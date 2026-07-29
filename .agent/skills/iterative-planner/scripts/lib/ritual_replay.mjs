// ritual_replay.mjs — current-code ritual quality replay over real telemetry.
//
// This is intentionally different from behavior_report.mjs. behavior_report scans
// all stored plan state as cumulative history; this runner reinterprets committed
// real gate-transition telemetry through today's deterministic taxonomy.

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { gateFailureNature, targetHotspotRepairRows } from "./behavior_report.mjs";
import { findingsFromRitualReplayReport } from "./deterministic_findings.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SCRIPTS_DIR = resolve(LIB_DIR, "..");
const SKILL_ROOT = resolve(SCRIPTS_DIR, "..");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");

export const RITUAL_REPLAY_SCHEMA_VERSION = 1;
export const DEFAULT_FIXTURES_DIR = join(SKILL_ROOT, "tests", "fixtures", "real_telemetry");
// Fixture corpus is auto-discovered from DEFAULT_FIXTURES_DIR. Expected categories include:
//   - code-heavy projects (crawler-extractor, tesseract, portable-agent-kit, ...)
//   - scientific/quant projects (evolution-trading, trueskill-tennis, TokenLab, ...)
//   - lightweight content projects (content_marketing_site.jsonl — markdown/config only, no backend/orchestration/recipe surfaces)
export const DEFAULT_RETIRED_GATES = Object.freeze(["GATE-TMP-002", "GATE-PLN-010"]);
export const DEFAULT_MAX_CURRENT_RITUAL_TRANSITION_RATE_PCT = 7;
export const DEFAULT_TARGET_CURRENT_RITUAL_TRANSITION_RATE_PCT = 7;
export const DEFAULT_MAX_CURRENT_UNKNOWN_TRANSITION_RATE_PCT = 1;
export const DEFAULT_MIN_FIXTURE_COUNT = 20;
export const DEFAULT_MIN_TRANSITION_COUNT = 100;
export const DEFAULT_MIN_PORTABLE_AGENT_KIT_TRANSITION_COUNT = 50;
export const CURRENT_SOFTENED_POLICY_VERSION = "2026-06-24.T-INTAKE-291DF645.T-INTAKE-98723175";
export const CURRENT_SUPPRESSED_POLICY_VERSION = "2026-06-24.T-INTAKE-484F9D5B";

const UNCODED_FAIL = "__uncoded_fail__";
const RITUAL_NATURES = new Set(["ceremony", "hybrid"]);
const TEXT_EXTENSIONS = new Set([".mjs", ".js", ".json", ".pl", ".md"]);

const CURRENT_SUPPRESSED_FAILURE_POLICIES = Object.freeze({
  "GATE-EXP-015": Object.freeze({
    source: "legacy_inference",
    reason: "legacy_assumption_ledger_inference_not_emitted_by_current_explore_gate",
  }),
  "GATE-EXP-016": Object.freeze({
    source: "legacy_inference",
    reason: "legacy_diagnostic_structure_inference_not_emitted_by_current_explore_gate",
  }),
  "GATE-TRC-002": Object.freeze({
    requires_unsupported_trace: true,
    reason: "trace_kb_read_coverage_is_advisory_when_trace_capture_is_unavailable",
  }),
  "GATE-TRC-006": Object.freeze({
    requires_unsupported_trace: true,
    reason: "trace_own_findings_proof_is_advisory_when_trace_capture_is_unavailable",
  }),
  "GATE-TRC-007": Object.freeze({
    requires_unsupported_trace: true,
    reason: "trace_verification_read_proof_is_advisory_when_trace_capture_is_unavailable",
  }),
  "GATE-TRC-009": Object.freeze({
    reason: "ide_trace_support_warning_is_advisory_for_current_replay",
  }),
  "GATE-PRS-001": Object.freeze({
    source: "legacy_inference",
    reason: "legacy_persona_audit_warning_is_advisory_below_current_fail_threshold",
  }),
  "GATE-PRS-TRACE": Object.freeze({
    source: "legacy_inference",
    reason: "legacy_traceability_persona_warning_is_advisory_below_current_fail_threshold",
  }),
});

const CURRENT_SOFTENED_FAILURE_POLICIES = Object.freeze({
  "GATE-PLN-017": Object.freeze({
    fixtures: ["crawler_extractor_GATE-VAL-015.jsonl"],
    projects: ["crawler_extractor_agent", "crawler_extractor"],
    reason: "crawler_extractor_non_boundary_false_positive_after_pln017_trigger_precision_tightening",
  }),
  "GATE-PLN-021": Object.freeze({
    name_includes: ["Plan references KB learnings"],
    reason: "legacy_unconditional_kb_marker_check_superseded_by_hit_sensitive_pln021",
  }),
});

const LEGACY_PERSONA_CODE_PREFIXES = Object.freeze([
  ["[[traceability]", "GATE-PRS-TRACE"],
  ["[[wiring_auditor]", "GATE-PRS-WIR"],
  ["[[tokenomics]", "GATE-PRS-TOK"],
  ["[[quant_target]", "GATE-PRS-QT"],
  ["[[quant_research_protocol]", "GATE-PRS-QRP"],
  ["[[quant]", "GATE-PRS-QUANT"],
  ["[[ux_ui]", "GATE-PRS-UX"],
]);

