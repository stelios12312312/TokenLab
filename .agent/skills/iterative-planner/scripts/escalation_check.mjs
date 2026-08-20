#!/usr/bin/env node
// Escalation Check — deterministic decision engine for /safe-change-power
//
// Usage:
//   node escalation_check.mjs              Run all checks, output recommendations
//   node escalation_check.mjs --json       Output as JSON (machine-readable)
//   node escalation_check.mjs execute-required [--json] [--synthetic <label>]
//                                           Run REQUIRED executable audits and record coverage
//   node escalation_check.mjs log <type>   Record that an audit was run (red-team|regression|retro|user-story)
//   node escalation_check.mjs log-workflow </workflow> <recommended|launched|completed> [source_workflow]
//   node escalation_check.mjs log-recommendation </workflow> [source_workflow]
//   node escalation_check.mjs history      Show audit log
//
// The script examines:
//   1. Size of the just-completed change (files, lines, abstractions)
//   2. Turbulence during execution (RE-PLANs, leash hits, skips)
//   3. Time/commits since last audit of each type
//   4. Whether shared/core modules were touched
//
// Output: a list of escalation recommendations with severity (REQUIRED / RECOMMENDED / OPTIONAL)

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, relative, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { emitJson } from "./lib/emit_json.mjs";

// Validate that a value is a safe git commit hash (7–40 hex chars).
function safeCommitHash(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

function parseCountOrFallback(value, fallback = 999) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function formatCommitCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}
import { debugLog, detectPlannerDogfoodIncident, extractFilesToModify, matchesBasename, readFile } from "./lib/plan_utils.mjs";
import { inferPersonaAdaptation } from "./lib/persona_adaptation.mjs";
import { getEscalationThresholds, nowISO } from "./lib/determinism.mjs";
import {
  TRACKED_WORKFLOWS,
  normalizeWorkflowEventType,
  normalizeWorkflowId,
  summarizeWorkflowIntelligence,
} from "./lib/workflow_intelligence.mjs";

const cwd = process.cwd();
const plansDir = join(cwd, "plans");
const auditLogPath = join(plansDir, "audit_log.json");
const WORKFLOW_AUTORUN_ADVISOR = "[WORKFLOW_AUTORUN:/advisor]";
const ESCALATION_ACTIONS = Object.freeze({
  "red-team-audit": Object.freeze({
    workflow: "/red-team-audit",
    audit_type: "red-team",
    auto_launch: false,
  }),
  "regression-audit": Object.freeze({
    workflow: "/regression-audit",
    audit_type: "regression",
    auto_launch: false,
  }),
  "retro": Object.freeze({
    workflow: "/retro",
    audit_type: "retro",
    auto_launch: false,
  }),
  "user-story-audit": Object.freeze({
    workflow: "/red-team-user-story-audit",
    audit_type: "user-story",
    auto_launch: false,
  }),
  "advisor-review": Object.freeze({
    workflow: "/advisor",
    audit_type: "advisor",
    auto_launch: true,
    auto_launch_marker: WORKFLOW_AUTORUN_ADVISOR,
  }),
  "ontology-rectification": Object.freeze({
    workflow: "/ontology",
    audit_type: "ontology",
    auto_launch: false,
  }),
});

function enrichEscalation(entry) {
  const action = ESCALATION_ACTIONS[entry?.type] || null;
  if (!action) return entry;
  const autoLaunch = typeof entry?.auto_launch === "boolean" ? entry.auto_launch : action.auto_launch;
  const autoLaunchMarker = autoLaunch
    ? (typeof entry?.auto_launch_marker === "string" ? entry.auto_launch_marker : action.auto_launch_marker)
    : null;
  return {
    ...entry,
    workflow: action.workflow,
    audit_type: action.audit_type,
    auto_launch: autoLaunch,
    ...(autoLaunchMarker ? { auto_launch_marker: autoLaunchMarker } : {}),
  };
}

// ---------------------------------------------------------------------------
// Audit Log Management
// ---------------------------------------------------------------------------

function readAuditLog() {
  try {
    return JSON.parse(readFileSync(auditLogPath, "utf-8"));
  } catch (e) {
    debugLog("readAuditLog", e.message);
    return { audits: [] };
  }
}

