#!/usr/bin/env node
// test_planner_shell_wrappers.mjs
// Coverage for bash wrappers that orchestrate planner behavior.

import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const installedPreCommitHookPath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/hooks/pre-commit");
const preCommitHookPath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/pre-commit-hook.sh");
const preCommitPolicySource = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/scripts/pre_commit_policy.mjs"), "utf-8");
const runNodeSource = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/scripts/hooks/run-node.sh"), "utf-8");
const migrateAllSource = readFileSync(join(plannerRoot, ".agent/scripts/migrate-all-projects.sh"), "utf-8");

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

function runBin(bin, args, cwd, extraEnv = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(bin, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      }),
      stderr: "",
    };
  } catch (e) {
    return {
      ok: false,
      status: e.status ?? 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

function initGitRepo(cwd) {
  execFileSync("git", ["init", "-q"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function seedFakeNvmNode(tmp) {
  const fakeHome = join(tmp, "fake-home");
  const fakeNodeDir = join(fakeHome, ".nvm", "versions", "node", "v20.19.2", "bin");
  mkdirSync(fakeNodeDir, { recursive: true });
  const fakeNode = join(fakeNodeDir, "node");
  writeFileSync(fakeNode, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`);
  chmodSync(fakeNode, 0o755);
  return {
    HOME: fakeHome,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

function stageFile(cwd, relPath, content) {
  const fullPath = join(cwd, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["add", relPath], { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function seedPreCommitPolicyRepo(tmp, rippleMode) {
  initGitRepo(tmp);
  const scriptsDir = join(tmp, ".agent/skills/iterative-planner/scripts");
  const hooksDir = join(scriptsDir, "hooks");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(scriptsDir, "pre_commit_policy.mjs"), preCommitPolicySource);
  writeFileSync(join(hooksDir, "run-node.sh"), runNodeSource);
  chmodSync(join(hooksDir, "run-node.sh"), 0o755);
  writeFileSync(join(scriptsDir, "ripple_check.mjs"), `#!/usr/bin/env node
const mode = process.env.TEST_RIPPLE_MODE || "clean";
if (mode === "hard") {
  console.log(JSON.stringify({
    results: [
      {
        gate: "plan-to-execute",
        gaps: [
          { file: "failure-codes.json", issue: "simulated hard gap" }
        ]
      }
    ],
    summary: { gates: 1, total_gaps: 1, hard_gaps: 1 }
  }));
  process.exit(1);
}
console.log(JSON.stringify({
  results: [
    {
      gate: "plan-to-execute",
      gaps: []
    }
  ],
  summary: { gates: 1, total_gaps: 0, hard_gaps: 0 }
}));
`);
  return { env: { TEST_RIPPLE_MODE: rippleMode } };
}

function scenarioInstalledPreCommitHook() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-pre-commit-"));
  try {
    const clean = seedPreCommitPolicyRepo(tmp, "clean");
    stageFile(tmp, ".agent/skills/iterative-planner/scripts/example.mjs", "export const example = true;\n");

    const cleanResult = runBin("sh", [installedPreCommitHookPath], tmp, clean.env);
    assert(cleanResult.ok, "installed pre-commit hook exits cleanly when ripple check is clean");
    assert(cleanResult.stdout.includes("ripple-through check passed"), "installed pre-commit hook reports a clean pass");

    const strippedEnv = seedFakeNvmNode(tmp);
    const strippedResult = runBin("sh", [installedPreCommitHookPath], tmp, { ...clean.env, ...strippedEnv });
    assert(strippedResult.ok, "installed pre-commit hook resolves nvm Node when PATH omits node");
    assert(strippedResult.stdout.includes("ripple-through check passed"), "installed pre-commit hook still reports a clean pass under stripped PATH");

    execFileSync("git", ["reset", "--hard", "-q"], { cwd: tmp, stdio: ["pipe", "pipe", "pipe"] });
    const advisory = seedPreCommitPolicyRepo(tmp, "hard");
    stageFile(tmp, ".agent/skills/iterative-planner/scripts/example.mjs", "export const example = false;\n");

    const advisoryResult = runBin("sh", [installedPreCommitHookPath], tmp, advisory.env);
    assert(advisoryResult.ok, "installed pre-commit hook allows non-overlapping hard ripple gaps");
    assert(advisoryResult.stdout.includes("deferred 1 hard ripple gap"), "installed pre-commit hook reports deferred hard gaps");
    assert(existsSync(join(tmp, "plans", "commit_advisories.json")), "installed pre-commit hook writes the local advisory ledger");
    const advisoryLedger = JSON.parse(readFileSync(join(tmp, "plans", "commit_advisories.json"), "utf-8"));
    assert((advisoryLedger.advisories || []).length === 1, "advisory ledger records the deferred issue");
    assert((advisoryLedger.advisories || [])[0]?.staged_files?.includes(".agent/skills/iterative-planner/scripts/example.mjs"), "advisory ledger records the staged planner file");

    execFileSync("git", ["reset", "--hard", "-q"], { cwd: tmp, stdio: ["pipe", "pipe", "pipe"] });
    const blocking = seedPreCommitPolicyRepo(tmp, "hard");
    stageFile(tmp, ".agent/skills/iterative-planner/config/failure-codes.json", "{\n  \"ok\": true\n}\n");

    const blockingResult = runBin("sh", [installedPreCommitHookPath], tmp, blocking.env);
    assert(!blockingResult.ok, "installed pre-commit hook blocks overlapping hard ripple gaps");
    assert((blockingResult.stdout + blockingResult.stderr).includes("overlap the staged planner surfaces"), "installed pre-commit hook explains the blocking overlap");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLegacyPreCommitWrapper() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-pre-commit-wrapper-"));
  try {
    const seeded = seedPreCommitPolicyRepo(tmp, "clean");
    stageFile(tmp, ".agent/skills/iterative-planner/scripts/example.mjs", "export const wrapper = true;\n");

    const result = runBin("bash", [preCommitHookPath], tmp, seeded.env);
    assert(result.ok, "legacy pre-commit wrapper delegates cleanly to the shared policy helper");
    assert(result.stdout.includes("ripple-through check passed"), "legacy pre-commit wrapper surfaces the shared policy result");

    const strippedEnv = seedFakeNvmNode(tmp);
    const strippedResult = runBin("bash", [preCommitHookPath], tmp, { ...seeded.env, ...strippedEnv });
    assert(strippedResult.ok, "legacy pre-commit wrapper resolves nvm Node when PATH omits node");
    assert(strippedResult.stdout.includes("ripple-through check passed"), "legacy pre-commit wrapper surfaces policy result under stripped PATH");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMigrateAllProjectsShell() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-migrate-all-"));
  try {
    const localScript = join(tmp, ".agent/scripts/migrate-all-projects.sh");
    const localSync = join(tmp, ".agent/scripts/sync-instructions.sh");
    const skillConfigDir = join(tmp, ".agent/skills/iterative-planner/config");
    const target = join(tmp, "consumer project");

    mkdirSync(join(tmp, ".agent/scripts"), { recursive: true });
    mkdirSync(skillConfigDir, { recursive: true });
    mkdirSync(join(target, ".agent"), { recursive: true });

    writeFileSync(localScript, migrateAllSource);
    chmodSync(localScript, 0o755);
    writeFileSync(localSync, "#!/usr/bin/env bash\necho sync\n");
    chmodSync(localSync, 0o755);

    writeFileSync(join(tmp, ".agent/rules.md"), `# Planner Rules

## 0. Use the Iterative Planner
Follow the planner state machine.

## 1. Keep the repo honest
`);
    writeFileSync(join(tmp, "CLAUDE.md"), "# Canonical planner instructions\n");
    writeFileSync(join(skillConfigDir, ".project_registry.json"), JSON.stringify({
      projects: [
        { path: target },
      ],
    }, null, 2));

    writeFileSync(join(target, ".agent/rules.md"), `# Project Rules

---

## 1. Existing rule
Preserve project-specific guidance.
`);

    const result = runBin("bash", [localScript], tmp);
    assert(result.ok, "migrate-all-projects shell wrapper exits cleanly on a temp registry");
    const strippedEnv = seedFakeNvmNode(tmp);
    const strippedResult = runBin("bash", [localScript], tmp, strippedEnv);
    assert(strippedResult.ok, "migrate-all-projects shell wrapper resolves nvm Node when PATH omits node");
    assert(existsSync(join(target, ".agent/scripts/sync-instructions.sh")), "migrate-all installs sync-instructions.sh into the target project");
    assert(readFileSync(join(target, ".agent/rules.md"), "utf-8").includes("## 0. Use the Iterative Planner"), "migrate-all injects Rule 0 into target rules.md");
    assert(readFileSync(join(target, "CLAUDE.md"), "utf-8") === "# Canonical planner instructions\n", "migrate-all creates CLAUDE.md from the planner template");
    assert(existsSync(join(target, "GEMINI.md")) && existsSync(join(target, "AGENTS.md")), "migrate-all syncs GEMINI.md and AGENTS.md from CLAUDE.md");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nPlanner Shell Wrapper Tests\n");

scenarioInstalledPreCommitHook();
scenarioLegacyPreCommitWrapper();
scenarioMigrateAllProjectsShell();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
