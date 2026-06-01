#!/usr/bin/env node
// Focused regression coverage for planner-core persona authority in project health.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { detectPlanShape } from "../scripts/lib/plan_shape.mjs";
import { decidePersonaPackActivation } from "../scripts/lib/persona_activation_authority.mjs";

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
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
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

const shape = detectPlanShape({ goalText: "Implement IVE ticket #9 Resolve persona config authority" });
assert(shape.primary === "planner-core", "persona config authority goal is planner-core before files exist");

const executionShape = detectPlanShape({ goalText: "Implement IVE ticket #10 persona execution script" });
assert(executionShape.primary === "planner-core", "persona execution script goal is planner-core before files exist");

const suppressedQuant = decidePersonaPackActivation("quant", { planShape: { primary: "planner-core" } });
assert(suppressedQuant.authority === "suppressed" && suppressedQuant.may_load === false, "planner-core suppresses quant by default");

const forcedQuant = decidePersonaPackActivation("quant", {
  planShape: { primary: "planner-core" },
  forcePacks: ["quant"],
});
assert(forcedQuant.authority === "forced" && forcedQuant.may_load === true, "force_packs restores quant authority explicitly");

const tmp = mkdtempSync(join(tmpdir(), "persona-authority-health-"));
try {
  const planDir = join(tmp, "plans", "plan_authority");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "quant", "quant_research_protocol", "assumptions_challenger", "config_integrity", "traceability"],
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2) + "\n");
  writeFileSync(join(tmp, "plans", ".current_plan"), "plan_authority\n");
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    version: 1,
    state: "PLAN",
    plan_dir: "plan_authority",
    goal: "Implement persona activation authority",
    plan_shape: { primary: "feature" },
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({ version: 1 }, null, 2) + "\n");
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Implement persona activation authority

## Files To Modify
- .agent/skills/iterative-planner/scripts/project_health.mjs
- .agent/skills/iterative-planner/scripts/audit_runner.mjs
- .agent/skills/iterative-planner/scripts/lib/plan_shape.mjs
`);

  const health = run([join(scriptDir, "project_health.mjs"), "--quick", "--json"], tmp);
  const healthReport = parseJson(health);
  const healthAnalyzers = (healthReport?.findings || []).map((entry) => String(entry?.analyzer || ""));
  assert(!!healthReport, "project_health emits parseable JSON for active planner-core authority fixture");
  assert(!healthAnalyzers.some((name) => name.startsWith("[quant]")), "project_health suppresses quant findings for planner-core active plan");
  assert(!healthAnalyzers.some((name) => name.startsWith("[ux_ui]")), "project_health suppresses ux_ui findings for planner-core active plan");

  const audit = run([join(scriptDir, "audit_runner.mjs"), "--plan", "plan_authority", "--json", "--report-only"], tmp);
  const auditReport = parseJson(audit);
  assert(Array.isArray(auditReport?.packs_loaded), "audit_runner emits loaded pack list");
  assert(!auditReport.packs_loaded.includes("quant"), "audit_runner suppresses configured quant pack for planner-core active plan");
  assert((auditReport.persona_authority?.suppressed_packs || []).includes("quant"), "audit_runner reports quant as suppressed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
