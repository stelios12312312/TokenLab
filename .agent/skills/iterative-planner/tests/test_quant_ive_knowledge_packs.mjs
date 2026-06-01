#!/usr/bin/env node
// test_quant_ive_knowledge_packs.mjs - IVE fact-route coverage for quant packs.

import quantPack from "../packs/quant/index.mjs";
import quantTargetPack from "../packs/quant_target/index.mjs";
import { makeConstraint } from "../scripts/lib/audit_types.mjs";

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

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
