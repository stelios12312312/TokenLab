#!/usr/bin/env node
// gate_false_failure_ledger.mjs — Aggregate per-gate false-failure signals from
// the decision log so self-invalidating gates can be found and repaired/removed.
//
// Principle (see feedback_verifier_design_principles): a gate that blocks honest
// work, then passes with no real change, has negative value — it trains the
// operator to route around it. The single most useful number about a gate is its
// "blocked-then-passed-unchanged" rate. The raw data already lives on disk in
// each plan's artifacts/decision_log.jsonl; this script just aggregates it.
//
// We cannot read the operator's mind about whether a fix was "real", so we use a
// defensible heuristic: a BLOCKED transition immediately followed by an ALLOWED
// transition of the SAME gate within a short wall-clock window almost certainly
// means no substantive human work happened between them — the gate self-cleared.
// That is the self-invalidation fingerprint (cf. the execute-to-reflect tamper
// check that flipped FAIL→PASS on retry with no edits).
//
// Usage:
//   node gate_false_failure_ledger.mjs [--plan <plan_dir>] [--cwd <path>]
//                                      [--window-sec N] [--json]
//   --plan        Restrict to one plan dir (default: all plans/plan_*).
//   --cwd         Project root (default: process.cwd()).
//   --window-sec  Max gap (s) for a BLOCKED→ALLOWED pair to count as self-clearing
//                 (default 120). A genuine human fix usually takes longer.
//   --json        Emit machine-readable JSON instead of the human summary.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { normalizeVerificationStatus } from "./lib/verification_status_vocabulary.mjs";

const SELF_CLEAR_WINDOW_SEC_DEFAULT = 120;
// A gate must have blocked at least this many times before we are willing to call
// it a self-invalidation suspect — avoids flagging a single transient failure.
const SUSPECT_MIN_BLOCKS = 3;
const SUSPECT_SELF_CLEAR_RATE = 0.5;

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), plan: null, windowSec: SELF_CLEAR_WINDOW_SEC_DEFAULT, json: false, help: false };
  const args = [...argv];
  while (args.length) {
    const t = args.shift();
    switch (t) {
      case "--plan": opts.plan = args.shift() || null; break;
      case "--cwd": opts.cwd = args.shift() || process.cwd(); break;
      case "--window-sec": opts.windowSec = Number(args.shift()) || SELF_CLEAR_WINDOW_SEC_DEFAULT; break;
      case "--json": opts.json = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: /* ignore unknown tokens to stay forgiving */ break;
    }
  }
  return opts;
}

function listPlanDirs(plansDir) {
  if (!existsSync(plansDir)) return [];
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("plan_"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Read gate_transition entries from one plan's decision_log.jsonl, in file order
// (which is chronological — appendDecisionLog only appends).
function normalizeDecision(entry) {
  if (entry.decision === "BLOCKED" || entry.decision === "ALLOWED") return entry.decision;
  if (Array.isArray(entry.checks) && entry.checks.some((check) => {
    const status = normalizeVerificationStatus(check?.status, "gate");
    return !status.valid || status.kind === "fail";
  })) return "BLOCKED";
  return "UNKNOWN";
}

function readGateTransitions(planDir) {
  const logPath = join(planDir, "artifacts", "decision_log.jsonl");
  if (!existsSync(logPath)) return [];
  const out = [];
  let raw;
  try { raw = readFileSync(logPath, "utf-8"); } catch { return []; }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry?.type !== "gate_transition" || !entry.gate) continue;
    const decision = normalizeDecision(entry);
    out.push({
      gate: entry.gate,
      decision,
      timestamp: entry.timestamp || null,
      ts: entry.timestamp ? Date.parse(entry.timestamp) : NaN,
      failureCodes: Array.isArray(entry.failure_codes) ? entry.failure_codes : [],
      sourceState: entry.inputs?.source_state || null,
    });
  }
  return out;
}

function emptyGateStat() {
  return {
    attempts: 0,
    blocked: 0,
    allowed: 0,
    self_clearing_unblocks: 0, // BLOCKED→ALLOWED (same gate) within window
    failure_code_counts: {},   // code -> times seen on a BLOCKED entry
    self_clearing_codes: {},   // code -> times it appeared then self-cleared
  };
}

