import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

import { getEscalationThresholds } from "./determinism.mjs";

const AUDIT_WORKFLOW_MAP = Object.freeze({
  "red-team": "/red-team-audit",
  "regression": "/regression-audit",
  "retro": "/retro",
  "user-story": "/red-team-user-story-audit",
  "advisor": "/advisor",
});

function safeCommitHash(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

function readAuditLog(cwd) {
  const auditLogPath = join(cwd, "plans", "audit_log.json");
  try {
    return JSON.parse(readFileSync(auditLogPath, "utf-8"));
  } catch {
    return { audits: [] };
  }
}

function computeCommitDistance(cwd, commitHash) {
  const safeHash = safeCommitHash(commitHash);
  if (!safeHash) return Infinity;

  try {
    const proc = spawnSync("git", ["rev-list", `${safeHash}..HEAD`, "--count"], {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });
    if (proc.status !== 0) return Infinity;
    const parsed = Number.parseInt((proc.stdout || "").trim(), 10);
    return Number.isFinite(parsed) ? parsed : Infinity;
  } catch {
    return Infinity;
  }
}

export function getAuditStaleness({ cwd = process.cwd() } = {}) {
  const log = readAuditLog(cwd);
  const now = Date.now();
  const types = ["red-team", "regression", "retro", "user-story", "advisor"];
  const staleness = {};

  for (const type of types) {
    const lastAudit = (Array.isArray(log.audits) ? log.audits : [])
      .filter((entry) => entry?.type === type)
      .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp))[0];

    if (!lastAudit) {
      staleness[type] = { days: Infinity, commits: Infinity, never: true, last_audit_at: null, last_commit: null };
      continue;
    }

    const lastAuditAt = typeof lastAudit.timestamp === "string" ? lastAudit.timestamp : null;
    const days = lastAuditAt
      ? Math.floor((now - new Date(lastAuditAt).getTime()) / (1000 * 60 * 60 * 24))
      : Infinity;
    staleness[type] = {
      days,
      commits: computeCommitDistance(cwd, lastAudit.commit),
      never: false,
      last_audit_at: lastAuditAt,
      last_commit: safeCommitHash(lastAudit.commit),
    };
  }

  return staleness;
}

function readCurrentPlanState(cwd) {
  const pointerPath = join(cwd, "plans", ".current_plan");
  try {
    const planName = readFileSync(pointerPath, "utf-8").trim();
    const statePath = join(cwd, "plans", planName, "state.md");
    return existsSync(statePath) ? readFileSync(statePath, "utf-8") : "";
  } catch {
    return "";
  }
}

function computePlanTurbulence(cwd) {
  const stateContent = readCurrentPlanState(cwd);
  return {
    replans: (stateContent.match(/RE.?PLAN/gi) || []).length,
    leash_hits: (stateContent.match(/leash/gi) || []).length,
    drift_warnings: (stateContent.match(/DRIFT_WARNING/g) || []).length,
    iterations: Number.parseInt((stateContent.match(/^## Iteration:\s*(\d+)/m) || [])[1] || "0", 10) || 0,
  };
}

function toReadableCount(value) {
  return Number.isFinite(value) ? String(value) : "never";
}

export function computeAuditFreshnessSignal({ cwd = process.cwd() } = {}) {
  const thresholds = getEscalationThresholds();
  const staleness = getAuditStaleness({ cwd });
  const turbulence = computePlanTurbulence(cwd);
  const retroThresholds = thresholds.retro || {};

  const audits = Object.entries(staleness).map(([type, entry]) => {
    const config = thresholds[type.replace("-", "_")] || thresholds[type] || {};
    const staleByDays = Number.isFinite(entry.days) && typeof config.staleness_days === "number" && entry.days > config.staleness_days;
    const staleByCommits = Number.isFinite(entry.commits) && typeof config.staleness_commits === "number" && entry.commits > config.staleness_commits;
    const stale = entry.never || staleByDays || staleByCommits;
    const retroTurbulent = type === "retro" && (
      turbulence.replans >= (retroThresholds.replan_threshold || 2) ||
      turbulence.leash_hits > 0 ||
      turbulence.drift_warnings >= (retroThresholds.drift_warning_threshold || 3) ||
      turbulence.iterations >= (retroThresholds.iteration_threshold || 4)
    );
    const required = type === "red-team" || type === "regression" || type === "advisor" || (type === "retro" && retroTurbulent);
    const recommended = type === "user-story" || (type === "retro" && !required);
    return {
      audit_type: type,
      workflow: AUDIT_WORKFLOW_MAP[type] || null,
      stale,
      required,
      recommended,
      never: entry.never,
      days: entry.days,
      commits: entry.commits,
      thresholds: {
        staleness_days: config.staleness_days ?? null,
        staleness_commits: config.staleness_commits ?? null,
      },
      reason: !stale
        ? `${type} audit is fresh`
        : type === "retro" && retroTurbulent
          ? `retro audit debt is active under turbulent execution (${turbulence.replans} replans, ${turbulence.leash_hits} leash hits, ${turbulence.drift_warnings} drift warnings, ${turbulence.iterations} iterations)`
          : entry.never
            ? `${type} audit has never been run`
            : `${type} audit is stale (${toReadableCount(entry.days)}d / ${toReadableCount(entry.commits)} commits)`,
    };
  });

  const staleRequired = audits.filter((audit) => audit.stale && audit.required);
  const staleRecommended = audits.filter((audit) => audit.stale && !audit.required);

  return {
    status: staleRequired.length > 0
      ? "stale_required"
      : staleRecommended.length > 0
        ? "stale_recommended"
        : "fresh",
    overall_status: staleRequired.length > 0
      ? "stale_required"
      : staleRecommended.length > 0
        ? "stale_recommended"
        : "fresh",
    false_green_risk: staleRequired.length > 0,
    required_actions: staleRequired.map((audit) => ({
      audit_type: audit.audit_type,
      workflow: audit.workflow,
      reason: audit.reason,
    })),
    advisory_actions: staleRecommended.map((audit) => ({
      audit_type: audit.audit_type,
      workflow: audit.workflow,
      reason: audit.reason,
    })),
    turbulence,
    audits,
  };
}
