// packs/assumptions_challenger/index.mjs — Assumptions Challenger persona pack.
//
// Purpose: Catches claims-without-evidence failures (HR-007, HR-008, HR-011).
// Instead of looking for bugs, this persona asks "Why should I believe this works?"
// and checks whether evidence artifacts actually exist to back up claims.
//
// Derived from UFC/IPBS failure: calibration was never proven despite
// multiple red team passes that all focused on code correctness.
//
// AuditorPack contract (v1.1):
//   Required: id, applies, rules, audit, normalizeFinding
//   Optional: getPhaseGuidance, getPlanConstraints

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { makeConstraint } from "../../scripts/lib/audit_types.mjs";
import { sanitizeAtom as sanitize } from "../../scripts/lib/sanitize.mjs";
import {
  assertStoryFacts,
  formatPhaseGuidance,
  normalizePackFinding,
  runPrologPackAudit,
} from "../../scripts/lib/auditor_pack_engine.mjs";
import { parseAnnotations, walkDir, toPrologFacts } from "../../scripts/annotation_parser.mjs";
import {
  compileVerificationStatusFacts,
  normalizeVerificationStatus,
} from "../../scripts/lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const RULES_FILE = join(__dirname, "rules.pl");
const VERIFICATION_STATUS_RULES_FILE = join(__dirname, "..", "..", "prolog", "verification_statuses.pl");

// ---------------------------------------------------------------------------
// Domain keywords — signals this pack is relevant
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS = [
  "calibration", "prediction", "probability", "forecast", "model",
  "betting", "trading", "backtest", "deploy", "production", "live",
  "accuracy", "precision", "recall", "brier", "auc", "roc",
  "sharpe", "sortino", "edge", "alpha", "baseline",
];

// Tags that indicate output trustworthiness matters
const OUTPUT_CRITICAL_TAGS = [
  "betting", "trading", "ml_model", "prediction", "financial",
  "medical", "safety_critical", "data_pipeline", "output_critical",
];

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

const RULE_DEFS = [
  {
    id: "AC-001",
    name: "Probability model without calibration proof",
    rationale: "Models outputting probabilities used for decisions (betting, trading, medical) must prove calibration. The UFC/IPBS failure: model probabilities didn't match observed frequencies, losing money on every bet.",
    false_positive: "Models in exploratory/research phase not yet used for decisions.",
    remediation: "Add calibration artifact: Brier score on held-out temporal data, reliability diagram, per-bucket calibration analysis.",
    engine: "prolog",
  },
  {
    id: "AC-002",
    name: "Live deployment without edge proof",
    rationale: "A model deployed to production that hasn't demonstrated edge over a baseline is a liability. Well-calibrated probabilities are worthless if they don't beat the market/random/majority-class baseline.",
    false_positive: "Models deployed for monitoring/logging purposes only (not driving decisions).",
    remediation: "Add edge artifact: comparison vs relevant baseline (market odds, buy-and-hold, random prediction, majority class).",
    engine: "prolog",
  },
  {
    id: "AC-003",
    name: "Success criterion with broken evidence chain",
    rationale: "Every success criterion must trace through story → code → test → validation. A criterion with no evidence chain is an unproven claim.",
    false_positive: "Criteria that are process-level (not code-level) and verified through documentation review.",
    remediation: "Ensure the criterion maps to a story with code_refs, test_refs, and ideally validation_refs.",
    engine: "prolog",
  },
  {
    id: "AC-004",
    name: "Output-critical story without validation artifact",
    rationale: "HIGH priority stories in domains where output quality matters (betting, ML, trading) need validation artifacts that verify the output, not just tests that verify the code.",
    false_positive: "Stories where output validation is handled by a downstream integration test.",
    remediation: "Add a validation_ref pointing to a script or notebook that validates output quality (not just code correctness).",
    engine: "prolog",
  },
  {
    id: "AC-005",
    name: "Degenerate output passed validation",
    rationale: "Zero-activity results (zero trades, zero predictions) cannot be valid. Evolution Trader M-010: zero-trade strategies scored 100/100 on robustness.",
    false_positive: "Intentional no-op strategies used as baselines.",
    remediation: "Add minimum activity gates before validation checks.",
    engine: "prolog",
  },
];

