#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import {
  basename,
  join,
  relative,
  resolve,
} from "path";
import { fileURLToPath } from "url";

import { readStateJson } from "./lib/determinism.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import {
  extractFilesToModify,
  extractMarkdownSection,
  getPaths,
  resolvePlanTarget,
} from "./lib/plan_utils.mjs";
import {
  loadThrashingThresholds,
  THRASHING_SIGNAL_ORDER,
} from "./lib/thrashing_thresholds.mjs";
import { recentSpotCheckSignals } from "./lib/spot_check.mjs";

const SIGNAL_FAMILY = Object.freeze({
  thrashing_repeat_edit: "structural",
  thrashing_oscillating_errors: "structural",
  thrashing_backtrack_pattern: "structural",
  thrashing_checkpoint_flood: "structural",
  thrashing_tool_call_volume: "structural",
  thrashing_criterion_stuck: "progress",
  thrashing_progress_divergence: "progress",
  thrashing_silent_scope_creep: "progress",
  thrashing_test_regression: "progress",
  thrashing_no_artifact_progress: "progress",
  thrashing_criterion_overbudget: "budget",
  thrashing_session_overbudget: "budget",
  thrashing_reflect_overdue: "reflection_skip",
  thrashing_plan_not_reread: "reflection_skip",
  thrashing_spot_check_severe: "spot_check",
  thrashing_spot_check_persistent: "spot_check",
});

const SEVERITY_RANK = Object.freeze({
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});

const EDIT_TOOLS = new Set(["Edit", "Write"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const REFLECTION_DECISIONS = new Set(["continue", "pivot", "escalate"]);
const GENERATED_ARTIFACT_PREFIXES = [
  "plans/",
  "reports/",
  "coverage/",
  "dist/",
  "build/",
  ".next/",
];

function safeRead(filePath) {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  const text = safeRead(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function clampNumber(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function normalizeComparablePath(filePath) {
  const normalized = String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
  return normalized || null;
}

function normalizeRepoPath(cwd, filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return null;
  const absolute = raw.startsWith("/") ? resolve(raw) : resolve(cwd, raw);
  const repoRelative = relative(cwd, absolute).replace(/\\/g, "/");
  if (!repoRelative || repoRelative.startsWith("..")) {
    return normalizeComparablePath(raw);
  }
  return normalizeComparablePath(repoRelative);
}

function pathMatchesPath(actualPath, expectedPath) {
  const actual = normalizeComparablePath(actualPath);
  const expected = normalizeComparablePath(expectedPath);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  if (actual.endsWith(`/${expected}`)) return true;
  if (expected.endsWith(`/${actual}`)) return true;
  return basename(actual) === basename(expected);
}

function pathMatchesAny(actualPath, expectedPaths = []) {
  return (expectedPaths || []).some((expectedPath) => pathMatchesPath(actualPath, expectedPath));
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const flags = {
    help: args.includes("--help") || args.includes("-h"),
    json: args.includes("--json"),
    compact: args.includes("--compact"),
  };

  function readFlagValue(flag) {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] ? args[index + 1] : null;
  }

  return {
    flags,
    cwd: readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd(),
    plan: readFlagValue("--plan"),
    now: readFlagValue("--now"),
  };
}

function readPlanFiles(planDir) {
  const planPath = join(planDir, "plan.md");
  const progressPath = join(planDir, "progress.md");
  const metricsPath = join(planDir, "metrics.json");
  const telemetrySummaryPath = join(planDir, "telemetry", "summary.json");
  const reflectionPath = join(planDir, "reflection.md");

  return {
    planPath,
    progressPath,
    metricsPath,
    telemetrySummaryPath,
    reflectionPath,
    planContent: safeRead(planPath) || "",
    progressContent: safeRead(progressPath) || "",
    metrics: safeReadJson(metricsPath),
    telemetrySummary: safeReadJson(telemetrySummaryPath),
    reflectionContent: safeRead(reflectionPath) || "",
  };
}

function readVerificationStrategy(planDir) {
  const path = join(planDir, "verification_strategy.yaml");
  const text = safeRead(path);
  if (!text) {
    return {
      ok: false,
      present: false,
      path,
      strategy: null,
      criteria: [],
      errors: ["verification_strategy.yaml missing"],
    };
  }

  try {
    const document = JSON.parse(text);
    const strategy = document?.verification_strategy || null;
    const rawCriteria = Array.isArray(strategy?.criteria) ? strategy.criteria : [];
    const criteria = rawCriteria.map((criterion, index) => {
      const requiredProofWeight = clampNumber(criterion?.required_proof_weight, 0);
      const accumulatedProofWeight = clampNumber(criterion?.accumulated_proof_weight, 0);
      const proofSufficient = typeof criterion?.proof_sufficient === "boolean"
        ? criterion.proof_sufficient
        : accumulatedProofWeight >= requiredProofWeight;
      return {
        ...criterion,
        id: String(criterion?.id || `CRIT-${String(index + 1).padStart(3, "0")}`),
        criterion: String(criterion?.criterion || "").trim(),
        required_proof_weight: requiredProofWeight,
        accumulated_proof_weight: accumulatedProofWeight,
        proof_sufficient: proofSufficient,
      };
    });
    return {
      ok: !!strategy,
      present: true,
      path,
      strategy,
      criteria,
      errors: strategy ? [] : ["verification_strategy root missing"],
    };
  } catch (error) {
    return {
      ok: false,
      present: true,
      path,
      strategy: null,
      criteria: [],
      errors: [`verification_strategy.yaml parse failure: ${error.message}`],
    };
  }
}

function extractSuccessCriteria(planContent) {
  const section = extractMarkdownSection(planContent, "Success Criteria");
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line) || /^-\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, "").replace(/^-\s+/, "").trim())
    .filter(Boolean);
}

function readToolTrace(planDir, cwd) {
  const tracePath = join(planDir, "artifacts", "tool_trace.jsonl");
  const content = safeRead(tracePath);
  if (!content) {
    return {
      present: false,
      path: tracePath,
      entries: [],
      executeEntries: [],
    };
  }

  const parsed = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        const entry = JSON.parse(line);
        return {
          ...entry,
          seq: Number.isInteger(entry?.seq) ? entry.seq : index + 1,
          tool: String(entry?.tool || "").trim(),
          phase: String(entry?.phase || "").trim(),
          ts: typeof entry?.ts === "string" ? entry.ts : null,
          command: typeof entry?.command === "string" ? entry.command.trim() : "",
          pattern: typeof entry?.pattern === "string" ? entry.pattern.trim() : "",
          paths: unique((Array.isArray(entry?.paths) ? entry.paths : [])
            .map((filePath) => normalizeRepoPath(cwd, filePath))
            .filter(Boolean)),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);

  const executeEntries = parsed.some((entry) => entry.phase === "EXECUTE")
    ? parsed.filter((entry) => entry.phase === "EXECUTE")
    : parsed;

  return {
    present: true,
    path: tracePath,
    entries: parsed,
    executeEntries,
  };
}

function readStructuredTestRuns(cwd, planId) {
  const testRunsDir = join(cwd, "reports", "test_runs");
  if (!existsSync(testRunsDir)) {
    return {
      present: false,
      dir: testRunsDir,
      runs: [],
    };
  }

  const prefix = `${planId}_`;
  const runs = readdirSync(testRunsDir)
    .filter((name) => name.startsWith(prefix))
    .filter((name) => /\.(yaml|yml|json)$/i.test(name))
    .filter((name) => !/_latest\.(yaml|yml|json)$/i.test(name))
    .map((name) => {
      const path = join(testRunsDir, name);
      const document = safeReadJson(path);
      const run = document?.test_run || null;
      const stats = safeStat(path);
      if (!run || run.plan_id !== planId) return null;
      return {
        path,
        generated_at: typeof run.generated_at === "string" ? run.generated_at : null,
        mtime_ms: stats?.mtimeMs || 0,
        run: {
          ...run,
          summary: {
            failed: clampNumber(run?.summary?.failed, 0),
            passed: clampNumber(run?.summary?.passed, 0),
            total: clampNumber(run?.summary?.total, 0),
          },
          tests: Array.isArray(run?.tests) ? run.tests : [],
          raw_output: typeof run?.raw_output === "string" ? run.raw_output : "",
        },
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = Date.parse(left.generated_at) || left.mtime_ms;
      const rightTime = Date.parse(right.generated_at) || right.mtime_ms;
      return rightTime - leftTime;
    });

  return {
    present: true,
    dir: testRunsDir,
    runs,
  };
}

function parseSimpleValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseFrontmatter(frontmatterText) {
  const lines = String(frontmatterText || "").split("\n");
  const data = {};
  let activeArrayKey = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    const arrayEntryMatch = line.match(/^\s*-\s+(.+)\s*$/);
    if (arrayEntryMatch && activeArrayKey) {
      if (!Array.isArray(data[activeArrayKey])) data[activeArrayKey] = [];
      data[activeArrayKey].push(parseSimpleValue(arrayEntryMatch[1]));
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      activeArrayKey = null;
      continue;
    }

    const [, key, rawValue] = keyMatch;
    if (!rawValue.trim()) {
      data[key] = [];
      activeArrayKey = key;
      continue;
    }

    data[key] = parseSimpleValue(rawValue);
    activeArrayKey = Array.isArray(data[key]) ? key : null;
  }

  return data;
}

function parseMiniReflectionDocument(content, path) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const frontmatter = parseFrontmatter(frontmatterMatch ? frontmatterMatch[1] : "");
  const body = frontmatterMatch ? frontmatterMatch[2] : text;
  const decisionSection = extractMarkdownSection(body, "Continue / Pivot / Escalate");
  const decisionLine = decisionSection
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .find((line) => REFLECTION_DECISIONS.has(line));

  return {
    path,
    triggered_by: Array.isArray(frontmatter?.triggered_by)
      ? frontmatter.triggered_by.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [],
    trigger_at: typeof frontmatter?.trigger_at === "string" ? frontmatter.trigger_at : null,
    response_level: clampNumber(frontmatter?.response_level, null),
    decision: decisionLine || null,
  };
}

