// @planner:module = truth_surface_convergence
// @planner:capability = deterministic_truth_surface_convergence

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";

import { computeAuditFreshnessSignal } from "./audit_freshness.mjs";
import { listProgramPacketPaths } from "./lifecycle_reconciler.mjs";
import {
  evaluateExternalPrerequisites,
  effectiveTicketLifecycle,
  resolveProgramPacketRemoteMode,
} from "./program_packet.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

const ACTIVE_TICKET_LIFECYCLES = new Set(["proposed", "ready", "in_progress", "executing", "done"]);
const TERMINAL_TICKET_LIFECYCLES = new Set(["verified", "closed", "deferred", "blocked"]);
const ACTIVE_PROGRAM_STATUSES = new Set(["design", "ready", "executing", "validating"]);
const BRANCH_DELETE_CANDIDATE_CLASSES = new Set(["MERGED_EQUIVALENT", "MERGED_THEN_REMOVED", "OBSOLETE"]);
const DEFAULT_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const AUTHORITY_MATRIX = Object.freeze([
  { surface: "program_ticket_lifecycle", canonical_owner: "program_packet", mirrors: ["github_issue"] },
  { surface: "program_status", canonical_owner: "program_manager_gate", mirrors: [] },
  { surface: "plan_state", canonical_owner: "top_level_state_json", mirrors: ["state_md"] },
  { surface: "story_identity", canonical_owner: "story_registry", mirrors: ["program_story_refs"] },
  { surface: "remote_issue_pr_state", canonical_owner: "fresh_remote_snapshot", mirrors: ["program_external_refs"] },
  { surface: "branch_state", canonical_owner: "git_refs", mirrors: ["branch_census"] },
  { surface: "audit_freshness", canonical_owner: "audit_log_plus_git_distance", mirrors: [] },
  { surface: "ontology", canonical_owner: "derived_verifier", mirrors: [] },
]);

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function lower(value) {
  return asString(value).toLowerCase();
}

function normalizedPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function safeJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value, length = 24) {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, length);
}

function parseTime(value) {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotUsability(snapshot, { nowMs, requiredCoverage = null } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { usable: false, reason: "missing" };
  }
  if (snapshot.complete !== true) return { usable: false, reason: "partial" };
  const collectedAt = parseTime(snapshot.collected_at);
  const explicitExpiry = parseTime(snapshot.expires_at);
  if (collectedAt === null) return { usable: false, reason: "collected_at_invalid" };
  const expiresAt = explicitExpiry ?? (collectedAt + DEFAULT_SNAPSHOT_MAX_AGE_MS);
  if (expiresAt <= nowMs) return { usable: false, reason: "expired" };
  if (requiredCoverage) {
    for (const key of requiredCoverage) {
      if (snapshot.query_coverage?.[key] !== true) return { usable: false, reason: `coverage_missing:${key}` };
    }
  }
  return { usable: true, reason: null, collected_at: snapshot.collected_at, expires_at: new Date(expiresAt).toISOString() };
}

function findingId(kind, subject) {
  return `TC-${kind.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${digest({ kind, subject }, 12).toUpperCase()}`;
}

function actionId(kind, target) {
  return `TA-${kind.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${digest({ kind, target }, 12).toUpperCase()}`;
}

function makeFinding({ kind, subject, disposition, message, authority, evidence = null }) {
  return {
    id: findingId(kind, subject),
    kind,
    subject,
    disposition,
    message,
    authority,
    evidence,
  };
}

function makeAction({ kind, target, payload = null, preconditions = null, sourceFinding, confirmationRequired = false }) {
  return {
    id: actionId(kind, target),
    kind,
    target,
    payload,
    preconditions,
    source_finding: sourceFinding,
    confirmation_required: confirmationRequired,
  };
}

