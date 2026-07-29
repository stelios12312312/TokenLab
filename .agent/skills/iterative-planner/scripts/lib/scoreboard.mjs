// scoreboard.mjs - E2-5 fail-closed metrics scoreboard.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import {
  REQUIRED_DEFECT_CLASSES,
  runSeededDefectHarness,
} from "../seeded_defect_harness.mjs";
import { buildAbTaskBenchmark } from "./ab_task_benchmark.mjs";
import {
  DEFAULT_DELIVERY_RECEIPT_ARTIFACT_DIR,
  collectDeliveryReceiptEscalationTelemetry,
} from "./delivery_receipt_assembler.mjs";
import { findingsFromScoreboardReport } from "./deterministic_findings.mjs";
import { buildIdeationQualityBenchmark } from "./ideation_quality_benchmark.mjs";
import { buildPackGuardBenchmark } from "./pack_guard_benchmark.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SCRIPTS_DIR = resolve(LIB_DIR, "..");
const SKILL_ROOT = resolve(SCRIPTS_DIR, "..");
const TESTS_ROOT = join(SKILL_ROOT, "tests");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");
const NODE = process.execPath;

export const SCOREBOARD_SCHEMA_VERSION = 1;
export const DEFAULT_BASELINE_PATH = "plans/programs/ive-autocoder-v2/baselines/baseline-2026-06-12.json";
export const DEFAULT_SCOREBOARD_OUT_DIR = "reports/ive/scoreboard";
export const DEFAULT_CONFORMANCE_BUDGET_MS = 420000;
export const DEFAULT_CONFORMANCE_TIMEOUT_MS = 480000;
export const SAMPLE_TIMESTAMP = "2026-01-01T00:00:00.000Z";
export const SCOREBOARD_ID = "ive_autocoder_v2_scoreboard";
export const CONVERGENCE_MIN_PLAN_COUNT = 5;
export const CONVERGENCE_SCAN_LIMIT = 12;

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasNumeric(value) {
  return asNullableNumber(value) !== null;
}

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, asNumber(value)));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rel(path) {
  if (!path) return null;
  return relative(REPO_ROOT, resolve(path)).split("\\").join("/");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function safeReadText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function safeReadJson(path) {
  try {
    return existsSync(path) ? readJson(path) : null;
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function delta(current, baseline) {
  return asNumber(current) - asNumber(baseline);
}

function issue(code, detail, extra = {}) {
  return {
    code,
    severity: "regression",
    detail,
    ...extra,
  };
}

function commandString(argv) {
  return argv.join(" ");
}

function subprocessEnv() {
  const env = {
    ...process.env,
    NO_COLOR: "1",
    PLANNER_SKIP_SELF_HEAL: "1",
  };
  delete env.PLANNER_VERIFICATION_EXECUTE;
  return env;
}

function parseJsonMaybe(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, value: null, error: "empty stdout" };
  try {
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error.message };
  }
}

export function runScoreboardJsonCommand(argv, {
  cwd = REPO_ROOT,
  timeoutMs = DEFAULT_CONFORMANCE_TIMEOUT_MS,
  maxBuffer = 80 * 1024 * 1024,
} = {}) {
  const started = Date.now();
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), {
      cwd,
      env: subprocessEnv(),
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseJsonMaybe(stdout);
    return {
      ok: parsed.ok,
      exit_code: 0,
      timed_out: false,
      duration_ms: Date.now() - started,
      command: commandString(argv),
      json: parsed.value,
      parse_error: parsed.error,
      stderr_excerpt: "",
    };
  } catch (error) {
    const stdout = error.stdout?.toString?.() || "";
    const stderr = error.stderr?.toString?.() || "";
    const parsed = parseJsonMaybe(stdout);
    return {
      ok: false,
      exit_code: Number.isFinite(error.status) ? error.status : null,
      signal: error.signal || null,
      timed_out: error.signal === "SIGTERM" || /timed out/i.test(error.message || ""),
      duration_ms: Date.now() - started,
      command: commandString(argv),
      json: parsed.value,
      parse_error: parsed.error,
      error: error.message,
      stderr_excerpt: stderr.slice(0, 2000),
    };
  }
}

export function loadScoreboardBaseline(path = DEFAULT_BASELINE_PATH, { cwd = REPO_ROOT } = {}) {
  const resolved = resolve(cwd, path);
  if (!existsSync(resolved)) {
    throw new Error(`Scoreboard baseline not found: ${path}`);
  }
  return {
    path,
    resolved_path: resolved,
    document: readJson(resolved),
  };
}

function normalizeConformance(input = {}) {
  const wrappedCommand = Object.prototype.hasOwnProperty.call(input, "json");
  const json = input.json || input;
  const started = Date.parse(json.run_started_at || "");
  const finished = Date.parse(json.run_finished_at || "");
  const derivedWallClock = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null;
  const checks = Array.isArray(json.checks) ? json.checks : (Array.isArray(json.suites) ? json.suites : []);
  const durationTotal = checks.reduce((sum, row) => sum + asNumber(row.duration_ms), 0);
  const reportedWallClock = asNullableNumber(json.wall_clock_ms);
  const wallClockMs = reportedWallClock ?? derivedWallClock ?? (checks.length > 0 ? durationTotal : null);
  const warningCount = asNumber(json.warning_count);
  const advisoryWarningCount = Math.min(
    warningCount,
    checks.filter((row) => normalizeVerificationStatus(row.status, "execution").kind === "pending" && row.required === false).length,
  );
  const status = json.status || json.overall_status || "UNKNOWN";
  return {
    ok: verificationStatusIsPass(status, "execution") && !input.timed_out,
    run_id: json.run_id || null,
    status,
    suite_count: asNumber(json.command_count ?? json.suite_count ?? checks.length),
    pass_count: asNumber(json.passed_count ?? json.pass_count ?? checks.filter((row) => verificationStatusIsPass(row.status, "execution")).length),
    failed_required_count: asNumber(json.failed_required_count),
    warning_count: warningCount,
    advisory_warning_count: advisoryWarningCount,
    warning_regression_count: Math.max(0, warningCount - advisoryWarningCount),
    skipped_count: asNumber(json.skipped_count),
    not_applicable_count: asNumber(json.not_applicable_count),
    not_implemented_count: asNumber(json.not_implemented_count),
    wall_clock_ms: wallClockMs,
    wall_clock_source: reportedWallClock !== null
      ? "child_report"
      : (derivedWallClock !== null ? "child_timestamps" : (checks.length > 0 ? "child_suite_durations" : "unavailable")),
    orchestration_duration_ms: wrappedCommand ? asNullableNumber(input.duration_ms) : null,
    timed_out: !!input.timed_out,
    exit_code: input.exit_code ?? 0,
    issues: Array.isArray(json.issues) ? json.issues : [],
    manifest_path: input.manifest_path || null,
  };
}

function normalizeBehavior(input = {}) {
  const metrics = input.json || input;
  const naturePct = metrics.nature_pct_of_classified || metrics.summary?.bounce_nature_pct || metrics.bounce_nature_pct || {};
  const autocoderScoreboard = normalizeAutocoderScoreboard(metrics.autocoder_scoreboard || metrics.summary?.autocoder_scoreboard || null);
  return {
    ok: input.ok !== false,
    total_runs: asNumber(metrics.total_runs ?? metrics.summary?.total_runs),
    total_gate_bounces: asNumber(metrics.total_gate_bounces ?? metrics.summary?.total_gate_bounces),
    bounce_rate_per_run: round(asNumber(metrics.total_gate_bounces ?? metrics.summary?.total_gate_bounces) / Math.max(1, asNumber(metrics.total_runs ?? metrics.summary?.total_runs))),
    nature_pct_of_classified: {
      ceremony: asNumber(naturePct.ceremony),
      substantive: asNumber(naturePct.substantive),
      hybrid: asNumber(naturePct.hybrid),
      unknown: asNumber(naturePct.unknown),
    },
    autocoder_scoreboard: autocoderScoreboard,
    output_volume_lines: metrics.output_volume_lines || null,
  };
}

function rateFromCounts(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator, 3) : 0;
}

function normalizeAutocoderScoreboard(scoreboard = null) {
  if (!scoreboard || typeof scoreboard !== "object") return null;
  const copy = deepClone(scoreboard);
  const metrics = { ...(copy.metrics || {}) };
  const detail = { ...(copy.detail || {}) };
  const proof = { ...(detail.proof || {}) };
  const plans = { ...(detail.plans || {}) };
  const programExpected = asNumber(proof.program_rows_expected);
  const programExecuted = asNumber(proof.program_rows_executed);
  const manifestExpected = asNumber(proof.manifest_suites_required);
  const manifestExecuted = asNumber(proof.manifest_suites_executed);
  const aggregateExpected = asNumber(proof.expected ?? (programExpected + manifestExpected));
  const aggregateExecuted = asNumber(proof.executed ?? (programExecuted + manifestExecuted));

  if (!hasNumeric(metrics.program_proof_execution_rate)) {
    metrics.program_proof_execution_rate = rateFromCounts(programExecuted, programExpected);
  }
  if (!hasNumeric(metrics.manifest_proof_execution_rate)) {
    metrics.manifest_proof_execution_rate = rateFromCounts(manifestExecuted, manifestExpected);
  }
  if (!hasNumeric(metrics.real_executed_proof_ratio)) {
    metrics.real_executed_proof_ratio = rateFromCounts(aggregateExecuted, aggregateExpected);
  }
  if (!hasNumeric(metrics.close_telemetry_unknown_rate)) {
    metrics.close_telemetry_unknown_rate = rateFromCounts(
      asNumber(plans.unknown_unrecorded_close_evidence),
      asNumber(plans.closed)
    );
  }
  proof.program_proof_execution_rate = metrics.program_proof_execution_rate;
  proof.manifest_proof_execution_rate = metrics.manifest_proof_execution_rate;
  proof.aggregate_proof_execution_rate = metrics.real_executed_proof_ratio;
  return {
    ...copy,
    metrics,
    detail: {
      ...detail,
      proof,
      plans,
    },
  };
}

function normalizeRitualReplay(input = {}) {
  const report = input.json || input;
  const current = report.current || {};
  const corpus = report.corpus || {};
  const retired = report.retired_gates || {};
  const status = report.status || "UNKNOWN";
  return {
    ok: verificationStatusIsPass(status, "execution"),
    status,
    fixture_count: asNumber(corpus.fixture_count ?? report.fixture_count),
    transition_count: asNumber(corpus.transition_count ?? report.transition_count),
    current_ritual_transition_count: asNumber(current.ritual_transition_count),
    current_ritual_transition_rate_pct: asNumber(current.ritual_transition_rate_pct),
    current_ritual_share_of_active_blocked_pct: asNumber(current.ritual_share_of_active_blocked_pct),
    current_unknown_transition_count: asNumber(current.unknown_transition_count),
    current_unknown_transition_rate_pct: asNumber(current.unknown_transition_rate_pct),
    retired_gate_active_bounce_count: asNumber(retired.current_active_bounce_count ?? current.retired_gate_active_bounce_count),
    historical_retired_gate_hits_by_code: retired.historical_hits_by_code || {},
    budgets: report.budgets || {},
    regressions: Array.isArray(report.regressions) ? report.regressions : [],
    semantics: report.semantics || null,
  };
}

function normalizeSeeded(input = {}) {
  const summary = input.summary || {};
  const status = input.status || "UNKNOWN";
  return {
    ok: verificationStatusIsPass(status, "execution"),
    status,
    defect_count: asNumber(input.defect_count ?? summary.planted),
    class_count: asNumber(input.class_count),
    planted: asNumber(summary.planted ?? input.defect_count),
    caught: asNumber(summary.caught),
    survived: asNumber(summary.survived ?? input.survived_count),
    catch_rate: asNumber(summary.catch_rate),
  };
}

