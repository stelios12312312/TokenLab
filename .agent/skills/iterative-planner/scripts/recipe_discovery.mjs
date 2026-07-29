#!/usr/bin/env node
// recipe_discovery.mjs — Deterministic discovery and review drafting for recipe-shaped flows.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { walkDir } from "./annotation_parser.mjs";
import {
  buildProjectContext,
  enforceMinimumPersona,
  loadAuditConfig,
  loadRolePacks,
  runRoleAuditors,
} from "./audit_runner.mjs";
import {
  getPaths,
  getSkillPath,
  readFile,
  resolvePlanTarget,
} from "./lib/plan_utils.mjs";
import { resolveRecipeRequest } from "./lib/recipe_utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillPath = getSkillPath(import.meta.url);

const ENTRYPOINT_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".py", ".sh", ".ts"]);
const ENTRYPOINT_DIR_HINTS = new Set([
  "scripts",
  "script",
  "jobs",
  "job",
  "tasks",
  "task",
  "bin",
  "automation",
  "ops",
  "workflows",
  "workflow",
  "cron",
  "prod",
]);
const EXCLUDED_PREFIXES = ["./.agent/", ".agent/", "plans/", "reports/", "recipes/", "node_modules/", "dist/", "build/"];
const OPERATIONAL_VERBS = [
  "get",
  "fetch",
  "list",
  "show",
  "retrieve",
  "find",
  "pull",
  "sync",
  "reconcile",
  "align",
  "export",
  "import",
  "update",
  "run",
  "generate",
  "collect",
  "retrain",
  "train",
  "refresh",
  "consolidate",
  "backfill",
];
const SYSTEM_HINTS = [
  { id: "eventbrite", keywords: ["eventbrite"] },
  { id: "ghl", keywords: ["ghl", "gohighlevel"] },
  { id: "crm", keywords: ["crm"] },
  { id: "hubspot", keywords: ["hubspot"] },
  { id: "salesforce", keywords: ["salesforce"] },
  { id: "linkedin", keywords: ["linkedin"] },
  { id: "instantly", keywords: ["instantly"] },
  { id: "email", keywords: ["email"] },
  { id: "calendar", keywords: ["calendar"] },
  { id: "reporting", keywords: ["report", "reporting"] },
  { id: "portfolio", keywords: ["portfolio"] },
];
const CAPABILITY_HINTS = [
  {
    id: "get_participants",
    verbs: ["get", "fetch", "list", "show", "retrieve", "find", "pull", "collect"],
    nouns: ["participants", "participant", "attendees", "attendee", "registrants", "registrant"],
  },
  {
    id: "sync_participants",
    verbs: ["sync", "import", "export", "update"],
    nouns: ["participants", "participant", "contacts", "leads", "crm"],
  },
  {
    id: "reconcile_participants",
    verbs: ["reconcile", "align"],
    nouns: ["participants", "participant", "crm", "pipeline", "funnel", "contacts", "leads"],
  },
  {
    id: "align_crm_pipeline",
    verbs: ["align", "sync", "update"],
    nouns: ["crm", "pipeline", "funnel", "contacts", "leads"],
  },
  {
    id: "daily_runner",
    verbs: ["run", "generate"],
    nouns: ["daily", "runner"],
  },
  {
    id: "retrain_models",
    verbs: ["retrain", "train", "refresh"],
    nouns: ["retrain", "model", "models", "training"],
  },
  {
    id: "walk_forward_report",
    verbs: ["walk", "run", "generate", "consolidate"],
    nouns: ["walk", "forward", "wfo", "report", "portfolio"],
  },
];
const SYSTEM_KEYWORD_SET = new Set(SYSTEM_HINTS.flatMap((hint) => hint.keywords));
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "this",
  "that",
  "for",
  "from",
  "into",
  "in",
  "on",
  "to",
  "of",
  "with",
  "via",
  "by",
  "all",
  "latest",
  "most",
  "recent",
  "data",
  "task",
  "flow",
  "recipe",
  "please",
  ...OPERATIONAL_VERBS,
  ...SYSTEM_KEYWORD_SET,
]);

