import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

import { buildNorthStarStatus } from "./planner_truth_packet.mjs";

export const NORTH_STAR_ARTIFACT_NAMES = new Set([
  "projection-north-star.json",
  "north-star-telemetry.json",
  "northstar-ui-dogfood.json",
]);

const OPERATOR_SURFACE_IDS = new Set([
  "planner_findings",
  "bootstrap_status",
]);

const INCIDENT_PATTERNS = [
  /\bdogfood\b/i,
  /\bfalse[-\s]?green\b/i,
  /\bhealth[-\s]?audit\b/i,
  /\bnorth[-\s]?star\b/i,
  /\badvisor\b/i,
  /\bsteward\b/i,
  /\buser stor(?:y|ies)\b/i,
  /\binvariant verification\b/i,
  /\bontology\b/i,
];

function safeReadJson(filePath) {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) : null;
  } catch {
    return null;
  }
}

function repoRelative(cwd, filePath) {
  const resolvedCwd = resolve(cwd);
  const resolvedPath = resolve(filePath);
  return resolvedPath.startsWith(`${resolvedCwd}/`)
    ? resolvedPath.slice(resolvedCwd.length + 1)
    : filePath;
}

function loadNorthStarManifestoForStatus(cwd) {
  const path = join(cwd, ".agent", "skills", "iterative-planner", "config", "planner_manifesto.json");
  const parsed = safeReadJson(path);
  if (!parsed) return { present: false, path };
  return {
    present: true,
    path,
    version: parsed.version || parsed.schema_version || null,
    north_star: parsed.north_star || null,
    north_star_type: parsed.north_star_type || null,
    core_metrics: Array.isArray(parsed.core_metrics) ? parsed.core_metrics : [],
    invariant_directives: Array.isArray(parsed.invariant_directives) ? parsed.invariant_directives : [],
  };
}

export function collectNorthStarArtifacts(cwd, { limit = 12 } = {}) {
  const root = join(cwd, "reports", "ive", "test_runs");
  if (!existsSync(root)) return [];
  const artifacts = [];
  let runDirs = [];
  try {
    runDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return artifacts;
  }

  for (const runDir of runDirs) {
    let entries = [];
    try {
      entries = readdirSync(runDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !NORTH_STAR_ARTIFACT_NAMES.has(entry.name)) continue;
      const path = join(runDir, entry.name);
      try {
        const stat = statSync(path);
        artifacts.push({
          path: repoRelative(cwd, path),
          mtime: stat.mtime.toISOString(),
        });
      } catch {
        artifacts.push({ path: repoRelative(cwd, path), mtime: null });
      }
    }
  }

  artifacts.sort((a, b) => String(b.mtime || "").localeCompare(String(a.mtime || "")));
  return artifacts.slice(0, limit);
}

