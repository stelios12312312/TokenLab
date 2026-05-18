#!/usr/bin/env node
// test_project_lifecycle.mjs — Behavioral coverage for planner init,
// project diagnosis, and workflow customization detection.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const scriptDir = resolve(skillDir, "scripts");
const plannerCliPath = join(scriptDir, "planner.mjs");
const migrateCliPath = join(scriptDir, "migrate.mjs");
const NODE = process.execPath;
const SOURCE_REPO_ROOT = resolve(skillDir, "../../..");

let passed = 0;
let failed = 0;
const failures = [];

function log(message) {
  console.log(message);
}

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    log(`    FAIL: ${label}`);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    const raw = String(text || "");
    const start = raw.indexOf("{");
    if (start >= 0) {
      try {
        return JSON.parse(raw.slice(start));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function run(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

function runGit(args, cwd) {
  try {
    execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function makeTemp(name) {
  return mkdtempSync(join("/tmp", `planner-lifecycle-${name}-`));
}

function createTempProject(name) {
  const tmp = makeTemp(name);
  assert(runGit(["init"], tmp), `${name}: git init succeeds`);
  assert(runGit(["config", "user.name", "Codex Lifecycle"], tmp), `${name}: git user.name is configured`);
  assert(runGit(["config", "user.email", "codex-lifecycle@example.com"], tmp), `${name}: git user.email is configured`);
  return tmp;
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

function installPlannerFixture(cwd, label) {
  const result = run([migrateCliPath, "upgrade", cwd], cwd);
  assert(result.ok, `${label}: migrate upgrade installs the planner fixture`);
}

function writeVersionRouting(cwd, overrides = {}) {
  const document = {
    planner: "v7",
    flavor: "standard",
    created_at: "2026-04-22T00:00:00.000Z",
    migrated_from: "v6",
    agents_enabled: {
      agent_a: true,
      agent_b: false,
      agent_b_invocation: ["manual_cli"],
      agent_c: false,
      orchestrator: "none",
    },
    ...overrides,
  };
  writeFileSync(join(cwd, ".agent", "version.json"), `${JSON.stringify(document, null, 2)}\n`);
}

function setSourceProjectPath(cwd, sourceProjectPath = SOURCE_REPO_ROOT) {
  const registryPath = join(cwd, ".agent", "skills", "iterative-planner", "config", ".project_registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  registry.source_project_path = resolve(sourceProjectPath);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function scenarioPlannerInitScaffoldsGreenfieldRepo() {
  log("\n  Scenario 1: planner init scaffolds a clean git repo");
  const tmp = createTempProject("init-greenfield");
  try {
    const init = run([plannerCliPath, "init", "--json", "--flavor", "full"], tmp);
    assert(init.ok, "planner init exits cleanly for a clean git repo");
    const initJson = parseJson(init.stdout);
    assert(initJson?.ok === true, "planner init emits PASS JSON");
    assert(existsSync(join(tmp, ".agent", "version.json")), "planner init writes root .agent/version.json");
    assert(existsSync(join(tmp, ".agent", "forbidden_paths.yaml")), "planner init writes .agent/forbidden_paths.yaml");
    assert(existsSync(join(tmp, ".agent", "decisions", "0001-initial-v7-adoption.md")), "planner init writes the initial decision record");
    assert(existsSync(join(tmp, "reports", "errors", ".gitkeep")), "planner init seeds reports/errors/.gitkeep");
    assert(existsSync(join(tmp, "reports", "metrics", ".gitkeep")), "planner init seeds reports/metrics/.gitkeep");
    assert(existsSync(join(tmp, "reports", "user_story_audit", "story_registry.json")), "planner init seeds the canonical story registry");

    const versionDoc = parseJson(readFileSync(join(tmp, ".agent", "version.json"), "utf-8"));
    assert(versionDoc?.planner === "v7", "planner init records planner=v7 in the root version document");
    assert(versionDoc?.flavor === "full", "planner init preserves the requested flavor");
    assert(versionDoc?.agents_enabled?.orchestrator === "advisory", "planner init keeps full-flavor orchestration advisory-only");

    const diagnose = run([plannerCliPath, "project", "diagnose", "--json"], tmp);
    assert(!diagnose.ok, "planner project diagnose returns a non-zero status while the greenfield registry is still empty");
    const diagnoseJson = parseJson(diagnose.stdout);
    assert(diagnoseJson?.scenario === "greenfield_in_progress", "planner project diagnose classifies a freshly initialized repo as greenfield_in_progress");
    assert(diagnoseJson?.readiness?.overall === "SETUP_IN_PROGRESS", "planner project diagnose reports setup in progress for an empty registry");
    assert((diagnoseJson?.readiness?.blockers || []).some((entry) => entry.includes("Registry is empty")), "planner project diagnose explains that the empty registry blocks the first implementation task");
  } finally {
    cleanup(tmp);
  }
}

function scenarioProjectDiagnoseReadyGreenfieldDoesNotRepeatFirstStoryAction() {
  log("\n  Scenario 1b: project diagnose stops asking for the first story once one exists");
  const tmp = createTempProject("diagnose-greenfield-story");
  try {
    const init = run([plannerCliPath, "init", "--json"], tmp);
    assert(init.ok, "planner init exits cleanly before greenfield story diagnosis");

    const registryPath = join(tmp, "reports", "user_story_audit", "story_registry.json");
    const registry = parseJson(readFileSync(registryPath, "utf-8"));
    registry.stories = [
      {
        id: "US-001",
        title: "External fixture story",
        priority: "HIGH",
        status: "NOT_IMPLEMENTED",
        code_refs: ["src/example.mjs"],
        test_refs: ["test/example.test.mjs"],
        doc_refs: [],
        validation_refs: [],
        merged_from: [],
        conflicts: [],
      },
    ];
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const diagnose = run([plannerCliPath, "project", "diagnose", "--json"], tmp);
    assert(diagnose.ok, "planner project diagnose exits cleanly when the greenfield registry has a story");
    const diagnoseJson = parseJson(diagnose.stdout);
    const nextActions = diagnoseJson?.next_actions || [];
    assert(diagnoseJson?.readiness?.ready_for_first_task === true, "planner project diagnose marks greenfield repo ready after first story exists");
    assert(!nextActions.some((entry) => entry.includes("Add the first story")), "planner project diagnose does not repeat the stale first-story next action");
    assert(nextActions.includes("Run planner bootstrap-registry --validate --json after any story registry edits."), "planner project diagnose points at registry validation after stories exist");
  } finally {
    cleanup(tmp);
  }
}

function scenarioPlannerInitRejectsDirtyRepo() {
  log("\n  Scenario 2: planner init rejects a dirty repo");
  const tmp = createTempProject("init-dirty");
  try {
    writeFileSync(join(tmp, "README.md"), "# Dirty fixture\n");
    const init = run([plannerCliPath, "init", "--json"], tmp);
    assert(!init.ok, "planner init rejects a dirty git worktree");
    const initJson = parseJson(init.stdout);
    assert(initJson?.code === "git_dirty", "planner init reports the git_dirty failure code");
  } finally {
    cleanup(tmp);
  }
}

function scenarioPlannerInitRejectsExistingAgentDir() {
  log("\n  Scenario 3: planner init rejects repos that already contain .agent");
  const tmp = createTempProject("init-existing-agent");
  try {
    mkdirSync(join(tmp, ".agent"), { recursive: true });
    writeFileSync(join(tmp, ".agent", ".keep"), "seed\n");
    assert(runGit(["add", ".agent"], tmp), "existing-agent: git add succeeds");
    assert(runGit(["commit", "-m", "seed .agent"], tmp), "existing-agent: git commit succeeds");

    const init = run([plannerCliPath, "init", "--json"], tmp);
    assert(!init.ok, "planner init refuses repos that already contain .agent");
    const initJson = parseJson(init.stdout);
    assert(initJson?.code === "agent_dir_exists", "planner init reports the agent_dir_exists failure code");
  } finally {
    cleanup(tmp);
  }
}

function scenarioDirectProjectDiagnoseClassifiesMigrationCandidate() {
  log("\n  Scenario 4: direct project.mjs diagnose classifies a v6 migration candidate");
  const tmp = createTempProject("diagnose-v6");
  try {
    installPlannerFixture(tmp, "diagnose-v6");
    const projectCliPath = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "project.mjs");
    const diagnose = run([projectCliPath, "diagnose", "--json"], tmp);
    assert(diagnose.ok, "direct installed project.mjs diagnose exits cleanly");
    const diagnoseJson = parseJson(diagnose.stdout);
    assert(diagnoseJson?.scenario === "v6_migration_candidate", "direct installed project.mjs diagnose reports v6_migration_candidate before root version routing exists");
    assert((diagnoseJson?.next_actions || []).includes("planner workflow customize detect --json"), "direct installed project.mjs diagnose points operators at workflow customize detect for migration review");
  } finally {
    cleanup(tmp);
  }
}

function scenarioProjectDiagnoseFlagsLegacyInFlightPlans() {
  log("\n  Scenario 5: project diagnose flags legacy-format in-flight plans");
  const tmp = createTempProject("diagnose-legacy");
  try {
    installPlannerFixture(tmp, "diagnose-legacy");
    writeVersionRouting(tmp);
    mkdirSync(join(tmp, "plans", "plan_legacy_inflight"), { recursive: true });
    writeFileSync(join(tmp, "plans", "plan_legacy_inflight", "state.json"), `${JSON.stringify({ state: "EXECUTE" }, null, 2)}\n`);

    const diagnose = run([plannerCliPath, "project", "diagnose", "--json"], tmp);
    assert(!diagnose.ok, "planner project diagnose exits non-zero when a v7 migration still has a legacy-format plan in flight");
    const diagnoseJson = parseJson(diagnose.stdout);
    assert(diagnoseJson?.scenario === "migration_incomplete", "planner project diagnose reports migration_incomplete when legacy in-flight plans remain");
    assert((diagnoseJson?.readiness?.blockers || []).some((entry) => entry.includes("legacy-format plan")), "planner project diagnose surfaces the legacy-plan blocker explicitly");
  } finally {
    cleanup(tmp);
  }
}

function scenarioWorkflowCustomizationDetectionClassifiesPreserveAndDeprecate() {
  log("\n  Scenario 6: workflow customization detection classifies preserve and deprecate flows");
  const tmp = createTempProject("workflow-customize");
  try {
    installPlannerFixture(tmp, "workflow-customize");
    setSourceProjectPath(tmp);

    writeFileSync(
      join(tmp, ".agent", "workflows", "advisor.md"),
      `${readFileSync(join(tmp, ".agent", "workflows", "advisor.md"), "utf-8")}\n## Local Notes\nKeep this workflow note in the target repo.\n`
    );
    writeFileSync(
      join(tmp, ".agent", "workflows", "red-team-user-story-audit.md"),
      `${readFileSync(join(tmp, ".agent", "workflows", "red-team-user-story-audit.md"), "utf-8")}\n<!-- local migration note -->\n`
    );

    const workflowCliPath = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "workflow.mjs");
    const detect = run([workflowCliPath, "customize", "detect", "--json"], tmp);
    assert(detect.ok, "direct installed workflow.mjs customize detect exits cleanly");
    const detectJson = parseJson(detect.stdout);
    const customizations = detectJson?.workflow_customizations?.customizations || [];
    assert(customizations.length >= 2, "workflow customize detect reports the modified workflow files");
    assert(customizations.some((entry) => entry.workflow === "/advisor" && entry.action === "preserve" && entry.section === "Local Notes"), "workflow customize detect classifies added local sections as preserve");
    assert(customizations.some((entry) => entry.workflow === "/red-team-user-story-audit" && entry.action === "deprecate_on_migrate"), "workflow customize detect classifies deprecated workflow edits as deprecate_on_migrate");
  } finally {
    cleanup(tmp);
  }
}

function scenarioWorkflowCustomizationDetectionBlocksUnavailableSource() {
  log("\n  Scenario 7: workflow customization detection blocks when the canonical source is unavailable");
  const tmp = createTempProject("workflow-customize-missing-source");
  try {
    installPlannerFixture(tmp, "workflow-customize-missing-source");
    setSourceProjectPath(tmp, join(tmp, "missing-canonical-source"));

    writeFileSync(
      join(tmp, ".agent", "workflows", "advisor.md"),
      `${readFileSync(join(tmp, ".agent", "workflows", "advisor.md"), "utf-8")}\n## Local Notes\nThis customization should not be silently ignored.\n`
    );

    const workflowCliPath = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "workflow.mjs");
    const detect = run([workflowCliPath, "customize", "detect", "--json"], tmp);
    assert(detect.ok, "workflow customize detect still exits cleanly when the canonical source path is unavailable");
    const detectJson = parseJson(detect.stdout);
    const issues = detectJson?.workflow_customizations?.issues || [];
    assert(detectJson?.workflow_customizations?.source_project_available === false, "workflow customize detect marks the canonical source path unavailable");
    assert(issues.some((entry) => entry.code === "source_project_unavailable"), "workflow customize detect reports an explicit source_project_unavailable issue");
    assert(detectJson?.workflow_customizations?.customization_count === 0, "workflow customize detect does not claim fake customizations when the canonical source is unavailable");

    const diagnose = run([plannerCliPath, "project", "diagnose", "--json"], tmp);
    assert(!diagnose.ok, "planner project diagnose exits non-zero when workflow customization review cannot be trusted");
    const diagnoseJson = parseJson(diagnose.stdout);
    assert((diagnoseJson?.readiness?.blockers || []).some((entry) => entry.includes("workflow customization review cannot compare local workflows safely")), "planner project diagnose surfaces the unavailable canonical source as a blocker");
    assert((diagnoseJson?.next_actions || []).includes("Repair .agent/skills/iterative-planner/config/.project_registry.json source_project_path, then rerun planner workflow customize detect --json"), "planner project diagnose points operators at repairing source_project_path before migration review");
  } finally {
    cleanup(tmp);
  }
}

function scenarioProjectHealthRecommendsCommitMsgHookWithoutFailing() {
  log("\n  Scenario 8: project health recommends missing commit-msg hook without failing");
  const tmp = createTempProject("health-commit-msg-hook");
  try {
    installPlannerFixture(tmp, "health-commit-msg-hook");
    const health = run([plannerCliPath, "doctor", "--analyzer", "commit_msg_hook", "--json"], tmp);
    assert(health.ok, "planner doctor commit_msg_hook analyzer exits cleanly");
    const healthJson = parseJson(health.stdout);
    assert(healthJson?.summary?.fail === 0, "missing commit-msg hook does not create a FAIL finding");
    assert((healthJson?.findings || []).some((entry) =>
      entry.analyzer === "commit_msg_hook" &&
      entry.severity === "warn" &&
      String(entry.message || "").includes("commit-msg hook")
    ), "planner doctor reports the missing commit-msg hook as a recommendation");
  } finally {
    cleanup(tmp);
  }
}

function scenarioAdvertisedLifecycleRoutesReturnStructuredOutput() {
  log("\n  Scenario 9: advertised lifecycle routes return structured output");
  const tmp = createTempProject("advertised-lifecycle-routes");
  try {
    installPlannerFixture(tmp, "advertised-lifecycle-routes");
    writeVersionRouting(tmp);

    const projectPlan = run([plannerCliPath, "project", "plan", "--json"], tmp);
    assert(projectPlan.ok, "planner project plan exits cleanly");
    const projectPlanJson = parseJson(projectPlan.stdout);
    assert(projectPlanJson?.status === "PASS", "planner project plan emits PASS JSON");
    assert(Array.isArray(projectPlanJson?.plan?.steps), "planner project plan returns deterministic steps");

    mkdirSync(join(tmp, "plans", "plan_legacy_plan"), { recursive: true });
    writeFileSync(join(tmp, "plans", "plan_legacy_plan", "state.json"), `${JSON.stringify({ state: "PLAN" }, null, 2)}\n`);

    const planResolveList = run([plannerCliPath, "plan", "resolve", "--list", "--json"], tmp);
    assert(planResolveList.ok, "planner plan resolve --list exits cleanly");
    const planResolveJson = parseJson(planResolveList.stdout);
    assert(planResolveJson?.status === "PASS", "planner plan resolve --list emits PASS JSON");
    assert((planResolveJson?.plans || []).some((entry) => entry.id === "plan_legacy_plan" && entry.recommended_option === "convert-to-v7"), "planner plan resolve recommends conversion for early legacy plans");

    writeFileSync(join(tmp, "CLAUDE.md"), "# Local instructions\n\nKeep project-specific context.\n");
    const mergeClaude = run([plannerCliPath, "migrate", "merge-claude-md", tmp, "--json"], tmp);
    assert(mergeClaude.ok, "planner migrate merge-claude-md exits cleanly");
    const mergeClaudeJson = parseJson(mergeClaude.stdout);
    assert(mergeClaudeJson?.status === "PASS", "planner migrate merge-claude-md emits PASS JSON");
    assert(mergeClaudeJson?.write_status === "unchanged", "planner migrate merge-claude-md is non-destructive by default");
  } finally {
    cleanup(tmp);
  }
}

log("\n╔══════════════════════════════════════════════════════╗");
log("║  PROJECT LIFECYCLE TESTS                            ║");
log("╚══════════════════════════════════════════════════════╝");

scenarioPlannerInitScaffoldsGreenfieldRepo();
scenarioProjectDiagnoseReadyGreenfieldDoesNotRepeatFirstStoryAction();
scenarioPlannerInitRejectsDirtyRepo();
scenarioPlannerInitRejectsExistingAgentDir();
scenarioDirectProjectDiagnoseClassifiesMigrationCandidate();
scenarioProjectDiagnoseFlagsLegacyInFlightPlans();
scenarioWorkflowCustomizationDetectionClassifiesPreserveAndDeprecate();
scenarioWorkflowCustomizationDetectionBlocksUnavailableSource();
scenarioProjectHealthRecommendsCommitMsgHookWithoutFailing();
scenarioAdvertisedLifecycleRoutesReturnStructuredOutput();

log("\n──────────────────────────────────────────────────────");
log(`  Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  log("\n  Failures:");
  for (const failure of failures) log(`    - ${failure}`);
}

process.exit(failed > 0 ? 1 : 0);
