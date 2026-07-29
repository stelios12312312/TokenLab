#!/usr/bin/env node
// test_recipe_promotion.mjs — E4-8 recipe-promotion close-signal proof.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  buildRecipePromotionDraft,
  collectRecipePromotionCandidates,
  commandSignature,
  computeRecipePromotionSignal,
  isOperationalPromotionCommand,
} from "../scripts/lib/recipe_promotion.mjs";
import { validateRecipeSurface } from "../scripts/lib/recipe_utils.mjs";
import { gateReflectToValidate, gateValidateToClose } from "../scripts/verify_gate.mjs";

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

function makeTempProject(name = "recipe-promotion") {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function materializeDraft(root, draft) {
  for (const [relPath, payload] of Object.entries(draft.files || {})) {
    writeJson(join(root, relPath), payload);
  }
}

function fixtureWorkOrder() {
  return {
    proposed_creations: [{
      capability_id: "daily_sync",
      recipe_id: "daily-sync",
      path: "scripts/daily_sync.mjs",
      purpose: "Sync daily customer records into the CRM",
      runner: {
        type: "command",
        cwd: ".",
        command: ["node", "scripts/daily_sync.mjs", "--account", "demo"],
        defaults: { account: "demo" },
        dry_run_flags: ["--dry-run"],
      },
    }],
  };
}

function scenarioPlanProducedOperationalFlow() {
  const tmp = makeTempProject();
  try {
    const planDir = join(tmp, "plans", "plan_recipe");
    mkdirSync(planDir, { recursive: true });
    writeJson(join(planDir, "work_order.json"), fixtureWorkOrder());
    const candidates = collectRecipePromotionCandidates({
      cwd: tmp,
      planDir,
      stateJson: { id: "plan_recipe" },
    });
    const candidate = candidates[0];
    assert(candidates.length === 1, "plan-produced operational flow creates one candidate");
    assert(candidate?.capability_id === "daily_sync", "candidate preserves capability id");
    assert(candidate?.recipe_id === "daily-sync", "candidate preserves recipe id");
    assert(candidate?.runner?.command?.includes("scripts/daily_sync.mjs"), "candidate preserves runner command");
    assert(candidate?.dry_run_flags?.includes("--dry-run"), "candidate preserves dry-run flags");
    assert(candidate?.bootstrap_command_display?.includes("recipe_bootstrap.mjs"), "candidate includes bootstrap command");
    assert(candidate?.provenance?.[0]?.source === "work_order", "candidate records work-order provenance");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioCrossPlanRepeatPromotion() {
  const tmp = makeTempProject();
  try {
    writeJsonl(join(tmp, "plans", "plan_a", "telemetry", "events.jsonl"), [
      { id: "evt-a", tool_input: { cmd: "node scripts/customer_sync.mjs --account demo" }, summary: "sync customers" },
    ]);
    writeJsonl(join(tmp, "plans", "plan_b", "telemetry", "events.jsonl"), [
      { id: "evt-b", input: { command: ["node", "scripts/customer_sync.mjs", "--account", "demo"] }, summary: "sync customers again" },
    ]);
    const candidates = collectRecipePromotionCandidates({ cwd: tmp, stateJson: { id: "plan_current" } });
    const candidate = candidates.find((entry) => entry.source_type === "cross_plan_repeat");
    assert(!!candidate, "cross-plan repeated command creates a promotion candidate");
    assert(candidate?.occurrence_count === 2, "repeat candidate records occurrence count");
    assert(candidate?.provenance?.some((entry) => entry.plan_id === "plan_a"), "repeat candidate preserves plan_a provenance");
    assert(candidate?.provenance?.some((entry) => entry.plan_id === "plan_b"), "repeat candidate preserves plan_b provenance");
    assert(candidate?.command_signature === commandSignature(["node", "scripts/customer_sync.mjs", "--account", "demo"], "."), "repeat candidate uses stable command signature");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function scenarioPlannerCommandsFiltered() {
  const tmp = makeTempProject();
  try {
    const workOrder = {
      proposed_creations: [
        { capability_id: "transition_gate", command: ["node", ".agent/skills/iterative-planner/scripts/transition.mjs", "plan-to-execute"] },
        { capability_id: "test_runner", command: ["npm", "test"] },
        { capability_id: "git_status", command: ["git", "status"] },
      ],
    };
    const candidates = collectRecipePromotionCandidates({ cwd: tmp, workOrder });
    assert(candidates.length === 0, "planner/test/git commands do not create recipe-promotion candidates");
    assert(!isOperationalPromotionCommand(["node", ".agent/skills/iterative-planner/scripts/transition.mjs", "plan-to-execute"]), "transition command is non-operational");
    assert(!isOperationalPromotionCommand(["npm", "test"]), "package test command is non-operational");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioDraftRecipeValidation() {
  const tmp = makeTempProject();
  try {
    const candidate = collectRecipePromotionCandidates({ cwd: tmp, workOrder: fixtureWorkOrder() })[0];
    const draft = buildRecipePromotionDraft(candidate);
    materializeDraft(tmp, draft);
    const validation = validateRecipeSurface(tmp);
    assert(validation.recipe_count === 1, "materialized draft has one recipe");
    assert(validation.invalid_count === 0, "materialized draft validates cleanly");
    assert(validation.recipes[0]?.work_order_profile?.status === "PASS", "materialized draft passes work-order profile validation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioSignalDispositionDoesNotWriteRecipes() {
  const tmp = makeTempProject();
  try {
    const rawSignal = computeRecipePromotionSignal({ cwd: tmp, workOrder: fixtureWorkOrder() });
    assert(rawSignal.required === true, "signal is required when a candidate exists");
    assert(rawSignal.satisfied === false && rawSignal.status === "needs_disposition", "undisposed signal needs disposition");
    assert(!existsSync(join(tmp, "recipes")), "signal computation does not create recipe files");

    const candidate = rawSignal.candidates[0];
    const acknowledged = computeRecipePromotionSignal({
      cwd: tmp,
      workOrder: fixtureWorkOrder(),
      reflectionContent: `## Recipe Promotion\n- ${candidate.id} deferred until operator review confirms this should become a shared recipe.\n`,
    });
    assert(acknowledged.satisfied === true, "candidate disposition satisfies signal");
    assert(acknowledged.candidates[0]?.disposition === "deferred", "signal records disposition verb");
    assert(!existsSync(join(tmp, "recipes")), "acknowledged signal still does not write recipe files");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeGatePlan(root, recipePromotionSignal) {
  const planDir = join(root, "plans", "plan_gate");
  mkdirSync(planDir, { recursive: true });
  writeJson(join(planDir, "state.json"), {
    id: "plan_gate",
    current_state: "REFLECT",
    close_signals: {
      recipe_promotion: recipePromotionSignal,
    },
  });
  writeFileSync(join(planDir, "reflection.md"), `# Reflection

## Solution Verdict
Verdict: PASS

## Semantic Verdict
Verdict: PASS

## Evidence-Readiness Verdict
Verdict: PASS

## Next Move
Proceed to VALIDATE.
`);
  writeFileSync(join(planDir, "progress.md"), "- [x] Implement recipe promotion signal\n");
  writeFileSync(join(planDir, "verification.md"), `# Verification

## Validation Status
| Level | Status |
|---|---|
| focused | PASS |

## Regression Audit
PASS

## Proof of Work
\`\`\`text
PASS recipe promotion fixture
\`\`\`
`);
  return planDir;
}

function findGateCheck(results) {
  return results.find((entry) => entry.name.includes("recipe-promotion disposition"));
}

function scenarioGateWarnAndPassSurfacing() {
  const tmp = makeTempProject();
  try {
    const unresolved = computeRecipePromotionSignal({ cwd: tmp, workOrder: fixtureWorkOrder() });
    const warnPlan = writeGatePlan(tmp, unresolved);
    const reflectWarn = findGateCheck(gateReflectToValidate(warnPlan));
    const validateWarn = findGateCheck(gateValidateToClose(warnPlan));
    assert(reflectWarn?.status === "WARN", "REFLECT gate warns on undisposed recipe-promotion candidate");
    assert(validateWarn?.status === "WARN", "VALIDATE gate warns on undisposed recipe-promotion candidate");

    const acknowledged = computeRecipePromotionSignal({
      cwd: tmp,
      workOrder: fixtureWorkOrder(),
      verificationContent: `## Recipe Promotion\n- ${unresolved.candidates[0].id} accepted after operator confirmation.\n`,
    });
    const passPlan = writeGatePlan(tmp, acknowledged);
    const reflectPass = findGateCheck(gateReflectToValidate(passPlan));
    const validatePass = findGateCheck(gateValidateToClose(passPlan));
    assert(reflectPass?.status === "PASS", "REFLECT gate passes after recipe-promotion disposition");
    assert(validatePass?.status === "PASS", "VALIDATE gate passes after recipe-promotion disposition");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nRecipe Promotion Tests\n");
scenarioPlanProducedOperationalFlow();
scenarioCrossPlanRepeatPromotion();
scenarioPlannerCommandsFiltered();
scenarioDraftRecipeValidation();
scenarioSignalDispositionDoesNotWriteRecipes();
scenarioGateWarnAndPassSurfacing();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
