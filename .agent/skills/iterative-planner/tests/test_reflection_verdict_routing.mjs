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
import {
  computeAntiRecurrenceSignal,
  extractAntiRecurrenceMarkdownEvidence,
  looksLikeConfigPath,
  looksLikeOntologyDslPath,
  parseMarkdownTable,
  refreshPlanArtifacts,
  requiresTestEvidence,
  verificationEvidenceSupportsProgressClosure,
  verificationShowsPassingCommand,
} from "../scripts/lib/plan_refresh.mjs";
import { buildGateRepairPacket } from "../scripts/verify_gate.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

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

function buildSandboxedPlan(reflection, options = {}) {
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
  writeFileSync(join(planDir, "progress.md"), options.progressContent || "# Progress\n\n## Open Items\n- none\n\n## Completed Items\n- step 1\n");
  writeFileSync(join(planDir, "verification.md"), options.verificationContent || "# Verification\n\n## Test Drift Scan\nN/A\n\n## Regression Audit\nN/A\n");
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
  return kbSignoff("no_new_learnings", reason);
}

function kbSignoff(decision, reason = "Regression fixture produced no durable KB learning.") {
  return [
    "## Knowledge Base Sign-Off",
    `- Decision: ${decision}`,
    `- Reason: ${reason}`,
  ].join("\n");
}

function passingVerificationContent() {
  return [
    "# Verification",
    "",
    "## Criteria Verification",
    "| Criterion | Status | Evidence |",
    "| --- | --- | --- |",
    "| sc_1 | PASS | Focused regression covered positive and negative close-readiness paths. |",
    "| sc_2 | PASS | Administrative progress close-readiness was derived from proof. |",
    "",
    "## Proof of Work",
    "```text",
    "PASS focused reflection verdict routing regression",
    "PASS generated close readiness refreshed",
    "0 errors observed",
    "```",
    "",
    "## Regression Audit",
    "PASS - Existing REFLECT gate routing remains covered.",
    "",
  ].join("\n");
}

function administrativeProgressContent() {
  return [
    "# Progress",
    "",
    "## Completed",
    "- [x] Implemented close-signal parser change.",
    "- [x] Ran focused regression proof.",
    "",
    "## Remaining",
    "- [ ] Update Program Packet lifecycle after child plan reaches CLOSE.",
    "- [ ] Commit E8-8 closeout evidence after close.",
    "",
  ].join("\n");
}

function substantiveProgressContent() {
  return [
    "# Progress",
    "",
    "## Completed",
    "- [x] Investigated close-signal parser.",
    "",
    "## Remaining",
    "- [ ] Implement parser fix before VALIDATE.",
    "",
  ].join("\n");
}

function runRefGate({ tmp, planDirName }) {
  try {
    const out = execFileSync(NODE, [verifyGate, "reflect-to-validate", "--plan", planDirName], {
      cwd: tmp,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: plannerSubprocessEnv({ PLANNER_VERBOSE_CHECKS: "1" }),
    });
    return { code: 0, stdout: out };
  } catch (error) {
    return { code: error.status || 1, stdout: (error.stdout || "") + (error.stderr || "") };
  }
}

console.log("\nReflection Verdict Routing\n");

