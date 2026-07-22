#!/usr/bin/env node
// test_program_packet_design_to_ready_gate.mjs
//
// Closes the CI gap that let "verified" tickets resting on uncommitted, local-only
// plan dirs survive CI: the conformance runner validated the IVE packet SCHEMA
// (core-packet-contract) but never ran Program-Packet `design-to-ready`, which is
// what catches required_child_plan_dir_missing / program_child_plan_not_closed on a
// clean checkout. This test runs design-to-ready on every program packet so that
// class fails in CI instead of being discovered mid-implementation.
//
// Known-debt packets are reported as ADVISORY (visible every run, non-blocking)
// until they are verified + cleaned; remove a packet from KNOWN_DEBT once it passes.

import { execFileSync } from "child_process";
import { readdirSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { validateProgramPacket } from "../scripts/lib/program_packet.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const NODE = process.execPath;
const PM = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "program_manager.mjs");
const PROGRAMS_DIR = join(repoRoot, "plans", "programs");

// Pre-existing design-to-ready debt NOT yet adversarially verified + cleaned.
// These stay visible (advisory) every CI run. Shrink this set as packets are fixed.
const KNOWN_DEBT = new Set([
  "ive-visualizer-frontend",    // 6 missing-plan-dir tickets (same pattern as remediation)
  "program-manager-hardening",  // 4 verification-not-passed rows (distinct pattern)
]);

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

function designToReady(packetPath) {
  try {
    const out = execFileSync(NODE, [PM, "verify", "design-to-ready", "--program", packetPath, "--json"], { encoding: "utf-8" });
    return JSON.parse(out);
  } catch (e) {
    // verify exits non-zero on FAIL; the JSON is still on stdout.
    try { return JSON.parse(String(e.stdout || "")); } catch { return { status: "ERROR", errors: [{ code: "cli_error", message: String(e.message).slice(0, 200) }] }; }
  }
}

console.log("\nProgram-packet design-to-ready CI gate\n");

// ── 1. Detection guard: the gate MUST catch a required child plan whose dir is missing.
// (If this silently stops catching the class, the whole gate is theater.)
const tmp = mkdtempSync(join(tmpdir(), "d2r-guard-"));
try {
  const bad = { id: "PROG-GUARD", status: "active",
    tickets: [{ id: "T-GUARD", lifecycle: "verified",
      child_plan: { policy: "required", plan_dir: "plans/does_not_exist_xyz", reason: "guard" } }] };
  const res = validateProgramPacket(bad, { cwd: tmp });
  const codes = res.errors.map((e) => e.code);
  assert(codes.includes("required_child_plan_dir_missing"),
    "a verified ticket with a required-but-missing child-plan dir is caught (gate is real)");

  // And a valid waiver clears it (JS/Prolog parity — the honest remediation path).
  const waived = { id: "PROG-GUARD", status: "active",
    decisions: [{ id: "D-W", type: "child_plan_artifact_waiver", subject_ref: "PROG-GUARD", decision: "x", rationale: "y" }],
    tickets: [{ id: "T-GUARD", lifecycle: "verified",
      child_plan: { policy: "required", plan_dir: "plans/does_not_exist_xyz", reason: "guard", waiver_decision_ref: "D-W" } }] };
  const wres = validateProgramPacket(waived, { cwd: tmp });
  assert(!wres.errors.some((e) => e.code.startsWith("required_child_plan")),
    "a valid waiver_decision_ref clears the missing-dir error (JS layer)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── 2. Enforce design-to-ready on every committed program packet.
let packetDirs = [];
try { packetDirs = readdirSync(PROGRAMS_DIR).filter((d) => existsSync(join(PROGRAMS_DIR, d, "program_packet.json"))); } catch { /* none */ }
assert(packetDirs.length > 0, `discovered program packets to validate (${packetDirs.length})`);

for (const dir of packetDirs) {
  const packetPath = join(PROGRAMS_DIR, dir, "program_packet.json");
  const res = designToReady(packetPath);
  const errCount = (res.errors || []).length;
  if (KNOWN_DEBT.has(dir)) {
    console.log(`  ADVISORY (known debt): ${dir} → status=${res.status}, ${errCount} design-to-ready error(s) — tracked, not blocking. Remove from KNOWN_DEBT once cleaned.`);
    continue;
  }
  assert(res.status === "PASS" && errCount === 0,
    `${dir} passes design-to-ready (status=${res.status}, ${errCount} errors)`);
  if (res.status !== "PASS") (res.errors || []).slice(0, 6).forEach((e) => console.log(`       ${e.code} ${e.path || e.message || ""}`));
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
