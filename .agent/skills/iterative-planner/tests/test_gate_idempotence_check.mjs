#!/usr/bin/env node
// test_gate_idempotence_check.mjs — the idempotence meta-invariant must (a) detect
// when a gate verdict flips between identical runs (teeth), and (b) confirm the
// real planner gate evaluators are deterministic on an unchanged plan.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { verdictOf, diffVerdicts, checkGateIdempotence } from "../scripts/gate_idempotence_check.mjs";

const __filename = fileURLToPath(import.meta.url);
const skillDir = resolve(dirname(__filename), "..");
const agentDir = resolve(skillDir, "../..");
const bootstrap = join(skillDir, "scripts", "bootstrap.mjs");
const idempotence = join(skillDir, "scripts", "gate_idempotence_check.mjs");
const verifyGate = join(skillDir, "scripts", "verify_gate.mjs");
const NODE = process.execPath;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

const fixtureEnv = { ...process.env, CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "idem-test" };

function runNode(args, cwd) {
  return execFileSync(NODE, args, { cwd, encoding: "utf-8", env: fixtureEnv });
}

function runNodeCapture(args, cwd) {
  try {
    return runNode(args, cwd);
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
}

// --- Unit: the comparison logic has teeth ---
assert(diffVerdicts({ a: "PASS" }, { a: "FAIL" }).length === 1, "diffVerdicts flags a PASS→FAIL flip");
assert(diffVerdicts({ a: "PASS", b: "WARN" }, { a: "PASS", b: "WARN" }).length === 0, "diffVerdicts: identical verdicts → no diff");
assert(diffVerdicts({ a: "PASS" }, {}).length === 1, "diffVerdicts flags an appearing/vanishing check");
// verdictOf keeps the worst status for a repeated name so a flip is never masked.
assert(verdictOf([{ name: "x", status: "PASS" }, { name: "x", status: "FAIL" }]).x === "FAIL", "verdictOf keeps worst status on duplicate name");

// --- Integration: real planner gates are deterministic on an unchanged plan ---
const tmp = mkdtempSync(join(tmpdir(), "idempotence-test-"));
try {
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  runNode([bootstrap, "new", "Idempotence harness fixture plan"], tmp);

  const plansDir = join(tmp, "plans");
  // Resolve the freshly created plan dir via the pointer.
  const planName = readFileSync(join(plansDir, ".current_plan"), "utf-8").trim();
  const planDir = join(plansDir, planName);

  // explore-to-plan evaluated twice on the unchanged fresh plan must be stable.
  const r = checkGateIdempotence(planDir, "explore-to-plan", 3);
  assert(r.idempotent === true, `explore-to-plan is idempotent across 3 runs (got ${JSON.stringify(r.diffs || r.error || "stable")})`);
  assert(r.check_count > 0, "explore-to-plan produced a non-empty verdict to compare");

  const allGateOut = JSON.parse(runNode([idempotence, "--cwd", tmp, "--json"], tmp));
  assert(allGateOut.ok === true, "default CLI reports all checked evaluators stable");
  assert(allGateOut.gates_checked >= 7, "default CLI covers every verify_gate evaluator");
  assert(allGateOut.results.some((entry) => entry.gate === "reflect-to-close"), "default CLI includes legacy reflect-to-close evaluator");

  const annotatedRel = "scripts/annotation_gap.mjs";
  const annotatedAbs = join(tmp, annotatedRel);
  mkdirSync(dirname(annotatedAbs), { recursive: true });
  writeFileSync(annotatedAbs, "// @planner:module = idempotence_fixture\nexport const value = 1;\n");
  writeFileSync(join(planDir, "plan.md"), [
    "# Plan v0",
    "",
    "## Problem Statement",
    "Exercise idempotence for the annotation gate.",
    "",
    "## Files To Modify",
    `- ${annotatedRel}`,
    "",
    "## Steps",
    "1. Run the fixture.",
    "",
    "## Verification Strategy",
    "Use gate_idempotence_check.mjs against the target gate.",
    "",
    "## Success Criteria",
    "- GATE-PLN-ANN-001 is evaluated and stable.",
    "",
    "## Semantic Upkeep Contract",
    "- Profile: integration_backend_orchestration",
  ].join("\n"));
  const planGateOut = runNodeCapture([verifyGate, "plan-to-execute", "--plan", planName], tmp);
  assert(planGateOut.includes("GATE-PLN-ANN-001"), "plan-to-execute fixture exercises GATE-PLN-ANN-001");
  const planIdem = JSON.parse(runNode([idempotence, "--cwd", tmp, "--plan", planName, "--gate", "plan-to-execute", "--json"], tmp));
  assert(planIdem.ok === true && planIdem.results[0]?.idempotent === true, "plan-to-execute remains idempotent while GATE-PLN-ANN-001 fires");

  writeFileSync(join(planDir, "red_team_notes.md"), [
    "## Vector 1: Thin parser bypass",
    "Attack: thin",
    "Impact: thin",
    "Mitigation: thin",
    "",
    "## Vector 2: Thin state bypass",
    "Attack: thin",
    "Impact: thin",
    "Mitigation: thin",
    "",
    "## Vector 3: Thin proof bypass",
    "Attack: thin",
    "Impact: thin",
    "Mitigation: thin",
  ].join("\n"));
  writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] Seed fixture\n");
  const reflectGateOut = runNodeCapture([verifyGate, "execute-to-reflect", "--plan", planName], tmp);
  assert(reflectGateOut.includes("GATE-ETR-008"), "execute-to-reflect fixture exercises GATE-ETR-008");
  assert(/\[FAIL\]\s+\[GATE-ETR-008\]/.test(reflectGateOut), "execute-to-reflect fixture makes GATE-ETR-008 fail");
  const reflectIdem = JSON.parse(runNode([idempotence, "--cwd", tmp, "--plan", planName, "--gate", "execute-to-reflect", "--json"], tmp));
  assert(reflectIdem.ok === true && reflectIdem.results[0]?.idempotent === true, "execute-to-reflect remains idempotent while GATE-ETR-008 fires");

  // The CLI exits 0 and reports stability for the active plan.
  const cliOut = runNode([idempotence, "--cwd", tmp, "--gate", "explore-to-plan"], tmp);
  assert(/✓ explore-to-plan/.test(cliOut), "CLI reports explore-to-plan stable");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
