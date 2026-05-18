#!/usr/bin/env node
// recipe_bootstrap.mjs — Scaffold or repair deterministic recipe registries.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { resolveRecipeRequest } from "./lib/recipe_utils.mjs";

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

function readFlagValues(flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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

function normalizeRunnerSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
  const command = Array.isArray(value.command)
    ? value.command.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : [];
  if (type !== "command" || command.length === 0) return null;
  return {
    type,
    cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : ".",
    command,
    defaults: normalizeStringMap(value.defaults),
    dry_run_flags: uniqueList(value.dry_run_flags),
    live_flags: uniqueList(value.live_flags),
  };
}

function normalizeId(text, fallback, index = 0) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized && !/^\d/.test(normalized)) return normalized;
  return `${fallback}_${index + 1}`;
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

function normalizeScriptEntries(values) {
  return uniqueList(values).map((entry) => {
    const [pathPart, ...purposeParts] = entry.split("::");
    return {
      path: pathPart.trim(),
      purpose: purposeParts.join("::").trim() || "Linked by recipe bootstrap",
    };
  }).filter((entry) => entry.path);
}

function normalizeTriggerEntries(values) {
  return uniqueList(values).map((pattern) => ({ pattern, weight: 1 }));
}

function parseKeyValueEntries(values) {
  const output = {};
  for (const entry of uniqueList(values)) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!key || !value) continue;
    output[key] = value;
  }
  return output;
}

function inferRunnerCommand(scripts) {
  const primaryScript = scripts.find((entry) => typeof entry?.path === "string" && entry.path.trim())?.path?.trim();
  if (!primaryScript) return [];

  if (/\.(mjs|cjs|js)$/i.test(primaryScript)) return ["node", primaryScript];
  if (/\.py$/i.test(primaryScript)) return ["python3", primaryScript];
  if (/\.sh$/i.test(primaryScript)) return ["bash", primaryScript];
  return [];
}

function buildRunnerSpec({ scripts, options, existingRunner, seedRunner, allowInferredRunner = true }) {
  const normalizedExistingRunner = normalizeRunnerSpec(existingRunner);
  const normalizedSeedRunner = normalizeRunnerSpec(seedRunner);
  const baseRunner = normalizedExistingRunner || normalizedSeedRunner || {};
  const explicitBin = readFlagValue("--runner-bin");
  const explicitArgs = readFlagValues("--runner-arg");
  const explicitCommand = explicitBin ? [explicitBin, ...explicitArgs] : [];
  const existingCommand = Array.isArray(normalizedExistingRunner?.command)
    ? normalizedExistingRunner.command
    : [];
  const seedCommand = Array.isArray(normalizedSeedRunner?.command)
    ? normalizedSeedRunner.command
    : [];
  const inferredCommand = allowInferredRunner ? inferRunnerCommand(scripts) : [];
  const command = explicitCommand.length > 0
    ? explicitCommand
    : existingCommand.length > 0
      ? existingCommand
      : seedCommand.length > 0
        ? seedCommand
        : inferredCommand;

  if (command.length === 0) return null;

  return {
    type: "command",
    cwd: options.runnerCwd || (typeof baseRunner.cwd === "string" && baseRunner.cwd.trim() ? baseRunner.cwd.trim() : "."),
    command,
    defaults: {
      ...normalizeStringMap(baseRunner.defaults),
      ...parseKeyValueEntries(readFlagValues("--runner-default")),
    },
    dry_run_flags: uniqueList([...(Array.isArray(baseRunner.dry_run_flags) ? baseRunner.dry_run_flags : []), ...readFlagValues("--runner-dry-flag")]),
    live_flags: uniqueList([...(Array.isArray(baseRunner.live_flags) ? baseRunner.live_flags : []), ...readFlagValues("--runner-live-flag")]),
  };
}

function ensureRegistryShape(parsed, key) {
  if (parsed && typeof parsed === "object" && Array.isArray(parsed[key])) return parsed;
  return { version: 1, [key]: [] };
}

