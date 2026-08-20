// quant_persona_gate.mjs - deterministic quant/persona guard for plans and tickets.

export const QUANT_PERSONA_GATE_VERSION = "1.0.0";

const MARKET_TERMS = Object.freeze([
  "polymarket",
  "prediction market",
  "betting",
  "odds",
  "sportsbook",
  "wager",
  "clv",
  "closing line",
  "pnl",
  "roi",
  "market inefficiency",
]);

const METHOD_TERMS = Object.freeze([
  "quant project",
  "quant work",
  "quant ticket",
  "quant model",
  "quant research",
  "backtest",
  "backtesting",
  "out of sample",
  "out-of-sample",
  "walk forward",
  "walk-forward",
  "temporal split",
  "leakage",
  "lookahead",
  "look-ahead",
  "calibration",
  "trueskill",
  "true skill",
  "markov",
  "optimizer",
  "optimization",
  "hyperparameter",
]);

const SUPPORT_TERMS = Object.freeze([
  "quant",
  "model",
  "factor",
  "alpha",
  "ranking",
  "forecast",
  "probability",
  "label",
  "dataset",
]);

const WEAK_SUPPORT_TERMS = new Set(["label"]);

const NON_QUANT_PROJECT_SHAPES = new Set(["planner-core", "docs", "analysis", "chore"]);

// Declared ticket scopes that exempt intake-time keyword detection. A ticket whose
// deliverable is planner/tooling machinery may legitimately mention quant terms
// (it builds or tests the quant gates themselves) without being quant research.
// The declaration is explicit and auditable: it must be persisted on the ticket
// (quant_scope) and is surfaced in the gate reason. Real quant enforcement still
// applies at child-plan/close time where changed files and
// quant_results_validation evidence exist.
const NON_QUANT_TICKET_SCOPES = new Set(["planner_core", "meta", "tooling"]);

function normalizeTicketScope(value) {
  return String(value || "").trim().toLowerCase().replace(/-/g, "_");
}