const cleanups = [];
try {
  const emptyTable = parseMarkdownTable("ordinary prose without a table");
  assert(emptyTable.header.length === 0 && emptyTable.rows.length === 0,
    "plan_refresh table parser keeps prose outside the structured proof boundary");
  const parsedTable = parseMarkdownTable("| Command | Status |\n|---|---|\n| node fixture.mjs | PASS |\n| | |");
  assert(parsedTable.header.join(",") === "Command,Status" && parsedTable.rows.length === 1,
    "plan_refresh table parser trims cells and removes empty rows");

  const noStructuredClosure = verificationEvidenceSupportsProgressClosure("# Verification\n\nPASS in prose only\n");
  assert(noStructuredClosure.satisfied === false && noStructuredClosure.reason.includes("canonical structured"),
    "administrative closeout rejects unstructured PASS prose");
  const noProofClosure = verificationEvidenceSupportsProgressClosure([
    "# Verification",
    "",
    "## Criteria Verification",
    "| Criterion | Status | Evidence |",
    "|---|---|---|",
    "| sc_1 | PASS | Structured status only. |",
  ].join("\n"));
  assert(noProofClosure.satisfied === false && noProofClosure.reason.includes("substantive recorded artifact"),
    "administrative closeout requires proof-of-work beyond a passing status row");
  const completeClosure = verificationEvidenceSupportsProgressClosure(passingVerificationContent());
  assert(completeClosure.satisfied === true,
    "administrative closeout accepts canonical passing rows plus substantive proof");

  const missingGuard = extractAntiRecurrenceMarkdownEvidence("# Verification\n");
  assert(missingGuard.present === false && missingGuard.status === "missing",
    "anti-recurrence parser reports a missing section explicitly");
  const passingWithoutGuard = extractAntiRecurrenceMarkdownEvidence("# Verification\n\n## Anti-Recurrence Guard\nStatus: PASS\n");
  assert(passingWithoutGuard.satisfied === false && passingWithoutGuard.status === "section_without_guard_type",
    "anti-recurrence parser rejects PASS without a governed guard type");
  const failedGuard = extractAntiRecurrenceMarkdownEvidence("# Verification\n\n## Anti-Recurrence Guard\nStatus: FAIL\nGuard Types: test\n");
  assert(failedGuard.satisfied === false && failedGuard.status === "section_without_pass",
    "anti-recurrence parser rejects guard metadata attached to FAIL");

  const notRequiredGuard = computeAntiRecurrenceSignal({
    stateJson: { goal: "Document a bounded feature" },
    planContent: "# Plan\n\n## Goal\nDocument a bounded feature\n",
    verificationContent: "# Verification\n",
    verificationLedger: null,
  });
  assert(notRequiredGuard.required === false && notRequiredGuard.status === "not_required",
    "anti-recurrence signal stays inactive without a defect or regression trigger");
  const waivedGuard = computeAntiRecurrenceSignal({
    stateJson: { goal: "Fix a recurring proof regression" },
    planContent: "# Plan\n",
    verificationContent: "# Verification\n",
    verificationLedger: {
      waivers: [{
        subject: "plan:anti-recurrence",
        approved_by: "maintainer",
        reason: "The isolated fixture has no persistent production surface.",
      }],
    },
  });
  assert(waivedGuard.satisfied === true && waivedGuard.status === "waived" && waivedGuard.waiver_approved_by === "maintainer",
    "anti-recurrence signal accepts an explicit approved structured waiver");
  const ledgerGuard = computeAntiRecurrenceSignal({
    stateJson: { goal: "Fix a recurring proof regression" },
    planContent: "# Plan\n",
    verificationContent: "# Verification\n",
    verificationLedger: {
      evidence: [{
        subject: "plan:anti-recurrence",
        status: "PASSED",
        guard_types: ["test", "ontology"],
      }],
    },
  });
  assert(ledgerGuard.satisfied === true && ledgerGuard.status === "verification_ledger" && ledgerGuard.guard_types.length === 2,
    "anti-recurrence signal derives canonical passing ledger evidence and nested guard types");

  assert(looksLikeConfigPath("config/runtime.json") === true && looksLikeConfigPath("config/.integrity") === true,
    "config-path classification covers typed and hidden governed config artifacts");
  assert(looksLikeConfigPath("config/runtime.txt") === false && looksLikeConfigPath("package.json") === true,
    "config-path classification excludes arbitrary config-folder text while retaining known root config");
  assert(looksLikeOntologyDslPath("prolog/rules.pl") === true && looksLikeOntologyDslPath("scripts/tool.pl") === false,
    "ontology-path classification requires both a governed DSL extension and ontology directory");
  assert(requiresTestEvidence("src/app.mjs") === true && requiresTestEvidence("prolog/rules.pl") === false,
    "test-evidence classification separates executable code from governed ontology DSL");

  assert(verificationShowsPassingCommand("", "node fixture.mjs") === false,
    "command proof rejects missing verification content");
  assert(verificationShowsPassingCommand("# Verification", "") === false,
    "command proof rejects an empty required command");
  assert(verificationShowsPassingCommand("# Verification\n\n## Proof of Work\nplain prose", "node fixture.mjs") === false,
    "command proof rejects prose without structured columns");
  const commandRows = [
    "# Verification",
    "",
    "## Proof of Work",
    "| Command | Status | Evidence |",
    "|---|---|---|",
    "| node fixture.mjs | FAIL | Firing negative. |",
    "| node fixture.mjs | PASS | Executed proof. |",
  ].join("\n");
  assert(verificationShowsPassingCommand(commandRows, "node fixture.mjs") === true,
    "command proof skips a matching FAIL row and requires a matching canonical PASS row");
  assert(verificationShowsPassingCommand(commandRows, "node other.mjs") === false,
    "command proof rejects canonical PASS attached to a different command");

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

  env = buildSandboxedPlan(makeReflection({
    solution: "pass — implementation verified and tests green",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
    kbSignoff: kbSignoff("no new learnings", "Focused regression fixture has no durable mistake, pattern, or gotcha."),
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/KB status = no_new_learnings via reflection\.md|PASS.*GATE-REF-004|KB no-new-learnings sign-off found via reflection\.md/i.test(result.stdout),
    "reflection Knowledge Base Sign-Off accepts spaced 'no new learnings'");

  env = buildSandboxedPlan(makeReflection({
    solution: "pass — implementation verified and tests green",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
    kbSignoff: kbSignoff("no new KB entry", "Focused regression fixture produced no reusable KB entry."),
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/KB status = no_new_learnings via reflection\.md|PASS.*GATE-REF-004|KB no-new-learnings sign-off found via reflection\.md/i.test(result.stdout),
    "reflection Knowledge Base Sign-Off accepts 'no new KB entry' with a meaningful reason");

  env = buildSandboxedPlan(makeReflection({
    solution: "pass — implementation verified and tests green",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
    kbSignoff: kbSignoff("no new KB entry", "pending"),
  }));
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/GATE-REF-004.*FAIL|KB status = missing|No KB update evidence/i.test(result.stdout),
    "weak 'no new KB entry' sign-off still blocks GATE-REF-004");

  env = buildSandboxedPlan(makeReflection({
    solution: "pass — implementation verified and tests green",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
    kbSignoff: noNewLearningsSignoff("Focused regression fixture has no durable mistake, pattern, or gotcha."),
  }), {
    progressContent: administrativeProgressContent(),
    verificationContent: passingVerificationContent(),
  });
  cleanups.push(env.tmp);
  refreshPlanArtifacts({
    cwd: env.tmp,
    skillPath: join(testDir, ".."),
    planDirName: env.planDirName,
    refreshOntology: false,
  });
  let progressState = JSON.parse(readFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), "utf-8"));
  assert(progressState.close_signals?.progress?.satisfied === true &&
      progressState.close_signals?.progress?.derived_from_verification === true,
    "plan_refresh derives progress readiness for evidence-backed administrative closeout items");
  result = runRefGate(env);
  assert(/GATE-REF-003.*PASS|administrative closeout item/i.test(result.stdout),
    "evidence-backed administrative progress items satisfy GATE-REF-003");

  env = buildSandboxedPlan(makeReflection({
    solution: "pass — implementation verified and tests green",
    semantic: "pass — semantic upkeep complete",
    evidence: "pass — evidence ready",
    nextMove: "Proceed to VALIDATE",
    kbSignoff: noNewLearningsSignoff("Focused regression fixture has no durable mistake, pattern, or gotcha."),
  }), {
    progressContent: substantiveProgressContent(),
    verificationContent: passingVerificationContent(),
  });
  cleanups.push(env.tmp);
  result = runRefGate(env);
  assert(/GATE-REF-003.*FAIL|blocking progress item|open progress item|uncompleted item/i.test(result.stdout),
    "substantive open progress item still blocks GATE-REF-003");
  refreshPlanArtifacts({
    cwd: env.tmp,
    skillPath: join(testDir, ".."),
    planDirName: env.planDirName,
    refreshOntology: false,
  });
  progressState = JSON.parse(readFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), "utf-8"));
  assert(progressState.close_signals?.progress?.satisfied === false,
    "plan_refresh does not derive progress readiness for substantive open work");

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

  writeFileSync(join(env.tmp, "plans", env.planDirName, "verification.md"), "# Verification\n\n## Regression Audit\nPASS\n");
  refreshPlanArtifacts({
    cwd: env.tmp,
    skillPath: join(testDir, ".."),
    planDirName: env.planDirName,
    refreshOntology: false,
  });
  let guardState = JSON.parse(readFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), "utf-8"));
  assert(guardState.close_signals?.anti_recurrence?.required === true &&
      guardState.close_signals?.anti_recurrence?.status === "missing" &&
      guardState.close_signals?.anti_recurrence?.satisfied === false,
    "plan_refresh keeps a required anti-recurrence guard red when its verification section is missing");

  writeFileSync(join(env.tmp, "plans", env.planDirName, "verification.md"), [
    "# Verification",
    "",
    "## Anti-Recurrence Guard",
    "| Status | Guard Type | Evidence |",
    "|---|---|---|",
    "| FAIL | structural | Negative control remains red. |",
    "| PASS | test, ontology | Executed guard and scanner proof. |",
    "",
  ].join("\n"));
  refreshPlanArtifacts({
    cwd: env.tmp,
    skillPath: join(testDir, ".."),
    planDirName: env.planDirName,
    refreshOntology: false,
  });
  guardState = JSON.parse(readFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), "utf-8"));
  assert(guardState.close_signals?.anti_recurrence?.satisfied === true &&
      (guardState.close_signals?.anti_recurrence?.guard_types || []).includes("ontology"),
    "plan_refresh reads guard types only from a canonical PASS table row");

  writeFileSync(join(env.tmp, "plans", env.planDirName, "verification.md"), [
    "# Verification",
    "",
    "## Anti-Recurrence Guard",
    "Status: PASS",
    "Guard Types: test / structural",
    "",
  ].join("\n"));
  refreshPlanArtifacts({
    cwd: env.tmp,
    skillPath: join(testDir, ".."),
    planDirName: env.planDirName,
    refreshOntology: false,
  });
  guardState = JSON.parse(readFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), "utf-8"));
  assert(guardState.close_signals?.anti_recurrence?.satisfied === true,
    "plan_refresh accepts labeled canonical anti-recurrence status and guard types");

  writeFileSync(join(env.tmp, "plans", env.planDirName, "plan.md"), [
    "# Plan",
    "",
    "## Goal",
    "Fix planner-core proof command truth.",
    "",
    "## Files To Modify",
    "- .agent/skills/iterative-planner/scripts/transition.mjs",
    "",
  ].join("\n"));
  writeFileSync(join(env.tmp, "plans", env.planDirName, "verification.md"), [
    "# Verification",
    "",
    "## Proof of Work",
    "| Command | Status | Evidence |",
    "|---|---|---|",
    "| node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest | FAIL | Firing negative control. |",
    "| node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest | PASS | Migration proof passed. |",
    "| node .agent/skills/iterative-planner/tests/ive/run.mjs --only preplanning-scaffolding --json --no-manifest | PASS | Preplanning proof passed. |",
    "| node .agent/skills/iterative-planner/tests/ive/run.mjs --only transition-gate-flows --json --no-manifest | PASS | Journey proof passed. |",
    "| node .agent/skills/iterative-planner/tests/ive/run.mjs --only gate-or-delete-census --json --no-manifest | PASS | Census proof passed. |",
    "",
  ].join("\n"));
  refreshPlanArtifacts({
    cwd: env.tmp,
    skillPath: join(testDir, ".."),
    planDirName: env.planDirName,
    refreshOntology: false,
  });
  const plannerCoreState = JSON.parse(readFileSync(join(env.tmp, "plans", env.planDirName, "state.json"), "utf-8"));
  assert(plannerCoreState.close_signals?.planner_core?.proof_bundle_required === true &&
      plannerCoreState.close_signals?.planner_core?.proof_bundle_verified === true &&
      plannerCoreState.close_signals?.planner_core?.proof_bundle_missing_commands?.length === 0,
    "plan_refresh requires canonical PASS command rows for every planner-core proof-bundle command");

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
