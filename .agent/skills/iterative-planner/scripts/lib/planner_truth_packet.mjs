// planner_truth_packet.mjs — Build a deterministic dogfood truth packet from planner health sources.
// @planner:module = planner_truth_packet
// @planner:capability = deterministic_planner_dogfood_false_green_packet

import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

const STATUS_RANK = Object.freeze({
  PASS: 0,
  WARN: 1,
  FAIL: 2,
  ERROR: 3,
});

function normalizeStatus(value) {
  const normalized = normalizeVerificationStatus(value, "execution");
  if (!normalized.valid) return null;
  if (normalized.kind === "pass") return "PASS";
  if (normalized.kind === "fail") return "FAIL";
  return "WARN";
}

function excerpt(value, max = 1200) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function parseJsonFromOutput(output) {
  const text = String(output || "").trim();
  if (!text) return { parsed: null, error: "empty output" };
  try {
    return { parsed: JSON.parse(text), error: null };
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) {
      const candidate = text.slice(first, last + 1);
      try {
        return { parsed: JSON.parse(candidate), error: null };
      } catch (error) {
        return { parsed: null, error: error.message };
      }
    }
    return { parsed: null, error: "no JSON object found" };
  }
}

function inferProjectHealthStatus(parsed) {
  const fail = Number(parsed?.summary?.fail ?? 0);
  const warn = Number(parsed?.summary?.warn ?? 0);
  if (fail > 0) return "FAIL";
  if (warn > 0) return "WARN";
  if (parsed?.summary) return "PASS";
  return null;
}

function inferSourceStatus({ id, exitCode, parsed, parseError }) {
  if (parseError) return { status: "ERROR", sourceError: true };
  if (Number(exitCode) !== 0) return { status: "FAIL", sourceError: false };
  const parsedStatus = normalizeStatus(parsed?.status);
  if (parsed?.status != null && !parsedStatus) return { status: "ERROR", sourceError: true };
  if (id === "project_health") {
    const healthStatus = inferProjectHealthStatus(parsed);
    if (healthStatus) return { status: healthStatus, sourceError: false };
  }
  if (parsedStatus) return { status: parsedStatus, sourceError: false };
  return { status: "ERROR", sourceError: true };
}

export function normalizeSourceResult({
  id,
  command = [],
  exitCode = 0,
  stdout = "",
  stderr = "",
  durationMs = 0,
  timedOut = false,
} = {}) {
  const { parsed, error } = parseJsonFromOutput(stdout);
  const parseError = parsed ? null : error;
  const inferred = timedOut
    ? { status: "ERROR", sourceError: true }
    : inferSourceStatus({ id, exitCode, parsed, parseError });

  return {
    id,
    command,
    exit_code: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
    status: inferred.status,
    source_error: inferred.sourceError,
    duration_ms: Number.isFinite(Number(durationMs)) ? Number(durationMs) : 0,
    timed_out: Boolean(timedOut),
    status_validated: true,
    parsed,
    parse_error: parseError,
    stdout_excerpt: excerpt(stdout),
    stderr_excerpt: excerpt(stderr),
  };
}

function risk(id, severity, message, sources = [], meta = {}) {
  return { id, severity, message, sources, ...meta };
}

function sourceStatusRank(source) {
  if (source?.source_error === true) return STATUS_RANK.ERROR;
  return STATUS_RANK[source?.status] ?? STATUS_RANK.ERROR;
}

function sourceHasStatus(source, status) {
  const actual = normalizeStatus(source?.status);
  const expected = normalizeStatus(status);
  return actual !== null && expected !== null && actual === expected;
}

function isProjectHealthGreen(source) {
  if (!source) return false;
  if (source.id !== "project_health") return false;
  if (!sourceHasStatus(source, "PASS")) return false;
  if (source.parsed?.summary) {
    return Number(source.parsed.summary.fail || 0) === 0 &&
      Number(source.parsed.summary.warn || 0) === 0;
  }
  return sourceHasStatus(source, "PASS");
}

function isCanonicalStoryRegistryFailed(source) {
  if (!source) return false;
  if (sourceHasStatus(source, "FAIL") || sourceHasStatus(source, "ERROR")) return true;
  if (normalizeStatus(source.parsed?.status) === "FAIL") return true;
  return Array.isArray(source.parsed?.errors) && source.parsed.errors.length > 0;
}

function isInvariantPass(source) {
  if (!source) return false;
  return sourceHasStatus(source, "PASS") ||
    (normalizeStatus(source.parsed?.status) === "PASS" && Number(source.parsed?.count || 0) === 0);
}