const DEFAULT_ACTIVE_SOURCE_PATHS = Object.freeze([
  ".agent/skills/iterative-planner/scripts/transition.mjs",
  ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
  ".agent/skills/iterative-planner/scripts/bootstrap.mjs",
  ".agent/skills/iterative-planner/scripts/lib",
  ".agent/skills/iterative-planner/config",
  ".agent/skills/iterative-planner/prolog",
  ".agent/skills/iterative-planner/checklists",
  ".agent/workflows",
]);

const DEFAULT_HISTORICAL_REFERENCE_FILES = Object.freeze([
  ".agent/skills/iterative-planner/scripts/lib/behavior_report.mjs",
  ".agent/skills/iterative-planner/scripts/lib/ritual_replay.mjs",
  ".agent/skills/iterative-planner/scripts/ritual_replay.mjs",
  ".agent/skills/iterative-planner/scripts/lib/scoreboard.mjs",
  ".agent/skills/iterative-planner/scripts/scoreboard.mjs",
  ".agent/skills/iterative-planner/scripts/behavior_report.mjs",
  ".agent/skills/iterative-planner/scripts/gate_survival.mjs",
  ".agent/skills/iterative-planner/scripts/replay_telemetry.mjs",
  ".agent/skills/iterative-planner/scripts/real_telemetry_false_reds.mjs",
  ".agent/skills/iterative-planner/scripts/harvest_real_telemetry.mjs",
  ".agent/skills/iterative-planner/config/failure-codes.json",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((Number(numerator) * 100) / Number(denominator)).toFixed(1));
}

function emptyCounter() {
  return Object.create(null);
}

function bump(counter, key, amount = 1) {
  const normalized = key || "unknown";
  counter[normalized] = (counter[normalized] || 0) + amount;
}

