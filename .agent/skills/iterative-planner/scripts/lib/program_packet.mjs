// program_packet.mjs — Program Packet loading, validation, and Prolog facts.
//
// The Program Manager layer is intentionally additive. Missing packets are a
// SKIP condition for the CLI, and child implementation remains owned by the
// iterative planner state machine.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { extname, isAbsolute, join, relative, resolve } from "path";
import { sanitizeAtom, sanitizeStrictId, sanitizeEnumAtom } from "./sanitize.mjs";
import { parseAnnotations } from "../annotation_parser.mjs";
import { extractFilesToModify } from "./plan_utils.mjs";
import { lintMistakeMitigations } from "./mistake_mitigation_linter.mjs";
import { detectQuantPersonaScope } from "./quant_persona_gate.mjs";
import { normalizeRemoteMode, resolveExplicitRemoteMode } from "./remote_mode.mjs";
import { evaluateGateSatisfiability } from "./gate_satisfiability.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";
import {
  PROPOSED_RESOLUTION_CLASSIFICATIONS,
  verifyPersistedProposedResolution,
} from "./program_resolution_evidence.mjs";

export const PROGRAM_STATUSES = new Set(["design", "ready", "executing", "validating", "closed", "deferred"]);
export const CANONICAL_TICKET_LIFECYCLES = new Set([
  "proposed",
  "ready",
  "in_progress",
  "blocked",
  "done",
  "verified",
  "closed",
  "deferred",
]);
export const TICKET_LIFECYCLE_ALIASES = new Map([
  ["submitted", "proposed"],
  ["review_ready", "proposed"],
]);
export const TICKET_LIFECYCLES = new Set([
  ...CANONICAL_TICKET_LIFECYCLES,
  ...TICKET_LIFECYCLE_ALIASES.keys(),
]);
export const TICKET_REVIEW_STATUSES = new Set([
  "not_run",
  "submitted",
  "fresh",
  "needs_story",
  "needs_annotation",
  "needs_verification",
  "ontology_conflict",
  "blocked",
  "review_ready",
  "unavailable",
]);
export const AWAITING_EXTERNAL_ACTION_LIFECYCLES = new Set(["in_progress", "blocked"]);
export const AWAITING_EXTERNAL_ACTION_KINDS = new Set(["operator_run", "human_decision"]);
export const CHILD_PLAN_POLICIES = new Set(["required", "lightweight", "not_required", "waived"]);
export const NON_EXECUTABLE_TICKET_TYPES = new Set(["artifact", "administrative", "decision", "research"]);
export const READY_OR_LATER = new Set(["ready", "in_progress", "done", "verified", "closed"]);
export const DONE_OR_LATER = new Set(["done", "verified", "closed"]);
// proof-status-lint: exempt T-INTAKE-B07B8898 -- Program dependency lifecycle enum (verified, closed, deferred), not an authored verification outcome; missing and unknown lifecycle values do not satisfy Set membership.
export const DEPENDENCY_PROOF_LIFECYCLES = new Set(["verified", "closed", "deferred"]);
export const VERIFIED_OR_CLOSED = new Set(["verified", "closed"]);
const FORWARD_TICKET_LIFECYCLE_RANK = new Map([
  ["proposed", 0],
  ["ready", 1],
  ["in_progress", 2],
  ["done", 3],
  ["verified", 4],
  ["closed", 5],
]);
export const ADMINISTRATIVE_BACKLOG_DISPOSITION_CLASSIFICATIONS = new Set([
  "close_obsolete",
  "fold_into_existing_ticket",
]);
const DEPENDENCY_WAIVER_TYPES = new Set(["dependency_waiver", "dependency-waiver", "dependency_waived", "waive_dependency", "waiver"]);
const CHILD_PLAN_STRUCTURAL_FAILURE_STATES = new Set(["invalid", "poisoned"]);
const CHILD_PLAN_POISON_FAIL_THRESHOLD = 3;
const CHILD_PLAN_REPLAN_THRESHOLD = 3;
const NEXT_CHILD_PLAN_GATE_BY_STATE = new Map([
  ["explore", "explore-to-plan"],
  ["plan", "plan-to-execute"],
  ["execute", "execute-to-reflect"],
  ["reflect", "reflect-to-validate"],
  ["validate", "validate-to-close"],
]);
const ANNOTATION_CLOSE_LIFECYCLES = new Set(["done", "verified", "closed"]);
const ANNOTATION_CODE_EXTENSIONS = new Set([
  ".py", ".js", ".mjs", ".ts", ".tsx", ".pl", ".rs", ".go", ".rb", ".sh",
  ".yaml", ".yml", ".toml", ".r", ".jl", ".php", ".java", ".c", ".cpp",
  ".h", ".swift", ".kt",
]);
export const PROGRAM_REMOTE_POLICY_REQUIREMENT = "program.remote_policy_resolution";
export const PROGRAM_REMOTE_REPOSITORY_REQUIREMENT = "program.remote_repository_identity";
// @planner:config_flag = program_ticket_verified
// @planner:mutually_exclusive = required_child_plan_open
// Program tickets cannot be treated as verified while a required child plan remains open.

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lower(value) {
  return asString(value).toLowerCase();
}

function ticketPersonaReviewStatus(ticket) {
  return lower(
    ticket?.persona_review?.status ||
    ticket?.personaReview?.status ||
    ticket?.persona_review_status ||
    ticket?.personaReviewStatus ||
    ticket?.last_persona_review_status ||
    ticket?.lastPersonaReviewStatus
  );
}

export function effectiveTicketLifecycle(value) {
  const normalized = lower(value);
  return TICKET_LIFECYCLE_ALIASES.get(normalized) || normalized;
}

function ticketLifecycleSatisfiesRequirement(observed, required) {
  if (observed === required) return true;
  const observedRank = FORWARD_TICKET_LIFECYCLE_RANK.get(observed);
  const requiredRank = FORWARD_TICKET_LIFECYCLE_RANK.get(required);
  return observedRank !== undefined && requiredRank !== undefined && observedRank >= requiredRank;
}

function isSafeRelativeEvidenceRoot(value) {
  const raw = asString(value).replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-z]:\//i.test(raw)) return false;
  return !raw.split("/").some((segment) => segment === "..");
}

function isJsonMatchScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function validateAwaitingExternalAction(value, { lifecycle = "" } = {}) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add("awaiting_external_action_invalid", "", "awaiting_external_action must be an object");
    return { ok: false, errors, normalized: null };
  }

  const allowedActionKeys = new Set(["kind", "reason", "expected_evidence", "recorded_at"]);
  for (const key of Object.keys(value)) {
    if (!allowedActionKeys.has(key)) add("awaiting_external_action_unknown_field", key, `Unsupported awaiting_external_action field: ${key}`);
  }

  const effectiveLifecycle = effectiveTicketLifecycle(lifecycle);
  if (!AWAITING_EXTERNAL_ACTION_LIFECYCLES.has(effectiveLifecycle)) {
    add(
      "awaiting_external_action_illegal_lifecycle",
      "lifecycle",
      "awaiting_external_action is legal only on in_progress or blocked tickets",
    );
  }

  const kind = lower(value.kind);
  if (!AWAITING_EXTERNAL_ACTION_KINDS.has(kind)) {
    add("awaiting_external_action_invalid_kind", "kind", "kind must be operator_run or human_decision");
  }
  const reason = asString(value.reason);
  if (!reason) add("awaiting_external_action_missing_reason", "reason", "reason is required");
  const recordedAt = asString(value.recorded_at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(recordedAt) || Number.isNaN(Date.parse(recordedAt))) {
    add("awaiting_external_action_invalid_recorded_at", "recorded_at", "recorded_at must be an ISO8601 UTC timestamp");
  }

  const expected = value.expected_evidence;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    add("awaiting_external_action_invalid_expected_evidence", "expected_evidence", "expected_evidence must be an object");
  } else {
    const allowedEvidenceKeys = new Set(["type", "root", "match"]);
    for (const key of Object.keys(expected)) {
      if (!allowedEvidenceKeys.has(key)) add("awaiting_external_action_unknown_evidence_field", `expected_evidence.${key}`, `Unsupported expected_evidence field: ${key}`);
    }
    if (lower(expected.type) !== "json_match") {
      add("awaiting_external_action_invalid_evidence_type", "expected_evidence.type", "expected_evidence.type must be json_match");
    }
    if (!isSafeRelativeEvidenceRoot(expected.root)) {
      add("awaiting_external_action_unsafe_evidence_root", "expected_evidence.root", "expected_evidence.root must be a safe repository-relative path");
    }
    const match = expected.match;
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      add("awaiting_external_action_invalid_evidence_match", "expected_evidence.match", "expected_evidence.match must be a non-empty object");
    } else {
      const entries = Object.entries(match);
      if (entries.length < 1 || entries.length > 8) {
        add("awaiting_external_action_invalid_evidence_match", "expected_evidence.match", "expected_evidence.match must contain between 1 and 8 scalar fields");
      }
      for (const [key, matchValue] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || !isJsonMatchScalar(matchValue)) {
          add("awaiting_external_action_invalid_evidence_match", `expected_evidence.match.${key}`, "match keys must be simple names and values must be JSON scalars");
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: errors.length === 0 ? {
      kind,
      reason,
      expected_evidence: {
        type: "json_match",
        root: asString(expected.root).replace(/\\/g, "/").replace(/^\.\//, ""),
        match: { ...expected.match },
      },
      recorded_at: recordedAt,
    } : null,
  };
}

function hasRefs(value) {
  return asArray(value).some((entry) => asString(entry));
}

const GENERIC_ACCEPTANCE_TEXT_PATTERNS = [
  /traceable scope,\s*acceptance criteria,\s*and verification evidence/i,
  /the proposed ticket has traceable scope/i,
  /there is acceptance criteria/i,
  /acceptance criteria exists?/i,
];

function isGenericAcceptanceText(value) {
  const text = asString(value);
  if (!text) return true;
  return GENERIC_ACCEPTANCE_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function issue(collection, code, path, message) {
  collection.push({ code, path, message });
}

function idSet(entries) {
  return new Set(asArray(entries).map((entry) => asString(entry?.id)).filter(Boolean));
}

function mapById(entries) {
  const map = new Map();
  for (const entry of asArray(entries)) {
    const id = asString(entry?.id);
    if (id) map.set(id, entry);
  }
  return map;
}

function objectText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "");
  }
}

function collectPacketPersonaPacks(packet) {
  const packs = [];
  for (const value of asArray(packet?.persona_packs)) packs.push(asString(value));
  for (const ticket of asArray(packet?.tickets)) {
    for (const value of asArray(ticket?.persona_packs)) packs.push(asString(value));
    for (const value of asArray(ticket?.persona_review?.persona_packs)) packs.push(asString(value));
  }
  return packs.map((value) => lower(value)).filter(Boolean);
}

function packetHasScopedClaimPersona(packet) {
  const text = objectText({
    id: packet?.id,
    title: packet?.title,
    goal: packet?.goal,
    ticket_types: asArray(packet?.tickets).map((ticket) => ticket?.ticket_type || ticket?.type),
    persona_packs: collectPacketPersonaPacks(packet),
  });
  const personaPacks = collectPacketPersonaPacks(packet);
  const explicitQuantPack = personaPacks.some((pack) => pack === "quant" || pack === "quant_target" || pack === "quant_research_protocol");
  const explicitQuantTicket = asArray(packet?.tickets).some((ticket) => /(^|[_-])quant([_-]|$)/i.test(asString(ticket?.ticket_type || ticket?.type || ticket?.title)));
  const scope = detectQuantPersonaScope({
    sourceText: text,
    packet,
    acceptanceCriteria: packet?.acceptance_criteria,
    verificationRows: packet?.verification_matrix,
  });
  return explicitQuantPack || explicitQuantTicket || scope.required === true;
}

