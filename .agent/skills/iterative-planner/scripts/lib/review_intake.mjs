import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, join, relative } from "path";

const LEDGER_FILENAME = "review_intake.json";
const SOURCE_DIRNAME = "review_intake_sources";
const REQUIRED_CLASSIFICATIONS = new Set([]);
const ADVISORY_CLASSIFICATIONS = new Set(["stale_advisory", "stale_blocking"]);
const VALID_DISPOSITIONS = new Set(["verified", "consumed", "rejected", "waived"]);

function safeJson(filePath) {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) : null;
  } catch {
    return null;
  }
}

function safeStat(filePath) {
  try {
    return existsSync(filePath) ? statSync(filePath) : null;
  } catch {
    return null;
  }
}

function stableHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeClassification(value) {
  const text = String(value || "").trim().toLowerCase();
  if (REQUIRED_CLASSIFICATIONS.has(text)) return text;
  if (ADVISORY_CLASSIFICATIONS.has(text)) return text;
  if (text === "blocking" || text === "required") return "stale_blocking";
  if (text === "advisory" || text === "warning") return "stale_advisory";
  return text || "unknown";
}

function compactPath(cwd, filePath) {
  const text = cleanString(filePath);
  if (!text) return null;
  try {
    return relative(cwd, text) || text;
  } catch {
    return text;
  }
}

function sourceArtifact(cwd, filePath) {
  return {
    path: compactPath(cwd, filePath),
    mtime_ms: safeStat(filePath)?.mtimeMs || null,
  };
}

function normalizeDisposition(raw) {
  const source = raw?.disposition && typeof raw.disposition === "object" ? raw.disposition : raw || {};
  const status = cleanString(source.status || source.disposition_status || raw?.status);
  const normalizedStatus = status ? status.toLowerCase() : null;
  const evidenceRefs = cleanStringArray(source.evidence_refs || source.evidence || raw?.evidence_refs);
  const reason = cleanString(
    source.disposition_reason ||
    source.reason ||
    source.rationale ||
    raw?.disposition_reason ||
    raw?.reason,
  );
  const waiverReason = cleanString(source.waiver_reason || raw?.waiver_reason);
  const approvedBy = cleanString(source.approved_by || source.waiver_approved_by || raw?.approved_by || raw?.waiver_approved_by);
  return {
    status: VALID_DISPOSITIONS.has(normalizedStatus) ? normalizedStatus : normalizedStatus,
    evidence_refs: evidenceRefs,
    disposition_reason: reason,
    waiver_reason: waiverReason,
    approved_by: approvedBy,
  };
}

function dispositionIsValid(disposition) {
  if (!VALID_DISPOSITIONS.has(disposition?.status)) return false;
  const validators = {
    verified: (row) => row.evidence_refs.length > 0,
    consumed: (row) => row.evidence_refs.length > 0 || !!row.disposition_reason,
    rejected: (row) => !!row.disposition_reason,
    waived: (row) => !!(row.disposition_reason || row.waiver_reason) && !!row.approved_by,
  };
  return validators[disposition.status]?.(disposition) === true;
}

function readLedger(planDir) {
  const ledgerPath = join(planDir, LEDGER_FILENAME);
  const parsed = safeJson(ledgerPath);
  const dispositions = new Map();
  if (!parsed || typeof parsed !== "object") {
    return { present: false, path: ledgerPath, dispositions };
  }

  const rows = Array.isArray(parsed.items)
    ? parsed.items
    : Array.isArray(parsed.dispositions)
      ? parsed.dispositions
      : [];
  for (const row of rows) {
    const id = cleanString(row?.id || row?.item_id || row?.review_item_id);
    if (!id) continue;
    dispositions.set(id, normalizeDisposition(row));
  }
  if (parsed.dispositions && !Array.isArray(parsed.dispositions) && typeof parsed.dispositions === "object") {
    for (const [id, value] of Object.entries(parsed.dispositions)) {
      if (!cleanString(id)) continue;
      dispositions.set(id, normalizeDisposition(value));
    }
  }
  return { present: true, path: ledgerPath, parsed, dispositions };
}

