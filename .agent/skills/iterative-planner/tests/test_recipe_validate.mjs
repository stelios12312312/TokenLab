#!/usr/bin/env node

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { LEGACY_RECIPE_NOTICE, validateRecipeSurface } from "../scripts/lib/recipe_utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const scriptDir = resolve(testDir, "..", "scripts");
const plannerCliPath = join(scriptDir, "planner.mjs");
const recipeDiscoveryPath = join(scriptDir, "recipe_discovery.mjs");
const recipeValidatePath = join(scriptDir, "recipe_validate.mjs");
const fixtureRoot = join(testDir, "fixtures", "recipes");
const discoveryReviewFixturePath = join(fixtureRoot, "discovery_review", "recipes", "discovery_review.json");
const NODE = process.execPath;
const ipbsRecipes = String(process.env.PLANNER_TEST_IPBS_RECIPES || "").trim();
const tesseractRecipes = String(process.env.PLANNER_TEST_TESSERACT_RECIPES || "").trim();

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

function runJson(args, cwd = plannerRoot, expectOk = true) {
  try {
    const stdout = execFileSync(NODE, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        _PLANNER_PLAN_TARGET: "",
      },
    });
    return { ok: true, status: 0, json: JSON.parse(stdout), stdout };
  } catch (error) {
    if (expectOk) {
      return {
        ok: false,
        status: error.status ?? 1,
        json: null,
        stdout: error.stdout || "",
        stderr: error.stderr || "",
      };
    }
    const stdout = error.stdout || "";
    return {
      ok: false,
      status: error.status ?? 1,
      json: stdout.trim() ? JSON.parse(stdout) : null,
      stdout,
      stderr: error.stderr || "",
    };
  }
}

function scenarioCanonicalFixtureValidates() {
  const payload = validateRecipeSurface(join(fixtureRoot, "canonical"));
  assert(payload.recipe_count === 1, "canonical fixture has one recipe");
  assert(payload.invalid_count === 0, "canonical fixture validates cleanly");
  assert(payload.recipes[0]?.normalized?.runner?.ready === true, "canonical fixture runner is normalized as ready");
  assert(payload.recipes[0]?.work_order_profile?.status === "PASS", "canonical fixture promotes to a valid work-order profile");
  assert(payload.work_order_profile?.valid_count === 1, "canonical fixture contributes one valid work-order profile");
}

function scenarioLegacyFixtureAcceptedWithInfo() {
  const payload = validateRecipeSurface(join(fixtureRoot, "legacy"));
  assert(payload.recipe_count === 2, "legacy fixture has two recipes");
  assert(payload.invalid_count === 0, "legacy runner.json fixture is accepted on read");
  assert(payload.legacy_count === 2, "legacy runner.json files are counted");
  assert(
    payload.recipes.every((recipe) => recipe.info.includes(LEGACY_RECIPE_NOTICE)),
    "legacy fixture reports migration notices at info level"
  );
  assert(
    payload.recipes.some((recipe) => recipe.normalized?.runner?.type === "python"),
    "legacy python runner type is preserved"
  );
  assert(
    payload.recipes.some((recipe) => recipe.normalized?.runner?.command?.includes("scripts/legacy_string_runner.py")),
    "legacy string runner is normalized into a command runner"
  );
  assert(
    payload.recipes.every((recipe) => recipe.work_order_profile?.status === "SKIP"),
    "legacy runner.json recipes remain readable but are not silently promoted"
  );
}

