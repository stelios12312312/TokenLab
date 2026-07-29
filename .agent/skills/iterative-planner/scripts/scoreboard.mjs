#!/usr/bin/env node
// scoreboard.mjs - E2-5 one-command autocoder regression scoreboard.

import {
  renderScoreboardText,
  runScoreboard,
} from "./lib/scoreboard.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/scoreboard.mjs [--json] [--baseline <path>] [--run-id <id>] [--out-dir <path>] [--no-write] [--sample] [--inject-seeded-regression] [--conformance-timeout-ms <n>]

Options:
  --json                         Emit machine-readable JSON.
  --baseline <path>              Baseline JSON path.
  --run-id <id>                  Stable artifact run id.
  --out-dir <path>               Scoreboard artifact root.
  --no-write                     Do not write scoreboard.json.
  --sample                       Use deterministic sample inputs for tests.
  --inject-seeded-regression     Force a seeded-defect regression for negative tests.
  --conformance-timeout-ms <n>   Timeout for the live conformance subprocess.`;
}

if (isDirectInvocation(import.meta.url)) {
  try {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      console.log(usage());
      process.exit(0);
    }
    const result = runScoreboard(process.argv.slice(2));
    if (process.argv.includes("--json")) {
      emitJson(result.report);
    } else {
      console.log(renderScoreboardText(result.report));
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    const failure = {
      schema_version: 1,
      scoreboard_id: "ive_autocoder_v2_scoreboard",
      ok: false,
      status: "FAIL",
      error: error.message,
    };
    if (process.argv.includes("--json")) {
      emitJson(failure);
    } else {
      console.error(`ERROR: ${error.message}`);
    }
    process.exit(1);
  }
}
