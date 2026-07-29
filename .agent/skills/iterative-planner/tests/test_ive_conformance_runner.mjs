#!/usr/bin/env node
// test_ive_conformance_runner.mjs — IVE conformance runner contracts.

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_SUITES,
  listSuites,
  parseArgs,
  runConformance,
  selectSuites,
} from "./ive/run.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const runnerCli = join(testDir, "ive", "run.mjs");
const NODE = process.execPath;

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

function sameIds(selected, expected) {
  // The E4 census guard intentionally overlays every top-level test-file
  // change. Exact surface assertions below compare the domain suites while
  // dedicated assertions prove the cross-cutting guard itself is selected.
  const got = selected.map((suite) => suite.id).filter((id) => id !== "gate-or-delete-census").sort();
  const want = [...expected].sort();
  return got.length === want.length && got.every((id, index) => id === want[index]);
}

function fakeExecutor(failIds = new Set()) {
  return (suite) => ({
    id: suite.id,
    category: suite.category,
    label: suite.label,
    required: suite.required !== false,
    command: suite.display_command,
    status: failIds.has(suite.id) ? "FAIL" : "PASS",
    exit_code: failIds.has(suite.id) ? 17 : 0,
    timed_out: false,
    started_at: "2026-05-27T00:00:00.000Z",
    finished_at: "2026-05-27T00:00:00.001Z",
    stdout_excerpt: failIds.has(suite.id) ? "" : "ok",
    stderr_excerpt: failIds.has(suite.id) ? "planned failure" : "",
  });
}

console.log("\nIVE Conformance Runner Tests\n");

const categories = new Set(DEFAULT_SUITES.map((suite) => suite.category));
for (const category of ["loop_guard", "escalation", "structured_plan", "ontology", "doc_contract", "visualizer", "ripple", "migration", "release", "projection", "knowledge_pack", "cli_contract", "quant", "ci", "active_ontology", "ideation", "reflection", "advisory", "scenario"]) {
  assert(categories.has(category), `default suite includes ${category}`);
}

