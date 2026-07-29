// behavior_report.mjs — classify planner runs (plans/plan_*/state.json) into a
// behavior taxonomy and measure gate-bounce cost. Pure functions; no I/O.
//
// Taxonomy (per run) — corrected for the SKIP-close finding: a run that reaches
// CLOSE via a SKIP →CLOSE transition short-circuited the gate chain (administrative
// / superseded close) and is NOT a completion, so it is counted as `abandoned`,
// not `false_green`. A `false_green` is the genuinely dangerous case: CLOSE reached
// via a PASS gate while a required close-signal is still unsatisfied.
//
// Gate-failure nature map (ceremony / substantive / hybrid) is a first-draft of the
// ceremony-reduction taxonomy decision rules; it is reviewable and meant to be tuned.

import { repairSurfaceOutputVolumeLines } from "./repair_packet.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

// Disclosed heuristic thresholds for "ritual_stall" (tunable).
export const RITUAL_THRESHOLDS = Object.freeze({
  failGates: 3, // >= this many FAIL gate_results in the run
  circuitBreaker: 2, // >= this many fails on a single circuit-breaker gate
  fixAttempts: 3, // >= this many fix_attempts
});

// First-draft ceremony/substantive/hybrid classification of gate failure codes.
// C = ceremony (marker/proof-of-reading/template-fill/doc hygiene),
// S = substantive (real quality/proof/coverage/integrity),
// H = hybrid (traceability/structured-planning completeness). Unlisted => unknown.
export const GATE_NATURE = Object.freeze({
  "GATE-PLN-017": "H", "GATE-REF-004": "C", "GATE-REF-003": "C", "GATE-ETR-008": "S",
  "GATE-VAL-010": "S", "GATE-REF-002": "H", "GATE-PLN-016": "H", "GATE-EXP-009": "S",
  "GATE-EXP-004": "C", "GATE-EXP-002": "H", "GATE-VAL-013": "S", "GATE-ETR-004": "S",
  "GATE-REF-017": "S", "GATE-TRC-006": "C", "GATE-VAL-011": "S", "GATE-TRC-002": "C",
  "GATE-PLN-014": "H", "GATE-PLN-008": "C", "GATE-VAL-012": "S", "GATE-TRC-007": "C",
  "GATE-ETR-011": "S", "GATE-TMP-002": "S", "GATE-EXP-010": "C", "GATE-EXP-001": "H",
  "GATE-REF-016": "H", "GATE-PLN-018": "H", "GATE-PLN-004": "H", "GATE-TRC-004": "C",
  "GATE-EXP-014": "H", "GATE-ETR-003": "H", "GATE-PLN-032": "S", "GATE-VAL-002": "S",
  "GATE-PLN-002": "C", "GATE-VAL-015": "S", "GATE-TRC-009": "C", "GATE-PLN-020": "H", "GATE-REF-021": "S",
  "GATE-PLN-001": "C", "GATE-REF-001": "C", "GATE-PLN-003": "C", "GATE-PLN-019": "H",
  "GATE-VAL-016": "S", "GATE-VAL-018": "S", "GATE-VAL-022": "S", "GATE-VAL-001": "S",
  "GATE-PLN-005": "C", "GATE-PLN-010": "S", "GATE-PLN-013": "H",
  "GATE-ETR-002": "S", "GATE-REF-011": "S", "GATE-HLT-002": "S",
  "GATE-SEM-001": "S", "GATE-SEM-002": "S", "GATE-SEM-003": "S", "GATE-SEM-004": "S",
  "GATE-PRS-001": "H", "GATE-PRS-TRACE": "H", "GATE-PRS-WIR": "S",
  "GATE-PRS-TOK": "S", "GATE-PRS-QT": "S", "GATE-PRS-QRP": "S",
  "GATE-PRS-QUANT": "S", "GATE-PRS-UX": "S",
  "GATE-EXP-015": "H", "GATE-EXP-016": "H", "GATE-PTE-012": "C",
  "GATE-PLN-021": "H", "GATE-CHK-008": "S", "GATE-CHK-009": "S", "GATE-CHK-010": "S",
  "GATE-SRC-001": "S",
});

