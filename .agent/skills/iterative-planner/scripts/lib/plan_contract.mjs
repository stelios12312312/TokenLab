// plan_contract.mjs — Structured plan artifact helpers.
//
// E8-1 retired the approval-envelope substrate. This module now preserves the
// useful plan.md / plan.json parsing, projection, duplicate-key detection, and
// canonical hash helpers without creating or validating approval envelopes.
//
// Stories: US-087 (table escape) and surviving structured-plan consumers.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

// Bumping this requires a migration entry in migrate.mjs upgrade-approval-envelope.
export const PLAN_CONTRACT_SCHEMA_VERSION = 1;

// Reason codes — verify_gate quotes these verbatim in gate output so machine
// consumers can pattern-match.
export const REASON_CODES = Object.freeze({
  PLAN_JSON_DUPLICATE_KEY: "plan_json_duplicate_key",
  PLAN_JSON_SCHEMA_INVALID: "plan_json_schema_invalid",
  PROJECTION_DRIFT: "projection_drift",
  PLAN_MD_MISSING: "plan_md_missing",
});

// ── Text normalization (shared with hasher and projection check) ────────────

export function normalizePlanText(content) {
  return String(content || "").replace(/\r\n/g, "\n").replace(/\n+$/, "\n");
}

// ── Markdown table cell escaping (US-087) ───────────────────────────────────

// NFKC collapses fullwidth pipe U+FF5C to ASCII | so it can be escaped.
// Then escape HTML, escape pipes, strip zero-width chars, collapse newlines.
// Strict-mode helper consumed by the projection emitter — every cell goes
// through this, no exceptions.
export function escapeMdTableCell(value) {
  if (value === null || value === undefined) return "";
  let text;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return text
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "") // ZWSP/ZWJ/ZWNJ/BOM
    // NF-006a: NFKC normalizes U+FF5C (fullwidth pipe) to ASCII | but does NOT
    // normalize U+00A6 (broken bar ¦), U+2502 (box drawings light │), or
    // U+2503 (box drawings heavy ┃). These pass GFM's parser but retain
    // visual-confusion vector in reviewed tables. Collapse to ASCII | first
    // so the pipe-escape pass below handles them uniformly (one backslash, not two).
    .replace(/[¦│┃]/g, "|")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>")
    .trim();
}

// ── Duplicate-key detection (F-003 / sc_6) ──────────────────────────────────

// Per-scope tokenizer. JSON.parse silently keeps the last value when keys
// collide; this scanner runs BEFORE JSON.parse and returns the first
// duplicate key it finds (any nesting depth), or null. Input is assumed
// syntactically valid JSON.
export function detectFirstDuplicateJsonKey(rawText) {
  if (typeof rawText !== "string") return null;
  const scopes = [];
  let inString = false;
  let stringStart = -1;
  let escape = false;
  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') {
        const tok = rawText.slice(stringStart + 1, i);
        let j = i + 1;
        while (j < rawText.length && /\s/.test(rawText[j])) j++;
        if (rawText[j] === ":" && scopes.length > 0) {
          const top = scopes[scopes.length - 1];
          if (top.has(tok)) return tok;
          top.add(tok);
        }
        inString = false;
      }
      continue;
    }
    if (ch === '"') { inString = true; stringStart = i; continue; }
    if (ch === "{") { scopes.push(new Set()); continue; }
    if (ch === "}") { scopes.pop(); continue; }
  }
  return null;
}

// ── Canonical JSON form (sc_3) ──────────────────────────────────────────────

// Recursive key-sorted serializer. Semantically-equivalent JSON (whitespace,
// key order) produces the same string; any data-level change alters it.
//
// F-012 (residual risk, documented and accepted): JS JSON.stringify normalizes
// numeric forms — `1`, `1.0`, `-0`, and `0` all serialize identically — so a
// plan.json change that only swaps numeric lexical form will NOT alter the
// canonical hash. The current plan.json schema has no fields where this
// matters (`complexity_budget.*` are integers). If a future schema version
// introduces numeric thresholds where `1.0` and `1` must be distinguishable,
// this serializer must be replaced with a lexically-preserving form.
function canonicalizeJsonValue(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonValue).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalizeJsonValue(value[k])}`).join(",")}}`;
}

// ── Plan.json parser (sc_2 + sc_6) ──────────────────────────────────────────

