#!/usr/bin/env node
// rule_engine.mjs — Prolog-powered semantic verification for the iterative planner.
//
// This file is the thin orchestrator. Heavy logic is in:
//   lib/fact_loader.mjs   — Prolog fact extraction from project state
//   lib/rule_commands.mjs  — CLI command implementations
//   lib/sanitize.mjs       — Prolog atom sanitization + formatting
//
// Usage:
//   node rule_engine.mjs check-transition <gate>   Diagnostic semantic check (not a transition predictor)
//   node rule_engine.mjs verify-stories            Full story coverage + gap analysis
//   node rule_engine.mjs story-deps <story-id>     Show dependency chain for a story
//   node rule_engine.mjs impact-from-file <path>   Show story/criterion/goal impact for a file
//   node rule_engine.mjs prove-criterion <id>      Show traceability proof for one criterion
//   node rule_engine.mjs story-proof <story-id>    Show traceability proof for one story
//   node rule_engine.mjs annotation-mismatches     Compare annotations against registry + criteria
//   node rule_engine.mjs find-conflicts            Detect contradictions between stories
//   node rule_engine.mjs check-invariants          Run all invariant rules and persist governed proof
//   node rule_engine.mjs check-invariants --smoke  Run the same rules without writing proof artifacts
//   node rule_engine.mjs blast-radius <story-id>   Which stories break if this one breaks
//   node rule_engine.mjs suggest-next              Deterministic skill recommendations
//   node rule_engine.mjs completeness-score        Completeness scoring
//   node rule_engine.mjs auto-approve-check        Autoplan approval gate
//   node rule_engine.mjs reachability-audit        State-space reachability analysis
//   node rule_engine.mjs --self-test               Run built-in smoke tests
//   node rule_engine.mjs --json                    Machine-readable output
//
// Exit codes: 0 = OK, 1 = violations found, 2 = error

import { join, dirname, basename } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createSession } from "./lib/prolog.mjs";
import { writeProofTrace, getRuleBundleVersion, hashRuleFiles, isFeatureEnabled, nowISO, withFailureCode, readStateJson } from "./lib/determinism.mjs";
import { formatReason, deduplicateViolations, sanitizeEnumAtom } from "./lib/sanitize.mjs";
import { loadStoryFacts, loadStateFacts, loadCapabilityFacts, loadGateRippleFacts, loadGateHistoryFacts, loadProjectMetaFacts, loadRemediationFacts, loadRules } from "./lib/fact_loader.mjs";
import { refreshPlanArtifacts } from "./lib/plan_refresh.mjs";
import { createSemanticEngine } from "./lib/semantic_engine.mjs";
import { degradedCoverageGateResult } from "./lib/degraded_coverage.mjs";
import {
  cmdCheckTransition, cmdVerifyStories, cmdStoryDeps, cmdFindConflicts,
  cmdCheckInvariants, cmdBlastRadius, cmdSuggestNext, cmdCompletenessScore,
  cmdAutoApproveCheck, cmdDumpFixtures, cmdReachabilityAudit, selfTest, formatInvariantDiagnostic,
  cmdImpactFromFile, cmdProveCriterion, cmdStoryProof, cmdAnnotationMismatches,
} from "./lib/rule_commands.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillPath = join(__dirname, "..");
const cwd = process.cwd();
const gatesJsonPath = join(skillPath, "config", "gates.json");
const GATE_REGISTRY = (() => {
  try {
    return JSON.parse(readFileSync(gatesJsonPath, "utf-8")).gates || {};
  } catch {
    return {};
  }
})();

// ═══════════════════════════════════════════════════════════
// Engine factory — creates a Prolog session with all facts loaded
// ═══════════════════════════════════════════════════════════

function createEngine(options = {}) {
  const refreshSnapshot = options?.refreshSnapshot && typeof options.refreshSnapshot === "object"
    ? options.refreshSnapshot
    : null;
  return createSemanticEngine({
    cwd,
    skillPath,
    refreshOntology: refreshSnapshot ? false : (options?.refreshOntology ?? true),
    transientCloseSignals: refreshSnapshot?.closeSignals || options?.transientCloseSignals || null,
    transientOntologyFacts:
      (typeof refreshSnapshot?.ontology?.facts === "string" ? refreshSnapshot.ontology.facts : "") ||
      options?.transientOntologyFacts ||
      "",
    transientRegistryRefresh: options?.transientRegistryRefresh === true,
  });
}

