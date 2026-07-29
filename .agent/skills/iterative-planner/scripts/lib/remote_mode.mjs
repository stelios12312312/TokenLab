// remote_mode.mjs — Local-compute-first remote mirror mode contract.
// @planner:capability = planner_remote_mode_contract

export const REMOTE_MODES = Object.freeze(["local-only", "remote-read", "remote-sync"]);

export function normalizeRemoteMode(value, { fallback = null } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase().replace(/_/g, "-");
  if (REMOTE_MODES.includes(normalized)) return normalized;
  throw new Error(`Unsupported remote mode: ${value}. Expected one of ${REMOTE_MODES.join(", ")}`);
}

export function resolveExplicitRemoteMode({ explicit = null, explicitSource = "cli", env = process.env } = {}) {
  const direct = String(explicit ?? "").trim();
  if (direct) {
    return {
      mode: normalizeRemoteMode(direct),
      source: explicitSource,
      raw: direct,
    };
  }
  const fromEnv = String(env?.PLANNER_REMOTE_MODE ?? "").trim();
  if (fromEnv) {
    return {
      mode: normalizeRemoteMode(fromEnv),
      source: "env:PLANNER_REMOTE_MODE",
      raw: fromEnv,
    };
  }
  return null;
}

export function resolveRemoteMode({ explicit = null, env = process.env, defaultMode = "local-only" } = {}) {
  return resolveExplicitRemoteMode({ explicit, env })?.mode || normalizeRemoteMode(defaultMode);
}

export function assertRemoteReadAllowed(mode, action = "remote read") {
  const normalized = normalizeRemoteMode(mode, { fallback: "local-only" });
  if (normalized === "local-only") {
    throw new Error(`${action} requires remote-read or remote-sync; current remote mode is local-only`);
  }
  return true;
}

export function assertRemoteWriteAllowed(mode, action = "remote write") {
  const normalized = normalizeRemoteMode(mode, { fallback: "local-only" });
  if (normalized !== "remote-sync") {
    throw new Error(`${action} requires remote-sync; current remote mode is ${normalized}`);
  }
  return true;
}