function sortUniqueById(values) {
  return [...new Map(values.map((value) => [value.id, value])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function collectStoryRefs(value, path = "$", rows = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStoryRefs(entry, `${path}[${index}]`, rows));
    return rows;
  }
  if (!value || typeof value !== "object") return rows;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (key === "story_refs" && Array.isArray(entry)) {
      entry.forEach((ref, index) => {
        const storyId = asString(ref);
        if (storyId) rows.push({ story_id: storyId, path: `${nextPath}[${index}]` });
      });
      continue;
    }
    collectStoryRefs(entry, nextPath, rows);
  }
  return rows;
}

function issueRefRows(program) {
  const rows = [];
  for (const ticket of asArray(program?.packet?.tickets)) {
    for (const ref of asArray(ticket?.external_refs)) {
      if (lower(ref?.kind) !== "github_issue") continue;
      const number = Number(ref?.issue_number ?? ref?.number);
      const repo = lower(ref?.repo || ref?.repository);
      if (!repo || !Number.isInteger(number) || number <= 0) continue;
      rows.push({
        program_id: asString(program?.packet?.id),
        ticket_id: asString(ticket?.id),
        lifecycle: effectiveTicketLifecycle(ticket?.lifecycle),
        repo,
        number,
        cached_state: lower(ref?.state),
      });
    }
  }
  return rows;
}

function effectiveRemoteMode(packet) {
  try {
    return resolveProgramPacketRemoteMode(packet);
  } catch {
    return lower(packet?.remote_mode || packet?.remoteMode) || "unknown";
  }
}

function normalizeScope(scope) {
  const kind = lower(scope?.kind || scope);
  if (kind === "repository") return { kind: "repository", program_id: null };
  if (kind === "program") return { kind: "program", program_id: asString(scope?.program_id) || null };
  return { kind: "none", program_id: null };
}

function scopePrograms(programs, scope) {
  if (scope.kind !== "program" || !scope.program_id) return programs;
  return programs.filter((entry) => asString(entry?.packet?.id) === scope.program_id);
}

function programGateForStatus(status) {
  if (status === "executing") return "execution-to-program-validate";
  if (status === "validating") return "validate-to-program-close";
  if (status === "design") return "design-to-ready";
  if (status === "ready") return "ready-to-execution";
  return null;
}

function programCloseEvidenceSatisfied(packet) {
  const programId = asString(packet?.id);
  const rows = asArray(packet?.verification_matrix).filter((row) =>
    lower(row?.scope) === "program" || asString(row?.subject_ref) === programId);
  if (rows.length === 0) return false;
  return rows.every((row) => (
    normalizeVerificationStatus(row?.result || row?.status || row?.outcome, "program").satisfies
  ));
}

function shouldRequireRemote(scope, programs, issueRefs) {
  if (issueRefs.length === 0) return false;
  return programs.some((entry) => effectiveRemoteMode(entry.packet) === "remote-sync");
}

