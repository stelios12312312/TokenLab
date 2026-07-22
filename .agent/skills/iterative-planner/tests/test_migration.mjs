#!/usr/bin/env node
// test_migration.mjs — User journey test for migration flow.
//
// Simulates what happens when a user:
//   1. Copies the planner's `.agent/` folder into a fresh project
//   2. Runs `migrate.mjs setup .`
//   3. Runs `migrate.mjs upgrade .`
//   4. Runs `migrate.mjs verify .`
//
// This catches the class of bug where migration exits early, skips
// project-level setup, or leaves the project in an inconsistent state.
//
// Usage:
//   node test_migration.mjs              Run all scenarios
//   node test_migration.mjs --verbose    Show full command output

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const verbose = process.argv.includes("--verbose");
// R-002 FIX: Use process.execPath so tests work when node isn't on default shell PATH
const NODE = process.execPath;

let passed = 0;
let failed = 0;
const failures = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) { console.log(msg); }
function assert(condition, label) {
  if (condition) {
    passed++;
    if (verbose) log(`    ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    log(`    ❌ ${label}`);
  }
}

function run(cmd, cwd) {
  try {
    const out = execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000, stdio: "pipe" });
    if (verbose) log(out);
    return { ok: true, stdout: out, exitCode: 0 };
  } catch (e) {
    if (verbose && e.stdout) log(e.stdout);
    if (verbose && e.stderr) log(e.stderr);
    return { ok: false, stdout: e.stdout || "", stderr: e.stderr || "", exitCode: e.status };
  }
}

function createTempProject(name) {
  const tmp = mkdtempSync(join(tmpdir(), `planner-test-${name}-`));
  // Init a git repo so setup can install hooks
  execSync("git init -q", { cwd: tmp });
  return tmp;
}

function removeConflictedCopyArtifacts(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      removeConflictedCopyArtifacts(full);
      continue;
    }
    if (entry.isFile() && /conflicted copy/i.test(entry.name)) {
      rmSync(full, { force: true });
    }
  }
}

function listConflictedCopyArtifacts(root) {
  const matches = [];
  if (!existsSync(root)) return matches;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...listConflictedCopyArtifacts(full));
      continue;
    }
    if (entry.isFile() && /conflicted copy/i.test(entry.name)) {
      matches.push(full);
    }
  }
  return matches;
}

function copyPlannerTo(targetPath) {
  const agentSrc = resolve(skillDir, "../..");
  cpSync(agentSrc, join(targetPath, ".agent"), { recursive: true });
  removeConflictedCopyArtifacts(join(targetPath, ".agent"));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function checkPlannerIntegrity(cwd) {
  const script = [
    "import{checkConfigIntegrity}from'./.agent/skills/iterative-planner/scripts/lib/determinism.mjs';",
    "console.log(JSON.stringify(checkConfigIntegrity()));",
  ].join("");
  const result = run(`${NODE} --input-type=module -e ${JSON.stringify(script)}`, cwd);
  if (!result.ok) return { intact: false, reason: result.stderr || result.stdout || "integrity command failed" };
  try {
    return JSON.parse(result.stdout.trim());
  } catch (e) {
    return { intact: false, reason: `integrity JSON parse failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function scenarioFreshProject() {
  log("\n  Scenario 1: Fresh project — copy planner, run full migration");
  const tmp = createTempProject("fresh");

  try {
    copyPlannerTo(tmp);

    // Step 1: setup
    const setupResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);
    assert(setupResult.ok, "setup exits cleanly");
    assert(existsSync(join(tmp, "audit.config.json")), "audit.config.json created by setup");
    assert(existsSync(join(tmp, "plans", "knowledge", "retros", "retro_ledger.json")), "retro_ledger.json created by setup");
    assert(existsSync(join(tmp, "plans", "knowledge", "retros", "cases")), "retro case directory created by setup");

    // Step 2: upgrade
    const upgradeResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .`, tmp);
    assert(upgradeResult.ok, "upgrade exits cleanly");

    // Step 3: verify
    const verifyResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs verify .`, tmp);
    assert(verifyResult.ok, "verify exits cleanly (PASS)");
    assert(verifyResult.stdout.includes("PASS"), "verify output contains PASS");
    assert(existsSync(join(tmp, "CLAUDE.md")), "CLAUDE.md created by setup");
    assert(existsSync(join(tmp, "GEMINI.md")), "GEMINI.md created by setup");
    assert(existsSync(join(tmp, "AGENTS.md")), "AGENTS.md created by setup");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/QUICKSTART.md")), "QUICKSTART.md ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/ERROR-RECOVERY.md")), "ERROR-RECOVERY.md ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/EDGE-CASES.md")), "EDGE-CASES.md ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/mcp_server.mjs")), "mcp_server.mjs ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/pre-commit-hook.sh")), "pre-commit-hook.sh ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/hooks/install.mjs")), "hook installer ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/hooks/pre-commit")), "managed pre-commit hook source ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/hooks/pre-push")), "managed pre-push hook source ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/hooks/pre_push_conformance.mjs")), "pre-push conformance helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/hooks/run-node.sh")), "Node resolver hook helper ships during migration");
    assert(existsSync(join(tmp, ".agent/scripts/migrate-all-projects.sh")), "migrate-all-projects.sh ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/snapshot_branch_protection.mjs")), "branch-protection snapshot CLI ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/semantic_map.mjs")), "semantic_map.mjs ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/config/semantic_map.schema.json")), "semantic_map.schema.json ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/semantic_maintenance.mjs")), "semantic_maintenance.mjs ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/semantic_maintenance.mjs")), "semantic maintenance helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_semantic_maintenance.mjs")), "semantic maintenance tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/program_manager.mjs")), "program_manager.mjs ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/program_packet.mjs")), "program_packet.mjs library ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/config/program_packet.schema.json")), "program_packet.schema.json ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/config/program_gates.json")), "program_gates.json ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/prolog/programs.pl")), "programs.pl ships during migration");
    assert(existsSync(join(tmp, ".agent/workflows/program-manager.md")), "program-manager workflow ships during migration");
    assert(existsSync(join(tmp, ".agent/workflows/roadmap-steward.md")), "roadmap-steward alias ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_program_manager.mjs")), "program manager tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/github_ticket_review.mjs")), "github_ticket_review.mjs ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_program_idea_intake.mjs")), "program idea intake tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_github_ticket_review.mjs")), "github ticket review tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_reflection_verdict_routing.mjs")), "reflection verdict routing tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/verification_runner.mjs")), "verification_runner.mjs ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/run_record.mjs")), "run_record helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_verification_runner.mjs")), "verification_runner tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/fixtures/programs/auto_executor.json")), "auto_executor fixture ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/fixtures/programs/dispatch_chain.json")), "dispatch_chain fixture ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_path_classifiers.mjs")), "path classifier tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_kb_relevance.mjs")), "KB relevance tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_plan_shape.mjs")), "plan shape tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/plan_shape.mjs")), "plan_shape.mjs ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_shape_ripple.mjs")), "shape ripple tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_v7_4_1_bugfixes.mjs")), "v7.4.1 bug-fix tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_v7_4_2_bugfixes.mjs")), "v7.4.2 bug-fix tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/pack_severity.mjs")), "pack_severity helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_chore_shape.mjs")), "chore shape tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_triage.mjs")), "triage tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/triage.mjs")), "triage library ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/planner_phase_routing.mjs")), "planner_phase_routing.mjs ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/persona_manifest_ci.mjs")), "persona_manifest_ci command ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/persona_manifest_ci.mjs")), "persona_manifest_ci library ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_persona_manifest_ci.mjs")), "persona_manifest_ci tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/ive/run.mjs")), "IVE conformance runner ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_ive_conformance_runner.mjs")), "IVE conformance runner tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_ci_enforcement_contracts.mjs")), "CI enforcement contract tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/ive_migration_bootstrap.mjs")), "IVE migration bootstrap helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_ive_migration_bootstrap.mjs")), "IVE migration bootstrap tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/project_ive.mjs")), "IVE projection CLI ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/ive_projection.mjs")), "IVE projection helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_ive_projection_north_star.mjs")), "IVE projection and North Star tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/ontology_write.mjs")), "IVE active ontology writer ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/ive_active_ontology.mjs")), "IVE active ontology helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_ive_active_ontology.mjs")), "IVE active ontology tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/ive_ideation_operators.mjs")), "IVE ideation operator helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_ive_ideation_operators.mjs")), "IVE ideation operator tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/reflection_renderer.mjs")), "IVE reflection renderer ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/ive_reflection_diff.mjs")), "IVE reflection diff helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs")), "IVE reflection diff tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/ive_advisory_records.mjs")), "IVE advisory records helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_ive_advisory_records.mjs")), "IVE advisory records tests ship during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/journal.mjs")), "agent journal CLI ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/scripts/lib/agent_journal.mjs")), "agent journal helper ships during migration");
    assert(existsSync(join(tmp, ".agent/skills/iterative-planner/tests/test_agent_journal.mjs")), "agent journal tests ship during migration");
    const claudeContent = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    assert(claudeContent.includes("notify-user"), "generated CLAUDE.md includes notify-user");
    assert(claudeContent.includes("## Domain Persona Autorun"), "generated CLAUDE.md includes the domain persona autorun front door");
    assert(claudeContent.includes("persona_adapt.mjs scan . --json"), "generated CLAUDE.md teaches persona adaptation scan");
    assert(claudeContent.includes("hyperparameter"), "generated CLAUDE.md exposes quant optimizer/hyperparameter obligations");
    assert(claudeContent.includes("ux_ui"), "generated CLAUDE.md exposes UX/UI persona routing");
    assert(claudeContent.includes("wiring_auditor"), "generated CLAUDE.md exposes wiring persona routing");
    assert(claudeContent.includes("config_integrity"), "generated CLAUDE.md exposes config-integrity persona routing");
    assert(claudeContent.includes("## Available Workflows"), "generated CLAUDE.md includes the available workflow catalog");
    assert(claudeContent.includes("/recipe-discovery"), "generated CLAUDE.md advertises /recipe-discovery");
    assert(claudeContent.includes("/program-manager"), "generated CLAUDE.md advertises /program-manager");
    const gatesJson = JSON.parse(readFileSync(join(tmp, ".agent/skills/iterative-planner/config/gates.json"), "utf-8"));
    assert(Object.values(gatesJson.gates || {}).every((gate) => gate?.authority_profile && typeof gate.authority_profile === "object"), "migrated gates.json ships authority_profile metadata for all gates");

    // Check version consistency
    const versionJson = JSON.parse(readFileSync(join(tmp, ".agent/skills/iterative-planner/config/version.json"), "utf-8"));
    const skillMd = readFileSync(join(tmp, ".agent/skills/iterative-planner/SKILL.md"), "utf-8");
    const versionMatch = skillMd.match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/);
    assert(versionMatch && versionMatch[1] === versionJson.version, `SKILL.md version (${versionMatch?.[1]}) matches version.json (${versionJson.version})`);

    // Check pre-commit hook installed
    assert(existsSync(join(tmp, ".git/hooks/pre-commit")), "pre-commit hook installed");

  } finally {
    cleanup(tmp);
  }
}