assert(DEFAULT_SUITES.every((suite) => suite.id && suite.category && suite.display_command && typeof suite.required === "boolean"), "default suites have stable required/advisory metadata");
assert(DEFAULT_SUITES.every((suite) => Array.isArray(suite.fixtures) && Array.isArray(suite.changed_file_patterns)), "default suites declare fixtures and changed-file patterns");
assert(DEFAULT_SUITES.every((suite) => ["functional_proof_test", "quality_score_evaluation"].includes(suite.test_class)), "default suites classify functional proof tests vs quality-score evaluations");
const coverageRatchetSuite = DEFAULT_SUITES.find((suite) => suite.id === "planner-core-coverage-ratchet");
assert(coverageRatchetSuite?.required === true, "planner-core coverage ratchet is required by default");
assert(coverageRatchetSuite?.display_command.includes("test_coverage_baseline.mjs"), "planner-core coverage ratchet directly executes its conformance test");
assert(coverageRatchetSuite?.fixtures.includes(".agent/skills/iterative-planner/config/coverage_baseline.json"), "planner-core coverage ratchet owns the committed baseline fixture");
assert(coverageRatchetSuite?.fixtures.includes(".agent/skills/iterative-planner/package-lock.json"), "planner-core coverage ratchet owns the locked c8 dependency fixture");
assert((coverageRatchetSuite?.changed_file_patterns || []).some((pattern) => pattern.test(".agent/skills/iterative-planner/scripts/transition.mjs")), "planner-core coverage ratchet selects a modified declared target");
const testGateCensusSuite = DEFAULT_SUITES.find((suite) => suite.id === "gate-or-delete-census");
assert(testGateCensusSuite?.required === true, "gate-or-delete census suite is required by default");
assert(testGateCensusSuite?.display_command.includes("test_gate_or_delete_census.mjs"), "gate-or-delete census suite directly executes its guard test");
assert(testGateCensusSuite?.fixtures.includes(".agent/skills/iterative-planner/config/test_gate_census.json"), "gate-or-delete census suite owns the committed census fixture");
assert((testGateCensusSuite?.changed_file_patterns || []).some((pattern) => pattern.test(".agent/skills/iterative-planner/tests/test_new_orphan.mjs")), "gate-or-delete census suite selects every new top-level test file");
assert(DEFAULT_SUITES.some((suite) => suite.display_command.includes("rule_engine.mjs check-invariants")), "default suites delegate ontology proof to rule_engine");
assert(DEFAULT_SUITES.some((suite) => suite.display_command.includes("ripple_check.mjs")), "default suites delegate ripple proof to ripple_check");
const researchMemorySuite = DEFAULT_SUITES.find((suite) => suite.id === "research-memory-packet-e2e");
assert(researchMemorySuite?.required === true, "research memory packet e2e suite is required by default");
assert(researchMemorySuite?.display_command.includes("test_research_memory_packet.mjs"), "research memory packet e2e suite drives the real packet test");
const transitionGateSuite = DEFAULT_SUITES.find((suite) => suite.id === "transition-gate-flows");
assert(transitionGateSuite?.required === true, "transition gate flow suite is required by default");
assert(transitionGateSuite?.display_command.includes("test_transition_gate_flows.mjs"), "transition gate flow suite drives the real lifecycle test");
assert(transitionGateSuite?.timeout_ms === 180000, "transition gate flow suite has CI-safe timeout override");
assert(transitionGateSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/gate_verdict.mjs"), "transition gate flow suite owns the authoritative receipt and verdict helper");
assert(transitionGateSuite?.fixtures.includes(".agent/skills/iterative-planner/config/failure-codes.json"), "transition gate flow suite owns failure classification policy");
const lifecycleJourneySuite = DEFAULT_SUITES.find((suite) => suite.id === "lifecycle-journey-proof");
assert(lifecycleJourneySuite?.required === true, "lifecycle journey proof suite is required by default");
assert(lifecycleJourneySuite?.display_command.includes("test_lifecycle_journey_proof.mjs"), "lifecycle journey proof suite drives the deterministic full-lifecycle test");
assert(lifecycleJourneySuite?.timeout_ms === 240000, "lifecycle journey proof suite has CI-safe timeout override");
assert(lifecycleJourneySuite?.phases.includes("full-lifecycle"), "lifecycle journey proof suite declares full-lifecycle phase");
assert(lifecycleJourneySuite?.phases.includes("j13") && lifecycleJourneySuite?.phases.includes("j14"), "lifecycle journey proof suite is tagged for J13/J14");
assert(lifecycleJourneySuite?.fixtures.includes(".agent/skills/iterative-planner/tests/test_lifecycle_journey_proof.mjs"), "lifecycle journey proof suite owns the journey test fixture");
assert(lifecycleJourneySuite?.surfaces.includes("transition_gates"), "lifecycle journey proof suite declares transition gate surface");
const committedLifecycleReplaySuite = DEFAULT_SUITES.find((suite) => suite.id === "committed-dogfood-lifecycle-replay");
assert(committedLifecycleReplaySuite?.required === true, "committed dogfood lifecycle replay is required by default");
assert(committedLifecycleReplaySuite?.display_command.includes("test_dogfood_lifecycle_replay.mjs"), "committed lifecycle replay drives the real three-plan corpus test");
assert(committedLifecycleReplaySuite?.timeout_ms === 300000, "committed lifecycle replay has a reliable clean-checkout timeout budget");
assert(committedLifecycleReplaySuite?.phases.includes("tier2") && committedLifecycleReplaySuite?.phases.includes("l2"), "committed lifecycle replay is tagged for Tier 2/L2");
assert(committedLifecycleReplaySuite?.fixtures.includes("plans/plan_2026-07-06_a562d891f2f965d0"), "committed lifecycle replay pins the planner-core fix plan");
assert(committedLifecycleReplaySuite?.fixtures.includes("plans/plan_2026-07-07_d07f86dd2adff3da"), "committed lifecycle replay pins the lifecycle test plan");
assert(committedLifecycleReplaySuite?.fixtures.includes("plans/plan_2026-07-09_09ac37d240a5fc72"), "committed lifecycle replay pins the Program Packet child plan");
assert(committedLifecycleReplaySuite?.surfaces.includes("committed_artifacts"), "committed lifecycle replay declares durable artifact coverage");
const autonomousDogfoodSuite = DEFAULT_SUITES.find((suite) => suite.id === "l3-autonomous-dogfood-harness");
assert(autonomousDogfoodSuite?.required === true, "L3 autonomous dogfood harness self-test is required by default");
assert(autonomousDogfoodSuite?.display_command.includes("test_autonomous_dogfood_run.mjs"), "L3 harness suite runs deterministic countersign self-tests without an LLM");
assert(autonomousDogfoodSuite?.phases.includes("tier3") && autonomousDogfoodSuite?.phases.includes("l3"), "L3 harness suite declares Tier 3/L3 phases");
assert(autonomousDogfoodSuite?.fixtures.includes(".github/workflows/l3-autonomous-dogfood.yml"), "L3 harness suite owns the separate real-run workflow contract");
const weeklyL3LaunchdSuite = DEFAULT_SUITES.find((suite) => suite.id === "weekly-l3-launchd-seat");
assert(weeklyL3LaunchdSuite?.required === true, "weekly L3 launchd seat contract is required by default");
assert(weeklyL3LaunchdSuite?.display_command.includes("test_weekly_l3_launchd.mjs"), "weekly L3 launchd suite directly executes its deterministic contract");
assert(weeklyL3LaunchdSuite?.phases.includes("weekly-l3") && weeklyL3LaunchdSuite?.phases.includes("launchd"), "weekly L3 launchd suite has local schedule phases without widening generic L3 selection");
assert(weeklyL3LaunchdSuite?.fixtures.includes("tools/ci/run-weekly-l3-autonomous-dogfood.mjs"), "weekly L3 launchd suite owns the seat resolver fixture");
assert(weeklyL3LaunchdSuite?.fixtures.includes("docs/ci/com.ive-studio.weekly-l3-dogfood.plist.template"), "weekly L3 launchd suite owns the inert plist fixture");
assert((weeklyL3LaunchdSuite?.changed_file_patterns || []).some((pattern) => pattern.test("tools/ci/run-weekly-l3-autonomous-dogfood.mjs")), "weekly L3 runner changes select the conformance suite");
assert((weeklyL3LaunchdSuite?.changed_file_patterns || []).some((pattern) => pattern.test("docs/ci/com.ive-studio.weekly-l3-dogfood.plist.template")), "weekly L3 plist changes select the conformance suite");
const autonomousFreshnessSuite = DEFAULT_SUITES.find((suite) => suite.id === "l3-autonomous-dogfood-receipt-freshness");
assert(autonomousFreshnessSuite?.required === false, "L3 real-run receipt freshness is advisory rather than a required merge gate");
assert(autonomousFreshnessSuite?.display_command.includes("autonomous_dogfood_run.mjs freshness --json"), "L3 freshness suite uses the public JSON CLI");
assert(typeof autonomousFreshnessSuite?.run === "function", "L3 freshness suite preserves PASS/WARN payload status instead of grading exit zero alone");
const deterministicFindingsSuite = DEFAULT_SUITES.find((suite) => suite.id === "deterministic-findings-schema");
assert(deterministicFindingsSuite?.required === true, "deterministic findings schema suite is required by default");
assert(deterministicFindingsSuite?.display_command.includes("test_deterministic_findings.mjs"), "deterministic findings suite drives the focused FI1 bridge test");
assert(deterministicFindingsSuite?.phases.includes("findings-to-intake") && deterministicFindingsSuite?.phases.includes("fi1"), "deterministic findings suite is tagged for FI1");
assert(deterministicFindingsSuite?.test_class === "functional_proof_test", "deterministic findings suite is classified as a functional proof test");
assert(deterministicFindingsSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/deterministic_findings.mjs"), "deterministic findings suite owns the bridge helper");
assert(deterministicFindingsSuite?.surfaces.includes("findings_bridge"), "deterministic findings suite declares the bridge surface");
const findingsTriageSuite = DEFAULT_SUITES.find((suite) => suite.id === "findings-triage-intake");
assert(findingsTriageSuite?.required === true, "findings triage intake suite is required by default");
assert(findingsTriageSuite?.display_command.includes("test_program_manager_findings_triage.mjs"), "findings triage suite drives the focused FI2 replay test");
assert(findingsTriageSuite?.phases.includes("findings-to-intake") && findingsTriageSuite?.phases.includes("fi2"), "findings triage suite is tagged for FI2");
assert(findingsTriageSuite?.test_class === "functional_proof_test", "findings triage suite is classified as a functional proof test");
assert(findingsTriageSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/program_manager.mjs"), "findings triage suite owns Program Manager CLI fixture");
assert(findingsTriageSuite?.fixtures.includes("reports/ive/scoreboard/scoreboard-2026-07-07T17-40-11-369Z/scoreboard.json"), "findings triage suite owns the committed replay scoreboard receipt");
assert(findingsTriageSuite?.surfaces.includes("findings_bridge") && findingsTriageSuite?.surfaces.includes("program_manager"), "findings triage suite declares bridge and Program Manager surfaces");
const transitionEnvSuite = DEFAULT_SUITES.find((suite) => suite.id === "transition-env-cleanup");
assert(transitionEnvSuite?.required === true, "transition env cleanup suite is required by default");
assert(transitionEnvSuite?.display_command.includes("test_transition_env_cleanup.mjs"), "transition env cleanup suite drives the focused env restoration test");
assert(transitionEnvSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/env_scope.mjs"), "transition env cleanup suite owns the env-scope helper fixture");
const reflectionVerdictSuite = DEFAULT_SUITES.find((suite) => suite.id === "reflection-verdict-routing");
assert(reflectionVerdictSuite?.required === true, "reflection verdict routing suite is required by default");
assert(reflectionVerdictSuite?.display_command.includes("test_reflection_verdict_routing.mjs"), "reflection verdict routing suite drives the focused close-signal test");
assert(reflectionVerdictSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/kb_signoff.mjs"), "reflection verdict routing suite owns the KB sign-off parser fixture");
assert(reflectionVerdictSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/plan_refresh.mjs"), "reflection verdict routing suite owns the close-signal refresh fixture");
const programManagerSuite = DEFAULT_SUITES.find((suite) => suite.id === "program-manager-tests");
assert(programManagerSuite?.test_class === "functional_proof_test", "program manager suite is classified as a functional proof test");
assert(programManagerSuite?.timeout_ms === 300000, "program manager suite has a reliable clean-checkout timeout budget");
const storyRegistryMergeGuardSuite = DEFAULT_SUITES.find((suite) => suite.id === "story-registry-merge-guard");
assert(storyRegistryMergeGuardSuite?.required === true, "story registry merge guard suite is required by default");
assert(storyRegistryMergeGuardSuite?.display_command.includes("test_story_registry_merge_guard.mjs"), "story registry merge guard suite drives the seeded collision test");
assert(storyRegistryMergeGuardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/story_registry.mjs"), "story registry merge guard suite owns the registry checker fixture");
assert(storyRegistryMergeGuardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/fact_loader.mjs"), "story registry merge guard suite owns the coverage fact-loader fixture");
assert(storyRegistryMergeGuardSuite?.fixtures.includes(".agent/skills/iterative-planner/prolog/stories.pl"), "story registry merge guard suite owns the Prolog coverage fixture");
assert(storyRegistryMergeGuardSuite?.surfaces.includes("story_registry"), "story registry merge guard suite declares the story registry surface");
const recipeContractSuite = DEFAULT_SUITES.find((suite) => suite.id === "recipe-contract");
assert(recipeContractSuite?.required === true, "recipe contract suite is required by default");
assert(recipeContractSuite?.display_command.includes("test_recipe_validate.mjs"), "recipe contract suite drives the real recipe validation test");
assert(recipeContractSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/recipe_utils.mjs"), "recipe contract suite owns the recipe utility fixture");
const recipePromotionSuite = DEFAULT_SUITES.find((suite) => suite.id === "recipe-promotion");
assert(recipePromotionSuite?.required === true, "recipe promotion suite is required by default");
assert(recipePromotionSuite?.display_command.includes("test_recipe_promotion.mjs"), "recipe promotion suite drives the E4-8 close-signal test");
assert(recipePromotionSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/recipe_promotion.mjs"), "recipe promotion suite owns the detector fixture");
assert(recipePromotionSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/close_signals.mjs"), "recipe promotion suite owns the explain surface fixture");
assert(recipePromotionSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/recipe_bootstrap.mjs"), "recipe promotion suite owns the bootstrap preview fixture");
const evidencePreflightSuite = DEFAULT_SUITES.find((suite) => suite.id === "evidence-preflight");
assert(evidencePreflightSuite?.required === true, "evidence preflight suite is required by default");
assert(evidencePreflightSuite?.display_command.includes("test_evidence_preflight.mjs"), "evidence preflight suite drives the focused hotspot preflight test");
assert(evidencePreflightSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/evidence_preflight.mjs"), "evidence preflight suite owns the CLI fixture");
assert(evidencePreflightSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/evidence_preflight.mjs"), "evidence preflight suite owns the library fixture");
assert(evidencePreflightSuite?.surfaces.includes("evidence_preflight"), "evidence preflight suite declares the evidence preflight surface");
const incidentContractSuite = DEFAULT_SUITES.find((suite) => suite.id === "incident-contract");
assert(incidentContractSuite?.required === true, "incident contract suite is required by default");
assert(incidentContractSuite?.display_command.includes("test_incident_contract.mjs"), "incident contract suite drives the focused incident contract test");
assert(incidentContractSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/incident_contract.mjs"), "incident contract suite owns the incident contract library fixture");
assert(incidentContractSuite?.fixtures.includes(".agent/skills/iterative-planner/config/incident_preflight_plugins.json"), "incident contract suite owns the incident preflight registry fixture");
assert(incidentContractSuite?.surfaces.includes("incident_contract"), "incident contract suite declares the incident contract surface");
const preplanningScaffoldingSuite = DEFAULT_SUITES.find((suite) => suite.id === "preplanning-scaffolding");
assert(preplanningScaffoldingSuite?.required === true, "preplanning scaffolding suite is required by default");
assert(preplanningScaffoldingSuite?.display_command.includes("test_preplanning_scaffolding.mjs"), "preplanning scaffolding suite drives the focused scaffold test");
assert(preplanningScaffoldingSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/preplanning_scaffolding.mjs"), "preplanning scaffolding suite owns the scaffold library fixture");
assert(preplanningScaffoldingSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/transition.mjs"), "preplanning scaffolding suite owns the transition integration fixture");
assert(preplanningScaffoldingSuite?.surfaces.includes("preplanning_scaffolding"), "preplanning scaffolding suite declares the scaffold surface");
const recipeResolverSuite = DEFAULT_SUITES.find((suite) => suite.id === "recipe-resolver");
assert(recipeResolverSuite?.required === true, "recipe resolver suite is required by default");
assert(recipeResolverSuite?.display_command.includes("test_recipe_resolver.mjs"), "recipe resolver suite drives the E6-7 ranked resolver test");
assert(recipeResolverSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/recipe_utils.mjs"), "recipe resolver suite owns the resolver utility fixture");
assert(recipeResolverSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/recipe_runner.mjs"), "recipe resolver suite owns the recipe runner preview fixture");
const reuseBeforeCreateSuite = DEFAULT_SUITES.find((suite) => suite.id === "reuse-before-create-gate");
assert(reuseBeforeCreateSuite?.required === true, "reuse-before-create suite is required by default");
assert(reuseBeforeCreateSuite?.display_command.includes("test_reuse_before_create_gate.mjs"), "reuse-before-create suite drives the focused duplicate capability test");
assert(reuseBeforeCreateSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/reuse_before_create_gate.mjs"), "reuse-before-create suite owns the gate library fixture");
assert(reuseBeforeCreateSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/reuse_before_create.mjs"), "reuse-before-create suite owns the CLI fixture");
assert(reuseBeforeCreateSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/verify_gate.mjs"), "reuse-before-create suite owns the plan gate integration fixture");
assert(reuseBeforeCreateSuite?.fixtures.includes(".agent/skills/iterative-planner/config/failure-codes.json"), "reuse-before-create suite owns the failure code catalog fixture");
const planArtifactRendererSuite = DEFAULT_SUITES.find((suite) => suite.id === "plan-artifact-renderer");
assert(planArtifactRendererSuite?.required === true, "plan artifact renderer suite is required by default");
assert(planArtifactRendererSuite?.display_command.includes("test_plan_artifact_renderer.mjs"), "plan artifact renderer suite drives focused renderer coverage");
assert(planArtifactRendererSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/plan_artifact_renderer.mjs"), "plan artifact renderer suite owns the renderer library fixture");
const localCiParitySuite = DEFAULT_SUITES.find((suite) => suite.id === "local-ci-parity");
assert(localCiParitySuite?.required === true, "local/CI parity suite is required by default");
assert(localCiParitySuite?.display_command.includes("test_local_ci_parity_helpers.mjs"), "local/CI parity suite drives the real helper guard");
const workspaceInventorySuite = DEFAULT_SUITES.find((suite) => suite.id === "workspace-artifact-inventory");
assert(workspaceInventorySuite?.required === true, "workspace artifact inventory suite is required by default");
assert(workspaceInventorySuite?.display_command.includes("test_workspace_artifact_inventory.mjs"), "workspace artifact inventory suite drives the focused read-only inventory test");
assert(workspaceInventorySuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/workspace_artifact_inventory.mjs"), "workspace artifact inventory suite owns the CLI fixture");
assert(workspaceInventorySuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/workspace_artifact_inventory.mjs"), "workspace artifact inventory suite owns the library fixture");
assert(workspaceInventorySuite?.fixtures.includes(".agent/skills/iterative-planner/config/.project_registry.json"), "workspace artifact inventory suite owns the project registry fixture");
assert(workspaceInventorySuite?.surfaces.includes("workspace_inventory"), "workspace artifact inventory suite declares the workspace inventory surface");
const knowledgeTriggerSuite = DEFAULT_SUITES.find((suite) => suite.id === "knowledge-triggers");
assert(knowledgeTriggerSuite?.required === true, "knowledge trigger suite is required by default");
assert(knowledgeTriggerSuite?.display_command.includes("test_knowledge_triggers.mjs"), "knowledge trigger suite drives the real trigger test");
assert(knowledgeTriggerSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/journal_memory.mjs"), "knowledge trigger suite owns the journal-memory helper fixture");
assert(knowledgeTriggerSuite?.fixtures.includes(".agent/skills/iterative-planner/tests/fixtures/real_episodes/mac_mini_quant_episodes.json"), "knowledge trigger suite owns the real episode retrieval fixture");
assert(knowledgeTriggerSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/ive_real_episode_corpus.mjs"), "knowledge trigger suite owns the real episode corpus helper fixture");
const agentJournalSuite = DEFAULT_SUITES.find((suite) => suite.id === "agent-journal-ontology");
assert(agentJournalSuite?.required === true, "agent journal ontology suite is required by default");
assert(agentJournalSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/agent_journal.mjs"), "agent journal suite owns the journal library fixture");
assert(agentJournalSuite?.fixtures.includes(".agent/skills/iterative-planner/prolog/invariants.pl"), "agent journal suite owns the Prolog invariant fixture");
const decisionAnchorSuite = DEFAULT_SUITES.find((suite) => suite.id === "decision-anchor-lifecycle");
assert(decisionAnchorSuite?.required === true, "decision anchor lifecycle suite is required by default");
assert(decisionAnchorSuite?.display_command.includes("test_decision_anchors.mjs"), "decision anchor lifecycle suite drives focused anchor coverage");
assert(decisionAnchorSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/decision_anchors.mjs"), "decision anchor lifecycle suite owns the helper fixture");
assert(decisionAnchorSuite?.fixtures.includes(".agent/skills/iterative-planner/checklists/validate-to-close.yaml"), "decision anchor lifecycle suite owns the close checklist fixture");
const repoStateStampSuite = DEFAULT_SUITES.find((suite) => suite.id === "repo-state-stamps");
assert(repoStateStampSuite?.required === true, "repo-state stamp suite is required by default");
assert(repoStateStampSuite?.display_command.includes("test_receipt_repo_state_stamp.mjs"), "repo-state stamp suite drives focused receipt provenance coverage");
assert(repoStateStampSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/repo_state_stamp.mjs"), "repo-state stamp suite owns the stamp helper fixture");
assert(repoStateStampSuite?.surfaces.includes("repo_state_stamp"), "repo-state stamp suite declares the stamp surface");
const abTaskBenchmarkSuite = DEFAULT_SUITES.find((suite) => suite.id === "ab-task-benchmark");
assert(abTaskBenchmarkSuite?.required === true, "A/B task benchmark suite is required by default");
assert(abTaskBenchmarkSuite?.display_command.includes("test_ab_task_benchmark.mjs"), "A/B task benchmark suite drives the real benchmark contract test");
assert(abTaskBenchmarkSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/ab_task_benchmark.mjs"), "A/B task benchmark suite owns the benchmark library fixture");
assert(abTaskBenchmarkSuite?.fixtures.includes(".agent/skills/iterative-planner/references/ab-task-benchmark.md"), "A/B task benchmark suite owns the benchmark reference doc fixture");
const ideationQualitySuite = DEFAULT_SUITES.find((suite) => suite.id === "ideation-quality-benchmark");
assert(ideationQualitySuite?.required === true, "ideation-quality suite is required by default");
assert(ideationQualitySuite?.display_command.includes("test_ideation_quality_benchmark.mjs"), "ideation-quality suite drives the real insight velocity benchmark");
assert(ideationQualitySuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/ideation_quality_benchmark.mjs"), "ideation-quality suite owns the benchmark CLI fixture");
assert(ideationQualitySuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/ideation_quality_benchmark.mjs"), "ideation-quality suite owns the benchmark library fixture");
assert(ideationQualitySuite?.fixtures.includes(".agent/skills/iterative-planner/tests/fixtures/ideation_quality/corpus.json"), "ideation-quality suite owns the fixture corpus");
assert(ideationQualitySuite?.fixtures.includes("docs/ive-redesign/18_ideation_quality_benchmark.md"), "ideation-quality suite owns the benchmark reference doc fixture");
const ttInsightsSuite = DEFAULT_SUITES.find((suite) => suite.id === "ttinsights-report");
assert(ttInsightsSuite?.required === true, "TTInsights suite is required by default");
assert(ttInsightsSuite?.display_command.includes("test_ttinsights_report.mjs"), "TTInsights suite drives the focused ontology-guided report test");
assert(ttInsightsSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/ttinsights_report.mjs"), "TTInsights suite owns the report CLI fixture");
assert(ttInsightsSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/ttinsights_report.mjs"), "TTInsights suite owns the report library fixture");
assert(ttInsightsSuite?.surfaces.includes("ttinsights"), "TTInsights suite declares the TTInsights surface");
const scoreboardSuite = DEFAULT_SUITES.find((suite) => suite.id === "scoreboard-cli");
assert(scoreboardSuite?.required === true, "scoreboard CLI suite is required by default");
assert(scoreboardSuite?.test_class === "quality_score_evaluation", "scoreboard CLI suite is classified as a quality-score evaluation");
assert(scoreboardSuite?.display_command.includes("test_scoreboard.mjs"), "scoreboard CLI suite drives the focused scoreboard test");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/scoreboard.mjs"), "scoreboard CLI suite owns the scoreboard CLI fixture");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/scoreboard.mjs"), "scoreboard CLI suite owns the scoreboard library fixture");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/plan_metrics.mjs"), "scoreboard CLI suite owns transition-friction metric collection");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/ideation_quality_benchmark.mjs"), "scoreboard CLI suite owns the ideation quality benchmark library fixture");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/ritual_replay.mjs"), "scoreboard CLI suite owns the ritual replay CLI fixture");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/ritual_replay.mjs"), "scoreboard CLI suite owns the ritual replay library fixture");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/reuse_before_create_gate.mjs"), "scoreboard CLI suite owns the reuse discipline gate fixture");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/references/convergence-metrics.md"), "scoreboard CLI suite owns the convergence metrics reference fixture");
assert(scoreboardSuite?.fixtures.includes(".agent/skills/iterative-planner/references/planning-rigor.md"), "scoreboard CLI suite owns the planning-rigor reference fixture");
assert(!scoreboardSuite?.display_command.includes("scripts/scoreboard.mjs"), "scoreboard suite does not recursively run the production scoreboard");
const seededDefectSuite = DEFAULT_SUITES.find((suite) => suite.id === "seeded-defect-harness");
assert(seededDefectSuite?.required === true, "seeded defect harness suite is required by default");
assert(seededDefectSuite?.display_command.includes("test_seeded_defect_harness.mjs"), "seeded defect harness suite drives the focused false-green test");
assert(seededDefectSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/seeded_defect_harness.mjs"), "seeded defect harness suite owns the harness fixture");
assert(seededDefectSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/reuse_before_create_gate.mjs"), "seeded defect harness suite owns the duplicate capability reuse gate fixture");
const ritualReplaySuite = DEFAULT_SUITES.find((suite) => suite.id === "ritual-replay");
assert(ritualReplaySuite?.required === true, "ritual replay suite is required by default");
assert(ritualReplaySuite?.test_class === "quality_score_evaluation", "ritual replay suite is classified as a quality-score evaluation");
assert(ritualReplaySuite?.display_command.includes("test_ritual_replay.mjs"), "ritual replay suite drives the focused real telemetry replay test");
assert(ritualReplaySuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/ritual_replay.mjs"), "ritual replay suite owns the ritual replay CLI fixture");
assert(ritualReplaySuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/ritual_replay.mjs"), "ritual replay suite owns the ritual replay library fixture");
assert(ritualReplaySuite?.fixtures.includes(".agent/skills/iterative-planner/tests/fixtures/real_telemetry"), "ritual replay suite owns the real telemetry corpus fixture");
const prologValueAuditSuite = DEFAULT_SUITES.find((suite) => suite.id === "prolog-value-audit");
assert(prologValueAuditSuite?.required === true, "Prolog value audit suite is required by default");
assert(prologValueAuditSuite?.display_command.includes("test_prolog_value_audit.mjs"), "Prolog value audit suite drives the focused E8-2 proof test");
assert(prologValueAuditSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/prolog_value_audit.mjs"), "Prolog value audit suite owns the CLI fixture");
assert(prologValueAuditSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/prolog_value_audit.mjs"), "Prolog value audit suite owns the library fixture");
assert(prologValueAuditSuite?.fixtures.includes("reports/ive/gate_survival/gate_survival.json"), "Prolog value audit suite owns the E2-4 gate-survival fixture");
const escalationProtocolSuite = DEFAULT_SUITES.find((suite) => suite.id === "escalation-protocol");
assert(escalationProtocolSuite?.required === true, "escalation protocol suite is required by default");
assert(escalationProtocolSuite?.display_command.includes("test_escalation_protocol.mjs"), "escalation protocol suite drives the focused E3-4 test");
assert(escalationProtocolSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/escalation_protocol.mjs"), "escalation protocol suite owns the protocol library fixture");
assert(escalationProtocolSuite?.fixtures.includes(".agent/skills/iterative-planner/tests/fixtures/escalation_protocol/transcripts.json"), "escalation protocol suite owns fixture transcripts");
assert(escalationProtocolSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/scoreboard.mjs"), "escalation protocol suite owns scoreboard telemetry fixture");
const presentationContractSuite = DEFAULT_SUITES.find((suite) => suite.id === "presentation-contract");
assert(presentationContractSuite?.required === true, "presentation contract suite is required by default");
assert(presentationContractSuite?.display_command.includes("test_presentation_contract.mjs"), "presentation contract suite drives the focused E3-5 test");
assert(presentationContractSuite?.fixtures.includes(".agent/skills/iterative-planner/config/presentation_contract.schema.json"), "presentation contract suite owns the schema fixture");
assert(presentationContractSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/presentation_contract.mjs"), "presentation contract suite owns the render helper fixture");
const verificationTruthSuite = DEFAULT_SUITES.find((suite) => suite.id === "verification-truth");
assert(verificationTruthSuite?.required === true, "verification truth suite is required by default");
assert(verificationTruthSuite?.display_command.includes("test_verification_truth.mjs"), "verification truth suite drives the structured close-result proof test");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/verification_truth.mjs"), "verification truth suite owns the canonical truth helper fixture");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/config/verification_status_vocabulary.json"), "verification truth suite owns the canonical status vocabulary fixture");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/verification_status_vocabulary.mjs"), "verification truth suite owns the status vocabulary loader fixture");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/config/proof_status_reader_census.json"), "verification truth suite owns the reviewed proof-status reader census fixture");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/config/mcp_tools.json"), "verification truth suite owns the MCP verification-writer schema fixture");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/proof_status_census.mjs"), "verification truth suite owns the proof-status structural guard fixture");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/fact_loader.mjs"), "verification truth suite owns the Prolog fact-loader fixture");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/ontology_serializer.mjs"), "verification truth suite owns the ontology serializer fixture");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/prolog/invariants.pl"), "verification truth suite owns mode-sensitive Prolog invariant matching");
assert(verificationTruthSuite?.fixtures.includes(".agent/skills/iterative-planner/prolog/verification_statuses.pl"), "verification truth suite owns the shared Prolog status rules fixture");
const adversarialEvidenceRerunSuite = DEFAULT_SUITES.find((suite) => suite.id === "adversarial-evidence-rerun");
assert(adversarialEvidenceRerunSuite?.required === true, "adversarial evidence rerun suite is required by default");
assert(adversarialEvidenceRerunSuite?.display_command.includes("test_adversarial_evidence_executor.mjs"), "adversarial evidence rerun suite drives the focused fresh-process contract test");
assert(adversarialEvidenceRerunSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/adversarial_evidence_executor.mjs"), "adversarial evidence rerun suite owns the standalone fresh-process worker");
assert(adversarialEvidenceRerunSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/plan_refresh.mjs"), "adversarial evidence rerun suite owns close-signal composition wiring");
assert(adversarialEvidenceRerunSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/ontology_serializer.mjs"), "adversarial evidence rerun suite owns semantic-reader parity");
assert(adversarialEvidenceRerunSuite?.fixtures.includes(".agent/skills/iterative-planner/config/state.schema.json"), "adversarial evidence rerun suite owns its persisted receipt schema");
assert((adversarialEvidenceRerunSuite?.changed_file_patterns || []).some((pattern) => pattern.test(".agent/skills/iterative-planner/scripts/adversarial_evidence_executor.mjs")), "standalone worker changes select the adversarial evidence rerun suite");
const gateSurvivalSuite = DEFAULT_SUITES.find((suite) => suite.id === "gate-survival-analysis");
assert(gateSurvivalSuite?.fixtures.includes(".agent/skills/iterative-planner/config/failure-codes.json"), "gate survival suite owns the full failure-code census input");
assert(gateSurvivalSuite?.fixtures.includes(".agent/skills/iterative-planner/checklists"), "gate survival suite owns the YAML checklist census input");
assert(gateSurvivalSuite?.fixtures.includes(".agent/skills/iterative-planner/prolog"), "gate survival suite owns the Prolog guard census input");
const claimBriefingSuite = DEFAULT_SUITES.find((suite) => suite.id === "claim-briefing-compiler");
assert(claimBriefingSuite?.required === true, "claim briefing compiler suite is required by default");
assert(claimBriefingSuite?.display_command.includes("test_claim_briefing_compiler.mjs"), "claim briefing compiler suite drives the focused E6-2 test");
assert(claimBriefingSuite?.fixtures.includes(".agent/skills/iterative-planner/config/claim_briefing.schema.json"), "claim briefing compiler suite owns the schema fixture");
assert(claimBriefingSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/claim_briefing_compiler.mjs"), "claim briefing compiler suite owns the compiler fixture");
assert(claimBriefingSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/persona_execute.mjs"), "claim briefing compiler suite owns the persona_execute integration fixture");
const rubricAdminSuite = DEFAULT_SUITES.find((suite) => suite.id === "rubric-admin-runner");
assert(rubricAdminSuite?.required === true, "rubric admin runner suite is required by default");
assert(rubricAdminSuite?.display_command.includes("test_rubric_admin_runner.mjs"), "rubric admin runner suite drives the focused E6-3 test");
assert(rubricAdminSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/rubric_admin_runner.mjs"), "rubric admin runner suite owns the runner library fixture");
assert(rubricAdminSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/rubric_admin_runner.mjs"), "rubric admin runner suite owns the CLI fixture");
assert(rubricAdminSuite?.fixtures.includes(".agent/skills/iterative-planner/tests/fixtures/rubric_admin/sycophancy_suite.json"), "rubric admin runner suite owns the sycophancy fixture");
const deliveryReceiptSuite = DEFAULT_SUITES.find((suite) => suite.id === "delivery-receipt-assembler");
assert(deliveryReceiptSuite?.required === true, "delivery receipt assembler suite is required by default");
assert(deliveryReceiptSuite?.display_command.includes("test_delivery_receipt_assembler.mjs"), "delivery receipt suite drives the focused E6-4 test");
assert(deliveryReceiptSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/delivery_receipt_assembler.mjs"), "delivery receipt suite owns the assembler library fixture");
assert(deliveryReceiptSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/delivery_receipt_assemble.mjs"), "delivery receipt suite owns the CLI fixture");
assert(deliveryReceiptSuite?.fixtures.includes(".agent/skills/iterative-planner/tests/fixtures/delivery_receipt/e6_4.dispute.json"), "delivery receipt suite owns the dispute fixture");
assert(deliveryReceiptSuite?.fixtures.includes("docs/autocoder-delivery-receipts.md"), "delivery receipt suite owns the receipt docs fixture");
const dispatcherSuite = DEFAULT_SUITES.find((suite) => suite.id === "dispatcher-v1");
assert(dispatcherSuite?.required === true, "dispatcher v1 suite is required by default");
assert(dispatcherSuite?.display_command.includes("test_dispatcher_v1.mjs"), "dispatcher v1 suite drives the focused E6-5 test");
assert(dispatcherSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/dispatcher_v1.mjs"), "dispatcher v1 suite owns the dispatcher library fixture");
assert(dispatcherSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/dispatcher_v1.mjs"), "dispatcher v1 suite owns the dispatcher CLI fixture");
assert(dispatcherSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/lib/recipe_utils.mjs"), "dispatcher v1 suite owns the recipe-first resolver fixture");
assert(dispatcherSuite?.fixtures.includes(".agent/skills/iterative-planner/scripts/recipe_runner.mjs"), "dispatcher v1 suite owns the recipe runner preview fixture");
assert(dispatcherSuite?.fixtures.includes(".agent/skills/iterative-planner/tests/test_dispatcher_v1.mjs"), "dispatcher v1 suite owns the focused test fixture");
assert(dispatcherSuite?.fixtures.includes("docs/autocoder-dispatcher-v1.md"), "dispatcher v1 suite owns the dispatcher docs fixture");
const visualizerContractSuite = DEFAULT_SUITES.find((suite) => suite.id === "visualizer-contract-bridge-guard");
assert(visualizerContractSuite?.fixtures.includes("apps/ive-visualizer/scripts/path-portability-check.mjs"), "visualizer contract suite owns path-portability fixture");
assert(visualizerContractSuite?.fixtures.includes("apps/ive-visualizer/scripts/live-payload-check.mjs"), "visualizer contract suite owns live-payload fixture");
assert(visualizerContractSuite?.fixtures.includes("apps/ive-visualizer/scripts/generate-live-payload.mjs"), "visualizer contract suite owns live-payload generator fixture");

let selected = selectSuites(DEFAULT_SUITES, ["ontology"]);
assert(sameIds(selected, ["ontology-cli-source-truth", "ontology-invariants", "prolog-value-audit", "trace-coverage-maturity"]), "--only category selects matching suites");

selected = selectSuites(DEFAULT_SUITES, ["ripple-check"]);
assert(selected.length === 1 && selected[0].category === "ripple", "--only id selects one suite");

selected = selectSuites(DEFAULT_SUITES, ["quant-results-validation"]);
assert(selected.length === 1 && selected[0].category === "quant", "--only quant-results-validation selects one quant suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.routing");
assert(selected.length === 1 && selected[0].id === "core-routing", "--phase core.routing selects routing suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.program-intake");
assert(selected.length === 1 && selected[0].id === "core-program-intake", "--phase core.program-intake selects program-intake suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.contracts");
assert(selected.length === 1 && selected[0].id === "contract-reliability", "--phase core.contracts selects contract reliability suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.user-verdict");
assert(selected.length === 1 && selected[0].id === "core-user-verdict", "--phase core.user-verdict selects user-verdict suite");

selected = selectSuites(DEFAULT_SUITES, [], "prolog-value-audit");
assert(selected.length === 1 && selected[0].id === "prolog-value-audit", "--phase prolog-value-audit selects Prolog value audit suite");

selected = selectSuites(DEFAULT_SUITES, [], "annotation-discipline");
assert(selected.length === 1 && selected[0].id === "annotation-discipline-gate", "--phase annotation-discipline selects annotation discipline gate suite");

selected = selectSuites(DEFAULT_SUITES, [], "red-team-depth");
assert(selected.length === 1 && selected[0].id === "red-team-depth-gate", "--phase red-team-depth selects ETR-008 red-team depth suite");

selected = selectSuites(DEFAULT_SUITES, [], "scenarios");
assert(
  selected.length === 2 &&
    selected.some((suite) => suite.id === "scenario-harness") &&
    selected.some((suite) => suite.id === "real-episode-replay-corpus"),
  "--phase scenarios selects scenario suite family",
);

selected = selectSuites(DEFAULT_SUITES, [], "e02");
assert(selected.length === 1 && selected[0].id === "quant-results-validation", "--phase e02 selects quant results validation suite");

selected = selectSuites(DEFAULT_SUITES, [], "e01");
assert(selected.length === 1 && selected[0].id === "quant-results-validation", "--phase e01 selects quant results validation suite");

selected = selectSuites(DEFAULT_SUITES, [], "research-memory-packet-e2e");
assert(selected.length === 1 && selected[0].id === "research-memory-packet-e2e", "--phase research-memory-packet-e2e selects research packet suite");

selected = selectSuites(DEFAULT_SUITES, [], "gate-lifecycle");
assert(sameIds(selected, ["transition-dry-run-equivalence", "transition-gate-flows"]), "--phase gate-lifecycle selects transition gate flow and dry-run equivalence suites");

selected = selectSuites(DEFAULT_SUITES, [], "full-lifecycle");
assert(selected.length === 1 && selected[0].id === "lifecycle-journey-proof", "--phase full-lifecycle selects lifecycle journey proof suite");

selected = selectSuites(DEFAULT_SUITES, [], "lifecycle-journey");
assert(selected.length === 1 && selected[0].id === "lifecycle-journey-proof", "--phase lifecycle-journey selects lifecycle journey proof suite");

selected = selectSuites(DEFAULT_SUITES, [], "committed-lifecycle-replay");
assert(selected.length === 1 && selected[0].id === "committed-dogfood-lifecycle-replay", "--phase committed-lifecycle-replay selects Tier 2 replay suite");

selected = selectSuites(DEFAULT_SUITES, [], "l2");
assert(selected.length === 1 && selected[0].id === "committed-dogfood-lifecycle-replay", "--phase l2 selects committed dogfood replay suite");

selected = selectSuites(DEFAULT_SUITES, [], "l3-harness");
assert(selected.length === 1 && selected[0].id === "l3-autonomous-dogfood-harness", "--phase l3-harness selects only deterministic L3 self-tests");

selected = selectSuites(DEFAULT_SUITES, [], "l3-freshness");
assert(selected.length === 1 && selected[0].id === "l3-autonomous-dogfood-receipt-freshness", "--phase l3-freshness selects only the receipt advisory");

selected = selectSuites(DEFAULT_SUITES, [], "l3");
assert(sameIds(selected, ["l3-autonomous-dogfood-harness", "l3-autonomous-dogfood-receipt-freshness"]), "--phase l3 selects deterministic harness and advisory freshness without invoking an LLM");

selected = selectSuites(DEFAULT_SUITES, [], "findings-to-intake");
assert(sameIds(selected, ["deterministic-findings-schema", "findings-triage-intake"]), "--phase findings-to-intake selects FI1 and FI2 findings suites");

selected = selectSuites(DEFAULT_SUITES, [], "fi1");
assert(selected.length === 1 && selected[0].id === "deterministic-findings-schema", "--phase fi1 selects deterministic findings suite");

selected = selectSuites(DEFAULT_SUITES, [], "fi2");
assert(selected.length === 1 && selected[0].id === "findings-triage-intake", "--phase fi2 selects findings triage intake suite");

selected = selectSuites(DEFAULT_SUITES, [], "e6-8");
assert(selected.length === 1 && selected[0].id === "reuse-before-create-gate", "--phase e6-8 selects reuse-before-create gate suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.reuse-before-create");
assert(selected.length === 1 && selected[0].id === "reuse-before-create-gate", "--phase core.reuse-before-create selects reuse-before-create gate suite");

selected = selectSuites(DEFAULT_SUITES, [], "e8-8");
assert(selected.length === 1 && selected[0].id === "reflection-verdict-routing", "--phase e8-8 selects reflection verdict routing suite");

selected = selectSuites(DEFAULT_SUITES, [], "knowledge-triggers");
assert(selected.length === 1 && selected[0].id === "knowledge-triggers", "--phase knowledge-triggers selects knowledge trigger suite");

selected = selectSuites(DEFAULT_SUITES, [], "e4-6");
assert(selected.length === 1 && selected[0].id === "knowledge-triggers", "--phase e4-6 selects knowledge trigger suite");

selected = selectSuites(DEFAULT_SUITES, [], "e4-5");
assert(selected.length === 1 && selected[0].id === "agent-journal-ontology", "--phase e4-5 selects agent journal ontology suite");

selected = selectSuites(DEFAULT_SUITES, [], "e4-7");
assert(selected.length === 1 && selected[0].id === "decision-anchor-lifecycle", "--phase e4-7 selects decision anchor lifecycle suite");

selected = selectSuites(DEFAULT_SUITES, [], "local-ci-parity");
assert(sameIds(selected, ["local-ci-parity", "transition-env-cleanup"]), "--phase local-ci-parity selects local/CI parity and transition env cleanup suites");

selected = selectSuites(DEFAULT_SUITES, [], "e2-6");
assert(selected.length === 1 && selected[0].id === "ab-task-benchmark", "--phase e2-6 selects A/B task benchmark suite");

selected = selectSuites(DEFAULT_SUITES, [], "ab-task-benchmark");
assert(selected.length === 1 && selected[0].id === "ab-task-benchmark", "--phase ab-task-benchmark selects A/B task benchmark suite");

selected = selectSuites(DEFAULT_SUITES, [], "scoreboard-sample");
assert(selected.length === 1 && selected[0].id === "ab-task-benchmark", "--phase scoreboard-sample selects A/B task benchmark suite");

selected = selectSuites(DEFAULT_SUITES, [], "e2-5");
assert(selected.length === 1 && selected[0].id === "scoreboard-cli", "--phase e2-5 selects scoreboard CLI suite");

selected = selectSuites(DEFAULT_SUITES, [], "e2-7");
assert(selected.length === 1 && selected[0].id === "scoreboard-cli", "--phase e2-7 selects scoreboard CLI suite");

selected = selectSuites(DEFAULT_SUITES, [], "e2-8");
assert(sameIds(selected, ["scoreboard-cli", "seeded-defect-harness"]), "--phase e2-8 selects duplicate-capability seeded and scoreboard suites");

selected = selectSuites(DEFAULT_SUITES, [], "reuse-discipline");
assert(sameIds(selected, ["scoreboard-cli", "seeded-defect-harness"]), "--phase reuse-discipline selects seeded and scoreboard reuse suites");

selected = selectSuites(DEFAULT_SUITES, [], "duplicate-capability");
assert(selected.length === 1 && selected[0].id === "seeded-defect-harness", "--phase duplicate-capability selects seeded defect harness suite");

selected = selectSuites(DEFAULT_SUITES, [], "scoreboard");
assert(sameIds(selected, ["pack-guard-benchmark", "scoreboard-cli"]), "--phase scoreboard selects scoreboard CLI and pack guard benchmark suites");

selected = selectSuites(DEFAULT_SUITES, [], "ideation-quality-benchmark");
assert(selected.length === 1 && selected[0].id === "ideation-quality-benchmark", "--phase ideation-quality-benchmark selects insight velocity suite");

selected = selectSuites(DEFAULT_SUITES, [], "insight-velocity");
assert(sameIds(selected, ["ideation-quality-benchmark", "insight-velocity-report", "ttinsights-report"]), "--phase insight-velocity selects ideation-quality and focused report suites");

selected = selectSuites(DEFAULT_SUITES, [], "e2-9");
assert(selected.length === 1 && selected[0].id === "ritual-replay", "--phase e2-9 selects ritual replay suite");

selected = selectSuites(DEFAULT_SUITES, [], "ritual-replay");
assert(selected.length === 1 && selected[0].id === "ritual-replay", "--phase ritual-replay selects ritual replay suite");

selected = selectSuites(DEFAULT_SUITES, [], "e3-4");
assert(selected.length === 1 && selected[0].id === "escalation-protocol", "--phase e3-4 selects escalation protocol suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.escalation-protocol");
assert(selected.length === 1 && selected[0].id === "escalation-protocol", "--phase core.escalation-protocol selects escalation protocol suite");

selected = selectSuites(DEFAULT_SUITES, [], "escalation-protocol");
assert(selected.length === 1 && selected[0].id === "escalation-protocol", "--phase escalation-protocol selects escalation protocol suite");

selected = selectSuites(DEFAULT_SUITES, [], "e3-5");
assert(selected.length === 1 && selected[0].id === "presentation-contract", "--phase e3-5 selects presentation contract suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.presentation-contract");
assert(selected.length === 1 && selected[0].id === "presentation-contract", "--phase core.presentation-contract selects presentation contract suite");

selected = selectSuites(DEFAULT_SUITES, [], "presentation-contract");
assert(selected.length === 1 && selected[0].id === "presentation-contract", "--phase presentation-contract selects presentation contract suite");
selected = selectSuites(DEFAULT_SUITES, [], "core.verification-truth");
assert(selected.length === 1 && selected[0].id === "verification-truth", "--phase core.verification-truth selects verification truth suite");
selected = selectSuites(DEFAULT_SUITES, [], "close-truth");
assert(selected.length === 1 && selected[0].id === "verification-truth", "--phase close-truth selects verification truth suite");

selected = selectSuites(DEFAULT_SUITES, [], "convergence-metrics");
assert(selected.length === 1 && selected[0].id === "scoreboard-cli", "--phase convergence-metrics selects scoreboard CLI suite");

selected = selectSuites(DEFAULT_SUITES, [], "test-switch");
assert(sameIds(selected, ["ideation-quality-benchmark", "insight-velocity-report", "ritual-replay", "scoreboard-cli"]), "--phase test-switch selects scoreboard, ritual replay, ideation-quality, and focused report suites");

selected = selectSuites(DEFAULT_SUITES, [], "e6-1");
assert(selected.length === 1 && selected[0].id === "role-provider-runtime", "--phase e6-1 selects role provider runtime suite");

selected = selectSuites(DEFAULT_SUITES, [], "role-provider-runtime");
assert(selected.length === 1 && selected[0].id === "role-provider-runtime", "--phase role-provider-runtime selects role provider runtime suite");

selected = selectSuites(DEFAULT_SUITES, [], "e6-2");
assert(selected.length === 1 && selected[0].id === "claim-briefing-compiler", "--phase e6-2 selects claim briefing compiler suite");

selected = selectSuites(DEFAULT_SUITES, [], "claim-briefing-compiler");
assert(selected.length === 1 && selected[0].id === "claim-briefing-compiler", "--phase claim-briefing-compiler selects claim briefing compiler suite");

selected = selectSuites(DEFAULT_SUITES, [], "e6-3");
assert(selected.length === 1 && selected[0].id === "rubric-admin-runner", "--phase e6-3 selects rubric admin runner suite");

selected = selectSuites(DEFAULT_SUITES, [], "rubric-admin-runner");
assert(selected.length === 1 && selected[0].id === "rubric-admin-runner", "--phase rubric-admin-runner selects rubric admin runner suite");

selected = selectSuites(DEFAULT_SUITES, [], "e6-4");
assert(selected.length === 1 && selected[0].id === "delivery-receipt-assembler", "--phase e6-4 selects delivery receipt assembler suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.delivery-receipt-assembler");
assert(selected.length === 1 && selected[0].id === "delivery-receipt-assembler", "--phase core.delivery-receipt-assembler selects delivery receipt assembler suite");

selected = selectSuites(DEFAULT_SUITES, [], "delivery-receipt-assembler");
assert(selected.length === 1 && selected[0].id === "delivery-receipt-assembler", "--phase delivery-receipt-assembler selects delivery receipt assembler suite");

selected = selectSuites(DEFAULT_SUITES, [], "e6-5");
assert(selected.length === 1 && selected[0].id === "dispatcher-v1", "--phase e6-5 selects dispatcher v1 suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.dispatcher-v1");
assert(selected.length === 1 && selected[0].id === "dispatcher-v1", "--phase core.dispatcher-v1 selects dispatcher v1 suite");

selected = selectSuites(DEFAULT_SUITES, [], "dispatcher-v1");
assert(selected.length === 1 && selected[0].id === "dispatcher-v1", "--phase dispatcher-v1 selects dispatcher v1 suite");

selected = selectSuites(DEFAULT_SUITES, [], "e6-7");
assert(sameIds(selected, ["dispatcher-v1", "recipe-resolver"]), "--phase e6-7 selects dispatcher and recipe resolver suites");

selected = selectSuites(DEFAULT_SUITES, [], "e3-6");
assert(selected.length === 1 && selected[0].id === "recipe-contract", "--phase e3-6 selects recipe contract suite");

selected = selectSuites(DEFAULT_SUITES, [], "e4-8");
assert(selected.length === 1 && selected[0].id === "recipe-promotion", "--phase e4-8 selects recipe promotion suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.recipe-promotion");
assert(selected.length === 1 && selected[0].id === "recipe-promotion", "--phase core.recipe-promotion selects recipe promotion suite");

selected = selectSuites(DEFAULT_SUITES, [], "recipe-promotion");
assert(selected.length === 1 && selected[0].id === "recipe-promotion", "--phase recipe-promotion selects recipe promotion suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.recipe-contract");
assert(selected.length === 1 && selected[0].id === "recipe-contract", "--phase core.recipe-contract selects recipe contract suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.recipe-resolver");
assert(selected.length === 1 && selected[0].id === "recipe-resolver", "--phase core.recipe-resolver selects recipe resolver suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.plan-artifact-renderer");
assert(selected.length === 1 && selected[0].id === "plan-artifact-renderer", "--phase core.plan-artifact-renderer selects plan artifact renderer suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.workspace-inventory");
assert(selected.length === 1 && selected[0].id === "workspace-artifact-inventory", "--phase core.workspace-inventory selects workspace artifact inventory suite");

const deletedProseDocSuite = DEFAULT_SUITES.find((suite) => suite.id === "autocoder-charter-doc-contract");
assert(!deletedProseDocSuite, "deleted autocoder charter prose doc suite is not registered");
assert(
  DEFAULT_SUITES.every((suite) => !suite.display_command.includes("test_planner_doc_contracts.mjs")),
  "no default suite invokes deleted test_planner_doc_contracts.mjs",
);
assert(
  DEFAULT_SUITES.every((suite) => !(suite.fixtures || []).includes(".agent/skills/iterative-planner/tests/test_planner_doc_contracts.mjs")),
  "no default suite lists deleted test_planner_doc_contracts.mjs as a fixture",
);
const docsContractsSuite = DEFAULT_SUITES.find((suite) => suite.id === "docs-contracts");
assert(docsContractsSuite?.display_command.includes("doc-contract-mvp"), "docs-contracts still includes the visualizer doc contract");
assert(docsContractsSuite?.display_command.includes("doc-contract-multi-ide"), "docs-contracts still includes the multi-IDE doc contract");
assert(!docsContractsSuite?.display_command.includes("autocoder-charter-doc-contract"), "docs-contracts no longer includes the deleted autocoder prose suite");
assert(!(docsContractsSuite?.fixtures || []).some((fixture) => fixture.includes("docs/autocoder-charter.md") || fixture.includes("docs/adr/ADR-")), "docs-contracts no longer owns autocoder charter or ADR prose fixtures");

selected = selectSuites(DEFAULT_SUITES, [], "e0-2");
assert(sameIds(selected, []), "--phase e0-2 no longer selects deleted autocoder charter prose suite");

selected = selectSuites(DEFAULT_SUITES, [], "autocoder-charter");
assert(sameIds(selected, []), "--phase autocoder-charter no longer selects deleted prose suite");

selected = selectSuites(DEFAULT_SUITES, [], "e0-3");
assert(sameIds(selected, []), "--phase e0-3 no longer selects deleted autocoder contract-language prose suite");

selected = selectSuites(DEFAULT_SUITES, [], "autocoder-contract-language");
assert(sameIds(selected, []), "--phase autocoder-contract-language no longer selects deleted prose suite");

selected = selectSuites(DEFAULT_SUITES, [], "e0-4");
assert(sameIds(selected, []), "--phase e0-4 no longer selects deleted autocoder pivot prose suite");

selected = selectSuites(DEFAULT_SUITES, [], "autocoder-pivot");
assert(sameIds(selected, []), "--phase autocoder-pivot no longer selects deleted prose suite");

selected = selectSuites(DEFAULT_SUITES, [], "e4-2");
assert(sameIds(selected, []), "--phase e4-2 no longer selects deleted autocoder memory-substrate prose suite");

selected = selectSuites(DEFAULT_SUITES, [], "autocoder-memory-substrate");
assert(sameIds(selected, []), "--phase autocoder-memory-substrate no longer selects deleted prose suite");

selected = selectSuites(DEFAULT_SUITES, [], "t06");
assert(
  selected.length === 4 &&
    selected.some((suite) => suite.id === "adversarial-evidence-rerun") &&
    selected.some((suite) => suite.id === "quant-results-validation") &&
    selected.some((suite) => suite.id === "structured-evidence-reflection-diff") &&
    selected.some((suite) => suite.id === "verification-runner"),
  "--phase t06 selects adversarial rerun, quant, reflection, and runner provenance suites",
);

selected = selectSuites(DEFAULT_SUITES, [], "0.5");
assert(selected.length === 1 && selected[0].id === "migration-bootstrap", "--phase 0.5 selects migration bootstrap suite");

selected = selectSuites(DEFAULT_SUITES, [], "6");
assert(selected.length === 1 && selected[0].id === "canonical-release-handoff", "--phase 6 selects canonical release handoff suite");

selected = selectSuites(DEFAULT_SUITES, [], "1,2");
assert(selected.length === 1 && selected[0].id === "projection-north-star", "--phase 1,2 selects projection and North Star suite");

selected = selectSuites(DEFAULT_SUITES, [], "2.5,2.6");
assert(selected.length === 1 && selected[0].id === "profile-knowledge-packs", "--phase 2.5,2.6 selects profile/knowledge-pack suite");

selected = selectSuites(DEFAULT_SUITES, [], "4.5");
assert(selected.length === 1 && selected[0].id === "active-ontology-temporal-provenance", "--phase 4.5 selects active ontology suite");

selected = selectSuites(DEFAULT_SUITES, [], "3");
assert(selected.length === 1 && selected[0].id === "ideation-anchors-operators-intent", "--phase 3 selects ideation anchors/operators/intent suite");

selected = selectSuites(DEFAULT_SUITES, [], "4,4.6");
assert(sameIds(selected, ["adversarial-idea-barrenness", "reflection-invariants", "structured-evidence-reflection-diff"]), "--phase 4,4.6 selects structured evidence/reflection suite");

selected = selectSuites(DEFAULT_SUITES, [], "4.7");
assert(selected.length === 1 && selected[0].id === "continuous-advisory-records", "--phase 4.7 selects continuous advisory suite");

selected = selectSuites(DEFAULT_SUITES, [], "2.6a,2.6b");
assert(selected.length === 3 && selected.some((suite) => suite.id === "profile-knowledge-packs") && selected.some((suite) => suite.id === "visualizer-contract-bridge-guard") && selected.some((suite) => suite.id === "visualizer-browser-proof"), "--phase 2.6a,2.6b selects sibling-pack and pack-aware visualizer suites");

selected = selectSuites(DEFAULT_SUITES, [], "5");
assert(selected.length === 2 && selected.some((suite) => suite.id === "visualizer-contract-bridge-guard") && selected.some((suite) => suite.id === "visualizer-browser-proof"), "--phase 5 selects visualizer contract and browser suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/knowledge_packs/product_management/pack.json"]);
assert(selected.length === 2 && selected.some((suite) => suite.id === "profile-knowledge-packs") && selected.some((suite) => suite.id === "ripple-check"), "--changed-files selects profile/knowledge-pack and ripple suites for sibling pack files");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/ive-redesign/08_visualizer_ui.md"]);
assert(selected.some((suite) => suite.id === "doc-contract-mvp"), "--changed-files selects the visualizer doc contract");
assert(selected.some((suite) => suite.id === "docs-contracts"), "--changed-files includes the aggregate docs contract");
assert(selected.some((suite) => suite.id === "visualizer-contract-bridge-guard") && selected.some((suite) => suite.id === "visualizer-browser-proof"), "--changed-files selects visualizer proof suites for visualizer docs");
assert(!selected.some((suite) => suite.id === "core-routing"), "--changed-files excludes unrelated core routing suite");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/ive-redesign/16_multi_ide_portability.md"]);
assert(selected.some((suite) => suite.id === "doc-contract-multi-ide"), "--changed-files selects the canonical multi-IDE doc contract");
assert(selected.some((suite) => suite.id === "docs-contracts"), "--changed-files includes aggregate docs contract for canonical multi-IDE docs");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/autocoder-charter.md"]);
assert(sameIds(selected, []), "--changed-files no longer selects deleted autocoder charter prose docs gate");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/adr/ADR-001-contract-language.md"]);
assert(sameIds(selected, []), "--changed-files no longer selects deleted autocoder contract-language prose docs gate");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/adr/ADR-002-pivot-reflect-outcome.md"]);
assert(sameIds(selected, []), "--changed-files no longer selects deleted autocoder pivot prose docs gate");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/adr/ADR-003-memory-substrate.md"]);
assert(sameIds(selected, []), "--changed-files no longer selects deleted autocoder memory-substrate prose docs gate");

// Exact sorted suite IDs (red-team F-004): inclusion-only assertions can't catch
// over-selection. Every lib change pulls the "capability-connectivity" no-shelf-ware
// guard plus "ripple-check"; pinning the full set forces a deliberate update on drift.
selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_migration_bootstrap.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "migration-bootstrap", "ripple-check"]), "--changed-files selects exactly migration bootstrap, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/presentation_contract.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "presentation-contract", "ripple-check"]), "--changed-files selects exactly presentation contract, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/config/presentation_contract.schema.json"]);
assert(sameIds(selected, ["presentation-contract", "ripple-check"]), "--changed-files selects exactly presentation contract and ripple for its schema");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_presentation_contract.mjs"]);
assert(sameIds(selected, ["presentation-contract", "ripple-check"]), "--changed-files selects exactly presentation contract and ripple for its test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/verification_truth.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "planner-core-coverage-ratchet", "ripple-check", "verification-truth"]), "--changed-files selects exactly coverage ratchet, verification truth, connectivity, and ripple for its helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_verification_truth.mjs"]);
assert(sameIds(selected, ["ripple-check", "verification-truth"]), "--changed-files selects exactly verification truth and ripple for its test");

for (const vocabularyFixture of [
  ".agent/skills/iterative-planner/config/verification_status_vocabulary.json",
  ".agent/skills/iterative-planner/config/proof_status_reader_census.json",
  ".agent/skills/iterative-planner/config/mcp_tools.json",
  ".agent/skills/iterative-planner/scripts/proof_status_census.mjs",
  ".agent/skills/iterative-planner/scripts/lib/verification_status_vocabulary.mjs",
  ".agent/skills/iterative-planner/prolog/verification_statuses.pl",
]) {
  selected = selectSuites(DEFAULT_SUITES, [], "all", [vocabularyFixture]);
  assert(selected.some((suite) => suite.id === "verification-truth"), `--changed-files selects verification truth for ${vocabularyFixture}`);
}

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/helpers/env.mjs"]);
assert(sameIds(selected, ["local-ci-parity", "ripple-check", "transition-env-cleanup"]), "--changed-files selects exactly local/CI parity, transition env cleanup, and ripple for the subprocess env helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_local_ci_parity_helpers.mjs"]);
assert(sameIds(selected, ["local-ci-parity", "ripple-check"]), "--changed-files selects exactly local/CI parity and ripple for the parity guard test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/annotation_discipline.mjs"]);
assert(sameIds(selected, ["annotation-discipline-gate", "capability-connectivity", "ripple-check"]), "--changed-files selects exactly annotation discipline, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/plan_utils.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "preplanning-scaffolding", "red-team-depth-gate", "ripple-check", "seeded-defect-harness", "transition-dry-run-equivalence"]), "--changed-files selects exactly preplanning, red-team depth, seeded-defect harness, dry-run equivalence, connectivity, and ripple suites for plan_utils");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/plan_artifact_renderer.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "plan-artifact-renderer", "ripple-check"]), "--changed-files selects exactly plan artifact renderer, connectivity, and ripple for renderer library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/plan_artifact_renderer.mjs"]);
assert(sameIds(selected, ["plan-artifact-renderer", "ripple-check"]), "--changed-files selects exactly plan artifact renderer and ripple for renderer CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/workspace_artifact_inventory.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "ripple-check", "workspace-artifact-inventory"]), "--changed-files selects exactly workspace inventory, connectivity, and ripple for inventory library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/workspace_artifact_inventory.mjs"]);
assert(sameIds(selected, ["ripple-check", "workspace-artifact-inventory"]), "--changed-files selects exactly workspace inventory and ripple for inventory CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_workspace_artifact_inventory.mjs"]);
assert(sameIds(selected, ["ripple-check", "workspace-artifact-inventory"]), "--changed-files selects exactly workspace inventory and ripple for inventory test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/references/scripts_registry.md"]);
assert(sameIds(selected, ["evidence-preflight", "ripple-check", "transition-dry-run-equivalence", "workspace-artifact-inventory"]), "--changed-files selects exactly evidence preflight, workspace inventory, dry-run equivalence, and ripple for script registry ownership docs");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/evidence_preflight.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "evidence-preflight", "incident-contract", "planner-core-coverage-ratchet", "ripple-check"]), "--changed-files selects exactly coverage ratchet, evidence preflight, incident contract, connectivity, and ripple for evidence preflight library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/evidence_preflight.mjs"]);
assert(sameIds(selected, ["evidence-preflight", "ripple-check"]), "--changed-files selects exactly evidence preflight and ripple for evidence preflight CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_evidence_preflight.mjs"]);
assert(sameIds(selected, ["evidence-preflight", "ripple-check"]), "--changed-files selects exactly evidence preflight and ripple for its focused test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_lifecycle_journey_proof.mjs"]);
assert(sameIds(selected, ["lifecycle-journey-proof", "ripple-check"]), "--changed-files selects exactly lifecycle journey proof and ripple for the journey test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_deterministic_findings.mjs"]);
assert(sameIds(selected, ["deterministic-findings-schema", "ripple-check"]), "--changed-files selects exactly deterministic findings and ripple for the FI1 test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_program_manager_findings_triage.mjs"]);
assert(sameIds(selected, ["findings-triage-intake", "ripple-check"]), "--changed-files selects exactly findings triage and ripple for the FI2 test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/deterministic_findings.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "deterministic-findings-schema", "findings-triage-intake", "ripple-check"]), "--changed-files selects deterministic findings, findings triage, connectivity, and ripple for the bridge helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/config/.project_registry.json"]);
assert(sameIds(selected, ["ripple-check", "workspace-artifact-inventory"]), "--changed-files selects exactly workspace inventory and ripple for registered project inventory config");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/verify_gate.mjs"]);
assert(sameIds(selected, ["adversarial-idea-barrenness", "annotation-discipline-gate", "autonomous-driver", "autonomous-verification-agents", "committed-dogfood-lifecycle-replay", "incident-contract", "lifecycle-journey-proof", "planner-core-coverage-ratchet", "quant-gate-hardening", "recipe-promotion", "red-team-depth-gate", "reflection-verdict-routing", "repo-state-stamps", "reuse-before-create-gate", "ripple-check", "transition-dry-run-equivalence", "transition-env-cleanup", "transition-gate-flows"]), "--changed-files selects exactly coverage ratchet, dry-run equivalence, live gate consumers, lifecycle journey proofs, quant gate hardening, incident contract, env cleanup, recipe promotion, transition flows, reuse gate, repo-state stamps, reflection close-signals, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_reflection_verdict_routing.mjs"]);
assert(sameIds(selected, ["reflection-verdict-routing", "ripple-check"]), "--changed-files selects exactly reflection verdict routing and ripple for its focused test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/transition.mjs"]);
assert(sameIds(selected, ["autonomous-driver", "lifecycle-journey-proof", "plan-artifact-renderer", "planner-core-coverage-ratchet", "preplanning-scaffolding", "ripple-check", "transition-dry-run-equivalence", "transition-env-cleanup", "transition-gate-flows"]), "--changed-files selects exactly coverage ratchet, preplanning, lifecycle journey proof, dry-run equivalence, transition env cleanup, transition gate flows, autonomous driver, plan artifact renderer, and ripple for transition.mjs");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/knowledge_triggers.mjs"]);
assert(sameIds(selected, ["knowledge-triggers", "ripple-check"]), "--changed-files selects exactly knowledge triggers and ripple for the Knowledge Trigger CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/journal_memory.mjs"]);
assert(sameIds(selected, ["agent-journal-ontology", "capability-connectivity", "knowledge-triggers", "ripple-check"]), "--changed-files selects journal-memory owner suites plus connectivity and ripple");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/decision_anchors.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "decision-anchor-lifecycle", "ripple-check"]), "--changed-files selects decision anchor lifecycle, connectivity, and ripple for decision anchor helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/decision_anchors.mjs"]);
assert(sameIds(selected, ["cli-determinism", "decision-anchor-lifecycle", "ripple-check"]), "--changed-files selects decision anchor lifecycle, CLI determinism, and ripple for decision anchor CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_release_handoff.mjs"]);
assert(sameIds(selected, ["canonical-release-handoff", "capability-connectivity", "cli-determinism", "ripple-check"]), "--changed-files selects exactly release handoff, connectivity, CLI determinism, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_projection.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "cli-determinism", "projection-north-star", "ripple-check"]), "--changed-files selects exactly projection/North Star, connectivity, CLI determinism, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/knowledge_packs/machine_learning/pack.json"]);
assert(sameIds(selected, ["profile-knowledge-packs", "ripple-check"]), "--changed-files selects exactly profile/knowledge-pack and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_active_ontology.mjs"]);
assert(sameIds(selected, ["active-ontology-temporal-provenance", "capability-connectivity", "ripple-check"]), "--changed-files selects exactly active ontology, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_ideation_operators.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "ideation-anchors-operators-intent", "ripple-check"]), "--changed-files selects exactly ideation operators, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_reflection_diff.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "ripple-check", "seeded-defect-harness", "structured-evidence-reflection-diff"]), "--changed-files selects exactly reflection diff, seeded-defect harness, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_advisory_records.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "continuous-advisory-records", "ripple-check"]), "--changed-files selects exactly advisory records, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/measured_gate.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "quant-results-validation", "ripple-check"]), "--changed-files selects exactly quant results validation, connectivity, and ripple for measured gate helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/quant_results_validation.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "quant-archetype-accomplices", "quant-betting-market", "quant-crypto-execution", "quant-leakage-artifact", "quant-results-validation", "quant-validation-retrofit", "research-memory-packet-e2e", "ripple-check"]), "--changed-files selects exactly the quant validation consumer family, research memory packet e2e, connectivity, and ripple for the quant parser");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/research_validity_binding.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "research-memory-packet-e2e", "ripple-check"]), "--changed-files selects exactly research packet e2e, connectivity, and ripple for the validity binding seam");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/claim_ledger.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "quant-results-validation", "ripple-check"]), "--changed-files selects exactly quant results validation, connectivity, and ripple for claim ledger helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/claim_briefing_compiler.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "claim-briefing-compiler", "ripple-check", "rubric-admin-runner"]), "--changed-files selects exactly claim briefing compiler, rubric admin runner, connectivity, and ripple for briefing compiler helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/rubric_admin_runner.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "cli-determinism", "ripple-check", "rubric-admin-runner"]), "--changed-files selects exactly rubric admin runner, CLI determinism, connectivity, and ripple for runner helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/rubric_admin_runner.mjs"]);
assert(sameIds(selected, ["cli-determinism", "ripple-check", "rubric-admin-runner"]), "--changed-files selects exactly rubric admin runner, CLI determinism, and ripple for runner CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_rubric_admin_runner.mjs"]);
assert(sameIds(selected, ["ripple-check", "rubric-admin-runner"]), "--changed-files selects exactly rubric admin runner and ripple for runner test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/fixtures/rubric_admin/sycophancy_suite.json"]);
assert(sameIds(selected, ["ripple-check", "rubric-admin-runner"]), "--changed-files selects exactly rubric admin runner and ripple for sycophancy fixture");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/delivery_receipt_assembler.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "cli-determinism", "delivery-receipt-assembler", "ripple-check"]), "--changed-files selects exactly delivery receipt, CLI determinism, connectivity, and ripple for assembler helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/delivery_receipt_assemble.mjs"]);
assert(sameIds(selected, ["cli-determinism", "delivery-receipt-assembler", "ripple-check"]), "--changed-files selects exactly delivery receipt, CLI determinism, and ripple for assembler CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_delivery_receipt_assembler.mjs"]);
assert(sameIds(selected, ["delivery-receipt-assembler", "ripple-check"]), "--changed-files selects exactly delivery receipt and ripple for assembler test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/fixtures/delivery_receipt/e6_4.dispute.json"]);
assert(sameIds(selected, ["delivery-receipt-assembler", "ripple-check"]), "--changed-files selects exactly delivery receipt and ripple for dispute fixture");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/dispatcher_v1.mjs"]);
assert(sameIds(selected, ["ab-task-benchmark", "capability-connectivity", "cli-determinism", "delivery-receipt-assembler", "dispatcher-v1", "ripple-check", "rubric-admin-runner"]), "--changed-files selects dispatcher v1, dependencies, connectivity, CLI determinism, and ripple for dispatcher helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/dispatcher_v1.mjs"]);
assert(sameIds(selected, ["cli-determinism", "dispatcher-v1", "ripple-check"]), "--changed-files selects dispatcher v1, CLI determinism, and ripple for dispatcher CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_dispatcher_v1.mjs"]);
assert(sameIds(selected, ["dispatcher-v1", "ripple-check"]), "--changed-files selects dispatcher v1 and ripple for dispatcher test");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/autocoder-dispatcher-v1.md"]);
assert(sameIds(selected, ["dispatcher-v1"]), "--changed-files selects dispatcher v1 for dispatcher docs");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/config/claim_briefing.schema.json"]);
assert(sameIds(selected, ["claim-briefing-compiler", "ripple-check"]), "--changed-files selects exactly claim briefing compiler and ripple for its schema");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_claim_briefing_compiler.mjs"]);
assert(sameIds(selected, ["claim-briefing-compiler", "ripple-check"]), "--changed-files selects exactly claim briefing compiler and ripple for its test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/persona_execute.mjs"]);
assert(sameIds(selected, ["claim-briefing-compiler", "ripple-check"]), "--changed-files selects exactly claim briefing compiler and ripple for persona_execute briefing mode");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/fixtures/work_orders/golden.claim-briefing.json"]);
assert(sameIds(selected, ["claim-briefing-compiler", "ripple-check", "work-order-contract"]), "--changed-files selects exactly claim briefing, work-order contract, and ripple for claim briefing fixture");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/contract_reliability.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "contract-reliability", "ripple-check"]), "--changed-files selects exactly contract reliability, connectivity, and ripple for contract reliability helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/run_record.mjs"]);
assert(
  sameIds(selected, ["capability-connectivity", "quant-results-validation", "ripple-check", "seeded-defect-harness", "structured-evidence-reflection-diff", "verification-runner"]),
  "--changed-files selects exactly all run-record consumers, connectivity, and ripple",
);

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ab_task_benchmark.mjs"]);
assert(sameIds(selected, ["ab-task-benchmark", "capability-connectivity", "cli-determinism", "ripple-check"]), "--changed-files selects exactly A/B benchmark, connectivity, CLI determinism, and ripple for benchmark library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/ab_task_benchmark.mjs"]);
assert(sameIds(selected, ["ab-task-benchmark", "cli-determinism", "ripple-check"]), "--changed-files selects exactly A/B benchmark, CLI determinism, and ripple for benchmark CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_ab_task_benchmark.mjs"]);
assert(sameIds(selected, ["ab-task-benchmark", "ripple-check"]), "--changed-files selects exactly A/B benchmark and ripple for benchmark test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ideation_quality_benchmark.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "cli-determinism", "ideation-quality-benchmark", "insight-velocity-report", "ripple-check", "scoreboard-cli"]), "--changed-files selects exactly insight velocity consumers, connectivity, CLI determinism, scoreboard, and ripple for ideation benchmark library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/ideation_quality_benchmark.mjs"]);
assert(sameIds(selected, ["cli-determinism", "ideation-quality-benchmark", "insight-velocity-report", "ripple-check"]), "--changed-files selects exactly insight velocity, CLI determinism, and ripple for ideation benchmark CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_ideation_quality_benchmark.mjs"]);
assert(sameIds(selected, ["ideation-quality-benchmark", "ripple-check"]), "--changed-files selects exactly ideation-quality and ripple for insight velocity test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/fixtures/ideation_quality/corpus.json"]);
assert(sameIds(selected, ["ideation-quality-benchmark", "ripple-check"]), "--changed-files selects exactly ideation-quality and ripple for insight velocity fixtures");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ttinsights_report.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "cli-determinism", "ripple-check", "ttinsights-report"]), "--changed-files selects TTInsights, connectivity, CLI determinism, and ripple for TTInsights library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/ttinsights_report.mjs"]);
assert(sameIds(selected, ["cli-determinism", "ripple-check", "ttinsights-report"]), "--changed-files selects TTInsights, CLI determinism, and ripple for TTInsights CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_ttinsights_report.mjs"]);
assert(sameIds(selected, ["ripple-check", "ttinsights-report"]), "--changed-files selects TTInsights and ripple for TTInsights test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/scoreboard.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "cli-determinism", "delivery-receipt-assembler", "deterministic-findings-schema", "escalation-protocol", "ideation-quality-benchmark", "pack-guard-benchmark", "ripple-check", "scoreboard-cli"]), "--changed-files selects exactly scoreboard, deterministic findings, pack guard benchmark, delivery receipt, escalation protocol, ideation quality, connectivity, CLI determinism, and ripple for scoreboard library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ritual_replay.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "cli-determinism", "deterministic-findings-schema", "ritual-replay", "ripple-check", "scoreboard-cli"]), "--changed-files selects exactly ritual replay consumers, deterministic findings, connectivity, CLI determinism, scoreboard, and ripple for ritual replay library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/ritual_replay.mjs"]);
assert(sameIds(selected, ["cli-determinism", "insight-velocity-report", "ritual-replay", "ripple-check", "scoreboard-cli"]), "--changed-files selects exactly ritual replay, focused report, scoreboard, CLI determinism, and ripple for ritual replay CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_ritual_replay.mjs"]);
assert(sameIds(selected, ["ritual-replay", "ripple-check"]), "--changed-files selects exactly ritual replay and ripple for ritual replay test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/escalation_protocol.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "delivery-receipt-assembler", "escalation-protocol", "ripple-check"]), "--changed-files selects exactly delivery receipt, escalation protocol, connectivity, and ripple for protocol library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_escalation_protocol.mjs"]);
assert(sameIds(selected, ["escalation-protocol", "ripple-check"]), "--changed-files selects exactly escalation protocol and ripple for protocol test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/fixtures/escalation_protocol/transcripts.json"]);
assert(sameIds(selected, ["escalation-protocol", "ripple-check"]), "--changed-files selects exactly escalation protocol and ripple for protocol fixtures");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/recipe_utils.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "dispatcher-v1", "recipe-contract", "recipe-resolver", "reuse-before-create-gate", "ripple-check"]), "--changed-files selects exactly recipe contract, resolver, dispatcher, reuse gate, connectivity, and ripple for recipe utility");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/recipe_promotion.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "recipe-promotion", "ripple-check"]), "--changed-files selects exactly recipe promotion, connectivity, and ripple for recipe promotion library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_recipe_promotion.mjs"]);
assert(sameIds(selected, ["recipe-promotion", "ripple-check"]), "--changed-files selects exactly recipe promotion and ripple for recipe promotion test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_reuse_before_create_gate.mjs"]);
assert(sameIds(selected, ["reuse-before-create-gate", "ripple-check"]), "--changed-files selects exactly reuse-before-create and ripple for reuse gate test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/reuse_before_create_gate.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "reuse-before-create-gate", "ripple-check", "scoreboard-cli", "seeded-defect-harness"]), "--changed-files selects exactly reuse-before-create, seeded, scoreboard, connectivity, and ripple for reuse gate library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/reuse_before_create.mjs"]);
assert(sameIds(selected, ["reuse-before-create-gate", "ripple-check"]), "--changed-files selects exactly reuse-before-create and ripple for reuse gate CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/seeded_defect_harness.mjs"]);
assert(sameIds(selected, ["ripple-check", "scoreboard-cli", "seeded-defect-harness"]), "--changed-files selects exactly seeded harness, scoreboard, and ripple for seeded harness source");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_recipe_resolver.mjs"]);
assert(sameIds(selected, ["recipe-resolver", "ripple-check"]), "--changed-files selects recipe resolver and ripple for resolver test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/recipe_runner.mjs"]);
assert(sameIds(selected, ["dispatcher-v1", "recipe-contract", "recipe-resolver", "ripple-check"]), "--changed-files selects recipe contract, resolver, dispatcher, and ripple for recipe runner");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/work_order_contract.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "recipe-contract", "ripple-check", "work-order-contract"]), "--changed-files selects exactly recipe/work-order contracts, connectivity, and ripple for work-order library");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/config/work_order.schema.json"]);
assert(sameIds(selected, ["recipe-contract", "ripple-check", "work-order-contract"]), "--changed-files selects exactly recipe/work-order contracts and ripple for work-order schema");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_recipe_validate.mjs"]);
assert(sameIds(selected, ["recipe-contract", "ripple-check"]), "--changed-files selects exactly recipe contract and ripple for recipe validation test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/recipe_validate.mjs"]);
assert(sameIds(selected, ["recipe-contract", "ripple-check"]), "--changed-files selects exactly recipe contract and ripple for recipe validation CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/role_provider_runtime.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "delivery-receipt-assembler", "fresh-context-reviewer", "llm-run-telemetry", "ripple-check", "role-provider-runtime", "rubric-admin-runner"]), "--changed-files selects exactly role provider runtime consumers, LLM telemetry, delivery receipt, rubric admin runner, connectivity, and ripple");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/role-provider-runtime.md"]);
assert(sameIds(selected, ["role-provider-runtime"]), "--changed-files selects exactly role provider runtime suite for role provider docs");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/scoreboard.mjs"]);
assert(sameIds(selected, ["cli-determinism", "ripple-check", "scoreboard-cli"]), "--changed-files selects exactly scoreboard, CLI determinism, and ripple for scoreboard CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/test_scoreboard.mjs"]);
assert(sameIds(selected, ["ripple-check", "scoreboard-cli"]), "--changed-files selects exactly scoreboard and ripple for scoreboard test");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/references/convergence-metrics.md"]);
assert(sameIds(selected, ["ripple-check", "scoreboard-cli"]), "--changed-files selects exactly scoreboard and ripple for convergence metrics reference doc");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/references/planning-rigor.md"]);
assert(sameIds(selected, ["ripple-check", "scoreboard-cli"]), "--changed-files selects exactly scoreboard and ripple for planning-rigor reference doc");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/references/ab-task-benchmark.md"]);
assert(sameIds(selected, ["ab-task-benchmark", "ripple-check"]), "--changed-files selects exactly A/B benchmark and ripple for benchmark reference doc");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/fixtures/real_episodes/mac_mini_quant_episodes.json"]);
assert(sameIds(selected, ["ab-task-benchmark", "knowledge-triggers", "real-episode-replay-corpus", "ripple-check"]), "--changed-files selects exactly A/B benchmark, knowledge triggers, real-episode replay, and ripple for real-episode corpus");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/verification_runner.mjs"]);
assert(sameIds(selected, ["ripple-check", "verification-runner"]), "--changed-files selects exactly verification runner and ripple");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["apps/ive-visualizer/src/App.jsx"]);
assert(sameIds(selected, ["autonomous-driver", "autonomous-verification-agents", "ci-enforcement-contracts", "northstar-ui-dogfood", "quant-archetype-accomplices", "quant-betting-market", "quant-crypto-execution", "quant-leakage-artifact", "tokenomics-arithmetic-gate", "visualizer-browser-proof", "visualizer-contract-bridge-guard"]), "--changed-files selects exactly the visualizer-app suite family for app source changes");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/ive/run.mjs"]);
assert(selected.length === DEFAULT_SUITES.length, "runner surface changes conservatively select every suite");