function evaluatePrograms({ programs, allProgramPackets, storyIds, remoteSnapshot, remoteUsability, remoteRequired, findings, actions }) {
  for (const program of programs) {
    const packet = program.packet || {};
    const programId = asString(packet.id) || normalizedPath(program.path) || "unknown-program";
    const status = lower(packet.status);
    const tickets = asArray(packet.tickets);
    const activeTickets = tickets.filter((ticket) => ACTIVE_TICKET_LIFECYCLES.has(effectiveTicketLifecycle(ticket?.lifecycle)));

    const externalPrerequisites = evaluateExternalPrerequisites(packet, { programPackets: allProgramPackets });
    for (const blocker of externalPrerequisites.blockers) {
      findings.push(makeFinding({
        kind: "external_prerequisite_unsatisfied",
        subject: {
          program_id: programId,
          ticket_id: blocker.ticket_id,
          prerequisite_program_id: blocker.program_ref,
          prerequisite_ticket_id: blocker.ticket_ref,
          required_status: blocker.required_status,
          required_lifecycle: blocker.required_lifecycle,
          observed: blocker.observed,
          code: blocker.code,
        },
        disposition: "actionable",
        message: blocker.message,
        authority: "program_packet",
      }));
    }

    for (const ref of collectStoryRefs(packet)) {
      if (storyIds.has(ref.story_id)) continue;
      const subject = { program_id: programId, story_id: ref.story_id, path: ref.path };
      findings.push(makeFinding({
        kind: "unknown_story_ref",
        subject,
        disposition: "actionable",
        message: `${programId} references unknown story ${ref.story_id} at ${ref.path}`,
        authority: "story_registry",
      }));
    }

    if (ACTIVE_PROGRAM_STATUSES.has(status) && tickets.length > 0 && activeTickets.length === 0) {
      if (status === "validating" && !programCloseEvidenceSatisfied(packet)) {
        findings.push(makeFinding({
          kind: "program_validation_pending",
          subject: { program_id: programId, status, terminal_ticket_count: tickets.length },
          disposition: "advisory",
          message: `${programId} is honestly validating until its Program-level proof passes or is waived`,
          authority: "program_manager_gate",
        }));
        continue;
      }
      const gate = programGateForStatus(status);
      const drift = makeFinding({
        kind: "program_status_ticket_lattice_drift",
        subject: { program_id: programId, status, terminal_ticket_count: tickets.length },
        disposition: "actionable",
        message: `${programId} is ${status} with zero actionable tickets`,
        authority: "program_manager_gate",
      });
      findings.push(drift);
      if (gate) {
        actions.push(makeAction({
          kind: "program_gate",
          target: { program_id: programId, program_path: normalizedPath(program.path) },
          payload: { gate },
          preconditions: { current_status: status, active_ticket_count: 0 },
          sourceFinding: drift.id,
        }));
      }
    }
  }

  if (!remoteRequired || !remoteUsability.usable) return;

  const snapshotRepo = lower(remoteSnapshot.repository || remoteSnapshot.repo);
  const remoteByKey = new Map(asArray(remoteSnapshot.issues).map((issue) => {
    const repo = lower(issue?.repo || issue?.repository || snapshotRepo);
    const number = Number(issue?.number ?? issue?.issue_number);
    return [`${repo}#${number}`, { ...issue, repo, number, state: lower(issue?.state) }];
  }));

  for (const ref of programs.flatMap(issueRefRows)) {
    const remote = remoteByKey.get(`${ref.repo}#${ref.number}`);
    if (!remote) {
      findings.push(makeFinding({
        kind: "remote_issue_observation_missing",
        subject: { repo: ref.repo, issue_number: ref.number, ticket_id: ref.ticket_id },
        disposition: "indeterminate",
        message: `Fresh snapshot does not cover ${ref.repo}#${ref.number}`,
        authority: "fresh_remote_snapshot",
      }));
      continue;
    }
    const localTerminal = TERMINAL_TICKET_LIFECYCLES.has(ref.lifecycle);
    const remoteOpen = remote.state === "open";
    const remoteClosed = remote.state === "closed";
    if (localTerminal && remoteOpen) {
      const deferred = ref.lifecycle === "deferred" || ref.lifecycle === "blocked";
      const drift = makeFinding({
        kind: "local_terminal_remote_open",
        subject: { repo: ref.repo, issue_number: ref.number, program_id: ref.program_id, ticket_id: ref.ticket_id, lifecycle: ref.lifecycle },
        disposition: deferred ? "acknowledged_deferred" : "actionable",
        message: `${ref.ticket_id} is locally ${ref.lifecycle} while ${ref.repo}#${ref.number} is open`,
        authority: "program_packet_local_lifecycle",
        evidence: { remote_state: remote.state, snapshot_collected_at: remoteSnapshot.collected_at },
      });
      findings.push(drift);
      if (!deferred) {
        actions.push(makeAction({
          kind: "github_issue_close",
          target: { repo: ref.repo, issue_number: ref.number },
          payload: { state: "closed", source_ticket: ref.ticket_id },
          preconditions: { remote_state: "open", local_lifecycle: ref.lifecycle, snapshot_expires_at: remoteUsability.expires_at },
          sourceFinding: drift.id,
          confirmationRequired: true,
        }));
      }
    } else if (!localTerminal && remoteClosed) {
      const conflict = makeFinding({
        kind: "remote_closed_local_nonterminal",
        subject: { repo: ref.repo, issue_number: ref.number, program_id: ref.program_id, ticket_id: ref.ticket_id, lifecycle: ref.lifecycle },
        disposition: "actionable",
        message: `${ref.repo}#${ref.number} is closed while ${ref.ticket_id} is locally ${ref.lifecycle}`,
        authority: "program_packet_local_lifecycle",
        evidence: { remote_state: remote.state, snapshot_collected_at: remoteSnapshot.collected_at },
      });
      findings.push(conflict);
      actions.push(makeAction({
        kind: "program_ticket_review",
        target: { program_id: ref.program_id, ticket_id: ref.ticket_id },
        payload: { observed_remote_state: "closed" },
        preconditions: { local_lifecycle: ref.lifecycle, snapshot_expires_at: remoteUsability.expires_at },
        sourceFinding: conflict.id,
      }));
    }
  }
}

