import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const VERSION_ROUTING_RELATIVE_PATH = join(".agent", "version.json");

const VALID_PLANNERS = new Set(["v6", "v7", "v10", "10", "10.0.0", "v10.0.0"]);
const VALID_FLAVORS = new Set(["minimal", "standard", "full"]);
const VALID_ORCHESTRATOR_MODES = new Set(["none", "advisory", "autonomous"]);

const V6_DEFAULTS = Object.freeze({
  planner: "v6",
  flavor: "legacy",
  created_at: null,
  migrated_from: null,
  agents_enabled: Object.freeze({
    agent_a: true,
    agent_b: false,
    agent_b_invocation: Object.freeze([]),
    agent_c: false,
    orchestrator: "none",
  }),
});

const V7_FLAVOR_DEFAULTS = Object.freeze({
  minimal: Object.freeze({
    agent_a: true,
    agent_b: false,
    agent_b_invocation: Object.freeze([]),
    agent_c: false,
    orchestrator: "none",
  }),
  standard: Object.freeze({
    agent_a: true,
    agent_b: false,
    agent_b_invocation: Object.freeze(["manual_cli"]),
    agent_c: false,
    orchestrator: "none",
  }),
  full: Object.freeze({
    agent_a: true,
    agent_b: true,
    agent_b_invocation: Object.freeze(["manual_cli"]),
    agent_c: true,
    orchestrator: "advisory",
  }),
});

function cloneAgentDefaults(agentDefaults) {
  return {
    agent_a: agentDefaults.agent_a === true,
    agent_b: agentDefaults.agent_b === true,
    agent_b_invocation: Array.isArray(agentDefaults.agent_b_invocation)
      ? [...agentDefaults.agent_b_invocation]
      : [],
    agent_c: agentDefaults.agent_c === true,
    orchestrator: typeof agentDefaults.orchestrator === "string" ? agentDefaults.orchestrator : "none",
  };
}

function uniqueModes(modes) {
  return [...new Set(
    (Array.isArray(modes) ? modes : [])
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim())
  )];
}

export function buildDefaultVersionRouting({ planner = "v6", flavor = null } = {}) {
  if (planner !== "v7") {
    return {
      path: null,
      present: false,
      valid: true,
      malformed: false,
      fallback_reason: null,
      warnings: [],
      planner: V6_DEFAULTS.planner,
      flavor: V6_DEFAULTS.flavor,
      created_at: V6_DEFAULTS.created_at,
      migrated_from: V6_DEFAULTS.migrated_from,
      agents_enabled: cloneAgentDefaults(V6_DEFAULTS.agents_enabled),
    };
  }

  const resolvedFlavor = VALID_FLAVORS.has(flavor) ? flavor : "standard";
  const defaults = V7_FLAVOR_DEFAULTS[resolvedFlavor];
  return {
    path: null,
    present: false,
    valid: true,
    malformed: false,
    fallback_reason: null,
    warnings: [],
    planner: "v7",
    flavor: resolvedFlavor,
    created_at: null,
    migrated_from: null,
    agents_enabled: cloneAgentDefaults(defaults),
  };
}

function v6Fallback(path, { present = false, malformed = false, fallbackReason = null, warning = null } = {}) {
  const fallback = buildDefaultVersionRouting({ planner: "v6" });
  return {
    ...fallback,
    path,
    present,
    valid: false,
    malformed,
    fallback_reason: fallbackReason,
    warnings: warning ? [warning] : [],
  };
}

