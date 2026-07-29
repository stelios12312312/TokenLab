// persona_artifacts.mjs — shared normalization helpers for persona JSON artifacts.

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function uniqueList(values) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function normalizeIssue(issue) {
  if (!issue || typeof issue !== "object") return null;
  const code = firstNonEmptyString(issue.code, "persona_artifact_issue");
  const artifact = firstNonEmptyString(issue.artifact, issue.file, "persona artifact");
  const message = firstNonEmptyString(issue.message, `${artifact} has a persona artifact issue`);
  return {
    artifact,
    severity: firstNonEmptyString(issue.severity, "warning"),
    code,
    message,
  };
}

function artifactIssue({ artifact, code, message, severity = "warning" }) {
  return normalizeIssue({ artifact, code, message, severity });
}

function normalizeSeverityKey(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function incrementCount(counts, key) {
  const normalizedKey = normalizeSeverityKey(key);
  counts[normalizedKey] = (counts[normalizedKey] || 0) + 1;
}

function normalizeStoryRefs(subject) {
  return uniqueList([
    ...asArray(subject?.story_refs),
    ...asArray(subject?.stories),
    ...asArray(subject?.story),
    ...asArray(subject?._roleAudit?.story_refs),
    ...asArray(subject?._roleAudit?.stories),
    ...asArray(subject?._roleAudit?.story),
  ].map((value) => typeof value === "string" ? value.trim() : null));
}

function extractAnalyzerPackId(subject) {
  const analyzer = firstNonEmptyString(subject?.analyzer);
  if (!analyzer) return null;
  const match = analyzer.match(/^\[([^\]]+)\]/);
  return match && match[1] ? match[1].trim() : null;
}

export function extractPersonaPackId(subject) {
  return firstNonEmptyString(
    subject?.pack_id,
    subject?.packId,
    subject?.role,
    subject?.persona,
    subject?._roleAudit?.pack_id,
    subject?._roleAudit?.packId,
    subject?._roleAudit?.role,
    extractAnalyzerPackId(subject),
  );
}

export function summarizePersonaGuidanceArtifact(document) {
  const items = asArray(document?.items);
  const legacyGuidance = asArray(document?.guidance);
  const normalizedItems = [...items, ...legacyGuidance];
  const issues = [];
  if (legacyGuidance.length > 0) {
    issues.push(artifactIssue({
      artifact: "persona_guidance.json",
      code: "legacy_guidance_shape",
      message: "persona_guidance.json uses legacy guidance[] shape; normalized for compatibility.",
    }));
  }
  const packIds = uniqueList(normalizedItems.map((item) => extractPersonaPackId(item)));
  return {
    present: !!document,
    phase: firstNonEmptyString(document?.phase),
    count: normalizedItems.length,
    pack_ids: packIds,
    legacy_shape: legacyGuidance.length > 0,
    issues,
  };
}

export function summarizePersonaConstraintsArtifact(document) {
  const constraints = asArray(document?.constraints);
  const severityCounts = {};
  const storyRefs = [];
  const packIds = [];
  const blockingIds = [];

  for (const constraint of constraints) {
    const severity = firstNonEmptyString(constraint?.severity, "unknown");
    incrementCount(severityCounts, severity);
    storyRefs.push(...normalizeStoryRefs(constraint));
    packIds.push(extractPersonaPackId(constraint));
    if (["critical", "high"].includes(normalizeSeverityKey(severity))) {
      const blockingId = firstNonEmptyString(constraint?.id, constraint?.constraint);
      if (blockingId) blockingIds.push(blockingId);
    }
  }

  return {
    present: !!document,
    phase: firstNonEmptyString(document?.phase),
    count: constraints.length,
    pack_ids: uniqueList(packIds),
    story_refs: uniqueList(storyRefs),
    severity_counts: severityCounts,
    blocking_ids: uniqueList(blockingIds),
    issues: [],
  };
}

export function summarizePersonaFindingsArtifact(document) {
  const findings = asArray(document?.findings);
  const severityCounts = {};
  const storyRefs = [];
  const packIds = [];
  const categories = [];

  for (const finding of findings) {
    const severity = firstNonEmptyString(finding?._roleAudit?.severity, finding?.severity, "unknown");
    incrementCount(severityCounts, severity);
    storyRefs.push(...normalizeStoryRefs(finding));
    packIds.push(extractPersonaPackId(finding));
    const category = firstNonEmptyString(finding?._roleAudit?.category, finding?.category);
    if (category) categories.push(category);
  }

  return {
    present: !!document,
    gate: firstNonEmptyString(document?.gate),
    count: findings.length,
    pack_ids: uniqueList(packIds),
    story_refs: uniqueList(storyRefs),
    severity_counts: severityCounts,
    categories: uniqueList(categories),
    issues: [],
  };
}

export function summarizePersonaArtifacts({ guidanceDoc = null, constraintsDoc = null, findingsDoc = null, issues = [] } = {}) {
  const guidance = summarizePersonaGuidanceArtifact(guidanceDoc);
  const constraints = summarizePersonaConstraintsArtifact(constraintsDoc);
  const findings = summarizePersonaFindingsArtifact(findingsDoc);
  const normalizedIssues = uniqueList([
    ...asArray(issues).map(normalizeIssue),
    ...guidance.issues,
    ...constraints.issues,
    ...findings.issues,
  ].filter(Boolean).map((issue) => JSON.stringify(issue))).map((encoded) => JSON.parse(encoded));

  return {
    present: guidance.present || constraints.present || findings.present,
    pack_ids: uniqueList([
      ...guidance.pack_ids,
      ...constraints.pack_ids,
      ...findings.pack_ids,
    ]),
    story_refs: uniqueList([
      ...constraints.story_refs,
      ...findings.story_refs,
    ]),
    total_items: guidance.count + constraints.count + findings.count,
    guidance,
    constraints,
    findings,
    issues: normalizedIssues,
  };
}

export function formatPersonaArtifactIssue(issue) {
  const normalized = normalizeIssue(issue);
  if (!normalized) return "";
  return normalized.message;
}
