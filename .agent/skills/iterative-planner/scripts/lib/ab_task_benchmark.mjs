// ab_task_benchmark.mjs - deterministic E2-6 planner-off/planner-wrapped replay benchmark.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  DEFAULT_REAL_EPISODE_CORPUS_PATH,
  loadRealEpisodeCorpus,
} from "./ive_real_episode_corpus.mjs";

export const AB_TASK_BENCHMARK_SCHEMA_VERSION = 1;
export const DEFAULT_AB_TASK_COUNT = 10;
export const DEFAULT_AB_TASK_SAMPLE_COUNT = 3;
export const AB_TASK_BENCHMARK_ID = "ive_autocoder_v2_ab_task_benchmark";
export const PLANNER_OFF_ARM_ID = "planner_off_baseline";
export const PLANNER_WRAPPED_ARM_ID = "planner_wrapped";
export const PLANNER_CHEAP_ARM_ID = "planner_cheap_dispatcher";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slug(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "task";
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgsValue(argv, index, arg, name) {
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), index };
  if (argv[index + 1] === undefined) throw new Error(`${name} requires a value`);
  return { value: argv[index + 1], index: index + 1 };
}

export function parseAbTaskBenchmarkArgs(argv = []) {
  const parsed = {
    json: false,
    write: false,
    help: false,
    sample: false,
    runId: null,
    taskCount: null,
    outDir: null,
    corpusPath: DEFAULT_REAL_EPISODE_CORPUS_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg === "--sample") {
      parsed.sample = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const value = parseArgsValue(argv, index, arg, "--run-id");
      parsed.runId = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--task-count" || arg.startsWith("--task-count=")) {
      const value = parseArgsValue(argv, index, arg, "--task-count");
      parsed.taskCount = parsePositiveInt(value.value, "--task-count");
      index = value.index;
      continue;
    }
    if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const value = parseArgsValue(argv, index, arg, "--out-dir");
      parsed.outDir = value.value;
      index = value.index;
      continue;
    }
    if (arg === "--corpus" || arg.startsWith("--corpus=")) {
      const value = parseArgsValue(argv, index, arg, "--corpus");
      parsed.corpusPath = value.value;
      index = value.index;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function taskIdForEpisode(episode, index) {
  return `task_${String(index + 1).padStart(3, "0")}_${slug(episode.id)}`;
}

function sourceRefLabel(ref) {
  return [
    asString(ref?.project),
    asString(ref?.source_path),
    asString(ref?.evidence_id),
  ].filter(Boolean).join(":");
}

function expectedOutcomeForEpisode(episode) {
  const route = episode.route || {};
  const quantGuard = episode.quant_guard || null;
  return {
    route_status: asString(route.status),
    valid_next_action: asString(route.valid_next_action),
    ticket_ref: asString(route.ticket_ref) || null,
    concept_guard: asString(route.concept_guard) || null,
    verification_required: asString(route.verification_required) || null,
    stop_condition: asString(route.stop_condition) || null,
    quant_guard_required: !!quantGuard,
    non_claims_required: asArray(episode.non_claims).length > 0,
    promotion_allowed: quantGuard?.promotion_allowed === false ? false : null,
  };
}

function routeIsSatisfied(expected) {
  return !["blocked", "unrouted"].includes(expected.route_status);
}

function wrappedDefectsCaught(episode, expected) {
  return [
    expected.valid_next_action,
    expected.concept_guard,
    expected.quant_guard_required ? "quant_guard" : "",
    expected.non_claims_required ? "non_claim_boundary" : "",
    asArray(episode.source_refs).length > 0 ? "source_provenance" : "",
  ].filter(Boolean).length;
}

function baselineSuccess(expected) {
  return expected.route_status === "accepted" && expected.valid_next_action === "accept_limitation";
}

function armForEpisode({ episode, expected, index, armId }) {
  const titleWords = asString(episode.title).split(/\s+/).filter(Boolean).length;
  const sourceRefCount = asArray(episode.source_refs).length;
  if (armId === PLANNER_OFF_ARM_ID) {
    const success = baselineSuccess(expected);
    return {
      arm_id: PLANNER_OFF_ARM_ID,
      executor: "deterministic_replay_proxy",
      task_success: success,
      output_tokens: 70 + titleWords * 3 + index,
      wall_clock_ms: 260 + index * 11,
      defects_caught_later: success ? 1 : 0,
      verdict: success ? "accepted_limitation_only" : "missed_route_or_guard",
      limitation: "Planner-off arm is a deterministic v1 proxy and does not call a live agent.",
    };
  }

  if (armId === PLANNER_CHEAP_ARM_ID) {
    const success = routeIsSatisfied(expected);
    const cheapCost = Number((0.0006 + sourceRefCount * 0.00008 + index * 0.00001).toFixed(8));
    const allFrontierCost = Number((0.006 + sourceRefCount * 0.0008 + index * 0.0001).toFixed(8));
    return {
      arm_id: PLANNER_CHEAP_ARM_ID,
      executor: "dispatcher_v1_replay_proxy",
      task_success: success,
      output_tokens: 140 + titleWords * 4 + sourceRefCount * 10 + index,
      wall_clock_ms: 520 + index * 17,
      defects_caught_later: success ? wrappedDefectsCaught(episode, expected) + 1 : 0,
      cost_estimate_usd: cheapCost,
      all_frontier_baseline_cost_estimate_usd: allFrontierCost,
      escalation_count: success && expected.valid_next_action === "ticket_now" ? 1 : 0,
      bounce_count: 0,
      receipt_ref: `reports/ive/dispatcher/replay-${slug(episode.id)}/delivery_receipt.json`,
      verdict: success ? "route_guard_satisfied_with_receipt" : "route_blocked",
      limitation: "Planner-cheap arm is a deterministic dispatcher replay proxy until E6-5 writes live dispatcher receipts.",
    };
  }

  const success = routeIsSatisfied(expected);
  return {
    arm_id: PLANNER_WRAPPED_ARM_ID,
    executor: "deterministic_replay_proxy",
    task_success: success,
    output_tokens: 112 + titleWords * 4 + sourceRefCount * 8 + index,
    wall_clock_ms: 380 + index * 13,
    defects_caught_later: success ? wrappedDefectsCaught(episode, expected) : 0,
    verdict: success ? "route_and_guard_satisfied" : "route_blocked",
    limitation: "Planner-wrapped arm uses fixture route/guard metadata as the replay oracle.",
  };
}

function taskForEpisode(episode, index) {
  const expected = expectedOutcomeForEpisode(episode);
  return {
    task_id: taskIdForEpisode(episode, index),
    source_episode_id: episode.id,
    title: episode.title,
    family: episode.family,
    project: episode.project,
    source_refs: asArray(episode.source_refs).map((ref) => ({
      project: ref.project,
      source_path: ref.source_path,
      source_sha256: ref.source_sha256,
      evidence_kind: ref.evidence_kind,
      evidence_id: ref.evidence_id,
      label: sourceRefLabel(ref),
    })),
    expected_outcome: expected,
    arms: [
      armForEpisode({ episode, expected, index, armId: PLANNER_OFF_ARM_ID }),
      armForEpisode({ episode, expected, index, armId: PLANNER_WRAPPED_ARM_ID }),
      armForEpisode({ episode, expected, index, armId: PLANNER_CHEAP_ARM_ID }),
    ],
  };
}

function summarizeArm(tasks, armId) {
  const arms = tasks.map((task) => task.arms.find((arm) => arm.arm_id === armId)).filter(Boolean);
  const successCount = arms.filter((arm) => arm.task_success).length;
  const totalOutputTokens = arms.reduce((sum, arm) => sum + arm.output_tokens, 0);
  const totalWallClockMs = arms.reduce((sum, arm) => sum + arm.wall_clock_ms, 0);
  const totalDefectsCaughtLater = arms.reduce((sum, arm) => sum + arm.defects_caught_later, 0);
  const totalCostEstimateUsd = arms.reduce((sum, arm) => sum + (Number.isFinite(arm.cost_estimate_usd) ? arm.cost_estimate_usd : 0), 0);
  const totalAllFrontierCostEstimateUsd = arms.reduce((sum, arm) => sum + (Number.isFinite(arm.all_frontier_baseline_cost_estimate_usd) ? arm.all_frontier_baseline_cost_estimate_usd : 0), 0);
  const totalEscalationCount = arms.reduce((sum, arm) => sum + (Number.isFinite(arm.escalation_count) ? arm.escalation_count : 0), 0);
  const totalBounceCount = arms.reduce((sum, arm) => sum + (Number.isFinite(arm.bounce_count) ? arm.bounce_count : 0), 0);
  const denominator = arms.length || 1;
  return {
    task_count: arms.length,
    success_count: successCount,
    success_rate: Number((successCount / denominator).toFixed(4)),
    total_output_tokens: totalOutputTokens,
    avg_output_tokens: Number((totalOutputTokens / denominator).toFixed(2)),
    total_wall_clock_ms: totalWallClockMs,
    avg_wall_clock_ms: Number((totalWallClockMs / denominator).toFixed(2)),
    defects_caught_later_total: totalDefectsCaughtLater,
    total_cost_estimate_usd: Number(totalCostEstimateUsd.toFixed(8)),
    total_all_frontier_baseline_cost_estimate_usd: Number(totalAllFrontierCostEstimateUsd.toFixed(8)),
    escalation_count_total: totalEscalationCount,
    bounce_count_total: totalBounceCount,
  };
}

function summarizeTasks(tasks) {
  const baseline = summarizeArm(tasks, PLANNER_OFF_ARM_ID);
  const wrapped = summarizeArm(tasks, PLANNER_WRAPPED_ARM_ID);
  const cheap = summarizeArm(tasks, PLANNER_CHEAP_ARM_ID);
  return {
    task_count: tasks.length,
    arms: {
      [PLANNER_OFF_ARM_ID]: baseline,
      [PLANNER_WRAPPED_ARM_ID]: wrapped,
      [PLANNER_CHEAP_ARM_ID]: cheap,
    },
    deltas: {
      success_count_delta: wrapped.success_count - baseline.success_count,
      success_rate_delta: Number((wrapped.success_rate - baseline.success_rate).toFixed(4)),
      output_tokens_delta: wrapped.total_output_tokens - baseline.total_output_tokens,
      wall_clock_ms_delta: wrapped.total_wall_clock_ms - baseline.total_wall_clock_ms,
      defects_caught_later_delta: wrapped.defects_caught_later_total - baseline.defects_caught_later_total,
    },
    planner_cheap_deltas: {
      success_count_delta: cheap.success_count - baseline.success_count,
      success_rate_delta: Number((cheap.success_rate - baseline.success_rate).toFixed(4)),
      output_tokens_delta: cheap.total_output_tokens - baseline.total_output_tokens,
      wall_clock_ms_delta: cheap.total_wall_clock_ms - baseline.total_wall_clock_ms,
      defects_caught_later_delta: cheap.defects_caught_later_total - baseline.defects_caught_later_total,
      cost_estimate_usd_delta: Number((cheap.total_all_frontier_baseline_cost_estimate_usd - cheap.total_cost_estimate_usd).toFixed(8)),
      escalation_count_delta: cheap.escalation_count_total,
      bounce_count_delta: cheap.bounce_count_total,
    },
  };
}

export function buildAbTaskBenchmark({
  taskCount = null,
  sample = false,
  corpusPath = DEFAULT_REAL_EPISODE_CORPUS_PATH,
  generatedAt = new Date().toISOString(),
} = {}) {
  const loaded = loadRealEpisodeCorpus(corpusPath);
  if (!loaded.validation.ok) {
    const first = loaded.validation.issues[0];
    throw new Error(`Real episode corpus invalid: ${first.code} at ${first.path}: ${first.message}`);
  }

  const selectedCount = taskCount || (sample ? DEFAULT_AB_TASK_SAMPLE_COUNT : DEFAULT_AB_TASK_COUNT);
  const episodes = asArray(loaded.corpus.episodes);
  if (selectedCount > episodes.length) {
    throw new Error(`Requested ${selectedCount} benchmark tasks but only ${episodes.length} are available`);
  }

  const tasks = episodes.slice(0, selectedCount).map(taskForEpisode);
  return {
    schema_version: AB_TASK_BENCHMARK_SCHEMA_VERSION,
    benchmark_id: AB_TASK_BENCHMARK_ID,
    generated_at: generatedAt,
    corpus_id: loaded.corpus.corpus_id,
    task_count: tasks.length,
    sample: !!sample,
    arms: [PLANNER_OFF_ARM_ID, PLANNER_WRAPPED_ARM_ID, PLANNER_CHEAP_ARM_ID],
    source_policy: {
      read_only_harvest: true,
      source_excerpt_included: false,
      provenance: "project_relative_path_plus_sha256",
    },
    decision_boundary: {
      claim_scope: "replay_proxy_only",
      live_llm_or_cost_claims_allowed: false,
      live_agent_execution: false,
      allowed_claims: [
        "Deterministic replay comparison over committed real-episode tasks.",
        "Proxy task success, output-token, wall-clock, and defect-catch fields by arm.",
      ],
      forbidden_claims: [
        "live LLM cost savings",
        "frontier-to-cheap-agent ROI",
        "model performance",
        "betting edge",
        "alpha",
        "CLV",
        "production autonomy quality",
      ],
      next_experiment: "E6 can replace deterministic arm executors with real role-provider telemetry.",
    },
    result_claims: [],
    scoreboard_sample_task_ids: tasks.slice(0, DEFAULT_AB_TASK_SAMPLE_COUNT).map((task) => task.task_id),
    tasks,
    summary: summarizeTasks(tasks),
  };
}

export function writeAbTaskBenchmarkReport(report, {
  cwd = process.cwd(),
  outDir = null,
  runId = null,
} = {}) {
  if (!report || typeof report !== "object") throw new Error("report is required");
  const safeRunId = slug(runId || `ab-task-benchmark-${new Date().toISOString()}`);
  const root = outDir ? resolve(cwd, outDir) : join(cwd, "reports", "ive", "ab_task_benchmark");
  const reportDir = join(root, safeRunId);
  mkdirSync(reportDir, { recursive: true });
  const benchmarkPath = join(reportDir, "benchmark.json");
  writeFileSync(benchmarkPath, JSON.stringify(report, null, 2) + "\n");
  const manifestPath = join(reportDir, "manifest.json");
  const manifest = {
    schema_version: 1,
    benchmark_id: report.benchmark_id,
    run_id: safeRunId,
    benchmark_path: benchmarkPath,
    task_count: report.task_count,
    status: "PASS",
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return {
    run_id: safeRunId,
    report_dir: reportDir,
    benchmark_path: benchmarkPath,
    manifest_path: manifestPath,
    benchmark_exists: existsSync(benchmarkPath),
    manifest_exists: existsSync(manifestPath),
  };
}
