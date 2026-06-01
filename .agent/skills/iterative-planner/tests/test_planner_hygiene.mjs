#!/usr/bin/env node
// test_planner_hygiene.mjs — focused regression coverage for planner_hygiene.mjs

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const sourceScriptsDir = join(plannerRoot, ".agent", "skills", "iterative-planner", "scripts");
const sourceMigrate = join(sourceScriptsDir, "migrate.mjs");
const NODE = process.execPath;

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

function extractJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // ignore
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function run(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-hygiene-${name}-`));
}

function installPlannerFixture(cwd) {
  const upgrade = run([sourceMigrate, "upgrade", cwd], plannerRoot);
  assert(upgrade.ok, "migrate upgrade installs planner into the hygiene fixture");
}

function seedFixtureReports(cwd) {
  mkdirSync(join(cwd, "reports", "user_story_audit"), { recursive: true });

  writeFileSync(join(cwd, "reports", "remediation_queue.md"), `# Unified Remediation Queue
Generated: 2026-03-26
Starting commit: abc1234

## Queue (ordered by: severity DESC, then dependency order)

| # | ID | Source | Severity | Title | File(s) | Depends On | Status |
|---|----|--------|----------|-------|---------|------------|--------|
| 1 | F-001 | red-team | HIGH | Missing sanitizer | \`src/config.ts\` | -- | PENDING |
`);

  writeFileSync(join(cwd, "reports", "full_review_summary.md"), `# Full Review & Fix Summary
**Date**: 2026-03-27

## Remediation Results
| Status | Count | Items |
|--------|-------|-------|
| DONE | 1 | F-001 (Missing sanitizer) |
`);

  writeFileSync(join(cwd, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    updated: "2026-04-09T12:00:00Z",
    stories: [
      {
        id: "US-001",
        title: "[persona] [ux_ui] accessibility: No accessibility coverage story found in the story registry",
        status: "draft",
        source: "persona",
        code_refs: ["scripts/transition.mjs"],
        test_refs: [],
        validation_refs: [],
      },
    ],
  }, null, 2));
}

function seedCleanupOnlyReports(cwd) {
  mkdirSync(join(cwd, "reports", "user_story_audit"), { recursive: true });

  writeFileSync(join(cwd, "reports", "remediation_queue.md"), `# Unified Remediation Queue
Generated: 2026-03-26
Starting commit: abc1234

## Queue (ordered by: severity DESC, then dependency order)

| # | ID | Source | Severity | Title | File(s) | Depends On | Status |
|---|----|--------|----------|-------|---------|------------|--------|
| 1 | F-001 | red-team | HIGH | Missing sanitizer | \`src/config.ts\` | -- | PENDING |
`);

  writeFileSync(join(cwd, "reports", "full_review_summary.md"), `# Full Review & Fix Summary
**Date**: 2026-03-27

## Remediation Results
| Status | Count | Items |
|--------|-------|-------|
| DONE | 1 | F-001 (Missing sanitizer) |
`);

  writeFileSync(join(cwd, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    updated: "2026-04-09T12:00:00Z",
    stories: [
      {
        id: "US-101",
        title: "Planner transition diagnostics stay documented",
        status: "PLANNED",
        source: "user",
        code_refs: ["scripts/transition.mjs"],
        test_refs: [],
        validation_refs: [],
      },
      {
        id: "US-102",
        title: "Planner hygiene status drift stays synced",
        status: "PLANNED",
        source: "user",
        code_refs: ["scripts/planner_hygiene.mjs"],
        test_refs: [],
        validation_refs: [],
      },
    ],
  }, null, 2));
}

