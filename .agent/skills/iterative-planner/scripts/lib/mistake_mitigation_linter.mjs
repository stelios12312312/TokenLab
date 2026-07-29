// mistake_mitigation_linter.mjs — Mechanical checks for Program Packet mistake guards.
// @planner:module = mistake_mitigation_linter
// @planner:capability = active_mistake_verification_hook_lint
// @planner:proves = crit:AC-T-INTAKE-2EA1EA51

import { verificationStatusSatisfies } from "./verification_status_vocabulary.mjs";

const MISTAKE_HOOKS = {
  "M-001": {
    guard_ids: ["ripple_through", "migration_smoke"],
    hook_ids: ["ripple_check", "migration-bootstrap", "transition-gate-flows"],
  },
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lower(value) {
  return asString(value).toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(asString).filter(Boolean))];
}

function rowText(row) {
  return [
    row?.id,
    row?.proof_type,
    row?.command_or_action,
    row?.pass_means,
    row?.evidence,
    ...asArray(row?.evidence_refs),
  ].map(asString).join("\n").toLowerCase();
}

function referencedRows(packet, ticket, verificationRows = null) {
  const rows = verificationRows || asArray(packet?.verification_matrix);
  const refs = new Set(asArray(ticket?.verification_refs).map(asString).filter(Boolean));
  return rows.filter((row) => refs.has(asString(row?.id)));
}

function carriedMistakeIds(rows) {
  return uniqueStrings(rows.flatMap((row) => asArray(row?.auto_carried_from)));
}

function rowMentionsAllHooks(rows, hooks) {
  const combined = rows.map(rowText).join("\n");
  return hooks.every((hook) => combined.includes(hook.toLowerCase()));
}

function rowsMentionGuardButNotHook(rows, guardIds, hookIds) {
  const combined = rows.map(rowText).join("\n");
  return guardIds.some((guard) => combined.includes(guard.toLowerCase())) &&
    !hookIds.every((hook) => combined.includes(hook.toLowerCase()));
}

function acceptsHistoricalM001HookContract(ticket, rows) {
  const lifecycle = lower(ticket?.lifecycle);
  if (!["done", "verified", "closed"].includes(lifecycle)) return false;
  // Commit 69672e72 purged the former direct migration test. Terminal rows keep
  // their recorded pre-purge evidence contract; open rows must use governed suites.
  return rowMentionsAllHooks(rows, ["ripple_check", "test_migration"]);
}

export function lintMistakeMitigations({ packet, ticket, verificationRows = null } = {}) {
  const ticketId = asString(ticket?.id);
  const rows = referencedRows(packet, ticket, verificationRows);
  const findings = [];
  const historicalContracts = [];

  for (const mistakeId of carriedMistakeIds(rows)) {
    const contract = MISTAKE_HOOKS[mistakeId];
    if (!contract) continue;
    if (!rowMentionsAllHooks(rows, contract.hook_ids)) {
      if (mistakeId === "M-001" && acceptsHistoricalM001HookContract(ticket, rows)) {
        historicalContracts.push("M-001:pre-69672e72-test-hook-contract");
        continue;
      }
      findings.push({
        code: "mistake_mitigation_hook_missing",
        path: `$.tickets[${ticketId}].verification_refs`,
        message: `${ticketId} carries ${mistakeId}, but verification rows do not name exact hooks: ${contract.hook_ids.join(", ")}`,
      });
      continue;
    }
    if (rowsMentionGuardButNotHook(rows, contract.guard_ids, contract.hook_ids)) {
      findings.push({
        code: "mistake_mitigation_guard_id_used_as_hook",
        path: `$.tickets[${ticketId}].verification_refs`,
        message: `${ticketId} appears to use planning guard ids as executable evidence for ${mistakeId}; use ${contract.hook_ids.join(", ")}.`,
      });
    }
  }

  for (const row of rows) {
    const carried = uniqueStrings(row?.auto_carried_from);
    if (carried.length === 0) continue;
    const known = carried.some((id) => MISTAKE_HOOKS[id]);
    if (!known) continue;
    const status = row?.result || row?.status || row?.outcome;
    if (verificationStatusSatisfies(status, "program") && !rowText(row).includes("ripple_check") && carried.includes("M-001")) {
      findings.push({
        code: "mistake_mitigation_pass_without_hook_evidence",
        path: `$.verification_matrix[${asString(row?.id)}].result`,
        message: `${asString(row?.id)} is marked passing for M-001 without naming ripple_check, migration-bootstrap, and transition-gate-flows evidence.`,
      });
    }
  }

  return {
    status: findings.length === 0 ? "pass" : "fail",
    findings,
    checked_rows: rows.map((row) => asString(row?.id)).filter(Boolean),
    historical_contracts: historicalContracts,
  };
}