const GUARD_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "quant_persona",
    title: "Quant persona is explicit",
    evidence_scope: "combined",
    terms: ["quant persona", "quant_target", "quant target", "quant truthfulness", "scientific shape", "scientific planner"],
    required_evidence: ["Name the quant/quant_target persona obligation in the ticket, plan, or acceptance criteria."],
    next_action: "Add an explicit quant/quant_target persona obligation before review.",
  }),
  Object.freeze({
    id: "what_happened_overview",
    title: "What happened overview is present",
    evidence_scope: "source",
    terms: ["what happened", "observed behavior", "observed failure", "actual behavior", "actual outcome", "symptom", "incident overview", "failure overview", "problem overview", "root cause", "reproduction"],
    required_evidence: ["Describe the concrete observed behavior or failure, not just the high-level idea."],
    next_action: "Add a concrete what-happened overview with observed behavior, expected behavior, and impact.",
  }),
  Object.freeze({
    id: "target_outcome",
    title: "Target or outcome is defined",
    evidence_scope: "combined",
    terms: ["target", "outcome", "label", "objective", "metric", "roi", "pnl", "profit", "clv", "brier", "log loss", "accuracy", "edge"],
    required_evidence: ["State the target, label, objective, or metric the quant work is optimizing or evaluating."],
    next_action: "Add the target/outcome definition and how it maps to the claimed result.",
  }),
  Object.freeze({
    id: "data_lineage",
    title: "Data lineage or odds snapshot semantics are defined",
    evidence_scope: "combined",
    terms: ["data source", "source dataset", "data lineage", "odds snapshot", "snapshot", "as-of", "as of", "timestamp", "known at time", "known-at-time", "coverage", "date range"],
    required_evidence: ["Name the data source, odds snapshot semantics, known-at-time boundary, coverage, or date range."],
    next_action: "Add data lineage, odds snapshot/as-of semantics, and coverage boundaries.",
  }),
  Object.freeze({
    id: "temporal_leakage",
    title: "Temporal split and leakage handling are explicit",
    evidence_scope: "combined",
    terms: ["temporal", "leakage", "lookahead", "look-ahead", "walk forward", "walk-forward", "out of sample", "out-of-sample", "oos", "train/test", "time split"],
    required_evidence: ["Explain temporal split, lookahead/leakage prevention, OOS, or walk-forward handling."],
    next_action: "Add temporal split/leakage handling before treating the ticket as review-ready.",
  }),
  Object.freeze({
    id: "controls_baselines",
    title: "Controls or baselines are defined",
    evidence_scope: "combined",
    terms: ["control", "controls", "baseline", "benchmark", "null model", "ablation", "holdout", "strongest counterargument", "calibration"],
    required_evidence: ["Name the baseline, control, benchmark, holdout, ablation, or strongest counterargument."],
    next_action: "Add controls/baselines so the quant claim cannot pass on headline performance alone.",
  }),
  Object.freeze({
    id: "quant_verification",
    title: "Quant verification proof is planned or present",
    evidence_scope: "verification",
    terms: [
      "proof:temporal_split_check",
      "proof:leakage_check",
      "proof:out_of_sample_validation",
      "proof:benchmark_comparison",
      "proof:calibration_check",
      "proof:backtest_run",
      "proof:quant_results_validation",
      "proof:live_parity_check",
      "temporal split check",
      "leakage check",
      "out of sample validation",
      "benchmark comparison",
      "calibration check",
      "backtest run",
      "quant results validation",
      "live parity",
    ],
    required_evidence: ["Link a verification row or proof artifact to quant temporal/leakage/OOS/benchmark/calibration/backtest/live-parity evidence."],
    next_action: "Add a quant verification row or proof artifact before a reviewer can call this ready.",
  }),
  Object.freeze({
    id: "alpha_discovery_loop",
    title: "Alpha discovery loop is explicit",
    evidence_scope: "combined",
    terms: [
      "alpha hypothesis",
      "edge hypothesis",
      "candidate alpha",
      "candidate edge",
      "candidate signal",
      "edge mechanism",
      "signal mechanism",
      "market inefficiency mechanism",
      "expected edge",
      "expected roi",
      "expected clv",
      "expected metric",
      "proof metric",
      "falsification threshold",
      "falsification criteria",
      "kill criterion",
      "next experiment",
      "next alpha hypothesis",
      "follow-up experiment",
      "research queue",
    ],
    required_term_groups: [
      Object.freeze({
        id: "mechanism",
        terms: ["alpha hypothesis", "edge hypothesis", "candidate alpha", "candidate edge", "candidate signal", "edge mechanism", "signal mechanism", "market inefficiency mechanism"],
        required_evidence: "Name the candidate alpha/edge mechanism or signal thesis.",
      }),
      Object.freeze({
        id: "expected_metric",
        terms: ["expected edge", "expected roi", "expected clv", "expected metric", "proof metric", "target metric"],
        required_evidence: "State the expected edge or metric that would make the hypothesis useful.",
      }),
      Object.freeze({
        id: "falsification",
        terms: ["falsification threshold", "falsification criteria", "kill criterion", "fails if", "reject if"],
        required_evidence: "Define the falsification threshold or kill criterion.",
      }),
      Object.freeze({
        id: "next_experiment",
        terms: ["next experiment", "next alpha hypothesis", "follow-up experiment", "research queue", "next test"],
        required_evidence: "Name the next experiment or research-queue step.",
      }),
    ],
    required_evidence: [
      "State the candidate alpha/edge mechanism, expected edge metric, falsification threshold, and next experiment.",
    ],
    next_action: "Add the alpha-discovery loop before a reviewer can call this quant work ready.",
  }),
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function objectText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "");
  }
}

function containsTerm(normalizedText, term) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  if (/^[a-z0-9]+$/.test(normalizedTerm) && normalizedTerm.length <= 4) {
    return new RegExp(`(^|[^a-z0-9_])${normalizedTerm}([^a-z0-9_]|$)`).test(normalizedText);
  }
  return normalizedText.includes(normalizedTerm);
}

function matchedTerms(normalizedText, terms) {
  return terms.filter((term) => containsTerm(normalizedText, term));
}

