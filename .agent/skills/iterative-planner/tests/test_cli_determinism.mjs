#!/usr/bin/env node
// test_cli_determinism.mjs - n01 regression suite for planner JSON CLI determinism.

import { spawnSync } from "child_process";
import {
  closeSync,
  cpSync,
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
import { fileURLToPath } from "url";
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
  "gate_false_failure_ledger.mjs",
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
  "recipe_runner.mjs",
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
      ".github/workflows/fresh-context-reviewer.yml",
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

function assertConformanceRunnerWired() {
  const source = readFileSync(conformanceRunnerPath, "utf-8");
  assert(source.includes('id: "cli-determinism"'), "conformance runner exposes cli-determinism");
  assert(!source.includes('id: "cli-json-emission"'), "old cli-json-emission conformance slot is folded away");
  assert(source.includes("test_cli_determinism.mjs"), "conformance runner points at the determinism suite");
}

function assertUnsafeContractRejected() {
  for (const descriptor of executableDescriptors) {
    const source = readFileSync(join(scriptsDir, descriptor.fileName), "utf-8");
    assert(source.includes("emitJson("), `${descriptor.fileName} uses shared emitJson() helper`);
    assert(!/console\.(log|error)\([^;\n]*JSON\.stringify/s.test(source), `${descriptor.fileName} does not write JSON with console.log/error(JSON.stringify(...))`);
    assert(!/process\.exit\(\s*main\s*\(/.test(source), `${descriptor.fileName} does not force process.exit(main()) after CLI output`);
  }
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
  assertConformanceRunnerWired();
  assertUnsafeContractRejected();
  assertDescriptorDeterminism(context);
  assertRedirectParity(context);
  assertPathWithSpaces(tmp);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
