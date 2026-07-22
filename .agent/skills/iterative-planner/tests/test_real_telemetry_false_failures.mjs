#!/usr/bin/env node
// test_real_telemetry_false_failures.mjs — grounds the false-failure ledger in
// REAL sibling-project telemetry (north star: tests from real failures, not
// synthetic fixtures). Each fixture under fixtures/real_telemetry/ is the actual
// gate_transition stream from a real stuck/false-green plan, harvested
// 2026-06-08 from crawler-extractor-agent, tesseract-automation-engine (Gemini),
// evolution-trading-scientist, ipbs_datapack_starter, and trueskill-atp-tennis,
// then extended 2026-06-09 with TokenLab (tokenomics), ValueInvestingAI (value
// investing), and a second crawler plan — three projects that live only on this
// machine (not on the Mac mini where the overnight Codex review harvests), adding
// NEW transitions (explore-to-plan, validate-to-close, reflect-to-close-stuck) and
// NEW gates (EXP-001/EXP-009, VAL-015) across two new domains. The crawler
// validate-to-close case also locks the hardened streak-window contract: a
// delayed pass after a multi-minute blocked streak must not be overclaimed as a
// self-clear just because the final retry is close to the unblock.
//
// Provenance + the canonical case (crawler GATE-TMP-002): plan-to-execute BLOCKED
// on a tamper-fingerprint mismatch (no approval nonce), then ALLOWED ~101s later
// because a PLANNER_TAMPER_APPROVAL_NONCE appeared — while the fingerprint stayed
// mismatched (9492… → 3d38…) and no file was repaired. A real permission-masked
// false-green. See memory project_tamper_fingerprint_self_invalidates.

