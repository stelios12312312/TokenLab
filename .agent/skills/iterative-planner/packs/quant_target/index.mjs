// packs/quant_target/index.mjs - Quant target and market microstructure auditor.
//
// This pack challenges scientific target semantics before a quant plan treats
// a model name as an established hypothesis. It is intentionally separate from
// the generic quant pack: quant checks backtest/data evidence; quant_target
// checks whether the target, label, prediction horizon, and odds snapshot
// support the claim being made.

import { makeConstraint, SEVERITY } from "../../scripts/lib/audit_types.mjs";
import { formatPhaseGuidance, normalizePackFinding } from "../../scripts/lib/auditor_pack_engine.mjs";

const RULE_DEFS = [
  {
    id: "QT-001",
    name: "Model target contract",
    rationale: "A model claim is not interpretable until the target, label formula, prediction time, available data, forbidden future fields, controls, failure modes, and proof metric are explicit.",
    false_positive: "Exploratory note that is not yet planning or executing a model claim.",
    remediation: "Add a model target contract before interpreting model output or naming the model as evidence for a claim.",
    engine: "js",
  },
  {
    id: "QT-002",
    name: "Target-to-claim justification",
    rationale: "Realized return and positive_return are related to market inefficiency, but they are not the same scientific target.",
    false_positive: "The plan explicitly documents why the chosen target is only a proxy and how it will be tested against CLV/excess-return controls.",
    remediation: "State why the label supports the named claim, and add CLV, excess-return, or closing/reference-price controls when claiming inefficiency.",
    engine: "js",
  },
  {
    id: "QT-003",
    name: "Betting odds snapshot matrix",
    rationale: "Betting targets depend on exactly which entry and reference prices were available at prediction time.",
    false_positive: "The project does not use betting odds, prices, CLV, or market-microstructure language.",
    remediation: "Add an odds snapshot matrix covering entry price, reference price, T-24/T-12/T-6/open/close availability, CLV availability, and label type.",
    engine: "js",
  },
  {
    id: "QT-004",
    name: "CLV provenance repair route",
    rationale: "CLV and closing-line claims are not interpretable unless entry, reference, book/market, and timestamp provenance are linked.",
    false_positive: "CLV appears only as an explicitly rejected or unavailable limitation with no CLV-based claim.",
    remediation: "Route missing CLV provenance to repair, ticket, accepted limitation, or claim block before interpreting CLV or market-microstructure claims.",
    engine: "js",
  },
];

const QUANT_SCOPE_TERMS = [
  "quant", "model", "modeling", "modelling", "factor",
  "alpha", "prediction", "predict", "classifier", "backtest",
  "optimizer", "trueskill", "true skill", "m-model", "market inefficiency model",
];

const HIGH_SIGNAL_TERMS = [
  "market inefficiency", "inefficiency", "market microstructure",
  "market inefficiency model", "mim", "clv", "closing line value",
  "odds snapshot", "positive_return", "realized return", "excess return",
  "entry price", "reference price", "betting odds", "sportsbook",
];

const TARGET_SIGNAL_TERMS = [
  "target", "label formula", "prediction time", "prediction horizon",
  "horizon", "known-at-time", "known at time", "available at that time",
  "forbidden future", "future field", "leakage", "proof metric",
];

const BETTING_SIGNAL_TERMS = [
  "bet", "bets", "betting", "wager", "odds", "price", "prices",
  "sportsbook", "bookmaker", "market", "line movement", "open", "close",
  "closing", "entry price", "reference price", "clv", "closing line value",
];

const INEFFICIENCY_TERMS = [
  "market inefficiency", "inefficiency", "market inefficiency model",
  "mim", "market microstructure",
];

const PROXY_LABEL_TERMS = [
  "positive_return", "positive return", "realized return", "roi", "profit",
  "pnl", "return label", "bet made money",
];