const NATURE_LABEL = { C: "ceremony", S: "substantive", H: "hybrid", U: "unknown" };
export const TARGET_HOTSPOT_CODES = Object.freeze(["GATE-REF-003", "GATE-PLN-017", "GATE-REF-004", "GATE-PLN-016"]);
const ACTIONABLE_HOTSPOT_CODES = new Set(TARGET_HOTSPOT_CODES);

const TARGET_HOTSPOT_REPAIR_EXECUTION = Object.freeze({
  "GATE-REF-003": Object.freeze({
    status: "repaired_guidance",
    repair_class: "close_signal_progress_guidance",
    strictness: "preserved",
    root_cause: "Progress close signals can stay open after evidence-backed administrative work is done, creating recoverable reflect-to-validate bounces.",
    action: "Repair packet now directs agents to complete or justify progress.md items and inspect generated close signals instead of editing state.json.",
    count_disposition: "current replay count may remain unchanged because historical telemetry is not rewritten and substantive open progress still blocks.",
    false_red_evidence: Object.freeze({ transition_gate: "reflect-to-validate", blocked_on: 9, self_cleared: 2, self_clear_rate: 0.222 }),
    safe_fixture_coverage: Object.freeze([
      "test_reflection_verdict_routing.mjs",
      "real_telemetry/false_red/reflect-to-validate",
    ]),
  }),
  "GATE-PLN-017": Object.freeze({
    status: "strict_guidance_repaired",
    repair_class: "verification_matrix_guidance",
    strictness: "preserved",
    root_cause: "Plans with recipe, orchestration, integration, backend, or migration obligations need context-specific proof rows rather than generic test prose.",
    action: "Repair packet now names recognized proof IDs, required matrix columns, and the verification_matrix lint truth command.",
    count_disposition: "kept strict because current real-telemetry evidence does not support safe softening.",
    false_red_evidence: Object.freeze({ transition_gate: "plan-to-execute", blocked_on: 28, self_cleared: 0, self_clear_rate: 0 }),
    safe_fixture_coverage: Object.freeze([
      "test_repair_packet.mjs",
      "verification_matrix.mjs lint",
    ]),
  }),
  "GATE-REF-004": Object.freeze({
    status: "repaired_guidance",
    repair_class: "close_signal_kb_guidance",
    strictness: "preserved",
    root_cause: "KB upkeep can be complete but unrecorded, causing recoverable reflect-to-validate bounces until reflection or KB artifacts carry a durable sign-off.",
    action: "Repair packet points to reflection.md Knowledge Base Sign-Off or real KB updates and warns not to edit generated close signals.",
    count_disposition: "current replay count may remain unchanged because missing KB evidence should still block.",
    false_red_evidence: Object.freeze({ transition_gate: "reflect-to-validate", blocked_on: 15, self_cleared: 4, self_clear_rate: 0.267 }),
    safe_fixture_coverage: Object.freeze([
      "test_reflection_verdict_routing.mjs",
      "real_telemetry/false_red/reflect-to-validate",
    ]),
  }),
  "GATE-PLN-016": Object.freeze({
    status: "strict_guidance_repaired",
    repair_class: "story_linkage_guidance",
    strictness: "preserved",
    root_cause: "Success criteria can be written without explicit active story-registry linkage, breaking the evidence chain before execution.",
    action: "Repair packet now reinforces stable sc_N criteria, active story IDs, and direct mapping in the Verification Strategy table.",
    count_disposition: "kept strict because current real-telemetry evidence is sparse and story linkage is a real traceability requirement.",
    false_red_evidence: Object.freeze({ transition_gate: "plan-to-execute", blocked_on: 19, self_cleared: 1, self_clear_rate: 0.053 }),
    safe_fixture_coverage: Object.freeze([
      "test_repair_packet.mjs",
      "verification_matrix.mjs lint",
    ]),
  }),
});

export const ADVISORY_SIGNAL_CONSUMERS = Object.freeze([
  {
    id: "gate_fired_audit",
    producers: ["transition.mjs", "escalation_check.mjs"],
    consumers: ["review_intake", "behavior_report.advisory_consumer_audit"],
    surfaced_in: ["transition output", "gate_fired_audits", "behavior_report"],
  },
  {
    id: "persona_audit_warnings",
    producers: ["persona audit packs"],
    consumers: ["persona_constraints.md", "plan verification matrix"],
    surfaced_in: ["transition output", "persona_constraints.md", "persona_findings.json"],
  },
  {
    id: "tool_trace_unavailable",
    producers: ["trace audit"],
    consumers: ["verification.md no-tool-telemetry note", "behavior_report.advisory_consumer_audit"],
    surfaced_in: ["bootstrap status", "transition output"],
  },
  {
    id: "shadow_canary_divergence",
    producers: ["future ceremony-reduction gate tickets"],
    consumers: ["behavior_report.shadow_canary"],
    surfaced_in: ["behavior_report"],
  },
]);

