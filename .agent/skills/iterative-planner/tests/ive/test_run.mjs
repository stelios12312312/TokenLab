#!/usr/bin/env node
// tests/ive/test_run.mjs — confidence test for the IVE conformance runner.
// Three scenarios:
//   A. PASS against the live tree (5 checks all green).
//   B. FAIL when IVE_RUNNER_INJECT_FAILURE forces one check red — exit 1, JSON
//      surfaces status: FAIL and summary.failed >= 1.
//   C. JSON shape — every top-level field and every per-check field is present.

import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { DEFAULT_SUITES, runConformance } from "./run.mjs";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const RUNNER = join(TEST_DIR, "run.mjs");
const NODE = process.execPath;
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..", "..", "..");
const LIVE_SMOKE_ONLY = ["doc-contract-mvp", "doc-contract-multi-ide"];

let passed = 0;
let failed = 0;
let runCounter = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function runRunner({ env = {}, args = null } = {}) {
  const finalArgs = args || smokeArgs(`ive-runner-test-${++runCounter}`);
  try {
    const stdout = execFileSync(NODE, [RUNNER, ...finalArgs], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { exit_code: 0, stdout, stderr: "", parsed: tryParse(stdout) };
  } catch (err) {
    return {
      exit_code: err.status ?? 1,
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || "",
      parsed: tryParse(err.stdout?.toString() || ""),
    };
  }
}

function smokeArgs(runId) {
  return [
    "--run-id", runId,
    ...LIVE_SMOKE_ONLY.flatMap((suiteId) => ["--only", suiteId]),
    "--json",
  ];
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function writeFileEnsured(path, contents, mode = null) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== null) chmodSync(path, mode);
}

function createVisualizerFixtureRepo({ fakePlaywrightExitCode = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ive-visproof-"));
  const appRoot = join(root, "apps", "ive-visualizer");
  writeFileEnsured(join(appRoot, "package.json"), JSON.stringify({
    scripts: {
      screenshot: "node ./scripts/run-playwright.mjs test --config=playwright.config.mjs",
    },
  }, null, 2));
  writeFileEnsured(join(appRoot, "scripts", "run-playwright.mjs"), "#!/usr/bin/env node\n");
  writeFileEnsured(join(appRoot, "playwright.config.mjs"), "export default {};\n");
  writeFileEnsured(join(appRoot, "tests", "visualizer-smoke.spec.mjs"), "export {};\n");
  writeFileEnsured(join(appRoot, "tests", "northstar-dogfood.spec.mjs"), "export {};\n");
  writeFileEnsured(join(appRoot, "src", "App.jsx"), "export default function App() { return null; }\n");
  writeFileEnsured(join(appRoot, "src", "styles.css"), "body { margin: 0; }\n");
  writeFileEnsured(join(appRoot, "src", "data", "visualizerPayload.js"), "export const visualizerPayload = {};\n");

  if (fakePlaywrightExitCode !== null) {
    const binName = process.platform === "win32" ? "playwright.cmd" : "playwright";
    const binPath = join(appRoot, "node_modules", ".bin", binName);
    const script = process.platform === "win32"
      ? `@echo off\r\necho fake broken playwright 1>&2\r\nexit /b ${fakePlaywrightExitCode}\r\n`
      : `#!/usr/bin/env sh\necho "fake broken playwright" >&2\nexit ${fakePlaywrightExitCode}\n`;
    writeFileEnsured(binPath, script, 0o755);
  }

  return root;
}

console.log("\nIVE conformance runner — confidence tests\n");

// Meta-guard: the research-memory packet seam is CI-real only if the suite is
// required and a red command fails the aggregate.
{
  const suite = DEFAULT_SUITES.find((entry) => entry.id === "research-memory-packet-e2e");
  assert(suite?.required === true, "research-memory-packet-e2e is a required default suite");
  assert(suite?.display_command.includes("test_research_memory_packet.mjs"), "research-memory-packet-e2e drives the packet e2e test");
  const report = runConformance({
    suites: DEFAULT_SUITES,
    only: ["research-memory-packet-e2e"],
    writeManifest: false,
    executeCommand: (item) => ({
      id: item.id,
      category: item.category,
      label: item.label,
      required: true,
      command: item.display_command,
      status: "FAIL",
      exit_code: 23,
      timed_out: false,
      started_at: "2026-06-07T00:00:00.000Z",
      finished_at: "2026-06-07T00:00:00.001Z",
      stdout_excerpt: "",
      stderr_excerpt: "synthetic research packet failure",
    }),
  });
  assert(report.ok === false && report.failed_required_count === 1, "research-memory-packet-e2e failure is gated as required");
}

// Scenario A: PASS against the live tree
console.log("Scenario A: live tree PASS");
{
  const r = runRunner();
  assert(r.exit_code === 0, "runner exits 0 on live tree");
  assert(!!r.parsed, "runner emits parseable JSON");
  assert(["PASS", "WARN"].includes(r.parsed?.status), "JSON status is PASS or WARN");
  assert(r.parsed?.summary?.failed === 0, "summary.failed is 0");
  assert(Array.isArray(r.parsed?.checks) && r.parsed.checks.length >= 2, "smoke checks array has at least 2 entries");
  assert(r.parsed?.checks?.some((c) => c.name === "doc-contract-multi-ide"), "doc-contract-multi-ide check is present");
  if (r.parsed?.status === "WARN") {
    const skipped = r.parsed?.checks?.filter((c) => c.status === "SKIPPED") || [];
    assert(skipped.length === r.parsed?.summary?.skipped, "WARN smoke run accounts for skipped checks");
    assert(skipped.every((c) => c.status_reason), "skipped checks include status_reason");
  }
  assert(!("runner_metadata" in (r.parsed || {})), "runner_metadata absent when IVE_RUNNER_INJECT_FAILURE is unset");
  assert(typeof r.parsed?.run_id === "string" && r.parsed.run_id.startsWith("ive-runner-test-"), "run_id is recorded");
  assert(typeof r.parsed?.manifest_path === "string" && existsSync(join(REPO_ROOT, r.parsed.manifest_path)), "manifest_path exists on disk");
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, r.parsed.manifest_path), "utf-8"));
  assert(["pass", "warn"].includes(manifest.overall_status), "manifest overall_status is lower-case pass or warn");
  assert(manifest.suites?.every((suite) => typeof suite.status === "string" && suite.proof_artifact), "manifest suites include status and proof_artifact");
  assert(r.parsed?.checks?.every((c) => c.stdout_log && existsSync(join(REPO_ROOT, c.stdout_log))), "each check has a stdout log");
}

