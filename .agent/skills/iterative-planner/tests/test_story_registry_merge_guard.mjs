#!/usr/bin/env node
// test_story_registry_merge_guard.mjs - R4 seeded collision guard for story IDs.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { createSession } from "../scripts/lib/prolog.mjs";
import { loadStoryFacts } from "../scripts/lib/fact_loader.mjs";
import { sanitizeStrictId } from "../scripts/lib/sanitize.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const storyRegistryCli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "story_registry.mjs");
const storiesRules = join(repoRoot, ".agent", "skills", "iterative-planner", "prolog", "stories.pl");
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

function writeRegistry(root, duplicate = true) {
  const registryPath = join(root, "reports", "user_story_audit", "story_registry.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    updated: "2026-07-04T00:00:00.000Z",
    stories: [
      {
        id: "US-PM-AUTO-231",
        title: "Legacy numeric auto story remains valid",
        status: "NOT_IMPLEMENTED",
      },
      {
        id: "US-PM-AUTO-HDEADBEEF00000000",
        title: "Seeded branch alpha",
        status: "NOT_IMPLEMENTED",
      },
      {
        id: duplicate ? "US-PM-AUTO-HDEADBEEF00000000" : "US-PM-AUTO-HDEADBEEF00000001",
        title: "Seeded branch beta",
        status: "NOT_IMPLEMENTED",
      },
    ],
    consolidations: [],
  }, null, 2)}\n`, "utf-8");
  return registryPath;
}

function runCheck(root) {
  const result = spawnSync(NODE, [storyRegistryCli, "check", "--json"], {
    cwd: root,
    encoding: "utf-8",
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    // Assertion below reports parse failure.
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, parsed };
}

function writeFixtureFile(root, relativePath, content = "fixture\n") {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf-8");
}

function legacyDigest(ids) {
  return createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
}

function coverageContract(legacyIds) {
  return {
    legacy_version: 1,
    current_version: 2,
    effective_at: "2026-07-22T00:00:00.000Z",
    legacy_population: {
      story_count: legacyIds.length,
      story_ids_sha256: legacyDigest(legacyIds),
    },
  };
}

function legacyStory(id = "US-LEGACY-001") {
  return {
    id,
    title: "Pinned legacy evidence remains valid",
    priority: "HIGH",
    status: "FULLY_COVERED",
    code_refs: ["src/legacy.mjs"],
    test_refs: ["tests/legacy.test.mjs"],
    doc_refs: ["docs/legacy.md"],
    validation_refs: ["tests/legacy.test.mjs"],
  };
}

function currentStory({ proof = null, id = "US-CURRENT-001" } = {}) {
  return {
    id,
    title: "Current coverage requires executed proof",
    priority: "HIGH",
    status: "FULLY_COVERED",
    coverage_contract_version: 2,
    code_refs: ["src/current.mjs"],
    test_refs: ["tests/current.test.mjs"],
    doc_refs: ["docs/current.md"],
    validation_refs: [proof?.artifact || "tests/current.test.mjs"],
    ...(proof ? { executed_proof_refs: [proof] } : {}),
  };
}

function seedEvidenceFiles(root) {
  for (const path of [
    "src/legacy.mjs",
    "tests/legacy.test.mjs",
    "docs/legacy.md",
    "src/current.mjs",
    "tests/current.test.mjs",
    "docs/current.md",
  ]) writeFixtureFile(root, path);
}

function writeCoverageRegistry(root, { stories, legacyIds = ["US-LEGACY-001"] }) {
  const registryPath = join(root, "reports", "user_story_audit", "story_registry.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    updated: "2026-07-22T00:00:00.000Z",
    coverage_contract: coverageContract(legacyIds),
    stories,
    consolidations: [],
  }, null, 2)}\n`, "utf-8");
}