function readMiniReflections(planDir) {
  const reflectionsDir = join(planDir, "reflections");
  if (!existsSync(reflectionsDir)) {
    return {
      present: false,
      dir: reflectionsDir,
      reflections: [],
      latest: null,
      continue_count: 0,
    };
  }

  const reflections = readdirSync(reflectionsDir)
    .filter((name) => /^mini_.+\.md$/i.test(name))
    .map((name) => {
      const path = join(reflectionsDir, name);
      const content = safeRead(path);
      const stats = safeStat(path);
      return {
        ...parseMiniReflectionDocument(content || "", path),
        mtime_ms: stats?.mtimeMs || 0,
      };
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.trigger_at || "") || left.mtime_ms;
      const rightTime = Date.parse(right.trigger_at || "") || right.mtime_ms;
      return rightTime - leftTime;
    });

  return {
    present: true,
    dir: reflectionsDir,
    reflections,
    latest: reflections[0] || null,
    continue_count: reflections.filter((entry) => entry.decision === "continue").length,
  };
}

function percentile(values, targetPercentile) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => clampNumber(value, null))
    .filter((value) => value !== null)
    .sort((left, right) => left - right);

  if (numeric.length === 0) return null;
  const percentileValue = clampNumber(targetPercentile, 95);
  const index = Math.max(0, Math.min(numeric.length - 1, Math.ceil((percentileValue / 100) * numeric.length) - 1));
  return numeric[index];
}

function diffMinutes(startIso, endIso) {
  const startMs = Date.parse(startIso || "");
  const endMs = Date.parse(endIso || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Number(((endMs - startMs) / 60000).toFixed(3));
}

function buildProgressSegments(entries, progressPath) {
  const progressIndexes = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (isProgressMarkerEntry(entries[index], progressPath)) {
      progressIndexes.push(index);
    }
  }

  const completedSegments = [];
  let segmentStartIndex = 0;
  for (const markerIndex of progressIndexes) {
    const slice = entries.slice(segmentStartIndex, markerIndex + 1);
    if (slice.length > 0) {
      completedSegments.push(segmentFromEntries(slice, true));
    }
    segmentStartIndex = markerIndex + 1;
  }

  const currentSegment = segmentFromEntries(entries.slice(segmentStartIndex), false);
  return {
    progress_marker_count: progressIndexes.length,
    completed_segments: completedSegments,
    current_segment: currentSegment,
  };
}

function segmentFromEntries(entries, closedByProgress) {
  const first = entries[0] || null;
  const last = entries[entries.length - 1] || null;
  return {
    tool_calls: entries.length,
    start_seq: first?.seq || null,
    end_seq: last?.seq || null,
    start_ts: first?.ts || null,
    end_ts: last?.ts || null,
    duration_minutes: diffMinutes(first?.ts || null, last?.ts || null),
    closed_by_progress: closedByProgress === true,
    entries,
  };
}

function isProgressMarkerEntry(entry, progressPath) {
  return EDIT_TOOLS.has(entry?.tool) && pathMatchesAny(progressPath, entry?.paths || []);
}

function isReflectionEntry(entry, reflectionPaths) {
  return pathMatchesAnyFromList(entry?.paths || [], reflectionPaths);
}

function pathMatchesAnyFromList(paths, targets) {
  return (paths || []).some((path) => pathMatchesAny(path, targets));
}

function isPlanReadEntry(entry, planPath) {
  if (!READ_TOOLS.has(entry?.tool)) return false;
  return pathMatchesAnyFromList(entry?.paths || [], [planPath]);
}

function commandLooksLikeProofActivity(command) {
  const normalized = String(command || "").toLowerCase();
  return /\b(pytest|node --test|jest|vitest|mocha|rspec|go test|cargo test)\b/.test(normalized)
    || /\b(npm|pnpm|yarn|bun)\s+(test|run test|run check|run lint)\b/.test(normalized)
    || /\b(ripple_check|check-invariants|verify-stories|story_registry\.mjs check|test_migration|test_planner_script_smoke|test_transition_gate_flows)\b/.test(normalized)
    || /\b(validate-strategy|verify|smoke)\b/.test(normalized);
}

function isProofArtifactEntry(entry, context) {
  const reportTargets = [
    normalizeComparablePath(relative(context.cwd, join(context.cwd, "reports", "test_runs"))),
    context.progressPath,
    context.verificationPath,
  ].filter(Boolean);

  const touchesKnownArtifact = pathMatchesAnyFromList(entry?.paths || [], reportTargets)
    || (entry?.paths || []).some((filePath) => String(filePath || "").startsWith(`plans/${context.planId}/telemetry/`))
    || (entry?.paths || []).some((filePath) => String(filePath || "").startsWith(`plans/${context.planId}/artifacts/`));

  return touchesKnownArtifact || (entry?.tool === "Bash" && commandLooksLikeProofActivity(entry?.command));
}

