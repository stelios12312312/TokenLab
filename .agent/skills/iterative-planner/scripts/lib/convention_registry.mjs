import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";

import {
  buildEmptyOntologyDocument,
  getOntologyFactPath,
  loadOntologyFactDocument,
  renderOntologyDocument,
  validateOntologyDocument,
} from "./ontology_schema.mjs";

const CONVENTION_STATUS_VALUES = new Set(["candidate", "active", "deprecated"]);
const REVIEW_DECISION_ALIASES = Object.freeze({
  approve: "approved",
  approved: "approved",
  reject: "rejected",
  rejected: "rejected",
  defer: "deferred",
  deferred: "deferred",
  pending: "pending",
  edit: "pending",
});
const CANDIDATE_REPORT_RELATIVE_DIR = join("reports", "convention_candidates");
const LIFECYCLE_LOG_RELATIVE_PATH = join("reports", "conventions", "lifecycle_log.yaml");

function safeReadJson(filePath) {
  try {
    if (!existsSync(filePath)) {
      return { ok: false, present: false, value: null, error: "missing" };
    }
    return {
      ok: true,
      present: true,
      value: JSON.parse(readFileSync(filePath, "utf-8")),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      present: true,
      value: null,
      error: error.message || "invalid_json_compatible_yaml",
    };
  }
}

function writeJsonDocument(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeRequirementFingerprint(requirements) {
  return JSON.stringify(
    (Array.isArray(requirements) ? requirements : [])
      .map((requirement) => {
        if (typeof requirement === "string") return requirement.trim();
        if (!isPlainObject(requirement)) return requirement;
        return Object.fromEntries(
          Object.entries(requirement)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, Array.isArray(entryValue) ? [...entryValue].sort() : entryValue])
        );
      })
  );
}

export function buildConventionFingerprint(convention) {
  return JSON.stringify({
    scope: convention?.scope || null,
    domain: convention?.domain || null,
    file_patterns: [...(convention?.applies_to?.file_patterns || [])].sort(),
    class_patterns: [...(convention?.applies_to?.class_patterns || [])].sort(),
    change_classes: [...(convention?.applies_to?.change_classes || [])].sort(),
    requirements: normalizeRequirementFingerprint(convention?.requires),
  });
}

export function parseConventionNumericId(value) {
  const match = /^CONV-(\d+)$/i.exec(String(value || "").trim());
  return match ? Number(match[1]) : null;
}

function formatConventionId(number) {
  return `CONV-${String(number).padStart(3, "0")}`;
}

function normalizeDecision(value) {
  if (value === null || value === undefined) return null;
  const normalized = REVIEW_DECISION_ALIASES[String(value).trim().toLowerCase()];
  return normalized || null;
}

function normalizeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CONVENTION_STATUS_VALUES.has(normalized) ? normalized : null;
}

function reportSortKey(filePath) {
  try {
    const stats = statSync(filePath);
    return `${String(stats.mtimeMs).padStart(16, "0")}:${basename(filePath)}`;
  } catch {
    return `0000000000000000:${basename(filePath)}`;
  }
}

export function listConventionCandidateReportPaths({ cwd = process.cwd() } = {}) {
  const directoryPath = join(cwd, CANDIDATE_REPORT_RELATIVE_DIR);
  if (!existsSync(directoryPath)) return [];
  return readdirSync(directoryPath)
    .filter((name) => /\.(yaml|yml)$/i.test(name))
    .filter((name) => !/\.review\.(yaml|yml)$/i.test(name))
    .map((name) => join(directoryPath, name))
    .sort((left, right) => reportSortKey(right).localeCompare(reportSortKey(left)));
}