function evaluateAudits(auditSignal, findings, actions) {
  for (const required of asArray(auditSignal?.required_actions)) {
    const auditType = asString(required?.audit_type) || "unknown";
    const drift = makeFinding({
      kind: "required_audit_stale",
      subject: { audit_type: auditType },
      disposition: "actionable",
      message: asString(required?.reason) || `${auditType} audit is stale`,
      authority: "audit_log_plus_git_distance",
    });
    findings.push(drift);
    actions.push(makeAction({
      kind: "run_workflow",
      target: { audit_type: auditType },
      payload: { workflow: asString(required?.workflow) || null },
      sourceFinding: drift.id,
    }));
  }
  for (const advisory of asArray(auditSignal?.advisory_actions)) {
    findings.push(makeFinding({
      kind: "audit_recommended",
      subject: { audit_type: asString(advisory?.audit_type) || "unknown" },
      disposition: "advisory",
      message: asString(advisory?.reason) || "Audit recommended",
      authority: "audit_log_plus_git_distance",
    }));
  }
}

function unusableSnapshotFinding(surface, usability) {
  return makeFinding({
    kind: `${surface}_snapshot_unusable`,
    subject: { surface, reason: usability.reason },
    disposition: "indeterminate",
    message: `Required ${surface} snapshot is ${usability.reason}`,
    authority: surface === "remote" ? "fresh_remote_snapshot" : (surface === "branch" ? "git_refs" : "fresh_remote_snapshot"),
  });
}