export function isNorthStarDecisionSurfaceRelevant({ goalText = "", plannedFiles = [] } = {}) {
  const text = [
    goalText,
    ...(Array.isArray(plannedFiles) ? plannedFiles : []),
  ].join("\n");
  return INCIDENT_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeConsumerStatus({ surfaceId, operatorDecisionSurface, relevant }) {
  const id = String(surfaceId || "unknown").trim() || "unknown";
  const operatorSurface = operatorDecisionSurface === true || OPERATOR_SURFACE_IDS.has(id);
  return {
    surface_id: id,
    operator_decision_surface: operatorSurface,
    status: operatorSurface ? "operator_surface_consumed" : "side_report_only",
    relevant_context: relevant === true,
    detail: operatorSurface
      ? `${id} surfaced the North Star decision state to the operator.`
      : `${id} is a measurement/report surface; route any advisory into planner_findings or bootstrap status before treating it as consumed.`,
  };
}

function freshnessStatus(status) {
  if (status === "PRESENT") return "fresh";
  if (status === "STALE") return "stale";
  if (status === "MISSING_MEASUREMENT") return "missing";
  if (status === "MISSING_CONTRACT") return "unknown";
  return "unknown";
}

function risk(id, severity, message, nextAction = null) {
  return { id, severity, message, next_action: nextAction };
}

function buildRisks(status, consumerStatus) {
  const risks = [];
  if (status === "MISSING_CONTRACT") {
    risks.push(risk(
      "north_star_contract_missing",
      "high",
      "Planner North Star contract is missing.",
      "Define the North Star contract in .agent/skills/iterative-planner/config/planner_manifesto.json or the active intent contract."
    ));
  } else if (status === "MISSING_MEASUREMENT") {
    risks.push(risk(
      "north_star_measurement_missing",
      "high",
      "North Star contract exists but no measurement artifact was found.",
      "Run or record a North Star measurement artifact under reports/ive/test_runs/ before treating the planner surface as measured."
    ));
  } else if (status === "STALE") {
    risks.push(risk(
      "north_star_measurement_stale",
      "medium",
      "Newest North Star measurement artifact is stale.",
      "Refresh North Star measurement artifacts before relying on the decision surface."
    ));
  }

  if (consumerStatus.status === "side_report_only" && risks.length > 0) {
    risks.push(risk(
      "north_star_advisory_unconsumed",
      "medium",
      "North Star advisory is present only in a side report, not an operator decision surface.",
      "Surface this advisory through planner_findings or bootstrap status before considering it consumed."
    ));
  }
  return risks;
}

function decisionStatus(status, risks) {
  if (["MISSING_CONTRACT", "MISSING_MEASUREMENT"].includes(status)) return "FAIL";
  if (status === "STALE" || risks.some((entry) => entry.severity === "medium")) return "WARN";
  return "PASS";
}

export function buildNorthStarDecisionSurface({
  cwd = process.cwd(),
  generatedAt = new Date().toISOString(),
  staleAfterDays = 14,
  surfaceId = "unknown",
  operatorDecisionSurface = false,
  relevant = null,
  goalText = "",
  plannedFiles = [],
  manifesto = null,
  artifacts = null,
} = {}) {
  const resolvedCwd = resolve(cwd);
  const contextRelevant = relevant === null
    ? isNorthStarDecisionSurfaceRelevant({ goalText, plannedFiles })
    : relevant === true;
  const sourceManifesto = manifesto || loadNorthStarManifestoForStatus(resolvedCwd);
  const sourceArtifacts = Array.isArray(artifacts)
    ? artifacts
    : collectNorthStarArtifacts(resolvedCwd);
  const statusPayload = buildNorthStarStatus({
    manifesto: sourceManifesto,
    artifacts: sourceArtifacts,
    generatedAt,
    staleAfterDays,
  });
  const consumerStatus = normalizeConsumerStatus({
    surfaceId,
    operatorDecisionSurface,
    relevant: contextRelevant,
  });
  const risks = buildRisks(statusPayload.status, consumerStatus);
  const newestArtifact = statusPayload.artifacts?.[0] || null;
  const measurement = {
    status: statusPayload.status,
    contract_present: sourceManifesto?.present === true,
    present: Array.isArray(statusPayload.artifacts) && statusPayload.artifacts.length > 0,
    artifact_count: Array.isArray(statusPayload.artifacts) ? statusPayload.artifacts.length : 0,
    newest_artifact: newestArtifact?.path || null,
    newest_age_days: statusPayload.newest_age_days ?? newestArtifact?.age_days ?? null,
  };

  return {
    ...statusPayload,
    decision_status: decisionStatus(statusPayload.status, risks),
    relevant: contextRelevant,
    measurement,
    freshness: {
      status: freshnessStatus(statusPayload.status),
      stale_after_days: staleAfterDays,
      newest_age_days: measurement.newest_age_days,
    },
    consumer_status: consumerStatus,
    risks,
    next_actions: risks.map((entry) => ({
      id: `repair_${entry.id}`,
      reason: entry.message,
      action: entry.next_action,
    })),
    summary: `${statusPayload.status}; freshness=${freshnessStatus(statusPayload.status)}; consumer=${consumerStatus.status}`,
  };
}

export function shouldRenderNorthStarDecisionSurface({ surface = null, goalText = "", plannedFiles = [] } = {}) {
  if (!surface) return false;
  if (surface.relevant === true) return true;
  if (surface.status && surface.status !== "PRESENT") return true;
  if ((surface.risks || []).length > 0) return true;
  return isNorthStarDecisionSurfaceRelevant({ goalText, plannedFiles });
}

export function renderNorthStarDecisionSurface(surface) {
  if (!surface) return "";
  const lines = ["North Star decision surface:"];
  const freshness = surface.freshness?.status || "unknown";
  const age = Number(surface.measurement?.newest_age_days);
  const ageText = Number.isFinite(age) ? `; newest ${age.toFixed(1)}d old` : "";
  lines.push(`  Status: ${surface.status || "UNKNOWN"} (${freshness}${ageText})`);
  lines.push(`  Consumer: ${surface.consumer_status?.surface_id || "unknown"} -> ${surface.consumer_status?.status || "unknown"}`);
  const newest = surface.measurement?.newest_artifact || null;
  const count = Number(surface.measurement?.artifact_count || 0);
  lines.push(`  Measurement: ${newest || "none"}${count > 1 ? ` (+${count - 1} more)` : ""}`);
  for (const riskEntry of (surface.risks || []).slice(0, 3)) {
    lines.push(`  Risk: ${riskEntry.id} - ${riskEntry.message}`);
  }
  const next = (surface.next_actions || [])[0];
  if (next?.action) lines.push(`  Next: ${next.action}`);
  return lines.join("\n");
}
