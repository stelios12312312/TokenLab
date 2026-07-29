import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export const TRACKED_WORKFLOWS = Object.freeze([
  "/advisor",
  "/steward",
  "/sme-improvement",
  "/ontology",
]);

export const WORKFLOW_EVENT_TYPES = Object.freeze([
  "recommended",
  "launched",
  "completed",
]);

function readJsonSafe(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeWorkflowId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const normalized = prefixed.toLowerCase();
  return TRACKED_WORKFLOWS.includes(normalized) ? normalized : null;
}

export function normalizeWorkflowEventType(value) {
  const normalized = normalizeToken(value);
  return WORKFLOW_EVENT_TYPES.includes(normalized) ? normalized : null;
}

function listPlanDirectories(targetPath) {
  const plansDir = join(targetPath, "plans");
  if (!existsSync(plansDir)) return [];
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function buildWorkflowState(workflow) {
  return {
    workflow,
    recommended_count: 0,
    launched_count: 0,
    completed_count: 0,
    last_recommended_at: null,
    last_launched_at: null,
    last_completed_at: null,
    latest_event_type: null,
    latest_event_at: null,
    latest_source_workflow: null,
  };
}

function updateLatest(state, eventType, timestamp, sourceWorkflow) {
  if (!timestamp) return;
  if (!state.latest_event_at || timestamp >= state.latest_event_at) {
    state.latest_event_at = timestamp;
    state.latest_event_type = eventType;
    state.latest_source_workflow = sourceWorkflow || null;
  }
}

function summarizeTrackedWorkflows(events) {
  const byWorkflow = new Map(TRACKED_WORKFLOWS.map((workflow) => [workflow, buildWorkflowState(workflow)]));

  for (const event of events) {
    const state = byWorkflow.get(event.workflow);
    if (!state) continue;

    if (event.event === "recommended") {
      state.recommended_count += 1;
      if (!state.last_recommended_at || event.timestamp >= state.last_recommended_at) {
        state.last_recommended_at = event.timestamp;
      }
    } else if (event.event === "launched") {
      state.launched_count += 1;
      if (!state.last_launched_at || event.timestamp >= state.last_launched_at) {
        state.last_launched_at = event.timestamp;
      }
    } else if (event.event === "completed") {
      state.completed_count += 1;
      if (!state.last_completed_at || event.timestamp >= state.last_completed_at) {
        state.last_completed_at = event.timestamp;
      }
    }

    updateLatest(state, event.event, event.timestamp, event.source_workflow);
  }

  return [...byWorkflow.values()];
}

function collectInvalidWorkflowEvents(rawEvents) {
  const invalid = [];
  const valid = [];
  for (const [index, raw] of rawEvents.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid.push({ index, reason: "invalid_entry" });
      continue;
    }

    const workflow = normalizeWorkflowId(raw.workflow);
    const eventType = normalizeWorkflowEventType(raw.event);
    if (!workflow || !eventType) {
      invalid.push({
        index,
        reason: !workflow ? "invalid_workflow" : "invalid_event",
      });
      continue;
    }

    valid.push({
      workflow,
      event: eventType,
      timestamp: typeof raw.timestamp === "string" && raw.timestamp.trim() ? raw.timestamp.trim() : null,
      source_workflow: normalizeWorkflowId(raw.source_workflow),
      commit: typeof raw.commit === "string" && raw.commit.trim() ? raw.commit.trim() : null,
      plan_id: typeof raw.plan_id === "string" && raw.plan_id.trim() ? raw.plan_id.trim() : null,
    });
  }
  return { valid, invalid };
}

function detectReportSurface(reportDir) {
  if (!existsSync(reportDir)) return { present: false, files: [] };
  try {
    const files = readdirSync(reportDir)
      .filter((entry) => !entry.startsWith("."))
      .sort();
    return { present: files.length > 0, files };
  } catch {
    return { present: false, files: [] };
  }
}

