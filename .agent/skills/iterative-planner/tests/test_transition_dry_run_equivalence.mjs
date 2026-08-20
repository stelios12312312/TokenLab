#!/usr/bin/env node
// Governed anti-recurrence proof for FI-PREFLIGHT-MIRROR-003.
// The invariant is that the only transition predictor is the actual transition
// evaluator with persistence disabled, across every registered gate.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { plannerSubprocessEnv } from "./helpers/env.mjs";
import { buildTransitionReceipt } from "../scripts/lib/gate_verdict.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const transitionScript = join(skillDir, "scripts", "transition.mjs");
const verifyGateScript = join(skillDir, "scripts", "verify_gate.mjs");
const ruleEngineScript = join(skillDir, "scripts", "rule_engine.mjs");
const gates = Object.keys(JSON.parse(readFileSync(join(skillDir, "config", "gates.json"), "utf-8")).gates || {});
const oldSuccessorName = "plan_2026-07-15_022c45123fb8a19c";
const oldSuccessorDir = join(repoRoot, "plans", oldSuccessorName);
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function runNode(args, cwd, extraEnv = {}) {
  try {
    const stdout = execFileSync(NODE, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
      env: plannerSubprocessEnv({
        PLANNER_SKIP_SELF_HEAL: "1",
        ...extraEnv,
      }),
    });
    return { ok: true, status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashTree(root) {
  const hash = createHash("sha256");
  function visit(path, relativePath = "") {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${relativePath}\0${readlinkSync(path)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`D\0${relativePath}\0`);
      for (const entry of readdirSync(path).sort()) {
        visit(join(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
      }
      return;
    }
    hash.update(`F\0${relativePath}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  visit(root);
  return hash.digest("hex");
}

function treeManifest(root) {
  const entries = new Map();
  function visit(path, relativePath = "") {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      entries.set(relativePath, `L:${readlinkSync(path)}`);
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        visit(join(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
      }
      return;
    }
    entries.set(relativePath, createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  visit(root);
  return entries;
}

function manifestDelta(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((path) => before.get(path) !== after.get(path))
    .join(", ");
}

function extractEquivalence(output) {
  return String(output || "").split("\n").find((line) => line.trimStart().startsWith("EQUIVALENCE: "))?.trim() || null;
}

function seedKnowledge(projectRoot) {
  const knowledgeDir = join(projectRoot, "plans", "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  for (const file of ["index.md", "mistakes.md", "patterns.md", "gotchas.md"]) {
    writeFileSync(join(knowledgeDir, file), `# ${file.replace(".md", "")}\n\nDry-run equivalence fixture knowledge.\n`);
  }
}

function seedStoryRegistry(projectRoot) {
  const reportDir = join(projectRoot, "reports", "user_story_audit");
  mkdirSync(reportDir, { recursive: true });
  writeJson(join(reportDir, "story_registry.json"), {
    version: 1,
    updated: "2026-07-16T00:00:00.000Z",
    stories: [{
      id: "US-073",
      title: "Use one transition truth path",
      priority: "LOW",
      status: "DRAFT",
      summary: "Fixture story for transition dry-run equivalence.",
      tags: ["planner", "transition"],
    }],
  });
}

function seedProject({ state = "EXPLORE", goal = "Internal planner maintenance dry-run equivalence control" } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "planner-dry-run-equivalence-"));
  symlinkSync(agentDir, join(projectRoot, ".agent"), "dir");
  writeJson(join(projectRoot, "audit.config.json"), {
    roles: ["core", "assumptions_challenger", "wiring_auditor", "config_integrity", "traceability"],
    fail_on: ["CRITICAL"],
  });
  seedKnowledge(projectRoot);
  seedStoryRegistry(projectRoot);

  const planName = "plan_2026-07-16_dryrunequivalence";
  const planDir = join(projectRoot, "plans", planName);
  mkdirSync(join(planDir, "artifacts"), { recursive: true });
  writeFileSync(join(projectRoot, "plans", ".current_plan"), `${planName}\n`);
  writeJson(join(planDir, "state.json"), {
    version: 1,
    state,
    iteration: 0,
    plan_dir: planName,
    goal,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z",
    current_step: null,
    fix_attempts: 0,
    workflow_id: null,
    transitions: [{
      from: "INIT",
      to: state,
      timestamp: "2026-07-16T00:00:00.000Z",
      gate_result: "SKIP",
      failure_codes: [],
      script_versions: {},
    }],
    change_manifest: [],
    script_versions: {},
    circuit_breakers: {},
    plan_shape: {
      primary: "planner-core",
      source: "fixture",
      requirements: { min_findings: 3, root_cause: true, adjacency: true, assumption_ledger: true },
    },
  });
  writeFileSync(join(planDir, "state.md"), `# State\n\n**Current**: ${state}\n`);
  writeJson(join(planDir, "findings_ledger.json"), {
    version: 1,
    fast_track: true,
    kb_digest_salt: null,
    findings: [1, 2, 3].map((index) => ({
      id: `F-00${index}`,
      title: `Equivalence finding ${index}`,
      summary: "The transition evaluator must own the complete gate truth and isolate persistence from dry-run evaluation.",
      details: [
        "The fixture uses a real explicit plan and the real transition CLI.",
        "JavaScript, persona, checklist, reachability, and Prolog checks stay on one path.",
        "A dry-run may report but cannot persist lifecycle or projection evidence.",
      ],
      story_refs: ["US-073"],
      file_refs: [".agent/skills/iterative-planner/scripts/transition.mjs"],
    })),
    root_cause: { summary: "Mirrored predictor CLIs previously omitted actual transition boundaries." },
    adjacency: { summary: "Transition, persona, facts, receipts, diagnostics, guidance, tests, and migration are adjacent." },
    assumptions: [{
      id: "A-001",
      statement: "One evaluator can serve actual and dry-run.",
      status: "VERIFIED",
      probe: "Run paired CLI controls.",
      observation: "The stable equivalence projection must match.",
    }],
    existing_capabilities: ["runTransition", "evaluateGateResults", "runSemanticChecks"],
    story_candidates: [{ disposition: "revise_existing", story_id: "US-073", reason: "Existing planner story." }],
  });
  writeFileSync(join(planDir, "findings.md"), `# Findings\n\n[FAST_TRACK]\n\n## Index\n- F-001 — one evaluator\n- F-002 — persistence isolation\n- F-003 — every-gate parity\n\n## F-001\n+The actual transition must be the only complete gate evaluator and prediction path.\n\n## F-002\n+Dry-run persistence isolation must include state, receipts, metrics, projections, persona files, markers, and pointers.\n\n## F-003\n+Every registered gate needs paired truth proof so later gates cannot drift silently.\n\n## Root Cause\n+Standalone subsets omitted actual transition boundaries.\n\n## Adjacency\n+Transition, persona, facts, receipts, guidance, tests, and migration.\n\n## Assumption Ledger\n+- VERIFIED: paired CLI execution exposes the canonical truth.\n`);
  writeJson(join(planDir, "intent_contract.json"), {
    version: 1,
    primary_user: "Planner maintainer",
    job_to_be_done: "Know exact transition truth without spending an attempt.",
    desired_outcomes: ["One evaluator", "No dry-run writes"],
    anti_goals: ["No mirrored predictor"],
    constraints: ["Preserve actual lifecycle"],
    deliverables: [],
  });
  writeJson(join(planDir, "focus_contract.json"), {
    version: 1,
    work_intent: "repair",
    zoom_level: "shared_planner_core",
    plan_shape: { primary: "planner-core", confidence: "high" },
    owned_scope: { files: [".agent/skills/iterative-planner/scripts/transition.mjs"], confidence: "high" },
    authoritative_packs: ["assumptions_challenger", "wiring_auditor", "config_integrity", "traceability"],
    advisory_packs: [],
    blockers: [],
  });
  writeFileSync(join(planDir, "plan.md"), `# Plan\n\n## Goal\n+Prove one transition evaluator.\n\n## Problem Statement\n+Mirrored preflights can disagree with actual transition truth.\n\n## Files To Modify\n+- .agent/skills/iterative-planner/scripts/transition.mjs\n+- .agent/skills/iterative-planner/tests/test_transition_dry_run_equivalence.mjs\n\n## Execution Steps\n+1. Run a non-writing dry-run.\n2. Run the actual transition.\n3. Compare stable truth.\n\n## Verification Obligation Synthesis\n+- Repo/system context: transition CLI\n+- Task shape: planner core\n+- Ontology signals: gate chain\n+- Persona signals: wiring and traceability\n+- System boundaries touched: evaluator and persistence\n+- Derived verification obligations: proof:dry_run proof:integration_smoke\n\n## Semantic Upkeep Contract\n+- Profile: planner_core_focus_contract\n+- Ontology action: update_relationships\n+- Story action: revise_existing\n+- Validation bundle: planner_core_contract\n+- Strictness mode: full\n+- Close blocker if skipped: Transition truth could drift.\n\n## Success Criteria\n+| ID | Criterion | Story linkage |\n+|---|---|---|\n+| SC-1 | Dry-run and actual truth match. | US-073 |\n+\n## Verification Strategy\n+| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |\n+|---|---|---|---|---|---|---|\n+| SC-1 | US-073 | transition CLI | proof:dry_run proof:integration_smoke | Run paired CLI controls. | Stable truth matches. | None |\n+\n+## Active Mistake Response\n+| Mistake | Guard | Planned handling | Planned evidence |\n+|---|---|---|---|\n+| M-001 | ripple_through | Keep evaluator and consumers aligned. | paired transition test |\n+| M-001 | migration_smoke | Preserve installed CLI behavior. | migration suite |\n+\n+## Fix Classification\n+Root-cause fix.\n\n+## Pre-Mortem\n+The likeliest recurrence is a newly registered gate bypassing the common evaluator.\n\n+## Knowledge Application\n+[KB_APPLIED:M-001] Shared planner truth needs ripple-complete proof.\n`);
  for (const [file, content] of Object.entries({
    "decisions.md": "# Decision Log\n\nUse one evaluator.\n",
    "progress.md": "# Progress\n\n## Completed\n- [x] Fixture authored\n\n## Remaining\n- [ ] Run gate\n",
    "verification.md": "# Verification Results\n\n## Criteria Verification\n| # | Criterion | Method | Command/Action | Result | Evidence |\n|---|---|---|---|---|---|\n| 1 | Dry-run parity | integration | paired transition | PENDING | fixture |\n",
    "red_team_notes.md": "## Vector 1: persistence\nAttack: dry-run writes state.\nImpact: telemetry corruption.\nMitigation: hash guard.\n\n## Vector 2: persona\nAttack: target context drifts.\nImpact: false green.\nMitigation: persona projection.\n\n## Vector 3: mirror\nAttack: docs route to a subset.\nImpact: wrong prediction.\nMitigation: authority census.\n",
    "reflection.md": "# Reflection\n\nPending.\n",
  })) {
    writeFileSync(join(planDir, file), content);
  }
  return { projectRoot, planName, planDir };
}

function pairedTransition({ projectRoot, planName, planDir, gate, env = {} }) {
  const before = hashTree(projectRoot);
  const beforeManifest = treeManifest(projectRoot);
  const dry = runNode([transitionScript, gate, "--dry-run", "--plan", planName], projectRoot, env);
  const afterDry = hashTree(projectRoot);
  const afterDryManifest = treeManifest(projectRoot);
  const actual = runNode([transitionScript, gate, "--plan", planName], projectRoot, env);
  const dryProjection = extractEquivalence(dry.stdout);
  const actualProjection = extractEquivalence(actual.stdout);
  return { before, afterDry, dry, actual, dryProjection, actualProjection, planDir, dryDelta: manifestDelta(beforeManifest, afterDryManifest) };
}

function scenarioEveryRegisteredGate() {
  for (const gate of gates) {
    const wrongState = gate === "explore-to-plan" ? "PLAN" : "EXPLORE";
    const fixture = seedProject({ state: wrongState, goal: `Internal planner maintenance ${gate} equivalence control` });
    try {
      const pair = pairedTransition({ ...fixture, gate, env: { _PLANNER_FAST_TRACK: "1" } });
      assert(pair.before === pair.afterDry, `${gate} dry-run is byte-non-writing`, pair.dryDelta || `${pair.before} != ${pair.afterDry}`);
      assert(pair.dryProjection !== null, `${gate} dry-run emits stable equivalence truth`);
      assert(pair.actualProjection !== null, `${gate} actual emits stable equivalence truth`);
      assert(pair.dryProjection === pair.actualProjection, `${gate} dry-run/actual stable truth is byte-equivalent`);
      assert(!pair.dry.ok && !pair.actual.ok, `${gate} wrong-source control blocks in both modes`);
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true });
    }
  }
}

