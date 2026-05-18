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
import { createSession } from "../../scripts/lib/prolog.mjs";
import { makeFinding, makeConstraint, SEVERITY } from "../../scripts/lib/audit_types.mjs";
import { sanitizeAtom as sanitize } from "../../scripts/lib/sanitize.mjs";
import { downgradeForShape as shapeAwareSeverity } from "../../scripts/lib/pack_severity.mjs";
import { parseAnnotations, walkDir, toPrologFacts } from "../../scripts/annotation_parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const RULES_FILE = join(__dirname, "rules.pl");

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
    const session = createSession();
    const { cwd, storyRegistry } = context;

    // Re-assert base story facts
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      for (const s of storyRegistry.stories) {
        if (!s.id) continue;
        const id = sanitize(s.id);
        session.consult(`story(${id}, ${sanitize(s.title || "untitled")}, ${sanitize(s.priority || "medium")}, ${sanitize(s.status || "unknown")}).`);
        if (Array.isArray(s.tags)) {
          for (const t of s.tags) session.consult(`story_tag(${id}, ${sanitize(t)}).`);
        }
        if (Array.isArray(s.code_refs)) {
          for (const c of s.code_refs) session.consult(`code_ref(${id}, ${sanitize(c)}).`);
        }
        if (Array.isArray(s.test_refs)) {
          for (const t of s.test_refs) session.consult(`test_ref(${id}, ${sanitize(t)}).`);
        }
        if (Array.isArray(s.validation_refs)) {
          for (const v of s.validation_refs) session.consult(`validation_ref(${id}, ${sanitize(v)}).`);
        }
      }
    }

    // Load @planner: annotations as deterministic facts
    try {
      const sourceFiles = walkDir(cwd, cwd);
      const allAnnotations = [];
      for (const f of sourceFiles) {
        allAnnotations.push(...parseAnnotations(f, cwd));
      }
      const prologFacts = toPrologFacts(allAnnotations);
      if (prologFacts) {
        session.consult(prologFacts);
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`[${this.id}] Annotation parse error: ${e.message}`);
    }

    // Detect and assert model facts
    const models = detectModels(cwd, storyRegistry);
    for (const m of models) {
      const name = sanitize(m.model_name || m.name || "unknown_model");
      const outputType = sanitize(m.output_type || "unknown");
      session.consult(`model(${name}, ${outputType}).`);

      if (m.used_for_decisions) session.consult(`model_used_for_decisions(${name}).`);
      if (m.live_deployment) session.consult(`model_tag(${name}, live_deployment).`);
      if (m.has_calibration) session.consult(`calibration_artifact(${name}, 'detected').`);
      if (m.has_edge) session.consult(`edge_artifact(${name}, 'detected').`);

      // AC-005: Assert result/validation_status from model metadata
      if (m.activity_count !== undefined) {
        session.consult(`result(${name}, activity_count, ${Number(m.activity_count) || 0}).`);
      }
      if (m.validation_status) {
        session.consult(`validation_status(${name}, ${sanitize(m.validation_status)}).`);
      }
    }

    // AC-005: Scan for result files that may contain activity counts
    const resultFiles = [
      "results.json", "model_results.json", "backtest_results.json",
      "reports/results.json", ".agent/results.json",
    ];
    for (const f of resultFiles) {
      const fullPath = join(cwd, f);
      if (existsSync(fullPath)) {
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
              const status = entry.validation_status || (entry.passed ? "passed" : "failed");
              session.consult(`validation_status(${subjName}, ${sanitize(status)}).`);
            }
          }
        } catch { /* skip malformed */ }
      }
    }

    // Assert success criteria from plan if available
    if (context.planFiles && context.planFiles.plan) {
      const planContent = context.planFiles.plan;
      const criteriaMatch = planContent.match(/##\s*Success\s*Criteria[\s\S]*?(?=##|$)/i);
      if (criteriaMatch) {
        const lines = criteriaMatch[0].split("\n").filter(l => /^[-*]\s/.test(l.trim()));
        for (let i = 0; i < lines.length; i++) {
          const criterionId = sanitize(`sc_${i + 1}`);
          session.consult(`success_criterion(${criterionId}).`);

          // AC-003 needs criterion_story/2 to build evidence chains.
          // Link criteria to stories that reference them via @planner:proves
          // or that share keywords with the criterion text.
          const criterionText = lines[i].replace(/^[-*]\s*/, "").toLowerCase();
          if (storyRegistry && Array.isArray(storyRegistry.stories)) {
            for (const s of storyRegistry.stories) {
              if (!s.id) continue;
              const storyId = sanitize(s.id);
              // Link if story title overlaps with criterion keywords (3+ char words)
              const storyTitle = (s.title || "").toLowerCase();
              const keywords = criterionText.split(/\s+/).filter(w => w.length > 3);
              const matched = keywords.some(kw => storyTitle.includes(kw));
              if (matched) {
                session.consult(`criterion_story(${criterionId}, ${storyId}).`);
              }
            }
          }
        }
      }
    }

    // Load Prolog rules
    let rulesText;
    try {
      rulesText = readFileSync(RULES_FILE, "utf-8");
    } catch (e) {
      return [{ _error: `Could not load ${this.id} rules.pl: ${e.message}` }];
    }

    try {
      session.consult(rulesText);
    } catch (e) {
      return [{ _error: `Failed to load ${this.id} Prolog rules: ${e.message}` }];
    }

    // Query violations
    const rawFindings = [];
    try {
      for (const ans of session.query("assumptions_challenger_violation(RuleId, Subject, Detail, Severity)")) {
        rawFindings.push({
          ruleId:   String(ans.RuleId   || "AC-???"),
          subject:  String(ans.Subject  || "project"),
          detail:   String(ans.Detail   || ""),
          severity: String(ans.Severity || "HIGH"),
        });
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`[${this.id}] Prolog query error: ${e.message}`);
    }

    return rawFindings;
  },

  normalizeFinding(raw, context) {
    if (raw._error) {
      return makeFinding({
        id:             `${this.id.toUpperCase()}-ERR`,
        role:           this.id,
        severity:       SEVERITY.MEDIUM,
        category:       "pack_error",
        story_refs:     [],
        evidence:       raw._error,
        recommendation: `Check that packs/${this.id}/rules.pl is present and valid Prolog.`,
      });
    }

    const rule = RULE_DEFS.find(r => r.id === raw.ruleId) || {};
    const isStoryRef = raw.subject !== "project" && raw.subject !== "unknown";
    const subjectSlug = String(raw.subject ?? "unknown").replace(/\W/g, "_");

    // v7.4.2: shape-conditional severity. AC-001 (calibration proof for
    // probability model) was firing CRITICAL on refactor plans that didn't
    // change probability output. AC-004 (HIGH output-critical story without
    // validation_ref) was firing on docs plans adding paragraphs to model
    // documentation. AC-002/AC-003/AC-005 (real edge / evidence chain /
    // dead-output bugs) stay CRITICAL across all shapes.
    const severity = shapeAwareSeverity({
      ruleId: raw.ruleId,
      defaultSeverity: raw.severity || SEVERITY.HIGH,
      planShape: context?.planShape,
      downgrades: {
        "AC-001": ["refactor", "docs"],
        "AC-004": ["docs", "integration"],
      },
    });

    // Build evidence message (Prolog returns subject/detail, JS composes message)
    const EVIDENCE_TEMPLATES = {
      "AC-001": (s, d) => `Probability model ${s} has no calibration proof (Brier score, reliability diagram)`,
      "AC-002": (s, d) => `Model ${s} is tagged for live deployment but has no edge proof over baseline`,
      "AC-003": (s, d) => `Success criterion ${s} has no complete evidence chain (story->code->test->validation)`,
      "AC-004": (s, d) => `HIGH story in output-critical domain: ${d} — no validation artifact proves output quality`,
      "AC-005": (s, d) => `Subject ${s} produced zero activity but passed validation`,
    };
    const evidenceFn = EVIDENCE_TEMPLATES[raw.ruleId];
    const evidence = evidenceFn
      ? evidenceFn(raw.subject, raw.detail)
      : `${raw.ruleId} violation for ${raw.subject}`;

    return makeFinding({
      id:             `${raw.ruleId}-${subjectSlug}`,
      role:           this.id,
      severity,
      category:       "output_trustworthiness",
      story_refs:     isStoryRef ? [raw.subject] : [],
      evidence,
      recommendation: rule.remediation || "Provide evidence that the output is trustworthy, not just that the code is correct.",
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
    const lines = guidance[phase];
    if (!lines || lines.length === 0) return null;
    return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
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