function normalizeReuseDiscipline(input = {}) {
  const duplicate = input.duplicate_creation || {};
  const novel = input.novel_creation || {};
  const existingCapabilityInvocations = asNumber(
    input.existing_capability_invocations ??
      input.existingCapabilityInvocations ??
      input.recipe_or_existing_capability_invocations ??
      duplicate.caught
  );
  const netNewScriptCreations = asNumber(
    input.net_new_script_creations ??
      input.netNewScriptCreations ??
      input.new_script_creations ??
      novel.allowed
  );
  const denominator = existingCapabilityInvocations + netNewScriptCreations;
  const duplicateCreationCatchRate = asNullableNumber(input.duplicate_creation_catch_rate ?? duplicate.catch_rate) ??
    (asNumber(duplicate.planted) > 0 ? asNumber(duplicate.caught) / asNumber(duplicate.planted) : 0);
  const falseCreateBlockRate = asNullableNumber(input.false_create_block_rate ?? novel.false_block_rate) ??
    (asNumber(novel.planted) > 0 ? asNumber(novel.blocked) / asNumber(novel.planted) : 0);
  const reuseRate = asNullableNumber(input.reuse_rate ?? input.reuseRate) ??
    (denominator > 0 ? existingCapabilityInvocations / denominator : 0);
  const status = input.status || "UNKNOWN";
  return {
    ok: verificationStatusIsPass(status, "execution"),
    status,
    source: input.source || null,
    source_status: input.source_status || (Object.keys(input).length > 0 ? "collected" : "not_collected"),
    duplicate_creation: {
      planted: asNumber(duplicate.planted),
      caught: asNumber(duplicate.caught),
      survived: asNumber(duplicate.survived),
      catch_rate: round(duplicateCreationCatchRate),
      block_count: asNumber(duplicate.block_count),
      status: duplicate.status || null,
      issue_codes: duplicate.issue_codes || [],
    },
    novel_creation: {
      planted: asNumber(novel.planted),
      blocked: asNumber(novel.blocked),
      allowed: asNumber(novel.allowed),
      false_block_rate: round(falseCreateBlockRate),
      status: novel.status || null,
      issue_codes: novel.issue_codes || [],
    },
    existing_capability_invocations: existingCapabilityInvocations,
    net_new_script_creations: netNewScriptCreations,
    reuse_rate: round(reuseRate),
    duplicate_creation_catch_rate: round(duplicateCreationCatchRate),
    false_create_block_rate: round(falseCreateBlockRate),
  };
}

function normalizeFalseRed(input = {}) {
  return {
    ok: input.ok === true,
    fixture_count: asNumber(input.fixture_count),
    gate_count: asNumber(input.gate_count),
    missing_count: Array.isArray(input.missing) ? input.missing.length : asNumber(input.missing_count),
    stale_count: Array.isArray(input.stale) ? input.stale.length : asNumber(input.stale_count),
    extra_count: Array.isArray(input.extra) ? input.extra.length : asNumber(input.extra_count),
    missing: input.missing || [],
    stale: input.stale || [],
    extra: input.extra || [],
    gates: input.gates || [],
  };
}

function normalizeAbBenchmark(input = {}) {
  const report = input.report || input;
  const summary = report.summary || {};
  return {
    ok: input.ok !== false,
    task_count: asNumber(report.task_count ?? summary.task_count),
    deltas: {
      success_count_delta: asNumber(summary.deltas?.success_count_delta),
      success_rate_delta: asNumber(summary.deltas?.success_rate_delta),
      output_tokens_delta: asNumber(summary.deltas?.output_tokens_delta),
      wall_clock_ms_delta: asNumber(summary.deltas?.wall_clock_ms_delta),
      defects_caught_later_delta: asNumber(summary.deltas?.defects_caught_later_delta),
    },
  };
}

function normalizeIdeationQuality(input = {}) {
  const supplied = !!input && typeof input === "object" && Object.keys(input).length > 0;
  const report = input.report || input;
  const aggregate = report.aggregate || {};
  const status = input.status || report.status || "NOT_COLLECTED";
  return {
    ok: supplied && verificationStatusIsPass(status, "execution"),
    status,
    benchmark_id: report.benchmark_id || null,
    fixture_count: asNumber(report.fixture_count ?? aggregate.fixture_count),
    actor_output_count: asNumber(report.actor_output_count ?? aggregate.actor_output_count),
    actor_family_count: asNumber(report.actor_family_count ?? aggregate.actor_family_count),
    actor_families: Array.isArray(report.actor_families) ? report.actor_families : [],
    runtime_ms: asNumber(report.runtime_ms),
    idea_coverage_pct: asNumber(aggregate.idea_coverage_pct),
    useful_novelty_score: asNumber(aggregate.useful_novelty_score),
    ontology_suggestion_hit_rate: asNumber(aggregate.ontology_suggestion_hit_rate),
    persona_lift_rate: asNumber(aggregate.persona_lift_rate),
    cross_actor_divergence_pct: asNumber(aggregate.cross_actor_divergence_pct),
    cross_persona_divergence_pct: asNumber(aggregate.cross_persona_divergence_pct),
    false_green_rate_pct: asNumber(aggregate.false_green_rate_pct),
    false_red_review_rate_pct: asNumber(aggregate.false_red_review_rate_pct),
    barren_fixture_blocked_count: asNumber(aggregate.barren_fixture_blocked_count),
    budgets: report.budgets || {},
    regressions: Array.isArray(report.regressions) ? report.regressions : [],
    source_policy: report.source_policy || null,
    decision_boundary: report.decision_boundary || null,
  };
}

function normalizePackGuardBenchmark(input = {}) {
  const supplied = !!input && typeof input === "object" && Object.keys(input).length > 0;
  const report = input.report || input;
  const aggregate = report.aggregate || {};
  const status = input.status || report.status || "NOT_COLLECTED";
  return {
    ok: supplied && verificationStatusIsPass(status, "execution"),
    status,
    benchmark_id: report.benchmark_id || null,
    fixture_count: asNumber(report.fixture_count ?? aggregate.fixture_count),
    scenario_class_count: asNumber(aggregate.scenario_class_count),
    scenario_classes: Array.isArray(report.scenario_classes) ? report.scenario_classes : [],
    expected_guard_count: asNumber(aggregate.expected_guard_count),
    applied_guard_count: asNumber(aggregate.applied_guard_count),
    ignored_high_confidence_pack_count: asNumber(aggregate.ignored_high_confidence_pack_count),
    false_block_count: asNumber(aggregate.false_block_count),
    receipt_required_count: asNumber(aggregate.receipt_required_count),
    receipt_visible_count: asNumber(aggregate.receipt_visible_count),
    receipt_visibility_rate: asNumber(aggregate.receipt_visibility_rate),
    runtime_ms: asNumber(report.runtime_ms ?? aggregate.runtime_ms),
    budgets: report.budgets || {},
    regressions: Array.isArray(report.regressions) ? report.regressions : [],
    source_policy: report.source_policy || null,
    decision_boundary: report.decision_boundary || null,
  };
}

