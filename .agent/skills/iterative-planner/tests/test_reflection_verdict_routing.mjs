#!/usr/bin/env node
// test_reflection_verdict_routing.mjs — Reflection-verdict routing contract.
//
// Phase 2 of ritual elimination: reflection.md verdicts must drive routing,
// not be parsed and discarded. fail → return_to_plan; warn → require ack;
// pass → proceed.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { refreshPlanArtifacts } from "../scripts/lib/plan_refresh.mjs";
import { buildGateRepairPacket } from "../scripts/verify_gate.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const verifyGate = join(testDir, "..", "scripts", "verify_gate.mjs");
const bootstrapScript = join(testDir, "..", "scripts", "bootstrap.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

function buildSandboxedPlan(reflection) {
  const tmp = mkdtempSync(join(tmpdir(), "reflection-routing-"));
  const planDirName = "plan_2026-01-01_test";
  const plansDir = join(tmp, "plans");
  const planDir = join(plansDir, planDirName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(plansDir, ".current_plan"), planDirName);
  mkdirSync(join(plansDir, "knowledge"), { recursive: true });
  writeFileSync(join(plansDir, "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(plansDir, "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(plansDir, "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(plansDir, "knowledge", "gotchas.md"), "# Gotchas\n");
  writeFileSync(join(planDir, "reflection.md"), reflection);
  writeFileSync(join(planDir, "plan.md"), "# Plan\n\n## Goal\nstub\n\n## Files To Modify\n- some/file.mjs\n");
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    plan_dir_name: planDirName,
    state: "REFLECT",
    iteration: 0,
    goal: "stub",
    transitions: [],
    close_signals: {},
    kb_digest_hash: null,
  }, null, 2));
  writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Open Items\n- none\n\n## Completed Items\n- step 1\n");
  writeFileSync(join(planDir, "verification.md"), "# Verification\n\n## Test Drift Scan\nN/A\n\n## Regression Audit\nN/A\n");
  writeFileSync(join(planDir, "decisions.md"), "# Decisions\n\n[APPROVED] stub\n");
  return { tmp, planDirName };
}

function makeReflection({ solution, semantic, evidence, nextMove, ackBlock = "", kbSignoff = "" }) {
  return [
    "# Reflection\n",
    "## Solution Verdict",
    solution,
    "",
    "## Semantic Verdict",
    semantic,
    "",
    "## Evidence-Readiness Verdict",
    evidence,
    "",
    "## Next Move",
    nextMove,
    "",
    kbSignoff,
    "",
    ackBlock,
    "",
  ].join("\n");
}

function noNewLearningsSignoff(reason = "Regression fixture produced no durable KB learning.") {
  return [
    "## Knowledge Base Sign-Off",
    "- Decision: no_new_learnings",
    `- Reason: ${reason}`,
  ].join("\n");
}

function runRefGate({ tmp, planDirName }) {
  try {
    const out = execFileSync(NODE, [verifyGate, "reflect-to-validate", "--plan", planDirName], {
      cwd: tmp,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout: out };
  } catch (error) {
    return { code: error.status || 1, stdout: (error.stdout || "") + (error.stderr || "") };
  }
}

console.log("\nReflection Verdict Routing\n");

const cleanups = [];
try {
  const bootstrapSource = readFileSync(bootstrapScript, "utf-8");
  assert(bootstrapSource.includes("## Knowledge Base Sign-Off") && bootstrapSource.includes("- Decision: pending"),
    "bootstrap reflection scaffold pre-fills a pending Knowledge Base Sign-Off");

  // PASS — all verdicts pass, nextMove forward
  let env = buildSandboxedPlan(makeReflection({
    solution: "pass — implementation verified and tests green",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
  }));
  cleanups.push(env.tmp);
  let result = runRefGate(env);
  assert(/GATE-REF-002.*PASS|reflection.md records pass/i.test(result.stdout),
    "all-pass reflection passes GATE-REF-002");
  assert(/Knowledge base\/semantic record is updated before VALIDATE.*FAIL|GATE-REF-004/i.test(result.stdout),
    "all-pass reflection without KB sign-off still surfaces GATE-REF-004");

  // KB sign-off in reflection.md — no generated JSON edit required
  env = buildSandboxedPlan(makeReflection({
    solution: "pass — implementation verified and tests green",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
    kbSignoff: noNewLearningsSignoff("Focused regression fixture has no durable mistake, pattern, or gotcha."),
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/KB no-new-learnings sign-off found via reflection\.md|PASS.*GATE-REF-004|KB status = no_new_learnings via reflection\.md/i.test(result.stdout),
    "reflection Knowledge Base Sign-Off satisfies GATE-REF-004 without state.json edits");

  refreshPlanArtifacts({
    cwd: env.tmp,
    skillPath: join(testDir, ".."),
    planDirName: env.planDirName,
    refreshOntology: false,
  });
  const refreshedState = JSON.parse(readFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), "utf-8"));
  assert(refreshedState.close_signals?.kb?.satisfied === true,
    "plan_refresh derives generated KB readiness from reflection sign-off");
  assert((refreshedState.close_signals?.kb?.signoff_sources || []).includes("reflection.md"),
    "generated KB readiness records reflection.md as the sign-off source");

  writeFileSync(join(env.tmp, "plans", env.planDirName, "verification.md"), [
    "# Verification",
    "",
    "## Anti-Recurrence Guard",
    "PASS - Guard Type: test - focused regression covers the defect shape.",
    "",
  ].join("\n"));
  refreshedState.goal = "Fix bug in reflection gate artifact normalization";
  writeFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), JSON.stringify(refreshedState, null, 2));
  refreshPlanArtifacts({
    cwd: env.tmp,
    skillPath: join(testDir, ".."),
    planDirName: env.planDirName,
    refreshOntology: false,
  });
  const antiRecurrenceState = JSON.parse(readFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), "utf-8"));
  assert(antiRecurrenceState.close_signals?.anti_recurrence?.satisfied === true &&
      (antiRecurrenceState.close_signals?.anti_recurrence?.guard_types || []).includes("test"),
    "plan_refresh accepts inline PASS - Guard Type anti-recurrence evidence");

  const packet = buildGateRepairPacket({
    planDirName: env.planDirName,
    gateName: "reflect-to-validate",
    results: [{
      status: "FAIL",
      code: "GATE-REF-004",
      name: "Knowledge base/semantic record is updated before VALIDATE",
      detail: "Structured close signal: KB status = missing",
    }],
  }).join("\n");
  assert(packet.includes("Do not edit `state.json.close_signals`") && packet.includes("Decision: no_new_learnings"),
    "GATE-REF-004 repair packet points to reflection sign-off instead of JSON editing");

  // FAIL — solution fails
  env = buildSandboxedPlan(makeReflection({
    solution: "fail — root cause not addressed",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Re-plan: revisit root cause",
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/Return to PLAN/i.test(result.stdout), "fail verdict surfaces 'Return to PLAN' guidance");
  assert(/include FAIL/i.test(result.stdout), "fail verdict surfaces FAIL list in detail");

  // WARN without acknowledgment — blocks
  env = buildSandboxedPlan(makeReflection({
    solution: "warn — partial coverage",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/include WARN/i.test(result.stdout), "warn verdict without acknowledgment is surfaced");
  assert(/Warnings Acknowledged/i.test(result.stdout), "warn verdict guidance names the acknowledgment line");

  // WARN with acknowledgment — passes
  env = buildSandboxedPlan(makeReflection({
    solution: "warn — partial coverage",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
    ackBlock: "## Warnings Acknowledged\nResidual risk: solution covers 80% of edge cases.",
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/warn\(s\) acknowledged|reflection.md records pass/i.test(result.stdout),
    "warn verdict with explicit Warnings Acknowledged section passes");

  // Unparseable — blocks distinctly
  env = buildSandboxedPlan(makeReflection({
    solution: "uncertain at this point in time",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/unparseable/i.test(result.stdout), "verdict that doesn't normalize is reported as unparseable");

  // Next move points back to PLAN
  env = buildSandboxedPlan(makeReflection({
    solution: "pass — implementation verified",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Re-plan: scope drift detected",
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/next move does not allow VALIDATE|Return to PLAN/i.test(result.stdout),
    "next-move pointing to re-plan blocks transition");

} finally {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
