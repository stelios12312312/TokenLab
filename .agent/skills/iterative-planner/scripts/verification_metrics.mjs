#!/usr/bin/env node
// verification_metrics.mjs — Epic I (T-INTAKE-F9DEC915) of the ive-verification-coverage
// program. Computes the verification-health metrics with REAL definitions so they can be
// gated measured-vs-threshold through the North Star chain (manifesto core_metrics ->
// metric_actual facts -> invariants.pl I-032). Emits a metrics report JSON that
// north_star_telemetry.collectMetricActualFacts can pick up (numeric top-level + .metrics).
//
// @planner:module = verification_metrics
// @planner:capability = verification_metrics_collector
//
// WHY REAL DEFINITIONS: the 2026-06-09 baseline showed naive metrics MISLEAD —
//   - a regex import-check flagged 19/110 'dead' libs; a parsed import graph finds ~4.
//   - naive state==CLOSE read 99% close-rate; genuine full-chain (a validate-to-close
//     transition, excluding `close --informational`) is ~65%.
// A metric is only as trustworthy as its definition, so:
//   - dead_load uses a parsed import graph (import/export-from/dynamic import), not regex.
//   - genuine_close_rate requires a real validate-to-close transition in state.json.
// The metric-definition-integrity test locks these against the naive miscounts.

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(__filename);
const SKILL_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");

// ─── filesystem helpers ──────────────────────────────────────────────────────
function walkMjs(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMjs(p));
    else if (e.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}
function safeRead(p) { try { return readFileSync(p, "utf8"); } catch { return ""; } }

// ─── import graph (real, not regex-on-filename) ──────────────────────────────
// Extract the set of module specifiers a file imports/re-exports, including dynamic
// import(). Returns specifiers as written (e.g. "./lib/foo.mjs", "../annotation_parser.mjs").
const SPEC_RES = [
  /\bimport\s+[^;]*?\bfrom\s*["']([^"']+)["']/g,   // import x from "..."
  /\bimport\s*["']([^"']+)["']/g,                  // import "..."  (side-effect)
  /\bexport\s+[^;]*?\bfrom\s*["']([^"']+)["']/g,    // export ... from "..."
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,          // dynamic import("...")
];
function extractSpecifiers(src) {
  const specs = new Set();
  for (const re of SPEC_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) specs.add(m[1]);
  }
  return specs;
}

// Build importedBy: absolute-resolved-module -> Set of importer files.
export function buildImportGraph(roots = [join(SKILL_DIR, "scripts")]) {
  const files = [...new Set(roots.flatMap(walkMjs))];
  const importedBy = new Map(); // resolvedTarget -> Set(importerPath)
  for (const file of files) {
    const src = safeRead(file);
    for (const spec of extractSpecifiers(src)) {
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue; // skip bare/node specifiers
      // resolve relative to the importer's dir; tolerate missing .mjs
      let target = resolve(dirname(file), spec);
      if (!target.endsWith(".mjs")) target += ".mjs";
      if (!importedBy.has(target)) importedBy.set(target, new Set());
      importedBy.get(target).add(file);
    }
  }
  return { files, importedBy };
}