function isImplementationEditEntry(entry, planId) {
  if (!EDIT_TOOLS.has(entry?.tool)) return false;
  return (entry?.paths || []).some((filePath) => !String(filePath || "").startsWith(`plans/${planId}/`));
}

function externalEditedFiles(entries, planId) {
  const files = [];
  for (const entry of entries) {
    if (!isImplementationEditEntry(entry, planId)) continue;
    for (const filePath of entry.paths || []) {
      if (String(filePath || "").startsWith(`plans/${planId}/`)) continue;
      files.push(filePath);
    }
  }
  return unique(files);
}

function isGeneratedArtifactPath(filePath) {
  const normalized = normalizeComparablePath(filePath);
  if (!normalized) return false;
  return GENERATED_ARTIFACT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || /\.(log|tmp|cache|snap)$/i.test(normalized);
}

function looksLikePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  return normalized.includes("/") || /\.[A-Za-z0-9_-]{1,12}$/.test(normalized);
}

function extractPathMentions(text, cwd) {
  const matches = [];
  const content = String(text || "");

  const codePattern = /`([^`\n]+)`/g;
  for (const match of content.matchAll(codePattern)) {
    if (looksLikePath(match[1])) matches.push(normalizeRepoPath(cwd, match[1]));
  }

  const pathPattern = /(?:^|[\s(])((?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)(?=$|[\s),:])/gm;
  for (const match of content.matchAll(pathPattern)) {
    if (looksLikePath(match[1])) matches.push(normalizeRepoPath(cwd, match[1]));
  }

  return unique(matches.filter(Boolean));
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractErrorPatternsFromRawOutput(rawOutput, { normalizeWhitespace: shouldNormalize }) {
  const lines = String(rawOutput || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const matches = [];
  for (const line of lines) {
    if (/^(typeerror|referenceerror|syntaxerror|assertionerror|error:|fail|failed:|cannot |unexpected )/i.test(line)) {
      matches.push(shouldNormalize ? normalizeWhitespace(line) : line);
    }
  }

  return unique(matches);
}

function extractOscillatingErrorPatterns(testRuns, thresholdConfig) {
  const runs = (testRuns || []).slice(0, thresholdConfig.lookback_tool_calls);
  const counts = new Map();

  for (const record of runs) {
    const failedSummaries = (record?.run?.tests || [])
      .filter((test) => String(test?.outcome || "").toLowerCase() === "fail")
      .map((test) => test?.output_summary)
      .filter(Boolean);

    const patterns = failedSummaries.length > 0
      ? failedSummaries.map((value) => thresholdConfig.normalize_whitespace ? normalizeWhitespace(value) : String(value))
      : extractErrorPatternsFromRawOutput(record?.run?.raw_output || "", {
          normalizeWhitespace: thresholdConfig.normalize_whitespace === true,
        });

    for (const pattern of patterns) {
      counts.set(pattern, (counts.get(pattern) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((left, right) => right.count - left.count);
}

function commandLooksLikeRevert(command, filePath) {
  const normalized = String(command || "").toLowerCase();
  if (!/\bgit\s+(restore|checkout|revert)\b/.test(normalized)) return false;
  const normalizedPath = String(filePath || "").toLowerCase();
  return normalized.includes(normalizedPath) || normalized.includes(basename(normalizedPath));
}

function isCheckpointCommand(command) {
  const normalized = String(command || "").toLowerCase();
  return /\bgit\s+commit\b/.test(normalized) && /\b(checkpoint|wip|savepoint|snapshot)\b/.test(normalized);
}

function findActiveCriterion(state, verification) {
  const currentStep = String(state?.current_step || "");
  const explicitMatch = currentStep.match(/\bCRIT-\d+\b/i);
  if (explicitMatch) {
    const explicitId = explicitMatch[0].toUpperCase();
    const matched = (verification.criteria || []).find((criterion) => criterion.id === explicitId) || null;
    return {
      id: explicitId,
      label: matched?.criterion || null,
      source: "state.current_step",
      criterion: matched,
      ambiguous: false,
    };
  }

  const incomplete = (verification.criteria || []).filter((criterion) => criterion.proof_sufficient !== true);
  if (incomplete.length === 1) {
    return {
      id: incomplete[0].id,
      label: incomplete[0].criterion || null,
      source: "sole_incomplete_verification_criterion",
      criterion: incomplete[0],
      ambiguous: false,
    };
  }

  return {
    id: null,
    label: null,
    source: incomplete.length > 1 ? "ambiguous_multiple_incomplete_criteria" : "not_available",
    criterion: null,
    ambiguous: incomplete.length > 1,
  };
}

function firstTraceTimestamp(entries) {
  return entries.find((entry) => typeof entry?.ts === "string")?.ts || null;
}

function latestStateTransitionTimestamp(state, targetState = null) {
  const desiredState = String(targetState || "").toUpperCase();
  if (!desiredState) return null;

  const transitions = Array.isArray(state?.transitions) ? state.transitions : [];
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (String(transition?.to || "").toUpperCase() !== desiredState) continue;
    if (typeof transition?.timestamp !== "string") continue;
    if (!Number.isFinite(Date.parse(transition.timestamp))) continue;
    return transition.timestamp;
  }

  return null;
}

function latestTraceTimestamp(entries, fallbackNow) {
  const latest = [...entries].reverse().find((entry) => typeof entry?.ts === "string");
  return latest?.ts || fallbackNow || null;
}

function computeSessionElapsedMinutes({ state, metrics, traceEntries, now }) {
  // Session age must come from runtime evidence for the active state, not from
  // plan creation timestamps that can predate EXECUTE by hours or days.
  const start = firstTraceTimestamp(traceEntries)
    || latestStateTransitionTimestamp(state, state?.state);
  if (!start) return null;
  const end = metrics?.closed_at || latestTraceTimestamp(traceEntries, now) || now || null;
  return diffMinutes(start, end);
}

function computeToolCallsSinceTimestamp(entries, timestamp) {
  const ts = Date.parse(timestamp || "");
  if (!Number.isFinite(ts)) return null;
  return entries.filter((entry) => {
    const entryTs = Date.parse(entry?.ts || "");
    return Number.isFinite(entryTs) && entryTs > ts;
  }).length;
}

function severityAtOrAbove(activeSeverity, configuredLevels = []) {
  const ranks = (configuredLevels || [])
    .map((level) => SEVERITY_RANK[String(level || "").toLowerCase()] || 0)
    .filter((rank) => rank > 0);
  if (ranks.length === 0) return false;
  const thresholdRank = Math.min(...ranks);
  return (SEVERITY_RANK[String(activeSeverity || "").toLowerCase()] || 0) >= thresholdRank;
}

function maxSeverity(signals) {
  const highest = (signals || [])
    .filter((signal) => signal.active)
    .reduce((current, signal) => {
      const currentRank = SEVERITY_RANK[current] || 0;
      const nextSeverity = String(signal.severity || "").toLowerCase();
      return (SEVERITY_RANK[nextSeverity] || 0) > currentRank ? nextSeverity : current;
    }, "none");
  return highest || "none";
}

function signalResult({ id, severity, status, reason, context = {} }) {
  return {
    id,
    family: SIGNAL_FAMILY[id] || "unknown",
    severity,
    status,
    active: status === "active",
    reason,
    context,
  };
}

function evaluateRepeatEdit(context, config) {
  const windowEntries = context.executeEntries.slice(-config.lookback_tool_calls);
  if (windowEntries.length === 0) {
    return signalResult({
      id: "thrashing_repeat_edit",
      severity: config.severity,
      status: "inactive",
      reason: "No EXECUTE trace entries available.",
    });
  }

  const editCounts = new Map();
  for (const entry of windowEntries) {
    if (!isImplementationEditEntry(entry, context.planId)) continue;
    for (const filePath of entry.paths || []) {
      editCounts.set(filePath, (editCounts.get(filePath) || 0) + 1);
    }
  }

  const repeated = [...editCounts.entries()]
    .map(([file, count]) => ({ file, count }))
    .filter((entry) => entry.count >= config.repeat_edit_count)
    .sort((left, right) => right.count - left.count);

  const recentProgressMarker = config.require_progress_stall === true
    ? windowEntries.some((entry) => isProgressMarkerEntry(entry, context.progressPath))
    : false;

  if (repeated.length === 0) {
    return signalResult({
      id: "thrashing_repeat_edit",
      severity: config.severity,
      status: "inactive",
      reason: "No file crossed the repeat-edit threshold inside the recent trace window.",
      context: {
        lookback_tool_calls: config.lookback_tool_calls,
        repeated_files: [],
      },
    });
  }

  if (config.require_progress_stall === true && recentProgressMarker) {
    return signalResult({
      id: "thrashing_repeat_edit",
      severity: config.severity,
      status: "inactive",
      reason: "Repeat edits occurred, but a progress marker appeared inside the same trace window.",
      context: {
        lookback_tool_calls: config.lookback_tool_calls,
        repeated_files: repeated,
      },
    });
  }

  return signalResult({
    id: "thrashing_repeat_edit",
    severity: config.severity,
    status: "active",
    reason: "The same file was edited repeatedly without a recent progress marker.",
    context: {
      lookback_tool_calls: config.lookback_tool_calls,
      repeated_files: repeated,
    },
  });
}

function evaluateOscillatingErrors(context, config) {
  if ((context.testRuns.runs || []).length === 0) {
    return signalResult({
      id: "thrashing_oscillating_errors",
      severity: config.severity,
      status: "unavailable",
      reason: "No structured plan test runs are available to extract repeated error patterns.",
    });
  }

  const patterns = extractOscillatingErrorPatterns(context.testRuns.runs, config);
  const repeated = patterns.filter((entry) => entry.count >= config.repeat_error_count);
  if (repeated.length === 0) {
    return signalResult({
      id: "thrashing_oscillating_errors",
      severity: config.severity,
      status: "inactive",
      reason: "Structured test runs do not show the same error pattern repeating often enough.",
      context: {
        repeat_error_count: config.repeat_error_count,
        observed_patterns: patterns.slice(0, 5),
      },
    });
  }

  return signalResult({
    id: "thrashing_oscillating_errors",
    severity: config.severity,
    status: "active",
    reason: "Recent structured test runs repeat the same failure pattern.",
    context: {
      repeat_error_count: config.repeat_error_count,
      repeated_patterns: repeated,
    },
  });
}

function evaluateBacktrackPattern(context, config) {
  const windowEntries = context.executeEntries.slice(-config.lookback_tool_calls);
  if (windowEntries.length === 0) {
    return signalResult({
      id: "thrashing_backtrack_pattern",
      severity: config.severity,
      status: "inactive",
      reason: "No EXECUTE trace entries available.",
    });
  }

  const byFile = new Map();
  for (let index = 0; index < windowEntries.length; index += 1) {
    const entry = windowEntries[index];
    if (!isImplementationEditEntry(entry, context.planId)) continue;
    for (const filePath of entry.paths || []) {
      if (!byFile.has(filePath)) byFile.set(filePath, []);
      byFile.get(filePath).push({ index, entry });
    }
  }

  const matched = [];
  for (const [filePath, editEvents] of byFile.entries()) {
    if (editEvents.length < config.distinct_edit_events) continue;

    if (config.require_revert_after_edit !== true) {
      matched.push({
        file: filePath,
        edit_events: editEvents.length,
        reverted: false,
      });
      continue;
    }

    let reverted = false;
    for (let eventIndex = 0; eventIndex < editEvents.length - 1 && !reverted; eventIndex += 1) {
      const currentEdit = editEvents[eventIndex];
      const nextEdit = editEvents[eventIndex + 1];
      for (let traceIndex = currentEdit.index + 1; traceIndex < nextEdit.index; traceIndex += 1) {
        if (windowEntries[traceIndex]?.tool === "Bash" && commandLooksLikeRevert(windowEntries[traceIndex]?.command, filePath)) {
          reverted = true;
          break;
        }
      }
    }

    if (reverted) {
      matched.push({
        file: filePath,
        edit_events: editEvents.length,
        reverted: true,
      });
    }
  }

  if (matched.length === 0) {
    return signalResult({
      id: "thrashing_backtrack_pattern",
      severity: config.severity,
      status: "inactive",
      reason: config.require_revert_after_edit === true
        ? "No edit-revert-edit pattern is visible in the recent trace window."
        : "No file reached the distinct-edit threshold in the recent trace window.",
      context: {
        lookback_tool_calls: config.lookback_tool_calls,
      },
    });
  }

  return signalResult({
    id: "thrashing_backtrack_pattern",
    severity: config.severity,
    status: "active",
    reason: "The recent trace shows edit/revert/edit backtracking on the same file.",
    context: {
      lookback_tool_calls: config.lookback_tool_calls,
      files: matched,
    },
  });
}

function evaluateCheckpointFlood(context, config) {
  const checkpointCommits = (context.progressSegments.current_segment.entries || [])
    .filter((entry) => entry.tool === "Bash" && isCheckpointCommand(entry.command))
    .map((entry) => ({
      seq: entry.seq,
      command: entry.command,
    }));

  if (checkpointCommits.length <= config.checkpoint_commits_per_criterion) {
    return signalResult({
      id: "thrashing_checkpoint_flood",
      severity: config.severity,
      status: "inactive",
      reason: "Checkpoint-style commits remain below the per-gap threshold.",
      context: {
        threshold: config.checkpoint_commits_per_criterion,
        count: checkpointCommits.length,
      },
    });
  }

  return signalResult({
    id: "thrashing_checkpoint_flood",
    severity: config.severity,
    status: "active",
    reason: "The current EXECUTE progress gap contains too many checkpoint-style commits.",
    context: {
      threshold: config.checkpoint_commits_per_criterion,
      count: checkpointCommits.length,
      commits: checkpointCommits,
      criterion_id: context.activeCriterion.id,
    },
  });
}

function evaluateToolCallVolume(context, config) {
  const historicalCounts = context.progressSegments.completed_segments
    .map((segment) => segment.tool_calls)
    .filter((value) => value > 0);

  if (historicalCounts.length === 0) {
    return signalResult({
      id: "thrashing_tool_call_volume",
      severity: config.severity,
      status: "unavailable",
      reason: "No completed progress gaps exist yet, so there is no plan-local call-volume baseline.",
    });
  }

  const baseline = percentile(historicalCounts, config.historical_percentile);
  const currentCalls = context.progressSegments.current_segment.tool_calls;
  const threshold = baseline !== null ? baseline * config.multiplier : null;

  if (baseline === null || threshold === null) {
    return signalResult({
      id: "thrashing_tool_call_volume",
      severity: config.severity,
      status: "unavailable",
      reason: "Plan-local progress gaps did not yield a usable tool-call baseline.",
    });
  }

  if (currentCalls <= threshold) {
    return signalResult({
      id: "thrashing_tool_call_volume",
      severity: config.severity,
      status: "inactive",
      reason: "Current EXECUTE call volume stays within the observed plan-local baseline.",
      context: {
        current_tool_calls: currentCalls,
        historical_baseline: baseline,
        threshold,
      },
    });
  }

  return signalResult({
    id: "thrashing_tool_call_volume",
    severity: config.severity,
    status: "active",
    reason: "Current EXECUTE call volume exceeds the observed plan-local baseline.",
    context: {
      current_tool_calls: currentCalls,
      historical_baseline: baseline,
      threshold,
      baseline_source: `completed_progress_gaps_p${config.historical_percentile}`,
    },
  });
}

function evaluateCriterionDurationSignal(context, config, signalId, multiplierKey) {
  const currentDuration = context.progressSegments.current_segment.duration_minutes;
  if (currentDuration === null) {
    return signalResult({
      id: signalId,
      severity: config.severity,
      status: "unavailable",
      reason: "Current EXECUTE trace segment does not have enough timestamp data.",
    });
  }

  const historicalDurations = context.progressSegments.completed_segments
    .map((segment) => segment.duration_minutes)
    .filter((value) => value !== null);

  const baseline = percentile(historicalDurations, 95);
  const threshold = Math.max(config.minimum_minutes, (baseline || config.minimum_minutes) * config[multiplierKey]);

  if (currentDuration <= threshold) {
    return signalResult({
      id: signalId,
      severity: config.severity,
      status: "inactive",
      reason: "Current EXECUTE duration remains within the available threshold.",
      context: {
        current_duration_minutes: currentDuration,
        threshold_minutes: threshold,
        baseline_minutes: baseline,
        baseline_source: baseline === null ? "threshold.minimum_minutes_fallback" : "completed_progress_gap_p95",
        criterion_id: context.activeCriterion.id,
      },
    });
  }

  return signalResult({
    id: signalId,
    severity: config.severity,
    status: "active",
    reason: "Current EXECUTE duration exceeds the available threshold.",
    context: {
      current_duration_minutes: currentDuration,
      threshold_minutes: threshold,
      baseline_minutes: baseline,
      baseline_source: baseline === null ? "threshold.minimum_minutes_fallback" : "completed_progress_gap_p95",
      criterion_id: context.activeCriterion.id,
    },
  });
}

function evaluateProgressDivergence(context, config) {
  if (context.plannedFiles.length === 0) {
    return signalResult({
      id: "thrashing_progress_divergence",
      severity: config.severity,
      status: "unavailable",
      reason: "plan.md does not currently list Files To Modify, so divergence cannot be checked truthfully.",
    });
  }

  if (context.progressMentionedPaths.length === 0) {
    return signalResult({
      id: "thrashing_progress_divergence",
      severity: config.severity,
      status: "inactive",
      reason: "progress.md does not mention any concrete file paths.",
    });
  }

  const overlapping = context.progressMentionedPaths.filter((filePath) => pathMatchesAny(filePath, context.plannedFiles));
  const unplanned = context.progressMentionedPaths.filter((filePath) => !pathMatchesAny(filePath, context.plannedFiles));
  const overlapRatio = overlapping.length / Math.max(context.progressMentionedPaths.length, 1);

  if (unplanned.length < config.minimum_unplanned_mentions || overlapRatio > config.path_overlap_ratio) {
    return signalResult({
      id: "thrashing_progress_divergence",
      severity: config.severity,
      status: "inactive",
      reason: "progress.md does not drift far enough away from the planned file list.",
      context: {
        planned_files: context.plannedFiles,
        progress_paths: context.progressMentionedPaths,
        overlap_ratio: Number(overlapRatio.toFixed(3)),
        unplanned_paths: unplanned,
      },
    });
  }

  return signalResult({
    id: "thrashing_progress_divergence",
    severity: config.severity,
    status: "active",
    reason: "progress.md mentions unplanned paths with low enough overlap to the planned file list.",
    context: {
      planned_files: context.plannedFiles,
      progress_paths: context.progressMentionedPaths,
      overlap_ratio: Number(overlapRatio.toFixed(3)),
      unplanned_paths: unplanned,
    },
  });
}

function evaluateSilentScopeCreep(context, config) {
  if (context.plannedFiles.length === 0) {
    return signalResult({
      id: "thrashing_silent_scope_creep",
      severity: config.severity,
      status: "unavailable",
      reason: "plan.md does not currently list Files To Modify, so edited-file scope cannot be checked truthfully.",
    });
  }

  let editedFiles = [...context.editedFiles];
  if (config.allow_listed_generated_artifacts === true) {
    editedFiles = editedFiles.filter((filePath) => !isGeneratedArtifactPath(filePath));
  }

  const unplanned = editedFiles.filter((filePath) => !pathMatchesAny(filePath, context.plannedFiles));
  if (unplanned.length < config.unplanned_file_count) {
    return signalResult({
      id: "thrashing_silent_scope_creep",
      severity: config.severity,
      status: "inactive",
      reason: "Edited files remain within the planned scope threshold.",
      context: {
        edited_files: editedFiles,
        unplanned_files: unplanned,
        threshold: config.unplanned_file_count,
      },
    });
  }

  return signalResult({
    id: "thrashing_silent_scope_creep",
    severity: config.severity,
    status: "active",
    reason: "Edited files exceed the planned scope threshold.",
    context: {
      edited_files: editedFiles,
      unplanned_files: unplanned,
      threshold: config.unplanned_file_count,
    },
  });
}

function evaluateTestRegression(context, config) {
  const latest = context.testRuns.runs[0] || null;
  if (!latest) {
    return signalResult({
      id: "thrashing_test_regression",
      severity: config.severity,
      status: "unavailable",
      reason: "No structured plan test runs are available to compare pass/fail history.",
    });
  }

  const latestFailingTests = (latest.run.tests || [])
    .filter((test) => String(test?.outcome || "").toLowerCase() === "fail")
    .map((test) => ({
      name: String(test?.name || "").trim(),
      file: String(test?.file || "").trim(),
      output_summary: String(test?.output_summary || "").trim(),
    }));

  if (latestFailingTests.length < config.failing_runs) {
    return signalResult({
      id: "thrashing_test_regression",
      severity: config.severity,
      status: "inactive",
      reason: "The latest structured test run does not fail often enough to cross the regression threshold.",
      context: {
        latest_failed_tests: latestFailingTests,
        threshold: config.failing_runs,
      },
    });
  }

  if (config.require_prior_pass !== true) {
    return signalResult({
      id: "thrashing_test_regression",
      severity: config.severity,
      status: "active",
      reason: "The latest structured test run fails often enough to cross the regression threshold.",
      context: {
        latest_failed_tests: latestFailingTests,
        threshold: config.failing_runs,
      },
    });
  }

  const priorPassKeys = new Set();
  for (const record of context.testRuns.runs.slice(1)) {
    for (const test of record.run.tests || []) {
      if (String(test?.outcome || "").toLowerCase() !== "pass") continue;
      const key = `${String(test?.file || "").trim()}::${String(test?.name || "").trim()}`;
      priorPassKeys.add(key);
    }
  }

  const regressed = latestFailingTests.filter((test) => priorPassKeys.has(`${test.file}::${test.name}`));
  if (regressed.length < config.failing_runs) {
    return signalResult({
      id: "thrashing_test_regression",
      severity: config.severity,
      status: "inactive",
      reason: priorPassKeys.size === 0
        ? "Latest failures exist, but there is no prior passing test history for comparison."
        : "Latest failures do not map back to enough prior passes to prove a regression.",
      context: {
        latest_failed_tests: latestFailingTests,
        regressed_tests: regressed,
        threshold: config.failing_runs,
      },
    });
  }

  return signalResult({
    id: "thrashing_test_regression",
    severity: config.severity,
    status: "active",
    reason: "The latest structured test run regresses tests that were previously passing in this plan.",
    context: {
      latest_failed_tests: latestFailingTests,
      regressed_tests: regressed,
      threshold: config.failing_runs,
    },
  });
}

function evaluateNoArtifactProgress(context, config) {
  if (config.require_active_criterion === true && !context.activeCriterion.id) {
    return signalResult({
      id: "thrashing_no_artifact_progress",
      severity: config.severity,
      status: "unavailable",
      reason: "No single active criterion can be identified for the current plan state.",
      context: {
        active_criterion_source: context.activeCriterion.source,
      },
    });
  }

  const lastProofIndex = findLastIndex(context.executeEntries, (entry) => isProofArtifactEntry(entry, context));
  const stalledCalls = lastProofIndex === -1
    ? context.executeEntries.length
    : context.executeEntries.length - lastProofIndex - 1;

  const criterionIncomplete = context.activeCriterion.criterion
    ? context.activeCriterion.criterion.proof_sufficient !== true
    : true;

  if (!criterionIncomplete || stalledCalls < config.stalled_tool_calls) {
    return signalResult({
      id: "thrashing_no_artifact_progress",
      severity: config.severity,
      status: "inactive",
      reason: criterionIncomplete
        ? "Recent trace still contains proof or artifact activity often enough."
        : "The identified active criterion is already proof-sufficient.",
      context: {
        stalled_tool_calls: stalledCalls,
        threshold: config.stalled_tool_calls,
        criterion_id: context.activeCriterion.id,
        telemetry_summary_mode: context.telemetrySummary?.mode || null,
      },
    });
  }

  return signalResult({
    id: "thrashing_no_artifact_progress",
    severity: config.severity,
    status: "active",
    reason: "The recent trace shows too many tool calls without proof or artifact progress.",
    context: {
      stalled_tool_calls: stalledCalls,
      threshold: config.stalled_tool_calls,
      criterion_id: context.activeCriterion.id,
      telemetry_summary_mode: context.telemetrySummary?.mode || null,
    },
  });
}

function evaluateSessionOverbudget(context, config) {
  const sessionElapsed = computeSessionElapsedMinutes({
    state: context.state,
    metrics: context.metrics,
    traceEntries: context.executeEntries,
    now: context.now,
  });

  if (sessionElapsed === null) {
    return signalResult({
      id: "thrashing_session_overbudget",
      severity: config.severity,
      status: "unavailable",
      reason: "Session duration cannot be computed from plan-local timestamps.",
    });
  }

  const historicalDurations = context.progressSegments.completed_segments
    .map((segment) => segment.duration_minutes)
    .filter((value) => value !== null);
  const criteriaCount = context.criteriaCount;
  const baselineCriterionMinutes = percentile(historicalDurations, 95);
  const estimatedMinutes = baselineCriterionMinutes !== null && criteriaCount > 0
    ? baselineCriterionMinutes * criteriaCount
    : config.minimum_minutes;
  const threshold = Math.max(config.minimum_minutes, estimatedMinutes * config.budget_multiplier);

  if (sessionElapsed <= threshold) {
    return signalResult({
      id: "thrashing_session_overbudget",
      severity: config.severity,
      status: "inactive",
      reason: "Session duration remains within the available estimate.",
      context: {
        session_elapsed_minutes: sessionElapsed,
        threshold_minutes: threshold,
        estimated_minutes: estimatedMinutes,
        criteria_count: criteriaCount,
        baseline_source: baselineCriterionMinutes === null
          ? "threshold.minimum_minutes_fallback"
          : "completed_progress_gap_p95_x_criteria_count",
      },
    });
  }

  return signalResult({
    id: "thrashing_session_overbudget",
    severity: config.severity,
    status: "active",
    reason: "Session duration exceeds the available plan-local estimate.",
    context: {
      session_elapsed_minutes: sessionElapsed,
      threshold_minutes: threshold,
      estimated_minutes: estimatedMinutes,
      criteria_count: criteriaCount,
      baseline_source: baselineCriterionMinutes === null
        ? "threshold.minimum_minutes_fallback"
        : "completed_progress_gap_p95_x_criteria_count",
    },
  });
}

function evaluateReflectOverdue(context, config) {
  const latestMiniReflect = context.miniReflections.latest;
  const toolCallsSinceMini = latestMiniReflect?.trigger_at
    ? computeToolCallsSinceTimestamp(context.executeEntries, latestMiniReflect.trigger_at)
    : null;

  if (config.ignore_if_recent_mini_reflect === true && toolCallsSinceMini !== null && toolCallsSinceMini < config.tool_calls_without_reflect) {
    return signalResult({
      id: "thrashing_reflect_overdue",
      severity: config.severity,
      status: "inactive",
      reason: "A recent mini-reflection exists inside the configured ignore window.",
      context: {
        tool_calls_since_mini_reflect: toolCallsSinceMini,
        threshold: config.tool_calls_without_reflect,
      },
    });
  }

  const reflectionTargets = [context.reflectionPath];
  if (latestMiniReflect?.path) reflectionTargets.push(normalizeRepoPath(context.cwd, latestMiniReflect.path));
  const lastReflectIndex = findLastIndex(context.executeEntries, (entry) => isReflectionEntry(entry, reflectionTargets));
  const toolCallsSinceReflect = lastReflectIndex === -1
    ? context.executeEntries.length
    : context.executeEntries.length - lastReflectIndex - 1;

  if (toolCallsSinceReflect < config.tool_calls_without_reflect) {
    return signalResult({
      id: "thrashing_reflect_overdue",
      severity: config.severity,
      status: "inactive",
      reason: "Reflection activity still falls inside the allowed trace window.",
      context: {
        tool_calls_since_reflect: toolCallsSinceReflect,
        threshold: config.tool_calls_without_reflect,
      },
    });
  }

  return signalResult({
    id: "thrashing_reflect_overdue",
    severity: config.severity,
    status: "active",
    reason: "Too many EXECUTE tool calls have happened without reflection activity.",
    context: {
      tool_calls_since_reflect: toolCallsSinceReflect,
      threshold: config.tool_calls_without_reflect,
    },
  });
}

function evaluatePlanNotReread(context, config) {
  const lastPlanReadIndex = findLastIndex(context.executeEntries, (entry) => isPlanReadEntry(entry, context.planPath));
  const toolCallsSincePlanRead = lastPlanReadIndex === -1
    ? context.executeEntries.length
    : context.executeEntries.length - lastPlanReadIndex - 1;

  if (toolCallsSincePlanRead < config.tool_calls_since_plan_read) {
    return signalResult({
      id: "thrashing_plan_not_reread",
      severity: config.severity,
      status: "inactive",
      reason: "plan.md was re-read recently enough for the configured trace window.",
      context: {
        tool_calls_since_plan_read: toolCallsSincePlanRead,
        threshold: config.tool_calls_since_plan_read,
      },
    });
  }

  return signalResult({
    id: "thrashing_plan_not_reread",
    severity: config.severity,
    status: "active",
    reason: "plan.md has not been re-read inside the configured trace window.",
    context: {
      tool_calls_since_plan_read: toolCallsSincePlanRead,
      threshold: config.tool_calls_since_plan_read,
      warn_before_block: config.warn_before_block === true,
    },
  });
}

function evaluateSpotCheckSevere(context, config) {
  const signals = recentSpotCheckSignals({
    cwd: context.cwd,
    planId: context.planId,
    severeThreshold: config.high_finding_count,
    persistentThreshold: Number.MAX_SAFE_INTEGER,
  });
  if (!signals.severe) {
    return signalResult({
      id: "thrashing_spot_check_severe",
      severity: config.severity,
      status: "inactive",
      reason: "Unacknowledged HIGH spot-check findings are below the severe threshold.",
      context: {
        high_unacknowledged_count: signals.high_unacknowledged_count,
        threshold: config.high_finding_count,
        lookback_tool_calls: config.lookback_tool_calls,
      },
    });
  }
  return signalResult({
    id: "thrashing_spot_check_severe",
    severity: config.severity,
    status: "active",
    reason: "Unacknowledged HIGH spot-check findings crossed the severe threshold.",
    context: {
      high_unacknowledged_count: signals.high_unacknowledged_count,
      threshold: config.high_finding_count,
      lookback_tool_calls: config.lookback_tool_calls,
    },
  });
}

function evaluateSpotCheckPersistent(context, config) {
  const findings = recentSpotCheckSignals({
    cwd: context.cwd,
    planId: context.planId,
    severeThreshold: Number.MAX_SAFE_INTEGER,
    persistentThreshold: config.recurrence_count,
  });
  if (findings.persistent_categories.length === 0) {
    return signalResult({
      id: "thrashing_spot_check_persistent",
      severity: config.severity,
      status: "inactive",
      reason: "No unacknowledged spot-check category recurred enough times to count as persistent.",
      context: {
        threshold: config.recurrence_count,
        persistent_categories: [],
      },
    });
  }
  return signalResult({
    id: "thrashing_spot_check_persistent",
    severity: config.severity,
    status: "active",
    reason: "The same spot-check category is recurring without acknowledgement.",
    context: {
      threshold: config.recurrence_count,
      persistent_categories: findings.persistent_categories,
    },
  });
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}

function determineResponse(signals, thresholds, miniReflections, executeEntries) {
  const activeSignals = signals.filter((signal) => signal.active);
  const activeCount = activeSignals.length;
  const severityMax = maxSeverity(activeSignals);
  const baseLevel = activeCount === 0
    ? 0
    : (
      activeCount >= thresholds.response_progression.level_2_mini_reflect.min_active_signals
      || severityAtOrAbove(severityMax, thresholds.response_progression.level_2_mini_reflect.severe_signal_levels)
    )
      ? 2
      : activeCount >= thresholds.response_progression.level_1_hint.min_active_signals
        ? 1
        : 0;

  const latestMini = miniReflections.latest;
  const toolCallsSinceLatestMini = latestMini?.trigger_at
    ? computeToolCallsSinceTimestamp(executeEntries, latestMini.trigger_at)
    : null;
  const retriggerWindow = thresholds.response_progression.level_3_hard_block.retrigger_within_tool_calls;
  const continueThreshold = thresholds.response_progression.level_3_hard_block.continue_decisions_before_block;
  const latestTriggeredBy = Array.isArray(latestMini?.triggered_by) ? latestMini.triggered_by : [];
  const retriggeredSignalIds = activeSignals
    .map((signal) => signal.id)
    .filter((signalId) => latestTriggeredBy.includes(signalId));
  const latestDecisionContinue = latestMini?.decision === "continue";
  const cooldownActive = latestDecisionContinue
    && toolCallsSinceLatestMini !== null
    && toolCallsSinceLatestMini < retriggerWindow
    && retriggeredSignalIds.length > 0
    && miniReflections.continue_count < continueThreshold;
  const hardBlockEligible = latestDecisionContinue
    && retriggeredSignalIds.length > 0
    && miniReflections.continue_count >= continueThreshold;

  const effectiveLevel = hardBlockEligible
    ? 3
    : cooldownActive && baseLevel >= 2
      ? 1
      : baseLevel;

  const recommendedAction = effectiveLevel === 3
    ? "human_escalation_block"
    : effectiveLevel === 2
      ? "auto_mini_reflect"
      : effectiveLevel === 1 && cooldownActive
        ? "cooldown_hint_only"
        : effectiveLevel === 1
          ? "hint_only"
          : "continue";

  return {
    severity_max: severityMax,
    response_level: effectiveLevel,
    base_response_level: baseLevel,
    recommended_action: recommendedAction,
    cooldown: {
      active: cooldownActive,
      latest_decision: latestMini?.decision || null,
      last_mini_reflection_path: latestMini?.path || null,
      tool_calls_since_last_mini_reflect: toolCallsSinceLatestMini,
      retrigger_window_tool_calls: retriggerWindow,
      cooldown_remaining_tool_calls: cooldownActive && toolCallsSinceLatestMini !== null
        ? Math.max(0, retriggerWindow - toolCallsSinceLatestMini)
        : 0,
      triggered_by_signal_ids: latestTriggeredBy,
      retriggered_signal_ids: retriggeredSignalIds,
      continue_decisions_count: miniReflections.continue_count,
      continue_decisions_before_block: continueThreshold,
      hard_block_eligible: hardBlockEligible,
    },
  };
}

function buildContext({ cwd, planDir, planId, now, thresholds }) {
  const state = readStateJson(planDir) || {};
  const files = readPlanFiles(planDir);
  const verification = readVerificationStrategy(planDir);
  const trace = readToolTrace(planDir, cwd);
  const testRuns = readStructuredTestRuns(cwd, planId);
  const miniReflections = readMiniReflections(planDir);
  const plannedFiles = extractFilesToModify(files.planContent)
    .map((filePath) => normalizeRepoPath(cwd, filePath))
    .filter(Boolean);
  const progressMentionedPaths = extractPathMentions(files.progressContent, cwd);
  const progressPath = normalizeRepoPath(cwd, files.progressPath);
  const planPath = normalizeRepoPath(cwd, files.planPath);
  const verificationPath = normalizeRepoPath(cwd, join(planDir, "verification.md"));
  const reflectionPath = normalizeRepoPath(cwd, files.reflectionPath);
  const progressSegments = buildProgressSegments(trace.executeEntries, progressPath);
  const criteriaCount = verification.criteria.length || extractSuccessCriteria(files.planContent).length;
  const activeCriterion = findActiveCriterion(state, verification);

  return {
    cwd,
    now,
    planDir,
    planId,
    thresholds,
    state,
    metrics: files.metrics || {},
    telemetrySummary: files.telemetrySummary || null,
    verification,
    testRuns,
    miniReflections,
    planContent: files.planContent,
    progressContent: files.progressContent,
    plannedFiles,
    progressMentionedPaths,
    progressPath,
    planPath,
    verificationPath,
    reflectionPath,
    tracePresent: trace.present,
    tracePath: trace.path,
    traceEntries: trace.entries,
    executeEntries: trace.executeEntries,
    progressSegments,
    activeCriterion,
    criteriaCount,
    editedFiles: externalEditedFiles(trace.executeEntries, planId),
  };
}

export function evaluateThrashingDetector({
  cwd = process.cwd(),
  planDir,
  planId = null,
  now = new Date().toISOString(),
} = {}) {
  if (!planDir) {
    return {
      ok: false,
      error: "planDir is required",
    };
  }

  const thresholdsLoad = loadThrashingThresholds({ cwd });
  if (!thresholdsLoad.ok) {
    return {
      ok: false,
      error: "thrashing_thresholds_invalid",
      details: thresholdsLoad.errors || [],
    };
  }

  const resolvedPlanId = planId || basename(planDir);
  const context = buildContext({
    cwd,
    planDir,
    planId: resolvedPlanId,
    now,
    thresholds: thresholdsLoad.thresholds,
  });

  const signalConfigs = thresholdsLoad.thresholds.signals || {};
  const signals = THRASHING_SIGNAL_ORDER.map((signalId) => {
    const config = signalConfigs[signalId];
    if (!config || config.enabled !== true) {
      return signalResult({
        id: signalId,
        severity: config?.severity || "low",
        status: "disabled",
        reason: "Signal is disabled in thrashing_thresholds.yaml.",
      });
    }

    switch (signalId) {
      case "thrashing_repeat_edit":
        return evaluateRepeatEdit(context, config);
      case "thrashing_oscillating_errors":
        return evaluateOscillatingErrors(context, config);
      case "thrashing_backtrack_pattern":
        return evaluateBacktrackPattern(context, config);
      case "thrashing_checkpoint_flood":
        return evaluateCheckpointFlood(context, config);
      case "thrashing_tool_call_volume":
        return evaluateToolCallVolume(context, config);
      case "thrashing_criterion_stuck":
        return evaluateCriterionDurationSignal(context, config, signalId, "duration_multiplier");
      case "thrashing_progress_divergence":
        return evaluateProgressDivergence(context, config);
      case "thrashing_silent_scope_creep":
        return evaluateSilentScopeCreep(context, config);
      case "thrashing_test_regression":
        return evaluateTestRegression(context, config);
      case "thrashing_no_artifact_progress":
        return evaluateNoArtifactProgress(context, config);
      case "thrashing_criterion_overbudget":
        return evaluateCriterionDurationSignal(context, config, signalId, "budget_multiplier");
      case "thrashing_session_overbudget":
        return evaluateSessionOverbudget(context, config);
      case "thrashing_reflect_overdue":
        return evaluateReflectOverdue(context, config);
      case "thrashing_plan_not_reread":
        return evaluatePlanNotReread(context, config);
      case "thrashing_spot_check_severe":
        return evaluateSpotCheckSevere(context, config);
      case "thrashing_spot_check_persistent":
        return evaluateSpotCheckPersistent(context, config);
      default:
        return signalResult({
          id: signalId,
          severity: config.severity,
          status: "unavailable",
          reason: "Signal id is not implemented.",
        });
    }
  });

  const response = determineResponse(signals, thresholdsLoad.thresholds, context.miniReflections, context.executeEntries);
  const activeSignals = signals.filter((signal) => signal.active);

  return {
    ok: true,
    generated_at: now,
    plan_id: resolvedPlanId,
    plan_dir: planDir,
    thresholds_profile: thresholdsLoad.thresholds.defaults_profile,
    sources: {
      tool_trace: {
        present: context.tracePresent,
        path: context.tracePath,
        total_entries: context.traceEntries.length,
        execute_entries: context.executeEntries.length,
      },
      plan: {
        present: existsSync(join(planDir, "plan.md")),
        path: join(planDir, "plan.md"),
      },
      progress: {
        present: existsSync(join(planDir, "progress.md")),
        path: join(planDir, "progress.md"),
      },
      state: {
        present: existsSync(join(planDir, "state.json")),
        path: join(planDir, "state.json"),
      },
      metrics: {
        present: existsSync(join(planDir, "metrics.json")),
        path: join(planDir, "metrics.json"),
      },
      telemetry_summary: {
        present: existsSync(join(planDir, "telemetry", "summary.json")),
        path: join(planDir, "telemetry", "summary.json"),
        mode: context.telemetrySummary?.mode || null,
      },
      verification_strategy: {
        present: context.verification.present,
        ok: context.verification.ok,
        path: context.verification.path,
        criteria_count: context.verification.criteria.length,
      },
      test_runs: {
        present: context.testRuns.present,
        dir: context.testRuns.dir,
        count: context.testRuns.runs.length,
      },
      mini_reflections: {
        present: context.miniReflections.present,
        dir: context.miniReflections.dir,
        count: context.miniReflections.reflections.length,
      },
    },
    status: {
      criteria_count: context.criteriaCount,
      active_criterion: {
        id: context.activeCriterion.id,
        label: context.activeCriterion.label,
        source: context.activeCriterion.source,
        ambiguous: context.activeCriterion.ambiguous,
      },
      current_progress_gap: {
        tool_calls: context.progressSegments.current_segment.tool_calls,
        duration_minutes: context.progressSegments.current_segment.duration_minutes,
        start_seq: context.progressSegments.current_segment.start_seq,
        start_ts: context.progressSegments.current_segment.start_ts,
      },
      completed_progress_gaps: context.progressSegments.completed_segments.length,
      planned_files: context.plannedFiles,
      edited_files: context.editedFiles,
      progress_mentioned_paths: context.progressMentionedPaths,
    },
    active_signal_ids: activeSignals.map((signal) => signal.id),
    signals,
    severity_max: response.severity_max,
    response_level: response.response_level,
    base_response_level: response.base_response_level,
    recommended_action: response.recommended_action,
    cooldown: response.cooldown,
  };
}

function printHelp() {
  console.log(`thrashing_detector.mjs — deterministic Phase 2.8 detector core

