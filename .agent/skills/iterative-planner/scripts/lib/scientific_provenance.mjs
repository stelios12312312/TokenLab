// scientific_provenance.mjs — provenance completeness, fixture stamping, and canonical-output isolation.
// @planner:module = scientific_provenance
// @planner:capability = independent_hash_and_fixture_provenance_validation
// @planner:story = US-003
// @planner:proves = crit:sc_2, crit:sc_4

import { dirname, resolve } from "path";

import { asObject, issue, normalizeEnum, resolveDeclaredPath } from "./scientific_contract.mjs";
import { outputTargetsCanonicalEvidence } from "./scientific_canonical_guard.mjs";

export function evaluateScientificProvenance(request, artifacts, paths, { requestPath, projectRoot }) {
  const issues = [];
  const warnings = [];
  const metadata = asObject(request.run_metadata);
  const canonicalResolved = resolveDeclaredPath(request.canonical_evidence_root, { requestPath, projectRoot });
  const outputResolved = resolveDeclaredPath(metadata.output_root, { requestPath, projectRoot });
  if (canonicalResolved.issue) issues.push(issue("canonical_evidence_root_invalid", canonicalResolved.issue));
  if (outputResolved.issue) issues.push(issue("output_root_invalid", outputResolved.issue));
  if (!canonicalResolved.issue && !outputResolved.issue && outputTargetsCanonicalEvidence({ canonicalRoot: canonicalResolved.path, outputRoot: outputResolved.path })) {
    issues.push(issue("canonical_evidence_write_target", `output root ${outputResolved.path} is inside canonical evidence ${canonicalResolved.path}`));
  }
  const provenance = asObject(request.provenance);
  if (!/^[a-f0-9]{7,64}$/i.test(String(provenance.code_revision || ""))) issues.push(issue("code_revision_invalid", String(provenance.code_revision || "missing")));
  const start = Date.parse(provenance.run_started_at);
  const end = Date.parse(provenance.run_completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) issues.push(issue("run_time_invalid", "run_started_at must not follow run_completed_at"));
  const fixtureReason = [
    metadata.is_test && "test",
    metadata.is_synthetic && "synthetic",
    metadata.short_history && "short_history",
    metadata.bypass_used && "bypass",
    /(^|[\\/])(tmp|temp|fixtures?)([\\/]|$)/i.test(String(metadata.output_root || "")) && "temporary_output",
    ["smoke", "wiring_proof"].includes(normalizeEnum(metadata.run_class)) && "diagnostic_run_class",
  ].filter(Boolean);
  return {
    valid: issues.length === 0,
    smoke_fixture: fixtureReason.length > 0,
    fixture_reasons: fixtureReason,
    issues,
    warnings,
    canonical_evidence_root: canonicalResolved.path || null,
    output_root: outputResolved.path || null,
    code_revision: provenance.code_revision || null,
    artifact_directory: dirname(requestPath),
  };
}