function writeIveProof(root, {
  selector = "fixture-suite",
  status = "PASS",
  manifestStatus = status,
  proofStatus = status,
  exitCode = 0,
  command = "node tests/current.test.mjs",
  startedAt = "2026-07-22T00:00:00.000Z",
  finishedAt = "2026-07-22T00:00:01.000Z",
} = {}) {
  const manifestPath = "reports/ive/test_runs/fixture/manifest.json";
  const proofPath = "reports/ive/test_runs/fixture/fixture-suite.json";
  writeFixtureFile(root, manifestPath, `${JSON.stringify({
    schema_version: "ive-test-manifest.v1",
    run_id: "fixture",
    suites: [{
      id: selector,
      status: String(manifestStatus).toLowerCase(),
      command,
      proof_artifact: proofPath,
    }],
  }, null, 2)}\n`);
  writeFixtureFile(root, proofPath, `${JSON.stringify({
    id: selector,
    command,
    status: proofStatus,
    exit_code: exitCode,
    started_at: startedAt,
    finished_at: finishedAt,
  }, null, 2)}\n`);
  return { kind: "ive_suite", artifact: manifestPath, selector };
}

function writeExecutedGateProof(root, { selector = "validate-to-close" } = {}) {
  const artifact = "plans/plan_fixture/executed_test_gates.json";
  writeFixtureFile(root, artifact, `${JSON.stringify({
    schema_version: 1,
    updated_at: "2026-07-22T00:00:01.000Z",
    gates: {
      [selector]: {
        gate: selector,
        status: "passed",
        command: "node tests/current.test.mjs",
        exit_code: 0,
        started_at: "2026-07-22T00:00:00.000Z",
        finished_at: "2026-07-22T00:00:01.000Z",
      },
    },
  }, null, 2)}\n`);
  return { kind: "executed_test_gate", artifact, selector };
}

function prologCoverage(root, storyId) {
  const session = createSession();
  session.consultFile(storiesRules);
  loadStoryFacts(session, { cwd: root });
  const atom = sanitizeStrictId(storyId);
  return {
    full: session.check(`coverage(${atom}, full)`),
    partial: session.check(`coverage(${atom}, partial)`),
  };
}

console.log("\nStory Registry Merge Guard\n");

