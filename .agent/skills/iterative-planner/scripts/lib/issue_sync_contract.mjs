// issue_sync_contract.mjs — Deterministic Program Packet <-> GitHub Issue mirror contract.
// @planner:module = issue_sync_contract
// @planner:capability = program_packet_github_issue_sync_contract

export const ISSUE_SYNC_CONTRACT_VERSION = "2026-07-02.remote-local-sync.v1";

export const REVIEW_STATUS_LABELS = Object.freeze([
  "planner:blocked",
  "planner:review-ready",
]);

export const TICKET_LIFECYCLE_LABELS = Object.freeze([
  "planner:ticket-proposed",
  "planner:ticket-ready",
  "planner:ticket-in-progress",
  "planner:ticket-blocked",
  "planner:ticket-done",
  "planner:ticket-verified",
  "planner:ticket-closed",
  "planner:ticket-deferred",
]);

const LEGACY_TICKET_LIFECYCLE_LABELS = Object.freeze([
  "planner:proposed",
]);

const TERMINAL_TICKET_LIFECYCLES = new Set([
  "closed",
  "verified",
  "deferred",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSyncToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(asString).filter(Boolean))];
}

export function reviewStatusLabel(finalStatus) {
  return normalizeSyncToken(finalStatus) === "blocked" ? "planner:blocked" : "planner:review-ready";
}

export function ticketLifecycleLabel(ticket) {
  const lifecycle = normalizeSyncToken(ticket?.lifecycle);
  return lifecycle ? `planner:ticket-${lifecycle.replaceAll("_", "-")}` : null;
}

export function issueLabelNames(issue) {
  return uniqueStrings(asArray(issue?.labels).map((label) => (typeof label === "string" ? label : label?.name)));
}

export function desiredIssueLabels({ reviewStatus, ticket }) {
  return uniqueStrings([
    reviewStatusLabel(reviewStatus),
    ticketLifecycleLabel(ticket),
  ]);
}

export function staleIssueLabels({ reviewStatus, ticket, issue }) {
  const current = new Set(issueLabelNames(issue));
  const desired = new Set(desiredIssueLabels({ reviewStatus, ticket }));
  return [
    ...REVIEW_STATUS_LABELS,
    ...TICKET_LIFECYCLE_LABELS,
    ...LEGACY_TICKET_LIFECYCLE_LABELS,
  ].filter((label) => !desired.has(label) && current.has(label));
}

function normalizeIssueState(issue) {
  return normalizeSyncToken(issue?.state);
}

function lifecycleState(ticket, lifecycleOverride = null) {
  const lifecycle = normalizeSyncToken(lifecycleOverride || ticket?.lifecycle) || "unknown";
  return {
    lifecycle,
    label: ticketLifecycleLabel(ticket),
    terminal: TERMINAL_TICKET_LIFECYCLES.has(lifecycle),
  };
}

function ticketWithLifecycle(ticket, lifecycle) {
  if (!ticket || !lifecycle) return ticket;
  return {
    ...ticket,
    lifecycle,
  };
}

function remoteToLocalDecision({ issue, ticket, acceptRemoteClose }) {
  const issueState = normalizeIssueState(issue);
  const local = lifecycleState(ticket);
  if (issueState !== "closed") {
    return {
      action: "no_change",
      reason: "Remote issue is not closed.",
      candidate_lifecycle: null,
    };
  }
  if (local.terminal) {
    return {
      action: "already_terminal",
      reason: "Remote issue is closed and local lifecycle is already terminal.",
      candidate_lifecycle: local.lifecycle,
    };
  }
  if (acceptRemoteClose) {
    return {
      action: "candidate_remote_close",
      reason: "Remote issue is closed, but local advancement must be gated by close-to-advance.",
      candidate_lifecycle: "closed",
    };
  }
  return {
    action: "conflict",
    reason: "Remote issue is closed while local lifecycle is non-terminal.",
    candidate_lifecycle: null,
  };
}

export function buildIssueSyncContract({
  ticket,
  issue,
  reviewStatus,
  closeGithubIssue = false,
  acceptRemoteClose = false,
} = {}) {
  const local = lifecycleState(ticket);
  const remoteDecision = remoteToLocalDecision({ issue, ticket, acceptRemoteClose });
  const effectiveTicket = remoteDecision.action === "candidate_remote_close"
    ? ticketWithLifecycle(ticket, remoteDecision.candidate_lifecycle)
    : ticket;
  const effectiveLocal = lifecycleState(effectiveTicket);
  const desiredLabels = desiredIssueLabels({ reviewStatus, ticket: effectiveTicket });
  const removeLabels = staleIssueLabels({ reviewStatus, ticket: effectiveTicket, issue });
  const conflicts = [];
  if (remoteDecision.action === "conflict") {
    conflicts.push({
      code: "remote_closed_local_non_terminal",
      severity: "blocked",
      local_lifecycle: local.lifecycle,
      remote_state: normalizeIssueState(issue) || null,
      message: "GitHub issue is closed but Program Packet ticket is not terminal.",
    });
  }

  return {
    version: ISSUE_SYNC_CONTRACT_VERSION,
    authority: {
      local: "program_packet",
      remote: "github_issue_mirror",
      rule: "Local Program Packet and child planner state are authoritative; GitHub is a mirror unless remote input is explicitly accepted by a gated command.",
    },
    local_state: {
      ticket_id: ticket?.id || null,
      lifecycle: local.lifecycle,
      lifecycle_label: local.label,
      terminal: local.terminal,
      effective_lifecycle: effectiveLocal.lifecycle,
      effective_lifecycle_label: effectiveLocal.label,
      effective_terminal: effectiveLocal.terminal,
      review_status: normalizeSyncToken(reviewStatus) || "not_run",
    },
    remote_state: {
      issue_number: issue?.number ?? null,
      issue_url: issue?.url || null,
      state: issue?.state || null,
      normalized_state: normalizeIssueState(issue) || null,
      labels: issueLabelNames(issue),
    },
    local_to_remote: {
      desired_labels: desiredLabels,
      remove_labels: removeLabels,
      should_comment: Boolean(issue?.number),
      should_update_labels: Boolean(issue?.number && (desiredLabels.length > 0 || removeLabels.length > 0)),
      should_update_project_status: Boolean(issue?.project_item?.id),
      should_close_issue: Boolean(closeGithubIssue && issue?.number),
    },
    remote_to_local: remoteDecision,
    conflicts,
  };
}
