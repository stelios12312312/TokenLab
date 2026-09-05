#!/usr/bin/env node
import { resolveModelAssurance } from "./lib/model_assurance.mjs";
import { emitJson } from "./lib/emit_json.mjs";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: model_assurance.mjs inspect [--floor standard|enhanced|critical] [--task-risk ...] [--capability-profile ... --identity-provenance observed|user_declared] [--observed-failures N] [--requested-profile ...] [--json]");
  process.exit(0);
}
const command = args[0] && !args[0].startsWith("-") ? args[0] : "inspect";
if (command !== "inspect") {
  console.error(`Unknown model assurance command: ${command}`);
  process.exit(2);
}
const capabilityProfile = value("--capability-profile");
const result = resolveModelAssurance({
  configuredFloor: value("--floor") || undefined,
  taskRisk: value("--task-risk") || "standard",
  capability: capabilityProfile ? { profile: capabilityProfile, provenance: value("--identity-provenance") || "unknown" } : null,
  observedFailures: Number(value("--observed-failures") || 0),
  requestedProfile: value("--requested-profile") || null,
});
if (args.includes("--json")) emitJson(result);
else {
  console.log(`Model assurance: ${result.effective_profile}`);
  console.log(`Identity provenance: ${result.identity_provenance}`);
  console.log(`Required checks: ${result.required_checks.join(", ")}`);
  console.log("Provider/model/generation/tools: unchanged");
  for (const warning of result.warnings) console.log(`WARN: ${warning}`);
}
