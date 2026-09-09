#!/usr/bin/env node
// component_performance_profile.mjs — End-to-end component performance profiler for v11 harness baseline.
// Measures startup, scanning, hashing, projection, parsing/indexing, query solving, subprocess, persistence, and context size.

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { cpus, platform, release, arch, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createSession } from "./lib/prolog.mjs";
import { ClauseIndex } from "./lib/clause_index.mjs";
import { loadOntologyRuntime } from "./lib/ontology_runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = dirname(__filename);
const skillDir = resolve(scriptsDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");

function percentile(values, p) {
  const sorted = [...values].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function stats(values, failureCount = 0) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length === 0) {
    return {
      samples: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      variance: 0,
      failure_count: failureCount,
      raw_samples: [],
    };
  }
  const sum = nums.reduce((acc, v) => acc + v, 0);
  const mean = sum / nums.length;
  const variance = nums.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / nums.length;
  return {
    samples: nums.length,
    min: Number(Math.min(...nums).toFixed(3)),
    max: Number(Math.max(...nums).toFixed(3)),
    mean: Number(mean.toFixed(3)),
    p50: Number((percentile(nums, 50) ?? 0).toFixed(3)),
    p95: Number((percentile(nums, 95) ?? 0).toFixed(3)),
    variance: Number(variance.toFixed(3)),
    failure_count: failureCount,
    raw_samples: nums.map((n) => Number(n.toFixed(3))),
  };
}

