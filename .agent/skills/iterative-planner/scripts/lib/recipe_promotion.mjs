// recipe_promotion.mjs — Advisory recipe-promotion detector for repeatable operational flows.

import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join } from "path";

const MAX_JSONL_LINES = 4000;
const MAX_JSONL_BYTES = 1_000_000;
const MAX_TELEMETRY_FILES = 120;

const WORK_ORDER_ARRAY_KEYS = [
  "proposed_creations",
  "scripts_to_create",
  "new_scripts",
  "runnable_flows",
  "operational_flows",
  "recipe_promotion_candidates",
];

const COMMAND_KEYS = [
  "command",
  "cmd",
  "argv",
  "args",
  "runner_command",
  "shell_command",
];

const PLANNER_COMMAND_PATTERNS = [
  /\b\.agent\/skills\/iterative-planner\//,
  /\b(agent\/skills\/iterative-planner|iterative-planner\/scripts\/(transition|verify_gate|bootstrap|rule_engine|program_manager|planner|close_signals|scoreboard|behavior_report|ritual_replay|seeded_defect_harness)\.mjs)\b/,
  /\b(test_|tests\/|\/tests\/|\.spec\.)/,
  /^(git|rg|grep|sed|awk|cat|ls|find|wc|date|pwd|mkdir|rm|cp|mv|touch|head|tail)\b/,
  /^(npm|pnpm|yarn|bun)\s+(test|install|ci|run\s+test)\b/,
  /\b(node|python3?|bash)\s+.*\b(test|check-invariants|validate|lint|smoke)\b/i,
];

const SCRIPT_EXTENSION_COMMANDS = [
  { pattern: /\.mjs$|\.cjs$|\.js$/i, command: "node" },
  { pattern: /\.py$/i, command: "python3" },
  { pattern: /\.sh$/i, command: "bash" },
];

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function safeReadText(path) {
  try {
    if (!existsSync(path)) return "";
    const stats = statSync(path);
    if (stats.size > MAX_JSONL_BYTES) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))];
}

function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entryValue]) => typeof key === "string" && key.trim() && typeof entryValue === "string" && entryValue.trim())
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
  );
}

function normalizeId(text, fallback = "capability") {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized && !/^\d/.test(normalized)) return normalized;
  return fallback;
}

