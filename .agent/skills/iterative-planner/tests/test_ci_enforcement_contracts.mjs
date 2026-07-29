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
if (mode === "sleep") {
  const sleepMs = Number(process.env.TEST_IVE_CONFORMANCE_SLEEP_MS || 250);
  await new Promise((resolveSleep) => setTimeout(resolveSleep, sleepMs));
}
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

function parseWorkflowTimeout(workflow) {
  const match = workflow.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function assertWorkflowTimeout(relPath, label) {
  const workflow = readText(relPath);
  const timeout = parseWorkflowTimeout(workflow);
  assert(Number.isInteger(timeout), `${label} declares a job timeout`);
  assert(Number.isInteger(timeout) && timeout > 0 && timeout <= 20, `${label} timeout is <=20 minutes`);
}

function scenarioCiWorkflowsDeclareBoundedTimeouts() {
  assertWorkflowTimeout(".github/workflows/ive-conformance.yml", "IVE conformance workflow");
  assertWorkflowTimeout(".github/workflows/fresh-context-reviewer.yml", "fresh-context reviewer workflow");
}

function scenarioRetiredIntegrityWorkflowsAreAbsent() {
  assert(!existsSync(join(plannerRoot, ".github/workflows/persona-manifest.yml")), "retired persona-manifest workflow is absent");
  assert(!existsSync(join(plannerRoot, ".github/workflows/verify-plan-envelope.yml")), "retired plan-envelope workflow is absent");
  assert(!existsSync(join(plannerRoot, "tests/test_migration_envelope_legacy_drift.mjs")), "retired migration envelope drift root test is absent");
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
  const helperContent = readFileSync(helper, "utf-8");
  assert(helperContent.includes("DEFAULT_IVE_PRE_PUSH_TIMEOUT_MS = 720_000"), "pre-push helper declares the measured twelve-minute default budget");
  assert(helperContent.includes("process.env.IVE_PRE_PUSH_TIMEOUT_MS"), "pre-push helper retains the explicit timeout override");

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
    assert((mainFail.stdout + mainFail.stderr).includes("conformance completed non-zero"), "pre-push hook classifies a completed red conformance run");

    const mainTimeout = runBin("sh", [prePush], {
      cwd: tmp,
      input: "refs/heads/main abc refs/heads/main def\n",
      env: {
        ...baseEnv,
        TEST_IVE_CONFORMANCE_MODE: "sleep",
        TEST_IVE_CONFORMANCE_SLEEP_MS: "250",
        IVE_PRE_PUSH_TIMEOUT_MS: "25",
      },
    });
    const timeoutOutput = mainTimeout.stdout + mainTimeout.stderr;
    assert(!mainTimeout.ok, "pre-push hook fails closed when the IVE child times out");
    assert(timeoutOutput.includes("IVE infrastructure timeout"), "pre-push hook distinguishes infrastructure timeout from completed conformance failure");
    assert(timeoutOutput.includes("runner=") && timeoutOutput.includes("/tests/ive/run.mjs"), "pre-push timeout diagnostic identifies the child runner");
    assert(/pid=(?:\d+|unavailable)/.test(timeoutOutput), "pre-push timeout diagnostic identifies the child PID when available");
    assert(timeoutOutput.includes("timeout_ms=25"), "pre-push timeout diagnostic reports the configured budget");
    assert(/elapsed_ms=\d+/.test(timeoutOutput), "pre-push timeout diagnostic reports elapsed time");
    assert(timeoutOutput.includes("refusing push to main"), "pre-push timeout remains a fail-closed refusal");

    for (const invalidValue of ["invalid", "0", "-1", "1.5"]) {
      const invalidTimeout = runBin("sh", [prePush], {
        cwd: tmp,
        input: "refs/heads/main abc refs/heads/main def\n",
        env: { ...baseEnv, TEST_IVE_CONFORMANCE_MODE: "pass", IVE_PRE_PUSH_TIMEOUT_MS: invalidValue },
      });
      assert(!invalidTimeout.ok, `pre-push hook fails closed on invalid timeout override ${invalidValue}`);
      assert((invalidTimeout.stdout + invalidTimeout.stderr).includes("Invalid IVE timeout configuration"), `pre-push hook explains invalid timeout override ${invalidValue}`);
    }
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

function scenarioFreshContextReviewerWorkflowSurface() {
  const workflow = readText(".github/workflows/fresh-context-reviewer.yml");
  const config = readText(".github/reviewer/config.json");

  assert(/name:\s*fresh-context-reviewer/.test(workflow), "fresh-context reviewer workflow keeps the expected check name");
  assert(workflow.includes("pull_request:"), "fresh-context reviewer runs on pull_request");
  assert(workflow.includes("pull-requests: write"), "fresh-context reviewer can post PR comments");
  assert(workflow.includes("node .agent/skills/iterative-planner/scripts/fresh_context_reviewer.mjs review"), "workflow runs the fresh-context reviewer CLI");
  assert(workflow.includes("--config .github/reviewer/config.json"), "workflow uses reviewer config from .github/reviewer/");
  assert(workflow.includes("--comment-file reports/fresh_context_reviewer/comment.md"), "workflow asks reviewer to write a PR comment artifact");
  assert(workflow.includes("gh pr comment"), "workflow posts the reviewer comment");
  assert(workflow.includes("Enforce reviewer verdict"), "workflow has a final verdict enforcement step");
  assert(workflow.includes("steps.review.outputs.reviewer_exit"), "workflow fails with the reviewer exit code");
  assert(config.includes('"fail_honest": true'), "reviewer config declares fail_honest true");
  assert(config.includes('".github/reviewer/**"'), "reviewer config owns self-review path for reviewer config");
  assert(config.includes('"wiring_auditor"') && config.includes('"assumptions_challenger"'), "reviewer config includes required persona packs");
}

function scenarioL3AutonomousDogfoodWorkflowSurface() {
  const workflow = readText(".github/workflows/l3-autonomous-dogfood.yml");
  const runbook = readText("docs/ci/l3-autonomous-dogfood.md");

  assert(/name:\s*l3-autonomous-dogfood/.test(workflow), "L3 autonomous dogfood workflow has a distinctive check name");
  assert(workflow.includes("workflow_dispatch:"), "L3 real-run lane supports manual dispatch");
  assert(workflow.includes("schedule:") && workflow.includes("cron:"), "L3 real-run lane has a separate schedule");
  assert(!/^\s*push:\s*$/m.test(workflow) && !/^\s*pull_request:\s*$/m.test(workflow), "L3 real-run lane is absent from push and pull-request triggers");
  assert(workflow.includes("runs-on: [self-hosted, l3-agent]"), "L3 real-run lane requires the credentialed labeled runner");
  assert(workflow.includes("persist-credentials: false"), "L3 real-run lane does not expose checkout credentials to the agent workspace");
  assert(workflow.includes("inputs.agent_cmd || vars.L3_AGENT_CMD"), "L3 agent command is explicit configuration rather than a hardcoded vendor");
  assert((workflow.match(/autonomous_dogfood_run\.mjs run/g) || []).length === 1, "L3 workflow invokes the harness exactly once");
  assert(workflow.includes("continue-on-error: true") && workflow.includes("if: always()"), "L3 workflow reaches receipt upload after a failed stochastic attempt");
  assert(workflow.includes("actions/upload-artifact@v4"), "L3 workflow preserves dated receipt evidence");
  assert(workflow.includes('test "${{ steps.l3_run.outcome }}" = "success"'), "L3 workflow restores honest failed-attempt job status after upload");
  assert(runbook.includes("does not retry") && runbook.includes("must not be converted into a pass"), "L3 runbook binds the no-retry nondeterminism policy");
  assert(runbook.includes("does not prove general autonomous coding") && runbook.includes("L4 domain work"), "L3 runbook binds the fixture-scoped claim boundary");
  assert(runbook.includes("parent process") && runbook.includes("transcript text"), "L3 runbook documents independent countersign rather than self-grading");
}

function scenarioIveRunnerRegistersCiEnforcementSuite() {
  const runner = readText(".agent/skills/iterative-planner/tests/ive/run.mjs");
  assert(runner.includes('id: "ci-enforcement-contracts"'), "IVE conformance runner registers the CI enforcement suite");
  assert(runner.includes("test_ci_enforcement_contracts.mjs"), "IVE conformance runner points at the CI enforcement test file");
  assert(runner.includes('id: "pack-contract"'), "IVE conformance runner registers the pack contract suite");
  assert(runner.includes("test_pack_contract.mjs"), "IVE conformance runner points at the pack contract test file");
  assert(runner.includes("pack_contract_validate.mjs"), "IVE conformance runner tracks the pack contract validator CLI");
  assert(runner.includes("pack_contract.schema.json"), "IVE conformance runner tracks the pack contract schema");
  assert(runner.includes("packs/quant/pack_contract.json"), "IVE conformance runner tracks the quant pack contract");
  assert(!runner.includes("verify-plan-envelope.yml"), "IVE CI enforcement suite no longer tracks the retired envelope workflow");
  assert(!runner.includes("persona-manifest.yml"), "IVE CI enforcement suite no longer tracks the retired persona manifest workflow");
  assert(runner.includes('id: "fresh-context-reviewer"'), "IVE conformance runner registers the fresh-context reviewer suite");
  assert(runner.includes("test_fresh_context_reviewer.mjs"), "IVE conformance runner points at the fresh-context reviewer tests");
  assert(runner.includes("fresh_context_reviewer.mjs"), "IVE conformance runner tracks the fresh-context reviewer CLI and library");
  assert(runner.includes("fresh-context-reviewer.yml"), "IVE conformance runner tracks the fresh-context reviewer workflow");
  assert(runner.includes('id: "l3-autonomous-dogfood-harness"'), "IVE runner registers required deterministic L3 harness self-tests");
  assert(runner.includes('id: "l3-autonomous-dogfood-receipt-freshness"'), "IVE runner registers separate L3 receipt freshness advisory");
  assert(runner.includes("l3-autonomous-dogfood.yml"), "IVE runner tracks the separate L3 real-run workflow");
  assert(runner.includes(".github/reviewer/config.json"), "IVE conformance runner tracks reviewer config");
  assert(!runner.includes("test_migration_envelope_legacy_drift.mjs"), "IVE CI enforcement suite no longer tracks the retired migration envelope drift test");
  assert(runner.includes("test_escalation_triggers.mjs"), "IVE CI enforcement suite tracks escalation trigger tests");
  assert(runner.includes("test_loop_guards.mjs"), "IVE CI enforcement suite tracks loop guard tests");
  assert(runner.includes("snapshot_branch_protection.mjs"), "IVE conformance runner tracks branch-protection snapshot changes");
  assert(runner.includes("pre_push_conformance.mjs"), "IVE conformance runner tracks pre-push helper changes");
  assert(runner.includes('id: "ive-conformance-runner-meta"'), "IVE conformance runner registers its meta-test as a default suite");
  assert(runner.includes("test_ive_conformance_runner.mjs"), "IVE conformance runner meta-suite points at the runner meta-test");
}

console.log("\nCI Enforcement Contract Tests\n");

scenarioIveConformanceWorkflowCoversVisualizer();
scenarioCiWorkflowsDeclareBoundedTimeouts();
scenarioRetiredIntegrityWorkflowsAreAbsent();
scenarioPrePushHookBlocksMainOnly();
scenarioInstallerManagesPrePushWithoutClobbering();
scenarioBranchProtectionSnapshotSurface();
scenarioFreshContextReviewerWorkflowSurface();
scenarioL3AutonomousDogfoodWorkflowSurface();
scenarioIveRunnerRegistersCiEnforcementSuite();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
