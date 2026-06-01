#!/usr/bin/env node
// llm_drift_auditor.mjs — Fail-open cheap-LLM drift classification.

import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  callOpenAiCompatibleJson,
  extractJsonObject,
  isDriftPhaseEnabled,
  loadDriftLlmConfig,
  normalizeDriftStatus,
  normalizeLlmDriftPayload,
  publicDriftConfig,
  redactSecrets,
} from "./lib/llm_drift_client.mjs";
import { getPaths, resolvePlanTarget, readFile } from "./lib/plan_utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);

function parseArgs(argv) {
  const flags = {
    json: argv.includes("--json"),
    help: argv.includes("--help") || argv.includes("-h"),
    mode: "gate",
    gate: null,
    plan: null,
    dir: process.cwd(),
    mockResponse: null,
    mockResponseFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode" && argv[i + 1]) flags.mode = argv[++i];
    else if (argv[i] === "--gate" && argv[i + 1]) flags.gate = argv[++i];
    else if (argv[i] === "--plan" && argv[i + 1]) flags.plan = argv[++i];
    else if (argv[i] === "--dir" && argv[i + 1]) flags.dir = argv[++i];
    else if (argv[i] === "--mock-response" && argv[i + 1]) flags.mockResponse = argv[++i];
    else if (argv[i] === "--mock-response-file" && argv[i + 1]) flags.mockResponseFile = argv[++i];
  }
  flags.phase = flags.mode === "post_task" ? "post_task" : "gate";
  flags.dir = resolve(flags.dir);
  return flags;
}

function printHelp() {
  console.log(`llm_drift_auditor.mjs — fail-open LLM drift classifier

Usage:
  node llm_drift_auditor.mjs --mode gate --gate <gate> --plan <plan> --json
  node llm_drift_auditor.mjs --mode post_task --plan <plan> --json

Provider env:
  PLANNER_DRIFT_LLM_API_KEY
  PLANNER_DRIFT_LLM_MODEL
  PLANNER_DRIFT_LLM_BASE_URL
  PLANNER_DRIFT_LLM_TIMEOUT_MS=20000
  PLANNER_DRIFT_LLM_PHASES=gate,post_task
`);
}

function hashText(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

function truncate(value, max = 4000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function parseJsonMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return extractJsonObject(text);
    } catch {
      return null;
    }
  }
}

