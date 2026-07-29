// @planner:module = program_disposition
// @planner:capability = deterministic_program_backlog_disposition
// program_disposition.mjs — Evidence-gated Program Packet lifecycle disposition.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import {
  ADMINISTRATIVE_BACKLOG_DISPOSITION_CLASSIFICATIONS,
  effectiveTicketLifecycle,
  isSupportedAdministrativeBacklogDisposition,
  loadProgramPacket,
  programGithubIssueMirrorRequired,
  resolveProgramPacketPath,
  ticketHasGithubIssueMirror,
  validateAwaitingExternalAction,
  validateProgramPacket,
} from "./program_packet.mjs";
import { buildRepoStateStamp } from "./repo_state_stamp.mjs";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";
import {
  canonicalLifecyclePlanDir,
  planGoalReferencesTicket,
  readPlanDeliveryScope,
  verifyLifecycleCommitEvidence,
} from "./lifecycle_delivery_evidence.mjs";
import {
  loadProposedResolutionRequest,
  verifyPersistedProposedResolution,
} from "./program_resolution_evidence.mjs";

const CLOSED_STATES = new Set(["close", "closed"]);
const TERMINAL_LIFECYCLES = new Set(["closed", "verified", "deferred"]);
const SHIPPED_OPEN_ACTIONS = new Set(["pending_apply_closed", "would_apply_closed", "applied_closed"]);
const DEFERRED_ADMIN_CLOSE_ACTIONS = new Set(["pending_admin_close", "would_admin_close", "admin_closed"]);
const MAX_EXPECTED_EVIDENCE_BYTES = 512 * 1024;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lower(value) {
  return asString(value).toLowerCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(asString).filter(Boolean))];
}

function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function relPath(cwd, path) {
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const root = resolve(cwd);
  const rel = relative(root, abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return normalizeRepoPath(rel);

  const canonicalRoot = canonicalMaybeMissing(root);
  const canonicalAbs = canonicalMaybeMissing(abs);
  const canonicalRel = relative(canonicalRoot, canonicalAbs);
  return canonicalRel && !canonicalRel.startsWith("..") && !isAbsolute(canonicalRel)
    ? normalizeRepoPath(canonicalRel)
    : normalizeRepoPath(path);
}

function canonicalMaybeMissing(absPath) {
  const parts = [];
  let current = absPath;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absPath;
    parts.unshift(basename(current));
    current = parent;
  }
  try {
    const real = realpathSync(current);
    return parts.length > 0 ? join(real, ...parts) : real;
  } catch {
    return absPath;
  }
}

