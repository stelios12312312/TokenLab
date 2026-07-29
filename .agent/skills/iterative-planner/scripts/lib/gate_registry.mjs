// gate_registry.mjs — normalized loader for the planner gate registry.

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { resolveAuthorityProfile } from "./planner_phase_routing.mjs";

const DEFAULT_SKILL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const GATE_REGISTRY_DEFAULTS = Object.freeze({
  persona_audit: true,
  health_scan: null,
  trace_audit: true,
  reachability_audit: true,
  audit_only: false,
});

export const GATE_REGISTRY_PROLOG_BLOCK_START = "%% BEGIN GENERATED GATE REGISTRY FACTS";
export const GATE_REGISTRY_PROLOG_BLOCK_END = "%% END GENERATED GATE REGISTRY FACTS";

const PHASE_ORDER = Object.freeze({
  explore: 1,
  plan: 2,
  execute: 3,
  reflect: 4,
  validate: 5,
  close: 6,
});

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeHealthScan(value, fallback = null) {
  if (value === "quick" || value === "full") return value;
  if (value === null) return null;
  return fallback;
}

function normalizeFrom(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function normalizeGateDefaults(rawDefaults = {}) {
  return {
    persona_audit: normalizeBoolean(rawDefaults.persona_audit, GATE_REGISTRY_DEFAULTS.persona_audit),
    health_scan: normalizeHealthScan(rawDefaults.health_scan, GATE_REGISTRY_DEFAULTS.health_scan),
    trace_audit: normalizeBoolean(rawDefaults.trace_audit, GATE_REGISTRY_DEFAULTS.trace_audit),
    reachability_audit: normalizeBoolean(rawDefaults.reachability_audit, GATE_REGISTRY_DEFAULTS.reachability_audit),
    audit_only: normalizeBoolean(rawDefaults.audit_only, GATE_REGISTRY_DEFAULTS.audit_only),
  };
}

function normalizeAuthorityOverride(rawGate = {}) {
  const override = rawGate?.authority_profile && typeof rawGate.authority_profile === "object"
    ? { ...rawGate.authority_profile }
    : {};
  if (typeof rawGate?.phase === "string" && rawGate.phase.trim() && !override.phase) {
    override.phase = rawGate.phase.trim();
  }
  return override;
}

export function normalizeGateRegistryDocument(document = {}) {
  const defaults = normalizeGateDefaults(document?.defaults || {});
  const rawGates = document?.gates && typeof document.gates === "object" ? document.gates : {};
  const normalized = {};

  for (const [gateName, rawGate] of Object.entries(rawGates)) {
    if (!rawGate || typeof rawGate !== "object") continue;

    const gateDef = {
      from: normalizeFrom(rawGate.from),
      to: rawGate.to === null || rawGate.to === undefined ? null : String(rawGate.to),
      audit_only: normalizeBoolean(rawGate.audit_only, defaults.audit_only),
      persona_audit: normalizeBoolean(rawGate.persona_audit, defaults.persona_audit),
      health_scan: normalizeHealthScan(rawGate.health_scan, defaults.health_scan),
      trace_audit: normalizeBoolean(rawGate.trace_audit, defaults.trace_audit),
      reachability_audit: normalizeBoolean(rawGate.reachability_audit, defaults.reachability_audit),
    };

    const authorityOverride = normalizeAuthorityOverride(rawGate);
    gateDef.authority_profile = resolveAuthorityProfile({
      gateName,
      gateDef,
      override: authorityOverride,
    });

    normalized[gateName] = gateDef;
  }

  return normalized;
}

export function resolveGateRegistryPath({ skillPath = DEFAULT_SKILL_PATH } = {}) {
  return join(skillPath, "config", "gates.json");
}

export function loadGateRegistry({ skillPath = DEFAULT_SKILL_PATH } = {}) {
  const path = resolveGateRegistryPath({ skillPath });
  if (!existsSync(path)) return null;
  const rawText = readFileSync(path, "utf-8");
  const raw = JSON.parse(rawText);
  return {
    path,
    raw,
    gates: normalizeGateRegistryDocument(raw),
  };
}

export function safeLoadGateRegistry({ skillPath = DEFAULT_SKILL_PATH } = {}) {
  try {
    return loadGateRegistry({ skillPath });
  } catch {
    return null;
  }
}

function prologQuotedAtom(value) {
  return `'${String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function prologStateAtom(value) {
  return String(value || "").trim().toLowerCase();
}

function gateSources(gateDef = {}) {
  if (Array.isArray(gateDef.from)) return gateDef.from;
  if (typeof gateDef.from === "string" && gateDef.from.trim()) return [gateDef.from.trim()];
  return [];
}

function orderedTransitionGates(gates = {}) {
  return Object.entries(gates)
    .filter(([, gateDef]) => !gateDef.audit_only && gateDef.to && gateSources(gateDef).length === 1)
    .map(([gateName, gateDef]) => ({
      gateName,
      from: gateSources(gateDef)[0],
      to: gateDef.to,
      fromIndex: PHASE_ORDER[prologStateAtom(gateSources(gateDef)[0])] || 999,
      toIndex: PHASE_ORDER[prologStateAtom(gateDef.to)] || 999,
    }))
    .sort((a, b) => a.fromIndex - b.fromIndex || a.toIndex - b.toIndex || a.gateName.localeCompare(b.gateName));
}

export function renderGateRegistryPrologFacts({ gates = {} } = {}) {
  const lines = [
    GATE_REGISTRY_PROLOG_BLOCK_START,
    "%% Source of truth: .agent/skills/iterative-planner/config/gates.json",
    "%% Generated by scripts/lib/gate_registry.mjs; update gates.json, then refresh this block.",
  ];

  for (const [gateName, gateDef] of Object.entries(gates)) {
    const sources = gateSources(gateDef);
    if (gateDef.audit_only || !gateDef.to) {
      lines.push(`audit_gate(${prologQuotedAtom(gateName)}).`);
      for (const source of sources) {
        lines.push(`audit_gate_source(${prologQuotedAtom(gateName)}, ${prologStateAtom(source)}).`);
      }
      continue;
    }

    for (const source of sources) {
      lines.push(`gate_transition(${prologQuotedAtom(gateName)}, ${prologStateAtom(source)}, ${prologStateAtom(gateDef.to)}).`);
    }
  }

  const ordered = orderedTransitionGates(gates);
  for (let i = 1; i < ordered.length; i += 1) {
    lines.push(`predecessor(${prologQuotedAtom(ordered[i].gateName)}, ${prologQuotedAtom(ordered[i - 1].gateName)}).`);
  }

  lines.push(GATE_REGISTRY_PROLOG_BLOCK_END);
  return `${lines.join("\n")}\n`;
}

export function extractGateRegistryPrologBlock(prologText = "") {
  const text = String(prologText || "").replace(/\r\n/g, "\n");
  const start = text.indexOf(GATE_REGISTRY_PROLOG_BLOCK_START);
  const end = text.indexOf(GATE_REGISTRY_PROLOG_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return "";
  return text.slice(start, end + GATE_REGISTRY_PROLOG_BLOCK_END.length).trimEnd() + "\n";
}

export function compareGateRegistryPrologFacts({ gates = {}, prologText = "" } = {}) {
  const expected = renderGateRegistryPrologFacts({ gates });
  const actual = extractGateRegistryPrologBlock(prologText);
  const issues = [];
  if (!actual) {
    issues.push("generated gate registry block missing from transitions.pl");
  } else if (actual.trim() !== expected.trim()) {
    issues.push("generated gate registry block does not match config/gates.json");
  }
  return {
    ok: issues.length === 0,
    issues,
    expected,
    actual,
  };
}
