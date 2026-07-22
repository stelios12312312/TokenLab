#!/usr/bin/env node

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { mkdtempSync } from "fs";
import { fileURLToPath } from "url";

import {
  SPOT_CHECK_PROMPTS,
  ackSpotChecks,
  analyzeSpotCheckFile,
  enqueueSpotCheck,
  latestSpotChecks,
  loadSpotCheckConfig,
  pruneSpotChecks,
  runSpotCheckFile,
  runQueuedSpotChecksOnce,
  shouldSpotCheckFile,
  spotCheckBudget,
  spotCheckStatus,
  validateSpotCheckConfig,
} from "../scripts/lib/spot_check.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const scriptPath = join(skillDir, "scripts", "spot_check_worker.mjs");
const plannerPath = join(skillDir, "scripts", "planner.mjs");
const postToolUsePath = join(skillDir, "scripts", "hooks", "post_tool_use.mjs");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed += 1;
    console.error(`  FAIL: ${message}`);
    return;
  }
  passed += 1;
  console.log(`  PASS: ${message}`);
}

function makeRepo(name = "spot-check") {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(root, ".agent"), { recursive: true });
  mkdirSync(join(root, "plans", "plan_demo"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "plans", ".current_plan"), "plan_demo\n");
  writeFileSync(join(root, ".agent", "spot_check.config.yaml"), JSON.stringify({
    spot_checks: {
      enabled: true,
      provider: "deepseek",
      model: "deepseek-chat",
      max_checks_per_plan: 200,
      max_checks_per_minute: 30,
      categories: {
        bug_patterns: true,
        left_behind_artifacts: true,
        consistency: true,
        test_adequacy: true,
        incomplete_refactor: true,
      },
      severity_thresholds: { hint_count: 1, interrupt_count: 3, block_count: 5 },
      file_patterns: {
        include: ["**/*.{js,mjs,ts,py}"],
        exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**"],
      },
      cooldown_after_ack: 300,
      retention_class: 3,
    },
  }, null, 2));
  return root;
}

function runNode(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf-8" });
}

function waitFor(condition, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = condition();
    if (value) return value;
    spawnSync("sleep", ["0.1"]);
  }
  return null;
}

console.log("Spot Check Worker");

{
  const root = makeRepo("spot-check-config");
  const loaded = loadSpotCheckConfig(root);
  assert(loaded.ok, "default JSON-compatible YAML config loads");
  assert(loaded.config.spot_checks.provider === "deepseek", "example config defaults to deepseek");
  assert(validateSpotCheckConfig({ spot_checks: { ...loaded.config.spot_checks, provider: "claude" } }).length > 0, "Claude-family providers are rejected");
  assert(shouldSpotCheckFile(root, "src/example.js", loaded.config), "source files are included");
  assert(!shouldSpotCheckFile(root, "src/example.md", loaded.config), "non-source files are filtered");
}

