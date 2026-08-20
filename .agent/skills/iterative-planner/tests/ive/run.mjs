#!/usr/bin/env node
// tests/ive/run.mjs - IVE conformance runner.
//
// The runner delegates to existing deterministic scripts/tests and aggregates
// their results. It also exposes a small selection API so Program Packet rows
// can run focused phases such as core.packet-contract without inventing a
// second orchestration path.

import { execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "../../scripts/lib/emit_json.mjs";
import { isDirectInvocation } from "../../scripts/lib/script_entrypoint.mjs";
import { buildRepoStateStamp } from "../../scripts/lib/repo_state_stamp.mjs";
import { findingsFromIveReport } from "../../scripts/lib/deterministic_findings.mjs";
import { plannerSubprocessEnv } from "../helpers/env.mjs";
import { COVERAGE_TARGETS } from "../../scripts/coverage_baseline.mjs";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const TESTS_ROOT = dirname(TEST_DIR);
const SKILL_DIR = dirname(TESTS_ROOT);
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");

const SCHEMA_VERSION = 1;
const STDOUT_EXCERPT_BYTES = 500;
const DIRECT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
const NODE = process.execPath;
const REPORT_ROOT = join(REPO_ROOT, "reports", "ive", "test_runs");
const RELEASE_PROFILES_PATH = join(SKILL_DIR, "config", "ive_release_profiles.json");
const VISUALIZER_SKIP_EXIT_CODE = 78;
const HOST_PROOF_SKIP_EXIT_CODE = 78;
const HOST_PROOF_SKIP_PREFIX = "IVE_HOST_PROOF_SKIP:";

const DIRECT_SUITE_WAVE_IDS = Object.freeze([
  Object.freeze(["transition-gate-flows", "cli-determinism"]),
  Object.freeze(["transition-dry-run-equivalence", "lifecycle-reconciler"]),
  Object.freeze(["lifecycle-journey-proof", "ive-conformance-runner-meta"]),
  Object.freeze(["committed-dogfood-lifecycle-replay", "visualizer-contract-bridge-guard"]),
  Object.freeze(["l3-autonomous-dogfood-harness", "reflection-invariants"]),
  Object.freeze(["transition-env-cleanup", "gate-idempotence"]),
  Object.freeze(["reflection-verdict-routing", "program-packet-design-to-ready"]),
  Object.freeze(["program-manager-tests", "migration-bootstrap"]),
  Object.freeze(["advisor-task-intake-routing", "adversarial-idea-barrenness"]),
  Object.freeze(["verification-truth", "planner-shell-wrapper-hooks"]),
]);

const FAILING_STATUSES = new Set(["FAIL", "TIMEOUT", "NOT_IMPLEMENTED_YET"]);
const RESULT_STATUSES = new Set([
  "PASS",
  "WARN",
  "SKIPPED",
  "NOT_APPLICABLE",
  "FAIL",
  "TIMEOUT",
  "NOT_IMPLEMENTED_YET",
]);
const TEST_CLASS_FUNCTIONAL_PROOF = "functional_proof_test";
const TEST_CLASS_QUALITY_SCORE = "quality_score_evaluation";
const TEST_CLASS_LABELS = Object.freeze({
  [TEST_CLASS_FUNCTIONAL_PROOF]: "Functional proof test",
  [TEST_CLASS_QUALITY_SCORE]: "Quality-score evaluation",
});
const QUALITY_SCORE_TOKENS = new Set([
  "ab-task-benchmark",
  "autocoder-metrics",
  "autocoder_v2",
  "behavior-report",
  "behavior_report",
  "convergence-metrics",
  "false-green",
  "gate-survival",
  "ideation",
  "ideation_quality",
  "insight-velocity",
  "insight_velocity",
  "north-star",
  "projection",
  "quality",
  "real-telemetry",
  "real_telemetry",
  "ritual-replay",
  "ritual_replay",
  "scoreboard",
]);

function displayCommand(command) {
  return command.map((arg) => {
    let rendered = String(arg);
    if (isAbsolute(rendered)) {
      const repoRelative = relative(REPO_ROOT, rendered);
      if (repoRelative && !repoRelative.startsWith("..") && !isAbsolute(repoRelative)) {
        rendered = repoRelative.split(sep).join("/");
      }
    }
    return /[\s"'\\]/.test(rendered) ? JSON.stringify(rendered) : rendered;
  }).join(" ");
}

function normalizeTestClass(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized === TEST_CLASS_QUALITY_SCORE ? TEST_CLASS_QUALITY_SCORE : TEST_CLASS_FUNCTIONAL_PROOF;
}

function inferTestClass({ id, category, phases = [], surfaces = [] }) {
  const tokens = [
    id,
    category,
    ...phases,
    ...surfaces,
  ].map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
  return tokens.some((token) => QUALITY_SCORE_TOKENS.has(token))
    ? TEST_CLASS_QUALITY_SCORE
    : TEST_CLASS_FUNCTIONAL_PROOF;
}

function suite({
  id,
  category,
  label,
  command,
  phases = ["default"],
  surfaces = [category],
  fixtures = [],
  changedFilePatterns = [],
  timeoutMs = null,
  testClass = null,
  required = true,
  acceptsPlanTarget = false,
  run,
}) {
  const resolvedSurfaces = surfaces || [category];
  const resolvedTestClass = normalizeTestClass(testClass || inferTestClass({
    id,
    category,
    phases,
    surfaces: resolvedSurfaces,
  }));
  return {
    id,
    name: id,
    category,
    test_class: resolvedTestClass,
    test_class_label: TEST_CLASS_LABELS[resolvedTestClass],
    label,
    command,
    display_command: displayCommand(command),
    required,
    phases,
    surfaces: resolvedSurfaces,
    fixtures,
    changed_file_patterns: changedFilePatterns,
    timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
    accepts_plan_target: acceptsPlanTarget === true,
    run,
  };
}

function skillRel(path) {
  return `.agent/skills/iterative-planner/${path}`;
}

function docsIvePattern(fileName) {
  return new RegExp(`^docs/ive-redesign/${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function exactRepoPathPattern(repoPath) {
  return new RegExp(`^${repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function visualizerAppRoot(repoRoot = REPO_ROOT) {
  return join(repoRoot, "apps", "ive-visualizer");
}

function visualizerPlaywrightBin(repoRoot = REPO_ROOT) {
  return join(visualizerAppRoot(repoRoot), "node_modules", ".bin", process.platform === "win32" ? "playwright.cmd" : "playwright");
}

const DEFAULT_SUITES = [
  suite({
    id: "planner-core-coverage-ratchet",
    category: "ci",
    label: "K2 modified planner-core scripts do not regress below measured coverage baselines",
    command: ["node", join(TESTS_ROOT, "test_coverage_baseline.mjs")],
    phases: ["k2", "coverage"],
    surfaces: ["ci", "coverage", "changed_file_selection", "planner_core"],
    fixtures: [
      skillRel("tests/test_coverage_baseline.mjs"),
      skillRel("scripts/coverage_baseline.mjs"),
      skillRel("config/coverage_baseline.json"),
      skillRel("package.json"),
      skillRel("package-lock.json"),
      skillRel("tests/ive/run.mjs"),
      ...COVERAGE_TARGETS,
    ],
    changedFilePatterns: [
      ...COVERAGE_TARGETS.map(exactRepoPathPattern),
      /^\.agent\/skills\/iterative-planner\/tests\/test_coverage_baseline\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/coverage_baseline\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/coverage_baseline\.json$/,
      /^\.agent\/skills\/iterative-planner\/package(-lock)?\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
    ],
  }),
  suite({
    id: "gate-or-delete-census",
    category: "ci",
    label: "E4 no-new-ungated-tests census guard",
    command: ["node", join(TESTS_ROOT, "test_gate_or_delete_census.mjs")],
    phases: ["e4", "test-governance", "planner-core"],
    surfaces: ["ci", "test_governance", "changed_file_selection", "planner_core"],
    fixtures: [
      skillRel("tests/test_gate_or_delete_census.mjs"),
      skillRel("scripts/test_gate_census.mjs"),
      skillRel("config/test_gate_census.json"),
      skillRel("tests/ive/run.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_.*\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/test_gate_census\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/test_gate_census\.json$/,
    ],
  }),
  suite({
    id: "owned-file-replacement",
    category: "structured_plan",
    label: "Ownership-returning no-overwrite planner file replacement and caller recovery",
    command: ["node", join(TESTS_ROOT, "test_owned_file_replace.mjs")],
    phases: ["state-machine", "planner-core", "fault-injection", "recovery"],
    surfaces: ["state_machine", "filesystem", "persistence", "migration", "planner_core"],
    fixtures: [
      skillRel("tests/test_owned_file_replace.mjs"),
      skillRel("scripts/lib/owned_file_replace.mjs"),
      skillRel("scripts/lib/determinism.mjs"),
      skillRel("scripts/lib/plan_metrics.mjs"),
      skillRel("scripts/lib/gate_verdict.mjs"),
      skillRel("scripts/lib/gate_input_snapshot.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/lib/transition_journal.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/migrate.mjs"),
      skillRel("scripts/ritual_lint.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_owned_file_replace\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(owned_file_replace|determinism|plan_metrics|gate_verdict|gate_input_snapshot|plan_refresh|transition_journal)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(transition|bootstrap|migrate|ritual_lint)\.mjs$/,
    ],
  }),
  suite({
    id: "plan-target-ownership",
    category: "structured_plan",
    label: "Per-thread plan targets preserve foreign and same-bytes replacement owners",
    command: ["node", join(TESTS_ROOT, "test_plan_target_ownership.mjs")],
    phases: ["state-machine", "planner-core", "fault-injection"],
    surfaces: ["state_machine", "filesystem", "concurrency", "planner_core"],
    fixtures: [
      skillRel("tests/test_plan_target_ownership.mjs"),
      skillRel("scripts/lib/plan_utils.mjs"),
      skillRel("scripts/lib/owned_file_replace.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_plan_target_ownership\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(plan_utils|owned_file_replace)\.mjs$/,
    ],
  }),
  suite({
    id: "ontology-invariants",
    category: "ontology",
    label: "Ontology invariants",
    command: ["node", join(SCRIPTS_DIR, "rule_engine.mjs"), "check-invariants", "--json"],
    acceptsPlanTarget: true,
    fixtures: [skillRel("scripts/rule_engine.mjs")],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/rule_engine\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\//,
      /^reports\/user_story_audit\/story_registry\.json$/,
    ],
  }),
  suite({
    id: "prolog-value-audit",
    category: "ontology",
    label: "E8-2 Prolog prove-or-lose value audit",
    command: ["node", join(TESTS_ROOT, "test_prolog_value_audit.mjs")],
    phases: ["prolog-value-audit", "e8-2", "ontology", "deletion-wave", "autocoder-v2"],
    surfaces: ["ontology", "prolog", "gate_survival", "planner_core"],
    fixtures: [
      skillRel("tests/test_prolog_value_audit.mjs"),
      skillRel("scripts/prolog_value_audit.mjs"),
      skillRel("scripts/lib/prolog_value_audit.mjs"),
      skillRel("prolog"),
      skillRel("packs/tokenomics/rules.pl"),
      "reports/ive/gate_survival/gate_survival.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_prolog_value_audit\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/prolog_value_audit\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/prolog_value_audit\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\//,
      /^\.agent\/skills\/iterative-planner\/packs\/tokenomics\/rules\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/(determinism|gates)\.json$/,
      /^reports\/ive\/gate_survival\/gate_survival\.json$/,
    ],
  }),
  suite({
    id: "trace-coverage-maturity",
    category: "ontology",
    label: "I-016 trace coverage is maturity-scaled (early phases advisory, mature phases hard) — FT-3",
    command: ["node", join(TESTS_ROOT, "test_trace_coverage_maturity.mjs")],
    fixtures: [
      skillRel("tests/test_trace_coverage_maturity.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("scripts/lib/fact_loader.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_trace_coverage_maturity\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
    ],
  }),
  suite({
    id: "ontology-cli-source-truth",
    category: "ontology",
    label: "Ontology CLI and runtime source-of-truth contracts",
    command: ["node", join(TESTS_ROOT, "test_ontology_cli.mjs")],
    fixtures: [
      skillRel("tests/test_ontology_cli.mjs"),
      skillRel("scripts/ontology_inducer.mjs"),
      skillRel("scripts/ontology_cli.mjs"),
      skillRel("scripts/planner.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/ontology_fact_builder.mjs"),
      skillRel("scripts/lib/ontology_runtime.mjs"),
      skillRel("scripts/lib/ontology_schema.mjs"),
      skillRel("scripts/lib/verification_strategy.mjs"),
      skillRel("scripts/lib/semantic_engine.mjs"),
      skillRel("config/verification_strategy.schema.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ontology_cli\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_inducer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_cli\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/planner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(fact_loader|ontology_fact_builder|ontology_runtime|ontology_schema|semantic_engine|verification_strategy)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/verification_strategy\.schema\.json$/,
      /^\.agent\/ontology\/facts\//,
    ],
  }),
  suite({
    id: "truth-surface-convergence",
    category: "structured_plan",
    label: "Freshness-aware Program, story, issue, plan, branch, PR, audit, and close-gate truth convergence",
    command: ["node", join(TESTS_ROOT, "test_truth_surface_convergence.mjs")],
    timeoutMs: 120000,
    phases: ["truth-surface-convergence", "close-truth", "planner-core", "migration-parity"],
    surfaces: ["program_packet", "story_registry", "github_mirror", "git_refs", "audit_freshness", "transition_gates", "ontology", "planner_core"],
    fixtures: [
      skillRel("tests/test_truth_surface_convergence.mjs"),
      skillRel("scripts/truth_surface_reconciler.mjs"),
      skillRel("scripts/lib/truth_surface_convergence.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/program_packet.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("prolog/transitions.pl"),
      skillRel("config/state.schema.json"),
      skillRel("config/failure-codes.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_truth_surface_convergence\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/truth_surface_reconciler\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(truth_surface_convergence|plan_refresh|fact_loader|program_packet)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/(invariants|transitions)\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/(state\.schema|failure-codes)\.json$/,
      /^reports\/user_story_audit\/story_registry\.json$/,
      /^plans\/programs\/[^/]+\/program_packet\.json$/,
    ],
  }),
  suite({
    id: "transition-gate-flows",
    category: "structured_plan",
    label: "Planner transition gate lifecycle flows",
    command: ["node", join(TESTS_ROOT, "test_transition_gate_flows.mjs")],
    timeoutMs: 300000,
    phases: ["state-machine", "gate-lifecycle", "planner-core"],
    surfaces: ["state_machine", "transition_gates", "planner_core", "semantic_gate"],
    fixtures: [
      skillRel("tests/test_transition_gate_flows.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/lib/guidance_reminder.mjs"),
      skillRel("scripts/lib/gate_verdict.mjs"),
      skillRel("scripts/lib/checklist_runner.mjs"),
      skillRel("scripts/lib/determinism.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/lib/gate_input_snapshot.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/degraded_coverage.mjs"),
      skillRel("scripts/lib/bootstrap_status_context.mjs"),
      skillRel("scripts/lib/semantic_substrate.mjs"),
      skillRel("scripts/lib/semantic_engine.mjs"),
      skillRel("scripts/lib/rule_commands.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("prolog/transitions.pl"),
      skillRel("config/gates.json"),
      skillRel("config/failure-codes.json"),
      skillRel("config/degraded_coverage_census.json"),
      skillRel("analyzers/pattern-grep.yaml"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_transition_gate_flows\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(bootstrap|transition|verify_gate)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(determinism|plan_refresh|gate_input_snapshot|fact_loader|guidance_reminder|gate_verdict|checklist_runner|degraded_coverage|bootstrap_status_context|semantic_substrate|semantic_engine|rule_commands)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/(invariants|transitions)\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/(gates|failure-codes|degraded_coverage_census)\.json$/,
      /^\.agent\/skills\/iterative-planner\/analyzers\/pattern-grep\.yaml$/,
      /^\.agent\/skills\/iterative-planner\/checklists\//,
    ],
  }),
  suite({
    id: "transition-dry-run-equivalence",
    category: "structured_plan",
    label: "Authoritative transition dry-run is non-writing and verdict-equivalent across every registered gate",
    command: ["node", join(TESTS_ROOT, "test_transition_dry_run_equivalence.mjs")],
    timeoutMs: 600000,
    phases: ["state-machine", "gate-lifecycle", "planner-core", "preflight-authority"],
    surfaces: ["state_machine", "transition_gates", "planner_core", "semantic_gate", "documentation", "migration"],
    fixtures: [
      skillRel("tests/test_transition_dry_run_equivalence.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/audit_runner.mjs"),
      skillRel("scripts/rule_engine.mjs"),
      skillRel("scripts/lib/autonomous_driver.mjs"),
      skillRel("scripts/lib/checklist_runner.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/gate_verdict.mjs"),
      skillRel("scripts/lib/gate_input_snapshot.mjs"),
      skillRel("scripts/lib/guidance_packet.mjs"),
      skillRel("scripts/lib/plan_utils.mjs"),
      skillRel("scripts/lib/repair_packet.mjs"),
      skillRel("scripts/lib/rule_commands.mjs"),
      skillRel("mcp_server.mjs"),
      skillRel("config/gates.json"),
      skillRel("config/.checklist_integrity"),
      skillRel("checklists/validate-to-close.yaml"),
      skillRel("SKILL.md"),
      skillRel("MIGRATION.md"),
      skillRel("references/CLAUDE.template.md"),
      skillRel("references/prompt-contracts.md"),
      skillRel("references/rule-engine-guide.md"),
      skillRel("references/scripts_registry.md"),
      ".agent/rules.md",
      ".agent/ADAPTATION-GUIDE.md",
      ".agent/workflows/safe-plan.md",
      "README.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_transition_dry_run_equivalence\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(transition|verify_gate|audit_runner|rule_engine)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(autonomous_driver|checklist_runner|fact_loader|gate_verdict|guidance_packet|plan_utils|repair_packet|rule_commands)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/(mcp_server\.mjs|SKILL\.md|MIGRATION\.md)$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
      /^\.agent\/skills\/iterative-planner\/config\/\.checklist_integrity$/,
      /^\.agent\/skills\/iterative-planner\/checklists\/validate-to-close\.yaml$/,
      /^\.agent\/skills\/iterative-planner\/references\/(CLAUDE\.template|prompt-contracts|rule-engine-guide|scripts_registry)\.md$/,
      /^\.agent\/(rules|ADAPTATION-GUIDE)\.md$/,
      /^\.agent\/workflows\/safe-plan\.md$/,
      /^README\.md$/,
    ],
  }),
  suite({
    id: "lifecycle-journey-proof",
    category: "structured_plan",
    label: "Deterministic full planner lifecycle journey proof (J13/J14 Tier 1)",
    command: ["node", join(TESTS_ROOT, "test_lifecycle_journey_proof.mjs")],
    timeoutMs: 240000,
    phases: ["full-lifecycle", "lifecycle-journey", "j13", "j14", "planner-core"],
    surfaces: ["state_machine", "transition_gates", "planner_core", "ive_runner", "program_manager", "story_registry"],
    fixtures: [
      skillRel("tests/test_lifecycle_journey_proof.mjs"),
      skillRel("tests/helpers/env.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/lib/determinism.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/semantic_hygiene.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("prolog/transitions.pl"),
      skillRel("config/gates.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_lifecycle_journey_proof\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_conformance_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(bootstrap|transition|verify_gate)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/gate_input_snapshot\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/semantic_hygiene\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/(invariants|transitions)\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
      /^plans\/programs\/ive-trust-repair\/program_packet\.json$/,
    ],
  }),
  suite({
    id: "committed-dogfood-lifecycle-replay",
    category: "structured_plan",
    label: "Committed dogfood lifecycle current-code replay (Tier 2/L2)",
    command: ["node", join(TESTS_ROOT, "test_dogfood_lifecycle_replay.mjs")],
    timeoutMs: 300000,
    phases: ["committed-lifecycle-replay", "lifecycle-replay", "tier2", "l2", "planner-core"],
    surfaces: ["state_machine", "transition_gates", "planner_core", "prolog", "ive_runner", "program_manager", "committed_artifacts"],
    fixtures: [
      skillRel("tests/test_dogfood_lifecycle_replay.mjs"),
      skillRel("scripts/dogfood_lifecycle_replay.mjs"),
      skillRel("scripts/lib/dogfood_lifecycle_replay.mjs"),
      skillRel("scripts/lib/gate_input_snapshot.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/prolog.mjs"),
      skillRel("prolog/transitions.pl"),
      skillRel("config/gates.json"),
      "plans/plan_2026-07-06_a562d891f2f965d0",
      "plans/plan_2026-07-07_d07f86dd2adff3da",
      "plans/plan_2026-07-09_09ac37d240a5fc72",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_dogfood_lifecycle_replay\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(dogfood_lifecycle_replay|verify_gate)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(dogfood_lifecycle_replay|gate_input_snapshot|fact_loader|prolog)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/transitions\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
      /^plans\/plan_2026-07-(06_a562d891f2f965d0|07_d07f86dd2adff3da|09_09ac37d240a5fc72)\//,
      /^plans\/programs\/ive-trust-repair\/program_packet\.json$/,
    ],
  }),
  suite({
    id: "l3-autonomous-dogfood-harness",
    category: "structured_plan",
    label: "Deterministic L3 headless-agent harness countersign proof",
    command: ["node", join(TESTS_ROOT, "test_autonomous_dogfood_run.mjs")],
    timeoutMs: 120000,
    phases: ["l3-harness", "autonomous-dogfood", "tier3", "l3", "planner-core"],
    surfaces: ["headless_agent", "state_machine", "transition_gates", "planner_core", "ive_runner", "ci", "receipt"],
    fixtures: [
      skillRel("tests/test_autonomous_dogfood_run.mjs"),
      skillRel("scripts/autonomous_dogfood_run.mjs"),
      skillRel("scripts/lib/autonomous_dogfood_run.mjs"),
      skillRel("scripts/lib/dogfood_lifecycle_replay.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("config/gates.json"),
      "docs/ci/l3-autonomous-dogfood.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_autonomous_dogfood_run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/autonomous_dogfood_run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(autonomous_dogfood_run|dogfood_lifecycle_replay)\.mjs$/,
      /^\.github\/workflows\/l3-autonomous-dogfood\.yml$/,
      /^docs\/ci\/l3-autonomous-dogfood\.md$/,
      /^reports\/ive\/autonomous_dogfood_runs\//,
      /^plans\/programs\/ive-trust-repair\/program_packet\.json$/,
    ],
  }),
  suite({
    id: "clean-checkout-conformance",
    category: "release",
    label: "Exact committed revision reproduces canonical story, invariant, findings, and project-health proof",
    command: ["node", join(SCRIPTS_DIR, "clean_checkout_conformance.mjs"), "--ref", "HEAD", "--json"],
    timeoutMs: 180000,
    phases: ["clean-checkout", "release", "planner-core", "story-evidence"],
    surfaces: ["git", "story_registry", "project_health", "release", "planner_core", "traceability"],
    fixtures: [
      skillRel("scripts/clean_checkout_conformance.mjs"),
      skillRel("tests/test_clean_checkout_conformance.mjs"),
      skillRel("tests/ive/run.mjs"),
      skillRel("scripts/story_registry.mjs"),
      skillRel("scripts/rule_engine.mjs"),
      skillRel("scripts/planner_findings.mjs"),
      skillRel("scripts/project_health.mjs"),
      ".agent/workflows/release.md",
      "docs/ive-redesign/17_release_lane.md",
      "reports/user_story_audit/story_registry.json",
      ".gitignore",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/clean_checkout_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_clean_checkout_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(story_registry|rule_engine|planner_findings|project_health)\.mjs$/,
      /^\.agent\/workflows\/release\.md$/,
      /^docs\/ive-redesign\/17_release_lane\.md$/,
      /^reports\/user_story_audit\/story_registry\.json$/,
      /^reports\/ive\/test_runs\/[^/]+-story-proof-[^/]+\//,
      /^\.gitignore$/,
    ],
  }),
  suite({
    id: "clean-checkout-conformance-regression",
    category: "release",
    label: "Seeded red/green, invalid-ref, cleanup, registration, portability, and release-contract guard",
    command: ["node", join(TESTS_ROOT, "test_clean_checkout_conformance.mjs")],
    timeoutMs: 60000,
    phases: ["clean-checkout", "release", "planner-core", "story-evidence"],
    surfaces: ["git", "story_registry", "release", "planner_core", "test_governance"],
    fixtures: [
      skillRel("tests/test_clean_checkout_conformance.mjs"),
      skillRel("scripts/clean_checkout_conformance.mjs"),
      skillRel("tests/ive/run.mjs"),
      ".agent/workflows/release.md",
      "docs/ive-redesign/17_release_lane.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/clean_checkout_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_clean_checkout_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/workflows\/release\.md$/,
      /^docs\/ive-redesign\/17_release_lane\.md$/,
    ],
  }),
  suite({
    id: "weekly-l3-launchd-seat",
    category: "ci",
    label: "Weekly L3 launchd template, Claude seat discovery, and operator boundary",
    command: ["node", join(TESTS_ROOT, "test_weekly_l3_launchd.mjs")],
    phases: ["weekly-l3", "launchd", "local-operator-lane"],
    surfaces: ["config", "orchestration", "local_ci", "headless_agent", "receipt"],
    fixtures: [
      skillRel("tests/test_weekly_l3_launchd.mjs"),
      skillRel("tests/ive/run.mjs"),
      "tools/ci/run-weekly-l3-autonomous-dogfood.mjs",
      "docs/ci/com.ive-studio.weekly-l3-dogfood.plist.template",
      "docs/ci/l3-autonomous-dogfood.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_weekly_l3_launchd\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^tools\/ci\/run-weekly-l3-autonomous-dogfood\.mjs$/,
      /^docs\/ci\/com\.ive-studio\.weekly-l3-dogfood\.plist\.template$/,
      /^docs\/ci\/l3-autonomous-dogfood\.md$/,
    ],
  }),
  suite({
    id: "l3-autonomous-dogfood-receipt-freshness",
    category: "advisory",
    label: "Latest real L3 receipt freshness (advisory only)",
    command: ["node", join(SCRIPTS_DIR, "autonomous_dogfood_run.mjs"), "freshness", "--json"],
    phases: ["l3-freshness", "autonomous-dogfood", "tier3", "l3", "advisory"],
    surfaces: ["headless_agent", "receipt", "freshness", "advisory"],
    required: false,
    run: runJsonAdvisoryStatus,
    fixtures: [
      skillRel("scripts/autonomous_dogfood_run.mjs"),
      skillRel("scripts/lib/autonomous_dogfood_run.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/autonomous_dogfood_run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/autonomous_dogfood_run\.mjs$/,
      /^reports\/ive\/autonomous_dogfood_runs\//,
    ],
  }),
  suite({
    id: "transition-env-cleanup",
    category: "structured_plan",
    label: "Planner transition and gate entrypoints restore temporary process.env targeting",
    command: ["node", join(TESTS_ROOT, "test_transition_env_cleanup.mjs")],
    timeoutMs: 120000,
    phases: ["state-machine", "planner-core", "local-ci-parity"],
    surfaces: ["state_machine", "transition_gates", "test_env", "planner_core"],
    fixtures: [
      skillRel("tests/test_transition_env_cleanup.mjs"),
      skillRel("tests/helpers/env.mjs"),
      skillRel("scripts/lib/env_scope.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/close_guard.mjs"),
      skillRel("scripts/test_baseline.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_transition_env_cleanup\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/helpers\/env\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/env_scope\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(transition|verify_gate|close_guard|test_baseline)\.mjs$/,
    ],
  }),
  suite({
    id: "reflection-verdict-routing",
    category: "structured_plan",
    label: "Reflection verdict routing and close-signal normalization",
    command: ["node", join(TESTS_ROOT, "test_reflection_verdict_routing.mjs")],
    timeoutMs: 120000,
    phases: ["reflection-verdict-routing", "close-signals", "e8-8", "planner-core"],
    surfaces: ["transition_gates", "close_signals", "kb_signoff", "planner_core"],
    fixtures: [
      skillRel("tests/test_reflection_verdict_routing.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/lib/kb_signoff.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_reflection_verdict_routing\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(plan_refresh|kb_signoff)\.mjs$/,
    ],
  }),
  suite({
    id: "local-ci-parity",
    category: "ci",
    label: "Local/CI subprocess env parity and command argv assertions",
    command: ["node", join(TESTS_ROOT, "test_local_ci_parity_helpers.mjs")],
    phases: ["stage1", "ci-enforcement", "local-ci-parity", "autocoder-v2"],
    surfaces: ["ci", "test_env", "subprocess", "runner"],
    fixtures: [
      skillRel("tests/test_local_ci_parity_helpers.mjs"),
      skillRel("tests/helpers/env.mjs"),
      skillRel("tests/ive/run.mjs"),
      skillRel("scripts/lib/autonomous_driver.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_local_ci_parity_helpers\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/helpers\/env\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/test_run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_conformance_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/autonomous_driver\.mjs$/,
    ],
  }),
  suite({
    id: "knowledge-triggers",
    category: "active_ontology",
    label: "Knowledge Trigger obligations, ranked insight injection, capture, and promotion",
    command: ["node", join(TESTS_ROOT, "test_knowledge_triggers.mjs")],
    phases: ["knowledge-triggers", "active-knowledge", "planner-memory", "e4-6", "ranked-knowledge-injection"],
    surfaces: ["knowledge_triggers", "active_ontology", "obligation_gate", "insight_injection", "ranked_retrieval"],
    fixtures: [
      skillRel("tests/test_knowledge_triggers.mjs"),
      skillRel("tests/fixtures/real_episodes/mac_mini_quant_episodes.json"),
      skillRel("scripts/knowledge_triggers.mjs"),
      skillRel("scripts/lib/knowledge_triggers.mjs"),
      skillRel("scripts/lib/journal_memory.mjs"),
      skillRel("scripts/lib/agent_journal.mjs"),
      skillRel("scripts/lib/ive_real_episode_corpus.mjs"),
      skillRel("config/knowledge_triggers.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_knowledge_triggers\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_episodes\/mac_mini_quant_episodes\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/knowledge_triggers\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(knowledge_triggers|journal_memory|agent_journal|ive_real_episode_corpus)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/knowledge_triggers\.json$/,
    ],
  }),
  suite({
    id: "context-packet",
    category: "active_ontology",
    label: "Context packet: bounded planning retrieval with provenance and noise exclusion",
    command: ["node", join(TESTS_ROOT, "test_context_packet.mjs")],
    phases: ["context-packet", "planner-memory", "retrieval"],
    surfaces: ["context_packet", "knowledge_resolver", "program_packet", "agent_journal", "persona_signals"],
    fixtures: [
      skillRel("tests/test_context_packet.mjs"),
      skillRel("scripts/context_packet.mjs"),
      skillRel("scripts/lib/context_packet.mjs"),
      skillRel("scripts/knowledge_resolver.mjs"),
      skillRel("scripts/lib/knowledge_hub.mjs"),
      skillRel("scripts/lib/agent_journal.mjs"),
      skillRel("scripts/lib/program_packet.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_context_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/context_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/context_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/knowledge_resolver\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(knowledge_hub|agent_journal|program_packet)\.mjs$/,
      /^plans\/programs\//,
      /^plans\/knowledge\/agent_journal\.jsonl$/,
    ],
  }),
  suite({
    id: "agent-journal-ontology",
    category: "active_ontology",
    label: "Agent journal advisory memory and ontology facts",
    command: ["node", join(TESTS_ROOT, "test_agent_journal.mjs")],
    phases: ["planner-memory", "ontology", "migration-parity", "e4-5", "bi-temporal-journal"],
    surfaces: ["agent_journal", "fact_loader", "prolog", "planner_core"],
    fixtures: [
      skillRel("tests/test_agent_journal.mjs"),
      skillRel("scripts/journal.mjs"),
      skillRel("scripts/lib/agent_journal.mjs"),
      skillRel("scripts/lib/journal_memory.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_agent_journal\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/journal\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(agent_journal|journal_memory|fact_loader)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^plans\/knowledge\/agent_journal\.jsonl$/,
    ],
  }),
  suite({
    id: "decision-anchor-lifecycle",
    category: "active_ontology",
    label: "Decision anchors: journal lifecycle, stale retirement, and capped projections",
    command: ["node", join(TESTS_ROOT, "test_decision_anchors.mjs")],
    phases: ["decision-anchors", "journal-projections", "planner-memory", "e4-7", "capped-projections"],
    surfaces: ["decision_anchors", "agent_journal", "fact_loader", "validate_to_close", "planner_core"],
    fixtures: [
      skillRel("tests/test_decision_anchors.mjs"),
      skillRel("scripts/decision_anchors.mjs"),
      skillRel("scripts/lib/decision_anchors.mjs"),
      skillRel("scripts/lib/agent_journal.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("checklists/validate-to-close.yaml"),
      skillRel("references/decision-anchoring.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_decision_anchors\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/decision_anchors\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(decision_anchors|agent_journal|fact_loader)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/checklists\/validate-to-close\.yaml$/,
      /^\.agent\/skills\/iterative-planner\/references\/decision-anchoring\.md$/,
      /^plans\/knowledge\/agent_journal\.jsonl$/,
    ],
  }),
  suite({
    id: "auditor-pack-engine",
    category: "escalation",
    label: "Shared auditor pack engine",
    command: ["node", join(TESTS_ROOT, "test_auditor_pack_engine.mjs")],
    phases: ["persona-packs", "autocoder-v2", "e5-1"],
    surfaces: ["persona_packs", "prolog", "normalization"],
    fixtures: [
      skillRel("tests/test_auditor_pack_engine.mjs"),
      skillRel("scripts/lib/auditor_pack_engine.mjs"),
      skillRel("scripts/lib/audit_types.mjs"),
      skillRel("scripts/lib/pack_severity.mjs"),
      skillRel("scripts/lib/prolog.mjs"),
      skillRel("packs/ux_ui/rules.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_auditor_pack_engine\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/auditor_pack_engine\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/(wiring_auditor|assumptions_challenger|traceability|config_integrity|ux_ui|quant|quant_target|tokenomics|_template)\/index\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/(wiring_auditor|assumptions_challenger|traceability|config_integrity|ux_ui|quant|quant_target|tokenomics|_template)\/rules\.pl$/,
    ],
  }),
  suite({
    id: "persona-authority-project-health",
    category: "escalation",
    label: "Persona authority project shape and bootstrap status receipts",
    command: ["node", join(TESTS_ROOT, "test_persona_authority_project_health.mjs")],
    phases: ["persona-authority", "planner-policy", "project-health", "j7"],
    surfaces: ["persona_packs", "planner_policy", "bootstrap", "project_health", "planner_core"],
    fixtures: [
      skillRel("tests/test_persona_authority_project_health.mjs"),
      skillRel("scripts/audit_runner.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/lib/persona_activation_authority.mjs"),
      skillRel("scripts/lib/persona_adaptation.mjs"),
      skillRel("scripts/lib/planner_policy.mjs"),
      skillRel("config/planner_policy.schema.json"),
      "planner.policy.yaml",
    ],
    changedFilePatterns: [
      /^planner\.policy\.ya?ml$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_persona_authority_project_health\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(audit_runner|bootstrap)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(persona_activation_authority|persona_adaptation|planner_policy)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/planner_policy\.schema\.json$/,
    ],
  }),
  suite({
    id: "program-manager-tests",
    category: "structured_plan",
    label: "Program manager tests",
    command: ["node", join(TESTS_ROOT, "test_program_manager.mjs")],
    timeoutMs: 300000,
    fixtures: [
      skillRel("tests/test_program_manager.mjs"),
      skillRel("scripts/program_manager.mjs"),
      skillRel("scripts/lib/gate_satisfiability.mjs"),
      skillRel("scripts/lib/lifecycle_delivery_evidence.mjs"),
      skillRel("scripts/lib/program_disposition.mjs"),
      skillRel("scripts/lib/program_packet.mjs"),
      skillRel("scripts/lib/remote_mode.mjs"),
      skillRel("config/program_packet.schema.json"),
      skillRel("prolog/programs.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/program_manager\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/gate_satisfiability\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/lifecycle_delivery_evidence\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/program_disposition\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/program_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/remote_mode\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/program_packet\.schema\.json$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/programs\.pl$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_program_manager\.mjs$/,
      /^plans\/programs\//,
    ],
  }),
  suite({
    id: "production-autonomous-ticket-delivery",
    category: "structured_plan",
    label: "Production Program-ticket worktree execution, parent grading, budget, and receipt contracts",
    command: ["node", join(TESTS_ROOT, "test_autonomous_ticket_delivery.mjs")],
    phases: ["production-autonomy", "ticket-delivery", "tier3", "l3"],
    surfaces: ["program_manager", "git_worktree", "agent_process", "artifact_grade", "budget", "receipt", "planner_core"],
    fixtures: [
      skillRel("tests/test_autonomous_ticket_delivery.mjs"),
      skillRel("scripts/autonomous_ticket_delivery.mjs"),
      skillRel("scripts/lib/autonomous_ticket_delivery.mjs"),
      skillRel("scripts/lib/task_rubric_grader.mjs"),
      skillRel("scripts/lib/work_order_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_autonomous_ticket_delivery\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/autonomous_ticket_delivery\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(autonomous_ticket_delivery|task_rubric_grader)\.mjs$/,
    ],
  }),
  suite({
    id: "lifecycle-reconciler",
    category: "structured_plan",
    label: "J9 lifecycle reconciler: shipped-open tickets and cross-program duplicate scope",
    command: ["node", join(TESTS_ROOT, "test_lifecycle_reconciler.mjs")],
    phases: ["j9", "T-INTAKE-B6D19965", "program-manager", "lifecycle-reconciliation"],
    surfaces: ["program_manager", "bootstrap", "planner_core", "lifecycle_reconciliation"],
    fixtures: [
      skillRel("tests/test_lifecycle_reconciler.mjs"),
      skillRel("scripts/lifecycle_reconciler.mjs"),
      skillRel("scripts/lib/lifecycle_delivery_evidence.mjs"),
      skillRel("scripts/lib/lifecycle_reconciler.mjs"),
      skillRel("scripts/program_manager.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      "plans/programs/ive-trust-repair/program_packet.json",
      "plans/programs/ive-consolidation-rectification/program_packet.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_lifecycle_reconciler\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lifecycle_reconciler\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/lifecycle_delivery_evidence\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/lifecycle_reconciler\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(program_manager|bootstrap)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^plans\/programs\//,
    ],
  }),
  suite({
    id: "deterministic-findings-schema",
    category: "structured_plan",
    label: "FI1 normalized deterministic findings schema and emitters",
    command: ["node", join(TESTS_ROOT, "test_deterministic_findings.mjs")],
    testClass: TEST_CLASS_FUNCTIONAL_PROOF,
    phases: ["findings-to-intake", "fi1", "program-manager", "us-091", "planner-core"],
    surfaces: [
      "findings_bridge",
      "program_manager",
      "ive_conformance",
      "scoreboard",
      "ritual_replay",
      "rule_engine",
      "project_health",
      "planner_core",
    ],
    fixtures: [
      skillRel("tests/test_deterministic_findings.mjs"),
      skillRel("scripts/lib/deterministic_findings.mjs"),
      skillRel("tests/ive/run.mjs"),
      skillRel("scripts/lib/scoreboard.mjs"),
      skillRel("scripts/lib/ritual_replay.mjs"),
      skillRel("scripts/lib/rule_commands.mjs"),
      skillRel("scripts/project_health.mjs"),
      "plans/programs/ive-autocoder-v2/baselines",
      "plans/programs/findings-to-intake/program_packet.json",
      "reports/user_story_audit/story_registry.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_deterministic_findings\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/deterministic_findings\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(scoreboard|ritual_replay|rule_commands)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/project_health\.mjs$/,
      /^plans\/programs\/ive-autocoder-v2\/baselines\//,
      /^plans\/programs\/findings-to-intake\/program_packet\.json$/,
      /^reports\/user_story_audit\/story_registry\.json$/,
    ],
  }),
  suite({
    id: "findings-triage-intake",
    category: "structured_plan",
    label: "FI2 findings triage creates evidence-attached Program Manager intake",
    command: ["node", join(TESTS_ROOT, "test_program_manager_findings_triage.mjs")],
    testClass: TEST_CLASS_FUNCTIONAL_PROOF,
    phases: ["findings-to-intake", "fi2", "program-manager", "us-091", "planner-core"],
    surfaces: [
      "findings_bridge",
      "program_manager",
      "ive_conformance",
      "scoreboard",
      "cli_determinism",
      "planner_core",
    ],
    fixtures: [
      skillRel("tests/test_program_manager_findings_triage.mjs"),
      skillRel("scripts/program_manager.mjs"),
      skillRel("scripts/lib/deterministic_findings.mjs"),
      skillRel("tests/ive/run.mjs"),
      skillRel("tests/test_cli_determinism.mjs"),
      "plans/programs/findings-to-intake/program_packet.json",
      "reports/user_story_audit/story_registry.json",
      "reports/ive/scoreboard/scoreboard-2026-07-07T17-40-11-369Z/scoreboard.json",
      "reports/ive/test_runs/scoreboard-2026-07-07T17-40-11-369Z-conformance/manifest.json",
      skillRel("tests/fixtures/findings_triage/cli-determinism.failure-excerpt.txt"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_program_manager_findings_triage\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/program_manager\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/deterministic_findings\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_cli_determinism\.mjs$/,
      /^plans\/programs\/findings-to-intake\/program_packet\.json$/,
      /^reports\/user_story_audit\/story_registry\.json$/,
      /^reports\/ive\/scoreboard\/scoreboard-2026-07-07T17-40-11-369Z\/scoreboard\.json$/,
      /^reports\/ive\/test_runs\/scoreboard-2026-07-07T17-40-11-369Z-conformance\//,
    ],
  }),
  suite({
    id: "repo-state-stamps",
    category: "structured_plan",
    label: "J11 repo-state stamps on receipts and dirty-input proof warnings",
    command: ["node", join(TESTS_ROOT, "test_receipt_repo_state_stamp.mjs")],
    phases: ["j11", "T-INTAKE-34C0058D", "repo-state-stamp", "receipt-provenance"],
    surfaces: ["repo_state_stamp", "transition_gates", "program_manager", "ive_runner", "lifecycle_reconciliation", "planner_core"],
    fixtures: [
      skillRel("tests/test_receipt_repo_state_stamp.mjs"),
      skillRel("scripts/lib/repo_state_stamp.mjs"),
      skillRel("scripts/lib/determinism.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/program_manager.mjs"),
      skillRel("scripts/lib/lifecycle_reconciler.mjs"),
      skillRel("tests/ive/run.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_repo_state_stamp\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_receipt_repo_state_stamp\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/repo_state_stamp\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/determinism\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/program_manager\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/lifecycle_reconciler\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
    ],
  }),
  suite({
    id: "story-registry-merge-guard",
    category: "structured_plan",
    label: "Story registry merge and executed-proof guard",
    command: ["node", join(TESTS_ROOT, "test_story_registry_merge_guard.mjs")],
    phases: ["stage1", "structured-plan", "merge-guard"],
    surfaces: ["story_registry", "program_manager", "conformance"],
    fixtures: [
      skillRel("tests/test_story_registry_merge_guard.mjs"),
      skillRel("scripts/story_cli.mjs"),
      skillRel("scripts/story_registry.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/planner_canonicalizer.mjs"),
      skillRel("scripts/lib/prolog.mjs"),
      skillRel("scripts/lib/sanitize.mjs"),
      skillRel("prolog/stories.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_story_registry_merge_guard\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/story_cli\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/story_registry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/planner_canonicalizer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(fact_loader|rule_commands)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/(stories|invariants)\.pl$/,
      /^reports\/user_story_audit\/story_registry\.json$/,
    ],
  }),
  suite({
    id: "program-packet-design-to-ready",
    category: "structured_plan",
    label: "Program packet design-to-ready gate (clean-checkout)",
    command: ["node", join(TESTS_ROOT, "test_program_packet_design_to_ready_gate.mjs")],
    fixtures: [
      skillRel("tests/test_program_packet_design_to_ready_gate.mjs"),
      skillRel("scripts/program_manager.mjs"),
      skillRel("scripts/lib/program_packet.mjs"),
      skillRel("config/program_packet_known_debt_profiles.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_program_packet_design_to_ready_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/program_manager\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/program_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/program_packet_known_debt_profiles\.json$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/programs\.pl$/,
      /^plans\/programs\//,
    ],
  }),
  suite({
    id: "north-star-telemetry",
    category: "projection",
    label: "North Star telemetry: measured-vs-threshold gate (t07)",
    command: ["node", join(TESTS_ROOT, "test_north_star_telemetry.mjs")],
    fixtures: [
      skillRel("tests/test_north_star_telemetry.mjs"),
      skillRel("scripts/lib/north_star_telemetry.mjs"),
      skillRel("scripts/lib/planner_manifesto.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_north_star_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/north_star_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/planner_manifesto\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
    ],
  }),
  suite({
    id: "verification-metrics",
    category: "projection",
    label: "Verification metrics: real-definition collector (dead-load/gated/real-data/genuine-close) for North Star gating",
    command: ["node", join(TESTS_ROOT, "test_verification_metrics.mjs")],
    fixtures: [
      skillRel("tests/test_verification_metrics.mjs"),
      skillRel("scripts/verification_metrics.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_verification_metrics\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verification_metrics\.mjs$/,
    ],
  }),
  suite({
    id: "autocoder-metrics",
    category: "projection",
    label: "Autocoder outcome metrics: ceremony, proof, autonomy, cost, retry, and false-green scoreboard",
    command: ["node", join(TESTS_ROOT, "test_autocoder_metrics.mjs")],
    fixtures: [
      skillRel("tests/test_autocoder_metrics.mjs"),
      skillRel("tests/fixtures/autocoder_outcomes/real_history_replay_manifest.json"),
      skillRel("scripts/autocoder_metrics.mjs"),
      skillRel("scripts/lib/behavior_report.mjs"),
      "plans/programs/ive-autocoder-v2/baselines",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_autocoder_metrics\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/autocoder_outcomes\/real_history_replay_manifest\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/autocoder_metrics\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/behavior_report\.mjs$/,
      /^plans\/programs\/ive-autocoder-v2\/baselines\//,
    ],
  }),
  suite({
    id: "behavior-report",
    category: "projection",
    label: "IVE behavior report: taxonomy, shadow-canary, advisory audit, and autocoder scoreboard",
    command: ["node", join(TESTS_ROOT, "test_behavior_report.mjs")],
    fixtures: [
      skillRel("tests/test_behavior_report.mjs"),
      skillRel("scripts/behavior_report.mjs"),
      skillRel("scripts/autocoder_metrics.mjs"),
      skillRel("scripts/lib/behavior_report.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_behavior_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/behavior_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/autocoder_metrics\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/behavior_report\.mjs$/,
    ],
  }),
  suite({
    id: "ab-task-benchmark",
    category: "projection",
    label: "A/B task benchmark v1: planner-off vs planner-wrapped replay",
    command: ["node", join(TESTS_ROOT, "test_ab_task_benchmark.mjs")],
    phases: ["ab-task-benchmark", "e2-6", "scoreboard-sample", "autocoder-v2"],
    surfaces: ["projection", "ab_task_benchmark", "scenario", "scoreboard", "autocoder_v2"],
    fixtures: [
      skillRel("tests/test_ab_task_benchmark.mjs"),
      skillRel("tests/fixtures/real_episodes/mac_mini_quant_episodes.json"),
      skillRel("scripts/ab_task_benchmark.mjs"),
      skillRel("scripts/lib/ab_task_benchmark.mjs"),
      skillRel("scripts/lib/ive_real_episode_corpus.mjs"),
      skillRel("references/ab-task-benchmark.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ab_task_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_episodes\/mac_mini_quant_episodes\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ab_task_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ab_task_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/dispatcher_v1\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_real_episode_corpus\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/references\/ab-task-benchmark\.md$/,
    ],
  }),
  suite({
    id: "ideation-quality-benchmark",
    category: "ideation",
    label: "Insight velocity ideation-quality benchmark",
    command: ["node", join(TESTS_ROOT, "test_ideation_quality_benchmark.mjs")],
    phases: ["ideation-quality-benchmark", "insight-velocity", "e2", "test-switch", "autocoder-v2"],
    surfaces: ["ideation_quality", "insight_velocity", "scoreboard", "planner_core"],
    fixtures: [
      skillRel("tests/test_ideation_quality_benchmark.mjs"),
      skillRel("tests/fixtures/ideation_quality/corpus.json"),
      skillRel("scripts/ideation_quality_benchmark.mjs"),
      skillRel("scripts/lib/ideation_quality_benchmark.mjs"),
      skillRel("scripts/lib/scoreboard.mjs"),
      "docs/ive-redesign/18_ideation_quality_benchmark.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ideation_quality_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/ideation_quality\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/ideation_quality_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ideation_quality_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/scoreboard\.mjs$/,
      docsIvePattern("18_ideation_quality_benchmark.md"),
    ],
  }),
  suite({
    id: "pack-guard-benchmark",
    category: "knowledge_pack",
    label: "Pack guard conformance and ignored-pack benchmark",
    command: ["node", join(TESTS_ROOT, "test_pack_guard_benchmark.mjs")],
    phases: ["pack-guard-benchmark", "knowledge-packs", "scoreboard", "planner-core", "program-manager", "autocoder-v2"],
    surfaces: ["knowledge_pack", "pack_guard", "scoreboard", "planner_core", "program_manager"],
    fixtures: [
      skillRel("tests/test_pack_guard_benchmark.mjs"),
      skillRel("tests/fixtures/pack_guard_benchmark/corpus.json"),
      skillRel("scripts/lib/pack_guard_benchmark.mjs"),
      skillRel("scripts/lib/scoreboard.mjs"),
      skillRel("scripts/lib/ontology_pack_guard_contract.mjs"),
      skillRel("scripts/lib/knowledge_receipt.mjs"),
      skillRel("scripts/lib/task_focus_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_pack_guard_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/pack_guard_benchmark\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/pack_guard_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/scoreboard\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ontology_pack_guard_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/knowledge_receipt\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/task_focus_contract\.mjs$/,
    ],
  }),
  suite({
    id: "insight-velocity-report",
    category: "ideation",
    label: "Insight Velocity focused current-code report",
    command: ["node", join(TESTS_ROOT, "test_insight_velocity_report.mjs")],
    phases: ["insight-velocity-report", "insight-velocity", "e2", "test-switch", "autocoder-v2"],
    surfaces: ["ideation_quality", "insight_velocity", "planner_core"],
    fixtures: [
      skillRel("tests/test_insight_velocity_report.mjs"),
      skillRel("scripts/insight_velocity_report.mjs"),
      skillRel("scripts/ideation_quality_benchmark.mjs"),
      skillRel("scripts/lib/ideation_quality_benchmark.mjs"),
      skillRel("scripts/ritual_replay.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_insight_velocity_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/insight_velocity_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ideation_quality_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ideation_quality_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ritual_replay\.mjs$/,
    ],
  }),
  suite({
    id: "ttinsights-report",
    category: "ideation",
    label: "TTInsights ontology-guided planner improvement report",
    command: ["node", join(TESTS_ROOT, "test_ttinsights_report.mjs")],
    phases: ["ttinsights-report", "insight-velocity", "planner-core", "program-manager", "autocoder-v2"],
    surfaces: ["ttinsights", "ontology", "insight_velocity", "program_manager", "planner_core"],
    fixtures: [
      skillRel("tests/test_ttinsights_report.mjs"),
      skillRel("scripts/ttinsights_report.mjs"),
      skillRel("scripts/lib/ttinsights_report.mjs"),
      skillRel("scripts/insight_velocity_report.mjs"),
      skillRel("scripts/autocoder_metrics.mjs"),
      skillRel("scripts/behavior_report.mjs"),
      skillRel("scripts/gate_survival.mjs"),
      skillRel("scripts/prolog_value_audit.mjs"),
      skillRel("scripts/rule_engine.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ttinsights_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ttinsights_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ttinsights_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/insight_velocity_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/autocoder_metrics\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/behavior_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/gate_survival\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/prolog_value_audit\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/rule_engine\.mjs$/,
      /^plans\/programs\/ive-ttinsights-engine\//,
    ],
  }),
  suite({
    id: "scoreboard-cli",
    category: "projection",
    label: "Scoreboard CLI: E2 test-switch fail-closed metrics gate",
    command: ["node", join(TESTS_ROOT, "test_scoreboard.mjs")],
    phases: ["scoreboard", "e2-5", "e2-7", "e2-8", "test-switch", "convergence-metrics", "reuse-discipline", "autocoder-v2"],
    surfaces: ["scoreboard", "test_switch", "ci", "convergence_metrics", "reuse_discipline", "autocoder_v2"],
    fixtures: [
      skillRel("tests/test_scoreboard.mjs"),
      skillRel("scripts/scoreboard.mjs"),
      skillRel("scripts/lib/scoreboard.mjs"),
      skillRel("scripts/lib/plan_metrics.mjs"),
      skillRel("scripts/ritual_replay.mjs"),
      skillRel("scripts/lib/ritual_replay.mjs"),
      skillRel("scripts/seeded_defect_harness.mjs"),
      skillRel("scripts/lib/reuse_before_create_gate.mjs"),
      skillRel("scripts/real_telemetry_false_reds.mjs"),
      skillRel("scripts/lib/ab_task_benchmark.mjs"),
      skillRel("scripts/lib/ideation_quality_benchmark.mjs"),
      skillRel("scripts/lib/pack_guard_benchmark.mjs"),
      skillRel("tests/fixtures/pack_guard_benchmark/corpus.json"),
      skillRel("references/convergence-metrics.md"),
      skillRel("references/planning-rigor.md"),
      "plans/programs/ive-autocoder-v2/baselines",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_scoreboard\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/scoreboard\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/scoreboard\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/plan_metrics\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ritual_replay\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ritual_replay\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/seeded_defect_harness\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/reuse_before_create_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ideation_quality_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/pack_guard_benchmark\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/pack_guard_benchmark\//,
      /^\.agent\/skills\/iterative-planner\/references\/(convergence-metrics|planning-rigor)\.md$/,
      /^plans\/programs\/ive-autocoder-v2\/baselines\//,
    ],
  }),
  suite({
    id: "seeded-defect-harness",
    category: "projection",
    label: "Seeded-defect corpus: false-green catch-rate harness",
    command: ["node", join(TESTS_ROOT, "test_seeded_defect_harness.mjs")],
    phases: ["false-green", "planner-core", "e2-8", "duplicate-capability", "reuse-discipline", "autocoder-v2"],
    surfaces: ["seeded_defects", "false_green", "planner_core", "ive_runner", "reuse_before_create"],
    fixtures: [
      skillRel("tests/test_seeded_defect_harness.mjs"),
      skillRel("scripts/seeded_defect_harness.mjs"),
      skillRel("scripts/lib/evidence_verifier.mjs"),
      skillRel("scripts/lib/ive_reflection_diff.mjs"),
      skillRel("scripts/lib/reuse_before_create_gate.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_seeded_defect_harness\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/seeded_defect_harness\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/reuse_before_create_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(evidence_verifier|ive_reflection_diff|run_record|plan_utils)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/(leakage_proof|calibration_gate)\.mjs$/,
    ],
  }),
  suite({
    id: "planner-truth-packet",
    category: "projection",
    label: "Planner truth packet: dogfood false-green measurement across health/story/ontology/North Star surfaces",
    command: ["node", join(TESTS_ROOT, "test_planner_truth_packet.mjs")],
    phases: ["false-green", "planner-core", "dogfood-health", "program-manager"],
    surfaces: ["false_green", "planner_core", "story_registry", "north_star", "program_manager"],
    fixtures: [
      skillRel("tests/test_planner_truth_packet.mjs"),
      skillRel("scripts/planner_truth_packet.mjs"),
      skillRel("scripts/lib/planner_truth_packet.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_planner_truth_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/planner_truth_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/planner_truth_packet\.mjs$/,
    ],
  }),
  suite({
    id: "false-failure-ledger",
    category: "projection",
    label: "Verifier resilience: false-failure ledger (block-then-pass-unchanged self-clear detection)",
    command: ["node", join(TESTS_ROOT, "test_gate_false_failure_ledger.mjs")],
    fixtures: [
      skillRel("tests/test_gate_false_failure_ledger.mjs"),
      skillRel("scripts/gate_false_failure_ledger.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_gate_false_failure_ledger\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/gate_false_failure_ledger\.mjs$/,
    ],
  }),
  suite({
    id: "gate-survival-analysis",
    category: "projection",
    label: "Gate survival analysis: E2-4 KEEP/DEMOTE/DELETE evidence feed",
    command: ["node", join(TESTS_ROOT, "test_gate_survival.mjs")],
    phases: ["gate-survival", "false-red", "planner-core", "autocoder-v2"],
    surfaces: ["gate_survival", "false_red", "planner_core", "ive_runner"],
    fixtures: [
      skillRel("tests/test_gate_survival.mjs"),
      skillRel("scripts/gate_survival.mjs"),
      skillRel("scripts/lib/behavior_report.mjs"),
      skillRel("config/gates.json"),
      skillRel("config/failure-codes.json"),
      skillRel("checklists"),
      skillRel("prolog"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/lib/checklist_runner.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_gate_survival\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/gate_survival\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/behavior_report\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
      /^reports\/ive\/gate_survival\//,
    ],
  }),
  suite({
    id: "real-telemetry-false-failures",
    category: "projection",
    label: "Verifier resilience: false-failure ledger grounded in real sibling-project telemetry",
    command: ["node", join(TESTS_ROOT, "test_real_telemetry_false_failures.mjs")],
    fixtures: [
      skillRel("tests/test_real_telemetry_false_failures.mjs"),
      skillRel("scripts/gate_false_failure_ledger.mjs"),
      skillRel("tests/fixtures/real_telemetry/crawler_extractor_GATE-TMP-002.jsonl"),
      skillRel("tests/fixtures/real_telemetry/evolution_trading_GATE-ETR-008.jsonl"),
      skillRel("tests/fixtures/real_telemetry/tesseract_GATE-ETR-008.jsonl"),
      skillRel("tests/fixtures/real_telemetry/ipbs_GATE-REF-003.jsonl"),
      skillRel("tests/fixtures/real_telemetry/trueskill_tennis_GATE-REF-003.jsonl"),
      skillRel("tests/fixtures/real_telemetry/tokenlab_GATE-EXP-001.jsonl"),
      skillRel("tests/fixtures/real_telemetry/valueinvesting_reflect_to_close_stuck.jsonl"),
      skillRel("tests/fixtures/real_telemetry/crawler_extractor_GATE-VAL-015.jsonl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_real_telemetry_false_failures\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/gate_false_failure_ledger\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_telemetry\//,
    ],
  }),
  suite({
    id: "harvest-real-telemetry",
    category: "projection",
    label: "Portable fixture supply chain: bootstrap and byte-verbatim telemetry contracts (US-088)",
    command: ["node", join(TESTS_ROOT, "test_harvest_real_telemetry.mjs"), "--portable-only"],
    surfaces: ["projection", "planner_core", "real_telemetry", "bootstrap"],
    testClass: "functional_proof_test",
    fixtures: [
      skillRel("tests/test_harvest_real_telemetry.mjs"),
      skillRel("tests/helpers/env.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/harvest_real_telemetry.mjs"),
      skillRel("scripts/gate_false_failure_ledger.mjs"),
      skillRel("config/.project_registry.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_harvest_real_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/helpers\/env\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/harvest_real_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/\.project_registry\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_telemetry\//,
    ],
  }),
  suite({
    id: "harvest-real-telemetry-host",
    category: "projection",
    label: "Host integration: require a real registered sibling telemetry harvest (US-088)",
    command: ["node", join(TESTS_ROOT, "test_harvest_real_telemetry.mjs"), "--require-real"],
    surfaces: ["projection", "host_real_telemetry"],
    testClass: "functional_proof_test",
    fixtures: [
      skillRel("tests/test_harvest_real_telemetry.mjs"),
      skillRel("tests/helpers/env.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/harvest_real_telemetry.mjs"),
      skillRel("scripts/gate_false_failure_ledger.mjs"),
      skillRel("config/.project_registry.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_harvest_real_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/helpers\/env\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/harvest_real_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/\.project_registry\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_telemetry\//,
    ],
    run: runHarvestRealTelemetryHost,
  }),
  suite({
    id: "real-telemetry-replay",
    category: "projection",
    label: "Real-telemetry replay: live gate-decision engine reproduces recorded verdicts + hash-chain integrity (Epic B)",
    command: ["node", join(TESTS_ROOT, "test_replay_telemetry.mjs")],
    fixtures: [
      skillRel("tests/test_replay_telemetry.mjs"),
      skillRel("scripts/replay_telemetry.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_replay_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/replay_telemetry\.mjs$/,
    ],
  }),
  suite({
    id: "ritual-replay",
    category: "projection",
    label: "Real-work ritual replay: current-code ritual percentage over real telemetry",
    command: ["node", join(TESTS_ROOT, "test_ritual_replay.mjs")],
    phases: ["ritual-replay", "real-telemetry", "e2-9", "test-switch", "autocoder-v2"],
    surfaces: ["real_telemetry", "ritual_replay", "scoreboard", "planner_core", "ive_runner"],
    fixtures: [
      skillRel("tests/test_ritual_replay.mjs"),
      skillRel("scripts/ritual_replay.mjs"),
      skillRel("scripts/lib/ritual_replay.mjs"),
      skillRel("scripts/lib/behavior_report.mjs"),
      skillRel("tests/fixtures/real_telemetry"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ritual_replay\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ritual_replay\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(ritual_replay|behavior_report)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_telemetry\//,
    ],
  }),
  suite({
    id: "real-telemetry-false-red-exports",
    category: "projection",
    label: "Real-telemetry false-red exports: 25+ provenance fixtures and per-gate false_red.json",
    command: ["node", join(TESTS_ROOT, "test_real_telemetry_false_red_exports.mjs")],
    phases: ["false-red", "real-telemetry", "planner-core", "autocoder-v2"],
    surfaces: ["real_telemetry", "false_red", "planner_core", "ive_runner"],
    fixtures: [
      skillRel("tests/test_real_telemetry_false_red_exports.mjs"),
      skillRel("scripts/real_telemetry_false_reds.mjs"),
      skillRel("scripts/gate_false_failure_ledger.mjs"),
      skillRel("scripts/replay_telemetry.mjs"),
      skillRel("tests/fixtures/real_telemetry"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_real_telemetry_false_red_exports\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/real_telemetry_false_reds\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_telemetry\//,
    ],
  }),
  suite({
    id: "capability-probe",
    category: "projection",
    label: "Verifier resilience: capability probe (never require proof from a sensor detected as off)",
    command: ["node", join(TESTS_ROOT, "test_capability_probe.mjs")],
    fixtures: [
      skillRel("tests/test_capability_probe.mjs"),
      skillRel("scripts/lib/capability_probe.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_capability_probe\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/capability_probe\.mjs$/,
    ],
  }),
  suite({
    id: "gate-idempotence",
    category: "projection",
    label: "Verifier resilience: gate idempotence (same verdict on an unchanged plan run twice)",
    command: ["node", join(TESTS_ROOT, "test_gate_idempotence_check.mjs")],
    fixtures: [
      skillRel("tests/test_gate_idempotence_check.mjs"),
      skillRel("scripts/gate_idempotence_check.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_gate_idempotence_check\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/gate_idempotence_check\.mjs$/,
    ],
  }),
  suite({
    id: "red-team-depth-gate",
    category: "structured_plan",
    label: "GATE-ETR-008 red-team vector depth and scaffold rejection",
    command: ["node", join(TESTS_ROOT, "test_repair_packet.mjs")],
    phases: ["stage1", "execute-to-reflect", "red-team-depth", "semantic-gates"],
    surfaces: ["structured_plan", "semantic_gate", "red_team"],
    fixtures: [
      skillRel("tests/test_repair_packet.mjs"),
      skillRel("scripts/lib/plan_utils.mjs"),
      skillRel("scripts/lib/repair_packet.mjs"),
      skillRel("scripts/lib/guidance_reminder.mjs"),
      skillRel("scripts/gate_prepare.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("config/gate_templates/GATE-ETR-008.json"),
      skillRel("examples/passing/GATE-ETR-008.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_repair_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(plan_utils|repair_packet|guidance_reminder)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(gate_prepare|verify_gate)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/gate_templates\/GATE-ETR-008\.json$/,
      /^\.agent\/skills\/iterative-planner\/examples\/passing\/GATE-ETR-008\.md$/,
    ],
  }),
  suite({
    id: "contract-preview",
    category: "structured_plan",
    label: "Front-loaded contract preview: rules surfaced before acting (cure for #1 ritual cause)",
    command: ["node", join(TESTS_ROOT, "test_contract_preview.mjs")],
    fixtures: [
      skillRel("tests/test_contract_preview.mjs"),
      skillRel("scripts/lib/contract_preview.mjs"),
      skillRel("scripts/lib/determinism.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_contract_preview\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/contract_preview\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/determinism\.mjs$/,
    ],
  }),
  suite({
    id: "contract-reliability",
    category: "structured_plan",
    label: "Contract reliability: output, assumptions, claims, complaints, and project-local registry",
    command: ["node", join(TESTS_ROOT, "test_contract_reliability.mjs")],
    phases: ["contract-reliability", "generalized-reliability", "core.contracts"],
    surfaces: ["structured_plan", "contract_reliability", "traceability", "assumptions"],
    fixtures: [
      skillRel("tests/test_contract_reliability.mjs"),
      skillRel("scripts/contract_reliability.mjs"),
      skillRel("scripts/lib/contract_reliability.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_contract_reliability\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/contract_reliability\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/contract_reliability\.mjs$/,
      /^plans\/programs\/ive-contract-reliability-generalization\//,
    ],
  }),
  suite({
    id: "northstar-ui-dogfood",
    category: "projection",
    label: "North-Star UI dogfood: real verdict → cockpit payload (T-E14EBBAE)",
    command: ["node", join(TESTS_ROOT, "test_northstar_dogfood.mjs")],
    fixtures: [
      skillRel("tests/test_northstar_dogfood.mjs"),
      skillRel("scripts/lib/northstar_dogfood.mjs"),
      skillRel("scripts/lib/north_star_telemetry.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_northstar_dogfood\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/northstar_dogfood\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "capability-connectivity",
    category: "structured_plan",
    label: "Capability connectivity: no shelf-ware (T-25285668 AC1)",
    command: ["node", join(TESTS_ROOT, "test_capability_connectivity.mjs")],
    fixtures: [
      skillRel("tests/test_capability_connectivity.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
      skillRel("packs/quant/forecastability.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_capability_connectivity\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\//,
    ],
  }),
  suite({
    id: "mcp-connector-smoke",
    category: "test_coverage",
    label: "MCP/connector smoke parity: real stdio handshake over transport/auth/schema boundaries (T-INTAKE-9C223A3C)",
    command: ["node", join(TESTS_ROOT, "test_mcp_connector_smoke.mjs")],
    surfaces: ["mcp", "connector", "wiring"],
    fixtures: [
      skillRel("tests/test_mcp_connector_smoke.mjs"),
      skillRel("tests/fixtures/mcp_connector/happy_handshake.json"),
      skillRel("mcp_server.mjs"),
      skillRel("config/mcp_tools.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_mcp_connector_smoke\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/mcp_connector\//,
      /^\.agent\/skills\/iterative-planner\/mcp_server\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/mcp_tools\.json$/,
    ],
  }),
  suite({
    id: "annotation-discipline-gate",
    category: "structured_plan",
    label: "GATE-PLN-ANN-001 annotation discipline",
    command: ["node", join(TESTS_ROOT, "test_annotation_discipline_gate.mjs")],
    phases: ["stage1", "plan-to-execute", "annotation-discipline", "semantic-gates"],
    surfaces: ["structured_plan", "semantic_gate", "annotations"],
    fixtures: [
      skillRel("tests/test_annotation_discipline_gate.mjs"),
      skillRel("scripts/lib/annotation_discipline.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/annotation_parser.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_annotation_discipline_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/annotation_discipline\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/annotation_parser\.mjs$/,
    ],
  }),
  suite({
    id: "annotation-parser-cli-contract",
    category: "structured_plan",
    label: "Annotation parser combined JSON validation contract",
    command: ["node", join(TESTS_ROOT, "test_annotation_parser_cli.mjs")],
    phases: ["stage1", "annotation-parser", "cli-contract", "semantic-gates"],
    surfaces: ["planner_runtime", "annotations", "cli_transport", "validation"],
    fixtures: [
      skillRel("tests/test_annotation_parser_cli.mjs"),
      skillRel("scripts/annotation_parser.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_annotation_parser_cli\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/annotation_parser\.mjs$/,
    ],
  }),
  suite({
    id: "blast-radius-budget",
    category: "cli_contract",
    label: "Blast-radius mapper terminates and reports explicit partial completeness (US-008)",
    command: ["node", join(SCRIPTS_DIR, "blast_radius.mjs"), "--self-test"],
    phases: ["blast-radius-budget", "planner-core", "cli-contract"],
    surfaces: ["cli_contract", "planner_core", "traceability", "mcp"],
    fixtures: [
      skillRel("scripts/blast_radius.mjs"),
      skillRel("mcp_server.mjs"),
      skillRel("tests/ive/run.mjs"),
    ],
    changedFilePatterns: [
      exactRepoPathPattern(skillRel("scripts/blast_radius.mjs")),
      exactRepoPathPattern(skillRel("mcp_server.mjs")),
      exactRepoPathPattern(skillRel("tests/ive/run.mjs")),
    ],
    timeoutMs: 28000,
  }),
  suite({
    id: "autonomous-driver",
    category: "structured_plan",
    label: "t13 autonomous driver: executed-test gates block CLOSE",
    command: ["node", join(TESTS_ROOT, "test_autonomous_driver.mjs")],
    phases: ["stage2", "t13", "autonomous-driver", "semantic-gates"],
    surfaces: ["planner_runtime", "semantic_gate", "validation", "visualizer"],
    fixtures: [
      skillRel("tests/test_autonomous_driver.mjs"),
      skillRel("scripts/planner.mjs"),
      skillRel("scripts/autonomous_driver.mjs"),
      skillRel("scripts/lib/autonomous_driver.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/test_baseline.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_autonomous_driver\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/autonomous_driver\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/planner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/transition\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/autonomous_driver\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_capability_connectivity\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "advisor-task-intake-routing",
    category: "orchestration",
    label: "Advisor orchestration and proportional task-intake routing",
    command: ["node", join(TESTS_ROOT, "test_advise.mjs")],
    phases: ["advisor", "task-intake", "guidance-first", "semantic-gates"],
    surfaces: ["planner_core", "orchestration", "task_intake", "guidance_packet"],
    fixtures: [
      skillRel("tests/test_advise.mjs"),
      skillRel("scripts/advise.mjs"),
      skillRel("scripts/task_intake.mjs"),
      skillRel("scripts/planner_preflight.mjs"),
      skillRel("scripts/lib/planner_policy.mjs"),
      skillRel("scripts/lib/plan_shape.mjs"),
      skillRel("scripts/lib/task_focus_contract.mjs"),
      skillRel("scripts/lib/triage.mjs"),
      skillRel("scripts/lib/guidance_packet.mjs"),
      skillRel("scripts/lib/guidance_reminder.mjs"),
      skillRel("config/orchestrator_rules.yaml"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_advise\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(advise|task_intake|planner_preflight)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(planner_policy|plan_shape|task_focus_contract|triage|guidance_packet|guidance_reminder)\.mjs$/,
      /^planner\.policy\.yaml$/,
      /^\.agent\/skills\/iterative-planner\/config\/orchestrator_rules\.yaml$/,
      /^plans\/programs\/guidance-first\//,
    ],
  }),
  suite({
    id: "autonomous-verification-agents",
    category: "orchestration",
    label: "t14 AVA adversarial defect artifacts block CLOSE and surface in cockpit",
    command: ["node", join(TESTS_ROOT, "test_autonomous_verification_agents.mjs")],
    phases: ["stage4", "t14", "ava", "semantic-gates", "visualizer"],
    surfaces: ["planner_runtime", "semantic_gate", "ontology", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_autonomous_verification_agents.mjs"),
      skillRel("scripts/lib/autonomous_verification_agents.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("config/ontology_namespace.json"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_autonomous_verification_agents\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/autonomous_verification_agents\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/ontology_namespace\.json$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "scientific-artifact-review",
    category: "quant",
    label: "content-addressed semantic scientific reviewer and canonical evidence immutability",
    command: ["node", join(TESTS_ROOT, "test_scientific_review.mjs")],
    phases: ["scientific-review", "quant-results-validation", "semantic-gates"],
    surfaces: ["quant", "semantic_gate", "validation", "ontology"],
    fixtures: [
      skillRel("tests/test_scientific_review.mjs"),
      skillRel("tests/lib/scientific_fixture.mjs"),
      skillRel("scripts/lib/scientific_review.mjs"),
      skillRel("config/scientific_review_request.schema.json"),
      skillRel("config/scientific_evidence_artifact.schema.json"),
      skillRel("config/scientific_review_receipt.schema.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/(scripts\/lib\/scientific_.*\.mjs|config\/scientific_.*\.schema\.json|tests\/(test_scientific_review\.mjs|lib\/scientific_fixture\.mjs|fixtures\/scientific\/.*))$/,
    ],
  }),
  suite({
    id: "scientific-transition-gate",
    category: "quant",
    label: "scientific receipt separation and exact EXP-010 real transition rejection",
    command: ["node", join(TESTS_ROOT, "test_scientific_transition.mjs")],
    phases: ["scientific-review", "quant-results-validation", "transition"],
    surfaces: ["quant", "semantic_gate", "validation", "transition"],
    fixtures: [
      skillRel("tests/test_scientific_transition.mjs"),
      skillRel("scripts/lib/scientific_review.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("scripts/transition.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_scientific_transition\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(scientific_.*|quant_results_validation)\.mjs$/,
    ],
  }),
  suite({
    id: "quant-validation-retrofit",
    category: "structured_plan",
    label: "e03/e04 consumed by the live REFLECT/VALIDATE quant gate (connectivity)",
    command: ["node", join(TESTS_ROOT, "test_quant_validation_retrofit.mjs")],
    fixtures: [
      skillRel("tests/test_quant_validation_retrofit.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
      skillRel("packs/quant/forecastability.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_validation_retrofit\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\//,
    ],
  }),
  suite({
    id: "quant-leakage-artifact",
    category: "quant",
    label: "t08 artifact-backed leakage/temporal split proof",
    command: ["node", join(TESTS_ROOT, "test_leakage_proof.mjs")],
    phases: ["stage1", "t08", "quant-results-validation", "semantic-gates"],
    surfaces: ["quant", "semantic_gate", "validation", "proof_telemetry", "ontology", "visualizer"],
    fixtures: [
      skillRel("tests/test_leakage_proof.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("scripts/lib/proof_telemetry.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_leakage_proof\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_proof_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/leakage_proof\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/proof_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-archetype-accomplices",
    category: "quant",
    label: "e06 archetype accomplices and residual scope-gap PLAN reopen",
    command: ["node", join(TESTS_ROOT, "test_archetype_accomplices.mjs")],
    phases: ["stage1", "e06", "quant-results-validation", "visualizer"],
    surfaces: ["quant", "semantic_gate", "validation", "bootstrap", "ontology", "visualizer"],
    fixtures: [
      skillRel("tests/test_archetype_accomplices.mjs"),
      skillRel("tests/test_quant_results_validation.mjs"),
      skillRel("packs/quant/archetype_accomplices.mjs"),
      skillRel("packs/quant/index.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_archetype_accomplices\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_archetype_accomplice_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/archetype_accomplices\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/index\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-betting-market",
    category: "quant",
    label: "t10 betting-market de-vig, rating, Markov, and sports sample-floor gate",
    command: ["node", join(TESTS_ROOT, "test_betting_market_conformance.mjs")],
    phases: ["stage1", "t10", "quant-results-validation", "visualizer"],
    surfaces: ["quant", "semantic_gate", "validation", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_betting_market_conformance.mjs"),
      skillRel("tests/test_quant_results_validation.mjs"),
      skillRel("packs/quant/betting_market.mjs"),
      skillRel("packs/quant/index.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_betting_market_pack\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_betting_market_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/betting_market\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/index\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-crypto-execution",
    category: "quant",
    label: "t11 crypto execution realism funding, liquidation, cost, slippage, and venue gate",
    command: ["node", join(TESTS_ROOT, "test_crypto_execution_conformance.mjs")],
    phases: ["stage1", "t11", "quant-results-validation", "visualizer"],
    surfaces: ["quant", "semantic_gate", "validation", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_crypto_execution_conformance.mjs"),
      skillRel("tests/test_quant_results_validation.mjs"),
      skillRel("packs/quant/crypto_execution.mjs"),
      skillRel("packs/quant/index.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_crypto_execution_pack\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_crypto_execution_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/crypto_execution\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/index\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "tokenomics-arithmetic-gate",
    category: "tokenomics",
    label: "t12 tokenomics arithmetic, Prolog, runtime gate, and visualizer surface",
    command: ["node", join(TESTS_ROOT, "test_tokenomics_conformance.mjs")],
    phases: ["stage1", "t12", "tokenomics", "semantic-gates", "visualizer"],
    surfaces: ["tokenomics", "semantic_gate", "ontology", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_tokenomics_conformance.mjs"),
      skillRel("packs/tokenomics/index.mjs"),
      skillRel("packs/tokenomics/rules.pl"),
      skillRel("scripts/audit_runner.mjs"),
      skillRel("config/gates.json"),
      skillRel("config/ontology_namespace.json"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_tokenomics_pack\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_tokenomics_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/tokenomics\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/audit_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/(gates|ontology_namespace)\.json$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-forecastability-pregates",
    category: "structured_plan",
    label: "Quant forecastability & data-quality pre-gates (e04)",
    command: ["node", join(TESTS_ROOT, "test_forecastability.mjs")],
    fixtures: [
      skillRel("tests/test_forecastability.mjs"),
      skillRel("packs/quant/forecastability.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_forecastability\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/forecastability\.mjs$/,
    ],
  }),
  suite({
    id: "quant-calibration-gate",
    category: "structured_plan",
    label: "Quant calibration bands + impossibility gate (e03)",
    command: ["node", join(TESTS_ROOT, "test_calibration_gate.mjs")],
    fixtures: [
      skillRel("tests/test_calibration_gate.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
      skillRel("packs/quant/calibration.json"),
      skillRel("packs/quant/rules.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_calibration_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\//,
    ],
  }),
  suite({
    id: "research-memory-packet-e2e",
    category: "quant",
    label: "Research Memory Packet validity seam ingest-route-rank-gate e2e",
    command: ["node", join(TESTS_ROOT, "test_research_memory_packet.mjs")],
    phases: ["research-memory-packet-e2e", "research-memory", "quant-results-validation", "semantic-gates"],
    surfaces: ["quant", "validation", "structured_plan", "active_ontology"],
    fixtures: [
      skillRel("tests/test_research_memory_packet.mjs"),
      skillRel("scripts/lib/research_validity_binding.mjs"),
      skillRel("scripts/lib/research_memory_packet.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
      skillRel("packs/quant/forecastability.mjs"),
      "docs/ive-redesign/research_memory_packets.md",
      "plans/programs/ive-ontology-memory/program_packet.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_research_memory_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/research_validity_binding\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/research_memory_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/(leakage_proof|calibration_gate|forecastability)\.mjs$/,
      docsIvePattern("research_memory_packets.md"),
      /^plans\/programs\/ive-ontology-memory\/program_packet\.json$/,
    ],
  }),
  suite({
    id: "phase-authority-contracts",
    category: "loop_guard",
    label: "Phase authority and loop guard contracts",
    command: ["node", join(TESTS_ROOT, "test_phase_authority_contract.mjs")],
    fixtures: [skillRel("tests/test_phase_authority_contract.mjs")],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_phase_authority_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/planner_phase_routing\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
    ],
  }),
  suite({
    id: "structural-contracts",
    category: "structural",
    label: "IVE structural gate, namespace, doc, and version contracts",
    command: ["node", join(TESTS_ROOT, "test_t16_structural_contracts.mjs")],
    phases: ["stage1", "structural", "t16"],
    surfaces: ["gate_registry", "ontology", "doc_contract", "migration", "version"],
    fixtures: [
      skillRel("tests/test_t16_structural_contracts.mjs"),
      skillRel("scripts/lib/gate_registry.mjs"),
      skillRel("scripts/ontology_namespace_check.mjs"),
      skillRel("config/ontology_namespace.json"),
      skillRel("prolog/transitions.pl"),
      skillRel("config/gates.json"),
      skillRel("config/version.json"),
      skillRel("MIGRATION.md"),
      "docs/ive-redesign/15_multi_ide_portability.md",
      "docs/ive-redesign/16_multi_ide_portability.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_t16_structural_contracts\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/gate_registry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_namespace_check\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/ontology_namespace\.json$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/transitions\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
      /^\.agent\/skills\/iterative-planner\/config\/version\.json$/,
      /^\.agent\/skills\/iterative-planner\/MIGRATION\.md$/,
      docsIvePattern("15_multi_ide_portability.md"),
      docsIvePattern("16_multi_ide_portability.md"),
    ],
  }),
  suite({
    id: "doc-contract-mvp",
    category: "doc_contract",
    label: "Visualizer MVP doc contract",
    command: [
      "grep",
      "-cE",
      "^### (MVP Scope|Proof Plan|Data Contract|No-Direct-Write Rule)\\s*$",
      join(REPO_ROOT, "docs/ive-redesign/08_visualizer_ui.md"),
    ],
    run: runDocContractCheck,
    fixtures: ["docs/ive-redesign/08_visualizer_ui.md"],
    changedFilePatterns: [docsIvePattern("08_visualizer_ui.md")],
  }),
  suite({
    id: "doc-contract-multi-ide",
    category: "doc_contract",
    label: "Multi-IDE portability doc contract",
    command: [
      "grep",
      "-cE",
      "^## (Source Of Truth|Portability Matrix|Managed Snapshot Rule|Update Workflow|Trace Behavior|False-Green Guards|Verification Checklist)\\s*$",
      join(REPO_ROOT, "docs/ive-redesign/16_multi_ide_portability.md"),
    ],
    run: runDocContractCheck,
    fixtures: ["docs/ive-redesign/16_multi_ide_portability.md"],
    changedFilePatterns: [docsIvePattern("16_multi_ide_portability.md")],
  }),
  suite({
    id: "workflow-disposition-contract",
    category: "doc_contract",
    label: "Workflow migration dispositions govern active, parked, and fleet-managed surfaces",
    command: ["node", join(TESTS_ROOT, "test_workflow_disposition_contract.mjs")],
    phases: ["h1", "docs-integrity", "workflow-disposition"],
    surfaces: ["config", "migration", "doc_contract", "workflow"],
    fixtures: [
      skillRel("tests/test_workflow_disposition_contract.mjs"),
      skillRel("scripts/lib/workflow_contracts.mjs"),
      skillRel("scripts/workflow.mjs"),
      skillRel("config/workflow_migration_inventory.json"),
      ".agent/_parked/sidekick.md",
      "reports/workflow_migration_inventory.yaml",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_workflow_disposition_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/workflow_contracts\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/workflow\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/workflow_migration_inventory\.json$/,
      /^\.agent\/(?:workflows|_parked)\/[^/]+\.md$/,
      /^reports\/workflow_migration_inventory\.yaml$/,
    ],
  }),
  suite({
    id: "docs-contracts",
    category: "doc_contract",
    label: "Combined IVE doc contracts",
    command: ["node", join(TEST_DIR, "run.mjs"), "--only", "doc-contract-mvp", "--only", "doc-contract-multi-ide", "--only", "workflow-disposition-contract", "--json"],
    run: runDocsContractsAggregate,
    fixtures: [
      "docs/ive-redesign/08_visualizer_ui.md",
      "docs/ive-redesign/16_multi_ide_portability.md",
      skillRel("tests/test_workflow_disposition_contract.mjs"),
      skillRel("scripts/lib/workflow_contracts.mjs"),
      skillRel("scripts/workflow.mjs"),
      skillRel("config/workflow_migration_inventory.json"),
      ".agent/_parked/sidekick.md",
      "reports/workflow_migration_inventory.yaml",
    ],
    changedFilePatterns: [
      /^docs\/ive-redesign\//,
      /^\.agent\/skills\/iterative-planner\/tests\/test_workflow_disposition_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/workflow_contracts\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/workflow\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/workflow_migration_inventory\.json$/,
      /^\.agent\/(?:workflows|_parked)\/[^/]+\.md$/,
      /^reports\/workflow_migration_inventory\.yaml$/,
    ],
  }),
  suite({
    id: "visualizer-contract-bridge-guard",
    category: "visualizer",
    label: "IVE Visualizer contract, bridge, and no-direct-write checks",
    command: ["npm", "--prefix", join(REPO_ROOT, "apps", "ive-visualizer"), "test"],
    phases: ["2.6b", "5", "dashboard", "visualizer"],
    surfaces: ["visualizer", "dashboard", "bridge", "browser"],
    fixtures: [
      "apps/ive-visualizer/package.json",
      "apps/ive-visualizer/scripts/graph-payload-check.mjs",
      "apps/ive-visualizer/scripts/live-payload-check.mjs",
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/scripts/bridge-parity-check.mjs",
      "apps/ive-visualizer/scripts/no-direct-write-check.mjs",
      "apps/ive-visualizer/scripts/path-portability-check.mjs",
      "apps/ive-visualizer/src/lib/dashboardBridge.js",
      "apps/ive-visualizer/src/lib/graphPayloadContract.js",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/public/ive-graph-payload.json",
    ],
    changedFilePatterns: [
      /^apps\/ive-visualizer\//,
      /^public\/ive-graph-payload\.json$/,
      docsIvePattern("08_visualizer_ui.md"),
      docsIvePattern("15_visualizer_mvp.md"),
    ],
  }),
  suite({
    id: "visualizer-browser-proof",
    category: "visualizer",
    label: "IVE Visualizer browser screenshots and accessibility",
    command: [visualizerPlaywrightBin(REPO_ROOT), "test", "--config=playwright.config.mjs"],
    run: runVisualizerBrowserProof,
    phases: ["2.6b", "5", "dashboard", "visualizer"],
    surfaces: ["visualizer", "dashboard", "browser"],
    fixtures: [
      "apps/ive-visualizer/package.json",
      "apps/ive-visualizer/scripts/run-playwright.mjs",
      "apps/ive-visualizer/playwright.config.mjs",
      "apps/ive-visualizer/tests/visualizer-smoke.spec.mjs",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
      "apps/ive-visualizer/src/App.jsx",
      "apps/ive-visualizer/src/styles.css",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/public/ive-graph-payload.json",
      "plans/programs/guidance-first/program_packet.json",
    ],
    changedFilePatterns: [
      /^apps\/ive-visualizer\//,
      /^plans\/programs\/guidance-first\/program_packet\.json$/,
      docsIvePattern("08_visualizer_ui.md"),
      docsIvePattern("15_visualizer_mvp.md"),
    ],
  }),
  suite({
    id: "frontend-journey-conformance",
    category: "test_coverage",
    label: "Browser/frontend automation conformance journey (T-INTAKE-2C7A79A9)",
    command: ["node", join(TESTS_ROOT, "test_frontend_journey_conformance.mjs")],
    surfaces: ["frontend", "ux_ui", "browser"],
    fixtures: [
      skillRel("tests/test_frontend_journey_conformance.mjs"),
      skillRel("tests/fixtures/frontend_journey/dashboard.html"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_frontend_journey_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/frontend_journey\//,
    ],
  }),
  suite({
    id: "ripple-check",
    category: "ripple",
    label: "Planner ripple check",
    command: ["node", join(SCRIPTS_DIR, "ripple_check.mjs")],
    fixtures: [skillRel("scripts/ripple_check.mjs")],
    changedFilePatterns: [/^\.agent\/skills\/iterative-planner\//, /^docs\/ive-redesign\//],
  }),
  suite({
    id: "workspace-artifact-inventory",
    category: "cli_contract",
    label: "Workspace artifact inventory: read-only registry and source-project proof",
    command: ["node", join(TESTS_ROOT, "test_workspace_artifact_inventory.mjs")],
    phases: ["workspace-artifact-inventory", "core.workspace-inventory", "registry-inventory", "planner-core"],
    surfaces: ["workspace_inventory", "registry", "planner_core", "cli_contract"],
    fixtures: [
      skillRel("tests/test_workspace_artifact_inventory.mjs"),
      skillRel("scripts/workspace_artifact_inventory.mjs"),
      skillRel("scripts/lib/workspace_artifact_inventory.mjs"),
      skillRel("config/.project_registry.json"),
      skillRel("references/scripts_registry.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_workspace_artifact_inventory\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/workspace_artifact_inventory\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/workspace_artifact_inventory\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/\.project_registry\.json$/,
      /^\.agent\/skills\/iterative-planner\/references\/scripts_registry\.md$/,
    ],
  }),
  suite({
    id: "core-packet-contract",
    category: "structured_plan",
    label: "IVE packet contract",
    command: ["node", join(TESTS_ROOT, "test_ive_packet_contract.mjs")],
    phases: ["core.packet-contract"],
    fixtures: [
      skillRel("tests/test_ive_packet_contract.mjs"),
      skillRel("scripts/lib/ive_packet_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_packet_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_packet_contract\.mjs$/,
    ],
  }),
  suite({
    id: "work-order-contract",
    category: "structured_plan",
    label: "Work-order schema and deterministic validator",
    command: ["node", join(TESTS_ROOT, "test_work_order_contract.mjs")],
    phases: ["core.work-order-contract", "autocoder-v2"],
    surfaces: ["structured_plan", "contract_language", "work_order", "planner_core"],
    fixtures: [
      skillRel("config/work_order.schema.json"),
      skillRel("tests/test_work_order_contract.mjs"),
      skillRel("tests/fixtures/work_orders/golden.basic.json"),
      skillRel("tests/fixtures/work_orders/golden.recipe-profile.json"),
      skillRel("tests/fixtures/work_orders/invalid.recipe-profile-missing-dry-run.json"),
      skillRel("scripts/work_order_validate.mjs"),
      skillRel("scripts/lib/work_order_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/config\/work_order\.schema\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_work_order_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/work_orders\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/work_order_validate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/work_order_contract\.mjs$/,
    ],
  }),
  suite({
    id: "plan-artifact-renderer",
    category: "projection",
    label: "Plan artifact JSON renderer and migration measurement",
    command: ["node", join(TESTS_ROOT, "test_plan_artifact_renderer.mjs")],
    phases: ["core.plan-artifact-renderer", "projection", "autocoder-v2", "e8-x"],
    surfaces: ["projection", "structured_plan", "planner_core", "migration"],
    fixtures: [
      skillRel("tests/test_plan_artifact_renderer.mjs"),
      skillRel("scripts/plan_artifact_renderer.mjs"),
      skillRel("scripts/lib/plan_artifact_renderer.mjs"),
      skillRel("scripts/lib/plan_contract.mjs"),
      skillRel("scripts/lib/plan_utils.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_plan_artifact_renderer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/plan_artifact_renderer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/plan_artifact_renderer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/transition\.mjs$/,
    ],
  }),
  suite({
    id: "recipe-promotion",
    category: "structured_plan",
    label: "E4-8 recipe promotion: repeatable operational flow to confirmed recipe draft",
    command: ["node", join(TESTS_ROOT, "test_recipe_promotion.mjs")],
    phases: ["core.recipe-promotion", "recipe-promotion", "e4-8", "action-layer-maturity", "autocoder-v2"],
    surfaces: ["structured_plan", "recipe", "close_signals", "journal_telemetry", "orchestration", "planner_core"],
    fixtures: [
      skillRel("tests/test_recipe_promotion.mjs"),
      skillRel("scripts/lib/recipe_promotion.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/close_signals.mjs"),
      skillRel("scripts/recipe_bootstrap.mjs"),
      skillRel("scripts/recipe_validate.mjs"),
      skillRel("scripts/lib/recipe_utils.mjs"),
      skillRel("scripts/lib/agent_journal.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_recipe_promotion\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/recipe_promotion\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/plan_refresh\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/close_signals\.mjs$/,
      /^plans\/knowledge\/agent_journal\.jsonl$/,
      /^plans\/plan_[^/]+\/telemetry\/events\.jsonl$/,
    ],
  }),
  suite({
    id: "evidence-preflight",
    category: "structured_plan",
    label: "Read-only evidence preflight for hotspot transition gates",
    command: ["node", join(TESTS_ROOT, "test_evidence_preflight.mjs")],
    phases: ["evidence-preflight", "gate-hotspots", "ritual-reduction", "planner-core"],
    surfaces: ["evidence_preflight", "transition_gates", "close_signals", "verification_matrix", "planner_core"],
    fixtures: [
      skillRel("tests/test_evidence_preflight.mjs"),
      skillRel("scripts/evidence_preflight.mjs"),
      skillRel("scripts/lib/evidence_preflight.mjs"),
      skillRel("scripts/lib/verification_matrix.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("references/scripts_registry.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_evidence_preflight\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/evidence_preflight\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/evidence_preflight\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/verification_matrix\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/references\/scripts_registry\.md$/,
    ],
  }),
  suite({
    id: "preplanning-scaffolding",
    category: "structured_plan",
    label: "Pre-planning scaffold gate for North Star, story registry, and Program Packet context",
    command: ["node", join(TESTS_ROOT, "test_preplanning_scaffolding.mjs")],
    phases: ["preplanning-scaffolding", "planner-core", "ritual-reduction", "traceability"],
    surfaces: ["transition", "preplanning_scaffolding", "story_registry", "program_manager", "north_star", "planner_core"],
    fixtures: [
      skillRel("tests/test_preplanning_scaffolding.mjs"),
      skillRel("scripts/lib/preplanning_scaffolding.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/lib/plan_utils.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/story_registry.mjs"),
      skillRel("config/failure-codes.json"),
      skillRel("SKILL.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_preplanning_scaffolding\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/preplanning_scaffolding\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/transition\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/plan_utils\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/plan_refresh\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/story_registry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/failure-codes\.json$/,
      /^\.agent\/skills\/iterative-planner\/SKILL\.md$/,
    ],
  }),
  suite({
    id: "incident-contract",
    category: "structured_plan",
    label: "Incident rectification contract: front door, preflight registry, and fail-closed closeout",
    command: ["node", join(TESTS_ROOT, "test_incident_contract.mjs")],
    phases: ["incident-contract", "planner-core", "quant", "orchestration"],
    surfaces: ["incident_contract", "evidence_preflight", "verify_gate", "retro", "advisor"],
    fixtures: [
      skillRel("tests/test_incident_contract.mjs"),
      skillRel("scripts/incident_contract.mjs"),
      skillRel("scripts/lib/incident_contract.mjs"),
      skillRel("config/incident_preflight_plugins.json"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/lib/evidence_preflight.mjs"),
      ".agent/workflows/retro.md",
      ".agent/workflows/advisor.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_incident_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/incident_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/incident_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/incident_preflight_plugins\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/evidence_preflight\.mjs$/,
      /^\.agent\/workflows\/(retro|advisor)\.md$/,
    ],
  }),
  suite({
    id: "pack-contract",
    category: "structured_plan",
    label: "Reusable pack contract schema and CI enforcement",
    command: ["node", join(TESTS_ROOT, "test_pack_contract.mjs")],
    phases: ["core.pack-contract", "pack-contract", "e5-2", "autocoder-v2"],
    surfaces: ["contract_language", "persona_packs", "pack_contract", "ci", "planner_core"],
    fixtures: [
      skillRel("config/pack_contract.schema.json"),
      skillRel("tests/test_pack_contract.mjs"),
      skillRel("tests/fixtures/pack_contract/goldens.json"),
      skillRel("tests/fixtures/pack_contract/seeded_defects.json"),
      skillRel("tests/fixtures/pack_contract/incomplete_pack/pack_contract.json"),
      skillRel("scripts/pack_contract_validate.mjs"),
      skillRel("scripts/lib/pack_contract.mjs"),
      skillRel("packs/_template/README.md"),
      skillRel("packs/app_dev_tesseract/pack_contract.json"),
      skillRel("packs/quant/pack_contract.json"),
      skillRel("packs/quant_target/pack_contract.json"),
      skillRel("packs/tokenomics/pack_contract.json"),
      skillRel("packs/ux_ui/pack_contract.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/config\/pack_contract\.schema\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_pack_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/pack_contract\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/pack_contract_validate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/pack_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/_template\/README\.md$/,
      /^\.agent\/skills\/iterative-planner\/packs\/(app_dev_tesseract|quant|quant_target|tokenomics|ux_ui)\/pack_contract\.json$/,
    ],
  }),
  suite({
    id: "app-dev-tesseract-pack",
    category: "knowledge_pack",
    label: "App-dev tesseract pack checker, seeded defects, and loader activation",
    command: ["node", join(TESTS_ROOT, "test_app_dev_tesseract_pack.mjs")],
    phases: ["core.app-dev-tesseract-pack", "app-dev-tesseract", "e5-4", "autocoder-v2"],
    surfaces: ["knowledge_pack", "pack_contract", "app_dev", "seeded_defects", "planner_core"],
    fixtures: [
      skillRel("tests/test_app_dev_tesseract_pack.mjs"),
      skillRel("scripts/app_dev_tesseract_check.mjs"),
      skillRel("scripts/lib/app_dev_tesseract_pack.mjs"),
      skillRel("knowledge_packs/app_dev_tesseract/pack.json"),
      skillRel("knowledge_packs/app_dev_tesseract/pitfalls.json"),
      skillRel("knowledge_packs/app_dev_tesseract/constraints.json"),
      skillRel("knowledge_packs/app_dev_tesseract/obligations.json"),
      skillRel("knowledge_packs/app_dev_tesseract/calibration.json"),
      skillRel("packs/app_dev_tesseract/pack_contract.json"),
      skillRel("tests/fixtures/pack_contract/goldens.json"),
      skillRel("tests/fixtures/pack_contract/seeded_defects.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_app_dev_tesseract_pack\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/app_dev_tesseract_check\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/app_dev_tesseract_pack\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/knowledge_packs\/app_dev_tesseract\//,
      /^\.agent\/skills\/iterative-planner\/packs\/app_dev_tesseract\/pack_contract\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/pack_contract\//,
    ],
  }),
  suite({
    id: "recipe-contract",
    category: "structured_plan",
    label: "Recipe contract: read compatibility, promoted work-order profile, and dry-run fail-closed runner",
    command: ["node", join(TESTS_ROOT, "test_recipe_validate.mjs")],
    phases: ["core.recipe-contract", "recipe-contract", "e3-6", "autocoder-v2"],
    surfaces: ["structured_plan", "contract_language", "recipe", "work_order", "orchestration", "planner_core"],
    fixtures: [
      skillRel("tests/test_recipe_validate.mjs"),
      skillRel("tests/fixtures/recipes/canonical/recipes/sample-flow/recipe.json"),
      skillRel("tests/fixtures/recipes/legacy/recipes/legacy-python/runner.json"),
      skillRel("tests/fixtures/recipes/legacy/recipes/legacy-string-runner/runner.json"),
      skillRel("tests/fixtures/recipes/discovery_review/recipes/discovery_review.json"),
      skillRel("scripts/recipe_validate.mjs"),
      skillRel("scripts/recipe_runner.mjs"),
      skillRel("scripts/recipe_bootstrap.mjs"),
      skillRel("scripts/recipe_discovery.mjs"),
      skillRel("scripts/planner.mjs"),
      skillRel("scripts/lib/recipe_utils.mjs"),
      skillRel("scripts/lib/work_order_contract.mjs"),
      skillRel("config/work_order.schema.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_recipe_validate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/recipes\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/recipe_(validate|runner|bootstrap|discovery|resolver)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/planner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/recipe_utils\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/work_order_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/work_order\.schema\.json$/,
    ],
  }),
  suite({
    id: "recipe-resolver",
    category: "structured_plan",
    label: "E6-7 recipe-first ranked resolver and legacy side-by-side proof",
    command: ["node", join(TESTS_ROOT, "test_recipe_resolver.mjs")],
    phases: ["core.recipe-resolver", "recipe-resolver", "e6-7", "autocoder-v2"],
    surfaces: ["structured_plan", "recipe", "resolver", "ranked_retrieval", "orchestration", "planner_core"],
    fixtures: [
      skillRel("tests/test_recipe_resolver.mjs"),
      skillRel("scripts/recipe_resolver.mjs"),
      skillRel("scripts/recipe_runner.mjs"),
      skillRel("scripts/lib/recipe_utils.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_recipe_resolver\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/recipe_(resolver|runner)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/recipe_utils\.mjs$/,
    ],
  }),
  suite({
    id: "reuse-before-create-gate",
    category: "structured_plan",
    label: "E6-8 reuse-before-create gate and duplicate capability guard",
    command: ["node", join(TESTS_ROOT, "test_reuse_before_create_gate.mjs")],
    phases: ["core.reuse-before-create", "reuse-before-create", "e6-8", "autocoder-v2"],
    surfaces: ["structured_plan", "recipe", "reuse_gate", "orchestration", "planner_core"],
    fixtures: [
      skillRel("tests/test_reuse_before_create_gate.mjs"),
      skillRel("tests/test_transition_gate_flows.mjs"),
      skillRel("tests/fixtures/recipe_fleet/alpha_project/recipes/daily-runner/recipe.json"),
      skillRel("tests/fixtures/recipe_fleet/beta_project/recipes/daily-runner/recipe.json"),
      skillRel("scripts/reuse_before_create.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/lib/reuse_before_create_gate.mjs"),
      skillRel("scripts/lib/recipe_utils.mjs"),
      skillRel("scripts/recipe_fleet_audit.mjs"),
      skillRel("config/failure-codes.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_reuse_before_create_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_transition_gate_flows\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/recipe_fleet\/(alpha|beta)_project\/recipes\/daily-runner\/recipe\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/reuse_before_create\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/reuse_before_create_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/recipe_utils\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/recipe_fleet_audit\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/failure-codes\.json$/,
    ],
  }),
  suite({
    id: "claims-evidence-contract",
    category: "structured_plan",
    label: "Claims/evidence schema, receipt projection, and bounce protocol",
    command: ["node", join(TESTS_ROOT, "test_claims_evidence_contract.mjs")],
    phases: ["core.claims-evidence-contract", "autocoder-v2"],
    surfaces: ["structured_plan", "contract_language", "claims_evidence", "receipt", "planner_core"],
    fixtures: [
      skillRel("config/claims_evidence.schema.json"),
      skillRel("tests/test_claims_evidence_contract.mjs"),
      skillRel("tests/fixtures/claims_evidence/golden.basic.json"),
      skillRel("scripts/claims_evidence_validate.mjs"),
      skillRel("scripts/lib/claims_evidence_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/config\/claims_evidence\.schema\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_claims_evidence_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/claims_evidence\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/claims_evidence_validate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/claims_evidence_contract\.mjs$/,
    ],
  }),
  suite({
    id: "claim-briefing-compiler",
    category: "structured_plan",
    label: "E6-2 claim compiler: work-order to closed-question briefing",
    command: ["node", join(TESTS_ROOT, "test_claim_briefing_compiler.mjs")],
    phases: ["core.claim-briefing-compiler", "claim-briefing-compiler", "e6-2", "autocoder-v2"],
    surfaces: ["structured_plan", "contract_language", "claim_briefing", "work_order", "pack_contract", "persona_execute", "planner_core"],
    fixtures: [
      skillRel("config/claim_briefing.schema.json"),
      skillRel("tests/test_claim_briefing_compiler.mjs"),
      skillRel("tests/fixtures/work_orders/golden.claim-briefing.json"),
      skillRel("scripts/persona_execute.mjs"),
      skillRel("scripts/lib/claim_briefing_compiler.mjs"),
      skillRel("scripts/lib/work_order_contract.mjs"),
      skillRel("scripts/lib/pack_contract.mjs"),
      skillRel("packs/app_dev_tesseract/pack_contract.json"),
      skillRel("packs/quant/pack_contract.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/config\/claim_briefing\.schema\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_claim_briefing_compiler\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/work_orders\/golden\.claim-briefing\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/persona_execute\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/claim_briefing_compiler\.mjs$/,
    ],
  }),
  suite({
    id: "rubric-admin-runner",
    category: "structured_plan",
    label: "E6-3 rubric administrator runner and sycophancy suite",
    command: ["node", join(TESTS_ROOT, "test_rubric_admin_runner.mjs")],
    phases: ["core.rubric-admin-runner", "rubric-admin-runner", "e6-3", "autocoder-v2"],
    surfaces: ["structured_plan", "rubric_admin", "sycophancy", "claim_briefing", "claims_evidence", "role_provider", "planner_core"],
    fixtures: [
      skillRel("tests/test_rubric_admin_runner.mjs"),
      skillRel("tests/fixtures/rubric_admin/sycophancy_suite.json"),
      skillRel("scripts/rubric_admin_runner.mjs"),
      skillRel("scripts/lib/rubric_admin_runner.mjs"),
      skillRel("scripts/lib/claim_briefing_compiler.mjs"),
      skillRel("scripts/lib/claims_evidence_contract.mjs"),
      skillRel("scripts/lib/role_provider_runtime.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_rubric_admin_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/rubric_admin\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/rubric_admin_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/rubric_admin_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/dispatcher_v1\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(claim_briefing_compiler|claims_evidence_contract|role_provider_runtime)\.mjs$/,
    ],
  }),
  suite({
    id: "delivery-receipt-assembler",
    category: "structured_plan",
    label: "E6-4 delivery receipt assembler, dispute escalation, and scoreboard telemetry",
    command: ["node", join(TESTS_ROOT, "test_delivery_receipt_assembler.mjs")],
    phases: ["core.delivery-receipt-assembler", "delivery-receipt-assembler", "e6-4", "autocoder-v2"],
    surfaces: ["structured_plan", "receipt", "delivery_receipt", "claims_evidence", "rubric_admin", "escalation_protocol", "role_provider", "scoreboard", "planner_core"],
    fixtures: [
      skillRel("tests/test_delivery_receipt_assembler.mjs"),
      skillRel("tests/fixtures/delivery_receipt/e6_4.dispute.json"),
      skillRel("scripts/delivery_receipt_assemble.mjs"),
      skillRel("scripts/lib/delivery_receipt_assembler.mjs"),
      skillRel("scripts/lib/claims_evidence_contract.mjs"),
      skillRel("scripts/lib/escalation_protocol.mjs"),
      skillRel("scripts/lib/role_provider_runtime.mjs"),
      skillRel("scripts/lib/scoreboard.mjs"),
      "docs/autocoder-delivery-receipts.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_delivery_receipt_assembler\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/delivery_receipt\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/delivery_receipt_assemble\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/delivery_receipt_assembler\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/dispatcher_v1\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(claims_evidence_contract|escalation_protocol|role_provider_runtime|scoreboard)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/claims_evidence\.schema\.json$/,
      /^docs\/autocoder-delivery-receipts\.md$/,
    ],
  }),
  suite({
    id: "dispatcher-v1",
    category: "structured_plan",
    label: "E6-5 dispatcher v1 end-to-end cheap-agent receipt proof",
    command: ["node", join(TESTS_ROOT, "test_dispatcher_v1.mjs")],
    phases: ["core.dispatcher-v1", "dispatcher-v1", "e6-5", "e6-7", "autocoder-v2"],
    surfaces: ["structured_plan", "dispatcher", "work_order", "claim_briefing", "rubric_admin", "delivery_receipt", "ab_task_benchmark", "role_provider", "recipe", "planner_core"],
    fixtures: [
      skillRel("tests/test_dispatcher_v1.mjs"),
      skillRel("tests/fixtures/real_episodes/mac_mini_quant_episodes.json"),
      skillRel("scripts/dispatcher_v1.mjs"),
      skillRel("scripts/recipe_runner.mjs"),
      skillRel("scripts/lib/dispatcher_v1.mjs"),
      skillRel("scripts/lib/recipe_utils.mjs"),
      skillRel("scripts/lib/work_order_contract.mjs"),
      skillRel("scripts/lib/claim_briefing_compiler.mjs"),
      skillRel("scripts/lib/rubric_admin_runner.mjs"),
      skillRel("scripts/lib/delivery_receipt_assembler.mjs"),
      skillRel("scripts/lib/ab_task_benchmark.mjs"),
      "docs/autocoder-dispatcher-v1.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_dispatcher_v1\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/dispatcher_v1\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/recipe_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/dispatcher_v1\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/recipe_utils\.mjs$/,
      /^docs\/autocoder-dispatcher-v1\.md$/,
    ],
  }),
  suite({
    id: "presentation-contract",
    category: "structured_plan",
    label: "Presentation contract: verbatim render surfaces and write-authority matrix",
    command: ["node", join(TESTS_ROOT, "test_presentation_contract.mjs")],
    phases: ["core.presentation-contract", "presentation-contract", "e3-5", "autocoder-v2"],
    surfaces: ["structured_plan", "contract_language", "presentation_contract", "write_authority", "planner_core"],
    fixtures: [
      skillRel("config/presentation_contract.schema.json"),
      skillRel("tests/test_presentation_contract.mjs"),
      skillRel("tests/fixtures/work_orders/golden.basic.json"),
      skillRel("tests/fixtures/claims_evidence/golden.basic.json"),
      skillRel("scripts/lib/presentation_contract.mjs"),
      skillRel("scripts/lib/claims_evidence_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/config\/presentation_contract\.schema\.json$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_presentation_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/presentation_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/claims_evidence_contract\.mjs$/,
    ],
  }),
  suite({
    id: "verification-truth",
    category: "structured_plan",
    label: "Structured verification status truth for close gates",
    command: ["node", join(TESTS_ROOT, "test_verification_truth.mjs")],
    phases: ["core.verification-truth", "verification-truth", "close-truth"],
    surfaces: ["verification_truth", "verification_md", "ontology_serializer", "fact_loader", "rule_engine", "planner_core"],
    fixtures: [
      skillRel("tests/test_verification_truth.mjs"),
      skillRel("config/verification_status_vocabulary.json"),
      skillRel("config/proof_status_reader_census.json"),
      skillRel("config/mcp_tools.json"),
      skillRel("scripts/proof_status_census.mjs"),
      skillRel("scripts/hooks/pre_push_conformance.mjs"),
      skillRel("scripts/lib/verification_truth.mjs"),
      skillRel("scripts/lib/verification_status_vocabulary.mjs"),
      skillRel("scripts/lib/verification_strategy.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/ontology_serializer.mjs"),
      skillRel("scripts/lib/rule_commands.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("prolog/transitions.pl"),
      skillRel("prolog/verification_statuses.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_verification_truth\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/verification_status_vocabulary\.json$/,
      /^\.agent\/skills\/iterative-planner\/config\/proof_status_reader_census\.json$/,
      /^\.agent\/skills\/iterative-planner\/config\/mcp_tools\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/proof_status_census\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/hooks\/pre_push_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/verification_truth\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/verification_status_vocabulary\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/verification_strategy\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_serializer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/rule_commands\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/verification_statuses\.pl$/,
    ],
  }),
  suite({
    id: "escalation-protocol",
    category: "structured_plan",
    label: "E3-4 escalation protocol: schema bounce, verifier disagreement, budget stop, and telemetry",
    command: ["node", join(TESTS_ROOT, "test_escalation_protocol.mjs")],
    phases: ["core.escalation-protocol", "escalation-protocol", "e3-4", "autocoder-v2"],
    surfaces: ["structured_plan", "escalation_protocol", "provider_runtime", "scoreboard", "autocoder_v2"],
    fixtures: [
      skillRel("tests/test_escalation_protocol.mjs"),
      skillRel("tests/fixtures/escalation_protocol/transcripts.json"),
      skillRel("scripts/lib/escalation_protocol.mjs"),
      skillRel("scripts/lib/claims_evidence_contract.mjs"),
      skillRel("scripts/lib/role_provider_runtime.mjs"),
      skillRel("scripts/lib/scoreboard.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_escalation_protocol\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/escalation_protocol\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/escalation_protocol\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/scoreboard\.mjs$/,
    ],
  }),
  suite({
    id: "core-routing",
    category: "structured_plan",
    label: "IVE fact/action routing",
    command: ["node", join(TESTS_ROOT, "test_ive_action_router.mjs")],
    phases: ["core.routing"],
    fixtures: [
      skillRel("tests/test_ive_action_router.mjs"),
      skillRel("scripts/lib/ive_action_router.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_action_router\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_action_router\.mjs$/,
    ],
  }),
  suite({
    id: "core-program-intake",
    category: "structured_plan",
    label: "IVE Program Manager intake",
    command: ["node", join(TESTS_ROOT, "test_ive_program_intake.mjs")],
    phases: ["core.program-intake"],
    fixtures: [
      skillRel("tests/test_ive_program_intake.mjs"),
      skillRel("scripts/lib/ive_program_intake.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_program_intake\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_program_intake\.mjs$/,
      /^plans\/programs\//,
    ],
  }),
  suite({
    id: "core-user-verdict",
    category: "structured_plan",
    label: "IVE user verdict renderer",
    command: ["node", join(TESTS_ROOT, "test_ive_user_verdict.mjs")],
    phases: ["core.user-verdict"],
    fixtures: [
      skillRel("tests/test_ive_user_verdict.mjs"),
      skillRel("scripts/lib/ive_user_verdict.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_user_verdict\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_user_verdict\.mjs$/,
    ],
  }),
  suite({
    id: "irreversible-action-contract",
    category: "safety",
    label: "Irreversible external actions require a direct typed human token",
    command: ["node", join(TESTS_ROOT, "test_irreversible_action_contract.mjs")],
    phases: ["safety", "irreversible-actions", "planner-core"],
    surfaces: ["safety", "config", "orchestration", "structured_plan"],
    fixtures: [
      skillRel("tests/test_irreversible_action_contract.mjs"),
      skillRel("config/irreversible_action_registry.json"),
      skillRel("config/irreversible_action_registry.schema.json"),
      skillRel("scripts/lib/irreversible_action_contract.mjs"),
      skillRel("scripts/irreversible_action_gate.mjs"),
      skillRel("scripts/lib/triage.mjs"),
      skillRel("SKILL.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_irreversible_action_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/irreversible_action_registry(?:\.schema)?\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/irreversible_action_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/irreversible_action_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/triage\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/SKILL\.md$/,
    ],
  }),
  suite({
    id: "scientific-migration-parity",
    category: "migration",
    label: "fresh setup and pinned transactional upgrade scientific-review parity",
    command: ["node", join(TESTS_ROOT, "test_scientific_migration_parity.mjs")],
    phases: ["migration", "scientific-review", "quant-results-validation"],
    surfaces: ["migration", "quant", "validation", "persona"],
    fixtures: [
      skillRel("tests/test_scientific_migration_parity.mjs"),
      skillRel("scripts/migrate.mjs"),
      skillRel("scripts/lib/scientific_review.mjs"),
      skillRel("config/scientific_review_request.schema.json"),
      skillRel("config/scientific_evidence_artifact.schema.json"),
      skillRel("config/scientific_review_receipt.schema.json"),
      skillRel("SKILL.md"),
      skillRel("references/role-auditors.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_scientific_migration_parity\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/(scripts\/lib\/scientific_.*\.mjs|config\/scientific_.*\.schema\.json|SKILL\.md|references\/role-auditors\.md)$/,
    ],
  }),
  suite({
    id: "migration-bootstrap",
    category: "migration",
    label: "IVE migration bootstrap",
    command: ["node", join(TESTS_ROOT, "test_ive_migration_bootstrap.mjs")],
    // Transactional upgrade fixtures clone and prove several Git repositories.
    // Dropbox-backed worktrees can exceed ten minutes under contention without
    // indicating a hang, so keep the governed wrapper above the observed ceiling.
    timeoutMs: 900000,
    phases: ["0.5", "migration.bootstrap", "e4-4", "kernel"],
    surfaces: ["migration", "structured_plan"],
    fixtures: [
      skillRel("tests/test_ive_migration_bootstrap.mjs"),
      skillRel("scripts/migrate.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/lib/ive_migration_bootstrap.mjs"),
      skillRel("scripts/lib/managed_upgrade_transaction.mjs"),
      skillRel("scripts/lib/migration_source_pin.mjs"),
      skillRel("scripts/lib/bootstrap_self_heal.mjs"),
      skillRel("scripts/pre_commit_policy.mjs"),
      skillRel("config/managed_upgrade_transaction.json"),
      skillRel("scripts/lib/degraded_coverage.mjs"),
      skillRel("scripts/lib/bootstrap_status_context.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("config/degraded_coverage_census.json"),
      skillRel("analyzers/pattern-grep.yaml"),
      skillRel("config/irreversible_action_registry.json"),
      skillRel("config/irreversible_action_registry.schema.json"),
      skillRel("scripts/lib/irreversible_action_contract.mjs"),
      skillRel("scripts/irreversible_action_gate.mjs"),
      skillRel("tests/test_irreversible_action_contract.mjs"),
      skillRel("SKILL.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_migration_bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/migrate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_migration_bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/managed_upgrade_transaction\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/migration_source_pin\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/bootstrap_self_heal\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/pre_commit_policy\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/managed_upgrade_transaction\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(degraded_coverage|bootstrap_status_context|fact_loader)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/degraded_coverage_census\.json$/,
      /^\.agent\/skills\/iterative-planner\/analyzers\/pattern-grep\.yaml$/,
      /^\.agent\/skills\/iterative-planner\/config\/irreversible_action_registry(?:\.schema)?\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/irreversible_action_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/irreversible_action_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_irreversible_action_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/SKILL\.md$/,
      /^docs\/autocoder-kernel-demo\.md$/,
      docsIvePattern("10_migration.md"),
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "canonical-release-handoff",
    category: "release",
    label: "IVE canonical migration release handoff",
    command: ["node", join(SCRIPTS_DIR, "ive_release_handoff.mjs"), "--plans", "50", "--json"],
    phases: ["6", "canonical-migration", "release-handoff"],
    surfaces: ["release", "migration", "structured_plan"],
    fixtures: [
      skillRel("scripts/ive_release_handoff.mjs"),
      skillRel("scripts/lib/ive_release_handoff.mjs"),
      skillRel("scripts/autonomous_dogfood_run.mjs"),
      skillRel("scripts/lib/autonomous_dogfood_run.mjs"),
      skillRel("scripts/lib/ive_migration_bootstrap.mjs"),
      skillRel("scripts/lib/ive_projection.mjs"),
      "docs/ive-redesign/17_release_lane.md",
      "plans/programs/ive-runtime-build/program_packet.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/ive_release_handoff\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_release_handoff\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_release_handoff\.mjs$/,
      /^plans\/programs\/ive-runtime-build\//,
      docsIvePattern("10_migration.md"),
      docsIvePattern("11_testing.md"),
      docsIvePattern("14_review_board.md"),
      docsIvePattern("17_release_lane.md"),
      /^\.agent\/skills\/iterative-planner\/config\/version\.json$/,
      /^\.agent\/skills\/iterative-planner\/MIGRATION\.md$/,
    ],
  }),
  suite({
    id: "projection-north-star",
    category: "projection",
    label: "IVE projection and North Star v2",
    command: ["node", join(TESTS_ROOT, "test_ive_projection_north_star.mjs")],
    phases: ["1", "2", "projection", "north-star"],
    surfaces: ["projection", "north_star", "structured_plan"],
    fixtures: [
      skillRel("tests/test_ive_projection_north_star.mjs"),
      skillRel("scripts/project_ive.mjs"),
      skillRel("scripts/lib/ive_projection.mjs"),
      skillRel("scripts/lib/planner_manifesto.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_projection_north_star\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/project_ive\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_projection\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/planner_manifesto\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      docsIvePattern("02_north_star.md"),
      docsIvePattern("09_roadmap.md"),
      docsIvePattern("10_migration.md"),
    ],
  }),
  suite({
    id: "profile-knowledge-packs",
    category: "knowledge_pack",
    label: "IVE profile evaluator and knowledge packs",
    command: ["node", join(TESTS_ROOT, "test_ive_profile_knowledge_packs.mjs")],
    phases: ["2.5", "2.6", "2.6a", "2.5,2.6", "profiles", "knowledge-packs"],
    surfaces: ["profile", "knowledge_pack", "ontology", "migration"],
    fixtures: [
      skillRel("tests/test_ive_profile_knowledge_packs.mjs"),
      skillRel("scripts/check_profile.mjs"),
      skillRel("scripts/knowledge_packs.mjs"),
      skillRel("scripts/lib/ive_profile_packs.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("profiles/quant_alpha.profile.json"),
      skillRel("knowledge_packs/machine_learning/pack.json"),
      skillRel("knowledge_packs/machine_learning/obligations.json"),
      skillRel("knowledge_packs/machine_learning/pitfalls.json"),
      skillRel("knowledge_packs/machine_learning/opportunities.json"),
      skillRel("knowledge_packs/machine_learning/constraints.json"),
      skillRel("knowledge_packs/machine_learning/decisions.json"),
      skillRel("knowledge_packs/machine_learning/vocabulary.json"),
      skillRel("knowledge_packs/machine_learning/canonical_artifacts.json"),
      skillRel("knowledge_packs/machine_learning_toolbox/pack.json"),
      skillRel("knowledge_packs/machine_learning_toolbox/tools.json"),
      skillRel("knowledge_packs/quant_results_communication/pack.json"),
      skillRel("knowledge_packs/product_management/pack.json"),
      skillRel("knowledge_packs/ux_ui_experience/pack.json"),
      skillRel("knowledge_packs/coaching_methodology/pack.json"),
      skillRel("knowledge_packs/software_engineering_methodology/pack.json"),
      skillRel("knowledge_packs/app_dev_tesseract/pack.json"),
      skillRel("knowledge_packs/app_dev_tesseract/pitfalls.json"),
      skillRel("knowledge_packs/app_dev_tesseract/constraints.json"),
      skillRel("knowledge_packs/app_dev_tesseract/obligations.json"),
      skillRel("knowledge_packs/app_dev_tesseract/calibration.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_profile_knowledge_packs\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/check_profile\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/knowledge_packs\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_profile_packs\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/profiles\//,
      /^\.agent\/skills\/iterative-planner\/knowledge_packs\//,
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "cli-determinism",
    category: "cli_contract",
    label: "IVE JSON CLI determinism and P-061 exit-after-stdout-JSON enforcement across pipe, TTY, path, and repeat runs",
    command: ["node", join(TESTS_ROOT, "test_cli_determinism.mjs")],
    phases: ["stage1", "cli-json", "determinism"],
    surfaces: ["cli", "json", "stdout", "exit_discipline", "p_061", "tty", "path", "conformance", "dispatcher", "workflow"],
    fixtures: [
      skillRel("tests/test_cli_determinism.mjs"),
      skillRel("scripts/planner.mjs"),
      ".agent/workflows/reflection.md",
      "plans/knowledge/patterns.md",
      skillRel("scripts/lib/emit_json.mjs"),
      skillRel("scripts/knowledge_packs.mjs"),
      skillRel("scripts/project_ive.mjs"),
      skillRel("scripts/lib/ive_projection.mjs"),
      skillRel("scripts/reflection_guide.mjs"),
      skillRel("scripts/validate_reflection.mjs"),
      skillRel("scripts/ive_packet_validator.mjs"),
      skillRel("scripts/check_profile.mjs"),
      skillRel("scripts/journal.mjs"),
      skillRel("scripts/decision_anchors.mjs"),
      skillRel("scripts/thrashing_detector.mjs"),
      skillRel("scripts/ab_task_benchmark.mjs"),
      skillRel("scripts/lib/ab_task_benchmark.mjs"),
      skillRel("scripts/ideation_quality_benchmark.mjs"),
      skillRel("scripts/lib/ideation_quality_benchmark.mjs"),
      skillRel("scripts/ttinsights_report.mjs"),
      skillRel("scripts/lib/ttinsights_report.mjs"),
      skillRel("scripts/scoreboard.mjs"),
      skillRel("scripts/lib/scoreboard.mjs"),
      skillRel("scripts/ritual_replay.mjs"),
      skillRel("scripts/lib/ritual_replay.mjs"),
      skillRel("scripts/rubric_admin_runner.mjs"),
      skillRel("scripts/lib/rubric_admin_runner.mjs"),
      skillRel("scripts/delivery_receipt_assemble.mjs"),
      skillRel("scripts/lib/delivery_receipt_assembler.mjs"),
      skillRel("scripts/ive_release_handoff.mjs"),
      skillRel("scripts/lib/ive_release_handoff.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/[^/]+\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/[^/]+\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_cli_determinism\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/planner\.mjs$/,
      /^\.agent\/workflows\/reflection\.md$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_emit_json_cli\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/emit_json\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(knowledge_packs|project_ive|reflection_guide|validate_reflection|ive_packet_validator|check_profile|journal|decision_anchors|thrashing_detector|ab_task_benchmark|ideation_quality_benchmark|ttinsights_report|dispatcher_v1|scoreboard|ritual_replay|rubric_admin_runner|delivery_receipt_assemble|ive_release_handoff|autonomous_dogfood_run)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(ive_projection|ab_task_benchmark|ideation_quality_benchmark|ttinsights_report|dispatcher_v1|scoreboard|ritual_replay|rubric_admin_runner|delivery_receipt_assembler|ive_release_handoff|autonomous_dogfood_run)\.mjs$/,
    ],
  }),
  suite({
    id: "quant-results-validation",
    category: "quant",
    label: "IVE quant results validation semantic gates",
    command: ["node", join(TESTS_ROOT, "test_quant_results_validation.mjs")],
    phases: ["stage1", "e01", "e02", "t06", "provenance", "quant-results-validation", "semantic-gates"],
    surfaces: ["quant", "claim_ledger", "semantic_gate", "validation", "conformance"],
    fixtures: [
      skillRel("tests/test_quant_results_validation.mjs"),
      skillRel("scripts/lib/claim_ledger.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("scripts/lib/measured_gate.mjs"),
      skillRel("scripts/lib/run_record.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
      skillRel("scripts/ontology_serializer.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_archetype_accomplices\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/claim_ledger\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/measured_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/run_record\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/leakage_proof\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_serializer\.mjs$/,
    ],
  }),
  suite({
    id: "adversarial-evidence-rerun",
    category: "quant",
    label: "IVE result-bearing close fresh-context adversarial evidence rerun",
    command: ["node", join(TESTS_ROOT, "test_adversarial_evidence_executor.mjs")],
    phases: ["stage1", "t06", "provenance", "quant-results-validation", "adversarial-rerun", "semantic-gates"],
    surfaces: ["planner_core", "fresh_context", "verification_ledger", "quant_results_validation", "transition_gates", "ontology"],
    fixtures: [
      skillRel("tests/test_adversarial_evidence_executor.mjs"),
      skillRel("scripts/adversarial_evidence_executor.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/ontology_serializer.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("config/state.schema.json"),
      skillRel("config/failure-codes.json"),
      skillRel("checklists/validate-to-close.yaml"),
      skillRel("SKILL.md"),
      skillRel("MIGRATION.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_adversarial_evidence_executor\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/adversarial_evidence_executor\.mjs$/,
    ],
  }),
  suite({
    id: "quant-gate-hardening",
    category: "quant",
    label: "IVE quant gate hardening: scale, run-class, and leakage fixture gates",
    command: ["node", join(TESTS_ROOT, "test_quant_gate_hardening.mjs")],
    phases: ["stage1", "quant-results-validation", "semantic-gates"],
    surfaces: ["quant", "semantic_gate", "prolog", "conformance"],
    fixtures: [
      skillRel("tests/test_quant_gate_hardening.mjs"),
      skillRel("tests/fixtures/quant/negative_leakage_guard_fires.json"),
      skillRel("scripts/lib/quant_gate_hardening.mjs"),
      skillRel("scripts/lib/quant_persona_gate.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/ontology_serializer.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("config/determinism.json"),
      skillRel("config/failure-codes.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_gate_hardening\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/quant\/negative_leakage_guard_fires\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_gate_hardening\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_persona_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/leakage_proof\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_serializer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/(determinism|failure-codes)\.json$/,
    ],
  }),
  suite({
    id: "quant-persona-gate-scoring",
    category: "semantic",
    label: "IVE quant persona gate scoring and non-quant conflict advisory",
    command: ["node", join(TESTS_ROOT, "test_quant_persona_gate_scoring.mjs")],
    phases: ["stage1", "persona", "quant"],
    surfaces: ["persona", "quant", "semantic_gate"],
    fixtures: [
      skillRel("tests/test_quant_persona_gate_scoring.mjs"),
      skillRel("tests/fixtures/persona_quant_genuine.json"),
      skillRel("tests/fixtures/persona_quant_false_positive.json"),
      skillRel("scripts/lib/quant_persona_gate.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_persona_gate_scoring\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/persona_quant_(genuine|false_positive)\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_persona_gate\.mjs$/,
    ],
  }),
  suite({
    id: "verification-runner",
    category: "structured_plan",
    label: "IVE verification runner provenance",
    command: ["node", join(TESTS_ROOT, "test_verification_runner.mjs")],
    phases: ["stage1", "t06", "provenance", "verification-runner"],
    surfaces: ["runner", "provenance", "verification", "program_packet"],
    fixtures: [
      skillRel("tests/test_verification_runner.mjs"),
      skillRel("tests/fixtures/programs/auto_executor.json"),
      skillRel("scripts/verification_runner.mjs"),
      skillRel("scripts/lib/run_record.mjs"),
      skillRel("config/program_packet.schema.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_verification_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/programs\/auto_executor\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verification_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/run_record\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/program_packet\.schema\.json$/,
    ],
  }),
  suite({
    id: "ci-enforcement-contracts",
    category: "ci",
    label: "IVE CI enforcement and branch-protection contracts",
    command: ["node", join(TESTS_ROOT, "test_ci_enforcement_contracts.mjs")],
    phases: ["stage1", "ci-enforcement", "t04"],
    surfaces: ["ci", "git_hooks", "github", "conformance"],
    fixtures: [
      skillRel("tests/test_ci_enforcement_contracts.mjs"),
      skillRel("scripts/hooks/install.mjs"),
      skillRel("scripts/hooks/pre-push"),
      skillRel("scripts/hooks/pre_push_conformance.mjs"),
      skillRel("scripts/snapshot_branch_protection.mjs"),
      skillRel("tests/test_pack_contract.mjs"),
      skillRel("scripts/pack_contract_validate.mjs"),
      skillRel("scripts/lib/pack_contract.mjs"),
      skillRel("config/pack_contract.schema.json"),
      skillRel("scripts/clean_checkout_conformance.mjs"),
      skillRel("config/ive_release_profiles.json"),
      ".agent/workflows/release.md",
      "docs/ive-redesign/17_release_lane.md",
      "docs/ci/github_actions.md",
      skillRel("SKILL.md"),
      skillRel("references/file-formats.md"),
      skillRel("scripts/pre_commit_policy.mjs"),
      ".github/branch-protection.snapshot.json",
      "tests/test_escalation_triggers.mjs",
      "tests/test_loop_guards.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ci_enforcement_contracts\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/hooks\/(install|pre_push_conformance)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/hooks\/pre-push$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/snapshot_branch_protection\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_pack_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/pack_contract_validate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/pack_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/pack_contract\.schema\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/clean_checkout_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/ive_release_profiles\.json$/,
      /^\.agent\/skills\/iterative-planner\/SKILL\.md$/,
      /^\.agent\/skills\/iterative-planner\/references\/file-formats\.md$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/pre_commit_policy\.mjs$/,
      /^\.agent\/workflows\/release\.md$/,
      /^docs\/ive-redesign\/17_release_lane\.md$/,
      /^docs\/ci\/github_actions\.md$/,
      // Legacy hosted paths are routing-only recurrence guards, never required fixtures.
      /^\.github\/workflows\/ive-conformance\.yml$/,
      /^\.github\/workflows\/fresh-context-reviewer\.yml$/,
      /^\.github\/branch-protection\.snapshot\.json$/,
      /^tests\/test_escalation_triggers\.mjs$/,
      /^tests\/test_loop_guards\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "fresh-context-reviewer",
    category: "ci",
    label: "Fresh-context PR reviewer: pack-derived closed questions and fail-honest provider boundary",
    command: ["node", join(TESTS_ROOT, "test_fresh_context_reviewer.mjs")],
    phases: ["stage1", "ci-enforcement", "e1-2", "fresh-context-reviewer", "autocoder-v2"],
    surfaces: ["ci", "github", "reviewer_agent", "persona_packs", "conformance"],
    fixtures: [
      skillRel("tests/test_fresh_context_reviewer.mjs"),
      skillRel("scripts/fresh_context_reviewer.mjs"),
      skillRel("scripts/lib/fresh_context_reviewer.mjs"),
      skillRel("scripts/lib/role_provider_runtime.mjs"),
      skillRel("scripts/lib/provider_client.mjs"),
      skillRel("packs/wiring_auditor/index.mjs"),
      skillRel("packs/assumptions_challenger/index.mjs"),
      skillRel("packs/traceability/index.mjs"),
      skillRel("packs/config_integrity/index.mjs"),
      ".github/reviewer/config.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_fresh_context_reviewer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/fresh_context_reviewer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fresh_context_reviewer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/role_provider_runtime\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/provider_client\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/(wiring_auditor|assumptions_challenger|traceability|config_integrity)\/index\.mjs$/,
      /^\.github\/reviewer\/config\.json$/,
    ],
  }),
  suite({
    id: "role-provider-runtime",
    category: "ci",
    label: "Role-provider runtime: cheap/frontier binding, fail-honest provider errors, and cost ledger telemetry",
    command: ["node", join(TESTS_ROOT, "test_role_provider_runtime.mjs")],
    phases: ["stage1", "ci-enforcement", "e6-1", "role-provider-runtime", "autocoder-v2"],
    surfaces: ["ci", "provider_runtime", "cost_telemetry", "conformance"],
    fixtures: [
      skillRel("tests/test_role_provider_runtime.mjs"),
      skillRel("scripts/lib/role_provider_runtime.mjs"),
      skillRel("scripts/lib/provider_client.mjs"),
      "docs/role-provider-runtime.md",
      ".github/reviewer/config.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_role_provider_runtime\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/role_provider_runtime\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/provider_client\.mjs$/,
      /^docs\/role-provider-runtime\.md$/,
      /^\.github\/reviewer\/config\.json$/,
    ],
  }),
  suite({
    id: "llm-run-telemetry",
    category: "ci",
    label: "LLM run telemetry: canonical ledger, privacy controls, IDE adapters, and reports",
    command: ["node", join(TESTS_ROOT, "test_llm_run_telemetry.mjs")],
    phases: ["stage1", "ci-enforcement", "telemetry", "autocoder-v2"],
    surfaces: ["provider_runtime", "telemetry", "privacy", "conformance"],
    fixtures: [
      skillRel("tests/test_llm_run_telemetry.mjs"),
      skillRel("scripts/lib/llm_run_telemetry.mjs"),
      skillRel("scripts/lib/role_provider_runtime.mjs"),
      skillRel("scripts/lib/interface_telemetry.mjs"),
      skillRel("scripts/telemetry.mjs"),
      skillRel("scripts/lib/provider_client.mjs"),
      skillRel("config/determinism.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_llm_run_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/llm_run_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/role_provider_runtime\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/interface_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/provider_client\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/determinism\.json$/,
    ],
  }),
  suite({
    id: "ive-conformance-runner-meta",
    category: "ci",
    label: "IVE conformance runner meta-test is default-gated",
    command: ["node", join(TESTS_ROOT, "test_ive_conformance_runner.mjs")],
    phases: ["stage1", "ci-enforcement", "runner-meta", "autocoder-v2"],
    surfaces: ["ci", "conformance", "runner"],
    fixtures: [
      skillRel("tests/test_ive_conformance_runner.mjs"),
      skillRel("tests/ive/run.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_conformance_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/run\.mjs$/,
    ],
  }),
  suite({
    id: "planner-shell-wrapper-hooks",
    category: "ci",
    label: "Planner shell wrapper hooks and local advisory pre-commit policy",
    command: ["node", join(TESTS_ROOT, "test_planner_shell_wrappers.mjs")],
    phases: ["stage1", "ci-enforcement", "n03"],
    surfaces: ["git_hooks", "planner_runtime", "conformance"],
    fixtures: [skillRel("tests/test_planner_shell_wrappers.mjs"), skillRel("scripts/pre_commit_policy.mjs"), skillRel("scripts/hooks/pre-commit"), skillRel("scripts/hooks/pre-push"), skillRel("scripts/pre-commit-hook.sh"), skillRel("SKILL.md")],
    changedFilePatterns: [/^\.agent\/skills\/iterative-planner\/tests\/test_planner_shell_wrappers\.mjs$/, /^\.agent\/skills\/iterative-planner\/scripts\/pre_commit_policy\.mjs$/, /^\.agent\/skills\/iterative-planner\/scripts\/hooks\/(pre-(commit|push)|pre_push_conformance\.mjs)$/, /^\.agent\/skills\/iterative-planner\/scripts\/pre-commit-hook\.sh$/, /^\.agent\/skills\/iterative-planner\/SKILL\.md$/],
  }),
  suite({
    id: "active-ontology-temporal-provenance",
    category: "active_ontology",
    label: "IVE active ontology and temporal provenance",
    command: ["node", join(TESTS_ROOT, "test_ive_active_ontology.mjs")],
    phases: ["4.5", "active-ontology", "temporal-provenance"],
    surfaces: ["ontology", "provenance", "migration"],
    fixtures: [
      skillRel("tests/test_ive_active_ontology.mjs"),
      skillRel("scripts/ontology_write.mjs"),
      skillRel("scripts/lib/ive_active_ontology.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_active_ontology\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_write\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_active_ontology\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      docsIvePattern("07a_active_ontology_file.md"),
      docsIvePattern("07b_temporal_provenance.md"),
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "ideation-anchors-operators-intent",
    category: "ideation",
    label: "IVE ideation anchors, operators, and intent binding",
    command: ["node", join(TESTS_ROOT, "test_ive_ideation_operators.mjs")],
    phases: ["3", "ideation", "anchors", "operators", "intent-binding"],
    surfaces: ["ideation", "ontology", "structured_plan"],
    fixtures: [
      skillRel("tests/test_ive_ideation_operators.mjs"),
      skillRel("scripts/lib/ive_ideation_operators.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_ideation_operators\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_ideation_operators\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      docsIvePattern("03_ideation.md"),
      docsIvePattern("04a_reflection_as_diff.md"),
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "structured-evidence-reflection-diff",
    category: "reflection",
    label: "IVE structured evidence and reflection diff",
    command: ["node", join(TESTS_ROOT, "test_ive_reflection_diff.mjs")],
    phases: ["4", "4.6", "4,4.6", "t06", "provenance", "structured-evidence", "reflection-diff"],
    surfaces: ["evidence", "reflection", "ontology", "migration"],
    fixtures: [
      skillRel("tests/test_ive_reflection_diff.mjs"),
      skillRel("scripts/reflection_renderer.mjs"),
      skillRel("scripts/lib/ive_reflection_diff.mjs"),
      skillRel("scripts/lib/run_record.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_reflection_diff\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/reflection_renderer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_reflection_diff\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/run_record\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      docsIvePattern("04a_reflection_as_diff.md"),
      docsIvePattern("09_roadmap.md"),
      docsIvePattern("10_migration.md"),
    ],
  }),
  suite({
    id: "reflection-invariants",
    category: "reflection",
    label: "Structured REFLECT invariant contracts",
    command: ["node", join(TESTS_ROOT, "test_reflection_invariants.mjs")],
    phases: ["4", "reflection-invariants", "semantic-gates"],
    surfaces: ["reflection", "semantic_gate", "ontology"],
    fixtures: [
      skillRel("tests/test_reflection_invariants.mjs"),
      skillRel("scripts/lib/reflection_validation.mjs"),
      skillRel("scripts/lib/reflection_guide.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_reflection_invariants\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(reflection_validation|reflection_guide|fact_loader)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
    ],
  }),
  suite({
    id: "adversarial-idea-barrenness",
    category: "reflection",
    label: "ADV-LLM-005 / I-050 novel-insight floor",
    command: ["node", join(TESTS_ROOT, "test_adversarial_idea_barrenness.mjs")],
    phases: ["4.6", "adversarial", "idea-barrenness", "i-050", "semantic-gates"],
    surfaces: ["reflection", "semantic_gate", "ontology", "verify_gate", "fact_loader"],
    fixtures: [
      skillRel("tests/test_adversarial_idea_barrenness.mjs"),
      skillRel("tests/ive/fixtures/adversarial/idea_barrenness/barren.json"),
      skillRel("tests/ive/fixtures/adversarial/idea_barrenness/non_barren.json"),
      skillRel("scripts/lib/novel_insight_floor.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_adversarial_idea_barrenness\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/ive\/fixtures\/adversarial\/idea_barrenness\/.+\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(novel_insight_floor|fact_loader)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      docsIvePattern("11a_adversarial_llm_scenarios.md"),
      docsIvePattern("07a_active_ontology_file.md"),
    ],
  }),
  suite({
    id: "continuous-advisory-records",
    category: "advisory",
    label: "IVE continuous advisory records",
    command: ["node", join(TESTS_ROOT, "test_ive_advisory_records.mjs")],
    phases: ["4.7", "continuous-advisory", "advisory-records"],
    surfaces: ["advisory", "structured_plan", "migration"],
    fixtures: [
      skillRel("tests/test_ive_advisory_records.mjs"),
      skillRel("scripts/lib/ive_advisory_records.mjs"),
      skillRel("scripts/lib/ive_packet_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_advisory_records\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_advisory_records\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_packet_contract\.mjs$/,
      docsIvePattern("04b_continuous_advisory.md"),
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "scenario-harness",
    category: "scenario",
    label: "IVE scenario and negative closure harness",
    command: ["node", join(TESTS_ROOT, "test_ive_scenario_harness.mjs")],
    phases: ["scenarios"],
    surfaces: ["scenario", "structured_plan"],
    fixtures: [
      skillRel("tests/test_ive_scenario_harness.mjs"),
      skillRel("scripts/lib/ive_scenario_harness.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_scenario_harness\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_scenario_harness\.mjs$/,
    ],
  }),
  suite({
    id: "real-episode-replay-corpus",
    category: "scenario",
    label: "Real Mac mini episode replay corpus",
    command: ["node", join(TESTS_ROOT, "test_real_episode_replay_corpus.mjs")],
    phases: ["scenarios", "real-episodes", "autocode-replay"],
    surfaces: ["scenario", "real_episode_corpus", "quant", "structured_plan"],
    fixtures: [
      skillRel("tests/test_real_episode_replay_corpus.mjs"),
      skillRel("tests/fixtures/real_episodes/mac_mini_quant_episodes.json"),
      skillRel("scripts/lib/ive_real_episode_corpus.mjs"),
      skillRel("scripts/lib/ive_scenario_harness.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_real_episode_replay_corpus\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_episodes\/mac_mini_quant_episodes\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_real_episode_corpus\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_scenario_harness\.mjs$/,
    ],
  }),
];

function captureExcerpt(value) {
  const text = (value || "").toString();
  return text.length > STDOUT_EXCERPT_BYTES
    ? `${text.slice(0, STDOUT_EXCERPT_BYTES)}...[truncated]`
    : text;
}

function normalizeRepoPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function repoRelPath(absPath, repoRoot = REPO_ROOT) {
  return normalizeRepoPath(relative(repoRoot, absPath));
}

function sanitizeRunId(value, now = new Date()) {
  const fallback = `ive-${now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")}`;
  const raw = String(value || process.env.IVE_RUN_ID || fallback).trim() || fallback;
  const normalized = raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 120) || fallback;
  if (normalized === "." || normalized === "..") {
    throw profileConfigError(
      "IVE run ID cannot resolve to a reserved path segment",
      "invalid_run_id",
    );
  }
  return normalized;
}

function splitChangedFiles(values = []) {
  return values
    .flatMap((value) => String(value || "").split(/[\n,]/g))
    .map(normalizeRepoPath)
    .filter(Boolean);
}

function toManifestStatus(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "PASS") return "pass";
  if (normalized === "WARN" || normalized === "WARNING") return "warn";
  if (normalized === "SKIPPED" || normalized === "SKIP") return "skipped";
  if (normalized === "NOT_APPLICABLE" || normalized === "NOT-APPLICABLE") return "not_applicable";
  if (normalized === "NOT_IMPLEMENTED_YET" || normalized === "NOT-IMPLEMENTED-YET") return "not_implemented_yet";
  return "fail";
}

function statusForReport({ issues = [], warningCount = 0, skippedCount = 0 } = {}) {
  if (issues.length > 0) return "FAIL";
  if (warningCount > 0 || skippedCount > 0) return "WARN";
  return "PASS";
}

function roundScore(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

function statusScore(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "PASS") return 1;
  if (normalized === "WARN" || normalized === "WARNING") return 0.75;
  if (normalized === "SKIPPED" || normalized === "SKIP") return 0.5;
  if (normalized === "NOT_APPLICABLE" || normalized === "NOT-APPLICABLE") return null;
  return 0;
}

function averageScore(rows) {
  const scored = rows
    .map((row) => Number(row?.score))
    .filter((score) => Number.isFinite(score));
  if (scored.length === 0) return null;
  return roundScore(scored.reduce((sum, score) => sum + score, 0) / scored.length);
}

function isInsightVelocitySuite(result) {
  const tokens = [
    result?.id,
    result?.name,
    result?.category,
    ...(Array.isArray(result?.surfaces) ? result.surfaces : []),
    ...(Array.isArray(result?.phases) ? result.phases : []),
  ].map((value) => String(value || "").toLowerCase());
  return tokens.some((token) =>
    token.includes("insight_velocity")
    || token.includes("insight-velocity")
    || token.includes("ideation_quality")
    || token.includes("ideation-quality")
  );
}

function isRitualSuite(result) {
  const tokens = [
    result?.id,
    result?.name,
    result?.category,
    ...(Array.isArray(result?.surfaces) ? result.surfaces : []),
    ...(Array.isArray(result?.phases) ? result.phases : []),
  ].map((value) => String(value || "").toLowerCase());
  return tokens.some((token) =>
    token.includes("ritual_replay")
    || token.includes("ritual-replay")
    || token.includes("anti_ritual")
    || token.includes("anti-ritual")
  );
}

function buildQualityScores(results) {
  const scoredRows = results.map((result) => ({
    id: result.id,
    status: result.status,
    score: statusScore(result.status),
  }));
  const ivRows = scoredRows.filter((row) => {
    const result = results.find((candidate) => candidate.id === row.id);
    return result && isInsightVelocitySuite(result);
  });
  const ritualRows = scoredRows.filter((row) => {
    const result = results.find((candidate) => candidate.id === row.id);
    return result && isRitualSuite(result);
  });
  const qualityScore = averageScore(scoredRows);
  const ivScore = averageScore(ivRows);
  const ritualScore = averageScore(ritualRows);
  return {
    quality_score: {
      current: qualityScore,
      scale: "0..1",
      source_status: qualityScore === null ? "not_scored" : "scored",
      scored_suite_count: scoredRows.filter((row) => row.score !== null).length,
      total_suite_count: results.length,
      method: "Average suite status score: PASS=1, WARN=0.75, SKIPPED=0.5, FAIL/TIMEOUT/NOT_IMPLEMENTED=0; NOT_APPLICABLE is excluded.",
    },
    iv_score: {
      current: ivScore,
      scale: "0..1",
      source_status: ivRows.length === 0 ? "not_selected" : ivScore === null ? "not_scored" : "scored",
      scored_suite_count: ivRows.filter((row) => row.score !== null).length,
      total_suite_count: ivRows.length,
      method: "Average status score for selected Insight Velocity / ideation-quality suites.",
    },
    ritual_score: {
      current: ritualScore,
      scale: "0..1",
      source_status: ritualRows.length === 0 ? "not_selected" : ritualScore === null ? "not_scored" : "scored",
      scored_suite_count: ritualRows.filter((row) => row.score !== null).length,
      total_suite_count: ritualRows.length,
      method: "Average status score for selected ritual replay / anti-ritual suites.",
    },
  };
}

function patternMatches(pattern, file) {
  if (pattern instanceof RegExp) return pattern.test(file);
  if (typeof pattern === "string") {
    if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -3));
    return file === normalizeRepoPath(pattern);
  }
  return false;
}

function isRunnerSurfaceChange(file) {
  return [
    ".agent/skills/iterative-planner/tests/ive/run.mjs",
    ".agent/skills/iterative-planner/tests/ive/test_run.mjs",
    ".agent/skills/iterative-planner/tests/test_ive_conformance_runner.mjs",
  ].includes(file);
}

function selectedByChangedFiles(item, changedFiles = []) {
  if (!changedFiles.length) return true;
  if (changedFiles.some(isRunnerSurfaceChange)) return true;
  const patterns = item.changed_file_patterns || [];
  return changedFiles.some((file) => patterns.some((pattern) => patternMatches(pattern, file)));
}

function missingRequiredFixtures(item, repoRoot = REPO_ROOT) {
  return (item.fixtures || [])
    .map(normalizeRepoPath)
    .filter((fixture) => fixture && !existsSync(resolve(repoRoot, fixture)));
}

function commandEnv(overrides = {}) {
  return plannerSubprocessEnv({
    PLANNER_SKIP_SELF_HEAL: process.env.PLANNER_SKIP_SELF_HEAL || "1",
    ...overrides,
  });
}

function runExitCodeCheck(command, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd = undefined,
  envOverrides = {},
} = {}) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      cwd,
      env: commandEnv(envOverrides),
    });
    return {
      status: "PASS",
      exit_code: 0,
      timed_out: false,
      stdout_excerpt: captureExcerpt(stdout),
      stderr_excerpt: "",
      raw_stdout: stdout,
      raw_stderr: "",
    };
  } catch (err) {
    const timedOut = err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    return {
      status: timedOut ? "TIMEOUT" : "FAIL",
      exit_code: timedOut ? -1 : (err.status ?? 1),
      timed_out: timedOut,
      stdout_excerpt: captureExcerpt(err.stdout || err.message),
      stderr_excerpt: captureExcerpt(err.stderr || ""),
      raw_stdout: (err.stdout || "").toString(),
      raw_stderr: (err.stderr || err.message || "").toString(),
    };
  }
}

function classifyHarvestRealTelemetryHostResult(result) {
  if (result?.exit_code !== HOST_PROOF_SKIP_EXIT_CODE || result?.timed_out) return result;
  const rawStdout = String(result.raw_stdout || result.stdout_excerpt || "");
  const reasonLine = rawStdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(HOST_PROOF_SKIP_PREFIX));
  const reason = reasonLine
    ? reasonLine.slice(HOST_PROOF_SKIP_PREFIX.length).trim()
    : "real sibling telemetry unavailable";
  return {
    ...result,
    status: "SKIPPED",
    timed_out: false,
    status_reason: `host_real_telemetry_unavailable: ${reason}`,
    stdout_excerpt: captureExcerpt(rawStdout),
  };
}

function runHarvestRealTelemetryHost(command, options = {}) {
  return classifyHarvestRealTelemetryHostResult(runExitCodeCheck(command, options));
}

function runJsonAdvisoryStatus(command, options = {}) {
  const result = runExitCodeCheck(command, options);
  if (result.status !== "PASS") return result;
  try {
    const payload = JSON.parse(result.raw_stdout || "{}");
    const status = String(payload.status || "FAIL").toUpperCase();
    if (!["PASS", "WARN"].includes(status)) {
      return { ...result, status: "FAIL", exit_code: 1, status_reason: "invalid_advisory_status" };
    }
    return {
      ...result,
      status,
      status_reason: payload.reason || "",
      stdout_excerpt: captureExcerpt(result.raw_stdout),
    };
  } catch (error) {
    return {
      ...result,
      status: "FAIL",
      exit_code: 1,
      status_reason: "invalid_advisory_json",
      stderr_excerpt: captureExcerpt(error.message),
    };
  }
}

function visualizerProofPortCandidates(pid = process.pid, count = 5) {
  const normalizedPid = Math.abs(Number.parseInt(pid, 10) || 0);
  return Array.from({ length: count }, (_, index) => 45000 + ((normalizedPid + (index * 7919)) % 10000));
}

function visualizerPortCollision(result) {
  const detail = [
    result?.raw_stdout,
    result?.raw_stderr,
    result?.stdout_excerpt,
    result?.stderr_excerpt,
  ].map((value) => String(value || "")).join("\n").toLowerCase();
  return detail.includes("is already used")
    || detail.includes("eaddrinuse")
    || detail.includes("address already in use");
}

function runVisualizerBrowserProof(_command, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  repoRoot = REPO_ROOT,
  env = process.env,
  pid = process.pid,
  execute = runExitCodeCheck,
} = {}) {
  const appRoot = visualizerAppRoot(repoRoot);
  const playwrightBin = visualizerPlaywrightBin(repoRoot);
  if (!existsSync(playwrightBin)) {
    const reason = "playwright_dependency_missing";
    const guidance = "Run: npm ci --prefix apps/ive-visualizer && npm --prefix apps/ive-visualizer exec playwright -- install --with-deps chromium";
    return {
      status: "SKIPPED",
      exit_code: VISUALIZER_SKIP_EXIT_CODE,
      timed_out: false,
      status_reason: `${reason}: ${guidance}`,
      stdout_excerpt: `${reason}: ${guidance}`,
      stderr_excerpt: "",
      raw_stdout: `${reason}: ${guidance}\n`,
      raw_stderr: "",
    };
  }
  const requestedPort = Number.parseInt(env.IVE_VISUALIZER_PORT || "", 10);
  const explicitPort = Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535;
  const candidates = explicitPort ? [requestedPort] : visualizerProofPortCandidates(pid);
  const attemptedPorts = [];
  let result = null;
  for (const proofPort of candidates) {
    attemptedPorts.push(proofPort);
    result = execute([playwrightBin, "test", "--config=playwright.config.mjs"], {
      timeoutMs,
      cwd: appRoot,
      envOverrides: { IVE_VISUALIZER_PORT: String(proofPort) },
    });
    if (result?.status === "PASS" || explicitPort || !visualizerPortCollision(result)) break;
  }
  return { ...result, visualizer_port_attempts: attemptedPorts };
}

function runDocContractCheck(command) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const count = parseInt(stdout.trim(), 10);
    if (Number.isFinite(count) && count >= 4) {
      return {
        status: "PASS",
        exit_code: 0,
        timed_out: false,
        stdout_excerpt: `count=${count}`,
        stderr_excerpt: "",
        raw_stdout: stdout,
        raw_stderr: "",
      };
    }
    return {
      status: "FAIL",
      exit_code: 0,
      timed_out: false,
      stdout_excerpt: `count=${count} (expected >=4)`,
      stderr_excerpt: "",
      raw_stdout: stdout,
      raw_stderr: "",
    };
  } catch (err) {
    return {
      status: "FAIL",
      exit_code: err.status ?? 1,
      timed_out: false,
      stdout_excerpt: captureExcerpt(err.stdout || err.message),
      stderr_excerpt: captureExcerpt(err.stderr || ""),
      raw_stdout: (err.stdout || "").toString(),
      raw_stderr: (err.stderr || err.message || "").toString(),
    };
  }
}

function runDocsContractsAggregate(_command, options) {
  const docContractIds = new Set(["doc-contract-mvp", "doc-contract-multi-ide", "workflow-disposition-contract"]);
  const docSuites = DEFAULT_SUITES.filter((item) => docContractIds.has(item.id));
  const results = docSuites.map((item) => executeSuite(item, options));
  const failed = results.filter((result) => result.status !== "PASS");
  return {
    status: failed.length === 0 ? "PASS" : "FAIL",
    exit_code: failed.length === 0 ? 0 : 1,
    timed_out: results.some((result) => result.timed_out),
    stdout_excerpt: captureExcerpt(JSON.stringify(results.map((result) => ({
      id: result.id,
      status: result.status,
      stdout_excerpt: result.stdout_excerpt,
    })))),
    stderr_excerpt: "",
    raw_stdout: JSON.stringify(results, null, 2),
    raw_stderr: "",
  };
}

function executeSuite(item, options = {}) {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const injectedTarget = process.env.IVE_RUNNER_INJECT_FAILURE || null;
  const missingFixtures = missingRequiredFixtures(item, options.repoRoot || REPO_ROOT);
  let result;

  if (missingFixtures.length > 0) {
    result = {
      status: "NOT_IMPLEMENTED_YET",
      exit_code: 66,
      timed_out: false,
      stdout_excerpt: `missing required fixture(s): ${missingFixtures.join(", ")}`,
      stderr_excerpt: "",
      raw_stdout: "",
      raw_stderr: "",
      status_reason: "missing_required_fixture",
      missing_fixtures: missingFixtures,
    };
  } else if (injectedTarget && injectedTarget === item.id) {
    result = {
      status: "FAIL",
      exit_code: 99,
      timed_out: false,
      stdout_excerpt: `injected failure via IVE_RUNNER_INJECT_FAILURE=${item.id}`,
      stderr_excerpt: "",
      raw_stdout: `injected failure via IVE_RUNNER_INJECT_FAILURE=${item.id}`,
      raw_stderr: "",
      injected: true,
    };
  } else {
    const runner = item.run || runExitCodeCheck;
    const itemTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : Number.isFinite(item.timeout_ms) && item.timeout_ms > 0
        ? item.timeout_ms
        : DEFAULT_TIMEOUT_MS;
    const envOverrides = item.accepts_plan_target === true && options.planTarget
      ? { _PLANNER_PLAN_TARGET: options.planTarget }
      : {};
    result = runner(item.command, {
      ...options,
      timeoutMs: itemTimeoutMs,
      envOverrides,
    });
  }

  return {
    id: item.id,
    name: item.id,
    category: item.category,
    test_class: item.test_class || TEST_CLASS_FUNCTIONAL_PROOF,
    test_class_label: item.test_class_label || TEST_CLASS_LABELS[item.test_class] || TEST_CLASS_LABELS[TEST_CLASS_FUNCTIONAL_PROOF],
    label: item.label,
    required: item.required !== false,
    command: item.display_command,
    status: result.status,
    manifest_status: toManifestStatus(result.status),
    status_reason: result.status_reason || "",
    missing_fixtures: result.missing_fixtures || [],
    surfaces: item.surfaces || [item.category],
    phases: item.phases || [],
    exit_code: result.exit_code,
    timed_out: !!result.timed_out,
    duration_ms: Date.now() - t0,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stdout_excerpt: result.stdout_excerpt || "",
    stderr_excerpt: result.stderr_excerpt || "",
    raw_stdout: result.raw_stdout ?? result.stdout_excerpt ?? "",
    raw_stderr: result.raw_stderr ?? result.stderr_excerpt ?? "",
    injected: !!result.injected,
  };
}

function selectedByOnly(item, filters) {
  if (!filters.length) return true;
  return filters.some((filter) => {
    const normalized = String(filter || "").trim();
    return normalized === item.id || normalized === item.name || normalized === item.category || normalized === item.test_class;
  });
}

function selectedByPhase(item, phase) {
  if (!phase || phase === "all") return true;
  const phases = String(phase)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (phases.length === 0) return true;
  return phases.some((entry) => (item.phases || []).includes(entry));
}

function selectSuites(suites = DEFAULT_SUITES, only = [], phase = "all", changedFiles = []) {
  const normalizedChangedFiles = splitChangedFiles(changedFiles);
  return suites.filter((item) =>
    selectedByOnly(item, only) &&
    selectedByPhase(item, phase) &&
    selectedByChangedFiles(item, normalizedChangedFiles)
  );
}

function profileConfigError(message, code = "invalid_release_profile") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function uniqueNonEmptyStrings(values, fieldName) {
  if (!Array.isArray(values)) {
    throw profileConfigError(`${fieldName} must be an array`);
  }
  const normalized = values.map((value) => String(value || "").trim());
  if (normalized.some((value) => !value)) {
    throw profileConfigError(`${fieldName} must contain non-empty strings`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw profileConfigError(`${fieldName} must not contain duplicate suite IDs`);
  }
  return normalized;
}

function readReleaseProfiles(configPath = RELEASE_PROFILES_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    throw profileConfigError(`Unable to read release profile config: ${error.message}`, "release_profile_config_unavailable");
  }
  if (parsed?.schema_version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
    throw profileConfigError("Release profile config must use schema_version 1 and contain a profiles object");
  }
  return parsed;
}

function resolveReleaseProfile({
  profileId,
  suites = DEFAULT_SUITES,
  config = null,
  configPath = RELEASE_PROFILES_PATH,
} = {}) {
  const normalizedProfileId = String(profileId || "").trim();
  if (!normalizedProfileId) {
    throw profileConfigError("A release profile ID is required", "release_profile_required");
  }
  const catalogIds = suites.map((item) => item.id);
  if (new Set(catalogIds).size !== catalogIds.length) {
    throw profileConfigError("IVE suite catalog contains duplicate suite IDs", "duplicate_catalog_suite_id");
  }
  const catalogById = new Map(suites.map((item) => [item.id, item]));
  const source = config || readReleaseProfiles(configPath);
  const definition = source.profiles?.[normalizedProfileId];
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw profileConfigError(`Unknown release profile: ${normalizedProfileId}`, "unknown_release_profile");
  }

  if (!Array.isArray(definition.selection_rules) || definition.selection_rules.length === 0) {
    throw profileConfigError(`${normalizedProfileId}.selection_rules must be a non-empty array`);
  }
  const selectionRules = definition.selection_rules.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw profileConfigError(`${normalizedProfileId}.selection_rules[${index}] must be an object`);
    }
    const testClass = String(rule.test_class || "").trim();
    const surface = String(rule.surface || "").trim();
    if (!testClass || !surface) {
      throw profileConfigError(`${normalizedProfileId}.selection_rules[${index}] requires test_class and surface`);
    }
    return { test_class: testClass, surface };
  });

  const mustIncludeIds = uniqueNonEmptyStrings(
    definition.must_include_suite_ids,
    `${normalizedProfileId}.must_include_suite_ids`
  );
  const missingMustIncludes = mustIncludeIds.filter((suiteId) => !catalogById.has(suiteId));
  if (missingMustIncludes.length > 0) {
    throw profileConfigError(
      `${normalizedProfileId} references missing must-include suites: ${missingMustIncludes.join(", ")}`,
      "missing_must_include_suite"
    );
  }

  if (!Array.isArray(definition.exclusions)) {
    throw profileConfigError(`${normalizedProfileId}.exclusions must be an array`);
  }
  const exclusionIds = new Set();
  const explicitExclusions = definition.exclusions.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw profileConfigError(`${normalizedProfileId}.exclusions[${index}] must be an object`);
    }
    const suiteId = String(entry.suite_id || "").trim();
    const reason = String(entry.reason || "").trim();
    const owner = String(entry.owner || "").trim();
    const reviewBy = String(entry.review_by || "").trim();
    if (!suiteId || !reason || !owner || !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) {
      throw profileConfigError(
        `${normalizedProfileId}.exclusions[${index}] requires suite_id, reason, owner, and ISO review_by`
      );
    }
    if (!catalogById.has(suiteId)) {
      throw profileConfigError(`${normalizedProfileId} excludes unknown suite: ${suiteId}`, "unknown_excluded_suite");
    }
    if (exclusionIds.has(suiteId)) {
      throw profileConfigError(`${normalizedProfileId} excludes ${suiteId} more than once`, "duplicate_excluded_suite");
    }
    exclusionIds.add(suiteId);
    return { suite_id: suiteId, reason, owner, review_by: reviewBy };
  });

  const selectedByRule = suites.filter((item) => selectionRules.some((rule) =>
    item.test_class === rule.test_class && (item.surfaces || []).includes(rule.surface)
  ));
  const selectedIdSet = new Set([
    ...selectedByRule.map((item) => item.id),
    ...mustIncludeIds,
  ]);
  for (const suiteId of exclusionIds) selectedIdSet.delete(suiteId);

  const excludedMustIncludes = mustIncludeIds.filter((suiteId) => exclusionIds.has(suiteId));
  if (excludedMustIncludes.length > 0) {
    throw profileConfigError(
      `${normalizedProfileId} excludes must-include suites: ${excludedMustIncludes.join(", ")}`,
      "excluded_must_include_suite"
    );
  }
  const selectedSuites = suites.filter((item) => selectedIdSet.has(item.id));
  if (selectedSuites.length === 0) {
    throw profileConfigError(`${normalizedProfileId} selected zero suites`, "empty_release_profile");
  }
  const optionalSelected = selectedSuites.filter((item) => item.required === false).map((item) => item.id);
  if (optionalSelected.length > 0) {
    throw profileConfigError(
      `${normalizedProfileId} selected non-required suites: ${optionalSelected.join(", ")}`,
      "optional_release_suite"
    );
  }

  const omittedByRule = suites
    .filter((item) => !selectedIdSet.has(item.id) && !exclusionIds.has(item.id))
    .map((item) => ({ suite_id: item.id, reason: "not_selected_by_profile_rule" }));
  const partitionedIds = [
    ...selectedSuites.map((item) => item.id),
    ...explicitExclusions.map((entry) => entry.suite_id),
    ...omittedByRule.map((entry) => entry.suite_id),
  ];
  if (partitionedIds.length !== suites.length || new Set(partitionedIds).size !== suites.length) {
    throw profileConfigError(`${normalizedProfileId} does not partition the complete suite catalog`, "incomplete_profile_partition");
  }

  return {
    id: normalizedProfileId,
    description: String(definition.description || "").trim(),
    selection_rules: selectionRules,
    must_include_suite_ids: mustIncludeIds,
    selected_suite_ids: selectedSuites.map((item) => item.id),
    explicit_exclusions: explicitExclusions,
    omitted_by_rule: omittedByRule,
    catalog_suite_count: suites.length,
    selected_suite_count: selectedSuites.length,
    explicit_exclusion_count: explicitExclusions.length,
    omitted_by_rule_count: omittedByRule.length,
    selected_suites: selectedSuites,
  };
}

function validateProfileArgs(args) {
  if (!args.profile) return;
  const incompatible = [];
  if (args.only.length > 0) incompatible.push("--only");
  if (args.phase !== "all") incompatible.push("--phase");
  if (args.changedFiles.length > 0) incompatible.push("--changed-files");
  if (!args.writeManifest) incompatible.push("--no-manifest");
  if (incompatible.length > 0) {
    throw profileConfigError(
      `--profile cannot be combined with ${incompatible.join(", ")}`,
      "unsafe_release_profile_narrowing"
    );
  }
}

function profileFailureReport(error, profileId = null) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: null,
    run_started_at: null,
    run_finished_at: new Date().toISOString(),
    ok: false,
    status: "FAIL",
    overall_status: "fail",
    profile: profileId ? { id: profileId } : null,
    checks: [],
    results: [],
    scores: buildQualityScores([]),
    summary: {
      total: 0,
      passed: 0,
      warned: 0,
      skipped: 0,
      not_applicable: 0,
      not_implemented: 0,
      failed: 1,
      functional_proof_tests: 0,
      quality_score_evaluations: 0,
      quality_score: null,
      iv_score: null,
      ritual_score: null,
    },
    issues: [{
      code: error?.code || "invalid_release_profile",
      suite_id: null,
      message: error?.message || String(error),
    }],
  };
}

function normalizeResult(item, result) {
  const candidate = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const candidateStatus = String(candidate.status || "").trim().toUpperCase();
  const invalidReasons = [];
  if (candidate.id !== item.id) invalidReasons.push("id_mismatch");
  if (!RESULT_STATUSES.has(candidateStatus)) invalidReasons.push("unknown_status");
  if (!Number.isInteger(candidate.exit_code)) invalidReasons.push("exit_code_missing");
  if (typeof candidate.timed_out !== "boolean") invalidReasons.push("timed_out_missing");
  if (typeof candidate.started_at !== "string" || !candidate.started_at.trim()) invalidReasons.push("started_at_missing");
  if (typeof candidate.finished_at !== "string" || !candidate.finished_at.trim()) invalidReasons.push("finished_at_missing");
  if (candidateStatus === "PASS" && candidate.exit_code !== 0) invalidReasons.push("pass_exit_code_nonzero");
  if (candidateStatus === "WARN" && candidate.exit_code !== 0) invalidReasons.push("warn_exit_code_nonzero");
  if (candidateStatus === "PASS" && candidate.timed_out === true) invalidReasons.push("pass_marked_timed_out");
  if (candidateStatus === "TIMEOUT" && candidate.timed_out !== true) invalidReasons.push("timeout_not_marked");
  if (candidateStatus === "TIMEOUT" && candidate.exit_code === 0) invalidReasons.push("timeout_exit_code_zero");
  if (candidateStatus && candidateStatus !== "TIMEOUT" && candidate.timed_out === true) invalidReasons.push("non_timeout_marked_timed_out");
  const expectedManifestStatus = toManifestStatus(candidateStatus);
  if (
    typeof candidate.manifest_status === "string"
    && candidate.manifest_status.trim().toLowerCase() !== expectedManifestStatus
  ) invalidReasons.push("manifest_status_mismatch");

  const invalid = invalidReasons.length > 0;
  const invalidDetail = invalid ? `invalid suite result: ${invalidReasons.join(",")}` : "";
  const rawStderr = [
    candidate.raw_stderr ?? candidate.stderr_excerpt ?? "",
    invalidDetail,
  ].filter(Boolean).join("\n");
  const status = invalid ? "FAIL" : candidateStatus;
  return {
    id: item.id,
    name: candidate.name || candidate.id || item.id,
    category: candidate.category || item.category,
    test_class: normalizeTestClass(candidate.test_class || item.test_class),
    test_class_label: candidate.test_class_label || TEST_CLASS_LABELS[normalizeTestClass(candidate.test_class || item.test_class)],
    label: candidate.label || item.label,
    required: item.required !== false,
    command: candidate.command || item.display_command,
    status,
    manifest_status: invalid ? "fail" : expectedManifestStatus,
    status_reason: invalid ? "invalid_suite_result" : candidate.status_reason || "",
    missing_fixtures: candidate.missing_fixtures || [],
    surfaces: candidate.surfaces || item.surfaces || [item.category],
    phases: candidate.phases || item.phases || [],
    exit_code: invalid ? 70 : candidate.exit_code,
    timed_out: invalid ? false : candidate.timed_out,
    duration_ms: candidate.duration_ms ?? 0,
    started_at: candidate.started_at || null,
    finished_at: candidate.finished_at || null,
    stdout_excerpt: candidate.stdout_excerpt || "",
    stderr_excerpt: invalid ? captureExcerpt(rawStderr) : candidate.stderr_excerpt || "",
    raw_stdout: candidate.raw_stdout ?? candidate.stdout_excerpt ?? "",
    raw_stderr: rawStderr,
    injected: !!candidate.injected,
  };
}

async function executeDirectSuiteWave(items, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  repoRoot = REPO_ROOT,
  planTarget = null,
} = {}) {
  const waveItems = Array.isArray(items) ? items : [];
  if (waveItems.length !== 2 || new Set(waveItems.map((item) => item?.id)).size !== 2) {
    throw new Error("direct suite wave requires exactly two unique suite IDs");
  }
  if (waveItems.some((item) => !Array.isArray(item?.command) || item.command.length === 0 || typeof item.run === "function")) {
    throw new Error("direct suite wave requires two ordinary command suites");
  }
  const missingFixtures = waveItems.flatMap((item) => missingRequiredFixtures(item, repoRoot));
  if (missingFixtures.length > 0) {
    throw new Error(`direct suite wave has missing fixture(s): ${[...new Set(missingFixtures)].join(", ")}`);
  }

  const records = waveItems.map((item) => ({
    item,
    child: null,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    stdout: "",
    stderr: "",
    outputBytes: 0,
    outputExceeded: false,
    timedOut: false,
    error: null,
    settled: false,
    ownershipComplete: false,
    finish: null,
    timer: null,
    signals: new Set(),
    cleanupErrors: new Set(),
  }));
  let aborting = false;
  let parentSignal = null;
  let forceTimer = null;
  let terminalTimer = null;
  const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
  const groupAlive = (record) => {
    if (record.ownershipComplete || !record.child?.pid) return false;
    if (process.platform === "win32") {
      return record.child.exitCode === null && record.child.signalCode === null;
    }
    try {
      process.kill(-record.child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      record.cleanupErrors.add(`process-group probe failed: ${error?.message || error}`);
      return true;
    }
  };
  const signalRecord = (record, signal) => {
    if (record.ownershipComplete || !record.child?.pid || record.signals.has(signal)) return;
    record.signals.add(signal);
    try {
      if (process.platform === "win32") record.child.kill(signal);
      else process.kill(-record.child.pid, signal);
    } catch (error) {
      if (error?.code === "ESRCH") {
        record.ownershipComplete = true;
        record.child = null;
      } else record.cleanupErrors.add(`process-group ${signal} failed: ${error?.message || error}`);
    }
  };
  const stopAll = (signal) => {
    aborting = true;
    for (const record of records) signalRecord(record, signal);
    if (!forceTimer && records.some((record) => !record.settled || groupAlive(record))) {
      forceTimer = setTimeout(() => {
        for (const record of records) signalRecord(record, "SIGKILL");
        terminalTimer = setTimeout(() => {
          for (const record of records.filter((entry) => !entry.settled)) {
            record.cleanupErrors.add("direct process did not close after SIGKILL");
            void record.finish?.(null, "SIGKILL");
          }
        }, 500);
      }, signal === "SIGKILL" ? 0 : 500);
    }
  };
  const onParentSignal = (signal) => {
    if (parentSignal) return;
    parentSignal = signal;
    stopAll("SIGTERM");
  };
  const onSigint = () => onParentSignal("SIGINT");
  const onSigterm = () => onParentSignal("SIGTERM");
  const onExit = () => records.forEach((record) => signalRecord(record, "SIGKILL"));
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", onExit);

  try {
    const tasks = records.map((record) => new Promise((resolveRecord) => {
      const { item } = record;
      const declaredTimeoutMs = Number.isFinite(item.timeout_ms) && item.timeout_ms > 0
        ? item.timeout_ms
        : timeoutMs;

      const finish = async (code, signal) => {
        if (record.settled) return;
        record.settled = true;
        if (record.timer) clearTimeout(record.timer);
        const commandFailed = record.timedOut || record.outputExceeded || record.error || code !== 0 || !!signal;
        if (commandFailed) stopAll("SIGTERM");

        await wait(25);
        if (groupAlive(record)) {
          signalRecord(record, "SIGTERM");
          await wait(125);
        }
        if (groupAlive(record)) {
          signalRecord(record, "SIGKILL");
          await wait(75);
        }
        const stillAlive = groupAlive(record);
        if (stillAlive) record.cleanupErrors.add("direct process group survived SIGKILL");
        const cleanupFailed = stillAlive || record.cleanupErrors.size > 0;
        record.ownershipComplete = !stillAlive;
        if (record.ownershipComplete) record.child = null;
        if (cleanupFailed) stopAll("SIGKILL");

        const status = cleanupFailed
          ? "FAIL"
          : record.timedOut
            ? "TIMEOUT"
            : record.outputExceeded || record.error || code !== 0 || signal
              ? "FAIL"
              : "PASS";
        const statusReason = cleanupFailed
          ? "direct_process_cleanup_failed"
          : record.timedOut
            ? "direct_process_timeout"
            : record.outputExceeded
              ? "direct_process_output_limit"
            : record.error
              ? "direct_process_spawn_failed"
              : signal
                ? `direct_process_signal_${signal}`
                : code !== 0
                  ? "direct_process_nonzero_exit"
                  : "";
        const failureStderr = [
          record.stderr,
          record.outputExceeded ? `direct process output exceeded ${DIRECT_OUTPUT_LIMIT_BYTES} bytes` : "",
          record.error?.message || "",
          ...record.cleanupErrors,
        ].filter(Boolean).join("\n");
        // Match runExitCodeCheck's established success contract: a zero-exit suite
        // publishes stdout proof but no stderr diagnostic surface.  Failure paths
        // retain the complete captured stderr, and both streams still count toward
        // the direct-transport output limit while the child is running.
        const rawStderr = status === "PASS" ? "" : failureStderr;
        const result = normalizeResult(item, {
          id: item.id,
          status,
          status_reason: statusReason,
          exit_code: record.timedOut ? -1 : Number.isInteger(code) ? code : status === "PASS" ? 0 : 1,
          timed_out: record.timedOut,
          duration_ms: Date.now() - record.startedMs,
          started_at: record.startedAt,
          finished_at: new Date().toISOString(),
          stdout_excerpt: captureExcerpt(record.stdout),
          stderr_excerpt: captureExcerpt(rawStderr),
          raw_stdout: record.stdout,
          raw_stderr: rawStderr,
        });
        resolveRecord([item.id, result]);
      };
      record.finish = finish;

      if (aborting) {
        record.error = new Error("direct suite wave aborted before spawn");
        void finish(null, null);
        return;
      }

      const envOverrides = item.accepts_plan_target === true && planTarget
        ? { _PLANNER_PLAN_TARGET: planTarget }
        : {};
      try {
        record.child = spawn(item.command[0], item.command.slice(1), {
          detached: process.platform !== "win32",
          cwd: repoRoot,
          env: commandEnv(envOverrides),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        record.error = error;
        stopAll("SIGTERM");
        void finish(null, null);
        return;
      }

      record.child.stdout?.setEncoding("utf-8");
      record.child.stderr?.setEncoding("utf-8");
      const appendOutput = (field, chunk) => {
        record.outputBytes += Buffer.byteLength(chunk);
        if (record.outputBytes > DIRECT_OUTPUT_LIMIT_BYTES && !record.outputExceeded) {
          record.outputExceeded = true;
          stopAll("SIGTERM");
        } else if (!record.outputExceeded) record[field] += chunk;
      };
      record.child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
      record.child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
      record.child.once("error", (error) => {
        record.error = error;
        stopAll("SIGTERM");
        queueMicrotask(() => { void finish(null, null); });
      });
      record.child.once("close", (code, signal) => { void finish(code, signal); });
      record.timer = setTimeout(() => {
        record.timedOut = true;
        stopAll("SIGTERM");
      }, declaredTimeoutMs);
    }));

    return new Map(await Promise.all(tasks));
  } finally {
    stopAll("SIGKILL");
    for (let attempt = 0; attempt < 5 && records.some(groupAlive); attempt += 1) {
      await wait(100);
      records.forEach((record) => signalRecord(record, "SIGKILL"));
    }
    for (const record of records.filter((entry) => !groupAlive(entry))) {
      record.ownershipComplete = true;
      record.child = null;
    }
    if (forceTimer) clearTimeout(forceTimer);
    if (terminalTimer) clearTimeout(terminalTimer);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (!parentSignal) {
      process.removeListener("exit", onExit);
    } else {
      records.forEach((record) => signalRecord(record, "SIGKILL"));
      await wait(50);
      process.removeListener("exit", onExit);
      process.kill(process.pid, parentSignal);
      await new Promise(() => {});
    }
  }
}

function syntheticNotApplicableResult(changedFiles) {
  const message = `No IVE conformance suite matched changed files: ${changedFiles.join(", ") || "(none)"}`;
  return {
    id: "changed-files-not-applicable",
    name: "changed-files-not-applicable",
    category: "selection",
    label: "Changed files outside declared IVE surfaces",
    required: false,
    command: "changed-files selector",
    status: "NOT_APPLICABLE",
    manifest_status: "not_applicable",
    status_reason: "changed_files_outside_declared_ive_surfaces",
    exit_code: 0,
    timed_out: false,
    duration_ms: 0,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    stdout_excerpt: message,
    stderr_excerpt: "",
    raw_stdout: message,
    raw_stderr: "",
    surfaces: ["selection"],
    phases: [],
  };
}

function publicResult(result) {
  const { raw_stdout, raw_stderr, ...rest } = result;
  return rest;
}

function writeRunArtifacts(report, {
  repoRoot = REPO_ROOT,
  reportRoot = REPORT_ROOT,
} = {}) {
  const resolvedReportRoot = resolve(reportRoot);
  const reportDir = resolve(resolvedReportRoot, report.run_id);
  const reportRelative = relative(resolvedReportRoot, reportDir);
  if (!reportRelative || reportRelative.startsWith(`..${sep}`) || reportRelative === ".." || isAbsolute(reportRelative)) {
    return { ok: false, reason: "run artifact directory must be a strict child of reportRoot" };
  }
  const logsDir = join(reportDir, "logs");
  try {
    mkdirSync(logsDir, { recursive: true });
    const artifactRepoStateStamp = buildRepoStateStamp({
      cwd: repoRoot,
      invocation: {
        command: "tests/ive/run.mjs",
        run_id: report.run_id,
        phase: report.phase,
      },
    });
    for (const result of report.results) {
      const stdoutPath = join(logsDir, `${result.id}.stdout.log`);
      const stderrPath = join(logsDir, `${result.id}.stderr.log`);
      const artifactPath = join(reportDir, `${result.id}.json`);
      writeFileSync(stdoutPath, result.raw_stdout || result.stdout_excerpt || "");
      writeFileSync(stderrPath, result.raw_stderr || result.stderr_excerpt || "");
      result.stdout_log = repoRelPath(stdoutPath, repoRoot);
      result.stderr_log = repoRelPath(stderrPath, repoRoot);
      result.proof_artifact = repoRelPath(artifactPath, repoRoot);
      writeFileSync(artifactPath, JSON.stringify({
        ...publicResult(result),
        repo_state_stamp: report.repo_state_stamp || artifactRepoStateStamp,
      }, null, 2) + "\n");
    }

    const manifestPath = join(reportDir, "manifest.json");
    report.report_dir = repoRelPath(reportDir, repoRoot);
    report.manifest_path = repoRelPath(manifestPath, repoRoot);
    report.suites = report.results.map((result) => ({
      id: result.id,
      surface: result.surfaces?.[0] || result.category,
      category: result.category,
      test_class: result.test_class,
      test_class_label: result.test_class_label,
      status: result.manifest_status,
      status_reason: result.status_reason || "",
      required: result.required,
      command: result.command,
      proof_artifact: result.proof_artifact,
      stdout_log: result.stdout_log,
      stderr_log: result.stderr_log,
    }));
    report.findings = findingsFromIveReport(report);
    const manifest = {
      schema_version: SCHEMA_VERSION,
      run_id: report.run_id,
      phase: report.phase,
      changed_files: report.changed_files,
      suites: report.suites,
      overall_status: report.overall_status,
      scores: report.scores,
      summary: report.summary,
      issues: report.issues,
      findings: report.findings,
      repo_state_stamp: report.repo_state_stamp || artifactRepoStateStamp,
      ...(report.profile ? { profile: report.profile } : {}),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { ok: true, manifest_path: report.manifest_path, report_dir: report.report_dir };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function runConformance({
  suites = DEFAULT_SUITES,
  only = [],
  phase = "all",
  changedFiles = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minimumTimeoutMs = null,
  executeCommand = executeSuite,
  writeManifest = false,
  runId = null,
  repoRoot = REPO_ROOT,
  reportRoot = REPORT_ROOT,
  profile = null,
  planTarget = null,
  runStartedAt = null,
} = {}) {
  const effectiveRunId = sanitizeRunId(runId);
  if (profile) {
    const activeIds = suites.map((item) => item.id);
    const governedIds = Array.isArray(profile.selected_suite_ids) ? profile.selected_suite_ids : [];
    if (
      activeIds.length !== governedIds.length
      || activeIds.some((suiteId, index) => suiteId !== governedIds[index])
    ) {
      throw profileConfigError(
        `${profile.id || "release profile"} suite execution does not match its governed selection`,
        "release_profile_selection_mismatch"
      );
    }
  }
  const effectiveRunStartedAt = runStartedAt || new Date().toISOString();
  const sourceRepoStateStamp = profile
    ? buildRepoStateStamp({
      cwd: repoRoot,
      invocation: {
        command: "tests/ive/run.mjs",
        profile: profile.id,
        phase,
      },
    })
    : null;
  const normalizedChangedFiles = splitChangedFiles(changedFiles);
  const baseSelected = suites.filter((item) => selectedByOnly(item, only) && selectedByPhase(item, phase));
  const selected = normalizedChangedFiles.length
    ? baseSelected.filter((item) => selectedByChangedFiles(item, normalizedChangedFiles))
    : baseSelected;
  const issues = [];

  if (baseSelected.length === 0) {
    issues.push({
      code: "no_matching_suite",
      suite_id: null,
      message: `No IVE conformance suite matched only=${only.join(",") || "*"} phase=${phase || "all"}`,
    });
  }

  const results = selected.map((item) => {
    const declaredTimeoutMs = Number.isFinite(item.timeout_ms) && item.timeout_ms > 0
      ? item.timeout_ms
      : timeoutMs;
    const effectiveTimeoutMs = Number.isFinite(minimumTimeoutMs) && minimumTimeoutMs > 0
      ? Math.max(declaredTimeoutMs, minimumTimeoutMs)
      : declaredTimeoutMs;
    return normalizeResult(
      item,
      executeCommand(item, {
        timeoutMs: effectiveTimeoutMs,
        repoRoot,
        planTarget,
      })
    );
  });

  if (baseSelected.length > 0 && normalizedChangedFiles.length > 0 && selected.length === 0) {
    results.push(syntheticNotApplicableResult(normalizedChangedFiles));
  }

  const failedRequired = [];
  let warningCount = 0;
  let skippedCount = 0;
  let notApplicableCount = 0;
  let notImplementedCount = 0;

  for (const result of results) {
    if (result.status === "WARN") warningCount += 1;
    if (result.status === "SKIPPED") skippedCount += 1;
    if (result.status === "NOT_APPLICABLE") notApplicableCount += 1;
    if (result.status === "NOT_IMPLEMENTED_YET") notImplementedCount += 1;

    if (result.status_reason === "invalid_suite_result") {
      issues.push({
        code: "invalid_suite_result",
        suite_id: result.id,
        message: `${result.id} returned malformed or incoherent result metadata`,
      });
    }

    if (result.status === "NOT_APPLICABLE" && !result.status_reason) {
      issues.push({
        code: "not_applicable_without_reason",
        suite_id: result.id,
        message: `${result.id} reported NOT_APPLICABLE without a status_reason`,
      });
    }

    if (result.status === "SKIPPED" && !result.status_reason) {
      issues.push({
        code: "skipped_without_reason",
        suite_id: result.id,
        message: `${result.id} reported SKIPPED without a status_reason`,
      });
    }

    if (result.required && FAILING_STATUSES.has(result.status)) {
      failedRequired.push(result);
      issues.push({
        code: result.status === "NOT_IMPLEMENTED_YET"
          ? "required_fixture_missing"
          : result.timed_out ? "required_suite_timeout" : "required_suite_failed",
        suite_id: result.id,
        message: `${result.id} reported ${result.status}`,
        missing_fixtures: result.missing_fixtures || [],
      });
    }
    if (profile && result.status !== "PASS") {
      issues.push({
        code: "profile_suite_non_pass",
        suite_id: result.id,
        message: `${profile.id} requires PASS but ${result.id} reported ${result.status}`,
      });
    }
  }

  const passedCount = results.filter((result) => result.status === "PASS").length;
  const status = statusForReport({ issues, warningCount, skippedCount });
  const allNotApplicable = results.length > 0 && results.every((result) => result.manifest_status === "not_applicable");
  const overallStatus = status === "FAIL"
    ? "fail"
    : warningCount > 0 || skippedCount > 0 ? "warn" : allNotApplicable ? "not_applicable" : "pass";
  const scores = buildQualityScores(results);
  const report = {
    schema_version: SCHEMA_VERSION,
    run_id: effectiveRunId,
    phase,
    changed_files: normalizedChangedFiles,
    run_started_at: effectiveRunStartedAt,
    run_finished_at: new Date().toISOString(),
    ok: issues.length === 0,
    status,
    overall_status: overallStatus,
    command_count: results.length,
    passed_count: passedCount,
    failed_required_count: failedRequired.length,
    warning_count: warningCount,
    skipped_count: skippedCount,
    not_applicable_count: notApplicableCount,
    not_implemented_count: notImplementedCount,
    categories: [...new Set(results.map((result) => result.category))],
    test_classes: [...new Set(results.map((result) => result.test_class))],
    scores,
    results,
    checks: results,
    summary: {
      total: results.length,
      passed: passedCount,
      warned: warningCount,
      skipped: skippedCount,
      not_applicable: notApplicableCount,
      not_implemented: notImplementedCount,
      failed: results.filter((result) => FAILING_STATUSES.has(result.status) || result.status === "FAIL").length,
      functional_proof_tests: results.filter((result) => result.test_class === TEST_CLASS_FUNCTIONAL_PROOF).length,
      quality_score_evaluations: results.filter((result) => result.test_class === TEST_CLASS_QUALITY_SCORE).length,
      quality_score: scores.quality_score.current,
      iv_score: scores.iv_score.current,
      ritual_score: scores.ritual_score.current,
    },
    issues,
    ...(profile ? {
      profile: {
        id: profile.id,
        description: profile.description,
        selection_rules: profile.selection_rules,
        must_include_suite_ids: profile.must_include_suite_ids,
        selected_suite_ids: profile.selected_suite_ids,
        explicit_exclusions: profile.explicit_exclusions,
        omitted_by_rule: profile.omitted_by_rule,
        catalog_suite_count: profile.catalog_suite_count,
        selected_suite_count: profile.selected_suite_count,
        explicit_exclusion_count: profile.explicit_exclusion_count,
        omitted_by_rule_count: profile.omitted_by_rule_count,
      },
      repo_state_stamp: sourceRepoStateStamp,
    } : {}),
  };

  if (writeManifest) {
    const artifactResult = writeRunArtifacts(report, { repoRoot, reportRoot });
    if (!artifactResult.ok) {
      report.issues.push({
        code: "manifest_write_failed",
        suite_id: null,
        message: artifactResult.reason,
      });
      report.ok = false;
      report.status = "FAIL";
      report.overall_status = "fail";
    }
  }

  if (!Array.isArray(report.findings)) {
    report.findings = findingsFromIveReport(report);
  }
  report.results = report.results.map(publicResult);
  report.checks = report.results;

  const injectedTarget = process.env.IVE_RUNNER_INJECT_FAILURE || null;
  if (injectedTarget) {
    report.runner_metadata = {
      injected_failures: results.filter((result) => result.injected).map((result) => result.id),
    };
  }

  return report;
}

function resolveDirectSuiteWaves(suites = DEFAULT_SUITES, repoRoot = REPO_ROOT) {
  const catalog = Array.isArray(suites) ? suites : [];
  const catalogIds = catalog.map((item) => item?.id).filter((id) => typeof id === "string" && id);
  const catalogIndex = new Map(catalog.map((item, index) => [item?.id, index]));
  const allIds = DIRECT_SUITE_WAVE_IDS.flat();
  const waves = DIRECT_SUITE_WAVE_IDS.map((ids) => ({
    ids,
    items: ids.map((id) => catalog.find((item) => item?.id === id)),
  }));
  const membershipHealthy = catalogIds.length === catalog.length
    && catalogIds.length === new Set(catalogIds).size
    && allIds.length === new Set(allIds).size
    && waves.every(({ ids, items }) => (
      ids.length === 2
      && ids[0] !== ids[1]
      && items.every(Boolean)
      && ids.every((id) => catalog.filter((item) => item?.id === id).length === 1)
      && catalogIndex.get(ids[0]) < catalogIndex.get(ids[1])
    ));
  const executionHealthy = membershipHealthy && waves.every(({ items }) => items.every((item) => (
    item.required !== false
    && Array.isArray(item.command)
    && item.command.length > 0
    && typeof item.run !== "function"
    && missingRequiredFixtures(item, repoRoot).length === 0
  )));
  const fixtureIsolationHealthy = executionHealthy && waves.every(({ items }) => {
    const leftFixtures = new Set(Array.isArray(items[0]?.fixtures) ? items[0].fixtures : []);
    const rightFixtures = Array.isArray(items[1]?.fixtures) ? items[1].fixtures : [];
    return rightFixtures.every((fixture) => !leftFixtures.has(fixture));
  });
  return {
    healthy: membershipHealthy && executionHealthy && fixtureIsolationHealthy,
    wave_count: waves.length,
    suite_count: allIds.length,
    waves,
    checks: {
      unique_ordered_membership: membershipHealthy,
      executable_required_suites: executionHealthy,
      pair_fixture_isolation: fixtureIsolationHealthy,
    },
  };
}

function directSchedulingFailure(runStartedAt, detail, reason = "invalid_direct_wave_result") {
  return {
    status: "FAIL",
    status_reason: reason,
    exit_code: 70,
    timed_out: false,
    started_at: runStartedAt,
    finished_at: new Date().toISOString(),
    stderr_excerpt: captureExcerpt(detail),
    raw_stderr: detail,
  };
}

async function prepareDirectConformanceResults({
  suites = DEFAULT_SUITES,
  directWavePlan = null,
  executeWave = executeDirectSuiteWave,
  executeCommand = executeSuite,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minimumTimeoutMs = null,
  repoRoot = REPO_ROOT,
  planTarget = null,
  runStartedAt = new Date().toISOString(),
} = {}) {
  const resolvedWavePlan = directWavePlan || resolveDirectSuiteWaves(suites, repoRoot);
  if (!resolvedWavePlan?.healthy) {
    throw new Error("direct suite wave plan must be healthy before scheduling");
  }
  const precomputedResults = new Map();
  const waveByTrigger = new Map(resolvedWavePlan.waves.map((wave) => [wave.ids[0], wave]));
  for (const item of suites) {
    if (precomputedResults.has(item.id)) continue;
    const wave = waveByTrigger.get(item.id);
    if (wave) {
      const { ids: waveIds, items: waveItems } = wave;
      let waveResults;
      let detail = "";
      try {
        waveResults = await executeWave(waveItems, {
          timeoutMs,
          repoRoot,
          planTarget,
        });
      } catch (error) {
        detail = error?.message || String(error);
      }
      const validWave = waveResults instanceof Map
        && waveResults.size === waveIds.length
        && waveIds.every((id) => {
          const result = waveResults.get(id);
          if (result?.id !== id) return false;
          const waveItem = waveItems.find((entry) => entry.id === id);
          const normalized = normalizeResult(waveItem, result);
          if (normalized.status_reason === "invalid_suite_result") {
            detail ||= `${id}: ${normalized.stderr_excerpt}`;
            return false;
          }
          return true;
        });
      if (!validWave) {
        detail ||= `invalid direct wave result: ${waveResults instanceof Map ? `size=${waveResults.size}` : "not-a-map"}`;
        for (const waveItem of waveItems) {
          precomputedResults.set(waveItem.id, {
            id: waveItem.id,
            ...directSchedulingFailure(runStartedAt, detail),
          });
        }
      } else {
        waveIds.forEach((id) => precomputedResults.set(id, waveResults.get(id)));
      }
      continue;
    }

    const declaredTimeoutMs = Number.isFinite(item.timeout_ms) && item.timeout_ms > 0
      ? item.timeout_ms
      : timeoutMs;
    const effectiveTimeoutMs = Number.isFinite(minimumTimeoutMs) && minimumTimeoutMs > 0
      ? Math.max(declaredTimeoutMs, minimumTimeoutMs)
      : declaredTimeoutMs;
    precomputedResults.set(item.id, executeCommand(item, {
      timeoutMs: effectiveTimeoutMs,
      repoRoot,
      planTarget,
    }));
  }
  return precomputedResults;
}

async function runConformanceLive({
  suites = DEFAULT_SUITES,
  only = [],
  phase = "all",
  changedFiles = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minimumTimeoutMs = null,
  executeCommand = executeSuite,
  writeManifest = false,
  runId = null,
  repoRoot = REPO_ROOT,
  reportRoot = REPORT_ROOT,
  profile = null,
  planTarget = null,
  invocationArgv = [],
} = {}) {
  const effectiveRunId = sanitizeRunId(runId);
  const directWavePlan = resolveDirectSuiteWaves(suites, repoRoot);
  const rawArgs = Array.isArray(invocationArgv) ? invocationArgv : [];
  let invocationIsExact = true;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--json") continue;
    if (arg === "--run-id" || arg === "--plan-target") {
      const value = rawArgs[index + 1];
      if (!value || String(value).startsWith("--")) {
        invocationIsExact = false;
        break;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--run-id=") || arg.startsWith("--plan-target=")) {
      if (!arg.slice(arg.indexOf("=") + 1)) invocationIsExact = false;
      continue;
    }
    invocationIsExact = false;
    break;
  }

  const eligible = isDirectInvocation(import.meta.url)
    && invocationIsExact
    && suites === DEFAULT_SUITES
    && executeCommand === executeSuite
    && only.length === 0
    && phase === "all"
    && splitChangedFiles(changedFiles).length === 0
    && timeoutMs === DEFAULT_TIMEOUT_MS
    && minimumTimeoutMs === null
    && writeManifest === true
    && profile === null
    && !process.env.IVE_RUNNER_INJECT_FAILURE
    && directWavePlan.healthy;

  if (!eligible) {
    return runConformance({
      suites,
      only,
      phase,
      changedFiles,
      timeoutMs,
      minimumTimeoutMs,
      executeCommand,
      writeManifest,
      runId: effectiveRunId,
      repoRoot,
      reportRoot,
      profile,
      planTarget,
    });
  }

  const runStartedAt = new Date().toISOString();
  const precomputedResults = await prepareDirectConformanceResults({
    suites,
    directWavePlan,
    executeWave: executeDirectSuiteWave,
    executeCommand,
    timeoutMs,
    minimumTimeoutMs,
    repoRoot,
    planTarget,
    runStartedAt,
  });

  return runConformance({
    suites,
    only,
    phase,
    changedFiles,
    timeoutMs,
    minimumTimeoutMs,
    executeCommand: (item) => precomputedResults.get(item.id)
      || {
        id: item.id,
        ...directSchedulingFailure(
          runStartedAt,
          `Missing prepared result for ${item.id}`,
          "invalid_precomputed_result",
        ),
      },
    writeManifest,
    runId: effectiveRunId,
    repoRoot,
    reportRoot,
    profile,
    planTarget,
    runStartedAt,
  });
}

function listSuites(suites = DEFAULT_SUITES) {
  return {
    ok: true,
    status: "LIST",
    suite_count: suites.length,
    suites: suites.map((item) => ({
      id: item.id,
      category: item.category,
      test_class: item.test_class,
      test_class_label: item.test_class_label,
      label: item.label,
      required: item.required !== false,
      phases: item.phases || [],
      surfaces: item.surfaces || [item.category],
      fixtures: item.fixtures || [],
      changed_file_patterns: (item.changed_file_patterns || []).map((pattern) => pattern.toString()),
      command: item.display_command,
    })),
  };
}

function parseArgs(argv = []) {
  const parsed = {
    json: false,
    list: false,
    only: [],
    phase: "all",
    changedFiles: [],
    runId: null,
    profile: null,
    planTarget: null,
    writeManifest: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    minimumTimeoutMs: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--only") parsed.only.push(argv[++index] || "");
    else if (arg.startsWith("--only=")) parsed.only.push(arg.slice("--only=".length));
    else if (arg === "--phase") parsed.phase = argv[++index] || "all";
    else if (arg.startsWith("--phase=")) parsed.phase = arg.slice("--phase=".length) || "all";
    else if (arg === "--changed-files") parsed.changedFiles.push(argv[++index] || "");
    else if (arg.startsWith("--changed-files=")) parsed.changedFiles.push(arg.slice("--changed-files=".length));
    else if (arg === "--run-id") parsed.runId = argv[++index] || null;
    else if (arg.startsWith("--run-id=")) parsed.runId = arg.slice("--run-id=".length) || null;
    else if (arg === "--profile") parsed.profile = argv[++index] || null;
    else if (arg.startsWith("--profile=")) parsed.profile = arg.slice("--profile=".length) || null;
    else if (arg === "--plan-target") parsed.planTarget = argv[++index] || null;
    else if (arg.startsWith("--plan-target=")) parsed.planTarget = arg.slice("--plan-target=".length) || null;
    else if (arg === "--no-manifest") parsed.writeManifest = false;
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number.parseInt(argv[++index] || "", 10);
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = Number.parseInt(arg.slice("--timeout-ms=".length), 10);
    else if (arg === "--minimum-timeout-ms") parsed.minimumTimeoutMs = Number.parseInt(argv[++index] || "", 10);
    else if (arg.startsWith("--minimum-timeout-ms=")) parsed.minimumTimeoutMs = Number.parseInt(arg.slice("--minimum-timeout-ms=".length), 10);
  }

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    parsed.timeoutMs = DEFAULT_TIMEOUT_MS;
  }
  if (!Number.isFinite(parsed.minimumTimeoutMs) || parsed.minimumTimeoutMs <= 0) {
    parsed.minimumTimeoutMs = null;
  }

  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/tests/ive/run.mjs [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --list [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --only <id-or-category> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --phase <phase-id> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --changed-files <file-list> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --run-id <stable-id> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --minimum-timeout-ms <milliseconds> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --profile <profile-id> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --plan-target <plan-dir-name> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --no-manifest [--json]`;
}

function printText(report) {
  if (report.status === "LIST") {
    console.log(`IVE conformance suites: ${report.suite_count}`);
    for (const item of report.suites) {
      console.log(`  - ${item.id} [${item.category}; ${item.test_class}] ${item.command}`);
    }
    return;
  }
  if (report.status === "FAIL" && !report.run_started_at) {
    console.log("IVE conformance runner: FAIL");
    for (const issue of report.issues || []) console.log(`  ${issue.code}: ${issue.message}`);
    return;
  }

  console.log(`IVE conformance runner: ${report.status}`);
  console.log(`  started:  ${report.run_started_at}`);
  console.log(`  finished: ${report.run_finished_at}`);
  console.log(`  checks:   ${report.summary.passed} passed / ${report.summary.failed} failed`);
  console.log(`  quality score: ${report.scores.quality_score.current ?? "n/a"} (${report.scores.quality_score.source_status})`);
  console.log(`  IV score:      ${report.scores.iv_score.current ?? "n/a"} (${report.scores.iv_score.source_status})`);
  console.log(`  ritual score:  ${report.scores.ritual_score.current ?? "n/a"} (${report.scores.ritual_score.source_status})`);
  console.log();
  for (const result of report.results) {
    const icon = result.status === "PASS" ? "PASS" : result.status === "SKIPPED" ? "SKIP" : "FAIL";
    console.log(`  ${icon} ${result.name} (${result.duration_ms}ms, exit ${result.exit_code})`);
    if (result.status !== "PASS") {
      const excerpt = (result.stderr_excerpt || result.stdout_excerpt || "").split("\n").slice(0, 5).join("\n");
      if (excerpt) console.log(excerpt.split("\n").map((line) => `      ${line}`).join("\n"));
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  let report;
  try {
    validateProfileArgs(args);
    const profile = args.profile
      ? resolveReleaseProfile({ profileId: args.profile, suites: DEFAULT_SUITES })
      : null;
    const suites = profile ? profile.selected_suites : DEFAULT_SUITES;
    report = args.list
      ? {
        ...listSuites(suites),
        ...(profile ? { profile: {
          ...profile,
          selected_suites: undefined,
        } } : {}),
      }
      : await runConformanceLive({
        suites,
        only: args.only,
        phase: args.phase,
        changedFiles: args.changedFiles,
        timeoutMs: args.timeoutMs,
        minimumTimeoutMs: args.minimumTimeoutMs,
        runId: args.runId,
        writeManifest: args.writeManifest,
        profile,
        planTarget: args.planTarget,
        invocationArgv: argv,
      });
  } catch (error) {
    report = profileFailureReport(error, args.profile);
  }

  if (args.json) emitJson(report);
  else printText(report);
  return report.status === "FAIL" ? 1 : 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = await main();
}

export {
  classifyHarvestRealTelemetryHostResult,
  DEFAULT_SUITES,
  DIRECT_SUITE_WAVE_IDS,
  executeDirectSuiteWave,
  listSuites,
  parseArgs,
  prepareDirectConformanceResults,
  readReleaseProfiles,
  resolveDirectSuiteWaves,
  resolveReleaseProfile,
  runVisualizerBrowserProof,
  runConformance,
  selectSuites,
  visualizerProofPortCandidates,
};
