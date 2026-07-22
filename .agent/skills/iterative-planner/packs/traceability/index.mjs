// packs/traceability/index.mjs — Traceability auditor persona pack.
//
// Purpose: Graph-level traceability from business goals to validated evidence.
// Catches "nobody built this" and "nobody proved this" failures by reasoning
// over the full goal → criterion → story → code → validation chain.
//
// This is the ontology audit layer described in Section G of
// iterative-planner-recommendations.md, implemented as Prolog rules
// instead of SPARQL (same reasoning power, no MCP dependency).
//
// Input sources:
//   - plan.md (goals, success criteria)
//   - story_registry.json (stories, code_refs, test_refs)
//   - @planner: annotations (proves, validation_module, story)
//   - red_team_notes.md (audit perspectives)
//   - verification.md (claimed results)
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
import { parseAnnotations, walkDir } from "../../scripts/annotation_parser.mjs";
import { serializeToFacts } from "../../scripts/ontology_serializer.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const RULES_FILE = join(__dirname, "rules.pl");

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

const RULE_DEFS = [
  {
    id: "TR-001",
    name: "Ungrounded success criterion",
    rationale: "A success criterion with no validation evidence is an unproven claim. The UFC/IPBS failure: 'model calibrated' was a criterion with zero calibration artifacts.",
    false_positive: "Criteria verified through manual process review (not code artifacts).",
    remediation: "Add a validation artifact (script, notebook, or test) that proves this criterion, and link it via @planner:proves or story validation_refs.",
    engine: "prolog",
  },
  {
    id: "TR-002",
    name: "Partial criterion (code but no validation)",
    rationale: "Code exists to implement the criterion but no artifact validates that the implementation actually works. This is the 'built but never tested' pattern.",
    false_positive: "Implementation covered by integration tests in a different story.",
    remediation: "Add output validation (not just unit tests) that verifies the criterion is met.",
    engine: "prolog",
  },
  {
    id: "TR-003",
    name: "Business goal at risk",
    rationale: "A goal has at least one ungrounded success criterion. The goal cannot be considered achieved until all its criteria have evidence.",
    false_positive: "Goals in early phases where criteria are being progressively validated.",
    remediation: "Ensure every criterion under this goal has a validation artifact with evidence.",
    engine: "prolog",
  },
  {
    id: "TR-004",
    name: "Orphan story (no traceability to goals)",
    rationale: "A story with code that doesn't trace to any business goal or success criterion. May indicate scope creep or incomplete traceability.",
    false_positive: "Infrastructure stories that support multiple goals indirectly.",
    remediation: "Link the story to a criterion via @planner:proves or add criterion_story mapping.",
    engine: "prolog",
  },
  {
    id: "TR-005",
    name: "Audit blind spot",
    rationale: "A known audit perspective was not covered in any red-team pass. Multiple UFC/IPBS passes all used the same code_correctness lens, missing calibration and wiring issues.",
    false_positive: "Perspectives not relevant to the current project domain.",
    remediation: "Add a red-team pass that explicitly covers the missing perspective.",
    engine: "prolog",
  },
  {
    id: "TR-006",
    name: "Verification claimed without evidence",
    rationale: "verification.md claims PASS for a criterion but no validation artifact exists to back it up. This catches rubber-stamped verification.",
    false_positive: "Criteria verified by manual review documented in verification.md notes.",
    remediation: "Add the validation artifact that was used to verify this criterion, or document the manual verification process.",
    engine: "prolog",
  },
];

// ---------------------------------------------------------------------------
// AuditorPack implementation
// ---------------------------------------------------------------------------

