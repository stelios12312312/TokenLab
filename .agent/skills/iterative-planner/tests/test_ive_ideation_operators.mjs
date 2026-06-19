#!/usr/bin/env node
// test_ive_ideation_operators.mjs — IVE phase 3 anchor/operator/intent contracts.

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadRules, loadStateFacts, loadStoryFacts } from "../scripts/lib/fact_loader.mjs";
import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import {
  REQUIRED_OPERATORS,
  compileIveIdeationFacts,
  evaluateIveIdeation,
} from "../scripts/lib/ive_ideation_operators.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), name));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function baseStoryRegistry() {
  return {
    version: 1,
    stories: [
      {
        id: "US-077",
        title: "Ontology as discipline layer",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/lib/ive_ideation_operators.mjs",
          ".agent/skills/iterative-planner/scripts/lib/fact_loader.mjs",
          ".agent/skills/iterative-planner/prolog/invariants.pl",
        ],
        test_refs: [
          ".agent/skills/iterative-planner/tests/test_ive_ideation_operators.mjs",
        ],
        validation_refs: [
          ".agent/skills/iterative-planner/tests/ive/run.mjs",
        ],
        anchors: [
          {
            id: "CA-IVE-P3-IDEATION-CONTRACT",
            story_id: "US-077",
            code_refs: [
              ".agent/skills/iterative-planner/scripts/lib/ive_ideation_operators.mjs",
              ".agent/skills/iterative-planner/prolog/invariants.pl",
            ],
            test_refs: [
              ".agent/skills/iterative-planner/tests/test_ive_ideation_operators.mjs",
            ],
            validation_refs: [
              ".agent/skills/iterative-planner/tests/ive/run.mjs",
            ],
          },
        ],
      },
    ],
  };
}

function baseOperatorLedger() {
  return {
    ive_phase3_required: true,
    complexity_score: 4,
    core_metrics: [{ id: "north_star.runtime", label: "Runtime north star" }],
    operators: [
      {
        operator: "what_if",
        story_id: "US-077",
        alternatives: [{ id: "alt-a" }, { id: "alt-b" }],
        selected_alternative_id: "alt-a",
        rationale: "Select the smallest executable validation surface.",
      },
      {
        operator: "pre_mortem",
        story_id: "US-077",
        risks: [
          {
            id: "RISK-ANCHOR-DRIFT",
            status: "addressed",
            mitigation_ref: "CA-IVE-P3-IDEATION-CONTRACT",
            mitigation_kind: "anchor",
          },
          {
            id: "RISK-CHAT-ONLY-INTENT",
            status: "accepted",
          },
        ],
      },
      {
        operator: "how_does_this_help",
        anchor_id: "CA-IVE-P3-IDEATION-CONTRACT",
        north_star_metric_id: "north_star.runtime",
        north_star_link: "Keeps imperatives executable instead of chat-only.",
      },
      {
        operator: "is_everything_connected",
        story_id: "US-077",
        orphans: {
          stories: [],
          anchors: [],
        },
      },
    ],
  };
}

function baseIntentContract() {
  return {
    ive_phase3_required: true,
    extracted_imperatives: [
      { id: "SRC-001", text: "Bind IVE phase 3 ideation to ontology evidence." },
    ],
    imperatives: [
      {
        id: "IMP-001",
        source: "SRC-001",
        text: "Bind IVE phase 3 ideation to ontology evidence.",
        binding: {
          kind: "anchor",
          ref_id: "CA-IVE-P3-IDEATION-CONTRACT",
        },
      },
    ],
    scope_additions: [
      {
        id: "ADD-001",
        source: "SRC-001",
        reason: "Phase 3 requires executable operator evidence.",
      },
    ],
  };
}

function evaluate(overrides = {}) {
  return evaluateIveIdeation({
    storyRegistry: overrides.storyRegistry || baseStoryRegistry(),
    operatorLedger: overrides.operatorLedger || baseOperatorLedger(),
    intentContract: overrides.intentContract || baseIntentContract(),
  });
}

