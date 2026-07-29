// recipe_utils.mjs — Deterministic recipe/entity/capability resolution helpers.
//
// Host-project convention:
//   recipes/entity_registry.json
//   recipes/capability_registry.json
//   recipes/<recipe-id>/recipe.json

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { buildRecipeWorkOrder, validateWorkOrder } from "./work_order_contract.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const LEGACY_RECIPE_NOTICE = "legacy runner.json accepted as a read-only recipe surface; promote to canonical recipe.json before work-order execution.";

const OPERATIONAL_VERB_REGEX = /\b(get|fetch|list|show|retrieve|find|pull|sync|reconcile|align|export|import|update|run|generate|collect)\b/i;
const OPERATIONAL_NOUN_REGEX = /\b(participants|attendees|registrants|contacts|leads|crm|pipeline|funnel|eventbrite|dataset|report|daily\s+runner|walk\s+forward|backfill|retrain|portfolio)\b/i;
const RANKED_RECIPE_RESOLVER_STRATEGY = "ranked_bm25_graph_v1";
const LEGACY_RECIPE_RESOLVER_STRATEGY = "exact_alias_regex_v1";
const MIN_ENTITY_SCORE = 1.2;
const MIN_CAPABILITY_SCORE = 2.4;

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "i", "in", "into",
  "me", "my", "of", "on", "or", "our", "please", "the", "this", "to", "with",
]);

const SEMANTIC_TOKEN_GROUPS = [
  ["participant", "participants", "attendee", "attendees", "registrant", "registrants", "people", "roster"],
  ["export", "extract", "pull", "retrieve", "collect", "list", "show", "download"],
  ["walk", "forward", "walkforward", "wfo", "cpcv", "split", "validation"],
  ["portfolio", "allocation", "basket", "blend", "ensemble", "meta"],
  ["crawl", "crawler", "scrape", "scraper", "extractor", "extract", "page", "pages", "site", "sites"],
  ["trading", "strategy", "strategies", "research", "scientist", "evolution", "experiment"],
  ["machine", "learning", "ml", "model", "models", "overfit", "overfitting", "leakage", "feature", "features"],
];

const SEMANTIC_EXPANSIONS = SEMANTIC_TOKEN_GROUPS.reduce((map, group) => {
  for (const token of group) {
    map.set(token, new Set(group));
  }
  return map;
}, new Map());

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readJsonWithError(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf-8")), error: null };
  } catch (err) {
    return { ok: false, value: null, error: err.message };
  }
}

function normalizeString(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function uniqueList(values) {
  return [...new Set(normalizeList(values))];
}

function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entryValue]) => typeof key === "string" && key.trim() && typeof entryValue === "string" && entryValue.trim())
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
  );
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchNormalizedPhrase(normalizedGoal, alias) {
  const normalizedAlias = normalizeString(alias);
  if (!normalizedAlias) return false;
  const pattern = new RegExp(`(?:^| )${escapeRegex(normalizedAlias)}(?: |$)`, "i");
  return pattern.test(` ${normalizedGoal} `);
}

function stemToken(token) {
  const text = String(token || "").trim().toLowerCase();
  if (text.length <= 4) return text;
  return text
    .replace(/ies$/, "y")
    .replace(/ing$/, "")
    .replace(/ers$/, "er")
    .replace(/ees$/, "ee")
    .replace(/s$/, "");
}

function tokenize(value) {
  return normalizeString(value)
    .split(" ")
    .map(stemToken)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function expandTokenSet(tokens) {
  const expanded = new Set();
  for (const token of tokens) {
    const stemmed = stemToken(token);
    if (!stemmed) continue;
    expanded.add(stemmed);
    const group = SEMANTIC_EXPANSIONS.get(stemmed);
    if (group) {
      for (const synonym of group) expanded.add(stemToken(synonym));
    }
  }
  return expanded;
}

function goalSignal(goalText) {
  const tokens = tokenize(goalText);
  return {
    normalized: normalizeString(goalText),
    tokens,
    expanded: expandTokenSet(tokens),
  };
}

function normalizeRegexPatternText(pattern) {
  return normalizeString(String(pattern || "")
    .replace(/\(\?<[^>]+>[^)]+\)/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[\\^$.*+?()[\]{}|]/g, " "));
}

function scoreWeightedText(goal, weightedFields) {
  let score = 0;
  const matchedTerms = new Set();
  const matchedFields = [];

  for (const field of weightedFields) {
    const text = normalizeString(field.text);
    if (!text) continue;
    const weight = Number.isFinite(Number(field.weight)) ? Number(field.weight) : 1;
    const tokens = tokenize(text);
    const tokenSet = expandTokenSet(tokens);
    let overlap = 0;
    for (const token of goal.expanded) {
      if (tokenSet.has(token)) {
        overlap += 1;
        matchedTerms.add(token);
      }
    }
    const phraseHit = text.length > 2 && (` ${goal.normalized} `.includes(` ${text} `) || ` ${text} `.includes(` ${goal.normalized} `));
    const fieldScore = (overlap * weight) + (phraseHit ? weight * 3 : 0);
    if (fieldScore > 0) {
      score += fieldScore;
      matchedFields.push({
        field: field.field || "text",
        score: Number(fieldScore.toFixed(4)),
      });
    }
  }

  return {
    score: Number(score.toFixed(4)),
    matched_terms: [...matchedTerms].sort(),
    matched_fields: matchedFields.sort((a, b) => b.score - a.score || a.field.localeCompare(b.field)),
  };
}

