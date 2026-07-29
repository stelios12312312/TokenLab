#!/usr/bin/env node
// test_decision_anchors.mjs - Journal-backed decision anchors and capped projections.

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadJournalFacts } from "../scripts/lib/fact_loader.mjs";
import {
  compileJournalFacts,
  JOURNAL_REL_PATH,
} from "../scripts/lib/agent_journal.mjs";
import {
  auditDecisionAnchors,
  projectJournalEntries,
  retireOrphanDecisionAnchors,
} from "../scripts/lib/decision_anchors.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const cliPath = join(skillDir, "scripts", "decision_anchors.mjs");

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

function tempProject(label) {
  return mkdtempSync(join(tmpdir(), `decision-anchors-${label}-`));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function journalPath(cwd) {
  return join(cwd, JOURNAL_REL_PATH);
}

function writeJournalLine(cwd, value) {
  const path = journalPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "a" });
}

function writeRepoFile(cwd, relPath, content) {
  const path = join(cwd, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runCli(cwd, args, { expectFailure = false } = {}) {
  try {
    const stdout = execFileSync("node", [cliPath, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert(!expectFailure, `CLI ${args.join(" ")} exits successfully`);
    return { ok: true, stdout: stdout.trim(), json: JSON.parse(stdout) };
  } catch (error) {
    assert(expectFailure, `CLI ${args.join(" ")} exits non-zero when expected`);
    const text = `${error.stdout || ""}${error.stderr || ""}`.trim();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: false, stdout: text, json };
  }
}

function anchorEntry(overrides = {}) {
  return {
    id: overrides.id || "J-ANCHOR-001",
    type: "decision",
    status: overrides.status || "accepted",
    confidence: "operator_policy",
    summary: overrides.summary || "Anchor a non-obvious planner-core decision.",
    memory_role: "decision_anchor",
    superseded_by: overrides.superseded_by || undefined,
    refs: overrides.refs || ["plans/plan_example/decisions.md:D-001"],
    source_entries: overrides.source_entries || [],
    payload: {
      anchor_id: overrides.anchor_id || "plan_example:D-001",
      plan_id: overrides.plan_id || "plan_example",
      decision_id: overrides.decision_id || "D-001",
      path: overrides.path || "src/anchored.mjs",
      ...overrides.payload,
    },
  };
}

console.log("\nDecision Anchor Lifecycle Tests\n");

console.log("[journal fact projection]");
{
  const tmp = tempProject("facts");
  try {
    writeJournalLine(tmp, anchorEntry());
    writeRepoFile(tmp, "src/anchored.mjs", "// DECISION plan_example:D-001 keep this branch explicit\n");

    const compiled = compileJournalFacts({ cwd: tmp });
    const facts = compiled.facts.join("\n");
    assert(facts.includes("decision_anchor_entry('plan_example:D-001', 'J-ANCHOR-001')."), "facts include anchor to journal entry");
    assert(facts.includes("decision_anchor_plan('plan_example:D-001', 'plan_example')."), "facts include anchor plan id");
    assert(facts.includes("decision_anchor_decision('plan_example:D-001', 'D-001')."), "facts include decision id");
    assert(facts.includes("decision_anchor_path('plan_example:D-001', 'src/anchored.mjs')."), "facts include anchor path");
    assert(facts.includes("decision_anchor_status('plan_example:D-001', 'active')."), "facts mark accepted anchors active");

    const session = createSession();
    loadJournalFacts(session, { cwd: tmp });
    const prolog = [...session.query("decision_anchor_status('plan_example:D-001', active).")].length;
    assert(prolog === 1, "fact loader accepts decision_anchor_status/2");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[anchor audit positive and negative cases]");
{
  const tmp = tempProject("audit");
  try {
    writeJournalLine(tmp, anchorEntry());
    writeRepoFile(tmp, "src/anchored.mjs", "// DECISION plan_example:D-001 keep this branch explicit\n");

    const pass = auditDecisionAnchors({ cwd: tmp });
    assert(pass.ok === true, "audit passes with active journal anchor and marker");
    assert(pass.summary.active_anchor_count === 1, "audit counts active anchors");

    writeRepoFile(tmp, "src/anchored.mjs", "// missing marker\n");
    const missing = auditDecisionAnchors({ cwd: tmp });
    assert(missing.ok === false, "audit fails when active marker is missing");
    assert(missing.issues.some((item) => item.code === "active_anchor_marker_missing"), "missing marker issue is coded");

    writeRepoFile(tmp, "src/anchored.mjs", "// missing marker\n");
    writeRepoFile(tmp, "src/orphan.mjs", "// DECISION plan_example:D-ORPHAN old branch\n");
    const orphan = auditDecisionAnchors({ cwd: tmp });
    assert(orphan.ok === false, "audit fails on non-stale orphan marker");
    assert(orphan.issues.some((item) => item.code === "orphan_decision_anchor_marker"), "orphan marker issue is coded");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[orphan retirement preview and write]");
{
  const tmp = tempProject("retire");
  try {
    writeRepoFile(tmp, "src/orphan.mjs", "// DECISION plan_example:D-ORPHAN old branch\n");

    const preview = retireOrphanDecisionAnchors({ cwd: tmp, write: false });
    assert(preview.ok === true && preview.changed_files.length === 1, "retire preview reports one file");
    assert(!readFileSync(join(tmp, "src/orphan.mjs"), "utf-8").includes("[STALE]"), "retire preview does not mutate");

    const written = retireOrphanDecisionAnchors({ cwd: tmp, write: true });
    const content = readFileSync(join(tmp, "src/orphan.mjs"), "utf-8");
    assert(written.ok === true && content.includes("DECISION [STALE] plan_example:D-ORPHAN"), "retire write marks orphan stale");

    const audit = auditDecisionAnchors({ cwd: tmp });
    assert(audit.ok === true, "audit passes with only stale orphan markers");
    assert(audit.summary.stale_orphan_marker_count === 1, "audit counts stale orphan marker as advisory");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[markdown examples are not live anchors]");
{
  const tmp = tempProject("markdown");
  try {
    writeRepoFile(tmp, "docs/reference.md", [
      "# Reference",
      "",
      "```js",
      "// DECISION plan_example:D-DOCS example only",
      "```",
      "",
      "Use `DECISION [STALE] plan_id:D-NNN` for retired examples.",
      "",
    ].join("\n"));

    const audit = auditDecisionAnchors({ cwd: tmp });
    assert(audit.ok === true, "audit ignores fenced Markdown example markers");
    assert(audit.summary.orphan_marker_count === 0, "fenced Markdown examples do not create orphan markers");
    assert(audit.summary.stale_orphan_marker_count === 1, "inline stale Markdown example remains advisory");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[capped journal projection]");
{
  const tmp = tempProject("projection");
  try {
    writeJournalLine(tmp, anchorEntry({ id: "J-ANCHOR-001", summary: "First anchor summary." }));
    writeJournalLine(tmp, anchorEntry({
      id: "J-ANCHOR-002",
      anchor_id: "plan_example:D-002",
      decision_id: "D-002",
      summary: "Second anchor summary.",
      refs: ["plans/plan_example/decisions.md:D-002"],
    }));
    writeJournalLine(tmp, {
      id: "J-OBS-001",
      type: "observation",
      status: "accepted",
      confidence: "measured",
      summary: "A plain observation can also project with provenance.",
      refs: ["plans/knowledge/patterns.md:P-001"],
    });

    const beforeHash = hashFile(journalPath(tmp));
    const projected = projectJournalEntries({
      cwd: tmp,
      maxLines: 5,
      title: "Projected Knowledge",
      includeStatuses: ["accepted", "promoted"],
    });
    const lines = projected.markdown.trimEnd().split(/\r?\n/);
    assert(projected.ok === true, "projection succeeds");
    assert(lines.length <= 6, "projection respects max line cap");
    assert(projected.markdown.includes("journal:J-ANCHOR-001"), "projection includes journal provenance");
    assert(projected.markdown.includes("Truncated at 5 lines"), "projection reports truncation within cap");
    assert(hashFile(journalPath(tmp)) === beforeHash, "projection does not mutate the journal");
  } finally {
    cleanup(tmp);
  }
}

console.log("\n[CLI JSON surfaces]");
{
  const tmp = tempProject("cli");
  try {
    writeJournalLine(tmp, anchorEntry());
    writeRepoFile(tmp, "src/anchored.mjs", "// DECISION plan_example:D-001 keep this branch explicit\n");

    const audit = runCli(tmp, ["audit", "--json"]);
    assert(audit.json?.ok === true && audit.json?.summary?.active_anchor_count === 1, "audit CLI emits JSON summary");

    writeRepoFile(tmp, "src/orphan.mjs", "// DECISION plan_example:D-ORPHAN old branch\n");
    const failedAudit = runCli(tmp, ["audit", "--json"], { expectFailure: true });
    assert(failedAudit.json?.issues?.some((item) => item.code === "orphan_decision_anchor_marker"), "audit CLI fails with coded orphan issue");

    const retire = runCli(tmp, ["retire-orphans", "--write", "--json"]);
    assert(retire.json?.ok === true && retire.json?.changed_files?.length === 1, "retire CLI writes stale marker");

    const projection = runCli(tmp, ["project", "--max-lines", "5", "--json"]);
    assert(projection.json?.ok === true && projection.json?.line_count <= 5, "project CLI emits capped JSON");
  } finally {
    cleanup(tmp);
  }
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