function loadDiscoveryCandidate(cwd) {
  const candidateId = readFlagValue("--from-discovery");
  if (!candidateId) return null;

  const discoveryPath = readFlagValue("--discovery-file")
    ? resolve(cwd, readFlagValue("--discovery-file"))
    : join(cwd, "recipes", "discovery_review.json");
  const parsed = safeReadJson(discoveryPath);
  if (!parsed || !Array.isArray(parsed.candidates)) {
    throw new Error(`Discovery review file is missing or invalid: ${discoveryPath}`);
  }

  const candidate = parsed.candidates.find((entry) => entry?.id === candidateId);
  if (!candidate) {
    throw new Error(`Discovery candidate '${candidateId}' not found in ${discoveryPath}`);
  }

  const review = candidate.review && typeof candidate.review === "object" ? candidate.review : {};
  const decision = typeof review.decision === "string" ? review.decision.trim().toLowerCase() : "pending";
  if (decision !== "approved") {
    throw new Error(`Discovery candidate '${candidateId}' is not approved yet (decision=${decision || "pending"})`);
  }

  return {
    path: discoveryPath,
    goalText: typeof parsed.goal === "string" && parsed.goal.trim()
      ? parsed.goal.trim()
      : (Array.isArray(candidate.goal_examples) ? candidate.goal_examples.find((entry) => typeof entry === "string" && entry.trim()) : "") || "",
    candidate,
    review,
  };
}

function buildSeedFromDiscovery(discovery) {
  if (!discovery?.candidate) return null;
  const candidate = discovery.candidate;
  const review = discovery.review || {};
  const triggerHints = Array.isArray(review.trigger_hints) && review.trigger_hints.length > 0
    ? review.trigger_hints
    : candidate.trigger_hints;

  return {
    recipeId: review.canonical_recipe_id || candidate.recipe_id_guess || null,
    recipeTitle: candidate.title || null,
    capabilityId: review.canonical_capability_id || candidate.capability_id_guess || null,
    capabilityTitle: review.canonical_capability_id ? titleFromId(review.canonical_capability_id) : titleFromId(candidate.capability_id_guess || ""),
    entityId: review.canonical_entity_id || candidate.entity_id_guess || null,
    entityTitle: review.canonical_entity_title || candidate.entity_title_guess || "",
    requiredParams: uniqueList(review.required_params || candidate.required_params_guess),
    aliases: uniqueList(review.aliases || (candidate.entity_title_guess ? [candidate.entity_title_guess] : [])),
    skills: uniqueList(candidate.skills),
    systems: uniqueList(candidate.systems),
    scripts: normalizeScriptEntries((candidate.scripts || []).map((script) => `${script.path || ""}::${script.purpose || ""}`)),
    triggers: normalizeTriggerEntries(triggerHints),
    runner: normalizeRunnerSpec(review.runner),
    allowInferredRunner: false,
  };
}

function buildScaffold({ cwd, goalText, resolution, options, seed }) {
  const primary = resolution.primary_resolution || {};
  const bestEntity = resolution.entities?.[0] || null;
  const bestCapability = resolution.capabilities?.[0] || null;
  const bestRecipe = resolution.recipe_candidates?.[0] || null;

  const recipeId = normalizeRecipeId(
    options.recipeId ||
    seed?.recipeId ||
    primary.recipe_id ||
    bestRecipe?.recipe_id ||
    goalText ||
    "recipe"
  );
  const capabilityId = normalizeId(
    options.capabilityId ||
    seed?.capabilityId ||
    primary.capability_id ||
    bestCapability?.id ||
    recipeId,
    "capability"
  );
  const entityId = options.entityId || seed?.entityId || primary.entity_id || bestEntity?.id || null;
  const entityTitle = options.entityTitle || seed?.entityTitle || bestEntity?.title || (entityId ? titleFromId(entityId) : "");
  const recipeTitle = options.recipeTitle || seed?.recipeTitle || bestRecipe?.recipe_id || titleFromId(recipeId);
  const capabilityTitle = options.capabilityTitle || seed?.capabilityTitle || bestCapability?.title || titleFromId(capabilityId);

  const defaultRequiredParams = seed
    ? seed.requiredParams || []
    : uniqueList([
        ...uniqueList(primary.missing_params),
        ...(entityId ? ["entity_id"] : []),
      ]);

  const requiredParams = uniqueList([
    ...readFlagValues("--required-param"),
    ...defaultRequiredParams,
  ]);
  const aliases = uniqueList([
    ...readFlagValues("--alias"),
    ...(seed?.aliases || []),
    ...(entityTitle ? [entityTitle] : []),
    ...(bestEntity?.matched_aliases || []),
  ]);
  const skills = uniqueList([
    ...readFlagValues("--skill"),
    ...(seed?.skills || []),
    ...(bestRecipe?.skills || []),
    ...(bestCapability?.skills || []),
  ]);
  const systems = uniqueList([
    ...readFlagValues("--system"),
    ...(seed?.systems || []),
    ...(bestRecipe?.systems || []),
  ]);
  const scripts = normalizeScriptEntries([
    ...readFlagValues("--script"),
    ...((seed?.scripts || []).map((entry) => `${entry.path || ""}::${entry.purpose || ""}`)),
    ...((bestRecipe?.scripts || []).map((entry) => `${entry.path || ""}::${entry.purpose || ""}`)),
    ...((bestCapability?.scripts || []).map((entry) => `${entry.path || ""}::${entry.purpose || ""}`)),
  ]);
  const triggers = normalizeTriggerEntries([
    ...readFlagValues("--trigger"),
    ...((seed?.triggers || []).map((trigger) => trigger.pattern || "")),
    ...((bestCapability?.matched_patterns || []).map((pattern) => pattern)),
  ]);
  const runner = buildRunnerSpec({
    scripts,
    options,
    existingRunner: bestRecipe?.runner || null,
    seedRunner: seed?.runner || null,
    allowInferredRunner: seed?.allowInferredRunner !== false,
  });

  const recipesDir = join(cwd, "recipes");
  const recipeDir = join(recipesDir, recipeId);
  const entityRegistryPath = join(recipesDir, "entity_registry.json");
  const capabilityRegistryPath = join(recipesDir, "capability_registry.json");
  const recipeJsonPath = join(recipeDir, "recipe.json");
  const readmePath = join(recipeDir, "README.md");
  const examplesPath = join(recipeDir, "examples.md");

  return {
    ids: { recipeId, capabilityId, entityId },
    titles: { recipeTitle, capabilityTitle, entityTitle },
    aliases,
    requiredParams,
    skills,
    systems,
    scripts,
    triggers,
    runner,
    paths: {
      recipesDir,
      recipeDir,
      entityRegistryPath,
      capabilityRegistryPath,
      recipeJsonPath,
      readmePath,
      examplesPath,
    },
    route: primary.route || "plan_build",
  };
}

