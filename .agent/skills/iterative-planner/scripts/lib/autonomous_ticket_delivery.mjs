// Production real-ticket autonomous delivery orchestrator.
// @planner:module = autonomous_ticket_delivery
// @planner:capability = production_program_ticket_delivery
// @planner:proves = crit:sc_2, crit:sc_3, crit:sc_5

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, posix, relative, resolve } from "path";
import { isolatedAgentEnvironment } from "./autonomous_dogfood_run.mjs";
import { buildLifecycleReconciliationReport } from "./lifecycle_reconciler.mjs";
import {
  effectiveTicketLifecycle,
  resolveProgramPacketRemotePolicy,
  ticketHasGithubIssueMirror,
} from "./program_packet.mjs";
import { gradeTaskArtifact } from "./task_rubric_grader.mjs";
import { validateWorkOrder } from "./work_order_contract.mjs";

export const AUTONOMOUS_TICKET_DELIVERY_SCHEMA = "ive.autonomous_ticket_delivery.v1";
export const DEFAULT_AUTONOMOUS_TICKET_RECEIPT_ROOT = "reports/ive/autonomous_ticket_deliveries";
export const DEFAULT_AUTONOMOUS_TICKET_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_AUTONOMOUS_TICKET_MAX_TOTAL_TOKENS = 200000;
export const DEFAULT_AUTONOMOUS_TICKET_MAX_CHANGED_FILES = 25;
export const DEFAULT_AUTONOMOUS_TICKET_MAX_DIFF_LINES = 2500;

const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const DELIVERY_HASHED_ARTIFACTS = [
  "work_order.json",
  "preflight.json",
  "agent_diagnostics.json",
  "dispatch.json",
  "diff.json",
  "budget.json",
  "grade.json",
  "close_evidence.json",
];
const LEGACY_DELIVERY_HASHED_ARTIFACTS = DELIVERY_HASHED_ARTIFACTS.filter((name) => !["preflight.json", "agent_diagnostics.json"].includes(name));

