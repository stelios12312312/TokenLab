#!/usr/bin/env node
// gate_idempotence_check.mjs — Meta-invariant: a gate evaluation run twice on an
// unchanged plan must return the SAME verdict.
//
// Principle (see feedback_verifier_design_principles): a verifier whose verdict
// is not reproducible cannot be trusted — the same inputs must yield the same
// answer. A check that flips between runs (Date.now(), Math.random(), unsorted
// iteration, reading state it just mutated) is disqualified until fixed. This is
// the cheapest, most fundamental property a verifier can have, and the planner
// never asserted it about its own gates.
//
// verify_gate.evaluateGateResults is a READ-ONLY evaluator (it does not mutate
// state.json), so we can call it N times back-to-back with nothing changing in
// between and diff the per-check verdicts. Any gate whose (check name -> status)
// map differs across runs is non-idempotent.
//
// Usage:
//   node gate_idempotence_check.mjs [--plan <plan_dir>] [--cwd <path>]
//                                   [--gate <name>] [--runs N] [--json]
//   Exit 0 = all checked gates idempotent; 1 = at least one flipped.

import { join } from "path";
import { existsSync } from "fs";
import { resolvePlanTarget } from "./lib/plan_utils.mjs";
import { GATES, evaluateGateResults } from "./verify_gate.mjs";

const ALL_GATES = Object.keys(GATES);

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), plan: null, gate: null, runs: 2, json: false, help: false };
  const args = [...argv];
  while (args.length) {
    const t = args.shift();
    switch (t) {
      case "--cwd": opts.cwd = args.shift() || process.cwd(); break;
      case "--plan": opts.plan = args.shift() || null; break;
      case "--gate": opts.gate = args.shift() || null; break;
      case "--runs": opts.runs = Math.max(2, Number(args.shift()) || 2); break;
      case "--json": opts.json = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: break;
    }
  }
  return opts;
}

// Reduce a results array to a stable, comparable verdict: a sorted map of
// check name -> status. Names are assumed unique per gate; if a name repeats we
// keep the worst status so a flip is never masked.
const SEVERITY = { PASS: 0, WARN: 1, FAIL: 2 };
export function verdictOf(results) {
  const map = {};
  for (const r of results || []) {
    const name = r?.name ?? "(unnamed)";
    const status = r?.status ?? "(none)";
    if (!(name in map) || (SEVERITY[status] ?? 0) > (SEVERITY[map[name]] ?? 0)) {
      map[name] = status;
    }
  }
  return map;
}

export function diffVerdicts(a, b) {
  const diffs = [];
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of [...names].sort()) {
    const va = a[name] ?? "(absent)";
    const vb = b[name] ?? "(absent)";
    if (va !== vb) diffs.push({ check: name, run1: va, run2: vb });
  }
  return diffs;
}

// Run one gate `runs` times, comparing every run to the first. Returns the
// idempotence verdict for that gate.
export function checkGateIdempotence(planDir, gateName, runs = 2) {
  let first;
  try {
    first = verdictOf(evaluateGateResults(planDir, gateName).results);
  } catch (e) {
    return { gate: gateName, idempotent: false, error: `run 1 threw: ${e.message}` };
  }
  for (let i = 2; i <= runs; i++) {
    let next;
    try {
      next = verdictOf(evaluateGateResults(planDir, gateName).results);
    } catch (e) {
      return { gate: gateName, idempotent: false, error: `run ${i} threw: ${e.message}`, diffs: [] };
    }
    const diffs = diffVerdicts(first, next);
    if (diffs.length) {
      return { gate: gateName, idempotent: false, run: i, check_count: Object.keys(first).length, diffs };
    }
  }
  return { gate: gateName, idempotent: true, check_count: Object.keys(first).length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node gate_idempotence_check.mjs [--plan <plan_dir>] [--cwd <path>] [--gate <name>] [--runs N] [--json]");
    process.exit(0);
  }
  const plansDir = join(opts.cwd, "plans");
  const target = resolvePlanTarget(plansDir, { plan: opts.plan, exitOnMissing: false });
  if (!target.planDir || !existsSync(target.planDir)) {
    const msg = "No target plan to check (create one with bootstrap.mjs, or pass --plan).";
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(msg);
    process.exit(1);
  }

  const gates = opts.gate ? [opts.gate] : ALL_GATES;
  const results = gates.map((g) => checkGateIdempotence(target.planDir, g, opts.runs));
  const flipped = results.filter((r) => !r.idempotent);
  const out = {
    plan: target.planDirName,
    runs: opts.runs,
    gates_checked: gates.length,
    non_idempotent: flipped.map((r) => r.gate),
    results,
    ok: flipped.length === 0,
  };

  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`Gate idempotence — plan ${out.plan}, ${opts.runs} runs each`);
    for (const r of results) {
      if (r.idempotent) {
        console.log(`  ✓ ${r.gate} (${r.check_count} checks, stable)`);
      } else if (r.error) {
        console.log(`  ✗ ${r.gate} — ${r.error}`);
      } else {
        console.log(`  ✗ ${r.gate} — verdict flipped on run ${r.run}:`);
        for (const d of r.diffs) console.log(`      ${d.check}: run1=${d.run1} run2=${d.run2}`);
      }
    }
    if (flipped.length) {
      console.log("");
      console.log(`⚠️  ${flipped.length} gate(s) are non-idempotent — same inputs, different verdict. A verifier that flips cannot be trusted; fix the check before relying on it.`);
    }
  }
  process.exit(out.ok ? 0 : 1);
}

// Only run the CLI when executed directly (keep import side-effect free).
import { fileURLToPath } from "url";
import { realpathSync } from "fs";
const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
const self = realpathSync(fileURLToPath(import.meta.url));
if (entry === self) main();
