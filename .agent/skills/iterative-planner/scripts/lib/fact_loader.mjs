// fact_loader.mjs — Prolog fact extraction for the iterative planner rule engine.
//
// Extracted from rule_engine.mjs to reduce file size and isolate
// fact-extraction logic from command dispatch and Prolog engine setup.
//
// Security controls preserved:
//   RT-AUDIT-C2:  Read state from state.json (canonical), not unsigned state.md
//   RT-HARDENING-004: Registry hash tamper detection
//   RT-REDTEAM-M3: Project rules loaded first, cannot override core
//   RT-AUDIT-M1:  Whitelist sanitization for structured identifiers
//
// Zero dependencies — Node.js 18+.

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { sanitizeAtom, sanitizeStrictId, sanitizeEnumAtom } from "./sanitize.mjs";
import { readStateJson, writeStateJson, isFeatureEnabled, nowISO, KB_SALT_HEX_LEN } from "./determinism.mjs";
import { analyzeRedTeamNotes, debugLog, extractFilesToModify, loadIntentContract, resolveFindingsTruth, resolvePlanTarget } from "./plan_utils.mjs";
import { detectPlanShape, shapeMinFindings } from "./plan_shape.mjs";
import { buildNorthStarFacts, loadPlannerManifesto } from "./planner_manifesto.mjs";
import { collectMetricActualFacts } from "./north_star_telemetry.mjs";
import { summarizeProofTelemetry } from "./proof_telemetry.mjs";
import { loadDiscoveryPolicy } from "../knowledge_resolver.mjs";
import { compileActiveOntologyFacts } from "./ive_active_ontology.mjs";
import { compileIveIdeationFacts, evaluateIveIdeation, loadIveIdeationInputs } from "./ive_ideation_operators.mjs";
import { compileIveReflectionDiffFacts } from "./ive_reflection_diff.mjs";
import { compileNovelInsightFloorFacts, evaluateNovelInsightFloor } from "./novel_insight_floor.mjs";
import { compileQuantGateHardeningFacts } from "./quant_gate_hardening.mjs";
import { loadSessionObligations } from "./session_obligations.mjs";
import { validateReflection } from "./reflection_validation.mjs";
import { buildOntologyFacts } from "./ontology_fact_builder.mjs";
import { assessDegradedCoverage } from "./degraded_coverage.mjs";
import { compileAvaFacts } from "./autonomous_verification_agents.mjs";
import { compileJournalFacts } from "./agent_journal.mjs";
import { compileJournalMemoryFacts } from "./journal_memory.mjs";
import { safeLoadGateRegistry } from "./gate_registry.mjs";
import { compileVerificationStatusFacts, deriveVerificationTruth } from "./verification_truth.mjs";
import {
  discoverSourceFiles,
  loadSemanticHygieneFacts as loadSemanticHygieneScannerFacts,
} from "./semantic_hygiene.mjs";
import { canonicalVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";
import {
  CURRENT_COVERAGE_CONTRACT_VERSION,
  evaluateStoryExecutedProof,
  storyCoverageContractVersion,
  validateCoverageContract,
} from "../story_registry.mjs";

// RT7-H3: Max file size for plan artifact reads (1 MB)
const MAX_ARTIFACT_BYTES = 1_048_576;

function safeRead(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (st.size > MAX_ARTIFACT_BYTES) {
      debugLog("fact_loader", `File exceeds ${MAX_ARTIFACT_BYTES} bytes: ${filePath} (${st.size})`);
      return null;
    }
    return readFileSync(filePath, "utf-8");
  } catch { return null; }
}

const FALLBACK_REACHABILITY_GATES = new Set([
  "explore-to-plan",
  "plan-to-execute",
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
]);

const REACHABILITY_AUDIT_LOG_TYPES = new Set([
  "reachability",
  "reachability-audit",
  "reachability_audit",
]);

function normalizeGateKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");
}

function transitionGateKey(transition) {
  if (!transition || typeof transition !== "object") return "";
  const explicit = normalizeGateKey(transition.gate || transition.gate_id || transition.gate_name);
  if (explicit) return explicit;

  const from = normalizeGateKey(transition.from);
  const to = normalizeGateKey(transition.to);
  if (!from || !to || from === to) return "";
  return `${from}-to-${to}`;
}

function loadReachabilityGateLookup(skillPath) {
  const registry = safeLoadGateRegistry({ skillPath });
  const gates = registry?.gates && typeof registry.gates === "object" ? registry.gates : {};
  const reachabilityGates = new Set(
    Object.entries(gates)
      .filter(([, gateDef]) => gateDef?.reachability_audit === true)
      .map(([gateName]) => normalizeGateKey(gateName))
      .filter(Boolean)
  );
  if (reachabilityGates.size === 0) {
    for (const gate of FALLBACK_REACHABILITY_GATES) reachabilityGates.add(gate);
  }
  return reachabilityGates;
}

function transitionHasPassingResult(transition) {
  if (!transition || typeof transition !== "object") return false;
  if (!verificationStatusIsPass(transition.gate_result ?? transition.status ?? transition.result, "gate")) return false;
  return !Array.isArray(transition.failure_codes) || transition.failure_codes.length === 0;
}

function transitionHasReachabilityAuditPass(transition, reachabilityGates) {
  if (!transitionHasPassingResult(transition)) return false;
  const gateKey = transitionGateKey(transition);
  if (gateKey && reachabilityGates.has(gateKey)) return true;
  if (transition.reachability_audit === true || transition.reachability_audit_done === true) return true;
  return false;
}

function planStateHasReachabilityEvidence(planDir, reachabilityGates) {
  const stateJson = readStateJson(planDir);
  if (!Array.isArray(stateJson?.transitions)) return false;
  return stateJson.transitions.some((transition) =>
    transitionHasReachabilityAuditPass(transition, reachabilityGates)
  );
}

function auditLogHasReachabilityEvidence(cwd) {
  const content = safeRead(join(cwd, "plans", "audit_log.json"));
  if (!content) return false;
  try {
    const auditLog = JSON.parse(content);
    const entries = [
      ...(Array.isArray(auditLog?.audits) ? auditLog.audits : []),
      ...(Array.isArray(auditLog?.workflow_events) ? auditLog.workflow_events : []),
    ];
    return entries.some((entry) => {
      const rawType = String(entry?.type || entry?.audit_type || entry?.workflow || entry?.skill || "").trim();
      const type = normalizeGateKey(rawType);
      if (!REACHABILITY_AUDIT_LOG_TYPES.has(type)) return false;
      return verificationStatusIsPass(entry?.status ?? entry?.result ?? entry?.gate_result, "gate");
    });
  } catch (e) {
    debugLog("fact_loader", `Reachability audit log parse failed: ${e.message}`);
    return false;
  }
}

function projectHasReachabilityAuditEvidence({ cwd, skillPath, plannerPlan }) {
  const reachabilityGates = loadReachabilityGateLookup(skillPath);
  if (plannerPlan?.planDir && planStateHasReachabilityEvidence(plannerPlan.planDir, reachabilityGates)) {
    return true;
  }
  if (auditLogHasReachabilityEvidence(cwd)) return true;

  const plansDir = join(cwd, "plans");
  try {
    if (!existsSync(plansDir)) return false;
    for (const entry of readdirSync(plansDir)) {
      if (!entry.startsWith("plan_")) continue;
      const planDir = join(plansDir, entry);
      if (planDir === plannerPlan?.planDir) continue;
      if (planStateHasReachabilityEvidence(planDir, reachabilityGates)) return true;
    }
  } catch (e) {
    debugLog("fact_loader", `Reachability plan scan failed: ${e.message}`);
  }
  return false;
}

function closeSignalRequiredAtom(signal) {
  if (typeof signal?.required === "boolean") return signal.required ? "true" : "false";
  return "unknown";
}

function closeSignalSatisfiedAtom(signal) {
  if (signal && typeof signal === "object" && signal.required === false) return "not_required";
  if (typeof signal?.satisfied === "boolean") return signal.satisfied ? "true" : "false";
  return "unknown";
}

function closeSignalStatusValue(signal, fallbackWhenPresent = "not_required") {
  if (!signal || typeof signal !== "object") return "unknown";
  if (signal.status) return signal.status;
  if (signal.required === false) return "not_required";
  return fallbackWhenPresent;
}

const RUNTIME_CLOSE_SIGNAL_FACT_PREDICATES = new Set([
  "migration_smoke_satisfied",
  "test_evidence_satisfied",
  "anti_recurrence_required",
  "anti_recurrence_satisfied",
  "intent_evidence_satisfied",
  "semantic_substrate_required",
  "semantic_substrate_satisfied",
  "semantic_substrate_scope_degraded",
  "semantic_substrate_scan_scope_used",
  "semantic_substrate_scope_degraded_reason",
  "semantic_substrate_relevance",
  "semantic_substrate_gap",
  "semantic_substrate_blocking_gap",
  "quant_results_validation_required",
  "quant_results_validation_satisfied",
  "quant_results_validation_status",
  "quant_results_evidence_validity",
  "quant_results_claim_support_allowed",
  "quant_results_numeric_output_reportable",
  "quant_results_environment_preflight_status",
  "quant_results_environment_preflight_performed",
  "quant_results_environment_preflight_probe_count",
  "quant_results_run_class",
  "quant_results_promotion_verdict",
  "quant_results_blocking_issue",
  "quant_optimization_scale_required",
  "quant_optimization_scale_status",
  "quant_optimization_scale_section_present",
  "quant_optimization_scale_issue",
  "quant_run_class_interpretive",
  "quant_run_class_declared",
  "quant_run_class_quick_evidence",
  "quant_run_class_discovered_budget",
  "quant_run_class_discovered_budget_unknown",
  "quant_run_class_threshold",
  "quant_run_class_inflation_issue",
  "quant_leakage_proof_artifact_required",
  "quant_leakage_proof_artifact_status",
  "quant_leakage_proof_artifact_row_count",
  "quant_leakage_proof_artifact_run_class",
  "quant_leakage_proof_artifact_issue",
  "review_intake_required",
  "review_intake_satisfied",
  "review_intake_unresolved_required_count",
]);

function filterRuntimeCloseSignalFacts(rawFacts) {
  return String(rawFacts || "")
    .split("\n")
    .filter((line) => {
      const match = line.trim().match(/^([a-z_][a-z0-9_]*)\s*\(/);
      return !match || !RUNTIME_CLOSE_SIGNAL_FACT_PREDICATES.has(match[1]);
    })
    .join("\n");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownSection(content, heading) {
  const lines = String(content || "").split("\n");
  const headingPattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "i");
  const nextHeadingPattern = /^##\s+/;
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return "";

  const collected = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (nextHeadingPattern.test(lines[i].trim())) break;
    collected.push(lines[i]);
  }
  return collected.join("\n");
}

function inferIvePhase3RequiredOnExtractionError({ cwd, planDir }) {
  try {
    return !!evaluateIveIdeation(loadIveIdeationInputs({ cwd, planDir })).required;
  } catch {
    return false;
  }
}