function issueCodes(report) {
  return new Set((report.issues || []).map((issue) => issue.code));
}

function warningCodes(report) {
  return new Set((report.warnings || []).map((warning) => warning.code));
}

function writeFixturePlan({ storyRegistry, operatorLedger, intentContract }) {
  const tmp = makeTemp("ive-ideation-");
  const planName = "plan_ive_ideation_fixture";
  const planDir = join(tmp, "plans", planName);
  mkdirSync(join(tmp, "plans"), { recursive: true });
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  mkdirSync(planDir, { recursive: true });

  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), `${JSON.stringify(storyRegistry, null, 2)}\n`);
  writeFileSync(join(planDir, "operator_ledger.json"), `${JSON.stringify(operatorLedger, null, 2)}\n`);
  writeFileSync(join(planDir, "intent_contract.json"), `${JSON.stringify(intentContract, null, 2)}\n`);
  writeFileSync(join(planDir, "plan.md"), [
    "## Problem Statement",
    "Verify IVE phase 3 ideation contracts.",
    "",
    "## Files To Modify",
    "- .agent/skills/iterative-planner/scripts/lib/ive_ideation_operators.mjs",
    "",
    "## Verification Strategy",
    "| Criterion | Story linkage | Check | Pass means |",
    "| --- | --- | --- | --- |",
    "| sc_1 | US-077 | node .agent/skills/iterative-planner/tests/test_ive_ideation_operators.mjs | PASS |",
  ].join("\n"));
  writeStateJson(planDir, createInitialStateJson(planName, "IVE phase 3 ideation fixture", { projectRoot: tmp }));

  return { tmp, planDir };
}

function loadFixtureSession(fixture) {
  const session = createSession();
  loadRules(session, { cwd: fixture.tmp, skillPath: skillDir });
  loadStoryFacts(session, { cwd: fixture.tmp });
  loadStateFacts(session, { cwd: fixture.tmp, skillPath: skillDir });
  return session;
}

console.log("\nIVE Ideation Operator Tests\n");

function testValidContractPasses() {
  const report = evaluate();
  assert(report.required && report.status === "PASS", "valid phase-3 contract passes");
  assert(report.anchor_count === 1 && report.imperative_count === 1 && report.operator_count === 4, "valid report records anchor, imperative, and operator counts");
}

function testAnchorContainmentFailsOnDrift() {
  const registry = baseStoryRegistry();
  registry.stories[0].anchors[0].code_refs.push(".agent/skills/iterative-planner/scripts/lib/not_in_story.mjs");
  const report = evaluate({ storyRegistry: registry });
  assert(issueCodes(report).has("anchor_ref_not_in_story"), "anchor refs must be contained in the parent story refs");
}

function testOperatorFailuresAreEquivalentToExecutableObligations() {
  const ledger = baseOperatorLedger();
  ledger.operators[1].risks[0] = { id: "RISK-UNADDRESSED", status: "open" };
  const report = evaluate({ operatorLedger: ledger });
  assert(issueCodes(report).has("pre_mortem_risk_unaddressed"), "unaddressed pre-mortem risk fails phase-3 validation");
}

function testIntentBindingFailures() {
  const unbound = baseIntentContract();
  unbound.imperatives[0].binding.ref_id = "CA-MISSING";
  assert(issueCodes(evaluate({ intentContract: unbound })).has("imperative_unbound"), "imperatives must bind to existing ontology nodes");

  const missingExtracted = baseIntentContract();
  missingExtracted.extracted_imperatives.push({ id: "SRC-MISSING", text: "Do this too." });
  assert(issueCodes(evaluate({ intentContract: missingExtracted })).has("imperative_missing_from_contract"), "extracted imperatives must be represented in intent_contract.imperatives");

  const unboundScope = baseIntentContract();
  unboundScope.scope_additions = [{ id: "ADD-UNBOUND", source: "SRC-OUT-OF-BAND" }];
  assert(issueCodes(evaluate({ intentContract: unboundScope })).has("scope_addition_unbound"), "scope additions must be bound or explicitly deferred");
}