function hasHypothesisSpaceLedger(packet) {
  const ledger = packet?.hypothesis_space;
  if (Array.isArray(ledger)) return ledger.length > 0;
  if (!ledger || typeof ledger !== "object") return false;
  if (Array.isArray(ledger.dimensions)) return ledger.dimensions.length > 0;
  if (ledger.dimensions && typeof ledger.dimensions === "object") return Object.keys(ledger.dimensions).length > 0;
  return Object.keys(ledger).length > 0;
}

const NEGATIVE_GRADE_TOKENS = new Set([
  "negative",
  "no_go",
  "no-go",
  "no go",
  "nogo",
  "not_promotable",
  "not-promotable",
  "not promotable",
  "rejected",
  "reject",
  "failed",
  "fail",
  "failure",
  "blocked",
  "insufficient",
]);

function normalizedFindingGrade(entry) {
  return lower(entry?.grade || entry?.verdict || entry?.result || entry?.status || entry?.classification || entry?.outcome);
}

function hasTestedRegionCitation(entry) {
  if (!entry || typeof entry !== "object") return false;
  const direct = [
    entry.tested_region,
    entry.tested_region_summary,
    entry.tested_region_ref,
    entry.scope_citation,
    entry.scope_citation_ref,
    entry.hypothesis_space_ref,
  ];
  if (direct.some((value) => {
    if (typeof value === "string") return !!value.trim();
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return false;
  })) return true;
  return hasRefs(entry.hypothesis_space_refs) || hasRefs(entry.tested_region_refs);
}

function negativeFindingsLedgerEntries(packet) {
  return asArray(packet?.findings_ledger)
    .map((entry, index) => ({ entry, index, id: asString(entry?.id) || `finding_${index + 1}` }))
    .filter(({ entry }) => NEGATIVE_GRADE_TOKENS.has(normalizedFindingGrade(entry)));
}

function programNoGoVerdict(packet) {
  const raw = packet?.program_verdict;
  const verdictObject = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const verdict = lower(
    verdictObject?.verdict ||
    verdictObject?.status ||
    verdictObject?.grade ||
    raw ||
    packet?.verdict ||
    packet?.program_status_verdict
  );
  if (!NEGATIVE_GRADE_TOKENS.has(verdict)) return null;
  return verdictObject || {
    id: "program_verdict",
    verdict,
    tested_region: packet?.tested_region,
    tested_region_ref: packet?.tested_region_ref,
    hypothesis_space_refs: packet?.hypothesis_space_refs,
  };
}

export function evaluateScopeCitationLedger(packet, options = {}) {
  const programId = asString(packet?.id) || "program";
  const required = packetHasScopedClaimPersona(packet);
  const hypothesisSpaceLedgerPresent = hasHypothesisSpaceLedger(packet);
  const negativeFindings = negativeFindingsLedgerEntries(packet);
  const noGoVerdict = programNoGoVerdict(packet);
  const blockingIssues = [];
  const warnings = [];

  if (required && !hypothesisSpaceLedgerPresent) {
    warnings.push({
      code: "hypothesis_space_ledger_missing",
      path: "$.hypothesis_space",
      message: "Scope-citation persona packet is missing optional hypothesis_space ledger; this is warning-only during the compatibility window unless negative/no_go claims lack tested-region citations.",
    });
  }

  if (required && options.enforceNegativeCitations === true) {
    for (const finding of negativeFindings) {
      if (!hasTestedRegionCitation(finding.entry)) {
        blockingIssues.push({
          code: "negative_finding_missing_tested_region",
          path: `$.findings_ledger[${finding.id}]`,
          message: `Negative finding ${finding.id} must cite the tested region or a hypothesis_space ref before program validation.`,
        });
      }
    }
    if (noGoVerdict && !hasTestedRegionCitation(noGoVerdict)) {
      blockingIssues.push({
        code: "program_no_go_missing_tested_region",
        path: "$.program_verdict",
        message: `Program ${programId} no_go/negative verdict must cite the tested region or a hypothesis_space ref before program validation.`,
      });
    }
  }

  return {
    required,
    program_id: programId,
    hypothesis_space_ledger_present: hypothesisSpaceLedgerPresent,
    negative_findings: negativeFindings.map((finding) => ({
      id: finding.id,
      cited: hasTestedRegionCitation(finding.entry),
    })),
    no_go_verdict: !!noGoVerdict,
    no_go_verdict_cited: noGoVerdict ? hasTestedRegionCitation(noGoVerdict) : false,
    warnings,
    blocking_issues: blockingIssues,
  };
}

function subjectExists(subjectRef, { programId, epicsById, ticketsById }) {
  if (!subjectRef) return false;
  return subjectRef === programId || epicsById.has(subjectRef) || ticketsById.has(subjectRef);
}

export function ticketHasGithubIssueMirror(ticket) {
  return asArray(ticket?.external_refs).some((ref) => {
    const kind = lower(ref?.kind);
    const hasIssueIdentity = asString(ref?.url) || asString(ref?.issue_url) || (ref?.issue_number !== undefined && ref?.issue_number !== null);
    if (!hasIssueIdentity) return false;
    if (kind === "github_issue") return true;
    if (kind === "github_project_item") return true;
    return false;
  });
}

function packetRemoteModePolicy(packet) {
  const candidates = [
    { path: "$.remote_mode", value: packet?.remote_mode },
    { path: "$.remoteMode", value: packet?.remoteMode },
    { path: "$.remote_policy.mode", value: packet?.remote_policy?.mode },
    { path: "$.remote_policy.remote_mode", value: packet?.remote_policy?.remote_mode },
    { path: "$.remotePolicy.mode", value: packet?.remotePolicy?.mode },
    { path: "$.remotePolicy.remoteMode", value: packet?.remotePolicy?.remoteMode },
    { path: "$.github_mirror.remote_mode", value: packet?.github_mirror?.remote_mode },
    { path: "$.githubMirror.remoteMode", value: packet?.githubMirror?.remoteMode },
  ];
  const configured = candidates.filter((candidate) => asString(candidate.value));
  if (configured.length === 0) return { path: "$.remote_mode", value: null };
  const modes = [...new Set(configured.map((candidate) => normalizeRemoteMode(candidate.value)))];
  if (modes.length > 1) {
    throw new Error(`Conflicting Program remote-mode fields: ${configured.map((candidate) => `${candidate.path}=${asString(candidate.value)}`).join(", ")}`);
  }
  return configured[0];
}

function validRepositorySlug(value) {
  const slug = asString(value);
  if (!slug || /\s/.test(slug)) return false;
  const parts = slug.split("/");
  return parts.length === 2 && parts.every((part) => part && part !== "." && part !== "..");
}

export function normalizeProgramRepositorySlug(value) {
  const slug = asString(value).replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return validRepositorySlug(slug) ? slug : "";
}

function directPacketRepositoryCandidates(packet) {
  return [
    { path: "$.remote_policy.repository_slug", value: packet?.remote_policy?.repository_slug },
    { path: "$.remotePolicy.repositorySlug", value: packet?.remotePolicy?.repositorySlug },
    { path: "$.repository_slug", value: packet?.repository_slug },
  ].filter((candidate) => asString(candidate.value));
}

function externalReferenceRepositories(packet) {
  const refs = [
    ...asArray(packet?.external_refs),
    ...asArray(packet?.tickets).flatMap((ticket) => asArray(ticket?.external_refs)),
  ];
  return [...new Set(refs.map((ref) => normalizeProgramRepositorySlug(ref?.repo || ref?.repository_slug)).filter(Boolean))].sort();
}

export function resolveProgramRepositoryIdentity(packet, options = {}) {
  const packetCandidates = directPacketRepositoryCandidates(packet);
  if (packetCandidates.length > 0) {
    const normalized = packetCandidates.map((candidate) => ({
      ...candidate,
      slug: normalizeProgramRepositorySlug(candidate.value),
    }));
    const invalid = normalized.filter((candidate) => !candidate.slug);
    const source = packetCandidates.map((candidate) => candidate.path).join(", ");
    if (invalid.length > 0) {
      return { status: "invalid", slug: null, source, candidates: invalid.map((candidate) => asString(candidate.value)) };
    }
    const slugs = [...new Set(normalized.map((candidate) => candidate.slug))].sort();
    if (slugs.length > 1) {
      return { status: "ambiguous", slug: null, source, candidates: slugs };
    }
    return { status: "resolved", slug: slugs[0], source: packetCandidates[0].path, candidates: slugs };
  }

  const cliCandidate = asString(options.repo || options.repositorySlug || options.repository_slug);
  if (cliCandidate) {
    const slug = normalizeProgramRepositorySlug(cliCandidate);
    return slug
      ? { status: "resolved", slug, source: "cli:--repo", candidates: [slug] }
      : { status: "invalid", slug: null, source: "cli:--repo", candidates: [cliCandidate] };
  }

  const env = options.env || process.env;
  const envCandidate = asString(env?.PLANNER_REPOSITORY || env?.GITHUB_REPOSITORY);
  if (envCandidate) {
    const slug = normalizeProgramRepositorySlug(envCandidate);
    return slug
      ? { status: "resolved", slug, source: asString(env?.PLANNER_REPOSITORY) ? "env:PLANNER_REPOSITORY" : "env:GITHUB_REPOSITORY", candidates: [slug] }
      : { status: "invalid", slug: null, source: "environment", candidates: [envCandidate] };
  }

  const externalRepositories = externalReferenceRepositories(packet);
  if (externalRepositories.length === 1) {
    return { status: "resolved", slug: externalRepositories[0], source: "$.tickets[].external_refs[].repo", candidates: externalRepositories };
  }
  if (externalRepositories.length > 1) {
    return { status: "ambiguous", slug: null, source: "$.tickets[].external_refs[].repo", candidates: externalRepositories };
  }
  return { status: "missing", slug: null, source: null, candidates: [] };
}

function programRequirementWaivers(packet) {
  return asArray(packet?.gate_requirement_waivers || packet?.gateRequirementWaivers);
}

export function resolveProgramPacketRemotePolicy(packet, options = {}) {
  const packetPolicy = packetRemoteModePolicy(packet);
  const repository = resolveProgramRepositoryIdentity(packet, options);
  let modeResolution = null;
  if (asString(packetPolicy.value)) {
    modeResolution = {
      mode: normalizeRemoteMode(packetPolicy.value),
      source: packetPolicy.path,
      raw: asString(packetPolicy.value),
    };
  } else {
    modeResolution = resolveExplicitRemoteMode({
      explicit: options.remoteMode ?? options.remote_mode ?? null,
      explicitSource: "cli:--remote-mode",
      env: options.env || process.env,
    });
  }
  const effectiveMode = modeResolution?.mode || "local-only";
  const modeResolved = !!modeResolution;
  const repositoryRequired = effectiveMode === "remote-read" || effectiveMode === "remote-sync";
  const policyReason = repository.status === "ambiguous"
    ? `Program remote policy is unresolved because repository identity is ambiguous: ${repository.candidates.join(", ")}.`
    : "Program remote policy is unresolved: choose an explicit local/remote mode or record a governed waiver. Repository identity alone is not policy authority.";
  const requirements = [
    {
      id: PROGRAM_REMOTE_POLICY_REQUIREMENT,
      description: "Program work must have an explicit local/remote policy before lifecycle gates proceed.",
      applicable: true,
      satisfied: modeResolved,
      reason: policyReason,
      resolution_options: [
        { id: "set_local_only", action: "Set explicit local-only mode.", command: "--remote-mode local-only" },
        { id: "provide_repository", action: "Select explicit remote-sync and provide canonical repository identity.", command: "--remote-mode remote-sync --repo owner/name" },
        { id: "record_governed_waiver", action: "Record a decision-backed gate requirement waiver." },
      ],
      metadata: { mode_source: modeResolution?.source || null },
    },
    {
      id: PROGRAM_REMOTE_REPOSITORY_REQUIREMENT,
      description: "Remote Program policy needs one canonical repository identity.",
      applicable: repositoryRequired,
      satisfied: repository.status === "resolved",
      reason: repository.status === "ambiguous"
        ? `Remote policy has multiple repository identities: ${repository.candidates.join(", ")}.`
        : repository.status === "invalid"
          ? `Remote policy repository identity is invalid: ${repository.candidates.join(", ")}.`
          : "Remote policy requires a repository slug such as owner/name.",
      resolution_options: [
        { id: "provide_repository", action: "Provide one canonical repository slug.", command: "--repo owner/name" },
        { id: "set_local_only", action: "Set explicit local-only mode.", command: "--remote-mode local-only" },
        { id: "record_governed_waiver", action: "Record a decision-backed gate requirement waiver." },
      ],
      metadata: { repository_status: repository.status },
    },
  ];
  const gateSatisfiability = evaluateGateSatisfiability({
    requirements,
    waivers: programRequirementWaivers(packet),
    decisions: asArray(packet?.decisions),
  });

  return {
    effective_mode: effectiveMode,
    mode_source: modeResolution?.source || "compatibility_default",
    mode_explicit: modeResolved,
    repository,
    gate_satisfiability: gateSatisfiability,
  };
}