function scenarioAlreadyAtVersion() {
  log("\n  Scenario 2: Already at current version — upgrade is idempotent; setup repairs explicitly");
  const tmp = createTempProject("already-current");

  try {
    copyPlannerTo(tmp);

    // Run upgrade first to establish a clean current install with setup surfaces.
    const firstUpgrade = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .`, tmp);
    assert(firstUpgrade.ok, "initial upgrade exits cleanly");

    const auditPath = join(tmp, "audit.config.json");
    const hookPath = join(tmp, ".git/hooks/pre-commit");
    const snapshotPaths = [
      "CLAUDE.md",
      "GEMINI.md",
      "AGENTS.md",
      "audit.config.json",
      ".git/hooks/pre-commit",
      ".agent/skills/iterative-planner/config/.project_registry.json",
    ];
    const before = new Map(snapshotPaths.map((rel) => [rel, readFileSync(join(tmp, rel), "utf-8")]));

    const secondUpgrade = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .`, tmp);
    assert(secondUpgrade.ok, "second upgrade exits cleanly");
    assert(secondUpgrade.stdout.includes("read-only no-op"), "clean version-match upgrade reports read-only no-op");
    for (const rel of snapshotPaths) {
      assert(readFileSync(join(tmp, rel), "utf-8") === before.get(rel), `clean version-match upgrade leaves ${rel} unchanged`);
    }

    // Downgrade the root instructions to a stale planner-managed snapshot.
    const staleClaude = `# Project Instructions — Iterative Planner
<!-- Canonical source: CLAUDE.md. Synced to GEMINI.md and AGENTS.md via .agent/scripts/sync-instructions.sh -->

## Planning Mode Override

Follow the **EXPLORE → PLAN → EXECUTE → REFLECT → CLOSE** state machine. All transitions via:

\`\`\`bash
node .agent/skills/iterative-planner/scripts/transition.mjs <gate-name>
\`\`\`

## Transition Gate Quick Reference

| # | Gate | Command |
|---|------|---------|
| 1 | explore-to-plan | \`node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan\` |
| 2 | plan-to-execute | \`node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute\` |
| 3 | execute-to-reflect | \`node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect\` |
| 4 | reflect-to-close | \`node .agent/skills/iterative-planner/scripts/transition.mjs reflect-to-close\` |
`;
    writeFileSync(join(tmp, "CLAUDE.md"), staleClaude);
    writeFileSync(join(tmp, "GEMINI.md"), staleClaude);
    writeFileSync(join(tmp, "AGENTS.md"), staleClaude);

    const advisoryUpgrade = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .`, tmp);
    assert(advisoryUpgrade.ok, "advisory-only root instruction drift upgrade exits cleanly");
    assert(advisoryUpgrade.stdout.includes("read-only no-op"), "advisory-only root instruction drift does not force setup during upgrade");
    assert(readFileSync(join(tmp, "CLAUDE.md"), "utf-8") === staleClaude, "upgrade preserves stale managed root instructions until explicit setup");

    // Remove setup-owned surfaces so explicit setup proves the repair path.
    if (existsSync(auditPath)) rmSync(auditPath);
    if (existsSync(hookPath)) rmSync(hookPath);

    const setupResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);
    assert(setupResult.ok, "explicit setup exits cleanly");
    assert(existsSync(auditPath), "audit.config.json re-created by explicit setup");
    assert(existsSync(hookPath), "pre-commit hook re-installed by explicit setup");
    const refreshedClaude = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    assert(refreshedClaude.includes("BEGIN ITERATIVE-PLANNER MANAGED SNAPSHOT"), "explicit setup injects the managed root-instruction snapshot when canonical docs are stale");
    assert(refreshedClaude.includes("## Domain Persona Autorun"), "explicit setup restores the domain persona autorun front door in CLAUDE.md");
    assert(refreshedClaude.includes("persona_adapt.mjs scan . --json"), "explicit setup restores persona adaptation scan guidance");
    assert(refreshedClaude.includes("hyperparameter"), "explicit setup restores quant optimizer/hyperparameter guidance");
    assert(refreshedClaude.includes("ux_ui"), "explicit setup restores UX/UI persona guidance");
    assert(refreshedClaude.includes("wiring_auditor"), "explicit setup restores wiring persona guidance");
    assert(refreshedClaude.includes("config_integrity"), "explicit setup restores config-integrity persona guidance");
    assert(refreshedClaude.includes("/recipe-discovery"), "explicit setup restores the recipe workflow front door in CLAUDE.md");
    assert(refreshedClaude.includes("/program-manager"), "explicit setup restores the program-manager workflow front door in CLAUDE.md");
    assert(refreshedClaude.includes("notify-user"), "explicit setup restores the current notify-user gate instructions");
    assert(readFileSync(join(tmp, "GEMINI.md"), "utf-8") === refreshedClaude, "explicit setup re-syncs GEMINI.md from the refreshed CLAUDE.md");
    assert(readFileSync(join(tmp, "AGENTS.md"), "utf-8") === refreshedClaude, "explicit setup re-syncs AGENTS.md from the refreshed CLAUDE.md");

  } finally {
    cleanup(tmp);
  }
}

function scenarioStaleManagedHookRefreshes() {
  log("\n  Scenario 2b: Stale managed pre-commit hook refreshes on explicit setup");
  const tmp = createTempProject("stale-managed-hook");

  try {
    copyPlannerTo(tmp);
    run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .`, tmp);

    const hookPath = join(tmp, ".git/hooks/pre-commit");
    const sourceHookPath = join(skillDir, "scripts/hooks/pre-commit");
    const sourceHook = readFileSync(sourceHookPath, "utf-8");
    const staleManagedHook = `#!/bin/sh
# iterative-planner managed pre-commit hook
echo "  [pre-commit] Planner files staged — running ripple-through check..."
node ".agent/skills/iterative-planner/scripts/ripple_check.mjs"
`;
    writeFileSync(hookPath, staleManagedHook);

    const upgradeResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .`, tmp);
    assert(upgradeResult.ok, "upgrade exits cleanly with a stale managed hook present");
    assert(readFileSync(hookPath, "utf-8") === staleManagedHook, "upgrade leaves stale managed hook untouched when install is otherwise clean");

    const setupResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);
    assert(setupResult.ok, "setup exits cleanly with a stale managed hook present");
    assert(readFileSync(hookPath, "utf-8") === sourceHook, "setup refreshes the stale managed pre-commit hook to the current source");
  } finally {
    cleanup(tmp);
  }
}

function scenarioSetupIdempotent() {
  log("\n  Scenario 3: Setup is idempotent — running twice changes nothing");
  const tmp = createTempProject("idempotent");

  try {
    copyPlannerTo(tmp);
    run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);

    // Read state after first setup
    const auditContent1 = readFileSync(join(tmp, "audit.config.json"), "utf-8");
    const skillContent1 = readFileSync(join(tmp, ".agent/skills/iterative-planner/SKILL.md"), "utf-8");

    // Run setup again
    const result = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);
    assert(result.ok, "second setup exits cleanly");

    // Read state after second setup
    const auditContent2 = readFileSync(join(tmp, "audit.config.json"), "utf-8");
    const skillContent2 = readFileSync(join(tmp, ".agent/skills/iterative-planner/SKILL.md"), "utf-8");

    assert(auditContent1 === auditContent2, "audit.config.json unchanged after second setup");
    assert(skillContent1 === skillContent2, "SKILL.md unchanged after second setup");

  } finally {
    cleanup(tmp);
  }
}

function scenarioDetectVersion() {
  log("\n  Scenario 4: Detect reports correct version and needs-upgrade status");
  const tmp = createTempProject("detect");

  try {
    copyPlannerTo(tmp);

    const result = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs detect .`, tmp);
    assert(result.ok, "detect exits cleanly");
    assert(result.stdout.includes("Needs upgrade:    NO"), "detect says no upgrade needed for current version");

    // Now tamper with version to simulate old project
    const skillPath = join(tmp, ".agent/skills/iterative-planner/SKILL.md");
    let content = readFileSync(skillPath, "utf-8");
    content = content.replace(/planner_version:\s*["']?\d+\.\d+\.\d+["']?/, 'planner_version: "1.0.0"');
    writeFileSync(skillPath, content);

    const result2 = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs detect .`, tmp);
    assert(result2.ok, "detect exits cleanly with old version");
    assert(result2.stdout.includes("Needs upgrade:    YES"), "detect says upgrade needed for old version");

  } finally {
    cleanup(tmp);
  }
}

function scenarioStaleFilesUpdated() {
  log("\n  Scenario 5: Stale files are detected and updated (RT10-MIGRATE regression test)");
  const tmp = createTempProject("stale-upgrade");

  // Key insight: migrate.mjs resolves source paths relative to its own location.
  // To test cross-project upgrade (source != target), we must run the SOURCE repo's
  // migrate.mjs against the temp project as target path — not the temp project's copy.
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    // Establish baseline using source migrate against target
    run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);

    // Tamper with files to make them stale.
    // NOTE: SKILL.md is excluded because runProjectSetup modifies it (version marker),
    // making it always differ from source after setup. Use plain data files instead.
    const libPath = join(tmp, ".agent/skills/iterative-planner/scripts/lib/sanitize.mjs");
    const prologPath = join(tmp, ".agent/skills/iterative-planner/prolog/invariants.pl");

    const originalLib = readFileSync(libPath, "utf-8");
    const originalProlog = readFileSync(prologPath, "utf-8");

    writeFileSync(libPath, originalLib + "\n// STALE MARKER\n");
    writeFileSync(prologPath, originalProlog + "\n% STALE MARKER\n");

    // Verify (from source) should detect staleness
    const verifyResult = run(`${NODE} "${sourceMigrate}" verify "${tmp}"`, tmp);
    assert(
      verifyResult.stdout.includes("STALE") || verifyResult.stdout.includes("stale"),
      "verify detects stale files after tampering"
    );

    // Upgrade (from source) should fix them
    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "upgrade exits cleanly with stale files");
    assert(
      upgradeResult.stdout.includes("UPDATED:"),
      "upgrade output shows files were UPDATED (not just SKIP)"
    );

    // Content should be restored (stale marker gone)
    const restoredLib = readFileSync(libPath, "utf-8");
    const restoredProlog = readFileSync(prologPath, "utf-8");
    assert(!restoredLib.includes("STALE MARKER"), "sanitize.mjs stale marker removed after upgrade");
    assert(!restoredProlog.includes("STALE MARKER"), "invariants.pl stale marker removed after upgrade");

    // Final verify should pass (stale files fixed; SKILL.md may still differ due to setup)
    const finalVerify = run(`${NODE} "${sourceMigrate}" verify "${tmp}"`, tmp);
    assert(finalVerify.ok || finalVerify.stdout.includes("present"), "verify exits after stale files upgraded");

  } finally {
    cleanup(tmp);
  }
}

function scenarioQuotedPathUpgrade() {
  log("\n  Scenario 6: Upgrade works when the target path contains spaces/parentheses and an active plan");
  const tmp = createTempProject("quoted path (active)");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const bootstrapResult = run(`${NODE} .agent/skills/iterative-planner/scripts/bootstrap.mjs new "Quoted path regression"`, tmp);
    assert(bootstrapResult.ok, "bootstrap new exits cleanly in quoted path");

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "upgrade exits cleanly in quoted path");
    assert(!upgradeResult.stdout.includes("Could not seed circuit_breakers"), "upgrade does not emit circuit_breakers quoting warning");

    const planDirName = readFileSync(join(tmp, "plans/.current_plan"), "utf-8").trim();
    const stateJson = JSON.parse(readFileSync(join(tmp, "plans", planDirName, "state.json"), "utf-8"));
    assert(typeof stateJson.circuit_breakers === "object" && stateJson.circuit_breakers !== null, "upgrade seeds circuit_breakers in active plan state.json");
    assert(existsSync(join(tmp, "plans", planDirName, "findings_ledger.json")), "upgrade seeds findings_ledger.json in the active plan");
    assert(existsSync(join(tmp, "plans", planDirName, "intent_contract.json")), "upgrade seeds intent_contract.json in the active plan");
  } finally {
    cleanup(tmp);
  }
}

function scenarioStaleTargetSelfHeals() {
  log("\n  Scenario 7: Stale target self-heals through a normal bootstrap entrypoint");
  const tmp = createTempProject("stale-self-heal");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "source upgrade exits cleanly before the stale-target self-heal scenario");

    const missingLib = join(tmp, ".agent/skills/iterative-planner/scripts/lib/plan_utils.mjs");
    if (existsSync(missingLib)) rmSync(missingLib);
    assert(!existsSync(missingLib), "self-heal scenario removes a planner dependency before bootstrap runs");

    const healthResult = run(`${NODE} .agent/skills/iterative-planner/scripts/bootstrap.mjs install-health --json`, tmp);
    assert(healthResult.ok, "install-health emits JSON for the stale target");
    let healthJson = null;
    try { healthJson = JSON.parse(healthResult.stdout); } catch { /* asserted below */ }
    assert(!!healthJson, "install-health JSON parses successfully");
    assert(healthJson?.needs_repair === true, "install-health reports that the stale target needs repair");
    assert(healthJson?.self_heal_available === true, "install-health reports that canonical self-heal is available");

    const bootstrapResult = run(`${NODE} .agent/skills/iterative-planner/scripts/bootstrap.mjs status`, tmp);
    assert(bootstrapResult.ok, "bootstrap status self-heals and exits cleanly for the stale target");
    assert(bootstrapResult.stdout.includes("Planner Self-Heal"), "bootstrap status reports the self-heal preflight");
    assert(bootstrapResult.stdout.includes("No active plan."), "bootstrap status re-runs the original command after self-heal");
    assert(existsSync(missingLib), "bootstrap self-heal restores the missing planner dependency");
  } finally {
    cleanup(tmp);
  }
}

function scenarioCustomizedRootInstructionsDoNotTriggerRepair() {
  log("\n  Scenario 8: Customized root instructions are advisory, not a self-heal loop");
  const tmp = createTempProject("root-instruction-advisory");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "source upgrade exits cleanly before the advisory drift scenario");

    const customized = `# Project-specific instructions\n\nThis repo intentionally customizes the root prompt.\n`;
    writeFileSync(join(tmp, "CLAUDE.md"), customized);
    writeFileSync(join(tmp, "GEMINI.md"), customized);
    writeFileSync(join(tmp, "AGENTS.md"), customized);

    const doctorResult = run(`${NODE} "${sourceMigrate}" doctor "${tmp}" --json`, tmp);
    assert(doctorResult.ok, "doctor exits cleanly for customized root instructions");
    let doctorJson = null;
    try { doctorJson = JSON.parse(doctorResult.stdout); } catch { /* asserted below */ }
    assert(!!doctorJson, "doctor JSON parses for customized root instructions");
    assert(doctorJson?.needs_repair === false, "doctor does not flag project-specific root instructions as repairable drift");
    assert((doctorJson?.stale_files || []).length === 0, "doctor does not report customized root instructions as stale planner files");
    assert((doctorJson?.advisory_issues || []).length === 0, "doctor stays fully clean when the mirror files match the customized CLAUDE.md");

    const bootstrapResult = run(`${NODE} .agent/skills/iterative-planner/scripts/bootstrap.mjs status`, tmp);
    assert(bootstrapResult.ok, "bootstrap status exits cleanly with customized root instructions");
    assert(!bootstrapResult.stdout.includes("Planner Self-Heal"), "bootstrap status does not trigger self-heal for advisory-free root customization");
    assert(bootstrapResult.stdout.includes("No active plan."), "bootstrap status still runs the original command after skipping self-heal");

    const setupResult = run(`${NODE} "${sourceMigrate}" setup "${tmp}"`, tmp);
    assert(setupResult.ok, "setup exits cleanly for customized root instructions");
    const refreshedCustom = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    assert(!refreshedCustom.includes("BEGIN ITERATIVE-PLANNER MANAGED SNAPSHOT"), "setup does not inject the managed snapshot into intentionally customized root instructions");
    assert(refreshedCustom === customized, "setup preserves intentionally customized CLAUDE.md content");
  } finally {
    cleanup(tmp);
  }
}