// DEAD-LOAD is scoped to scripts/lib/*.mjs (which exist to be imported). Two tiers,
// because "no importer" is NOT the same as "unreachable":
//   - dead: zero non-self/non-own-test importers AND its filename appears as a string
//     NOWHERE in the corpus (so it is not spawned, dynamically loaded, or CLI-dispatched
//     either) -> genuinely removable. This matches the careful 2026-06-09 register (~4).
//   - import_orphaned: zero importers BUT referenced by name elsewhere (spawned / dispatched
//     / dynamic path) -> reachable via a non-import path (e.g. northstar_dogfood is spawned
//     by a Playwright dogfood). Reported separately, NOT counted as dead-load.
// dead_load_ratio uses the `dead` (truly-removable) set so the metric drives real deletions.
export function deadLoadLibs() {
  const { files, importedBy } = buildImportGraph();
  const libDir = join(SKILL_DIR, "scripts", "lib");
  const libs = existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith(".mjs")) : [];
  // Reachability is PRODUCTION-ONLY (scripts/). A test merely *naming* a module — including
  // this collector's own integrity test, which lists the dead libs as string literals — does
  // NOT make it production-reachable; counting tests here would be self-defeating.
  const prodText = new Map(files.map((f) => [f, safeRead(f)]));
  const dead = [];
  const importOrphaned = [];
  for (const lib of libs) {
    const abs = resolve(libDir, lib);
    const importers = importedBy.get(abs) || new Set();
    const realImporters = [...importers].filter((imp) => {
      const b = basename(imp);
      return imp !== abs && b !== `test_${lib}` && !b.endsWith(`test_${lib}`);
    });
    if (realImporters.length > 0) continue; // imported by production code -> alive
    // No production importer. Is it referenced by name in any OTHER production script
    // (spawn / execFileSync / dynamic path / CLI dispatch)?
    const referencedInProd = files.some((f) => f !== abs && (prodText.get(f) || "").includes(lib));
    if (referencedInProd) importOrphaned.push(lib);
    else dead.push(lib);
  }
  return { dead, importOrphaned, total: libs.length };
}

// ─── test gating + real-data grounding ───────────────────────────────────────
function testFiles() {
  const dir = join(SKILL_DIR, "tests");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("test_") && f.endsWith(".mjs")) : [];
}
export function gatedTests() {
  const tests = testFiles();
  const runMjs = safeRead(join(SKILL_DIR, "tests", "ive", "run.mjs"));
  const gated = tests.filter((t) => runMjs.includes(t));
  return { gated, total: tests.length };
}
export function realDataGroundedTests() {
  const dir = join(SKILL_DIR, "tests");
  const tests = testFiles();
  const grounded = tests.filter((t) => safeRead(join(dir, t)).includes("real_telemetry"));
  const fxDir = join(dir, "fixtures", "real_telemetry");
  const fixtures = existsSync(fxDir) ? readdirSync(fxDir).filter((f) => f.endsWith(".jsonl")).length : 0;
  return { grounded, total: tests.length, fixtures };
}

// ─── genuine close rate ──────────────────────────────────────────────────────
// A GENUINE close traversed the real gate chain: state==CLOSE AND state.json.transitions
// contains a `validate-to-close` transition. `close --informational` skips that gate, so
// informational/SKIP closes are excluded — the difference between naive ~99% and real ~65%.
// A GENUINE close has a real VALIDATE->CLOSE transition that PASSED the gate. The
// transition entries are {from, to, timestamp, gate_result, failure_codes, marker?}.
// `close --informational` / force-close jump to CLOSE from EXECUTE/EXPLORE with
// gate_result "SKIP" and a [FORCE-CLOSED]/[INFORMATIONAL-CLOSE] marker — excluded.
function hasGenuineCloseTransition(state) {
  const tr = state?.transitions || state?.history || [];
  if (!Array.isArray(tr)) return false;
  return tr.some((t) => {
    const to = String(t?.to || "").toUpperCase();
    const from = String(t?.from || "").toUpperCase();
    const result = String(t?.gate_result || t?.result || "").toUpperCase();
    const marker = String(t?.marker || "");
    if (to !== "CLOSE") return false;
    if (/FORCE-CLOSED|INFORMATIONAL/i.test(marker)) return false;
    if (result === "SKIP") return false;
    return from === "VALIDATE"; // the real penultimate state before a gated close
  });
}
export function genuineCloseRate({ cwd = REPO_ROOT } = {}) {
  const plansRoot = join(cwd, "plans");
  let total = 0, closed = 0, genuine = 0, informational = 0;
  if (!existsSync(plansRoot)) return { total, closed, genuine, informational, rate: 0 };
  for (const d of readdirSync(plansRoot).filter((x) => x.startsWith("plan_"))) {
    const sp = join(plansRoot, d, "state.json");
    if (!existsSync(sp)) continue;
    let s; try { s = JSON.parse(safeRead(sp)); } catch { continue; }
    total += 1;
    const st = String(s.state || s.current_state || "").toUpperCase();
    if (st !== "CLOSE" && st !== "CLOSED") continue;
    closed += 1;
    if (hasGenuineCloseTransition(s)) genuine += 1; else informational += 1;
  }
  return { total, closed, genuine, informational, rate: total ? genuine / total : 0 };
}

