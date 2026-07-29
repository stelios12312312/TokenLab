// session_obligations.mjs - Disk-first assumption/obligation reconstruction.
//
// The structured findings ledger is the durable source. Chat context may vanish;
// this reader reconstructs load-bearing assumptions and close blockers solely
// from files in the active plan directory.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

const BLOCKING_STATUSES = new Set(["UNVALIDATED", "TESTING"]);

function readJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && entry !== undefined);
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

export function normalizeAssumptionStatus(value) {
  const raw = String(value || "UNVALIDATED").trim().toUpperCase().replace(/\s+/g, "_");
  // These five values are assumption lifecycle states, not proof verdicts.
  if (["UNVALIDATED", "TESTING", "VALIDATED", "REFUTED", "RETIRED"].includes(raw)) return raw;
  if (raw === "VIOLATED") return "REFUTED";
  if (raw === "IN_PROGRESS" || raw === "IN-PROGRESS") return "TESTING";

  const presentation = normalizeVerificationStatus(value, "presentation");
  if (presentation.kind === "pass") return "VALIDATED";
  if (presentation.kind === "fail") return "REFUTED";
  if (presentation.kind === "waived" || presentation.kind === "not_applicable") return "RETIRED";

  const decision = normalizeVerificationStatus(value, "decision");
  if (decision.kind === "pass") return "VALIDATED";
  if (decision.kind === "fail") return "REFUTED";
  return "UNVALIDATED";
}

export function assumptionStatusIsResolved(value) {
  const status = normalizeAssumptionStatus(value);
  return status === "VALIDATED" || status === "REFUTED";
}

function truthy(value) {
  if (value === true) return true;
  const text = String(value || "").trim().toLowerCase();
  return ["true", "yes", "1", "required", "critical", "load-bearing", "load_bearing"].includes(text);
}

function normalizeAssumption(entry, index) {
  if (typeof entry === "string") {
    return {
      id: `A-${String(index + 1).padStart(3, "0")}`,
      status: "UNVALIDATED",
      statement: entry.trim(),
      load_bearing: false,
      cited_as_support: false,
      supports: [],
      probe: null,
    };
  }
  if (!entry || typeof entry !== "object") return null;

  const supports = asArray(entry.supports || entry.supports_criteria || entry.supported_criteria || entry.citations)
    .map((value) => String(value).trim())
    .filter(Boolean);
  const id = firstString(entry.id, entry.assumption_id, entry.key) || `A-${String(index + 1).padStart(3, "0")}`;
  const status = normalizeAssumptionStatus(entry.status || entry.result || entry.outcome);
  const statement = firstString(
    entry.statement,
    entry.summary,
    entry.assumption,
    entry.hypothesis,
    entry.title
  ) || "(no assumption text recorded)";
  const loadBearing = truthy(entry.load_bearing) ||
    truthy(entry.loadBearing) ||
    truthy(entry.required_for_close) ||
    truthy(entry.requiredForClose);
  const citedAsSupport = truthy(entry.cited_as_support) ||
    truthy(entry.citedAsSupport) ||
    supports.length > 0;

  return {
    id,
    status,
    statement,
    load_bearing: loadBearing,
    cited_as_support: citedAsSupport,
    supports,
    probe: firstString(entry.probe, entry.command, entry.check),
  };
}

export function loadSessionObligations(planDir) {
  const ledger = readJson(join(planDir, "findings_ledger.json"));
  const assumptions = asArray(ledger?.assumptions)
    .map((entry, index) => normalizeAssumption(entry, index))
    .filter(Boolean);
  const blockers = assumptions.filter((assumption) => (
    (assumption.load_bearing && BLOCKING_STATUSES.has(assumption.status)) ||
    (assumption.cited_as_support && assumption.status === "REFUTED")
  ));

  return {
    present: !!ledger,
    assumptions,
    blockers,
    active: assumptions.filter((assumption) => assumption.status !== "RETIRED"),
  };
}

export function formatSessionAssumption(assumption) {
  const flags = [
    assumption.load_bearing ? "load-bearing" : null,
    assumption.cited_as_support ? "support" : null,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return `${assumption.id}: ${assumption.status}${suffix} - ${assumption.statement}`;
}

export function formatSessionAssumptionBlockers(blockers) {
  return blockers.map(formatSessionAssumption).join("; ");
}

export function summarizeSessionObligations(planDir) {
  const obligations = loadSessionObligations(planDir);
  const active = obligations.active;
  if (active.length === 0) {
    return { ...obligations, summary: "No active session assumptions recorded." };
  }
  const blockerText = obligations.blockers.length > 0
    ? `${obligations.blockers.length} blocker(s): ${formatSessionAssumptionBlockers(obligations.blockers)}`
    : "no blockers";
  return {
    ...obligations,
    summary: `${active.length} active assumption(s), ${blockerText}`,
  };
}