const args = process.argv.slice(2);
const flags = {
  apply: args.includes("--apply"),
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
};

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function significantTokens(value) {
  return tokenize(value).filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function uniqueList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())
  )];
}

function normalizeId(text, fallback = "flow") {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized && !/^\d/.test(normalized)) return normalized;
  return fallback;
}

function normalizeRecipeId(text, fallback = "recipe") {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function titleFromId(id) {
  return String(id || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractGoalFromPlanContent(planContent) {
  const text = String(planContent || "");
  const match = text.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim().split("\n")[0].trim() : "";
}

function pathMatchesRef(ref, relPath) {
  const refFile = String(ref || "").split(":")[0].replace(/\\/g, "/");
  const target = String(relPath || "").replace(/\\/g, "/");
  return refFile === target || target.endsWith(`/${refFile}`) || refFile.endsWith(`/${target}`);
}

function overlapsTokens(a, b) {
  const left = new Set(significantTokens(a));
  const right = new Set(significantTokens(b));
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count++;
  }
  return count;
}

function inferCapability(tokens) {
  let best = null;
  for (const hint of CAPABILITY_HINTS) {
    const verbHits = hint.verbs.filter((verb) => tokens.includes(verb)).length;
    const nounHits = hint.nouns.filter((noun) => tokens.includes(noun)).length;
    const score = verbHits * 2 + nounHits;
    if (score > 0 && (!best || score > best.score)) {
      best = {
        id: hint.id,
        score,
        verbs: hint.verbs,
        nouns: hint.nouns,
      };
    }
  }

  if (best) return best;

  const verb = OPERATIONAL_VERBS.find((entry) => tokens.includes(entry)) || (tokens.includes("runner") ? "run" : "run");
  const nounTokens = tokens.filter((token) => !STOPWORDS.has(token)).slice(0, 2);
  const nounId = nounTokens.length > 0 ? nounTokens.join("_") : "flow";
  return {
    id: normalizeId(`${verb}_${nounId}`, "run_flow"),
    score: nounTokens.length + 1,
    verbs: [verb],
    nouns: nounTokens.length > 0 ? nounTokens : ["flow"],
  };
}

function inferSystems(tokens) {
  const systems = [];
  for (const hint of SYSTEM_HINTS) {
    if (hint.keywords.some((keyword) => tokens.includes(keyword))) systems.push(hint.id);
  }
  return uniqueList(systems);
}

function inferEntityTokens(tokens, capability, systems = []) {
  const excluded = new Set([
    ...OPERATIONAL_VERBS,
    ...SYSTEM_KEYWORD_SET,
    ...ENTRYPOINT_DIR_HINTS,
    ...(Array.isArray(capability?.verbs) ? capability.verbs : []),
    ...(Array.isArray(capability?.nouns) ? capability.nouns : []),
    ...(Array.isArray(systems) ? systems : []),
    "runner",
  ]);

  return uniqueList(
    (Array.isArray(tokens) ? tokens : []).filter((token) => (
      typeof token === "string"
      && token.length > 1
      && !STOPWORDS.has(token)
      && !excluded.has(token)
      && !/^\d+$/.test(token)
    ))
  );
}

function inferRunnerHint(scriptPath) {
  const ext = extname(scriptPath).toLowerCase();
  if (ext === ".mjs" || ext === ".js" || ext === ".cjs") {
    return { type: "command", cwd: ".", command: ["node", scriptPath], dry_run_flags: [], live_flags: [] };
  }
  if (ext === ".py") {
    return { type: "command", cwd: ".", command: ["python3", scriptPath], dry_run_flags: [], live_flags: [] };
  }
  if (ext === ".sh") {
    return { type: "command", cwd: ".", command: ["bash", scriptPath], dry_run_flags: [], live_flags: [] };
  }
  return null;
}

function extractEntityPhrase(goalText, fallbackTexts = []) {
  const patterns = [
    /\bfor\s+([^,.;]+)/i,
    /\bfrom\s+([^,.;]+)/i,
    /\bof\s+([^,.;]+)/i,
  ];

  const texts = [goalText, ...fallbackTexts].filter(Boolean);
  for (const text of texts) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      const cleaned = match[1]
        .replace(/\b(using|with|via|in|on|to)\b.*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      const tokens = significantTokens(cleaned).filter((token) => !SYSTEM_KEYWORD_SET.has(token));
      if (tokens.length > 0) return tokens.slice(0, 4).join(" ");
    }
  }

  const fallbackTokens = significantTokens(goalText).filter((token) => !SYSTEM_KEYWORD_SET.has(token));
  if (fallbackTokens.length >= 2) return fallbackTokens.slice(0, 3).join(" ");
  return null;
}

function pickEntityPhrase(goalText, fallbackTexts = [], entityHints = []) {
  const normalizedHints = uniqueList(entityHints);
  const goalEntity = extractEntityPhrase(goalText);
  if (goalEntity) {
    const matchedHint = normalizedHints.find((hint) => {
      const overlapCount = overlapsTokens(goalEntity, hint);
      const hintTokenCount = significantTokens(hint).length;
      return overlapCount >= Math.min(2, hintTokenCount || 1);
    });
    if (matchedHint) return matchedHint;
    if (normalizedHints.length === 0) return goalEntity;
  }
  if (normalizedHints.length > 0) return normalizedHints[0];
  return extractEntityPhrase(goalText, fallbackTexts);
}

function buildCapabilityEntityStats(profiles) {
  const stats = new Map();
  for (const profile of profiles) {
    if (!stats.has(profile.capability_id)) {
      stats.set(profile.capability_id, new Set());
    }
    if (profile.entity_id_hint) {
      stats.get(profile.capability_id).add(profile.entity_id_hint);
    }
  }
  return stats;
}

function buildTriggerHints(capabilityProfile) {
  const verbs = uniqueList(capabilityProfile.verbs);
  const nouns = uniqueList(capabilityProfile.nouns);
  if (verbs.length === 0 || nouns.length === 0) return [];
  return [`\\b(${verbs.map(escapeRegex).join("|")})\\b.*\\b(${nouns.map(escapeRegex).join("|")})\\b`];
}

function listEntrypoints(cwd) {
  const files = walkDir(cwd, cwd);
  return files
    .map((filePath) => String(filePath || "").replace(/\\/g, "/"))
    .filter((relPath) => {
      if (!relPath) return false;
      if (EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false;
      const ext = extname(relPath).toLowerCase();
      if (!ENTRYPOINT_EXTENSIONS.has(ext)) return false;
      const segments = relPath.split("/");
      const hasDirHint = segments.some((segment) => ENTRYPOINT_DIR_HINTS.has(segment.toLowerCase()));
      const baseTokens = tokenize(relPath.replace(ext, ""));
      const hasOperationalToken = baseTokens.some((token) => OPERATIONAL_VERBS.includes(token) || token === "runner");
      return hasDirHint || hasOperationalToken;
    });
}

function buildEntrypointProfiles(cwd, goalText) {
  const goalTokens = significantTokens(goalText);
  return listEntrypoints(cwd)
    .map((relPath) => {
      const ext = extname(relPath).toLowerCase();
      const pathWithoutExt = relPath.slice(0, -ext.length);
      const tokens = tokenize(pathWithoutExt);
      const capability = inferCapability(tokens);
      const systems = inferSystems(tokens);
      const entityTokens = inferEntityTokens(tokens, capability, systems);
      const entityPhraseHint = entityTokens.length > 0 ? entityTokens.slice(0, 4).join(" ") : null;
      const matchedGoalTokens = goalTokens.filter((token) => tokens.includes(token));
      const segments = relPath.split("/");
      const score =
        matchedGoalTokens.length * 5 +
        (segments.some((segment) => ENTRYPOINT_DIR_HINTS.has(segment.toLowerCase())) ? 2 : 0) +
        (systems.length * 2) +
        capability.score;

      return {
        path: relPath,
        purpose: `Candidate flow entry point from ${relPath}`,
        tokens,
        matched_goal_tokens: matchedGoalTokens,
        capability_id: capability.id,
        capability_verbs: capability.verbs,
        capability_nouns: capability.nouns,
        systems,
        entity_tokens: entityTokens,
        entity_phrase_hint: entityPhraseHint,
        entity_id_hint: entityPhraseHint ? normalizeId(entityPhraseHint, "entity") : null,
        score,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function loadPlanHistory(cwd, currentGoal) {
  const { plansDir } = getPaths(cwd, skillPath);
  if (!existsSync(plansDir)) return [];

  return readdirSync(plansDir)
    .filter((entry) => entry.startsWith("plan_"))
    .sort()
    .reverse()
    .map((planDirName) => {
      const planDir = join(plansDir, planDirName);
      const stateJson = safeReadJson(join(planDir, "state.json"));
      const planContent = readFile(join(planDir, "plan.md")) || "";
      const goal = stateJson?.goal || extractGoalFromPlanContent(planContent);
      if (!goal || goal === currentGoal) return null;
      const score = overlapsTokens(goal, currentGoal);
      return {
        plan: planDirName,
        goal,
        score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.plan.localeCompare(b.plan))
    .slice(0, 5);
}

async function loadPersonaContext(cwd) {
  const auditConfig = loadAuditConfig(cwd);
  if (!auditConfig) {
    return {
      present: false,
      configured_roles: [],
      effective_roles: [],
      findings: [],
    };
  }

  const configuredRoles = Array.isArray(auditConfig.roles)
    ? uniqueList(auditConfig.roles)
    : ["core"];
  let packs = await loadRolePacks(auditConfig, skillPath, cwd);
  const context = await buildProjectContext(cwd, skillPath, auditConfig);
  packs = await enforceMinimumPersona(packs, context);
  const findings = await runRoleAuditors(context, packs);

  return {
    present: true,
    configured_roles: configuredRoles,
    effective_roles: uniqueList(["core", ...packs.map((pack) => pack.id).filter(Boolean)]),
    findings: findings
      .filter((finding) => finding && typeof finding === "object")
      .map((finding) => ({
        analyzer: finding.analyzer || "unknown",
        severity: finding.severity || "info",
        message: finding.message || "",
        location: typeof finding.location === "string" ? finding.location : null,
      })),
  };
}

function loadStoryRegistry(cwd) {
  return safeReadJson(join(cwd, "reports", "user_story_audit", "story_registry.json"));
}

function loadOntologyContext(cwd) {
  const serializerPath = join(scriptDir, "ontology_serializer.mjs");
  const result = spawnSync(process.execPath, [serializerPath, "--json", "--dir", cwd], {
    cwd,
    encoding: "utf-8",
    timeout: 20_000,
  });

  if (result.status !== 0) {
    return {
      available: false,
      meta: {},
      facts: [],
      error: (result.stderr || result.stdout || "ontology_serializer failed").trim(),
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return {
      available: true,
      meta: parsed?.meta && typeof parsed.meta === "object" ? parsed.meta : {},
      facts: Array.isArray(parsed?.facts) ? parsed.facts : [],
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      meta: {},
      facts: [],
      error: error.message,
    };
  }
}

function buildDiscoveryCandidates({ goalText, profiles, requestHistory, personaContext, ontologyContext, storyRegistry }) {
  const groups = new Map();
  const capabilityEntityStats = buildCapabilityEntityStats(profiles.slice(0, 20));
  for (const profile of profiles.slice(0, 20)) {
    const groupEntityKey = profile.entity_id_hint || `systems:${profile.systems.join("+") || "generic"}`;
    const groupKey = `${profile.capability_id}::${groupEntityKey}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(profile);
  }

  const candidates = [];
  for (const [, groupProfiles] of groups.entries()) {
    const sortedProfiles = [...groupProfiles].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const primary = sortedProfiles[0];
    const capabilityId = primary.capability_id;
    const groupEntityHints = uniqueList(sortedProfiles.map((profile) => profile.entity_phrase_hint).filter(Boolean));
    const multipleEntityGroups = (capabilityEntityStats.get(capabilityId)?.size || 0) > 1;
    const matchedHistory = requestHistory
      .filter((entry) => {
        if (entry.score <= 0) return false;
        const entityOverlap = groupEntityHints.some((hint) => {
          const overlapCount = overlapsTokens(entry.goal, hint);
          const hintTokenCount = significantTokens(hint).length;
          return overlapCount >= Math.min(2, hintTokenCount || 1);
        });
        if (groupEntityHints.length > 0 && multipleEntityGroups) return entityOverlap;
        return entityOverlap || overlapsTokens(entry.goal, capabilityId) > 0 || overlapsTokens(entry.goal, primary.path) > 0;
      })
      .slice(0, 3);
    const entityPhrase = pickEntityPhrase(goalText, matchedHistory.map((entry) => entry.goal), groupEntityHints);
    const entityId = entityPhrase ? normalizeId(entityPhrase, "entity") : null;
    const entityTitle = entityPhrase ? titleFromId(entityId) : "";
    const triggerHints = buildTriggerHints({
      verbs: primary.capability_verbs,
      nouns: primary.capability_nouns,
    });
    const matchedStories = Array.isArray(storyRegistry?.stories)
      ? storyRegistry.stories
          .filter((story) => Array.isArray(story.code_refs) && story.code_refs.some((ref) => sortedProfiles.some((profile) => pathMatchesRef(ref, profile.path))))
          .map((story) => ({
            id: story.id,
            title: story.title || "",
            status: story.status || "UNKNOWN",
          }))
      : [];
    const matchedPersonaFindings = personaContext.findings
      .filter((finding) => {
        if (finding.location && sortedProfiles.some((profile) => pathMatchesRef(finding.location, profile.path))) return true;
        return overlapsTokens(finding.message, `${capabilityId} ${sortedProfiles.map((profile) => profile.path).join(" ")}`) > 0;
      })
      .slice(0, 3);
    const searchedSurfaces = ["repo_entrypoints"];
    if (matchedHistory.length > 0) searchedSurfaces.push("request_history");
    if (personaContext.effective_roles.length > 0) searchedSurfaces.push("personas");
    if (matchedStories.length > 0 || ontologyContext.available) searchedSurfaces.push("ontology");
    const systems = uniqueList(sortedProfiles.flatMap((profile) => profile.systems));
    const recipeIdGuess = normalizeRecipeId(capabilityId, "recipe");
    const runnerHint = inferRunnerHint(primary.path);
    const score = sortedProfiles.reduce((sum, profile) => sum + profile.score, 0)
      + matchedHistory.length * 3
      + matchedStories.length * 2
      + matchedPersonaFindings.length;
    const confidence = score >= 18 ? "high" : score >= 10 ? "medium" : "low";

    candidates.push({
      id: normalizeId(`${capabilityId}_${entityId || primary.path.replace(/[/.]/g, "_")}`, "candidate"),
      title: entityTitle ? `${titleFromId(capabilityId)} for ${entityTitle}` : titleFromId(capabilityId),
      status: "review_required",
      capability_id_guess: capabilityId,
      recipe_id_guess: recipeIdGuess,
      entity_id_guess: entityId,
      entity_title_guess: entityTitle || null,
      systems,
      skills: systems,
      workflows: [],
      required_params_guess: entityId ? ["entity_id"] : [],
      trigger_hints: triggerHints,
      scripts: sortedProfiles.slice(0, 4).map((profile) => ({
        path: profile.path,
        purpose: profile.purpose,
        score: profile.score,
        matched_goal_tokens: profile.matched_goal_tokens,
      })),
      matched_request_history: matchedHistory,
      matched_story_refs: matchedStories,
      matched_persona_findings: matchedPersonaFindings,
      ontology_hints: {
        evidence: uniqueList([
          ontologyContext.available ? `ontology_loaded:${ontologyContext.meta.goals || 0}:${ontologyContext.meta.recipe_contracts || 0}` : "",
          matchedStories.length > 0 ? `story_refs:${matchedStories.map((story) => story.id).join(",")}` : "",
        ]).filter(Boolean),
      },
      searched_surfaces: searchedSurfaces,
      search_status: searchedSurfaces.length >= 3 ? "multi_surface" : "repo_only",
      score,
      confidence,
      goal_examples: uniqueList([goalText, ...matchedHistory.map((entry) => entry.goal)]),
      runner_hint: runnerHint,
      review: {
        decision: "pending",
        canonical_recipe_id: recipeIdGuess,
        canonical_capability_id: capabilityId,
        canonical_entity_id: entityId,
        canonical_entity_title: entityTitle || null,
        aliases: entityTitle ? [entityTitle] : [],
        required_params: entityId ? ["entity_id"] : [],
        trigger_hints: triggerHints,
        runner: null,
        notes: "",
        merge_with: [],
        split_into: [],
      },
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Number(readFlagValue("--limit")) || 5);
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Recipe Discovery Review");
  lines.push("");
  lines.push(`- Goal: \`${report.goal || "(not provided)"}\``);
  lines.push(`- Goal source: \`${report.goal_source}\``);
  lines.push(`- Recipe route: \`${report.recipe_resolution?.primary_resolution?.route || "unknown"}\``);
  lines.push(`- Entrypoints scanned: \`${report.context.repo_entrypoints_scanned}\``);
  lines.push(`- Persona roles: ${report.context.personas.effective_roles.length > 0 ? report.context.personas.effective_roles.map((role) => `\`${role}\``).join(", ") : "none"}`);
  lines.push(`- Ontology available: \`${report.context.ontology.available ? "yes" : "no"}\``);
  lines.push("");
  lines.push("Review rule: update the `review` block in `recipes/discovery_review.json`, set `decision` to `approved`, and only then run `/recipe-bootstrap` or `recipe_bootstrap.mjs --from-discovery`.");
  lines.push("");

  if (report.candidates.length === 0) {
    lines.push("No candidate flows found. Broaden the goal wording or inspect repo entry points manually before bootstrapping recipes.");
    return `${lines.join("\n")}\n`;
  }

  for (const candidate of report.candidates) {
    lines.push(`## ${candidate.title}`);
    lines.push(`- Candidate ID: \`${candidate.id}\``);
    lines.push(`- Confidence: \`${candidate.confidence}\``);
    lines.push(`- Capability guess: \`${candidate.capability_id_guess}\``);
    lines.push(`- Recipe guess: \`${candidate.recipe_id_guess}\``);
    if (candidate.entity_id_guess) {
      lines.push(`- Entity guess: \`${candidate.entity_id_guess}\` (${candidate.entity_title_guess || "title pending"})`);
    }
    lines.push(`- Systems: ${candidate.systems.length > 0 ? candidate.systems.map((system) => `\`${system}\``).join(", ") : "none"}`);
    lines.push(`- Search surfaces: ${candidate.searched_surfaces.map((surface) => `\`${surface}\``).join(", ")}`);
    lines.push("");
    lines.push("### Scripts");
    for (const script of candidate.scripts) {
      lines.push(`- \`${script.path}\` (score=${script.score})`);
    }
    if (candidate.matched_request_history.length > 0) {
      lines.push("");
      lines.push("### Request History");
      for (const entry of candidate.matched_request_history) {
        lines.push(`- \`${entry.goal}\` from \`${entry.plan}\``);
      }
    }
    if (candidate.matched_story_refs.length > 0) {
      lines.push("");
      lines.push("### Story / Ontology Context");
      for (const story of candidate.matched_story_refs) {
        lines.push(`- \`${story.id}\` — ${story.title}`);
      }
    }
    if (candidate.matched_persona_findings.length > 0) {
      lines.push("");
      lines.push("### Persona Findings");
      for (const finding of candidate.matched_persona_findings) {
        lines.push(`- [${finding.severity}] ${finding.analyzer}: ${finding.message}`);
      }
    }
    lines.push("");
    lines.push("### Review Checklist");
    lines.push(`- decision: \`${candidate.review.decision}\``);
    lines.push(`- canonical_recipe_id: \`${candidate.review.canonical_recipe_id}\``);
    lines.push(`- canonical_capability_id: \`${candidate.review.canonical_capability_id}\``);
    if (candidate.review.canonical_entity_id) {
      lines.push(`- canonical_entity_id: \`${candidate.review.canonical_entity_id}\``);
    }
    lines.push(`- required_params: ${candidate.review.required_params.length > 0 ? candidate.review.required_params.map((param) => `\`${param}\``).join(", ") : "none"}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function toJsonPayload(report, outputs) {
  return {
    version: report.version,
    generated_at: report.generated_at,
    cwd: report.cwd,
    goal: report.goal,
    goal_source: report.goal_source,
    recipe_resolution: report.recipe_resolution,
    context: {
      repo_entrypoints_scanned: report.context.repo_entrypoints_scanned,
      request_history: report.context.request_history,
      personas: report.context.personas,
      ontology: {
        available: report.context.ontology.available,
        meta: report.context.ontology.meta,
        error: report.context.ontology.error,
      },
    },
    candidates: report.candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      status: candidate.status,
      capability_id_guess: candidate.capability_id_guess,
      recipe_id_guess: candidate.recipe_id_guess,
      entity_id_guess: candidate.entity_id_guess,
      entity_title_guess: candidate.entity_title_guess,
      systems: candidate.systems,
      skills: candidate.skills,
      workflows: candidate.workflows,
      required_params_guess: candidate.required_params_guess,
      scripts: candidate.scripts.map((script) => ({
        path: script.path,
        purpose: script.purpose,
        score: script.score,
        matched_goal_tokens: script.matched_goal_tokens,
      })),
      matched_request_history: candidate.matched_request_history,
      matched_story_refs: candidate.matched_story_refs,
      matched_persona_findings: candidate.matched_persona_findings,
      runner_hint: candidate.runner_hint,
      searched_surfaces: candidate.searched_surfaces,
      search_status: candidate.search_status,
      confidence: candidate.confidence,
      review: {
        decision: candidate.review.decision,
        canonical_recipe_id: candidate.review.canonical_recipe_id,
        canonical_capability_id: candidate.review.canonical_capability_id,
        canonical_entity_id: candidate.review.canonical_entity_id,
        canonical_entity_title: candidate.review.canonical_entity_title,
        aliases: candidate.review.aliases,
        required_params: candidate.review.required_params,
        trigger_hints: candidate.review.trigger_hints,
        runner: candidate.review.runner,
        notes: candidate.review.notes,
        merge_with: candidate.review.merge_with,
        split_into: candidate.review.split_into,
      },
    })),
    applied: flags.apply,
    outputs,
  };
}

function writeReportFiles(report, cwd) {
  const recipesDir = join(cwd, "recipes");
  mkdirSync(recipesDir, { recursive: true });
  const jsonPath = readFlagValue("--discovery-file")
    ? resolve(cwd, readFlagValue("--discovery-file"))
    : join(recipesDir, "discovery_review.json");
  const markdownPath = jsonPath.replace(/\.json$/i, ".md");

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, toMarkdown(report));

  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
  };
}