export function normalizeVersionRoutingDocument(parsed, { path = null, present = false } = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return v6Fallback(path, {
      present,
      fallbackReason: "invalid_shape",
      warning: "`.agent/version.json` must be an object. Falling back to v6 defaults.",
    });
  }

  const warnings = [];
  let requestedPlanner = typeof parsed.planner === "string" ? parsed.planner.trim() : "";
  if (!VALID_PLANNERS.has(requestedPlanner)) {
    return v6Fallback(path, {
      present,
      fallbackReason: "invalid_planner",
      warning: "`.agent/version.json` planner must be `v6`, `v7`, or `v10`. Falling back to v6 defaults.",
    });
  }

  // Normalize v10 aliases to v7 internally for architectural routing compatibility
  if (["v10", "10", "10.0.0", "v10.0.0"].includes(requestedPlanner)) {
    requestedPlanner = "v7";
  }

  if (requestedPlanner === "v6") {
    if (parsed.agents_enabled && typeof parsed.agents_enabled === "object") {
      const requestedAgentB = parsed.agents_enabled.agent_b === true || parsed.agents_enabled.agent_c === true;
      const requestedOrchestrator = typeof parsed.agents_enabled.orchestrator === "string"
        && parsed.agents_enabled.orchestrator.trim()
        && parsed.agents_enabled.orchestrator.trim() !== "none";
      if (requestedAgentB || requestedOrchestrator) {
        warnings.push("`.agent/version.json` declared v7-only agent settings while planner=v6; ignoring those fields.");
      }
    }

    return {
      ...buildDefaultVersionRouting({ planner: "v6" }),
      path,
      present,
      valid: warnings.length === 0,
      warnings,
    };
  }

  let flavor = typeof parsed.flavor === "string" ? parsed.flavor.trim() : "";
  if (!VALID_FLAVORS.has(flavor)) {
    if (flavor) {
      warnings.push(`.agent/version.json flavor "${flavor}" is unknown; defaulting to v7 standard.`);
    }
    flavor = "standard";
  }

  const defaults = buildDefaultVersionRouting({ planner: "v7", flavor });
  const agentsEnabled = parsed.agents_enabled && typeof parsed.agents_enabled === "object"
    ? parsed.agents_enabled
    : {};

  const invocationModes = uniqueModes(agentsEnabled.agent_b_invocation);
  const orchestrator = typeof agentsEnabled.orchestrator === "string" && VALID_ORCHESTRATOR_MODES.has(agentsEnabled.orchestrator.trim())
    ? agentsEnabled.orchestrator.trim()
    : defaults.agents_enabled.orchestrator;

  if (typeof agentsEnabled.orchestrator === "string" && !VALID_ORCHESTRATOR_MODES.has(agentsEnabled.orchestrator.trim())) {
    warnings.push(`.agent/version.json orchestrator "${agentsEnabled.orchestrator}" is unsupported; using ${defaults.agents_enabled.orchestrator}.`);
  }

  if (Array.isArray(agentsEnabled.agent_b_invocation) && invocationModes.length === 0 && defaults.agents_enabled.agent_b_invocation.length > 0) {
    warnings.push("`.agent/version.json` agent_b_invocation was empty after normalization; using the flavor default.");
  }

  return {
    ...defaults,
    path,
    present,
    valid: warnings.length === 0,
    warnings,
    created_at: typeof parsed.created_at === "string" && parsed.created_at.trim() ? parsed.created_at.trim() : null,
    migrated_from: parsed.migrated_from === "v6" ? "v6" : null,
    agents_enabled: {
      agent_a: agentsEnabled.agent_a === true ? true : defaults.agents_enabled.agent_a,
      agent_b: agentsEnabled.agent_b === true ? true : (agentsEnabled.agent_b === false ? false : defaults.agents_enabled.agent_b),
      agent_b_invocation: invocationModes.length > 0 ? invocationModes : [...defaults.agents_enabled.agent_b_invocation],
      agent_c: agentsEnabled.agent_c === true ? true : (agentsEnabled.agent_c === false ? false : defaults.agents_enabled.agent_c),
      orchestrator,
    },
  };
}

export function readVersionRouting(projectRoot = process.cwd()) {
  const path = join(projectRoot, VERSION_ROUTING_RELATIVE_PATH);
  if (!existsSync(path)) {
    return v6Fallback(path, {
      present: false,
      fallbackReason: "missing_version_json",
      warning: "`.agent/version.json` is missing; defaulting to v6 routing for safety.",
    });
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return normalizeVersionRoutingDocument(parsed, { path, present: true });
  } catch (error) {
    return v6Fallback(path, {
      present: true,
      malformed: true,
      fallbackReason: "malformed_version_json",
      warning: `.agent/version.json is malformed (${error.message}); defaulting to v6 routing for safety.`,
    });
  }
}

export function agentBInvocationModes(versionInfo) {
  return uniqueModes(versionInfo?.agents_enabled?.agent_b_invocation);
}

export function shouldRunPostCommitStoryVerification(versionInfo) {
  return versionInfo?.planner === "v7"
    && versionInfo?.agents_enabled?.agent_b === true
    && agentBInvocationModes(versionInfo).includes("post_commit_hook");
}
