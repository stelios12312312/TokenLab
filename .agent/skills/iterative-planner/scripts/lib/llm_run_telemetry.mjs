// @planner:module = llm_run_telemetry
// @planner:capability = canonical_llm_run_ledger
// llm_run_telemetry.mjs - Append-only planner-owned LLM run ledger.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, join, relative, resolve } from "path";
import { createHash, randomUUID } from "crypto";

import { isFeatureEnabled, loadConfig, nowISO, readStateJson } from "./determinism.mjs";
import { resolvePlanTarget } from "./plan_utils.mjs";
import { redactSecrets } from "./provider_client.mjs";

export const LLM_RUN_TELEMETRY_SCHEMA_VERSION = 1;
export const RAW_STORAGE_ACKNOWLEDGEMENT = "I_UNDERSTAND_RAW_LLM_TELEMETRY_STORAGE";

const DEFAULT_PROMPT_EXCERPT_CHARS = 500;
const DEFAULT_RESPONSE_EXCERPT_CHARS = 1000;
const MAX_EXCERPT_CHARS = 10_000;

function canonicalRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function safeRead(filePath) {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function safeReadJsonLines(filePath) {
  if (!existsSync(filePath)) return { records: [], invalid_count: 0 };
  const lines = safeRead(filePath).split("\n").filter((line) => line.trim());
  const records = [];
  let invalidCount = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidCount += 1;
    }
  }
  return { records, invalid_count: invalidCount };
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))].sort();
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || null;
}

function clampNonNegativeInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Math.floor(number), MAX_EXCERPT_CHARS);
}

function stableStringify(value) {
  const seen = new WeakSet();
  function stable(item) {
    if (item === null || item === undefined) return item ?? null;
    if (typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    if (Array.isArray(item)) return item.map(stable);
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])]));
  }
  return JSON.stringify(stable(value));
}

function digestValue(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function textFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map((message) => {
    const role = typeof message?.role === "string" ? message.role : "message";
    const content = typeof message?.content === "string" ? message.content : stableStringify(message?.content || "");
    return `${role}: ${content}`;
  }).join("\n");
}

function textForTelemetry({ text, messages, fallback = "" } = {}) {
  if (typeof text === "string") return text;
  const messageText = textFromMessages(messages);
  if (messageText) return messageText;
  return typeof fallback === "string" ? fallback : stableStringify(fallback);
}

function redactedExcerpt(value, maxChars, env) {
  const redacted = redactSecrets(String(value || ""), env);
  return maxChars > 0 ? redacted.slice(0, maxChars) : "";
}

function redactFull(value, env) {
  return redactSecrets(String(value || ""), env);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const out = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "token_source"]) {
    if (usage[key] !== undefined && usage[key] !== null) out[key] = usage[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function publicProvider(provider) {
  if (!provider || typeof provider !== "object") return null;
  const copy = { ...provider };
  delete copy.apiKey;
  delete copy.api_key;
  delete copy.authorization;
  delete copy.headers;
  return copy;
}

function normalizeCost(value) {
  if (!value || typeof value !== "object") return null;
  return JSON.parse(JSON.stringify(value));
}

function repoRelative(root, fullPath) {
  return relative(root, fullPath).replace(/\\/g, "/");
}

function countJsonlRecords(filePath) {
  if (!existsSync(filePath)) return { line_count: 0, latest_at: null };
  const lines = safeRead(filePath).split("\n").filter((line) => line.trim());
  let latestAt = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const candidate = parsed.timestamp || parsed.ts || parsed.generated_at || parsed.at || null;
      if (typeof candidate === "string" && (!latestAt || candidate > latestAt)) latestAt = candidate;
    } catch {
      // Best-effort only.
    }
  }
  if (!latestAt) {
    try {
      latestAt = new Date(statSync(filePath).mtimeMs).toISOString();
    } catch {
      latestAt = null;
    }
  }
  return { line_count: lines.length, latest_at: latestAt };
}

