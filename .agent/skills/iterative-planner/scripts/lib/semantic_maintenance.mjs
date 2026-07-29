// semantic_maintenance.mjs -- shared fleet semantic-health classifier and safe repair helpers.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, extname, join, relative } from "path";
import { execFileSync } from "child_process";
import { parseAnnotations } from "../annotation_parser.mjs";

const SEMANTIC_SURFACES = new Set([
  "audit_config",
  "persona_adaptation",
  "annotation_coverage",
  "root_instructions",
  "recipes",
  "story_registry",
  "mistake_overrides",
  "learned_obligation_overrides",
  "discovery_policy",
]);

const OBSERVABILITY_SURFACES = new Set(["telemetry_capture"]);
const HOST_HISTORY_SURFACES = new Set(["workflow_intelligence"]);
const PLANNER_SURFACES = new Set(["migration_hygiene"]);

const COMMENT_PREFIX_BY_EXT = new Map([
  [".py", "#"],
  [".rb", "#"],
  [".sh", "#"],
  [".yaml", "#"],
  [".yml", "#"],
  [".toml", "#"],
  [".r", "#"],
  [".jl", "#"],
  [".js", "//"],
  [".mjs", "//"],
  [".ts", "//"],
  [".tsx", "//"],
  [".rs", "//"],
  [".go", "//"],
  [".php", "//"],
  [".java", "//"],
  [".c", "//"],
  [".cpp", "//"],
  [".h", "//"],
  [".swift", "//"],
  [".kt", "//"],
  [".pl", "%%"],
]);

