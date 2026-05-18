#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { detectWorkflowCustomizations, formatWorkflowCustomizationText } from "./lib/workflow_customization.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const defaultProjectRoot = resolve(process.cwd());

function isMain(entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(__filename);
  } catch {
    return resolve(entry) === __filename;
  }
}

const CONFIG_RELATIVE_PATH = join(".agent", "skills", "iterative-planner", "config", "workflow_migration_inventory.json");
const REGISTRY_RELATIVE_PATH = join(".agent", "skills", "iterative-planner", "config", "workflow_registry.json");
const WORKFLOW_DIR_RELATIVE_PATH = join(".agent", "workflows");

function usage() {
  return [
    "workflow.mjs — Workflow inventory utilities",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/workflow.mjs inventory [--json] [--write]",
    "  node .agent/skills/iterative-planner/scripts/workflow.mjs customize detect [--json]",
    "",
    "Behavior:",
    "  - Reads the workflow migration inventory source of truth",
    "  - Validates that every workflow file is accounted for",
    "  - Writes reports/workflow_migration_inventory.yaml when --write is passed",
    "  - Diffs local workflow files against the canonical source repo when customize detect is used",
  ].join("\n");
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeActionKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function listWorkflowFiles(root) {
  const workflowDir = join(root, WORKFLOW_DIR_RELATIVE_PATH);
  if (!existsSync(workflowDir)) return [];
  return readdirSync(workflowDir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => ({
      file: join(WORKFLOW_DIR_RELATIVE_PATH, entry),
      workflow: `/${entry.replace(/\.md$/i, "")}`,
    }));
}

function loadInventoryConfig(root) {
  const configPath = join(root, CONFIG_RELATIVE_PATH);
  const parsed = safeReadJson(configPath);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`workflow migration inventory config must be version=1 with an entries array at ${configPath}`);
  }
  return {
    path: configPath,
    generated_report: typeof parsed.generated_report === "string" && parsed.generated_report.trim()
      ? parsed.generated_report.trim()
      : join("reports", "workflow_migration_inventory.yaml"),
    entries: parsed.entries,
  };
}

function loadWorkflowRegistry(root) {
  const parsed = safeReadJson(join(root, REGISTRY_RELATIVE_PATH));
  return Array.isArray(parsed?.workflows)
    ? new Set(parsed.workflows
      .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
      .filter(Boolean))
    : new Set();
}

function buildAliasTarget(entry) {
  if (entry.workflow === "/story-bootstrap") return "/story-registry-bootstrap";
  if (entry.workflow === "/red-team-user-story-audit") return "/story-verification";
  return null;
}