const TARGET_CONTRACT_GROUPS = Object.freeze([
  Object.freeze({
    key: "name",
    terms: ["model name", "model:", "market inefficiency model", "mim", "name"],
  }),
  Object.freeze({
    key: "purpose",
    terms: ["purpose", "use case", "decision", "claim", "hypothesis"],
  }),
  Object.freeze({
    key: "target",
    terms: ["target", "label", "label formula", "positive_return", "realized return", "excess return"],
  }),
  Object.freeze({
    key: "prediction_time",
    terms: ["prediction time", "prediction horizon", "horizon", "as-of", "as of", "t-24", "t-12", "t-6", "pre-event", "before event"],
  }),
  Object.freeze({
    key: "available_data",
    terms: ["data available", "available at that time", "known-at-time", "known at time", "as-of", "feature provenance", "data source", "odds snapshot"],
  }),
  Object.freeze({
    key: "forbidden_future",
    terms: ["forbidden future", "future field", "future fields", "leakage", "lookahead", "look-ahead", "post-event", "close not used"],
  }),
  Object.freeze({
    key: "controls",
    terms: ["control", "controls", "baseline", "ablation", "placebo"],
  }),
  Object.freeze({
    key: "failure_modes",
    terms: ["failure mode", "failure modes", "invalid if", "fails when", "can fail"],
  }),
  Object.freeze({
    key: "proof_metric",
    terms: ["proof metric", "metric", "oos", "out-of-sample", "out of sample", "calibration", "clv", "excess return", "benchmark"],
  }),
  Object.freeze({
    key: "target_to_claim",
    terms: ["target-to-claim", "target to claim", "claim justification", "supports the claim", "proxy for", "not the same as"],
  }),
]);

const ODDS_MATRIX_GROUPS = Object.freeze([
  Object.freeze({
    key: "entry_price",
    terms: ["entry price", "bet price", "price taken", "t-24", "t-12", "t-6", "open", "opening price", "pre-event"],
  }),
  Object.freeze({
    key: "reference_price",
    terms: ["reference price", "close", "closing", "closing price", "best available pre-event", "final pre-event"],
  }),
  Object.freeze({
    key: "snapshot_matrix",
    terms: ["odds snapshot matrix", "snapshot matrix", "odds snapshot", "price snapshot", "odds ladder"],
  }),
  Object.freeze({
    key: "clv_availability",
    terms: ["clv", "closing line value", "clv available", "clv availability"],
  }),
  Object.freeze({
    key: "label_type",
    terms: ["label type", "realized return", "positive_return", "excess return", "hybrid", "return label"],
  }),
]);

const CLV_PROVENANCE_SIGNAL_TERMS = [
  "clv", "closing line value", "closing-line value", "closing line",
  "reference price", "entry price", "odds provenance", "price provenance",
  "market microstructure",
];

const CLV_PROVENANCE_GROUPS = Object.freeze([
  Object.freeze({
    key: "book_or_market",
    terms: ["book", "sportsbook", "bookmaker", "market id", "market", "exchange"],
  }),
  Object.freeze({
    key: "entry_snapshot",
    terms: ["entry price", "bet price", "price taken", "entry timestamp", "taken at", "t-24", "t-12", "t-6", "open"],
  }),
  Object.freeze({
    key: "reference_snapshot",
    terms: ["reference price", "closing price", "close", "closing", "final pre-event", "reference timestamp"],
  }),
  Object.freeze({
    key: "timestamp_or_asof",
    terms: ["timestamp", "as-of", "as of", "snapshot time", "odds snapshot", "price snapshot"],
  }),
]);

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function storyText(story) {
  return [
    story?.id || "",
    story?.title || "",
    story?.description || "",
    ...(Array.isArray(story?.postconditions) ? story.postconditions : []),
    ...(Array.isArray(story?.preconditions) ? story.preconditions : []),
    ...(Array.isArray(story?.tags) ? story.tags : []),
  ].join(" ");
}