function writeAuditLog(log) {
  mkdirSync(dirname(auditLogPath), { recursive: true });
  // D-013: Write atomically via tmp file + rename to prevent corrupt JSON on interrupt.
  const tmpPath = `${auditLogPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(log, null, 2) + "\n");
  renameSync(tmpPath, auditLogPath);
}

function resolveCurrentCommitHash() {
  try {
    const revProc = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8", cwd, timeout: 10000 });
    if (revProc.status === 0) return (revProc.stdout || "").trim();
  } catch (e) {
    debugLog("escalation", `git rev-parse failed: ${e.message}`);
  }
  return "unknown";
}

function gitOutput(args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 10000 });
  if (proc.status !== 0) return null;
  return String(proc.stdout || "").trim();
}

function gitRawOutput(args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 10000 });
  if (proc.status !== 0) return null;
  return String(proc.stdout || "").replace(/\r?\n$/, "");
}

function parseNumstat(text) {
  const files = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of String(text || "").split("\n")) {
    const match = line.trim().match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) continue;
    const added = match[1] === "-" ? 0 : Number.parseInt(match[1], 10) || 0;
    const removed = match[2] === "-" ? 0 : Number.parseInt(match[2], 10) || 0;
    const file = match[3].trim();
    files.push({ file, added, removed });
    linesAdded += added;
    linesRemoved += removed;
  }
  return { files, linesAdded, linesRemoved };
}

function parsePorcelainStatus(text) {
  const entries = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim() || "modified";
    let file = line.slice(3).trim();
    if (file.includes(" -> ")) file = file.split(" -> ").pop().trim();
    if (file) entries.push({ status, file });
  }
  return entries;
}

function currentChangedFiles() {
  return parsePorcelainStatus(gitRawOutput(["status", "--porcelain=v1", "--untracked-files=all"]) || "")
    .filter((entry) => !ignoreCoveragePath(entry.file))
    .map((entry) => entry.file)
    .sort();
}

function changedOntologyFiles() {
  return currentChangedFiles().filter((file) => {
    const normalized = String(file || "").replace(/\\/g, "/");
    return normalized.startsWith(".agent/ontology/")
      || normalized.startsWith(".agent/skills/iterative-planner/prolog/")
      || normalized === ".agent/skills/iterative-planner/prolog/invariants.pl"
      || normalized === ".agent/skills/iterative-planner/prolog/transitions.pl";
  });
}

function ignoreCoveragePath(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  if (normalized === "plans/audit_log.json" || normalized === "plans/.current_plan") return true;
  if (normalized === ".agent/http_permissions.yaml") return true;
  if (normalized.startsWith("reports/telemetry_capture/")) return true;
  if (normalized.startsWith("reports/workflow_intelligence/")) return true;
  if (/^plans\/plan_[^/]+\/(?:state\.json|state\.md|ontology_facts\.pl|metrics\.json|health_final\.json|health_report\.md|persona_findings\.json|executed_test_gates\.json)$/.test(normalized)) return true;
  if (/^plans\/plan_[^/]+\/artifacts\/(?:\.invariant_advisories\.json|\.repair_surface_[^/]+\.json|decision_log\.jsonl)$/.test(normalized)) return true;
  if (/^plans\/plan_[^/]+\/artifacts\/prolog\/[^/]+\.json$/.test(normalized)) return true;
  return false;
}

let copiedPlannerInstallCache = null;

function isCopiedPlannerInstall() {
  if (copiedPlannerInstallCache !== null) return copiedPlannerInstallCache;
  copiedPlannerInstallCache = false;
  try {
    const registryPath = join(cwd, ".agent", "skills", "iterative-planner", "config", ".project_registry.json");
    const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
    const sourceProjectPath = typeof parsed?.source_project_path === "string" ? parsed.source_project_path.trim() : "";
    copiedPlannerInstallCache = Boolean(sourceProjectPath) && resolve(sourceProjectPath) !== resolve(cwd);
  } catch {
    copiedPlannerInstallCache = false;
  }
  return copiedPlannerInstallCache;
}

function isCopiedPlannerInternalPath(file) {
  const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return isCopiedPlannerInstall() && normalized.startsWith(".agent/skills/iterative-planner/");
}

function allRegistryStories(registry) {
  return [
    ...(Array.isArray(registry?.stories) ? registry.stories : []),
    ...(Array.isArray(registry?.infrastructure_stories) ? registry.infrastructure_stories : []),
  ];
}

function storyRefs(story) {
  return [
    ...(story?.code_refs || []),
    ...(story?.test_refs || []),
    ...(story?.validation_refs || []),
    ...(story?.doc_refs || []),
  ];
}

function refMatchesChangedFile(file, ref) {
  const normalizedFile = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const refFile = String(ref || "").split(":")[0].replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedFile || !refFile) return false;
  return refFile === normalizedFile
    || normalizedFile.endsWith("/" + refFile)
    || refFile.endsWith("/" + normalizedFile);
}

function countLines(value) {
  if (!value) return 0;
  return String(value).split(/\r\n|\r|\n/).length;
}

function hashWorktreeFile(file) {
  try {
    const fullPath = join(cwd, file);
    const stat = statSync(fullPath);
    if (!stat.isFile()) return { file, kind: "non_file", size: stat.size };
    if (stat.size > 1_048_576) {
      return { file, kind: "large_file", size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs) };
    }
    const content = readFileSync(fullPath);
    return {
      file,
      kind: "file",
      size: stat.size,
      sha256: createHash("sha256").update(content).digest("hex"),
      line_count: countLines(content.toString("utf-8")),
    };
  } catch {
    return { file, kind: "missing" };
  }
}

function computeCommitCoverageFingerprint(commitish = "HEAD", worktreeDirtyOverride = null) {
  const commit = safeCommitHash(gitOutput(["rev-parse", commitish])) || null;
  if (!commit) {
    return { covers_commit: null, covers_worktree: false, worktree_dirty: false, worktree_fingerprint: null, changed_file_count: 0, lines_added: 0, lines_removed: 0, line_delta: 0, changed_files: [], change_fingerprint: null };
  }
  const parsed = parseNumstat(gitOutput(["show", "--format=", "--numstat", "--find-renames", commit]) || "");
  const fingerprintInput = JSON.stringify({
    commit,
    files: parsed.files.map((entry) => [entry.file, entry.added, entry.removed]).sort((a, b) => a[0].localeCompare(b[0])),
  });
  return {
    covers_commit: commit,
    covers_worktree: false,
    worktree_dirty: worktreeDirtyOverride ?? parsePorcelainStatus(gitRawOutput(["status", "--porcelain=v1", "--untracked-files=all"]) || "").some((entry) => !ignoreCoveragePath(entry.file)),
    worktree_fingerprint: null,
    changed_file_count: parsed.files.length,
    lines_added: parsed.linesAdded,
    lines_removed: parsed.linesRemoved,
    line_delta: parsed.linesAdded - parsed.linesRemoved,
    changed_files: parsed.files.map((entry) => entry.file).sort(),
    change_fingerprint: createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 32),
  };
}

function computeWorktreeCoverageFingerprint() {
  const commit = safeCommitHash(resolveCurrentCommitHash());
  const statusEntries = parsePorcelainStatus(gitRawOutput(["status", "--porcelain=v1", "--untracked-files=all"]) || "")
    .filter((entry) => !ignoreCoveragePath(entry.file));
  const changedFiles = [...new Set(statusEntries.map((entry) => entry.file))].sort();
  if (changedFiles.length === 0) {
    const headCoverage = computeCommitCoverageFingerprint("HEAD", false);
    return {
      ...headCoverage,
      covers_worktree: true,
      worktree_dirty: false,
      worktree_fingerprint: headCoverage.change_fingerprint,
    };
  }
  const trackedDiffRaw = parseNumstat(gitOutput(["diff", "--numstat", "--find-renames", "HEAD", "--"]) || "");
  const trackedFiles = trackedDiffRaw.files.filter((entry) => !ignoreCoveragePath(entry.file));
  const untrackedFiles = statusEntries.filter((entry) => entry.status === "??").map((entry) => entry.file).sort();
  const untrackedDigests = untrackedFiles.map(hashWorktreeFile);
  const untrackedLines = untrackedDigests.reduce((sum, entry) => sum + (entry.line_count || 0), 0);
  const fingerprintInput = JSON.stringify({
    commit,
    dirty_files: changedFiles,
    tracked_diff: trackedFiles.map((entry) => [entry.file, entry.added, entry.removed]).sort((a, b) => a[0].localeCompare(b[0])),
    untracked: untrackedDigests,
  });
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 32);
  const trackedAdded = trackedFiles.reduce((sum, entry) => sum + entry.added, 0);
  const trackedRemoved = trackedFiles.reduce((sum, entry) => sum + entry.removed, 0);
  return {
    covers_commit: commit,
    covers_worktree: true,
    worktree_dirty: true,
    worktree_fingerprint: fingerprint,
    changed_file_count: changedFiles.length,
    lines_added: trackedAdded + untrackedLines,
    lines_removed: trackedRemoved,
    line_delta: trackedAdded + untrackedLines - trackedRemoved,
    changed_files: changedFiles,
    change_fingerprint: fingerprint,
  };
}

function computeCurrentCoverageFingerprint() {
  const worktreeCoverage = computeWorktreeCoverageFingerprint();
  return worktreeCoverage.worktree_dirty ? worktreeCoverage : computeCommitCoverageFingerprint("HEAD", false);
}

function auditLogCoversCurrent(auditType, log = readAuditLog()) {
  const coverage = computeCurrentCoverageFingerprint();
  const headCoverage = coverage.worktree_dirty ? computeCommitCoverageFingerprint("HEAD", false) : coverage;
  const matching = (Array.isArray(log?.audits) ? log.audits : [])
    .filter((entry) => entry?.type === auditType)
    .filter((entry) => coverage.worktree_dirty
      ? (entry.covers_worktree === true && entry.worktree_fingerprint === coverage.worktree_fingerprint)
        || (entry.coverage_scope === "head" && entry.covers_commit === headCoverage.covers_commit
          && entry.change_fingerprint === headCoverage.change_fingerprint)
      : entry.covers_commit === coverage.covers_commit && entry.change_fingerprint === coverage.change_fingerprint)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0] || null;
  return { covered: Boolean(matching), coverage, matching_audit: matching };
}

function resolvePlanId() {
  try {
    const pointerFile = join(plansDir, ".current_plan");
    const active = readFileSync(pointerFile, "utf-8").trim();
    if (active) return active;
  } catch {
    // Best-effort fallback below.
  }

  try {
    const dirs = readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return dirs[0] || null;
  } catch {
    return null;
  }
}

function readActivePlanState() {
  try {
    const pointerFile = join(plansDir, ".current_plan");
    const active = readFileSync(pointerFile, "utf-8").trim();
    if (!active) return null;
    const parsed = JSON.parse(readFileSync(join(plansDir, active, "state.json"), "utf-8"));
    return typeof parsed?.state === "string" ? parsed.state.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

function readActivePlanOntologyFacts() {
  try {
    const pointerFile = join(plansDir, ".current_plan");
    if (!existsSync(pointerFile)) return "";
    const active = readFileSync(pointerFile, "utf-8").trim();
    if (!active) return "";
    const factsPath = join(plansDir, active, "ontology_facts.pl");
    return existsSync(factsPath) ? readFileSync(factsPath, "utf-8") : "";
  } catch {
    return "";
  }
}

function collectFactValues(text, regex, groupIndex = 1) {
  const values = new Set();
  for (const match of String(text || "").matchAll(regex)) {
    const value = String(match[groupIndex] || "").trim();
    if (value) values.add(value);
  }
  return [...values].sort();
}

function auditPerspectiveBlindSpot() {
  const facts = readActivePlanOntologyFacts();
  if (!facts) return null;
  const known = collectFactValues(facts, /known_perspective\(\s*['"]?([^'")]+)['"]?\s*\)\s*\./g, 1);
  const covered = collectFactValues(facts, /audit_perspective\(\s*[^,]+,\s*['"]?([^'")]+)['"]?\s*\)\s*\./g, 1);
  if (known.length === 0 || covered.length === 0) return null;
  const coveredSet = new Set(covered);
  const missing = known.filter((entry) => !coveredSet.has(entry));
  if (new Set(covered).size >= 2 && missing.length === 0) return null;
  return {
    known,
    covered,
    missing,
  };
}

function highPriorityStoryGaps(registry) {
  const stories = allRegistryStories(registry);
  return stories
    .filter((story) => String(story?.priority || "").toUpperCase() === "HIGH")
    .filter((story) => {
      const status = String(story?.status || "").toUpperCase();
      if (status === "FULLY_COVERED" || status === "IMPLEMENTED" || status === "CLOSED" || status === "RETIRED") return false;
      return storyRefs(story).length === 0 || status === "NOT_IMPLEMENTED" || status === "MISSING" || status === "PARTIAL";
    })
    .map((story) => String(story?.id || "").trim())
    .filter(Boolean)
    .sort();
}

function suppressAdvisorAutorunForActiveCloseout(trigger) {
  if (trigger !== "significant-change") return false;
  const state = readActivePlanState();
  return state === "VALIDATE" || state === "CLOSE";
}

function appendWorkflowEvent(log, { workflow, event, sourceWorkflow = null, commitHash = null, planId = null }) {
  if (!Array.isArray(log.workflow_events)) log.workflow_events = [];
  log.workflow_events.push({
    workflow,
    event,
    timestamp: nowISO(),
    commit: commitHash || resolveCurrentCommitHash(),
    plan_id: planId || resolvePlanId(),
    source_workflow: sourceWorkflow || null,
  });
}

function logAudit(type, opts = {}) {
  const log = readAuditLog();
  const commitHash = resolveCurrentCommitHash();
  const coverageTarget = String(opts.coverageTarget || "").toUpperCase();
  const coverage = coverageTarget === "HEAD"
    ? computeCommitCoverageFingerprint("HEAD", false)
    : computeCurrentCoverageFingerprint();

  log.audits.push({
    type,
    timestamp: new Date().toISOString(),
    commit: commitHash,
    covers_commit: coverage.covers_commit,
    covers_worktree: coverage.covers_worktree === true,
    worktree_dirty: coverage.worktree_dirty === true,
    worktree_fingerprint: coverage.worktree_fingerprint,
    changed_file_count: coverage.changed_file_count,
    lines_added: coverage.lines_added,
    lines_removed: coverage.lines_removed,
    line_delta: coverage.line_delta,
    change_fingerprint: coverage.change_fingerprint,
    changed_files: coverage.changed_files,
    coverage_scope: coverageTarget === "HEAD" ? "head" : "current",
    ...(opts.extra && typeof opts.extra === "object" ? opts.extra : {}),
  });
  if (type === "advisor") {
    appendWorkflowEvent(log, {
      workflow: "/advisor",
      event: "completed",
      commitHash,
    });
  }
  writeAuditLog(log);
  const covered = coverage.covers_worktree && coverage.worktree_fingerprint
    ? ` covering worktree ${coverage.worktree_fingerprint.slice(0, 8)}`
    : coverage.covers_commit
      ? ` covering ${coverage.covers_commit.slice(0, 8)}`
      : "";
  if (!opts.silent) {
    console.log(`✅ Recorded ${type} audit at ${commitHash.slice(0, 8)}${covered}`);
  }
}

function logWorkflowEvent(workflow, event, sourceWorkflow = null) {
  const normalizedWorkflow = normalizeWorkflowId(workflow);
  const normalizedEvent = normalizeWorkflowEventType(event);
  const normalizedSource = sourceWorkflow ? normalizeWorkflowId(sourceWorkflow) : null;

  if (!normalizedWorkflow) {
    console.error(`ERROR: Invalid workflow "${workflow}". Valid: ${TRACKED_WORKFLOWS.join(", ")}`);
    process.exit(1);
  }
  if (!normalizedEvent) {
    console.error("ERROR: Invalid workflow event. Valid: recommended, launched, completed");
    process.exit(1);
  }
  if (sourceWorkflow && !normalizedSource) {
    console.error(`ERROR: Invalid source workflow "${sourceWorkflow}". Valid: ${TRACKED_WORKFLOWS.join(", ")}`);
    process.exit(1);
  }

  const log = readAuditLog();
  appendWorkflowEvent(log, {
    workflow: normalizedWorkflow,
    event: normalizedEvent,
    sourceWorkflow: normalizedSource,
  });
  writeAuditLog(log);
  console.log(`✅ Recorded ${normalizedEvent} workflow event for ${normalizedWorkflow}`);
}

function logWorkflowRecommendation(workflow, sourceWorkflow = "/advisor") {
  logWorkflowEvent(workflow, "recommended", sourceWorkflow);
}

function showHistory() {
  const log = readAuditLog();
  const audits = Array.isArray(log.audits) ? log.audits : [];
  const workflowEvents = Array.isArray(log.workflow_events) ? log.workflow_events : [];
  if (audits.length === 0 && workflowEvents.length === 0) {
    console.log("No audits recorded yet.");
    return;
  }
  if (audits.length > 0) {
    console.log(`Audit history (${audits.length} entries):\n`);
    console.log("  Type              | Date                | Commit");
    console.log("  ------------------|---------------------|--------");
    for (const a of audits.slice(-20)) {
      const date = String(a.timestamp || "").split("T")[0] || "unknown";
      console.log(`  ${String(a.type || "unknown").padEnd(18)}| ${date}            | ${String(a.commit || "unknown").slice(0, 8)}`);
    }
  }
  if (workflowEvents.length > 0) {
    console.log(`\nWorkflow history (${workflowEvents.length} entries):\n`);
    console.log("  Workflow          | Event       | Source        | Date");
    console.log("  ------------------|-------------|---------------|------------");
    for (const event of workflowEvents.slice(-20)) {
      const workflow = String(event.workflow || "unknown").padEnd(18);
      const eventType = String(event.event || "unknown").padEnd(11);
      const source = String(event.source_workflow || "-").padEnd(15);
      const date = String(event.timestamp || "").split("T")[0] || "unknown";
      console.log(`  ${workflow}| ${eventType}| ${source}| ${date}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Change Size Analysis
// ---------------------------------------------------------------------------

function getRecentChangeStats() {
  const stats = { filesChanged: 0, linesAdded: 0, linesRemoved: 0, newFiles: 0 };
  try {
    // Get diff stats from last commit
    const diffProc = spawnSync("git", ["diff", "HEAD~1", "--stat", "--numstat"], {
      encoding: "utf-8", cwd, timeout: 10000
    });
    const diffStat = (diffProc.stdout || "").trim();

    if (diffStat) {
      const lines = diffStat.split("\n").filter(l => l.trim());
      for (const line of lines) {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) {
          stats.filesChanged++;
          stats.linesAdded += parseInt(match[1]) || 0;
          stats.linesRemoved += parseInt(match[2]) || 0;
        }
      }
    }

    // Check for new files
    const newFilesProc = spawnSync("git", ["diff", "HEAD~1", "--diff-filter=A", "--name-only"], {
      encoding: "utf-8", cwd, timeout: 10000
    });
    const newFiles = (newFilesProc.stdout || "").trim();
    if (newFiles) {
      stats.newFiles = newFiles.split("\n").filter(l => l.trim()).length;
    }
  } catch (e) { debugLog("getChangeStats", e.message); /* not a git repo or no history */ }
  return stats;
}