function clean(value) {
  return String(value || "").trim();
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

function slash(value) {
  return String(value || "").replaceAll("\\", "/");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

function hashFile(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

export function buildDeliveryArtifactHashes(artifactDir) {
  return Object.fromEntries(DELIVERY_HASHED_ARTIFACTS.map((name) => [name, hashFile(join(artifactDir, name))]));
}

export function assertDeliveryArtifactHashes(artifactDir, expected) {
  const observed = buildDeliveryArtifactHashes(artifactDir);
  const names = expected?.["preflight.json"] && expected?.["agent_diagnostics.json"]
    ? DELIVERY_HASHED_ARTIFACTS
    : LEGACY_DELIVERY_HASHED_ARTIFACTS;
  for (const name of names) {
    if (!expected?.[name] || observed[name] !== expected[name]) {
      throw new Error(`existing delivery artifact hash mismatch: ${name}; refusing replay`);
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function sameStableJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function run(command, args, cwd, options = {}) {
  const proc = spawnSync(command, args, {
    cwd,
    env: options.env || process.env,
    input: options.input,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return {
    exit_code: proc.error ? 1 : (proc.status ?? 1),
    timed_out: proc.error?.code === "ETIMEDOUT",
    stdout: proc.stdout || "",
    stderr: proc.stderr || proc.error?.message || "",
  };
}

function runGit(args, cwd, check = true) {
  const result = run("git", args, cwd);
  if (check && result.exit_code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function processUsageCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const input = number(candidate.input_tokens ?? candidate.inputTokens, NaN);
  const output = number(candidate.output_tokens ?? candidate.outputTokens, NaN);
  const cached = number(candidate.cached_input_tokens ?? candidate.cachedInputTokens, 0);
  const total = number(candidate.total_tokens ?? candidate.totalTokens, Number.isFinite(input) && Number.isFinite(output) ? input + output : NaN);
  if (!Number.isFinite(total)) return null;
  return {
    input_tokens: Number.isFinite(input) ? input : Math.max(0, total - (Number.isFinite(output) ? output : 0)),
    cached_input_tokens: Number.isFinite(cached) ? cached : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    total_tokens: total,
  };
}

export function parseUsageFromAgentOutput(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      const event = JSON.parse(text);
      if (!event || Array.isArray(event) || typeof event !== "object") continue;
      if (event.type !== "turn.completed") continue;
      const usage = processUsageCandidate(event.usage || event.token_usage || event.tokenUsage);
      if (usage) rows.push(usage);
    } catch {
      // Non-JSON transcript lines are deliberately irrelevant to outcome grading.
    }
  }
  return rows.at(-1) || null;
}

function safeDiagnosticToken(value) {
  const token = clean(value);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(token) ? token : null;
}

export function summarizeAgentDiagnostics({ stdout = "", stderr = "", exitCode = null, timedOut = false } = {}) {
  const eventTypes = {};
  const itemTypes = {};
  const commandExitCodes = {};
  const errorCodes = new Set();
  let eventCount = 0;
  let nonJsonLineCount = 0;
  for (const line of `${String(stdout || "")}\n${String(stderr || "")}`.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    let event;
    try {
      event = JSON.parse(value);
    } catch {
      nonJsonLineCount += 1;
      continue;
    }
    if (!event || Array.isArray(event) || typeof event !== "object") {
      nonJsonLineCount += 1;
      continue;
    }
    eventCount += 1;
    const eventType = safeDiagnosticToken(event.type) || "unknown";
    eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;
    const itemType = safeDiagnosticToken(event.item?.type);
    if (itemType) itemTypes[itemType] = (itemTypes[itemType] || 0) + 1;
    if (itemType === "command_execution" && Number.isInteger(Number(event.item?.exit_code))) {
      const code = String(Number(event.item.exit_code));
      commandExitCodes[code] = (commandExitCodes[code] || 0) + 1;
    }
    const errorCode = safeDiagnosticToken(event.error?.code || event.code);
    if (eventType === "error" && errorCode) errorCodes.add(errorCode);
  }
  const sortedRecord = (record) => Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
  return {
    schema_version: "ive.autonomous_ticket_agent_diagnostics.v1",
    exit_code: Number.isInteger(Number(exitCode)) ? Number(exitCode) : null,
    timed_out: timedOut === true,
    event_count: eventCount,
    non_json_line_count: nonJsonLineCount,
    event_types: sortedRecord(eventTypes),
    item_types: sortedRecord(itemTypes),
    command_exit_codes: sortedRecord(commandExitCodes),
    error_codes: [...errorCodes].sort(),
    usage: parseUsageFromAgentOutput(`${String(stdout || "")}\n${String(stderr || "")}`),
    transcript_content_persisted: false,
  };
}

export function compileTicketWorkOrder({ program, ticket, programPath, limits = {} } = {}) {
  const acceptanceRefs = new Set((ticket?.acceptance_criteria || []).map(clean).filter(Boolean));
  const verificationRefs = new Set((ticket?.verification_refs || []).map(clean).filter(Boolean));
  const acceptanceRows = (program?.acceptance_criteria || []).filter((entry) => (
    acceptanceRefs.has(clean(entry?.id)) || clean(entry?.subject_ref) === clean(ticket?.id)
  ));
  const verificationRows = (program?.verification_matrix || []).filter((entry) => (
    verificationRefs.has(clean(entry?.id))
    || clean(entry?.subject_ref) === clean(ticket?.id)
    || clean(entry?.ticket_ref) === clean(ticket?.id)
  ));
  const workOrder = {
    schema_version: 1,
    id: `wo_${slug(ticket?.id).replaceAll("-", "_")}`,
    goal: `Close the exact existing Program ticket ${clean(ticket?.id)} through sanctioned lifecycle tooling using already-shipped evidence; do not claim authorship of prior implementation.`,
    inputs: [
      { id: "program_packet", kind: "path", ref: clean(programPath), description: `Canonical local authority for ${clean(program?.id)}` },
      { id: "ticket", kind: "program_ticket", ref: clean(ticket?.id), description: clean(ticket?.title) },
      { id: "child_plan", kind: "plan", ref: clean(ticket?.child_plan?.plan_dir), description: "Existing governed implementation proof" },
    ],
    constraints: [
      "Work only on the exact selected ticket; do not create a replacement or demonstration ticket.",
      "Use Program Manager/lifecycle disposition tooling; do not hand-edit state.json.",
      "Do not edit the parent grader, production runner, their tests, or unrelated source.",
      "Do not merge, push, close GitHub issues, delete branches, or mutate external services.",
      "Commit the complete candidate change before returning.",
    ],
    claims_to_produce: [
      { id: "ticket_closed", statement: `Ticket ${clean(ticket?.id)} is canonically closed on reachable evidence.`, consumer: "parent task-rubric grader" },
      { id: "program_valid", statement: `Program ${clean(program?.id)} validates after the exact lifecycle transition.`, consumer: "truth-surface convergence" },
    ],
    proof_obligations: [
      { claim_id: "ticket_closed", method: "deterministic", check: "Program Packet lifecycle is closed and child plan state is CLOSE" },
      { claim_id: "program_valid", method: "executed", command: ["node", ".agent/skills/iterative-planner/scripts/program_manager.mjs", "check", "--program", clean(programPath), "--json"] },
    ],
    stop_conditions: [
      "Stop without mutation if the exact ticket cannot be found or its evidence is not reachable.",
      "Stop if sanctioned lifecycle tooling reports an indeterminate or blocking finding.",
      "Stop before any external or irreversible action.",
    ],
    budget: {
      max_tokens: number(limits.maxTotalTokens, DEFAULT_AUTONOMOUS_TICKET_MAX_TOTAL_TOKENS),
      token_budget_enforcement: "post_run_acceptance",
      hard_token_cap_enforced: false,
      max_cost_usd: 0,
      max_time_minutes: Math.max(1, Math.ceil(number(limits.timeoutMs, DEFAULT_AUTONOMOUS_TICKET_TIMEOUT_MS) / 60000)),
    },
    delivery_limits: {
      max_changed_files: number(limits.maxChangedFiles, DEFAULT_AUTONOMOUS_TICKET_MAX_CHANGED_FILES),
      max_diff_lines: number(limits.maxDiffLines, DEFAULT_AUTONOMOUS_TICKET_MAX_DIFF_LINES),
      automatic_retries: 0,
    },
    task_contract: {
      ticket: {
        id: clean(ticket?.id),
        title: clean(ticket?.title),
        type: clean(ticket?.type),
        lifecycle: clean(ticket?.lifecycle),
        problem: clean(ticket?.problem),
        story_refs: (ticket?.story_refs || []).map(clean).filter(Boolean),
        defect_refs: (ticket?.defect_refs || []).map(clean).filter(Boolean),
        gap_refs: (ticket?.gap_refs || []).map(clean).filter(Boolean),
        acceptance_criteria_refs: [...acceptanceRefs],
        verification_refs: [...verificationRefs],
        external_prerequisites: ticket?.external_prerequisites || [],
        child_plan: ticket?.child_plan || null,
      },
      acceptance_criteria: acceptanceRows,
      verification_matrix: verificationRows,
    },
  };
  const validation = validateWorkOrder(workOrder);
  if (!validation.ok) throw new Error(`generated work order is invalid: ${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  return workOrder;
}

export function runAutonomousTicketBatch({ candidates = [], maxTotalTokens, runCandidate, haltCheck = () => false } = {}) {
  const ceiling = number(maxTotalTokens, NaN);
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error("maxTotalTokens must be positive");
  if (typeof runCandidate !== "function") throw new Error("runCandidate is required");
  let used = 0;
  let exhausted = false;
  const runs = [];
  for (const candidate of candidates) {
    if (exhausted) {
      runs.push({ candidate_id: candidate?.id || null, status: "SKIPPED", reason: "budget_exhausted", used_tokens: 0, remaining_tokens: 0 });
      continue;
    }
    if (haltCheck()) {
      runs.push({ candidate_id: candidate?.id || null, status: "SKIPPED", reason: "halted", used_tokens: 0, remaining_tokens: Math.max(0, ceiling - used) });
      continue;
    }
    const result = runCandidate(candidate) || {};
    const consumed = number(result.usage?.total_tokens, 0);
    used += Math.max(0, consumed);
    exhausted = used > ceiling;
    runs.push({
      candidate_id: candidate?.id || null,
      ...result,
      status: exhausted ? "FAIL" : (result.status || "FAIL"),
      reason: exhausted ? "budget_exhausted" : (result.reason || null),
      used_tokens: consumed,
      remaining_tokens: Math.max(0, ceiling - used),
    });
  }
  return {
    schema_version: "ive.autonomous_ticket_budget_ledger.v1",
    token_budget_enforcement: "post_run_acceptance",
    hard_token_cap_enforced: false,
    max_total_tokens: ceiling,
    used_tokens: used,
    remaining_tokens: Math.max(0, ceiling - used),
    exhausted,
    runs,
  };
}

function defaultAllowedPaths(programPath, ticket) {
  return [
    slash(programPath),
    clean(ticket?.child_plan?.plan_dir) ? `${slash(ticket.child_plan.plan_dir)}/` : "",
    "reports/ive/lifecycle_dispositions/",
    `${DEFAULT_AUTONOMOUS_TICKET_RECEIPT_ROOT}/`,
  ].filter(Boolean);
}

function normalizedRepoPath(value) {
  const raw = slash(clean(value));
  if (!raw || raw === "." || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("allow paths must be repository-relative normalized paths");
  }
  const normalized = posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("allow paths must be repository-relative normalized paths");
  }
  return {
    path: normalized.replace(/\/$/, ""),
    directory: raw.endsWith("/"),
  };
}

export function resolveAllowedPaths(programPath, ticket, requestedPaths = null) {
  const defaults = defaultAllowedPaths(programPath, ticket).map(normalizedRepoPath);
  if (!requestedPaths?.length) return defaults.map((entry) => `${entry.path}${entry.directory ? "/" : ""}`);
  const resolved = requestedPaths.map(normalizedRepoPath);
  for (const candidate of resolved) {
    const withinDefault = defaults.some((boundary) => (
      candidate.path === boundary.path || (boundary.directory && candidate.path.startsWith(`${boundary.path}/`))
    ));
    if (!withinDefault) throw new Error(`allow path cannot widen the default write boundary: ${candidate.path}`);
  }
  return [...new Set(resolved.map((entry) => `${entry.path}${entry.directory ? "/" : ""}`))].sort();
}

function buildPrompt(workOrder) {
  return [
    "Work autonomously on the exact production Program ticket described below.",
    "The JSON work order is authoritative. Do not ask questions and do not broaden scope.",
    "Use the repository's sanctioned Program Manager and lifecycle-reconciliation commands.",
    "Run the relevant verification, commit the complete candidate, and return only after the worktree is clean.",
    "Never merge, push, delete a branch, edit GitHub, or edit the parent grader/runner/tests.",
    "",
    JSON.stringify(workOrder, null, 2),
    "",
  ].join("\n");
}

function parseStatusPaths(output) {
  return String(output || "").split("\0").filter(Boolean).map((entry) => slash(entry.slice(3))).filter(Boolean);
}

function diffLineCount(workspace, baseCommit, finalCommit) {
  const text = runGit(["diff", "--numstat", baseCommit, finalCommit, "--"], workspace).stdout;
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const [added, deleted] = line.split("\t");
    if (/^\d+$/.test(added)) total += Number(added);
    if (/^\d+$/.test(deleted)) total += Number(deleted);
  }
  return total;
}

function loadTargetState(workspace, programPath, ticketId) {
  const packet = readJson(join(workspace, programPath));
  const ticket = (packet.tickets || []).find((entry) => clean(entry?.id) === clean(ticketId)) || null;
  let childPlanState = null;
  if (clean(ticket?.child_plan?.plan_dir)) {
    try {
      const state = readJson(join(workspace, ticket.child_plan.plan_dir, "state.json"));
      childPlanState = state.state || state.current_state || null;
    } catch {
      childPlanState = null;
    }
  }
  return { packet, ticket, lifecycle: ticket?.lifecycle || null, child_plan_state: childPlanState };
}

export function evaluateAutonomousTicketPreflight({
  packet,
  ticket,
  programPath,
  childPlanState,
  lifecycleReport,
  lifecycleError = null,
} = {}) {
  const checks = [];
  const blockers = [];
  const addCheck = (id, ok, observed, detail, blockerCode = null) => {
    checks.push({ id, status: ok ? "PASS" : "FAIL", observed, detail });
    if (!ok && blockerCode) blockers.push({ code: blockerCode, detail });
  };
  const ticketId = clean(ticket?.id);
  const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
  const remotePolicy = resolveProgramPacketRemotePolicy(packet || {});
  const actionable = ["ready", "in_progress", "executing", "done"].includes(lifecycle);
  addCheck(
    "target_actionable",
    actionable,
    lifecycle || null,
    actionable
      ? `Ticket ${ticketId} is actionable.`
      : `Ticket ${ticketId || "unknown"} must be ready, in_progress, executing, or done before autonomous delivery.`,
    "production_preflight_target_not_actionable",
  );

  const childPlanDir = clean(ticket?.child_plan?.plan_dir);
  const childPlanClosed = !!childPlanDir && ["close", "closed"].includes(clean(childPlanState).toLowerCase());
  addCheck(
    "child_plan_closed",
    childPlanClosed,
    childPlanState || null,
    childPlanClosed
      ? `Declared child plan ${childPlanDir} is closed.`
      : `Ticket ${ticketId} needs a declared closed child plan before autonomous lifecycle delivery.`,
    "production_preflight_child_plan_not_closed",
  );

  const policySatisfied = remotePolicy.gate_satisfiability?.ok === true;
  addCheck(
    "remote_policy_resolved",
    policySatisfied,
    remotePolicy.effective_mode,
    policySatisfied
      ? `Program remote policy resolves to ${remotePolicy.effective_mode}.`
      : `Program remote policy is not gate-satisfiable for ${clean(packet?.id) || clean(programPath)}.`,
    "production_preflight_remote_policy_unresolved",
  );
  const mirrorRequired = remotePolicy.effective_mode === "remote-sync";
  const mirrorPresent = ticketHasGithubIssueMirror(ticket);
  addCheck(
    "ticket_github_issue_mirror",
    !mirrorRequired || mirrorPresent,
    mirrorPresent,
    !mirrorRequired || mirrorPresent
      ? (mirrorRequired ? `Ticket ${ticketId} has a GitHub issue mirror.` : "GitHub issue mirror is not required by local policy.")
      : `Remote-synced ticket ${ticketId} has no GitHub issue mirror; the isolated agent cannot create one within its local-only authority.`,
    "production_preflight_missing_github_issue",
  );

  const exactFinding = (lifecycleReport?.findings?.shipped_open || []).find((entry) => clean(entry?.ticket_id) === ticketId) || null;
  const planEvidence = (exactFinding?.evidence_chain || []).some((entry) => (
    entry?.kind === "declared_child_plan" && entry?.closes_lifecycle === true && ["close", "closed"].includes(clean(entry?.status).toLowerCase())
  ));
  const commitEvidence = (exactFinding?.evidence_chain || []).some((entry) => (
    entry?.kind === "git_commit"
      // proof-status-lint: exempt T-INTAKE-B07B8898 -- Lifecycle-reconciler Git commit evidence state, not an authored or executed verification outcome.
      && entry?.status === "verified"
      && !!clean(entry?.hash || entry?.commit)
  ));
  const lifecycleEvidenceComplete = !lifecycleError
    && exactFinding?.proposed_lifecycle === "closed"
    && planEvidence
    && commitEvidence;
  addCheck(
    "lifecycle_close_evidence",
    lifecycleEvidenceComplete,
    exactFinding ? { plan_evidence: planEvidence, commit_evidence: commitEvidence } : null,
    lifecycleEvidenceComplete
      ? `Lifecycle reconciler found complete closed-plan and reachable-commit evidence for ${ticketId}.`
      : `Lifecycle reconciliation cannot prove a complete close for ${ticketId}${lifecycleError ? `: ${clean(lifecycleError.message || lifecycleError)}` : "."}`,
    "production_preflight_lifecycle_evidence_incomplete",
  );

  const targetWarningCodes = [...new Set((lifecycleReport?.warnings || [])
    .filter((entry) => !childPlanDir || clean(entry?.path) === childPlanDir)
    .map((entry) => clean(entry?.code))
    .filter(Boolean))].sort();
  checks.push({
    id: "lifecycle_diagnostics",
    status: targetWarningCodes.length > 0 ? "WARN" : "PASS",
    observed: targetWarningCodes,
    detail: targetWarningCodes.length > 0
      ? `Lifecycle evidence has advisory diagnostics: ${targetWarningCodes.join(", ")}. Complete exact evidence remains authoritative.`
      : "Lifecycle evidence has no target-scoped diagnostics.",
  });

  return {
    schema_version: "ive.autonomous_ticket_preflight.v1",
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    invocation_allowed: blockers.length === 0,
    program_id: clean(packet?.id) || null,
    program_packet_path: slash(programPath),
    ticket_id: ticketId || null,
    remote_policy: {
      effective_mode: remotePolicy.effective_mode,
      mode_source: remotePolicy.mode_source,
      repository_status: remotePolicy.repository?.status || null,
      repository_slug: remotePolicy.repository?.slug || null,
      github_issue_mirror_required: mirrorRequired,
    },
    checks,
    blockers,
  };
}

export function buildDefaultVerificationInvocation(programPath) {
  return {
    command: process.execPath,
    args: [
      ".agent/skills/iterative-planner/scripts/program_manager.mjs",
      "check",
      "--program",
      slash(programPath),
      "--json",
    ],
    shell: false,
  };
}

function artifactRelative(repoRoot, path) {
  return slash(relative(resolve(repoRoot), resolve(path)));
}

function receiptIdentityPayload(receipt) {
  const payload = {
    schema_version: receipt.schema_version,
    receipt_type: receipt.receipt_type,
    program_id: receipt.program_id,
    program_packet_path: receipt.program_packet_path,
    ticket_id: receipt.ticket_id,
    base_commit: receipt.base_commit,
    candidate_branch: receipt.candidate_branch,
    final_commit: receipt.final_commit,
    outcome: receipt.outcome,
    grade: receipt.grade,
    budget: receipt.budget,
    invocation_count: receipt.invocation_count,
    actor: receipt.actor,
    actor_observed_by: receipt.actor_observed_by,
    countersign: receipt.countersign,
    human_touchpoints: receipt.human_touchpoints,
    fixture: receipt.fixture,
    automatic_retries: receipt.automatic_retries,
    artifact_hashes: receipt.artifact_hashes,
  };
  if (receipt.requested_candidate_branch !== undefined) {
    payload.requested_candidate_branch = receipt.requested_candidate_branch || null;
  }
  return payload;
}

export function assertReplayCandidateBranch({ root, candidateBranch, finalCommit, resolveBranch = null }) {
  if (!clean(finalCommit)) return;
  const branchCommit = clean(resolveBranch
    ? resolveBranch(candidateBranch)
    : runGit(["rev-parse", "--verify", `refs/heads/${candidateBranch}^{commit}`], root, false).stdout);
  if (branchCommit !== clean(finalCommit)) {
    throw new Error("existing delivery candidate branch no longer points to its countersigned final commit; refusing replay");
  }
}

export function failGradeForHarnessError(grade, error) {
  const prior = grade && typeof grade === "object" ? grade : {};
  return {
    ...prior,
    status: "FAIL",
    ok: false,
    score: 0,
    failures: [
      ...(Array.isArray(prior.failures) ? prior.failures : []),
      { code: "harness_error", detail: error?.message || String(error || "unknown harness error") },
    ],
    transcript_used_for_outcome: false,
  };
}

function replayExistingDelivery({
  root,
  artifactDir,
  workOrder,
  programId,
  ticketId,
  baseCommit,
  candidateBranch,
  agentCommand,
}) {
  const receiptPath = join(artifactDir, "receipt.json");
  const runReportPath = join(artifactDir, "run_report.json");
  const workOrderPath = join(artifactDir, "work_order.json");
  if (!existsSync(receiptPath) && !existsSync(runReportPath) && !existsSync(workOrderPath)) return null;
  if (![receiptPath, runReportPath, workOrderPath].every(existsSync)) {
    throw new Error("existing delivery artifact chain is incomplete; refusing a second agent invocation");
  }
  const receipt = readJson(receiptPath);
  const report = readJson(runReportPath);
  const storedWorkOrder = readJson(workOrderPath);
  const expectedReceiptId = sha256(JSON.stringify(stable(receiptIdentityPayload(receipt))));
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Production-delivery receipt outcome used to recognize a zero-invocation preflight block during idempotent replay.
  const preflightBlocked = receipt.outcome === "BLOCKED" && receipt.invocation_count === 0;
  const matches = receipt.schema_version === AUTONOMOUS_TICKET_DELIVERY_SCHEMA
    && receipt.receipt_type === "production_program_ticket_delivery"
    && receipt.program_id === programId
    && receipt.ticket_id === ticketId
    && receipt.base_commit === baseCommit
    && (preflightBlocked
      ? receipt.candidate_branch === null && receipt.requested_candidate_branch === candidateBranch
      : receipt.candidate_branch === candidateBranch && receipt.invocation_count === 1)
    && receipt.automatic_retries === 0
    && receipt.agent_transport?.command_fingerprint_sha256 === sha256(agentCommand)
    && receipt.receipt_id === expectedReceiptId
    && report.receipt_id === receipt.receipt_id
    && sameStableJson(storedWorkOrder, workOrder);
  if (!matches) throw new Error("existing delivery receipt does not match the immutable run identity; refusing a second agent invocation");
  if (receipt.final_commit && runGit(["cat-file", "-e", `${receipt.final_commit}^{commit}`], root, false).exit_code !== 0) {
    throw new Error("existing delivery receipt names an unavailable final commit; refusing a second agent invocation");
  }
  assertDeliveryArtifactHashes(artifactDir, receipt.artifact_hashes);
  if (!preflightBlocked) {
    assertReplayCandidateBranch({ root, candidateBranch: receipt.candidate_branch, finalCommit: receipt.final_commit });
  }
  return {
    status: receipt.outcome,
    ok: receipt.grade?.ok === true,
    reason: receipt.grade?.ok ? null : receipt.grade?.failures?.[0]?.code || "delivery_failed",
    work_order: storedWorkOrder,
    receipt,
    receipt_path: artifactRelative(root, receiptPath),
    run_report_path: artifactRelative(root, runReportPath),
    artifact_dir: artifactRelative(root, artifactDir),
    candidate_branch: receipt.candidate_branch,
    workspace: receipt.workspace,
  };
}

function finalizePreflightBlockedDelivery({
  root,
  artifactDir,
  workOrder,
  preflight,
  packet,
  ticket,
  programPath,
  baseCommit,
  effectiveBranch,
  agentCommand,
  startedAt,
  finishedAt,
  limits,
  target,
}) {
  const workOrderPath = join(artifactDir, "work_order.json");
  const preflightPath = join(artifactDir, "preflight.json");
  const diagnosticsPath = writeJson(join(artifactDir, "agent_diagnostics.json"), summarizeAgentDiagnostics());
  const budget = {
    schema_version: "ive.autonomous_ticket_budget_ledger.v1",
    token_budget_enforcement: "post_run_acceptance",
    hard_token_cap_enforced: false,
    max_total_tokens: limits.maxTotalTokens,
    used_tokens: 0,
    remaining_tokens: limits.maxTotalTokens,
    max_changed_files: limits.maxChangedFiles,
    changed_files: 0,
    max_diff_lines: limits.maxDiffLines,
    diff_lines: 0,
    automatic_retries: 0,
  };
  const grade = {
    schema_version: 1,
    status: "BLOCKED",
    ok: false,
    score: 0,
    failures: preflight.blockers,
    transcript_used_for_outcome: false,
  };
  const dispatchPath = writeJson(join(artifactDir, "dispatch.json"), {
    schema_version: 1,
    status: "BLOCKED",
    ticket_id: ticket.id,
    requested_candidate_branch: effectiveBranch,
    candidate_branch: null,
    base_commit: baseCommit,
    invocation_count: 0,
    command_fingerprint_sha256: sha256(agentCommand),
    started_at: startedAt,
    finished_at: finishedAt,
  });
  const diffPath = writeJson(join(artifactDir, "diff.json"), {
    schema_version: 1,
    base_commit: baseCommit,
    final_commit: null,
    changed_paths: [],
    diff_lines: 0,
  });
  const budgetPath = writeJson(join(artifactDir, "budget.json"), budget);
  const gradePath = writeJson(join(artifactDir, "grade.json"), grade);
  const closePath = writeJson(join(artifactDir, "close_evidence.json"), {
    schema_version: 1,
    ticket_id: ticket.id,
    actor: null,
    lifecycle: target.lifecycle,
    child_plan_state: target.child_plan_state,
    final_commit: null,
    parent_countersigned: false,
  });
  const artifactHashes = buildDeliveryArtifactHashes(artifactDir);
  const stableReceipt = {
    schema_version: AUTONOMOUS_TICKET_DELIVERY_SCHEMA,
    receipt_type: "production_program_ticket_delivery",
    program_id: packet.id,
    program_packet_path: slash(programPath),
    ticket_id: ticket.id,
    base_commit: baseCommit,
    candidate_branch: null,
    requested_candidate_branch: effectiveBranch,
    final_commit: null,
    outcome: "BLOCKED",
    grade,
    budget,
    invocation_count: 0,
    actor: "none",
    actor_observed_by: "parent_harness",
    countersign: { agent_self_graded: false, transcript_used_for_outcome: false, target_selected_by: "operator" },
    human_touchpoints: ["target_selection", "preflight_resolution"],
    fixture: false,
    automatic_retries: 0,
    artifact_hashes: artifactHashes,
  };
  const receiptId = sha256(JSON.stringify(stable(receiptIdentityPayload(stableReceipt))));
  const receipt = {
    ...stableReceipt,
    receipt_id: receiptId,
    started_at: startedAt,
    finished_at: finishedAt,
    preflight: { status: preflight.status, blocker_count: preflight.blockers.length },
    agent_transport: {
      command_fingerprint_sha256: sha256(agentCommand),
      stdout_bytes: 0,
      stderr_bytes: 0,
      stdout_sha256: sha256(""),
      stderr_sha256: sha256(""),
    },
    workspace: { retained: false, path: null, cleanup_reason: "preflight_blocked_before_workspace" },
  };
  const receiptPath = writeJson(join(artifactDir, "receipt.json"), receipt);
  const runReportPath = writeJson(join(artifactDir, "run_report.json"), {
    schema_version: 1,
    status: receipt.outcome,
    receipt_id: receipt.receipt_id,
    artifacts: [workOrderPath, preflightPath, diagnosticsPath, dispatchPath, diffPath, budgetPath, gradePath, closePath, receiptPath]
      .map((path) => artifactRelative(root, path)),
    human_touchpoints: receipt.human_touchpoints,
    remaining_unverified: ["agent execution skipped because deterministic prerequisites were unsatisfied"],
  });
  return {
    status: receipt.outcome,
    ok: false,
    reason: preflight.blockers[0]?.code || "production_preflight_blocked",
    work_order: workOrder,
    preflight,
    receipt,
    receipt_path: artifactRelative(root, receiptPath),
    run_report_path: artifactRelative(root, runReportPath),
    artifact_dir: artifactRelative(root, artifactDir),
    candidate_branch: null,
    workspace: receipt.workspace,
  };
}

export function runAutonomousTicketDelivery({
  repoRoot = process.cwd(),
  programPath,
  ticketId,
  agentCommand,
  verificationCommand = null,
  receiptRoot = DEFAULT_AUTONOMOUS_TICKET_RECEIPT_ROOT,
  workspaceParent = tmpdir(),
  timeoutMs = DEFAULT_AUTONOMOUS_TICKET_TIMEOUT_MS,
  maxTotalTokens = DEFAULT_AUTONOMOUS_TICKET_MAX_TOTAL_TOKENS,
  maxChangedFiles = DEFAULT_AUTONOMOUS_TICKET_MAX_CHANGED_FILES,
  maxDiffLines = DEFAULT_AUTONOMOUS_TICKET_MAX_DIFF_LINES,
  allowPaths = null,
  haltFile = null,
  keepWorkspace = false,
  branchName = null,
  now = () => new Date(),
  agentInvoker = null,
} = {}) {
  if (!clean(programPath) || !clean(ticketId) || !clean(agentCommand)) throw new Error("programPath, ticketId, and agentCommand are required");
  for (const [name, value] of [["timeoutMs", timeoutMs], ["maxTotalTokens", maxTotalTokens], ["maxChangedFiles", maxChangedFiles], ["maxDiffLines", maxDiffLines]]) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(`${name} must be positive`);
  }
  if (haltFile && existsSync(resolve(repoRoot, haltFile))) {
    return { status: "SKIPPED", ok: false, reason: "halted", invocation_count: 0, receipt: null, receipt_path: null };
  }

  const root = resolve(repoRoot);
  const packet = readJson(resolve(root, programPath));
  const ticket = (packet.tickets || []).find((entry) => clean(entry?.id) === clean(ticketId));
  if (!ticket) throw new Error(`ticket not found: ${ticketId}`);
  const limits = { maxTotalTokens: Number(maxTotalTokens), timeoutMs: Number(timeoutMs), maxChangedFiles: Number(maxChangedFiles), maxDiffLines: Number(maxDiffLines) };
  const workOrder = compileTicketWorkOrder({ program: packet, ticket, programPath: slash(programPath), limits });
  const allowedPaths = resolveAllowedPaths(slash(programPath), ticket, allowPaths);
  const baseCommit = clean(runGit(["rev-parse", "HEAD"], root).stdout);
  const runIdentity = {
    program: packet.id,
    ticket: ticket.id,
    base_commit: baseCommit,
    work_order: workOrder,
    limits,
    agent_command_fingerprint_sha256: sha256(agentCommand),
    verification_command_fingerprint_sha256: sha256(clean(verificationCommand) || "default_program_check"),
    allow_paths: allowedPaths,
    keep_workspace: keepWorkspace === true,
    requested_branch: clean(branchName) || null,
  };
  const runSeed = sha256(JSON.stringify(stable(runIdentity))).slice(0, 16);
  const effectiveBranch = clean(branchName) || `autocoder/${slug(ticket.id)}-${runSeed.slice(0, 8)}`;
  const artifactDir = resolve(root, receiptRoot, slug(ticket.id), runSeed);
  const replay = replayExistingDelivery({
    root,
    artifactDir,
    workOrder,
    programId: packet.id,
    ticketId: ticket.id,
    baseCommit,
    candidateBranch: effectiveBranch,
    agentCommand,
  });
  if (replay) return replay;
  const startedAt = now().toISOString();
  const workOrderPath = writeJson(join(artifactDir, "work_order.json"), workOrder);
  const initialTarget = loadTargetState(root, slash(programPath), ticket.id);
  let lifecycleReport = null;
  let lifecycleError = null;
  try {
    lifecycleReport = buildLifecycleReconciliationReport({
      cwd: root,
      program: slash(programPath),
      timestamp: startedAt,
      includeStampedArtifacts: true,
    });
  } catch (error) {
    lifecycleError = error;
  }
  const preflight = evaluateAutonomousTicketPreflight({
    packet,
    ticket,
    programPath: slash(programPath),
    childPlanState: initialTarget.child_plan_state,
    lifecycleReport,
    lifecycleError,
  });
  const preflightPath = writeJson(join(artifactDir, "preflight.json"), preflight);
  if (!preflight.invocation_allowed) {
    return finalizePreflightBlockedDelivery({
      root,
      artifactDir,
      workOrder,
      preflight,
      packet,
      ticket,
      programPath,
      baseCommit,
      effectiveBranch,
      agentCommand,
      startedAt,
      finishedAt: now().toISOString(),
      limits,
      target: initialTarget,
    });
  }

  const workspace = mkdtempSync(join(resolve(workspaceParent), `ive-autocoder-${slug(ticket.id)}-`));
  const immutablePaths = [
    ".agent/skills/iterative-planner/scripts/lib/task_rubric_grader.mjs",
    ".agent/skills/iterative-planner/scripts/lib/autonomous_ticket_delivery.mjs",
    ".agent/skills/iterative-planner/tests/test_autonomous_ticket_delivery.mjs",
  ];
  const beforeHashes = Object.fromEntries(immutablePaths.map((path) => [path, hashFile(resolve(root, path))]));
  let invocationCount = 0;
  let agent = { exit_code: null, timed_out: false, stdout: "", stderr: "" };
  let verification = { exit_code: null, timed_out: false, stdout: "", stderr: "" };
  let candidate = null;
  let grade = null;
  let retained = true;
  let cleanupReason = "diagnostic";

  try {
    runGit(["worktree", "add", "-b", effectiveBranch, workspace, baseCommit], root);
    invocationCount = 1;
    agent = agentInvoker
      ? agentInvoker({ command: agentCommand, cwd: workspace, prompt: buildPrompt(workOrder), timeoutMs, env: isolatedAgentEnvironment() })
      : run("/bin/sh", ["-lc", agentCommand], workspace, { input: buildPrompt(workOrder), timeoutMs, env: isolatedAgentEnvironment() });
    const finalCommit = clean(runGit(["rev-parse", "HEAD"], workspace).stdout);
    const statusOutput = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace).stdout;
    const worktreeClean = statusOutput.length === 0;
    const changedPaths = runGit(["diff", "--name-only", baseCommit, finalCommit, "--"], workspace).stdout.split(/\r?\n/).map(slash).filter(Boolean);
    const statusPaths = parseStatusPaths(statusOutput);
    const allChangedPaths = [...new Set([...changedPaths, ...statusPaths])].sort();
    const reachable = runGit(["merge-base", "--is-ancestor", finalCommit, "HEAD"], workspace, false).exit_code === 0 ? [finalCommit] : [];
    const target = loadTargetState(workspace, slash(programPath), ticket.id);
    if (clean(verificationCommand)) {
      verification = run("/bin/sh", ["-lc", verificationCommand], workspace, { timeoutMs });
    } else {
      const defaultVerify = buildDefaultVerificationInvocation(slash(programPath));
      verification = run(defaultVerify.command, defaultVerify.args, workspace, { timeoutMs });
    }
    const usage = parseUsageFromAgentOutput(`${agent.stdout || ""}\n${agent.stderr || ""}`);
    const afterHashes = Object.fromEntries(immutablePaths.map((path) => [path, hashFile(resolve(workspace, path))]));
    candidate = {
      ticket_id: ticket.id,
      base_commit: baseCommit,
      final_commit: finalCommit,
      reachable_commits: reachable,
      changed_paths: allChangedPaths,
      allowed_paths: allowedPaths,
      immutable_inputs: { before: beforeHashes, after: afterHashes },
      invocation_count: invocationCount,
      agent_exit_code: agent.exit_code,
      timed_out: agent.timed_out === true,
      worktree_clean: worktreeClean,
      tests: { status: verification.exit_code === 0 ? "PASS" : "FAIL", exit_code: verification.exit_code, stdout_sha256: sha256(verification.stdout || ""), stderr_sha256: sha256(verification.stderr || "") },
      target: { lifecycle: target.lifecycle, child_plan_state: target.child_plan_state },
      usage,
      evidence_refs: [slash(programPath), clean(ticket.child_plan?.plan_dir), `git:${finalCommit}`].filter(Boolean),
      diff_lines: diffLineCount(workspace, baseCommit, finalCommit),
      limits: { max_total_tokens: Number(maxTotalTokens), max_changed_files: Number(maxChangedFiles), max_diff_lines: Number(maxDiffLines) },
    };
    grade = gradeTaskArtifact(candidate);
    if (grade.ok && !keepWorkspace) {
      runGit(["worktree", "remove", workspace], root);
      retained = false;
      cleanupReason = "passing_committed_candidate_branch_retained";
    } else {
      cleanupReason = keepWorkspace ? "operator_requested" : "failed_candidate_retained_for_diagnosis";
    }
  } catch (error) {
    grade = failGradeForHarnessError(grade, error);
  }

  const finishedAt = now().toISOString();
  const diagnosticsPath = writeJson(join(artifactDir, "agent_diagnostics.json"), summarizeAgentDiagnostics({
    stdout: agent.stdout,
    stderr: agent.stderr,
    exitCode: agent.exit_code,
    timedOut: agent.timed_out,
  }));
  const observedTotalTokens = Number(candidate?.usage?.total_tokens);
  const budget = {
    schema_version: "ive.autonomous_ticket_budget_ledger.v1",
    token_budget_enforcement: "post_run_acceptance",
    hard_token_cap_enforced: false,
    max_total_tokens: Number(maxTotalTokens),
    used_tokens: Number.isFinite(observedTotalTokens) ? observedTotalTokens : null,
    remaining_tokens: Number.isFinite(observedTotalTokens) ? Math.max(0, Number(maxTotalTokens) - observedTotalTokens) : null,
    max_changed_files: Number(maxChangedFiles),
    changed_files: candidate?.changed_paths?.length ?? null,
    max_diff_lines: Number(maxDiffLines),
    diff_lines: candidate?.diff_lines ?? null,
    automatic_retries: 0,
  };
  const dispatchPath = writeJson(join(artifactDir, "dispatch.json"), {
    schema_version: 1,
    ticket_id: ticket.id,
    candidate_branch: effectiveBranch,
    requested_candidate_branch: effectiveBranch,
    base_commit: baseCommit,
    invocation_count: invocationCount,
    command_fingerprint_sha256: sha256(agentCommand),
    started_at: startedAt,
    finished_at: finishedAt,
  });
  const diffPath = writeJson(join(artifactDir, "diff.json"), { schema_version: 1, base_commit: baseCommit, final_commit: candidate?.final_commit || null, changed_paths: candidate?.changed_paths || [], diff_lines: candidate?.diff_lines ?? null });
  const budgetPath = writeJson(join(artifactDir, "budget.json"), budget);
  const gradePath = writeJson(join(artifactDir, "grade.json"), grade);
  const closePath = writeJson(join(artifactDir, "close_evidence.json"), { schema_version: 1, ticket_id: ticket.id, actor: "agent", lifecycle: candidate?.target?.lifecycle || null, child_plan_state: candidate?.target?.child_plan_state || null, final_commit: candidate?.final_commit || null, parent_countersigned: true });
  const artifactHashes = buildDeliveryArtifactHashes(artifactDir);
  const stableReceipt = {
    schema_version: AUTONOMOUS_TICKET_DELIVERY_SCHEMA,
    receipt_type: "production_program_ticket_delivery",
    program_id: packet.id,
    program_packet_path: slash(programPath),
    ticket_id: ticket.id,
    base_commit: baseCommit,
    candidate_branch: effectiveBranch,
    requested_candidate_branch: effectiveBranch,
    final_commit: candidate?.final_commit || null,
    outcome: grade?.status || "FAIL",
    grade,
    budget,
    invocation_count: invocationCount,
    actor: "agent",
    actor_observed_by: "parent_harness",
    countersign: { agent_self_graded: false, transcript_used_for_outcome: false, target_selected_by: "operator" },
    human_touchpoints: ["target_selection", "final_merge"],
    fixture: false,
    automatic_retries: 0,
    artifact_hashes: artifactHashes,
  };
  const receiptId = sha256(JSON.stringify(stable(receiptIdentityPayload(stableReceipt))));
  const receipt = {
    ...stableReceipt,
    receipt_id: receiptId,
    started_at: startedAt,
    finished_at: finishedAt,
    agent_transport: {
      command_fingerprint_sha256: sha256(agentCommand),
      stdout_bytes: Buffer.byteLength(agent.stdout || ""),
      stderr_bytes: Buffer.byteLength(agent.stderr || ""),
      stdout_sha256: sha256(agent.stdout || ""),
      stderr_sha256: sha256(agent.stderr || ""),
    },
    workspace: { retained, path: retained ? workspace : null, cleanup_reason: cleanupReason },
  };
  const receiptPath = writeJson(join(artifactDir, "receipt.json"), receipt);
  const runReportPath = writeJson(join(artifactDir, "run_report.json"), {
    schema_version: 1,
    status: receipt.outcome,
    receipt_id: receipt.receipt_id,
    artifacts: [workOrderPath, preflightPath, diagnosticsPath, dispatchPath, diffPath, budgetPath, gradePath, closePath, receiptPath].map((path) => artifactRelative(root, path)),
    human_touchpoints: receipt.human_touchpoints,
    remaining_unverified: ["general autonomous coding capability", "hostile operating-system sandbox escape"],
  });
  return {
    status: receipt.outcome,
    ok: grade?.ok === true,
    reason: grade?.ok ? null : grade?.failures?.[0]?.code || "delivery_failed",
    work_order: workOrder,
    receipt,
    receipt_path: artifactRelative(root, receiptPath),
    run_report_path: artifactRelative(root, runReportPath),
    artifact_dir: artifactRelative(root, artifactDir),
    candidate_branch: effectiveBranch,
    workspace: receipt.workspace,
  };
}
