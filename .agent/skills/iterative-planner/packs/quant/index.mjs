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
  "coverage", "tape", "objective", "parameter surface",
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
        "Name the data source/tape, lineage, date range, row counts, and known-at-time boundary before trusting any result.",
        "Search for look-ahead bias signals in any data pipeline code.",
        "Check whether train/test split method is documented (temporal_cutoff or walk_forward preferred).",
        "Verify backtest window length is recorded — minimum 252 trading days unless justified.",
        "Look for feature provenance documentation — every feature must trace to a known-at-time source.",
      ],
      plan: [
        "Plan must state the data contract: source/tape, lineage, date range, row counts, coverage gaps, and known-at-time guarantees.",
        "For optimizer/search work, state run class, trial count, parameter surface, objective handling, frozen-vs-sampled inputs, and controls before interpreting output.",
        "Include a dedicated leakage review step for any story that touches backtest data.",
        "Require temporal_cutoff or walk_forward as the split method — random shuffle on time-series is a critical error.",
        "Plan must specify minimum backtest window (default 252 days) and justify any shorter window.",
        "If probability outputs are involved, include a calibration verification step.",
        "List required risk metrics (Sharpe ratio, max drawdown at minimum) as explicit acceptance criteria.",
      ],
      execute: [
        "Always verify train/test split is temporal, not random shuffle — this is the #1 source of inflated backtest results.",
        "Check feature provenance before computing any backtest metric — no future data in feature construction.",
        "Never use in-sample data for evaluation. If walk-forward, ensure each fold respects temporal ordering.",
        "When implementing risk metrics, compute Sharpe ratio and max drawdown at minimum.",
        "Document any data transformations that could introduce survivorship bias.",
      ],
      reflect: [
        "Produce or review quant_results_validation.json before interpreting any quant/model/betting report as evidence.",
        "Classify the run as smoke, wiring_proof, exploratory, serious_search, or promotion_candidate; stamp smoke and wiring runs as diagnostic_only when the search budget is too small for the parameter surface.",
        "Challenge empirical plausibility: controls, baselines, bootstrap/confidence intervals, rolling or yearly stability, leakage audit, sample size, date span, and split summary must all match the claim being made.",
        "If a control is profitable or beats the strategy, require a full-history stability audit and explanation before any promotion language is allowed.",
        "Require the strongest counterargument and falsification criteria in the validation artifact, not only in prose.",
      ],
      validate: [
        "Block closeout when quant/model/betting result claims exist but close_signals.quant_results_validation is missing or unsatisfied.",
        "Promotion candidates require bootstrap/confidence intervals, stability evidence, leakage audit, train/validation/final-OOS split summary, sample size, date span, controls, and a promotion verdict.",
        "Smoke or wiring-proof runs may close only as diagnostic_only or not_promotable, with no best-strategy, optimized, production-ready, or promotion-grade language.",
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