// Command context passed to all command functions
const cmdCtx = {
  createEngine,
  createSession,
  loadRules: (session) => loadRules(session, { cwd, skillPath }),
  cwd,
  skillPath,
};

// ═══════════════════════════════════════════════════════════
// Exported for integration with transition.mjs
// ═══════════════════════════════════════════════════════════

export function runSemanticChecks(gate, planDir, engineOptions = {}) {
  const results = [];
  try {
    const { session, degradedCoverage } = createEngine(engineOptions);
    const coverageResult = degradedCoverageGateResult(degradedCoverage);
    if (coverageResult) results.push(coverageResult);
    const gateDef = GATE_REGISTRY[gate];

    // F-006 FIX: Read from/to from gates.json for gates that don't follow the X-to-Y naming pattern.
    // Falls back to name parsing for backwards compat.
    let rawFrom, rawTo;
    if (gateDef) {
      rawFrom = Array.isArray(gateDef.from) ? gateDef.from[0] : gateDef.from;
      rawTo = gateDef.to || "none";
    }
    if (!rawFrom) {
      [rawFrom, rawTo] = gate.replace(/-to-|_to_/, " ").split(" ").map(s => s.replace(/[-_]/g, "_"));
    }
    // F-003 FIX: Sanitize gate name parts before Prolog interpolation to prevent injection
    const from = sanitizeEnumAtom(rawFrom);
    const to = sanitizeEnumAtom(rawTo || "none");

    if (gateDef?.audit_only) {
      const expectedSources = (Array.isArray(gateDef.from) ? gateDef.from : [gateDef.from])
        .filter(Boolean)
        .map(state => sanitizeEnumAtom(state));
      const currentStateRaw = readStateJson(planDir)?.state;
      const currentState = currentStateRaw ? sanitizeEnumAtom(currentStateRaw) : "unknown";
      const allowed = currentStateRaw ? expectedSources.includes(currentState) : false;

      results.push(withFailureCode({
        name: `Semantic: audit-only ${gate}`,
        status: allowed ? "PASS" : "FAIL",
        detail: allowed
          ? `Audit-only gate allowed from ${currentState}`
          : `Blocked: expected [${expectedSources.join("|")}], found ${currentState}`,
      }, "GATE-SEM-001"));
    } else {
      const canTransition = session.check(`can_transition(${from}, ${to})`);
      const blockers = session.queryAll(`missing_guard(${from}, ${to}, Reason)`);

      results.push(withFailureCode({
        name: `Semantic: ${from} → ${to}`,
        status: canTransition ? "PASS" : "FAIL",
        detail: canTransition ? "All semantic guards satisfied" : `Blocked: ${blockers.map(b => formatReason(b.Reason)).join(", ")}`,
      }, "GATE-SEM-001"));
    }

    // Assert the gate's target state so transition-scoped invariants (I-052
    // close-blockers, I-053 validate-blockers) can fire at the real gate, not
    // only when a test injects semantic_transition_target.
    session.consult(`semantic_transition_target(${to}).`);

    const violations = session.queryAll("invariant_violated(Name, Detail)");
    if (violations.length > 0) {
      // FAST_TRACK mode: downgrade story invariant violations from FAIL to WARN.
      // Story invariants fire for high-priority untested/unimplemented stories — expected
      // during EXPLORE→PLAN when the bootstrap plan hasn't run yet. This mirrors the
      // FAST_TRACK relaxation in verify_gate.mjs (GATE-EXP-009/010).
      const auditOnly = gateDef?.audit_only === true;
      const fastTrack = process.env._PLANNER_FAST_TRACK === "1" || auditOnly;
      // Phase B: attach structured violation list so transition.mjs can request
      // supervisor-generated fix commands per violation. Additive — existing
      // consumers reading only {name, status, detail} are unaffected.
      const structuredViolations = violations.map((v) => ({
        name: typeof v.Name === "string" ? v.Name : String(v.Name || "unknown"),
        detail: typeof v.Detail === "string" ? v.Detail : String(v.Detail || ""),
        // Heuristic phase-guard hint: known phase-premature invariant names. The
        // supervisor itself also enforces this via violation.phase_guard_required.
        phase_guard_required: /phase_reached|phase_premature|temporal/i.test(String(v.Name || "")),
        suggested_fix_command: null,
        auto_repair_safe: false,
      }));
      results.push(withFailureCode({
        name: "Story invariants",
        status: fastTrack ? "WARN" : "FAIL",
        detail: `${violations.length} violation(s): ${violations.slice(0, 3).map(v => formatInvariantDiagnostic(session, v)).join("; ")}${violations.length > 3 ? " ..." : ""}${fastTrack ? ` [${auditOnly ? "AUDIT_ONLY" : "FAST_TRACK"} — downgraded to WARN]` : ""}`,
        violations: structuredViolations,
      }, "GATE-SEM-002"));
    }

    const warnings = session.queryAll("invariant_warning(Name, Detail)");
    if (warnings.length > 0) {
      results.push({
        name: "Invariant advisories",
        status: "WARN",
        detail: `${warnings.length} advisory(s) [ADVISORY ONLY — DOES NOT BLOCK TRANSITION]: ${warnings.map(w => formatInvariantDiagnostic(session, w)).join("; ")}`,
      });
    }
  } catch (e) {
    results.push(withFailureCode({
      name: "Semantic checks",
      status: "FAIL",
      detail: `Engine error: ${e.message}`,
    }, "GATE-SEM-ERR"));
  }
  return results;
}