function scenarioFreshPassAndSeededFail() {
  const passFixture = seedProject({ state: "EXPLORE", goal: "Internal planner maintenance fresh PASS equivalence control" });
  try {
    const pair = pairedTransition({ ...passFixture, gate: "explore-to-plan", env: { _PLANNER_FAST_TRACK: "1" } });
    assert(pair.before === pair.afterDry, "fresh PASS dry-run writes nothing", pair.dryDelta);
    assert(pair.dry.ok && pair.actual.ok, "fresh real plan dry-run PASS is immediately followed by actual PASS");
    assert(pair.dryProjection === pair.actualProjection, "fresh PASS pair has byte-equivalent stable truth");
    assert(JSON.parse(readFileSync(join(pair.planDir, "state.json"), "utf-8")).state === "PLAN", "fresh PASS actual advances canonical state");
  } finally {
    rmSync(passFixture.projectRoot, { recursive: true, force: true });
  }

  const failFixture = seedProject({ state: "PLAN", goal: "Internal planner maintenance seeded FAIL equivalence control" });
  try {
    const pair = pairedTransition({ ...failFixture, gate: "explore-to-plan", env: { _PLANNER_FAST_TRACK: "1" } });
    assert(pair.before === pair.afterDry, "seeded FAIL dry-run writes nothing", pair.dryDelta);
    assert(!pair.dry.ok && !pair.actual.ok, "seeded dry-run FAIL is immediately followed by actual FAIL");
    assert(pair.dryProjection === pair.actualProjection, "seeded FAIL pair has byte-equivalent stable truth");
    assert(pair.dryProjection?.includes("GATE-SRC-001"), "seeded FAIL pair preserves its exact hard-block code");
  } finally {
    rmSync(failFixture.projectRoot, { recursive: true, force: true });
  }
}

