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
  symlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createHash } from "crypto";

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
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const mode = process.env.TEST_IVE_CONFORMANCE_MODE || "pass";
if (mode === "sleep") {
  const sleepMs = Number(process.env.TEST_IVE_CONFORMANCE_SLEEP_MS || 250);
  await new Promise((resolveSleep) => setTimeout(resolveSleep, sleepMs));
}

if (mode === "spawn_descendant_and_sleep") {
  const descendant = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(process.env.TEST_IVE_SURVIVOR_MARKER, String(process.pid)), 250); setTimeout(() => process.exit(0), 500);",
  ], { env: process.env, stdio: "ignore" });
  writeFileSync(process.env.TEST_IVE_SURVIVOR_PID, String(descendant.pid));
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000));
}

if (mode === "spawn_detached_descendant_and_sleep") {
  const descendant = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    "import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); setTimeout(() => writeFileSync(process.env.TEST_IVE_SURVIVOR_MARKER, String(process.pid)), 900); setTimeout(() => process.exit(0), 1400);",
  ], { detached: true, env: process.env, stdio: "ignore" });
  writeFileSync(process.env.TEST_IVE_SURVIVOR_PID, String(descendant.pid));
  const onParentTerm = () => {
    try { process.kill(-descendant.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(-descendant.pid, "SIGKILL"); } catch {}
      process.removeListener("SIGTERM", onParentTerm);
      process.kill(process.pid, "SIGTERM");
    }, 500);
  };
  process.on("SIGTERM", onParentTerm);
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000));
}

