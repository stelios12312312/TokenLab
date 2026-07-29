// ive_reflection_diff.mjs - IVE Phase 4/4.6 structured evidence compiler.

import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { sanitizeEnumAtom, sanitizeStrictId } from "./sanitize.mjs";
import { validateRunRecordBinding } from "./run_record.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const REQUIRED_GENERATOR_PREDICATES = [
  "progress_complete",
  "proof_of_work",
  "all_verification_pass",
  "test_evidence_satisfied",
  "red_team_documented",
  "audit_perspective",
  "planned_anchor_not_delivered",
  "acceptance_unmet",
  "pre_mortem_risk_unresolved",
  "verification_row_missing_evidence",
  "telemetry_missing",
  "reflection_unsubstantiated",
];

const REQUIRED_REFLECTION_SECTIONS = [
  "Anchors",
  "Acceptance",
  "Pre-mortem",
  "Verification",
  "Telemetry",
  "Unsubstantiated",
];

const COMPLETENESS_CLAIM_RE = /\b(implemented|delivered|completed|verified|tested|validated|done|finished)\b/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeEnum(value) {
  return asString(value).toLowerCase().replace(/[-\s]+/g, "_");
}

function normalizeId(value, fallback = "unknown") {
  return asString(value) || fallback;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(asString).filter(Boolean))];
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function issue(code, subject, message, severity = "error", path = null) {
  return {
    code,
    subject: normalizeId(subject),
    severity,
    message,
    path,
  };
}

function evidenceRefs(row = {}) {
  return uniqueStrings([
    ...asArray(row.evidence_refs),
    ...asArray(row.evidence),
    ...asArray(row.artifact_refs),
    ...asArray(row.validation_refs),
    ...asArray(row.test_refs),
    ...asArray(row.mitigation_refs),
    ...asArray(row.refs),
    row.evidence_ref,
    row.artifact_ref,
    row.validation_ref,
    row.test_ref,
    row.mitigation_ref,
    row.path,
  ]);
}

function hasEvidence(row = {}) {
  return evidenceRefs(row).length > 0;
}

function statusOf(row = {}) {
  return normalizeEnum(row.status || row.state || row.outcome);
}

function isDelivered(row = {}) {
  return verificationStatusIsPass(statusOf(row), "execution");
}

function isDeferred(row = {}) {
  return normalizeVerificationStatus(statusOf(row), "execution").kind === "waived";
}

function collectRows(structuredTelemetry = {}) {
  const anchors = asArray(structuredTelemetry.anchors || structuredTelemetry.planned_anchors);
  const acceptanceCriteria = asArray(
    structuredTelemetry.acceptance_criteria ||
    structuredTelemetry.criteria ||
    structuredTelemetry.acceptance
  );
  const preMortemRisks = asArray(
    structuredTelemetry.pre_mortem_risks ||
    structuredTelemetry.risks ||
    structuredTelemetry.pre_mortem
  );
  const verificationRows = asArray(
    structuredTelemetry.verification_rows ||
    structuredTelemetry.verification ||
    structuredTelemetry.tests
  );
  const telemetryRows = asArray(
    structuredTelemetry.telemetry ||
    structuredTelemetry.metrics ||
    structuredTelemetry.metric_actuals
  );
  const redTeamNotes = asArray(
    structuredTelemetry.red_team_notes ||
    structuredTelemetry.red_team ||
    structuredTelemetry.findings
  );
  const sessionClaims = asArray(
    structuredTelemetry.session_claims ||
    structuredTelemetry.claims
  );

  return {
    anchors,
    acceptanceCriteria,
    preMortemRisks,
    verificationRows,
    telemetryRows,
    redTeamNotes,
    sessionClaims,
  };
}

function buildKnownRefs(rows) {
  const refs = new Set();
  for (const collection of Object.values(rows)) {
    for (const row of asArray(collection)) {
      const id = asString(row?.id || row?.anchor_id || row?.criterion_id || row?.risk_id || row?.metric_id || row?.claim_id);
      if (id) refs.add(id);
      for (const ref of evidenceRefs(row)) refs.add(ref);
    }
  }
  return refs;
}

function buildKnownStructuredIds(rows) {
  const refs = new Set();
  for (const collection of Object.values(rows)) {
    for (const row of asArray(collection)) {
      const id = asString(row?.id || row?.anchor_id || row?.criterion_id || row?.risk_id || row?.metric_id || row?.claim_id);
      if (id) refs.add(id);
    }
  }
  return refs;
}

