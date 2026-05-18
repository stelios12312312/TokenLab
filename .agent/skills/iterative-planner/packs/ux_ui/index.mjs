// packs/ux_ui/index.mjs — UX/UI role auditor pack.
//
// Checks (v1 — 4 rules max):
//   UX-001  Accessibility baseline coverage (a11y story presence, keyboard/contrast)
//   UX-002  Critical flow consistency (HIGH priority flows have code + test coverage)
//   UX-003  Error state usability coverage (form/modal stories have error postconditions)
//   UX-004  Interaction consistency (conflicting state postconditions between UX stories)
//
// Collector pattern:
//   1. Grep story titles/tags for UX keywords → story_mentions/2 facts
//   2. Load ux_metadata.json if present → ux_meta/2 facts + critical flow facts
//   3. Run Prolog rules → ux_violation/4 query
//   4. Normalize findings to shared schema

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createSession } from "../../scripts/lib/prolog.mjs";
import { makeFinding, makeConstraint, SEVERITY } from "../../scripts/lib/audit_types.mjs";
import { downgradeForShape as shapeAwareSeverity } from "../../scripts/lib/pack_severity.mjs";

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = dirname(__filename);
const RULES_FILE  = join(__dirname, "rules.pl");

// ---------------------------------------------------------------------------
// UX/UI keywords for story text grep
// ---------------------------------------------------------------------------

const UX_KEYWORDS = [
  "keyboard", "contrast", "screen_reader", "screenreader", "aria",
  "focus", "a11y", "accessibility", "wcag",
  "form", "modal", "dialog", "input", "button",
  "navigation", "menu", "breadcrumb",
  "error_state", "validation", "empty_state",
  "tooltip", "dropdown", "carousel",
  "frontend", "responsive", "mobile", "viewport", "screenshot",
];

// ---------------------------------------------------------------------------
// Collector: extract facts from stories and metadata file
// ---------------------------------------------------------------------------

