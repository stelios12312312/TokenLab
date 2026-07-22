#!/usr/bin/env node
// test_ci_enforcement_contracts.mjs
// T-INTAKE-ECF78BA4: CI enforcement contracts for IVE remediation.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const skillRoot = join(plannerRoot, ".agent", "skills", "iterative-planner");
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

function readText(relPath) {
  return readFileSync(join(plannerRoot, relPath), "utf-8");
}

function requireFile(relPath, label) {
  const fullPath = join(plannerRoot, relPath);
  const present = existsSync(fullPath);
  assert(present, label);
  return present ? fullPath : null;
}

function runBin(bin, args, options = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(bin, args, {
        cwd: options.cwd || plannerRoot,
        input: options.input || "",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(options.env || {}) },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function initGitRepo(cwd) {
  execFileSync("git", ["init", "-q"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function withTempProject(prefix, fn) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  try {
    initGitRepo(tmp);
    fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeFakeConformanceRunner(root) {
  const runnerDir = join(root, ".agent", "skills", "iterative-planner", "tests", "ive");
  mkdirSync(runnerDir, { recursive: true });
  const runner = join(runnerDir, "run.mjs");
  writeFileSync(runner, `#!/usr/bin/env node
const mode = process.env.TEST_IVE_CONFORMANCE_MODE || "pass";
console.log(JSON.stringify({ status: mode === "pass" ? "PASS" : "FAIL" }));
process.exit(mode === "pass" ? 0 : 1);
`);
  chmodSync(runner, 0o755);
}

function writeFakeGh(binDir) {
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, "gh");
  writeFileSync(gh, `#!/bin/sh
if [ "$1" = "repo" ]; then
  printf '%s\\n' '{"isPrivate":true,"viewerPermission":"ADMIN","nameWithOwner":"owner/repo"}'
  exit 0
fi

if [ "$1" = "api" ]; then
  case "$TEST_GH_PROTECTION_MODE" in
    enforced)
      cat <<'JSON'
{"required_status_checks":{"contexts":["ive-conformance / conformance"]},"required_pull_request_reviews":{"required_approving_review_count":1},"enforce_admins":{"enabled":true},"restrictions":null}
JSON
      exit 0
      ;;
    forbidden)
      echo 'HTTP 403: Resource not accessible by integration' >&2
      exit 1
      ;;
    notfound)
      echo 'HTTP 404: Branch not protected' >&2
      exit 1
      ;;
  esac
fi

echo "unexpected gh invocation: $*" >&2
exit 1
`);
  chmodSync(gh, 0o755);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scenarioIveConformanceWorkflowCoversVisualizer() {
  const workflow = readText(".github/workflows/ive-conformance.yml");

  assert(/name:\s*ive-conformance/.test(workflow), "IVE conformance workflow keeps the expected check name");
  assert(workflow.includes("pull_request:"), "IVE conformance workflow runs on pull_request");
  assert(workflow.includes("push:"), "IVE conformance workflow runs on push");
  assert(workflow.includes("branches:\n      - main"), "IVE conformance push leg is scoped to main");
  assert((workflow.match(/apps\/ive-visualizer\/\*\*/g) || []).length >= 2, "visualizer path triggers both PR and main-push conformance legs");
  assert(workflow.includes("npm ci --prefix apps/ive-visualizer"), "workflow installs visualizer dependencies");
  assert(workflow.includes("playwright -- install --with-deps chromium"), "workflow provisions Chromium for visual proof");
  assert(workflow.includes("node .agent/skills/iterative-planner/tests/ive/run.mjs --json"), "workflow runs strict JSON IVE conformance");
  assert(workflow.includes("node .agent/skills/iterative-planner/tests/ive/test_run.mjs"), "workflow runs IVE conformance unit coverage");
}

function scenarioPrePushHookBlocksMainOnly() {
  const prePush = requireFile(
    ".agent/skills/iterative-planner/scripts/hooks/pre-push",
    "managed pre-push hook source ships"
  );
  const helper = requireFile(
    ".agent/skills/iterative-planner/scripts/hooks/pre_push_conformance.mjs",
    "pre-push conformance helper ships"
  );
  if (!prePush || !helper) return;

  withTempProject("planner-pre-push-main-", (tmp) => {
    writeFakeConformanceRunner(tmp);
    const baseEnv = { ITERATIVE_PLANNER_SKILL_DIR: skillRoot };
    const nonMain = runBin("sh", [prePush], {
      cwd: tmp,
      input: "refs/heads/feature abc refs/heads/feature def\n",
      env: { ...baseEnv, TEST_IVE_CONFORMANCE_MODE: "fail" },
    });
    assert(nonMain.ok, "pre-push hook skips non-main refs even when conformance would fail");
    assert((nonMain.stdout + nonMain.stderr).includes("No main push refs detected"), "pre-push hook reports non-main skip");

    const mainPass = runBin("sh", [prePush], {
      cwd: tmp,
      input: "refs/heads/main abc refs/heads/main def\n",
      env: { ...baseEnv, TEST_IVE_CONFORMANCE_MODE: "pass" },
    });
    assert(mainPass.ok, "pre-push hook allows main push when conformance passes");
    assert((mainPass.stdout + mainPass.stderr).includes("conformance passed"), "pre-push hook reports conformance pass");

    const mainFail = runBin("sh", [prePush], {
      cwd: tmp,
      input: "refs/heads/main abc refs/heads/main def\n",
      env: { ...baseEnv, TEST_IVE_CONFORMANCE_MODE: "fail" },
    });
    assert(!mainFail.ok, "pre-push hook blocks main push when conformance is red");
    assert((mainFail.stdout + mainFail.stderr).includes("refusing push to main"), "pre-push hook explains the main-push refusal");
  });

  withTempProject("planner-pre-push-missing-runner-", (tmp) => {
    const missingRunner = runBin("sh", [prePush], {
      cwd: tmp,
      input: "refs/heads/main abc refs/heads/main def\n",
      env: { ITERATIVE_PLANNER_SKILL_DIR: skillRoot },
    });
    assert(!missingRunner.ok, "pre-push hook fails closed when the conformance runner is missing");
    assert((missingRunner.stdout + missingRunner.stderr).includes("conformance runner missing"), "pre-push hook names the missing runner");
  });
}

function scenarioInstallerManagesPrePushWithoutClobbering() {
  const installer = requireFile(
    ".agent/skills/iterative-planner/scripts/hooks/install.mjs",
    "hook installer ships"
  );
  const prePushSource = requireFile(
    ".agent/skills/iterative-planner/scripts/hooks/pre-push",
    "pre-push source is available to installer"
  );
  if (!installer || !prePushSource) return;

  withTempProject("planner-pre-push-install-", (tmp) => {
    const hookPath = join(tmp, ".git", "hooks", "pre-push");
    writeFileSync(hookPath, "#!/bin/sh\necho existing pre-push\n");
    chmodSync(hookPath, 0o755);

    const install = runBin(NODE, [installer, "pre-push"], { cwd: tmp });
    assert(install.ok, "installer accepts pre-push as a target");

    const installed = readFileSync(hookPath, "utf-8");
    assert(installed.includes("echo existing pre-push"), "installer preserves existing pre-push content");
    assert(installed.includes("pre_push_conformance.mjs"), "installer adds the planner pre-push conformance section");

    const beforeCount = (installed.match(/pre_push_conformance\.mjs/g) || []).length;
    const reinstall = runBin(NODE, [installer, "pre-push"], { cwd: tmp });
    const reinstalled = readFileSync(hookPath, "utf-8");
    const afterCount = (reinstalled.match(/pre_push_conformance\.mjs/g) || []).length;
    assert(reinstall.ok, "installer refreshes pre-push idempotently");
    assert(beforeCount === afterCount, "installer does not duplicate pre-push conformance sections");

    const uninstall = runBin(NODE, [installer, "pre-push", "--uninstall"], { cwd: tmp });
    const uninstalled = readFileSync(hookPath, "utf-8");
    assert(uninstall.ok, "installer uninstalls only the planner pre-push section");
    assert(uninstalled.includes("echo existing pre-push"), "uninstall preserves unrelated pre-push content");
    assert(!uninstalled.includes("pre_push_conformance.mjs"), "uninstall removes planner pre-push content");
  });
}

function scenarioBranchProtectionSnapshotSurface() {
  const script = requireFile(
    ".agent/skills/iterative-planner/scripts/snapshot_branch_protection.mjs",
    "branch-protection snapshot script ships"
  );
  const snapshotPath = join(plannerRoot, ".github", "branch-protection.snapshot.json");
  const snapshotExists = existsSync(snapshotPath);
  assert(snapshotExists, "branch-protection snapshot artifact ships");
  if (snapshotExists) {
    const snapshot = parseJson(readFileSync(snapshotPath, "utf-8"));
    assert(!!snapshot, "branch-protection snapshot parses as JSON");
    assert(snapshot?.repo === "stelios12312312/portable-agent-kit", "snapshot records the expected repository");
    assert(snapshot?.branch === "main", "snapshot records main");
    assert(["enforced", "not_protected", "unavailable", "error"].includes(snapshot?.status), "snapshot status is explicit");
    if (snapshot?.status !== "enforced") {
      assert(typeof snapshot?.reason === "string" && snapshot.reason.length > 0, "non-enforced snapshot records the remaining blocker");
    }
  }
  if (!script) return;

  withTempProject("planner-branch-protection-", (tmp) => {
    const fakeBin = join(tmp, "bin");
    const outputPath = join(tmp, "snapshot.json");
    writeFakeGh(fakeBin);

    const enforced = runBin(NODE, [
      script,
      "--repo",
      "owner/repo",
      "--branch",
      "main",
      "--output",
      outputPath,
      "--write",
      "--require-enforced",
    ], {
      cwd: plannerRoot,
      env: { PATH: `${fakeBin}:${process.env.PATH}`, TEST_GH_PROTECTION_MODE: "enforced" },
    });
    const enforcedJson = parseJson(enforced.stdout);
    assert(enforced.ok, "branch-protection snapshot CLI accepts an enforced protection response");
    assert(enforcedJson?.status === "enforced", "snapshot CLI classifies required IVE conformance and PR review as enforced");
    assert(existsSync(outputPath), "snapshot CLI writes the requested output path");

    const forbidden = runBin(NODE, [
      script,
      "--repo",
      "owner/repo",
      "--branch",
      "main",
      "--require-enforced",
    ], {
      cwd: plannerRoot,
      env: { PATH: `${fakeBin}:${process.env.PATH}`, TEST_GH_PROTECTION_MODE: "forbidden" },
    });
    const forbiddenJson = parseJson(forbidden.stdout);
    assert(!forbidden.ok && forbidden.status === 2, "--require-enforced exits non-zero when protection is unavailable");
    assert(forbiddenJson?.status === "unavailable", "snapshot CLI classifies GitHub 403 as unavailable, not pass");
    assert(forbiddenJson?.http_status === 403, "snapshot CLI preserves the 403 blocker");
  });
}

function scenarioIveRunnerRegistersCiEnforcementSuite() {
  const runner = readText(".agent/skills/iterative-planner/tests/ive/run.mjs");
  assert(runner.includes('id: "ci-enforcement-contracts"'), "IVE conformance runner registers the CI enforcement suite");
  assert(runner.includes("test_ci_enforcement_contracts.mjs"), "IVE conformance runner points at the CI enforcement test file");
  assert(runner.includes("snapshot_branch_protection.mjs"), "IVE conformance runner tracks branch-protection snapshot changes");
  assert(runner.includes("pre_push_conformance.mjs"), "IVE conformance runner tracks pre-push helper changes");
}

console.log("\nCI Enforcement Contract Tests\n");

scenarioIveConformanceWorkflowCoversVisualizer();
scenarioPrePushHookBlocksMainOnly();
scenarioInstallerManagesPrePushWithoutClobbering();
scenarioBranchProtectionSnapshotSurface();
scenarioIveRunnerRegistersCiEnforcementSuite();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
