#!/usr/bin/env node

// @planner:module = quant_researcher_e2e_test
// @planner:proves = sc_1,sc_2,sc_3,sc_4,sc_5

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  OUTER_LIFECYCLE,
  buildE2EScoreboard,
  buildKillPromoteRouteEnvelope,
  runQuantResearchFixture,
} from "../scripts/quant_researcher_contracts.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const manifestPath = resolve(__dirname, "fixtures", "quant_researcher_e2e_manifest.json");
const dataReceiptEvaluatedAt = "2026-07-17T00:00:10.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const hashC = `sha256:${"c".repeat(64)}`;
// Test-only direct-user confirmation fixture. Production code must never construct user confirmation.
const TEST_KILL_PROMOTE_CONFIRMATION = "Yes, proceed";
const countersignNow = "2026-07-17T00:10:00.000Z";
const countersignRecordedAt = "2026-07-17T00:09:00.000Z";

function buildFixtureCountersign(caseRow, envelope, researcherContextId) {
  const review = {
    review_type: caseRow.countersign_control === "skeptic_contest" ? "skeptic" : "referee",
    source: "artifact_only",
    verdict: caseRow.countersign_control === "skeptic_contest" ? "contested" : "passed",
    reviewer_actor: `agent:${caseRow.id}:referee`,
    reviewer_context_id: `context:${caseRow.id}:referee`,
    researcher_context_id: researcherContextId,
    route: envelope.route,
    envelope_sha256: envelope.envelope_sha256,
    artifact_refs_sha256: envelope.artifact_refs_sha256,
  };
  if (caseRow.countersign_control === "referee_mismatch") {
    review.envelope_sha256 = "0".repeat(64);
  }
  return {
    evaluated_at: countersignNow,
    human_authorization: {
      action_class: "kill_promote",
      mode: "execute",
      target: envelope.target,
      payload_ref: envelope.payload_ref,
      confirmation: {
        text: TEST_KILL_PROMOTE_CONFIRMATION,
        actor: `human:${caseRow.id}:operator`,
        source: "direct_user_input",
        recorded_at: countersignRecordedAt,
        generated: false,
        delegated: false,
        action_class: "kill_promote",
        target: envelope.target,
        payload_ref: envelope.payload_ref,
      },
    },
    agent_reviews: [review],
  };
}

function parseArgs(argv) {
  const args = {
    type: "all",
    min: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--type") {
      args.type = argv[index + 1];
      index += 1;
    } else if (arg === "--min") {
      args.min = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/quant-researcher/tests/test_quant_researcher_e2e.mjs --type <project-type> --min 10",
    "",
    "Use --type all to run every corpus.",
  ].join("\n");
}

function loadManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function baseValidation(projectType) {
  const validation = {
    leakage: true,
    controls: true,
    temporal_split: true,
    data_lineage: true,
    calibration: true,
    baseline: true,
    stale_artifact: false,
    missing_provider: false,
    no_next_move: false,
    promotion_candidate: false,
    sample_floor_met: true,
  };
  if (projectType === "tokenomics") {
    validation.governance_delay = true;
    validation.financial_or_legal_boundary = true;
  }
  return validation;
}

function processIdentity(caseRow) {
  if (!caseRow.process_identity_mismatch) return null;
  return {
    expected: {
      running_process: `${caseRow.id}:process:v1`,
      config: `${caseRow.id}:config:v1`,
      log_stream: `${caseRow.id}:log:v1`,
      code_under_test: `${caseRow.id}:code:v1`,
    },
    observed: {
      running_process: `${caseRow.id}:process:v1`,
      config: `${caseRow.id}:config:stale`,
      log_stream: `${caseRow.id}:log:stale`,
      code_under_test: `${caseRow.id}:code:v1`,
    },
  };
}

