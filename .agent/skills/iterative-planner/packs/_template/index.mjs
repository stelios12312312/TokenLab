// packs/_template/index.mjs — Skeleton persona pack.
//
// INSTRUCTIONS:
//   1. Copy this directory: cp -r packs/_template packs/<your_domain>
//   2. Rename the pack id below (must match /^[a-z][a-z0-9_]*$/)
//   3. Update applies() with your domain's detection signals
//   4. Define rules in rules.pl (or implement JS-only checks in audit())
//   5. Add "<your_domain>" to roles in audit.config.json
//   6. Test: node scripts/audit_runner.mjs --pack <your_domain>
//
// AuditorPack contract (v1.1):
//   Required: id, applies, rules, audit, normalizeFinding
//   Optional: getPhaseGuidance, getPlanConstraints

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createSession } from "../../scripts/lib/prolog.mjs";
import { makeFinding, makeConstraint, SEVERITY } from "../../scripts/lib/audit_types.mjs";

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = dirname(__filename);
const RULES_FILE  = join(__dirname, "rules.pl");

// ---------------------------------------------------------------------------
// Domain keywords — used for story text matching and auto-detection
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS = [
  // TODO: Add keywords relevant to your domain
  // e.g., "caching", "latency", "throughput", "sla"
];

// ---------------------------------------------------------------------------
// Prolog atom sanitizer
// ---------------------------------------------------------------------------

function sanitize(str) {
  const s = String(str || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").toLowerCase();
  return `'${s}'`;
}

// ---------------------------------------------------------------------------
// Rule definitions (metadata only — actual logic lives in rules.pl)
// ---------------------------------------------------------------------------

const RULE_DEFS = [
  // TODO: Define your rules. Each entry is metadata — the logic lives in rules.pl.
  // {
  //   id: "MY-001",
  //   name: "Example check",
  //   rationale: "Why this rule matters for your domain.",
  //   false_positive: "When this rule might fire incorrectly.",
  //   remediation: "How to fix violations.",
  //   engine: "prolog",  // or "js" for JavaScript-only checks
  // },
];

// ---------------------------------------------------------------------------
// AuditorPack implementation
// ---------------------------------------------------------------------------

const myDomainPack = {
  // TODO: Change this to your domain name (must match directory name)
  id: "my_domain",

  applies(context) {
    const { storyRegistry, auditConfig, planFiles, cwd } = context;

    // Explicit opt-in via audit.config.json roles
    const roles = Array.isArray(auditConfig.roles) ? auditConfig.roles : [];
    if (roles.includes(this.id)) return true;

    // Auto-detect from story registry keywords
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
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

    // TODO: Add more detection signals (dependency manifests, config files, etc.)

    return false;
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    const session = createSession();

    // Re-assert base story facts
    if (context.storyRegistry && Array.isArray(context.storyRegistry.stories)) {
      for (const s of context.storyRegistry.stories) {
        if (!s.id) continue;
        const id = sanitize(s.id);
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

    // TODO: Collect domain-specific facts into the Prolog session
    // e.g., session.consult(`my_fact(${sanitize(value)}).`);

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

    // Query violations — update the predicate name to match your rules.pl
    const rawFindings = [];
    try {
      for (const ans of session.query("my_domain_violation(RuleId, Subject, Detail, Severity)")) {
        rawFindings.push({
          ruleId:   String(ans.RuleId   || "MY-???"),
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

  normalizeFinding(raw) {
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

    return makeFinding({
      id:             `${raw.ruleId}-${subjectSlug}`,
      role:           this.id,
      severity:       raw.severity || SEVERITY.MEDIUM,
      category:       raw.ruleId ? raw.ruleId.toLowerCase() : this.id,
      story_refs:     isStoryRef ? [raw.subject] : [],
      evidence:       raw.detail || `${raw.ruleId} violation for ${raw.subject}`,
      recommendation: rule.remediation || `See ${this.id} pack documentation.`,
    });
  },

  // --- Optional v1.1 methods ---

  getPhaseGuidance(phase, _context) {
    // TODO: Return domain-specific guidance strings per phase.
    // Return null for phases where your domain has no special guidance.
    const guidance = {
      explore: [
        // "Check for X in the codebase.",
        // "Look for Y patterns in dependencies.",
      ],
      plan: [
        // "Include a step for Z verification.",
        // "Ensure acceptance criteria cover W.",
      ],
      execute: [
        // "Always do A before B.",
        // "Watch out for C when implementing D.",
      ],
      reflect: [
        // "Verify that E is present in the output.",
        // "Confirm F meets the threshold.",
      ],
    };
    const lines = guidance[phase];
    if (!lines || lines.length === 0) return null;
    return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
  },

  getPlanConstraints(context) {
    const constraints = [];
    // TODO: Analyze context and return domain-specific constraints.
    // Example:
    // constraints.push(makeConstraint({
    //   id: "MY-C-001",
    //   role: this.id,
    //   constraint: "Plan must include a performance benchmark step",
    //   severity: "MEDIUM",
    //   rationale: "Performance-critical stories require baseline measurements before optimization",
    //   story_refs: [],
    // }));
    return constraints;
  },
};

export default myDomainPack;
