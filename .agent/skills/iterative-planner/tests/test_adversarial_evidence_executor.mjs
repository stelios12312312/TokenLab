#!/usr/bin/env node
// Contract tests for fresh-context adversarial evidence reruns at verified close.

import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  ADVERSARIAL_EVIDENCE_RECEIPT_SCHEMA,
  executeAdversarialEvidenceJob,
} from "../scripts/adversarial_evidence_executor.mjs";
import {
  composeAdversarialEvidenceRerun,
  selectAdversarialEvidence,
} from "../scripts/lib/quant_results_validation.mjs";
import { serializeToFacts } from "../scripts/ontology_serializer.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

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

function writeEmitter(dir) {
  const path = join(dir, "emit-json.mjs");
  writeFileSync(path, [
    "const variant = process.argv[2] || 'good';",
    "const payloads = {",
    "  good: { evl: { funded_assets: 2, eligible_assets: 5, evaluated_assets: 5, reserve_stamp: 'reserve-v1' }, tennis: { log_loss: 0.421 } },",
    "  funding_collapse: { evl: { funded_assets: 1, eligible_assets: 5, evaluated_assets: 5, reserve_stamp: 'reserve-v1' }, tennis: { log_loss: 0.421 } },",
    "  eligibility_trap: { evl: { funded_assets: 2, eligible_assets: 5, evaluated_assets: 3, reserve_stamp: 'reserve-v1' }, tennis: { log_loss: 0.421 } },",
    "  missing_reserve: { evl: { funded_assets: 2, eligible_assets: 5, evaluated_assets: 5 }, tennis: { log_loss: 0.421 } },",
    "  tennis_drift: { evl: { funded_assets: 2, eligible_assets: 5, evaluated_assets: 5, reserve_stamp: 'reserve-v1' }, tennis: { log_loss: 0.439 } },",
    "};",
    "process.stdout.write(JSON.stringify({ ...payloads[variant], context: { codex: process.env.CODEX_THREAD_ID || '', planner_target: process.env._PLANNER_PLAN_TARGET || '' } }));",
    "",
  ].join("\n"));
  return path;
}

function evidence(id, selection, command, expectations) {
  return {
    id,
    command,
    rerun: {
      risk_bearing: true,
      selection,
      expected_exit_code: 0,
      timeout_ms: 5000,
      expectations,
    },
  };
}

function exact(path, expected) {
  return { source: "stdout_json", path, comparator: "exact", expected };
}

function numeric(path, expected, absoluteTolerance = 0, relativeTolerance = 0) {
  return {
    source: "stdout_json",
    path,
    comparator: "numeric",
    expected,
    absolute_tolerance: absoluteTolerance,
    relative_tolerance: relativeTolerance,
  };
}

function scenarioSelectionIsProportionalAndDeterministic() {
  const rows = [
    evidence("sample-b", "sample", "node b.mjs", [exact("ok", true)]),
    evidence("critical-a", "critical", "node a.mjs", [exact("ok", true)]),
    evidence("critical-c", "critical", "node c.mjs", [exact("ok", true)]),
  ];
  const critical = selectAdversarialEvidence(rows, { planId: "plan-test" });
  assert(critical.selected.map((row) => row.id).join(",") === "critical-a,critical-c", "all and only declared-critical rows are selected in stable order");

  const sampleRows = rows.filter((row) => row.rerun.selection === "sample").concat([
    evidence("sample-a", "sample", "node a.mjs", [exact("ok", true)]),
  ]);
  const forward = selectAdversarialEvidence(sampleRows, { planId: "plan-test" });
  const reversed = selectAdversarialEvidence([...sampleRows].reverse(), { planId: "plan-test" });
  assert(forward.selected.length === 1, "exactly one row is selected when no row is critical");
  assert(forward.selected[0].id === reversed.selected[0].id, "sample selection is deterministic across ledger ordering");
}