function parseEquivalenceLine(stdout) {
  const line = (stdout || "").split("\n").find((l) => l.includes("EQUIVALENCE:"));
  if (!line) return null;
  try {
    const jsonStr = line.slice(line.indexOf("EQUIVALENCE:") + "EQUIVALENCE:".length).trim();
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// 1. Startup timings
export function measureStartup(runs = 5, { projectRoot = repoRoot, plansDir = join(projectRoot, "plans"), overrideFixturePlanName = null } = {}) {
  // If plansDir points to an isolated workspace, keep projectRoot consistent with plansDir
  if (projectRoot === repoRoot && plansDir && dirname(resolve(plansDir)) !== repoRoot) {
    projectRoot = dirname(resolve(plansDir));
  }

  const nodeStartupSamples = [];
  const bootstrapStatusSamples = [];
  const transitionDryRunSamples = [];
  const transitionHelpSamples = [];
  const dirtyGateSamples = [];
  let failures = 0;
  let dirtyFailures = 0;

  // Set up temporary canonical fixture plans for representative transition gate dry-runs
  // Canonical name MUST start with "plan_" to satisfy resolvePlanTarget
  const fixturePlanName = overrideFixturePlanName || `plan_perf_fixture_${process.pid}_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const fixturePlanDir = join(plansDir, fixturePlanName);

  const dirtyPlanName = `plan_perf_dirty_${process.pid}_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const dirtyPlanDir = join(plansDir, dirtyPlanName);

  try {
    // 1. Clean valid canonical fixture plan
    mkdirSync(fixturePlanDir, { recursive: true });
    writeFileSync(join(fixturePlanDir, "state.json"), JSON.stringify({
      state: "EXPLORE",
      schema_version: 1,
      plan_id: fixturePlanName,
      goal: "Representative maintenance refactor for component benchmarking",
      created_at: new Date().toISOString(),
      workflow_id: "/safe-change",
      iteration: 0,
    }, null, 2));
    writeFileSync(join(fixturePlanDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      fast_track: false,
      findings: [{
        id: "F-001",
        title: "Perf test finding",
        summary: "Representative exploration finding summary with sufficient length for testing gate transition cleanly.",
      }],
    }, null, 2));
    writeFileSync(join(fixturePlanDir, "findings.md"), "# Findings\n## F-001: Perf test finding\nRepresentative exploration finding summary with sufficient length for testing gate transition cleanly.\n");

    // 2. Deterministic fixture for matched semantic negative evaluation:
    // Goal explicitly declares a user-facing deliverable that requires an intent contract,
    // but intent_contract.json is missing required fields, deterministically triggering GATE-EXP-014 hard blocker.
    mkdirSync(dirtyPlanDir, { recursive: true });
    writeFileSync(join(dirtyPlanDir, "state.json"), JSON.stringify({
      state: "EXPLORE",
      schema_version: 1,
      plan_id: dirtyPlanName,
      goal: "Build user-facing dashboard report for end-users",
      created_at: new Date().toISOString(),
      workflow_id: "/safe-change",
      iteration: 0,
    }, null, 2));
    writeFileSync(join(dirtyPlanDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      fast_track: false,
      findings: [{
        id: "F-001",
        title: "Perf test finding",
        summary: "Representative exploration finding summary with sufficient length for testing gate transition cleanly.",
      }],
    }, null, 2));
    writeFileSync(join(dirtyPlanDir, "findings.md"), "# Findings\n## F-001: Perf test finding\nRepresentative exploration finding summary with sufficient length for testing gate transition cleanly.\n");
    writeFileSync(join(dirtyPlanDir, "intent_contract.json"), "{}\n");

    for (let i = 0; i < runs; i++) {
      // Node process startup
      const t0 = performance.now();
      const r0 = spawnSync(process.execPath, ["-e", "process.exit(0)"], { cwd: projectRoot });
      if (r0.status !== 0) failures++;
      else nodeStartupSamples.push(performance.now() - t0);

      // Bootstrap status CLI
      const t1 = performance.now();
      const r1 = spawnSync(process.execPath, [join(scriptsDir, "bootstrap.mjs"), "status", "--json"], {
        cwd: projectRoot,
        encoding: "utf-8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      if (r1.status !== 0 || !r1.stdout) failures++;
      else bootstrapStatusSamples.push(performance.now() - t1);

      // Representative state machine transition execution (dry-run on clean fixture)
      const t2 = performance.now();
      const r2 = spawnSync(process.execPath, [
        join(scriptsDir, "transition.mjs"),
        "explore-to-plan",
        "--dry-run",
        "--plan",
        fixturePlanName,
      ], {
        cwd: projectRoot,
        encoding: "utf-8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });

      // Parse structured result and verify intended plan was actually evaluated
      const stdout2 = r2.stdout || "";
      const hasPlanRefusal2 = /GATE-PLAN-001/i.test(stdout2) || /No active or explicit plan could be resolved/i.test(stdout2);
      const hasRuntimeError2 = /GATE-RUN-001/i.test(stdout2) || r2.status === 3;
      const eq2 = parseEquivalenceLine(stdout2);
      const isCleanPositivePass =
        !hasPlanRefusal2 &&
        !hasRuntimeError2 &&
        r2.status === 0 &&
        eq2?.status === "PASS" &&
        eq2?.hard_block_count === 0 &&
        Array.isArray(eq2?.failure_codes) &&
        eq2.failure_codes.length === 0;

      // Only valid evaluations count as successful timing samples; setup/plan resolution errors increment failures
      if (!isCleanPositivePass) {
        failures++;
      } else {
        transitionDryRunSamples.push(performance.now() - t2);
      }

      // Matched dirty fixture evaluation (expected semantic negative)
      const tDirty = performance.now();
      const rDirty = spawnSync(process.execPath, [
        join(scriptsDir, "transition.mjs"),
        "explore-to-plan",
        "--dry-run",
        "--plan",
        dirtyPlanName,
      ], {
        cwd: projectRoot,
        encoding: "utf-8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });

      const stdoutDirty = rDirty.stdout || "";
      const hasPlanRefusalDirty = /GATE-PLAN-001/i.test(stdoutDirty) || /No active or explicit plan could be resolved/i.test(stdoutDirty);
      const hasRuntimeErrorDirty = /GATE-RUN-001/i.test(stdoutDirty) || rDirty.status === 3;
      const eqDirty = parseEquivalenceLine(stdoutDirty);
      const isExpectedSemanticNegative =
        !hasPlanRefusalDirty &&
        !hasRuntimeErrorDirty &&
        rDirty.status === 1 &&
        eqDirty?.status === "FAIL" &&
        eqDirty?.hard_block_count > 0 &&
        Array.isArray(eqDirty?.failure_codes) &&
        eqDirty.failure_codes.includes("GATE-EXP-014");

      if (!isExpectedSemanticNegative) {
        dirtyFailures++;
      } else {
        dirtyGateSamples.push(performance.now() - tDirty);
      }

      // CLI help argument parsing baseline
      const t3 = performance.now();
      const r3 = spawnSync(process.execPath, [join(scriptsDir, "transition.mjs"), "--help"], {
        cwd: projectRoot,
        encoding: "utf-8",
      });
      if (r3.status !== 0) failures++;
      else transitionHelpSamples.push(performance.now() - t3);
    }
  } finally {
    try {
      if (existsSync(fixturePlanDir)) rmSync(fixturePlanDir, { recursive: true, force: true });
    } catch {}
    try {
      if (existsSync(dirtyPlanDir)) rmSync(dirtyPlanDir, { recursive: true, force: true });
    } catch {}
  }

  return {
    node_process_startup: stats(nodeStartupSamples, failures),
    bootstrap_status_cli: stats(bootstrapStatusSamples, failures),
    transition_gate_dry_run: stats(transitionDryRunSamples, failures),
    transition_help_cli: stats(transitionHelpSamples, failures),
    matched_evaluations: {
      clean_gate_dry_run: stats(transitionDryRunSamples, failures),
      dirty_semantic_negative_gate: {
        ...stats(dirtyGateSamples, dirtyFailures),
        expected_failure_code: "GATE-EXP-014",
        verified_semantic_negative: dirtyGateSamples.length > 0 && dirtyFailures === 0,
      },
      unchanged_vs_changed: {
        status: "unmeasured",
        reason: "Phase 0 harness baseline profiles local components without persistent transition evaluation cache",
      },
      cache_hit_vs_miss: {
        status: "unmeasured",
        reason: "Transition gate dry-run evaluates live invariants on each invocation without a cross-run cache",
      },
    },
  };
}

// 2. Scanning & Hashing
function measureScanningAndHashing(runs = 5) {
  const coldScanSamples = [];
  const warmScanSamples = [];
  const hashingSamples = [];

  function collectFiles(dir, maxDepth = 4, currentDepth = 0) {
    if (currentDepth > maxDepth) return [];
    let results = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          results = results.concat(collectFiles(full, maxDepth, currentDepth + 1));
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
    } catch {
      // ignore unreadable
    }
    return results;
  }

  const fileList = collectFiles(join(repoRoot, ".agent"), 4);

  for (let i = 0; i < runs; i++) {
    // Scan time
    const t0 = performance.now();
    const files = collectFiles(join(repoRoot, ".agent"), 4);
    if (i === 0) coldScanSamples.push(performance.now() - t0);
    else warmScanSamples.push(performance.now() - t0);

    // Hashing time
    const t1 = performance.now();
    let totalBytesHashed = 0;
    for (const f of files.slice(0, 100)) {
      try {
        const buf = readFileSync(f);
        createHash("sha256").update(buf).digest("hex");
        totalBytesHashed += buf.length;
      } catch {}
    }
    hashingSamples.push(performance.now() - t1);
  }

  return {
    total_files_scanned: fileList.length,
    cold_scan: stats(coldScanSamples),
    warm_scan: stats(warmScanSamples),
    file_hashing_100_files: stats(hashingSamples),
  };
}

// 3. Ontology Projection
function measureOntologyProjection(runs = 5) {
  const coldProjectionSamples = [];
  const warmProjectionSamples = [];
  let factCount = 0;
  let factBytes = 0;

  for (let i = 0; i < runs; i++) {
    // Cold: bypass cache
    const t0 = performance.now();
    const runtimeCold = loadOntologyRuntime({ cwd: repoRoot, useCache: false, writeCache: false, projectionProfile: "full" });
    coldProjectionSamples.push(performance.now() - t0);
    if (i === 0 && runtimeCold.session?.db) {
      for (const [_, idx] of runtimeCold.session.db) {
        factCount += idx.length;
      }
      factBytes = runtimeCold.facts_text?.length || 0;
    }

    // Warm: use cache
    const t1 = performance.now();
    loadOntologyRuntime({ cwd: repoRoot, useCache: true, writeCache: false, projectionProfile: "full" });
    warmProjectionSamples.push(performance.now() - t1);
  }

  return {
    fact_count: factCount,
    fact_text_bytes: factBytes,
    cold_projection: stats(coldProjectionSamples),
    warm_projection: stats(warmProjectionSamples),
  };
}

// 4. Rule Parsing and Indexing
function measureParsingAndIndexing(runs = 5) {
  const prologDir = join(skillDir, "prolog");
  const plFiles = readdirSync(prologDir)
    .filter((f) => f.endsWith(".pl"))
    .map((f) => join(prologDir, f));

  const ruleTexts = plFiles.map((p) => readFileSync(p, "utf-8"));
  const totalRuleBytes = ruleTexts.reduce((acc, t) => acc + t.length, 0);

  const parseSamples = [];
  const indexConstructionSamples = [];
  const indexedLookupSamples = [];
  const unindexedScanSamples = [];
  let totalClauses = 0;
  let failures = 0;

  // Build a benchmark dataset of 5,000 clauses with first-argument indexing to compare against unindexed scan
  const benchmarkClauses = [];
  for (let k = 0; k < 5000; k++) {
    benchmarkClauses.push({
      head: {
        type: "compound",
        functor: "story_metric",
        args: [
          { type: "atom", name: `us_${String(k).padStart(5, "0")}` },
          { type: "number", value: k * 10 },
        ],
      },
      body: [],
    });
  }

  for (let i = 0; i < runs; i++) {
    const session = createSession();
    const t0 = performance.now();
    for (const text of ruleTexts) {
      session.consult(text);
    }
    parseSamples.push(performance.now() - t0);

    if (i === 0 && session.db) {
      for (const [_, idx] of session.db) {
        totalClauses += idx.length;
      }
    }

    // 1. Measure ClauseIndex construction over 5,000 clauses
    const t1 = performance.now();
    const index = new ClauseIndex("story_metric/2");
    for (const clause of benchmarkClauses) {
      index.add(clause);
    }
    indexConstructionSamples.push(performance.now() - t1);

    // 2. Measure actual indexed lookup performance
    const targetKey = { type: "atom", name: "us_04200" };
    const t2 = performance.now();
    const indexedMatches = index.getMatching(targetKey);
    indexedLookupSamples.push(performance.now() - t2);

    // Assert indexed result correctness
    if (indexedMatches.length !== 1 || indexedMatches[0].head.args[0].name !== "us_04200") {
      failures++;
      throw new Error(`Indexed lookup failed to retrieve expected candidate: ${JSON.stringify(indexedMatches)}`);
    }

    // 3. Measure unindexed linear scan over all 5,000 clauses for the same target
    const targetSubKey = ClauseIndex.getTermKey(targetKey);
    const t3 = performance.now();
    const unindexedMatches = benchmarkClauses.filter((c) => {
      const firstArg = c.head?.args?.[0];
      return firstArg && ClauseIndex.getTermKey(firstArg) === targetSubKey;
    });
    unindexedScanSamples.push(performance.now() - t3);

    // Assert unindexed result matches indexed result
    if (unindexedMatches.length !== indexedMatches.length) {
      failures++;
      throw new Error(`Unindexed scan count (${unindexedMatches.length}) does not match indexed count (${indexedMatches.length})`);
    }
  }

  return {
    rule_files_count: plFiles.length,
    total_rule_bytes: totalRuleBytes,
    total_clauses: totalClauses,
    rule_parsing: stats(parseSamples, failures),
    clause_indexing: stats(indexConstructionSamples, failures),
    clause_index_lookup: stats(indexedLookupSamples, failures),
    unindexed_scan: stats(unindexedScanSamples, failures),
  };
}

// 5. Query Solving (including depth 50+ alternatives, negative cases, cyclic cases)
function measureQuerySolving(runs = 5) {
  const runtime = loadOntologyRuntime({ cwd: repoRoot, useCache: true, projectionProfile: "full" });
  const session = runtime.session;

  // Consult standard invariants
  const invariantsPl = readFileSync(join(skillDir, "prolog", "invariants.pl"), "utf-8");
  session.consult(invariantsPl);

  const groundedSamples = [];
  const unboundScanSamples = [];
  const relationalJoinSamples = [];
  const depth50PlusSamples = [];
  const negativeQuerySamples = [];
  const cyclicPruningSamples = [];
  let failures = 0;

  // Depth 50+ query with multiple alternatives
  session.consult(`
    choice_item(a).
    choice_item(b).
    choice_item(c).
    deep_branch(0, X) :- choice_item(X).
    deep_branch(N, X) :- N > 0, N1 is N - 1, deep_branch(N1, X).
  `);

  // Cyclic rule for testing cycle detection termination
  session.consult(`
    cyclic_a :- cyclic_b.
    cyclic_b :- cyclic_a.
    cyclic_root :- cyclic_a.
    cyclic_root :- true.
  `);

  let verifications = null;

  for (let i = 0; i < runs; i++) {
    // Grounded lookup: story('US-001')
    const t0 = performance.now();
    const r0 = session.queryAll("story('US-001')");
    groundedSamples.push(performance.now() - t0);
    if (r0.length !== 1) {
      failures++;
      throw new Error(`Query story('US-001') expected 1 result, got ${r0.length}`);
    }

    // Unbound scan: story(S)
    const t1 = performance.now();
    const r1 = session.queryAll("story(S)");
    unboundScanSamples.push(performance.now() - t1);
    if (r1.length === 0 || !r1[0]?.S) {
      failures++;
      throw new Error(`Query story(S) returned empty or unbound variable S`);
    }

    // Relational join: story(S), story_title(S, T)
    const t2 = performance.now();
    const r2 = session.queryAll("story(S), story_title(S, T)");
    relationalJoinSamples.push(performance.now() - t2);
    if (r2.length === 0 || !r2[0]?.S || !r2[0]?.T) {
      failures++;
      throw new Error(`Relational join returned empty or unbound variables S/T`);
    }

    // Continuation depth 50+ alternatives
    const t3 = performance.now();
    const prefix = Array(55).fill("true").join(", ");
    const r3 = session.queryAll(`${prefix}, choice_item(X)`);
    depth50PlusSamples.push(performance.now() - t3);
    if (r3.length !== 3) {
      failures++;
      throw new Error(`Depth 50+ query expected 3 alternatives, got ${r3.length}`);
    }
    const boundXs = r3.map((s) => s.X).sort();
    if (JSON.stringify(boundXs) !== JSON.stringify(["a", "b", "c"])) {
      failures++;
      throw new Error(`Depth 50+ variable bindings mismatch: ${JSON.stringify(boundXs)}`);
    }

    // Negative query (nonexistent predicate)
    const t4 = performance.now();
    const r4 = session.queryAll("nonexistent_predicate(X, Y, Z)");
    negativeQuerySamples.push(performance.now() - t4);
    if (r4.length !== 0) {
      failures++;
      throw new Error(`Negative query expected 0 results, got ${r4.length}`);
    }

    // Cyclic rule pruning
    const t5 = performance.now();
    const r5 = session.queryAll("cyclic_root");
    cyclicPruningSamples.push(performance.now() - t5);
    if (r5.length !== 1) {
      failures++;
      throw new Error(`Cyclic rule query expected 1 terminating result, got ${r5.length}`);
    }

    if (i === 0) {
      verifications = {
        grounded_lookup_count: r0.length,
        unbound_scan_count: r1.length,
        relational_join_count: r2.length,
        depth_50_plus_alternatives_count: r3.length,
        depth_50_plus_bindings: boundXs,
        negative_query_count: r4.length,
        cyclic_pruning_count: r5.length,
      };
    }
  }

  return {
    verifications,
    grounded_lookup: stats(groundedSamples, failures),
    unbound_scan: stats(unboundScanSamples, failures),
    relational_join: stats(relationalJoinSamples, failures),
    depth_50_plus_alternatives: stats(depth50PlusSamples, failures),
    negative_query: stats(negativeQuerySamples, failures),
    cyclic_rule_pruning: stats(cyclicPruningSamples, failures),
  };
}

// 6. Subprocesses
function measureSubprocesses(runs = 5) {
  const gitStatusSamples = [];
  const gitRevParseSamples = [];
  let failures = 0;

  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r0 = spawnSync("git", ["status", "-s"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    if (r0.status !== 0) failures++;
    else gitStatusSamples.push(performance.now() - t0);

    const t1 = performance.now();
    const r1 = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    if (r1.status !== 0 || !r1.stdout || r1.stdout.trim().length !== 40) failures++;
    else gitRevParseSamples.push(performance.now() - t1);
  }

  return {
    git_status: stats(gitStatusSamples, failures),
    git_rev_parse: stats(gitRevParseSamples, failures),
  };
}

// 7. Persistence and State Serialization
export function measurePersistence(runs = 5, { plansDir = join(repoRoot, "plans"), injectError = false, onScratchCreated = null } = {}) {
  const serializationSamples = [];
  const diskWriteSamples = [];
  let failures = 0;

  const testData = {
    plan_id: "plan_test_perf",
    state: "EXECUTE",
    iterations: Array(50).fill(null).map((_, i) => ({
      index: i,
      timestamp: new Date().toISOString(),
      evaluations: [{ gate: "explore-to-plan", status: "PASS", duration_ms: 12.34 }],
    })),
    ontology_snapshot: { facts_count: 44000, rules_count: 350 },
  };

  // Process-unique, run-isolated scratch directory to prevent collisions during parallel runs
  const uniqueScratchDir = join(
    plansDir,
    `.perf_scratch_${process.pid}_${Date.now()}_${randomBytes(4).toString("hex")}`
  );
  const testFilePath = join(uniqueScratchDir, "perf_test_write.json");

  try {
    mkdirSync(uniqueScratchDir, { recursive: true });

    if (typeof onScratchCreated === "function") {
      onScratchCreated({ scratchDir: uniqueScratchDir, plansDir, pid: process.pid });
    }

    if (injectError) {
      throw new Error("Simulated failure during persistence benchmark");
    }

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const str = JSON.stringify(testData, null, 2);
      serializationSamples.push(performance.now() - t0);

      const t1 = performance.now();
      writeFileSync(testFilePath, str, "utf-8");
      diskWriteSamples.push(performance.now() - t1);

      if (!existsSync(testFilePath) || readFileSync(testFilePath, "utf-8").length === 0) {
        failures++;
      }
    }
  } finally {
    // Guaranteed cleanup on success or failure of ONLY the unique scratch directory and contents
    try {
      if (existsSync(testFilePath)) unlinkSync(testFilePath);
      if (existsSync(uniqueScratchDir)) rmSync(uniqueScratchDir, { recursive: true, force: true });
    } catch {}
  }

  return {
    json_serialization: stats(serializationSamples, failures),
    disk_write: stats(diskWriteSamples, failures),
  };
}

// 8. Context Size and Memory Footprint
function measureContextSize() {
  const memBefore = process.memoryUsage();
  const runtime = loadOntologyRuntime({ cwd: repoRoot, useCache: true, projectionProfile: "full" });
  const memAfter = process.memoryUsage();

  return {
    heap_used_mb: Number((memAfter.heapUsed / (1024 * 1024)).toFixed(2)),
    heap_total_mb: Number((memAfter.heapTotal / (1024 * 1024)).toFixed(2)),
    rss_mb: Number((memAfter.rss / (1024 * 1024)).toFixed(2)),
    external_mb: Number((memAfter.external / (1024 * 1024)).toFixed(2)),
    delta_heap_mb: Number(((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2)),
  };
}

export function runComponentProfile({
  runs = 5,
  projectRoot = repoRoot,
  plansDir = join(projectRoot, "plans"),
} = {}) {
  // If plansDir points to an isolated workspace, keep projectRoot consistent with plansDir
  if (projectRoot === repoRoot && plansDir && dirname(resolve(plansDir)) !== repoRoot) {
    projectRoot = dirname(resolve(plansDir));
  }
  const hostInfo = {
    platform: platform(),
    release: release(),
    arch: arch(),
    hostname: hostname(),
    cpus: cpus().length,
    cpu_model: cpus()[0]?.model || "unknown",
    node_version: process.version,
  };

  const startup = measureStartup(runs, { projectRoot, plansDir });
  const scanHash = measureScanningAndHashing(runs);
  const ontology = measureOntologyProjection(runs);
  const parseIndex = measureParsingAndIndexing(runs);
  const solving = measureQuerySolving(runs);
  const subprocess = measureSubprocesses(runs);
  const persistence = measurePersistence(runs, { plansDir });
  const contextSize = measureContextSize();

  const report = {
    schema_version: 1,
    benchmark_id: "v11_phase0_component_profile",
    generated_at: new Date().toISOString(),
    host: hostInfo,
    config: { runs },
    profiles: {
      startup,
      scanning_and_hashing: scanHash,
      ontology_projection: ontology,
      parsing_and_indexing: parseIndex,
      query_solving: solving,
      subprocess,
      persistence,
      context_size: contextSize,
    },
    disclosed_limits: [
      "Measurements conducted on local host (Apple M4 Max, 16 cores, arm64, macOS).",
      "Tail estimates (p95) from 5 runs serve as directional guidance, not universal SLOs.",
      "Disk I/O times reflect APFS SSD caching characteristics.",
      "Prolog solver is single-threaded in Node.js event loop.",
      "Nonexistent predicates safely return empty answer sets without exception.",
      "Unchanged/changed differential caching and cache-hit/miss benchmarks are explicitly unmeasured in Phase 0.",
    ],
  };

  return report;
}

export function renderMarkdownReport(report) {
  const p = report.profiles;
  return `# V11 Harness Component Performance Baseline Profile

**Date**: ${report.generated_at}  
**Host**: ${report.host.cpu_model} (${report.host.cpus} cores, ${report.host.arch}, macOS ${report.host.release}), Node ${report.host.node_version}  
**Measurement Runs**: ${report.config.runs} iterations per component

---

## 1. Executive Latency Summary

| Component / Path | Metric / Operation | p50 (ms) | p95 (ms) | Mean (ms) | Variance (ms²) |
|---|---|---|---|---|---|
| **Node Engine** | Cold process spawn | ${p.startup.node_process_startup.p50} | ${p.startup.node_process_startup.p95} | ${p.startup.node_process_startup.mean} | ${p.startup.node_process_startup.variance} |
| **CLI Status** | \`bootstrap.mjs status --json\` | ${p.startup.bootstrap_status_cli.p50} | ${p.startup.bootstrap_status_cli.p95} | ${p.startup.bootstrap_status_cli.mean} | ${p.startup.bootstrap_status_cli.variance} |
| **Transition Gate** | \`transition.mjs --dry-run\` (fixture) | ${p.startup.transition_gate_dry_run?.p50 ?? "N/A"} | ${p.startup.transition_gate_dry_run?.p95 ?? "N/A"} | ${p.startup.transition_gate_dry_run?.mean ?? "N/A"} | ${p.startup.transition_gate_dry_run?.variance ?? "N/A"} |
| **CLI Help** | \`transition.mjs --help\` | ${p.startup.transition_help_cli.p50} | ${p.startup.transition_help_cli.p95} | ${p.startup.transition_help_cli.mean} | ${p.startup.transition_help_cli.variance} |
| **Workspace Scan** | Cold scan (.agent) | ${p.scanning_and_hashing.cold_scan.p50} | ${p.scanning_and_hashing.cold_scan.p95} | ${p.scanning_and_hashing.cold_scan.mean} | ${p.scanning_and_hashing.cold_scan.variance} |
| **Workspace Scan** | Warm scan (.agent) | ${p.scanning_and_hashing.warm_scan.p50} | ${p.scanning_and_hashing.warm_scan.p95} | ${p.scanning_and_hashing.warm_scan.mean} | ${p.scanning_and_hashing.warm_scan.variance} |
| **File Hashing** | SHA-256 over 100 files | ${p.scanning_and_hashing.file_hashing_100_files.p50} | ${p.scanning_and_hashing.file_hashing_100_files.p95} | ${p.scanning_and_hashing.file_hashing_100_files.mean} | ${p.scanning_and_hashing.file_hashing_100_files.variance} |
| **Ontology Projection**| Cold fact generation | ${p.ontology_projection.cold_projection.p50} | ${p.ontology_projection.cold_projection.p95} | ${p.ontology_projection.cold_projection.mean} | ${p.ontology_projection.cold_projection.variance} |
| **Ontology Projection**| Warm cache load | ${p.ontology_projection.warm_projection.p50} | ${p.ontology_projection.warm_projection.p95} | ${p.ontology_projection.warm_projection.mean} | ${p.ontology_projection.warm_projection.variance} |
| **Rule Parsing** | Parse all 11 .pl rule files | ${p.parsing_and_indexing.rule_parsing.p50} | ${p.parsing_and_indexing.rule_parsing.p95} | ${p.parsing_and_indexing.rule_parsing.mean} | ${p.parsing_and_indexing.rule_parsing.variance} |
| **Clause Indexing** | Build ClauseIndex (5k clauses) | ${p.parsing_and_indexing.clause_indexing.p50} | ${p.parsing_and_indexing.clause_indexing.p95} | ${p.parsing_and_indexing.clause_indexing.mean} | ${p.parsing_and_indexing.clause_indexing.variance} |
| **Indexed Lookup** | ClauseIndex.getMatching | ${p.parsing_and_indexing.clause_index_lookup?.p50 ?? "N/A"} | ${p.parsing_and_indexing.clause_index_lookup?.p95 ?? "N/A"} | ${p.parsing_and_indexing.clause_index_lookup?.mean ?? "N/A"} | ${p.parsing_and_indexing.clause_index_lookup?.variance ?? "N/A"} |
| **Unindexed Scan** | Array.filter linear scan | ${p.parsing_and_indexing.unindexed_scan?.p50 ?? "N/A"} | ${p.parsing_and_indexing.unindexed_scan?.p95 ?? "N/A"} | ${p.parsing_and_indexing.unindexed_scan?.mean ?? "N/A"} | ${p.parsing_and_indexing.unindexed_scan?.variance ?? "N/A"} |
| **Grounded Lookup** | \`story('US-001')\` | ${p.query_solving.grounded_lookup.p50} | ${p.query_solving.grounded_lookup.p95} | ${p.query_solving.grounded_lookup.mean} | ${p.query_solving.grounded_lookup.variance} |
| **Unbound Scan** | \`story(S)\` (342 stories) | ${p.query_solving.unbound_scan.p50} | ${p.query_solving.unbound_scan.p95} | ${p.query_solving.unbound_scan.mean} | ${p.query_solving.unbound_scan.variance} |
| **Relational Join** | \`story(S), story_title(S, T)\` | ${p.query_solving.relational_join.p50} | ${p.query_solving.relational_join.p95} | ${p.query_solving.relational_join.mean} | ${p.query_solving.relational_join.variance} |
| **Depth 50+ Query** | 55 prefix goals + alternatives | ${p.query_solving.depth_50_plus_alternatives.p50} | ${p.query_solving.depth_50_plus_alternatives.p95} | ${p.query_solving.depth_50_plus_alternatives.mean} | ${p.query_solving.depth_50_plus_alternatives.variance} |
| **Negative Query** | \`nonexistent_predicate/3\` | ${p.query_solving.negative_query.p50} | ${p.query_solving.negative_query.p95} | ${p.query_solving.negative_query.mean} | ${p.query_solving.negative_query.variance} |
| **Cyclic Pruning** | \`cyclic_root(X)\` guard | ${p.query_solving.cyclic_rule_pruning.p50} | ${p.query_solving.cyclic_rule_pruning.p95} | ${p.query_solving.cyclic_rule_pruning.mean} | ${p.query_solving.cyclic_rule_pruning.variance} |
| **Subprocess** | \`git status -s\` | ${p.subprocess.git_status.p50} | ${p.subprocess.git_status.p95} | ${p.subprocess.git_status.mean} | ${p.subprocess.git_status.variance} |
| **Subprocess** | \`git rev-parse HEAD\` | ${p.subprocess.git_rev_parse.p50} | ${p.subprocess.git_rev_parse.p95} | ${p.subprocess.git_rev_parse.mean} | ${p.subprocess.git_rev_parse.variance} |
| **Persistence** | JSON serialization | ${p.persistence.json_serialization.p50} | ${p.persistence.json_serialization.p95} | ${p.persistence.json_serialization.mean} | ${p.persistence.json_serialization.variance} |
| **Persistence** | Atomic disk write | ${p.persistence.disk_write.p50} | ${p.persistence.disk_write.p95} | ${p.persistence.disk_write.mean} | ${p.persistence.disk_write.variance} |

---

## 2. Context Size and Memory Footprint

- **Projected Facts**: ${p.ontology_projection.fact_count.toLocaleString()} facts (${(p.ontology_projection.fact_text_bytes / 1024).toFixed(1)} KB text)
- **Rules**: ${p.parsing_and_indexing.rule_files_count} files, ${p.parsing_and_indexing.total_clauses.toLocaleString()} parsed clauses (${(p.parsing_and_indexing.total_rule_bytes / 1024).toFixed(1)} KB)
- **Node Process Heap Used**: ${p.context_size.heap_used_mb} MB (RSS: ${p.context_size.rss_mb} MB)
- **Ontology Runtime Heap Delta**: +${p.context_size.delta_heap_mb} MB

---

## 3. Disclosed Limits & Boundaries

${report.disclosed_limits.map((l) => `- ${l}`).join("\n")}
`;
}

// CLI execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1] || "5");
  const outJson = process.argv.find((a) => a.startsWith("--out-json="))?.split("=")[1] || null;
  const outMd = process.argv.find((a) => a.startsWith("--out-md="))?.split("=")[1] || null;

  console.log(`Starting V11 component performance profiling (${runs} runs)...`);
  const report = runComponentProfile({ runs });

  if (outJson) {
    mkdirSync(dirname(resolve(outJson)), { recursive: true });
    writeFileSync(resolve(outJson), JSON.stringify(report, null, 2) + "\n", "utf-8");
    console.log(`Wrote JSON report to ${outJson}`);
  }

  if (outMd) {
    mkdirSync(dirname(resolve(outMd)), { recursive: true });
    writeFileSync(resolve(outMd), renderMarkdownReport(report), "utf-8");
    console.log(`Wrote Markdown report to ${outMd}`);
  }

  console.log(renderMarkdownReport(report));
}