function verifyStoriesMissingCount(source) {
  return Number(source?.parsed?.coverage?.missing || 0);
}

function plannerFindingsClaimsStoryRegistryUsable(source) {
  const health = source?.parsed?.story_registry_health;
  if (!health) return false;
  return health.present === true &&
    health.usable === true &&
    health.blocking !== true &&
    (!Array.isArray(health.errors) || health.errors.length === 0);
}

function escalationHasAdvisorSignals(source) {
  const parsed = source?.parsed || {};
  const entries = [
    ...(Array.isArray(parsed.escalations) ? parsed.escalations : []),
    ...(Array.isArray(parsed.recommendations) ? parsed.recommendations : []),
    ...(Array.isArray(parsed.required) ? parsed.required : []),
    ...(Array.isArray(parsed.recommended) ? parsed.recommended : []),
  ];
  return entries.some((entry) => /advisor/i.test(JSON.stringify(entry)));
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / 86400000);
}

export function buildNorthStarStatus({
  manifesto = null,
  artifacts = [],
  generatedAt = new Date().toISOString(),
  staleAfterDays = 14,
} = {}) {
  const normalizedArtifacts = (Array.isArray(artifacts) ? artifacts : [])
    .filter(Boolean)
    .map((artifact) => {
      const ageDays = Number.isFinite(Number(artifact.age_days))
        ? Number(artifact.age_days)
        : daysBetween(artifact.mtime || artifact.generated_at, generatedAt);
      return {
        path: artifact.path || null,
        mtime: artifact.mtime || artifact.generated_at || null,
        age_days: ageDays,
      };
    });
  const hasContract = manifesto?.present === true && Boolean(
    manifesto?.north_star ||
    manifesto?.north_star_type ||
    (Array.isArray(manifesto?.core_metrics) && manifesto.core_metrics.length > 0)
  );

  if (!hasContract) {
    return {
      status: "MISSING_CONTRACT",
      manifesto,
      artifacts: normalizedArtifacts,
      stale_after_days: staleAfterDays,
      detail: "No planner North Star contract was found.",
    };
  }

  if (normalizedArtifacts.length === 0) {
    return {
      status: "MISSING_MEASUREMENT",
      manifesto,
      artifacts: normalizedArtifacts,
      stale_after_days: staleAfterDays,
      detail: "North Star contract exists but no measurement artifact was found.",
    };
  }

  const newestAge = Math.min(...normalizedArtifacts
    .map((artifact) => Number(artifact.age_days))
    .filter((value) => Number.isFinite(value)));
  if (Number.isFinite(newestAge) && newestAge > staleAfterDays) {
    return {
      status: "STALE",
      manifesto,
      artifacts: normalizedArtifacts,
      stale_after_days: staleAfterDays,
      newest_age_days: newestAge,
      detail: `Newest North Star measurement is ${newestAge.toFixed(1)} days old.`,
    };
  }

  return {
    status: "PRESENT",
    manifesto,
    artifacts: normalizedArtifacts,
    stale_after_days: staleAfterDays,
    newest_age_days: Number.isFinite(newestAge) ? newestAge : null,
    detail: "North Star contract and measurement artifact are present.",
  };
}

