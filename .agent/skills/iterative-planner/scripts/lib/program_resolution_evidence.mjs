// @planner:module = program_resolution_evidence
// @planner:capability = committed_proposed_ticket_resolution_evidence
// @planner:story = US-PM-AUTO-218

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { isAbsolute, relative, resolve } from "path";
import { textReferencesTicketId, verifyLifecycleCommitEvidence } from "./lifecycle_delivery_evidence.mjs";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const PROPOSED_RESOLUTION_CLASSIFICATIONS = new Set([
  "resolved_by_evidence",
  "resolved_by_investigation",
]);

const MAX_REQUEST_ENTRIES = 25;
const MAX_EVIDENCE_REFS = 8;
const MAX_COMMITTED_BYTES = 512 * 1024;

const asArray = (value) => Array.isArray(value) ? value : [];
const asString = (value) => typeof value === "string" ? value.trim() : "";
const lower = (value) => asString(value).toLowerCase();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const unique = (values) => [...new Set(values.filter(Boolean))];

function normalizeRepoPath(value) {
  return asString(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isSafeResolutionRepoPath(value) {
  const path = normalizeRepoPath(value);
  return !!path && !isAbsolute(path) && !path.split("/").includes("..") && !path.includes("\0");
}

function repoRelativePath(cwd, value) {
  const raw = asString(value);
  if (!raw) return "";
  if (!isAbsolute(raw)) return normalizeRepoPath(raw);
  const rel = normalizeRepoPath(relative(resolve(cwd), resolve(raw)));
  return isSafeResolutionRepoPath(rel) ? rel : "";
}

function defaultGitRunner(cwd, args, options = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf-8", timeout: options.timeout || 10000 });
}

function runGit(gitRunner, cwd, args, options = {}) {
  try {
    return gitRunner(cwd, args, options);
  } catch (error) {
    return { status: 1, stdout: "", stderr: error?.message || String(error) };
  }
}

function committedText({ cwd, path, gitRunner, prefix }) {
  const repoPath = repoRelativePath(cwd, path);
  if (!isSafeResolutionRepoPath(repoPath)) return { ok: false, blocker: `${prefix}_path_unsafe`, path: repoPath || null };
  const dirty = runGit(gitRunner, cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--", repoPath]);
  if (dirty.status !== 0) return { ok: false, blocker: `${prefix}_git_status_failed`, path: repoPath };
  if (asString(dirty.stdout)) return { ok: false, blocker: `${prefix}_not_clean`, path: repoPath };
  const shown = runGit(gitRunner, cwd, ["show", `HEAD:${repoPath}`]);
  if (shown.status !== 0) return { ok: false, blocker: `${prefix}_not_committed`, path: repoPath };
  const text = String(shown.stdout || "");
  if (Buffer.byteLength(text) > MAX_COMMITTED_BYTES) return { ok: false, blocker: `${prefix}_too_large`, path: repoPath };
  return { ok: true, path: repoPath, text, sha256: sha256(text) };
}

function parseJsonCommitted(input, prefix) {
  if (!input.ok) return input;
  try {
    return { ...input, json: JSON.parse(input.text) };
  } catch {
    return { ...input, ok: false, blocker: `${prefix}_json_invalid` };
  }
}

function decisionSection(text, decisionId) {
  const lines = String(text || "").split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^##\s+([^\s—–-]+(?:-[^\s—–]+)*)/);
    if (match?.[1] === decisionId) starts.push(index);
  }
  if (starts.length !== 1) return { ok: false, blocker: starts.length === 0 ? "resolution_decision_not_found" : "resolution_decision_ambiguous" };
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) { end = index; break; }
  }
  const section = lines.slice(start, end).join("\n");
  return { ok: true, section, section_sha256: sha256(section) };
}

function receiptPasses(json) {
  if (verificationStatusIsPass(json?.status, "execution") || verificationStatusIsPass(json?.outcome, "execution")) return true;
  const summary = json?.summary;
  if (!summary || typeof summary !== "object") return false;
  const total = Number(summary.total);
  return Number.isFinite(total) && total > 0 && Number(summary.passed) === total
    && Number(summary.failed || 0) === 0 && Number(summary.warned || 0) === 0
    && Number(summary.not_implemented || 0) === 0;
}

function verifyDecision({ cwd, ticketId, decisionRef, gitRunner }) {
  const path = asString(decisionRef?.path);
  const id = asString(decisionRef?.id);
  if (!path || !id) return { ok: false, blockers: ["resolution_decision_ref_invalid"], normalized: null };
  const committed = committedText({ cwd, path, gitRunner, prefix: "resolution_decision" });
  if (!committed.ok) return { ok: false, blockers: [committed.blocker], normalized: null };
  const located = decisionSection(committed.text, id);
  if (!located.ok) return { ok: false, blockers: [located.blocker], normalized: null };
  if (!textReferencesTicketId(located.section, ticketId)) {
    return { ok: false, blockers: ["resolution_decision_ticket_mismatch"], normalized: null };
  }
  return {
    ok: true,
    blockers: [],
    normalized: { path: committed.path, id, file_sha256: committed.sha256, section_sha256: located.section_sha256 },
  };
}

