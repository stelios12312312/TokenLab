// measured_gate.mjs - small semantic gate evaluator for machine-measured proof.

const THRESHOLD_ALIASES = new Map([
  ["=", "=="],
  ["===", "=="],
  ["eq", "=="],
  ["equals", "=="],
  ["lte", "<="],
  ["max", "<="],
  ["gte", ">="],
  ["min", ">="],
  ["lt", "<"],
  ["gt", ">"],
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(asObject(object), key);
}

function normalizeId(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return !Number.isFinite(value);
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

function comparable(value) {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
  }
  return value;
}

export function normalizeThreshold(raw) {
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "string") {
    return { op: "==", value: raw };
  }

  const threshold = asObject(raw);
  if (Object.keys(threshold).length === 0) return null;

  if (hasOwn(threshold, "op") || hasOwn(threshold, "operator")) {
    const rawOp = String(threshold.op ?? threshold.operator ?? "").trim().toLowerCase();
    const op = THRESHOLD_ALIASES.get(rawOp) || rawOp;
    const value = hasOwn(threshold, "value") ? threshold.value : threshold.expected;
    return { op, value };
  }

  if (hasOwn(threshold, "max")) return { op: "<=", value: threshold.max };
  if (hasOwn(threshold, "min")) return { op: ">=", value: threshold.min };
  if (hasOwn(threshold, "equals")) return { op: "==", value: threshold.equals };
  if (hasOwn(threshold, "expected")) return { op: "==", value: threshold.expected };
  return null;
}

export function isMeasuredGateObject(value) {
  const gate = asObject(value);
  return Object.keys(gate).length > 0 &&
    (hasOwn(gate, "measured") || hasOwn(gate, "threshold") || Array.isArray(gate.criteria) || Array.isArray(gate.per_criterion));
}

function compareMeasuredValue(measured, threshold) {
  if (!threshold) return { satisfied: false, issue: "missing_threshold" };
  if (isMissing(threshold.value)) return { satisfied: false, issue: "missing_threshold_value" };
  if (isMissing(measured)) return { satisfied: false, issue: "missing_measured" };

  const left = comparable(measured);
  const right = comparable(threshold.value);
  switch (threshold.op) {
    case "<":
      return { satisfied: left < right, issue: left < right ? null : `measured_${left}_not_lt_${right}` };
    case "<=":
      return { satisfied: left <= right, issue: left <= right ? null : `measured_${left}_not_lte_${right}` };
    case ">":
      return { satisfied: left > right, issue: left > right ? null : `measured_${left}_not_gt_${right}` };
    case ">=":
      return { satisfied: left >= right, issue: left >= right ? null : `measured_${left}_not_gte_${right}` };
    case "!=":
      return { satisfied: left !== right, issue: left !== right ? null : `measured_${left}_equals_forbidden_${right}` };
    case "==":
      return { satisfied: left === right, issue: left === right ? null : `measured_${left}_not_eq_${right}` };
    default:
      return { satisfied: false, issue: `unsupported_threshold_op:${threshold.op || "missing"}` };
  }
}

function normalizeMeasuredValue(value) {
  return value === undefined ? null : value;
}

function evaluateCriterion(rawCriterion, index) {
  const criterion = asObject(rawCriterion);
  const id = normalizeId(criterion.id || criterion.name, `criterion_${index + 1}`);
  const measured = hasOwn(criterion, "measured") ? normalizeMeasuredValue(criterion.measured) : null;
  const threshold = normalizeThreshold(criterion.threshold);
  const comparison = compareMeasuredValue(measured, threshold);
  return {
    id,
    measured,
    threshold,
    satisfied: comparison.satisfied,
    ...(comparison.issue ? { issue: comparison.issue } : {}),
  };
}

export function evaluateMeasuredGate(rawGate, { defaultId = "semantic_gate" } = {}) {
  const gate = asObject(rawGate);
  const id = normalizeId(gate.id || gate.name || gate.gate_id, defaultId);
  const measured = hasOwn(gate, "measured") ? normalizeMeasuredValue(gate.measured) : null;
  const threshold = normalizeThreshold(gate.threshold);
  const main = compareMeasuredValue(measured, threshold);
  const rawCriteria = Array.isArray(gate.criteria)
    ? gate.criteria
    : Array.isArray(gate.per_criterion)
      ? gate.per_criterion
      : [];
  const perCriterion = rawCriteria.map(evaluateCriterion);
  const criteriaPassed = perCriterion.filter((criterion) => criterion.satisfied).length;
  const issues = [
    ...(main.issue ? [main.issue] : []),
    ...perCriterion
      .filter((criterion) => !criterion.satisfied)
      .map((criterion) => `criterion_failed:${criterion.id}:${criterion.issue || "unsatisfied"}`),
  ];

  return {
    id,
    measured,
    threshold,
    satisfied: main.satisfied && perCriterion.every((criterion) => criterion.satisfied),
    per_criterion: perCriterion,
    counts: {
      criteria_total: perCriterion.length,
      criteria_passed: criteriaPassed,
    },
    issues: [...new Set(issues)],
  };
}

export function dedupeMeasuredGates(gates) {
  const deduped = new Map();
  for (const gate of Array.isArray(gates) ? gates : []) {
    if (!isMeasuredGateObject(gate)) continue;
    const id = normalizeId(gate.id || gate.name || gate.gate_id, `semantic_gate_${deduped.size + 1}`);
    if (!deduped.has(id)) deduped.set(id, { ...gate, id });
  }
  return [...deduped.values()];
}