function allRegistryStories(storyRegistry) {
  return [
    ...(Array.isArray(storyRegistry?.stories) ? storyRegistry.stories : []),
    ...(Array.isArray(storyRegistry?.infrastructure_stories) ? storyRegistry.infrastructure_stories : []),
  ];
}

function combinedContextText(context) {
  return normalizeText(Object.values(context?.planFiles || {}).join(" "));
}

function currentShape(context) {
  const shape = context?.planShape;
  if (shape && typeof shape === "object") return normalizeText(shape.primary || "");
  return normalizeText(shape || "");
}

function hasScientificPlanShape(context) {
  return currentShape(context) === "scientific";
}

function textContainsAny(text, terms) {
  const normalized = normalizeText(text);
  return terms.some((term) => termPresent(normalized, term));
}

function termPresent(normalizedText, term) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  if (/^[a-z0-9]+$/.test(normalizedTerm)) {
    return new RegExp(`(^|[^a-z0-9_])${normalizedTerm}([^a-z0-9_]|$)`).test(normalizedText);
  }
  return normalizedText.includes(normalizedTerm);
}

function matchingStories(storyRegistry, terms) {
  return allRegistryStories(storyRegistry)
    .filter((story) => textContainsAny(storyText(story), terms))
    .map((story) => story.id)
    .filter(Boolean);
}

function countCoveredGroups(text, groups) {
  const covered = [];
  const missing = [];
  for (const group of groups) {
    if (textContainsAny(text, group.terms)) covered.push(group.key);
    else missing.push(group.key);
  }
  return { covered, missing };
}

function iveMeta({ knowledgePack, factTemplates, conceptGuards, validNextActions, verificationRequired, memoryGuard }) {
  return {
    ive: {
      knowledge_pack: knowledgePack,
      fact_templates: factTemplates,
      concept_guards: conceptGuards,
      valid_next_actions: validNextActions,
      verification_required: verificationRequired,
      memory_guard: memoryGuard,
    },
  };
}

function roles(context) {
  return Array.isArray(context?.auditConfig?.roles) ? context.auditConfig.roles : [];
}

function hasQuantScope(context, text) {
  if (hasScientificPlanShape(context)) return true;
  return textContainsAny(text, QUANT_SCOPE_TERMS);
}

function shouldApply(context) {
  const text = combinedContextText(context);
  if (!text) return hasScientificPlanShape(context) && (roles(context).includes("quant") || roles(context).includes("quant_target"));
  if (hasScientificPlanShape(context) && (roles(context).includes("quant") || roles(context).includes("quant_target"))) return true;
  if (textContainsAny(text, HIGH_SIGNAL_TERMS)) return true;
  return hasQuantScope(context, text) && textContainsAny(text, TARGET_SIGNAL_TERMS);
}

function phaseAllowsBlockingFindings(context) {
  const phase = normalizeText(context?.currentState || "");
  if (!phase) return true;
  return !["explore", "init"].includes(phase);
}

function analyze(context) {
  const text = combinedContextText(context);
  const targetGroups = countCoveredGroups(text, TARGET_CONTRACT_GROUPS);
  const oddsGroups = countCoveredGroups(text, ODDS_MATRIX_GROUPS);
  const clvProvenanceGroups = countCoveredGroups(text, CLV_PROVENANCE_GROUPS);
  const hasBettingSignal = textContainsAny(text, BETTING_SIGNAL_TERMS);
  const hasClvProvenanceSignal = textContainsAny(text, CLV_PROVENANCE_SIGNAL_TERMS);
  const hasInefficiencySignal = textContainsAny(text, INEFFICIENCY_TERMS);
  const hasProxyLabel = textContainsAny(text, PROXY_LABEL_TERMS);
  const hasTargetClaimJustification = textContainsAny(text, [
    "target-to-claim", "target to claim", "claim justification",
    "proxy for", "does not equal", "not the same as", "supports the claim",
    "excess return", "clv", "closing line value",
  ]);

  return {
    text,
    targetGroups,
    oddsGroups,
    clvProvenanceGroups,
    hasBettingSignal,
    hasClvProvenanceSignal,
    hasInefficiencySignal,
    hasProxyLabel,
    hasTargetClaimJustification,
    storyRefs: matchingStories(context?.storyRegistry, [
      ...HIGH_SIGNAL_TERMS,
      ...TARGET_SIGNAL_TERMS,
      ...BETTING_SIGNAL_TERMS,
    ]),
  };
}

