// scientific_contract.mjs — strict contracts and deterministic helpers for scientific review.
// @planner:module = scientific_review_contract
// @planner:capability = strict_bounded_scientific_artifact_contract
// @planner:story = US-003
// @planner:proves = crit:sc_2, crit:sc_3

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, relative, resolve, sep } from "path";

export const SCIENTIFIC_REVIEW_REQUEST_SCHEMA = "planner.scientific_review_request.v1";
export const SCIENTIFIC_EVIDENCE_ARTIFACT_SCHEMA = "planner.scientific_evidence_artifact.v1";
export const SCIENTIFIC_REVIEW_RECEIPT_SCHEMA = "planner.scientific_review_receipt.v1";

export const EXECUTION_STATUSES = Object.freeze(["not_run", "complete", "failed"]);
export const DESIGN_VALIDITIES = Object.freeze(["valid", "invalid", "unresolved"]);
export const EVIDENCE_GRADES = Object.freeze(["evidence", "exploratory", "smoke_fixture", "underpowered", "legacy_unknown"]);
export const SCIENTIFIC_VERDICTS = Object.freeze(["supported", "falsified", "inconclusive", "not_evaluated"]);
export const PROMOTION_STATUSES = Object.freeze(["blocked", "research_only", "candidate_for_confirmation", "eligible_for_integration_review"]);
export const ARTIFACT_ROLES = Object.freeze([
  "preregistration", "executed_config", "universe", "folds", "trials",
  "observations", "result", "registry", "ticket", "plan_identity",
]);

export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeEnum(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveDeclaredPath(reference, { requestPath, projectRoot }) {
  const raw = typeof reference === "string" ? reference : reference?.path;
  if (!raw || typeof raw !== "string") return { path: null, issue: "missing_path" };
  const path = isAbsolute(raw) ? resolve(raw) : resolve(dirname(requestPath), raw);
  if (projectRoot && !isWithin(projectRoot, path)) return { path, issue: "path_outside_project" };
  return { path, issue: null };
}

function exactKeys(value, allowed, location, issues) {
  const object = asObject(value);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) issues.push(`${location}.unexpected_property:${key}`);
  }
}

function requireString(value, location, issues) {
  if (typeof value !== "string" || !value.trim()) issues.push(`${location}:required_string`);
}

function requireInteger(value, location, issues, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) issues.push(`${location}:required_integer_gte_${minimum}`);
}

function requireScalarParameter(value, location, issues) {
  const valid = (typeof value === "string" && value.trim())
    || (typeof value === "number" && Number.isFinite(value))
    || typeof value === "boolean";
  if (!valid) issues.push(`${location}:required_scalar_parameter`);
}

function validateIdentity(identity, location, issues) {
  exactKeys(identity, ["experiment_id", "title", "hypothesis_id", "ticket_id", "story_id", "plan_id"], location, issues);
  for (const key of ["experiment_id", "title", "hypothesis_id", "ticket_id", "story_id", "plan_id"]) {
    requireString(asObject(identity)[key], `${location}.${key}`, issues);
  }
}

function validateArtifactReference(reference, location, issues) {
  exactKeys(reference, ["path", "sha256"], location, issues);
  requireString(asObject(reference).path, `${location}.path`, issues);
  if (!/^[a-f0-9]{64}$/.test(String(asObject(reference).sha256 || ""))) issues.push(`${location}.sha256:invalid`);
}

function requireArray(value, location, issues, { minimum = 0, maximum = Infinity } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    issues.push(`${location}:required_array_${minimum}_${Number.isFinite(maximum) ? maximum : "many"}`);
    return [];
  }
  return value;
}

function validateWindowRows(rowsInput, location, issues) {
  for (const [index, row] of requireArray(rowsInput, location, issues, { minimum: 3 }).entries()) {
    exactKeys(row, ["role", "start", "end"], `${location}[${index}]`, issues);
    for (const key of ["role", "start", "end"]) requireString(asObject(row)[key], `${location}[${index}].${key}`, issues);
  }
}