function scenarioRootInstructionSyncPreservesHostContent() {
  log("\n  Scenario 8b: Root instruction sync preserves target-owned host content");
  const tmp = createTempProject("root-instruction-rendering");

  try {
    copyPlannerTo(tmp);
    const setupResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);
    assert(setupResult.ok, "initial setup exits cleanly before root instruction rendering fixture");

    const claudePath = join(tmp, "CLAUDE.md");
    const geminiPath = join(tmp, "GEMINI.md");
    const agentsPath = join(tmp, "AGENTS.md");
    writeFileSync(claudePath, `${readFileSync(claudePath, "utf-8")}\nCLAUDE PRIVATE HOST NOTE - should not propagate.\n`);
    writeFileSync(geminiPath, `${readFileSync(geminiPath, "utf-8")}\nGEMINI PRIVATE HOST NOTE - should stay.\n`);
    rmSync(agentsPath, { force: true });

    const syncResult = run(`bash .agent/scripts/sync-instructions.sh`, tmp);
    assert(syncResult.ok, "sync-instructions exits cleanly through migrate sync command");

    const gemini = readFileSync(geminiPath, "utf-8");
    const agents = readFileSync(agentsPath, "utf-8");
    assert(gemini.includes("GEMINI PRIVATE HOST NOTE - should stay."), "sync preserves Gemini-owned host content");
    assert(!gemini.includes("CLAUDE PRIVATE HOST NOTE - should not propagate."), "sync does not copy Claude-owned host content into Gemini");
    assert(!agents.includes("CLAUDE PRIVATE HOST NOTE - should not propagate."), "sync creates AGENTS from managed template rather than local Claude content");
  } finally {
    cleanup(tmp);
  }
}