function dataReceipt(caseRow, receiptRef) {
  const identity = {
    running_process: `${caseRow.id}:fixture-process`,
    config: `${caseRow.id}:fixture-config`,
    log_stream: `${caseRow.id}:fixture-log`,
    code_under_test: `${caseRow.id}:fixture-code`,
  };
  const receipt = {
    schema_version: 1,
    receipt_ref: receiptRef,
    source: {
      ref: `fixture://${caseRow.id}/panel`,
      lineage: [`fixture://${caseRow.id}/raw`, `fixture://${caseRow.id}/panel`],
    },
    generator_identity: { expected: { ...identity }, observed: { ...identity } },
    span: {
      start_at: "2026-07-16T00:00:00.000Z",
      end_at: "2026-07-17T00:00:03.000Z",
      as_of_at: "2026-07-17T00:00:04.000Z",
    },
    generated_at: "2026-07-17T00:00:05.000Z",
    freshness: { max_age_seconds: 60 },
    row_counts: { observed: 10, expected: { min: 10, max: 10 } },
    coverage_counts: { observed: 8, expected: { min: 8, max: 8 } },
    content_hash: { algorithm: "sha256", observed: hashA, expected: hashA },
    schema_hash: { algorithm: "sha256", observed: hashB, expected: hashB },
    missing_data_profile: { missing_rows: 0, missing_cells: 0, fields: [] },
    known_at_time: {
      cutoff_at: "2026-07-17T00:00:03.000Z",
      latest_observation_at: "2026-07-17T00:00:02.000Z",
      future_canary: { passed: true, checked_fields: ["post_cutoff_value"] },
    },
  };

  switch (caseRow.receipt_failure) {
    case "stale":
      receipt.freshness.max_age_seconds = 1;
      break;
    case "incomplete_lineage":
      receipt.source.lineage = [];
      break;
    case "future_canary":
      receipt.known_at_time.future_canary.passed = false;
      break;
    case "content_hash_drift":
      receipt.content_hash.observed = hashC;
      break;
    case "schema_hash_drift":
      receipt.schema_hash.observed = hashC;
      break;
    case "row_count_mismatch":
      receipt.row_counts.observed = 9;
      break;
    case "coverage_count_mismatch":
      receipt.coverage_counts.observed = 7;
      break;
    default:
      break;
  }
  return receipt;
}

function dataReceiptEvidence(caseRow, receiptRef) {
  if (caseRow.receipt_failure === "missing") {
    return { data_receipts: [], data_receipt_evaluated_at: dataReceiptEvaluatedAt };
  }
  if (caseRow.receipt_failure === "empty") {
    return { data_receipts: [{}], data_receipt_evaluated_at: dataReceiptEvaluatedAt };
  }
  return {
    data_receipts: [dataReceipt(caseRow, receiptRef)],
    data_receipt_evaluated_at: dataReceiptEvaluatedAt,
  };
}