Usage:
  node .agent/skills/iterative-planner/scripts/thrashing_detector.mjs --plan <plan-dir>
  node .agent/skills/iterative-planner/scripts/thrashing_detector.mjs --plan <plan-dir> --compact

Behavior:
  - Reads plan-local trace, state, plan, progress, metrics, telemetry, reflection, and verification surfaces
  - Evaluates all 14 canonical signal ids from .agent/thrashing_thresholds.yaml
  - Emits structured JSON with signal status plus response/cooldown metadata
`);
}

export function main(argv = process.argv.slice(2)) {
  const cli = parseCliArgs(argv);
  if (cli.flags.help) {
    printHelp();
    return 0;
  }

  const { plansDir } = getPaths(cli.cwd);
  const target = resolvePlanTarget(plansDir, {
    plan: cli.plan || null,
    exitOnMissing: false,
  });

  if (!target.planDir || !target.planDirName) {
    const payload = {
      ok: false,
      error: "missing_plan",
      details: "Pass --plan <plan-dir> or set an active plan.",
    };
    emitJson(payload, { fd: 2, space: cli.flags.compact ? 0 : 2 });
    return 1;
  }

  const result = evaluateThrashingDetector({
    cwd: cli.cwd,
    planDir: target.planDir,
    planId: target.planDirName,
    now: cli.now || new Date().toISOString(),
  });

  if (result.ok) {
    emitJson(result, { space: cli.flags.compact ? 0 : 2 });
    return 0;
  }

  emitJson(result, { fd: 2, space: cli.flags.compact ? 0 : 2 });
  return 1;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  process.exitCode = main();
}
