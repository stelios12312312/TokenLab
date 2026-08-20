#!/usr/bin/env node

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  auditCoverageRatchet,
  COVERAGE_TARGETS,
  preserveByteUnchangedCoverageRows,
  resolveCoverageWorkloadSuiteIds,
  summarizeFailedIveSuites,
  validateBaselineArtifact,
} from "../scripts/coverage_baseline.mjs";

const testDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const baselinePath = join(skillDir, "config", "coverage_baseline.json");
let passed = 0;
let failed = 0;

function assert(condition, message, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}${detail ? ` — ${detail}` : ""}`);
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function row(file, sourceHash, pct = 50) {
  const metric = { total: 10, covered: 5, skipped: 0, pct };
  return { file, source_hash: sourceHash, metrics: { lines: { ...metric }, branches: { ...metric }, functions: { ...metric }, statements: { ...metric } } };
}

function artifact(rows) {
  return { schema_version: 1, targets: rows };
}

const stablePrevious = row("scripts/stable.mjs", "a".repeat(64), 80);
const stableMeasured = row("scripts/stable.mjs", "a".repeat(64), 70);
const changedMeasured = row("scripts/changed.mjs", "c".repeat(64), 75);
const stabilized = preserveByteUnchangedCoverageRows(
  artifact([stableMeasured, changedMeasured]),
  artifact([stablePrevious, row("scripts/changed.mjs", "b".repeat(64), 90)]),
);
assert(stabilized.targets[0] === stablePrevious, "measurement preserves the committed row for byte-unchanged targets");
assert(stabilized.targets[1] === changedMeasured, "measurement keeps fresh evidence for byte-changed targets");
assert(
  preserveByteUnchangedCoverageRows(artifact([stableMeasured]), null).targets[0] === stableMeasured,
  "first measurement keeps fresh evidence without inventing a prior floor",
);

const canonical = JSON.parse(readFileSync(baselinePath, "utf8"));
const canonicalValidation = validateBaselineArtifact(canonical, { repoRoot });
assert(COVERAGE_TARGETS.length === 20, "coverage target contract contains exactly twenty scripts");
assert(new Set(COVERAGE_TARGETS).size === 20, "coverage targets are unique");
assert(canonicalValidation.status === "PASS", "canonical baseline is complete and source-fresh", canonicalValidation.issues.join("; "));
const committedBaselineRead = spawnSync(
  "git",
  ["show", "HEAD:.agent/skills/iterative-planner/config/coverage_baseline.json"],
  { cwd: repoRoot, encoding: "utf8" },
);
let committedBaseline = null;
try {
  committedBaseline = committedBaselineRead.status === 0
    ? JSON.parse(committedBaselineRead.stdout || "null")
    : null;
} catch {
  // The assertion below reports an unreadable committed baseline.
}
const committedRows = new Map((committedBaseline?.targets || []).map((entry) => [entry.file, entry]));
const loweredCanonicalFloors = [];
for (const currentRow of canonical.targets || []) {
  const committedRow = committedRows.get(currentRow.file);
  if (!committedRow) continue;
  for (const metric of ["lines", "branches", "functions", "statements"]) {
    const before = committedRow.metrics?.[metric]?.pct;
    const after = currentRow.metrics?.[metric]?.pct;
    if (Number.isFinite(before) && Number.isFinite(after) && after < before) {
      loweredCanonicalFloors.push(`${currentRow.file} ${metric}: ${before} -> ${after}`);
    }
  }
}
assert(
  committedBaselineRead.status !== 0 || (committedBaseline && loweredCanonicalFloors.length === 0),
  "canonical baseline never lowers a committed coverage floor",
  loweredCanonicalFloors.join("; ") || committedBaselineRead.stderr,
);
const workloadSuiteIds = await resolveCoverageWorkloadSuiteIds();
assert(workloadSuiteIds.length > 0, "coverage measurement resolves a non-empty governed workload");
assert(new Set(workloadSuiteIds).size === workloadSuiteIds.length, "coverage measurement workload has unique suite IDs");
assert(!workloadSuiteIds.includes("planner-core-coverage-ratchet"), "coverage measurement excludes its recursive ratchet suite");
assert(!workloadSuiteIds.includes("cli-determinism"), "coverage measurement excludes timing-sensitive CLI determinism");
assert(workloadSuiteIds.includes("planner-shell-wrapper-hooks"), "coverage measurement includes governed pre-commit wrapper proof");
assert(workloadSuiteIds.includes("harvest-real-telemetry"), "coverage measurement includes bootstrap reachability branch proof");

const failedSuiteSummary = summarizeFailedIveSuites(JSON.stringify({
  results: [
    { id: "pass-suite", required: true, status: "PASS", exit_code: 0 },
    { id: "failed-suite", required: true, status: "FAIL", exit_code: 1, stderr_excerpt: "exact failure" },
    { id: "timeout-suite", required: true, status: "TIMEOUT", timed_out: true },
    { id: "optional-suite", required: false, status: "FAIL", exit_code: 1 },
  ],
}));
assert(
  failedSuiteSummary.map((entry) => entry.id).join(",") === "failed-suite,timeout-suite",
  "coverage failure diagnostics list every required non-passing suite",
);
assert(
  failedSuiteSummary[0]?.detail === "exact failure"
    && failedSuiteSummary[1]?.timed_out === true,
  "coverage failure diagnostics preserve bounded actionable details",
);

const fixtureRoot = mkdtempSync(join(tmpdir(), "coverage-ratchet-"));
try {
  const target = "scripts/example.mjs";
  const targetPath = join(fixtureRoot, target);
  mkdirSync(resolve(targetPath, ".."), { recursive: true });
  writeFileSync(targetPath, "export const value = 1;\n");
  const sourceHash = hash("export const value = 1;\n");
  const previous = artifact([row(target, sourceHash, 50)]);

  let current = artifact([row(target, sourceHash, 50)]);
  let result = auditCoverageRatchet({ currentBaseline: current, previousBaseline: previous, changedFiles: [target], repoRoot: fixtureRoot, expectedTargets: [target] });
  assert(result.status === "PASS", "equal modified-script coverage passes");
  assert(result.modified_targets.length === 1, "modified target is named in the result");

  current = artifact([row(target, sourceHash, 60)]);
  result = auditCoverageRatchet({ currentBaseline: current, previousBaseline: previous, changedFiles: [target], repoRoot: fixtureRoot, expectedTargets: [target] });
  assert(result.status === "PASS", "improved modified-script coverage passes");

  for (const metric of ["lines", "branches", "functions", "statements"]) {
    current = artifact([row(target, sourceHash, 50)]);
    current.targets[0].metrics[metric].pct = 49.99;
    result = auditCoverageRatchet({ currentBaseline: current, previousBaseline: previous, changedFiles: [target], repoRoot: fixtureRoot, expectedTargets: [target] });
    assert(result.status === "FAIL", `${metric} regression fails`);
    assert(result.issues.some((issue) => issue.includes(`${metric} coverage dropped: 50 -> 49.99`)), `${metric} diagnostic names baseline and current value`);
  }

  current = artifact([row(target, sourceHash, 1)]);
  result = auditCoverageRatchet({ currentBaseline: current, previousBaseline: previous, changedFiles: ["docs/readme.md"], repoRoot: fixtureRoot, expectedTargets: [target] });
  assert(result.status === "PASS", "unchanged target is not percentage-gated");

  current = artifact([row(target, "0".repeat(64), 50)]);
  result = auditCoverageRatchet({ currentBaseline: current, previousBaseline: previous, changedFiles: [target], repoRoot: fixtureRoot, expectedTargets: [target] });
  assert(result.status === "FAIL", "stale source hash fails closed");
  assert(result.issues.some((issue) => issue.includes(`stale source_hash: ${target}`)), "stale diagnostic names the target");

  result = auditCoverageRatchet({ currentBaseline: artifact([]), previousBaseline: previous, changedFiles: [target], repoRoot: fixtureRoot, expectedTargets: [target] });
  assert(result.status === "FAIL", "missing current baseline row fails closed");

  current = artifact([row(target, sourceHash, 50)]);
  result = auditCoverageRatchet({ currentBaseline: current, previousBaseline: null, changedFiles: [target], repoRoot: fixtureRoot, expectedTargets: [target] });
  assert(result.status === "PASS" && result.compared_to_head === false, "first baseline passes without inventing historical thresholds");

  current = artifact([row(target, sourceHash, 50), row(target, sourceHash, 50)]);
  result = auditCoverageRatchet({ currentBaseline: current, previousBaseline: null, changedFiles: [], repoRoot: fixtureRoot, expectedTargets: [target] });
  assert(result.status === "FAIL" && result.issues.some((issue) => issue.includes("unique")), "duplicate target rows fail closed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const canonicalCheck = spawnSync(
  process.execPath,
  [join(skillDir, "scripts", "coverage_baseline.mjs"), "check", "--json"],
  { cwd: repoRoot, encoding: "utf8" },
);
let canonicalCheckPayload = null;
try {
  canonicalCheckPayload = JSON.parse(canonicalCheck.stdout || "{}");
} catch {
  // The assertion below reports the non-JSON output without hiding the failure.
}
assert(
  canonicalCheck.status === 0 && canonicalCheckPayload?.status === "PASS",
  "canonical modified-script ratchet passes against the committed HEAD baseline",
  canonicalCheckPayload?.issues?.join("; ") || canonicalCheck.stderr || canonicalCheck.stdout,
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