function touchesSharedModules() {
  // RP-005: Use path-segment matching instead of substring matching to avoid false positives
  // (e.g. "my-plugin-library/main.ts" should NOT match "lib/")
  const dirPatterns = new Set([
    "lib", "shared", "core", "utils", "common", "base",
    "config", "middleware", "hooks", "plugins",
  ]);
  const filePatterns = new Set([
    "__init__.py", "index.ts", "index.js", "index.mjs",
    "package.json", "requirements.txt", "Cargo.toml",
  ]);

  try {
    const changedProc = spawnSync("git", ["diff", "HEAD~1", "--name-only"], {
      encoding: "utf-8", cwd, timeout: 10000
    });
    const changedFiles = (changedProc.stdout || "").trim();
    if (!changedFiles) return { touches: false, files: [] };

    const files = changedFiles.split("\n")
      .filter(l => l.trim())
      .filter(file => !isCopiedPlannerInternalPath(file));
    const sharedFiles = files.filter(f => {
      const segments = f.replace(/\\/g, "/").split("/");
      const basename = segments[segments.length - 1];
      return segments.some(seg => dirPatterns.has(seg)) || filePatterns.has(basename);
    });
    return { touches: sharedFiles.length > 0, files: sharedFiles };
  } catch (e) {
    debugLog("touchesSharedModules", e.message);
    return { touches: false, files: [] };
  }
}