function aggregate(transitionsByPlan, windowSec) {
  const windowMs = windowSec * 1000;
  const gates = {};
  const gate = (name) => (gates[name] ||= emptyGateStat());

  for (const transitions of Object.values(transitionsByPlan)) {
    // Per plan, scan in order. For each gate, accumulate the BLOCKED *streak*
    // (every block since the last unblock) so a self-clearing unblock is credited
    // to the UNION of failure codes seen during the streak — not just the last
    // block's codes. Real telemetry (evolution-trading GATE-ETR-008) blocks with
    // ["GATE-ETR-008"], then re-blocks with [] (codes drift between attempts),
    // then ALLOWs unchanged; attributing only the last block's (empty) codes lost
    // the real culprit.
    const blockStreakByGate = {};
    for (const t of transitions) {
      const g = gate(t.gate);
      g.attempts += 1;
      if (t.decision === "BLOCKED") {
        g.blocked += 1;
        for (const code of t.failureCodes) g.failure_code_counts[code] = (g.failure_code_counts[code] || 0) + 1;
        const streak = blockStreakByGate[t.gate] || { codes: new Set(), firstTs: NaN, lastTs: NaN };
        if (Number.isFinite(t.ts) && !Number.isFinite(streak.firstTs)) streak.firstTs = t.ts;
        if (Number.isFinite(t.ts)) streak.lastTs = t.ts;
        for (const code of t.failureCodes) streak.codes.add(code);
        blockStreakByGate[t.gate] = streak;
      } else if (t.decision === "ALLOWED") {
        g.allowed += 1;
        const streak = blockStreakByGate[t.gate];
        if (streak && Number.isFinite(streak.firstTs) && Number.isFinite(t.ts) && t.ts - streak.firstTs <= windowMs) {
          g.self_clearing_unblocks += 1;
          for (const code of streak.codes) g.self_clearing_codes[code] = (g.self_clearing_codes[code] || 0) + 1;
        }
        blockStreakByGate[t.gate] = null; // streak consumed by the unblock
      }
    }
  }

  // Cross-gate failure-code rollup. A single check (identified by failure code)
  // can poison many gates — e.g. a tamper check wired into every transition. The
  // per-gate view dilutes that; this rollup makes the systemic offender obvious.
  const codeRollup = {};
  for (const g of Object.values(gates)) {
    for (const [code, count] of Object.entries(g.failure_code_counts)) {
      const r = (codeRollup[code] ||= { code, blocked_on: 0, self_cleared: 0, gates: new Set() });
      r.blocked_on += count;
    }
    for (const [code, count] of Object.entries(g.self_clearing_codes)) {
      const r = (codeRollup[code] ||= { code, blocked_on: 0, self_cleared: 0, gates: new Set() });
      r.self_cleared += count;
    }
  }
  // Record which gates each code blocked.
  for (const [name, g] of Object.entries(gates)) {
    for (const code of Object.keys(g.failure_code_counts)) codeRollup[code]?.gates.add(name);
  }

  // Derive verdicts.
  for (const [name, g] of Object.entries(gates)) {
    g.self_clear_rate = g.blocked ? Number((g.self_clearing_unblocks / g.blocked).toFixed(3)) : 0;
    if (g.blocked >= SUSPECT_MIN_BLOCKS && g.self_clear_rate >= SUSPECT_SELF_CLEAR_RATE) {
      g.verdict = "SELF_INVALIDATING_SUSPECT";
    } else if (g.self_clearing_unblocks > 0) {
      g.verdict = "some_self_clearing";
    } else if (g.blocked > 0) {
      g.verdict = "blocks_then_real_fix_or_abandon";
    } else {
      g.verdict = "clean";
    }
    g.top_failure_codes = Object.entries(g.failure_code_counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, count]) => ({ code, count, self_cleared: g.self_clearing_codes[code] || 0 }));
  }

  const codes = Object.values(codeRollup)
    .map((r) => ({
      code: r.code,
      blocked_on: r.blocked_on,
      self_cleared: r.self_cleared,
      self_clear_rate: r.blocked_on ? Number((r.self_cleared / r.blocked_on).toFixed(3)) : 0,
      gates: [...r.gates].sort(),
      // A code that self-clears is the signature of a self-invalidating check.
      // Two routes to "systemic": (a) it spans many gates and self-clears more
      // than once — a cross-cutting check wired everywhere (e.g. tamper); or
      // (b) within a single gate it self-clears a majority of the time. Spread
      // matters because abandonment (start a new plan) dilutes the within-gate
      // self-clear rate even when the check is clearly broken.
      systemic_suspect:
        (r.gates.size >= 3 && r.self_cleared >= 2) ||
        (r.blocked_on >= SUSPECT_MIN_BLOCKS && (r.self_cleared / r.blocked_on) >= SUSPECT_SELF_CLEAR_RATE),
    }))
    .sort((a, b) => (b.self_cleared - a.self_cleared) || (b.blocked_on - a.blocked_on));

  return { gates, codes };
}

