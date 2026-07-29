#!/usr/bin/env node
// test_prolog_value_audit.mjs - E8-2 prove-or-lose evidence for Prolog ontology value.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildPrologValueAudit,
  DEFAULT_GATE_SURVIVAL_PATH,
} from "../scripts/lib/prolog_value_audit.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const script = join(skillDir, "scripts", "prolog_value_audit.mjs");
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

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

console.log("\nProlog Value Audit Tests\n");

const report = buildPrologValueAudit({ repoRoot });
assert(report.status === "PASS", "real Prolog value audit passes");
assert(report.decision === "keep_minimal_prolog", "audit decides to keep minimal Prolog with named value");
assert(report.e2_4_gate_survival?.path === DEFAULT_GATE_SURVIVAL_PATH, "audit cites default E2-4 gate-survival path");
assert(report.e2_4_gate_survival?.summary?.total_attempts >= 3000, "audit carries E2-4 total attempt count");
assert(report.e2_4_gate_survival?.summary?.check_delete_count >= 100, "audit carries E2-4 delete-candidate check count");

const uniqueIds = new Set(report.unique_catches.map((row) => row.id));
for (const id of [
  "traceability_graph_join",
  "tokenomics_arithmetic",
  "temporal_split_leakage_guard",
  "program_packet_relational_invariants",
  "gate_chain_reachability",
]) {
  assert(uniqueIds.has(id), `unique catch is named: ${id}`);
}

const tokenomics = report.unique_catches.find((row) => row.id === "tokenomics_arithmetic");
assert(tokenomics?.rule_ids?.includes("TK-007"), "tokenomics catch includes TK-007");
assert(tokenomics?.rule_ids?.includes("TK-012"), "tokenomics catch includes TK-012");
assert((tokenomics?.evidence_refs || []).some((ref) => ref.includes("test_tokenomics_conformance.mjs")), "tokenomics catch has governed executable evidence");

const missingEvidenceKeep = report.unique_catches.filter((row) => row.verdict.startsWith("keep") && (row.evidence_refs || []).length === 0);
assert(missingEvidenceKeep.length === 0, "no keep candidate lacks evidence refs");

const reachability = report.duplicate_or_noisy_candidates.find((row) => row.id === "reachability_disabled_claim");
assert(reachability?.verdict === "stale_claim_refuted", "stale disabled-reachability claim is refuted");
assert(report.current_wiring.reachability_audit.enabled === true, "current determinism wiring has reachability audit enabled");
assert(report.current_wiring.gates_with_reachability.length >= 5, "current gate config enables reachability for main gates");

const cli = JSON.parse(execFileSync(NODE, [script, "--json"], { encoding: "utf-8" }));
assert(cli.status === "PASS", "CLI JSON reports PASS");
assert(cli.decision === report.decision, "CLI JSON matches library decision");

const tmp = mkdtempSync(join(tmpdir(), "prolog-value-audit-"));
try {
  const missing = buildPrologValueAudit({
    repoRoot,
    gateSurvivalPath: join(tmp, "missing", "gate_survival.json"),
  });
  assert(missing.status === "FAIL", "missing gate-survival report fails closed");
  assert(missing.failures.some((failure) => failure.code === "missing_gate_survival"), "missing report identifies missing_gate_survival");

  const brokenPath = join(tmp, "reports", "ive", "gate_survival", "gate_survival.json");
  writeJson(brokenPath, { summary: {}, gates: {}, checks: [] });
  const broken = buildPrologValueAudit({ repoRoot, gateSurvivalPath: brokenPath });
  assert(broken.status === "FAIL", "empty gate-survival report fails closed");
  assert(broken.failures.some((failure) => failure.code === "gate_survival_missing_attempts"), "empty report identifies missing attempt evidence");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

assert(existsSync(join(repoRoot, DEFAULT_GATE_SURVIVAL_PATH)), "default E2-4 gate-survival artifact exists");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
