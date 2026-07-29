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
const skillRoot = join(plannerRoot, ".agent/skills/iterative-planner");
const installedPreCommitHookPath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/hooks/pre-commit");
const installedPrePushHookPath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/hooks/pre-push");
const preCommitHookPath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/pre-commit-hook.sh");
const preCommitPolicySource = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/scripts/pre_commit_policy.mjs"), "utf-8");
const affectedTimeoutMatch = preCommitPolicySource.match(/const AFFECTED_TEST_TIMEOUT_MS = ([\d_]+);/);
const verificationStatusHelperSource = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/scripts/lib/verification_status_vocabulary.mjs"), "utf-8");
const verificationStatusVocabularySource = readFileSync(join(plannerRoot, ".agent/skills/iterative-planner/config/verification_status_vocabulary.json"), "utf-8");
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

function runBin(bin, args, cwd, extraEnv = {}, input = "") {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(bin, args, {
        cwd,
        input,
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
  const libDir = join(scriptsDir, "lib");
  const configDir = join(tmp, ".agent/skills/iterative-planner/config");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(scriptsDir, "pre_commit_policy.mjs"), preCommitPolicySource);
  writeFileSync(join(libDir, "verification_status_vocabulary.mjs"), verificationStatusHelperSource);
  writeFileSync(join(configDir, "verification_status_vocabulary.json"), verificationStatusVocabularySource);
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
  seedFakeIveConformanceRunner(tmp);
  return { env: { TEST_RIPPLE_MODE: rippleMode } };
}

function seedFakeIveConformanceRunner(tmp) {
  const runnerDir = join(tmp, ".agent/skills/iterative-planner/tests/ive");
  mkdirSync(runnerDir, { recursive: true });
const runner = join(runnerDir, "run.mjs");
  writeFileSync(runner, `#!/usr/bin/env node
import { writeFileSync } from "fs";
const mode = process.env.TEST_IVE_CONFORMANCE_MODE || "pass";
const passed = mode === "pass" || mode === "large-pass";
writeFileSync(".ive-args.json", JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ status: passed ? "PASS" : "FAIL", results: [{ id: "fake-affected" }], padding: mode === "large-pass" ? "x".repeat(2 * 1024 * 1024) : "" }));
process.exitCode = passed ? 0 : 1;
`);
  chmodSync(runner, 0o755);
}

function scenarioInstalledPreCommitHook() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-pre-commit-"));
  try {
    const clean = seedPreCommitPolicyRepo(tmp, "clean");
    stageFile(tmp, ".agent/skills/iterative-planner/scripts/example.mjs", "export const example = true;\n");

    const affectedTimeoutMs = Number(String(affectedTimeoutMatch?.[1] || "0").replaceAll("_", ""));
    assert(affectedTimeoutMs >= 900_000, "installed pre-commit hook gives the full affected-suite workload at least fifteen minutes");

    const cleanResult = runBin("sh", [installedPreCommitHookPath], tmp, {
      ...clean.env,
      _PLANNER_PLAN_TARGET: "plan-test-target",
    });
    assert(cleanResult.ok, "installed pre-commit hook exits cleanly when ripple check is clean");
    assert(cleanResult.stdout.includes("ripple-through check passed"), "installed pre-commit hook reports a clean pass");
    assert(cleanResult.stdout.includes("affected IVE suites passed"), "installed pre-commit hook runs affected IVE suites");
    const affectedArgs = JSON.parse(readFileSync(join(tmp, ".ive-args.json"), "utf8"));
    assert(affectedArgs.includes("--changed-files") && affectedArgs.includes(".agent/skills/iterative-planner/scripts/example.mjs"), "installed pre-commit hook forwards the exact staged planner path to IVE");
    assert(
      affectedArgs.includes("--plan-target") && affectedArgs.includes("plan-test-target"),
      "installed pre-commit hook forwards the explicit plan target to scoped IVE suites",
    );

    execFileSync("git", ["add", ".agent/skills/iterative-planner/tests/ive/run.mjs"], { cwd: tmp, stdio: ["pipe", "pipe", "pipe"] });
    const governedResult = runBin("sh", [installedPreCommitHookPath], tmp, clean.env);
    assert(governedResult.ok, "installed pre-commit hook exits cleanly for a governed runner-surface change");
    const governedArgs = JSON.parse(readFileSync(join(tmp, ".ive-args.json"), "utf8"));
    assert(governedArgs.includes("--profile") && governedArgs.includes("core-release"), "runner-surface changes use the governed core-release profile");
    assert(!governedArgs.includes("--changed-files") && !governedArgs.includes("--no-manifest"), "governed pre-commit proof cannot be narrowed or suppress its manifest");

    const affectedFailure = runBin("sh", [installedPreCommitHookPath], tmp, { ...clean.env, TEST_IVE_CONFORMANCE_MODE: "fail" });
    assert(!affectedFailure.ok, "installed pre-commit hook blocks when an affected IVE suite fails");
    const affectedFailureOutput = affectedFailure.stdout + affectedFailure.stderr;
    assert(affectedFailureOutput.includes("refusing commit"), "installed pre-commit hook reports affected-suite refusal");
    assert(
      affectedFailureOutput.includes("half-applied payload detected")
        && affectedFailureOutput.includes("stash or revert .agent/**")
        && affectedFailureOutput.includes("migrate.mjs doctor"),
      "installed pre-commit refusal prints the managed-upgrade diagnosis and recovery recipe",
    );

    const largePass = runBin("sh", [installedPreCommitHookPath], tmp, { ...clean.env, TEST_IVE_CONFORMANCE_MODE: "large-pass" });
    assert(largePass.ok, "installed pre-commit hook accepts valid affected-suite JSON larger than Node's default child-process buffer");
    assert(largePass.stdout.includes("affected IVE suites passed"), "installed pre-commit hook reports a large affected-suite payload as passed");

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
    rmSync(join(tmp, "plans"), { recursive: true, force: true });
    const overlapping = seedPreCommitPolicyRepo(tmp, "hard");
    stageFile(tmp, ".agent/skills/iterative-planner/config/failure-codes.json", "{\n  \"ok\": true\n}\n");

    const overlappingResult = runBin("sh", [installedPreCommitHookPath], tmp, overlapping.env);
    assert(overlappingResult.ok, "installed pre-commit hook allows overlapping hard ripple gaps as advisory");
    assert(overlappingResult.stdout.includes("deferred 1 hard ripple gap"), "installed pre-commit hook reports deferred overlapping hard gaps");
    assert(!(overlappingResult.stdout + overlappingResult.stderr).includes("overlap the staged planner surfaces"), "installed pre-commit hook no longer reports a blocking overlap");
    const overlappingLedgerPath = join(tmp, "plans", "commit_advisories.json");
    assert(existsSync(overlappingLedgerPath), "overlap advisory ledger is written");
    const overlappingLedger = existsSync(overlappingLedgerPath) ? JSON.parse(readFileSync(overlappingLedgerPath, "utf-8")) : {};
    const overlappingAdvisory = (overlappingLedger.advisories || [])[0];
    assert(overlappingAdvisory?.staged_files?.includes(".agent/skills/iterative-planner/config/failure-codes.json"), "overlap advisory ledger records the staged planner file");
    assert(overlappingAdvisory?.impacted_paths?.includes(".agent/skills/iterative-planner/config/failure-codes.json"), "overlap advisory ledger records the impacted planner file");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioInstalledPrePushHook() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-pre-push-"));
  try {
    initGitRepo(tmp);
    seedFakeIveConformanceRunner(tmp);
    const baseEnv = { ITERATIVE_PLANNER_SKILL_DIR: skillRoot };

    const nonMain = runBin(
      "sh",
      [installedPrePushHookPath],
      tmp,
      { ...baseEnv, TEST_IVE_CONFORMANCE_MODE: "fail" },
      "refs/heads/feature abc refs/heads/feature def\n"
    );
    assert(nonMain.ok, "installed pre-push hook skips non-main refs");
    assert(nonMain.stdout.includes("No main push refs detected"), "installed pre-push hook reports non-main skip");

    const mainPass = runBin(
      "sh",
      [installedPrePushHookPath],
      tmp,
      {
        ...baseEnv,
        TEST_IVE_CONFORMANCE_MODE: "pass",
        _PLANNER_PLAN_TARGET: "plan-test-target",
      },
      "refs/heads/main abc refs/heads/main def\n"
    );
    assert(mainPass.ok, "installed pre-push hook allows main refs after green IVE conformance");
    assert(mainPass.stdout.includes("conformance passed"), "installed pre-push hook reports green conformance");
    const prePushArgs = JSON.parse(readFileSync(join(tmp, ".ive-args.json"), "utf8"));
    assert(
      prePushArgs.includes("--plan-target") && prePushArgs.includes("plan-test-target"),
      "installed pre-push hook forwards the explicit plan target to IVE",
    );

    const mainFail = runBin(
      "sh",
      [installedPrePushHookPath],
      tmp,
      { ...baseEnv, TEST_IVE_CONFORMANCE_MODE: "fail" },
      "refs/heads/main abc refs/heads/main def\n"
    );
    assert(!mainFail.ok, "installed pre-push hook blocks main refs after red IVE conformance");
    assert((mainFail.stdout + mainFail.stderr).includes("refusing push to main"), "installed pre-push hook reports main-push refusal");
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
    assert(result.stdout.includes("affected IVE suites passed"), "legacy pre-commit wrapper runs the shared affected-test policy");

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
    const skillScriptsDir = join(tmp, ".agent/skills/iterative-planner/scripts");
    const skillConfigDir = join(tmp, ".agent/skills/iterative-planner/config");
    const target = join(tmp, "consumer project");

    mkdirSync(join(tmp, ".agent/scripts"), { recursive: true });
    mkdirSync(skillScriptsDir, { recursive: true });
    mkdirSync(skillConfigDir, { recursive: true });
    mkdirSync(join(target, ".agent"), { recursive: true });

    writeFileSync(localScript, migrateAllSource);
    chmodSync(localScript, 0o755);
    writeFileSync(localSync, "#!/usr/bin/env bash\necho sync\n");
    chmodSync(localSync, 0o755);
    writeFileSync(join(skillScriptsDir, "migrate.mjs"), `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
const [, , command, target] = process.argv;
if (command !== 'sync-instructions' || !target) process.exit(1);
const template = readFileSync(join(process.cwd(), 'CLAUDE.md'), 'utf8');
for (const name of ['GEMINI.md', 'AGENTS.md']) {
  const path = join(target, name);
  if (!existsSync(path)) writeFileSync(path, template);
}
`);

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
    assert(existsSync(join(target, "GEMINI.md")) && existsSync(join(target, "AGENTS.md")), "migrate-all delegates root instruction snapshot sync to migrate.mjs");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nPlanner Shell Wrapper Tests\n");

scenarioInstalledPreCommitHook();
scenarioInstalledPrePushHook();
scenarioLegacyPreCommitWrapper();
scenarioMigrateAllProjectsShell();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