async function emitFailure(report) {
  await new Promise((resolveWrite) => {
    process.stdout.write(\`\${JSON.stringify(report)}\\n\`, resolveWrite);
  });
  process.exit(1);
}

if (mode === "authoritative_fail") {
  const manifestPath = "reports/ive/test_runs/fake-refusal/manifest.json";
  const manifest = join(process.cwd(), manifestPath);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ overall_status: "fail" }));
  await emitFailure({
    padding: "x".repeat(1400),
    status: "FAIL",
    issues: [
      { suite_id: "suite-z" },
      { suite_id: "suite-z" },
    ],
    results: [
      { id: "suite-a", status: "TIMEOUT" },
      { id: "suite-missing-status" },
      { id: "suite-pass", status: "PASS" },
      { id: "suite-warn", status: "WARN" },
      { id: "suite-skipped", status: "SKIPPED" },
    ],
    checks: [
      { id: "suite-m", status: "NOT_IMPLEMENTED_YET" },
      { id: "suite-not-applicable", status: "NOT_APPLICABLE" },
      { id: "suite-unknown", status: "ALIEN" },
      { id: "suite-z", status: "FAIL" },
    ],
    manifest_path: manifestPath,
  });
}

if (mode === "malformed_runner_json") {
  await new Promise((resolveWrite) => {
    process.stdout.write("{not-json\\n", resolveWrite);
  });
  process.exit(1);
}

if (mode === "missing_manifest_path") {
  await emitFailure({ status: "FAIL", issues: [{ suite_id: "suite-a" }] });
}

if (mode === "missing_manifest_file") {
  await emitFailure({
    status: "FAIL",
    issues: [{ suite_id: "suite-a" }],
    manifest_path: "reports/ive/test_runs/missing/manifest.json",
  });
}

if (mode === "outside_manifest") {
  await emitFailure({
    status: "FAIL",
    issues: [{ suite_id: "suite-a" }],
    manifest_path: process.env.TEST_IVE_MANIFEST_PATH,
  });
}

if (mode === "directory_manifest") {
  const manifestPath = "reports/ive/test_runs/fake-directory";
  mkdirSync(join(process.cwd(), manifestPath), { recursive: true });
  await emitFailure({
    status: "FAIL",
    issues: [{ suite_id: "suite-a" }],
    manifest_path: manifestPath,
  });
}

if (mode === "symlink_manifest") {
  await emitFailure({
    status: "FAIL",
    issues: [{ suite_id: "suite-a" }],
    manifest_path: process.env.TEST_IVE_MANIFEST_PATH,
  });
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

function occurrenceCount(text, needle) {
  return String(text).split(needle).length - 1;
}

function scenarioHostedActionsSurfacesAreRetired() {
  assert(
    !existsSync(join(plannerRoot, ".github/workflows/ive-conformance.yml")),
    "retired hosted IVE conformance workflow is absent"
  );
  assert(
    !existsSync(join(plannerRoot, ".github/workflows/fresh-context-reviewer.yml")),
    "retired hosted fresh-context reviewer workflow is absent"
  );
}

function scenarioLocalEnforcementReplacementSurface() {
  const cleanCheckout = requireFile(
    ".agent/skills/iterative-planner/scripts/clean_checkout_conformance.mjs",
    "A5 clean-checkout conformance script ships"
  );
  const profiles = JSON.parse(readText(".agent/skills/iterative-planner/config/ive_release_profiles.json"));
  const release = readText(".agent/workflows/release.md");
  const prePush = readText(".agent/skills/iterative-planner/scripts/hooks/pre-push");

  assert(Boolean(profiles?.profiles?.["core-release"]), "governed core-release profile ships");
  assert(
    Boolean(cleanCheckout) && release.includes("clean_checkout_conformance.mjs --ref HEAD") && release.includes("--require-profile core-release"),
    "release workflow binds exact-revision clean-checkout proof to core-release"
  );
  assert(
    prePush.includes("pre_push_conformance.mjs") && prePush.includes("exit $?"),
    "managed pre-push hook delegates to fail-closed local conformance"
  );
}

function scenarioActiveContractsUseLocalAuthority() {
  const activeContracts = [
    "docs/ive-redesign/17_release_lane.md",
    ".agent/skills/iterative-planner/SKILL.md",
    ".agent/skills/iterative-planner/references/file-formats.md",
    ".agent/skills/iterative-planner/scripts/pre_commit_policy.mjs",
    ".agent/workflows/release.md",
  ].map((relPath) => readText(relPath)).join("\n");
  const portabilityRecipe = readText("docs/ci/github_actions.md");

  assert(!activeContracts.includes(".github/workflows/ive-conformance.yml"), "active contracts do not cite the retired hosted IVE workflow");
  assert(!activeContracts.includes(".github/workflows/fresh-context-reviewer.yml"), "active contracts do not cite the retired hosted reviewer workflow");
  assert(!activeContracts.includes("envelope CI remain authoritative"), "active contracts do not call envelope CI authoritative");
  assert(
    portabilityRecipe.includes("optional portability recipe") && portabilityRecipe.includes("not this repository's enforcement authority"),
    "GitHub Actions recipe declares its optional non-authoritative boundary"
  );
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
  assert(helperContent.includes("DEFAULT_IVE_PRE_PUSH_TIMEOUT_MS = 900_000"), "pre-push helper preserves the governed measured fifteen-minute default budget");
  assert(helperContent.includes("process.env.IVE_PRE_PUSH_TIMEOUT_MS"), "pre-push helper retains the explicit timeout override");
  assert(helperContent.includes("git\", [") && helperContent.includes("--changed-files") && helperContent.includes("trusted_ref_diff"), "pre-push helper scopes trustworthy main updates through the governed IVE changed-file selector");
  assert(helperContent.includes("invalid_ref_boundary") && helperContent.includes("git_diff_unavailable") && helperContent.includes("new_main_ref"), "pre-push helper retains explicit full-catalog fallback reasons for uncertain Git boundaries");
  const parentGitRoutingKeys = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_WORK_TREE",
  ];
  assert(
    helperContent.includes("isolatedChildEnv()")
      && parentGitRoutingKeys.every((key) => helperContent.includes(`"${key}"`)),
    "pre-push helper strips every parent Git routing variable before the IVE child starts",
  );

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

    const authoritativeFail = runBin("sh", [prePush], {
      cwd: tmp,
      input: "refs/heads/main abc refs/heads/main def\n",
      env: { ...baseEnv, TEST_IVE_CONFORMANCE_MODE: "authoritative_fail" },
    });
    const authoritativeOutput = authoritativeFail.stdout + authoritativeFail.stderr;
    const failingSuiteLine = authoritativeOutput
      .split(/\r?\n/)
      .find((line) => line.includes("failing_suite_ids=")) ?? "";
    const failingSuiteIds = failingSuiteLine
      .slice(failingSuiteLine.indexOf("failing_suite_ids=") + "failing_suite_ids=".length)
      .split(",");
    const expectedManifestPath = "reports/ive/test_runs/fake-refusal/manifest.json";
    assert(!authoritativeFail.ok, "pre-push hook retains refusal for an authoritative structured red run");
    assert(
      authoritativeOutput.includes(
        "failing_suite_ids=suite-a,suite-m,suite-missing-status,suite-unknown,suite-z"
      ),
      "pre-push hook prints every mixed-source failing suite in stable lexical order"
    );
    assert(
      occurrenceCount(authoritativeOutput, "failing_suite_ids=") === 1,
      "pre-push hook prints exactly one structured failing-suite line"
    );
    for (const suiteId of [
      "suite-a",
      "suite-m",
      "suite-missing-status",
      "suite-unknown",
      "suite-z",
    ]) {
      assert(
        failingSuiteIds.filter((id) => id === suiteId).length === 1,
        `pre-push hook prints ${suiteId} exactly once after stable deduplication`
      );
    }
    for (const advisorySuiteId of [
      "suite-warn",
      "suite-skipped",
      "suite-not-applicable",
    ]) {
      assert(
        failingSuiteIds.filter((id) => id === advisorySuiteId).length === 0,
        `pre-push hook does not misclassify ${advisorySuiteId} as a hard failure`
      );
    }
    assert(
      authoritativeOutput.includes("failure_authority=available"),
      "pre-push hook marks verified failure authority available"
    );
    assert(
      authoritativeOutput.includes(`manifest_path=${expectedManifestPath}`),
      "pre-push hook prints the verified repository-relative manifest path"
    );
    assert(
      occurrenceCount(authoritativeOutput, "manifest_path=") === 1,
      "pre-push hook prints exactly one verified manifest-path line"
    );
    assert(
      existsSync(join(tmp, expectedManifestPath)),
      "authoritative refusal manifest exists as a regular in-repository artifact"
    );
    assert(
      authoritativeOutput.includes("refusing push to main"),
      "authoritative structured diagnostics do not weaken refusal"
    );

    const unavailableCases = [
      {
        mode: "malformed_runner_json",
        reason: "invalid_runner_json",
        label: "malformed runner JSON",
      },
      {
        mode: "missing_manifest_path",
        reason: "missing_manifest_path",
        label: "missing manifest path",
      },
      {
        mode: "missing_manifest_file",
        reason: "manifest_missing",
        label: "missing manifest file",
      },
      {
        mode: "directory_manifest",
        reason: "manifest_not_a_file",
        label: "manifest directory",
      },
    ];

    for (const unavailableCase of unavailableCases) {
      const unavailable = runBin("sh", [prePush], {
        cwd: tmp,
        input: "refs/heads/main abc refs/heads/main def\n",
        env: { ...baseEnv, TEST_IVE_CONFORMANCE_MODE: unavailableCase.mode },
      });
      const unavailableOutput = unavailable.stdout + unavailable.stderr;
      assert(!unavailable.ok, `pre-push hook fails closed for ${unavailableCase.label}`);
      assert(
        unavailableOutput.includes(`failure_authority=unavailable reason=${unavailableCase.reason}`),
        `pre-push hook names ${unavailableCase.reason} for ${unavailableCase.label}`
      );
      assert(
        !unavailableOutput.includes("manifest_path="),
        `pre-push hook does not print a verified manifest path for ${unavailableCase.label}`
      );
      assert(
        unavailableOutput.includes("refusing push to main"),
        `pre-push hook retains refusal for ${unavailableCase.label}`
      );
    }

    const outsideManifest = `${tmp}-outside-manifest.json`;
    writeFileSync(outsideManifest, JSON.stringify({ overall_status: "fail" }));
    try {
      const relativeOutsideManifest = relative(tmp, outsideManifest);
      const relativeTraversal = runBin("sh", [prePush], {
        cwd: tmp,
        input: "refs/heads/main abc refs/heads/main def\n",
        env: {
          ...baseEnv,
          TEST_IVE_CONFORMANCE_MODE: "outside_manifest",
          TEST_IVE_MANIFEST_PATH: relativeOutsideManifest,
        },
      });
      const relativeTraversalOutput = relativeTraversal.stdout + relativeTraversal.stderr;
      assert(!relativeTraversal.ok, "pre-push hook fails closed for a relative traversal manifest");
      assert(
        relativeTraversalOutput.includes("failure_authority=unavailable reason=manifest_outside_repository"),
        "pre-push hook names relative traversal outside-repository manifest authority"
      );
      assert(
        !relativeTraversalOutput.includes(`manifest_path=${relativeOutsideManifest}`),
        "pre-push hook never labels a relative traversal manifest as verified"
      );

      const outside = runBin("sh", [prePush], {
        cwd: tmp,
        input: "refs/heads/main abc refs/heads/main def\n",
        env: {
          ...baseEnv,
          TEST_IVE_CONFORMANCE_MODE: "outside_manifest",
          TEST_IVE_MANIFEST_PATH: outsideManifest,
        },
      });
      const outsideOutput = outside.stdout + outside.stderr;
      assert(!outside.ok, "pre-push hook fails closed for a real outside manifest");
      assert(
        outsideOutput.includes("failure_authority=unavailable reason=manifest_outside_repository"),
        "pre-push hook names lexical outside-repository manifest authority"
      );
      assert(
        !outsideOutput.includes(`manifest_path=${outsideManifest}`),
        "pre-push hook never labels the outside manifest as verified"
      );

      const symlinkRel = "reports/ive/test_runs/symlink-escape/manifest.json";
      const symlinkPath = join(tmp, symlinkRel);
      mkdirSync(dirname(symlinkPath), { recursive: true });
      symlinkSync(outsideManifest, symlinkPath);
      const symlinkEscape = runBin("sh", [prePush], {
        cwd: tmp,
        input: "refs/heads/main abc refs/heads/main def\n",
        env: {
          ...baseEnv,
          TEST_IVE_CONFORMANCE_MODE: "symlink_manifest",
          TEST_IVE_MANIFEST_PATH: symlinkRel,
        },
      });
      const symlinkOutput = symlinkEscape.stdout + symlinkEscape.stderr;
      assert(!symlinkEscape.ok, "pre-push hook fails closed for an in-repository symlink escape");
      assert(
        symlinkOutput.includes("failure_authority=unavailable reason=manifest_outside_repository"),
        "pre-push hook names canonical symlink escape as outside repository"
      );
      assert(
        !symlinkOutput.includes(`manifest_path=${symlinkRel}`),
        "pre-push hook never labels a symlink escape as verified"
      );
    } finally {
      rmSync(outsideManifest, { force: true });
    }

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

    const survivorMarker = join(tmp, "pre-push-timeout-survivor.marker");
    const survivorPidPath = join(tmp, "pre-push-timeout-survivor.pid");
    const descendantTimeout = runBin("sh", [prePush], {
      cwd: tmp,
      input: "refs/heads/main abc refs/heads/main def\n",
      env: {
        ...baseEnv,
        TEST_IVE_CONFORMANCE_MODE: "spawn_descendant_and_sleep",
        TEST_IVE_SURVIVOR_MARKER: survivorMarker,
        TEST_IVE_SURVIVOR_PID: survivorPidPath,
        IVE_PRE_PUSH_TIMEOUT_MS: "150",
      },
    });
    execFileSync(NODE, ["--eval", "setTimeout(() => {}, 400)"]);
    const survivorPid = existsSync(survivorPidPath)
      ? Number.parseInt(readFileSync(survivorPidPath, "utf-8"), 10)
      : null;
    let survivorAlive = false;
    if (Number.isInteger(survivorPid)) {
      try {
        process.kill(survivorPid, 0);
        survivorAlive = true;
      } catch (error) {
        survivorAlive = error?.code !== "ESRCH";
      }
    }
    assert(!descendantTimeout.ok, "pre-push hook refuses after timing out a runner with an owned descendant");
    assert(Number.isInteger(survivorPid), "pre-push timeout fixture launched the runner descendant");
    assert(!existsSync(survivorMarker) && !survivorAlive, "pre-push timeout cleans the complete runner process group before returning");

    const detachedMarker = join(tmp, "pre-push-timeout-detached.marker");
    const detachedPidPath = join(tmp, "pre-push-timeout-detached.pid");
    const detachedTimeout = runBin("sh", [prePush], {
      cwd: tmp,
      input: "refs/heads/main abc refs/heads/main def\n",
      env: {
        ...baseEnv,
        TEST_IVE_CONFORMANCE_MODE: "spawn_detached_descendant_and_sleep",
        TEST_IVE_SURVIVOR_MARKER: detachedMarker,
        TEST_IVE_SURVIVOR_PID: detachedPidPath,
        IVE_PRE_PUSH_TIMEOUT_MS: "150",
      },
    });
    execFileSync(NODE, ["--eval", "setTimeout(() => {}, 1000)"]);
    const detachedPid = existsSync(detachedPidPath)
      ? Number.parseInt(readFileSync(detachedPidPath, "utf-8"), 10)
      : null;
    let detachedAlive = false;
    if (Number.isInteger(detachedPid)) {
      try {
        process.kill(detachedPid, 0);
        detachedAlive = true;
      } catch (error) {
        detachedAlive = error?.code !== "ESRCH";
      }
    }
    assert(!detachedTimeout.ok, "pre-push hook refuses after timing out a runner with a detached wave child");
    assert(Number.isInteger(detachedPid), "pre-push timeout fixture launched the detached wave child");
    assert(!existsSync(detachedMarker) && !detachedAlive, "pre-push grace lets the runner reap detached wave groups before returning");

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
    "optional branch-protection diagnostic script ships"
  );
  const snapshotPath = join(plannerRoot, ".github", "branch-protection.snapshot.json");
  const snapshotExists = existsSync(snapshotPath);
  assert(snapshotExists, "optional branch-protection diagnostic artifact ships");
  if (snapshotExists) {
    const snapshot = parseJson(readFileSync(snapshotPath, "utf-8"));
    assert(!!snapshot, "branch-protection snapshot parses as JSON");
    assert(snapshot?.repo === "stelios12312312/portable-agent-kit", "snapshot records the expected repository");
    assert(snapshot?.branch === "main", "snapshot records main");
    assert(["enforced", "not_protected", "unavailable", "error"].includes(snapshot?.status), "snapshot status is explicit");
    if (snapshot?.status !== "enforced") {
      assert(snapshot?.reason?.includes("does not block or satisfy"), "unavailable remote diagnostic is explicitly non-authoritative");
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
    assert(enforced.ok, "branch-protection diagnostic accepts an observed protection response");
    assert(enforcedJson?.status === "enforced", "diagnostic classifies the legacy IVE context and PR review without promoting it to local authority");
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

function scenarioFreshContextReviewerLocalSurface() {
  const config = readText(".github/reviewer/config.json");
  const cli = requireFile(
    ".agent/skills/iterative-planner/scripts/fresh_context_reviewer.mjs",
    "fresh-context reviewer local CLI ships"
  );

  assert(Boolean(cli), "fresh-context reviewer remains locally executable after hosted trigger retirement");
  assert(config.includes('"fail_honest": true'), "reviewer config declares fail_honest true");
  assert(config.includes('".github/reviewer/**"'), "reviewer config owns self-review path for reviewer config");
  assert(!config.includes('".github/workflows/fresh-context-reviewer.yml"'), "reviewer config does not self-own the retired hosted trigger");
  assert(config.includes('"wiring_auditor"') && config.includes('"assumptions_challenger"'), "reviewer config includes required persona packs");
}

function scenarioL3AutonomousDogfoodWorkflowSurface() {
  const workflowPath = join(plannerRoot, ".github/workflows/l3-autonomous-dogfood.yml");
  const workflowsDir = join(plannerRoot, ".github/workflows");
  const workflowsExist = existsSync(workflowsDir) && readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).length > 0;
  assert(!existsSync(workflowPath), "L3 autonomous dogfood workflow is absent from GitHub Actions");
  assert(!workflowsExist, "GitHub workflows directory contains zero hosted CI workflow files");

  const runbook = readText("docs/ci/l3-autonomous-dogfood.md");
  assert(runbook.includes("does not retry") && runbook.includes("must not be converted into a pass"), "L3 runbook binds the no-retry nondeterminism policy");
  assert(runbook.includes("does not prove general autonomous coding") && runbook.includes("L4 domain work"), "L3 runbook binds the fixture-scoped claim boundary");
  assert(runbook.includes("parent process") && runbook.includes("transcript text"), "L3 runbook documents independent countersign rather than self-grading");
}

function scenarioIveRunnerRegistersCiEnforcementSuite() {
  const runner = readText(".agent/skills/iterative-planner/tests/ive/run.mjs");
  const ciStart = runner.indexOf('id: "ci-enforcement-contracts"');
  const reviewerStart = runner.indexOf('id: "fresh-context-reviewer"');
  const reviewerEnd = runner.indexOf("\n  suite({", reviewerStart + 1);
  const ciBlock = runner.slice(ciStart, reviewerStart);
  const reviewerBlock = runner.slice(reviewerStart, reviewerEnd);
  const ciFixtures = ciBlock.slice(ciBlock.indexOf("fixtures:"), ciBlock.indexOf("changedFilePatterns:"));
  const reviewerFixtures = reviewerBlock.slice(reviewerBlock.indexOf("fixtures:"), reviewerBlock.indexOf("changedFilePatterns:"));
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
  assert(!ciFixtures.includes("ive-conformance.yml"), "CI enforcement suite does not require the retired hosted IVE workflow as a fixture");
  assert(!reviewerFixtures.includes("fresh-context-reviewer.yml"), "fresh-context reviewer suite does not require its retired hosted workflow as a fixture");
  assert(ciBlock.includes("ive-conformance\\.yml") && ciBlock.includes("fresh-context-reviewer\\.yml"), "CI enforcement changed-path routing catches restoration of either retired hosted workflow");
  assert(runner.includes('id: "l3-autonomous-dogfood-harness"'), "IVE runner registers required deterministic L3 harness self-tests");
  assert(runner.includes('id: "l3-autonomous-dogfood-receipt-freshness"'), "IVE runner registers separate L3 receipt freshness advisory");
  assert(!runner.includes(".github/workflows/l3-autonomous-dogfood.yml"), "IVE runner does not require retired L3 GitHub Actions workflow as fixture");
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

scenarioHostedActionsSurfacesAreRetired();
scenarioLocalEnforcementReplacementSurface();
scenarioActiveContractsUseLocalAuthority();
scenarioRetiredIntegrityWorkflowsAreAbsent();
scenarioPrePushHookBlocksMainOnly();
scenarioInstallerManagesPrePushWithoutClobbering();
scenarioBranchProtectionSnapshotSurface();
scenarioFreshContextReviewerLocalSurface();
scenarioL3AutonomousDogfoodWorkflowSurface();
scenarioIveRunnerRegistersCiEnforcementSuite();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
