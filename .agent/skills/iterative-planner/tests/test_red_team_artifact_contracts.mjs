#!/usr/bin/env node
// test_red_team_artifact_contracts.mjs — structured anti-pattern artifact coverage.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { collectSymmetryHunts, loadAntiPatternsArtifact } from "../scripts/lib/planner_phase_routing.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);

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

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-red-team-artifacts-${name}-`));
}

function scenarioStructuredAntiPatternsNormalizeIntoSymmetryHunts() {
  const tmp = makeTemp("normalize");
  try {
    mkdirSync(join(tmp, "reports", "red_team_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "red_team_audit", "anti_patterns.json"), JSON.stringify({
      anti_patterns: [
        {
          id: "AP-001",
          label: "Silent error swallowing in async UI flows",
          queries: ["catch", "console.error"],
          scope: ["src/", "app/"],
          confidence: "high",
          evidence_refs: ["F-001"],
          recommended_guard: "requires_red_team",
        },
        {
          id: "AP-001",
          label: "Duplicate id should dedupe",
          queries: ["catch"],
          scope: ["src/"],
          confidence: "medium",
          evidence_refs: ["F-002"],
          recommended_guard: "advisory",
        },
      ],
    }, null, 2));

    const artifact = loadAntiPatternsArtifact({ cwd: tmp });
    const hunts = collectSymmetryHunts({
      goalText: "Investigate catch handling in the UI",
      effectiveFiles: ["src/app.tsx"],
      activeMistakes: [],
      antiPatternArtifact: artifact,
    });

    assert(artifact.present === true, "loadAntiPatternsArtifact marks anti_patterns.json as present");
    assert(artifact.usable === true, "loadAntiPatternsArtifact marks anti_patterns.json as usable");
    assert(hunts.length === 1, "collectSymmetryHunts deduplicates repeated anti-pattern ids");
    assert(hunts[0]?.id === "AP-001", "collectSymmetryHunts preserves anti-pattern ids");
    assert(hunts[0]?.source === "red_team_artifact", "collectSymmetryHunts tags red-team artifact sources explicitly");
    assert(Array.isArray(hunts[0]?.queries) && hunts[0].queries.length === 2, "collectSymmetryHunts preserves anti-pattern query signatures");
    assert(Array.isArray(hunts[0]?.scope) && hunts[0].scope.length === 2, "collectSymmetryHunts preserves anti-pattern scope");
    assert(hunts[0]?.confidence === "high", "collectSymmetryHunts preserves anti-pattern confidence");
    assert(Array.isArray(hunts[0]?.evidence_refs) && hunts[0].evidence_refs[0] === "F-001", "collectSymmetryHunts preserves anti-pattern evidence refs");
    assert(hunts[0]?.recommended_guard === "requires_red_team", "collectSymmetryHunts preserves anti-pattern guard requirements");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nRed-Team Artifact Contract Tests\n");
scenarioStructuredAntiPatternsNormalizeIntoSymmetryHunts();

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