// Parses plan.json and returns a normalized plan object. Rejects duplicate
// keys BEFORE JSON.parse so attacker-curated `{"goal":"a","goal":"b"}` is
// caught (the canonical hash would otherwise collapse two visually-distinct
// files to the same value). Rejects invalid JSON and missing required fields
// with explicit error messages.
export function parsePlanJson(rawContent) {
  if (typeof rawContent !== "string") {
    throw new Error(`[plan.json Schema Validation Failed] non-string input`);
  }
  const duplicate = detectFirstDuplicateJsonKey(rawContent);
  if (duplicate) {
    throw new Error(`[plan.json Schema Validation Failed] Duplicate key '${duplicate}' — JSON.parse silently keeps the last occurrence and would mask the conflict`);
  }
  let planObj;
  try {
    planObj = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`[plan.json Schema Validation Failed] JSON Syntax Error: ${err.message}`);
  }
  const errors = validatePlanJsonSchema(planObj);
  if (errors.length > 0) {
    throw new Error(`[plan.json Schema Validation Failed] Validation Errors:\n- ${errors.join("\n- ")}`);
  }
  return planObj;
}

function validatePlanJsonSchema(planObj) {
  const errors = [];
  if (!planObj || typeof planObj !== "object" || Array.isArray(planObj)) {
    errors.push("Root must be a JSON object");
    return errors;
  }
  if (typeof planObj.goal !== "string" || !planObj.goal.trim()) {
    errors.push("Missing or empty required field 'goal'");
  }
  if (!planObj.problem_statement || typeof planObj.problem_statement !== "object") {
    errors.push("Missing or invalid required field 'problem_statement'");
  } else if (typeof planObj.problem_statement.expected_behavior !== "string" ||
             !planObj.problem_statement.expected_behavior.trim()) {
    errors.push("Missing or empty field 'problem_statement.expected_behavior'");
  }
  if (!Array.isArray(planObj.files_to_modify)) {
    errors.push("Missing or invalid required field 'files_to_modify'");
  }
  if (!Array.isArray(planObj.steps)) {
    errors.push("Missing or invalid required field 'steps'");
  } else {
    planObj.steps.forEach((step, idx) => {
      if (!step || typeof step !== "object") {
        errors.push(`step[${idx}] is not an object`);
        return;
      }
      for (const field of ["id", "description", "status"]) {
        if (typeof step[field] !== "string" || !step[field].trim()) {
          errors.push(`step[${idx}].${field} is missing or empty`);
        }
      }
    });
  }
  if (!planObj.semantic_upkeep_contract || typeof planObj.semantic_upkeep_contract !== "object") {
    errors.push("Missing or invalid required field 'semantic_upkeep_contract'");
  } else {
    const s = planObj.semantic_upkeep_contract;
    if (typeof s.profile !== "string" || !s.profile.trim()) {
      errors.push("Missing or empty field 'semantic_upkeep_contract.profile'");
    }
    if (typeof s.validation_bundle !== "string" || !s.validation_bundle.trim()) {
      errors.push("Missing or empty field 'semantic_upkeep_contract.validation_bundle'");
    }
    if (!["lightweight", "full", "scientific"].includes(s.strictness_mode)) {
      errors.push("Missing or invalid field 'semantic_upkeep_contract.strictness_mode'");
    }
  }
  if (!Array.isArray(planObj.success_criteria)) {
    errors.push("Missing or invalid required field 'success_criteria'");
  } else {
    planObj.success_criteria.forEach((sc, idx) => {
      if (!sc || typeof sc !== "object") {
        errors.push(`success_criteria[${idx}] is not an object`);
        return;
      }
      for (const field of ["id", "description"]) {
        if (typeof sc[field] !== "string" || !sc[field].trim()) {
          errors.push(`success_criteria[${idx}].${field} is missing or empty`);
        }
      }
    });
  }
  if (!Array.isArray(planObj.verification_strategy)) {
    errors.push("Missing or invalid required field 'verification_strategy'");
  } else {
    planObj.verification_strategy.forEach((vs, idx) => {
      if (!vs || typeof vs !== "object") {
        errors.push(`verification_strategy[${idx}] is not an object`);
        return;
      }
      for (const field of ["criterion_id", "story_linkage", "required_proof_type", "command", "pass_means"]) {
        if (typeof vs[field] !== "string" || !vs[field].trim()) {
          errors.push(`verification_strategy[${idx}].${field} is missing or empty`);
        }
      }
    });
  }
  return errors;
}

