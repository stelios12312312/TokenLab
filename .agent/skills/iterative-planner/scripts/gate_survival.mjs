#!/usr/bin/env node
// @planner:module gate_survival
// @planner:capability Deterministic gate survival analysis for autocoder-v2 E2-4.
//
// gate_survival.mjs turns planner transition evidence into a KEEP / DEMOTE /
// DELETE feed for later gate-deletion tickets. Decision logs are the primary
// survival signal; state.json and telemetry/events.jsonl provide corroborating
// source counts without double-counting the same transition attempts.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { gateFailureNature } from "./lib/behavior_report.mjs";
import { normalizeVerificationStatus } from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const SKILL_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");
const DEFAULT_PLANS_DIR = join(REPO_ROOT, "plans");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "reports", "ive", "gate_survival");
const GATES_CONFIG_PATH = join(SKILL_ROOT, "config", "gates.json");
const FAILURE_CODES_CONFIG_PATH = join(SKILL_ROOT, "config", "failure-codes.json");
const CHECKLISTS_DIR = join(SKILL_ROOT, "checklists");
const PROLOG_DIR = join(SKILL_ROOT, "prolog");
const SCRIPTS_DIR = join(SKILL_ROOT, "scripts");
const SELF_CLEAR_WINDOW_SEC_DEFAULT = 120;
const SCHEMA_VERSION = 1;

const CLASS_ORDER = { DELETE: 0, DEMOTE: 1, KEEP: 2 };
const NATURE_ORDER = { ceremony: 0, hybrid: 1, unknown: 2, substantive: 3 };
const CANDIDATE_ACTIONABILITIES = Object.freeze(["actionable", "review_only", "non_actionable", "not_candidate"]);

export const KNOWN_FALSE_RED_CLASSES = Object.freeze([
  {
    id: "deliverable_evidence_parser",
    codes: ["GATE-VAL-012"],
    gate: "validate-to-close",
    description: "Deliverable evidence parser required explicit deliverable IDs/names near PASS evidence.",
    disposition: "keep_guard_intent_repair_parser",
  },
  {
    id: "anti_recurrence_parser",
    codes: ["GATE-VAL-013"],
    gate: "validate-to-close",
    description: "Anti-recurrence parser required standalone PASS language plus Guard Type.",
    disposition: "keep_guard_intent_repair_parser",
  },
  {
    id: "planner_core_self_proof",
    codes: ["GATE-VAL-010"],
    gate: "validate-to-close",
    description: "Planner-core close proof required focused transition regression evidence beyond full-suite PASS.",
    disposition: "keep_guard_intent_make_evidence_contract_explicit",
  },
  {
    id: "global_review_intake_noise",
    codes: ["review_intake_unresolved", "rule_engine_global_noise"],
    gate: "validate-to-close",
    description: "Broad review/invariant commands can surface stale unrelated issues while targeted close diagnostics pass.",
    disposition: "demote_global_noise_to_targeted_context",
  },
  {
    id: "stale_registry_orphan_envelope",
    codes: ["stale_registry_hash", "orphan_envelope"],
    gate: "ontology-invariants",
    description: "Pre-existing ontology known-red: stale registry hash and orphan envelope on a stuck 2026-06-10 plan.",
    disposition: "fixture_not_drive_by_fix",
  },
  {
    id: "local_ci_environment_flake",
    codes: ["CLAUDE_CODE_ENV", "path_with_spaces"],
    gate: "local-vs-ci",
    description: "Local-vs-CI environment/path flakiness is E1-4 scope, not an E2-4 cleanup.",
    disposition: "report_only_until_e1_4",
  },
]);

const FALSE_RED_BY_CODE = new Map();
for (const row of KNOWN_FALSE_RED_CLASSES) {
  for (const code of row.codes) FALSE_RED_BY_CODE.set(code, row.id);
}

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    plansDir: DEFAULT_PLANS_DIR,
    outDir: DEFAULT_OUT_DIR,
    windowSec: SELF_CLEAR_WINDOW_SEC_DEFAULT,
    write: false,
    json: false,
    help: false,
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (token === "--cwd") {
      opts.cwd = resolve(args.shift() || process.cwd());
      if (opts.plansDir === DEFAULT_PLANS_DIR) opts.plansDir = join(opts.cwd, "plans");
      if (opts.outDir === DEFAULT_OUT_DIR) opts.outDir = join(opts.cwd, "reports", "ive", "gate_survival");
    } else if (token === "--plans-dir") {
      opts.plansDir = resolve(args.shift() || DEFAULT_PLANS_DIR);
    } else if (token === "--out-dir") {
      opts.outDir = resolve(args.shift() || DEFAULT_OUT_DIR);
    } else if (token === "--window-sec") {
      opts.windowSec = Number(args.shift()) || SELF_CLEAR_WINDOW_SEC_DEFAULT;
    } else if (token === "--write") {
      opts.write = true;
    } else if (token === "--json") {
      opts.json = true;
    } else if (token === "--help" || token === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return opts;
}

function usage() {
  return `gate_survival.mjs - build E2-4 gate survival evidence

Usage:
  node gate_survival.mjs [--json] [--write] [--cwd <repo>] [--plans-dir <dir>]
                         [--out-dir <dir>] [--window-sec N]

Flags:
  --json          Emit machine-readable JSON.
  --write         Write gate_survival.json and gate_survival.md.
  --cwd           Repository root for default plans/report paths.
  --plans-dir     Plans directory to scan. Recursive; includes .audit-archive.
  --out-dir       Output directory for --write.
  --window-sec    BLOCKED->ALLOWED window counted as artifact-edit/self-clear (default 120).
`;
}

function rel(root, path) {
  const r = relative(root, path);
  return r && !r.startsWith("..") ? r.replace(/\\/g, "/") : path.replace(/\\/g, "/");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readJsonl(path) {
  const result = { rows: [], malformed: 0, raw_count: 0 };
  let text = "";
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return result;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    result.raw_count += 1;
    try {
      result.rows.push(JSON.parse(trimmed));
    } catch {
      result.malformed += 1;
    }
  }
  return result;
}

function walkFiles(root) {
  const out = [];
  function visit(dir) {
    if (!existsSync(dir)) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.push(path);
    }
  }
  visit(root);
  return out.sort();
}

