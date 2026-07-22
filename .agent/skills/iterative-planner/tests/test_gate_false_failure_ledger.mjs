#!/usr/bin/env node
// test_gate_false_failure_ledger.mjs — the false-failure ledger must detect a
// gate that blocks then passes unchanged (self-invalidation), distinguish it
// from a gate that blocks then is fixed with real work (slow unblock), and roll
// a cross-cutting failure code up across gates as a systemic suspect.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const skillDir = resolve(dirname(__filename), "..");
const ledger = join(skillDir, "scripts", "gate_false_failure_ledger.mjs");
const NODE = process.execPath;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// Build a decision_log.jsonl for one plan from compact transition specs.
function writePlan(plansDir, name, transitions) {
  const dir = join(plansDir, name, "artifacts");
  mkdirSync(dir, { recursive: true });
  const lines = transitions.map((t) => JSON.stringify({
    timestamp: t.at,
    type: "gate_transition",
    gate: t.gate,
    decision: t.decision,
    checks: t.checks,
    inputs: { plan: name, source_state: t.from || "explore" },
    failure_codes: t.codes || [],
  }));
  writeFileSync(join(dir, "decision_log.jsonl"), lines.join("\n") + "\n");
}

const tmp = mkdtempSync(join(tmpdir(), "ledger-test-"));
const plansDir = join(tmp, "plans");
try {
  // Plan A: execute-to-reflect BLOCKED 3× on GATE-TMP-002, then ALLOWED 18s
  // later with no edits → self-clearing. Same code also poisons plan-to-execute.
  writePlan(plansDir, "plan_2026-06-08_aaaa", [
    { at: "2026-06-08T10:23:00.000Z", gate: "plan-to-execute", decision: "BLOCKED", codes: ["GATE-TMP-002"] },
    { at: "2026-06-08T10:23:30.000Z", gate: "plan-to-execute", decision: "ALLOWED" },
    { at: "2026-06-08T10:31:16.000Z", gate: "execute-to-reflect", decision: "BLOCKED", codes: ["GATE-TMP-002"] },
    { at: "2026-06-08T10:31:38.000Z", gate: "execute-to-reflect", decision: "BLOCKED", codes: ["GATE-TMP-002"] },
    { at: "2026-06-08T10:31:59.000Z", gate: "execute-to-reflect", decision: "BLOCKED", codes: ["GATE-TMP-002"] },
    { at: "2026-06-08T10:32:17.000Z", gate: "execute-to-reflect", decision: "ALLOWED" },
    { at: "2026-06-08T10:40:00.000Z", gate: "reflect-to-validate", decision: "BLOCKED", codes: ["GATE-TMP-002"] },
    { at: "2026-06-08T10:40:20.000Z", gate: "reflect-to-validate", decision: "ALLOWED" },
  ]);
  // Plan B: explore-to-plan BLOCKED on GATE-EXP-001, fixed 40 MINUTES later
  // (real work) → NOT self-clearing.
  writePlan(plansDir, "plan_2026-06-08_bbbb", [
    { at: "2026-06-08T09:00:00.000Z", gate: "explore-to-plan", decision: "BLOCKED", codes: ["GATE-EXP-001"] },
    { at: "2026-06-08T09:40:00.000Z", gate: "explore-to-plan", decision: "ALLOWED" },
  ]);
  // Plan C: execute-to-reflect stayed blocked for hours, then retried quickly.
  // The final 18s gap is quick, but the unresolved streak started at 10:00, so
  // this is real stuck time, not a self-clearing gate.
  writePlan(plansDir, "plan_2026-06-08_cccc", [
    { at: "2026-06-08T10:00:00.000Z", gate: "execute-to-reflect", decision: "BLOCKED", codes: ["GATE-LONG-STUCK"] },
    { at: "2026-06-08T11:00:00.000Z", gate: "execute-to-reflect", decision: "BLOCKED", codes: ["GATE-LONG-STUCK"] },
    { at: "2026-06-08T12:00:00.000Z", gate: "execute-to-reflect", decision: "BLOCKED", codes: ["GATE-LONG-STUCK"] },
    { at: "2026-06-08T12:00:00.000Z", gate: "execute-to-reflect", decision: "BLOCKED", codes: ["GATE-LONG-STUCK"] },
    { at: "2026-06-08T12:00:18.000Z", gate: "execute-to-reflect", decision: "ALLOWED" },
  ]);
  // Plan D: hand-written/corrupt logs without a decision must not invent an
  // ALLOWED transition just because the checks are WARN-only.
  writePlan(plansDir, "plan_2026-06-08_dddd", [
    { at: "2026-06-08T13:00:00.000Z", gate: "plan-to-execute", decision: "BLOCKED", codes: ["GATE-WARN-SPOOF"] },
    { at: "2026-06-08T13:00:20.000Z", gate: "plan-to-execute", checks: [{ status: "WARN" }] },
  ]);

  const out = JSON.parse(execFileSync(NODE, [ledger, "--cwd", tmp, "--json"], { encoding: "utf-8" }));

  assert(out.plan_count === 4, "counts all plans");

  const etr = out.gates["execute-to-reflect"];
  assert(etr && etr.blocked === 7 && etr.allowed === 2, "execute-to-reflect: includes short and long blocked streaks");
  assert(etr && etr.self_clearing_unblocks === 1, "execute-to-reflect: only the short 18s streak counts as self-clearing");
  const longStuckCode = etr?.top_failure_codes?.find((c) => c.code === "GATE-LONG-STUCK");
  assert(longStuckCode && longStuckCode.self_cleared === 0, "multi-hour stuck streak is not credited as self-clearing on a quick final retry");

  const exp = out.gates["explore-to-plan"];
  assert(exp && exp.blocked === 1 && exp.self_clearing_unblocks === 0, "explore-to-plan 40min unblock is NOT self-clearing (real fix)");

  const tmp002 = out.failure_codes.find((c) => c.code === "GATE-TMP-002");
  assert(tmp002 && tmp002.gates.length === 3, "GATE-TMP-002 rolled up across 3 gates");
  assert(tmp002 && tmp002.self_cleared >= 3, "GATE-TMP-002 self-cleared in each gate");
  assert(out.suspect_codes.includes("GATE-TMP-002"), "GATE-TMP-002 flagged as cross-cutting systemic suspect");
  assert(!out.suspect_codes.includes("GATE-EXP-001"), "a single real-fix block is NOT flagged systemic");

  const pte = out.gates["plan-to-execute"];
  const warnSpoof = pte?.top_failure_codes?.find((c) => c.code === "GATE-WARN-SPOOF");
  assert(pte && pte.blocked === 2 && pte.allowed === 1, "WARN-only missing-decision entry does not add a fabricated ALLOWED count");
  assert(warnSpoof && warnSpoof.self_cleared === 0, "WARN-only missing-decision entry does not fabricate a self-clear");

  // Window tightening: with a 10s window the 18s execute-to-reflect unblock no
  // longer counts as self-clearing.
  const tight = JSON.parse(execFileSync(NODE, [ledger, "--cwd", tmp, "--window-sec", "10", "--json"], { encoding: "utf-8" }));
  assert(tight.gates["execute-to-reflect"].self_clearing_unblocks === 0, "tighter window excludes the 18s unblock");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
