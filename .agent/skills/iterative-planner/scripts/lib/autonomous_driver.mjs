import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { getPaths, resolvePlanTarget } from "./plan_utils.mjs";
import { readStateJson } from "./determinism.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const EXECUTED_TEST_GATES_FILE = "executed_test_gates.json";
export const TEST_GATED_TRANSITIONS = new Set(["execute-to-reflect", "validate-to-close"]);

const STATE_TO_GATE = new Map([
  ["explore", "explore-to-plan"],
  ["plan", "plan-to-execute"],
  ["execute", "execute-to-reflect"],
  ["reflect", "reflect-to-validate"],
  ["validate", "validate-to-close"],
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeState(value) {
  return String(value || "").trim().toLowerCase();
}

function excerpt(value, max = 6000) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function displayCommand(args) {
  return args.map((part) => /\s/.test(String(part)) ? JSON.stringify(String(part)) : String(part)).join(" ");
}

export function executedTestGatesPath(planDir) {
  return join(planDir, EXECUTED_TEST_GATES_FILE);
}

export function readExecutedTestGates(planDir) {
  const parsed = readJson(executedTestGatesPath(planDir), null);
  if (parsed && typeof parsed === "object") return parsed;
  return { schema_version: 1, gates: {} };
}

export function writeExecutedTestGateEvidence(planDir, gateEvidence) {
  const existing = readExecutedTestGates(planDir);
  const next = {
    schema_version: 1,
    updated_at: nowIso(),
    gates: {
      ...(existing.gates || {}),
      [gateEvidence.gate]: gateEvidence,
    },
  };
  writeFileSync(executedTestGatesPath(planDir), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function resolveDriverPlan({ cwd = process.cwd(), plan = null } = {}) {
  const { plansDir } = getPaths(cwd);
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false, plan });
  if (!target?.planDirName || !target?.planDir) {
    return {
      ok: false,
      reason: plan
        ? `Plan not found: ${plan}`
        : "No active plan found. Create one with bootstrap.mjs first or pass --plan.",
    };
  }
  return { ok: true, ...target };
}

export function resolveExecutedTestEvidenceSignal(planDir, gate, currentGateEvidence = null) {
  const evidence = readExecutedTestGates(planDir);
  const gateEvidence = currentGateEvidence?.gate === gate
    ? currentGateEvidence
    : evidence?.gates?.[gate] || null;
  if (!gateEvidence) {
    return {
      present: false,
      required: false,
      satisfied: true,
      detail: `No executed test gate evidence recorded for ${gate}`,
      gate_evidence: null,
    };
  }
  const evidenceStatus = normalizeVerificationStatus(gateEvidence.status, "execution");
  if (evidenceStatus.valid && evidenceStatus.token !== "unknown" && evidenceStatus.kind === "pending" && gateEvidence.required !== true && gateEvidence.blocking !== true) {
    return {
      present: false,
      required: false,
      satisfied: true,
      detail: `Executed test gate skipped for ${gate}: ${gateEvidence.detail || "advisory skip"}`,
      gate_evidence: gateEvidence,
    };
  }
  const satisfied = verificationStatusIsPass(gateEvidence.status, "execution") && gateEvidence.exit_code === 0;
  return {
    present: true,
    required: gateEvidence.required === true,
    satisfied,
    detail: satisfied
      ? `Executed test gate passed for ${gate}: exit code 0 from test_baseline.mjs verify`
      : `Executed test gate blocked ${gate}: exit code ${gateEvidence.exit_code ?? "n/a"} from test_baseline.mjs verify`,
    gate_evidence: gateEvidence,
  };
}

export function runExecutedTestGate({
  cwd = process.cwd(),
  skillPath,
  planDir,
  planDirName,
  gate,
  autonomous = false,
  timeoutMs = 600000,
  persistEvidence = true,
} = {}) {
  if (!TEST_GATED_TRANSITIONS.has(gate)) {
    return {
      gate,
      status: "skipped",
      required: false,
      blocking: false,
      detail: `${gate} is not a test-gated transition`,
    };
  }

  const baselinePath = join(planDir, "baseline.json");
  const verifyArgs = [join(skillPath, "scripts", "test_baseline.mjs"), "verify", "--plan", planDirName];
  const commandArgv = [process.execPath, ...verifyArgs];
  const command = displayCommand(commandArgv);
  const startedAt = nowIso();

  if (!existsSync(baselinePath)) {
    const evidence = {
      gate,
      status: autonomous ? "blocked" : "skipped",
      required: !!autonomous,
      blocking: !!autonomous,
      command,
      command_argv: commandArgv,
      exit_code: null,
      started_at: startedAt,
      finished_at: nowIso(),
      stdout: "",
      stderr: "baseline.json missing",
      detail: autonomous
        ? "baseline.json missing; autonomous driver requires executed test proof"
        : "baseline.json missing; manual transition records advisory skip",
    };
    if (persistEvidence) writeExecutedTestGateEvidence(planDir, evidence);
    return evidence;
  }

  const proc = spawnSync(commandArgv[0], commandArgv.slice(1), {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    env: {
      ...process.env,
      _PLANNER_PLAN_TARGET: planDirName,
    },
  });
  const exitCode = proc.error ? 1 : (proc.status ?? 1);
  const status = exitCode === 0 ? "passed" : "blocked";
  const passed = verificationStatusIsPass(status, "execution");
  const evidence = {
    gate,
    status,
    required: true,
    blocking: !passed,
    command,
    command_argv: commandArgv,
    timeout_ms: timeoutMs,
    exit_code: exitCode,
    timed_out: !!proc.error && proc.error.code === "ETIMEDOUT",
    started_at: startedAt,
    finished_at: nowIso(),
    stdout: excerpt(proc.stdout || ""),
    stderr: excerpt(proc.stderr || proc.error?.message || ""),
    detail: passed
      ? "test_baseline.mjs verify exited 0"
      : `test_baseline.mjs verify exited ${exitCode}`,
  };
  if (persistEvidence) writeExecutedTestGateEvidence(planDir, evidence);
  return evidence;
}

export function nextGateForState(state) {
  return STATE_TO_GATE.get(normalizeState(state)) || null;
}

export function runAutonomousDriver({
  cwd = process.cwd(),
  skillPath,
  until = "close",
  plan = null,
  maxTransitions = 8,
  transitionRunner = null,
} = {}) {
  const normalizedUntil = normalizeState(until);
  if (normalizedUntil !== "close") {
    return {
      ok: false,
      exit_code: 2,
      status: "unsupported_target",
      reason: `Unsupported --until target "${until}". Supported target: close.`,
      transitions: [],
    };
  }

  const resolved = resolveDriverPlan({ cwd, plan });
  if (!resolved.ok) {
    return { ok: false, exit_code: 1, status: "no_plan", reason: resolved.reason, transitions: [] };
  }

  const actualSkillPath = skillPath || join(process.cwd(), ".agent", "skills", "iterative-planner");
  const transitionScript = join(actualSkillPath, "scripts", "transition.mjs");
  const transitions = [];

  for (let index = 0; index < maxTransitions; index++) {
    const beforeState = normalizeState(readStateJson(resolved.planDir)?.state);
    if (beforeState === normalizedUntil) {
      return {
        ok: true,
        exit_code: 0,
        status: "reached_target",
        plan: resolved.planDirName,
        final_state: beforeState,
        transitions,
      };
    }

    const gate = nextGateForState(beforeState);
    if (!gate) {
      return {
        ok: false,
        exit_code: 1,
        status: "blocked",
        reason: `No legal transition from state ${beforeState || "unknown"} toward ${normalizedUntil}`,
        blocked_gate: null,
        final_state: beforeState,
        transitions,
      };
    }

    const startedAt = nowIso();
    const run = transitionRunner || ((transitionGate) => spawnSync(process.execPath, [transitionScript, transitionGate, "--plan", resolved.planDirName], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        _PLANNER_PLAN_TARGET: resolved.planDirName,
        PLANNER_AUTONOMOUS_DRIVER: "1",
      },
      timeout: 600000,
    }));
    const proc = run(gate, { cwd, planDirName: resolved.planDirName, planDir: resolved.planDir });
    const exitCode = proc.error ? 1 : (proc.status ?? 1);
    const afterState = normalizeState(readStateJson(resolved.planDir)?.state);
    const record = {
      gate,
      from_state: beforeState,
      to_state: afterState,
      exit_code: exitCode,
      status: exitCode === 0 ? "passed" : "blocked",
      started_at: startedAt,
      finished_at: nowIso(),
      stdout: excerpt(proc.stdout || ""),
      stderr: excerpt(proc.stderr || proc.error?.message || ""),
    };
    transitions.push(record);

    if (exitCode !== 0) {
      return {
        ok: false,
        exit_code: exitCode,
        status: "blocked",
        reason: `Transition ${gate} blocked`,
        blocked_gate: gate,
        final_state: afterState,
        transitions,
      };
    }
  }

  return {
    ok: false,
    exit_code: 1,
    status: "max_transitions_exceeded",
    reason: `Stopped after ${maxTransitions} transition(s) without reaching ${normalizedUntil}`,
    plan: resolved.planDirName,
    final_state: normalizeState(readStateJson(resolved.planDir)?.state),
    transitions,
  };
}