function walkDirs(root) {
  const out = [];
  function visit(dir) {
    if (!existsSync(dir)) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      out.push(path);
      visit(path);
    }
  }
  visit(root);
  return out.sort();
}

function listTopLevelPlanDirs(plansDir) {
  if (!existsSync(plansDir)) return [];
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
      .map((entry) => join(plansDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function planIdFromPath(path) {
  const parts = path.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].startsWith("plan_")) return parts[i];
  }
  return "unknown_plan";
}

function loadConfiguredGates() {
  const config = readJson(GATES_CONFIG_PATH);
  const gates = config?.gates && typeof config.gates === "object" ? config.gates : {};
  return Object.keys(gates).sort().map((name) => ({ name, ...gates[name] }));
}

function emptyGateStat(name, configured = false) {
  return {
    gate: name,
    configured,
    classification: null,
    rationale: [],
    evidence_counts: {
      decision_log_attempts: 0,
      state_transitions: 0,
      telemetry_events: 0,
      malformed_jsonl_rows: 0,
    },
    blocked: 0,
    allowed: 0,
    unknown: 0,
    state_failures: 0,
    self_clearing_unblocks: 0,
    self_clear_rate: 0,
    bounce_loops: 0,
    max_block_streak: 0,
    action_buckets: {
      real_source_or_plan_fix: 0,
      artifact_edit_until_green: 0,
      unresolved_or_abandoned: 0,
      never_failed: 0,
    },
    failure_code_counts: {},
    self_clearing_codes: {},
    failure_nature_counts: {
      ceremony: 0,
      hybrid: 0,
      substantive: 0,
      unknown: 0,
    },
    top_failure_codes: [],
    source_examples: [],
  };
}

function bump(object, key, amount = 1) {
  if (!key) return;
  object[key] = (object[key] || 0) + amount;
}

function addExample(list, value, max = 5) {
  if (!value || list.includes(value) || list.length >= max) return;
  list.push(value);
}