function markdownSection(text, heading) {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
  const match = String(text || "").match(pattern);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = String(text || "").slice(start);
  const next = rest.search(/^##\s+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

function countMatches(text, pattern) {
  return [...String(text || "").matchAll(pattern)].length;
}

function countChecklistItems(text, checkedOnly = false) {
  const pattern = checkedOnly
    ? /^[ \t]*[-*]\s+\[[xX]\]\s+\S/gm
    : /^[ \t]*[-*]\s+\[[ xX]\]\s+\S/gm;
  return countMatches(text, pattern);
}

function countPlannedSteps(planText) {
  const steps = markdownSection(planText, "Steps");
  if (!steps) return 0;
  const numbered = countMatches(steps, /^[ \t]*\d+\.\s+\S/gm);
  if (numbered > 0) return numbered;
  const checkboxes = countChecklistItems(steps, false);
  if (checkboxes > 0) return checkboxes;
  return countMatches(steps, /^[ \t]*[-*]\s+\S/gm);
}

function countCompletedSteps(progressText) {
  const completed = markdownSection(progressText, "Completed") || progressText;
  return countChecklistItems(completed, true);
}

function extractFilesToModifyCount(planText) {
  const section = markdownSection(planText, "Files To Modify");
  if (!section) return 0;
  const paths = new Set();
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^[-*]\s+/.test(trimmed)) continue;
    if (/to be determined|child-plan artifacts only/i.test(trimmed)) continue;
    const backtick = trimmed.match(/`([^`]+)`/);
    const candidate = (backtick ? backtick[1] : trimmed.replace(/^[-*]\s+/, "")).trim();
    if (!candidate || candidate.startsWith("*")) continue;
    if (candidate.includes("/") || candidate.includes(".")) paths.add(candidate);
  }
  return paths.size;
}

function extractChangeManifestCount(stateJson, stateText) {
  if (Array.isArray(stateJson?.change_manifest) && stateJson.change_manifest.length > 0) {
    return stateJson.change_manifest.length;
  }
  const section = markdownSection(stateText, "Change Manifest") || markdownSection(stateText, "Change Manifest (current iteration)");
  if (!section) return 0;
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) && !/no changes yet/i.test(line))
    .length;
}

function extractVerificationCounts(verificationText, state) {
  let pass = 0;
  let fail = 0;
  for (const line of String(verificationText || "").split(/\r?\n/)) {
    const candidates = line.includes("|")
      ? line.split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""))
      : [line.match(/\b(?:status|result|outcome|verdict)\s*[:=]\s*`?([a-z_ /-]+)`?/i)?.[1]];
    for (const candidate of candidates.filter(Boolean)) {
      const normalized = normalizeVerificationStatus(candidate, "execution");
      if (normalized.kind === "pass") pass += 1;
      else if (normalized.kind === "fail") fail += 1;
    }
  }
  return { pass_count: pass, fail_count: fail };
}

function extractPlannedIterations(planText) {
  const match = String(planText || "").match(/\bplanned iterations?\s*[:=-]\s*(\d+)\b/i) ||
    String(planText || "").match(/\biteration budget\s*[:=-]\s*(\d+)\b/i);
  return match ? asNumber(match[1], null) : null;
}

function classifyPivotDirection(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw.trim()) return null;
  if (/\b(add|expand|increase|broaden|include)\b/.test(raw)) return "expand";
  if (/\b(remove|delete|reduce|tighten|narrow|simplify)\b/.test(raw)) return "tighten";
  if (/\b(replace|reroute|redirect|switch|rework|refactor)\b/.test(raw)) return "redirect";
  if (/\b(defer|pause|hold)\b/.test(raw)) return "defer";
  const firstWords = raw.match(/[a-z0-9]+/g)?.slice(0, 2).join("_");
  return firstWords || null;
}

function extractPivotDirection(decisionsText) {
  for (const line of String(decisionsText || "").split(/\r?\n/)) {
    if (/pivot direction/i.test(line)) return classifyPivotDirection(line);
    if (/^##\s+D-\d+.*\bpivot\b/i.test(line)) return classifyPivotDirection(line);
  }
  return null;
}

function signalFromPlanDir(planDir) {
  const stateJson = safeReadJson(join(planDir, "state.json")) || {};
  const planMetrics = safeReadJson(join(planDir, "metrics.json")) || {};
  const stateText = safeReadText(join(planDir, "state.md"));
  const planText = safeReadText(join(planDir, "plan.md"));
  const progressText = safeReadText(join(planDir, "progress.md"));
  const verificationText = safeReadText(join(planDir, "verification.md"));
  const decisionsText = safeReadText(join(planDir, "decisions.md"));
  const { pass_count: passCount, fail_count: failCount } = extractVerificationCounts(verificationText, stateJson.state);
  const verificationTotal = passCount + failCount;
  const plannedScope = extractFilesToModifyCount(planText);
  const actualScope = extractChangeManifestCount(stateJson, stateText);
  const plannedSteps = countPlannedSteps(planText);
  const actualSteps = countCompletedSteps(progressText);
  const actualIterations = Number.isFinite(Number(stateJson.iteration)) ? Number(stateJson.iteration) : null;
  const createdAt = stateJson.created_at ||
    (Array.isArray(stateJson.transitions) ? stateJson.transitions[0]?.timestamp : null) ||
    null;
  return {
    plan_id: basename(planDir),
    plan_dir: rel(planDir),
    created_at: createdAt,
    state: stateJson.state || "UNKNOWN",
    pass_count: passCount,
    fail_count: failCount,
    pass_rate: verificationTotal > 0 ? round(passCount / verificationTotal) : (/^CLOSE$/i.test(stateJson.state || "") ? 1 : 0),
    new_issues: failCount,
    planned_scope_files: plannedScope,
    actual_scope_files: actualScope,
    planned_steps: plannedSteps,
    actual_steps: actualSteps,
    planned_iterations: extractPlannedIterations(planText),
    actual_iterations: actualIterations,
    pivot_direction: extractPivotDirection(decisionsText),
    transition_friction: {
      hard_blocks: asNumber(planMetrics.transition_friction?.hard_blocks ?? planMetrics.gate_failures?.length),
      advisory_conversions: asNumber(planMetrics.transition_friction?.advisory_conversions),
      repeat_same_code_blocks: asNumber(planMetrics.transition_friction?.repeat_same_code_blocks),
      tool_errors: asNumber(planMetrics.transition_friction?.tool_errors ?? planMetrics.tool_errors?.length),
    },
  };
}

function collectHistoricalPlanSignals({
  plansDir = join(REPO_ROOT, "plans"),
  limit = CONVERGENCE_SCAN_LIMIT,
  minimum = CONVERGENCE_MIN_PLAN_COUNT,
} = {}) {
  if (!existsSync(plansDir)) return [];
  const dirs = readdirSync(plansDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^plan_/.test(entry.name))
    .map((entry) => join(plansDir, entry.name));
  const signals = dirs
    .map(signalFromPlanDir)
    .filter((row) => row.pass_count + row.fail_count > 0 || row.planned_scope_files > 0 || row.actual_scope_files > 0)
    .sort((a, b) => String(a.created_at || a.plan_id).localeCompare(String(b.created_at || b.plan_id)));
  const closed = signals.filter((row) => /^CLOSE$/i.test(row.state || ""));
  const pool = closed.length >= minimum ? closed : signals;
  return pool.slice(-Math.max(minimum, limit));
}

function samplePlanSignals() {
  return [
    { plan_id: "sample-plan-001", plan_dir: "plans/sample-plan-001", state: "CLOSE", created_at: "2026-01-01T00:00:00.000Z", pass_count: 6, fail_count: 4, pass_rate: 0.6, new_issues: 4, planned_scope_files: 4, actual_scope_files: 7, planned_steps: 4, actual_steps: 7, planned_iterations: 1, actual_iterations: 2, pivot_direction: "tighten" },
    { plan_id: "sample-plan-002", plan_dir: "plans/sample-plan-002", state: "CLOSE", created_at: "2026-01-02T00:00:00.000Z", pass_count: 7, fail_count: 3, pass_rate: 0.7, new_issues: 3, planned_scope_files: 5, actual_scope_files: 7, planned_steps: 4, actual_steps: 6, planned_iterations: 1, actual_iterations: 2, pivot_direction: "tighten" },
    { plan_id: "sample-plan-003", plan_dir: "plans/sample-plan-003", state: "CLOSE", created_at: "2026-01-03T00:00:00.000Z", pass_count: 8, fail_count: 2, pass_rate: 0.8, new_issues: 2, planned_scope_files: 6, actual_scope_files: 7, planned_steps: 5, actual_steps: 7, planned_iterations: 1, actual_iterations: 2, pivot_direction: "expand" },
    { plan_id: "sample-plan-004", plan_dir: "plans/sample-plan-004", state: "CLOSE", created_at: "2026-01-04T00:00:00.000Z", pass_count: 9, fail_count: 1, pass_rate: 0.9, new_issues: 1, planned_scope_files: 6, actual_scope_files: 6, planned_steps: 5, actual_steps: 6, planned_iterations: 1, actual_iterations: 1, pivot_direction: "tighten" },
    { plan_id: "sample-plan-005", plan_dir: "plans/sample-plan-005", state: "CLOSE", created_at: "2026-01-05T00:00:00.000Z", pass_count: 11, fail_count: 1, pass_rate: 0.9167, new_issues: 1, planned_scope_files: 7, actual_scope_files: 7, planned_steps: 6, actual_steps: 8, planned_iterations: 1, actual_iterations: 2, pivot_direction: "expand" },
    { plan_id: "sample-plan-006", plan_dir: "plans/sample-plan-006", state: "CLOSE", created_at: "2026-01-06T00:00:00.000Z", pass_count: 12, fail_count: 0, pass_rate: 1, new_issues: 0, planned_scope_files: 8, actual_scope_files: 8, planned_steps: 6, actual_steps: 9, planned_iterations: 1, actual_iterations: 2, pivot_direction: "tighten" },
  ];
}

function scopeStability(signal) {
  const planned = asNumber(signal.planned_scope_files);
  const actual = asNumber(signal.actual_scope_files);
  if (planned <= 0) return actual <= 0 ? 1 : 0;
  return round(1 - clamp(Math.abs(actual - planned) / planned, 0, 1));
}

function issueTrend(prior, current) {
  if (!prior) return 0;
  const diff = asNumber(prior.new_issues) - asNumber(current.new_issues);
  return diff > 0 ? 1 : diff < 0 ? -1 : 0;
}

function convergenceSignal(score) {
  if (score > 1) return "positive_close_signal";
  if (score < -1) return "decomposition_analysis";
  return "neutral";
}

function buildMomentum(signals) {
  const directions = signals.map((row) => row.pivot_direction).filter(Boolean);
  if (directions.length < 3) {
    return {
      total_pivots: directions.length,
      classified_pivots: directions.length,
      same_direction_pivots: 0,
      ratio: null,
      threshold: 0.3,
      status: "insufficient_pivots",
      directions,
    };
  }
  let same = 0;
  for (let index = 1; index < directions.length; index += 1) {
    if (directions[index] === directions[index - 1]) same += 1;
  }
  const ratio = round(same / directions.length);
  return {
    total_pivots: directions.length,
    classified_pivots: directions.length,
    same_direction_pivots: same,
    ratio,
    threshold: 0.3,
    status: ratio < 0.3 ? "oscillating" : "directional",
    directions,
  };
}

function ratioOrNull(actual, planned) {
  const p = asNumber(planned);
  const a = asNumber(actual);
  if (p <= 0 || a <= 0) return null;
  return round(a / p);
}

function buildPredictionAccuracy(signals) {
  const rows = signals.map((row) => {
    const stepsRatio = ratioOrNull(row.actual_steps, row.planned_steps);
    const scopeRatio = ratioOrNull(row.actual_scope_files, row.planned_scope_files);
    const iterationDelta = row.planned_iterations !== null && row.actual_iterations !== null
      ? asNumber(row.actual_iterations) - asNumber(row.planned_iterations)
      : null;
    const comparable = stepsRatio !== null || scopeRatio !== null || iterationDelta !== null;
    const underpredicted = (stepsRatio !== null && stepsRatio > 1.25) ||
      (scopeRatio !== null && scopeRatio > 1.25) ||
      (iterationDelta !== null && iterationDelta > 0);
    return {
      plan_id: row.plan_id,
      comparable,
      underpredicted,
      planned: {
        steps: row.planned_steps,
        scope_files: row.planned_scope_files,
        iterations: row.planned_iterations,
      },
      actual: {
        steps: row.actual_steps,
        scope_files: row.actual_scope_files,
        iterations: row.actual_iterations,
      },
      ratios: {
        steps: stepsRatio,
        scope_files: scopeRatio,
        iteration_delta: iterationDelta,
      },
    };
  });
  const comparableRows = rows.filter((row) => row.comparable);
  const underpredictedRows = comparableRows.filter((row) => row.underpredicted);
  const average = (values) => {
    const nums = values.filter((value) => value !== null && Number.isFinite(Number(value))).map(Number);
    return nums.length > 0 ? round(nums.reduce((sum, value) => sum + value, 0) / nums.length) : null;
  };
  const underpredictionRate = comparableRows.length > 0 ? round(underpredictedRows.length / comparableRows.length) : 0;
  return {
    comparable_plan_count: comparableRows.length,
    underpredicted_plan_count: underpredictedRows.length,
    underprediction_rate: underpredictionRate,
    systematic_underprediction: comparableRows.length >= 3 && underpredictionRate > 0.6,
    averages: {
      steps_ratio: average(rows.map((row) => row.ratios.steps)),
      scope_ratio: average(rows.map((row) => row.ratios.scope_files)),
      iteration_delta: average(rows.map((row) => row.ratios.iteration_delta)),
    },
    rows,
  };
}

function buildConvergenceMetricsFromSignals(signals, { source = "plans_corpus", generatedAt = new Date().toISOString() } = {}) {
  const normalizedSignals = Array.isArray(signals) ? signals : [];
  const rows = normalizedSignals.map((current, index) => {
    const prior = index > 0 ? normalizedSignals[index - 1] : null;
    const passRateDelta = prior ? clamp(round(asNumber(current.pass_rate) - asNumber(prior.pass_rate)), -1, 1) : 0;
    const stability = scopeStability(current);
    const trend = issueTrend(prior, current);
    const score = round(passRateDelta + stability + trend);
    return {
      plan_id: current.plan_id,
      plan_dir: current.plan_dir,
      state: current.state,
      prior: prior ? {
        plan_id: prior.plan_id,
        pass_rate: prior.pass_rate,
        new_issues: prior.new_issues,
        planned_scope_files: prior.planned_scope_files,
        actual_scope_files: prior.actual_scope_files,
      } : null,
      current: {
        pass_rate: current.pass_rate,
        pass_count: current.pass_count,
        fail_count: current.fail_count,
        new_issues: current.new_issues,
        planned_scope_files: current.planned_scope_files,
        actual_scope_files: current.actual_scope_files,
        planned_steps: current.planned_steps,
        actual_steps: current.actual_steps,
        planned_iterations: current.planned_iterations,
        actual_iterations: current.actual_iterations,
      },
      components: {
        pass_rate_delta: passRateDelta,
        scope_stability: stability,
        issue_trend: trend,
        score,
      },
      signal: prior ? convergenceSignal(score) : "baseline_row",
      reproducibility: {
        formula: "pass_rate_delta + scope_stability + issue_trend",
        source_fields: [
          "verification pass/fail counts",
          "planned vs actual file counts",
          "new issue counts",
          "plan/progress iteration counts",
        ],
      },
    };
  });
  const scoredRows = rows.filter((row) => row.prior);
  const latest = scoredRows[scoredRows.length - 1] || rows[rows.length - 1] || null;
  const recent = scoredRows.slice(-2);
  const sustainedPositive = recent.length >= 2 && recent.every((row) => row.components.score > 1);
  const sustainedNegative = recent.length >= 2 && recent.every((row) => row.components.score < -1);
  const transitionFrictionPlans = normalizedSignals.map((row) => ({
    plan_id: row.plan_id,
    hard_blocks: asNumber(row.transition_friction?.hard_blocks),
    advisory_conversions: asNumber(row.transition_friction?.advisory_conversions),
    repeat_same_code_blocks: asNumber(row.transition_friction?.repeat_same_code_blocks),
    tool_errors: asNumber(row.transition_friction?.tool_errors),
  }));
  return {
    ok: normalizedSignals.length >= CONVERGENCE_MIN_PLAN_COUNT,
    status: normalizedSignals.length >= CONVERGENCE_MIN_PLAN_COUNT ? "PASS" : "INSUFFICIENT_HISTORY",
    source,
    generated_at: generatedAt,
    plan_count: normalizedSignals.length,
    minimum_plan_count: CONVERGENCE_MIN_PLAN_COUNT,
    sampled_plan_ids: normalizedSignals.map((row) => row.plan_id),
    latest: latest ? {
      plan_id: latest.plan_id,
      score: latest.components.score,
      signal: latest.signal,
      sustained_status: sustainedPositive ? "supports_close" : sustainedNegative ? "decomposition_analysis" : "not_sustained",
    } : null,
    thresholds: {
      close_score: 1,
      decomposition_score: -1,
      sustained_runs: 2,
      oscillation_ratio: 0.3,
    },
    rows,
    momentum: buildMomentum(normalizedSignals),
    prediction_accuracy: buildPredictionAccuracy(normalizedSignals),
    transition_friction: {
      plans: transitionFrictionPlans,
      totals: {
        hard_blocks: transitionFrictionPlans.reduce((sum, row) => sum + row.hard_blocks, 0),
        advisory_conversions: transitionFrictionPlans.reduce((sum, row) => sum + row.advisory_conversions, 0),
        repeat_same_code_blocks: transitionFrictionPlans.reduce((sum, row) => sum + row.repeat_same_code_blocks, 0),
        tool_errors: transitionFrictionPlans.reduce((sum, row) => sum + row.tool_errors, 0),
      },
    },
  };
}

function normalizeConvergence(input = {}) {
  if (input?.rows && input?.momentum && input?.prediction_accuracy) return input;
  if (Array.isArray(input?.signals)) {
    return buildConvergenceMetricsFromSignals(input.signals, {
      source: input.source || "provided_signals",
      generatedAt: input.generated_at || input.generatedAt,
    });
  }
  return {
    ok: false,
    status: "NOT_COLLECTED",
    source: "none",
    generated_at: null,
    plan_count: 0,
    minimum_plan_count: CONVERGENCE_MIN_PLAN_COUNT,
    sampled_plan_ids: [],
    latest: null,
    thresholds: {
      close_score: 1,
      decomposition_score: -1,
      sustained_runs: 2,
      oscillation_ratio: 0.3,
    },
    rows: [],
    momentum: {
      total_pivots: 0,
      classified_pivots: 0,
      same_direction_pivots: 0,
      ratio: null,
      threshold: 0.3,
      status: "insufficient_pivots",
      directions: [],
    },
    prediction_accuracy: {
      comparable_plan_count: 0,
      underpredicted_plan_count: 0,
      underprediction_rate: 0,
      systematic_underprediction: false,
      averages: {
        steps_ratio: null,
        scope_ratio: null,
        iteration_delta: null,
      },
      rows: [],
    },
  };
}

function normalizeEscalationProtocol(input = null) {
  const supplied = !!input && typeof input === "object" && Object.keys(input).length > 0;
  const events = Array.isArray(input?.events)
    ? input.events
    : Array.isArray(input?.telemetry_events)
      ? input.telemetry_events
      : [];
  const sourceStatus = input?.source_status || (supplied ? "collected" : "not_collected");
  const taskCount = asNullableNumber(input?.task_count ?? input?.taskCount) ?? (events.length > 0 ? events.length : 0);
  const escalationCount = asNullableNumber(input?.escalation_count ?? input?.escalationCount) ??
    events.filter((event) => event?.action === "escalate").length;
  const budgetBreachCount = asNullableNumber(input?.budget_breach_count ?? input?.budgetBreachCount) ??
    events.filter((event) => event?.trigger_class === "budget_breach" || asNumber(event?.budget_breach_count) > 0).length;
  const bounceCount = asNullableNumber(input?.bounce_count ?? input?.bounceCount) ??
    events.reduce((sum, event) => sum + asNumber(event?.bounce_count), 0);
  const totalCost = asNullableNumber(input?.total_cost_usd ?? input?.totalCostUsd) ??
    events.reduce((sum, event) => {
      const cost = asNullableNumber(event?.cost_estimate_usd ?? event?.cost_ledger?.cost_estimate_usd) ?? 0;
      return sum + cost;
    }, 0);
  const escalationRate = asNullableNumber(input?.escalation_rate ?? input?.escalationRate) ??
    (taskCount > 0 ? escalationCount / taskCount : 0);
  const costPerEscalation = asNullableNumber(input?.cost_per_escalation_usd ?? input?.costPerEscalationUsd) ??
    (escalationCount > 0 ? totalCost / escalationCount : 0);
  const budgets = input?.budgets || input?.thresholds || {};
  return {
    ok: input?.ok !== false,
    source_status: sourceStatus,
    task_count: taskCount,
    event_count: asNullableNumber(input?.event_count ?? input?.eventCount) ?? events.length,
    escalation_count: escalationCount,
    budget_breach_count: budgetBreachCount,
    bounce_count: bounceCount,
    escalation_rate: round(escalationRate, 4),
    total_cost_usd: round(totalCost, 8),
    cost_per_escalation_usd: round(costPerEscalation, 8),
    by_trigger: input?.by_trigger || input?.byTrigger || {},
    budgets: {
      max_escalation_rate: asNullableNumber(budgets.max_escalation_rate ?? budgets.maxEscalationRate ?? input?.max_escalation_rate),
      max_cost_per_escalation_usd: asNullableNumber(budgets.max_cost_per_escalation_usd ?? budgets.maxCostPerEscalationUsd ?? input?.max_cost_per_escalation_usd),
    },
    events,
  };
}

function outputVolumeBudget({ baselineBehavior, currentBehavior }) {
  const baseline = baselineBehavior.output_volume_lines || {};
  const live = currentBehavior.output_volume_lines;
  const sourceStatus = live
    ? "live_behavior_report_counter"
    : "baseline_frozen_no_live_counter";
  const current = live || baseline;
  const keys = ["blocked_first", "blocked_repeat", "pre_dedupe_baseline"];
  return {
    source_status: sourceStatus,
    source: current.source || baseline.source || null,
    limit_source: baseline.source || null,
    rows: Object.fromEntries(keys.map((key) => [
      key,
      {
        current: asNumber(current[key]),
        baseline: asNumber(baseline[key]),
        delta: delta(current[key], baseline[key]),
        regression: !!live && asNumber(current[key]) > asNumber(baseline[key]),
      },
    ])),
  };
}

function escalationProtocolBudget(escalation) {
  const supplied = escalation.source_status !== "not_collected";
  const maxRate = escalation.budgets.max_escalation_rate;
  const maxCost = escalation.budgets.max_cost_per_escalation_usd;
  return {
    source_status: escalation.source_status,
    budget_breach_count: {
      current: escalation.budget_breach_count,
      limit: 0,
      regression: supplied && escalation.budget_breach_count > 0,
    },
    escalation_rate: {
      current: escalation.escalation_rate,
      limit: maxRate,
      regression: supplied && maxRate !== null && escalation.escalation_rate > maxRate,
    },
    cost_per_escalation_usd: {
      current: escalation.cost_per_escalation_usd,
      limit: maxCost,
      regression: supplied && maxCost !== null && escalation.cost_per_escalation_usd > maxCost,
    },
  };
}

function proofExecutionBudget(behavior) {
  const hasScoreboard = !!behavior.autocoder_scoreboard;
  const scoreboard = behavior.autocoder_scoreboard || {};
  const metrics = scoreboard.metrics || {};
  const proof = scoreboard.detail?.proof || {};
  const programExpected = asNumber(proof.program_rows_expected);
  const programRate = asNumber(metrics.program_proof_execution_rate);
  const manifestRate = asNumber(metrics.manifest_proof_execution_rate);
  const aggregateRate = asNumber(metrics.real_executed_proof_ratio);
  const minimumProgramRateForGreenContext = 0.5;
  return {
    source_status: hasScoreboard ? "autocoder_scoreboard" : "not_collected",
    program_proof_execution_rate: {
      current: programRate,
      minimum_for_green_context: minimumProgramRateForGreenContext,
      warning: programExpected > 0 && programRate < minimumProgramRateForGreenContext,
    },
    manifest_proof_execution_rate: {
      current: manifestRate,
    },
    aggregate_proof_execution_rate: {
      current: aggregateRate,
    },
    denominator_split: {
      program_rows_executed: asNumber(proof.program_rows_executed),
      program_rows_expected: programExpected,
      manifest_suites_executed: asNumber(proof.manifest_suites_executed),
      manifest_suites_required: asNumber(proof.manifest_suites_required),
      aggregate_executed: asNumber(proof.executed),
      aggregate_expected: asNumber(proof.expected),
    },
  };
}

function averageNumeric(values) {
  const scored = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (scored.length === 0) return 0;
  return round(scored.reduce((sum, value) => sum + value, 0) / scored.length);
}

function boundedUnit(value) {
  return round(clamp(value, 0, 1));
}

function buildScoreRow(id, score, detail) {
  return {
    id,
    score: boundedUnit(score),
    detail,
  };
}

function buildScoreboardScores({
  conformance,
  budgets,
  seeded,
  reuseDiscipline,
  ritualReplay,
  ideationQuality,
  packGuardBenchmark,
  regressions,
}) {
  const passRate = conformance.suite_count > 0
    ? asNumber(conformance.pass_count) / Math.max(1, asNumber(conformance.suite_count))
    : 0;
  const proof = budgets.proof_execution || {};
  const proofScore = averageNumeric([
    proof.program_proof_execution_rate?.current,
    proof.manifest_proof_execution_rate?.current,
    proof.aggregate_proof_execution_rate?.current,
  ]);
  const ivScore = boundedUnit(ideationQuality.useful_novelty_score);
  const ritualScore = boundedUnit(ritualReplay.ok ? 1 : 0);
  const falseGreenScore = boundedUnit(1 - (asNumber(ideationQuality.false_green_rate_pct) / 100));
  const falseCreateScore = boundedUnit(1 - asNumber(reuseDiscipline.false_create_block_rate));
  const packGuardCoverageScore = packGuardBenchmark.expected_guard_count > 0
    ? asNumber(packGuardBenchmark.applied_guard_count) / Math.max(1, asNumber(packGuardBenchmark.expected_guard_count))
    : 1;
  const packGuardScore = averageNumeric([
    packGuardCoverageScore,
    packGuardBenchmark.receipt_visibility_rate,
    packGuardBenchmark.ignored_high_confidence_pack_count === 0 ? 1 : 0,
    packGuardBenchmark.false_block_count === 0 ? 1 : 0,
  ]);
  const rows = [
    buildScoreRow("conformance_pass_rate", passRate, "IVE conformance pass_count / suite_count"),
    buildScoreRow("regression_free", regressions.length === 0 ? 1 : 0, "No scoreboard regressions"),
    buildScoreRow("proof_execution", proofScore, "Average of program, manifest, and aggregate proof execution rates"),
    buildScoreRow("seeded_defect_catch_rate", seeded.catch_rate, "Seeded defect catch rate"),
    buildScoreRow("duplicate_creation_catch_rate", reuseDiscipline.duplicate_creation_catch_rate, "Duplicate capability creation catch rate"),
    buildScoreRow("false_create_allow_rate", falseCreateScore, "Inverse of novel-script false-create-block rate"),
    buildScoreRow("ritual_replay_gate", ritualScore, "Current-code ritual replay gate"),
    buildScoreRow("iv_score", ivScore, "Insight Velocity useful novelty score"),
    buildScoreRow("ideation_false_green_inverse", falseGreenScore, "Inverse of Insight Velocity false-green rate"),
    buildScoreRow("pack_guard_score", packGuardScore, "Pack guard coverage, receipt visibility, ignored-pack, and false-block score"),
  ];
  return {
    quality_score: {
      current: averageNumeric(rows.map((row) => row.score)),
      scale: "0..1",
      status: regressions.length === 0 ? "PASS" : "FAIL",
      method: "Mean of bounded quality components: conformance, regressions, proof execution, seeded catch, reuse, ritual replay, IV, ideation false-green inverse, and pack guard score.",
      components: rows,
    },
    iv_score: {
      current: ivScore,
      scale: "0..1",
      status: ideationQuality.ok ? "PASS" : "FAIL",
      source: "metrics.ideation_quality.useful_novelty_score",
      companion_metrics: {
        idea_coverage_pct: ideationQuality.idea_coverage_pct,
        ontology_suggestion_hit_rate: ideationQuality.ontology_suggestion_hit_rate,
        persona_lift_rate: ideationQuality.persona_lift_rate,
        false_green_rate_pct: ideationQuality.false_green_rate_pct,
        barren_fixture_blocked_count: ideationQuality.barren_fixture_blocked_count,
      },
    },
    ritual_score: {
      current: ritualScore,
      scale: "0..1",
      status: ritualReplay.ok ? "PASS" : "FAIL",
      source: "metrics.ritual_replay.ok",
      companion_metrics: {
        current_ritual_transition_rate_pct: ritualReplay.current_ritual_transition_rate_pct,
        current_unknown_transition_rate_pct: ritualReplay.current_unknown_transition_rate_pct,
        retired_gate_active_bounce_count: ritualReplay.retired_gate_active_bounce_count,
      },
    },
    pack_guard_score: {
      current: boundedUnit(packGuardScore),
      scale: "0..1",
      status: packGuardBenchmark.ok ? "PASS" : "FAIL",
      source: "metrics.pack_guard_benchmark",
      companion_metrics: {
        applied_guard_count: packGuardBenchmark.applied_guard_count,
        expected_guard_count: packGuardBenchmark.expected_guard_count,
        ignored_high_confidence_pack_count: packGuardBenchmark.ignored_high_confidence_pack_count,
        false_block_count: packGuardBenchmark.false_block_count,
        receipt_visibility_rate: packGuardBenchmark.receipt_visibility_rate,
      },
    },
  };
}

function evaluateRegressions({
  baselineConformance,
  baselineBehavior,
  baselineReuseDiscipline = {},
  conformance,
  seeded,
  reuseDiscipline,
  falseRed,
  ritualReplay,
  ideationQuality,
  packGuardBenchmark,
  budgets,
}) {
  const regressions = [];
  if (!conformance.ok || conformance.failed_required_count > 0) {
    regressions.push(issue("conformance_command_failed", "IVE conformance command did not report PASS", {
      current_status: conformance.status,
      exit_code: conformance.exit_code,
      timed_out: conformance.timed_out,
    }));
  }
  if (conformance.failed_required_count > asNumber(baselineConformance.failed_required_count)) {
    regressions.push(issue("conformance_required_failures", "Required IVE conformance failures increased", {
      current: conformance.failed_required_count,
      baseline: asNumber(baselineConformance.failed_required_count),
    }));
  }
  if (conformance.warning_regression_count > asNumber(baselineConformance.warning_count)) {
    regressions.push(issue("conformance_warning_count", "IVE warning count increased above baseline", {
      current: conformance.warning_regression_count,
      baseline: asNumber(baselineConformance.warning_count),
      advisory_warning_count: conformance.advisory_warning_count,
    }));
  }
  if (conformance.not_implemented_count > asNumber(baselineConformance.not_implemented_count)) {
    regressions.push(issue("conformance_not_implemented", "IVE not-implemented suite count increased", {
      current: conformance.not_implemented_count,
      baseline: asNumber(baselineConformance.not_implemented_count),
    }));
  }
  if (hasNumeric(conformance.wall_clock_ms) && conformance.wall_clock_ms > DEFAULT_CONFORMANCE_BUDGET_MS) {
    regressions.push(issue("conformance_wall_clock_budget", "IVE conformance wall-clock exceeded the 7 minute budget", {
      current_ms: conformance.wall_clock_ms,
      limit_ms: DEFAULT_CONFORMANCE_BUDGET_MS,
    }));
  }
  if (!seeded.ok || seeded.catch_rate < 1 || seeded.survived > 0) {
    regressions.push(issue("seeded_defect_catch_rate_regression", "Seeded-defect catch rate dropped below 100%", {
      caught: seeded.caught,
      planted: seeded.planted,
      survived: seeded.survived,
      catch_rate: seeded.catch_rate,
    }));
  }
  if (!reuseDiscipline.ok || reuseDiscipline.duplicate_creation_catch_rate < 1 || reuseDiscipline.duplicate_creation.survived > 0) {
    regressions.push(issue("duplicate_capability_catch_rate_regression", "Duplicate-capability creation catch rate dropped below 100%", {
      caught: reuseDiscipline.duplicate_creation.caught,
      planted: reuseDiscipline.duplicate_creation.planted,
      survived: reuseDiscipline.duplicate_creation.survived,
      catch_rate: reuseDiscipline.duplicate_creation_catch_rate,
      issue_codes: reuseDiscipline.duplicate_creation.issue_codes,
    }));
  }
  const baselineFalseBlockRate = asNullableNumber(baselineReuseDiscipline.false_create_block_rate);
  const falseBlockLimit = baselineFalseBlockRate ?? 0;
  if (reuseDiscipline.false_create_block_rate > falseBlockLimit) {
    regressions.push(issue("false_create_block_rate_regression", "Novel script creation false-block rate increased", {
      current: reuseDiscipline.false_create_block_rate,
      baseline: falseBlockLimit,
      blocked: reuseDiscipline.novel_creation.blocked,
      planted: reuseDiscipline.novel_creation.planted,
      issue_codes: reuseDiscipline.novel_creation.issue_codes,
    }));
  }
  if (hasNumeric(baselineReuseDiscipline.reuse_rate) && reuseDiscipline.reuse_rate < asNumber(baselineReuseDiscipline.reuse_rate)) {
    regressions.push(issue("reuse_rate_regression", "Existing-capability reuse rate dropped below baseline", {
      current: reuseDiscipline.reuse_rate,
      baseline: asNumber(baselineReuseDiscipline.reuse_rate),
      existing_capability_invocations: reuseDiscipline.existing_capability_invocations,
      net_new_script_creations: reuseDiscipline.net_new_script_creations,
    }));
  }
  if (!falseRed.ok || falseRed.missing_count > 0 || falseRed.stale_count > 0 || falseRed.extra_count > 0) {
    regressions.push(issue("false_red_export_regression", "False-red replay exports are missing, stale, or extra", {
      missing_count: falseRed.missing_count,
      stale_count: falseRed.stale_count,
      extra_count: falseRed.extra_count,
    }));
  }
  if (!ritualReplay.ok) {
    regressions.push(issue("ritual_replay_gate_regression", "Real-work ritual replay gate did not report PASS", {
      current_ritual_transition_rate_pct: ritualReplay.current_ritual_transition_rate_pct,
      current_unknown_transition_rate_pct: ritualReplay.current_unknown_transition_rate_pct,
      retired_gate_active_bounce_count: ritualReplay.retired_gate_active_bounce_count,
      regressions: ritualReplay.regressions,
    }));
  }
  if (!ideationQuality.ok) {
    regressions.push(issue("ideation_quality_regression", "Insight velocity ideation-quality benchmark did not report PASS", {
      status: ideationQuality.status,
      fixture_count: ideationQuality.fixture_count,
      idea_coverage_pct: ideationQuality.idea_coverage_pct,
      useful_novelty_score: ideationQuality.useful_novelty_score,
      false_green_rate_pct: ideationQuality.false_green_rate_pct,
      barren_fixture_blocked_count: ideationQuality.barren_fixture_blocked_count,
      regressions: ideationQuality.regressions,
    }));
  }
  if (!packGuardBenchmark.ok) {
    regressions.push(issue("pack_guard_benchmark_regression", "Pack guard conformance benchmark did not report PASS", {
      status: packGuardBenchmark.status,
      fixture_count: packGuardBenchmark.fixture_count,
      scenario_class_count: packGuardBenchmark.scenario_class_count,
      applied_guard_count: packGuardBenchmark.applied_guard_count,
      expected_guard_count: packGuardBenchmark.expected_guard_count,
      ignored_high_confidence_pack_count: packGuardBenchmark.ignored_high_confidence_pack_count,
      false_block_count: packGuardBenchmark.false_block_count,
      receipt_visibility_rate: packGuardBenchmark.receipt_visibility_rate,
      regressions: packGuardBenchmark.regressions,
    }));
  }
  for (const [key, row] of Object.entries(budgets.output_volume_lines.rows)) {
    if (row.regression) {
      regressions.push(issue("output_volume_line_budget", `Output-volume line budget increased for ${key}`, {
        metric: key,
        current: row.current,
        baseline: row.baseline,
        delta: row.delta,
        baseline_source: baselineBehavior.output_volume_lines?.source || null,
      }));
    }
  }
  if (budgets.escalation_protocol.budget_breach_count.regression) {
    regressions.push(issue("escalation_budget_breach", "Escalation protocol reported a budget-breach stop", {
      current: budgets.escalation_protocol.budget_breach_count.current,
      limit: budgets.escalation_protocol.budget_breach_count.limit,
    }));
  }
  if (budgets.escalation_protocol.escalation_rate.regression) {
    regressions.push(issue("escalation_rate_budget", "Escalation rate exceeded supplied budget", {
      current: budgets.escalation_protocol.escalation_rate.current,
      limit: budgets.escalation_protocol.escalation_rate.limit,
    }));
  }
  if (budgets.escalation_protocol.cost_per_escalation_usd.regression) {
    regressions.push(issue("escalation_cost_budget", "Cost per escalation exceeded supplied budget", {
      current: budgets.escalation_protocol.cost_per_escalation_usd.current,
      limit: budgets.escalation_protocol.cost_per_escalation_usd.limit,
    }));
  }
  return regressions;
}

function conformanceDeltas(current, baseline) {
  return {
    suite_count: delta(current.suite_count, baseline.suite_count),
    pass_count: delta(current.pass_count, baseline.pass_count),
    failed_required_count: delta(current.failed_required_count, baseline.failed_required_count),
    warning_count: delta(current.warning_count, baseline.warning_count),
    advisory_warning_count: delta(current.advisory_warning_count, baseline.advisory_warning_count),
    warning_regression_count: delta(current.warning_regression_count, baseline.warning_count),
    skipped_count: delta(current.skipped_count, baseline.skipped_count),
    not_applicable_count: delta(current.not_applicable_count, baseline.not_applicable_count),
    not_implemented_count: delta(current.not_implemented_count, baseline.not_implemented_count),
    wall_clock_ms: hasNumeric(current.wall_clock_ms) ? delta(current.wall_clock_ms, baseline.wall_clock_ms) : null,
  };
}

function behaviorDeltas(current, baseline) {
  return {
    total_runs: delta(current.total_runs, baseline.total_runs),
    total_gate_bounces: delta(current.total_gate_bounces, baseline.total_gate_bounces),
    bounce_rate_per_run: round(current.bounce_rate_per_run - round(asNumber(baseline.total_gate_bounces) / Math.max(1, asNumber(baseline.total_runs)))),
    nature_pct_of_classified: {
      ceremony: delta(current.nature_pct_of_classified.ceremony, baseline.nature_pct_of_classified?.ceremony),
      substantive: delta(current.nature_pct_of_classified.substantive, baseline.nature_pct_of_classified?.substantive),
      hybrid: delta(current.nature_pct_of_classified.hybrid, baseline.nature_pct_of_classified?.hybrid),
      unknown: delta(current.nature_pct_of_classified.unknown, baseline.nature_pct_of_classified?.unknown),
    },
  };
}

function ritualReplayDeltas(current, baseline = {}) {
  return {
    fixture_count: delta(current.fixture_count, baseline.fixture_count),
    transition_count: delta(current.transition_count, baseline.transition_count),
    current_ritual_transition_rate_pct: round(
      current.current_ritual_transition_rate_pct - asNumber(baseline.current_ritual_transition_rate_pct)
    ),
    current_ritual_share_of_active_blocked_pct: round(
      current.current_ritual_share_of_active_blocked_pct - asNumber(baseline.current_ritual_share_of_active_blocked_pct)
    ),
    current_unknown_transition_rate_pct: round(
      current.current_unknown_transition_rate_pct - asNumber(baseline.current_unknown_transition_rate_pct)
    ),
    retired_gate_active_bounce_count: delta(
      current.retired_gate_active_bounce_count,
      baseline.retired_gate_active_bounce_count
    ),
  };
}

function ideationQualityDeltas(current, baseline = {}) {
  return {
    fixture_count: delta(current.fixture_count, baseline.fixture_count),
    actor_family_count: delta(current.actor_family_count, baseline.actor_family_count),
    idea_coverage_pct: round(current.idea_coverage_pct - asNumber(baseline.idea_coverage_pct)),
    useful_novelty_score: round(current.useful_novelty_score - asNumber(baseline.useful_novelty_score)),
    ontology_suggestion_hit_rate: round(
      current.ontology_suggestion_hit_rate - asNumber(baseline.ontology_suggestion_hit_rate)
    ),
    persona_lift_rate: round(current.persona_lift_rate - asNumber(baseline.persona_lift_rate)),
    cross_actor_divergence_pct: round(
      current.cross_actor_divergence_pct - asNumber(baseline.cross_actor_divergence_pct)
    ),
    false_green_rate_pct: round(current.false_green_rate_pct - asNumber(baseline.false_green_rate_pct)),
    barren_fixture_blocked_count: delta(
      current.barren_fixture_blocked_count,
      baseline.barren_fixture_blocked_count
    ),
  };
}

function packGuardBenchmarkDeltas(current, baseline = {}) {
  return {
    fixture_count: delta(current.fixture_count, baseline.fixture_count),
    scenario_class_count: delta(current.scenario_class_count, baseline.scenario_class_count),
    expected_guard_count: delta(current.expected_guard_count, baseline.expected_guard_count),
    applied_guard_count: delta(current.applied_guard_count, baseline.applied_guard_count),
    ignored_high_confidence_pack_count: delta(
      current.ignored_high_confidence_pack_count,
      baseline.ignored_high_confidence_pack_count
    ),
    false_block_count: delta(current.false_block_count, baseline.false_block_count),
    receipt_visibility_rate: round(current.receipt_visibility_rate - asNumber(baseline.receipt_visibility_rate)),
  };
}

function convergenceDeltas(current, baseline = {}) {
  return {
    plan_count: delta(current.plan_count, baseline.plan_count),
    latest_score: round(asNumber(current.latest?.score) - asNumber(baseline.latest?.score)),
    momentum_ratio: current.momentum?.ratio === null
      ? null
      : round(asNumber(current.momentum?.ratio) - asNumber(baseline.momentum?.ratio)),
    prediction_comparable_plan_count: delta(
      current.prediction_accuracy?.comparable_plan_count,
      baseline.prediction_accuracy?.comparable_plan_count
    ),
    underprediction_rate: round(
      asNumber(current.prediction_accuracy?.underprediction_rate) -
      asNumber(baseline.prediction_accuracy?.underprediction_rate)
    ),
  };
}

function reuseDisciplineDeltas(current, baseline = {}) {
  return {
    reuse_rate: round(current.reuse_rate - asNumber(baseline.reuse_rate)),
    duplicate_creation_catch_rate: round(current.duplicate_creation_catch_rate - asNumber(baseline.duplicate_creation_catch_rate)),
    false_create_block_rate: round(current.false_create_block_rate - asNumber(baseline.false_create_block_rate)),
    existing_capability_invocations: delta(current.existing_capability_invocations, baseline.existing_capability_invocations),
    net_new_script_creations: delta(current.net_new_script_creations, baseline.net_new_script_creations),
    duplicate_planted: delta(current.duplicate_creation.planted, baseline.duplicate_creation?.planted),
    duplicate_caught: delta(current.duplicate_creation.caught, baseline.duplicate_creation?.caught),
    duplicate_survived: delta(current.duplicate_creation.survived, baseline.duplicate_creation?.survived),
    novel_planted: delta(current.novel_creation.planted, baseline.novel_creation?.planted),
    novel_blocked: delta(current.novel_creation.blocked, baseline.novel_creation?.blocked),
  };
}

function escalationProtocolDeltas(current, baseline = {}) {
  return {
    task_count: delta(current.task_count, baseline.task_count),
    event_count: delta(current.event_count, baseline.event_count),
    escalation_count: delta(current.escalation_count, baseline.escalation_count),
    budget_breach_count: delta(current.budget_breach_count, baseline.budget_breach_count),
    bounce_count: delta(current.bounce_count, baseline.bounce_count),
    escalation_rate: round(current.escalation_rate - asNumber(baseline.escalation_rate)),
    total_cost_usd: round(current.total_cost_usd - asNumber(baseline.total_cost_usd), 8),
    cost_per_escalation_usd: round(current.cost_per_escalation_usd - asNumber(baseline.cost_per_escalation_usd), 8),
  };
}

export function buildScoreboardReport({
  baseline,
  inputs,
  runId,
  generatedAt = new Date().toISOString(),
  baselinePath = DEFAULT_BASELINE_PATH,
  artifactPath = null,
} = {}) {
  if (!baseline) throw new Error("baseline is required");
  if (!inputs) throw new Error("inputs are required");
  const baselineConformance = baseline.metrics?.ive_conformance || {};
  const baselineBehavior = baseline.metrics?.behavior_report || {};
  const baselineRitualReplay = baseline.metrics?.ritual_replay || {};
  const baselineIdeationQuality = baseline.metrics?.ideation_quality || {};
  const baselinePackGuardBenchmark = baseline.metrics?.pack_guard_benchmark || {};
  const baselineReuseDiscipline = baseline.metrics?.reuse_discipline || {};
  const conformance = normalizeConformance(inputs.conformance || {});
  const behavior = normalizeBehavior(inputs.behavior_report || {});
  const ritualReplay = normalizeRitualReplay(inputs.ritual_replay || {});
  const seeded = normalizeSeeded(inputs.seeded_defects || {});
  const reuseDiscipline = normalizeReuseDiscipline(inputs.reuse_discipline || inputs.seeded_defects?.reuse_discipline || {});
  const falseRed = normalizeFalseRed(inputs.false_red_exports || {});
  const abBenchmark = normalizeAbBenchmark(inputs.ab_task_benchmark || {});
  const ideationQuality = normalizeIdeationQuality(inputs.ideation_quality || {});
  const packGuardBenchmark = normalizePackGuardBenchmark(inputs.pack_guard_benchmark || {});
  const convergence = normalizeConvergence(inputs.convergence_metrics || {});
  const escalationProtocol = normalizeEscalationProtocol(inputs.escalation_protocol || null);
  const budgets = {
    conformance_wall_clock_ms: {
      current: conformance.wall_clock_ms,
      limit: DEFAULT_CONFORMANCE_BUDGET_MS,
      delta_vs_baseline: hasNumeric(conformance.wall_clock_ms)
        ? delta(conformance.wall_clock_ms, baselineConformance.wall_clock_ms)
        : null,
      regression: hasNumeric(conformance.wall_clock_ms) && conformance.wall_clock_ms > DEFAULT_CONFORMANCE_BUDGET_MS,
    },
    output_volume_lines: outputVolumeBudget({ baselineBehavior, currentBehavior: behavior }),
    escalation_protocol: escalationProtocolBudget(escalationProtocol),
    proof_execution: proofExecutionBudget(behavior),
  };
  const regressions = evaluateRegressions({
    baselineConformance,
    baselineBehavior,
    baselineReuseDiscipline,
    conformance,
    seeded,
    reuseDiscipline,
    falseRed,
    ritualReplay,
    ideationQuality,
    packGuardBenchmark,
    budgets,
  });
  const status = regressions.length === 0 ? "PASS" : "FAIL";
  const scores = buildScoreboardScores({
    conformance,
    budgets,
    seeded,
    reuseDiscipline,
    ritualReplay,
    ideationQuality,
    packGuardBenchmark,
    regressions,
  });
  const report = {
    schema_version: SCOREBOARD_SCHEMA_VERSION,
    scoreboard_id: SCOREBOARD_ID,
    run_id: runId,
    generated_at: generatedAt,
    ok: verificationStatusIsPass(status, "execution"),
    status,
    baseline: {
      baseline_id: baseline.baseline_id || null,
      frozen_at: baseline.frozen_at || null,
      source_commit: baseline.source_commit || null,
      path: baselinePath,
    },
    program: baseline.program || null,
    ticket: {
      id: "T-INTAKE-8BAC86BB",
      title: "E2-5 Scoreboard CLI + CI wiring (THE test switch)",
      story_ref: "US-PM-AUTO-084",
    },
    commands: inputs.commands || {},
    artifacts: {
      scoreboard_json: artifactPath ? rel(artifactPath) : null,
      conformance_manifest: inputs.artifacts?.conformance_manifest || null,
    },
    metrics: {
      ive_conformance: conformance,
      behavior_report: behavior,
      ritual_replay: ritualReplay,
      seeded_defects: seeded,
      reuse_discipline: reuseDiscipline,
      false_red_exports: falseRed,
      ab_task_benchmark: abBenchmark,
      ideation_quality: ideationQuality,
      pack_guard_benchmark: packGuardBenchmark,
      convergence,
      escalation_protocol: escalationProtocol,
    },
    scores,
    deltas: {
      ive_conformance: conformanceDeltas(conformance, baselineConformance),
      behavior_report: behaviorDeltas(behavior, baselineBehavior),
      ritual_replay: ritualReplayDeltas(ritualReplay, baselineRitualReplay),
      seeded_defects: {
        planted: seeded.planted,
        caught: seeded.caught,
        survived: seeded.survived,
        catch_rate: seeded.catch_rate,
      },
      reuse_discipline: reuseDisciplineDeltas(reuseDiscipline, baselineReuseDiscipline),
      false_red_exports: {
        fixture_count: falseRed.fixture_count,
        gate_count: falseRed.gate_count,
        missing_count: falseRed.missing_count,
        stale_count: falseRed.stale_count,
        extra_count: falseRed.extra_count,
      },
      ab_task_benchmark: abBenchmark.deltas,
      ideation_quality: ideationQualityDeltas(ideationQuality, baselineIdeationQuality),
      pack_guard_benchmark: packGuardBenchmarkDeltas(packGuardBenchmark, baselinePackGuardBenchmark),
      convergence: convergenceDeltas(convergence, baseline.metrics?.convergence || {}),
      escalation_protocol: escalationProtocolDeltas(escalationProtocol, baseline.metrics?.escalation_protocol || {}),
    },
    budgets,
    regressions,
    scoreboard_contract: {
      fail_closed_on: [
        "required conformance failures",
        "conformance wall-clock budget breach",
        "seeded-defect catch-rate regression",
        "duplicate-capability creation catch-rate regression",
        "novel script false-create block regression",
        "reuse-rate regression against an established baseline",
        "missing/stale false-red exports",
        "real-work ritual replay gate failure",
        "insight velocity ideation-quality benchmark failure",
        "pack guard conformance benchmark failure",
        "live output-line budget growth",
        "supplied escalation budget breach",
        "supplied escalation rate over budget",
        "supplied cost per escalation over budget",
      ],
      contextual_deltas: [
        "suite_count",
        "behavior_report.total_runs",
        "behavior_report.total_gate_bounces",
        "behavior_report.autocoder_scoreboard.program_proof_execution_rate",
        "behavior_report.autocoder_scoreboard.manifest_proof_execution_rate",
        "behavior_report.autocoder_scoreboard.real_executed_proof_ratio",
        "behavior_report.autocoder_scoreboard.close_telemetry_unknown_rate",
        "behavior_report.autocoder_scoreboard.program_packet_lifecycle_drift_rate",
        "ritual_replay.current_ritual_transition_rate_pct",
        "A/B sample cost and output deltas",
        "insight velocity coverage, useful novelty, ontology hit rate, and false-green rate",
        "pack guard applied, ignored, false-block, and receipt visibility rates",
        "convergence, momentum, and prediction-accuracy signals",
        "reuse rate, duplicate creation catch rate, and false create block rate",
        "escalation rate, bounce counts, and cost per escalation",
      ],
    },
    summary: {
      regression_count: regressions.length,
      suite_count_delta: delta(conformance.suite_count, baselineConformance.suite_count),
      pass_count_delta: delta(conformance.pass_count, baselineConformance.pass_count),
      conformance_wall_clock_ms: conformance.wall_clock_ms,
      total_gate_bounces_delta: delta(behavior.total_gate_bounces, baselineBehavior.total_gate_bounces),
      program_proof_execution_rate: behavior.autocoder_scoreboard?.metrics?.program_proof_execution_rate ?? 0,
      manifest_proof_execution_rate: behavior.autocoder_scoreboard?.metrics?.manifest_proof_execution_rate ?? 0,
      aggregate_proof_execution_rate: behavior.autocoder_scoreboard?.metrics?.real_executed_proof_ratio ?? 0,
      close_telemetry_unknown_rate: behavior.autocoder_scoreboard?.metrics?.close_telemetry_unknown_rate ?? 0,
      program_packet_lifecycle_drift_rate: behavior.autocoder_scoreboard?.metrics?.program_packet_lifecycle_drift_rate ?? 0,
      ritual_replay_current_rate_pct: ritualReplay.current_ritual_transition_rate_pct,
      ritual_replay_unknown_rate_pct: ritualReplay.current_unknown_transition_rate_pct,
      ritual_replay_retired_active_bounces: ritualReplay.retired_gate_active_bounce_count,
      insight_velocity_idea_coverage_pct: ideationQuality.idea_coverage_pct,
      insight_velocity_useful_novelty_score: ideationQuality.useful_novelty_score,
      insight_velocity_false_green_rate_pct: ideationQuality.false_green_rate_pct,
      insight_velocity_barren_fixture_blocked_count: ideationQuality.barren_fixture_blocked_count,
      pack_guard_applied_guard_count: packGuardBenchmark.applied_guard_count,
      pack_guard_expected_guard_count: packGuardBenchmark.expected_guard_count,
      pack_guard_ignored_high_confidence_pack_count: packGuardBenchmark.ignored_high_confidence_pack_count,
      pack_guard_false_block_count: packGuardBenchmark.false_block_count,
      pack_guard_receipt_visibility_rate: packGuardBenchmark.receipt_visibility_rate,
      seeded_catch_rate: seeded.catch_rate,
      reuse_rate: reuseDiscipline.reuse_rate,
      duplicate_creation_catch_rate: reuseDiscipline.duplicate_creation_catch_rate,
      false_create_block_rate: reuseDiscipline.false_create_block_rate,
      false_red_fixture_count: falseRed.fixture_count,
      output_volume_source_status: budgets.output_volume_lines.source_status,
      convergence_latest_score: convergence.latest?.score ?? null,
      convergence_plan_count: convergence.plan_count,
      escalation_source_status: escalationProtocol.source_status,
      escalation_rate: escalationProtocol.escalation_rate,
      escalation_budget_breach_count: escalationProtocol.budget_breach_count,
      quality_score: scores.quality_score.current,
      iv_score: scores.iv_score.current,
      ritual_score: scores.ritual_score.current,
      pack_guard_score: scores.pack_guard_score.current,
    },
  };
  report.findings = findingsFromScoreboardReport(report);
  return report;
}

export function buildSampleScoreboardInputs({
  baseline,
  generatedAt = SAMPLE_TIMESTAMP,
  injectSeededRegression = false,
} = {}) {
  const conformance = deepClone(baseline.metrics?.ive_conformance || {});
  conformance.run_id = "sample-conformance";
  conformance.ok = true;
  conformance.status = "PASS";
  const behavior = deepClone(baseline.metrics?.behavior_report || {});
  delete behavior.output_volume_lines;
  const ritualReplay = deepClone(baseline.metrics?.ritual_replay || {
    ok: true,
    status: "PASS",
    corpus: {
      fixture_count: 25,
      transition_count: 358,
    },
    current: {
      ritual_transition_count: 25,
      ritual_transition_rate_pct: 7,
      ritual_share_of_active_blocked_pct: 10.5,
      unknown_transition_count: 3,
      unknown_transition_rate_pct: 0.8,
      retired_gate_active_bounce_count: 0,
    },
    retired_gates: {
      current_active_bounce_count: 0,
      historical_hits_by_code: {
        "GATE-PLN-010": 14,
        "GATE-TMP-002": 22,
      },
    },
    budgets: {
      current_ritual_transition_rate_pct: {
        current: 7,
        maximum: 7,
        target: 7,
        pass: true,
        target_met: true,
      },
      current_unknown_transition_rate_pct: {
        current: 0.8,
        maximum: 1,
        pass: true,
      },
      retired_gate_active_bounce_count: {
        current: 0,
        maximum: 0,
        pass: true,
      },
    },
    regressions: [],
  });
  const planted = REQUIRED_DEFECT_CLASSES.length;
  const seeded = {
    ok: true,
    status: "PASS",
    defect_count: planted,
    class_count: planted,
    survived_count: 0,
    summary: {
      planted,
      caught: planted,
      survived: 0,
      catch_rate: 1,
    },
  };
  const reuseDiscipline = {
    source: "seeded_defect_harness",
    source_status: "seeded_benchmark",
    status: "PASS",
    duplicate_creation: {
      planted: 1,
      caught: 1,
      survived: 0,
      catch_rate: 1,
      block_count: 2,
      status: "FAIL",
      issue_codes: ["duplicate_capability_id", "duplicate_runner_command"],
    },
    novel_creation: {
      planted: 1,
      blocked: 0,
      allowed: 1,
      false_block_rate: 0,
      status: "PASS",
      issue_codes: [],
    },
    existing_capability_invocations: 1,
    net_new_script_creations: 1,
    reuse_rate: 0.5,
    duplicate_creation_catch_rate: 1,
    false_create_block_rate: 0,
  };
  seeded.reuse_discipline = reuseDiscipline;
  if (injectSeededRegression) {
    seeded.ok = false;
    seeded.status = "FAIL";
    seeded.survived_count = 1;
    seeded.summary = {
      planted,
      caught: planted - 1,
      survived: 1,
      catch_rate: round((planted - 1) / planted),
    };
    seeded.reuse_discipline = reuseDiscipline;
  }
  const abTask = buildAbTaskBenchmark({ sample: true, generatedAt });
  const ideationQuality = buildIdeationQualityBenchmark({ generatedAt });
  const packGuardBenchmark = buildPackGuardBenchmark({ generatedAt });
  const convergenceMetrics = buildConvergenceMetricsFromSignals(samplePlanSignals(), {
    source: "sample_historical_plans",
    generatedAt,
  });
  return {
    commands: {
      ive_conformance: "sample: baseline metrics",
      behavior_report: "sample: baseline metrics",
      ritual_replay: "sample: deterministic real-work ritual replay summary",
      seeded_defects: "sample: deterministic seeded summary",
      reuse_discipline: "sample: deterministic seeded reuse discipline benchmark",
      false_red_exports: "sample: deterministic false-red export summary",
      ab_task_benchmark: "sample: deterministic A/B task benchmark",
      ideation_quality: "sample: deterministic insight velocity benchmark",
      pack_guard_benchmark: "sample: deterministic pack guard benchmark",
      convergence_metrics: "sample: deterministic historical plan signals",
      escalation_protocol: "sample: deterministic escalation telemetry",
    },
    conformance,
    behavior_report: behavior,
    ritual_replay: ritualReplay,
    seeded_defects: seeded,
    reuse_discipline: reuseDiscipline,
    false_red_exports: {
      ok: true,
      fixture_count: 25,
      gate_count: 7,
      missing: [],
      stale: [],
      extra: [],
      gates: [
        "execute-to-reflect",
        "explore-to-plan",
        "notify-user",
        "plan-to-execute",
        "reflect-to-validate",
        "validate-to-close",
        "reflect-to-close",
      ],
    },
    ab_task_benchmark: {
      ok: true,
      status: "PASS",
      report: abTask,
    },
    ideation_quality: {
      ok: ideationQuality.ok,
      status: ideationQuality.status,
      report: ideationQuality,
    },
    pack_guard_benchmark: {
      ok: packGuardBenchmark.ok,
      status: packGuardBenchmark.status,
      report: packGuardBenchmark,
    },
    convergence_metrics: convergenceMetrics,
    escalation_protocol: {
      source_status: "collected",
      task_count: 20,
      event_count: 1,
      escalation_count: 1,
      budget_breach_count: 0,
      bounce_count: 2,
      escalation_rate: 0.05,
      total_cost_usd: 0.0005,
      cost_per_escalation_usd: 0.0005,
      by_trigger: {
        schema_bounce_loop: 1,
      },
      budgets: {
        max_escalation_rate: 0.25,
        max_cost_per_escalation_usd: 0.01,
      },
      events: [
        {
          event_type: "escalation_protocol",
          action: "escalate",
          trigger_class: "schema_bounce_loop",
          reason: "bounce_budget_exhausted",
          bounce_count: 2,
          cost_estimate_usd: 0.0005,
        },
      ],
    },
    artifacts: {},
  };
}

export function collectLiveScoreboardInputs({
  runId,
  generatedAt = new Date().toISOString(),
  conformanceTimeoutMs = DEFAULT_CONFORMANCE_TIMEOUT_MS,
} = {}) {
  const conformanceRunId = `${runId || "scoreboard"}-conformance`;
  const conformanceArgv = [
    NODE,
    join(TESTS_ROOT, "ive", "run.mjs"),
    "--json",
    "--run-id",
    conformanceRunId,
  ];
  const behaviorArgv = [NODE, join(SCRIPTS_DIR, "behavior_report.mjs"), "--json"];
  const ritualReplayArgv = [
    NODE,
    join(SCRIPTS_DIR, "ritual_replay.mjs"),
    "--json",
    "--max-current-ritual-transition-rate-pct",
    "7",
    "--target-current-ritual-transition-rate-pct",
    "7",
    "--max-current-unknown-transition-rate-pct",
    "1",
  ];
  const falseRedArgv = [NODE, join(SCRIPTS_DIR, "real_telemetry_false_reds.mjs"), "--check", "--json"];

  const conformanceResult = runScoreboardJsonCommand(conformanceArgv, { timeoutMs: conformanceTimeoutMs });
  const behaviorResult = runScoreboardJsonCommand(behaviorArgv, { timeoutMs: 120000 });
  const ritualReplayResult = runScoreboardJsonCommand(ritualReplayArgv, { timeoutMs: 120000 });
  const falseRedResult = runScoreboardJsonCommand(falseRedArgv, { timeoutMs: 120000 });
  const seeded = runSeededDefectHarness();
  const reuseDiscipline = seeded.reuse_discipline || {};
  const abTask = buildAbTaskBenchmark({ sample: true, generatedAt });
  const ideationQuality = buildIdeationQualityBenchmark({ generatedAt });
  const packGuardBenchmark = buildPackGuardBenchmark({ generatedAt });
  const convergenceMetrics = buildConvergenceMetricsFromSignals(collectHistoricalPlanSignals(), {
    source: "plans_corpus",
    generatedAt,
  });
  const escalationProtocol = collectDeliveryReceiptEscalationTelemetry({
    receiptsDir: DEFAULT_DELIVERY_RECEIPT_ARTIFACT_DIR,
    cwd: REPO_ROOT,
  });
  return {
    commands: {
      ive_conformance: commandString(conformanceArgv),
      behavior_report: commandString(behaviorArgv),
      ritual_replay: commandString(ritualReplayArgv),
      seeded_defects: "runSeededDefectHarness()",
      reuse_discipline: "runSeededDefectHarness().reuse_discipline",
      false_red_exports: commandString(falseRedArgv),
      ab_task_benchmark: "buildAbTaskBenchmark({ sample: true })",
      ideation_quality: "buildIdeationQualityBenchmark({})",
      pack_guard_benchmark: "buildPackGuardBenchmark({})",
      convergence_metrics: "collectHistoricalPlanSignals({ plansDir: plans/ })",
      escalation_protocol: `collectDeliveryReceiptEscalationTelemetry({ receiptsDir: ${DEFAULT_DELIVERY_RECEIPT_ARTIFACT_DIR} })`,
    },
    conformance: {
      ...conformanceResult,
      manifest_path: rel(join(REPO_ROOT, "reports", "ive", "test_runs", conformanceRunId, "manifest.json")),
    },
    behavior_report: behaviorResult.json ? { ...behaviorResult.json, ok: behaviorResult.ok } : behaviorResult,
    ritual_replay: ritualReplayResult.json ? { ...ritualReplayResult.json, ok: ritualReplayResult.ok && ritualReplayResult.json.ok === true } : ritualReplayResult,
    seeded_defects: seeded,
    reuse_discipline: reuseDiscipline,
    false_red_exports: falseRedResult.json ? { ...falseRedResult.json, ok: falseRedResult.ok && falseRedResult.json.ok === true } : falseRedResult,
    ab_task_benchmark: {
      ok: true,
      status: "PASS",
      report: abTask,
    },
    ideation_quality: {
      ok: ideationQuality.ok,
      status: ideationQuality.status,
      report: ideationQuality,
    },
    pack_guard_benchmark: {
      ok: packGuardBenchmark.ok,
      status: packGuardBenchmark.status,
      report: packGuardBenchmark,
    },
    convergence_metrics: convergenceMetrics,
    escalation_protocol: escalationProtocol,
    artifacts: {
      conformance_manifest: rel(join(REPO_ROOT, "reports", "ive", "test_runs", conformanceRunId, "manifest.json")),
    },
  };
}

export function parseScoreboardArgs(argv = []) {
  const parsed = {
    json: false,
    help: false,
    baselinePath: DEFAULT_BASELINE_PATH,
    runId: null,
    outDir: DEFAULT_SCOREBOARD_OUT_DIR,
    write: true,
    sample: false,
    injectSeededRegression: false,
    conformanceTimeoutMs: DEFAULT_CONFORMANCE_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const valueFor = (name) => {
      if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), index };
      if (argv[index + 1] === undefined) throw new Error(`${name} requires a value`);
      return { value: argv[index + 1], index: index + 1 };
    };
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--no-write") parsed.write = false;
    else if (arg === "--sample") parsed.sample = true;
    else if (arg === "--inject-seeded-regression") parsed.injectSeededRegression = true;
    else if (arg === "--baseline" || arg.startsWith("--baseline=")) {
      const next = valueFor("--baseline");
      parsed.baselinePath = next.value;
      index = next.index;
    } else if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const next = valueFor("--run-id");
      parsed.runId = next.value;
      index = next.index;
    } else if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const next = valueFor("--out-dir");
      parsed.outDir = next.value;
      index = next.index;
    } else if (arg === "--conformance-timeout-ms" || arg.startsWith("--conformance-timeout-ms=")) {
      const next = valueFor("--conformance-timeout-ms");
      parsed.conformanceTimeoutMs = asNumber(next.value, DEFAULT_CONFORMANCE_TIMEOUT_MS);
      index = next.index;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (parsed.conformanceTimeoutMs <= 0) throw new Error("--conformance-timeout-ms must be positive");
  return parsed;
}

function defaultRunId(sample) {
  if (sample) return "sample-scoreboard";
  return `scoreboard-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export function scoreboardArtifactPath({ outDir = DEFAULT_SCOREBOARD_OUT_DIR, runId, cwd = REPO_ROOT } = {}) {
  return resolve(cwd, outDir, runId, "scoreboard.json");
}

export function writeScoreboardReport(report, { outDir = DEFAULT_SCOREBOARD_OUT_DIR, runId, cwd = REPO_ROOT } = {}) {
  const path = scoreboardArtifactPath({ outDir, runId, cwd });
  const withArtifact = {
    ...report,
    artifacts: {
      ...report.artifacts,
      scoreboard_json: rel(path),
    },
  };
  withArtifact.findings = findingsFromScoreboardReport(withArtifact);
  writeJson(path, withArtifact);
  return { path, report: withArtifact };
}

export function renderScoreboardText(report) {
  const proofBudget = report.budgets.proof_execution || {};
  const conformanceWallClock = hasNumeric(report.metrics.ive_conformance.wall_clock_ms)
    ? `${report.metrics.ive_conformance.wall_clock_ms} ms (${report.budgets.conformance_wall_clock_ms.regression ? "over budget" : "within budget"})`
    : "unavailable (no child proof telemetry)";
  const lines = [
    "IVE Autocoder Scoreboard",
    `Status: ${report.status}`,
    `Run: ${report.run_id}`,
    `Baseline: ${report.baseline.baseline_id || "unknown"} (${report.baseline.path})`,
    `Conformance suites: ${report.metrics.ive_conformance.suite_count} (${report.deltas.ive_conformance.suite_count >= 0 ? "+" : ""}${report.deltas.ive_conformance.suite_count})`,
    `Conformance wall-clock: ${conformanceWallClock}`,
    `Quality score: ${report.scores?.quality_score?.current ?? "n/a"} (${report.scores?.quality_score?.status || "unknown"})`,
    `IV score: ${report.scores?.iv_score?.current ?? "n/a"} (${report.scores?.iv_score?.source || "unknown source"})`,
    `Ritual score: ${report.scores?.ritual_score?.current ?? "n/a"} (${report.scores?.ritual_score?.source || "unknown source"})`,
    `Gate bounces: ${report.metrics.behavior_report.total_gate_bounces} (${report.deltas.behavior_report.total_gate_bounces >= 0 ? "+" : ""}${report.deltas.behavior_report.total_gate_bounces})`,
    `Proof split: program ${proofBudget.program_proof_execution_rate?.current ?? "n/a"}, manifest ${proofBudget.manifest_proof_execution_rate?.current ?? "n/a"}, aggregate ${proofBudget.aggregate_proof_execution_rate?.current ?? "n/a"}${proofBudget.program_proof_execution_rate?.warning ? " (program denominator low)" : ""}`,
    `Ritual replay: ${report.metrics.ritual_replay.current_ritual_transition_rate_pct}% current ritual, ${report.metrics.ritual_replay.current_unknown_transition_rate_pct}% unknown, retired active bounces ${report.metrics.ritual_replay.retired_gate_active_bounce_count}`,
    `Insight velocity: ${report.metrics.ideation_quality.idea_coverage_pct}% coverage, novelty ${report.metrics.ideation_quality.useful_novelty_score}, ontology hit ${report.metrics.ideation_quality.ontology_suggestion_hit_rate}, false green ${report.metrics.ideation_quality.false_green_rate_pct}%, barren ${report.metrics.ideation_quality.barren_fixture_blocked_count}`,
    `Pack guards: applied ${report.metrics.pack_guard_benchmark.applied_guard_count}/${report.metrics.pack_guard_benchmark.expected_guard_count}, ignored ${report.metrics.pack_guard_benchmark.ignored_high_confidence_pack_count}, false blocks ${report.metrics.pack_guard_benchmark.false_block_count}, receipt visibility ${report.metrics.pack_guard_benchmark.receipt_visibility_rate}`,
    `Seeded catch rate: ${report.metrics.seeded_defects.catch_rate}`,
    `Reuse discipline: reuse rate ${report.metrics.reuse_discipline.reuse_rate}, duplicate catch ${report.metrics.reuse_discipline.duplicate_creation_catch_rate}, false create block ${report.metrics.reuse_discipline.false_create_block_rate}`,
    `False-red exports: ${report.metrics.false_red_exports.fixture_count} fixtures / ${report.metrics.false_red_exports.gate_count} gates`,
    `Convergence: ${report.metrics.convergence.plan_count} plans, latest ${report.metrics.convergence.latest?.score ?? "n/a"} (${report.metrics.convergence.latest?.sustained_status || report.metrics.convergence.status})`,
    `Transition friction: ${report.metrics.convergence.transition_friction?.totals?.hard_blocks ?? 0} hard, ${report.metrics.convergence.transition_friction?.totals?.tool_errors ?? 0} tool errors, ${report.metrics.convergence.transition_friction?.totals?.advisory_conversions ?? 0} advisory conversions, ${report.metrics.convergence.transition_friction?.totals?.repeat_same_code_blocks ?? 0} repeat-code blocks`,
    `Escalation telemetry: ${report.metrics.escalation_protocol.source_status}, rate ${report.metrics.escalation_protocol.escalation_rate}, cost/escalation ${report.metrics.escalation_protocol.cost_per_escalation_usd}`,
    `Output-volume source: ${report.budgets.output_volume_lines.source_status}`,
  ];
  if (report.artifacts.scoreboard_json) lines.push(`Artifact: ${report.artifacts.scoreboard_json}`);
  if (report.regressions.length > 0) {
    lines.push("Regressions:");
    for (const row of report.regressions) {
      lines.push(`- ${row.code}: ${row.detail}`);
    }
  }
  return lines.join("\n");
}

export function runScoreboard(argv = process.argv.slice(2), {
  cwd = REPO_ROOT,
  now = () => new Date().toISOString(),
} = {}) {
  const args = parseScoreboardArgs(argv);
  if (args.help) {
    return {
      help: true,
      status: "HELP",
      ok: true,
    };
  }
  const loaded = loadScoreboardBaseline(args.baselinePath, { cwd });
  const generatedAt = args.sample ? SAMPLE_TIMESTAMP : now();
  const runId = args.runId || defaultRunId(args.sample);
  const inputs = args.sample
    ? buildSampleScoreboardInputs({
        baseline: loaded.document,
        generatedAt,
        injectSeededRegression: args.injectSeededRegression,
      })
    : collectLiveScoreboardInputs({
        runId,
        generatedAt,
        conformanceTimeoutMs: args.conformanceTimeoutMs,
      });
  let report = buildScoreboardReport({
    baseline: loaded.document,
    inputs,
    runId,
    generatedAt,
    baselinePath: args.baselinePath,
    artifactPath: args.write ? scoreboardArtifactPath({ outDir: args.outDir, runId, cwd }) : null,
  });
  let artifact = null;
  if (args.write) {
    const written = writeScoreboardReport(report, { outDir: args.outDir, runId, cwd });
    artifact = written.path;
    report = written.report;
  }
  return {
    ok: report.ok,
    status: report.status,
    report,
    artifact: artifact ? rel(artifact) : null,
  };
}