export function resolveProgramPacketRemoteMode(packet, options = {}) {
  return resolveProgramPacketRemotePolicy(packet, options).effective_mode;
}

export function programGithubIssueMirrorRequired(packet, options = {}) {
  return resolveProgramPacketRemoteMode(packet, options) === "remote-sync";
}

export function backlogDispositionDecisionRef(ticket) {
  const disposition = ticket?.backlog_disposition;
  if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)) return "";
  return asString(disposition.decision_ref || disposition.decisionRef);
}

export function isSupportedAdministrativeBacklogDisposition(ticket, options = {}) {
  const disposition = ticket?.backlog_disposition;
  if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)) return false;
  const classification = lower(disposition.classification);
  if (PROPOSED_RESOLUTION_CLASSIFICATIONS.has(classification)) {
    if (!options.cwd) return false;
    return verifyPersistedProposedResolution({
      cwd: options.cwd,
      ticket,
      programId: options.programId,
      programPacketPath: options.programPacketPath,
    }).ok;
  }
  if (!ADMINISTRATIVE_BACKLOG_DISPOSITION_CLASSIFICATIONS.has(classification)) return false;
  const decisionRef = backlogDispositionDecisionRef(ticket);
  if (!decisionRef) return false;
  const decisionsById = options.decisionsById instanceof Map ? options.decisionsById : null;
  if (decisionsById && !decisionsById.has(decisionRef)) return false;
  return true;
}

export function isAdministrativeClosureTicket(ticket, options = {}) {
  return effectiveTicketLifecycle(ticket?.lifecycle) === "closed" &&
    isSupportedAdministrativeBacklogDisposition(ticket, options);
}

export function isDispositionResolvedTicket(ticket, options = {}) {
  const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
  return ["closed", "deferred"].includes(lifecycle) &&
    isSupportedAdministrativeBacklogDisposition(ticket, options);
}

function dependencyTarget(dep) {
  return asString(dep?.to_ref || dep?.target_ref || dep?.target || dep?.blocks);
}

function dependencySource(dep) {
  return asString(dep?.from_ref || dep?.source_ref || dep?.source || dep?.blocked_by);
}

function decisionForSubject(decisions, subjectRef, allowedTypes) {
  return asArray(decisions).find((decision) => {
    const type = lower(decision?.type || decision?.kind);
    const subject = asString(decision?.subject_ref || decision?.ticket_ref);
    return subject === subjectRef && allowedTypes.has(type);
  }) || null;
}

function decisionDependencyRef(decision) {
  return asString(
    decision?.dependency_ref ||
    decision?.depends_on_ref ||
    decision?.dep_ref ||
    decision?.blocker_ref ||
    decision?.prerequisite_ref
  );
}

function hasDependencyWaiver(decisions, ticketId, depId) {
  return asArray(decisions).some((decision) => {
    const type = lower(decision?.type || decision?.kind);
    const subject = asString(decision?.subject_ref || decision?.ticket_ref);
    const dependency = decisionDependencyRef(decision);
    return DEPENDENCY_WAIVER_TYPES.has(type) && subject === ticketId && dependency === depId;
  });
}

function dependencyProofSatisfied(depTicket, decisions, ticketId, depId) {
  return DEPENDENCY_PROOF_LIFECYCLES.has(effectiveTicketLifecycle(depTicket?.lifecycle)) ||
    hasDependencyWaiver(decisions, ticketId, depId);
}

function normalizeVerificationResult(row) {
  return normalizeVerificationStatus(row?.result || row?.status || row?.outcome, "program");
}

function isPassingVerificationRow(row) {
  const status = normalizeVerificationResult(row);
  return status.valid && status.satisfies && status.kind === "pass";
}

function isWaivedVerificationRow(row) {
  const status = normalizeVerificationResult(row);
  return status.valid && status.satisfies && status.kind === "waived";
}

function childPlanStateCandidates(planDir, cwd) {
  if (!planDir) return [];
  return [
    isAbsolute(planDir) ? join(planDir, "state.json") : join(cwd, planDir, "state.json"),
    join(cwd, "plans", planDir, "state.json"),
  ];
}

function childPlanBases(planDir, cwd) {
  if (!planDir || !cwd) return [];
  return [...new Set([
    isAbsolute(planDir) ? planDir : join(cwd, planDir),
    join(cwd, "plans", planDir),
  ])];
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function loadChildPlanSnapshot(ticket, cwd) {
  const child = ticket?.child_plan || {};
  const explicit = lower(child.state || child.status);
  const planDir = asString(child.plan_dir);

  if (!planDir) {
    return {
      plan_dir: null,
      state: explicit,
      explicit_state: explicit,
      state_path: null,
      base_dir: null,
      state_json: null,
      plan_content: "",
      transitions: [],
    };
  }

  if (!cwd) {
    return {
      plan_dir: planDir,
      state: explicit || "missing_plan_dir",
      explicit_state: explicit,
      state_path: null,
      base_dir: null,
      state_json: null,
      plan_content: "",
      transitions: [],
    };
  }

  const candidates = childPlanStateCandidates(planDir, cwd);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = readJsonFile(candidate);
    const baseDir = candidate.replace(/\/state\.json$/, "");
    return {
      plan_dir: planDir,
      state: parsed ? lower(parsed?.state) : "invalid",
      explicit_state: explicit,
      state_path: candidate,
      base_dir: baseDir,
      state_json: parsed,
      plan_content: existsSync(join(baseDir, "plan.md")) ? readFileSync(join(baseDir, "plan.md"), "utf-8") : "",
      transitions: Array.isArray(parsed?.transitions) ? parsed.transitions : [],
    };
  }
  return {
    plan_dir: planDir,
    state: "missing_plan_dir",
    explicit_state: explicit,
    state_path: null,
    base_dir: null,
    state_json: null,
    plan_content: "",
    transitions: [],
  };
}

function childPlanState(ticket, cwd) {
  return loadChildPlanSnapshot(ticket, cwd).state;
}

function normalizeTransitionKey(value) {
  return lower(value).replace(/[_\s]+/g, "-");
}

function childPlanTransitionGateKey(entry) {
  const explicit = asString(entry?.gate || entry?.name || entry?.transition);
  if (explicit) return normalizeTransitionKey(explicit);

  const from = normalizeTransitionKey(entry?.from);
  const to = normalizeTransitionKey(entry?.to);
  if (from && to && from !== to) return `${from}-to-${to}`;
  if (from && to && from === to) return NEXT_CHILD_PLAN_GATE_BY_STATE.get(from) || from;
  if (from && lower(entry?.gate_result || entry?.result || entry?.status) === "fail") {
    return NEXT_CHILD_PLAN_GATE_BY_STATE.get(from) || from;
  }
  return normalizeTransitionKey(entry?.to || entry?.state);
}

function consecutiveFailTail(transitions, gate) {
  const relevant = asArray(transitions)
    .filter((entry) => childPlanTransitionGateKey(entry) === gate)
    .reverse();
  let count = 0;
  const failureCodes = [];
  for (const entry of relevant) {
    if (normalizeVerificationStatus(entry?.gate_result || entry?.result || entry?.status, "gate").kind !== "fail") break;
    count += 1;
    failureCodes.push(...asArray(entry?.failure_codes).map(asString).filter(Boolean));
  }
  return { count, failure_codes: [...new Set(failureCodes)] };
}

function childPlanFailureSignals(ticket, cwd) {
  const snapshot = loadChildPlanSnapshot(ticket, cwd);
  const signals = [];
  if (snapshot.state === "missing_plan_dir" && snapshot.plan_dir) {
    signals.push({
      code: "child_plan_missing_dir",
      message: `Child plan directory is missing: ${snapshot.plan_dir}.`,
      state: snapshot.state,
    });
  }
  if (
    normalizeVerificationStatus(snapshot.state, "execution").kind === "fail" ||
    CHILD_PLAN_STRUCTURAL_FAILURE_STATES.has(snapshot.state)
  ) {
    signals.push({
      code: "child_plan_failed_state",
      message: `Child plan state is ${snapshot.state}.`,
      state: snapshot.state,
    });
  }

  const transitions = asArray(snapshot.transitions);
  const gateNames = [...new Set(transitions.map((entry) => childPlanTransitionGateKey(entry)).filter(Boolean))];
  for (const gate of gateNames) {
    const tail = consecutiveFailTail(transitions, gate);
    if (tail.count >= CHILD_PLAN_POISON_FAIL_THRESHOLD) {
      signals.push({
        code: "child_plan_history_poisoned",
        message: `Child plan has ${tail.count} consecutive failed ${gate} transitions.`,
        gate,
        consecutive_fails: tail.count,
        failure_codes: tail.failure_codes,
      });
    }
  }

  const replanCount = transitions.filter((entry) => /\bre[_-]?plan\b/i.test(asString(entry?.to || entry?.state || entry?.gate || entry?.transition))).length;
  if (replanCount >= CHILD_PLAN_REPLAN_THRESHOLD) {
    signals.push({
      code: "child_plan_replan_loop",
      message: `Child plan has ${replanCount} re-plan transitions.`,
      replan_count: replanCount,
    });
  }

  return {
    ...snapshot,
    signals,
    failed: signals.length > 0,
  };
}

function lightweightPlanBases(planDir, cwd) {
  if (!planDir || !cwd) return [];
  return childPlanBases(planDir, cwd);
}

function lightweightClosedSpineState(base) {
  const statePath = join(base, "state.json");
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    return lower(parsed?.state);
  } catch {
    return "invalid";
  }
}

// A lightweight child plan is "complete" when its plan_dir exists on disk and
// carries real proof. Preferred proof is now a closed normal state-machine
// spine; walkthrough.md remains accepted as legacy compatibility. This is a
// real on-disk gate (no inline-only bypass), but it does NOT require policy
// `required`. Returns a status string mirroring childPlanState's vocabulary so
// callers can distinguish failure modes.
function lightweightChildState(ticket, cwd) {
  const child = ticket?.child_plan || {};
  const planDir = asString(child.plan_dir);
  if (!planDir) return "no_plan_dir";
  if (!cwd) return "missing_plan_dir";
  const bases = lightweightPlanBases(planDir, cwd);
  let dirSeen = false;
  for (const base of bases) {
    if (existsSync(base)) dirSeen = true;
    const state = lightweightClosedSpineState(base);
    if (state === "close" || state === "closed") return "complete";
    if (existsSync(join(base, "walkthrough.md"))) return "complete";
  }
  return dirSeen ? "no_proof" : "missing_plan_dir";
}