function evaluateTermGroups(normalizedText, groups) {
  return asArray(groups).map((group) => {
    const evidenceRefs = matchedTerms(normalizedText, asArray(group.terms));
    return {
      id: group.id,
      satisfied: evidenceRefs.length > 0,
      evidence_refs: evidenceRefs,
      required_evidence: group.required_evidence || `Missing ${group.id || "term group"}`,
    };
  });
}

function unique(values) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function normalizeShape(planShape) {
  if (typeof planShape === "string") return planShape.trim().toLowerCase();
  if (planShape && typeof planShape === "object") return String(planShape.primary || planShape.detected_primary || "").trim().toLowerCase();
  return "";
}

function changedFilesLookPlannerCore(changedFiles) {
  const files = asArray(changedFiles).map((file) => String(file || "").replace(/\\/g, "/")).filter(Boolean);
  return files.length > 0 && files.every((file) =>
    file.startsWith(".agent/skills/iterative-planner/") ||
    file.startsWith(".agent/workflows/") ||
    file === "AGENTS.md" ||
    file === "CLAUDE.md" ||
    file === "GEMINI.md"
  );
}

function collectTextBundle({
  sourceText = "",
  planContent = "",
  verificationContent = "",
  ticket = null,
  packet = null,
  acceptanceCriteria = [],
  verificationRows = [],
  reviewArtifacts = [],
} = {}) {
  const source = objectText(sourceText);
  const ticketText = objectText(ticket);
  const packetText = packet
    ? [
        packet.id,
        packet.title,
        packet.goal,
        packet.status,
      ].filter(Boolean).join(" ")
    : "";
  const acceptanceText = asArray(acceptanceCriteria).map(objectText).join(" ");
  const verificationText = [
    objectText(verificationContent),
    ...asArray(verificationRows).map(objectText),
    ...asArray(reviewArtifacts).map(objectText),
  ].join(" ");
  const combined = [
    source,
    planContent,
    verificationText,
    ticketText,
    packetText,
    acceptanceText,
  ].join(" ");
  const sourceBoundary = [
    source,
    ticketText,
    acceptanceText,
  ].filter(Boolean).join(" ");
  return {
    source: normalizeText(sourceBoundary),
    combined: normalizeText(combined),
    verification: normalizeText(verificationText),
  };
}

export function detectQuantPersonaScope(input = {}) {
  const bundle = collectTextBundle(input);
  const shape = normalizeShape(input.planShape);
  const ticketType = String(input.ticket?.ticket_type || input.ticket?.type || "").trim().toLowerCase();
  const programId = String(input.packet?.id || input.packet?.program || "").trim().toLowerCase();

  const market = matchedTerms(bundle.combined, MARKET_TERMS);
  const method = matchedTerms(bundle.combined, METHOD_TERMS);
  const support = matchedTerms(bundle.combined, SUPPORT_TERMS);
  const changedFiles = asArray(input.changedFiles);
  const ticketScope = normalizeTicketScope(input.ticketScope || input.ticket?.quant_scope);

  const matchedSignals = unique([
    ...market.map((term) => `market:${term}`),
    ...method.map((term) => `method:${term}`),
    ...support.map((term) => `support:${term}`),
  ]);

  if (NON_QUANT_TICKET_SCOPES.has(ticketScope)) {
    return {
      required: false,
      reason: "planner_core_ticket_scope",
      declared_scope: ticketScope,
      matched_signals: matchedSignals,
    };
  }

  const isCodeRefactorOrResearch = ticketType === "code_refactor" || ticketType === "refactor" || ticketType === "research";
  const programDomainIsQuant = programId.includes("quant") || programId.includes("betting") || programId.includes("trading");
  const isDeclaredNonQuant = isCodeRefactorOrResearch && !programDomainIsQuant;

  const strongSupport = support.filter((term) => term !== "quant" && !WEAK_SUPPORT_TERMS.has(term));
  const supportQuantPair = support.includes("quant") && strongSupport.length > 0;
  const vocabSuggestsQuant = market.length > 0 || method.length > 0 || supportQuantPair;

  if (isDeclaredNonQuant && vocabSuggestsQuant) {
    return {
      required: false,
      reason: "conflicting_signals_advisory",
      advisory: "--quant-scope to override",
      matched_signals: matchedSignals,
    };
  }

  if (isDeclaredNonQuant) {
    return {
      required: false,
      reason: "declared_signals_non_quant",
      matched_signals: matchedSignals,
    };
  }

  if (NON_QUANT_PROJECT_SHAPES.has(shape) || changedFilesLookPlannerCore(changedFiles)) {
    return {
      required: false,
      reason: "non_quant_project_context",
      matched_signals: matchedSignals,
    };
  }

  const required = vocabSuggestsQuant;
  return {
    required,
    reason: required ? "quant_scope_detected" : "no_quant_scope",
    matched_signals: matchedSignals,
  };
}