function collectUxFacts(context, session) {
  const { storyRegistry, cwd, auditConfig } = context;
  const roleOptions = (auditConfig.role_options || {}).ux_ui || {};

  // 1. Grep story text for UX keywords → story_mentions/2
  if (storyRegistry && Array.isArray(storyRegistry.stories)) {
    for (const story of storyRegistry.stories) {
      const haystack = [
        story.id || "",
        story.title || "",
        ...(story.postconditions || []),
        ...(story.preconditions || []),
        ...(story.tags || []),
      ].join(" ").toLowerCase();

      for (const kw of UX_KEYWORDS) {
        const normalized = kw.replace(/_/g, " ");  // match "screen reader" and "screen_reader"
        if (haystack.includes(kw) || haystack.includes(normalized)) {
          // sanitize() returns a quoted atom — no extra quotes needed
          session.consult(`story_mentions(${sanitize(story.id)}, ${sanitize(kw)}).`);
        }
      }
    }
  }

  // 2. Load ux_metadata.json if present
  const metaPaths = [
    join(cwd, "ux_metadata.json"),
    join(cwd, ".agent", "ux_metadata.json"),
    join(cwd, "plans", "knowledge", "ux_metadata.json"),
  ];

  for (const mp of metaPaths) {
    if (existsSync(mp)) {
      let meta;
      try {
        meta = JSON.parse(readFileSync(mp, "utf-8"));
      } catch { continue; }

      // A11y standard
      if (meta.a11y_standard) {
        session.consult(`ux_meta(a11y_standard, ${sanitize(meta.a11y_standard)}).`);
      }
      if (meta.has_a11y_audit === true) {
        session.consult("ux_meta(has_a11y_audit, true).");
      }

      // Critical flows: [{ id: "checkout", story_id: "us_005" }, ...]
      if (Array.isArray(meta.critical_flows)) {
        for (const flow of meta.critical_flows) {
          if (flow.id && flow.story_id) {
            session.consult(`ux_critical_flow(${sanitize(flow.id)}, ${sanitize(flow.story_id)}).`);
          }
        }
      }

      // Excluded flows (suppress UX-001/UX-002 for intentionally out-of-scope flows)
      if (Array.isArray(meta.excluded_flows)) {
        for (const f of meta.excluded_flows) {
          session.consult(`ux_excluded_flow(${sanitize(f)}).`);
        }
      }
      break; // use first found
    }
  }

  // 3. Apply role config overrides
  if (Array.isArray(roleOptions.critical_flows)) {
    for (const flow of roleOptions.critical_flows) {
      if (flow.id && flow.story_id) {
        session.consult(`ux_critical_flow(${sanitize(flow.id)}, ${sanitize(flow.story_id)}).`);
      }
    }
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

// ---------------------------------------------------------------------------
// Rule definitions (metadata only)
// ---------------------------------------------------------------------------

const RULE_DEFS = [
  {
    id: "UX-001",
    name: "Accessibility baseline coverage",
    rationale: "Products without a11y baseline risk legal exposure (WCAG, ADA) and exclude users with disabilities.",
    false_positive: "Internal tooling not subject to public a11y standards.",
    remediation: "Add an a11y audit story covering keyboard navigation and colour contrast. Set has_a11y_audit: true in ux_metadata.json once complete.",
    engine: "prolog",
  },
  {
    id: "UX-002",
    name: "Critical flow consistency",
    rationale: "High-priority UX journeys must have code implementation and test coverage to prevent regressions.",
    false_positive: "Flows intentionally excluded from scope — document in ux_metadata.json `excluded_flows`.",
    remediation: "Add code_refs and test_refs to HIGH priority UX stories.",
    engine: "prolog",
  },
  {
    id: "UX-003",
    name: "Error state usability coverage",
    rationale: "Missing error states in forms and modals produce confusing UX and are a common bug source.",
    false_positive: "Read-only views, pure display components with no user input.",
    remediation: "Add `error_state(...)` or `validation_error(...)` postconditions to interactive stories.",
    engine: "prolog",
  },
  {
    id: "UX-004",
    name: "Interaction consistency",
    rationale: "Conflicting state postconditions between UX stories signal interaction design contradictions.",
    false_positive: "Intentional multi-mode UIs (progressive disclosure, mode switching).",
    remediation: "Reconcile the conflicting state changes or document the intentional divergence.",
    engine: "prolog",
  },
];

// ---------------------------------------------------------------------------
// AuditorPack implementation
// ---------------------------------------------------------------------------

const uxUiPack = {
  id: "ux_ui",

  applies(context) {
    const { storyRegistry, auditConfig, planFiles, cwd } = context;
    // Explicit opt-in via roles config
    const roles = Array.isArray(auditConfig.roles) ? auditConfig.roles : [];
    if (roles.includes("ux_ui")) return true;

    // Auto-detect from story registry keywords
    if (storyRegistry && Array.isArray(storyRegistry.stories)) {
      const storyMatch = storyRegistry.stories.some(s => {
        const text = [s.title || "", ...(s.tags || []), ...(s.postconditions || [])].join(" ").toLowerCase();
        return UX_KEYWORDS.some(kw => text.includes(kw) || text.includes(kw.replace(/_/g, " ")));
      });
      if (storyMatch) return true;
    }

    // Auto-detect from plan files (findings, plan, decisions)
    if (planFiles) {
      const planText = Object.values(planFiles).join(" ").toLowerCase();
      if (UX_KEYWORDS.some(kw => planText.includes(kw))) return true;
    }

    // Auto-detect from project metadata files
    const metaPaths = [
      join(cwd, "ux_metadata.json"),
      join(cwd, ".agent", "ux_metadata.json"),
      join(cwd, "plans", "knowledge", "ux_metadata.json"),
    ];
    if (metaPaths.some(p => existsSync(p))) return true;

    // Auto-detect from frontend framework config files or UI deps in package.json
    const strongSignals = ["next.config.js", "next.config.mjs",
      "vite.config.ts", "vite.config.js", "angular.json", ".storybook"];
    if (strongSignals.some(f => existsSync(join(cwd, f)))) return true;

    // Check for UI framework deps in package.json (parsed, not substring)
    const uiLibs = ["react", "vue", "angular", "svelte", "next", "nuxt", "gatsby",
      "tailwindcss", "@chakra-ui", "@material-ui", "@mui", "antd", "@radix-ui",
      "styled-components", "@emotion", "sass"];
    try {
      const pkgPath = join(cwd, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const allDeps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}))
          .map(d => d.toLowerCase());
        if (uiLibs.some(lib => allDeps.some(dep => dep === lib || dep.startsWith(lib + "/")))) return true;
      }
    } catch { /* ignore parse errors */ }

    return false;
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    // Own session to avoid polluting shared state
    const session = createSession();

    // Re-assert base story facts
    if (context.storyRegistry && Array.isArray(context.storyRegistry.stories)) {
      for (const s of context.storyRegistry.stories) {
        if (!s.id) continue;
        // sanitize() returns a quoted atom — use directly without extra quotes
        const id = sanitize(s.id);
        session.consult(`story(${id}, ${sanitize(s.title || "untitled")}, ${sanitize(s.priority || "medium")}, ${sanitize(s.status || "unknown")}).`);
        if (Array.isArray(s.code_refs)) {
          for (const ref of s.code_refs)
            session.consult(`code_ref(${id}, ${sanitize(ref)}).`);
        }
        if (Array.isArray(s.test_refs)) {
          for (const ref of s.test_refs)
            session.consult(`test_ref(${id}, ${sanitize(ref)}).`);
        }
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

    // Collect UX-specific facts
    collectUxFacts(context, session);

    // Load Prolog rules
    let rulesText;
    try {
      rulesText = readFileSync(RULES_FILE, "utf-8");
    } catch (e) {
      return [{ _error: `Could not load ux_ui rules.pl: ${e.message}` }];
    }

    try {
      session.consult(rulesText);
    } catch (e) {
      return [{ _error: `Failed to load ux_ui Prolog rules: ${e.message}` }];
    }

    // Query all violations
    const rawFindings = [];
    try {
      for (const ans of session.query("ux_violation(RuleId, Subject, Detail, Severity)")) {
        rawFindings.push({
          ruleId:   String(ans.RuleId   || "UX-???"),
          subject:  String(ans.Subject  || "project"),
          detail:   String(ans.Detail   || ""),
          severity: String(ans.Severity || "MEDIUM"),
        });
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`[ux_ui] Prolog query error: ${e.message}`);
    }

    return rawFindings;
  },

  getPhaseGuidance(phase, _context) {
    const guidance = {
      explore: [
        "Identify all interactive components (forms, modals, dropdowns) and check for error state documentation.",
        "Look for accessibility markers (ARIA attributes, keyboard handlers, focus management) in existing code.",
        "Check if critical user flows are documented and have corresponding test coverage.",
        "Scan for colour contrast issues — look for hardcoded colour values without contrast ratio checks.",
      ],
      plan: [
        "Include accessibility audit as an explicit plan step — keyboard navigation and colour contrast at minimum.",
        "Every interactive story (form, modal, dialog) must address error states in its acceptance criteria.",
        "Plan must list critical user flows and specify test coverage for each.",
        "If new UI components are introduced, include a visual consistency check step with screenshot artifacts for relevant desktop and mobile viewports.",
        "Ensure empty states and loading states are covered for data-dependent views.",
      ],
      execute: [
        "Add ARIA labels and roles to all interactive elements — screen readers cannot infer intent from visual layout.",
        "Implement keyboard navigation for all interactive flows — Tab order, Enter/Space activation, Escape to close.",
        "Always handle error states explicitly — show user-friendly messages, preserve form input on validation failure.",
        "Test with browser zoom at 200% and capture screenshots for the changed user-visible states.",
        "Use semantic HTML elements (button, nav, main, aside) instead of generic divs with click handlers.",
      ],
      reflect: [
        "Verify all critical flows are keyboard-navigable end-to-end and attach browser screenshots or trace artifacts for the changed states.",
        "Check that error states render correctly and preserve user input.",
        "Confirm colour contrast meets WCAG AA (4.5:1 for normal text, 3:1 for large text).",
        "Validate that all interactive elements have visible focus indicators.",
        "Check that loading and empty states render appropriately for data-dependent views.",
      ],
    };
    const lines = guidance[phase];
    return lines ? lines.map((l, i) => `${i + 1}. ${l}`).join("\n") : null;
  },

  getPlanConstraints(context) {
    const constraints = [];
    const { storyRegistry } = context;
    const stories = (storyRegistry && Array.isArray(storyRegistry.stories)) ? storyRegistry.stories : [];

    // Check if UI stories exist but no a11y story
    const hasUiStories = stories.some(s => {
      const text = [s.title || "", ...(s.tags || [])].join(" ").toLowerCase();
      return UX_KEYWORDS.some(kw => text.includes(kw));
    });

    const hasA11yStory = stories.some(s => {
      const text = [s.title || "", ...(s.tags || []), ...(s.postconditions || [])].join(" ").toLowerCase();
      return text.includes("a11y") || text.includes("accessibility") || text.includes("wcag");
    });

    if (hasUiStories && !hasA11yStory) {
      constraints.push(makeConstraint({
        id: "UX-C-001",
        role: "ux_ui",
        constraint: "Plan must include an accessibility audit step (keyboard navigation + colour contrast at minimum)",
        severity: "HIGH",
        rationale: "UI stories detected without any accessibility coverage — risk of legal exposure (WCAG/ADA) and excluded users",
        story_refs: [],
      }));
    }

    // Check if form/modal stories exist without error state mentions
    const interactiveStories = stories.filter(s => {
      const text = [s.title || "", ...(s.tags || [])].join(" ").toLowerCase();
      return text.includes("form") || text.includes("modal") || text.includes("dialog") || text.includes("input");
    });

    const interactiveWithoutErrors = interactiveStories.filter(s => {
      const text = [s.title || "", ...(s.postconditions || []), ...(s.tags || [])].join(" ").toLowerCase();
      return !text.includes("error") && !text.includes("validation");
    });

    if (interactiveWithoutErrors.length > 0) {
      constraints.push(makeConstraint({
        id: "UX-C-002",
        role: "ux_ui",
        constraint: "Interactive stories must address error states in their acceptance criteria",
        severity: "MEDIUM",
        rationale: "Forms/modals without explicit error handling produce confusing UX and are a common bug source",
        story_refs: interactiveWithoutErrors.map(s => s.id),
      }));
    }

    if (hasUiStories) {
      constraints.push(makeConstraint({
        id: "UX-C-005",
        role: "ux_ui",
        constraint: "Frontend/UI plans must include browser journey proof plus screenshot or captured-viewport artifacts for changed user-visible states",
        severity: "MEDIUM",
        rationale: "Rendered UI regressions can pass unit tests while still being visibly broken; durable pictures make the proof inspectable by the user",
        story_refs: stories.filter(s => {
          const text = [s.title || "", ...(s.tags || []), ...(s.postconditions || [])].join(" ").toLowerCase();
          return UX_KEYWORDS.some(kw => text.includes(kw) || text.includes(kw.replace(/_/g, " ")));
        }).map(s => s.id).filter(Boolean),
      }));
    }

    return constraints;
  },

  normalizeFinding(raw, context) {
    if (raw._error) {
      return makeFinding({
        id:             "UX-ERR",
        role:           "ux_ui",
        severity:       SEVERITY.MEDIUM,
        category:       "pack_error",
        story_refs:     [],
        evidence:       raw._error,
        recommendation: "Check that packs/ux_ui/rules.pl is present and valid Prolog.",
      });
    }

    const rule = RULE_DEFS.find(r => r.id === raw.ruleId) || {};

    // Subject could be a story id, "project", or a pair term like "pair(us_001, us_002)"
    // RP-016: Guard against undefined subject (missing Prolog binding).
    const subjectStr  = String(raw.subject ?? "unknown");
    const isPair      = subjectStr.startsWith("pair(");
    const isProject   = subjectStr === "project";
    const storyRefs   = isPair || isProject ? [] : [subjectStr];
    const subjectSlug = subjectStr.replace(/\W/g, "_");

    // v7.4.2: shape-conditional severity downgrade. UX-001 (a11y coverage)
    // shouldn't fire HIGH on backend / refactor / integration / config / docs
    // plans that don't touch UI surfaces — the project-level a11y demand is
    // real but doesn't apply to those plan shapes.
    const severity = shapeAwareSeverity({
      ruleId: raw.ruleId,
      defaultSeverity: raw.severity || SEVERITY.MEDIUM,
      planShape: context?.planShape,
      downgrades: {
        "UX-001": ["bug-fix", "regression", "integration", "refactor", "migration", "planner-core", "docs"],
      },
    });

    return makeFinding({
      id:             `${raw.ruleId}-${subjectSlug}`,
      role:           "ux_ui",
      severity,
      category:       ruleCategory(raw.ruleId),
      story_refs:     storyRefs,
      evidence:       raw.detail || `${raw.ruleId} violation for ${raw.subject}`,
      recommendation: rule.remediation || "See ux_ui pack documentation.",
      meta: {
        ux: {
          rule_id:        raw.ruleId,
          false_positive: rule.false_positive,
        },
      },
    });
  },
};

function ruleCategory(ruleId) {
  const map = {
    "UX-001": "accessibility",
    "UX-002": "flow_coverage",
    "UX-003": "error_handling",
    "UX-004": "interaction_consistency",
  };
  return map[ruleId] || "ux_ui";
}

export default uxUiPack;
