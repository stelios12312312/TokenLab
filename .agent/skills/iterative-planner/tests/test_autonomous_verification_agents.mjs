#!/usr/bin/env node
// test_autonomous_verification_agents.mjs - t14 AVA minimal vertical slice.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadStateFacts, loadStoryFacts } from "../scripts/lib/fact_loader.mjs";
import { compileAvaFacts, evaluateAvaGate } from "../scripts/lib/autonomous_verification_agents.mjs";
import { gateValidateToClose } from "../scripts/verify_gate.mjs";
import { generateLiveGraphPayload } from "../../../../apps/ive-visualizer/scripts/generate-live-payload.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "../../..");

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function closeSignals() {
  return {
    planner_core: {
      required: false,
      satisfied: true,
      migration_smoke_verified: true,
      planner_journey_verified: true,
      proof_bundle_required: false,
      proof_bundle_verified: true,
    },
    test_evidence: {
      required: true,
      satisfied: true,
      status: "pass",
      code_paths: ["src/ava_target.mjs"],
      test_paths: [".agent/skills/iterative-planner/tests/test_autonomous_verification_agents.mjs"],
    },
    intent_evidence: { required: true, satisfied: true, status: "pass" },
    anti_recurrence: { required: true, satisfied: true, status: "pass" },
    learned_obligations: { required: false, satisfied: true, active_count: 0, satisfied_count: 0 },
    verification_obligation_synthesis: { required: true, satisfied: true, active_count: 1 },
    quant_results_validation: { required: false, satisfied: true, status: "not_required", blocking_issues: [] },
    review_intake: { required: false, satisfied: true, unresolved_required_count: 0 },
    session_obligations: { required: false, satisfied: true },
    semantic_substrate: { required: false, satisfied: true },
    kb: { satisfied: true, status: "no_new_learnings", signoff_reason: "AVA fixture" },
  };
}

function seedRepo({ defectStatus = "active", withAnchor = true, sandbox = null } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "planner-ava-"));
  const planName = "plan_ava_fixture";
  const planDir = join(tmp, "plans", planName);
  mkdirSync(join(tmp, "plans"), { recursive: true });
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  mkdirSync(join(tmp, "src"), { recursive: true });
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeFileSync(join(tmp, "src", "ava_target.mjs"), "export const target = true;\n");
  writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    stories: [
      {
        id: "US-AVA-001",
        title: "AVA-discovered defect blocks close",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: ["src/ava_target.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_autonomous_verification_agents.mjs"],
        validation_refs: ["ava_defects.json"],
      },
    ],
    infrastructure_stories: [],
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "verification.md"), `# Verification

## Results
PASS: ordinary close proof is present.

\`\`\`
focused AVA fixture proof
\`\`\`

## Regression Audit
AVA must block close when it synthesizes an active defect.
`);
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "validate",
    goal: "AVA fixture",
    plan_dir: planName,
    close_signals: closeSignals(),
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "ava_defects.json"), JSON.stringify({
    schema_version: 1,
    runs: [
      {
        id: "AVA-RUN-001",
        persona: "ava:adversarial",
        sandbox: sandbox || {
          database: "in_memory",
          network: "interdicted",
          time_budget_ms: 5000,
          action_budget: 8,
        },
        defects: [
          {
            id: "AVA-DEF-001",
            type: "prov:Defect",
            status: defectStatus,
            summary: "Adversarial AVA found a runtime defect.",
            story_refs: ["US-AVA-001"],
            code_anchor_refs: withAnchor ? ["src/ava_target.mjs:1"] : [],
            evidence_refs: ["verification.md#ava"],
            replay: { command: "node src/ava_target.mjs", exit_code: 1 },
          },
        ],
      },
    ],
  }, null, 2) + "\n");
  return { tmp, planDir, planName };
}