function scenarioSuccessorThreeControl() {
  assert(existsSync(oldSuccessorDir), "successor #3 immutable source plan exists");
  if (!existsSync(oldSuccessorDir)) return;
  const protectedPaths = [
    "state.json",
    "findings.md",
    "findings_ledger.json",
    "metrics.json",
    "artifacts/transition_receipts/latest_explore-to-plan.json",
  ];
  const originalBefore = Object.fromEntries(protectedPaths.map((path) => [path, hashTree(join(oldSuccessorDir, path))]));
  const projectRoot = mkdtempSync(join(tmpdir(), "planner-successor-three-control-"));
  try {
    symlinkSync(agentDir, join(projectRoot, ".agent"), "dir");
    cpSync(join(repoRoot, "audit.config.json"), join(projectRoot, "audit.config.json"));
    seedKnowledge(projectRoot);
    seedStoryRegistry(projectRoot);
    const cloneDir = join(projectRoot, "plans", oldSuccessorName);
    cpSync(oldSuccessorDir, cloneDir, { recursive: true });
    const pair = pairedTransition({ projectRoot, planName: oldSuccessorName, planDir: cloneDir, gate: "explore-to-plan" });
    assert(pair.before === pair.afterDry, "successor #3 cloned dry-run writes nothing", pair.dryDelta);
    assert(pair.dryProjection === pair.actualProjection, "successor #3 dry-run/actual stable truth is byte-equivalent");
    assert(
      JSON.parse(readFileSync(join(oldSuccessorDir, "state.json"), "utf-8")).state === "CLOSE"
        && pair.dryProjection?.includes("GATE-GAR-001"),
      "successor #3 control preserves its governed terminal disposition",
    );
    const originalAfter = Object.fromEntries(protectedPaths.map((path) => [path, hashTree(join(oldSuccessorDir, path))]));
    assert(JSON.stringify(originalBefore) === JSON.stringify(originalAfter), "successor #3 original state/findings/receipts/metrics remain immutable");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function scenarioMirrorDemotionAndAuthorityCensus() {
  const fixture = seedProject({ state: "PLAN", goal: "Internal planner maintenance verifier delegation control" });
  try {
    const direct = runNode([transitionScript, "explore-to-plan", "--dry-run", "--plan", fixture.planName], fixture.projectRoot);
    const delegated = runNode([verifyGateScript, "explore-to-plan", "--plan", fixture.planName], fixture.projectRoot);
    assert(extractEquivalence(direct.stdout) === extractEquivalence(delegated.stdout), "ordinary verify_gate CLI delegates to transition dry-run truth");

    const legacy = runNode([verifyGateScript, "reflect-to-close", "--plan", fixture.planName], fixture.projectRoot);
    assert(legacy.stdout.includes("DIAGNOSTIC ONLY"), "legacy reflect-to-close CLI is visibly diagnostic-only");

    const semantic = runNode([ruleEngineScript, "check-transition", "explore-to-plan", "--json"], fixture.projectRoot);
    const semanticPayload = (() => { try { return JSON.parse(semantic.stdout); } catch { return null; } })();
    assert(semanticPayload?.authority === "diagnostic_only", "check-transition JSON declares diagnostic-only authority", semantic.stdout || semantic.stderr);
    assert(semanticPayload?.preflight_command?.includes("transition.mjs explore-to-plan --dry-run"), "check-transition names the authoritative dry-run command", semantic.stdout || semantic.stderr);
  } finally {
    rmSync(fixture.projectRoot, { recursive: true, force: true });
  }

  const staleFixture = seedProject({ state: "CLOSE", goal: "Legacy diagnostic stale-gate control" });
  try {
    const statePath = join(staleFixture.planDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.transitions.push({
      from: "REFLECT",
      to: "CLOSE",
      timestamp: "2026-07-16T00:01:00.000Z",
      gate_result: "PASS",
      failure_codes: [],
      script_versions: {},
    });
    writeJson(statePath, state);
    const staleLegacy = runNode([verifyGateScript, "reflect-to-close", "--plan", staleFixture.planName], staleFixture.projectRoot);
    assert(staleLegacy.stdout.includes("already passed at"), "legacy diagnostic identifies an already-passed stale gate", staleLegacy.stdout || staleLegacy.stderr);
  } finally {
    rmSync(staleFixture.projectRoot, { recursive: true, force: true });
  }

  const runtimeAuthorityFiles = [
    "scripts/transition.mjs",
    "scripts/lib/gate_verdict.mjs",
    "scripts/lib/repair_packet.mjs",
    "mcp_server.mjs",
  ];
  for (const relativePath of runtimeAuthorityFiles) {
    const source = readFileSync(join(skillDir, relativePath), "utf-8");
    assert(!/runScript\("verify_gate\.mjs"|check-transition.*gate|verify_gate\.mjs \$\{gate/.test(source), `${relativePath} has no standalone transition-prediction route`);
  }
  const checklistFiles = readdirSync(join(skillDir, "checklists")).filter((name) => /\.ya?ml$/.test(name));
  for (const name of checklistFiles) {
    const source = readFileSync(join(skillDir, "checklists", name), "utf-8");
    assert(!/command:\s*["']?node .*verify_gate\.mjs/.test(source), `checklists/${name} cannot recursively invoke the retired verifier predictor`);
  }

  const authorityDocs = [
    join(repoRoot, "CLAUDE.md"),
    join(repoRoot, "GEMINI.md"),
    join(repoRoot, "AGENTS.md"),
    join(repoRoot, ".agent", "workflows", "safe-plan.md"),
    join(repoRoot, ".agent", "rules.md"),
    join(repoRoot, ".agent", "ADAPTATION-GUIDE.md"),
    join(repoRoot, ".agent", "skills", "red-team-remediation", "SKILL.md"),
    join(skillDir, "SKILL.md"),
    join(skillDir, "MIGRATION.md"),
    join(skillDir, "references", "CLAUDE.template.md"),
    join(skillDir, "references", "prompt-contracts.md"),
    join(skillDir, "references", "rule-engine-guide.md"),
    join(skillDir, "references", "scripts_registry.md"),
    join(repoRoot, "README.md"),
  ];
  for (const path of authorityDocs) {
    const lines = readFileSync(path, "utf-8").split("\n");
    const forbidden = lines.filter((line) => /node .*verify_gate\.mjs/.test(line) && !line.includes("--planning-only"));
    assert(forbidden.length === 0, `${path.replace(`${repoRoot}/`, "")} has no standalone verifier preflight command`, forbidden.join(" | "));
  }
  const ruleGuide = readFileSync(join(skillDir, "references", "rule-engine-guide.md"), "utf-8");
  assert(ruleGuide.includes("not a transition predictor"), "rule-engine guide states the semantic diagnostic boundary");
  const scriptsRegistry = readFileSync(join(skillDir, "references", "scripts_registry.md"), "utf-8");
  assert(scriptsRegistry.includes("transition.mjs --dry-run") && scriptsRegistry.includes("ordinary CLI use delegates"), "scripts registry states the unified preflight authority");
  const guidanceSource = readFileSync(join(skillDir, "scripts", "lib", "guidance_packet.mjs"), "utf-8");
  assert(guidanceSource.includes("preflight_command") && guidanceSource.includes("--dry-run"), "guidance packets publish the unified preflight command");
  const ruleEngineSource = readFileSync(join(skillDir, "scripts", "rule_engine.mjs"), "utf-8");
  assert(ruleEngineSource.includes('_PLANNER_GATE_TRANSITION === "1"') && ruleEngineSource.includes("transitionSmokeMode"), "nested invariant checklist evaluation cannot persist a pre-verdict proof trace");
}

function scenarioExplainedDivergenceProjection() {
  const explained = {
    name: "Prolog/JS divergence explained",
    status: "PASS",
    semantic_divergence: {
      status: "explained",
      direction: "prolog_only",
      explaining_check_ids: ["GATE-SEM-002", "GATE-SEM-002"],
      violation_names: ["high_priority_untested", "broken_evidence_chain"],
    },
  };
  const receipt = buildTransitionReceipt({
    planId: "plan_explained_divergence_projection",
    gate: "validate-to-close",
    sourceState: "VALIDATE",
    targetState: "CLOSE",
    results: [explained],
    generatedAt: "2026-07-22T00:00:00.000Z",
  });
  assert(receipt.status === "PASS" && receipt.hard_block_count === 0, "explained divergence does not change transition truth");
  assert(JSON.stringify(receipt.explained_divergences) === JSON.stringify(receipt.equivalence.explained_divergences), "explained divergence is identical in receipt and equivalence projections");
  assert(JSON.stringify(receipt.explained_divergences[0]?.explaining_check_ids) === JSON.stringify(["GATE-SEM-002"]), "explaining check IDs are deduplicated deterministically");

  const legacyShape = buildTransitionReceipt({
    planId: "plan_no_explained_divergence",
    gate: "validate-to-close",
    sourceState: "VALIDATE",
    targetState: "CLOSE",
    results: [],
    generatedAt: "2026-07-22T00:00:00.000Z",
  });
  assert(Array.isArray(legacyShape.explained_divergences) && legacyShape.explained_divergences.length === 0, "receipt absence normalizes explained divergences to an empty array");
  assert(Array.isArray(legacyShape.equivalence.explained_divergences) && legacyShape.equivalence.explained_divergences.length === 0, "equivalence absence normalizes explained divergences to an empty array");
}

console.log("\nTransition Dry-Run Equivalence Test\n");

const help = runNode([transitionScript, "--help"], repoRoot);
const dryRunAdvertised = help.ok && help.stdout.includes("--dry-run");
assert(dryRunAdvertised, "transition CLI advertises --dry-run");
const verifierHelp = runNode([verifyGateScript, "--help"], repoRoot);
assert(verifierHelp.ok && verifierHelp.stdout.includes("delegates to transition.mjs"), "verify_gate help declares delegated preflight authority");
scenarioExplainedDivergenceProjection();

// Test-before-fix fast failure: do not spend the full fixture matrix until the
// public contract exists. Once implemented, every structural control below runs.
if (dryRunAdvertised) {
  scenarioEveryRegisteredGate();
  scenarioFreshPassAndSeededFail();
  scenarioSuccessorThreeControl();
  scenarioMirrorDemotionAndAuthorityCensus();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