// ── Projection emitter (sc_1 / sc_5) ────────────────────────────────────────

// Deterministic plan.md projection of a parsed plan.json object. Every table cell goes
// through escapeMdTableCell so adversarial JSON values cannot malform the
// table (US-087).
export function projectPlanJsonToMd(planObj) {
  let md = `# Goal\n${planObj.goal}\n\n`;

  md += `## Problem Statement\nExpected behavior: ${planObj.problem_statement.expected_behavior}\n`;
  if (Array.isArray(planObj.problem_statement.invariants) && planObj.problem_statement.invariants.length > 0) {
    md += `Invariants: ${planObj.problem_statement.invariants.join(", ")}\n`;
  }
  if (Array.isArray(planObj.problem_statement.edge_cases) && planObj.problem_statement.edge_cases.length > 0) {
    md += `Edge cases: ${planObj.problem_statement.edge_cases.join(", ")}\n`;
  }
  md += `\n`;

  md += `## Files To Modify\n`;
  planObj.files_to_modify.forEach(file => { md += `- ${file}\n`; });
  md += `\n`;

  md += `## Steps\n`;
  planObj.steps.forEach(step => {
    md += `- Step ${step.id.replace(/^step_/i, "")}: ${step.description} (${step.status})\n`;
  });
  md += `\n`;

  md += `## Success Criteria\n`;
  planObj.success_criteria.forEach(sc => { md += `- ${sc.id}: ${sc.description}\n`; });
  md += `\n`;

  md += `## Verification Strategy\n`;
  md += `| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  planObj.verification_strategy.forEach(vs => {
    md += `| ${escapeMdTableCell(vs.criterion_id)} | ${escapeMdTableCell(vs.story_linkage)} | ${escapeMdTableCell(vs.repo_context || "")} | ${escapeMdTableCell(vs.required_proof_type)} | ${escapeMdTableCell(vs.command)} | ${escapeMdTableCell(vs.pass_means)} | ${escapeMdTableCell(vs.what_remains_unverified || "None")} |\n`;
  });
  md += `\n`;

  md += `## Semantic Upkeep Contract\n`;
  md += `- Profile: ${planObj.semantic_upkeep_contract.profile}\n`;
  md += `- Ontology action: ${planObj.semantic_upkeep_contract.ontology_action || "none"}\n`;
  md += `- Story action: ${planObj.semantic_upkeep_contract.story_action || "none"}\n`;
  md += `- Validation bundle: ${planObj.semantic_upkeep_contract.validation_bundle}\n`;
  md += `- Strictness mode: ${planObj.semantic_upkeep_contract.strictness_mode}\n`;
  md += `- Close blocker if skipped: ${planObj.semantic_upkeep_contract.close_blocker_if_skipped || "none"}\n`;
  md += `\n`;

  if (Array.isArray(planObj.failure_modes) && planObj.failure_modes.length > 0) {
    md += `## Failure Modes\n`;
    planObj.failure_modes.forEach(fm => {
      md += `- ${fm.dependency}: ${fm.failure_scenario} -> Mitigation: ${fm.mitigation}\n`;
    });
    md += `\n`;
  }

  if (Array.isArray(planObj.risks) && planObj.risks.length > 0) {
    md += `## Risks\n`;
    planObj.risks.forEach(r => { md += `- ${r.risk} -> Mitigation: ${r.mitigation}\n`; });
    md += `\n`;
  }

  if (Array.isArray(planObj.active_mistake_response) && planObj.active_mistake_response.length > 0) {
    md += `## Active Mistake Response\n`;
    md += `| Mistake | Guard | Planned handling | Planned evidence |\n`;
    md += `|---|---|---|---|\n`;
    planObj.active_mistake_response.forEach(amr => {
      md += `| ${escapeMdTableCell(amr.mistake_id)} | ${escapeMdTableCell(amr.guard)} | ${escapeMdTableCell(amr.planned_handling)} | ${escapeMdTableCell(amr.planned_evidence)} |\n`;
    });
    md += `\n`;
  }

  if (planObj.complexity_budget) {
    md += `## Complexity Budget\n`;
    if (planObj.complexity_budget.max_files_added !== undefined) md += `- Max files added: ${planObj.complexity_budget.max_files_added}\n`;
    if (planObj.complexity_budget.max_new_abstractions !== undefined) md += `- Max new abstractions: ${planObj.complexity_budget.max_new_abstractions}\n`;
    if (planObj.complexity_budget.target_lines_net !== undefined) md += `- Target lines net: ${planObj.complexity_budget.target_lines_net}\n`;
    md += `\n`;
  }

  return md;
}