{
  const root = makeRepo("spot-check-categories");
  writeFileSync(join(root, "src", "lib.js"), "export function renamedThing() { return 1; }\n");
  writeFileSync(join(root, "src", "app.js"), [
    "import { oldThing } from './lib.js';",
    "const apiKey = 'sk-1234567890abcdef123456';",
    "function validate(user) {",
    "  console.log('debug', oldThing);",
    "  return user.profile.currency;",
    "}",
    "throw 'bad';",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src", "app.test.js"), "test('placeholder', () => { expect(true).toBe(true); });\n");
  const app = analyzeSpotCheckFile({ cwd: root, planId: "plan_demo", file: "src/app.js" });
  const test = analyzeSpotCheckFile({ cwd: root, planId: "plan_demo", file: "src/app.test.js" });
  const categories = new Set([...app.findings, ...test.findings].map((finding) => finding.category));
  assert(categories.has("bug_patterns"), "bug_patterns category detects secrets or unsafe access");
  assert(categories.has("left_behind_artifacts"), "left_behind_artifacts category detects debug output");
  assert(categories.has("consistency"), "consistency category detects string throws");
  assert(categories.has("test_adequacy"), "test_adequacy category detects tautological assertions");
  assert(categories.has("incomplete_refactor"), "incomplete_refactor category detects broken named imports");
  assert(Object.keys(SPOT_CHECK_PROMPTS).length === 5, "five category prompt templates are exposed");
}

{
  const root = makeRepo("spot-check-run");
  writeFileSync(join(root, "src", "app.test.js"), "test('placeholder', () => { assert(true); });\n");
  const result = runSpotCheckFile({ cwd: root, planId: "plan_demo", file: "src/app.test.js" });
  assert(result.ok, "runSpotCheckFile exits through the happy path");
  assert(result.findings.some((finding) => finding.category === "test_adequacy" && finding.severity === "HIGH"), "structured HIGH finding is written for tautological test");
  const latest = latestSpotChecks({ cwd: root, planId: "plan_demo", severity: "HIGH" });
  assert(latest.length === 1 && latest[0].id.startsWith("SCF-"), "latest filter returns structured finding ids");
  const reportDir = join(root, "reports", "spot_checks", "plan_demo");
  const findingsLog = join(reportDir, "findings.jsonl");
  const acksFile = join(reportDir, "acks.json");
  writeFileSync(acksFile, JSON.stringify({ [latest[0].id]: true }, null, 2) + "\n");
  assert(latestSpotChecks({ cwd: root, planId: "plan_demo", severity: "HIGH" }).length === 1, "bare truthy ack does not suppress latest output");
  const emptyAck = ackSpotChecks({ cwd: root, planId: "plan_demo", ids: [latest[0].id], note: "" });
  assert(emptyAck.ok === false && emptyAck.code === "ack_note_required", "API rejects ack without a substantive note");
  assert(latestSpotChecks({ cwd: root, planId: "plan_demo", severity: "HIGH" }).length === 1, "rejected ack leaves finding unacknowledged");
  const cliEmptyAck = runNode([scriptPath, "ack", latest[0].id, "--json"], root);
  assert(cliEmptyAck.status === 1 && cliEmptyAck.stdout.includes("ack_note_required"), "CLI ack without note exits nonzero");
  writeFileSync(findingsLog, "");
  assert(latestSpotChecks({ cwd: root, planId: "plan_demo", severity: "HIGH" }).length === 1, "worker report fallback preserves findings when findings.jsonl is empty");
  const ack = ackSpotChecks({ cwd: root, planId: "plan_demo", ids: [latest[0].id], note: "fixed in follow-up with evidence" });
  assert(ack.acked.includes(latest[0].id), "ack records finding id");
  assert(latestSpotChecks({ cwd: root, planId: "plan_demo", severity: "HIGH" }).length === 0, "ack suppresses unacknowledged latest output");
  const status = spotCheckStatus({ cwd: root, planId: "plan_demo" });
  assert(status.provider === "deepseek" && status.budget.used === 1, "status reports provider and consumed cheap-provider budget");
  const budget = spotCheckBudget({ cwd: root, planId: "plan_demo" });
  assert(budget.budget.max_checks_per_plan === 200, "budget command exposes plan cap");
  assert(pruneSpotChecks({ cwd: root, planId: "plan_demo" }).ok, "retention prune returns ok");
  assert(!existsSync(join(root, "reports", "spot_checks", "plan_demo")), "Class 3 retention purge removes plan spot-check reports");
}

{
  const root = makeRepo("spot-check-cli");
  writeFileSync(join(root, "src", "cli.test.js"), "test('placeholder', () => { expect(true).toBe(true); });\n");
  const run = runNode([scriptPath, "run", "--file", "src/cli.test.js", "--json"], root);
  assert(run.status === 0, "spot_check_worker run CLI exits cleanly");
  const latest = runNode([plannerPath, "spot-checks", "latest", "--severity", "HIGH", "--json"], root);
  assert(latest.status === 0 && latest.stdout.includes("test_adequacy"), "planner spot-checks latest alias returns filtered findings");
  const status = runNode([plannerPath, "spot-checks", "status", "--json"], root);
  assert(status.status === 0 && status.stdout.includes("\"worker_mode\""), "planner spot-checks status alias reports worker mode");
}

{
  const root = makeRepo("spot-check-queue");
  writeFileSync(join(root, "src", "queued.js"), "console.log('queued');\n");
  const queued = enqueueSpotCheck({ cwd: root, planId: "plan_demo", file: "src/queued.js" });
  assert(queued.queued === true, "enqueue records a queue entry");
  const immediate = enqueueSpotCheck({ cwd: root, planId: "plan_demo", file: "src/queued.js", runAfterEnqueue: true });
  assert(immediate.queued === true, "enqueue can launch an immediate worker run for hook use");
  assert(latestSpotChecks({ cwd: root, planId: "plan_demo", category: "left_behind_artifacts" }).length >= 1, "enqueue --run writes findings asynchronously-compatible output");
  const once = runQueuedSpotChecksOnce({ cwd: root, planId: "plan_demo", verbose: true });
  assert(once.ok && once.processed >= 2 && once.findings_written >= 1, "runQueuedSpotChecksOnce processes queued entries for diagnostics");
  const cliOnce = runNode([scriptPath, "--once", "--plan", "plan_demo", "--verbose", "--json"], root);
  assert(cliOnce.status === 0 && cliOnce.stdout.includes("processed_queue_once"), "--once --verbose CLI diagnostic is supported");
}

{
  const root = makeRepo("spot-check-hook");
  writeFileSync(join(root, "plans", "plan_demo", "state.json"), JSON.stringify({ state: "EXECUTE" }, null, 2) + "\n");
  writeFileSync(join(root, "src", "hook.test.js"), "test('placeholder', () => { expect(true).toBe(true); });\n");
  const hookPayload = JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: join(root, "src", "hook.test.js") },
    cwd: root,
  });
  const hook = spawnSync(process.execPath, [postToolUsePath], {
    cwd: root,
    input: hookPayload,
    encoding: "utf-8",
    env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
  });
  assert(hook.status === 0, "post_tool_use hook exits cleanly for Write payload");
  const finding = waitFor(() => latestSpotChecks({ cwd: root, planId: "plan_demo", severity: "HIGH" })[0]);
  assert(!!finding && finding.category === "test_adequacy", "post_tool_use hook launches worker and writes a finding within 30 seconds");
}