function checkKey(check, fallbackCode = null) {
  if (check?.code) return String(check.code);
  if (fallbackCode) return String(fallbackCode);
  if (check?.name) {
    const slug = String(check.name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return `CHECK:${slug || "unnamed"}`;
  }
  return "CHECK:unknown";
}

function statusOf(check) {
  return check?.status ?? "";
}

function statusKind(value) {
  return normalizeVerificationStatus(value, "gate").kind;
}

function normalizeDecision(entry) {
  if (entry?.decision === "BLOCKED" || entry?.decision === "ALLOWED") return entry.decision;
  const gateResult = normalizeVerificationStatus(entry?.gate_result, "gate");
  if (gateResult.kind === "fail") return "BLOCKED";
  if (gateResult.kind === "pass") return "ALLOWED";
  if (Array.isArray(entry?.checks) && entry.checks.some((check) => statusKind(check?.status) === "fail")) return "BLOCKED";
  return "UNKNOWN";
}

function uniq(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

function emptyCheckStat(key, label = key) {
  return {
    id: key,
    label,
    classification: null,
    rationale: [],
    nature: key.startsWith("GATE-") ? gateFailureNature(key) : "unknown",
    observed: 0,
    pass: 0,
    warn: 0,
    fail: 0,
    unknown: 0,
    self_cleared: 0,
    self_clear_rate: 0,
    gates: new Set(),
    sources: new Set(),
    known_false_red_classes: new Set(FALSE_RED_BY_CODE.has(key) ? [FALSE_RED_BY_CODE.get(key)] : []),
    examples: [],
  };
}

function emptyClassificationCounts() {
  return { KEEP: 0, DEMOTE: 0, DELETE: 0 };
}

function isGateCode(value) {
  return /^GATE-[A-Z]+-\d+$/i.test(String(value || ""));
}

function isSyntheticSummaryCheck(row) {
  const id = String(row?.id || "");
  const label = String(row?.label || "");
  return /^CHECK:\d+_warning_s$/i.test(id) ||
    /^\d+\s+warning\(s\)$/i.test(label) ||
    /^\d+\s+warnings?$/i.test(label);
}

function candidateDispositionForGate(row) {
  if (row.classification === "KEEP") {
    return {
      candidate_disposition: "keep_strict",
      candidate_actionability: "not_candidate",
      candidate_reason: "strict gate has blocking or substantive survival evidence",
    };
  }
  if (row.classification === "DEMOTE") {
    return {
      candidate_disposition: "demote_candidate_gate",
      candidate_actionability: "actionable",
      candidate_reason: "gate-level demotion candidate with transition evidence",
    };
  }
  return {
    candidate_disposition: "delete_candidate_gate",
    candidate_actionability: "actionable",
    candidate_reason: "gate-level deletion candidate with no observed discrimination",
  };
}

function candidateDispositionForCheck(row) {
  if (row.classification === "KEEP") {
    return {
      candidate_disposition: "keep_strict",
      candidate_actionability: "not_candidate",
      candidate_reason: row.known_false_red_classes?.length
        ? "known false-red class keeps guard intent while parser/evidence contract is repaired"
        : "check has blocking or substantive survival evidence",
    };
  }
  if (row.classification === "DEMOTE") {
    return {
      candidate_disposition: isGateCode(row.id) ? "demote_candidate_guard_code" : "demote_candidate_unmapped_check",
      candidate_actionability: "actionable",
      candidate_reason: "demotion candidate still needs proof that guard intent remains covered",
    };
  }
  if (isSyntheticSummaryCheck(row)) {
    return {
      candidate_disposition: "ignore_synthetic_summary",
      candidate_actionability: "non_actionable",
      candidate_reason: "summary count row is generated from checklist prose and is not a gate/check to delete",
    };
  }
  if (isGateCode(row.id)) {
    return {
      candidate_disposition: "delete_candidate_guard_code",
      candidate_actionability: "actionable",
      candidate_reason: "guard-code row has no observed blocking evidence but needs proof-backed deletion review",
    };
  }
  return {
    candidate_disposition: "defer_unmapped_pass_only_check",
    candidate_actionability: "review_only",
    candidate_reason: "pass-only unmapped checklist row needs review before it can become deletion work",
  };
}

function recordCheck(checks, key, {
  label = key,
  status = "UNKNOWN",
  gate = null,
  source = null,
  example = null,
  knownFalseRed = null,
} = {}) {
  const row = checks.get(key) || emptyCheckStat(key, label);
  row.label = row.label || label;
  row.observed += 1;
  const normalizedStatus = normalizeVerificationStatus(status, "gate");
  if (normalizedStatus.kind === "pass") row.pass += 1;
  else if (normalizedStatus.kind === "pending" && normalizedStatus.token !== "UNKNOWN") row.warn += 1;
  else if (normalizedStatus.kind === "fail") row.fail += 1;
  else row.unknown += 1;
  if (gate) row.gates.add(gate);
  if (source) row.sources.add(source);
  if (knownFalseRed) row.known_false_red_classes.add(knownFalseRed);
  addExample(row.examples, example);
  checks.set(key, row);
  return row;
}

function failureCodesForEntry(entry) {
  const codes = Array.isArray(entry?.failure_codes) ? entry.failure_codes : [];
  const checkCodes = Array.isArray(entry?.checks)
    ? entry.checks.filter((check) => statusKind(check?.status) === "fail" && check?.code).map((check) => check.code)
    : [];
  return uniq([...codes, ...checkCodes]);
}

function recordEntryChecks({ entry, gate, source, checks }) {
  const failedCodes = failureCodesForEntry(entry);
  const failedKeys = [];
  const seen = new Set();
  const checkRows = Array.isArray(entry?.checks) ? entry.checks : [];
  for (const check of checkRows) {
    const status = statusOf(check);
    const failed = statusKind(status) === "fail";
    const key = checkKey(check, failed && failedCodes.length === 1 ? failedCodes[0] : null);
    seen.add(key);
    recordCheck(checks, key, {
      label: check?.name || key,
      status,
      gate,
      source,
      example: check?.detail || check?.name || key,
      knownFalseRed: FALSE_RED_BY_CODE.get(key),
    });
    if (failed) failedKeys.push(key);
  }
  for (const code of failedCodes) {
    if (seen.has(code)) continue;
    recordCheck(checks, code, {
      label: code,
      status: "FAIL",
      gate,
      source,
      example: `failure_codes included ${code}`,
      knownFalseRed: FALSE_RED_BY_CODE.get(code),
    });
    failedKeys.push(code);
  }
  return uniq(failedKeys);
}

function gateForStateTransition(transition, configuredGates) {
  if (transition?.gate) return String(transition.gate);
  const from = String(transition?.from || "").toLowerCase();
  const to = String(transition?.to || "").toLowerCase();
  for (const gate of configuredGates) {
    const fromValues = Array.isArray(gate.from) ? gate.from : [gate.from];
    const fromMatch = fromValues.map((v) => String(v || "").toLowerCase()).includes(from);
    const toValue = gate.to === null || gate.to === undefined ? "" : String(gate.to).toLowerCase();
    if (fromMatch && toValue === to) return gate.name;
  }
  return null;
}

function classifyGate(stat) {
  const substantive = stat.failure_nature_counts.substantive || 0;
  const ceremony = stat.failure_nature_counts.ceremony || 0;
  const hybrid = stat.failure_nature_counts.hybrid || 0;
  if (stat.blocked === 0 && stat.state_failures === 0) {
    return {
      classification: "DELETE",
      rationale: ["never discriminated in decision logs or state history"],
    };
  }
  if (stat.gate === "notify-user" && stat.blocked <= 3 && stat.self_clear_rate >= 0.75) {
    return {
      classification: "DEMOTE",
      rationale: ["audit-only gate has low block count and complete self-clear in current corpus"],
    };
  }
  if (stat.self_clear_rate >= 0.5 && ceremony + hybrid >= substantive) {
    return {
      classification: "DEMOTE",
      rationale: ["high self-clear rate is dominated by ceremony/hybrid checks"],
    };
  }
  return {
    classification: "KEEP",
    rationale: substantive > 0
      ? ["substantive failures changed or blocked outcomes"]
      : ["blocked transitions require human review before demotion or deletion"],
  };
}

function classifyCheck(row) {
  if (row.known_false_red_classes.size > 0) {
    return {
      classification: "KEEP",
      rationale: ["known false-red class; keep guard intent but repair parser/evidence contract"],
    };
  }
  if (row.fail === 0 && row.observed > 0) {
    return {
      classification: "DELETE",
      rationale: ["never discriminated; observed only as PASS/WARN/UNKNOWN"],
    };
  }
  if (row.nature === "ceremony") {
    return {
      classification: "DEMOTE",
      rationale: ["ceremony-format check produced failures; candidate for advisory or lower severity"],
    };
  }
  if (row.nature === "hybrid" && row.fail > 0 && row.self_clear_rate >= 0.5) {
    return {
      classification: "DEMOTE",
      rationale: ["hybrid check self-cleared at high rate"],
    };
  }
  if (row.fail > 0) {
    return {
      classification: "KEEP",
      rationale: row.nature === "substantive"
        ? ["substantive check produced blocking evidence"]
        : ["blocking evidence exists; review before demotion or deletion"],
    };
  }
  return {
    classification: "DELETE",
    rationale: ["no blocking evidence"],
  };
}

function finalizeGateStats(gates) {
  const finalized = {};
  for (const name of Object.keys(gates).sort()) {
    const stat = gates[name];
    for (const [code, count] of Object.entries(stat.failure_code_counts)) {
      bump(stat.failure_nature_counts, gateFailureNature(code), count);
    }
    stat.self_clear_rate = stat.blocked ? Number((stat.self_clearing_unblocks / stat.blocked).toFixed(3)) : 0;
    stat.action_buckets.never_failed = stat.blocked === 0 && stat.state_failures === 0 ? 1 : 0;
    stat.top_failure_codes = Object.entries(stat.failure_code_counts)
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([code, count]) => ({
        code,
        count,
        nature: gateFailureNature(code),
        self_cleared: stat.self_clearing_codes[code] || 0,
        known_false_red_class: FALSE_RED_BY_CODE.get(code) || null,
      }));
    const classification = classifyGate(stat);
    stat.classification = classification.classification;
    stat.rationale = classification.rationale;
    Object.assign(stat, candidateDispositionForGate(stat));
    finalized[name] = stat;
  }
  return finalized;
}

function finalizeChecks(checks) {
  return [...checks.values()].map((row) => {
    row.self_clear_rate = row.fail ? Number((row.self_cleared / row.fail).toFixed(3)) : 0;
    const classification = classifyCheck(row);
    const output = {
      id: row.id,
      label: row.label,
      classification: classification.classification,
      rationale: classification.rationale,
      nature: row.nature,
      observed: row.observed,
      pass: row.pass,
      warn: row.warn,
      fail: row.fail,
      unknown: row.unknown,
      self_cleared: row.self_cleared,
      self_clear_rate: row.self_clear_rate,
      gates: [...row.gates].sort(),
      sources: [...row.sources].sort(),
      known_false_red_classes: [...row.known_false_red_classes].sort(),
      examples: row.examples,
    };
    Object.assign(output, candidateDispositionForCheck(output));
    return output;
  }).sort((a, b) =>
    (CLASS_ORDER[a.classification] - CLASS_ORDER[b.classification]) ||
    (b.self_cleared - a.self_cleared) ||
    (b.fail - a.fail) ||
    (NATURE_ORDER[a.nature] - NATURE_ORDER[b.nature]) ||
    a.id.localeCompare(b.id)
  );
}

function summarizeClassification(rows) {
  const out = { KEEP: 0, DEMOTE: 0, DELETE: 0 };
  for (const row of rows) if (out[row.classification] !== undefined) out[row.classification] += 1;
  return out;
}

function summarizeCandidates(rows) {
  const actionability = {};
  const dispositions = {};
  const classifications = {};
  for (const key of CANDIDATE_ACTIONABILITIES) classifications[key] = emptyClassificationCounts();
  for (const row of rows) {
    const actionKey = CANDIDATE_ACTIONABILITIES.includes(row.candidate_actionability)
      ? row.candidate_actionability
      : "review_only";
    bump(actionability, actionKey);
    bump(dispositions, row.candidate_disposition || "unknown");
    if (classifications[actionKey]?.[row.classification] !== undefined) {
      classifications[actionKey][row.classification] += 1;
    }
  }
  return { actionability, dispositions, classifications };
}

function addClassificationCounts(a, b) {
  const out = emptyClassificationCounts();
  for (const key of Object.keys(out)) out[key] = (a?.[key] || 0) + (b?.[key] || 0);
  return out;
}

function addCountObjects(a = {}, b = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]).values()) {
    out[key] = (a[key] || 0) + (b[key] || 0);
  }
  return out;
}