function scenarioRegistryUpgradeMetadataDoesNotTriggerStaleVerify() {
  log("\n  Scenario 9: Registry runtime metadata does not trigger post-upgrade staleness");
  const sourceTmp = createTempProject("registry-source");
  const targetTmp = createTempProject("registry-target");

  try {
    copyPlannerTo(sourceTmp);
    copyPlannerTo(targetTmp);

    const sourceMigrate = join(sourceTmp, ".agent/skills/iterative-planner/scripts/migrate.mjs");
    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${targetTmp}"`, sourceTmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly before registry metadata drift test");

    const sourceRegistryPath = join(sourceTmp, ".agent/skills/iterative-planner/config/.project_registry.json");
    const sourceRegistry = JSON.parse(readFileSync(sourceRegistryPath, "utf-8"));
    sourceRegistry.last_scan = "2026-04-06T08:14:00.000Z";
    sourceRegistry.scan_roots = [sourceTmp, join(sourceTmp, "nested-scan-root")];
    sourceRegistry.projects = Array.isArray(sourceRegistry.projects)
      ? sourceRegistry.projects.map((project, index) => ({
          ...project,
          ...(index < 2 ? { last_upgraded: `2026-04-05T09:28:16.0${index}Z` } : {}),
        }))
      : sourceRegistry.projects;
    writeFileSync(sourceRegistryPath, JSON.stringify(sourceRegistry, null, 2) + "\n");

    const verifyResult = run(`${NODE} "${sourceMigrate}" verify "${targetTmp}"`, sourceTmp);
    assert(verifyResult.ok, "verify exits cleanly when registry differs only by runtime metadata");
    assert(!verifyResult.stdout.includes(".project_registry.json"), "verify ignores runtime-only registry drift");

    const fleetRegistry = {
      source_project_path: sourceTmp,
      projects: [
        {
          path: targetTmp,
          type: "current",
          last_upgraded: "2026-04-05T09:28:16.000Z",
        },
      ],
      last_scan: new Date().toISOString(),
      scan_roots: [targetTmp],
    };
    writeFileSync(sourceRegistryPath, JSON.stringify(fleetRegistry, null, 2) + "\n");
    const registryBeforeUpgradeAll = readFileSync(sourceRegistryPath, "utf-8");
    const upgradeAllResult = run(`${NODE} "${sourceMigrate}" upgrade-all`, sourceTmp);
    assert(upgradeAllResult.ok, "upgrade-all exits cleanly for already-current clean target");
    assert(upgradeAllResult.stdout.includes("read-only no-op"), "upgrade-all reports no-op upgrade for clean current target");
    assert(!upgradeAllResult.stdout.includes("PROJECT SETUP"), "upgrade-all does not run setup for clean current target");
    assert(readFileSync(sourceRegistryPath, "utf-8") === registryBeforeUpgradeAll, "upgrade-all preserves registry metadata for clean current target");
  } finally {
    cleanup(sourceTmp);
    cleanup(targetTmp);
  }
}

