#!/usr/bin/env node
// test_cli_determinism.mjs - n01 regression suite for planner JSON CLI determinism.

import { spawnSync } from "child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { writeIssueHistoryCache } from "../scripts/lib/issue_history_cache.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const scriptsDir = join(skillDir, "scripts");
const repoRoot = resolve(skillDir, "..", "..", "..");
const conformanceRunnerPath = join(testDir, "ive", "run.mjs");
const NODE = process.execPath;
const MAX_BUFFER = 40 * 1024 * 1024;
const LARGE_JSON_BYTES = 16 * 1024;
const FIXED_TIMESTAMP = "2026-01-01T00:00:00Z";

const declaredVolatileTimeFields = new Set([
  "as_of",
  "checked_at",
  "collected_at",
  "completed_at",
  "created_at",
  "emitted_at",
  "executed_at",
  "expires_at",
  "generated_at",
  "report_timestamp",
  "rolled_back_at",
  "run_at",
  "timestamp",
  "updated_at",
  "validated_at",
]);

const executableDescriptors = [
  {
    fileName: "coverage_baseline.mjs",
    label: "coverage_baseline canonical check",
    args: ({ skillDir }) => [scriptPath(skillDir, "coverage_baseline.mjs"), "check", "--json", "--no-head"],
  },
  {
    fileName: "test_gate_census.mjs",
    label: "test_gate_census canonical report",
    args: ({ skillDir }) => [scriptPath(skillDir, "test_gate_census.mjs"), "--json"],
  },
  {
    fileName: "irreversible_action_gate.mjs",
    label: "irreversible action draft boundary",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "irreversible_action_gate.mjs"),
      "check",
      "--action-class",
      "send_email",
      "--mode",
      "draft",
      "--target",
      "determinism@example.invalid",
      "--payload-ref",
      "fixture:draft",
      "--json",
    ],
  },
  {
    fileName: "knowledge_packs.mjs",
    label: "knowledge_packs machine_learning",
    args: ({ skillDir }) => [scriptPath(skillDir, "knowledge_packs.mjs"), "--pack", "machine_learning", "--json"],
    minBytes: LARGE_JSON_BYTES,
  },
  {
    fileName: "project_ive.mjs",
    label: "project_ive plan replay",
    delegatedJsonFlag: "scripts/lib/ive_projection.mjs",
    args: ({ skillDir }) => [scriptPath(skillDir, "project_ive.mjs"), "--plans", "10", "--json"],
    minBytes: LARGE_JSON_BYTES,
  },
  {
    fileName: "reflection_guide.mjs",
    label: "reflection_guide fixture",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "reflection_guide.mjs"), "--plan", "plan_emit_json", "--json"],
    cwd: ({ fixtures }) => fixtures.reflectionRoot,
  },
  {
    fileName: "validate_reflection.mjs",
    label: "validate_reflection missing file",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "validate_reflection.mjs"), fixtures.missingReflectionPath, "--json"],
    stream: "stderr",
  },
  {
    fileName: "ive_packet_validator.mjs",
    label: "ive_packet_validator large failure",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "ive_packet_validator.mjs"), fixtures.largePacketPath, "--json"],
    minBytes: LARGE_JSON_BYTES,
  },
  {
    fileName: "check_profile.mjs",
    label: "check_profile quant_alpha",
    args: ({ skillDir }) => [scriptPath(skillDir, "check_profile.mjs"), "--profile", "quant_alpha", "--gate", "plan-to-execute", "--json", "--no-cache"],
  },
  {
    fileName: "contract_reliability.mjs",
    label: "contract_reliability registry",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "contract_reliability.mjs"), "check", "--registry", fixtures.contractRegistryPath, "--json"],
  },
  {
    fileName: "behavior_report.mjs",
    label: "behavior_report over a fixture plans dir",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "behavior_report.mjs"), "--plans-dir", join(fixtures.autonomousRoot, "plans"), "--json"],
  },
  {
    fileName: "ritual_replay.mjs",
    label: "ritual_replay real telemetry corpus",
    args: ({ skillDir }) => [scriptPath(skillDir, "ritual_replay.mjs"), "--json"],
  },
  {
    fileName: "dogfood_lifecycle_replay.mjs",
    label: "dogfood_lifecycle_replay committed corpus",
    args: ({ skillDir }) => [scriptPath(skillDir, "dogfood_lifecycle_replay.mjs"), "--json"],
  },
  {
    fileName: "autonomous_dogfood_run.mjs",
    label: "autonomous_dogfood_run fresh receipt advisory",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "autonomous_dogfood_run.mjs"),
      "freshness",
      "--receipt-root",
      fixtures.autonomousDogfoodReceiptRoot,
      "--now",
      FIXED_TIMESTAMP,
      "--json",
    ],
  },
  {
    fileName: "autonomous_ticket_delivery.mjs",
    label: "production autonomous ticket delivery large PASS fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "autonomous_ticket_delivery.mjs"),
      "run",
      "--program",
      "plans/programs/delivery/program_packet.json",
      "--ticket",
      "T-DELIVERY-PASS",
      "--agent-cmd",
      "node fixture_agent.mjs",
      "--verification-cmd",
      "node -e \"process.exit(0)\"",
      "--workspace-parent",
      fixtures.autonomousTicketPassRoot,
      "--json",
    ],
    cwd: ({ fixtures }) => fixtures.autonomousTicketPassRoot,
    minBytes: LARGE_JSON_BYTES,
    expectedStatus: 0,
  },
  {
    fileName: "autonomous_ticket_delivery.mjs",
    label: "production autonomous ticket delivery large FAIL fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "autonomous_ticket_delivery.mjs"),
      "run",
      "--program",
      "plans/programs/delivery/program_packet.json",
      "--ticket",
      "T-DELIVERY-FAIL",
      "--agent-cmd",
      "node fixture_agent.mjs",
      "--verification-cmd",
      "node -e \"process.exit(0)\"",
      "--workspace-parent",
      fixtures.autonomousTicketFailRoot,
      "--json",
    ],
    cwd: ({ fixtures }) => fixtures.autonomousTicketFailRoot,
    minBytes: LARGE_JSON_BYTES,
    expectedStatus: 1,
  },
  {
    fileName: "ab_task_benchmark.mjs",
    label: "ab_task_benchmark sample",
    args: ({ skillDir }) => [scriptPath(skillDir, "ab_task_benchmark.mjs"), "--json", "--sample"],
  },
  {
    fileName: "ideation_quality_benchmark.mjs",
    label: "ideation_quality_benchmark default corpus",
    args: ({ skillDir }) => [scriptPath(skillDir, "ideation_quality_benchmark.mjs"), "--json"],
  },
  {
    fileName: "insight_velocity_report.mjs",
    label: "insight_velocity_report current-code report",
    args: ({ skillDir }) => [scriptPath(skillDir, "insight_velocity_report.mjs"), "--json"],
  },
  {
    fileName: "ttinsights_report.mjs",
    label: "ttinsights_report sample",
    args: ({ skillDir }) => [scriptPath(skillDir, "ttinsights_report.mjs"), "--json", "--sample"],
  },
  {
    fileName: "dispatcher_v1.mjs",
    label: "dispatcher_v1 fixed episode",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "dispatcher_v1.mjs"),
      "--json",
      "--episode",
      "trueskill_cpcv_future_leakage",
      "--run-id",
      "determinism",
      "--now",
      FIXED_TIMESTAMP,
    ],
  },
  {
    fileName: "scoreboard.mjs",
    label: "scoreboard sample",
    args: ({ skillDir }) => [scriptPath(skillDir, "scoreboard.mjs"), "--json", "--sample", "--no-write"],
  },
  {
    fileName: "consolidation_receipt.mjs",
    label: "consolidation_receipt sample",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "consolidation_receipt.mjs"),
      "--sample",
      "--no-write",
      "--run-id",
      "determinism",
      "--generated-at",
      FIXED_TIMESTAMP,
      "--json",
    ],
  },
  {
    fileName: "planner_score_health_closeout.mjs",
    label: "planner_score_health_closeout sample",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "planner_score_health_closeout.mjs"),
      "--json",
      "--sample",
      "--run-id",
      "determinism",
    ],
  },
  {
    fileName: "plan_artifact_renderer.mjs",
    label: "plan_artifact_renderer measure fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "plan_artifact_renderer.mjs"),
      "measure",
      "--plans",
      join(fixtures.autonomousRoot, "plans"),
      "--sample",
      "2",
      "--json",
    ],
  },
  {
    fileName: "gate_survival.mjs",
    label: "gate_survival over a fixture plans dir",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "gate_survival.mjs"), "--cwd", fixtures.gateSurvivalRoot, "--plans-dir", join(fixtures.gateSurvivalRoot, "plans"), "--json"],
  },
  {
    fileName: "prolog_value_audit.mjs",
    label: "prolog_value_audit baseline",
    args: ({ skillDir }) => [scriptPath(skillDir, "prolog_value_audit.mjs"), "--json"],
  },
  {
    fileName: "autocoder_metrics.mjs",
    label: "autocoder_metrics over a fixture repo",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "autocoder_metrics.mjs"),
      "--cwd",
      fixtures.autonomousRoot,
      "--json",
    ],
  },
  {
    fileName: "context_packet.mjs",
    label: "context_packet fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "context_packet.mjs"),
      "--dir",
      fixtures.contextPacketRoot,
      "--goal",
      "Plan quant CLV as-of snapshot repair",
      "--program",
      "context-program",
      "--ticket",
      "T-CONTEXT-1",
      "--entry-budget",
      "10",
      "--json",
      "--no-plan-context",
    ],
  },
  {
    fileName: "incident_contract.mjs",
    label: "incident_contract UFC WFO fixture",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "incident_contract.mjs"),
      "check",
      "--entrypoint",
      "retro",
      "--from-text",
      "UFC WFO incident with missing_prediction, prediction_provider none, Optuna report lineage, temporal leakage, and connector boundary proof.",
      "--json",
    ],
  },
  {
    fileName: "verify_retro_action.mjs",
    label: "verify_retro_action accepted ledger fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "verify_retro_action.mjs"),
      "--ledger",
      fixtures.retroActionLedgerPath,
      "--json",
    ],
  },
  {
    fileName: "work_order_validate.mjs",
    label: "work_order_validate fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "work_order_validate.mjs"),
      fixtures.workOrderPath,
      "--json",
    ],
  },
  {
    fileName: "claims_evidence_validate.mjs",
    label: "claims_evidence_validate fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "claims_evidence_validate.mjs"),
      fixtures.claimsEvidencePath,
      "--json",
    ],
  },
  {
    fileName: "rubric_admin_runner.mjs",
    label: "rubric_admin_runner focused honest model",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "rubric_admin_runner.mjs"),
      "--suite",
      join(skillDir, "tests", "fixtures", "rubric_admin", "sycophancy_suite.json"),
      "--model",
      "cheap_honest",
      "--json",
    ],
  },
  {
    fileName: "delivery_receipt_assemble.mjs",
    label: "delivery_receipt_assemble dispute fixture",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "delivery_receipt_assemble.mjs"),
      "--input",
      join(skillDir, "tests", "fixtures", "delivery_receipt", "e6_4.dispute.json"),
      "--now",
      FIXED_TIMESTAMP,
      "--json",
    ],
  },
  {
    fileName: "pack_contract_validate.mjs",
    label: "pack_contract_validate repository packs",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "pack_contract_validate.mjs"),
      "--json",
    ],
  },
  {
    fileName: "workspace_artifact_inventory.mjs",
    label: "workspace_artifact_inventory registry fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "workspace_artifact_inventory.mjs"),
      "--registry",
      fixtures.workspaceInventoryRegistryPath,
      "--root",
      fixtures.workspaceInventoryHome,
      "--max-depth",
      "4",
      "--sample-limit",
      "3",
      "--json",
    ],
  },
  {
    fileName: "reuse_before_create.mjs",
    label: "reuse_before_create duplicate fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "reuse_before_create.mjs"),
      "--plan",
      fixtures.reuseBeforeCreatePlanDir,
      "--json",
    ],
  },
  {
    fileName: "episode_source_harvest.mjs",
    label: "episode_source_harvest fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "episode_source_harvest.mjs"),
      "--scan-root",
      fixtures.episodeSourceRoot,
      "--max-depth",
      "3",
      "--artifact-depth",
      "5",
      "--candidate-limit",
      "6",
      "--json",
    ],
  },
  {
    fileName: "knowledge_triggers.mjs",
    label: "knowledge_triggers validate",
    args: ({ skillDir }) => [scriptPath(skillDir, "knowledge_triggers.mjs"), "--validate", "--json"],
  },
  {
    fileName: "branch_drift_probe.mjs",
    label: "branch_drift_probe fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "branch_drift_probe.mjs"),
      "--cwd",
      fixtures.branchDriftRoot,
      "--now",
      FIXED_TIMESTAMP,
      "--stale-days",
      "7",
      "--deterministic",
      "--json",
    ],
  },
  {
    fileName: "truth_surface_reconciler.mjs",
    label: "truth surface large PASS fixture",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "truth_surface_reconciler.mjs"),
      "scan",
      "--scope",
      "repository",
      "--plan",
      "plan_truth",
      "--now",
      FIXED_TIMESTAMP,
      "--json",
    ],
    cwd: ({ fixtures }) => fixtures.truthSurfacePassRoot,
    minBytes: LARGE_JSON_BYTES,
    expectedStatus: 0,
  },
  {
    fileName: "truth_surface_reconciler.mjs",
    label: "truth surface large FAIL fixture",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "truth_surface_reconciler.mjs"),
      "scan",
      "--scope",
      "repository",
      "--plan",
      "plan_truth",
      "--now",
      FIXED_TIMESTAMP,
      "--json",
    ],
    cwd: ({ fixtures }) => fixtures.truthSurfaceFailRoot,
    minBytes: LARGE_JSON_BYTES,
    expectedStatus: 1,
  },
  {
    fileName: "insight_induction.mjs",
    label: "insight_induction offline focus fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "insight_induction.mjs"),
      "--focus",
      "US-HYG-001",
      "--output",
      fixtures.insightInductionOutput,
      "--agent",
      "offline",
      "--json",
    ],
  },
  {
    fileName: "issue_history_cache.mjs",
    label: "issue_history_cache verify fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "issue_history_cache.mjs"),
      "verify",
      "--cache",
      fixtures.issueHistoryCacheDir,
      "--json",
    ],
  },
  {
    fileName: "issue_history_facts.mjs",
    label: "issue_history_facts local cache fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "issue_history_facts.mjs"),
      "facts",
      "--dir",
      fixtures.issueHistoryRoot,
      "--json",
    ],
  },
  {
    fileName: "journal.mjs",
    label: "journal facts absent-file fixture",
    args: ({ skillDir }) => [scriptPath(skillDir, "journal.mjs"), "facts", "--json"],
  },
  {
    fileName: "decision_anchors.mjs",
    label: "decision_anchors audit empty fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "decision_anchors.mjs"),
      "audit",
      "--cwd",
      fixtures.root,
      "--json",
    ],
  },
  {
    fileName: "lifecycle_reconciler.mjs",
    label: "lifecycle_reconciler closed child-plan fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "lifecycle_reconciler.mjs"),
      "--program",
      "lifecycle-fixture",
      "--output",
      "reports/ive/lifecycle_reconciliation/determinism.json",
      "--no-write",
      "--json",
    ],
    cwd: ({ fixtures }) => fixtures.lifecycleReconcilerRoot,
  },
  {
    fileName: "ontology_namespace_check.mjs",
    label: "ontology_namespace_check baseline",
    args: ({ skillDir }) => [scriptPath(skillDir, "ontology_namespace_check.mjs"), "--json"],
  },
  {
    fileName: "thrashing_detector.mjs",
    label: "thrashing_detector fixture",
    args: ({ skillDir }) => [scriptPath(skillDir, "thrashing_detector.mjs"), "--plan", "plans/plan_emit_json", "--json"],
    cwd: ({ fixtures }) => fixtures.reflectionRoot,
    stream: "stderr",
  },
  {
    fileName: "ive_release_handoff.mjs",
    label: "ive_release_handoff no-write",
    delegatedJsonFlag: "scripts/lib/ive_release_handoff.mjs",
    args: ({ skillDir }) => [scriptPath(skillDir, "ive_release_handoff.mjs"), "--plans", "1", "--no-write", "--no-rollback-drill", "--json"],
  },
  {
    fileName: "autonomous_driver.mjs",
    label: "autonomous_driver already closed",
    args: ({ skillDir }) => [scriptPath(skillDir, "autonomous_driver.mjs"), "run", "--until", "close", "--plan", "plan_autonomous_closed", "--json"],
    cwd: ({ fixtures }) => fixtures.autonomousRoot,
  },
  {
    fileName: "seeded_defect_harness.mjs",
    label: "seeded_defect_harness fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "seeded_defect_harness.mjs"),
      "--root",
      fixtures.seededDefectRoot,
      "--json",
    ],
  },
  {
    fileName: "real_telemetry_false_reds.mjs",
    label: "real_telemetry_false_reds check",
    args: ({ skillDir }) => [scriptPath(skillDir, "real_telemetry_false_reds.mjs"), "--check", "--json"],
  },
  {
    fileName: "planner_truth_packet.mjs",
    label: "planner_truth_packet sample",
    args: ({ skillDir }) => [scriptPath(skillDir, "planner_truth_packet.mjs"), "--sample", "--json"],
  },
  {
    fileName: "fresh_context_reviewer.mjs",
    label: "fresh_context_reviewer rubric",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "fresh_context_reviewer.mjs"),
      "rubric",
      "--config",
      fixtures.freshContextReviewerConfigPath,
      "--json",
    ],
  },
  {
    fileName: "app_dev_tesseract_check.mjs",
    label: "app_dev_tesseract_check fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "app_dev_tesseract_check.mjs"),
      "--root",
      fixtures.appDevTesseractRoot,
      "--json",
    ],
  },
  {
    fileName: "proof_status_census.mjs",
    label: "proof_status_census repository guard",
    args: ({ skillDir }) => [scriptPath(skillDir, "proof_status_census.mjs"), "--check", "--json"],
  },
  {
    fileName: "gate_false_failure_ledger.mjs",
    label: "gate_false_failure_ledger fixture transport",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "gate_false_failure_ledger.mjs"),
      "--cwd",
      fixtures.gateSurvivalRoot,
      "--json",
    ],
  },
  {
    fileName: "recipe_runner.mjs",
    label: "recipe_runner canonical preview",
    args: ({ skillDir }) => [
      scriptPath(skillDir, "recipe_runner.mjs"),
      "--dir",
      join(skillDir, "tests", "fixtures", "recipes", "canonical"),
      "--recipe",
      "sample-flow",
      "--json",
    ],
  },
];