selected = selectSuites(DEFAULT_SUITES, ["quality_score_evaluation"]);
assert(selected.length > 0 && selected.every((suite) => suite.test_class === "quality_score_evaluation"), "--only can select quality-score evaluations by test_class");

let report = runConformance({ suites: DEFAULT_SUITES, executeCommand: fakeExecutor() });
assert(report.ok && report.status === "PASS", "all-passing fake execution reports PASS");
assert(report.command_count === DEFAULT_SUITES.length && report.passed_count === DEFAULT_SUITES.length, "all commands are counted");
assert(report.categories.includes("structured_plan") && report.categories.includes("doc_contract"), "report includes selected categories");
assert(report.test_classes.includes("functional_proof_test") && report.test_classes.includes("quality_score_evaluation"), "report includes functional and quality test classes");
assert(report.summary.functional_proof_tests > 0 && report.summary.quality_score_evaluations > 0, "report summary counts both test classes");
assert(report.scores?.quality_score?.current === 1, "report always includes quality_score");
assert(report.scores?.iv_score?.current === 1, "report includes IV score when IV suites are selected");
assert(report.scores?.ritual_score?.current === 1, "report includes ritual score when ritual suites are selected");
assert(report.summary.quality_score === report.scores.quality_score.current, "summary repeats quality_score");
assert(report.summary.iv_score === report.scores.iv_score.current, "summary repeats IV score");
assert(report.summary.ritual_score === report.scores.ritual_score.current, "summary repeats ritual score");

