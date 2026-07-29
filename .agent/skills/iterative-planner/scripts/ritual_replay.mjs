#!/usr/bin/env node
// ritual_replay.mjs — current-code ritual E2E replay over real telemetry.

import {
  parseRitualReplayArgs,
  renderRitualReplayText,
  runRitualReplay,
} from "./lib/ritual_replay.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/ritual_replay.mjs [--json] [--fixtures-dir <path>] [--max-current-ritual-transition-rate-pct <n>] [--max-current-unknown-transition-rate-pct <n>]

Options:
  --json                                      Emit machine-readable JSON.
  --fixtures-dir <path>                       Real telemetry fixture directory.
                                              Default: .agent/skills/iterative-planner/tests/fixtures/real_telemetry
                                              Example fixture: content_marketing_site.jsonl (lightweight markdown/config content project).
  --max-current-ritual-transition-rate-pct    Fail if current ritual transition rate exceeds this percentage (default: 7).
  --target-current-ritual-transition-rate-pct Non-blocking quality target surfaced in JSON/text (default: 7).
  --max-current-unknown-transition-rate-pct   Fail if unknown/uncoded current transition rate reaches this percentage (default: 1).
  --min-fixture-count <n>                     Minimum fixture count.
  --min-transition-count <n>                  Minimum gate-transition count.
  --min-portable-agent-kit-transition-count <n> Minimum portable-agent-kit transition count.

Current replay keeps historical failures visible while excluding bounded softened legacy/advisory rows from current active blockers.`;
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const args = parseRitualReplayArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    const report = runRitualReplay(args);
    if (args.json) emitJson(report);
    else console.log(renderRitualReplayText(report));
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    const failure = {
      schema_version: 1,
      ritual_replay_id: "real_work_ritual_e2e_replay",
      ok: false,
      status: "FAIL",
      error: error.message,
    };
    if (process.argv.includes("--json")) emitJson(failure);
    else console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