function evaluateGuard(definition, bundle) {
  const text = bundle[definition.evidence_scope] || bundle.combined;
  const evidenceRefs = matchedTerms(text, definition.terms);
  const termGroups = evaluateTermGroups(text, definition.required_term_groups);
  const satisfied = termGroups.length > 0
    ? termGroups.every((group) => group.satisfied)
    : evidenceRefs.length > 0;
  const missingProof = satisfied
    ? []
    : termGroups.length > 0
      ? termGroups.filter((group) => !group.satisfied).map((group) => group.required_evidence)
      : definition.required_evidence;
  return {
    id: definition.id,
    title: definition.title,
    status: satisfied ? "pass" : "blocked",
    satisfied,
    evidence_scope: definition.evidence_scope,
    evidence_refs: evidenceRefs,
    term_groups: termGroups,
    required_evidence: definition.required_evidence,
    missing_proof: missingProof,
    next_action: satisfied ? null : definition.next_action,
  };
}

export function evaluateQuantPersonaGate(input = {}) {
  const scope = detectQuantPersonaScope(input);
  if (!scope.required) {
    return {
      version: QUANT_PERSONA_GATE_VERSION,
      required: false,
      status: "not_applicable",
      reason: scope.reason,
      ...(scope.declared_scope ? { declared_scope: scope.declared_scope } : {}),
      matched_signals: scope.matched_signals,
      summary: {
        matched_signal_count: scope.matched_signals.length,
        required_guard_count: 0,
        satisfied_guard_count: 0,
        missing_guard_count: 0,
      },
      required_guards: [],
    };
  }

  const bundle = collectTextBundle(input);
  const requiredGuards = GUARD_DEFINITIONS.map((definition) => evaluateGuard(definition, bundle));
  const missing = requiredGuards.filter((guard) => !guard.satisfied);
  return {
    version: QUANT_PERSONA_GATE_VERSION,
    required: true,
    status: missing.length > 0 ? "blocked" : "pass",
    reason: scope.reason,
    matched_signals: scope.matched_signals,
    summary: {
      matched_signal_count: scope.matched_signals.length,
      required_guard_count: requiredGuards.length,
      satisfied_guard_count: requiredGuards.length - missing.length,
      missing_guard_count: missing.length,
      missing_guard_ids: missing.map((guard) => guard.id),
    },
    required_guards: requiredGuards,
  };
}

export function quantPersonaGateToBlockers(gate) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Domain-persona gate lifecycle is derived from missing scientific guard counts.
  if (!gate?.required || gate.status !== "blocked") return [];
  return asArray(gate.required_guards)
    .filter((guard) => !guard.satisfied)
    .map((guard) => ({
      source: "quant_persona_gate",
      code: `quant_persona_${guard.id}_missing`,
      path: guard.evidence_scope || null,
      message: guard.next_action || `${guard.title} is missing`,
    }));
}

export function summarizeQuantPersonaGate(gate) {
  if (!gate?.required) return "Quant persona gate not applicable";
  const missing = gate.summary?.missing_guard_ids || [];
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Domain-persona gate lifecycle is derived from missing scientific guard counts.
  return gate.status === "pass"
    ? `Quant persona gate passed (${gate.summary?.satisfied_guard_count || 0}/${gate.summary?.required_guard_count || 0} guards satisfied)`
    : `Quant persona gate blocked: missing ${missing.join(", ") || "required quant guard evidence"}`;
}