function validateArtifactPayload(role, payloadInput, issues) {
  const payload = asObject(payloadInput);
  if (role === "preregistration") {
    exactKeys(payload, ["windows", "purge_days", "parameter_choices"], "artifact.payload", issues);
    validateWindowRows(payload.windows, "artifact.payload.windows", issues);
    requireInteger(payload.purge_days, "artifact.payload.purge_days", issues);
    for (const [index, row] of requireArray(payload.parameter_choices, "artifact.payload.parameter_choices", issues, { minimum: 9 }).entries()) {
      const location = `artifact.payload.parameter_choices[${index}]`;
      exactKeys(row, ["dimension", "value", "mechanism", "prior", "alternatives", "basis", "rationale", "sensitivity"], location, issues);
      for (const key of ["dimension", "mechanism", "prior", "basis"]) requireString(asObject(row)[key], `${location}.${key}`, issues);
      requireScalarParameter(asObject(row).value, `${location}.value`, issues);
      for (const [alternativeIndex, alternative] of requireArray(asObject(row).alternatives, `${location}.alternatives`, issues, { minimum: 1 }).entries()) {
        requireScalarParameter(alternative, `${location}.alternatives[${alternativeIndex}]`, issues);
      }
      exactKeys(asObject(row).sensitivity, ["description", "outcomes"], `${location}.sensitivity`, issues);
      requireString(asObject(asObject(row).sensitivity).description, `${location}.sensitivity.description`, issues);
      for (const [outcomeIndex, outcome] of requireArray(asObject(asObject(row).sensitivity).outcomes, `${location}.sensitivity.outcomes`, issues, { minimum: 1 }).entries()) {
        requireScalarParameter(outcome, `${location}.sensitivity.outcomes[${outcomeIndex}]`, issues);
      }
    }
  } else if (role === "executed_config") {
    exactKeys(payload, ["windows", "selected_parameters", "folds_requested", "trials_requested", "universe_target_count"], "artifact.payload", issues);
    validateWindowRows(payload.windows, "artifact.payload.windows", issues);
    exactKeys(payload.selected_parameters, ["windows", "frequency", "universe", "strategy_families", "parameter_ranges", "weights", "thresholds", "trials", "folds"], "artifact.payload.selected_parameters", issues);
    for (const key of ["windows", "frequency", "universe", "strategy_families", "parameter_ranges", "weights", "thresholds", "trials", "folds"]) {
      requireScalarParameter(asObject(payload.selected_parameters)[key], `artifact.payload.selected_parameters.${key}`, issues);
    }
    for (const key of ["folds_requested", "trials_requested", "universe_target_count"]) requireInteger(payload[key], `artifact.payload.${key}`, issues, { minimum: 1 });
  } else if (role === "universe") {
    exactKeys(payload, ["as_of", "ranking_method", "assets", "survivorship_policy", "sensitivity"], "artifact.payload", issues);
    for (const key of ["as_of", "ranking_method", "survivorship_policy"]) requireString(payload[key], `artifact.payload.${key}`, issues);
    for (const [index, row] of requireArray(payload.sensitivity, "artifact.payload.sensitivity", issues, { minimum: 1 }).entries()) {
      requireString(row, `artifact.payload.sensitivity[${index}]`, issues);
    }
    for (const [index, row] of requireArray(payload.assets, "artifact.payload.assets", issues, { minimum: 1 }).entries()) {
      exactKeys(row, ["asset_id", "rank", "eligible", "exclusion_reason"], `artifact.payload.assets[${index}]`, issues);
      requireString(asObject(row).asset_id, `artifact.payload.assets[${index}].asset_id`, issues);
      requireInteger(asObject(row).rank, `artifact.payload.assets[${index}].rank`, issues, { minimum: 1 });
      if (typeof asObject(row).eligible !== "boolean") issues.push(`artifact.payload.assets[${index}].eligible:required_boolean`);
    }
  } else if (role === "folds") {
    exactKeys(payload, ["records"], "artifact.payload", issues);
    for (const [index, row] of requireArray(payload.records, "artifact.payload.records", issues).entries()) {
      exactKeys(row, ["fold_id", "status", "usable"], `artifact.payload.records[${index}]`, issues);
      requireString(asObject(row).fold_id, `artifact.payload.records[${index}].fold_id`, issues);
      if (!["complete", "failed", "not_run"].includes(asObject(row).status)) issues.push(`artifact.payload.records[${index}].status:invalid`);
      if (typeof asObject(row).usable !== "boolean") issues.push(`artifact.payload.records[${index}].usable:required_boolean`);
    }
  } else if (role === "trials") {
    exactKeys(payload, ["records"], "artifact.payload", issues);
    for (const [index, row] of requireArray(payload.records, "artifact.payload.records", issues).entries()) {
      exactKeys(row, ["trial_id", "status", "parameter_set"], `artifact.payload.records[${index}]`, issues);
      requireString(asObject(row).trial_id, `artifact.payload.records[${index}].trial_id`, issues);
      if (!["complete", "failed", "not_run"].includes(asObject(row).status)) issues.push(`artifact.payload.records[${index}].status:invalid`);
      if (!row?.parameter_set || typeof row.parameter_set !== "object" || Array.isArray(row.parameter_set) || Object.keys(row.parameter_set).length === 0) {
        issues.push(`artifact.payload.records[${index}].parameter_set:required_nonempty_object`);
      } else {
        for (const [name, value] of Object.entries(row.parameter_set)) {
          if (!name.trim()) issues.push(`artifact.payload.records[${index}].parameter_set:empty_name`);
          requireScalarParameter(value, `artifact.payload.records[${index}].parameter_set.${name || "unknown"}`, issues);
        }
      }
    }
  } else if (role === "observations") {
    exactKeys(payload, ["records"], "artifact.payload", issues);
    for (const [index, row] of requireArray(payload.records, "artifact.payload.records", issues).entries()) {
      exactKeys(row, ["observation_id", "asset_id", "period_id", "event_id", "eligible", "exclusion_reason"], `artifact.payload.records[${index}]`, issues);
      for (const key of ["observation_id", "asset_id", "period_id", "event_id"]) requireString(asObject(row)[key], `artifact.payload.records[${index}].${key}`, issues);
      if (typeof asObject(row).eligible !== "boolean") issues.push(`artifact.payload.records[${index}].eligible:required_boolean`);
    }
  } else if (role === "result") {
    exactKeys(payload, ["execution_status", "outcome", "counterarguments"], "artifact.payload", issues);
    if (!EXECUTION_STATUSES.includes(payload.execution_status)) issues.push("artifact.payload.execution_status:invalid");
    if (!["positive", "negative", "mixed"].includes(payload.outcome)) issues.push("artifact.payload.outcome:invalid");
    for (const [index, row] of requireArray(payload.counterarguments, "artifact.payload.counterarguments", issues, { minimum: 6, maximum: 6 }).entries()) {
      exactKeys(row, ["type", "assessment", "status"], `artifact.payload.counterarguments[${index}]`, issues);
      requireString(asObject(row).type, `artifact.payload.counterarguments[${index}].type`, issues);
      requireString(asObject(row).assessment, `artifact.payload.counterarguments[${index}].assessment`, issues);
      if (!["addressed", "material_gap"].includes(asObject(row).status)) issues.push(`artifact.payload.counterarguments[${index}].status:invalid`);
    }
  } else if (["registry", "ticket", "plan_identity"].includes(role)) {
    exactKeys(payload, ["status", "source"], "artifact.payload", issues);
    requireString(payload.status, "artifact.payload.status", issues);
    requireString(payload.source, "artifact.payload.source", issues);
  }
}

