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
//
// Exit codes: 0 = all pass (transition allowed), 1 = any FAIL (transition blocked).
// Zero dependencies — Node.js 18+.

import { readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __filename = fileURLToPath(import.meta.url);
const cwd = process.cwd();
const skillPath = resolve(dirname(__filename), "..");

const SELF_HEAL_ENV = "_PLANNER_SELF_HEAL_RUNNING";
const SELF_HEAL_SKIP_ENV = "PLANNER_SKIP_SELF_HEAL";
const SELF_HEAL_SOURCE_ENV = "PLANNER_SOURCE_REPO";

function resolveSelfHealSource(projectRoot) {
  const override = process.env[SELF_HEAL_SOURCE_ENV]?.trim();
  if (override) return resolve(projectRoot, override);

  const registryPath = join(projectRoot, ".agent", "skills", "iterative-planner", "config", ".project_registry.json");
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    const sourcePath = registry?.source_project_path;
    if (typeof sourcePath === "string" && sourcePath.trim()) {
      return resolve(sourcePath);
    }
  } catch {
    // Best-effort only — absent or stale registry means no self-heal.
  }

  return null;
}

function maybeRunSelfHeal(projectRoot, entryArgs) {
  const gateArg = process.argv[2];
  if (!gateArg || gateArg === "help" || gateArg === "--help" || gateArg === "-h") return;
  if (process.env[SELF_HEAL_ENV] === "1") return;
  if (process.env[SELF_HEAL_SKIP_ENV]) return;

  const sourceRepo = resolveSelfHealSource(projectRoot);
  if (!sourceRepo || resolve(sourceRepo) === resolve(projectRoot)) return;

  const migrateScript = join(sourceRepo, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");
  if (!existsSync(migrateScript)) {
    console.warn(`⚠️  Planner self-heal skipped — canonical migrate.mjs not found at ${migrateScript}`);
    return;
  }

  const doctor = spawnSync(process.execPath, [migrateScript, "doctor", projectRoot, "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (doctor.status !== 0) {
    console.warn(`⚠️  Planner self-heal skipped — doctor check failed (${doctor.status ?? "unknown"}).`);
    return;
  }

  let report = null;
  try {
    report = JSON.parse(doctor.stdout || "{}");
  } catch {
    console.warn("⚠️  Planner self-heal skipped — doctor output was not valid JSON.");
    return;
  }

  if (!report?.needs_repair) return;

  console.log("\n── Planner Self-Heal ──");
  console.log(`  Source repo: ${sourceRepo}`);
  console.log(`  Target repo: ${projectRoot}`);
  console.log(`  Detected drift: ${report.summary?.description || "planner repair required"}`);

  const upgrade = spawnSync(process.execPath, [migrateScript, "upgrade", projectRoot], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (upgrade.status !== 0) {
    console.error(`  ❌ Planner self-heal failed during upgrade (exit ${upgrade.status ?? "unknown"}).`);
    process.exit(upgrade.status || 1);
  }

  console.log("\n  Planner self-heal complete — re-running original command once.\n");
  const rerun = spawnSync(process.execPath, entryArgs, {
    encoding: "utf-8",
    stdio: "inherit",
    env: {
      ...process.env,
      [SELF_HEAL_ENV]: "1",
    },
  });
  process.exit(rerun.status || 0);
}

maybeRunSelfHeal(cwd, process.argv.slice(1));

const {
  getPaths,
  PASS, WARN, FAIL, check, printHeader, printSection, printResults, printSummary,
  getActivePlan, GATE_HISTORY_POISON_THRESHOLD, GATE_HISTORY_POISON_MARKER,
  summarizeGateFailureTail,
  syncActivePlanAlias, detectRecentNonActivePlanContext, formatNonActivePlanContextDetail,
  readPointer, resolvePlanTarget, clearThreadPlanTarget,
  loadFindingsLedger, syncFindingsMarkdownFromLedger,
} = await import("./lib/plan_utils.mjs");
const {
  isFeatureEnabled, readStateJson, writeStateJson,
  appendDecisionLog, buildDecisionEntry, writeProofTrace,
  hashAllScripts, nowISO, nowCompact, getReplayDir, loadReplayArtifacts,
  withFailureCode, getRuleBundleVersion, sortResults,
  checkConfigIntegrity, validateStateIntegrity,
  validateDecisionLogChain, acquireStateLock,
  writeOneTimeNonce, cleanupStaleNonces, sendNonceViaSocket,
  NONCE_BYTES, KB_SALT_BYTES,
  getApprovalMode
} = await import("./lib/determinism.mjs");
const { runPersonaAuditGate } = await import("./audit_runner.mjs");
const { runChecklist } = await import("./lib/checklist_runner.mjs");
const { refreshPlanArtifacts } = await import("./lib/plan_refresh.mjs");
const { persistReviewIntakeSource } = await import("./lib/review_intake.mjs");
const { writeScopeContract, summarizeScopeContract } = await import("./lib/scope_contract.mjs");
const { buildPhaseContract, resolveAuthorityProfile, resolveProofPosture } = await import("./lib/planner_phase_routing.mjs");
const { computePlanTamperFingerprint } = await import("./lib/plan_integrity.mjs");
const { plansDir, knowledgeDir } = getPaths(cwd);
const ACTIVE_PLAN_ALIAS_LABEL = "plans/ACTIVE_PLAN.md";

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

// ---------------------------------------------------------------------------
// Gate registry — single source of truth
// ---------------------------------------------------------------------------

const gatesJsonPath = join(skillPath, "config", "gates.json");
const GATE_REGISTRY = existsSync(gatesJsonPath)
  ? JSON.parse(readFileSync(gatesJsonPath, "utf-8")).gates
  : null;

if (!GATE_REGISTRY) {
  console.error("FATAL: config/gates.json not found — gate registry is required.");
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

function formatStateTransitionLine(transition) {
  const from = transition?.from || "?";
  const to = transition?.to || "?";
  const ts = typeof transition?.timestamp === "string"
    ? transition.timestamp.replace(/\.\d{3}Z$/, "Z")
    : nowCompact();
  const metadata = [];
  if (transition?.gate_result) metadata.push(transition.gate_result);
  if (Array.isArray(transition?.failure_codes) && transition.failure_codes.length > 0) {
    metadata.push(`codes: ${transition.failure_codes.join(", ")}`);
  }
  if (transition?.is_forced) metadata.push("FORCED");
  return `${from} → ${to} (${ts}${metadata.length > 0 ? `, ${metadata.join("; ")}` : ""})`;
}

function syncStateMarkdown(planDir, stateJson) {
  if (!planDir || !stateJson) return;

  const fixAttempts = stateJson.fix_attempts;
  const fixAttemptLines = typeof fixAttempts === "number"
    ? [fixAttempts > 0 ? `- ${fixAttempts} total` : "- (none yet)"]
    : Object.entries(fixAttempts || {}).length > 0
      ? Object.entries(fixAttempts).map(([step, count]) => `- ${step}: ${count}`)
      : ["- (none yet)"];

  const changeManifestLines = Array.isArray(stateJson.change_manifest) && stateJson.change_manifest.length > 0
    ? stateJson.change_manifest.map((entry) => `- ${typeof entry === "string" ? entry : JSON.stringify(entry)}`)
    : ["- (no changes yet)"];

  const transitions = Array.isArray(stateJson.transitions) ? stateJson.transitions : [];
  const lastTransition = transitions.length > 0
    ? formatStateTransitionLine(transitions[transitions.length - 1])
    : "INIT → EXPLORE (?)";
  const historyLines = transitions.length > 0
    ? transitions.map((transition) => `- ${formatStateTransitionLine(transition)}`)
    : ["- (no transitions recorded)"];

  const content = `# Current State: ${stateJson.state || "UNKNOWN"}
## Iteration: ${stateJson.iteration ?? "?"}
## Current Plan Step: ${stateJson.current_step || "N/A"}
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
- [ ] Re-read plan.md
- [ ] Re-read progress.md
- [ ] Re-read decisions.md (if fix attempt)
- [ ] Checkpoint created (if risky step or irreversible op)
## Fix Attempts (resets per plan step)
${fixAttemptLines.join("\n")}
## Change Manifest (current iteration)
${changeManifestLines.join("\n")}
## Last Transition: ${lastTransition}
## Transition History:
${historyLines.join("\n")}
`;

  writeFileSync(join(planDir, "state.md"), content);
}

function refreshTamperFingerprintSnapshot(planDir, planDirName, gate, reason = "transition") {
  if (!planDir || !planDirName || !gate) {
    return { refreshed: false, reason: "missing plan or gate" };
  }

  const releaseLock = acquireStateLock(planDir, 2000);
  if (!releaseLock) {
    return { refreshed: false, reason: "state lock unavailable" };
  }

  try {
    const stateJson = readStateJson(planDir);
    if (!stateJson) return { refreshed: false, reason: "state.json unreadable" };
    const fingerprint = computePlanTamperFingerprint(planDir, {
      stateJson,
      gate,
      generatedAt: nowISO(),
    });
    if (!fingerprint?.hash) return { refreshed: false, reason: "fingerprint unavailable" };

    stateJson.tamper_fingerprint = fingerprint;
    const written = writeStateJson(planDir, stateJson);
    if (written) {
      syncStateMarkdown(planDir, stateJson);
      syncActivePlanAlias(plansDir, { planDirName, planDir, stateJson });
      return { refreshed: true, hash: fingerprint.hash, reason };
    }
    return { refreshed: false, reason: "state write failed" };
  } finally {
    releaseLock();
  }
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
async function runHealthScan(planDir, mode) {
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

    // Save report
    if (mode === "quick") {
      const md = formatMarkdown(report);
      writeFileSync(join(planDir, "health_report.md"), md);
    } else {
      writeFileSync(join(planDir, "health_final.json"), JSON.stringify(report, null, 2));
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

const LLM_DRIFT_AUDIT_GATES = new Set([
  "plan-to-execute",
  "reflect-to-validate",
  "validate-to-close",
  "notify-user",
]);

const DRIFT_SENSITIVE_PATH_RE = /(^|\/)(AGENTS\.md|CLAUDE\.md|GEMINI\.md|README\.md|SKILL\.md|MIGRATION\.md|story_registry\.json|audit\.config\.json|\.agent\/rules\.md|\.agent\/workflows\/|\.agent\/skills\/iterative-planner\/(scripts|prolog|config|packs|references)|plans\/knowledge\/|reports\/user_story_audit\/|annotation)/i;

function runLlmDriftGateAudit(gate, planDirName) {
  const scriptPath = join(skillPath, "scripts", "llm_drift_auditor.mjs");
  if (!existsSync(scriptPath)) {
    return {
      status: "unavailable",
      summary: "llm_drift_auditor.mjs not installed",
      fail_open: true,
      hard_blocking: false,
      findings: [],
    };
  }
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--mode", "gate",
    "--gate", gate,
    "--plan", planDirName,
    "--json",
  ], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: {
      ...process.env,
      PLANNER_SKIP_SELF_HEAL: "1",
    },
  });
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return {
      status: "unavailable",
      summary: `LLM drift audit output was not valid JSON (exit ${result.status ?? "unknown"})`,
      fail_open: true,
      hard_blocking: false,
      findings: [],
    };
  }
}

function printLlmDriftGateAudit(result) {
  const status = result?.status || "unknown";
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const blockingCount = findings.filter((finding) => finding.classification === "stale_blocking").length;
  const advisoryCount = findings.filter((finding) => finding.classification === "stale_advisory").length;
  const providerMissing = Array.isArray(result?.provider?.missing) && result.provider.missing.length > 0
    ? ` Missing config: ${result.provider.missing.join(", ")}.`
    : "";
  const detail = status === "fresh"
    ? "No LLM-classified drift surfaced."
    : `${result?.summary || "LLM drift audit unavailable."}${providerMissing} Deterministic checks remain authoritative; this section cannot fail the gate by itself.`;
  console.log(`  ${status === "fresh" ? "✓" : "⚠"} ${status}: ${detail}`);
  if (blockingCount || advisoryCount) {
    console.log(`  Findings: ${blockingCount} stale_blocking, ${advisoryCount} stale_advisory (advisory only)`);
  }
  for (const finding of findings.slice(0, 3)) {
    console.log(`    - ${finding.classification || "unknown"} ${finding.surface || "surface"}${finding.file ? ` (${finding.file})` : ""}: ${finding.reason || finding.claim || "no detail"}`);
  }
}

function shouldPersistLlmDriftGateAudit(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  if (findings.some((finding) => ["stale_blocking", "stale_advisory"].includes(finding?.classification))) return true;
  return ["stale_blocking", "stale_advisory"].includes(result?.status);
}

function persistLlmDriftGateAuditResult(gate, planDir, result) {
  if (!planDir || !shouldPersistLlmDriftGateAudit(result)) return null;
  return persistReviewIntakeSource({
    cwd,
    planDir,
    name: `llm_drift_gate_${gate}.json`,
    payload: result,
  });
}

function extractPlannedFilesForDrift(planDir) {
  try {
    const planContent = readFileSync(join(planDir, "plan.md"), "utf-8");
    const section = planContent.match(/##\s+Files\s+To\s+Modify\s*\n([\s\S]*?)(?=\n##|$)/i);
    if (!section) return [];
    return section[1]
      .split("\n")
      .map((line) => line.match(/^\s*[-*]\s+`?([^`\n]+?)`?\s*$/)?.[1]?.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectGitStatusFilesForDrift() {
  const result = spawnSync("git", ["status", "--short"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (result.status !== 0) return [];
  return (result.stdout || "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function selectDriftMaintenanceFiles(planDir) {
  const plannedFiles = [...new Set(extractPlannedFilesForDrift(planDir))];
  if (plannedFiles.length > 0) {
    return {
      source: "plan_files",
      touched: plannedFiles.filter((file) => DRIFT_SENSITIVE_PATH_RE.test(file)),
    };
  }
  return {
    source: "git_status_fallback",
    touched: [...new Set(collectGitStatusFilesForDrift())]
      .filter((file) => DRIFT_SENSITIVE_PATH_RE.test(file)),
  };
}

function hasPendingDriftMaintenanceJob(planDir) {
  const asyncDir = join(planDir, "async");
  if (!existsSync(asyncDir)) return false;
  try {
    return readdirSync(asyncDir).some((name) => {
      if (!/^drift_job_.*\.json$/.test(name)) return false;
      try {
        const parsed = JSON.parse(readFileSync(join(asyncDir, name), "utf-8"));
        return parsed?.status === "pending" || parsed?.status === "running";
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function maybeEnqueuePostTaskDriftMaintenance(gate, planDirName, planDir) {
  if (gate !== "validate-to-close") return null;
  const { source, touched } = selectDriftMaintenanceFiles(planDir);
  if (touched.length === 0) return null;
  if (hasPendingDriftMaintenanceJob(planDir)) {
    return { enqueued: false, reason: "pending_job_exists", touched, source };
  }
  const scriptPath = join(skillPath, "scripts", "llm_drift_maintenance.mjs");
  const result = spawnSync(process.execPath, [
    scriptPath,
    "enqueue",
    "--plan", planDirName,
    "--reason", "post_task",
    "--json",
  ], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    env: {
      ...process.env,
      PLANNER_SKIP_SELF_HEAL: "1",
    },
  });
  if (result.status !== 0) {
    return { enqueued: false, reason: "enqueue_failed", touched, source, detail: (result.stderr || result.stdout || "").slice(0, 300) };
  }
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return { enqueued: true, touched, source, job_path: parsed.job_path || null };
  } catch {
    return { enqueued: true, touched, source, job_path: null };
  }
}

// ---------------------------------------------------------------------------
// Gate transitions
// ---------------------------------------------------------------------------

async function runTransition(gate, opts = {}) {
  // RT3-M4-FIX: Signal write mode to fact_loader.mjs so it can persist registry hash.
  // CLI-only commands (rule_engine.mjs verify-stories) should not modify state.json.
  process.env._PLANNER_GATE_TRANSITION = "1";
  const { planDirName, planDir } = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: opts.plan });
  const gateDef = GATE_REGISTRY[gate];
  const isAuditOnlyGate = gateDef?.audit_only === true;

  if (!planDirName || !planDir) {
    console.error("ERROR: No active plan. Create one with bootstrap.mjs first.");
    process.exit(1);
  }
  process.env._PLANNER_PLAN_TARGET = planDirName;

  const pointerPlanDirName = readPointer(plansDir);
  if (pointerPlanDirName) {
    syncActivePlanAlias(plansDir, {
      planDirName: pointerPlanDirName,
      planDir: join(plansDir, pointerPlanDirName),
      stateJson: readStateJson(join(plansDir, pointerPlanDirName)),
    });
  }

  // POST-CLOSE GUARD: Prevent state-mutating gates on an already-closed plan.
  // Audit-only gates (for example notify-user) are allowed because they do not
  // append transition history or change canonical planner state.
  const stateJsonForCloseCheck = readStateJson(planDir);
  if (stateJsonForCloseCheck?.state === "CLOSE" && !isAuditOnlyGate) {
    console.error("  ❌ Plan is already CLOSED — no further transitions allowed (POST-CLOSE-BLOCKED).");
    console.error("     Create a new plan with: node bootstrap.mjs new \"<goal>\"");
    process.exit(2);
  }
  syncStateMarkdown(planDir, stateJsonForCloseCheck);

  // AV-19 + RT-AUDIT-H2: Per-gate retry cooldown — prevent brute-force content changes.
  // Checks the last attempt for THIS SPECIFIC gate, not just the global last transition.
  // The old check only looked at the last transition globally — an LLM could bypass the
  // cooldown by running a different gate (e.g. notify-user) in between retries.
  const GATE_COOLDOWN_MS = 10_000; // 10 seconds between retries of the same gate
  const GATE_THRASH_GUARD_THRESHOLD = 3;
  const stateJsonForCooldown = readStateJson(planDir);
  let historyPoisonDiagnostic = null;
  if (stateJsonForCooldown?.transitions?.length > 0) {
    const transitions = stateJsonForCooldown.transitions;
    const thrashTail = summarizeGateFailureTail(transitions, GATE_REGISTRY, gate, {
      threshold: GATE_THRASH_GUARD_THRESHOLD,
    });
    if (thrashTail.blocked) {
      const verifyScript = join(skillPath, "scripts", "verify_gate.mjs");
      const targeted = spawnSync(process.execPath, [verifyScript, gate, "--plan", planDirName, "--json"], {
        cwd,
        encoding: "utf-8",
        timeout: 20000,
      });
      const targetedPasses = targeted.status === 0;
      if (!targetedPasses) {
        const commandPrefix = "node .agent/skills/iterative-planner/scripts";
        console.error(`  ❌ GATE-RETRY-001: You have failed ${gate} ${thrashTail.consecutiveFails} times.`);
        console.error("     Do not edit artifacts blindly. Run this diagnosis packet:");
        console.error(`     ${commandPrefix}/verify_gate.mjs ${gate} --plan ${planDirName} --json`);
        console.error(`     ${commandPrefix}/planner_findings.mjs --dir . --plan plans/${planDirName} --gate ${gate} --json`);
        if (thrashTail.consecutiveFails >= GATE_HISTORY_POISON_THRESHOLD) {
          console.error(`     After 5 failures, use ${commandPrefix}/planner.mjs fix-stuck --json or ${commandPrefix}/planner.mjs recover-poison before another transition attempt.`);
        }
        process.exit(2);
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
      console.error(`  ❌ CIRCUIT_BREAKER_OPEN: Gate '${gate}' has failed ${persistedFails} times total (threshold: ${CIRCUIT_BREAKER_THRESHOLD}).`);
      console.error(`     Fix the underlying issue then reset with: node bootstrap.mjs reset-circuit-breaker ${gate}`);
      process.exit(2);
    }

    // Time-based cooldown (original logic)
    const gateDefForCooldown = GATE_REGISTRY[gate];
    const gateFromStates = gateDefForCooldown
      ? (Array.isArray(gateDefForCooldown.from) ? gateDefForCooldown.from : [gateDefForCooldown.from]).map(s => s?.toUpperCase())
      : [];
    const gateToState = gateDefForCooldown?.to?.toUpperCase() || null;
    for (let i = transitions.length - 1; i >= 0; i--) {
      const t = transitions[i];
      const matchesGate = gateFromStates.includes(t.from) &&
        (t.gate_result === "FAIL" ? gateFromStates.includes(t.to) : t.to === (gateToState || t.to));
      if (!matchesGate) continue;
      if (t.gate_result === "FAIL") {
        const lastTs = new Date(t.timestamp).getTime();
        const elapsed = Date.now() - lastTs;
        if (elapsed < GATE_COOLDOWN_MS && !isNaN(lastTs)) {
          const waitSec = Math.ceil((GATE_COOLDOWN_MS - elapsed) / 1000);
          console.error(`  ⏳ Gate retry cooldown: ${waitSec}s remaining (AV-19). Last ${gate} attempt failed at ${t.timestamp}.`);
          process.exit(1);
        }
      }
      break;
    }
  }

  printHeader(`TRANSITION: ${gate}`, `Plan: ${planDirName}`);

  const allResults = [];
  let sharedPlanRefresh = null;
  let llmDriftGateAuditResult = null;
  let llmDriftGateAuditPath = null;

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

  // Step 0a: RT-001 + RT2-007 — Transition nonce verification.
  // Verify the previous transition was run via transition.mjs (not manual state.md edit).
  // The first transition in a plan (explore-to-plan) is exempt since there's no prior nonce.
  const stateJsonForNonce = readStateJson(planDir);
  const isFirstTransition = gate === "explore-to-plan";
  if (stateJsonForNonce && !isFirstTransition) {
    // RT10-C2: Accept both old 16-char and new 32-char transition nonces
    const nLen = stateJsonForNonce.transition_nonce?.length;
    const hasNonce = nLen === 16 || nLen === 32;
    const nonceValid = hasNonce && /^[0-9a-f]+$/.test(stateJsonForNonce.transition_nonce);
    if (!nonceValid) {
      printSection("Transition Integrity Check");
      const r = check(
        "Prior transition ran via transition.mjs",
        FAIL,
        "state.json transition_nonce is missing or invalid — state may have been modified directly. Run the prior transition command first."
      );
      printResults([r]);
      allResults.push(r);
      console.log();
    }
  }

  // Step 0b: AV-13 + RT-AUDIT-006 — Config integrity check.
  // Detects modification of ALL security-relevant config files since last verified write.
  {
    const configCheck = checkConfigIntegrity();
    if (!configCheck.intact) {
      printSection("Config Integrity Check (AV-13)");
      const r = check(
        "Config file integrity",
        FAIL,
        configCheck.reason
      );
      printResults([r]);
      allResults.push(r);
      // RT5-H2: Config integrity failure must block early — running subsequent
      // gate steps with tampered config pollutes audit trail and executes
      // logic that may itself be compromised.
      console.error("  ❌ Config integrity failure — gate transition aborted.");
      // F-001 FIX: Removed releaseLock() call — lock is not yet acquired at this
      // point (declared later at line ~583). Referencing a const before declaration
      // throws ReferenceError due to Temporal Dead Zone.
      process.exit(1);
    }
  }

  // Step 0c: RT6-C1 — State.json integrity hash validation.
  // Detects direct edits to state.json (LLM faking transitions, nonces, etc).
  {
    const stateForIntegrity = readStateJson(planDir);
    if (stateForIntegrity) {
      const stateIntegrity = validateStateIntegrity(stateForIntegrity);
      if (!stateIntegrity.intact) {
        printSection("State Integrity Check (RT6-C1)");
        const r = check(
          "state.json integrity hash",
          FAIL,
          stateIntegrity.reason
        );
        printResults([r]);
        allResults.push(r);
        console.error("  ❌ state.json was modified outside transition.mjs — gate transition aborted.");
        process.exit(1);
      }
    }
  }

  // Step 0d: RT-REDTEAM-M1 — Decision log hash chain validation.
  // Detects tampering with historical decision log entries.
  {
    const chainCheck = validateDecisionLogChain(planDir);
    if (!chainCheck.valid && chainCheck.reason !== "no decision log" && chainCheck.reason !== "empty log") {
      printSection("Decision Log Chain Integrity");
      const r = check(
        "Decision log hash chain",
        FAIL,
        chainCheck.reason
      );
      printResults([r]);
      allResults.push(r);
      console.log();
    }
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
    const stateCheckResult = check(
      `Current state matches gate source`,
      stateMatch ? PASS : FAIL,
      stateMatch
        ? `State is ${currentStateName} ✓`
        : `Expected [${expectedSources.join("|")}], found: ${currentStateName || "unknown"} — transition blocked (wrong phase)`
    );
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
    const report = await runHealthScan(planDir, "quick");
    if (report) {
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
      healthResults.push(check("Report saved", PASS, `health_report.md (${(report.duration_ms / 1000).toFixed(1)}s)`));
      const counts = printResults(healthResults);
      allResults.push(...healthResults);
    } else {
      // RP-002: Health scan returned null — scanner itself may have crashed.
      // This is distinct from "scan ran but found zero issues".
      // A scanner crash should block the transition (FAIL), not proceed with a warning.
      const r = check("Health scan", FAIL, "Health scan failed to produce a report — fix scanner before proceeding");
      printResults([r]);
      allResults.push(r);
    }
    console.log();
  }

  if (gateDef?.health_scan === "full") {
    printSection("Health Delta Check");
    const report = await runHealthScan(planDir, "json");
    if (!report) {
      const r = check("Health scan", FAIL, "Health scan failed to produce a report — fix scanner before closing");
      printResults([r]);
      allResults.push(r);
    } else {
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
            const r = check("No new health failures", FAIL, `${newFails} NEW failure(s) introduced`);
            printResults([r]);
            allResults.push(r);
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
        const r = check("Health baseline", FAIL, "No health_baseline.json — run bootstrap to capture baseline before closing");
        printResults([r]);
        allResults.push(r);
      }
    }
    console.log();
  }

  // Step 1.5: Compulsory persona audit (for applicable gates)
  if (PERSONA_AUDIT_GATES.has(gate)) {
    printSection("Persona Audit (compulsory)");
    const personaResults = await runPersonaAuditGate(cwd, skillPath, planDir, gate);
    const personaCounts = printResults(personaResults);
    allResults.push(...personaResults);
    console.log();
  }

  if (planDir && LLM_DRIFT_AUDIT_GATES.has(gate)) {
    try {
      llmDriftGateAuditResult = runLlmDriftGateAudit(gate, planDirName);
      llmDriftGateAuditPath = persistLlmDriftGateAuditResult(gate, planDir, llmDriftGateAuditResult);
    } catch (e) {
      llmDriftGateAuditResult = {
        status: "unavailable",
        summary: e.message,
        fail_open: true,
        hard_blocking: false,
        findings: [],
      };
    }
  }

  // Step 1.7: Shared plan refresh — regenerate ontology facts and structured close signals
  // before JS gate checks, checklists, and Prolog semantics run. Non-blocking: transitions
  // still continue even if the refresh cannot complete so legacy fallbacks remain available.
  if (planDir) {
    try {
      sharedPlanRefresh = refreshPlanArtifacts({ cwd, skillPath, planDirName });
      if (process.env.DEBUG && sharedPlanRefresh?.ontology?.error) {
        console.error(`  [plan_refresh] ontology error: ${sharedPlanRefresh.ontology.error}`);
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`  [plan_refresh] refresh error: ${e.message}`);
    }
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
      const scopeContract = writeScopeContract({ cwd, planDir, planContent });
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

  // Step 2: Gate checks (delegated to verify_gate.mjs — single authoritative implementation)
  printSection("Gate Checks");
  const modules = await loadGateFunctions();
  const { GATES, evaluateGateResults } = modules.verifyGate;
  const gateFn = GATES[gate];
  const gateEvaluation = gateFn
    ? evaluateGateResults(planDir, gate)
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

  if (LLM_DRIFT_AUDIT_GATES.has(gate)) {
    printSection("LLM Drift Audit (advisory)");
    try {
      const result = llmDriftGateAuditResult || runLlmDriftGateAudit(gate, planDirName);
      printLlmDriftGateAudit(result);
      if (llmDriftGateAuditPath) {
        console.log(`  Review intake source: ${llmDriftGateAuditPath}`);
      }
    } catch (e) {
      console.log(`  ⚠ unavailable: ${e.message}. Deterministic checks remain authoritative; this section cannot fail the gate by itself.`);
    }
    console.log();
  }

  // Step 3: Checklist
  printSection("Checklist");
  const checklistResults = runChecklist(gate, planDirName, { skillPath, plansDir, knowledgeDir, cwd });
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

      // Warn (or fail) if IDE doesn't support trace capture
      // RT-HARDENING-005: When strict_trace_ide is enabled, unsupported IDE is FAIL, not WARN.
      if (traceAuditMode === "unsupported") {
        const warning = formatIDEWarning(ideInfo);
        const strictIDE = isFeatureEnabled("strict_trace_ide");
        const r = withFailureCode(
          check("IDE trace support", strictIDE ? FAIL : WARN, warning || "IDE does not support tool trace capture"),
          "GATE-TRC-009"
        );
        printResults([r]);
        allResults.push(r);
      }

      if (traceAuditMode === "not_applicable") {
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
        printResults(traceResults);
        allResults.push(...traceResults);

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
      const r = check("Reachability audit", FAIL, `Audit error: ${e.message}`);
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
      const r = check("Prolog rule engine", FAIL,
        `Required files missing: ${!existsSync(prologDirPath) ? "prolog/ directory" : "rule_engine.mjs"} — Prolog verification is mandatory`);
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
          const mapped = semanticResults.map(r => check(r.name, r.status, r.detail));
          printResults(mapped);
          allResults.push(...mapped);
          // Phase B: render Suggested Fixes via the unit-tested helper rather
          // than inline so the rendered format is locked by test_supervisor_runner.mjs.
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
        writeProofTrace(planDir, gate, {
          gate,
          facts_source: "state.json + story_registry.json",
          goal: semanticGoal,
          result: semanticResults.some(r => r.status === "FAIL") ? "BLOCKED" : "ALLOWED",
          checks: semanticResults,
          timestamp: nowISO(),
        });

        // M4-FIX: Prolog enforce mode — if Prolog semantic checks FAIL but JS gate checks PASSED,
        // this is a divergence. When prolog_enforce_mode is enabled, block the transition.
        // Previously prolog_shadow_mode only logged warnings, letting tampered JS logic proceed.
        // T4-FIX: Enforce mode should detect divergence independently of shadow mode.
        // Previously required BOTH flags, so disabling shadow_mode silently disabled enforcement.
        const prologBlocked = semanticResults.some(r => r.status === "FAIL");
        const jsGateBlocked = gateResults.some(r => r.status === "FAIL");
        if (isFeatureEnabled("prolog_enforce_mode")) {
          if (prologBlocked && !jsGateBlocked) {
            const divergeResult = check(
              "Prolog/JS divergence (M4-FIX)",
              FAIL,
              "Prolog semantic checks FAIL but JS gate checks PASS — possible JS gate tampering. Transition blocked."
            );
            printResults([divergeResult]);
            allResults.push(divergeResult);
          }
        }
        // RT5-M1: Detect reverse divergence — Prolog PASS but JS FAIL.
        // This remains diagnostic-only because JS is already blocking the transition.
        if (!prologBlocked && jsGateBlocked) {
          const divergeResult = check(
            "Prolog/JS diagnostic (RT5-M1)",
            WARN,
            "Prolog semantic checks PASS while JS gate checks FAIL. Treating this as a normal JS gate failure unless the normalized semantic facts disagree."
          );
          printResults([divergeResult]);
          allResults.push(divergeResult);
        }

        console.log();
      } catch (e) {
        // Prolog execution errors are hard failures — not warnings
        const r = check("Semantic checks", FAIL, `Prolog verification failed: ${e.message}`);
        printResults([r]);
        allResults.push(r);
        console.log();
      }
    }
  }


  // Final summary
  const totalPass = allResults.filter(r => r.status === PASS).length;
  const totalWarn = allResults.filter(r => r.status === WARN).length;
  const totalFail = allResults.filter(r => r.status === FAIL).length;

  console.log(`  Summary: ${totalPass} PASS, ${totalWarn} WARN, ${totalFail} FAIL`);

  // --- Determinism: decision log + state.json update ---
  const scriptVersions = hashAllScripts(skillPath);
  const failureCodes = allResults.filter(r => r.status === "FAIL" && r.code).map(r => r.code);

  // Decision log
  // RT6-H1: Decision log write failure must block the transition.
  // Without this, audit trail entries are silently lost during lock contention.
  const logWritten = appendDecisionLog(planDir, buildDecisionEntry(
    gate,
    { plan: planDirName, source_state: expectedSources.join("|") },
    allResults,
    totalFail > 0 ? "BLOCKED" : "ALLOWED",
    totalFail > 0 ? null : (gateDef?.to ? gateDef.to.toUpperCase() : null)
  ));
  if (!logWritten && isFeatureEnabled("decision_logs")) {
    console.error("  ❌ Decision log write failed — audit trail incomplete. Transition blocked (RT6-H1).");
    process.exit(1);
  }

  // State.json update
  // RT-002 + RT-REDTEAM-C2: Plaintext nonces written to side-channel file,
  // not printed to stdout (LLM sees stdout and could self-approve).
  let _approvalNoncePlaintext = null;
  let _kbDigestSaltPlaintext = null;

  let releaseLock = null;
  if (!isAuditOnlyGate) {
    // RT-REDTEAM-H3: Acquire file lock to prevent TOCTOU race on state.json
    // RT3-H1-FIX: Lock failure is a hard block, not a warning.
    // Failing open defeats the purpose of the lock — concurrent transitions
    // could corrupt state.json by overwriting each other's transition records.
    releaseLock = acquireStateLock(planDir);
    if (!releaseLock) {
      console.error("  ❌ Could not acquire state.json lock — concurrent transition detected. Retry in a few seconds.");
      process.exit(1);
    }

    const stateJson = readStateJson(planDir);
    if (stateJson) {
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

      const previousState = stateJson.state; // capture BEFORE mutation
      const gateToField = gateDef?.to;
      const targetState = gateToField
        ? gateToField.toUpperCase()
        : stateJson.state;
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
      const replanCount = stateJson.transitions.filter(t => (t.to || "").toLowerCase() === "re_plan" && t.gate_result === "PASS").length;
      if (replanCount >= 3) {
        console.log(`  ⚠ WARNING: ${replanCount} re-plan cycles detected. Consider closing and starting a fresh plan, or escalating scope.`);
      }
      // Tool trace summary (if audit ran)
      if (_traceSummary) {
        stateJson.trace_summary = _traceSummary;
      }
      // RT10-H1: Record consumed approval nonce hash to prevent replay.
      // After a successful plan-to-execute transition, the approval nonce is consumed
      // and cannot be reused for any future transitions.
      if (totalFail === 0 && gate === "plan-to-execute" && stateJson.approval_nonce_hash) {
        if (!Array.isArray(stateJson.consumed_nonces)) stateJson.consumed_nonces = [];
        if (!stateJson.consumed_nonces.includes(stateJson.approval_nonce_hash)) {
          stateJson.consumed_nonces.push(stateJson.approval_nonce_hash);
          // F-011 FIX: Cap consumed_nonces to prevent unbounded growth over many re-plan cycles
          const MAX_CONSUMED_NONCES = 50;
          if (stateJson.consumed_nonces.length > MAX_CONSUMED_NONCES) {
            stateJson.consumed_nonces = stateJson.consumed_nonces.slice(-MAX_CONSUMED_NONCES);
          }
        }
      }
      // RT-001: Write transition nonce — proves this state change came from transition.mjs
      if (totalFail === 0) {
        // RT10-C2: 16 bytes → 32 hex chars (128-bit) for transition nonce
        stateJson.transition_nonce = randomBytes(16).toString("hex");
      }
      // RT-002 + RT2-001: Generate approval nonce on explore-to-plan success.
      // SECURITY: Plaintext nonces are NEVER written to state.json — only hashes.
      // Nonces are held in local variables and printed to console after the write.
      if (totalFail === 0 && gate === "explore-to-plan") {
        // RT2-001: Approval nonce — store hash only
        // RT7-M1 + RT9-M2: Use centralized constant from nonce.mjs
        const approvalNonce = randomBytes(NONCE_BYTES).toString("hex");
        _approvalNoncePlaintext = approvalNonce; // local var only — never on disk
        // C1-FIX: 128-bit hash (was 64-bit) — prevents LLM brute-force collision
        stateJson.approval_nonce_hash = createHash("sha256").update(approvalNonce).digest("hex").slice(0, 32);
        // RT-HARDENING-003: Nonce expiration — store generation timestamp so gates
        // can reject stale nonces (>24h). Prevents replay with old state.json files.
        stateJson.nonce_generated_at = nowISO();
        delete stateJson.approval_nonce; // remove old plaintext field if present

        // RT2-003: KB digest salt — LLM must write [KB_DIGEST:<salt>] in findings.md.
        // Gate recomputes hash(salt + KB_content) and verifies against stored hash.
        // AV-2 + RT9-M2: Use centralized constant from nonce.mjs
        const kbSalt = randomBytes(KB_SALT_BYTES).toString("hex");
        const knowledgeDirPath = join(plansDir, "knowledge");
        let kbContent = "";
        for (const f of ["index.md", "mistakes.md", "patterns.md", "gotchas.md"]) {
          const p = join(knowledgeDirPath, f);
          if (existsSync(p)) kbContent += readFileSync(p, "utf-8");
        }
        if (kbContent) {
          _kbDigestSaltPlaintext = kbSalt; // local var only — never on disk
          stateJson.kb_digest_hash = createHash("sha256").update(kbSalt + kbContent).digest("hex").slice(0, 32);
        }
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

      if (totalFail === 0) {
        const fingerprint = computePlanTamperFingerprint(planDir, {
          stateJson,
          gate,
          generatedAt: nowISO(),
        });
        if (fingerprint?.hash) {
          stateJson.tamper_fingerprint = fingerprint;
        }
      }

      const stateWritten = writeStateJson(planDir, stateJson);
      if (stateWritten) {
        syncStateMarkdown(planDir, stateJson);
        syncActivePlanAlias(plansDir, { planDirName, planDir, stateJson });
      }
      // RT3-M3-FIX: If state.json write failed and we're about to deliver a nonce,
      // the nonce hash won't be persisted — making the nonce unverifiable.
      // Block nonce delivery in this case to avoid confusing the user.
      if (!stateWritten && gate === "explore-to-plan" && _approvalNoncePlaintext) {
        console.error("  ❌ state.json write failed — nonce not delivered (would be unverifiable). Fix state_json feature flag or file permissions.");
        if (releaseLock) releaseLock();
        process.exit(1);
      }
    }

    // RT-REDTEAM-H3: Release file lock
    if (releaseLock) releaseLock();
  } else {
    console.log("  Audit-only gate: canonical planner state/history left unchanged.");
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
      console.log();
      console.log("  -- Deterministic Repair Packet --");
      for (const line of repairPacket) {
        console.log(`  ${line}`);
      }
    }
  }

  console.log();
  if (totalFail > 0) {
    console.log(`  ══ RESULT: ❌ TRANSITION BLOCKED — fix ${totalFail} FAIL item(s) ══`);
    process.exit(1);
  } else {
    console.log(`  ══ RESULT: ✅ TRANSITION ALLOWED ══`);
    const driftMaintenance = maybeEnqueuePostTaskDriftMaintenance(gate, planDirName, planDir);
    if (driftMaintenance) {
      if (driftMaintenance.enqueued) {
        console.log(`  Async drift maintenance enqueued${driftMaintenance.job_path ? `: ${driftMaintenance.job_path}` : ""} (scope=${driftMaintenance.source || "unknown"})`);
      } else {
        console.log(`  Async drift maintenance not enqueued (${driftMaintenance.reason}, scope=${driftMaintenance.source || "unknown"}).`);
      }
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
    // H1-H3 FIX + RT-002 + RT2-001 + RT-REDTEAM-C2: One-time-read nonce delivery.
    // Nonces are written to a randomized filename in ~/.config/iterative-planner/
    // (NOT a predictable path). The file is auto-deleted after first read.
    // This prevents LLM agents from reading the nonce via a predictable file path.
    if (gate === "explore-to-plan" && _approvalNoncePlaintext) {
      // Clean up any stale nonce files from prior runs
      cleanupStaleNonces();
      try {
        const approvalMode = getApprovalMode();

        if (approvalMode === "auto") {
          // AUTO MODE (default): write [APPROVED:<nonce>] directly to decisions.md.
          // No daemon or user action needed. The nonce chain is intact — verify_gate.mjs
          // still checks the hash; the only difference is the writer (transition vs daemon).
          const decisionsPath = join(planDir, "decisions.md");
          const existing = existsSync(decisionsPath) ? readFileSync(decisionsPath, "utf-8") : "";
          writeFileSync(decisionsPath, existing.trimEnd() + `\n\n[APPROVED:${_approvalNoncePlaintext}]\n`);
          const kbDigestWrite = _kbDigestSaltPlaintext
            ? persistAutoModeKbDigestProof(planDir, _kbDigestSaltPlaintext)
            : null;
          console.log();
          console.log(`  ✓ Auto-approval mode — [APPROVED] written to decisions.md (no daemon needed).`);
          if (kbDigestWrite?.persisted) {
            console.log(`  ✓ KB digest proof persisted via ${kbDigestWrite.mode}.`);
          } else if (kbDigestWrite && kbDigestWrite.mode !== "none") {
            console.log(`  ⚠ KB digest proof was not persisted in auto mode: ${kbDigestWrite.detail}`);
          }
          const tamperRefresh = refreshTamperFingerprintSnapshot(planDir, planDirName, gate, "auto approval artifacts persisted");
          if (tamperRefresh.refreshed) {
            console.log(`  ✓ Tamper fingerprint refreshed (${tamperRefresh.hash}).`);
          } else {
            console.log(`  ⚠ Tamper fingerprint refresh skipped after auto approval: ${tamperRefresh.reason}`);
          }
          console.log(`    To require interactive approval: set approval.mode = "interactive" in determinism.json`);
        } else {
          // INTERACTIVE / MULTI-AGENT: write nonce file first (common to both modes).
          // T3-FIX: Whitelist workflow type — LLM could set env var to inject arbitrary values
          const rawWorkflowType = process.env._PLANNER_WORKFLOW_TYPE || "full";
          const workflowType = ["full", "safe-change"].includes(rawWorkflowType) ? rawWorkflowType : "full";
          const noncePayload = {
            plan: planDirName,
            plan_dir: planDir || null,
            workflow_type: workflowType,
            approval_nonce: _approvalNoncePlaintext,
            kb_digest_salt: _kbDigestSaltPlaintext || null,
            created_at: nowISO(),
          };

          if (approvalMode === "multi-agent") {
            // MULTI-AGENT: write nonce file, then print story-review prompt.
            // The story-review command will consumeOneTimeNonce() to retrieve and delete it.
            writeOneTimeNonce(planDirName, _approvalNoncePlaintext, _kbDigestSaltPlaintext, { planDir, workflowType });
            console.log();
            console.log(`  ┌──────────────────────────────────────────────────────────────────────┐`);
            console.log(`  │ STORY REVIEW REQUIRED (multi-agent mode)                              │`);
            console.log(`  │                                                                       │`);
            console.log(`  │ Run in a separate Claude Code session:                                │`);
            console.log(`  │   node bootstrap.mjs story-review plans/${planDirName}/`);
            console.log(`  │                                                                       │`);
            console.log(`  │ The reviewer reads findings, checks story coverage, and writes        │`);
            console.log(`  │ [APPROVED:<nonce>] or [REJECTED:<nonce>] to decisions.md.             │`);
            console.log(`  │ See: .agent/workflows/story-review-agent.md                           │`);
            console.log(`  └──────────────────────────────────────────────────────────────────────┘`);
          } else {
            // INTERACTIVE: try Unix domain socket first — nonce stays in memory, never on disk.
            // RT-DAEMON-V4-012: socket delivery keeps plaintext out of filesystem.
            const socketDelivered = await sendNonceViaSocket(noncePayload);

            if (socketDelivered) {
              console.log();
              console.log(`  ✓ Approval nonce delivered to daemon via socket (never written to disk).`);
            } else {
              // Fallback: write nonce file for daemon polling or manual nonce_reveal.
              writeOneTimeNonce(planDirName, _approvalNoncePlaintext, _kbDigestSaltPlaintext, { planDir, workflowType });
              // RT-DAEMON-V2-010: Do NOT print nonce path to stdout or stderr.
              console.log();
              console.log(`  ┌──────────────────────────────────────────────────────────────────────┐`);
              console.log(`  │ Approval nonce written to a ONE-TIME-READ file.                       │`);
              console.log(`  │                                                                       │`);
              console.log(`  │ Option A: Run the approval daemon in a separate terminal:             │`);
              console.log(`  │   node .agent/skills/iterative-planner/scripts/approval_daemon.mjs    │`);
              console.log(`  │                                                                       │`);
              console.log(`  │ Option B: Reveal the nonce manually:                                  │`);
              console.log(`  │   node .agent/skills/iterative-planner/scripts/nonce_reveal.mjs       │`);
              console.log(`  │   Then add [APPROVED:<nonce>] to decisions.md.                        │`);
              console.log(`  └──────────────────────────────────────────────────────────────────────┘`);
            }
          }
        }
      } catch (e) {
        // C3-FIX: If side-channel write fails, BLOCK the transition instead of printing secrets.
        console.error(`  ❌ Nonce delivery failed: ${e.message}. Transition blocked — fix filesystem permissions and retry.`);
        process.exit(1);
      }
    }
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const cliArgs = process.argv.slice(2);
const gate = cliArgs[0];
let planOverride = null;
for (let i = 1; i < cliArgs.length; i++) {
  if (cliArgs[i] === "--plan" && cliArgs[i + 1]) {
    planOverride = cliArgs[i + 1];
    i++;
  }
}

if (!gate || gate === "--help" || gate === "help") {
  console.log(`transition.mjs — Unified gate wrapper for iterative planner state transitions

Usage:
  node transition.mjs explore-to-plan [--plan <plan-dir>]      EXPLORE → PLAN gate
  node transition.mjs plan-to-execute [--plan <plan-dir>]      PLAN → EXECUTE gate
  node transition.mjs execute-to-reflect [--plan <plan-dir>]   EXECUTE → REFLECT gate (red-team)
  node transition.mjs reflect-to-validate [--plan <plan-dir>]  REFLECT → VALIDATE gate
  node transition.mjs validate-to-close [--plan <plan-dir>]    VALIDATE → CLOSE gate
  node transition.mjs notify-user [--plan <plan-dir>]          KB Notification Gate

This single command runs health checks, gate verification, and checklists.
If it outputs FAIL, you may NOT proceed.`);
  process.exit(0);
}

const validGates = Object.keys(GATE_REGISTRY);
if (!validGates.includes(gate)) {
  console.error(`ERROR: Unknown gate '${gate}'. Valid gates: ${validGates.join(", ")}`);
  process.exit(1);
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

runTransition(gate, { plan: planOverride }).catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exit(2);
});