const inventoryExemptions = new Map([
  "annotation_assist.mjs",
  "annotation_hints.mjs",
  "annotation_parser.mjs",
  "annotation_quality.mjs",
  "advise.mjs",
  "audit_runner.mjs",
  "batch.mjs",
  "blast_radius.mjs",
  "bootstrap.mjs",
  "bootstrap_registry.mjs",
  "close_signals.mjs",
  "clean_checkout_conformance.mjs",
  "convention_inducer.mjs",
  "conventions.mjs",
  "escalation_check.mjs",
  "evidence_preflight.mjs",
  "gate_compliance.mjs",
  "gate_idempotence_check.mjs",
  "gate_prepare.mjs",
  "generate_tests.mjs",
  "harvest_real_telemetry.mjs",
  "github_ticket_review.mjs",
  "intent_contract_bootstrap.mjs",
  "ive_program_intake.mjs",
  "ive_user_verdict.mjs",
  "knowledge_benchmark.mjs",
  "knowledge_resolver.mjs",
  "migrate.mjs",
  "ontology_cli.mjs",
  "ontology_context.mjs",
  "ontology_inducer.mjs",
  "ontology_serializer.mjs",
  "ontology_write.mjs",
  "orient.mjs",
  "persona_adapt.mjs",
  "persona_execute.mjs",
  "persona_manifest_ci.mjs",
  "planner.mjs",
  "planner_findings.mjs",
  "planner_hygiene.mjs",
  "planner_preflight.mjs",
  "pre_commit_policy.mjs",
  "program_manager.mjs",
  "project.mjs",
  "project_health.mjs",
  "recipe_bootstrap.mjs",
  "recipe_discovery.mjs",
  "recipe_fleet_audit.mjs",
  "recipe_resolver.mjs",
  "recipe_validate.mjs",
  "replay_telemetry.mjs",
  "reflection_renderer.mjs",
  "retro_registry.mjs",
  "review_intake.mjs",
  "ripple_check.mjs",
  "ritual_lint.mjs",
  "rule_engine.mjs",
  "security_audit.mjs",
  "semantic_maintenance.mjs",
  "semantic_map.mjs",
  "snapshot_branch_protection.mjs",
  "source_parity_guard.mjs",
  "story_cli.mjs",
  "story_registry.mjs",
  "story_registry_bootstrap.mjs",
  "substrate_check.mjs",
  "task_intake.mjs",
  "telemetry.mjs",
  "test_run_record.mjs",
  "transition.mjs",
  "validate_mini_reflection.mjs",
  "verification_matrix.mjs",
  "verification_metrics.mjs",
  "verification_runner.mjs",
  "verification_strategy.mjs",
  "verify_gate.mjs",
  "work_preflight.mjs",
  "workflow.mjs",
].map((fileName) => [
  fileName,
  "Inventory-owned exemption: command requires workflow-specific state, subcommands, or mutation-safe fixtures before it can join the generic deterministic execution set.",
]));

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

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, String(value));
}

function scriptPath(currentSkillDir, fileName) {
  return join(currentSkillDir, "scripts", fileName);
}

function baseEnv() {
  return {
    ...process.env,
    IVE_MIGRATION_TIMESTAMP: FIXED_TIMESTAMP,
    IVE_RELEASE_HANDOFF_TIMESTAMP: FIXED_TIMESTAMP,
    NO_COLOR: "1",
    PLANNER_SKIP_SELF_HEAL: "1",
  };
}

