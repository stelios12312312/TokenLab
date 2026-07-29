#!/usr/bin/env node
// gate_compliance.mjs — Gate compliance auditor for the iterative planner.
//
// Reads state.json transitions array and gates.json to determine:
// 1. Which gates have been run (PASS/FAIL) and when
// 2. Which required predecessor gates are missing for the current state
// 3. Overall compliance status
//
// Usage:
//   node gate_compliance.mjs              Report for active plan (exits 1 if non-compliant)
//   node gate_compliance.mjs --json       Machine-readable output
//   node gate_compliance.mjs --lenient    Exit 0 even if non-compliant (advisory mode)
//
// Exit codes: 0 = compliant (or no plan), 1 = non-compliant, 2 = error
// RT-AUDIT-004: Default changed from lenient to strict — documentation promises
// "You cannot skip gates" so the compliance tool must enforce that by default.
//
// Zero dependencies — Node.js 18+.

import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { resolvePlanTarget } from "./lib/plan_utils.mjs";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillDir = resolve(scriptDir, "..");
const cwd = process.cwd();

// ---------------------------------------------------------------------------
// Load gate registry
// ---------------------------------------------------------------------------

const gatesJsonPath = join(skillDir, "config", "gates.json");
let gateRegistry = {};
if (existsSync(gatesJsonPath)) {
  try {
    gateRegistry = JSON.parse(readFileSync(gatesJsonPath, "utf-8")).gates || {};
  } catch { /* empty */ }
}

// Build from/to → gate name lookup
const stateToGate = new Map();
for (const [gateName, def] of Object.entries(gateRegistry)) {
  const sources = Array.isArray(def.from) ? def.from : [def.from];
  for (const src of sources.filter(Boolean)) {
    stateToGate.set(`${src.toLowerCase()}_${(def.to || "").toLowerCase()}`, gateName);
  }
}

// Gate chain: required predecessors in order
const GATE_CHAIN = [
  "explore-to-plan",
  "plan-to-execute",
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
];

// State → required gates to have reached that state
const REQUIRED_GATES_FOR_STATE = {
  explore: [],
  plan: ["explore-to-plan"],
  execute: ["explore-to-plan", "plan-to-execute"],
  reflect: ["explore-to-plan", "plan-to-execute", "execute-to-reflect"],
  validate: ["explore-to-plan", "plan-to-execute", "execute-to-reflect", "reflect-to-validate"],
  close: ["explore-to-plan", "plan-to-execute", "execute-to-reflect", "reflect-to-validate", "validate-to-close"],
  re_plan: ["explore-to-plan"],  // at minimum, explore-to-plan must have passed
};

// ---------------------------------------------------------------------------
// Resolve active plan
// ---------------------------------------------------------------------------

function getActivePlan() {
  // Honor per-agent isolation (explicit > env > thread > pointer) so concurrent
  // agents do not collide on the shared plans/.current_plan pointer.
  const plansDir = join(cwd, "plans");
  const { planDirName, planDir } = resolvePlanTarget(plansDir, { exitOnMissing: false });
  if (!planDirName || !planDir) return null;
  return { name: planDirName, path: planDir };
}

function readStateJson(planDir) {
  const statePath = join(planDir, "state.json");
  try { return JSON.parse(readFileSync(statePath, "utf-8")); } catch { return null; }
}

function readCurrentState(planDir) {
  // RT-REDTEAM-H1: Only trust state.json (canonical source of truth).
  // state.md fallback REMOVED — LLMs can edit state.md to fake current state,
  // bypassing source-state checks and making compliance reports unreliable.
  const stateJson = readStateJson(planDir);
  if (stateJson?.state) return stateJson.state.toLowerCase();
  return "unknown";
}

// ---------------------------------------------------------------------------
// Audit logic
// ---------------------------------------------------------------------------