function runScript(cwd, scriptName, args, opts = {}) {
  const result = spawnSync(process.execPath, [join(scriptDir, scriptName), ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs || 12_000,
    env: {
      ...process.env,
      PLANNER_SKIP_SELF_HEAL: "1",
      ...(opts.env || {}),
    },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const parsed = opts.parseJson === false ? null : parseJsonMaybe(stdout);
  return {
    ok: result.status === 0 || opts.allowExitOne === true && result.status === 1,
    status: result.status,
    signal: result.signal || null,
    command: `node ${scriptName} ${args.join(" ")}`,
    stdout_hash: hashText(stdout),
    stderr_hash: hashText(stderr),
    stdout_excerpt: truncate(stdout, opts.excerptBytes || 3000),
    stderr_excerpt: truncate(stderr, opts.excerptBytes || 1000),
    parsed,
  };
}

function summarizeCommandResult(name, result) {
  const parsed = result.parsed;
  if (name === "planner_findings") {
    return {
      ok: result.ok,
      status: result.status,
      semantic_blocks: Array.isArray(parsed?.semantic_blocks) ? parsed.semantic_blocks.length : 0,
      invariant_violations: Array.isArray(parsed?.invariant_violations) ? parsed.invariant_violations.length : 0,
      invariant_warnings: Array.isArray(parsed?.invariant_warnings) ? parsed.invariant_warnings.length : 0,
      active_plan_state: parsed?.active_plan?.state || null,
      recommended_recovery: parsed?.recommended_recovery?.mode || null,
      anti_ritual: parsed?.anti_ritual?.status || null,
    };
  }
  if (name === "knowledge_resolver") {
    return {
      ok: result.ok,
      status: result.status,
      confidence: parsed?.confidence || null,
      recommended_entrypoint: parsed?.recommended_entrypoint?.value || null,
      related_stories: Array.isArray(parsed?.related_stories) ? parsed.related_stories.length : 0,
      active_obligations: Array.isArray(parsed?.active_obligations) ? parsed.active_obligations.length : 0,
    };
  }
  if (name === "project_health") {
    return {
      ok: result.ok,
      status: result.status,
      summary: parsed?.summary || null,
      analyzers_ran: parsed?.analyzers_ran || null,
    };
  }
  if (name === "annotation_parser") {
    return {
      ok: result.ok,
      status: result.status,
      summary: parsed?.summary || null,
    };
  }
  if (name === "ontology_serializer") {
    return {
      ok: result.ok,
      status: result.status,
      meta: parsed?.meta || null,
      facts_count: Array.isArray(parsed?.facts) ? parsed.facts.length : null,
      facts_hash: hashText(JSON.stringify(parsed?.facts || [])),
    };
  }
  if (name === "story_registry") {
    return {
      ok: result.ok,
      status: result.status,
      registry_status: parsed?.status || null,
      story_count: parsed?.storyCount || parsed?.story_count || null,
      errors: Array.isArray(parsed?.errors) ? parsed.errors.length : 0,
      warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.length : 0,
    };
  }
  return {
    ok: result.ok,
    status: result.status,
    stdout_hash: result.stdout_hash,
  };
}

function readPlanSummary(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: planArg });
  if (!target.planDir) return { present: false, plan_dir_name: null, plan_dir: null };
  const state = parseJsonMaybe(readFile(join(target.planDir, "state.json")) || "");
  const planContent = readFile(join(target.planDir, "plan.md")) || "";
  const findingsContent = readFile(join(target.planDir, "findings.md")) || "";
  return {
    present: true,
    plan_dir_name: target.planDirName,
    plan_dir: target.planDir,
    state: state?.state || null,
    goal: state?.goal || null,
    plan_hash: hashText(planContent),
    findings_hash: hashText(findingsContent),
    files_to_modify: extractPlanFiles(planContent),
  };
}