function sortedWeightedValues(values, field, weight) {
  return uniqueList(values).map((text) => ({ field, text, weight }));
}

function extractRegexValue(pattern, goalText) {
  if (typeof pattern !== "string" || !pattern.trim()) return null;
  try {
    const regex = new RegExp(pattern, "i");
    const match = regex.exec(goalText);
    if (!match) return null;
    if (match.groups?.value && String(match.groups.value).trim()) return String(match.groups.value).trim();
    for (let i = 1; i < match.length; i++) {
      if (typeof match[i] === "string" && match[i].trim()) return match[i].trim();
    }
  } catch {
    return null;
  }
  return null;
}

function getRecipePaths(cwd) {
  const recipesDir = join(cwd, "recipes");
  return {
    recipesDir,
    entityRegistryPath: join(recipesDir, "entity_registry.json"),
    capabilityRegistryPath: join(recipesDir, "capability_registry.json"),
  };
}

function hasConfiguredRecipeSurface(recipesDir, entityRegistryPath, capabilityRegistryPath) {
  if (existsSync(entityRegistryPath) || existsSync(capabilityRegistryPath)) return true;
  if (!existsSync(recipesDir)) return false;

  try {
    return readdirSync(recipesDir).some((entry) => existsSync(join(recipesDir, entry, "recipe.json")));
  } catch {
    return false;
  }
}

function normalizeRunnerSpec(runner) {
  if (!runner || typeof runner !== "object" || Array.isArray(runner)) return null;
  const type = typeof runner.type === "string" ? runner.type.trim().toLowerCase() : "";
  if (type !== "command") return null;

  const command = Array.isArray(runner.command)
    ? runner.command
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
    : [];

  const cwd = typeof runner.cwd === "string" && runner.cwd.trim() ? runner.cwd.trim() : ".";

  return {
    type,
    cwd,
    command,
    defaults: normalizeStringMap(runner.defaults),
    dry_run_flags: uniqueList(runner.dry_run_flags),
    live_flags: uniqueList(runner.live_flags),
    ready: command.length > 0,
  };
}

function normalizeSurfaceRunnerSpec(runner, { legacy = false } = {}) {
  if (typeof runner === "string" && runner.trim()) {
    return {
      type: "python",
      cwd: ".",
      command: ["python", runner.trim()],
      defaults: {},
      dry_run_flags: [],
      live_flags: [],
      ready: true,
    };
  }

  if (!runner || typeof runner !== "object" || Array.isArray(runner)) return null;
  const type = typeof runner.type === "string" && runner.type.trim()
    ? runner.type.trim().toLowerCase()
    : (legacy ? "python" : "command");
  const command = Array.isArray(runner.command)
    ? runner.command
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
    : typeof runner.command === "string" && runner.command.trim()
      ? [runner.command.trim()]
      : [];
  const cwd = typeof runner.cwd === "string" && runner.cwd.trim() ? runner.cwd.trim() : ".";

  return {
    type,
    cwd,
    command,
    defaults: normalizeStringMap(runner.defaults),
    dry_run_flags: uniqueList(runner.dry_run_flags),
    live_flags: uniqueList(runner.live_flags),
    ready: command.length > 0,
  };
}

function normalizeParameterNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, param]) => param?.required === true)
    .map(([name]) => name)
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim());
}

function pathLooksLikeRecipesDir(targetDir) {
  if (!existsSync(targetDir)) return false;
  try {
    return readdirSync(targetDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      return existsSync(join(targetDir, entry.name, "recipe.json")) ||
        existsSync(join(targetDir, entry.name, "runner.json"));
    });
  } catch {
    return false;
  }
}

function resolveRecipeSurfacePaths(targetDir) {
  const nestedRecipesDir = join(targetDir, "recipes");
  const recipesDir = existsSync(nestedRecipesDir) ? nestedRecipesDir : targetDir;
  return {
    root_dir: targetDir,
    recipes_dir: recipesDir,
    entity_registry_path: join(recipesDir, "entity_registry.json"),
    capability_registry_path: join(recipesDir, "capability_registry.json"),
    usable: pathLooksLikeRecipesDir(recipesDir) || existsSync(join(recipesDir, "entity_registry.json")) || existsSync(join(recipesDir, "capability_registry.json")),
  };
}

function listRecipeSurfaceDirs(recipesDir) {
  try {
    return readdirSync(recipesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        id: entry.name,
        dir: join(recipesDir, entry.name),
        recipe_json_path: join(recipesDir, entry.name, "recipe.json"),
        runner_json_path: join(recipesDir, entry.name, "runner.json"),
      }))
      .filter((entry) => existsSync(entry.recipe_json_path) || existsSync(entry.runner_json_path))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