function expandFixture(projectType, typeConfig, caseRow) {
  const hypothesisId = `hyp-${slug(caseRow.id)}`;
  const receiptRef = `receipt://${caseRow.id}/input-v1`;
  const validation = {
    ...baseValidation(projectType),
    ...(caseRow.validation || {}),
  };
  const materialFact = {
    id: `fact-${slug(caseRow.id)}`,
    summary: caseRow.focus,
    material: true,
  };
  if (!caseRow.unrouted_fact_failure) {
    materialFact.route = caseRow.route === "report_only" ? "report_only" : caseRow.route;
  }

  const evidence = {
    validation,
    observed_sample_size: 10,
    artifact_refs: [
      `fixture://${caseRow.id}/charter`,
      `fixture://${caseRow.id}/evidence-ledger`,
    ],
    researcher_context_id: `context:${caseRow.id}:researcher`,
    material_facts: [materialFact],
    ...dataReceiptEvidence(caseRow, receiptRef),
  };
  const identity = processIdentity(caseRow);
  if (identity) evidence.process_identity = identity;
  if (!caseRow.omit_next) {
    evidence.next_best_experiment = {
      id: `next-${slug(caseRow.id)}`,
      rationale: `Next deterministic fixture experiment for ${caseRow.focus}.`,
    };
  }

  const fixture = {
    id: caseRow.id,
    project_type: projectType,
    title: caseRow.title,
    category: caseRow.category,
    planted_failure: caseRow.category === "planted-quant-failure",
    attempted_route: caseRow.attempted_route || null,
    prior_killed: caseRow.prior_killed
      ? [
          {
            hypothesis_id: hypothesisId,
            reason: `Prior falsification for ${caseRow.focus}.`,
            evidence_ref: `fixture://${caseRow.id}/prior-kill`,
          },
        ]
      : [],
    survey: {
      id: `survey-${slug(caseRow.id)}`,
      project_type: projectType,
      target: typeConfig.target,
      data_lineage: typeConfig.data_lineage,
      data_receipt_refs: [receiptRef],
      known_at_time: typeConfig.known_at_time,
      temporal_split: typeConfig.temporal_split,
      leakage_controls: typeConfig.leakage_controls,
      controls: typeConfig.controls,
      claim_boundary: ["killed-hypothesis", "smoke-kill-attempt", "countersign-control"].includes(caseRow.category)
        ? "negative over the enumerated deterministic fixture region only"
        : typeConfig.claim_boundary,
      signals: [
        {
          hypothesis_id: hypothesisId,
          statement: `Evaluate whether ${caseRow.focus} can route safely for ${projectType}.`,
          mechanism: `candidate signal: ${caseRow.focus}`,
          expected_metric: "route correctness with promotion blocked unless validation proves otherwise",
          falsification_threshold: "fails if lineage, temporal proof, leakage controls, baselines, or claim boundaries are invalid",
          data_requirements: [
            typeConfig.data_lineage,
            typeConfig.known_at_time,
            typeConfig.temporal_split,
          ],
          next_experiment: `fixture smoke for ${caseRow.focus}`,
          priority: caseRow.category === "golden" ? 10 : 5,
        },
      ],
    },
    design: {
      run_class: ["killed-hypothesis", "countersign-control"].includes(caseRow.category)
        ? "serious_search"
        : caseRow.category === "smoke-kill-attempt"
          ? "smoke"
          : "fixture_integration_smoke",
      trial_count: ["killed-hypothesis", "countersign-control"].includes(caseRow.category) ? 10 : 0,
      parameter_search_surface: [
        "fixture route expectation",
        "planted failure toggle",
        "claim-boundary validation",
      ],
      objective_handling: "route_correctness",
      frozen_inputs: [
        "quant_researcher_e2e_manifest.json",
        `project_type:${projectType}`,
      ],
      sampled_inputs: [],
      mde: { value: 0.1, metric: "fixture_route_error_rate" },
      sample_floor: 10,
      power_note: "Ten deterministic fixture rows are the declared contract-routing floor, not empirical power.",
      tested_region: `The tested region covers the ${projectType} deterministic fixture case only.`,
    },
    evidence,
    expected: {
      route: caseRow.route,
      promotion_allowed: false,
      unrouted_fact_failure: caseRow.unrouted_fact_failure === true,
      receipt_state: caseRow.receipt_failure ? "invalid" : "valid",
      attempted_route: caseRow.attempted_route || null,
      blockers: caseRow.expected_blockers || [],
      close_allowed: caseRow.close_allowed !== false,
    },
  };

  if (caseRow.route === "killed_hypothesis" || caseRow.attempted_route === "killed_hypothesis") {
    const envelope = buildKillPromoteRouteEnvelope({
      charter_id: `${caseRow.id}:charter`,
      route: "killed_hypothesis",
      artifact_refs: evidence.artifact_refs,
    });
    fixture.countersign = buildFixtureCountersign(caseRow, envelope, evidence.researcher_context_id);
  }
  return fixture;
}

function selectedTypes(manifest, typeArg) {
  const available = Object.keys(manifest.project_types || {});
  if (typeArg === "all") return available;
  if (!available.includes(typeArg)) {
    throw new Error(`Unknown project type '${typeArg}'. Available: ${available.join(", ")}`);
  }
  return [typeArg];
}

function countByCategory(results, category) {
  return results.filter((result) => result.category === category).length;
}

function validateTypeMix(results, requiredMix) {
  const staleOrUnrouted = results.filter((result) => (
    result.category === "stale-process-config-log" || result.category === "unrouted-fact-failure"
  )).length;
  return [
    {
      ok: countByCategory(results, "golden") >= requiredMix.golden,
      code: "mix_golden",
    },
    {
      ok: countByCategory(results, "killed-hypothesis") >= requiredMix["killed-hypothesis"],
      code: "mix_killed_hypothesis",
    },
    {
      ok: countByCategory(results, "defer-blocked-data") >= requiredMix["defer-blocked-data"],
      code: "mix_defer_blocked_data",
    },
    {
      ok: countByCategory(results, "planted-quant-failure") >= requiredMix["planted-quant-failure"],
      code: "mix_planted_quant_failure",
    },
    {
      ok: staleOrUnrouted >= requiredMix["stale-or-unrouted"],
      code: "mix_stale_or_unrouted",
    },
    {
      ok: countByCategory(results, "smoke-kill-attempt") >= requiredMix["smoke-kill-attempt"],
      code: "mix_smoke_kill_attempt",
    },
  ].filter((assertion) => !assertion.ok).map((assertion) => assertion.code);
}

