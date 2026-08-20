#!/usr/bin/env node
// @planner:module harvest_real_telemetry
// @planner:capability Registry-driven, read-only harvester that stages real
// gate_transition fixtures (with provenance headers) from registered sibling
// projects into tests/fixtures/real_telemetry/. Story: US-088. Tickets:
// T-INTAKE-17421755, T-INTAKE-E1C56B87, T-INTAKE-F28D005F.
//
// Contract (see plan_2026-06-10_146c9969366d5dcf):
//   - READ-ONLY on sibling repos; writes only inside --out (default:
//     <this repo>/.agent/skills/iterative-planner/tests/fixtures/real_telemetry).
//   - gate_transition lines are copied byte-verbatim from the source
//     decision_log.jsonl. Line 1 of each fixture is a `harvest_provenance`
//     record, a type the existing consumer (gate_false_failure_ledger.mjs)
//     provably skips.
//   - Idempotent: same args + unchanged sources => byte-identical output.
//     `harvested_at` derives from the source records, not wall clock.
//   - Deterministic selection: most matching records, then latest
//     first-record timestamp, then plan id.
//
// Usage:
//   node harvest_real_telemetry.mjs --list [--registry <path>] [--json]
//   node harvest_real_telemetry.mjs --project <name> --gate <CODE>
//       [--plan <plan_id>] [--out <dir>] [--dry-run] [--registry <path>]
//   node harvest_real_telemetry.mjs --all-projects --gate <CODE> [...]

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_REGISTRY = join(SKILL_ROOT, "config", ".project_registry.json");
const DEFAULT_OUT = join(SKILL_ROOT, "tests", "fixtures", "real_telemetry");
const PROVENANCE_TYPE = "harvest_provenance";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    list: false, json: false, dryRun: false, allProjects: false,
    project: null, gate: null, plan: null,
    registry: DEFAULT_REGISTRY, out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--json") args.json = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--all-projects") args.allProjects = true;
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--gate") args.gate = argv[++i];
    else if (a === "--plan") args.plan = argv[++i];
    else if (a === "--registry") args.registry = resolve(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

function usage() {
  console.log(`harvest_real_telemetry.mjs — stage real gate_transition fixtures from registered projects

  --list                      Inventory registered projects present on this machine
  --project <name> --gate <CODE>   Stage one fixture for the named project + failure code
  --all-projects --gate <CODE>     Stage a fixture from every project containing the code
  --plan <plan_id>            Pin an exact plan (default: deterministic selection)
  --out <dir>                 Output directory (default: tests/fixtures/real_telemetry)
  --dry-run                   Print what would be staged without writing
  --registry <path>           Registry JSON (default: config/.project_registry.json)
  --json                      Machine-readable output`);
}

// ---------------------------------------------------------------------------
// Registry + scanning (read-only on sibling repos)
// ---------------------------------------------------------------------------

function projectSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function loadRegistry(registryPath) {
  if (!existsSync(registryPath)) {
    throw new Error(`Registry not found: ${registryPath}`);
  }
  const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
  const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
  return projects
    .filter((p) => typeof p?.path === "string" && p.path.trim())
    .map((p) => ({ path: p.path, name: basename(p.path) }));
}

function listPlanDirs(projectPath) {
  const plansDir = join(projectPath, "plans");
  if (!existsSync(plansDir)) return [];
  let entries;
  try { entries = readdirSync(plansDir); } catch { return []; }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.startsWith("plan_")) continue;
    const full = join(plansDir, entry);
    try { if (statSync(full).isDirectory()) dirs.push({ id: entry, path: full }); } catch { /* skip unreadable */ }
  }
  return dirs.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Read one plan's decision log. Returns verbatim gate_transition lines plus
 * parse bookkeeping. Lines are kept byte-identical (no re-serialization).
 */
