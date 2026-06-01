#!/usr/bin/env node

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const conventionsCliPath = join(scriptDir, "conventions.mjs");
const plannerCliPath = join(scriptDir, "planner.mjs");
const nodeBin = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-conventions-cli-${name}-`));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runCli(scriptPath, args, cwd) {
  try {
    const stdout = execFileSync(nodeBin, [scriptPath, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, status: 0, stdout, stderr: "" };
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

function seedEmptyConventions(cwd) {
  writeJson(join(cwd, ".agent", "ontology", "facts", "conventions.yaml"), {
    conventions: {
      version: 1,
      conventions: [],
    },
  });
}

function seedActiveConventions(cwd) {
  writeJson(join(cwd, ".agent", "ontology", "facts", "conventions.yaml"), {
    conventions: {
      version: 1,
      conventions: [
        {
          id: "CONV-300",
          title: "Pages include MainLayout",
          description: "Frontend pages should wrap content in MainLayout.",
          status: "active",
          domain: "frontend",
          scope: "pages",
          confidence: 0.97,
          applies_to: {
            file_patterns: ["src/pages/**/*.tsx"],
            change_classes: ["new_page", "page_modification"],
          },
          requires: [{ import_contains: "MainLayout" }, { jsx_tree_contains: "Menu" }],
          evidence_type: "static_analysis",
          detected_from: "manual",
        },
        {
          id: "CONV-301",
          title: "Legacy pages keep audit banner",
          description: "Deprecated banner convention kept for audit history.",
          status: "deprecated",
          domain: "frontend",
          scope: "pages",
          confidence: 0.61,
          applies_to: {
            file_patterns: ["src/pages/legacy/**/*.tsx"],
            change_classes: ["page_modification"],
          },
          requires: [{ jsx_tree_contains: "AuditBanner" }],
          evidence_type: "static_analysis",
          detected_from: "manual",
        },
      ],
    },
  });
}

function seedConventionCheckPlan(cwd, planName = "plan_convention_check_fixture") {
  mkdirSync(join(cwd, "plans", planName), { recursive: true });
  mkdirSync(join(cwd, "src", "pages"), { recursive: true });
  writeFileSync(join(cwd, "src", "pages", "dashboard.tsx"), `import { MainLayout } from "../layout/MainLayout";
import { Menu } from "../layout/Menu";

export function DashboardPage() {
  return <MainLayout><Menu /></MainLayout>;
}
`);
  writeFileSync(join(cwd, "src", "pages", "settings.tsx"), `import { MainLayout } from "../layout/MainLayout";

export function SettingsPage() {
  return <MainLayout><section>Settings</section></MainLayout>;
}
`);
  writeFileSync(join(cwd, "plans", planName, "plan.md"), `# Plan

## Goal
Apply page conventions to new frontend pages

## Files To Modify
- src/pages/dashboard.tsx
- src/pages/settings.tsx
`);
  return planName;
}

function seedExemptedConventionCheckPlan(cwd, planName = "plan_convention_exemption_fixture") {
  mkdirSync(join(cwd, "plans", planName), { recursive: true });
  mkdirSync(join(cwd, "src", "pages"), { recursive: true });
  writeFileSync(join(cwd, "src", "pages", "admin.tsx"), `import { MainLayout } from "../layout/MainLayout";

export function AdminPage() {
  return <MainLayout><section>Admin</section></MainLayout>;
}
`);
  writeFileSync(join(cwd, "plans", planName, "plan.md"), `# Plan

## Goal
Allow a justified admin-page convention exemption

## Files To Modify
- src/pages/admin.tsx

## Convention Exemptions
\`\`\`yaml
convention_exemptions:
  - id: CONV-300
    reason: "Admin pages intentionally omit the public Menu surface."
    approved_by: user
\`\`\`
`);
  return planName;
}

function seedConventionCandidateReport(cwd, reportName = "2026-04-25T10-00-00.000Z") {
  const reportPath = join(cwd, "reports", "convention_candidates", `${reportName}.yaml`);
  writeJson(reportPath, {
    convention_candidates: {
      version: 1,
      generated_at: "2026-04-25T10:00:00.000Z",
      path_filter: null,
      detectors: ["import", "jsx_tree"],
      thresholds: {
        min_instances: 10,
        min_confidence: 0.85,
        propose_high_confidence: 0.95,
        propose_medium_confidence: 0.85,
      },
      groups_scanned: 2,
      candidate_count: 2,
      candidates: [
        {
          id: "CONV-901",
          title: "Pages include MainLayout",
          description: "detected pages importing MainLayout",
          status: "candidate",
          domain: "frontend",
          scope: "pages",
          confidence: 0.96,
          applies_to: {
            file_patterns: ["src/pages/**/*.tsx"],
            change_classes: ["new_page", "page_modification"],
          },
          requires: [{ import_contains: "MainLayout" }],
          evidence_type: "static_analysis",
          detected_from: "induction_import",
          detected_at: "2026-04-25T10:00:00.000Z",
          detected_in_instances: 12,
          total_instances: 12,
        },
        {
          id: "CONV-902",
          title: "Routes requireAuth middleware",
          description: "detected backend routes using requireAuth",
          status: "candidate",
          domain: "backend",
          scope: "endpoints",
          confidence: 0.72,
          applies_to: {
            file_patterns: ["src/api/**/*.ts"],
            change_classes: ["new_endpoint", "endpoint_modification"],
          },
          requires: [{ import_contains: "requireAuth" }],
          evidence_type: "static_analysis",
          detected_from: "induction_import",
          detected_at: "2026-04-25T10:00:00.000Z",
          detected_in_instances: 9,
          total_instances: 12,
        },
      ],
    },
  });
  return reportPath;
}

