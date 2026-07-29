#!/usr/bin/env node
// test_incident_contract.mjs — deterministic incident rectification contract tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import {
  buildIncidentContract,
  evaluateIncidentCloseout,
  loadIncidentPreflightRegistry,
} from "../scripts/lib/incident_contract.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const NODE = process.execPath;
const CLI = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "incident_contract.mjs");

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `incident-contract-${name}-`));
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function seedPlan(root, planName, goal) {
  const dir = join(root, "plans", planName);
  ensureDir(dir);
  const state = createInitialStateJson(planName, goal, { projectRoot: root });
  state.state = "VALIDATE";
  writeStateJson(dir, state);
  writeFileSync(join(dir, "plan.md"), `# Plan

## Goal
${goal}

## Incident Contract
[INCIDENT_CONTRACT_REQUIRED]
`, "utf-8");
  writeFileSync(join(dir, "verification.md"), "# Verification\n", "utf-8");
  return dir;
}

console.log("\nIncident Contract Tests\n");

{
  const text = [
    "UFC WFO Optuna/report wiring is screwed up.",
    "Prediction provider might be none, ML strategies show missing_prediction, Optuna trial count may not match budget,",
    "and the canonical HTML report may be consuming default params instead of nested best params.",
    "Need temporal/leakage proof before ROI is interpreted.",
  ].join(" ");
  const contract = buildIncidentContract({ entrypoint: "retro", text });
  const preflightIds = contract.required_preflights.map((entry) => entry.id);
  const closeoutGateIds = contract.closeout_gates.map((entry) => entry.id);

  assert(contract.status === "required", "UFC WFO text requires an incident contract");
  assert(contract.incident.suspected_failure_classes.includes("quant_wfo"), "contract detects quant WFO shape");
  assert(contract.incident.suspected_failure_classes.includes("dead_signal_or_prediction_fallback"), "contract detects dead signal/fallback shape");
  assert(contract.incident.suspected_failure_classes.includes("report_artifact_lineage"), "contract detects report artifact lineage shape");
  assert(contract.persona.required_packs.includes("quant") && contract.persona.required_packs.includes("wiring_auditor"), "contract activates quant and wiring personas");
  assert(preflightIds.includes("prediction_provider_not_none"), "contract requires prediction_provider_not_none preflight");
  assert(preflightIds.includes("ml_missing_prediction_zero"), "contract requires missing_prediction zero preflight");
  assert(preflightIds.includes("optuna_study_trial_count"), "contract requires Optuna study/trial preflight");
  assert(preflightIds.includes("best_params_consumed_by_report"), "contract requires best-param consumption proof");
  assert(preflightIds.includes("temporal_leakage_proof"), "contract requires temporal/leakage proof");
  assert(preflightIds.includes("artifact_freshness_lineage"), "contract requires artifact lineage proof");
  assert(preflightIds.includes("report_semantic_acceptance_review"), "contract requires report semantic acceptance preflight");
  assert(closeoutGateIds.includes("report_semantic_acceptance"), "contract requires report semantic acceptance closeout gate");
  assert(contract.state_mutated === false && contract.preflight_registry.state_mutated === false, "contract reports state_mutated=false");
}

{
  const out = JSON.parse(execFileSync(NODE, [
    CLI,
    "check",
    "--entrypoint",
    "advisor",
    "--program",
    "plans/programs/incident-rectification-orchestration/program_packet.json",
    "--ticket",
    "T-INTAKE-79834C1C",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env: plannerSubprocessEnv() }));

  assert(out.ok === true && out.contract.status === "required", "CLI builds a required contract for the front-door Program Packet ticket");
  assert(out.contract.source.ticket_id === "T-INTAKE-79834C1C", "CLI preserves Program Packet ticket id");
  assert(out.contract.closeout_gates.some((entry) => entry.id === "advisor_persona_findings_consumed"), "CLI contract includes advisor/persona closeout gate");
}

{
  const tmp = makeTemp("closeout");
  try {
    const planName = "plan_incident_closeout";
    const planDir = seedPlan(tmp, planName, "Fix UFC WFO Optuna/report wiring incident");
    const contract = buildIncidentContract({
      cwd: tmp,
      entrypoint: "incident",
      text: "UFC WFO Optuna missing_prediction prediction_provider none best params report lineage temporal leakage",
      activePlan: planName,
    });
    writeJson(join(planDir, "incident_contract.json"), contract);

    const missing = evaluateIncidentCloseout({ cwd: tmp, planDir });
    assert(missing.required === true && missing.satisfied === false, "incident closeout fails when contract evidence is missing");
    assert(missing.missing.some((entry) => entry.includes("prediction_provider_not_none")), "closeout names missing required preflight id");

    const passLines = [
      "# Verification",
      "",
      "## Incident Closeout",
      "incident_contract_present PASS: incident_contract.json generated and reviewed.",
      "advisor_persona_findings_consumed PASS: advisor and persona obligations consumed.",
      "incident_preflight_rows_pass PASS: all required rows below passed.",
      "rerun_command_and_artifact_lineage PASS: command and artifact lineage recorded.",
      "report_semantic_acceptance PASS: operator question answered, report family and lineage recorded, diagnostic rows retained, recommendations and stop conditions stated, claims not promoted documented.",
      "quant_false_green_guards PASS: prediction_provider != none, 0 missing_prediction, Optuna study/trial budget, best params consumed by canonical report, temporal/leakage proof.",
      "residual_risk_recorded PASS: no residual unverified risk beyond local fixture boundaries.",
      ...contract.required_preflights.map((entry) => `${entry.id} PASS: ${entry.evidence_terms.join(", ")} evidence recorded.`),
      "",
    ].join("\n");
    writeFileSync(join(planDir, "verification.md"), passLines, "utf-8");

    const passedCloseout = evaluateIncidentCloseout({ cwd: tmp, planDir });
    assert(passedCloseout.satisfied === true, "incident closeout passes when every gate and preflight row has PASS evidence");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp("plugins");
  try {
    writeJson(join(tmp, ".agent", "incident_preflight_plugins.json"), {
      version: 1,
      plugins: [
        {
          id: "unsafe_writer",
          applies_to: ["quant_wfo"],
          state_mutated: true,
          command_or_action: "This host plugin would mutate state.",
        },
      ],
    });
    const registry = loadIncidentPreflightRegistry({ cwd: tmp });
    assert(!registry.plugins.some((entry) => entry.id === "unsafe_writer"), "state-mutating host plugin is rejected");
    assert(registry.warnings.some((entry) => entry.code === "state_mutating_plugin_rejected"), "unsafe plugin rejection is surfaced as a warning");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
