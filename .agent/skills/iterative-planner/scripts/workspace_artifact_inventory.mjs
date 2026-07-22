#!/usr/bin/env node
// workspace_artifact_inventory.mjs - CLI for read-only workspace artifact inventory.
// @planner:module = workspace_artifact_inventory_cli
// @planner:capability = registry_workspace_artifact_inventory_cli

import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import {
  defaultRegistryPath,
  formatInventoryText,
  inventoryWorkspaceArtifacts,
  parseInventoryArgs,
} from "./lib/workspace_artifact_inventory.mjs";

function usage() {
  return [
    "workspace_artifact_inventory.mjs — read-only registry workspace artifact inventory",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/workspace_artifact_inventory.mjs [--json] [--registry <path>] [--root <home-root>] [--max-depth <n>] [--sample-limit <n>]",
    "",
    "The command reads registry and filesystem metadata only. It does not read secret values or write into registered workspaces.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const options = parseInventoryArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.unknown?.length) {
    console.error(`Unknown option(s): ${options.unknown.join(", ")}`);
    console.error(usage());
    return 2;
  }

  const report = inventoryWorkspaceArtifacts({
    cwd,
    registryPath: options.registryPath || defaultRegistryPath(cwd),
    currentHome: options.currentHome,
    maxDepth: options.maxDepth,
    sampleLimit: options.sampleLimit,
  });

  if (options.json) emitJson(report);
  else console.log(formatInventoryText(report));
  return report.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