// Scenario B: synthetic FAIL via env var
console.log("\nScenario B: synthetic FAIL via IVE_RUNNER_INJECT_FAILURE");
{
  const r = runRunner({ env: { IVE_RUNNER_INJECT_FAILURE: "doc-contract-mvp" } });
  assert(r.exit_code === 1, "runner exits 1 when a check is forced FAIL");
  assert(!!r.parsed, "runner still emits parseable JSON on FAIL");
  assert(r.parsed?.status === "FAIL", "JSON status is FAIL");
  assert(r.parsed?.summary?.failed >= 1, "summary.failed is >= 1");
  const target = r.parsed?.checks?.find((c) => c.name === "doc-contract-mvp");
  assert(target?.status === "FAIL", "the injected check is the one marked FAIL");
  assert(/injected failure/i.test(target?.stdout_excerpt || ""), "stdout_excerpt records the injection");
  // F-004: runner_metadata.injected_failures distinguishes injected from real failures
  assert(Array.isArray(r.parsed?.runner_metadata?.injected_failures), "runner_metadata.injected_failures is an array");
  assert((r.parsed?.runner_metadata?.injected_failures || []).includes("doc-contract-mvp"), "injected_failures lists the targeted check");
  assert(existsSync(join(REPO_ROOT, r.parsed?.manifest_path || "")), "manifest is written even on FAIL");
}

