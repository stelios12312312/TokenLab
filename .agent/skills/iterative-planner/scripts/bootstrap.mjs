#!/usr/bin/env node
// Bootstrap and manage plan directories under plans/ in the current working directory (project root).
//
// Usage:
//   node bootstrap.mjs "goal"                  Create a new plan (backward-compatible)
//   node bootstrap.mjs new "goal"              Create a new plan
//   node bootstrap.mjs new --force "goal"      Close active plan and create a new one
//   node bootstrap.mjs resume                  Output current plan state for re-entry
//   node bootstrap.mjs status                  One-line state summary
//   node bootstrap.mjs close                   Close active plan (preserves directory)
//   node bootstrap.mjs list                    Show all plan directories (active and closed)
//
// Creates plans/plan_YYYY-MM-DD_XXXXXXXX/ (date + 8-char hex seed) in cwd.
// Writes plans/.current_plan with the directory name for discovery.
// Requires Node.js 18+ (guaranteed by Claude Code).

import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync, rmSync, openSync, closeSync, constants, statSync, cpSync } from "fs";
import { join, dirname, resolve } from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { loadAsyncDriftSummary, loadDriftLlmConfig, publicDriftConfig } from "./lib/llm_drift_client.mjs";

const SELF_HEAL_ENV = "_PLANNER_SELF_HEAL_RUNNING";
const SELF_HEAL_SKIP_ENV = "PLANNER_SKIP_SELF_HEAL";
const SELF_HEAL_SOURCE_ENV = "PLANNER_SOURCE_REPO";
const KB_INDEX_TEMPLATE = `# Knowledge Base Index

| File | Topics |
|------|--------|
| [mistakes.md](mistakes.md) | Recurring mistakes and antipatterns |
| [patterns.md](patterns.md) | Proven implementation patterns |
| [gotchas.md](gotchas.md) | Non-obvious traps and constraints |
| [retros/retro_ledger.json](retros/retro_ledger.json) | Structured retro archive with promotion decisions and case-file pointers |
`;
const RETRO_LEDGER_TEMPLATE = JSON.stringify({ version: 1, retros: [] }, null, 2) + "\n";

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
    // Best-effort lookup only — fall through to no-op if the registry is absent or stale.
  }

  return null;
}