const SKIP_DIRS = new Set([
  ".git",
  ".agent",
  "plans",
  "reports",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

function hashText(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 12);
}

function normalizeToken(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

export function stableSemanticIssueId(issue = {}) {
  const surface = normalizeToken(issue.surface);
  const code = normalizeToken(issue.code);
  const digest = hashText([
    issue.path || "",
    issue.message || "",
    issue.command || "",
  ].join("\n"));
  return `sem_${surface}_${code}_${digest}`;
}

function layerForIssue(issue = {}) {
  const surface = issue.surface || "";
  if (PLANNER_SURFACES.has(surface)) return "planner";
  if (OBSERVABILITY_SURFACES.has(surface)) return "observability";
  if (HOST_HISTORY_SURFACES.has(surface)) return "host_history";
  if (SEMANTIC_SURFACES.has(surface)) return "semantic";
  return "semantic";
}

function classifyRepairStrategy(issue = {}) {
  const code = issue.code || "";
  const message = issue.message || "";
  if (issue.surface === "persona_adaptation" && code === "persona_underfit_high_confidence") {
    return "persona_apply_safe";
  }
  if (
    issue.surface === "annotation_coverage" &&
    code === "annotation_surface_warning" &&
    /Mutual exclusion is not symmetric:/i.test(message)
  ) {
    return "annotation_mutual_exclusion_symmetry";
  }
  if (issue.surface === "telemetry_capture" && code === "missing_post_tool_use_hook") {
    return "telemetry_install_hook";
  }
  if (issue.surface === "workflow_intelligence" && code === "missing_workflow_audit_log") {
    return "workflow_audit_log_scaffold";
  }
  return null;
}

export function classifySemanticIssue(issue = {}) {
  const layer = layerForIssue(issue);
  const repairStrategy = classifyRepairStrategy(issue);
  const severity = issue.severity || "info";
  const needsHuman =
    severity === "error" ||
    /Unknown annotation key:/i.test(issue.message || "") ||
    issue.code === "invalid_annotation_surface";
  return {
    ...issue,
    id: stableSemanticIssueId(issue),
    layer,
    owner: layer === "planner" ? "planner" : "host-project",
    auto_repairable: Boolean(repairStrategy),
    repair_strategy: repairStrategy,
    backlog_status: needsHuman ? "needs_human" : repairStrategy ? "repairable" : "open",
  };
}

function countBySeverity(issues, severity) {
  return issues.filter((issue) => issue.severity === severity).length;
}

function hasIssues(issues, layer, predicate = () => true) {
  return issues.some((issue) => issue.layer === layer && predicate(issue));
}

function plannerStatus(projectReport = {}, issues = []) {
  const summary = projectReport.summary || {};
  if ((summary.critical_missing_count || 0) > 0) return "blocked";
  if (hasIssues(issues, "planner", (issue) => issue.severity === "error")) return "blocked";
  if (
    (summary.missing_count || 0) > 0 ||
    (summary.stale_count || 0) > 0 ||
    (summary.setup_issue_count || 0) > 0 ||
    hasIssues(issues, "planner")
  ) {
    return "behind";
  }
  return "current";
}

function semanticStatus(issues = []) {
  if (hasIssues(issues, "semantic", (issue) => issue.severity === "error")) return "blocked";
  if (hasIssues(issues, "semantic", (issue) => issue.severity === "warning")) return "attention";
  if (hasIssues(issues, "semantic")) return "advisory";
  return "satisfied";
}

function observabilityStatus(issues = []) {
  if (hasIssues(issues, "observability", (issue) => issue.severity === "error")) return "blocked";
  if (hasIssues(issues, "observability")) return "incomplete";
  return "satisfied";
}

function hostHistoryStatus(issues = []) {
  if (hasIssues(issues, "host_history", (issue) => issue.severity === "error")) return "blocked";
  if (hasIssues(issues, "host_history")) return "debt";
  return "satisfied";
}

function overallStatus(parts) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Maintenance lifecycle state is derived from semantic issue severities and routes repair work.
  if (parts.planner_status === "blocked" || parts.semantic_status === "blocked") return "blocked";
  if (parts.planner_status === "behind") return "planner_behind";
  if (parts.semantic_status === "attention") return "semantic_attention";
  if (parts.observability_status === "incomplete") return "observability_incomplete";
  if (parts.host_history_status === "debt") return "host_history_debt";
  if (parts.semantic_status === "advisory") return "semantic_advisory";
  return "satisfied";
}

export function buildSemanticHealth(projectReport = {}) {
  const secondPass = projectReport.second_pass_verification || projectReport;
  const rawIssues = Array.isArray(secondPass.issues) ? secondPass.issues : [];
  const issues = rawIssues.map((issue) => classifySemanticIssue(issue));
  const parts = {
    planner_status: plannerStatus(projectReport, issues),
    semantic_status: semanticStatus(issues),
    observability_status: observabilityStatus(issues),
    host_history_status: hostHistoryStatus(issues),
  };
  const recommendedCommands = [...new Set(issues.map((issue) => issue.command).filter(Boolean))];
  return {
    overall_status: overallStatus(parts),
    ...parts,
    issue_count: issues.length,
    blocking_count: countBySeverity(issues, "error"),
    warning_count: countBySeverity(issues, "warning"),
    info_count: countBySeverity(issues, "info"),
    auto_repairable_count: issues.filter((issue) => issue.auto_repairable).length,
    backlog_count: issues.filter((issue) => issue.backlog_status !== "repaired").length,
    recommended_commands: recommendedCommands,
    issues,
  };
}

export function attachSemanticHealth(projectReport = {}) {
  return {
    ...projectReport,
    semantic_health: buildSemanticHealth(projectReport),
  };
}

function issueStatus(issue, repairResults = []) {
  const repaired = repairResults.some((result) =>
    result.status === "repaired" &&
    Array.isArray(result.issue_ids) &&
    result.issue_ids.includes(issue.id)
  );
  if (repaired) return "repaired";
  if (issue.backlog_status === "needs_human") return "needs_human";
  if (issue.auto_repairable) return "repairable";
  if (issue.layer === "observability" || issue.layer === "host_history") return "deferred";
  return "open";
}

export function buildSemanticBacklog(projectReport = {}, repairResults = []) {
  const semanticHealth = projectReport.semantic_health || buildSemanticHealth(projectReport);
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    project_path: projectReport.path || null,
    status: semanticHealth.overall_status,
    semantic_health: {
      planner_status: semanticHealth.planner_status,
      semantic_status: semanticHealth.semantic_status,
      observability_status: semanticHealth.observability_status,
      host_history_status: semanticHealth.host_history_status,
      issue_count: semanticHealth.issue_count,
      auto_repairable_count: semanticHealth.auto_repairable_count,
    },
    repair_results: repairResults,
    issues: semanticHealth.issues.map((issue) => ({
      id: issue.id,
      status: issueStatus(issue, repairResults),
      layer: issue.layer,
      surface: issue.surface,
      code: issue.code,
      severity: issue.severity,
      owner: issue.owner,
      auto_repairable: issue.auto_repairable,
      repair_strategy: issue.repair_strategy,
      path: issue.path || null,
      message: issue.message || "",
      command: issue.command || null,
    })),
  };
}