function resolveEvidenceRef(ref, cwd) {
  const raw = asString(ref);
  if (!raw) return { ok: false, reason: "empty_ref" };
  const hashIndex = raw.indexOf("#");
  const pathPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const symbol = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";
  if (!pathPart) return { ok: false, reason: "missing_path" };
  const candidates = isAbsolute(pathPart)
    ? [pathPart]
    : [resolve(cwd, pathPart), resolve(process.cwd(), pathPart)];
  const found = [...new Set(candidates)].find((candidate) => existsSync(candidate));
  if (!found) return { ok: false, reason: "path_missing", path: pathPart };
  if (symbol) {
    try {
      const content = readFileSync(found, "utf-8");
      if (!content.includes(symbol)) return { ok: false, reason: "symbol_missing", path: found, symbol };
    } catch {
      return { ok: false, reason: "symbol_unreadable", path: found, symbol };
    }
  }
  return { ok: true, path: found, symbol: symbol || null };
}

function validateDeliveredEvidenceRefs(row, knownStructuredIds, cwd, issues) {
  if (!isDelivered(row)) return;
  const refs = evidenceRefs(row);
  if (refs.length === 0) return;
  const id = normalizeId(row.id || row.anchor_id || row.criterion_id || row.risk_id || row.metric_id || row.command, "evidence_row");
  for (const ref of refs) {
    if (knownStructuredIds.has(ref)) continue;
    const resolved = resolveEvidenceRef(ref, cwd);
    if (!resolved.ok) {
      issues.push(issue("evidence_ref_unresolved", id, `Delivered row ${id} references unresolved evidence ${ref} (${resolved.reason}).`, "error", ref));
    }
  }
}

function claimHasConcreteSupport(claim = {}, knownRefs = new Set()) {
  const explicitRefs = evidenceRefs(claim);
  if (explicitRefs.some((ref) => knownRefs.has(ref) || existsSync(ref))) return true;
  const text = asString(claim.text || claim.claim);
  if (!text) return false;
  for (const ref of knownRefs) {
    if (ref && text.includes(ref)) return true;
  }
  return false;
}

function isBlockingClaim(claim = {}) {
  const severity = normalizeEnum(claim.severity || claim.priority);
  const text = asString(claim.text || claim.claim);
  return severity === "critical" || COMPLETENESS_CLAIM_RE.test(text);
}

function evaluateGeneratorPredicateCoverage(coverage = {}) {
  const mappings = asArray(coverage.mappings);
  const mapped = new Set(mappings.map((row) => asString(row?.predicate || row?.id)).filter(Boolean));
  const manualFallbacks = new Set(asArray(coverage.manual_fallbacks).map((row) => asString(row?.predicate || row)).filter(Boolean));
  const missing = REQUIRED_GENERATOR_PREDICATES.filter((predicate) => !mapped.has(predicate) && !manualFallbacks.has(predicate));
  return {
    version: 1,
    status: missing.length > 0 ? "FAIL" : "PASS",
    required_predicates: REQUIRED_GENERATOR_PREDICATES,
    mapped_predicates: [...mapped],
    manual_fallbacks: [...manualFallbacks],
    missing_predicates: missing,
  };
}

function buildPredicateCoverage() {
  return {
    schema_version: 1,
    source: "ive_reflection_diff",
    mappings: [
      { predicate: "progress_complete", artifact: "progress.md", source_fields: ["anchors", "acceptance_criteria"] },
      { predicate: "proof_of_work", artifact: "verification.md", source_fields: ["verification_rows.evidence_refs"] },
      { predicate: "all_verification_pass", artifact: "verification.md", source_fields: ["verification_rows.status"] },
      { predicate: "test_evidence_satisfied", artifact: "verification.md", source_fields: ["verification_rows.command", "verification_rows.evidence_refs"] },
      { predicate: "red_team_documented", artifact: "red_team_notes.md", source_fields: ["red_team_notes"] },
      { predicate: "audit_perspective", artifact: "red_team_notes.md", source_fields: ["red_team_notes.perspective"] },
      { predicate: "planned_anchor_not_delivered", artifact: "reflection.md", source_fields: ["anchors.status", "anchors.evidence_refs"] },
      { predicate: "acceptance_unmet", artifact: "reflection.md", source_fields: ["acceptance_criteria.status", "acceptance_criteria.evidence_refs"] },
      { predicate: "pre_mortem_risk_unresolved", artifact: "reflection.md", source_fields: ["pre_mortem_risks.status", "pre_mortem_risks.mitigation_refs"] },
      { predicate: "verification_row_missing_evidence", artifact: "reflection.md", source_fields: ["verification_rows.evidence_refs"] },
      { predicate: "telemetry_missing", artifact: "reflection.md", source_fields: ["telemetry.metric_id", "telemetry.actual"] },
      { predicate: "reflection_unsubstantiated", artifact: "reflection.md", source_fields: ["session_claims.text", "session_claims.refs"] },
    ],
    manual_fallbacks: [],
  };
}

