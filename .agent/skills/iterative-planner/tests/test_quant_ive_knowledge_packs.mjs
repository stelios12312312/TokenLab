#!/usr/bin/env node
// test_quant_ive_knowledge_packs.mjs - IVE fact-route coverage for quant packs.

import quantPack from "../packs/quant/index.mjs";
import quantTargetPack from "../packs/quant_target/index.mjs";
import { makeConstraint } from "../scripts/lib/audit_types.mjs";
import { detectQuantPersonaScope } from "../scripts/lib/quant_persona_gate.mjs";
import { computeQuantResultsValidationSignal } from "../scripts/lib/quant_results_validation.mjs";
import quantResearchProtocolPack from "../../../packs/quant_research_protocol/index.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

function ids(constraints) {
  return constraints.map((constraint) => constraint.id);
}

function constraintById(constraints, id) {
  return constraints.find((constraint) => constraint.id === id);
}

function factTemplates(constraint) {
  return constraint?.meta?.ive?.fact_templates || [];
}

console.log("\nQuant IVE Knowledge Pack Contract\n");

const metaConstraint = makeConstraint({
  id: "TEST-C-001",
  role: "test",
  constraint: "preserve metadata",
  severity: "HIGH",
  rationale: "IVE routes must survive constraint creation",
  meta: { ive: { fact_templates: ["test_fact"] } },
});

assert(metaConstraint.meta.ive.fact_templates.includes("test_fact"), "makeConstraint preserves optional meta.ive facts");

const quantContext = {
  storyRegistry: {
    stories: [
      {
        id: "US-IVE-QUANT",
        title: "IVE quant pack blind spot coverage",
        status: "PARTIALLY_COVERED",
        tags: ["quant", "model", "optimizer"],
        postconditions: [
          "A serious_search model selection report includes final OOS ROI, capped Sharpe, weighted coverage, and policy selected zero bets.",
        ],
      },
    ],
  },
  planFiles: {
    "plan.md": [
      "# Plan",
      "Run Optuna model selection and present a serious_search promotion candidate with final OOS ROI.",
      "The report shows capped Sharpe, weighted coverage, transformed ROI, and policy selected zero bets.",
      "No routing action has been chosen yet.",
    ].join("\n"),
  },
  auditConfig: { roles: ["quant"] },
};

const quantConstraints = quantPack.getPlanConstraints(quantContext);
const quantIds = ids(quantConstraints);

assert(quantIds.includes("QU-C-010"), "serious search without statistical rigor triggers QU-C-010");
assert(factTemplates(constraintById(quantConstraints, "QU-C-010")).includes("bootstrap_ci_missing"), "QU-C-010 carries statistical-rigor fact templates");
assert(quantIds.includes("QU-C-011"), "zero-bet output without routing triggers QU-C-011");
assert(factTemplates(constraintById(quantConstraints, "QU-C-011")).includes("policy_selected_zero_bets"), "QU-C-011 carries degenerate-output fact templates");
assert((constraintById(quantConstraints, "QU-C-011")?.meta?.ive?.valid_next_actions || []).includes("ticket_now"), "QU-C-011 exposes valid next actions");
assert(quantIds.includes("QU-C-012"), "transformed/capped/weighted metrics without lineage trigger QU-C-012");
assert(factTemplates(constraintById(quantConstraints, "QU-C-012")).includes("transformed_metric_reported_as_raw"), "QU-C-012 carries metric-lineage fact templates");

const routedDegenerateConstraints = quantPack.getPlanConstraints({
  ...quantContext,
  planFiles: {
    "plan.md": [
      "# Plan",
      "The report shows policy selected zero bets.",
      "Route this with ticket_now and an accepted limitation before any claim.",
    ].join("\n"),
  },
});

assert(!ids(routedDegenerateConstraints).includes("QU-C-011"), "routed zero-bet outputs do not trigger degenerate-output churn");

const targetContext = {
  storyRegistry: {
    stories: [
      {
        id: "US-IVE-TARGET",
        title: "IVE quant target CLV provenance",
        status: "PARTIALLY_COVERED",
        tags: ["quant", "betting", "odds"],
        postconditions: [
          "Use CLV and closing line value to support a market inefficiency claim.",
        ],
      },
    ],
  },
  planFiles: {
    "plan.md": [
      "# Plan",
      "The market inefficiency model uses positive_return and CLV as evidence.",
      "Interpret closing line value from betting odds without a provenance repair route.",
    ].join("\n"),
  },
  auditConfig: { roles: ["quant_target"] },
};

const targetConstraints = quantTargetPack.getPlanConstraints(targetContext);
const targetIds = ids(targetConstraints);

assert(targetIds.includes("QT-C-004"), "CLV without provenance route triggers QT-C-004");
assert(factTemplates(constraintById(targetConstraints, "QT-C-004")).includes("clv_provenance_unrepaired"), "QT-C-004 carries CLV provenance facts");
assert((constraintById(targetConstraints, "QT-C-004")?.meta?.ive?.valid_next_actions || []).includes("accept_limitation"), "QT-C-004 exposes accepted-limitation routing");

const nonBettingTargetConstraints = quantTargetPack.getPlanConstraints({
  storyRegistry: { stories: [] },
  planFiles: {
    "plan.md": "Plan a non-betting model target contract for calibration benchmark review.",
  },
  auditConfig: { roles: ["quant_target"] },
});

assert(!ids(nonBettingTargetConstraints).includes("QT-C-004"), "non-betting target text does not trigger CLV provenance route");