function scenarioWorkerComparesTypedOutputAndSanitizesContext() {
  const dir = mkdtempSync(join(tmpdir(), "planner-adversarial-evidence-"));
  try {
    const emitter = writeEmitter(dir);
    const job = {
      evidence_id: "field-positive",
      command: `${process.execPath} ${emitter} good`,
      cwd: dir,
      expected_exit_code: 0,
      timeout_ms: 5000,
      expectations: [
        exact("evl.funded_assets", 2),
        exact("evl.eligible_assets", 5),
        exact("evl.evaluated_assets", 5),
        exact("evl.reserve_stamp", "reserve-v1"),
        numeric("tennis.log_loss", 0.42, 0.002, 0),
        exact("context.codex", ""),
        exact("context.planner_target", ""),
      ],
    };
    const receipt = executeAdversarialEvidenceJob(job, {
      env: plannerSubprocessEnv({}, {
        ...process.env,
        CODEX_THREAD_ID: "author-thread-must-not-cross",
        _PLANNER_PLAN_TARGET: "author-plan-must-not-cross",
      }),
    });
    assert(receipt.schema_version === ADVERSARIAL_EVIDENCE_RECEIPT_SCHEMA, "worker emits the versioned receipt schema");
    assert(receipt.status === "satisfied", "typed exact and in-tolerance numeric expectations reproduce");
    assert(receipt.executor_pid === process.pid, "direct worker API identifies its executing process");
    assert(Number.isInteger(receipt.duration_ms) && receipt.duration_ms >= 0, "worker receipt records bounded execution duration");
    assert(receipt.comparisons.every((row) => row.satisfied), "positive receipt retains every satisfied typed comparison");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scenarioCliIsFreshProcess() {
  const dir = mkdtempSync(join(tmpdir(), "planner-adversarial-cli-"));
  try {
    const emitter = writeEmitter(dir);
    const worker = resolve(".agent/skills/iterative-planner/scripts/adversarial_evidence_executor.mjs");
    const job = {
      evidence_id: "fresh-process",
      command: `${process.execPath} ${emitter} good`,
      cwd: dir,
      expected_exit_code: 0,
      timeout_ms: 5000,
      expectations: [exact("context.codex", ""), exact("context.planner_target", "")],
    };
    const proc = spawnSync(process.execPath, [worker], {
      cwd: process.cwd(),
      input: JSON.stringify(job),
      encoding: "utf-8",
      env: plannerSubprocessEnv({}, {
        ...process.env,
        CODEX_THREAD_ID: "author-thread-must-not-cross",
        _PLANNER_PLAN_TARGET: "author-plan-must-not-cross",
      }),
      timeout: 10000,
    });
    const receipt = JSON.parse(proc.stdout);
    assert(proc.status === 0 && receipt.status === "satisfied", "standalone worker succeeds through its machine-JSON stdin/stdout boundary");
    assert(receipt.executor_pid !== process.pid && receipt.executor_parent_pid === process.pid, "standalone worker proves fresh process identity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scenarioFieldDivergencesAreNamed() {
  const dir = mkdtempSync(join(tmpdir(), "planner-adversarial-fields-"));
  try {
    const emitter = writeEmitter(dir);
    const cases = [
      ["funding_collapse", exact("evl.funded_assets", 2), "EVL single-asset funding collapse"],
      ["eligibility_trap", exact("evl.evaluated_assets", 5), "EVL eligible-vs-evaluated trap"],
      ["missing_reserve", exact("evl.reserve_stamp", "reserve-v1"), "EVL missing reserve stamp"],
      ["tennis_drift", numeric("tennis.log_loss", 0.421, 0.001, 0), "independent tennis result drift"],
    ];
    for (const [variant, expectation, label] of cases) {
      const receipt = executeAdversarialEvidenceJob({
        evidence_id: variant,
        command: `${process.execPath} ${emitter} ${variant}`,
        cwd: dir,
        expected_exit_code: 0,
        timeout_ms: 5000,
        expectations: [expectation],
      });
      assert(receipt.status === "diverged", `${label} blocks reproduction`);
      assert(receipt.blockers[0].includes(expectation.path), `${label} names the divergent output path`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scenarioWorkerFailsClosed() {
  const dir = mkdtempSync(join(tmpdir(), "planner-adversarial-negative-"));
  try {
    const malformed = join(dir, "malformed.mjs");
    const crashing = join(dir, "crash.mjs");
    const sleeping = join(dir, "sleep.mjs");
    writeFileSync(malformed, "process.stdout.write('not-json');\n");
    writeFileSync(crashing, "process.exit(7);\n");
    writeFileSync(sleeping, "setTimeout(() => process.stdout.write('{}'), 5000);\n");
    const common = { cwd: dir, expected_exit_code: 0, expectations: [exact("ok", true)] };
    const invalid = executeAdversarialEvidenceJob({ evidence_id: "invalid", command: "", timeout_ms: 5000, ...common });
    const parse = executeAdversarialEvidenceJob({ evidence_id: "parse", command: `${process.execPath} ${malformed}`, timeout_ms: 5000, ...common });
    const exit = executeAdversarialEvidenceJob({ evidence_id: "exit", command: `${process.execPath} ${crashing}`, timeout_ms: 5000, ...common });
    const timeout = executeAdversarialEvidenceJob({ evidence_id: "timeout", command: `${process.execPath} ${sleeping}`, timeout_ms: 25, ...common });
    assert(invalid.status === "invalid_contract", "missing runnable command fails contract validation before spawn");
    assert(parse.status === "executor_error" && parse.blockers.some((row) => row.includes("stdout_json")), "malformed JSON stdout fails closed");
    assert(exit.status === "diverged" && exit.observed_exit_code === 7, "unexpected command exit fails with observed code");
    assert(timeout.status === "executor_error" && timeout.timed_out === true, "command timeout fails closed and is named");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scenarioCompositionIsResultOnlyAndFailClosed() {
  const dir = mkdtempSync(join(tmpdir(), "planner-adversarial-compose-"));
  try {
    const emitter = writeEmitter(dir);
    const row = evidence("critical-result", "critical", `${process.execPath} ${emitter} good`, [numeric("tennis.log_loss", 0.421, 0, 0)]);
    const notRequired = composeAdversarialEvidenceRerun({ required: false, satisfied: true, status: "not_required", blocking_issues: [] }, {
      planDir: dir,
      planId: "plan-docs",
      projectRoot: dir,
      evidenceRows: [row],
      execute: true,
    });
    assert(notRequired.adversarial_evidence_rerun_receipt.status === "not_required", "non-result plan is explicitly exempt");

    const deferred = composeAdversarialEvidenceRerun({ required: true, satisfied: true, status: "satisfied", blocking_issues: [] }, {
      planDir: dir,
      planId: "plan-result",
      projectRoot: dir,
      evidenceRows: [row],
      execute: false,
    });
    assert(deferred.adversarial_evidence_rerun_receipt.status === "deferred_until_close", "ordinary refresh does not execute result evidence");

    const satisfied = composeAdversarialEvidenceRerun({ required: true, satisfied: true, status: "satisfied", blocking_issues: [] }, {
      planDir: dir,
      planId: "plan-result",
      projectRoot: dir,
      evidenceRows: [row],
      execute: true,
    });
    assert(satisfied.satisfied === true && satisfied.adversarial_evidence_rerun_receipt.status === "satisfied", "reproducible selected evidence preserves close satisfaction");
    assert(satisfied.adversarial_evidence_rerun_receipt.author_context_reused === false, "composed receipt countersigns fresh executor separation");

    const divergence = composeAdversarialEvidenceRerun({ required: true, satisfied: true, status: "satisfied", blocking_issues: [] }, {
      planDir: dir,
      planId: "plan-result",
      projectRoot: dir,
      evidenceRows: [evidence("critical-drift", "critical", `${process.execPath} ${emitter} tennis_drift`, [numeric("tennis.log_loss", 0.421, 0.001, 0)])],
      execute: true,
    });
    assert(divergence.satisfied === false && divergence.claim_support_allowed === false, "selected divergence removes claim support and blocks close");
    assert(divergence.blocking_issues.some((row) => row.includes("critical-drift") && row.includes("tennis.log_loss")), "close blocker names evidence ID and divergent path");

    const missing = composeAdversarialEvidenceRerun({ required: true, satisfied: true, status: "satisfied", blocking_issues: [] }, {
      planDir: dir,
      planId: "plan-result",
      projectRoot: dir,
      evidenceRows: [],
      execute: true,
    });
    assert(missing.satisfied === false && missing.blocking_issues.includes("missing_runnable_adversarial_evidence"), "result plan without risk-bearing runnable evidence fails closed");

    const baseBlocked = composeAdversarialEvidenceRerun({ required: true, satisfied: false, status: "promotion_blocked", blocking_issues: ["base_invalid"] }, {
      planDir: dir,
      planId: "plan-result",
      projectRoot: dir,
      evidenceRows: [row],
      execute: true,
    });
    assert(baseBlocked.satisfied === false && baseBlocked.blocking_issues.includes("base_invalid"), "passing rerun cannot erase a base result-validation blocker");

    const missingWorker = composeAdversarialEvidenceRerun({ required: true, satisfied: true, status: "satisfied", blocking_issues: [] }, {
      planDir: dir,
      planId: "plan-result",
      projectRoot: dir,
      evidenceRows: [row],
      execute: true,
      executorPath: join(dir, "missing-adversarial-worker.mjs"),
    });
    assert(missingWorker.satisfied === false && missingWorker.adversarial_evidence_rerun_receipt.status === "executor_error", "missing fresh-context worker blocks close");
    assert(missingWorker.blocking_issues.some((issue) => issue.includes("adversarial_evidence_executor_protocol_error:critical-result")), "missing worker failure names the selected evidence and command boundary");

    const allCritical = composeAdversarialEvidenceRerun({ required: true, satisfied: true, status: "satisfied", blocking_issues: [] }, {
      planDir: dir,
      planId: "plan-result",
      projectRoot: dir,
      evidenceRows: [
        evidence("critical-a", "critical", `${process.execPath} ${emitter} good`, [exact("evl.reserve_stamp", "reserve-v1")]),
        evidence("critical-b", "critical", `${process.execPath} ${emitter} good`, [numeric("tennis.log_loss", 0.421, 0, 0)]),
      ],
      execute: true,
    });
    assert(allCritical.satisfied === true && allCritical.adversarial_evidence_rerun_receipt.command_receipts.length === 2, "all declared-critical evidence commands execute before close");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scenarioOntologyConsumesComposedAuthority() {
  const dir = mkdtempSync(join(tmpdir(), "planner-adversarial-ontology-"));
  try {
    writeFileSync(join(dir, "plan.md"), "# Plan\n\n## Goal\n\nProve one result.\n");
    writeFileSync(join(dir, "verification.md"), "# Verification\n");
    writeFileSync(join(dir, "reflection.md"), "# Reflection\n");
    writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "VALIDATE", transitions: [] }));
    const composed = {
      required: true,
      satisfied: false,
      status: "evidence_rerun_diverged",
      blocking_issues: ["adversarial_evidence_divergence:critical-result:node evidence.mjs:numeric_divergence:score"],
      evidence_validity: "invalid",
      claim_support_allowed: false,
      numeric_output_reportable: false,
      adversarial_evidence_rerun_receipt: { status: "diverged" },
    };
    const { facts } = serializeToFacts({
      cwd: dir,
      storyRegistry: { stories: [] },
      planDir: dir,
      planContent: "# Plan\n\n## Goal\n\nProve one result.\n",
      annotations: [],
      quantResultsValidationOverride: composed,
    });
    assert(facts.includes("quant_results_validation_satisfied(false)."), "ontology consumes the composed unsatisfied result without recomputing base truth");
    assert(facts.includes("quant_results_validation_status('evidence_rerun_diverged')."), "ontology preserves the composed rerun status");
    assert(facts.includes("quant_results_blocking_issue('adversarial_evidence_divergence_critical_result_node_evidence_mjs_numeric_divergence_score')."), "ontology preserves the named rerun blocker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

scenarioSelectionIsProportionalAndDeterministic();
scenarioWorkerComparesTypedOutputAndSanitizesContext();
scenarioCliIsFreshProcess();
scenarioFieldDivergencesAreNamed();
scenarioWorkerFailsClosed();
scenarioCompositionIsResultOnlyAndFailClosed();
scenarioOntologyConsumesComposedAuthority();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