function truthy(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on", "required"].includes(value.trim().toLowerCase());
}

function annotationCloseRequired(ticket) {
  return truthy(ticket?.annotation_close_required) ||
    truthy(ticket?.requires_code_annotations) ||
    truthy(ticket?.close_requirements?.annotations_required);
}

function normalizeRelPath(value) {
  return asString(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isCodeAnnotationCandidate(filePath) {
  const normalized = normalizeRelPath(filePath);
  if (!normalized) return false;
  if (!ANNOTATION_CODE_EXTENSIONS.has(extname(normalized).toLowerCase())) return false;
  if (/(^|\/)(fixtures?|examples?|samples?|__fixtures__)\/?/i.test(normalized)) return false;
  if (/\.(fixture|sample|example)\.[^.]+$/i.test(normalized)) return false;
  return true;
}

function collectTicketCloseDeclaredFiles(ticket, cwd) {
  const explicit = [
    ...asArray(ticket?.code_refs),
    ...asArray(ticket?.changed_files),
    ...asArray(ticket?.canonical_files),
    ...asArray(ticket?.files),
  ].map(normalizeRelPath).filter(Boolean);
  const childScope = extractFilesToModify(loadChildPlanSnapshot(ticket, cwd).plan_content).map(normalizeRelPath);
  return [...new Set([...explicit, ...childScope])];
}

function collectTicketCloseFiles(ticket, cwd) {
  return collectTicketCloseDeclaredFiles(ticket, cwd).filter(isCodeAnnotationCandidate);
}

function annotationCloseWaived(ticket, filePath) {
  const waivers = [
    ...asArray(ticket?.annotation_waivers),
    ...asArray(ticket?.close_requirements?.annotation_waivers),
  ];
  return waivers.some((entry) => {
    if (typeof entry === "string") return normalizeRelPath(entry) === filePath;
    return normalizeRelPath(entry?.path || entry?.file) === filePath && asString(entry?.reason);
  });
}

function annotationProvesTicket(annotations, ticket) {
  const expected = new Set([
    ...asArray(ticket?.acceptance_criteria).map(asString),
    ...asArray(ticket?.story_refs).map(asString),
  ].filter(Boolean));
  const proofAnnotations = asArray(annotations)
    .filter((annotation) => annotation && !annotation.error && annotation.key === "proves")
    .flatMap((annotation) => annotation.values?.length ? annotation.values : [annotation.value])
    .map(asString)
    .filter(Boolean);
  const matched = proofAnnotations.filter((value) => {
    const normalized = value.replace(/^crit:/i, "");
    return expected.has(value) || expected.has(normalized);
  });
  const wrong = proofAnnotations.filter((value) => {
    const normalized = value.replace(/^crit:/i, "");
    return !expected.has(value) && !expected.has(normalized);
  });
  return { proofAnnotations, matched, wrong };
}

function ticketCloseAnnotationFindings(ticket, cwd) {
  if (!annotationCloseRequired(ticket)) return [];
  const declaredFiles = collectTicketCloseDeclaredFiles(ticket, cwd);
  const files = collectTicketCloseFiles(ticket, cwd);
  if (files.length === 0) {
    if (declaredFiles.length > 0) return [];
    return [{
      code: "ticket_close_annotation_scope_missing",
      path: `$.tickets[${asString(ticket?.id)}]`,
      message: "Annotation close gate is required, but no code file scope was declared through ticket refs or child-plan Files To Modify.",
    }];
  }

  const findings = [];
  for (const filePath of files) {
    if (annotationCloseWaived(ticket, filePath)) continue;
    const abs = isAbsolute(filePath) ? filePath : join(cwd, filePath);
    if (!existsSync(abs)) {
      findings.push({
        code: "ticket_close_annotation_file_missing",
        path: `$.tickets[${asString(ticket?.id)}].code_refs`,
        message: `Annotation close gate file does not exist: ${filePath}`,
      });
      continue;
    }
    const annotations = parseAnnotations(filePath, cwd).filter((annotation) => annotation && !annotation.error);
    const proof = annotationProvesTicket(annotations, ticket);
    if (proof.matched.length > 0) continue;
    if (proof.proofAnnotations.length > 0) {
      findings.push({
        code: "ticket_close_annotation_wrong_story",
        path: `$.tickets[${asString(ticket?.id)}].code_refs`,
        message: `${filePath} declares @planner:proves values that do not match ticket stories or acceptance criteria: ${proof.wrong.join(", ")}`,
      });
    } else {
      findings.push({
        code: "ticket_close_annotation_missing",
        path: `$.tickets[${asString(ticket?.id)}].code_refs`,
        message: `${filePath} lacks @planner:proves for ticket ${asString(ticket?.id)} acceptance criteria or stories.`,
      });
    }
  }
  return findings;
}

function checkDependencyCycles(edges) {
  const graph = new Map();
  for (const [source, target] of edges) {
    if (!source || !target) continue;
    if (!graph.has(source)) graph.set(source, []);
    graph.get(source).push(target);
  }

  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      cycles.push(path.slice(start).concat(node));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of graph.get(node) || []) dfs(next, path.concat(next));
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) dfs(node, [node]);
  return cycles;
}

