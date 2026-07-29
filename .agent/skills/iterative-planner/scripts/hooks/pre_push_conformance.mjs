#!/usr/bin/env node
// pre_push_conformance.mjs
// Stopgap gate for t04: refuse pushes to main when IVE conformance is red.

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";

const DEFAULT_IVE_PRE_PUSH_TIMEOUT_MS = 720_000;

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

function projectRoot() {
  return resolve(process.env.ITERATIVE_PLANNER_PROJECT_ROOT || process.cwd());
}

function excerpt(value, max = 1200) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function resolveTimeoutMs(rawValue) {
  if (rawValue === undefined || String(rawValue).trim() === "") {
    return { ok: true, value: DEFAULT_IVE_PRE_PUSH_TIMEOUT_MS, source: "default" };
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

console.log(`[pre-push] Push to main detected; running IVE conformance stopgap (runner=${runner} timeout_ms=${timeout.value} timeout_source=${timeout.source})...`);
const startedAtMs = Date.now();
const explicitPlanTarget = process.env._PLANNER_PLAN_TARGET?.trim() || null;
const runnerArgs = [
  runner,
  ...(explicitPlanTarget ? ["--plan-target", explicitPlanTarget] : []),
  "--json",
];
const result = spawnSync(process.execPath, runnerArgs, {
  cwd: root,
  encoding: "utf-8",
  env: {
    ...process.env,
    PLANNER_SKIP_SELF_HEAL: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  timeout: timeout.value,
});
const elapsedMs = Date.now() - startedAtMs;

if (result.status !== 0) {
  if (result.stdout) console.error(excerpt(result.stdout));
  if (result.stderr) console.error(excerpt(result.stderr));
  if (result.error?.code === "ETIMEDOUT") {
    const childPid = Number.isInteger(result.pid) ? result.pid : "unavailable";
    console.error(`[pre-push] IVE infrastructure timeout: runner=${runner} pid=${childPid} timeout_ms=${timeout.value} elapsed_ms=${elapsedMs} code=ETIMEDOUT.`);
  } else if (result.error) {
    console.error(`[pre-push] IVE runner infrastructure error: runner=${runner} pid=${Number.isInteger(result.pid) ? result.pid : "unavailable"} elapsed_ms=${elapsedMs} detail=${excerpt(result.error.message)}`);
  } else {
    console.error(`[pre-push] IVE conformance completed non-zero: runner=${runner} pid=${Number.isInteger(result.pid) ? result.pid : "unavailable"} status=${result.status} signal=${result.signal || "none"} elapsed_ms=${elapsedMs}.`);
  }
  console.error("[pre-push] IVE conformance failed; refusing push to main.");
  process.exit(result.status || 1);
}

console.log(`[pre-push] IVE conformance passed in ${elapsedMs}ms; allowing push to main.`);