export function buildWorkflowMigrationInventory(root = defaultProjectRoot) {
  const workflowFiles = listWorkflowFiles(root);
  const inventoryConfig = loadInventoryConfig(root);
  const registryIds = loadWorkflowRegistry(root);
  const entryByWorkflow = new Map(
    inventoryConfig.entries.map((entry) => [entry.workflow, entry])
  );

  const missingFromInventory = workflowFiles
    .filter(({ workflow }) => !entryByWorkflow.has(workflow))
    .map(({ workflow }) => workflow);

  const missingWorkflowFiles = inventoryConfig.entries
    .filter((entry) => normalizeActionKey(entry.v7_action) !== "parked")
    .filter((entry) => !workflowFiles.some(({ workflow }) => workflow === entry.workflow))
    .map((entry) => entry.workflow)
    .sort();

  const workflows = workflowFiles.map(({ workflow, file }) => {
    const entry = entryByWorkflow.get(workflow) || {};
    const action = typeof entry.v7_action === "string" ? entry.v7_action.trim() : "UNMAPPED";
    return {
      workflow,
      workflow_file: file,
      v6_purpose: typeof entry.v6_purpose === "string" ? entry.v6_purpose.trim() : null,
      v7_action: action,
      v7_owner: typeof entry.v7_owner === "string" ? entry.v7_owner.trim() : null,
      notes: typeof entry.notes === "string" ? entry.notes.trim() : null,
      alias_target: buildAliasTarget(entry),
      registry_tracked: registryIds.has(workflow),
    };
  });

  const actionCounts = {};
  for (const entry of workflows) {
    const key = normalizeActionKey(entry.v7_action);
    actionCounts[key] = (actionCounts[key] || 0) + 1;
  }

  const registryTracked = workflows.filter((entry) => entry.registry_tracked).map((entry) => entry.workflow);
  const registryUntracked = workflows.filter((entry) => !entry.registry_tracked).map((entry) => entry.workflow);

  return {
    workflow_migration_inventory: {
      version: 1,
      generated_at: new Date().toISOString(),
      source_config: CONFIG_RELATIVE_PATH,
      report_path: inventoryConfig.generated_report,
      summary: {
        workflow_file_count: workflowFiles.length,
        mapped_workflow_count: workflows.filter((entry) => entry.v7_action !== "UNMAPPED").length,
        workflow_registry_tracked_count: registryTracked.length,
        workflow_registry_untracked_count: registryUntracked.length,
        action_counts: actionCounts,
      },
      coverage: {
        missing_from_inventory: missingFromInventory,
        missing_workflow_files: missingWorkflowFiles,
        workflow_registry_tracked: registryTracked,
        workflow_registry_untracked: registryUntracked,
      },
      workflows,
    },
  };
}

export function serializeJsonCompatibleYaml(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function formatInventoryText(document) {
  const payload = document.workflow_migration_inventory;
  const lines = [];
  lines.push("Workflow migration inventory");
  lines.push(`  Workflow files: ${payload.summary.workflow_file_count}`);
  lines.push(`  Mapped workflows: ${payload.summary.mapped_workflow_count}`);
  lines.push(`  Registry tracked: ${payload.summary.workflow_registry_tracked_count}`);
  lines.push(`  Registry untracked: ${payload.summary.workflow_registry_untracked_count}`);

  if (payload.coverage.missing_from_inventory.length > 0) {
    lines.push(`  Missing from inventory: ${payload.coverage.missing_from_inventory.join(", ")}`);
  }
  if (payload.coverage.missing_workflow_files.length > 0) {
    lines.push(`  Missing workflow files: ${payload.coverage.missing_workflow_files.join(", ")}`);
  }

  return lines.join("\n");
}

function main(argv = process.argv) {
  const projectRoot = resolve(process.cwd());
  const args = argv.slice(2);
  const subcommand = args[0] || "inventory";
  const nestedSubcommand = args[1] || null;
  const json = args.includes("--json");
  const write = args.includes("--write");

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(usage());
    return 0;
  }

  if (subcommand === "customize" && nestedSubcommand === "detect") {
    const report = detectWorkflowCustomizations(projectRoot);
    if (json) {
      console.log(serializeJsonCompatibleYaml(report).trimEnd());
    } else {
      console.log(formatWorkflowCustomizationText(report));
    }
    return 0;
  }

  if (subcommand !== "inventory") {
    console.error(`Unknown workflow subcommand: ${subcommand}`);
    console.error(usage());
    return 2;
  }

  const report = buildWorkflowMigrationInventory(projectRoot);
  if (write) {
    const reportPath = join(projectRoot, report.workflow_migration_inventory.report_path);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, serializeJsonCompatibleYaml(report));
  }

  if (json) {
    console.log(serializeJsonCompatibleYaml(report).trimEnd());
  } else {
    console.log(formatInventoryText(report));
  }

  const hasCoverageGap = report.workflow_migration_inventory.coverage.missing_from_inventory.length > 0
    || report.workflow_migration_inventory.coverage.missing_workflow_files.length > 0;
  return hasCoverageGap ? 1 : 0;
}

if (isMain()) {
  process.exitCode = main(process.argv);
}