function scenarioDryRunProfileFailsClosed() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-recipe-dry-run-contract-"));
  try {
    mkdirSync(join(tmp, "recipes", "live-only"), { recursive: true });
    writeFileSync(join(tmp, "recipes", "live-only", "recipe.json"), JSON.stringify({
      id: "live-only",
      title: "Live Only",
      capability_id: "run_live_only",
      runner: {
        type: "command",
        cwd: ".",
        command: ["node", "-e", "console.log('live only')"],
        dry_run_flags: [],
        live_flags: []
      }
    }, null, 2) + "\n");
    const validateResult = runJson([recipeValidatePath, "validate", "--dir", tmp, "--json"]);
    assert(validateResult.ok, "recipe validate still reads canonical live-only recipe");
    assert(validateResult.json?.recipes?.[0]?.work_order_profile?.status === "FAIL", "live-only recipe is not promoted without dry-run flags");

    const runnerResult = runJson([join(scriptDir, "recipe_runner.mjs"), "--dir", tmp, "--recipe", "live-only", "--execute", "--json"], plannerRoot, false);
    assert(!runnerResult.ok && runnerResult.status !== 0, "recipe runner dry-run execution fails closed without dry-run flags");
    assert(String(runnerResult.json?.error || "").includes("dry-run mode"), "dry-run failure explains missing dry-run contract");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioIpbsLiveSurfaceValidatesUnmodified() {
  if (!ipbsRecipes || !existsSync(ipbsRecipes)) {
    console.log("  SKIP: live IPBS compatibility is opt-in via PLANNER_TEST_IPBS_RECIPES");
    return;
  }
  const result = runJson([recipeValidatePath, "validate", "--dir", ipbsRecipes, "--json"]);
  assert(result.ok, "recipe validate exits cleanly for live IPBS recipes");
  assert(result.json?.recipe_count > 0, "live IPBS surface contains at least one recipe");
  assert(result.json?.invalid_count === 0, "live IPBS recipes validate without modification");
  assert(result.json?.legacy_count === 0, "live IPBS surface uses canonical recipe.json only");
}

function scenarioTesseractLegacyReadCompatibility() {
  if (!tesseractRecipes || !existsSync(tesseractRecipes)) {
    console.log("  SKIP: live Tesseract compatibility is opt-in via PLANNER_TEST_TESSERACT_RECIPES");
    return;
  }
  const payload = validateRecipeSurface(tesseractRecipes);
  assert(payload.legacy_count > 0, "live Tesseract legacy runner.json recipes are detected");
  assert(
    payload.recipes
      .filter((recipe) => recipe.variant === "legacy_runner_json")
      .every((recipe) => recipe.info.includes(LEGACY_RECIPE_NOTICE)),
    "live Tesseract legacy runner.json recipes emit info-level migration notices"
  );
  assert(
    payload.recipes
      .filter((recipe) => recipe.variant === "legacy_runner_json")
      .every((recipe) => recipe.valid),
    "live Tesseract legacy runner.json recipes are valid read inputs"
  );
}

function scenarioBootstrapWritesCanonicalRecipeJsonOnly() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-recipe-bootstrap-"));
  try {
    const result = runJson([
      plannerCliPath,
      "recipe",
      "bootstrap",
      "--dir",
      tmp,
      "--goal",
      "Run sample import",
      "--recipe-id",
      "sample-import",
      "--capability-id",
      "run_sample_import",
      "--script",
      "scripts/sample_import.py::Sample import fixture",
      "--apply",
      "--json",
    ]);
    const recipePath = join(tmp, "recipes", "sample-import", "recipe.json");
    const runnerPath = join(tmp, "recipes", "sample-import", "runner.json");
    const recipe = JSON.parse(readFileSync(recipePath, "utf-8"));
    assert(result.ok, "recipe bootstrap exits cleanly");
    assert(existsSync(recipePath), "recipe bootstrap writes recipe.json");
    assert(!existsSync(runnerPath), "recipe bootstrap does not write runner.json");
    assert(recipe.id === "sample-import", "recipe bootstrap writes canonical id");
    assert(!("recipe_id" in recipe), "recipe bootstrap does not write legacy recipe_id");
    assert(Array.isArray(recipe.workflows), "recipe bootstrap emits workflows array");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioDiscoveryReviewFixtureMatchesIpbsShape() {
  const review = JSON.parse(readFileSync(discoveryReviewFixturePath, "utf-8"));
  const approved = review.candidates.find((candidate) => candidate.id === "daily_pipeline");
  const pending = review.candidates.find((candidate) => candidate.id === "pending_flow");

  assert(review.curated_by === "agent_manual_review", "discovery review fixture includes curated_by");
  assert(Array.isArray(review.candidates) && review.candidates.length === 2, "discovery review fixture has approved and pending candidates");
  assert(Array.isArray(approved?.workflows) && approved.workflows.includes(".agent/workflows/daily-ipbs.md"), "approved discovery candidate preserves workflows");
  assert(approved?.scripts?.[0]?.purpose === "Run the daily IPBS production pipeline", "approved discovery candidate preserves script purpose");
  assert(approved?.matched_story_refs?.every((entry) => typeof entry === "string"), "discovery review fixture uses string story refs");
  assert(approved?.matched_persona_findings?.[0]?.analyzer === "assumptions_challenger", "discovery review fixture preserves persona findings");
  assert(approved?.review?.runner?.command?.includes("scripts/prod/daily_runner.py"), "approved discovery candidate has review runner metadata");
  assert(pending?.review?.decision === "pending", "discovery review fixture includes a pending candidate");
}

function scenarioDiscoveryJsonPreviewPreservesIpbsFields() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-recipe-discovery-"));
  try {
    mkdirSync(join(tmp, "scripts", "prod"), { recursive: true });
    writeFileSync(join(tmp, "scripts", "prod", "daily_runner.py"), "print('daily')\n");
    const result = runJson([
      recipeDiscoveryPath,
      "--dir",
      tmp,
      "--goal",
      "run daily runner",
      "--json",
    ]);
    const candidate = result.json?.candidates?.[0];
    assert(result.ok, "recipe discovery --json exits cleanly");
    assert(Array.isArray(candidate?.workflows), "recipe discovery --json emits workflows array");
    assert(typeof candidate?.scripts?.[0]?.purpose === "string" && candidate.scripts[0].purpose.length > 0, "recipe discovery --json preserves script purpose");
    assert(Array.isArray(candidate?.matched_story_refs) && candidate.matched_story_refs.every((entry) => typeof entry === "string"), "recipe discovery --json emits string story refs");
    assert(Array.isArray(candidate?.matched_persona_findings), "recipe discovery --json preserves persona findings array");
    assert(candidate?.runner_hint?.command?.includes("scripts/prod/daily_runner.py"), "recipe discovery --json preserves runner hint");
    assert(Object.prototype.hasOwnProperty.call(candidate?.review || {}, "runner"), "recipe discovery --json preserves review runner field");
    assert(Object.prototype.hasOwnProperty.call(candidate?.review || {}, "required_params"), "recipe discovery --json preserves full review fields");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeDiscoveryFixtureInto(tmp) {
  mkdirSync(join(tmp, "recipes"), { recursive: true });
  writeFileSync(join(tmp, "recipes", "discovery_review.json"), readFileSync(discoveryReviewFixturePath, "utf-8"));
}

function scenarioDiscoveryBootstrapGatesOnApprovedCandidates() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-recipe-discovery-bootstrap-"));
  try {
    writeDiscoveryFixtureInto(tmp);
    const pendingResult = runJson([
      plannerCliPath,
      "recipe",
      "bootstrap",
      "--dir",
      tmp,
      "--from-discovery",
      "pending_flow",
      "--apply",
      "--json",
    ], plannerRoot, false);
    assert(!pendingResult.ok && pendingResult.status !== 0, "recipe bootstrap rejects pending discovery candidates");
    assert(String(pendingResult.stderr || "").includes("is not approved yet"), "pending discovery bootstrap explains approval gate");

    const approvedResult = runJson([
      plannerCliPath,
      "recipe",
      "bootstrap",
      "--dir",
      tmp,
      "--from-discovery",
      "daily_pipeline",
      "--apply",
      "--json",
    ]);
    const recipePath = join(tmp, "recipes", "daily-pipeline", "recipe.json");
    const capabilityPath = join(tmp, "recipes", "capability_registry.json");
    const recipe = JSON.parse(readFileSync(recipePath, "utf-8"));
    const capabilities = JSON.parse(readFileSync(capabilityPath, "utf-8"));

    assert(approvedResult.ok, "recipe bootstrap accepts approved discovery candidates");
    assert(recipe.id === "daily-pipeline", "approved discovery bootstrap writes canonical recipe id");
    assert(recipe.capability_id === "run_daily_pipeline", "approved discovery bootstrap writes canonical capability id");
    assert(recipe.workflows.includes(".agent/workflows/daily-ipbs.md"), "approved discovery bootstrap preserves workflows");
    assert(recipe.runner?.command?.includes("scripts/prod/daily_runner.py"), "approved discovery bootstrap preserves review runner");
    assert(capabilities.capabilities.some((entry) => entry.id === "run_daily_pipeline"), "approved discovery bootstrap writes capability registry");
    assert(!existsSync(join(tmp, "recipes", "daily-pipeline", "runner.json")), "approved discovery bootstrap does not write runner.json");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

scenarioCanonicalFixtureValidates();
scenarioLegacyFixtureAcceptedWithInfo();
scenarioDryRunProfileFailsClosed();
scenarioIpbsLiveSurfaceValidatesUnmodified();
scenarioTesseractLegacyReadCompatibility();
scenarioBootstrapWritesCanonicalRecipeJsonOnly();
scenarioDiscoveryReviewFixtureMatchesIpbsShape();
scenarioDiscoveryJsonPreviewPreservesIpbsFields();
scenarioDiscoveryBootstrapGatesOnApprovedCandidates();

console.log(`\nRecipe validate tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