const traceabilityPack = {
  id: "traceability",

  applies(context) {
    const { auditConfig, planFiles } = context;

    // Explicit opt-in
    const roles = Array.isArray(auditConfig.roles) ? auditConfig.roles : [];
    if (roles.includes(this.id)) return true;

    // Auto-detect: any project with a plan that has success criteria
    if (planFiles && planFiles.plan) {
      if (/## Success Criteria/i.test(planFiles.plan)) return true;
      if (/## Goal/i.test(planFiles.plan)) return true;
    }

    // Auto-detect: any project with a story registry
    if (context.storyRegistry && Array.isArray(context.storyRegistry.stories)) {
      if (context.storyRegistry.stories.length > 0) return true;
    }

    return false;
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    const session = createSession();
    const { cwd, storyRegistry, planFiles } = context;
    const currentState = String(context.currentState || "").toLowerCase();
    const enforceAuditCoverage = currentState === "execute" || currentState === "reflect";

    // --- Load base story facts (same as other packs) ---
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      for (const s of storyRegistry.stories) {
        if (!s.id) continue;
        const id = sanitize(s.id);
        session.consult(`story(${id}, ${sanitize(s.title || "untitled")}, ${sanitize(s.priority || "medium")}, ${sanitize(s.status || "unknown")}).`);
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

    // --- Load @planner: annotations ---
    let annotations = [];
    try {
      const sourceFiles = walkDir(cwd, cwd);
      for (const f of sourceFiles) {
        annotations.push(...parseAnnotations(f, cwd));
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`[${this.id}] Annotation parse error: ${e.message}`);
    }

    // --- Run ontology serializer to get traceability facts ---
    let planDir = context.planDir || context.personaAuthorityContext?.plan_dir || null;
    let planContent = planFiles?.plan || null;
    const pointerFile = join(cwd, "plans", ".current_plan");
    if (!planDir && existsSync(pointerFile)) {
      try {
        const planDirName = readFileSync(pointerFile, "utf-8").trim();
        planDir = join(cwd, "plans", planDirName);
      } catch { /* skip */ }
    }

    const { facts: ontologyFacts, meta } = serializeToFacts({
      cwd,
      storyRegistry,
      planDir,
      planContent,
      annotations,
    });

    // Assert ontology facts into Prolog session
    try {
      session.consult(ontologyFacts);
    } catch (e) {
      return [{ _error: `Failed to load ontology facts: ${e.message}` }];
    }

    // --- Load traceability rules ---
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

    // --- Query violations ---
    const rawFindings = [];
    try {
      for (const ans of session.query("traceability_violation(RuleId, Subject, Detail, Severity)")) {
        rawFindings.push({
          ruleId:   String(ans.RuleId   || "TR-???"),
          subject:  String(ans.Subject  || "project"),
          detail:   String(ans.Detail   || ""),
          severity: String(ans.Severity || "HIGH"),
        });
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`[${this.id}] Prolog query error: ${e.message}`);
    }

    // Deduplicate: TR-003 fires once per ungrounded criterion for the same goal.
    // Collapse to one finding per goal with a count.
    const deduped = [];
    const seen = new Set();
    for (const f of rawFindings) {
      if (f.ruleId === "TR-005" && !enforceAuditCoverage) continue;
      const key = `${f.ruleId}:${f.subject}`;
      if (f.ruleId === "TR-003" || f.ruleId === "TR-004") {
        // Deduplicate: one finding per goal (TR-003) or per story (TR-004)
        if (seen.has(key)) continue;
        seen.add(key);
      }
      // TR-004 can be very noisy — cap at 10 examples + summary
      if (f.ruleId === "TR-004") {
        const tr004Count = deduped.filter(d => d.ruleId === "TR-004").length;
        if (tr004Count >= 10) {
          const remaining = rawFindings.filter(r => r.ruleId === "TR-004").length - 10;
          if (!seen.has("TR-004-summary") && remaining > 0) {
            seen.add("TR-004-summary");
            deduped.push({
              ruleId: "TR-004",
              subject: "project",
              detail: `${remaining} additional stories have no traceability to goals`,
              severity: "MEDIUM",
            });
          }
          continue;
        }
      }
      deduped.push(f);
    }

    // Attach serialization metadata for transparency
    if (deduped.length === 0 && meta.goals === 0 && meta.criteria === 0) {
      deduped.push({
        ruleId: "TR-INFO",
        subject: "project",
        detail: "No business goals or success criteria found in plan.md. Traceability audit requires a plan with ## Goal and ## Success Criteria sections.",
        severity: "INFO",
      });
    }

    return deduped;
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

    // v7.4.1: TR-005 (audit blind spot — perspective not covered) was firing
    // HIGH on every shape, including feature/integration/refactor/docs plans
    // where exhaustive perspective coverage is overkill. Downgrade to LOW for
    // shapes that don't need diagnosis-grade red-team breadth. bug-fix /
    // regression / migration / planner-core / unknown still see HIGH.
    const PERSPECTIVE_STRICT_SHAPES = new Set(["bug-fix", "regression", "migration", "planner-core", "unknown"]);
    let severity = raw.severity || SEVERITY.HIGH;
    if (raw.ruleId === "TR-005") {
      const shapePrimary = String(context?.planShape?.primary || "").toLowerCase();
      if (shapePrimary && !PERSPECTIVE_STRICT_SHAPES.has(shapePrimary)) {
        severity = SEVERITY.LOW;
      }
    }

    // Build human-readable evidence (Prolog engine lacks atom_concat,
    // so rules return subject + label and we compose the message here)
    const EVIDENCE_TEMPLATES = {
      "TR-001": (s, d) => `Success criterion has no validation evidence: ${d}`,
      "TR-002": (s, d) => `Criterion has code but no validation artifact: ${d}`,
      "TR-003": (s, d) => `Goal at risk — has ungrounded criterion: ${d}`,
      "TR-004": (s, d) => `Story has code but no traceability to goals: ${d}`,
      "TR-005": (s, d) => `Audit blind spot — no pass covered perspective: ${d}`,
      "TR-006": (s, d) => `Verification claims PASS but no validation artifact found: ${d}`,
      "TR-INFO": (s, d) => d,
    };
    const evidenceFn = EVIDENCE_TEMPLATES[raw.ruleId];
    const evidence = evidenceFn
      ? evidenceFn(raw.subject, raw.detail)
      : `${raw.ruleId} violation for ${raw.subject}: ${raw.detail}`;

    return makeFinding({
      id:             `${raw.ruleId}-${subjectSlug}`,
      role:           this.id,
      severity,
      category:       "traceability",
      story_refs:     raw.ruleId === "TR-004" ? [raw.subject] : [],
      evidence,
      recommendation: rule.remediation || "Ensure complete evidence chain from business goals to validated artifacts.",
    });
  },

  // --- Optional v1.1 methods ---

  getPhaseGuidance(phase, _context) {
    const guidance = {
      explore: [
        "Identify the business goals and success criteria for this project.",
        "For each criterion, note what validation artifact would prove it.",
        "Check: are there claims in the plan that lack evidence?",
      ],
      plan: [
        "Plan must include explicit success criteria with validation methods.",
        "Each criterion should map to at least one story.",
        "Plan should specify what validation artifacts will be created.",
        "Pre-mortem: 'If we claim success but it's actually broken, what did we miss?'",
      ],
      execute: [
        "When implementing a criterion, create the validation artifact alongside the code.",
        "Use @planner:proves annotations to link validation files to criteria.",
        "Don't defer validation to 'later' — build evidence as you go.",
      ],
      reflect: [
        "Verify every success criterion has a complete evidence chain: goal → criterion → code → validation.",
        "Check that red-team passes covered diverse perspectives (not just code correctness).",
        "Confirm verification.md claims are backed by actual artifacts.",
        "Run ontology serializer to see the full traceability graph.",
      ],
    };
    const lines = guidance[phase];
    if (!lines || lines.length === 0) return null;
    return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
  },

  getPlanConstraints(context) {
    const constraints = [];
    const { planFiles } = context;

    if (planFiles && planFiles.plan) {
      // Check if plan has success criteria
      if (/## Success Criteria/i.test(planFiles.plan)) {
        constraints.push(makeConstraint({
          id: "TR-C-001",
          role: this.id,
          constraint: "Every success criterion must have a planned validation artifact (not just tests)",
          severity: "HIGH",
          rationale: "Past incident: all criteria were 'verified' by tests that checked code correctness, not output quality. The UFC betting failure: model passed tests but produced uncalibrated probabilities.",
          story_refs: [],
        }));
      }

      if (/## Goal/i.test(planFiles.plan)) {
        constraints.push(makeConstraint({
          id: "TR-C-002",
          role: this.id,
          constraint: "Plan must trace every business goal through criteria to stories with code_refs",
          severity: "MEDIUM",
          rationale: "Untraced goals are aspirational statements with no implementation path. Ontology audit will flag them as AT_RISK.",
          story_refs: [],
        }));
      }
    }

    return constraints;
  },
};

export default traceabilityPack;
