#!/usr/bin/env node
// Focused tests for annotation_quality.mjs.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { analyzeAnnotationQuality, repairAnnotations } from "../scripts/annotation_quality.mjs";
import { parseAnnotations, validate as validateAnnotations, walkDir } from "../scripts/annotation_parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const NODE = process.execPath;

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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-annotation-quality-"));
  const planName = "plan_quality_fixture";
  writeText(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeText(join(tmp, "plans", planName, "plan.md"), `# Plan

## Goal
Annotation quality fixture

## Success Criteria
1. Known proof criterion
`);

  writeJson(join(tmp, "reports", "user_story_audit", "project_goals.json"), {
    goals: [{ id: "G-001", title: "Goal one", description: "Primary fixture goal" }],
  });
  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    stories: [
      {
        id: "US-100",
        title: "Goal-backed annotation story",
        status: "FULLY_COVERED",
        code_refs: ["src/source.py"],
        validation_refs: ["tests/test_source.py"],
        goal_refs: ["G-001"],
      },
    ],
  });

  writeText(join(tmp, "pkg", "old", "path.py"), "# consumer target\n");
  writeText(join(tmp, "real", "target.py"), "# basename target\n");
  writeText(join(tmp, "tests", "test_source.py"), "# test target\n");
  writeText(join(tmp, "src", "source.py"), `# @planner:story_id US-100
# @planner:consumer = pkg.old.path.py
# @planner:consumer = tests/test_source.py
# @planner:consumer = tests/test_source.py
# @planner:consumer = missing/target.py
# @planner:proves = crit:ghost
# fixture source
`);
  writeText(join(tmp, "src", "proof.py"), `# @planner:proves = crit:sc_1
# known proof
`);
  writeText(join(tmp, "src", "unknown_story.py"), `# @planner:story_id US-999
# unknown story
`);
  writeText(join(tmp, "src", "flags.py"), `# @planner:config_flag = selector_probability_diagnostic_only
# @planner:mutually_exclusive = selector_probability_as_stake
# flag source
`);
  return tmp;
}

function parseAll(tmp) {
  const annotations = [];
  for (const file of walkDir(tmp, tmp)) annotations.push(...parseAnnotations(file, tmp));
  return annotations;
}

function scenarioRepairAndUsefulness() {
  const tmp = makeFixture();
  try {
    const before = analyzeAnnotationQuality({ cwd: tmp });
    assert(before.summary.counts.invalid >= 2, "quality report flags malformed/missing annotations as invalid before repair");
    assert(before.summary.counts.stale >= 1, "quality report flags stale proof targets before repair");

    const dryRun = repairAnnotations({ cwd: tmp, apply: false, demoteStaleProves: true });
    assert(dryRun.repair_count >= 5, "dry-run reports deterministic repairs");
    assert(readFileSync(join(tmp, "src", "source.py"), "utf-8").includes("@planner:story_id US-100"), "dry-run does not mutate files");

    const applied = repairAnnotations({ cwd: tmp, apply: true, demoteStaleProves: true });
    assert(applied.applied === true, "apply mode records that repairs were applied");
    assert(applied.repairs.some((entry) => entry.action === "normalize_story_id"), "repair normalizes known story_id annotations");
    assert(applied.repairs.some((entry) => entry.action === "repair_consumer_path" && entry.to === "pkg/old/path.py"), "repair converts dotted Python consumer paths");
    assert(applied.repairs.some((entry) => entry.action === "repair_consumer_path" && entry.to === "real/target.py"), "repair resolves a unique basename consumer path");
    assert(applied.repairs.some((entry) => entry.action === "remove_duplicate_consumer"), "repair removes duplicate consumer annotations");
    assert(applied.repairs.some((entry) => entry.action === "demote_stale_proves"), "repair demotes stale proof targets when explicitly requested");
    assert(applied.repairs.some((entry) => entry.action === "demote_unknown_story_id"), "repair demotes unknown story_id annotations");

    const source = readFileSync(join(tmp, "src", "source.py"), "utf-8");
    assert(source.includes("@planner:story = US-100"), "known story_id is rewritten to @planner:story");
    assert(!source.includes("@planner:proves = crit:ghost"), "stale proof target is removed from live @planner surface");
    assert((source.match(/@planner:consumer = tests\/test_source.py/g) || []).length === 1, "duplicate consumer line is removed");

    const after = analyzeAnnotationQuality({ cwd: tmp });
    assert(after.summary.counts.invalid === 0, "quality report has zero invalid annotations after repair");
    assert(after.summary.counts.stale === 0, "quality report has zero stale annotations after repair");
    assert(after.summary.counts.needs_review >= 1, "undeclared asymmetric mutual exclusion remains review-only");
    assert(after.issues.some((issue) => issue.code === "goal_backed_story"), "story annotation is useful when linked to a project goal");

    const validationErrors = validateAnnotations(parseAll(tmp), tmp).filter((entry) => entry.severity === "fail");
    assert(validationErrors.length === 0, "annotation_parser validation has no hard errors after repair");

    const cli = execFileSync(NODE, [join(scriptDir, "annotation_quality.mjs"), "--dir", tmp, "--json"], {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(cli);
    assert(parsed.summary.counts.invalid === 0 && parsed.summary.counts.stale === 0, "CLI JSON reports clean invalid/stale counts");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

scenarioRepairAndUsefulness();

console.log(`\nannotation_quality tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