export function summarizeWorkflowIntelligence(targetPath) {
  const auditLogPath = join(targetPath, "plans", "audit_log.json");
  const auditLogPresent = existsSync(auditLogPath);
  const auditLog = auditLogPresent ? readJsonSafe(auditLogPath) : { ok: true, value: { audits: [] } };
  const planDirs = listPlanDirectories(targetPath);
  const stewardshipReports = detectReportSurface(join(targetPath, "reports", "stewardship"));
  const smeReports = detectReportSurface(join(targetPath, "reports", "sme_improvement"));

  const base = {
    path: auditLogPath,
    present: auditLogPresent,
    usable: auditLogPresent && auditLog.ok,
    plan_count: planDirs.length,
    audit_count: 0,
    audit_counts: {},
    workflow_events_supported: false,
    workflow_event_count: 0,
    invalid_workflow_event_count: 0,
    advisor_audit_count: 0,
    tracked_workflows: TRACKED_WORKFLOWS,
    workflows: TRACKED_WORKFLOWS.map((workflow) => buildWorkflowState(workflow)),
    stewardship_reports: stewardshipReports,
    sme_improvement_reports: smeReports,
    issues: [],
  };

  if (!auditLog.ok) {
    base.usable = false;
    base.issues.push({
      code: "invalid_workflow_audit_log",
      severity: "info",
      path: auditLogPath,
      message: "plans/audit_log.json exists but is not valid JSON, so workflow-intelligence history cannot be trusted.",
    });
    return base;
  }

  const parsed = auditLog.value && typeof auditLog.value === "object" && !Array.isArray(auditLog.value)
    ? auditLog.value
    : { audits: [] };
  const audits = Array.isArray(parsed.audits) ? parsed.audits.filter((entry) => entry && typeof entry === "object") : [];
  const rawWorkflowEvents = Array.isArray(parsed.workflow_events) ? parsed.workflow_events : [];
  const { valid: workflowEvents, invalid: invalidWorkflowEvents } = collectInvalidWorkflowEvents(rawWorkflowEvents);
  const workflows = summarizeTrackedWorkflows(workflowEvents);

  const auditCounts = {};
  for (const audit of audits) {
    const type = typeof audit.type === "string" && audit.type.trim() ? audit.type.trim() : "unknown";
    auditCounts[type] = (auditCounts[type] || 0) + 1;
  }

  base.audit_count = audits.length;
  base.audit_counts = auditCounts;
  base.workflow_events_supported = Array.isArray(parsed.workflow_events);
  base.workflow_event_count = workflowEvents.length;
  base.invalid_workflow_event_count = invalidWorkflowEvents.length;
  base.advisor_audit_count = auditCounts.advisor || 0;
  base.workflows = workflows;

  const advisorState = workflows.find((entry) => entry.workflow === "/advisor") || buildWorkflowState("/advisor");
  const stewardState = workflows.find((entry) => entry.workflow === "/steward") || buildWorkflowState("/steward");
  const smeState = workflows.find((entry) => entry.workflow === "/sme-improvement") || buildWorkflowState("/sme-improvement");

  if (invalidWorkflowEvents.length > 0) {
    base.issues.push({
      code: "invalid_workflow_event_entries",
      severity: "info",
      path: auditLogPath,
      message: `${invalidWorkflowEvents.length} workflow event entr${invalidWorkflowEvents.length === 1 ? "y is" : "ies are"} invalid, so workflow-intelligence history is incomplete.`,
    });
  }

  if (planDirs.length > 0 && !auditLogPresent) {
    base.issues.push({
      code: "missing_workflow_audit_log",
      severity: "info",
      path: auditLogPath,
      message: "Planner history exists but plans/audit_log.json is missing, so workflow recommendation and uptake history is not recorded.",
    });
  }

  if ((audits.length > 0 || planDirs.length > 0) && workflowEvents.length === 0) {
    base.issues.push({
      code: "workflow_events_missing",
      severity: "info",
      path: auditLogPath,
      message: "Audit history or planner history exists, but no workflow recommendation/launch/completion events are recorded yet.",
    });
  }

  if (base.advisor_audit_count > 0 && advisorState.completed_count === 0) {
    base.issues.push({
      code: "advisor_audit_only_history",
      severity: "info",
      path: auditLogPath,
      message: "Advisor audits were recorded through the legacy audit log, but no explicit /advisor workflow completion events exist yet.",
    });
  }

  if (stewardshipReports.present && stewardState.completed_count === 0) {
    base.issues.push({
      code: "steward_reports_without_completion_log",
      severity: "info",
      path: join(targetPath, "reports", "stewardship"),
      message: "Stewardship artifacts exist, but no explicit /steward completion event is recorded in plans/audit_log.json.",
    });
  }

  if (smeReports.present && smeState.completed_count === 0) {
    base.issues.push({
      code: "sme_reports_without_completion_log",
      severity: "info",
      path: join(targetPath, "reports", "sme_improvement"),
      message: "SME improvement artifacts exist, but no explicit /sme-improvement completion event is recorded in plans/audit_log.json.",
    });
  }

  for (const state of [stewardState, smeState]) {
    if (state.latest_event_type === "recommended") {
      base.issues.push({
        code: "workflow_recommended_without_uptake",
        severity: "info",
        path: auditLogPath,
        workflow: state.workflow,
        message: `${state.workflow} was recommended${state.latest_source_workflow ? ` by ${state.latest_source_workflow}` : ""} but no later launch or completion event has been recorded.`,
      });
    } else if (state.latest_event_type === "launched") {
      base.issues.push({
        code: "workflow_launched_without_completion",
        severity: "info",
        path: auditLogPath,
        workflow: state.workflow,
        message: `${state.workflow} was launched${state.latest_source_workflow ? ` from ${state.latest_source_workflow}` : ""} but no completion event has been recorded yet.`,
      });
    }
  }

  return base;
}