function testAdvisoryMajorityWarningAndSuppression() {
  const advisory = baseIntentContract();
  advisory.imperatives.push({
    id: "IMP-002",
    source: "SRC-002",
    text: "Keep this as advice.",
    binding: { kind: "advisory" },
  });
  const advisoryReport = evaluate({ intentContract: advisory });
  assert(advisoryReport.status === "WARN" && warningCodes(advisoryReport).has("imperative_advisory_majority"), "advisory-majority intent contracts warn without blocking deterministic bindings");

  const suppressed = evaluate({
    operatorLedger: {
      ive_phase3_required: true,
      plan_shape: "chore",
      triage_path: "skip_planner",
      operators: [],
    },
    intentContract: { ive_phase3_required: true },
  });
  assert(suppressed.status === "PASS" && REQUIRED_OPERATORS.every((operator) => suppressed.suppressed_operators.includes(operator)), "chore/skip-planner shapes suppress required ideation operators");
}

function testFactCompilerAndPrologBridge() {
  const ledger = baseOperatorLedger();
  ledger.operators[1].risks[0] = { id: "RISK-UNADDRESSED", status: "open" };
  const compiled = compileIveIdeationFacts({
    inputs: {
      storyRegistry: baseStoryRegistry(),
      operatorLedger: ledger,
      intentContract: baseIntentContract(),
    },
  });
  assert(compiled.facts.some((fact) => fact === "pre_mortem_risk_unaddressed('RISK-UNADDRESSED')."), "compiler emits dedicated pre_mortem_risk_unaddressed fact");

  const fixture = writeFixturePlan({
    storyRegistry: baseStoryRegistry(),
    operatorLedger: ledger,
    intentContract: baseIntentContract(),
  });
  try {
    const session = loadFixtureSession(fixture);
    assert(session.check("ive_phase3_required(true)"), "fact_loader exposes IVE phase-3 requirement");
    assert(session.check("invariant_violated(pre_mortem_risk_unaddressed, 'RISK-UNADDRESSED')"), "Prolog invariant consumes phase-3 pre-mortem fact");
  } finally {
    cleanup(fixture.tmp);
  }
}

function testFactExtractionCrashFailsClosedWhenPhase3Required() {
  const fixture = writeFixturePlan({
    storyRegistry: baseStoryRegistry(),
    operatorLedger: baseOperatorLedger(),
    intentContract: baseIntentContract(),
  });
  const previous = process.env.PLANNER_TEST_THROW_IVE_IDEATION;
  process.env.PLANNER_TEST_THROW_IVE_IDEATION = "1";
  try {
    const session = loadFixtureSession(fixture);
    assert(session.check("ive_phase3_required(true)"), "fact_loader preserves phase-3 required status when ideation extraction crashes");
    assert(session.check("ive_ideation_status('error')"), "fact_loader emits ideation error status on extraction crash");
    assert(
      session.check("invariant_violated(ive_ideation_fact_extraction_error, phase3_required)"),
      "phase-3 ideation extraction crashes fail closed through Prolog"
    );
  } finally {
    if (previous === undefined) delete process.env.PLANNER_TEST_THROW_IVE_IDEATION;
    else process.env.PLANNER_TEST_THROW_IVE_IDEATION = previous;
    cleanup(fixture.tmp);
  }
}

testValidContractPasses();
testAnchorContainmentFailsOnDrift();
testOperatorFailuresAreEquivalentToExecutableObligations();
testIntentBindingFailures();
testAdvisoryMajorityWarningAndSuppression();
testFactCompilerAndPrologBridge();
testFactExtractionCrashFailsClosedWhenPhase3Required();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