function lintLearningNote(note, knownRefs = new Set()) {
  const text = asString(note);
  const issues = [];
  if (!text) return issues;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 300) {
    issues.push(issue("learning_note_too_long", "learning_note", "Learning Note exceeds 300 words.", "error"));
  }
  if (COMPLETENESS_CLAIM_RE.test(text)) {
    issues.push(issue("learning_note_completeness_claim", "learning_note", "Learning Note contains a completeness claim that belongs in the computed diff.", "error"));
  }

  const candidates = text.match(/\b[A-Z][A-Z0-9_.:/-]{2,}\b|\b\S+\.(?:mjs|js|ts|tsx|py|md|json)\b/g) || [];
  for (const candidate of uniqueStrings(candidates)) {
    if (!knownRefs.has(candidate)) {
      issues.push(issue("learning_note_dangling_ref", candidate, `Learning Note references ${candidate}, which is not present in the structured evidence.`, "warning"));
    }
  }
  return issues;
}

function evaluateReflectionDiff(structuredTelemetry = {}, { cwd = process.cwd() } = {}) {
  const rows = collectRows(structuredTelemetry);
  const knownRefs = buildKnownRefs(rows);
  const knownStructuredIds = buildKnownStructuredIds(rows);
  const issues = [];
  const warnings = [];
  const runRecord = validateRunRecordBinding(structuredTelemetry);
  const phase4Signal = phase4Required(structuredTelemetry);
  const phase46Signal = phase46Required(structuredTelemetry, { runRecordValid: runRecord.valid });

  if (phase4Signal && !runRecord.valid) {
    for (const code of runRecord.issues) {
      issues.push(issue(code, "run_record", `Structured telemetry is not runner-bound proof: ${code}.`));
    }
  }

  for (const anchor of rows.anchors) {
    const id = normalizeId(anchor.id || anchor.anchor_id, "anchor");
    validateDeliveredEvidenceRefs(anchor, knownStructuredIds, cwd, issues);
    if (!isDelivered(anchor) && !isDeferred(anchor)) {
      issues.push(issue("planned_anchor_not_delivered", id, `Planned anchor ${id} has no delivered evidence or deferral.`));
    }
  }

  for (const criterion of rows.acceptanceCriteria) {
    const id = normalizeId(criterion.id || criterion.criterion_id, "criterion");
    validateDeliveredEvidenceRefs(criterion, knownStructuredIds, cwd, issues);
    if (!isDelivered(criterion) && !isDeferred(criterion)) {
      issues.push(issue("acceptance_unmet", id, `Acceptance criterion ${id} has no satisfying evidence.`));
    }
  }

  for (const risk of rows.preMortemRisks) {
    const id = normalizeId(risk.id || risk.risk_id, "risk");
    const status = statusOf(risk);
    validateDeliveredEvidenceRefs(risk, knownStructuredIds, cwd, issues);
    if (!verificationStatusIsPass(status, "execution") && !isDeferred(risk)) {
      issues.push(issue("pre_mortem_risk_unresolved", id, `Pre-mortem risk ${id} is unresolved.`));
    }
  }

  for (const row of rows.verificationRows) {
    const id = normalizeId(row.id || row.criterion_id || row.command, "verification_row");
    validateDeliveredEvidenceRefs(row, knownStructuredIds, cwd, issues);
    if (!hasEvidence(row)) {
      issues.push(issue("verification_row_missing_evidence", id, `Verification row ${id} has no evidence ref.`));
    }
    if (!verificationStatusIsPass(statusOf(row), "execution")) {
      issues.push(issue("verification_row_not_passed", id, `Verification row ${id} does not report a satisfying execution status.`));
    }
  }

  for (const metric of rows.telemetryRows) {
    const id = normalizeId(metric.id || metric.metric_id, "metric");
    const actual = metric.actual ?? metric.value ?? metric.observed;
    validateDeliveredEvidenceRefs(metric, knownStructuredIds, cwd, issues);
    if (actual === null || actual === undefined || actual === "") {
      issues.push(issue("telemetry_missing", id, `Telemetry metric ${id} has no actual value.`));
    }
  }

  for (const claim of rows.sessionClaims) {
    const id = normalizeId(claim.id || claim.claim_id, "claim");
    if (!claimHasConcreteSupport(claim, knownRefs)) {
      const severity = isBlockingClaim(claim) ? "error" : "warning";
      const target = severity === "error" ? issues : warnings;
      target.push(issue("reflection_unsubstantiated", id, `Session claim ${id} has no anchor, test, or artifact support.`, severity));
    }
  }

  for (const lintIssue of lintLearningNote(structuredTelemetry.learning_note, knownRefs)) {
    (lintIssue.severity === "error" ? issues : warnings).push(lintIssue);
  }

  const coverage = structuredTelemetry.generator_predicate_coverage || buildPredicateCoverage();
  const coverageReport = evaluateGeneratorPredicateCoverage(coverage);
  for (const predicate of coverageReport.missing_predicates) {
    issues.push(issue("generator_predicate_unmapped", predicate, `Generator predicate ${predicate} has no mapping or manual fallback.`));
  }

  return {
    version: 1,
    required: phase4Signal,
    required_phase4: phase4Signal,
    required_phase4_6: phase46Signal,
    status: summarizeStatus(issues, warnings, phase4Signal || phase46Signal),
    sections: {
      anchors: rows.anchors,
      acceptance: rows.acceptanceCriteria,
      pre_mortem: rows.preMortemRisks,
      verification: rows.verificationRows,
      telemetry: rows.telemetryRows,
      unsubstantiated: rows.sessionClaims,
    },
    counts: {
      anchors: rows.anchors.length,
      acceptance: rows.acceptanceCriteria.length,
      pre_mortem_risks: rows.preMortemRisks.length,
      verification_rows: rows.verificationRows.length,
      telemetry_rows: rows.telemetryRows.length,
      red_team_notes: rows.redTeamNotes.length,
      session_claims: rows.sessionClaims.length,
    },
    predicate_coverage: coverageReport,
    run_record_status: runRecord.status,
    run_record_issues: runRecord.issues,
    issues,
    warnings,
  };
}

