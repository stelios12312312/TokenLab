#!/usr/bin/env node
// test_component_performance_profile.mjs — Comprehensive test suite for component_performance_profile.mjs.
// Verifies subprocess exit code checking, raw sample arrays, failure counts, query assertions, ClauseIndex benchmarking,
// isolated workspace byte-for-byte preservation, scratch file cleanup on errors, concurrency, and GATE-PLAN-001 rejection.

import assert from "assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  measurePersistence,
  measureStartup,
  runComponentProfile,
} from "../scripts/component_performance_profile.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failed++;
  }
}

async function runAllTests() {
  console.log("Running Component Performance Profiler Test Suite...\n");

  // 1. Full component profile run and structure verification
  console.log("1. Full component profile run and structure verification:");
  const profileReport = runComponentProfile({ runs: 2 });

  await test("Report contains required top-level metadata and 8 component profiles", () => {
    assert.strictEqual(profileReport.schema_version, 1);
    assert.strictEqual(profileReport.benchmark_id, "v11_phase0_component_profile");
    assert.ok(profileReport.generated_at);
    assert.ok(profileReport.host);
    assert.strictEqual(profileReport.config.runs, 2);

    const p = profileReport.profiles;
    assert.ok(p.startup, "Missing startup profile");
    assert.ok(p.scanning_and_hashing, "Missing scanning_and_hashing profile");
    assert.ok(p.ontology_projection, "Missing ontology_projection profile");
    assert.ok(p.parsing_and_indexing, "Missing parsing_and_indexing profile");
    assert.ok(p.query_solving, "Missing query_solving profile");
    assert.ok(p.subprocess, "Missing subprocess profile");
    assert.ok(p.persistence, "Missing persistence profile");
    assert.ok(p.context_size, "Missing context_size profile");
    assert.ok(profileReport.disclosed_limits?.length > 0, "Missing disclosed_limits");
  });

  // 2. Raw sample arrays and failure count preservation
  console.log("\n2. Raw sample arrays and failure count preservation:");
  await test("Stats preserve raw_samples array and failure_count across profiles", () => {
    const startup = profileReport.profiles.startup;
    assert.ok(Array.isArray(startup.node_process_startup.raw_samples));
    assert.strictEqual(startup.node_process_startup.raw_samples.length, 2);
    assert.strictEqual(typeof startup.node_process_startup.failure_count, "number");
    assert.strictEqual(startup.node_process_startup.failure_count, 0);

    const solving = profileReport.profiles.query_solving;
    assert.ok(Array.isArray(solving.grounded_lookup.raw_samples));
    assert.strictEqual(solving.grounded_lookup.raw_samples.length, 2);
    assert.strictEqual(solving.grounded_lookup.failure_count, 0);
  });

  // 3. Representative transition gate dry-run execution
  console.log("\n3. Representative transition gate execution:");
  await test("Startup profile includes transition_gate_dry_run with valid timings", () => {
    const startup = profileReport.profiles.startup;
    assert.ok(startup.transition_gate_dry_run, "Missing transition_gate_dry_run");
    assert.strictEqual(startup.transition_gate_dry_run.samples, 2);
    assert.ok(startup.transition_gate_dry_run.p50 > 0, "p50 must be positive");
    assert.strictEqual(startup.transition_gate_dry_run.failure_count, 0);
    assert.ok(startup.matched_evaluations, "Missing matched_evaluations");
    assert.strictEqual(startup.matched_evaluations.clean_gate_dry_run.samples, 2);
    assert.strictEqual(startup.matched_evaluations.clean_gate_dry_run.failure_count, 0);
    assert.strictEqual(startup.matched_evaluations.dirty_semantic_negative_gate.samples, 2);
    assert.strictEqual(startup.matched_evaluations.dirty_semantic_negative_gate.failure_count, 0);
    assert.strictEqual(startup.matched_evaluations.dirty_semantic_negative_gate.expected_failure_code, "GATE-EXP-014");
    assert.strictEqual(startup.matched_evaluations.dirty_semantic_negative_gate.verified_semantic_negative, true);
    assert.strictEqual(startup.matched_evaluations.unchanged_vs_changed.status, "unmeasured");
    assert.strictEqual(startup.matched_evaluations.cache_hit_vs_miss.status, "unmeasured");
  });

  // 4. Query solving result assertions and variable bindings
  console.log("\n4. Query solving result assertions and variable bindings:");
  await test("Query solving profile asserts result counts and variable bindings", () => {
    const solving = profileReport.profiles.query_solving;
    assert.ok(solving.verifications, "Missing query verifications");
    assert.strictEqual(solving.verifications.grounded_lookup_count, 1);
    assert.ok(solving.verifications.unbound_scan_count > 0);
    assert.ok(solving.verifications.relational_join_count > 0);
    assert.strictEqual(solving.verifications.depth_50_plus_alternatives_count, 3);
    assert.deepStrictEqual(solving.verifications.depth_50_plus_bindings, ["a", "b", "c"]);
    assert.strictEqual(solving.verifications.negative_query_count, 0);
    assert.strictEqual(solving.verifications.cyclic_pruning_count, 1);
  });

  // 5. Genuine ClauseIndex profiling vs unindexed scan
  console.log("\n5. Genuine ClauseIndex profiling vs unindexed scan:");
  await test("Parsing and indexing measures genuine ClauseIndex lookup and unindexed scan", () => {
    const pi = profileReport.profiles.parsing_and_indexing;
    assert.ok(pi.clause_indexing, "Missing clause_indexing");
    assert.ok(pi.clause_index_lookup, "Missing clause_index_lookup");
    assert.ok(pi.unindexed_scan, "Missing unindexed_scan");

    assert.strictEqual(pi.clause_indexing.samples, 2);
    assert.strictEqual(pi.clause_index_lookup.samples, 2);
    assert.strictEqual(pi.unindexed_scan.samples, 2);

    assert.ok(pi.clause_index_lookup.p50 >= 0);
    assert.ok(pi.unindexed_scan.p50 >= 0);
  });

  // 6. Isolated test workspace byte-for-byte preservation and safety
  console.log("\n6. Isolated test workspace byte-for-byte preservation and safety:");
  const testEnvDir = mkdtempSync(join(tmpdir(), "v11_perf_test_workspace_"));
  const isolatedPlansDir = join(testEnvDir, "plans");
  mkdirSync(isolatedPlansDir, { recursive: true });

  // Symlink workspace dependencies to allow transition gates to evaluate cleanly in testEnvDir
  symlinkSync(join(repoRoot, ".agent"), join(testEnvDir, ".agent"), "dir");
  if (existsSync(join(repoRoot, "audit.config.json"))) {
    symlinkSync(join(repoRoot, "audit.config.json"), join(testEnvDir, "audit.config.json"), "file");
  }
  if (existsSync(join(repoRoot, "planner.policy.yaml"))) {
    symlinkSync(join(repoRoot, "planner.policy.yaml"), join(testEnvDir, "planner.policy.yaml"), "file");
  }
  if (existsSync(join(repoRoot, "reports"))) {
    symlinkSync(join(repoRoot, "reports"), join(testEnvDir, "reports"), "dir");
  }
  if (existsSync(join(repoRoot, "plans", "knowledge"))) {
    symlinkSync(join(repoRoot, "plans", "knowledge"), join(isolatedPlansDir, "knowledge"), "dir");
  }

  const existingPlanDir = join(isolatedPlansDir, "plan_2026-09-01_existing");
  mkdirSync(existingPlanDir, { recursive: true });

  const filesToTrack = [
    {
      path: join(existingPlanDir, "state.json"),
      content: JSON.stringify({ state: "EXPLORE", plan_id: "plan_2026-09-01_existing", note: "preserve this state" }, null, 2),
    },
    {
      path: join(existingPlanDir, "guidance_packet.json"),
      content: JSON.stringify({ packet_id: "GP-TEST-001", mode: "local-only", note: "preserve this guidance" }, null, 2),
    },
    {
      path: join(isolatedPlansDir, ".perf_test_write.json"),
      content: "LEGACY_PREEXISTING_PERF_FILE_MUST_NOT_BE_MODIFIED_OR_DELETED",
    },
    {
      path: join(isolatedPlansDir, "user_sentinel_note.txt"),
      content: "PREEXISTING_USER_NOTE_SAFE_DATA",
    },
  ];

  for (const f of filesToTrack) {
    writeFileSync(f.path, f.content, "utf-8");
    f.hash = createHash("sha256").update(readFileSync(f.path)).digest("hex");
  }

  function verifyFilesPreserved() {
    for (const f of filesToTrack) {
      assert.ok(existsSync(f.path), `File ${f.path} must continue to exist`);
      const currentContent = readFileSync(f.path);
      const currentHash = createHash("sha256").update(currentContent).digest("hex");
      assert.strictEqual(
        currentHash,
        f.hash,
        `File ${f.path} was modified! Expected hash ${f.hash} but got ${currentHash}`
      );
    }
  }

  try {
    await test("Profiler preserves existing plan files and pre-existing .perf_test_write.json byte-for-byte in isolated workspace", () => {
      const profileResult = runComponentProfile({ runs: 2, projectRoot: testEnvDir, plansDir: isolatedPlansDir });
      assert.strictEqual(profileResult.profiles.startup.transition_gate_dry_run.failure_count, 0);
      assert.strictEqual(profileResult.profiles.startup.transition_gate_dry_run.samples, 2);
      assert.strictEqual(profileResult.profiles.startup.matched_evaluations.clean_gate_dry_run.failure_count, 0);
      assert.strictEqual(profileResult.profiles.startup.matched_evaluations.clean_gate_dry_run.samples, 2);
      assert.strictEqual(profileResult.profiles.startup.matched_evaluations.dirty_semantic_negative_gate.failure_count, 0);
      assert.strictEqual(profileResult.profiles.startup.matched_evaluations.dirty_semantic_negative_gate.samples, 2);
      assert.strictEqual(profileResult.profiles.startup.matched_evaluations.dirty_semantic_negative_gate.expected_failure_code, "GATE-EXP-014");
      assert.strictEqual(profileResult.profiles.startup.matched_evaluations.dirty_semantic_negative_gate.verified_semantic_negative, true);

      verifyFilesPreserved();

      // Ensure no leftover scratch files or directories in isolated workspace
      const leftovers = readdirSync(isolatedPlansDir).filter(
        (f) => f.startsWith(".perf_scratch_") || f.startsWith("plan_perf_")
      );
      assert.strictEqual(
        leftovers.length,
        0,
        `Expected 0 leftover scratch dirs in isolated workspace, found: ${leftovers.join(", ")}`
      );

      // Verify no test sentinels or scratch files were written to the live workspace plans dir
      const livePlans = join(repoRoot, "plans");
      assert.strictEqual(
        existsSync(join(livePlans, ".user_sentinel_test.txt")),
        false,
        "Sentinel file .user_sentinel_test.txt must never exist in live workspace"
      );
      const liveLeftovers = readdirSync(livePlans).filter(
        (f) => f.startsWith(".perf_scratch_") || f.startsWith("plan_perf_")
      );
      assert.strictEqual(
        liveLeftovers.length,
        0,
        `Expected 0 leftover scratch dirs in live workspace, found: ${liveLeftovers.join(", ")}`
      );
    });

    await test("Persistence benchmark cleans up scratch directory when operation throws", () => {
      let threw = false;
      try {
        measurePersistence(1, { plansDir: isolatedPlansDir, injectError: true });
      } catch (err) {
        threw = true;
        assert.ok(/Simulated failure/.test(err.message));
      }
      assert.ok(threw, "measurePersistence should have thrown with injectError=true");

      const leftovers = readdirSync(isolatedPlansDir).filter((f) => f.startsWith(".perf_scratch_"));
      assert.strictEqual(
        leftovers.length,
        0,
        `Persistence scratch dir must be cleaned up on error, found: ${leftovers.join(", ")}`
      );
      verifyFilesPreserved();
    });

    await test("Concurrent persistence benchmark runs overlap in subprocesses without collision, corruption, or cross-deletion", async () => {
      const syncDir = join(testEnvDir, "sync");
      mkdirSync(syncDir, { recursive: true });

      const workerScript = `
import { measurePersistence } from "${join(repoRoot, ".agent/skills/iterative-planner/scripts/component_performance_profile.mjs")}";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [workerId, syncDir, plansDir] = process.argv.slice(2);

const res = measurePersistence(2, {
  plansDir,
  onScratchCreated: ({ scratchDir }) => {
    writeFileSync(join(syncDir, "ready_" + workerId + ".json"), JSON.stringify({
      workerId,
      scratchDir,
      pid: process.pid
    }));
    const signalFile = join(syncDir, "proceed.signal");
    const start = Date.now();
    while (!existsSync(signalFile)) {
      if (Date.now() - start > 10000) throw new Error("Timed out waiting for proceed signal");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
});
writeFileSync(join(syncDir, "done_" + workerId + ".json"), JSON.stringify(res));
`;
      const workerFile = join(testEnvDir, "worker.mjs");
      writeFileSync(workerFile, workerScript, "utf-8");

      const p1 = spawn(process.execPath, [workerFile, "1", syncDir, isolatedPlansDir], { stdio: "inherit" });
      const p2 = spawn(process.execPath, [workerFile, "2", syncDir, isolatedPlansDir], { stdio: "inherit" });

      const ready1Path = join(syncDir, "ready_1.json");
      const ready2Path = join(syncDir, "ready_2.json");

      const startWait = Date.now();
      while (!existsSync(ready1Path) || !existsSync(ready2Path)) {
        if (Date.now() - startWait > 10000) throw new Error("Timed out waiting for concurrent workers to be ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }

      const ready1 = JSON.parse(readFileSync(ready1Path, "utf-8"));
      const ready2 = JSON.parse(readFileSync(ready2Path, "utf-8"));

      assert.notStrictEqual(ready1.pid, ready2.pid, "Workers must run under different process IDs (PIDs)");
      assert.notStrictEqual(ready1.scratchDir, ready2.scratchDir, "Workers must have unique, non-colliding scratch directories");
      assert.ok(existsSync(ready1.scratchDir), "Worker 1 scratch dir must exist during concurrent execution");
      assert.ok(existsSync(ready2.scratchDir), "Worker 2 scratch dir must exist during concurrent execution");

      // Verify files to track are intact while both scratch dirs exist concurrently
      verifyFilesPreserved();

      // Signal both workers to proceed with file write and cleanup
      writeFileSync(join(syncDir, "proceed.signal"), "go", "utf-8");

      await Promise.all([
        new Promise((res, rej) => p1.on("exit", (code) => code === 0 ? res() : rej(new Error("Worker 1 exited with " + code)))),
        new Promise((res, rej) => p2.on("exit", (code) => code === 0 ? res() : rej(new Error("Worker 2 exited with " + code)))),
      ]);

      const done1 = JSON.parse(readFileSync(join(syncDir, "done_1.json"), "utf-8"));
      const done2 = JSON.parse(readFileSync(join(syncDir, "done_2.json"), "utf-8"));

      assert.strictEqual(done1.disk_write.failure_count, 0, "Worker 1 must complete with 0 failures");
      assert.strictEqual(done2.disk_write.failure_count, 0, "Worker 2 must complete with 0 failures");
      assert.strictEqual(done1.disk_write.samples, 2, "Worker 1 must record 2 samples");
      assert.strictEqual(done2.disk_write.samples, 2, "Worker 2 must record 2 samples");

      const leftovers = readdirSync(isolatedPlansDir).filter((f) => f.startsWith(".perf_scratch_"));
      assert.strictEqual(leftovers.length, 0, "All concurrent scratch directories must be cleaned up on completion");
      verifyFilesPreserved();
    });

    await test("Transition gate benchmark distinguishes valid fixture execution from GATE-PLAN-001 refusal", () => {
      // 1. Valid execution control in isolated workspace
      const validStartup = measureStartup(1, {
        projectRoot: testEnvDir,
        plansDir: isolatedPlansDir,
      });

      assert.strictEqual(
        validStartup.transition_gate_dry_run.failure_count,
        0,
        `Valid fixture run must have failure_count === 0, got ${validStartup.transition_gate_dry_run.failure_count}`
      );
      assert.strictEqual(
        validStartup.transition_gate_dry_run.samples,
        1,
        `Valid fixture run must record timing samples, got ${validStartup.transition_gate_dry_run.samples}`
      );
      assert.strictEqual(validStartup.matched_evaluations.clean_gate_dry_run.samples, 1);
      assert.strictEqual(validStartup.matched_evaluations.clean_gate_dry_run.failure_count, 0);
      assert.strictEqual(validStartup.matched_evaluations.dirty_semantic_negative_gate.samples, 1);
      assert.strictEqual(validStartup.matched_evaluations.dirty_semantic_negative_gate.failure_count, 0);
      assert.strictEqual(validStartup.matched_evaluations.dirty_semantic_negative_gate.expected_failure_code, "GATE-EXP-014");
      assert.strictEqual(validStartup.matched_evaluations.dirty_semantic_negative_gate.verified_semantic_negative, true);

      verifyFilesPreserved();

      // 2. Invalid plan directory refusal
      const invalidStartup = measureStartup(1, {
        projectRoot: testEnvDir,
        plansDir: isolatedPlansDir,
        overrideFixturePlanName: "invalid_plan_missing_prefix",
      });

      assert.ok(
        invalidStartup.transition_gate_dry_run.failure_count >= 1,
        `Expected failure_count >= 1 for GATE-PLAN-001 refusal, got ${invalidStartup.transition_gate_dry_run.failure_count}`
      );
      assert.strictEqual(
        invalidStartup.transition_gate_dry_run.samples,
        0,
        `Invalid gate run must NOT be recorded as valid timing sample, got ${invalidStartup.transition_gate_dry_run.samples} samples`
      );

      verifyFilesPreserved();
    });
  } finally {
    try {
      rmSync(testEnvDir, { recursive: true, force: true });
    } catch {}
  }

  // Summary
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

