#!/usr/bin/env node
// transition.mjs — Unified gate wrapper for iterative planner state transitions.
//
// Replaces the 3-command pattern (verify_gate + checklist_runner + project_health)
// with ONE command at each transition point.
//
// Usage:
//   node transition.mjs explore-to-plan      Run all checks for EXPLORE → PLAN
//   node transition.mjs plan-to-execute      Run all checks for PLAN → EXECUTE
//   node transition.mjs execute-to-reflect   Run all checks for EXECUTE → REFLECT (red-team gate)
//   node transition.mjs reflect-to-validate  Run all checks for REFLECT → VALIDATE
//   node transition.mjs validate-to-close    Run all checks for VALIDATE → CLOSE
//   node transition.mjs notify-user          Run all checks before presenting results
//   node transition.mjs refresh-registry     Re-sign an intentional registry change without changing phase
// Add --dry-run to execute the identical evaluator with persistence disabled.
//
// Exit codes: 0 = all pass (transition allowed), 1 = semantic FAIL, 3 = planner tool error.
// Zero dependencies — Node.js 18+.

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync, realpathSync } from "fs";
import { join, dirname, resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { captureEnvValues, restoreEnvValues } from "./lib/env_scope.mjs";
import { redactSecrets } from "./lib/provider_client.mjs";
import {
  prepareGateInputSnapshot,
  persistGateInputSnapshot,
  removeGateInputSnapshot,
} from "./lib/gate_input_snapshot.mjs";

const __filename = fileURLToPath(import.meta.url);
const cwd = process.cwd();
const skillPath = resolve(dirname(__filename), "..");

// Transition evaluation must be stable between dry-run and actual execution.
// Planner installation repair remains owned by bootstrap/status and migrate;
// it cannot run as an implicit, pre-evaluation transition mutation.

const {
  getPaths,
  PASS, WARN, FAIL, SKIP, check, printHeader, printSection, printResults, printSummary,
  getActivePlan, GATE_HISTORY_POISON_THRESHOLD, GATE_HISTORY_POISON_MARKER,
  summarizeGateFailureTail,
  syncActivePlanAlias, detectRecentNonActivePlanContext, formatNonActivePlanContextDetail,
  readPointer, resolvePlanTarget, clearThreadPlanTarget,
  loadFindingsLedger, syncFindingsMarkdownFromLedger,
} = await import("./lib/plan_utils.mjs");
const {
  isFeatureEnabled, loadConfig, readStateJson, readStateJsonWithProvenance, writeStateJsonResult, validateStateJson,
  appendDecisionLogResult, buildDecisionEntry, deriveGateDecision, writeProofTrace,
  hashAllScripts, nowISO, getReplayDir, loadReplayArtifacts,
  withFailureCode, getRuleBundleVersion, sortResults, KB_SALT_BYTES,
  validateDecisionLogChain, acquireStateLock,
} = await import("./lib/determinism.mjs");
const { runPersonaAuditGate, persistPersonaAuditArtifacts } = await import("./audit_runner.mjs");
const { runChecklist } = await import("./lib/checklist_runner.mjs");
const { recordGateMetrics } = await import("./lib/plan_metrics.mjs");
const { finalizeOwnedFileReplace, rollbackOwnedFileReplace } = await import("./lib/owned_file_replace.mjs");
const {
  recoverTransitionJournal,
  removeTransitionJournal,
  writeTransitionJournal,
} = await import("./lib/transition_journal.mjs");
const {
  buildTransitionReceipt,
  finalizeToolErrorTransition,
  normalizeGateResults,
  normalizeGateResultsForTransition,
  renderTransitionVerdict,
  writeTransitionReceipt,
} = await import("./lib/gate_verdict.mjs");
const { refreshPlanArtifacts } = await import("./lib/plan_refresh.mjs");
const { evaluatePreplanningScaffolding } = await import("./lib/preplanning_scaffolding.mjs");
const { buildScopeContract, writeScopeContract, summarizeScopeContract } = await import("./lib/scope_contract.mjs");
const { buildPhaseContract, resolveAuthorityProfile, resolveProofPosture } = await import("./lib/planner_phase_routing.mjs");
const { renderStateMarkdownFromJson } = await import("./lib/plan_artifact_renderer.mjs");
const { EXECUTED_TEST_GATES_FILE, TEST_GATED_TRANSITIONS, runExecutedTestGate, writeExecutedTestGateEvidence } = await import("./lib/autonomous_driver.mjs");
const { loadAgentOrchestrationConfig, validateAgentWhitelist } = await import("./lib/agent_orchestration.mjs");
const { readHealthDeltaAcknowledgement } = await import("./lib/health_delta_ack.mjs");
const { verificationStatusIsHardFailure, verificationStatusIsPass } = await import("./lib/verification_status_vocabulary.mjs");
const { classifySemanticDivergence } = await import("./lib/semantic_divergence.mjs");
const { validateCoverageContract } = await import("./story_registry.mjs");
const { plansDir, knowledgeDir } = getPaths(cwd);
const ACTIVE_PLAN_ALIAS_LABEL = "plans/ACTIVE_PLAN.md";
const RITUAL_TOOL_ERROR_CODE = "TOOL-RIT-001";
const TOOL_OUTPUT_EXCERPT_BYTES = 2048;

function gateResultBlocks(result) {
  return verificationStatusIsHardFailure(result.status, "gate");
}

function persistAutoModeKbDigestProof(planDir, kbDigestSalt) {
  if (!planDir || !kbDigestSalt) {
    return { persisted: false, mode: "none", detail: "No KB digest salt available to persist" };
  }

  const findingsPath = join(planDir, "findings.md");
  let ledgerUpdated = false;
  let ledgerError = null;
  const ledgerInfo = loadFindingsLedger(planDir);
  if (ledgerInfo.present && ledgerInfo.parsed) {
    try {
      const ledger = { ...ledgerInfo.parsed, kb_digest_salt: kbDigestSalt };
      writeFileSync(ledgerInfo.path, JSON.stringify(ledger, null, 2) + "\n");
      ledgerUpdated = true;
    } catch {
      ledgerError = "Could not update findings_ledger.json with KB digest salt";
    }
  }

  const syncResult = ledgerUpdated ? syncFindingsMarkdownFromLedger(planDir) : null;
  const needsMarkdownFallback = !ledgerUpdated || !syncResult?.synced;
  if (needsMarkdownFallback && existsSync(findingsPath)) {
    const kbTag = `[KB_DIGEST:${kbDigestSalt}]`;
    const currentFindings = readFileSync(findingsPath, "utf-8");
    if (!currentFindings.includes(kbTag)) {
      writeFileSync(findingsPath, currentFindings.trimEnd() + `\n\n${kbTag}\n`);
    }
    return {
      persisted: true,
      mode: ledgerUpdated ? "ledger+markdown" : "markdown",
      detail: ledgerUpdated
        ? "Stored in findings_ledger.json and preserved in findings.md"
        : "Stored in findings.md fallback",
    };
  }

  if (ledgerUpdated) {
    return {
      persisted: true,
      mode: "ledger",
      detail: syncResult?.synced
        ? "Stored in findings_ledger.json and synced to findings.md"
        : "Stored in findings_ledger.json",
    };
  }

  return {
    persisted: false,
    mode: ledgerError ? "ledger_error" : "missing_findings",
    detail: ledgerError || "No findings artifact was available for KB digest persistence",
  };
}

function readKnowledgeDigestContent() {
  let kbContent = "";
  for (const kbFile of ["index.md", "mistakes.md", "patterns.md", "gotchas.md"]) {
    const kbPath = join(knowledgeDir, kbFile);
    if (existsSync(kbPath)) kbContent += readFileSync(kbPath, "utf-8");
  }
  return kbContent;
}

function boundedToolOutput(value) {
  const text = typeof value === "string" ? value : String(value || "");
  const bytes = Buffer.byteLength(text, "utf-8");
  const buffer = Buffer.from(redactSecrets(text), "utf-8");
  let excerpt = buffer.subarray(0, TOOL_OUTPUT_EXCERPT_BYTES).toString("utf-8");
  while (Buffer.byteLength(excerpt, "utf-8") > TOOL_OUTPUT_EXCERPT_BYTES) excerpt = excerpt.slice(0, -1);
  return {
    bytes,
    excerpt,
  };
}

export function ritualLintTimeoutMs(value = process.env.PLANNER_RITUAL_LINT_TIMEOUT_MS) {
  const raw = String(value || "").trim();
  if (!raw) return 60000;
  const configured = Number(raw);
  if (!Number.isFinite(configured)) return 60000;
  return Math.min(60000, Math.max(10, Math.trunc(configured)));
}

function validRitualResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.ok !== "boolean") return false;
  if (!Array.isArray(value.issues) || !value.issue_counts || typeof value.issue_counts !== "object") return false;
  return ["total", "blocking", "warnings"].every((key) => (
    Number.isInteger(value.issue_counts[key]) && value.issue_counts[key] >= 0
  ));
}

function ritualToolError({ kind, proc, stdout, stderr, detail }) {
  return {
    name: "Workflow ritual contract tool",
    status: "TOOL_ERROR",
    code: RITUAL_TOOL_ERROR_CODE,
    classification: "tool_error",
    kind,
    detail,
    next: "Retry the same transition with --dry-run; if TOOL-RIT-001 repeats, report the code and receipt with the bounded stdout/stderr excerpts.",
    why: "The ritual_lint tool failed before producing trustworthy semantic evidence, so repairing plan artifacts or consuming a lifecycle attempt would be unsafe.",
    exit_status: proc.status ?? null,
    signal: proc.signal || null,
    stdout_excerpt: stdout.excerpt,
    stderr_excerpt: stderr.excerpt,
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
  };
}

export function classifyRitualLintProcess(proc) {
  const stdout = boundedToolOutput(proc.stdout);
  const stderr = boundedToolOutput(proc.stderr);
  if (proc.error) {
    const kind = proc.error.code === "ETIMEDOUT"
      ? "timeout"
      : proc.error.code === "ENOBUFS"
        ? "buffer_exhaustion"
        : "spawn_error";
    return {
      ok: false,
      result: null,
      toolError: ritualToolError({ kind, proc, stdout, stderr, detail: `ritual_lint process failed: ${proc.error.message}` }),
    };
  }
  if (proc.signal) {
    return {
      ok: false,
      result: null,
      toolError: ritualToolError({ kind: "process_signal", proc, stdout, stderr, detail: `ritual_lint terminated by signal ${proc.signal}` }),
    };
  }
  if (!String(proc.stdout || "").trim()) {
    const kind = proc.status === 0 ? "empty_stdout" : "process_exit";
    return {
      ok: false,
      result: null,
      toolError: ritualToolError({ kind, proc, stdout, stderr, detail: `ritual_lint produced no JSON response (exit ${proc.status ?? "unknown"})` }),
    };
  }
  let result = null;
  try {
    result = JSON.parse(proc.stdout);
  } catch {
    return {
      ok: false,
      result: null,
      toolError: ritualToolError({ kind: "invalid_json", proc, stdout, stderr, detail: "ritual_lint stdout was not valid JSON" }),
    };
  }
  if (!validRitualResponse(result)) {
    return {
      ok: false,
      result,
      toolError: ritualToolError({ kind: "invalid_response", proc, stdout, stderr, detail: "ritual_lint JSON response did not satisfy the required result contract" }),
    };
  }
  if (proc.status === null) {
    return {
      ok: false,
      result,
      toolError: ritualToolError({ kind: "missing_exit_status", proc, stdout, stderr, detail: "ritual_lint returned without a process exit status" }),
    };
  }
  if (result.ok === true && proc.status !== 0) {
    return {
      ok: false,
      result,
      toolError: ritualToolError({ kind: "protocol_mismatch", proc, stdout, stderr, detail: `ritual_lint returned ok=true with exit ${proc.status ?? "unknown"}` }),
    };
  }
  return {
    ok: proc.status === 0 && result?.ok === true,
    status: proc.status,
    stdout: proc.stdout || "",
    stderr: proc.stderr || "",
    result,
    toolError: null,
  };
}

function runRitualContractLint(gate, planDirName, workflowId) {
  const scriptPath = join(skillPath, "scripts", "ritual_lint.mjs");
  const proc = spawnSync(process.execPath, [
    scriptPath,
    "--workflow", workflowId,
    "--phase", gate,
    "--plan", planDirName,
    "--json",
  ], {
    cwd,
    encoding: "utf-8",
    timeout: ritualLintTimeoutMs(),
  });
  return classifyRitualLintProcess(proc);
}

// ---------------------------------------------------------------------------
// Gate registry — single source of truth
// ---------------------------------------------------------------------------

const gatesJsonPath = join(skillPath, "config", "gates.json");
const GATE_REGISTRY_DOCUMENT = existsSync(gatesJsonPath)
  ? JSON.parse(readFileSync(gatesJsonPath, "utf-8"))
  : null;