function sortedObject(counter) {
  return Object.fromEntries(Object.entries(counter || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function rel(path, root = REPO_ROOT) {
  return relative(root, resolve(path)).split("\\").join("/");
}

function normalizeProjectId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown";
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function inferProjectFromFixture(fileName) {
  const stem = basename(fileName, extname(fileName));
  const withoutGate = stem.replace(/_GATE-[A-Z0-9-]+$/i, "");
  return normalizeProjectId(withoutGate);
}

function parseJsonLine(line, filePath, lineNumber) {
  try {
    return { ok: true, value: JSON.parse(line), error: null };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: {
        file: rel(filePath),
        line: lineNumber,
        message: error.message,
      },
    };
  }
}

export function parseTelemetryFixture(filePath) {
  const text = readFileSync(filePath, "utf-8");
  const entries = [];
  const parseErrors = [];
  let provenance = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const parsed = parseJsonLine(line, filePath, index + 1);
    if (!parsed.ok) {
      parseErrors.push(parsed.error);
      continue;
    }
    if (!provenance && parsed.value?.type === "harvest_provenance") provenance = parsed.value;
    entries.push(parsed.value);
  }
  const transitions = entries.filter((entry) => entry?.type === "gate_transition");
  const sourceProject = normalizeProjectId(provenance?.source_project || inferProjectFromFixture(filePath));
  return {
    path: filePath,
    fixture: basename(filePath),
    provenance,
    source_project: sourceProject,
    entries,
    transitions,
    parse_errors: parseErrors,
  };
}

function listFixtureFiles(fixturesDir) {
  if (!existsSync(fixturesDir)) return [];
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(fixturesDir, entry.name))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

function normalizeFailureCode(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueFailureCodes(values) {
  return [...new Set(asArray(values).map(normalizeFailureCode).filter(Boolean))];
}

function failedCheckRows(transition) {
  return asArray(transition?.checks)
    .filter((check) => String(check?.status || "").toUpperCase() === "FAIL");
}

function legacyPersonaFailureCode(name) {
  const normalized = String(name || "").trim();
  for (const [prefix, code] of LEGACY_PERSONA_CODE_PREFIXES) {
    if (normalized.startsWith(prefix)) return code;
  }
  return null;
}

function inferLegacyFailureCode(_transition, check) {
  const name = String(check?.name || "").trim();
  const detail = String(check?.detail || "").trim();
  const personaCode = legacyPersonaFailureCode(name);
  if (personaCode) return personaCode;
  if (name === "Persona audit findings") return "GATE-PRS-001";
  if (name === "Story invariants") return "GATE-SEM-002";
  if (name === "Prolog/JS divergence (M4-FIX)") return "GATE-SEM-003";
  if (name === "Prolog/JS divergence (RT5-M1)" || name === "Prolog/JS diagnostic (RT5-M1)") return "GATE-SEM-004";
  if (name.startsWith("Semantic: ")) return "GATE-SEM-001";
  if (/assumption probe|assumption ledger/i.test(`${name} ${detail}`)) return "GATE-EXP-015";
  if (/findings|root cause|adjacency/i.test(`${name} ${detail}`)) return "GATE-EXP-016";
  if (/Plan references KB learnings/i.test(name)) return "GATE-PLN-021";
  if (/Current state matches gate source/i.test(name)) return "GATE-SRC-001";
  if (/FAIL-level finding/i.test(name)) return "GATE-HLT-002";
  if (/Checklist/i.test(name)) return "GATE-CHK-009";
  if (/^Success criteria section exists in plan\.md$/i.test(name)) return "GATE-PLN-005";
  if (/^Red-team notes contain actual analysis \(not empty\)$/i.test(name)) return "GATE-ETR-002";
  if (/^Mitigations documented for attack vectors(?: \(mandatory\))?$/i.test(name)) return "GATE-ETR-004";
  if (/^Prolog rule engine self-test passes/i.test(name)) return "GATE-CHK-008";
  if (/^@planner: annotations are valid/i.test(name)) return "GATE-CHK-008";
  if (/^Structured close signal confirms all progress items are complete before VALIDATE$/i.test(name)) return "GATE-REF-003";
  if (/^Structured close signal confirms task-relevant semantic substrate gaps are resolved before VALIDATE$/i.test(name)) return "GATE-REF-016";
  if (/^Verification is not still template$/i.test(name)) return "GATE-VAL-001";
  if (/Structured close signal confirms code changes have test evidence/i.test(name)) return "GATE-VAL-011";
  if (/Structured close signal confirms planner-core self-proof/i.test(name)) return "GATE-VAL-010";
  if (/Structured close signal confirms semantic\/KB upkeep/i.test(name)) return "GATE-REF-016";
  if (/Structured close signal confirms remediation-style work records an anti-recurrence guard/i.test(name)) return "GATE-VAL-013";
  if (/Structured close signal confirms quant\/model\/betting result claims/i.test(name)) return "GATE-REF-017";
  return null;
}

function failureRecord(code, check, source) {
  return {
    code,
    name: check?.name || null,
    nature: gateFailureNature(code),
    source,
  };
}

function failedChecks(transition) {
  const failedRows = failedCheckRows(transition);
  const uncodedRows = [];
  const records = [];
  const explicitCodes = new Set();
  const recordCodes = new Set();

  for (const check of failedRows) {
    const code = normalizeFailureCode(check?.code);
    if (!code) {
      uncodedRows.push(check);
      continue;
    }
    explicitCodes.add(code);
    recordCodes.add(code);
    records.push(failureRecord(code, check, "check.code"));
  }

  let addedTransitionFallback = false;
  if (uncodedRows.length > 0) {
    for (const code of uniqueFailureCodes(transition?.failure_codes)) {
      if (explicitCodes.has(code) || recordCodes.has(code)) continue;
      recordCodes.add(code);
      addedTransitionFallback = true;
      records.push(failureRecord(code, { name: "transition.failure_codes" }, "transition.failure_codes"));
    }
  }

  for (const check of uncodedRows) {
    const inferredCode = inferLegacyFailureCode(transition, check);
    if (inferredCode) {
      if (!recordCodes.has(inferredCode)) {
        recordCodes.add(inferredCode);
        records.push(failureRecord(inferredCode, check, "legacy_inference"));
      }
      continue;
    }
    if (!addedTransitionFallback) {
      records.push(failureRecord(UNCODED_FAIL, check, "unresolved"));
    }
  }

  return records;
}

function transitionHasUnsupportedTraceCapture(transition) {
  return asArray(transition?.checks).some((check) => {
    const name = String(check?.name || "");
    const detail = String(check?.detail || "");
    const code = String(check?.code || "");
    const status = normalizeVerificationStatus(check?.status, "gate");
    if (code !== "GATE-TRC-009" && !/IDE trace support/i.test(name)) return false;
    if (!status.valid || status.token === "UNKNOWN" || (status.kind !== "pending" && status.kind !== "fail")) return false;
    return /unsupported|cannot capture|does not support|not found|no supported|requires Claude Code|PostToolUse/i.test(`${name} ${detail}`);
  });
}

function softenedFailurePolicy(failure, transition, context = {}) {
  const policy = CURRENT_SOFTENED_FAILURE_POLICIES[failure?.code];
  if (!policy) return null;
  if (policy.source && failure.source !== policy.source) return null;
  if (policy.requires_unsupported_trace && !transitionHasUnsupportedTraceCapture(transition)) return null;
  if (Array.isArray(policy.fixtures) && !policy.fixtures.includes(context.fixture)) return null;
  if (Array.isArray(policy.projects) && !policy.projects.includes(context.source_project)) return null;
  if (Array.isArray(policy.name_includes)) {
    const name = String(failure?.name || "");
    if (!policy.name_includes.some((needle) => name.includes(needle))) return null;
  }
  return {
    code: failure.code,
    source: failure.source,
    reason: policy.reason,
  };
}

function suppressedFailurePolicy(failure, transition, context = {}) {
  const policy = CURRENT_SUPPRESSED_FAILURE_POLICIES[failure?.code];
  if (!policy) return null;
  if (policy.source && failure.source !== policy.source) return null;
  if (policy.requires_unsupported_trace && !transitionHasUnsupportedTraceCapture(transition)) return null;
  if (Array.isArray(policy.fixtures) && !policy.fixtures.includes(context.fixture)) return null;
  if (Array.isArray(policy.projects) && !policy.projects.includes(context.source_project)) return null;
  return {
    code: failure.code,
    source: failure.source,
    reason: policy.reason,
  };
}

function classifyActiveTransition(failures, retiredGateSet, transition = null, context = {}) {
  const retiredFailures = failures.filter((failure) => retiredGateSet.has(failure.code));
  const nonRetiredFailures = failures.filter((failure) => !retiredGateSet.has(failure.code));
  const suppressedFailures = [];
  const softenedFailures = [];
  const activeFailures = [];
  for (const failure of nonRetiredFailures) {
    const suppressedPolicy = suppressedFailurePolicy(failure, transition, context);
    if (suppressedPolicy) {
      suppressedFailures.push({ ...failure, suppressed_policy: suppressedPolicy });
      continue;
    }
    const policy = softenedFailurePolicy(failure, transition, context);
    if (policy) {
      softenedFailures.push({ ...failure, softened_policy: policy });
    } else {
      activeFailures.push(failure);
    }
  }
  const natures = new Set(activeFailures.map((failure) => failure.nature));
  const activeBlocked = activeFailures.length > 0;
  const hasSubstantive = natures.has("substantive");
  const hasRitualNature = [...natures].some((nature) => RITUAL_NATURES.has(nature));
  return {
    retiredFailures,
    suppressedFailures,
    softenedFailures,
    activeFailures,
    activeBlocked,
    ritualCoded: activeBlocked && hasRitualNature && !hasSubstantive,
    substantiveCoded: activeBlocked && hasSubstantive,
    mixedCoded: activeBlocked && hasSubstantive && hasRitualNature,
  };
}

function collectSourceFiles(root, relativePath) {
  const start = resolve(root, relativePath);
  if (!existsSync(start)) return [];
  const stat = statSync(start);
  if (stat.isFile()) return [start];
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    const child = join(start, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "fixtures", "reports"].includes(entry.name)) continue;
      files.push(...collectSourceFiles(root, rel(child, root)));
      continue;
    }
    if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) files.push(child);
  }
  return files;
}

