import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { normalizeAllowedProofType } from "./verification_obligations.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

export const VALID_DIAGNOSIS_STATUSES = new Set([
  "reproduced",
  "unreproducible_local",
  "external_only",
  "waived",
]);

function safeReadJson(filePath) {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return VALID_DIAGNOSIS_STATUSES.has(normalized) ? normalized : null;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\r\n/g, "\n");
}

function normalizeFlatText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningful(value, { allowExplicitNone = false } = {}) {
  const normalized = normalizeFlatText(value);
  if (!normalized) return false;
  if (["-", "tbd", "todo", "pending"].includes(normalized)) return false;
  if (normalized.startsWith("to be defined") || normalized.startsWith("to be populated")) return false;
  if (!allowExplicitNone && (normalized === "n/a" || normalized === "none")) return false;
  return true;
}

function normalizeWaiver(waiver, status) {
  if (!waiver || typeof waiver !== "object" || Array.isArray(waiver)) {
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Corrective-action lifecycle discriminator identifies an explicitly waived action with its own reason and approver.
    return status === "waived"
      ? {
          reason: null,
          approved_by: null,
          note: null,
        }
      : null;
  }

  return {
    reason: firstNonEmptyString(
      waiver.reason,
      waiver.code,
      waiver.waiver_reason,
      waiver.waiverReason,
    ),
    approved_by: firstNonEmptyString(
      waiver.approved_by,
      waiver.approvedBy,
      waiver.authorized_by,
      waiver.authorizedBy,
    ),
    note: firstNonEmptyString(
      waiver.note,
      waiver.detail,
      waiver.description,
    ),
  };
}

export function diagnosisArtifactPath(planDir) {
  return join(planDir, "diagnosis.json");
}