const GATE_REGISTRY = GATE_REGISTRY_DOCUMENT?.gates || null;
const GUIDE_FIRST_CONTRACT = GATE_REGISTRY_DOCUMENT?.guide_first_contract || null;
// The targeted retry runs the complete authoritative dry-run, including the
// executed-test baseline whose own governed timeout is ten minutes. Keep the
// wrapper budget larger so it cannot turn a still-running green baseline into
// a false GATE-RETRY-001 hard block.
const GATE_RETRY_DIAGNOSTIC_TIMEOUT_MS = 660000;

if (!GATE_REGISTRY || GUIDE_FIRST_CONTRACT?.uncoded_fail_policy !== "contract_defect") {
  console.error("FATAL: config/gates.json is missing the gate registry or guide-first contract.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Import gate functions from sibling scripts (dynamic imports for flexibility)
// ---------------------------------------------------------------------------

async function loadGateFunctions() {
  const verifyGatePath = join(skillPath, "scripts", "verify_gate.mjs");
  const healthPath = join(skillPath, "scripts", "project_health.mjs");

  const modules = {};
  try {
    modules.verifyGate = await import(verifyGatePath);
  } catch (e) {
    console.error(`FATAL: Cannot import verify_gate.mjs: ${e.message}`);
    console.error("  Gate checks require verify_gate.mjs — inline fallback has been removed to prevent logic divergence.");
    process.exit(2);
  }
  try {
    modules.health = await import(healthPath);
  } catch (e) {
    console.error(`WARNING: Cannot import project_health.mjs: ${e.message}`);
    console.error("  Health gate checks will be skipped. Fix the import to enable health scanning.");
    modules.health = null;
  }
  return modules;
}

function syncStateMarkdown(planDir, stateJson) {
  if (!planDir || !stateJson) return;
  const content = renderStateMarkdownFromJson(stateJson);
  if (content) writeFileSync(join(planDir, "state.md"), content);
}

function clearActivePlanPointerIfMatching(planDirName) {
  const pointerPath = join(plansDir, ".current_plan");
  try {
    const activePlan = readFileSync(pointerPath, "utf-8").trim();
    if (activePlan !== planDirName) return false;
    unlinkSync(pointerPath);
    syncActivePlanAlias(plansDir, { planDirName: null, planDir: null, stateJson: null });
    return true;
  } catch {
    return false;
  }
}

function clearPlannerTargetsIfMatching(planDirName) {
  const pointerCleared = clearActivePlanPointerIfMatching(planDirName);
  const threadTargetResult = clearThreadPlanTarget(plansDir, { planDirName, env: process.env });
  return {
    pointerCleared,
    threadCleared: threadTargetResult.cleared === true,
  };
}

// ---------------------------------------------------------------------------
// Checklist runner — delegated to lib/checklist_runner.mjs
// Security controls (AV-3, AV-8, AV-17, RT-AUDIT-005) preserved in module.
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Health scan runner
// ---------------------------------------------------------------------------

// AV-20: Replaced process.argv mutation with environment variable signaling.
// process.argv mutation is not thread-safe and can cause data races if
// runAnalyzers is async or if concurrent calls interleave.
async function runHealthScan(planDir, mode, { persist = true } = {}) {
  const origQuick = process.env._PLANNER_HEALTH_QUICK;
  const origJson = process.env._PLANNER_HEALTH_JSON;
  try {
    const { runAnalyzers, formatMarkdown } = await import(join(skillPath, "scripts", "project_health.mjs"));
    // Signal mode via env vars instead of mutating process.argv
    // M1-FIX: Removed process.argv mutation — not thread-safe and no longer needed.
    if (mode === "quick") {
      process.env._PLANNER_HEALTH_QUICK = "1";
      delete process.env._PLANNER_HEALTH_JSON;
    } else {
      process.env._PLANNER_HEALTH_JSON = "1";
      delete process.env._PLANNER_HEALTH_QUICK;
    }

    const report = runAnalyzers();

    // Save report only at the actual transition persistence boundary.
    if (persist && mode === "quick") {
      const md = formatMarkdown(report);
      writeFileSync(join(planDir, "health_report.md"), md);
    }


    return report;
  } catch (e) {
    console.log(`  ⚠️ Health scan unavailable: ${e.message}`);
    return null;
  } finally {
    // Restore env vars
    if (origQuick !== undefined) process.env._PLANNER_HEALTH_QUICK = origQuick;
    else delete process.env._PLANNER_HEALTH_QUICK;
    if (origJson !== undefined) process.env._PLANNER_HEALTH_JSON = origJson;
    else delete process.env._PLANNER_HEALTH_JSON;
  }
}

async function persistHealthScan(planDir, mode, report) {
  if (!planDir || !report) return false;
  if (mode === "quick") {
    const { formatMarkdown } = await import(join(skillPath, "scripts", "project_health.mjs"));
    writeFileSync(join(planDir, "health_report.md"), formatMarkdown(report));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Persona audit — delegated to audit_runner.mjs:runPersonaAuditGate()
// Security controls (RT-008, RT2-008, RT-AUDIT-003, GATE-PER-001) preserved.
// ---------------------------------------------------------------------------

// Gates where persona audit is compulsory — derived from gates.json
const PERSONA_AUDIT_GATES = new Set(
  Object.entries(GATE_REGISTRY)
    .filter(([_, def]) => def.persona_audit)
    .map(([name]) => name)
);

async function prepareAttemptedGate({ gate, planDirName, results }) {
  printSection("Attempted Gate Preparation");
  try {
    const { buildResult: prepareGate } = await import("./gate_prepare.mjs");
    const prepared = prepareGate({ cwd, gate, planArg: planDirName, write: false });
    const report = {
      status: prepared.status || (prepared.ok ? "pass" : "advisory"),
      ok: prepared.ok === true,
      write_requested: false,
      wrote: prepared.wrote === true,
      write_actions: prepared.write_actions || [],
      missing_before: prepared.before?.missing || [],
      missing_after: prepared.after?.missing || [],
      truthfulness_notes: prepared.report?.truthfulness_notes || [],
    };
    const changedActions = (prepared.write_actions || []).filter((action) =>
      ["created", "updated", "written", "appended_missing_tokens"].includes(action?.status)
    );
    if (changedActions.length > 0) {
      for (const action of changedActions) {
        const row = withFailureCode(check(
          `Prepared ${action.id || action.file || gate}`,
          WARN,
          `${action.status}: ${action.file || "structural gate artifact"}; structural-only, not accepted as proof`
        ), "GATE-PREP-001");
        printResults([row]);
        results.push(row);
      }
    } else {
      const row = check("Attempted gate preparation", PASS, "No structural repair was needed; proof evaluation follows.");
      printResults([row]);
      results.push(row);
    }
    console.log();
    return report;
  } catch (error) {
    const report = {
      status: "advisory",
      ok: false,
      write_requested: false,
      wrote: false,
      write_actions: [],
      error: error.message,
    };
    const row = withFailureCode(check(
      "Attempted gate preparation",
      WARN,
      `Preparation unavailable: ${error.message}; authoritative gate checks still run and retain all proof controls.`
    ), "GATE-PREP-002");
    printResults([row]);
    results.push(row);
    console.log();
    return report;
  }
}

function readStoryRegistrySnapshot(projectRoot = cwd) {
  const path = join(projectRoot, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(path)) {
    return {
      present: false,
      ok: true,
      path,
      hash: null,
      coverageMode: "absent",
      error: null,
    };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const registry = JSON.parse(raw);
    if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
      throw new Error("story_registry.json must contain a JSON object");
    }
    if (!Array.isArray(registry.stories) && !Array.isArray(registry.infrastructure_stories)) {
      throw new Error("story_registry.json must declare stories or infrastructure_stories");
    }
    const coverage = validateCoverageContract(registry);
    if (coverage.errors.length > 0) {
      throw new Error(coverage.errors.join("; "));
    }
    return {
      present: true,
      ok: true,
      path,
      hash: createHash("sha256").update(raw).digest("hex").slice(0, 32),
      coverageMode: coverage.mode,
      error: null,
    };
  } catch (error) {
    return {
      present: true,
      ok: false,
      path,
      hash: null,
      coverageMode: "invalid",
      error: error.message,
    };
  }
}

function normalizeRegistryRefreshResults(results, planDirName) {
  return normalizeGateResultsForTransition(results, {
    gate: "refresh-registry",
    planId: planDirName,
  });
}

export async function runRegistryRefresh(opts = {}) {
  const dryRun = opts.dryRun === true;
  const { planDirName, planDir, source } = resolvePlanTarget(plansDir, {
    exitOnMissing: false,
    plan: opts.plan,
  });
  const generatedAt = nowISO();
  const results = [];

  printHeader(
    `TRANSITION: refresh-registry${dryRun ? " [DRY RUN]" : ""}`,
    `Plan: ${planDirName || opts.plan || "unknown"}`,
  );
  if (source && source !== "pointer") {
    console.log(`  Target source: ${source}`);
    console.log();
  }

  if (!planDirName || !planDir) {
    const result = withFailureCode(check(
      "Active plan resolution",
      FAIL,
      "No active or explicit plan could be resolved.",
    ), "GATE-PLAN-001");
    results.push(result);
    printResults(results);
    const receipt = buildTransitionReceipt({
      projectRoot: cwd,
      planId: opts.plan || "unknown",
      gate: "refresh-registry",
      sourceState: null,
      targetState: null,
      results,
      generatedAt,
    });
    console.log();
    console.log(renderTransitionVerdict(receipt));
    return 1;
  }

  const stateJson = readStateJson(planDir);
  const stateValidation = validateStateJson(stateJson);
  const stateResult = stateValidation.valid
    ? check("Canonical plan state", PASS, `State is ${stateJson.state}`)
    : withFailureCode(check(
        "Canonical plan state",
        FAIL,
        stateValidation.errors.join("; ") || "state.json is missing or invalid",
      ), "GATE-RUN-001");
  results.push(stateResult);

  if (stateValidation.valid) {
    results.push(
      stateJson.state === "CLOSE"
        ? withFailureCode(check(
            "Post-close mutation guard",
            FAIL,
            "Plan is already CLOSED — registry signing is immutable after close.",
          ), "GATE-GAR-001")
        : check(
            "Phase-neutral scope",
            PASS,
            `${stateJson.state} will be preserved and lifecycle transition history will not be appended.`,
          ),
    );
  }

  const registrySnapshot = readStoryRegistrySnapshot(cwd);
  if (!registrySnapshot.present) {
    results.push(withFailureCode(check(
      "Story registry integrity",
      FAIL,
      "reports/user_story_audit/story_registry.json is missing.",
    ), "GATE-SEM-002"));
  } else if (!registrySnapshot.ok) {
    results.push(withFailureCode(check(
      "Story registry integrity",
      FAIL,
      registrySnapshot.error,
    ), "GATE-SEM-002"));
  } else {
    results.push(check(
      "Story registry integrity",
      PASS,
      `Valid ${registrySnapshot.coverageMode} registry; candidate hash ${registrySnapshot.hash}.`,
    ));
    results.push(check(
      "Registry hash candidate",
      PASS,
      stateJson?.registry_hash === registrySnapshot.hash
        ? `Signed hash already matches ${registrySnapshot.hash}; write mode is a no-op.`
        : `Would replace ${stateJson?.registry_hash || "(unsigned)"} with ${registrySnapshot.hash}.`,
    ));
  }

  let normalized = normalizeRegistryRefreshResults(results, planDirName);
  const hasFailure = normalized.some(gateResultBlocks);
  printSection("Registry Hash Refresh");
  printResults(normalized);
  console.log();

  const buildReceipt = (persistence = {}) => buildTransitionReceipt({
    projectRoot: cwd,
    planId: planDirName,
    gate: "refresh-registry",
    sourceState: stateJson?.state || null,
    targetState: stateJson?.state || null,
    results: normalized,
    generatedAt,
    persistence,
  });

  if (dryRun || hasFailure) {
    let receipt = buildReceipt();
    if (!dryRun) {
      receipt = writeTransitionReceipt(planDir, receipt, { projectRoot: cwd }).receipt;
    }
    console.log(renderTransitionVerdict(receipt));
    return hasFailure ? 1 : 0;
  }

  if (stateJson.registry_hash === registrySnapshot.hash) {
    const receipt = writeTransitionReceipt(planDir, buildReceipt(), { projectRoot: cwd }).receipt;
    console.log(renderTransitionVerdict(receipt));
    return 0;
  }

  const releaseLock = acquireStateLock(planDir);
  if (!releaseLock) {
    normalized = normalizeRegistryRefreshResults([
      ...normalized,
      withFailureCode(check(
        "Canonical state lock",
        FAIL,
        "Could not acquire state.json lock — concurrent transition detected.",
      ), "GATE-STA-001"),
    ], planDirName);
    const receipt = writeTransitionReceipt(planDir, buildReceipt(), { projectRoot: cwd }).receipt;
    console.log(renderTransitionVerdict(receipt));
    return 1;
  }

  let statePersisted = false;
  let receipt = null;
  let journalWrite = null;
  try {
    const recovered = recoverTransitionJournal(planDir);
    if (!["no_transaction", "aborted_clean"].includes(recovered.status)) {
      normalized = normalizeRegistryRefreshResults([
        ...normalized,
        withFailureCode(check(
          "Transition journal recovery",
          FAIL,
          `An interrupted registry refresh requires reconciliation (${recovered.action}: ${recovered.reason || recovered.phase || "unknown"}).`,
        ), "GATE-STA-002"),
      ], planDirName);
      receipt = writeTransitionReceipt(planDir, buildReceipt(), { projectRoot: cwd }).receipt;
      console.log(renderTransitionVerdict(receipt));
      return 1;
    }

    const lockedStateRead = readStateJsonWithProvenance(planDir);
    const lockedState = lockedStateRead.state;
    const lockedRegistry = readStoryRegistrySnapshot(cwd);
    const lockedValidation = validateStateJson(lockedState);
    const inputChanged = !lockedValidation.valid ||
      lockedState.state !== stateJson.state ||
      JSON.stringify(lockedState.transitions) !== JSON.stringify(stateJson.transitions) ||
      !lockedRegistry.present ||
      !lockedRegistry.ok ||
      lockedRegistry.hash !== registrySnapshot.hash;
    if (inputChanged) {
      normalized = normalizeRegistryRefreshResults([
        ...normalized,
        withFailureCode(check(
          "Registry refresh input stability",
          FAIL,
          "Plan state or story registry changed after evaluation; rerun the dry-run against the current bytes.",
        ), "GATE-STA-002"),
      ], planDirName);
    } else {
      journalWrite = writeTransitionJournal(planDir, {
        gate: "refresh-registry",
        phase: "prepared",
        plan_id: planDirName,
        transition_timestamp: generatedAt,
        state_before: lockedStateRead.provenance,
        state_after: null,
        receipt_paths: [],
        decision_status: "not_applicable",
      }, { expected: null });
      if (journalWrite.status !== "committed") {
        normalized = normalizeRegistryRefreshResults([
          ...normalized,
          withFailureCode(check(
            "Transition journal persistence",
            FAIL,
            `Registry refresh journal ${journalWrite.status} (${journalWrite.reason}).`,
          ), "GATE-STA-002"),
        ], planDirName);
        receipt = writeTransitionReceipt(planDir, buildReceipt(), { projectRoot: cwd }).receipt;
        console.log(renderTransitionVerdict(receipt));
        return 1;
      }

      lockedState.registry_hash = lockedRegistry.hash;
      lockedState.registry_hash_refreshed_at = generatedAt;
      lockedState.registry_hash_refresh_count =
        Number(lockedState.registry_hash_refresh_count || 0) + 1;
      const stateWrite = writeStateJsonResult(planDir, lockedState, {
        expected: lockedStateRead.provenance,
        deferFinalize: true,
        mutationOrigin: "transition:refresh-registry",
      });
      if (stateWrite.status !== "committed") {
        normalized = normalizeRegistryRefreshResults([
          ...normalized,
          withFailureCode(check(
            "Canonical state persistence",
            FAIL,
            `state.json publication ${stateWrite.status} (${stateWrite.reason}); the registry refresh cannot claim success.`,
          ), "GATE-STA-002"),
        ], planDirName);
        removeTransitionJournal(journalWrite);
      } else {
        const publishedJournal = writeTransitionJournal(planDir, {
          ...journalWrite.journal,
          phase: "state_published",
          state_after: stateWrite.published,
        }, { expected: journalWrite.token });
        if (publishedJournal.status !== "committed") {
          rollbackOwnedFileReplace(stateWrite);
          throw new Error(`registry refresh journal publication ${publishedJournal.status}: ${publishedJournal.reason}`);
        }
        journalWrite = publishedJournal;

        const provisionalReceipt = writeTransitionReceipt(
          planDir,
          buildReceipt({ state: true }),
          { projectRoot: cwd },
        );
        const stateFinalization = finalizeOwnedFileReplace(stateWrite);
        if (stateFinalization.status !== "committed") {
          throw new Error(`registry refresh state finalization ${stateFinalization.status}: ${stateFinalization.reason}`);
        }
        statePersisted = true;
        receipt = provisionalReceipt.receipt;

        const committedJournal = writeTransitionJournal(planDir, {
          ...journalWrite.journal,
          phase: "committed",
          receipt_paths: [provisionalReceipt.immutable_path, provisionalReceipt.latest_path],
          decision_status: "not_applicable",
        }, { expected: journalWrite.token });
        if (committedJournal.status !== "committed") {
          throw new Error(`registry refresh journal finalization ${committedJournal.status}: ${committedJournal.reason}`);
        }
        journalWrite = committedJournal;
        const journalCleanup = removeTransitionJournal(journalWrite);
        if (journalCleanup.status !== "committed") {
          throw new Error(`registry refresh journal cleanup ${journalCleanup.status}: ${journalCleanup.reason}`);
        }
      }
    }

    if (!receipt) {
      receipt = writeTransitionReceipt(
        planDir,
        buildReceipt({ state: statePersisted }),
        { projectRoot: cwd },
      ).receipt;
    }
  } finally {
    releaseLock();
  }

  console.log(renderTransitionVerdict(receipt));
  return normalized.some(gateResultBlocks) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Gate transitions
// ---------------------------------------------------------------------------

async function runTransition(gate, opts = {}) {
  const dryRun = opts.dryRun === true;
  // Signal the shared evaluator to fact_loader. Registry persistence is separately
  // gated by _PLANNER_DRY_RUN so both modes consult the same facts.
  const plannerEnvScope = captureEnvValues(["_PLANNER_GATE_TRANSITION", "_PLANNER_DRY_RUN", "_PLANNER_PLAN_TARGET"]);
  process.env._PLANNER_GATE_TRANSITION = "1";
  if (dryRun) process.env._PLANNER_DRY_RUN = "1";
  else delete process.env._PLANNER_DRY_RUN;
  try {
  const { planDirName, planDir } = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: opts.plan });
  const gateDef = GATE_REGISTRY[gate];
  const isAuditOnlyGate = gateDef?.audit_only === true;

  if (!planDirName || !planDir) {
    const result = withFailureCode(check(
      "Active plan resolution",
      FAIL,
      "No active or explicit plan could be resolved."
    ), "GATE-PLAN-001");
    result.next = "node .agent/skills/iterative-planner/scripts/bootstrap.mjs status";
    result.why = "A transition without a canonical plan target could mutate or report against the wrong lifecycle.";
    const receipt = buildTransitionReceipt({
      projectRoot: cwd,
      planId: opts.plan || "unknown",
      gate,
      sourceState: null,
      targetState: null,
      results: [result],
      generatedAt: nowISO(),
    });
    console.log(renderTransitionVerdict(receipt));
    return 1;
  }
  process.env._PLANNER_PLAN_TARGET = planDirName;

  printHeader(`TRANSITION: ${gate}${dryRun ? " [DRY RUN]" : ""}`, `Plan: ${planDirName}`);
  const targetedPlan = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: opts.plan });
  if (targetedPlan.source && targetedPlan.source !== "pointer") {
    console.log(`  Target source: ${targetedPlan.source}`);
    const pointerPlanDirName = readPointer(plansDir);
    if (pointerPlanDirName && pointerPlanDirName !== planDirName) {
      console.log(`  Pointer: plans/.current_plan → ${pointerPlanDirName}`);
    }
    console.log();
  }
  const allResults = [];
  let sharedPlanRefresh = null;
  let evaluatedRegistrySnapshot = null;
  const pendingPersistence = {
    health: [],
    persona: null,
    executedTest: null,
    scope: null,
    semanticTrace: null,
    invariantAdvisories: null,
  };
  const preparationReport = await prepareAttemptedGate({ gate, planDirName, results: allResults });
  const emitEarlyBlock = (row, exitCode = 2) => {
    const normalized = normalizeGateResults([...allResults, row], { gate, planId: planDirName });
    const sourceState = readStateJson(planDir)?.state || null;
    let earlyReceipt = buildTransitionReceipt({
      projectRoot: cwd,
      planId: planDirName,
      gate,
      sourceState,
      targetState: gateDef?.to ? gateDef.to.toUpperCase() : sourceState,
      results: normalized,
      preparation: preparationReport,
      generatedAt: nowISO(),
    });
    if (!dryRun) earlyReceipt = writeTransitionReceipt(planDir, earlyReceipt, { projectRoot: cwd }).receipt;
    if (!dryRun) {
      try {
        recordGateMetrics({
          projectRoot: cwd,
          planDirName,
          planDir,
          gate,
          status: "FAIL",
          at: earlyReceipt.generated_at,
          failureCodes: earlyReceipt.failure_codes,
          advisoryCodes: earlyReceipt.advisories.map((entry) => entry.code).filter(Boolean),
          advisoryConversions: earlyReceipt.advisory_conversion_count,
          resultingState: null,
        });
      } catch {
        // Receipt is authoritative; telemetry remains best-effort.
      }
    }
    console.log();
    console.log(renderTransitionVerdict(earlyReceipt));
    return exitCode;
  };
  // POST-CLOSE GUARD: Prevent state-mutating gates on an already-closed plan.
  // Audit-only gates (for example notify-user) are allowed because they do not
  // append transition history or change canonical planner state.
  const stateJsonForCloseCheck = readStateJson(planDir);
  if (stateJsonForCloseCheck?.state === "CLOSE" && !isAuditOnlyGate) {
    const row = withFailureCode(check(
      "Post-close mutation guard",
      FAIL,
      "Plan is already CLOSED — no further state-mutating transitions are allowed."
    ), "GATE-GAR-001");
    row.next = "node .agent/skills/iterative-planner/scripts/bootstrap.mjs new \"<goal>\"";
    row.why = "Mutating a closed plan would corrupt immutable lifecycle history and shared planner state.";
    return emitEarlyBlock(row);
  }
  // AV-19 + RT-AUDIT-H2: Per-gate retry guards against brute-force content changes.
  // The TIME-BASED cooldown is disabled by default (T-INTAKE-8CD950E7, 2026-06-10):
  // the persistent circuit breaker (CIRCUIT_BREAKER_OPEN) and the GATE-RETRY-001
  // thrash guard already catch brute-force retry loops, while the wall-clock
  // cooldown only added dead time to honest fix-and-retry loops (friction_log F5).
  // Re-enable via determinism.json features.gate_retry_cooldown if ever needed.
  const cooldownFeature = loadConfig().features?.gate_retry_cooldown || {};
  const GATE_COOLDOWN_MS = cooldownFeature.enabled === true
    ? (Number(cooldownFeature.cooldown_ms) > 0 ? Number(cooldownFeature.cooldown_ms) : 10_000)
    : 0;
  const GATE_THRASH_GUARD_THRESHOLD = 3;
  const stateJsonForCooldown = readStateJson(planDir);
  let historyPoisonDiagnostic = null;
  if (stateJsonForCooldown?.transitions?.length > 0) {
    const transitions = stateJsonForCooldown.transitions;
    const thrashTail = summarizeGateFailureTail(transitions, GATE_REGISTRY, gate, {
      threshold: GATE_THRASH_GUARD_THRESHOLD,
    });
    if (thrashTail.blocked && process.env._PLANNER_RETRY_DIAGNOSTIC !== "1") {
      const transitionScript = join(skillPath, "scripts", "transition.mjs");
      const targeted = spawnSync(process.execPath, [transitionScript, gate, "--dry-run", "--plan", planDirName], {
        cwd,
        encoding: "utf-8",
        timeout: GATE_RETRY_DIAGNOSTIC_TIMEOUT_MS,
        env: { ...process.env, _PLANNER_RETRY_DIAGNOSTIC: "1" },
      });
      const targetedPasses = targeted.status === 0;
      if (!targetedPasses) {
        const commandPrefix = "node .agent/skills/iterative-planner/scripts";
        const row = withFailureCode(check(
          "Repeated same-gate failure guard",
          FAIL,
          `${gate} has ${thrashTail.consecutiveFails} consecutive failures and its targeted diagnosis still fails.`
        ), "GATE-RETRY-001");
        row.next = `${commandPrefix}/transition.mjs ${gate} --dry-run --plan ${planDirName}`;
        row.why = "Continuing an unchanged failing loop risks blind artifact edits and hides the first actionable defect.";
        return emitEarlyBlock(row);
      }
    }

    const gateTail = summarizeGateFailureTail(transitions, GATE_REGISTRY, gate, {
      threshold: GATE_HISTORY_POISON_THRESHOLD,
    });
    if (gateTail.blocked) {
      historyPoisonDiagnostic = gateTail;
    }

    // PERSISTENT CIRCUIT BREAKER PRE-CHECK: Block if total fails exceed threshold.
    // Unlike the consecutive-tail counter above, this cannot be bypassed by gate-swapping
    // because it reads from the persisted circuit_breakers field in state.json.
    const CIRCUIT_BREAKER_THRESHOLD = 10;
    const persistedFails = stateJsonForCooldown.circuit_breakers?.[gate]?.total_fails ?? 0;
    if (persistedFails >= CIRCUIT_BREAKER_THRESHOLD) {
      const row = withFailureCode(check(
        "Persistent gate circuit breaker",
        FAIL,
        `Gate '${gate}' has failed ${persistedFails} times total (threshold: ${CIRCUIT_BREAKER_THRESHOLD}).`
      ), "GATE-GAR-002");
      row.next = `node .agent/skills/iterative-planner/scripts/bootstrap.mjs reset-circuit-breaker ${gate}`;
      row.why = "The persistent threshold indicates repeated unresolved failure and protects the plan from unbounded mutation loops.";
      return emitEarlyBlock(row);
    }

    // Time-based cooldown (opt-in via features.gate_retry_cooldown; default off)
    if (GATE_COOLDOWN_MS > 0) {
    const gateDefForCooldown = GATE_REGISTRY[gate];
    const gateFromStates = gateDefForCooldown
      ? (Array.isArray(gateDefForCooldown.from) ? gateDefForCooldown.from : [gateDefForCooldown.from]).map(s => s?.toUpperCase())
      : [];
    const gateToState = gateDefForCooldown?.to?.toUpperCase() || null;
    for (let i = transitions.length - 1; i >= 0; i--) {
      const t = transitions[i];
      const transitionFailed = verificationStatusIsHardFailure(t.gate_result, "gate");
      const matchesGate = gateFromStates.includes(t.from) &&
        (transitionFailed ? gateFromStates.includes(t.to) : t.to === gateToState);
      if (!matchesGate) continue;
      if (transitionFailed) {
        const lastTs = new Date(t.timestamp).getTime();
        const elapsed = Date.now() - lastTs;
        if (elapsed < GATE_COOLDOWN_MS && !isNaN(lastTs)) {
          const waitSec = Math.ceil((GATE_COOLDOWN_MS - elapsed) / 1000);
          const row = withFailureCode(check(
            "Configured gate retry cooldown",
            FAIL,
            `${waitSec}s remain; last ${gate} attempt failed at ${t.timestamp}.`
          ), "GATE-RETRY-002");
          row.next = `Wait ${waitSec}s, then rerun the targeted diagnosis before another transition attempt.`;
          row.why = "This explicitly enabled concurrency guard prevents overlapping attempts from racing canonical state writes.";
          return emitEarlyBlock(row, 1);
        }
      }
      break;
    }
    }
  }

  if (historyPoisonDiagnostic) {
    printSection("Retry History");
    const diagnostic = check(
      "History-poisoned gate tail (AV-19)",
      WARN,
      historyPoisonDiagnostic.failureCodes?.length > 0
        ? `${GATE_HISTORY_POISON_MARKER}: ${historyPoisonDiagnostic.consecutiveFails} consecutive failures for ${gate}. Repeated failure codes: ${historyPoisonDiagnostic.failureCodes.join(", ")}. Keeping the transition live so a now-valid gate can pass; recover-poison remains available if you want to preserve history first.`
        : `${GATE_HISTORY_POISON_MARKER}: ${historyPoisonDiagnostic.consecutiveFails} consecutive failures for ${gate}. Keeping the transition live so a now-valid gate can pass; recover-poison remains available if you want to preserve history first.`
    );
    printResults([diagnostic]);
    allResults.push(diagnostic);
    console.log();
  }

  // Step 0a: RT-REDTEAM-M1 — Decision log hash chain validation.
  // Detects tampering with historical decision log entries.
  {
    const chainCheck = validateDecisionLogChain(planDir);
    if (!chainCheck.valid && chainCheck.reason !== "no decision log" && chainCheck.reason !== "empty log") {
      printSection("Decision Log Chain Integrity");
      const r = withFailureCode(check(
        "Decision log hash chain",
        FAIL,
        chainCheck.reason
      ), "GATE-CHN-001");
      printResults([r]);
      allResults.push(r);
      console.log();
    }
  }

  // Step 0e: e05 AC1/AC2 — Agent orchestration whitelist integrity.
  // The Agent() whitelist + single-foreground-writer policy (config/agent_orchestration.json)
  // is the anti-gate-bypass orchestration contract. Validate it here so a tampered or malformed
  // policy blocks the gate rather than sitting as unwired shelf-ware. A FAIL flows through the
  // normal blocking spine (totalFail > 0) instead of an early exit.
  {
    let orchestrationResult;
    try {
      const orchestrationConfig = loadAgentOrchestrationConfig();
      const whitelist = validateAgentWhitelist(orchestrationConfig);
      orchestrationResult = withFailureCode(check(
        "Agent orchestration whitelist integrity",
        whitelist.ok ? PASS : FAIL,
        whitelist.ok
          ? `${(orchestrationConfig.agents || []).length} whitelisted agent(s); single-foreground-writer policy intact`
          : `Orchestration policy invalid: ${whitelist.issues.map((i) => i.code).join(", ")}`
      ), "GATE-ORC-001");
    } catch (e) {
      orchestrationResult = withFailureCode(check(
        "Agent orchestration whitelist integrity",
        FAIL,
        `agent_orchestration.json could not be loaded: ${e.message}`
      ), "GATE-ORC-001");
    }
    if (orchestrationResult.status === FAIL) {
      printSection("Agent Orchestration Whitelist (e05)");
      printResults([orchestrationResult]);
    }
    allResults.push(orchestrationResult);
  }

  // Step 0: Source-state validation — derived from gates.json
  const expectedSources = gateDef
    ? (Array.isArray(gateDef.from) ? gateDef.from : [gateDef.from]).filter(Boolean)
    : [];
  if (expectedSources.length > 0) {
    // AV-6: Require state.json (canonical). state.md regex fallback removed —
    // LLMs can edit state.md to fake current state, bypassing source-state checks.
    let currentStateName = null;
    const stateJson = readStateJson(planDir);
    if (stateJson?.state) {
      currentStateName = stateJson.state.toLowerCase();
    }
    // If state.json is missing/corrupt, currentStateName stays null → transition blocked
    const stateMatch = currentStateName && expectedSources.includes(currentStateName);
    printSection("Source-State Check");
    const stateCheckResult = withFailureCode(check(
      `Current state matches gate source`,
      stateMatch ? PASS : FAIL,
      stateMatch
        ? `State is ${currentStateName} ✓`
        : `Expected [${expectedSources.join("|")}], found: ${currentStateName || "unknown"} — transition blocked (wrong phase)`
    ), "GATE-SRC-001");
    printResults([stateCheckResult]);
    allResults.push(stateCheckResult);
    console.log();
  }

  const authorityProfile = resolveAuthorityProfile({
    gateName: gate,
    gateDef,
    state: readStateJson(planDir)?.state || null,
  });
  const proofPosture = resolveProofPosture({
    gateName: gate,
    gateDef,
    state: authorityProfile.phase,
  });
  const phaseContract = buildPhaseContract({
    authorityProfile,
    proofPosture,
  });
  printSection("Phase Authority");
  console.log(`  Entering phase: ${phaseContract.phase.toUpperCase()}`);
  console.log(`  Agent role: ${phaseContract.authority_profile.agent_role}`);
  console.log(`  Persona role: ${phaseContract.authority_profile.persona_role}`);
  console.log(`  Ontology role: ${phaseContract.authority_profile.ontology_role}`);
  console.log(`  Proof posture: ${phaseContract.proof_posture.label}`);
  console.log(`  Contract: ${phaseContract.summary}`);
  console.log();

  // Step 1: Health scan (for applicable gates — derived from gates.json health_scan field)
  if (gateDef?.health_scan === "quick") {
    printSection("Health Scan (quick)");
    const report = await runHealthScan(planDir, "quick", { persist: false });
    if (report) {
      pendingPersistence.health.push({ mode: "quick", report });
      const healthResults = [];
      // Health-scan FAILs are repo-level findings (stale doc references, orphaned
      // capabilities, etc.) that are usually unrelated to the current plan goal.
      // v7.3.0: surfaced here as WARN, not FAIL, so they don't block plan
      // transitions. The /advisor and /housekeeping workflows are the right
      // places to triage and act on them.
      if (report.summary.fail > 0) {
        healthResults.push(check(`${report.summary.fail} repo health finding(s)`, WARN, "Repo-level health findings — see health_report.md, /advisor, or /housekeeping. Not blocking this transition."));
      }
      if (report.summary.warn > 0) {
        healthResults.push(check(`${report.summary.warn} warning(s)`, PASS, "Documented in health_report.md"));
      }
      healthResults.push(check("Health report resolved", PASS, `quick scan evaluated in ${(report.duration_ms / 1000).toFixed(1)}s; persistence occurs only after the actual verdict`));
      const counts = printResults(healthResults);
      allResults.push(...healthResults);
    } else {
      // RP-002: Health scan returned null — scanner itself may have crashed.
      // This is distinct from "scan ran but found zero issues".
      // A scanner crash should block the transition (FAIL), not proceed with a warning.
      const r = withFailureCode(check("Health scan", FAIL, "Health scan failed to produce a report — fix scanner before proceeding"), "GATE-HLT-001");
      printResults([r]);
      allResults.push(r);
    }
    console.log();
  }

  if (gateDef?.health_scan === "full") {
    printSection("Health Delta Check");
    const report = await runHealthScan(planDir, "json", { persist: false });
    if (!report) {
      const r = withFailureCode(check("Health scan", FAIL, "Health scan failed to produce a report — fix scanner before closing"), "GATE-HLT-001");
      printResults([r]);
      allResults.push(r);
    } else {
      pendingPersistence.health.push({ mode: "json", report });
      const baselinePath = join(planDir, "health_baseline.json");
      if (existsSync(baselinePath)) {
        try {
          const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
          if (!baseline?.summary || typeof baseline.summary.fail !== "number") {
            throw new Error("Health baseline JSON missing required summary.fail field");
          }
          const newFails = report.summary.fail - baseline.summary.fail;
          const resolvedWarns = baseline.summary.warn - report.summary.warn;
          console.log(`  Baseline: ${baseline.summary.fail}F ${baseline.summary.warn}W ${baseline.summary.info}I`);
          console.log(`  Final:    ${report.summary.fail}F ${report.summary.warn}W ${report.summary.info}I`);
          if (newFails > 0) {
            const acknowledgement = readHealthDeltaAcknowledgement(planDir, { newFails });
            if (acknowledgement.acknowledged) {
              const r = check(
                "Health delta acknowledgement",
                PASS,
                `${newFails} expected new failure(s) documented in ${acknowledgement.sourceFile}: ${acknowledgement.reason}`
              );
              printResults([r]);
              allResults.push(r);
            } else {
              const detail = acknowledgement.reason && acknowledgement.reason !== "missing_section"
                ? `${newFails} NEW failure(s) introduced; acknowledgement invalid (${acknowledgement.reason})`
                : `${newFails} NEW failure(s) introduced`;
              const r = withFailureCode(check("No new health failures", FAIL, detail), "GATE-HLT-003");
              printResults([r]);
              allResults.push(r);
            }
          } else {
            const r = check("No new health failures", PASS, resolvedWarns > 0 ? `${resolvedWarns} warning(s) resolved` : "Clean");
            printResults([r]);
            allResults.push(r);
          }
        } catch (e) {
          const r = check("Health delta", WARN, `Parse error: ${e.message}`);
          printResults([r]);
          allResults.push(r);
        }
      } else {
        // AV-18: Missing baseline is FAIL (not WARN) for consistency with quick mode.
        // A full health delta requires a baseline to compare against.
        const r = withFailureCode(check("Health baseline", FAIL, "No health_baseline.json — run bootstrap to capture baseline before closing"), "GATE-HLT-004");
        printResults([r]);
        allResults.push(r);
      }
    }
    console.log();
  }

  // Step 1.5: Compulsory persona audit (for applicable gates)
  if (PERSONA_AUDIT_GATES.has(gate)) {
    printSection("Persona Audit (compulsory)");
    const personaResults = await runPersonaAuditGate(cwd, skillPath, planDir, gate, { persistArtifacts: false });
    pendingPersistence.persona = personaResults.artifacts || null;
    const personaCounts = printResults(personaResults);
    allResults.push(...personaResults);
    console.log();
  }

  // Step 1.7: Shared plan refresh — regenerate ontology facts and structured close signals
  // before JS gate checks, checklists, and Prolog semantics run. Non-blocking: transitions
  // still continue even if the refresh cannot complete so legacy fallbacks remain available.
  if (planDir) {
    try {
      sharedPlanRefresh = refreshPlanArtifacts({
        cwd,
        skillPath,
        planDirName,
        gateName: gate,
        persistState: false,
        persistOntology: false,
        syncFindings: false,
        backfillScaffold: false,
        executeAdversarialEvidence: gate === "validate-to-close",
      });
      if (process.env.DEBUG && sharedPlanRefresh?.ontology?.error) {
        console.error(`  [plan_refresh] ontology error: ${sharedPlanRefresh.ontology.error}`);
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`  [plan_refresh] refresh error: ${e.message}`);
    }
  }

  if (planDir && TEST_GATED_TRANSITIONS.has(gate)) {
    printSection("Executed Test Baseline Gate");
    const executedTestGate = runExecutedTestGate({
      cwd,
      skillPath,
      planDir,
      planDirName,
      gate,
      autonomous: process.env.PLANNER_AUTONOMOUS_DRIVER === "1",
      persistEvidence: false,
    });
    pendingPersistence.executedTest = executedTestGate;
    const executedPassed = verificationStatusIsPass(executedTestGate.status, "execution");
    const executedFailed = verificationStatusIsHardFailure(executedTestGate.status, "execution");
    const status = executedPassed
      ? PASS
      : executedTestGate.blocking || executedFailed
        ? FAIL
        : WARN;
    const r = withFailureCode(check(
      "test_baseline.mjs verify executed for test-gated transition",
      status,
      executedPassed
        ? `${gate}: exit code 0; evidence ${EXECUTED_TEST_GATES_FILE}`
        : `${gate}: ${executedTestGate.detail}; exit code ${executedTestGate.exit_code ?? "n/a"}`
    ), "GATE-TST-001");
    printResults([r]);
    allResults.push(r);
    console.log();
  }

  // Step 1.8: Deterministic stale-plan context preflight.
  // Recent reads from non-active plans warn; recent edits/writes block the gate.
  {
    const staleContext = detectRecentNonActivePlanContext(plansDir, planDirName);
    if (staleContext.warned) {
      printSection("Active Plan Context");
      const r = withFailureCode(check(
        staleContext.blocked
          ? "Recent non-active plan edits detected"
          : "Recent non-active plan context detected",
        staleContext.blocked ? FAIL : WARN,
        formatNonActivePlanContextDetail(staleContext, ACTIVE_PLAN_ALIAS_LABEL)
      ), staleContext.blocked ? "GATE-CTX-001" : "GATE-CTX-002");
      printResults([r]);
      allResults.push(r);
      console.log();
    }
  }

  if (planDir && (gate === "explore-to-plan" || gate === "plan-to-execute")) {
    try {
      const planContent = existsSync(join(planDir, "plan.md"))
        ? readFileSync(join(planDir, "plan.md"), "utf-8")
        : "";
      const scopeContract = buildScopeContract({ cwd, planDir, planContent });
      pendingPersistence.scope = { planContent, contract: scopeContract };
      if (scopeContract?.summary?.ambient_count >= 20 && scopeContract.summary.declared_count > 0) {
        printSection("Scope Contract");
        const r = check(
          "Ambient dirty diff quarantine",
          WARN,
          `Large unrelated dirty diff detected. Treating ${scopeContract.summary.ambient_count} file(s) as ambient unless explicitly adopted (${summarizeScopeContract(scopeContract)}).`
        );
        printResults([r]);
        allResults.push(r);
        console.log();
      }
    } catch (e) {
      printSection("Scope Contract");
      const r = check("Scope contract", WARN, `Could not refresh scope.json: ${e.message}`);
      printResults([r]);
      allResults.push(r);
      console.log();
    }
  }

  // Step 1.9: Knowledge Trigger obligations for this gate (ive-ontology-memory).
  // Portable enforcement: an obligation KT whose when-match fires at this gate must
  // have its required evidence recorded, or the gate blocks. Fires for ANY agent that
  // invokes the planner (not a harness hook), so a fast/cheap model can't forget it.
  // Non-matching plans add no checks (scoped to the obligation's triggers).
  if (planDir) {
    try {
      const { evaluateObligationGate } = await import("./lib/knowledge_triggers.mjs");
      const ktPlanContent = existsSync(join(planDir, "plan.md")) ? readFileSync(join(planDir, "plan.md"), "utf-8") : "";
      const ktFilesSection = ktPlanContent.match(/##\s+Files\s+[Tt]o\s+[Mm]odify\s*\n([\s\S]*?)(?=\n##|$)/);
      let ktPlannedFiles = [];
      if (ktFilesSection) {
        ktPlannedFiles = (ktFilesSection[1].match(/^\s*[-*]\s+`?([^`\s]+)`?/gm) || [])
          .map((line) => line.replace(/^\s*[-*]\s+`?/, "").replace(/`?\s*$/, "").trim())
          .filter(Boolean);
      }
      const obligations = evaluateObligationGate({
        gate,
        planDir,
        goalText: stateJson.goal || "",
        plannedFiles: ktPlannedFiles,
      });
      if (obligations.length > 0) {
        printSection("Knowledge Trigger Obligations");
        for (const o of obligations) {
          const r = withFailureCode(check(
            `Obligation ${o.id}`,
            o.satisfied ? PASS : FAIL,
            o.satisfied
              ? "Required evidence recorded"
              : `${o.directive}${o.prompt_ref ? ` (see ${o.prompt_ref})` : ""} — then record evidence: ${o.missing_evidence.join(", ")}`
          ), "GATE-KT-001");
          printResults([r]);
          allResults.push(r);
        }
        console.log();
      }
    } catch {
      // best-effort: never crash a transition on Knowledge Trigger evaluation
    }
  }

  {
    const workflowState = readStateJson(planDir);
    if (workflowState?.workflow_id) {
      printSection("Ritual Contract Lint");
      const ritual = runRitualContractLint(gate, planDirName, workflowState.workflow_id);
      if (ritual.toolError) {
        printResults([ritual.toolError]);
        const sourceState = readStateJson(planDir)?.state || null;
        const toolReceipt = finalizeToolErrorTransition({
          projectRoot: cwd,
          planDirName,
          planDir,
          gate,
          sourceState,
          targetState: gateDef?.to ? gateDef.to.toUpperCase() : sourceState,
          results: [...allResults, ritual.toolError],
          preparation: preparationReport,
          generatedAt: nowISO(),
          dryRun,
        });
        console.log();
        console.log(renderTransitionVerdict(toolReceipt));
        return 3;
      }
      const counts = ritual.result?.issue_counts || { total: 0, blocking: ritual.ok ? 0 : 1, warnings: 0 };
      const detail = ritual.result
        ? `workflow=${workflowState.workflow_id}; issues=${counts.total} (blocking ${counts.blocking}, warnings ${counts.warnings})`
        : `ritual_lint.mjs failed before producing JSON${ritual.stderr ? `: ${ritual.stderr.trim()}` : ""}`;
      const r = withFailureCode(check(
        "Workflow ritual contract",
        ritual.ok ? PASS : FAIL,
        detail
      ), "GATE-RIT-001");
      printResults([r]);
      for (const issue of ritual.result?.issues || []) {
        console.log(`  - [${issue.severity}] ${issue.id}: ${issue.message}`);
        if (issue.repair_command) console.log(`    Repair: ${issue.repair_command}`);
      }
      allResults.push(r);
      console.log();
    }
  }

  if (gate === "explore-to-plan") {
    printSection("Pre-Planning Scaffolding");
    const scaffold = evaluatePreplanningScaffolding({ cwd, planDir, skillPath });
    printResults(scaffold.results);
    allResults.push(...scaffold.results);
    if (scaffold.actions.length > 0) {
      console.log(`  Shape: ${scaffold.shape}`);
      for (const action of scaffold.actions) {
        const codeLabel = action.code ? ` [${action.code}]` : "";
        console.log(`  Action${codeLabel} ${action.finding_id}: ${action.action}`);
      }
    }
    console.log();
  }

  // Step 2: Gate checks (delegated to verify_gate.mjs — single authoritative implementation)
  printSection("Gate Checks");
  const modules = await loadGateFunctions();
  const { GATES, evaluateGateResults } = modules.verifyGate;
  const gateFn = GATES[gate];
  const gateEvaluation = gateFn
    ? evaluateGateResults(planDir, gate, {
        refreshSnapshot: sharedPlanRefresh,
        executedTestEvidence: pendingPersistence.executedTest,
      })
    : { results: [], anti_ritual: null };
  const gateResults = gateEvaluation.results;
  if (!gateFn) {
    gateResults.push(check(`Gate function for "${gate}"`, WARN, "No gate function defined for this transition"));
  }
  const gateCounts = printResults(gateResults);
  allResults.push(...gateResults);
  if (gateEvaluation.anti_ritual?.status && gateEvaluation.anti_ritual.status !== "clean") {
    console.log(`  ↳ anti_ritual: ${gateEvaluation.anti_ritual.status} (${gateEvaluation.anti_ritual.recommended_action})`);
    console.log(`    ${gateEvaluation.anti_ritual.detail}`);
  }
  console.log();

  // Step 3: Checklist
  printSection("Checklist");
  const checklistResults = runChecklist(gate, planDirName, { skillPath, plansDir, knowledgeDir, cwd, refreshSnapshot: sharedPlanRefresh });
  const checklistCounts = printResults(checklistResults);
  allResults.push(...checklistResults);
  console.log();

  // Step 3.5: Tool trace audit (if feature enabled AND gate has trace_audit:true)
  // BUG-6: Previously gates.json trace_audit field was dead config — now wired in
  let _traceSummary = null;
  if (isFeatureEnabled("tool_trace") && gateDef?.trace_audit !== false) {
    printSection("Tool Trace Audit");
    try {
      const { auditTrace } = await import(join(skillPath, "scripts", "trace_auditor.mjs"));
      const { detectIDE, formatIDEWarning } = await import(join(skillPath, "scripts", "lib", "ide_detect.mjs"));

      const ideInfo = detectIDE(cwd);
      const traceAuditMode = ideInfo.trace_audit_mode || (ideInfo.trace_method ? "supported" : "unsupported");

      // When the IDE cannot capture traces, suppress trace-dependent advisory
      // rows instead of printing warnings operators cannot repair here.
      // Supported IDEs still run the full trace audit below.
      if (traceAuditMode === "unsupported") {
        const r = check(
          "IDE trace support",
          PASS,
          `${formatIDEWarning(ideInfo) || "IDE does not support tool trace capture"}; trace audit suppressed for this transition.`
        );
        printResults([r]);
        allResults.push(r);
        _traceSummary = {
          total_calls: 0,
          coverage_pct: 100,
          ide: ideInfo.ide,
          rules_checked: 0,
          rules_passed: 0,
          status: "unsupported_suppressed",
          last_audit: nowISO(),
        };
      } else if (traceAuditMode === "not_applicable") {
        const r = check(
          "IDE trace support",
          PASS,
          "Codex sessions do not expose external PostToolUse hook files; skipping tool trace audit."
        );
        printResults([r]);
        allResults.push(r);
        _traceSummary = {
          total_calls: 0,
          coverage_pct: 100,
          ide: ideInfo.ide,
          rules_checked: 0,
          rules_passed: 0,
          status: "not_applicable",
          last_audit: nowISO(),
        };
      } else {
        // RT3-M2-FIX: Derive phase from gates.json `from` field, not by splitting gate name.
        // "notify-user" has no "-to-" separator, causing auditPhase = "NOTIFY-USER" (invalid).
        const auditPhase = (Array.isArray(gateDef?.from) ? gateDef.from[0] : gateDef?.from)?.toUpperCase() || "EXPLORE";
        const { results: traceResults, coverage, totalRules, passedRules } = auditTrace(planDir, auditPhase);
        const effectiveTraceResults = traceResults;
        printResults(effectiveTraceResults);
        allResults.push(...effectiveTraceResults);

        _traceSummary = {
          total_calls: traceResults.length,
          coverage_pct: coverage,
          ide: ideInfo.ide,
          rules_checked: totalRules,
          rules_passed: passedRules,
          last_audit: nowISO(),
        };

        console.log(`  Coverage: ${coverage}% (${passedRules}/${totalRules} rules)`);
      }
    } catch (e) {
      const r = check("Tool trace audit", WARN, `Trace audit error: ${e.message}`);
      printResults([r]);
      allResults.push(r);
    }
    console.log();
  }

  // Step 3.75: Reachability audit (RT-HARDENING-007)
  // Exhaustive state-space analysis — detects deadlocks, forbidden paths,
  // gate bypasses, and privilege escalation routes via Prolog backtracking.
  // RT-RCH-002: NOT gated by feature flag — only by gates.json per-gate field.
  // An LLM can edit determinism.json but cannot bypass gates.json integrity check.
  if (gateDef?.reachability_audit) {
    printSection("Reachability Audit (compulsory)");
    try {
      const { runReachabilityAudit } = await import(join(skillPath, "scripts", "rule_engine.mjs"));
      const reachResults = runReachabilityAudit({ refreshSnapshot: sharedPlanRefresh });
      const reachCounts = printResults(reachResults);
      allResults.push(...reachResults);
    } catch (e) {
      const r = withFailureCode(check("Reachability audit", FAIL, `Audit error: ${e.message}`), "GATE-RCH-001");
      printResults([r]);
      allResults.push(r);
    }
    console.log();
  }

  // Step 4: Semantic rule checks (MANDATORY — Prolog verification is required)
  {
    const ruleEnginePath = join(skillPath, "scripts", "rule_engine.mjs");
    const prologDirPath = join(skillPath, "prolog");

    if (!existsSync(prologDirPath) || !existsSync(ruleEnginePath)) {
      // Missing Prolog infrastructure is a hard failure — do not allow transitions without it
      printSection("Semantic Checks (Prolog)");
      const r = withFailureCode(check("Prolog rule engine", FAIL,
        `Required files missing: ${!existsSync(prologDirPath) ? "prolog/ directory" : "rule_engine.mjs"} — Prolog verification is mandatory`), "GATE-SEM-005");
      printResults([r]);
      allResults.push(r);
      console.log();
    } else {
      printSection("Semantic Checks (Prolog)");
      try {
        const { runSemanticChecks, enrichViolationsWithFixes } = await import(ruleEnginePath);
        let semanticResults = runSemanticChecks(gate, planDir, { refreshSnapshot: sharedPlanRefresh });
        // Phase B: enrich invariant violations with supervisor-generated fix commands.
        // Best-effort — degrades gracefully if supervisor or LLM is unavailable.
        // Skipped when there are no violations to enrich (zero LLM cost).
        if (typeof enrichViolationsWithFixes === "function") {
          try {
            semanticResults = await enrichViolationsWithFixes(semanticResults);
          } catch { /* enrichment is best-effort; original semantic results are still usable */ }
        }
        if (semanticResults.length > 0) {
          const mapped = semanticResults.map((r) => {
            const row = r.code
              ? withFailureCode(check(r.name, r.status, r.detail), r.code)
              : check(r.name, r.status, r.detail);
            if (r.violations) row.violations = r.violations;
            if (r.degraded_coverage) row.degraded_coverage = r.degraded_coverage;
            return row;
          });
          // T-INTAKE-A0AAAFC1 AC3: recurring WARN advisories (identical name+detail
          // already shown at a previous transition of this plan) are suppressed to a
          // single count line. Display-only — allResults still carries every WARN, so
          // summaries, decision logs, and enforcement are unchanged.
          const advisoryMarkerPath = join(planDir, "artifacts", ".invariant_advisories.json");
          let previouslyShown = new Set();
          try { previouslyShown = new Set(JSON.parse(readFileSync(advisoryMarkerPath, "utf-8")).keys || []); } catch { /* first transition */ }
          const advisoryKey = (r) => `${r.name}::${r.detail || ""}`;
          const recurring = mapped.filter((r) => r.status === WARN && previouslyShown.has(advisoryKey(r)));
          const printable = mapped.filter((r) => !recurring.includes(r));
          printResults(printable);
          if (recurring.length > 0) {
            console.log(`  ⚠️ ${recurring.length} recurring advisor${recurring.length === 1 ? "y" : "ies"} suppressed (unchanged since a previous transition; full list: plans/${planDirName}/artifacts/.invariant_advisories.json)`);
          }
          pendingPersistence.invariantAdvisories = {
            path: advisoryMarkerPath,
            payload: {
              updated_at: nowISO(),
              gate,
              keys: mapped.filter((r) => r.status === WARN).map(advisoryKey),
              entries: mapped.filter((r) => r.status === WARN),
            },
          };
          allResults.push(...mapped);
          // Phase B: render Suggested Fixes via the unit-tested helper rather
          // than inline so the rendered format is locked by governed test_advise.mjs scenarios.
          try {
            const { renderSuggestedFixesBlock } = await import("./lib/supervisor_runner.mjs");
            const block = renderSuggestedFixesBlock(semanticResults);
            if (block) {
              console.log();
              console.log(block);
            }
          } catch { /* helper unavailable — fall back to silent (data still in JSON) */ }
        } else {
          const r = check("Semantic checks", PASS, "No semantic issues");
          printResults([r]);
          allResults.push(r);
        }

        // Determinism: always write Prolog proof trace after a successful run
        const semanticGoal = isAuditOnlyGate
          ? `audit_gate_allowed(${gate.replace(/-/g, "_")})`
          : `can_transition(${gate.replace("-to-", ", ")})`;
        pendingPersistence.semanticTrace = {
          gate,
          facts_source: "state.json + story_registry.json",
          goal: semanticGoal,
          result: deriveGateDecision(semanticResults),
          checks: semanticResults,
          timestamp: nowISO(),
        };

        // T-INTAKE-A2D49302: one fail-closed classifier owns both live callers.
        // It quiets only fully structured ordinary story-invariant differences;
        // unknown, mixed, missing, I-035, and engine-level blockers stay hard.
        const jsGateBlocked = gateResults.some(gateResultBlocks);
        const divergenceResults = classifySemanticDivergence({
          jsGateBlocked,
          semanticResults,
          enforcePrologDivergence: isFeatureEnabled("prolog_enforce_mode"),
        });
        if (divergenceResults.length > 0) {
          printResults(divergenceResults);
          allResults.push(...divergenceResults);
        }

        console.log();
      } catch (e) {
        // Prolog execution errors are hard failures — not warnings
        const r = withFailureCode(check("Semantic checks", FAIL, `Prolog verification failed: ${e.message}`), "GATE-SEM-005");
        printResults([r]);
        allResults.push(r);
        console.log();
      }
    }
  }

  // Registry signing is verdict-bound. The semantic evaluator may transiently
  // model an intentional registry change, but only a successful transition may
  // persist its hash below at the canonical state-write boundary.
  evaluatedRegistrySnapshot = readStoryRegistrySnapshot(cwd);
  if (evaluatedRegistrySnapshot.present && !evaluatedRegistrySnapshot.ok) {
    printSection("Story Registry Integrity");
    const result = withFailureCode(check(
      "Story registry integrity",
      FAIL,
      evaluatedRegistrySnapshot.error,
    ), "GATE-SEM-002");
    printResults([result]);
    allResults.push(result);
    console.log();
  }

  // Final guide-first normalization. Any uncoded FAIL is a planner contract
  // defect, never an ordinary blocker with an empty failure-code list.
  const normalizedGateResults = normalizeGateResultsForTransition(allResults, { gate, planId: planDirName });
  allResults.splice(0, allResults.length, ...normalizedGateResults);

  let totalPass = allResults.filter(r => r.status === PASS).length;
  let totalWarn = allResults.filter(r => r.status === WARN).length;
  let totalFail = allResults.filter(r => r.status === FAIL).length;
  let totalSkip = allResults.filter(r => r.status === SKIP).length;

  console.log(`  Summary: ${totalPass} PASS, ${totalWarn} WARN, ${totalFail} FAIL${totalSkip ? `, ${totalSkip} SKIP` : ""}`);

  // --- Determinism: decision log + state.json update ---
  const scriptVersions = hashAllScripts(skillPath);
  let failureCodes = [...new Set(allResults.filter(gateResultBlocks).map(r => r.code))];
  const transitionTimestamp = nowISO();
  const sourceStateForReceipt = readStateJson(planDir)?.state || expectedSources[0]?.toUpperCase() || null;
  const targetStateForReceipt = gateDef?.to ? gateDef.to.toUpperCase() : sourceStateForReceipt;
  let receipt = buildTransitionReceipt({
    projectRoot: cwd,
    planId: planDirName,
    gate,
    sourceState: sourceStateForReceipt,
    targetState: targetStateForReceipt,
    results: allResults,
    preparation: preparationReport,
    generatedAt: transitionTimestamp,
  });

  // The persistence boundary begins only after the complete evaluator has
  // produced its normalized receipt. Dry-run returns the in-memory receipt;
  // actual execution continues with artifact, audit-log, metric, and state writes.
  if (dryRun) {
    if (totalFail > 0 && failureCodes?.length > 0) {
      console.log(`  Failure codes: ${failureCodes.join(", ")}`);
    }
    console.log();
    console.log(renderTransitionVerdict(receipt));
    return totalFail > 0 ? 1 : 0;
  }

  // Preserve the exact top-level plan bytes evaluated by a successful
  // plan-to-execute gate before any post-verdict artifacts or state mutation.
  // Preparation is memory-only; replay authority is published below only if
  // the capture itself can be persisted and verified.
  let pendingGateInputSnapshot = null;
  let persistedGateInputSnapshot = null;
  if (totalFail === 0 && gate === "plan-to-execute" && planDir) {
    try {
      pendingGateInputSnapshot = prepareGateInputSnapshot({
        planDir,
        gate,
        capturedAt: transitionTimestamp,
      });
    } catch (error) {
      allResults.push(withFailureCode(check(
        "Gate-time replay input capture",
        FAIL,
        `Could not capture the evaluated plan input: ${error.message}`,
      ), "GATE-RUN-001"));
      const normalized = normalizeGateResults(allResults, { gate, planId: planDirName });
      allResults.splice(0, allResults.length, ...normalized);
      totalPass = allResults.filter((result) => result.status === PASS).length;
      totalWarn = allResults.filter((result) => result.status === WARN).length;
      totalFail = allResults.filter((result) => result.status === FAIL).length;
      failureCodes = [...new Set(allResults.filter(gateResultBlocks).map((result) => result.code))];
      receipt = buildTransitionReceipt({
        projectRoot: cwd,
        planId: planDirName,
        gate,
        sourceState: sourceStateForReceipt,
        targetState: targetStateForReceipt,
        results: allResults,
        preparation: preparationReport,
        generatedAt: transitionTimestamp,
      });
    }
  }

  // Persist artifacts computed by the shared evaluator without recomputing
  // their truth. These writes cannot influence the verdict above.
  try {
    for (const item of pendingPersistence.health) {
      await persistHealthScan(planDir, item.mode, item.report);
    }
    if (pendingPersistence.persona) {
      persistPersonaAuditArtifacts(planDir, pendingPersistence.persona);
    }
    if (pendingPersistence.executedTest) {
      writeExecutedTestGateEvidence(planDir, pendingPersistence.executedTest);
    }
    if (pendingPersistence.scope) {
      writeScopeContract({ cwd, planDir, planContent: pendingPersistence.scope.planContent });
    }
    if (sharedPlanRefresh?.ontology?.facts) {
      writeFileSync(join(planDir, "ontology_facts.pl"), `${sharedPlanRefresh.ontology.facts}\n`);
      sharedPlanRefresh.ontology.persisted = true;
    }
    syncFindingsMarkdownFromLedger(planDir);
    if (pendingPersistence.invariantAdvisories) {
      mkdirSync(dirname(pendingPersistence.invariantAdvisories.path), { recursive: true });
      writeFileSync(
        pendingPersistence.invariantAdvisories.path,
        `${JSON.stringify(pendingPersistence.invariantAdvisories.payload, null, 2)}\n`,
      );
    }
    if (pendingPersistence.semanticTrace) {
      writeProofTrace(planDir, gate, pendingPersistence.semanticTrace);
    }
  } catch (error) {
    debugLog("transition", `post-verdict artifact persistence failed: ${error.message}`);
  }

  // The canonical state lock owns the complete publication/finalization window.
  // A leftover journal is either safely aborted while state still matches its
  // before-token, or it blocks this invocation for explicit reconciliation.
  let releaseLock = null;
  let lockedStateRead = null;
  let transitionJournalWrite = null;
  if (!isAuditOnlyGate) {
    releaseLock = acquireStateLock(planDir);
    if (!releaseLock) {
      const row = withFailureCode(check(
        "Canonical state lock",
        FAIL,
        "Could not acquire state.json lock — concurrent transition detected."
      ), "GATE-STA-001");
      allResults.push(row);
      const normalized = normalizeGateResults(allResults, { gate, planId: planDirName });
      allResults.splice(0, allResults.length, ...normalized);
      receipt = buildTransitionReceipt({
        projectRoot: cwd,
        planId: planDirName,
        gate,
        sourceState: sourceStateForReceipt,
        targetState: targetStateForReceipt,
        results: allResults,
        preparation: preparationReport,
        generatedAt: transitionTimestamp,
        persistence: { decision_log: false, state: false, metrics: false },
      });
      receipt = writeTransitionReceipt(planDir, receipt, { projectRoot: cwd }).receipt;
      console.log();
      console.log(renderTransitionVerdict(receipt));
      return 1;
    }

    const recovered = recoverTransitionJournal(planDir);
    if (recovered.status === "recovery_required") {
      releaseLock();
      const row = withFailureCode(check(
        "Transition journal recovery",
        FAIL,
        `An interrupted transition requires reconciliation (${recovered.action}: ${recovered.reason || recovered.phase || "unknown"}).`,
      ), "GATE-STA-002");
      allResults.push(row);
      const normalized = normalizeGateResults(allResults, { gate, planId: planDirName });
      allResults.splice(0, allResults.length, ...normalized);
      receipt = writeTransitionReceipt(planDir, buildTransitionReceipt({
        projectRoot: cwd,
        planId: planDirName,
        gate,
        sourceState: sourceStateForReceipt,
        targetState: targetStateForReceipt,
        results: allResults,
        preparation: preparationReport,
        generatedAt: transitionTimestamp,
      }), { projectRoot: cwd }).receipt;
      console.log();
      console.log(renderTransitionVerdict(receipt));
      return 1;
    }

    lockedStateRead = readStateJsonWithProvenance(planDir);
    transitionJournalWrite = writeTransitionJournal(planDir, {
      gate,
      phase: "prepared",
      plan_id: planDirName,
      transition_timestamp: transitionTimestamp,
      state_before: lockedStateRead.provenance,
      state_after: null,
      receipt_paths: [],
      decision_status: "pending",
    }, { expected: null });
    if (transitionJournalWrite.status !== "committed") {
      releaseLock();
      throw new Error(`transition journal ${transitionJournalWrite.status}: ${transitionJournalWrite.reason}`);
    }
  }

  if (totalFail === 0 && pendingGateInputSnapshot) {
    try {
      persistedGateInputSnapshot = persistGateInputSnapshot(pendingGateInputSnapshot);
      console.log(`  ↳ Captured gate-time replay input: ${persistedGateInputSnapshot.relative_path}`);
    } catch (error) {
      allResults.push(withFailureCode(check(
        "Gate-time replay input persistence",
        FAIL,
        `Could not persist verified gate-time input: ${error.message}`,
      ), "GATE-RUN-001"));
      const normalized = normalizeGateResults(allResults, { gate, planId: planDirName });
      allResults.splice(0, allResults.length, ...normalized);
      totalPass = allResults.filter((result) => result.status === PASS).length;
      totalWarn = allResults.filter((result) => result.status === WARN).length;
      totalFail = allResults.filter((result) => result.status === FAIL).length;
      failureCodes = [...new Set(allResults.filter(gateResultBlocks).map((result) => result.code))];
      receipt = buildTransitionReceipt({
        projectRoot: cwd,
        planId: planDirName,
        gate,
        sourceState: sourceStateForReceipt,
        targetState: targetStateForReceipt,
        results: allResults,
        preparation: preparationReport,
        generatedAt: transitionTimestamp,
      });
    }
  }

  let receiptWrite;
  try {
    receiptWrite = writeTransitionReceipt(planDir, receipt, { projectRoot: cwd });
  } catch (error) {
    if (persistedGateInputSnapshot) removeGateInputSnapshot(persistedGateInputSnapshot);
    if (releaseLock) releaseLock();
    throw error;
  }
  receipt = receiptWrite.receipt;

  let logWriteResult = null;
  let logWritten = false;

  // State.json update
  let statePersisted = isAuditOnlyGate;
  let stateWriteResult = null;
  let metricsPersisted = false;
  if (!isAuditOnlyGate) {
    const stateRead = lockedStateRead;
    const stateJson = stateRead.state;
    if (stateJson) {
      if (sharedPlanRefresh?.closeSignals) {
        stateJson.close_signals = {
          ...sharedPlanRefresh.closeSignals,
          ontology: sharedPlanRefresh.ontology,
        };
      }
      // v7.4.1: opportunistic plan_shape detection for legacy plans that
      // predate v7.3.0. Without this, those plans can never benefit from
      // shape-aware gates because `state.json.plan_shape` is missing and
      // every shape consumer falls through to the strict "unknown" default.
      // Detection runs once per plan and is purely additive — no existing
      // field is overwritten.
      if (!stateJson.plan_shape || !stateJson.plan_shape.primary) {
        try {
          const { detectPlanShape } = await import("./lib/plan_shape.mjs");
          const planContent = readFileSync(join(planDir, "plan.md"), "utf-8");
          const filesSection = planContent.match(/##\s+Files\s+[Tt]o\s+[Mm]odify\s*\n([\s\S]*?)(?=\n##|$)/);
          let plannedFiles = [];
          if (filesSection) {
            plannedFiles = (filesSection[1].match(/^\s*[-*]\s+`?([^`\s]+)`?/gm) || [])
              .map((line) => line.replace(/^\s*[-*]\s+`?/, "").replace(/`?\s*$/, "").trim())
              .filter(Boolean);
          }
          let intentContract = null;
          try {
            intentContract = JSON.parse(readFileSync(join(planDir, "intent_contract.json"), "utf-8"));
          } catch { /* tolerate */ }
          const detected = detectPlanShape({
            goalText: stateJson.goal || "",
            plannedFiles,
            intentContract,
          });
          stateJson.plan_shape = {
            primary: detected.primary,
            source: `${detected.source}:opportunistic_legacy`,
            requirements: detected.requirements,
            detected_at: nowISO(),
          };
          console.log(`  ↳ Detected plan shape '${detected.primary}' for legacy plan (no plan_shape field present); persisting to state.json`);
        } catch (err) {
          // best effort — never block a transition on shape detection
        }
      }

      // v7.4.2: opportunistic backfill of fields that legacy plans (v7.2.0
      // or earlier) don't have. circuit_breakers is the most important:
      // cmdFixStuck uses Object.values(stateJson.circuit_breakers || {}) to
      // detect stuck plans, and a missing field fell through to 0 — masking
      // real stuck-state from agents who needed to see it. Adding the empty
      // object so the field is always defined.
      if (!stateJson.circuit_breakers) {
        stateJson.circuit_breakers = {};
      }

      if (totalFail === 0 && evaluatedRegistrySnapshot?.ok && evaluatedRegistrySnapshot.present) {
        stateJson.registry_hash = evaluatedRegistrySnapshot.hash;
      }

      const previousState = stateJson.state; // capture BEFORE mutation
      const gateToField = gateDef?.to;
      const targetState = gateToField
        ? gateToField.toUpperCase()
        : stateJson.state;

      // Forward-scaffold the immediately-next gate's artifacts when entering EXECUTE.
      // This pre-fills verification.md, red_team_notes.md, reflection.md, and
      // progress.md with the structural sections that execute-to-reflect will
      // enforce. The agent during EXECUTE only needs to fill in content, not
      // discover format requirements through gate-rejection cycles. Scaffolding
      // runs BEFORE state mutation so gate_prepare sees the pre-transition state.
      if (totalFail === 0 && gate === "plan-to-execute" && planDir) {
        try {
          const { buildResult: prepareGate } = await import("./gate_prepare.mjs");
          const downstreamGate = "execute-to-reflect";
          const result = prepareGate({ cwd, gate: downstreamGate, planArg: planDirName, write: true });
          const actionCount = (result.write_actions || []).filter(
            (a) => ["created", "updated", "written", "appended_missing_tokens"].includes(a.status)
          ).length;
          if (actionCount > 0) {
            console.log(`  ↳ Forward-scaffolded ${downstreamGate}: ${actionCount} section(s)`);
          }
        } catch (e) {
          // Best-effort — forward scaffolding must never block a transition.
          console.warn(`  ↳ Forward-scaffolding skipped: ${e.message}`);
        }
      }

      if (totalFail === 0 && gateToField) {
        stateJson.state = targetState;
      }
      stateJson.transitions.push({
        from: previousState,
        to: totalFail > 0 ? previousState : targetState,
        timestamp: nowISO(),
        gate_result: totalFail > 0 ? "FAIL" : "PASS",
        failure_codes: failureCodes,
        script_versions: scriptVersions,
      });
      stateJson.script_versions = scriptVersions;
      stateJson.rule_bundle_version = getRuleBundleVersion();
      // RT9-I1: Soft warning when re-plan loop count is high.
      // Counts transitions TO re_plan state — more than 3 suggests the plan is struggling.
      const replanCount = stateJson.transitions.filter(t =>
        (t.to || "").toLowerCase() === "re_plan" && verificationStatusIsPass(t.gate_result, "gate")
      ).length;
      if (replanCount >= 3) {
        console.log(`  ⚠ WARNING: ${replanCount} re-plan cycles detected. Consider closing and starting a fresh plan, or escalating scope.`);
      }
      // Tool trace summary (if audit ran)
      if (_traceSummary) {
        stateJson.trace_summary = _traceSummary;
      }
      if (totalFail === 0 && gate === "explore-to-plan" && existsSync(join(knowledgeDir, "index.md"))) {
        const kbDigestSalt = randomBytes(KB_SALT_BYTES).toString("hex");
        stateJson.kb_digest_hash = createHash("sha256")
          .update(kbDigestSalt + readKnowledgeDigestContent())
          .digest("hex")
          .slice(0, 32);
        persistAutoModeKbDigestProof(planDir, kbDigestSalt);
      }
      // PERSISTENT CIRCUIT BREAKER: Track total fails per gate across all sessions.
      // The consecutive-tail counter (above) resets when a different gate runs, which
      // an automation engine can exploit. This counter persists in state.json and is
      // immune to gate-swapping. Threshold: 10 total failures → gate blocked until
      // explicit reset via: node bootstrap.mjs reset-circuit-breaker <gate>
      if (!stateJson.circuit_breakers) stateJson.circuit_breakers = {};
      if (!stateJson.circuit_breakers[gate]) stateJson.circuit_breakers[gate] = { total_fails: 0 };
      if (totalFail > 0) {
        stateJson.circuit_breakers[gate].total_fails += 1;
        stateJson.circuit_breakers[gate].last_fail_at = nowISO();
      } else {
        stateJson.circuit_breakers[gate].total_fails = 0; // reset on PASS
        delete stateJson.circuit_breakers[gate].last_fail_at;
      }
      // Phase 0.5 metrics: capture this gate attempt (pass or fail) per plan —
      // total attempts, retries (prior failures for this gate folded in), and
      // close timing. Best-effort; metrics.json is a side artifact and must
      // never block a transition.
      try {
        const recordedMetrics = recordGateMetrics({
          projectRoot: cwd,
          planDirName,
          planDir,
          gate,
          status: totalFail === 0 ? "PASS" : "FAIL",
          at: nowISO(),
          failureCodes: totalFail > 0
            ? allResults.filter((r) => r && gateResultBlocks(r) && r.code).map((r) => r.code)
            : [],
          advisoryCodes: allResults.filter((r) => r && r.status === WARN && r.code).map((r) => r.code),
          advisoryConversions: allResults.filter((r) => r && r.status === WARN && r.advisory_conversion === true).length,
          resultingState: totalFail === 0 ? stateJson.state : null,
        });
        metricsPersisted = recordedMetrics?.persistence?.status === "committed";
      } catch (e) {
        debugLog("transition", `plan metrics record failed: ${e.message}`);
      }

      stateWriteResult = writeStateJsonResult(planDir, stateJson, {
        expected: stateRead.provenance,
        allowPhaseMutation: true,
        mutationOrigin: `transition:${gate}`,
        deferFinalize: true,
      });
      if (stateWriteResult.status === "committed") {
        const publishedJournal = writeTransitionJournal(planDir, {
          ...transitionJournalWrite.journal,
          phase: "state_published",
          state_after: stateWriteResult.published,
          receipt_paths: [receiptWrite.immutable_path, receiptWrite.latest_path],
        }, { expected: transitionJournalWrite.token });
        if (publishedJournal.status !== "committed") {
          rollbackOwnedFileReplace(stateWriteResult);
          throw new Error(`transition journal publication ${publishedJournal.status}: ${publishedJournal.reason}`);
        }
        transitionJournalWrite = publishedJournal;
      }
    }
  } else {
    console.log("  Audit-only gate: canonical planner state/history left unchanged.");
    try {
      const recordedMetrics = recordGateMetrics({
        projectRoot: cwd,
        planDirName,
        planDir,
        gate,
        status: totalFail === 0 ? "PASS" : "FAIL",
        at: transitionTimestamp,
        failureCodes,
        advisoryCodes: allResults.filter((r) => r && r.status === WARN && r.code).map((r) => r.code),
        advisoryConversions: allResults.filter((r) => r && r.status === WARN && r.advisory_conversion === true).length,
        resultingState: sourceStateForReceipt,
      });
      metricsPersisted = recordedMetrics?.persistence?.status === "committed";
    } catch (error) {
      debugLog("transition", `audit-only plan metrics record failed: ${error.message}`);
    }
  }

  let statePersistenceFailureAdded = false;
  if (!isAuditOnlyGate && stateWriteResult?.status !== "committed") {
    if (persistedGateInputSnapshot) removeGateInputSnapshot(persistedGateInputSnapshot);
    const row = withFailureCode(check(
      "Canonical state persistence",
      FAIL,
      `state.json publication ${stateWriteResult?.status || "missing"} (${stateWriteResult?.reason || "no structured result"}); the transition cannot claim a state change.`,
    ), "GATE-STA-002");
    allResults.push(row);
    const normalized = normalizeGateResults(allResults, { gate, planId: planDirName });
    allResults.splice(0, allResults.length, ...normalized);
    totalFail = allResults.filter((result) => result.status === FAIL).length;
    totalWarn = allResults.filter((result) => result.status === WARN).length;
    failureCodes = [...new Set(allResults.filter(gateResultBlocks).map((result) => result.code))];
    statePersistenceFailureAdded = true;
  }

  // Decision publication follows canonical state publication but precedes owned
  // finalization. A decision failure can therefore roll state back by token.
  logWriteResult = appendDecisionLogResult(planDir, buildDecisionEntry(
    gate,
    { plan: planDirName, source_state: expectedSources.join("|") },
    allResults,
    deriveGateDecision(allResults),
    totalFail > 0 ? null : (gateDef?.to ? gateDef.to.toUpperCase() : null)
  ), { deferFinalize: !isAuditOnlyGate });
  logWritten = logWriteResult.status === "committed";
  if (!logWritten && isFeatureEnabled("decision_logs")) {
    if (stateWriteResult?.status === "committed") {
      const rollback = rollbackOwnedFileReplace(stateWriteResult);
      if (rollback.status === "committed" && transitionJournalWrite?.token) {
        removeTransitionJournal(transitionJournalWrite);
      }
    }
    if (persistedGateInputSnapshot) removeGateInputSnapshot(persistedGateInputSnapshot);
    const row = withFailureCode(check(
      "Decision log persistence",
      FAIL,
      `Decision log write ${logWriteResult.status} (${logWriteResult.reason}) — audit trail incomplete.`
    ), "GATE-AUD-001");
    allResults.push(row);
    const normalized = normalizeGateResults(allResults, { gate, planId: planDirName });
    allResults.splice(0, allResults.length, ...normalized);
    totalFail = allResults.filter((result) => result.status === FAIL).length;
    totalWarn = allResults.filter((result) => result.status === WARN).length;
    failureCodes = [...new Set(allResults.filter(gateResultBlocks).map((result) => result.code))];
    receipt = buildTransitionReceipt({
      projectRoot: cwd,
      planId: planDirName,
      gate,
      sourceState: sourceStateForReceipt,
      targetState: targetStateForReceipt,
      results: allResults,
      preparation: preparationReport,
      generatedAt: transitionTimestamp,
    });
    receipt = writeTransitionReceipt(planDir, receipt, { projectRoot: cwd }).receipt;
    if (releaseLock) releaseLock();
    console.log();
    console.log(renderTransitionVerdict(receipt));
    return 1;
  }

  if (stateWriteResult?.status === "committed") {
    const decisionFinalization = isFeatureEnabled("decision_logs")
      ? finalizeOwnedFileReplace(logWriteResult)
      : { status: "committed", reason: "decision_logs_disabled" };
    if (decisionFinalization.status !== "committed") {
      rollbackOwnedFileReplace(stateWriteResult);
      logWritten = false;
    } else {
      const finalization = finalizeOwnedFileReplace(stateWriteResult);
      if (finalization.status === "committed") {
      statePersisted = true;
      const persistedState = readStateJson(planDir);
      if (persistedState) {
        syncStateMarkdown(planDir, persistedState);
        syncActivePlanAlias(plansDir, { planDirName, planDir, stateJson: persistedState });
      }
      }
    }
  } else if (!isAuditOnlyGate && logWriteResult?.status === "committed" && isFeatureEnabled("decision_logs")) {
    const decisionFinalization = finalizeOwnedFileReplace(logWriteResult);
    if (decisionFinalization.status !== "committed") logWritten = false;
  }

  if (!statePersisted && !statePersistenceFailureAdded) {
    if (persistedGateInputSnapshot) removeGateInputSnapshot(persistedGateInputSnapshot);
    const row = withFailureCode(check(
      "Canonical state persistence",
      FAIL,
      "state.json was not written; the transition cannot claim a state change."
    ), "GATE-STA-002");
    allResults.push(row);
    const normalized = normalizeGateResults(allResults, { gate, planId: planDirName });
    allResults.splice(0, allResults.length, ...normalized);
  }

  totalPass = allResults.filter((result) => result.status === PASS).length;
  totalWarn = allResults.filter((result) => result.status === WARN).length;
  totalFail = allResults.filter((result) => result.status === FAIL).length;
  totalSkip = allResults.filter((result) => result.status === SKIP).length;
  failureCodes = [...new Set(allResults.filter(gateResultBlocks).map((result) => result.code))];
  receipt = buildTransitionReceipt({
    projectRoot: cwd,
    planId: planDirName,
    gate,
    sourceState: sourceStateForReceipt,
    targetState: targetStateForReceipt,
    results: allResults,
    preparation: preparationReport,
    generatedAt: transitionTimestamp,
    persistence: { decision_log: logWritten, state: statePersisted, metrics: metricsPersisted },
  });
  let finalReceiptWrite;
  try {
    finalReceiptWrite = writeTransitionReceipt(planDir, receipt, { projectRoot: cwd });
    receipt = finalReceiptWrite.receipt;
    if (!isAuditOnlyGate && transitionJournalWrite?.token) {
      if (statePersisted) {
        const committedJournal = writeTransitionJournal(planDir, {
          ...transitionJournalWrite.journal,
          phase: "committed",
          decision_status: logWritten ? "committed" : "conflict",
          receipt_paths: [finalReceiptWrite.immutable_path, finalReceiptWrite.latest_path],
        }, { expected: transitionJournalWrite.token });
        if (committedJournal.status !== "committed") {
          throw new Error(`transition journal finalization ${committedJournal.status}: ${committedJournal.reason}`);
        }
        transitionJournalWrite = committedJournal;
        const journalCleanup = removeTransitionJournal(transitionJournalWrite);
        if (journalCleanup.status !== "committed") {
          throw new Error(`transition journal cleanup ${journalCleanup.status}: ${journalCleanup.reason}`);
        }
      } else {
        recoverTransitionJournal(planDir);
      }
    }
  } finally {
    if (releaseLock) releaseLock();
  }

  if (totalFail > 0 && failureCodes?.length > 0) {
    console.log(`  Failure codes: ${failureCodes.join(", ")}`);
  }

  if (totalFail > 0 && typeof modules?.verifyGate?.buildGateRepairPacket === "function") {
    const repairPacket = modules.verifyGate.buildGateRepairPacket({
      planDir,
      planDirName,
      gateName: gate,
      results: allResults,
    });
    if (repairPacket.length > 0) {
      // T-INTAKE-A0AAAFC1 AC2: print the full surface once per gate; on repeated
      // identical failures print a one-line pointer instead of ~1.5k tokens.
      const packetHash = createHash("sha256").update(repairPacket.join("\n")).digest("hex").slice(0, 16);
      const packetMarkerPath = join(planDir, "artifacts", `.repair_surface_${gate}.json`);
      let lastPacketHash = null;
      try { lastPacketHash = JSON.parse(readFileSync(packetMarkerPath, "utf-8")).hash; } catch { /* first attempt */ }
      console.log();
      if (lastPacketHash === packetHash) {
        console.log(`  -- Repair Surface unchanged from the previous ${gate} attempt --`);
        console.log(`     Full copy: plans/${planDirName}/artifacts/.repair_surface_${gate}.json`);
      } else {
        console.log("  -- Repair Surface --");
        for (const line of repairPacket) {
          console.log(`  ${line}`);
        }
      }
      try {
        mkdirSync(join(planDir, "artifacts"), { recursive: true });
        writeFileSync(packetMarkerPath, `${JSON.stringify({ gate, hash: packetHash, updated_at: nowISO(), lines: repairPacket }, null, 2)}\n`);
      } catch { /* marker is best-effort display state, never enforcement */ }
    }
  }

  if (totalFail === 0) {
    // Forcing function (ive-ontology-memory ticket 5): on a successful close, prompt the agent to
    // capture reusable positive memory as INERT draft Knowledge Triggers. Advisory only — never a
    // block. Pairs with the bootstrap-status draft resurfacer so what is captured gets surfaced and
    // promoted instead of forgotten (the recall this whole capability replaces).
    if (gate === "validate-to-close") {
      console.log();
      console.log("  📒 Capture positive memory: if this session produced a reusable insight or strategy,");
      console.log("     propose it as an inert draft Knowledge Trigger (inert until you promote it):");
      console.log("       node .agent/skills/iterative-planner/scripts/knowledge_triggers.mjs --capture \\");
      console.log("         --id KT-<SLUG>-001 --kind insight --title \"…\" --directive \"…\" --plan-term \"…\" --proposed-from " + (planDirName || "<plan>"));
      console.log("     Drafts surface in `bootstrap status` for review/promotion. (For incident lessons, run /retro.)");
    }
    if (gate === "notify-user" && stateJsonForCloseCheck?.state === "CLOSE") {
      const cleanup = clearPlannerTargetsIfMatching(planDirName);
      if (cleanup.pointerCleared || cleanup.threadCleared) {
        const cleared = [];
        if (cleanup.pointerCleared) cleared.push("pointer");
        if (cleanup.threadCleared) cleared.push("thread target");
        console.log(`  Active plan ${cleared.join(" + ")} cleared after final closed-plan handoff.`);
      } else {
        console.log("  Active plan pointer/thread target already absent or reassigned; leaving them untouched.");
      }
    }
  }
  console.log();
  console.log(renderTransitionVerdict(receipt));
  return totalFail > 0 ? 1 : 0;
  } finally {
    restoreEnvValues(plannerEnvScope);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function transitionCli(cliArgs = process.argv.slice(2)) {
const gate = cliArgs[0];
let planOverride = null;
let dryRun = false;
let cliError = null;
for (let i = 1; i < cliArgs.length; i++) {
  if (cliArgs[i] === "--plan") {
    if (!cliArgs[i + 1] || cliArgs[i + 1].startsWith("--")) {
      cliError = "--plan requires a plan directory value";
      break;
    }
    planOverride = cliArgs[++i];
  } else if (cliArgs[i] === "--dry-run") {
    dryRun = true;
  } else {
    cliError = `Unknown flag '${cliArgs[i]}'`;
    break;
  }
}

if (!gate || gate === "--help" || gate === "help") {
  console.log(`transition.mjs — Unified gate wrapper for iterative planner state transitions

Usage:
  node transition.mjs explore-to-plan [--dry-run] [--plan <plan-dir>]      EXPLORE → PLAN gate
  node transition.mjs plan-to-execute [--dry-run] [--plan <plan-dir>]      PLAN → EXECUTE gate
  node transition.mjs execute-to-reflect [--dry-run] [--plan <plan-dir>]   EXECUTE → REFLECT gate (red-team)
  node transition.mjs reflect-to-validate [--dry-run] [--plan <plan-dir>]  REFLECT → VALIDATE gate
  node transition.mjs validate-to-close [--dry-run] [--plan <plan-dir>]    VALIDATE → CLOSE gate
  node transition.mjs notify-user [--dry-run] [--plan <plan-dir>]          KB Notification Gate
  node transition.mjs refresh-registry [--dry-run] [--plan <plan-dir>]     Phase-neutral story-registry signer

This single command runs health checks, gate verification, and checklists.
--dry-run runs the identical evaluator but writes no planner or project files.
If it outputs FAIL, you may NOT proceed.`);
  process.exit(0);
}

if (cliError) {
  console.error(`ERROR: ${cliError}`);
  process.exit(1);
}

const validGates = Object.keys(GATE_REGISTRY);
const validOperations = [...validGates, "refresh-registry"];
if (!validOperations.includes(gate)) {
  console.error(`ERROR: Unknown gate '${gate}'. Valid gates/operations: ${validOperations.join(", ")}`);
  process.exit(1);
}

if (gate === "refresh-registry") {
  try {
    process.exitCode = await runRegistryRefresh({ plan: planOverride, dryRun });
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 2;
  }
  return;
}

// Replay mode: re-evaluate a historical plan using saved artifacts
const replayDir = getReplayDir();
if (replayDir) {
  console.log(`\n  🔁 REPLAY MODE — re-evaluating from: ${replayDir}\n`);
  const artifacts = loadReplayArtifacts(replayDir);
  if (artifacts.decisionLog.length > 0) {
    console.log(`  Decision log entries: ${artifacts.decisionLog.length}`);
    for (const entry of artifacts.decisionLog) {
      console.log(`    ${entry.timestamp} ${entry.gate} → ${entry.decision}`);
      if (entry.failure_codes?.length > 0) {
        console.log(`      Codes: ${entry.failure_codes.join(", ")}`);
      }
    }
  }
  if (artifacts.proofTraces.length > 0) {
    console.log(`\n  Prolog proof traces: ${artifacts.proofTraces.length}`);
    for (const trace of artifacts.proofTraces) {
      console.log(`    ${trace.file}: goal=${trace.goal} result=${trace.result}`);
    }
  }
  console.log(`\n  Re-running gate checks against current logic...\n`);
}

try {
  process.exitCode = await runTransition(gate, { plan: planOverride, dryRun });
} catch (error) {
  const resolvedPlan = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: planOverride });
  const planId = resolvedPlan.planDirName || planOverride || "unknown";
  const result = withFailureCode(check(
    "Transition runtime integrity",
    FAIL,
    `Unexpected transition runtime error: ${error.message}`
  ), "GATE-RUN-001");
  result.next = `Run node .agent/skills/iterative-planner/scripts/transition.mjs ${gate} --dry-run --plan ${planId}, then inspect the runtime stack.`;
  result.why = "An unexpected runtime exception makes state, proof, and terminal-output integrity uncertain.";
  let receipt = buildTransitionReceipt({
    projectRoot: cwd,
    planId,
    gate,
    sourceState: resolvedPlan.planDir ? readStateJson(resolvedPlan.planDir)?.state : null,
    targetState: null,
    results: [result],
    preparation: null,
    generatedAt: nowISO(),
  });
  if (resolvedPlan.planDir && !dryRun) {
    try {
      receipt = writeTransitionReceipt(resolvedPlan.planDir, receipt, { projectRoot: cwd }).receipt;
    } catch {
      // The terminal line still reports receipt=unavailable if persistence itself failed.
    }
  }
  console.error(error.stack || error.message);
  console.log(renderTransitionVerdict(receipt));
  process.exitCode = 2;
}
}

if (process.argv[1] && realpathSync(process.argv[1]) === __filename) {
  await transitionCli();
}
