#!/usr/bin/env node
// test_planner_truth_packet.mjs — Anti-recurrence tests for planner dogfood false-green packets.

import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  buildNorthStarStatus,
  buildTruthPacketFromResults,
  normalizeSourceResult,
} from "../scripts/lib/planner_truth_packet.mjs";
import { buildNorthStarDecisionSurface } from "../scripts/lib/north_star_decision_surface.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const CLI_PATH = join(testDir, "..", "scripts", "planner_truth_packet.mjs");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function source(id, { exitCode = 0, payload = {}, stdout = null, stderr = "", durationMs = 11 } = {}) {
  return normalizeSourceResult({
    id,
    command: ["node", `${id}.mjs`, "--json"],
    exitCode,
    stdout: stdout ?? `${JSON.stringify(payload, null, 2)}\n`,
    stderr,
    durationMs,
  });
}

function riskIds(packet) {
  return new Set((packet.false_green_risks || []).map((risk) => risk.id));
}

function scenarioFlagsCanonicalStoryRegistryFalseGreen() {
  const packet = buildTruthPacketFromResults({
    generatedAt: "2026-06-25T22:00:00.000Z",
    cwd: "/fixture",
    sources: [
      source("project_health", {
        payload: { summary: { fail: 0, warn: 0, info: 1 }, status: "PASS" },
      }),
      source("story_registry_check", {
        exitCode: 1,
        payload: { status: "FAIL", errors: ["US-089 missing evidence"], warnings: [] },
      }),
      source("check_invariants", {
        payload: { status: "PASS", count: 0, violations: [] },
      }),
      source("verify_stories", {
        payload: { status: "PASS", coverage: { full: 162, missing: 52 }, stories: 214 },
      }),
      source("planner_findings", {
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
      source("escalation_check", {
        payload: { status: "WARN", required_workflows: ["/red-team-audit"] },
      }),
    ],
    northStar: buildNorthStarStatus({
      manifesto: { present: true, north_star: "Cheapest semantically valid next move" },
      artifacts: [],
      generatedAt: "2026-06-25T22:00:00.000Z",
    }),
  });

  const ids = riskIds(packet);
  assert(packet.status === "WARN", "canonical false-green packet reports WARN rather than PASS");
  assert(ids.has("story_registry_failed_while_project_health_green"), "flags project_health green while canonical story_registry check fails");
  assert(ids.has("story_registry_failed_while_invariants_pass"), "flags invariant pass while story evidence readiness fails");
  assert(ids.has("planner_findings_story_registry_disagrees_with_canonical"), "flags planner_findings mirror disagreement with canonical registry check");
  assert(ids.has("north_star_measurement_missing"), "flags missing North Star measurement artifacts");
  assert(packet.quality.false_green_count >= 4, "quality metrics count false-green risks");
  assert(packet.quality.source_count === 6, "quality metrics count source probes");
}

function scenarioKeepsCommandFailuresAsPacketData() {
  const packet = buildTruthPacketFromResults({
    generatedAt: "2026-06-25T22:01:00.000Z",
    cwd: "/fixture",
    sources: [
      normalizeSourceResult({
        id: "planner_findings",
        command: ["node", "planner_findings.mjs", "--json"],
        exitCode: 2,
        stdout: "not json at all",
        stderr: "boom",
        durationMs: 3,
      }),
    ],
    northStar: buildNorthStarStatus({
      manifesto: { present: false },
      artifacts: [],
      generatedAt: "2026-06-25T22:01:00.000Z",
    }),
  });

  const ids = riskIds(packet);
  assert(packet.status === "ERROR", "source command/parse failures make the packet ERROR");
  assert(packet.sources.planner_findings.status === "ERROR", "malformed failed source is recorded as ERROR");
  assert(ids.has("source_command_failed"), "non-zero command exit is represented as packet data");
  assert(ids.has("source_json_parse_failed"), "malformed JSON is represented as packet data");
}

function scenarioDetectsStaleNorthStarArtifacts() {
  const northStar = buildNorthStarStatus({
    manifesto: { present: true, north_star: "Cheapest semantically valid next move" },
    artifacts: [
      {
        path: "reports/ive/test_runs/old/projection-north-star.json",
        mtime: "2026-05-01T00:00:00.000Z",
      },
    ],
    generatedAt: "2026-06-25T22:02:00.000Z",
    staleAfterDays: 14,
  });

  const packet = buildTruthPacketFromResults({
    generatedAt: "2026-06-25T22:02:00.000Z",
    cwd: "/fixture",
    sources: [],
    northStar,
  });

  assert(northStar.status === "STALE", "stale North Star artifacts are classified as STALE");
  assert(riskIds(packet).has("north_star_measurement_stale"), "stale North Star measurements are surfaced as a risk");
}

function scenarioDecisionSurfaceMarksUnconsumedSideReportAdvisory() {
  const northStar = buildNorthStarDecisionSurface({
    generatedAt: "2026-06-25T22:03:00.000Z",
    manifesto: { present: true, north_star: "Cheapest semantically valid next move" },
    artifacts: [],
    surfaceId: "planner_truth_packet",
    operatorDecisionSurface: false,
    relevant: true,
  });
  const packet = buildTruthPacketFromResults({
    generatedAt: "2026-06-25T22:03:00.000Z",
    cwd: "/fixture",
    sources: [],
    northStar,
  });

  assert(northStar.status === "MISSING_MEASUREMENT", "decision surface classifies missing measurement");
  assert(northStar.consumer_status?.status === "side_report_only", "truth packet is marked as a side-report consumer");
  assert(northStar.risks.some((entry) => entry.id === "north_star_advisory_unconsumed"), "helper surfaces unconsumed North Star advisory risk");
  assert(riskIds(packet).has("north_star_advisory_unconsumed"), "truth packet carries side-report-only advisory risk");
}

function scenarioCliSampleEmitsDeterministicJson() {
  const first = spawnSync(process.execPath, [CLI_PATH, "--sample", "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const second = spawnSync(process.execPath, [CLI_PATH, "--sample", "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let parsed = null;
  try {
    parsed = JSON.parse(first.stdout || "");
  } catch {
    parsed = null;
  }

  assert(first.status === 0, "CLI sample exits zero");
  assert(Boolean(parsed), "CLI sample emits parseable JSON");
  assert(parsed?.quality?.source_count === 8, "CLI sample includes all source probes");
  assert(parsed?.quality?.source_statuses?.ttinsights_report === "PASS", "CLI sample includes TTInsights dogfood probe");
  assert(parsed?.quality?.source_statuses?.insight_velocity_report === "PASS", "CLI sample includes Insight Velocity dogfood probe");
  assert(riskIds(parsed).has("story_registry_failed_while_project_health_green"), "CLI sample preserves false-green signal");
  assert(first.stdout === second.stdout, "CLI sample output is deterministic across repeat runs");
}

console.log("\nPlanner truth packet tests\n");
scenarioFlagsCanonicalStoryRegistryFalseGreen();
scenarioKeepsCommandFailuresAsPacketData();
scenarioDetectsStaleNorthStarArtifacts();
scenarioDecisionSurfaceMarksUnconsumedSideReportAdvisory();
scenarioCliSampleEmitsDeterministicJson();

if (failed > 0) {
  console.log(`\n${failed} failed, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} passed`);
}
