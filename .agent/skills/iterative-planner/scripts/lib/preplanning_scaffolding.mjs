import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

import { extractFilesToModify, FAIL, PASS, SKIP, WARN } from "./plan_utils.mjs";
import { detectPlanShape } from "./plan_shape.mjs";
import { loadPlannerPolicy } from "./planner_policy.mjs";
import { normalizePlannerManifesto } from "./planner_manifesto.mjs";

const __filename = fileURLToPath(import.meta.url);
const defaultSkillPath = resolve(dirname(__filename), "..", "..");

export const PREPLANNING_CODES = Object.freeze({
  northStar: "GATE-EXP-017",
  storyRegistry: "GATE-EXP-018",
  programContext: "GATE-EXP-019",
});

export const PREPLANNING_FINDINGS = Object.freeze({
  northStarMissing: "preplanning_north_star_missing",
  storyRegistryMissing: "preplanning_story_registry_missing",
  storyRegistryBelowMinimum: "preplanning_story_registry_below_minimum",
  programContextMissing: "preplanning_program_context_missing",
});

const SKIP_SHAPES = new Set(["analysis", "chore"]);
const INACTIVE_STORY_STATUSES = new Set([
  "archived",
  "cancelled",
  "canceled",
  "closed",
  "deprecated",
  "removed",
  "retired",
]);
const COUNTABLE_STORY_STATUSES = new Set([
  "draft",
  "fully_covered",
  "not_implemented",
  "partially_covered",
  "planned",
  "proposed",
]);
const CLOSED_PROGRAM_STATUSES = new Set([
  "abandoned",
  "cancelled",
  "canceled",
  "closed",
  "completed",
  "deferred",
  "done",
]);

function safeRead(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    const content = safeRead(filePath);
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

function rel(cwd, filePath) {
  if (!filePath) return "";
  const relativePath = relative(cwd, filePath).replace(/\\/g, "/");
  return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !["from", "with", "this", "that", "ticket", "program", "packet"].includes(token));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = asNonEmptyString(value);
    if (normalized) return normalized;
  }
  return null;
}

function configuredStoryMinimum(cwd) {
  const loaded = loadPlannerPolicy(cwd);
  const policy = loaded.valid ? loaded.policy : null;
  const storyPolicy = policy?.story_registry || {};
  const candidates = [
    storyPolicy.minimum_active_or_draft_stories,
    storyPolicy.min_active_or_draft_stories,
    storyPolicy.minimum_active_stories,
    storyPolicy.min_active_stories,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
  }
  return 1;
}

function planShapeFor({ stateJson, planContent }) {
  const stateShape = asNonEmptyString(stateJson?.plan_shape?.primary);
  if (stateShape) return stateShape.toLowerCase();

  const plannedFiles = extractFilesToModify(planContent || "");
  const detected = detectPlanShape({
    goalText: stateJson?.goal || "",
    plannedFiles,
    intentContract: safeReadJson(stateJson?.intent_contract_path || ""),
  });
  return detected.primary || "unknown";
}

function softStatusForShape(shape) {
  return SKIP_SHAPES.has(String(shape || "").toLowerCase()) ? WARN : FAIL;
}

function hasValidNorthStarContract(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (asNonEmptyString(raw.north_star)) return true;

  const version = Number(raw.schema_version || raw.version || 1);
  if (version < 2) return false;

  const normalized = normalizePlannerManifesto(raw);
  return normalized.valid === true &&
    asNonEmptyString(normalized.north_star_type) &&
    normalized.core_metrics.length > 0 &&
    normalized.invariant_directives.length > 0;
}

function evaluateNorthStar({ cwd, planDir, skillPath, shape }) {
  const sources = [
    join(planDir, "intent_contract.json"),
    join(cwd, "planner_manifesto.json"),
    join(skillPath, "config", "planner_manifesto.json"),
  ];
  const validSource = sources.find((source) => hasValidNorthStarContract(safeReadJson(source)));
  if (validSource) {
    return {
      name: "North Star contract",
      status: PASS,
      detail: `Found explicit North Star contract at ${rel(cwd, validSource)}`,
      finding_id: "preplanning_north_star_present",
    };
  }

  const status = softStatusForShape(shape);
  return {
    name: "North Star contract",
    status,
    detail: `No explicit North Star contract found in ${sources.map((source) => rel(cwd, source)).join(", ")}`,
    code: PREPLANNING_CODES.northStar,
    finding_id: PREPLANNING_FINDINGS.northStarMissing,
    action: "Define `north_star` or v2 `north_star_type` + `core_metrics` + `invariant_directives` in the plan intent contract or `.agent/skills/iterative-planner/config/planner_manifesto.json`.",
  };
}

