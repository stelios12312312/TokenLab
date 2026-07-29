// kill_claim_evidence.mjs — pure symmetric evidence floor for negative claims.

export const KILL_CLAIM_EVIDENCE_VERSION = 1;
export const KILL_CLAIM_FROM_SMOKE_EVIDENCE = "kill_claim_from_smoke_evidence";
export const KILL_CLAIM_ROUTES = Object.freeze(["killed_hypothesis", "no_go"]);
export const SERIOUS_KILL_RUN_CLASSES = Object.freeze(["serious_search", "promotion_candidate"]);

const KILL_ROUTE_SET = new Set(KILL_CLAIM_ROUTES);
const SERIOUS_CLASS_SET = new Set(SERIOUS_KILL_RUN_CLASSES);

function normalizeEnum(value) {
  return String(value || "").trim().toLowerCase();
}

function finitePositive(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedMde(value) {
  const direct = finitePositive(value);
  if (direct !== null) return { value: direct, metric: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = finitePositive(value.value ?? value.mde ?? value.minimum_detectable_effect);
  if (amount === null) return null;
  return {
    ...value,
    value: amount,
    metric: typeof value.metric === "string" && value.metric.trim() ? value.metric.trim() : null,
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function oneSentence(value) {
  if (!nonEmptyString(value)) return false;
  const text = value.trim();
  if (/\r|\n/.test(text)) return false;
  return text.split(/(?<=[.!?])\s+/).filter(Boolean).length === 1;
}

export function isKillClaimRoute(value) {
  return KILL_ROUTE_SET.has(normalizeEnum(value));
}

export function evaluateKillClaimEvidence(input = {}) {
  const attemptedRoute = normalizeEnum(input.attempted_route ?? input.route ?? input.verdict);
  const runClass = normalizeEnum(input.run_class);
  if (!isKillClaimRoute(attemptedRoute)) {
    return {
      version: KILL_CLAIM_EVIDENCE_VERSION,
      required: false,
      satisfied: true,
      attempted_route: attemptedRoute || null,
      run_class: runClass || null,
      blockers: [],
      detail_blockers: [],
      evidence: null,
    };
  }

  const detailBlockers = [];
  const mde = normalizedMde(input.mde ?? input.minimum_detectable_effect);
  const sampleFloor = finitePositive(input.sample_floor);
  const observedSampleSize = finitePositive(input.observed_sample_size ?? input.sample_size);
  const observedMeetsFloor = (
    sampleFloor !== null &&
    observedSampleSize !== null &&
    observedSampleSize >= sampleFloor
  );
  const sampleFloorMet = input.sample_floor_met === true && observedMeetsFloor;

  if (!SERIOUS_CLASS_SET.has(runClass)) detailBlockers.push("kill_claim_run_class_under_evidenced");
  if (!mde) detailBlockers.push("kill_claim_mde_missing_or_invalid");
  if (sampleFloor === null) detailBlockers.push("kill_claim_sample_floor_missing_or_invalid");
  if (sampleFloor !== null && !sampleFloorMet) detailBlockers.push("kill_claim_sample_floor_not_met");
  if (!nonEmptyString(input.power_note)) detailBlockers.push("kill_claim_power_note_missing");
  if (!oneSentence(input.tested_region)) detailBlockers.push("kill_claim_tested_region_missing_or_not_one_sentence");
  if (!nonEmptyString(input.claim_boundary)) detailBlockers.push("kill_claim_boundary_missing");
  if (input.claim_support_allowed === false || input.evidence_valid === false) {
    detailBlockers.push("kill_claim_input_evidence_invalid");
  }

  const satisfied = detailBlockers.length === 0;
  return {
    version: KILL_CLAIM_EVIDENCE_VERSION,
    required: true,
    satisfied,
    attempted_route: attemptedRoute,
    run_class: runClass || null,
    blockers: satisfied ? [] : [KILL_CLAIM_FROM_SMOKE_EVIDENCE, ...detailBlockers],
    detail_blockers: detailBlockers,
    evidence: {
      mde,
      sample_floor: sampleFloor,
      observed_sample_size: observedSampleSize,
      sample_floor_met: sampleFloorMet,
      power_note: nonEmptyString(input.power_note) ? input.power_note.trim() : null,
      tested_region: oneSentence(input.tested_region) ? input.tested_region.trim() : null,
      claim_boundary: nonEmptyString(input.claim_boundary) ? input.claim_boundary.trim() : null,
      claim_support_allowed: input.claim_support_allowed !== false && input.evidence_valid !== false,
    },
  };
}
