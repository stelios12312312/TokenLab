import { verificationStatusIsPass } from "../../iterative-planner/scripts/lib/verification_status_vocabulary.mjs";

function listCriteria(strategyDocument) {
  return Array.isArray(strategyDocument?.verification_strategy?.criteria)
    ? strategyDocument.verification_strategy.criteria
    : [];
}

function matchesImplementationFile(recordFile, criterionFile) {
  const recordPath = String(recordFile || "").replace(/\\/g, "/");
  const criterionPath = String(criterionFile || "").trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!criterionPath) return true;
  return recordPath === criterionPath
    || recordPath.endsWith(`/${criterionPath}`)
    || recordPath.startsWith(`${criterionPath}/`);
}

function matchingRecords(criterion, annotations) {
  const records = Array.isArray(annotations?.records) ? annotations.records : [];
  return records.filter((record) => {
    const storyIds = Array.isArray(record?.tags?.story_id) ? record.tags.story_id : [];
    const storyMatch = criterion?.story_id ? storyIds.includes(criterion.story_id) : true;
    const fileMatch = criterion?.implementation?.file ? matchesImplementationFile(record.file, criterion.implementation.file) : true;
    return storyMatch && fileMatch;
  });
}

function declaredTests(criterion) {
  return Array.isArray(criterion?.tests) ? criterion.tests : [];
}

function resolveCandidateTests(criterion, records, testResults) {
  const byName = new Map();

  for (const declared of declaredTests(criterion)) {
    if (!declared?.name) continue;
    byName.set(declared.name, {
      name: declared.name,
      exists: true,
      passed: null,
      classification: declared.type || null,
      changed_in_plan: false,
    });
  }

  for (const record of records) {
    for (const testName of Array.isArray(record?.tags?.tested_by) ? record.tags.tested_by : []) {
      const existing = byName.get(testName) || {
        name: testName,
        exists: false,
        passed: null,
        classification: null,
        changed_in_plan: false,
      };
      byName.set(testName, existing);
    }
  }

  for (const [name, result] of Object.entries(testResults || {})) {
    if (!byName.has(name)) continue;
    const current = byName.get(name);
    byName.set(name, {
      ...current,
      exists: result?.exists ?? current.exists,
      passed: typeof result?.passed === "boolean" ? result.passed : current.passed,
      classification: result?.classification || current.classification,
      changed_in_plan: result?.changed_in_plan ?? current.changed_in_plan,
    });
  }

  return [...byName.values()];
}

function evaluateTestObligation(candidates, { expectedClassification = null, requireChanged = false } = {}) {
  if (candidates.length === 0) {
    return {
      obligation_met: false,
      obligation_notes: "No matching @planner:tested_by evidence or declared test entries were found for this criterion",
    };
  }

  const satisfied = candidates.find((candidate) => {
    if (!candidate.exists) return false;
    if (candidate.passed !== true) return false;
    if (expectedClassification && candidate.classification !== expectedClassification) return false;
    if (requireChanged && candidate.changed_in_plan !== true) return false;
    return true;
  });

  if (satisfied) {
    return {
      obligation_met: true,
      obligation_notes: null,
    };
  }

  const notes = candidates.map((candidate) => {
    const parts = [candidate.name];
    parts.push(candidate.exists ? "exists" : "missing");
    parts.push(candidate.passed === true ? "pass" : candidate.passed === false ? "fail" : "not-run");
    if (candidate.classification) parts.push(candidate.classification);
    if (requireChanged) parts.push(candidate.changed_in_plan ? "changed" : "unchanged");
    return parts.join("/");
  }).join("; ");

  return {
    obligation_met: false,
    obligation_notes: notes,
  };
}

export function verifyObligations({ strategyDocument, annotations, testResults = {} }) {
  const findings = [];

  for (const criterion of listCriteria(strategyDocument)) {
    const records = matchingRecords(criterion, annotations);
    const candidates = resolveCandidateTests(criterion, records, testResults);
    let evaluation;

    switch (criterion?.how_verified) {
      case "integration_test":
        evaluation = evaluateTestObligation(candidates, { expectedClassification: "integration" });
        break;
      case "unit_test":
        evaluation = evaluateTestObligation(candidates, { expectedClassification: "unit" });
        break;
      case "regression_test":
        evaluation = evaluateTestObligation(candidates, { requireChanged: true });
        break;
      case "artifact_review":
        evaluation = verificationStatusIsPass(criterion?.persona_audit_result?.verdict, "gate")
          ? { obligation_met: true, obligation_notes: null }
          : { obligation_met: false, obligation_notes: "artifact_review declared but persona_audit_result.verdict != PASS" };
        break;
      case "manual_smoke":
        evaluation = criterion?.waiver
          ? { obligation_met: true, obligation_notes: null }
          : { obligation_met: false, obligation_notes: "manual_smoke declared without waiver metadata" };
        break;
      case "waiver_approved":
        evaluation = criterion?.waiver?.approved_by && criterion?.waiver?.approved_at
          ? { obligation_met: true, obligation_notes: null }
          : { obligation_met: false, obligation_notes: "waiver_approved declared without approved_by/approved_at metadata" };
        break;
      default:
        evaluation = { obligation_met: false, obligation_notes: `Unsupported how_verified value: ${criterion?.how_verified || "<missing>"}` };
        break;
    }

    findings.push({
      criterion_id: criterion?.id || null,
      how_verified: criterion?.how_verified || null,
      obligation_met: evaluation.obligation_met,
      obligation_notes: evaluation.obligation_notes,
      matched_tests: candidates.map((candidate) => candidate.name),
    });
  }

  return {
    ok: findings.every((finding) => finding.obligation_met === true),
    findings,
    summary: {
      total_criteria: findings.length,
      obligations_met: findings.filter((finding) => finding.obligation_met).length,
      obligations_failed: findings.filter((finding) => !finding.obligation_met).length,
    },
  };
}