function readPlanTelemetry(planDir) {
  const logPath = join(planDir.path, "artifacts", "decision_log.jsonl");
  if (!existsSync(logPath)) return null;
  let raw;
  try { raw = readFileSync(logPath, "utf-8"); } catch { return null; }
  const lines = raw.split("\n");
  const records = [];
  let skipped = 0;
  // Source chain state, recorded honestly in provenance: fleet projects on
  // older planner versions emit logs with broken or absent _prev_hash chains.
  // Fixtures reproduce the source faithfully, so downstream integrity checks
  // must key off this field rather than assume chain perfection.
  let hashedRecords = 0, chainBreaks = 0, prevHash = null, firstHashed = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { skipped++; continue; }
    if (typeof entry?._record_hash === "string") {
      hashedRecords++;
      if (!firstHashed && entry._prev_hash !== prevHash) chainBreaks++;
      prevHash = entry._record_hash;
      firstHashed = false;
    }
    if (entry?.type !== "gate_transition") { skipped++; continue; }
    records.push({ line, entry });
  }
  if (records.length === 0) return null;
  const sourceChain = hashedRecords === 0 ? "absent" : chainBreaks === 0 ? "intact" : "broken";
  return { plan_id: planDir.id, source_path: logPath, records, skipped_lines: skipped, source_chain: sourceChain };
}

function recordMatchesGate(entry, gateCode) {
  if (Array.isArray(entry.failure_codes) && entry.failure_codes.includes(gateCode)) return true;
  if (Array.isArray(entry.checks)) {
    for (const c of entry.checks) if (c?.code === gateCode) return true;
  }
  return false;
}

function scanProject(project, { gate = null } = {}) {
  const planDirs = listPlanDirs(project.path);
  const plans = [];
  for (const pd of planDirs) {
    const telemetry = readPlanTelemetry(pd);
    if (!telemetry) continue;
    const matches = gate
      ? telemetry.records.filter((r) => recordMatchesGate(r.entry, gate)).length
      : 0;
    plans.push({ ...telemetry, match_count: matches });
  }
  return plans;
}

/** Deterministic selection: most matches, then latest first-record timestamp, then plan id. */
function selectPlan(plans, { gate, pinnedPlan = null }) {
  if (pinnedPlan) {
    const exact = plans.find((p) => p.plan_id === pinnedPlan);
    if (!exact) return { error: `Plan '${pinnedPlan}' not found or has no gate_transition records` };
    if (gate && exact.match_count === 0) return { error: `Plan '${pinnedPlan}' contains no records matching ${gate}` };
    return { plan: exact };
  }
  const candidates = plans.filter((p) => p.match_count > 0);
  if (candidates.length === 0) return { error: `No plan contains records matching ${gate}` };
  candidates.sort((a, b) => {
    if (b.match_count !== a.match_count) return b.match_count - a.match_count;
    const ta = a.records[0]?.entry?.timestamp || "";
    const tb = b.records[0]?.entry?.timestamp || "";
    if (ta !== tb) return tb.localeCompare(ta);
    return a.plan_id.localeCompare(b.plan_id);
  });
  return { plan: candidates[0] };
}

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

function buildFixture({ project, plan, gate }) {
  // harvested_at derives from source content (last record timestamp), not wall
  // clock, so re-harvesting unchanged sources is byte-identical (idempotency).
  const lastTs = plan.records[plan.records.length - 1]?.entry?.timestamp || null;
  const provenance = {
    type: PROVENANCE_TYPE,
    source_project: project.name,
    source_project_path: project.path,
    plan_id: plan.plan_id,
    source_path: plan.source_path,
    gate_code: gate,
    record_count: plan.records.length,
    match_count: plan.match_count,
    skipped_lines: plan.skipped_lines,
    source_chain: plan.source_chain,
    harvested_at: lastTs,
    harvester: "harvest_real_telemetry.mjs",
    note: "Line 1 is provenance metadata; consumers that filter on type==='gate_transition' skip it. gate_transition lines are byte-verbatim from the source decision_log.jsonl and keep their original _prev_hash/_record_hash chain.",
  };
  const body = plan.records.map((r) => r.line).join("\n");
  return JSON.stringify(provenance) + "\n" + body + "\n";
}