// ── Canonical hash (sc_3) ───────────────────────────────────────────────────

// Hash source: normalized plan.md + canonical plan.json, separated by a
// sentinel so a deliberate boundary blur cannot let a JSON-only change look
// like an md-only change. If plan.json has duplicate keys, falls back to
// raw normalized bytes (canonical form would collapse the dup keys silently).
export function buildHashSource(planDir) {
  if (!planDir) return null;
  const mdPath = join(planDir, "plan.md");
  const jsonPath = join(planDir, "plan.json");
  const hasMd = existsSync(mdPath);
  const hasJson = existsSync(jsonPath);
  if (!hasMd && !hasJson) return null;

  let mdNorm = "";
  if (hasMd) {
    try { mdNorm = normalizePlanText(readFileSync(mdPath, "utf-8")); }
    catch { mdNorm = ""; }
  }

  let jsonNorm = "";
  if (hasJson) {
    let raw = "";
    try { raw = readFileSync(jsonPath, "utf-8"); } catch { raw = ""; }
    if (raw.trim()) {
      if (detectFirstDuplicateJsonKey(raw)) {
        jsonNorm = normalizePlanText(raw);
      } else {
        try { jsonNorm = canonicalizeJsonValue(JSON.parse(raw)); }
        catch { jsonNorm = normalizePlanText(raw); }
      }
    }
  }

  return `${mdNorm}\n---PLAN_JSON_BOUNDARY---\n${jsonNorm}`;
}

export function computeCanonicalHash(planDir) {
  const source = buildHashSource(planDir);
  if (source === null) return null;
  return createHash("sha256").update(source).digest("hex");
}

// ── Preconditions for envelope construction (sc_5 + sc_6) ───────────────────

// Returns null on agreement, or a {reason_code, detail} object on drift.
// Callers reject plan.json projections when this returns non-null.
// verify_gate refuses to verify when projection drift is detected on the
// disk state, regardless of the envelope's stored value.
export function assertProjectionEquivalence(planDir) {
  if (!planDir) return null;
  const jsonPath = join(planDir, "plan.json");
  const mdPath = join(planDir, "plan.md");
  if (!existsSync(jsonPath)) return null;
  if (!existsSync(mdPath)) {
    return { reason_code: REASON_CODES.PLAN_MD_MISSING, detail: "plan.json exists but plan.md is missing" };
  }
  let raw;
  try { raw = readFileSync(jsonPath, "utf-8"); }
  catch (err) { return { reason_code: REASON_CODES.PROJECTION_DRIFT, detail: `failed to read plan.json: ${err.message}` }; }
  let planObj;
  try { planObj = parsePlanJson(raw); }
  catch (err) { return { reason_code: REASON_CODES.PLAN_JSON_SCHEMA_INVALID, detail: err.message.split("\n")[0] }; }
  let rawMd;
  try { rawMd = readFileSync(mdPath, "utf-8"); }
  catch (err) { return { reason_code: REASON_CODES.PROJECTION_DRIFT, detail: `failed to read plan.md: ${err.message}` }; }
  const projected = projectPlanJsonToMd(planObj);
  if (normalizePlanText(rawMd) !== normalizePlanText(projected)) {
    return {
      reason_code: REASON_CODES.PROJECTION_DRIFT,
      detail: "plan.md does not match plan.json projection — re-run explore-to-plan or regenerate plan.md via bootstrap.mjs edit-plan",
    };
  }
  return null;
}

// Returns null when plan.json is absent OR has no duplicate keys. Otherwise
// returns {reason_code, detail} for structured-plan validators.
export function assertNoDuplicateKeys(planDir) {
  if (!planDir) return null;
  const jsonPath = join(planDir, "plan.json");
  if (!existsSync(jsonPath)) return null;
  let raw;
  try { raw = readFileSync(jsonPath, "utf-8"); } catch { return null; }
  const duplicate = detectFirstDuplicateJsonKey(raw);
  if (duplicate) {
    return {
      reason_code: REASON_CODES.PLAN_JSON_DUPLICATE_KEY,
      detail: `plan.json contains duplicate key '${duplicate}' — JSON.parse silently collapses duplicates and would mask the conflict`,
    };
  }
  return null;
}