// Scenario C: JSON shape contract
console.log("\nScenario C: JSON shape contract");
{
  const r = runRunner();
  const required_top = ["schema_version", "run_id", "run_started_at", "run_finished_at", "checks", "summary", "status", "overall_status", "manifest_path"];
  for (const k of required_top) {
    assert(r.parsed && (k in r.parsed), `top-level field ${k} is present`);
  }
  assert(r.parsed?.schema_version === 1, "schema_version is 1");
  assert(typeof r.parsed?.summary?.total === "number", "summary.total is numeric");
  assert(typeof r.parsed?.summary?.passed === "number", "summary.passed is numeric");
  assert(typeof r.parsed?.summary?.failed === "number", "summary.failed is numeric");
  const required_check = ["name", "command", "status", "manifest_status", "exit_code", "duration_ms", "stdout_excerpt", "proof_artifact", "stdout_log", "stderr_log"];
  for (const c of r.parsed?.checks || []) {
    for (const k of required_check) {
      assert(k in c, `check '${c.name || "?"}' has field ${k}`);
    }
  }
}

// Scenario D: injected failure with an unknown check name does not silence real failures
console.log("\nScenario D: unknown-check injection does not silence real checks");
{
  const r = runRunner({ env: { IVE_RUNNER_INJECT_FAILURE: "non-existent-check-name" } });
  // The injection targets a non-existent check; no check should match, so the
  // runner behaves identically to a clean run.
  assert(r.exit_code === 0, "unknown injection name does not change exit code");
  assert(["PASS", "WARN"].includes(r.parsed?.status), "unknown injection name does not flip status to FAIL");
  assert(r.parsed?.summary?.failed === 0, "unknown injection name does not silence anything");
  assert((r.parsed?.checks || []).filter((c) => c.status === "SKIPPED").every((c) => c.status_reason), "unknown injection preserves reasoned skips");
}

// Scenario E: changed files outside IVE surfaces are explicit not_applicable
console.log("\nScenario E: changed-files not_applicable contract");
{
  const r = runRunner({ args: ["--run-id", `ive-runner-test-${++runCounter}`, "--changed-files", "README.md", "--json"] });
  assert(r.exit_code === 0, "outside changed files exit 0");
  assert(r.parsed?.overall_status === "not_applicable", "outside changed files are not_applicable");
  assert(r.parsed?.checks?.[0]?.status_reason === "changed_files_outside_declared_ive_surfaces", "not_applicable includes a reason");
}

// Scenario F: missing local visualizer Playwright is a reasoned SKIPPED, not a false green
console.log("\nScenario F: visualizer browser proof skips only when local Playwright is absent");
{
  const fixtureRoot = createVisualizerFixtureRepo();
  try {
    const report = runConformance({
      only: ["visualizer-browser-proof"],
      repoRoot: fixtureRoot,
      reportRoot: join(fixtureRoot, "reports", "ive", "test_runs"),
      writeManifest: false,
      runId: "ive-runner-test-vis-skip",
    });
    const check = report.checks?.[0];
    assert(report.status === "WARN", "missing local Playwright reports WARN");
    assert(report.ok === true, "reasoned local browser SKIPPED is not a failing issue");
    assert(report.summary?.skipped === 1, "summary.skipped records the browser skip");
    assert(check?.status === "SKIPPED", "visualizer-browser-proof check is SKIPPED");
    assert(check?.manifest_status === "skipped", "manifest status maps SKIPPED to skipped");
    assert(/playwright_dependency_missing/.test(check?.status_reason || ""), "SKIPPED includes playwright_dependency_missing reason");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// Scenario G: present but broken local visualizer Playwright is a hard FAIL
console.log("\nScenario G: broken local Playwright is a real failure");
{
  const fixtureRoot = createVisualizerFixtureRepo({ fakePlaywrightExitCode: 17 });
  try {
    const report = runConformance({
      only: ["visualizer-browser-proof"],
      repoRoot: fixtureRoot,
      reportRoot: join(fixtureRoot, "reports", "ive", "test_runs"),
      writeManifest: false,
      runId: "ive-runner-test-vis-fail",
    });
    const check = report.checks?.[0];
    assert(report.status === "FAIL", "broken local Playwright reports FAIL");
    assert(report.ok === false, "broken local browser proof is not ok");
    assert(report.summary?.failed === 1, "summary.failed records the browser failure");
    assert(check?.status === "FAIL", "visualizer-browser-proof check is FAIL");
    assert(check?.exit_code === 17, "browser failure preserves Playwright exit code");
    assert(/fake broken playwright/.test(check?.stderr_excerpt || ""), "browser failure preserves stderr");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
