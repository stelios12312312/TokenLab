#!/usr/bin/env node
// pre_push_conformance.mjs
// Stopgap gate for t04: refuse pushes to main when IVE conformance is red.

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";

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

console.log("[pre-push] Push to main detected; running IVE conformance stopgap...");
const result = spawnSync(process.execPath, [runner, "--json"], {
  cwd: root,
  encoding: "utf-8",
  env: {
    ...process.env,
    PLANNER_SKIP_SELF_HEAL: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  timeout: Number(process.env.IVE_PRE_PUSH_TIMEOUT_MS || 300000),
});

if (result.status !== 0) {
  if (result.stdout) console.error(excerpt(result.stdout));
  if (result.stderr) console.error(excerpt(result.stderr));
  if (result.error) console.error(excerpt(result.error.message));
  console.error("[pre-push] IVE conformance failed; refusing push to main.");
  process.exit(result.status || 1);
}

console.log("[pre-push] IVE conformance passed; allowing push to main.");