function buildLlmItem({ finding, classification, sourceKind, sourcePath, sourceIndex, cwd }) {
  const normalizedClassification = normalizeClassification(classification || finding?.classification || finding?.status);
  if (!REQUIRED_CLASSIFICATIONS.has(normalizedClassification) && !ADVISORY_CLASSIFICATIONS.has(normalizedClassification)) {
    return null;
  }
  const sourceKey = [
    sourceKind,
    sourcePath,
    finding?.id,
    finding?.surface,
    finding?.file,
    finding?.line,
    finding?.claim,
    finding?.reason,
    sourceIndex,
  ].filter((value) => value !== undefined && value !== null).join("|");
  const id = cleanString(finding?.id)
    ? `llm:${normalizedClassification}:${finding.id}`
    : `llm:${normalizedClassification}:${stableHash(sourceKey)}`;
  const required = REQUIRED_CLASSIFICATIONS.has(normalizedClassification);
  return {
    id,
    source_kind: sourceKind,
    source_path: compactPath(cwd, sourcePath),
    source_index: sourceIndex,
    required,
    severity: required ? "required" : "advisory",
    classification: normalizedClassification,
    surface: cleanString(finding?.surface),
    file: cleanString(finding?.file),
    line: typeof finding?.line === "number" ? finding.line : null,
    claim: cleanString(finding?.claim),
    reason: cleanString(finding?.reason) || cleanString(finding?.summary),
    recommended_action: cleanString(finding?.recommended_action),
    runtime_truth_refs: cleanStringArray(finding?.runtime_truth_refs),
    confidence: cleanString(finding?.confidence),
  };
}

function collectLlmItemsFromPayload({ payload, sourceKind, sourcePath, cwd }) {
  const findings = Array.isArray(payload?.findings)
    ? payload.findings
    : Array.isArray(payload?.llm_audit?.findings)
      ? payload.llm_audit.findings
      : [];
  const status = payload?.status || payload?.classification || payload?.llm_audit?.status || payload?.llm_audit?.classification;
  const items = [];
  findings.forEach((finding, index) => {
    const item = buildLlmItem({
      finding,
      classification: finding?.classification || status,
      sourceKind,
      sourcePath,
      sourceIndex: index,
      cwd,
    });
    if (item) items.push(item);
  });

  if (items.length === 0) {
    const classification = normalizeClassification(status);
    if (REQUIRED_CLASSIFICATIONS.has(classification) || ADVISORY_CLASSIFICATIONS.has(classification)) {
      const item = buildLlmItem({
        finding: {
          id: `${sourceKind}_${stableHash(sourcePath)}`,
          classification,
          surface: sourceKind,
          reason: payload?.summary || payload?.llm_audit?.summary,
        },
        classification,
        sourceKind,
        sourcePath,
        sourceIndex: 0,
        cwd,
      });
      if (item) items.push(item);
    }
  }

  return items;
}

function listJsonFiles(dirPath) {
  try {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(dirPath, name))
      .sort();
  } catch {
    return [];
  }
}

function latestPrologTrace(planDir) {
  const dir = join(planDir, "artifacts", "prolog");
  const files = listJsonFiles(dir);
  let latest = null;
  for (const file of files) {
    const parsed = safeJson(file);
    if (!parsed) continue;
    const timestamp = Date.parse(parsed.timestamp || "") || safeStat(file)?.mtimeMs || 0;
    if (!latest || timestamp > latest.timestamp) latest = { path: file, parsed, timestamp };
  }
  return latest;
}