function normalizeRecipeId(text, fallback = "recipe") {
  return String(text || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function titleFromId(id) {
  return String(id || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function stableHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function commandFromValue(value) {
  if (Array.isArray(value)) {
    const command = value
      .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
    return command.length > 0 ? command : [];
  }
  if (typeof value !== "string" || !value.trim()) return [];
  const trimmed = value.trim();
  if (!/\s/.test(trimmed)) return [trimmed];
  return trimmed.match(/(?:"[^"]+"|'[^']+'|\S+)/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean) || [];
}

function inferCommandFromPath(path) {
  if (typeof path !== "string" || !path.trim()) return [];
  const scriptPath = path.trim();
  const match = SCRIPT_EXTENSION_COMMANDS.find((entry) => entry.pattern.test(scriptPath));
  return match ? [match.command, scriptPath] : [];
}

function normalizeRunner(value = {}) {
  const runner = value.runner && typeof value.runner === "object" && !Array.isArray(value.runner)
    ? value.runner
    : value;
  let command = [];
  for (const key of COMMAND_KEYS) {
    command = commandFromValue(runner[key] ?? value[key]);
    if (command.length > 0) break;
  }
  const path = firstString(value.path, value.script_path, value.file, runner.path);
  if (command.length === 0) command = inferCommandFromPath(path);
  const cwd = firstString(runner.cwd, value.cwd, ".") || ".";
  const dryRunFlags = uniqueList([
    ...(Array.isArray(runner.dry_run_flags) ? runner.dry_run_flags : []),
    ...(Array.isArray(value.dry_run_flags) ? value.dry_run_flags : []),
  ]);
  return {
    type: "command",
    cwd,
    command,
    defaults: normalizeStringMap(runner.defaults || value.defaults),
    dry_run_flags: dryRunFlags.length > 0 ? dryRunFlags : ["--dry-run"],
    live_flags: uniqueList([
      ...(Array.isArray(runner.live_flags) ? runner.live_flags : []),
      ...(Array.isArray(value.live_flags) ? value.live_flags : []),
    ]),
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function commandSignature(command, cwd = ".") {
  const normalizedCommand = commandFromValue(command);
  if (normalizedCommand.length === 0) return "";
  const normalizedCwd = typeof cwd === "string" && cwd.trim() ? cwd.trim() : ".";
  return `${normalizedCwd} :: ${normalizedCommand.join(" ")}`;
}

export function isOperationalPromotionCommand(command, cwd = ".") {
  const normalizedCommand = commandFromValue(command);
  if (normalizedCommand.length === 0) return false;
  const commandText = normalizedCommand.join(" ").trim();
  if (!commandText) return false;
  if (PLANNER_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText))) return false;
  const executable = basename(normalizedCommand[0] || "");
  const scriptToken = normalizedCommand.find((token) => /\.(mjs|cjs|js|py|sh)$/i.test(token)) || "";
  if (["node", "python", "python3", "bash", "sh"].includes(executable)) {
    if (!scriptToken) return false;
    if (/^\.agent\//.test(scriptToken) || /\/tests?\//.test(scriptToken) || /^tests?\//.test(scriptToken)) return false;
    return true;
  }
  if (/^(npm|pnpm|yarn|bun|git|rg|grep|sed|awk|cat|ls|find|wc|date|pwd)$/i.test(executable)) return false;
  return /\b(run|sync|import|export|collect|fetch|generate|reconcile|backfill|dispatch|compile|send|publish|refresh)\b/i.test(commandText) ||
    /\.(mjs|cjs|js|py|sh)$/i.test(commandText) ||
    String(cwd || ".").includes("scripts");
}

function sourcePlanIdFromPath(path) {
  const text = String(path || "");
  const match = text.match(/plans\/(plan_[^/]+)\//);
  return match ? match[1] : null;
}

function buildCandidateFromFlow({
  sourceType,
  flow,
  cwd = ".",
  planId = null,
  provenance = [],
  occurrenceCount = 1,
}) {
  const runner = normalizeRunner(flow);
  if (!isOperationalPromotionCommand(runner.command, runner.cwd)) return null;

  const path = firstString(flow.path, flow.script_path, flow.file, runner.command.find((token) => /\.(mjs|cjs|js|py|sh)$/i.test(token)));
  const purpose = firstString(flow.purpose, flow.description, flow.title, flow.summary, `Promoted operational flow: ${runner.command.join(" ")}`);
  const capabilityId = normalizeId(firstString(flow.capability_id, flow.capabilityId, flow.id, flow.name, purpose), "promoted_flow");
  const recipeId = normalizeRecipeId(firstString(flow.recipe_id, flow.recipeId, capabilityId.replace(/_/g, "-")), "promoted-flow");
  const signature = commandSignature(runner.command, runner.cwd);
  const id = `recipe-promotion-${stableHash(`${sourceType}|${signature}|${recipeId}`)}`;
  const bootstrapCommand = buildBootstrapCommand({
    goal: purpose,
    recipeId,
    capabilityId,
    path,
    purpose,
    runner,
  });
  return {
    id,
    source_type: sourceType,
    status: "needs_disposition",
    capability_id: capabilityId,
    recipe_id: recipeId,
    title: firstString(flow.title, titleFromId(recipeId)),
    purpose,
    path: path || null,
    runner,
    dry_run_flags: runner.dry_run_flags,
    command_signature: signature,
    bootstrap_command: bootstrapCommand,
    bootstrap_command_display: shellJoin(bootstrapCommand),
    occurrence_count: occurrenceCount,
    provenance: provenance.length > 0 ? provenance : [{
      source: sourceType,
      plan_id: planId,
      cwd,
    }],
    draft: buildRecipePromotionDraft({
      recipe_id: recipeId,
      capability_id: capabilityId,
      title: firstString(flow.title, titleFromId(recipeId)),
      purpose,
      path,
      runner,
    }),
  };
}

function buildBootstrapCommand({ goal, recipeId, capabilityId, path, purpose, runner }) {
  const command = [
    "node",
    ".agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs",
    "--goal",
    goal || titleFromId(recipeId),
    "--recipe-id",
    recipeId,
    "--capability-id",
    capabilityId,
    "--runner-cwd",
    runner.cwd || ".",
  ];
  if (Array.isArray(runner.command) && runner.command.length > 0) {
    command.push("--runner-bin", runner.command[0]);
    for (const arg of runner.command.slice(1)) command.push("--runner-arg", arg);
  }
  if (path) command.push("--script", `${path}::${purpose || "Promoted operational flow"}`);
  for (const flag of runner.dry_run_flags || []) command.push("--runner-dry-flag", flag);
  for (const [key, value] of Object.entries(runner.defaults || {})) command.push("--runner-default", `${key}=${value}`);
  command.push("--json");
  return command;
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function shellJoin(command) {
  return (Array.isArray(command) ? command : []).map(shellQuote).join(" ");
}

export function buildRecipePromotionDraft(candidate) {
  const recipeId = normalizeRecipeId(candidate?.recipe_id, "promoted-flow");
  const capabilityId = normalizeId(candidate?.capability_id || recipeId, "promoted_flow");
  const title = firstString(candidate?.title, titleFromId(recipeId));
  const purpose = firstString(candidate?.purpose, `Promoted flow for ${title}`);
  const path = firstString(candidate?.path);
  const runner = normalizeRunner(candidate?.runner || candidate || {});
  const trigger = purpose.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 100);
  const recipe = {
    id: recipeId,
    title,
    capability_id: capabilityId,
    entity_ids: [],
    required_params: [],
    systems: uniqueList(candidate?.systems),
    workflows: uniqueList(candidate?.workflows),
    scripts: path ? [{ path, purpose }] : [],
    skills: uniqueList(candidate?.skills),
    runner,
  };
  const capability = {
    id: capabilityId,
    title: titleFromId(capabilityId),
    description: purpose,
    triggers: trigger ? [{ pattern: trigger, weight: 1 }] : [],
    parameters: [],
    required_params: [],
    recipe_ids: [recipeId],
    skills: uniqueList(candidate?.skills),
    scripts: recipe.scripts,
    supported_entities: [],
  };
  return {
    schema_version: 1,
    files: {
      [`recipes/${recipeId}/recipe.json`]: recipe,
      "recipes/capability_registry.json": {
        version: 1,
        capabilities: [capability],
      },
      "recipes/entity_registry.json": {
        version: 1,
        entities: [],
      },
    },
    recipe,
    capability,
  };
}

function collectWorkOrderFlows(workOrder) {
  if (!workOrder || typeof workOrder !== "object") return [];
  const flows = [];
  for (const key of WORK_ORDER_ARRAY_KEYS) {
    if (!Array.isArray(workOrder[key])) continue;
    for (const entry of workOrder[key]) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) flows.push({ ...entry, _work_order_key: key });
    }
  }
  const recipeProfileRunner = workOrder.profile?.recipe?.runner || workOrder.recipe?.runner || null;
  if (recipeProfileRunner) {
    flows.push({
      ...workOrder.recipe,
      runner: recipeProfileRunner,
      capability_id: workOrder.recipe?.capability_id || workOrder.profile?.recipe?.capability_id,
      recipe_id: workOrder.recipe?.recipe_id || workOrder.profile?.recipe?.recipe_id,
      purpose: workOrder.goal,
      _work_order_key: "profile.recipe.runner",
    });
  }
  return flows;
}

function extractObjectCommandRecord(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const runner = normalizeRunner(object);
  if (runner.command.length > 0) {
    return {
      runner,
      purpose: firstString(object.purpose, object.summary, object.description, object.name, object.type),
      path: firstString(object.path, object.script_path, object.file),
    };
  }
  const nested = [
    object.input,
    object.inputs,
    object.tool_input,
    object.toolInput,
    object.payload,
    object.args,
    object.result,
  ];
  for (const entry of nested) {
    const record = extractObjectCommandRecord(entry);
    if (record) return record;
  }
  return null;
}

function readJsonl(path) {
  const content = safeReadText(path);
  if (!content) return [];
  const rows = [];
  const lines = content.split("\n").slice(0, MAX_JSONL_LINES);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push({ line: index + 1, value: JSON.parse(line) });
    } catch {
      // Ignore malformed telemetry rows; they should not create recipe advice.
    }
  }
  return rows;
}

function listTelemetryFiles(cwd) {
  const plansDir = join(cwd, "plans");
  if (!existsSync(plansDir)) return [];
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^plan_/.test(entry.name))
      .map((entry) => join(plansDir, entry.name, "telemetry", "events.jsonl"))
      .filter((path) => existsSync(path))
      .sort()
      .slice(-MAX_TELEMETRY_FILES);
  } catch {
    return [];
  }
}

function collectRepeatedCommandOccurrences({ cwd }) {
  const occurrences = [];
  const journalPath = join(cwd, "plans", "knowledge", "agent_journal.jsonl");
  for (const row of readJsonl(journalPath)) {
    const record = extractObjectCommandRecord(row.value?.payload || row.value);
    if (!record) continue;
    if (!isOperationalPromotionCommand(record.runner.command, record.runner.cwd)) continue;
    occurrences.push({
      source: "agent_journal",
      path: journalPath,
      line: row.line,
      plan_id: firstString(row.value?.plan_id, row.value?.payload?.plan_id),
      runner: record.runner,
      purpose: firstString(record.purpose, row.value?.summary),
      script_path: record.path,
      ref: row.value?.id || null,
    });
  }
  for (const path of listTelemetryFiles(cwd)) {
    for (const row of readJsonl(path)) {
      const record = extractObjectCommandRecord(row.value);
      if (!record) continue;
      if (!isOperationalPromotionCommand(record.runner.command, record.runner.cwd)) continue;
      occurrences.push({
        source: "telemetry",
        path,
        line: row.line,
        plan_id: sourcePlanIdFromPath(path),
        runner: record.runner,
        purpose: record.purpose,
        script_path: record.path,
        ref: row.value?.id || row.value?.event_id || null,
      });
    }
  }
  return occurrences;
}

function collectRepeatedCommandCandidates({ cwd, planId = null }) {
  const grouped = new Map();
  for (const occurrence of collectRepeatedCommandOccurrences({ cwd })) {
    const signature = commandSignature(occurrence.runner.command, occurrence.runner.cwd);
    if (!signature) continue;
    if (!grouped.has(signature)) grouped.set(signature, []);
    grouped.get(signature).push(occurrence);
  }

  const candidates = [];
  for (const [signature, occurrences] of grouped.entries()) {
    const distinctPlans = new Set(occurrences.map((entry) => entry.plan_id).filter(Boolean));
    const distinctSources = new Set(occurrences.map((entry) => entry.source));
    if (occurrences.length < 2 || (distinctPlans.size < 2 && distinctSources.size < 2)) continue;
    const primary = occurrences[0];
    const scriptPath = firstString(primary.script_path, primary.runner.command.find((token) => /\.(mjs|cjs|js|py|sh)$/i.test(token)));
    const purpose = firstString(primary.purpose, `Repeated operational command ${primary.runner.command.join(" ")}`);
    const flow = {
      path: scriptPath,
      purpose,
      title: titleFromId(basename(scriptPath || "repeated operational flow").replace(/\.[^.]+$/, "")),
      command: primary.runner.command,
      runner: primary.runner,
      capability_id: normalizeId(basename(scriptPath || signature).replace(/\.[^.]+$/, ""), "repeated_flow"),
    };
    const candidate = buildCandidateFromFlow({
      sourceType: "cross_plan_repeat",
      flow,
      cwd,
      planId,
      occurrenceCount: occurrences.length,
      provenance: occurrences.map((entry) => ({
        source: entry.source,
        plan_id: entry.plan_id,
        path: entry.path,
        line: entry.line,
        ref: entry.ref,
      })),
    });
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function collectRecipePromotionCandidates({
  cwd = process.cwd(),
  planDir = null,
  stateJson = null,
  workOrder = null,
  maxCandidates = 5,
} = {}) {
  const planId = firstString(stateJson?.id, planDir ? basename(planDir) : "");
  const effectiveWorkOrder = workOrder || (planDir ? safeReadJson(join(planDir, "work_order.json")) : null);
  const candidates = [];
  for (const flow of collectWorkOrderFlows(effectiveWorkOrder)) {
    const candidate = buildCandidateFromFlow({
      sourceType: "plan_produced",
      flow,
      cwd,
      planId,
      provenance: [{
        source: "work_order",
        plan_id: planId,
        path: planDir ? join(planDir, "work_order.json") : null,
        ref: flow._work_order_key || null,
      }],
    });
    if (candidate) candidates.push(candidate);
  }
  candidates.push(...collectRepeatedCommandCandidates({ cwd, planId }));

  const deduped = new Map();
  for (const candidate of candidates) {
    const key = candidate.command_signature;
    if (!deduped.has(key)) {
      deduped.set(key, candidate);
      continue;
    }
    const existing = deduped.get(key);
    existing.provenance = [...existing.provenance, ...candidate.provenance];
    existing.occurrence_count = Math.max(existing.occurrence_count || 1, candidate.occurrence_count || 1);
    if (existing.source_type !== "plan_produced" && candidate.source_type === "plan_produced") {
      deduped.set(key, { ...candidate, provenance: existing.provenance, occurrence_count: existing.occurrence_count });
    }
  }

  return [...deduped.values()]
    .sort((a, b) => (a.source_type === b.source_type ? a.id.localeCompare(b.id) : a.source_type === "plan_produced" ? -1 : 1))
    .slice(0, maxCandidates);
}

function dispositionForCandidate(candidate, content) {
  const text = String(content || "");
  if (!/recipe promotion/i.test(text)) return null;
  const identifiers = uniqueList([candidate.id, candidate.recipe_id, candidate.capability_id]);
  const mentionsCandidate = identifiers.some((id) => id && text.includes(id));
  if (!mentionsCandidate) return null;
  const actionMatch = text.match(/\b(accepted|confirmed|promoted|deferred|rejected|waived|not_applicable|not applicable)\b/i);
  return actionMatch ? actionMatch[1].toLowerCase().replace(/\s+/g, "_") : "acknowledged";
}

export function computeRecipePromotionSignal({
  cwd = process.cwd(),
  planDir = null,
  stateJson = null,
  planContent = "",
  reflectionContent = "",
  verificationContent = "",
  workOrder = null,
} = {}) {
  const candidates = collectRecipePromotionCandidates({
    cwd,
    planDir,
    stateJson,
    workOrder,
  });
  const dispositionContent = [planContent, reflectionContent, verificationContent].filter(Boolean).join("\n\n");
  const candidatesWithDisposition = candidates.map((candidate) => {
    const disposition = dispositionForCandidate(candidate, dispositionContent);
    return {
      ...candidate,
      status: disposition ? "acknowledged" : "needs_disposition",
      disposition,
    };
  });
  const unacknowledged = candidatesWithDisposition.filter((candidate) => !candidate.disposition);
  const required = candidatesWithDisposition.length > 0;
  const satisfied = !required || unacknowledged.length === 0;
  return {
    required,
    satisfied,
    status: !required ? "not_required" : satisfied ? "acknowledged" : "needs_disposition",
    candidate_count: candidatesWithDisposition.length,
    unacknowledged_count: unacknowledged.length,
    candidates: candidatesWithDisposition,
    suggested_section: "## Recipe Promotion",
    detail: !required
      ? "Structured close signal: no repeatable operational flow needs recipe promotion"
      : satisfied
        ? `Structured close signal: ${candidatesWithDisposition.length} recipe-promotion candidate(s) have explicit disposition`
        : `Recipe promotion needs explicit disposition for ${unacknowledged.length} candidate(s): ${unacknowledged.map((candidate) => candidate.id).join(", ")}`,
  };
}
