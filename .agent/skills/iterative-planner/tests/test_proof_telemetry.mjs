#!/usr/bin/env node
// test_proof_telemetry.mjs — focused regression coverage for planner proof telemetry.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { recordProofTelemetryFromToolUse, summarizeProofTelemetry } from "../scripts/lib/proof_telemetry.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");

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

function createPlanFixture(name, {
  goal = "Proof telemetry fixture",
  planContent = null,
} = {}) {
  const tmp = mkdtempSync(join(tmpdir(), `planner-proof-telemetry-${name}-`));
  const planName = "plan_2026-04-09_proof_telemetry";
  const planDir = join(tmp, "plans", planName);

  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeStateJson(planDir, createInitialStateJson(planName, goal, { projectRoot: tmp }));
  writeFileSync(join(planDir, "plan.md"), planContent || `# Plan

## Goal
${goal}

## Problem Statement
Proof telemetry should summarize trusted work signals.

## Files To Modify
- src/review/ChangeReviewCard.tsx

## Steps
1. Keep the summary deterministic.
`);

  return { tmp, planDir, planName };
}

function scenarioHookDerivedEventsSummarizeDeterministically() {
  const { tmp, planDir, planName } = createPlanFixture("derived-events", {
    goal: "Render {{IMAGE: concept}} placeholders in the review UI",
  });

  try {
    mkdirSync(join(tmp, "src", "review"), { recursive: true });
    writeFileSync(join(tmp, "src", "review", "ChangeReviewCard.tsx"), "export function ChangeReviewCard() { return null; }\n");

    const editWrite = recordProofTelemetryFromToolUse({
      cwd: tmp,
      planDir,
      planDirName: planName,
      phase: "EXECUTE",
      toolName: "Edit",
      toolInput: { file_path: join(tmp, "src", "review", "ChangeReviewCard.tsx") },
      paths: [join(tmp, "src", "review", "ChangeReviewCard.tsx")],
    });
    assert(editWrite.written === true, "proof telemetry hook records trusted surface events for file edits");

    const bashWrite = recordProofTelemetryFromToolUse({
      cwd: tmp,
      planDir,
      planDirName: planName,
      phase: "EXECUTE",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      paths: [],
    });
    assert(bashWrite.written === true, "proof telemetry hook records trusted proof events for recognized commands");

    const summary = summarizeProofTelemetry({
      cwd: tmp,
      planDir,
      planDirName: planName,
      persist: true,
    });

    assert(summary.mode === "present", "proof telemetry summary reports present mode when trusted events exist");
    assert(summary.surfaces.includes("browser_ui"), "proof telemetry summary derives browser_ui from touched review files");
    assert(summary.proof_events.includes("unit_test"), "proof telemetry summary infers unit_test proof from trusted command events");
    assert(summary.task_signals.includes("structural_token_output"), "proof telemetry summary keeps deterministic structural-token task signals from plan context");
    assert(readFileSync(join(planDir, "telemetry", "summary.json"), "utf-8").includes("\"browser_ui\""), "proof telemetry persists a compact summary for downstream findings");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCrossPlanEventsAndArtifactBackedProofsStayTrusted() {
  const { tmp, planDir, planName } = createPlanFixture("trust-model", {
    goal: "Stateful browser proof telemetry",
    planContent: `# Plan

## Goal
Stateful browser proof telemetry

## Problem Statement
Manual observation should only count when it carries a concrete artifact.

## Files To Modify
- src/review/SessionWizard.tsx

## Steps
1. Record trusted proof telemetry.
`,
  });

  try {
    mkdirSync(join(planDir, "telemetry"), { recursive: true });
    mkdirSync(join(tmp, "artifacts"), { recursive: true });
    writeFileSync(join(tmp, "artifacts", "manual-observation.md"), "# Observation\n\nThe wizard persisted state.\n");
    writeFileSync(join(planDir, "telemetry", "events.jsonl"), [
      JSON.stringify({
        event: "surface_touched",
        timestamp: "2026-04-09T10:00:00.000Z",
        plan_id: "plan_some_other_plan",
        repo_root: tmp,
        surface: "browser_ui",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
      JSON.stringify({
        event: "surface_touched",
        timestamp: "2026-04-09T10:00:01.000Z",
        plan_id: planName,
        repo_root: tmp,
        surface: "browser_ui",
        file: "src/review/SessionWizard.tsx",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
      JSON.stringify({
        event: "surface_touched",
        timestamp: "2026-04-09T10:00:02.000Z",
        plan_id: planName,
        repo_root: tmp,
        surface: "browser_ui",
        file: "src/review/SessionWizard.tsx",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
      JSON.stringify({
        event: "proof_recorded",
        timestamp: "2026-04-09T10:00:03.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "manual_observation",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
      JSON.stringify({
        event: "proof_recorded",
        timestamp: "2026-04-09T10:00:04.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "manual_observation",
        artifact_path: "artifacts/manual-observation.md",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
    ].join("\n") + "\n");

    const summary = summarizeProofTelemetry({
      cwd: tmp,
      planDir,
      planDirName: planName,
      persist: false,
    });

    assert(summary.mode === "partial", "proof telemetry summary reports partial mode when some trusted events are rejected");
    assert(summary.surfaces.filter((entry) => entry === "browser_ui").length === 1, "proof telemetry summary deduplicates repeated surface events");
    assert(summary.proof_events.includes("manual_observation"), "artifact-backed manual observations remain valid proof events");
    assert(!summary.proof_events.includes("visual_proof"), "proof telemetry summary does not invent proof from missing artifact-backed events");
    assert(summary.ignored_event_count >= 2, "proof telemetry summary rejects cross-plan and artifact-free proof events");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function validLeakageProofArtifact(overrides = {}) {
  return {
    version: 1,
    split_evidence: {
      method: "walk_forward",
      train: { start: "2024-01-01", end: "2024-12-31" },
      validation: { start: "2025-01-01", end: "2025-06-30" },
      final_oos: { start: "2025-07-01", end: "2025-12-31" },
      folds: [
        { train_start: "2024-01-01", train_end: "2024-06-30", test_start: "2024-07-08", test_end: "2024-08-31" },
      ],
      embargo: { days: 7 },
      known_at_time_boundary: "Features are known at prediction time.",
    },
    source_leakage_scan: {
      status: "pass",
      findings: [],
    },
    ...overrides,
  };
}

function scenarioLeakageKeywordsDoNotCreateProofEvents() {
  const { tmp, planDir, planName } = createPlanFixture("leakage-keywords", {
    goal: "Artifact-backed leakage proof telemetry",
  });

  try {
    const bashWrite = recordProofTelemetryFromToolUse({
      cwd: tmp,
      planDir,
      planDirName: planName,
      phase: "EXECUTE",
      toolName: "Bash",
      toolInput: { command: "echo leakage temporal split walk forward" },
      paths: [],
    });
    assert(bashWrite.written === true, "proof telemetry records the command action itself");

    const summary = summarizeProofTelemetry({
      cwd: tmp,
      planDir,
      planDirName: planName,
      persist: false,
    });

    assert(!summary.proof_events.includes("leakage_check"), "keyword-only leakage command is not a trusted proof event");
    assert(!summary.proof_events.includes("temporal_split_check"), "keyword-only temporal split command is not a trusted proof event");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLeakageProofEventsRequireValidArtifacts() {
  const { tmp, planDir, planName } = createPlanFixture("leakage-artifacts", {
    goal: "Artifact-backed leakage proof telemetry",
  });

  try {
    mkdirSync(join(planDir, "telemetry"), { recursive: true });
    mkdirSync(join(tmp, "artifacts"), { recursive: true });
    writeFileSync(join(tmp, "artifacts", "leakage-proof.json"), JSON.stringify(validLeakageProofArtifact(), null, 2));
    writeFileSync(join(tmp, "artifacts", "bad-leakage-proof.json"), JSON.stringify({
      split_evidence: { method: "random_shuffle" },
      source_leakage_scan: { status: "pass" },
    }, null, 2));
    writeFileSync(join(planDir, "telemetry", "events.jsonl"), [
      JSON.stringify({
        event: "proof_recorded",
        timestamp: "2026-06-03T10:00:00.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "leakage_check",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
      JSON.stringify({
        event: "proof_recorded",
        timestamp: "2026-06-03T10:00:01.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "leakage_check",
        artifact_path: "artifacts/leakage-proof.json",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
      JSON.stringify({
        event: "proof_recorded",
        timestamp: "2026-06-03T10:00:02.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "temporal_split_check",
        artifact_path: "artifacts/leakage-proof.json",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
      JSON.stringify({
        event: "proof_recorded",
        timestamp: "2026-06-03T10:00:03.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "temporal_split_check",
        artifact_path: "artifacts/bad-leakage-proof.json",
        source: "post_tool_use",
        trust_level: "trusted",
      }),
    ].join("\n") + "\n");

    const summary = summarizeProofTelemetry({
      cwd: tmp,
      planDir,
      planDirName: planName,
      persist: false,
    });

    assert(summary.proof_events.includes("leakage_check"), "valid leakage artifact backs leakage_check proof");
    assert(summary.proof_events.includes("temporal_split_check"), "valid leakage artifact backs temporal_split_check proof");
    assert(summary.ignored_event_count >= 2, "artifact-free and invalid leakage proof events are ignored");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nProof Telemetry\n");

scenarioHookDerivedEventsSummarizeDeterministically();
scenarioCrossPlanEventsAndArtifactBackedProofsStayTrusted();
scenarioLeakageKeywordsDoNotCreateProofEvents();
scenarioLeakageProofEventsRequireValidArtifacts();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
