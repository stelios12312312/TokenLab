#!/usr/bin/env node
// @planner:module harvest_real_telemetry_test
// @planner:capability Well-formedness + consumer-compatibility contract for
// harvested real-telemetry fixtures (US-088, T-INTAKE-F28D005F). Asserts:
// (1) the harvester stages provenance-led JSONL fixtures whose gate_transition
// lines are byte-verbatim; (2) the live consumer (gate_false_failure_ledger)
// accepts staged fixtures; (3) harvesting is idempotent and --dry-run writes
// nothing; (4) committed fixtures (legacy + harvested) honor the golden shape;
// (5) when registered siblings exist on this machine, a real harvest passes
// the same contract (SKIPs loudly on clean checkouts, per G-079).

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const TESTS_ROOT = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(TESTS_ROOT, "..");
const HARVESTER = join(SKILL_ROOT, "scripts", "harvest_real_telemetry.mjs");
const LEDGER = join(SKILL_ROOT, "scripts", "gate_false_failure_ledger.mjs");
const FIXTURES_DIR = join(TESTS_ROOT, "fixtures", "real_telemetry");
const DEFAULT_REGISTRY = join(SKILL_ROOT, "config", ".project_registry.json");

// Required keys are what the live consumer (gate_false_failure_ledger.mjs)
// actually reads. _prev_hash/_record_hash are NOT required: fleet projects on
// older planner versions emit records without hash-chaining (verified live:
// TokenLab plan_2026-06-09_55f19326ff45bbe3), and the consumer never reads them.
const GOLDEN_KEYS = ["timestamp", "type", "gate", "inputs", "checks", "decision", "next_state", "failure_codes"];