export function validateScientificReviewRequest(requestInput) {
  const request = asObject(requestInput);
  const issues = [];
  exactKeys(request, [
    "schema_version", "canonical_evidence_root", "artifacts", "minimums", "expected_identity",
    "claim_direction", "confirmation_stage", "run_metadata", "provenance",
  ], "request", issues);
  if (request.schema_version !== SCIENTIFIC_REVIEW_REQUEST_SCHEMA) issues.push("request.schema_version:invalid");
  requireString(request.canonical_evidence_root, "request.canonical_evidence_root", issues);
  exactKeys(request.artifacts, ARTIFACT_ROLES, "request.artifacts", issues);
  for (const role of ARTIFACT_ROLES) validateArtifactReference(asObject(request.artifacts)[role], `request.artifacts.${role}`, issues);
  exactKeys(request.minimums, ["assets", "completed_folds", "completed_trials", "eligible_observations", "effective_groups"], "request.minimums", issues);
  for (const key of ["assets", "completed_folds", "completed_trials", "eligible_observations", "effective_groups"]) {
    requireInteger(asObject(request.minimums)[key], `request.minimums.${key}`, issues, { minimum: 1 });
  }
  validateIdentity(request.expected_identity, "request.expected_identity", issues);
  if (!["positive", "negative", "mixed"].includes(request.claim_direction)) issues.push("request.claim_direction:invalid");
  if (typeof request.confirmation_stage !== "boolean") issues.push("request.confirmation_stage:required_boolean");
  exactKeys(request.run_metadata, ["run_class", "is_test", "is_synthetic", "short_history", "bypass_used", "output_root"], "request.run_metadata", issues);
  if (!["exploratory", "serious_search", "promotion_candidate", "confirmation"].includes(asObject(request.run_metadata).run_class)) issues.push("request.run_metadata.run_class:invalid");
  for (const key of ["is_test", "is_synthetic", "short_history", "bypass_used"]) {
    if (typeof asObject(request.run_metadata)[key] !== "boolean") issues.push(`request.run_metadata.${key}:required_boolean`);
  }
  requireString(asObject(request.run_metadata).output_root, "request.run_metadata.output_root", issues);
  exactKeys(request.provenance, ["code_revision", "run_started_at", "run_completed_at"], "request.provenance", issues);
  requireString(asObject(request.provenance).code_revision, "request.provenance.code_revision", issues);
  for (const key of ["run_started_at", "run_completed_at"]) {
    const value = asObject(request.provenance)[key];
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) issues.push(`request.provenance.${key}:invalid_datetime`);
  }
  return { valid: issues.length === 0, issues };
}