function scenarioSourceDrivenSelfUpdatePropagatesFullUpgrade() {
  log("\n  Scenario 10: Source-driven self-update still upgrades the rest of the planner in one pass");
  const sourceTmp = createTempProject("self-update-source");
  const targetTmp = createTempProject("self-update-target");

  try {
    copyPlannerTo(sourceTmp);
    copyPlannerTo(targetTmp);

    const sourceMigratePath = join(sourceTmp, ".agent/skills/iterative-planner/scripts/migrate.mjs");
    const sourceTestPath = join(sourceTmp, ".agent/skills/iterative-planner/tests/test_migration_wave_policy.mjs");
    writeFileSync(sourceMigratePath, `${readFileSync(sourceMigratePath, "utf-8").trimEnd()}\n// self-update one-pass regression marker\n`);
    writeFileSync(sourceTestPath, `${readFileSync(sourceTestPath, "utf-8").trimEnd()}\n// self-update propagated asset marker\n`);

    const upgradeResult = run(`${NODE} "${sourceMigratePath}" upgrade "${targetTmp}"`, sourceTmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly when migrate.mjs self-updates first");
    assert(
      upgradeResult.stdout.includes("SELF-UPDATE: migrate.mjs refreshed on target before continuing"),
      "upgrade reports the source-driven self-update refresh"
    );
    assert(
      readFileSync(join(targetTmp, ".agent/skills/iterative-planner/tests/test_migration_wave_policy.mjs"), "utf-8").includes("// self-update propagated asset marker"),
      "one-pass self-update still propagates other stale planner-managed files"
    );

    const verifyResult = run(`${NODE} "${sourceMigratePath}" verify "${targetTmp}"`, sourceTmp);
    assert(verifyResult.ok, "verify exits cleanly after the one-pass self-update upgrade");
    assert(!verifyResult.stdout.includes("test_migration_wave_policy.mjs"), "verify does not report the propagated asset as stale after one-pass self-update");
  } finally {
    cleanup(sourceTmp);
    cleanup(targetTmp);
  }
}

function scenarioConflictedCopyArtifactsAreIgnoredDuringUpgrade() {
  log("\n  Scenario 11: Upgrade ignores Dropbox conflicted-copy artifacts from the source planner tree");
  const sourceTmp = createTempProject("conflicted-source");
  const targetTmp = createTempProject("conflicted-target");

  try {
    copyPlannerTo(sourceTmp);
    copyPlannerTo(targetTmp);

    const conflictedWorkflow = join(
      sourceTmp,
      ".agent/workflows/safe-change (Stylianos’s MacBook Pro (2)'s conflicted copy 2026-04-08).md"
    );
    const conflictedReference = join(
      sourceTmp,
      ".agent/skills/iterative-planner/references/file-formats (Stylianos’s MacBook Pro (2)'s conflicted copy 2026-04-08).md"
    );
    writeFileSync(conflictedWorkflow, "# conflicted workflow copy\n");
    writeFileSync(conflictedReference, "# conflicted reference copy\n");

    const sourceMigrate = join(sourceTmp, ".agent/skills/iterative-planner/scripts/migrate.mjs");
    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${targetTmp}"`, sourceTmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly when source tree contains conflicted-copy artifacts");
    assert(
      listConflictedCopyArtifacts(join(targetTmp, ".agent")).length === 0,
      "upgrade does not copy conflicted-copy artifacts into the target project"
    );
  } finally {
    cleanup(sourceTmp);
    cleanup(targetTmp);
  }
}