function resolvePlannerPlanContext(cwd, opts = {}) {
  const plansDir = join(cwd, "plans");
  const target = resolvePlanTarget(plansDir, {
    exitOnMissing: false,
    plan: opts.plan,
    env: opts.env || process.env,
  });
  if (!target.planDirName || !target.planDir) return null;
  return { plansDir, ...target };
}

const PLANNER_STATE_ATOM = "(?:explore|plan|execute|reflect|validate|re_plan|close)";
const SAFE_POLICY_FACT_PATTERNS = [
  new RegExp(`^forbidden_path\\(\\s*${PLANNER_STATE_ATOM}\\s*,\\s*${PLANNER_STATE_ATOM}\\s*\\)\\.\\s*$`),
  new RegExp(`^privileged_state\\(\\s*${PLANNER_STATE_ATOM}\\s*\\)\\.\\s*$`),
  new RegExp(`^auth_gate\\(\\s*${PLANNER_STATE_ATOM}\\s*,\\s*${PLANNER_STATE_ATOM}\\s*\\)\\.\\s*$`),
];
const SAFE_POLICY_PREDICATES = new Set(["forbidden_path", "privileged_state", "auth_gate"]);

function isSafePlannerPolicyFact(trimmed) {
  return SAFE_POLICY_FACT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function normalizeStoryText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveStoryTags(story) {
  const explicit = Array.isArray(story.tags) ? story.tags : [];
  const codeRefs = Array.isArray(story.code_refs) ? story.code_refs : [];
  const combined = normalizeStoryText([
    story.id,
    story.title,
    story.description,
    story.summary,
    ...(Array.isArray(story.postconditions) ? story.postconditions : []),
    ...codeRefs,
  ].filter(Boolean).join("\n"));
  const tags = new Set(explicit.map((tag) => normalizeStoryText(tag).replace(/\s+/g, "_")).filter(Boolean));

  const directTimeSeriesSignal = /\b(time series|walk forward|temporal split|rolling forecast|rolling backtest|rolling window|forecast model|odds model|trueskill|markov|final oos|out of sample)\b/.test(combined);
  const backtestModelSignal = /\bbacktest\b/.test(combined) && /\b(model|forecast|odds|signal|train|oos|out of sample)\b/.test(combined);
  const codeModelSignal = codeRefs.some((ref) => /(^|\/)(models?|signals?|backtests?|forecast)\//i.test(String(ref)) || /(model|forecast|backtest|signal)\.(py|mjs|ts|js)$/i.test(String(ref)));
  if (directTimeSeriesSignal || backtestModelSignal || (codeModelSignal && /\b(backtest|forecast|odds|oos|out of sample)\b/.test(combined))) {
    tags.add("time_series");
  }

  return [...tags];
}

function structuredPostconditionFact(id, value) {
  const text = String(value || "").trim();
  const temporal = text.match(/^temporal_split_defined\(([^()]+)\)$/i);
  if (temporal) {
    return `postcondition(${id}, temporal_split_defined(${sanitizeEnumAtom(temporal[1])})).`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// Fact extraction: story_registry.json → Prolog facts
// ═══════════════════════════════════════════════════════════

export function loadStoryFacts(session, { cwd, transientRegistryRefresh = false }) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) {
    session.consult("story_registry_exists(false).");
    session.consult("story_count(0).");
    session.consult("story_postcondition_count(0).");
    session.consult("story_conflict_decl_count(0).");
    return { loaded: false, count: 0 };
  }

  let registry;
  let registryRaw;
  try {
    registryRaw = readFileSync(registryPath, "utf-8");
    registry = JSON.parse(registryRaw);
  } catch (e) {
    return { loaded: false, count: 0, error: e.message };
  }

  const coverageContractValidation = validateCoverageContract(registry);
  session.consult(`story_coverage_contract_valid(${coverageContractValidation.errors.length === 0 ? "true" : "false"}).`);
  session.consult("story_coverage_contract('__coverage_contract_sentinel__', none).");
  session.consult("story_validation_satisfied('__coverage_contract_sentinel__').");
  session.consult("validation_executed('__coverage_contract_sentinel__', '__coverage_contract_sentinel__').");
  for (const error of coverageContractValidation.errors) {
    session.consult(`story_coverage_contract_error(${sanitizeAtom(error)}).`);
  }
  if (registry.coverage_contract?.current_version === CURRENT_COVERAGE_CONTRACT_VERSION) {
    session.consult("validation_executed_tracking_enabled.");
  }
  session.consult("story_coverage_tracking_enabled.");

  // RT-HARDENING-004: Compute registry hash and store in state.json for tamper detection.
  // RT3-M4-FIX: Only WRITE registry hash when explicitly in write mode (transition.mjs).
  // CLI commands (rule_engine.mjs verify-stories, --self-test) should be read-only.
  // The caller signals write intent via env var set by transition.mjs.
  // RT10-C2: Full 32-char hash for registry tamper detection
  const registryHash = createHash("sha256").update(registryRaw).digest("hex").slice(0, 32);
  const plannerPlan = resolvePlannerPlanContext(cwd);
  if (plannerPlan) {
    const { planDirName, planDir } = plannerPlan;
    const stateJson = readStateJson(planDir);
    if (stateJson) {
      const registryRefreshAuthorized = [transientRegistryRefresh, process.env._PLANNER_GATE_TRANSITION === "1"].includes(true);
      if (stateJson.registry_hash && stateJson.registry_hash !== registryHash && !registryRefreshAuthorized) {
        debugLog("rule_engine", `WARNING: story_registry.json changed since the last signed transition (was ${stateJson.registry_hash}, now ${registryHash}). If intentional, run a planner transition to refresh registry_hash.`);
        session.consult("registry_tampered(true).");
      } else {
        session.consult("registry_tampered(false).");
      }
      // RT3-M4-FIX: Only persist hash during transition (write mode)
      if (process.env._PLANNER_GATE_TRANSITION === "1" && process.env._PLANNER_DRY_RUN !== "1") {
        stateJson.registry_hash = registryHash;
        writeStateJson(planDir, stateJson);
        // RT-2026-07-02: The transition that refreshes the hash must not be
        // blocked by the stale hash it is replacing. Retract the tamper signal
        // for the same session after the refresh is persisted.
        session.consult("registry_tampered(false).");
      }
    }
  }

  const allStories = [
    ...(Array.isArray(registry.stories) ? registry.stories : []),
    ...(Array.isArray(registry.infrastructure_stories) ? registry.infrastructure_stories : []),
  ];
  if (allStories.length === 0) {
    session.consult("story_postcondition_count(0).");
    session.consult("story_conflict_decl_count(0).");
    return { loaded: false, count: 0 };
  }

  let count = 0;
  const storyIds = [];
  const activeStoryIds = [];
  const retiredStoryIds = [];
  let postconditionCount = 0;
  let conflictDeclCount = 0;
  for (const s of allStories) {
    if (!s.id) continue;
    const id = sanitizeStrictId(s.id);
    const title = sanitizeAtom(s.title || "untitled");
    const priority = sanitizeEnumAtom(s.priority || "medium");
    const status = sanitizeEnumAtom(s.status || "unknown");
    const rawStatus = String(s.status || "unknown").trim().toUpperCase();
    const coverageContractVersion = storyCoverageContractVersion(s, registry);

    session.consult(`story(${id}, ${title}, ${priority}, ${status}).`);
    if (coverageContractVersion === CURRENT_COVERAGE_CONTRACT_VERSION) {
      session.consult(`story_coverage_contract(${id}, current).`);
    }

    for (const tag of deriveStoryTags(s)) {
      try { session.consult(`story_tag(${id}, ${sanitizeEnumAtom(tag)}).`); } catch (e) { debugLog("rule_engine", `Malformed tag for ${s.id}: ${e.message}`); }
    }

    if (Array.isArray(s.code_refs)) {
      for (const ref of s.code_refs) {
        session.consult(`code_ref(${id}, ${sanitizeStrictId(ref)}).`);
        const refFile = ref.split(":")[0];
        const baseName = refFile.split("/").pop();
        if (baseName.endsWith(".mjs")) {
          session.consult(`story_covers_script(${id}, ${sanitizeStrictId(baseName)}).`);
        }
      }
    }
    if (Array.isArray(s.test_refs)) {
      for (const ref of s.test_refs) session.consult(`test_ref(${id}, ${sanitizeStrictId(ref)}).`);
    }
    if (Array.isArray(s.validation_refs)) {
      for (const ref of s.validation_refs) session.consult(`validation_ref(${id}, ${sanitizeStrictId(ref)}).`);
    }
    const executedProof = evaluateStoryExecutedProof(s, { registry, cwd });
    for (const proof of executedProof.valid) {
      session.consult(`validation_executed(${id}, ${sanitizeStrictId(proof.validation_ref)}).`);
    }
    if (coverageContractVersion === CURRENT_COVERAGE_CONTRACT_VERSION && executedProof.executed) {
      session.consult(`story_validation_satisfied(${id}).`);
    }
    if (Array.isArray(s.doc_refs)) {
      for (const ref of s.doc_refs) session.consult(`doc_ref(${id}, ${sanitizeStrictId(ref)}).`);
    }
    if (Array.isArray(s.requires)) {
      for (const dep of s.requires) session.consult(`requires(${id}, ${sanitizeStrictId(dep)}).`);
    }
    if (Array.isArray(s.blocked_by)) {
      for (const b of s.blocked_by) session.consult(`blocked_by_defect(${id}, ${sanitizeStrictId(b)}).`);
    }
    if (Array.isArray(s.open_gaps)) {
      for (const g of s.open_gaps) session.consult(`open_gap(${id}, ${sanitizeAtom(g)}).`);
    }
    if (Array.isArray(s.preconditions)) {
      for (const p of s.preconditions) {
        try { session.consult(`precondition(${id}, ${sanitizeAtom(p)}).`); } catch (e) { debugLog("rule_engine", `Malformed precondition for ${s.id}: ${e.message}`); }
      }
    }
    if (Array.isArray(s.postconditions)) {
      for (const p of s.postconditions) {
        try {
          session.consult(structuredPostconditionFact(id, p) || `postcondition(${id}, ${sanitizeAtom(p)}).`);
          postconditionCount++;
        } catch (e) {
          debugLog("rule_engine", `Malformed postcondition for ${s.id}: ${e.message}`);
        }
      }
    }
    if (Array.isArray(s.actions)) {
      for (const a of s.actions) {
        try { session.consult(`action(${id}, ${sanitizeAtom(a)}).`); } catch (e) { debugLog("rule_engine", `Malformed action for ${s.id}: ${e.message}`); }
      }
    }
    if (Array.isArray(s.conflicts)) {
      for (const conflict of s.conflicts) {
        const targetId = typeof conflict === "string"
          ? conflict
          : (conflict && typeof conflict === "object"
            ? conflict.story_id || conflict.story || conflict.id || conflict.with
            : null);
        if (!targetId) continue;
        try {
          session.consult(`declared_story_conflict(${id}, ${sanitizeStrictId(targetId)}).`);
          conflictDeclCount++;
        } catch (e) {
          debugLog("rule_engine", `Malformed conflict for ${s.id}: ${e.message}`);
        }
      }
    }
    storyIds.push(String(s.id));
    if (rawStatus === "RETIRED") retiredStoryIds.push(String(s.id));
    else activeStoryIds.push(String(s.id));
    count++;
  }

  // Emit aggregate story count fact for invariant checks (I-030)
  session.consult(`story_count(${count}).`);
  session.consult(`story_postcondition_count(${postconditionCount}).`);
  session.consult(`story_conflict_decl_count(${conflictDeclCount}).`);
  session.consult("story_registry_exists(true).");

  return { loaded: true, count, storyIds, activeStoryIds, retiredStoryIds };
}

// ═══════════════════════════════════════════════════════════
// Fact extraction: state.json → Prolog facts
// RT-AUDIT-C2: Read current_state from state.json (canonical), not unsigned state.md.
// ═══════════════════════════════════════════════════════════

export function loadStateFacts(session, { cwd, skillPath, transientCloseSignals = null }) {
  const plannerPlan = resolvePlannerPlanContext(cwd);
  if (!plannerPlan) return { loaded: false };

  const { planDirName, planDir, plansDir } = plannerPlan;
  const facts = {};
  const findingsTruth = resolveFindingsTruth(planDir);
  const effectiveFindings = findingsTruth.effective;

  // H1-FIX: Read state.json ONCE and reuse. Previously read 3 times (TOCTOU risk).
  const stateJson = readStateJson(planDir);
  const closeSignals = transientCloseSignals || stateJson?.close_signals || null;

  // RT-AUDIT-C2 + RT-REDTEAM-H1: Read current state ONLY from state.json.
  if (stateJson?.state) {
    facts.state = stateJson.state.toLowerCase();
    session.consult(`current_state(${facts.state}).`);
  } else {
    facts.state = "unknown";
    session.consult("current_state(unknown).");
    session.consult("state_source_degraded(true).");
    debugLog("rule_engine", "WARNING: state.json missing or corrupt — asserting current_state(unknown)");
  }

  const sessionObligations = loadSessionObligations(planDir);
  session.consult(`session_assumption_tracking_enabled(${sessionObligations.assumptions.length > 0 ? "true" : "false"}).`);
  if (sessionObligations.assumptions.length === 0) {
    session.consult("session_assumption(none, validated, false, false).");
  } else {
    for (const assumption of sessionObligations.assumptions) {
      const id = sanitizeStrictId(assumption.id);
      const status = sanitizeEnumAtom(assumption.status);
      session.consult(`session_assumption(${id}, ${status}, ${assumption.load_bearing ? "true" : "false"}, ${assumption.cited_as_support ? "true" : "false"}).`);
    }
  }

  // Parse findings.md using the same counting/depth rules as verify_gate.mjs.
  // This avoids JS/Prolog split-brain failures where one layer treats markdown,
  // structured ledgers, preambles, or fast-track mode differently from the other.
  if (findingsTruth.issues.length > 0) {
    debugLog("fact_loader", findingsTruth.issues.join("; "));
  }
  if (effectiveFindings) {
    const depth = effectiveFindings.depth;
    facts.findingsCount = effectiveFindings.findingCount;
    session.consult(`findings_count(${facts.findingsCount}).`);
    const hasDepth = facts.findingsCount > 0 && depth.hasDepth;
    session.consult(`findings_depth_ok(${hasDepth ? "true" : "false"}).`);
  } else {
    session.consult("findings_count(0).");
    session.consult("findings_depth_ok(false).");
  }

  // v7.3.0: assert plan shape + shape-derived minimum findings so the Prolog
  // layer matches the JS gate's shape-conditional thresholds. transitions.pl
  // uses findings_minimum(N) instead of hardcoded N=3.
  try {
    const intentInfo = stateJson ? loadIntentContract(planDir) : null;
    const intentContractRaw = intentInfo?.error ? null : intentInfo?.parsed || null;
    let plannedFiles = [];
    try {
      const planContent = readFileSync(join(planDir, "plan.md"), "utf-8");
      const filesSection = planContent.match(/##\s+Files\s+[Tt]o\s+[Mm]odify\s*\n([\s\S]*?)(?=\n##|$)/);
      if (filesSection) {
        plannedFiles = (filesSection[1].match(/^\s*[-*]\s+`?([^`\s]+)`?/gm) || [])
          .map((line) => line.replace(/^\s*[-*]\s+`?/, "").replace(/`?\s*$/, "").trim())
          .filter(Boolean);
      }
    } catch { /* tolerate */ }
    const shape = detectPlanShape({
      goalText: stateJson?.goal || "",
      plannedFiles,
      intentContract: intentContractRaw,
    });
    const safeShape = String(shape.primary || "unknown").replace(/[^a-z0-9_-]/gi, "_");
    session.consult(`plan_shape('${safeShape}').`);
    session.consult(`findings_minimum(${shapeMinFindings(shape)}).`);
    facts.planShape = safeShape;
    facts.findingsMinimum = shapeMinFindings(shape);
  } catch (err) {
    debugLog("fact_loader", `plan_shape detection failed: ${err.message}`);
    session.consult("plan_shape('unknown').");
    session.consult("findings_minimum(3).");
  }

  try {
    if (process.env.PLANNER_TEST_THROW_IVE_IDEATION === "1") {
      throw new Error("test-forced IVE ideation extraction crash");
    }
    for (const fact of compileIveIdeationFacts({ cwd, planDir }).facts || []) {
      session.consult(fact);
    }
  } catch (err) {
    debugLog("fact_loader", `IVE ideation fact extraction failed: ${err.message}`);
    const phase3Required = inferIvePhase3RequiredOnExtractionError({ cwd, planDir });
    session.consult(`ive_phase3_required(${phase3Required ? "true" : "false"}).`);
    session.consult("ive_ideation_status('error').");
    session.consult("ive_ideation_anchor_count(0).");
    session.consult("ive_ideation_imperative_count(0).");
    session.consult("ive_ideation_operator_count(0).");
  }

  try {
    for (const fact of compileIveReflectionDiffFacts({ cwd, planDir }).facts || []) {
      session.consult(fact);
    }
  } catch (err) {
    debugLog("fact_loader", `IVE reflection-diff fact extraction failed: ${err.message}`);
    session.consult("ive_phase4_required(false).");
    session.consult("ive_phase4_6_required(false).");
    session.consult("ive_reflection_diff_status('error').");
  }

  try {
    const novelInsightFloor = evaluateNovelInsightFloor({ cwd, planDir, stateJson });
    for (const fact of compileNovelInsightFloorFacts(novelInsightFloor)) {
      session.consult(fact);
    }
  } catch (err) {
    debugLog("fact_loader", `Novel insight floor fact extraction failed: ${err.message}`);
    for (const fact of compileNovelInsightFloorFacts({
      required: false,
      waived: false,
      windowCount: 0,
      warningThreshold: 2,
      threshold: 3,
      decisionCount: 0,
      lessonCount: 0,
      riskCount: 0,
      insightCount: 0,
      status: "error",
      detail: "I-050 novel-insight floor fact extraction failed; JS gate owns the operator-facing failure."
    })) {
      session.consult(fact);
    }
  }

  // RT2-003: KB digest verification
  const knowledgeDir = join(plansDir, "knowledge");
  const kbIndexPath = join(knowledgeDir, "index.md");
  let kbReadProven = false;
  // H1-FIX: Reuse single stateJson read instead of calling readStateJson again.
  const kbDigestHash = stateJson?.kb_digest_hash;
  const kbDigestSalt = findingsTruth.json?.kbDigestSalt || findingsTruth.markdown?.kbDigestSalt || null;

  if (kbDigestHash && existsSync(kbIndexPath) && kbDigestSalt) {
    if (new RegExp(`^[0-9a-f]{${KB_SALT_HEX_LEN}}$`).test(kbDigestSalt)) {
      const kbFiles = ["index.md", "mistakes.md", "patterns.md", "gotchas.md"];
      let kbContent = "";
      for (const f of kbFiles) {
        const p = join(knowledgeDir, f);
        if (existsSync(p)) kbContent += readFileSync(p, "utf-8");
      }
      const candidateHash = createHash("sha256").update(kbDigestSalt + kbContent).digest("hex").slice(0, 32);
      kbReadProven = candidateHash === kbDigestHash;
    }
  } else if (kbDigestHash && existsSync(kbIndexPath) && !kbDigestSalt) {
    // Structured rollout: a hash without any persisted salt proof is still a FAIL.
    kbReadProven = false;
    debugLog("rule_engine", "KB digest hash set but no findings KB digest salt was found — KB read not proven");
  } else if (!kbDigestHash && existsSync(kbIndexPath)) {
    // Bootstrap catch-22: no salt exists yet because the transition hasn't succeeded yet.
    // JS gate verification already downgrades this first-run state to WARN so the
    // transition can generate kb_digest_hash and reveal the salt. Prolog must mirror
    // that behavior or explore->plan hits a false M4-FIX divergence on otherwise-valid
    // first runs.
    kbReadProven = true;
    debugLog("rule_engine", "KB digest: no hash yet — treating as bootstrap first run");
  } else if (!existsSync(kbIndexPath)) {
    kbReadProven = true;
  }
  session.consult(`kb_read(${kbReadProven ? "true" : "false"}).`);

  // Check plan.md
  const planPath = join(planDir, "plan.md");
  if (existsSync(planPath)) {
    const plan = readFileSync(planPath, "utf-8");
    session.consult(`problem_statement(${plan.includes("## Problem Statement") && !plan.includes("To be defined during PLAN") ? "true" : "false"}).`);
    session.consult(`files_listed(${extractFilesToModify(plan).length > 0 ? "true" : "false"}).`);
    const hasVerificationStrategy = plan.includes("## Verification Strategy") && !plan.match(/## Verification Strategy\s*\n\*To be defined/);
    session.consult(`verification_strategy(${hasVerificationStrategy ? "true" : "false"}).`);
  } else {
    session.consult("problem_statement(false). files_listed(false). verification_strategy(false).");
  }

  // Check verification.md
  // RT3-C2-FIX: Strengthened proof_of_work check. Previously an LLM could:
  //   - Add a trivial code block with >10 chars to fake proof
  //   - Write "UNVERIFIED: Requires manual user validation" to bypass
  // Now: code blocks must contain ≥3 distinct lines with content, AND
  // the total verification.md must have ≥50 unique words.
  const verificationPath = join(planDir, "verification.md");
  if (existsSync(verificationPath)) {
    const ver = readFileSync(verificationPath, "utf-8");
    const verificationTruth = deriveVerificationTruth({ cwd, planDir, verificationContent: ver });
    session.consult(`all_verification_pass(${verificationTruth.allVerificationPass ? "true" : "false"}).`);
    // RT5-H3: UNVERIFIED marker no longer satisfies proof_of_work.
    // It now sets a separate needs_manual_validation fact. An LLM could
    // trivially write the UNVERIFIED string + filler words to bypass.
    const hasUnverified = ver.includes("UNVERIFIED: Requires manual user validation");
    session.consult(`proof_of_work(${verificationTruth.proofOfWork ? "true" : "false"}).`);
    session.consult(`needs_manual_validation(${hasUnverified ? "true" : "false"}).`);
  } else {
    session.consult("all_verification_pass(false). proof_of_work(false).");
  }

  // Check progress.md
  const progressPath = join(planDir, "progress.md");
  if (typeof closeSignals?.progress?.blocking_satisfied === "boolean") {
    session.consult(`progress_complete(${closeSignals.progress.blocking_satisfied ? "true" : "false"}).`);
  } else if (typeof closeSignals?.progress?.satisfied === "boolean") {
    // Legacy snapshots predate the explicit blocking-only projection.
    session.consult(`progress_complete(${closeSignals.progress.satisfied ? "true" : "false"}).`);
  } else if (existsSync(progressPath)) {
    const prog = readFileSync(progressPath, "utf-8");
    const uncompleted = (prog.match(/- \[ \]/g) || []).length;
    session.consult(`progress_complete(${uncompleted === 0 ? "true" : "false"}).`);
  } else {
    session.consult("progress_complete(false).");
  }

  // KB updated
  if (typeof closeSignals?.kb?.satisfied === "boolean") {
    session.consult(`kb_updated(${closeSignals.kb.satisfied ? "true" : "false"}).`);
  } else {
    const kbFiles = ["mistakes.md", "patterns.md", "gotchas.md"];
    const kbHasEntries = kbFiles.some(f => {
      const p = join(knowledgeDir, f);
      if (!existsSync(p)) return false;
      const content = readFileSync(p, "utf-8");
      return /^## [MPG]-\d+/m.test(content);
    });
    session.consult(`kb_updated(${kbHasEntries ? "true" : "false"}).`);
  }

  const plannerCoreSignal = closeSignals?.planner_core || null;
  session.consult(`migration_smoke_satisfied(${closeSignalSatisfiedAtom(plannerCoreSignal)}).`);

  const testEvidenceSignal = closeSignals?.test_evidence || null;
  session.consult(`test_evidence_satisfied(${closeSignalSatisfiedAtom(testEvidenceSignal)}).`);

  const antiRecurrenceSignal = closeSignals?.anti_recurrence || null;
  session.consult(`anti_recurrence_required(${closeSignalRequiredAtom(antiRecurrenceSignal)}).`);
  session.consult(`anti_recurrence_satisfied(${closeSignalSatisfiedAtom(antiRecurrenceSignal)}).`);

  const intentEvidenceSignal = closeSignals?.intent_evidence || null;
  session.consult(`intent_evidence_satisfied(${closeSignalSatisfiedAtom(intentEvidenceSignal)}).`);

  const semanticSubstrateSignal = closeSignals?.semantic_substrate || null;
  session.consult(`semantic_substrate_required(${closeSignalRequiredAtom(semanticSubstrateSignal)}).`);
  session.consult(`semantic_substrate_satisfied(${closeSignalSatisfiedAtom(semanticSubstrateSignal)}).`);
  session.consult(`semantic_substrate_scope_degraded(${closeSignals?.semantic_substrate?.scope_degraded ? "true" : "false"}).`);
  session.consult(`semantic_substrate_scan_scope_used(${sanitizeEnumAtom(closeSignals?.semantic_substrate?.scan_scope_used || "planned_plus_nearby")}).`);
  session.consult(`semantic_substrate_scope_degraded_reason(${sanitizeEnumAtom(closeSignals?.semantic_substrate?.scope_degraded_reason || "none")}).`);
  const relevanceEvidence = closeSignals?.semantic_substrate?.relevance_evidence || {};
  session.consult(`semantic_substrate_relevance(config, ${sanitizeEnumAtom(relevanceEvidence.config || "none")}).`);
  session.consult(`semantic_substrate_relevance(story_semantics, ${sanitizeEnumAtom(relevanceEvidence.story_semantics || "none")}).`);

  for (const gapId of Array.isArray(closeSignals?.semantic_substrate?.advisory_gap_ids) ? closeSignals.semantic_substrate.advisory_gap_ids : []) {
    session.consult(`semantic_substrate_gap(${sanitizeEnumAtom(gapId)}).`);
  }
  for (const gapId of Array.isArray(closeSignals?.semantic_substrate?.blocking_gap_ids) ? closeSignals.semantic_substrate.blocking_gap_ids : []) {
    session.consult(`semantic_substrate_blocking_gap(${sanitizeEnumAtom(gapId)}).`);
  }

  const quantResultsValidation = closeSignals?.quant_results_validation || null;
  session.consult(`quant_results_validation_required(${closeSignalRequiredAtom(quantResultsValidation)}).`);
  session.consult(`quant_results_validation_satisfied(${closeSignalSatisfiedAtom(quantResultsValidation)}).`);
  session.consult(`quant_results_validation_status(${sanitizeEnumAtom(closeSignalStatusValue(quantResultsValidation))}).`);
  session.consult(`quant_results_evidence_validity(${sanitizeEnumAtom(quantResultsValidation?.evidence_validity || "not_required")}).`);
  session.consult(`quant_results_claim_support_allowed(${quantResultsValidation?.claim_support_allowed === true ? "true" : "false"}).`);
  session.consult(`quant_results_numeric_output_reportable(${quantResultsValidation?.numeric_output_reportable === true ? "true" : "false"}).`);
  const environmentReceipt = quantResultsValidation?.environment_preflight_receipt || null;
  session.consult(`quant_results_environment_preflight_status(${sanitizeEnumAtom(environmentReceipt?.status || "not_available")}).`);
  session.consult(`quant_results_environment_preflight_performed(${environmentReceipt?.performed === true ? "true" : "false"}).`);
  session.consult(`quant_results_environment_preflight_probe_count(${Number.isInteger(environmentReceipt?.probe_count) ? environmentReceipt.probe_count : 0}).`);
  if (quantResultsValidation?.run_class) {
    session.consult(`quant_results_run_class(${sanitizeEnumAtom(quantResultsValidation.run_class)}).`);
  }
  if (quantResultsValidation?.promotion_verdict) {
    session.consult(`quant_results_promotion_verdict(${sanitizeEnumAtom(quantResultsValidation.promotion_verdict)}).`);
  }
  for (const issue of Array.isArray(quantResultsValidation?.blocking_issues) ? quantResultsValidation.blocking_issues : []) {
    session.consult(`quant_results_blocking_issue(${sanitizeEnumAtom(issue)}).`);
  }

  try {
    const quantGateFacts = compileQuantGateHardeningFacts({ cwd, planDir, stateJson });
    if (quantGateFacts?.prolog) session.consult(quantGateFacts.prolog);
  } catch (err) {
    debugLog("fact_loader", `Quant gate hardening fact extraction failed: ${err.message}`);
    session.consult("quant_optimization_scale_required(false).");
    session.consult("quant_optimization_scale_status('error').");
    session.consult("quant_run_class_interpretive(false).");
    session.consult("quant_run_class_quick_evidence(false).");
    session.consult("quant_run_class_discovered_budget_unknown(true).");
    session.consult("quant_leakage_proof_artifact_required(false).");
    session.consult("quant_leakage_proof_artifact_status(error).");
    session.consult("quant_leakage_proof_artifact_row_count(0).");
  }

  try {
    const avaFacts = compileAvaFacts({ planDir, repoRoot: cwd });
    if (avaFacts?.prolog) session.consult(avaFacts.prolog);
  } catch (error) {
    session.consult("ava_report_present(true).");
    session.consult(`ava_artifact_error(${sanitizeEnumAtom(`compile_failed_${error?.message || "unknown"}`)}).`);
  }

  const reviewIntake = closeSignals?.review_intake || null;
  session.consult(`review_intake_required(${closeSignalRequiredAtom(reviewIntake)}).`);
  session.consult(`review_intake_satisfied(${closeSignalSatisfiedAtom(reviewIntake)}).`);
  const unresolvedReviewCount = Number.isFinite(Number(reviewIntake?.unresolved_required_count))
    ? Math.max(0, Math.trunc(Number(reviewIntake.unresolved_required_count)))
    : 0;
  session.consult(`review_intake_unresolved_required_count(${unresolvedReviewCount}).`);

  // Root cause documented
  if (effectiveFindings) {
    session.consult(`root_cause_documented(${effectiveFindings.hasRootCause ? "true" : "false"}).`);
  } else {
    session.consult("root_cause_documented(false).");
  }

  // RT-REDTEAM-M2 + RT3-C2-FIX: Red-team documentation check.
  // Use the same guide-first pass boundary as verify_gate.mjs. Missing
  // mitigation/depth on an extra ornamental heading remains visible there as
  // an advisory, but it must not turn three substantive vectors into
  // red_team_documented(false) and create a JS/Prolog divergence.
  const redTeamPath = join(planDir, "red_team_notes.md");
  if (existsSync(redTeamPath)) {
    const rtContent = readFileSync(redTeamPath, "utf-8");
    const analysis = analyzeRedTeamNotes(rtContent);
    const isDocumented =
      analysis.vectorCount >= 3 &&
      analysis.substantiveVectors >= 3;
    session.consult(`red_team_documented(${isDocumented ? "true" : "false"}).`);
  } else {
    session.consult("red_team_documented(false).");
  }

  // Tool trace coverage (I-016)
  // H1-FIX: Use consolidated stateJson reference (was kbStateJson, a separate read).
  // IDE-FIX (2026-04-03): When the IDE doesn't support trace capture (ide="unknown" or
  // "vscode-no-claude"), coverage_pct is 0 not because coverage is low but because the
  // trace mechanism is unavailable. Codex also skips the external hook audit by design.
  // Asserting trace_coverage(phase, 0) incorrectly fires I-016, so fall through to the
  // safe default (no violation possible) when trace capture is unsupported or not applicable.
  const traceIde = stateJson?.trace_summary?.ide || "unknown";
  const traceUnsupported = traceIde === "unknown" || traceIde === "vscode-no-claude" || traceIde === "codex" || traceIde === "antigravity";
  if (isFeatureEnabled("tool_trace") && !traceUnsupported && stateJson?.trace_summary?.coverage_pct !== undefined) {
    const phaseLower = (facts.state || "unknown").toLowerCase();
    const coveragePct = Math.round(Number(stateJson.trace_summary.coverage_pct) || 0);
    session.consult(`trace_coverage(${phaseLower}, ${coveragePct}).`);
  } else {
    session.consult("trace_coverage(unknown, 100).");
  }

  return { loaded: true, state: facts.state, planDir: planDirName };
}

// ═══════════════════════════════════════════════════════════
// Fact extraction: reflection.md (structured REFLECT contract)
// Feeds invariants I-044..I-047. All facts are gated downstream by
// current_state(reflect) in invariants.pl, so they never affect non-REFLECT
// plans. A missing reflection.md or guide asserts nothing (no false blocks).
// ═══════════════════════════════════════════════════════════

export function loadReflectionFacts(session, { cwd }) {
  let plannerPlan;
  try { plannerPlan = resolvePlannerPlanContext(cwd); } catch { plannerPlan = null; }
  if (!plannerPlan) return { loaded: false };

  const { planDir } = plannerPlan;
  const reflectionPath = join(planDir, "reflection.md");
  if (!existsSync(reflectionPath)) return { loaded: false };

  let v;
  try {
    v = validateReflection({ cwd, filePath: reflectionPath });
  } catch (e) {
    debugLog("rule_engine", `loadReflectionFacts: validateReflection failed: ${e.message}`);
    return { loaded: false };
  }

  session.consult("reflection_present(true).");

  // I-044: required-vs-answered structured reflection questions.
  const required = Number.isInteger(v?.required_question_count) ? v.required_question_count : 0;
  const answered = Number.isInteger(v?.answered_question_count) ? v.answered_question_count : 0;
  session.consult(`reflection_required_questions(${answered}, ${required}).`);

  let reflectionText = "";
  try { reflectionText = readFileSync(reflectionPath, "utf-8"); } catch { /* best effort */ }

  const requiredRetros = new Set();
  for (const qr of Array.isArray(v?.question_results) ? v.question_results : []) {
    const subject = sanitizeStrictId(qr?.subject_id || qr?.question_id || "unknown");
    const decision = String(qr?.decision || "");

    // I-045: a "known limitation" answer must name a follow-up story that exists.
    if (decision === "accept_as_known_limitation") {
      const storyIds = Array.isArray(qr?.followup_story_ids) ? qr.followup_story_ids.filter(Boolean) : [];
      if (storyIds.length === 0) {
        session.consult(`reflection_known_limitation_followup(${subject}, none).`);
      } else {
        for (const sid of storyIds) {
          session.consult(`reflection_known_limitation_followup(${subject}, ${sanitizeStrictId(sid)}).`);
        }
      }
    }

    // I-046: a pivot-back-to-execute decision means the plan must return to
    // EXECUTE, not advance toward VALIDATE.
    if (decision === "pivot_back_to_execute") {
      session.consult(`reflection_pivot_decision(${subject}).`);
    }

    // I-047: required retros must be explicitly named in the reflection.
    if (qr?.section_id === "relevant_retros" && qr?.required !== false && qr?.subject_id) {
      requiredRetros.add(String(qr.subject_id));
    }
  }

  for (const retroId of requiredRetros) {
    const atom = sanitizeStrictId(retroId);
    session.consult(`reflection_required_retro(${atom}).`);
    if (reflectionText.includes(retroId)) {
      session.consult(`reflection_addresses_retro(${atom}).`);
    }
  }

  return { loaded: true };
}

// ═══════════════════════════════════════════════════════════
// Retired by E8-1: in-process spot-check facts no longer participate in the
// Prolog substrate. Keep the loader name so rule_engine callers remain stable.
// ═══════════════════════════════════════════════════════════

export function loadSpotCheckFacts(session, { cwd }) {
  return { loaded: false, retired: true };
}

// ═══════════════════════════════════════════════════════════
// Fact extraction: source/config semantic hygiene facts
// ═══════════════════════════════════════════════════════════

export function loadSemanticHygieneFacts(session, { cwd = process.cwd() } = {}) {
  return loadSemanticHygieneScannerFacts(session, { cwd });
}

// ═══════════════════════════════════════════════════════════
// Fact extraction: scripts/*.mjs → capability/1
// ═══════════════════════════════════════════════════════════

export function loadCapabilityFacts(session, { skillPath, cwd = process.cwd() }) {
  const scriptsDir = join(skillPath, "scripts");
  if (!existsSync(scriptsDir)) return;
  // I-007-FIX (2026-04-03): Planner scripts are infrastructure, not project application code.
  // Auto-assert story coverage for all planner scripts so I-007 doesn't fire in project
  // registries. Projects don't need to add story_registry entries for transition.mjs, etc.
  // The reserved ID "_planner_infra" cannot conflict with real story IDs (must start US-/IP-).
  // I-008 (script_story_without_doc) is also satisfied because _planner_infra is not a real
  // story_covers_script entry checked by I-008 (I-008 checks code_ref stories, not synthetic ones).
  let hasScripts = false;
  for (const f of readdirSync(scriptsDir)) {
    if (!f.endsWith(".mjs")) continue;
    session.consult(`capability(${sanitizeAtom(f)}).`);
    session.consult(`story_covers_script('_planner_infra', ${sanitizeAtom(f)}).`);
    session.consult(`story_covers_script('_planner_infra', ${sanitizeStrictId(`.agent/skills/iterative-planner/scripts/${f}`)}).`);
    hasScripts = true;
  }
  const plannerInfraPrefixes = [
    ".agent/packs/",
    ".agent/skills/iterative-planner/",
    ".agent/skills/story-verification/",
    "tests/",
    "tools/planner-visualizer/",
  ];
  for (const entry of discoverSourceFiles(cwd).files) {
    if (!plannerInfraPrefixes.some((prefix) => entry.path.startsWith(prefix))) continue;
    session.consult(`story_covers_script('_planner_infra', ${sanitizeStrictId(entry.path)}).`);
    hasScripts = true;
  }
  if (hasScripts) {
    session.consult("story('_planner_infra', 'Iterative Planner Infrastructure', medium, fully_covered).");
    // Satisfy I-008 (script_story_without_doc): the planner's SKILL.md is the documentation.
    session.consult("doc_ref('_planner_infra', 'SKILL.md').");
  }
}

// ═══════════════════════════════════════════════════════════
// Fact extraction: gate ripple-through coverage (I-012, I-013, I-014)
// ═══════════════════════════════════════════════════════════

export function loadGateRippleFacts(session, { skillPath, cwd }) {
  const gatesJsonPath = join(skillPath, "config", "gates.json");
  let gates = ["explore-to-plan", "plan-to-execute", "execute-to-reflect", "reflect-to-validate", "validate-to-close", "notify-user"];
  if (existsSync(gatesJsonPath)) {
    try {
      const registry = JSON.parse(readFileSync(gatesJsonPath, "utf-8"));
      if (registry.gates) gates = Object.keys(registry.gates);
    } catch { /* use fallback */ }
  }

  const transitionPath = join(skillPath, "scripts", "transition.mjs");
  const transitionContent = existsSync(transitionPath) ? readFileSync(transitionPath, "utf-8") : "";
  for (const g of gates) {
    if (transitionContent.includes(g)) {
      session.consult(`gate_in_transition(${sanitizeAtom(g)}).`);
    }
  }

  const fcPath = join(skillPath, "config", "failure-codes.json");
  if (existsSync(fcPath)) {
    try {
      const fc = JSON.parse(readFileSync(fcPath, "utf-8"));
      const codesPerGate = new Set();
      for (const code of Object.values(fc.codes || {})) {
        if (code.gate) codesPerGate.add(code.gate);
      }
      for (const g of codesPerGate) {
        session.consult(`gate_has_failure_code(${sanitizeAtom(g)}).`);
      }
    } catch { /* skip malformed */ }
  }

  const checklistsDir = join(skillPath, "checklists");
  for (const g of gates) {
    const clPath = join(checklistsDir, `${g}.yaml`);
    const clPathYml = join(checklistsDir, `${g}.yml`);
    if (existsSync(clPath) || existsSync(clPathYml)) {
      session.consult(`gate_has_checklist(${sanitizeAtom(g)}).`);
    }
  }

  const docPaths = [
    join(skillPath, "SKILL.md"),
    join(cwd, "CLAUDE.md"),
    join(cwd, "GEMINI.md"),
    join(cwd, "AGENTS.md"),
  ];
  const docContent = docPaths
    .filter((docPath) => existsSync(docPath))
    .map((docPath) => readFileSync(docPath, "utf-8"))
    .join("\n");
  for (const g of gates) {
    if (docContent.includes(g)) {
      session.consult(`gate_in_skill_doc(${sanitizeAtom(g)}).`);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Fact extraction: gate history from state.json (I-015)
// ═══════════════════════════════════════════════════════════

export function loadGateHistoryFacts(session, { cwd, skillPath }) {
  const plannerPlan = resolvePlannerPlanContext(cwd);
  if (!plannerPlan) {
    session.consult("state_history_available(false).");
    return;
  }

  const { planDirName, planDir, source } = plannerPlan;
  let stateJson = readStateJson(planDir);

  if (!stateJson) {
    session.consult("state_history_available(true).");
    debugLog("rule_engine", `WARNING: state.json missing for plan ${planDirName} — gate chain enforcement active with no passes`);
    return;
  }

  // STALE-POINTER GUARD: If the pointer points to a CLOSE plan, treat as no active plan.
  // Prevents a stale .current_plan from loading closed-plan gate history as live state,
  // which can cause incorrect gate_passed facts to be asserted for the wrong plan.
  if (stateJson.state === 'CLOSE') {
    debugLog("rule_engine", `Target plan (${source || "unknown"}): ${planDirName} is in CLOSE state — asserting state_history_available(false)`);
    session.consult("state_history_available(false).");
    return;
  }

  if (!Array.isArray(stateJson.transitions) || stateJson.transitions.length === 0) {
    session.consult("state_history_available(true).");
    return;
  }

  session.consult("state_history_available(true).");

  const gatesJsonPath = join(skillPath, "config", "gates.json");
  const stateToGate = new Map();
  if (existsSync(gatesJsonPath)) {
    try {
      const registry = JSON.parse(readFileSync(gatesJsonPath, "utf-8"));
      for (const [gateName, def] of Object.entries(registry.gates || {})) {
        const sources = Array.isArray(def.from) ? def.from : [def.from];
        for (const src of sources.filter(Boolean)) {
          const key = `${src.toLowerCase()}_${(def.to || "").toLowerCase()}`;
          stateToGate.set(key, gateName);
        }
      }
    } catch { /* use empty map */ }
  }

  for (const t of stateJson.transitions) {
    // IS_FORCED GUARD: Skip FORCE-CLOSE transitions from gate chain analysis.
    // These are admin-only closures that should not be treated as gate executions.
    if (t.is_forced) continue;

    const from = (t.from || "").toLowerCase();
    const to = (t.to || "").toLowerCase();
    const gateName = stateToGate.get(`${from}_${to}`);
    if (!gateName) continue;

    const ts = sanitizeAtom(t.timestamp || "unknown");
    const result = canonicalVerificationStatus(t.gate_result, "gate", { fallback: "PENDING" });

    session.consult(`gate_attempted(${sanitizeAtom(gateName)}, ${sanitizeAtom(result)}, ${ts}).`);
    if (verificationStatusIsPass(t.gate_result, "gate")) {
      session.consult(`gate_passed(${sanitizeAtom(gateName)}, ${ts}).`);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Fact extraction: project meta → suggestions/completeness/repo_mode
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// Fact extraction: remediation queue (I-031)
// ═══════════════════════════════════════════════════════════

export function loadRemediationFacts(session, { cwd }) {
  const queuePath = join(cwd, "reports", "remediation_queue.md");
  if (!existsSync(queuePath)) {
    session.consult("remediation_queue_exists(false).");
    session.consult("pending_remediation_count(0).");
    session.consult("pending_high_remediation_count(0).");
    session.consult("remediation_queue_age_days(0).");
    return;
  }
  session.consult("remediation_queue_exists(true).");
  const content = safeRead(queuePath) || "";
  const lines = content.split("\n");
  const generatedLine = lines.find((line) => /^Generated:\s*/i.test(line));
  const generatedText = generatedLine ? generatedLine.replace(/^Generated:\s*/i, "").trim() : "";
  const generatedMs = Date.parse(generatedText);
  const ageDays = Number.isFinite(generatedMs)
    ? Math.max(0, Math.floor((Date.now() - generatedMs) / 86_400_000))
    : 0;

  let pendingCount = 0;
  let pendingHighCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 8) continue;
    if (/^#$/i.test(cells[0]) || /^id$/i.test(cells[1]) || cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    const severity = String(cells[3] || "").trim().toUpperCase();
    const status = String(cells[7] || "").trim().toUpperCase();
    if (!status.includes("PENDING")) continue;
    pendingCount++;
    if (severity === "HIGH") pendingHighCount++;
  }

  session.consult(`pending_remediation_count(${pendingCount}).`);
  session.consult(`pending_high_remediation_count(${pendingHighCount}).`);
  session.consult(`remediation_queue_age_days(${ageDays}).`);
}

export function loadProofTelemetryFacts(session, { cwd }) {
  const plannerPlan = resolvePlannerPlanContext(cwd);
  if (!plannerPlan) {
    session.consult("proof_telemetry_mode(unavailable).");
    session.consult("proof_telemetry_event_count(0).");
    session.consult("proof_telemetry_ignored_event_count(0).");
    return {
      enabled: isFeatureEnabled("proof_telemetry"),
      mode: "unavailable",
      trusted_events_count: 0,
      ignored_event_count: 0,
      surfaces: [],
      proof_events: [],
      task_signals: [],
      artifacts: [],
    };
  }

  const { planDir, planDirName } = plannerPlan;
  const planContent = safeRead(join(planDir, "plan.md")) || "";
  const stateJson = readStateJson(planDir);
  const summary = summarizeProofTelemetry({
    cwd,
    planDir,
    planDirName,
    goalText: typeof stateJson?.goal === "string" ? stateJson.goal : "",
    planContent,
    persist: true,
  });

  session.consult(`proof_telemetry_mode(${sanitizeEnumAtom(summary.mode)}).`);
  session.consult(`proof_telemetry_event_count(${Number(summary.trusted_events_count) || 0}).`);
  session.consult(`proof_telemetry_ignored_event_count(${Number(summary.ignored_event_count) || 0}).`);
  for (const surface of summary.surfaces || []) {
    session.consult(`touched_surface(${sanitizeEnumAtom(surface)}).`);
  }
  for (const signal of summary.task_signals || []) {
    session.consult(`task_signal(${sanitizeEnumAtom(signal)}).`);
  }
  for (const proof of summary.proof_events || []) {
    session.consult(`proof_event(${sanitizeEnumAtom(proof)}).`);
  }
  for (const artifact of summary.artifacts || []) {
    session.consult(`artifact_recorded(${sanitizeAtom(artifact)}).`);
  }

  return summary;
}

export function loadJournalFacts(session, { cwd }) {
  try {
    const compiled = compileJournalFacts({ cwd });
    for (const fact of compiled.facts || []) {
      session.consult(fact);
    }
    const memory = compileJournalMemoryFacts({ cwd });
    for (const fact of memory.facts || []) {
      session.consult(fact);
    }
    return { ...compiled, journal_memory: memory };
  } catch (e) {
    debugLog("rule_engine", `Journal fact extraction failed: ${e.message}`);
    session.consult("journal_present(false).");
    session.consult("journal_entry_count(0).");
    session.consult("journal_issue_count(1).");
    session.consult("journal_issue('loader_error', 0).");
    session.consult("journal_memory_record_count(0).");
    session.consult("journal_memory_issue_count(1).");
    session.consult("journal_memory_issue('loader_error', 'unknown', 'fact_loader').");
    return { present: false, entries: [], issues: [{ code: "loader_error", line: 0, detail: e.message }], facts: [] };
  }
}

export function loadProjectMetaFacts(session, { cwd, skillPath }) {
  const manifestoInfo = loadPlannerManifesto();
  const discoveryPolicyInfo = loadDiscoveryPolicy({ cwd });
  session.consult(`planner_manifesto_present(${manifestoInfo.present ? "true" : "false"}).`);
  session.consult(`planner_hard_policy_mode(${sanitizeEnumAtom(manifestoInfo.manifesto.hard_policy_mode)}).`);
  session.consult(`planner_ontology_role(${sanitizeEnumAtom(manifestoInfo.manifesto.ontology_role?.mode)}).`);
  for (const fact of buildNorthStarFacts(manifestoInfo.manifesto).facts) {
    session.consult(fact);
  }
  // t07: emit MEASURED metric facts from reports/backtests/*.json so the North
  // Star comparator (invariants.pl I-032) can fail a plan that declares a
  // threshold but measures below it.
  {
    const northStarMetricIds = (manifestoInfo.manifesto.core_metrics || []).map((m) => m.id).filter(Boolean);
    for (const fact of collectMetricActualFacts({ cwd, metricIds: northStarMetricIds })) {
      session.consult(fact);
    }
  }
  for (const issue of manifestoInfo.manifesto.parse_issues || []) {
    session.consult(`north_star_parse_issue(${sanitizeEnumAtom(issue.code)}, ${sanitizeAtom(issue.path || "unknown")}).`);
  }
  if (discoveryPolicyInfo.policy?.archetype) {
    session.consult(`project_archetype(${sanitizeEnumAtom(discoveryPolicyInfo.policy.archetype)}).`);
  }
  for (const policy of manifestoInfo.manifesto.hard_policies || []) {
    session.consult(`planner_hard_policy(${sanitizeEnumAtom(policy.id)}).`);
  }
  for (const antiGoal of manifestoInfo.manifesto.anti_goals || []) {
    session.consult(`planner_anti_goal(${sanitizeAtom(antiGoal)}).`);
  }
  for (const successSignal of manifestoInfo.manifesto.success_signals || []) {
    session.consult(`planner_success_signal(${sanitizeAtom(successSignal)}).`);
  }

  try {
    for (const fact of compileActiveOntologyFacts({ cwd }).facts || []) {
      session.consult(fact);
    }
  } catch (e) {
    debugLog("rule_engine", `Active ontology fact extraction failed: ${e.message}`);
  }

  loadJournalFacts(session, { cwd });

  if (!isFeatureEnabled("suggestion_engine")) return;

  // --- Git-derived facts ---
  try {
    const diffStat = execSync("git diff --stat HEAD 2>/dev/null || true", { cwd, encoding: "utf-8", timeout: 5000 });
    const filesChanged = (diffStat.match(/\d+ files? changed/) || ["0"])[0].match(/\d+/)?.[0] || "0";
    session.consult(`files_changed_count(${parseInt(filesChanged, 10)}).`);

    const diffNumstat = execSync("git diff --numstat HEAD 2>/dev/null || true", { cwd, encoding: "utf-8", timeout: 5000 });
    let linesAdded = 0;
    for (const line of diffNumstat.trim().split("\n")) {
      const parts = line.split("\t");
      if (parts[0] && parts[0] !== "-") linesAdded += parseInt(parts[0], 10) || 0;
    }
    session.consult(`lines_added_count(${linesAdded}).`);

    const untrackedRaw = execSync("git ls-files --others --exclude-standard 2>/dev/null || true", { cwd, encoding: "utf-8", timeout: 5000 });
    const newFiles = untrackedRaw.trim().split("\n").filter(l => l.trim()).length;
    session.consult(`new_files_count(${newFiles}).`);

    const authorLog = execSync("git log --format='%ae' -50 2>/dev/null || true", { cwd, encoding: "utf-8", timeout: 5000 });
    const authors = new Set(authorLog.trim().split("\n").filter(l => l.trim()));
    const mode = authors.size <= 1 ? "solo" : "collaborative";
    session.consult(`repo_mode(${mode}).`);

    const diffFiles = execSync("git diff --name-only HEAD 2>/dev/null || true", { cwd, encoding: "utf-8", timeout: 5000 });
    const sharedPatterns = /\b(lib|shared|core|utils|config|common)\b/i;
    const touchesShared = diffFiles.split("\n").some(f => sharedPatterns.test(f));
    session.consult(`touches_shared_module(${touchesShared ? "true" : "false"}).`);

    const authPatterns = /\b(auth|login|session|token|credential|password|oauth|jwt)\b/i;
    const paymentPatterns = /\b(payment|billing|stripe|charge|invoice|subscription)\b/i;
    const touchesAuth = diffFiles.split("\n").some(f => authPatterns.test(f));
    const touchesPayments = diffFiles.split("\n").some(f => paymentPatterns.test(f));
    session.consult(`touches_auth(${touchesAuth ? "true" : "false"}).`);
    session.consult(`touches_payments(${touchesPayments ? "true" : "false"}).`);
  } catch (e) {
    debugLog("rule_engine", `Git fact extraction failed: ${e.message}`);
    session.consult("files_changed_count(0). lines_added_count(0). new_files_count(0).");
    session.consult("repo_mode(collaborative). touches_shared_module(false).");
    session.consult("touches_auth(false). touches_payments(false).");
  }

  // --- Audit staleness facts ---
  // Prefer legacy .audit-log.json when present, then fill missing facts from the
  // canonical workflow log written by escalation_check.mjs.
  const auditFacts = {
    redTeamDays: false,
    redTeamCommits: false,
    regressionCommits: false,
    userStoryDays: false,
  };
  const consultNonNegativeInteger = (fact, value) => {
    if (Number.isInteger(value) && value >= 0) session.consult(`${fact}(${value}).`);
  };
  const daysSince = (timestamp) => {
    const parsed = new Date(timestamp).getTime();
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.floor((Date.now() - parsed) / 86400000));
  };
  const commitsSince = (commit) => {
    const safeCommit = typeof commit === "string" && /^[0-9a-f]{7,40}$/i.test(commit.trim())
      ? commit.trim()
      : null;
    if (!safeCommit) return null;
    try {
      const output = execSync(`git rev-list ${safeCommit}..HEAD --count 2>/dev/null || true`, {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const parsed = Number.parseInt(output, 10);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    } catch {
      return null;
    }
  };
  const latestAudit = (auditLog, aliases) => {
    const aliasSet = new Set(aliases);
    return (Array.isArray(auditLog?.audits) ? auditLog.audits : [])
      .filter((entry) => entry && typeof entry === "object" && aliasSet.has(String(entry.type || "")))
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())[0] || null;
  };

  const legacyAuditLogPath = join(cwd, ".audit-log.json");
  if (existsSync(legacyAuditLogPath)) {
    try {
      const auditLog = JSON.parse(readFileSync(legacyAuditLogPath, "utf-8"));
      if (auditLog.last_red_team) {
        consultNonNegativeInteger("last_red_team_days", daysSince(auditLog.last_red_team));
        auditFacts.redTeamDays = true;
      }
      if (typeof auditLog.red_team_commits_since === "number") {
        consultNonNegativeInteger("last_red_team_commits", auditLog.red_team_commits_since);
        auditFacts.redTeamCommits = true;
      }
      if (typeof auditLog.regression_commits_since === "number") {
        consultNonNegativeInteger("last_regression_commits", auditLog.regression_commits_since);
        auditFacts.regressionCommits = true;
      }
      if (auditLog.last_user_story) {
        consultNonNegativeInteger("last_user_story_days", daysSince(auditLog.last_user_story));
        auditFacts.userStoryDays = true;
      }
    } catch (e) {
      debugLog("rule_engine", `Legacy audit log parse failed: ${e.message}`);
  }
}

  const workflowAuditLogPath = join(cwd, "plans", "audit_log.json");
  if (existsSync(workflowAuditLogPath)) {
    try {
      const auditLog = JSON.parse(readFileSync(workflowAuditLogPath, "utf-8"));
      const redTeam = latestAudit(auditLog, ["red-team", "red_team", "red_team_audit"]);
      const regression = latestAudit(auditLog, ["regression", "regression-audit", "regression_audit"]);
      const userStory = latestAudit(auditLog, ["user-story", "user_story", "user_story_audit"]);

      if (redTeam && !auditFacts.redTeamDays) {
        consultNonNegativeInteger("last_red_team_days", daysSince(redTeam.timestamp));
        auditFacts.redTeamDays = true;
      }
      if (redTeam && !auditFacts.redTeamCommits) {
        consultNonNegativeInteger("last_red_team_commits", commitsSince(redTeam.covers_commit || redTeam.commit));
        auditFacts.redTeamCommits = true;
      }
      if (regression && !auditFacts.regressionCommits) {
        consultNonNegativeInteger("last_regression_commits", commitsSince(regression.covers_commit || regression.commit));
        auditFacts.regressionCommits = true;
      }
      if (userStory && !auditFacts.userStoryDays) {
        consultNonNegativeInteger("last_user_story_days", daysSince(userStory.timestamp));
        auditFacts.userStoryDays = true;
      }
    } catch (e) {
      debugLog("rule_engine", `Workflow audit log parse failed: ${e.message}`);
    }
  }

  // --- Plan-derived facts ---
  const plannerPlan = resolvePlannerPlanContext(cwd);
  if (plannerPlan) {
    const { planDir } = plannerPlan;

    // H2-FIX: Derive metrics from state.json transitions (canonical), not state.md (unsigned text).
    // Previously an LLM could edit state.md to inject/remove keywords and manipulate Prolog facts.
    const planStateJson = readStateJson(planDir);
    if (planStateJson?.transitions) {
      const replanCount = planStateJson.transitions.filter(t =>
        (t.to || "").toUpperCase() === "RE_PLAN" || (t.from || "").toUpperCase() === "RE_PLAN"
      ).length;
      // Leash hits and drift warnings must now be tracked in state.json if needed.
      // For backward compat, check for optional fields on transition records.
      let leashHits = 0;
      let driftWarnings = 0;
      for (const t of planStateJson.transitions) {
        if (t.leash_hit) leashHits++;
        if (t.drift_warning) driftWarnings++;
      }
      session.consult(`replan_count(${replanCount}).`);
      session.consult(`leash_hit_count(${leashHits}).`);
      session.consult(`drift_warning_count(${driftWarnings}).`);
    } else {
      session.consult("replan_count(0). leash_hit_count(0). drift_warning_count(0).");
    }

    const progressPath = join(planDir, "progress.md");
    if (existsSync(progressPath)) {
      const prog = readFileSync(progressPath, "utf-8");
      const iterations = (prog.match(/- \[x\]/gi) || []).length;
      session.consult(`iteration_count(${iterations}).`);
    } else {
      session.consult("iteration_count(0).");
    }

    const planPath = join(planDir, "plan.md");
    if (existsSync(planPath)) {
      const plan = readFileSync(planPath, "utf-8");
      session.consult(`error_paths_documented(${/error.?path|error.?handling|failure.?mode/i.test(plan) ? "true" : "false"}).`);
      session.consult(`edge_cases_documented(${/edge.?case|boundary|corner.?case/i.test(plan) ? "true" : "false"}).`);
    } else {
      session.consult("error_paths_documented(false). edge_cases_documented(false).");
    }
  } else {
    session.consult("replan_count(0). leash_hit_count(0). drift_warning_count(0). iteration_count(0).");
    session.consult("error_paths_documented(false). edge_cases_documented(false).");
  }

  // --- Security audit status ---
  const secAuditPath = join(cwd, "reports", "security_audit");
  session.consult(`security_audit_done(${existsSync(secAuditPath) ? "true" : "false"}).`);

  // --- Reachability audit status (RT6-H3) ---
  // The suggestion is project-level memory: a fresh active plan must not erase
  // historical reachability proof from canonical plan states or the audit log.
  const reachabilityDone = projectHasReachabilityAuditEvidence({ cwd, skillPath, plannerPlan });
  session.consult(`reachability_audit_done(${reachabilityDone ? "true" : "false"}).`);

  // --- External API detection ---
  const pkgPath = join(cwd, "package.json");
  let hasExternalApi = false;
  if (existsSync(pkgPath)) {
    try {
      const pkg = readFileSync(pkgPath, "utf-8");
      hasExternalApi = /fetch|axios|got|request|http|api/i.test(pkg);
    } catch (_) { /* ignore */ }
  }
  session.consult(`has_external_api(${hasExternalApi ? "true" : "false"}).`);

  // --- Defaults for optional facts ---
  session.consult("breaking_change(false).");
  session.consult("search_required(false). search_completed(false).");
  session.consult("plan_options_count(1).");
}

// ═══════════════════════════════════════════════════════════
// Load Prolog rule files
// ═══════════════════════════════════════════════════════════

export function loadRules(session, { cwd, skillPath, transientOntologyFacts = "" }) {
  const prologDir = join(skillPath, "prolog");
  const loaded = [];
  const runtimeCoverageFailures = [];
  const coreRuleErrors = [];

  const strictMode = process.env.RULE_ENGINE_STRICT === "1";

  // RT4-M3: Load built-in rules FIRST so core predicates are authoritative.
  // project.pl loads AFTER — it can add facts but cannot override core rules
  // because Prolog resolves clauses in consultation order (first match wins
  // for deterministic predicates, and core rules always appear first).
  for (const file of (existsSync(prologDir) ? readdirSync(prologDir).sort() : [])) {
    if (!file.endsWith(".pl")) continue;
    try {
      session.consultFile(join(prologDir, file));
      loaded.push(file);
    } catch (e) {
      console.error(`  ⚠️  Error loading ${file}: ${e.message}`);
      coreRuleErrors.push(`${file}: ${e.message}`);
      if (strictMode) {
        console.error(`  ❌ Rule file load failure in strict mode — aborting (set RULE_ENGINE_STRICT=0 to warn-only)`);
        process.exit(2);
      }
    }
  }
  if (coreRuleErrors.length > 0) {
    runtimeCoverageFailures.push({
      check_id: "core_prolog_rule_bundle",
      cause: `Core Prolog rule file(s) failed to load: ${coreRuleErrors.join("; ")}`,
      cause_details: coreRuleErrors,
    });
  }
  session.consult(compileVerificationStatusFacts());

  // RT5-C1: Load project-specific rules AFTER built-in rules, with reserved
  // predicate blocklist. The Prolog interpreter yields on ANY matching clause,
  // so project.pl adding `can_transition(_, _).` would bypass all guards.
  // We read the file, strip any clauses for reserved predicates, then consult.
  // Narrow exception: safe one-line planner policy facts for forbidden_path/2,
  // privileged_state/1, and auth_gate/2 are allowed so host projects can
  // declare reachability policies without reopening arbitrary Prolog overrides.
  const RESERVED_PREDICATES = new Set([
    "can_transition", "gate_passed", "state_history_available",
    "kb_read", "findings_count", "findings_depth_ok",
    "proof_of_work", "all_verification_pass", "progress_complete",
    "red_team_documented", "kb_updated", "migration_smoke_satisfied", "test_evidence_satisfied", "anti_recurrence_required", "anti_recurrence_satisfied", "intent_evidence_satisfied", "semantic_substrate_required", "semantic_substrate_satisfied", "semantic_substrate_scope_degraded", "semantic_substrate_scan_scope_used", "semantic_substrate_scope_degraded_reason", "semantic_substrate_relevance", "semantic_substrate_gap", "semantic_substrate_blocking_gap", "quant_results_validation_required", "quant_results_validation_satisfied", "quant_results_validation_status", "quant_results_evidence_validity", "quant_results_claim_support_allowed", "quant_results_numeric_output_reportable", "quant_results_environment_preflight_status", "quant_results_environment_preflight_performed", "quant_results_environment_preflight_probe_count", "quant_results_run_class", "quant_results_promotion_verdict", "quant_results_blocking_issue", "quant_optimization_scale_required", "quant_optimization_scale_status", "quant_optimization_scale_section_present", "quant_optimization_scale_issue", "quant_run_class_interpretive", "quant_run_class_declared", "quant_run_class_quick_evidence", "quant_run_class_discovered_budget", "quant_run_class_discovered_budget_unknown", "quant_run_class_threshold", "quant_run_class_inflation_issue", "quant_leakage_proof_artifact_required", "quant_leakage_proof_artifact_status", "quant_leakage_proof_artifact_row_count", "quant_leakage_proof_artifact_run_class", "quant_leakage_proof_artifact_issue", "ava_report_present", "ava_artifact_error", "ava_verification_agent", "ava_agent_persona", "ava_sandbox_floor_satisfied", "ava_discovered_defect", "ava_defect_discovered_by", "ava_defect_type", "ava_defect_status", "ava_defect_story", "ava_defect_anchor", "review_intake_required", "review_intake_satisfied", "review_intake_unresolved_required_count", "has_external_api",
    "session_assumption_tracking_enabled", "session_assumption",
    "breaking_change", "search_required", "search_completed",
    "plan_options_count", "story", "story_dep", "story_status",
    "structural_transition", "forbidden_path", "privileged_state",
    "reachable", "gate_bypass", "auth_gate",
    "verification_ledger_present", "verification_obligation_tracking_enabled", "verification_status_token", "verification_status_accepts", "verification_result_status", "verification_result",
    "verification_subject", "verification_subject_alias", "subject_story", "subject_criterion",
    "subject_capability", "subject_journey", "verification_mode",
    "verification_supported", "verification_mode_declared_by",
    "verification_obligation", "obligation_source",
    "obligation_required_by_phase", "verification_evidence",
    "evidence_actor", "evidence_environment", "evidence_command",
    "evidence_trace", "evidence_artifact", "manual_ack",
    "verification_waiver", "waiver_reason", "waiver_approved_by",
    "waiver_expires_at", "pack_obligation", "active_obligation",
    "obligation_trust_tier", "obligation_provenance", "obligation_requires",
    "obligation_satisfied_by", "findings_ledger_present", "finding_record",
    "finding_story", "finding_file", "finding_tag", "finding_source",
    "retro_case", "retro_status", "retro_promotion_decision", "retro_failure_mode",
    "retro_discovered_phase", "retro_case_file", "retro_promoted_mistake",
    "mistake_registry_present", "mistake_registry_usable", "known_mistake", "mistake_summary",
    "mistake_family", "mistake_kb_ref", "mistake_originates_from_retro", "mistake_query_tag",
    "mistake_required_guard", "mistake_required_evidence", "mistake_recommended_annotation",
    "mistake_verification_hook", "mistake_obligation", "mistake_supersedes", "active_mistake",
    "active_mistake_trigger_family", "active_mistake_match", "obligation_source_mistake",
    "obligation_source_registry_degraded", "obligation_source_registry_status",
    "mistake_guard_declared", "mistake_hook_satisfied",
    "source_file", "file_marked_ignored", "file_ignore_reason",
    "config_key", "config_key_source",
    "intent_contract_present", "intent_contract_required", "intent_contract_invalid",
    "intent_primary_user", "intent_job_to_be_done", "intent_desired_outcome",
    "intent_anti_goal", "intent_constraint", "deliverable_contract",
    "deliverable_required", "deliverable_purpose", "deliverable_quality_bar",
    "deliverable_required_section", "deliverable_required_signal",
    "deliverable_anti_goal", "deliverable_evidence_mode",
    "planner_manifesto_present", "planner_manifesto_version", "planner_hard_policy_mode", "planner_north_star",
    "planner_ontology_role", "planner_hard_policy", "planner_anti_goal",
    "planner_success_signal", "project_archetype", "north_star_type", "north_star_policy_mode",
    "north_star_metric", "north_star_directive", "north_star_parse_issue",
    "north_star_threshold", "metric_actual", "metric_failed", "metric_below_threshold",
    "journal_present", "journal_entry_count", "journal_issue_count", "journal_issue",
    "journal_entry", "journal_type", "journal_status", "journal_confidence",
    "journal_summary", "journal_timestamp", "journal_topic", "journal_actor",
    "journal_ref", "journal_promoted_to", "journal_tag", "journal_linked_id",
    "journal_memory_role", "journal_created_at", "journal_valid_at", "journal_invalid_at",
    "journal_expired_at", "journal_project_key", "journal_superseded_by",
    "journal_supersedes", "journal_source_entry", "journal_key", "journal_verdict",
    "decision_anchor_entry", "decision_anchor_plan", "decision_anchor_decision",
    "decision_anchor_path", "decision_anchor_status",
    "contradicts", "journal_contradiction_key", "journal_queryable",
    "journal_memory_record_count", "journal_memory_issue_count", "journal_memory_role_count",
    "journal_memory_issue", "journal_memory_record", "journal_memory_source",
    "journal_memory_journal_entry", "journal_memory_source_path",
    "issue_history_cache", "issue_history_cache_status", "issue_history_cache_generated_at",
    "issue_history_cache_record_count", "issue_history_cache_issue",
    "issue_history_record", "issue_history_record_repo", "issue_state", "issue_title",
    "issue_created", "issue_updated", "issue_closed", "issue_label",
    "issue_comment", "issue_comment_created", "issue_decision",
    "issue_decision_summary", "issue_blocker", "issue_blocker_resolved",
    "ticket_github_issue_ref", "ticket_cached_issue_state",
    "ticket_cached_issue_decision", "ticket_cached_blocker_resolved",
    "program_ticket_open_blocking_issue",
    "active_ontology_present", "active_ontology_integrity_status", "active_ontology_issue",
    "active_ontology_digest", "active_ontology_iteration", "active_ontology_delta",
    "active_ontology_triple", "active_ontology_current",
    "ive_phase3_required", "ive_ideation_status", "ive_ideation_anchor_count",
    "ive_ideation_imperative_count", "ive_ideation_operator_count",
    "operator_suppressed_by_triage", "ive_ideation_issue", "ive_ideation_warning",
    "anchor_ref_not_in_story", "imperative_unbound", "imperative_missing_from_contract",
    "scope_addition_unbound", "pre_mortem_risk_unaddressed",
    "novel_insight_floor_required", "novel_insight_floor_waived",
    "novel_insight_floor_window_count", "novel_insight_floor_threshold",
    "novel_insight_floor_warning_threshold", "novel_insight_count",
    "novel_insight_decision_count", "novel_insight_lesson_count",
    "novel_insight_risk_count", "novel_insight_floor_status",
    "novel_insight_floor_reason",
    "diagnostics_gate", "diagnostics_active_plan_poisoned",
    "diagnostics_simple_task", "diagnostics_full_flow", "canonicalization_applied",
    "story_postcondition_count", "story_conflict_decl_count", "declared_story_conflict",
    "pending_high_remediation_count", "remediation_queue_age_days",
    "diagnostics_pending_high_remediation_count", "diagnostics_remediation_age_days",
    "diagnostics_adjacency_required", "diagnostics_adjacency_populated",
    "diagnostics_adjacency_explicit_na", "diagnostics_adjacency_candidate_count",
    "diagnostics_domain_checklist_required", "diagnostics_domain_checklist_present",
    "diagnostics_domain_checklist_placeholder", "diagnostics_config_flag_context",
    "diagnostics_mutually_exclusive_declared", "diagnostics_stateful_flow_context",
    "proof_telemetry_mode", "proof_telemetry_event_count", "proof_telemetry_ignored_event_count",
    "touched_surface", "task_signal", "proof_event", "artifact_recorded",
    "semantic_block", "repairable_variance", "recommended_recovery",
    "minimal_repair_item", "next_best_action",
  ]);
  const projectPl = join(cwd, "prolog", "project.pl");
  if (existsSync(projectPl)) {
    try {
      const raw = readFileSync(projectPl, "utf-8");
      // Filter out clauses whose head matches a reserved predicate
      // R5-001-FIX: Block Prolog directives that assert/retract reserved predicates.
      // An LLM can bypass the head-match filter with `:- assert(can_transition(...))`.
      const DANGEROUS_BUILTINS = /\b(assert[az]?|retract[az]?|abolish|consult|load_files|use_module)\b/;
      const filtered = raw.split("\n").filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("%")) return true; // keep comments/blanks
        const headMatch = trimmed.match(/^([a-z_][a-z0-9_]*)\s*[\(:.-]/);
        if (headMatch && SAFE_POLICY_PREDICATES.has(headMatch[1])) {
          if (isSafePlannerPolicyFact(trimmed)) return true;
          console.error(`  ⚠️  project.pl: skipping unsafe policy clause for '${headMatch[1]}' — only simple ground facts are allowed`);
          return false;
        }
        // Block directives (:- ...) that call dangerous builtins or reference reserved predicates
        if (trimmed.startsWith(":-")) {
          if (DANGEROUS_BUILTINS.test(trimmed)) {
            console.error(`  ⚠️  project.pl: skipping directive with dangerous builtin — cannot assert/retract/consult`);
            return false;
          }
          for (const rp of RESERVED_PREDICATES) {
            if (trimmed.includes(rp)) {
              console.error(`  ⚠️  project.pl: skipping directive referencing reserved predicate '${rp}'`);
              return false;
            }
          }
        }
        if (headMatch && RESERVED_PREDICATES.has(headMatch[1])) {
          console.error(`  ⚠️  project.pl: skipping reserved predicate '${headMatch[1]}' — cannot override core rules`);
          return false;
        }
        return true;
      }).join("\n");
      session.consult(filtered);
      loaded.push("project.pl (project-specific, reserved predicates filtered)");
    } catch (e) {
      console.error(`  ⚠️  Error loading project.pl: ${e.message}`);
      runtimeCoverageFailures.push({
        check_id: "project_specific_prolog_rules",
        cause: `Selected project-specific Prolog rules failed to load: ${e.message}`,
        cause_details: [e.message],
      });
      if (strictMode) {
        console.error(`  ❌ Project rule load failure in strict mode — aborting...`);
        process.exit(2);
      }
    }
  }

  // Load ontology traceability facts from active plan directory (if generated by transition.mjs).
  // These facts (criterion_story, annotation_proves, verification_obligation, etc.) are
  // regenerated at every gate by ontology_serializer.mjs and enable both the legacy
  // HR-011 evidence-chain reasoning and the Phase 1 verification-ledger advisory warnings.
  // Non-blocking: missing or malformed facts file is silently skipped.
  try {
    if (typeof transientOntologyFacts === "string" && transientOntologyFacts.trim()) {
      session.consult(filterRuntimeCloseSignalFacts(transientOntologyFacts));
      loaded.push("ontology_facts (transient)");
    } else {
      const plannerPlan = resolvePlannerPlanContext(cwd);
      if (plannerPlan) {
        const factsPath = join(plannerPlan.planDir, "ontology_facts.pl");
        if (existsSync(factsPath)) {
          session.consult(filterRuntimeCloseSignalFacts(readFileSync(factsPath, "utf-8")));
          loaded.push("ontology_facts.pl");
        }
      }
    }
  } catch { /* non-blocking — ontology facts are supplementary */ }

  // Also load repo-level generated ontology facts from the canonical YAML
  // source documents. Do not consult .agent/ontology/facts.pl directly here:
  // that file is a compiled artifact and can become stale or hand-edited between
  // builds. Gates should reason over freshly rendered source facts.
  let repoFacts;
  try {
    repoFacts = buildOntologyFacts({ cwd, dryRun: true });
    if (repoFacts?.ok && typeof repoFacts.facts === "string" && repoFacts.facts.trim()) {
      session.consult(repoFacts.facts);
      loaded.push("ontology facts (generated from source)");
    }
  } catch (error) {
    repoFacts = {
      ok: false,
      issues: [`Ontology fact builder threw: ${error.message}`],
      warnings: [],
      facts: "",
    };
  }

  const degradedCoverage = assessDegradedCoverage({
    cwd,
    skillPath,
    repoOntologyBuildResult: repoFacts,
    runtimeFailures: runtimeCoverageFailures,
  });
  Object.defineProperty(loaded, "degraded_coverage", {
    value: degradedCoverage,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return loaded;
}