function validateResult(result) {
  const failures = [];
  if (result.lifecycle.join(" -> ") !== OUTER_LIFECYCLE.join(" -> ")) failures.push("lifecycle_order");
  if (result.inner_plan_ref.external_calls !== 0) failures.push("external_calls");
  if (result.inner_plan_ref.no_live_data !== true) failures.push("live_data_guard");
  if (result.route_decision.promotion_allowed !== false) failures.push("promotion_not_blocked");
  if (result.close_receipt.promotion_allowed !== false) failures.push("close_receipt_promotion_not_blocked");
  if (result.close_receipt.evidence_validity === "valid" && result.close_receipt.data_receipts_valid !== true) {
    failures.push("valid_receipt_claim_support_missing");
  }
  if (result.close_receipt.evidence_validity !== "valid" && result.close_receipt.data_receipts_valid !== false) {
    failures.push("invalid_receipt_claim_support_allowed");
  }
  if (result.category === "smoke-kill-attempt") {
    if (result.route_decision.attempted_route !== "killed_hypothesis") failures.push("smoke_kill_attempt_not_recorded");
    if (result.route_decision.route !== "run_experiment") failures.push("smoke_kill_not_routed_to_larger_run");
    if (!result.route_decision.blockers.includes("kill_claim_from_smoke_evidence")) failures.push("smoke_kill_issue_missing");
    if (result.route_decision.kill_claim_evidence?.satisfied !== false) failures.push("smoke_kill_evidence_false_green");
  }
  if (result.category === "countersign-control") {
    if (result.route_decision.route !== "blocked_claim") failures.push("countersign_control_not_blocked");
    if (result.route_decision.close_allowed !== false) failures.push("countersign_control_close_false_green");
    if (result.route_decision.kill_promote_countersign?.satisfied !== false) {
      failures.push("countersign_control_satisfied_false_green");
    }
  }
  return failures;
}

function runType(manifest, projectType, min) {
  const typeConfig = manifest.project_types[projectType];
  const fixtures = typeConfig.fixtures.map((caseRow) => expandFixture(projectType, typeConfig, caseRow));
  const results = fixtures.map((fixture) => runQuantResearchFixture(fixture));
  const scoreboard = buildE2EScoreboard(results, min);
  const mixFailures = validateTypeMix(results, manifest.required_mix_per_type);
  const lifecycleFailures = results.flatMap((result) => validateResult(result).map((code) => ({
    fixture_id: result.fixture_id,
    code,
  })));
  const fixtureFailures = results
    .filter((result) => !result.passed)
    .map((result) => ({
      fixture_id: result.fixture_id,
      failures: result.failures,
    }));
  const targetResidual = Math.max(0, Number(manifest.target_per_type || 20) - scoreboard.passed);
  const verified = scoreboard.verified
    && mixFailures.length === 0
    && lifecycleFailures.length === 0
    && fixtureFailures.length === 0;

  return {
    project_type: projectType,
    title: typeConfig.title,
    target_per_type: manifest.target_per_type,
    target_residual: targetResidual,
    scoreboard,
    mix: {
      golden: countByCategory(results, "golden"),
      "killed-hypothesis": countByCategory(results, "killed-hypothesis"),
      "defer-blocked-data": countByCategory(results, "defer-blocked-data"),
      "planted-quant-failure": countByCategory(results, "planted-quant-failure"),
      "stale-process-config-log": countByCategory(results, "stale-process-config-log"),
      "unrouted-fact-failure": countByCategory(results, "unrouted-fact-failure"),
      "smoke-kill-attempt": countByCategory(results, "smoke-kill-attempt"),
    },
    lifecycle: OUTER_LIFECYCLE,
    verified,
    failures: {
      mix: mixFailures,
      lifecycle: lifecycleFailures,
      fixtures: fixtureFailures,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const manifest = loadManifest();
  const min = Number.isFinite(args.min) ? args.min : manifest.minimum_per_type;
  if (!Number.isInteger(min) || min < 1) throw new Error("--min must be a positive integer");

  const typeNames = selectedTypes(manifest, args.type);
  const perType = {};
  for (const projectType of typeNames) {
    perType[projectType] = runType(manifest, projectType, min);
  }

  const output = {
    schema_version: 1,
    manifest: manifestPath,
    command_shape: manifest.command,
    selected_type: args.type,
    minimum_per_type: min,
    no_live_data: manifest.constraints.no_live_data === true,
    network_calls: false,
    external_service_calls: false,
    trading_or_betting: false,
    per_type: perType,
    verified: Object.values(perType).every((entry) => entry.verified),
  };

  console.log(JSON.stringify(output, null, 2));
  if (!output.verified) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
