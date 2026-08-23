#!/usr/bin/env node

// @planner:module = quant_researcher_runtime_contract_test
// @planner:proves = sc_1,sc_2,sc_3,sc_4

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import {
  appendExperiment,
  assertHypothesisSearchAllowed,
  buildE2EScoreboard,
  buildExperimentCharter,
  buildKillPromoteRouteEnvelope,
  buildResearchReport,
  createResearchMemory,
  evaluateKillPromoteCountersign,
  generateHypothesisCandidates,
  interpretExperimentEvidence,
  markHypothesisStatus,
  recordVerdict,
  routeResearchFacts,
  runQuantResearchFixture,
  validateResearchContract,
  verifyProcessIdentity,
} from "../scripts/quant_researcher_contracts.mjs";
import {
  EVIDENCE_VALIDITY_STATES,
  evaluateDataReceipt,
  evaluateDataReceipts,
  evidenceValiditySupportsResultClaim,
} from "../../iterative-planner/packs/quant/data_receipt.mjs";
import { buildEvidenceValidityVerdict } from "../../iterative-planner/scripts/lib/evidence_validity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const contractPath = resolve(__dirname, "..", "contracts", "research_contract.json");
const receiptRef = "receipt://runtime/panel-v1";
const receiptEvaluatedAt = "2026-06-29T00:00:10.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
// Test-only direct-user confirmation fixture. Production code must never construct user confirmation.
const TEST_KILL_PROMOTE_CONFIRMATION = "Yes, proceed";
const countersignNow = "2026-06-29T00:10:00.000Z";
const countersignRecordedAt = "2026-06-29T00:09:00.000Z";
const researcherContextId = "context:runtime-researcher";
const routeArtifactRefs = ["artifact://runtime/charter", "artifact://runtime/evidence-ledger"];

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${message}`);
    return;
  }
  failed += 1;
  console.log(`FAIL: ${message}`);
}

function assertThrows(action, expectedMessage, message) {
  try {
    action();
    assert(false, message);
  } catch (error) {
    assert(String(error.message).includes(expectedMessage), message);
  }
}

function goldenDataReceipt() {
  const identity = {
    running_process: "fixture:quant-runtime",
    config: "fixture:config-v1",
    log_stream: "fixture:log-v1",
    code_under_test: "fixture:contracts-v1",
  };
  return {
    schema_version: 1,
    receipt_ref: receiptRef,
    source: {
      ref: "fixture://runtime/panel",
      lineage: ["fixture://runtime/raw", "fixture://runtime/panel"],
    },
    generator_identity: { expected: { ...identity }, observed: { ...identity } },
    span: {
      start_at: "2026-06-28T00:00:00.000Z",
      end_at: "2026-06-29T00:00:03.000Z",
      as_of_at: "2026-06-29T00:00:04.000Z",
    },
    generated_at: "2026-06-29T00:00:05.000Z",
    freshness: { max_age_seconds: 60 },
    row_counts: { observed: 10, expected: { min: 10, max: 10 } },
    coverage_counts: { observed: 8, expected: { min: 8, max: 8 } },
    content_hash: { algorithm: "sha256", observed: hashA, expected: hashA },
    schema_hash: { algorithm: "sha256", observed: hashB, expected: hashB },
    missing_data_profile: { missing_rows: 0, missing_cells: 0, fields: [] },
    known_at_time: {
      cutoff_at: "2026-06-29T00:00:03.000Z",
      latest_observation_at: "2026-06-29T00:00:02.000Z",
      future_canary: { passed: true, checked_fields: ["post_cutoff_value"] },
    },
  };
}

function mutateReceipt(mutator) {
  const receipt = JSON.parse(JSON.stringify(goldenDataReceipt()));
  mutator(receipt);
  return receipt;
}

function receiptEvidence(receipt = goldenDataReceipt()) {
  return {
    data_receipts: [receipt],
    data_receipt_evaluated_at: receiptEvaluatedAt,
  };
}

function fixedClock() {
  return "2026-06-29T00:00:00.000Z";
}

function humanAuthorization(envelope, confirmationOverrides = {}, requestOverrides = {}) {
  return {
    action_class: "kill_promote",
    mode: "execute",
    target: envelope.target,
    payload_ref: envelope.payload_ref,
    confirmation: {
      text: TEST_KILL_PROMOTE_CONFIRMATION,
      actor: "human:runtime-operator",
      source: "direct_user_input",
      recorded_at: countersignRecordedAt,
      generated: false,
      delegated: false,
      action_class: "kill_promote",
      target: envelope.target,
      payload_ref: envelope.payload_ref,
      ...confirmationOverrides,
    },
    ...requestOverrides,
  };
}

function agentReview(envelope, overrides = {}) {
  return {
    review_type: "referee",
    source: "artifact_only",
    verdict: "passed",
    reviewer_actor: "agent:runtime-referee",
    reviewer_context_id: "context:runtime-referee",
    researcher_context_id: researcherContextId,
    route: envelope.route,
    envelope_sha256: envelope.envelope_sha256,
    artifact_refs_sha256: envelope.artifact_refs_sha256,
    ...overrides,
  };
}

function countersignOptions(envelope, overrides = {}) {
  return {
    evaluated_at: countersignNow,
    human_authorization: humanAuthorization(envelope),
    agent_reviews: [agentReview(envelope)],
    ...overrides,
  };
}

let memory = createResearchMemory();
memory = appendExperiment(memory, {
  id: "exp-1",
  hypothesis_id: "hyp-alpha-contract",
  mechanism: "contract fixture",
  expected_metric: "assertion pass rate",
  next_experiment: "fixture-smoke",
}, { clock: fixedClock });

assert(memory.experiments.length === 1, "research memory appends experiments");
assert(memory.hypothesis_queue[0].status === "testing", "experiment append seeds hypothesis queue");

memory = markHypothesisStatus(memory, "hyp-alpha-contract", "killed", {
  reason: "fixture falsified",
  evidence_ref: "artifact://fixture",
}, { clock: fixedClock });

assert(memory.hypothesis_queue[0].status === "killed", "hypothesis status can be marked killed");
assert(memory.killed_ideas.length === 1, "killed hypotheses are recorded");
assert(assertHypothesisSearchAllowed(memory, "hyp-alpha-contract").allowed === false, "killed hypotheses prevent re-search");

memory = recordVerdict(memory, "exp-1", {
  status: "blocked_claim",
  evidence_ref: "artifact://fixture",
  claim_boundary: "diagnostic_only",
}, { clock: fixedClock });

assert(memory.verdicts[0].status === "blocked_claim", "experiment verdicts are recorded with evidence");

const report = buildResearchReport({
  tested: { hypothesis_id: "hyp-alpha-contract", experiment_id: "exp-1" },
  verdict: { status: "killed", reason: "fixture falsified" },
  evidence: [{ ref: "artifact://fixture", summary: "negative fixture" }],
  claim_boundaries: ["diagnostic_only", "promotion_allowed=false"],
  remaining_blockers: ["no empirical data"],
  next_best_experiment: {
    id: "fixture-smoke-next",
    rationale: "Exercise the same contract against a richer fixture.",
  },
});

assert(report.json.next_best_experiment.id === "fixture-smoke-next", "report JSON always includes next best experiment");
assert(report.markdown.includes("## What Was Tested"), "report Markdown includes tested section");
assert(report.markdown.includes("## Next Best Experiment"), "report Markdown includes next move section");
assert(report.markdown.includes("promotion_allowed=false"), "report Markdown preserves claim boundaries");

const expectedIdentity = {
  running_process: "pid:123:sha256:abc",
  config: "config:sha256:def",
  log_stream: "log:research-run-1",
  code_under_test: "git:HEAD:contract-module",
};

assert(
  verifyProcessIdentity({ expected: expectedIdentity, observed: { ...expectedIdentity } }).ok === true,
  "process identity passes when process, config, log stream, and code match"
);

const mismatch = verifyProcessIdentity({
  expected: expectedIdentity,
  observed: { ...expectedIdentity, log_stream: "log:stale-run" },
});

assert(mismatch.ok === false, "process identity fails closed on mismatch");
assert(mismatch.mismatches.some((row) => row.field === "log_stream"), "process identity reports mismatched field");

const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const contractVerdict = validateResearchContract(contract);

assert(contractVerdict.ok === true, "research contract validates");
assert(contract.default_autonomy_level === 2, "default autonomy level is 2");
assert(contract.autonomy_levels.length === 4, "autonomy levels 1 through 4 are defined");
assert(contract.resource_budget_limits.live_trading_allowed === false, "resource budget blocks live trading");
assert(contract.promotion_governance.promotion_allowed_default === false, "promotion is false by default");

assert(
  JSON.stringify(EVIDENCE_VALIDITY_STATES) === JSON.stringify([
    "valid",
    "invalid",
    "environment_invalid",
    "degraded_coverage",
  ]),
  "shared evidence validity vocabulary is exact and ordered"
);
for (const state of EVIDENCE_VALIDITY_STATES) {
  assert(
    evidenceValiditySupportsResultClaim(state) === (state === "valid"),
    `only valid evidence supports result claims: ${state}`
  );
}
const forgedValidity = buildEvidenceValidityVerdict({
  state: "invalid",
  pass: true,
  claim_support_allowed: true,
  blockers: [{ code: "planted_invalid" }],
});
assert(
  forgedValidity.pass === false && forgedValidity.claim_support_allowed === false,
  "caller details cannot override fail-closed validity semantics"
);

const goldenReceiptVerdict = evaluateDataReceipt(goldenDataReceipt(), {
  expected_ref: receiptRef,
  evaluated_at: receiptEvaluatedAt,
});
assert(goldenReceiptVerdict.pass === true, "golden data receipt passes every intrinsic validity check");
assert(goldenReceiptVerdict.state === "valid", "golden data receipt returns valid evidence state");
assert(goldenReceiptVerdict.claim_support_allowed === true, "golden data receipt can support a result claim");

const receiptBlockerCases = [
  ["data_receipt_missing", null, { expected_ref: receiptRef, evaluated_at: receiptEvaluatedAt }],
  ["data_receipt_empty", {}, { expected_ref: receiptRef, evaluated_at: receiptEvaluatedAt }],
  ["data_receipt_schema_version_unsupported", mutateReceipt((row) => { row.schema_version = 2; })],
  ["data_receipt_ref_missing", mutateReceipt((row) => { delete row.receipt_ref; })],
  ["data_receipt_ref_mismatch", mutateReceipt((row) => { row.receipt_ref = "receipt://runtime/wrong"; })],
  ["data_receipt_source_lineage_incomplete", mutateReceipt((row) => { row.source.lineage = []; })],
  ["data_receipt_generator_identity_incomplete", mutateReceipt((row) => { delete row.generator_identity.observed.config; })],
  ["data_receipt_generator_identity_mismatch", mutateReceipt((row) => { row.generator_identity.observed.config = "fixture:stale"; })],
  ["data_receipt_span_invalid", mutateReceipt((row) => { row.span.end_at = "2026-06-27T00:00:00.000Z"; })],
  ["data_receipt_generated_at_invalid", mutateReceipt((row) => { row.generated_at = "2026-06-29T00:00:00.000Z"; })],
  ["data_receipt_evaluation_time_missing", goldenDataReceipt(), { expected_ref: receiptRef }],
  ["data_receipt_freshness_window_invalid", mutateReceipt((row) => { row.freshness.max_age_seconds = -1; })],
  ["data_receipt_generated_in_future", mutateReceipt((row) => { row.generated_at = "2026-06-29T00:00:20.000Z"; })],
  ["data_receipt_stale", mutateReceipt((row) => { row.freshness.max_age_seconds = 1; })],
  ["data_receipt_row_count_invalid", mutateReceipt((row) => { row.row_counts.observed = -1; })],
  ["data_receipt_row_count_mismatch", mutateReceipt((row) => { row.row_counts.observed = 9; })],
  ["data_receipt_coverage_count_invalid", mutateReceipt((row) => { row.coverage_counts.expected.max = -1; })],
  ["data_receipt_coverage_count_mismatch", mutateReceipt((row) => { row.coverage_counts.observed = 7; })],
  ["data_receipt_content_hash_invalid", mutateReceipt((row) => { row.content_hash.observed = "sha256:bad"; })],
  ["data_receipt_content_hash_drift", mutateReceipt((row) => { row.content_hash.observed = hashB; })],
  ["data_receipt_schema_hash_invalid", mutateReceipt((row) => { row.schema_hash.algorithm = "md5"; })],
  ["data_receipt_schema_hash_drift", mutateReceipt((row) => { row.schema_hash.observed = hashA; })],
  ["data_receipt_missing_data_profile_invalid", mutateReceipt((row) => { row.missing_data_profile.missing_rows = -1; })],
  ["data_receipt_known_at_time_invalid", mutateReceipt((row) => { row.known_at_time.future_canary.checked_fields = []; })],
  ["data_receipt_known_at_time_violation", mutateReceipt((row) => { row.known_at_time.latest_observation_at = "2026-06-29T00:00:04.000Z"; })],
  ["data_receipt_future_canary_failed", mutateReceipt((row) => { row.known_at_time.future_canary.passed = false; })],
];

for (const [expectedCode, receipt, options = { expected_ref: receiptRef, evaluated_at: receiptEvaluatedAt }] of receiptBlockerCases) {
  const verdict = evaluateDataReceipt(receipt, options);
  assert(verdict.state === "invalid", `${expectedCode} yields invalid evidence state`);
  assert(verdict.claim_support_allowed === false, `${expectedCode} cannot support result claims`);
  assert(verdict.blockers.some((row) => row.code === expectedCode), `${expectedCode} is stable and observable`);
}

const aggregateBlockerCases = [
  ["data_receipt_refs_missing", { required_refs: [], receipts: [], evaluated_at: receiptEvaluatedAt }],
  ["data_receipt_required_ref_duplicate", { required_refs: [receiptRef, receiptRef], receipts: [goldenDataReceipt()], evaluated_at: receiptEvaluatedAt }],
  ["data_receipt_duplicate", { required_refs: [receiptRef], receipts: [goldenDataReceipt(), goldenDataReceipt()], evaluated_at: receiptEvaluatedAt }],
  ["data_receipt_unexpected", {
    required_refs: [receiptRef],
    receipts: [
      goldenDataReceipt(),
      mutateReceipt((row) => { row.receipt_ref = "receipt://runtime/unexpected"; }),
    ],
    evaluated_at: receiptEvaluatedAt,
  }],
];
for (const [expectedCode, input] of aggregateBlockerCases) {
  const verdict = evaluateDataReceipts(input);
  assert(verdict.state === "invalid", `${expectedCode} fails the aggregate receipt set closed`);
  assert(verdict.blockers.some((row) => row.code === expectedCode), `${expectedCode} is stable at aggregate scope`);
}

const survey = {
  id: "survey-runtime",
  project_type: "ml-ranking-backtest",
  target: "out-of-sample ranking lift",
  data_lineage: "fixture://runtime known-at-time panel",
  data_receipt_refs: [receiptRef],
  known_at_time: "features available before prediction timestamp",
  temporal_split: "walk-forward cutoff",
  controls: ["baseline Elo"],
  claim_boundary: "diagnostic_only",
  signals: [
    {
      hypothesis_id: "hyp-runtime-signal",
      statement: "Feature drift might explain ranking instability.",
      mechanism: "candidate signal: feature drift",
      expected_metric: "route correctness",
      falsification_threshold: "fails if leakage or baseline controls are missing",
      data_requirements: ["known-at-time feature registry"],
      next_experiment: "runtime fixture smoke",
      priority: 5,
    },
  ],
};

const scientificDesign = {
  run_class: "serious_search",
  trial_count: 120,
  parameter_search_surface: ["route expectation"],
  frozen_inputs: ["fixture manifest"],
  mde: { value: 0.05, metric: "route_error_rate" },
  sample_floor: 100,
  power_note: "The deterministic contract matrix uses 100 independent fixture cases as its declared floor.",
  tested_region: "The tested region covers the deterministic runtime contract matrix only.",
};

const generated = generateHypothesisCandidates(survey, memory);
assert(generated.candidates[0].id === "hyp-runtime-signal", "hypothesis generator ranks allowed candidates");

const killedMemory = markHypothesisStatus(
  createResearchMemory({ hypothesis_queue: [{ id: "hyp-runtime-signal", status: "queued" }] }),
  "hyp-runtime-signal",
  "killed",
  { reason: "prior falsification", evidence_ref: "fixture://prior" },
  { clock: fixedClock }
);
const deduped = generateHypothesisCandidates(survey, killedMemory);
assert(deduped.killed_dedup.length === 1, "hypothesis generator dedups killed ideas");

assertThrows(
  () => buildExperimentCharter({
    survey: { ...survey, data_receipt_refs: [] },
    hypothesis: generated.candidates[0],
    design: {},
  }),
  "data_receipt_refs",
  "empirical experiment charter fails closed without data receipt refs"
);

assertThrows(
  () => buildExperimentCharter({
    survey,
    hypothesis: generated.candidates[0],
    design: { ...scientificDesign, mde: null },
  }),
  "design.mde",
  "empirical experiment charter fails closed without minimum detectable effect"
);

for (const [field, expectedMessage] of [
  ["sample_floor", "design.sample_floor"],
  ["power_note", "design.power_note"],
  ["tested_region", "design.tested_region"],
]) {
  assertThrows(
    () => buildExperimentCharter({
      survey,
      hypothesis: generated.candidates[0],
      design: { ...scientificDesign, [field]: null },
    }),
    expectedMessage,
    `empirical experiment charter fails closed without ${field}`
  );
}

const charter = buildExperimentCharter({
  survey,
  hypothesis: generated.candidates[0],
  design: scientificDesign,
});

assert(charter.promotion_allowed_default === false, "experiment charter defaults promotion to false");
assert(charter.temporal_split === "walk-forward cutoff", "experiment charter preserves temporal split");
assert(charter.mde?.value === 0.05, "experiment charter preserves minimum detectable effect");
assert(charter.sample_floor === 100, "experiment charter preserves sample floor");
assert(charter.tested_region === scientificDesign.tested_region, "experiment charter preserves one-sentence tested region");

const interpreted = interpretExperimentEvidence(charter, {
  ...receiptEvidence(),
  validation: {
    leakage: false,
    controls: true,
    temporal_split: true,
    data_lineage: true,
  },
  material_facts: [{ id: "fact-leakage", summary: "future leakage", route: "blocked_claim" }],
  next_best_experiment: { id: "fix-leakage", rationale: "remove future feature" },
});

assert(interpreted.promotion_allowed === false, "interpreter blocks promotion on leakage failure");
assert(interpreted.issues.some((issue) => issue.code === "leakage_detected"), "interpreter records leakage issue");

const unrouted = interpretExperimentEvidence(charter, {
  ...receiptEvidence(),
  validation: { leakage: true, controls: true, temporal_split: true, data_lineage: true },
  material_facts: [{ id: "fact-unrouted", summary: "unrouted fact" }],
  next_best_experiment: { id: "route-fact", rationale: "route fact" },
});
const routed = routeResearchFacts(unrouted);

assert(routed.close_allowed === false, "router blocks close when material facts are unrouted");
assert(routed.unrouted_facts.length === 1, "router reports unrouted facts");

const staleReceipt = mutateReceipt((row) => { row.freshness.max_age_seconds = 1; });
const invalidReceiptInterpretation = interpretExperimentEvidence(charter, {
  ...receiptEvidence(staleReceipt),
  validation: {
    leakage: true,
    controls: true,
    temporal_split: true,
    data_lineage: true,
    promotion_candidate: true,
    promotion_proof: {
      oos: true,
      leakage: true,
      controls: true,
      calibration: true,
      sample_floor: true,
    },
  },
  material_facts: [{ id: "fact-spoof", summary: "caller booleans claim green", route: "report_only" }],
  next_best_experiment: { id: "repair-receipt", rationale: "refresh deterministic receipt" },
});
assert(invalidReceiptInterpretation.promotion_allowed === false, "invalid data receipt overrides caller-supplied promotion booleans");
assert(invalidReceiptInterpretation.data_receipt_validity.state === "invalid", "interpreter exposes invalid receipt state");
assert(routeResearchFacts(invalidReceiptInterpretation).route === "defer", "invalid data receipt routes to defer");

const earnedKillInterpretation = interpretExperimentEvidence(charter, {
  ...receiptEvidence(),
  validation: {
    leakage: true,
    controls: true,
    temporal_split: true,
    data_lineage: true,
    sample_floor_met: true,
  },
  observed_sample_size: 120,
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  material_facts: [{ id: "fact-earned-kill", summary: "The bounded hypothesis missed its threshold.", route: "killed_hypothesis" }],
  next_best_experiment: { id: "reverse-or-expand", rationale: "Test a reversal condition or a larger registered region." },
});
const earnedKillEnvelope = buildKillPromoteRouteEnvelope({
  charter_id: charter.id,
  route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
});
const reorderedKillEnvelope = buildKillPromoteRouteEnvelope({
  charter_id: charter.id,
  route: "killed_hypothesis",
  artifact_refs: [...routeArtifactRefs].reverse(),
});
assert(earnedKillEnvelope.envelope_sha256 === reorderedKillEnvelope.envelope_sha256, "route envelope is stable under artifact-ref ordering");
assert(earnedKillEnvelope.payload_ref === reorderedKillEnvelope.payload_ref, "route payload ref is stable under artifact-ref ordering");

const refereeCountersign = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope),
});
assert(refereeCountersign.satisfied === true, "direct-user human key plus artifact-only referee passes");
assert(refereeCountersign.human_receipt?.action_class === "kill_promote", "passing countersign retains the hash-only human receipt");
assert(!JSON.stringify(refereeCountersign).includes(TEST_KILL_PROMOTE_CONFIRMATION), "countersign receipt never echoes human confirmation text");

const skepticCountersign = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope, {
    agent_reviews: [agentReview(earnedKillEnvelope, {
      review_type: "skeptic",
      verdict: "countersigned",
      reviewer_actor: "agent:runtime-skeptic",
      reviewer_context_id: "context:runtime-skeptic",
    })],
  }),
});
assert(skepticCountersign.satisfied === true, "direct-user human key plus artifact-only skeptic passes");

const twoAgentOnly = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  evaluated_at: countersignNow,
  agent_reviews: [
    agentReview(earnedKillEnvelope),
    agentReview(earnedKillEnvelope, {
      review_type: "skeptic",
      verdict: "countersigned",
      reviewer_actor: "agent:runtime-skeptic",
      reviewer_context_id: "context:runtime-skeptic",
    }),
  ],
});
assert(twoAgentOnly.satisfied === false && twoAgentOnly.blockers.includes("human_confirmation_missing"), "two-agent-only countersign cannot replace the human key");

for (const [label, confirmationOverrides, blocker] of [
  ["generated", { generated: true }, "confirmation_generated"],
  ["inferred", { source: "inferred" }, "confirmation_source_invalid"],
  ["stale", { recorded_at: "2026-06-28T23:00:00.000Z" }, "confirmation_stale"],
  ["future", { recorded_at: "2026-06-29T00:12:00.000Z" }, "confirmation_from_future"],
]) {
  const verdict = evaluateKillPromoteCountersign({
    charter_id: charter.id,
    attempted_route: "killed_hypothesis",
    artifact_refs: routeArtifactRefs,
    researcher_context_id: researcherContextId,
    ...countersignOptions(earnedKillEnvelope, {
      human_authorization: humanAuthorization(earnedKillEnvelope, confirmationOverrides),
    }),
  });
  assert(verdict.satisfied === false && verdict.blockers.includes(blocker), `${label} human confirmation rejects with shared blocker`);
}

const wrongEnvelopeCountersign = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope, {
    human_authorization: humanAuthorization(earnedKillEnvelope, {}, { target: "research-route:wrong:killed_hypothesis" }),
  }),
});
assert(wrongEnvelopeCountersign.satisfied === false && wrongEnvelopeCountersign.blockers.includes("human_route_envelope_mismatch"), "wrong human route envelope rejects");

const reviewMismatch = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope, {
    agent_reviews: [agentReview(earnedKillEnvelope, { envelope_sha256: "0".repeat(64) })],
  }),
});
assert(reviewMismatch.satisfied === false && reviewMismatch.blockers.includes("referee_mismatch"), "referee envelope mismatch rejects");

const skepticContest = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope, {
    agent_reviews: [agentReview(earnedKillEnvelope, {
      review_type: "skeptic",
      verdict: "contested",
      reviewer_actor: "agent:runtime-skeptic",
      reviewer_context_id: "context:runtime-skeptic",
    })],
  }),
});
assert(skepticContest.satisfied === false && skepticContest.blockers.includes("skeptic_contested"), "skeptic contest rejects");

const passingPlusContested = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope, {
    agent_reviews: [
      agentReview(earnedKillEnvelope),
      agentReview(earnedKillEnvelope, {
        review_type: "skeptic",
        verdict: "contested",
        reviewer_actor: "agent:runtime-skeptic",
        reviewer_context_id: "context:runtime-skeptic",
      }),
    ],
  }),
});
assert(passingPlusContested.satisfied === false && passingPlusContested.blockers.includes("skeptic_contested"), "adverse supplied review overrides a passing review");

const sharedContextReview = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope, {
    agent_reviews: [agentReview(earnedKillEnvelope, { reviewer_context_id: researcherContextId })],
  }),
});
assert(sharedContextReview.satisfied === false && sharedContextReview.blockers.includes("agent_review_not_independent"), "shared researcher/reviewer context rejects");

const sharedActorReview = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope, {
    agent_reviews: [agentReview(earnedKillEnvelope, { reviewer_actor: "human:runtime-operator" })],
  }),
});
assert(sharedActorReview.satisfied === false && sharedActorReview.blockers.includes("agent_review_not_independent"), "shared human/reviewer actor rejects");

const narrativeReview = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "killed_hypothesis",
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  ...countersignOptions(earnedKillEnvelope, {
    agent_reviews: [agentReview(earnedKillEnvelope, { source: "researcher_narrative" })],
  }),
});
assert(narrativeReview.satisfied === false && narrativeReview.blockers.includes("agent_review_not_artifact_only"), "narrative-fed review rejects");

const ordinaryCountersign = evaluateKillPromoteCountersign({
  charter_id: charter.id,
  attempted_route: "report_only",
  artifact_refs: [],
  researcher_context_id: researcherContextId,
});
assert(ordinaryCountersign.required === false && ordinaryCountersign.satisfied === true, "ordinary route is inert to countersign contract");

const earnedKillRoute = routeResearchFacts(earnedKillInterpretation, {
  preferred_route: "killed_hypothesis",
  countersign: countersignOptions(earnedKillEnvelope),
});
assert(earnedKillRoute.route === "killed_hypothesis", "serious-class evidence can earn a killed_hypothesis route");
assert(earnedKillRoute.kill_claim_evidence?.satisfied === true, "earned kill exposes satisfied kill-claim evidence");
assert(earnedKillRoute.kill_promote_countersign?.satisfied === true, "earned kill exposes satisfied two-key countersign evidence");

const agentOnlyKillRoute = routeResearchFacts(earnedKillInterpretation, {
  preferred_route: "killed_hypothesis",
  countersign: {
    evaluated_at: countersignNow,
    agent_reviews: [agentReview(earnedKillEnvelope)],
  },
});
assert(agentOnlyKillRoute.route === "blocked_claim", "agent-only earned kill route fail-closes");
assert(agentOnlyKillRoute.close_allowed === false, "agent-only earned kill cannot close");
assert(agentOnlyKillRoute.blockers.includes("human_confirmation_missing"), "agent-only earned kill exposes missing-human blocker");

const smokeKillCharter = { ...charter, run_class: "smoke" };
const smokeKillInterpretation = interpretExperimentEvidence(smokeKillCharter, {
  ...receiptEvidence(),
  validation: {
    leakage: true,
    controls: true,
    temporal_split: true,
    data_lineage: true,
    sample_floor_met: true,
  },
  observed_sample_size: 120,
  material_facts: [{ id: "fact-smoke-kill", summary: "Smoke evidence missed its threshold.", route: "killed_hypothesis" }],
  next_best_experiment: { id: "larger-run", rationale: "Pay for a serious registered run." },
});
const smokeKillRoute = routeResearchFacts(smokeKillInterpretation, { preferred_route: "killed_hypothesis" });
assert(smokeKillRoute.route === "run_experiment", "smoke kill attempt routes only to larger-run work");
assert(smokeKillRoute.attempted_route === "killed_hypothesis", "smoke kill receipt preserves the attempted negative route");
assert(smokeKillRoute.blockers.includes("kill_claim_from_smoke_evidence"), "smoke kill attempt emits stable umbrella blocker");
assert(smokeKillRoute.kill_claim_evidence?.detail_blockers?.includes("kill_claim_run_class_under_evidenced"), "smoke kill names under-evidenced run class");

const implicitBaselineKillRoute = routeResearchFacts({
  ...earnedKillInterpretation,
  issues: [{ code: "baseline_not_beaten", severity: "planted_failure" }],
}, { countersign: countersignOptions(earnedKillEnvelope) });
assert(implicitBaselineKillRoute.route === "killed_hypothesis", "serious baseline failure can earn an implicit killed_hypothesis route");
assert(implicitBaselineKillRoute.attempted_route === "killed_hypothesis", "implicit baseline kill receipt preserves the evaluated attempted route");

const missingBoundaryRoute = routeResearchFacts({
  ...earnedKillInterpretation,
  kill_claim_evidence: { ...earnedKillInterpretation.kill_claim_evidence, tested_region: "" },
}, { preferred_route: "no_go" });
assert(missingBoundaryRoute.route === "run_experiment", "otherwise under-evidenced no_go routes to larger-run work");
assert(missingBoundaryRoute.blockers.includes("kill_claim_from_smoke_evidence"), "missing tested region uses the stable umbrella blocker");

const promotionInterpretation = interpretExperimentEvidence(charter, {
  ...receiptEvidence(),
  validation: {
    leakage: true,
    controls: true,
    temporal_split: true,
    data_lineage: true,
    promotion_candidate: true,
    promotion_proof: {
      oos: true,
      leakage: true,
      controls: true,
      calibration: true,
      sample_floor: true,
    },
  },
  artifact_refs: routeArtifactRefs,
  researcher_context_id: researcherContextId,
  material_facts: [{ id: "fact-promotion", summary: "Promotion fixture passed existing proof.", route: "promotion_candidate" }],
  next_best_experiment: { id: "human-review", rationale: "Require permanent human authority." },
});
const promotionEnvelope = buildKillPromoteRouteEnvelope({
  charter_id: charter.id,
  route: "promotion_candidate",
  artifact_refs: routeArtifactRefs,
});
const promotedRoute = routeResearchFacts(promotionInterpretation, {
  preferred_route: "promotion_candidate",
  countersign: countersignOptions(promotionEnvelope),
});
assert(promotedRoute.route === "promotion_candidate" && promotedRoute.promotion_allowed === true, "promotion requires existing entitlement plus both countersign keys");

const agentOnlyPromotion = routeResearchFacts(promotionInterpretation, {
  preferred_route: "promotion_candidate",
  countersign: { evaluated_at: countersignNow, agent_reviews: [agentReview(promotionEnvelope)] },
});
assert(agentOnlyPromotion.route === "blocked_claim" && agentOnlyPromotion.close_allowed === false, "agent-only promotion fail-closes and cannot close");

const unearnedPromotion = routeResearchFacts({ ...promotionInterpretation, promotion_allowed: false }, {
  preferred_route: "promotion_candidate",
  countersign: countersignOptions(promotionEnvelope),
});
assert(unearnedPromotion.route === "blocked_claim" && unearnedPromotion.blockers.includes("promotion_not_allowed"), "two keys cannot manufacture promotion entitlement");

const fixtureResult = runQuantResearchFixture({
  id: "fixture-runtime-golden",
  project_type: "ml-ranking-backtest",
  title: "Runtime golden diagnostic fixture",
  category: "golden",
  planted_failure: false,
  survey,
  design: {
    run_class: "fixture_integration_smoke",
    trial_count: 0,
    parameter_search_surface: ["route expectation"],
    frozen_inputs: ["fixture manifest"],
    mde: { value: 0.05, metric: "route_error_rate" },
    sample_floor: 10,
    power_note: "Ten deterministic fixture cases are sufficient for route-wiring proof only.",
    tested_region: "The tested region covers this deterministic golden fixture only.",
  },
  evidence: {
    ...receiptEvidence(),
    validation: { leakage: true, controls: true, temporal_split: true, data_lineage: true },
    material_facts: [{ id: "fact-ok", summary: "diagnostic fact", route: "report_only" }],
    next_best_experiment: { id: "next-runtime", rationale: "add richer fixture" },
  },
  expected: {
    route: "report_only",
    promotion_allowed: false,
    receipt_state: "valid",
  },
});

assert(fixtureResult.passed === true, "full fixture lifecycle passes for a golden diagnostic path");
assert(fixtureResult.close_receipt.evidence_validity === "valid", "close receipt exposes evidence validity state");
assert(fixtureResult.close_receipt.data_receipts_valid === true, "close receipt records valid data receipts");
assert(fixtureResult.lifecycle.join(" -> ") === "SURVEY -> HYPOTHESIZE -> DESIGN -> planner-loop -> INTERPRET -> ROUTE -> REPORT -> CLOSE", "fixture lifecycle is complete and ordered");
assert(buildE2EScoreboard([fixtureResult], 1).verified === true, "scoreboard verifies when minimum passed count is met");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\nAll ${passed} quant-researcher runtime contract assertions passed.`);
