// packs/quant/index.mjs — Quantitative / trading role auditor pack.
//
// Checks (v1 — 5 rules max):
//   QU-001  Data leakage signal check (backtest stories without leakage review)
//   QU-002  Backtest horizon sanity (minimum window days)
//   QU-003  Required risk metrics presence (Sharpe, max drawdown)
//   QU-004  Train/test split integrity (random shuffle on time-series = error)
//   QU-005  Calibration documentation for probability-outputting models
//
// Collector pattern:
//   1. Grep story titles/postconditions for quant keywords → story_mentions/2 facts
//   2. Load quant_metadata.json if present → quant_meta/2 facts
//   3. Run Prolog rules → quant_violation/4 query
//   4. Normalize findings to shared schema

import { readFileSync, existsSync, statSync } from "fs";
import { join, dirname, resolve, sep, extname } from "path";
import { fileURLToPath } from "url";
import { createSession } from "../../scripts/lib/prolog.mjs";
import { makeFinding, makeConstraint, SEVERITY } from "../../scripts/lib/audit_types.mjs";
import { extractFilesToModify } from "../../scripts/lib/plan_utils.mjs";

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = dirname(__filename);
const RULES_FILE  = join(__dirname, "rules.pl");

// ---------------------------------------------------------------------------
// Quant keywords for story text grep
// ---------------------------------------------------------------------------

const QUANT_KEYWORDS = [
  "backtest", "backtesting", "leakage", "look_ahead", "lookahead",
  "train_test", "sharpe", "drawdown", "calibrat", "temporal",
  "feature_provenance", "time_series", "timeseries", "optimizer",
  "optimization", "optuna", "trial", "search_space", "search space",
  "parameter", "trueskill", "model", "dataset", "data source",
];

const QUANT_RESEARCH_KEYWORDS = [
  ...QUANT_KEYWORDS,
  "lineage", "known-at-time", "known at time", "date range", "row count",
  "coverage", "tape", "objective", "parameter surface", "alpha hypothesis",
  "edge hypothesis", "candidate alpha", "candidate edge", "next experiment",
  "expected edge", "falsification threshold",
];

const DATA_CONTRACT_TERMS = [
  "data source", "source dataset", "data tape", "lineage", "known-at-time",
  "known at time", "date range", "row count", "row counts", "coverage window",
  "as-of", "timestamp", "temporal coverage",
];

const OPTIMIZER_SIGNAL_TERMS = [
  "optimizer", "optimization", "optuna", "trial", "trials", "search space",
  "search_space", "parameter", "parameter surface", "grid search", "objective",
  "hyperparameter",
];

const OPTIMIZER_CONTRACT_TERMS = [
  "run class", "trial count", "trials", "parameter surface", "search space",
  "objective handling", "objective", "control", "controls", "frozen",
  "sampled", "smoke", "wiring", "serious",
];

const EXPLORATION_SIGNAL_TERMS = [
  "explore", "exploration", "exploratory", "hypothesis", "candidate",
  "screen", "scout", "sweep", "breadth", "aggressive", "discovery",
  "triage", "frontier", "falsification",
];

const EXPLORATION_CONTRACT_TERMS = [
  "exploration lane", "hypothesis ledger", "candidate ledger",
  "candidate funnel", "search breadth", "triage threshold",
  "kill criteria", "graduate criteria", "promotion boundary",
  "non-claim", "not claimed", "not run", "cheap falsification",
  "falsification criteria", "negative findings",
];

const MODEL_FAMILY_SEARCH_SIGNAL_TERMS = [
  "model family", "model families", "algorithm search", "model search",
  "catboost", "xgboost", "lightgbm", "extra trees", "extra_trees",
  "random forest", "gradient boosting", "hist gradient boosting",
  "booster", "boosting", "ensemble", "ensembling", "stacking",
  "stacker", "stackingclassifier", "voting", "weighted policy",
];

const MODEL_SEARCH_CONTRACT_GROUPS = [
  [
    "family-specific", "family specific", "model-family", "model families",
    "searched knobs", "not searched", "parameter ranges", "search surface",
    "parameter surface", "conditional parameter", "conditional parameters",
  ],
  [
    "boosting_type", "boosting type", "bootstrap_type", "bootstrap type",
    "grow_policy", "grow policy", "loss_function", "loss function",
    "leaf_estimation", "leaf estimation", "ordered boosting", "plain boosting",
    "bayesian bootstrap", "bernoulli", "mvs", "dart", "goss",
  ],
  [
    "calibration curve", "brier", "log loss", "ece", "ev calibration",
    "prediction correlation", "correlation matrix", "disagreement",
    "feature importance", "permutation", "shap", "odds bucket",
  ],
  [
    "paired lift", "paired", "control-adjusted", "control adjusted",
    "confidence interval", "bootstrap", "fight bootstrap", "card-cluster",
    "card cluster", "selection uncertainty", "top-k", "top k",
    "ci method", "sample size",
  ],
  [
    "stale", "fresh run", "fresh holdout", "not run", "not claimed",
    "non-claim", "exploratory", "promotion boundary", "rerun required",
  ],
];

const RESULT_CLAIM_TERMS = [
  "results", "report", "final-oos", "final oos", "out-of-sample", "out of sample",
  "roi", "pnl", "profit", "sharpe", "drawdown", "calibration", "clv",
  "promotion", "promotable", "optimized strategy", "selected strategy",
  "control beats", "baseline beats", "market inefficiency",
];

const RESULTS_VALIDATION_TERMS = [
  "quant_results_validation.json", "promotion verdict", "diagnostic_only",
  "wiring_proof", "run class", "bootstrap", "confidence interval",
  "rolling", "yearly stability", "leakage audit", "strongest counterargument",
  "falsification criteria", "presentation stamp",
];

const STATISTICAL_RIGOR_SIGNAL_TERMS = [
  "serious_search", "serious search", "promotion candidate", "promotable",
  "best strategy", "selected strategy", "optimized strategy", "model selection",
  "final-oos", "final oos", "out-of-sample", "out of sample", "oos roi",
  "oos sharpe", "production-ready", "promotion-grade",
];

