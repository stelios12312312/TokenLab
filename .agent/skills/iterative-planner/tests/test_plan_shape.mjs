#!/usr/bin/env node
// test_plan_shape.mjs — v7.3.0 plan-shape detection contract.
//
// Plan shape determines which EXPLORE gates apply. The Tesseract incident
// showed that demanding the maximalist set on every plan (3 findings, root
// cause, adjacency, assumption ledger) caused agents to spend 30+ min
// padding "N/A" answers for shapes that didn't need those checks. This test
// locks in the shape detection rules so they don't drift back.

import { detectPlanShape, shapeMinFindings, shapeRequiresField, SHAPE_NAMES, SHAPE_REQUIREMENTS } from "../scripts/lib/plan_shape.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nPlan Shape Detection Contract\n");

// Goal-text classification
const goalCases = [
  { goal: "Design a webhook to tag users when they purchase via GHL automation", expected: "integration" },
  { goal: "Add a Stripe connector to the payment flow", expected: "integration" },
  { goal: "Fix the bug where signup emails are sent twice", expected: "bug-fix" },
  { goal: "Diagnose the latency regression in the checkout API", expected: "bug-fix" },
  { goal: "Create a point-based TrueSkill system based on points won/lost instead of match outcomes", expected: "scientific" },
  { goal: "Build a Markov tennis model with temporal split and leakage checks", expected: "scientific" },
  { goal: "Refactor the data layer to use the new schema", expected: "refactor" },
  { goal: "Migrate fleet projects to v7.3.0", expected: "migration" },
  { goal: "Delete the deprecated v1 endpoint", expected: "migration" },
  { goal: "Add a dashboard widget for active users", expected: "feature" },
  { goal: "Build the new onboarding flow", expected: "feature" },
  { goal: "Update the README with new install instructions", expected: "docs" },
  { goal: "Document the new API surface", expected: "integration" /* API beats docs by precedence */ },
];

for (const tc of goalCases) {
  const shape = detectPlanShape({ goalText: tc.goal });
  assert(shape.primary === tc.expected,
    `goal "${tc.goal.slice(0, 50)}..." → ${tc.expected} (got ${shape.primary})`);
}

// Planned-files classification: planner-core wins regardless of goal
const plannerCorePaths = [
  ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
  ".agent/workflows/safe-change.md",
  ".agent/rules.md",
];
for (const filePath of plannerCorePaths) {
  const shape = detectPlanShape({ goalText: "add a feature", plannedFiles: [filePath] });
  assert(shape.primary === "planner-core",
    `planned file ${filePath} forces planner-core shape`);
}

// Docs-only via paths
const docsShape = detectPlanShape({ goalText: "update notes", plannedFiles: ["README.md", "docs/guide.md"] });
assert(docsShape.primary === "docs", "all-doc planned files → docs shape");

// Empty / no-signal goal falls back to unknown (strict default)
const unknownShape = detectPlanShape({ goalText: "" });
assert(unknownShape.primary === "unknown", "empty goal → unknown shape");

// Intent contract override wins
const overrideShape = detectPlanShape({
  goalText: "Add a feature widget",
  intentContract: { plan_shape: "planner-core" },
});
assert(overrideShape.primary === "planner-core" && overrideShape.source === "intent_contract",
  "intent_contract.plan_shape overrides goal-text inference");

// Requirements wiring
console.log("\nShape Requirements\n");

assert(shapeMinFindings({ requirements: SHAPE_REQUIREMENTS["bug-fix"] }) === 3, "bug-fix requires 3 findings");
assert(shapeMinFindings({ requirements: SHAPE_REQUIREMENTS["feature"] }) === 1, "feature requires 1 finding");
assert(shapeMinFindings({ requirements: SHAPE_REQUIREMENTS["integration"] }) === 1, "integration requires 1 finding");
assert(shapeMinFindings({ requirements: SHAPE_REQUIREMENTS["scientific"] }) === 3, "scientific requires 3 findings");
assert(shapeMinFindings({ requirements: SHAPE_REQUIREMENTS["docs"] }) === 1, "docs requires 1 finding");
assert(shapeMinFindings({ requirements: SHAPE_REQUIREMENTS["unknown"] }) === 3, "unknown defaults to 3 findings (strict)");

const bugfix = { requirements: SHAPE_REQUIREMENTS["bug-fix"] };
const feature = { requirements: SHAPE_REQUIREMENTS["feature"] };
const integration = { requirements: SHAPE_REQUIREMENTS["integration"] };
const scientific = { requirements: SHAPE_REQUIREMENTS["scientific"] };

assert(shapeRequiresField(bugfix, "root_cause") === true, "bug-fix requires root_cause");
assert(shapeRequiresField(bugfix, "adjacency") === true, "bug-fix requires adjacency");
assert(shapeRequiresField(feature, "root_cause") === false, "feature does NOT require root_cause (the Tesseract fix)");
assert(shapeRequiresField(feature, "adjacency") === false, "feature does NOT require adjacency");
assert(shapeRequiresField(integration, "assumption_ledger") === true, "integration requires assumption_ledger (webhook plans)");
assert(shapeRequiresField(integration, "root_cause") === false, "integration does NOT require root_cause");
assert(shapeRequiresField(scientific, "assumption_ledger") === true, "scientific requires assumption_ledger (data/model claims)");
assert(shapeRequiresField(scientific, "root_cause") === false, "scientific does NOT require root_cause by default");
assert(shapeRequiresField(feature, "assumption_ledger") === false, "feature does NOT require assumption_ledger");

const genericModel = detectPlanShape({ goalText: "Add a model selector dropdown to the settings page" });
assert(genericModel.primary === "feature", "generic model wording without scientific/data probes stays feature-shaped");

// Defensive: every named shape has a complete requirements record
for (const name of SHAPE_NAMES) {
  const req = SHAPE_REQUIREMENTS[name];
  const hasAll = req && typeof req.min_findings === "number" &&
    typeof req.root_cause === "boolean" &&
    typeof req.adjacency === "boolean" &&
    typeof req.assumption_ledger === "boolean";
  assert(hasAll, `shape '${name}' has complete requirements record`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
