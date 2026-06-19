#!/usr/bin/env node
// project_ive.mjs - Read-only projection from legacy planner state to IVE macro-phases.

import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { runProjectionCli } from "./lib/ive_projection.mjs";

function printText(report) {
  console.log(`IVE projection: ${report.status}`);
  console.log(`Plans replayed: ${report.plans_replayed}`);
  console.log(`Gate verdict parity: ${report.gate_verdicts_byte_identical ? "byte-identical" : "drift"}`);
  for (const entry of report.projections || []) {
    if (!entry.ok) {
      console.log(`- ${entry.plan}: FAIL (${entry.error || "projection_failed"})`);
      continue;
    }
    console.log(`- ${entry.plan}: ${entry.projection.legacy_state} -> ${entry.projection.ive_macro_phase} (${entry.projection.legacy_gate_count} gate verdicts)`);
  }
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const report = runProjectionCli(argv, { cwd });
  if (report.json) {
    emitJson(report);
  } else {
    printText(report);
  }
  return report.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
