#!/usr/bin/env node
// @planner:module clean_checkout_conformance_test
// @planner:proves US-PM-AUTO-180

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..", "..");
const CLI = join(REPO_ROOT, ".agent", "skills", "iterative-planner", "scripts", "clean_checkout_conformance.mjs");
const RUNNER = join(TEST_DIR, "ive", "run.mjs");
const NODE = process.execPath;
const fixtureRoot = mkdtempSync(join(tmpdir(), "clean checkout conformance-"));

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function cleanGitEnvironment(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function git(args, cwd = fixtureRoot) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: cleanGitEnvironment(),
  }).trim();
}

function write(relativePath, content) {
  const target = join(fixtureRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fakeProbe(body) {
  return `#!/usr/bin/env node\n${body}\n`;
}

function parseJson(stdout) {
  const text = String(stdout || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runCli(ref, extraEnv = {}, extraArgs = []) {
  const result = spawnSync(NODE, [CLI, "--repo", fixtureRoot, "--ref", ref, ...extraArgs, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30000,
    env: { ...cleanGitEnvironment(), ...extraEnv },
  });
  return {
    ...result,
    receipt: parseJson(result.stdout),
  };
}

function runTextCli(ref, extraArgs = []) {
  return spawnSync(NODE, [CLI, "--repo", fixtureRoot, "--ref", ref, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30000,
    env: cleanGitEnvironment(),
  });
}

function profileManifest(targetSha, overrides = {}) {
  const suite = {
    id: "fixture-proof",
    status: "pass",
    required: true,
  };
  return {
    schema_version: 1,
    run_id: "fixture-core-release",
    overall_status: "pass",
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      warned: 0,
      skipped: 0,
      not_applicable: 0,
      not_implemented: 0,
    },
    suites: [suite],
    issues: [],
    profile: {
      id: "core-release",
      selected_suite_ids: [suite.id],
      selected_suite_count: 1,
      explicit_exclusion_count: 0,
      omitted_by_rule_count: 0,
      catalog_suite_count: 1,
    },
    repo_state_stamp: {
      head_sha: targetSha,
      dirty: false,
    },
    ...overrides,
  };
}

function runProfileCli(ref, fileName, payload, requiredProfile = "core-release") {
  const manifestPath = `reports/${fileName}`;
  if (typeof payload === "string") write(manifestPath, payload);
  else if (payload !== null) write(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  return runCli(ref, {}, [
    "--profile-manifest", manifestPath,
    "--require-profile", requiredProfile,
  ]);
}

function runProfileTextCli(ref, fileName, payload, requiredProfile = "core-release") {
  const manifestPath = `reports/${fileName}`;
  write(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  return runTextCli(ref, [
    "--profile-manifest", manifestPath,
    "--require-profile", requiredProfile,
  ]);
}

function seedFixture() {
  git(["init", "-q"]);
  git(["config", "user.email", "clean-checkout@example.invalid"]);
  git(["config", "user.name", "Clean Checkout Test"]);

  write(".agent/skills/iterative-planner/scripts/story_registry.mjs", fakeProbe(`
import { existsSync } from "node:fs";
const authorityLeak = [
  "_PLANNER_GATE_TRANSITION",
  "_PLANNER_FAST_TRACK",
  "_PLANNER_THREAD_ID",
  "PLANNER_PROJECT_REGISTRY_PATH",
  "PLANNER_REMOTE_MODE",
  "CODEX_THREAD_ID",
].some((key) => Boolean(process.env[key]));
const red = !existsSync("evidence.ok") || authorityLeak;
console.log(JSON.stringify({
  status: red ? "FAIL" : "PASS",
  storyCount: 1,
  errors: red ? [authorityLeak ? "seeded authority leak" : "seeded missing proof"] : [],
  warnings: [],
}));
process.exitCode = red ? 1 : 0;`));

  write(".agent/skills/iterative-planner/scripts/rule_engine.mjs", fakeProbe(`
console.log(JSON.stringify({ status: "PASS", count: 0, violations: [], warnings: [] }));`));

  write(".agent/skills/iterative-planner/scripts/planner_findings.mjs", fakeProbe(`
import { existsSync } from "node:fs";
const red = !existsSync("evidence.ok");
console.log(JSON.stringify({
  status: red ? "ADVISORY" : "PASS",
  iv_consistency_bridge: {
    status: red ? "ADVISORY" : "PASS",
    canonical_story_registry: {
      status: red ? "FAIL" : "PASS",
      error_count: red ? 1 : 0,
    },
    invariant_only: { status: "PASS", violation_count: 0 },
    disagreement_count: red ? 1 : 0,
  },
}));`));

  write(".agent/skills/iterative-planner/scripts/project_health.mjs", fakeProbe(`
import { existsSync, writeFileSync } from "node:fs";
const red = !existsSync("evidence.ok");
if (process.env.CLEAN_CHECKOUT_TEST_MUTATE_IGNORED === "1") {
  writeFileSync(".probe-cache", "seeded ignored mutation\\n");
}
console.log(JSON.stringify({
  status: red ? "FAIL" : "PASS",
  summary: { fail: red ? 1 : 0, warn: 0, pass: red ? 0 : 1 },
}));
process.exitCode = red ? 1 : 0;`));

  write(".gitignore", ".probe-cache\n");

  git(["add", "."]);
  git(["commit", "-qm", "seed red canonical health"]);
  const redSha = git(["rev-parse", "HEAD"]);

  write("evidence.ok", "portable proof\n");
  git(["add", "evidence.ok"]);
  git(["commit", "-qm", "seed green canonical health"]);
  return { redSha, greenSha: git(["rev-parse", "HEAD"]) };
}

console.log("\nClean Checkout Conformance Tests\n");

try {
  const { redSha, greenSha } = seedFixture();

  assert(existsSync(CLI), "clean-checkout CLI exists");

  const red = runCli(redSha);
  assert(red.status === 1, "seeded red commit exits non-zero");
  assert(red.receipt?.status === "FAIL", "seeded red receipt is FAIL");
  assert(red.receipt?.release_authority === false, "failed unbound receipt is not release authority");
  assert(red.receipt?.target_sha === redSha, "red receipt binds the exact target SHA");
  assert(red.receipt?.checks?.canonical_story_registry?.error_count === 1, "red receipt preserves canonical error count");
  assert(red.receipt?.checks?.ontology_invariants?.violation_count === 0, "red receipt preserves narrower invariant PASS");
  assert(red.receipt?.iv_consistency?.disagreement === true, "red receipt makes canonical/invariant disagreement explicit");
  assert(red.receipt?.post_run_clean === true, "red target remains clean");
  assert(red.receipt?.cleanup?.status === "PASS", "red worktree cleanup passes");

  const green = runCli(greenSha);
  assert(green.status === 0, "seeded green commit exits zero");
  assert(green.receipt?.status === "PASS", "seeded green receipt is PASS");
  assert(green.receipt?.release_authority === false, "passing unbound receipt is not release authority");
  assert(green.receipt?.target_sha === greenSha, "green receipt binds the exact target SHA");
  assert(green.receipt?.checks?.canonical_story_registry?.status === "PASS", "green canonical story check passes");
  assert(green.receipt?.checks?.ontology_invariants?.status === "PASS", "green invariant check passes");
  assert(green.receipt?.checks?.planner_findings?.status === "PASS", "green findings bridge passes");
  assert(green.receipt?.checks?.project_health?.status === "PASS", "green project health passes");
  assert(green.receipt?.iv_consistency?.disagreement === false, "green receipt has no masked disagreement");

  const governedGreen = runProfileCli(greenSha, "profile-green.json", profileManifest(greenSha));
  assert(governedGreen.status === 0, "same-SHA governed profile exits zero");
  assert(governedGreen.receipt?.checks?.governed_profile?.status === "PASS", "same-SHA governed profile check passes");
  assert(governedGreen.receipt?.governed_profile?.manifest_sha256?.length === 64, "receipt records governed profile manifest hash");
  assert(governedGreen.receipt?.release_authority === true, "passing governed receipt is release authority");

  const unboundText = runTextCli(greenSha);
  assert(unboundText.status === 0, "unbound text mode preserves conformance exit status");
  assert(unboundText.stdout.includes("NOT-RELEASE-AUTHORITY"), "unbound text mode prints the non-authority banner");

  const governedText = runProfileTextCli(greenSha, "profile-green-text.json", profileManifest(greenSha));
  assert(governedText.status === 0, "governed text mode preserves conformance exit status");
  assert(!governedText.stdout.includes("NOT-RELEASE-AUTHORITY"), "governed text mode does not print the non-authority banner");

  const governedFailed = runProfileCli(greenSha, "profile-failed.json", profileManifest(greenSha, {
    overall_status: "fail",
  }));
  assert(governedFailed.status !== 0, "failed governed profile fails closed");
  assert(governedFailed.receipt?.failure_stage === "governed_profile_manifest", "failed profile names the governed manifest stage");

  const governedStale = runProfileCli(greenSha, "profile-stale.json", profileManifest(redSha));
  assert(governedStale.status !== 0, "stale-SHA governed profile fails closed");
  assert(governedStale.receipt?.checks?.governed_profile?.errors?.some((entry) => entry.includes("target_sha")), "stale profile explains the SHA mismatch");

  const governedWrongProfile = runProfileCli(greenSha, "profile-wrong-id.json", profileManifest(greenSha), "not-core-release");
  assert(governedWrongProfile.status !== 0, "wrong governed profile ID fails closed");

  const governedMalformed = runProfileCli(greenSha, "profile-malformed.json", "{ definitely not json\n");
  assert(governedMalformed.status !== 0, "malformed governed profile fails closed");

  const governedMissing = runProfileCli(greenSha, "profile-missing.json", null);
  assert(governedMissing.status !== 0, "missing governed profile fails closed");

  const hostileEnvironment = runCli(greenSha, {
    _PLANNER_GATE_TRANSITION: "1",
    _PLANNER_FAST_TRACK: "1",
    _PLANNER_THREAD_ID: "hostile-parent-thread",
    PLANNER_PROJECT_REGISTRY_PATH: "/tmp/hostile-project-registry.json",
    PLANNER_REMOTE_MODE: "remote-sync",
    CODEX_THREAD_ID: "hostile-parent-codex-thread",
  });
  assert(hostileEnvironment.status === 0, "hostile parent planner authority is neutralized");
  assert(hostileEnvironment.receipt?.status === "PASS", "authority-isolated receipt remains PASS");

  const hostileGitEnvironment = runCli(greenSha, {
    GIT_DIR: "/tmp/hostile-git-dir",
    GIT_WORK_TREE: "/tmp/hostile-git-work-tree",
    GIT_INDEX_FILE: ".git/index",
  });
  assert(hostileGitEnvironment.status === 0, "hostile parent Git repository authority is neutralized");
  assert(hostileGitEnvironment.receipt?.status === "PASS", "Git-environment-isolated receipt remains PASS");

  const ignoredMutation = runCli(greenSha, {
    CLEAN_CHECKOUT_TEST_MUTATE_IGNORED: "1",
  });
  assert(ignoredMutation.status !== 0, "ignored probe mutation fails closed");
  assert(ignoredMutation.receipt?.post_run_clean === false, "ignored mutation is visible to cleanliness proof");

  const invalid = runCli("definitely-not-a-ref");
  assert(invalid.status !== 0, "invalid ref fails closed");
  assert(invalid.receipt?.status === "FAIL", "invalid-ref receipt is machine-readable");
  assert(invalid.receipt?.failure_stage === "resolve_ref", "invalid-ref receipt names the failing stage");

  const worktrees = git(["worktree", "list", "--porcelain"]);
  assert((worktrees.match(/^worktree /gm) || []).length === 1, "no detached fixture worktree leaks");

  const listResult = spawnSync(NODE, [RUNNER, "--list", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
  const list = parseJson(listResult.stdout);
  const suite = list?.suites?.find((entry) => entry.id === "clean-checkout-conformance");
  assert(listResult.status === 0 && Boolean(suite), "IVE runner registers clean-checkout-conformance");
  assert(suite?.required === true, "clean-checkout suite is required");
  assert(suite?.phases?.includes("release") && suite?.phases?.includes("planner-core"), "suite is selected for release and planner-core");
  assert(!String(suite?.command || "").includes(REPO_ROOT), "runner command projection is repository-relative");

  const releaseWorkflow = readFileSync(join(REPO_ROOT, ".agent", "workflows", "release.md"), "utf8");
  const releaseLane = readFileSync(join(REPO_ROOT, "docs", "ive-redesign", "17_release_lane.md"), "utf8");
  const requiredCommand = "clean_checkout_conformance.mjs --ref HEAD --profile-manifest <repo-relative-manifest.json> --require-profile core-release --json";
  assert(releaseWorkflow.includes(requiredCommand), "release workflow requires the detached replay command");
  assert(releaseLane.includes(requiredCommand), "release lane documents the same detached replay command");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
