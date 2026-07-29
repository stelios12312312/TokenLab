#!/usr/bin/env node
// test_autonomous_dogfood_run.mjs - deterministic L3 harness countersign proof.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  AUTONOMOUS_DOGFOOD_RECEIPT_SCHEMA,
  buildAutonomousDogfoodPrompt,
  buildAutonomousDogfoodFixture,
  checkAutonomousDogfoodFreshness,
  evaluateAutonomousPlannerLifecycle,
  getAutonomousDogfoodFixtureSpec,
  runAutonomousDogfood,
} from "../scripts/lib/autonomous_dogfood_run.mjs";
import { evaluateCurrentGateInRepository } from "../scripts/lib/dogfood_lifecycle_replay.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const cli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "autonomous_dogfood_run.mjs");

const GATES = [
  "explore-to-plan",
  "plan-to-execute",
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
  "notify-user",
];
const CORRECT_SOURCE = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(maximum, Math.max(minimum, value));",
  "}",
  "",
].join("\n");

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makePlan(workspace, name = "plan_simulated_l3") {
  const planDir = join(workspace, "plans", name);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(workspace, "plans", ".current_plan"), `${name}\n`);
  writeJson(join(planDir, "state.json"), { state: "CLOSE" });
  return { name, planDir };
}

function passingLifecycle() {
  return {
    ok: true,
    status: "PASS",
    lifecycle_state: "CLOSE",
    recorded_transition_chain: GATES.slice(0, 5).map((gate) => ({ gate, ok: true })),
    gates: GATES.map((gate) => ({
      gate,
      historical_evidence: { decision_log: "ALLOWED", prolog_record: "ALLOWED" },
      current_code: { js_contract: "PASS", prolog_transition: gate === "notify-user" ? "AUDIT_ONLY" : "PASS" },
    })),
    close_signals: [
      { signal: "progress_complete", satisfied: true },
      { signal: "kb_signoff", satisfied: true },
    ],
    failures: [],
  };
}

function missingGateLifecycle() {
  return {
    ...passingLifecycle(),
    ok: false,
    status: "FAIL",
    lifecycle_state: "EXECUTE",
    gates: GATES.slice(0, 2).map((gate) => ({ gate, status: "ALLOWED" })),
    failures: [{
      code: "historical_decision_missing",
      gate: "execute-to-reflect",
      artifact: "artifacts/decision_log.jsonl",
      detail: "simulated missing real gate receipt",
    }],
  };
}

function deterministicNow() {
  const values = [new Date("2026-07-10T12:00:00.000Z"), new Date("2026-07-10T12:00:01.000Z")];
  return () => values.shift() || new Date("2026-07-10T12:00:01.000Z");
}

function runSimulation(tmp, id, agentInvoker, lifecycleEvaluator = passingLifecycle) {
  return runAutonomousDogfood({
    repoRoot,
    agentCommand: `simulated-agent-${id}-secret`,
    receiptRoot: join(tmp, "receipts", id),
    workspaceParent: join(tmp, "workspaces"),
    agentInvoker,
    lifecycleEvaluator,
    now: deterministicNow(),
    runId: `l3-${id}`,
  });
}

function repairAndPlan({ cwd }) {
  writeFileSync(join(cwd, "src", "clamp.mjs"), CORRECT_SOURCE);
  makePlan(cwd);
  return { exit_code: 0, timed_out: false, stdout: "agent says success", stderr: "" };
}

function runPromptContract() {
  const spec = getAutonomousDogfoodFixtureSpec();
  const prompt = buildAutonomousDogfoodPrompt(spec);
  const commands = GATES.map((gate) => `node .agent/skills/iterative-planner/scripts/transition.mjs ${gate}`);
  const indexes = commands.map((command) => prompt.indexOf(command));
  assert(indexes.every((index) => index >= 0), "composed task publishes all six literal transition commands");
  assert(indexes.every((index, position) => position === 0 || index > indexes[position - 1]), "composed task publishes the six commands in lifecycle order");
  assert(commands.every((command) => prompt.split(command).length === 2), "composed task publishes each transition command exactly once");
  assert(prompt.includes("audit-only sixth gate after the plan reaches CLOSE"), "composed task identifies notify-user as mandatory after CLOSE");
  for (const immutablePath of [
    "audit.config.json",
    ".gitignore",
    "reports/user_story_audit/story_registry.json",
    spec.test_path,
    "tests/",
    "plans/knowledge/",
    "index.md",
    "mistakes.md",
    "patterns.md",
    "gotchas.md",
  ]) {
    assert(prompt.includes(immutablePath), `composed task names immutable input ${immutablePath}`);
  }
}

