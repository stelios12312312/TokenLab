#!/usr/bin/env node
// recipe_fleet_audit.mjs — Read-only cross-project recipe adoption audit.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { validateRecipeSurface } from "./lib/recipe_utils.mjs";

const __filename = fileURLToPath(import.meta.url);

export const DEFAULT_FLEET_PROJECTS = Object.freeze([
  {
    name: "tesseract_automation_engine",
    path: "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/Executives course/tesseract-automation-engine",
  },
  {
    name: "ipbs_datapack_starter",
    path: "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Tennis/Sport betting/ipbs_datapack_starter",
  },
  {
    name: "evolution_trading_scientist",
    path: "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Metalos/evolution-trading-scientist",
  },
  {
    name: "crawler_extractor_agent",
    path: "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Courses/crawler-extractor-agent",
  },
]);

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function resolveConfigPath({ cwd = process.cwd(), configPath = null } = {}) {
  if (configPath) return isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
  const local = join(cwd, ".agent", "recipe_fleet.config.yaml");
  return existsSync(local) ? local : null;
}

function unquote(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

function parseProjectConfig(text, configDir) {
  const projects = [];
  let current = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim() === "projects:") continue;
    const itemMatch = line.match(/^\s*-\s+([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (itemMatch) {
      if (current) projects.push(current);
      current = {};
      current[itemMatch[1]] = unquote(itemMatch[2]);
      continue;
    }
    const keyMatch = line.match(/^\s+([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (keyMatch && current) {
      current[keyMatch[1]] = unquote(keyMatch[2]);
    }
  }
  if (current) projects.push(current);

  return projects
    .map((project, index) => {
      const name = project.name || `project_${index + 1}`;
      const rawPath = project.path || project.root || "";
      if (!rawPath) return null;
      return {
        name,
        path: isAbsolute(rawPath) ? rawPath : resolve(configDir, rawPath),
      };
    })
    .filter(Boolean);
}

export function loadFleetConfig({ cwd = process.cwd(), configPath = null } = {}) {
  const resolvedConfigPath = resolveConfigPath({ cwd, configPath });
  if (!resolvedConfigPath) {
    return {
      path: null,
      projects: DEFAULT_FLEET_PROJECTS.map((project) => ({ ...project })),
      source: "default",
    };
  }

  const text = readFileSync(resolvedConfigPath, "utf-8");
  const projects = parseProjectConfig(text, dirname(resolvedConfigPath));
  return {
    path: resolvedConfigPath,
    projects,
    source: "config",
  };
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function latestMtimeIso(paths) {
  const times = paths
    .map((path) => safeStat(path))
    .filter(Boolean)
    .map((stat) => stat.mtimeMs);
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

function collectKnownFiles(projectRoot, surface) {
  const files = [];
  if (existsSync(surface.recipes_dir)) {
    files.push(surface.recipes_dir);
    try {
      for (const entry of readdirSync(surface.recipes_dir, { withFileTypes: true })) {
        const entryPath = join(surface.recipes_dir, entry.name);
        files.push(entryPath);
        if (!entry.isDirectory()) continue;
        for (const child of readdirSync(entryPath)) files.push(join(entryPath, child));
      }
    } catch {
      // Keep the audit read-only and best-effort when a project changes underfoot.
    }
  } else {
    files.push(projectRoot);
  }
  return files;
}

function asProjectReport(project) {
  const rootPath = resolve(project.path);
  const exists = existsSync(rootPath);
  const surface = exists
    ? validateRecipeSurface(rootPath, { requireCanonicalLayout: true })
    : {
        generated_at: new Date().toISOString(),
        recipes_dir: join(rootPath, "recipes"),
        recipe_count: 0,
        valid_count: 0,
        invalid_count: 1,
        legacy_count: 0,
        recipes: [],
        registry: {
          capability_registry: { present: false, valid: true, count: 0, issues: [], info: ["capability_registry_missing"] },
          entity_registry: { present: false, valid: true, count: 0, issues: [], info: ["entity_registry_missing"] },
          valid: false,
          issues: ["project_path_missing"],
          info: [],
        },
      };
  const recipes = (surface.recipes || []).map((recipe) => ({
    id: recipe.id,
    schema_variant: recipe.variant,
    valid: recipe.valid,
    capability_id: recipe.normalized?.capability_id || "",
    entity_ids: recipe.normalized?.entity_ids || [],
  }));
  const schemaVariants = uniqueList(recipes.map((recipe) => recipe.schema_variant));
  const capabilities = uniqueList(recipes.map((recipe) => recipe.capability_id).filter(Boolean));
  const entities = uniqueList(recipes.flatMap((recipe) => recipe.entity_ids || []));
  const adoptionStatus = !exists
    ? "missing_project"
    : (surface.recipe_count > 0 ? (surface.legacy_count > 0 ? "legacy_and_canonical" : "canonical_or_empty") : "configured_empty");

  return {
    name: project.name,
    root_path: rootPath,
    recipes_dir: surface.recipes_dir,
    exists,
    adoption_status: adoptionStatus,
    recipe_count: surface.recipe_count,
    valid_count: surface.valid_count,
    invalid_count: surface.invalid_count,
    legacy_count: surface.legacy_count,
    schema_variants: schemaVariants,
    capabilities,
    entities,
    last_modified: latestMtimeIso(collectKnownFiles(rootPath, surface)),
    registry_summary: {
      capability_registry_present: !!surface.registry?.capability_registry?.present,
      capability_registry_count: surface.registry?.capability_registry?.count || 0,
      entity_registry_present: !!surface.registry?.entity_registry?.present,
      entity_registry_count: surface.registry?.entity_registry?.count || 0,
      valid: !!surface.registry?.valid,
    },
    recipes,
  };
}

function buildCollisions(projects) {
  const recipeIds = new Map();
  const capabilityIds = new Map();
  for (const project of projects) {
    for (const recipe of project.recipes) {
      if (recipe.id) {
        if (!recipeIds.has(recipe.id)) recipeIds.set(recipe.id, []);
        recipeIds.get(recipe.id).push({ project: project.name, schema_variant: recipe.schema_variant });
      }
      if (recipe.capability_id) {
        if (!capabilityIds.has(recipe.capability_id)) capabilityIds.set(recipe.capability_id, []);
        capabilityIds.get(recipe.capability_id).push({ project: project.name, recipe_id: recipe.id, schema_variant: recipe.schema_variant });
      }
    }
  }
  const toCollisions = (map, kind) => [...map.entries()]
    .filter(([, entries]) => uniqueList(entries.map((entry) => entry.project)).length > 1 || entries.length > 1)
    .map(([id, entries]) => ({ kind, id, entries }));
  return [
    ...toCollisions(recipeIds, "recipe_id"),
    ...toCollisions(capabilityIds, "capability_id"),
  ];
}

function buildSchemaDrift(projects) {
  return projects.flatMap((project) => {
    const drift = [];
    if (!project.exists) drift.push({ project: project.name, type: "missing_project" });
    if (project.recipe_count === 0) drift.push({ project: project.name, type: "configured_empty" });
    if (project.legacy_count > 0) drift.push({ project: project.name, type: "legacy_recipe_shape", count: project.legacy_count });
    if (project.invalid_count > 0) drift.push({ project: project.name, type: "invalid_recipe_or_registry", count: project.invalid_count });
    if (!project.registry_summary?.capability_registry_present) drift.push({ project: project.name, type: "missing_capability_registry" });
    if (!project.registry_summary?.entity_registry_present) drift.push({ project: project.name, type: "missing_entity_registry" });
    return drift;
  });
}

function buildMigrationRecommendations(projects, collisions, schemaDrift) {
  const recommendations = [];
  for (const drift of schemaDrift) {
    if (drift.type === "legacy_recipe_shape") {
      recommendations.push({
        project: drift.project,
        action: "convert_legacy_runner_json_to_ipbs_recipe_json",
        read_only: true,
        reason: `${drift.count} legacy recipe(s) remain readable but should be migrated to the IPBS shape.`,
      });
    }
    if (drift.type === "configured_empty") {
      recommendations.push({
        project: drift.project,
        action: "bootstrap_canonical_recipe_surface_after_approved_discovery",
        read_only: true,
        reason: "Configured project has no concrete recipe folders.",
      });
    }
    if (drift.type === "invalid_recipe_or_registry") {
      recommendations.push({
        project: drift.project,
        action: "repair_schema_validation_issues_before_recipe_adoption",
        read_only: true,
        reason: `${drift.count} invalid recipe or registry issue(s) detected.`,
      });
    }
  }
  for (const collision of collisions) {
    recommendations.push({
      project: "fleet",
      action: collision.kind === "recipe_id" ? "review_cross_project_recipe_id_collision" : "review_cross_project_capability_id_overlap",
      read_only: true,
      reason: `${collision.kind} '${collision.id}' appears in ${collision.entries.length} fleet entries.`,
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      project: "fleet",
      action: "no_migration_needed",
      read_only: true,
      reason: "No schema drift or collisions detected.",
    });
  }
  return recommendations;
}

function buildMigrationPlan(recommendations) {
  return {
    mode: "plan_only",
    writes_performed: false,
    steps: recommendations.map((recommendation, index) => ({
      step: index + 1,
      project: recommendation.project,
      action: recommendation.action,
      reason: recommendation.reason,
      read_only: true,
    })),
  };
}

export function buildRecipeFleetAudit({ cwd = process.cwd(), configPath = null, projects = null, migrate = false } = {}) {
  const config = projects
    ? { path: configPath || null, projects, source: "inline" }
    : loadFleetConfig({ cwd, configPath });
  const projectReports = config.projects.map(asProjectReport);
  const collisions = buildCollisions(projectReports);
  const schemaDrift = buildSchemaDrift(projectReports);
  const migrationRecommendations = buildMigrationRecommendations(projectReports, collisions, schemaDrift);
  const report = {
    version: 1,
    generated_at: new Date().toISOString(),
    config_path: config.path,
    config_source: config.source,
    read_only: true,
    summary: {
      project_count: projectReports.length,
      recipe_count: projectReports.reduce((sum, project) => sum + project.recipe_count, 0),
      valid_count: projectReports.reduce((sum, project) => sum + project.valid_count, 0),
      invalid_count: projectReports.reduce((sum, project) => sum + project.invalid_count, 0),
      legacy_count: projectReports.reduce((sum, project) => sum + project.legacy_count, 0),
      configured_empty_count: projectReports.filter((project) => project.recipe_count === 0).length,
    },
    projects: projectReports,
    collisions,
    schema_drift: schemaDrift,
    migration_recommendations: migrationRecommendations,
  };
  if (migrate) report.migration_plan = buildMigrationPlan(migrationRecommendations);
  return report;
}

export function findCrossFleetCapabilityMatches(audit, capabilityId, { excludeRoot = null } = {}) {
  const normalizedCapabilityId = String(capabilityId || "").trim();
  if (!normalizedCapabilityId) return [];
  const exclude = excludeRoot ? resolve(excludeRoot) : null;
  return (audit?.projects || [])
    .filter((project) => !exclude || resolve(project.root_path) !== exclude)
    .flatMap((project) => {
      const recipes = (project.recipes || []).filter((recipe) => recipe.capability_id === normalizedCapabilityId);
      if (recipes.length === 0) return [];
      return [{
        project: project.name,
        root_path: project.root_path,
        recipes_dir: project.recipes_dir,
        capability_id: normalizedCapabilityId,
        recipe_ids: uniqueList(recipes.map((recipe) => recipe.id)),
        schema_variants: uniqueList(recipes.map((recipe) => recipe.schema_variant)),
      }];
    });
}

function scalarToYaml(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (!text || /[:#\n\r[\]{}]|^\s|\s$/.test(text)) return JSON.stringify(text);
  return text;
}

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((entry) => {
      if (entry && typeof entry === "object") {
        const rendered = toYaml(entry, indent + 2);
        return `${pad}- ${rendered.startsWith(" ".repeat(indent + 2)) ? `\n${rendered}` : rendered}`;
      }
      return `${pad}- ${scalarToYaml(entry)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return entries.map(([key, entryValue]) => {
      if (entryValue && typeof entryValue === "object") {
        const rendered = toYaml(entryValue, indent + 2);
        return `${pad}${key}: ${rendered === "[]" || rendered === "{}" ? rendered : `\n${rendered}`}`;
      }
      return `${pad}${key}: ${scalarToYaml(entryValue)}`;
    }).join("\n");
  }
  return `${pad}${scalarToYaml(value)}`;
}

function usage() {
  return `recipe_fleet_audit.mjs — read-only recipe fleet audit

Usage:
  node recipe_fleet_audit.mjs audit [--config <path>] [--json] [--migrate] [--output <path>]

Notes:
  --migrate emits a migration plan only. It does not write into target projects.
`;
}

function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0] || "help";
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(usage());
    process.exit(0);
  }
  if (subcommand !== "audit") {
    console.error(`Unknown recipe fleet subcommand: ${subcommand}`);
    console.error(usage());
    process.exit(2);
  }

  const configPath = readFlagValue(args, "--config");
  const outputPath = readFlagValue(args, "--output") || join("reports", "recipe_fleet_audit.yaml");
  const json = args.includes("--json");
  const migrate = args.includes("--migrate");
  const report = buildRecipeFleetAudit({ cwd: process.cwd(), configPath, migrate });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const resolvedOutputPath = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(resolvedOutputPath), { recursive: true });
  writeFileSync(resolvedOutputPath, `${toYaml(report)}\n`);
  console.log(`Recipe fleet audit wrote ${resolvedOutputPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