export function loadConventionCandidateReport({ cwd = process.cwd(), reportPath = null } = {}) {
  const absolutePath = reportPath
    ? resolve(cwd, reportPath)
    : listConventionCandidateReportPaths({ cwd })[0] || null;

  if (!absolutePath) {
    return {
      ok: false,
      cwd,
      path: null,
      relative_path: null,
      report: null,
      candidates: [],
      issues: ["No convention candidate reports found under reports/convention_candidates/"],
    };
  }

  const parsed = safeReadJson(absolutePath);
  if (!parsed.present) {
    return {
      ok: false,
      cwd,
      path: absolutePath,
      relative_path: relative(cwd, absolutePath),
      report: null,
      candidates: [],
      issues: [`Convention candidate report missing at ${absolutePath}`],
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      cwd,
      path: absolutePath,
      relative_path: relative(cwd, absolutePath),
      report: null,
      candidates: [],
      issues: [`Convention candidate report unreadable: ${parsed.error}`],
    };
  }

  const root = parsed.value?.convention_candidates;
  const candidates = Array.isArray(root?.candidates) ? root.candidates : null;
  if (!isPlainObject(root) || !Array.isArray(candidates)) {
    return {
      ok: false,
      cwd,
      path: absolutePath,
      relative_path: relative(cwd, absolutePath),
      report: null,
      candidates: [],
      issues: [`Convention candidate report at ${absolutePath} must contain convention_candidates.candidates[]`],
    };
  }

  return {
    ok: true,
    cwd,
    path: absolutePath,
    relative_path: relative(cwd, absolutePath),
    report: root,
    candidates,
    issues: [],
  };
}

function defaultReviewPath(reportPath) {
  return reportPath.replace(/\.(yaml|yml)$/i, ".review.yaml");
}

function buildReviewEntry(candidate) {
  return {
    id: candidate.id,
    title: candidate.title,
    decision: "pending",
    notes: null,
    reviewed_by: null,
    reviewed_at: null,
    approved_by: null,
    edits: {},
    promoted_at: null,
    promoted_status: null,
  };
}

function buildReviewDocument(reportInfo) {
  return {
    convention_candidate_review: {
      version: 1,
      report_path: reportInfo.relative_path,
      report_generated_at: reportInfo.report.generated_at || null,
      updated_at: new Date().toISOString(),
      candidate_count: reportInfo.candidates.length,
      reviews: reportInfo.candidates.map((candidate) => buildReviewEntry(candidate)),
    },
  };
}

function mergeReviewDocument(reportInfo, existingDocument = null) {
  const current = isPlainObject(existingDocument?.convention_candidate_review)
    ? existingDocument.convention_candidate_review
    : null;
  const existingReviews = new Map(
    Array.isArray(current?.reviews)
      ? current.reviews
          .filter((entry) => isPlainObject(entry) && normalizeString(entry.id))
          .map((entry) => [entry.id.trim(), entry])
      : []
  );

  const reviews = reportInfo.candidates.map((candidate) => {
    const existing = existingReviews.get(candidate.id);
    return {
      ...buildReviewEntry(candidate),
      ...(existing || {}),
      id: candidate.id,
      title: candidate.title,
      edits: isPlainObject(existing?.edits) ? cloneJson(existing.edits) : {},
    };
  });

  return {
    convention_candidate_review: {
      version: 1,
      report_path: reportInfo.relative_path,
      report_generated_at: reportInfo.report.generated_at || null,
      updated_at: new Date().toISOString(),
      candidate_count: reportInfo.candidates.length,
      reviews,
    },
  };
}

function validateReviewDocument(document, reportInfo) {
  const root = document?.convention_candidate_review;
  if (!isPlainObject(root)) return "convention_candidate_review top-level object is required";
  if (!Array.isArray(root.reviews)) return "convention_candidate_review.reviews must be an array";
  const knownCandidateIds = new Set(reportInfo.candidates.map((candidate) => candidate.id));
  for (const entry of root.reviews) {
    if (!isPlainObject(entry) || !normalizeString(entry.id)) {
      return "convention_candidate_review.reviews entries must declare a non-empty id";
    }
    if (!knownCandidateIds.has(entry.id)) {
      return `review entry ${entry.id} does not exist in ${reportInfo.relative_path}`;
    }
    if (!normalizeDecision(entry.decision || "pending")) {
      return `review entry ${entry.id} has an invalid decision`;
    }
  }
  return null;
}

function writeReviewDocument(path, document) {
  const next = cloneJson(document);
  if (next?.convention_candidate_review) {
    next.convention_candidate_review.updated_at = new Date().toISOString();
  }
  writeJsonDocument(path, next);
}

