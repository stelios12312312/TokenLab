import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const SKILL_DIR = resolve(dirname(__filename), "..", "..");
const DEFAULT_CONFIG_PATH = join(SKILL_DIR, "config", "agent_orchestration.json");

const WRITE_TOOLS = new Set(["write", "edit", "bash", "apply_patch"]);
const VALID_AUTHORITIES = new Set(["foreground_writer", "background_reader", "adversarial_auditor"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function norm(value) {
  return String(value || "").trim();
}

function lower(value) {
  return norm(value).toLowerCase();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadAgentOrchestrationConfig({ configPath = DEFAULT_CONFIG_PATH } = {}) {
  if (!existsSync(configPath)) {
    throw new Error(`agent orchestration config not found at ${configPath}`);
  }
  const raw = readJson(configPath);
  return {
    ...raw,
    path: configPath,
    agents: asArray(raw.agents).map((agent) => ({
      ...agent,
      id: norm(agent.id),
      phase: norm(agent.phase).toUpperCase(),
      authority: lower(agent.authority),
      model: norm(agent.model),
      effort: lower(agent.effort),
      tools: asArray(agent.tools).map(norm).filter(Boolean),
      writes_shared_state: agent.writes_shared_state === true,
      allow_nested_agents: agent.allow_nested_agents === true,
    })),
  };
}

function issue(code, message, agentId = null) {
  return { code, message, agent_id: agentId };
}

function hasWriteTool(agent) {
  return asArray(agent.tools).some((tool) => WRITE_TOOLS.has(lower(tool)));
}

function hasAgentTool(agent) {
  return asArray(agent.tools).some((tool) => lower(tool) === "agent" || lower(tool) === "agent()");
}

export function validateAgentWhitelist(config) {
  const issues = [];
  const seen = new Set();

  if (config?.schema_version !== 1) {
    issues.push(issue("unsupported_schema_version", "agent_orchestration.json must declare schema_version 1"));
  }
  if (config?.orchestrator?.id !== "planner_orchestrator") {
    issues.push(issue("orchestrator_id_invalid", "orchestrator.id must be planner_orchestrator"));
  }
  if (config?.orchestrator?.single_foreground_writer !== true) {
    issues.push(issue("single_foreground_writer_disabled", "single_foreground_writer must be true"));
  }
  if (config?.orchestrator?.no_nested_subagents !== true) {
    issues.push(issue("nested_subagent_policy_disabled", "no_nested_subagents must be true"));
  }

  for (const agent of asArray(config?.agents)) {
    if (!agent.id) {
      issues.push(issue("agent_id_missing", "Every whitelisted agent needs an id"));
      continue;
    }
    if (seen.has(agent.id)) {
      issues.push(issue("duplicate_agent_id", `Duplicate agent id ${agent.id}`, agent.id));
    }
    seen.add(agent.id);
    if (!agent.model || !agent.effort) {
      issues.push(issue("model_effort_missing", "Whitelisted agents must pin model and effort", agent.id));
    }
    if (!VALID_AUTHORITIES.has(agent.authority)) {
      issues.push(issue("invalid_authority", `Unsupported authority ${agent.authority}`, agent.id));
    }
    if (agent.allow_nested_agents || hasAgentTool(agent)) {
      issues.push(issue("nested_subagent_forbidden", "Subagents cannot spawn subagents or request Agent()", agent.id));
    }
    if (agent.authority !== "foreground_writer" && (agent.writes_shared_state || hasWriteTool(agent))) {
      issues.push(issue("background_agent_not_read_only", "Background and auditor agents must be read-only", agent.id));
    }
    if (agent.authority === "foreground_writer" && !agent.writes_shared_state) {
      issues.push(issue("foreground_writer_not_marked_mutating", "Foreground writers must explicitly own shared-state mutation", agent.id));
    }
    if (agent.authority === "adversarial_auditor" && agent.tools.join(",") !== "Read,Grep") {
      issues.push(issue("isolated_auditor_tool_scope", "Adversarial auditor must be Read/Grep only", agent.id));
    }
  }

  return {
    ok: issues.length === 0,
    issue_count: issues.length,
    issues,
  };
}

function agentById(config) {
  return new Map(asArray(config?.agents).map((agent) => [agent.id, agent]));
}

export function planAgentDispatch(config, requests = []) {
  const validation = validateAgentWhitelist(config);
  const agents = agentById(config);
  const errors = [...validation.issues];
  const accepted = [];
  const advisoryFindings = [];
  const foregroundByResource = new Map();

  for (const request of asArray(requests)) {
    const agentId = norm(request.agent_id);
    const agent = agents.get(agentId);
    if (!agent) {
      errors.push(issue("agent_not_whitelisted", `Agent ${agentId || "(missing)"} is not whitelisted`, agentId || null));
      continue;
    }
    if (request.requested_by !== "planner_orchestrator") {
      errors.push(issue("dispatch_not_from_orchestrator", "Only planner_orchestrator may dispatch agents", agentId));
      continue;
    }
    const requestedMode = lower(request.mode || (agent.authority === "foreground_writer" ? "foreground" : "background"));
    if (requestedMode === "foreground") {
      if (agent.authority !== "foreground_writer") {
        errors.push(issue("foreground_authority_missing", "Only foreground_writer agents may run foreground", agentId));
        continue;
      }
      const resource = norm(request.resource || "shared_state");
      if (foregroundByResource.has(resource)) {
        errors.push(issue("foreground_writer_conflict", `Foreground writer conflict for ${resource}`, agentId));
        continue;
      }
      foregroundByResource.set(resource, agentId);
    } else if (agent.authority === "foreground_writer") {
      errors.push(issue("foreground_writer_demoted", "Foreground writer agents cannot be launched as background readers", agentId));
      continue;
    } else {
      advisoryFindings.push({
        agent_id: agentId,
        resource: norm(request.resource || "shared_state"),
        phase: norm(request.phase || agent.phase),
        advisory: true,
      });
    }
    accepted.push({ ...request, agent });
  }

  return {
    ok: errors.length === 0,
    accepted,
    errors,
    advisory_findings: advisoryFindings,
  };
}

export { DEFAULT_CONFIG_PATH as AGENT_ORCHESTRATION_CONFIG_PATH };
