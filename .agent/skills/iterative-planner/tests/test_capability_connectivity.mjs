#!/usr/bin/env node
// test_capability_connectivity.mjs — T-INTAKE-25285668 AC1 (connectivity).
//
// FAILS if a declared verification capability is "shelf-ware": present + unit-tested
// but never imported by a NON-TEST runtime consumer. This is the systematic backstop
// for the e03/e04 gap — before the retrofit, calibration_gate/forecastability were
// imported only by the conformance runner (a test), and nothing caught it. Now they
// must be consumed by the agent's runtime path or this test goes red.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, "..");                 // .../iterative-planner
const repoRoot = resolve(skillRoot, "..", "..", "..");

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// Walk a dir for .mjs files, skipping any path segment under a tests/ dir.
function walkMjs(dir, acc = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "tests" || e.name === "node_modules" || e.name === ".git") continue;
      walkMjs(full, acc);
    } else if (e.name.endsWith(".mjs")) {
      acc.push(full);
    }
  }
  return acc;
}

// Runtime consumer set: all .mjs under the skill (minus tests/) + the visualizer app scripts.
const consumerFiles = [
  ...walkMjs(join(skillRoot, "scripts")),
  ...walkMjs(join(skillRoot, "packs")),
  ...walkMjs(join(repoRoot, "apps", "ive-visualizer", "scripts")),
];

function nonTestImportersOf(moduleAbsPath) {
  const base = basename(moduleAbsPath); // e.g. calibration_gate.mjs
  const importers = [];
  for (const f of consumerFiles) {
    if (resolve(f) === resolve(moduleAbsPath)) continue; // skip self
    let src = "";
    try { src = readFileSync(f, "utf-8"); } catch { continue; }
    // import ... from "..../<base>"  (static from, dynamic import(), and require — all are
    // genuine runtime consumption; transition.mjs wires its libs via dynamic await import()).
    if (new RegExp(`(from|require\\(|import\\()\\s*["'][^"']*/${base.replace(".", "\\.")}["']`).test(src)) {
      importers.push(f);
    }
  }
  return importers;
}

function posixRel(absPath) {
  return absPath.slice(skillRoot.length + 1).replaceAll("\\", "/");
}

function importSpecs(src) {
  const specs = [];
  const re = /(?:import\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\))/g;
  for (const match of src.matchAll(re)) {
    specs.push(match[1] || match[2] || match[3]);
  }
  return specs;
}

function resolveImportPath(fromFile, spec, knownFiles) {
  if (!spec || !spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.mjs`,
    join(base, "index.mjs"),
  ].map((candidate) => resolve(candidate));
  return candidates.find((candidate) => knownFiles.has(candidate)) || null;
}

function buildRuntimeImportGraph(files) {
  const knownFiles = new Set(files.map((file) => resolve(file)));
  const graph = new Map();
  for (const file of knownFiles) {
    let src = "";
    try { src = readFileSync(file, "utf-8"); } catch { src = ""; }
    const edges = importSpecs(src)
      .map((spec) => resolveImportPath(file, spec, knownFiles))
      .filter(Boolean);
    graph.set(file, edges);
  }
  return graph;
}

function reachableFromRoots(graph, roots) {
  const seen = new Set();
  const stack = roots.map((root) => resolve(root)).filter((root) => graph.has(root));
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of graph.get(current) || []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

console.log("\nCapability connectivity (T-25285668 AC1)\n");

// Auto-discovered quant gate modules (any packs/quant/*.mjs except the pack entry/index).
const quantGateDir = join(skillRoot, "packs", "quant");
const autoGates = readdirSync(quantGateDir)
  .filter((f) => f.endsWith(".mjs") && f !== "index.mjs")
  .map((f) => join(quantGateDir, f));

// Explicit lib capabilities that must be live in the runtime.
const libCapabilities = [
  "scripts/lib/north_star_telemetry.mjs",
  "scripts/lib/proportionality.mjs",
  "scripts/lib/claim_ledger.mjs",
  "scripts/lib/measured_gate.mjs",
  "scripts/lib/run_record.mjs",
  // e05 AC1/AC2: the Agent() whitelist + single-foreground-writer policy. Validated by
  // transition.mjs (Step 0e); listed here so it can never silently regress to shelf-ware —
  // it is neither a packs/quant/* module nor an ive_* lib, so the auto-discovery arms miss it.
  "scripts/lib/agent_orchestration.mjs",
].map((p) => join(skillRoot, p));

const capabilities = [...autoGates, ...libCapabilities];
assert(capabilities.length >= 5, `discovered >=5 capability modules to check (got ${capabilities.length})`);

for (const cap of capabilities) {
  const rel = cap.slice(skillRoot.length + 1);
  const importers = nonTestImportersOf(cap);
  assert(importers.length > 0,
    `${rel} is consumed by a non-test runtime path${importers.length ? ` (${basename(importers[0])})` : " — ORPHAN / shelf-ware"}`);
}

console.log("\nIVE runtime import graph (T-INTAKE-684369E8 AC3)\n");

const runtimeGraph = buildRuntimeImportGraph(consumerFiles);
const reachable = reachableFromRoots(runtimeGraph, [
  join(skillRoot, "scripts", "transition.mjs"),
  join(skillRoot, "scripts", "bootstrap.mjs"),
]);
const iveLibs = readdirSync(join(skillRoot, "scripts", "lib"))
  .filter((file) => /^ive_.*\.mjs$/.test(file))
  .map((file) => join(skillRoot, "scripts", "lib", file));

const experimentalIveLibs = new Map([
  ["scripts/lib/ive_action_router.mjs", "deterministic route checker used by intake/verdict preview helpers; not yet transition/bootstrap truth"],
  ["scripts/lib/ive_advisory_records.mjs", "continuous advisory record helpers; not yet part of transition/bootstrap truth"],
  ["scripts/lib/ive_packet_contract.mjs", "packet validation contract consumed by IVE intake/release CLIs, not live gate roots"],
  ["scripts/lib/ive_program_intake.mjs", "Program Packet intake mapper used by program-manager paths, not the transition/bootstrap roots"],
  ["scripts/lib/ive_projection.mjs", "projection helper for visualizer/bridge surfaces outside transition/bootstrap roots"],
  ["scripts/lib/ive_real_episode_corpus.mjs", "real-episode fixture adapter consumed by conformance replay suites, intentionally not a live gate root"],
  ["scripts/lib/ive_release_handoff.mjs", "release-handoff report helper consumed by ive_release_handoff.mjs CLI"],
  ["scripts/lib/ive_scenario_harness.mjs", "scenario fixture orchestration for conformance suites, intentionally not a live gate"],
  ["scripts/lib/ive_user_verdict.mjs", "user-facing verdict renderer used by scenario/intake previews until verdicts become a live gate"],
]);

assert(iveLibs.length >= 5, `discovered IVE lib modules to check (got ${iveLibs.length})`);
for (const lib of iveLibs) {
  const rel = posixRel(lib);
  if (reachable.has(resolve(lib))) {
    assert(true, `${rel} is reachable from transition.mjs/bootstrap.mjs`);
  } else {
    const rationale = experimentalIveLibs.get(rel);
    assert(!!rationale && rationale.length >= 20, `${rel} has explicit experimental/runtime-off-path rationale`);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