function scenarioDoctorFlagsMissingShippedDocsAndWrappers() {
  log("\n  Scenario 12: Doctor flags missing shipped docs and wrapper assets");
  const tmp = createTempProject("doctor-install-completeness");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly before install-completeness doctor check");

    const missingQuickstart = join(tmp, ".agent/skills/iterative-planner/QUICKSTART.md");
    const missingHook = join(tmp, ".agent/skills/iterative-planner/scripts/hooks/pre-commit");
    const missingRunNode = join(tmp, ".agent/skills/iterative-planner/scripts/hooks/run-node.sh");
    const missingMigrateAll = join(tmp, ".agent/scripts/migrate-all-projects.sh");
    rmSync(missingQuickstart, { force: true });
    rmSync(missingHook, { force: true });
    rmSync(missingRunNode, { force: true });
    rmSync(missingMigrateAll, { force: true });

    const doctorResult = run(`${NODE} "${sourceMigrate}" doctor "${tmp}" --json`, tmp);
    assert(doctorResult.ok, "doctor exits cleanly when shipped assets are missing");
    let doctorJson = null;
    try { doctorJson = JSON.parse(doctorResult.stdout); } catch { /* asserted below */ }
    assert(!!doctorJson, "doctor JSON parses when shipped assets are missing");
    assert(doctorJson?.needs_repair === true, "doctor marks missing shipped assets as repairable drift");
    const missingPaths = new Set((doctorJson?.missing_files || []).map((entry) => entry.path));
    assert(missingPaths.has(".agent/skills/iterative-planner/QUICKSTART.md"), "doctor reports QUICKSTART.md as a missing shipped asset");
    assert(missingPaths.has(".agent/skills/iterative-planner/scripts/hooks/pre-commit"), "doctor reports the managed pre-commit hook source as missing");
    assert(missingPaths.has(".agent/skills/iterative-planner/scripts/hooks/run-node.sh"), "doctor reports the Node resolver helper as a missing shipped asset");
    assert(missingPaths.has(".agent/scripts/migrate-all-projects.sh"), "doctor reports migrate-all-projects.sh as missing");
  } finally {
    cleanup(tmp);
  }
}

