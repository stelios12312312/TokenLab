// packs/wiring_auditor/index.mjs — Wiring Auditor persona pack.
//
// Purpose: Catches "build-but-never-wire" failures (HR-001, HR-002).
// Detects validation modules that exist but are not connected to the
// pipeline, or are disabled by default without justification.
//
// Derived from Evolution Trader M-022: 7 anti-overfit modules were
// built with tests and docstrings but never called from the pipeline.
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
// Domain keywords — signals that wiring audit is relevant
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS = [
  "validation", "validator", "checker", "check", "gate", "gauntlet",
  "guard", "verify", "verifier", "sanitize", "sanitizer", "filter",
];

// Directories that typically contain validation/checking modules
const VALIDATION_DIRS = [
  "validation", "validators", "checks", "gates", "guards",
  "core/validation", "src/validation", "lib/validation",
];

const CODE_FILE_RE = /\.(py|mjs|js|ts)$/;
const VALIDATION_PATH_SEGMENTS = new Set(["validation", "validators", "checks", "gates", "guards"]);
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
// Rule definitions
// ---------------------------------------------------------------------------

const RULE_DEFS = [
  {
    id: "WR-001",
    name: "Unwired validation module",
    rationale: "Validation modules that exist but are never called from the pipeline provide no protection. This was the root cause of Evolution Trader M-022 where 7 anti-overfit modules were built but never connected.",
    false_positive: "Utility modules in validation directories that are legitimately standalone tools (not pipeline checks).",
    remediation: "Wire the module into the relevant pipeline stage. If intentionally standalone, move it out of the validation directory.",
    engine: "prolog",
  },
  {
    id: "WR-002",
    name: "Validation disabled by default",
    rationale: "Validation checks with enabled=False defaults tend to stay disabled forever. 'Skip in discovery' comments become permanent accidents.",
    false_positive: "Checks that are genuinely only needed for specific project types and are auto-enabled by domain detection.",
    remediation: "Change the default to enabled=True, or add a disable_justification with an expiry date.",
    engine: "prolog",
  },
  {
    id: "WR-003",
    name: "Disabled check without expiry",
    rationale: "Even justified disabled checks need a review date to prevent them from being forgotten permanently.",
    false_positive: "Checks disabled for a known permanent architectural reason.",
    remediation: "Add a disable_expiry date when the disabled check should be re-evaluated.",
    engine: "prolog",
  },
  {
    id: "WR-004",
    name: "Output-critical story without validation_ref",
    rationale: "Stories tagged as output-critical must have validation artifacts that verify the output quality, not just code correctness.",
    false_positive: "Stories where output validation is handled by a downstream story.",
    remediation: "Add a validation_ref pointing to a script or notebook that validates the output.",
    engine: "prolog",
  },
];

// ---------------------------------------------------------------------------
// Scan project for validation modules and their consumers
// ---------------------------------------------------------------------------