function runNode(args, { cwd = repoRoot, env = {} } = {}) {
  return spawnSync(NODE, args, {
    cwd,
    env: { ...baseEnv(), ...env },
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runPty(args, { cwd = repoRoot } = {}) {
  if (process.platform === "win32") {
    return { status: 127, stdout: "", stderr: "script(1) PTY wrapper is unavailable on win32" };
  }
  const scriptArgs = process.platform === "darwin"
    ? ["-q", "/dev/null", NODE, ...args]
    : ["-q", "-e", "-c", [NODE, ...args].map(shellQuote).join(" "), "/dev/null"];
  return spawnSync("script", scriptArgs, {
    cwd,
    env: baseEnv(),
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function extractJsonText(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  const direct = raw.trim();
  if (direct) {
    try {
      JSON.parse(direct);
      return direct;
    } catch {
      // PTY transcripts may include control bytes around the JSON payload.
    }
  }
  const starts = ["{", "["]
    .map((char) => ({ char, index: raw.indexOf(char) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  for (const { char, index } of starts) {
    const endChar = char === "{" ? "}" : "]";
    const end = raw.lastIndexOf(endChar);
    if (end <= index) continue;
    const candidate = raw.slice(index, end + 1).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep looking for another JSON opener.
    }
  }
  return direct;
}

function parseJsonFromResult(result, label, { stream = "stdout", pty = false } = {}) {
  const text = pty ? `${result.stdout || ""}${result.stderr || ""}` : (stream === "stderr" ? result.stderr : result.stdout);
  const jsonText = pty ? extractJsonText(text) : String(text || "").trim();
  try {
    return {
      ok: true,
      parsed: JSON.parse(jsonText),
      text: jsonText,
      byteLength: Buffer.byteLength(jsonText),
      status: result.status,
    };
  } catch (error) {
    return {
      ok: false,
      parsed: null,
      text: jsonText,
      byteLength: Buffer.byteLength(jsonText || ""),
      status: result.status,
      error: `${label}: ${error.message}`,
    };
  }
}

function normalizeVolatile(value, key = null) {
  if (key && declaredVolatileTimeFields.has(key)) return "<declared-time>";
  if (Array.isArray(value)) return value.map((entry) => normalizeVolatile(entry));
  if (!value || typeof value !== "object") return value;
  const normalized = {};
  for (const itemKey of Object.keys(value).sort()) {
    normalized[itemKey] = normalizeVolatile(value[itemKey], itemKey);
  }
  return normalized;
}

function canonicalJson(value) {
  return JSON.stringify(normalizeVolatile(value));
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function assertProcessParity(direct, dispatched, label) {
  assert(direct.status === dispatched.status, `${label}: dispatcher preserves exit code`);
  assert(direct.stdout === dispatched.stdout, `${label}: dispatcher preserves stdout`);
  assert(direct.stderr === dispatched.stderr, `${label}: dispatcher preserves stderr`);
}

function makeLargePacket(packetPath) {
  const packet = {
    schema_version: 1,
    intent: { goal: "Exercise large JSON emission through validator failure output." },
    source_findings: [],
    concept_dictionary: {},
    fact_routes: [],
    closure_status: "closeable",
    closure_reason: "Fixture intentionally fails route validation.",
    advisory_review: { status: "not_run" },
  };
  for (let index = 0; index < 520; index += 1) {
    packet.fact_routes.push({
      source_finding: `F-${index}`,
      ontology_fact: "",
      status: "maybe",
      valid_next_action: "nope",
    });
  }
  writeJson(packetPath, packet);
}

function makeReflectionFixture(root) {
  const planDir = join(root, "plans", "plan_emit_json");
  writeText(join(planDir, "plan.md"), [
    "# Plan v0",
    "",
    "## Goal",
    "Emit JSON reflection guide fixture",
    "",
    "## Files To Modify",
    "- fixture.md",
    "",
    "## Success Criteria",
    "| ID | Criterion | Story linkage | Validation method |",
    "|---|---|---|---|",
    "| sc_1 | Fixture succeeds | US-003 | CLI parse proof |",
    "",
    "## Verification Strategy",
    "| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |",
    "|---|---|---|---|---|---|---|",
    "| sc_1 | US-003 | Fixture | proof:integration_smoke | fixture | pass | None |",
    "",
  ].join("\n"));
  writeText(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] Fixture\n");
  writeJson(join(planDir, "state.json"), {
    version: 1,
    state: "REFLECT",
    goal: "Emit JSON reflection guide fixture",
    transitions: [],
  });
  writeJson(join(planDir, "metrics.json"), {
    stage_reversals: 0,
    repeated_gate_failures: 0,
    reflection_rewrites: 0,
  });
  writeJson(join(root, "reports", "user_story_audit", "story_registry.json"), {
    stories: [{ id: "US-003", title: "Gate verification", status: "ACTIVE" }],
  });
  return root;
}

function makeReflectionValidationFixture(root) {
  const planId = "plan_validate_reflection";
  const planDir = join(root, "plans", planId);
  const guidePath = join(planDir, "reflection_guide.yaml");
  const reflectionPath = join(planDir, "reflection.md");
  const sectionDefinitions = [
    ["plan_vs_progress", "Plan vs Progress Divergence"],
    ["applicable_kb", "Applicable KB Entries"],
    ["relevant_retros", "Relevant Retros"],
    ["edge_case_coverage", "Edge Case Coverage"],
    ["pattern_application_check", "Pattern Application Check"],
    ["process_signals", "Thrashing & Process Signals"],
    ["proof_weight_audit", "Proof Weight Audit"],
    ["next_time_candidates", "Next Time Candidates"],
    ["convention_application_check", "Convention Application Check"],
  ];
  const sections = Object.fromEntries(sectionDefinitions.map(([sectionId, title]) => [
    sectionId,
    {
      title,
      questions: [],
    },
  ]));
  sections.edge_case_coverage.questions.push({
    id: "edge_case_coverage:uncovered_edge_cases",
    title: "Resolve uncovered edge cases",
    subject_id: "uncovered_edge_cases",
    required: true,
    answer_modes: ["pivot_back_to_execute", "accept_as_known_limitation", "out_of_scope"],
  });

  writeJson(guidePath, {
    reflection_guide: {
      version: 1,
      plan_id: planId,
      generated_at: FIXED_TIMESTAMP,
      section_order: sectionDefinitions.map(([sectionId]) => sectionId),
      sections,
      questions: [],
      required_question_count: 1,
      summary: {},
    },
  });
  writeText(reflectionPath, `---
plan_id: ${planId}
generated_from_guide: plans/${planId}/reflection_guide.yaml
guide_version: 1
answered_at: ${FIXED_TIMESTAMP}
required_questions_answered: 1/1
---

# Reflection

## Solution Verdict
PASS — The canonical reflection fixture is complete and ready for deterministic validation.

## Surprises
The dispatcher parity fixture remained intentionally small while exercising the child validator contract.

## Plan vs Progress Divergence
The implemented fixture stayed within its declared validation scope and introduced no unplanned runtime work.

## Applicable KB Entries
Mistake M-001 applies because the documented workflow, dispatcher route, and governed regression must move together.

## Relevant Retros
No earlier retro changes this bounded fixture, and the result remains explicit enough for deterministic review.

## Edge Case Coverage
out_of_scope — No additional runtime edge case remains after the canonical valid and missing-file paths are compared.

## Pattern Application Check
The argument-preserving dispatcher pattern is checked against direct child execution for every representative path.

## Thrashing & Process Signals
No process signal fired while constructing this deterministic reflection validation fixture.

## Proof Weight Audit
Direct child output, dispatcher output, exit status, streams, and generated artifacts provide independent parity evidence.

## Next Time Candidates
Keep dispatcher aliases in the CLI determinism suite whenever a workflow publishes them as executable commands.

## Convention Application Check
The stable planner entrypoint and canonical reflection artifact paths follow the repository command conventions.

## Lessons Learned
Testing the child and dispatcher together prevents a documentation-only command from appearing executable when its route is absent.

## Semantic Verdict
PASS — The fixture represents a valid structured reflection with one substantive required answer.

## Evidence-Readiness Verdict
READY — The fixture supplies enough deterministic evidence for direct-versus-dispatcher comparison.

## Next Move
VALIDATE — Run the canonical validator through both entrypoints and require identical observable behavior.
`);

  return {
    root,
    reflectionPath,
    guidePath,
  };
}

function makeAutonomousDriverFixture(root) {
  const planDir = join(root, "plans", "plan_autonomous_closed");
  writeJson(join(planDir, "state.json"), {
    version: 1,
    state: "CLOSE",
    goal: "Already closed autonomous driver determinism fixture",
    transitions: [],
  });
  writeText(join(root, "plans", ".current_plan"), "plan_autonomous_closed\n");
  return root;
}

function makeGateSurvivalFixture(root) {
  const logPath = join(root, "plans", "plan_2026-01-01_gate", "artifacts", "decision_log.jsonl");
  const rows = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "gate_transition",
      gate: "plan-to-execute",
      decision: "BLOCKED",
      failure_codes: ["GATE-PLN-017"],
      checks: [{ name: "Verification matrix", code: "GATE-PLN-017", status: "FAIL", detail: "missing row" }],
    },
    {
      timestamp: "2026-01-01T00:00:30.000Z",
      type: "gate_transition",
      gate: "plan-to-execute",
      decision: "ALLOWED",
      failure_codes: [],
      checks: [{ name: "State is stable", status: "PASS", detail: "stable" }],
    },
  ];
  writeText(logPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeJson(join(root, "plans", "plan_2026-01-01_gate", "state.json"), {
    state: "EXECUTE",
    transitions: [
      { from: "PLAN", to: "EXECUTE", gate_result: "PASS", failure_codes: [] },
    ],
  });
  return root;
}

function makeLifecycleReconcilerFixture(root) {
  const planDir = join(root, "plans", "plan_2026-01-01_lifecycle");
  writeJson(join(root, "plans", "programs", "lifecycle-fixture", "program_packet.json"), {
    id: "lifecycle-fixture",
    title: "Lifecycle Reconciler Determinism Fixture",
    status: "executing",
    tickets: [
      {
        id: "T-LIFE-001",
        title: "A1: Lifecycle reconciler marks closed child plan",
        lifecycle: "proposed",
        child_plan: {
          plan_dir: "plans/plan_2026-01-01_lifecycle",
        },
        acceptance_criteria: [
          "Closed child-plan evidence is reported as an advisory lifecycle repair.",
        ],
        verification_refs: [
          "determinism:lifecycle_reconciler",
        ],
      },
    ],
  });
  writeJson(join(planDir, "state.json"), {
    version: 1,
    state: "CLOSE",
    goal: "T-LIFE-001 Lifecycle reconciler closed child-plan fixture",
    transitions: [],
  });
  writeText(join(planDir, "summary.md"), "Closed fixture plan for T-LIFE-001.\n");
  return root;
}

function makeContractRegistryFixture(path) {
  writeJson(path, {
    id: "cli_determinism_contract_registry",
    version: 1,
    contracts: [
      {
        id: "report_shape",
        type: "output_contract",
        artifact_text: "# Report\n\n## Evidence\nProof refs: VM-001.\n",
        required_sections: ["Evidence"],
        required_signals: ["Proof refs"],
        forbidden_placeholders: ["TODO"],
      },
    ],
  });
  return path;
}

function makeWorkOrderFixture(path) {
  writeJson(path, {
    schema_version: 1,
    id: "wo_cli_determinism_fixture",
    goal: "Validate a deterministic work-order fixture for CLI JSON emission proof.",
    inputs: [
      {
        id: "fixture_input",
        kind: "path",
        ref: "fixture/work-order.json",
        description: "Self-contained CLI determinism fixture.",
      },
    ],
    constraints: [
      "Emit JSON only when --json is provided.",
      "Keep validation deterministic across repeat, PTY, and redirect execution.",
    ],
    claims_to_produce: [
      {
        id: "fixture_validated",
        statement: "The work-order validator emits a stable PASS payload for a valid fixture.",
        consumer: "cli-determinism regression suite",
      },
    ],
    proof_obligations: [
      {
        claim_id: "fixture_validated",
        method: "deterministic",
        check: "Repeat, PTY, and redirect JSON outputs normalize identically.",
      },
    ],
    stop_conditions: [
      "Stop if JSON output cannot be parsed.",
      "Stop if normalized output changes between repeat runs.",
    ],
    budget: {
      max_tokens: 1000,
      max_cost_usd: 0,
      max_time_minutes: 5,
    },
  });
  return path;
}

function makeClaimsEvidenceFixture(path) {
  writeJson(path, {
    schema_version: 1,
    return_type: "claims_evidence",
    bounce: {
      attempt: 0,
      max_bounces: 2,
    },
    claims: [
      {
        id: "claim_cli_determinism",
        statement: "The claims/evidence validator emits stable PASS JSON for a valid fixture.",
        type: "receipt",
        evidence_refs: [
          ".agent/skills/iterative-planner/tests/test_cli_determinism.mjs",
        ],
        verification_method: "deterministic",
        cost: {
          tokens: 32,
          usd: 0,
          wall_clock_ms: 1,
        },
      },
    ],
  });
  return path;
}

function makeRetroActionLedgerFixture(path) {
  writeJson(path, {
    version: 1,
    retros: [
      {
        id: "R-CLI-DETERMINISM-001",
        date: "2026-01-01",
        title: "CLI determinism accepted action fixture",
        summary: "Accepted retros need concrete action evidence.",
        failure_modes: ["MISSING_ACTION_EVIDENCE"],
        discovered_phase: "validate-to-close",
        affected_surfaces: [".agent/workflows/retro.md"],
        root_cause: "Fixture exercises accepted-retro action evidence deterministically.",
        promotion_decision: "guardrail",
        remediation_plan_ids: ["plan_cli_determinism_retro_action"],
        kb_refs: ["plans/knowledge/mistakes.md#M-CLI"],
        tags: ["retro", "determinism"],
        status: "accepted",
      },
    ],
  });
  return path;
}

function makeWorkspaceInventoryFixture(root) {
  const fixtureRoot = join(root, "workspace_inventory");
  const presentProject = join(fixtureRoot, "present_project");
  const currentHome = join(fixtureRoot, "home");
  const registryPath = join(fixtureRoot, "registry.json");
  writeText(join(presentProject, "plans", "plan_2026-01-01_fixture", "decisions.md"), "decision\n");
  writeText(join(presentProject, "plans", "knowledge", "mistakes.md"), "mistake\n");
  writeText(join(presentProject, "reports", "ive", "report.json"), "{}\n");
  writeText(join(presentProject, ".codex", "transcripts", "session.jsonl"), "{}\n");
  ensureDir(join(currentHome, "old_workspace"));
  writeJson(registryPath, {
    projects: [
      { path: presentProject, type: "standard", last_upgraded: "2026-01-01T00:00:00.000Z" },
      { path: "/Users/old/old_workspace/missing_project", type: "standard" },
      { path: "relative/path", type: "standard" },
    ],
    scan_roots: ["/Users/old/old_workspace"],
    source_project_path: presentProject,
  });
  return { registryPath, currentHome };
}

function makeReuseBeforeCreateFixture(root) {
  const fixtureRoot = join(root, "reuse_before_create");
  const planDir = join(fixtureRoot, "plans", "plan_duplicate_script");
  writeJson(join(fixtureRoot, "recipes", "entity_registry.json"), {
    version: 1,
    entities: [{ id: "portfolio", title: "Portfolio" }],
  });
  writeJson(join(fixtureRoot, "recipes", "capability_registry.json"), {
    version: 1,
    capabilities: [
      {
        id: "daily_runner",
        title: "Daily Runner",
        description: "Runs deterministic daily portfolio workflow jobs.",
        scripts: [{ path: "scripts/daily_runner.mjs", purpose: "Run the daily portfolio workflow" }],
      },
    ],
  });
  writeJson(join(fixtureRoot, "recipes", "daily-runner", "recipe.json"), {
    id: "daily-runner",
    title: "Daily Runner",
    capability_id: "daily_runner",
    entity_ids: ["portfolio"],
    required_params: ["portfolio_id"],
    scripts: [{ path: "scripts/daily_runner.mjs", purpose: "Run the daily portfolio workflow" }],
    runner: {
      type: "command",
      command: ["node", "scripts/daily_runner.mjs"],
      cwd: ".",
      defaults: {},
      dry_run_flags: ["--dry-run"],
      live_flags: [],
    },
  });
  writeText(join(planDir, "plan.md"), [
    "# Plan",
    "",
    "## Goal",
    "Add duplicate daily runner script",
    "",
    "## Files To Modify",
    "- scripts/new_daily_runner.mjs",
    "",
    "## Steps",
    "1. Propose the duplicate runner.",
    "",
  ].join("\n"));
  writeJson(join(planDir, "work_order.json"), {
    id: "wo_reuse_before_create_duplicate",
    proposed_creations: [
      {
        capability_id: "daily_runner",
        path: "scripts/new_daily_runner.mjs",
        purpose: "Run the daily portfolio workflow",
      },
    ],
  });
  return planDir;
}

function makeEpisodeSourceFixture(root) {
  const scanRoot = join(root, "episode_sources");
  const project = join(scanRoot, "quant_project");
  ensureDir(join(project, ".git"));
  writeText(join(project, "AGENTS.md"), "# Agent fixture\n");
  writeText(
    join(project, "plans", "plan_2026-01-01_episode", "decisions.md"),
    "Aha: the agent loop missed temporal leakage during optimizer verification.\n"
  );
  writeText(
    join(project, "plans", "knowledge", "retros", "case.md"),
    "Root cause: false-green ontology routing hid the verification gap.\n"
  );
  writeText(
    join(project, "reports", "quant", "backtest_report.md"),
    "Calibration, OOS holdout, and no-alpha claim boundary.\n"
  );
  return scanRoot;
}

function makeContextPacketFixture(root) {
  const contextRoot = join(root, "context-packet-root");
  writeJson(join(contextRoot, "reports", "user_story_audit", "story_registry.json"), {
    stories: [
      { id: "US-CONTEXT-1", title: "Quant CLV as-of snapshot context", status: "ACTIVE", tags: ["quant", "clv"] },
      { id: "US-CONTEXT-UI", title: "UI context noise", status: "ACTIVE", tags: ["ui"] },
    ],
  });
  writeJson(join(contextRoot, "plans", "programs", "context-program", "program_packet.json"), {
    version: 1,
    id: "context-program",
    title: "Context Packet Fixture",
    goal: "Exercise context_packet CLI determinism.",
    status: "executing",
    epics: [],
    tickets: [
      {
        id: "T-CONTEXT-1",
        title: "Plan quant CLV as-of snapshot repair",
        lifecycle: "in_progress",
        story_refs: ["US-CONTEXT-1"],
      },
      {
        id: "T-CONTEXT-UI",
        title: "Polish UI context colors",
        lifecycle: "ready",
        story_refs: ["US-CONTEXT-UI"],
      },
    ],
    acceptance_criteria: [],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [],
    decisions: [],
  });
  writeText(join(contextRoot, "plans", "knowledge", "agent_journal.jsonl"), `${JSON.stringify({
    id: "J-CONTEXT-1",
    type: "observation",
    status: "accepted",
    confidence: "measured",
    topic: "quant CLV context",
    summary: "Quant CLV as-of snapshot context needs traceable retrieval.",
    tags: ["quant", "clv"],
    linked_ids: ["US-CONTEXT-1", "T-CONTEXT-1"],
  })}\n`);
  return contextRoot;
}

function makeFreshContextReviewerFixture(path) {
  writeJson(path, {
    schema_version: 1,
    name: "fresh-context-reviewer-determinism-fixture",
    fail_honest: true,
    packs: [
      "wiring_auditor",
      "assumptions_challenger",
      "traceability",
      "config_integrity",
    ],
    provider: {
      api_key_env: "FRESH_CONTEXT_REVIEWER_API_KEY",
      model_env: "FRESH_CONTEXT_REVIEWER_MODEL",
      base_url_env: "FRESH_CONTEXT_REVIEWER_BASE_URL",
      mock_response_env: "FRESH_CONTEXT_REVIEWER_MOCK_RESPONSE",
      mock_error_env: "FRESH_CONTEXT_REVIEWER_MOCK_ERROR",
      timeout_ms: 20000,
    },
    self_review_paths: [
      ".github/reviewer/**",
      ".agent/skills/iterative-planner/scripts/fresh_context_reviewer.mjs",
      ".agent/skills/iterative-planner/scripts/lib/fresh_context_reviewer.mjs",
      ".agent/skills/iterative-planner/tests/test_fresh_context_reviewer.mjs",
    ],
  });
  return path;
}

function makeAutonomousDogfoodReceiptFixture(root) {
  const receiptRoot = join(root, "autonomous_dogfood_receipts");
  writeJson(join(receiptRoot, "2026-01-01", "l3-cli-determinism.json"), {
    schema_version: "ive.autonomous_dogfood_run.v1",
    run_id: "l3-cli-determinism",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:00.000Z",
    outcome: "PASS",
  });
  return receiptRoot;
}

function makeAppDevTesseractFixture(root) {
  const appRoot = join(root, "app_dev_tesseract");
  writeText(join(appRoot, "src", "webhook.js"), [
    "const apiBase = process.env.TESSERACT_API_BASE;",
    "app.post('/webhook/tesseract', async (req, res) => {",
    "  const signature = req.headers['x-signature'];",
    "  const eventId = req.headers['x-event-id'];",
    "  const retryAttempt = req.headers['x-retry-attempt'];",
    "  const loading = true;",
    "  try {",
    "    const response = await fetch(`${apiBase}/events/${eventId}`);",
    "    if (!response.ok) throw new Error('failed webhook fetch');",
    "    const rows = await response.json();",
    "    if (rows.length === 0) return res.json({ empty: true, retryAttempt });",
    "    return res.json({ ok: true, signature, eventId, loading });",
    "  } catch (error) {",
    "    return res.status(500).json({ error: error.message });",
    "  }",
    "});",
    "",
  ].join("\n"));
  writeText(join(appRoot, "migrations", "001_upgrade.js"), [
    "export function migrateMembershipSchema() {",
    "  // dry-run, rollback, checkpoint, resume, verify, and idempotent journey smoke test",
    "  return { dryRun: true, rollback: true, checkpoint: 'before/after verified' };",
    "}",
    "",
  ].join("\n"));
  return appRoot;
}

function runGitFixture(args, cwd, extraEnv = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Planner Test",
      GIT_AUTHOR_EMAIL: "planner@example.invalid",
      GIT_COMMITTER_NAME: "Planner Test",
      GIT_COMMITTER_EMAIL: "planner@example.invalid",
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function commitBranchDriftFixtureFile(root, fileName, content, isoTimestamp) {
  writeText(join(root, fileName), content);
  runGitFixture(["add", fileName], root);
  runGitFixture(["commit", "-m", `fixture ${fileName}`], root, {
    GIT_AUTHOR_DATE: isoTimestamp,
    GIT_COMMITTER_DATE: isoTimestamp,
  });
}

function makeBranchDriftFixture(root) {
  ensureDir(root);
  runGitFixture(["init", "-b", "main"], root);
  runGitFixture(["config", "user.name", "Planner Test"], root);
  runGitFixture(["config", "user.email", "planner@example.invalid"], root);
  commitBranchDriftFixtureFile(root, "README.md", "main\n", "2025-12-20T00:00:00Z");
  runGitFixture(["update-ref", "refs/remotes/origin/main", "HEAD"], root);
  runGitFixture(["checkout", "-b", "feature/drift"], root);
  commitBranchDriftFixtureFile(root, "drift.txt", "branch work\n", "2025-12-21T00:00:00Z");
  runGitFixture(["update-ref", "refs/remotes/origin/feature/drift", "HEAD"], root);
  runGitFixture(["checkout", "main"], root);
  const fetchHead = join(root, ".git", "FETCH_HEAD");
  writeText(fetchHead, "# fixture fetch marker\n");
  const fetchDate = new Date("2025-12-31T00:00:00Z");
  utimesSync(fetchHead, fetchDate, fetchDate);
  return root;
}

function makeAutonomousTicketDeliveryFixture(root, { pass }) {
  const ticketId = pass ? "T-DELIVERY-PASS" : "T-DELIVERY-FAIL";
  const programPath = join(root, "plans", "programs", "delivery", "program_packet.json");
  writeJson(programPath, {
    version: 1,
    id: pass ? "PGM-DELIVERY-PASS" : "PGM-DELIVERY-FAIL",
    title: "Production delivery transport fixture",
    status: "executing",
    remote_mode: "local-only",
    goal: "Prove large deterministic PASS and FAIL transport without a second invocation.",
    epics: [],
    tickets: [{
      id: ticketId,
      epic_id: "EP-DELIVERY",
      title: "Close one exact real fixture ticket",
      type: "maintenance",
      lifecycle: "in_progress",
      problem: `Large immutable work-order contract: ${"proof-boundary ".repeat(1800)}`,
      story_refs: ["US-DELIVERY"],
      defect_refs: [],
      gap_refs: [],
      depends_on: [],
      acceptance_criteria: ["AC-DELIVERY"],
      verification_refs: ["VM-DELIVERY"],
      review_status: "fresh",
      child_plan: {
        policy: "required",
        plan_dir: "plans/plan_delivery",
        reason: "Committed closed child-plan fixture",
      },
    }],
    acceptance_criteria: [{ id: "AC-DELIVERY", scope: "ticket", subject_ref: ticketId, text: "Ticket closes on committed evidence.", story_refs: ["US-DELIVERY"] }],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [{ id: "VM-DELIVERY", subject_ref: ticketId, command: "node -e \"process.exit(0)\"", status: "passed" }],
    decisions: [],
  });
  writeJson(join(root, "plans", "plan_delivery", "state.json"), { version: 1, state: "CLOSE", transitions: [] });
  writeJson(join(root, "plans", "plan_delivery", "scope.json"), {
    version: 1,
    goal: `Close ${ticketId}`,
    declared_files: ["plans/programs/delivery/program_packet.json"],
  });
  writeText(join(root, "plans", "plan_delivery", "summary.md"), `# Closed delivery for ${ticketId}\n`);
  writeText(join(root, "fixture_agent.mjs"), pass ? [
    'import { readFileSync, writeFileSync } from "fs";',
    'import { spawnSync } from "child_process";',
    'for await (const _chunk of process.stdin) {}',
    'const path = "plans/programs/delivery/program_packet.json";',
    'const packet = JSON.parse(readFileSync(path, "utf-8"));',
    'packet.tickets[0].lifecycle = "closed";',
    'writeFileSync(path, `${JSON.stringify(packet, null, 2)}\\n`);',
    'for (const args of [["add", "--", path], ["commit", "-m", "close deterministic delivery fixture"]]) {',
    '  const result = spawnSync("git", args, { encoding: "utf-8" });',
    '  if (result.status !== 0) { console.error(result.stderr || result.stdout); process.exit(4); }',
    '}',
    'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, total_tokens: 150 } }));',
    '',
  ].join("\n") : [
    'for await (const _chunk of process.stdin) {}',
    'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, cached_input_tokens: 10, output_tokens: 20, total_tokens: 100 } }));',
    '',
  ].join("\n"));
  const agentSyntax = spawnSync(NODE, ["--check", join(root, "fixture_agent.mjs")], {
    cwd: root,
    env: baseEnv(),
    encoding: "utf-8",
  });
  if (agentSyntax.status !== 0) throw new Error(`fixture agent syntax failed: ${agentSyntax.stderr || agentSyntax.stdout}`);
  runGitFixture(["init", "-b", "main"], root);
  runGitFixture(["config", "user.name", "Planner Test"], root);
  runGitFixture(["config", "user.email", "planner@example.invalid"], root);
  runGitFixture(["add", "."], root);
  runGitFixture(["commit", "-m", `production delivery transport fixture for ${ticketId}`], root, {
    GIT_AUTHOR_DATE: FIXED_TIMESTAMP,
    GIT_COMMITTER_DATE: FIXED_TIMESTAMP,
  });
  return root;
}

function makeTruthSurfaceFixture(root, { fail = false } = {}) {
  const planDir = join(root, "plans", "plan_truth");
  const snapshotDir = join(planDir, "artifacts", "truth_surface");
  ensureDir(snapshotDir);
  writeJson(join(planDir, "state.json"), {
    version: 1,
    plan_id: "plan_truth",
    state: "EXECUTE",
    transitions: [],
  });
  writeText(join(planDir, "plan.md"), "# Truth convergence fixture\n");
  writeText(join(root, "plans", ".current_plan"), "plan_truth\n");
  writeJson(join(snapshotDir, "branch_snapshot.json"), {
    version: 1,
    collected_at: FIXED_TIMESTAMP,
    expires_at: "2026-01-02T00:00:00Z",
    complete: true,
    branches: Array.from({ length: 180 }, (_, index) => ({
      name: `origin/fixture-${String(index).padStart(3, "0")}`,
      classification: fail ? "UNKNOWN" : "ACTIVE_WIP",
      disposition: fail ? "indeterminate" : "advisory",
    })),
  });
  writeJson(join(snapshotDir, "pr_snapshot.json"), {
    version: 1,
    repository: "owner/repo",
    collected_at: FIXED_TIMESTAMP,
    expires_at: "2026-01-02T00:00:00Z",
    complete: true,
    pull_requests: [],
  });
  runGitFixture(["init", "-b", "main"], root);
  runGitFixture(["config", "user.name", "Planner Test"], root);
  runGitFixture(["config", "user.email", "planner@example.invalid"], root);
  runGitFixture(["add", "."], root);
  runGitFixture(["commit", "-m", "truth surface transport fixture"], root, {
    GIT_AUTHOR_DATE: FIXED_TIMESTAMP,
    GIT_COMMITTER_DATE: FIXED_TIMESTAMP,
  });
  const head = runGitFixture(["rev-parse", "HEAD"], root).stdout.trim();
  writeJson(join(root, "plans", "audit_log.json"), {
    audits: ["red-team", "regression", "retro", "user-story", "advisor"].map((type) => ({
      type,
      timestamp: "2099-01-01T00:00:00Z",
      commit: head,
    })),
  });
  return root;
}

function makeIssueHistoryFixture(root) {
  const issueHistoryRoot = join(root, "issue_history");
  const written = writeIssueHistoryCache({
    cwd: issueHistoryRoot,
    out: "plans/knowledge/github_issues",
    repo: "owner/repo",
    query: { repo: "owner/repo", state: "all", labels: ["planner"], scope: "all", limit: 1 },
    issues: [
      {
        number: 7,
        title: "Decision: cache issue history locally",
        state: "closed",
        url: "https://github.com/owner/repo/issues/7",
        labels: ["planner"],
        author: { login: "planner" },
        assignees: [],
        milestone: null,
        body: "Decision: verify issue history from a local cache fixture.",
        created_at: FIXED_TIMESTAMP,
        updated_at: FIXED_TIMESTAMP,
        closed_at: FIXED_TIMESTAMP,
        comments: [
          {
            id: "comment-7",
            author: { login: "planner" },
            body: "The blocker is resolved by deterministic local cache verification.",
            created_at: FIXED_TIMESTAMP,
            updated_at: FIXED_TIMESTAMP,
            url: "https://github.com/owner/repo/issues/7#issuecomment-7",
          },
        ],
        source: "detail",
      },
    ],
    generatedAt: FIXED_TIMESTAMP,
    ttlHours: 24,
  });
  return {
    root: issueHistoryRoot,
    cacheDir: join(issueHistoryRoot, written.cache_dir),
  };
}

function prepareFixtures(root) {
  const fixtureRoot = join(root, ".tmp_cli_determinism");
  const reflectionRoot = makeReflectionFixture(join(fixtureRoot, "reflection-root"));
  const reflectionValidation = makeReflectionValidationFixture(join(fixtureRoot, "reflection-validation-root"));
  const autonomousRoot = makeAutonomousDriverFixture(join(fixtureRoot, "autonomous-root"));
  const gateSurvivalRoot = makeGateSurvivalFixture(join(fixtureRoot, "gate-survival-root"));
  const largePacketPath = join(fixtureRoot, "large_packet.json");
  const contractRegistryPath = makeContractRegistryFixture(join(fixtureRoot, "contract_registry.json"));
  const workOrderPath = makeWorkOrderFixture(join(fixtureRoot, "work_order.json"));
  const claimsEvidencePath = makeClaimsEvidenceFixture(join(fixtureRoot, "claims_evidence.json"));
  const retroActionLedgerPath = makeRetroActionLedgerFixture(join(fixtureRoot, "retro_action_ledger.json"));
  const workspaceInventory = makeWorkspaceInventoryFixture(fixtureRoot);
  const reuseBeforeCreatePlanDir = makeReuseBeforeCreateFixture(fixtureRoot);
  const episodeSourceRoot = makeEpisodeSourceFixture(fixtureRoot);
  const contextPacketRoot = makeContextPacketFixture(fixtureRoot);
  const freshContextReviewerConfigPath = makeFreshContextReviewerFixture(join(fixtureRoot, "fresh_context_reviewer_config.json"));
  const autonomousDogfoodReceiptRoot = makeAutonomousDogfoodReceiptFixture(fixtureRoot);
  const appDevTesseractRoot = makeAppDevTesseractFixture(fixtureRoot);
  const branchDriftRoot = makeBranchDriftFixture(join(fixtureRoot, "branch_drift_repo"));
  const autonomousTicketPassRoot = makeAutonomousTicketDeliveryFixture(join(fixtureRoot, "autonomous_ticket_pass"), { pass: true });
  const autonomousTicketFailRoot = makeAutonomousTicketDeliveryFixture(join(fixtureRoot, "autonomous_ticket_fail"), { pass: false });
  const truthSurfacePassRoot = makeTruthSurfaceFixture(join(fixtureRoot, "truth_surface_pass"));
  const truthSurfaceFailRoot = makeTruthSurfaceFixture(join(fixtureRoot, "truth_surface_fail"), { fail: true });
  const issueHistory = makeIssueHistoryFixture(fixtureRoot);
  const insightInductionOutput = join(fixtureRoot, "insight_induction");
  const seededDefectRoot = join(fixtureRoot, "seeded_defects");
  const lifecycleReconcilerRoot = makeLifecycleReconcilerFixture(join(fixtureRoot, "lifecycle-reconciler-root"));
  ensureDir(seededDefectRoot);
  makeLargePacket(largePacketPath);
  return {
    root,
    skillDir: join(root, ".agent", "skills", "iterative-planner"),
    reflectionRoot,
    reflectionValidationRoot: reflectionValidation.root,
    validReflectionPath: reflectionValidation.reflectionPath,
    validReflectionGuidePath: reflectionValidation.guidePath,
    autonomousRoot,
    gateSurvivalRoot,
    contextPacketRoot,
    largePacketPath,
    contractRegistryPath,
    workOrderPath,
    claimsEvidencePath,
    retroActionLedgerPath,
    workspaceInventoryRegistryPath: workspaceInventory.registryPath,
    workspaceInventoryHome: workspaceInventory.currentHome,
    reuseBeforeCreatePlanDir,
    episodeSourceRoot,
    seededDefectRoot,
    freshContextReviewerConfigPath,
    autonomousDogfoodReceiptRoot,
    appDevTesseractRoot,
    branchDriftRoot,
    autonomousTicketPassRoot,
    autonomousTicketFailRoot,
    truthSurfacePassRoot,
    truthSurfaceFailRoot,
    issueHistoryRoot: issueHistory.root,
    issueHistoryCacheDir: issueHistory.cacheDir,
    insightInductionOutput,
    lifecycleReconcilerRoot,
    missingReflectionPath: join(fixtureRoot, "missing_reflection.md"),
  };
}

function copyMinimalCheckout(tmp) {
  const target = join(tmp, "ive checkout (determinism)");
  ensureDir(target);
  cpSync(join(repoRoot, ".agent"), join(target, ".agent"), { recursive: true });
  cpSync(join(repoRoot, "docs"), join(target, "docs"), { recursive: true });
  cpSync(join(repoRoot, "plans", "programs"), join(target, "plans", "programs"), { recursive: true });
  return target;
}

function discoverJsonCliScripts() {
  return readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => readFileSync(join(scriptsDir, name), "utf-8").includes("--json"))
    .sort();
}

function assertInventoryClosed() {
  const discovered = discoverJsonCliScripts();
  const descriptorNames = new Set(executableDescriptors.map((descriptor) => descriptor.fileName));
  const exemptNames = new Set(inventoryExemptions.keys());
  const missing = discovered.filter((name) => !descriptorNames.has(name) && !exemptNames.has(name));
  const staleDescriptors = executableDescriptors
    .filter((descriptor) => !discovered.includes(descriptor.fileName) && !descriptor.delegatedJsonFlag)
    .map((descriptor) => descriptor.fileName);
  const staleExemptions = [...exemptNames].filter((name) => !discovered.includes(name));
  assert(missing.length === 0, "all discovered --json scripts are covered or explicitly exempted", missing.join(", "));
  assert(staleDescriptors.length === 0, "executable descriptor inventory has no stale entries", staleDescriptors.join(", "));
  assert(staleExemptions.length === 0, "exemption inventory has no stale entries", staleExemptions.join(", "));
  assert(discovered.length >= executableDescriptors.length, "single-source discovery enumerates the JSON CLI surface");
  for (const [fileName, reason] of inventoryExemptions) {
    assert(reason.length >= 40, `${fileName} exemption records a reason`);
  }
  for (const descriptor of executableDescriptors.filter((entry) => entry.delegatedJsonFlag)) {
    const delegatedSource = readFileSync(join(skillDir, descriptor.delegatedJsonFlag), "utf-8");
    assert(delegatedSource.includes("--json"), `${descriptor.fileName} delegated --json parser is inventory-visible`);
  }
}

const exitAfterStdoutJsonExemptions = new Map();

function maskJavascriptNonCode(source) {
  // String indexes in JavaScript are UTF-16 code-unit offsets. Keep the mask in
  // that same representation so astral characters earlier in a file cannot
  // shift later structural tokens and corrupt branch analysis.
  const chars = source.split("");
  const blank = (index) => {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  };
  const previousWord = (index) => {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
    const end = cursor + 1;
    while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor])) cursor -= 1;
    return source.slice(cursor + 1, end);
  };
  const regexCanStart = (index) => {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
    if (cursor < 0 || /[([{:;,=!&|?+*%<>~-]/.test(source[cursor])) return true;
    return ["case", "delete", "return", "throw", "typeof", "void", "yield"].includes(previousWord(index));
  };
  const consumeQuoted = (start, quote) => {
    let cursor = start + 1;
    let interpolationDepth = 0;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        blank(cursor);
        cursor += 1;
        if (cursor < source.length) blank(cursor);
        cursor += 1;
        continue;
      }
      if (quote === "`" && source[cursor] === "$" && source[cursor + 1] === "{") {
        blank(cursor);
        blank(cursor + 1);
        interpolationDepth += 1;
        cursor += 2;
        continue;
      }
      if (quote === "`" && interpolationDepth > 0 && source[cursor] === "}") {
        blank(cursor);
        interpolationDepth -= 1;
        cursor += 1;
        continue;
      }
      if (source[cursor] === quote && interpolationDepth === 0) {
        blank(cursor);
        return cursor + 1;
      }
      if (quote === "`" && interpolationDepth > 0 && ["'", '"', "`"].includes(source[cursor])) {
        const nestedQuote = source[cursor];
        blank(cursor);
        cursor = consumeQuoted(cursor, nestedQuote);
        continue;
      }
      blank(cursor);
      cursor += 1;
    }
    return cursor;
  };

  let index = 0;
  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "/") {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          blank(index);
          blank(index + 1);
          index += 2;
          break;
        }
        blank(index);
        index += 1;
      }
      continue;
    }
    if (["'", '"', "`"].includes(source[index])) {
      const quote = source[index];
      blank(index);
      index = consumeQuoted(index, quote);
      continue;
    }
    if (source[index] === "/" && regexCanStart(index)) {
      blank(index);
      index += 1;
      let inClass = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          blank(index);
          index += 1;
          if (index < source.length) blank(index);
          index += 1;
          continue;
        }
        if (source[index] === "[") inClass = true;
        if (source[index] === "]") inClass = false;
        if (source[index] === "/" && !inClass) {
          blank(index);
          index += 1;
          while (index < source.length && /[a-z]/i.test(source[index])) {
            blank(index);
            index += 1;
          }
          break;
        }
        blank(index);
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return chars.join("");
}

function tokenizeJavascriptStructure(maskedSource) {
  const tokens = [];
  const matcher = /=>|[A-Za-z_$][A-Za-z0-9_$]*|[{}()[\];,.:?]/g;
  let match;
  while ((match = matcher.exec(maskedSource)) !== null) {
    tokens.push({ value: match[0], start: match.index, end: matcher.lastIndex });
  }
  return tokens;
}

function buildTokenPairs(tokens) {
  const pairs = new Map();
  const reversePairs = new Map();
  const stacks = { "(": [], "[": [], "{": [] };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (Object.hasOwn(stacks, value)) stacks[value].push(index);
    if (Object.hasOwn(closing, value)) {
      const open = stacks[closing[value]].pop();
      if (open !== undefined) {
        pairs.set(open, index);
        reversePairs.set(index, open);
      }
    }
  }
  return { pairs, reversePairs };
}

function tokenIndexAt(tokens, position) {
  let low = 0;
  let high = tokens.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (tokens[middle].start < position) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, Math.min(low, tokens.length - 1));
}

function sourceLineAt(source, position) {
  let line = 1;
  for (let index = 0; index < position; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function analyzeJavascriptControl(source) {
  const masked = maskJavascriptNonCode(source);
  const tokens = tokenizeJavascriptStructure(masked);
  const { pairs, reversePairs } = buildTokenPairs(tokens);
  const controlKeywords = new Set(["catch", "do", "for", "if", "switch", "try", "while", "with"]);

  const nextToken = (start, value, limit = tokens.length) => {
    for (let index = start; index < limit; index += 1) {
      if (tokens[index].value === value) return index;
    }
    return -1;
  };
  const statementEnd = (start) => {
    if (start < 0 || start >= tokens.length) return start;
    if (tokens[start].value === "{") return pairs.get(start) ?? start;
    if (tokens[start].value === "if") {
      const conditionOpen = nextToken(start + 1, "(");
      const conditionClose = pairs.get(conditionOpen);
      if (conditionOpen >= 0 && conditionClose !== undefined) {
        const consequentEnd = statementEnd(conditionClose + 1);
        if (tokens[consequentEnd + 1]?.value === "else") return statementEnd(consequentEnd + 2);
        return consequentEnd;
      }
    }
    for (let index = start; index < tokens.length; index += 1) {
      if (["(", "[", "{"].includes(tokens[index].value) && pairs.has(index)) {
        index = pairs.get(index);
        continue;
      }
      if (tokens[index].value === ";") return index;
    }
    return tokens.length - 1;
  };

  const frames = [{ id: "root", start: 0, end: Math.max(0, tokens.length - 1) }];
  const seenFrames = new Set();
  const addFrame = (start, end, label) => {
    if (start < 0 || end < start) return;
    const key = `${start}:${end}`;
    if (seenFrames.has(key)) return;
    seenFrames.add(key);
    frames.push({ id: `${label}:${start}:${end}`, start, end });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === "function") {
      const paramsOpen = nextToken(index + 1, "(");
      const paramsClose = pairs.get(paramsOpen);
      const bodyOpen = paramsClose === undefined ? -1 : nextToken(paramsClose + 1, "{", paramsClose + 4);
      if (bodyOpen >= 0 && pairs.has(bodyOpen)) addFrame(bodyOpen + 1, pairs.get(bodyOpen) - 1, "function");
    }
    if (tokens[index].value === "=>") {
      if (tokens[index + 1]?.value === "{" && pairs.has(index + 1)) {
        addFrame(index + 2, pairs.get(index + 1) - 1, "arrow");
      } else {
        let end = tokens.length - 1;
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
          const value = tokens[cursor].value;
          if (["(", "[", "{"].includes(value) && pairs.has(cursor)) {
            cursor = pairs.get(cursor);
            continue;
          }
          if ([")", "]", "}", ",", ";"].includes(value)) {
            end = cursor - 1;
            break;
          }
        }
        addFrame(index + 1, end, "arrow-expression");
      }
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "{" || !pairs.has(index) || tokens[index - 1]?.value !== ")") continue;
    const paramsOpen = reversePairs.get(index - 1);
    const methodName = paramsOpen === undefined ? null : tokens[paramsOpen - 1]?.value;
    if (methodName && !controlKeywords.has(methodName)) addFrame(index + 1, pairs.get(index) - 1, "method");
  }

  const contexts = [];
  let group = 0;
  const addContext = (branch, start, end, kind) => {
    if (start >= 0 && end >= start) contexts.push({ group, branch, start, end, kind });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === "if") {
      const conditionOpen = nextToken(index + 1, "(");
      const conditionClose = pairs.get(conditionOpen);
      if (conditionOpen < 0 || conditionClose === undefined) continue;
      group += 1;
      const consequentStart = conditionClose + 1;
      const consequentEnd = statementEnd(consequentStart);
      addContext("then", consequentStart, consequentEnd, "branch");
      if (tokens[consequentEnd + 1]?.value === "else") {
        const alternateStart = consequentEnd + 2;
        addContext("else", alternateStart, statementEnd(alternateStart), "branch");
      }
    }
    if (["for", "while"].includes(tokens[index].value)) {
      const conditionOpen = nextToken(index + 1, "(");
      const conditionClose = pairs.get(conditionOpen);
      if (conditionOpen < 0 || conditionClose === undefined) continue;
      group += 1;
      const bodyStart = conditionClose + 1;
      addContext("body", bodyStart, statementEnd(bodyStart), "optional");
    }
    if (tokens[index].value === "do") {
      group += 1;
      addContext("body", index + 1, statementEnd(index + 1), "optional");
    }
  }
  const ifInfos = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "if") continue;
    const conditionOpen = nextToken(index + 1, "(");
    const conditionClose = pairs.get(conditionOpen);
    if (conditionOpen < 0 || conditionClose === undefined) continue;
    const consequentStart = conditionClose + 1;
    const consequentEnd = statementEnd(consequentStart);
    ifInfos.push({ index, consequentStart, consequentEnd, elseIndex: consequentEnd + 1 });
  }
  const infoByIndex = new Map(ifInfos.map((info) => [info.index, info]));
  const previousIfByElse = new Map(ifInfos
    .filter((info) => tokens[info.elseIndex]?.value === "else")
    .map((info) => [info.elseIndex, info.index]));
  const previousIfForElse = (elseIndex) => {
    if (previousIfByElse.has(elseIndex)) return previousIfByElse.get(elseIndex);
    const previousClose = elseIndex - 1;
    if (tokens[previousClose]?.value !== "}") return undefined;
    const previousOpen = reversePairs.get(previousClose);
    const conditionClose = previousOpen === undefined ? -1 : previousOpen - 1;
    const conditionOpen = reversePairs.get(conditionClose);
    return conditionOpen !== undefined && tokens[conditionOpen - 1]?.value === "if"
      ? conditionOpen - 1
      : undefined;
  };
  const chainRoot = (ifIndex) => {
    const precedingElse = tokens[ifIndex - 1]?.value === "else" ? ifIndex - 1 : -1;
    const previousIf = previousIfForElse(precedingElse);
    return previousIf === undefined ? ifIndex : chainRoot(previousIf);
  };
  for (const info of ifInfos) {
    const chainGroup = `if-chain:${chainRoot(info.index)}`;
    contexts.push({
      group: chainGroup,
      branch: `if:${info.index}`,
      start: info.consequentStart,
      end: info.consequentEnd,
      kind: "branch-chain",
    });
    if (tokens[info.elseIndex]?.value !== "else") continue;
    const alternateStart = info.elseIndex + 1;
    if (infoByIndex.has(alternateStart)) continue;
    contexts.push({
      group: chainGroup,
      branch: "else",
      start: alternateStart,
      end: statementEnd(alternateStart),
      kind: "branch-chain",
    });
  }

  const frameAt = (tokenIndex) => frames
    .filter((frame) => frame.start <= tokenIndex && tokenIndex <= frame.end)
    .sort((left, right) => (right.start - left.start) || (left.end - right.end))[0]?.id || "root";
  const contextAt = (tokenIndex) => new Map(contexts
    .filter((context) => context.start <= tokenIndex && tokenIndex <= context.end)
    .map((context) => [context.group, context.branch]));
  const compatible = (left, right) => {
    for (const [contextGroup, branch] of left) {
      if (right.has(contextGroup) && right.get(contextGroup) !== branch) return false;
    }
    return true;
  };
  const terminators = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => {
      if (token.value !== "return" && token.value !== "throw") return false;
      // Property access, object keys, and method names are not control-flow
      // statements even though their token text is a reserved keyword.
      const nextOpen = tokens[index + 1]?.value === "(" ? index + 1 : -1;
      const nextClose = pairs.get(nextOpen);
      const methodDefinition = nextClose !== undefined && tokens[nextClose + 1]?.value === "{";
      return tokens[index - 1]?.value !== "."
        && tokens[index + 1]?.value !== ":"
        && !methodDefinition;
    })
    .map(({ token, index }) => ({
      tokenIndex: index,
      position: token.start,
      frame: frameAt(index),
      context: contextAt(index),
    }));

  return { masked, tokens, tokenIndexAt: (position) => tokenIndexAt(tokens, position), frameAt, contextAt, compatible, terminators };
}