if (flags.help) {
  console.log(`recipe_discovery.mjs — Draft reviewable recipe proposals from a prompt or request before bootstrap

Usage:
  node recipe_discovery.mjs --goal "<goal>" --json
  node recipe_discovery.mjs --goal "<goal>" --apply --json
  node recipe_discovery.mjs --dir <path> --goal "<goal>"

Behavior:
  - turns a concrete prompt/request into proposed recipe candidates for review
  - scans repo entry points in scripts/jobs/tasks/bin-style paths
  - groups likely operational flows deterministically
  - enriches candidate flows with persona, ontology, and prior-request context
  - writes recipes/discovery_review.json and .md when --apply is used
`);
  process.exit(0);
}

async function main() {
  const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
  const explicitGoal = readFlagValue("--goal");
  const { plansDir } = getPaths(cwd, skillPath);
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
  const stateJson = !explicitGoal && target.planDir ? safeReadJson(join(target.planDir, "state.json")) : null;
  const planContent = !explicitGoal && target.planDir ? (readFile(join(target.planDir, "plan.md")) || "") : "";
  const goal = explicitGoal || stateJson?.goal || extractGoalFromPlanContent(planContent) || "";
  const goalSource = explicitGoal ? "cli" : (stateJson?.goal ? "state.json" : (planContent ? "plan.md" : "none"));

  const recipeResolution = resolveRecipeRequest({ cwd, goalText: goal });
  const profiles = buildEntrypointProfiles(cwd, goal);
  const requestHistory = loadPlanHistory(cwd, goal);
  const [personaContext, ontologyContext] = await Promise.all([
    loadPersonaContext(cwd),
    Promise.resolve(loadOntologyContext(cwd)),
  ]);
  const storyRegistry = loadStoryRegistry(cwd);
  const candidates = buildDiscoveryCandidates({
    goalText: goal,
    profiles,
    requestHistory,
    personaContext,
    ontologyContext,
    storyRegistry,
  });

  const report = {
    version: 1,
    generated_at: new Date().toISOString(),
    cwd,
    goal,
    goal_source: goalSource,
    recipe_resolution: recipeResolution,
    context: {
      repo_entrypoints_scanned: profiles.length,
      request_history: {
        matched: requestHistory,
      },
      personas: {
        present: personaContext.present,
        configured_roles: personaContext.configured_roles,
        effective_roles: personaContext.effective_roles,
        findings_considered: personaContext.findings.length,
      },
      ontology: {
        available: ontologyContext.available,
        meta: ontologyContext.meta,
        error: ontologyContext.error,
      },
    },
    candidates,
  };

  let outputs = null;
  if (flags.apply) {
    outputs = writeReportFiles(report, cwd);
  }

  const payload = toJsonPayload(report, outputs);

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  console.log("Recipe Discovery");
  console.log(`Goal: ${goal || "(not provided)"}`);
  console.log(`Route: ${recipeResolution?.primary_resolution?.route || "unknown"}`);
  console.log(`Entrypoints scanned: ${profiles.length}`);
  console.log(`Candidates: ${candidates.length}`);
  if (candidates[0]) {
    console.log(`Top candidate: ${candidates[0].title} (${candidates[0].id})`);
  }
  if (flags.apply && outputs) {
    console.log(`Wrote: ${outputs.json_path}`);
    console.log(`Wrote: ${outputs.markdown_path}`);
  } else {
    console.log("Dry preview only. Re-run with --apply to write discovery_review artifacts.");
  }
}

await main();
