#!/usr/bin/env node
// test_agent_orchestration.mjs - e05 single-writer orchestration contract.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadAgentOrchestrationConfig,
  planAgentDispatch,
  validateAgentWhitelist,
} from "../scripts/lib/agent_orchestration.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function writeConfig(root, config) {
  const path = join(root, "agent_orchestration.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

function validConfig() {
  return {
    schema_version: 1,
    orchestrator: {
      id: "planner_orchestrator",
      single_foreground_writer: true,
      no_nested_subagents: true,
    },
    agents: [
      {
        id: "phase_planner",
        phase: "PLAN",
        authority: "foreground_writer",
        model: "gpt-5",
        effort: "high",
        tools: ["Read", "Grep", "Edit"],
        writes_shared_state: true,
        allow_nested_agents: false,
      },
      {
        id: "traceability_specialist",
        phase: "PLAN",
        authority: "background_reader",
        model: "gpt-5-mini",
        effort: "medium",
        tools: ["Read", "Grep"],
        writes_shared_state: false,
        allow_nested_agents: false,
      },
      {
        id: "isolated_adversarial_auditor",
        phase: "VALIDATE",
        authority: "adversarial_auditor",
        model: "gpt-5-mini",
        effort: "medium",
        tools: ["Read", "Grep"],
        writes_shared_state: false,
        allow_nested_agents: false,
      },
    ],
  };
}

function scenarioWhitelistContract() {
  const tmp = mkdtempSync(join(tmpdir(), "e05-orchestration-"));
  try {
    const configPath = writeConfig(tmp, validConfig());
    const config = loadAgentOrchestrationConfig({ configPath });
    const validation = validateAgentWhitelist(config);

    assert(validation.ok, "valid whitelist passes contract validation", JSON.stringify(validation.issues));
    assert(config.agents.every((agent) => agent.model && agent.effort), "every whitelisted agent pins model and effort");
    assert(config.agents.every((agent) => agent.allow_nested_agents === false), "every whitelisted agent forbids nested Agent() calls");
    assert(config.agents.find((agent) => agent.id === "isolated_adversarial_auditor")?.tools.join(",") === "Read,Grep", "isolated auditor is read/grep only");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioRejectsNestedSubagentsAndMutableBackground() {
  const config = validConfig();
  config.agents.push({
    id: "unsafe_background_writer",
    phase: "REFLECT",
    authority: "background_reader",
    model: "gpt-5-mini",
    effort: "low",
    tools: ["Read", "Edit", "Agent"],
    writes_shared_state: true,
    allow_nested_agents: true,
  });

  const validation = validateAgentWhitelist(config);
  const codes = validation.issues.map((issue) => issue.code);
  assert(!validation.ok, "unsafe background writer fails contract validation");
  assert(codes.includes("nested_subagent_forbidden"), "contract rejects nested Agent() authority");
  assert(codes.includes("background_agent_not_read_only"), "contract rejects mutable background agents");
}

function scenarioSingleForegroundWriter() {
  const config = validConfig();
  const blocked = planAgentDispatch(config, [
    { agent_id: "phase_planner", requested_by: "planner_orchestrator", phase: "PLAN", resource: "plans/active/state.json", mode: "foreground" },
    { agent_id: "phase_planner", requested_by: "planner_orchestrator", phase: "PLAN", resource: "plans/active/state.json", mode: "foreground" },
  ]);

  assert(!blocked.ok, "two foreground writers cannot mutate the same shared resource");
  assert(blocked.errors.some((error) => error.code === "foreground_writer_conflict"), "foreground conflict is explicit");

  const allowed = planAgentDispatch(config, [
    { agent_id: "phase_planner", requested_by: "planner_orchestrator", phase: "PLAN", resource: "plans/active/state.json", mode: "foreground" },
    { agent_id: "traceability_specialist", requested_by: "planner_orchestrator", phase: "PLAN", resource: "plans/active/state.json", mode: "background" },
    { agent_id: "isolated_adversarial_auditor", requested_by: "planner_orchestrator", phase: "VALIDATE", resource: "plans/active/state.json", mode: "background" },
  ]);

  assert(allowed.ok, "one foreground writer plus read-only background agents is allowed", JSON.stringify(allowed.errors));
  assert(allowed.advisory_findings.length === 2, "background findings are advisory for orchestrator folding");
}

function scenarioOnlyOrchestratorDispatches() {
  const config = validConfig();
  const result = planAgentDispatch(config, [
    { agent_id: "traceability_specialist", requested_by: "phase_planner", phase: "PLAN", resource: "plans/active/state.json", mode: "background" },
  ]);

  assert(!result.ok, "subagents cannot spawn subagents");
  assert(result.errors.some((error) => error.code === "dispatch_not_from_orchestrator"), "non-orchestrator dispatch is rejected");
}

console.log("\nAgent Orchestration Contract Tests\n");
scenarioWhitelistContract();
scenarioRejectsNestedSubagentsAndMutableBackground();
scenarioSingleForegroundWriter();
scenarioOnlyOrchestratorDispatches();

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