function countActiveStories(registry) {
  const stories = asArray(registry?.stories);
  return stories.filter((story) => {
    if (!asNonEmptyString(story?.id)) return false;
    const status = String(story?.status || "").trim().toLowerCase();
    return COUNTABLE_STORY_STATUSES.has(status) && !INACTIVE_STORY_STATUSES.has(status);
  }).length;
}

function storyBootstrapDryRun({ cwd, skillPath }) {
  const scriptPath = join(skillPath, "scripts", "story_registry_bootstrap.mjs");
  const command = "node .agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs --dry-run --json";
  if (!existsSync(scriptPath)) {
    return {
      command,
      detail: "story_registry_bootstrap.mjs is missing",
    };
  }
  const proc = spawnSync(process.execPath, [scriptPath, "--dry-run", "--json", "--dir", cwd], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
  });
  const stdout = String(proc.stdout || "").trim();
  const stderr = String(proc.stderr || "").trim();
  let parsed = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch { /* excerpt below is enough */ }
  const candidateCount = Number(parsed?.candidates?.length ?? parsed?.candidate_count ?? parsed?.summary?.candidates ?? NaN);
  const detail = Number.isFinite(candidateCount)
    ? `dry-run found ${candidateCount} candidate story item(s)`
    : `dry-run exit ${proc.status ?? "unknown"}${stderr ? `; stderr: ${stderr.slice(0, 160)}` : stdout ? `; stdout: ${stdout.slice(0, 160)}` : ""}`;
  return { command, detail };
}

function evaluateStoryRegistry({ cwd, skillPath, shape }) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  const minimum = configuredStoryMinimum(cwd);
  const status = softStatusForShape(shape);
  let bootstrap = null;
  const getBootstrap = () => {
    if (!bootstrap) bootstrap = storyBootstrapDryRun({ cwd, skillPath });
    return bootstrap;
  };

  if (!existsSync(registryPath)) {
    const repair = getBootstrap();
    return {
      name: "Story registry baseline",
      status,
      detail: `${rel(cwd, registryPath)} missing; ${repair.detail}`,
      code: PREPLANNING_CODES.storyRegistry,
      finding_id: PREPLANNING_FINDINGS.storyRegistryMissing,
      action: `Run: ${repair.command}`,
    };
  }

  const registry = safeReadJson(registryPath);
  if (!registry || !Array.isArray(registry.stories)) {
    const repair = getBootstrap();
    return {
      name: "Story registry baseline",
      status,
      detail: `${rel(cwd, registryPath)} is invalid or lacks a stories array; ${repair.detail}`,
      code: PREPLANNING_CODES.storyRegistry,
      finding_id: PREPLANNING_FINDINGS.storyRegistryMissing,
      action: "Repair `reports/user_story_audit/story_registry.json`, then run `node .agent/skills/iterative-planner/scripts/rule_engine.mjs verify-stories --json`.",
    };
  }

  const activeCount = countActiveStories(registry);
  if (activeCount < minimum) {
    const repair = getBootstrap();
    return {
      name: "Story registry baseline",
      status,
      detail: `${activeCount} active/draft story item(s), minimum ${minimum}; ${repair.detail}`,
      code: PREPLANNING_CODES.storyRegistry,
      finding_id: PREPLANNING_FINDINGS.storyRegistryBelowMinimum,
      action: `Run: ${repair.command}`,
    };
  }

  return {
    name: "Story registry baseline",
    status: PASS,
    detail: `${activeCount} active/draft story item(s), minimum ${minimum}`,
    finding_id: "preplanning_story_registry_present",
  };
}

