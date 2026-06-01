// packs/config_integrity/index.mjs — Configuration Integrity persona pack.
//
// Purpose: Catches configuration conflicts and metric contamination
// (HR-005, HR-006). Detects mutually exclusive flags enabled
// simultaneously and capped metrics leaking without raw values.
//
// Derived from Evolution Trader M-024: --use-walk-forward AND
// --use-cpcv-ga both enabled, destroying temporal ordering.
//
// AuditorPack contract (v1.1):
//   Required: id, applies, rules, audit, normalizeFinding
//   Optional: getPhaseGuidance, getPlanConstraints

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createSession } from "../../scripts/lib/prolog.mjs";
import { makeFinding, makeConstraint, SEVERITY } from "../../scripts/lib/audit_types.mjs";
import { downgradeForShape as shapeAwareSeverity } from "../../scripts/lib/pack_severity.mjs";
import { sanitizeAtom as sanitize } from "../../scripts/lib/sanitize.mjs";
import { parseAnnotations, walkDir, toPrologFacts } from "../../scripts/annotation_parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const RULES_FILE = join(__dirname, "rules.pl");

// ---------------------------------------------------------------------------
// Domain keywords — signals this pack is relevant
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS = [
  "config", "configuration", "flag", "toggle", "feature_flag",
  "metric", "sharpe", "sortino", "drawdown", "threshold",
  "enable", "disable", "skip", "mode", "strategy",
];

const TEST_FIXTURE_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "fixture",
  "fixtures",
  "example",
  "examples",
  "sample",
  "samples",
]);

// ---------------------------------------------------------------------------
// Known mutual exclusions (extensible via config)
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUSIONS = [
  ["use_walk_forward", "use_cpcv_shuffle"],
  ["temporal_split", "random_split"],
  ["train_test_random", "train_test_temporal"],
];

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

const RULE_DEFS = [
  {
    id: "CI-001",
    name: "Mutually exclusive flags both enabled",
    rationale: "Logically incompatible configuration flags enabled simultaneously can cause silent data corruption. Evolution Trader M-024: walk-forward (temporal) + CPCV (shuffled) destroyed temporal ordering.",
    false_positive: "Flags that appear contradictory but have a valid combined interpretation documented in code.",
    remediation: "Disable one of the conflicting flags. Add mutual exclusion validation to the configuration loader.",
    engine: "prolog",
  },
  {
    id: "CI-002",
    name: "Capped metric without raw value",
    rationale: "When metrics are capped (e.g., Sharpe capped at 10), downstream consumers may not know they're seeing transformed data. Evolution Trader M-007: capped Sharpe/Sortino leaked to reports.",
    false_positive: "Metrics that are intentionally display-only and never used for decision-making.",
    remediation: "Preserve raw metric values alongside capped versions. Label clearly which is raw vs transformed.",
    engine: "prolog",
  },
  {
    id: "CI-003",
    name: "Orphaned configuration flag",
    rationale: "Configuration flags with defaults but no readers indicate dead code or incomplete integration.",
    false_positive: "Flags reserved for future use that are documented as not-yet-implemented.",
    remediation: "Either wire the flag to its consumer or remove it to reduce configuration surface area.",
    engine: "prolog",
  },
];

// ---------------------------------------------------------------------------
// Configuration scanning
// ---------------------------------------------------------------------------

function scanConfigFiles(cwd) {
  const configs = {};
  const configFiles = [
    "config.json", "config.yaml", "config.yml",
    ".env", "settings.json", "audit.config.json",
    "pyproject.toml", "setup.cfg",
  ];

  for (const f of configFiles) {
    const fullPath = join(cwd, f);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        configs[f] = content;
      } catch { /* skip */ }
    }
  }

  return configs;
}