function summarizeStatus(errors, warnings, required) {
  if (!required) return "NOT_APPLICABLE";
  if (errors.length > 0) return "FAIL";
  if (warnings.length > 0) return "WARN";
  return "PASS";
}

function phase4Required(structuredTelemetry = {}) {
  return structuredTelemetry?.ive_phase4_required === true ||
    structuredTelemetry?.ive_phase4_6_required === true ||
    asArray(structuredTelemetry?.anchors).length > 0 ||
    asArray(structuredTelemetry?.verification_rows).length > 0 ||
    asArray(structuredTelemetry?.red_team_notes).length > 0;
}

function phase46Required(structuredTelemetry = {}, { runRecordValid = false } = {}) {
  if (!runRecordValid) return false;
  return structuredTelemetry?.ive_phase4_6_required === true ||
    asArray(structuredTelemetry?.session_claims).length > 0 ||
    asString(structuredTelemetry?.learning_note) !== "";
}

function renderProgressMarkdown(report, structuredTelemetry = {}) {
  const lines = [
    "<!-- GENERATED: ive_reflection_diff progress -->",
    "## Generated Progress",
    "",
  ];
  for (const anchor of report.sections.anchors) {
    const id = normalizeId(anchor.id || anchor.anchor_id, "anchor");
    lines.push(`- [${isDelivered(anchor) ? "x" : " "}] ${id} - ${statusOf(anchor) || "pending"}`);
  }
  if (report.sections.anchors.length === 0) lines.push("- [x] No planned anchors declared in structured telemetry.");
  lines.push("");
  lines.push(`Source: structured telemetry ${asString(structuredTelemetry.generated_at) || "(undated)"}`);
  return lines.join("\n");
}

