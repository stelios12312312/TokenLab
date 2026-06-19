#!/usr/bin/env node
// test_annotation_discipline_gate.mjs - Phase A.4 regression coverage for
// proactive-ontology proposal: lock the @planner annotation discipline gate
// (GATE-PLN-ANN-001) emitted by gatePlanToExecute.
//
// Covers:
//   - File with @planner:capability      -> PASS
//   - File with @planner:module          -> PASS
//   - File without annotations           -> FAIL
//   - File with only non-identity annotations -> FAIL
//   - Substantive waiver in plan.md      -> PASS
//   - Placeholder waiver reason (TBD)    -> FAIL (waiver placeholder rejected)
//   - File not yet on disk               -> SKIP (pre-EXECUTE)
//   - Non-worthy path (e.g., docs/)      -> no result emitted
//   - PLANNER_ANNOTATION_DISCIPLINE=off  -> WARN (advisory mode)
//   - Plan with no worthy files          -> no result emitted
//   - Pre-existing file in git HEAD       -> EXEMPT (net-new scoping); net-new file still FAILs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

import {
  analyzeAnnotationDiscipline,
  parseAnnotationWaivers,
  isAnnotationDisciplineEnabled,
} from "../scripts/lib/annotation_discipline.mjs";

const VERIFY_GATE_HREF = new URL("../scripts/verify_gate.mjs", import.meta.url).href;

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}`); }
}

function makeFixture(prefix, files) {
  // files = { "scripts/foo.mjs": "...contents..." }
  const root = mkdtempSync(join(tmpdir(), `ann-discipline-${prefix}-`));
  for (const [relPath, content] of Object.entries(files || {})) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function writePlan(root, filesToModify, extraLines = []) {
  const planDir = join(root, "plans", "plan_ann_discipline");
  mkdirSync(planDir, { recursive: true });
  const plan = [
    "# Plan v0",
    "",
    "## Problem Statement",
    "Exercise annotation discipline.",
    "",
    "## Files To Modify",
    ...filesToModify.map((file) => `- ${file}`),
    "",
    "## Steps",
    "1. Exercise the gate.",
    "",
    "## Verification Strategy",
    "Read the GATE-PLN-ANN-001 result.",
    "",
    "## Success Criteria",
    "GATE-PLN-ANN-001 reports the expected status.",
    "",
    "## Semantic Upkeep Contract",
    "- Profile: integration_backend_orchestration",
    ...extraLines,
  ].join("\n");
  writeFileSync(join(planDir, "plan.md"), `${plan}\n`);
  return planDir;
}

function runLiveAnnotationGate(planDir, cwd, env = {}, options = {}) {
  const code = [
    `import { gatePlanToExecute } from ${JSON.stringify(VERIFY_GATE_HREF)};`,
    `const results = gatePlanToExecute(${JSON.stringify(planDir)}, ${JSON.stringify(options)});`,
    `const target = results.find((entry) => entry?.code === "GATE-PLN-ANN-001");`,
    "console.log(JSON.stringify(target));",
  ].join("\n");
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

console.log("\nAnnotation Discipline Gate (GATE-PLN-ANN-001) Regression\n");

// ──────────────────────────────────────────────────────────────────────
// Scenario 1: File with @planner:capability -> PASS
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-pass", {
    "scripts/sample.mjs": "// @planner:capability = sample_thing\nexport const ok = true;\n",
  });
  try {
    const plan = "## Files To Modify\n- scripts/sample.mjs\n";
    const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
    assert(r.required === true, "annotation-worthy file makes discipline 'required'");
    assert(r.satisfied === true, "annotated file PASSes");
    assert(r.violations.length === 0, "no violations recorded");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 1b: File with @planner:module -> PASS
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-module-pass", {
    "scripts/sample.mjs": "// @planner:module = sample_module\nexport const ok = true;\n",
  });
  try {
    const plan = "## Files To Modify\n- scripts/sample.mjs\n";
    const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
    assert(r.required === true, "module-only annotation-worthy file makes discipline 'required'");
    assert(r.satisfied === true, "module-only annotated file PASSes");
    assert(r.violations.length === 0, "module-only file records no violations");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 2: File without annotations and no waiver -> FAIL
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-fail", {
    "scripts/unannotated.mjs": "export const value = 42;\n",
  });
  try {
    const plan = "## Files To Modify\n- scripts/unannotated.mjs\n";
    const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
    assert(r.satisfied === false, "unannotated file FAILs the gate");
    assert(r.violations.length === 1, "one violation captured");
    assert(r.violations[0].kind === "missing_annotation", "violation kind is missing_annotation");
    assert(r.violations[0].path === "scripts/unannotated.mjs", "violation cites the offending file");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 2b: File with annotations but no module/capability -> FAIL
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-story-only", {
    "scripts/story_only.mjs": "// @planner:story = US-001\nexport const value = 42;\n",
  });
  try {
    const plan = "## Files To Modify\n- scripts/story_only.mjs\n";
    const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
    assert(r.satisfied === false, "story-only annotation FAILs the gate");
    assert(r.violations.length === 1, "one story-only violation captured");
    assert(r.violations[0].kind === "missing_required_annotation", "story-only violation requires module/capability");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 3: Substantive waiver lifts the requirement -> PASS
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-waiver", {
    "scripts/generated.mjs": "// generated\nexport default {};\n",
  });
  try {
    const plan = [
      "## Files To Modify",
      "- scripts/generated.mjs",
      "",
      "## Notes",
      "[KB_NOT_APPLICABLE: annotation: scripts/generated.mjs: build artifact regenerated by codegen; should not carry @planner annotations]",
    ].join("\n");
    const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
    assert(r.satisfied === true, "valid waiver lifts the requirement");
    assert(r.waivers.size === 1, "waiver parsed");
    const waiver = r.waivers.get("scripts/generated.mjs");
    assert(waiver && waiver.placeholder === false, "waiver reason is not a placeholder");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 3b: Live gate blocks an existing unannotated owned file
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-live-unannotated", {
    "scripts/unannotated.mjs": "export const value = 42;\n",
  });
  try {
    const planDir = writePlan(cwd, ["scripts/unannotated.mjs"]);
    const target = runLiveAnnotationGate(planDir, cwd);
    assert(target?.status === "FAIL", "live GATE-PLN-ANN-001 FAILs existing unannotated files");
    assert(String(target?.detail || "").includes("missing_annotation"), "live unannotated failure names missing_annotation");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 3c: Live planning-only handoff skips implementation annotation enforcement
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-live-planning-only", {
    "scripts/unannotated.mjs": "export const value = 42;\n",
  });
  try {
    const planDir = writePlan(cwd, ["scripts/unannotated.mjs"]);
    const target = runLiveAnnotationGate(planDir, cwd, {}, { planningOnly: true });
    assert(target?.status === "PASS", "planning-only live gate does not enforce implementation annotations");
    assert(String(target?.detail || "").includes("Planning-only"), "planning-only annotation result explains the exemption");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 3d: Live gate requires exact waiver paths
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-live-waiver-exact", {
    "lib/plan_utils.mjs": "// @planner:story = US-001\nexport const plan = true;\n",
    "lib/scope_utils.mjs": "// @planner:story = US-002\nexport const scope = true;\n",
  });
  try {
    const planDir = writePlan(cwd, ["lib/plan_utils.mjs", "lib/scope_utils.mjs"], [
      "",
      "## Notes",
      "[KB_NOT_APPLICABLE: annotation: utils.mjs: real-sounding eight-plus-char reason]",
    ]);
    const target = runLiveAnnotationGate(planDir, cwd);
    assert(target?.status === "FAIL", "suffix waiver does not clear sibling utils files");
    assert(String(target?.detail || "").includes("lib/plan_utils.mjs"), "suffix waiver failure names plan_utils");
    assert(String(target?.detail || "").includes("lib/scope_utils.mjs"), "suffix waiver failure names scope_utils");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 4: Placeholder waiver reason -> FAIL (rubber-stamp defense)
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-waiver-tbd", {
    "scripts/whatever.mjs": "export const v = 1;\n",
  });
  try {
    // Every placeholder pattern listed by WAIVER_REASON_PLACEHOLDER_PATTERNS
    // must be caught. Test the three highest-value: TBD, <placeholder>, [FILL].
    for (const reason of ["TBD", "<placeholder reason>", "[FILL: write reason]"]) {
      const plan = [
        "## Files To Modify",
        "- scripts/whatever.mjs",
        "",
        `[KB_NOT_APPLICABLE: annotation: scripts/whatever.mjs: ${reason}]`,
      ].join("\n");
      const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
      assert(r.satisfied === false, `placeholder waiver reason '${reason}' FAILs the gate`);
      assert(r.violations[0]?.kind === "waiver_placeholder", `kind=waiver_placeholder for '${reason}'`);
    }
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 5: File listed in plan but doesn't exist yet -> SKIP
// (pre-EXECUTE; the file hasn't been written yet, so the gate is patient)
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-not-yet-written", {});
  try {
    const plan = "## Files To Modify\n- scripts/future_helper.mjs\n";
    const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
    assert(r.required === true, "annotation-worthy path keeps required=true even when file is missing");
    assert(r.satisfied === true, "absent file SKIPped (no annotation check possible yet)");
    assert(r.violations.length === 0, "no violation while file doesn't exist on disk");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 6: Non-worthy path (docs/, tests/fixtures/, etc.) -> no requirement
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-non-worthy", {
    "docs/README.md": "# Docs\n",
    "tests/fixtures/sample.json": "{}",
  });
  try {
    const plan = [
      "## Files To Modify",
      "- docs/README.md",
      "- tests/fixtures/sample.json",
    ].join("\n");
    const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
    assert(r.required === false, "non-worthy paths produce required=false");
    assert(r.satisfied === true, "no annotation-worthy files -> trivially satisfied");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 7: PLANNER_ANNOTATION_DISCIPLINE=off -> WARN (advisory)
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-disabled", {
    "scripts/skipped.mjs": "export const v = 1;\n",
  });
  try {
    const plan = "## Files To Modify\n- scripts/skipped.mjs\n";
    const r = analyzeAnnotationDiscipline({
      planContent: plan,
      cwd,
      env: { PLANNER_ANNOTATION_DISCIPLINE: "off" },
    });
    assert(r.enabled === false, "PLANNER_ANNOTATION_DISCIPLINE=off disables enforcement");
    assert(r.satisfied === true, "advisory mode does not FAIL the gate");
    assert(r.required === true, "advisory mode still flags annotation-worthy files (so verify_gate emits WARN)");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 8: Plan with no Files To Modify section -> no requirement, no fail
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-empty-plan", {});
  try {
    const plan = "# Plan v0\n\nThis plan has no Files To Modify section.\n";
    const r = analyzeAnnotationDiscipline({ planContent: plan, cwd });
    assert(r.required === false, "empty plan emits no requirement");
    assert(r.satisfied === true, "empty plan trivially satisfied");
    assert(r.planned.length === 0, "no planned files");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 9: parseAnnotationWaivers parses + flags placeholder reasons
// ──────────────────────────────────────────────────────────────────────
{
  const plan = [
    "[KB_NOT_APPLICABLE: annotation: a.mjs: real reason here]",
    "[KB_NOT_APPLICABLE: annotation: b.mjs: TBD]",
    "[KB_NOT_APPLICABLE: annotation: c.mjs: <placeholder>]",
    "[KB_NOT_APPLICABLE: annotation: d.mjs: [FILL: text]]",
  ].join("\n");
  const waivers = parseAnnotationWaivers(plan);
  assert(waivers.size === 4, "all four waivers parsed");
  assert(waivers.get("a.mjs")?.placeholder === false, "real reason not flagged as placeholder");
  assert(waivers.get("b.mjs")?.placeholder === true, "TBD flagged as placeholder");
  assert(waivers.get("c.mjs")?.placeholder === true, "<placeholder> flagged as placeholder");
  assert(waivers.get("d.mjs")?.placeholder === true, "[FILL: ...] flagged as placeholder");
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 10: isAnnotationDisciplineEnabled env parsing
// ──────────────────────────────────────────────────────────────────────
{
  assert(isAnnotationDisciplineEnabled({}) === true, "default is enabled");
  assert(isAnnotationDisciplineEnabled({ PLANNER_ANNOTATION_DISCIPLINE: "off" }) === false, "'off' disables");
  assert(isAnnotationDisciplineEnabled({ PLANNER_ANNOTATION_DISCIPLINE: "0" }) === false, "'0' disables");
  assert(isAnnotationDisciplineEnabled({ PLANNER_ANNOTATION_DISCIPLINE: "false" }) === false, "'false' disables");
  assert(isAnnotationDisciplineEnabled({ PLANNER_ANNOTATION_DISCIPLINE: "no" }) === false, "'no' disables");
  assert(isAnnotationDisciplineEnabled({ PLANNER_ANNOTATION_DISCIPLINE: "on" }) === true, "'on' enabled");
}

// ──────────────────────────────────────────────────────────────────────
// Scenario 11: net-new scoping (remediation for the 856af38 false-red).
// A worthy file already in git HEAD is EXEMPT (pre-existing/legacy code being
// modified — real plans do this constantly and must not be blocked). A
// brand-new un-annotated owned worthy file (the AV-7 bypass) still FAILs.
// ──────────────────────────────────────────────────────────────────────
{
  const cwd = makeFixture("ann-net-new", {
    "scripts/legacy_committed.mjs": "export const legacy = 1;\n",
  });
  try {
    const git = (args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
    git(["init", "-q"]);
    git(["add", "scripts/legacy_committed.mjs"]);
    git(["commit", "-q", "-m", "legacy"]);

    // Pre-existing committed file → EXEMPT (this is what was false-redding real plans).
    const plan1 = "## Files To Modify\n- scripts/legacy_committed.mjs\n";
    const r1 = analyzeAnnotationDiscipline({ planContent: plan1, cwd });
    assert(r1.satisfied === true, "pre-existing (in git HEAD) un-annotated file is EXEMPT — no false-red");
    assert(r1.violations.length === 0, "no violation for a legacy committed file");

    // Net-new un-annotated worthy file (not committed) → still ENFORCED (AV-7 stays closed).
    writeFileSync(join(cwd, "scripts", "brand_new.mjs"), "export const fresh = 1;\n");
    const plan2 = "## Files To Modify\n- scripts/legacy_committed.mjs\n- scripts/brand_new.mjs\n";
    const r2 = analyzeAnnotationDiscipline({ planContent: plan2, cwd });
    assert(r2.satisfied === false, "net-new un-annotated worthy file still FAILs (AV-7 stays closed)");
    assert(r2.violations.length === 1, "exactly one violation — only the net-new file, not the legacy one");
    assert(r2.violations[0].path === "scripts/brand_new.mjs", "violation cites the net-new file");
  } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