function fixtureFilename(project, gate) {
  return `${projectSlug(project.name)}_${gate}.jsonl`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(args) {
  const registry = loadRegistry(args.registry);
  const rows = [];
  for (const project of registry) {
    if (!existsSync(project.path)) {
      rows.push({ project: project.name, present: false, reason: "path missing on this machine", plans: 0, records: 0 });
      continue;
    }
    const plans = scanProject(project);
    const records = plans.reduce((sum, p) => sum + p.records.length, 0);
    rows.push({
      project: project.name, present: true,
      plans: plans.length, records,
      ...(plans.length === 0 ? { reason: "no plans with gate_transition telemetry" } : {}),
    });
  }
  if (args.json) {
    emitJson({ registry: args.registry, projects: rows }, { exitCode: 0 });
  } else {
    for (const r of rows) {
      const status = r.present ? `${String(r.plans).padStart(4)} plans ${String(r.records).padStart(6)} records` : `ABSENT (${r.reason})`;
      console.log(`  ${r.project.padEnd(36)} ${status}`);
    }
    const present = rows.filter((r) => r.present);
    console.log(`\n  ${present.length}/${rows.length} registered projects present; ${present.reduce((s, r) => s + r.records, 0)} gate_transition records total`);
  }
  return 0;
}

function harvestOne(project, args, results) {
  const plans = scanProject(project, { gate: args.gate });
  const picked = selectPlan(plans, { gate: args.gate, pinnedPlan: args.plan });
  if (picked.error) {
    results.push({ project: project.name, status: "no_match", detail: picked.error });
    return;
  }
  const plan = picked.plan;
  const content = buildFixture({ project, plan, gate: args.gate });
  const outPath = join(args.out, fixtureFilename(project, args.gate));
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null;
  const changed = existing !== content;

  if (args.dryRun) {
    results.push({
      project: project.name, status: "dry_run", plan_id: plan.plan_id,
      records: plan.records.length, matches: plan.match_count,
      out: outPath, would_write: changed,
    });
    return;
  }
  if (changed) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(outPath, content);
  }
  results.push({
    project: project.name, status: changed ? "staged" : "unchanged",
    plan_id: plan.plan_id, records: plan.records.length,
    matches: plan.match_count, out: outPath,
  });
}

function cmdHarvest(args) {
  if (!args.gate) { console.error("ERROR: --gate <CODE> is required for harvesting."); return 2; }
  const registry = loadRegistry(args.registry);
  let targets;
  if (args.allProjects) {
    targets = registry.filter((p) => existsSync(p.path));
  } else {
    const wanted = args.project;
    targets = registry.filter((p) => p.name === wanted || projectSlug(p.name) === projectSlug(wanted));
    if (targets.length === 0) {
      console.error(`ERROR: project '${wanted}' not in registry. Known: ${registry.map((p) => p.name).join(", ")}`);
      return 2;
    }
    if (!existsSync(targets[0].path)) {
      console.error(`ERROR: project '${wanted}' is registered but absent at ${targets[0].path}`);
      return 2;
    }
  }

  const results = [];
  for (const project of targets) harvestOne(project, args, results);
  const staged = results.filter((r) => r.status !== "no_match");
  const exitCode = !args.allProjects && staged.length === 0 ? 1 : 0;

  if (args.json) {
    emitJson({ gate: args.gate, dry_run: args.dryRun, results }, { exitCode });
  } else {
    for (const r of results) {
      if (r.status === "no_match") console.log(`  ${r.project}: NO MATCH — ${r.detail}`);
      else console.log(`  ${r.project}: ${r.status} ${r.plan_id} (${r.records} records, ${r.matches} matching) -> ${r.out}`);
    }
  }
  return exitCode;
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.list && !args.gate && !args.project && !args.allProjects)) {
  usage();
  process.exit(args.help ? 0 : 2);
}
try {
  const exitCode = args.list ? cmdList(args) : cmdHarvest(args);
  if (!args.json || process.exitCode === undefined) process.exit(exitCode);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