function targetContractIsMissing(analysis) {
  const requiredCore = ["target", "prediction_time", "available_data", "forbidden_future", "proof_metric"];
  return requiredCore.some((key) => analysis.targetGroups.missing.includes(key)) ||
    analysis.targetGroups.covered.length < 7;
}

function oddsMatrixIsMissing(analysis) {
  return analysis.hasBettingSignal && (
    analysis.oddsGroups.missing.includes("entry_price") ||
    analysis.oddsGroups.missing.includes("reference_price") ||
    analysis.oddsGroups.missing.includes("label_type") ||
    analysis.oddsGroups.covered.length < 4
  );
}

function clvProvenanceIsMissing(analysis) {
  return analysis.hasClvProvenanceSignal && (
    analysis.clvProvenanceGroups.missing.includes("book_or_market") ||
    analysis.clvProvenanceGroups.missing.includes("entry_snapshot") ||
    analysis.clvProvenanceGroups.missing.includes("reference_snapshot") ||
    analysis.clvProvenanceGroups.covered.length < 3
  );
}

function targetClaimMismatch(analysis) {
  return analysis.hasInefficiencySignal && analysis.hasProxyLabel && !analysis.hasTargetClaimJustification;
}

function makeRawFinding(ruleId, detail, recommendation, analysis, severity = SEVERITY.HIGH) {
  return {
    ruleId,
    detail,
    recommendation,
    severity,
    story_refs: analysis.storyRefs,
    missing_target_groups: analysis.targetGroups.missing,
    missing_odds_groups: analysis.oddsGroups.missing,
    missing_clv_provenance_groups: analysis.clvProvenanceGroups?.missing || [],
  };
}