function auditCompliance(stateJson, currentState) {
  const passedGates = new Map(); // gateName → {timestamp, result}
  const allAttempts = [];

  if (stateJson?.transitions) {
    // RT5-M4: Track re_plan transitions. After a re_plan, gate passes for
    // plan-to-execute and beyond are stale and must be re-earned.
    // We only count gates that occurred after the last re_plan transition.
    const GATES_INVALIDATED_BY_REPLAN = new Set([
      "plan-to-execute", "execute-to-reflect", "reflect-to-validate", "validate-to-close",
    ]);
    let lastReplanIndex = -1;
    for (let i = 0; i < stateJson.transitions.length; i++) {
      const t = stateJson.transitions[i];
      if ((t.to || "").toLowerCase() === "re_plan") lastReplanIndex = i;
    }

    for (let i = 0; i < stateJson.transitions.length; i++) {
      const t = stateJson.transitions[i];
      const from = (t.from || "").toLowerCase();
      const to = (t.to || "").toLowerCase();
      const gateName = stateToGate.get(`${from}_${to}`);
      if (!gateName) continue;

      // RT3-M5-FIX: Coerce gate_result to string before calling toUpperCase().
      const entry = {
        gate: gateName,
        result: String(t.gate_result || "SKIP").toUpperCase(),
        timestamp: t.timestamp || "unknown",
      };
      allAttempts.push(entry);

      if (verificationStatusIsPass(entry.result, "gate")) {
        // RT5-M4: Ignore pre-replan passes for gates that must be re-earned
        if (lastReplanIndex >= 0 && i < lastReplanIndex && GATES_INVALIDATED_BY_REPLAN.has(gateName)) {
          continue; // stale pass from previous cycle
        }
        passedGates.set(gateName, entry);
      }
    }
  }

  const requiredGates = REQUIRED_GATES_FOR_STATE[currentState] || [];
  const results = [];
  let compliant = true;

  for (const gate of GATE_CHAIN) {
    const required = requiredGates.includes(gate);
    const passed = passedGates.has(gate);
    const entry = passedGates.get(gate);

    if (required && !passed) compliant = false;

    results.push({
      gate,
      required,
      passed,
      timestamp: entry?.timestamp || null,
      status: !required ? "not_required" : passed ? "pass" : "missing",
    });
  }

  // F-031 FIX: Convert Map to plain object for JSON serialization
  return { results, compliant, currentState, allAttempts, passedGates: Object.fromEntries(passedGates) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printHuman(plan, audit) {
  console.log(`\n┌──────────────────────────────────────────────────────┐`);
  console.log(`│  GATE COMPLIANCE REPORT                              │`);
  console.log(`│  Plan: ${plan.name.padEnd(30)}  State: ${audit.currentState.toUpperCase().padEnd(8)} │`);
  console.log(`└──────────────────────────────────────────────────────┘\n`);

  if (!audit.allAttempts.length) {
    console.log(`  ⚠️  No state.json transitions found — gate history unavailable.`);
    // RT-AUDIT-008: Do NOT early-return. If state requires gates (e.g. state=execute
    // requires explore-to-plan + plan-to-execute), missing history means non-compliant.
    // Fall through to show the compliance summary so the operator sees the full picture.
    if (audit.compliant) {
      console.log(`  State "${audit.currentState}" requires no gates — compliant.\n`);
      return;
    }
    console.log(`  State "${audit.currentState}" requires gates that have no history — NON-COMPLIANT.\n`);
  }

  console.log(`  Gate Chain Status:`);
  for (const r of audit.results) {
    const icon = r.passed ? "✅" : r.required ? "❌" : "⬜";
    const label = r.required ? (r.passed ? "PASS" : "MISSING") : "n/a";
    const ts = r.timestamp ? `  ${r.timestamp.slice(0, 19)}` : "";
    console.log(`    ${icon}  ${r.gate.padEnd(25)} ${label.padEnd(8)}${ts}`);
  }

  const required = audit.results.filter(r => r.required);
  const passed = required.filter(r => r.passed);
  console.log(`\n  Summary: ${passed.length}/${required.length} required gates passed — ${audit.compliant ? "COMPLIANT ✅" : "NON-COMPLIANT ❌"}`);

  if (!audit.compliant) {
    const missing = required.filter(r => !r.passed);
    console.log(`\n  Missing gates:`);
    for (const r of missing) {
      console.log(`    - ${r.gate} (required for ${audit.currentState.toUpperCase()} state)`);
    }
    console.log(`\n  These gates must be run via: node <skill-path>/scripts/transition.mjs <gate-name>`);
  }

  console.log();
}

function printJson(plan, audit) {
  console.log(JSON.stringify({
    plan: plan.name,
    state: audit.currentState,
    compliant: audit.compliant,
    gates: audit.results,
    total_attempts: audit.allAttempts.length,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
// RT-AUDIT-004: Default to strict enforcement. Use --lenient for advisory-only mode.
const lenient = args.includes("--lenient");
const strict = !lenient;

const plan = getActivePlan();
if (!plan) {
  if (jsonMode) {
    console.log(JSON.stringify({ error: "no_active_plan", compliant: true }));
  } else {
    console.log("\n  No active plan found. Gate compliance check skipped.\n");
  }
  process.exit(0);
}

const stateJson = readStateJson(plan.path);
const currentState = readCurrentState(plan.path);
const audit = auditCompliance(stateJson, currentState);

if (jsonMode) {
  printJson(plan, audit);
} else {
  printHuman(plan, audit);
}

if (strict && !audit.compliant) {
  process.exit(1);
}