function renderVerificationMarkdown(report) {
  const lines = [
    "<!-- GENERATED: ive_reflection_diff verification -->",
    "## Criteria Verification",
    "",
    "| Criterion | Status | Evidence refs |",
    "| --- | --- | --- |",
  ];
  for (const row of report.sections.verification) {
    const id = normalizeId(row.id || row.criterion_id || row.command, "verification_row");
    lines.push(`| ${id} | ${statusOf(row) || "unknown"} | ${evidenceRefs(row).join(", ") || "MISSING"} |`);
  }
  if (report.sections.verification.length === 0) lines.push("| none | not_applicable | No verification rows declared |");
  lines.push("");
  lines.push("## Validation Status");
  lines.push("");
  lines.push(`Status: ${report.status}`);
  return lines.join("\n");
}

function renderRedTeamNotesMarkdown(report) {
  const notes = report.sections.unsubstantiated || [];
  const lines = ["<!-- GENERATED: ive_reflection_diff red_team_notes -->"];
  const riskRows = notes.length > 0 ? notes : [{ id: "CLAIM-SCAN", text: "No unsupported claims found.", severity: "info" }];
  for (const [index, row] of riskRows.entries()) {
    const id = normalizeId(row.id || row.claim_id, `CLAIM-${index + 1}`);
    lines.push("");
    lines.push(`## Vector ${index + 1}: ${id}`);
    lines.push("");
    lines.push(`Attack: Check whether claim ${id} can pass as prose without artifact support.`);
    lines.push(`Impact: Unsupported completion claims can create a false green closeout.`);
    lines.push(`Evidence: ${evidenceRefs(row).join(", ") || "No direct refs declared."}`);
    lines.push(`Status: ${claimHasConcreteSupport(row, buildKnownRefs(collectRows({ session_claims: riskRows }))) ? "supported" : "requires structured evidence"}`);
    lines.push("Mitigation: Bind claims to anchors, tests, or artifacts before close.");
  }
  return lines.join("\n");
}

function formatRow(row, idKey = "id") {
  const id = normalizeId(row[idKey] || row.id || row.anchor_id || row.criterion_id || row.risk_id || row.metric_id, "row");
  const status = statusOf(row) || (hasEvidence(row) ? "evidence_present" : "pending");
  const refs = evidenceRefs(row).join(", ") || "none";
  return `- ${id}: ${status}; evidence=${refs}`;
}

function renderReflectionMarkdown(report, structuredTelemetry = {}) {
  const lines = [
    "<!-- GENERATED: ive_reflection_diff reflection -->",
    "## Anchors",
    ...report.sections.anchors.map((row) => formatRow(row, "anchor_id")),
    ...(report.sections.anchors.length ? [] : ["- none declared"]),
    "",
    "## Acceptance",
    ...report.sections.acceptance.map((row) => formatRow(row, "criterion_id")),
    ...(report.sections.acceptance.length ? [] : ["- none declared"]),
    "",
    "## Pre-mortem",
    ...report.sections.pre_mortem.map((row) => formatRow(row, "risk_id")),
    ...(report.sections.pre_mortem.length ? [] : ["- none declared"]),
    "",
    "## Verification",
    ...report.sections.verification.map((row) => formatRow(row, "id")),
    ...(report.sections.verification.length ? [] : ["- none declared"]),
    "",
    "## Telemetry",
    ...report.sections.telemetry.map((row) => {
      const id = normalizeId(row.metric_id || row.id, "metric");
      const actual = row.actual ?? row.value ?? row.observed ?? "MISSING";
      return `- ${id}: actual=${actual}; evidence=${evidenceRefs(row).join(", ") || "none"}`;
    }),
    ...(report.sections.telemetry.length ? [] : ["- none declared"]),
    "",
    "## Unsubstantiated",
    ...(report.issues.filter((row) => row.code === "reflection_unsubstantiated").map((row) => `- ${row.subject}: ${row.message}`)),
    ...(report.warnings.filter((row) => row.code === "reflection_unsubstantiated").map((row) => `- ${row.subject}: ${row.message}`)),
    ...((report.issues.concat(report.warnings)).some((row) => row.code === "reflection_unsubstantiated") ? [] : ["- none"]),
  ];

  const note = asString(structuredTelemetry.learning_note);
  if (note) {
    lines.push("");
    lines.push("## Learning Note");
    lines.push(note.split(/\s+/).slice(0, 300).join(" "));
  }

  return lines.join("\n");
}