function scenarioActiveDefectBlocksPrologAndGate() {
  const { tmp, planDir } = seedRepo();
  try {
    const evaluation = evaluateAvaGate({ planDir, repoRoot: tmp });
    assert(evaluation.present === true, "AVA artifact is detected");
    assert(evaluation.satisfied === false, "active AVA defect is a blocking issue");
    assert(evaluation.blocking_issues.some((issue) => issue.includes("ava_active_defect:AVA-DEF-001")), "active defect blocker is named");

    const facts = compileAvaFacts({ planDir, repoRoot: tmp });
    const session = createSession();
    session.consultFile(join(skillDir, "prolog", "invariants.pl"));
    loadStoryFacts(session, { cwd: tmp });
    loadStateFacts(session, { cwd: tmp, skillPath: skillDir });
    session.consult(facts.prolog);
    assert(session.check("invariant_violated(ava_active_defect, info('US-AVA-001', 'AVA-DEF-001'))"), "I-055 blocks a story with an active AVA defect");

    const gateResults = gateValidateToClose(planDir);
    assert(gateResults.some((result) => result.status === "FAIL" && /AVA/.test(result.name) && /AVA-DEF-001/.test(result.detail || "")), "validate-to-close surfaces a readable AVA blocker");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioMissingAnchorBlocksI056() {
  const { tmp, planDir } = seedRepo({ withAnchor: false });
  try {
    const facts = compileAvaFacts({ planDir, repoRoot: tmp });
    const session = createSession();
    session.consultFile(join(skillDir, "prolog", "invariants.pl"));
    loadStoryFacts(session, { cwd: tmp });
    loadStateFacts(session, { cwd: tmp, skillPath: skillDir });
    session.consult(facts.prolog);
    assert(session.check("invariant_violated(ava_defect_missing_anchor, 'AVA-DEF-001')"), "I-056 blocks an AVA defect without a physical code anchor");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioResolvedAnchoredDefectPasses() {
  const { tmp, planDir } = seedRepo({ defectStatus: "resolved" });
  try {
    const evaluation = evaluateAvaGate({ planDir, repoRoot: tmp });
    assert(evaluation.satisfied === true, "resolved anchored AVA defect does not block close");
    const gateResults = gateValidateToClose(planDir);
    assert(gateResults.some((result) => /AVA/.test(result.name) && result.status === "PASS"), "validate-to-close reports AVA pass for resolved anchored defect");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioSandboxFloorIsRequired() {
  const { tmp, planDir } = seedRepo({ sandbox: { database: "disk", network: "enabled", time_budget_ms: 0, action_budget: 0 } });
  try {
    const evaluation = evaluateAvaGate({ planDir, repoRoot: tmp });
    assert(evaluation.satisfied === false, "unsafe AVA sandbox floor blocks the gate");
    assert(evaluation.blocking_issues.some((issue) => issue.includes("ava_sandbox_floor_missing:AVA-RUN-001")), "sandbox floor blocker is named");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioLivePayloadSurfacesAvaDefect() {
  const { tmp, planDir } = seedRepo();
  try {
    const payload = generateLiveGraphPayload({
      repoRoot,
      planDir,
      invariantResult: {
        status: "pass",
        count: 0,
        violations: [],
      },
    });
    assert(payload.entities.ontology_facts.some((fact) => fact.type === "AutonomousVerificationAgent" && fact.label === "ava:adversarial"), "live payload exposes AVA agent fact");
    assert(payload.entities.ontology_facts.some((fact) => fact.type === "AvaDefect" && String(fact.label || "").startsWith("ava_")), "live payload exposes AVA defect fact");
    assert(payload.invariant_violations.some((violation) => violation.id === "ava_active_defect"), "live payload exposes AVA invariant violation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nAutonomous Verification Agents (t14)\n");

scenarioActiveDefectBlocksPrologAndGate();
scenarioMissingAnchorBlocksI056();
scenarioResolvedAnchoredDefectPasses();
scenarioSandboxFloorIsRequired();
scenarioLivePayloadSurfacesAvaDefect();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
