#!/usr/bin/env node
// test_fresh_context_reviewer.mjs — E1-2 fresh-context PR reviewer boundary.

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const reviewerCli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "fresh_context_reviewer.mjs");
const configPath = join(repoRoot, ".github", "reviewer", "config.json");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function runReviewer(args = [], env = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, [reviewerCli, ...args], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...env },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withDiffFixture(name, diffText, fn) {
  const tmp = mkdtempSync(join(tmpdir(), `fresh-reviewer-${name}-`));
  try {
    const diffPath = join(tmp, "fixture.diff");
    writeFileSync(diffPath, diffText);
    fn(diffPath, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const seededBadDiff = `diff --git a/docs/reviewer-fixture.md b/docs/reviewer-fixture.md
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/docs/reviewer-fixture.md
@@ -0,0 +1,2 @@
+# Reviewer Fixture
+All reviewer checks pass.
diff --git a/src/reviewer_fixture.mjs b/src/reviewer_fixture.mjs
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/src/reviewer_fixture.mjs
@@ -0,0 +1,2 @@
+export function reviewerChecksPass() {
+  return false;
+}
`;

const honestDiff = `diff --git a/src/reviewer_fixture.mjs b/src/reviewer_fixture.mjs
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/src/reviewer_fixture.mjs
@@ -0,0 +1,3 @@
+export function reviewerChecksPass() {
+  return true;
+}
`;

const baseArgs = [
  "--config",
  configPath,
  "--json",
];

function scenarioRequiredSurfacesExist() {
  assert(existsSync(reviewerCli), "fresh-context reviewer CLI ships");
  assert(existsSync(configPath), "reviewer config lives under .github/reviewer/");
  assert(!existsSync(join(repoRoot, ".github", "workflows", "fresh-context-reviewer.yml")), "retired hosted reviewer trigger remains absent");
}

function scenarioPrintsPackDerivedClosedQuestions() {
  const result = runReviewer(["rubric", "--config", configPath, "--json"]);
  const parsed = parseJson(result.stdout);
  assert(result.ok, "rubric command exits cleanly");
  assert(parsed?.question_count >= 4, "rubric compiles pack-derived questions");
  assert((parsed?.packs || []).includes("wiring_auditor"), "rubric includes wiring_auditor pack");
  assert((parsed?.packs || []).includes("assumptions_challenger"), "rubric includes assumptions_challenger pack");
  assert((parsed?.questions || []).every((q) => q.answer_type === "yes_no_uncertain"), "every rubric question is closed yes/no/uncertain");
  assert((parsed?.questions || []).some((q) => q.rule_id === "WR-001"), "rubric derives questions from RULE_DEFS rule ids");
}

function scenarioSeededBadDiffFails() {
  withDiffFixture("bad", seededBadDiff, (diffPath) => {
    const result = runReviewer([
      "review",
      ...baseArgs,
      "--diff-file",
      diffPath,
      "--changed-files",
      "docs/reviewer-fixture.md,src/reviewer_fixture.mjs",
    ], {
      FRESH_CONTEXT_REVIEWER_MOCK_RESPONSE: JSON.stringify({
        status: "fail",
        summary: "Planted contradiction detected.",
        answers: [
          {
            rule_id: "AC-003",
            answer: "yes",
            finding_id: "claim_code_contradiction",
            finding: "The docs claim all reviewer checks pass, but the code returns false.",
            evidence: "docs/reviewer-fixture.md and src/reviewer_fixture.mjs",
          },
        ],
      }),
    });
    const parsed = parseJson(result.stdout);
    assert(!result.ok && result.status === 1, "seeded bad PR exits non-zero");
    assert(parsed?.status === "fail", "seeded bad PR emits fail verdict");
    assert((parsed?.findings || []).some((finding) => finding.id === "claim_code_contradiction"), "seeded bad PR records the planted contradiction");
  });
}

function scenarioHonestDiffPasses() {
  withDiffFixture("honest", honestDiff, (diffPath) => {
    const result = runReviewer([
      "review",
      ...baseArgs,
      "--diff-file",
      diffPath,
      "--changed-files",
      "src/reviewer_fixture.mjs",
    ], {
      FRESH_CONTEXT_REVIEWER_MOCK_RESPONSE: JSON.stringify({
        status: "pass",
        summary: "No closed-question violations found.",
        answers: [
          { rule_id: "WR-001", answer: "no" },
          { rule_id: "AC-003", answer: "no" },
        ],
      }),
    });
    const parsed = parseJson(result.stdout);
    assert(result.ok, "honest PR exits zero");
    assert(parsed?.status === "pass", "honest PR emits pass verdict");
    assert((parsed?.findings || []).length === 0, "honest PR has no findings");
    assert(parsed?.provider?.role === "reviewer", "honest PR records reviewer role provider");
    assert(parsed?.cost_ledger?.call_count === 1, "honest PR records one provider call in cost ledger");
  });
}

function scenarioProviderDownFailsHonest() {
  withDiffFixture("provider-down", honestDiff, (diffPath) => {
    const result = runReviewer([
      "review",
      ...baseArgs,
      "--diff-file",
      diffPath,
      "--changed-files",
      "src/reviewer_fixture.mjs",
    ], {
      FRESH_CONTEXT_REVIEWER_API_KEY: "",
      FRESH_CONTEXT_REVIEWER_MOCK_RESPONSE: "",
    });
    const parsed = parseJson(result.stdout);
    assert(!result.ok && result.status === 2, "provider-down path exits with infrastructure failure");
    assert(parsed?.status === "fail", "provider-down path emits fail verdict");
    assert(parsed?.reason === "provider_unavailable", "provider-down path names provider_unavailable");
    assert(parsed?.fail_honest === true, "provider-down path is explicitly fail-honest");
    assert(parsed?.provider?.role === "reviewer", "provider-down path reports reviewer role provider");
    assert(parsed?.cost_ledger?.call_count === 0, "provider-down path keeps an empty cost ledger");
  });
}

function scenarioSelfReviewFailsBeforeProviderPass() {
  withDiffFixture("self-review", honestDiff, (diffPath) => {
    const result = runReviewer([
      "review",
      ...baseArgs,
      "--diff-file",
      diffPath,
      "--changed-files",
      ".github/reviewer/config.json,src/reviewer_fixture.mjs",
    ], {
      FRESH_CONTEXT_REVIEWER_MOCK_RESPONSE: JSON.stringify({
        status: "pass",
        summary: "Would pass if not self-review.",
        answers: [{ rule_id: "WR-001", answer: "no" }],
      }),
    });
    const parsed = parseJson(result.stdout);
    assert(!result.ok && result.status === 1, "self-review PR exits non-zero even with provider pass");
    assert(parsed?.reason === "self_review_modification", "self-review PR names self_review_modification");
    assert((parsed?.self_review_paths || []).includes(".github/reviewer/config.json"), "self-review verdict names changed reviewer config path");
  });
}

function scenarioCommentFileRendersVerdict() {
  withDiffFixture("comment", honestDiff, (diffPath, tmp) => {
    const commentPath = join(tmp, "review-comment.md");
    const result = runReviewer([
      "review",
      ...baseArgs,
      "--diff-file",
      diffPath,
      "--changed-files",
      "src/reviewer_fixture.mjs",
      "--comment-file",
      commentPath,
    ], {
      FRESH_CONTEXT_REVIEWER_MOCK_RESPONSE: JSON.stringify({
        status: "pass",
        summary: "No closed-question violations found.",
        answers: [{ rule_id: "WR-001", answer: "no" }],
      }),
    });
    const comment = existsSync(commentPath) ? readFileSync(commentPath, "utf-8") : "";
    assert(result.ok, "reviewer writes comment file on pass");
    assert(comment.includes("Fresh-Context Reviewer"), "comment has reviewer heading");
    assert(comment.includes("Status: pass"), "comment names pass status");
  });
}

console.log("\nFresh-Context Reviewer Tests (E1-2)\n");

scenarioRequiredSurfacesExist();
scenarioPrintsPackDerivedClosedQuestions();
scenarioSeededBadDiffFails();
scenarioHonestDiffPasses();
scenarioProviderDownFailsHonest();
scenarioSelfReviewFailsBeforeProviderPass();
scenarioCommentFileRendersVerdict();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