// ---------------------------------------------------------------------------
// Plan Turbulence Analysis
// ---------------------------------------------------------------------------

function getPlanTurbulence() {
  const turbulence = { replans: 0, leashHits: 0, driftWarnings: 0, iterations: 0 };

  try {
    const pointerFile = join(plansDir, ".current_plan");
    let planDirName;
    try {
      planDirName = readFileSync(pointerFile, "utf-8").trim();
    } catch {
      // No active plan — check most recent closed plan
      const dirs = readdirSync(plansDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith("plan_"))
        .map(d => d.name)
        .sort()
        .reverse();
      planDirName = dirs[0];
    }
    if (!planDirName) return turbulence;

    const statePath = join(plansDir, planDirName, "state.md");
    const decisionsPath = join(plansDir, planDirName, "decisions.md");

    if (existsSync(statePath)) {
      const state = readFileSync(statePath, "utf-8");
      turbulence.replans = (state.match(/RE.?PLAN/gi) || []).length;
      turbulence.leashHits = (state.match(/leash/gi) || []).length;
      turbulence.driftWarnings = (state.match(/DRIFT_WARNING/g) || []).length;
      const iterMatch = state.match(/^## Iteration:\s*(\d+)/m);
      turbulence.iterations = iterMatch ? parseInt(iterMatch[1]) : 0;
    }

    if (existsSync(decisionsPath)) {
      const decisions = readFileSync(decisionsPath, "utf-8");
      // Count actual decision entries (pivots)
      turbulence.replans += (decisions.match(/^## D-\d+/gm) || []).length;
    }
  } catch (e) { debugLog("escalation", `Plan turbulence scan failed: ${e.message}`); }

  return turbulence;
}

// ---------------------------------------------------------------------------
// Audit Staleness Check
// ---------------------------------------------------------------------------

function getAuditStaleness() {
  const log = readAuditLog();
  const now = Date.now();
  const types = ["red-team", "regression", "retro", "user-story", "advisor"];

  const staleness = {};
  for (const type of types) {
    const lastAudit = log.audits
      .filter(a => a.type === type)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

    if (!lastAudit) {
      staleness[type] = { days: Infinity, commits: Infinity, never: true };
      continue;
    }

    const daysSince = Math.floor((now - new Date(lastAudit.timestamp).getTime()) / (1000 * 60 * 60 * 24));

    let commitsSince = null;
    const safeHash = safeCommitHash(lastAudit.covers_commit || lastAudit.commit);
    if (safeHash) {
      try {
        const currentHead = safeCommitHash(resolveCurrentCommitHash());
        if (currentHead && (currentHead === safeHash || currentHead.startsWith(safeHash))) {
          commitsSince = 0;
        } else {
          const proc = spawnSync("git", ["rev-list", `${safeHash}..HEAD`, "--count"], {
            encoding: "utf-8", cwd, timeout: 10000,
          });
          commitsSince = proc.status === 0 ? parseCountOrFallback(proc.stdout, null) : null;
        }
      } catch (e) { debugLog("escalation", `git rev-list failed: ${e.message}`); }
    }

    staleness[type] = { days: daysSince, commits: commitsSince, commits_unknown: commitsSince === null, never: false };
  }

  return staleness;
}

function collectAdvisorReviewReasons(changeStats, sharedModules, turbulence, thresholds) {
  const rt = thresholds.red_team || {};
  const retro = thresholds.retro || {};
  const us = thresholds.user_story || {};
  const reasons = [];

  if (
    changeStats.filesChanged > (rt.change_files_threshold || 5) ||
    changeStats.linesAdded > (rt.change_lines_threshold || 200)
  ) {
    reasons.push(`recent change is large (${changeStats.filesChanged} files, +${changeStats.linesAdded}/-${changeStats.linesRemoved} lines)`);
  }

  if (sharedModules.touches && sharedModules.files.length > 0) {
    reasons.push(`shared/core modules touched: ${sharedModules.files.join(", ")}`);
  }

  if (changeStats.newFiles >= (us.new_files_threshold || 3)) {
    reasons.push(`${changeStats.newFiles} new file(s) added`);
  }

  if (
    turbulence.replans >= (retro.replan_threshold || 2) ||
    turbulence.leashHits > 0 ||
    turbulence.driftWarnings >= (retro.drift_warning_threshold || 3)
  ) {
    reasons.push(
      `execution was turbulent (${turbulence.replans} RE-PLANs, ${turbulence.leashHits} leash hits, ${turbulence.driftWarnings} drift warnings)`
    );
  }

  return reasons;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function readCurrentPlanDogfoodIncident() {
  try {
    const pointerFile = join(plansDir, ".current_plan");
    if (!existsSync(pointerFile)) return null;
    const planName = readFileSync(pointerFile, "utf-8").trim();
    if (!planName) return null;
    const planDir = join(plansDir, planName);
    const state = safeReadJson(join(planDir, "state.json")) || {};
    const planContent = readFile(join(planDir, "plan.md")) || "";
    const goalText = [
      typeof state.goal === "string" ? state.goal : "",
      planContent,
    ].filter(Boolean).join("\n");
    const files = extractFilesToModify(planContent);
    return detectPlannerDogfoodIncident(goalText, files);
  } catch (e) {
    debugLog("escalation", `dogfood incident scan failed: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Escalation Decision Engine
// ---------------------------------------------------------------------------

function computeEscalations() {
  const thresholds = getEscalationThresholds();
  const rt = thresholds.red_team || {};
  const reg = thresholds.regression || {};
  const retro = thresholds.retro || {};
  const us = thresholds.user_story || {};

  const changeStats = getRecentChangeStats();
  const sharedModules = touchesSharedModules();
  const turbulence = getPlanTurbulence();
  const staleness = getAuditStaleness();
  const auditLog = readAuditLog();
  const redTeamCoveredCurrent = auditLogCoversCurrent("red-team", auditLog).covered;
  const regressionCoveredCurrent = auditLogCoversCurrent("regression", auditLog).covered;
  const workflowIntelligence = summarizeWorkflowIntelligence(cwd);
  const dogfoodIncident = readCurrentPlanDogfoodIncident();
  const ontologyChangedFiles = changedOntologyFiles();
  const perspectiveBlindSpot = auditPerspectiveBlindSpot();

  const escalations = [];

  // ---- Red Team Audit ----
  const rtStaleness = staleness["red-team"];
  if (rtStaleness.never) {
    escalations.push({
      type: "red-team-audit",
      severity: "REQUIRED",
      reason: "No red-team audit has ever been run on this project",
      trigger: "first-ever",
    });
  } else if (rtStaleness.days > (rt.staleness_days || 7) || (Number.isFinite(rtStaleness.commits) && rtStaleness.commits > (rt.staleness_commits || 10))) {
    escalations.push({
      type: "red-team-audit",
      severity: "REQUIRED",
      reason: `Last red-team audit was ${rtStaleness.days}d / ${formatCommitCount(rtStaleness.commits)} commits ago`,
      trigger: "staleness",
    });
  }

  if (!redTeamCoveredCurrent && (changeStats.filesChanged > (rt.change_files_threshold || 5) || changeStats.linesAdded > (rt.change_lines_threshold || 200))) {
    escalations.push({
      type: "red-team-audit",
      severity: "REQUIRED",
      reason: `Large change: ${changeStats.filesChanged} files, +${changeStats.linesAdded}/-${changeStats.linesRemoved} lines`,
      trigger: "change-size",
    });
  }

  if (!redTeamCoveredCurrent && sharedModules.touches) {
    escalations.push({
      type: "red-team-audit",
      severity: "REQUIRED",
      reason: `Shared/core modules touched: ${sharedModules.files.join(", ")}`,
      trigger: "shared-module",
    });
  }

  if (perspectiveBlindSpot) {
    escalations.push({
      type: "red-team-audit",
      severity: "REQUIRED",
      reason: `Audit perspective blind spots: covered ${perspectiveBlindSpot.covered.join(", ")}; missing ${perspectiveBlindSpot.missing.join(", ") || "second distinct perspective"}`,
      trigger: "audit-perspective-blind-spot",
    });
  }

  // ---- Regression Audit ----
  const regStaleness = staleness["regression"];
  if (regStaleness.never && changeStats.filesChanged > 0) {
    escalations.push({
      type: "regression-audit",
      severity: "REQUIRED",
      reason: "No regression audit has ever been run",
      trigger: "first-ever",
    });
  } else if (Number.isFinite(regStaleness.commits) && regStaleness.commits > (reg.staleness_commits || 10)) {
    escalations.push({
      type: "regression-audit",
      severity: "REQUIRED",
      reason: `Last regression audit was ${formatCommitCount(regStaleness.commits)} commits ago`,
      trigger: "staleness",
    });
  }

  if (!regressionCoveredCurrent && sharedModules.touches) {
    escalations.push({
      type: "regression-audit",
      severity: "REQUIRED",
      reason: `Shared modules changed — blast radius verification needed`,
      trigger: "shared-module",
    });
  }

  // ---- Retro ----
  if (turbulence.replans >= (retro.replan_threshold || 2) || turbulence.leashHits > 0 || turbulence.driftWarnings >= (retro.drift_warning_threshold || 3)) {
    escalations.push({
      type: "retro",
      severity: "REQUIRED",
      reason: `Turbulent execution: ${turbulence.replans} RE-PLANs, ${turbulence.leashHits} leash hits, ${turbulence.driftWarnings} drift warnings`,
      trigger: "turbulence",
    });
  }

  if (turbulence.iterations >= (retro.iteration_threshold || 4)) {
    escalations.push({
      type: "retro",
      severity: "RECOMMENDED",
      reason: `High iteration count (${turbulence.iterations}) — extract learnings`,
      trigger: "iteration-count",
    });
  }

  // ---- User Story Audit ----
  const usStaleness = staleness["user-story"];
  if (changeStats.newFiles >= (us.new_files_threshold || 3)) {
    escalations.push({
      type: "user-story-audit",
      severity: "RECOMMENDED",
      reason: `${changeStats.newFiles} new files created — verify story coverage`,
      trigger: "new-files",
    });
  }

  if (usStaleness.days > (us.staleness_days || 30) || (usStaleness.never && changeStats.filesChanged > (us.new_files_threshold || 3))) {
    escalations.push({
      type: "user-story-audit",
      severity: "OPTIONAL",
      reason: usStaleness.never
        ? "No user-story audit has been run — consider establishing coverage baseline"
        : `Last user-story audit was ${usStaleness.days}d ago`,
      trigger: "staleness",
    });
  }

  // ---- Story Registry Freshness ----
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (existsSync(registryPath)) {
    try {
      const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      const highPriorityGaps = highPriorityStoryGaps(registry);
      if (highPriorityGaps.length > 0) {
        escalations.push({
          type: "user-story-audit",
          severity: "REQUIRED",
          reason: `High-priority story gap(s) need audit coverage: ${highPriorityGaps.join(", ")}`,
          trigger: "high-priority-story-gap",
        });
      }

      // Registry staleness check
      if (registry.updated) {
        const regDays = Math.floor((Date.now() - new Date(registry.updated).getTime()) / (1000 * 60 * 60 * 24));
        let regCommits = null;
        if (registry.commit) {
          const safeRegHash = safeCommitHash(registry.commit);
          if (safeRegHash) {
            try {
              const currentHead = safeCommitHash(resolveCurrentCommitHash());
              if (currentHead && (currentHead === safeRegHash || currentHead.startsWith(safeRegHash))) {
                regCommits = 0;
              } else {
                const proc = spawnSync("git", ["rev-list", `${safeRegHash}..HEAD`, "--count"], {
                  encoding: "utf-8", cwd, timeout: 10000,
                });
                regCommits = proc.status === 0 ? parseCountOrFallback(proc.stdout, null) : null;
              }
            } catch (e) { debugLog("storyRegistryStaleness", e.message); }
          }
        }
        if (regDays > (us.registry_staleness_days || 14) || (Number.isFinite(regCommits) && regCommits > (us.registry_staleness_commits || 15))) {
          escalations.push({
            type: "user-story-audit",
            severity: "RECOMMENDED",
            reason: `Story registry is stale (${regDays}d / ${formatCommitCount(regCommits)} commits old) — re-run audit to refresh`,
            trigger: "registry-stale",
          });
        }
      }

      // Changed files match story refs, and changed files without story refs are visible gaps.
      const registryStories = allRegistryStories(registry);
      if (registryStories.length > 0 && changeStats.filesChanged > 0) {
        try {
          const storyDiffProc = spawnSync("git", ["diff", "HEAD~1", "--name-only"], {
            encoding: "utf-8", cwd, timeout: 10000,
          });
          const changedFiles = (storyDiffProc.stdout || "").trim().split("\n")
            .map(l => l.trim())
            .filter(Boolean)
            .filter(file => !ignoreCoveragePath(file));

          const affectedStories = [];
          const matchedFiles = new Set();
          for (const file of changedFiles) {
            for (const story of registryStories) {
              const refs = storyRefs(story);
              if (refs.some(ref => matchesBasename(file, ref) || refMatchesChangedFile(file, ref))) {
                if (!affectedStories.includes(story.id)) affectedStories.push(story.id);
                matchedFiles.add(file);
              }
            }
          }
          if (affectedStories.length > 0) {
            escalations.push({
              type: "user-story-audit",
              severity: "RECOMMENDED",
              reason: `Changed files match story refs for stories: ${affectedStories.join(", ")} — verify traceability`,
              trigger: "story-code-changed",
            });
          }
          const unmatchedFiles = changedFiles.filter(file => !matchedFiles.has(file));
          if (unmatchedFiles.length > 0) {
            const examples = unmatchedFiles.slice(0, 8);
            escalations.push({
              type: "user-story-audit",
              severity: "RECOMMENDED",
              reason: `${unmatchedFiles.length} changed file(s) have no story_registry refs: ${examples.join(", ")}${unmatchedFiles.length > examples.length ? ", ..." : ""} — update story coverage or record a waiver`,
              trigger: "story-unmapped-changed-files",
            });
          }
        } catch (e) { debugLog("escalation", `git diff for story check failed: ${e.message}`); }
      }
    } catch (e) { debugLog("escalation", `Registry parse failed: ${e.message}`); }
  } else {
    // Registry doesn't exist — suggest creating one for non-trivial projects
    try {
      const findProc = spawnSync("find", [".", "-type", "f", "-not", "-path", "./.git/*", "-not", "-path", "./node_modules/*", "-maxdepth", "3"], {
        encoding: "utf-8", cwd, timeout: 10000,
      });
      const fileCount = String((findProc.stdout || "").trim().split("\n").filter(l => l.trim()).length);
      if (parseInt(fileCount) >= 5) {
        escalations.push({
          type: "user-story-audit",
          severity: "RECOMMENDED",
          reason: "No story_registry.json exists — run /red-team-user-story-audit to establish traceability baseline",
          trigger: "registry-missing",
        });
      }
    } catch (e) { debugLog("escalation", `File count scan failed: ${e.message}`); }
  }

  if (ontologyChangedFiles.length > 0 && !auditLogCoversCurrent("ontology", auditLog).covered) {
    escalations.push({
      type: "ontology-rectification",
      severity: "REQUIRED",
      reason: `Ontology surface changed: ${ontologyChangedFiles.join(", ")} — run ontology rectification before treating invariants as settled`,
      trigger: "ontology-surface-changed",
      changed_files: ontologyChangedFiles,
    });
  }

  // ---- Advisor Session Review ----
  if (dogfoodIncident?.active) {
    escalations.push({
      type: "advisor-review",
      severity: "RECOMMENDED",
      reason: `Planner dogfood false-green incident: ${dogfoodIncident.why}`,
      trigger: dogfoodIncident.trigger,
      auto_launch: true,
      recommended_followup_workflow: dogfoodIncident.recommended_followup_workflow,
      recommended_followup_reason: dogfoodIncident.why,
      recommended_followup_next: dogfoodIncident.next,
      matched_surfaces: dogfoodIncident.matched_surfaces,
    });
  }

  const advThresh = thresholds.advisor || { trigger_commits: 15, trigger_days: 5 };
  const advStaleness = staleness["advisor"];
  const advisorAlreadyHandledAtHead = advStaleness &&
    advStaleness.never === false &&
    advStaleness.commits === 0 &&
    advStaleness.days === 0;
  const proactiveAdvisorReasons = advisorAlreadyHandledAtHead
    ? []
    : collectAdvisorReviewReasons(changeStats, sharedModules, turbulence, thresholds);
  if (advStaleness) {
    const commitsDue = advStaleness.never || (Number.isFinite(advStaleness.commits) && advStaleness.commits >= (advThresh.trigger_commits || 15));
    const daysDue = advStaleness.never || advStaleness.days >= (advThresh.trigger_days || 5);
    const reasonParts = [];

    if (commitsDue || daysDue) {
      reasonParts.push(advStaleness.never
        ? "No advisor session review recorded yet — run /advisor to capture lessons and check codebase health"
        : `${formatCommitCount(advStaleness.commits)} commit(s) / ${advStaleness.days}d since last advisor session review`
      );
    }

    if (proactiveAdvisorReasons.length > 0) {
      reasonParts.push(`Meaningful recent change: ${proactiveAdvisorReasons.join("; ")}`);
    }

    if (reasonParts.length > 0) {
      const trigger = (commitsDue || daysDue) && proactiveAdvisorReasons.length > 0
        ? "mixed"
        : (commitsDue || daysDue)
          ? "staleness"
          : "significant-change";
      escalations.push({
        type: "advisor-review",
        severity: "RECOMMENDED",
        reason: reasonParts.join("; "),
        trigger,
        ...(suppressAdvisorAutorunForActiveCloseout(trigger) ? { auto_launch: false } : {}),
      });
    }
  }

  // ---- Domain Profiles & Obvious Packs Audit (Advisor trigger) ----
  try {
    const personaReport = inferPersonaAdaptation(cwd);
    if (personaReport && personaReport.audit_config_valid) {
      const activeProfiles = personaReport.domain_profiles || [];
      const configuredRoles = personaReport.configured_roles || [];
      const suppressedProfiles = personaReport.suppressed_domain_profiles || [];
      const suppressedSet = new Set(suppressedProfiles);
      const isQuantActive = activeProfiles.includes("quant") || activeProfiles.includes("quant_betting") || configuredRoles.includes("quant");

      // Check 1: Tokenomics false positive from promotion governance
      const isTokenomicsActive = activeProfiles.includes("tokenomics") && !suppressedSet.has("tokenomics");
      if (isTokenomicsActive) {
        let hasRealTokenomics = false;
        let hasGovernanceOnly = false;
        try {
          const files = readdirSync(cwd);
          hasRealTokenomics = files.some(f => f.toLowerCase().includes("tokenomics") || f.toLowerCase().includes("tokenlab"));
          hasGovernanceOnly = files.some(f => f.toLowerCase().includes("governance"));
        } catch {}

        if (!hasRealTokenomics && hasGovernanceOnly) {
          escalations.push({
            type: "advisor-review",
            severity: "RECOMMENDED",
            reason: "Unexpected domain profile: tokenomics appears to be a false positive from sports/model promotion governance files; consider suppressing tokenomics in audit.config.json via suppressed_domain_profiles",
            trigger: "unexpected-domain-profile",
            auto_launch: true,
          });
        }
      }

      // Check 2: Missing obvious packs (ML should apply for quant projects)
      let hasMLFiles = false;
      try {
        const files = readdirSync(cwd);
        hasMLFiles = files.some(f => {
          const l = f.toLowerCase();
          return l.includes("optuna") || l.includes("wfo") || l.includes("calibration") || l.includes("backtest") || l.includes("model");
        });
        if (!hasMLFiles) {
          if (existsSync(join(cwd, "models"))) hasMLFiles = true;
          if (existsSync(join(cwd, "ipbs_datapack"))) hasMLFiles = true;
        }
      } catch {}

      if (hasMLFiles && !isQuantActive) {
        escalations.push({
          type: "advisor-review",
          severity: "RECOMMENDED",
          reason: "Missing obvious packs: quant/ML should apply for this model/betting repo; consider forcing machine_learning and quant_results_communication packs",
          trigger: "missing-obvious-pack",
          auto_launch: true,
        });
      }
    }
  } catch (e) {
    debugLog("escalation", `Persona adaptation advisor check failed: ${e.message}`);
  }

  // Deduplicate: keep highest severity per type
  const byType = {};
  const severityRank = { REQUIRED: 3, RECOMMENDED: 2, OPTIONAL: 1 };
  for (const e of escalations) {
    if (!byType[e.type] || severityRank[e.severity] > severityRank[byType[e.type].severity]) {
      // Keep highest severity, but accumulate reasons
      if (byType[e.type]) {
        e.reason = byType[e.type].reason + "; " + e.reason;
      }
      byType[e.type] = e;
    } else {
      byType[e.type].reason += "; " + e.reason;
    }
  }

  return {
    output_schema_version: "1.1.0",
    escalations: Object.values(byType).map(enrichEscalation),
    context: { changeStats, sharedModules, turbulence, staleness, thresholds, ontologyChangedFiles },
    workflow_intelligence: workflowIntelligence,
  };
}

// ---------------------------------------------------------------------------
// Gate-Fired Audit Execution
// ---------------------------------------------------------------------------

function auditCommandForEscalation(escalation) {
  const scriptsDir = join(cwd, ".agent", "skills", "iterative-planner", "scripts");
  if (escalation.audit_type === "red-team") {
    return {
      label: "red-team",
      command: process.execPath,
      args: [join(scriptsDir, "audit_runner.mjs"), "--report-only", "--json"],
    };
  }
  if (escalation.audit_type === "regression") {
    return {
      label: "regression",
      command: process.execPath,
      args: [join(scriptsDir, "project_health.mjs"), "--json"],
    };
  }
  return null;
}

function safeArtifactToken(value) {
  return String(value || "audit")
    .replace(/[^a-z0-9_.-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "audit";
}

function writeGateFiredAuditArtifact(payload) {
  const dir = join(cwd, "reports", "gate_fired_audits");
  mkdirSync(dir, { recursive: true });
  const stamp = nowISO().replace(/[:.]/g, "-");
  const token = safeArtifactToken(payload.audit_type || payload.type || "audit");
  const path = join(dir, `${stamp}-${token}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

function executeRequiredEscalations(options = {}) {
  const syntheticLabel = options.syntheticLabel || null;
  const result = computeEscalations();
  const required = result.escalations.filter((entry) => entry.severity === "REQUIRED");
  const executed = [];
  const skipped = [];
  let failed = false;

  for (const escalation of required) {
    const commandSpec = auditCommandForEscalation(escalation);
    if (!commandSpec) {
      skipped.push({
        type: escalation.type,
        audit_type: escalation.audit_type,
        reason: "No deterministic gate-fired executor is registered for this escalation type",
      });
      continue;
    }

    const startedAt = nowISO();
    const proc = spawnSync(commandSpec.command, commandSpec.args, {
      cwd,
      encoding: "utf-8",
      timeout: 180000,
    });
    const coverage = computeCurrentCoverageFingerprint();
    const artifact = {
      output_schema_version: "1.0.0",
      kind: "gate_fired_audit",
      synthetic_trigger: syntheticLabel,
      generated_at: nowISO(),
      started_at: startedAt,
      escalation,
      audit_type: escalation.audit_type,
      command: [commandSpec.command, ...commandSpec.args],
      exit_status: proc.status,
      signal: proc.signal || null,
      timed_out: proc.error?.code === "ETIMEDOUT",
      stdout: proc.stdout || "",
      stderr: proc.stderr || "",
      coverage,
    };
    const artifactPath = writeGateFiredAuditArtifact(artifact);
    const relArtifactPath = relative(cwd, artifactPath);
    const executedOk = proc.status === 0 ||
      (escalation.audit_type === "regression" && proc.status === 1 && String(proc.stdout || "").trim().length > 0);
    if (executedOk) {
      logAudit(escalation.audit_type, {
        silent: options.jsonMode,
        extra: {
          execution_mode: "gate_fired_audit",
          artifact_path: relArtifactPath,
          escalation_type: escalation.type,
          escalation_trigger: escalation.trigger,
          synthetic_trigger: syntheticLabel,
        },
      });
    } else {
      failed = true;
    }
    executed.push({
      type: escalation.type,
      audit_type: escalation.audit_type,
      workflow: escalation.workflow,
      ok: executedOk,
      audit_verdict_exit_status: proc.status,
      exit_status: proc.status,
      artifact_path: relArtifactPath,
      command: [commandSpec.command, ...commandSpec.args],
    });
  }

  return {
    output_schema_version: "1.2.0",
    kind: "gate_fired_audit_execution",
    generated_at: nowISO(),
    synthetic_trigger: syntheticLabel,
    required_count: required.length,
    executed_count: executed.length,
    skipped_count: skipped.length,
    failed_count: executed.filter((entry) => !entry.ok).length,
    ok: !failed,
    executed_audits: executed,
    skipped_escalations: skipped,
    source_escalation_check: result,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printReport(result) {
  const { escalations, context, workflow_intelligence: workflowIntelligence } = result;

  console.log("══════════════════════════════════════════════════════════");
  console.log("  ESCALATION CHECK — /safe-change-power");
  console.log("══════════════════════════════════════════════════════════\n");

  // Print active thresholds for auditability
  const thresholds = getEscalationThresholds();
  if (thresholds.red_team || thresholds.regression) {
    console.log("  Active Thresholds (from config/determinism.json):");
    const rt = thresholds.red_team || {};
    console.log(`    Red-team: ${rt.staleness_days || 7}d / ${rt.staleness_commits || 10} commits | ${rt.change_files_threshold || 5} files / ${rt.change_lines_threshold || 200} lines`);
    const reg = thresholds.regression || {};
    console.log(`    Regression: ${reg.staleness_commits || 10} commits`);
    const retro = thresholds.retro || {};
    console.log(`    Retro: ${retro.replan_threshold || 2} RE-PLANs / ${retro.drift_warning_threshold || 3} drift warnings / ${retro.iteration_threshold || 4} iterations`);
    console.log();
  }

  // Context
  console.log("  Change Stats:");
  console.log(`    Files: ${context.changeStats.filesChanged}  New: ${context.changeStats.newFiles}  Lines: +${context.changeStats.linesAdded}/-${context.changeStats.linesRemoved}`);
  if (context.sharedModules.touches) {
    console.log(`    ⚠️  Shared modules touched: ${context.sharedModules.files.join(", ")}`);
  }

  console.log("\n  Plan Turbulence:");
  console.log(`    RE-PLANs: ${context.turbulence.replans}  Leash hits: ${context.turbulence.leashHits}  Drift warnings: ${context.turbulence.driftWarnings}  Iterations: ${context.turbulence.iterations}`);

  console.log("\n  Audit Staleness:");
  for (const [type, s] of Object.entries(context.staleness)) {
    const label = s.never ? "NEVER RUN" : `${s.days}d / ${formatCommitCount(s.commits)} commits ago`;
    const icon = s.never ? "🔴" : s.days > 14 ? "🟡" : "🟢";
    console.log(`    ${icon} ${type.padEnd(15)} ${label}`);
  }

  console.log("\n  ──────────────────────────────────────────────────────");

  if (workflowIntelligence) {
    console.log("\n  Workflow Intelligence:");
    console.log(`    Audit log: ${workflowIntelligence.present ? (workflowIntelligence.usable ? "present" : "invalid") : "missing"}`);
    console.log(`    Workflow events: ${workflowIntelligence.workflow_event_count} explicit event(s)`);
    console.log(`    Advisor audits: ${workflowIntelligence.advisor_audit_count}`);
    for (const workflow of workflowIntelligence.workflows || []) {
      console.log(
        `    ${workflow.workflow}: recommended=${workflow.recommended_count} launched=${workflow.launched_count} completed=${workflow.completed_count}`
      );
    }
    if (Array.isArray(workflowIntelligence.issues) && workflowIntelligence.issues.length > 0) {
      console.log("    Issues:");
      for (const issue of workflowIntelligence.issues.slice(0, 5)) {
        console.log(`      - ${issue.code}: ${issue.message}`);
      }
    }
  }

  if (escalations.length === 0) {
    console.log("\n  ✅ No escalation needed. Change is clean and audits are fresh.\n");
    return;
  }

  console.log("\n  ESCALATION RECOMMENDATIONS:\n");
  const icons = { REQUIRED: "🔴", RECOMMENDED: "🟡", OPTIONAL: "🟢" };
  for (const e of escalations.sort((a, b) => ({ REQUIRED: 0, RECOMMENDED: 1, OPTIONAL: 2 }[a.severity] - { REQUIRED: 0, RECOMMENDED: 1, OPTIONAL: 2 }[b.severity]))) {
    console.log(`  ${icons[e.severity]} [${e.severity}] ${e.workflow || `/${e.type}`}`);
    console.log(`     ${e.reason}\n`);
    if (e.auto_launch && e.auto_launch_marker) {
      console.log(`     Autorun marker: ${e.auto_launch_marker}`);
      console.log(`     Audit log key: ${e.audit_type}\n`);
    }
  }

  const required = escalations.filter(e => e.severity === "REQUIRED");
  if (required.length > 0) {
    console.log(`  ⚠️  ${required.length} REQUIRED escalation(s) — do NOT skip these.\n`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

async function loadCurrentPlanStateForSupervisor() {
  try {
    const pointerFile = join(plansDir, ".current_plan");
    if (!existsSync(pointerFile)) return null;
    const planName = readFileSync(pointerFile, "utf-8").trim();
    if (!planName) return null;
    const statePath = join(plansDir, planName, "state.json");
    if (!existsSync(statePath)) return null;
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    return {
      state: typeof state.state === "string" ? state.state : null,
      iter: typeof state.iteration === "number" ? state.iteration : (typeof state.iter === "number" ? state.iter : null),
    };
  } catch {
    return null;
  }
}

async function enrichWithSupervisorVerdict(result) {
  const advEsc = (result?.escalations || []).find((e) => e?.type === "advisor-review");
  if (!advEsc) return result;
  try {
    const { runAdvisorSupervisor } = await import("./lib/supervisor_runner.mjs");
    const planState = await loadCurrentPlanStateForSupervisor();
    const verdict = await runAdvisorSupervisor({
      escalations: result.escalations,
      planState,
      env: process.env,
    });
    return { ...result, supervisor_verdict: verdict };
  } catch (err) {
    debugLog("escalation_supervisor", `supervisor import/call failed: ${err?.message || err}`);
    return { ...result, supervisor_verdict: {
      next: "Supervisor unavailable; run /advisor manually",
      why: `runner_error: ${err?.message || "unknown"}`,
      commands: ["node .agent/skills/iterative-planner/scripts/escalation_check.mjs"],
      supervisor_status: "unavailable",
      source: "fallback",
    }};
  }
}

(async () => {
  if (args[0] === "log" && args[1]) {
    const validTypes = ["red-team", "regression", "retro", "user-story", "advisor", "ontology"];
    if (!validTypes.includes(args[1])) {
      console.error(`ERROR: Invalid audit type "${args[1]}". Valid: ${validTypes.join(", ")}`);
      process.exit(1);
    }
    const coversIndex = args.indexOf("--covers");
    const coverageTarget = coversIndex >= 0 ? String(args[coversIndex + 1] || "").toUpperCase() : null;
    if (coversIndex >= 0 && coverageTarget !== "HEAD") {
      console.error('ERROR: --covers currently accepts only "HEAD".');
      process.exit(1);
    }
    logAudit(args[1], { coverageTarget });
  } else if (args[0] === "execute-required" || args.includes("--execute-required")) {
    const syntheticIndex = args.indexOf("--synthetic");
    const syntheticLabel = syntheticIndex >= 0 ? (args[syntheticIndex + 1] || "synthetic") : null;
    const jsonMode = args.includes("--json");
    const execution = executeRequiredEscalations({ jsonMode, syntheticLabel });
    if (jsonMode) {
      emitJson(execution, { exitCode: execution.ok ? 0 : 1 });
    } else {
      console.log("Gate-fired audit execution");
      console.log(`  Required: ${execution.required_count}`);
      console.log(`  Executed: ${execution.executed_count}`);
      console.log(`  Skipped: ${execution.skipped_count}`);
      console.log(`  Failed: ${execution.failed_count}`);
      for (const audit of execution.executed_audits) {
        console.log(`  - ${audit.ok ? "PASS" : "FAIL"} ${audit.audit_type}: ${audit.artifact_path}`);
      }
      for (const skipped of execution.skipped_escalations) {
        console.log(`  - SKIP ${skipped.type}: ${skipped.reason}`);
      }
      process.exit(execution.ok ? 0 : 1);
    }
  } else if (args[0] === "log-workflow" && args[1] && args[2]) {
    logWorkflowEvent(args[1], args[2], args[3] || null);
  } else if (args[0] === "log-recommendation" && args[1]) {
    logWorkflowRecommendation(args[1], args[2] || "/advisor");
  } else if (args[0] === "history") {
    showHistory();
  } else {
    let result = computeEscalations();
    if (args.includes("--with-supervisor")) {
      result = await enrichWithSupervisorVerdict(result);
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result);
    }
  }
})();
