#!/usr/bin/env node
// pre_push_conformance.mjs
// Refuse pushes to main when the affected governed IVE conformance is red.

import { execFileSync, spawn, spawnSync } from "child_process";
import { existsSync, realpathSync, statSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { verificationStatusIsHardFailure } from "../lib/verification_status_vocabulary.mjs";

const DEFAULT_IVE_PRE_PUSH_TIMEOUT_MS = 900_000;
const CORE_RELEASE_PROFILE_ID = "core-release";
const SKILL_PREFIX = ".agent/skills/iterative-planner/";
const CORE_RELEASE_PROFILE_SURFACES = new Set([
  `${SKILL_PREFIX}config/ive_release_profiles.json`,
  `${SKILL_PREFIX}config/conformance_session.json`,
  `${SKILL_PREFIX}config/release_artifact_policy.json`,
  `${SKILL_PREFIX}scripts/hooks/pre_push_conformance.mjs`,
  `${SKILL_PREFIX}scripts/lib/conformance_session.mjs`,
  `${SKILL_PREFIX}scripts/lib/release_artifact_policy.mjs`,
  `${SKILL_PREFIX}scripts/pre_commit_policy.mjs`,
  `${SKILL_PREFIX}tests/ive/run.mjs`,
  `${SKILL_PREFIX}tests/ive/test_run.mjs`,
  `${SKILL_PREFIX}tests/test_ive_conformance_runner.mjs`,
]);
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/i;
const PARENT_GIT_ENV_KEYS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]);

function isolatedChildEnv(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const key of PARENT_GIT_ENV_KEYS) delete env[key];
  return env;
}

function readStdin() {
  return new Promise((resolveRead) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolveRead(data));
    if (process.stdin.isTTY) resolveRead("");
  });
}

