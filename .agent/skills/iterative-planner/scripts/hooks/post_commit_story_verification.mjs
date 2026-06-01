#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { runVerifyStories } from "../verify_stories.mjs";
import { readVersionRouting, shouldRunPostCommitStoryVerification } from "../lib/version_routing.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveProjectRoot() {
  return resolve(process.env.ITERATIVE_PLANNER_PROJECT_ROOT || process.cwd());
}

function appendErrorLog(projectRoot, message, errorClass = "HookError") {
  const date = new Date().toISOString().slice(0, 10);
  const logPath = join(projectRoot, "reports", "errors", `agent_b_${date}.log`);
  mkdirSync(dirname(logPath), { recursive: true });

  const entry = {
    version: 1,
    timestamp: new Date().toISOString(),
    agent: "agent_b",
    severity: "ERROR",
    event: "post_commit_story_verification_failed",
    component: "post_commit_story_verification.mjs",
    plan_id: null,
    context: {
      phase: null,
      gate: null,
      operation: "post_commit_hook",
      path: null,
      error_class: errorClass,
      error_message: message,
    },
    outcome: "ignored",
    user_notified: false,
    recovery_action: null,
    correlation_id: null,
  };

  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
  return logPath;
}

function runWorker(projectRoot) {
  try {
    const result = runVerifyStories(["--plan-from-head", "--quiet"], projectRoot);
    if (!result.ok) {
      appendErrorLog(
        projectRoot,
        result.error || `verify-stories exited with status ${result.status || 1}`,
        "VerificationError"
      );
    }
  } catch (error) {
    appendErrorLog(projectRoot, error?.message || String(error), error?.name || "Error");
  }
  return 0;
}

function launchDetachedWorker(projectRoot) {
  const child = spawn(process.execPath, [__filename, "--worker"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ITERATIVE_PLANNER_PROJECT_ROOT: projectRoot,
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const projectRoot = resolveProjectRoot();
const routing = readVersionRouting(projectRoot);

if (!shouldRunPostCommitStoryVerification(routing)) {
  process.exit(0);
}

if (process.argv.includes("--worker") || process.env.ITERATIVE_PLANNER_STORY_VERIFICATION_SYNC === "1") {
  process.exit(runWorker(projectRoot));
}

try {
  launchDetachedWorker(projectRoot);
} catch (error) {
  appendErrorLog(projectRoot, error?.message || String(error), error?.name || "SpawnError");
}

process.exit(0);