const frontendVerificationContext = {
  storyRegistry: { stories: [] },
  planShape: { primary: "feature" },
  currentState: "execute",
  planFiles: {
    "plan.md": [
      "## Verification Strategy",
      "| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |",
      "| sc_2 | US-080 | Rendered React dashboard | proof:browser_journey | npm run screenshot | no horizontal overflow | manual taste review |",
    ].join("\n"),
    "verification.md": "## Regression Audit\nRecord the browser regression evidence here. `test_quant_ive_knowledge_packs.mjs` passed.",
  },
  auditConfig: { roles: ["quant_target"] },
};

assert(!quantTargetPack.applies(frontendVerificationContext), "generic frontend verification wording does not activate quant target audit");
assert(quantTargetPack.getPlanConstraints(frontendVerificationContext).length === 0, "generic frontend verification wording does not create quant target constraints");

const frontendTargetFindings = await quantTargetPack.audit(frontendVerificationContext);
assert(frontendTargetFindings.length === 0, "test_quant filename references do not create quant target findings");

const frontendResearchContext = {
  ...frontendVerificationContext,
  auditConfig: { roles: ["quant_research_protocol"] },
};
const frontendResearchFindings = await quantResearchProtocolPack.audit(frontendResearchContext);
assert(frontendResearchFindings.length === 0, "test_quant filename references do not create quant research findings");
assert(quantResearchProtocolPack.getPlanConstraints(frontendResearchContext).length === 0, "test_quant filename references do not create quant research constraints");

const frontendFalsePositiveContext = {
  storyRegistry: { stories: [] },
  planShape: { primary: "feature" },
  currentState: "reflect",
  planFiles: {
    "plan.md": "This frontend plan must not claim unrelated analytic performance or promotion evidence.",
    "findings.md": "Browser proof checks accessible status labels and proof link labels.",
    "reflection.md": "The quant/persona false-positive repair is covered by regression tests.",
    "progress.md": "Fixed quant persona false positives.",
  },
  auditConfig: { roles: ["quant_research_protocol", "quant_target"] },
};
const falsePositiveResearchFindings = await quantResearchProtocolPack.audit(frontendFalsePositiveContext);
assert(falsePositiveResearchFindings.length === 0, "quant false-positive prose plus promotion non-claim does not create quant research findings");
assert(!quantTargetPack.applies(frontendFalsePositiveContext), "quant false-positive prose plus UI labels does not activate quant target audit");

const frontendQuantGate = detectQuantPersonaScope({
  planShape: { primary: "feature" },
  sourceText: "Implement all remaining IVE Visualizer frontend tickets.",
  planContent: "Graph payload contract and Dashboard Bridge parity proof.",
  verificationContent: "`test_quant_ive_knowledge_packs.mjs` passed; GitHub mirror issues are open or closed.",
});
assert(frontendQuantGate.required === false, "test_quant filename references do not require the hard quant persona gate");

const frontendLabelGate = detectQuantPersonaScope({
  planShape: { primary: "feature" },
  sourceText: "The reflection mentions a quant/persona false-positive repair.",
  planContent: "Browser proof checks accessible names, status labels, and proof link labels.",
  verificationContent: "`test_quant_ive_knowledge_packs.mjs` passed.",
});
assert(frontendLabelGate.required === false, "quant false-positive prose plus UI labels does not require the hard quant persona gate");

const realQuantGate = detectQuantPersonaScope({
  planShape: { primary: "feature" },
  sourceText: "Implement a quant model label formula for a prediction workflow.",
});
assert(realQuantGate.required === true, "real quant model label wording still requires the hard quant persona gate");

const frontendPlanDir = mkdtempSync(join(tmpdir(), "ive-frontend-quant-signal-"));
writeFileSync(join(frontendPlanDir, "state.json"), JSON.stringify({ plan_shape: { primary: "feature" } }));
const frontendQuantResultsSignal = computeQuantResultsValidationSignal({
  planDir: frontendPlanDir,
  planContent: "This frontend plan does not make unrelated result claims or promotion evidence claims.",
  verificationContent: "`test_quant_ive_knowledge_packs.mjs` passed and status labels are accessible.",
  reflectionContent: "The quant/persona false-positive repair is covered by regression tests.",
});
assert(frontendQuantResultsSignal.required === false, "frontend quant false-positive prose does not require quant_results_validation.json");
rmSync(frontendPlanDir, { recursive: true, force: true });

const realQuantPlanDir = mkdtempSync(join(tmpdir(), "ive-real-quant-signal-"));
writeFileSync(join(realQuantPlanDir, "state.json"), JSON.stringify({ plan_shape: { primary: "scientific" } }));
const realQuantResultsSignal = computeQuantResultsValidationSignal({
  planDir: realQuantPlanDir,
  planContent: "A quant model result reports ROI 12% after optimizer trials.",
  verificationContent: "No quant_results_validation.json is present.",
});
assert(realQuantResultsSignal.required === true, "real quant result wording still requires quant_results_validation.json");
rmSync(realQuantPlanDir, { recursive: true, force: true });

const researchFindings = await quantResearchProtocolPack.audit({
  storyRegistry: { stories: [] },
  planShape: { primary: "scientific" },
  currentState: "execute",
  planFiles: {
    "plan.md": "Run a quant model optimizer backtest and interpret the result.",
  },
  auditConfig: { roles: ["quant_research_protocol"] },
});
assert(researchFindings.length > 0, "real quant research wording still triggers quant research findings");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
