#!/usr/bin/env node

import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

import { detectWorkflowCustomizations, formatWorkflowCustomizationText } from "./lib/workflow_customization.mjs";
import {
  buildWorkflowDispositionSurface,
  normalizeWorkflowAction,
} from "./lib/workflow_contracts.mjs";

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

function repoRelative(root, path) {
  if (!path) return null;
  return relative(root, path).split(sep).join("/");
}

function buildAliasTarget(entry) {
  if (entry.workflow === "/story-bootstrap") return "/story-registry-bootstrap";
  if (entry.workflow === "/red-team-user-story-audit") return "/story-verification";
  return null;
}

export function buildWorkflowMigrationInventory(root = defaultProjectRoot) {
  const surface = buildWorkflowDispositionSurface(root);
  const inventoryConfig = surface.inventory;
  const workflows = surface.entries.map((entry) => {
    const action = typeof entry.v7_action === "string" ? entry.v7_action.trim() : null;
    return {
      workflow: entry.workflow,
      workflow_file: entry.active_file_exists ? repoRelative(root, entry.active_file) : null,
      parked_workflow_file: entry.parked_file_exists ? repoRelative(root, entry.parked_file) : null,
      v6_purpose: typeof entry.v6_purpose === "string" ? entry.v6_purpose.trim() : null,
      v7_action: action,
      v7_owner: typeof entry.v7_owner === "string" ? entry.v7_owner.trim() : null,
      notes: typeof entry.notes === "string" ? entry.notes.trim() : null,
      alias_target: buildAliasTarget(entry),
      disposition_status: entry.disposition_status,
      fleet_propagation: entry.fleet_managed ? "included" : "excluded",
      registry_tracked: entry.registry_tracked,
    };
  });

  const actionCounts = {};
  for (const entry of workflows) {
    const key = normalizeWorkflowAction(entry.v7_action) || "invalid";
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
        workflow_file_count: surface.active_workflow_ids.length,
        parked_workflow_file_count: surface.parked_workflow_ids.length,
        disposition_count: workflows.length,
        mapped_workflow_count: surface.entries.filter((entry) => entry.workflow && entry.action_known).length,
        workflow_registry_tracked_count: registryTracked.length,
        workflow_registry_untracked_count: registryUntracked.length,
        action_counts: actionCounts,
      },
      coverage: {
        missing_from_inventory: surface.issues
          .filter((entry) => entry.id === "workflow_markdown_missing_inventory_entry")
          .map((entry) => entry.workflow),
        missing_workflow_files: surface.issues
          .filter((entry) => entry.id === "workflow_active_file_missing")
          .map((entry) => entry.workflow),
        parked_in_active_workflow_dir: surface.issues
          .filter((entry) => entry.id === "workflow_parked_present_in_active_dir")
          .map((entry) => entry.workflow),
        missing_parked_workflow_files: surface.issues
          .filter((entry) => entry.id === "workflow_parked_artifact_missing")
          .map((entry) => entry.workflow),
        disposition_issues: surface.issues,
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
  lines.push(`  Parked workflow files: ${payload.summary.parked_workflow_file_count}`);
  lines.push(`  Governed dispositions: ${payload.summary.disposition_count}`);
  lines.push(`  Mapped workflows: ${payload.summary.mapped_workflow_count}`);
  lines.push(`  Registry tracked: ${payload.summary.workflow_registry_tracked_count}`);
  lines.push(`  Registry untracked: ${payload.summary.workflow_registry_untracked_count}`);

  if (payload.coverage.missing_from_inventory.length > 0) {
    lines.push(`  Missing from inventory: ${payload.coverage.missing_from_inventory.join(", ")}`);
  }
  if (payload.coverage.missing_workflow_files.length > 0) {
    lines.push(`  Missing workflow files: ${payload.coverage.missing_workflow_files.join(", ")}`);
  }
  if (payload.coverage.parked_in_active_workflow_dir.length > 0) {
    lines.push(`  Parked but active: ${payload.coverage.parked_in_active_workflow_dir.join(", ")}`);
  }
  if (payload.coverage.missing_parked_workflow_files.length > 0) {
    lines.push(`  Missing parked archives: ${payload.coverage.missing_parked_workflow_files.join(", ")}`);
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

  const hasCoverageGap = report.workflow_migration_inventory.coverage.disposition_issues
    .some((entry) => entry.blocking);
  return hasCoverageGap ? 1 : 0;
}

if (isMain()) {
  process.exitCode = main(process.argv);
}
