#!/usr/bin/env node
// test_insight_velocity_report.mjs — focused current-code IV + ritual replay report.

import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillRoot = resolve(testDir, "..");
const reportCli = join(skillRoot, "scripts", "insight_velocity_report.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function runCli(args = []) {
  const stdout = execFileSync(NODE, [reportCli, ...args], {
    cwd: resolve(skillRoot, "..", "..", ".."),
    encoding: "utf-8",
    timeout: 120000,
  });
  return stdout;
}

console.log("Insight Velocity report CLI");

const text = runCli([]);
assert(text.includes("Insight Velocity / ideation quality:"), "text report includes IV header");
assert(text.includes("Current-code ritual replay:"), "text report includes ritual replay header");
assert(text.includes("cumulative behavior-archive"), "text report notes archive exclusion");
assert(/Idea coverage:\s*100%/.test(text), "text report shows idea coverage");
assert(/Ritual transition rate:\s*5\.4%/.test(text), "text report shows ritual rate");

const json = JSON.parse(runCli(["--json"]));
assert(json.schema_version === 1, "json schema version present");
assert(typeof json.generated_at === "string", "json has generated_at");
assert(json.insight_velocity.status === "PASS", "json IV status PASS");
assert(json.insight_velocity.idea_coverage_pct === 100, "json idea coverage 100%");
assert(json.insight_velocity.false_green_rate_pct === 0, "json false-green 0%");
assert(json.ritual_replay.status === "PASS", "json ritual status PASS");
assert(json.ritual_replay.current_ritual_transition_rate_pct === 5.4, "json ritual rate 5.4%");
assert(json.ritual_replay.current_unknown_transition_rate_pct === 0.8, "json unknown rate 0.8%");
assert(json.ritual_replay.retired_gate_active_bounce_count === 0, "json retired bounces 0");
assert(!json.behavior_archive, "json does not include cumulative behavior archive");

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