function applyScaffold(scaffold) {
  const actions = [];
  const {
    ids,
    titles,
    aliases,
    requiredParams,
    skills,
    systems,
    scripts,
    triggers,
    runner,
    paths,
  } = scaffold;

  mkdirSync(paths.recipesDir, { recursive: true });
  mkdirSync(paths.recipeDir, { recursive: true });

  const entityRegistry = ensureRegistryShape(safeReadJson(paths.entityRegistryPath), "entities");
  const capabilityRegistry = ensureRegistryShape(safeReadJson(paths.capabilityRegistryPath), "capabilities");

  if (ids.entityId) {
    const existingEntity = entityRegistry.entities.find((entry) => entry?.id === ids.entityId);
    if (existingEntity) {
      existingEntity.title = existingEntity.title || titles.entityTitle;
      existingEntity.aliases = uniqueList([...(existingEntity.aliases || []), ...aliases]);
      existingEntity.recipe_ids = uniqueList([...(existingEntity.recipe_ids || []), ids.recipeId]);
      existingEntity.systems = existingEntity.systems && typeof existingEntity.systems === "object"
        ? existingEntity.systems
        : {};
      for (const system of systems) {
        if (!(system in existingEntity.systems)) existingEntity.systems[system] = {};
      }
      actions.push(`updated:${paths.entityRegistryPath}`);
    } else {
      entityRegistry.entities.push({
        id: ids.entityId,
        title: titles.entityTitle || titleFromId(ids.entityId),
        aliases,
        systems: Object.fromEntries(systems.map((system) => [system, {}])),
        recipe_ids: [ids.recipeId],
      });
      actions.push(`created:${paths.entityRegistryPath}`);
    }
  }

  const existingCapability = capabilityRegistry.capabilities.find((entry) => entry?.id === ids.capabilityId);
  if (existingCapability) {
    existingCapability.title = existingCapability.title || titles.capabilityTitle;
    existingCapability.description = existingCapability.description || "";
    existingCapability.triggers = Array.isArray(existingCapability.triggers)
      ? [...existingCapability.triggers]
      : [];
    for (const trigger of triggers) {
      if (!existingCapability.triggers.some((entry) => entry?.pattern === trigger.pattern)) {
        existingCapability.triggers.push(trigger);
      }
    }
    existingCapability.required_params = uniqueList([...(existingCapability.required_params || []), ...requiredParams]);
    existingCapability.recipe_ids = uniqueList([...(existingCapability.recipe_ids || []), ids.recipeId]);
    existingCapability.skills = uniqueList([...(existingCapability.skills || []), ...skills]);
    existingCapability.scripts = Array.isArray(existingCapability.scripts)
      ? [...existingCapability.scripts]
      : [];
    for (const script of scripts) {
      if (!existingCapability.scripts.some((entry) => entry?.path === script.path)) {
        existingCapability.scripts.push(script);
      }
    }
    existingCapability.supported_entities = uniqueList([
      ...(existingCapability.supported_entities || []),
      ...(ids.entityId ? [ids.entityId] : []),
    ]);
    actions.push(`updated:${paths.capabilityRegistryPath}`);
  } else {
    capabilityRegistry.capabilities.push({
      id: ids.capabilityId,
      title: titles.capabilityTitle || titleFromId(ids.capabilityId),
      description: "",
      triggers,
      parameters: requiredParams.map((paramName) => ({ name: paramName, required: true, patterns: [] })),
      required_params: requiredParams,
      recipe_ids: [ids.recipeId],
      skills,
      scripts,
      supported_entities: ids.entityId ? [ids.entityId] : [],
    });
    actions.push(`created:${paths.capabilityRegistryPath}`);
  }

  writeJson(paths.entityRegistryPath, entityRegistry);
  writeJson(paths.capabilityRegistryPath, capabilityRegistry);

  const recipeExisted = existsSync(paths.recipeJsonPath);
  const existingRecipe = safeReadJson(paths.recipeJsonPath) || {};
  const mergedRecipe = {
    id: existingRecipe.id || ids.recipeId,
    title: existingRecipe.title || titles.recipeTitle || titleFromId(ids.recipeId),
    capability_id: existingRecipe.capability_id || ids.capabilityId,
    entity_ids: uniqueList([...(existingRecipe.entity_ids || []), ...(ids.entityId ? [ids.entityId] : [])]),
    required_params: uniqueList([...(existingRecipe.required_params || []), ...requiredParams]),
    systems: uniqueList([...(existingRecipe.systems || []), ...systems]),
    scripts: Array.isArray(existingRecipe.scripts) && existingRecipe.scripts.length > 0
      ? existingRecipe.scripts
      : scripts,
    skills: uniqueList([...(existingRecipe.skills || []), ...skills]),
    ...(runner || existingRecipe.runner ? { runner: runner || existingRecipe.runner } : {}),
  };
  writeJson(paths.recipeJsonPath, mergedRecipe);
  actions.push(`${recipeExisted ? "updated" : "created"}:${paths.recipeJsonPath}`);

  if (!existsSync(paths.readmePath)) {
    writeFileSync(paths.readmePath, `# ${mergedRecipe.title}

## Purpose
Describe when this recipe should be used and what it returns.

## Canonical IDs
- Recipe: \`${mergedRecipe.id}\`
- Capability: \`${mergedRecipe.capability_id}\`
${mergedRecipe.entity_ids.length > 0 ? `- Entities: ${mergedRecipe.entity_ids.map((id) => `\`${id}\``).join(", ")}\n` : ""}
## Required Params
${mergedRecipe.required_params.length > 0 ? mergedRecipe.required_params.map((param) => `- \`${param}\``).join("\n") : "- None recorded yet"}

## Linked Scripts
${mergedRecipe.scripts.length > 0 ? mergedRecipe.scripts.map((script) => `- \`${script.path}\` — ${script.purpose || "Purpose TBD"}`).join("\n") : "- Add linked scripts here"}

## Runner
${mergedRecipe.runner ? `- Type: \`${mergedRecipe.runner.type}\`
- CWD: \`${mergedRecipe.runner.cwd || "."}\`
- Command: \`${(mergedRecipe.runner.command || []).join(" ")}\`
- Dry-run flags: ${(mergedRecipe.runner.dry_run_flags || []).length > 0 ? (mergedRecipe.runner.dry_run_flags || []).map((flag) => `\`${flag}\``).join(", ") : "none"}
- Live flags: ${(mergedRecipe.runner.live_flags || []).length > 0 ? (mergedRecipe.runner.live_flags || []).map((flag) => `\`${flag}\``).join(", ") : "none"}` : "- Add a deterministic runner contract here"}

## Skills
${mergedRecipe.skills.length > 0 ? mergedRecipe.skills.map((skill) => `- \`${skill}\``).join("\n") : "- Add related skills here"}
`);
    actions.push(`created:${paths.readmePath}`);
  }

  if (!existsSync(paths.examplesPath)) {
    writeFileSync(paths.examplesPath, `# Examples