export function loadConventionCandidateReview({ cwd = process.cwd(), reportPath = null, writeIfMissing = false } = {}) {
  const reportInfo = loadConventionCandidateReport({ cwd, reportPath });
  if (!reportInfo.ok) {
    return {
      ok: false,
      cwd,
      report: reportInfo,
      path: reportInfo.path ? defaultReviewPath(reportInfo.path) : null,
      document: null,
      issues: reportInfo.issues,
    };
  }

  const reviewPath = defaultReviewPath(reportInfo.path);
  const parsed = safeReadJson(reviewPath);
  const baseDocument = !parsed.present
    ? buildReviewDocument(reportInfo)
    : (parsed.ok ? parsed.value : null);

  if (parsed.present && !parsed.ok) {
    return {
      ok: false,
      cwd,
      report: reportInfo,
      path: reviewPath,
      document: null,
      issues: [`Convention review file unreadable: ${parsed.error}`],
    };
  }

  const mergedDocument = mergeReviewDocument(reportInfo, baseDocument);
  const validationError = validateReviewDocument(mergedDocument, reportInfo);
  if (validationError) {
    return {
      ok: false,
      cwd,
      report: reportInfo,
      path: reviewPath,
      document: null,
      issues: [validationError],
    };
  }

  if ((!parsed.present && writeIfMissing) || JSON.stringify(baseDocument) !== JSON.stringify(mergedDocument)) {
    writeReviewDocument(reviewPath, mergedDocument);
  }

  return {
    ok: true,
    cwd,
    report: reportInfo,
    path: reviewPath,
    document: mergedDocument,
    issues: [],
  };
}

function findReviewEntry(reviewInfo, conventionId) {
  return reviewInfo.document?.convention_candidate_review?.reviews?.find((entry) => entry.id === conventionId) || null;
}

function findReportCandidate(reportInfo, conventionId) {
  return reportInfo.candidates.find((candidate) => candidate.id === conventionId) || null;
}

export function applyConventionReview(candidate, reviewEntry) {
  const merged = cloneJson(candidate);
  const edits = isPlainObject(reviewEntry?.edits) ? reviewEntry.edits : {};

  if (normalizeString(edits.title)) merged.title = edits.title.trim();
  if (normalizeString(edits.description)) merged.description = edits.description.trim();
  if (normalizeString(edits.domain)) merged.domain = edits.domain.trim();
  if (normalizeString(edits.scope)) merged.scope = edits.scope.trim();
  if (edits.confidence !== undefined && edits.confidence !== null) merged.confidence = Number(edits.confidence);
  if (isPlainObject(edits.applies_to)) merged.applies_to = cloneJson(edits.applies_to);
  if (Array.isArray(edits.requires)) merged.requires = cloneJson(edits.requires);

  return merged;
}

export function reviewConventionCandidate({
  cwd = process.cwd(),
  reportPath = null,
  conventionId = null,
  decision = null,
  notes = null,
  reviewedBy = null,
  approvedBy = null,
  editPatch = {},
} = {}) {
  const reviewInfo = loadConventionCandidateReview({
    cwd,
    reportPath,
    writeIfMissing: !!conventionId || Object.keys(editPatch || {}).length > 0 || decision !== null || notes !== null,
  });
  if (!reviewInfo.ok) {
    return {
      ok: false,
      cwd,
      report_path: reviewInfo.report?.relative_path || null,
      review_path: reviewInfo.path,
      issues: reviewInfo.issues,
    };
  }

  if (!conventionId) {
    return {
      ok: true,
      cwd,
      report_path: reviewInfo.report.relative_path,
      review_path: relative(cwd, reviewInfo.path),
      review: reviewInfo.document,
    };
  }

  const entry = findReviewEntry(reviewInfo, conventionId);
  const candidate = findReportCandidate(reviewInfo.report, conventionId);
  if (!entry || !candidate) {
    return {
      ok: false,
      cwd,
      report_path: reviewInfo.report.relative_path,
      review_path: relative(cwd, reviewInfo.path),
      issues: [`Convention candidate ${conventionId} not found in ${reviewInfo.report.relative_path}`],
    };
  }

  const normalizedDecision = decision === null ? entry.decision : normalizeDecision(decision);
  if (!normalizedDecision) {
    return {
      ok: false,
      cwd,
      report_path: reviewInfo.report.relative_path,
      review_path: relative(cwd, reviewInfo.path),
      issues: [`Invalid review decision: ${decision}`],
    };
  }

  const nextEdits = {
    ...(isPlainObject(entry.edits) ? cloneJson(entry.edits) : {}),
    ...(isPlainObject(editPatch) ? cloneJson(editPatch) : {}),
  };
  const changed = decision !== null
    || notes !== null
    || normalizeString(reviewedBy)
    || normalizeString(approvedBy)
    || Object.keys(editPatch || {}).length > 0;
  const timestamp = new Date().toISOString();
  const updatedEntry = {
    ...entry,
    decision: normalizedDecision,
    notes: notes === null ? entry.notes : notes,
    reviewed_by: normalizeString(reviewedBy) || entry.reviewed_by || null,
    reviewed_at: changed ? timestamp : entry.reviewed_at,
    approved_by: normalizedDecision === "approved"
      ? (normalizeString(approvedBy) || normalizeString(reviewedBy) || entry.approved_by || "user")
      : null,
    edits: nextEdits,
  };

  const reviews = reviewInfo.document.convention_candidate_review.reviews.map((current) =>
    current.id === conventionId ? updatedEntry : current
  );
  const nextDocument = {
    convention_candidate_review: {
      ...reviewInfo.document.convention_candidate_review,
      reviews,
    },
  };

  if (changed) {
    writeReviewDocument(reviewInfo.path, nextDocument);
  }

  return {
    ok: true,
    cwd,
    report_path: reviewInfo.report.relative_path,
    review_path: relative(cwd, reviewInfo.path),
    review: nextDocument,
    candidate: applyConventionReview(candidate, updatedEntry),
    entry: updatedEntry,
  };
}