function parseUpdates(stdin) {
  return String(stdin || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

function targetsMain(update) {
  return update?.remoteRef === "refs/heads/main" || update?.localRef === "refs/heads/main";
}

function isZeroObjectId(value) {
  return typeof value === "string" && value.length > 0 && /^0+$/.test(value);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function requiresCoreReleaseProfile(paths) {
  return paths.some((path) => CORE_RELEASE_PROFILE_SURFACES.has(normalizePath(path)));
}

function mainPushSelection(root, updates) {
  const changedFiles = new Set();
  const baseShas = new Set();
  for (const update of updates) {
    if (isZeroObjectId(update?.localSha)) {
      return { mode: "full", changed_files: [], reason: "main_deletion" };
    }
    if (isZeroObjectId(update?.remoteSha)) {
      return { mode: "full", changed_files: [], reason: "new_main_ref" };
    }
    if (!GIT_OBJECT_ID.test(update?.localSha || "") || !GIT_OBJECT_ID.test(update?.remoteSha || "")) {
      return { mode: "full", changed_files: [], reason: "invalid_ref_boundary" };
    }
    baseShas.add(update.remoteSha);
    try {
      const output = execFileSync("git", [
        "diff",
        "--name-only",
        "--diff-filter=ACMRTUXB",
        "-z",
        `${update.remoteSha}..${update.localSha}`,
      ], {
        cwd: root,
        encoding: "utf-8",
        env: isolatedChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const path of output.split("\0").map((entry) => entry.trim()).filter(Boolean)) {
        changedFiles.add(path);
      }
    } catch {
      return { mode: "full", changed_files: [], reason: "git_diff_unavailable" };
    }
  }
  const paths = [...changedFiles].sort();
  const baseSha = baseShas.size === 1 ? [...baseShas][0] : null;
  if (paths.length > 0 && requiresCoreReleaseProfile(paths)) {
    return {
      mode: "profile",
      profile: CORE_RELEASE_PROFILE_ID,
      changed_files: paths,
      reason: "governed_release_surface",
      base_sha: baseSha,
    };
  }
  return paths.length > 0
    ? { mode: "changed_files", changed_files: paths, reason: "trusted_ref_diff", base_sha: baseSha }
    : { mode: "full", changed_files: [], reason: "empty_ref_diff", base_sha: baseSha };
}

function projectRoot() {
  return resolve(process.env.ITERATIVE_PLANNER_PROJECT_ROOT || process.cwd());
}

function excerpt(value, max = 1200) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function collectFailingSuiteIds(report) {
  const suiteIds = new Set();

  for (const issue of Array.isArray(report?.issues) ? report.issues : []) {
    const suiteId = nonEmptyString(issue?.suite_id);
    if (suiteId) suiteIds.add(suiteId);
  }

  for (const collection of [report?.results, report?.checks]) {
    for (const result of Array.isArray(collection) ? collection : []) {
      const status = nonEmptyString(result?.status)?.toUpperCase();
      const suiteId = nonEmptyString(result?.id);
      if (suiteId && verificationStatusIsHardFailure(status, "execution")) suiteIds.add(suiteId);
    }
  }

  return [...suiteIds].sort();
}

function isWithinRoot(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function verifyManifestPath(root, rawPath) {
  const manifestPath = nonEmptyString(rawPath);
  if (!manifestPath) {
    return { ok: false, reason: "missing_manifest_path" };
  }

  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(lexicalRoot, manifestPath);
  if (!isWithinRoot(lexicalRoot, lexicalTarget)) {
    return { ok: false, reason: "manifest_outside_repository" };
  }
  if (!existsSync(lexicalTarget)) {
    return { ok: false, reason: "manifest_missing" };
  }

  let canonicalRoot;
  let canonicalTarget;
  try {
    canonicalRoot = realpathSync(lexicalRoot);
    canonicalTarget = realpathSync(lexicalTarget);
  } catch {
    return { ok: false, reason: "manifest_realpath_unavailable" };
  }

  if (!isWithinRoot(canonicalRoot, canonicalTarget)) {
    return { ok: false, reason: "manifest_outside_repository" };
  }

  let targetStat;
  try {
    targetStat = statSync(canonicalTarget);
  } catch {
    return { ok: false, reason: "manifest_realpath_unavailable" };
  }
  if (!targetStat.isFile()) {
    return { ok: false, reason: "manifest_not_a_file" };
  }

  return {
    ok: true,
    path: relative(lexicalRoot, lexicalTarget).split(sep).join("/"),
  };
}

function completedRunDiagnostics(stdout, root) {
  let report;
  try {
    report = JSON.parse(String(stdout || "").trim());
  } catch {
    return ["failure_authority=unavailable reason=invalid_runner_json"];
  }

  const failingSuiteIds = collectFailingSuiteIds(report);
  const diagnostics = [
    failingSuiteIds.length > 0
      ? `failing_suite_ids=${failingSuiteIds.join(",")}`
      : "failing_suite_ids=unavailable",
  ];
  const manifest = verifyManifestPath(root, report?.manifest_path);
  if (!manifest.ok) {
    diagnostics.push(`failure_authority=unavailable reason=${manifest.reason}`);
    return diagnostics;
  }

  diagnostics.push("failure_authority=available");
  diagnostics.push(`manifest_path=${manifest.path}`);
  return diagnostics;
}

function resolveTimeoutMs(rawValue) {
  if (rawValue === undefined || String(rawValue).trim() === "") {
    return { ok: true, value: null, source: "forecast" };
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, value: null, source: "IVE_PRE_PUSH_TIMEOUT_MS" };
  }
  return { ok: true, value, source: "IVE_PRE_PUSH_TIMEOUT_MS" };
}

const stdin = await readStdin();
const updates = parseUpdates(stdin);
const mainUpdates = updates.filter(targetsMain);

if (mainUpdates.length === 0) {
  console.log("[pre-push] No main push refs detected; skipping IVE conformance stopgap.");
  process.exit(0);
}

const root = projectRoot();
const runner = join(root, ".agent", "skills", "iterative-planner", "tests", "ive", "run.mjs");

if (!existsSync(runner)) {
  console.error(`[pre-push] IVE conformance runner missing: ${runner}`);
  console.error("[pre-push] IVE conformance failed; refusing push to main.");
  process.exit(1);
}

const timeout = resolveTimeoutMs(process.env.IVE_PRE_PUSH_TIMEOUT_MS);
if (!timeout.ok) {
  console.error(`[pre-push] Invalid IVE timeout configuration: IVE_PRE_PUSH_TIMEOUT_MS=${JSON.stringify(process.env.IVE_PRE_PUSH_TIMEOUT_MS)} (expected a positive integer in milliseconds).`);
  console.error("[pre-push] IVE conformance failed; refusing push to main.");
  process.exit(1);
}

const selection = mainPushSelection(root, mainUpdates);
const explicitPlanTarget = process.env._PLANNER_PLAN_TARGET?.trim() || null;
const selectionArgs = [
  runner,
  ...(explicitPlanTarget ? ["--plan-target", explicitPlanTarget] : []),
  ...(selection.profile
    ? ["--profile", selection.profile]
    : selection.changed_files.flatMap((path) => ["--changed-files", path])),
  ...(selection.base_sha ? ["--base-sha", selection.base_sha] : []),
];
const forecast = spawnSync(process.execPath, [...selectionArgs, "--forecast", "--json"], {
  cwd: root,
  encoding: "utf-8",
  env: {
    ...isolatedChildEnv(),
    PLANNER_SKIP_SELF_HEAL: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 60_000,
  maxBuffer: 64 * 1024 * 1024,
});
let forecastReport = null;
try { forecastReport = JSON.parse(forecast.stdout || "{}"); } catch {}
const requiredOuterTimeoutMs = Number(forecastReport?.forecast?.required_outer_timeout_ms);
if (forecast.status !== 0 || forecastReport?.status !== "FORECAST" || !Number.isInteger(requiredOuterTimeoutMs) || requiredOuterTimeoutMs <= 0) {
  console.error(`[pre-push] IVE infrastructure preflight failed before suite spawn: ${excerpt(forecast.stderr || forecastReport?.issues?.[0]?.message || "invalid selected-workload forecast")}`);
  console.error("[pre-push] IVE conformance failed; refusing push to main.");
  process.exit(1);
}
const effectiveTimeoutMs = timeout.value ?? Math.max(DEFAULT_IVE_PRE_PUSH_TIMEOUT_MS, requiredOuterTimeoutMs);
if (effectiveTimeoutMs < requiredOuterTimeoutMs) {
  console.error(`[pre-push] IVE infrastructure preflight failed before suite spawn: configured outer timeout ${effectiveTimeoutMs}ms is below selected-workload bound ${requiredOuterTimeoutMs}ms.`);
  console.error("[pre-push] IVE conformance failed; refusing push to main.");
  process.exit(1);
}
console.log(`[pre-push] Push to main detected; running governed IVE conformance (runner=${runner} timeout_ms=${effectiveTimeoutMs} timeout_source=${timeout.source} selected_bound_ms=${requiredOuterTimeoutMs} selection=${selection.mode} changed_files=${selection.changed_files.length} reason=${selection.reason})...`);
const startedAtMs = Date.now();
const runnerArgs = [
  ...selectionArgs,
  "--outer-timeout-ms",
  String(effectiveTimeoutMs),
  "--progress",
  "--json",
];
const child = spawn(process.execPath, runnerArgs, {
  cwd: root,
  detached: process.platform !== "win32",
  env: {
    ...isolatedChildEnv(),
    PLANNER_SKIP_SELF_HEAL: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childStdout = "";
let childStderr = "";
let spawnError = null;
let timeoutExpired = false;
let parentSignal = null;
let stopPromise = null;
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const groupAlive = () => {
  if (!Number.isInteger(child.pid)) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};
const signalGroup = (signal) => {
  if (!Number.isInteger(child.pid)) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH" && !spawnError) spawnError = error;
  }
};
const stopOwnedRunner = () => {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    signalGroup("SIGTERM");
    // The exact live runner may be inside its detached two-suite wave. Its
    // TERM -> KILL -> terminal cleanup path is bounded at roughly one second;
    // do not kill the runner before it has reaped those separate groups.
    await wait(1500);
    if (groupAlive()) signalGroup("SIGKILL");
    for (let attempt = 0; attempt < 5 && groupAlive(); attempt += 1) await wait(100);
    return !groupAlive();
  })();
  return stopPromise;
};
const onParentSignal = (signal) => {
  if (parentSignal) return;
  parentSignal = signal;
  void stopOwnedRunner();
};
const onSigint = () => onParentSignal("SIGINT");
const onSigterm = () => onParentSignal("SIGTERM");
const onExit = () => signalGroup("SIGKILL");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.on("exit", onExit);

child.stdout?.setEncoding("utf-8");
child.stderr?.setEncoding("utf-8");
child.stdout?.on("data", (chunk) => { childStdout += chunk; });
child.stderr?.on("data", (chunk) => {
  childStderr += chunk;
  if (childStderr.length > 64 * 1024 * 1024) childStderr = childStderr.slice(-64 * 1024 * 1024);
  process.stderr.write(chunk);
});

const childClosePromise = new Promise((resolveChild) => {
  let settled = false;
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    resolveChild(outcome);
  };
  child.once("error", (error) => {
    spawnError = error;
    settle({ code: null, signal: null });
  });
  child.once("close", (code, signal) => settle({ code, signal }));
});
const timeoutTimer = setTimeout(() => {
  timeoutExpired = true;
  void stopOwnedRunner();
}, effectiveTimeoutMs);
const childOutcome = await childClosePromise;
clearTimeout(timeoutTimer);
const unexpectedDescendants = !timeoutExpired && !parentSignal && groupAlive();
let cleanupComplete = true;
if (timeoutExpired || parentSignal || groupAlive()) cleanupComplete = await stopOwnedRunner();
process.removeListener("SIGINT", onSigint);
process.removeListener("SIGTERM", onSigterm);
process.removeListener("exit", onExit);

if (parentSignal) {
  if (!cleanupComplete) console.error(`[pre-push] IVE runner process group cleanup failed before ${parentSignal}.`);
  process.kill(process.pid, parentSignal);
  await new Promise(() => {});
}

let resultError = spawnError;
if (timeoutExpired) {
  resultError = new Error(`IVE conformance exceeded ${effectiveTimeoutMs}ms`);
  resultError.code = "ETIMEDOUT";
} else if (unexpectedDescendants || !cleanupComplete) {
  resultError = new Error("IVE runner process group did not exit cleanly");
  resultError.code = "ERUNNERCLEANUP";
}
const result = {
  pid: child.pid,
  status: childOutcome.code,
  signal: childOutcome.signal,
  stdout: childStdout,
  stderr: childStderr,
  error: resultError,
};
const elapsedMs = Date.now() - startedAtMs;

if (result.status !== 0 || result.error) {
  if (!result.error) {
    for (const diagnostic of completedRunDiagnostics(result.stdout, root)) {
      console.error(`[pre-push] ${diagnostic}`);
    }
  }
  if (result.stdout) console.error(excerpt(result.stdout));
  if (result.stderr) console.error(excerpt(result.stderr));
  if (result.error?.code === "ETIMEDOUT") {
    const childPid = Number.isInteger(result.pid) ? result.pid : "unavailable";
    console.error(`[pre-push] IVE infrastructure timeout: runner=${runner} pid=${childPid} timeout_ms=${effectiveTimeoutMs} elapsed_ms=${elapsedMs} code=ETIMEDOUT.`);
  } else if (result.error) {
    console.error(`[pre-push] IVE runner infrastructure error: runner=${runner} pid=${Number.isInteger(result.pid) ? result.pid : "unavailable"} elapsed_ms=${elapsedMs} detail=${excerpt(result.error.message)}`);
  } else {
    console.error(`[pre-push] IVE conformance completed non-zero: runner=${runner} pid=${Number.isInteger(result.pid) ? result.pid : "unavailable"} status=${result.status} signal=${result.signal || "none"} elapsed_ms=${elapsedMs}.`);
  }
  console.error("[pre-push] IVE conformance failed; refusing push to main.");
  process.exit(result.status || 1);
}

console.log(`[pre-push] IVE conformance passed in ${elapsedMs}ms; allowing push to main.`);