import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const ledger = join(skillDir, "scripts", "gate_false_failure_ledger.mjs");
const fixturesDir = join(testDir, "fixtures", "real_telemetry");
const NODE = process.execPath;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// Run the ledger over a single real fixture by staging it as a one-plan repo.
function ledgerFor(fixtureName) {
  const fixture = join(fixturesDir, `${fixtureName}.jsonl`);
  if (!existsSync(fixture)) return null;
  const tmp = mkdtempSync(join(tmpdir(), `realtel-${fixtureName}-`));
  try {
    const artifacts = join(tmp, "plans", "plan_real", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    copyFileSync(fixture, join(artifacts, "decision_log.jsonl"));
    const out = execFileSync(NODE, [ledger, "--cwd", tmp, "--json"], { encoding: "utf-8" });
    return JSON.parse(out);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function selfClearedCode(d, code) {
  return (d?.failure_codes || []).find((c) => c.code === code && c.self_cleared > 0);
}
function failureCode(d, code) {
  return (d?.failure_codes || []).find((c) => c.code === code);
}
function gate(d, name) {
  return d?.gates?.[name] || null;
}

console.log("\nReal-Telemetry False-Failure Fixtures\n");

// 1. crawler-extractor-agent — GATE-TMP-002 tamper false-green (the canonical case).
{
  const d = ledgerFor("crawler_extractor_GATE-TMP-002");
  assert(!!d, "crawler fixture loads and the ledger runs over real telemetry");
  assert((d?.suspect_codes || []).includes("GATE-TMP-002"), "GATE-TMP-002 flagged as a cross-cutting self-invalidating suspect on real crawler telemetry");
  assert(!!selfClearedCode(d, "GATE-TMP-002"), "GATE-TMP-002 self-cleared (BLOCKED→ALLOWED with no state repair) in the real crawler plan");
}

// 2. evolution-trading-scientist — GATE-ETR-008 self-clear across a block streak
//    whose codes drift to [] before the unblock. This is the regression guard for
//    the streak-union code attribution fix (the last block carried no codes).
{
  const d = ledgerFor("evolution_trading_GATE-ETR-008");
  assert(!!d, "evolution fixture loads");
  assert(gate(d, "execute-to-reflect")?.self_clearing_unblocks >= 1, "execute-to-reflect self-clears at gate level in the real evolution plan");
  assert(!!selfClearedCode(d, "GATE-ETR-008"), "GATE-ETR-008 credited with the self-clear even though the last block before the unblock carried empty failure_codes (streak-union attribution)");
}

// 3. trueskill-atp-tennis — reflect-to-validate self-clears within the window.
{
  const d = ledgerFor("trueskill_tennis_GATE-REF-003");
  assert(!!d, "trueskill fixture loads");
  assert(!!selfClearedCode(d, "GATE-REF-003"), "GATE-REF-003 self-clears (reflect-to-validate BLOCKED→ALLOWED, no human change) in the real trueskill plan");
}

// 4. ipbs_datapack_starter — reflect/quant gates self-clear in the real plan.
{
  const d = ledgerFor("ipbs_GATE-REF-003");
  assert(!!d, "ipbs fixture loads");
  const anySelfClear = (d?.failure_codes || []).some((c) => c.self_cleared > 0);
  assert(anySelfClear, "ipbs real plan exhibits at least one self-clearing gate (block-then-pass-unchanged)");
}

// 5. tesseract-automation-engine (Gemini) — the harvest agent claimed GATE-ETR-008
//    "self-cleared", but the real telemetry shows execute-to-reflect was BLOCKED on
//    every attempt (a stuck/repeated-block, NOT a false-green). This locks the
//    distinction: a gate that never unblocks must NOT be scored as self-clearing.
{
  const d = ledgerFor("tesseract_GATE-ETR-008");
  assert(!!d, "tesseract fixture loads");
  const etr = gate(d, "execute-to-reflect");
  assert(etr && etr.blocked >= 3 && etr.allowed === 0, "tesseract execute-to-reflect is a repeated-block (blocked, never allowed) — a stuck case, not a self-clear");
  assert(etr.self_clearing_unblocks === 0, "a never-unblocked gate is NOT scored as self-clearing (over-claim guard)");
}

// 6. TokenLab (tokenomics, NEW domain) — explore-to-plan self-clears GATE-EXP-001/EXP-009.
//    Adds a NEW transition (explore-to-plan) and NEW gates (EXP-001/EXP-009) plus a new domain;
//    none of the 5 prior fixtures cover these. Harvested 2026-06-09 from real TokenLab telemetry
//    (plan_2026-05-21_a2428903a5b598f8). TokenLab is not on the machine where the overnight Codex
//    review runs, so this fixture is created here.
{
  const d = ledgerFor("tokenlab_GATE-EXP-001");
  assert(!!d, "tokenlab fixture loads");
  assert(gate(d, "explore-to-plan")?.self_clearing_unblocks >= 1, "explore-to-plan self-clears in the real TokenLab tokenomics plan (NEW transition coverage)");
  assert(!!selfClearedCode(d, "GATE-EXP-001"), "GATE-EXP-001 self-cleared (BLOCKED→ALLOWED, no state repair) in the real TokenLab plan (NEW gate coverage)");
  assert(!!selfClearedCode(d, "GATE-EXP-009"), "GATE-EXP-009 self-cleared in the real TokenLab plan");
}

// 7. ValueInvestingAI (value investing, NEW domain) — within ONE real plan, reflect-to-close is
//    genuinely STUCK (blocked, never allowed) while OTHER gates self-clear. Locks that the ledger
//    discriminates a stuck repeated-block from a self-clear INSIDE the same plan (the over-claim
//    guard, in a new domain). Harvested 2026-06-09 (plan_2026-04-06_85c1b6b5b137e745).
{
  const d = ledgerFor("valueinvesting_reflect_to_close_stuck");
  assert(!!d, "valueinvesting fixture loads");
  const rtc = gate(d, "reflect-to-close");
  assert(rtc && rtc.blocked >= 3 && rtc.allowed === 0 && rtc.self_clearing_unblocks === 0, "reflect-to-close is a repeated-block (stuck, never allowed) — NOT scored self-clearing (over-claim guard, new domain)");
  const anySelfClear = Object.values(d?.gates || {}).some((v) => (v.self_clearing_unblocks || 0) >= 1);
  assert(anySelfClear, "the SAME real plan still has a self-clearing gate — ledger separates stuck from self-clear within one plan");
}

// 8. crawler-extractor — validate-to-close blocks on GATE-VAL-015, then passes
//    after a multi-minute blocked streak. This is NEW transition/gate coverage,
//    and under the hardened streak attribution contract it must NOT be counted
//    as a quick self-clear. Harvested 2026-06-09 (plan_2026-04-22_2e7de9553504fbf5).
{
  const d = ledgerFor("crawler_extractor_GATE-VAL-015");
  assert(!!d, "crawler validate-to-close fixture loads");
  const val = gate(d, "validate-to-close");
  assert(val && val.blocked >= 2 && val.allowed >= 1, "validate-to-close has real block-then-pass coverage in the crawler plan");
  assert(val.self_clearing_unblocks === 0, "validate-to-close delayed unblock is NOT scored self-clearing under start-of-streak attribution");
  const val015 = failureCode(d, "GATE-VAL-015");
  assert(val015 && val015.blocked_on >= 1 && val015.self_cleared === 0, "GATE-VAL-015 is observed but not overclaimed as self-clearing after a delayed unblock");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