export function renderSemanticRepairPlan(backlog = {}) {
  const lines = [
    "# Semantic Repair Plan",
    "",
    `Status: ${backlog.status || "unknown"}`,
    `Generated: ${backlog.generated_at || new Date().toISOString()}`,
    `Project: ${backlog.project_path || "unknown"}`,
    "",
    "## Issues",
    "",
  ];
  const issues = Array.isArray(backlog.issues) ? backlog.issues : [];
  if (issues.length === 0) {
    lines.push("No open semantic maintenance issues.");
  } else {
    for (const issue of issues) {
      lines.push(`- [ ] ${issue.id} (${issue.status}, ${issue.layer}/${issue.surface}, ${issue.severity})`);
      lines.push(`  ${issue.message}`);
      if (issue.command) lines.push(`  Command: \`${issue.command}\``);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function writeSemanticBacklog(projectPath, projectReport, repairResults = []) {
  const backlog = buildSemanticBacklog(projectReport, repairResults);
  const backlogDir = join(projectPath, "plans", "semantic_backlog");
  mkdirSync(backlogDir, { recursive: true });
  const jsonPath = join(backlogDir, "semantic_issues.json");
  const mdPath = join(backlogDir, "repair_plan.md");
  writeFileSync(jsonPath, `${JSON.stringify(backlog, null, 2)}\n`);
  writeFileSync(mdPath, renderSemanticRepairPlan(backlog));
  return {
    backlog,
    files_written: [jsonPath, mdPath],
  };
}

function walkRepairableAnnotationFiles(dir, baseDir, files = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRepairableAnnotationFiles(fullPath, baseDir, files);
    } else if (entry.isFile() && COMMENT_PREFIX_BY_EXT.has(extname(entry.name))) {
      files.push(relative(baseDir, fullPath));
    }
  }
  return files;
}

function readProjectAnnotations(projectPath) {
  const files = walkRepairableAnnotationFiles(projectPath, projectPath);
  return files.flatMap((file) => parseAnnotations(file, projectPath));
}

function parseSymmetryMessage(message = "") {
  const match = String(message).match(/Mutual exclusion is not symmetric:\s*(.+?)\s+excludes\s+(.+?)\s+but\s+.+?\s+does not exclude\s+.+$/i);
  if (!match) return null;
  return {
    flagA: match[1].trim(),
    flagB: match[2].trim(),
  };
}

function commentPrefixForLine(filePath, line) {
  const trimmed = String(line || "").trimStart();
  for (const prefix of ["//", "%%", "%", "#"]) {
    if (trimmed.startsWith(prefix)) return prefix;
  }
  return COMMENT_PREFIX_BY_EXT.get(extname(filePath)) || "#";
}

function insertMutualExclusion(projectPath, targetAnnotation, reverseFlag) {
  const fullPath = join(projectPath, targetAnnotation.file);
  const content = readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");
  const lineIndex = Math.max(0, targetAnnotation.line - 1);
  const sourceLine = lines[lineIndex] || "";
  const indent = sourceLine.match(/^(\s*)/)?.[1] || "";
  const prefix = commentPrefixForLine(targetAnnotation.file, sourceLine);
  const addition = `${indent}${prefix} @planner:mutually_exclusive = ${reverseFlag}`;
  lines.splice(lineIndex + 1, 0, addition);
  writeFileSync(fullPath, lines.join("\n"));
  return fullPath;
}

export function repairMutualExclusionSymmetry(projectPath, issues = []) {
  const relevant = issues.filter((issue) => issue.repair_strategy === "annotation_mutual_exclusion_symmetry");
  const result = {
    strategy: "annotation_mutual_exclusion_symmetry",
    status: "not_needed",
    repaired_count: 0,
    issue_ids: [],
    files_changed: [],
    skipped: [],
  };
  if (relevant.length === 0) return result;

  const annotations = readProjectAnnotations(projectPath);
  const configFlags = new Map();
  const mutualExclusions = new Set();
  for (const ann of annotations) {
    if (ann.error) continue;
    if (ann.key === "config_flag" && ann.values[0]) configFlags.set(ann.values[0], ann);
  }
  for (const ann of annotations) {
    if (ann.error || ann.key !== "mutually_exclusive" || !ann.values[0]) continue;
    const fileAnnotations = annotations.filter((candidate) => candidate.file === ann.file);
    const flagAnn = fileAnnotations.find((candidate) => candidate.key === "config_flag" && candidate.values[0]);
    if (flagAnn) mutualExclusions.add(`${flagAnn.values[0]}\u0000${ann.values[0]}`);
  }

  for (const issue of relevant) {
    const parsed = parseSymmetryMessage(issue.message);
    if (!parsed) {
      result.skipped.push({ issue_id: issue.id, reason: "unparsed_message" });
      continue;
    }
    const { flagA, flagB } = parsed;
    const target = configFlags.get(flagB);
    if (!configFlags.has(flagA) || !target) {
      result.skipped.push({ issue_id: issue.id, reason: "missing_config_flag" });
      continue;
    }
    if (mutualExclusions.has(`${flagB}\u0000${flagA}`)) {
      result.skipped.push({ issue_id: issue.id, reason: "already_repaired" });
      continue;
    }
    const changedFile = insertMutualExclusion(projectPath, target, flagA);
    mutualExclusions.add(`${flagB}\u0000${flagA}`);
    result.repaired_count += 1;
    result.issue_ids.push(issue.id);
    if (!result.files_changed.includes(changedFile)) result.files_changed.push(changedFile);
  }

  result.status = result.repaired_count > 0 ? "repaired" : "skipped";
  return result;
}

export function scaffoldWorkflowAuditLog(projectPath, issues = []) {
  const relevant = issues.filter((issue) => issue.repair_strategy === "workflow_audit_log_scaffold");
  const auditPath = join(projectPath, "plans", "audit_log.json");
  const result = {
    strategy: "workflow_audit_log_scaffold",
    status: "not_needed",
    issue_ids: [],
    files_changed: [],
  };
  if (relevant.length === 0) return result;
  if (existsSync(auditPath)) {
    result.status = "skipped_existing";
    return result;
  }
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, `${JSON.stringify({ audits: [], workflow_events: [] }, null, 2)}\n`);
  result.status = "repaired";
  result.issue_ids = relevant.map((issue) => issue.id);
  result.files_changed = [auditPath];
  return result;
}

export function installTelemetryHook(projectPath, issues = []) {
  const relevant = issues.filter((issue) => issue.repair_strategy === "telemetry_install_hook");
  const hookInstaller = join(projectPath, ".agent", "skills", "iterative-planner", "scripts", "hooks", "install.mjs");
  const result = {
    strategy: "telemetry_install_hook",
    status: "not_needed",
    issue_ids: [],
    files_changed: [],
    error: null,
  };
  if (relevant.length === 0) return result;
  if (!existsSync(hookInstaller)) {
    result.status = "skipped_missing_installer";
    result.error = `Missing hook installer: ${hookInstaller}`;
    return result;
  }
  try {
    execFileSync(process.execPath, [hookInstaller, "--trace-hook"], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    result.status = "repaired";
    result.issue_ids = relevant.map((issue) => issue.id);
  } catch (error) {
    result.status = "failed";
    result.error = error.stderr || error.stdout || error.message;
  }
  return result;
}