function scenarioProgramManagerTestsExecute() {
  log("\n  Scenario: program_manager test suite executes from a migrated project");
  const tmp = createTempProject("program-manager-exec");
  try {
    copyPlannerTo(tmp);
    run(`node .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);
    const result = run(`node .agent/skills/iterative-planner/tests/test_program_manager.mjs`, tmp);
    assert(result.ok, "test_program_manager.mjs exits 0 in a migrated project");
    assert(/Results:\s+\d+\s+passed,\s+0\s+failed/.test(result.stdout), "test_program_manager.mjs reports zero failures");
    // Guards against the entry-guard regression where main() never runs and
    // every assertion past the existence check is skipped silently.
    assert(/PASS:\s+valid Program Packet passes check/.test(result.stdout), "test_program_manager.mjs reaches the JSON assertions (entry guard fires)");
  } finally {
    cleanup(tmp);
  }
}

function scenarioWalkthroughRetirementHonored() {
  log("\n  Scenario: walkthrough.md retired — full plan closes via summary.md alone");
  const tmp = createTempProject("walkthrough-retired");
  try {
    copyPlannerTo(tmp);
    run(`node .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);

    // Spawn a verify_gate run that previously could only succeed via the legacy
    // walkthrough.md tag fallback. Now the structured signal + summary.md path
    // is the only route. We assert the runner reports the legacy walkthrough
    // tag is no longer honored as a fallback by reading verify_gate.mjs source.
    const verifyGateSource = readFileSync(
      join(tmp, ".agent/skills/iterative-planner/scripts/verify_gate.mjs"),
      "utf-8"
    );
    assert(!/Legacy KB evidence found via walkthrough tag/.test(verifyGateSource),
      "verify_gate.mjs no longer cites walkthrough.md as a KB-evidence fallback");
    assert(/walkthrough\.md retired/i.test(verifyGateSource) || /walkthrough.*retired/i.test(verifyGateSource),
      "verify_gate.mjs records the walkthrough retirement comment");

    // The lightweight /safe-change flow should still document walkthrough.md
    // as the canonical close artifact for that path — retirement is scoped to
    // the full-flow KB fallback only.
    const skillSource = readFileSync(
      join(tmp, ".agent/skills/iterative-planner/SKILL.md"),
      "utf-8"
    );
    assert(/Lightweight Invocation[\s\S]+walkthrough\.md/.test(skillSource),
      "SKILL.md preserves walkthrough.md as the lightweight-flow close artifact");
  } finally {
    cleanup(tmp);
  }
}

function scenarioIveProfileAndKnowledgePackAssetsMigrate() {
  log("\n  Scenario: IVE profile evaluator and knowledge-pack assets migrate");
  const tmp = createTempProject("ive-profile-pack-migrate");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const expected = [
      ".agent/skills/iterative-planner/scripts/check_profile.mjs",
      ".agent/skills/iterative-planner/scripts/knowledge_packs.mjs",
      ".agent/skills/iterative-planner/scripts/lib/ive_profile_packs.mjs",
      ".agent/skills/iterative-planner/tests/test_ive_profile_knowledge_packs.mjs",
      ".agent/skills/iterative-planner/profiles/quant_alpha.profile.json",
      ".agent/skills/iterative-planner/knowledge_packs/machine_learning/pack.json",
      ".agent/skills/iterative-planner/knowledge_packs/machine_learning/pitfalls.json",
    ];
    for (const relPath of expected) {
      rmSync(join(tmp, relPath), { force: true });
    }

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly when IVE profile/pack assets are missing");
    for (const relPath of expected) {
      assert(existsSync(join(tmp, relPath)), `upgrade copies ${relPath}`);
    }

    const verifyResult = run(`${NODE} "${sourceMigrate}" verify "${tmp}"`, tmp);
    assert(verifyResult.ok, "verify exits cleanly after profile/pack assets are restored");
    assert(!verifyResult.stdout.includes("knowledge_packs/machine_learning/pack.json"), "verify no longer reports restored knowledge-pack manifest as missing");
  } finally {
    cleanup(tmp);
  }
}

function scenarioIveActiveOntologyAssetsMigrate() {
  log("\n  Scenario: IVE active ontology assets migrate");
  const tmp = createTempProject("ive-active-ontology-migrate");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const expected = [
      ".agent/skills/iterative-planner/scripts/ontology_write.mjs",
      ".agent/skills/iterative-planner/scripts/lib/ive_active_ontology.mjs",
      ".agent/skills/iterative-planner/tests/test_ive_active_ontology.mjs",
    ];
    for (const relPath of expected) {
      rmSync(join(tmp, relPath), { force: true });
    }

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly when IVE active-ontology assets are missing");
    for (const relPath of expected) {
      assert(existsSync(join(tmp, relPath)), `upgrade copies ${relPath}`);
    }

    const verifyResult = run(`${NODE} "${sourceMigrate}" verify "${tmp}"`, tmp);
    assert(verifyResult.ok, "verify exits cleanly after active-ontology assets are restored");
    assert(!verifyResult.stdout.includes("ive_active_ontology.mjs"), "verify no longer reports restored active-ontology helper as missing");
  } finally {
    cleanup(tmp);
  }
}