function verifyEvidenceRef({ cwd, ticketId, evidenceRef, gitRunner }) {
  const kind = lower(evidenceRef?.kind);
  if (kind === "git_commit") {
    const commit = asString(evidenceRef?.commit);
    if (!commit) return { ok: false, blocker: "resolution_commit_missing", normalized: null };
    const verified = verifyLifecycleCommitEvidence({ cwd, ticketId: "", commit, gitRunner });
    if (!verified.exists) return { ok: false, blocker: "resolution_commit_missing", normalized: null };
    if (!verified.reachable) return { ok: false, blocker: "resolution_commit_not_head_reachable", normalized: null };
    return { ok: true, blocker: null, normalized: { kind, commit: verified.hash } };
  }
  if (kind === "json_receipt") {
    const committed = parseJsonCommitted(
      committedText({ cwd, path: evidenceRef?.path, gitRunner, prefix: "resolution_receipt" }),
      "resolution_receipt",
    );
    if (!committed.ok) return { ok: false, blocker: committed.blocker, normalized: null };
    if (!receiptPasses(committed.json)) return { ok: false, blocker: "resolution_receipt_not_passing", normalized: null };
    return { ok: true, blocker: null, normalized: { kind, path: committed.path, sha256: committed.sha256 } };
  }
  return { ok: false, blocker: "resolution_evidence_kind_unsupported", normalized: null };
}

function verifyEntry({ cwd, entry, gitRunner }) {
  const ticketId = asString(entry?.ticket_id);
  const classification = lower(entry?.classification);
  const evidenceRefs = asArray(entry?.evidence_refs);
  const blockers = [];
  if (!ticketId) blockers.push("resolution_ticket_id_required");
  if (!PROPOSED_RESOLUTION_CLASSIFICATIONS.has(classification)) blockers.push("resolution_classification_unsupported");
  const decision = verifyDecision({ cwd, ticketId, decisionRef: entry?.decision_ref, gitRunner });
  blockers.push(...decision.blockers);
  if (evidenceRefs.length === 0) blockers.push("resolution_evidence_required");
  if (evidenceRefs.length > MAX_EVIDENCE_REFS) blockers.push("resolution_evidence_limit_exceeded");
  const evidence = evidenceRefs.slice(0, MAX_EVIDENCE_REFS).map((ref) => verifyEvidenceRef({ cwd, ticketId, evidenceRef: ref, gitRunner }));
  blockers.push(...evidence.map((item) => item.blocker).filter(Boolean));
  return {
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    blockers: unique(blockers),
    ticket_id: ticketId,
    classification,
    decision_ref: decision.normalized,
    evidence_refs: evidence.map((item) => item.normalized).filter(Boolean),
  };
}

export function loadProposedResolutionRequest(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const gitRunner = options.gitRunner || defaultGitRunner;
  const committed = parseJsonCommitted(
    committedText({ cwd, path: options.requestPath, gitRunner, prefix: "resolution_request" }),
    "resolution_request",
  );
  if (!committed.ok) return committed;
  const request = committed.json;
  if (request?.schema_version !== "program_proposed_resolution_request.v1") return { ...committed, ok: false, blocker: "resolution_request_schema_invalid" };
  const programId = asString(request?.program_id);
  const programPacketPath = normalizeRepoPath(request?.program_packet_path);
  if (!programId) return { ...committed, ok: false, blocker: "resolution_request_program_id_required" };
  if (!isSafeResolutionRepoPath(programPacketPath)) return { ...committed, ok: false, blocker: "resolution_request_program_path_unsafe" };
  const rows = asArray(request?.resolutions);
  if (rows.length === 0 || rows.length > MAX_REQUEST_ENTRIES) return { ...committed, ok: false, blocker: "resolution_request_entry_count_invalid" };
  const ids = rows.map((row) => asString(row?.ticket_id));
  if (new Set(ids).size !== ids.length) return { ...committed, ok: false, blocker: "resolution_request_duplicate_ticket" };
  return {
    ok: true,
    path: committed.path,
    sha256: committed.sha256,
    program_id: programId,
    program_packet_path: programPacketPath,
    entries: rows.map((entry) => verifyEntry({ cwd, entry, gitRunner })),
  };
}

export function verifyPersistedProposedResolution(options = {}) {
  const ticket = options.ticket;
  const stored = ticket?.backlog_disposition?.resolution_evidence;
  const requestPath = asString(stored?.request_ref);
  if (!requestPath) return { ok: false, blockers: ["resolution_persisted_evidence_missing"] };
  const loaded = loadProposedResolutionRequest({ ...options, requestPath });
  if (!loaded.ok) return { ok: false, blockers: [loaded.blocker] };
  const entry = loaded.entries.find((item) => item.ticket_id === asString(ticket?.id));
  const blockers = [...asArray(entry?.blockers)];
  const currentProgramPath = repoRelativePath(options.cwd || process.cwd(), options.programPacketPath);
  if (!entry) blockers.push("resolution_request_ticket_missing");
  if (options.programId && loaded.program_id !== asString(options.programId)) blockers.push("resolution_request_program_mismatch");
  if (!currentProgramPath) blockers.push("resolution_program_path_required");
  else if (loaded.program_packet_path !== currentProgramPath) blockers.push("resolution_request_program_path_mismatch");
  if (loaded.sha256 !== asString(stored?.request_sha256)) blockers.push("resolution_request_digest_mismatch");
  if (entry?.classification !== lower(ticket?.backlog_disposition?.classification)) blockers.push("resolution_persisted_classification_mismatch");
  if (JSON.stringify(entry?.decision_ref || null) !== JSON.stringify(stored?.decision_ref || null)) blockers.push("resolution_persisted_decision_mismatch");
  if (JSON.stringify(entry?.evidence_refs || []) !== JSON.stringify(stored?.evidence_refs || [])) blockers.push("resolution_persisted_refs_mismatch");
  return { ok: blockers.length === 0, blockers: unique(blockers), request: loaded, entry };
}