export function gateFailureNature(code) {
  return NATURE_LABEL[GATE_NATURE[code] || "U"];
}

function cloneRepairExecution(row) {
  if (!row) return null;
  return {
    ...row,
    false_red_evidence: row.false_red_evidence ? { ...row.false_red_evidence } : null,
    safe_fixture_coverage: [...(row.safe_fixture_coverage || [])],
  };
}

export function hotspotRepairExecutionForGate(code) {
  return cloneRepairExecution(TARGET_HOTSPOT_REPAIR_EXECUTION[code]);
}

export function targetHotspotRepairRows(activeFailureCounts = {}) {
  return TARGET_HOTSPOT_CODES.map((code) => ({
    code,
    nature: gateFailureNature(code),
    current_active_failure_count: Number(activeFailureCounts?.[code] || 0),
    repair_execution: hotspotRepairExecutionForGate(code),
  }));
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function ratePct(numerator, denominator) {
  return denominator ? Math.round((1000 * numerator) / denominator) / 10 : 0;
}

// Which required close-signal groups are NOT satisfied (a required=true group with
// satisfied=false). Absent `required` defaults to true (treat as required).
export function unsatisfiedRequiredSignals(closeSignals) {
  const bad = [];
  if (!closeSignals || typeof closeSignals !== "object") return bad;
  for (const [key, grp] of Object.entries(closeSignals)) {
    if (grp && typeof grp === "object" && "satisfied" in grp) {
      const required = grp.required === undefined ? true : Boolean(grp.required);
      if (required && grp.satisfied === false) bad.push(key);
    }
  }
  return bad;
}

export function gateFailureCodes(state) {
  const codes = [];
  for (const t of asArray(state?.transitions)) {
    if (normalizeVerificationStatus(t?.gate_result, "gate").kind === "fail") {
      for (const c of asArray(t?.failure_codes)) if (c) codes.push(c);
    }
  }
  return codes;
}

function gateBounceRateRows({ gateBounces, totalRuns, totalBounces }) {
  const rows = {};
  const ceremonyRows = {};
  for (const [code, count] of Object.entries(gateBounces || {}).sort()) {
    const row = {
      count,
      nature: gateFailureNature(code),
      per_run_pct: ratePct(count, totalRuns),
      pct_of_gate_bounces: ratePct(count, totalBounces),
    };
    rows[code] = row;
    if (row.nature === "ceremony") ceremonyRows[code] = row;
  }
  return { rows, ceremonyRows };
}

function repairHintForGate(code, nature) {
  if (code === "GATE-REF-003") return "Tighten structured close-signal completion before validate handoff.";
  if (code === "GATE-PLN-017") return "Map required deliverables into explicit verification rows before execute.";
  if (code === "GATE-REF-004") return "Record semantic/KB upkeep outcome before reflect-to-validate.";
  if (code === "GATE-PLN-016") return "Use stable success-criteria IDs and recognized proof IDs in the verification matrix.";
  if (nature === "ceremony") return "Review whether this ceremony gate can become advisory or derive proof from existing artifacts.";
  if (nature === "hybrid") return "Repair traceability shape so proof obligations are concrete before the gate runs.";
  return "Review gate taxonomy before ranking this as ceremony-reduction work.";
}

function actionableGateHotspots(gateBounceRates) {
  return Object.entries(gateBounceRates || {})
    .filter(([, row]) => row.nature === "ceremony" || row.nature === "hybrid")
    .map(([code, row]) => {
      const repairExecution = hotspotRepairExecutionForGate(code);
      return {
        code,
        count: row.count,
        nature: row.nature,
        per_run_pct: row.per_run_pct,
        pct_of_gate_bounces: row.pct_of_gate_bounces,
        targeted_attack_plan_gate: ACTIONABLE_HOTSPOT_CODES.has(code),
        repair_hint: repairHintForGate(code, row.nature),
        ...(repairExecution ? { repair_execution: repairExecution } : {}),
        priority_score: row.count + (ACTIONABLE_HOTSPOT_CODES.has(code) ? 1000 : 0),
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score || b.count - a.count || a.code.localeCompare(b.code))
    .map((row, index) => {
      const { priority_score: _priorityScore, ...publicRow } = row;
      return { rank: index + 1, ...publicRow };
    });
}

function normalizeShadowCanaryRow(row = {}) {
  const gate = row.gate || row.gate_code || row.code || "unknown_gate";
  const proxy = row.proxy || row.proxy_gate || row.check || row.id || gate;
  const oldStatus = row.old_result || row.legacy_result || row.old_status;
  const newStatus = row.new_result || row.current_result || row.new_status;
  const oldWouldBounce = normalizeVerificationStatus(oldStatus, "execution").kind === "fail";
  const newPassed = normalizeVerificationStatus(newStatus, "execution").kind === "pass";
  return {
    gate: String(gate),
    proxy: String(proxy),
    old_would_bounce: oldWouldBounce,
    new_passed: newPassed,
    diverged: oldWouldBounce && newPassed,
  };
}

function collectShadowCanaryRows(state) {
  const rows = [];
  const stateRows = [
    ...asArray(state?.shadow_canary),
    ...asArray(state?.shadow_canaries),
    ...asArray(state?.shadow_canary_results),
  ];
  for (const row of stateRows) rows.push(normalizeShadowCanaryRow(row));
  for (const transition of asArray(state?.transitions)) {
    const transitionRows = [
      ...asArray(transition?.shadow_canary),
      ...asArray(transition?.shadow_canaries),
      ...asArray(transition?.shadow_canary_results),
    ];
    for (const row of transitionRows) rows.push(normalizeShadowCanaryRow(row));
  }
  return rows;
}

function bumpShadowBucket(bucket, row) {
  bucket.observations += 1;
  if (row.diverged) bucket.divergences += 1;
  bucket.divergence_rate_pct = ratePct(bucket.divergences, bucket.observations);
}

function summarizeShadowCanary(rows) {
  const byGate = {};
  const byProxy = {};
  let divergenceCount = 0;
  for (const row of rows) {
    if (row.diverged) divergenceCount += 1;
    byGate[row.gate] = byGate[row.gate] || { observations: 0, divergences: 0, divergence_rate_pct: 0 };
    byProxy[row.proxy] = byProxy[row.proxy] || { observations: 0, divergences: 0, divergence_rate_pct: 0 };
    bumpShadowBucket(byGate[row.gate], row);
    bumpShadowBucket(byProxy[row.proxy], row);
  }
  return {
    total_observations: rows.length,
    divergence_count: divergenceCount,
    divergence_rate_pct: ratePct(divergenceCount, rows.length),
    by_gate: byGate,
    by_proxy: byProxy,
  };
}

export function advisoryConsumerAudit(registry = ADVISORY_SIGNAL_CONSUMERS) {
  const signals = asArray(registry).map((row) => {
    const consumers = asArray(row?.consumers).filter(Boolean);
    const surfacedIn = asArray(row?.surfaced_in).filter(Boolean);
    return {
      id: String(row?.id || "unknown_advisory"),
      producers: asArray(row?.producers).filter(Boolean),
      consumers,
      surfaced_in: surfacedIn,
      consumed: consumers.length > 0 && surfacedIn.length > 0,
    };
  });
  const unconsumed = signals.filter((row) => !row.consumed);
  return {
    status: unconsumed.length === 0 ? "pass" : "fail",
    total_signals: signals.length,
    consumed_count: signals.length - unconsumed.length,
    unconsumed_count: unconsumed.length,
    unconsumed,
    signals,
  };
}

// The final →CLOSE transition (the one that landed the run in CLOSE), or null.
function closingTransition(state) {
  const toClose = asArray(state?.transitions).filter((t) => t?.to === "CLOSE");
  return toClose.length ? toClose[toClose.length - 1] : null;
}

export function classifyRun(state, thresholds = RITUAL_THRESHOLDS) {
  if (!state || typeof state !== "object") {
    return { category: "other_uncertain", reason: "missing or unparseable state" };
  }
  const transitions = asArray(state.transitions);
  const failCount = transitions.filter((t) => normalizeVerificationStatus(t?.gate_result, "gate").kind === "fail").length;
  const cbMax = Math.max(
    0,
    ...Object.values(state.circuit_breakers || {}).map((v) => Number(v?.total_fails) || 0)
  );
  const fixAttempts = Number(state.fix_attempts) || 0;
  const friction =
    failCount >= thresholds.failGates ||
    cbMax >= thresholds.circuitBreaker ||
    fixAttempts >= thresholds.fixAttempts;
  const signals = { failCount, cbMax, fixAttempts };

  if (state.state !== "CLOSE") {
    return { category: "abandoned", reason: `stopped at ${state.state || "UNKNOWN"}`, signals };
  }
  // Reached CLOSE — but HOW?
  const closing = closingTransition(state);
  if (closing && normalizeVerificationStatus(closing.gate_result, "gate").kind === "pending") {
    // Short-circuit / administrative close: the validate-to-close gate was skipped,
    // not passed. Not a real completion regardless of close-signal state.
    return {
      category: "abandoned",
      reason: `administrative SKIP-close from ${closing.from || "?"}`,
      administrative_skip_close: true,
      signals,
    };
  }
  if (!closing || !verificationStatusIsPass(closing.gate_result, "gate")) {
    return { category: "false_green", reason: "CLOSE without a satisfying gate result", signals };
  }
  const unsatisfied = unsatisfiedRequiredSignals(state.close_signals);
  if (unsatisfied.length) {
    return { category: "false_green", reason: `CLOSE via PASS but unsatisfied: ${unsatisfied.join(", ")}`, signals };
  }
  if (friction) {
    return { category: "ritual_stall", reason: `friction (${failCount} fails)`, signals };
  }
  return { category: "right_action", reason: `clean CLOSE (${failCount} fails)`, signals };
}

export const CATEGORY_ORDER = Object.freeze([
  "right_action", "ritual_stall", "false_green", "abandoned", "other_uncertain",
]);

// Aggregate a list of {name, month, state} run records into the full report.
export function summarize(runs) {
  const byCategory = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0]));
  const byMonth = {};
  const gateBounces = {};
  const natureSplit = { ceremony: 0, substantive: 0, hybrid: 0, unknown: 0 };
  const shadowRows = [];
  let total = 0;

  for (const run of runs) {
    total += 1;
    const { category } = classifyRun(run.state);
    byCategory[category] = (byCategory[category] || 0) + 1;
    const m = run.month || "unknown";
    byMonth[m] = byMonth[m] || Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0]));
    byMonth[m][category] += 1;
    for (const code of gateFailureCodes(run.state)) {
      gateBounces[code] = (gateBounces[code] || 0) + 1;
      natureSplit[gateFailureNature(code)] += 1;
    }
    shadowRows.push(...collectShadowCanaryRows(run.state));
  }

  const totalBounces = Object.values(natureSplit).reduce((a, b) => a + b, 0);
  const known = totalBounces - natureSplit.unknown;
  const { rows: gateBounceRates, ceremonyRows } = gateBounceRateRows({
    gateBounces,
    totalRuns: total,
    totalBounces,
  });
  return {
    total_runs: total,
    by_category: byCategory,
    category_rates: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, ratePct(byCategory[c], total)])),
    by_month: byMonth,
    gate_bounces: gateBounces,
    gate_bounce_rates: gateBounceRates,
    ceremony_gate_bounce_rates: ceremonyRows,
    actionable_gate_hotspots: actionableGateHotspots(gateBounceRates),
    total_gate_bounces: totalBounces,
    nature_split: natureSplit,
    nature_pct_of_classified: known
      ? {
          ceremony: Math.round((100 * natureSplit.ceremony) / known),
          substantive: Math.round((100 * natureSplit.substantive) / known),
          hybrid: Math.round((100 * natureSplit.hybrid) / known),
        }
      : null,
    shadow_canary: summarizeShadowCanary(shadowRows),
    advisory_consumer_audit: advisoryConsumerAudit(),
    output_volume_lines: repairSurfaceOutputVolumeLines(),
    thresholds: RITUAL_THRESHOLDS,
  };
}