function kbDigestHash(workspace, salt) {
  const knowledgeDir = join(workspace, "plans", "knowledge");
  const content = ["index.md", "mistakes.md", "patterns.md", "gotchas.md"]
    .map((name) => join(knowledgeDir, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf-8"))
    .join("");
  return createHash("sha256").update(salt + content).digest("hex").slice(0, 32);
}

function runFixtureContract(tmp) {
  const fixture = buildAutonomousDogfoodFixture({ repoRoot, workspaceParent: join(tmp, "fixture parent (quoted)") });
  try {
    const initialAuditConfig = readFileSync(join(fixture.workspace, "audit.config.json"), "utf-8");
    const parsedAuditConfig = JSON.parse(initialAuditConfig);
    assert(
      JSON.stringify(parsedAuditConfig.suppressed_domain_profiles) === JSON.stringify(["quant", "quant_betting"]),
      "canonical fixture pre-suppresses only the known irrelevant quant profiles",
    );
    const baseline = spawnSync(process.execPath, ["--test", "tests/clamp.test.mjs"], {
      cwd: fixture.workspace,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert(baseline.status !== 0, "canonical fixture starts red through the real behavioral test");
    assert(existsSync(join(fixture.workspace, "src", "clamp.mjs")), "canonical fixture contains the intended source module");
    assert(existsSync(join(fixture.workspace, "tests", "clamp.test.mjs")), "canonical fixture contains one behavioral test file");
    const isolationMarker = join(fixture.workspace, ".agent", ".l3-runtime-isolation-marker");
    writeFileSync(isolationMarker, "fixture-only\n");
    assert(!existsSync(join(repoRoot, ".agent", ".l3-runtime-isolation-marker")), "fixture runtime cannot mutate the parent harness runtime");
    const bootstrap = spawnSync(process.execPath, [
      ".agent/skills/iterative-planner/scripts/bootstrap.mjs",
      "new",
      "--force",
      "Exercise the canonical fixture bootstrap contract",
    ], {
      cwd: fixture.workspace,
      env: { ...process.env, PLANNER_SKIP_SELF_HEAL: "1" },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const gitignoreDiff = spawnSync("git", ["diff", "--exit-code", "--", ".gitignore"], {
      cwd: fixture.workspace,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ignoreRules = readFileSync(join(fixture.workspace, ".gitignore"), "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const ignoresProofRoot = (root) => ignoreRules.some((rule) => new RegExp(`^/?${root}(?:/|/\\*|/\\*\\*)?$`).test(rule));
    assert(bootstrap.status === 0, "canonical fixture exercises the real bootstrap generator", bootstrap.stderr);
    assert(readFileSync(join(fixture.workspace, "audit.config.json"), "utf-8") === initialAuditConfig, "bootstrap preserves immutable fixture audit config bytes");
    assert(gitignoreDiff.status === 0, "bootstrap creates no gitignore drift in the canonical fixture", gitignoreDiff.stdout);
    assert(!ignoresProofRoot("plans"), "fixture never broadly ignores plans proof surface");
    assert(!ignoresProofRoot("reports"), "fixture never broadly ignores reports proof surface");

    const activePlanName = readFileSync(join(fixture.workspace, "plans", ".current_plan"), "utf-8").trim();
    const activePlanDir = join(fixture.workspace, "plans", activePlanName);
    const salt = "0123456789abcdef0123456789abcdef";
    const statePath = join(activePlanDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.kb_digest_hash = kbDigestHash(fixture.workspace, salt);
    writeJson(statePath, state);
    const ledgerPath = join(activePlanDir, "findings_ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8"));
    ledger.kb_digest_salt = salt;
    writeJson(ledgerPath, ledger);
    const validKbReplay = evaluateCurrentGateInRepository({
      repoRoot: fixture.workspace,
      skillRoot: fixture.harness_skill_root,
      planDir: activePlanDir,
      gate: "explore-to-plan",
    });
    const validKbCheck = validKbReplay.results.find((entry) => entry.code === "GATE-EXP-010");
    assert(validKbCheck?.status === "PASS", "cross-repository current gate accepts the fixture-local KB digest", JSON.stringify(validKbCheck));
    ledger.kb_digest_salt = "fedcba9876543210fedcba9876543210";
    writeJson(ledgerPath, ledger);
    const invalidKbReplay = evaluateCurrentGateInRepository({
      repoRoot: fixture.workspace,
      skillRoot: fixture.harness_skill_root,
      planDir: activePlanDir,
      gate: "explore-to-plan",
    });
    const invalidKbCheck = invalidKbReplay.results.find((entry) => entry.code === "GATE-EXP-010");
    assert(
      invalidKbCheck?.status === "WARN" && invalidKbCheck?.advisory_conversion === true,
      "cross-repository current gate surfaces an incorrect fixture KB digest without blocking planning",
      JSON.stringify(invalidKbCheck),
    );
    let missingGraderFailedClosed = false;
    try {
      evaluateCurrentGateInRepository({
        repoRoot: fixture.workspace,
        skillRoot: join(fixture.workspace, "missing-current-grader"),
        planDir: activePlanDir,
        gate: "explore-to-plan",
      });
    } catch (error) {
      missingGraderFailedClosed = error.message.includes("current gate evaluator failed in replay repository");
    }
    assert(missingGraderFailedClosed, "cross-repository current gate fails closed when current grader code cannot load");

    writeFileSync(join(fixture.workspace, ".agent", "skills", "iterative-planner", "config", "gates.json"), "{invalid\n");
    const replayProbe = makePlan(fixture.workspace, "plan_runtime_isolation_probe");
    const replayResult = evaluateAutonomousPlannerLifecycle({
      workspace: fixture.workspace,
      plan: { plan: replayProbe.name, plan_dir: replayProbe.planDir },
      fixture,
    });
    assert(
      !replayResult.failures.some((entry) => String(entry.detail || "").includes("Gate registry is invalid")),
      "parent countersign uses current harness gates rather than agent-mutable fixture gates",
    );
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
}

function runPassingSimulation(tmp) {
  const result = runSimulation(tmp, "pass", repairAndPlan);
  const text = JSON.stringify(result.receipt);
  assert(result.receipt.outcome === "PASS", "simulated valid repair passes independent countersign", text);
  assert(result.receipt.agent.invocation_count === 1, "passing simulation invokes the agent exactly once");
  assert(result.receipt.tests.red_to_green === true, "passing simulation proves red-to-green behavior");
  assert(result.receipt.tests.immutable_test === true, "passing simulation preserves seeded test bytes");
  assert(result.receipt.git.worktree_clean_of_stray_files === true, "passing simulation has no unexpected worktree paths");
  assert(result.receipt.planner.gate_chain.length === 6, "passing receipt carries all six planner gates");
  assert(result.receipt.planner.lifecycle_state === "CLOSE", "passing receipt carries CLOSE state");
  assert(result.receipt.countersign.transcript_used_for_outcome === false, "transcript is explicitly excluded from grading");
  assert(!text.includes("simulated-agent-pass-secret"), "receipt persists command fingerprint without raw command");
  assert(result.receipt.claim_boundary.does_not_prove.includes("L4 domain work"), "receipt preserves the L4 claim boundary");
}

function runFalseGreenSimulations(tmp) {
  let selfClaimCalls = 0;
  const selfClaim = runSimulation(tmp, "self-claim", ({ cwd }) => {
    selfClaimCalls += 1;
    makePlan(cwd);
    return { exit_code: 0, stdout: "SUCCESS: everything is green" };
  });
  assert(selfClaimCalls === 1, "self-claimed success receives no retry");
  assert(selfClaim.receipt.outcome === "FAIL", "self-claimed success cannot override a red final test");
  assert(selfClaim.receipt.failures.some((entry) => entry.code === "final_test_not_green"), "red final test names its failed assertion");

  let failedAgentCalls = 0;
  const failedAgent = runSimulation(tmp, "agent-fail", () => {
    failedAgentCalls += 1;
    return { exit_code: 9, stderr: "gave up" };
  }, missingGateLifecycle);
  assert(failedAgentCalls === 1 && failedAgent.receipt.agent.invocation_count === 1, "non-zero agent exit is recorded once without retry");
  assert(failedAgent.receipt.failures.some((entry) => entry.code === "agent_command_failed"), "non-zero agent exit fails countersign");

  const tampered = runSimulation(tmp, "tampered-test", ({ cwd }) => {
    writeFileSync(join(cwd, "src", "clamp.mjs"), CORRECT_SOURCE);
    writeFileSync(join(cwd, "tests", "clamp.test.mjs"), "import test from 'node:test';\ntest('weakened', () => {});\n");
    makePlan(cwd);
    return { exit_code: 0 };
  });
  assert(tampered.receipt.failures.some((entry) => entry.code === "seeded_test_changed"), "test tampering fails even when the weakened suite is green");

  const stray = runSimulation(tmp, "stray-file", ({ cwd }) => {
    writeFileSync(join(cwd, "src", "clamp.mjs"), CORRECT_SOURCE);
    writeFileSync(join(cwd, "notes.txt"), "unexpected\n");
    makePlan(cwd);
    return { exit_code: 0 };
  });
  assert(stray.receipt.failures.some((entry) => entry.code === "unexpected_worktree_path" && entry.path === "notes.txt"), "unexpected file fails with its path");

  const missingGate = runSimulation(tmp, "missing-gate", repairAndPlan, missingGateLifecycle);
  assert(missingGate.receipt.failures.some((entry) => entry.code === "historical_decision_missing" && entry.gate === "execute-to-reflect"), "missing lifecycle evidence fails naming the gate");
  assert(missingGate.receipt.outcome === "FAIL", "incomplete planner ceremony cannot pass on green code alone");

  const noPlan = evaluateAutonomousPlannerLifecycle({ workspace: tmp, plan: null });
  assert(noPlan.ok === false && noPlan.failures[0].code === "plan_missing", "default lifecycle evaluator rejects absent plans");
}

function writeReceipt(path, { outcome = "PASS", finishedAt = "2026-07-10T10:00:00.000Z" } = {}) {
  writeJson(path, {
    schema_version: AUTONOMOUS_DOGFOOD_RECEIPT_SCHEMA,
    run_id: "freshness-fixture",
    started_at: finishedAt,
    finished_at: finishedAt,
    outcome,
  });
}

function runFreshnessContracts(tmp) {
  const absentRoot = join(tmp, "freshness", "absent");
  const absent = checkAutonomousDogfoodFreshness({ repoRoot, receiptRoot: absentRoot, now: () => new Date("2026-07-10T12:00:00Z") });
  assert(absent.status === "WARN" && absent.reason === "latest_receipt_absent", "absent receipt is advisory WARN");

  const freshRoot = join(tmp, "freshness", "fresh");
  writeReceipt(join(freshRoot, "2026-07-10", "receipt.json"), { finishedAt: "2026-07-10T10:00:00.000Z" });
  const fresh = checkAutonomousDogfoodFreshness({ repoRoot, receiptRoot: freshRoot, now: () => new Date("2026-07-10T12:00:00Z") });
  assert(fresh.status === "PASS" && fresh.latest_receipt.age_hours === 2, "fresh passing receipt is PASS with deterministic age");

  const stale = checkAutonomousDogfoodFreshness({ repoRoot, receiptRoot: freshRoot, maxAgeHours: 1, now: () => new Date("2026-07-10T12:00:00Z") });
  assert(stale.status === "WARN" && stale.reason === "latest_receipt_stale", "stale receipt is advisory WARN");

  const failedRoot = join(tmp, "freshness", "failed");
  writeReceipt(join(failedRoot, "2026-07-10", "receipt.json"), { outcome: "FAIL", finishedAt: "2026-07-10T11:30:00.000Z" });
  const failedReceipt = checkAutonomousDogfoodFreshness({ repoRoot, receiptRoot: failedRoot, now: () => new Date("2026-07-10T12:00:00Z") });
  assert(failedReceipt.status === "WARN" && failedReceipt.reason === "latest_receipt_failed", "fresh failed attempt remains honest advisory WARN");

  const orderedRoot = join(tmp, "freshness", "dated-order");
  writeReceipt(join(orderedRoot, "2026-07-10", "l3-2026-07-10T11-30-00Z-newer.json"), { outcome: "FAIL", finishedAt: "2026-07-10T11:30:00.000Z" });
  writeReceipt(join(orderedRoot, "2026-07-09", "l3-2026-07-09T11-30-00Z-older.json"), { outcome: "PASS", finishedAt: "2026-07-09T11:30:00.000Z" });
  const datedOrder = checkAutonomousDogfoodFreshness({ repoRoot, receiptRoot: orderedRoot, now: () => new Date("2026-07-10T12:00:00Z") });
  assert(
    datedOrder.status === "WARN" && datedOrder.latest_receipt.outcome === "FAIL",
    "dated receipt order cannot be overridden by a later filesystem mtime on an older PASS",
  );

  const invalidRoot = join(tmp, "freshness", "invalid");
  mkdirSync(invalidRoot, { recursive: true });
  writeFileSync(join(invalidRoot, "bad.json"), "{not-json\n");
  const invalid = checkAutonomousDogfoodFreshness({ repoRoot, receiptRoot: invalidRoot, now: () => new Date("2026-07-10T12:00:00Z") });
  assert(invalid.status === "WARN" && invalid.reason === "latest_receipt_invalid", "malformed latest receipt is advisory WARN");

  const cliResult = spawnSync(process.execPath, [
    cli,
    "freshness",
    "--receipt-root",
    freshRoot,
    "--now",
    "2026-07-10T12:00:00Z",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  const cliJson = JSON.parse(cliResult.stdout);
  assert(cliResult.status === 0 && cliJson.status === "PASS", "freshness JSON CLI exposes the deterministic public contract");
}

console.log("\nAutonomous Dogfood L3 Harness Tests\n");

const tmp = mkdtempSync(join(tmpdir(), "ive-l3-harness-test-"));
try {
  runPromptContract();
  runFixtureContract(tmp);
  runPassingSimulation(tmp);
  runFalseGreenSimulations(tmp);
  runFreshnessContracts(tmp);
  let missingCommandThrew = false;
  try {
    runAutonomousDogfood({ repoRoot, agentCommand: "" });
  } catch {
    missingCommandThrew = true;
  }
  assert(missingCommandThrew, "run refuses implicit vendor selection when agent command is absent");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