function evaluateRepositorySurfaces({ planSnapshot, branchSnapshot, prSnapshot, nowMs, findings, actions }) {
  if (!planSnapshot || planSnapshot.complete !== true) {
    findings.push(makeFinding({
      kind: "plan_snapshot_unusable",
      subject: { reason: planSnapshot ? "partial" : "missing" },
      disposition: "indeterminate",
      message: "Canonical top-level plan snapshot is missing or incomplete",
      authority: "top_level_state_json",
    }));
  } else {
    for (const plan of asArray(planSnapshot.plans)) {
      const state = lower(plan?.state);
      if (plan?.current === true || state === "close" || state === "closed" || state === "abandoned") continue;
      const drift = makeFinding({
        kind: "orphan_plan",
        subject: { plan_id: asString(plan?.id), state },
        disposition: lower(plan?.disposition) === "acknowledged_deferred" ? "acknowledged_deferred" : "actionable",
        message: `Noncurrent canonical plan ${asString(plan?.id)} remains ${state}`,
        authority: "top_level_state_json",
      });
      findings.push(drift);
      if (drift.disposition === "actionable") {
        actions.push(makeAction({
          kind: "plan_disposition_review",
          target: { plan_id: asString(plan?.id) },
          payload: { observed_state: state },
          sourceFinding: drift.id,
        }));
      }
    }
  }

  const branchUsability = snapshotUsability(branchSnapshot, { nowMs });
  if (!branchUsability.usable) {
    findings.push(unusableSnapshotFinding("branch", branchUsability));
  } else {
    for (const branch of asArray(branchSnapshot.branches)) {
      const name = asString(branch?.name);
      const classification = asString(branch?.classification).toUpperCase() || "UNKNOWN";
      const explicitDisposition = lower(branch?.disposition);
      if (explicitDisposition === "acknowledged_deferred" || explicitDisposition === "advisory") {
        findings.push(makeFinding({
          kind: "branch_disposition_required",
          subject: { branch: name, classification },
          disposition: explicitDisposition,
          message: `${name} is ${classification} (${explicitDisposition})`,
          authority: "git_refs",
        }));
      } else if (BRANCH_DELETE_CANDIDATE_CLASSES.has(classification) || explicitDisposition === "actionable") {
        const drift = makeFinding({
          kind: "branch_cleanup_candidate",
          subject: { branch: name, classification },
          disposition: "actionable",
          message: `${name} is a ${classification} remote cleanup candidate`,
          authority: "git_refs",
        });
        findings.push(drift);
        actions.push(makeAction({
          kind: "remote_branch_delete",
          target: { branch: name },
          payload: { classification },
          preconditions: { snapshot_expires_at: branchUsability.expires_at },
          sourceFinding: drift.id,
          confirmationRequired: true,
        }));
      } else {
        findings.push(makeFinding({
          kind: "branch_disposition_required",
          subject: { branch: name, classification },
          disposition: "indeterminate",
          message: `${name} requires an explicit disposition (${classification})`,
          authority: "git_refs",
        }));
      }
    }
  }

  const prUsability = snapshotUsability(prSnapshot, { nowMs });
  if (!prUsability.usable) {
    findings.push(unusableSnapshotFinding("pr", prUsability));
  } else {
    for (const pr of asArray(prSnapshot.pull_requests)) {
      if (lower(pr?.state) !== "open") continue;
      const target = { repo: lower(pr?.repo || prSnapshot.repository), number: Number(pr?.number) };
      if (pr?.head_in_main === true) {
        const drift = makeFinding({
          kind: "pr_head_already_in_main",
          subject: target,
          disposition: "actionable",
          message: `${target.repo}#${target.number} is open although its head is in main`,
          authority: "fresh_remote_snapshot",
        });
        findings.push(drift);
        actions.push(makeAction({
          kind: "github_pr_close",
          target,
          payload: { state: "closed", reason: "head_already_in_main" },
          preconditions: { remote_state: "open", snapshot_expires_at: prUsability.expires_at },
          sourceFinding: drift.id,
          confirmationRequired: true,
        }));
      } else {
        findings.push(makeFinding({
          kind: "pr_disposition_required",
          subject: target,
          disposition: lower(pr?.disposition) === "acknowledged_deferred" ? "acknowledged_deferred" : "indeterminate",
          message: `${target.repo}#${target.number} requires explicit merge/extract/close disposition`,
          authority: "fresh_remote_snapshot",
        }));
      }
    }
  }
}