function extractFlags(configs) {
  const flags = [];
  for (const [source, content] of Object.entries(configs)) {
    // JSON config
    if (source.endsWith(".json")) {
      try {
        const data = JSON.parse(content);
        function walk(obj, prefix) {
          for (const [k, v] of Object.entries(obj)) {
            const key = prefix ? `${prefix}.${k}` : k;
            if (typeof v === "boolean") {
              flags.push({ source, name: key, value: v });
            } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
              walk(v, key);
            }
          }
        }
        walk(data, "");
      } catch { /* skip malformed */ }
    }

    // .env file
    if (source === ".env") {
      const lines = content.split("\n");
      for (const line of lines) {
        const match = line.match(/^([A-Z_]+)\s*=\s*(true|false|1|0)\s*$/i);
        if (match) {
          const val = match[2].toLowerCase();
          flags.push({ source, name: match[1].toLowerCase(), value: val === "true" || val === "1" });
        }
      }
    }
  }

  return flags;
}

function isTestOrFixturePath(filePath) {
  const segments = String(filePath || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => TEST_FIXTURE_SEGMENTS.has(segment))) return true;

  const baseName = segments.at(-1) || "";
  return /(^|[._-])(test|spec)([._-]|$)/.test(baseName) ||
    /(^|[._-])(fixture|sample)([._-]|$)/.test(baseName);
}

// ---------------------------------------------------------------------------
// AuditorPack implementation
// ---------------------------------------------------------------------------