## Request
${titles.entityTitle ? `Get participants for ${titles.entityTitle}` : "Describe the canonical request here"}

## Expected Resolution
- Recipe: \`${mergedRecipe.id}\`
- Capability: \`${mergedRecipe.capability_id}\`
- Route: execute_known_recipe or recipe_tidy

## Runner Preview
\`\`\`bash
node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe ${mergedRecipe.id} --json
\`\`\`
`);
    actions.push(`created:${paths.examplesPath}`);
  }

  return { actions, recipe: mergedRecipe };
}

if (flags.help) {
  console.log(`recipe_bootstrap.mjs — Scaffold deterministic recipe registries and folders

Usage:
  node recipe_bootstrap.mjs --goal "<goal>" --json
  node recipe_bootstrap.mjs --goal "<goal>" --apply
  node recipe_bootstrap.mjs --from-discovery <candidate-id> --apply --json
  node recipe_bootstrap.mjs --goal "<goal>" --recipe-id <id> --capability-id <id> [--entity-id <id>] [--apply]

Discovery handoff:
  --from-discovery <candidate-id>   Seed scaffold values from recipes/discovery_review.json
  --discovery-file <path>           Override the discovery review JSON path

Optional repeatable flags:
  --alias <text>
  --trigger <regex>
  --required-param <name>
  --skill <name>
  --system <name>
  --script <path::purpose>
  --runner-bin <bin>
  --runner-arg <token>
  --runner-default <key=value>
  --runner-dry-flag <token>
  --runner-live-flag <token>
  --runner-cwd <path>
`);
  process.exit(0);
}