export function evaluateTruthSurfaceConvergence(input = {}) {
  const scope = normalizeScope(input.scope);
  if (scope.kind === "none") {
    const base = {
      version: 1,
      generated_at: asString(input.now) || new Date().toISOString(),
      required: false,
      satisfied: true,
      status: "not_required",
      scope,
      authority_matrix: AUTHORITY_MATRIX,
      observations: {},
      findings: [],
      blockers: [],
      actions: [],
      input_digest: digest({ scope }),
    };
    return { ...base, receipt_id: digest({ ...base, generated_at: undefined, receipt_id: undefined }) };
  }

  const now = asString(input.now) || new Date().toISOString();
  const nowMs = parseTime(now) ?? Date.now();
  const storyIds = new Set(asArray(input.story_ids).map(asString).filter(Boolean));
  const allProgramPackets = asArray(input.programs).map((entry) => entry?.packet || entry).filter(Boolean);
  const programs = scopePrograms(asArray(input.programs), scope);
  const issueRefs = programs.flatMap(issueRefRows);
  const remoteRequired = shouldRequireRemote(scope, programs, issueRefs);
  const remoteUsability = snapshotUsability(input.remote_snapshot, {
    nowMs,
    requiredCoverage: remoteRequired ? ["issues"] : null,
  });
  const findings = [];
  const actions = [];

  if (remoteRequired && !remoteUsability.usable) {
    findings.push(unusableSnapshotFinding("remote", remoteUsability));
  }

  evaluatePrograms({
    programs,
    allProgramPackets,
    storyIds,
    remoteSnapshot: input.remote_snapshot,
    remoteUsability,
    remoteRequired,
    findings,
    actions,
  });
  evaluateAudits(input.audit_signal, findings, actions);
  if (scope.kind === "repository") {
    evaluateRepositorySurfaces({
      planSnapshot: input.plan_snapshot,
      branchSnapshot: input.branch_snapshot,
      prSnapshot: input.pr_snapshot,
      nowMs,
      findings,
      actions,
    });
  }

  const sortedFindings = sortUniqueById(findings);
  const sortedActions = sortUniqueById(actions);
  const blockers = sortedFindings
    .filter((entry) => entry.disposition === "actionable" || entry.disposition === "indeterminate")
    .map((entry) => entry.id)
    .sort();
  const indeterminate = sortedFindings.some((entry) => entry.disposition === "indeterminate");
  const satisfied = blockers.length === 0;
  const status = satisfied ? "converged" : (indeterminate ? "indeterminate" : "drift");
  const inputMaterial = {
    scope,
    programs,
    external_program_authorities: allProgramPackets,
    story_ids: [...storyIds].sort(),
    remote_snapshot: input.remote_snapshot || null,
    audit_signal: input.audit_signal || null,
    plan_snapshot: input.plan_snapshot || null,
    branch_snapshot: input.branch_snapshot || null,
    pr_snapshot: input.pr_snapshot || null,
  };
  const report = {
    version: 1,
    generated_at: now,
    required: true,
    satisfied,
    status,
    scope,
    authority_matrix: AUTHORITY_MATRIX,
    observations: {
      program_count: programs.length,
      ticket_count: programs.reduce((sum, entry) => sum + asArray(entry?.packet?.tickets).length, 0),
      story_registry_count: storyIds.size,
      mirrored_issue_count: issueRefs.length,
      remote_required: remoteRequired,
      remote_snapshot_status: remoteRequired ? (remoteUsability.usable ? "fresh" : remoteUsability.reason) : "not_required",
      finding_count: sortedFindings.length,
      blocker_count: blockers.length,
      action_count: sortedActions.length,
    },
    findings: sortedFindings,
    blockers,
    actions: sortedActions,
    input_digest: digest(inputMaterial),
  };
  return { ...report, receipt_id: digest({ ...report, generated_at: undefined, receipt_id: undefined }) };
}

export function writeTruthSurfaceReceipt(path, report) {
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  const current = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (current !== null) {
    try {
      const existing = JSON.parse(current);
      if (existing?.receipt_id && existing.receipt_id === report?.receipt_id) {
        return { written: false, path, receipt_id: report.receipt_id, reason: "unchanged_receipt_id" };
      }
    } catch {
      // Invalid existing bytes are replaced by the verified receipt below.
    }
    if (current === bytes) return { written: false, path, receipt_id: report?.receipt_id || null, reason: "unchanged_bytes" };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, "utf-8");
  return { written: true, path, receipt_id: report?.receipt_id || null, reason: current === null ? "created" : "updated" };
}