function isCodeFile(filePath) {
  return CODE_FILE_RE.test(filePath);
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

function isProductionCodeFile(filePath) {
  return isCodeFile(filePath) && !isTestOrFixturePath(filePath);
}

function isValidationPath(filePath) {
  const segments = filePath.split("/");
  return segments.some(segment => VALIDATION_PATH_SEGMENTS.has(segment));
}

function scanValidationModules(sourceFiles) {
  return sourceFiles.filter(filePath => isProductionCodeFile(filePath) && isValidationPath(filePath));
}

function getAnnotatedValidationModules(allAnnotations) {
  const modules = new Set();
  for (const ann of allAnnotations) {
    if (!ann?.error && ann?.key === "validation_module" && ann.file && !isTestOrFixturePath(ann.file)) {
      modules.add(ann.file);
    }
  }
  return modules;
}

function scanForImports(cwd, modulePath, sourceFiles) {
  // Simple grep-style check: does any file import/require this module?
  const moduleName = modulePath.replace(/\.[^.]+$/, "").replace(/\//g, ".");
  const baseName = modulePath.split("/").pop().replace(/\.[^.]+$/, "");

  // Check common import patterns
  const patterns = [baseName, modulePath, moduleName];
  for (const filePath of sourceFiles) {
    if (!isCodeFile(filePath) || filePath === modulePath) continue;
    try {
      const content = readFileSync(join(cwd, filePath), "utf-8");
      for (const pat of patterns) {
        if (content.includes(pat)) return true;
      }
    } catch { /* skip inaccessible */ }
  }
  return false;
}

function scanForCliEntrypoint(cwd, modulePath) {
  const fullPath = join(cwd, modulePath);
  if (!existsSync(fullPath)) return false;
  try {
    const content = readFileSync(fullPath, "utf-8");
    return /^#!.*\b(env|node|python|python3|bash|sh)\b/m.test(content) ||
      /if\s+__name__\s*==\s*["']__main__["']\s*:/.test(content) ||
      /require\.main\s*===\s*module/.test(content) ||
      /import\.meta\.url\s*===/.test(content) ||
      /\bprocess\.argv\b/.test(content);
  } catch {
    return false;
  }
}

function scanForDisabledDefaults(cwd, modulePath) {
  const fullPath = join(cwd, modulePath);
  if (!existsSync(fullPath)) return null;
  try {
    const content = readFileSync(fullPath, "utf-8");
    // Check for common disabled-by-default patterns
    const disabledPatterns = [
      /enabled\s*[=:]\s*False/i,
      /skip\s*[=:]\s*True/i,
      /run_\w+\s*[=:]\s*False/i,
      /disabled\s*[=:]\s*True/i,
      /=\s*False\s*#.*skip/i,
      /=\s*False\s*#.*default/i,
    ];
    for (const pat of disabledPatterns) {
      if (pat.test(content)) return true;
    }
  } catch { /* skip */ }
  return false;
}

// ---------------------------------------------------------------------------
// AuditorPack implementation
// ---------------------------------------------------------------------------

const wiringAuditorPack = {
  id: "wiring_auditor",

  applies(context) {
    const { storyRegistry, auditConfig, cwd } = context;

    // Explicit opt-in via audit.config.json roles
    const roles = Array.isArray(auditConfig.roles) ? auditConfig.roles : [];
    if (roles.includes(this.id)) return true;

    // Auto-detect: does the project have validation directories?
    for (const dir of VALIDATION_DIRS) {
      if (existsSync(join(cwd, dir))) return true;
    }

    // Auto-detect from story registry keywords
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      const storyMatch = storyRegistry.stories.some(s => {
        const text = [s.title || "", ...(s.tags || [])].join(" ").toLowerCase();
        return DOMAIN_KEYWORDS.some(kw => text.includes(kw));
      });
      if (storyMatch) return true;
    }

    return false;
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    const session = createSession();
    const { cwd, storyRegistry } = context;
    const sourceFiles = walkDir(cwd, cwd);
    const codeFiles = sourceFiles.filter(isCodeFile);
    const productionCodeFiles = sourceFiles.filter(isProductionCodeFile);
    const allAnnotations = [];

    // Re-assert base story facts
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      for (const s of storyRegistry.stories) {
        if (!s.id) continue;
        const id = sanitize(s.id);
        session.consult(`story(${id}, ${sanitize(s.title || "untitled")}, ${sanitize(s.priority || "medium")}, ${sanitize(s.status || "unknown")}).`);
        if (Array.isArray(s.tags)) {
          for (const t of s.tags) {
            session.consult(`story_tag(${id}, ${sanitize(t)}).`);
          }
        }
        if (Array.isArray(s.validation_refs)) {
          for (const v of s.validation_refs) {
            session.consult(`validation_ref(${id}, ${sanitize(v)}).`);
          }
        }
        if (Array.isArray(s.code_refs)) {
          for (const c of s.code_refs) {
            session.consult(`code_ref(${id}, ${sanitize(c)}).`);
          }
        }
        if (Array.isArray(s.test_refs)) {
          for (const t of s.test_refs) {
            session.consult(`test_ref(${id}, ${sanitize(t)}).`);
          }
        }
      }
    }

    // Load @planner: annotations as deterministic facts (highest priority)
    try {
      for (const f of productionCodeFiles) {
        allAnnotations.push(...parseAnnotations(f, cwd));
      }
      const prologFacts = toPrologFacts(allAnnotations);
      if (prologFacts) {
        session.consult(prologFacts);
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`[${this.id}] Annotation parse error: ${e.message}`);
    }

    // Scan project for validation modules and assert facts (heuristic fallback)
    // Annotations take precedence — heuristic scan fills gaps for unannotated files
    const modules = new Set(scanValidationModules(productionCodeFiles));
    const annotatedValidationModules = getAnnotatedValidationModules(allAnnotations);
    for (const mod of annotatedValidationModules) {
      modules.add(mod);
    }
    for (const mod of [...modules].sort()) {
      if (!annotatedValidationModules.has(mod)) {
        session.consult(`validation_module(${sanitize(mod)}).`);
      }

      if (scanForImports(cwd, mod, productionCodeFiles) || scanForCliEntrypoint(cwd, mod)) {
        session.consult(`module_has_live_consumer(${sanitize(mod)}).`);
      }

      const isDisabled = scanForDisabledDefaults(cwd, mod);
      if (isDisabled === true) {
        session.consult(`module_default_enabled(${sanitize(mod)}, false).`);
        // WR-003 needs validation_check(Module, disabled) to fire
        session.consult(`validation_check(${sanitize(mod)}, disabled).`);
      } else if (isDisabled === false) {
        session.consult(`module_default_enabled(${sanitize(mod)}, true).`);
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
      for (const ans of session.query("wiring_auditor_violation(RuleId, Subject, Detail, Severity)")) {
        rawFindings.push({
          ruleId:   String(ans.RuleId   || "WR-???"),
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

    // v7.4.2: shape-conditional severity downgrade. WR-004 (output-critical
    // story without validation_ref) shouldn't FAIL gate transitions on plans
    // that aren't producing new outputs (refactor, docs).
    const severity = shapeAwareSeverity({
      ruleId: raw.ruleId,
      defaultSeverity: raw.severity || SEVERITY.HIGH,
      planShape: context?.planShape,
      downgrades: {
        "WR-004": ["refactor", "docs"],
      },
    });
    const isStoryRef = raw.subject !== "project" && raw.subject !== "unknown";
    const subjectSlug = String(raw.subject ?? "unknown").replace(/\W/g, "_");

    // Build evidence message (Prolog returns subject/detail, JS composes message)
    const EVIDENCE_TEMPLATES = {
      "WR-001": (s, d) => `Validation module ${s} is built but not wired to any pipeline`,
      "WR-002": (s, d) => `Validation module ${s} is disabled by default with no justification`,
      "WR-003": (s, d) => `Disabled check ${s} has justification but no expiry date for review`,
      "WR-004": (s, d) => `Output-critical story ${d} has no validation_ref artifact`,
    };
    const evidenceFn = EVIDENCE_TEMPLATES[raw.ruleId];
    const evidence = evidenceFn
      ? evidenceFn(raw.subject, raw.detail)
      : `${raw.ruleId} violation for ${raw.subject}`;

    return makeFinding({
      id:             `${raw.ruleId}-${subjectSlug}`,
      role:           this.id,
      severity,
      category:       "infrastructure_wiring",
      story_refs:     isStoryRef ? [raw.subject] : [],
      evidence,
      recommendation: rule.remediation || "Wire the module into the pipeline or document why it's intentionally disconnected.",
    });
  },

  // --- Optional v1.1 methods ---

  getPhaseGuidance(phase, _context) {
    const guidance = {
      explore: [
        "Inventory all files in validation/, checks/, gates/ directories.",
        "For each validation module, trace where it is imported from.",
        "Check for enabled=False or skip=True defaults in validation configs.",
      ],
      plan: [
        "Every new validation module must specify its pipeline integration point.",
        "Plan must document which validation checks will be enabled and why.",
        "If disabling any check, include justification and expiry date in plan.",
      ],
      execute: [
        "After implementing any validation module, verify it is called from the pipeline.",
        "Never commit a validation check with enabled=False without a tracked expiry.",
        "Run 'grep -r enabled.*False' on validation directories before completing.",
      ],
      reflect: [
        "Verify every validation module has at least one caller in the pipeline.",
        "Confirm no validation checks were accidentally left disabled.",
        "Check that new modules added during execution have consumers.",
      ],
    };
    const lines = guidance[phase];
    if (!lines || lines.length === 0) return null;
    return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
  },

  getPlanConstraints(context) {
    const constraints = [];
    const { cwd } = context;

    // Check if project has validation directories
    const hasValidationDirs = VALIDATION_DIRS.some(dir => existsSync(join(cwd, dir)));
    if (hasValidationDirs) {
      constraints.push(makeConstraint({
        id: "WR-C-001",
        role: this.id,
        constraint: "Plan must include a wiring verification step confirming all validation modules have pipeline consumers",
        severity: "HIGH",
        rationale: "Past incident (M-022): 7 anti-overfit modules were built but never connected to the search pipeline, resulting in 1/49 gauntlet pass rate.",
        story_refs: [],
      }));
    }

    return constraints;
  },
};

export default wiringAuditorPack;
