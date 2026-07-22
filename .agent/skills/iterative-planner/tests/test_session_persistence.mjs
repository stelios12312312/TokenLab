#!/usr/bin/env node
// test_session_persistence.mjs — e07 disk-first session funnel regressions.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

import {
  createInitialStateJson,
  readStateJson,
  writeStateJson,
} from "../scripts/lib/determinism.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const NODE = process.execPath;
const bootstrapScript = join(skillDir, "scripts", "bootstrap.mjs");
const verifyGateScript = join(skillDir, "scripts", "verify_gate.mjs");
const determinismModule = pathToFileURL(join(skillDir, "scripts", "lib", "determinism.mjs")).href;

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

function makeTemp(prefix) {
  return mkdtempSync(join(tmpdir(), `planner-e07-${prefix}-`));
}

function runNode(args, cwd, extraEnv = {}) {
  const result = spawnSync(NODE, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      _PLANNER_PLAN_TARGET: "",
      PLANNER_SKIP_SELF_HEAL: "1",
      ...extraEnv,
    },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function seedProject(cwd, goal) {
  symlinkSync(agentDir, join(cwd, ".agent"), "dir");
  writeJson(join(cwd, "audit.config.json"), {
    roles: ["core", "assumptions_challenger", "config_integrity", "traceability"],
    fail_on: ["CRITICAL"],
  });
  const created = runNode([bootstrapScript, "new", goal], cwd);
  assert(created.ok, `bootstrap new succeeds for ${goal}`);
  const planName = readFileSync(join(cwd, "plans", ".current_plan"), "utf-8").trim();
  const planDir = join(cwd, "plans", planName);
  return { planName, planDir };
}

function writeAssumptionLedger(planDir, status = "UNVALIDATED") {
  writeJson(join(planDir, "findings_ledger.json"), {
    version: 1,
    fast_track: true,
    findings: [
      {
        id: "F-001",
        title: "Disk-first obligations must survive context loss",
        summary: "Resume should reconstruct active assumptions from files, not chat memory.",
        details: [
          "The assumption is intentionally load-bearing so CLOSE must not pass while it is unresolved.",
          "The fixture uses findings_ledger.json because it is the structured source already read by planner gates."
        ],
      },
    ],
    root_cause: { summary: "Session obligations are currently implicit in chat context." },
    adjacency: { summary: "bootstrap resume/status, validate-to-close, and ontology facts consume the same ledger." },
    assumptions: [
      {
        id: "A-001",
        status,
        statement: "Gate-close proof can rely on reconstructed disk obligations.",
        load_bearing: true,
        supports: ["sc_1"],
        probe: "node .agent/skills/iterative-planner/scripts/bootstrap.mjs resume",
      },
    ],
  });
}

const directTmp = makeTemp("direct-write");
try {
  const planDir = join(directTmp, "plans", "plan_direct_write");
  mkdirSync(planDir, { recursive: true });
  writeStateJson(planDir, createInitialStateJson("plan_direct_write", "Direct phase write fixture", { projectRoot: directTmp }));

  const directWrite = runNode([
    "--input-type=module",
    "-e",
    `
      import { readStateJson, writeStateJson } from ${JSON.stringify(determinismModule)};
      const planDir = ${JSON.stringify(planDir)};
      const state = readStateJson(planDir);
      state.state = "EXECUTE";
      const ok = writeStateJson(planDir, state);
      console.log(JSON.stringify({ ok, state: readStateJson(planDir)?.state }));
      process.exit(ok ? 0 : 2);
    `,
  ], directTmp, {
    PLANNER_SKIP_SELF_HEAL: "",
    PLANNER_ALLOW_DIRECT_STATE_SETUP: "",
  });
  const after = readStateJson(planDir);
  assert(!directWrite.ok, "direct writeStateJson phase mutation is refused outside the funnel");
  assert(after?.state === "EXPLORE", "refused direct phase write leaves state.json unchanged");
} finally {
  rmSync(directTmp, { recursive: true, force: true });
}

const resumeTmp = makeTemp("resume");
try {
  const { planDir } = seedProject(resumeTmp, "e07 resume reconstructs disk obligations");
  writeAssumptionLedger(planDir, "UNVALIDATED");
  const activeAlias = join(resumeTmp, "plans", "ACTIVE_PLAN.json");
  if (existsSync(activeAlias)) rmSync(activeAlias, { force: true });

  const resumed = runNode([bootstrapScript, "resume"], resumeTmp);
  assert(resumed.ok, "bootstrap resume exits cleanly after alias/context loss");
  assert(resumed.stdout.includes("Session obligations"), "bootstrap resume reconstructs session obligations from disk");
  assert(resumed.stdout.includes("A-001") && resumed.stdout.includes("UNVALIDATED"), "resume surfaces unresolved load-bearing assumption status");
} finally {
  rmSync(resumeTmp, { recursive: true, force: true });
}

const closeTmp = makeTemp("close-block");
try {
  const { planName, planDir } = seedProject(closeTmp, "e07 close blocks unresolved load-bearing assumptions");
  writeAssumptionLedger(planDir, "UNVALIDATED");
  const state = readStateJson(planDir);
  state.state = "VALIDATE";
  state.transitions.push({
    from: "REFLECT",
    to: "VALIDATE",
    timestamp: "2026-06-02T12:00:00.000Z",
    gate_result: "PASS",
    failure_codes: [],
    script_versions: {},
  });
  writeStateJson(planDir, state);

  const gate = runNode([verifyGateScript, "validate-to-close", "--plan", planName], closeTmp);
  const output = `${gate.stdout}\n${gate.stderr}`;
  assert(!gate.ok, "validate-to-close blocks unresolved load-bearing assumptions");
  assert(output.includes("Load-bearing assumptions resolved"), "validate-to-close reports the assumption-ledger close guard");
  assert(output.includes("A-001") && output.includes("UNVALIDATED"), "validate-to-close names the unresolved assumption");
} finally {
  rmSync(closeTmp, { recursive: true, force: true });
}

console.log(`\nSession persistence tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
