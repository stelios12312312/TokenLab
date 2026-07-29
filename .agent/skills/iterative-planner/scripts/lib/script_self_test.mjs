import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const AGENT_IDE_ENV_PREFIXES = Object.freeze([
  "CLAUDE_CODE_",
  "CODEX_",
  "CURSOR_",
  "ANTIGRAVITY_",
]);

const AGENT_IDE_ENV_KEYS = Object.freeze([
  "_PLANNER_PLAN_TARGET",
  "_PLANNER_THREAD_ID",
  "VSCODE_PID",
  "TERM_PROGRAM",
]);

export function selfPath(metaUrl) {
  return fileURLToPath(metaUrl);
}

export function plannerSelfTestEnv(overrides = {}, baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    if (AGENT_IDE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = "";
    }
  }
  for (const key of AGENT_IDE_ENV_KEYS) {
    env[key] = "";
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

export function makeSelfTestTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-script-self-test-${name}-`));
}

export function cleanupSelfTestTemp(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export function seedActivePlan(cwd, planName = "plan_self_test") {
  const planDir = join(cwd, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(cwd, "plans", ".current_plan"), `${planName}\n`);
  return planDir;
}

export function runNodeScript(args, cwd, extraEnv = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(process.execPath, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: plannerSelfTestEnv(extraEnv),
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

export function runBin(bin, args, cwd, extraEnv = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(bin, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: plannerSelfTestEnv(extraEnv),
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

export function assertSelfTest(condition, label, detail = "") {
  if (condition) return;
  const suffix = detail ? `\n${detail}` : "";
  throw new Error(`SELF-TEST FAIL: ${label}${suffix}`);
}

export function initGitRepo(cwd) {
  const init = runBin("git", ["init"], cwd);
  assertSelfTest(init.ok, "git init succeeds", init.stderr || init.stdout);

  const userName = runBin("git", ["config", "user.name", "Codex Self Test"], cwd);
  assertSelfTest(userName.ok, "git user.name is configured", userName.stderr || userName.stdout);

  const userEmail = runBin("git", ["config", "user.email", "codex-self-test@example.com"], cwd);
  assertSelfTest(userEmail.ok, "git user.email is configured", userEmail.stderr || userEmail.stdout);
}

export function printSelfTestPass(name) {
  console.log(`SELF-TEST PASS ${name}`);
}