function defaultAllowlist(root) {
  return new Set(DEFAULT_HISTORICAL_REFERENCE_FILES.map((path) => rel(resolve(root, path), root)));
}

export function detectRetiredGateRecurrence({
  repoRoot = REPO_ROOT,
  retiredGates = DEFAULT_RETIRED_GATES,
  scanPaths = DEFAULT_ACTIVE_SOURCE_PATHS,
  allowlist = null,
} = {}) {
  const retired = new Set(retiredGates);
  const allowed = allowlist ? new Set(allowlist) : defaultAllowlist(repoRoot);
  const hits = [];
  const scanned = new Set();
  for (const scanPath of scanPaths) {
    for (const filePath of collectSourceFiles(repoRoot, scanPath)) {
      const relativePath = rel(filePath, repoRoot);
      if (allowed.has(relativePath)) continue;
      if (scanned.has(relativePath)) continue;
      scanned.add(relativePath);
      const text = readFileSync(filePath, "utf-8");
      for (const gate of retired) {
        if (!text.includes(gate)) continue;
        hits.push({ path: relativePath, gate });
      }
    }
  }
  return {
    ok: hits.length === 0,
    retired_gates: [...retired],
    scanned_file_count: scanned.size,
    hit_count: hits.length,
    hits,
  };
}