let observedTimeoutMs = null;
report = runConformance({
  suites: DEFAULT_SUITES,
  only: ["transition-gate-flows"],
  timeoutMs: 120000,
  executeCommand: (suite, options) => {
    observedTimeoutMs = options.timeoutMs;
    return fakeExecutor()(suite);
  },
});
assert(report.ok && observedTimeoutMs === 180000, "per-suite timeout override is passed to executor");

report = runConformance({
  suites: DEFAULT_SUITES,
  only: ["transition-gate-flows"],
  timeoutMs: 120000,
  minimumTimeoutMs: 900000,
  executeCommand: (suite, options) => {
    observedTimeoutMs = options.timeoutMs;
    return fakeExecutor()(suite);
  },
});
assert(report.ok && observedTimeoutMs === 900000, "explicit minimum timeout raises instrumentation budget without weakening the normal suite timeout");

report = runConformance({ suites: DEFAULT_SUITES, executeCommand: fakeExecutor(new Set(["docs-contracts"])) });
assert(!report.ok && report.status === "FAIL", "required command failure reports FAIL");
assert(report.failed_required_count === 1, "required failure count is recorded");
assert(report.issues?.[0]?.suite_id === "docs-contracts", "failure issue names the failed suite");

report = runConformance({ suites: DEFAULT_SUITES, only: ["research-memory-packet-e2e"], executeCommand: fakeExecutor(new Set(["research-memory-packet-e2e"])) });
assert(!report.ok && report.status === "FAIL", "required research memory packet suite failure reports FAIL");
assert(report.failed_required_count === 1, "research memory packet suite failure is gated as required");