const STATISTICAL_RIGOR_CONTRACT_GROUPS = [
  ["bootstrap", "confidence interval", "ci method", "selection uncertainty"],
  ["dsr", "deflated sharpe", "multiple testing", "multiple-testing", "fdr", "bonferroni"],
  ["sample floor", "sample size", "minimum sample", "min sample", "bets", "trades"],
  ["control", "controls", "baseline", "placebo", "fresh holdout", "final-oos", "walk-forward", "walk forward"],
];

const DEGENERATE_OUTPUT_SIGNAL_TERMS = [
  "policy selected zero bets", "selected zero bets", "zero bets", "0 bets",
  "no bets", "zero trades", "0 trades", "no trades", "tiny sample",
  "sample floor failed", "empty signal", "empty signal surface", "no signal",
  "no qualifying bets", "no qualifying trades",
];

const DEGENERATE_OUTPUT_ROUTING_TERMS = [
  "fix_now", "fix now", "ticket_now", "ticket now", "ticket", "diagnose",
  "diagnosis", "accept_limitation", "accepted limitation", "claim block",
  "diagnostic_only", "diagnostic only", "not_promotable", "not promotable",
  "next experiment", "run_experiment", "run experiment", "deferred_with_ticket",
];

const METRIC_LINEAGE_SIGNAL_TERMS = [
  "capped sharpe", "capped roi", "capped metric", "weighted coverage",
  "weighted roi", "weighted metric", "unweighted", "transformed roi",
  "transformed metric", "normalized roi", "metric lineage",
];

const METRIC_LINEAGE_CONTRACT_GROUPS = [
  ["raw metric", "raw value", "raw roi", "raw sharpe", "uncapped", "unweighted"],
  ["transformation", "transformed", "capped", "weighted", "winsorized", "normalized", "normalization"],
  ["metric lineage", "formula", "calculation", "denominator", "sample count", "aggregation"],
];

const ALPHA_DISCOVERY_TERM_GROUPS = [
  ["alpha hypothesis", "edge hypothesis", "candidate alpha", "candidate edge", "candidate signal", "edge mechanism", "signal mechanism", "market inefficiency mechanism"],
  ["expected edge", "expected roi", "expected clv", "expected metric", "proof metric", "target metric"],
  ["falsification threshold", "falsification criteria", "kill criterion", "fails if", "reject if"],
  ["next experiment", "next alpha hypothesis", "follow-up experiment", "research queue", "next test"],
];

const SOURCE_SCAN_EXTENSIONS = new Set([".py", ".r"]);
const MAX_SOURCE_SCAN_BYTES = 250_000;

const SOURCE_LEAKAGE_CONTEXT_TERMS = [
  "backtest", "model", "signal", "strategy", "prediction", "predict",
  "temporal", "time_series", "timeseries", "odds", "clv", "trueskill",
  "tennis", "atp", "ipbs", "mim",
];

// ---------------------------------------------------------------------------
// Collector: extract facts from stories and metadata file
// ---------------------------------------------------------------------------

function collectQuantFacts(context, session) {
  const { storyRegistry, cwd, auditConfig } = context;
  const roleOptions = (auditConfig.role_options || {}).quant || {};

  // 1. Grep story titles and evidence for quant keywords → story_mentions/2
  if (storyRegistry && Array.isArray(storyRegistry.stories)) {
    for (const story of storyRegistry.stories) {
      const haystack = [
        story.id || "",
        story.title || "",
        ...(story.postconditions || []),
        ...(story.preconditions || []),
        ...(story.tags || []),
      ].join(" ").toLowerCase();

      for (const kw of QUANT_KEYWORDS) {
        if (haystack.includes(kw)) {
          // sanitize() returns a quoted atom: 'value' — no extra quotes needed
          session.consult(`story_mentions(${sanitize(story.id)}, ${sanitize(kw)}).`);
        }
      }
    }
  }

  // 2. Apply role config overrides as quant_meta facts
  if (roleOptions.min_backtest_window_days) {
    session.consult(`quant_meta(min_backtest_days, ${Number(roleOptions.min_backtest_window_days)}).`);
  }
  if (Array.isArray(roleOptions.required_metrics)) {
    for (const m of roleOptions.required_metrics) {
      session.consult(`quant_meta(required_metric, ${sanitize(m)}).`);
    }
  }

  // 3. Load quant_metadata.json if present
  const metaPaths = [
    join(cwd, "quant_metadata.json"),
    join(cwd, ".agent", "quant_metadata.json"),
    join(cwd, "plans", "knowledge", "quant_metadata.json"),
  ];

  for (const mp of metaPaths) {
    if (existsSync(mp)) {
      let meta;
      try {
        meta = JSON.parse(readFileSync(mp, "utf-8"));
      } catch { continue; }

      if (typeof meta.backtest_days === "number") {
        session.consult(`quant_meta(backtest_days, ${meta.backtest_days}).`);
      }
      if (meta.split_method) {
        session.consult(`quant_meta(split_method, ${sanitize(meta.split_method)}).`);
      }
      if (meta.data_type) {
        session.consult(`quant_meta(data_type, ${sanitize(meta.data_type)}).`);
      }
      if (meta.feature_source) {
        session.consult(`quant_meta(feature_source, ${sanitize(meta.feature_source)}).`);
      }
      if (Array.isArray(meta.metrics)) {
        for (const m of meta.metrics) {
          session.consult(`quant_meta(has_metric, ${sanitize(m)}).`);
        }
      }
      if (Array.isArray(meta.skip_metrics)) {
        for (const m of meta.skip_metrics) {
          session.consult(`quant_meta(skip_metric, ${sanitize(m)}).`);
        }
      }
      break; // use first found
    }
  }

  // 4. Detect quant signals from plan files (if active plan exists)
  const planText = Object.values(context.planFiles || {}).join(" ").toLowerCase();
  if (planText.includes("backtest")) {
    session.consult("quant_meta(plan_mentions, backtest).");
  }
}

