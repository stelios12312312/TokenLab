#!/usr/bin/env node
// ive_release_handoff.mjs - IVE Runtime Phase 6 release-handoff CLI.

import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { buildReleaseHandoffReport, parseReleaseHandoffArgs } from "./lib/ive_release_handoff.mjs";

function printText(report) {
  console.log(`IVE Runtime Phase 6 Release Handoff: ${report.status}`);
  console.log(`  ticket:  ${report.ticket_id}`);
  console.log(`  plans:   ${report.selected_plan_count}/${report.plans_requested}`);
  if (report.report_paths?.json_path) console.log(`  report:  ${report.report_paths.json_path}`);
  for (const [name, check] of Object.entries(report.checks || {})) {
    console.log(`  ${check.status} ${name}`);
  }
  if (report.issues?.length) {
    console.log("  issues:");
    for (const issue of report.issues) console.log(`    - ${issue.code}: ${issue.message}`);
  }
  if (report.warnings?.length) {
    console.log("  warnings:");
    for (const warning of report.warnings) console.log(`    - ${warning.code}: ${warning.message}`);
  }
}

function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const args = parseReleaseHandoffArgs(argv);
  const report = buildReleaseHandoffReport(cwd, {
    plans: args.plans,
    writeReport: args.writeReport,
    runRollbackDrill: args.runRollbackDrill,
  });
  if (args.json) emitJson(report);
  else printText(report);
  return report.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { main };