report = runConformance({
  suites: DEFAULT_SUITES,
  executeCommand: (suite) => ({
    ...fakeExecutor()(suite),
    status: suite.id === "ontology-invariants" ? "TIMEOUT" : "PASS",
    exit_code: suite.id === "ontology-invariants" ? -1 : 0,
    timed_out: suite.id === "ontology-invariants",
  }),
});
assert(!report.ok && report.failed_required_count === 1, "required timeout reports FAIL");
assert(report.results.find((result) => result.id === "ontology-invariants")?.timed_out === true, "timeout metadata is preserved");

report = runConformance({ suites: DEFAULT_SUITES, only: ["missing-suite"], executeCommand: fakeExecutor() });
assert(!report.ok && report.issues?.[0]?.code === "no_matching_suite", "unknown suite filter fails closed");

report = runConformance({
  suites: DEFAULT_SUITES,
  changedFiles: ["outside/irrelevant.txt"],
  executeCommand: fakeExecutor(),
});
assert(report.ok && report.overall_status === "not_applicable", "changed files outside IVE surfaces are reasoned not_applicable");
assert(report.results?.[0]?.status_reason === "changed_files_outside_declared_ive_surfaces", "not_applicable includes a reason");

report = runConformance({
  suites: [{
    id: "missing-fixture",
    name: "missing-fixture",
    category: "structured_plan",
    label: "Missing fixture",
    required: true,
    command: ["node", "missing.mjs"],
    display_command: "node missing.mjs",
    phases: ["fixture"],
    fixtures: ["does/not/exist.mjs"],
    changed_file_patterns: [],
  }],
  phase: "fixture",
});
assert(!report.ok && report.status === "FAIL", "missing required fixture fails closed");
assert(report.results?.[0]?.manifest_status === "not_implemented_yet", "missing fixture maps to not_implemented_yet manifest status");
assert(report.issues?.[0]?.code === "required_fixture_missing", "missing fixture emits required_fixture_missing issue");