/**
 * Return a single-quoted Prolog atom string.
 * Quoting is always applied so that IDs like 'RE-001' or 'us-005' don't get
 * mis-tokenized as arithmetic expressions (e.g. RE - 001).
 */
function sanitize(str) {
  const s = String(str || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").toLowerCase();
  return `'${s}'`;
}

function storyText(story) {
  return [
    story?.id || "",
    story?.title || "",
    story?.description || "",
    ...(story?.postconditions || []),
    ...(story?.preconditions || []),
    ...(story?.tags || []),
  ].join(" ").toLowerCase();
}

function allRegistryStories(storyRegistry) {
  return [
    ...(Array.isArray(storyRegistry?.stories) ? storyRegistry.stories : []),
    ...(Array.isArray(storyRegistry?.infrastructure_stories) ? storyRegistry.infrastructure_stories : []),
  ];
}

function textContainsAny(text, terms) {
  const normalized = String(text || "").toLowerCase();
  return terms.some(term => normalized.includes(term));
}

function countPresentTerms(text, terms) {
  const normalized = String(text || "").toLowerCase();
  return terms.filter(term => normalized.includes(term)).length;
}

function countSatisfiedTermGroups(text, termGroups) {
  return termGroups.filter(group => textContainsAny(text, group)).length;
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

function normalizedPlanText(context) {
  return Object.values(context?.planFiles || {}).join(" ").toLowerCase();
}

function projectLooksTimeSeriesOrBacktest(context) {
  const stories = allRegistryStories(context?.storyRegistry);
  const combined = [
    normalizedPlanText(context),
    ...stories.map(storyText),
  ].join(" ");
  return textContainsAny(combined, SOURCE_LEAKAGE_CONTEXT_TERMS);
}

function cleanCandidatePath(value) {
  return String(value || "")
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/^["']|["']$/g, "");
}

function addCandidatePath(paths, cwd, value) {
  const clean = cleanCandidatePath(value);
  if (!clean || clean.includes("\0")) return;
  if (clean.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(clean)) return;
  const extension = extname(clean).toLowerCase();
  if (!SOURCE_SCAN_EXTENSIONS.has(extension)) return;

  const root = resolve(cwd);
  const resolved = resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + sep)) return;
  if (!existsSync(resolved)) return;
  try {
    const st = statSync(resolved);
    if (!st.isFile() || st.size > MAX_SOURCE_SCAN_BYTES) return;
  } catch {
    return;
  }
  paths.set(clean, resolved);
}

function collectSourceCandidatePaths(context) {
  const paths = new Map();
  const cwd = context?.cwd;
  if (!cwd) return paths;

  const planContent = context?.planFiles?.["plan.md"] || "";
  for (const filePath of extractFilesToModify(planContent)) {
    addCandidatePath(paths, cwd, filePath);
  }

  for (const story of allRegistryStories(context?.storyRegistry)) {
    for (const ref of [
      ...(Array.isArray(story.code_refs) ? story.code_refs : []),
      ...(Array.isArray(story.test_refs) ? story.test_refs : []),
    ]) {
      addCandidatePath(paths, cwd, ref);
    }
  }

  return paths;
}

function sourceLine(lines, index) {
  return String(lines[index] || "").trim().replace(/\s+/g, " ");
}

function collectSourceLeakageFindings(context) {
  if (!projectLooksTimeSeriesOrBacktest(context)) return [];

  const findings = [];
  for (const [relativePath, absolutePath] of collectSourceCandidatePaths(context)) {
    let source;
    try {
      source = readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }
    const lower = source.toLowerCase();
    const lines = source.split(/\r?\n/);

    const negativeShiftIndex = lines.findIndex((line) => /\bshift\s*\(\s*-\d+/.test(line.toLowerCase()));
    if (negativeShiftIndex !== -1) {
      findings.push({
        ruleId: "QU-006",
        subject: "project",
        file: relativePath,
        detail: `Source leakage risk in ${relativePath}: negative shift appears in model/backtest code (${sourceLine(lines, negativeShiftIndex)}). Confirm future labels are target-only and excluded from features.`,
        severity: "HIGH",
      });
    }

    const futureFeatureIndex = lines.findIndex((line) =>
      /\bfeatures?\s*=/.test(line.toLowerCase()) &&
      /\b(clv|closing[_\s-]?line|close[_\s-]?odds|future|target|label|actual|outcome|realized[_\s-]?return|post[_\s-]?event)\b/i.test(line)
    );
    if (futureFeatureIndex !== -1) {
      findings.push({
        ruleId: "QU-006",
        subject: "project",
        file: relativePath,
        detail: `Source leakage risk in ${relativePath}: feature list appears to include future/target-like fields (${sourceLine(lines, futureFeatureIndex)}). Confirm prediction-time availability before accepting the model.`,
        severity: "HIGH",
      });
    }

    const splitMatch = lower.match(/train_test_split\s*\(([\s\S]{0,500})\)/);
    if (splitMatch && !/shuffle\s*=\s*false/.test(splitMatch[1])) {
      findings.push({
        ruleId: "QU-006",
        subject: "project",
        file: relativePath,
        detail: `Source leakage risk in ${relativePath}: train_test_split is used without shuffle=False on time-series/backtest-like code. Use temporal cutoff or walk-forward split.`,
        severity: "CRITICAL",
      });
    }

    const scalerIndex = lower.indexOf(".fit_transform(");
    const splitIndex = lower.indexOf("train_test_split(");
    if (scalerIndex !== -1 && splitIndex !== -1 && scalerIndex < splitIndex) {
      findings.push({
        ruleId: "QU-006",
        subject: "project",
        file: relativePath,
        detail: `Source leakage risk in ${relativePath}: fit_transform appears before train/test splitting. Fit preprocessing on train folds only.`,
        severity: "HIGH",
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule definitions (metadata only — actual logic lives in rules.pl)
// ---------------------------------------------------------------------------

const RULE_DEFS = [
  {
    id: "QU-001",
    name: "Data leakage signal check",
    rationale: "Backtest stories without documented leakage review are a significant risk of inflated performance metrics.",
    false_positive: "Story is exploratory research; leakage check handled in a separate story.",
    remediation: "Add a dedicated leakage-check story or document feature provenance explicitly in postconditions.",
    engine: "prolog",
  },
  {
    id: "QU-002",
    name: "Backtest horizon sanity",
    rationale: "Backtests under 252 trading days (1 year) lack statistical reliability for most strategies.",
    false_positive: "Intraday strategies, prototype research phases, or strategies with short data history.",
    remediation: "Extend the backtest window or add quant_metadata.json with min_backtest_days override.",
    engine: "prolog",
  },
  {
    id: "QU-003",
    name: "Required risk metrics presence",
    rationale: "Strategies evaluated only on returns hide tail risk. Sharpe ratio and max drawdown are minimum requirements.",
    false_positive: "Exploratory research phase with no live deployment intent.",
    remediation: "Add risk metric computation to quant_metadata.json `metrics` field.",
    engine: "prolog",
  },
  {
    id: "QU-004",
    name: "Train/test split integrity",
    rationale: "Random shuffle on time-series data destroys temporal ordering, producing look-ahead bias.",
    false_positive: "Cross-sectional data (non-time-series), deliberately randomized regression tests.",
    remediation: "Set split_method to 'temporal_cutoff' or 'walk_forward' in quant_metadata.json.",
    engine: "prolog",
  },
  {
    id: "QU-005",
    name: "Calibration documentation",
    rationale: "Probability-outputting models must be calibrated before trading to ensure correct position sizing.",
    false_positive: "Non-probabilistic models (pure signal/regression output).",
    remediation: "Add calibration step to the implementation story and mention it in postconditions.",
    engine: "prolog",
  },
  {
    id: "QU-006",
    name: "Source-level leakage smell",
    rationale: "Referenced model/backtest code can contain leakage even when project metadata and stories look plausible.",
    false_positive: "Future label construction is target-only, random split is used in a non-temporal fixture, or preprocessing is fold-local despite compact code.",
    remediation: "Trace known-at-time feature boundaries, remove future-derived fields from features, use temporal/walk-forward splits, and fit preprocessing only inside train folds.",
    engine: "source_scan",
  },
];

// ---------------------------------------------------------------------------
// AuditorPack implementation
// ---------------------------------------------------------------------------

const quantPack = {
  id: "quant",

  applies(context) {
    const { storyRegistry, auditConfig, planFiles, cwd } = context;
    // Explicit opt-in via roles config
    const roles = Array.isArray(auditConfig.roles) ? auditConfig.roles : [];
    if (roles.includes("quant")) return true;

    // Auto-detect from story registry keywords
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      const storyMatch = storyRegistry.stories.some(s => {
        const text = [s.title || "", ...(s.tags || []), ...(s.postconditions || [])].join(" ").toLowerCase();
        return QUANT_KEYWORDS.some(kw => text.includes(kw));
      });
      if (storyMatch) return true;
    }

    // Auto-detect from plan files (findings, plan, decisions)
    if (planFiles) {
      const planText = Object.values(planFiles).join(" ").toLowerCase();
      if (QUANT_KEYWORDS.some(kw => planText.includes(kw))) return true;
    }

    // Auto-detect from project metadata files
    const metaPaths = [
      join(cwd, "quant_metadata.json"),
      join(cwd, ".agent", "quant_metadata.json"),
      join(cwd, "plans", "knowledge", "quant_metadata.json"),
    ];
    if (metaPaths.some(p => existsSync(p))) return true;

    // Auto-detect from dependency manifests for quant libraries
    const quantLibs = ["pandas", "numpy", "scipy", "statsmodels", "quantlib", "zipline",
      "backtrader", "bt", "pyfolio", "empyrical", "ta-lib", "ccxt", "alpaca"];
    try {
      const pkgPath = join(cwd, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const allDeps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}))
          .map(d => d.toLowerCase());
        if (quantLibs.some(lib => allDeps.some(dep => dep.includes(lib)))) return true;
      }
    } catch { /* ignore parse errors */ }
    // Python dependency manifests
    const pyManifests = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.cfg"];
    for (const manifest of pyManifests) {
      try {
        const mPath = join(cwd, manifest);
        if (existsSync(mPath)) {
          const content = readFileSync(mPath, "utf-8").toLowerCase();
          if (quantLibs.some(lib => content.includes(lib))) return true;
        }
      } catch { /* ignore */ }
    }

    return false;
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    // Clone the shared session so we don't pollute it for other packs
    const session = createSession();

    // Re-assert base story facts (the shared session is not clonable in our Prolog impl)
    if (context.storyRegistry && Array.isArray(context.storyRegistry.stories)) {
      for (const s of context.storyRegistry.stories) {
        if (!s.id) continue;
        const id = sanitize(s.id);
        // sanitize() wraps in quotes — use directly, no extra quoting needed
        session.consult(`story(${id}, ${sanitize(s.title || "untitled")}, ${sanitize(s.priority || "medium")}, ${sanitize(s.status || "unknown")}).`);
        if (Array.isArray(s.postconditions)) {
          for (const p of s.postconditions) {
            try { session.consult(`postcondition(${id}, ${p}).`); } catch { /* skip malformed */ }
          }
        }
        if (Array.isArray(s.tags)) {
          for (const t of s.tags) {
            session.consult(`story_tag(${id}, ${sanitize(t)}).`);
          }
        }
      }
    }

    // Collect quant-specific facts into the session
    collectQuantFacts(context, session);

    // Load Prolog rules
    let rulesText;
    try {
      rulesText = readFileSync(RULES_FILE, "utf-8");
    } catch (e) {
      return [{ _error: `Could not load quant rules.pl: ${e.message}` }];
    }

    try {
      session.consult(rulesText);
    } catch (e) {
      return [{ _error: `Failed to load quant Prolog rules: ${e.message}` }];
    }

    // Query all violations
    const rawFindings = [];
    try {
      for (const ans of session.query("quant_violation(RuleId, Subject, Detail, Severity)")) {
        rawFindings.push({
          ruleId:   String(ans.RuleId   || "QU-???"),
          subject:  String(ans.Subject  || "project"),
          detail:   String(ans.Detail   || ""),
          severity: String(ans.Severity || "MEDIUM"),
        });
      }
    } catch (e) {
      // Partial results already collected — continue
      if (process.env.DEBUG) console.error(`[quant] Prolog query error: ${e.message}`);
    }

    rawFindings.push(...collectSourceLeakageFindings(context));

    return rawFindings;
  },

  getPhaseGuidance(phase, _context) {
    const guidance = {
      explore: [
        "For alpha discovery, separate the exploration lane from the promotion lane: exploration maximizes hypothesis breadth and cheap falsification; promotion requires frozen-policy holdout proof.",
        "Create or require a hypothesis ledger with candidate source, trade thesis, target/outcome, known-at-time data, expected failure mode, kill criteria, and graduate criteria.",
        "Name the data source/tape, lineage, date range, row counts, and known-at-time boundary before trusting any result.",
        "Search for look-ahead bias signals in any data pipeline code.",
        "Check whether train/test split method is documented (temporal_cutoff or walk_forward preferred).",
        "Verify backtest window length is recorded — minimum 252 trading days unless justified.",
        "Look for feature provenance documentation — every feature must trace to a known-at-time source.",
      ],
      plan: [
        "Plan must state the alpha discovery loop: candidate alpha/edge mechanism, expected edge metric, falsification threshold, and next experiment.",
        "Aggressive exploration plans must state search breadth, candidate families, triage threshold, cheap falsification tests, kill criteria, graduate criteria, artifact ledger, and explicit non-claim boundary.",
        "Plan must state the data contract: source/tape, lineage, date range, row counts, coverage gaps, and known-at-time guarantees.",
        "For optimizer/search work, state run class, trial count, parameter surface, objective handling, frozen-vs-sampled inputs, and controls before interpreting output.",
        "For model-family, booster, or ensemble work, state family-specific searched knobs and not-searched knobs, internal training modes, diagnostics, paired/control-adjusted comparisons, CI or selection-uncertainty method, and stale-result boundary before interpreting output.",
        "For serious-search or promotion-grade claims, state bootstrap/CI or selection uncertainty, multiple-testing or DSR handling, sample floors, controls, and holdout/stability boundaries.",
        "Route zero-bet, zero-trade, tiny-sample, or empty-signal outputs to diagnosis, repair ticket, next experiment, claim block, or accepted limitation before closure.",
        "For capped, weighted, normalized, or transformed metrics, state raw values, transformation lineage, formula, denominator, and sample count.",
        "Include a dedicated leakage review step for any story that touches backtest data.",
        "Require temporal_cutoff or walk_forward as the split method — random shuffle on time-series is a critical error.",
        "Plan must specify minimum backtest window (default 252 days) and justify any shorter window.",
        "If probability outputs are involved, include a calibration verification step with quality thresholds; artifact existence alone is not calibration proof.",
        "List required risk metrics (Sharpe ratio, max drawdown at minimum) as explicit acceptance criteria.",
      ],
      execute: [
        "During exploration, prefer many small falsifiable screens over one overfit deep dive; log negative findings and killed candidates as first-class output.",
        "Always verify train/test split is temporal, not random shuffle — this is the #1 source of inflated backtest results.",
        "Check feature provenance before computing any backtest metric — no future data in feature construction.",
        "Never use in-sample data for evaluation. If walk-forward, ensure each fold respects temporal ordering.",
        "When implementing risk metrics, compute Sharpe ratio and max drawdown at minimum.",
        "Document any data transformations that could introduce survivorship bias.",
      ],
      reflect: [
        "Produce or review quant_results_validation.json before interpreting any quant/model/betting report as evidence.",
        "For non-diagnostic result artifacts, require next_alpha_hypothesis and next_experiment so not-promotable runs still feed the research queue.",
        "Classify the run as smoke, wiring_proof, exploratory, serious_search, or promotion_candidate; stamp smoke and wiring runs as diagnostic_only when the search budget is too small for the parameter surface.",
        "For model-family and ensemble results, report what was searched versus not searched, calibration/Brier/log-loss/ECE, calibration quality verdict, prediction correlation or disagreement, odds/EV buckets, top-K sensitivity, paired lift, and fight/card bootstrap or selection-uncertainty method.",
        "When probability outputs feed thresholds, Kelly sizing, or betting policy, grade calibration bins/reliability evidence; high-support bucket error, weighted error, low-probability inversions, or non-monotonic observed rates must route to blocked_alarm/repair/non-use.",
        "For exploratory runs, report the candidate funnel: requested, executed, killed, graduated, not run, and not claimed. Treat negative findings as useful signal, not cleanup.",
        "For degenerate outputs, record the ontology fact and route it; a zero-action policy or tiny sample is not a closeable report footnote.",
        "For transformed metrics, include raw-versus-transformed lineage so presentation cannot blur capped or weighted values into raw performance.",
        "Challenge empirical plausibility: controls, baselines, bootstrap/confidence intervals, rolling or yearly stability, leakage audit, sample size, date span, and split summary must all match the claim being made.",
        "If a control is profitable or beats the strategy, require a full-history stability audit and explanation before any promotion language is allowed.",
        "Require the strongest counterargument and falsification criteria in the validation artifact, not only in prose.",
      ],
      validate: [
        "Block closeout when quant/model/betting result claims exist but close_signals.quant_results_validation is missing or unsatisfied.",
        "Block non-diagnostic no-alpha dead ends that omit the next alpha hypothesis or next experiment.",
        "Promotion candidates require bootstrap/confidence intervals, stability evidence, leakage audit, train/validation/final-OOS split summary, sample size, date span, controls, and a promotion verdict.",
        "Smoke or wiring-proof runs may close only as diagnostic_only or not_promotable, with no best-strategy, optimized, production-ready, or promotion-grade language; diagnostic_only does not suppress explicit calibration-quality alarms.",
        "Exploratory runs may close with useful discoveries only if the report visibly separates explored candidates, killed candidates, graduated candidates, not-run surfaces, and non-claims.",
        "Block model-family exhaustion or ensemble-selection claims when the report omits family-specific search coverage, diagnostics, paired/control-adjusted comparison, CI/selection uncertainty, or a stale-result rerun boundary.",
        "Block serious-search or promotion language when statistical rigor facts such as bootstrap_ci_missing, dsr_missing, multiple_testing_unrepaired, or sample_floor_failed remain unrouted.",
        "Block closure when degenerate-output or metric-lineage facts remain unrouted; report_only is valid only after claim boundaries are explicit.",
        "For betting or inefficiency claims, require odds snapshot / CLV / reference-price evidence via the quant_target companion before accepting the result presentation.",
        "Treat markdown reports as presentation surfaces; the machine-readable quant_results_validation.json is the gate signal.",
      ],
    };
    const lines = guidance[phase];
    return lines ? lines.map((l, i) => `${i + 1}. ${l}`).join("\n") : null;
  },

  getPlanConstraints(context) {
    const constraints = [];
    const { storyRegistry } = context;
    const stories = allRegistryStories(storyRegistry);
    const planText = Object.values(context.planFiles || {}).join(" ").toLowerCase();
    const combinedText = [planText, ...stories.map(storyText)].join(" ");

    // Check if any stories mention backtest keywords
    const backtestStories = stories.filter(s => {
      const text = storyText(s);
      return text.includes("backtest") || text.includes("backtesting");
    });

    const quantStories = stories.filter(s => textContainsAny(storyText(s), QUANT_RESEARCH_KEYWORDS));
    const storyRefs = quantStories.map(s => s.id).filter(Boolean);
    const hasQuantResearchSignal = textContainsAny(combinedText, QUANT_RESEARCH_KEYWORDS);
    const hasExplorationSignal = textContainsAny(combinedText, EXPLORATION_SIGNAL_TERMS);
    const hasModelFamilySearchSignal =
      textContainsAny(combinedText, MODEL_FAMILY_SEARCH_SIGNAL_TERMS) &&
      (textContainsAny(combinedText, OPTIMIZER_SIGNAL_TERMS) ||
        textContainsAny(combinedText, MODEL_FAMILY_SEARCH_SIGNAL_TERMS.filter(term => !["model family", "model families"].includes(term))));
    const hasStatisticalRigorSignal =
      textContainsAny(combinedText, STATISTICAL_RIGOR_SIGNAL_TERMS) ||
      (textContainsAny(combinedText, RESULT_CLAIM_TERMS) && textContainsAny(combinedText, OPTIMIZER_SIGNAL_TERMS));
    const hasDegenerateOutputSignal = textContainsAny(combinedText, DEGENERATE_OUTPUT_SIGNAL_TERMS);
    const hasMetricLineageSignal =
      textContainsAny(combinedText, METRIC_LINEAGE_SIGNAL_TERMS) &&
      textContainsAny(combinedText, RESULT_CLAIM_TERMS);

    // Check for leakage mentions
    const hasLeakageMention = stories.some(s => {
      const text = storyText(s);
      return text.includes("leakage") || text.includes("look_ahead") || text.includes("lookahead");
    });

    if (backtestStories.length > 0 && !hasLeakageMention) {
      constraints.push(makeConstraint({
        id: "QU-C-001",
        role: "quant",
        constraint: "Plan must include a dedicated leakage review step",
        severity: "HIGH",
        rationale: "Backtest stories detected without any leakage review — inflated performance metrics are the #1 risk in quant projects",
        story_refs: backtestStories.map(s => s.id),
      }));
    }

    // Check for time-series without temporal split
    const hasTimeSeries = stories.some(s => {
      const text = storyText(s);
      return text.includes("time_series") || text.includes("timeseries") || text.includes("temporal");
    });

    const hasSplitMethod = stories.some(s => {
      const text = storyText(s);
      return text.includes("temporal_cutoff") || text.includes("walk_forward");
    });

    if (hasTimeSeries && !hasSplitMethod) {
      constraints.push(makeConstraint({
        id: "QU-C-002",
        role: "quant",
        constraint: "Train/test split must use temporal_cutoff or walk_forward — not random shuffle",
        severity: "CRITICAL",
        rationale: "Random shuffle on time-series data destroys temporal ordering, producing look-ahead bias and unreliable results",
        story_refs: [],
      }));
    }

    // Backtest window constraint
    if (backtestStories.length > 0) {
      const roleOptions = (context.auditConfig.role_options || {}).quant || {};
      const minDays = roleOptions.min_backtest_window_days || 252;
      constraints.push(makeConstraint({
        id: "QU-C-003",
        role: "quant",
        constraint: `Plan must specify minimum backtest window of ${minDays} trading days`,
        severity: "MEDIUM",
        rationale: `Backtests under ${minDays} trading days lack statistical reliability for most strategies`,
        story_refs: backtestStories.map(s => s.id),
      }));
    }

    if (hasQuantResearchSignal && countPresentTerms(combinedText, DATA_CONTRACT_TERMS) < 2) {
      constraints.push(makeConstraint({
        id: "QU-C-004",
        role: "quant",
        constraint: "Plan must name the data source/tape, lineage, date range, row counts, coverage gaps, and known-at-time boundary before treating data claims as true",
        severity: "HIGH",
        rationale: "Quant research can look rigorous while resting on an unnamed or look-ahead-prone data source; the planner must force the data contract before model interpretation",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "experiment_charter",
          factTemplates: ["data_contract_missing", "known_at_time_boundary_missing", "coverage_gap_unrouted"],
          conceptGuards: ["data source/tape and known-at-time boundaries must be facts, not report prose"],
          validNextActions: ["fix_now", "ticket_now", "accept_limitation"],
          verificationRequired: "source/tape, lineage, date range, row counts, coverage gaps, and known-at-time proof recorded or limitation accepted",
          memoryGuard: "future quant plans must carry a data contract before interpreting model output",
        }),
      }));
    }

    if (hasQuantResearchSignal && countSatisfiedTermGroups(combinedText, ALPHA_DISCOVERY_TERM_GROUPS) < 3) {
      constraints.push(makeConstraint({
        id: "QU-C-008",
        role: "quant",
        constraint: "Plan must state a candidate alpha/edge mechanism, expected edge metric, falsification threshold, and next experiment before quant work is review-ready",
        severity: "HIGH",
        rationale: "Quant research should not terminate at generic no-alpha wording; the planner must force the next falsifiable alpha-search step.",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "research_queue",
          factTemplates: ["candidate_unrouted", "falsification_rule_missing", "next_experiment_missing"],
          conceptGuards: ["no-alpha reports must still route the next falsifiable research action or accepted limitation"],
          validNextActions: ["run_experiment", "ticket_now", "accept_limitation"],
          verificationRequired: "candidate mechanism, proof metric, falsification threshold, and next experiment are recorded",
          memoryGuard: "negative findings and killed candidates remain in the research queue ledger",
        }),
      }));
    }

    if (
      textContainsAny(combinedText, OPTIMIZER_SIGNAL_TERMS) &&
      countPresentTerms(combinedText, OPTIMIZER_CONTRACT_TERMS) < 3
    ) {
      constraints.push(makeConstraint({
        id: "QU-C-005",
        role: "quant",
        constraint: "Optimizer/search plans must disclose run class, trial count, parameter surface, objective handling, frozen-vs-sampled inputs, and controls before interpreting output",
        severity: "HIGH",
        rationale: "A smoke run, wiring run, and serious optimization run have different evidentiary value; optimizer output is not research evidence unless scale and objective handling are explicit",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "experiment_charter",
          factTemplates: ["optimizer_scale_missing", "run_class_ambiguous", "search_surface_missing"],
          conceptGuards: ["smoke, wiring_proof, exploratory, serious_search, and promotion_candidate runs carry different claim boundaries"],
          validNextActions: ["fix_now", "ticket_now", "accept_limitation"],
          verificationRequired: "run class, trial count, parameter/search surface, objective handling, frozen inputs, sampled inputs, and controls are explicit",
          memoryGuard: "optimizer output cannot be promoted without the run-scale contract",
        }),
      }));
    }

    if (
      hasModelFamilySearchSignal &&
      countSatisfiedTermGroups(combinedText, MODEL_SEARCH_CONTRACT_GROUPS) < 3
    ) {
      constraints.push(makeConstraint({
        id: "QU-C-009",
        role: "quant",
        constraint: "Model-family, booster, or ensemble search plans must disclose family-specific searched/not-searched knobs, internal training modes, diagnostics, paired/control-adjusted comparisons, CI or selection-uncertainty method, and stale-result boundaries before interpreting output",
        severity: "HIGH",
        rationale: "Saying a family such as CatBoost or an ensemble was tried is not enough; boosted libraries and stacking policies have meaningful internal modes, and reports must prove those surfaces were searched or explicitly mark them not run before drawing model-selection conclusions.",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "model_family_search",
          factTemplates: ["model_family_search_coverage_missing", "stale_result_boundary_missing", "selection_uncertainty_missing"],
          conceptGuards: ["trying a model family is not proof that its meaningful internal modes or ensemble surfaces were searched"],
          validNextActions: ["run_experiment", "ticket_now", "accept_limitation"],
          verificationRequired: "searched and not-searched knobs, diagnostics, paired/control-adjusted comparison, CI or selection uncertainty, and stale-result boundary are explicit",
          memoryGuard: "model-family exhaustion claims require a coverage and stale-boundary ledger",
        }),
      }));
    }

    if (
      hasQuantResearchSignal &&
      hasExplorationSignal &&
      countPresentTerms(combinedText, EXPLORATION_CONTRACT_TERMS) < 3
    ) {
      constraints.push(makeConstraint({
        id: "QU-C-007",
        role: "quant",
        constraint: "Aggressive quant exploration must define hypothesis breadth, candidate ledger, triage threshold, kill/graduate criteria, artifact ledger, and explicit non-claim or promotion boundary",
        severity: "HIGH",
        rationale: "Exploration should be wide and fast, but without a ledger and kill/graduate contract it becomes hype-prone and hard to distinguish from promotion evidence.",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "research_queue",
          factTemplates: ["candidate_unrouted", "negative_finding_unrecorded", "allowed_claims_exceeded"],
          conceptGuards: ["exploration maximizes learning breadth; it is not promotion evidence until frozen proof exists"],
          validNextActions: ["run_experiment", "ticket_now", "accept_limitation"],
          verificationRequired: "candidate ledger, triage threshold, kill criteria, graduate criteria, artifact ledger, and non-claim boundary are present",
          memoryGuard: "explored, killed, graduated, not-run, and non-claim surfaces remain visible",
        }),
      }));
    }

    if (
      hasStatisticalRigorSignal &&
      countSatisfiedTermGroups(combinedText, STATISTICAL_RIGOR_CONTRACT_GROUPS) < 2
    ) {
      constraints.push(makeConstraint({
        id: "QU-C-010",
        role: "quant",
        constraint: "Serious-search, model-selection, or promotion-grade quant claims must state bootstrap/CI or selection uncertainty, multiple-testing or DSR handling, sample floors, controls, and holdout/stability boundaries",
        severity: "HIGH",
        rationale: "Thin search output can look persuasive when the report shows only point estimates; IVE must route missing statistical rigor before any serious interpretation.",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "statistical_rigor",
          factTemplates: ["bootstrap_ci_missing", "dsr_missing", "multiple_testing_unrepaired", "sample_floor_failed"],
          conceptGuards: ["promotion and serious-search language require uncertainty, multiplicity, sample-floor, control, and holdout boundaries"],
          validNextActions: ["run_experiment", "accept_limitation", "report_only"],
          verificationRequired: "bootstrap/CI or selection uncertainty, multiplicity or DSR handling, sample floor, controls, and holdout/stability proof are present; report_only is valid only after claim block",
          memoryGuard: "serious quant claims must carry statistical-rigor proof or explicit diagnostic-only limitation",
        }),
      }));
    }

    if (
      hasDegenerateOutputSignal &&
      countPresentTerms(combinedText, DEGENERATE_OUTPUT_ROUTING_TERMS) < 1
    ) {
      constraints.push(makeConstraint({
        id: "QU-C-011",
        role: "quant",
        constraint: "Degenerate quant outputs such as zero bets, zero trades, tiny samples, or empty signal surfaces must be routed to diagnosis, repair ticket, next experiment, claim block, or accepted limitation",
        severity: "HIGH",
        rationale: "A no-action policy or tiny-sample result is an ontology fact, not a presentational footnote; leaving it unrouted recreates IPBS-style report churn.",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "degenerate_output",
          factTemplates: ["policy_selected_zero_bets", "zero_trade_strategy", "tiny_sample_result", "empty_signal_surface", "degenerate_output_unrouted"],
          conceptGuards: ["policy results must be distinguished from diagnostic selector output; zero selected actions cannot be promoted as usable policy ROI"],
          validNextActions: ["fix_now", "ticket_now", "run_experiment", "accept_limitation"],
          verificationRequired: "policy trace, diagnosis, ticket acceptance criteria, next experiment, claim block, or accepted limitation routes the degenerate fact",
          memoryGuard: "future reports must keep degenerate outputs in the fact-routing ledger until routed",
        }),
      }));
    }

    if (
      hasMetricLineageSignal &&
      countSatisfiedTermGroups(combinedText, METRIC_LINEAGE_CONTRACT_GROUPS) < 2
    ) {
      constraints.push(makeConstraint({
        id: "QU-C-012",
        role: "quant",
        constraint: "Capped, weighted, normalized, or transformed quant metrics must state raw metric, transformation lineage, aggregation formula, denominator, and sample count before report claims are trusted",
        severity: "HIGH",
        rationale: "Metric presentation drift can turn diagnostic transformed values into apparent raw performance; IVE must force the metric lineage before action or closure.",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "metric_lineage",
          factTemplates: ["raw_metric_missing", "transformed_metric_reported_as_raw", "weighted_unweighted_mixed"],
          conceptGuards: ["raw, capped, weighted, normalized, and transformed metrics are different claim surfaces"],
          validNextActions: ["fix_now", "ticket_now", "accept_limitation"],
          verificationRequired: "raw values, transformation/capping/weighting lineage, formula, denominator, aggregation, and sample count are documented or limitation accepted",
          memoryGuard: "metric reports must preserve raw-versus-transformed lineage in future validation artifacts",
        }),
      }));
    }

    if (
      textContainsAny(combinedText, RESULT_CLAIM_TERMS) &&
      countPresentTerms(combinedText, RESULTS_VALIDATION_TERMS) < 3
    ) {
      constraints.push(makeConstraint({
        id: "QU-C-006",
        role: "quant",
        constraint: "Quant/model/betting result claims must produce quant_results_validation.json during REFLECT/VALIDATE with run class, controls, stability, confidence, presentation stamp, counterargument, falsification criteria, and promotion verdict",
        severity: "HIGH",
        rationale: "The planner must not accept report existence as proof; post-run numbers need an adversarial evidence audit before closeout or promotion.",
        story_refs: storyRefs,
        meta: iveMeta({
          knowledgePack: "validation_wiring",
          factTemplates: ["quant_results_validation_missing", "strongest_counterargument_missing", "promotion_verdict_missing"],
          conceptGuards: ["a report is presentation; quant_results_validation.json is the evidence route for result claims"],
          validNextActions: ["fix_now", "ticket_now", "accept_limitation"],
          verificationRequired: "machine-readable validation artifact records run class, controls, stability, confidence, counterargument, falsification criteria, presentation stamp, residual risk, and promotion verdict",
          memoryGuard: "future result claims must cite the validation artifact rather than only markdown report prose",
        }),
      }));
    }

    return constraints;
  },

  normalizeFinding(raw) {
    if (raw._error) {
      return makeFinding({
        id:             "QU-ERR",
        role:           "quant",
        severity:       SEVERITY.MEDIUM,
        category:       "pack_error",
        story_refs:     [],
        evidence:       raw._error,
        recommendation: "Check that packs/quant/rules.pl is present and valid Prolog.",
      });
    }

    const rule = RULE_DEFS.find(r => r.id === raw.ruleId) || {};
    const isStoryRef = raw.subject !== "project" && raw.subject !== "unknown" && !String(raw.subject || "").includes("/");

    // RP-016: Guard against undefined subject (missing Prolog binding).
    const subjectSlug = String(raw.file || raw.subject || "unknown").replace(/\W/g, "_");
    return makeFinding({
      id:             `${raw.ruleId}-${subjectSlug}`,
      role:           "quant",
      severity:       raw.severity || SEVERITY.MEDIUM,
      category:       ruleCategory(raw.ruleId),
      story_refs:     isStoryRef ? [raw.subject] : [],
      evidence:       raw.detail || `${raw.ruleId} violation for ${raw.subject}`,
      recommendation: rule.remediation || "See quant pack documentation.",
      meta: {
        quant: {
          rule_id:        raw.ruleId,
          false_positive: rule.false_positive,
          source_file:    raw.file || null,
        },
      },
    });
  },
};

function ruleCategory(ruleId) {
  const map = {
    "QU-001": "data_integrity",
    "QU-002": "backtest_validity",
    "QU-003": "metric_coverage",
    "QU-004": "data_integrity",
    "QU-005": "model_quality",
    "QU-006": "data_integrity",
  };
  return map[ruleId] || "quant";
}

export default quantPack;