export function normalizeDiagnosisArtifact(raw, { fallbackSubjectId = "plan:current-failure" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const status = normalizeStatus(raw.status);
  const proofType = normalizeAllowedProofType(raw.proof_type || raw.proofType || raw.chosen_proof_type || raw.chosenProofType);
  const waiver = normalizeWaiver(raw.waiver, status);

  return {
    version: Number.isInteger(raw.version) ? raw.version : 1,
    subject_id: firstNonEmptyString(raw.subject_id, raw.subjectId, fallbackSubjectId),
    status,
    proof_type: proofType,
    proof_type_raw: firstNonEmptyString(raw.proof_type, raw.proofType, raw.chosen_proof_type, raw.chosenProofType),
    disputed_behavior: firstNonEmptyString(raw.disputed_behavior, raw.disputedBehavior),
    exact_action: firstNonEmptyString(raw.exact_action, raw.exactAction),
    expected_failure_signal: firstNonEmptyString(raw.expected_failure_signal, raw.expectedFailureSignal),
    observed_failure_signal: firstNonEmptyString(raw.observed_failure_signal, raw.observedFailureSignal),
    expected_passing_signal: firstNonEmptyString(raw.expected_passing_signal, raw.expectedPassingSignal),
    required_replay: normalizeBoolean(raw.required_replay ?? raw.requiredReplay, true),
    captured_at: firstNonEmptyString(raw.captured_at, raw.capturedAt),
    waiver,
  };
}

function validateDiagnosisArtifactShape(artifact) {
  if (!artifact) {
    return {
      usable: false,
      missing_fields: ["diagnosis.json"],
    };
  }

  const missingFields = [];
  if (!isMeaningful(artifact.subject_id)) missingFields.push("subject_id");
  if (!isMeaningful(artifact.status)) missingFields.push("status");
  if (!isMeaningful(artifact.proof_type)) missingFields.push("proof_type");
  if (!isMeaningful(artifact.disputed_behavior)) missingFields.push("disputed_behavior");
  if (!isMeaningful(artifact.exact_action)) missingFields.push("exact_action");
  if (!isMeaningful(artifact.expected_failure_signal)) missingFields.push("expected_failure_signal");
  if (!isMeaningful(artifact.observed_failure_signal, { allowExplicitNone: true })) missingFields.push("observed_failure_signal");
  if (!isMeaningful(artifact.expected_passing_signal)) missingFields.push("expected_passing_signal");
  if (!isMeaningful(artifact.captured_at)) missingFields.push("captured_at");
  if (typeof artifact.required_replay !== "boolean") missingFields.push("required_replay");

  const waiverRequired = artifact.status && artifact.status !== "reproduced";
  const waiverApproved = !!artifact.waiver?.reason && !!artifact.waiver?.approved_by;

  if (waiverRequired && !artifact.waiver) {
    missingFields.push("waiver");
  } else if (waiverRequired) {
    if (!artifact.waiver?.reason) missingFields.push("waiver.reason");
    if (!artifact.waiver?.approved_by) missingFields.push("waiver.approved_by");
  }

  return {
    usable: missingFields.length === 0,
    missing_fields: missingFields,
    waiver_required: waiverRequired,
    waiver_approved: waiverApproved,
  };
}

export function assessDiagnosisArtifact(raw, options = {}) {
  const artifact = normalizeDiagnosisArtifact(raw, options);
  const validation = validateDiagnosisArtifactShape(artifact);
  const status = artifact?.status || null;
  const hasApprovedWaiver = !!artifact?.waiver?.reason && !!artifact?.waiver?.approved_by;

  return {
    artifact,
    ...validation,
    status,
    has_approved_waiver: hasApprovedWaiver,
    plan_satisfied: validation.usable && (status === "reproduced" || hasApprovedWaiver),
  };
}

export function loadDiagnosisArtifact(planDir, options = {}) {
  const path = diagnosisArtifactPath(planDir);
  if (!existsSync(path)) {
    return {
      path,
      present: false,
      usable: false,
      error: "missing_diagnosis",
      artifact: null,
      missing_fields: ["diagnosis.json"],
      has_approved_waiver: false,
      plan_satisfied: false,
    };
  }

  const parsed = safeReadJson(path);
  if (!parsed) {
    return {
      path,
      present: true,
      usable: false,
      error: "invalid_json",
      artifact: null,
      missing_fields: ["valid_json"],
      has_approved_waiver: false,
      plan_satisfied: false,
    };
  }

  const assessed = assessDiagnosisArtifact(parsed, options);
  return {
    path,
    present: true,
    usable: assessed.usable,
    error: assessed.usable ? null : "invalid_shape",
    artifact: assessed.artifact,
    missing_fields: assessed.missing_fields,
    has_approved_waiver: assessed.has_approved_waiver,
    plan_satisfied: assessed.plan_satisfied,
  };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownSection(content, heading) {
  if (!content || !heading) return "";
  const match = String(content).match(new RegExp(`^## ${escapeRegex(heading)}\\s*$`, "m"));
  if (!match || match.index === undefined) return "";
  const afterHeading = String(content).slice(match.index + match[0].length).replace(/^\n/, "");
  const nextHeadingMatch = afterHeading.match(/\n## |\n# /);
  return nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
}

function extractLabeledSectionValue(section, labels) {
  const lines = String(section || "").split("\n");
  for (const rawLabel of labels) {
    const normalizedLabel = String(rawLabel).trim().toLowerCase();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;
      const label = line.slice(0, colonIndex).trim().toLowerCase();
      if (label !== normalizedLabel) continue;
      const inlineValue = line.slice(colonIndex + 1).trim();
      if (inlineValue) return inlineValue;
      const collected = [];
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const nextLine = lines[cursor];
        if (!nextLine.trim()) break;
        if (/^[A-Za-z][A-Za-z0-9 _/-]*:/.test(nextLine.trim())) break;
        collected.push(nextLine.trim());
      }
      return collected.join(" ").trim();
    }
  }
  return "";
}

export function normalizeCorrectiveOutcome(value) {
  const normalized = normalizeFlatText(value);
  if (!normalized) return null;
  if (normalized === "unverified") return "unverified";
  const status = normalizeVerificationStatus(normalized, "execution");
  if (status.kind === "pass") return "pass";
  if (status.kind === "fail") return "fail";
  return normalized;
}

export function parseCurrentFailureProofSection(section, { includeOutcome = false } = {}) {
  const trimmed = String(section || "").trim();
  const parsed = {
    present: !!trimmed,
    diagnosis_subject: extractLabeledSectionValue(trimmed, ["Diagnosis subject"]),
    diagnosis_status: extractLabeledSectionValue(trimmed, ["Diagnosis status"]),
    disputed_behavior: extractLabeledSectionValue(trimmed, ["Disputed behavior"]),
    chosen_proof_type_raw: extractLabeledSectionValue(trimmed, ["Chosen proof type"]),
    exact_command_or_action: extractLabeledSectionValue(trimmed, ["Exact command or action"]),
    expected_failing_signal_now: extractLabeledSectionValue(trimmed, ["Expected failing signal now"]),
    expected_passing_signal_after_change: extractLabeledSectionValue(trimmed, ["Expected passing signal after the change", "Expected passing signal after change"]),
    waiver_raw: extractLabeledSectionValue(trimmed, ["Diagnosis waiver", "Waiver"]),
    outcome_raw: includeOutcome ? extractLabeledSectionValue(trimmed, ["Outcome"]) : "",
    observed_signal: includeOutcome ? extractLabeledSectionValue(trimmed, ["Observed signal"]) : "",
  };
  parsed.chosen_proof_type = normalizeAllowedProofType(parsed.chosen_proof_type_raw);
  parsed.outcome = includeOutcome ? normalizeCorrectiveOutcome(parsed.outcome_raw) : null;
  parsed.missing_fields = [];
  if (!isMeaningful(parsed.chosen_proof_type_raw)) parsed.missing_fields.push("Chosen proof type");
  if (!isMeaningful(parsed.exact_command_or_action)) parsed.missing_fields.push("Exact command or action");
  if (!includeOutcome) {
    if (!isMeaningful(parsed.disputed_behavior)) parsed.missing_fields.push("Disputed behavior");
    if (!isMeaningful(parsed.expected_failing_signal_now)) parsed.missing_fields.push("Expected failing signal now");
    if (!isMeaningful(parsed.expected_passing_signal_after_change)) parsed.missing_fields.push("Expected passing signal after the change");
  } else {
    if (!isMeaningful(parsed.outcome_raw)) parsed.missing_fields.push("Outcome");
    if (!isMeaningful(parsed.observed_signal, { allowExplicitNone: true })) parsed.missing_fields.push("Observed signal");
  }
  parsed.complete = parsed.present && parsed.missing_fields.length === 0;
  return parsed;
}

function normalizeWaiverDisplay(artifact) {
  if (!artifact?.waiver?.reason) return null;
  return artifact.waiver.approved_by
    ? `${artifact.waiver.reason} (approved by ${artifact.waiver.approved_by})`
    : artifact.waiver.reason;
}

export function renderDiagnosisPlanSection(artifact) {
  if (!artifact) return "";
  const lines = [
    `Diagnosis subject: ${artifact.subject_id || "plan:current-failure"}`,
    `Diagnosis status: ${artifact.status || "unknown"}`,
    `Disputed behavior: ${artifact.disputed_behavior || "*"}`,
    `Chosen proof type: ${artifact.proof_type || artifact.proof_type_raw || "*"}`,
    `Exact command or action: ${artifact.exact_action || "*"}`,
    `Expected failing signal now: ${artifact.expected_failure_signal || "*"}`,
    `Expected passing signal after the change: ${artifact.expected_passing_signal || "*"}`,
  ];
  const waiverDisplay = normalizeWaiverDisplay(artifact);
  if (waiverDisplay) lines.push(`Diagnosis waiver: ${waiverDisplay}`);
  return `${lines.join("\n")}\n`;
}

export function renderDiagnosisOutcomeSection(artifact, existingSection = "") {
  if (!artifact) return "";
  const existing = parseCurrentFailureProofSection(existingSection, { includeOutcome: true });
  const outcomeRaw = firstNonEmptyString(existing.outcome_raw, "PENDING");
  const observedSignal = firstNonEmptyString(existing.observed_signal, "*To be recorded during VALIDATE.*");
  const lines = [
    `Diagnosis subject: ${artifact.subject_id || "plan:current-failure"}`,
    `Diagnosis status: ${artifact.status || "unknown"}`,
    `Chosen proof type: ${artifact.proof_type || artifact.proof_type_raw || "*"}`,
    `Exact command or action: ${artifact.exact_action || "*"}`,
    `Outcome: ${outcomeRaw}`,
    `Observed signal: ${observedSignal}`,
  ];
  const waiverDisplay = normalizeWaiverDisplay(artifact);
  if (waiverDisplay) lines.push(`Diagnosis waiver: ${waiverDisplay}`);
  return `${lines.join("\n")}\n`;
}

export function diagnosisPlanSectionMatchesArtifact(parsedSection, artifact) {
  if (!parsedSection?.present || !artifact) return false;
  return normalizeFlatText(parsedSection.diagnosis_subject || artifact.subject_id) === normalizeFlatText(artifact.subject_id) &&
    normalizeFlatText(parsedSection.diagnosis_status || artifact.status) === normalizeFlatText(artifact.status) &&
    normalizeFlatText(parsedSection.disputed_behavior) === normalizeFlatText(artifact.disputed_behavior) &&
    normalizeFlatText(parsedSection.chosen_proof_type || parsedSection.chosen_proof_type_raw) === normalizeFlatText(artifact.proof_type) &&
    normalizeFlatText(parsedSection.exact_command_or_action) === normalizeFlatText(artifact.exact_action) &&
    normalizeFlatText(parsedSection.expected_failing_signal_now) === normalizeFlatText(artifact.expected_failure_signal) &&
    normalizeFlatText(parsedSection.expected_passing_signal_after_change) === normalizeFlatText(artifact.expected_passing_signal);
}

export function diagnosisOutcomeSectionMatchesArtifact(parsedSection, artifact) {
  if (!parsedSection?.present || !artifact) return false;
  return normalizeFlatText(parsedSection.diagnosis_subject || artifact.subject_id) === normalizeFlatText(artifact.subject_id) &&
    normalizeFlatText(parsedSection.diagnosis_status || artifact.status) === normalizeFlatText(artifact.status) &&
    normalizeFlatText(parsedSection.chosen_proof_type || parsedSection.chosen_proof_type_raw) === normalizeFlatText(artifact.proof_type) &&
    normalizeFlatText(parsedSection.exact_command_or_action) === normalizeFlatText(artifact.exact_action);
}

function replaceMarkdownSection(content, heading, body) {
  const text = String(content || "");
  const headingPattern = new RegExp(`^## ${escapeRegex(heading)}\\s*$`, "m");
  const match = text.match(headingPattern);
  const normalizedBody = String(body || "").trimEnd();
  if (!match || match.index === undefined) {
    const suffix = text.endsWith("\n") ? "" : "\n";
    return `${text}${suffix}\n## ${heading}\n${normalizedBody}\n`;
  }

  const afterStart = match.index + match[0].length;
  const afterHeading = text.slice(afterStart).replace(/^\n/, "");
  const nextHeadingMatch = afterHeading.match(/\n## |\n# /);
  const before = text.slice(0, afterStart);
  const after = nextHeadingMatch ? afterHeading.slice(nextHeadingMatch.index) : "";
  return `${before}\n${normalizedBody}${after.startsWith("\n") ? "" : "\n"}${after}`;
}

export function syncDiagnosisMarkdown(planDir, artifact) {
  const planPath = join(planDir, "plan.md");
  const verificationPath = join(planDir, "verification.md");
  const planContent = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
  const verificationContent = existsSync(verificationPath) ? readFileSync(verificationPath, "utf-8") : "";
  const nextPlan = replaceMarkdownSection(planContent, "Current Failure Proof", renderDiagnosisPlanSection(artifact));
  const existingOutcomeSection = extractMarkdownSection(verificationContent, "Current Failure Proof Outcome");
  const nextVerification = replaceMarkdownSection(
    verificationContent,
    "Current Failure Proof Outcome",
    renderDiagnosisOutcomeSection(artifact, existingOutcomeSection),
  );
  writeFileSync(planPath, nextPlan);
  writeFileSync(verificationPath, nextVerification);
  return {
    plan_path: planPath,
    verification_path: verificationPath,
  };
}

export function writeDiagnosisArtifact(planDir, rawArtifact) {
  const normalized = normalizeDiagnosisArtifact(rawArtifact);
  const path = diagnosisArtifactPath(planDir);
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return {
    path,
    artifact: normalized,
  };
}

export function readExistingVerificationOutcomeSection(planDir) {
  const verificationPath = join(planDir, "verification.md");
  if (!existsSync(verificationPath)) return "";
  const verificationContent = readFileSync(verificationPath, "utf-8");
  return extractMarkdownSection(verificationContent, "Current Failure Proof Outcome");
}