function extractPlanFiles(planContent) {
  const section = String(planContent || "").match(/##\s+Files\s+To\s+Modify\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (!section) return [];
  return section[1]
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+`?([^`\n]+?)`?\s*$/)?.[1]?.trim())
    .filter(Boolean);
}

function gitChangedFiles(cwd) {
  const result = spawnSync("git", ["status", "--short"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (result.status !== 0) return [];
  return (result.stdout || "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }))
    .slice(0, 200);
}

function scopedChangedFiles(cwd, planSummary) {
  if (Array.isArray(planSummary?.files_to_modify) && planSummary.files_to_modify.length > 0) {
    return {
      source: "plan_files",
      files: planSummary.files_to_modify.map((path) => ({ status: "planned", path })).slice(0, 200),
    };
  }
  return {
    source: "git_status_fallback",
    files: gitChangedFiles(cwd),
  };
}

export function collectDeterministicTruth({ cwd = process.cwd(), plan = null, gate = null } = {}) {
  const planSummary = readPlanSummary(cwd, plan);
  const changedFiles = scopedChangedFiles(cwd, planSummary);
  const commandArgs = {
    planner_findings: ["--dir", cwd, "--json"],
    knowledge_resolver: ["--dir", cwd, "--json"],
    project_health: ["--quick", "--json"],
    annotation_parser: ["--dir", cwd, "--json"],
    ontology_serializer: ["--dir", cwd, "--json"],
    story_registry: ["check", "--json"],
  };
  if (planSummary.plan_dir_name) {
    commandArgs.planner_findings.push("--plan", planSummary.plan_dir_name);
    commandArgs.knowledge_resolver.push("--plan", planSummary.plan_dir_name);
  }
  if (gate) commandArgs.planner_findings.push("--gate", gate);

  const commands = {
    planner_findings: runScript(cwd, "planner_findings.mjs", commandArgs.planner_findings, { allowExitOne: true }),
    knowledge_resolver: runScript(cwd, "knowledge_resolver.mjs", commandArgs.knowledge_resolver, { allowExitOne: true }),
    project_health: runScript(cwd, "project_health.mjs", commandArgs.project_health, { allowExitOne: true }),
    annotation_parser: runScript(cwd, "annotation_parser.mjs", commandArgs.annotation_parser, { allowExitOne: true }),
    ontology_serializer: runScript(cwd, "ontology_serializer.mjs", commandArgs.ontology_serializer, { allowExitOne: true }),
    story_registry: runScript(cwd, "story_registry.mjs", commandArgs.story_registry, { allowExitOne: true }),
  };

  const summary = Object.fromEntries(
    Object.entries(commands).map(([name, result]) => [name, summarizeCommandResult(name, result)])
  );

  return {
    collected_at: new Date().toISOString(),
    cwd,
    gate,
    plan: planSummary,
    changed_files_source: changedFiles.source,
    changed_files: changedFiles.files,
    summaries: summary,
    command_hashes: Object.fromEntries(Object.entries(commands).map(([name, result]) => [
      name,
      {
        command: result.command,
        status: result.status,
        stdout_hash: result.stdout_hash,
        stderr_hash: result.stderr_hash,
      },
    ])),
  };
}

function unavailableResult({ cwd, flags, config, reason, deterministicTruth = null }) {
  return {
    generated_at: new Date().toISOString(),
    cwd,
    mode: flags.mode,
    phase: flags.phase,
    gate: flags.gate || null,
    plan: flags.plan || null,
    status: "unavailable",
    fail_open: true,
    hard_blocking: false,
    provider: publicDriftConfig(config),
    deterministic_truth: deterministicTruth,
    findings: [],
    proposed_semantic_edits: [],
    recommended_follow_up: [],
    summary: reason,
    errors: [reason],
  };
}

export async function runDriftAudit(options = {}) {
  const cwd = resolve(options.dir || process.cwd());
  const env = { ...process.env, ...(options.env || {}) };
  if (options.mockResponse) env.PLANNER_DRIFT_LLM_MOCK_RESPONSE = options.mockResponse;
  if (options.mockResponseFile) {
    env.PLANNER_DRIFT_LLM_MOCK_RESPONSE = readFileSync(resolve(cwd, options.mockResponseFile), "utf-8");
  }
  const flags = {
    mode: options.mode || "gate",
    phase: options.mode === "post_task" ? "post_task" : "gate",
    gate: options.gate || null,
    plan: options.plan || null,
  };
  const config = loadDriftLlmConfig(env);

  if (!isDriftPhaseEnabled(config, flags.phase)) {
    return unavailableResult({ cwd, flags, config, reason: `LLM drift phase '${flags.phase}' disabled by PLANNER_DRIFT_LLM_PHASES` });
  }
  if (!config.configured && !config.mockResponse && !config.mockError) {
    return unavailableResult({ cwd, flags, config, reason: `Provider config missing: ${config.missing.join(", ")}` });
  }

  let deterministicTruth = null;
  try {
    deterministicTruth = collectDeterministicTruth({ cwd, plan: flags.plan, gate: flags.gate });
  } catch (error) {
    deterministicTruth = { error: error.message };
  }

  const schemaPrompt = [
    "You are a drift classifier for an iterative planner.",
    "Use only the deterministic truth snapshot. Do not invent gate results.",
    "Return exactly one compact valid JSON object and nothing else.",
    "Use this exact top-level shape: {\"status\":\"fresh\",\"summary\":\"...\",\"findings\":[],\"proposed_semantic_edits\":[],\"recommended_follow_up\":[]}.",
    "status must be one of fresh, stale_advisory, stale_blocking, unknown, unavailable.",
    "findings[] fields: id, classification, surface, file, line, claim, reason, confidence, runtime_truth_refs, recommended_action.",
    "Hard limits: at most 3 findings, at most 2 proposed_semantic_edits, at most 3 recommended_follow_up strings, summary <= 240 chars, every string <= 180 chars.",
    "Prefer findings: [] when deterministic truth does not directly prove stale docs, annotations, story refs, ontology-facing claims, or operator guidance.",
    "Use [] for empty arrays. Use null for unknown line. Do not include markdown, comments, trailing commas, or unescaped newlines inside strings.",
    "proposed_semantic_edits[] are review-only suggestions and must not be described as applied.",
    "stale_blocking means high-priority deterministic follow-up, not a gate veto.",
  ].join(" ");
  const userPrompt = JSON.stringify({
    task: "Classify stale docs, annotations, story refs, ontology-facing claims, and operator guidance.",
    mode: flags.mode,
    gate: flags.gate,
    deterministic_truth: deterministicTruth,
  }).slice(0, 28_000);

  try {
    const response = await callOpenAiCompatibleJson({
      config,
      env,
      messages: [
        { role: "system", content: schemaPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const normalized = normalizeLlmDriftPayload(response.parsed);
    return {
      generated_at: new Date().toISOString(),
      cwd,
      mode: flags.mode,
      phase: flags.phase,
      gate: flags.gate || null,
      plan: deterministicTruth?.plan?.plan_dir_name || flags.plan || null,
      status: normalizeDriftStatus(normalized.status),
      fail_open: true,
      hard_blocking: false,
      provider: publicDriftConfig(config),
      deterministic_truth: deterministicTruth,
      findings: normalized.findings,
      proposed_semantic_edits: normalized.proposed_semantic_edits,
      recommended_follow_up: normalized.recommended_follow_up,
      summary: normalized.summary || `${normalized.status} drift classification`,
      errors: [],
      source: response.source,
      raw_excerpt: response.raw_excerpt,
    };
  } catch (error) {
    return unavailableResult({
      cwd,
      flags,
      config,
      reason: redactSecrets(error?.message || "LLM drift audit unavailable", env),
      deterministicTruth,
    });
  }
}

function printHuman(result, env = process.env) {
  console.log("LLM Drift Audit");
  console.log(`  Status: ${result.status}`);
  console.log(`  Fail-open: ${result.fail_open ? "yes" : "no"}`);
  console.log(`  Hard blocking: ${result.hard_blocking ? "yes" : "no"}`);
  console.log(`  Summary: ${redactSecrets(result.summary || "(none)", env)}`);
  if (result.findings?.length) {
    for (const finding of result.findings.slice(0, 5)) {
      const detail = redactSecrets(finding.reason || finding.claim || "", env);
      const surface = redactSecrets(finding.surface || "unknown", env);
      const file = finding.file ? ` (${redactSecrets(finding.file, env)})` : "";
      console.log(`  - ${finding.classification}: ${surface}${file} — ${detail}`);
    }
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  runDriftAudit(flags).then((result) => {
    const output = redactSecrets(flags.json ? JSON.stringify(result, null, 2) : "");
    if (flags.json) {
      process.stdout.write(`${output}\n`);
    } else {
      printHuman(result, process.env);
    }
  }).catch((error) => {
    const result = {
      generated_at: new Date().toISOString(),
      cwd: flags.dir,
      mode: flags.mode,
      phase: flags.phase,
      gate: flags.gate || null,
      plan: flags.plan || null,
      status: "unavailable",
      fail_open: true,
      hard_blocking: false,
      errors: [redactSecrets(error?.message || "unexpected error")],
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printHuman(result);
  });
}
