#!/usr/bin/env node
// test_preplanning_scaffolding.mjs
// Focused coverage for the EXPLORE pre-planning scaffold guard.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import {
  PREPLANNING_CODES,
  PREPLANNING_FINDINGS,
  evaluatePreplanningScaffolding,
} from "../scripts/lib/preplanning_scaffolding.mjs";
import { refreshPlanArtifacts } from "../scripts/lib/plan_refresh.mjs";
import { createInitialStateJson, readStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const storyRegistryScript = join(skillDir, "scripts", "story_registry.mjs");
const transitionScript = join(skillDir, "scripts", "transition.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function makeTemp(prefix = "planner-preplanning-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedPlan(tmp, {
  goal = "Implement Program Packet PGM-RITUAL-REDUCTION-2026 ticket T-INTAKE-0558093A",
  shape = "planner-core",
  findings = "# Findings\n\n## F-001\nThe fixture intentionally omits Program Context.\n",
} = {}) {
  const planName = "plan_2026-06-24_preplanning";
  const planDir = join(tmp, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Files To Modify
- .agent/skills/iterative-planner/scripts/transition.mjs
`);
  writeFileSync(join(planDir, "findings.md"), findings);
  writeFileSync(join(planDir, "verification.md"), "# Verification\n");
  const state = createInitialStateJson(planName, goal, { projectRoot: tmp });
  state.plan_shape = { primary: shape, source: "test", requirements: {} };
  writeStateJson(planDir, state);
  return { planName, planDir };
}

function seedManifesto(skillPath) {
  writeJson(join(skillPath, "config", "planner_manifesto.json"), {
    schema_version: 2,
    north_star_type: "traceability_only",
    core_metrics: [
      { id: "story_coverage", scope: "planner", threshold: ">=1" },
    ],
    invariant_directives: [
      { id: "traceable_planning", severity: "fail", description: "Planner work keeps story evidence linked." },
    ],
  });
}

function seedStoryRegistry(tmp, stories = [{ id: "US-1", status: "DRAFT" }]) {
  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    version: 1,
    stories,
  });
}

function seedProgramPacket(tmp) {
  writeJson(join(tmp, "plans", "programs", "ritual-reduction-2026", "program_packet.json"), {
    program_id: "PGM-RITUAL-REDUCTION-2026",
    title: "Lower planner ritual and close test-coverage gaps",
    status: "executing",
    tickets: [
      {
        id: "T-INTAKE-0558093A",
        title: "Pre-planning scaffolding check for missing North Star, story registry, and program context",
        lifecycle: "proposed",
      },
    ],
  });
}

function resultByName(report, name) {
  return report.results.find((result) => result.name === name);
}

function scenarioAllScaffoldInputsPass() {
  const tmp = makeTemp();
  try {
    const skillPath = join(tmp, "skill");
    seedManifesto(skillPath);
    seedStoryRegistry(tmp);
    seedProgramPacket(tmp);
    mkdirSync(join(skillPath, "scripts"), { recursive: true });
    writeFileSync(join(skillPath, "scripts", "story_registry_bootstrap.mjs"), `
import { writeFileSync } from "fs";
import { join } from "path";
writeFileSync(join(process.cwd(), "unexpected-story-bootstrap"), "ran");
console.log(JSON.stringify({ candidates: [] }));
`);
    const { planDir } = seedPlan(tmp, {
      findings: `# Findings

## Program Context
Program: PGM-RITUAL-REDUCTION-2026
Ticket: T-INTAKE-0558093A
`,
    });

    const report = evaluatePreplanningScaffolding({ cwd: tmp, planDir, skillPath });
    assert(resultByName(report, "North Star contract")?.status === "PASS", "valid manifesto satisfies North Star scaffold");
    assert(resultByName(report, "Story registry baseline")?.status === "PASS", "active story baseline satisfies scaffold");
    assert(resultByName(report, "Program Packet context")?.status === "PASS", "Program Context section satisfies matched packet scaffold");
    assert(report.actions.length === 0, "passing scaffold emits no repair actions");
    assert(!existsSync(join(tmp, "unexpected-story-bootstrap")), "valid registry does not launch the expensive story-bootstrap diagnostic");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioProgramPacketPrefersDirectTicketMatch() {
  const tmp = makeTemp();
  try {
    const skillPath = join(tmp, "skill");
    seedManifesto(skillPath);
    seedStoryRegistry(tmp);
    writeJson(join(tmp, "plans", "programs", "aaa-ambient-persona", "program_packet.json"), {
      program_id: "PGM-AMBIENT-PERSONA",
      title: "Ambient persona sync memory",
      status: "executing",
      tickets: [
        {
          id: "T-AMBIENT-1",
          title: "Ambient persona sync memory review",
          lifecycle: "proposed",
        },
      ],
    });
    writeJson(join(tmp, "plans", "programs", "zzz-remote-memory", "program_packet.json"), {
      program_id: "PGM-REMOTE-MEMORY",
      title: "Remote issue memory",
      status: "executing",
      tickets: [
        {
          id: "T-REMOTE-1",
          title: "Sync issue history",
          lifecycle: "proposed",
        },
      ],
    });
    const { planDir } = seedPlan(tmp, {
      goal: "Implement sync issue history for T-REMOTE-1 while ambient persona sync memory is mentioned in context",
      findings: `# Findings

## Program Context
Program: PGM-REMOTE-MEMORY
Ticket: T-REMOTE-1
`,
    });

    const report = evaluatePreplanningScaffolding({ cwd: tmp, planDir, skillPath });
    const programContext = resultByName(report, "Program Packet context");
    assert(programContext?.status === "PASS", "direct ticket id match beats earlier fuzzy Program Packet token match");
    assert(String(programContext?.detail || "").includes("PGM-REMOTE-MEMORY"), "Program Packet context reports the directly matched packet");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMissingScaffoldBlocksNormalPlannerWork() {
  const tmp = makeTemp();
  try {
    const skillPath = join(tmp, "skill");
    mkdirSync(skillPath, { recursive: true });
    seedProgramPacket(tmp);
    const { planDir } = seedPlan(tmp);

    const report = evaluatePreplanningScaffolding({ cwd: tmp, planDir, skillPath });
    const northStar = resultByName(report, "North Star contract");
    const storyRegistry = resultByName(report, "Story registry baseline");
    const programContext = resultByName(report, "Program Packet context");
    assert(northStar?.status === "FAIL" && northStar.code === PREPLANNING_CODES.northStar, "missing North Star blocks normal plans with stable code");
    assert(storyRegistry?.status === "FAIL" && storyRegistry.finding_id === PREPLANNING_FINDINGS.storyRegistryMissing, "missing story registry blocks normal plans with stable finding id");
    assert(programContext?.status === "FAIL" && programContext.code === PREPLANNING_CODES.programContext, "missing Program Context blocks matched normal plans");
    assert(report.actions.length === 3, "missing normal scaffold emits one repair action per missing item");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSkipPlannerShapesWarnOnly() {
  const tmp = makeTemp();
  try {
    const skillPath = join(tmp, "skill");
    mkdirSync(skillPath, { recursive: true });
    seedProgramPacket(tmp);
    const { planDir } = seedPlan(tmp, { shape: "analysis", goal: "Review Program Packet PGM-RITUAL-REDUCTION-2026 ticket T-INTAKE-0558093A" });

    const report = evaluatePreplanningScaffolding({ cwd: tmp, planDir, skillPath });
    assert(resultByName(report, "North Star contract")?.status === "WARN", "analysis shape softens missing North Star to WARN");
    assert(resultByName(report, "Story registry baseline")?.status === "WARN", "analysis shape softens missing story registry to WARN");
    assert(resultByName(report, "Program Packet context")?.status === "WARN", "analysis shape softens missing Program Context to WARN");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStoryRegistryMinimumUsesPolicyOverride() {
  const tmp = makeTemp();
  try {
    const skillPath = join(tmp, "skill");
    seedManifesto(skillPath);
    seedStoryRegistry(tmp, [{ id: "US-1", status: "DRAFT" }]);
    writeJson(join(tmp, "planner.policy.json"), {
      version: 1,
      story_registry: {
        enforced_for: ["code"],
        minimum_active_or_draft_stories: 2,
      },
    });
    const { planDir } = seedPlan(tmp);

    const report = evaluatePreplanningScaffolding({ cwd: tmp, planDir, skillPath });
    const storyRegistry = resultByName(report, "Story registry baseline");
    assert(storyRegistry?.status === "FAIL", "policy story minimum blocks below-threshold registry");
    assert(storyRegistry?.finding_id === PREPLANNING_FINDINGS.storyRegistryBelowMinimum, "below-threshold registry has stable finding id");
    assert(String(storyRegistry?.action || "").includes("story_registry_bootstrap.mjs --dry-run --json"), "below-threshold registry reports exact bootstrap dry-run command");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function runNode(args, cwd, extraEnv = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: plannerSubprocessEnv(extraEnv),
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

function probeStoryRegistryJson(root, args, label, expectedStatus) {
  const result = runNode([storyRegistryScript, ...args, "--json"], root);
  assert(result.status === expectedStatus, `${label} exits ${expectedStatus}`);
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    parseError = error.message;
  }
  assert(
    result.stdout.trim().length > 0 && parseError === null && parsed !== null,
    `${label} emits exactly one parseable JSON document`,
  );
  return parsed;
}

function scenarioStoryRegistryJsonExitPaths() {
  const tmp = makeTemp("planner-story-registry-json-");
  try {
    const missingRoot = join(tmp, "missing");
    const invalidRoot = join(tmp, "invalid");
    const incompleteRoot = join(tmp, "incomplete");
    mkdirSync(missingRoot, { recursive: true });
    const invalidRegistryPath = join(invalidRoot, "reports", "user_story_audit", "story_registry.json");
    mkdirSync(dirname(invalidRegistryPath), { recursive: true });
    writeFileSync(invalidRegistryPath, "{not-json\n");
    seedStoryRegistry(incompleteRoot, [{
      id: "US-INCOMPLETE-001",
      title: "Incomplete evidence fixture",
      status: "PARTIALLY_COVERED",
      code_refs: [],
      test_refs: [],
      validation_refs: [],
    }]);

    const invalidCheck = probeStoryRegistryJson(invalidRoot, ["check"], "invalid JSON registry check", 1);
    assert(invalidCheck?.status === "FAIL", "invalid JSON registry check reports FAIL");

    const missingCheck = probeStoryRegistryJson(missingRoot, ["check"], "missing-registry check", 0);
    assert(missingCheck?.status === "SKIP", "missing-registry check reports SKIP");

    const missingEvidence = probeStoryRegistryJson(missingRoot, ["evidence"], "missing-registry evidence", 0);
    assert(missingEvidence?.status === "SKIP", "missing-registry evidence reports SKIP");

    const missingDiff = probeStoryRegistryJson(missingRoot, ["diff", "src/changed.mjs"], "missing-registry diff", 0);
    assert(missingDiff?.count === 0 && Array.isArray(missingDiff?.affected), "missing-registry diff reports no affected stories");

    const unsafePrune = probeStoryRegistryJson(incompleteRoot, ["prune"], "prune without --safe", 1);
    assert(unsafePrune?.required_flag === "--safe", "prune without --safe reports the required flag");

    const missingPrune = probeStoryRegistryJson(missingRoot, ["prune", "--safe"], "missing-registry prune", 0);
    assert(missingPrune?.status === "SKIP", "missing-registry prune reports SKIP");

    const invalidPrune = probeStoryRegistryJson(invalidRoot, ["prune", "--safe"], "invalid JSON registry prune", 1);
    assert(invalidPrune?.status === "FAIL", "invalid JSON registry prune reports FAIL");

    const invalidEvidence = probeStoryRegistryJson(invalidRoot, ["evidence"], "invalid JSON registry evidence", 1);
    assert(invalidEvidence?.status === "FAIL", "invalid JSON registry evidence reports FAIL");

    const missingStory = probeStoryRegistryJson(incompleteRoot, ["evidence", "US-NOT-PRESENT"], "missing-story evidence", 1);
    assert(missingStory?.status === "FAIL", "missing-story evidence reports FAIL");

    const aggregateIncomplete = probeStoryRegistryJson(incompleteRoot, ["evidence"], "aggregate incomplete evidence", 1);
    assert(aggregateIncomplete?.status === "WARN", "aggregate incomplete evidence reports WARN");
    assert(aggregateIncomplete?.incomplete_count === 1, "aggregate incomplete evidence reports its incomplete story");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTransitionRunsScaffoldSection() {
  const tmp = makeTemp();
  try {
    symlinkSync(agentDir, join(tmp, ".agent"), "dir");
    seedProgramPacket(tmp);
    const { planName } = seedPlan(tmp);

    const transition = runNode([transitionScript, "explore-to-plan", "--plan", planName], tmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
      _PLANNER_FAST_TRACK: "1",
      _PLANNER_FAST_VERIFY: "1",
    });
    const output = `${transition.stdout}\n${transition.stderr}`;
    assert(!transition.ok, "transition smoke blocks the deliberately incomplete pre-planning fixture");
    assert(output.includes("Pre-Planning Scaffolding"), "transition output includes the pre-planning scaffold section");
    assert(output.includes(PREPLANNING_CODES.storyRegistry), "transition output includes the story registry scaffold failure code");
    assert(output.includes(PREPLANNING_CODES.programContext), "transition output includes the Program Context scaffold failure code");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanRefreshDefersSemanticSubstrateBeforeReflect() {
  const tmp = makeTemp();
  try {
    const planName = "plan_refresh_deferred_semantics";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "src", "config"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "src", "config", "runtime.ts"), "export const runtimeMode = process.env.LLM_MODE;\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Keep config flags coherent

## Files To Modify
- src/config/runtime.ts
`);
    writeFileSync(join(planDir, "verification.md"), "# Verification\n");
    const state = createInitialStateJson(planName, "Keep config flags coherent", { projectRoot: tmp });
    state.state = "PLAN";
    writeStateJson(planDir, state);

    const refresh = refreshPlanArtifacts({
      cwd: tmp,
      skillPath: skillDir,
      planDirName: planName,
      refreshOntology: false,
      persistOntology: false,
      persistState: true,
      syncFindings: false,
    });

    const reloaded = readStateJson(planDir);
    const semanticSubstrate = reloaded?.close_signals?.semantic_substrate;
    assert(refresh.refreshed === true, "PLAN-phase refresh still completes");
    assert(semanticSubstrate?.status === "deferred_until_reflect", "PLAN-phase refresh defers semantic substrate closeout diagnostics");
    assert(semanticSubstrate?.satisfied === true, "deferred semantic substrate signal is non-blocking before REFLECT");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapContractAndTriageCli() {
  const bootstrapScript = join(skillDir, "scripts", "bootstrap.mjs");
  const contractJson = execFileSync(NODE, [bootstrapScript, "contract", "Fix config flags", "--files=config/runtime.ts", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: plannerSubprocessEnv(),
  });
  const parsedContract = JSON.parse(contractJson);
  assert(parsedContract.goal === "Fix config flags", "bootstrap contract CLI outputs valid json");

  const contractText = execFileSync(NODE, [bootstrapScript, "contract", "Fix config flags", "--files=config/runtime.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: plannerSubprocessEnv(),
  });
  assert(contractText.includes("Goal: Fix config flags"), "bootstrap contract CLI outputs formatted text");

  const triageJson = execFileSync(NODE, [bootstrapScript, "triage", "Fix config flags", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: plannerSubprocessEnv(),
  });
  const parsedTriage = JSON.parse(triageJson);
  assert(parsedTriage.goal === "Fix config flags", "bootstrap triage CLI outputs valid json");

  const triageText = execFileSync(NODE, [bootstrapScript, "triage", "Fix config flags"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: plannerSubprocessEnv(),
  });
  assert(triageText.includes("Goal: Fix config flags"), "bootstrap triage CLI outputs formatted text");

  const helpText = execFileSync(NODE, [bootstrapScript, "help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: plannerSubprocessEnv(),
  });
  assert(helpText.includes("Usage:"), "bootstrap help CLI outputs usage");

  const listText = execFileSync(NODE, [bootstrapScript, "list"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: plannerSubprocessEnv(),
  });
  assert(typeof listText === "string", "bootstrap list CLI executes cleanly");

  try {
    execFileSync(NODE, [bootstrapScript, "triage"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: plannerSubprocessEnv(),
    });
    assert(false, "bootstrap triage without goal should exit non-zero");
  } catch (error) {
    assert(error.status === 2, "bootstrap triage without goal exits 2");
  }

  try {
    execFileSync(NODE, [bootstrapScript, "contract"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: plannerSubprocessEnv(),
    });
    assert(false, "bootstrap contract without goal or files should exit non-zero");
  } catch (error) {
    assert(error.status === 2, "bootstrap contract without goal or files exits 2");
  }
}

function scenarioBootstrapStatusDoesNotSelfDirtyCleanConsumer() {
  const tmp = makeTemp("planner-clean-status-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp });
    writeFileSync(join(tmp, "README.md"), "# Consumer\n");
    writeFileSync(join(tmp, ".gitignore"), "plans/.current_plan*\nplans/ACTIVE_PLAN.*\nplans/.thread_targets/\nplans/.audit-archive/\n");
    mkdirSync(join(tmp, "plans", "knowledge", "retros", "cases"), { recursive: true });
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(tmp, "plans", "knowledge", "retros", "retro_ledger.json"), JSON.stringify({ entries: [] }, null, 2));
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({ roles: ["core"], fail_on: ["HIGH"] }, null, 2));
    writeFileSync(join(tmp, "planner.policy.yaml"), "version: 1\n");
    mkdirSync(join(tmp, ".agent", "skills", "iterative-planner"), { recursive: true });
    execFileSync("cp", ["-r", `${skillDir}/.`, join(tmp, ".agent", "skills", "iterative-planner")]);
    mkdirSync(join(tmp, ".agent", "workflows"), { recursive: true });
    writeFileSync(join(tmp, ".agent", "workflows", "safe-change.md"), "# safe-change\n");

    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["commit", "-m", "clean initial state"], { cwd: tmp });

    const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: tmp, encoding: "utf8" });
    assert(statusBefore.trim() === "", "fixture starts clean");

    const bootstrapScript = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs");
    execFileSync(NODE, [bootstrapScript, "status"], {
      cwd: tmp,
      encoding: "utf8",
      env: plannerSubprocessEnv(),
    });
    const statusAfter1 = execFileSync("git", ["status", "--porcelain"], { cwd: tmp, encoding: "utf8" });
    assert(statusAfter1.trim() === "", "git status remains clean after first bootstrap status");

    execFileSync(NODE, [bootstrapScript, "status"], {
      cwd: tmp,
      encoding: "utf8",
      env: plannerSubprocessEnv(),
    });
    const statusAfter2 = execFileSync("git", ["status", "--porcelain"], { cwd: tmp, encoding: "utf8" });
    assert(statusAfter2.trim() === "", "git status remains clean after second bootstrap status");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nPre-Planning Scaffolding\n");

scenarioAllScaffoldInputsPass();
scenarioProgramPacketPrefersDirectTicketMatch();
scenarioMissingScaffoldBlocksNormalPlannerWork();
scenarioSkipPlannerShapesWarnOnly();
scenarioStoryRegistryMinimumUsesPolicyOverride();
scenarioStoryRegistryJsonExitPaths();
scenarioTransitionRunsScaffoldSection();
scenarioPlanRefreshDefersSemanticSubstrateBeforeReflect();
scenarioBootstrapContractAndTriageCli();
scenarioBootstrapStatusDoesNotSelfDirtyCleanConsumer();

if (!existsSync(transitionScript)) {
  assert(false, "transition.mjs exists for scaffold transition smoke");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