export function analyzeRitualReplayCorpus({
  fixturesDir = DEFAULT_FIXTURES_DIR,
  retiredGates = DEFAULT_RETIRED_GATES,
} = {}) {
  const retiredGateSet = new Set(retiredGates);
  const fixtures = listFixtureFiles(fixturesDir).map(parseTelemetryFixture);
  const parseErrors = fixtures.flatMap((fixture) => fixture.parse_errors);
  const byProject = emptyCounter();
  const transitionsByProject = emptyCounter();
  const historicalFailureCounts = emptyCounter();
  const historicalRetiredCounts = emptyCounter();
  const currentFailureCounts = emptyCounter();
  const currentNatureCounts = emptyCounter();
  const currentFailureSourceCounts = emptyCounter();
  const currentSoftenedFailureCounts = emptyCounter();
  const currentSoftenedFailureSourceCounts = emptyCounter();
  const currentSoftenedFailureReasonCounts = emptyCounter();
  const currentSuppressedFailureCounts = emptyCounter();
  const currentSuppressedFailureSourceCounts = emptyCounter();
  const currentSuppressedFailureReasonCounts = emptyCounter();
  const currentGateCounts = emptyCounter();
  const historicalGateCounts = emptyCounter();
  const unresolvedFailureSignals = [];
  const currentSoftenedFailureSamples = [];
  const currentSuppressedFailureSamples = [];
  const currentRitualTransitionSamples = [];
  const fixtureSummaries = [];

  let transitionCount = 0;
  let historicalRecordedBlockedTransitions = 0;
  let historicalFailedTransitions = 0;
  let historicalRetiredTransitionCount = 0;
  let currentActiveBlockedTransitions = 0;
  let currentRitualTransitions = 0;
  let currentSubstantiveTransitions = 0;
  let currentMixedTransitions = 0;
  let currentUnknownTransitions = 0;
  let currentActiveFailureCount = 0;
  let currentSoftenedTransitionCount = 0;
  let currentSoftenedFailureCount = 0;
  let currentSuppressedTransitionCount = 0;
  let currentSuppressedFailureCount = 0;
  let historicalRetiredFailureCount = 0;

  for (const fixture of fixtures) {
    bump(byProject, fixture.source_project);
    let fixtureTransitions = 0;
    let fixtureCurrentRitual = 0;
    let fixtureCurrentBlocked = 0;
    for (const transition of fixture.transitions) {
      fixtureTransitions += 1;
      transitionCount += 1;
      bump(transitionsByProject, fixture.source_project);
      bump(historicalGateCounts, transition.gate || "unknown");
      const failures = failedChecks(transition);
      if (String(transition.decision || "").toUpperCase() === "BLOCKED") {
        historicalRecordedBlockedTransitions += 1;
      }
      if (failures.length > 0) historicalFailedTransitions += 1;
      for (const failure of failures) bump(historicalFailureCounts, failure.code);
      const active = classifyActiveTransition(failures, retiredGateSet, transition, {
        fixture: fixture.fixture,
        source_project: fixture.source_project,
      });
      if (active.retiredFailures.length > 0) {
        historicalRetiredTransitionCount += 1;
        historicalRetiredFailureCount += active.retiredFailures.length;
        for (const failure of active.retiredFailures) bump(historicalRetiredCounts, failure.code);
      }
      if (active.activeBlocked) {
        fixtureCurrentBlocked += 1;
        currentActiveBlockedTransitions += 1;
        bump(currentGateCounts, transition.gate || "unknown");
        currentActiveFailureCount += active.activeFailures.length;
        for (const failure of active.activeFailures) {
          bump(currentFailureCounts, failure.code);
          bump(currentNatureCounts, failure.nature);
          bump(currentFailureSourceCounts, failure.source);
          if (failure.code === UNCODED_FAIL && unresolvedFailureSignals.length < 20) {
            unresolvedFailureSignals.push({
              fixture: fixture.fixture,
              gate: transition.gate || "unknown",
              check: failure.name || "unknown",
            });
          }
        }
      }
      if (active.softenedFailures.length > 0) {
        currentSoftenedTransitionCount += 1;
        currentSoftenedFailureCount += active.softenedFailures.length;
        for (const failure of active.softenedFailures) {
          bump(currentSoftenedFailureCounts, failure.code);
          bump(currentSoftenedFailureSourceCounts, failure.source);
          bump(currentSoftenedFailureReasonCounts, failure.softened_policy?.reason);
          if (currentSoftenedFailureSamples.length < 20) {
            currentSoftenedFailureSamples.push({
              fixture: fixture.fixture,
              gate: transition.gate || "unknown",
              code: failure.code,
              check: failure.name || "unknown",
              source: failure.source,
              reason: failure.softened_policy?.reason || "unknown",
            });
          }
        }
      }
      if (active.suppressedFailures.length > 0) {
        currentSuppressedTransitionCount += 1;
        currentSuppressedFailureCount += active.suppressedFailures.length;
        for (const failure of active.suppressedFailures) {
          bump(currentSuppressedFailureCounts, failure.code);
          bump(currentSuppressedFailureSourceCounts, failure.source);
          bump(currentSuppressedFailureReasonCounts, failure.suppressed_policy?.reason);
          if (currentSuppressedFailureSamples.length < 20) {
            currentSuppressedFailureSamples.push({
              fixture: fixture.fixture,
              gate: transition.gate || "unknown",
              code: failure.code,
              check: failure.name || "unknown",
              source: failure.source,
              reason: failure.suppressed_policy?.reason || "unknown",
            });
          }
        }
      }
      if (active.ritualCoded) {
        fixtureCurrentRitual += 1;
        currentRitualTransitions += 1;
        if (currentRitualTransitionSamples.length < 20) {
          currentRitualTransitionSamples.push({
            fixture: fixture.fixture,
            gate: transition.gate || "unknown",
            active_failures: active.activeFailures.map((failure) => ({
              code: failure.code,
              name: failure.name || "unknown",
              nature: failure.nature,
              source: failure.source,
            })),
          });
        }
      }
      if (active.substantiveCoded) currentSubstantiveTransitions += 1;
      if (active.mixedCoded) currentMixedTransitions += 1;
      if (active.activeBlocked && active.activeFailures.some((failure) => failure.nature === "unknown")) {
        currentUnknownTransitions += 1;
      }
    }
    fixtureSummaries.push({
      fixture: fixture.fixture,
      source_project: fixture.source_project,
      transition_count: fixtureTransitions,
      current_active_blocked_transition_count: fixtureCurrentBlocked,
      current_ritual_transition_count: fixtureCurrentRitual,
      current_ritual_transition_rate_pct: pct(fixtureCurrentRitual, fixtureTransitions),
      historical_retired_failure_count: fixture.transitions.reduce((sum, transition) => {
        const failures = failedChecks(transition);
        return sum + failures.filter((failure) => retiredGateSet.has(failure.code)).length;
      }, 0),
    });
  }

  return {
    fixture_count: fixtures.length,
    fixtures: fixtureSummaries,
    parse_error_count: parseErrors.length,
    parse_errors: parseErrors,
    by_project: sortedObject(byProject),
    transitions_by_project: sortedObject(transitionsByProject),
    transition_count: transitionCount,
    historical: {
      recorded_blocked_transition_count: historicalRecordedBlockedTransitions,
      failed_transition_count: historicalFailedTransitions,
      retired_gate_transition_count: historicalRetiredTransitionCount,
      retired_gate_failure_count: historicalRetiredFailureCount,
      failure_counts_by_code: sortedObject(historicalFailureCounts),
      retired_gate_hits_by_code: sortedObject(historicalRetiredCounts),
      gate_counts: sortedObject(historicalGateCounts),
    },
    current: {
      semantics: "Recorded gate_transition checks reinterpreted with today's gate taxonomy; retired gates are historical-only.",
      active_blocked_transition_count: currentActiveBlockedTransitions,
      active_failure_count: currentActiveFailureCount,
      ritual_transition_count: currentRitualTransitions,
      ritual_transition_rate_pct: pct(currentRitualTransitions, transitionCount),
      ritual_share_of_active_blocked_pct: pct(currentRitualTransitions, currentActiveBlockedTransitions),
      substantive_transition_count: currentSubstantiveTransitions,
      mixed_transition_count: currentMixedTransitions,
      unknown_transition_count: currentUnknownTransitions,
      unknown_transition_rate_pct: pct(currentUnknownTransitions, transitionCount),
      active_failure_counts_by_code: sortedObject(currentFailureCounts),
      active_failure_counts_by_nature: sortedObject(currentNatureCounts),
      active_failure_counts_by_source: sortedObject(currentFailureSourceCounts),
      target_hotspot_repairs: targetHotspotRepairRows(currentFailureCounts),
      ritual_transition_samples: currentRitualTransitionSamples,
      softened_failure_policy_version: CURRENT_SOFTENED_POLICY_VERSION,
      softened_failure_policy: Object.fromEntries(
        Object.entries(CURRENT_SOFTENED_FAILURE_POLICIES).map(([code, policy]) => [code, { ...policy }])
      ),
      softened_transition_count: currentSoftenedTransitionCount,
      softened_failure_count: currentSoftenedFailureCount,
      softened_failure_counts_by_code: sortedObject(currentSoftenedFailureCounts),
      softened_failure_counts_by_source: sortedObject(currentSoftenedFailureSourceCounts),
      softened_failure_counts_by_reason: sortedObject(currentSoftenedFailureReasonCounts),
      softened_failure_samples: currentSoftenedFailureSamples,
      suppressed_failure_policy_version: CURRENT_SUPPRESSED_POLICY_VERSION,
      suppressed_failure_policy: Object.fromEntries(
        Object.entries(CURRENT_SUPPRESSED_FAILURE_POLICIES).map(([code, policy]) => [code, { ...policy }])
      ),
      suppressed_transition_count: currentSuppressedTransitionCount,
      suppressed_failure_count: currentSuppressedFailureCount,
      suppressed_failure_counts_by_code: sortedObject(currentSuppressedFailureCounts),
      suppressed_failure_counts_by_source: sortedObject(currentSuppressedFailureSourceCounts),
      suppressed_failure_counts_by_reason: sortedObject(currentSuppressedFailureReasonCounts),
      suppressed_failure_samples: currentSuppressedFailureSamples,
      unresolved_failure_signal_count: currentFailureCounts[UNCODED_FAIL] || 0,
      unresolved_failure_signal_samples: unresolvedFailureSignals,
      active_blocked_gate_counts: sortedObject(currentGateCounts),
    },
  };
}