export function deriveTruthSurfaceScope({ stateJson = null, planContent = "" } = {}) {
  const contract = String(planContent || "").match(/## Truth Surface Convergence Contract\s*([\s\S]*?)(?=\n## |$)/i)?.[1] || "";
  const explicit = contract.match(/(?:^|\n)\s*-?\s*Scope:\s*`?([a-z-]+)`?/i)?.[1]?.toLowerCase();
  if (explicit === "repository") return { kind: "repository" };
  if (explicit === "none" || explicit === "not_required") return { kind: "none" };
  const programId = asString(stateJson?.program_context?.program_id || stateJson?.program_context?.program);
  if (explicit === "program" || programId) return { kind: "program", program_id: programId || null };
  return { kind: "none" };
}

function collectCanonicalPlanSnapshot(cwd, activePlanDirName = null) {
  const plansDir = join(cwd, "plans");
  if (!existsSync(plansDir)) return { complete: false, plans: [] };
  try {
    const plans = readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
      .map((entry) => {
        const state = safeJson(join(plansDir, entry.name, "state.json"));
        if (!state) return null;
        const abandoned = asArray(state.transitions).at(-1)?.marker === "[ABANDONED]";
        return {
          id: entry.name,
          state: abandoned ? "abandoned" : lower(state.state),
          current: entry.name === activePlanDirName,
        };
      })
      .filter(Boolean);
    return { complete: true, plans };
  } catch {
    return { complete: false, plans: [] };
  }
}

function loadPrograms(cwd, scope, stateJson) {
  let paths = listProgramPacketPaths(cwd);
  const scopedPath = asString(stateJson?.program_context?.program_packet_path);
  if (scope.kind === "program" && scopedPath) paths = [join(cwd, scopedPath)];
  return paths.map((path) => ({
    path: normalizedPath(relative(cwd, path)),
    packet: safeJson(path),
  })).filter((entry) => entry.packet);
}

function loadStoryIds(cwd) {
  const registry = safeJson(join(cwd, "reports", "user_story_audit", "story_registry.json"));
  return asArray(registry?.stories).map((story) => asString(story?.id)).filter(Boolean);
}

function loadSnapshot(planDir, filename, explicit) {
  if (explicit && typeof explicit === "object") return explicit;
  const explicitPath = asString(explicit);
  return safeJson(explicitPath || join(planDir, "artifacts", "truth_surface", filename));
}

export function collectTruthSurfaceInputs({
  cwd = process.cwd(),
  planDir,
  stateJson = null,
  planContent = "",
  scope = null,
  now = null,
  remoteSnapshot = null,
  branchSnapshot = null,
  prSnapshot = null,
  auditSignal = null,
  planSnapshot = null,
} = {}) {
  const resolvedScope = scope ? normalizeScope(scope) : deriveTruthSurfaceScope({ stateJson, planContent });
  const activePlanDirName = planDir ? normalizedPath(planDir).split("/").at(-1) : null;
  return {
    now: asString(now) || new Date().toISOString(),
    scope: resolvedScope,
    programs: resolvedScope.kind === "none" ? [] : loadPrograms(cwd, resolvedScope, stateJson),
    story_ids: resolvedScope.kind === "none" ? [] : loadStoryIds(cwd),
    remote_snapshot: resolvedScope.kind === "none" ? null : loadSnapshot(planDir, "remote_snapshot.json", remoteSnapshot),
    audit_signal: resolvedScope.kind === "none" ? null : (auditSignal || computeAuditFreshnessSignal({ cwd })),
    plan_snapshot: resolvedScope.kind === "repository"
      ? (planSnapshot || collectCanonicalPlanSnapshot(cwd, activePlanDirName))
      : null,
    branch_snapshot: resolvedScope.kind === "repository" ? loadSnapshot(planDir, "branch_snapshot.json", branchSnapshot) : null,
    pr_snapshot: resolvedScope.kind === "repository" ? loadSnapshot(planDir, "pr_snapshot.json", prSnapshot) : null,
  };
}

export function computeTruthSurfaceConvergenceSignal(options = {}) {
  return evaluateTruthSurfaceConvergence(collectTruthSurfaceInputs(options));
}