function compileStructuredEvidence(structuredTelemetry = {}) {
  const report = evaluateReflectionDiff(structuredTelemetry);
  return {
    report,
    progress_md: renderProgressMarkdown(report, structuredTelemetry),
    verification_md: renderVerificationMarkdown(report),
    red_team_notes_md: renderRedTeamNotesMarkdown(report),
    reflection_md: renderReflectionMarkdown(report, structuredTelemetry),
    generator_predicate_coverage: structuredTelemetry.generator_predicate_coverage || buildPredicateCoverage(),
  };
}

function loadIveReflectionDiffInputs({ cwd = process.cwd(), planDir = null } = {}) {
  const structuredTelemetry = planDir ? (readJson(join(planDir, "structured_telemetry.json")) || {}) : {};
  const verificationLedger = planDir ? (readJson(join(planDir, "verification_ledger.json")) || {}) : {};
  const findingsLedger = planDir ? (readJson(join(planDir, "findings_ledger.json")) || {}) : {};

  if (!structuredTelemetry.ive_phase4_required && !structuredTelemetry.ive_phase4_6_required) {
    structuredTelemetry.ive_phase4_required = verificationLedger?.ive_phase4_required === true || findingsLedger?.ive_phase4_required === true;
    structuredTelemetry.ive_phase4_6_required = verificationLedger?.ive_phase4_6_required === true || findingsLedger?.ive_phase4_6_required === true;
  }
  return { structuredTelemetry };
}

function factsForIssue(row) {
  const subject = sanitizeStrictId(row.subject);
  const facts = [`ive_reflection_diff_issue(${sanitizeEnumAtom(row.code)}, ${subject}).`];
  if (row.code === "planned_anchor_not_delivered") facts.push(`planned_anchor_not_delivered(${subject}).`);
  if (row.code === "acceptance_unmet") facts.push(`acceptance_unmet(${subject}).`);
  if (row.code === "pre_mortem_risk_unresolved") facts.push(`pre_mortem_risk_unresolved(${subject}).`);
  if (row.code === "verification_row_missing_evidence") facts.push(`verification_row_missing_evidence(${subject}).`);
  if (row.code === "telemetry_missing") facts.push(`telemetry_missing(${subject}).`);
  if (row.code === "reflection_unsubstantiated") facts.push(`reflection_unsubstantiated(${subject}).`);
  if (row.code === "generator_predicate_unmapped") facts.push(`generator_predicate_unmapped(${subject}).`);
  if (row.code === "learning_note_completeness_claim") facts.push(`learning_note_completeness_claim(${subject}).`);
  if (row.code === "learning_note_too_long") facts.push(`learning_note_too_long(${subject}).`);
  return facts;
}

function compileIveReflectionDiffFacts({ cwd = process.cwd(), planDir = null, inputs = null } = {}) {
  const loaded = inputs || loadIveReflectionDiffInputs({ cwd, planDir });
  const structuredTelemetry = loaded.structuredTelemetry || {};
  const report = evaluateReflectionDiff(structuredTelemetry);
  const facts = [
    `ive_phase4_required(${report.required_phase4 ? "true" : "false"}).`,
    `ive_phase4_6_required(${report.required_phase4_6 ? "true" : "false"}).`,
    `ive_reflection_diff_status(${sanitizeEnumAtom(report.status)}).`,
  ];

  for (const row of report.issues || []) facts.push(...factsForIssue(row));
  for (const row of report.warnings || []) {
    facts.push(`ive_reflection_diff_warning(${sanitizeEnumAtom(row.code)}, ${sanitizeStrictId(row.subject)}).`);
  }
  return { report, facts };
}

export {
  REQUIRED_GENERATOR_PREDICATES,
  REQUIRED_REFLECTION_SECTIONS,
  buildPredicateCoverage,
  compileIveReflectionDiffFacts,
  compileStructuredEvidence,
  evaluateGeneratorPredicateCoverage,
  evaluateReflectionDiff,
  lintLearningNote,
  loadIveReflectionDiffInputs,
  renderReflectionMarkdown,
};