function scenarioScanBucketsDeterministicRepairVsJudgment() {
  const tmp = makeTemp("scan");
  try {
    installPlannerFixture(tmp);
    seedFixtureReports(tmp);

    const result = run([
      join(tmp, ".agent/skills/iterative-planner/scripts/planner_hygiene.mjs"),
      "scan",
      "--json",
    ], tmp);

    assert(result.ok, "planner_hygiene scan exits cleanly");
    const parsed = extractJson(result.stdout);
    assert(!!parsed, "planner_hygiene scan emits valid JSON");
    assert(parsed?.summary?.auto_fix_count === 2, "planner_hygiene scan finds the two deterministic auto-fix candidates");
    assert((parsed?.auto_fix || []).some((item) => item.kind === "report_status_drift" && item.entry_id === "F-001"), "planner_hygiene scan flags remediation queue status drift");
    assert((parsed?.auto_fix || []).some((item) => item.kind === "story_registry_ref_prefix" && item.story_id === "US-001"), "planner_hygiene scan flags broken planner-local story refs with shipped targets");
    assert((parsed?.needs_decision || []).some((item) => String(item.detail || "").includes("placeholder_story_registry")), "planner_hygiene scan keeps placeholder registries in needs_decision");
    assert((parsed?.needs_decision || []).some((item) => String(item.detail || "").includes("unknown status 'draft'")), "planner_hygiene scan keeps invalid story statuses in needs_decision");
    assert(parsed?.audit_posture === "normal", "planner_hygiene scan keeps cleanup-only semantic drift in normal posture when no hidden-risk hunt is active");
    assert(parsed?.recommended_path === "bootstrap_semantics", "planner_hygiene scan keeps semantic bootstrap ahead of cleanup when semantic substrate is still missing");
    assert(!!parsed?.anti_ritual, "planner_hygiene scan exposes the additive anti_ritual contract");
    assert(!(parsed?.auto_fix || []).some((item) => item.kind === "anti_ritual"), "planner_hygiene scan never treats anti-ritual drift as auto-fixable");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCleanupPathWinsWhenOnlyDeterministicRepairsRemain() {
  const tmp = makeTemp("cleanup-path");
  try {
    installPlannerFixture(tmp);
    seedCleanupOnlyReports(tmp);

    const result = run([
      join(tmp, ".agent/skills/iterative-planner/scripts/planner_hygiene.mjs"),
      "scan",
      "--json",
    ], tmp);

    assert(result.ok, "planner_hygiene scan exits cleanly for cleanup-only fixtures");
    const parsed = extractJson(result.stdout);
    assert(!!parsed, "planner_hygiene scan emits valid JSON for cleanup-only fixtures");
    assert(parsed?.summary?.auto_fix_count === 3, "planner_hygiene scan still finds deterministic cleanup candidates for cleanup-only fixtures");
    assert(parsed?.recommended_path === "cleanup", "planner_hygiene scan recommends cleanup when only deterministic repairs remain");
    assert(!!parsed?.anti_ritual, "planner_hygiene scan keeps anti_ritual visible even when cleanup wins");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioFixSafeDryRunDoesNotWriteFiles() {
  const tmp = makeTemp("dry-run");
  try {
    installPlannerFixture(tmp);
    seedFixtureReports(tmp);
    const queueBefore = readFileSync(join(tmp, "reports", "remediation_queue.md"), "utf-8");
    const registryBefore = readFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), "utf-8");

    const result = run([
      join(tmp, ".agent/skills/iterative-planner/scripts/planner_hygiene.mjs"),
      "fix-safe",
      "--json",
    ], tmp);

    assert(result.ok, "planner_hygiene fix-safe dry-run exits cleanly");
    const parsed = extractJson(result.stdout);
    assert(!!parsed, "planner_hygiene fix-safe dry-run emits valid JSON");
    assert(parsed?.mode === "dry_run", "planner_hygiene fix-safe defaults to dry-run mode");
    assert(parsed?.pending_count === 2, "planner_hygiene fix-safe dry-run reports pending deterministic repairs");
    assert(readFileSync(join(tmp, "reports", "remediation_queue.md"), "utf-8") === queueBefore, "planner_hygiene fix-safe dry-run leaves remediation_queue.md untouched");
    assert(readFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), "utf-8") === registryBefore, "planner_hygiene fix-safe dry-run leaves story_registry.json untouched");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioFixSafeWriteRepairsOnlyDeterministicDrift() {
  const tmp = makeTemp("write");
  try {
    installPlannerFixture(tmp);
    seedFixtureReports(tmp);

    const fixResult = run([
      join(tmp, ".agent/skills/iterative-planner/scripts/planner_hygiene.mjs"),
      "fix-safe",
      "--json",
      "--write",
    ], tmp);

    assert(fixResult.ok, "planner_hygiene fix-safe --write exits cleanly");
    const parsed = extractJson(fixResult.stdout);
    assert(!!parsed, "planner_hygiene fix-safe --write emits valid JSON");
    assert(parsed?.mode === "write", "planner_hygiene fix-safe --write reports write mode");
    assert(parsed?.applied_count === 2, "planner_hygiene fix-safe --write applies the two deterministic repairs");

    const queueAfter = readFileSync(join(tmp, "reports", "remediation_queue.md"), "utf-8");
    assert(queueAfter.includes("| 1 | F-001 | red-team | HIGH | Missing sanitizer | `src/config.ts` | -- | DONE |"), "planner_hygiene fix-safe --write updates remediation_queue.md status");

    const registryAfter = JSON.parse(readFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), "utf-8"));
    assert(registryAfter.stories?.[0]?.code_refs?.[0] === ".agent/skills/iterative-planner/scripts/transition.mjs", "planner_hygiene fix-safe --write repairs planner-local story refs");
    assert(registryAfter.stories?.[0]?.status === "draft", "planner_hygiene fix-safe --write leaves semantic status judgment untouched");

    const scanAfter = run([
      join(tmp, ".agent/skills/iterative-planner/scripts/planner_hygiene.mjs"),
      "scan",
      "--json",
    ], tmp);
    const parsedAfter = extractJson(scanAfter.stdout);
    assert(parsedAfter?.summary?.auto_fix_count === 0, "planner_hygiene scan no longer reports deterministic auto-fix candidates after write mode");
    assert((parsedAfter?.needs_decision || []).some((item) => String(item.detail || "").includes("unknown status 'draft'")), "planner_hygiene scan still preserves semantic follow-up after safe fixes");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nPlanner Hygiene Tests\n");
scenarioScanBucketsDeterministicRepairVsJudgment();
scenarioCleanupPathWinsWhenOnlyDeterministicRepairsRemain();
scenarioFixSafeDryRunDoesNotWriteFiles();
scenarioFixSafeWriteRepairsOnlyDeterministicDrift();

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
