#!/usr/bin/env node
// Focused coverage for persona_execute.mjs.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { detectPlanShape } from "../scripts/lib/plan_shape.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}

function run(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      status: error.status,
    };
  }
}

function parseJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function writePlan(root, {
  goal = "Implement IVE ticket #10 persona execution script",
  files = [".agent/skills/iterative-planner/scripts/persona_execute.mjs"],
} = {}) {
  const planDir = join(root, "plans", "plan_persona_execution");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(root, "plans", ".current_plan"), "plan_persona_execution\n");
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    version: 1,
    state: "PLAN",
    plan_dir: "plan_persona_execution",
    goal,
    plan_shape: { primary: "feature" },
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({ version: 1 }, null, 2) + "\n");
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Files To Modify
${files.map((file) => `- ${file}`).join("\n")}

## Success Criteria
1. sc_1: Persona execution script emits deterministic guidance.
`);
  return planDir;
}

function writeAuditConfig(root, roles = ["core", "assumptions_challenger", "config_integrity", "traceability"]) {
  writeFileSync(join(root, "audit.config.json"), JSON.stringify({
    roles,
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2) + "\n");
}

function scenarioShapeClassifiesPersonaExecutionAsPlannerCore() {
  const shape = detectPlanShape({ goalText: "Implement IVE ticket #10 persona execution script" });
  assert(shape.primary === "planner-core", "persona execution script goal is planner-core before files exist");
}

function scenarioJsonExecutionGuidanceAndSuppression() {
  const root = mkdtempSync(join(tmpdir(), "persona-execute-json-"));
  try {
    writePlan(root);
    writeAuditConfig(root, ["core", "quant", "quant_research_protocol", "assumptions_challenger", "config_integrity", "traceability"]);

    const result = run([join(scriptDir, "persona_execute.mjs"), "--json"], root);
    const report = parseJson(result);
    assert(!!report, "persona_execute --json emits parseable JSON");
    assert(result.ok, "persona_execute exits 0 when only advisory/nonblocking obligations exist");
    assert(report.version === 1, "persona_execute JSON includes version");
    assert(report.phase === "execute", "persona_execute defaults phase to execute");
    assert(report.plan.name === "plan_persona_execution", "persona_execute resolves active plan");
    assert(report.packs.loaded.includes("assumptions_challenger"), "persona_execute loads configured authoritative packs");
    assert(!report.packs.loaded.includes("quant"), "persona_execute suppresses quant for planner-core plan");
    assert(report.packs.suppressed.includes("quant"), "persona_execute reports quant as suppressed");
    assert(report.obligations.some((entry) => entry.type === "guidance"), "persona_execute projects phase guidance obligations");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioWriteModePersistsArtifacts() {
  const root = mkdtempSync(join(tmpdir(), "persona-execute-write-"));
  try {
    const planDir = writePlan(root);
    writeAuditConfig(root);

    const result = run([join(scriptDir, "persona_execute.mjs"), "--write", "--json"], root);
    const report = parseJson(result);
    assert(result.ok, "persona_execute --write exits 0 for healthy fixture");
    assert(report?.write_status === "written", "persona_execute reports written status");
    assert(existsSync(join(planDir, "persona_execution.json")), "persona_execute writes persona_execution.json");
    assert(existsSync(join(planDir, "persona_execution.md")), "persona_execute writes persona_execution.md");
    assert(report.artifacts_written.includes("plans/plan_persona_execution/persona_execution.json"), "persona_execute reports written JSON artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioMissingConfigBlocksDeterministically() {
  const root = mkdtempSync(join(tmpdir(), "persona-execute-missing-config-"));
  try {
    writePlan(root);

    const result = run([join(scriptDir, "persona_execute.mjs"), "--json"], root);
    const report = parseJson(result);
    assert(!result.ok, "persona_execute exits nonzero when audit config is missing");
    assert(report?.status === "blocked", "persona_execute reports blocked status for missing config");
    assert(report?.config?.present === false, "persona_execute reports missing audit config");
    assert(report?.obligations?.some((entry) => entry.id === "persona_config_missing" && entry.blocking), "persona_execute emits blocking missing-config obligation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioUnderfitBlocksWithRepairGuidance() {
  const root = mkdtempSync(join(tmpdir(), "persona-execute-underfit-"));
  try {
    writePlan(root);
    writeAuditConfig(root, ["core"]);
    mkdirSync(join(root, "planner"), { recursive: true });
    writeFileSync(join(root, "planner", "runtime.txt"), "planner persona execution surface\n");

    const result = run([join(scriptDir, "persona_execute.mjs"), "--strict-underfit", "--json"], root);
    const report = parseJson(result);
    assert(!result.ok, "persona_execute exits nonzero for strict underfit fixture");
    assert(report?.summary?.blocking > 0, "persona_execute reports blocking strict-underfit obligation");
    assert(report?.config?.repair_command, "persona_execute includes repair guidance for underfit config");
    assert(report?.obligations?.some((entry) => entry.id === "persona_config_status"), "persona_execute emits persona_config_status obligation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

scenarioShapeClassifiesPersonaExecutionAsPlannerCore();
scenarioJsonExecutionGuidanceAndSuppression();
scenarioWriteModePersistsArtifacts();
scenarioMissingConfigBlocksDeterministically();
scenarioUnderfitBlocksWithRepairGuidance();

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