function scenarioReviewPromotionLifecycle() {
  const tmp = makeTemp("review-promotion");
  try {
    seedEmptyConventions(tmp);
    const reportPath = seedConventionCandidateReport(tmp);

    const blocked = runCli(conventionsCliPath, ["promote", "CONV-901", "--report", reportPath, "--json"], tmp);
    assert(!blocked.ok, "convention promotion blocks before review approval");
    const blockedJson = parseJson(blocked.stdout);
    assert(!!blockedJson, "blocked convention promotion emits JSON");
    assert((blockedJson?.issues || []).some((issue) => issue.includes("must be approved")), "blocked convention promotion explains the review requirement");

    const review = runCli(conventionsCliPath, [
      "review",
      "CONV-901",
      "--report", reportPath,
      "--decision", "approve",
      "--reviewer", "user",
      "--notes", "Observed consistently in the repo.",
      "--set-title", "Reviewed MainLayout convention",
      "--set-description", "User reviewed the MainLayout import requirement.",
      "--json",
    ], tmp);
    assert(review.ok, "convention review can approve and edit a candidate");
    const reviewJson = parseJson(review.stdout);
    assert(!!reviewJson, "convention review emits JSON");
    assert(reviewJson?.entry?.decision === "approved", "convention review stores the approved decision");
    assert(reviewJson?.candidate?.title === "Reviewed MainLayout convention", "convention review applies edited titles to the effective candidate");
    const reviewPath = join(tmp, "reports", "convention_candidates", "2026-04-25T10-00-00.000Z.review.yaml");
    assert(existsSync(reviewPath), "convention review writes the paired review file");

    const promote = runCli(conventionsCliPath, [
      "promote",
      "CONV-901",
      "--report", reportPath,
      "--status", "active",
      "--approved-by", "user",
      "--json",
    ], tmp);
    assert(promote.ok, "approved convention candidates promote cleanly");
    const promoteJson = parseJson(promote.stdout);
    assert(!!promoteJson, "convention promotion emits JSON");
    assert(promoteJson?.convention?.status === "active", "convention promotion activates the candidate");

    const conventions = JSON.parse(readFileSync(join(tmp, ".agent", "ontology", "facts", "conventions.yaml"), "utf-8"));
    const promoted = conventions?.conventions?.conventions?.find((entry) => entry.id === "CONV-901");
    assert(promoted?.title === "Reviewed MainLayout convention", "convention promotion persists reviewed title edits");
    assert(promoted?.status === "active", "convention promotion persists active status to conventions.yaml");

    const lifecycle = JSON.parse(readFileSync(join(tmp, "reports", "conventions", "lifecycle_log.yaml"), "utf-8"));
    assert((lifecycle?.convention_lifecycle?.events || []).some((entry) => entry.action === "promote" && entry.convention_id === "CONV-901"), "convention promotion appends a lifecycle event");

    const list = runCli(plannerCliPath, ["conventions", "list", "--report", reportPath, "--json"], tmp);
    assert(list.ok, "planner conventions list alias exits cleanly");
    const listJson = parseJson(list.stdout);
    assert(!!listJson, "planner conventions list alias emits JSON");
    assert((listJson?.records || []).some((entry) => entry.source === "ontology" && entry.id === "CONV-901"), "planner conventions list surfaces promoted ontology conventions");
    assert(!(listJson?.records || []).some((entry) => entry.source === "candidate_report" && entry.id === "CONV-901"), "planner conventions list hides candidate-report duplicates after promotion");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioDemoteRequiresJustification() {
  const tmp = makeTemp("demote");
  try {
    seedActiveConventions(tmp);

    const blocked = runCli(conventionsCliPath, ["demote", "CONV-300", "--status", "candidate", "--json"], tmp);
    assert(!blocked.ok, "convention demotion blocks without justification");
    const blockedJson = parseJson(blocked.stdout);
    assert((blockedJson?.issues || []).some((issue) => issue.includes("--justification")), "convention demotion explains the justification requirement");

    const demote = runCli(conventionsCliPath, [
      "demote",
      "CONV-300",
      "--status", "candidate",
      "--justification", "Admin surfaces are splitting into a new convention.",
      "--approved-by", "user",
      "--json",
    ], tmp);
    assert(demote.ok, "convention demotion succeeds with justification");
    const demoteJson = parseJson(demote.stdout);
    assert(demoteJson?.convention?.status === "candidate", "convention demotion returns the downgraded status");
    const conventions = JSON.parse(readFileSync(join(tmp, ".agent", "ontology", "facts", "conventions.yaml"), "utf-8"));
    const downgraded = conventions?.conventions?.conventions?.find((entry) => entry.id === "CONV-300");
    assert(downgraded?.status === "candidate", "convention demotion persists the downgraded status");
    const lifecycle = JSON.parse(readFileSync(join(tmp, "reports", "conventions", "lifecycle_log.yaml"), "utf-8"));
    assert((lifecycle?.convention_lifecycle?.events || []).some((entry) => entry.action === "demote" && entry.justification.includes("splitting into a new convention")), "convention demotion logs the justification in the lifecycle log");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioListFiltersUseReviewState() {
  const tmp = makeTemp("list-filters");
  try {
    seedActiveConventions(tmp);
    const reportPath = seedConventionCandidateReport(tmp);

    const reject = runCli(conventionsCliPath, [
      "review",
      "CONV-902",
      "--report", reportPath,
      "--decision", "reject",
      "--reviewer", "user",
      "--notes", "Backend routes vary by auth boundary.",
      "--json",
    ], tmp);
    assert(reject.ok, "convention review can reject a noisy candidate");

    const filtered = runCli(conventionsCliPath, [
      "list",
      "--report", reportPath,
      "--status", "candidate",
      "--review-decision", "reject",
      "--confidence-below", "0.8",
      "--json",
    ], tmp);
    assert(filtered.ok, "convention list filter command exits cleanly");
    const filteredJson = parseJson(filtered.stdout);
    assert(!!filteredJson, "convention list filter emits JSON");
    assert(filteredJson?.records?.length === 1, "convention list filters down to the rejected low-confidence candidate");
    assert(filteredJson?.records?.[0]?.id === "CONV-902", "convention list filter returns the expected rejected candidate");
    assert(filteredJson?.records?.[0]?.review_decision === "rejected", "convention list filter surfaces review decisions");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioCheckSummarizesPlanConventionStatus() {
  const tmp = makeTemp("check");
  try {
    seedActiveConventions(tmp);
    const planName = seedConventionCheckPlan(tmp);

    const check = runCli(plannerCliPath, ["conventions", "check", "--plan", planName, "--json"], tmp);
    assert(check.ok, "planner conventions check exits cleanly for a plan fixture");
    const checkJson = parseJson(check.stdout);
    assert(!!checkJson, "planner conventions check emits JSON");
    assert(checkJson?.summary?.applicable_results === 2, "planner conventions check records both applicable files");
    assert(checkJson?.summary?.satisfied === 1, "planner conventions check counts satisfied convention applications");
    assert(checkJson?.summary?.violations === 1, "planner conventions check counts violated convention applications");
    assert(existsSync(join(tmp, "reports", "conventions", planName, "check.yaml")), "planner conventions check writes the plan-local convention report");
    assert(
      (checkJson?.results || []).some((entry) => entry.file === "src/pages/settings.tsx" && entry.status === "violated"),
      "planner conventions check surfaces violated files in the result set"
    );
    assert(
      (checkJson?.reflection_sections?.convention_application_check || []).some((entry) => entry.required_question && entry.file === "src/pages/settings.tsx"),
      "planner conventions check emits reflection-guide convention_application_check data for violations"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioCheckRecognizesJustifiedExemptions() {
  const tmp = makeTemp("check-exemption");
  try {
    seedActiveConventions(tmp);
    const planName = seedExemptedConventionCheckPlan(tmp);

    const check = runCli(plannerCliPath, ["conventions", "check", "--plan", planName, "--json"], tmp);
    assert(check.ok, "planner conventions check accepts justified convention exemptions");
    const checkJson = parseJson(check.stdout);
    assert(!!checkJson, "planner conventions check with exemption emits JSON");
    assert(checkJson?.summary?.violations === 0, "justified convention exemptions remove the blocking violation count");
    assert(checkJson?.summary?.exempted === 1, "planner conventions check counts exempted convention applications");
    assert(checkJson?.declared_exemptions?.length === 1, "planner conventions check reports declared convention exemptions");
    assert(
      (checkJson?.results || []).some((entry) => entry.file === "src/pages/admin.tsx" && entry.status === "exempted" && entry.exemption_justified === true),
      "planner conventions check marks the exempted file result with justification metadata"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

scenarioReviewPromotionLifecycle();
scenarioDemoteRequiresJustification();
scenarioListFiltersUseReviewState();
scenarioCheckSummarizesPlanConventionStatus();
scenarioCheckRecognizesJustifiedExemptions();

console.log(`\nConvention CLI tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