const EVIDENCE_TEMPLATES = {
  "AC-001": (s, d) => `Probability model ${s} has no calibration proof (Brier score, reliability diagram)`,
  "AC-002": (s, d) => `Model ${s} is tagged for live deployment but has no edge proof over baseline`,
  "AC-003": (s, d) => `Success criterion ${s} has no complete evidence chain (story->code->test->validation)`,
  "AC-004": (s, d) => `HIGH story in output-critical domain: ${d} — no validation artifact proves output quality`,
  "AC-005": (s, d) => `Subject ${s} produced zero activity but passed validation`,
};

// ---------------------------------------------------------------------------
// Detect models and their evidence from project files
// ---------------------------------------------------------------------------

function detectModels(cwd, storyRegistry) {
  const models = [];

  // Check for model metadata files
  const metadataFiles = [
    "model_metadata.json", ".agent/model_metadata.json",
    "plans/knowledge/model_metadata.json",
    "betting_metadata.json", ".agent/betting_metadata.json",
    "quant_metadata.json", ".agent/quant_metadata.json",
  ];

  for (const f of metadataFiles) {
    const fullPath = join(cwd, f);
    if (existsSync(fullPath)) {
      try {
        const data = JSON.parse(readFileSync(fullPath, "utf-8"));
        if (data.models && Array.isArray(data.models)) {
          models.push(...data.models);
        } else if (data.model_name || data.model_type) {
          models.push(data);
        }
      } catch { /* skip malformed */ }
    }
  }

  // Infer from story tags
  if (storyRegistry && Array.isArray(storyRegistry.stories)) {
    for (const s of storyRegistry.stories) {
      const tags = s.tags || [];
      if (tags.some(t => OUTPUT_CRITICAL_TAGS.includes(t))) {
        // Check if any story mentions calibration/edge artifacts
        const hasCalibration = (s.validation_refs || []).some(v =>
          /calibr|brier|reliability/i.test(v)
        );
        const hasEdge = (s.validation_refs || []).some(v =>
          /edge|baseline|clv|alpha/i.test(v)
        );

        if (!hasCalibration || !hasEdge) {
          // Infer a model from the story context
          const modelId = `model_from_${s.id}`;
          if (!models.some(m => m.model_name === modelId)) {
            models.push({
              model_name: modelId,
              output_type: tags.includes("prediction") || tags.includes("betting") ? "outputs_probabilities" : "outputs_values",
              used_for_decisions: true,
              live_deployment: tags.includes("production") || tags.includes("live"),
              has_calibration: hasCalibration,
              has_edge: hasEdge,
            });
          }
        }
      }
    }
  }

  return models;
}

// ---------------------------------------------------------------------------
// AuditorPack implementation
// ---------------------------------------------------------------------------

