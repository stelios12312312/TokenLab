#!/usr/bin/env node
// test_leakage_proof.mjs — t08 artifact-backed leakage/temporal proof.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { evaluateLeakageProofArtifact } from "../packs/quant/leakage_proof.mjs";
import { createSession } from "../scripts/lib/prolog.mjs";
import { loadStoryFacts } from "../scripts/lib/fact_loader.mjs";
let generateLiveGraphPayload = null;
try {
  ({ generateLiveGraphPayload } = await import("../../../../apps/ive-visualizer/scripts/generate-live-payload.mjs"));
} catch {
  // Optional app fixture is not present in every planner installation.
}

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

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

function validArtifact(overrides = {}) {
  return {
    version: 1,
    split_evidence: {
      method: "walk_forward",
      train: { start: "2024-01-01", end: "2024-12-31" },
      validation: { start: "2025-01-01", end: "2025-06-30" },
      final_oos: { start: "2025-07-01", end: "2025-12-31" },
      folds: [
        { train_start: "2024-01-01", train_end: "2024-06-30", test_start: "2024-07-08", test_end: "2024-08-31" },
        { train_start: "2024-01-01", train_end: "2024-12-31", test_start: "2025-01-08", test_end: "2025-06-30" },
      ],
      embargo: { days: 7 },
      known_at_time_boundary: "Features are available at or before each prediction timestamp.",
    },
    source_leakage_scan: {
      status: "pass",
      tool: "audit_runner",
      artifact: "reports/quant/source-leakage.json",
      findings: [],
    },
    computed_assertions: [
      {
        id: "temporal_order",
        status: "pass",
        computed: true,
        provenance: {
          source_artifact: "stage0_audit.json",
          algorithm: "compare train, validation, and final_oos window boundaries",
        },
      },
      {
        id: "known_at_time_boundary",
        status: "pass",
        computed: true,
        provenance: {
          source_artifact: "stage0_audit.json",
          algorithm: "verify feature availability boundary exists for each split",
        },
      },
    ],
    ...overrides,
  };
}

function blockerCodes(result) {
  return (result.blockers || []).map((entry) => entry.code || entry.reason || String(entry));
}

function scenarioValidArtifactPasses() {
  const result = evaluateLeakageProofArtifact(validArtifact());
  assert(result.pass === true, "valid split-evidence artifact passes");
  assert(result.semantic_gate?.id === "leakage_audit", "valid artifact exposes leakage semantic gate");
  assert(result.semantic_gate?.satisfied === true, "valid artifact semantic gate is satisfied");
}

function scenarioMissingFoldAndEmbargoFail() {
  const artifact = validArtifact({
    split_evidence: {
      method: "temporal_holdout",
      train: { start: "2024-01-01", end: "2024-12-31" },
      validation: { start: "2025-01-01", end: "2025-06-30" },
      final_oos: { start: "2025-07-01", end: "2025-12-31" },
      known_at_time_boundary: "Known at prediction time.",
    },
  });
  const result = evaluateLeakageProofArtifact(artifact);
  const codes = blockerCodes(result);
  assert(result.pass === false, "missing fold and embargo evidence fails");
  assert(codes.includes("fold_boundaries_missing"), "missing folds are named blockers");
  assert(codes.includes("embargo_missing"), "missing embargo is a named blocker");
}

function scenarioBadTemporalOrderFails() {
  const artifact = validArtifact({
    split_evidence: {
      ...validArtifact().split_evidence,
      validation: { start: "2024-12-15", end: "2025-06-30" },
    },
  });
  const result = evaluateLeakageProofArtifact(artifact);
  assert(result.pass === false, "overlapping train/validation dates fail");
  assert(blockerCodes(result).includes("split_order_invalid"), "split ordering failure is explicit");
}

function scenarioQu006FindingFails() {
  const artifact = validArtifact({
    source_leakage_scan: {
      status: "pass",
      tool: "audit_runner",
      findings: [
        { id: "QU-006", severity: "high", message: "Target leakage from future label column." },
      ],
    },
  });
  const result = evaluateLeakageProofArtifact(artifact);
  assert(result.pass === false, "QU-006 source leakage finding blocks leakage proof");
  assert(blockerCodes(result).includes("source_leakage_scan_qu006"), "QU-006 blocker is explicit");
}

function scenarioDeclaredOnlyExp013ProofFails() {
  const fixturePath = join(testDir, "fixtures", "quant", "exp013_rubber_stamp_leakage_proof.json");
  const artifact = JSON.parse(readFileSync(fixturePath, "utf-8"));
  const result = evaluateLeakageProofArtifact(artifact);
  const codes = blockerCodes(result);
  assert(result.pass === false, "declared-only EXP-013 leakage proof fails");
  assert(codes.includes("computed_assertions_missing"), "missing computed assertions are named blockers");
}

function scenarioDerivedTimeSeriesTagFiresHr004() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-leakage-story-"));
  try {
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-QLEAK-001",
          title: "Rolling odds model backtest",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/models/rolling_odds_model.py"],
          postconditions: ["Backtest model reports OOS lift without temporal split proof."],
        },
        {
          id: "US-QLEAK-002",
          title: "Walk-forward forecast story",
          priority: "HIGH",
          status: "FULLY_COVERED",
          tags: ["time_series"],
          postconditions: ["temporal_split_defined(leakage_artifact)"],
        },
      ],
      infrastructure_stories: [],
    }, null, 2));

    const session = createSession();
    session.consultFile(resolve(testDir, "../prolog/invariants.pl"));
    loadStoryFacts(session, { cwd: tmp });

    assert(session.check("story_tag('US-QLEAK-001', time_series)"), "time_series tag is derived from model/backtest wording");
    assert(session.check("invariant_violated(no_temporal_split, 'US-QLEAK-001')"), "HR-004 fires for derived time_series story without temporal split postcondition");
    assert(session.check("story_tag('US-QLEAK-002', time_series)"), "explicit time_series tag is loaded");
    assert(!session.check("invariant_violated(no_temporal_split, 'US-QLEAK-002')"), "structured temporal_split_defined postcondition satisfies HR-004");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioLivePayloadSurfacesLeakageInvariant() {
  if (!generateLiveGraphPayload) {
    console.log("  SKIP: live payload visualizer app not present");
    return;
  }
  const payload = generateLiveGraphPayload({
    repoRoot,
    invariantResult: {
      status: "fail",
      count: 1,
      violations: [
        {
          id: "no_temporal_split",
          severity: "fail",
          status: "blocked",
          message: "no_temporal_split: US-QLEAK-001 requires artifact-backed temporal split evidence",
        },
      ],
    },
  });
  assert(
    payload.entities.ontology_facts.some((fact) => fact.type === "InvariantViolation" && fact.label === "no_temporal_split"),
    "live payload exposes no_temporal_split as an ontology fact",
  );
  assert(
    payload.invariant_violations.some((violation) => violation.id === "no_temporal_split" && violation.message.includes("artifact-backed temporal split")),
    "live payload exposes leakage/temporal detail in invariant_violations",
  );
}

console.log("\nLeakage Proof\n");

scenarioValidArtifactPasses();
scenarioMissingFoldAndEmbargoFail();
scenarioBadTemporalOrderFails();
scenarioQu006FindingFails();
scenarioDeclaredOnlyExp013ProofFails();
scenarioDerivedTimeSeriesTagFiresHr004();
scenarioLivePayloadSurfacesLeakageInvariant();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
