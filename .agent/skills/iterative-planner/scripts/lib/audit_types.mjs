// audit_types.mjs — Shared finding schema and pack contract for role-specific auditors.
//
// This module contains only type definitions (as JSDoc) and shared constants.
// Zero runtime logic — safe to import from any script without side effects.
//
// AuditorPack interface (stable v1 contract):
//   id              string                         — unique pack identifier (e.g., 'quant')
//   applies         (ctx: ProjectContext) => bool  — whether this pack is relevant for the project
//   rules           () => RuleDef[]                — rule definitions for this pack
//   normalizeFinding(f: Object) => Finding         — maps internal finding to shared schema
//
// Finding schema (single format emitted by all packs):
//   id              string    — unique finding identifier (e.g., 'QU-001-1')
//   role            string    — which pack emitted this ('core', 'quant', 'ux_ui')
//   severity        string    — CRITICAL | HIGH | MEDIUM | LOW | INFO
//   category        string    — e.g., 'data_integrity', 'metric_coverage', 'a11y'
//   story_refs      string[]  — relevant story IDs (empty array if none)
//   evidence        string    — what was found (concrete, not vague)
//   recommendation  string    — actionable remediation guidance
//   meta            Object    — optional role-specific extensions (namespaced: meta.quant.*, meta.ux.*)

// ---------------------------------------------------------------------------
// Severity levels
// ---------------------------------------------------------------------------

/**
 * Severity levels, ordered from most to least severe.
 * Used in audit.config.json `fail_on` and in CI gate logic.
 */
export const SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH:     'HIGH',
  MEDIUM:   'MEDIUM',
  LOW:      'LOW',
  INFO:     'INFO',
});

/** Ordered array of all severity levels (most → least severe). */
export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/**
 * Map a role-auditor severity to project_health.mjs severity levels.
 *   CRITICAL / HIGH  → 'fail'
 *   MEDIUM           → 'warn'
 *   LOW / INFO       → 'info'
 */
export function toHealthSeverity(severity) {
  const s = String(severity).toUpperCase();
  if (s === 'CRITICAL' || s === 'HIGH') return 'fail';
  if (s === 'MEDIUM') return 'warn';
  return 'info';
}

/**
 * Returns true if severity meets or exceeds the threshold.
 * e.g., meetsThreshold('HIGH', 'MEDIUM') → true (HIGH is more severe than MEDIUM)
 */
export function meetsThreshold(severity, threshold) {
  const idx = SEVERITY_ORDER.indexOf(String(severity).toUpperCase());
  const tIdx = SEVERITY_ORDER.indexOf(String(threshold).toUpperCase());
  if (idx === -1 || tIdx === -1) return false;
  return idx <= tIdx; // lower index = more severe
}

// ---------------------------------------------------------------------------
// Finding factory
// ---------------------------------------------------------------------------

/**
 * Build a Finding object with all required fields.
 * Ensures the schema is always complete even if the pack omits fields.
 *
 * @param {Object} opts
 * @param {string} opts.id            — unique identifier (e.g., 'QU-001-1')
 * @param {string} opts.role          — pack id (e.g., 'quant')
 * @param {string} opts.severity      — one of SEVERITY values
 * @param {string} opts.category      — short category label
 * @param {string[]} [opts.story_refs] — relevant story IDs
 * @param {string} opts.evidence      — what was found
 * @param {string} opts.recommendation — what to do about it
 * @param {Object} [opts.meta]        — role-specific extensions
 * @returns {Object} Finding
 */
export function makeFinding({ id, role, severity, category, story_refs, evidence, recommendation, meta }) {
  return {
    id:             String(id || 'UNKNOWN'),
    role:           String(role || 'unknown'),
    severity:       String(severity || SEVERITY.MEDIUM).toUpperCase(),
    category:       String(category || 'general'),
    story_refs:     Array.isArray(story_refs) ? story_refs : [],
    evidence:       String(evidence || '(no evidence provided)'),
    recommendation: String(recommendation || '(no recommendation provided)'),
    meta:           meta || {},
  };
}

// ---------------------------------------------------------------------------
// JSDoc types (reference only — not enforced at runtime)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Finding
 * @property {string}   id
 * @property {string}   role
 * @property {string}   severity       — CRITICAL | HIGH | MEDIUM | LOW | INFO
 * @property {string}   category
 * @property {string[]} story_refs
 * @property {string}   evidence
 * @property {string}   recommendation
 * @property {Object}   [meta]
 */

/**
 * @typedef {Object} RuleDef
 * @property {string} id              — Rule identifier (e.g., 'QU-001')
 * @property {string} name            — Human-readable name
 * @property {string} rationale       — Why this rule exists
 * @property {string} false_positive  — Known false-positive scenarios
 * @property {string} remediation     — How to fix violations
 * @property {'prolog'|'js'} engine   — Which engine evaluates this rule
 */

/**
 * @typedef {Object} ProjectContext
 * @property {string}  cwd              — Project working directory
 * @property {string}  skillPath        — Skill root directory
 * @property {Object}  [storyRegistry]  — Parsed story_registry.json if available
 * @property {Object}  [planFiles]      — Map of plan file contents (state, plan, findings)
 * @property {Object}  auditConfig      — Parsed audit.config.json
 */

/**
 * @typedef {Object} Constraint
 * @property {string}   id              — unique constraint identifier (e.g., 'QU-C-001')
 * @property {string}   role            — pack id that emitted this
 * @property {string}   constraint      — what the plan must include/address
 * @property {string}   severity        — CRITICAL | HIGH | MEDIUM | LOW
 * @property {string}   rationale       — why this constraint matters
 * @property {string[]} story_refs      — relevant story IDs (empty array if none)
 * @property {Object}   [meta]          — optional role-specific extensions
 */

/**
 * Build a Constraint object with all required fields.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string} opts.role
 * @param {string} opts.constraint
 * @param {string} opts.severity
 * @param {string} opts.rationale
 * @param {string[]} [opts.story_refs]
 * @param {Object} [opts.meta]
 * @returns {Object} Constraint
 */
export function makeConstraint({ id, role, constraint, severity, rationale, story_refs, meta }) {
  return {
    id:         String(id || 'UNKNOWN'),
    role:       String(role || 'unknown'),
    constraint: String(constraint || '(no constraint provided)'),
    severity:   String(severity || SEVERITY.MEDIUM).toUpperCase(),
    rationale:  String(rationale || '(no rationale provided)'),
    story_refs: Array.isArray(story_refs) ? story_refs : [],
    meta:       meta || {},
  };
}

/**
 * AuditorPack interface — stable contract for v1.1.
 *
 * Required methods: id, applies, rules, normalizeFinding
 * Optional methods (v1.1):
 *   getPhaseGuidance(phase, context)  — returns domain-specific guidance string for a phase
 *   getPlanConstraints(context)       — returns array of Constraint objects for PLAN phase
 *
 * @typedef {Object} AuditorPack
 * @property {string}   id
 * @property {(ctx: ProjectContext) => boolean} applies
 * @property {() => RuleDef[]} rules
 * @property {(finding: Object) => Finding} normalizeFinding
 * @property {(phase: string, ctx: ProjectContext) => string|null} [getPhaseGuidance]
 * @property {(ctx: ProjectContext) => Constraint[]} [getPlanConstraints]
 */
