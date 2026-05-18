#!/usr/bin/env node
// test_parallel_plan_targeting.mjs — Regression coverage for parallel plan
// targeting via thread-local bindings and explicit --plan overrides.

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { refreshPlanArtifacts } from "../scripts/lib/plan_refresh.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const agentDir = resolve(skillDir, "../..");
const NODE = process.execPath;

const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
const verifyGateScript = ".agent/skills/iterative-planner/scripts/verify_gate.mjs";
const postToolUseScript = ".agent/skills/iterative-planner/scripts/hooks/post_tool_use.mjs";

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

function run(args, cwd, extraEnv = {}, input = undefined) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
        input,
      }),
      stderr: "",
    };
  } catch (e) {
    return {
      ok: false,
      status: e.status ?? 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "planner-parallel-targeting-"));

try {
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");

  const mainThreadEnv = { CODEX_THREAD_ID: "thread-main" };
  const parallelThreadEnv = { CODEX_THREAD_ID: "thread-parallel" };

  const primary = run([bootstrapScript, "new", "Primary pointer plan"], tmp, mainThreadEnv);
  assert(primary.ok, "bootstrap new creates the primary pointer-backed plan");

  const primaryPlan = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
  assert(!!primaryPlan, "primary plan pointer is recorded");

  const parallel = run([bootstrapScript, "new", "--parallel", "Parallel thread plan"], tmp, parallelThreadEnv);
  assert(parallel.ok, "bootstrap new --parallel creates a second plan without replacing the pointer");
  assert(readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim() === primaryPlan, "parallel creation preserves the primary pointer");

  const parallelTargetPath = join(tmp, "plans", ".thread_targets", "thread-parallel.txt");
  assert(existsSync(parallelTargetPath), "parallel creation writes a thread-local target file");
  const parallelPlan = readFileSync(parallelTargetPath, "utf-8").trim();
  assert(parallelPlan.startsWith("plan_") && parallelPlan !== primaryPlan, "thread-local target points at the new parallel plan");

  const status = run([bootstrapScript, "status"], tmp, parallelThreadEnv);
  assert(status.ok, "bootstrap status resolves the thread-targeted plan");
  assert(status.stdout.includes(`plans/${parallelPlan}`), "bootstrap status reports the parallel plan rather than the pointer plan");
  assert(status.stdout.includes("Target source: thread"), "bootstrap status surfaces thread-based targeting");
  assert(status.stdout.includes(`Pointer: plans/.current_plan → ${primaryPlan}`), "bootstrap status still shows the repo-wide pointer");

  const resume = run([bootstrapScript, "resume"], tmp, parallelThreadEnv);
  assert(resume.ok, "bootstrap resume resolves the thread-targeted plan");
  assert(resume.stdout.includes(`Resuming plans/${parallelPlan}/`), "bootstrap resume opens the parallel plan");
  assert(resume.stdout.includes("Target:     thread resolution"), "bootstrap resume explains that thread resolution selected the plan");

  const explicitGate = run([verifyGateScript, "explore-to-plan", "--plan", parallelPlan], tmp, mainThreadEnv);
  assert(!explicitGate.ok, "verify_gate still blocks an unprepared explore plan when explicitly targeted");
  assert(explicitGate.stdout.includes(`Plan: ${parallelPlan}`), "verify_gate header reflects the explicit plan target");
  assert(explicitGate.stdout.includes("Target source: explicit"), "verify_gate reports explicit plan targeting");
  assert(explicitGate.stdout.includes(`Pointer: plans/.current_plan → ${primaryPlan}`), "verify_gate keeps the pointer visible during explicit targeting");

  const foreignPlanPath = join(tmp, "plans", primaryPlan, "findings.md");
  const parallelSourcePath = join(tmp, "src", "parallel-ui.tsx");
  writeFileSync(foreignPlanPath, "# Pointer plan findings\n");
  mkdirSync(dirname(parallelSourcePath), { recursive: true });
  writeFileSync(parallelSourcePath, "export const ParallelUI = true;\n");
  const hookPayload = JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: parallelSourcePath },
    cwd: tmp,
  });
  const hook = run([postToolUseScript], tmp, parallelThreadEnv, hookPayload);
  assert(hook.ok, "post_tool_use exits cleanly under a thread-targeted session");

  const parallelTracePath = join(tmp, "plans", parallelPlan, "artifacts", "tool_trace.jsonl");
  assert(existsSync(parallelTracePath), "post_tool_use writes trace output into the thread-targeted plan");
  const parallelTrace = readFileSync(parallelTracePath, "utf-8");
  assert(parallelTrace.includes(`"plan_dir":"${parallelPlan}"`), "trace records attribute the tool call to the thread-targeted plan");
  assert(parallelTrace.includes(parallelSourcePath), "trace records keep the edited parallel source path as evidence");

  const parallelTelemetryPath = join(tmp, "plans", parallelPlan, "telemetry", "events.jsonl");
  assert(existsSync(parallelTelemetryPath), "post_tool_use also routes proof telemetry into the thread-targeted plan");
  const parallelTelemetry = readFileSync(parallelTelemetryPath, "utf-8");
  assert(parallelTelemetry.includes(`"plan_id":"${parallelPlan}"`), "proof telemetry records attribute the tool call to the thread-targeted plan");

  const pointerTracePath = join(tmp, "plans", primaryPlan, "artifacts", "tool_trace.jsonl");
  assert(!existsSync(pointerTracePath), "post_tool_use does not misroute the trace into the pointer plan");
  const pointerTelemetryPath = join(tmp, "plans", primaryPlan, "telemetry", "events.jsonl");
  assert(!existsSync(pointerTelemetryPath), "post_tool_use does not misroute proof telemetry into the pointer plan");

  const originalThread = process.env.CODEX_THREAD_ID;
  const originalTarget = process.env._PLANNER_PLAN_TARGET;

  process.env.CODEX_THREAD_ID = "thread-parallel";
  process.env._PLANNER_PLAN_TARGET = "";
  const refreshFromThread = refreshPlanArtifacts({
    cwd: tmp,
    refreshOntology: false,
    persistState: false,
    syncFindings: false,
  });
  assert(refreshFromThread?.planDirName === parallelPlan, "refreshPlanArtifacts honors the thread-targeted plan instead of the shared pointer");

  process.env._PLANNER_PLAN_TARGET = primaryPlan;
  const refreshFromEnv = refreshPlanArtifacts({
    cwd: tmp,
    refreshOntology: false,
    persistState: false,
    syncFindings: false,
  });
  assert(refreshFromEnv?.planDirName === primaryPlan, "refreshPlanArtifacts honors the explicit env plan target when present");

  if (typeof originalThread === "string") process.env.CODEX_THREAD_ID = originalThread;
  else delete process.env.CODEX_THREAD_ID;
  if (typeof originalTarget === "string") process.env._PLANNER_PLAN_TARGET = originalTarget;
  else delete process.env._PLANNER_PLAN_TARGET;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
