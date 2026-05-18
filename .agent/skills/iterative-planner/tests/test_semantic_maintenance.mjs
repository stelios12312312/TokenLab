#!/usr/bin/env node
// Focused coverage for fleet semantic maintenance and safe host repair.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { buildSemanticHealth } from "../scripts/lib/semantic_maintenance.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const scriptDir = join(skillDir, "scripts");
const NODE = process.execPath;

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-semantic-${name}-`));
}

function runNode(args, cwd, extraEnv = {}) {
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
          ...extraEnv,
        },
        timeout: 120000,
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      status: error.status || 1,
    };
  }
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert(false, `${label} emits valid JSON (${error.message})`);
    return null;
  }
}

function installPlanner(projectPath) {
  const result = runNode([join(scriptDir, "migrate.mjs"), "upgrade", projectPath], projectPath);
  assert(result.ok, "migrate upgrade installs planner into semantic-maintenance fixture");
}

function writeAuditConfig(projectPath, config) {
  writeFileSync(join(projectPath, "audit.config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function readAuditConfig(projectPath) {
  return JSON.parse(readFileSync(join(projectPath, "audit.config.json"), "utf-8"));
}

function scenarioStatusSplitting() {
  console.log("\nScenario: status splitting keeps observability/history out of semantic attention");
  const health = buildSemanticHealth({
    path: "/tmp/example",
    summary: {
      missing_count: 0,
      critical_missing_count: 0,
      stale_count: 0,
      setup_issue_count: 0,
    },
    second_pass_verification: {
      issues: [
        {
          surface: "telemetry_capture",
          code: "no_tool_trace_history",
          severity: "info",
          path: "/tmp/example/plans",
          message: "No tool trace history.",
        },
        {
          surface: "workflow_intelligence",
          code: "workflow_events_missing",
          severity: "info",
          path: "/tmp/example/plans/audit_log.json",
          message: "Workflow events missing.",
        },
      ],
    },
  });
  assert(health.planner_status === "current", "planner status stays current");
  assert(health.semantic_status === "satisfied", "info-only observability/history is not semantic_attention");
  assert(health.observability_status === "incomplete", "telemetry info maps to observability incomplete");
  assert(health.host_history_status === "debt", "workflow history info maps to host history debt");
}

function scenarioPersonaSafeRepair() {
  console.log("\nScenario: safe persona repair is additive and preserves fail_on");
  const tmp = makeTemp("persona");
  try {
    mkdirSync(join(tmp, "src", "models"), { recursive: true });
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    writeAuditConfig(tmp, { roles: ["core"], fail_on: ["HIGH"], ignore: ["legacy"] });
    writeFileSync(join(tmp, "planner.discovery.json"), `${JSON.stringify({
      archetype: "automation",
      notes: "automation orchestration workflow runner",
    }, null, 2)}\n`);
    writeFileSync(join(tmp, "requirements.txt"), "pandas\nnumpy\noptuna\n");
    writeFileSync(join(tmp, "src", "models", "backtest.py"), "def model():\n    return 'trueskill backtest optimizer'\n");
    writeFileSync(join(tmp, "scripts", "orchestrate.mjs"), "export const pipeline = 'automation orchestration scheduler workflow';\n");
    installPlanner(tmp);

    const scan = runNode([join(scriptDir, "semantic_maintenance.mjs"), "scan", tmp, "--json"], tmp);
    assert(scan.ok, "semantic maintenance scan exits cleanly");
    const scanJson = parseJson(scan, "persona scan");
    assert(scanJson?.semantic_health?.issues?.some((issue) => issue.repair_strategy === "persona_apply_safe"), "underfit persona issue is safe-repairable");

    const repair = runNode([join(scriptDir, "semantic_maintenance.mjs"), "repair", tmp, "--safe", "--json"], tmp);
    assert(repair.ok, "semantic maintenance repair exits cleanly");
    const config = readAuditConfig(tmp);
    assert(config.roles.includes("quant"), "repair adds quant seed role");
    assert(config.roles.includes("assumptions_challenger"), "repair adds assumptions challenger seed role");
    assert(config.roles.includes("wiring_auditor"), "repair adds wiring auditor seed role");
    assert(JSON.stringify(config.fail_on) === JSON.stringify(["HIGH"]), "repair preserves fail_on");
    assert(JSON.stringify(config.ignore) === JSON.stringify(["legacy"]), "repair preserves project-owned ignore options");
    assert(existsSync(join(tmp, "plans", "semantic_backlog", "semantic_issues.json")), "repair writes semantic backlog JSON");
    assert(existsSync(join(tmp, "plans", "semantic_backlog", "repair_plan.md")), "repair writes semantic repair plan");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioAutoCommitteeFalsePreserved() {
  console.log("\nScenario: explicit auto_committee false is preserved");
  const tmp = makeTemp("committee");
  try {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    writeAuditConfig(tmp, { roles: ["core"], auto_committee: false, fail_on: ["CRITICAL"] });
    writeFileSync(join(tmp, "scripts", "orchestrate.mjs"), "export const workflow = 'automation scheduler pipeline';\n");
    installPlanner(tmp);

    const repair = runNode([join(scriptDir, "semantic_maintenance.mjs"), "repair", tmp, "--safe", "--json"], tmp);
    assert(repair.ok, "repair with explicit auto_committee false exits cleanly");
    const config = readAuditConfig(tmp);
    assert(config.auto_committee === false, "repair does not override auto_committee:false");
    assert(JSON.stringify(config.fail_on) === JSON.stringify(["CRITICAL"]), "repair preserves CRITICAL fail_on");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioAnnotationRepairAndBacklog() {
  console.log("\nScenario: symmetric annotation repair and unknown-key backlog");
  const tmp = makeTemp("annotations");
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeAuditConfig(tmp, { roles: ["core"], fail_on: ["HIGH"] });
    writeFileSync(join(tmp, "src", "a.js"), [
      "// @planner:config_flag = flag_a",
      "// @planner:mutually_exclusive = flag_b",
      "export const a = true;",
      "",
    ].join("\n"));
    writeFileSync(join(tmp, "src", "b.js"), [
      "// @planner:config_flag = flag_b",
      "export const b = true;",
      "",
    ].join("\n"));
    writeFileSync(join(tmp, "src", "unknown.js"), [
      "// @planner:banana = true",
      "export const c = true;",
      "",
    ].join("\n"));
    installPlanner(tmp);

    const repair = runNode([join(scriptDir, "semantic_maintenance.mjs"), "repair", tmp, "--safe", "--json"], tmp);
    assert(repair.ok, "annotation repair exits cleanly");
    const bContent = readFileSync(join(tmp, "src", "b.js"), "utf-8");
    assert(bContent.includes("@planner:mutually_exclusive = flag_a"), "repair adds reverse mutual exclusion to the opposite flag file");
    const backlog = JSON.parse(readFileSync(join(tmp, "plans", "semantic_backlog", "semantic_issues.json"), "utf-8"));
    assert(backlog.issues.some((issue) => issue.status === "needs_human" && /Unknown annotation key: banana/.test(issue.message)), "unknown annotation key is kept as needs_human backlog");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioFleetScanIncludesSemanticHealth() {
  console.log("\nScenario: fleet scan includes semantic health");
  const tmp = makeTemp("fleet");
  try {
    const project = join(tmp, "project");
    mkdirSync(project, { recursive: true });
    writeAuditConfig(project, { roles: ["core"], fail_on: ["HIGH"] });
    installPlanner(project);
    const registryPath = join(tmp, "registry.json");
    writeFileSync(registryPath, JSON.stringify({
      source_project_path: resolve(skillDir, "..", ".."),
      last_scan: new Date().toISOString(),
      scan_roots: [tmp],
      projects: [{ path: project, type: "standard" }],
    }, null, 2) + "\n");

    const fleet = runNode([join(scriptDir, "semantic_maintenance.mjs"), "scan", "--all", "--json"], tmp, {
      PLANNER_PROJECT_REGISTRY_PATH: registryPath,
    });
    assert(fleet.ok, "semantic maintenance scan --all exits cleanly");
    const report = parseJson(fleet, "fleet scan");
    assert(report?.project_count === 1, "fleet scan sees registered project");
    assert(report?.projects?.[0]?.semantic_health?.planner_status, "fleet scan includes per-project semantic_health");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

scenarioStatusSplitting();
scenarioPersonaSafeRepair();
scenarioAutoCommitteeFalsePreserved();
scenarioAnnotationRepairAndBacklog();
scenarioFleetScanIncludesSemanticHealth();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