function validateRecipeId(value, issues, path = "id") {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${path} must be a non-empty string`);
    return false;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.trim())) {
    issues.push(`${path} must match /^[a-z0-9][a-z0-9-]*$/`);
    return false;
  }
  return true;
}

function validateCapabilityId(value, issues, path = "capability_id") {
  if (typeof value !== "string" || !value.trim()) return true;
  if (!/^[a-z][a-z0-9_]*$/.test(value.trim())) {
    issues.push(`${path} must match /^[a-z][a-z0-9_]*$/`);
    return false;
  }
  return true;
}

function assessWorkOrderProfile(normalized, variant) {
  if (variant !== "canonical_recipe_json") {
    return {
      status: "SKIP",
      valid: false,
      reason: "legacy runner.json remains read-compatible but is not promoted until canonical recipe.json exists",
      error_codes: [],
    };
  }

  const workOrder = buildRecipeWorkOrder(normalized);
  const result = validateWorkOrder(workOrder);
  return {
    status: result.ok ? "PASS" : "FAIL",
    valid: result.ok,
    work_order_id: workOrder.id,
    profile_type: workOrder.profile?.type || null,
    error_codes: (result.errors || []).map((issue) => issue.code),
    errors: result.errors || [],
  };
}

function normalizeCanonicalRecipeSurface(entry) {
  const parsed = readJsonWithError(entry.recipe_json_path);
  if (!parsed.ok) {
    return {
      id: entry.id,
      path: entry.recipe_json_path,
      variant: "canonical_recipe_json",
      valid: false,
      issues: [`recipe.json parse failed: ${parsed.error}`],
      info: [],
      normalized: null,
      work_order_profile: { status: "FAIL", valid: false, error_codes: ["recipe_json_parse_failed"] },
    };
  }

  const recipe = parsed.value || {};
  const issues = [];
  const id = typeof recipe.id === "string" && recipe.id.trim() ? recipe.id.trim() : entry.id;
  validateRecipeId(id, issues);
  validateCapabilityId(recipe.capability_id, issues);
  const runner = normalizeSurfaceRunnerSpec(recipe.runner);
  if (!runner?.ready) issues.push("runner must be a command runner with a non-empty command");

  const normalized = {
    present: true,
    recipe_id: id,
    recipe_dir: `recipes/${entry.id}`,
    recipe_json_path: entry.recipe_json_path,
    title: typeof recipe.title === "string" ? recipe.title.trim() : "",
    capability_id: typeof recipe.capability_id === "string" ? recipe.capability_id.trim() : "",
    required_params: uniqueList(recipe.required_params),
    scripts: Array.isArray(recipe.scripts) ? recipe.scripts : [],
    skills: uniqueList(recipe.skills),
    workflows: uniqueList(recipe.workflows),
    entity_ids: uniqueList(recipe.entity_ids),
    systems: uniqueList(recipe.systems),
    runner,
    runner_present: !!runner?.ready,
  };

  return {
    id,
    path: entry.recipe_json_path,
    variant: "canonical_recipe_json",
    valid: issues.length === 0,
    issues,
    info: [],
    normalized,
    work_order_profile: assessWorkOrderProfile(normalized, "canonical_recipe_json"),
  };
}

function normalizeLegacyRecipeSurface(entry) {
  const parsed = readJsonWithError(entry.runner_json_path);
  if (!parsed.ok) {
    return {
      id: entry.id,
      path: entry.runner_json_path,
      variant: "legacy_runner_json",
      valid: false,
      issues: [`runner.json parse failed: ${parsed.error}`],
      info: [LEGACY_RECIPE_NOTICE],
      normalized: null,
      work_order_profile: { status: "FAIL", valid: false, error_codes: ["runner_json_parse_failed"] },
    };
  }

  const recipe = parsed.value || {};
  const issues = [];
  const id = typeof recipe.recipe_id === "string" && recipe.recipe_id.trim() ? recipe.recipe_id.trim() : entry.id;
  validateRecipeId(id, issues, "recipe_id");
  const runner = normalizeSurfaceRunnerSpec(recipe.runner, { legacy: true });
  if (!runner?.ready) issues.push("legacy runner.json must declare a runnable command");
  const requiredParams = uniqueList([
    ...normalizeParameterNames(recipe.parameters),
    ...normalizeList(recipe.required_params),
  ]);

  const normalized = {
    present: true,
    recipe_id: id,
    recipe_dir: `recipes/${entry.id}`,
    recipe_json_path: null,
    legacy_runner_json_path: entry.runner_json_path,
    title: typeof recipe.title === "string" ? recipe.title.trim() : "",
    capability_id: typeof recipe.capability_id === "string" ? recipe.capability_id.trim() : "",
    required_params: requiredParams,
    scripts: Array.isArray(recipe.scripts) ? recipe.scripts : [],
    skills: uniqueList(recipe.skills || recipe.skills_used),
    workflows: uniqueList(recipe.workflows),
    entity_ids: uniqueList(recipe.entity_ids),
    systems: uniqueList(recipe.systems),
    runner,
    runner_present: !!runner?.ready,
  };

  return {
    id,
    path: entry.runner_json_path,
    variant: "legacy_runner_json",
    valid: issues.length === 0,
    issues,
    info: [LEGACY_RECIPE_NOTICE],
    normalized,
    work_order_profile: assessWorkOrderProfile(normalized, "legacy_runner_json"),
  };
}

function validateRegistryFile(path, label) {
  if (!existsSync(path)) {
    return { present: false, count: 0, issues: [], info: [`${label} not present`] };
  }
  const parsed = readJsonWithError(path);
  if (!parsed.ok) return { present: true, count: 0, issues: [`${label} parse failed: ${parsed.error}`], info: [] };
  const collectionName = label === "entity_registry" ? "entities" : "capabilities";
  const entries = Array.isArray(parsed.value?.[collectionName]) ? parsed.value[collectionName] : [];
  return { present: true, count: entries.length, issues: [], info: [] };
}

export function validateRecipeSurface(targetDir) {
  const paths = resolveRecipeSurfacePaths(targetDir);
  const entries = listRecipeSurfaceDirs(paths.recipes_dir);
  const recipes = entries.map((entry) => (
    existsSync(entry.recipe_json_path)
      ? normalizeCanonicalRecipeSurface(entry)
      : normalizeLegacyRecipeSurface(entry)
  ));
  const registryEntries = [
    validateRegistryFile(paths.entity_registry_path, "entity_registry"),
    validateRegistryFile(paths.capability_registry_path, "capability_registry"),
  ];
  const registryIssues = registryEntries.flatMap((entry) => entry.issues);
  const registryInfo = registryEntries.flatMap((entry) => entry.info);
  const invalidCount = recipes.filter((recipe) => !recipe.valid).length + registryIssues.length;
  const profileStatus = (recipe) => normalizeVerificationStatus(recipe.work_order_profile?.status, "execution");
  const profilePassCount = recipes.filter((recipe) =>
    verificationStatusIsPass(recipe.work_order_profile?.status, "execution")
  ).length;
  const profileSkipCount = recipes.filter((recipe) => {
    const status = profileStatus(recipe);
    return status.kind === "pending" && status.token !== "unknown";
  }).length;
  const profileFailCount = recipes.filter((recipe) => {
    const status = profileStatus(recipe);
    return !status.valid
      || status.token === "unknown"
      || (status.kind !== "pass" && status.kind !== "pending");
  }).length;

  return {
    schema_version: 1,
    root_dir: paths.root_dir,
    recipes_dir: paths.recipes_dir,
    recipe_count: recipes.length,
    valid_count: recipes.filter((recipe) => recipe.valid).length,
    invalid_count: invalidCount,
    legacy_count: recipes.filter((recipe) => recipe.variant === "legacy_runner_json").length,
    recipes,
    registry: {
      entity_registry_present: registryEntries[0].present,
      capability_registry_present: registryEntries[1].present,
      entity_count: registryEntries[0].count,
      capability_count: registryEntries[1].count,
      issues: registryIssues,
      info: registryInfo,
    },
    work_order_profile: {
      valid_count: profilePassCount,
      invalid_count: profileFailCount,
      skipped_count: profileSkipCount,
    },
  };
}

function looksOperationalRecipeRequest(goalText) {
  const text = String(goalText || "").trim();
  if (!text) return false;
  return OPERATIONAL_VERB_REGEX.test(text) && OPERATIONAL_NOUN_REGEX.test(text);
}

function normalizeEntity(entity) {
  return {
    id: typeof entity?.id === "string" ? entity.id.trim() : "",
    title: typeof entity?.title === "string" && entity.title.trim() ? entity.title.trim() : (typeof entity?.name === "string" ? entity.name.trim() : ""),
    aliases: uniqueList([entity?.id, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])]),
    systems: entity?.systems && typeof entity.systems === "object" ? entity.systems : {},
    recipe_ids: uniqueList(entity?.recipe_ids),
  };
}

function normalizeCapability(capability) {
  const triggers = Array.isArray(capability?.triggers)
    ? capability.triggers
        .map((trigger) => {
          if (typeof trigger === "string") return { pattern: trigger.trim(), weight: 1 };
          if (trigger && typeof trigger === "object" && typeof trigger.pattern === "string" && trigger.pattern.trim()) {
            return {
              pattern: trigger.pattern.trim(),
              weight: Number.isFinite(Number(trigger.weight)) ? Number(trigger.weight) : 1,
            };
          }
          return null;
        })
        .filter(Boolean)
    : [];

  const parameters = Array.isArray(capability?.parameters)
    ? capability.parameters
        .map((param) => {
          if (!param || typeof param !== "object") return null;
          const name = typeof param.name === "string" ? param.name.trim() : "";
          if (!name) return null;
          return {
            name,
            required: param.required === true,
            patterns: uniqueList(param.patterns),
          };
        })
        .filter(Boolean)
    : [];

  return {
    id: typeof capability?.id === "string" ? capability.id.trim() : "",
    title: typeof capability?.title === "string" && capability.title.trim() ? capability.title.trim() : (typeof capability?.name === "string" ? capability.name.trim() : ""),
    description: typeof capability?.description === "string" ? capability.description.trim() : "",
    triggers,
    parameters,
    recipe_ids: uniqueList(capability?.recipe_ids || capability?.recipes),
    required_params: uniqueList(capability?.required_params),
    scripts: Array.isArray(capability?.scripts) ? capability.scripts : [],
    skills: uniqueList(capability?.skills),
    supported_entities: uniqueList(capability?.supported_entities),
  };
}

export function loadRecipeDefinition(cwd, recipeId) {
  const recipeJsonPath = join(cwd, "recipes", recipeId, "recipe.json");
  if (!existsSync(recipeJsonPath)) {
    return {
      present: false,
      recipe_id: recipeId,
      recipe_dir: `recipes/${recipeId}`,
      recipe_json_path: recipeJsonPath,
      required_params: [],
      scripts: [],
      skills: [],
      entity_ids: [],
      runner: null,
      runner_present: false,
    };
  }

  const parsed = safeReadJson(recipeJsonPath) || {};
  const runner = normalizeRunnerSpec(parsed.runner);
  return {
    present: true,
    recipe_id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : recipeId,
    recipe_dir: `recipes/${recipeId}`,
    recipe_json_path: recipeJsonPath,
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    capability_id: typeof parsed.capability_id === "string" ? parsed.capability_id.trim() : "",
    required_params: uniqueList(parsed.required_params),
    scripts: Array.isArray(parsed.scripts) ? parsed.scripts : [],
    skills: uniqueList(parsed.skills),
    entity_ids: uniqueList(parsed.entity_ids),
    systems: uniqueList(parsed.systems),
    runner,
    runner_present: !!runner?.ready,
  };
}

function resolveEntitiesLegacy(entities, goalText) {
  const normalizedGoal = normalizeString(goalText);
  return entities
    .map((entity) => {
      const matchedAliases = entity.aliases.filter((alias) => matchNormalizedPhrase(normalizedGoal, alias));
      if (matchedAliases.length === 0) return null;
      const bestAliasLength = Math.max(...matchedAliases.map((alias) => normalizeString(alias).split(" ").length));
      return {
        id: entity.id,
        title: entity.title || entity.id,
        matched_aliases: matchedAliases,
        systems: entity.systems,
        recipe_ids: entity.recipe_ids,
        score: bestAliasLength * 10 + matchedAliases.length,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function resolveEntities(entities, goalText) {
  const goal = goalSignal(goalText);
  return entities
    .map((entity) => {
      const exactAliases = entity.aliases.filter((alias) => matchNormalizedPhrase(goal.normalized, alias));
      const systemValues = Object.entries(entity.systems || {}).flatMap(([key, value]) => [
        key,
        typeof value === "string" ? value : "",
      ]);
      const scored = scoreWeightedText(goal, [
        { field: "id", text: entity.id, weight: 2.5 },
        { field: "title", text: entity.title, weight: 3 },
        ...sortedWeightedValues(entity.aliases, "alias", 3.5),
        ...sortedWeightedValues(systemValues, "system", 1.2),
        ...sortedWeightedValues(entity.recipe_ids, "recipe_id", 1.5),
      ]);
      const exactBoost = exactAliases.length * 6;
      const score = Number((scored.score + exactBoost).toFixed(4));
      if (score < MIN_ENTITY_SCORE) return null;
      return {
        id: entity.id,
        title: entity.title || entity.id,
        matched_aliases: exactAliases.length > 0 ? exactAliases : entity.aliases.filter((alias) => {
          const aliasTokens = expandTokenSet(tokenize(alias));
          return [...goal.expanded].some((token) => aliasTokens.has(token));
        }),
        matched_terms: scored.matched_terms,
        matched_fields: scored.matched_fields,
        systems: entity.systems,
        recipe_ids: entity.recipe_ids,
        matched_by: exactAliases.length > 0 ? "exact_alias_or_ranked_text" : "ranked_text",
        score,
        relevance_score: score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function resolveCapabilitiesLegacy(capabilities, goalText) {
  return capabilities
    .map((capability) => {
      const matchedPatterns = [];
      let score = 0;
      for (const trigger of capability.triggers) {
        try {
          const regex = new RegExp(trigger.pattern, "i");
          if (regex.test(goalText)) {
            matchedPatterns.push(trigger.pattern);
            score += trigger.weight;
          }
        } catch {
          // Ignore invalid patterns so a single bad registry row does not break intake.
        }
      }
      if (matchedPatterns.length === 0) return null;

      const extractedParams = {};
      for (const param of capability.parameters) {
        for (const pattern of param.patterns) {
          const value = extractRegexValue(pattern, goalText);
          if (value) {
            extractedParams[param.name] = value;
            break;
          }
        }
      }

      return {
        id: capability.id,
        title: capability.title || capability.id,
        description: capability.description,
        matched_patterns: matchedPatterns,
        extracted_params: extractedParams,
        recipe_ids: capability.recipe_ids,
        required_params: capability.required_params,
        scripts: capability.scripts,
        skills: capability.skills,
        supported_entities: capability.supported_entities,
        score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function resolveCapabilities(capabilities, goalText) {
  const goal = goalSignal(goalText);
  return capabilities
    .map((capability) => {
      const triggerTexts = capability.triggers.map((trigger) => normalizeRegexPatternText(trigger.pattern)).filter(Boolean);
      const scored = scoreWeightedText(goal, [
        { field: "id", text: capability.id, weight: 2.5 },
        { field: "title", text: capability.title, weight: 4 },
        { field: "description", text: capability.description, weight: 2 },
        ...sortedWeightedValues(triggerTexts, "trigger_text", 1.8),
        ...sortedWeightedValues(capability.recipe_ids, "recipe_id", 2),
        ...sortedWeightedValues(capability.required_params, "required_param", 0.8),
        ...sortedWeightedValues(capability.skills, "skill", 1.5),
        ...sortedWeightedValues(capability.supported_entities, "supported_entity", 1.5),
        ...sortedWeightedValues(capability.scripts.map((script) => script?.path || script?.command || script?.id || ""), "script", 1),
      ]);
      if (scored.score < MIN_CAPABILITY_SCORE) return null;

      const extractedParams = {};
      for (const param of capability.parameters) {
        for (const pattern of param.patterns) {
          const value = extractRegexValue(pattern, goalText);
          if (value) {
            extractedParams[param.name] = value;
            break;
          }
        }
      }

      return {
        id: capability.id,
        title: capability.title || capability.id,
        description: capability.description,
        matched_patterns: [],
        matched_terms: scored.matched_terms,
        matched_fields: scored.matched_fields,
        extracted_params: extractedParams,
        recipe_ids: capability.recipe_ids,
        required_params: capability.required_params,
        scripts: capability.scripts,
        skills: capability.skills,
        supported_entities: capability.supported_entities,
        matched_by: "ranked_text_graph",
        score: scored.score,
        relevance_score: scored.score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function scoreRecipeDefinition(recipe, goalText) {
  if (!recipe?.present) return { score: 0, matched_terms: [], matched_fields: [] };
  const goal = goalSignal(goalText);
  return scoreWeightedText(goal, [
    { field: "recipe_id", text: recipe.recipe_id, weight: 2.5 },
    { field: "recipe_title", text: recipe.title, weight: 4 },
    { field: "capability_id", text: recipe.capability_id, weight: 1.5 },
    ...sortedWeightedValues(recipe.skills, "recipe_skill", 1.5),
    ...sortedWeightedValues(recipe.entity_ids, "recipe_entity", 1.2),
    ...sortedWeightedValues(recipe.systems, "recipe_system", 1.2),
    ...sortedWeightedValues(recipe.scripts.map((script) => script?.path || script?.command || script?.id || ""), "recipe_script", 1),
  ]);
}

function resolveRecipeCandidates(cwd, capabilityMatches, entityMatches, goalText) {
  const bestEntity = entityMatches[0] || null;

  return capabilityMatches.flatMap((capability) => {
    const recipeIds = capability.recipe_ids.length > 0 ? capability.recipe_ids : [capability.id];
    if (recipeIds.length === 0) return [];

    return recipeIds.map((recipeId) => {
      const recipe = loadRecipeDefinition(cwd, recipeId);
      const recipeScore = scoreRecipeDefinition(recipe, goalText);
      const resolvedParams = { ...capability.extracted_params };
      if (bestEntity) {
        if (!resolvedParams.entity) resolvedParams.entity = bestEntity.title || bestEntity.id;
        if (!resolvedParams.entity_id) resolvedParams.entity_id = bestEntity.id;
      }

      const requiredParams = uniqueList([
        ...recipe.required_params,
        ...capability.required_params,
      ]);
      const missingParams = requiredParams.filter((paramName) => !resolvedParams[paramName]);

      const entityAllowed = recipe.entity_ids.length === 0 ||
        !bestEntity ||
        recipe.entity_ids.includes("*") ||
        recipe.entity_ids.includes(bestEntity.id);

      return {
        recipe_id: recipe.recipe_id,
        recipe_dir: recipe.recipe_dir,
        recipe_present: recipe.present,
        runner_present: recipe.runner_present,
        runner: recipe.runner,
        capability_id: capability.id,
        capability_title: capability.title,
        entity_id: bestEntity?.id || null,
        entity_title: bestEntity?.title || null,
        entity_allowed: entityAllowed,
        matched_patterns: capability.matched_patterns,
        resolved_params: resolvedParams,
        missing_params: missingParams,
        scripts: recipe.scripts.length > 0 ? recipe.scripts : capability.scripts,
        skills: recipe.skills.length > 0 ? recipe.skills : capability.skills,
        systems: recipe.systems || [],
        matched_terms: uniqueList([
          ...(capability.matched_terms || []),
          ...(bestEntity?.matched_terms || []),
          ...(recipeScore.matched_terms || []),
        ]),
        matched_fields: [
          ...(capability.matched_fields || []),
          ...(bestEntity?.matched_fields || []),
          ...(recipeScore.matched_fields || []),
        ],
        matched_by: recipeScore.score > 0 ? "ranked_capability_entity_recipe_graph" : "ranked_capability_entity_graph",
        score: Number((capability.score + (bestEntity ? bestEntity.score : 0) + recipeScore.score + (recipe.present ? 5 : 0) - (missingParams.length * 2) - (entityAllowed ? 0 : 5)).toFixed(4)),
      };
    });
  }).sort((a, b) => b.score - a.score || a.recipe_id.localeCompare(b.recipe_id));
}

function choosePrimaryResolution(recipeCandidates, capabilityMatches, entityMatches, registryPresent, goalText) {
  const bestCandidate = recipeCandidates.find((candidate) => candidate.entity_allowed);
  if (bestCandidate) {
    const executeReady = bestCandidate.recipe_present && bestCandidate.runner_present && bestCandidate.missing_params.length === 0;
    return {
      route: executeReady ? "execute_known_recipe" : "recipe_tidy",
      reason: executeReady
        ? "A deterministic capability + entity match resolved to a concrete recipe folder with a valid runner contract and all required parameters."
        : bestCandidate.recipe_present && !bestCandidate.runner_present
          ? "A deterministic capability/entity match exists, but the recipe still needs a runner contract before execution is predictable."
          : "A deterministic capability/entity match exists, but the recipe still needs parameter capture or recipe-folder cleanup.",
      recipe_id: bestCandidate.recipe_id,
      capability_id: bestCandidate.capability_id,
      entity_id: bestCandidate.entity_id,
      missing_params: bestCandidate.missing_params,
      runner_present: bestCandidate.runner_present,
      confidence: executeReady ? "high" : "medium",
    };
  }

  const bestCapability = capabilityMatches[0] || null;
  if (bestCapability) {
    const bestEntity = entityMatches[0] || null;
    const missingParams = uniqueList([
      ...bestCapability.required_params,
      ...(bestEntity ? [] : ["entity_id"]),
    ]).filter(Boolean);
    return {
      route: "recipe_tidy",
      reason: "The request matches a known capability, but the project still needs an entity mapping, recipe folder, or required parameters.",
      recipe_id: bestCapability.recipe_ids[0] || bestCapability.id,
      capability_id: bestCapability.id,
      entity_id: bestEntity?.id || null,
      missing_params: missingParams,
      confidence: bestEntity ? "medium" : "low",
    };
  }

  if (!registryPresent && looksOperationalRecipeRequest(goalText)) {
    return {
      route: "recipe_discovery",
      reason: "No recipe registries are configured yet, but the request looks like a reusable operational flow that should be reviewed and consolidated into discovery candidates before bootstrap creates recipe artifacts.",
      recipe_id: null,
      capability_id: null,
      entity_id: null,
      missing_params: [],
      runner_present: false,
      confidence: "medium",
    };
  }

  if (!registryPresent) {
    return {
      route: "unconfigured",
      reason: "No recipe registries are configured for this project yet.",
      recipe_id: null,
      capability_id: null,
      entity_id: null,
      missing_params: [],
      runner_present: false,
      confidence: "low",
    };
  }

  return {
    route: "plan_build",
    reason: "No deterministic recipe match exists, so ordinary planner sizing should handle the request.",
    recipe_id: null,
    capability_id: null,
    entity_id: null,
    missing_params: [],
    runner_present: false,
    confidence: "low",
  };
}

function resolveRecipeRequestWithStrategy({ cwd, goalText, legacy = false }) {
  const { recipesDir, entityRegistryPath, capabilityRegistryPath } = getRecipePaths(cwd);
  const entityRegistry = safeReadJson(entityRegistryPath);
  const capabilityRegistry = safeReadJson(capabilityRegistryPath);

  const entities = Array.isArray(entityRegistry?.entities)
    ? entityRegistry.entities.map(normalizeEntity).filter((entity) => entity.id)
    : [];
  const capabilities = Array.isArray(capabilityRegistry?.capabilities)
    ? capabilityRegistry.capabilities.map(normalizeCapability).filter((capability) => capability.id)
    : [];

  const entityMatches = legacy
    ? resolveEntitiesLegacy(entities, goalText)
    : resolveEntities(entities, goalText);
  const capabilityMatches = legacy
    ? resolveCapabilitiesLegacy(capabilities, goalText)
    : resolveCapabilities(capabilities, goalText);
  const recipeCandidates = resolveRecipeCandidates(cwd, capabilityMatches, entityMatches, goalText);
  const primaryResolution = choosePrimaryResolution(
    recipeCandidates,
    capabilityMatches,
    entityMatches,
    hasConfiguredRecipeSurface(recipesDir, entityRegistryPath, capabilityRegistryPath),
    goalText
  );

  return {
    resolver: {
      strategy: legacy ? LEGACY_RECIPE_RESOLVER_STRATEGY : RANKED_RECIPE_RESOLVER_STRATEGY,
      candidate_gate: legacy ? "exact alias phrase or trigger regex" : "ranked entity/capability/recipe relevance",
      parameter_extraction: "capability parameter regexes remain extraction-only",
    },
    registry: {
      recipes_dir: recipesDir,
      entity_registry_path: entityRegistryPath,
      capability_registry_path: capabilityRegistryPath,
      entity_registry_present: !!entityRegistry,
      capability_registry_present: !!capabilityRegistry,
      entity_count: entities.length,
      capability_count: capabilities.length,
    },
    entities: entityMatches,
    capabilities: capabilityMatches,
    recipe_candidates: recipeCandidates,
    primary_resolution: primaryResolution,
  };
}

export function resolveRecipeRequest({ cwd, goalText }) {
  return resolveRecipeRequestWithStrategy({ cwd, goalText, legacy: false });
}

export function resolveRecipeRequestLegacy({ cwd, goalText }) {
  return resolveRecipeRequestWithStrategy({ cwd, goalText, legacy: true });
}

export function evaluateRankedRecipeResolverAgainstLegacy({ cwd, cases = [] }) {
  const rows = (Array.isArray(cases) ? cases : []).map((testCase, index) => {
    const goal = String(testCase?.goal || "").trim();
    const expectedRecipeId = String(testCase?.expected_recipe_id || "").trim();
    const legacyResolution = resolveRecipeRequestLegacy({ cwd, goalText: goal });
    const rankedResolution = resolveRecipeRequest({ cwd, goalText: goal });
    const legacyRecipeId = legacyResolution.primary_resolution?.recipe_id || null;
    const rankedRecipeId = rankedResolution.primary_resolution?.recipe_id || null;
    return {
      id: testCase?.id || `case_${index + 1}`,
      project_family: testCase?.project_family || testCase?.family || null,
      goal,
      expected_recipe_id: expectedRecipeId || null,
      legacy_route: legacyResolution.primary_resolution?.route || null,
      legacy_recipe_id: legacyRecipeId,
      legacy_score: legacyResolution.recipe_candidates?.[0]?.score || 0,
      legacy_hit: !!expectedRecipeId && legacyRecipeId === expectedRecipeId,
      ranked_route: rankedResolution.primary_resolution?.route || null,
      ranked_recipe_id: rankedRecipeId,
      ranked_score: rankedResolution.recipe_candidates?.[0]?.score || 0,
      ranked_hit: !!expectedRecipeId && rankedRecipeId === expectedRecipeId,
      ranked_matched_terms: rankedResolution.recipe_candidates?.[0]?.matched_terms || [],
    };
  });

  const families = new Set(rows.map((row) => row.project_family).filter(Boolean));
  const legacyHits = rows.filter((row) => row.legacy_hit).length;
  const rankedHits = rows.filter((row) => row.ranked_hit).length;

  return {
    schema_version: 1,
    strategy: RANKED_RECIPE_RESOLVER_STRATEGY,
    baseline_strategy: LEGACY_RECIPE_RESOLVER_STRATEGY,
    case_count: rows.length,
    project_family_count: families.size,
    legacy_top_1_hits: legacyHits,
    ranked_top_1_hits: rankedHits,
    ranked_beats_legacy: rankedHits > legacyHits,
    improvement: rankedHits - legacyHits,
    rows,
  };
}

export function resolvePrimaryRecipeCandidate(recipeResolution) {
  const recipeId = recipeResolution?.primary_resolution?.recipe_id;
  if (!recipeId) return null;
  return (recipeResolution?.recipe_candidates || []).find((candidate) => (
    candidate?.recipe_id === recipeId && candidate?.entity_allowed !== false
  )) || null;
}

export function applyRecipeResolutionToClassification(classification, recipeResolution) {
  const route = recipeResolution?.primary_resolution?.route;
  if (route === "recipe_discovery") {
    return {
      ...classification,
      workflow: {
        recommended: "/recipe-discovery",
        escalation_reason: "recipe_discovery_candidate",
        reason: "The request looks like a reusable operational flow, but this repo has no recipe registry yet. Discover and review candidate flows before bootstrapping the deterministic recipe surface.",
      },
      recovery: {
        mode: "start_recipe_discovery",
        reason: "Recipe registries do not exist yet for this project, and the request is operational enough to justify discovery and review before bootstrap.",
        command: "node .agent/skills/iterative-planner/scripts/recipe_discovery.mjs --goal \"<goal>\" --json",
      },
      escalation_reason: "recipe_discovery_candidate",
    };
  }

  if (route !== "execute_known_recipe" && route !== "recipe_tidy") return classification;

  const recommended = "/recipe-tidy";
  const executeReady = route === "execute_known_recipe";
  const escalationReason = executeReady ? "known_recipe_match" : "recipe_candidate_match";

  return {
    ...classification,
    workflow: {
      recommended,
      escalation_reason: escalationReason,
      reason: executeReady
        ? "A deterministic recipe match already exists, so use /recipe-tidy to execute or lightly adapt the known workflow before bootstrapping new planner work."
        : "A deterministic capability/entity match exists, but the request still needs recipe normalization. Use /recipe-tidy before deciding on code-change planning.",
    },
    recovery: {
      mode: executeReady ? "execute_known_recipe" : "start_recipe_tidy",
      reason: executeReady
        ? "A concrete recipe folder already exists for this request."
        : "The request is recipe-shaped, but the recipe registry or parameter capture still needs cleanup.",
      command: "node .agent/skills/iterative-planner/scripts/recipe_resolver.mjs --goal \"<goal>\" --json",
    },
    escalation_reason: escalationReason,
  };
}
