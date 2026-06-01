// @planner:story_id US-MED-001
// @planner:tested_by tests/payment.test.mjs
export function normalizeAmount(value) {
  return Number(value).toFixed(2);
}
