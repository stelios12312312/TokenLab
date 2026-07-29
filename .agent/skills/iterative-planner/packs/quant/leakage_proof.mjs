// packs/quant/leakage_proof.mjs — t08 artifact-backed leakage/temporal split proof.
//
// Clean-room schema validator for split evidence. It intentionally validates
// artifact structure and temporal ordering only; domain metrics/numbers live in
// other quant packs.

import { existsSync, readFileSync } from "fs";
import {
  normalizeVerificationStatus,
  verificationStatusIsPass,
} from "../../scripts/lib/verification_status_vocabulary.mjs";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
  return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseDate(value) {
  if (!nonEmpty(value)) return null;
  const text = String(value).trim();
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

function parseRange(value) {
  if (typeof value === "string") {
    const [start, end] = value.split(/\.\.|->| to /i).map((part) => part?.trim());
    return { start, end, startMs: parseDate(start), endMs: parseDate(end) };
  }
  const obj = asObject(value);
  return {
    start: obj.start ?? obj.from ?? obj.begin,
    end: obj.end ?? obj.to ?? obj.stop,
    startMs: parseDate(obj.start ?? obj.from ?? obj.begin),
    endMs: parseDate(obj.end ?? obj.to ?? obj.stop),
  };
}

function rangeValid(range) {
  return Number.isFinite(range.startMs) && Number.isFinite(range.endMs) && range.endMs >= range.startMs;
}

function daysBetween(leftMs, rightMs) {
  return (rightMs - leftMs) / (24 * 60 * 60 * 1000);
}

function addBlocker(blockers, code, message, severity = "high") {
  blockers.push({ code, message, severity });
}

function evaluateRanges(split, blockers, checks) {
  const train = parseRange(split.train);
  const validation = parseRange(split.validation ?? split.val);
  const finalOos = parseRange(split.final_oos ?? split.oos ?? split.out_of_sample);

  checks.split_ranges_present = rangeValid(train) && rangeValid(validation) && rangeValid(finalOos);
  if (!checks.split_ranges_present) {
    addBlocker(blockers, "split_ranges_missing", "train, validation, and final_oos ranges must be present with parseable dates");
    return { train, validation, finalOos };
  }

  checks.split_order_valid = train.endMs < validation.startMs && validation.endMs < finalOos.startMs;
  if (!checks.split_order_valid) {
    addBlocker(blockers, "split_order_invalid", "train, validation, and final_oos ranges must be strictly non-overlapping and chronological");
  }
  return { train, validation, finalOos };
}

function embargoDays(split) {
  const embargo = split.embargo ?? split.embargo_days;
  if (typeof embargo === "number" && Number.isFinite(embargo)) return embargo;
  if (typeof embargo === "string" && embargo.trim()) {
    const parsed = Number(embargo.match(/-?\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const obj = asObject(embargo);
  const parsed = Number(obj.days ?? obj.day_count ?? obj.duration_days);
  return Number.isFinite(parsed) ? parsed : null;
}

function evaluateFolds(split, blockers, checks) {
  const folds = Array.isArray(split.folds) ? split.folds : [];
  checks.fold_boundaries_present = folds.length > 0;
  if (!checks.fold_boundaries_present) {
    addBlocker(blockers, "fold_boundaries_missing", "walk-forward or temporal fold boundaries are required");
    return;
  }

  const gapDays = embargoDays(split);
  let valid = true;
  let embargoValid = true;
  folds.forEach((fold, index) => {
    const row = asObject(fold);
    const trainEnd = parseDate(row.train_end ?? row.trainEnd ?? row.cutoff);
    const testStart = parseDate(row.test_start ?? row.validation_start ?? row.oos_start ?? row.testStart);
    const testEnd = parseDate(row.test_end ?? row.validation_end ?? row.oos_end ?? row.testEnd);
    if (!Number.isFinite(trainEnd) || !Number.isFinite(testStart) || !Number.isFinite(testEnd) || !(testStart > trainEnd) || !(testEnd >= testStart)) {
      valid = false;
      addBlocker(blockers, "fold_order_invalid", `fold ${index + 1} must have train_end < test_start <= test_end`);
      return;
    }
    if (Number.isFinite(gapDays) && daysBetween(trainEnd, testStart) < gapDays) {
      embargoValid = false;
      addBlocker(blockers, "embargo_gap_invalid", `fold ${index + 1} gap is shorter than embargo ${gapDays} day(s)`);
    }
  });
  checks.fold_boundaries_temporal = valid;
  checks.embargo_gap_valid = embargoValid;
}

function evaluateEmbargo(split, blockers, checks) {
  const days = embargoDays(split);
  checks.embargo_present = Number.isFinite(days) && days >= 0;
  if (!checks.embargo_present) {
    addBlocker(blockers, "embargo_missing", "embargo evidence is required for temporal leakage proof");
  }
}

function evaluateKnownAtTime(split, blockers, checks) {
  checks.known_at_time_boundary_present = nonEmpty(
    split.known_at_time_boundary ?? split.known_at_time ?? split.feature_availability,
  );
  if (!checks.known_at_time_boundary_present) {
    addBlocker(blockers, "known_at_time_boundary_missing", "known-at-time feature boundary must be documented in the artifact");
  }
}

function sourceLeakageStatusPasses(status) {
  return verificationStatusIsPass(status, "execution");
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (nonEmpty(value)) return value;
  }
  return null;
}

function boolTrue(...values) {
  return values.some((value) => value === true || normalize(value) === "true");
}

function blockingVerdict(value) {
  return normalizeVerificationStatus(value, "execution").kind === "fail";
}

function provenanceObject(doc) {
  const root = asObject(doc);
  return asObject(
    root.capture_time_provenance ??
    asObject(root.time_join).capture_time_provenance ??
    asObject(root.time_joined_evidence).capture_time_provenance ??
    asObject(root.timestamp_provenance).capture_time_provenance ??
    root.timestamp_provenance,
  );
}

function provenanceHandling(provenance, ...keys) {
  for (const key of keys) {
    const value = provenance[key];
    if (nonEmpty(value)) return value;
  }
  return null;
}

function failClosed(value) {
  return normalize(value) === "fail_closed";
}

export function evaluateNegativeLeakageGuardFixture(artifact = {}) {
  const blockers = [];
  const checks = {};
  const doc = asObject(artifact);
  const negative = asObject(
    doc.negative_fixture ??
    doc.negative_leakage_fixture ??
    doc.leakage_guard_negative_fixture ??
    doc,
  );
  const guard = asObject(
    negative.guard ??
    negative.leakage_guard ??
    negative.observed ??
    negative.actual ??
    negative.result,
  );
  const observed = asObject(negative.observed ?? negative.actual ?? negative.result ?? doc.observed ?? doc.actual ?? doc.result);

  checks.artifact_object_present = Object.keys(doc).length > 0;
  if (!checks.artifact_object_present) {
    addBlocker(blockers, "negative_fixture_empty", "negative leakage fixture must be a JSON object");
  }

  checks.known_bad_input = boolTrue(
    negative.known_bad,
    negative.negative_case,
    negative.expected_bad,
    doc.known_bad,
  );
  if (!checks.known_bad_input) {
    addBlocker(blockers, "negative_fixture_known_bad_missing", "negative leakage fixture must mark the input as known_bad");
  }

  checks.guard_fired = boolTrue(
    negative.guard_fired,
    guard.fired,
    guard.guard_fired,
    observed.guard_fired,
    observed.fired,
  );
  if (!checks.guard_fired) {
    addBlocker(blockers, "negative_fixture_guard_not_firing", "negative leakage fixture must record guard_fired=true");
  }

  const verdict = firstNonEmptyValue(
    negative.verdict,
    negative.status,
    guard.verdict,
    guard.status,
    observed.verdict,
    observed.status,
  );
  checks.known_bad_rejected = blockingVerdict(verdict);
  if (!checks.known_bad_rejected) {
    addBlocker(blockers, "negative_fixture_not_rejected", "negative leakage fixture must show the known-bad input was blocked or rejected");
  }

  return {
    pass: blockers.length === 0,
    blockers,
    warnings: [],
    checks,
    verdict: blockers.length === 0 ? "pass" : "fail",
  };
}

export function evaluateCaptureTimeProvenance(artifact = {}, options = {}) {
  const blockers = [];
  const checks = {};
  const doc = asObject(artifact);
  const provenance = provenanceObject(doc);
  const runClass = normalize(options.runClass);
  const failClosedRequired = ["serious_search", "promotion_candidate"].includes(runClass);

  checks.capture_time_provenance_present = Object.keys(provenance).length > 0;
  if (!checks.capture_time_provenance_present) {
    addBlocker(blockers, "capture_time_provenance_missing", "time-joined evidence must declare capture_time_provenance");
  }

  const source = firstNonEmptyValue(
    provenance.timestamp_source,
    provenance.capture_source,
    provenance.source,
    provenance.observed_at_source,
  );
  checks.capture_time_source_present = nonEmpty(source);
  if (!checks.capture_time_source_present) {
    addBlocker(blockers, "capture_time_source_missing", "capture_time_provenance must name the timestamp source");
  }

  const synthesizedHandling = provenanceHandling(
    provenance,
    "synthesized_timestamp_handling",
    "synthetic_timestamp_handling",
    "synthesized_handling",
  );
  checks.synthesized_timestamp_handling_present = nonEmpty(synthesizedHandling);
  if (!checks.synthesized_timestamp_handling_present) {
    addBlocker(blockers, "synthesized_timestamp_handling_missing", "capture_time_provenance must state synthesized timestamp handling");
  }

  const unverifiableHandling = provenanceHandling(
    provenance,
    "unverifiable_timestamp_handling",
    "unverified_timestamp_handling",
    "unknown_timestamp_handling",
  );
  checks.unverifiable_timestamp_handling_present = nonEmpty(unverifiableHandling);
  if (!checks.unverifiable_timestamp_handling_present) {
    addBlocker(blockers, "unverifiable_timestamp_handling_missing", "capture_time_provenance must state unverifiable timestamp handling");
  }

  if (failClosedRequired) {
    checks.synthesized_timestamp_fail_closed = failClosed(synthesizedHandling);
    checks.unverifiable_timestamp_fail_closed = failClosed(unverifiableHandling);
    if (!checks.synthesized_timestamp_fail_closed || !checks.unverifiable_timestamp_fail_closed) {
      addBlocker(blockers, "serious_run_timestamp_handling_not_fail_closed", "serious_search and promotion_candidate evidence must fail closed for synthesized or unverifiable timestamps");
    }
  }

  return {
    pass: blockers.length === 0,
    blockers,
    warnings: [],
    checks,
    run_class: runClass || null,
    fail_closed_required: failClosedRequired,
    verdict: blockers.length === 0 ? "pass" : "fail",
  };
}

function evaluateSourceLeakageScan(scan, blockers, checks) {
  const obj = asObject(scan);
  checks.source_leakage_scan_present = Object.keys(obj).length > 0;
  if (!checks.source_leakage_scan_present) {
    addBlocker(blockers, "source_leakage_scan_missing", "QU-006 source-leakage scan result is required");
    return;
  }

  checks.source_leakage_scan_passed = sourceLeakageStatusPasses(obj.status ?? obj.verdict);
  if (!checks.source_leakage_scan_passed) {
    addBlocker(blockers, "source_leakage_scan_failed", "source-leakage scan status is not passing");
  }

  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  const qu006 = findings.find((finding) => {
    const row = asObject(finding);
    return normalize(row.id ?? row.code ?? row.rule).startsWith("qu_006");
  });
  checks.source_leakage_scan_qu006_clear = !qu006;
  if (qu006) {
    addBlocker(blockers, "source_leakage_scan_qu006", "QU-006 source-leakage finding blocks leakage proof");
  }

  const severe = findings.find((finding) => {
    const row = asObject(finding);
    const severity = normalize(row.severity);
    return ["high", "critical"].includes(severity) ||
      normalizeVerificationStatus(row.status, "execution").kind === "fail";
  });
  checks.source_leakage_scan_severity_clear = !severe;
  if (severe && severe !== qu006) {
    addBlocker(blockers, "source_leakage_scan_blocking_finding", "source-leakage scan contains a blocking finding");
  }
}

function assertionStatusPasses(assertion) {
  const authored = assertion.status ?? assertion.verdict ?? assertion.result;
  if (nonEmpty(authored)) return verificationStatusIsPass(authored, "execution");
  const explicitBoolean = [assertion.pass, assertion.passed, assertion.satisfied]
    .find((value) => typeof value === "boolean");
  if (explicitBoolean === undefined) return false;
  return verificationStatusIsPass(explicitBoolean ? "pass" : "fail", "execution");
}

function assertionProvenancePresent(assertion) {
  const provenance = asObject(
    assertion.provenance ??
    assertion.computed_from ??
    assertion.source_provenance ??
    assertion.receipt,
  );
  return Object.keys(provenance).length > 0 && nonEmpty(firstNonEmptyValue(
    provenance.source_artifact,
    provenance.artifact,
    provenance.source,
    provenance.producer,
    provenance.algorithm,
    assertion.source_artifact,
    assertion.artifact,
  ));
}

function assertionComputed(assertion) {
  return boolTrue(assertion.computed, assertion.measured, assertion.machine_generated, assertion.programmatic) ||
    nonEmpty(assertion.formula ?? assertion.metric ?? assertion.check) ||
    assertionProvenancePresent(assertion);
}

function normalizeComputedAssertions(value) {
  if (Array.isArray(value)) return value.map(asObject);
  const obj = asObject(value);
  return Object.entries(obj).map(([id, assertion]) => ({ id, ...asObject(assertion) }));
}

function evaluateComputedAssertions(value, blockers, checks) {
  const assertions = normalizeComputedAssertions(value);
  checks.computed_assertions_present = assertions.length > 0;
  if (!checks.computed_assertions_present) {
    addBlocker(blockers, "computed_assertions_missing", "leakage proof must include computed assertions with provenance");
    return;
  }

  assertions.forEach((assertion, index) => {
    const id = normalize(assertion.id ?? assertion.name ?? assertion.check ?? `assertion_${index + 1}`) || `assertion_${index + 1}`;
    const computed = assertionComputed(assertion);
    const provenance = assertionProvenancePresent(assertion);
    const passed = assertionStatusPasses(assertion);

    checks[`computed_assertion_${id}_computed`] = computed;
    checks[`computed_assertion_${id}_provenance`] = provenance;
    checks[`computed_assertion_${id}_passed`] = passed;

    if (!computed) {
      addBlocker(blockers, "computed_assertion_not_computed", `computed assertion ${id} must be machine-derived or measured`);
    }
    if (!provenance) {
      addBlocker(blockers, "computed_assertion_without_provenance", `computed assertion ${id} must cite source provenance`);
    }
    if (!passed) {
      addBlocker(blockers, "computed_assertion_failed", `computed assertion ${id} did not pass`);
    }
  });
}

function semanticGateFor(checks, blockers) {
  return {
    id: "leakage_audit",
    measured: blockers.length,
    threshold: { op: "<=", value: 0 },
    satisfied: blockers.length === 0,
    criteria: Object.entries(checks).map(([id, measured]) => ({
      id,
      measured: measured === true,
      threshold: { op: "==", value: true },
      satisfied: measured === true,
    })),
  };
}

export function evaluateLeakageProofArtifact(artifact = {}) {
  const blockers = [];
  const warnings = [];
  const checks = {};
  const doc = asObject(artifact);
  const split = asObject(doc.split_evidence ?? doc.temporal_split ?? doc.split_proof);

  checks.artifact_object_present = Object.keys(doc).length > 0;
  if (!checks.artifact_object_present) {
    addBlocker(blockers, "artifact_empty", "leakage proof artifact must be a JSON object");
  }

  checks.split_evidence_present = Object.keys(split).length > 0;
  if (!checks.split_evidence_present) {
    addBlocker(blockers, "split_evidence_missing", "split_evidence section is required");
  } else {
    evaluateRanges(split, blockers, checks);
    evaluateEmbargo(split, blockers, checks);
    evaluateFolds(split, blockers, checks);
    evaluateKnownAtTime(split, blockers, checks);
  }

  evaluateSourceLeakageScan(doc.source_leakage_scan ?? doc.source_scan ?? doc.qu006_scan, blockers, checks);
  evaluateComputedAssertions(
    doc.computed_assertions ??
    doc.assertions ??
    asObject(doc.leakage_audit).computed_assertions,
    blockers,
    checks,
  );

  return {
    pass: blockers.length === 0,
    blockers,
    warnings,
    checks,
    semantic_gate: semanticGateFor(checks, blockers),
    verdict: blockers.length === 0 ? "pass" : "fail",
  };
}

export function evaluateLeakageProofFile(filePath) {
  if (!filePath) {
    return {
      pass: false,
      blockers: [{ code: "artifact_missing", message: "leakage proof artifact path is missing", severity: "high" }],
      warnings: [],
      checks: {},
      semantic_gate: semanticGateFor({}, [{ code: "artifact_missing" }]),
      verdict: "fail",
    };
  }
  if (!existsSync(filePath)) {
    return {
      pass: false,
      blockers: [{ code: "artifact_missing", message: `leakage proof artifact not found: ${filePath}`, severity: "high" }],
      warnings: [],
      checks: {},
      artifact_path: filePath,
      semantic_gate: semanticGateFor({}, [{ code: "artifact_missing" }]),
      verdict: "fail",
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return { ...evaluateLeakageProofArtifact(parsed), artifact_path: filePath };
  } catch (error) {
    return {
      pass: false,
      blockers: [{ code: "artifact_invalid_json", message: error?.message || "invalid JSON", severity: "high" }],
      warnings: [],
      checks: {},
      artifact_path: filePath,
      semantic_gate: semanticGateFor({}, [{ code: "artifact_invalid_json" }]),
      verdict: "fail",
    };
  }
}
