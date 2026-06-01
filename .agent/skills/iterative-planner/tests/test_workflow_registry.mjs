#!/usr/bin/env node
// test_workflow_registry.mjs — contract coverage for workflow_registry.json.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const registryPath = join(plannerRoot, ".agent", "skills", "iterative-planner", "config", "workflow_registry.json");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
const workflows = Array.isArray(parsed?.workflows) ? parsed.workflows : [];
const ids = workflows.map((entry) => entry.id);
const requiredIds = [
  "/advisor",
  "/safe-change",
  "/safe-plan",
  "/safe-change-power",
  "/steward",
  "/program-manager",
  "/ticket-traceability-repair",
  "/roadmap-steward",
  "/sme-improvement",
  "/recipe-discovery",
  "/recipe-tidy",
  "/recipe-bootstrap",
];

assert(parsed?.version === 1, "workflow_registry version is pinned");
assert(workflows.length >= requiredIds.length, "workflow_registry exposes the blocking workflow set");
assert(new Set(ids).size === ids.length, "workflow_registry ids are unique");
assert(requiredIds.every((id) => ids.includes(id)), "workflow_registry includes every blocking workflow id");

for (const workflow of workflows) {
  assert(typeof workflow.purpose === "string" && workflow.purpose.trim().length > 0, `${workflow.id} has a purpose`);
  assert(Array.isArray(workflow.trigger_tags), `${workflow.id} has trigger tags`);
  assert(Array.isArray(workflow.route_tags), `${workflow.id} has route tags`);
  assert(["tier0", "tier1", "tier2"].includes(workflow.search_tier), `${workflow.id} uses a supported search tier`);
  assert(Array.isArray(workflow.dispatch_targets), `${workflow.id} has dispatch targets`);
  assert(Array.isArray(workflow.skill_hints), `${workflow.id} has skill hints`);
  assert(Array.isArray(workflow.preferred_personas), `${workflow.id} declares preferred personas`);
  assert(Array.isArray(workflow.required_inputs) && workflow.required_inputs.length > 0, `${workflow.id} declares required inputs`);
  assert(Array.isArray(workflow.canonical_outputs) && workflow.canonical_outputs.length > 0, `${workflow.id} declares canonical outputs`);
}

const smeImprovement = workflows.find((entry) => entry.id === "/sme-improvement");
assert(Array.isArray(smeImprovement?.preferred_personas) && smeImprovement.preferred_personas.includes("quant"), "/sme-improvement advertises quant persona affinity");
assert(Array.isArray(smeImprovement?.dispatch_targets) && smeImprovement.dispatch_targets.includes("/steward"), "/sme-improvement can dispatch back to /steward when drift dominates");

const advisor = workflows.find((entry) => entry.id === "/advisor");
assert(Array.isArray(advisor?.dispatch_targets) && advisor.dispatch_targets.includes("/ticket-traceability-repair"), "/advisor can dispatch existing ticket traceability blockers to /ticket-traceability-repair");

const recipeDiscovery = workflows.find((entry) => entry.id === "/recipe-discovery");
assert(Array.isArray(recipeDiscovery?.trigger_tags) && recipeDiscovery.trigger_tags.includes("recipe proposal"), "/recipe-discovery advertises recipe proposal wording in trigger tags");
assert(Array.isArray(recipeDiscovery?.route_tags) && recipeDiscovery.route_tags.includes("prompt-to-recipe"), "/recipe-discovery advertises prompt-to-recipe routing metadata");

const safePlan = workflows.find((entry) => entry.id === "/safe-plan");
assert(Array.isArray(safePlan?.trigger_tags) && safePlan.trigger_tags.includes("planning only"), "/safe-plan advertises planning-only wording in trigger tags");
assert(Array.isArray(safePlan?.trigger_tags) && safePlan.trigger_tags.includes("no code"), "/safe-plan advertises no-code wording in trigger tags");
assert(Array.isArray(safePlan?.route_tags) && safePlan.route_tags.includes("implementation-plan"), "/safe-plan advertises implementation-plan routing metadata");
assert(Array.isArray(safePlan?.dispatch_targets) && safePlan.dispatch_targets.includes("/safe-change-power"), "/safe-plan can escalate future implementation toward /safe-change-power");
assert(Array.isArray(safePlan?.canonical_outputs) && safePlan.canonical_outputs.includes("plan_audit_handoff"), "/safe-plan advertises the audit-backed planning handoff output");
assert(Array.isArray(safePlan?.related_failure_codes) && safePlan.related_failure_codes.includes("GATE-PLN-023"), "/safe-plan surfaces the planning-only validator failure codes");

const programManager = workflows.find((entry) => entry.id === "/program-manager");
assert(Array.isArray(programManager?.trigger_tags) && programManager.trigger_tags.includes("program packet"), "/program-manager advertises program packet wording in trigger tags");
assert(Array.isArray(programManager?.trigger_tags) && programManager.trigger_tags.includes("idea-to-ticket"), "/program-manager advertises idea-to-ticket wording in trigger tags");
assert(Array.isArray(programManager?.trigger_tags) && programManager.trigger_tags.includes("backlog intake"), "/program-manager advertises backlog intake wording in trigger tags");
assert(Array.isArray(programManager?.route_tags) && programManager.route_tags.includes("idea-intake"), "/program-manager advertises idea-intake routing metadata");
assert(Array.isArray(programManager?.dispatch_targets) && programManager.dispatch_targets.includes("/safe-change-power"), "/program-manager can dispatch high-risk child plans to /safe-change-power");
assert(Array.isArray(programManager?.canonical_outputs) && programManager.canonical_outputs.includes("program_packet.json"), "/program-manager advertises Program Packet output");

const ticketTraceabilityRepair = workflows.find((entry) => entry.id === "/ticket-traceability-repair");
assert(Array.isArray(ticketTraceabilityRepair?.trigger_tags) && ticketTraceabilityRepair.trigger_tags.includes("needs_story"), "/ticket-traceability-repair advertises needs_story wording");
assert(Array.isArray(ticketTraceabilityRepair?.trigger_tags) && ticketTraceabilityRepair.trigger_tags.includes("ticket_without_traceability"), "/ticket-traceability-repair advertises deterministic blocker wording");
assert(Array.isArray(ticketTraceabilityRepair?.route_tags) && ticketTraceabilityRepair.route_tags.includes("story-linkage"), "/ticket-traceability-repair advertises story-linkage routing metadata");
assert(Array.isArray(ticketTraceabilityRepair?.dispatch_targets) && ticketTraceabilityRepair.dispatch_targets.includes("/story-bootstrap"), "/ticket-traceability-repair can dispatch to story-bootstrap when substrate is weak");
assert(Array.isArray(ticketTraceabilityRepair?.dispatch_targets) && ticketTraceabilityRepair.dispatch_targets.includes("/safe-change-power"), "/ticket-traceability-repair can dispatch repaired high-risk tickets to /safe-change-power");
assert(Array.isArray(ticketTraceabilityRepair?.canonical_outputs) && ticketTraceabilityRepair.canonical_outputs.includes("repaired_program_packet"), "/ticket-traceability-repair advertises repaired Program Packet output");

const roadmapSteward = workflows.find((entry) => entry.id === "/roadmap-steward");
assert(Array.isArray(roadmapSteward?.dispatch_targets) && roadmapSteward.dispatch_targets.includes("/program-manager"), "/roadmap-steward aliases to /program-manager");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