export function buildTruthPacketFromResults({
  generatedAt = new Date().toISOString(),
  cwd = process.cwd(),
  sources = [],
  northStar = null,
} = {}) {
  const normalizedSources = (Array.isArray(sources) ? sources : [])
    .map((entry) => {
      if (entry?.status_validated === true) return entry;
      if (!entry?.status) return normalizeSourceResult(entry);
      const status = normalizeStatus(entry.status);
      return {
        ...entry,
        status: status || "ERROR",
        status_validated: true,
        source_error: !status,
        ...(status ? {} : { status_error: `invalid_source_status:${String(entry.status)}` }),
      };
    })
    .filter((entry) => entry?.id);
  const byId = Object.fromEntries(normalizedSources.map((entry) => [entry.id, entry]));
  const risks = [];

  for (const source of normalizedSources) {
    if (Number(source.exit_code) !== 0) {
      risks.push(risk("source_command_failed", "high", `${source.id} exited ${source.exit_code}`, [source.id], {
        exit_code: source.exit_code,
      }));
    }
    if (source.parse_error) {
      risks.push(risk("source_json_parse_failed", "high", `${source.id} did not emit parseable JSON`, [source.id], {
        parse_error: source.parse_error,
      }));
    }
    if (source.status_error) {
      risks.push(risk("source_status_invalid", "high", `${source.id} emitted an invalid or unknown status`, [source.id], {
        status_error: source.status_error,
      }));
    }
  }

  const projectHealth = byId.project_health;
  const storyRegistry = byId.story_registry_check;
  const invariants = byId.check_invariants;
  const verifyStories = byId.verify_stories;
  const plannerFindings = byId.planner_findings;
  const escalation = byId.escalation_check;
  const storyRegistryFailed = isCanonicalStoryRegistryFailed(storyRegistry);

  if (isProjectHealthGreen(projectHealth) && storyRegistryFailed) {
    risks.push(risk(
      "story_registry_failed_while_project_health_green",
      "critical",
      "project_health reports no fail/warn findings while canonical story_registry check fails.",
      ["project_health", "story_registry_check"]
    ));
  }

  if (storyRegistryFailed && isInvariantPass(invariants)) {
    risks.push(risk(
      "story_registry_failed_while_invariants_pass",
      "high",
      "Ontology invariants pass while canonical story registry evidence readiness fails.",
      ["story_registry_check", "check_invariants"]
    ));
  }

  const missingStoryCount = verifyStoriesMissingCount(verifyStories);
  if (storyRegistryFailed && sourceHasStatus(verifyStories, "PASS") && missingStoryCount > 0) {
    risks.push(risk(
      "verify_stories_passed_with_missing_story_coverage",
      "medium",
      `verify-stories passed while reporting ${missingStoryCount} missing stories and canonical story_registry failed.`,
      ["story_registry_check", "verify_stories"],
      { missing_story_count: missingStoryCount }
    ));
  }

  if (storyRegistryFailed && plannerFindingsClaimsStoryRegistryUsable(plannerFindings)) {
    risks.push(risk(
      "planner_findings_story_registry_disagrees_with_canonical",
      "high",
      "planner_findings story registry mirror reports usable while canonical story_registry check fails.",
      ["story_registry_check", "planner_findings"]
    ));
  }

  if (escalationHasAdvisorSignals(escalation)) {
    risks.push(risk(
      "advisor_escalation_present_in_packet",
      "medium",
      "Escalation check contains advisor-related signals that should be surfaced to the operator.",
      ["escalation_check"]
    ));
  }

  if (northStar?.status === "MISSING_CONTRACT") {
    risks.push(risk(
      "north_star_contract_missing",
      "high",
      "Planner North Star contract is missing.",
      ["north_star"]
    ));
  } else if (northStar?.status === "MISSING_MEASUREMENT") {
    risks.push(risk(
      "north_star_measurement_missing",
      "high",
      "Planner North Star contract exists but no measurement artifact was found.",
      ["north_star"]
    ));
  } else if (northStar?.status === "STALE") {
    risks.push(risk(
      "north_star_measurement_stale",
      "medium",
      "Planner North Star measurement artifact is stale.",
      ["north_star"],
      { newest_age_days: northStar.newest_age_days ?? null }
    ));
  }

  if (northStar?.consumer_status?.status === "side_report_only" && northStar?.status && northStar.status !== "PRESENT") {
    risks.push(risk(
      "north_star_advisory_unconsumed",
      "medium",
      "North Star advisory is present only in a side report and has not reached an operator decision surface.",
      ["north_star"]
    ));
  }

  const sourceErrorCount = normalizedSources.filter((source) =>
    source.source_error === true || source.parse_error
  ).length;
  const worstSourceRank = normalizedSources.reduce((rank, source) =>
    Math.max(rank, sourceStatusRank(source)), 0);
  const status = sourceErrorCount > 0 || worstSourceRank >= STATUS_RANK.ERROR
    ? "ERROR"
    : risks.length > 0 || worstSourceRank >= STATUS_RANK.WARN
      ? "WARN"
      : "PASS";

  return {
    schema_version: 1,
    generated_at: generatedAt,
    cwd,
    status,
    sources: byId,
    north_star: northStar,
    false_green_risks: risks,
    quality: {
      source_count: normalizedSources.length,
      source_error_count: sourceErrorCount,
      false_green_count: risks.length,
      source_statuses: Object.fromEntries(normalizedSources.map((source) => [source.id, source.status])),
      total_source_duration_ms: normalizedSources.reduce((sum, source) => sum + Number(source.duration_ms || 0), 0),
      north_star_status: northStar?.status || null,
    },
  };
}