function listJsonFiles(dirPath) {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(dirPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function normalizeLlmRunTelemetryConfig(raw = {}) {
  return {
    enabled: raw.enabled === true,
    store_raw_prompt: raw.store_raw_prompt === true,
    store_raw_response: raw.store_raw_response === true,
    prompt_excerpt_chars: clampNonNegativeInt(raw.prompt_excerpt_chars, DEFAULT_PROMPT_EXCERPT_CHARS),
    response_excerpt_chars: clampNonNegativeInt(raw.response_excerpt_chars, DEFAULT_RESPONSE_EXCERPT_CHARS),
    redaction_enabled: raw.redaction_enabled !== false,
    require_raw_storage_acknowledgement: raw.require_raw_storage_acknowledgement !== false,
    raw_storage_acknowledgement: typeof raw.raw_storage_acknowledgement === "string" ? raw.raw_storage_acknowledgement.trim() : "",
  };
}

export function getLlmRunTelemetryConfig(overrides = null) {
  const configured = loadConfig().features?.llm_run_telemetry || {};
  return normalizeLlmRunTelemetryConfig({ ...configured, ...(overrides || {}) });
}

export function validateLlmRunTelemetryConfig(rawConfig = null) {
  const config = rawConfig ? normalizeLlmRunTelemetryConfig(rawConfig) : getLlmRunTelemetryConfig();
  const errors = [];
  const rawRequested = config.store_raw_prompt || config.store_raw_response;
  if (rawRequested && config.require_raw_storage_acknowledgement && config.raw_storage_acknowledgement !== RAW_STORAGE_ACKNOWLEDGEMENT) {
    errors.push({
      code: "raw_storage_acknowledgement_required",
      message: `Set raw_storage_acknowledgement to ${RAW_STORAGE_ACKNOWLEDGEMENT} before storing full redacted prompt/response text.`,
    });
  }
  return { ok: errors.length === 0, errors, config };
}

export function getLlmRunTelemetryPaths(planDir) {
  const telemetryDir = join(planDir, "telemetry");
  return {
    telemetryDir,
    runsPath: join(telemetryDir, "llm_runs.jsonl"),
    summaryPath: join(telemetryDir, "llm_runs_summary.json"),
  };
}

function resolveTelemetryPlan({ cwd, planDir, planDirName, planId, env }) {
  if (planDir) {
    const resolvedPlanDir = resolve(planDir);
    return {
      planDir: resolvedPlanDir,
      planDirName: planDirName || basename(resolvedPlanDir),
      source: "explicit",
    };
  }
  const target = resolvePlanTarget(join(cwd, "plans"), {
    plan: planId || null,
    env,
    exitOnMissing: false,
  });
  if (!target?.planDir || !target?.planDirName) return { planDir: null, planDirName: null, source: target?.source || null };
  return target;
}

export function readLlmRunTelemetryRecords(planDir) {
  const { runsPath } = getLlmRunTelemetryPaths(planDir);
  return safeReadJsonLines(runsPath);
}

export function recordLlmRunTelemetry({
  cwd = process.cwd(),
  planDir = null,
  planDirName = null,
  planId = null,
  phase = null,
  actor = null,
  role = null,
  source = "planner",
  eventType = "completion",
  provider = null,
  model = null,
  modelVersion = null,
  messages = [],
  promptText = null,
  responseText = null,
  responseObject = null,
  usage = null,
  costCall = null,
  costLedger = null,
  toolRefs = [],
  personaPacks = [],
  advisoryArtifacts = [],
  artifacts = [],
  captureStatus = null,
  metadata = {},
  runId = null,
  env = process.env,
  telemetryConfig = null,
} = {}) {
  const config = telemetryConfig ? normalizeLlmRunTelemetryConfig(telemetryConfig) : getLlmRunTelemetryConfig();
  if (!config.enabled || !isFeatureEnabled("llm_run_telemetry")) {
    return { written: false, reason: "disabled" };
  }

  const validation = validateLlmRunTelemetryConfig(config);
  if (!validation.ok) {
    return { written: false, reason: "invalid_privacy_config", errors: validation.errors };
  }

  const repoRoot = canonicalRoot(cwd);
  const target = resolveTelemetryPlan({ cwd: repoRoot, planDir, planDirName, planId, env });
  if (!target.planDir || !target.planDirName) {
    return { written: false, reason: "missing_plan" };
  }

  const state = readStateJson(target.planDir) || {};
  const promptCanonical = promptText !== null && promptText !== undefined ? promptText : messages;
  const responseCanonical = responseText !== null && responseText !== undefined ? responseText : (responseObject || {});
  const promptForExcerpt = textForTelemetry({ text: promptText, messages });
  const responseForExcerpt = responseText !== null && responseText !== undefined ? responseText : stableStringify(responseObject || {});
  const timestamp = nowISO();
  const actorObject = typeof actor === "object" && actor
    ? actor
    : { kind: role ? "role_provider" : "planner", id: String(actor || role || "planner"), role: role || null };

  const record = {
    schema_version: LLM_RUN_TELEMETRY_SCHEMA_VERSION,
    run_id: runId || `llm_${timestamp.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`,
    timestamp,
    plan_id: target.planDirName,
    phase: phase || state.state || "UNKNOWN",
    event_type: normalizeToken(eventType) || "completion",
    actor: actorObject,
    source: normalizeToken(source) || "planner",
    provider: publicProvider(provider),
    model: model || provider?.model || null,
    model_version: modelVersion || null,
    prompt_digest: digestValue(promptCanonical),
    response_digest: digestValue(responseCanonical),
    prompt_excerpt: redactedExcerpt(promptForExcerpt, config.prompt_excerpt_chars, env),
    response_excerpt: redactedExcerpt(responseForExcerpt, config.response_excerpt_chars, env),
    privacy: {
      redaction_enabled: config.redaction_enabled,
      prompt_digest_algorithm: "sha256",
      response_digest_algorithm: "sha256",
      prompt_excerpt_chars: config.prompt_excerpt_chars,
      response_excerpt_chars: config.response_excerpt_chars,
      store_raw_prompt: config.store_raw_prompt,
      store_raw_response: config.store_raw_response,
      raw_storage_acknowledged: config.raw_storage_acknowledgement === RAW_STORAGE_ACKNOWLEDGEMENT,
      raw_text_is_redacted: true,
    },
    usage: normalizeUsage(usage),
    cost_call: normalizeCost(costCall),
    cost_ledger: normalizeCost(costLedger),
    tool_refs: uniqueList(toolRefs),
    persona_packs: uniqueList(personaPacks),
    advisory_artifacts: uniqueList(advisoryArtifacts),
    artifacts: uniqueList(artifacts),
    capture_status: captureStatus || null,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };

  if (config.store_raw_prompt) record.prompt_text = redactFull(promptForExcerpt, env);
  if (config.store_raw_response) record.response_text = redactFull(responseForExcerpt, env);

  const { telemetryDir, runsPath } = getLlmRunTelemetryPaths(target.planDir);
  mkdirSync(telemetryDir, { recursive: true });
  appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
  return {
    written: true,
    path: runsPath,
    plan_id: target.planDirName,
    run_id: record.run_id,
    record,
  };
}

function collectPersonaPacks(planDir) {
  const packs = new Set();
  for (const name of ["persona_guidance.json", "persona_constraints.json", "persona_findings.json"]) {
    const parsed = safeReadJson(join(planDir, name));
    for (const packId of parsed?.summary?.pack_ids || []) packs.add(packId);
    for (const item of parsed?.items || []) if (item?.pack_id) packs.add(item.pack_id);
    for (const finding of parsed?.findings || []) {
      const role = finding?._roleAudit?.role || String(finding?.analyzer || "").match(/\[([^\]]+)\]/)?.[1];
      if (role) packs.add(role);
    }
  }
  return uniqueList([...packs]);
}

function collectAdvisoryArtifacts(cwd, planDir) {
  const reviewDir = join(planDir, "review_intake_sources");
  return listJsonFiles(reviewDir).map((filePath) => {
    const parsed = safeReadJson(filePath) || {};
    return {
      path: repoRelative(cwd, filePath),
      source: parsed.source || parsed.provider?.source || parsed.provider?.kind || null,
      status: parsed.status || parsed.advisory?.status || parsed.deepseek_advisory?.status || null,
      deterministic_truth: parsed.deterministic_truth || null,
    };
  });
}

function compactRun(record) {
  return {
    run_id: record.run_id || null,
    timestamp: record.timestamp || null,
    actor: record.actor || null,
    source: record.source || null,
    model: record.model || record.provider?.model || null,
    provider_kind: record.provider?.kind || null,
    prompt_digest: record.prompt_digest || null,
    response_digest: record.response_digest || null,
    usage: record.usage || null,
    cost_call: record.cost_call || null,
    tool_refs: record.tool_refs || [],
    persona_packs: record.persona_packs || [],
    advisory_artifacts: record.advisory_artifacts || [],
    privacy: record.privacy || null,
  };
}

function countBy(records, pick) {
  const counts = {};
  for (const record of records) {
    const value = pick(record);
    if (!value) continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function latestTimestamp(records) {
  return records
    .map((record) => record?.timestamp)
    .filter((value) => typeof value === "string" && value)
    .sort()
    .at(-1) || null;
}

export function summarizeLlmRunTelemetry({
  cwd = process.cwd(),
  planDir = null,
  planDirName = null,
  planId = null,
  persist = true,
  includeRuns = false,
  env = process.env,
  telemetryConfig = null,
} = {}) {
  const config = telemetryConfig ? normalizeLlmRunTelemetryConfig(telemetryConfig) : getLlmRunTelemetryConfig();
  const enabled = config.enabled && isFeatureEnabled("llm_run_telemetry");
  const repoRoot = canonicalRoot(cwd);
  const target = resolveTelemetryPlan({ cwd: repoRoot, planDir, planDirName, planId, env });
  if (!target.planDir || !target.planDirName) {
    return {
      generated_at: nowISO(),
      enabled,
      mode: "unavailable",
      plan_id: target.planDirName || null,
      repo_root: repoRoot,
      run_count: 0,
      capture_gaps: ["missing_plan"],
    };
  }
  if (!enabled) {
    return {
      generated_at: nowISO(),
      enabled: false,
      mode: "disabled",
      plan_id: target.planDirName,
      repo_root: repoRoot,
      run_count: 0,
      capture_gaps: ["llm_run_telemetry_disabled"],
    };
  }

  const { telemetryDir, runsPath, summaryPath } = getLlmRunTelemetryPaths(target.planDir);
  const { records, invalid_count: invalidCount } = readLlmRunTelemetryRecords(target.planDir);
  const toolTrace = countJsonlRecords(join(target.planDir, "artifacts", "tool_trace.jsonl"));
  const proofEvents = countJsonlRecords(join(target.planDir, "telemetry", "events.jsonl"));
  const proofSummary = safeReadJson(join(target.planDir, "telemetry", "summary.json"));
  const personaPacks = uniqueList([
    ...collectPersonaPacks(target.planDir),
    ...records.flatMap((record) => record.persona_packs || []),
  ]);
  const advisoryArtifacts = collectAdvisoryArtifacts(repoRoot, target.planDir);
  const captureGaps = [];
  if (records.length === 0) captureGaps.push("llm_run_ledger_absent");
  if (invalidCount > 0) captureGaps.push("llm_run_ledger_invalid_lines");
  if (toolTrace.line_count === 0) captureGaps.push("primary_tool_trace_absent_or_unavailable");
  if (proofEvents.line_count === 0) captureGaps.push("proof_telemetry_absent");

  const mode = records.length === 0
    ? "absent"
    : (invalidCount > 0 || captureGaps.length > 0 ? "partial" : "present");
  const state = readStateJson(target.planDir) || {};
  const summary = {
    generated_at: nowISO(),
    enabled: true,
    mode,
    plan_id: target.planDirName,
    repo_root: repoRoot,
    ledger_path: repoRelative(repoRoot, runsPath),
    run_count: records.length,
    invalid_record_count: invalidCount,
    latest_run_at: latestTimestamp(records),
    actors: countBy(records, (record) => record.actor?.id || record.actor?.role || record.actor?.kind),
    sources: countBy(records, (record) => record.source),
    models: countBy(records, (record) => record.model || record.provider?.model),
    persona_packs: personaPacks,
    advisory_artifacts: advisoryArtifacts,
    tool_trace: {
      path: repoRelative(repoRoot, join(target.planDir, "artifacts", "tool_trace.jsonl")),
      line_count: toolTrace.line_count,
      latest_at: toolTrace.latest_at,
    },
    proof_telemetry: {
      path: repoRelative(repoRoot, join(target.planDir, "telemetry", "events.jsonl")),
      event_count: proofEvents.line_count,
      latest_at: proofEvents.latest_at,
      summary_mode: proofSummary?.mode || null,
    },
    deterministic_status: {
      plan_state: state.state || state.phase || null,
      advisory_can_clear_blockers: false,
      authority: "state_json_and_program_packet",
    },
    advisory_status: {
      artifact_count: advisoryArtifacts.length,
      authority: "advisory_only",
    },
    capture_gaps: uniqueList(captureGaps),
    privacy: {
      raw_prompt_records: records.filter((record) => Object.prototype.hasOwnProperty.call(record, "prompt_text")).length,
      raw_response_records: records.filter((record) => Object.prototype.hasOwnProperty.call(record, "response_text")).length,
      redacted_excerpts: true,
    },
  };
  if (includeRuns) summary.runs = records.map(compactRun);

  if (persist) {
    mkdirSync(telemetryDir, { recursive: true });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  }
  return summary;
}

export function buildPlanLlmRunReport(options = {}) {
  return summarizeLlmRunTelemetry({
    ...options,
    includeRuns: options.includeRuns !== false,
    persist: options.persist === true,
  });
}

export function buildIdeTelemetryAdapterMatrix({
  hookConfigured = false,
  llmRunTelemetryEnabled = null,
} = {}) {
  const plannerEvents = llmRunTelemetryEnabled === null ? isFeatureEnabled("llm_run_telemetry") : llmRunTelemetryEnabled === true;
  const postToolStatus = hookConfigured ? "available" : "unavailable";
  return [
    {
      ide: "claude_code",
      adapter: "post_tool_use",
      primary_tool_capture: postToolStatus,
      planner_owned_llm_events: plannerEvents ? "recordable" : "disabled",
      notes: hookConfigured ? [] : ["missing_post_tool_use_hook"],
    },
    {
      ide: "cursor",
      adapter: "post_tool_use",
      primary_tool_capture: postToolStatus,
      planner_owned_llm_events: plannerEvents ? "recordable" : "disabled",
      notes: hookConfigured ? [] : ["missing_post_tool_use_hook"],
    },
    {
      ide: "antigravity",
      adapter: "trace_auditor_import",
      primary_tool_capture: "import_supported",
      planner_owned_llm_events: plannerEvents ? "recordable" : "disabled",
      notes: ["use trace_auditor.mjs --import-antigravity for primary tool traces"],
    },
    {
      ide: "vs_code",
      adapter: "none",
      primary_tool_capture: "unsupported_without_claude_or_cursor_hook",
      planner_owned_llm_events: plannerEvents ? "recordable" : "disabled",
      notes: ["plain VS Code does not provide this repo a primary PostToolUse stream"],
    },
    {
      ide: "codex",
      adapter: "planner_owned_events_only",
      primary_tool_capture: "unavailable",
      planner_owned_llm_events: plannerEvents ? "recordable" : "disabled",
      notes: ["Codex has no supported primary tool hook in this project context"],
    },
  ];
}

export function normalizeIdeTelemetryEvent(input = {}, { ide = null } = {}) {
  const adapter = normalizeToken(ide || input.ide || input.source || "unknown");
  const timestamp = input.timestamp || input.ts || nowISO();
  if (adapter === "codex" || adapter === "vs_code" || input.capture_unavailable === true) {
    return {
      schema_version: LLM_RUN_TELEMETRY_SCHEMA_VERSION,
      timestamp,
      adapter,
      source: adapter,
      event_type: "capture_unavailable",
      tool_name: null,
      paths: [],
      capture_status: {
        primary_tool_capture: adapter === "vs_code" ? "unsupported_without_claude_or_cursor_hook" : "unavailable",
        reason: input.reason || "no_supported_primary_tool_hook",
      },
    };
  }

  const isAntigravity = adapter === "antigravity";
  const toolInput = input.tool_input || input.input || input.args || {};
  const toolName = input.tool_name || input.tool || input.name || toolInput.tool || "";
  const paths = uniqueList([
    ...(Array.isArray(input.paths) ? input.paths : []),
    input.path,
    toolInput.path,
    toolInput.file_path,
  ]);
  const command = toolInput.command || input.command || null;
  return {
    schema_version: LLM_RUN_TELEMETRY_SCHEMA_VERSION,
    timestamp,
    adapter,
    source: isAntigravity ? "antigravity_import" : "post_tool_use",
    event_type: "tool_use",
    tool_name: toolName || null,
    tool_input_digest: digestValue(toolInput),
    paths,
    command_excerpt: command ? redactSecrets(String(command).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200)) : null,
    capture_status: {
      primary_tool_capture: isAntigravity ? "import_supported" : "available",
      raw_shape: isAntigravity ? "antigravity_jsonl" : "post_tool_use",
    },
  };
}