function resolvePath(cwd, path) {
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

function stampForIso(iso) {
  return iso.replace(/[-:]/g, "").replace(/\.(\d+)Z$/, "$1Z");
}

function slugifyReceiptComponent(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function hashReceiptIdentity(parts) {
  const normalized = uniqueStrings(parts).sort().join("\n") || "disposition";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function dispositionOutputIdentity({ cwd, fromRepairPacket, fromResolutionRequest, deferredPrograms }) {
  const parts = [];
  if (fromRepairPacket) parts.push(`repair:${relPath(cwd, fromRepairPacket)}`);
  if (fromResolutionRequest) parts.push(`resolution:${relPath(cwd, fromResolutionRequest)}`);
  for (const packetArg of deferredPrograms) {
    let packetPath = null;
    try {
      packetPath = resolveDeferredProgramPath(cwd, packetArg);
    } catch {
      packetPath = resolvePath(cwd, packetArg);
    }
    let packetId = "";
    if (packetPath && existsSync(packetPath)) {
      try {
        packetId = asString(readJsonFile(packetPath)?.id);
      } catch {
        packetId = "";
      }
    }
    parts.push(packetId ? `program:${packetId}` : `program_path:${relPath(cwd, packetPath || packetArg)}`);
  }
  return uniqueStrings(parts);
}

function uniqueJsonPath(dir, stem, avoidExisting) {
  let candidate = join(dir, `${stem}.json`);
  if (!avoidExisting) return candidate;
  for (let index = 2; existsSync(candidate); index++) {
    candidate = join(dir, `${stem}-${index}.json`);
  }
  return candidate;
}

function defaultOutputPath(cwd, timestamp, { identityParts = [], avoidExisting = false } = {}) {
  const dir = join(cwd, "reports", "ive", "lifecycle_dispositions");
  const slug = slugifyReceiptComponent(identityParts.join("-")) || "disposition";
  const hash = hashReceiptIdentity(identityParts);
  const stem = `lifecycle_disposition_${stampForIso(timestamp)}_${slug}_${hash}`;
  return uniqueJsonPath(dir, stem, avoidExisting);
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJsonFile(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function defaultGitRunner(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: options.timeout || 10000,
  });
}

function runGit(gitRunner, cwd, args, options = {}) {
  try {
    return gitRunner(cwd, args, options);
  } catch (error) {
    return { status: 1, stdout: "", stderr: error?.message || String(error) };
  }
}

function childStateFromObject(value) {
  return lower(value?.state || value?.status || value?.phase);
}

function readPlanEvidence(cwd, evidence, ticket) {
  const evidencePlanDir = canonicalLifecyclePlanDir(cwd, evidence?.path);
  const declaredPlanRaw = asString(ticket?.child_plan?.plan_dir);
  const declaredPlanProvided = !!declaredPlanRaw;
  const declaredPlanDir = canonicalLifecyclePlanDir(cwd, declaredPlanRaw);
  const pathAuthorized = !!evidencePlanDir && (
    !declaredPlanProvided || (!!declaredPlanDir && evidencePlanDir === declaredPlanDir)
  );
  const planDir = pathAuthorized ? evidencePlanDir : "";
  const statePath = planDir ? `${planDir}/state.json` : "";
  const absStatePath = statePath ? resolvePath(cwd, statePath) : null;
  let stateJson = null;
  let state = "";
  let statePathExists = false;
  const diagnostics = [];
  if (asString(evidence?.path) && !evidencePlanDir) diagnostics.push("canonical_supplied_plan_path_invalid");
  if (declaredPlanProvided && !declaredPlanDir) diagnostics.push("canonical_declared_plan_path_invalid");
  if (declaredPlanDir && evidencePlanDir && evidencePlanDir !== declaredPlanDir) diagnostics.push("canonical_declared_plan_path_mismatch");
  if (absStatePath && existsSync(absStatePath)) {
    statePathExists = true;
    try {
      stateJson = readJsonFile(absStatePath);
      state = childStateFromObject(stateJson);
    } catch {
      stateJson = null;
      diagnostics.push("canonical_state_json_invalid");
    }
  } else if (pathAuthorized) {
    diagnostics.push("canonical_state_missing");
  }

  const deliveryScope = planDir
    ? readPlanDeliveryScope({ cwd, planDir, source: "worktree", gitRunner: defaultGitRunner })
    : { ok: false, scope_path: null, delivery_files: [] };
  diagnostics.push(...asArray(deliveryScope.diagnostics));
  if (planDir && !deliveryScope.ok && deliveryScope.reason) diagnostics.push(`canonical_${deliveryScope.reason}`);
  return {
    path: planDir || null,
    path_authorized: pathAuthorized,
    declared_plan_dir: declaredPlanDir || null,
    supplied_plan_dir: evidencePlanDir || null,
    state_path: statePath || null,
    state_path_exists: statePathExists,
    state,
    state_json_valid: !!stateJson,
    state_closed: !!stateJson && CLOSED_STATES.has(state),
    state_json: stateJson,
    canonical_goal: asString(stateJson?.goal),
    scope_path: deliveryScope.scope_path,
    delivery_files: deliveryScope.delivery_files,
    diagnostics: uniqueStrings(diagnostics),
  };
}

function declaredChildPlanMatchesTicket(ticket, planEvidence) {
  const ticketPlanDir = normalizeRepoPath(planEvidence?.declared_plan_dir || ticket?.child_plan?.plan_dir || "");
  const evidencePath = normalizeRepoPath(planEvidence?.path || "");
  if (!ticketPlanDir || !evidencePath) return false;
  return ticketPlanDir === evidencePath;
}

function scopeMatchesTicket({ finding, ticket, planEvidence }) {
  const ticketId = asString(finding?.ticket_id || ticket?.id);
  if (!planEvidence?.path_authorized) return false;
  if (declaredChildPlanMatchesTicket(ticket, planEvidence)) return true;
  return planGoalReferencesTicket(planEvidence?.canonical_goal, ticketId);
}

function publicPlanEvidence(planEvidence) {
  if (!planEvidence) return null;
  return {
    path: planEvidence.path || null,
    path_authorized: planEvidence.path_authorized === true,
    state_path: planEvidence.state_path || null,
    state_path_exists: planEvidence.state_path_exists === true,
    state_json_valid: planEvidence.state_json_valid === true,
    state: planEvidence.state || null,
    state_closed: planEvidence.state_closed === true,
    scope_path: planEvidence.scope_path || null,
    delivery_files: asArray(planEvidence.delivery_files),
    diagnostics: asArray(planEvidence.diagnostics),
  };
}

function verificationSummary(checks) {
  const blockers = checks.filter((check) => check.pass !== true).map((check) => check.name);
  return {
    status: blockers.length === 0 ? "pass" : "blocked",
    blockers,
    checks,
  };
}

function verificationRowRefs(ticket, packet) {
  const refs = new Set(asArray(ticket?.verification_refs).map(asString).filter(Boolean));
  for (const row of asArray(packet?.verification_matrix)) {
    if (asString(row?.subject_ref) === asString(ticket?.id)) refs.add(asString(row?.id));
  }
  return refs;
}

function evidenceRefsForDisposition({ cwd, receiptRel, repairPacketRel, finding, planEvidence, verifiedCommits }) {
  return uniqueStrings([
    receiptRel,
    repairPacketRel,
    relPath(cwd, finding?.packet_path),
    planEvidence?.path,
    planEvidence?.state_path,
    ...asArray(verifiedCommits)
      .map((entry) => asString(entry.hash || entry.commit))
      .filter(Boolean)
      .map((hash) => `git:${hash}`),
  ]);
}

function jsonDocumentMatches(document, expected) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;
  return Object.entries(expected || {}).every(([key, value]) => Object.is(document[key], value));
}

function safeEvidenceCandidate({ cwd, root, matchedPath }) {
  const rawMatchedPath = asString(matchedPath).replace(/\\/g, "/");
  if (!rawMatchedPath || isAbsolute(rawMatchedPath) || rawMatchedPath.split("/").includes("..")) {
    return { safe: false, exists: false, is_file: false, parsed: null };
  }

  const rootPath = resolve(cwd, root);
  const candidatePath = resolve(cwd, rawMatchedPath);
  const canonicalRoot = canonicalMaybeMissing(rootPath);
  const canonicalCandidate = canonicalMaybeMissing(candidatePath);
  const fromRoot = relative(canonicalRoot, canonicalCandidate);
  let rootIsDirectory = false;
  try {
    rootIsDirectory = statSync(rootPath).isDirectory();
  } catch {
    rootIsDirectory = false;
  }
  const safe = rootIsDirectory
    && !!fromRoot
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(fromRoot);
  if (!safe || !existsSync(candidatePath)) {
    return { safe, exists: false, is_file: false, parsed: null };
  }

  let isFile = false;
  let parsed = null;
  try {
    const st = statSync(candidatePath);
    isFile = st.isFile() && rawMatchedPath.endsWith(".json") && st.size <= MAX_EXPECTED_EVIDENCE_BYTES;
    if (isFile) parsed = readJsonFile(candidatePath);
  } catch {
    parsed = null;
  }
  return { safe, exists: true, is_file: isFile, parsed };
}

function verifyAwaitingExternalActionResolution({ cwd, ticket, finding }) {
  if (ticket?.awaiting_external_action === undefined) {
    return {
      required: false,
      status: "not_applicable",
      blockers: [],
      checks: [],
      normalized: null,
      matched_path: null,
    };
  }

  const awaiting = validateAwaitingExternalAction(ticket.awaiting_external_action, { lifecycle: ticket.lifecycle });
  const findingResolution = finding?.awaiting_external_action;
  const matchedPath = normalizeRepoPath(findingResolution?.matched_path);
  const matchingEvidence = asArray(finding?.evidence_chain).filter((entry) =>
    asString(entry?.kind) === "expected_external_evidence"
      && lower(entry?.status) === "matched"
      && normalizeRepoPath(entry?.path) === matchedPath
  );
  const candidate = awaiting.ok && matchedPath
    ? safeEvidenceCandidate({
        cwd,
        root: awaiting.normalized.expected_evidence.root,
        matchedPath,
      })
    : { safe: false, exists: false, is_file: false, parsed: null };
  const checks = [
    {
      name: "awaiting_contract_valid",
      pass: awaiting.ok,
      detail: awaiting.errors,
    },
    {
      name: "awaiting_evidence_expired",
      pass: lower(findingResolution?.status) === "expired" && !!matchedPath,
    },
    {
      name: "awaiting_evidence_path_linked",
      pass: matchingEvidence.length === 1,
      detail: matchingEvidence.map((entry) => ({ kind: entry.kind, status: entry.status, path: entry.path })),
    },
    {
      name: "awaiting_evidence_within_root",
      pass: candidate.safe === true,
    },
    {
      name: "awaiting_evidence_file",
      pass: candidate.exists === true && candidate.is_file === true,
    },
    {
      name: "awaiting_evidence_json",
      pass: !!candidate.parsed,
    },
    {
      name: "awaiting_evidence_matches_contract",
      pass: awaiting.ok && jsonDocumentMatches(candidate.parsed, awaiting.normalized.expected_evidence.match),
    },
    {
      name: "awaiting_resolution_slot_available",
      pass: ticket.awaiting_external_action_resolved === undefined,
    },
  ];
  return {
    required: true,
    ...verificationSummary(checks),
    normalized: awaiting.ok ? awaiting.normalized : null,
    matched_path: matchedPath || null,
  };
}

function updatePersonaReview(ticket, evidenceRefs) {
  if (!ticket.persona_review || typeof ticket.persona_review !== "object" || Array.isArray(ticket.persona_review)) {
    ticket.persona_review = {
      version: 1,
      status: "accepted",
      findings: [],
      authority: "advisory_only_deterministic_gates_remain_authoritative",
    };
  }
  ticket.persona_review.status = "accepted";
  ticket.persona_review.accepted_by = "program_manager_disposition";
  ticket.persona_review.evidence_refs = uniqueStrings([
    ...asArray(ticket.persona_review.evidence_refs),
    ...evidenceRefs,
  ]);
  ticket.persona_review.findings = asArray(ticket.persona_review.findings).map((finding) => ({
    ...finding,
    status: "verified",
    evidence_refs: uniqueStrings([
      ...asArray(finding?.evidence_refs),
      ...evidenceRefs,
    ]),
  }));
}

function recurrenceHookNames(row) {
  const hooks = [];
  const carried = asArray(row?.auto_carried_from).map(asString);
  if (carried.includes("M-001")) hooks.push("ripple_check", "migration-bootstrap", "transition-gate-flows");
  if (carried.includes("M-041")) hooks.push("rule_engine_check_invariants", "annotation_parser_validate");
  return uniqueStrings(hooks);
}

function appendHookEvidenceText(row) {
  const hooks = recurrenceHookNames(row);
  if (hooks.length === 0) return;
  const combined = `${row.command_or_action || ""}\n${row.pass_means || ""}\n${asArray(row.evidence_refs).join("\n")}`;
  const missing = hooks.filter((hook) => !combined.includes(hook));
  if (missing.length === 0) return;
  const suffix = `Disposition recurrence evidence includes ${missing.join(", ")} via the closed child-plan receipt.`;
  row.command_or_action = `${asString(row.command_or_action)} ${suffix}`.trim();
}

function markVerificationRowsPassing(packet, ticket, evidenceRefs, timestamp) {
  const refs = verificationRowRefs(ticket, packet);
  for (const row of asArray(packet?.verification_matrix)) {
    if (!refs.has(asString(row?.id))) continue;
    appendHookEvidenceText(row);
    row.result = "pass";
    row.result_source = "program_manager_disposition";
    row.observed_at = timestamp;
    row.evidence_refs = uniqueStrings([
      ...asArray(row.evidence_refs),
      ...evidenceRefs,
    ]);
  }
}

function mutateClosedTicket({ cwd, packet, ticket, finding, receiptRel, repairPacketRel, timestamp, planEvidence, awaitingResolution, verifiedCommits }) {
  const evidenceRefs = evidenceRefsForDisposition({ cwd, receiptRel, repairPacketRel, finding, planEvidence, verifiedCommits });
  if (awaitingResolution?.required === true) {
    ticket.awaiting_external_action_resolved = {
      ...awaitingResolution.normalized,
      resolved_at: timestamp,
      resolving_evidence: awaitingResolution.matched_path,
    };
    delete ticket.awaiting_external_action;
  }
  ticket.lifecycle = "closed";
  ticket.review_status = "review_ready";
  ticket.last_review_status = "review_ready";
  ticket.close_reason = `Evidence-verified shipped-open disposition from ${repairPacketRel || "lifecycle repair packet"}.`;
  ticket.lifecycle_disposition = {
    kind: "shipped_open_verified_close",
    applied_at: timestamp,
    repair_finding_id: asString(finding?.id),
    repair_packet_ref: repairPacketRel || null,
    receipt_ref: receiptRel,
    evidence_plan_dir: planEvidence?.path || null,
    evidence_state_path: planEvidence?.state_path || null,
    evidence_commits: asArray(verifiedCommits)
      .map((entry) => asString(entry.hash || entry.commit))
      .filter(Boolean),
    commit_linkage: asString(asArray(verifiedCommits)[0]?.linkage_reason) || null,
  };
  if (!ticket.child_plan || typeof ticket.child_plan !== "object" || Array.isArray(ticket.child_plan)) {
    ticket.child_plan = { policy: "required", plan_dir: null, reason: "Disposition supplied child plan evidence." };
  }
  if (planEvidence?.path && !asString(ticket.child_plan.plan_dir)) ticket.child_plan.plan_dir = planEvidence.path;
  if (!asString(ticket.child_plan.policy)) ticket.child_plan.policy = "required";
  ticket.child_plan.disposition_evidence_ref = receiptRel;
  updatePersonaReview(ticket, evidenceRefs);
  markVerificationRowsPassing(packet, ticket, evidenceRefs, timestamp);
}

function validateFindingEvidence({ cwd, finding, packet, ticket, gitRunner }) {
  const commits = asArray(finding?.evidence_chain).filter((entry) => entry?.kind === "git_commit");
  const closingEvidence = asArray(finding?.evidence_chain)
    .filter((entry) => entry?.closes_lifecycle === true || ["declared_child_plan", "closed_plan_match", "stamped_receipt"].includes(asString(entry?.kind)));
  const planChecks = closingEvidence.map((entry) => {
    const planEvidence = readPlanEvidence(cwd, entry, ticket);
    return {
      kind: asString(entry.kind),
      path: planEvidence.path,
      state_path: planEvidence.state_path,
      state_path_exists: planEvidence.state_path_exists,
      path_authorized: planEvidence.path_authorized,
      state_json_valid: planEvidence.state_json_valid,
      state: planEvidence.state,
      state_closed: planEvidence.state_closed,
      scope_match: scopeMatchesTicket({ finding, ticket, planEvidence }),
      diagnostics: asArray(planEvidence.diagnostics),
      detail: asString(entry.detail),
      plan_evidence: planEvidence,
    };
  });
  const selectedPlan = planChecks.find((entry) => entry.path_authorized && entry.state_json_valid && entry.state_closed && entry.scope_match) || null;
  const commitChecks = commits.map((entry) => {
    const verified = verifyLifecycleCommitEvidence({
      cwd,
      ticketId: asString(finding?.ticket_id || ticket?.id),
      commit: entry.hash || entry.commit,
      deliveryFiles: selectedPlan?.plan_evidence?.delivery_files || [],
      planDir: selectedPlan?.plan_evidence?.path || null,
      gitRunner,
    });
    return {
      commit: verified.hash || asString(entry.hash || entry.commit),
      short_commit: verified.short_hash || asString(entry.commit),
      subject: verified.subject || "",
      exists: verified.exists === true,
      head_reachable: verified.reachable === true,
      trusted: verified.trusted === true,
      linkage_reason: verified.reason,
      exact_ticket_id: verified.exact_ticket_id === true,
      full_delivery_scope: verified.full_delivery_scope === true,
      delivery_files: verified.delivery_files,
      changed_files: verified.changed_files,
      missing_delivery_files: verified.missing_delivery_files,
      diagnostics: asArray(verified.diagnostics),
    };
  });
  const verifiedCommits = commitChecks.filter((entry) => entry.trusted);
  const mirrorRequired = programGithubIssueMirrorRequired(packet);
  const mirror = ticket ? ticketHasGithubIssueMirror(ticket) : false;
  const awaitingResolution = ticket
    ? verifyAwaitingExternalActionResolution({ cwd, ticket, finding })
    : { required: false, status: "not_applicable", blockers: [], checks: [], normalized: null, matched_path: null };
  const checks = [
    { name: "ticket_found", pass: !!ticket },
    { name: "proposed_closed", pass: lower(finding?.proposed_lifecycle) === "closed" },
    { name: "commit_exists", pass: commitChecks.some((entry) => entry.exists), detail: commitChecks },
    { name: "commit_linkage", pass: verifiedCommits.length > 0, detail: commitChecks },
    { name: "child_plan_closed", pass: planChecks.some((entry) => entry.path_authorized && entry.state_path_exists && entry.state_json_valid && entry.state_closed), detail: planChecks.map(({ plan_evidence, ...entry }) => entry) },
    { name: "scope_match", pass: planChecks.some((entry) => entry.path_authorized && entry.state_json_valid && entry.state_closed && entry.scope_match), detail: planChecks.map(({ plan_evidence, ...entry }) => entry) },
    { name: "github_issue_mirror", pass: !mirrorRequired || mirror, required: mirrorRequired, detail: { mirror_present: mirror } },
    ...awaitingResolution.checks,
  ];
  return {
    ...verificationSummary(checks),
    commit_checks: commitChecks,
    verified_commits: verifiedCommits,
    plan_checks: planChecks.map(({ plan_evidence, ...entry }) => entry),
    selected_plan_evidence: publicPlanEvidence(selectedPlan?.plan_evidence),
    awaiting_external_action_resolution: awaitingResolution,
  };
}

function classifyDeferredTicket(ticket) {
  const reason = asString(ticket?.close_reason || ticket?.deferred_reason || ticket?.reason);
  const decisionRef = asString(ticket?.deferral_decision_ref || ticket?.decision_ref || ticket?.decisionRef);
  const text = `${reason} ${decisionRef}`.toLowerCase();
  if (/absorbed into|fold(?:ed)? into|carried into/.test(text)) return "fold_into_existing_ticket";
  if (/superseded|obsolete|delete|deleted|replaced by/.test(text)) return "close_obsolete";
  if (!reason || !decisionRef || /revive|reopen|needs implementation|undecided/.test(text)) return "revive";
  return "close_obsolete";
}

function ensurePacketCache({ cwd, packetCaches, packetPath }) {
  const absPath = resolvePath(cwd, packetPath);
  if (!absPath) throw new Error(`Missing Program Packet path`);
  const rel = relPath(cwd, absPath);
  if (!packetCaches.has(rel)) {
    const loaded = loadProgramPacket(absPath);
    const original = loaded.packet;
    packetCaches.set(rel, {
      path: absPath,
      rel,
      original,
      draft: clone(original),
      changed: false,
      changed_ticket_ids: new Set(),
      baseline_validation: validateProgramPacket(original, { cwd, programPacketPath: absPath }),
      post_validation: null,
      introduced_errors: [],
      written: false,
    });
  }
  return packetCaches.get(rel);
}

function resolveDeferredProgramPath(cwd, programArg) {
  const direct = resolvePath(cwd, programArg);
  if (direct && existsSync(direct)) return direct;
  const resolved = resolveProgramPacketPath(cwd, programArg);
  if (resolved.status === "FOUND") return resolved.path;
  throw new Error(`Deferred Program Packet not found: ${programArg}`);
}

function validationErrorKey(error) {
  return `${error?.code || ""}\u0000${error?.path || ""}\u0000${error?.message || ""}`;
}

function introducedValidationErrors(before, after) {
  const baseline = new Set(asArray(before?.errors).map(validationErrorKey));
  return asArray(after?.errors).filter((error) => !baseline.has(validationErrorKey(error)));
}

function unresolvedGateRequirementErrors(validation) {
  return asArray(validation?.errors).filter((error) => /^program_gate_requirement_/.test(asString(error?.code)));
}

function uniqueValidationErrors(errors) {
  const seen = new Set();
  return asArray(errors).filter((error) => {
    const key = validationErrorKey(error);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findTicket(packet, ticketId) {
  return asArray(packet?.tickets).find((ticket) => asString(ticket?.id) === asString(ticketId)) || null;
}

function mapDecisionsById(packet) {
  return new Map(asArray(packet?.decisions).map((decision) => [asString(decision?.id), decision]).filter(([id]) => id));
}

function extractDecisionRefFromText(ticket, packet) {
  const text = [
    ticket?.close_reason,
    ticket?.deferred_reason,
    ticket?.reason,
    ticket?.backlog_disposition?.notes,
    ticket?.backlog_disposition?.decision,
  ].map(asString).filter(Boolean).join("\n");
  if (!text) return "";
  const decisions = mapDecisionsById(packet);
  for (const id of decisions.keys()) {
    if (id && text.includes(id)) return id;
  }
  const match = text.match(/\bdecision\s+([A-Za-z0-9][A-Za-z0-9_.:-]*)/i);
  return match ? asString(match[1]).replace(/[).,;:]+$/, "") : "";
}

function administrativeDecisionRef(ticket, packet) {
  return asString(
    ticket?.backlog_disposition?.decision_ref ||
    ticket?.backlog_disposition?.decisionRef ||
    ticket?.deferral_decision_ref ||
    ticket?.decision_ref ||
    ticket?.decisionRef
  ) || extractDecisionRefFromText(ticket, packet);
}

function administrativeCloseReason(classification, decisionRef) {
  return `Administrative backlog disposition close: ${classification} via decision ${decisionRef}.`;
}

function normalizeBacklogDispositionForClose(ticket, packet) {
  const existing = ticket?.backlog_disposition && typeof ticket.backlog_disposition === "object" && !Array.isArray(ticket.backlog_disposition)
    ? ticket.backlog_disposition
    : null;
  if (!existing) {
    return {
      ok: false,
      blockers: ["missing_backlog_disposition"],
      classification: null,
      decision_ref: null,
    };
  }
  const classification = lower(existing.classification);
  const decisionRef = administrativeDecisionRef(ticket, packet);
  const decisions = mapDecisionsById(packet);
  const blockers = [];
  if (!ADMINISTRATIVE_BACKLOG_DISPOSITION_CLASSIFICATIONS.has(classification)) blockers.push("unsupported_backlog_disposition_classification");
  if (!decisionRef) blockers.push("missing_backlog_disposition_decision_ref");
  else if (!decisions.has(decisionRef)) blockers.push("backlog_disposition_decision_ref_not_found");
  return {
    ok: blockers.length === 0,
    blockers,
    classification,
    decision_ref: decisionRef || null,
  };
}

function mutateAdministrativeClosedTicket({ ticket, classification, decisionRef, receiptRel, timestamp }) {
  const existing = ticket.backlog_disposition && typeof ticket.backlog_disposition === "object" && !Array.isArray(ticket.backlog_disposition)
    ? ticket.backlog_disposition
    : {};
  ticket.backlog_disposition = {
    ...existing,
    classification,
    decision_ref: decisionRef,
    receipt_ref: receiptRel,
    source: asString(existing.source) || "program_manager_disposition",
    updated_at: timestamp,
    closed_at: timestamp,
  };
  ticket.lifecycle = "closed";
  ticket.review_status = "unavailable";
  ticket.last_review_status = "unavailable";
  ticket.close_reason = administrativeCloseReason(classification, decisionRef);
}

function mutateProposedResolutionTicket({ ticket, entry, request, receiptRel, timestamp }) {
  ticket.backlog_disposition = {
    classification: entry.classification,
    decision_ref: entry.decision_ref.id,
    receipt_ref: receiptRel,
    source: "program_manager_proposed_resolution",
    updated_at: timestamp,
    closed_at: timestamp,
    resolution_evidence: {
      schema_version: "program_resolution_evidence.v1",
      request_ref: request.path,
      request_sha256: request.sha256,
      decision_ref: entry.decision_ref,
      evidence_refs: entry.evidence_refs,
    },
  };
  ticket.lifecycle = "closed";
  ticket.review_status = "unavailable";
  ticket.last_review_status = "unavailable";
  ticket.close_reason = `Administrative proposed-ticket resolution: ${entry.classification} via decision ${entry.decision_ref.id}.`;
}

function processShippedOpenFinding({ cwd, finding, packetCaches, gitRunner, write, timestamp, receiptRel, repairPacketRel }) {
  const packetRel = relPath(cwd, finding?.packet_path);
  const cache = ensurePacketCache({ cwd, packetCaches, packetPath: finding?.packet_path });
  const ticket = findTicket(cache.draft, finding?.ticket_id);
  const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
  const verification = validateFindingEvidence({ cwd, finding, packet: cache.draft, ticket, gitRunner });
  const baseEntry = {
    ticket_id: asString(finding?.ticket_id),
    ticket_title: asString(finding?.ticket_title),
    program_id: asString(finding?.program_id),
    packet_path: packetRel,
    previous_lifecycle: lifecycle || null,
    proposed_lifecycle: "closed",
    action: "keep_open",
    blockers: [],
    verification,
    evidence_refs: uniqueStrings([
      packetRel,
      verification.selected_plan_evidence?.path,
      verification.selected_plan_evidence?.state_path,
    ]),
  };

  if (!ticket) {
    return { ...baseEntry, blockers: ["ticket_not_found"] };
  }
  if (lifecycle === "closed") {
    return { ...baseEntry, action: "already_closed", blockers: [] };
  }
  if (!verification.checks.find((check) => check.name === "github_issue_mirror")?.pass) {
    return {
      ...baseEntry,
      blockers: uniqueStrings([
        ...verification.blockers.filter((blocker) => blocker !== "github_issue_mirror"),
        "missing_github_issue_mirror",
      ]),
    };
  }
  if (!verificationStatusIsPass(verification.status, "execution")) {
    return { ...baseEntry, blockers: verification.blockers };
  }

  const action = write ? "pending_apply_closed" : "would_apply_closed";
  mutateClosedTicket({
    cwd,
    packet: cache.draft,
    ticket,
    finding,
    receiptRel,
    repairPacketRel,
    timestamp,
    planEvidence: verification.selected_plan_evidence,
    awaitingResolution: verification.awaiting_external_action_resolution,
    verifiedCommits: verification.verified_commits,
  });
  cache.changed = true;
  cache.changed_ticket_ids.add(asString(finding.ticket_id));
  return { ...baseEntry, action, blockers: [] };
}

function processDuplicateScope(finding) {
  return {
    ticket_id: asString(finding?.ticket_id),
    ticket_title: asString(finding?.ticket_title),
    program_id: asString(finding?.program_id),
    packet_path: normalizeRepoPath(finding?.packet_path),
    classification: "fold_into_existing_ticket",
    matched_scope: finding?.matched_scope || null,
    evidence_refs: uniqueStrings([
      finding?.packet_path,
      finding?.matched_scope?.packet_path,
      finding?.matched_scope?.id,
    ]),
    action: "receipt_only",
  };
}

function processDeferredProgram({ cwd, packetArg, packetCaches, write, close, timestamp, receiptRel }) {
  const packetPath = resolveDeferredProgramPath(cwd, packetArg);
  const cache = ensurePacketCache({ cwd, packetCaches, packetPath });
  const entries = [];
  for (const ticket of asArray(cache.draft?.tickets)) {
    const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
    if (!close && lifecycle !== "deferred") continue;
    if (close && !["deferred", "closed"].includes(lifecycle)) continue;
    if (close && lifecycle === "closed" && !ticket?.backlog_disposition) continue;
    const closeDisposition = close ? normalizeBacklogDispositionForClose(ticket, cache.draft) : null;
    const classification = close
      ? (closeDisposition?.classification || lower(ticket?.backlog_disposition?.classification))
      : classifyDeferredTicket(ticket);
    const decisionRef = close
      ? (closeDisposition?.decision_ref || null)
      : asString(ticket?.deferral_decision_ref || ticket?.decision_ref);
    const entry = {
      ticket_id: asString(ticket?.id),
      ticket_title: asString(ticket?.title),
      program_id: asString(cache.draft?.id),
      packet_path: cache.rel,
      classification,
      decision_ref: decisionRef,
      close_reason: asString(ticket?.close_reason),
      previous_lifecycle: lifecycle || null,
      proposed_lifecycle: close ? "closed" : lifecycle,
      action: close
        ? (write ? "pending_admin_close" : "would_admin_close")
        : (write ? "classified_written" : "classified_dry_run"),
      blockers: [],
    };
    if (close) {
      if (lifecycle === "closed" && isSupportedAdministrativeBacklogDisposition(ticket, { decisionsById: mapDecisionsById(cache.draft) })) {
        entries.push({ ...entry, action: "already_closed", blockers: [] });
        continue;
      }
      if (!closeDisposition?.ok) {
        entries.push({ ...entry, action: "keep_deferred", blockers: closeDisposition?.blockers || ["invalid_backlog_disposition"] });
        continue;
      }
      if (write) {
        mutateAdministrativeClosedTicket({
          ticket,
          classification,
          decisionRef,
          receiptRel,
          timestamp,
        });
        cache.changed = true;
        cache.changed_ticket_ids.add(entry.ticket_id);
      }
      entries.push(entry);
      continue;
    }
    if (write) {
      const existing = ticket.backlog_disposition || {};
      const alreadyClassified = existing.classification === classification
        && (existing.decision_ref || null) === (entry.decision_ref || null)
        && existing.source === "program_manager_disposition";
      if (alreadyClassified) {
        entry.action = "already_classified";
      } else {
        ticket.backlog_disposition = {
          classification,
          decision_ref: entry.decision_ref || null,
          receipt_ref: receiptRel,
          source: "program_manager_disposition",
          updated_at: timestamp,
        };
        cache.changed = true;
        cache.changed_ticket_ids.add(entry.ticket_id);
      }
    }
    entries.push(entry);
  }
  return entries;
}

function processProposedResolutionRequest({ cwd, request, packetCaches, write, timestamp, receiptRel }) {
  const cache = ensurePacketCache({ cwd, packetCaches, packetPath: request.program_packet_path });
  const programMismatch = request.program_id !== asString(cache.draft?.id);
  return request.entries.map((verified) => {
    const ticket = findTicket(cache.draft, verified.ticket_id);
    const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
    const blockers = [...asArray(verified.blockers)];
    if (programMismatch) blockers.push("resolution_request_program_mismatch");
    if (!ticket) blockers.push("resolution_ticket_not_found");
    const childPlan = asString(ticket?.child_plan?.plan_dir || ticket?.child_plan);
    if (ticket && childPlan) blockers.push("resolution_ticket_has_child_plan");
    const persisted = ticket && lifecycle === "closed"
      ? verifyPersistedProposedResolution({ cwd, ticket, programId: cache.draft?.id, programPacketPath: cache.path })
      : null;
    if (ticket && lifecycle === "closed" && persisted?.ok) {
      return {
        ticket_id: verified.ticket_id,
        ticket_title: asString(ticket.title),
        program_id: asString(cache.draft?.id),
        packet_path: cache.rel,
        classification: verified.classification,
        previous_lifecycle: lifecycle,
        proposed_lifecycle: "closed",
        action: "already_resolved",
        blockers: [],
        verification: verified,
      };
    }
    if (ticket && lifecycle !== "proposed") blockers.push("resolution_ticket_not_proposed");
    if (blockers.length > 0) {
      return {
        ticket_id: verified.ticket_id,
        ticket_title: asString(ticket?.title),
        program_id: asString(cache.draft?.id),
        packet_path: cache.rel,
        classification: verified.classification,
        previous_lifecycle: lifecycle || null,
        proposed_lifecycle: "closed",
        action: "keep_open",
        blockers: uniqueStrings(blockers),
        verification: { ...verified, status: "BLOCKED", blockers: uniqueStrings(blockers) },
      };
    }
    const action = write ? "pending_admin_resolve" : "would_admin_resolve";
    mutateProposedResolutionTicket({ ticket, entry: verified, request, receiptRel, timestamp });
    cache.changed = true;
    cache.changed_ticket_ids.add(verified.ticket_id);
    return {
      ticket_id: verified.ticket_id,
      ticket_title: asString(ticket.title),
      program_id: asString(cache.draft?.id),
      packet_path: cache.rel,
      classification: verified.classification,
      previous_lifecycle: lifecycle,
      proposed_lifecycle: "closed",
      action,
      blockers: [],
      verification: verified,
    };
  });
}

function finalizePacketWrites({ packetCaches, cwd, write }) {
  const packetResults = [];
  for (const cache of packetCaches.values()) {
    if (!cache.changed) {
      const structuralErrors = unresolvedGateRequirementErrors(cache.baseline_validation);
      packetResults.push({
        packet_path: cache.rel,
        changed: false,
        written: false,
        write_blocked: write && structuralErrors.length > 0,
        baseline_error_count: asArray(cache.baseline_validation?.errors).length,
        post_error_count: asArray(cache.baseline_validation?.errors).length,
        introduced_error_count: structuralErrors.length,
        introduced_errors: structuralErrors,
      });
      continue;
    }
    cache.post_validation = validateProgramPacket(cache.draft, { cwd, programPacketPath: cache.path });
    cache.introduced_errors = uniqueValidationErrors([
      ...introducedValidationErrors(cache.baseline_validation, cache.post_validation),
      ...unresolvedGateRequirementErrors(cache.post_validation),
    ]);
    const canWrite = cache.introduced_errors.length === 0;
    if (write && canWrite) {
      writeJsonFile(cache.path, cache.draft);
      cache.written = true;
    }
    packetResults.push({
      packet_path: cache.rel,
      changed: true,
      written: cache.written,
      write_blocked: write && !canWrite,
      baseline_error_count: asArray(cache.baseline_validation?.errors).length,
      post_error_count: asArray(cache.post_validation?.errors).length,
      introduced_error_count: cache.introduced_errors.length,
      introduced_errors: cache.introduced_errors,
      changed_ticket_ids: [...cache.changed_ticket_ids].sort(),
    });
  }
  return packetResults.sort((a, b) => a.packet_path.localeCompare(b.packet_path));
}

function markBlockedPacketActions(receipt) {
  const blockedPackets = new Map(
    asArray(receipt.packet_writes)
      .filter((entry) => entry.introduced_error_count > 0)
      .map((entry) => [entry.packet_path, entry]),
  );
  if (blockedPackets.size === 0) {
    for (const entry of receipt.shipped_open) {
      if (entry.action === "pending_apply_closed") entry.action = "applied_closed";
    }
    for (const entry of receipt.deferred) {
      if (entry.action === "pending_admin_close") entry.action = "admin_closed";
    }
    for (const entry of receipt.proposed_resolutions) {
      if (entry.action === "pending_admin_resolve") entry.action = "admin_resolved";
    }
    return;
  }
  for (const entry of receipt.shipped_open) {
    const packet = blockedPackets.get(entry.packet_path);
    if (!packet || !["pending_apply_closed", "would_apply_closed"].includes(entry.action)) continue;
    entry.action = "keep_open";
    const blocker = asArray(packet.introduced_errors).some((error) => /^program_gate_requirement_/.test(asString(error?.code)))
      ? "packet_gate_requirement_unresolved"
      : "packet_validation_introduced_errors";
    entry.blockers = uniqueStrings([...entry.blockers, blocker]);
    entry.packet_validation_errors = packet.introduced_errors;
  }
  for (const entry of receipt.deferred) {
    const packet = blockedPackets.get(entry.packet_path);
    if (!packet || entry.action !== "pending_admin_close") continue;
    entry.action = "keep_deferred";
    const blocker = asArray(packet.introduced_errors).some((error) => /^program_gate_requirement_/.test(asString(error?.code)))
      ? "packet_gate_requirement_unresolved"
      : "packet_validation_introduced_errors";
    entry.blockers = uniqueStrings([...entry.blockers, blocker]);
    entry.packet_validation_errors = packet.introduced_errors;
  }
  for (const entry of receipt.proposed_resolutions) {
    const packet = blockedPackets.get(entry.packet_path);
    if (!packet || !["pending_admin_resolve", "would_admin_resolve"].includes(entry.action)) continue;
    entry.action = "keep_open";
    entry.blockers = uniqueStrings([...entry.blockers, "packet_validation_introduced_errors"]);
    entry.packet_validation_errors = packet.introduced_errors;
  }
}

function countBy(entries, key) {
  const counts = {};
  for (const entry of asArray(entries)) {
    const value = asString(entry?.[key]) || "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function collectBlockers(receipt) {
  const blockers = [];
  for (const entry of asArray(receipt.shipped_open)) {
    for (const blocker of asArray(entry.blockers)) {
      blockers.push({
        code: blocker,
        ticket_id: entry.ticket_id,
        packet_path: entry.packet_path,
        message: `${entry.ticket_id}: ${blocker}`,
      });
    }
  }
  for (const entry of asArray(receipt.deferred)) {
    for (const blocker of asArray(entry.blockers)) {
      blockers.push({
        code: blocker,
        ticket_id: entry.ticket_id,
        packet_path: entry.packet_path,
        message: `${entry.ticket_id}: ${blocker}`,
      });
    }
  }
  for (const entry of asArray(receipt.proposed_resolutions)) {
    for (const blocker of asArray(entry.blockers)) {
      blockers.push({
        code: blocker,
        ticket_id: entry.ticket_id,
        packet_path: entry.packet_path,
        message: `${entry.ticket_id}: ${blocker}`,
      });
    }
  }
  for (const packet of asArray(receipt.packet_writes)) {
    for (const error of asArray(packet.introduced_errors)) {
      const unresolvedRequirement = /^program_gate_requirement_/.test(asString(error?.code));
      blockers.push({
        code: unresolvedRequirement ? "packet_gate_requirement_unresolved" : "packet_validation_introduced_error",
        packet_path: packet.packet_path,
        path: error.path,
        message: error.message,
      });
    }
  }
  return blockers;
}

export function buildProgramDisposition(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const write = options.write === true;
  const close = options.close === true;
  const timestamp = nowIso(options.clock);
  const fromRepairPacket = options.fromRepairPacket ? resolvePath(cwd, options.fromRepairPacket) : null;
  const fromResolutionRequest = options.fromResolutionRequest ? resolvePath(cwd, options.fromResolutionRequest) : null;
  const deferredPrograms = asArray(options.deferredPrograms).map(asString).filter(Boolean);
  const identityParts = dispositionOutputIdentity({ cwd, fromRepairPacket, fromResolutionRequest, deferredPrograms });
  const outputPath = resolvePath(cwd, options.output || defaultOutputPath(cwd, timestamp, { identityParts, avoidExisting: write }));
  const outputRel = relPath(cwd, outputPath);
  const gitRunner = options.gitRunner || defaultGitRunner;

  if (!fromRepairPacket && !fromResolutionRequest && deferredPrograms.length === 0) {
    throw new Error("disposition requires --from-repair-packet, --from-resolution-request, at least one --deferred-program, or a combination");
  }
  if (fromRepairPacket && !existsSync(fromRepairPacket)) {
    throw new Error(`Repair packet not found: ${relPath(cwd, fromRepairPacket)}`);
  }

  const repairPacket = fromRepairPacket ? readJsonFile(fromRepairPacket) : null;
  const resolutionRequest = fromResolutionRequest
    ? loadProposedResolutionRequest({ cwd, requestPath: fromResolutionRequest, gitRunner })
    : null;
  if (resolutionRequest && !resolutionRequest.ok) throw new Error(`${resolutionRequest.blocker}: ${relPath(cwd, fromResolutionRequest)}`);
  const packetCaches = new Map();
  const receipt = {
    schema_version: "program_disposition_receipt.v1",
    command: "disposition",
    status: "PASS",
    dry_run: !write,
    write_requested: write,
    close_requested: close,
    generated_at: timestamp,
    repair_packet_path: fromRepairPacket ? relPath(cwd, fromRepairPacket) : null,
    resolution_request_path: resolutionRequest?.path || null,
    output_path: outputRel,
    receipt_written: false,
    shipped_open: [],
    duplicate_scope: [],
    deferred: [],
    proposed_resolutions: [],
    packet_writes: [],
    counts: {},
    blockers: [],
    repo_state_stamp: null,
  };

  for (const finding of asArray(repairPacket?.findings?.shipped_open)) {
    receipt.shipped_open.push(processShippedOpenFinding({
      cwd,
      finding,
      packetCaches,
      gitRunner,
      write,
      timestamp,
      receiptRel: outputRel,
      repairPacketRel: receipt.repair_packet_path,
    }));
  }
  for (const finding of asArray(repairPacket?.findings?.duplicate_scope)) {
    receipt.duplicate_scope.push(processDuplicateScope(finding));
  }
  for (const packetArg of deferredPrograms) {
    receipt.deferred.push(...processDeferredProgram({
      cwd,
      packetArg,
      packetCaches,
      write,
      close,
      timestamp,
      receiptRel: outputRel,
    }));
  }
  if (resolutionRequest) {
    receipt.proposed_resolutions.push(...processProposedResolutionRequest({
      cwd,
      request: resolutionRequest,
      packetCaches,
      write,
      timestamp,
      receiptRel: outputRel,
    }));
  }

  receipt.packet_writes = finalizePacketWrites({ packetCaches, cwd, write });
  markBlockedPacketActions(receipt);
  for (const entry of receipt.shipped_open) {
    if (entry.action === "pending_apply_closed") entry.action = "applied_closed";
  }

  receipt.counts = {
    shipped_open: receipt.shipped_open.length,
    shipped_open_by_action: countBy(receipt.shipped_open, "action"),
    duplicate_scope: receipt.duplicate_scope.length,
    deferred: receipt.deferred.length,
    deferred_by_classification: countBy(receipt.deferred, "classification"),
    deferred_by_action: countBy(receipt.deferred, "action"),
    administrative_closed: receipt.deferred.filter((entry) => entry.action === "admin_closed").length,
    proposed_resolutions: receipt.proposed_resolutions.length,
    proposed_resolution_by_action: countBy(receipt.proposed_resolutions, "action"),
    proposed_administrative_closed: receipt.proposed_resolutions.filter((entry) => entry.action === "admin_resolved").length,
    packets_changed: receipt.packet_writes.filter((entry) => entry.changed).length,
    packets_written: receipt.packet_writes.filter((entry) => entry.written).length,
  };
  receipt.blockers = collectBlockers(receipt);
  receipt.status = receipt.blockers.length > 0 ? "BLOCKED" : "PASS";
  receipt.repo_state_stamp = buildRepoStateStamp({
    cwd,
    inputRoots: uniqueStrings([
      receipt.repair_packet_path,
      receipt.resolution_request_path,
      ...deferredPrograms.map((entry) => relPath(cwd, resolveDeferredProgramPath(cwd, entry))),
      outputRel,
    ]),
    invocation: {
      command: "program_manager.mjs",
      subcommand: "disposition",
      repair_packet_path: receipt.repair_packet_path,
      resolution_request_path: receipt.resolution_request_path,
      output_path: outputRel,
      write,
      close,
    },
  });

  if (write) {
    writeJsonFile(outputPath, receipt);
    receipt.receipt_written = true;
    writeJsonFile(outputPath, receipt);
  }
  return receipt;
}

export function renderProgramDispositionText(receipt) {
  const blockers = asArray(receipt?.blockers);
  const lines = [
    `Program Manager disposition: ${receipt?.status || "UNKNOWN"}`,
    `Mode: ${receipt?.dry_run ? "dry-run" : "write"}`,
    `Shipped-open: ${receipt?.counts?.shipped_open || 0}`,
    `Duplicate-scope: ${receipt?.counts?.duplicate_scope || 0}`,
    `Deferred: ${receipt?.counts?.deferred || 0}`,
    `Proposed resolutions: ${receipt?.counts?.proposed_resolutions || 0}`,
    `Packets written: ${receipt?.counts?.packets_written || 0}`,
    `Blockers: ${blockers.length}`,
  ];
  const actionCounts = receipt?.counts?.shipped_open_by_action || {};
  if (Object.keys(actionCounts).length > 0) {
    lines.push(`Shipped-open actions: ${Object.entries(actionCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
  const deferredCounts = receipt?.counts?.deferred_by_classification || {};
  if (Object.keys(deferredCounts).length > 0) {
    lines.push(`Deferred classifications: ${Object.entries(deferredCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
  const deferredActions = receipt?.counts?.deferred_by_action || {};
  if (Object.keys(deferredActions).length > 0) {
    lines.push(`Deferred actions: ${Object.entries(deferredActions).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
  const proposedActions = receipt?.counts?.proposed_resolution_by_action || {};
  if (Object.keys(proposedActions).length > 0) {
    lines.push(`Proposed-resolution actions: ${Object.entries(proposedActions).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
  for (const blocker of blockers.slice(0, 5)) {
    lines.push(`- ${blocker.code}: ${blocker.ticket_id || blocker.packet_path || blocker.path || "disposition"} - ${blocker.message || ""}`);
  }
  if (blockers.length > 5) lines.push(`More blockers: ${blockers.length - 5} (see receipt)`);
  lines.push(`Receipt: ${receipt?.receipt_written ? receipt.output_path : `${receipt?.output_path || "not written"} (planned; dry-run not written)`}`);
  const next = blockers.some((entry) => entry.code === "missing_github_issue_mirror")
    ? "publish missing GitHub mirrors for remote-sync packets, then rerun disposition --write"
    : blockers.some((entry) => entry.code === "packet_gate_requirement_unresolved")
      ? "resolve Program policy with local-only, repository identity, or governed waiver, then rerun disposition"
    : (receipt?.dry_run ? "rerun with --write after reviewing receipt" : "continue with Program Packet checks");
  lines.push(`Next: ${next}`);
  return lines.join("\n");
}

export function terminalLifecycle(value) {
  return TERMINAL_LIFECYCLES.has(effectiveTicketLifecycle(value));
}

export function shippedOpenActionCloses(action) {
  return SHIPPED_OPEN_ACTIONS.has(asString(action));
}
