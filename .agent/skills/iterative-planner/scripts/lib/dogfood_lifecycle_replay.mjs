// dogfood_lifecycle_replay.mjs - current-code replay over committed lifecycle proof.
// @planner:module = dogfood_lifecycle_replay
// @planner:capability = committed_dogfood_lifecycle_current_contract_replay

import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { pathToFileURL } from "url";
import { evaluateGateResults } from "../verify_gate.mjs";
import { createSession } from "./prolog.mjs";
import { loadRules, loadStateFacts } from "./fact_loader.mjs";
import { withEnvValues } from "./env_scope.mjs";
import { resolveGateInputSnapshot } from "./gate_input_snapshot.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";
import {
  getWorkflowContract,
  requiredArtifactsForPhase,
} from "./workflow_contracts.mjs";

export const DOGFOOD_LIFECYCLE_REPLAY_SCHEMA_VERSION = 1;
export const DEFAULT_DOGFOOD_PLAN_SPECS = Object.freeze([
  Object.freeze({
    plan_dir: "plans/plan_2026-07-06_a562d891f2f965d0",
    shape: "planner_core_fix",
    evidence_ref: "T-INTAKE-34C0058D",
  }),
  Object.freeze({
    plan_dir: "plans/plan_2026-07-07_d07f86dd2adff3da",
    shape: "lifecycle_test_plan",
    evidence_ref: "T-INTAKE-98ADC736,T-INTAKE-45517BB4",
  }),
  Object.freeze({
    plan_dir: "plans/plan_2026-07-09_09ac37d240a5fc72",
    shape: "program_ticket_child_plan",
    evidence_ref: "T-INTAKE-A4763B4B",
  }),
]);

const STATEFUL_GATES = Object.freeze([
  "explore-to-plan",
  "plan-to-execute",
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
]);
const ALL_GATES = Object.freeze([...STATEFUL_GATES, "notify-user"]);
const CANONICAL_ARTIFACTS = Object.freeze([
  "state.json",
  "state.md",
  "findings.md",
  "plan.md",
  "decisions.md",
  "progress.md",
  "red_team_notes.md",
  "reflection.md",
  "verification.md",
  "artifacts/decision_log.jsonl",
]);
const CLOSE_SIGNAL_KEYS = Object.freeze(["progress", "kb"]);
const CURRENT_GATE_RESULT_MARKER = "__IVE_CURRENT_GATE_RESULT__";
const CURRENT_GATE_TIMEOUT_MS = 120000;
const HISTORICAL_ONLY_CURRENT_CHECK_CODES = Object.freeze(new Set([
  "GATE-EXP-010",
]));

