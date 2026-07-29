// ive_advisory_records.mjs - IVE continuous advisory record helpers.

import { createHash } from "crypto";

const DEFAULT_MODEL = "unknown";
const DEFAULT_UNAVAILABLE_SUMMARY =
  "Advisory run unavailable; deterministic evidence remains authoritative.";
const ADVISORY_VERBATIM_REPRODUCTION_CONTRACT =
  "Full advisory verdicts are audit artifacts. Default user-facing output should report deterministic status, summary, and artifact path; reproduce advisory payloads verbatim only when explicitly requested.";
const ADVISORY_VERDICT_BEGIN_PATTERN = /<<<\s*ADVISORY_VERDICT_BEGIN\s*>>>/gi;
const ADVISORY_VERDICT_END_PATTERN = /<<<\s*ADVISORY_VERDICT_END\s*>>>/gi;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeJson(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = normalizeJson(value[key]);
  }
  return out;
}

function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value));
}

function sanitizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(ADVISORY_VERDICT_BEGIN_PATTERN, "[ADVISORY_VERDICT_BEGIN_ESCAPED]")
    .replace(ADVISORY_VERDICT_END_PATTERN, "[ADVISORY_VERDICT_END_ESCAPED]")
    .trim();
}

function sanitizeValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? sanitizeText(value) : value;
  }
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = sanitizeValue(item);
    }
    return out;
  }
  return sanitizeText(value);
}

function routeIsDeterministicBlocker(route) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Detects blocked or unrouted IVE lifecycle states while constructing advisory input.
  return route?.status === "blocked" || route?.status === "unrouted";
}

function countAnchors(value) {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return 0;
}

function ticketIdFromPacket(packet) {
  return packet?.ticket_id || packet?.id || packet?.intent?.ticket_id || null;
}

export function buildAdvisoryInput(packet = {}, options = {}) {
  const reflectionDelta = options.reflectionDelta || packet.reflection_delta || packet.reflection_diff || {};
  const factRoutes = asArray(packet.fact_routes);
  const base = {
    ticket_id: ticketIdFromPacket(packet),
    acceptance_criteria: asArray(packet.acceptance_criteria),
    verification_refs: asArray(packet.verification_refs),
    story_refs: asArray(packet.story_refs),
    gap_refs: asArray(packet.gap_refs),
    deterministic: {
      closure_status: packet.closure_status || null,
      fact_route_count: factRoutes.length,
      blocker_count: factRoutes.filter(routeIsDeterministicBlocker).length,
    },
    reflection_delta: reflectionDelta,
    retro_recurrence_status: packet.retro_recurrence_status || packet.retro?.recurrence_status || null,
    north_star: packet.north_star || null,
  };
  return normalizeJson({
    ...base,
    ...(isPlainObject(options.additionalInput) ? options.additionalInput : {}),
  });
}

export function canonicalizeAdvisoryInput(input) {
  return canonicalJson(input);
}

export function computeAdvisoryInputDigest(input) {
  return `sha256:${createHash("sha256").update(canonicalizeAdvisoryInput(input)).digest("hex")}`;
}

export function buildAdvisoryInputSummary(input = {}) {
  const normalized = normalizeJson(input);
  const delta = normalized.reflection_delta || {};
  const deterministic = normalized.deterministic || {};
  const blockerCount = Number(deterministic.blocker_count || 0);
  const unresolvedRisks = countAnchors(delta.unresolved_risks || delta.pre_mortem_unresolved);
  const unmetCriteria = countAnchors(delta.unmet_criteria || delta.acceptance_unmet);
  return {
    acceptance_criteria_count: asArray(normalized.acceptance_criteria).length,
    anchors_planned: countAnchors(delta.planned_anchors),
    anchors_delivered: countAnchors(delta.delivered_anchors),
    deterministic_delta_clean: blockerCount === 0 && unresolvedRisks === 0 && unmetCriteria === 0,
    deterministic_blocker_count: blockerCount,
    retro_recurrence_status: normalized.retro_recurrence_status || null,
  };
}

export function normalizeAdvisoryPayload(advisory, options = {}) {
  const payload = isPlainObject(advisory) ? advisory : {};
  const unavailableReason = sanitizeText(options.unavailableReason || payload.unavailable_reason || payload.error || "");
  const fallbackStatus = advisory ? "unknown" : "unavailable";
  const status = sanitizeText(payload.status || fallbackStatus) || fallbackStatus;
  const summaryFallback = status === "unavailable" || !advisory
    ? unavailableReason
      ? `${DEFAULT_UNAVAILABLE_SUMMARY} Reason: ${unavailableReason}`
      : DEFAULT_UNAVAILABLE_SUMMARY
    : "(no advisory summary)";
  return {
    status,
    summary: sanitizeText(payload.summary || summaryFallback),
    findings: asArray(payload.findings).map(sanitizeValue),
    recommended_actions: asArray(payload.recommended_actions || payload.actions).map(sanitizeValue),
  };
}

function normalizeTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function recordId(timestamp, digest) {
  const stamp = timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `ADV-${stamp}-${String(digest).replace(/^sha256:/, "").slice(0, 12)}`;
}

export function buildAdvisoryRecord(packet = {}, options = {}) {
  const timestamp = normalizeTimestamp(options.timestamp);
  const input = options.input || buildAdvisoryInput(packet, options);
  const inputDigest = options.inputDigest || computeAdvisoryInputDigest(input);
  const advisory = normalizeAdvisoryPayload(options.advisory, options);
  return {
    id: options.id || recordId(timestamp, inputDigest),
    ticket_id: options.ticketId || ticketIdFromPacket(packet),
    trigger: options.trigger || "manual",
    gate: options.gate || null,
    model: options.model || DEFAULT_MODEL,
    model_version: options.modelVersion || options.model_version || null,
    timestamp,
    input_digest: inputDigest,
    input_summary: buildAdvisoryInputSummary(input),
    advisory,
    verbatim_reproduction_contract: ADVISORY_VERBATIM_REPRODUCTION_CONTRACT,
  };
}

export function advisoryHistory(packet = {}) {
  return asArray(packet.advisory_history);
}

export function latestAdvisoryRecord(packet = {}) {
  const history = advisoryHistory(packet);
  return history.length > 0 ? history[history.length - 1] : null;
}

export function findCachedAdvisoryRecord(packet = {}, inputOrDigest) {
  const digest = typeof inputOrDigest === "string"
    ? inputOrDigest
    : computeAdvisoryInputDigest(inputOrDigest);
  const history = advisoryHistory(packet);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.input_digest === digest) return history[index];
  }
  return null;
}

export function appendAdvisoryRecord(packet = {}, options = {}) {
  const record = buildAdvisoryRecord(packet, options);
  const nextPacket = jsonClone(packet) || {};
  const history = advisoryHistory(nextPacket).map((entry) => jsonClone(entry));
  history.push(record);
  nextPacket.advisory_history = history;
  return { packet: nextPacket, record, reused: false };
}

export function appendOrReuseAdvisoryRecord(packet = {}, options = {}) {
  const input = options.input || buildAdvisoryInput(packet, options);
  const cached = options.reuseCache === false ? null : findCachedAdvisoryRecord(packet, input);
  if (cached) {
    return {
      packet: jsonClone(packet) || {},
      record: jsonClone(cached),
      reused: true,
    };
  }
  return appendAdvisoryRecord(packet, { ...options, input });
}