const configIntegrityPack = {
  id: "config_integrity",

  applies(context) {
    const { auditConfig } = context;

    // Explicit opt-in
    const roles = Array.isArray(auditConfig.roles) ? auditConfig.roles : [];
    if (roles.includes(this.id)) return true;

    // Auto-detect: any project with configuration files
    const configs = scanConfigFiles(context.cwd);
    if (Object.keys(configs).length > 0) return true;

    return false;
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    const session = createSession();
    const { cwd, storyRegistry, auditConfig } = context;

    // Re-assert base story facts
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      for (const s of storyRegistry.stories) {
        if (!s.id) continue;
        const id = sanitize(s.id);
        session.consult(`story(${id}, ${sanitize(s.title || "untitled")}, ${sanitize(s.priority || "medium")}, ${sanitize(s.status || "unknown")}).`);
        if (Array.isArray(s.tags)) {
          for (const t of s.tags) session.consult(`story_tag(${id}, ${sanitize(t)}).`);
        }
      }
    }

    // Load @planner: annotations as deterministic facts
    try {
      const sourceFiles = walkDir(cwd, cwd).filter((filePath) => !isTestOrFixturePath(filePath));
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

    // Scan and assert configuration flags
    const configs = scanConfigFiles(cwd);
    const flags = extractFlags(configs);
    const flagNamesSeen = new Set();
    for (const f of flags) {
      session.consult(`config_flag(${sanitize(f.source)}, ${sanitize(f.name)}, ${f.value}).`);
      flagNamesSeen.add(f.name);
    }

    // CI-003 needs config_default/2: assert defaults for known config schemas.
    // Source: @planner:enabled_default annotations and documented defaults.
    try {
      const sourceFiles = walkDir(cwd, cwd).filter((filePath) => !isTestOrFixturePath(filePath));
      for (const sf of sourceFiles) {
        for (const ann of parseAnnotations(sf, cwd)) {
          if (ann.key === "enabled_default" && ann.values[0]) {
            const flagName = sf.replace(/[^a-zA-Z0-9_./-]/g, "_");
            session.consult(`config_default(${sanitize(flagName)}, ${ann.values[0].toLowerCase()}).`);
          }
          if (ann.key === "config_flag" && ann.values[0] && !flagNamesSeen.has(ann.values[0])) {
            // Documented flag with no runtime config_flag — assert as default
            session.consult(`config_default(${sanitize(ann.values[0])}, unknown).`);
          }
        }
      }
    } catch { /* annotation scan failure is non-fatal */ }

    // Assert mutual exclusions from defaults + project config
    const exclusions = [...DEFAULT_EXCLUSIONS];
    if (auditConfig.role_options && auditConfig.role_options.config_integrity) {
      const opts = auditConfig.role_options.config_integrity;
      if (Array.isArray(opts.mutual_exclusions)) {
        for (const ex of opts.mutual_exclusions) {
          if (Array.isArray(ex) && ex.length === 2) {
            exclusions.push(ex);
          }
        }
      }
    }

    for (const [a, b] of exclusions) {
      session.consult(`mutually_exclusive(${sanitize(a)}, ${sanitize(b)}).`);
      session.consult(`mutually_exclusive(${sanitize(b)}, ${sanitize(a)}).`);
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
      for (const ans of session.query("config_integrity_violation(RuleId, Subject, Detail, Severity)")) {
        rawFindings.push({
          ruleId:   String(ans.RuleId   || "CI-???"),
          subject:  String(ans.Subject  || "project"),
          detail:   String(ans.Detail   || ""),
          severity: String(ans.Severity || "MEDIUM"),
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
    const subjectSlug = String(raw.subject ?? "unknown").replace(/\W/g, "_");

    // v7.4.2: shape-conditional severity. CI-002 (capped metric without raw
    // value) HIGH on every plan was firing on metric refactors / docs work
    // that aren't changing the actual capping. CI-001 (mutually exclusive
    // flags both enabled) stays CRITICAL on all shapes — that's a real bug.
    const severity = shapeAwareSeverity({
      ruleId: raw.ruleId,
      defaultSeverity: raw.severity || SEVERITY.HIGH,
      planShape: context?.planShape,
      downgrades: {
        "CI-002": ["refactor", "docs"],
      },
    });

    // Build evidence message (Prolog returns subject/detail, JS composes message)
    const EVIDENCE_TEMPLATES = {
      "CI-001": (s, d) => `Mutually exclusive flags both enabled: ${s} + ${d}`,
      "CI-002": (s, d) => `Capped metric ${s} has no raw value available — downstream consumers see transformed data`,
      "CI-003": (s, d) => `Config flag ${s} has a default value but is never read by any code`,
    };
    const evidenceFn = EVIDENCE_TEMPLATES[raw.ruleId];
    const evidence = evidenceFn
      ? evidenceFn(raw.subject, raw.detail)
      : `${raw.ruleId} violation for ${raw.subject}`;

    return makeFinding({
      id:             `${raw.ruleId}-${subjectSlug}`,
      role:           this.id,
      severity,
      category:       "configuration_integrity",
      story_refs:     [],
      evidence,
      recommendation: rule.remediation || "Review configuration for conflicts and metric lineage issues.",
    });
  },

  // --- Optional v1.1 methods ---

  getPhaseGuidance(phase, _context) {
    const guidance = {
      explore: [
        "Inventory all configuration flags and their sources (config files, env vars, CLI args).",
        "Identify which flags are logically incompatible (e.g., temporal vs random splits).",
        "Check for metrics that are capped or transformed before reporting.",
      ],
      plan: [
        "Document which configuration flags the change will affect.",
        "If adding new flags, specify their mutual exclusions.",
        "Plan must include configuration validation step if touching config-related code.",
      ],
      execute: [
        "When adding boolean config flags, always check for mutual exclusions.",
        "When computing metrics with caps/floors, preserve the raw value alongside.",
        "Configuration changes must be tested with all flag combinations.",
      ],
      reflect: [
        "Verify no mutually exclusive flags are both enabled in production config.",
        "Confirm all reported metrics indicate whether they are raw or transformed.",
        "Check that configuration changes haven't introduced contradictions.",
      ],
    };
    const lines = guidance[phase];
    if (!lines || lines.length === 0) return null;
    return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
  },

  getPlanConstraints(context) {
    const constraints = [];

    // Check if project has config files
    const configs = scanConfigFiles(context.cwd);
    if (Object.keys(configs).length > 0) {
      constraints.push(makeConstraint({
        id: "CI-C-001",
        role: this.id,
        constraint: "Plan must document any new configuration flags and their mutual exclusions",
        severity: "MEDIUM",
        rationale: "Past incident (M-024): conflicting flags (walk-forward + CPCV shuffle) were both enabled, destroying temporal ordering.",
        story_refs: [],
      }));
    }

    return constraints;
  },
};

export default configIntegrityPack;
