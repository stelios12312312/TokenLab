#!/usr/bin/env node
// persona_execute.mjs - deterministic persona execution guidance.
//
// This CLI projects persona adaptation, role-pack guidance, constraints, and
// findings into a single machine-readable execution contract. It is read-only
// by default; use --write to persist persona_execution.json/md in the target plan.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { getPaths, getSkillPath, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { inferPersonaAdaptation } from "./lib/persona_adaptation.mjs";
import {
  buildProjectContext,
  collectPhaseGuidance,
  collectPlanConstraints,
  enforceMinimumPersona,
  loadAuditConfig,
  loadRolePacks,
  runRoleAuditors,
  shouldFailCI,
} from "./audit_runner.mjs";

const VERSION = 1;
const DEFAULT_PHASE = "execute";
const BLOCKING_ADAPTATION_STATUSES = new Set([
  "blocked_invalid_config",
  "underfit_high_confidence",
]);
const UNDERFIT_STATUSES = new Set([
  "underfit_high_confidence",
  "underfit_advisory",
  "unused",
  "overactive",
]);
const BLOCKING_CONSTRAINT_SEVERITIES = new Set(["high", "critical", "fail"]);

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    json: false,
    write: false,
    help: false,
    strictUnderfit: false,
    phase: DEFAULT_PHASE,
    plan: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--write") flags.write = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--strict-underfit") flags.strictUnderfit = true;
    else if (arg === "--phase" && argv[i + 1]) flags.phase = normalizePhase(argv[++i]);
    else if (arg === "--plan" && argv[i + 1]) flags.plan = argv[++i];
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return flags;
}

function normalizePhase(value) {
  const phase = String(value || "").trim().toLowerCase();
  if (!phase) return DEFAULT_PHASE;
  return phase.replace(/[^a-z0-9_-]+/g, "_").slice(0, 80) || DEFAULT_PHASE;
}

function safeJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function severityKey(value) {
  return String(value || "info").trim().toLowerCase();
}

function isHighConstraint(value) {
  return BLOCKING_CONSTRAINT_SEVERITIES.has(severityKey(value));
}

function toArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function unique(values) {
  return [...new Set(toArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function countByBlocking(obligations) {
  const result = { blocking: 0, advisory: 0, info: 0 };
  for (const obligation of obligations) {
    if (obligation.blocking) result.blocking++;
    else if (severityKey(obligation.severity) === "info") result.info++;
    else result.advisory++;
  }
  return result;
}

function planSnapshot(paths, flags) {
  const target = resolvePlanTarget(paths.plansDir, {
    plan: flags.plan,
    exitOnMissing: false,
    env: process.env,
  });
  const state = target.planDir ? safeJson(join(target.planDir, "state.json")) : null;
  return {
    present: Boolean(target.planDir),
    source: target.source,
    name: target.planDirName,
    path: target.planDir,
    state: typeof state?.state === "string" ? state.state : null,
    goal: typeof state?.goal === "string" ? state.goal : null,
    shape: state?.plan_shape?.primary || null,
    explicit_missing: Boolean(flags.plan && !target.planDir),
  };
}

function configObligations(adaptation, flags) {
  const obligations = [];
  const status = adaptation?.status || "unknown";
  const missingConfig = adaptation?.audit_config_present === false;
  const strictUnderfit = flags.strictUnderfit && UNDERFIT_STATUSES.has(status);
  const blocking = missingConfig ||
    BLOCKING_ADAPTATION_STATUSES.has(status) ||
    strictUnderfit;

  if (missingConfig || status !== "satisfied") {
    obligations.push({
      id: "persona_config_status",
      type: "configuration",
      source: "persona_adapt",
      severity: blocking ? "fail" : "warn",
      blocking,
      title: missingConfig
        ? "Persona audit config is missing"
        : `Persona adaptation status is ${status}`,
      detail: adaptation?.recommended_command || "Review persona adaptation report.",
      repair_command: adaptation?.recommended_command || null,
      status,
      missing_seed_roles: adaptation?.missing_seed_roles || [],
      high_confidence_missing_seed_roles: adaptation?.high_confidence_missing_seed_roles || [],
    });
  }

  return obligations;
}

function planTargetObligations(plan) {
  if (!plan.explicit_missing) return [];
  return [{
    id: "plan_target_missing",
    type: "plan_target",
    source: "persona_execute",
    severity: "fail",
    blocking: true,
    title: "Explicit plan target was not found",
    detail: "Pass an existing plan directory name with --plan, or omit --plan to use the active target.",
  }];
}

function guidanceObligations(guidanceItems, phase) {
  return guidanceItems.map((item) => ({
    id: `guidance:${item.packId}:${phase}`,
    type: "guidance",
    source: "role_pack",
    pack_id: item.packId,
    phase,
    severity: "info",
    blocking: false,
    title: `${item.packId} guidance for ${phase}`,
    detail: item.guidance,
  }));
}

function constraintObligations(constraints) {
  return constraints.map((constraint) => {
    const blocking = isHighConstraint(constraint?.severity);
    return {
      id: `constraint:${constraint?.id || "unknown"}`,
      type: "constraint",
      source: "role_pack",
      pack_id: constraint?.role || constraint?.pack_id || null,
      severity: severityKey(constraint?.severity),
      blocking,
      title: constraint?.constraint || constraint?.id || "Persona constraint",
      detail: constraint?.rationale || "",
      story_refs: unique(constraint?.story_refs || []),
      raw: constraint,
    };
  });
}

function findingObligations(findings) {
  return findings.map((finding, index) => {
    const roleAudit = finding?._roleAudit || {};
    const severity = severityKey(finding?.severity || roleAudit.severity);
    return {
      id: `finding:${roleAudit.id || index + 1}`,
      type: "finding",
      source: "role_audit",
      pack_id: roleAudit.role || roleAudit.pack_id || null,
      severity,
      blocking: severity === "fail",
      title: finding?.message || roleAudit.evidence || "Persona finding",
      detail: finding?.details || roleAudit.recommendation || "",
      story_refs: unique(roleAudit.story_refs || finding?.story_refs || []),
      location: finding?.location || null,
      raw: finding,
    };
  });
}

async function roleProjection({ cwd, skillPath, auditConfig, plan, flags }) {
  const result = {
    audit_error: null,
    configured_roles: Array.isArray(auditConfig?.roles) ? auditConfig.roles : [],
    loaded_packs: [],
    persona_authority: null,
    guidance_items: [],
    constraints: [],
    findings: [],
    role_summary: { fail: 0, warn: 0, info: 0 },
    role_fail_on_triggered: false,
  };

  if (!auditConfig || plan.explicit_missing) return result;

  try {
    const context = await buildProjectContext(cwd, skillPath, auditConfig, {
      plan: plan.name,
      env: process.env,
    });
    let packs = await loadRolePacks(auditConfig, skillPath, cwd, context.planShape);
    packs = await enforceMinimumPersona(packs, context);

    result.loaded_packs = packs.map((pack) => pack.id);
    result.persona_authority = packs.personaAuthority || null;
    result.guidance_items = collectPhaseGuidance(packs, context, flags.phase);
    result.constraints = collectPlanConstraints(packs, context);
    result.findings = await runRoleAuditors(context, packs);
    result.role_fail_on_triggered = shouldFailCI(result.findings, auditConfig);

    for (const finding of result.findings) {
      if (finding?.severity === "fail") result.role_summary.fail++;
      else if (finding?.severity === "warn") result.role_summary.warn++;
      else result.role_summary.info++;
    }
  } catch (error) {
    result.audit_error = error.message;
  }

  return result;
}

function buildStatus({ adaptation, roleResult, obligations }) {
  if (roleResult.audit_error) return "blocked_audit_error";
  if (obligations.some((entry) => entry.blocking)) return "blocked";
  if (adaptation?.status && adaptation.status !== "satisfied") return adaptation.status;
  return "ok";
}

function renderMarkdown(report) {
  const lines = [
    "# Persona Execution Guidance",
    "",
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Phase: ${report.phase}`,
    `Plan: ${report.plan.present ? report.plan.name : "none"}`,
    "",
    "## Packs",
    `Configured: ${report.packs.configured.join(", ") || "none"}`,
    `Loaded: ${report.packs.loaded.join(", ") || "none"}`,
    `Suppressed: ${report.packs.suppressed.join(", ") || "none"}`,
    "",
    "## Obligations",
  ];

  if (report.obligations.length === 0) {
    lines.push("No persona execution obligations.");
  } else {
    lines.push("| ID | Type | Severity | Blocking | Title |");
    lines.push("|---|---|---|---|---|");
    for (const obligation of report.obligations) {
      lines.push(`| ${escapeCell(obligation.id)} | ${escapeCell(obligation.type)} | ${escapeCell(obligation.severity)} | ${obligation.blocking ? "yes" : "no"} | ${escapeCell(obligation.title)} |`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function escapeCell(value) {
  return String(value || "")
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .trim();
}

function writeArtifacts(report) {
  if (!report.plan?.present || !report.plan?.path) {
    report.write_status = "skipped_no_plan";
    return [];
  }
  mkdirSync(report.plan.path, { recursive: true });
  const jsonPath = join(report.plan.path, "persona_execution.json");
  const mdPath = join(report.plan.path, "persona_execution.md");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  writeFileSync(mdPath, renderMarkdown(report), "utf-8");
  report.write_status = "written";
  return [jsonPath, mdPath];
}

export async function buildPersonaExecutionReport({
  cwd = process.cwd(),
  flags = {},
} = {}) {
  const normalizedFlags = {
    json: Boolean(flags.json),
    write: Boolean(flags.write),
    strictUnderfit: Boolean(flags.strictUnderfit),
    phase: normalizePhase(flags.phase || DEFAULT_PHASE),
    plan: flags.plan || null,
  };
  const paths = getPaths(cwd);
  const skillPath = getSkillPath(import.meta.url);
  const plan = planSnapshot(paths, normalizedFlags);
  const adaptation = inferPersonaAdaptation(cwd, { commandTarget: "." });
  let auditConfig = null;
  let auditConfigError = null;

  try {
    auditConfig = loadAuditConfig(cwd);
  } catch (error) {
    auditConfigError = error.message;
  }

  const roleResult = await roleProjection({
    cwd,
    skillPath,
    auditConfig,
    plan,
    flags: normalizedFlags,
  });
  if (auditConfigError && !roleResult.audit_error) roleResult.audit_error = auditConfigError;

  const obligations = [
    ...planTargetObligations(plan),
    ...configObligations(adaptation, normalizedFlags),
    ...guidanceObligations(roleResult.guidance_items, normalizedFlags.phase),
    ...constraintObligations(roleResult.constraints),
    ...findingObligations(roleResult.findings),
  ];

  if (roleResult.audit_error) {
    obligations.unshift({
      id: "persona_audit_error",
      type: "audit_error",
      source: "audit_runner",
      severity: "fail",
      blocking: true,
      title: "Persona audit runner failed",
      detail: roleResult.audit_error,
    });
  }

  if (auditConfig === null && !auditConfigError) {
    obligations.unshift({
      id: "persona_config_missing",
      type: "configuration",
      source: "audit_runner",
      severity: "fail",
      blocking: true,
      title: "No audit.config.json found",
      detail: "Create audit.config.json with at least one persona role.",
      repair_command: adaptation?.recommended_command || null,
    });
  }

  const counts = countByBlocking(obligations);
  const report = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    status: buildStatus({ adaptation, roleResult, obligations }),
    phase: normalizedFlags.phase,
    plan: {
      present: plan.present,
      source: plan.source,
      name: plan.name,
      path: plan.path,
      state: plan.state,
      goal: plan.goal,
      shape: roleResult.persona_authority?.plan_shape || plan.shape,
    },
    config: {
      present: adaptation?.audit_config_present === true,
      valid: adaptation?.audit_config_valid !== false && !auditConfigError,
      path: adaptation?.audit_config_path || null,
      status: adaptation?.status || "unknown",
      error: adaptation?.audit_config_error || auditConfigError || null,
      repair_command: adaptation?.recommended_command || null,
      missing_seed_roles: adaptation?.missing_seed_roles || [],
      high_confidence_missing_seed_roles: adaptation?.high_confidence_missing_seed_roles || [],
    },
    persona_authority: roleResult.persona_authority || adaptation?.persona_authority || null,
    packs: {
      configured: unique(roleResult.configured_roles || adaptation?.configured_roles || []),
      loaded: unique(roleResult.loaded_packs),
      active: unique(roleResult.persona_authority?.active_packs || []),
      suppressed: unique(roleResult.persona_authority?.suppressed_packs || []),
      forced: unique(roleResult.persona_authority?.forced_packs || []),
    },
    summary: {
      obligations: obligations.length,
      blocking: counts.blocking,
      advisory: counts.advisory,
      info: counts.info,
      guidance: roleResult.guidance_items.length,
      constraints: roleResult.constraints.length,
      findings: roleResult.findings.length,
      role_findings: roleResult.role_summary,
      role_fail_on_triggered: roleResult.role_fail_on_triggered,
    },
    obligations,
    write_status: normalizedFlags.write ? "pending" : "not_requested",
    artifacts_written: [],
  };

  if (normalizedFlags.write) {
    report.artifacts_written = writeArtifacts(report).map((path) => path.replace(`${cwd}/`, ""));
  }

  return report;
}

function printHelp() {
  console.log(`persona_execute.mjs - deterministic persona execution guidance

Usage:
  node persona_execute.mjs [--json] [--write] [--plan <plan-dir>] [--phase <phase>] [--strict-underfit]

Options:
  --json              Print machine-readable JSON.
  --write             Write persona_execution.json and persona_execution.md to the target plan.
  --plan <plan-dir>   Use an explicit planner target instead of the active plan.
  --phase <phase>     Guidance phase to project. Default: execute.
  --strict-underfit   Treat advisory underfit statuses as blocking at exit.
`);
}

const isMain = process.argv[1] && basename(process.argv[1]) === "persona_execute.mjs";

if (isMain) {
  (async () => {
    try {
      const flags = parseArgs();
      if (flags.help) {
        printHelp();
        process.exitCode = 0;
        return;
      }
      const report = await buildPersonaExecutionReport({ flags });
      if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderMarkdown(report));
      }
      process.exitCode = report.summary.blocking > 0 ? 1 : 0;
    } catch (error) {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 2;
    }
  })();
}