// Phase B: enrich semantic check results with supervisor-generated fix commands.
// Iterates over each FAIL result that carries a `violations` array (currently
// only "Story invariants") and, for each violation, calls runOntologyFixSupervisor
// to populate `suggested_fix_command` and `auto_repair_safe`. Returns a new array
// of results with mutated violations; the original results are not modified.
// Idempotent: violations that already have non-null suggested_fix_command are skipped.
// Graceful: import or supervisor failure leaves violations un-enriched but does
// NOT throw — caller can render whatever fix commands are present.
export async function enrichViolationsWithFixes(results, options = {}) {
  if (!Array.isArray(results) || results.length === 0) return results;
  const enriched = results.map((r) => {
    if (!r || !Array.isArray(r.violations)) return r;
    return { ...r, violations: r.violations.map((v) => ({ ...v })) };
  });
  const hasAnyViolation = enriched.some((r) => Array.isArray(r?.violations) && r.violations.length > 0);
  if (!hasAnyViolation) return enriched;
  let supervisorMod;
  try {
    supervisorMod = await import("./lib/supervisor_runner.mjs");
  } catch {
    return enriched; // supervisor unavailable; leave violations as-is
  }
  const { runOntologyFixSupervisor } = supervisorMod;
  if (typeof runOntologyFixSupervisor !== "function") return enriched;
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  for (const r of enriched) {
    if (!Array.isArray(r?.violations)) continue;
    for (const v of r.violations) {
      if (v.suggested_fix_command !== null && v.suggested_fix_command !== undefined) continue;
      try {
        const verdict = await runOntologyFixSupervisor({ violation: v, env, fetchImpl });
        v.suggested_fix_command = verdict?.suggested_fix_command ?? null;
        v.auto_repair_safe = verdict?.auto_repair_safe === true;
        v.explanation = typeof verdict?.explanation === "string" ? verdict.explanation : "";
        v.supervisor_status = verdict?.supervisor_status || "unknown";
        v.supervisor_source = verdict?.source || "unknown";
      } catch {
        // Defensive: never propagate supervisor errors out of enrichment.
        v.supervisor_status = "unavailable";
      }
    }
  }
  return enriched;
}