function matchingCallEnd(masked, openPosition) {
  let depth = 0;
  for (let index = openPosition; index < masked.length; index += 1) {
    if (masked[index] === "(") depth += 1;
    if (masked[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findSerializedBindings(control) {
  const bindings = [];
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*JSON\s*\.\s*stringify\s*\(/g;
  let match;
  while ((match = pattern.exec(control.masked)) !== null) {
    const tokenIndex = control.tokenIndexAt(match.index);
    bindings.push({
      name: match[1],
      position: match.index,
      frame: control.frameAt(tokenIndex),
      context: control.contextAt(tokenIndex),
    });
  }
  return bindings;
}

function findCallSites(source, control, pattern, kind, serializedBindings = []) {
  const sites = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(control.masked)) !== null) {
    const openPosition = control.masked.indexOf("(", match.index);
    const endPosition = matchingCallEnd(control.masked, openPosition);
    if (endPosition < 0) continue;
    const maskedArgs = control.masked.slice(openPosition + 1, endPosition);
    const rawArgs = source.slice(openPosition + 1, endPosition);
    const siteToken = control.tokenIndexAt(match.index);
    const siteFrame = control.frameAt(siteToken);
    const siteContext = control.contextAt(siteToken);
    const aliasMatch = maskedArgs.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    const serializedAlias = aliasMatch !== null && serializedBindings.some((binding) =>
      binding.name === aliasMatch[1]
      && binding.position < match.index
      && binding.frame === siteFrame
      && control.compatible(binding.context, siteContext));
    const serialized = kind.startsWith("console.log")
      ? /^\s*JSON\s*\.\s*stringify\s*\(/.test(maskedArgs)
      : /^\s*JSON\s*\.\s*stringify\s*\(/.test(maskedArgs)
        || /^\s*Buffer\s*\.\s*from\s*\(\s*JSON\s*\.\s*stringify\s*\(/.test(maskedArgs)
        || /`[^`]*\$\{\s*JSON\s*\.\s*stringify\s*\(/s.test(rawArgs);
    if (!serialized && !serializedAlias) continue;
    sites.push({
      kind,
      position: match.index,
      line: sourceLineAt(source, match.index),
      tokenIndex: siteToken,
      frame: siteFrame,
      context: siteContext,
    });
  }
  return sites;
}

function scanExitAfterStdoutJson(source, file = "fixture.mjs") {
  const control = analyzeJavascriptControl(source);
  const serializedBindings = findSerializedBindings(control);
  const emissions = [
    ...findCallSites(source, control, /\bconsole\s*\.\s*log\s*\(/g, "console.log(JSON.stringify)"),
    ...findCallSites(source, control, /\bprocess\s*\.\s*stdout\s*\.\s*write\s*\(/g, "process.stdout.write(serialized JSON)", serializedBindings),
  ].sort((left, right) => left.position - right.position);
  const exits = [];
  const exitPattern = /\bprocess\s*\.\s*exit\s*\(/g;
  let exitMatch;
  while ((exitMatch = exitPattern.exec(control.masked)) !== null) {
    const siteToken = control.tokenIndexAt(exitMatch.index);
    exits.push({
      position: exitMatch.index,
      line: sourceLineAt(source, exitMatch.index),
      tokenIndex: siteToken,
      frame: control.frameAt(siteToken),
      context: control.contextAt(siteToken),
    });
  }
  const findings = [];
  for (const exit of exits) {
    const candidates = emissions.filter((emission) =>
      emission.position < exit.position
      && emission.frame === exit.frame
      && control.compatible(emission.context, exit.context));
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const emission = candidates[index];
      const blocked = control.terminators.some((terminator) => {
        if (terminator.position <= emission.position || terminator.position >= exit.position) return false;
        if (terminator.frame !== exit.frame) return false;
        if (!control.compatible(terminator.context, emission.context) || !control.compatible(terminator.context, exit.context)) return false;
        for (const [contextGroup, branch] of terminator.context) {
          if (emission.context.get(contextGroup) !== branch && exit.context.get(contextGroup) !== branch) return false;
        }
        return true;
      });
      if (blocked) continue;
      const key = `${file}:${emission.line}->${exit.line}`;
      findings.push({
        key,
        file,
        emission_line: emission.line,
        exit_line: exit.line,
        emission_kind: emission.kind,
        frame: exit.frame,
        emission_context: Object.fromEntries(emission.context),
        exit_context: Object.fromEntries(exit.context),
      });
      break;
    }
  }
  return findings;
}

function applyExitDisciplineExemptions(findings, exemptions = exitAfterStdoutJsonExemptions) {
  const findingKeys = new Set(findings.map((finding) => finding.key));
  return {
    unexempted: findings.filter((finding) => !exemptions.has(finding.key)),
    invalidReasons: [...exemptions]
      .filter(([, reason]) => String(reason).trim().length < 40 || /[\r\n]/.test(String(reason)))
      .map(([key]) => key),
    staleKeys: [...exemptions.keys()].filter((key) => !findingKeys.has(key)),
  };
}

function discoverExitDisciplineSources() {
  const roots = [
    { dir: scriptsDir, prefix: "scripts" },
    { dir: join(scriptsDir, "lib"), prefix: "scripts/lib" },
  ];
  return roots.flatMap(({ dir, prefix }) => readdirSync(dir)
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => ({ path: join(dir, name), relative: `${prefix}/${name}` })));
}

function assertExitAfterStdoutJsonDiscipline() {
  const historicalUnsafe = [
    "function main(options) {",
    "  const result = { ok: true };",
    "  if (options.json) {",
    "    console.log(JSON.stringify(result, null, 2));",
    "  } else {",
    "    console.log('human');",
    "  }",
    "  process.exit(0);",
    "}",
  ].join("\n");
  const directFallthrough = [
    "function main(payload) {",
    "  process.stdout.write(`${JSON.stringify(payload)}\\n`);",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const aliasedFallthrough = [
    "function main(payload) {",
    "  const serialized = JSON.stringify(payload);",
    "  process.stdout.write(serialized);",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const wrappedFallthrough = [
    "function main(payload) {",
    "  process.stdout.write(Buffer.from(JSON.stringify(payload)));",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const propertyKeywordFallthrough = [
    "function main(payload) {",
    "  console.log(JSON.stringify(payload));",
    "  const metadata = { return: true, throw: false };",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const methodKeywordFallthrough = [
    "function main(payload) {",
    "  console.log(JSON.stringify(payload));",
    "  const metadata = { return() { return true; }, throw() { return false; } };",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const safeFixtures = new Map([
    ["return and exitCode barrier", [
      "function main(payload) {",
      "  console.log(JSON.stringify(payload));",
      "  process.exitCode = 1;",
      "  return;",
      "  process.exit(1);",
      "}",
    ].join("\n")],
    ["sibling else branch", [
      "if (json) {",
      "  console.log(JSON.stringify(payload));",
      "} else {",
      "  process.exit(1);",
      "}",
    ].join("\n")],
    ["long else-if dispatcher", [
      "const marker = '🧭';",
      "if (command === 'start') {",
      "  runStart();",
      "} else if (command === 'emit') {",
      "  console.log(JSON.stringify(payload));",
      "} else if (command === 'stop') {",
      "  process.exit(1);",
      "} else {",
      "  process.exit(2);",
      "}",
    ].join("\n")],
    ["separate callable frames", [
      "function emit(payload) { console.log(JSON.stringify(payload)); }",
      "function stop() { process.exit(1); }",
    ].join("\n")],
    ["rejection callback frame", [
      "function main(payload) {",
      "  console.log(JSON.stringify(payload));",
      "  return Promise.resolve().catch(() => process.exit(1));",
      "}",
    ].join("\n")],
    ["comments and string literals", [
      "const sample = 'console.log(JSON.stringify(payload)); process.exit(1);';",
      "// console.log(JSON.stringify(payload)); process.exit(1);",
      "const pattern = /process\\.exit\\(.*JSON\\.stringify/;",
    ].join("\n")],
    ["P-100 awaited callback frame", [
      "function write(payload) {",
      "  process.stdout.write(`${JSON.stringify(payload)}\\n`, () => {",
      "    process.exit(0);",
      "  });",
      "}",
    ].join("\n")],
    ["throw barrier", [
      "function main(payload) {",
      "  console.log(JSON.stringify(payload));",
      "  throw new Error('stop');",
      "  process.exit(1);",
      "}",
    ].join("\n")],
    ["parenthesized return barrier", [
      "function main(payload) {",
      "  console.log(JSON.stringify(payload));",
      "  return (0);",
      "  process.exit(1);",
      "}",
    ].join("\n")],
  ]);

  const historicalFindings = scanExitAfterStdoutJson(historicalUnsafe, "historical-gate-false-failure-ledger.mjs");
  assert(historicalFindings.length === 1, "P-061 historical unsafe fixture produces a RED lint verdict", JSON.stringify(historicalFindings));
  assert(
    historicalFindings[0]?.emission_kind === "console.log(JSON.stringify)"
      && historicalFindings[0]?.emission_line === 4
      && historicalFindings[0]?.exit_line === 8,
    "P-061 historical finding identity is deterministic",
    JSON.stringify(historicalFindings[0] || null),
  );
  const fallthroughFindings = scanExitAfterStdoutJson(directFallthrough, "direct-fallthrough.mjs");
  assert(fallthroughFindings.length === 1, "P-061 direct stdout.write fallthrough produces a RED lint verdict", JSON.stringify(fallthroughFindings));
  const aliasedFindings = scanExitAfterStdoutJson(aliasedFallthrough, "aliased-fallthrough.mjs");
  assert(aliasedFindings.length === 1, "P-061 aliased serialized stdout.write fallthrough produces a RED lint verdict", JSON.stringify(aliasedFindings));
  const wrappedFindings = scanExitAfterStdoutJson(wrappedFallthrough, "wrapped-fallthrough.mjs");
  assert(wrappedFindings.length === 1, "P-061 Buffer-wrapped stdout.write fallthrough produces a RED lint verdict", JSON.stringify(wrappedFindings));
  const propertyKeywordFindings = scanExitAfterStdoutJson(propertyKeywordFallthrough, "property-keyword-fallthrough.mjs");
  assert(propertyKeywordFindings.length === 1, "P-061 property names do not suppress a reachable exit finding", JSON.stringify(propertyKeywordFindings));
  const methodKeywordFindings = scanExitAfterStdoutJson(methodKeywordFallthrough, "method-keyword-fallthrough.mjs");
  assert(methodKeywordFindings.length === 1, "P-061 method names do not suppress a reachable exit finding", JSON.stringify(methodKeywordFindings));
  for (const [label, fixture] of safeFixtures) {
    const findings = scanExitAfterStdoutJson(fixture, `${label.replace(/\s+/g, "-")}.mjs`);
    assert(findings.length === 0, `P-061 safe fixture remains green: ${label}`, JSON.stringify(findings));
  }

  const shortReason = applyExitDisciplineExemptions(historicalFindings, new Map([[historicalFindings[0].key, "too short"]]));
  assert(shortReason.invalidReasons.length === 1, "P-061 exemption reasons must contain at least 40 characters");
  const multilineReason = applyExitDisciplineExemptions(historicalFindings, new Map([[
    historicalFindings[0].key,
    "This first line is deliberately long enough to pass length.\nThis second line must make it invalid.",
  ]]));
  assert(multilineReason.invalidReasons.length === 1, "P-061 exemption rationales must remain one line");
  const staleReason = applyExitDisciplineExemptions([], new Map([["stale.mjs:1->2", "This intentionally long rationale proves stale keys fail closed."]]));
  assert(staleReason.staleKeys.length === 1, "P-061 exemption inventory rejects stale finding keys");
  assert(exitAfterStdoutJsonExemptions.size === 0, "P-061 committed exit-discipline exemption inventory is empty");

  const sources = discoverExitDisciplineSources();
  const findings = sources.flatMap(({ path, relative }) => scanExitAfterStdoutJson(readFileSync(path, "utf-8"), relative));
  const exempted = applyExitDisciplineExemptions(findings);
  assert(sources.some(({ relative }) => relative.startsWith("scripts/lib/")), "P-061 scan includes the direct scripts/lib root");
  assert(sources.length >= 300, "P-061 scan covers the full direct scripts and scripts/lib inventory", `count=${sources.length}`);
  assert(exempted.invalidReasons.length === 0, "P-061 current exemption reasons are complete", exempted.invalidReasons.join(", "));
  assert(exempted.staleKeys.length === 0, "P-061 current exemption inventory has no stale entries", exempted.staleKeys.join(", "));
  assert(exempted.unexempted.length === 0, "P-061 post-B1 source tree has zero exit-after-stdout-JSON findings", JSON.stringify(exempted.unexempted));
}

function assertConformanceRunnerWired() {
  const source = readFileSync(conformanceRunnerPath, "utf-8");
  const suiteStart = source.indexOf('id: "cli-determinism"');
  const suiteEnd = source.indexOf('id: "quant-results-validation"', suiteStart);
  const suiteSource = suiteStart >= 0 && suiteEnd > suiteStart
    ? source.slice(suiteStart, suiteEnd)
    : "";
  assert(source.includes('id: "cli-determinism"'), "conformance runner exposes cli-determinism");
  assert(!source.includes('id: "cli-json-emission"'), "old cli-json-emission conformance slot is folded away");
  assert(source.includes("test_cli_determinism.mjs"), "conformance runner points at the determinism suite");
  assert(suiteSource.includes('skillRel("scripts/planner.mjs")'), "cli-determinism owns the planner dispatcher fixture");
  assert(suiteSource.includes('".agent/workflows/reflection.md"'), "cli-determinism owns the documented reflection workflow fixture");
}

function assertUnsafeContractRejected() {
  for (const descriptor of executableDescriptors) {
    const source = readFileSync(join(scriptsDir, descriptor.fileName), "utf-8");
    assert(source.includes("emitJson("), `${descriptor.fileName} uses shared emitJson() helper`);
    assert(!/console\.(log|error)\([^;\n]*JSON\.stringify/s.test(source), `${descriptor.fileName} does not write JSON with console.log/error(JSON.stringify(...))`);
    assert(!/process\.exit\(\s*main\s*\(/.test(source), `${descriptor.fileName} does not force process.exit(main()) after CLI output`);
  }
}

function assertEmitJsonExitCodeContract() {
  const helperPath = join(skillDir, "scripts", "lib", "emit_json.mjs");
  const helperUrl = pathToFileURL(helperPath).href;
  const result = spawnSync(
    NODE,
    [
      "--input-type=module",
      "--eval",
      `import { emitJson } from ${JSON.stringify(helperUrl)}; emitJson({ ok: true, payload: "x".repeat(${LARGE_JSON_BYTES}) }, { exitCode: 7 });`,
    ],
    {
      cwd: repoRoot,
      env: baseEnv(),
      encoding: "utf-8",
      maxBuffer: MAX_BUFFER,
    },
  );
  const parsed = parseJsonFromResult(result, "emitJson exitCode contract");
  assert(parsed.ok, "emitJson exitCode contract emits one parseable JSON document", parsed.error || "");
  assert(parsed.byteLength > LARGE_JSON_BYTES, "emitJson exitCode contract completes a payload larger than 16KiB");
  assert(result.status === 7, "emitJson exitCode contract observes the requested child status", `status=${result.status}`);
  const helperSource = readFileSync(helperPath, "utf-8");
  assert(!helperSource.includes("process.exit("), "emitJson helper never forces process termination");
}

function runDescriptor(descriptor, context, { pty = false, redirect = false } = {}) {
  const args = descriptor.args(context);
  const cwd = typeof descriptor.cwd === "function" ? descriptor.cwd(context) : (descriptor.cwd || context.root);
  if (pty) return runPty(args, { cwd });
  if (!redirect) return runNode(args, { cwd });

  const outputPath = join(context.fixtures.root, `${descriptor.fileName.replace(/[^a-z0-9]+/gi, "_")}.redirect.json`);
  const fd = openSync(outputPath, "w");
  try {
    return spawnSync(NODE, args, {
      cwd,
      env: baseEnv(),
      encoding: "utf-8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", fd, "pipe"],
    });
  } finally {
    closeSync(fd);
  }
}

function assertDescriptorDeterminism(context) {
  for (const descriptor of executableDescriptors) {
    const pipe = parseJsonFromResult(runDescriptor(descriptor, context), descriptor.label, { stream: descriptor.stream || "stdout" });
    assert(pipe.ok, `${descriptor.label}: pipe JSON parses`, pipe.error || "");
    if (!pipe.ok) continue;

    const repeat = parseJsonFromResult(runDescriptor(descriptor, context), `${descriptor.label} repeat`, { stream: descriptor.stream || "stdout" });
    assert(repeat.ok, `${descriptor.label}: repeat JSON parses`, repeat.error || "");
    assert(repeat.ok && canonicalJson(pipe.parsed) === canonicalJson(repeat.parsed), `${descriptor.label}: repeat normalized bytes are identical`);
    assert(pipe.status === repeat.status, `${descriptor.label}: repeat exit code is stable`);

    const pty = parseJsonFromResult(runDescriptor(descriptor, context, { pty: true }), `${descriptor.label} PTY`, { pty: true });
    assert(pty.ok, `${descriptor.label}: PTY JSON parses`, pty.error || "");
    assert(pty.ok && canonicalJson(pipe.parsed) === canonicalJson(pty.parsed), `${descriptor.label}: pipe and PTY normalized bytes are identical`);

    if (descriptor.minBytes) {
      assert(pipe.byteLength > descriptor.minBytes, `${descriptor.label}: payload exceeds ${descriptor.minBytes} bytes`);
    }
    if (Number.isInteger(descriptor.expectedStatus)) {
      const failureDetail = JSON.stringify(pipe.parsed?.receipt?.grade?.failures || pipe.parsed?.error || {});
      assert(pipe.status === descriptor.expectedStatus, `${descriptor.label}: pipe exit status is ${descriptor.expectedStatus}`, failureDetail);
      assert(pty.status === descriptor.expectedStatus, `${descriptor.label}: PTY exit status is ${descriptor.expectedStatus}`, failureDetail);
    }
  }
}

function assertRedirectParity(context) {
  for (const descriptor of executableDescriptors.filter((item) => item.stream !== "stderr")) {
    const pipe = parseJsonFromResult(runDescriptor(descriptor, context), `${descriptor.label} pipe`);
    const redirected = runDescriptor(descriptor, context, { redirect: true });
    const outputPath = join(context.fixtures.root, `${descriptor.fileName.replace(/[^a-z0-9]+/gi, "_")}.redirect.json`);
    const redirectedText = readFileSync(outputPath, "utf-8");
    let redirectedParsed = null;
    try {
      redirectedParsed = JSON.parse(redirectedText);
    } catch {
      // Assertion below reports the parse failure.
    }
    assert(redirectedParsed !== null, `${descriptor.label}: redirected JSON parses`);
    assert(redirectedParsed !== null && canonicalJson(pipe.parsed) === canonicalJson(redirectedParsed), `${descriptor.label}: pipe and redirected normalized bytes are identical`);
    assert(pipe.status === redirected.status, `${descriptor.label}: redirected exit code matches pipe exit code`);
  }
}

function assertReflectionDispatcherParity(context) {
  const plannerPath = scriptPath(context.skillDir, "planner.mjs");
  const guidePath = scriptPath(context.skillDir, "reflection_guide.mjs");
  const validatorPath = scriptPath(context.skillDir, "validate_reflection.mjs");
  const workflowSource = readFileSync(join(context.root, ".agent", "workflows", "reflection.md"), "utf-8");
  const documentedGuideCommand = "node .agent/skills/iterative-planner/scripts/planner.mjs reflection-guide --plan <plan-dir> --json";
  const documentedValidatorCommand = "node .agent/skills/iterative-planner/scripts/planner.mjs validate-reflection plans/<plan-id>/reflection.md --json";

  assert(workflowSource.includes(documentedGuideCommand), "reflection workflow cites the exact reflection-guide dispatcher command");
  assert(workflowSource.includes(documentedValidatorCommand), "reflection workflow cites the exact validate-reflection dispatcher command");

  const dispatcherHelp = runNode([plannerPath, "--help"], { cwd: context.fixtures.reflectionRoot });
  assert(dispatcherHelp.status === 0, "planner dispatcher help exits zero");
  assert(
    dispatcherHelp.stdout.includes("planner.mjs reflection-guide --plan <plan-dir> [--json]"),
    "planner dispatcher help advertises reflection-guide",
  );
  assert(
    dispatcherHelp.stdout.includes("planner.mjs validate-reflection <path> [--json]"),
    "planner dispatcher help advertises validate-reflection",
  );

  const directGuideHelp = runNode([guidePath, "--help"], { cwd: context.fixtures.reflectionRoot });
  const dispatchedGuideHelp = runNode([plannerPath, "reflection-guide", "--help"], { cwd: context.fixtures.reflectionRoot });
  assert(directGuideHelp.status === 0, "reflection-guide direct help exits zero");
  assertProcessParity(directGuideHelp, dispatchedGuideHelp, "reflection-guide help");

  const missingPlanArgs = ["--plan", "plan_missing_dispatcher", "--json"];
  const directMissingPlan = runNode([guidePath, ...missingPlanArgs], { cwd: context.fixtures.reflectionRoot });
  const dispatchedMissingPlan = runNode([plannerPath, "reflection-guide", ...missingPlanArgs], { cwd: context.fixtures.reflectionRoot });
  const missingPlanPayload = parseJsonFromResult(directMissingPlan, "reflection-guide missing plan", { stream: "stderr" });
  assert(directMissingPlan.status === 1, "reflection-guide direct missing-plan path exits one");
  assert(
    missingPlanPayload.ok && missingPlanPayload.parsed?.ok === false && missingPlanPayload.parsed?.error === "missing_plan",
    "reflection-guide direct missing-plan path emits JSON failure on stderr",
  );
  assertProcessParity(directMissingPlan, dispatchedMissingPlan, "reflection-guide missing plan");

  const generatedGuidePath = join(
    context.fixtures.reflectionRoot,
    "plans",
    "plan_emit_json",
    "reflection_guide.yaml",
  );
  const validGuideArgs = ["--plan", "plan_emit_json", "--json"];
  rmSync(generatedGuidePath, { force: true });
  const directGuide = runNode([guidePath, ...validGuideArgs], { cwd: context.fixtures.reflectionRoot });
  const directGuidePayload = parseJsonFromResult(directGuide, "reflection-guide direct valid");
  const directGuideArtifact = readJsonFile(generatedGuidePath);
  rmSync(generatedGuidePath, { force: true });
  const dispatchedGuide = runNode([plannerPath, "reflection-guide", ...validGuideArgs], { cwd: context.fixtures.reflectionRoot });
  const dispatchedGuideArtifact = readJsonFile(generatedGuidePath);
  assert(directGuide.status === 0, "reflection-guide direct valid path exits zero");
  assert(directGuidePayload.ok && directGuidePayload.parsed?.ok === true, "reflection-guide direct valid path emits JSON success");
  assert(directGuideArtifact !== null, "reflection-guide direct path writes its child artifact");
  assert(dispatchedGuideArtifact !== null, "reflection-guide dispatcher writes its child artifact");
  assert(
    directGuideArtifact !== null
      && dispatchedGuideArtifact !== null
      && canonicalJson(directGuideArtifact) === canonicalJson(dispatchedGuideArtifact),
    "reflection-guide dispatcher preserves the normalized child artifact",
  );
  assertProcessParity(directGuide, dispatchedGuide, "reflection-guide valid");

  const directValidatorHelp = runNode([validatorPath, "--help"], { cwd: context.fixtures.reflectionValidationRoot });
  const dispatchedValidatorHelp = runNode([plannerPath, "validate-reflection", "--help"], { cwd: context.fixtures.reflectionValidationRoot });
  assert(directValidatorHelp.status === 0, "validate-reflection direct help exits zero");
  assertProcessParity(directValidatorHelp, dispatchedValidatorHelp, "validate-reflection help");

  const missingReflectionArgs = ["plans/plan_validate_reflection/missing.md", "--json"];
  const directMissingReflection = runNode([validatorPath, ...missingReflectionArgs], { cwd: context.fixtures.reflectionValidationRoot });
  const dispatchedMissingReflection = runNode(
    [plannerPath, "validate-reflection", ...missingReflectionArgs],
    { cwd: context.fixtures.reflectionValidationRoot },
  );
  const missingReflectionPayload = parseJsonFromResult(
    directMissingReflection,
    "validate-reflection missing file",
    { stream: "stderr" },
  );
  assert(directMissingReflection.status === 1, "validate-reflection direct missing-file path exits one");
  assert(
    missingReflectionPayload.ok
      && missingReflectionPayload.parsed?.ok === false
      && missingReflectionPayload.parsed?.issues?.some((issue) => issue.includes("reflection file is missing")),
    "validate-reflection direct missing-file path emits JSON failure on stderr",
  );
  assertProcessParity(directMissingReflection, dispatchedMissingReflection, "validate-reflection missing file");

  const validReflectionArgs = ["plans/plan_validate_reflection/reflection.md", "--json"];
  const directReflection = runNode([validatorPath, ...validReflectionArgs], { cwd: context.fixtures.reflectionValidationRoot });
  const dispatchedReflection = runNode(
    [plannerPath, "validate-reflection", ...validReflectionArgs],
    { cwd: context.fixtures.reflectionValidationRoot },
  );
  const validReflectionPayload = parseJsonFromResult(directReflection, "validate-reflection direct valid");
  assert(directReflection.status === 0, "validate-reflection direct valid path exits zero");
  assert(
    validReflectionPayload.ok
      && validReflectionPayload.parsed?.ok === true
      && validReflectionPayload.parsed?.required_question_count === 1
      && validReflectionPayload.parsed?.answered_question_count === 1,
    "validate-reflection direct valid path accepts the guide-backed child artifact",
  );
  assert(existsSync(context.fixtures.validReflectionGuidePath), "validate-reflection fixture retains its guide child artifact");
  assertProcessParity(directReflection, dispatchedReflection, "validate-reflection valid");
}

function assertSignaledChildFailure(tmp) {
  const fixtureDir = join(tmp, "signal-dispatcher");
  const copiedPlannerPath = join(fixtureDir, "planner.mjs");
  ensureDir(fixtureDir);
  cpSync(scriptPath(skillDir, "planner.mjs"), copiedPlannerPath);
  writeText(
    join(fixtureDir, "reflection_guide.mjs"),
    '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n',
  );

  const result = runNode([copiedPlannerPath, "reflection-guide"], { cwd: fixtureDir });
  assert(
    result.status !== 0 && result.signal === null,
    "planner dispatcher exits nonzero when a routed child terminates by signal",
    `status=${result.status ?? "null"}, signal=${result.signal ?? "none"}`,
  );
}

function assertPathWithSpaces(tmp) {
  const copiedRoot = copyMinimalCheckout(tmp);
  const context = {
    root: copiedRoot,
    skillDir: join(copiedRoot, ".agent", "skills", "iterative-planner"),
    fixtures: prepareFixtures(copiedRoot),
  };
  const pathCases = executableDescriptors.filter((descriptor) =>
    ["knowledge_packs.mjs", "check_profile.mjs", "ive_packet_validator.mjs", "reflection_guide.mjs", "validate_reflection.mjs"].includes(descriptor.fileName)
  );
  assert(copiedRoot.includes(" ") && copiedRoot.includes("(") && copiedRoot.includes(")"), "path fixture contains spaces and parentheses");
  for (const descriptor of pathCases) {
    const pipe = parseJsonFromResult(runDescriptor(descriptor, context), `${descriptor.label} spaced path`, { stream: descriptor.stream || "stdout" });
    assert(pipe.ok, `${descriptor.label}: spaced path JSON parses`, pipe.error || "");
    const repeat = parseJsonFromResult(runDescriptor(descriptor, context), `${descriptor.label} spaced path repeat`, { stream: descriptor.stream || "stdout" });
    assert(repeat.ok && canonicalJson(pipe.parsed) === canonicalJson(repeat.parsed), `${descriptor.label}: spaced path repeat normalized bytes are identical`);
  }
}

console.log("\nIVE CLI Determinism Regression\n");

const tmp = mkdtempSync(join(tmpdir(), "ive-cli-determinism-"));
try {
  const context = {
    root: repoRoot,
    skillDir,
    fixtures: prepareFixtures(tmp),
  };
  assertInventoryClosed();
  assertExitAfterStdoutJsonDiscipline();
  assertConformanceRunnerWired();
  assertReflectionDispatcherParity(context);
  assertSignaledChildFailure(tmp);
  assertEmitJsonExitCodeContract();
  assertUnsafeContractRejected();
  assertDescriptorDeterminism(context);
  assertRedirectParity(context);
  assertPathWithSpaces(tmp);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