const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
let discovery = null;
try {
  discovery = loadDiscoveryCandidate(cwd);
} catch (error) {
  console.error(`recipe_bootstrap: ${error.message}`);
  process.exit(2);
}
const seed = discovery ? buildSeedFromDiscovery(discovery) : null;
const goalText = readFlagValue("--goal") || discovery?.goalText || "";
const resolution = resolveRecipeRequest({ cwd, goalText });
const scaffold = buildScaffold({
  cwd,
  goalText,
  resolution,
  options: {
    recipeId: readFlagValue("--recipe-id"),
    recipeTitle: readFlagValue("--recipe-title"),
    capabilityId: readFlagValue("--capability-id"),
    capabilityTitle: readFlagValue("--capability-title"),
    entityId: readFlagValue("--entity-id"),
    entityTitle: readFlagValue("--entity-title"),
    runnerCwd: readFlagValue("--runner-cwd"),
  },
  seed,
});

let applyResult = null;
if (flags.apply) {
  applyResult = applyScaffold(scaffold);
}

const payload = {
  generated_at: new Date().toISOString(),
  cwd,
  goal: goalText,
  discovery: discovery
    ? {
        path: discovery.path,
        candidate_id: discovery.candidate?.id || null,
        decision: discovery.review?.decision || null,
      }
    : null,
  recipe_resolution: {
    primary_resolution: resolution.primary_resolution,
  },
  scaffold: {
    ids: scaffold.ids,
    titles: scaffold.titles,
    requiredParams: scaffold.requiredParams,
    skills: scaffold.skills,
    systems: scaffold.systems,
    scripts: scaffold.scripts,
    route: scaffold.route,
  },
  applied: flags.apply,
  apply_result: applyResult
    ? {
        actions: applyResult.actions,
        recipe: {
          id: applyResult.recipe?.id || null,
          capability_id: applyResult.recipe?.capability_id || null,
          entity_ids: applyResult.recipe?.entity_ids || [],
          required_params: applyResult.recipe?.required_params || [],
          runner_present: !!applyResult.recipe?.runner,
        },
      }
    : null,
};

if (flags.json) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log("Recipe Bootstrap");
console.log(`Goal: ${goalText || "(not provided)"}`);
console.log(`Suggested recipe: ${scaffold.ids.recipeId}`);
console.log(`Suggested capability: ${scaffold.ids.capabilityId}`);
if (scaffold.ids.entityId) {
  console.log(`Suggested entity: ${scaffold.ids.entityId}`);
}
if (discovery?.candidate?.id) {
  console.log(`Discovery candidate: ${discovery.candidate.id}`);
}
console.log(`Route: ${scaffold.route}`);
if (flags.apply) {
  console.log(`Applied actions: ${(applyResult?.actions || []).join(", ") || "none"}`);
} else {
  console.log("Dry preview only. Re-run with --apply to write files.");
}
