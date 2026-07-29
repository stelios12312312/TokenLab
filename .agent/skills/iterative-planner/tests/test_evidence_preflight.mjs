#!/usr/bin/env node
// test_evidence_preflight.mjs — read-only hotspot evidence preflight contracts.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { runEvidencePreflight } from "../scripts/lib/evidence_preflight.mjs";
import { buildIncidentContract } from "../scripts/lib/incident_contract.mjs";
import { stampRunRecordPayload } from "../scripts/lib/run_record.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const NODE = process.execPath;

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
  return mkdtempSync(join(tmpdir(), `evidence-preflight-${name}-`));
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeText(path, content) {
  ensureDir(dirname(path));
  writeFileSync(path, content);
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seedPlan(root, planName, stateName, goal) {
  const dir = join(root, "plans", planName);
  ensureDir(dir);
  const state = createInitialStateJson(planName, goal, { projectRoot: root });
  state.state = stateName;
  writeStateJson(dir, state);
  writeText(join(root, "plans", ".current_plan"), `${planName}\n`);
  return dir;
}

function seedStoryRegistry(root) {
  writeJson(join(root, "reports", "user_story_audit", "story_registry.json"), {
    stories: [
      {
        id: "US-PREFLIGHT-001",
        title: "Planner evidence preflight",
        status: "FULLY_COVERED",
        priority: "HIGH",
        code_refs: [".agent/skills/iterative-planner/scripts/evidence_preflight.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_evidence_preflight.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_evidence_preflight.mjs"],
      },
    ],
  });
}

function seedKnowledge(root) {
  const files = {
    "index.md": "# Knowledge Index\n\n- mistakes.md\n- patterns.md\n- gotchas.md\n",
    "mistakes.md": "# Mistakes\n\n## M-001\nPrior gate drift must be checked with real commands.\n",
    "patterns.md": "# Patterns\n\n## P-001\nMirror readers and reporters when adding diagnostics.\n",
    "gotchas.md": "# Gotchas\n\n## G-001\nGenerated planner state should not be edited by hand.\n",
  };
  for (const [name, content] of Object.entries(files)) {
    writeText(join(root, "plans", "knowledge", name), content);
  }
  return files["index.md"] + files["mistakes.md"] + files["patterns.md"] + files["gotchas.md"];
}

function runCli(root, args) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd: root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: plannerSubprocessEnv(),
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function scenarioPlanPreflightReportsMissingStoryLinkage() {
  const tmp = makeTemp("plan");
  try {
    seedStoryRegistry(tmp);
    const planName = "plan_evidence_preflight_plan";
    const dir = seedPlan(tmp, planName, "PLAN", "Connector workflow evidence preflight");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Connector workflow evidence preflight

## Problem Statement
The planner should report missing gate evidence before the hard transition.

## Files To Modify
- .agent/skills/iterative-planner/scripts/evidence_preflight.mjs

## Success Criteria
1. First criterion maps to an active story.
2. Second criterion is intentionally missing its active story linkage.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-PREFLIGHT-001 | Planner preflight CLI | proof:planner_smoke | node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --json | CLI reports PASS | None |
| sc_2 | TBD | Planner preflight diagnostics | proof:artifact_review | Inspect JSON actions | Missing evidence is actionable | None |
`);

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-PLN-016"] });
    const gate = result.gates[0];
    assert(result.ok === false, "plan preflight fails when a success criterion lacks active story linkage");
    assert(gate?.code === "GATE-PLN-016" && gate.status === "FAIL", "preflight identifies GATE-PLN-016");
    assert(gate?.missing?.some((entry) => entry.includes("sc_2")), "preflight names the missing criterion");
    assert(gate?.missing?.some((entry) => entry.includes("US-PREFLIGHT-001")), "preflight ranks story-linkage suggestions for missing criteria");
    assert(gate?.data?.suggestions?.some((entry) => entry.criterion_id === "sc_2" && entry.story_ids?.includes("US-PREFLIGHT-001")), "preflight exposes structured story-linkage suggestions");
    assert(gate?.actions?.some((entry) => entry.includes("Story linkage")), "preflight gives a concrete story-linkage repair action");

    const cli = runCli(tmp, [join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "evidence_preflight.mjs"), "check", "--plan", planName, "--gate", "GATE-PLN-016", "--json"]);
    assert(cli.status === 1, "CLI exits non-zero for missing evidence");
    const parsed = JSON.parse(cli.stdout);
    assert(parsed.gates?.[0]?.missing?.some((entry) => entry.includes("sc_2")), "CLI JSON preserves actionable missing evidence");
    assert(parsed.gates?.[0]?.data?.suggestions?.some((entry) => entry.story_ids?.includes("US-PREFLIGHT-001")), "CLI JSON preserves structured story-linkage suggestions");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioCloseSignalPreflightDoesNotMutateState() {
  const tmp = makeTemp("close");
  try {
    const planName = "plan_evidence_preflight_close";
    const dir = seedPlan(tmp, planName, "REFLECT", "Close evidence preflight");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Close evidence preflight

## Problem Statement
The planner should show generated close-signal gaps without writing state.json.

## Files To Modify
- docs/example.md
`);
    writeText(join(dir, "progress.md"), [
      "# Progress",
      "",
      "- [x] Implement the read-only helper.",
      "- [ ] Record verification evidence.",
      "",
    ].join("\n"));
    writeText(join(dir, "reflection.md"), "# Reflection\n\n## Knowledge Base Sign-Off\nDecision: pending\n");
    writeText(join(dir, "verification.md"), "# Verification\n");

    const before = readFileSync(join(dir, "state.json"), "utf-8");
    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-REF-003", "GATE-VAL-010"] });
    const after = readFileSync(join(dir, "state.json"), "utf-8");
    const progressGate = result.gates.find((gate) => gate.code === "GATE-REF-003");
    const plannerCoreGate = result.gates.find((gate) => gate.code === "GATE-VAL-010");

    assert(before === after, "close-signal preflight does not mutate state.json");
    assert(result.state_mutated === false, "preflight reports state_mutated=false");
    assert(progressGate?.status === "FAIL", "progress preflight reports open progress evidence");
    assert(progressGate?.actions?.some((entry) => entry.includes("progress.md")), "progress preflight points at progress.md repair");
    assert(plannerCoreGate?.status === "NOT_REQUIRED", "planner-core preflight is not required for non-planner files");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioRegistryHashMismatchPredictsSemanticFailure() {
  const tmp = makeTemp("registry");
  try {
    seedStoryRegistry(tmp);
    const planName = "plan_evidence_preflight_registry";
    const dir = seedPlan(tmp, planName, "REFLECT", "Registry hash preflight");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Registry hash preflight

## Problem Statement
The planner should detect registry hash mismatch before the semantic gate fires.

## Files To Modify
- docs/example.md
`);
    writeText(join(dir, "progress.md"), "# Progress\n\n- [x] All done\n");
    writeText(join(dir, "reflection.md"), "# Reflection\n\n## Knowledge Base Sign-Off\nDecision: no_new_learnings\nReason: fixture\n");
    writeText(join(dir, "verification.md"), "# Verification\n\nAll PASS.\n");

    // Simulate a signed transition hash, then mutate the registry.
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
    state.registry_hash = "00000000000000000000000000000000";
    writeJson(join(dir, "state.json"), state);

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-SEM-001"] });
    const registryGate = result.gates.find((gate) => gate.source === "registry_hash");

    assert(registryGate?.code === "GATE-SEM-001", "registry mismatch is predicted as GATE-SEM-001");
    assert(registryGate?.status === "FAIL", "registry mismatch preflight FAILS");
    assert(registryGate?.missing?.some((entry) => entry.includes("registry_hash")), "preflight names the hash mismatch");
    assert(registryGate?.actions?.some((entry) => entry.includes("transition")), "preflight tells the agent to run a transition");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioMissingAntiRecurrenceGuardIsPredicted() {
  const tmp = makeTemp("antirec");
  try {
    const planName = "plan_evidence_preflight_antirec";
    const dir = seedPlan(tmp, planName, "REFLECT", "Fix a bug in the connector");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Fix a bug in the connector

## Problem Statement
Bug-fix plans need an anti-recurrence guard.

## Files To Modify
- src/connector.mjs
`);
    writeText(join(dir, "progress.md"), "# Progress\n\n- [x] All done\n");
    writeText(join(dir, "reflection.md"), "# Reflection\n\n## Knowledge Base Sign-Off\nDecision: no_new_learnings\nReason: fixture\n");
    writeText(join(dir, "verification.md"), "# Verification\n\nAll PASS.\n");

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-VAL-013"] });
    const gate = result.gates[0];

    assert(gate?.code === "GATE-VAL-013", "anti-recurrence preflight identifies GATE-VAL-013");
    assert(gate?.status === "FAIL", "missing anti-recurrence guard FAILS preflight");
    assert(gate?.missing?.some((entry) => /anti[- ]?recurrence/i.test(entry)), "preflight names missing anti-recurrence evidence");
    assert(gate?.actions?.some((entry) => entry.includes("Anti-Recurrence Guard")), "preflight gives anti-recurrence repair action");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioPreflightDoesNotBackfillScaffoldSections() {
  const tmp = makeTemp("scaffold-readonly");
  try {
    seedStoryRegistry(tmp);
    const planName = "plan_evidence_preflight_scaffold_readonly";
    const dir = seedPlan(tmp, planName, "PLAN", "Connector workflow evidence preflight");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Connector workflow evidence preflight

## Files To Modify
- src/connector.mjs
`);

    const before = readFileSync(join(dir, "plan.md"), "utf-8");
    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-PLN-016"] });
    const after = readFileSync(join(dir, "plan.md"), "utf-8");

    assert(before === after, "evidence preflight leaves plan.md unchanged (scaffold backfill is disabled for read-only preflight)");
    assert(result.state_mutated === false, "preflight reports state_mutated=false when scaffold backfill is disabled");
    assert(!/## Execution Steps/.test(after), "preflight does not inject Execution Steps");
    assert(!/## Verification Obligation Synthesis/.test(after), "preflight does not inject Verification Obligation Synthesis");
    assert(!/## Semantic Upkeep Contract/.test(after), "preflight does not inject Semantic Upkeep Contract");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioMissingIntentEvidenceIsPredicted() {
  const tmp = makeTemp("intent");
  try {
    const planName = "plan_evidence_preflight_intent";
    const dir = seedPlan(tmp, planName, "REFLECT", "Build a user-facing report");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Build a user-facing report

## Problem Statement
Goal-shaped work requires intent evidence.

## Files To Modify
- src/report.mjs
`);
    writeText(join(dir, "progress.md"), "# Progress\n\n- [x] All done\n");
    writeText(join(dir, "reflection.md"), "# Reflection\n\n## Knowledge Base Sign-Off\nDecision: no_new_learnings\nReason: fixture\n");
    writeText(join(dir, "verification.md"), "# Verification\n\nAll PASS.\n");
    writeJson(join(dir, "intent_contract.json"), {
      primary_user: "analyst",
      job_to_be_done: "view metrics",
      desired_outcomes: ["clear metrics"],
      anti_goals: ["wrong data"],
      deliverables: [
        { id: "report", name: "Metrics report", required: true, quality_bars: ["rendered"] },
      ],
    });

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-VAL-012"] });
    const gate = result.gates[0];

    assert(gate?.code === "GATE-VAL-012", "intent-evidence preflight identifies GATE-VAL-012");
    assert(gate?.status === "FAIL", "missing deliverable evidence FAILS preflight");
    assert(gate?.missing?.some((entry) => entry.includes("report")), "preflight names the missing deliverable");
    assert(gate?.actions?.some((entry) => entry.includes("verification.md")), "preflight points at verification.md repair");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioContextMatrixPreflightPredictsBoundaryFailure() {
  const tmp = makeTemp("pln017-boundary");
  try {
    seedStoryRegistry(tmp);
    const planName = "plan_evidence_preflight_pln017_boundary";
    const dir = seedPlan(tmp, planName, "PLAN", "Add Slack connector transport boundary");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Add Slack connector transport boundary

## Problem Statement
Connector boundary plans need context-sensitive verification.

## Files To Modify
- src/connectors/slack_connector.mjs

## Success Criteria
1. sc_1 - Connector dry-run proves the transport boundary.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| sc_1 | US-PREFLIGHT-001 | node test | PASS |
`);

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-PLN-017"] });
    const gate = result.gates[0];

    assert(gate?.code === "GATE-PLN-017", "context matrix preflight identifies GATE-PLN-017");
    assert(gate?.status === "FAIL", "boundary-shaped connector plan without context matrix FAILS preflight");
    assert(gate?.missing?.some((entry) => entry.includes("Repo/system context")), "preflight names missing context matrix columns");
    assert(gate?.actions?.some((entry) => entry.includes("verification_matrix.mjs lint")), "preflight names matrix lint command");
    assert(result.state_mutated === false, "PLN-017 preflight reports state_mutated=false");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioCrawlerExtractorDoesNotTriggerContextMatrix() {
  const tmp = makeTemp("pln017-crawler");
  try {
    seedStoryRegistry(tmp);
    const planName = "plan_evidence_preflight_crawler_extractor";
    const dir = seedPlan(tmp, planName, "PLAN", "Fix crawler extractor article content output");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Fix crawler extractor article content output

## Problem Statement
The crawler extractor fixture is content parsing and report output work.

## Files To Modify
- crawler_extractor/extractor.py

## Success Criteria
1. sc_1 - Extracted article body is present in the report.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| sc_1 | US-PREFLIGHT-001 | Run fixture extraction and inspect output artifact | Article body is present |
`);

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-PLN-017"] });
    const gate = result.gates[0];

    assert(gate?.code === "GATE-PLN-017", "crawler extractor regression evaluates GATE-PLN-017");
    assert(gate?.status !== "FAIL", "crawler extractor false-positive does not require the context-sensitive matrix");
    assert(gate?.data?.synthesis_required === false, "crawler extractor regression has no synthesized boundary obligation");
    assert(result.state_mutated === false, "crawler extractor preflight reports state_mutated=false");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioSemanticUpkeepContractPreflight() {
  const tmp = makeTemp("pln020");
  try {
    const planName = "plan_evidence_preflight_pln020";
    const dir = seedPlan(tmp, planName, "PLAN", "Update planner gate diagnostics");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Update planner gate diagnostics

## Problem Statement
The semantic upkeep contract is intentionally missing.

## Files To Modify
- .agent/skills/iterative-planner/scripts/verify_gate.mjs
`);

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-PLN-020"] });
    const gate = result.gates[0];

    assert(gate?.code === "GATE-PLN-020", "semantic upkeep preflight identifies GATE-PLN-020");
    assert(gate?.status === "FAIL", "missing Semantic Upkeep Contract FAILS preflight");
    assert(gate?.artifact?.includes("Semantic Upkeep Contract"), "preflight names the missing Semantic Upkeep Contract section");
    assert(gate?.actions?.some((entry) => entry.includes("GATE-PLN-020")), "preflight names the PLN-020 retry command");
    assert(result.state_mutated === false, "PLN-020 preflight reports state_mutated=false");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioKbTagPreflight() {
  const tmp = makeTemp("pln021-none");
  try {
    const planName = "plan_evidence_preflight_pln021_none";
    const dir = seedPlan(tmp, planName, "PLAN", "Update unrelated docs wording");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Update unrelated docs wording

## Problem Statement
No active KB learning should match this lightweight wording change.

## Files To Modify
- docs/readme.md
`);

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-PLN-021"] });
    const gate = result.gates[0];

    assert(gate?.code === "GATE-PLN-021", "KB tag preflight identifies GATE-PLN-021");
    assert(gate?.status === "NOT_REQUIRED", "missing KB tag is not required when no active KB hit exists");
    assert(gate?.detail?.includes("KB marker is not required"), "preflight explains why PLN-021 is not required");
    assert(result.state_mutated === false, "PLN-021 preflight reports state_mutated=false");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioKbTagPreflightRequiresRealHit() {
  const tmp = makeTemp("pln021-hit");
  try {
    seedKnowledge(tmp);
    const planName = "plan_evidence_preflight_pln021_hit";
    const dir = seedPlan(tmp, planName, "PLAN", "Fix prior gate drift with real commands");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Fix prior gate drift with real commands

## Problem Statement
This intentionally matches an active KB learning but omits the KB marker.

## Files To Modify
- .agent/skills/iterative-planner/scripts/lib/evidence_preflight.mjs
`);

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-PLN-021"] });
    const gate = result.gates[0];

    assert(gate?.code === "GATE-PLN-021", "KB-hit preflight identifies GATE-PLN-021");
    assert(gate?.status === "FAIL", "missing KB tag fails when a deterministic KB hit exists");
    assert(gate?.missing?.some((entry) => entry.includes("KB application marker")), "preflight names missing KB marker for real hit");
    assert(gate?.actions?.some((entry) => entry.includes("[KB_APPLIED:")), "preflight suggests concrete KB_APPLIED tag");
    assert(result.state_mutated === false, "PLN-021 real-hit preflight reports state_mutated=false");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioKbDigestPreflight() {
  const tmp = makeTemp("exp010");
  try {
    const kbContent = seedKnowledge(tmp);
    const planName = "plan_evidence_preflight_exp010";
    const dir = seedPlan(tmp, planName, "EXPLORE", "Update planner KB digest diagnostics");
    writeText(join(dir, "findings.md"), "# Findings\n\n## F-001\nKB was read but salt is intentionally missing.\n");
    writeJson(join(dir, "findings_ledger.json"), {
      version: 1,
      fast_track: false,
      kb_digest_salt: null,
      findings: [
        {
          id: "F-001",
          title: "KB digest fixture",
          analysis: ["KB was read but the salt is intentionally missing."],
        },
      ],
    });
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
    const salt = "a".repeat(32);
    state.kb_digest_hash = createHash("sha256").update(salt + kbContent).digest("hex").slice(0, 32);
    writeStateJson(dir, state);

    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-EXP-010"] });
    const gate = result.gates[0];

    assert(gate?.code === "GATE-EXP-010", "KB digest preflight identifies GATE-EXP-010");
    assert(gate?.status === "FAIL", "missing KB digest salt FAILS preflight when state hash exists");
    assert(gate?.missing?.some((entry) => entry.includes("[KB_DIGEST:<salt>]")), "preflight names missing KB_DIGEST marker");
    assert(gate?.actions?.some((entry) => entry.includes("findings_ledger.json")), "preflight names findings_ledger repair");
    assert(result.state_mutated === false, "EXP-010 preflight reports state_mutated=false");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioIncidentCloseoutPreflight() {
  const tmp = makeTemp("incident-closeout");
  try {
    const planName = "plan_evidence_preflight_incident";
    const dir = seedPlan(tmp, planName, "VALIDATE", "Fix UFC WFO Optuna/report wiring incident");
    writeText(join(dir, "plan.md"), `# Plan

## Goal
Fix UFC WFO Optuna/report wiring incident

## Incident Contract
[INCIDENT_CONTRACT_REQUIRED]
`);
    writeText(join(dir, "verification.md"), "# Verification\n\nPASS placeholder but no incident closeout rows.\n");
    const contract = buildIncidentContract({
      cwd: tmp,
      entrypoint: "incident",
      text: "UFC WFO Optuna missing_prediction prediction_provider none best params report lineage temporal leakage",
      activePlan: planName,
    });
    writeJson(join(dir, "incident_contract.json"), contract);

    const before = readFileSync(join(dir, "state.json"), "utf-8");
    const result = runEvidencePreflight({ cwd: tmp, plan: planName, gates: ["GATE-VAL-022"] });
    const after = readFileSync(join(dir, "state.json"), "utf-8");
    const gate = result.gates[0];

    assert(gate?.code === "GATE-VAL-022", "incident closeout preflight identifies GATE-VAL-022");
    assert(gate?.status === "FAIL", "missing incident closeout evidence FAILS preflight");
    assert(gate?.missing?.some((entry) => entry.includes("prediction_provider_not_none")), "preflight names missing incident preflight row");
    assert(gate?.actions?.some((entry) => entry.includes("Incident Closeout")), "preflight points at Incident Closeout repair");
    assert(before === after, "incident closeout preflight does not mutate state.json");
    assert(result.state_mutated === false, "GATE-VAL-022 preflight reports state_mutated=false");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function diagnosticResultArtifact(claimedDataSources) {
  return stampRunRecordPayload({
    version: 1,
    applicable: true,
    run_class: "wiring_proof",
    promotion_verdict: "diagnostic_only",
    search: {
      trials_completed: 1,
      unique_parameter_count: 1,
      objective_handling: "sampled",
    },
    controls: [],
    evidence: {
      claimed_data_sources: claimedDataSources,
      strongest_counterargument: "The environment may not contain the intended database.",
      falsification_criteria: "The result is unsupported if the claimed database is absent, empty, stale, or belongs to another worktree.",
      presentation_stamp: "diagnostic_only",
    },
  }, {
    producer: "verification_runner",
    row_id: "VM-PREFLIGHT-QUANT-RESULT",
    command: "/bin/sh -c 'printf result-ok && exit 0'",
    exit_code: 0,
    timestamp: "2026-07-17T10:00:00.000Z",
  });
}

function seedResultPlan(root, planName, claimedDataSources) {
  const dir = seedPlan(root, planName, "REFLECT", "Validate a diagnostic quant result environment");
  writeText(join(dir, "plan.md"), `# Plan

## Goal
Validate a diagnostic quant result environment

## Problem Statement
The quant backtest result reports 0 of 1000 populated rows and must not support a verdict from the wrong database.

## Files To Modify
- src/model_runner.mjs
`);
  writeText(join(dir, "verification.md"), "# Verification\n\nDiagnostic result: 0/1000 populated rows.\n");
  writeText(join(dir, "reflection.md"), "# Reflection\n");
  writeJson(join(dir, "quant_results_validation.json"), diagnosticResultArtifact(claimedDataSources));
  return dir;
}

function scenarioQuantResultPreflightExposesEnvironmentReceiptReadOnly() {
  const parent = makeTemp("quant-environment");
  const activeRoot = join(parent, "active");
  const siblingRoot = join(parent, "sibling");
  ensureDir(activeRoot);
  ensureDir(siblingRoot);
  const siblingDatabase = join(siblingRoot, "soccer.db");
  writeFileSync(siblingDatabase, "");
  try {
    const planName = "plan_evidence_preflight_quant_environment";
    const dir = seedResultPlan(activeRoot, planName, [
      {
        id: "soccer_database",
        path: siblingDatabase,
        expected_worktree_root: siblingRoot,
        freshness: { max_age_seconds: 86400 },
      },
    ]);
    const before = readFileSync(join(dir, "state.json"), "utf-8");
    const result = runEvidencePreflight({
      cwd: activeRoot,
      plan: planName,
      gates: ["GATE-REF-017", "GATE-VAL-016"],
    });
    const after = readFileSync(join(dir, "state.json"), "utf-8");

    for (const code of ["GATE-REF-017", "GATE-VAL-016"]) {
      const gate = result.gates.find((entry) => entry.code === code);
      assert(gate?.status === "FAIL", `${code} preflight blocks the empty sibling-worktree source`);
      assert(gate?.data?.status === "environment_invalid", `${code} exposes environment_invalid close-signal status`);
      assert(gate?.data?.numeric_output_reportable === false, `${code} exposes non-reportable numeric output`);
      assert(gate?.data?.environment_preflight_receipt?.probe_count === 1, `${code} exposes the one-source environment receipt`);
    }
    assert(before === after && result.state_mutated === false, "quant-result evidence preflight leaves state.json byte-identical");

    const cli = runCli(activeRoot, [
      join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "evidence_preflight.mjs"),
      "check",
      "--plan",
      planName,
      "--gate",
      "GATE-REF-017",
      "--json",
    ]);
    const parsed = JSON.parse(cli.stdout);
    assert(cli.status === 1, "environment-invalid result preflight CLI exits non-zero");
    assert(parsed.gates?.[0]?.data?.environment_preflight_receipt?.sources?.[0]?.bytes === 0, "CLI JSON preserves the computed zero-byte receipt");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function scenarioQuantResultPreflightPassesValidActiveSource() {
  const root = makeTemp("quant-valid");
  try {
    const database = join(root, "soccer.db");
    writeFileSync(database, "non-empty active-worktree database\n");
    const stableTime = new Date(Date.now() - 5000);
    utimesSync(database, stableTime, stableTime);
    const planName = "plan_evidence_preflight_quant_valid";
    seedResultPlan(root, planName, [
      {
        id: "soccer_database",
        path: database,
        expected_worktree_root: root,
        freshness: { max_age_seconds: 86400 },
      },
    ]);

    const result = runEvidencePreflight({ cwd: root, plan: planName, gates: ["GATE-REF-017"] });
    const gate = result.gates[0];
    assert(gate?.status === "PASS", "GATE-REF-017 passes a valid active-worktree source");
    assert(gate?.data?.status === "diagnostic_only", "valid source preserves diagnostic_only result status");
    assert(gate?.data?.evidence_validity === "valid", "valid source exposes shared valid evidence state");
    assert(gate?.data?.environment_preflight_receipt?.sources?.[0]?.sha256?.length === 64, "valid source preflight exposes computed SHA-256");
    assert(result.state_mutated === false, "valid quant-result evidence preflight is read-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\nEvidence Preflight Tests\n");

scenarioPlanPreflightReportsMissingStoryLinkage();
scenarioCloseSignalPreflightDoesNotMutateState();
scenarioRegistryHashMismatchPredictsSemanticFailure();
scenarioMissingAntiRecurrenceGuardIsPredicted();
scenarioPreflightDoesNotBackfillScaffoldSections();
scenarioMissingIntentEvidenceIsPredicted();
scenarioContextMatrixPreflightPredictsBoundaryFailure();
scenarioCrawlerExtractorDoesNotTriggerContextMatrix();
scenarioSemanticUpkeepContractPreflight();
scenarioKbTagPreflight();
scenarioKbTagPreflightRequiresRealHit();
scenarioKbDigestPreflight();
scenarioIncidentCloseoutPreflight();
scenarioQuantResultPreflightExposesEnvironmentReceiptReadOnly();
scenarioQuantResultPreflightPassesValidActiveSource();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
