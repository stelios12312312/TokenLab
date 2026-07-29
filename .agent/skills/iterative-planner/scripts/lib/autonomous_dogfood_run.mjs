// autonomous_dogfood_run.mjs - independently countersigned L3 headless-agent run.
// @planner:module = autonomous_dogfood_run
// @planner:capability = l3_headless_agent_seeded_defect_countersign

import { spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve } from "path";
import { replayDogfoodPlan } from "./dogfood_lifecycle_replay.mjs";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const AUTONOMOUS_DOGFOOD_RECEIPT_SCHEMA = "ive.autonomous_dogfood_run.v1";
export const AUTONOMOUS_DOGFOOD_FRESHNESS_SCHEMA = "ive.autonomous_dogfood_freshness.v1";
export const DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE = "canonical-js-clamp-v1";
export const DEFAULT_AUTONOMOUS_DOGFOOD_RECEIPT_ROOT = "reports/ive/autonomous_dogfood_runs";
export const DEFAULT_AUTONOMOUS_DOGFOOD_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_AUTONOMOUS_DOGFOOD_MAX_AGE_HOURS = 192;

const STATEFUL_GATES = Object.freeze([
  "explore-to-plan",
  "plan-to-execute",
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
]);
const ALL_GATES = Object.freeze([...STATEFUL_GATES, "notify-user"]);
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const AGENT_IDE_ENV_PREFIXES = Object.freeze(["CLAUDE_CODE_", "CODEX_", "CURSOR_", "ANTIGRAVITY_"]);
const AGENT_IDE_ENV_KEYS = Object.freeze([
  "_PLANNER_PLAN_TARGET",
  "_PLANNER_THREAD_ID",
  "_PLANNER_GATE_TRANSITION",
  "VSCODE_PID",
  "TERM_PROGRAM",
]);
const PRESERVED_AGENT_AUTH_KEYS = Object.freeze(["CODEX_API_KEY", "CODEX_HOME"]);

export const AUTONOMOUS_DOGFOOD_CLAIM_BOUNDARY = Object.freeze({
  demonstrates: "One passing run demonstrates the autonomous-coding loop end to end for this fixture in this harness.",
  does_not_prove: Object.freeze([
    "general autonomous coding capability",
    "L4 domain work",
    "quant or live-system validity",
    "vendor superiority",
  ]),
});

const FIXTURE_SPECS = Object.freeze({
  [DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE]: Object.freeze({
    id: DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE,
    version: 1,
    source_path: "src/clamp.mjs",
    test_path: "tests/clamp.test.mjs",
    test_command: Object.freeze([process.execPath, "--test", "tests/clamp.test.mjs"]),
    files: Object.freeze({
      ".gitignore": [
        ".agent",
        "node_modules/",
        "plans/.current_plan*",
        "plans/ACTIVE_PLAN.*",
        "plans/.thread_targets/",
        "plans/.audit-archive/",
        "",
      ].join("\n"),
      "package.json": `${JSON.stringify({
        name: "l3-autonomous-dogfood-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test tests/clamp.test.mjs" },
      }, null, 2)}\n`,
      "audit.config.json": `${JSON.stringify({
        roles: ["core"],
        fail_on: ["HIGH", "CRITICAL"],
        suppressed_domain_profiles: ["quant", "quant_betting"],
      }, null, 2)}\n`,
      "src/clamp.mjs": [
        "export function clamp(value, minimum, maximum) {",
        "  return Math.min(minimum, Math.max(maximum, value));",
        "}",
        "",
      ].join("\n"),
      "tests/clamp.test.mjs": [
        "import test from \"node:test\";",
        "import assert from \"node:assert/strict\";",
        "import { clamp } from \"../src/clamp.mjs\";",
        "",
        "test(\"clamp preserves in-range values and enforces both bounds\", () => {",
        "  assert.equal(clamp(5, 0, 10), 5);",
        "  assert.equal(clamp(-2, 0, 10), 0);",
        "  assert.equal(clamp(12, 0, 10), 10);",
        "});",
        "",
      ].join("\n"),
      "reports/user_story_audit/story_registry.json": `${JSON.stringify({
        version: 1,
        updated: "2026-07-10T00:00:00.000Z",
        stories: [{
          id: "US-001",
          title: "Repair the seeded clamp behavior through a safe planner lifecycle",
          priority: "HIGH",
          status: "PARTIALLY_COVERED",
          code_refs: ["src/clamp.mjs"],
          test_refs: ["tests/clamp.test.mjs"],
          validation_refs: ["tests/clamp.test.mjs"],
          doc_refs: [".agent/workflows/safe-change.md"],
          acceptance_criteria: [{
            id: "AC-US-001-001",
            description: "The clamp function preserves in-range values and enforces both bounds.",
          }],
          tags: ["bug_fix", "behavioral_test"],
        }],
        consolidations: [],
      }, null, 2)}\n`,
    }),
  }),
});