function loadProgramPackets(cwd) {
  const programsDir = join(cwd, "plans", "programs");
  if (!existsSync(programsDir)) return [];
  const entries = [];
  for (const dirent of readdirSync(programsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const packetPath = join(programsDir, dirent.name, "program_packet.json");
    const packet = safeReadJson(packetPath);
    if (!packet || typeof packet !== "object") continue;
    const status = String(packet.status || "").trim().toLowerCase();
    if (CLOSED_PROGRAM_STATUSES.has(status)) continue;
    entries.push({ packet, packetPath });
  }
  return entries;
}

function packetIdentifiers(packet) {
  return unique([
    packet.program_id,
    packet.id,
    ...asArray(packet.tickets).map((ticket) => ticket?.id),
  ].map(asNonEmptyString));
}

function packetTokens(packet) {
  const text = [
    packet.program_id,
    packet.id,
    packet.title,
    ...asArray(packet.tickets).flatMap((ticket) => [ticket?.id, ticket?.title, ticket?.problem, ticket?.proposed_change]),
  ].join(" ");
  return unique(tokenize(text));
}

function matchProgramPacket(packetEntry, haystack) {
  const lowerHaystack = String(haystack || "").toLowerCase();
  const ids = packetIdentifiers(packetEntry.packet);
  const direct = ids.find((id) => lowerHaystack.includes(id.toLowerCase()));
  if (direct) {
    return { matched: true, reason: `matched id ${direct}`, ids, score: 1000 };
  }

  const tokens = packetTokens(packetEntry.packet);
  const matchedTokens = tokens.filter((token) => lowerHaystack.includes(token));
  if (matchedTokens.length >= 3) {
    return { matched: true, reason: `matched tokens ${matchedTokens.slice(0, 4).join(", ")}`, ids, score: matchedTokens.length };
  }

  return { matched: false, ids, score: 0 };
}

function hasProgramContext({ stateJson, planContent, findingsContent, match }) {
  if (stateJson?.program_context || stateJson?.program_packet || stateJson?.program_id || stateJson?.ticket_id) {
    return true;
  }
  const content = `${planContent || ""}\n${findingsContent || ""}`;
  if (!/^##\s+Program Context\s*$/im.test(content)) return false;
  const lower = content.toLowerCase();
  return match.ids.some((id) => lower.includes(id.toLowerCase()));
}

function programIntakeCommand(packetPath, goal) {
  const safeGoal = String(goal || "").replace(/\s+/g, " ").trim().replace(/"/g, "\\\"");
  return `node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program ${packetPath} --from-text "${safeGoal}" --auto-story --write --json`;
}

function evaluateProgramContext({ cwd, stateJson, planContent, findingsContent, shape }) {
  const packets = loadProgramPackets(cwd);
  if (packets.length === 0) {
    return {
      name: "Program Packet context",
      status: SKIP,
      detail: "No open Program Packets found under plans/programs",
      finding_id: "preplanning_program_context_not_applicable",
    };
  }

  const plannedFiles = extractFilesToModify(planContent || "");
  const haystack = [
    stateJson?.goal,
    planContent,
    findingsContent,
    plannedFiles.join(" "),
  ].join("\n");

  const matched = packets
    .map((entry) => ({ ...entry, match: matchProgramPacket(entry, haystack) }))
    .filter((entry) => entry.match.matched)
    .sort((a, b) => (b.match.score || 0) - (a.match.score || 0))[0];

  if (!matched) {
    return {
      name: "Program Packet context",
      status: SKIP,
      detail: `${packets.length} open Program Packet(s), none matched this plan goal/files`,
      finding_id: "preplanning_program_context_not_applicable",
    };
  }

  if (hasProgramContext({ stateJson, planContent, findingsContent, match: matched.match })) {
    return {
      name: "Program Packet context",
      status: PASS,
      detail: `Context declared for ${matched.packet.program_id || matched.packet.id} (${matched.match.reason})`,
      finding_id: "preplanning_program_context_present",
    };
  }

  const status = softStatusForShape(shape);
  const packetPath = rel(cwd, matched.packetPath);
  return {
    name: "Program Packet context",
    status,
    detail: `Plan appears related to ${matched.packet.program_id || matched.packet.id} (${matched.match.reason}) but lacks a ## Program Context section or state program_context link`,
    code: PREPLANNING_CODES.programContext,
    finding_id: PREPLANNING_FINDINGS.programContextMissing,
    action: `Add a ## Program Context section naming ${matched.packet.program_id || matched.packet.id} and the relevant ticket, or run: ${programIntakeCommand(packetPath, stateJson?.goal || "")}`,
  };
}

export function evaluatePreplanningScaffolding({ cwd = process.cwd(), planDir, skillPath = defaultSkillPath } = {}) {
  if (!planDir) {
    return {
      shape: "unknown",
      results: [{
        name: "Pre-planning scaffold target",
        status: FAIL,
        detail: "No plan directory provided",
        finding_id: "preplanning_plan_dir_missing",
      }],
      actions: [],
    };
  }

  const stateJson = safeReadJson(join(planDir, "state.json")) || {};
  const planContent = safeRead(join(planDir, "plan.md")) || "";
  const findingsContent = safeRead(join(planDir, "findings.md")) || "";
  const shape = planShapeFor({ stateJson, planContent });

  const results = [
    evaluateNorthStar({ cwd, planDir, skillPath, shape }),
    evaluateStoryRegistry({ cwd, skillPath, shape }),
    evaluateProgramContext({ cwd, stateJson, planContent, findingsContent, shape }),
  ];
  const actions = results
    .filter((result) => result.status !== PASS && result.status !== SKIP && result.action)
    .map((result) => ({
      finding_id: result.finding_id,
      code: result.code || null,
      action: result.action,
    }));

  return { shape, results, actions };
}