function humanSummary(gates, codes, opts, planCount) {
  const lines = [];
  lines.push(`Gate false-failure ledger — ${planCount} plan(s), self-clear window ${opts.windowSec}s`);
  lines.push("");
  const ordered = Object.entries(gates).sort((a, b) => (b[1].self_clear_rate - a[1].self_clear_rate) || (b[1].blocked - a[1].blocked));
  if (!ordered.length) {
    lines.push("  No gate transitions recorded.");
    return lines.join("\n");
  }
  const flag = (v) => (v === "SELF_INVALIDATING_SUSPECT" ? "⚠️ " : v === "some_self_clearing" ? "·  " : "   ");
  for (const [name, g] of ordered) {
    lines.push(`${flag(g.verdict)}${name}`);
    lines.push(`     attempts=${g.attempts} blocked=${g.blocked} allowed=${g.allowed} self-cleared=${g.self_clearing_unblocks} (rate ${g.self_clear_rate}) → ${g.verdict}`);
    if (g.top_failure_codes.length) {
      const codes = g.top_failure_codes.map((c) => `${c.code}×${c.count}${c.self_cleared ? ` (self-cleared ${c.self_cleared})` : ""}`).join(", ");
      lines.push(`     codes: ${codes}`);
    }
  }
  const selfClearingCodes = codes.filter((c) => c.self_cleared > 0);
  if (selfClearingCodes.length) {
    lines.push("");
    lines.push("Failure codes by self-clearing (cross-gate):");
    for (const c of selfClearingCodes.slice(0, 8)) {
      const tag = c.systemic_suspect ? "⚠️ " : "   ";
      lines.push(`${tag}${c.code}  blocked-on=${c.blocked_on} self-cleared=${c.self_cleared} (rate ${c.self_clear_rate}) across ${c.gates.length} gate(s): ${c.gates.join(", ")}`);
    }
  }
  const suspectGates = ordered.filter(([, g]) => g.verdict === "SELF_INVALIDATING_SUSPECT");
  const suspectCodes = codes.filter((c) => c.systemic_suspect);
  if (suspectGates.length || suspectCodes.length) {
    lines.push("");
    if (suspectCodes.length) {
      lines.push(`⚠️  ${suspectCodes.length} failure code(s) look cross-cutting self-invalidating: ${suspectCodes.map((c) => c.code).join(", ")}. One check is poisoning multiple gates — fix it at the source.`);
    }
    if (suspectGates.length) {
      lines.push(`⚠️  ${suspectGates.length} gate(s) block then pass unchanged. Repair the check or remove it — do not demote to advisory.`);
    }
  }
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node gate_false_failure_ledger.mjs [--plan <plan_dir>] [--cwd <path>] [--window-sec N] [--json]");
    return 0;
  }
  const plansDir = join(opts.cwd, "plans");
  const planNames = opts.plan ? [opts.plan] : listPlanDirs(plansDir);
  const transitionsByPlan = {};
  for (const name of planNames) {
    const planDir = join(plansDir, name);
    if (!existsSync(planDir)) continue;
    transitionsByPlan[name] = readGateTransitions(planDir);
  }
  const { gates, codes } = aggregate(transitionsByPlan, opts.windowSec);
  const result = {
    project_root: opts.cwd,
    plan_count: Object.keys(transitionsByPlan).length,
    self_clear_window_sec: opts.windowSec,
    gates,
    failure_codes: codes,
    suspect_gates: Object.entries(gates).filter(([, g]) => g.verdict === "SELF_INVALIDATING_SUSPECT").map(([name]) => name),
    suspect_codes: codes.filter((c) => c.systemic_suspect).map((c) => c.code),
  };
  if (opts.json) {
    emitJson(result, { exitCode: 0 });
  } else {
    console.log(humanSummary(gates, codes, opts, result.plan_count));
  }
  return 0;
}

process.exitCode = main();