report = runConformance({
  suites: [{
    id: "reasonless-na",
    name: "reasonless-na",
    category: "structured_plan",
    label: "Reasonless not applicable",
    required: true,
    command: ["node", "noop.mjs"],
    display_command: "node noop.mjs",
    phases: ["fixture"],
    fixtures: [],
    changed_file_patterns: [],
  }],
  phase: "fixture",
  executeCommand: (suite) => ({
    id: suite.id,
    category: suite.category,
    label: suite.label,
    required: true,
    command: suite.display_command,
    status: "NOT_APPLICABLE",
    exit_code: 0,
    timed_out: false,
    started_at: "2026-05-27T00:00:00.000Z",
    finished_at: "2026-05-27T00:00:00.001Z",
    stdout_excerpt: "skipped",
    stderr_excerpt: "",
  }),
});
assert(!report.ok && report.issues?.[0]?.code === "not_applicable_without_reason", "reasonless not_applicable is a stale-green failure");

const tmp = mkdtempSync(join(tmpdir(), "ive-runner-"));
report = runConformance({
  suites: DEFAULT_SUITES,
  only: ["core-routing"],
  executeCommand: fakeExecutor(),
  writeManifest: true,
  runId: "unit-manifest",
  repoRoot: tmp,
  reportRoot: join(tmp, "reports", "ive", "test_runs"),
});
const manifestPath = join(tmp, "reports", "ive", "test_runs", "unit-manifest", "manifest.json");
assert(report.ok && existsSync(manifestPath), "writeManifest writes manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
assert(manifest.overall_status === "pass" && manifest.suites?.[0]?.status === "pass", "manifest uses lower-case pass status");
assert(manifest.suites?.[0]?.test_class === "functional_proof_test", "manifest records suite test_class");
assert(existsSync(join(tmp, "reports", "ive", "test_runs", "unit-manifest", "logs", "core-routing.stdout.log")), "writeManifest preserves stdout log");

const list = listSuites(DEFAULT_SUITES);
assert(list.ok && list.status === "LIST" && list.suite_count === DEFAULT_SUITES.length, "listSuites emits machine-readable suite inventory");
assert(Array.isArray(list.suites?.[0]?.fixtures), "listSuites includes fixture metadata");
assert(["functional_proof_test", "quality_score_evaluation"].includes(list.suites?.[0]?.test_class), "listSuites includes test_class metadata");

const parsedArgs = parseArgs(["--json", "--only", "ontology", "--only=ripple", "--changed-files", "a.js,b.js", "--run-id=stable", "--timeout-ms=5000", "--minimum-timeout-ms=900000", "--no-manifest"]);
assert(
  parsedArgs.json
    && parsedArgs.only.length === 2
    && parsedArgs.timeoutMs === 5000
    && parsedArgs.minimumTimeoutMs === 900000,
  "parseArgs handles json, repeated only filters, and timeout budgets",
);
assert(parsedArgs.changedFiles.length === 1 && parsedArgs.runId === "stable" && parsedArgs.writeManifest === false, "parseArgs handles changed-files, run-id, and no-manifest");

const cliList = execFileSync(NODE, [runnerCli, "--list", "--json"], {
  cwd: repoRoot,
  encoding: "utf-8",
});
const cliJson = JSON.parse(cliList);
assert(cliJson.status === "LIST" && cliJson.suites?.length === DEFAULT_SUITES.length, "CLI list mode emits parseable JSON");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
