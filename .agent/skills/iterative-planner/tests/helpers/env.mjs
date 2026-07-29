// Shared subprocess environment helpers for planner tests.

export const AGENT_IDE_ENV_PREFIXES = Object.freeze([
  "CLAUDE_CODE_",
  "CODEX_",
  "CURSOR_",
  "ANTIGRAVITY_",
]);

export const AGENT_IDE_ENV_KEYS = Object.freeze([
  "_PLANNER_PLAN_TARGET",
  "_PLANNER_THREAD_ID",
  "_PLANNER_GATE_TRANSITION",
  "VSCODE_PID",
  "TERM_PROGRAM",
]);

export function plannerSubprocessEnv(overrides = {}, baseEnv = process.env) {
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