const assumptionsChallengerPack = {
  id: "assumptions_challenger",

  applies(context) {
    const { storyRegistry, auditConfig, planFiles } = context;

    // Explicit opt-in
    const roles = Array.isArray(auditConfig.roles) ? auditConfig.roles : [];
    if (roles.includes(this.id)) return true;

    // Auto-detect from story tags
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      const hasOutputCritical = storyRegistry.stories.some(s => {
        const tags = s.tags || [];
        return tags.some(t => OUTPUT_CRITICAL_TAGS.includes(t));
      });
      if (hasOutputCritical) return true;

      const storyMatch = storyRegistry.stories.some(s => {
        const text = [s.title || "", ...(s.tags || []), ...(s.postconditions || [])].join(" ").toLowerCase();
        return DOMAIN_KEYWORDS.some(kw => text.includes(kw));
      });
      if (storyMatch) return true;
    }

    // Auto-detect from plan files
    if (planFiles) {
      const planText = Object.values(planFiles).join(" ").toLowerCase();
      if (DOMAIN_KEYWORDS.some(kw => planText.includes(kw))) return true;
    }

    return false;
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    return runPrologPackAudit(context, {
      packId: this.id,
      rulesFile: RULES_FILE,
      query: "assumptions_challenger_violation(RuleId, Subject, Detail, Severity)",
      defaultRuleId: "AC-???",
      defaultSeverity: "HIGH",
      collectFacts: (ctx, session) => {
        const { cwd, storyRegistry } = ctx;
        session.consultFile(VERIFICATION_STATUS_RULES_FILE);
        session.consult(compileVerificationStatusFacts());
        assertStoryFacts(session, storyRegistry, {
          sanitize,
          include: ["tags", "code_refs", "test_refs", "validation_refs"],
        });

        try {
          const sourceFiles = walkDir(cwd, cwd);
          const allAnnotations = [];
          for (const f of sourceFiles) allAnnotations.push(...parseAnnotations(f, cwd));
          const prologFacts = toPrologFacts(allAnnotations);
          if (prologFacts) session.consult(prologFacts);
        } catch (e) {
          if (process.env.DEBUG) console.error(`[${this.id}] Annotation parse error: ${e.message}`);
        }

        const models = detectModels(cwd, storyRegistry);
        for (const m of models) {
          const name = sanitize(m.model_name || m.name || "unknown_model");
          const outputType = sanitize(m.output_type || "unknown");
          session.consult(`model(${name}, ${outputType}).`);
          if (m.used_for_decisions) session.consult(`model_used_for_decisions(${name}).`);
          if (m.live_deployment) session.consult(`model_tag(${name}, live_deployment).`);
          if (m.has_calibration) session.consult(`calibration_artifact(${name}, 'detected').`);
          if (m.has_edge) session.consult(`edge_artifact(${name}, 'detected').`);
          if (m.activity_count !== undefined) session.consult(`result(${name}, activity_count, ${Number(m.activity_count) || 0}).`);
          if (m.validation_status) {
            const status = normalizeVerificationStatus(m.validation_status, "execution");
            session.consult(`validation_status(${name}, ${sanitize(status.valid ? status.canonical : "unknown")}).`);
          }
        }

        const resultFiles = [
          "results.json", "model_results.json", "backtest_results.json",
          "reports/results.json", ".agent/results.json",
        ];
        for (const f of resultFiles) {
          const fullPath = join(cwd, f);
          if (!existsSync(fullPath)) continue;
          try {
            const data = JSON.parse(readFileSync(fullPath, "utf-8"));
            const subjects = Array.isArray(data) ? data : (data.results || data.strategies || [data]);
            for (const entry of subjects) {
              if (!entry.name && !entry.id) continue;
              const subjName = sanitize(entry.name || entry.id);
              if (entry.trade_count !== undefined || entry.activity_count !== undefined || entry.prediction_count !== undefined) {
                const count = Number(entry.trade_count ?? entry.activity_count ?? entry.prediction_count ?? 0);
                session.consult(`result(${subjName}, activity_count, ${count}).`);
              }
              if (entry.validation_status || entry.passed !== undefined) {
                const authoredStatus = entry.validation_status || (entry.passed ? "passed" : "failed");
                const status = normalizeVerificationStatus(authoredStatus, "execution");
                session.consult(`validation_status(${subjName}, ${sanitize(status.valid ? status.canonical : "unknown")}).`);
              }
            }
          } catch { /* skip malformed */ }
        }

        if (ctx.planFiles && ctx.planFiles.plan) {
          const criteriaMatch = ctx.planFiles.plan.match(/##\s*Success\s*Criteria[\s\S]*?(?=##|$)/i);
          if (criteriaMatch) {
            const lines = criteriaMatch[0].split("\n").filter(l => /^[-*]\s/.test(l.trim()));
            for (let i = 0; i < lines.length; i++) {
              const criterionId = sanitize(`sc_${i + 1}`);
              session.consult(`success_criterion(${criterionId}).`);
              const criterionText = lines[i].replace(/^[-*]\s*/, "").toLowerCase();
              if (storyRegistry && Array.isArray(storyRegistry.stories)) {
                for (const s of storyRegistry.stories) {
                  if (!s.id) continue;
                  const storyTitle = (s.title || "").toLowerCase();
                  const keywords = criterionText.split(/\s+/).filter(w => w.length > 3);
                  if (keywords.some(kw => storyTitle.includes(kw))) {
                    session.consult(`criterion_story(${criterionId}, ${sanitize(s.id)}).`);
                  }
                }
              }
            }
          }
        }
      },
    });
  },

  normalizeFinding(raw, context) {
    return normalizePackFinding(raw, context, {
      packId: this.id,
      rules: RULE_DEFS,
      defaultSeverity: "HIGH",
      category: "output_trustworthiness",
      severityDowngrades: {
        "AC-001": ["refactor", "docs"],
        "AC-004": ["docs", "integration"],
      },
      evidenceTemplates: EVIDENCE_TEMPLATES,
      fallbackRecommendation: "Provide evidence that the output is trustworthy, not just that the code is correct.",
    });
  },

  // --- Optional v1.1 methods ---

  getPhaseGuidance(phase, _context) {
    const guidance = {
      explore: [
        "Identify what claims this project makes about its output quality.",
        "For each claim, note what evidence would be needed to prove it.",
        "Check for existing calibration, baseline comparison, or validation artifacts.",
        "Ask: 'Would I bet my own money on this output?' — if not, why not?",
      ],
      plan: [
        "Plan must identify which outputs are used for decisions and require proof.",
        "Include explicit verification steps for calibration and edge/alpha.",
        "Success criteria must include output quality metrics, not just code metrics.",
        "Pre-mortem: 'If this fails in 6 months, what's the most likely reason?'",
      ],
      execute: [
        "When implementing model outputs, always create a validation artifact alongside.",
        "Calibration checks must run on temporally held-out data, not random splits.",
        "Edge/baseline comparisons must use the same data and time period.",
        "Never mark a model ready for deployment without calibration + edge proof.",
      ],
      reflect: [
        "Verify every success criterion has evidence — not just tests passing.",
        "Check that validation artifacts were actually executed (proof of work).",
        "Confirm calibration and edge metrics meet documented thresholds.",
        "Ask: 'What assumptions are we making that we haven't validated?'",
      ],
    };
    return formatPhaseGuidance(guidance, phase);
  },

  getPlanConstraints(context) {
    const constraints = [];
    const { storyRegistry } = context;

    // Check if any stories are in output-critical domains
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      const outputCriticalStories = storyRegistry.stories.filter(s =>
        (s.tags || []).some(t => OUTPUT_CRITICAL_TAGS.includes(t))
      );

      if (outputCriticalStories.length > 0) {
        constraints.push(makeConstraint({
          id: "AC-C-001",
          role: this.id,
          constraint: "Plan must include output validation steps (not just code tests) for all output-critical stories",
          severity: "CRITICAL",
          rationale: "Past incident: model passed all code tests but produced uncalibrated probabilities, leading to financial losses on every bet.",
          story_refs: outputCriticalStories.map(s => s.id),
        }));

        constraints.push(makeConstraint({
          id: "AC-C-002",
          role: this.id,
          constraint: "Plan must document what baseline the model/system will be compared against and what constitutes sufficient edge",
          severity: "HIGH",
          rationale: "A well-coded model that doesn't beat a trivial baseline is worse than useless — it provides false confidence.",
          story_refs: [],
        }));
      }
    }

    return constraints;
  },
};

export default assumptionsChallengerPack;
