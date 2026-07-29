#!/usr/bin/env node
// @planner:module real_telemetry_false_reds
// @planner:capability Deterministic per-transition-gate false_red.json exports
// for the committed real-telemetry replay corpus. Story: US-088.

import { execFileSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { replayFixtures } from "./replay_telemetry.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { normalizeVerificationStatus } from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const SKILL_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");
const DEFAULT_FIXTURES = join(SKILL_ROOT, "tests", "fixtures", "real_telemetry");
const DEFAULT_OUT = join(DEFAULT_FIXTURES, "false_red");
const LEDGER = join(SCRIPT_DIR, "gate_false_failure_ledger.mjs");
const SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const args = {
    fixtures: DEFAULT_FIXTURES,
    out: DEFAULT_OUT,
    check: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixtures") args.fixtures = resolve(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--check") args.check = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function usage() {
  console.log(`real_telemetry_false_reds.mjs - build per-gate false_red.json exports

  --fixtures <dir>   Fixture directory (default: tests/fixtures/real_telemetry)
  --out <dir>        Output directory (default: <fixtures>/false_red)
  --check            Do not write; fail if exports are missing or stale
  --json             Emit machine-readable result`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function rel(path) {
  return relative(REPO_ROOT, path).split("\\").join("/");
}

function slugGate(gate) {
  return String(gate || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeDecision(entry) {
  if (entry?.decision === "BLOCKED" || entry?.decision === "ALLOWED") return entry.decision;
  if (Array.isArray(entry?.checks) && entry.checks.some((check) =>
    normalizeVerificationStatus(check?.status, "gate").kind === "fail"
  )) return "BLOCKED";
  return "UNKNOWN";
}

function parseJsonl(path) {
  const raw = readFileSync(path, "utf-8");
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line));
  }
  return { raw, entries };
}

function compactProvenance(entry) {
  if (entry?.type !== "harvest_provenance") return null;
  return {
    source_project: entry.source_project || null,
    plan_id: entry.plan_id || null,
    source_path: entry.source_path || null,
    gate_code: entry.gate_code || null,
    record_count: entry.record_count ?? null,
    match_count: entry.match_count ?? null,
    source_chain: entry.source_chain || null,
    harvested_at: entry.harvested_at || null,
    harvester: entry.harvester || null,
  };
}

function readFixture(path) {
  const { raw, entries } = parseJsonl(path);
  const first = entries[0] || null;
  const provenance = compactProvenance(first);
  const body = provenance ? entries.slice(1) : entries;
  const transitions = body.filter((e) => e?.type === "gate_transition");
  const gates = {};
  for (const entry of transitions) {
    const gateName = entry.gate || "unknown";
    const g = gates[gateName] ||= {
      attempts: 0,
      blocked: 0,
      allowed: 0,
      unknown: 0,
      failure_codes: {},
    };
    g.attempts += 1;
    const decision = normalizeDecision(entry);
    if (decision === "BLOCKED") g.blocked += 1;
    else if (decision === "ALLOWED") g.allowed += 1;
    else g.unknown += 1;
    for (const code of entry.failure_codes || []) {
      g.failure_codes[code] = (g.failure_codes[code] || 0) + 1;
    }
  }
  return {
    name: basename(path),
    path,
    rel_path: rel(path),
    sha256: sha256(raw),
    provenance,
    gate_transitions: transitions.length,
    gates,
  };
}

function readFixtures(dir) {
  if (!existsSync(dir)) throw new Error(`Fixture directory not found: ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => readFixture(join(dir, f)));
}

function stageLedgerRepo(fixtures) {
  const root = mkdtempSync(join(tmpdir(), "false-red-ledger-"));
  for (const fixture of fixtures) {
    const planName = `plan_${fixture.name.replace(/\.jsonl$/, "").replace(/[^a-zA-Z0-9_]+/g, "_")}`;
    const artifactDir = join(root, "plans", planName, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    copyFileSync(fixture.path, join(artifactDir, "decision_log.jsonl"));
  }
  return root;
}

function runLedger(fixtures) {
  const root = stageLedgerRepo(fixtures);
  try {
    const out = execFileSync(process.execPath, [LEDGER, "--cwd", root, "--json"], {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function corpusDigest(fixtures) {
  const h = createHash("sha256");
  for (const f of fixtures) {
    h.update(f.name);
    h.update("\0");
    h.update(f.sha256);
    h.update("\0");
  }
  return h.digest("hex");
}

function sortedFailureCounts(obj = {}) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => ({ code, count }));
}

function buildExports({ fixturesDir, fixtures, ledger, replayResults }) {
  const replayByName = Object.fromEntries(replayResults.map((r) => [r.fixture, r]));
  const digest = corpusDigest(fixtures);
  const gates = Object.keys(ledger.gates || {}).sort();
  const codeRows = Array.isArray(ledger.failure_codes) ? ledger.failure_codes : [];
  const exports = {};

  for (const gate of gates) {
    const gateStats = ledger.gates[gate] || {};
    const relatedFixtures = fixtures
      .filter((fixture) => fixture.gates[gate])
      .map((fixture) => {
        const local = fixture.gates[gate];
        const replay = replayByName[fixture.name] || {};
        return {
          fixture: fixture.name,
          path: fixture.rel_path,
          sha256: fixture.sha256,
          provenance: fixture.provenance,
          gate_transitions: local.attempts,
          blocked: local.blocked,
          allowed: local.allowed,
          unknown: local.unknown,
          failure_codes: sortedFailureCounts(local.failure_codes),
          replay: {
            matched: replay.matched ?? null,
            mismatched: replay.mismatched ?? null,
            gate_transitions: replay.gate_transitions ?? null,
            not_check_derived: replay.not_check_derived ?? null,
            chain_valid: replay.chain_valid ?? null,
            chain_reason: replay.chain_reason || null,
          },
        };
      });

    const failureCodes = codeRows
      .filter((row) => Array.isArray(row.gates) && row.gates.includes(gate))
      .map((row) => ({
        code: row.code,
        blocked_on: row.blocked_on,
        self_cleared: row.self_cleared,
        self_clear_rate: row.self_clear_rate,
        systemic_suspect: !!row.systemic_suspect,
      }))
      .sort((a, b) => (b.self_cleared - a.self_cleared) || (b.blocked_on - a.blocked_on) || a.code.localeCompare(b.code));

    exports[gate] = {
      schema_version: SCHEMA_VERSION,
      artifact: "false_red.json",
      generated_by: "real_telemetry_false_reds.mjs",
      transition_gate: gate,
      source: {
        fixture_dir: rel(fixturesDir),
        fixture_count: fixtures.length,
        corpus_digest: digest,
        self_clear_window_sec: ledger.self_clear_window_sec,
      },
      gate_summary: {
        attempts: gateStats.attempts || 0,
        blocked: gateStats.blocked || 0,
        allowed: gateStats.allowed || 0,
        self_clearing_unblocks: gateStats.self_clearing_unblocks || 0,
        self_clear_rate: gateStats.self_clear_rate || 0,
        verdict: gateStats.verdict || "unknown",
        top_failure_codes: gateStats.top_failure_codes || [],
      },
      failure_codes: failureCodes,
      fixtures: relatedFixtures,
    };
  }
  return exports;
}

function expectedPaths(outDir, exportsByGate) {
  return Object.fromEntries(Object.keys(exportsByGate).sort().map((gate) => [
    gate,
    join(outDir, slugGate(gate), "false_red.json"),
  ]));
}

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function findExistingExportFiles(outDir) {
  if (!existsSync(outDir)) return [];
  const files = [];
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(outDir, entry.name, "false_red.json");
    if (existsSync(p)) files.push(p);
  }
  return files.sort();
}

function writeExports(outDir, exportsByGate) {
  rmSync(outDir, { recursive: true, force: true });
  const paths = expectedPaths(outDir, exportsByGate);
  for (const [gate, path] of Object.entries(paths)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialize(exportsByGate[gate]));
  }
  return Object.values(paths);
}

function checkExports(outDir, exportsByGate) {
  const paths = expectedPaths(outDir, exportsByGate);
  const expected = new Set(Object.values(paths).map((p) => resolve(p)));
  const existing = new Set(findExistingExportFiles(outDir).map((p) => resolve(p)));
  const missing = [];
  const stale = [];
  const extra = [];
  for (const [gate, path] of Object.entries(paths)) {
    if (!existsSync(path)) {
      missing.push(rel(path));
      continue;
    }
    const expectedText = serialize(exportsByGate[gate]);
    const actualText = readFileSync(path, "utf-8");
    if (actualText !== expectedText) stale.push(rel(path));
  }
  for (const path of existing) {
    if (!expected.has(path)) extra.push(rel(path));
  }
  return { ok: missing.length === 0 && stale.length === 0 && extra.length === 0, missing, stale, extra };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }

  const fixtures = readFixtures(args.fixtures);
  const ledger = runLedger(fixtures);
  const replayResults = replayFixtures(args.fixtures);
  const exportsByGate = buildExports({ fixturesDir: args.fixtures, fixtures, ledger, replayResults });
  const paths = expectedPaths(args.out, exportsByGate);
  const result = {
    schema_version: SCHEMA_VERSION,
    mode: args.check ? "check" : "write",
    fixture_count: fixtures.length,
    gate_count: Object.keys(exportsByGate).length,
    gates: Object.keys(exportsByGate).sort(),
    output_dir: rel(args.out),
    paths: Object.values(paths).map(rel),
  };

  if (args.check) {
    const check = checkExports(args.out, exportsByGate);
    const payload = { ...result, ok: check.ok, ...check };
    if (args.json) emitJson(payload);
    else if (check.ok) console.log(`false_red exports current: ${result.gate_count} gate(s), ${result.fixture_count} fixture(s)`);
    else console.log(`false_red exports stale/missing: ${[...check.missing, ...check.stale, ...check.extra].join(", ")}`);
    return check.ok ? 0 : 1;
  }

  const written = writeExports(args.out, exportsByGate);
  const payload = { ...result, ok: true, written: written.map(rel) };
  if (args.json) emitJson(payload);
  else console.log(`Wrote ${written.length} false_red export(s) from ${fixtures.length} fixture(s) to ${rel(args.out)}`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
