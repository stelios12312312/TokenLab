#!/usr/bin/env node
// test_workflow_disposition_contract.mjs — governed workflow disposition semantics.
// @planner:validation_module = true
// @planner:story = US-PM-AUTO-198
// @planner:proves = sc_1, sc_2, sc_4

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildWorkflowDispositionSurface,
  listFleetManagedWorkflowFiles,
  validateWorkflowContractSurface,
} from "../scripts/lib/workflow_contracts.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeProject({
  entries = [{ workflow: "/sidekick", v7_action: "Parked" }],
  registryWorkflows = [],
  activeFiles = ["sidekick.md"],
  parkedFiles = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "workflow-disposition-contract-"));
  const configDir = join(root, ".agent", "skills", "iterative-planner", "config");
  const workflowDir = join(root, ".agent", "workflows");
  const parkedDir = join(root, ".agent", "_parked");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(parkedDir, { recursive: true });
  writeJson(join(configDir, "workflow_registry.json"), { version: 1, workflows: registryWorkflows });
  writeJson(join(configDir, "workflow_contract_profiles.json"), { version: 1, profiles: {} });
  writeJson(join(configDir, "workflow_migration_inventory.json"), {
    version: 1,
    entries,
  });
  for (const file of activeFiles) writeFileSync(join(workflowDir, file), `# /${file.replace(/\.md$/, "")}\n`);
  for (const file of parkedFiles) writeFileSync(join(parkedDir, file), `# /${file.replace(/\.md$/, "")}\n`);
  return root;
}

function withProject(options, callback) {
  const projectRoot = makeProject(options);
  try {
    callback(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

console.log("\nWorkflow Disposition Contract Tests\n");

const migrationSource = readFileSync(new URL("../scripts/migrate.mjs", import.meta.url), "utf-8");
assert(
  (migrationSource.match(/listFleetManagedWorkflowFiles\(dirname\(agentDir\)\)/g) || []).length === 3,
  "expected-managed census, canonical prune set, and copy loop share the fleet projection",
);

withProject({}, (projectRoot) => {
  const result = validateWorkflowContractSurface(projectRoot);
  assert(result.ok === false, "a parked workflow cannot remain in the active workflow directory");
  assert(
    result.issues.some((entry) => entry.id === "workflow_parked_present_in_active_dir" && entry.workflow === "/sidekick"),
    "active parked contradiction reports the stable workflow-specific issue",
  );
});

withProject({
  entries: [
    { workflow: "/advisor", v7_action: "Redesigned" },
    { workflow: "/sidekick", v7_action: "Parked" },
  ],
  activeFiles: ["advisor.md"],
  parkedFiles: ["sidekick.md"],
}, (projectRoot) => {
  const result = buildWorkflowDispositionSurface(projectRoot, { requireParkedArtifacts: true });
  assert(result.ok === true, "a complete active-plus-parked disposition surface passes");
  assert(
    JSON.stringify(listFleetManagedWorkflowFiles(projectRoot, { requireParkedArtifacts: true })) === JSON.stringify(["advisor.md"]),
    "fleet-managed filenames include active entries and exclude parked entries",
  );
});

for (const fixture of [
  {
    label: "malformed workflow ids fail closed",
    issue: "workflow_inventory_invalid_id",
    options: { entries: [{ workflow: "/../escape", v7_action: "Parked" }], activeFiles: [] },
  },
  {
    label: "blank actions fail closed",
    issue: "workflow_inventory_missing_action",
    options: { entries: [{ workflow: "/advisor", v7_action: "  " }], activeFiles: ["advisor.md"] },
  },
  {
    label: "unknown actions fail closed",
    issue: "workflow_inventory_unknown_action",
    options: { entries: [{ workflow: "/advisor", v7_action: "Teleport" }], activeFiles: ["advisor.md"] },
  },
  {
    label: "duplicate workflow ids fail closed",
    issue: "workflow_inventory_duplicate_id",
    options: {
      entries: [
        { workflow: "/advisor", v7_action: "New" },
        { workflow: "advisor", v7_action: "Updated" },
      ],
      activeFiles: ["advisor.md"],
    },
  },
  {
    label: "active files without an inventory disposition fail closed",
    issue: "workflow_markdown_missing_inventory_entry",
    options: { entries: [], activeFiles: ["orphan.md"] },
  },
  {
    label: "non-parked dispositions require an active file",
    issue: "workflow_active_file_missing",
    options: { entries: [{ workflow: "/advisor", v7_action: "New" }], activeFiles: [] },
  },
  {
    label: "parked workflows cannot remain public",
    issue: "workflow_parked_public_registry_conflict",
    options: {
      entries: [{ workflow: "/sidekick", v7_action: "Parked" }],
      registryWorkflows: [{ id: "/sidekick", contract_profile: "diagnostic" }],
      activeFiles: [],
      parkedFiles: ["sidekick.md"],
    },
  },
  {
    label: "parked archive files require a parked inventory disposition",
    issue: "workflow_parked_artifact_undispositioned",
    options: { entries: [], activeFiles: [], parkedFiles: ["orphan.md"] },
  },
]) {
  withProject(fixture.options, (projectRoot) => {
    const result = buildWorkflowDispositionSurface(projectRoot, { requireParkedArtifacts: true });
    assert(result.issues.some((entry) => entry.id === fixture.issue), fixture.label);
  });
}

withProject({ activeFiles: [], parkedFiles: [] }, (projectRoot) => {
  const consumerResult = buildWorkflowDispositionSurface(projectRoot, { requireParkedArtifacts: false });
  const sourceResult = buildWorkflowDispositionSurface(projectRoot, { requireParkedArtifacts: true });
  assert(!consumerResult.issues.some((entry) => entry.id === "workflow_parked_artifact_missing"), "fleet consumers do not need the canonical parked archive");
  assert(sourceResult.issues.some((entry) => entry.id === "workflow_parked_artifact_missing"), "canonical source mode requires the parked archive");
});

withProject({
  entries: [{ workflow: "/../escape", v7_action: "Parked" }],
  activeFiles: [],
  parkedFiles: [],
}, (projectRoot) => {
  const consumerResult = buildWorkflowDispositionSurface(projectRoot, { requireParkedArtifacts: false });
  assert(consumerResult.ok === false, "fleet consumers reject malformed parked ids instead of reporting a false green");
  assert(
    consumerResult.entries[0].active_file === null && consumerResult.entries[0].parked_file === null,
    "malformed ids never produce active or parked filesystem paths",
  );
});

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;