export function validateScientificArtifact(artifactInput, expectedRole = null) {
  const artifact = asObject(artifactInput);
  const issues = [];
  exactKeys(artifact, ["schema_version", "artifact_type", "identity", "payload"], "artifact", issues);
  if (artifact.schema_version !== SCIENTIFIC_EVIDENCE_ARTIFACT_SCHEMA) issues.push("artifact.schema_version:invalid");
  if (!ARTIFACT_ROLES.includes(artifact.artifact_type)) issues.push("artifact.artifact_type:invalid");
  if (expectedRole && artifact.artifact_type !== expectedRole) issues.push(`artifact.artifact_type:expected_${expectedRole}`);
  validateIdentity(artifact.identity, "artifact.identity", issues);
  if (!artifact.payload || typeof artifact.payload !== "object" || Array.isArray(artifact.payload)) issues.push("artifact.payload:required_object");
  else validateArtifactPayload(expectedRole || artifact.artifact_type, artifact.payload, issues);
  return { valid: issues.length === 0, issues };
}

export function readScientificArtifactSet(request, { requestPath, projectRoot }) {
  const issues = [];
  const artifacts = {};
  const paths = {};
  for (const role of ARTIFACT_ROLES) {
    const reference = asObject(request.artifacts)[role];
    const resolved = resolveDeclaredPath(reference, { requestPath, projectRoot });
    if (resolved.issue) {
      issues.push(`artifact.${role}:${resolved.issue}`);
      continue;
    }
    paths[role] = resolved.path;
    if (!existsSync(resolved.path)) {
      issues.push(`artifact.${role}:missing`);
      continue;
    }
    const actualHash = sha256File(resolved.path);
    if (actualHash !== reference.sha256) issues.push(`artifact.${role}:hash_mismatch`);
    try {
      artifacts[role] = JSON.parse(readFileSync(resolved.path, "utf8"));
    } catch {
      issues.push(`artifact.${role}:invalid_json`);
      continue;
    }
    const validation = validateScientificArtifact(artifacts[role], role);
    issues.push(...validation.issues.map((issue) => `artifact.${role}:${issue}`));
  }
  return { artifacts, paths, issues };
}

export function issue(code, detail, severity = "blocker") {
  return { code, detail, severity };
}

export function uniqueIssues(rows) {
  return [...new Map((rows || []).map((row) => [`${row.severity}:${row.code}:${row.detail}`, row])).values()];
}
