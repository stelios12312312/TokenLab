#!/usr/bin/env node
// test_checklist_runner_yaml_lists.mjs — Ensure the standalone checklist runner
// accepts multiline include lists via the shared YAML parser.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptPath = join(testDir, "..", "scripts", "checklist_runner.mjs");
const tmp = mkdtempSync(join(tmpdir(), "planner-checklist-yaml-"));

try {
  const fixtureDir = join(tmp, "fixture");
  mkdirSync(fixtureDir, { recursive: true });
  const targetPath = join(fixtureDir, "plan.md");
  const checklistPath = join(fixtureDir, "checklist.yaml");

  writeFileSync(targetPath, "[KB_APPLIED: P-020]\n");
  writeFileSync(checklistPath, `name: "List parser regression"

items:
  - id: kb-tag
    check: contains_any_string
    path: "${targetPath}"
    include:
      - "[KB_APPLIED"
      - "[KB_NOT_APPLICABLE"
    description: "shared parser should accept multiline include lists"
`);

  const result = spawnSync(process.execPath, [scriptPath, "--file", checklistPath], {
    encoding: "utf-8",
    cwd: fixtureDir,
  });

  assert(result.status === 0, "standalone checklist runner exits cleanly for multiline include lists");
  assert(!result.stdout.includes("BLOCKED"), "standalone checklist runner does not block on parser warnings");
  assert(result.stdout.includes("PASS"), "contains_any_string checklist item passes with multiline include list");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