export function runReachabilityAudit(engineOptions = {}) {
  const results = [];
  try {
    const { session } = createEngine(engineOptions);

    // 1. Hard deadlocks
    const deadlocks = session.queryAll("deadlock(S)");
    const uniqueDeadlocks = [...new Set(deadlocks.map(d => d.S))];
    results.push(withFailureCode({
      name: "Reachability: deadlocks",
      status: uniqueDeadlocks.length > 0 ? "FAIL" : "PASS",
      detail: uniqueDeadlocks.length > 0 ? `Hard deadlock(s): ${uniqueDeadlocks.join(", ")}` : "No hard deadlocks",
    }, "GATE-RCH-001"));

    // 2. Forbidden path violations
    const forbidden = session.queryAll("forbidden_reachable(From, To, Path)");
    const forbiddenSeen = new Set();
    const uniqueForbidden = forbidden.filter(f => {
      const key = `${f.From}→${f.To}`;
      if (forbiddenSeen.has(key)) return false;
      forbiddenSeen.add(key);
      return true;
    });
    results.push(withFailureCode({
      name: "Reachability: forbidden paths",
      status: uniqueForbidden.length > 0 ? "FAIL" : "PASS",
      detail: uniqueForbidden.length > 0
        ? `${uniqueForbidden.length} forbidden path(s) reachable: ${uniqueForbidden.map(f => `${f.From}→${f.To}`).join(", ")}`
        : "No forbidden paths reachable",
    }, "GATE-RCH-002"));

    // 3. Gate bypass routes
    const bypasses = session.queryAll("gate_bypass(Gate, Path)");
    const bypassSeen = new Set();
    const uniqueBypasses = bypasses.filter(b => {
      if (bypassSeen.has(b.Gate)) return false;
      bypassSeen.add(b.Gate);
      return true;
    });
    results.push(withFailureCode({
      name: "Reachability: gate bypasses",
      status: uniqueBypasses.length > 0 ? "FAIL" : "PASS",
      detail: uniqueBypasses.length > 0
        ? `${uniqueBypasses.length} gate bypass(es): ${uniqueBypasses.map(b => b.Gate).join(", ")}`
        : "No gate bypass routes",
    }, "GATE-RCH-003"));

    // 4. Privilege escalation paths
    if (session.check("privileged_state(_)")) {
      const escalations = session.queryAll("escalation_path(From, To, Path)");
      results.push(withFailureCode({
        name: "Reachability: privilege escalation",
        status: escalations.length > 0 ? "FAIL" : "PASS",
        detail: escalations.length > 0 ? `${escalations.length} escalation path(s) found` : "No privilege escalation paths",
      }, "GATE-RCH-004"));
    }

    // 5. Soft deadlocks (informational)
    const softDeadlocks = session.queryAll("soft_deadlock(S)");
    const uniqueSoft = [...new Set(softDeadlocks.map(d => d.S))];
    if (uniqueSoft.length > 0) {
      results.push({
        name: "Reachability: soft deadlocks",
        status: "WARN",
        detail: `States with all guards blocked: ${uniqueSoft.join(", ")}`,
      });
    }

  } catch (e) {
    results.push(withFailureCode({
      name: "Reachability audit",
      status: "FAIL",
      detail: `Engine error: ${e.message}`,
    }, "GATE-RCH-ERR"));
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
// CLI (only when invoked directly, not when imported as a module)
// ═══════════════════════════════════════════════════════════

// L1-FIX: Use basename check to avoid matching files like "my_rule_engine.mjs".
const _isMain = process.argv[1] && (
  basename(process.argv[1]) === "rule_engine.mjs" ||
  basename(process.argv[1].replace(/\/$/, "")) === "rule_engine.mjs"
);

if (!_isMain) {
  // Module import path — skip CLI dispatch
} else {

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const smokeMode = args.includes("--smoke");
if (args.includes("--strict")) process.env.RULE_ENGINE_STRICT = "1";
const filtered = args.filter(a => a !== "--json" && a !== "--strict" && a !== "--smoke");
const command = filtered[0];

if (smokeMode && command !== "check-invariants") {
  console.error("--smoke is supported only by the check-invariants command.");
  process.exitCode = 2;
} else if (!command || command === "--help" || command === "help") {
  console.log(`rule_engine.mjs — Prolog-powered semantic verification

Usage:
  node rule_engine.mjs check-transition <gate>   Diagnostic semantic check (not a transition predictor)
  node rule_engine.mjs verify-stories            Story coverage + gap analysis
  node rule_engine.mjs story-deps <story-id>     Dependency chain
  node rule_engine.mjs impact-from-file <path>   File impact across traceability surfaces
  node rule_engine.mjs prove-criterion <id>      Criterion proof chain
  node rule_engine.mjs story-proof <story-id>    Story proof chain
  node rule_engine.mjs annotation-mismatches     Annotation / registry drift report
  node rule_engine.mjs find-conflicts            Story contradiction detection
  node rule_engine.mjs check-invariants          Run all invariant rules and persist governed proof
  node rule_engine.mjs check-invariants --smoke  Run the same rules without writing plan/report artifacts
  node rule_engine.mjs blast-radius <story-id>   Semantic blast radius
  node rule_engine.mjs suggest-next              Deterministic skill recommendations
  node rule_engine.mjs completeness-score        Completeness scoring (Boil the Lake)
  node rule_engine.mjs auto-approve-check        Autoplan approval gate
  node rule_engine.mjs reachability-audit        State-space reachability analysis
  node rule_engine.mjs --self-test               Smoke tests
  node rule_engine.mjs --json                    Machine-readable output
  node rule_engine.mjs --strict                  Exit 2 on rule-file load errors (also: RULE_ENGINE_STRICT=1)

Gates: explore-to-plan, plan-to-execute, execute-to-reflect, reflect-to-validate, validate-to-close`);
  process.exitCode = 0;
} else {
  let exitCode = 0;
  if (command === "--self-test") { exitCode = selfTest(jsonMode, cmdCtx); }
  else if (command === "check-transition") { exitCode = cmdCheckTransition(filtered[1] || "explore-to-plan", jsonMode, cmdCtx); }
  else if (command === "verify-stories") { exitCode = cmdVerifyStories(jsonMode, cmdCtx); }
  else if (command === "story-deps") { exitCode = cmdStoryDeps(filtered[1] || "", jsonMode, cmdCtx); }
  else if (command === "impact-from-file") { exitCode = cmdImpactFromFile(filtered[1] || "", jsonMode, cmdCtx); }
  else if (command === "prove-criterion") { exitCode = cmdProveCriterion(filtered[1] || "", jsonMode, cmdCtx); }
  else if (command === "story-proof") { exitCode = cmdStoryProof(filtered[1] || "", jsonMode, cmdCtx); }
  else if (command === "annotation-mismatches") { exitCode = cmdAnnotationMismatches(jsonMode, cmdCtx); }
  else if (command === "find-conflicts") { exitCode = cmdFindConflicts(jsonMode, cmdCtx); }
  else if (command === "check-invariants") {
    const transitionSmokeMode = process.env._PLANNER_GATE_TRANSITION === "1";
    exitCode = cmdCheckInvariants(jsonMode, {
      ...cmdCtx,
      persistProof: !smokeMode && !transitionSmokeMode,
      invariantMode: smokeMode || transitionSmokeMode ? "smoke" : "evidence",
    });
  }
  else if (command === "blast-radius") { exitCode = cmdBlastRadius(filtered[1] || "", jsonMode, cmdCtx); }
  else if (command === "dump-fixtures") { exitCode = cmdDumpFixtures(jsonMode, cmdCtx); }
  else if (command === "suggest-next") { exitCode = cmdSuggestNext(jsonMode, cmdCtx); }
  else if (command === "completeness-score") { exitCode = cmdCompletenessScore(jsonMode, cmdCtx); }
  else if (command === "auto-approve-check") { exitCode = cmdAutoApproveCheck(jsonMode, cmdCtx); }
  else if (command === "reachability-audit") { exitCode = cmdReachabilityAudit(jsonMode, cmdCtx); }
  else {
    console.error(`Unknown command: ${command}. Use --help for available commands.`);
    exitCode = 2;
  }
  process.exitCode = exitCode;
}

} // end _isMain guard
