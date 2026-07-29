// packs/_template/index.mjs - Skeleton persona pack.
//
// INSTRUCTIONS:
//   1. Copy this directory: cp -r packs/_template packs/<your_domain>
//   2. Rename the pack id below (must match /^[a-z][a-z0-9_]*$/)
//   3. Update applies() with your domain's detection signals
//   4. Define rules in rules.pl or add JS-only checks in audit()
//   5. Add "<your_domain>" to roles in audit.config.json
//   6. Test: node scripts/audit_runner.mjs --pack <your_domain>

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { makeConstraint, SEVERITY } from "../../scripts/lib/audit_types.mjs";
import { sanitizeAtom as sanitize } from "../../scripts/lib/sanitize.mjs";
import {
  assertStoryFacts,
  formatPhaseGuidance,
  normalizePackFinding,
  runPrologPackAudit,
} from "../../scripts/lib/auditor_pack_engine.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RULES_FILE = join(__dirname, "rules.pl");

const DOMAIN_KEYWORDS = [
  // TODO: Add keywords relevant to your domain.
  // e.g., "caching", "latency", "throughput", "sla"
];

const RULE_DEFS = [
  // TODO: Define rule metadata. The predicate logic normally lives in rules.pl.
  // {
  //   id: "MY-001",
  //   name: "Example check",
  //   rationale: "Why this rule matters for your domain.",
  //   false_positive: "When this rule might fire incorrectly.",
  //   remediation: "How to fix violations.",
  //   engine: "prolog",
  // },
];

const PHASE_GUIDANCE = {
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

function storyText(story) {
  return [story.title || "", ...(story.tags || []), ...(story.postconditions || [])]
    .join(" ")
    .toLowerCase();
}

const myDomainPack = {
  id: "my_domain",

  applies(context) {
    const roles = Array.isArray(context.auditConfig?.roles) ? context.auditConfig.roles : [];
    if (roles.includes(this.id)) return true;

    const stories = Array.isArray(context.storyRegistry?.stories) ? context.storyRegistry.stories : [];
    if (stories.some((story) => DOMAIN_KEYWORDS.some((keyword) => storyText(story).includes(keyword)))) return true;

    const planText = Object.values(context.planFiles || {}).join(" ").toLowerCase();
    return DOMAIN_KEYWORDS.some((keyword) => planText.includes(keyword));
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    return runPrologPackAudit(context, {
      packId: this.id,
      rulesFile: RULES_FILE,
      query: "my_domain_violation(RuleId, Subject, Detail, Severity)",
      defaultRuleId: "MY-???",
      defaultSeverity: SEVERITY.MEDIUM,
      collectFacts: (ctx, session) => {
        assertStoryFacts(session, ctx.storyRegistry, {
          sanitize,
          include: ["tags", "code_refs", "test_refs", "postconditions"],
          rawPostconditions: true,
        });
        // TODO: Collect domain-specific facts into the Prolog session.
        // e.g., session.consult(`my_fact(${sanitize(value)}).`);
      },
    });
  },

  normalizeFinding(raw, context) {
    return normalizePackFinding(raw, context, {
      packId: this.id,
      rules: RULE_DEFS,
      defaultSeverity: SEVERITY.MEDIUM,
      category: (finding) => finding.ruleId ? finding.ruleId.toLowerCase() : this.id,
      fallbackRecommendation: `See ${this.id} pack documentation.`,
    });
  },

  getPhaseGuidance(phase, _context) {
    return formatPhaseGuidance(PHASE_GUIDANCE, phase);
  },

  getPlanConstraints(_context) {
    const constraints = [];
    // TODO: Analyze context and return domain-specific constraints.
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