function updateProgressFromDecisionLogs({ decisionLogFiles, root, gates, checks, windowMs }) {
  const transitionsByPlan = new Map();
  for (const file of decisionLogFiles) {
    const parsed = readJsonl(file);
    const source = rel(root, file);
    const planId = planIdFromPath(file);
    if (!transitionsByPlan.has(planId)) transitionsByPlan.set(planId, []);
    for (const gateName of Object.keys(gates)) {
      gates[gateName].evidence_counts.malformed_jsonl_rows += parsed.malformed;
    }
    for (const entry of parsed.rows) {
      if (entry?.type !== "gate_transition" || !entry?.gate) continue;
      const gate = String(entry.gate);
      if (!gates[gate]) gates[gate] = emptyGateStat(gate, false);
      addExample(gates[gate].source_examples, source);
      const decision = normalizeDecision(entry);
      const failedCodes = failureCodesForEntry(entry);
      const failedKeys = recordEntryChecks({ entry, gate, source, checks });
      const transition = {
        gate,
        decision,
        ts: entry.timestamp ? Date.parse(entry.timestamp) : NaN,
        timestamp: entry.timestamp || null,
        failedCodes,
        failedKeys,
      };
      transitionsByPlan.get(planId).push(transition);
      const stat = gates[gate];
      stat.evidence_counts.decision_log_attempts += 1;
      if (decision === "BLOCKED") {
        stat.blocked += 1;
        for (const code of failedCodes) bump(stat.failure_code_counts, code);
      } else if (decision === "ALLOWED") {
        stat.allowed += 1;
      } else {
        stat.unknown += 1;
      }
    }
  }

  for (const transitions of transitionsByPlan.values()) {
    const streaks = new Map();
    for (const transition of transitions) {
      if (transition.decision === "BLOCKED") {
        const streak = streaks.get(transition.gate) || {
          firstTs: NaN,
          lastTs: NaN,
          length: 0,
          codes: new Set(),
          checks: new Set(),
        };
        if (Number.isFinite(transition.ts) && !Number.isFinite(streak.firstTs)) streak.firstTs = transition.ts;
        if (Number.isFinite(transition.ts)) streak.lastTs = transition.ts;
        streak.length += 1;
        for (const code of transition.failedCodes) streak.codes.add(code);
        for (const key of transition.failedKeys) streak.checks.add(key);
        streaks.set(transition.gate, streak);
      } else if (transition.decision === "ALLOWED") {
        const streak = streaks.get(transition.gate);
        if (!streak) continue;
        const stat = gates[transition.gate];
        stat.bounce_loops += 1;
        stat.max_block_streak = Math.max(stat.max_block_streak, streak.length);
        const selfClear = Number.isFinite(streak.firstTs) &&
          Number.isFinite(transition.ts) &&
          transition.ts - streak.firstTs <= windowMs;
        if (selfClear) {
          stat.self_clearing_unblocks += 1;
          stat.action_buckets.artifact_edit_until_green += 1;
          for (const code of streak.codes) bump(stat.self_clearing_codes, code);
          for (const key of streak.checks) {
            const row = checks.get(key);
            if (row) row.self_cleared += 1;
          }
        } else {
          stat.action_buckets.real_source_or_plan_fix += 1;
        }
        streaks.delete(transition.gate);
      }
    }
    for (const [gate, streak] of streaks) {
      const stat = gates[gate];
      stat.bounce_loops += 1;
      stat.max_block_streak = Math.max(stat.max_block_streak, streak.length);
      stat.action_buckets.unresolved_or_abandoned += 1;
    }
  }
}

