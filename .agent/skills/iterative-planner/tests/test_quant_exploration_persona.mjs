#!/usr/bin/env node
// test_quant_exploration_persona.mjs - focused coverage for aggressive exploration guidance.

import quantPack from "../packs/quant/index.mjs";

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

console.log("\nQuant Exploration Persona Contract\n");

const storyRegistry = {
  stories: [
    {
      id: "US-HFOPP-005",
      title: "Aggressive alpha hypothesis exploration",
      status: "PARTIALLY_COVERED",
      tags: ["quant", "model", "optimizer"],
      postconditions: [
        "Explore betting market inefficiency model hypotheses with positive_return and odds.",
      ],
    },
  ],
};

const planText = [
  "# Plan",
  "Explore an aggressive hypothesis sweep for alpha candidates using a model optimizer before promotion.",
].join("\n");

const constraints = quantPack.getPlanConstraints({
  storyRegistry,
  planFiles: { "plan.md": planText },
  auditConfig: { roles: ["quant"] },
});
const ids = constraints.map((constraint) => constraint.id);

assert(ids.includes("QU-C-007"), "aggressive exploration without a contract triggers QU-C-007");
assert(ids.includes("QU-C-005"), "optimizer-scale disclosure remains required");
assert(ids.includes("QU-C-006"), "quant result-claim validation remains required");
assert((quantPack.getPhaseGuidance("explore", {}) || "").includes("hypothesis ledger"), "EXPLORE guidance asks for a hypothesis ledger");
assert((quantPack.getPhaseGuidance("plan", {}) || "").includes("kill criteria"), "PLAN guidance asks for kill criteria");
assert((quantPack.getPhaseGuidance("validate", {}) || "").includes("not-run surfaces"), "VALIDATE guidance preserves non-claim boundaries");

const modelFamilyConstraints = quantPack.getPlanConstraints({
  storyRegistry: {
    stories: [
      {
        id: "US-UFC-ML",
        title: "UFC CatBoost Optuna stacking ensemble search",
        status: "PARTIALLY_COVERED",
        tags: ["quant", "model", "optimizer"],
        postconditions: [
          "Run Optuna across CatBoost and a stacking ensemble, then report ROI and calibration.",
        ],
      },
    ],
  },
  planFiles: {
    "plan.md": [
      "# Plan",
      "Use CatBoost, Optuna, and a stacking ensemble to choose the final betting model.",
      "Report run class, trial count, objective handling, controls, and final OOS ROI.",
    ].join("\n"),
  },
  auditConfig: { roles: ["quant"] },
});
const modelFamilyIds = modelFamilyConstraints.map((constraint) => constraint.id);
const modelFamilyConstraint = modelFamilyConstraints.find((constraint) => constraint.id === "QU-C-009");

assert(modelFamilyIds.includes("QU-C-009"), "CatBoost/Optuna/stacking without booster diagnostics triggers QU-C-009");
assert((modelFamilyConstraint?.meta?.ive?.fact_templates || []).includes("model_family_search_coverage_missing"), "QU-C-009 carries IVE model-family fact templates");
assert((quantPack.getPhaseGuidance("plan", {}) || "").includes("family-specific searched knobs"), "PLAN guidance asks for family-specific search depth");
assert((quantPack.getPhaseGuidance("reflect", {}) || "").includes("prediction correlation"), "REFLECT guidance asks for model diagnostics");
assert((quantPack.getPhaseGuidance("validate", {}) || "").includes("family-specific search coverage"), "VALIDATE guidance blocks model-family exhaustion claims without coverage");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
