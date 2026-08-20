#!/usr/bin/env node
// replay_telemetry.mjs — Epic B foundational ticket: replay REAL decision-log telemetry
// through the LIVE gate-decision engine and assert it reproduces history.
//
// @planner:module = replay_telemetry
// @planner:capability = real_telemetry_replay_harness
//
// The verification program's north star: ground the planner in REAL telemetry, not
// synthetic fixtures. The existing real_telemetry suite only exercised the POST-HOC
// false-failure ledger; the live gate engine was never replayed against real plans.
// This harness closes that gap at the verdict + integrity layer:
//
//   1. INTEGRITY — validateDecisionLogChain (the live tamper-evidence verifier) confirms
//      the recorded stream's _prev_hash chain is intact, i.e. it is a faithful, untampered
//      real plan log before we trust any replay over it.
//   2. VERDICT REPLAY — for every recorded gate_transition, re-derive BLOCK/ALLOW from its
//      recorded `checks` using deriveGateDecision (the SAME function transition.mjs uses to
//      record a verdict) and assert it matches the recorded `decision`. A mismatch means the
//      live decision rule diverged from what historically produced these real verdicts (a
//      real regression) — or that a decision was not check-derived (reported separately).
//
// SCOPE (honest): this replays the decision-AGGREGATION layer + stream integrity. Replaying
// full check GENERATION needs each plan's complete state (state.json + artifacts), which the
// committed fixtures do not carry; per-project state-replay cases are later Epic B tickets.

import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { join, basename, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { deriveGateDecision, validateDecisionLogChain } from "./lib/determinism.mjs";
import { emitJson } from "./lib/emit_json.mjs";

const __filename = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(__filename));
const DEFAULT_FIXTURES = join(SKILL_DIR, "tests", "fixtures", "real_telemetry");

function parseEntries(text) {
  return text.split("\n").filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// Replay one decision_log file (a real recorded gate-transition stream).
export function replayDecisionLog(logPath) {
  if (!existsSync(logPath)) return { ok: false, reason: "not_found", logPath };
  const entries = parseEntries(readFileSync(logPath, "utf-8"));
  const gts = entries.filter((e) => e?.type === "gate_transition");

  const mismatches = [];
  let matched = 0, notCheckDerived = 0;
  for (let i = 0; i < gts.length; i++) {
    const e = gts[i];
    if (!Array.isArray(e.checks) || e.checks.length === 0) { notCheckDerived++; continue; }
    const replayed = deriveGateDecision(e.checks);
    if (replayed === e.decision) matched++;
    else mismatches.push({ index: i, gate: e.gate, recorded: e.decision, replayed });
  }

  // Integrity: stage the log as a plan dir and run the live chain verifier.
  let chain = { valid: null };
  const tmp = mkdtempSync(join(tmpdir(), "replay-chain-"));
  try {
    const art = join(tmp, "artifacts");
    mkdirSync(art, { recursive: true });
    copyFileSync(logPath, join(art, "decision_log.jsonl"));
    chain = validateDecisionLogChain(tmp);
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }

  return {
    ok: true,
    logPath,
    gate_transitions: gts.length,
    matched,
    mismatched: mismatches.length,
    not_check_derived: notCheckDerived,
    mismatches,
    chain_valid: chain.valid,
    chain_reason: chain.valid === false ? chain.reason : undefined,
  };
}

// Replay every fixture in a directory (default: the real-telemetry fixtures).
export function replayFixtures(dir = DEFAULT_FIXTURES) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()
    .map((f) => ({ fixture: f, ...replayDecisionLog(join(dir, f)) }));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const pathArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const results = pathArg ? [{ fixture: basename(pathArg), ...replayDecisionLog(pathArg) }] : replayFixtures();
  const exitCode = results.some((r) => r.mismatched > 0 || r.chain_valid === false) ? 1 : 0;
  if (json) {
    emitJson({ schema_version: 1, results }, { exitCode });
  } else {
    console.log("Real-telemetry replay (live gate-decision engine)\n");
    let totalGts = 0, totalMatched = 0, totalMismatch = 0, badChains = 0;
    for (const r of results) {
      totalGts += r.gate_transitions || 0; totalMatched += r.matched || 0; totalMismatch += r.mismatched || 0;
      if (r.chain_valid === false) badChains++;
      console.log(`  ${r.fixture}: ${r.matched}/${r.gate_transitions} verdicts reproduced` +
        (r.mismatched ? ` — ${r.mismatched} MISMATCH` : "") +
        (r.not_check_derived ? ` (${r.not_check_derived} non-check-derived)` : "") +
        ` | chain ${r.chain_valid === false ? "BROKEN: " + r.chain_reason : "intact"}`);
    }
    console.log(`\n  TOTAL: ${totalMatched}/${totalGts} real gate verdicts reproduced by the live rule; ${totalMismatch} mismatch; ${badChains} broken chains`);
    process.exitCode = exitCode;
  }
}