export function runRitualReplay({
  fixturesDir = DEFAULT_FIXTURES_DIR,
  repoRoot = REPO_ROOT,
  retiredGates = DEFAULT_RETIRED_GATES,
  maxCurrentRitualTransitionRatePct = DEFAULT_MAX_CURRENT_RITUAL_TRANSITION_RATE_PCT,
  targetCurrentRitualTransitionRatePct = DEFAULT_TARGET_CURRENT_RITUAL_TRANSITION_RATE_PCT,
  maxCurrentUnknownTransitionRatePct = DEFAULT_MAX_CURRENT_UNKNOWN_TRANSITION_RATE_PCT,
  minFixtureCount = DEFAULT_MIN_FIXTURE_COUNT,
  minTransitionCount = DEFAULT_MIN_TRANSITION_COUNT,
  minPortableAgentKitTransitionCount = DEFAULT_MIN_PORTABLE_AGENT_KIT_TRANSITION_COUNT,
  scanPaths = DEFAULT_ACTIVE_SOURCE_PATHS,
  allowlist = null,
} = {}) {
  const corpus = analyzeRitualReplayCorpus({ fixturesDir, retiredGates });
  const recurrence = detectRetiredGateRecurrence({ repoRoot, retiredGates, scanPaths, allowlist });
  const portableTransitions = corpus.transitions_by_project.portable_agent_kit || 0;
  const budgetRows = {
    fixture_count: {
      current: corpus.fixture_count,
      minimum: minFixtureCount,
      pass: corpus.fixture_count >= minFixtureCount,
    },
    transition_count: {
      current: corpus.transition_count,
      minimum: minTransitionCount,
      pass: corpus.transition_count >= minTransitionCount,
    },
    portable_agent_kit_transition_count: {
      current: portableTransitions,
      minimum: minPortableAgentKitTransitionCount,
      pass: portableTransitions >= minPortableAgentKitTransitionCount,
    },
    current_ritual_transition_rate_pct: {
      current: corpus.current.ritual_transition_rate_pct,
      maximum: maxCurrentRitualTransitionRatePct,
      target: targetCurrentRitualTransitionRatePct,
      pass: corpus.current.ritual_transition_rate_pct <= maxCurrentRitualTransitionRatePct,
      target_met: corpus.current.ritual_transition_rate_pct <= targetCurrentRitualTransitionRatePct,
    },
    current_unknown_transition_rate_pct: {
      current: corpus.current.unknown_transition_rate_pct,
      maximum: maxCurrentUnknownTransitionRatePct,
      pass: corpus.current.unknown_transition_rate_pct < maxCurrentUnknownTransitionRatePct,
    },
    retired_gate_active_bounce_count: {
      current: recurrence.hit_count,
      maximum: 0,
      pass: recurrence.hit_count === 0,
    },
    parse_error_count: {
      current: corpus.parse_error_count,
      maximum: 0,
      pass: corpus.parse_error_count === 0,
    },
  };
  const regressions = [];
  for (const [metric, row] of Object.entries(budgetRows)) {
    if (row.pass) continue;
    regressions.push({
      code: `ritual_replay_${metric}`,
      severity: "regression",
      detail: `${metric} outside budget`,
      metric,
      current: row.current,
      minimum: row.minimum,
      maximum: row.maximum,
      target: row.target,
    });
  }
  const ok = regressions.length === 0;
  const report = {
    schema_version: RITUAL_REPLAY_SCHEMA_VERSION,
    ritual_replay_id: "real_work_ritual_e2e_replay",
    ok,
    status: ok ? "PASS" : "FAIL",
    generated_at: new Date().toISOString(),
    semantics: {
      current_code_replay: "Uses committed real telemetry fixtures and today's deterministic ritual taxonomy.",
      cumulative_history: "behavior_report.mjs remains a separate all-plans archive report and is not used as this current-code E2E denominator.",
      residual_unknown: "This replay does not regenerate every historical gate check from full plan state; it reinterprets recorded check arrays.",
      softened_current_failures: "Bounded legacy/advisory failure rows stay historical but do not count as current active blockers when current gate behavior no longer blocks the same condition.",
      suppressed_trace_off_failures: "Trace-capture-dependent legacy persona/trace rows are suppressed from current replay counts when the fixture shows trace capture was unavailable.",
    },
    corpus: {
      fixtures_dir: rel(fixturesDir, repoRoot),
      fixture_count: corpus.fixture_count,
      transition_count: corpus.transition_count,
      by_project: corpus.by_project,
      transitions_by_project: corpus.transitions_by_project,
      fixtures: corpus.fixtures,
      parse_error_count: corpus.parse_error_count,
      parse_errors: corpus.parse_errors,
    },
    historical: corpus.historical,
    current: {
      ...corpus.current,
      retired_gate_active_bounce_count: recurrence.hit_count,
      retired_gate_active_source_hits: recurrence.hits,
    },
    retired_gates: {
      configured: [...retiredGates],
      historical_hits_by_code: corpus.historical.retired_gate_hits_by_code,
      current_active_bounce_count: recurrence.hit_count,
      current_active_source_hits: recurrence.hits,
      active_source_scan: {
        ok: recurrence.ok,
        scanned_file_count: recurrence.scanned_file_count,
      },
    },
    budgets: budgetRows,
    regressions,
  };
  report.findings = findingsFromRitualReplayReport(report);
  return report;
}