// ─── aggregate ───────────────────────────────────────────────────────────────
export function collectVerificationMetrics({ cwd = REPO_ROOT } = {}) {
  const dl = deadLoadLibs();
  const gt = gatedTests();
  const rd = realDataGroundedTests();
  const gc = genuineCloseRate({ cwd });
  const round = (n) => Math.round(n * 1000) / 1000;
  const metrics = {
    dead_load_ratio: dl.total ? round(dl.dead.length / dl.total) : 0,
    gated_test_ratio: gt.total ? round(gt.gated.length / gt.total) : 0,
    real_data_grounded_ratio: rd.total ? round(rd.grounded.length / rd.total) : 0,
    genuine_close_rate: round(gc.rate),
  };
  return {
    schema_version: 1,
    generated_at: null, // stamped by the caller / CI to keep this pure
    metrics,
    detail: {
      dead_load: { count: dl.dead.length, total: dl.total, libs: dl.dead.sort(), import_orphaned: (dl.importOrphaned || []).sort() },
      gated_tests: { gated: gt.gated.length, total: gt.total, ungated: gt.total - gt.gated.length },
      real_data: { grounded: rd.grounded.length, total: rd.total, fixtures: rd.fixtures },
      genuine_close: gc,
    },
    // definitions are documented so a reader knows exactly what each ratio means
    definitions: {
      dead_load_ratio: "scripts/lib/*.mjs that are PRODUCTION-UNREACHABLE (no production importer in a parsed import graph AND not referenced by name in any other production script) / total lib modules. Test-only references are excluded (a test naming a module doesn't make it reachable). Some unreachable modules are test harnesses to keep, not remove — triage required.",
      gated_test_ratio: "test_*.mjs files referenced by tests/ive/run.mjs / total test_*.mjs files",
      real_data_grounded_ratio: "test_*.mjs files consuming real_telemetry fixtures / total test_*.mjs files",
      genuine_close_rate: "plans whose state.json.transitions include a validate-to-close gate (excludes `close --informational`) / total plans with a state.json",
    },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const report = collectVerificationMetrics();
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const m = report.metrics, d = report.detail;
    const pct = (x) => (x * 100).toFixed(1) + "%";
    console.log("Verification metrics (real definitions)\n");
    console.log(`  dead_load_ratio:          ${pct(m.dead_load_ratio)}  (${d.dead_load.count}/${d.dead_load.total} lib modules, production-unreachable)`);
    console.log(`     production-unreachable (triage: remove vs wire vs keep-as-test-harness): ${d.dead_load.libs.join(", ") || "(none)"}`);
    console.log(`     import-orphaned (referenced by name in prod, not imported): ${d.dead_load.import_orphaned.join(", ") || "(none)"}`);
    console.log(`  gated_test_ratio:         ${pct(m.gated_test_ratio)}  (${d.gated_tests.gated}/${d.gated_tests.total}; ${d.gated_tests.ungated} ungated)`);
    console.log(`  real_data_grounded_ratio: ${pct(m.real_data_grounded_ratio)}  (${d.real_data.grounded}/${d.real_data.total}; ${d.real_data.fixtures} fixtures)`);
    console.log(`  genuine_close_rate:       ${pct(m.genuine_close_rate)}  (${d.genuine_close.genuine} genuine / ${d.genuine_close.total} plans; ${d.genuine_close.closed} state==CLOSE, ${d.genuine_close.informational} informational/skip)`);
  }
}