function updateProgressFromStates({ stateFiles, configuredGates, root, gates, checks }) {
  for (const file of stateFiles) {
    const state = readJson(file);
    if (!state || !Array.isArray(state.transitions)) continue;
    const source = rel(root, file);
    for (const transition of state.transitions) {
      const gate = gateForStateTransition(transition, configuredGates);
      if (!gate) continue;
      if (!gates[gate]) gates[gate] = emptyGateStat(gate, false);
      const stat = gates[gate];
      addExample(stat.source_examples, source);
      stat.evidence_counts.state_transitions += 1;
      const failed = String(transition.gate_result || "").toUpperCase() === "FAIL";
      if (failed) stat.state_failures += 1;
      const codes = Array.isArray(transition.failure_codes) ? transition.failure_codes : [];
      for (const code of codes) {
        if (failed) bump(stat.failure_code_counts, code);
        recordCheck(checks, String(code), {
          label: String(code),
          status: failed ? "FAIL" : "PASS",
          gate,
          source,
          example: `state transition ${transition.from || "?"}->${transition.to || "?"}`,
          knownFalseRed: FALSE_RED_BY_CODE.get(String(code)),
        });
      }
    }
  }
}

function updateProgressFromTelemetry({ telemetryFiles, root, gates }) {
  for (const file of telemetryFiles) {
    const parsed = readJsonl(file);
    const source = rel(root, file);
    for (const entry of parsed.rows) {
      const gate = entry?.gate ? String(entry.gate) : null;
      if (gate) {
        if (!gates[gate]) gates[gate] = emptyGateStat(gate, false);
        gates[gate].evidence_counts.telemetry_events += 1;
        addExample(gates[gate].source_examples, source);
      }
    }
  }
}

function sourceInventory(plansDir) {
  const files = walkFiles(plansDir);
  const dirs = walkDirs(plansDir);
  const decisionLogFiles = files.filter((file) => basename(file) === "decision_log.jsonl");
  const telemetryFiles = files.filter((file) => file.replace(/\\/g, "/").endsWith("/telemetry/events.jsonl"));
  const stateFiles = files.filter((file) => basename(file) === "state.json");
  const allPlanDirs = dirs.filter((dir) => basename(dir).startsWith("plan_"));
  return {
    files,
    dirs,
    decisionLogFiles,
    telemetryFiles,
    stateFiles,
    topLevelPlanDirs: listTopLevelPlanDirs(plansDir),
    allPlanDirs,
  };
}

