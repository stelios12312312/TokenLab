#!/usr/bin/env node
// planner_truth_packet.mjs — Deterministic dogfood packet across planner health surfaces.
// @planner:module = planner_truth_packet_cli
// @planner:capability = deterministic_planner_dogfood_false_green_packet_cli

import { spawnSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { buildNorthStarDecisionSurface } from "./lib/north_star_decision_surface.mjs";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";
import {
  buildTruthPacketFromResults,
  normalizeSourceResult,
} from "./lib/planner_truth_packet.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(__filename);
const NODE = process.execPath;

function usage() {
  return `planner_truth_packet.mjs — planner dogfood false-green measurement

Usage:
  node .agent/skills/iterative-planner/scripts/planner_truth_packet.mjs [--json] [--dir <repo>] [--fail-on-risk]
  node .agent/skills/iterative-planner/scripts/planner_truth_packet.mjs --sample --json

Default mode exits 0 when the packet itself ran, even if it reports risks.
Use --fail-on-risk to make WARN/ERROR packets exit non-zero.`;
}

function parseArgs(argv) {
  const flags = {
    json: false,
    failOnRisk: false,
    help: false,
    sample: false,
    dir: process.cwd(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--fail-on-risk") flags.failOnRisk = true;
    else if (arg === "--sample") flags.sample = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--dir" && argv[i + 1]) flags.dir = argv[++i];
    else if (arg.startsWith("--dir=")) flags.dir = arg.slice("--dir=".length);
  }
  flags.dir = resolve(flags.dir);
  return flags;
}

function runSource(cwd, source) {
  const started = Date.now();
  const proc = spawnSync(NODE, [join(SCRIPTS_DIR, source.script), ...source.args], {
    cwd,
    encoding: "utf-8",
    timeout: source.timeoutMs || 60000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const durationMs = Date.now() - started;
  const exitCode = proc.error?.code === "ETIMEDOUT"
    ? 124
    : typeof proc.status === "number"
      ? proc.status
      : proc.error
        ? 2
        : 0;

  return normalizeSourceResult({
    id: source.id,
    command: ["node", `.agent/skills/iterative-planner/scripts/${source.script}`, ...source.args],
    exitCode,
    stdout: proc.stdout || "",
    stderr: proc.stderr || (proc.error ? proc.error.message : ""),
    durationMs,
    timedOut: proc.error?.code === "ETIMEDOUT",
  });
}

function buildSources() {
  return [
    { id: "project_health", script: "project_health.mjs", args: ["--quick", "--json"], timeoutMs: 60000 },
    { id: "story_registry_check", script: "story_registry.mjs", args: ["check", "--json"], timeoutMs: 60000 },
    { id: "verify_stories", script: "rule_engine.mjs", args: ["verify-stories", "--json"], timeoutMs: 90000 },
    { id: "check_invariants", script: "rule_engine.mjs", args: ["check-invariants", "--json"], timeoutMs: 90000 },
    { id: "planner_findings", script: "planner_findings.mjs", args: ["--dir", ".", "--json"], timeoutMs: 90000 },
    { id: "ttinsights_report", script: "ttinsights_report.mjs", args: ["--json", "--max-candidates", "10", "--timeout-ms", "30000"], timeoutMs: 120000 },
    { id: "insight_velocity_report", script: "insight_velocity_report.mjs", args: ["--json"], timeoutMs: 90000 },
    { id: "escalation_check", script: "escalation_check.mjs", args: ["--json"], timeoutMs: 60000 },
  ];
}

export function buildLiveTruthPacket({ cwd = process.cwd(), generatedAt = new Date().toISOString() } = {}) {
  const sources = buildSources().map((source) => runSource(cwd, source));
  const northStar = buildNorthStarDecisionSurface({
    cwd,
    generatedAt,
    surfaceId: "planner_truth_packet",
    operatorDecisionSurface: false,
    relevant: true,
  });
  return buildTruthPacketFromResults({
    generatedAt,
    cwd,
    sources,
    northStar,
  });
}

function sampleSource(id, { exitCode = 0, payload = {}, durationMs = 1 } = {}) {
  return normalizeSourceResult({
    id,
    command: ["node", `.agent/skills/iterative-planner/scripts/${id}.mjs`, "--json"],
    exitCode,
    stdout: `${JSON.stringify(payload, null, 2)}\n`,
    stderr: "",
    durationMs,
  });
}

export function buildSampleTruthPacket() {
  const generatedAt = "2026-01-01T00:00:00.000Z";
  return buildTruthPacketFromResults({
    generatedAt,
    cwd: "/planner-truth-packet-sample",
    sources: [
      sampleSource("project_health", {
        durationMs: 1,
        payload: { status: "PASS", summary: { fail: 0, warn: 0, info: 1 } },
      }),
      sampleSource("story_registry_check", {
        exitCode: 1,
        durationMs: 2,
        payload: { status: "FAIL", errors: ["US-SAMPLE missing evidence"], warnings: [] },
      }),
      sampleSource("verify_stories", {
        durationMs: 3,
        payload: { status: "PASS", coverage: { full: 3, missing: 2 }, stories: 5 },
      }),
      sampleSource("check_invariants", {
        durationMs: 4,
        payload: { status: "PASS", count: 0, violations: [] },
      }),
      sampleSource("planner_findings", {
        durationMs: 5,
        payload: {
          status: "PASS",
          story_registry_health: {
            present: true,
            usable: true,
            blocking: false,
            errors: [],
          },
        },
      }),
      sampleSource("ttinsights_report", {
        durationMs: 6,
        payload: {
          schema_version: 1,
          status: "PASS",
          report_id: "ttinsights_ontology_guided_improvement",
          source_statuses: { ok: 7, degraded: 1, missing: 0 },
          program_manager_intake_candidates: [
            { id: "TTINSIGHTS-SAMPLE", title: "Sample dogfood candidate" },
          ],
        },
      }),
      sampleSource("insight_velocity_report", {
        durationMs: 7,
        payload: {
          schema_version: 1,
          status: "PASS",
          report_id: "insight_velocity_current_code",
          insight_velocity: { status: "PASS", idea_coverage_pct: 100 },
          ritual_replay: { status: "PASS", current_ritual_transition_rate_pct: 5.4 },
        },
      }),
      sampleSource("escalation_check", {
        durationMs: 8,
        payload: { status: "PASS", escalations: [] },
      }),
    ],
    northStar: buildNorthStarDecisionSurface({
      manifesto: { present: true, north_star: "Cheapest semantically valid next move" },
      artifacts: [{
        path: "reports/ive/test_runs/sample/projection-north-star.json",
        mtime: generatedAt,
      }],
      generatedAt,
      surfaceId: "planner_truth_packet",
      operatorDecisionSurface: false,
      relevant: true,
    }),
  });
}

function printText(packet) {
  console.log("Planner Truth Packet");
  console.log(`Status: ${packet.status}`);
  console.log(`Sources: ${packet.quality.source_count}; source errors: ${packet.quality.source_error_count}`);
  console.log(`Risks: ${packet.quality.false_green_count}`);
  console.log(`North Star: ${packet.quality.north_star_status || "unknown"}`);
  for (const risk of packet.false_green_risks || []) {
    console.log(`- ${risk.severity}: ${risk.id} — ${risk.message}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const packet = flags.sample
    ? buildSampleTruthPacket()
    : buildLiveTruthPacket({ cwd: flags.dir });
  if (flags.json) emitJson(packet);
  else printText(packet);

  if (flags.failOnRisk && !verificationStatusIsPass(packet.status, "execution")) {
    process.exitCode = 1;
  }
}

if (isDirectInvocation(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 2;
  });
}