const quantTargetPack = {
  id: "quant_target",

  applies(context) {
    return shouldApply(context);
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    if (!shouldApply(context) || !phaseAllowsBlockingFindings(context)) return [];
    const analysis = analyze(context);
    const findings = [];

    if (targetContractIsMissing(analysis)) {
      findings.push(makeRawFinding(
        "QT-001",
        `Relevant quant target language is present, but the model target contract is incomplete (missing: ${analysis.targetGroups.missing.join(", ")}).`,
        "Before interpreting the model claim, declare name, purpose, target, label formula, prediction time/horizon, known-at-time data, forbidden future fields, controls, failure modes, proof metric, and target-to-claim justification.",
        analysis
      ));
    }

    if (targetClaimMismatch(analysis)) {
      findings.push(makeRawFinding(
        "QT-002",
        "The plan links market inefficiency language to a realized-return or positive_return label without explaining why that target supports the inefficiency claim.",
        "State whether the label is realized return, CLV, excess return, or a hybrid, then justify the target-to-claim bridge with closing/reference-price controls.",
        analysis
      ));
    }

    if (oddsMatrixIsMissing(analysis)) {
      findings.push(makeRawFinding(
        "QT-003",
        `Betting/odds language is present, but the odds snapshot matrix is incomplete (missing: ${analysis.oddsGroups.missing.join(", ")}).`,
        "Add an odds snapshot matrix with entry price, reference price, T-24/T-12/T-6/open/close availability, CLV availability, and label type before interpreting betting-market claims.",
        analysis
      ));
    }

    if (clvProvenanceIsMissing(analysis)) {
      findings.push(makeRawFinding(
        "QT-004",
        `CLV or closing-line language is present, but CLV provenance is incomplete (missing: ${analysis.clvProvenanceGroups.missing.join(", ")}).`,
        "Route CLV provenance to repair, ticket, accepted limitation, or claim block with entry/reference/book/timestamp evidence before interpreting CLV claims.",
        analysis
      ));
    }

    return findings;
  },

  getPhaseGuidance(phase, context) {
    if (!shouldApply(context)) return null;
    const guidance = {
      explore: [
        "Treat every model name as a hypothesis, not an implementation noun.",
        "Identify the target label, prediction time, known-at-time data boundary, and forbidden future fields before accepting any quant claim.",
        "For betting work, inventory available odds snapshots: T-24, T-12, T-6, open, close, and best available pre-event reference price.",
        "Do not let positive_return or realized profit stand in for market inefficiency without a target-to-claim justification.",
      ],
      plan: [
        "Plan must include a model target contract: name, purpose, target, label formula, prediction horizon, prediction time, available-at-time data, forbidden future fields, controls, failure modes, and proof metric.",
        "If the claim uses market inefficiency, MIM, CLV, or betting prices, the plan must say whether the label is realized return, CLV, excess return, or a hybrid.",
        "Betting plans must include an odds snapshot matrix covering entry price, reference price, T-24/T-12/T-6/open/close availability, CLV availability, and label type.",
        "CLV or closing-line plans must route entry/reference/book/timestamp provenance to repair, ticket, accepted limitation, or claim block before interpreting CLV.",
      ],
      execute: [
        "Before building features, verify each feature is available at the declared prediction time.",
        "Keep strategy/modifier outputs separate from final policy decisions unless the plan explicitly declares that contract.",
        "Do not mix entry and reference odds snapshots without recording the matrix row being used.",
      ],
      reflect: [
        "Check whether the implemented target still supports the named claim, or whether the claim must be narrowed.",
        "Confirm CLV/excess-return/realized-return metrics are not being described interchangeably.",
        "Treat clv_provenance_unrepaired as an unresolved ontology fact until it has a repair, ticket, accepted limitation, or claim block.",
        "Record any missing odds horizon as residual uncertainty instead of filling it with assumptions.",
      ],
      validate: [
        "Validate the target contract against the artifacts actually produced.",
        "Confirm betting-market claims cite the declared odds snapshot matrix and target-to-claim justification.",
        "Block CLV-based claims while entry/reference/book/timestamp provenance remains unrouted.",
      ],
    };
    return formatPhaseGuidance(guidance, phase);
  },

  getPlanConstraints(context) {
    if (!shouldApply(context)) return [];
    const analysis = analyze(context);
    const constraints = [];

    if (targetContractIsMissing(analysis)) {
      constraints.push(makeConstraint({
        id: "QT-C-001",
        role: "quant_target",
        constraint: "Plan must declare a model target contract before interpreting quant model claims",
        severity: "HIGH",
        rationale: "Without the target, label formula, prediction horizon, known-at-time data, forbidden future fields, controls, failure modes, proof metric, and target-to-claim bridge, the model name can imply more than the evidence proves.",
        story_refs: analysis.storyRefs,
        meta: iveMeta({
          knowledgePack: "experiment_charter",
          factTemplates: ["model_target_contract_missing", "prediction_time_missing", "forbidden_future_fields_unbounded"],
          conceptGuards: ["model names are hypotheses; target, label formula, prediction time, known-at-time data, and proof metric define the claim boundary"],
          validNextActions: ["fix_now", "ticket_now", "accept_limitation"],
          verificationRequired: "model target contract includes target, label formula, prediction horizon/time, available data, forbidden future fields, controls, failure modes, proof metric, and target-to-claim bridge",
          memoryGuard: "future model claims must cite the target contract before interpretation",
        }),
      }));
    }

    if (analysis.hasInefficiencySignal) {
      constraints.push(makeConstraint({
        id: "QT-C-002",
        role: "quant_target",
        constraint: "Market-inefficiency or MIM claims must include a target-to-claim justification",
        severity: "HIGH",
        rationale: "positive_return and realized profit can reflect outcome variance, odds availability, or staking rules; they are not automatically evidence that a price was inefficient.",
        story_refs: analysis.storyRefs,
        meta: iveMeta({
          knowledgePack: "experiment_charter",
          factTemplates: ["target_to_claim_bridge_missing", "allowed_claims_exceeded", "proxy_label_overclaimed"],
          conceptGuards: ["positive_return, realized profit, CLV, and excess return are distinct targets with distinct allowed claims"],
          validNextActions: ["fix_now", "ticket_now", "accept_limitation"],
          verificationRequired: "target-to-claim bridge states whether the label is realized return, CLV, excess return, or hybrid, with controls for the named claim",
          memoryGuard: "future inefficiency claims must separate proxy labels from claim evidence",
        }),
      }));
    }

    if (oddsMatrixIsMissing(analysis)) {
      constraints.push(makeConstraint({
        id: "QT-C-003",
        role: "quant_target",
        constraint: "Betting-market plans must include an odds snapshot matrix before interpreting CLV, excess return, or inefficiency claims",
        severity: "HIGH",
        rationale: "Entry price, reference price, close, open, and intermediate snapshots answer different questions; mixing them changes the target.",
        story_refs: analysis.storyRefs,
        meta: iveMeta({
          knowledgePack: "market_odds_provenance",
          factTemplates: ["entry_price_missing", "reference_price_missing", "odds_snapshot_ambiguous"],
          conceptGuards: ["entry, reference, open, close, CLV, and realized return are different market facts"],
          validNextActions: ["fix_now", "ticket_now", "accept_limitation"],
          verificationRequired: "odds snapshot matrix records entry price, reference price, T-24/T-12/T-6/open/close availability, CLV availability, and label type",
          memoryGuard: "future betting claims must cite the odds snapshot matrix row being used",
        }),
      }));
    }

    if (clvProvenanceIsMissing(analysis)) {
      constraints.push(makeConstraint({
        id: "QT-C-004",
        role: "quant_target",
        constraint: "CLV or closing-line claims must route entry/reference/book/timestamp provenance to repair, ticket, accepted limitation, or claim block before interpretation",
        severity: "HIGH",
        rationale: "CLV provenance gaps are ontology facts; treating them as warnings in a report recreates IPBS-style report churn and can make unsupported market claims sound proven.",
        story_refs: analysis.storyRefs,
        meta: iveMeta({
          knowledgePack: "market_odds_provenance",
          factTemplates: ["clv_provenance_unrepaired", "entry_price_missing", "reference_price_missing", "odds_snapshot_ambiguous"],
          conceptGuards: ["CLV requires linked entry price, reference/close price, book or market, and timestamp/as-of provenance"],
          validNextActions: ["fix_now", "ticket_now", "accept_limitation"],
          verificationRequired: "entry/reference/close timestamps are linked to book/market, or CLV claim is blocked by accepted limitation",
          memoryGuard: "CLV claims stay disabled until provenance is repaired or explicitly limited",
        }),
      }));
    }

    return constraints;
  },

  normalizeFinding(raw) {
    return normalizePackFinding(raw, undefined, {
      packId: "quant_target",
      rules: RULE_DEFS,
      defaultSeverity: SEVERITY.HIGH,
      id: (finding) => finding.ruleId || "QT-UNKNOWN",
      category: (finding) => finding.ruleId === "QT-003" ? "market_microstructure" : "target_semantics",
      storyRefs: (finding) => finding.story_refs || [],
      fallbackEvidence: (finding) => finding.detail || `${finding.ruleId || "QT"} target-semantics finding`,
      fallbackRecommendation: "Add the missing quant target semantics to the plan.",
      meta: (finding, _context, rule) => ({
        quant_target: {
          rule_id: finding.ruleId,
          missing_target_groups: finding.missing_target_groups || [],
          missing_odds_groups: finding.missing_odds_groups || [],
          missing_clv_provenance_groups: finding.missing_clv_provenance_groups || [],
          false_positive: rule.false_positive,
        },
      }),
    });
  },
};

export default quantTargetPack;