function censusDispositionForSeverity(severity) {
  return ["warn", "warning", "advisory"].includes(String(severity || "").toLowerCase()) ? "DEMOTE" : "KEEP";
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function parseChecklistItems(text) {
  const rows = [];
  let current = null;
  const flush = () => {
    if (current?.id) rows.push(current);
    current = null;
  };
  for (const [index, line] of String(text || "").split("\n").entries()) {
    const id = line.match(/^\s*-\s+id:\s*["']?([^"']+?)["']?\s*$/);
    if (id) {
      flush();
      current = { id: id[1].trim(), line: index + 1, check: null, severity: null, description: null };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s+(check|severity|description):\s*["']?(.*?)["']?\s*$/);
    if (field) current[field[1]] = field[2].trim();
  }
  flush();
  return rows;
}

function buildStaticCheckCensus({ observedChecks = [] } = {}) {
  const registryDocument = readJson(FAILURE_CODES_CONFIG_PATH) || {};
  const registry = registryDocument.codes && typeof registryDocument.codes === "object" ? registryDocument.codes : {};
  const observedById = new Map(observedChecks.map((row) => [row.id, row]));
  const rows = [];
  const sourceCounts = {};
  const add = (row) => {
    rows.push(row);
    bump(sourceCounts, row.surface);
  };

  for (const [code, entry] of Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))) {
    const observed = observedById.get(code) || null;
    const disposition = censusDispositionForSeverity(entry?.severity);
    add({
      id: `registry:${code}`,
      surface: "failure_code_registry",
      source: rel(REPO_ROOT, FAILURE_CODES_CONFIG_PATH),
      line: null,
      gate: entry?.gate || null,
      check: entry?.check || null,
      failure_code: code,
      runtime_class: disposition === "KEEP" ? "hard" : "advisory",
      disposition,
      why: disposition === "KEEP"
        ? "Semantic, proof-integrity, runtime-integrity, or shared-surface guard remains blocking."
        : (entry?.classification_reason || "Structural or ritual miss remains visible but non-blocking."),
      historical_evidence: observed ? {
        fail: observed.fail,
        warn: observed.warn,
        pass: observed.pass,
        self_cleared: observed.self_cleared,
        gates: observed.gates,
        sources: observed.sources,
      } : { fail: 0, warn: 0, pass: 0, self_cleared: 0, gates: [], sources: [] },
    });
  }

  for (const path of walkFiles(CHECKLISTS_DIR).filter((file) => /\.ya?ml$/i.test(file))) {
    const text = readFileSync(path, "utf-8");
    for (const item of parseChecklistItems(text)) {
      const hard = item.check === "json_field_equals" || item.check === "command_succeeds";
      add({
        id: `checklist:${rel(SKILL_ROOT, path)}:${item.id}`,
        surface: "yaml_checklist",
        source: rel(REPO_ROOT, path),
        line: item.line,
        gate: basename(path).replace(/\.ya?ml$/i, ""),
        check: item.id,
        failure_code: item.check === "command_succeeds" ? "GATE-CHK-008" : item.check === "json_field_equals" ? "GATE-CHK-011" : "GATE-CHK-001",
        runtime_class: hard ? "hard" : "advisory",
        disposition: hard ? "KEEP" : "DEMOTE",
        why: hard
          ? "The checklist item exercises a proof command or reads a structured semantic signal."
          : "The checklist item checks document shape or presence and is guide-first advisory.",
        historical_evidence: null,
      });
    }
  }

  for (const path of walkFiles(SCRIPTS_DIR).filter((file) => file.endsWith(".mjs"))) {
    const text = readFileSync(path, "utf-8");
    const regex = /\bcheck\s*\(\s*(?:`([^`\n]*)`|"([^"\n]*)"|'([^'\n]*)'|([^,\n]+))/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const snippet = text.slice(Math.max(0, match.index - 80), Math.min(text.length, match.index + 700));
      const codeMatch = snippet.match(/,\s*["'](GATE-[A-Z0-9-]+)["']\s*\)/);
      const code = codeMatch?.[1] || null;
      const entry = code ? registry[code] : null;
      const disposition = code ? censusDispositionForSeverity(entry?.severity) : "KEEP";
      const line = lineNumberAt(text, match.index);
      add({
        id: `js:${rel(SKILL_ROOT, path)}:${line}`,
        surface: "javascript_check",
        source: rel(REPO_ROOT, path),
        line,
        gate: entry?.gate || null,
        check: (match[1] || match[2] || match[3] || match[4] || "dynamic check").trim().slice(0, 160),
        failure_code: code,
        runtime_class: code ? (disposition === "KEEP" ? "hard" : "advisory") : "contract_enforced",
        disposition,
        why: code
          ? (disposition === "KEEP" ? "Coded runtime check retains hard semantic/proof/shared-surface enforcement." : "Coded runtime check is visible advisory guidance.")
          : "Any uncoded FAIL is converted into the single hard GATE-CONTRACT-001 defect at runtime.",
        historical_evidence: code && observedById.has(code) ? observedById.get(code) : null,
      });
    }
  }

  for (const path of walkFiles(PROLOG_DIR).filter((file) => file.endsWith(".pl"))) {
    const text = readFileSync(path, "utf-8");
    const regex = /^\s*(can_transition|invariant_violated|invariant_warning)\s*\(([^,\n)]+)/gm;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const warning = match[1] === "invariant_warning";
      add({
        id: `prolog:${rel(SKILL_ROOT, path)}:${lineNumberAt(text, match.index)}`,
        surface: "prolog_guard",
        source: rel(REPO_ROOT, path),
        line: lineNumberAt(text, match.index),
        gate: match[1] === "can_transition" ? String(match[2]).trim() : "ontology-invariants",
        check: `${match[1]}(${String(match[2]).trim()})`,
        failure_code: warning ? null : "GATE-SEM-002",
        runtime_class: warning ? "advisory" : "hard",
        disposition: warning ? "DEMOTE" : "KEEP",
        why: warning
          ? "Prolog warning stays visible without blocking advancement."
          : "Prolog transition/invariant guard protects semantic or proof correctness.",
        historical_evidence: warning ? null : (observedById.get("GATE-SEM-002") || null),
      });
    }
  }

  const gateDocument = readJson(GATES_CONFIG_PATH) || {};
  for (const [gate, entry] of Object.entries(gateDocument.gates || {}).sort(([a], [b]) => a.localeCompare(b))) {
    add({
      id: `gate-metadata:${gate}`,
      surface: "gate_registry_metadata",
      source: rel(REPO_ROOT, GATES_CONFIG_PATH),
      line: null,
      gate,
      check: `${entry.from}->${entry.to || "audit-only"}`,
      failure_code: entry.failure_code_prefix || null,
      runtime_class: "hard_boundary",
      disposition: "KEEP",
      why: "The gate boundary defines state authority; its internal structural checks may be advisory without deleting the state transition itself.",
      historical_evidence: null,
    });
  }

  const dispositions = { KEEP: 0, DEMOTE: 0, DELETE: 0 };
  for (const row of rows) dispositions[row.disposition] += 1;
  return {
    complete: true,
    generated_from: [
      rel(REPO_ROOT, GATES_CONFIG_PATH),
      rel(REPO_ROOT, FAILURE_CODES_CONFIG_PATH),
      rel(REPO_ROOT, CHECKLISTS_DIR),
      rel(REPO_ROOT, SCRIPTS_DIR),
      rel(REPO_ROOT, PROLOG_DIR),
    ],
    row_count: rows.length,
    source_counts: sourceCounts,
    dispositions,
    uncoded_javascript_check_sites: rows.filter((row) => row.surface === "javascript_check" && !row.failure_code).length,
    rows,
  };
}

export function buildGateSurvivalReport({
  cwd = process.cwd(),
  plansDir = DEFAULT_PLANS_DIR,
  windowSec = SELF_CLEAR_WINDOW_SEC_DEFAULT,
} = {}) {
  const root = resolve(cwd);
  const configuredGates = loadConfiguredGates();
  const configuredNames = configuredGates.map((gate) => gate.name);
  const gates = {};
  for (const name of configuredNames) gates[name] = emptyGateStat(name, true);

  const checks = new Map();
  const inventory = sourceInventory(plansDir);
  const malformedDecisionRows = inventory.decisionLogFiles
    .map((file) => readJsonl(file).malformed)
    .reduce((sum, count) => sum + count, 0);
  const malformedTelemetryRows = inventory.telemetryFiles
    .map((file) => readJsonl(file).malformed)
    .reduce((sum, count) => sum + count, 0);

  updateProgressFromDecisionLogs({
    decisionLogFiles: inventory.decisionLogFiles,
    root,
    gates,
    checks,
    windowMs: windowSec * 1000,
  });
  updateProgressFromStates({ stateFiles: inventory.stateFiles, configuredGates, root, gates, checks });
  updateProgressFromTelemetry({ telemetryFiles: inventory.telemetryFiles, root, gates });

  const finalizedGates = finalizeGateStats(gates);
  const checkRows = finalizeChecks(checks);
  const gateRows = Object.values(finalizedGates).sort((a, b) =>
    (CLASS_ORDER[a.classification] - CLASS_ORDER[b.classification]) ||
    (b.blocked - a.blocked) ||
    a.gate.localeCompare(b.gate)
  );
  const gateCandidateSummary = summarizeCandidates(gateRows);
  const checkCandidateSummary = summarizeCandidates(checkRows);
  const staticCheckCensus = buildStaticCheckCensus({ observedChecks: checkRows });

  const summary = {
    configured_gate_count: configuredNames.length,
    configured_gates_covered: configuredNames.every((name) => Boolean(finalizedGates[name])),
    configured_gates_missing: configuredNames.filter((name) => !finalizedGates[name]),
    legacy_gate_count: gateRows.filter((row) => !row.configured).length,
    gate_classifications: summarizeClassification(gateRows),
    check_classifications: summarizeClassification(checkRows),
    candidate_actionability: {
      actionable: (gateCandidateSummary.actionability.actionable || 0) + (checkCandidateSummary.actionability.actionable || 0),
      review_only: (gateCandidateSummary.actionability.review_only || 0) + (checkCandidateSummary.actionability.review_only || 0),
      non_actionable: (gateCandidateSummary.actionability.non_actionable || 0) + (checkCandidateSummary.actionability.non_actionable || 0),
      not_candidate: (gateCandidateSummary.actionability.not_candidate || 0) + (checkCandidateSummary.actionability.not_candidate || 0),
    },
    gate_candidate_actionability: gateCandidateSummary.actionability,
    check_candidate_actionability: checkCandidateSummary.actionability,
    candidate_dispositions: addCountObjects(gateCandidateSummary.dispositions, checkCandidateSummary.dispositions),
    gate_actionable_candidate_counts: gateCandidateSummary.classifications.actionable,
    check_actionable_candidate_counts: checkCandidateSummary.classifications.actionable,
    actionable_candidate_counts: addClassificationCounts(
      gateCandidateSummary.classifications.actionable,
      checkCandidateSummary.classifications.actionable
    ),
    review_only_candidate_counts: addClassificationCounts(
      gateCandidateSummary.classifications.review_only,
      checkCandidateSummary.classifications.review_only
    ),
    non_actionable_candidate_counts: addClassificationCounts(
      gateCandidateSummary.classifications.non_actionable,
      checkCandidateSummary.classifications.non_actionable
    ),
    total_decision_log_attempts: gateRows.reduce((sum, row) => sum + row.evidence_counts.decision_log_attempts, 0),
    total_blocked: gateRows.reduce((sum, row) => sum + row.blocked, 0),
    total_allowed: gateRows.reduce((sum, row) => sum + row.allowed, 0),
    total_bounce_loops: gateRows.reduce((sum, row) => sum + row.bounce_loops, 0),
    total_self_clearing_unblocks: gateRows.reduce((sum, row) => sum + row.self_clearing_unblocks, 0),
    static_census_rows: staticCheckCensus.row_count,
    static_census_dispositions: staticCheckCensus.dispositions,
  };

  return {
    schema_version: SCHEMA_VERSION,
    program_id: "PGM-IVE-AUTOCODER-V2",
    ticket_id: "E2-4",
    report_kind: "gate_survival",
    self_clear_window_sec: windowSec,
    corpus: {
      plans_dir: rel(root, plansDir),
      top_level_plan_dirs: inventory.topLevelPlanDirs.length,
      all_plan_dirs_including_archive: inventory.allPlanDirs.length,
      decision_log_files: inventory.decisionLogFiles.length,
      telemetry_event_files: inventory.telemetryFiles.length,
      state_files: inventory.stateFiles.length,
      malformed_decision_log_rows: malformedDecisionRows,
      malformed_telemetry_rows: malformedTelemetryRows,
      configured_gates: configuredNames,
      stale_seed_note: "The program seed says 341 plans; this report records measured current-checkout source counts instead.",
    },
    assumptions: [
      "Decision logs are the primary transition-outcome source.",
      "State snapshots and telemetry streams corroborate source coverage and failure-code presence.",
      "A BLOCKED->ALLOWED streak inside the self-clear window is heuristic evidence of artifact edit-until-green behavior, not proof.",
      "A never-failing check is a deletion candidate only when it is not a known guard or false-red class.",
    ],
    strongest_counterargument: "Historical logs do not prove whether an operator changed source code, plan prose, or only gate artifacts between FAIL and PASS.",
    e8_usage: "E8 deletion tickets should cite the gate_survival.json gate/check row they delete or demote.",
    known_false_red_classes: KNOWN_FALSE_RED_CLASSES,
    summary,
    gates: finalizedGates,
    gate_rankings: gateRows.map((row) => ({
      gate: row.gate,
      configured: row.configured,
      classification: row.classification,
      candidate_disposition: row.candidate_disposition,
      candidate_actionability: row.candidate_actionability,
      blocked: row.blocked,
      allowed: row.allowed,
      self_clear_rate: row.self_clear_rate,
      bounce_loops: row.bounce_loops,
      top_failure_codes: row.top_failure_codes,
      rationale: row.rationale,
    })),
    checks: checkRows,
    check_rankings: checkRows.slice(0, 60).map((row) => ({
      id: row.id,
      label: row.label,
      classification: row.classification,
      candidate_disposition: row.candidate_disposition,
      candidate_actionability: row.candidate_actionability,
      nature: row.nature,
      fail: row.fail,
      pass: row.pass,
      warn: row.warn,
      self_clear_rate: row.self_clear_rate,
      gates: row.gates,
      known_false_red_classes: row.known_false_red_classes,
      rationale: row.rationale,
    })),
    static_check_census: staticCheckCensus,
  };
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(headers, rows) {
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# Gate Survival Analysis");
  lines.push("");
  lines.push(`Program: ${report.program_id}`);
  lines.push(`Ticket: ${report.ticket_id}`);
  lines.push(`Self-clear window: ${report.self_clear_window_sec}s`);
  lines.push("");
  lines.push("## Corpus Provenance");
  lines.push("");
  lines.push(table(
    ["Source", "Count"],
    [
      ["Top-level plan dirs", report.corpus.top_level_plan_dirs],
      ["All plan dirs including archive", report.corpus.all_plan_dirs_including_archive],
      ["Decision logs", report.corpus.decision_log_files],
      ["Telemetry event files", report.corpus.telemetry_event_files],
      ["State snapshots", report.corpus.state_files],
      ["Malformed decision rows", report.corpus.malformed_decision_log_rows],
      ["Malformed telemetry rows", report.corpus.malformed_telemetry_rows],
    ]
  ));
  lines.push("");
  lines.push(`Seed note: ${report.corpus.stale_seed_note}`);
  lines.push("");
  lines.push("## Assumptions And Boundary");
  lines.push("");
  for (const item of report.assumptions) lines.push(`- ${item}`);
  lines.push(`- Strongest counterargument: ${report.strongest_counterargument}`);
  lines.push(`- E8 citation rule: ${report.e8_usage}`);
  lines.push("");
  lines.push("## Candidate Actionability Summary");
  lines.push("");
  lines.push(table(
    ["Metric", "KEEP", "DEMOTE", "DELETE"],
    [
      ["Raw gate classifications", report.summary.gate_classifications.KEEP, report.summary.gate_classifications.DEMOTE, report.summary.gate_classifications.DELETE],
      ["Raw check classifications", report.summary.check_classifications.KEEP, report.summary.check_classifications.DEMOTE, report.summary.check_classifications.DELETE],
      ["Actionable candidates", report.summary.actionable_candidate_counts.KEEP, report.summary.actionable_candidate_counts.DEMOTE, report.summary.actionable_candidate_counts.DELETE],
      ["Review-only candidates", report.summary.review_only_candidate_counts.KEEP, report.summary.review_only_candidate_counts.DEMOTE, report.summary.review_only_candidate_counts.DELETE],
      ["Non-actionable candidates", report.summary.non_actionable_candidate_counts.KEEP, report.summary.non_actionable_candidate_counts.DEMOTE, report.summary.non_actionable_candidate_counts.DELETE],
    ]
  ));
  lines.push("");
  lines.push("## Complete Static Check Census");
  lines.push("");
  lines.push(table(
    ["Metric", "Value"],
    [
      ["Census complete", report.static_check_census.complete ? "yes" : "no"],
      ["Total rows", report.static_check_census.row_count],
      ["Gate metadata rows", report.static_check_census.source_counts.gate_registry_metadata || 0],
      ["Failure-code rows", report.static_check_census.source_counts.failure_code_registry || 0],
      ["YAML checklist rows", report.static_check_census.source_counts.yaml_checklist || 0],
      ["JavaScript check rows", report.static_check_census.source_counts.javascript_check || 0],
      ["Prolog guard rows", report.static_check_census.source_counts.prolog_guard || 0],
      ["KEEP", report.static_check_census.dispositions.KEEP],
      ["DEMOTE", report.static_check_census.dispositions.DEMOTE],
      ["DELETE", report.static_check_census.dispositions.DELETE],
      ["Uncoded JS check sites", report.static_check_census.uncoded_javascript_check_sites],
    ]
  ));
  lines.push("");
  lines.push("The complete row-level KEEP/DEMOTE/DELETE census, including source locations and historical evidence, is persisted in `gate_survival.json#static_check_census.rows`.");
  lines.push("");
  lines.push("## Gate Rankings");
  lines.push("");
  lines.push(table(
    ["Gate", "Configured", "Class", "Actionability", "Disposition", "Blocked", "Allowed", "Self-clear", "Loops", "Top codes", "Rationale"],
    report.gate_rankings.map((row) => [
      row.gate,
      row.configured ? "yes" : "legacy",
      row.classification,
      row.candidate_actionability,
      row.candidate_disposition,
      row.blocked,
      row.allowed,
      row.self_clear_rate,
      row.bounce_loops,
      row.top_failure_codes.map((code) => `${code.code}:${code.count}`).join(", "),
      row.rationale.join("; "),
    ])
  ));
  lines.push("");
  lines.push("## Check Recommendations");
  lines.push("");
  lines.push(table(
    ["Check", "Class", "Actionability", "Disposition", "Nature", "Fail", "Pass", "Warn", "Self-clear", "Gates", "Known false-red", "Rationale"],
    report.check_rankings.slice(0, 40).map((row) => [
      row.id,
      row.classification,
      row.candidate_actionability,
      row.candidate_disposition,
      row.nature,
      row.fail,
      row.pass,
      row.warn,
      row.self_clear_rate,
      row.gates.join(", "),
      row.known_false_red_classes.join(", "),
      row.rationale.join("; "),
    ])
  ));
  lines.push("");
  lines.push("## Known False-Red Classes");
  lines.push("");
  lines.push(table(
    ["Class", "Codes", "Gate", "Disposition", "Description"],
    report.known_false_red_classes.map((row) => [
      row.id,
      row.codes.join(", "),
      row.gate,
      row.disposition,
      row.description,
    ])
  ));
  lines.push("");
  lines.push("## Summary Counts");
  lines.push("");
  lines.push(table(
    ["Metric", "Value"],
    [
      ["Configured gates covered", report.summary.configured_gates_covered ? "yes" : "no"],
      ["Legacy gates", report.summary.legacy_gate_count],
      ["Gate KEEP", report.summary.gate_classifications.KEEP],
      ["Gate DEMOTE", report.summary.gate_classifications.DEMOTE],
      ["Gate DELETE", report.summary.gate_classifications.DELETE],
      ["Check KEEP", report.summary.check_classifications.KEEP],
      ["Check DEMOTE", report.summary.check_classifications.DEMOTE],
      ["Check DELETE", report.summary.check_classifications.DELETE],
      ["Actionable DEMOTE", report.summary.actionable_candidate_counts.DEMOTE],
      ["Actionable DELETE", report.summary.actionable_candidate_counts.DELETE],
      ["Review-only DELETE", report.summary.review_only_candidate_counts.DELETE],
      ["Non-actionable DELETE", report.summary.non_actionable_candidate_counts.DELETE],
      ["Decision attempts", report.summary.total_decision_log_attempts],
      ["Blocked", report.summary.total_blocked],
      ["Allowed", report.summary.total_allowed],
      ["Bounce loops", report.summary.total_bounce_loops],
      ["Self-clearing unblocks", report.summary.total_self_clearing_unblocks],
    ]
  ));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeReports(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "gate_survival.json");
  const markdownPath = join(outDir, "gate_survival.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
  return { jsonPath, markdownPath };
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  const report = buildGateSurvivalReport({
    cwd: opts.cwd,
    plansDir: opts.plansDir,
    windowSec: opts.windowSec,
  });
  let written = null;
  if (opts.write) {
    const paths = writeReports(report, opts.outDir);
    written = {
      json: rel(opts.cwd, paths.jsonPath),
      markdown: rel(opts.cwd, paths.markdownPath),
    };
  }
  const payload = written ? { ...report, written } : report;
  if (opts.json) emitJson(payload);
  else if (opts.write) console.log(`Wrote gate survival report to ${written.json} and ${written.markdown}`);
  else console.log(renderMarkdown(report));
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