function normalizeSlash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function compactErrorDetail(value, max = 2000) {
  const text = String(value || "").trim();
  return text.length <= max ? text : `${text.slice(0, max)}...[truncated]`;
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function addFailure(failures, { code, plan, gate = null, artifact = null, detail }) {
  failures.push({ code, plan, gate, artifact, detail });
}

function parseJsonLines(path) {
  if (!existsSync(path)) return { ok: false, records: [], errors: ["file missing"] };
  const records = [];
  const errors = [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      errors.push(`line ${index + 1}: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, records, errors };
}

function gitTracks(repoRoot, relativePath) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function gateRegistry(repoRoot) {
  const path = join(repoRoot, ".agent", "skills", "iterative-planner", "config", "gates.json");
  const parsed = readJson(path);
  if (!parsed.ok) return { ok: false, path, gates: {}, error: parsed.error };
  return { ok: true, path, gates: parsed.value?.gates || {} };
}

function normalizeState(value) {
  return String(value || "").trim().toLowerCase();
}

function successfulTransitionChain(stateJson, gates) {
  const successful = (Array.isArray(stateJson?.transitions) ? stateJson.transitions : [])
    .filter((entry) => String(entry?.gate_result || "").toUpperCase() === "PASS")
    .filter((entry) => normalizeState(entry?.from) !== "init");
  return STATEFUL_GATES.map((gate, index) => {
    const definition = gates[gate] || {};
    const entry = successful[index] || null;
    const expectedFrom = Array.isArray(definition.from) ? definition.from[0] : definition.from;
    const expectedTo = definition.to;
    const ok = Boolean(entry)
      && normalizeState(entry.from) === normalizeState(expectedFrom)
      && normalizeState(entry.to) === normalizeState(expectedTo);
    return {
      gate,
      ok,
      expected: { from: normalizeState(expectedFrom), to: normalizeState(expectedTo) },
      recorded: entry ? {
        from: normalizeState(entry.from),
        to: normalizeState(entry.to),
        timestamp: entry.timestamp || null,
        gate_result: entry.gate_result || null,
      } : null,
    };
  });
}

function historicalPrologRecords(planDir, gate) {
  const dir = join(planDir, "artifacts", "prolog");
  if (!existsSync(dir)) return { ok: false, records: [], errors: ["artifacts/prolog missing"] };
  const records = [];
  const errors = [];
  for (const name of readdirSync(dir).filter((entry) => entry.startsWith(`${gate}_`) && entry.endsWith(".json")).sort()) {
    const path = join(dir, name);
    const parsed = readJson(path);
    if (!parsed.ok) {
      errors.push(`${name}: ${parsed.error}`);
      continue;
    }
    if (parsed.value?.gate !== gate) {
      errors.push(`${name}: gate is ${parsed.value?.gate || "missing"}`);
      continue;
    }
    records.push({
      artifact: normalizeSlash(relative(planDir, path)),
      result: String(parsed.value?.result || "").toUpperCase(),
      timestamp: parsed.value?.timestamp || null,
      checks: Array.isArray(parsed.value?.checks) ? parsed.value.checks : [],
    });
  }
  return {
    ok: errors.length === 0 && records.some((record) => record.result === "ALLOWED"),
    records,
    errors,
  };
}

function currentPrologChecks({ repoRoot, skillRoot, planDir, statefulGates, gates }) {
  const planName = basename(planDir);
  return withEnvValues({ _PLANNER_PLAN_TARGET: planName }, () => {
    const session = createSession();
    loadStateFacts(session, { cwd: repoRoot, skillPath: skillRoot });
    loadRules(session, { cwd: repoRoot, skillPath: skillRoot });
    return statefulGates.map((gate) => {
      const definition = gates[gate] || {};
      const from = normalizeState(Array.isArray(definition.from) ? definition.from[0] : definition.from);
      const to = normalizeState(definition.to);
      const query = `can_transition(${from}, ${to})`;
      return { gate, from, to, query, ok: session.check(query) };
    });
  });
}

function workflowArtifacts(repoRoot, planDir, stateJson, gates) {
  const workflowId = stateJson?.workflow_id || null;
  if (!workflowId) return { workflow_id: null, contract_profile: null, required: [] };
  const contract = getWorkflowContract(repoRoot, workflowId);
  const required = [];
  for (const gate of ALL_GATES) {
    const phase = gates[gate]?.to || (gate === "notify-user" ? "close" : gate);
    for (const artifact of requiredArtifactsForPhase(contract.profile, phase)) {
      if (!required.some((entry) => entry.artifact === artifact)) {
        required.push({ artifact, exists: existsSync(join(planDir, artifact)), required_by_gate: gate });
      }
    }
  }
  return {
    workflow_id: workflowId,
    contract_profile: contract.contract_profile || null,
    required,
  };
}

function closeSignalChecks(stateJson) {
  const signals = stateJson?.close_signals;
  if (!signals || typeof signals !== "object") {
    return [{ signal: "close_signals", required: true, satisfied: false, status: "missing" }];
  }
  const keys = new Set(CLOSE_SIGNAL_KEYS);
  for (const [key, value] of Object.entries(signals)) {
    if (value && typeof value === "object" && value.required === true) keys.add(key);
  }
  return [...keys].sort().map((key) => {
    const value = signals[key];
    return {
      signal: key,
      required: true,
      satisfied: value?.satisfied === true,
      status: value?.status || null,
    };
  });
}

function resolvePlan(repoRoot, spec) {
  const raw = spec?.plan_dir || spec?.plan || spec;
  const path = isAbsolute(String(raw || "")) ? resolve(String(raw)) : resolve(repoRoot, String(raw || ""));
  return {
    ...((spec && typeof spec === "object") ? spec : {}),
    plan_dir: normalizeSlash(relative(repoRoot, path)),
    path,
    plan: basename(path),
  };
}

export function evaluateCurrentGateInRepository({
  repoRoot,
  skillRoot,
  planDir,
  gate,
  directEvaluator = evaluateGateResults,
} = {}) {
  const root = resolve(repoRoot);
  const targetPlan = resolve(planDir);
  if (root === resolve(process.cwd())) return directEvaluator(targetPlan, gate);

  const verifierUrl = pathToFileURL(join(resolve(skillRoot), "scripts", "verify_gate.mjs")).href;
  const script = [
    `const { evaluateGateResults } = await import(${JSON.stringify(verifierUrl)});`,
    `const result = evaluateGateResults(${JSON.stringify(targetPlan)}, ${JSON.stringify(gate)});`,
    `process.stdout.write(${JSON.stringify(CURRENT_GATE_RESULT_MARKER)} + JSON.stringify(result) + "\\n");`,
  ].join("\n");
  const proc = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CURRENT_GATE_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      PLANNER_SKIP_SELF_HEAL: "1",
      _PLANNER_PLAN_TARGET: basename(targetPlan),
    },
  });
  if (proc.error || proc.status !== 0) {
    const reason = compactErrorDetail(proc.error?.message || proc.stderr || proc.stdout || `exit ${proc.status}`);
    throw new Error(`current gate evaluator failed in replay repository for ${gate}: ${reason}`);
  }
  const stdout = String(proc.stdout || "");
  const markerIndex = stdout.lastIndexOf(CURRENT_GATE_RESULT_MARKER);
  if (markerIndex < 0) throw new Error(`current gate evaluator returned no structured result for ${gate}`);
  const payload = stdout.slice(markerIndex + CURRENT_GATE_RESULT_MARKER.length).split(/\r?\n/, 1)[0];
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`current gate evaluator returned invalid structured result for ${gate}: ${error.message}`);
  }
}

export function replayDogfoodPlan({
  repoRoot,
  skillRoot,
  spec,
  gates,
  requireTracked = true,
  gateEvaluator = null,
} = {}) {
  const resolved = resolvePlan(repoRoot, spec);
  const failures = [];
  const statePath = join(resolved.path, "state.json");
  const beforeStateBytes = existsSync(statePath) ? readFileSync(statePath, "utf-8") : null;
  const stateRead = readJson(statePath);
  if (!stateRead.ok) {
    addFailure(failures, { code: "state_json_invalid", plan: resolved.plan, artifact: "state.json", detail: stateRead.error });
  }
  const stateJson = stateRead.ok ? stateRead.value : {};

  const canonicalArtifacts = CANONICAL_ARTIFACTS.map((artifact) => ({
    artifact,
    exists: existsSync(join(resolved.path, artifact)),
    tracked: requireTracked ? gitTracks(repoRoot, normalizeSlash(join(resolved.plan_dir, artifact))) : null,
  }));
  for (const artifact of canonicalArtifacts) {
    if (!artifact.exists) addFailure(failures, { code: "required_artifact_missing", plan: resolved.plan, artifact: artifact.artifact, detail: "canonical lifecycle artifact is missing" });
    if (requireTracked && artifact.exists && !artifact.tracked) addFailure(failures, { code: "required_artifact_untracked", plan: resolved.plan, artifact: artifact.artifact, detail: "canonical lifecycle artifact is not tracked by git" });
  }

  const chain = successfulTransitionChain(stateJson, gates);
  for (const row of chain) {
    if (!row.ok) addFailure(failures, { code: "recorded_transition_illegal", plan: resolved.plan, gate: row.gate, artifact: "state.json", detail: `expected ${row.expected.from}->${row.expected.to}` });
  }

  const decisionLogPath = join(resolved.path, "artifacts", "decision_log.jsonl");
  const decisionLog = parseJsonLines(decisionLogPath);
  if (!decisionLog.ok) addFailure(failures, { code: "decision_log_invalid", plan: resolved.plan, artifact: "artifacts/decision_log.jsonl", detail: decisionLog.errors.join("; ") });

  const workflow = workflowArtifacts(repoRoot, resolved.path, stateJson, gates);
  for (const row of workflow.required) {
    if (!row.exists) addFailure(failures, { code: "workflow_artifact_missing", plan: resolved.plan, gate: row.required_by_gate, artifact: row.artifact, detail: `${workflow.contract_profile} requires this artifact` });
  }

  let prologChecks = [];
  try {
    prologChecks = currentPrologChecks({ repoRoot, skillRoot, planDir: resolved.path, statefulGates: STATEFUL_GATES, gates });
  } catch (error) {
    addFailure(failures, { code: "prolog_replay_error", plan: resolved.plan, detail: error.message });
  }
  const gateReports = ALL_GATES.map((gate) => {
    const historicalDecisionRecords = decisionLog.records.filter((entry) => entry?.gate === gate);
    const historicalDecisionAllowed = historicalDecisionRecords.some((entry) => String(entry?.decision || "").toUpperCase() === "ALLOWED");
    if (!historicalDecisionAllowed) addFailure(failures, { code: "historical_decision_missing", plan: resolved.plan, gate, artifact: "artifacts/decision_log.jsonl", detail: "no ALLOWED historical decision record" });

    const prolog = historicalPrologRecords(resolved.path, gate);
    if (!prolog.ok) addFailure(failures, { code: "historical_prolog_record_invalid", plan: resolved.plan, gate, artifact: "artifacts/prolog", detail: [...prolog.errors, "no ALLOWED record"].join("; ") });

    let currentResults = [];
    let evaluationPlanDir = resolved.path;
    let inputSource = "final_plan";
    let inputSnapshot = null;
    let inputSnapshotInvalid = false;
    if (gate === "plan-to-execute") {
      inputSnapshot = resolveGateInputSnapshot({ planDir: resolved.path, gate });
      if (inputSnapshot.status === "valid" && requireTracked) {
        const untracked = inputSnapshot.artifact_paths
          .map((path) => normalizeSlash(relative(repoRoot, path)))
          .filter((path) => !gitTracks(repoRoot, path));
        if (untracked.length > 0) {
          inputSnapshot = {
            ...inputSnapshot,
            status: "invalid",
            errors: [`snapshot provenance artifact(s) are not tracked by git: ${untracked.join(", ")}`],
          };
        }
      }
      if (inputSnapshot.status === "valid") {
        evaluationPlanDir = inputSnapshot.path;
        inputSource = "gate_time_snapshot";
      } else if (inputSnapshot.status === "absent") {
        inputSource = "final_plan_legacy_fallback";
      } else {
        inputSource = "invalid_gate_time_snapshot";
        inputSnapshotInvalid = true;
        evaluationPlanDir = null;
        const detail = (inputSnapshot.errors || []).join("; ") || "gate-time snapshot validation failed";
        addFailure(failures, {
          code: "gate_input_snapshot_invalid",
          plan: resolved.plan,
          gate,
          artifact: normalizeSlash(relative(resolved.path, inputSnapshot.pointer_path || resolved.path)),
          detail,
        });
        currentResults = [{
          status: "FAIL",
          code: "GATE-REPLAY-INPUT",
          name: "Verified gate-time replay input",
          detail,
        }];
      }
    }
    if (!inputSnapshotInvalid) {
      try {
        const evaluation = typeof gateEvaluator === "function"
          ? gateEvaluator(evaluationPlanDir, gate, {
            input_source: inputSource,
            canonical_plan_dir: resolved.path,
            snapshot: inputSnapshot,
          })
          : evaluateCurrentGateInRepository({ repoRoot, skillRoot, planDir: evaluationPlanDir, gate });
        currentResults = evaluation?.results || [];
      } catch (error) {
        addFailure(failures, { code: "current_gate_evaluator_error", plan: resolved.plan, gate, detail: error.message });
      }
    }
    const rawCurrentFailures = currentResults.filter((entry) => {
      const status = normalizeVerificationStatus(entry?.status, "gate");
      return !status.valid || status.token === "UNKNOWN" || status.kind === "fail";
    });
    const currentAdvisories = currentResults.filter((entry) => {
      const status = normalizeVerificationStatus(entry?.status, "gate");
      return status.kind === "pending" && status.token !== "UNKNOWN";
    });
    const historicalOnlyFailures = rawCurrentFailures.filter((entry) =>
      HISTORICAL_ONLY_CURRENT_CHECK_CODES.has(String(entry?.code || ""))
      && historicalDecisionAllowed
      && prolog.ok
    );
    const currentFailures = rawCurrentFailures.filter((entry) => !historicalOnlyFailures.includes(entry));
    for (const entry of inputSnapshotInvalid ? [] : currentFailures) {
      addFailure(failures, {
        code: "current_gate_contract_rejected",
        plan: resolved.plan,
        gate,
        detail: `${entry.code || "uncoded"}: ${entry.name || "current check failed"}${entry.detail ? ` - ${entry.detail}` : ""}`,
      });
    }
    const currentProlog = prologChecks.find((entry) => entry.gate === gate) || null;
    const prologHistoricalOnly = gate !== "notify-user"
      && currentProlog?.ok !== true
      && historicalOnlyFailures.length > 0
      && currentFailures.length === 0;
    if (gate !== "notify-user" && currentProlog?.ok !== true && !prologHistoricalOnly) {
      addFailure(failures, {
        code: "current_prolog_transition_rejected",
        plan: resolved.plan,
        gate,
        detail: `${currentProlog?.from || "unknown"}->${currentProlog?.to || "unknown"} rejected by current transitions.pl`,
      });
    }
    return {
      gate,
      historical_evidence: {
        decision_log: historicalDecisionAllowed ? "ALLOWED" : "MISSING",
        decision_record_count: historicalDecisionRecords.length,
        prolog_record: prolog.ok ? "ALLOWED" : "INVALID",
        prolog_record_count: prolog.records.length,
      },
      current_code: {
        js_contract: currentFailures.length > 0
          ? "FAIL"
          : historicalOnlyFailures.length > 0
            ? "HISTORICAL_ONLY"
            : "PASS",
        check_count: currentResults.length,
        failed_checks: currentFailures.map((entry) => ({ code: entry.code || null, name: entry.name || null, detail: entry.detail || null })),
        historical_only_checks: historicalOnlyFailures.map((entry) => ({ code: entry.code || null, name: entry.name || null, detail: entry.detail || null })),
        advisory_checks: currentAdvisories.map((entry) => ({
          code: entry.code || null,
          name: entry.name || null,
          detail: entry.detail || null,
          advisory_conversion: entry.advisory_conversion === true,
        })),
        input_source: inputSource,
        input_plan_dir: evaluationPlanDir ? normalizeSlash(relative(repoRoot, evaluationPlanDir)) : null,
        input_snapshot_status: inputSnapshot?.status || null,
        prolog_transition: currentProlog?.ok === true
          ? "PASS"
          : prologHistoricalOnly
            ? "HISTORICAL_ONLY"
          : gate === "notify-user"
            ? "AUDIT_ONLY"
            : "FAIL",
      },
    };
  });

  const closeSignals = closeSignalChecks(stateJson);
  if (String(stateJson?.state || "").toUpperCase() !== "CLOSE") {
    addFailure(failures, { code: "plan_not_closed", plan: resolved.plan, gate: "validate-to-close", artifact: "state.json", detail: `state is ${stateJson?.state || "missing"}` });
  }
  for (const signal of closeSignals) {
    if (!signal.satisfied) addFailure(failures, { code: "close_signal_unsatisfied", plan: resolved.plan, gate: "validate-to-close", artifact: "state.json", detail: `${signal.signal} is not satisfied` });
  }

  const afterStateBytes = existsSync(statePath) ? readFileSync(statePath, "utf-8") : null;
  const stateBytesUnchanged = beforeStateBytes === afterStateBytes;
  if (!stateBytesUnchanged) addFailure(failures, { code: "state_json_mutated", plan: resolved.plan, artifact: "state.json", detail: "replay changed canonical state bytes" });

  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? "PASS" : "FAIL",
    plan: resolved.plan,
    plan_dir: resolved.plan_dir,
    shape: resolved.shape || "explicit_plan",
    evidence_ref: resolved.evidence_ref || null,
    tracked_plan: requireTracked ? gitTracks(repoRoot, normalizeSlash(resolved.plan_dir)) : null,
    lifecycle_state: stateJson?.state || null,
    state_json_bytes_unchanged: stateBytesUnchanged,
    recorded_transition_chain: chain,
    canonical_artifacts: canonicalArtifacts,
    workflow_contract: workflow,
    close_signals: closeSignals,
    gates: gateReports,
    failures,
  };
}

export function replayDogfoodLifecycleCorpus({
  repoRoot = process.cwd(),
  skillRoot = join(repoRoot, ".agent", "skills", "iterative-planner"),
  planSpecs = DEFAULT_DOGFOOD_PLAN_SPECS,
  requireTracked = true,
  gateEvaluator = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const root = resolve(repoRoot);
  const registry = gateRegistry(root);
  if (!registry.ok) {
    return {
      schema_version: DOGFOOD_LIFECYCLE_REPLAY_SCHEMA_VERSION,
      replay_id: "tier2_committed_dogfood_lifecycle_replay",
      generated_at: generatedAt,
      ok: false,
      status: "FAIL",
      failures: [{ code: "gate_registry_invalid", plan: null, gate: null, artifact: normalizeSlash(relative(root, registry.path)), detail: registry.error }],
      plans: [],
    };
  }
  const plans = planSpecs.map((spec) => replayDogfoodPlan({
    repoRoot: root,
    skillRoot: resolve(skillRoot),
    spec,
    gates: registry.gates,
    requireTracked,
    gateEvaluator,
  }));
  const failures = plans.flatMap((plan) => plan.failures);
  const ok = plans.length >= 3 && plans.length <= 5 && failures.length === 0;
  if (plans.length < 3 || plans.length > 5) {
    failures.push({ code: "corpus_size_out_of_contract", plan: null, gate: null, artifact: null, detail: `expected 3-5 plans, received ${plans.length}` });
  }
  return {
    schema_version: DOGFOOD_LIFECYCLE_REPLAY_SCHEMA_VERSION,
    replay_id: "tier2_committed_dogfood_lifecycle_replay",
    generated_at: generatedAt,
    ok,
    status: ok ? "PASS" : "FAIL",
    claim_boundary: {
      proves: "Recorded committed dogfood journeys remain valid under current gate and Prolog contracts.",
      does_not_prove: ["live lifecycle execution", "autonomous coding behavior"],
      tier_1_boundary: "Live deterministic lifecycle execution remains the lifecycle-journey-proof suite.",
      tier_3_boundary: "Autonomous coding concept proof remains out of scope for Tier 2.",
    },
    corpus: {
      minimum_plans: 3,
      maximum_plans: 5,
      plan_count: plans.length,
      shapes: plans.map((plan) => plan.shape),
      all_plans_tracked: requireTracked ? plans.every((plan) => plan.tracked_plan === true) : null,
    },
    current_code_contract: {
      js_gate_evaluator: ".agent/skills/iterative-planner/scripts/verify_gate.mjs#evaluateGateResults",
      prolog_rules: ".agent/skills/iterative-planner/prolog/transitions.pl",
      gate_registry: ".agent/skills/iterative-planner/config/gates.json",
    },
    evidence_semantics: {
      historical: "state.json transitions plus committed decision-log and Prolog gate records prove what ran.",
      current: "Current JS gate evaluation uses a verified gate-time plan-to-execute snapshot when present, otherwise a visible legacy final-plan fallback; current Prolog queries prove replayable transition compatibility, and time-bound environmental attestations require historical ALLOWED receipts and are reported as HISTORICAL_ONLY.",
      read_only: "Replay compares state.json bytes before and after and never calls transition.mjs.",
    },
    plans,
    failures,
  };
}

export function renderDogfoodLifecycleReplayText(report) {
  const lines = [
    `Committed dogfood lifecycle replay: ${report.status}`,
    `Plans: ${report.corpus?.plan_count ?? report.plans?.length ?? 0}`,
    `Claim: ${report.claim_boundary?.proves || "recorded journey compatibility"}`,
  ];
  for (const plan of report.plans || []) lines.push(`- ${plan.plan} [${plan.shape}]: ${plan.status}`);
  for (const failure of report.failures || []) {
    lines.push(`FAIL ${failure.plan || "corpus"}${failure.gate ? `/${failure.gate}` : ""}: ${failure.code} - ${failure.detail}`);
  }
  return lines.join("\n");
}