const tmp = mkdtempSync(join(tmpdir(), "story-registry-merge-guard-"));
try {
  writeRegistry(tmp, true);
  const red = runCheck(tmp);
  assert(red.status === 1, "seeded duplicate registry exits non-zero");
  assert(red.parsed?.status === "FAIL", "seeded duplicate registry reports FAIL");
  assert((red.parsed?.errors || []).some((error) => error.includes("Duplicate story ID: US-PM-AUTO-HDEADBEEF00000000")), "seeded duplicate registry names the colliding story id");

  writeRegistry(tmp, false);
  const green = runCheck(tmp);
  assert(green.status === 0, "de-collided registry exits zero");
  assert(green.parsed?.status === "PASS", "de-collided registry reports PASS");
  assert(green.parsed?.storyCount === 3, "de-collided registry keeps legacy and hash story ids");

  const registry = JSON.parse(readFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), "utf-8"));
  assert(registry.stories.some((story) => story.id === "US-PM-AUTO-231"), "legacy numeric auto-story id remains accepted by registry check");

  seedEvidenceFiles(tmp);

  const iveProof = writeIveProof(tmp);
  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: iveProof })] });
  const iveGreen = runCheck(tmp);
  assert(iveGreen.status === 0, "current FULLY_COVERED story accepts a valid executed IVE suite proof", (iveGreen.parsed?.errors || []).join("; "));
  assert(prologCoverage(tmp, "US-CURRENT-001").full, "Prolog classifies valid current executed proof as full coverage");

  const gateProof = writeExecutedGateProof(tmp);
  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: gateProof })] });
  const gateGreen = runCheck(tmp);
  assert(gateGreen.status === 0, "current FULLY_COVERED story accepts a valid executed test gate proof", (gateGreen.parsed?.errors || []).join("; "));

  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory()] });
  const pointerOnly = runCheck(tmp);
  assert(pointerOnly.status === 1, "current FULLY_COVERED story rejects file-pointer-only evidence");
  assert((pointerOnly.parsed?.errors || []).some((error) => /executed proof/i.test(error)), "pointer-only rejection names the missing executed proof");
  const pointerCoverage = prologCoverage(tmp, "US-CURRENT-001");
  assert(!pointerCoverage.full && pointerCoverage.partial, "Prolog degrades pointer-only current evidence to partial coverage");

  const failedProof = writeIveProof(tmp, { manifestStatus: "PASS", proofStatus: "FAIL", exitCode: 1 });
  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: failedProof })] });
  const failedRun = runCheck(tmp);
  assert(failedRun.status === 1, "passing manifest row cannot hide a failed observable proof result");

  const missingCommandProof = writeIveProof(tmp, { command: "" });
  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: missingCommandProof })] });
  const missingCommand = runCheck(tmp);
  assert(missingCommand.status === 1, "executed proof without a recorded command fails closed");

  const missingTimestampProof = writeIveProof(tmp, { finishedAt: "" });
  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: missingTimestampProof })] });
  const missingTimestamp = runCheck(tmp);
  assert(missingTimestamp.status === 1, "executed proof without a complete dated execution window fails closed");

  const selectorProof = writeIveProof(tmp);
  const selectorMismatch = { ...selectorProof, selector: "missing-suite" };
  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: selectorMismatch })] });
  const missingSelector = runCheck(tmp);
  assert(missingSelector.status === 1, "selector-mismatched executed proof fails closed");

  const malformedProof = writeIveProof(tmp);
  writeFixtureFile(tmp, malformedProof.artifact, "{not-json\n");
  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: malformedProof })] });
  const malformed = runCheck(tmp);
  assert(malformed.status === 1, "malformed executed proof artifact fails closed");

  const oversizedProof = writeIveProof(tmp);
  writeFixtureFile(tmp, oversizedProof.artifact, "x".repeat(1_048_577));
  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: oversizedProof })] });
  const oversized = runCheck(tmp);
  assert(oversized.status === 1, "oversized executed proof artifact fails closed before parsing");

  const unlinkedProof = writeIveProof(tmp);
  const unlinkedStory = currentStory({ proof: unlinkedProof });
  unlinkedStory.validation_refs = ["tests/current.test.mjs"];
  writeCoverageRegistry(tmp, { stories: [legacyStory(), unlinkedStory] });
  const unlinked = runCheck(tmp);
  assert(unlinked.status === 1, "executed proof not linked through validation_refs fails closed");

  const sharedProof = writeIveProof(tmp);
  const provedStory = currentStory({ proof: sharedProof, id: "US-CURRENT-PROVED" });
  const borrowingStory = currentStory({ id: "US-CURRENT-BORROWING" });
  borrowingStory.validation_refs = [sharedProof.artifact];
  writeCoverageRegistry(tmp, { stories: [legacyStory(), provedStory, borrowingStory] });
  const borrowingCoverage = prologCoverage(tmp, "US-CURRENT-BORROWING");
  assert(prologCoverage(tmp, "US-CURRENT-PROVED").full, "executed proof remains valid for its declaring story");
  assert(!borrowingCoverage.full && borrowingCoverage.partial, "one story cannot borrow another story's executed proof fact");

  writeCoverageRegistry(tmp, { stories: [legacyStory(), currentStory({ proof: { kind: "ive_suite", artifact: "../outside.json", selector: "fixture-suite" } })] });
  const escaping = runCheck(tmp);
  assert(escaping.status === 1, "executed proof path escaping the project root fails closed");

  writeCoverageRegistry(tmp, { stories: [legacyStory()] });
  const legacyGreen = runCheck(tmp);
  assert(legacyGreen.status === 0, "pinned legacy FULLY_COVERED evidence remains valid without executed proof", (legacyGreen.parsed?.errors || []).join("; "));
  assert(prologCoverage(tmp, "US-LEGACY-001").full, "Prolog preserves pinned legacy full coverage");

  writeCoverageRegistry(tmp, {
    stories: [legacyStory(), legacyStory("US-LEGACY-UNAUTHORIZED")],
    legacyIds: ["US-LEGACY-001"],
  });
  const legacyExpansion = runCheck(tmp);
  assert(legacyExpansion.status === 1, "unversioned story growth cannot silently expand the pinned legacy population");
  assert((legacyExpansion.parsed?.errors || []).some((error) => /legacy population/i.test(error)), "legacy expansion rejection names the population pin mismatch");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