function normalizeSlash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function excerpt(value, max = 1200) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max)}...[truncated]`;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function isoNow(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return date.toISOString();
}

function processResult(proc) {
  const stdout = String(proc?.stdout || "");
  const stderr = String(proc?.stderr || proc?.error?.message || "");
  const timedOut = proc?.error?.code === "ETIMEDOUT" || proc?.signal === "SIGTERM";
  return {
    exit_code: timedOut ? 124 : (typeof proc?.status === "number" ? proc.status : proc?.error ? 1 : 0),
    timed_out: timedOut,
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_excerpt: excerpt(stdout),
    stderr_excerpt: excerpt(stderr),
  };
}

function runGit(args, cwd, { check = true } = {}) {
  const proc = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_OUTPUT_BYTES,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "IVE L3 Harness",
      GIT_AUTHOR_EMAIL: "ive-l3@example.invalid",
      GIT_COMMITTER_NAME: "IVE L3 Harness",
      GIT_COMMITTER_EMAIL: "ive-l3@example.invalid",
    },
  });
  if (check && proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr || proc.stdout}`);
  }
  return proc;
}

function writeFixtureFiles(workspace, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(workspace, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export function getAutonomousDogfoodFixtureSpec(id = DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE) {
  const spec = FIXTURE_SPECS[id];
  if (!spec) throw new Error(`Unknown autonomous dogfood fixture: ${id}`);
  return spec;
}

export function buildAutonomousDogfoodFixture({
  repoRoot = process.cwd(),
  fixtureId = DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE,
  workspaceParent = tmpdir(),
} = {}) {
  const spec = getAutonomousDogfoodFixtureSpec(fixtureId);
  mkdirSync(workspaceParent, { recursive: true });
  const workspace = mkdtempSync(join(resolve(workspaceParent), "ive-l3-dogfood-"));
  writeFixtureFiles(workspace, spec.files);

  const sourceAgent = join(resolve(repoRoot), ".agent");
  if (!existsSync(sourceAgent)) throw new Error(`Planner runtime missing: ${sourceAgent}`);
  cpSync(sourceAgent, join(workspace, ".agent"), { recursive: true });

  runGit(["init", "--quiet"], workspace);
  runGit(["config", "user.email", "ive-l3@example.invalid"], workspace);
  runGit(["config", "user.name", "IVE L3 Harness"], workspace);
  runGit(["add", "."], workspace);
  runGit(["commit", "--quiet", "-m", "seed canonical L3 defect"], workspace);
  const seedCommit = runGit(["rev-parse", "HEAD"], workspace).stdout.trim();

  return {
    workspace,
    spec,
    seed_commit: seedCommit,
    harness_skill_root: join(sourceAgent, "skills", "iterative-planner"),
    source_hash: hashFile(join(workspace, spec.source_path)),
    test_hash: hashFile(join(workspace, spec.test_path)),
  };
}

function runCommand(command, cwd, { timeoutMs = DEFAULT_AUTONOMOUS_DOGFOOD_TIMEOUT_MS, env = process.env } = {}) {
  const proc = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return processResult(proc);
}

export function isolatedAgentEnvironment(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  const preserved = Object.fromEntries(PRESERVED_AGENT_AUTH_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(env, key))
    .map((key) => [key, env[key]]));
  for (const key of Object.keys(env)) {
    if (AGENT_IDE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = "";
  }
  for (const key of AGENT_IDE_ENV_KEYS) env[key] = "";
  Object.assign(env, preserved);
  env.PLANNER_SKIP_SELF_HEAL = env.PLANNER_SKIP_SELF_HEAL || "1";
  return env;
}

export function buildAutonomousDogfoodPrompt(spec = getAutonomousDogfoodFixtureSpec()) {
  return [
    "/safe-change",
    "",
    "Work autonomously in this repository. Discover and repair the seeded behavioral defect.",
    "Use the FULL iterative planner flow with a real plan: read .agent/rules.md and .agent/workflows/safe-change.md, create the plan with bootstrap.mjs new --force, and author substantive EXPLORE and PLAN artifacts.",
    "Run this FULL required transition command sequence in order, including the audit-only sixth gate after the plan reaches CLOSE:",
    "node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan",
    "node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute",
    "node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect",
    "node .agent/skills/iterative-planner/scripts/transition.mjs reflect-to-validate",
    "node .agent/skills/iterative-planner/scripts/transition.mjs validate-to-close",
    "node .agent/skills/iterative-planner/scripts/transition.mjs notify-user",
    "A CLOSE state is not the end of this task: notify-user must also produce its historical ALLOWED decision and Prolog audit receipt.",
    "Reference fixture story US-001 from the plan verification artifacts. Run the behavioral test before and after the repair.",
    `Immutable inputs — do not edit, delete, rewrite, or regenerate any of these: audit.config.json; .gitignore; reports/user_story_audit/story_registry.json (the seeded story registry); ${spec.test_path} and every file under tests/; every shared knowledge file under plans/knowledge/ (including index.md, mistakes.md, patterns.md, gotchas.md, and retros/retro_ledger.json when present).`,
    `The intended implementation surface is ${spec.source_path}. Record a no-new-knowledge signoff inside the child plan for this disposable fixture without changing shared knowledge files.`,
    "Do not create files outside the intended source path and planner-owned plans/ or reports/ive/ proof surfaces.",
    "Do not ask for human input. Do not merely report success: finish the fix, tests, evidence, and planner closure.",
    "",
  ].join("\n");
}

export function invokeConfiguredAgent({
  command,
  cwd,
  prompt,
  timeoutMs = DEFAULT_AUTONOMOUS_DOGFOOD_TIMEOUT_MS,
  env = isolatedAgentEnvironment(),
} = {}) {
  if (!String(command || "").trim()) throw new Error("agent command is required");
  const proc = spawnSync("/bin/sh", ["-lc", String(command)], {
    cwd,
    env,
    input: prompt,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return processResult(proc);
}

function parseStatusPaths(output) {
  return String(output || "")
    .split("\0")
    .filter(Boolean)
    .map((entry) => normalizeSlash(entry.slice(3)))
    .filter(Boolean);
}

function gitEvidence(workspace, seedCommit, spec) {
  const statusProc = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace);
  const statusPaths = parseStatusPaths(statusProc.stdout);
  const diffPaths = runGit(["diff", "--name-only", seedCommit, "--"], workspace).stdout
    .split(/\r?\n/)
    .map(normalizeSlash)
    .filter(Boolean);
  const changedPaths = [...new Set([...diffPaths, ...statusPaths])].sort();
  const expected = (path) => path === spec.source_path || path.startsWith("plans/") || path.startsWith("reports/");
  const unexpectedPaths = changedPaths.filter((path) => !expected(path));
  const diffStat = runGit(["diff", "--stat", seedCommit, "--"], workspace).stdout.trim();
  return {
    seed_commit: seedCommit,
    final_head: runGit(["rev-parse", "HEAD"], workspace).stdout.trim(),
    changed_paths: changedPaths,
    status_paths: statusPaths,
    unexpected_paths: unexpectedPaths,
    worktree_clean_of_stray_files: unexpectedPaths.length === 0,
    diff_stat: diffStat,
  };
}

function discoverPlan(workspace) {
  const plansDir = join(workspace, "plans");
  const pointer = join(plansDir, ".current_plan");
  if (existsSync(pointer)) {
    const plan = readFileSync(pointer, "utf-8").trim();
    if (plan && existsSync(join(plansDir, plan))) return { plan, plan_dir: join(plansDir, plan) };
  }
  if (!existsSync(plansDir)) return null;
  const plans = readdirSync(plansDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
    .map((entry) => entry.name)
    .sort();
  const plan = plans.at(-1) || null;
  return plan ? { plan, plan_dir: join(plansDir, plan) } : null;
}

function loadGateRegistry(skillRoot) {
  const path = join(skillRoot, "config", "gates.json");
  const parsed = readJson(path);
  if (!parsed?.gates) throw new Error(`Gate registry is invalid: ${path}`);
  return parsed.gates;
}

export function evaluateAutonomousPlannerLifecycle({ workspace, plan, fixture } = {}) {
  if (!plan?.plan_dir) {
    return {
      ok: false,
      status: "FAIL",
      lifecycle_state: null,
      recorded_transition_chain: [],
      gates: [],
      close_signals: [],
      failures: [{ code: "plan_missing", plan: null, gate: null, detail: "agent did not create a planner plan" }],
    };
  }
  try {
    const skillRoot = fixture?.harness_skill_root || join(workspace, ".agent", "skills", "iterative-planner");
    return replayDogfoodPlan({
      repoRoot: workspace,
      skillRoot,
      spec: { plan_dir: normalizeSlash(relative(workspace, plan.plan_dir)), shape: "l3_headless_agent_run" },
      gates: loadGateRegistry(skillRoot),
      requireTracked: false,
    });
  } catch (error) {
    return {
      ok: false,
      status: "FAIL",
      lifecycle_state: null,
      recorded_transition_chain: [],
      gates: [],
      close_signals: [],
      failures: [{ code: "lifecycle_replay_error", plan: plan.plan, gate: null, detail: error.message }],
    };
  }
}

function addFailure(failures, code, detail, meta = {}) {
  failures.push({ code, detail, ...meta });
}

export function evaluateAutonomousDogfoodOutcome({
  baseline,
  agent,
  finalTest,
  fixture,
  finalTestHash,
  finalSourceHash,
  git,
  plan,
  lifecycle,
} = {}) {
  const failures = [];
  if (baseline?.exit_code === 0) addFailure(failures, "fixture_not_red", "seeded behavioral test passed before agent invocation");
  if (agent?.invocation_count !== 1) addFailure(failures, "agent_invocation_count", `expected one invocation, received ${agent?.invocation_count ?? 0}`);
  if (agent?.exit_code !== 0) addFailure(failures, "agent_command_failed", `agent command exited ${agent?.exit_code ?? "unknown"}`);
  if (finalTest?.exit_code !== 0) addFailure(failures, "final_test_not_green", `final behavioral suite exited ${finalTest?.exit_code ?? "unknown"}`);
  if (!fixture?.test_hash || finalTestHash !== fixture.test_hash) addFailure(failures, "seeded_test_changed", "seeded behavioral test bytes changed");
  if (!fixture?.source_hash || finalSourceHash === fixture.source_hash) addFailure(failures, "intended_source_unchanged", "intended source bytes did not change");
  for (const path of git?.unexpected_paths || []) addFailure(failures, "unexpected_worktree_path", path, { path });
  if (!plan?.plan_dir) addFailure(failures, "plan_missing", "agent did not create a planner plan");
  if (String(lifecycle?.lifecycle_state || "").toUpperCase() !== "CLOSE") {
    addFailure(failures, "plan_not_closed", `planner state is ${lifecycle?.lifecycle_state || "missing"}`);
  }
  if (lifecycle?.ok !== true) {
    addFailure(failures, "lifecycle_replay_failed", `${lifecycle?.failures?.length || 0} lifecycle replay failure(s)`);
  }
  for (const failure of lifecycle?.failures || []) {
    failures.push({
      code: failure.code || "lifecycle_failure",
      detail: failure.detail || "planner lifecycle evidence failed",
      gate: failure.gate || null,
      artifact: failure.artifact || null,
    });
  }
  return { ok: failures.length === 0, status: failures.length === 0 ? "PASS" : "FAIL", failures };
}

function receiptRunId(timestamp) {
  return `l3-${timestamp.replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function writeAutonomousDogfoodReceipt(receipt, {
  repoRoot = process.cwd(),
  receiptRoot = DEFAULT_AUTONOMOUS_DOGFOOD_RECEIPT_ROOT,
} = {}) {
  const root = resolve(repoRoot, receiptRoot);
  const date = String(receipt.started_at || receipt.finished_at).slice(0, 10);
  const dir = join(root, date);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${receipt.run_id}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

export function runAutonomousDogfood({
  repoRoot = process.cwd(),
  agentCommand,
  fixtureId = DEFAULT_AUTONOMOUS_DOGFOOD_FIXTURE,
  receiptRoot = DEFAULT_AUTONOMOUS_DOGFOOD_RECEIPT_ROOT,
  workspaceParent = tmpdir(),
  timeoutMs = DEFAULT_AUTONOMOUS_DOGFOOD_TIMEOUT_MS,
  keepWorkspace = false,
  agentInvoker = invokeConfiguredAgent,
  lifecycleEvaluator = evaluateAutonomousPlannerLifecycle,
  now = () => new Date(),
  runId = null,
} = {}) {
  if (!String(agentCommand || "").trim()) throw new Error("run requires an explicit agent command");
  const startedAt = isoNow(now);
  const startedMs = Date.parse(startedAt);
  const resolvedRunId = runId || receiptRunId(startedAt);
  const commandFingerprint = sha256(String(agentCommand));
  let fixture = null;
  let baseline = null;
  let agentResult = { exit_code: null, timed_out: false, stdout_bytes: 0, stderr_bytes: 0, stdout_sha256: sha256(""), stderr_sha256: sha256("") };
  let invocationCount = 0;
  let finalTest = null;
  let finalTestHash = null;
  let finalSourceHash = null;
  let git = { changed_paths: [], status_paths: [], unexpected_paths: [], worktree_clean_of_stray_files: false, diff_stat: "" };
  let plan = null;
  let lifecycle = { ok: false, status: "FAIL", lifecycle_state: null, recorded_transition_chain: [], gates: [], close_signals: [], failures: [] };
  let outcome = null;

  try {
    fixture = buildAutonomousDogfoodFixture({ repoRoot, fixtureId, workspaceParent });
    baseline = runCommand(fixture.spec.test_command, fixture.workspace, { timeoutMs });
    if (baseline.exit_code !== 0) {
      invocationCount = 1;
      try {
        agentResult = agentInvoker({
          command: String(agentCommand),
          cwd: fixture.workspace,
          prompt: buildAutonomousDogfoodPrompt(fixture.spec),
          timeoutMs,
          env: isolatedAgentEnvironment(),
          fixture,
        }) || agentResult;
      } catch (error) {
        agentResult = { ...agentResult, exit_code: 1, stderr_excerpt: excerpt(error.message), stderr_sha256: sha256(error.message), stderr_bytes: Buffer.byteLength(error.message) };
      }
    }
    finalTest = runCommand(fixture.spec.test_command, fixture.workspace, { timeoutMs });
    finalTestHash = hashFile(join(fixture.workspace, fixture.spec.test_path));
    finalSourceHash = hashFile(join(fixture.workspace, fixture.spec.source_path));
    git = gitEvidence(fixture.workspace, fixture.seed_commit, fixture.spec);
    plan = discoverPlan(fixture.workspace);
    lifecycle = lifecycleEvaluator({ workspace: fixture.workspace, plan, fixture }) || lifecycle;
    outcome = evaluateAutonomousDogfoodOutcome({
      baseline,
      agent: { ...agentResult, invocation_count: invocationCount },
      finalTest,
      fixture,
      finalTestHash,
      finalSourceHash,
      git,
      plan,
      lifecycle,
    });
  } catch (error) {
    outcome = { ok: false, status: "FAIL", failures: [{ code: "harness_error", detail: error.message }] };
  }

  const finishedAt = isoNow(now);
  const finishedMs = Date.parse(finishedAt);
  const receipt = {
    schema_version: AUTONOMOUS_DOGFOOD_RECEIPT_SCHEMA,
    run_id: resolvedRunId,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : null,
    ok: outcome?.ok === true,
    outcome: outcome?.status || "FAIL",
    failures: outcome?.failures || [],
    fixture: {
      id: fixture?.spec?.id || fixtureId,
      version: fixture?.spec?.version || null,
      source_path: fixture?.spec?.source_path || null,
      test_path: fixture?.spec?.test_path || null,
      source_hash_before: fixture?.source_hash || null,
      source_hash_after: finalSourceHash,
      test_hash_before: fixture?.test_hash || null,
      test_hash_after: finalTestHash,
    },
    agent: {
      command_fingerprint_sha256: commandFingerprint,
      invocation_count: invocationCount,
      exit_code: agentResult?.exit_code ?? null,
      timed_out: agentResult?.timed_out === true,
      stdout_bytes: agentResult?.stdout_bytes || 0,
      stderr_bytes: agentResult?.stderr_bytes || 0,
      stdout_sha256: agentResult?.stdout_sha256 || sha256(""),
      stderr_sha256: agentResult?.stderr_sha256 || sha256(""),
    },
    tests: {
      baseline: baseline ? { exit_code: baseline.exit_code, status: baseline.exit_code === 0 ? "GREEN" : "RED" } : null,
      final: finalTest ? { exit_code: finalTest.exit_code, status: finalTest.exit_code === 0 ? "GREEN" : "RED" } : null,
      red_to_green: baseline?.exit_code !== 0 && finalTest?.exit_code === 0,
      immutable_test: Boolean(fixture?.test_hash) && fixture.test_hash === finalTestHash,
    },
    git,
    planner: {
      plan: plan?.plan || null,
      lifecycle_state: lifecycle?.lifecycle_state || null,
      replay_status: lifecycle?.status || "FAIL",
      recorded_transition_chain: lifecycle?.recorded_transition_chain || [],
      gate_chain: (lifecycle?.gates || []).map((entry) => ({
        gate: entry.gate,
        historical_decision: entry.historical_evidence?.decision_log || entry.status || null,
        historical_prolog: entry.historical_evidence?.prolog_record || null,
        current_js_contract: entry.current_code?.js_contract || null,
        current_prolog_transition: entry.current_code?.prolog_transition || null,
      })),
      close_signals: lifecycle?.close_signals || [],
    },
    countersign: {
      actor: "parent_harness",
      agent_self_graded: false,
      transcript_used_for_outcome: false,
      evidence: ["fresh test subprocesses", "immutable test hash", "git diff/status", "state and gate receipt replay"],
      threat_boundary: "This is independent outcome grading, not hostile filesystem sandboxing or tamper-proof execution.",
    },
    claim_boundary: AUTONOMOUS_DOGFOOD_CLAIM_BOUNDARY,
    retry_policy: { automatic_retries: 0, attempt_is_receipt_unit: true },
    workspace: { retained: Boolean(keepWorkspace), path: keepWorkspace ? fixture?.workspace || null : null },
  };
  const receiptPath = writeAutonomousDogfoodReceipt(receipt, { repoRoot, receiptRoot });
  const workspace = fixture?.workspace || null;
  if (workspace && !keepWorkspace) rmSync(workspace, { recursive: true, force: true });
  return { receipt, receipt_path: normalizeSlash(receiptPath), workspace };
}

function collectJsonFiles(root, files = []) {
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) collectJsonFiles(path, files);
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files;
}

export function checkAutonomousDogfoodFreshness({
  repoRoot = process.cwd(),
  receiptRoot = DEFAULT_AUTONOMOUS_DOGFOOD_RECEIPT_ROOT,
  maxAgeHours = DEFAULT_AUTONOMOUS_DOGFOOD_MAX_AGE_HOURS,
  now = () => new Date(),
} = {}) {
  const root = resolve(repoRoot, receiptRoot);
  const checkedAt = isoNow(now);
  const files = collectJsonFiles(root).sort((left, right) => {
    const leftKey = normalizeSlash(relative(root, left));
    const rightKey = normalizeSlash(relative(root, right));
    return rightKey.localeCompare(leftKey);
  });
  const resolvingCommand = "node .agent/skills/iterative-planner/scripts/autonomous_dogfood_run.mjs run --agent-cmd \"<configured headless-agent command>\" --json";
  if (files.length === 0) {
    return {
      schema_version: AUTONOMOUS_DOGFOOD_FRESHNESS_SCHEMA,
      status: "WARN",
      ok: false,
      reason: "latest_receipt_absent",
      checked_at: checkedAt,
      max_age_hours: maxAgeHours,
      latest_receipt: null,
      resolving_command: resolvingCommand,
    };
  }

  const latestPath = files[0];
  const receipt = readJson(latestPath);
  if (!receipt || receipt.schema_version !== AUTONOMOUS_DOGFOOD_RECEIPT_SCHEMA) {
    return {
      schema_version: AUTONOMOUS_DOGFOOD_FRESHNESS_SCHEMA,
      status: "WARN",
      ok: false,
      reason: "latest_receipt_invalid",
      checked_at: checkedAt,
      max_age_hours: maxAgeHours,
      latest_receipt: { path: normalizeSlash(relative(resolve(repoRoot), latestPath)), valid: false },
      resolving_command: resolvingCommand,
    };
  }

  const receiptAt = Date.parse(receipt.finished_at || receipt.generated_at || receipt.started_at);
  const checkedMs = Date.parse(checkedAt);
  const ageHours = Number.isFinite(receiptAt) && Number.isFinite(checkedMs) ? Math.max(0, (checkedMs - receiptAt) / 3600000) : null;
  let reason = "latest_receipt_fresh";
  let status = "PASS";
  if (!Number.isFinite(ageHours)) {
    reason = "latest_receipt_timestamp_invalid";
    status = "WARN";
  } else if (ageHours > maxAgeHours) {
    reason = "latest_receipt_stale";
    status = "WARN";
  } else if (!verificationStatusIsPass(receipt.outcome, "execution")) {
    reason = "latest_receipt_failed";
    status = "WARN";
  }

  return {
    schema_version: AUTONOMOUS_DOGFOOD_FRESHNESS_SCHEMA,
    status,
    ok: verificationStatusIsPass(status, "gate"),
    reason,
    checked_at: checkedAt,
    max_age_hours: maxAgeHours,
    latest_receipt: {
      path: normalizeSlash(relative(resolve(repoRoot), latestPath)),
      valid: true,
      run_id: receipt.run_id || basename(latestPath, ".json"),
      outcome: receipt.outcome || null,
      finished_at: receipt.finished_at || null,
      age_hours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(3)) : null,
    },
    resolving_command: verificationStatusIsPass(status, "gate") ? null : resolvingCommand,
  };
}