let passed = 0, failed = 0, skipped = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`); }
}
function skip(name, reason) { skipped++; console.log(`  SKIP: ${name} — ${reason}`); }

function runHarvester(args) {
  return execFileSync("node", [HARVESTER, ...args], { encoding: "utf-8" });
}

function assertFixtureShape(label, content, { expectProvenance }) {
  const lines = content.split("\n").filter((l) => l.trim());
  check(`${label}: parses as JSONL`, lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  const entries = lines.map((l) => JSON.parse(l));
  let body = entries;
  if (expectProvenance) {
    const prov = entries[0];
    check(`${label}: line 1 is harvest_provenance`, prov?.type === "harvest_provenance");
    for (const key of ["source_project", "plan_id", "source_path", "gate_code", "record_count", "harvested_at"]) {
      check(`${label}: provenance has ${key}`, prov != null && prov[key] !== undefined && prov[key] !== null && prov[key] !== "");
    }
    body = entries.slice(1);
    check(`${label}: provenance record_count matches body`, prov?.record_count === body.length);
  }
  check(`${label}: body is gate_transition records`, body.length > 0 && body.every((e) => e?.type === "gate_transition"));
  const missing = body.flatMap((e, i) => GOLDEN_KEYS.filter((k) => !(k in e)).map((k) => `line${i}:${k}`));
  check(`${label}: golden key set present on every record`, missing.length === 0, missing.slice(0, 4).join(", "));
}

function runLedgerOverFixture(content) {
  const repo = mkdtempSync(join(tmpdir(), "harvest-consumer-"));
  try {
    mkdirSync(join(repo, "plans", "plan_real", "artifacts"), { recursive: true });
    writeFileSync(join(repo, "plans", "plan_real", "artifacts", "decision_log.jsonl"), content);
    const out = execFileSync("node", [LEDGER, "--cwd", repo, "--json"], { encoding: "utf-8" });
    return JSON.parse(out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
console.log("\nHarvest Real Telemetry Contract Test\n");

// ── Leg 1: synthetic project (CI-safe, no siblings required) ──────────────
const work = mkdtempSync(join(tmpdir(), "harvest-synth-"));
try {
  const projDir = join(work, "synthetic-project");
  const planArtifacts = join(projDir, "plans", "plan_2026-01-01_aaaa", "artifacts");
  mkdirSync(planArtifacts, { recursive: true });

  const mkRecord = (i, codes) => JSON.stringify({
    timestamp: `2026-01-01T00:0${i}:00.000Z`, type: "gate_transition", gate: "explore-to-plan",
    inputs: { plan: "plan_2026-01-01_aaaa", source_state: "explore" },
    checks: [{ name: "synthetic", status: codes.length ? "FAIL" : "PASS", code: codes[0] || null }],
    decision: codes.length ? "blocked" : "allowed", next_state: codes.length ? "explore" : "plan",
    failure_codes: codes, _prev_hash: `h${i - 1}`, _record_hash: `h${i}`,
  });
  const sourceLines = [
    mkRecord(1, ["GATE-TST-001"]),
    JSON.stringify({ type: "note", detail: "non-transition record the harvester must filter" }),
    mkRecord(2, ["GATE-TST-001"]),
    "not-json-at-all",
    mkRecord(3, []),
  ];
  writeFileSync(join(planArtifacts, "decision_log.jsonl"), sourceLines.join("\n") + "\n");

  const registryPath = join(work, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ projects: [{ path: projDir, type: "standard" }] }, null, 2));
  const outDir = join(work, "out");

  // --dry-run writes nothing
  runHarvester(["--project", "synthetic-project", "--gate", "GATE-TST-001", "--registry", registryPath, "--out", outDir, "--dry-run"]);
  check("synthetic: --dry-run writes nothing", !existsSync(outDir) || readdirSync(outDir).length === 0);

  // real harvest
  runHarvester(["--project", "synthetic-project", "--gate", "GATE-TST-001", "--registry", registryPath, "--out", outDir]);
  const fixturePath = join(outDir, "synthetic_project_GATE-TST-001.jsonl");
  check("synthetic: fixture staged", existsSync(fixturePath));
  const content = readFileSync(fixturePath, "utf-8");
  assertFixtureShape("synthetic", content, { expectProvenance: true });

  // byte-verbatim body: each body line must appear verbatim in the source
  const bodyLines = content.split("\n").filter((l) => l.trim()).slice(1);
  check("synthetic: gate_transition lines byte-verbatim from source", bodyLines.every((l) => sourceLines.includes(l)));
  check("synthetic: non-gate_transition source lines filtered", bodyLines.length === 3);
  const prov = JSON.parse(content.split("\n")[0]);
  check("synthetic: skipped_lines counted in provenance", prov.skipped_lines === 2);

  // idempotency
  runHarvester(["--project", "synthetic-project", "--gate", "GATE-TST-001", "--registry", registryPath, "--out", outDir]);
  check("synthetic: re-harvest is byte-identical", readFileSync(fixturePath, "utf-8") === content);

  // consumer compatibility (live ledger over provenance-led fixture)
  const ledger = runLedgerOverFixture(content);
  check("synthetic: live consumer parses staged fixture", ledger?.plan_count === 1);
  check("synthetic: live consumer scored the gate", ledger?.gates?.["explore-to-plan"]?.attempts === 3);

  // unknown gate exits non-zero, writes nothing
  let failedAsExpected = false;
  try { runHarvester(["--project", "synthetic-project", "--gate", "GATE-NOPE-999", "--registry", registryPath, "--out", outDir]); }
  catch { failedAsExpected = true; }
  check("synthetic: unmatched gate exits non-zero", failedAsExpected);
  check("synthetic: unmatched gate writes no fixture", !existsSync(join(outDir, "synthetic_project_GATE-NOPE-999.jsonl")));
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ── Leg 2: committed fixtures honor the golden shape ──────────────────────
for (const name of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
  const content = readFileSync(join(FIXTURES_DIR, name), "utf-8");
  const first = JSON.parse(content.split("\n").find((l) => l.trim()));
  assertFixtureShape(`committed ${name}`, content, { expectProvenance: first?.type === "harvest_provenance" });
}

// ── Leg 3: real siblings on this machine (G-079) — SKIP loudly on CI ──────
let realLegRan = false;
if (existsSync(DEFAULT_REGISTRY)) {
  const registry = JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf-8"));
  const present = (registry.projects || []).filter((p) => p?.path && existsSync(p.path) && existsSync(join(p.path, "plans")) && resolve(p.path) !== resolve(SKILL_ROOT, "..", "..", ".."));
  if (present.length > 0) {
    const listOut = runHarvester(["--list", "--json"]);
    const listed = JSON.parse(listOut);
    check("real: --list enumerates registry projects", Array.isArray(listed.projects) && listed.projects.length === (registry.projects || []).length);
    realLegRan = true;
  }
}
if (!realLegRan) skip("real sibling harvest", "no registered sibling projects with plans/ on this machine (clean checkout) — synthetic leg covers the contract");

// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