function valueFor(argv, index, name) {
  const arg = argv[index];
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), index };
  if (argv[index + 1] === undefined) throw new Error(`${name} requires a value`);
  return { value: argv[index + 1], index: index + 1 };
}

export function parseRitualReplayArgs(argv = []) {
  const args = {
    json: false,
    help: false,
    fixturesDir: DEFAULT_FIXTURES_DIR,
    repoRoot: REPO_ROOT,
    maxCurrentRitualTransitionRatePct: DEFAULT_MAX_CURRENT_RITUAL_TRANSITION_RATE_PCT,
    targetCurrentRitualTransitionRatePct: DEFAULT_TARGET_CURRENT_RITUAL_TRANSITION_RATE_PCT,
    maxCurrentUnknownTransitionRatePct: DEFAULT_MAX_CURRENT_UNKNOWN_TRANSITION_RATE_PCT,
    minFixtureCount: DEFAULT_MIN_FIXTURE_COUNT,
    minTransitionCount: DEFAULT_MIN_TRANSITION_COUNT,
    minPortableAgentKitTransitionCount: DEFAULT_MIN_PORTABLE_AGENT_KIT_TRANSITION_COUNT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--fixtures-dir" || arg.startsWith("--fixtures-dir=")) {
      const next = valueFor(argv, index, "--fixtures-dir");
      args.fixturesDir = resolve(args.repoRoot, next.value);
      index = next.index;
    } else if (arg === "--repo-root" || arg.startsWith("--repo-root=")) {
      const next = valueFor(argv, index, "--repo-root");
      args.repoRoot = resolve(next.value);
      index = next.index;
    } else if (arg === "--max-current-ritual-transition-rate-pct" || arg.startsWith("--max-current-ritual-transition-rate-pct=")) {
      const next = valueFor(argv, index, "--max-current-ritual-transition-rate-pct");
      args.maxCurrentRitualTransitionRatePct = Number(next.value);
      index = next.index;
    } else if (arg === "--target-current-ritual-transition-rate-pct" || arg.startsWith("--target-current-ritual-transition-rate-pct=")) {
      const next = valueFor(argv, index, "--target-current-ritual-transition-rate-pct");
      args.targetCurrentRitualTransitionRatePct = Number(next.value);
      index = next.index;
    } else if (arg === "--max-current-unknown-transition-rate-pct" || arg.startsWith("--max-current-unknown-transition-rate-pct=")) {
      const next = valueFor(argv, index, "--max-current-unknown-transition-rate-pct");
      args.maxCurrentUnknownTransitionRatePct = Number(next.value);
      index = next.index;
    } else if (arg === "--min-fixture-count" || arg.startsWith("--min-fixture-count=")) {
      const next = valueFor(argv, index, "--min-fixture-count");
      args.minFixtureCount = Number(next.value);
      index = next.index;
    } else if (arg === "--min-transition-count" || arg.startsWith("--min-transition-count=")) {
      const next = valueFor(argv, index, "--min-transition-count");
      args.minTransitionCount = Number(next.value);
      index = next.index;
    } else if (arg === "--min-portable-agent-kit-transition-count" || arg.startsWith("--min-portable-agent-kit-transition-count=")) {
      const next = valueFor(argv, index, "--min-portable-agent-kit-transition-count");
      args.minPortableAgentKitTransitionCount = Number(next.value);
      index = next.index;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  for (const key of [
    "maxCurrentRitualTransitionRatePct",
    "targetCurrentRitualTransitionRatePct",
    "maxCurrentUnknownTransitionRatePct",
    "minFixtureCount",
    "minTransitionCount",
    "minPortableAgentKitTransitionCount",
  ]) {
    if (!Number.isFinite(args[key])) throw new Error(`${key} must be numeric`);
  }
  return args;
}

export function renderRitualReplayText(report) {
  return [
    "Real-Work Ritual Replay",
    `Status: ${report.status}`,
    `Fixtures: ${report.corpus.fixture_count}`,
    `Transitions: ${report.corpus.transition_count}`,
    `Current ritual transitions: ${report.current.ritual_transition_count} (${report.current.ritual_transition_rate_pct}%)`,
    `Current ritual share of active blocked transitions: ${report.current.ritual_share_of_active_blocked_pct}%`,
    `Current unknown transitions: ${report.current.unknown_transition_count} (${report.current.unknown_transition_rate_pct}%)`,
    `Current softened failures: ${report.current.softened_failure_count} across ${report.current.softened_transition_count} transition(s) (${report.current.softened_failure_policy_version})`,
    `Current suppressed trace-off failures: ${report.current.suppressed_failure_count} across ${report.current.suppressed_transition_count} transition(s) (${report.current.suppressed_failure_policy_version})`,
    `Historical retired gate hits: ${Object.entries(report.retired_gates.historical_hits_by_code).map(([code, count]) => `${code}=${count}`).join(", ") || "none"}`,
    `Current retired active bounces: ${report.retired_gates.current_active_bounce_count}`,
    `Budget: max current ritual transition rate ${report.budgets.current_ritual_transition_rate_pct.maximum}% (${report.budgets.current_ritual_transition_rate_pct.pass ? "within budget" : "over budget"})`,
    `Target: ${report.budgets.current_ritual_transition_rate_pct.target}% (${report.budgets.current_ritual_transition_rate_pct.target_met ? "met" : "not met"})`,
  ].join("\n");
}