function sortConventions(records) {
  return [...records].sort((left, right) => {
    const leftNumeric = parseConventionNumericId(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightNumeric = parseConventionNumericId(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftNumeric !== rightNumeric) return leftNumeric - rightNumeric;
    return String(left.id).localeCompare(String(right.id));
  });
}

export function loadConventionsDocument({ cwd = process.cwd() } = {}) {
  const loaded = loadOntologyFactDocument({ cwd, entityClass: "conventions", allowMissing: false });
  if (!loaded.ok) {
    return {
      ok: false,
      cwd,
      path: loaded.path || getOntologyFactPath("conventions", cwd),
      document: null,
      conventions: [],
      issues: loaded.issues,
    };
  }

  const document = loaded.document || buildEmptyOntologyDocument("conventions");
  return {
    ok: true,
    cwd,
    path: loaded.path || getOntologyFactPath("conventions", cwd),
    document,
    conventions: Array.isArray(document?.conventions?.conventions) ? document.conventions.conventions : [],
    issues: [],
  };
}

function writeConventionsDocument(path, document) {
  const validation = validateOntologyDocument("conventions", document);
  if (!validation.ok) {
    return {
      ok: false,
      issues: validation.issues,
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderOntologyDocument(document));
  return { ok: true, issues: [] };
}

function loadLifecycleLog(cwd) {
  const path = join(cwd, LIFECYCLE_LOG_RELATIVE_PATH);
  const parsed = safeReadJson(path);
  if (!parsed.present) {
    return {
      path,
      document: {
        convention_lifecycle: {
          version: 1,
          updated_at: null,
          events: [],
        },
      },
    };
  }
  if (!parsed.ok || !isPlainObject(parsed.value?.convention_lifecycle) || !Array.isArray(parsed.value.convention_lifecycle.events)) {
    return {
      path,
      document: {
        convention_lifecycle: {
          version: 1,
          updated_at: null,
          events: [],
        },
      },
    };
  }
  return {
    path,
    document: parsed.value,
  };
}

function appendLifecycleEvent(cwd, event) {
  const loaded = loadLifecycleLog(cwd);
  const events = Array.isArray(loaded.document?.convention_lifecycle?.events)
    ? loaded.document.convention_lifecycle.events
    : [];
  const nextId = `CLE-${String(events.length + 1).padStart(3, "0")}`;
  const nextDocument = {
    convention_lifecycle: {
      version: 1,
      updated_at: new Date().toISOString(),
      events: [
        ...events,
        {
          id: nextId,
          at: new Date().toISOString(),
          ...event,
        },
      ],
    },
  };
  writeJsonDocument(loaded.path, nextDocument);
  return {
    path: loaded.path,
    event_id: nextId,
  };
}

export function recordConventionExemptions({
  cwd = process.cwd(),
  planId = null,
  reportPath = null,
  exemptions = [],
} = {}) {
  const normalizedPlanId = normalizeString(planId);
  const lifecycle = loadLifecycleLog(cwd);
  const existingEvents = Array.isArray(lifecycle.document?.convention_lifecycle?.events)
    ? lifecycle.document.convention_lifecycle.events
    : [];
  const relativeReportPath = normalizeString(reportPath)
    ? relative(cwd, resolve(cwd, reportPath))
    : null;
  const recorded = [];

  for (const exemption of Array.isArray(exemptions) ? exemptions : []) {
    const conventionId = normalizeString(exemption?.convention_id || exemption?.id);
    const justification = normalizeString(exemption?.justification || exemption?.reason);
    if (!normalizedPlanId || !conventionId || !justification) continue;

    const approvedBy = normalizeString(exemption?.approved_by) || "unspecified";
    const filePaths = [...new Set(
      (Array.isArray(exemption?.file_paths) ? exemption.file_paths : [])
        .map((entry) => normalizeString(entry))
        .filter(Boolean)
    )];
    const existing = existingEvents.find((event) =>
      event?.action === "exemption"
      && normalizeString(event?.plan_id) === normalizedPlanId
      && normalizeString(event?.convention_id) === conventionId
      && normalizeString(event?.justification) === justification
    );

    if (existing?.id) {
      recorded.push({
        event_id: existing.id,
        created: false,
        convention_id: conventionId,
      });
      continue;
    }

    const appended = appendLifecycleEvent(cwd, {
      action: "exemption",
      plan_id: normalizedPlanId,
      convention_id: conventionId,
      convention_title: normalizeString(exemption?.convention_title) || conventionId,
      approved_by: approvedBy,
      justification,
      report_path: relativeReportPath,
      file_paths: filePaths,
    });
    recorded.push({
      event_id: appended.event_id,
      created: true,
      convention_id: conventionId,
    });
  }

  return {
    ok: true,
    cwd,
    lifecycle_log_path: relative(cwd, lifecycle.path),
    events: recorded,
  };
}

export function collectUsedConventionIds({ cwd = process.cwd() } = {}) {
  const ids = new Set();
  const conventions = loadConventionsDocument({ cwd });
  if (conventions.ok) {
    for (const convention of conventions.conventions) {
      if (normalizeString(convention?.id)) ids.add(convention.id.trim());
    }
  }
  for (const reportPath of listConventionCandidateReportPaths({ cwd })) {
    const report = loadConventionCandidateReport({ cwd, reportPath });
    if (!report.ok) continue;
    for (const candidate of report.candidates) {
      if (normalizeString(candidate?.id)) ids.add(candidate.id.trim());
    }
  }
  return [...ids];
}

export function allocateConventionIds({ cwd = process.cwd(), count = 1 } = {}) {
  const usedIds = collectUsedConventionIds({ cwd });
  const maxNumericId = usedIds.reduce((max, id) => {
    const numeric = parseConventionNumericId(id);
    return numeric !== null && numeric > max ? numeric : max;
  }, 0);
  const total = Math.max(0, Number(count) || 0);
  return Array.from({ length: total }, (_, index) => formatConventionId(maxNumericId + index + 1));
}

export function listConventionInventory({
  cwd = process.cwd(),
  reportPath = null,
  source = "all",
  domain = null,
  status = null,
  confidenceBelow = null,
  reviewDecision = null,
} = {}) {
  const sources = new Set(source === "all" ? ["ontology", "candidate_report"] : [source]);
  const records = [];
  const conventions = loadConventionsDocument({ cwd });
  const activeIds = new Set();

  if (conventions.ok && sources.has("ontology")) {
    for (const convention of conventions.conventions) {
      activeIds.add(convention.id);
      records.push({
        source: "ontology",
        id: convention.id,
        status: convention.status || "candidate",
        review_decision: null,
        title: convention.title || null,
        description: convention.description || null,
        domain: convention.domain || null,
        scope: convention.scope || null,
        confidence: convention.confidence ?? null,
        report_path: null,
      });
    }
  }

  let reportInfo = null;
  let reviewInfo = null;
  if (sources.has("candidate_report")) {
    reportInfo = loadConventionCandidateReport({ cwd, reportPath });
    if (reportInfo.ok) {
      reviewInfo = loadConventionCandidateReview({ cwd, reportPath: reportInfo.path });
      const reviews = new Map(
        (reviewInfo.ok ? reviewInfo.document?.convention_candidate_review?.reviews : [])
          .map((entry) => [entry.id, entry])
      );
      for (const candidate of reportInfo.candidates) {
        const entry = reviews.get(candidate.id) || buildReviewEntry(candidate);
        if (entry.promoted_at && activeIds.has(candidate.id)) continue;
        const effective = applyConventionReview(candidate, entry);
        records.push({
          source: "candidate_report",
          id: candidate.id,
          status: candidate.status || "candidate",
          review_decision: entry.decision || "pending",
          title: effective.title || null,
          description: effective.description || null,
          domain: effective.domain || null,
          scope: effective.scope || null,
          confidence: effective.confidence ?? null,
          report_path: reportInfo.relative_path,
        });
      }
    }
  }

  const normalizedStatus = status ? normalizeStatus(status) : null;
  const normalizedReviewDecision = reviewDecision ? normalizeDecision(reviewDecision) : null;
  const confidenceThreshold = confidenceBelow === null ? null : Number(confidenceBelow);
  const filtered = records.filter((record) => {
    if (domain && record.domain !== domain) return false;
    if (normalizedStatus && record.status !== normalizedStatus) return false;
    if (normalizedReviewDecision && record.review_decision !== normalizedReviewDecision) return false;
    if (Number.isFinite(confidenceThreshold) && !(Number(record.confidence) < confidenceThreshold)) return false;
    return true;
  });

  return {
    ok: true,
    cwd,
    report_path: reportInfo?.ok ? reportInfo.relative_path : null,
    records: sortConventions(filtered),
    summary: {
      total: filtered.length,
      ontology: filtered.filter((record) => record.source === "ontology").length,
      candidate_report: filtered.filter((record) => record.source === "candidate_report").length,
      by_status: {
        candidate: filtered.filter((record) => record.status === "candidate").length,
        active: filtered.filter((record) => record.status === "active").length,
        deprecated: filtered.filter((record) => record.status === "deprecated").length,
      },
      pending_review: filtered.filter((record) => record.review_decision === "pending").length,
      approved_review: filtered.filter((record) => record.review_decision === "approved").length,
      rejected_review: filtered.filter((record) => record.review_decision === "rejected").length,
      deferred_review: filtered.filter((record) => record.review_decision === "deferred").length,
    },
    issues: [],
  };
}

export function promoteConventionCandidate({
  cwd = process.cwd(),
  reportPath = null,
  conventionId,
  status = "active",
  approvedBy = "user",
} = {}) {
  const normalizedStatus = normalizeStatus(status);
  if (!normalizedStatus || normalizedStatus === "candidate") {
    return {
      ok: false,
      cwd,
      report_path: null,
      issues: [`Convention promotion status must be active or deprecated, received ${status}`],
    };
  }

  const reviewInfo = loadConventionCandidateReview({ cwd, reportPath, writeIfMissing: false });
  if (!reviewInfo.ok) {
    return {
      ok: false,
      cwd,
      report_path: reviewInfo.report?.relative_path || null,
      issues: reviewInfo.issues,
    };
  }

  const entry = findReviewEntry(reviewInfo, conventionId);
  const candidate = findReportCandidate(reviewInfo.report, conventionId);
  if (!entry || !candidate) {
    return {
      ok: false,
      cwd,
      report_path: reviewInfo.report.relative_path,
      issues: [`Convention candidate ${conventionId} not found in ${reviewInfo.report.relative_path}`],
    };
  }
  if (entry.decision !== "approved") {
    return {
      ok: false,
      cwd,
      report_path: reviewInfo.report.relative_path,
      issues: [`Convention candidate ${conventionId} must be approved in ${relative(cwd, reviewInfo.path)} before promotion`],
    };
  }

  const effective = {
    ...applyConventionReview(candidate, entry),
    id: candidate.id,
    status: normalizedStatus,
  };

  const conventions = loadConventionsDocument({ cwd });
  if (!conventions.ok) {
    return {
      ok: false,
      cwd,
      report_path: reviewInfo.report.relative_path,
      issues: conventions.issues,
    };
  }

  const nextRecords = [...conventions.conventions];
  const existingIndex = nextRecords.findIndex((record) => record.id === conventionId);
  if (existingIndex >= 0) {
    if (buildConventionFingerprint(nextRecords[existingIndex]) !== buildConventionFingerprint(effective)) {
      return {
        ok: false,
        cwd,
        report_path: reviewInfo.report.relative_path,
        issues: [`Convention id conflict: ${conventionId} already exists in ${relative(cwd, conventions.path)} with different requirements`],
      };
    }
    nextRecords[existingIndex] = {
      ...nextRecords[existingIndex],
      ...effective,
    };
  } else {
    nextRecords.push(effective);
  }

  const nextDocument = {
    conventions: {
      version: 1,
      conventions: sortConventions(nextRecords),
    },
  };
  const writeResult = writeConventionsDocument(conventions.path, nextDocument);
  if (!writeResult.ok) {
    return {
      ok: false,
      cwd,
      report_path: reviewInfo.report.relative_path,
      issues: writeResult.issues,
    };
  }

  const timestamp = new Date().toISOString();
  const reviews = reviewInfo.document.convention_candidate_review.reviews.map((current) =>
    current.id === conventionId
      ? {
          ...current,
          promoted_at: timestamp,
          promoted_status: normalizedStatus,
          approved_by: normalizeString(approvedBy) || current.approved_by || "user",
        }
      : current
  );
  writeReviewDocument(reviewInfo.path, {
    convention_candidate_review: {
      ...reviewInfo.document.convention_candidate_review,
      reviews,
    },
  });

  const lifecycle = appendLifecycleEvent(cwd, {
    action: "promote",
    convention_id: conventionId,
    convention_title: effective.title || candidate.title || conventionId,
    from_status: "candidate",
    to_status: normalizedStatus,
    report_path: reviewInfo.report.relative_path,
    review_path: relative(cwd, reviewInfo.path),
    approved_by: normalizeString(approvedBy) || entry.approved_by || "user",
    reviewed_by: entry.reviewed_by || null,
  });

  return {
    ok: true,
    cwd,
    report_path: reviewInfo.report.relative_path,
    review_path: relative(cwd, reviewInfo.path),
    conventions_path: relative(cwd, conventions.path),
    lifecycle_log_path: relative(cwd, lifecycle.path),
    lifecycle_event_id: lifecycle.event_id,
    convention: effective,
  };
}

export function demoteConvention({
  cwd = process.cwd(),
  conventionId,
  status = "candidate",
  justification = null,
  approvedBy = "user",
} = {}) {
  const normalizedStatus = normalizeStatus(status);
  if (!normalizedStatus || normalizedStatus === "active") {
    return {
      ok: false,
      cwd,
      issues: [`Convention demotion status must be candidate or deprecated, received ${status}`],
    };
  }
  if (!normalizeString(justification)) {
    return {
      ok: false,
      cwd,
      issues: [`Convention demotion for ${conventionId} requires --justification`],
    };
  }

  const conventions = loadConventionsDocument({ cwd });
  if (!conventions.ok) {
    return {
      ok: false,
      cwd,
      issues: conventions.issues,
    };
  }

  const target = conventions.conventions.find((record) => record.id === conventionId);
  if (!target) {
    return {
      ok: false,
      cwd,
      issues: [`Convention ${conventionId} not found in ${relative(cwd, conventions.path)}`],
    };
  }

  const previousStatus = target.status || "candidate";
  const nextDocument = {
    conventions: {
      version: 1,
      conventions: sortConventions(
        conventions.conventions.map((record) =>
          record.id === conventionId
            ? { ...record, status: normalizedStatus }
            : record
        )
      ),
    },
  };
  const writeResult = writeConventionsDocument(conventions.path, nextDocument);
  if (!writeResult.ok) {
    return {
      ok: false,
      cwd,
      issues: writeResult.issues,
    };
  }

  const lifecycle = appendLifecycleEvent(cwd, {
    action: "demote",
    convention_id: conventionId,
    convention_title: target.title || conventionId,
    from_status: previousStatus,
    to_status: normalizedStatus,
    approved_by: normalizeString(approvedBy) || "user",
    justification: justification.trim(),
  });

  return {
    ok: true,
    cwd,
    conventions_path: relative(cwd, conventions.path),
    lifecycle_log_path: relative(cwd, lifecycle.path),
    lifecycle_event_id: lifecycle.event_id,
    convention: {
      ...target,
      status: normalizedStatus,
    },
  };
}
