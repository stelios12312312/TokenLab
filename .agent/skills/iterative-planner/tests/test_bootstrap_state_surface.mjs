#!/usr/bin/env node
// test_bootstrap_state_surface.mjs — Ensure operator-facing bootstrap commands
// read canonical state.json rather than stale state.md text.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const agentDir = resolve(skillDir, "../..");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function run(args, cwd, extraEnv = {}) {
  const result = spawnSync(NODE, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Neutralize ALL per-agent identity sources so plan resolution falls back
      // to the .current_plan pointer only. getPlannerThreadId is harness-agnostic
      // (CODEX_THREAD_ID / CLAUDE_CODE_SESSION_ID / _PLANNER_THREAD_ID); leaving
      // any of them inherited would write a thread target that survives a pointer
      // unlink and break the "no active plan" scenario below.
      CODEX_THREAD_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      _PLANNER_THREAD_ID: "",
      _PLANNER_PLAN_TARGET: "",
      PLANNER_SKIP_SELF_HEAL: "1",
      ...extraEnv,
    },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

const tmp = mkdtempSync(join(tmpdir(), "planner-bootstrap-state-"));

try {
  cpSync(agentDir, join(tmp, ".agent"), { recursive: true });

  const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
  const create = run([bootstrapScript, "new", "Bootstrap state surface regression"], tmp);
  assert(create.ok, "bootstrap new exits cleanly");

  const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
  assert(!!planName, "active plan pointer created");
  const activeAliasMarkdown = join(tmp, "plans", "ACTIVE_PLAN.md");
  const activeAliasJson = join(tmp, "plans", "ACTIVE_PLAN.json");
  assert(existsSync(activeAliasMarkdown), "bootstrap new writes plans/ACTIVE_PLAN.md");
  assert(existsSync(activeAliasJson), "bootstrap new writes plans/ACTIVE_PLAN.json");
  assert(readFileSync(activeAliasMarkdown, "utf-8").includes(`plans/${planName}/plan.md`), "active alias markdown points at the current plan files");
  assert(JSON.parse(readFileSync(activeAliasJson, "utf-8"))?.plan_dir_name === planName, "active alias JSON records the current plan name");

  const updateScript = `
    import { join } from "path";
    import { readStateJson, writeStateJson } from "./.agent/skills/iterative-planner/scripts/lib/determinism.mjs";
    const planDir = join(process.cwd(), "plans", ${JSON.stringify(planName)});
    const state = readStateJson(planDir);
    state.state = "EXECUTE";
    state.iteration = 2;
    state.current_step = "repo-debt-cleanup";
    state.transitions.push({
      from: "PLAN",
      to: "EXECUTE",
      timestamp: "2026-04-03T20:00:00.000Z",
      gate_result: "PASS",
      failure_codes: [],
      script_versions: {}
    });
    writeStateJson(planDir, state);
  `;
  const update = run(["--input-type=module", "-e", updateScript], tmp);
  assert(update.ok, "state.json updated with canonical EXECUTE state");

  const status = run([bootstrapScript, "status"], tmp);
  assert(status.ok, "bootstrap status exits cleanly");
  assert(status.stdout.includes("[EXECUTE]"), "bootstrap status reads EXECUTE from state.json");

  const stalePlanName = "plan_2026-04-03_staletab";
  mkdirSync(join(tmp, "plans", stalePlanName), { recursive: true });
  mkdirSync(join(tmp, "plans", planName, "artifacts"), { recursive: true });
  const stalePlanPath = join(tmp, "plans", stalePlanName, "findings.md");
  writeFileSync(stalePlanPath, "# Historical findings\n");
  writeFileSync(join(tmp, "plans", planName, "artifacts", "tool_trace.jsonl"), JSON.stringify({
    ts: "2026-04-04T10:00:00Z",
    seq: 1,
    tool: "Read",
    paths: [stalePlanPath],
    phase: "EXECUTE",
    plan_dir: planName,
  }) + "\n");

  const warnedStatus = run([bootstrapScript, "status"], tmp);
  assert(warnedStatus.ok, "bootstrap status still exits cleanly when stale-plan context is detected");
  assert(warnedStatus.stdout.includes("Recent non-active plan context detected"), "bootstrap status warns about recent non-active plan reads");
  assert(warnedStatus.stdout.includes("plans/ACTIVE_PLAN.md"), "bootstrap status points operators to the canonical active-plan alias");

  const resume = run([bootstrapScript, "resume"], tmp);
  assert(resume.ok, "bootstrap resume exits cleanly");
  assert(resume.stdout.includes("State:      EXECUTE"), "bootstrap resume reads EXECUTE from state.json");
  assert(resume.stdout.includes("Step:       repo-debt-cleanup"), "bootstrap resume reads current_step from state.json");
  assert(resume.stdout.includes("Recent non-active plan context detected"), "bootstrap resume warns about recent non-active plan reads");
  assert(resume.stdout.includes("Alias:      plans/ACTIVE_PLAN.md"), "bootstrap resume surfaces the canonical active-plan alias");

  const list = run([bootstrapScript, "list"], tmp);
  assert(list.ok, "bootstrap list exits cleanly");
  assert(list.stdout.includes("[EXECUTE]"), "bootstrap list shows EXECUTE from state.json");

  const poisonScript = `
    import { join } from "path";
    import { readStateJson, writeStateJson } from "./.agent/skills/iterative-planner/scripts/lib/determinism.mjs";
    const planDir = join(process.cwd(), "plans", ${JSON.stringify(planName)});
    const state = readStateJson(planDir);
    state.transitions = Array.from({ length: 5 }, (_, index) => ({
      from: "EXECUTE",
      to: "EXECUTE",
      timestamp: \`2026-04-03T21:00:0\${index}Z\`,
      gate_result: "FAIL",
      failure_codes: ["GATE-ETR-001"],
      script_versions: {}
    }));
    writeStateJson(planDir, state);
  `;
  const poison = run(["--input-type=module", "-e", poisonScript], tmp);
  assert(poison.ok, "state.json updated with a history-poisoned transition tail");

  const poisonedStatus = run([bootstrapScript, "status"], tmp);
  assert(poisonedStatus.ok, "bootstrap status still exits cleanly for poisoned plans");
  assert(poisonedStatus.stdout.includes("History-poisoned gate tail"), "bootstrap status surfaces the history-poisoned warning");

  const fixStuck = run([bootstrapScript, "fix-stuck"], tmp);
  assert(fixStuck.ok, "bootstrap fix-stuck exits cleanly for poisoned plans");
  assert(fixStuck.stdout.includes("History-poisoned plan detected"), "bootstrap fix-stuck diagnoses history-poisoned plans");
  assert(fixStuck.stdout.includes("Repeated failure codes: GATE-ETR-001"), "bootstrap fix-stuck surfaces the repeated failure-code pattern");
  assert(fixStuck.stdout.includes("recover-poison"), "bootstrap fix-stuck recommends recover-poison after stale failures");

  const fixStuckJson = run([bootstrapScript, "fix-stuck", "--json"], tmp);
  assert(fixStuckJson.ok, "bootstrap fix-stuck --json exits cleanly for poisoned plans");
  const fixStuckPayload = JSON.parse(fixStuckJson.stdout);
  assert(fixStuckPayload.reason_code === "HISTORY_POISON", "bootstrap fix-stuck --json classifies history-poisoned plans deterministically");
  assert(fixStuckPayload.recommended_mode === "recover_poison", "bootstrap fix-stuck --json returns recover_poison as the exact recovery family");
  assert(Array.isArray(fixStuckPayload.related_failure_codes) && fixStuckPayload.related_failure_codes.includes("GATE-ETR-001"), "bootstrap fix-stuck --json preserves repeated failure codes");
  assert(fixStuckPayload.safe_fix_applied === false, "bootstrap fix-stuck --json does not claim a safe auto-fix for poisoned histories");

  const seedRecoveryArtifactsScript = `
    import { join } from "path";
    import { mkdirSync, readFileSync, writeFileSync } from "fs";
    const planDir = join(process.cwd(), "plans", ${JSON.stringify(planName)});
    mkdirSync(join(planDir, "findings"), { recursive: true });
    writeFileSync(join(planDir, "findings", "carry.md"), "# Carry Forward\\nDurable findings should survive poisoned-plan recovery.\\n");
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      fast_track: true,
      kb_digest_salt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      findings: [
        {
          id: "F-001",
          title: "Carry forward ledger-authored findings",
          summary: "Successor recovery should preserve durable findings context.",
          details: [
            "This finding should survive the recovery flow.",
            "The KB digest salt should not."
          ]
        }
      ],
      root_cause: { summary: "Manual recovery is currently fragmented." },
      adjacency: { summary: "bootstrap.mjs and transition.mjs both surface the poison signal." },
      assumptions: [
        { status: "VERIFIED", statement: "Recovery should preserve useful context." }
      ]
    }, null, 2));
    writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({
      version: 1,
      primary_user: "Planner maintainer",
      job_to_be_done: "Recover safely from a poisoned plan without redoing valid exploration",
      desired_outcomes: [],
      anti_goals: [],
      constraints: [],
      deliverables: []
    }, null, 2));
    const decisionsPath = join(planDir, "decisions.md");
    const existing = readFileSync(decisionsPath, "utf-8");
    writeFileSync(decisionsPath, existing + "\\n\\n## D-001\\nPreserve durable reasoning during recovery.\\n\\n[APPROVED:deadbeefdeadbeef]\\n");
  `;
  const seedRecoveryArtifacts = run(["--input-type=module", "-e", seedRecoveryArtifactsScript], tmp);
  assert(seedRecoveryArtifacts.ok, "poisoned bootstrap fixture can seed recovery artifacts before recover-poison");

  const recoverPoison = run([bootstrapScript, "recover-poison"], tmp);
  assert(recoverPoison.ok, "bootstrap recover-poison exits cleanly for poisoned plans");
  assert(recoverPoison.stdout.includes("Recovery complete"), "bootstrap recover-poison reports successful successor-plan recovery");

  const successorName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
  const successorDir = join(tmp, "plans", successorName);
  assert(successorName !== planName, "bootstrap recover-poison activates a fresh successor plan");
  assert(existsSync(successorDir), "bootstrap recover-poison creates the successor plan directory");

  const sourceState = JSON.parse(readFileSync(join(tmp, "plans", planName, "state.json"), "utf-8"));
  assert(sourceState.state === "CLOSE", "bootstrap recover-poison closes the poisoned source plan");
  assert(sourceState.recovery_context?.successor_plan === successorName, "poisoned source plan records its successor in recovery_context");
  assert(readFileSync(join(tmp, "plans", planName, "state.md"), "utf-8").includes("[POISON-RECOVERED]"), "poisoned source plan records the recovery close marker in state.md");

  const successorState = JSON.parse(readFileSync(join(successorDir, "state.json"), "utf-8"));
  assert(successorState.goal === "Bootstrap state surface regression", "bootstrap recover-poison keeps the original goal in the successor plan");
  assert(successorState.recovery_context?.recovered_from_plan === planName, "successor plan state.json records the poisoned source plan");
  assert(Array.isArray(successorState.recovery_context?.poisoned_gates) && successorState.recovery_context.poisoned_gates[0]?.failure_codes?.includes("GATE-ETR-001"), "successor recovery_context keeps the poisoned failure-code context");

  const successorLedger = JSON.parse(readFileSync(join(successorDir, "findings_ledger.json"), "utf-8"));
  assert(successorLedger.kb_digest_salt === null, "bootstrap recover-poison strips stale KB digest salt from carried findings ledger");
  assert(successorLedger.findings?.length === 1, "bootstrap recover-poison carries forward durable structured findings");

  const successorDecisions = readFileSync(join(successorDir, "decisions.md"), "utf-8");
  assert(successorDecisions.includes("Recovery Context"), "successor decisions.md records the recovery context");
  assert(!successorDecisions.includes("[APPROVED:"), "successor decisions.md strips stale approval nonce markers");

  const successorPlan = readFileSync(join(successorDir, "plan.md"), "utf-8");
  assert(successorPlan.includes(`Recovered from history-poisoned plan \`${planName}\``), "successor plan.md records the recovered source plan in Context");
  assert(existsSync(join(successorDir, "findings", "carry.md")), "bootstrap recover-poison carries forward detailed findings artifacts");

  const recoveredAlias = JSON.parse(readFileSync(activeAliasJson, "utf-8"));
  assert(recoveredAlias?.plan_dir_name === successorName, "ACTIVE_PLAN.json switches to the successor plan after recover-poison");

  unlinkSync(join(tmp, "plans", ".current_plan"));
  const noActiveStatus = run([bootstrapScript, "status"], tmp);
  assert(noActiveStatus.ok, "bootstrap status exits cleanly without an active plan");
  assert(noActiveStatus.stdout.includes("No active plan."), "bootstrap status reports the missing active plan");
  assert(noActiveStatus.stdout.includes("plans/ACTIVE_PLAN.md"), "bootstrap status still points to the canonical alias when no plan is active");
  const noActiveAlias = JSON.parse(readFileSync(activeAliasJson, "utf-8"));
  assert(noActiveAlias?.active === false, "active alias JSON switches to no-active mode when the pointer is missing");
  assert(readFileSync(activeAliasMarkdown, "utf-8").includes("No active plan."), "active alias markdown switches to a no-active recovery stub");

  const newAfterPointerLoss = run([bootstrapScript, "new", "Bootstrap should warn when an open plan loses its pointer"], tmp);
  assert(newAfterPointerLoss.ok, "bootstrap new still exits cleanly when recreating after pointer loss");
  const pointerLossOutput = newAfterPointerLoss.stdout + newAfterPointerLoss.stderr;
  assert(pointerLossOutput.includes("non-closed plan director"), "bootstrap new warns when a non-closed plan exists without an active pointer");
  assert(pointerLossOutput.includes("manual pointer removal"), "bootstrap new explains manual pointer removal as a realistic warning cause");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

const closedHistoryTmp = mkdtempSync(join(tmpdir(), "planner-bootstrap-closed-history-"));

try {
  cpSync(agentDir, join(closedHistoryTmp, ".agent"), { recursive: true });

  const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
  const create = run([bootstrapScript, "new", "Bootstrap should not warn for closed history"], closedHistoryTmp);
  assert(create.ok, "bootstrap new exits cleanly for the closed-history fixture");

  const close = run([bootstrapScript, "close", "--informational"], closedHistoryTmp);
  assert(close.ok, "bootstrap close --informational exits cleanly for the closed-history fixture");

  const newAfterClose = run([bootstrapScript, "new", "Bootstrap should stay quiet after a clean close"], closedHistoryTmp);
  assert(newAfterClose.ok, "bootstrap new exits cleanly after a normal close");
  const closedHistoryOutput = newAfterClose.stdout + newAfterClose.stderr;
  assert(!closedHistoryOutput.includes("non-closed plan director"), "bootstrap new does not warn when only closed historical plans remain");
  assert(!closedHistoryOutput.includes("previous crash"), "bootstrap new does not mislabel closed plan history as crash residue");
} finally {
  try { rmSync(closedHistoryTmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
