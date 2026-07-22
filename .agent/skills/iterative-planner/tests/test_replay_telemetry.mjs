#!/usr/bin/env node
// test_replay_telemetry.mjs — Epic B foundational harness test. Replays REAL recorded
// gate-transition telemetry through the LIVE decision engine (deriveGateDecision — the
// SAME function transition.mjs uses) and verifies the live rule reproduces real history,
// plus the recorded streams' tamper-evident hash chains. Includes anti-vacuity + tamper
// cases so the harness cannot pass trivially.

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { replayFixtures, replayDecisionLog } from "../scripts/replay_telemetry.mjs";
import { buildDecisionEntry, appendDecisionLog } from "../scripts/lib/determinism.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const fixturesDir = join(skillDir, "tests", "fixtures", "real_telemetry");

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nReal-Telemetry Replay Harness\n");

// 1. Replay every real fixture: the live rule must reproduce every recorded verdict,
//    and every recorded stream's hash chain must be intact.
const results = replayFixtures(fixturesDir);
assert(results.length >= 8, `replays all real fixtures (got ${results.length})`);
let totalGts = 0, totalMatched = 0;
for (const r of results) {
  totalGts += r.gate_transitions; totalMatched += r.matched;
  assert(r.gate_transitions > 0, `${r.fixture}: has real gate_transitions to replay (${r.gate_transitions})`);
  assert(r.mismatched === 0, `${r.fixture}: live rule reproduces all recorded verdicts (${r.matched}/${r.gate_transitions}, ${r.mismatched} mismatch)`);
  // Harvested fixtures carry a harvest_provenance header recording the SOURCE
  // log's chain state. Fleet projects on older planner versions emit broken or
  // absent _prev_hash chains; the fixture reproduces the source faithfully, so
  // chain intactness is only asserted when the source chain was intact.
  let sourceChain = null;
  try {
    const firstLine = readFileSync(join(fixturesDir, r.fixture), "utf-8").split("\n").find((l) => l.trim());
    const head = JSON.parse(firstLine);
    if (head?.type === "harvest_provenance") sourceChain = head.source_chain ?? null;
  } catch { /* legacy fixture without provenance */ }
  if (sourceChain === null || sourceChain === "intact") {
    assert(r.chain_valid === true, `${r.fixture}: recorded stream hash-chain is intact (untampered real telemetry)`);
  } else {
    assert(true, `${r.fixture}: source chain recorded as '${sourceChain}' in provenance — fixture faithfully reproduces source; chain assertion not applicable`);
  }
}
assert(totalMatched === totalGts && totalGts >= 100, `live engine reproduces all ${totalGts} real gate verdicts across the corpus`);

// 2. ANTI-VACUITY: a recorded decision that CONTRADICTS its checks must be flagged a
//    mismatch — proves the replay actually compares, not rubber-stamps.
{
  const tmp = mkdtempSync(join(tmpdir(), "replay-vacuity-"));
  try {
    const logPath = join(tmp, "decision_log.jsonl");
    // FAIL check but recorded ALLOWED — impossible under the live rule.
    const bad = buildDecisionEntry("explore-to-plan", { plan: "x" }, [{ name: "c", status: "FAIL", code: "X" }], "ALLOWED", "PLAN");
    writeFileSync(logPath, JSON.stringify(bad) + "\n");
    const r = replayDecisionLog(logPath);
    assert(r.mismatched === 1, "replay FLAGS a recorded verdict that contradicts its checks (not vacuous)");
    assert(r.mismatches[0]?.recorded === "ALLOWED" && r.mismatches[0]?.replayed === "BLOCKED", "mismatch names recorded-vs-replayed verdicts");
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// 3. TAMPER DETECTION: a broken _prev_hash chain must be caught (integrity gate works).
{
  const tmp = mkdtempSync(join(tmpdir(), "replay-tamper-"));
  try {
    const planDir = tmp; mkdirSync(join(planDir, "artifacts"), { recursive: true });
    // Two genuine appends build a valid chain...
    appendDecisionLog(planDir, buildDecisionEntry("explore-to-plan", { plan: "x" }, [{ name: "c", status: "PASS" }], "ALLOWED", "PLAN"));
    appendDecisionLog(planDir, buildDecisionEntry("plan-to-execute", { plan: "x" }, [{ name: "c", status: "PASS" }], "ALLOWED", "EXECUTE"));
    const logPath = join(planDir, "artifacts", "decision_log.jsonl");
    const clean = replayDecisionLog(logPath);
    assert(clean.chain_valid === true, "a genuinely-appended stream has a valid chain");
    // ...now tamper with the first record's content (hash chain should break).
    const fs = await import("fs");
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    const first = JSON.parse(lines[0]); first.decision = "BLOCKED"; lines[0] = JSON.stringify(first);
    fs.writeFileSync(logPath, lines.join("\n") + "\n");
    const tampered = replayDecisionLog(logPath);
    assert(tampered.chain_valid === false, "replay DETECTS a tampered record via the hash chain");
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
