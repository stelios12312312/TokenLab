#!/usr/bin/env node
// test_workflow_migration_inventory.mjs — Contract coverage for Phase 6 workflow inventory.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  buildWorkflowMigrationInventory,
  serializeJsonCompatibleYaml,
} from "../scripts/workflow.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

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

function scenarioInventoryCoversEveryWorkflowFile() {
  const report = buildWorkflowMigrationInventory(repoRoot).workflow_migration_inventory;
  assert(report.version === 1, "workflow inventory report schema version is pinned");
  assert(report.summary.workflow_file_count === report.summary.mapped_workflow_count, "every workflow file is accounted for in the migration inventory");
  assert(report.coverage.missing_from_inventory.length === 0, "workflow inventory has no unmapped workflow files");
  assert(report.coverage.missing_workflow_files.length === 0, "workflow inventory has no stale entries without backing workflow files");
  assert(report.summary.workflow_registry_tracked_count + report.summary.workflow_registry_untracked_count === report.summary.workflow_file_count, "workflow registry coverage counts add up to the workflow file count");
}

function scenarioKeyMappingsStayAnchored() {
  const report = buildWorkflowMigrationInventory(repoRoot).workflow_migration_inventory;
  const byWorkflow = new Map(report.workflows.map((entry) => [entry.workflow, entry]));

  assert(byWorkflow.get("/story-bootstrap")?.v7_action === "Renamed", "/story-bootstrap is marked as a renamed workflow");
  assert(byWorkflow.get("/story-bootstrap")?.alias_target === "/story-registry-bootstrap", "/story-bootstrap points at the new registry bootstrap alias target");
  assert(byWorkflow.get("/red-team-user-story-audit")?.v7_action === "Deprecated", "/red-team-user-story-audit is marked as deprecated");
  assert(byWorkflow.get("/red-team-user-story-audit")?.alias_target === "/story-verification", "/red-team-user-story-audit points at /story-verification");
  assert(byWorkflow.get("/kb-update")?.v7_action === "Keep unchanged", "/kb-update stays represented in the active migration inventory");
  assert(byWorkflow.get("/full-review-and-fix")?.v7_action === "Keep unchanged", "/full-review-and-fix stays represented in the active migration inventory");
  assert(byWorkflow.get("/story-verification")?.v7_action === "New", "/story-verification is marked as a new v7 workflow");
  assert(byWorkflow.get("/story-review-agent")?.v7_action === "Keep unchanged", "story-review-agent stays explicitly represented in the migration inventory");
  assert(byWorkflow.get("/roadmap-steward")?.v7_action === "Renamed", "/roadmap-steward is explicitly represented as a user-facing alias workflow");
  assert(byWorkflow.get("/ticket-traceability-repair")?.v7_action === "New", "/ticket-traceability-repair is marked as a new v7 workflow");
}

function scenarioCommittedReportMatchesGenerator() {
  const generated = buildWorkflowMigrationInventory(repoRoot);
  const committed = JSON.parse(readFileSync(join(repoRoot, "reports", "workflow_migration_inventory.yaml"), "utf-8"));

  committed.workflow_migration_inventory.generated_at = generated.workflow_migration_inventory.generated_at;
  assert(serializeJsonCompatibleYaml(committed) === serializeJsonCompatibleYaml(generated), "committed workflow migration report matches the generator output");
}

console.log("\nWorkflow Migration Inventory Tests\n");

scenarioInventoryCoversEveryWorkflowFile();
scenarioKeyMappingsStayAnchored();
scenarioCommittedReportMatchesGenerator();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
