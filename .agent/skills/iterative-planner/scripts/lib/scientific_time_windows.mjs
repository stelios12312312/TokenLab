// scientific_time_windows.mjs — semantic-role chronology, overlap, and preregistration parity.
// @planner:module = scientific_time_windows
// @planner:capability = semantic_role_temporal_independence_validation
// @planner:story = US-003
// @planner:proves = crit:sc_1, crit:sc_2

import { asObject, issue } from "./scientific_contract.mjs";

function day(value) {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

function normalizeWindows(rows, source, issues) {
  const byRole = new Map();
  for (const [index, rowInput] of (Array.isArray(rows) ? rows : []).entries()) {
    const row = asObject(rowInput);
    const role = String(row.role || "").trim();
    const start = day(row.start);
    const end = day(row.end);
    if (!role || start === null || end === null || start > end) {
      issues.push(issue("invalid_time_window", `${source}[${index}] must have role and chronological YYYY-MM-DD boundaries`));
      continue;
    }
    if (byRole.has(role)) issues.push(issue("duplicate_window_role", `${source} repeats semantic role ${role}`));
    byRole.set(role, { role, start: row.start, end: row.end, startDay: start, endDay: end });
  }
  return byRole;
}

export function evaluateScientificTimeWindows(preregistration, executedConfig) {
  const issues = [];
  const prereg = normalizeWindows(asObject(preregistration?.payload).windows, "preregistration.windows", issues);
  const actual = normalizeWindows(asObject(executedConfig?.payload).windows, "executed_config.windows", issues);
  const purgeDays = Number(asObject(preregistration?.payload).purge_days);
  if (!Number.isInteger(purgeDays) || purgeDays < 0) issues.push(issue("invalid_purge_gap", "preregistration purge_days must be a non-negative integer"));
  if (prereg.size < 3) issues.push(issue("insufficient_window_roles", "at least three preregistered semantic window roles are required"));
  for (const [role, expected] of prereg.entries()) {
    const observed = actual.get(role);
    if (!observed) issues.push(issue("actual_window_missing", `executed configuration omits ${role}`));
    else if (observed.start !== expected.start || observed.end !== expected.end) {
      issues.push(issue("actual_window_differs_from_preregistration", `${role} actual ${observed.start}..${observed.end} != preregistered ${expected.start}..${expected.end}`));
    }
  }
  for (const role of actual.keys()) {
    if (!prereg.has(role)) issues.push(issue("unpreregistered_window", `executed configuration adds semantic role ${role}`));
  }
  const rows = [...actual.values()].sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay || a.role.localeCompare(b.role));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const left = rows[i];
      const right = rows[j];
      if (right.startDay <= left.endDay) {
        issues.push(issue("time_window_overlap", `${left.role} ${left.start}..${left.end} overlaps ${right.role} ${right.start}..${right.end}`));
      } else if (Number.isInteger(purgeDays) && right.startDay - left.endDay - 1 < purgeDays) {
        issues.push(issue("purge_gap_not_met", `${left.role} to ${right.role} has ${right.startDay - left.endDay - 1} purge days; requires ${purgeDays}`));
      }
    }
  }
  const holdoutRoles = rows.filter((row) => /holdout|oos/.test(row.role));
  const signatures = new Set();
  for (const row of holdoutRoles) {
    const signature = `${row.start}:${row.end}`;
    if (signatures.has(signature)) issues.push(issue("duplicate_holdout", `${row.role} duplicates another holdout at ${row.start}..${row.end}`));
    signatures.add(signature);
  }
  return {
    valid: issues.length === 0,
    issues,
    actual_windows: rows.map(({ startDay, endDay, ...row }) => row),
    preregistered_roles: [...prereg.keys()].sort(),
    purge_days: Number.isInteger(purgeDays) ? purgeDays : null,
  };
}