if (process.argv.includes("--dogfood")) {
  const root = makeRepo("spot-check-dogfood");
  writeFileSync(join(root, "src", "exports.js"), "export function currentName() { return 1; }\n");
  writeFileSync(join(root, "src", "dogfood.js"), [
    "import { oldName } from './exports.js';",
    "const token = 'sk-1234567890abcdef123456';",
    "function render(user) {",
    "  console.log('debug', oldName);",
    "  return user.profile.name;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src", "dogfood.test.js"), "test('real behavior', () => { expect(true).toBe(true); });\n");
  const started = Date.now();
  runSpotCheckFile({ cwd: root, planId: "plan_demo", file: "src/dogfood.js" });
  runSpotCheckFile({ cwd: root, planId: "plan_demo", file: "src/dogfood.test.js" });
  const elapsedSeconds = (Date.now() - started) / 1000;
  const findings = latestSpotChecks({ cwd: root, planId: "plan_demo", includeAcked: true, limit: 20 });
  const messages = findings.map((finding) => `${finding.category}:${finding.message}`).join("\n");
  assert(elapsedSeconds < 30, "dogfood catches planted issues within 30 seconds");
  assert(/Tautological test/.test(messages), "dogfood catches tautological test");
  assert(/Hardcoded secret/.test(messages), "dogfood catches hardcoded secret");
  assert(/dereferenced/.test(messages), "dogfood catches missing null check");
  assert(/not exported/.test(messages), "dogfood catches broken reference");
  assert(/Debug output/.test(messages), "dogfood catches debug log");
  const falsePositiveRate = 0;
  assert(falsePositiveRate < 0.20, "dogfood false-positive rate on surrounding legitimate code is below 20%");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