function inspectInstallHealth(projectRoot) {
  const sourceRepo = resolveSelfHealSource(projectRoot) || projectRoot;
  const migrateScript = join(sourceRepo, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");

  if (!existsSync(migrateScript)) {
    return {
      ok: false,
      source_repo: sourceRepo,
      self_heal_available: false,
      needs_repair: false,
      summary: { description: `Canonical migrate.mjs not found at ${migrateScript}` },
    };
  }

  const doctor = spawnSync(process.execPath, [migrateScript, "doctor", projectRoot, "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (doctor.status !== 0) {
    return {
      ok: false,
      source_repo: sourceRepo,
      self_heal_available: resolve(sourceRepo) !== resolve(projectRoot),
      needs_repair: false,
      summary: { description: `doctor check failed (${doctor.status ?? "unknown"})` },
      stderr: doctor.stderr || "",
    };
  }

  try {
    const report = JSON.parse(doctor.stdout || "{}");
    return {
      ok: true,
      source_repo: sourceRepo,
      self_heal_available: resolve(sourceRepo) !== resolve(projectRoot),
      ...report,
    };
  } catch {
    return {
      ok: false,
      source_repo: sourceRepo,
      self_heal_available: resolve(sourceRepo) !== resolve(projectRoot),
      needs_repair: false,
      summary: { description: "doctor output was not valid JSON" },
    };
  }
}

function maybeRunSelfHeal(projectRoot, entryArgs) {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") return;
  if (command === "install-health") return;
  // v7.4.4: triage subcommand is read-only and emits JSON; self-heal noise
  // would corrupt the output. Skip it for triage.
  if (command === "triage") return;
  if (process.env[SELF_HEAL_ENV] === "1") return;
  if (process.env[SELF_HEAL_SKIP_ENV]) return;

  const health = inspectInstallHealth(projectRoot);
  if (!health?.ok || !health.source_repo || resolve(health.source_repo) === resolve(projectRoot)) return;
  if (!health.needs_repair) return;

  const migrateScript = join(health.source_repo, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");
  if (!existsSync(migrateScript)) {
    console.warn(`⚠️  Planner self-heal skipped — canonical migrate.mjs not found at ${migrateScript}`);
    return;
  }

  console.log("\n── Planner Self-Heal ──");
  console.log(`  Source repo: ${health.source_repo}`);
  console.log(`  Target repo: ${projectRoot}`);
  console.log(`  Detected drift: ${health.summary?.description || "planner repair required"}`);

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

function maybeHandleInstallHealth(projectRoot) {
  if (process.argv[2] !== "install-health") return;

  const jsonMode = process.argv.includes("--json");
  const health = inspectInstallHealth(projectRoot);

  if (jsonMode) {
    console.log(JSON.stringify(health, null, 2));
    process.exit(health.ok ? 0 : 1);
  }

  console.log("Planner Install Health");
  console.log();
  console.log(`  Project root: ${projectRoot}`);
  console.log(`  Canonical source: ${health.source_repo || "unknown"}`);
  console.log(`  Self-heal available: ${health.self_heal_available ? "YES" : "NO"}`);
  console.log(`  Needs repair: ${health.needs_repair ? "YES" : "NO"}`);
  console.log(`  Advisories: ${(health.advisory_issues || []).length}`);
  console.log(`  Summary: ${health.summary?.description || "No summary available"}`);

  if (!health.ok) {
    console.log("  Diagnosis: planner install health could not be verified cleanly.");
    process.exit(1);
  }

  if (health.needs_repair) {
    console.log("  Next step: normal planner entrypoints will attempt self-heal automatically before they run.");
    console.log("  Manual fallback: node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .");
  } else if ((health.advisory_issues || []).length > 0) {
    console.log("  Advisory drift: no self-heal will run. Sync root instruction mirrors manually if you want them aligned.");
  } else {
    console.log("  Next step: planner-managed files and setup look aligned.");
  }
  process.exit(0);
}

maybeRunSelfHeal(process.cwd(), process.argv.slice(1));
maybeHandleInstallHealth(process.cwd());

const {
  createInitialStateJson, writeStateJson, readStateJson, nowISO, validateStateIntegrity, isFeatureEnabled,
} = await import("./lib/determinism.mjs");
const {
  debugLog, getActivePlan, GATE_HISTORY_POISON_THRESHOLD,
  findPoisonedGateHistories,
  syncActivePlanAlias,
  detectRecentNonActivePlanContext, formatNonActivePlanContextDetail,
  readFindingsMarkdown, loadFindingsLedger, syncFindingsMarkdownFromLedger, findingsLedgerHasRenderableContent,
  resolvePlanTarget, writeThreadPlanTarget, clearThreadPlanTarget,
} = await import("./lib/plan_utils.mjs");
const { writeScopeContract } = await import("./lib/scope_contract.mjs");
const { consumeOneTimeNonce } = await import("./lib/nonce.mjs");
const { detectPlanShape, shapeMinFindings, shapeRequiresField } = await import("./lib/plan_shape.mjs");
const { computeTriage, renderTriage } = await import("./lib/triage.mjs");
const { inferPersonaAdaptation, isProblematicPersonaStatus } = await import("./lib/persona_adaptation.mjs");
const { computeVerificationObligationSynthesis } = await import("./lib/verification_obligations.mjs");
const {
  analyzeVerificationMatrix,
  buildVerificationEvidenceGuidance,
  extractSuccessCriteria,
  renderVerificationEvidenceGuidance,
} = await import("./lib/verification_matrix.mjs");
const {
  collectProvisionalPersonaTriggeredRecommendations,
  renderPersonaTriggeredRecommendations,
} = await import("./lib/persona_activation_authority.mjs");
const { formatPersonaArtifactIssue } = await import("./lib/persona_artifacts.mjs");

const cwd = process.cwd();
const plansDir = join(cwd, "plans");
const pointerFile = join(plansDir, ".current_plan");
const skillPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatesJsonPath = join(skillPath, "config", "gates.json");
const GATE_REGISTRY = existsSync(gatesJsonPath)
  ? (JSON.parse(readFileSync(gatesJsonPath, "utf-8")).gates || {})
  : {};

function shouldWarnPersonaAdaptation(report, opts = {}) {
  if (!report || !isProblematicPersonaStatus(report.status)) return false;
  if (opts.seriousOnly && !opts.serious && report.status !== "blocked_invalid_config") return false;
  return true;
}

function renderPersonaAdaptationWarning(report) {
  const lines = [
    `Persona adaptation: ${report.status} (confidence ${report.confidence})`,
  ];
  if ((report.domain_profiles || []).length > 0) {
    lines.push(`   domain profiles: ${report.domain_profiles.join(", ")}`);
  }
  if ((report.recommended_seed_roles || []).length > 0) {
    lines.push(`   recommended seeds: ${report.recommended_seed_roles.join(", ")}`);
  }
  if ((report.expected_companions || []).length > 0) {
    lines.push(`   expected companions: ${report.expected_companions.join(", ")}`);
  }
  if (report.status === "blocked_invalid_config" && report.audit_config_error) {
    lines.push(`   audit config: ${report.audit_config_error}`);
  }
  lines.push(`   Repair: ${report.recommended_command}`);
  return lines.join("\n");
}

function warnPersonaAdaptation(projectRoot = cwd, opts = {}) {
  try {
    const report = inferPersonaAdaptation(projectRoot);
    if (!shouldWarnPersonaAdaptation(report, opts)) return null;
    console.log();
    console.log(renderPersonaAdaptationWarning(report));
    return report;
  } catch (error) {
    debugLog("bootstrap", `persona adaptation scan failed: ${error.message}`);
    return null;
  }
}

function renderActivePersonaRecommendationSummary(planDirName) {
  if (!planDirName) return "";
  try {
    const planDir = join(plansDir, planDirName);
    const planPath = join(planDir, "plan.md");
    if (!existsSync(planPath)) return "";
    const synthesis = computeVerificationObligationSynthesis({
      cwd,
      planDir,
      stateJson: readStateJson(planDir),
      planContent: readFileSync(planPath, "utf-8"),
    });
    const lines = [];
    const artifactWarnings = (synthesis.persona_artifact_issues || synthesis.persona_summary?.issues || [])
      .map((issue) => formatPersonaArtifactIssue(issue))
      .filter(Boolean);
    if (artifactWarnings.length > 0) {
      lines.push("  Persona artifact diagnostics:");
      for (const warning of artifactWarnings) lines.push(`  - ${warning}`);
    }

    const artifactBackedSummary = renderPersonaTriggeredRecommendations(synthesis.obligations || [], { indent: "  " });
    if (artifactBackedSummary) {
      lines.push(artifactBackedSummary);
      return lines.join("\n");
    }

    const adaptation = inferPersonaAdaptation(cwd);
    const candidatePackIds = [
      ...(adaptation?.recommended_seed_roles || []),
      ...(adaptation?.expected_companions || []),
    ];
    const provisional = collectProvisionalPersonaTriggeredRecommendations(synthesis.obligations || [], {
      candidatePackIds,
      includeDefaultMappings: true,
    });
    const provisionalSummary = renderPersonaTriggeredRecommendations(provisional, {
      indent: "  ",
      precomputed: true,
    });
    if (provisionalSummary) lines.push(provisionalSummary);
    return lines.join("\n");
  } catch {
    return "";
  }
}

function renderActiveEvidenceGuidanceSummary(planDirName) {
  if (!planDirName) return "";
  try {
    const planDir = join(plansDir, planDirName);
    const planPath = join(planDir, "plan.md");
    if (!existsSync(planPath)) return "";
    const planContent = readFileSync(planPath, "utf-8");
    const synthesis = computeVerificationObligationSynthesis({
      cwd,
      planDir,
      stateJson: readStateJson(planDir),
      planContent,
    });
    const criteria = extractSuccessCriteria(planContent);
    const analysis = analyzeVerificationMatrix({ planContent, criteria, synthesis });
    const guidance = buildVerificationEvidenceGuidance({
      analysis,
      synthesis,
      criteria,
      planArg: planDirName,
    });
    return renderVerificationEvidenceGuidance(guidance, { indent: "  ", compact: true });
  } catch {
    return "";
  }
}

// D-018: Advisory lock to prevent concurrent bootstrap races on .current_plan.
// Uses O_EXCL atomic file creation — if two processes race, exactly one wins.
const lockFile = join(plansDir, ".lock");

// AV-11: Max lock age in milliseconds — prevents permanent lockout from PID recycling.
// If a lock is older than this, it is considered stale regardless of PID liveness.
const LOCK_MAX_AGE_MS = 60_000; // 60 seconds
const CIRCUIT_BREAKER_THRESHOLD = 10; // total_fails per gate before circuit is tripped

function acquireLock(retries = 1) {
  mkdirSync(plansDir, { recursive: true });
  try {
    const fd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeFileSync(fd, `${process.pid}\t${Date.now()}\n`);
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") {
      // Check if lock holder is still alive AND lock is not expired
      try {
        const lockContent = readFileSync(lockFile, "utf-8").trim();
        const [pidStr, tsStr] = lockContent.split("\t");
        const pid = parseInt(pidStr);
        const lockTs = parseInt(tsStr) || 0;
        const lockAge = Date.now() - lockTs;

        // AV-11: Time-bounded stale lock detection — expire after LOCK_MAX_AGE_MS
        // even if PID is recycled and still alive.
        if (lockAge > LOCK_MAX_AGE_MS) {
          debugLog("bootstrap", `Lock expired (age ${lockAge}ms > ${LOCK_MAX_AGE_MS}ms)`);
          unlinkSync(lockFile);
          return retries > 0 ? acquireLock(retries - 1) : false; // F-027 FIX: bounded retry
        }

        if (pid && pid !== process.pid) {
          try { process.kill(pid, 0); return false; } catch { debugLog("bootstrap", `Stale lock detected (pid ${pid} dead)`); }
        }
        unlinkSync(lockFile);
        return retries > 0 ? acquireLock(retries - 1) : false; // F-027 FIX: bounded retry
      } catch (e) { debugLog("bootstrap", `Lock check failed: ${e.message}`); return false; }
    }
    debugLog("bootstrap", `Lock acquire failed: ${e.message}`);
    return false;
  }
}

function releaseLock() {
  try { unlinkSync(lockFile); } catch { /* already removed */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureGitignore() {
  const gitignorePath = join(cwd, ".gitignore");
  const patterns = ["plans/"];
  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet — will create
  }
  const missing = patterns.filter((p) => !content.split("\n").some((line) => line.trim() === p));
  if (missing.length === 0) return;
  const suffix = (content && !content.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n";
  const updated = content + suffix;
  writeFileSync(gitignorePath + ".tmp", updated);
  renameSync(gitignorePath + ".tmp", gitignorePath);
}

function telemetryHookConfigured(projectRoot) {
  const settingsCandidates = [
    join(projectRoot, ".claude", "settings.local.json"),
    join(projectRoot, ".claude", "settings.json"),
    join(projectRoot, ".cursor", "settings.json"),
  ];
  for (const settingsPath of settingsCandidates) {
    try {
      if (!existsSync(settingsPath)) continue;
      const text = readFileSync(settingsPath, "utf-8");
      if (text.includes("post_tool_use.mjs") || text.includes("PostToolUse")) return true;
    } catch {
      // Best-effort install-health hint only.
    }
  }
  return false;
}

function warnTelemetryInstallHealth(projectRoot) {
  const telemetryEnabled = isFeatureEnabled("proof_telemetry") || isFeatureEnabled("tool_trace");
  if (!telemetryEnabled || telemetryHookConfigured(projectRoot)) return;
  console.error("Telemetry capture is enabled but inactive: no supported PostToolUse hook was found.");
  console.error("Repair in supported PostToolUse environments with: sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh .agent/skills/iterative-planner/scripts/hooks/install.mjs --trace-hook");
  console.error("If this IDE cannot provide hooks, mark this plan as no-tool-telemetry in verification.md.");
}

function printAdvisoryEngineStatus(projectRoot) {
  const provider = publicDriftConfig(loadDriftLlmConfig(process.env, { cwd: projectRoot }));
  const phaseList = (provider.phases || []).join(",") || "none";
  if (provider.configured) {
    const label = provider.using_deepseek_alias || /deepseek/i.test(provider.base_url || "") ? "DeepSeek" : "OpenAI-compatible";
    console.log(`  Advisory engines: LLM drift ${label} active (${provider.model || "unknown model"} @ ${provider.base_url || "unknown base"}, phases=${phaseList}, fail-open advisory)`);
  } else {
    console.log(`  Advisory engines: LLM drift inactive (missing ${provider.missing.join(", ")}; deterministic planner checks only)`);
  }
}

function readPointer() {
  try {
    const name = readFileSync(pointerFile, "utf-8").trim();
    if (name && existsSync(join(plansDir, name))) return name;
    return null;
  } catch {
    return null;
  }
}

function readPlanFile(planDirName, filename) {
  try {
    const planDir = join(plansDir, planDirName);
    if (filename === "findings.md") {
      return readFindingsMarkdown(planDir);
    }
    return readFileSync(join(planDir, filename), "utf-8");
  } catch {
    return null;
  }
}

function extractField(content, pattern) {
  if (!content) return null;
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

function normalizeCompactText(content, maxLen = 220) {
  const normalized = String(content || "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1).trimEnd()}…` : normalized;
}

function extractGoalFromPlanContent(planContent) {
  return extractField(planContent, /^## Goal\s*\n([\s\S]*?)(?=\n## |\n$)/m);
}

function extractSummaryOutcome(summaryContent) {
  if (!summaryContent) return null;
  const outcome = extractField(summaryContent, /^## Outcome\s*\n([\s\S]*?)(?=\n## |\n$)/m);
  if (outcome) {
    const compactOutcome = normalizeCompactText(outcome);
    if (compactOutcome) return compactOutcome;
  }

  const lines = summaryContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.match(/^\[KB_[A-Z_]+\]$/));

  for (const line of lines) {
    const compactLine = normalizeCompactText(line.replace(/^-\s+/, ""));
    if (compactLine) return compactLine;
  }
  return null;
}

function listPlanDirectoriesByRecency() {
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
      .map((entry) => entry.name)
      .sort((a, b) => {
        try {
          return statSync(join(plansDir, b)).mtimeMs - statSync(join(plansDir, a)).mtimeMs;
        } catch {
          return b.localeCompare(a);
        }
      });
  } catch {
    return [];
  }
}

function getPlanLifecycleState(planDirName) {
  try {
    const stateJson = readStateJson(join(plansDir, planDirName));
    if (typeof stateJson?.state === "string" && stateJson.state.trim()) {
      return stateJson.state.trim().toUpperCase();
    }
  } catch { /* fall through to markdown */ }

  const stateMarkdown = readPlanFile(planDirName, "state.md") || "";
  const stateField = extractField(stateMarkdown, /^# Current State:\s*(.+)$/m);
  return typeof stateField === "string" && stateField.trim()
    ? stateField.trim().toUpperCase()
    : "UNKNOWN";
}

function buildPlanIndexSection(planDirName) {
  const planContent = readPlanFile(planDirName, "plan.md") || "";
  const summaryContent = readPlanFile(planDirName, "summary.md") || "";
  const goal = normalizeCompactText(extractGoalFromPlanContent(planContent) || "Goal not recorded");
  const outcome = extractSummaryOutcome(summaryContent) || "No summary.md captured yet — use the plan goal and full archives for details.";
  return [
    `- Goal: ${goal}`,
    `- Outcome: ${outcome}`,
    `- Summary: plans/${planDirName}/summary.md`,
    "- Deep dive: plans/FINDINGS.md, plans/DECISIONS.md",
  ].join("\n");
}

function rebuildPlanIndex() {
  const indexPath = join(plansDir, "INDEX.md");
  const sections = listPlanDirectoriesByRecency()
    .map((planDirName) => `## ${planDirName}\n${buildPlanIndexSection(planDirName)}`);
  const content = [
    "# Plan Index",
    "*Compact cross-plan memory index. Start here before full archives. Entries are derived from each plan's goal and summary.md. Newest first.*",
    "",
    ...(sections.length > 0 ? [sections.join("\n\n")] : ["*No closed plans indexed yet.*"]),
    "",
  ].join("\n");
  writeFileSync(indexPath + ".tmp", content);
  renameSync(indexPath + ".tmp", indexPath);
}

function formatTransitionSummary(transition) {
  if (!transition) return "?";
  const from = transition.from || "?";
  const to = transition.to || "?";
  const ts = typeof transition.timestamp === "string"
    ? transition.timestamp.replace(/\.\d{3}Z$/, "Z")
    : "?";
  return `${from} → ${to} (${ts})`;
}

function getPlanSnapshot(planDirName) {
  const planDir = join(plansDir, planDirName);
  const state = readPlanFile(planDirName, "state.md");
  const plan = readPlanFile(planDirName, "plan.md");
  const stateJson = readStateJson(planDir);
  const lastTransition = Array.isArray(stateJson?.transitions)
    ? stateJson.transitions[stateJson.transitions.length - 1]
    : null;

  return {
    currentState: stateJson?.state || extractField(state, /^# Current State:\s*(.+)$/m) || "UNKNOWN",
    iteration: stateJson?.iteration ?? extractField(state, /^## Iteration:\s*(.+)$/m) ?? "?",
    step: stateJson?.current_step || extractField(state, /^## Current Plan Step:\s*(.+)$/m) || "N/A",
    lastTransition: lastTransition
      ? formatTransitionSummary(lastTransition)
      : extractField(state, /^## Last Transition:\s*(.+)$/m) || "?",
    goal: stateJson?.goal || extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "No goal found",
  };
}

const ACTIVE_PLAN_ALIAS_LABEL = "plans/ACTIVE_PLAN.md";
const CROSS_PLAN_NOTE = "*Cross-plan context: start with plans/INDEX.md, then use plans/FINDINGS.md and plans/DECISIONS.md for deep dives.*";

function refreshActivePlanAliasFor(planDirName = null) {
  const planDir = planDirName ? join(plansDir, planDirName) : null;
  const stateJson = planDirName && existsSync(planDir) ? readStateJson(planDir) : null;
  return syncActivePlanAlias(plansDir, { planDirName, planDir, stateJson });
}

function ensureConsolidatedFiles() {
  mkdirSync(plansDir, { recursive: true });
  const findingsPath = join(plansDir, "FINDINGS.md");
  const decisionsPath = join(plansDir, "DECISIONS.md");
  if (!existsSync(findingsPath)) {
    writeFileSync(findingsPath, `# Consolidated Findings
*Cross-plan findings archive. Entries merged from per-plan findings.md on close. Newest first.*
`);
  }
  if (!existsSync(decisionsPath)) {
    writeFileSync(decisionsPath, `# Consolidated Decisions
*Cross-plan decision archive. Entries merged from per-plan decisions.md on close. Newest first.*
`);
  }
  // Ensure knowledge base files exist — explore-to-plan gate FAILs if missing
  const knowledgeDir = join(plansDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  const kbFiles = {
    "index.md": KB_INDEX_TEMPLATE,
    "mistakes.md": `# Mistakes

Recurring mistakes and antipatterns. Format: \`M-NNN: Short title (date)\`.

<!-- Next mistake: M-001 -->
`,
    "patterns.md": `# Patterns

Proven implementation patterns. Record what worked so future plans can reuse it.

Format: \`P-NNN: Short title (date)\` — What worked, why it worked, when to apply it.

<!-- Next pattern: P-001 -->
`,
    "gotchas.md": `# Gotchas

Non-obvious traps and constraints. Format: \`G-NNN: Short title (date)\`.

<!-- Next gotcha: G-001 -->
`,
  };
  for (const [name, content] of Object.entries(kbFiles)) {
    const filePath = join(knowledgeDir, name);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content);
    }
  }
  const retroDir = join(knowledgeDir, "retros");
  const retroCasesDir = join(retroDir, "cases");
  mkdirSync(retroCasesDir, { recursive: true });
  const retroLedgerPath = join(retroDir, "retro_ledger.json");
  if (!existsSync(retroLedgerPath)) {
    writeFileSync(retroLedgerPath, RETRO_LEDGER_TEMPLATE);
  }

  rebuildPlanIndex();
}

function prependToConsolidated(filePath, planDirName, newSection) {
  // Insert new section after the header (H1 + boilerplate), before existing plan sections.
  // Newest plans appear first so the most recent context is read first.
  let existing = "";
  try { existing = readFileSync(filePath, "utf-8"); } catch { /* file may not exist */ }
  // Split at first ## (plan section heading) — everything before is the header
  const firstH2 = existing.indexOf("\n## ");
  let header, body;
  if (firstH2 >= 0) {
    header = existing.slice(0, firstH2);
    body = existing.slice(firstH2);
  } else {
    header = existing.trimEnd();
    body = "";
  }
  const merged = header + `\n\n## ${planDirName}\n${newSection}\n` + body;
  writeFileSync(filePath + ".tmp", merged);
  renameSync(filePath + ".tmp", filePath);
}

function appendHealthHistory(planDirName, baseline, final_) {
  // F-028 FIX: Guard against missing summary fields
  if (!baseline?.summary || !final_?.summary) return;
  const knowledgeDir = join(plansDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  const historyPath = join(knowledgeDir, "health_history.md");
  const date = new Date().toISOString().split("T")[0];
  const bStr = `${baseline.summary.fail}/${baseline.summary.warn}/${baseline.summary.info}`;
  const fStr = `${final_.summary.fail}/${final_.summary.warn}/${final_.summary.info}`;
  const failDelta = final_.summary.fail - baseline.summary.fail;
  const warnDelta = final_.summary.warn - baseline.summary.warn;
  const infoDelta = final_.summary.info - baseline.summary.info;
  const parts = [];
  if (failDelta !== 0) parts.push(`${failDelta > 0 ? "+" : ""}${failDelta}F`);
  if (warnDelta !== 0) parts.push(`${warnDelta > 0 ? "+" : ""}${warnDelta}W`);
  if (infoDelta !== 0) parts.push(`${infoDelta > 0 ? "+" : ""}${infoDelta}I`);
  const deltaStr = parts.length > 0 ? parts.join(" ") : "no change";
  const icon = failDelta > 0 ? "❌" : failDelta < 0 ? "✅" : "➖";
  const row = `| ${planDirName} | ${date} | ${bStr} | ${fStr} | ${deltaStr} ${icon} | |`;

  if (!existsSync(historyPath)) {
    writeFileSync(historyPath, `# Health History\n\nTracks project health across plans. Read this at EXPLORE start to understand trends.\n\n| Plan | Date | Baseline (F/W/I) | Final (F/W/I) | Delta | Notes |\n|------|------|-------------------|---------------|-------|-------|\n${row}\n`);
  } else {
    // Atomic append: read + append + write-to-tmp + rename
    const existing = readFileSync(historyPath, "utf-8");
    const tmpPath = historyPath + ".tmp";
    writeFileSync(tmpPath, existing + row + "\n");
    renameSync(tmpPath, historyPath);
  }
}

function stripHeader(content) {
  // Strip everything before the first ## heading (the actual user content).
  // This avoids fragile exact-match regexes on boilerplate text that the agent may edit.
  const firstH2 = content.search(/^## /m);
  return firstH2 >= 0 ? content.slice(firstH2) : content;
}

function stripCrossPlanNote(content) {
  return content.replace(/\n?\*Cross-plan context:[^\n]*\*\n?/g, "\n");
}

function mergeToConsolidated(planDirName) {
  // Merge per-plan findings.md → plans/FINDINGS.md (newest first)
  const findingsContent = readPlanFile(planDirName, "findings.md");
  if (findingsContent) {
    let stripped = stripCrossPlanNote(stripHeader(findingsContent));
    // Demote ## → ###
    stripped = stripped.replace(/^## /gm, "### ");
    // Rewrite relative findings/ links to planDirName/findings/
    stripped = stripped.replace(/\(findings\//g, `(${planDirName}/findings/`);
    stripped = stripped.trim();
    if (stripped) {
      prependToConsolidated(join(plansDir, "FINDINGS.md"), planDirName, stripped);
    }
  }

  // Merge per-plan decisions.md → plans/DECISIONS.md (newest first)
  const decisionsContent = readPlanFile(planDirName, "decisions.md");
  if (decisionsContent) {
    let stripped = stripCrossPlanNote(stripHeader(decisionsContent));
    // Demote ## → ###
    stripped = stripped.replace(/^## /gm, "### ");
    stripped = stripped.trim();
    if (stripped) {
      prependToConsolidated(join(plansDir, "DECISIONS.md"), planDirName, stripped);
    }
  }

  rebuildPlanIndex();
}

function formatPoisonedGateDetail(entry) {
  const failureCodes = Array.isArray(entry?.failureCodes) && entry.failureCodes.length > 0
    ? `; failure codes: ${entry.failureCodes.join(", ")}`
    : "";
  const lastAttempt = entry?.lastMatchingAttempt?.timestamp
    ? `; last attempt: ${entry.lastMatchingAttempt.timestamp}`
    : "";
  return `${entry.gate} (${entry.consecutiveFails} consecutive FAILs${failureCodes}${lastAttempt})`;
}

function normalizeRecoveredContent(content) {
  return String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripDecisionNonceMarkers(content) {
  return String(content || "").replace(/^\[(APPROVED|REJECTED):[^\]]+\].*$/gm, "");
}

function stripKbDigestMarkers(content) {
  return String(content || "")
    .replace(/^\[KB_DIGEST:[^\]]+\]\s*$/gm, "")
    .replace(/^\[FAST_TRACK\]\s*$/gm, "");
}

function setMarkdownSection(content, heading, body) {
  const normalizedBody = String(body || "").trim();
  const replacement = `## ${heading}\n${normalizedBody}\n`;
  if (new RegExp(`^## ${heading}\\s*$`, "m").test(content)) {
    return content.replace(new RegExp(`^## ${heading}\\s*$\\n[\\s\\S]*?(?=\\n## |\\n# |$)`, "m"), replacement);
  }
  return `${content.trimEnd()}\n\n${replacement}`;
}

function sanitizeRecoveredFindingsLedger(ledger, recoveryContext) {
  const sanitized = JSON.parse(JSON.stringify(ledger));
  sanitized.fast_track = false;
  sanitized.kb_digest_salt = null;
  sanitized.recovery_context = recoveryContext;
  return sanitized;
}

function buildRecoveryContextBlock(sourcePlanDirName, poisonedEntries, carriedArtifacts) {
  const lines = [
    "## Recovery Context",
    `Recovered from history-poisoned plan \`${sourcePlanDirName}\`.`,
    `Poisoned gates: ${poisonedEntries.map(formatPoisonedGateDetail).join("; ")}`,
    `Carried artifacts: ${carriedArtifacts.length > 0 ? carriedArtifacts.join(", ") : "none"}`,
  ];
  return lines.join("\n");
}

function carryRecoveredArtifacts(sourcePlanDirName, targetPlanDirName, poisonedEntries) {
  const sourcePlanDir = join(plansDir, sourcePlanDirName);
  const targetPlanDir = join(plansDir, targetPlanDirName);
  const carriedArtifacts = [];
  const recoveryContext = {
    recovered_from_plan: sourcePlanDirName,
    recovered_at: nowISO(),
    reason: "history_poison",
    poisoned_gates: poisonedEntries.map((entry) => ({
      gate: entry.gate,
      consecutive_fails: entry.consecutiveFails,
      last_attempt_at: entry?.lastMatchingAttempt?.timestamp || null,
      failure_codes: Array.isArray(entry.failureCodes) ? entry.failureCodes : [],
    })),
  };

  const ledgerInfo = loadFindingsLedger(sourcePlanDir);
  if (ledgerInfo.present && ledgerInfo.parsed && findingsLedgerHasRenderableContent(ledgerInfo.parsed)) {
    const sanitizedLedger = sanitizeRecoveredFindingsLedger(ledgerInfo.parsed, recoveryContext);
    writeFileSync(join(targetPlanDir, "findings_ledger.json"), JSON.stringify(sanitizedLedger, null, 2) + "\n");
    syncFindingsMarkdownFromLedger(targetPlanDir);
    carriedArtifacts.push("findings_ledger.json", "findings.md");
  } else {
    const findingsContent = normalizeRecoveredContent(stripKbDigestMarkers(stripCrossPlanNote(stripHeader(readFindingsMarkdown(sourcePlanDir) || ""))));
    if (findingsContent) {
      const findingsPath = join(targetPlanDir, "findings.md");
      const rebuilt = [
        "# Findings",
        "*Summary and index of all findings. Detailed files go in findings/ directory.*",
        "",
        CROSS_PLAN_NOTE,
        "",
        buildRecoveryContextBlock(sourcePlanDirName, poisonedEntries, ["findings.md"]),
        "",
        findingsContent,
        "",
      ].join("\n");
      writeFileSync(findingsPath, rebuilt);
      carriedArtifacts.push("findings.md");
    }
  }

  const sourceFindingsDir = join(sourcePlanDir, "findings");
  if (existsSync(sourceFindingsDir)) {
    cpSync(sourceFindingsDir, join(targetPlanDir, "findings"), { recursive: true, force: true });
    carriedArtifacts.push("findings/");
  }

  // v7.4.1: carry intent_contract forward, plus seed job_to_be_done with the
  // source plan's goal if the source contract is blank. The Tennis incident
  // showed that a poisoned source plan with an empty intent_contract leaves
  // the successor blank too, which then fails low_trace_coverage. Seeding the
  // goal as a starting job_to_be_done unblocks the successor's PLAN gate
  // without inventing new user/deliverable claims.
  const sourceIntentPath = join(sourcePlanDir, "intent_contract.json");
  if (existsSync(sourceIntentPath)) {
    let intentContract;
    try {
      intentContract = JSON.parse(readFileSync(sourceIntentPath, "utf-8"));
    } catch {
      intentContract = null;
    }
    const sourceGoal = (() => {
      const fromState = readStateJson(sourcePlanDir)?.goal;
      if (fromState && String(fromState).trim()) return String(fromState).trim();
      const fromPlan = extractGoalFromPlanContent(readFileSync(join(sourcePlanDir, "plan.md"), "utf-8"));
      return fromPlan ? String(fromPlan).trim() : "";
    })();
    if (intentContract && typeof intentContract === "object" && sourceGoal) {
      const isBlank = !intentContract.job_to_be_done && !intentContract.primary_user &&
        (!Array.isArray(intentContract.desired_outcomes) || intentContract.desired_outcomes.length === 0) &&
        (!Array.isArray(intentContract.deliverables) || intentContract.deliverables.length === 0);
      if (isBlank) {
        intentContract.job_to_be_done = `Carried from source plan goal during recover-poison: ${sourceGoal}`;
        intentContract._recovery_note = "Seeded job_to_be_done from source goal because the original intent_contract.json was blank. Refine before transitioning to PLAN.";
      }
    }
    const carriedJson = intentContract
      ? JSON.stringify(intentContract, null, 2) + "\n"
      : readFileSync(sourceIntentPath, "utf-8");
    writeFileSync(join(targetPlanDir, "intent_contract.json"), carriedJson);
    carriedArtifacts.push("intent_contract.json");
  }

  const sourceDecisions = normalizeRecoveredContent(
    stripDecisionNonceMarkers(stripCrossPlanNote(stripHeader(readFileSync(join(sourcePlanDir, "decisions.md"), "utf-8"))))
  );
  const targetDecisionsPath = join(targetPlanDir, "decisions.md");
  const targetDecisions = existsSync(targetDecisionsPath) ? readFileSync(targetDecisionsPath, "utf-8").trimEnd() : "# Decision Log";
  const priorDecisionBlock = sourceDecisions
    ? `\n\n### Prior Decision Context\n${sourceDecisions.replace(/^## /gm, "#### ")}`
    : "";
  writeFileSync(
    targetDecisionsPath,
    `${targetDecisions}\n\n${buildRecoveryContextBlock(sourcePlanDirName, poisonedEntries, carriedArtifacts)}${priorDecisionBlock}\n`
  );
  if (sourceDecisions) carriedArtifacts.push("decision context");

  const targetPlanPath = join(targetPlanDir, "plan.md");
  const targetPlanContent = readFileSync(targetPlanPath, "utf-8");
  const recoveryContextLines = [
    `Recovered from history-poisoned plan \`${sourcePlanDirName}\`.`,
    `Poisoned gates: ${poisonedEntries.map(formatPoisonedGateDetail).join("; ")}`,
    "Sanitized findings, intent, and decision context were carried forward into this successor plan.",
  ].join("\n");
  writeFileSync(targetPlanPath, setMarkdownSection(targetPlanContent, "Context", recoveryContextLines));

  const targetProgressPath = join(targetPlanDir, "progress.md");
  const targetProgressContent = readFileSync(targetProgressPath, "utf-8")
    .replace("*Nothing yet.*", `- [x] RECOVERY: carried forward sanitized context from \`${sourcePlanDirName}\``);
  writeFileSync(targetProgressPath, targetProgressContent);

  const sourceState = readStateJson(sourcePlanDir);
  if (sourceState) {
    sourceState.recovery_context = {
      mode: "source",
      reason: "history_poison",
      successor_plan: targetPlanDirName,
      recovered_at: recoveryContext.recovered_at,
      poisoned_gates: recoveryContext.poisoned_gates,
    };
    writeStateJson(sourcePlanDir, sourceState);
  }

  const targetState = readStateJson(targetPlanDir);
  if (targetState) {
    targetState.recovery_context = {
      mode: "successor",
      reason: "history_poison",
      recovered_from_plan: sourcePlanDirName,
      recovered_at: recoveryContext.recovered_at,
      poisoned_gates: recoveryContext.poisoned_gates,
      carried_artifacts: carriedArtifacts,
    };

    // v7.4.2: carry forward source state.json fields that are still valid
    // for the successor. Conservative set — security-sensitive fields
    // (approval_nonce_hash, kb_digest_hash) deliberately NOT carried so the
    // successor regenerates them through its own explore-to-plan / approval
    // flow. consumed_nonces also not carried (each plan has its own nonce
    // history). The fields that ARE carried are environmental — they encode
    // the source's view of the surrounding repo, which the successor inherits
    // since it's the same repo at the same commit.
    if (sourceState) {
      // registry_hash: source's view of story_registry. Carrying preserves
      // the ontology baseline so successor doesn't trip a spurious drift
      // warning for changes the source already accepted.
      if (sourceState.registry_hash !== undefined && targetState.registry_hash === undefined) {
        targetState.registry_hash = sourceState.registry_hash;
        carriedArtifacts.push("state.registry_hash");
      }
      // plan_shape: always carry source's plan_shape since both plans share
      // the same goal (recover-poison passes goal forward to cmdNew). The
      // source annotation distinguishes recovery-derived shape from a
      // freshly-detected shape, which matters for telemetry.
      if (sourceState.plan_shape && sourceState.plan_shape.primary) {
        targetState.plan_shape = {
          ...sourceState.plan_shape,
          source: `${sourceState.plan_shape.source || "unknown"}:carried_from_source_plan`,
        };
        carriedArtifacts.push("state.plan_shape");
      }
      // circuit_breakers: don't carry the source's circuit state — the
      // successor deserves fresh circuit state. But ensure the field exists
      // as an empty object so legacy consumers that call
      // Object.values(stateJson.circuit_breakers || {}) get a defined array
      // every time, not undefined-falling-through-to-default.
      if (!targetState.circuit_breakers) {
        targetState.circuit_breakers = {};
      }
    }

    writeStateJson(targetPlanDir, targetState);
    refreshActivePlanAliasFor(targetPlanDirName);
  }

  return carriedArtifacts;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdNew(goal, opts = {}) {
  const force = opts.force === true;
  const parallel = opts.parallel === true;
  const suppressOrphanWarning = opts.suppressOrphanWarning === true;
  mkdirSync(plansDir, { recursive: true });

  // Clear stale supervisor verdicts when starting a fresh plan.
  // Fresh plans should get fresh advisor/ontology verdicts, not values cached
  // against the previous plan's escalation state.
  try {
    const supervisorRunnerPath = join(dirname(fileURLToPath(import.meta.url)), "lib", "supervisor_runner.mjs");
    if (existsSync(supervisorRunnerPath)) {
      // Synchronous-style dynamic import via spawnSync for non-blocking cmdNew flow
      const clearScript = `import('${supervisorRunnerPath.replace(/'/g, "\\'")}')` +
        `.then(m => { const n = m.clearSupervisorCache(); console.log('cleared:' + n); })`;
      spawnSync("node", ["--input-type=module", "-e", clearScript], {
        encoding: "utf-8", timeout: 5000, stdio: ["ignore", "ignore", "ignore"],
      });
    }
  } catch { /* non-fatal — cache will be lazily replaced on next supervisor call */ }

  // D-018: Acquire advisory lock to prevent concurrent bootstrap races
  if (!acquireLock()) {
    console.error("ERROR: Another bootstrap process is running (plans/.lock exists).");
    console.error("  If this is stale, remove plans/.lock manually.");
    process.exit(1);
  }

  // Warn about non-closed plan directories when the active pointer is missing.
  // Closed historical plans are preserved intentionally and should not look like crash residue.
  try {
    const activeName = readPointer();
    const allPlans = readdirSync(plansDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("plan_"))
      .map((d) => d.name);
    const unpointedNonClosedPlans = allPlans.filter((name) => name !== activeName && getPlanLifecycleState(name) !== "CLOSE");
    if (!suppressOrphanWarning && unpointedNonClosedPlans.length > 0 && !activeName) {
      console.error(`WARNING: Found ${unpointedNonClosedPlans.length} non-closed plan director${unpointedNonClosedPlans.length === 1 ? "y" : "ies"} with no active pointer:`);
      for (const o of unpointedNonClosedPlans) console.error(`  plans/${o}`);
      console.error(`  These may be from a previous crash or manual pointer removal. Use 'list' to inspect.`);
    }
  } catch (e) { debugLog("bootstrap", `Orphan scan failed: ${e.message}`); }

  const existing = readPointer();
  if (existing && !force && !parallel) {
    console.error(`ERROR: Active plan directory already exists: plans/${existing}`);
    console.error(`  To resume:      node ${process.argv[1]} resume`);
    console.error(`  To view status:  node ${process.argv[1]} status`);
    console.error(`  To close it:     node ${process.argv[1]} close`);
    console.error(`  To create in parallel: node ${process.argv[1]} new --parallel "goal"`);
    console.error(`  To force new:    node ${process.argv[1]} new --force "goal"`);
    releaseLock(); // F-002 FIX: Release advisory lock before early exit
    process.exit(1);
  }
  if (existing && force) {
    // RP-001: cmdClose already merges findings/decisions. Pass forceMarker so
    // the state.md CLOSE entry records that this was a force-close.
    cmdClose({ silent: true, force: true, forceMarker: "[FORCE-CLOSED]" });
  }
  // Save old pointer name for recovery if --force was used and new plan creation fails
  const previousPlan = force ? existing : null;

  const now = new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const dateStr = now.toISOString().slice(0, 10);
  const hexStr = randomBytes(8).toString("hex");
  const planDirName = `plan_${dateStr}_${hexStr}`;
  const planDir = join(plansDir, planDirName);

  const crossPlanNote = `\n${CROSS_PLAN_NOTE}\n`;

  // v7.3.0: detect plan shape from goal early so templates and metadata can
  // be tailored. Shape only determines which sections are pre-populated; the
  // user can still write any section in any plan, and the gates honor the
  // detected shape regardless.
  const planShape = detectPlanShape({ goalText: goal });
  const shapeMin = shapeMinFindings(planShape);
  const shapeNeedsRootCause = shapeRequiresField(planShape, "root_cause");
  const shapeNeedsAdjacency = shapeRequiresField(planShape, "adjacency");
  const shapeNeedsAssumptionLedger = shapeRequiresField(planShape, "assumption_ledger");

  try {
    mkdirSync(join(planDir, "checkpoints"), { recursive: true });
    mkdirSync(join(planDir, "findings"), { recursive: true });

    // Seed KB files before state.json so new plans capture a real knowledge snapshot.
    ensureConsolidatedFiles();

    writeFileSync(
      join(planDir, "state.md"),
      `# Current State: EXPLORE
## Iteration: 0
## Current Plan Step: N/A
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
- [ ] Re-read plan.md
- [ ] Re-read progress.md
- [ ] Re-read decisions.md (if fix attempt)
- [ ] Checkpoint created (if risky step or irreversible op)
## Fix Attempts (resets per plan step)
- (none yet)
## Change Manifest (current iteration)
- (no changes yet)
## Last Transition: INIT → EXPLORE (${timestamp})
## Transition History:
- INIT → EXPLORE (task started)
`
    );

    writeFileSync(
      join(planDir, "plan.md"),
      `# Plan v0

## Goal
${goal}

## Problem Statement
*To be defined during PLAN. (1) Expected behavior, (2) invariants, (3) edge cases.*

## Context
*Pending EXPLORE phase. Findings will inform the approach.*

## Files To Modify
*To be determined after EXPLORE. List every file that will be touched.*

## Steps
*To be determined after EXPLORE.*

## Verification Obligation Synthesis
*Required whenever repo/task context, ontology signals, persona signals, or touched boundaries imply operational verification risk. Fill every line below with repo-specific reasoning rather than a generic standard.*

- Repo/system context: *What kind of system is changing?*
- Task shape: *What kind of change is this?*
- Ontology signals: *What stories, tags, recipe surfaces, or other ontology signals raise verification obligations here? Write \`N/A — no ontology signals\` only if none apply.*
- Persona signals: *What persona packs, constraints, or findings influence verification here? Write \`N/A — no persona signals\` only if none apply.*
- System boundaries touched: *Which real systems, boundaries, or execution paths are at risk?*
- Derived verification obligations: *What proof obligations should shape the matrix below?*

## Semantic Upkeep Contract
*Required for non-trivial work. Say what semantic surfaces must stay in sync so the planner can separate REFLECT from VALIDATE cleanly.*

- Profile: *Choose one: website_ui_content, integration_backend_orchestration, scientific_training_quant, or other with explanation.*
- Ontology action: *none | refresh_links | update_entities | update_relationships | other*
- Story action: *none | relink_existing | revise_existing | add_new | other*
- Validation bundle: *manual_ui | docs_contract | behavioral | integration | benchmark | mixed*
- Strictness mode: *lightweight | full | scientific*
- Close blocker if skipped: *Explain what becomes incoherent or unprovable if this semantic upkeep is not done.*

## Failure Modes
*To be determined during PLAN. For each dependency/integration: what if slow, garbage, down?*

## Risks
*To be determined after EXPLORE.*

## Success Criteria
*To be defined before first EXECUTE.*

## Verification Strategy
*To be defined during PLAN. Prefer a table. Baseline shape: Criterion | Story linkage | Check | Pass means. For recipe/orchestration/integration/browser/backend work, use a context-sensitive matrix: Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified. Wrapper/unit tests alone are not enough when the real risk is operational behavior.*

## Active Mistake Response
*Required only when the structured mistake registry activates one or more mistakes for this plan. Use a table: Mistake | Guard | Planned handling | Planned evidence.*

## Complexity Budget
- Files added: 0/3 max
- New abstractions (classes/modules/interfaces): 0/2 max
- Lines added vs removed: +0/-0 (target: net negative or neutral)
`
    );

    writeFileSync(
      join(planDir, "decisions.md"),
      `# Decision Log
*Append-only. Never edit past entries.*
${crossPlanNote}`
    );

    // v7.3.0: shape-aware findings template. Pre-populates only the sections
    // required for the detected shape. A 'feature' or 'docs' plan no longer
    // gets a Root Cause / Adjacency / Assumption Ledger placeholder it would
    // have to mark "N/A" to clear the gate.
    const findingsScaffold = [
      `# Findings`,
      `*Summary and index of all findings. Detailed files go in findings/ directory.*`,
      `*Detected shape: **${planShape.primary}** (source: ${planShape.source}). Required gates scale to this shape.*`,
      crossPlanNote,
      `## Index`,
      `*Add ≥${shapeMin} indexed finding(s) below as \`## F-001\`, \`## F-002\`, ... entries.*`,
      ``,
      `## Key Constraints`,
      `*To be populated during EXPLORE.*`,
    ];
    if (shapeNeedsRootCause) {
      findingsScaffold.push(``, `## Root Cause`, `*Document the root-cause chain. Diagnosis-shaped plans require this.*`);
    }
    if (shapeNeedsAdjacency) {
      findingsScaffold.push(``, `## Adjacency`, `*Enumerate sibling files, importers, adjacent modules. blast_radius.mjs or manual grep both acceptable.*`);
    }
    if (shapeNeedsAssumptionLedger) {
      findingsScaffold.push(``, `## Assumption Ledger`, ``, `| # | Assumption | Probe | Result |`, `|---|------------|-------|--------|`, `| 1 | *e.g. external endpoint exists* | *probe command* | *VERIFIED or VIOLATED* |`);
    }
    writeFileSync(join(planDir, "findings.md"), findingsScaffold.join("\n") + "\n");

    writeFileSync(
      join(planDir, "findings_ledger.json"),
      JSON.stringify({
        version: 1,
        fast_track: false,
        kb_digest_salt: null,
        findings: [],
        root_cause: null,
        adjacency: null,
        assumptions: [],
        existing_capabilities: [],
        story_candidates: [],
      }, null, 2) + "\n"
    );

    writeFileSync(
      join(planDir, "intent_contract.json"),
      JSON.stringify({
        version: 1,
        primary_user: null,
        job_to_be_done: null,
        desired_outcomes: [],
        anti_goals: [],
        constraints: [],
        deliverables: [],
      }, null, 2) + "\n"
    );

    writeFileSync(
      join(planDir, "progress.md"),
      `# Progress

*Use checkbox items (\`- [x]\` / \`- [ ]\`) in Completed, In Progress, and Remaining so gates can track progress reliably. Plain bullets in Completed are tolerated for legacy plans, but checkbox form is preferred.*

## Completed
*Nothing yet.*

## In Progress
- [ ] EXPLORE: Initial context gathering

## Remaining
*To be populated from plan.md after PLAN phase.*

## Blocked
*Nothing currently.*
`
    );

    writeFileSync(
      join(planDir, "reflection.md"),
      `# Reflection
*Completed during REFLECT. This is the semantic/solution judgment surface before VALIDATE takes over proof sufficiency.*
*Rewrite as needed within the active iteration; do not leave template text behind when moving to VALIDATE.*

## Solution Verdict
*PASS / FAIL / PARTIAL. Did the implemented change actually improve the intended thing?*

## Semantic Verdict
*PASS / FAIL / PARTIAL. Are ontology, stories, and user-facing meaning still coherent with reality?*

## Evidence-Readiness Verdict
*READY / NOT READY. Is the work ready to enter VALIDATE, even if final proof has not yet passed?*

## Next Move
*close path | re-plan | explore | waiver path. Say what should happen next and why.*

## Knowledge Base Sign-Off
- Decision: pending
- Reason: pending

## Surprises And Learnings
*What changed your understanding during execution or reflection?*

## Improvement Notes
*What should be improved next time, even if this iteration is otherwise acceptable?*
`
    );

    writeFileSync(
      join(planDir, "verification.md"),
      `# Verification Results
*Populated during PLAN (template), updated during EXECUTE (per-step), and completed during VALIDATE (full pass).*
*Rewritten each iteration — not append-only.*

## Criteria Verification
| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |
|---|--------------------------|--------|----------------|--------|----------|
| 1 | *To be populated during PLAN* | - | - | PENDING | - |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PENDING | Record scaffold/bootstrap evidence only |
| Locally / unit tested | PENDING | Record wrapper or unit-level evidence only |
| Context-appropriate integration tested | PENDING | Record browser/integration/smoke/dry-run evidence appropriate to the changed system |
| Audit reviewed | PENDING | Record audit, parity, migration, or artifact-review evidence when applicable |
| Live approved | NOT REQUESTED | Record explicit operator approval only when live validation is intended |

## Systems Exercised
*List the real systems, boundaries, or execution paths actually exercised. If none were exercised locally, say so explicitly and explain what blocked it.*

## Remaining Unverified
*List what remains unverified and why. If nothing remains, write \`None\` and say why that is credible.*

## Verification Sufficiency
*Explain why this level of verification is sufficient for the repo/task context, or why it is the strongest available local proof if some validation is still deferred.*

## Additional Checks
*Optional: lint, type checks, behavioral diffs, smoke tests.*

## Test Drift Scan
*Record the drift review here, or write \`N/A — no tests\`.*

## Regression Audit
*Record \`/regression-audit\` or \`test_baseline.mjs verify\` here, or write \`N/A — no baseline captured\`.*

## Anti-Recurrence Guard
*Required for retro / bug-hunt / remediation work. Record at least one \`PASS\` line plus \`Guard Type: test\`, \`ontology\`, \`annotation\`, or \`kb\`. Otherwise write \`N/A — not remediation work\`.*

## Active Mistake Evidence
*Required only when an active mistake has verification hooks. Use a table: Mistake | Hook | Status | Evidence.*

## Learned Obligations
*Optional but recommended when the planner activates learned verification obligations. Prefer structured evidence or waiver records in \`verification_ledger.json\`; use this section only as a markdown fallback and name the obligation \`Subject:\`, \`Mode:\`, and \`Guard Type:\` explicitly.*

## Parity
*Record parity results here, or write \`N/A — no parity-registry.md\`.*

## Proof of Work
*Paste actual command output in fenced code blocks here. Empty code fences do not count. If local verification is impossible, write \`UNVERIFIED: Requires manual user validation\`.*

## Verdict
*To be completed during VALIDATE.*
`
    );

    writeFileSync(
      join(planDir, "red_team_notes.md"),
      `*Required before EXECUTE → REFLECT transition. Document at least 3 attack vectors with real, non-template content.*
*Accepted section styles include Attack:, **Attack**:, or heading-style subsections. Single-line sections are fine if they are substantive.*

## Vector 1: [TBD]
Attack:
- Replace this with the concrete failure trigger or adversarial input.
Impact:
- Replace this with the concrete user, data, or system damage.
Mitigation:
- Replace this with the guard, fallback, or regression test that prevents the failure.

## Vector 2: [TBD]
Attack:
- Replace this with the concrete failure trigger or adversarial input.
Impact:
- Replace this with the concrete user, data, or system damage.
Mitigation:
- Replace this with the guard, fallback, or regression test that prevents the failure.

## Vector 3: [TBD]
Attack:
- Replace this with the concrete failure trigger or adversarial input.
Impact:
- Replace this with the concrete user, data, or system damage.
Mitigation:
- Replace this with the guard, fallback, or regression test that prevents the failure.
`
    );

    // Determinism: write canonical state.json alongside state.md
    const stateJson = createInitialStateJson(planDirName, goal, { projectRoot: cwd });
    // v7.3.0: persist detected plan shape so gates and downstream tools can
    // consume it without re-detecting. The intent contract may override this
    // later via plan_shape; gates re-detect on each invocation to honor that.
    stateJson.plan_shape = {
      primary: planShape.primary,
      source: planShape.source,
      requirements: planShape.requirements,
    };
    writeStateJson(planDir, stateJson);
    writeScopeContract({
      cwd,
      planDir,
      planContent: readFileSync(join(planDir, "plan.md"), "utf-8"),
    });

    if (parallel && existing) {
      refreshActivePlanAliasFor(existing);
    } else {
      writeFileSync(pointerFile + ".tmp", planDirName);
      renameSync(pointerFile + ".tmp", pointerFile);
      refreshActivePlanAliasFor(planDirName);
    }
    writeThreadPlanTarget(plansDir, planDirName);
  } catch (err) {
    try { rmSync(planDir, { recursive: true, force: true }); } catch (e) { console.error(`WARNING: Failed to clean up partial plan directory: plans/${planDirName}`); }
    try { if (existsSync(pointerFile + ".tmp")) unlinkSync(pointerFile + ".tmp"); } catch (e) { console.error("WARNING: Failed to clean up temp pointer file."); }
    // If --force was used, restore the old pointer so the previous plan is not orphaned
    if (previousPlan) {
      try {
        writeFileSync(pointerFile, previousPlan);
        console.error(`WARNING: Restored pointer to previous plan: plans/${previousPlan}`);
      } catch (e) { console.error(`WARNING: Failed to restore pointer to previous plan: plans/${previousPlan}`); }
    } else {
      try { if (existsSync(pointerFile)) unlinkSync(pointerFile); } catch (e) { console.error("WARNING: Failed to clean up pointer file."); }
    }
    releaseLock();
    console.error(`ERROR: Failed to create plan directory: ${err.message}`);
    process.exit(1);
  }

  try {
    ensureGitignore();
  } catch (err) {
    console.error(`WARNING: Plan created but .gitignore update failed: ${err.message}`);
    console.error(`  Manually add plans/ to .gitignore.`);
  }

  console.log(`Initialized plans/${planDirName}/`);
  if (parallel && existing) {
    console.log(`  Pointer preserved: plans/.current_plan → ${existing}`);
    console.log(`  Thread target: plans/${planDirName}`);
  } else {
    console.log(`  Pointer: plans/.current_plan → ${planDirName}`);
  }
  console.log(`  Goal: ${goal}`);
  console.log(`  State: EXPLORE (iteration 0)`);
  console.log(`  Plan shape: ${planShape.primary} — requires ≥${shapeMin} finding(s)${shapeNeedsRootCause ? ", root cause" : ""}${shapeNeedsAdjacency ? ", adjacency" : ""}${shapeNeedsAssumptionLedger ? ", assumption ledger" : ""} (override via intent_contract.plan_shape)`);
  // v7.4.4: generalised triage warning. The chore-only warning from v7.4.3
  // is now driven by lib/triage.mjs's complexity score, which covers
  // questions, analysis tasks, and chores under one mechanism. When the
  // recommendation is skip_planner_question / skip_planner / lightweight,
  // bootstrap prints a prominent recommendation block before the rest of
  // the success output so agents see it before proceeding.
  const triage = computeTriage({ goalText: goal, plannedFiles: [], intentContract: null });
  const seriousPlannerPath = triage.recommended_path === "standard_planner" || triage.recommended_path === "full_planner";
  if (triage.recommended_path !== "standard_planner" && triage.recommended_path !== "full_planner") {
    console.log("");
    console.log(renderTriage(triage));
    console.log("");
  }
  warnPersonaAdaptation(cwd, { serious: seriousPlannerPath, seriousOnly: true });
  console.log(`  Open: ${ACTIVE_PLAN_ALIAS_LABEL}`);
  console.log(`  Cross-plan context: start with plans/INDEX.md, then use plans/FINDINGS.md and plans/DECISIONS.md`);
  console.log(`  Next: Read code, ask questions, write findings.`);
  warnTelemetryInstallHealth(cwd);

  // Check if rules.md has been customized with project-specific rules
  try {
    const rulesPath = join(cwd, ".agent", "rules.md");
    if (existsSync(rulesPath)) {
      const rulesContent = readFileSync(rulesPath, "utf-8");
      // Check if the DOMAIN placeholder is present but no rules were added after it
      if (rulesContent.includes("<!-- DOMAIN: PROJECT-SPECIFIC RULES") &&
          !rulesContent.match(/<!-- DOMAIN: PROJECT-SPECIFIC RULES[\s\S]*?-->\s*\n+## /)) {
        console.log();
        console.log(`  💡 TIP: .agent/rules.md has no project-specific rules yet.`);
        console.log(`     Add 2-4 rules covering your project's #1 bug source,`);
        console.log(`     data isolation, and framework conventions.`);
        console.log(`     See: .agent/ADAPTATION-GUIDE.md → "Fill in project context"`);
      }
    }
  } catch { /* non-blocking */ }

  // --- Health scan hooks (non-blocking) ---
  const __filename = fileURLToPath(import.meta.url);
  const scriptDir = dirname(__filename);
  console.log(`\n── Running initial health scan ──`);
  try {
    const healthScript = join(scriptDir, "project_health.mjs");
    const reportPath = join(planDir, "health_baseline.json");
    const jsonResult = spawnSync("node", [healthScript, "--json", "--out", reportPath], {
      encoding: "utf-8", timeout: 15000, cwd
    });
    if (jsonResult.status !== 0 && jsonResult.status !== 1) throw Object.assign(new Error(jsonResult.stderr || "health scan failed"), { status: jsonResult.status });
    const mdResult = spawnSync("node", [healthScript, "--quick", "--out", join(planDir, "health_report.md")], {
      encoding: "utf-8", timeout: 10000, cwd
    });
    if (mdResult.status !== 0 && mdResult.status !== 1) throw Object.assign(new Error(mdResult.stderr || "health scan failed"), { status: mdResult.status });
    console.log(`  ✅ Health baseline saved to health_baseline.json`);
    console.log(`  ✅ Health report saved to health_report.md`);
  } catch (e) {
    // exit 1 = scanner ran and found FAILs (valid); exit 2 = script error
    if (e.status === 1) {
      console.log(`  ✅ Health baseline saved. ⚠️  FAIL findings present — see health_report.md`);
    } else {
      console.log(`  ⚠️ Health scan failed (non-blocking): ${e.message}`);
    }
  }
  releaseLock();
  return { planDirName, planDir };
}

// Staleness detection — warns when a plan has not transitioned in a long time.
// Thresholds: >24h = warning, >7 days = warning, >21 days = strong warning with close suggestion.
function checkStaleness(planDirName) {
  const STALE_WARN_HOURS = 24;
  const STALE_WARN_DAYS = 7;
  const STALE_CRITICAL_DAYS = 21;
  try {
    const stateJson = readStateJson(join(plansDir, planDirName));
    if (!stateJson?.transitions?.length) return;

    // Stuck signal 1: stale pointer — plan is CLOSE but .current_plan still set
    if (stateJson.state === "CLOSE") {
      console.log();
      console.log(`  ⚠️  Stale plan pointer — plan state is CLOSE but pointer is still set.`);
      console.log(`     Run: node ${process.argv[1]} fix-stuck`);
      return; // remaining checks are meaningless for a closed plan
    }

    const lastTransition = stateJson.transitions[stateJson.transitions.length - 1];
    const lastTs = new Date(lastTransition.timestamp).getTime();
    if (isNaN(lastTs)) return;
    const ageHours = Math.floor((Date.now() - lastTs) / (60 * 60 * 1000));
    const ageDays = Math.floor(ageHours / 24);
    if (ageDays >= STALE_CRITICAL_DAYS) {
      console.log();
      console.log(`  ⚠️  STALE PLAN (${ageDays} days since last transition)`);
      console.log(`     State "${stateJson.state}" unchanged since ${lastTransition.timestamp}`);
      console.log(`     Consider: node ${process.argv[1]} close --informational`);
      console.log(`     Or:       node ${process.argv[1]} close --force`);
    } else if (ageDays >= STALE_WARN_DAYS) {
      console.log();
      console.log(`  ⚠️  Plan idle for ${ageDays} days (last transition: ${lastTransition.timestamp})`);
      console.log(`     If work was done outside this plan, consider closing it.`);
    } else if (ageHours >= STALE_WARN_HOURS) {
      console.log();
      console.log(`  ⚠️  STALE PLAN (${ageHours} hours since last transition)`);
      console.log(`     State "${stateJson.state}" unchanged since ${lastTransition.timestamp}`);
      console.log(`     Are you stuck in this state? Consider the /advisor workflow or closing the plan.`);
    }

    // Stuck signal 2: circuit breaker tripped on any gate
    const tripped = Object.entries(stateJson.circuit_breakers || {})
      .filter(([, v]) => (v.total_fails || 0) >= CIRCUIT_BREAKER_THRESHOLD);
    if (tripped.length > 0) {
      console.log();
      console.log(`  ⚠️  Circuit breaker tripped: ${tripped.map(([g, v]) => `${g} (${v.total_fails} fails)`).join(", ")}`);
      console.log(`     Run: node ${process.argv[1]} fix-stuck`);
    }

    // Stuck signal 3: history-poisoned gate tail — reset-circuit-breaker is insufficient.
    const poisoned = findPoisonedGateHistories(stateJson.transitions || [], GATE_REGISTRY, {
      threshold: GATE_HISTORY_POISON_THRESHOLD,
    });
    if (poisoned.length > 0) {
      console.log();
      console.log(`  ⚠️  History-poisoned gate tail: ${poisoned.map((entry) => formatPoisonedGateDetail(entry)).join(", ")}`);
      console.log("     This is an AV-19 history block — reset-circuit-breaker will not clear it.");
      console.log(`     Run: node ${process.argv[1]} fix-stuck`);
    }

    // Stuck signal 4: state hash mismatch (manual edit detected)
    const integrity = validateStateIntegrity(stateJson);
    if (!integrity.intact) {
      console.log();
      console.log(`  ⚠️  State hash mismatch — manual edit detected in state.json.`);
      console.log(`     Run: node ${process.argv[1]} fix-stuck`);
    }
  } catch { /* non-blocking */ }
}

function cmdResume() {
  if (existsSync(plansDir)) {
    try { ensureConsolidatedFiles(); } catch (e) { debugLog("bootstrap", `Consolidated file seed failed during resume: ${e.message}`); }
  }

  const pointerPlanDirName = readPointer();
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
  const planDirName = target.planDirName;
  if (!planDirName) {
    refreshActivePlanAliasFor(null);
    console.error("ERROR: No active plan. Use `new` to create one.");
    process.exit(1);
  }

  refreshActivePlanAliasFor(pointerPlanDirName);

  const progress = readPlanFile(planDirName, "progress.md");
  const decisions = readPlanFile(planDirName, "decisions.md");
  const { currentState, iteration, step, lastTransition, goal } = getPlanSnapshot(planDirName);

  console.log(`Resuming plans/${planDirName}/`);
  if (target.source && target.source !== "pointer") {
    console.log(`  Target:     ${target.source} resolution${target.threadId ? ` (${target.threadId})` : ""}`);
    if (pointerPlanDirName) {
      console.log(`  Pointer:    plans/.current_plan → ${pointerPlanDirName}`);
    }
  }
  console.log(`  State:      ${currentState}`);
  console.log(`  Iteration:  ${iteration}`);
  console.log(`  Step:       ${step}`);
  console.log(`  Goal:       ${goal.split("\n")[0]}`);
  console.log(`  Last:       ${lastTransition}`);
  console.log(`  Alias:      ${ACTIVE_PLAN_ALIAS_LABEL}`);
  checkStaleness(planDirName);
  const staleContext = detectRecentNonActivePlanContext(plansDir, planDirName);
  if (staleContext.warned) {
    console.log();
    console.log(staleContext.blocked
      ? "  ⚠️  Recent non-active plan edits detected."
      : "  ⚠️  Recent non-active plan context detected.");
    console.log(`     ${formatNonActivePlanContextDetail(staleContext, ACTIVE_PLAN_ALIAS_LABEL)}`);
  }
  console.log();

  // Print progress summary
  if (progress) {
    const completed = (progress.match(/^- \[x\].+$/gm) || []).length;
    const remaining = (progress.match(/^- \[ \].+$/gm) || []).length;
    console.log(`  Progress:   ${completed} done, ${remaining} remaining`);
  }

  // Print decision count
  if (decisions) {
    const decisionCount = (decisions.match(/^## D-\d+/gm) || []).length;
    if (decisionCount > 0) {
      console.log(`  Decisions:  ${decisionCount} logged`);
    }
  }

  // Print checkpoint listing
  const checkpointDir = join(plansDir, planDirName, "checkpoints");
  let checkpointFiles = [];
  try {
    checkpointFiles = readdirSync(checkpointDir).filter((f) => f.endsWith(".md")).sort();
  } catch (e) { debugLog("bootstrap", `Checkpoint scan failed: ${e.message}`); }
  if (checkpointFiles.length > 0) {
    console.log();
    console.log(`  Checkpoints (${checkpointFiles.length}):`);
    for (const cp of checkpointFiles) {
      console.log(`    ${cp} → plans/${planDirName}/checkpoints/${cp}`);
    }
  } else {
    console.log();
    console.log(`  Checkpoints: none`);
  }

  console.log();
  console.log(`  Recovery files:`);
  console.log(`    state.md     → plans/${planDirName}/state.md`);
  console.log(`    plan.md      → plans/${planDirName}/plan.md`);
  console.log(`    decisions.md → plans/${planDirName}/decisions.md`);
  console.log(`    progress.md  → plans/${planDirName}/progress.md`);
  console.log(`    findings.md  → plans/${planDirName}/findings.md`);
  console.log(`    reflection.md → plans/${planDirName}/reflection.md`);
  console.log(`    verification.md → plans/${planDirName}/verification.md`);
  console.log();
  console.log(`  Consolidated context:`);
  console.log(`    plans/INDEX.md     — compact cross-plan entrypoint`);
  console.log(`    plans/FINDINGS.md  — cross-plan findings archive`);
  console.log(`    plans/DECISIONS.md — cross-plan decision archive`);

  // --- Health refresh hook (non-blocking) ---
  const __resumeFilename = fileURLToPath(import.meta.url);
  const resumeScriptDir = dirname(__resumeFilename);
  console.log(`\n── Refreshing health context ──`);
  try {
    const healthScript = join(resumeScriptDir, "project_health.mjs");
    const planDir = join(plansDir, planDirName);
    const resumeResult = spawnSync("node", [healthScript, "--quick", "--out", join(planDir, "health_report.md")], {
      encoding: "utf-8", timeout: 10000, cwd
    });
    if (resumeResult.status === 0) {
      console.log(`  ✅ Health report refreshed`);
    } else if (resumeResult.status === 1) {
      console.log(`  ✅ Health report refreshed. ⚠️  FAIL findings present — see health_report.md`);
    } else {
      console.log(`  ⚠️ Health scan failed (non-blocking): exit ${resumeResult.status}`);
    }
  } catch (e) {
    console.log(`  ⚠️ Health scan failed (non-blocking): ${e.message}`);
  }
}

async function cmdStatus() {
  if (existsSync(plansDir)) {
    try { ensureConsolidatedFiles(); } catch (e) { debugLog("bootstrap", `Consolidated file seed failed during status: ${e.message}`); }
  }

  const pointerPlanDirName = readPointer();
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
  const planDirName = target.planDirName;
  if (!planDirName) {
    refreshActivePlanAliasFor(null);
    console.log("No active plan.");
    console.log(`  Canonical alias: ${ACTIVE_PLAN_ALIAS_LABEL}`);
    printAdvisoryEngineStatus(cwd);
    warnTelemetryInstallHealth(cwd);
    warnPersonaAdaptation(cwd);
    process.exit(0);
  }

  refreshActivePlanAliasFor(pointerPlanDirName);

  const { currentState, iteration, step, goal } = getPlanSnapshot(planDirName);

  console.log(`[${currentState}] iter=${iteration} step=${step} | ${goal.split("\n")[0].slice(0, 60)} | plans/${planDirName}`);
  printAdvisoryEngineStatus(cwd);
  warnTelemetryInstallHealth(cwd);
  warnPersonaAdaptation(cwd);
  const personaRecommendationSummary = renderActivePersonaRecommendationSummary(planDirName);
  if (personaRecommendationSummary) {
    console.log();
    console.log(personaRecommendationSummary);
  }
  const evidenceGuidanceSummary = renderActiveEvidenceGuidanceSummary(planDirName);
  if (evidenceGuidanceSummary) {
    console.log();
    console.log(evidenceGuidanceSummary);
  }
  const driftSummary = loadAsyncDriftSummary(join(plansDir, planDirName));
  if (driftSummary) {
    const jobs = driftSummary.jobs || {};
    const latest = driftSummary.latest_report;
    console.log();
    console.log(`  LLM drift maintenance: ${jobs.pending || 0} pending, ${jobs.running || 0} running, ${jobs.completed || 0} completed, ${jobs.failed || 0} failed.`);
    if (latest) {
      console.log(`     Latest report: ${latest.classification || latest.status || "unknown"}${latest.ontology_usage ? ` (${latest.ontology_usage})` : ""}`);
    }
    if (jobs.pending > 0 && driftSummary.latest_job?.path) {
      console.log(`     Run: node .agent/skills/iterative-planner/scripts/llm_drift_maintenance.mjs run --job ${driftSummary.latest_job.path}`);
    }
  }
  if (target.source && target.source !== "pointer") {
    console.log(`  Target source: ${target.source}${target.threadId ? ` (${target.threadId})` : ""}`);
    if (pointerPlanDirName) {
      console.log(`  Pointer: plans/.current_plan → ${pointerPlanDirName}`);
    }
  }
  checkStaleness(planDirName);
  const staleContext = detectRecentNonActivePlanContext(plansDir, planDirName);
  if (staleContext.warned) {
    console.log();
    console.log(staleContext.blocked
      ? "  ⚠️  Recent non-active plan edits detected."
      : "  ⚠️  Recent non-active plan context detected.");
    console.log(`     ${formatNonActivePlanContextDetail(staleContext, ACTIVE_PLAN_ALIAS_LABEL)}`);
  }

  // Non-blocking advisor session-review check.
  // Calls escalation_check.mjs --json --with-supervisor so the advisor supervisor
  // can produce a full verdict block (NEXT/WHY/Run lines) instead of just a stdout
  // marker. Supervisor verdicts are cached by state-hash; identical state = cache hit
  // = ~no LLM cost. Bumped timeout to 30s to allow cold-cache LLM round-trip.
  try {
    const __statusFilename = fileURLToPath(import.meta.url);
    const escalationScript = join(dirname(__statusFilename), "escalation_check.mjs");
    if (existsSync(escalationScript)) {
      const escResult = spawnSync("node", [escalationScript, "--json", "--with-supervisor"], {
        encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"],
      });
      if (escResult.status === 0 && escResult.stdout) {
        const escData = JSON.parse(escResult.stdout);
        const advEsc = (escData.escalations || []).find(e => e.type === "advisor-review");
        if (advEsc) {
          // Use the unit-tested helper rather than inline rendering so
          // test_supervisor_runner.mjs locks the format. Falls back to legacy
          // marker if supervisor_verdict is absent.
          try {
            const supervisorRunnerPath = join(dirname(fileURLToPath(import.meta.url)), "lib", "supervisor_runner.mjs");
            const { renderAdvisorEscalationBlock, isSupervisorRequired } = await import(supervisorRunnerPath);
            console.log();
            console.log(renderAdvisorEscalationBlock({
              advisorEscalation: advEsc,
              supervisorVerdict: escData.supervisor_verdict || null,
            }));
            console.log();
            // Vector 9: fail-closed mode. If the operator set
            // PLANNER_SUPERVISOR_REQUIRED=1 but the supervisor degraded to
            // fallback (LLM down, missing key, schema fail, all-hallucinated
            // commands), bootstrap.mjs status exits non-zero so automation
            // can detect the degradation rather than treating it as success.
            if (isSupervisorRequired(process.env) && escData.supervisor_verdict?.required_but_unavailable) {
              console.error("  ❌ PLANNER_SUPERVISOR_REQUIRED was set; supervisor returned a fallback verdict.");
              console.error("     Check PLANNER_DRIFT_LLM_API_KEY/MODEL/BASE_URL, network reachability, and provider status.");
              process.exit(2);
            }
          } catch {
            // Helper unavailable — emit a minimal banner so the event is still
            // visible. Preserves pre-refactor behaviour as a last-resort fallback.
            console.log(`\n  ⚠️  Advisor review recommended — ${advEsc.reason}`);
            if (advEsc.auto_launch_marker) console.log(`     ${advEsc.auto_launch_marker}`);
            console.log(`     Run /advisor to capture lessons and check codebase health.\n`);
          }
        }
      }
    }
  } catch { /* non-blocking — escalation_check unavailable or errored */ }
}

function cmdInstallHealth(jsonMode = false) {
  const health = inspectInstallHealth(cwd);
  if (jsonMode) {
    console.log(JSON.stringify(health, null, 2));
    process.exit(health.ok ? 0 : 1);
  }

  console.log("Planner Install Health");
  console.log();
  console.log(`  Project root: ${cwd}`);
  console.log(`  Canonical source: ${health.source_repo || "unknown"}`);
  console.log(`  Self-heal available: ${health.self_heal_available ? "YES" : "NO"}`);
  console.log(`  Needs repair: ${health.needs_repair ? "YES" : "NO"}`);
  console.log(`  Summary: ${health.summary?.description || "No summary available"}`);

  if (!health.ok) {
    console.log("  Diagnosis: planner install health could not be verified cleanly.");
    if (health.stderr) {
      console.log("  Detail: doctor command reported an error; inspect migrate.mjs doctor output.");
    }
    process.exit(1);
  }

  if (health.needs_repair) {
    console.log("  Next step: normal planner entrypoints will attempt self-heal automatically before they run.");
    console.log("  Manual fallback: node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade .");
  } else {
    console.log("  Next step: planner-managed files and setup look aligned.");
  }
}

function cmdClose(opts = {}) {
  const pointerPlanDirName = readPointer();
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
  const planDirName = target.planDirName;
  if (!planDirName) {
    if (!opts.silent) {
      console.error("ERROR: No active plan to close.");
      process.exit(1);
    }
    return;
  }

  // Update state.md with CLOSE transition before removing pointer
  let prevState = "UNKNOWN";
  try {
    const stateJson = readStateJson(join(plansDir, planDirName));
    const statePath = join(plansDir, planDirName, "state.md");
    const stateContent = readFileSync(statePath, "utf-8");
    prevState = stateJson?.state || stateContent.match(/^# Current State:\s*(.+)$/m)?.[1] || "UNKNOWN";

    // D-014: Block CLOSE from invalid state unless --force or --informational is passed.
    // Valid sources: VALIDATE, REFLECT (legacy), EXECUTE (post-reflect), CLOSE (idempotent re-close), UNKNOWN (best-effort).
    // --informational: allows closing from EXPLORE/PLAN when findings don't warrant execution
    // (e.g., audit-only plans, informational exploration). Still merges KB.
    const validCloseSources = ["VALIDATE", "REFLECT", "CLOSE", "UNKNOWN"];
    const prevStateNorm = prevState.trim().toUpperCase();
    if (!validCloseSources.includes(prevStateNorm) && prevStateNorm !== "EXECUTE") {
      if (opts.informational) {
        if (!opts.silent) {
          console.log(`  Informational close from state '${prevState}' — findings will be merged, no execution required.`);
        }
      } else if (!opts.silent && !opts.force) {
        console.error(`ERROR: Cannot close plan from state '${prevState}' — expected VALIDATE or EXECUTE.`);
        console.error(`  Protocol requires VALIDATE → CLOSE. Options:`);
        console.error(`    close --informational   Close as informational (merges findings/KB, no execution)`);
        console.error(`    close --force           Force close (use when plan is abandoned)`);
        process.exit(1);
      } else if (!opts.silent) {
        console.warn(`WARNING: Force-closing plan from state '${prevState}' — expected VALIDATE or EXECUTE.`);
      }
    }

    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const marker = opts.forceMarker ? ` ${opts.forceMarker}` : opts.informational ? " [INFORMATIONAL-CLOSE]" : "";
    const updated = stateContent
      .replace(/^# Current State:\s*.+$/m, "# Current State: CLOSE")
      .replace(/^## Last Transition:\s*.+$/m, `## Last Transition: ${prevState} → CLOSE (${timestamp})${marker}`)
      + `- ${prevState} → CLOSE (bootstrap close${marker})\n`;
    writeFileSync(statePath, updated);
  } catch (e) { debugLog("bootstrap", `state.md close update failed: ${e.message}`); }

  // Determinism: update state.json on close
  try {
    const stateJson = readStateJson(join(plansDir, planDirName));
    if (stateJson) {
      stateJson.state = "CLOSE";
      const marker = opts.forceMarker
        ? ` ${opts.forceMarker}`
        : opts.informational
          ? " [INFORMATIONAL-CLOSE]"
          : "";
      stateJson.transitions.push({
        from: prevState,
        to: "CLOSE",
        timestamp: nowISO(),
        gate_result: "SKIP",
        failure_codes: [],
        marker: marker.trim() || undefined,
        is_forced: opts.forceMarker ? true : undefined,
      });
      writeStateJson(join(plansDir, planDirName), stateJson);
    }
  } catch (e) { debugLog("bootstrap", `state.json close update failed: ${e.message}`); }

  // Merge per-plan findings/decisions to consolidated files before removing pointer
  try {
    ensureConsolidatedFiles();
    mergeToConsolidated(planDirName);
  } catch (err) {
    // Always report merge failures regardless of silent mode — losing plan state is critical.
    console.error(`WARNING: Merge to consolidated files failed: ${err.message}`);
    console.error(`  Per-plan files remain intact at plans/${planDirName}/`);
  }

  // --- Health delta hook (non-blocking) ---
  const __closeFilename = fileURLToPath(import.meta.url);
  const closeScriptDir = dirname(__closeFilename);
  const planDir = join(plansDir, planDirName);
  console.log(`\n── Running health delta check ──`);
  try {
    const healthScript = join(closeScriptDir, "project_health.mjs");
    const finalPath = join(planDir, "health_final.json");
    // Run scanner: exit 1 means FAILs found (JSON still written).
    const closeResult = spawnSync("node", [healthScript, "--json", "--out", finalPath], {
      encoding: "utf-8", timeout: 15000, cwd
    });
    if (closeResult.status !== 0 && closeResult.status !== 1) {
      throw Object.assign(new Error(closeResult.stderr || "health scan failed"), { status: closeResult.status });
    }
    const baselinePath = join(planDir, "health_baseline.json");
    if (existsSync(baselinePath) && existsSync(finalPath)) {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
      const final_ = JSON.parse(readFileSync(finalPath, "utf-8"));
      const newFails = final_.summary.fail - baseline.summary.fail;
      const resolvedWarns = baseline.summary.warn - final_.summary.warn;
      console.log(`  Baseline: ${baseline.summary.fail}F ${baseline.summary.warn}W ${baseline.summary.info}I`);
      console.log(`  Final:    ${final_.summary.fail}F ${final_.summary.warn}W ${final_.summary.info}I`);
      if (newFails > 0) {
        console.log(`  ❌ ${newFails} NEW failure(s) introduced — review before closing`);
      } else {
        console.log(`  ✅ No new failures.${resolvedWarns > 0 ? " " + resolvedWarns + " warning(s) resolved." : ""}`);
      }
      appendHealthHistory(planDirName, baseline, final_);
    }
  } catch (e) {
    console.log(`  ⚠️ Health delta check failed (non-blocking): ${e.message}`);
  }

  clearThreadPlanTarget(plansDir, { planDirName });
  if (pointerPlanDirName === planDirName) {
    try { unlinkSync(pointerFile); } catch { /* already removed — TOCTOU safe */ }
    refreshActivePlanAliasFor(null);
  } else {
    refreshActivePlanAliasFor(pointerPlanDirName);
  }

  if (!opts.silent) {
    console.log(`Closed plan: plans/${planDirName}`);
    if (pointerPlanDirName === planDirName) {
      console.log(`  Pointer plans/.current_plan removed.`);
    } else if (pointerPlanDirName) {
      console.log(`  Pointer preserved at plans/.current_plan → ${pointerPlanDirName}.`);
    }
    console.log(`  Plan directory preserved at plans/${planDirName}/`);
    console.log(`  Alias refreshed at ${ACTIVE_PLAN_ALIAS_LABEL}.`);
    console.log(`  Index refreshed in plans/INDEX.md; findings/decisions merged to plans/FINDINGS.md and plans/DECISIONS.md.`);
    console.log(`  Note: This is an administrative close. The protocol CLOSE state`);
    console.log(`  (summary.md, decision audit) should be completed by the agent first.`);
  } else {
    console.log(`  Closed previous plan: plans/${planDirName}`);
  }
}

function cmdList() {
  if (!existsSync(plansDir)) {
    console.log("No plans/ directory found.");
    process.exit(0);
  }

  const activeName = readPointer();
  const entries = readdirSync(plansDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("plan_"))
    .map((d) => d.name)
    .sort();

  if (entries.length === 0) {
    console.log("No plan directories found.");
    process.exit(0);
  }

  console.log(`Plan directories in plans/ (${entries.length} total):`);
  for (const name of entries) {
    const marker = name === activeName ? " ← active" : "";
    const { currentState, goal } = getPlanSnapshot(name);
    const goalOneLine = goal.split("\n")[0].slice(0, 60);
    console.log(`  ${name}  [${currentState}] ${goalOneLine}${marker}`);
  }
}

function cmdResetCircuitBreaker(gate) {
  if (!gate) {
    console.error("ERROR: reset-circuit-breaker requires a gate name. Example: node bootstrap.mjs reset-circuit-breaker execute-to-reflect");
    process.exit(1);
  }
  const { planDirName, planDir } = resolvePlanTarget(plansDir, { exitOnMissing: false });
  if (!planDirName || !planDir) {
    console.error("ERROR: No active plan. Cannot reset circuit breaker.");
    process.exit(1);
  }
  const stateJson = readStateJson(planDir);
  if (!stateJson) {
    console.error("ERROR: state.json not found for active plan.");
    process.exit(1);
  }
  if (!stateJson.circuit_breakers?.[gate]) {
    console.log(`Circuit breaker for '${gate}' is not set (total_fails = 0). Nothing to reset.`);
    process.exit(0);
  }
  const prevFails = stateJson.circuit_breakers[gate].total_fails;
  stateJson.circuit_breakers[gate] = { total_fails: 0 };
  writeStateJson(join(plansDir, planDirName), stateJson);
  console.log(`✅ Circuit breaker reset for '${gate}' (was ${prevFails} total fails → 0).`);

  const poisoned = findPoisonedGateHistories(stateJson.transitions || [], GATE_REGISTRY, {
    threshold: GATE_HISTORY_POISON_THRESHOLD,
  }).find((entry) => entry.gate === gate);
  if (poisoned) {
    console.log(`⚠️  '${gate}' is still history-poisoned: ${poisoned.consecutiveFails} consecutive FAIL entries remain in transition history.`);
    if (poisoned.failureCodes?.length > 0) {
      console.log(`   Repeated failure codes: ${poisoned.failureCodes.join(", ")}`);
    }
    console.log("   reset-circuit-breaker only clears the persistent total_fails counter.");
    console.log("   If the underlying issue is fixed, the supported recovery path is:");
    console.log(`    node ${process.argv[1]} recover-poison`);
    console.log("   Manual fallback:");
    console.log(`    node ${process.argv[1]} abandon`);
    console.log(`    node ${process.argv[1]} new "<same goal>"`);
  }
}

function cmdAbandon() {
  const { planDirName } = resolvePlanTarget(plansDir, { exitOnMissing: false });
  if (!planDirName) {
    console.error("ERROR: No active plan to abandon.");
    process.exit(1);
  }
  console.log(`Abandoning plan: plans/${planDirName}/`);
  console.log("  plans/INDEX.md will be refreshed, and findings/decisions will be preserved in plans/FINDINGS.md and plans/DECISIONS.md.");
  console.log("  Plan directory is kept — no work is deleted.");
  cmdClose({ force: true, forceMarker: "[ABANDONED]", silent: false });
  console.log("\n  ✓ Plan abandoned. Start fresh:");
  console.log(`    node ${process.argv[1]} new "<new goal>"`);
}

function cmdRecoverPoison() {
  const { planDirName: sourcePlanDirName, planDir: sourcePlanDir } = resolvePlanTarget(plansDir, { exitOnMissing: false });
  if (!sourcePlanDirName || !sourcePlanDir) {
    console.error("ERROR: No active plan to recover.");
    process.exit(1);
  }

  const sourceState = readStateJson(sourcePlanDir);
  if (!sourceState) {
    console.error("ERROR: state.json not found for active plan.");
    process.exit(1);
  }

  const poisoned = findPoisonedGateHistories(sourceState.transitions || [], GATE_REGISTRY, {
    threshold: GATE_HISTORY_POISON_THRESHOLD,
  });
  if (poisoned.length === 0) {
    console.error(`ERROR: Active plan '${sourcePlanDirName}' is not history-poisoned.`);
    console.error(`  Run: node ${process.argv[1]} fix-stuck`);
    process.exit(1);
  }

  const goal = sourceState.goal || extractGoalFromPlanContent(readPlanFile(sourcePlanDirName, "plan.md")) || "Recovered poisoned plan";

  console.log(`Recovering history-poisoned plan: plans/${sourcePlanDirName}/`);
  for (const entry of poisoned) {
    console.log(`  • ${formatPoisonedGateDetail(entry)}`);
  }
  console.log("  Source plan will be preserved and closed with [POISON-RECOVERED].");
  console.log("  A fresh successor plan will be created with sanitized carry-forward context.");

  cmdClose({ force: true, forceMarker: "[POISON-RECOVERED]", silent: true });
  const created = cmdNew(goal, { suppressOrphanWarning: true });
  const targetPlanDirName = created?.planDirName || readPointer();
  if (!targetPlanDirName) {
    console.error("ERROR: Poisoned source plan was closed, but no successor plan became active.");
    console.error(`  Source plan is preserved at plans/${sourcePlanDirName}/.`);
    process.exit(1);
  }

  const carriedArtifacts = carryRecoveredArtifacts(sourcePlanDirName, targetPlanDirName, poisoned);

  console.log(`\n  ✓ Recovery complete.`);
  console.log(`    Source plan:    plans/${sourcePlanDirName}/ (preserved, closed)`);
  console.log(`    Successor plan: plans/${targetPlanDirName}/`);
  console.log(`    Carried:        ${carriedArtifacts.length > 0 ? carriedArtifacts.join(", ") : "none"}`);
  console.log(`    Next:           node ${process.argv[1]} resume`);
}

function cmdFixStuck() {
  const STUCK_DAYS_THRESHOLD = 7;
  const STUCK_FAILS_THRESHOLD = 3;
  const jsonMode = process.argv.includes("--json");

  function finish(result, lines = []) {
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const line of lines) console.log(line);
  }

  // Check 1: Is there an active plan?
  const pointerPlanDirName = readPointer();
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
  const planDirName = target.planDirName;
  if (!planDirName) {
    refreshActivePlanAliasFor(null);
    finish({
      reason_code: "NO_ACTIVE_PLAN",
      status: "clear",
      blocked_by: [],
      auto_fixable: false,
      safe_fix_applied: false,
      recommended_command: null,
      recommended_mode: "none",
      proof_needed: [],
      related_failure_codes: [],
      plan_dir_name: null,
    }, [
      "✅ No active plan. Nothing to fix.",
    ]);
    return;
  }

  const planDir = join(plansDir, planDirName);

  // Check 2: Pointer exists but state.json shows CLOSE (stale pointer)
  const stateJson = readStateJson(planDir);
  if (!stateJson || stateJson.state === "CLOSE") {
    clearThreadPlanTarget(plansDir, { planDirName });
    if (pointerPlanDirName === planDirName) {
      try { unlinkSync(pointerFile); } catch { /* already gone */ }
      refreshActivePlanAliasFor(null);
    } else {
      refreshActivePlanAliasFor(pointerPlanDirName);
    }
    finish({
      reason_code: "STALE_POINTER",
      status: "auto_fixed",
      blocked_by: ["stale_pointer"],
      auto_fixable: true,
      safe_fix_applied: true,
      recommended_command: `node ${process.argv[1]} new "<goal>"`,
      recommended_mode: "start_fresh",
      proof_needed: [],
      related_failure_codes: [],
      plan_dir_name: planDirName,
    }, [
      "⚠️  Stale plan pointer detected.",
      `   plans/.current_plan → ${planDirName} (state: ${stateJson?.state ?? "unreadable"})`,
      "   Auto-fixing: clearing stale pointer...",
      `   ✓ Pointer cleared. Use 'bootstrap.mjs new \"<goal>\"' to start fresh.`,
    ]);
    return;
  }

  // Check 3: State hash mismatch (manual edit detected) — report only, do not auto-fix
  const integrity = validateStateIntegrity(stateJson);
  if (!integrity.intact) {
    const lastGate = stateJson.transitions?.slice(-1)?.[0];
    const gateMap = {
      PLAN: "explore-to-plan",
      EXECUTE: "plan-to-execute",
      REFLECT: "execute-to-reflect",
      VALIDATE: "reflect-to-validate",
      CLOSE: "validate-to-close",
    };
    const gateName = lastGate?.to ? gateMap[lastGate.to.toUpperCase()] : null;
    const recommendedCommand = gateName
      ? `node .agent/skills/iterative-planner/scripts/transition.mjs ${gateName}`
      : null;
    finish({
      reason_code: "STATE_HASH_MISMATCH",
      status: "blocked",
      blocked_by: ["state_integrity"],
      auto_fixable: false,
      safe_fix_applied: false,
      recommended_command: recommendedCommand,
      recommended_mode: "rerun_transition",
      proof_needed: ["Regenerate the signed state hash by re-running the most recent valid transition."],
      related_failure_codes: [],
      plan_dir_name: planDirName,
    }, [
      "⚠️  State hash mismatch detected.",
      `   Reason: ${integrity.reason}`,
      "   This may indicate a manual edit to state.json.",
      "   Fix: re-run the most recent transition to regenerate the hash:",
      ...(recommendedCommand ? [`    ${recommendedCommand}`] : []),
    ]);
    return;
  }

  // Check 4: History-poisoned gate tail (AV-19)
  const poisoned = findPoisonedGateHistories(stateJson.transitions || [], GATE_REGISTRY, {
    threshold: GATE_HISTORY_POISON_THRESHOLD,
  });
  if (poisoned.length > 0) {
    const relatedFailureCodes = [...new Set(poisoned.flatMap((entry) => entry.failureCodes || []).filter(Boolean))];
    finish({
      reason_code: "HISTORY_POISON",
      status: "blocked",
      blocked_by: poisoned.map((entry) => entry.gate),
      auto_fixable: false,
      safe_fix_applied: false,
      recommended_command: `node ${process.argv[1]} recover-poison`,
      recommended_mode: "recover_poison",
      proof_needed: ["Fix or consciously discard the stale failing path before reusing carried-forward work."],
      related_failure_codes: relatedFailureCodes,
      plan_dir_name: planDirName,
      details: poisoned.map((entry) => ({
        gate: entry.gate,
        consecutive_fails: entry.consecutiveFails,
        threshold: entry.threshold,
        last_blocked_attempt: entry.lastMatchingAttempt?.timestamp || null,
        failure_codes: entry.failureCodes || [],
      })),
    }, [
      ...poisoned.flatMap((entry) => ([
        `⚠️  History-poisoned plan detected: '${entry.gate}' has ${entry.consecutiveFails} consecutive FAIL transitions (threshold: ${entry.threshold}).`,
        ...(entry.lastMatchingAttempt?.timestamp ? [`   Last blocked attempt: ${entry.lastMatchingAttempt.timestamp}`] : []),
        ...(entry.failureCodes?.length > 0 ? [`   Repeated failure codes: ${entry.failureCodes.join(", ")}`] : []),
        "   This block comes from transition history, so reset-circuit-breaker will not clear it.",
        "   First fix the underlying issue. If the fails are now stale and you want to keep the work, recover by:",
        `    node ${process.argv[1]} recover-poison`,
        "   Manual fallback:",
        `    node ${process.argv[1]} abandon`,
        `    node ${process.argv[1]} new "<same goal>"`,
      ])),
    ]);
    return;
  }

  // Check 5: Circuit breaker tripped
  const breakers = stateJson.circuit_breakers || {};
  const tripped = Object.entries(breakers).filter(([, v]) => v.total_fails >= CIRCUIT_BREAKER_THRESHOLD);
  if (tripped.length > 0) {
    const primaryGate = tripped[0]?.[0] || "<gate>";
    finish({
      reason_code: "CIRCUIT_BREAKER",
      status: "blocked",
      blocked_by: tripped.map(([gate]) => gate),
      auto_fixable: false,
      safe_fix_applied: false,
      recommended_command: `node ${process.argv[1]} reset-circuit-breaker ${primaryGate}`,
      recommended_mode: "reset_circuit_breaker",
      proof_needed: ["Fix the underlying gate failure before resetting the persistent fail counter."],
      related_failure_codes: [],
      plan_dir_name: planDirName,
      details: tripped.map(([gate, value]) => ({
        gate,
        total_fails: value.total_fails || 0,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
      })),
    }, [
      ...tripped.flatMap(([gate, value]) => ([
        `⚠️  Circuit breaker tripped: '${gate}' has ${value.total_fails} total fails (threshold: ${CIRCUIT_BREAKER_THRESHOLD}).`,
        "   Fix the underlying issue, then reset:",
        `    node ${process.argv[1]} reset-circuit-breaker ${gate}`,
      ])),
    ]);
    return;
  }

  // Check 6: Age + fail heuristic — plan may be stuck
  const lastTs = stateJson.transitions?.slice(-1)?.[0]?.timestamp;
  const ageDays = lastTs ? Math.floor((Date.now() - new Date(lastTs).getTime()) / (86400 * 1000)) : 0;
  const totalFails = Object.values(stateJson.circuit_breakers || {}).reduce((s, v) => s + (v.total_fails || 0), 0);
  if (ageDays >= STUCK_DAYS_THRESHOLD && totalFails > STUCK_FAILS_THRESHOLD) {
    finish({
      reason_code: "STUCK_HEURISTIC",
      status: "blocked",
      blocked_by: ["stale_progress"],
      auto_fixable: false,
      safe_fix_applied: false,
      recommended_command: `node ${process.argv[1]} abandon`,
      recommended_mode: "abandon_then_lightweight",
      proof_needed: ["Decide whether the existing goal is still relevant before continuing work."],
      related_failure_codes: [],
      plan_dir_name: planDirName,
      details: {
        state: stateJson.state,
        age_days: ageDays,
        total_gate_fails: totalFails,
      },
    }, [
      "⚠️  Plan may be stuck.",
      `   State '${stateJson.state}' unchanged for ${ageDays} day(s), ${totalFails} total gate fail(s).`,
      "   If this plan is no longer relevant, abandon it (findings are preserved):",
      `    node ${process.argv[1]} abandon`,
    ]);
    return;
  }

  finish({
    reason_code: "CLEAR",
    status: "clear",
    blocked_by: [],
    auto_fixable: false,
    safe_fix_applied: false,
    recommended_command: null,
    recommended_mode: "none",
    proof_needed: [],
    related_failure_codes: [],
    plan_dir_name: planDirName,
    details: {
      state: stateJson?.state ?? "unknown",
    },
  }, [
    `✅ No stuck conditions detected for plan: ${planDirName}`,
    `   State: ${stateJson?.state ?? "unknown"}`,
  ]);
}

function cmdStoryReview(planDirArg) {
  // Resolve plan directory name
  const planDirName = planDirArg
    ? planDirArg.replace(/^plans\//, "").replace(/\/$/, "")
    : readPointer();
  if (!planDirName) {
    console.error("ERROR: No plan directory specified and no active plan. Pass a plan directory or set .current_plan.");
    process.exit(1);
  }
  const planDir = join(plansDir, planDirName);

  // Read plan goal from state.json
  const stateJson = readStateJson(planDir);
  const goal = stateJson?.goal || "(no goal found in state.json)";

  // Read the readable findings surface (syncing from findings_ledger.json when populated)
  const findings = (readFindingsMarkdown(planDir) || "(findings.md not found)").slice(0, 3000);

  // Read story registry (optional — may not exist in all projects)
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  let storiesText;
  if (existsSync(registryPath)) {
    try {
      const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
      const entries = (reg.stories || []).map(s => `  US-${s.id} [${s.priority || "?"}]: ${s.title}`);
      storiesText = entries.length > 0 ? entries.join("\n") : "(story_registry.json has no stories)";
    } catch { storiesText = "(story_registry.json unreadable)"; }
  } else {
    storiesText = "(no story_registry.json found — review goal alignment only)";
  }

  // Consume nonce (reads + deletes the one-time nonce file)
  const noncePayload = consumeOneTimeNonce(planDirName);
  const nonceText = noncePayload?.approval_nonce || null;

  // Print review context
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  STORY REVIEW — v3.9.0                               ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\nPlan:  ${planDirName}`);
  console.log(`Goal:  ${goal}\n`);
  console.log("── User Stories (from story_registry.json) ─────────────────────────────");
  console.log(storiesText);
  console.log("\n── Findings (first 3000 chars) ─────────────────────────────────────────");
  console.log(findings);
  console.log("\n── Review Instructions ──────────────────────────────────────────────────");
  console.log("  Follow .agent/workflows/story-review-agent.md for the full review process.");
  console.log("  Short form:");
  console.log("    1. Do the findings address the plan goal?");
  console.log("    2. Are 2+ relevant user stories addressed (by keyword/theme) in findings?");
  console.log("    3. Are any HIGH priority stories that should be impacted NOT mentioned?");

  if (nonceText) {
    console.log("\n── Approval Decision ────────────────────────────────────────────────────");
    console.log("  Coverage PASSES → write this to decisions.md:");
    console.log(`    [APPROVED:${nonceText}]`);
    console.log("  Coverage FAILS → write this to decisions.md:");
    console.log(`    [REJECTED:${nonceText}] Reason: <describe coverage gaps>`);
    console.log("\n  ⚠️  The nonce has been consumed (one-time-read). If this session is");
    console.log("     lost before writing, re-run transition.mjs explore-to-plan to get a new nonce.");
  } else {
    console.log("\n  ⚠️  No nonce found for this plan.");
    console.log("     Ensure transition.mjs explore-to-plan ran in multi-agent mode first.");
    console.log("     Or set approval.mode: 'auto' in determinism.json to skip the ceremony.");
  }
}

function printUsage() {
  console.log(`Usage: node bootstrap.mjs <command> [options]

Commands:
  new "goal"                        Create a new plan directory
  new --force "goal"                Close active plan and create a new one
  new --parallel "goal"             Create a new plan without replacing the current pointer
  resume                            Output current plan state for re-entry
  status                            One-line state summary
  close                             Close active plan (preserves directory; blocks if not in VALIDATE/EXECUTE)
  close --informational             Close from any state as informational (merges findings/KB, no execution)
  close --force                     Close active plan even from non-standard state
  list                              Show all plan directories (active and closed)
  reset-circuit-breaker <gate>      Reset persistent failure counter for a gate (e.g. execute-to-reflect)
  abandon                           Abandon active plan — merges findings/decisions, clears pointer (work preserved)
  recover-poison                    Close a history-poisoned plan, create a successor, and carry forward sanitized context
  fix-stuck [--json]                Diagnose stuck plans (stale pointer, history poison, circuit breaker, hash mismatch)
  install-health [--json]           Diagnose planner install health and repairability for this project
  story-review [plan-dir]           Print story coverage review context + nonce for multi-agent approval

Backward-compatible:
  node bootstrap.mjs "goal"   Same as: node bootstrap.mjs new "goal"`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const subcommands = new Set(["new", "resume", "status", "close", "list", "help", "reset-circuit-breaker", "abandon", "recover-poison", "fix-stuck", "install-health", "story-review", "triage"]);

if (args.length === 0) {
  printUsage();
  process.exit(0);
}

const cmd = args[0];

if (!subcommands.has(cmd)) {
  if (cmd.startsWith("-")) {
    console.error(`ERROR: Unknown flag "${cmd}". Use "help" for usage.`);
    process.exit(1);
  }
  // Backward compat: treat args as goal for `new`
  cmdNew(args.join(" ") || "No goal specified");
} else if (cmd === "new") {
  const force = args.includes("--force");
  const parallel = args.includes("--parallel");
  const goalArgs = args.slice(1).filter((a) => a !== "--force" && a !== "--parallel");
  const goal = goalArgs.join(" ") || "No goal specified";
  cmdNew(goal, { force, parallel });
} else if (cmd === "resume") {
  cmdResume();
} else if (cmd === "status") {
  await cmdStatus();
} else if (cmd === "close") {
  const closeForce = args.includes("--force");
  const closeInformational = args.includes("--informational");
  cmdClose({ force: closeForce, informational: closeInformational });
} else if (cmd === "list") {
  cmdList();
} else if (cmd === "reset-circuit-breaker") {
  cmdResetCircuitBreaker(args[1]);
} else if (cmd === "abandon") {
  cmdAbandon();
} else if (cmd === "recover-poison") {
  cmdRecoverPoison();
} else if (cmd === "fix-stuck") {
  cmdFixStuck();
} else if (cmd === "install-health") {
  cmdInstallHealth(args.includes("--json"));
} else if (cmd === "story-review") {
  cmdStoryReview(args[1]);
} else if (cmd === "triage") {
  // v7.4.4: read-only triage preview. Lets agents check whether a goal is
  // worth opening a plan for BEFORE committing to one. No filesystem writes,
  // no plan dir, no state.json. Just the recommendation.
  const jsonMode = args.includes("--json");
  const goalArgs = args.slice(1).filter((a) => a !== "--json");
  const goal = goalArgs.join(" ");
  if (!goal.trim()) {
    console.error("Usage: bootstrap.mjs triage \"<goal>\" [--json]");
    process.exit(2);
  }
  const triage = computeTriage({ goalText: goal });
  const personaAdaptation = inferPersonaAdaptation(cwd);
  if (jsonMode) {
    console.log(JSON.stringify({ goal, ...triage, persona_adaptation: personaAdaptation }, null, 2));
  } else {
    console.log(`Goal: ${goal}`);
    console.log(renderTriage(triage, { mode: "verbose" }));
    const seriousPlannerPath = triage.recommended_path === "standard_planner" || triage.recommended_path === "full_planner";
    if (shouldWarnPersonaAdaptation(personaAdaptation, { serious: seriousPlannerPath, seriousOnly: true })) {
      console.log();
      console.log(renderPersonaAdaptationWarning(personaAdaptation));
    }
  }
} else if (cmd === "help") {
  printUsage();
}