function normalizePrologDetail(value) {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectPrologItems({ planDir, cwd }) {
  const latest = latestPrologTrace(planDir);
  if (!latest) return { items: [], artifact: null };
  // RT-2026-07-02: Invariant-audit artifacts must not create review-intake
  // obligations against themselves. Skip the latest trace if it is a
  // check-invariants artifact; other gate traces may still contain legitimate
  // required intake items.
  if (String(latest.parsed?.gate || "").toLowerCase() === "check-invariants") {
    return { items: [], artifact: null };
  }
  const items = [];
  const sourcePath = latest.path;
  const sourceKind = "prolog_trace_latest";
  const violations = Array.isArray(latest.parsed?.violations) ? latest.parsed.violations : [];
  const seenViolations = new Set();
  for (const violation of violations) {
    const name = cleanString(violation?.name || violation?.Name || "invariant_violation") || "invariant_violation";
    const detail = normalizePrologDetail(violation?.detail ?? violation?.Detail);
    const key = `${name}:${detail}`;
    if (seenViolations.has(key)) continue;
    seenViolations.add(key);
    items.push({
      id: `ontology:violation:${stableHash(key)}`,
      source_kind: sourceKind,
      source_path: compactPath(cwd, sourcePath),
      source_index: items.length,
      required: true,
      severity: "required",
      classification: "invariant_violation",
      surface: "ontology",
      file: null,
      line: null,
      claim: name,
      reason: detail,
      recommended_action: "Clear the invariant violation or record a valid disposition before close.",
      runtime_truth_refs: [compactPath(cwd, sourcePath)].filter(Boolean),
      confidence: "deterministic",
    });
  }

  const checks = Array.isArray(latest.parsed?.checks) ? latest.parsed.checks : [];
  for (const check of checks) {
    if (String(check?.status || "").toUpperCase() !== "WARN") continue;
    const name = cleanString(check?.name || "ontology_advisory") || "ontology_advisory";
    const detail = cleanString(check?.detail) || "Ontology advisory";
    const key = `${name}:${detail}`;
    items.push({
      id: `ontology:advisory:${stableHash(key)}`,
      source_kind: sourceKind,
      source_path: compactPath(cwd, sourcePath),
      source_index: items.length,
      required: false,
      severity: "advisory",
      classification: "invariant_warning",
      surface: "ontology",
      file: null,
      line: null,
      claim: name,
      reason: detail,
      recommended_action: "Review advisory relevance during closeout.",
      runtime_truth_refs: [compactPath(cwd, sourcePath)].filter(Boolean),
      confidence: "deterministic",
    });
  }

  return { items, artifact: sourceArtifact(cwd, sourcePath) };
}

function collectSourceItems({ planDir, cwd }) {
  const sourceArtifacts = [];
  const items = [];
  const sourceDir = join(planDir, SOURCE_DIRNAME);
  for (const sourcePath of listJsonFiles(sourceDir)) {
    const payload = safeJson(sourcePath);
    if (!payload) continue;
    sourceArtifacts.push(sourceArtifact(cwd, sourcePath));
    items.push(...collectLlmItemsFromPayload({
      payload,
      sourceKind: "review_source",
      sourcePath,
      cwd,
    }));
  }

  const maintenancePath = join(planDir, "async", "advisory_maintenance_report.json");
  const maintenance = safeJson(maintenancePath);
  if (maintenance) {
    sourceArtifacts.push(sourceArtifact(cwd, maintenancePath));
    items.push(...collectLlmItemsFromPayload({
      payload: maintenance,
      sourceKind: "advisory_maintenance",
      sourcePath: maintenancePath,
      cwd,
    }));
  }

  const prolog = collectPrologItems({ planDir, cwd });
  if (prolog.artifact) sourceArtifacts.push(prolog.artifact);
  items.push(...prolog.items);

  return { items, sourceArtifacts };
}

function mergeItems(items, dispositions) {
  const byId = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  return [...byId.values()]
    .sort((a, b) => `${a.required ? 0 : 1}:${a.id}`.localeCompare(`${b.required ? 0 : 1}:${b.id}`))
    .map((item) => {
      const disposition = dispositions.get(item.id) || null;
      const dispositionValid = disposition ? dispositionIsValid(disposition) : false;
      const unresolved = item.required === true && !dispositionValid;
      return {
        ...item,
        disposition: disposition || null,
        disposition_valid: dispositionValid,
        unresolved,
      };
    });
}

function summarize(items, sourceArtifacts, ledger, cwd) {
  const requiredItems = items.filter((item) => item.required);
  const unresolvedRequired = requiredItems.filter((item) => item.unresolved);
  const advisoryItems = items.filter((item) => !item.required);
  const satisfied = unresolvedRequired.length === 0;
  return {
    required: requiredItems.length > 0,
    satisfied,
    status: requiredItems.length === 0 ? "not_required" : satisfied ? "satisfied" : "unresolved",
    total_count: items.length,
    required_count: requiredItems.length,
    advisory_count: advisoryItems.length,
    unresolved_required_count: unresolvedRequired.length,
    ledger_present: ledger.present,
    ledger_path: compactPath(cwd, ledger.path),
    source_artifacts: sourceArtifacts
      .filter((artifact) => artifact?.path)
      .filter((artifact, index, arr) => arr.findIndex((candidate) => candidate.path === artifact.path) === index),
    unresolved_required: unresolvedRequired.map((item) => ({
      id: item.id,
      classification: item.classification,
      source_kind: item.source_kind,
      source_path: item.source_path,
      claim: item.claim,
      reason: item.reason,
      recommended_action: item.recommended_action,
    })).slice(0, 20),
    items,
  };
}

export function computeReviewIntake({ cwd = process.cwd(), planDir }) {
  if (!planDir) {
    return {
      required: false,
      satisfied: true,
      status: "not_required",
      total_count: 0,
      required_count: 0,
      advisory_count: 0,
      unresolved_required_count: 0,
      ledger_present: false,
      ledger_path: null,
      source_artifacts: [],
      unresolved_required: [],
      items: [],
    };
  }
  const ledger = readLedger(planDir);
  const { items: sourceItems, sourceArtifacts } = collectSourceItems({ planDir, cwd });
  const items = mergeItems(sourceItems, ledger.dispositions);
  return summarize(items, sourceArtifacts, ledger, cwd);
}

export function writeReviewIntakeLedger({ cwd = process.cwd(), planDir }) {
  const signal = computeReviewIntake({ cwd, planDir });
  const ledgerPath = join(planDir, LEDGER_FILENAME);
  const existing = readLedger(planDir);
  const items = signal.items.map((item) => ({
    id: item.id,
    required: item.required,
    classification: item.classification,
    source_kind: item.source_kind,
    source_path: item.source_path,
    claim: item.claim,
    reason: item.reason,
    recommended_action: item.recommended_action,
    disposition: item.disposition || {
      status: null,
      evidence_refs: [],
      disposition_reason: null,
      waiver_reason: null,
      approved_by: null,
    },
  }));
  const ledger = {
    version: 1,
    generated_at: new Date().toISOString(),
    source: "review_intake.mjs",
    source_artifacts: signal.source_artifacts,
    summary: {
      required_count: signal.required_count,
      advisory_count: signal.advisory_count,
      unresolved_required_count: signal.unresolved_required_count,
    },
    items,
  };
  mkdirSync(planDir, { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  return {
    ...computeReviewIntake({ cwd, planDir }),
    ledger_written: true,
    ledger_path: compactPath(cwd, ledgerPath),
    previous_ledger_present: existing.present,
  };
}

export function persistReviewIntakeSource({ cwd = process.cwd(), planDir, name, payload }) {
  if (!planDir || !name || !payload) return null;
  const sourceDir = join(planDir, SOURCE_DIRNAME);
  mkdirSync(sourceDir, { recursive: true });
  const safeName = String(name).replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/_+/g, "_");
  const path = join(sourceDir, safeName.endsWith(".json") ? safeName : `${safeName}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return compactPath(cwd, path);
}