export function resolveProgramPacketPath({ cwd = process.cwd(), program = null } = {}) {
  const root = resolve(cwd);
  const programArg = asString(program);
  const programsDir = join(root, "plans", "programs");

  const packetPaths = [];
  if (existsSync(programsDir)) {
    for (const entry of readdirSync(programsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packetPath = join(programsDir, entry.name, "program_packet.json");
      if (existsSync(packetPath)) packetPaths.push(packetPath);
    }
    packetPaths.sort();
  }

  if (programArg) {
    const direct = isAbsolute(programArg) ? programArg : resolve(root, programArg);
    if (existsSync(direct)) {
      const st = statSync(direct);
      const canonicalDirect = realpathSync(direct);
      return {
        status: "FOUND",
        path: st.isDirectory() ? join(canonicalDirect, "program_packet.json") : canonicalDirect,
      };
    }
    const byId = join(root, "plans", "programs", programArg, "program_packet.json");
    if (existsSync(byId)) return { status: "FOUND", path: byId };

    const registered = [];
    for (const packetPath of packetPaths) {
      try {
        const packet = JSON.parse(readFileSync(packetPath, "utf-8"));
        const id = asString(packet?.id);
        if (id) registered.push({ id, path: packetPath });
      } catch {
        // Direct selection still reports malformed packets through loadProgramPacket.
        // Canonical ID discovery only treats readable packets with IDs as registered.
      }
    }
    const validIds = [...new Set(registered.map((entry) => entry.id))].sort();
    const validIdText = validIds.length > 0 ? validIds.join(", ") : "(none)";
    const matches = registered.filter((entry) => entry.id === programArg);
    if (matches.length === 1) return { status: "FOUND", path: matches[0].path };
    if (matches.length > 1) {
      const candidates = matches.map((entry) => entry.path).sort();
      const candidateText = candidates
        .map((packetPath) => relative(root, packetPath).replace(/\\/g, "/"))
        .join(", ");
      return {
        status: "AMBIGUOUS",
        path: null,
        candidates,
        message: `Program ID ${programArg} is ambiguous; matching packets: ${candidateText}. Valid Program IDs: ${validIdText}`,
      };
    }
    return {
      status: "MISSING",
      path: byId,
      candidates: packetPaths,
      message: `Program Packet not found for ${programArg}. Valid Program IDs: ${validIdText}`,
    };
  }

  if (!existsSync(programsDir)) {
    return { status: "SKIP", path: null, message: "No plans/programs directory found" };
  }

  if (packetPaths.length === 0) return { status: "SKIP", path: null, message: "No Program Packet found" };
  if (packetPaths.length > 1) {
    return {
      status: "AMBIGUOUS",
      path: null,
      message: "Multiple Program Packets found; pass --program <id-or-path>",
      candidates: packetPaths,
    };
  }
  return { status: "FOUND", path: packetPaths[0] };
}

export function loadProgramPacket(packetPath) {
  const raw = readFileSync(packetPath, "utf-8");
  return { packet: JSON.parse(raw), raw };
}

function repositoryProgramPackets(cwd) {
  const programsDir = join(resolve(cwd), "plans", "programs");
  if (!existsSync(programsDir)) return [];
  const packets = [];
  for (const entry of readdirSync(programsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packetPath = join(programsDir, entry.name, "program_packet.json");
    if (!existsSync(packetPath)) continue;
    try {
      packets.push(JSON.parse(readFileSync(packetPath, "utf-8")));
    } catch {
      // The selected packet validator reports its own parse errors. A sibling
      // that cannot be read is deliberately treated as unknown authority.
    }
  }
  return packets;
}

// @planner:proves = US-PM-AUTO-221, US-079
export function evaluateExternalPrerequisites(packet, options = {}) {
  const supplied = Array.isArray(options.programPackets)
    ? options.programPackets
    : repositoryProgramPackets(options.cwd || process.cwd());
  const packetsById = new Map();
  for (const candidate of [...supplied, packet]) {
    const programId = asString(candidate?.id);
    if (programId) packetsById.set(programId, candidate);
  }
  const prerequisites = [];
  const blockers = [];

  for (const ticket of asArray(packet?.tickets)) {
    const ticketId = asString(ticket?.id);
    const seen = new Set();
    for (const [index, prerequisite] of asArray(ticket?.external_prerequisites).entries()) {
      const path = `$.tickets[${ticketId || "unknown"}].external_prerequisites[${index}]`;
      const programRef = asString(prerequisite?.program_ref);
      const ticketRef = asString(prerequisite?.ticket_ref);
      const requiredStatus = lower(prerequisite?.required_status);
      const requiredLifecycle = lower(prerequisite?.required_lifecycle);
      const identity = `${programRef}\u0000${ticketRef || "program"}`;
      let code = null;
      let observed = null;
      let message = null;

      if (
        !programRef
        || (!ticketRef && (!requiredStatus || requiredLifecycle))
        || (ticketRef && (!requiredLifecycle || requiredStatus))
        || (requiredStatus && !PROGRAM_STATUSES.has(requiredStatus))
        || (requiredLifecycle && !CANONICAL_TICKET_LIFECYCLES.has(requiredLifecycle))
      ) {
        code = "ticket_external_prerequisite_invalid";
        message = `External prerequisite needs program_ref plus required_status, or program_ref + ticket_ref + required_lifecycle`;
      } else if (seen.has(identity)) {
        code = "ticket_external_prerequisite_duplicate";
        message = `Duplicate external prerequisite: ${programRef}${ticketRef ? `/${ticketRef}` : ""}`;
      } else {
        seen.add(identity);
        const authority = packetsById.get(programRef);
        if (!authority) {
          code = "ticket_external_prerequisite_program_unknown";
          message = `External prerequisite Program not found: ${programRef}`;
        } else if (ticketRef) {
          const subject = asArray(authority.tickets).find((entry) => asString(entry?.id) === ticketRef);
          if (!subject) {
            code = "ticket_external_prerequisite_ticket_unknown";
            message = `External prerequisite ticket not found: ${programRef}/${ticketRef}`;
          } else {
            observed = effectiveTicketLifecycle(subject.lifecycle);
            if (!ticketLifecycleSatisfiesRequirement(observed, requiredLifecycle)) {
              code = "ticket_external_prerequisite_lifecycle_mismatch";
              message = `External prerequisite ${programRef}/${ticketRef} requires lifecycle=${requiredLifecycle} or later; observed ${observed || "unknown"}`;
            }
          }
        } else {
          observed = lower(authority.status);
          if (observed !== requiredStatus) {
            code = "ticket_external_prerequisite_status_mismatch";
            message = `External prerequisite ${programRef} requires status=${requiredStatus}; observed ${observed || "unknown"}`;
          }
        }
      }

      const row = {
        ticket_id: ticketId || null,
        program_ref: programRef || null,
        ticket_ref: ticketRef || null,
        required_status: requiredStatus || null,
        required_lifecycle: requiredLifecycle || null,
        observed,
        satisfied: !code,
        code,
        path,
        message,
      };
      prerequisites.push(row);
      if (code) blockers.push(row);
    }
  }

  return { ok: blockers.length === 0, prerequisites, blockers };
}

export function validateProgramPacket(packet, options = {}) {
  const errors = [];
  const warnings = [];
  const cwd = options.cwd || process.cwd();

  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    issue(errors, "program_packet_not_object", "$", "Program Packet must be a JSON object");
    return { ok: false, errors, warnings, counts: {} };
  }

  const programId = asString(packet.id);
  const status = lower(packet.status);
  const epics = asArray(packet.epics);
  const tickets = asArray(packet.tickets);
  const acceptanceCriteria = asArray(packet.acceptance_criteria);
  const dependencies = asArray(packet.dependencies);
  const compatibilityContracts = asArray(packet.compatibility_contracts);
  const migrationBoundaries = asArray(packet.migration_boundaries);
  const deletionMoveCensus = asArray(packet.deletion_move_census);
  const verificationRows = asArray(packet.verification_matrix);
  const decisions = asArray(packet.decisions);
  const scopeCitation = evaluateScopeCitationLedger(packet);
  let remotePolicy = null;
  let remoteMode = "local-only";
  let githubIssueMirrorRequired = false;
  try {
    remotePolicy = resolveProgramPacketRemotePolicy(packet, options);
    remoteMode = remotePolicy.effective_mode;
    githubIssueMirrorRequired = remoteMode === "remote-sync";
    for (const blocker of remotePolicy.gate_satisfiability.blockers) {
      const code = blocker.code === "gate_requirement_waiver_invalid"
        ? "program_gate_requirement_waiver_invalid"
        : "program_gate_requirement_resolution_required";
      const requirement = remotePolicy.gate_satisfiability.requirements
        .find((entry) => entry.id === blocker.requirement_id);
      const path = blocker.requirement_id === PROGRAM_REMOTE_REPOSITORY_REQUIREMENT
        ? "$.remote_policy.repository_slug"
        : "$.remote_mode";
      const optionsText = asArray(requirement?.resolution_options).map((entry) => entry.action).join(" | ");
      issue(errors, code, path, `${blocker.message}${optionsText ? ` Resolution: ${optionsText}` : ""}`);
    }
  } catch (error) {
    let policyPath = "$.remote_mode";
    try {
      policyPath = packetRemoteModePolicy(packet).path;
    } catch {
      // The original error already explains conflicting packet aliases.
    }
    issue(errors, "program_remote_mode_invalid", policyPath, error?.message || String(error));
  }

  if (packet.version !== 1) issue(errors, "program_packet_version", "$.version", "Program Packet version must be 1");
  for (const [key, value] of [["id", packet.id], ["title", packet.title], ["goal", packet.goal]]) {
    if (!asString(value)) issue(errors, `program_missing_${key}`, `$.${key}`, `Program Packet requires ${key}`);
  }
  if (!PROGRAM_STATUSES.has(status)) {
    issue(errors, "program_invalid_status", "$.status", `Unsupported program status: ${packet.status}`);
  }
  for (const key of [
    "epics",
    "tickets",
    "acceptance_criteria",
    "dependencies",
    "compatibility_contracts",
    "migration_boundaries",
    "deletion_move_census",
    "verification_matrix",
    "decisions",
  ]) {
    if (!Array.isArray(packet[key])) issue(errors, `program_${key}_not_array`, `$.${key}`, `${key} must be an array`);
  }
  for (const warning of scopeCitation.warnings) {
    issue(warnings, warning.code, warning.path, warning.message);
  }

  const epicsById = mapById(epics);
  const ticketsById = mapById(tickets);
  const criteriaById = mapById(acceptanceCriteria);
  const contractsById = mapById(compatibilityContracts);
  const boundariesById = mapById(migrationBoundaries);
  const censusById = mapById(deletionMoveCensus);
  const decisionsById = mapById(decisions);
  const verificationRowsById = mapById(verificationRows);
  const ticketIds = idSet(tickets);
  const storyIds = options.storyIds instanceof Set ? options.storyIds : null;
  const programStoryErrors = status !== "design";
  const programStoryTarget = programStoryErrors ? errors : warnings;
  const externalPrerequisites = evaluateExternalPrerequisites(packet, options);

  for (const storyRef of asArray(packet.story_refs)) {
    if (storyIds && !storyIds.has(asString(storyRef))) {
      issue(programStoryTarget, "program_unknown_story", "$.story_refs", `Story not found in registry: ${storyRef}`);
    }
  }

  for (const epic of epics) {
    const epicId = asString(epic?.id);
    if (!epicId) {
      issue(errors, "epic_missing_id", "$.epics[]", "Every epic requires an id");
      continue;
    }
    if (!hasRefs(epic.story_refs)) {
      issue(errors, "epic_without_story", `$.epics[${epicId}].story_refs`, "Every epic must link to at least one story");
    }
    for (const storyRef of asArray(epic.story_refs)) {
      if (storyIds && !storyIds.has(asString(storyRef))) {
        issue(programStoryTarget, "epic_unknown_story", `$.epics[${epicId}].story_refs`, `Story not found in registry: ${storyRef}`);
      }
    }
    for (const ticketRef of asArray(epic.ticket_refs)) {
      if (!ticketIds.has(asString(ticketRef))) {
        issue(errors, "epic_ticket_ref_missing", `$.epics[${epicId}].ticket_refs`, `Unknown ticket ref: ${ticketRef}`);
      }
    }
  }

  const dependencyEdges = [];
  for (const dep of dependencies) {
    const source = dependencySource(dep);
    const target = dependencyTarget(dep);
    if (!source || !target) {
      issue(errors, "dependency_missing_endpoint", "$.dependencies[]", "Dependency requires from_ref/source_ref and to_ref/target_ref");
      continue;
    }
    if (!ticketsById.has(source)) issue(errors, "dependency_unknown_source", `$.dependencies[${asString(dep?.id) || source}].from_ref`, `Unknown source ticket: ${source}`);
    if (!ticketsById.has(target)) issue(errors, "dependency_unknown_target", `$.dependencies[${asString(dep?.id) || target}].to_ref`, `Unknown target ticket: ${target}`);
    dependencyEdges.push([source, target]);
  }

  for (const ticket of tickets) {
    const ticketId = asString(ticket?.id);
    const ticketType = lower(ticket?.type || "feature");
    const rawLifecycle = lower(ticket?.lifecycle);
    const lifecycle = effectiveTicketLifecycle(ticket?.lifecycle);
    const reviewStatus = lower(ticket?.review_status || ticket?.last_review_status);
    const personaReviewStatus = ticketPersonaReviewStatus(ticket);
    const executable = !NON_EXECUTABLE_TICKET_TYPES.has(ticketType);
    const administrativeClosure = isAdministrativeClosureTicket(ticket, {
      decisionsById,
      cwd,
      programId: packet?.id,
      programPacketPath: options.programPacketPath,
    });
    const strictAcceptanceQuality = options.strictAcceptanceQuality === true ||
      lower(packet.acceptance_quality_gate || packet.acceptanceQualityGate) === "strict" ||
      ticket?.acceptance_quality_required === true ||
      ticket?.acceptanceQualityRequired === true;
    let awaitingExternalActionValid = false;

    if (!ticketId) {
      issue(errors, "ticket_missing_id", "$.tickets[]", "Every ticket requires an id");
      continue;
    }
    if (!epicsById.has(asString(ticket.epic_id))) {
      issue(errors, "ticket_unknown_epic", `$.tickets[${ticketId}].epic_id`, `Ticket references unknown epic: ${ticket.epic_id}`);
    }
    if (!TICKET_LIFECYCLES.has(rawLifecycle)) {
      issue(errors, "ticket_invalid_lifecycle", `$.tickets[${ticketId}].lifecycle`, `Unsupported lifecycle: ${ticket.lifecycle}`);
    }
    if (ticket.awaiting_external_action !== undefined) {
      const awaiting = validateAwaitingExternalAction(ticket.awaiting_external_action, { lifecycle });
      awaitingExternalActionValid = awaiting.ok;
      for (const finding of awaiting.errors) {
        const suffix = finding.path ? `.${finding.path}` : "";
        issue(errors, finding.code, `$.tickets[${ticketId}].awaiting_external_action${suffix}`, finding.message);
      }
    }
    if (reviewStatus && !TICKET_REVIEW_STATUSES.has(reviewStatus)) {
      issue(errors, "ticket_invalid_review_status", `$.tickets[${ticketId}].review_status`, `Unsupported review_status: ${reviewStatus}`);
    }
    if (lifecycle === "closed" && !administrativeClosure && reviewStatus === "not_run") {
      issue(errors, "ticket_closure_review_not_run", `$.tickets[${ticketId}].review_status`, "Closed tickets must not carry review_status:not_run");
    }
    if (lifecycle === "closed" && !administrativeClosure && personaReviewStatus === "needs_evidence") {
      issue(errors, "ticket_closure_persona_review_needs_evidence", `$.tickets[${ticketId}].persona_review.status`, "Closed tickets must not carry persona_review.status:needs_evidence");
    }
    if (executable && !hasRefs(ticket.story_refs) && !hasRefs(ticket.defect_refs) && !hasRefs(ticket.gap_refs)) {
      issue(errors, "ticket_without_traceability", `$.tickets[${ticketId}]`, "Executable tickets must link to at least one story, defect, or gap");
    }
    const ticketStoryTarget = lifecycle === "proposed" ? warnings : errors;
    for (const storyRef of asArray(ticket.story_refs)) {
      if (storyIds && !storyIds.has(asString(storyRef))) {
        issue(ticketStoryTarget, "ticket_unknown_story", `$.tickets[${ticketId}].story_refs`, `Story not found in registry: ${storyRef}`);
      }
    }
    for (const depRef of asArray(ticket.depends_on)) {
      const depId = asString(depRef);
      if (!ticketsById.has(depId)) issue(errors, "ticket_dependency_unknown", `$.tickets[${ticketId}].depends_on`, `Unknown dependency: ${depId}`);
      dependencyEdges.push([ticketId, depId]);
    }
    for (const prerequisite of externalPrerequisites.prerequisites.filter((entry) => entry.ticket_id === ticketId && !entry.satisfied)) {
      const target = READY_OR_LATER.has(lifecycle) ? errors : warnings;
      issue(target, prerequisite.code, prerequisite.path, prerequisite.message);
    }

    const acceptanceRefs = asArray(ticket.acceptance_criteria).map(asString).filter(Boolean);
    const verificationRefs = asArray(ticket.verification_refs).map(asString).filter(Boolean);
    if (READY_OR_LATER.has(lifecycle) && !administrativeClosure) {
      if (acceptanceRefs.length === 0) issue(errors, "ready_ticket_missing_acceptance", `$.tickets[${ticketId}].acceptance_criteria`, "Ready or later tickets need acceptance criteria");
      if (verificationRefs.length === 0) issue(errors, "ready_ticket_missing_verification", `$.tickets[${ticketId}].verification_refs`, "Ready or later tickets need verification rows");
      if (githubIssueMirrorRequired && !ticketHasGithubIssueMirror(ticket)) {
        issue(errors, "ready_ticket_missing_github_issue", `$.tickets[${ticketId}].external_refs`, `Ready or later tickets need a GitHub Issue mirror in external_refs when remote mode is ${remoteMode}`);
      }
      if (!ticket.child_plan || !CHILD_PLAN_POLICIES.has(lower(ticket.child_plan.policy))) {
        issue(errors, "ready_ticket_missing_child_plan_policy", `$.tickets[${ticketId}].child_plan.policy`, "Ready or later tickets need child_plan.policy");
      }
    }
    for (const acRef of acceptanceRefs) {
      const criterion = criteriaById.get(acRef);
      if (!criterion) {
        issue(errors, "ticket_acceptance_ref_unknown", `$.tickets[${ticketId}].acceptance_criteria`, `Unknown acceptance criterion: ${acRef}`);
        continue;
      }
      if (READY_OR_LATER.has(lifecycle) && !administrativeClosure && isGenericAcceptanceText(criterion.text)) {
        const target = strictAcceptanceQuality ? errors : warnings;
        issue(target, "ready_ticket_generic_acceptance", `$.acceptance_criteria[${acRef}].text`, "Ready or later tickets need substantive, source-backed acceptance criteria; placeholder text cannot satisfy readiness once acceptance_quality_required is enabled");
      }
    }
    for (const rowRef of verificationRefs) {
      const row = verificationRowsById.get(rowRef);
      if (!row) {
        issue(errors, "ticket_verification_ref_unknown", `$.tickets[${ticketId}].verification_refs`, `Unknown verification row: ${rowRef}`);
        continue;
      }
      if (DONE_OR_LATER.has(lifecycle) && !administrativeClosure && !isPassingVerificationRow(row) && !isWaivedVerificationRow(row)) {
        issue(errors, "ticket_verification_not_passed", `$.verification_matrix[${rowRef}].result`, "Done, verified, or closed ticket verification rows must pass or be waived");
      }
    }

    const childFailure = childPlanFailureSignals(ticket, cwd);
    if (childFailure.failed && READY_OR_LATER.has(lifecycle) && !["blocked", "deferred", "closed"].includes(lifecycle) && !awaitingExternalActionValid) {
      const signalCodes = childFailure.signals.map((entry) => entry.code).join(", ");
      issue(errors, "child_plan_failure_not_propagated", `$.tickets[${ticketId}].lifecycle`, `Child plan failure must be propagated to parent ticket lifecycle=blocked before continuing: ${signalCodes}`);
    }

    if (ANNOTATION_CLOSE_LIFECYCLES.has(lifecycle) && !administrativeClosure) {
      for (const finding of ticketCloseAnnotationFindings(ticket, cwd)) {
        issue(errors, finding.code, finding.path, finding.message);
      }
      const lint = lintMistakeMitigations({ packet, ticket, verificationRows });
      for (const finding of lint.findings) {
        issue(errors, finding.code, finding.path || `$.tickets[${ticketId}].verification_refs`, finding.message);
      }
    }

    const compatRefs = asArray(ticket.compatibility_contract_refs).map(asString).filter(Boolean);
    if (ticketType === "migration" && compatRefs.length === 0) {
      issue(errors, "migration_ticket_missing_contract", `$.tickets[${ticketId}].compatibility_contract_refs`, "Migration tickets require at least one compatibility contract");
    }
    for (const ref of compatRefs) {
      if (!contractsById.has(ref)) issue(errors, "ticket_contract_ref_unknown", `$.tickets[${ticketId}].compatibility_contract_refs`, `Unknown compatibility contract: ${ref}`);
    }
    for (const ref of asArray(ticket.migration_boundary_refs).map(asString).filter(Boolean)) {
      if (!boundariesById.has(ref)) issue(errors, "ticket_migration_boundary_ref_unknown", `$.tickets[${ticketId}].migration_boundary_refs`, `Unknown migration boundary: ${ref}`);
    }

    const censusRefs = asArray(ticket.deletion_move_census_refs).map(asString).filter(Boolean);
    const hasMoveDeleteShape = ticketType === "delete_move" || hasRefs(ticket.deletes_files) || hasRefs(ticket.moves_files);
    if (hasMoveDeleteShape && censusRefs.length === 0) {
      issue(errors, "delete_move_ticket_missing_census", `$.tickets[${ticketId}].deletion_move_census_refs`, "Move/delete tickets require a dependency census");
    }
    for (const ref of censusRefs) {
      if (!censusById.has(ref)) issue(errors, "ticket_census_ref_unknown", `$.tickets[${ticketId}].deletion_move_census_refs`, `Unknown deletion/move census: ${ref}`);
    }

    const child = ticket.child_plan || {};
    const policy = lower(child.policy);
    if (policy === "required" && VERIFIED_OR_CLOSED.has(lifecycle) && !administrativeClosure) {
      const state = childPlanState(ticket, cwd);
      const waiver = asString(child.waiver_decision_ref);
      const hasWaiver = waiver && decisionsById.has(waiver);
      if (!hasWaiver) {
        // Three distinct failure modes when policy=required + lifecycle in verified/closed:
        //   (a) plan_dir is null/empty                            -> required_child_plan_dir_required (F-001 null-path bypass)
        //   (b) plan_dir set but directory missing on disk        -> required_child_plan_dir_missing (G-072 missing-path)
        //   (c) plan_dir set, dir exists, state not closed        -> required_child_plan_not_closed
        // The legitimate plan_dir=null + lifecycle=proposed/in_progress + reason text shape is
        // the D-PGM-IVE-004 demotion pattern — that shape never reaches this branch because
        // proposed/in_progress are NOT in VERIFIED_OR_CLOSED.
        if (!asString(child.plan_dir)) {
          issue(errors, "required_child_plan_dir_required", `$.tickets[${ticketId}].child_plan.plan_dir`, "Required child_plan with verified/closed lifecycle MUST declare a plan_dir; inline state cannot substitute for filesystem proof");
        } else if (state === "missing_plan_dir") {
          issue(errors, "required_child_plan_dir_missing", `$.tickets[${ticketId}].child_plan.plan_dir`, "Required child plan directory does not exist on disk; inline state cannot substitute for missing plan artifacts");
        } else if (!["close", "closed"].includes(state)) {
          issue(errors, "required_child_plan_not_closed", `$.tickets[${ticketId}].child_plan`, "Required child plans must be closed before ticket verified or closed");
        }
      }
    } else if (policy === "lightweight" && VERIFIED_OR_CLOSED.has(lifecycle) && !administrativeClosure) {
      // Proportional tier: satisfied by an on-disk walkthrough proof rather than
      // a full closed state machine — but still a real gate (no inline bypass).
      const waiver = asString(child.waiver_decision_ref);
      const hasWaiver = waiver && decisionsById.has(waiver);
      if (!hasWaiver) {
        const lwState = lightweightChildState(ticket, cwd);
        if (lwState === "no_plan_dir") {
          issue(errors, "lightweight_child_plan_dir_required", `$.tickets[${ticketId}].child_plan.plan_dir`, "Lightweight child_plan with verified/closed lifecycle MUST declare a plan_dir; inline state cannot substitute for filesystem proof");
        } else if (lwState === "missing_plan_dir") {
          issue(errors, "lightweight_child_plan_dir_missing", `$.tickets[${ticketId}].child_plan.plan_dir`, "Lightweight child plan directory does not exist on disk; inline state cannot substitute for missing plan artifacts");
        } else if (lwState !== "complete") {
          issue(errors, "lightweight_child_plan_proof_missing", `$.tickets[${ticketId}].child_plan`, "Lightweight child plans must carry a closed state.json spine or legacy walkthrough.md proof before the ticket is verified or closed");
        }
      }
    }

    const canonicalFiles = new Set([
      ...asArray(packet.canonical_files).map(asString),
      ...asArray(ticket.canonical_files).map(asString),
    ].filter(Boolean));
    for (const censusRef of censusRefs) {
      const census = censusById.get(censusRef);
      for (const filePath of asArray(census?.canonical_files).map(asString).filter(Boolean)) canonicalFiles.add(filePath);
    }
    const deletedFiles = asArray(ticket.deletes_files).map(asString).filter(Boolean);
    const deletesCanonical = deletedFiles.some((filePath) => canonicalFiles.has(filePath));
    if (deletesCanonical) {
      const replacementDecision = asString(ticket.replacement_decision_ref) || asString(ticket.retirement_decision_ref);
      const subjectDecision = decisionForSubject(decisions, ticketId, new Set(["replacement", "retirement", "canonical_replacement"]));
      if (!(replacementDecision && decisionsById.has(replacementDecision)) && !subjectDecision) {
        issue(errors, "canonical_delete_without_replacement", `$.tickets[${ticketId}].deletes_files`, "Canonical files cannot be deleted without a replacement or retirement decision");
      }
    }

    const capabilityImpacts = [
      ...asArray(ticket.capability_impacts),
      ...asArray(ticket.removes_capabilities).map((capabilityRef) => ({ capability_ref: capabilityRef, disposition: "removed" })),
    ];
    for (const censusRef of censusRefs) {
      capabilityImpacts.push(...asArray(censusById.get(censusRef)?.capability_impacts));
    }
    for (const impact of capabilityImpacts) {
      const disposition = lower(impact?.disposition || impact?.type || "removed");
      if (!["removed", "retired", "replaced"].includes(disposition)) continue;
      if (!hasRefs(impact.story_refs) && !asString(impact.retired_by_story) && !asString(impact.replaced_by_story)) {
        issue(errors, "capability_removed_without_story", `$.tickets[${ticketId}].capability_impacts`, "User-facing capabilities cannot disappear without retired/replaced story linkage");
      }
    }
  }

  for (const criterion of acceptanceCriteria) {
    const criterionId = asString(criterion?.id);
    if (!criterionId) {
      issue(errors, "acceptance_missing_id", "$.acceptance_criteria[]", "Acceptance criteria require ids");
      continue;
    }
    if (!subjectExists(asString(criterion.subject_ref), { programId, epicsById, ticketsById })) {
      issue(errors, "acceptance_unknown_subject", `$.acceptance_criteria[${criterionId}].subject_ref`, `Unknown subject: ${criterion.subject_ref}`);
    }
    if (!hasRefs(criterion.story_refs) && !asString(criterion.maintenance_rationale)) {
      issue(errors, "acceptance_without_story_or_rationale", `$.acceptance_criteria[${criterionId}]`, "Acceptance criteria need story refs or a non-user-facing maintenance rationale");
    }
    for (const storyRef of asArray(criterion.story_refs)) {
      if (storyIds && !storyIds.has(asString(storyRef))) {
        issue(programStoryTarget, "acceptance_unknown_story", `$.acceptance_criteria[${criterionId}].story_refs`, `Story not found in registry: ${storyRef}`);
      }
    }
  }

  for (const row of verificationRows) {
    const rowId = asString(row?.id);
    if (!rowId) {
      issue(errors, "verification_missing_id", "$.verification_matrix[]", "Verification rows require ids");
      continue;
    }
    if (!subjectExists(asString(row.subject_ref), { programId, epicsById, ticketsById })) {
      issue(errors, "verification_unknown_subject", `$.verification_matrix[${rowId}].subject_ref`, `Unknown subject: ${row.subject_ref}`);
    }
    const acRef = asString(row.acceptance_criterion_ref);
    if (acRef && !criteriaById.has(acRef)) {
      issue(errors, "verification_unknown_acceptance", `$.verification_matrix[${rowId}].acceptance_criterion_ref`, `Unknown acceptance criterion: ${acRef}`);
    }
    for (const key of ["proof_type", "command_or_action", "pass_means"]) {
      if (!asString(row[key])) issue(errors, `verification_missing_${key}`, `$.verification_matrix[${rowId}].${key}`, `Verification row requires ${key}`);
    }
  }

  for (const contract of compatibilityContracts) {
    const ticketRef = asString(contract?.ticket_ref || contract?.subject_ref);
    if (ticketRef && !ticketsById.has(ticketRef)) issue(errors, "contract_unknown_ticket", `$.compatibility_contracts[${asString(contract?.id)}].ticket_ref`, `Unknown ticket: ${ticketRef}`);
  }
  for (const boundary of migrationBoundaries) {
    const ticketRef = asString(boundary?.ticket_ref || boundary?.subject_ref);
    if (ticketRef && !ticketsById.has(ticketRef)) issue(errors, "boundary_unknown_ticket", `$.migration_boundaries[${asString(boundary?.id)}].ticket_ref`, `Unknown ticket: ${ticketRef}`);
  }
  for (const census of deletionMoveCensus) {
    const ticketRef = asString(census?.ticket_ref || census?.subject_ref);
    if (ticketRef && !ticketsById.has(ticketRef)) issue(errors, "census_unknown_ticket", `$.deletion_move_census[${asString(census?.id)}].ticket_ref`, `Unknown ticket: ${ticketRef}`);
  }

  for (const cycle of checkDependencyCycles(dependencyEdges)) {
    issue(errors, "ticket_dependency_cycle", "$.tickets.depends_on", `Ticket dependency cycle: ${cycle.join(" -> ")}`);
  }

  if (status === "closed") {
    for (const ticket of tickets) {
      const ticketId = asString(ticket.id);
      const lifecycle = effectiveTicketLifecycle(ticket.lifecycle);
      if (lifecycle === "closed") continue;
      if (lifecycle === "deferred") {
        const decisionRef = asString(ticket.deferral_decision_ref);
        const decision = decisionRef ? decisionsById.get(decisionRef) : decisionForSubject(decisions, ticketId, new Set(["defer", "deferral"]));
        if (decision) continue;
        issue(errors, "deferred_ticket_missing_decision", `$.tickets[${ticketId}].deferral_decision_ref`, "Deferred tickets need an explicit decision before program close");
        continue;
      }
      issue(errors, "program_close_ticket_not_closed", `$.tickets[${ticketId}].lifecycle`, "Program cannot close until tickets are closed or deferred");
    }
    const programRows = verificationRows.filter((row) => lower(row.scope) === "program" || asString(row.subject_ref) === programId);
    if (programRows.length === 0) {
      issue(errors, "program_close_missing_verification", "$.verification_matrix", "Program close requires program-level verification rows");
    }
    for (const row of programRows) {
      if (!isPassingVerificationRow(row) && !isWaivedVerificationRow(row)) {
        issue(errors, "program_close_verification_not_passed", `$.verification_matrix[${asString(row.id)}].result`, "Program-level verification rows must pass or be waived before close");
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    remote_policy: remotePolicy,
    gate_satisfiability: remotePolicy?.gate_satisfiability || null,
    counts: {
      epics: epics.length,
      tickets: tickets.length,
      acceptance_criteria: acceptanceCriteria.length,
      verification_rows: verificationRows.length,
      decisions: decisions.length,
    },
  };
}

export function evaluateProgramGate(packet, gate, options = {}) {
  const result = validateProgramPacket(packet, options);
  const errors = [...result.errors];
  const warnings = [...result.warnings];
  const tickets = asArray(packet?.tickets);
  const verificationRows = asArray(packet?.verification_matrix);
  const programId = asString(packet?.id);
  const decisionsById = mapById(packet?.decisions);
  const ticketsById = mapById(tickets);

  function gateError(code, path, message) {
    issue(errors, code, path, message);
  }

  function enforceDependencyProof(eligibleLifecycles) {
    for (const ticket of tickets) {
      const ticketId = asString(ticket.id);
      const lifecycle = effectiveTicketLifecycle(ticket.lifecycle);
      if (!ticketId || !eligibleLifecycles.has(lifecycle)) continue;
      for (const depId of asArray(ticket.depends_on).map(asString).filter(Boolean)) {
        const dep = ticketsById.get(depId);
        if (!dep) continue;
        if (!dependencyProofSatisfied(dep, packet?.decisions, ticketId, depId)) {
          gateError(
            "ticket_dependency_not_verified",
            `$.tickets[${ticketId}].depends_on`,
            `Ticket ${ticketId} dependency is not verified or waived: ${depId}`
          );
        }
      }
    }
  }

  if (gate === "design-to-ready") {
    if (!["design", "ready", "executing", "validating", "closed"].includes(lower(packet?.status))) {
      gateError("program_gate_status_mismatch", "$.status", "design-to-ready expects program status design, ready, or already past ready");
    }
  } else if (gate === "ready-to-execution") {
    if (!["ready", "executing"].includes(lower(packet?.status))) {
      gateError("program_gate_status_mismatch", "$.status", "ready-to-execution expects program status ready or executing");
    }
    enforceDependencyProof(new Set(["in_progress", "done", "verified", "closed"]));
  } else if (gate === "execution-to-program-validate") {
    if (!["executing", "validating"].includes(lower(packet?.status))) {
      gateError("program_gate_status_mismatch", "$.status", "execution-to-program-validate expects program status executing or validating");
    }
    enforceDependencyProof(new Set(["in_progress", "done", "verified", "closed"]));
    for (const ticket of tickets) {
      const type = lower(ticket.type || "feature");
      const lifecycle = effectiveTicketLifecycle(ticket.lifecycle);
      if (NON_EXECUTABLE_TICKET_TYPES.has(type) || lifecycle === "deferred") continue;
      if (!DONE_OR_LATER.has(lifecycle)) {
        gateError("program_validate_ticket_not_done", `$.tickets[${asString(ticket.id)}].lifecycle`, "Executable tickets must be done, verified, or closed before program validation");
      }
    }
    const scopeCitation = evaluateScopeCitationLedger(packet, { ...options, enforceNegativeCitations: true });
    for (const blocker of scopeCitation.blocking_issues) {
      gateError(blocker.code, blocker.path, blocker.message);
    }
  } else if (gate === "validate-to-program-close") {
    if (!["validating", "closed"].includes(lower(packet?.status))) {
      gateError("program_gate_status_mismatch", "$.status", "validate-to-program-close expects program status validating or closed");
    }
    for (const ticket of tickets) {
      const lifecycle = effectiveTicketLifecycle(ticket.lifecycle);
      if (lifecycle === "closed") continue;
      if (lifecycle === "deferred") {
        const decisionRef = asString(ticket.deferral_decision_ref);
        const hasDecision = (decisionRef && decisionsById.has(decisionRef)) ||
          decisionForSubject(packet.decisions, asString(ticket.id), new Set(["defer", "deferral"]));
        if (!hasDecision) gateError("deferred_ticket_missing_decision", `$.tickets[${asString(ticket.id)}].deferral_decision_ref`, "Deferred tickets need an explicit decision");
        continue;
      }
      gateError("program_close_ticket_not_closed", `$.tickets[${asString(ticket.id)}].lifecycle`, "Tickets must be closed or deferred before program close");
    }
    const programRows = verificationRows.filter((row) => lower(row.scope) === "program" || asString(row.subject_ref) === programId);
    if (programRows.length === 0) gateError("program_close_missing_verification", "$.verification_matrix", "Program close requires program-level verification rows");
    for (const row of programRows) {
      if (!isPassingVerificationRow(row) && !isWaivedVerificationRow(row)) {
        gateError("program_close_verification_not_passed", `$.verification_matrix[${asString(row.id)}].result`, "Program-level verification must pass or be waived");
      }
    }
  } else {
    gateError("unknown_program_gate", "gate", `Unknown program gate: ${gate}`);
  }

  return {
    ok: errors.length === 0,
    gate,
    errors,
    warnings,
    counts: result.counts,
    remote_policy: result.remote_policy,
    gate_satisfiability: result.gate_satisfiability,
  };
}

function fact(line) {
  return `${line}.`;
}

function id(value) {
  return sanitizeStrictId(value);
}

function text(value) {
  return sanitizeAtom(value || "unknown");
}

function atom(value) {
  return sanitizeEnumAtom(value || "unknown");
}

export function programPacketToFacts(packet, options = {}) {
  const cwd = options.cwd || process.cwd();
  const facts = [];
  const decisionsById = mapById(packet?.decisions);
  const programId = asString(packet?.id);
  if (!programId) return "";
  const gateContext = lower(options.gate || "none").replace(/-/g, "_") || "none";
  const remotePolicy = resolveProgramPacketRemotePolicy(packet, options);
  const remoteMode = remotePolicy.effective_mode;
  const githubIssueMirrorRequired = remoteMode === "remote-sync";
  const scopeCitation = evaluateScopeCitationLedger(packet, {
    ...options,
    enforceNegativeCitations: gateContext === "execution_to_program_validate",
  });
  const externalPrerequisites = evaluateExternalPrerequisites(packet, options);

  facts.push(fact(`program_gate_context(${atom(gateContext)})`));
  facts.push(fact(`program(${id(programId)}, ${text(packet.title)}, ${atom(packet.status)})`));
  facts.push(fact(`program_status(${id(programId)}, ${atom(packet.status)})`));
  facts.push(fact(`program_remote_mode(${id(programId)}, ${atom(remoteMode)})`));
  for (const requirement of remotePolicy.gate_satisfiability.requirements) {
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Structural gate-requirement lifecycle drives semantic facts, not verification-result truth.
    if (requirement.status === "satisfied") {
      facts.push(fact(`program_gate_requirement_satisfied(${id(programId)}, ${id(requirement.id)})`));
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Structural gate-requirement lifecycle drives semantic facts, not verification-result truth.
    } else if (requirement.status === "waived") {
      facts.push(fact(`program_gate_requirement_waived(${id(programId)}, ${id(requirement.id)})`));
    } else if (requirement.status === "resolution_required" || requirement.status === "invalid_waiver") {
      facts.push(fact(`program_gate_requirement_unsatisfied(${id(programId)}, ${id(requirement.id)})`));
    }
  }
  if (githubIssueMirrorRequired) {
    facts.push(fact(`program_github_issue_mirror_required(${id(programId)})`));
  }
  if (scopeCitation.required) {
    facts.push(fact(`scope_citation_required(${id(programId)})`));
  }
  if (scopeCitation.hypothesis_space_ledger_present) {
    facts.push(fact(`hypothesis_space_ledger_present(${id(programId)})`));
  }
  for (const finding of scopeCitation.negative_findings) {
    facts.push(fact(`negative_finding(${id(finding.id)})`));
    if (finding.cited) facts.push(fact(`finding_tested_region_cited(${id(finding.id)})`));
  }
  if (scopeCitation.no_go_verdict) {
    facts.push(fact(`program_no_go_verdict(${id(programId)})`));
    if (scopeCitation.no_go_verdict_cited) facts.push(fact(`program_verdict_tested_region_cited(${id(programId)})`));
  }
  for (const storyRef of asArray(packet.story_refs)) facts.push(fact(`program_story(${id(programId)}, ${id(storyRef)})`));
  for (const filePath of asArray(packet.canonical_files)) facts.push(fact(`canonical_file(${id(filePath)})`));

  for (const epic of asArray(packet.epics)) {
    const epicId = asString(epic.id);
    if (!epicId) continue;
    facts.push(fact(`epic(${id(epicId)}, ${id(programId)}, ${text(epic.title)})`));
    facts.push(fact(`program_epic(${id(programId)}, ${id(epicId)})`));
    for (const storyRef of asArray(epic.story_refs)) facts.push(fact(`epic_story(${id(epicId)}, ${id(storyRef)})`));
  }

  for (const ticket of asArray(packet.tickets)) {
    const ticketId = asString(ticket.id);
    if (!ticketId) continue;
    const lifecycle = effectiveTicketLifecycle(ticket.lifecycle);
    const administrativeClosure = isAdministrativeClosureTicket(ticket, {
      decisionsById,
      cwd,
      programId: packet?.id,
      programPacketPath: options.programPacketPath,
    });
    facts.push(fact(`ticket(${id(ticketId)}, ${id(ticket.epic_id)}, ${atom(ticket.type || "feature")}, ${atom(lifecycle)})`));
    facts.push(fact(`ticket_lifecycle(${id(ticketId)}, ${atom(lifecycle)})`));
    if (administrativeClosure) {
      facts.push(fact(`ticket_administrative_closure(${id(ticketId)})`));
    }
    if (asString(ticket.review_status || ticket.last_review_status)) {
      facts.push(fact(`ticket_review_status(${id(ticketId)}, ${atom(ticket.review_status || ticket.last_review_status)})`));
    }
    const personaReviewStatus = ticketPersonaReviewStatus(ticket);
    if (personaReviewStatus) {
      facts.push(fact(`ticket_persona_review_status(${id(ticketId)}, ${atom(personaReviewStatus)})`));
    }
    facts.push(fact(`epic_ticket(${id(ticket.epic_id)}, ${id(ticketId)})`));
    for (const storyRef of asArray(ticket.story_refs)) facts.push(fact(`ticket_story(${id(ticketId)}, ${id(storyRef)})`));
    for (const defectRef of asArray(ticket.defect_refs)) facts.push(fact(`ticket_defect(${id(ticketId)}, ${id(defectRef)})`));
    for (const gapRef of asArray(ticket.gap_refs)) facts.push(fact(`ticket_gap(${id(ticketId)}, ${id(gapRef)})`));
    for (const depRef of asArray(ticket.depends_on)) facts.push(fact(`ticket_depends_on(${id(ticketId)}, ${id(depRef)})`));
    for (const prerequisite of externalPrerequisites.prerequisites.filter((entry) => entry.ticket_id === ticketId)) {
      const subject = prerequisite.ticket_ref || "program";
      facts.push(fact(`ticket_external_prerequisite(${id(ticketId)}, ${id(prerequisite.program_ref || "unknown")}, ${id(subject)})`));
      if (prerequisite.satisfied) {
        facts.push(fact(`ticket_external_prerequisite_satisfied(${id(ticketId)}, ${id(prerequisite.program_ref || "unknown")}, ${id(subject)})`));
      } else {
        facts.push(fact(`ticket_external_prerequisite_unsatisfied(${id(ticketId)}, ${id(prerequisite.program_ref || "unknown")}, ${id(subject)})`));
      }
    }
    for (const acRef of asArray(ticket.acceptance_criteria)) facts.push(fact(`ticket_acceptance_criterion(${id(ticketId)}, ${id(acRef)})`));
    if (ticketHasGithubIssueMirror(ticket)) facts.push(fact(`ticket_github_issue(${id(ticketId)})`));
    for (const ref of asArray(ticket.external_refs)) {
      if (lower(ref?.kind) !== "github_issue") continue;
      const repo = asString(ref.repo);
      const issueNumber = Number(ref.issue_number);
      if (!repo || !Number.isFinite(issueNumber)) continue;
      facts.push(fact(`ticket_github_issue_ref(${id(ticketId)}, ${id(repo)}, ${Math.trunc(issueNumber)})`));
    }
    for (const contractRef of asArray(ticket.compatibility_contract_refs)) facts.push(fact(`ticket_compatibility_contract(${id(ticketId)}, ${id(contractRef)})`));
    for (const censusRef of asArray(ticket.deletion_move_census_refs)) facts.push(fact(`ticket_deletion_move_census(${id(ticketId)}, ${id(censusRef)})`));
    for (const filePath of asArray(ticket.deletes_files)) facts.push(fact(`ticket_deletes_file(${id(ticketId)}, ${id(filePath)})`));
    for (const filePath of asArray(ticket.canonical_files)) facts.push(fact(`canonical_file(${id(filePath)})`));
    if (asString(ticket.replacement_decision_ref)) facts.push(fact(`replacement_decision(${id(ticketId)}, ${id(ticket.replacement_decision_ref)})`));
    if (asString(ticket.retirement_decision_ref)) facts.push(fact(`replacement_decision(${id(ticketId)}, ${id(ticket.retirement_decision_ref)})`));
    if (asString(ticket.deferral_decision_ref)) facts.push(fact(`ticket_deferred_by_decision(${id(ticketId)}, ${id(ticket.deferral_decision_ref)})`));

    const child = ticket.child_plan || {};
    if (asString(child.policy)) facts.push(fact(`child_plan_policy(${id(ticketId)}, ${atom(child.policy)})`));
    if (asString(child.plan_dir)) facts.push(fact(`child_plan_ref(${id(ticketId)}, ${id(child.plan_dir)})`));
    const state = childPlanState(ticket, cwd);
    if (state) facts.push(fact(`child_plan_state(${id(ticketId)}, ${atom(state)})`));
    if (lower(child.policy) === "lightweight" && lightweightChildState(ticket, cwd) === "complete") {
      facts.push(fact(`child_plan_lightweight_complete(${id(ticketId)})`));
    }
    // JS/Prolog parity: the JS validator already skips required-child-plan errors
    // when a valid waiver_decision_ref exists (program_packet.mjs ~L456). Emit the
    // fact so the Prolog program_child_plan_not_closed invariant agrees, instead of
    // firing on a ticket the JS layer considers satisfied.
    if (asString(child.waiver_decision_ref) && decisionsById.has(asString(child.waiver_decision_ref))) {
      facts.push(fact(`child_plan_waived(${id(ticketId)})`));
    }

    for (const capability of asArray(ticket.removes_capabilities)) {
      facts.push(fact(`ticket_removes_capability(${id(ticketId)}, ${id(capability)})`));
      facts.push(fact(`user_capability(${id(capability)})`));
    }
    for (const impact of asArray(ticket.capability_impacts)) {
      const capability = asString(impact.capability_ref || impact.id);
      if (!capability) continue;
      facts.push(fact(`ticket_removes_capability(${id(ticketId)}, ${id(capability)})`));
      facts.push(fact(`user_capability(${id(capability)})`));
      for (const storyRef of asArray(impact.story_refs)) {
        const disposition = lower(impact.disposition || impact.type);
        if (disposition === "replaced") facts.push(fact(`capability_replaced_by_story(${id(capability)}, ${id(storyRef)})`));
        else facts.push(fact(`capability_retired_by_story(${id(capability)}, ${id(storyRef)})`));
      }
      if (asString(impact.retired_by_story)) facts.push(fact(`capability_retired_by_story(${id(capability)}, ${id(impact.retired_by_story)})`));
      if (asString(impact.replaced_by_story)) facts.push(fact(`capability_replaced_by_story(${id(capability)}, ${id(impact.replaced_by_story)})`));
    }
  }

  for (const dep of asArray(packet.dependencies)) {
    const source = dependencySource(dep);
    const target = dependencyTarget(dep);
    if (source && target) facts.push(fact(`ticket_depends_on(${id(source)}, ${id(target)})`));
  }

  for (const criterion of asArray(packet.acceptance_criteria)) {
    const criterionId = asString(criterion.id);
    if (!criterionId) continue;
    facts.push(fact(`acceptance_criterion(${id(criterionId)}, ${atom(criterion.scope || "ticket")}, ${id(criterion.subject_ref)}, ${text(criterion.text)})`));
    for (const storyRef of asArray(criterion.story_refs)) facts.push(fact(`criterion_story(${id(criterionId)}, ${id(storyRef)})`));
    if (asString(criterion.maintenance_rationale)) facts.push(fact(`criterion_maintenance_rationale(${id(criterionId)}, ${text(criterion.maintenance_rationale)})`));
  }

  for (const contract of asArray(packet.compatibility_contracts)) {
    const contractId = asString(contract.id);
    if (!contractId) continue;
    facts.push(fact(`compatibility_contract(${id(contractId)}, ${id(contract.ticket_ref || contract.subject_ref || "program")}, ${text(contract.summary || contract.title)})`));
  }
  for (const boundary of asArray(packet.migration_boundaries)) {
    const boundaryId = asString(boundary.id);
    if (!boundaryId) continue;
    facts.push(fact(`migration_boundary(${id(boundaryId)}, ${id(boundary.ticket_ref || boundary.subject_ref || "program")}, ${text(boundary.summary || boundary.title)})`));
  }
  for (const census of asArray(packet.deletion_move_census)) {
    const censusId = asString(census.id);
    if (!censusId) continue;
    const ticketRef = asString(census.ticket_ref || census.subject_ref);
    facts.push(fact(`deletion_move_census(${id(censusId)}, ${id(ticketRef || "program")}, ${text(census.summary || census.title)})`));
    for (const filePath of asArray(census.canonical_files)) facts.push(fact(`canonical_file(${id(filePath)})`));
    if (ticketRef && asString(census.replacement_decision_ref)) facts.push(fact(`replacement_decision(${id(ticketRef)}, ${id(census.replacement_decision_ref)})`));
    for (const impact of asArray(census.capability_impacts)) {
      const capability = asString(impact.capability_ref || impact.id);
      if (!capability || !ticketRef) continue;
      facts.push(fact(`ticket_removes_capability(${id(ticketRef)}, ${id(capability)})`));
      facts.push(fact(`user_capability(${id(capability)})`));
      for (const storyRef of asArray(impact.story_refs)) facts.push(fact(`capability_retired_by_story(${id(capability)}, ${id(storyRef)})`));
    }
  }

  for (const row of asArray(packet.verification_matrix)) {
    const rowId = asString(row.id);
    if (!rowId) continue;
    facts.push(fact(`verification_matrix_row(${id(rowId)}, ${atom(row.scope || "ticket")}, ${id(row.subject_ref)}, ${id(row.acceptance_criterion_ref || "none")}, ${atom(row.proof_type)}, ${text(row.command_or_action)}, ${text(row.pass_means)})`));
    if (asString(row.result || row.status)) {
      const status = normalizeVerificationResult(row);
      facts.push(fact(`verification_row_result(${id(rowId)}, ${atom(status.valid ? status.canonical : status.token)})`));
    }
    const resultSource = lower(row.result_source || (row.executor && lower(row.executor) === "auto" ? "manual" : "manual"));
    if (resultSource === "executed") {
      facts.push(fact(`verification_row_result_source(${id(rowId)}, executed)`));
    } else {
      facts.push(fact(`verification_row_result_source(${id(rowId)}, manual)`));
    }
    if (lower(row.executor || "manual") === "auto") {
      facts.push(fact(`verification_row_executor(${id(rowId)}, auto)`));
    }
    if (asString(row.subject_ref) === programId || lower(row.scope) === "program") {
      facts.push(fact(`program_verification_row(${id(programId)}, ${id(rowId)})`));
    }
  }

  for (const decision of asArray(packet.decisions)) {
    const decisionId = asString(decision.id);
    if (!decisionId) continue;
    facts.push(fact(`decision(${id(decisionId)}, ${atom(decision.type || decision.kind)}, ${id(decision.subject_ref || decision.ticket_ref || programId)})`));
    const type = lower(decision.type || decision.kind);
    const subject = asString(decision.subject_ref || decision.ticket_ref);
    if (subject && ["replacement", "retirement", "canonical_replacement"].includes(type)) {
      facts.push(fact(`replacement_decision(${id(subject)}, ${id(decisionId)})`));
    }
    if (subject && ["defer", "deferral"].includes(type)) {
      facts.push(fact(`ticket_deferred_by_decision(${id(subject)}, ${id(decisionId)})`));
    }
    const dependency = decisionDependencyRef(decision);
    if (subject && dependency && DEPENDENCY_WAIVER_TYPES.has(type)) {
      facts.push(fact(`ticket_dependency_waived(${id(subject)}, ${id(dependency)})`));
    }
  }

  return `${facts.join("\n")}\n`;
}
