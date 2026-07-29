import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function resolveSkillDir(importMetaUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "..", "..");
}

export function getArchetypeScenarioRegistryPath(importMetaUrl = import.meta.url) {
  return join(resolveSkillDir(importMetaUrl), "config", "archetype_scenarios.json");
}

export function loadArchetypeScenarioRegistry(importMetaUrl = import.meta.url) {
  const registryPath = getArchetypeScenarioRegistryPath(importMetaUrl);
  const parsed = safeReadJson(registryPath);
  if (!parsed || typeof parsed !== "object") {
    return {
      version: 1,
      planner_core_proof_bundle: { trigger_paths: [], required_commands: [] },
      preflight_scenarios: [],
      gate_canonicalization_scenarios: [],
    };
  }
  return parsed;
}

export function listArchetypePreflightScenarios(importMetaUrl = import.meta.url) {
  const registry = loadArchetypeScenarioRegistry(importMetaUrl);
  return Array.isArray(registry.preflight_scenarios) ? registry.preflight_scenarios : [];
}

export function listGateCanonicalizationScenarios(importMetaUrl = import.meta.url) {
  const registry = loadArchetypeScenarioRegistry(importMetaUrl);
  return Array.isArray(registry.gate_canonicalization_scenarios) ? registry.gate_canonicalization_scenarios : [];
}

export function getPlannerCoreProofBundle(importMetaUrl = import.meta.url) {
  const registry = loadArchetypeScenarioRegistry(importMetaUrl);
  const bundle = registry.planner_core_proof_bundle;
  if (!bundle || typeof bundle !== "object") {
    return { trigger_paths: [], required_commands: [] };
  }
  return {
    trigger_paths: Array.isArray(bundle.trigger_paths) ? bundle.trigger_paths.filter(Boolean) : [],
    required_commands: Array.isArray(bundle.required_commands) ? bundle.required_commands.filter(Boolean) : [],
  };
}