function scenarioIveIdeationOperatorAssetsMigrate() {
  log("\n  Scenario: IVE ideation operator assets migrate");
  const tmp = createTempProject("ive-ideation-operator-migrate");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const expected = [
      ".agent/skills/iterative-planner/scripts/lib/ive_ideation_operators.mjs",
      ".agent/skills/iterative-planner/tests/test_ive_ideation_operators.mjs",
    ];
    for (const relPath of expected) {
      rmSync(join(tmp, relPath), { force: true });
    }

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly when IVE ideation assets are missing");
    for (const relPath of expected) {
      assert(existsSync(join(tmp, relPath)), `upgrade copies ${relPath}`);
    }

    const verifyResult = run(`${NODE} "${sourceMigrate}" verify "${tmp}"`, tmp);
    assert(verifyResult.ok, "verify exits cleanly after ideation assets are restored");
    assert(!verifyResult.stdout.includes("ive_ideation_operators.mjs"), "verify no longer reports restored ideation helper as missing");
  } finally {
    cleanup(tmp);
  }
}

function scenarioIveReflectionDiffAssetsMigrate() {
  log("\n  Scenario: IVE reflection-diff assets migrate");
  const tmp = createTempProject("ive-reflection-diff-migrate");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const expected = [
      ".agent/skills/iterative-planner/scripts/reflection_renderer.mjs",
      ".agent/skills/iterative-planner/scripts/lib/ive_reflection_diff.mjs",
      ".agent/skills/iterative-planner/tests/test_ive_reflection_diff.mjs",
    ];
    for (const relPath of expected) {
      rmSync(join(tmp, relPath), { force: true });
    }

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly when IVE reflection-diff assets are missing");
    for (const relPath of expected) {
      assert(existsSync(join(tmp, relPath)), `upgrade copies ${relPath}`);
    }

    const verifyResult = run(`${NODE} "${sourceMigrate}" verify "${tmp}"`, tmp);
    assert(verifyResult.ok, "verify exits cleanly after reflection-diff assets are restored");
    assert(!verifyResult.stdout.includes("ive_reflection_diff.mjs"), "verify no longer reports restored reflection-diff helper as missing");
  } finally {
    cleanup(tmp);
  }
}

function scenarioIveAdvisoryRecordAssetsMigrate() {
  log("\n  Scenario: IVE advisory-record assets migrate");
  const tmp = createTempProject("ive-advisory-record-migrate");
  const sourceMigrate = join(skillDir, "scripts/migrate.mjs");

  try {
    copyPlannerTo(tmp);

    const expected = [
      ".agent/skills/iterative-planner/scripts/lib/ive_advisory_records.mjs",
      ".agent/skills/iterative-planner/tests/test_ive_advisory_records.mjs",
    ];
    for (const relPath of expected) {
      rmSync(join(tmp, relPath), { force: true });
    }

    const upgradeResult = run(`${NODE} "${sourceMigrate}" upgrade "${tmp}"`, tmp);
    assert(upgradeResult.ok, "cross-project upgrade exits cleanly when IVE advisory-record assets are missing");
    for (const relPath of expected) {
      assert(existsSync(join(tmp, relPath)), `upgrade copies ${relPath}`);
    }

    const verifyResult = run(`${NODE} "${sourceMigrate}" verify "${tmp}"`, tmp);
    assert(verifyResult.ok, "verify exits cleanly after advisory-record assets are restored");
    assert(!verifyResult.stdout.includes("ive_advisory_records.mjs"), "verify no longer reports restored advisory helper as missing");
  } finally {
    cleanup(tmp);
  }
}

function scenarioUpgradeDoesNotLaunderTamperedPrologBaseline() {
  log("\n  Scenario: Upgrade does not launder a tampered Prolog integrity baseline");
  const tmp = createTempProject("config-integrity-tamper");

  try {
    copyPlannerTo(tmp);
    const setupResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs setup .`, tmp);
    assert(setupResult.ok, "setup exits cleanly before tamper-laundering fixture");

    const transitionsPath = join(tmp, ".agent/skills/iterative-planner/prolog/transitions.pl");
    writeFileSync(transitionsPath, readFileSync(transitionsPath, "utf-8").trimEnd() + "\n\ncan_transition(_, _).\n");
    const beforeUpgrade = checkPlannerIntegrity(tmp);
    assert(beforeUpgrade.intact === false, "tampered transitions.pl is detected before upgrade");

    rmSync(join(tmp, "audit.config.json"), { force: true });
    const upgradeResult = run(`${NODE} .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .`, tmp);
    assert(upgradeResult.ok, "same-project upgrade exits cleanly while setup repair is pending");
    assert(!upgradeResult.stdout.includes("CONFIG INTEGRITY: Re-baselined after upgrade"), "upgrade does not rebaseline config integrity without out-of-band approval");

    const afterUpgrade = checkPlannerIntegrity(tmp);
    assert(afterUpgrade.intact === false, "tampered transitions.pl remains detected after upgrade");
  } finally {
    cleanup(tmp);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

log("\n╔══════════════════════════════════════════════════════╗");
log("║  MIGRATION USER JOURNEY TESTS                       ║");
log("╚══════════════════════════════════════════════════════╝");

scenarioFreshProject();
scenarioProgramManagerTestsExecute();
scenarioWalkthroughRetirementHonored();
scenarioAlreadyAtVersion();
scenarioStaleManagedHookRefreshes();
scenarioSetupIdempotent();
scenarioDetectVersion();
scenarioStaleFilesUpdated();
scenarioQuotedPathUpgrade();
scenarioStaleTargetSelfHeals();
scenarioCustomizedRootInstructionsDoNotTriggerRepair();
scenarioRootInstructionSyncPreservesHostContent();
scenarioRegistryUpgradeMetadataDoesNotTriggerStaleVerify();
scenarioSourceDrivenSelfUpdatePropagatesFullUpgrade();
scenarioConflictedCopyArtifactsAreIgnoredDuringUpgrade();
scenarioIveProfileAndKnowledgePackAssetsMigrate();
scenarioIveActiveOntologyAssetsMigrate();
scenarioIveIdeationOperatorAssetsMigrate();
scenarioIveReflectionDiffAssetsMigrate();
scenarioIveAdvisoryRecordAssetsMigrate();
scenarioUpgradeDoesNotLaunderTamperedPrologBaseline();
scenarioDoctorFlagsMissingShippedDocsAndWrappers();

log("\n──────────────────────────────────────────────────────");
log(`  Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  log(`\n  Failures:`);
  for (const f of failures) log(`    - ${f}`);
}
log(failed === 0 ? "\n  ✅ ALL TESTS PASSED\n" : "\n  ❌ SOME TESTS FAILED\n");

process.exit(failed > 0 ? 1 : 0);
