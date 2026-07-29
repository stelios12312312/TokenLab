#!/usr/bin/env node
// program_manager.mjs — Validate Program Packets and program-level gates.
// @planner:config_flag = required_child_plan_open
// @planner:mutually_exclusive = program_ticket_verified

import { basename, dirname, join, sep } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { createSession } from "./lib/prolog.mjs";
import { formatReason } from "./lib/sanitize.mjs";
import {
  compileVerificationStatusFacts,
  normalizeVerificationStatus,
  verificationStatusIsPass,
} from "./lib/verification_status_vocabulary.mjs";
import {
  evaluateProgramGate,
  loadProgramPacket,
  normalizeProgramRepositorySlug,
  programPacketToFacts,
  resolveProgramPacketPath,
  ticketHasGithubIssueMirror,
  validateProgramPacket,
} from "./lib/program_packet.mjs";
import {
  defaultGhRunner,
  defaultGitRunner,
  fetchIssue,
  fetchProjectItem,
  resolveRepo,
} from "./github_ticket_review.mjs";
import { redactSecrets } from "./lib/provider_client.mjs";
import { extractNormalizedStoryIdsFromText } from "./lib/planner_canonicalizer.mjs";
import {
  evaluateRetroRecurrenceCheck,
  recurrenceCheckToBlockers,
} from "./lib/retro_recurrence_check.mjs";
import {
  evaluateQuantPersonaGate,
  quantPersonaGateToBlockers,
} from "./lib/quant_persona_gate.mjs";
import {
  buildLifecycleReconciliationReport,
  lifecycleReconciliationSummary,
  renderLifecycleReconciliationStatusLine,
} from "./lib/lifecycle_reconciler.mjs";
import {
  buildKnowledgeReceipt,
} from "./lib/knowledge_receipt.mjs";
import {
  assertRemoteReadAllowed,
  normalizeRemoteMode,
  resolveRemoteMode,
} from "./lib/remote_mode.mjs";
import { buildRepoStateStamp } from "./lib/repo_state_stamp.mjs";
import {
  buildProgramDisposition,
  renderProgramDispositionText,
} from "./lib/program_disposition.mjs";
import {
  findingsFromIveReport,
  findingsFromProjectHealthReport,
  findingsFromRitualReplayReport,
  findingsFromRuleEngineReport,
  findingsFromScoreboardReport,
} from "./lib/deterministic_findings.mjs";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillPath = join(__dirname, "..");

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    command: args.shift() || "help",
    gate: null,
    program: null,
    ticket: null,
    title: null,
    goal: null,
    fromText: null,
    fromFile: null,
    fromJsonArray: null,
    fromRepairPacket: null,
    fromResolutionRequest: null,
    fromArtifacts: [],
    findingId: null,
    deferredPrograms: [],
    output: null,
    issue: null,
    projectItem: null,
    repo: null,
    remoteMode: null,
    waiveGateRequirement: null,
    waiverDecision: null,
    waiverReason: null,
    ticketType: null,
    personaReview: false,
    personaPacks: null,
    autoStory: false,
    accept: false,
    close: false,
    remediate: false,
    force: false,
    write: false,
    json: false,
    facts: false,
  };
  if (parsed.command === "verify") parsed.gate = args.shift() || null;
  if (parsed.command === "blockers" || parsed.command === "unlocks-if-closed") {
    parsed.ticket = args.shift() || null;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--facts") parsed.facts = true;
    else if (arg === "--program") parsed.program = args[++i] || null;
    else if (arg === "--title") parsed.title = args[++i] || "";
    else if (arg === "--goal") parsed.goal = args[++i] || "";
    else if (arg === "--from-text") parsed.fromText = args[++i] || "";
    else if (arg === "--from-file") parsed.fromFile = args[++i] || null;
    else if (arg === "--from-json-array") parsed.fromJsonArray = args[++i] || "";
    else if (arg === "--from-repair-packet") parsed.fromRepairPacket = args[++i] || null;
    else if (arg === "--from-resolution-request") parsed.fromResolutionRequest = args[++i] || null;
    else if (arg === "--from-artifact" || arg === "--from-findings") parsed.fromArtifacts.push(args[++i] || "");
    else if (arg === "--finding" || arg === "--finding-id") parsed.findingId = args[++i] || null;
    else if (arg === "--deferred-program") parsed.deferredPrograms.push(args[++i] || "");
    else if (arg === "--output") parsed.output = args[++i] || null;
    else if (arg === "--issue") parsed.issue = args[++i] || null;
    else if (arg === "--project-item") parsed.projectItem = args[++i] || null;
    else if (arg === "--repo") parsed.repo = args[++i] || null;
    else if (arg === "--remote-mode") parsed.remoteMode = args[++i] || null;
    else if (arg === "--waive-gate-requirement") parsed.waiveGateRequirement = args[++i] || null;
    else if (arg === "--waiver-decision") parsed.waiverDecision = args[++i] || null;
    else if (arg === "--waiver-reason") parsed.waiverReason = args[++i] || null;
    else if (arg === "--ticket-type") parsed.ticketType = args[++i] || "";
    else if (arg === "--persona-review") parsed.personaReview = true;
    else if (arg === "--persona-packs") parsed.personaPacks = args[++i] || "";
    else if (arg === "--quant-scope") parsed.quantScope = args[++i] || "";
    else if (arg === "--auto-story") parsed.autoStory = true;
    else if (arg === "--accept") parsed.accept = true;
    else if (arg === "--close") parsed.close = true;
    else if (arg === "--remediate") parsed.remediate = true;
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--write") parsed.write = true;
    else if (arg === "--allow-duplicate") parsed.allowDuplicate = true;
    else if (arg.startsWith("--")) {
      // Unknown flags are ignored for backward-compatible dry-run callers.
    }
    else if (!parsed.program) parsed.program = arg;
  }
  return parsed;
}

function usage() {
  return `program_manager.mjs — Program Packet validation

Usage:
  node program_manager.mjs init --program <name-or-path> [--title "<program title>"] [--goal "<program goal>"] (--remote-mode local-only|remote-read|remote-sync|--repo owner/name|--waive-gate-requirement <id> --waiver-decision <id> --waiver-reason "<reason>") [--force] [--json]
  node program_manager.mjs intake --program <path-or-id> (--from-text "<idea>"|--from-file <path>|--from-json-array '[{"title":"...","text":"..."}]'|--issue <n>|--project-item <id/url>) [--title "<short title>"] [--ticket-type <type>] [--persona-review] [--persona-packs <csv>] [--quant-scope planner_core|meta|tooling] [--repo owner/name] [--remote-mode local-only|remote-read|remote-sync] [--write] [--allow-duplicate] [--json]
  node program_manager.mjs intake --program <path-or-id> --from-text "<idea>" [--auto-story] [--write] [--allow-duplicate] [--json]
  node program_manager.mjs triage-findings --program <path-or-id> --from-artifact <path> [--from-artifact <path> ...] [--finding <id>] [--accept] [--write] [--allow-duplicate] [--json]
  node program_manager.mjs disposition [--from-repair-packet <path>] [--from-resolution-request <path>] [--deferred-program <path-or-id> ...] [--output <path>] [--close] [--write] [--json]
  node program_manager.mjs check [--program <path-or-id>] [--remediate] [--write] [--json]
  node program_manager.mjs verify <gate> [--program <path-or-id>] [--remediate] [--write] [--json]
  node program_manager.mjs facts [--program <path-or-id>] [--remote-mode local-only|remote-read|remote-sync]
  node program_manager.mjs next-ready [--program <path-or-id>] [--json]
  node program_manager.mjs dispatch-order [--program <path-or-id>] [--json]
  node program_manager.mjs blockers <ticket> [--program <path-or-id>] [--json]
  node program_manager.mjs unlocks-if-closed <ticket> [--program <path-or-id>] [--json]

Program gates:
  design-to-ready
  ready-to-execution
  execution-to-program-validate
  validate-to-program-close

Forward-reasoning queries (next-ready / dispatch-order / blockers / unlocks-if-closed)
use the Prolog ontology to answer dispatch and what-if questions over the dependency
graph. They are advisory — they do not gate transitions.

init writes a valid empty Program Packet only after remote policy is explicit and
refuses to overwrite unless --force is passed. Choose local-only, provide a
repository slug (which selects remote-sync when mode is absent), or record a
decision-backed governed waiver. During init, explicit --remote-mode local-only
and --repo are mutually exclusive. Intake is dry-run by default. --title overrides first-line title
extraction for single local text/file intake. If a derived title is longer than
70 characters, intake attempts a redacted cheap LLM title summary and falls back
to a deterministic concise title. --ticket-type records a specialized ticket lane
while preserving schema-safe base type values; known lanes include
quant_exploration and code_refactor. --persona-review attaches advisory persona
review metadata, and --persona-packs overrides the default packs. --from-json-array
accepts a JSON array string of ticket objects; each object needs
text/body/description/content and may include title, id, ticket_type/type,
persona_review, and persona_packs. --write updates only the local Program Packet
and local intake artifact(s), but ready-or-later tickets require a
GitHub Issue mirror in external_refs only when the Program Packet remote policy
resolves to remote-sync.
Issue and Project item intake are remote reads and require remote-read or
remote-sync mode. Set --remote-mode explicitly or use PLANNER_REMOTE_MODE.
local-only keeps draft intake, checks, dispatch, and local packet work fully
offline; remote-sync is reserved for explicit GitHub mirror writes in
github_ticket_review.mjs publish/review --write.

disposition consumes lifecycle reconciler repair packets, clean committed proposed-
resolution requests, and explicit deferred Program Packets. It is dry-run by default.
--from-resolution-request closes only exact proposed/no-child tickets whose committed
decision section names the ticket and whose typed commit/receipt refs all pass when
recomputed from HEAD; it records review_status:unavailable and re-verifiable digests.
--write classifies deferred backlog
tickets and preserves their lifecycle. Add --close for the explicit second step
that promotes already-dispositioned deferred tickets to administrative closed;
the close lane requires a supported backlog_disposition classification plus a
valid decision_ref and records review_status:unavailable rather than review_ready.
Evidence-verified shipped-open tickets close only when commit, closed child-plan
scope, and GitHub issue mirror checks pass; failed evidence is recorded as
keep_open in the receipt. GitHub mirrors are still published separately through
github_ticket_review.mjs publish --remote-mode remote-sync --write.

Duplicate scan: intake deterministically compares the candidate title against
every ticket in the target packet AND every sibling Program Packet under
plans/programs/. High-similarity matches BLOCK the intake (exit 3) unless
--allow-duplicate is passed after confirming the candidate is genuinely new.

triage-findings consumes deterministic findings artifacts (or deterministic run
receipts that can be normalized into findings), reuses the same intake duplicate
scan, and stays advisory by default. It never mutates packet state unless the
operator passes both --accept and --write. --write without --accept fails.

--auto-story appends review-needed NOT_IMPLEMENTED draft stories to
reports/user_story_audit/story_registry.json and links them to the ticket when
--write is used. --remediate on check/verify emits advisory remediation task
packets; --write writes the packet. On verify, --write also advances Program
Packet status after deterministic validation and ontology checks pass.
GitHub Issue mirroring is required before ready-or-later ticket lifecycles.
Publishing is handled by github_ticket_review.mjs publish, which reuses existing
ticket external_refs instead of creating duplicate issues.

No Program Packet is backward-compatible: check and verify return SKIP.`;
}

function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function oneLine(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sanitizeIdSegment(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "INTAKE";
}

function truncate(value, max = 1200) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

const TITLE_SUMMARY_THRESHOLD = 70;
const TITLE_SUMMARY_MAX_CHARS = 70;
const AUTO_STORY_ID_PREFIX = "US-PM-AUTO";
const BASE_TICKET_TYPES = new Set([
  "feature",
  "defect",
  "gap",
  "migration",
  "delete_move",
  "maintenance",
  "documentation",
  "test",
  "refactor",
  "artifact",
  "administrative",
  "decision",
  "research",
]);
const TICKET_TYPE_PROFILES = {
  quant_exploration: {
    base_type: "research",
    persona_packs: ["quant", "quant_target", "assumptions_challenger", "wiring_auditor", "traceability"],
    required_evidence: [
      "Optimization Scale Contract with target/outcome boundary",
      "data lineage, known-at-time assumptions, and temporal/leakage split",
      "controls, baselines, and result-claim validation boundary",
      "reproducible verification artifact before promotion language",
    ],
    recommended_actions: [
      "Add target semantics and data lineage before child-plan execution.",
      "Record leakage/temporal split and control/baseline expectations.",
      "Keep any early run diagnostic_only until quantitative proof exists.",
    ],
  },
  code_refactor: {
    base_type: "refactor",
    persona_packs: ["wiring_auditor", "config_integrity", "traceability"],
    required_evidence: [
      "public contract and call-site impact review",
      "regression test or exercised-system smoke proof",
      "configuration/defaults and migration parity check when surfaces change",
      "traceability link from ticket to story, acceptance criteria, and verification row",
    ],
    recommended_actions: [
      "Map affected contracts before editing shared code.",
      "Run focused regression tests plus any migration/config parity checks.",
      "Keep compatibility or migration boundaries visible in the Program Packet.",
    ],
  },
  refactor: {
    base_type: "refactor",
    persona_packs: ["wiring_auditor", "config_integrity", "traceability"],
    required_evidence: [
      "call-site impact review",
      "focused regression proof",
      "traceability link from ticket to verification row",
    ],
    recommended_actions: ["Prove behavior is unchanged or document the intended contract change."],
  },
  research: {
    base_type: "research",
    persona_packs: ["assumptions_challenger", "traceability"],
    required_evidence: [
      "explicit question, assumptions, and decision boundary",
      "evidence source list and strongest counterargument",
      "clear next-step trigger for implementation",
    ],
    recommended_actions: ["Separate exploration evidence from implementation-ready scope."],
  },
  migration: {
    base_type: "migration",
    persona_packs: ["config_integrity", "wiring_auditor", "traceability"],
    required_evidence: [
      "compatibility or migration boundary",
      "rollback/forward plan",
      "migration verification proof",
    ],
    recommended_actions: ["Document defaults, compatibility, and rollback proof before execution."],
  },
};

function redactText(value, env = process.env) {
  return redactSecrets(String(value || ""), env);
}

function redactObject(value, env = process.env) {
  const text = redactSecrets(JSON.stringify(value, null, 2), env);
  try {
    return JSON.parse(text);
  } catch {
    return { redaction_error: "redacted payload was not valid JSON", raw_excerpt: truncate(text, 2000) };
  }
}

function normalizeTicketType(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "";
}

function isBaseTicketType(value) {
  return BASE_TICKET_TYPES.has(normalizeTicketType(value));
}

function ticketTypeProfile(ticketType, baseType) {
  const normalized = normalizeTicketType(ticketType);
  if (TICKET_TYPE_PROFILES[normalized]) return TICKET_TYPE_PROFILES[normalized];
  const base = normalizeTicketType(baseType);
  if (TICKET_TYPE_PROFILES[base]) return TICKET_TYPE_PROFILES[base];
  return null;
}

function baseTicketTypeFor(ticketType, requestedBaseType) {
  const requestedBase = normalizeTicketType(requestedBaseType);
  if (BASE_TICKET_TYPES.has(requestedBase)) return requestedBase;
  const normalizedTicketType = normalizeTicketType(ticketType);
  if (BASE_TICKET_TYPES.has(normalizedTicketType)) return normalizedTicketType;
  return TICKET_TYPE_PROFILES[normalizedTicketType]?.base_type || "feature";
}

function parsePersonaPacks(value) {
  if (Array.isArray(value)) return uniqueStrings(value.map(asString));
  return uniqueStrings(String(value || "").split(/[,\s]+/).map(asString));
}

function booleanOverride(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function intakeMetadataDefaults(args) {
  const ticketType = normalizeTicketType(args.ticketType || args.ticket_type);
  const baseType = ticketType ? baseTicketTypeFor(ticketType, args.baseTicketType || args.base_ticket_type) : "";
  const explicitPacks = parsePersonaPacks(args.personaPacks || args.persona_packs);
  const profile = ticketTypeProfile(ticketType, baseType);
  const inferredPacks = ticketType ? asArray(profile?.persona_packs) : [];
  const rawQuantScope = args.quantScope || args.quant_scope || null;
  return {
    ticket_type: ticketType || "",
    base_ticket_type: baseType || "",
    ticket_type_explicit: !!ticketType,
    persona_review_enabled: args.personaReview === true || args.persona_review === true,
    persona_packs: explicitPacks.length > 0 ? explicitPacks : inferredPacks,
    persona_packs_explicit: explicitPacks.length > 0,
    quant_scope: rawQuantScope ? String(rawQuantScope).trim().toLowerCase().replace(/-/g, "_") : null,
  };
}

function resolveSourceTicketMetadata(item = {}, defaults = {}) {
  const rawTicketType = hasOwn(item, "ticket_type")
    ? item.ticket_type
    : (hasOwn(item, "ticketType") ? item.ticketType : null);
  const rawType = hasOwn(item, "type") ? item.type : null;
  const rawBaseType = hasOwn(item, "base_ticket_type")
    ? item.base_ticket_type
    : (hasOwn(item, "baseTicketType") ? item.baseTicketType : (hasOwn(item, "base_type") ? item.base_type : null));
  const itemType = normalizeTicketType(rawType);
  const itemTicketType = normalizeTicketType(rawTicketType) || (itemType && !isBaseTicketType(itemType) ? itemType : "");
  const explicitBaseType = isBaseTicketType(rawBaseType) ? normalizeTicketType(rawBaseType) : (isBaseTicketType(itemType) ? itemType : "");
  const ticketType = itemTicketType || normalizeTicketType(defaults.ticket_type) || explicitBaseType || "feature";
  const baseType = baseTicketTypeFor(ticketType, explicitBaseType || defaults.base_ticket_type);
  const profile = ticketTypeProfile(ticketType, baseType);
  const itemHasPacks = hasOwn(item, "persona_packs") || hasOwn(item, "personaPacks");
  const itemPacks = itemHasPacks ? parsePersonaPacks(hasOwn(item, "persona_packs") ? item.persona_packs : item.personaPacks) : [];
  const defaultPacks = defaults.persona_packs_explicit
    ? asArray(defaults.persona_packs)
    : (normalizeTicketType(defaults.ticket_type) && !itemTicketType ? asArray(defaults.persona_packs) : asArray(profile?.persona_packs));
  const personaPacks = itemHasPacks ? itemPacks : uniqueStrings(defaultPacks);
  const itemHasReview = hasOwn(item, "persona_review") || hasOwn(item, "personaReview");
  const personaReview = itemHasReview
    ? booleanOverride(hasOwn(item, "persona_review") ? item.persona_review : item.personaReview, defaults.persona_review_enabled)
    : defaults.persona_review_enabled === true;
  const rawQuantScope = hasOwn(item, "quant_scope")
    ? item.quant_scope
    : (hasOwn(item, "quantScope") ? item.quantScope : (defaults.quant_scope || null));
  return {
    ticket_type: ticketType,
    base_ticket_type: baseType,
    ticket_type_explicit: !!(itemTicketType || defaults.ticket_type_explicit || explicitBaseType),
    persona_review_enabled: personaReview,
    persona_packs: personaPacks,
    persona_packs_explicit: itemHasPacks || defaults.persona_packs_explicit === true,
    ticket_type_profile: profile ? normalizeTicketType(ticketType) : "generic",
    quant_scope: rawQuantScope ? String(rawQuantScope).trim().toLowerCase().replace(/-/g, "_") : null,
  };
}

function attachSourceTicketMetadata(source, item, defaults) {
  return {
    ...source,
    ...resolveSourceTicketMetadata(item, defaults),
  };
}

function buildPersonaReview({ ticketId, ticketTitle, ticketType, baseTicketType, personaPacks }) {
  const profile = ticketTypeProfile(ticketType, baseTicketType);
  const requiredEvidence = asArray(profile?.required_evidence);
  const reviewPacks = uniqueStrings(personaPacks.length > 0 ? personaPacks : asArray(profile?.persona_packs));
  const evidence = requiredEvidence.length > 0
    ? requiredEvidence
    : ["story linkage, acceptance criteria, verification proof, and explicit assumptions"];
  const status = reviewPacks.length > 0 ? "needs_evidence" : "review_recommended";
  return {
    version: 1,
    status,
    ticket_id: ticketId,
    ticket_title: ticketTitle,
    ticket_type: ticketType,
    base_ticket_type: baseTicketType,
    persona_packs: reviewPacks,
    required_evidence: evidence,
    findings: evidence.map((message, index) => ({
      id: `PR-${String(index + 1).padStart(3, "0")}`,
      status: "needs_verification",
      persona_pack: reviewPacks[index % Math.max(reviewPacks.length, 1)] || "assumptions_challenger",
      message,
      evidence_refs: [],
    })),
    recommended_actions: asArray(profile?.recommended_actions).length > 0
      ? profile.recommended_actions
      : ["Run the relevant domain persona review before marking the ticket ready."],
    authority: "advisory_only_deterministic_gates_remain_authoritative",
  };
}

function relativePath(cwd, path) {
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const root = resolve(cwd);
  const rel = relative(root, abs);
  if (isRelativeInside(rel)) return rel.replace(/\\/g, "/");

  const canonicalRoot = canonicalMaybeMissing(root);
  const canonicalAbs = canonicalMaybeMissing(abs);
  const canonicalRel = relative(canonicalRoot, canonicalAbs);
  return isRelativeInside(canonicalRel) ? canonicalRel.replace(/\\/g, "/") : path;
}

function isRelativeInside(rel) {
  return rel && !rel.startsWith("..") && !isAbsolute(rel);
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

function sourceModes(args) {
  return [
    args.fromText !== null && args.fromText !== undefined ? "from_text" : null,
    args.fromFile ? "from_file" : null,
    args.fromJsonArray !== null && args.fromJsonArray !== undefined ? "from_json_array" : null,
    args.issue ? "issue" : null,
    args.projectItem ? "project_item" : null,
  ].filter(Boolean);
}

function normalizeIntakeIssue(issue, env) {
  const title = redactText(issue?.title || "", env);
  const body = redactText(issue?.body || "", env);
  return {
    kind: issue?.source === "project_item" ? "github_project_item" : "github_issue",
    title,
    ticket_title: title,
    title_source: "external_title",
    title_explicit: true,
    text: [title, body].filter(Boolean).join("\n\n"),
    external: {
      repo: issue?.repo || null,
      number: issue?.number ?? null,
      state: issue?.state || null,
      url: issue?.url || null,
      project_item: issue?.project_item || null,
    },
  };
}

function explicitTitle(args, env) {
  if (!Object.prototype.hasOwnProperty.call(args, "title") || args.title === null) return null;
  return redactText(args.title, env).trim() || "Program intake ticket";
}

function titleOrFallback({ title, fallback }) {
  return title !== null && title !== undefined
    ? (asString(title) || "Program intake ticket")
    : fallback;
}

function parseJsonArrayInput(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ""));
  } catch (error) {
    throw new Error(`Invalid --from-json-array JSON: ${error?.message || "parse failed"}`);
  }
  if (!Array.isArray(parsed)) throw new Error("--from-json-array must be a JSON array");
  if (parsed.length === 0) throw new Error("--from-json-array must contain at least one ticket object");
  return parsed;
}

function jsonArrayItemText(item) {
  return item?.text ?? item?.body ?? item?.description ?? item?.content ?? "";
}

function stringListFromValue(value, env = process.env) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === "string" ? entry : (entry?.text || entry?.description || entry?.title || ""))
      .map((entry) => redactText(entry, env).trim())
      .filter(Boolean);
  }
  const text = redactText(value || "", env).trim();
  return text ? [text] : [];
}

function normalizeStructuredStoryContext(value, env = process.env) {
  if (!Array.isArray(value)) return stringListFromValue(value, env).map((entry) => ({ relevance: entry }));
  return value
    .map((entry) => {
      if (typeof entry === "string") return { relevance: redactText(entry, env).trim() };
      if (!entry || typeof entry !== "object") return null;
      return {
        id: asString(entry.id || entry.story_ref || entry.storyRef || entry.ref) || null,
        title: redactText(entry.title || "", env).trim() || null,
        status: redactText(entry.status || "", env).trim() || null,
        relevance: redactText(entry.relevance || entry.context || entry.reason || entry.description || "", env).trim() || null,
      };
    })
    .filter((entry) => entry && (entry.id || entry.title || entry.relevance));
}

function normalizeJsonArrayStructuredFields(item, env = process.env) {
  const problem = redactText(item.problem || item.user_problem || item.story_problem || "", env).trim();
  const proposedChange = redactText(
    item.proposed_change || item.proposedChange || item.solution || item.implementation || item.change || "",
    env,
  ).trim();
  const acceptanceBullets = [
    ...stringListFromValue(item.acceptance_bullets, env),
    ...stringListFromValue(item.acceptance_criteria, env),
    ...stringListFromValue(item.acceptanceCriteria, env),
    ...stringListFromValue(item.criteria, env),
  ];
  const verificationPlan = [
    ...stringListFromValue(item.verification_plan, env),
    ...stringListFromValue(item.verification, env),
    ...stringListFromValue(item.test_plan, env),
    ...stringListFromValue(item.testPlan, env),
  ];
  const storyContext = normalizeStructuredStoryContext(
    item.story_context || item.storyContext || item.user_story_context || item.userStoryContext || [],
    env,
  );
  return {
    problem: problem || null,
    proposed_change: proposedChange || null,
    acceptance_bullets: uniqueStrings(acceptanceBullets),
    verification_plan: uniqueStrings(verificationPlan),
    story_context: storyContext,
  };
}

function normalizeJsonArraySource(item, index, env, defaults = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`--from-json-array item ${index + 1} must be an object`);
  }
  const text = redactText(jsonArrayItemText(item), env);
  if (!text.trim()) {
    throw new Error(`--from-json-array item ${index + 1} requires text, body, description, or content`);
  }
  const itemId = asString(item.id || item.ticket_id || item.key);
  const explicitItemTitle = item.title !== undefined && item.title !== null && asString(item.title);
  const title = titleOrFallback({
    title: explicitItemTitle ? redactText(item.title, env) : null,
    fallback: firstLine(text) || `JSON array ticket ${index + 1}`,
  });
  return attachSourceTicketMetadata({
    kind: "json_array",
    title,
    ticket_title: title,
    title_source: explicitItemTitle ? "json_array_title" : "first_line",
    title_explicit: !!explicitItemTitle,
    text,
    external: {
      array_index: index,
      item_id: itemId || null,
    },
    structured: normalizeJsonArrayStructuredFields(item, env),
    source_arg: itemId ? `--from-json-array:${itemId}` : `--from-json-array:${index + 1}`,
  }, item, defaults);
}

function loadSingleIntakeSource(args, { cwd, env, ghRunner, gitRunner, remoteMode }) {
  const overrideTitle = explicitTitle(args, env);
  const modes = sourceModes(args);
  if (modes.length !== 1) throw new Error("Pass exactly one intake source: --from-text, --from-file, --from-json-array, --issue, or --project-item");

  if (args.fromText !== null && args.fromText !== undefined) {
    const text = redactText(args.fromText, env);
    const fallbackTitle = firstLine(text) || "Idea intake";
    return {
      kind: "text",
      title: titleOrFallback({ title: overrideTitle, fallback: fallbackTitle }),
      ticket_title: titleOrFallback({ title: overrideTitle, fallback: fallbackTitle }),
      title_source: overrideTitle ? "explicit_arg" : "first_line",
      title_explicit: !!overrideTitle,
      text,
      external: null,
      source_arg: "--from-text",
    };
  }

  if (args.fromFile) {
    const filePath = isAbsolute(args.fromFile) ? args.fromFile : resolve(cwd, args.fromFile);
    const text = redactText(readFileSync(filePath, "utf-8"), env);
    const fallbackTitle = firstLine(text) || `Idea intake from ${relativePath(cwd, filePath)}`;
    return {
      kind: "file",
      title: titleOrFallback({ title: overrideTitle, fallback: fallbackTitle }),
      ticket_title: titleOrFallback({ title: overrideTitle, fallback: fallbackTitle }),
      title_source: overrideTitle ? "explicit_arg" : "first_line",
      title_explicit: !!overrideTitle,
      text,
      external: { path: relativePath(cwd, filePath) },
      source_arg: args.fromFile,
    };
  }

  assertRemoteReadAllowed(remoteMode, "program_manager intake GitHub source");
  const repo = resolveRepo(cwd, args.repo, gitRunner);
  if (!repo) throw new Error("Cannot determine GitHub repo; pass --repo <owner/repo>");
  const issue = args.issue
    ? fetchIssue(args.issue, { cwd, repo, ghRunner })
    : fetchProjectItem(args.projectItem, { cwd, repo, ghRunner });
  const source = {
    ...normalizeIntakeIssue(issue, env),
    source_arg: args.issue ? String(args.issue) : String(args.projectItem),
  };
  if (overrideTitle) {
    source.title = overrideTitle;
    source.ticket_title = overrideTitle;
    source.title_source = "explicit_arg";
    source.title_explicit = true;
  }
  return source;
}

function loadIntakeSources(args, { cwd, env, ghRunner, gitRunner, remoteMode }) {
  const modes = sourceModes(args);
  if (modes.length !== 1) throw new Error("Pass exactly one intake source: --from-text, --from-file, --from-json-array, --issue, or --project-item");
  const defaults = intakeMetadataDefaults(args);
  if (args.fromJsonArray !== null && args.fromJsonArray !== undefined) {
    return parseJsonArrayInput(args.fromJsonArray).map((item, index) => normalizeJsonArraySource(item, index, env, defaults));
  }
  return [attachSourceTicketMetadata(loadSingleIntakeSource(args, { cwd, env, ghRunner, gitRunner, remoteMode }), {}, defaults)];
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function titleFromSource(source) {
  const raw = firstLine(source.ticket_title || source.title || source.text || "Program intake ticket");
  return cleanTitle(raw) || "Program intake ticket";
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTicketTitle(value) {
  const cleaned = cleanTitle(value)
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.。]+$/u, "")
    .trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).filter(Boolean);
  const cappedWords = words.slice(0, 6).join(" ");
  return cappedWords.length <= TITLE_SUMMARY_MAX_CHARS
    ? cappedWords
    : cappedWords.slice(0, TITLE_SUMMARY_MAX_CHARS).replace(/\s+\S*$/u, "").trim();
}

function deterministicTitleSummary(text) {
  const stopwords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "when", "where",
    "because", "should", "would", "could", "about", "there", "their", "then",
  ]);
  const words = String(text || "")
    .replace(STORY_LINK_PATTERN_GLOBAL, " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !stopwords.has(word.toLowerCase()));
  const selected = words.slice(0, 6);
  if (selected.length === 0) return "Program Intake Ticket";
  while (selected.length < 3 && words[selected.length]) selected.push(words[selected.length]);
  return normalizeTicketTitle(selected.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")) || "Program Intake Ticket";
}

const STORY_LINK_FINAL_SEGMENT = "(?:\\d{1,4}|H[0-9A-F]{8,64})";
const STORY_LINK_PATTERN_GLOBAL = new RegExp(`\\bUS(?:[\\s_-]*\\d{1,4}|(?:[\\s_-]+[A-Z][A-Z0-9]{0,15})+[\\s_-]+${STORY_LINK_FINAL_SEGMENT})\\b`, "gi");

function normalizeTitleSummaryPayload(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  return normalizeTicketTitle(payload.title || payload.ticket_title || payload.short_title || payload.summary);
}

async function summarizeLongTitle({ source, cwd, env, fetchImpl }) {
  const originalTitle = cleanTitle(source.ticket_title || source.title || firstLine(source.text));
  if (source.title_explicit || originalTitle.length <= TITLE_SUMMARY_THRESHOLD) {
    return {
      ...source,
      title: originalTitle || source.title || "Program intake ticket",
      ticket_title: originalTitle || source.ticket_title || source.title || "Program intake ticket",
    };
  }

  const fallback = deterministicTitleSummary(source.text || originalTitle);
  return {
    ...source,
    title: fallback,
    ticket_title: fallback,
    title_source: "deterministic_summary",
    title_summary: {
      status: "deterministic",
      source: "deterministic",
      original_title: truncate(originalTitle, 500),
      title: fallback,
    },
  };
}

function extractStoryRefs(text) {
  return extractNormalizedStoryIdsFromText(text);
}

function storyRegistryPath(cwd) {
  return join(cwd, "reports", "user_story_audit", "story_registry.json");
}

function loadStoryRegistry(cwd, timestamp) {
  const path = storyRegistryPath(cwd);
  if (!existsSync(path)) {
    return {
      path,
      existed: false,
      registry: {
        version: 1,
        updated: timestamp,
        stories: [],
        consolidations: [],
      },
    };
  }
  try {
    const registry = JSON.parse(readFileSync(path, "utf-8"));
    if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
      throw new Error("story_registry.json must be a JSON object");
    }
    if (!Array.isArray(registry.stories)) {
      throw new Error("story_registry.json must expose a stories array");
    }
    return { path, existed: true, registry };
  } catch (error) {
    throw new Error(`Cannot use --auto-story with invalid story_registry.json: ${error?.message || "parse failed"}`);
  }
}

function readStoryRegistryForContext(cwd) {
  const path = storyRegistryPath(cwd);
  if (!existsSync(path)) return { path, registry: null, stories_by_id: new Map() };
  try {
    const registry = JSON.parse(readFileSync(path, "utf-8"));
    const stories = [
      ...asArray(registry?.stories),
      ...asArray(registry?.infrastructure_stories),
    ];
    return {
      path,
      registry,
      stories_by_id: new Map(stories.map((story) => [asString(story?.id), story]).filter(([id]) => id)),
    };
  } catch {
    return { path, registry: null, stories_by_id: new Map() };
  }
}

function storyTitleFromRecord(story) {
  return cleanTitle(story?.title || story?.name || story?.summary || story?.narrative?.need || "") || null;
}

function storyStatusFromRecord(story) {
  return asString(story?.status || story?.state || story?.review_status) || null;
}

function buildStoryContext({ storyRefs, source, cwd }) {
  const registry = cwd ? readStoryRegistryForContext(cwd) : { stories_by_id: new Map() };
  const structured = asArray(source?.structured?.story_context);
  const byId = new Map();
  const loose = [];
  for (const entry of structured) {
    const id = asString(entry?.id);
    if (id) byId.set(id, entry);
    else if (entry?.title || entry?.status || entry?.relevance) loose.push(entry);
  }
  let looseIndex = 0;
  return uniqueStrings(storyRefs).map((storyRef) => {
    const story = registry.stories_by_id.get(storyRef) || null;
    const provided = byId.get(storyRef) || null;
    const fallback = !provided && looseIndex < loose.length ? loose[looseIndex++] : null;
    return {
      id: storyRef,
      title: provided?.title || fallback?.title || storyTitleFromRecord(story),
      status: provided?.status || fallback?.status || storyStatusFromRecord(story),
      relevance: provided?.relevance || fallback?.relevance || "Linked by the intake source and carried into Program Packet traceability.",
    };
  });
}

function normalizeStoryTitle(value, fallback = "Program Manager intake story") {
  const title = cleanTitle(value || fallback).slice(0, 120).trim();
  return title || fallback;
}

function normalizeAutoStoryCandidates(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const raw = asArray(payload.story_candidates || payload.stories || payload.candidates);
  return raw.map((entry, index) => ({
    title: normalizeStoryTitle(entry?.title || entry?.name || entry?.summary, `Program Manager intake story ${index + 1}`),
    user: asString(entry?.user || entry?.actor || "operator"),
    need: asString(entry?.need || entry?.problem || entry?.description),
    outcome: asString(entry?.outcome || entry?.value || entry?.benefit),
    acceptance_criteria: asArray(entry?.acceptance_criteria || entry?.acceptance || entry?.criteria).map(asString).filter(Boolean).slice(0, 6),
    tags: uniqueStrings(["program_manager", "auto_story", ...asArray(entry?.tags).map(asString)]),
  })).filter((entry) => entry.title);
}

async function discoverAutoStoryCandidates({ source, cwd, env, fetchImpl }) {
  return {
    available: false,
    source: "deterministic_only",
    summary: "Auto-story provider discovery removed; deterministic story drafting remains available.",
    candidates: [],
  };
}

function existingAutoStoryForCandidate(registry, sourceHash, candidate) {
  const titleKey = normalizeStoryTitle(candidate.title).toLowerCase();
  return asArray(registry?.stories).find((story) => {
    const generated = story?.generated_from || {};
    if (asString(generated.source_hash) === sourceHash) return true;
    const storyTitle = normalizeStoryTitle(story?.title).toLowerCase();
    return storyTitle === titleKey && asArray(story?.tags).includes("auto_story");
  }) || null;
}

function autoStoryIdFromSourceHash(sourceHash) {
  const hash = asString(sourceHash).replace(/[^0-9a-f]/gi, "").slice(0, 16).toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(hash)) {
    throw new Error(`Cannot derive auto story id from source hash: ${sourceHash}`);
  }
  return `${AUTO_STORY_ID_PREFIX}-H${hash}`;
}

function buildDraftStory({ registry, source, candidate, timestamp }) {
  const sourceHash = sha256(`${source.kind}:${source.source_arg || ""}:${source.text}:${candidate.title}`).slice(0, 16);
  const existing = existingAutoStoryForCandidate(registry, sourceHash, candidate);
  if (existing?.id) {
    return { story: existing, reused: true, source_hash: sourceHash };
  }
  const story = {
    id: autoStoryIdFromSourceHash(sourceHash),
    title: normalizeStoryTitle(candidate.title),
    priority: "MEDIUM",
    status: "NOT_IMPLEMENTED",
    code_refs: [],
    test_refs: [],
    validation_refs: [],
    doc_refs: [],
    tags: uniqueStrings(["program_manager", "auto_story", "draft", ...asArray(candidate.tags)]),
    generated_from: {
      source: "program_manager_intake",
      source_hash: sourceHash,
      generated_at: timestamp,
      review_status: "draft_review_needed",
      source_title: source.title || null,
    },
    narrative: {
      user: candidate.user || "operator",
      need: candidate.need || source.text.slice(0, 280),
      outcome: candidate.outcome || "The Program Manager ticket can be implemented with explicit story traceability.",
    },
    acceptance_criteria: candidate.acceptance_criteria || [],
  };
  registry.stories.push(story);
  return { story, reused: false, source_hash: sourceHash };
}

async function prepareAutoStory({ enabled, source, cwd, env, fetchImpl, timestamp }) {
  if (!enabled) return { enabled: false, status: "not_requested", story_refs: [], stories: [] };
  const existingRefs = extractStoryRefs(source.text);
  const advisory = await discoverAutoStoryCandidates({ source, cwd, env, fetchImpl });
  let candidates = advisory.candidates;
  if (candidates.length === 0 && existingRefs.length === 0) {
    candidates = [{
      title: normalizeStoryTitle(source.title || deterministicTitleSummary(source.text)),
      user: "program operator",
      need: source.text.slice(0, 500),
      outcome: "The requested Program Manager capability is represented as an implementation-ready backlog story.",
      acceptance_criteria: [],
      tags: ["program_manager", "auto_story", "fallback"],
    }];
  }
  if (candidates.length === 0) {
    return {
      enabled: true,
      status: "skipped_existing_story_refs",
      story_refs: [],
      stories: [],
      advisory,
    };
  }

  const loaded = loadStoryRegistry(cwd, timestamp);
  const stories = [];
  let reusedCount = 0;
  for (const candidate of candidates.slice(0, 12)) {
    const built = buildDraftStory({ registry: loaded.registry, source, candidate, timestamp });
    if (built.reused) reusedCount += 1;
    stories.push(built.story);
  }
  if (!loaded.existed || !loaded.registry.updated) loaded.registry.updated = timestamp;
  return {
    enabled: true,
    status: stories.length > 0 ? "drafted" : "no_candidates",
    registry_path: relativePath(cwd, loaded.path),
    story_refs: uniqueStrings(stories.map((story) => story.id)),
    stories,
    generated_count: stories.length - reusedCount,
    reused_count: reusedCount,
    registry: loaded.registry,
    registry_absolute_path: loaded.path,
    advisory,
  };
}

function writeAutoStoryRegistry(autoStory, env) {
  if (!autoStory?.registry_absolute_path || !autoStory?.registry) return false;
  mkdirSync(dirname(autoStory.registry_absolute_path), { recursive: true });
  writeFileSync(autoStory.registry_absolute_path, `${JSON.stringify(redactObject(autoStory.registry, env), null, 2)}\n`, "utf-8");
  return true;
}

function upsertById(items, next) {
  const id = asString(next?.id);
  return [...asArray(items).filter((item) => asString(item?.id) !== id), next];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(asString).filter(Boolean))];
}

function ensurePacketArrays(packet) {
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
    if (!Array.isArray(packet[key])) packet[key] = [];
  }
  if (!Array.isArray(packet.story_refs)) packet.story_refs = [];
}

function selectEpic(packet, storyRefs, ticketId) {
  const existing = asArray(packet.epics).find((epic) => asString(epic?.id));
  if (existing) {
    existing.ticket_refs = uniqueStrings([...(existing.ticket_refs || []), ticketId]);
    if (storyRefs.length > 0) existing.story_refs = uniqueStrings([...(existing.story_refs || []), ...storyRefs]);
    return existing.id;
  }

  const epicId = "EP-INTAKE";
  packet.epics.push({
    id: epicId,
    title: "Idea intake",
    story_refs: storyRefs.length > 0 ? storyRefs : ["US-INTAKE-TBD"],
    ticket_refs: [ticketId],
  });
  return epicId;
}

function externalRefFromSource(source, timestamp) {
  if (source.kind === "github_issue") {
    return {
      kind: "github_issue",
      repo: source.external?.repo || null,
      issue_number: source.external?.number ?? null,
      title: source.title || null,
      state: source.external?.state || null,
      url: source.external?.url || null,
      synced_at: timestamp,
    };
  }
  if (source.kind === "github_project_item") {
    return {
      kind: "github_project_item",
      repo: source.external?.repo || null,
      issue_number: source.external?.number ?? null,
      project_item_id: source.external?.project_item?.id || null,
      project_id: source.external?.project_item?.project?.id || null,
      project_url: source.external?.project_item?.project?.url || null,
      title: source.title || null,
      state: source.external?.state || null,
      url: source.external?.url || null,
      synced_at: timestamp,
    };
  }
  if (source.kind === "file") {
    return {
      kind: "local_file",
      path: source.external?.path || source.source_arg || null,
      synced_at: timestamp,
    };
  }
  if (source.kind === "finding") {
    return {
      kind: "local_file",
      path: source.external?.artifact_path || source.external?.path || null,
      source_hash: sha256(source.text).slice(0, 16),
      title: source.title || null,
      synced_at: timestamp,
    };
  }
  return {
    kind: "local_text",
    source_hash: sha256(source.text).slice(0, 16),
    synced_at: timestamp,
  };
}

function sameExternalRef(left, right) {
  if (left?.kind !== right?.kind) return false;
  if (right.kind === "github_issue") return left.repo === right.repo && Number(left.issue_number) === Number(right.issue_number);
  if (right.kind === "github_project_item") return asString(left.project_item_id) === asString(right.project_item_id);
  if (right.kind === "local_file") return asString(left.path) === asString(right.path);
  if (right.kind === "local_text") return asString(left.source_hash) === asString(right.source_hash);
  return false;
}

function upsertExternalRef(items, next) {
  return [...asArray(items).filter((item) => !sameExternalRef(item, next)), next];
}

function intakeArtifactPath(packetPath, ticketId) {
  return join(dirname(packetPath), "intake", `${sanitizeIdSegment(ticketId).toLowerCase()}_intake_packet.json`);
}

// Right-altitude recurrence handling: a predictive recurrence guard (e.g. M-001
// "planner-core gate rollout missed ripple-through") should be CARRIED into a
// proposed ticket's verification plan at intake, not hard-block scoping for evidence
// that can only be produced at implementation. We auto-add a verification row naming
// the missing guards so the obligation is recorded (and the child-plan must still
// satisfy it downstream), which clears the intake block exactly as a hand-written
// guard row would. The recurrence semantics are unchanged — this just stops the
// scoper being blocked to do by hand what the system can carry for them.
function carryRecurrenceGuardsIntoDraft(draft, recurrenceCheck) {
  const blocking = asArray(recurrenceCheck?.matches).filter((entry) => entry?.blocking);
  if (blocking.length === 0) return false;
  const guards = uniqueStrings(blocking.flatMap((entry) => asArray(entry.missing_proof)));
  if (guards.length === 0) return false;
  const ticketId = asString(draft?.ticket?.id);
  if (!ticketId) return false;
  const acceptanceId = asString(draft?.acceptance_criteria?.[0]?.id) || null;
  const rowId = `vm-${ticketId}-recurrence-guard`.toLowerCase();
  const guardList = guards.join(", ");
  const carriedFrom = uniqueStrings(blocking.map((entry) => asString(entry.id)).filter(Boolean));
  const row = {
    id: rowId,
    scope: "ticket",
    subject_ref: ticketId,
    acceptance_criterion_ref: acceptanceId,
    proof_type: "proof:migration_parity",
    command_or_action: `Carry recurrence guard (auto-added from matched prior lessons ${carriedFrom.join(", ")}): the child plan must produce ${guardList}.`,
    pass_means: `${guardList} are produced and pass before the child plan closes.`,
    auto_carried_from: carriedFrom,
  };
  draft.packet.verification_matrix = upsertById(draft.packet.verification_matrix, row);
  draft.ticket.verification_refs = uniqueStrings([...asArray(draft.ticket.verification_refs), rowId]);
  draft.verification_rows = [...asArray(draft.verification_rows), row];
  return true;
}

const SECTION_STOP_LABELS = [
  "problem",
  "proposed change",
  "proposal",
  "solution",
  "acceptance criteria",
  "acceptance",
  "verification",
  "test plan",
  "story context",
  "user story",
];

function sourceBodyWithoutTitle(source) {
  const lines = String(source?.text || "").split(/\r?\n/);
  const title = cleanTitle(source?.ticket_title || source?.title || "");
  if (title && cleanTitle(lines[0] || "").toLowerCase() === title.toLowerCase()) {
    return lines.slice(1).join("\n").trim();
  }
  return String(source?.text || "").trim();
}

function extractLabeledSection(text, labels) {
  const body = String(text || "");
  if (!body.trim()) return "";
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const stopLabels = SECTION_STOP_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:${escapedLabels})\\s*:?\\s*(?:\\n|)([\\s\\S]*?)(?=\\n\\s*(?:#{1,6}\\s*)?(?:${stopLabels})\\s*:?\\s*(?:\\n|$)|$)`, "i");
  const match = body.match(pattern);
  return match ? match[1].trim() : "";
}

function sourceProblem(source) {
  return oneLine(
    source?.structured?.problem ||
    extractLabeledSection(sourceBodyWithoutTitle(source), ["problem", "user problem"]) ||
    sourceBodyWithoutTitle(source),
    500,
  );
}

function sourceProposedChange(source, ticketTitle) {
  return oneLine(
    source?.structured?.proposed_change ||
    extractLabeledSection(sourceBodyWithoutTitle(source), ["proposed change", "proposal", "solution", "implementation"]) ||
    `Implement ${ticketTitle} using the Program Packet traceability, acceptance, and verification evidence from intake.`,
    500,
  );
}

function buildAcceptanceText({ source, ticketTitle, problem, proposedChange }) {
  const explicit = asArray(source?.structured?.acceptance_bullets)
    .map(asString)
    .find(Boolean);
  if (explicit) return oneLine(explicit, 600);
  const section = extractLabeledSection(sourceBodyWithoutTitle(source), ["acceptance criteria", "acceptance"]);
  if (section) return oneLine(section.replace(/^[-*]\s*/gm, ""), 600);
  const basis = proposedChange || problem || sourceBodyWithoutTitle(source) || ticketTitle;
  return oneLine(`Complete "${ticketTitle}" so ${basis}`, 600);
}

function buildVerificationAction({ source, artifactRelPath }) {
  const explicit = asArray(source?.structured?.verification_plan)
    .map(asString)
    .find(Boolean);
  if (explicit) return oneLine(explicit, 600);
  const section = extractLabeledSection(sourceBodyWithoutTitle(source), ["verification", "test plan"]);
  if (section) return oneLine(section.replace(/^[-*]\s*/gm, ""), 600);
  return `Review ${artifactRelPath}`;
}

function sourceEvidenceRefs(source) {
  return uniqueStrings(asArray(source?.structured?.evidence_refs).map(asString).filter(Boolean));
}

function buildIntakeDraft({ packet, source, timestamp, artifactRelPath, additionalStoryRefs = [], cwd = null }) {
  const structuredStoryRefs = asArray(source?.structured?.story_context).map((entry) => asString(entry?.id)).filter(Boolean);
  const storyRefs = uniqueStrings([...extractStoryRefs(source.text), ...structuredStoryRefs, ...additionalStoryRefs]);
  const evidenceRefs = sourceEvidenceRefs(source);
  const suffix = sha256(`${source.kind}:${source.source_arg || ""}:${source.external?.url || ""}:${source.text}`).slice(0, 8).toUpperCase();
  const ticketId = `T-INTAKE-${suffix}`;
  const acceptanceId = `AC-${ticketId}`;
  const verificationId = `VM-${ticketId}`;
  const gapId = `GAP-INTAKE-${suffix}`;
  const next = clone(packet);
  ensurePacketArrays(next);
  const epicId = selectEpic(next, storyRefs, ticketId);
  if (storyRefs.length > 0) next.story_refs = uniqueStrings([...(next.story_refs || []), ...storyRefs]);

  const externalRef = externalRefFromSource(source, timestamp);
  const reviewArtifact = {
    path: artifactRelPath,
    kind: "program_intake_packet",
    generated_at: timestamp,
  };
  const existingTicket = asArray(next.tickets).find((ticket) => asString(ticket?.id) === ticketId) || {};
  const ticketTitle = titleFromSource(source);
  const problem = sourceProblem(source);
  const proposedChange = sourceProposedChange(source, ticketTitle);
  const storyContext = buildStoryContext({ storyRefs, source, cwd });
  const incomingTypeWins = source.ticket_type_explicit === true || !existingTicket.id;
  const incomingTicketType = incomingTypeWins ? source.ticket_type : (existingTicket.ticket_type || existingTicket.type || source.ticket_type);
  const incomingBaseType = incomingTypeWins ? source.base_ticket_type : (existingTicket.type || source.base_ticket_type);
  const baseTicketType = baseTicketTypeFor(incomingTicketType || incomingBaseType, incomingBaseType || existingTicket.type);
  const ticketType = normalizeTicketType(incomingTicketType || existingTicket.ticket_type) || baseTicketType;
  const personaPacks = uniqueStrings([
    ...asArray(existingTicket.persona_packs),
    ...asArray(source.persona_packs),
  ]);
  const personaReview = source.persona_review_enabled === true
    ? buildPersonaReview({
        ticketId,
        ticketTitle,
        ticketType,
        baseTicketType,
        personaPacks,
      })
    : existingTicket.persona_review || null;
  const ticket = {
    ...existingTicket,
    id: ticketId,
    epic_id: asString(existingTicket.epic_id) || epicId,
    title: ticketTitle,
    type: baseTicketType,
    ticket_type: ticketType,
    lifecycle: "proposed",
    review_status: existingTicket.review_status || "not_run",
    story_refs: storyRefs,
    defect_refs: asArray(existingTicket.defect_refs),
    gap_refs: storyRefs.length > 0 ? asArray(existingTicket.gap_refs) : uniqueStrings([...(existingTicket.gap_refs || []), gapId]),
    depends_on: asArray(existingTicket.depends_on),
    acceptance_criteria: uniqueStrings([...(existingTicket.acceptance_criteria || []), acceptanceId]),
    child_plan: existingTicket.child_plan || {
      policy: "required",
      plan_dir: null,
      reason: "Executable intake ticket requires a child iterative plan before implementation.",
    },
    compatibility_contract_refs: asArray(existingTicket.compatibility_contract_refs),
    migration_boundary_refs: asArray(existingTicket.migration_boundary_refs),
    deletion_move_census_refs: asArray(existingTicket.deletion_move_census_refs),
    verification_refs: uniqueStrings([...(existingTicket.verification_refs || []), verificationId]),
    evidence_refs: uniqueStrings([...(existingTicket.evidence_refs || []), ...evidenceRefs]),
    external_refs: upsertExternalRef(existingTicket.external_refs, externalRef),
    review_artifacts: upsertByPath(existingTicket.review_artifacts, reviewArtifact),
    persona_packs: personaPacks,
    acceptance_quality_required: existingTicket.acceptance_quality_required !== undefined
      ? existingTicket.acceptance_quality_required
      : true,
  };
  if (problem) ticket.problem = existingTicket.problem || problem;
  if (proposedChange) ticket.proposed_change = existingTicket.proposed_change || proposedChange;
  if (storyContext.length > 0) ticket.story_context = storyContext;
  if (personaReview) ticket.persona_review = personaReview;
  const quantScope = source.quant_scope || existingTicket.quant_scope || null;
  if (quantScope) ticket.quant_scope = quantScope;
  next.tickets = upsertById(next.tickets, ticket);
  const existingAcceptance = asArray(next.acceptance_criteria)
    .find((entry) => asString(entry?.id) === acceptanceId) || null;
  const acceptanceRow = {
    id: acceptanceId,
    scope: "ticket",
    subject_ref: ticketId,
    text: buildAcceptanceText({ source, ticketTitle, problem, proposedChange }),
    story_refs: storyRefs,
    maintenance_rationale: storyRefs.length > 0 ? null : "Draft intake gap requires story linkage before ready.",
    ...(existingAcceptance || {}),
  };
  acceptanceRow.story_refs = uniqueStrings([
    ...storyRefs,
    ...asArray(existingAcceptance?.story_refs),
  ]);
  next.acceptance_criteria = upsertById(next.acceptance_criteria, acceptanceRow);

  const existingVerification = asArray(next.verification_matrix)
    .find((entry) => asString(entry?.id) === verificationId) || null;
  const verificationRow = {
    id: verificationId,
    scope: "ticket",
    subject_ref: ticketId,
    acceptance_criterion_ref: acceptanceId,
    proof_type: existingVerification?.proof_type || source?.structured?.verification_proof_type || "proof:artifact_review",
    command_or_action: existingVerification?.command_or_action || buildVerificationAction({ source, artifactRelPath }),
    pass_means: existingVerification?.pass_means || source?.structured?.verification_pass_means || "Intake packet records source text, traceability, acceptance criteria, verification rows, and deterministic blockers.",
    ...(existingVerification || {}),
  };
  verificationRow.evidence_refs = uniqueStrings([
    ...asArray(existingVerification?.evidence_refs),
    ...evidenceRefs,
  ]);
  next.verification_matrix = upsertById(next.verification_matrix, verificationRow);

  return {
    packet: next,
    ticket,
    story_refs: storyRefs,
    story_context: storyContext,
    gap_refs: ticket.gap_refs,
    persona_review: personaReview,
    acceptance_criteria: next.acceptance_criteria.filter((entry) => entry.id === acceptanceId),
    verification_rows: next.verification_matrix.filter((entry) => entry.id === verificationId),
  };
}

function upsertByPath(items, next) {
  return [...asArray(items).filter((item) => asString(item?.path) !== asString(next?.path)), next];
}

function runIntakeOntology(packet, cwd, options = {}) {
  const storyIds = collectStoryIds(cwd);
  if (storyIds && Array.isArray(options.extraStoryIds)) {
    for (const storyId of options.extraStoryIds) storyIds.add(asString(storyId));
  }
  const validation = validateProgramPacket(packet, {
    cwd,
    storyIds,
    programPacketPath: options.programPacketPath,
  });
  const ontology = runProgramOntology(packet, cwd, null, {
    programPacketPath: options.programPacketPath,
  });
  return {
    program_packet_validation: validation,
    ontology,
    blockers: [...(validation.errors || []), ...(ontology.violations || [])],
  };
}

function normalizeIntakeAdvisoryPayload(parsed) {
  const allowed = new Set(["fresh", "needs_story", "needs_annotation", "needs_verification", "ontology_conflict", "blocked", "review_ready", "unavailable"]);
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const status = String(payload.status || payload.classification || "unavailable").trim().toLowerCase();
  return {
    status: allowed.has(status) ? status : "unavailable",
    summary: typeof payload.summary === "string" ? payload.summary : "",
    findings: asArray(payload.findings).map((finding, index) => ({
      id: asString(finding?.id) || `DS-${String(index + 1).padStart(3, "0")}`,
      status: allowed.has(String(finding?.status || finding?.classification || "").trim().toLowerCase())
        ? String(finding?.status || finding?.classification).trim().toLowerCase()
        : "fresh",
      message: asString(finding?.message || finding?.reason || finding?.summary),
      evidence_refs: asArray(finding?.evidence_refs).map(asString).filter(Boolean),
    })),
    recommended_actions: asArray(payload.recommended_actions || payload.recommended_follow_up).map(asString).filter(Boolean),
  };
}

const DUPLICATE_TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "with", "into",
  "from", "via", "by", "at", "is", "are", "be", "as", "not", "no", "its", "it",
]);
const DUPLICATE_SIMILARITY_THRESHOLD = 0.7;

function duplicateTitleTokens(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !DUPLICATE_TITLE_STOPWORDS.has(word)),
  );
}

function duplicateTitleSimilarity(a, b) {
  const tokensA = duplicateTitleTokens(a);
  const tokensB = duplicateTitleTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  // Overlap coefficient (intersection / smaller set) so a candidate that is a
  // strict subset/superset of an existing ticket title still flags.
  return intersection / Math.min(tokensA.size, tokensB.size);
}

/**
 * Deterministic cross-program duplicate scan (consolidation 2026-06-10, PM-2).
 * Compares the candidate title against tickets in the target packet and every
 * sibling Program Packet under plans/programs/. This is a BLOCKING check, not
 * a silent advisory: bypass requires the explicit --allow-duplicate flag.
 */
function scanForDuplicateTickets({ candidateTitle, candidateId, packet, packetPath, cwd }) {
  const matches = [];
  const seenPackets = new Set();
  const considerTicket = (ticket, programId, packetRel) => {
    const ticketId = asString(ticket?.id);
    if (!ticketId || ticketId === candidateId) return;
    const similarity = duplicateTitleSimilarity(candidateTitle, ticket?.title);
    if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
      matches.push({
        id: ticketId,
        title: asString(ticket?.title),
        lifecycle: asString(ticket?.lifecycle) || null,
        program_id: programId || null,
        packet_path: packetRel,
        similarity: Number(similarity.toFixed(3)),
      });
    }
  };
  const targetRel = relativePath(cwd, packetPath);
  seenPackets.add(resolve(packetPath));
  for (const ticket of asArray(packet?.tickets)) considerTicket(ticket, packet?.id, targetRel);

  const programsRoot = join(cwd, "plans", "programs");
  if (existsSync(programsRoot)) {
    for (const entry of readdirSync(programsRoot)) {
      const siblingPath = join(programsRoot, entry, "program_packet.json");
      if (!existsSync(siblingPath) || seenPackets.has(resolve(siblingPath))) continue;
      seenPackets.add(resolve(siblingPath));
      try {
        const sibling = JSON.parse(readFileSync(siblingPath, "utf-8"));
        const siblingRel = relativePath(cwd, siblingPath);
        for (const ticket of asArray(sibling?.tickets)) considerTicket(ticket, sibling?.id, siblingRel);
      } catch {
        // Unreadable sibling packets are reported by `check`, not by intake.
      }
    }
  }
  matches.sort((a, b) => b.similarity - a.similarity);
  return {
    status: matches.length > 0 ? "matches_found" : "clear",
    threshold: DUPLICATE_SIMILARITY_THRESHOLD,
    scanned_packets: seenPackets.size,
    matches: matches.slice(0, 10),
  };
}

function buildTicketIntakeReceipt({ source, programPacketPath, intakeArtifactPath, ticket, acceptanceCriteria, verificationRows, deterministic, duplicateScan = null }) {
  const blockerCount = asArray(deterministic?.blockers).length;
  const recurrence = deterministic?.retro_recurrence_check || null;
  const quantGate = deterministic?.quant_persona_gate || null;
  const personaReview = ticket?.persona_review || null;
  const personaPacks = uniqueStrings([
    ...asArray(ticket?.persona_packs),
    ...asArray(personaReview?.persona_packs),
  ]);
  const deterministicStatus = blockerCount > 0 ? "blocked" : "proposed";
  const deterministicBlockers = asArray(deterministic?.blockers).slice(0, 8);
  const hasGithubIssue = ticketHasGithubIssueMirror(ticket);
  const publishCommand = `node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs publish --program ${programPacketPath} --ticket ${ticket?.id || "<ticket-id>"} --repo owner/name --json`;
  const knowledgeReceipt = buildKnowledgeReceipt({
    source: {
      surface: "program_manager_intake",
      kind: source?.kind || null,
      title: source?.title || ticket?.title || null,
      ticket_id: ticket?.id || null,
      path: intakeArtifactPath || null,
      text: source?.text || null,
    },
    ticket,
    personaReview,
    personaPacks,
    sourceText: source?.text || "",
    retroRecurrenceCheck: recurrence,
    quantPersonaGate: quantGate,
    deterministicStatus,
    deterministicBlockers,
    evidenceRefs: [
      ...asArray(ticket?.story_refs),
      ...asArray(ticket?.verification_refs),
      ...asArray(verificationRows).map((entry) => entry?.id),
    ],
    remainingUnverifiedRisk: [
      hasGithubIssue ? null : {
        id: "github_issue_required_before_ready",
        status: "pending",
        reason: "GitHub mirror publication is still required before ticket-ready handoff.",
      },
      deterministicStatus === "proposed" ? {
        id: "implementation_proof_pending",
        status: "pending",
        reason: "Program intake scoped the ticket but did not execute the child plan.",
      } : null,
    ].filter(Boolean),
    artifactRefs: [
      { kind: "program_packet", path: programPacketPath },
      { kind: "program_intake_packet", path: intakeArtifactPath },
    ],
  });
  return {
    name: "Ticket Intake Receipt",
    version: 1,
    action: "intake",
    front_door: "/program-manager",
    source: {
      kind: source?.kind || null,
      title: source?.title || null,
      external_kind: source?.external?.project_item ? "github_project_item" : (source?.external?.url ? "github_issue" : null),
    },
    program_packet_path: programPacketPath,
    intake_artifact_path: intakeArtifactPath,
    ticket_id: ticket?.id || null,
    ticket_title: ticket?.title || null,
    ticket_type: ticket?.ticket_type || ticket?.type || null,
    base_ticket_type: ticket?.type || null,
    ticket_lifecycle: ticket?.lifecycle || null,
    persona_review_status: personaReview?.status || "not_run",
    persona_packs: personaPacks,
    story_refs: uniqueStrings(ticket?.story_refs),
    story_context_refs: uniqueStrings(asArray(ticket?.story_context).map((entry) => entry?.id)),
    gap_refs: uniqueStrings(ticket?.gap_refs),
    defect_refs: uniqueStrings(ticket?.defect_refs),
    acceptance_criteria_refs: uniqueStrings([
      ...asArray(ticket?.acceptance_criteria),
      ...asArray(acceptanceCriteria).map((entry) => entry?.id),
    ]),
    verification_refs: uniqueStrings([
      ...asArray(ticket?.verification_refs),
      ...asArray(verificationRows).map((entry) => entry?.id),
    ]),
    deterministic_status: deterministicStatus,
    deterministic_blocker_count: blockerCount,
    deterministic_blockers: deterministicBlockers,
    knowledge_receipt: knowledgeReceipt,
    retro_recurrence_status: recurrence?.status || "not_run",
    retro_recurrence_blocking_count: recurrence?.summary?.blocking_count || 0,
    retro_recurrence_advisory_count: recurrence?.summary?.advisory_count || 0,
    quant_persona_gate_status: quantGate?.status || "not_run",
    quant_persona_gate_required: quantGate?.required === true,
    quant_persona_gate_reason: quantGate?.reason || null,
    quant_persona_gate_declared_scope: quantGate?.declared_scope || null,
    quant_persona_gate_missing_count: quantGate?.summary?.missing_guard_count || 0,
    duplicate_scan_status: duplicateScan?.status || "not_run",
    duplicate_scan_matches: asArray(duplicateScan?.matches).map((match) => match.id),
    direct_github_creation_allowed: false,
    github_publication: hasGithubIssue ? "github_issue_linked" : "required_before_ready",
    github_issue_required_before_ready: !hasGithubIssue,
    next_required_command: hasGithubIssue
      ? `node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program ${programPacketPath} --json`
      : publishCommand,
    publish_command: publishCommand,
  };
}

async function runSingleIntakeSource({ source, packet, packetPath, timestamp, cwd, env, fetchImpl, write, autoStoryEnabled = false, allowDuplicate = false }) {
  const preparedSource = await summarizeLongTitle({ source, cwd, env, fetchImpl });
  const autoStory = await prepareAutoStory({
    enabled: autoStoryEnabled,
    source: preparedSource,
    cwd,
    env,
    fetchImpl,
    timestamp,
  });
  const artifactPath = intakeArtifactPath(packetPath, `T-INTAKE-${sha256(`${source.kind}:${source.source_arg || ""}:${source.external?.url || ""}:${source.text}`).slice(0, 8).toUpperCase()}`);
  const artifactRelPath = relativePath(cwd, artifactPath);
  const draft = buildIntakeDraft({
    packet,
    source: preparedSource,
    timestamp,
    artifactRelPath,
    additionalStoryRefs: autoStory.story_refs,
    cwd,
  });
  const duplicateScan = scanForDuplicateTickets({
    candidateTitle: draft.ticket?.title || preparedSource.title,
    candidateId: draft.ticket?.id,
    packet,
    packetPath,
    cwd,
  });
  if (duplicateScan.matches.length > 0 && !allowDuplicate) {
    return {
      status: "BLOCKED",
      blocked_reason: "duplicate_candidates",
      dry_run: !write,
      write: false,
      packet_updated: false,
      program_packet_path: relativePath(cwd, packetPath),
      intake_artifact_path: null,
      candidate_ticket: draft.ticket,
      duplicate_scan: duplicateScan,
      message: `Intake blocked: candidate resembles ${duplicateScan.matches.length} existing ticket(s): ${duplicateScan.matches.map((m) => `${m.id} (${m.similarity})`).join(", ")}. Consolidate with the existing ticket, or re-run with --allow-duplicate if it is genuinely new.`,
      packet,
    };
  }
  if (duplicateScan.matches.length > 0 && allowDuplicate) {
    duplicateScan.status = "overridden";
  }
  let deterministic = runIntakeOntology(draft.packet, cwd, {
    extraStoryIds: autoStory.story_refs,
    programPacketPath: packetPath,
  });
  const recurrenceArgs = () => ({
    cwd,
    sourceText: preparedSource.text,
    packet: draft.packet,
    ticket: draft.ticket,
    acceptanceCriteria: draft.acceptance_criteria,
    verificationRows: draft.verification_rows,
    env,
  });
  let recurrenceCheck = evaluateRetroRecurrenceCheck(recurrenceArgs());
  // Carry predictive recurrence guards into the proposed ticket's verification plan
  // rather than hard-blocking scoping; re-evaluate once carried. The guard is now an
  // obligation on the ticket the child-plan must satisfy at implementation.
  if ((recurrenceCheck?.summary?.blocking_count || 0) > 0 && carryRecurrenceGuardsIntoDraft(draft, recurrenceCheck)) {
    deterministic = runIntakeOntology(draft.packet, cwd, {
      extraStoryIds: autoStory.story_refs,
      programPacketPath: packetPath,
    });
    recurrenceCheck = evaluateRetroRecurrenceCheck(recurrenceArgs());
  }
  const quantPersonaGate = evaluateQuantPersonaGate({
    sourceText: preparedSource.text,
    packet: draft.packet,
    ticket: draft.ticket,
    acceptanceCriteria: draft.acceptance_criteria,
    verificationRows: draft.verification_rows,
    ticketScope: preparedSource.quant_scope || draft.ticket?.quant_scope || null,
  });
  deterministic.retro_recurrence_check = recurrenceCheck;
  deterministic.quant_persona_gate = quantPersonaGate;
  deterministic.blockers = [
    ...asArray(deterministic.blockers),
    ...recurrenceCheckToBlockers(recurrenceCheck),
    ...quantPersonaGateToBlockers(quantPersonaGate),
  ];
  const intakePacket = {
    version: 1,
    generated_at: timestamp,
    source: {
      kind: preparedSource.kind,
      title: preparedSource.title,
      ticket_title: preparedSource.ticket_title || preparedSource.title || null,
      title_source: preparedSource.title_source || null,
      title_summary: preparedSource.title_summary || null,
      ticket_type: preparedSource.ticket_type || draft.ticket.ticket_type || null,
      base_ticket_type: preparedSource.base_ticket_type || draft.ticket.type || null,
      persona_review_enabled: preparedSource.persona_review_enabled === true,
      persona_packs: uniqueStrings(preparedSource.persona_packs || draft.ticket.persona_packs),
      text: preparedSource.text,
      structured: preparedSource.structured || null,
      external: preparedSource.external,
    },
    program: {
      id: packet.id || null,
      title: packet.title || null,
      status: packet.status || null,
      packet_path: relativePath(cwd, packetPath),
    },
    candidate_ticket: draft.ticket,
    linked_story_refs: draft.story_refs,
    story_context: draft.story_context,
    linked_gap_refs: draft.gap_refs,
    persona_review: draft.persona_review || null,
    auto_story: {
      enabled: autoStory.enabled === true,
      status: autoStory.status,
      registry_path: autoStory.registry_path || null,
      story_refs: autoStory.story_refs || [],
      generated_count: autoStory.generated_count || 0,
      reused_count: autoStory.reused_count || 0,
      stories: asArray(autoStory.stories).map((story) => ({
        id: story.id,
        title: story.title,
        status: story.status,
        review_status: story.generated_from?.review_status || null,
      })),
      advisory: autoStory.advisory ? {
        available: autoStory.advisory.available === true,
        source: autoStory.advisory.source || null,
        summary: autoStory.advisory.summary || null,
        candidate_count: asArray(autoStory.advisory.candidates).length,
      } : null,
    },
    persona_obligations: quantPersonaGate.required
      ? quantPersonaGate.required_guards.map((guard) => ({
          id: guard.id,
          title: guard.title,
          status: guard.status,
          missing_proof: guard.missing_proof,
          next_action: guard.next_action,
        }))
      : [],
    acceptance_criteria: draft.acceptance_criteria,
    verification_rows: draft.verification_rows,
    annotation_findings: {
      status: "not_run",
      summary: "Run annotation validation during ticket review or child-plan execution.",
    },
    ontology_findings: deterministic.ontology,
    retro_recurrence_check: recurrenceCheck,
    quant_persona_gate: quantPersonaGate,
    deterministic,
    duplicate_scan: duplicateScan,
    final_status: deterministic.blockers.length > 0 ? "blocked" : "proposed",
  };
  intakePacket.ticket_intake_receipt = buildTicketIntakeReceipt({
    source: preparedSource,
    programPacketPath: relativePath(cwd, packetPath),
    intakeArtifactPath: artifactRelPath,
    ticket: draft.ticket,
    acceptanceCriteria: draft.acceptance_criteria,
    verificationRows: draft.verification_rows,
    deterministic,
    duplicateScan,
  });

  if (write) {
    writeAutoStoryRegistry(autoStory, env);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(redactObject(intakePacket, env), null, 2)}\n`, "utf-8");
  }

  return {
    status: "PASS",
    dry_run: !write,
    write: !!write,
    program_packet_path: relativePath(cwd, packetPath),
    intake_artifact_path: artifactRelPath,
    packet_updated: !!write,
    auto_story: intakePacket.auto_story,
    candidate_ticket: draft.ticket,
    persona_review: draft.persona_review || null,
    story_refs: draft.story_refs,
    gap_refs: draft.gap_refs,
    acceptance_criteria: draft.acceptance_criteria,
    verification_rows: draft.verification_rows,
    deterministic,
    duplicate_scan: duplicateScan,
    ticket_intake_receipt: intakePacket.ticket_intake_receipt,
    intake_packet: intakePacket,
    packet: draft.packet,
  };
}

function aggregateIntakeResults({ results, target, cwd, write }) {
  const deterministicBlockers = results.flatMap((result) => asArray(result.deterministic?.blockers));
  const finalPacket = results[results.length - 1]?.packet || target.packet;
  return {
    status: "PASS",
    mode: "bulk",
    dry_run: !write,
    write: !!write,
    program_packet_path: relativePath(cwd, target.resolved.path),
    packet_updated: !!write,
    ticket_count: results.length,
    intake_artifact_paths: results.map((result) => result.intake_artifact_path),
    candidate_tickets: results.map((result) => result.candidate_ticket),
    ticket_types: results.map((result) => result.candidate_ticket?.ticket_type || result.candidate_ticket?.type || null),
    persona_reviews: results.map((result) => result.persona_review || null),
    persona_review_statuses: results.map((result) => result.ticket_intake_receipt?.persona_review_status || "not_run"),
    auto_stories: results.map((result) => result.auto_story),
    story_refs: uniqueStrings(results.flatMap((result) => result.story_refs)),
    gap_refs: uniqueStrings(results.flatMap((result) => result.gap_refs)),
    acceptance_criteria: results.flatMap((result) => result.acceptance_criteria),
    verification_rows: results.flatMap((result) => result.verification_rows),
    deterministic: {
      status: deterministicBlockers.length > 0 ? "blocked" : "proposed",
      blocker_count: deterministicBlockers.length,
      blockers: deterministicBlockers,
    },
    ticket_intake_receipts: results.map((result) => result.ticket_intake_receipt),
    intake_packets: results.map((result) => result.intake_packet),
    results: results.map(({ packet, ...result }) => result),
    packet: finalPacket,
  };
}

function hasPathSeparator(value) {
  const text = String(value || "");
  return text.includes("/") || text.includes("\\") || text.includes(sep);
}

function resolveInitPacketPath(cwd, programArg) {
  const raw = asString(programArg);
  if (!raw) throw new Error("Missing --program");
  const direct = isAbsolute(raw) ? raw : resolve(cwd, raw);
  if (raw.endsWith(".json")) return direct;
  if (hasPathSeparator(raw)) return join(direct, "program_packet.json");
  return join(cwd, "plans", "programs", raw, "program_packet.json");
}

function humanizeProgramName(value) {
  return String(value || "Program")
    .replace(/\.json$/i, "")
    .split(/[\/\\]/).filter(Boolean).pop()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Program";
}

function programIdFromName(value) {
  const segment = sanitizeIdSegment(String(value || "").split(/[\/\\]/).filter(Boolean).pop() || value);
  return segment.startsWith("PGM-") ? segment : `PGM-${segment}`;
}

function buildBaseProgramPacket({ programArg, title, goal }) {
  const displayTitle = asString(title) || humanizeProgramName(programArg);
  return {
    version: 1,
    id: programIdFromName(programArg),
    title: displayTitle,
    status: "design",
    goal: asString(goal) || `Coordinate ${displayTitle} as a Program Packet.`,
    story_refs: [],
    canonical_files: [],
    epics: [],
    tickets: [],
    acceptance_criteria: [],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [],
    decisions: [],
  };
}

export function runInit(inputArgs, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const args = Array.isArray(inputArgs) ? parseArgs(inputArgs) : { ...inputArgs };
  if (args.command !== "init") throw new Error(`Unknown command: ${args.command || "(missing)"}`);
  if (!args.program) throw new Error("Missing --program");

  const packetPath = resolveInitPacketPath(cwd, args.program);
  const existedBefore = existsSync(packetPath);
  if (existedBefore && !args.force) {
    throw new Error(`Program Packet already exists: ${relativePath(cwd, packetPath)} (pass --force to overwrite)`);
  }
  const packet = buildBaseProgramPacket({
    programArg: args.program,
    title: explicitTitle(args, env),
    goal: redactText(args.goal || "", env),
  });

  const waiverValues = [args.waiveGateRequirement, args.waiverDecision, args.waiverReason].map(asString);
  const waiverCount = waiverValues.filter(Boolean).length;
  if (waiverCount > 0 && waiverCount !== waiverValues.length) {
    throw new Error("--waive-gate-requirement, --waiver-decision, and --waiver-reason must be provided together");
  }
  if (asString(args.remoteMode) && normalizeRemoteMode(args.remoteMode) === "local-only" && asString(args.repo)) {
    throw new Error("--remote-mode local-only and --repo are mutually exclusive during Program init");
  }

  const configuredMode = asString(args.remoteMode || env.PLANNER_REMOTE_MODE);
  const configuredRepository = asString(args.repo || env.PLANNER_REPOSITORY || env.GITHUB_REPOSITORY);
  if (configuredMode) packet.remote_mode = normalizeRemoteMode(configuredMode);
  if (configuredRepository) {
    packet.remote_policy = { repository_slug: normalizeProgramRepositorySlug(configuredRepository) || configuredRepository };
    if (!configuredMode) packet.remote_mode = "remote-sync";
  }
  if (waiverCount === waiverValues.length && waiverCount > 0) {
    const [requirementId, decisionId, reason] = waiverValues;
    packet.decisions.push({
      id: decisionId,
      type: "gate_requirement_waiver",
      subject_ref: requirementId,
      rationale: reason,
    });
    packet.gate_requirement_waivers = [{
      requirement_id: requirementId,
      decision_ref: decisionId,
      reason,
    }];
  }

  const validation = validateProgramPacket(packet, {
    cwd,
    storyIds: collectStoryIds(cwd),
    remoteMode: args.remoteMode,
    repo: args.repo,
    env,
    programPacketPath: packetPath,
  });
  if (!validation.ok) {
    const error = new Error(`Generated Program Packet failed validation: ${validation.errors.map((entry) => entry.message).join("; ")}`);
    error.validation = validation;
    error.packetPath = relativePath(cwd, packetPath);
    throw error;
  }
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, `${JSON.stringify(redactObject(packet, env), null, 2)}\n`, "utf-8");
  return redactObject({
    command: "init",
    status: "PASS",
    packet_path: relativePath(cwd, packetPath),
    program: {
      id: packet.id,
      title: packet.title,
      status: packet.status,
    },
    created: true,
    overwritten: existedBefore && args.force,
    validation,
    remote_policy: validation.remote_policy,
    gate_satisfiability: validation.gate_satisfiability,
    next_required_command: `node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program ${relativePath(cwd, packetPath)} --json`,
  }, env);
}

export async function runIntake(inputArgs, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const clock = options.clock || (() => new Date());
  const ghRunner = options.ghRunner || defaultGhRunner;
  const gitRunner = options.gitRunner || defaultGitRunner;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const args = Array.isArray(inputArgs) ? parseArgs(inputArgs) : { ...inputArgs };

  if (args.command !== "intake") throw new Error(`Unknown command: ${args.command || "(missing)"}`);
  if (!args.program) throw new Error("Missing --program");

  const target = loadTarget(cwd, args.program);
  if (target.resolved.status !== "FOUND" || target.loadError) {
    throw new Error(target.loadError?.message || target.resolved.message || `Program Packet not found: ${args.program}`);
  }

  const timestamp = nowIso(clock);
  const remoteMode = resolveRemoteMode({
    explicit: args.remoteMode,
    env,
    defaultMode: (args.issue || args.projectItem) ? "remote-read" : "local-only",
  });
  const sources = loadIntakeSources(args, { cwd, env, ghRunner, gitRunner, remoteMode });
  let workingPacket = target.packet;
  const results = [];
  for (const source of sources) {
    const result = await runSingleIntakeSource({
      source,
      packet: workingPacket,
      packetPath: target.resolved.path,
      timestamp,
      cwd,
      env,
      fetchImpl,
      write: args.write,
      autoStoryEnabled: args.autoStory,
      allowDuplicate: args.allowDuplicate === true,
    });
    workingPacket = result.packet;
    results.push(result);
  }

  if (args.write) {
    writeFileSync(target.resolved.path, `${JSON.stringify(redactObject(workingPacket, env), null, 2)}\n`, "utf-8");
  }

  const isJsonArrayIntake = args.fromJsonArray !== null && args.fromJsonArray !== undefined;
  const result = sources.length === 1 && !isJsonArrayIntake
    ? results[0]
    : aggregateIntakeResults({ results, target, cwd, write: args.write });
  const { packet, ...publicResult } = result;
  return redactObject({ remote_mode: remoteMode, ...publicResult }, env);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstValue(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return null;
}

function readJsonArtifact(cwd, artifactPath) {
  const resolved = isAbsolute(artifactPath) ? artifactPath : resolve(cwd, artifactPath);
  const parsed = JSON.parse(readFileSync(resolved, "utf-8"));
  return {
    path: resolved,
    rel_path: relativePath(cwd, resolved),
    json: parsed,
  };
}

function normalizeArtifactReport(report, relPath) {
  const next = clone(report);
  if (!next.artifact_path) next.artifact_path = relPath;
  if (!next.manifest_path && (Array.isArray(next.suites) || Array.isArray(next.results) || Array.isArray(next.checks))) {
    next.manifest_path = relPath;
  }
  return next;
}

function looksLikeIveReport(report) {
  return isPlainObject(report) && (
    Array.isArray(report.suites) ||
    Array.isArray(report.results) ||
    Array.isArray(report.checks) ||
    Array.isArray(report.issues) && (report.overall_status || report.phase || report.run_id)
  );
}

function looksLikeScoreboardReport(report) {
  return isPlainObject(report) && (
    isPlainObject(report.scores) ||
    Array.isArray(report.regressions) ||
    report.artifacts?.scoreboard_json ||
    report.artifacts?.conformance_manifest
  );
}

function looksLikeRitualReplayReport(report) {
  return isPlainObject(report) && (report.ritual_replay_id || report.corpus) && Array.isArray(report.regressions);
}

function looksLikeRuleEngineReport(report) {
  return isPlainObject(report) && (Array.isArray(report.violations) || Array.isArray(report.warnings));
}

function looksLikeProjectHealthReport(report) {
  return isPlainObject(report) && Array.isArray(report.findings) && (report.commit || report.analyzers || report.generated_at);
}

function scoreValuesFromFinding(finding) {
  const scores = {
    ...(isPlainObject(finding?.measured_scores) ? finding.measured_scores : {}),
    ...(isPlainObject(finding?.evidence_refs?.measured_scores) ? finding.evidence_refs.measured_scores : {}),
  };
  return Object.fromEntries(
    Object.entries(scores).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
  );
}

function mergeFindingScores(finding, scores = {}) {
  const mergedScores = {
    ...scoreValuesFromFinding(finding),
    ...Object.fromEntries(
      Object.entries(scores || {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
    ),
  };
  const next = clone(finding);
  next.measured_scores = mergedScores;
  next.evidence_refs = {
    ...(isPlainObject(next.evidence_refs) ? next.evidence_refs : {}),
    measured_scores: mergedScores,
  };
  return next;
}

function repoRelativeCommand(command, cwd) {
  const text = asString(command);
  if (!text) return "";
  return text.split(resolve(cwd) + sep).join("");
}

function artifactFileExists(cwd, relPath) {
  if (!relPath) return false;
  const resolved = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
  return existsSync(resolved);
}

function plannerScriptPathFor(scriptName, cwd) {
  const candidate = `.agent/skills/iterative-planner/scripts/${scriptName}`;
  return artifactFileExists(cwd, candidate) ? candidate : scriptName;
}

function detectOffendingFilesFromLogs(finding, cwd) {
  const evidence = isPlainObject(finding?.evidence_refs) ? finding.evidence_refs : {};
  const logPaths = uniqueStrings([
    evidence.stdout_log_path,
    evidence.log_path,
    evidence.stderr_log_path,
  ]);
  const files = [];
  for (const logPath of logPaths) {
    if (!artifactFileExists(cwd, logPath)) continue;
    const resolved = isAbsolute(logPath) ? logPath : resolve(cwd, logPath);
    const failureLines = readFileSync(resolved, "utf-8")
      .split(/\r?\n/)
      .filter((line) => /\bFAIL\b/i.test(line));
    for (const line of failureLines) {
      for (const match of line.matchAll(/\b([A-Za-z0-9_.-]+\.mjs)\b/g)) {
        files.push(plannerScriptPathFor(match[1], cwd));
      }
    }
  }
  return uniqueStrings(files);
}

function enrichFindingEvidence(finding, { cwd, measuredScores = {} } = {}) {
  const next = mergeFindingScores(finding, measuredScores);
  const evidence = isPlainObject(next.evidence_refs) ? next.evidence_refs : {};
  const detectedFiles = detectOffendingFilesFromLogs(next, cwd);
  next.evidence_refs = {
    ...evidence,
    offending_files: uniqueStrings([
      ...asArray(evidence.offending_files),
      ...asArray(evidence.files),
      ...detectedFiles,
    ]),
  };
  return next;
}

function findingIdentity(finding) {
  return [
    finding?.id,
    finding?.dedupe_key,
    finding?.source_run?.run_receipt_path,
    finding?.failing_suite_id,
    finding?.failing_check_id,
    finding?.title,
  ].map((entry) => asString(entry)).filter(Boolean).join("|");
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const finding of findings) {
    const key = findingIdentity(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function scoreboardFindings(report, cwd) {
  const scoreboardScores = scoreCurrentsFromProgramManager(report.scores || {});
  const nestedManifest = firstValue(report.artifacts?.conformance_manifest);
  if (nestedManifest && artifactFileExists(cwd, nestedManifest)) {
    const nested = readJsonArtifact(cwd, nestedManifest);
    const nestedReport = normalizeArtifactReport(nested.json, nested.rel_path);
    const nestedFindings = findingsFromIveReport(nestedReport)
      .map((finding) => enrichFindingEvidence(finding, { cwd, measuredScores: scoreboardScores }));
    if (nestedFindings.length > 0) {
      return nestedFindings;
    }
  }
  return findingsFromScoreboardReport(report)
    .map((finding) => enrichFindingEvidence(finding, { cwd, measuredScores: scoreboardScores }));
}

function scoreCurrentsFromProgramManager(scores = {}) {
  const out = {};
  for (const [key, value] of Object.entries(scores || {})) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (isPlainObject(value) && Number.isFinite(Number(value.current))) out[key] = Number(value.current);
  }
  return out;
}

function findingsFromArtifact(cwd, artifactPath) {
  const artifact = readJsonArtifact(cwd, artifactPath);
  const report = normalizeArtifactReport(artifact.json, artifact.rel_path);
  const findings = [];

  if (Array.isArray(report.findings) && report.findings.some((finding) => finding?.schema_version || finding?.source_run || finding?.evidence_refs)) {
    findings.push(...report.findings.map((finding) => enrichFindingEvidence(finding, { cwd })));
  }

  if (looksLikeScoreboardReport(report)) {
    findings.push(...scoreboardFindings(report, cwd));
  } else if (looksLikeIveReport(report)) {
    findings.push(...findingsFromIveReport(report).map((finding) => enrichFindingEvidence(finding, { cwd })));
  } else if (looksLikeRitualReplayReport(report)) {
    findings.push(...findingsFromRitualReplayReport(report).map((finding) => enrichFindingEvidence(finding, { cwd })));
  } else if (looksLikeRuleEngineReport(report)) {
    findings.push(...findingsFromRuleEngineReport(report).map((finding) => enrichFindingEvidence(finding, { cwd })));
  } else if (looksLikeProjectHealthReport(report)) {
    findings.push(...findingsFromProjectHealthReport(report).map((finding) => enrichFindingEvidence(finding, { cwd })));
  }

  return dedupeFindings(findings).map((finding) => ({
    artifact_path: artifact.rel_path,
    finding,
  }));
}

function findingEvidenceRefStrings(finding) {
  const evidence = isPlainObject(finding?.evidence_refs) ? finding.evidence_refs : {};
  const scoreRefs = Object.entries(scoreValuesFromFinding(finding))
    .map(([key, value]) => `score:${key}=${value}`);
  return uniqueStrings([
    finding?.source_run?.run_receipt_path,
    evidence.run_receipt_path,
    evidence.proof_artifact_path,
    evidence.stdout_log_path,
    evidence.stderr_log_path,
    evidence.log_path,
    finding?.failing_suite_id ? `suite:${finding.failing_suite_id}` : null,
    finding?.failing_check_id ? `check:${finding.failing_check_id}` : null,
    ...asArray(evidence.offending_files),
    ...scoreRefs,
  ]);
}

function findingTicketTitle(finding) {
  const suite = asString(finding?.failing_suite_id);
  const check = asString(finding?.failing_check_id);
  if (suite) return `Fix ${suite} deterministic finding`;
  if (check) return `Fix ${check} deterministic finding`;
  return `Fix ${finding?.source_run?.surface || "deterministic"} finding`;
}

function findingTextBlock(finding, evidenceRefs, command, expectedResult) {
  const evidence = isPlainObject(finding?.evidence_refs) ? finding.evidence_refs : {};
  const files = uniqueStrings(evidence.offending_files);
  const scores = Object.entries(scoreValuesFromFinding(finding))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return [
    findingTicketTitle(finding),
    "",
    "Problem:",
    `${finding.summary || finding.title || "A deterministic run finding needs repair."}`,
    "",
    "Evidence:",
    `- Finding id: ${finding.id || "unknown"}`,
    `- Source surface: ${finding.source_run?.surface || "unknown"}`,
    `- Run receipt: ${finding.source_run?.run_receipt_path || evidence.run_receipt_path || "unknown"}`,
    finding.failing_suite_id ? `- Failing suite: ${finding.failing_suite_id}` : null,
    finding.failing_check_id ? `- Failing check: ${finding.failing_check_id}` : null,
    evidence.stdout_log_path ? `- Stdout log: ${evidence.stdout_log_path}` : null,
    files.length > 0 ? `- Offending files: ${files.join(", ")}` : null,
    scores ? `- Measured scores: ${scores}` : null,
    "",
    "Acceptance criteria:",
    `- Repair the finding so ${finding.failing_suite_id || finding.failing_check_id || "the deterministic check"} no longer reports failure while preserving evidence refs.`,
    "",
    "Verification:",
    `- ${command || "Rerun the failing deterministic check."}`,
    `- Expected: ${expectedResult}`,
    "",
    `Story refs: US-091`,
    `Evidence refs: ${evidenceRefs.join(", ")}`,
  ].filter((line) => line !== null).join("\n");
}

function findingToIntakeSource({ finding, artifactPath, cwd }) {
  const evidence = isPlainObject(finding?.evidence_refs) ? finding.evidence_refs : {};
  const command = repoRelativeCommand(firstValue(finding?.verification?.command, evidence.verification_command), cwd);
  const expectedResult = firstValue(
    finding?.verification?.expected_result,
    evidence.expected_result,
    "Finding no longer reproduces after repair",
  );
  const evidenceRefs = findingEvidenceRefStrings(finding);
  return attachSourceTicketMetadata({
    kind: "finding",
    title: findingTicketTitle(finding),
    ticket_title: findingTicketTitle(finding),
    title_source: "deterministic_finding",
    title_explicit: true,
    text: findingTextBlock(finding, evidenceRefs, command, expectedResult),
    external: {
      artifact_path: artifactPath,
      path: artifactPath,
      finding_id: finding.id || null,
    },
    structured: {
      problem: finding.summary || finding.title || null,
      proposed_change: `Repair ${finding.failing_suite_id || finding.failing_check_id || "the deterministic finding"} using the attached run evidence.`,
      acceptance_bullets: [
        `${finding.failing_suite_id || finding.failing_check_id || "The deterministic finding"} no longer reports failure.`,
        "The generated intake ticket keeps the source run receipt, logs, offending files, measured scores, and rerun command attached.",
      ],
      verification_plan: command ? [command] : [],
      verification_pass_means: expectedResult,
      verification_proof_type: "proof:integration_smoke",
      evidence_refs: evidenceRefs,
      story_context: [{
        id: "US-091",
        title: "Deterministic run findings generate evidence-attached draft tickets",
      }],
      finding,
    },
    source_arg: finding.id || finding.dedupe_key || artifactPath,
  }, { type: "defect", persona_packs: ["wiring_auditor", "config_integrity", "traceability"] }, {});
}

export async function runFindingsTriage(inputArgs, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const clock = options.clock || (() => new Date());
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const args = Array.isArray(inputArgs) ? parseArgs(inputArgs) : { ...inputArgs };

  if (args.command !== "triage-findings") throw new Error(`Unknown command: ${args.command || "(missing)"}`);
  if (!args.program) throw new Error("Missing --program");
  if (args.write && !args.accept) throw new Error("Findings are advisory: pass --accept together with --write to create intake tickets.");
  if (!Array.isArray(args.fromArtifacts) || args.fromArtifacts.filter(Boolean).length === 0) {
    throw new Error("Pass at least one findings artifact with --from-artifact <path>.");
  }

  const target = loadTarget(cwd, args.program);
  if (target.resolved.status !== "FOUND" || target.loadError) {
    throw new Error(target.loadError?.message || target.resolved.message || `Program Packet not found: ${args.program}`);
  }

  const artifactFindings = args.fromArtifacts
    .filter(Boolean)
    .flatMap((artifactPath) => findingsFromArtifact(cwd, artifactPath));
  const selectedFindings = args.findingId
    ? artifactFindings.filter((entry) => entry.finding?.id === args.findingId || entry.finding?.dedupe_key === args.findingId)
    : artifactFindings;

  const timestamp = nowIso(clock);
  const runBatch = async ({ write }) => {
    let workingPacket = target.packet;
    const results = [];
    for (const entry of selectedFindings) {
      const source = findingToIntakeSource({
        finding: entry.finding,
        artifactPath: entry.artifact_path,
        cwd,
      });
      const result = await runSingleIntakeSource({
        source,
        packet: workingPacket,
        packetPath: target.resolved.path,
        timestamp,
        cwd,
        env,
        fetchImpl,
        write,
        autoStoryEnabled: false,
        allowDuplicate: args.allowDuplicate === true,
      });
      workingPacket = result.packet;
      const { packet, intake_packet: intakePacket, ...publicResult } = result;
      results.push({
        ...publicResult,
        source_finding: entry.finding,
        intake_packet: intakePacket,
      });
    }
    return { workingPacket, results };
  };

  let { workingPacket, results } = await runBatch({ write: false });

  const blockedDuplicate = results.some((result) => result.blocked_reason === "duplicate_candidates");
  if (args.accept && args.write && selectedFindings.length > 0 && !blockedDuplicate) {
    ({ workingPacket, results } = await runBatch({ write: true }));
    writeFileSync(target.resolved.path, `${JSON.stringify(redactObject(workingPacket, env), null, 2)}\n`, "utf-8");
  }
  const wroteArtifacts = args.accept === true && args.write === true && !blockedDuplicate;

  return redactObject({
    command: "triage-findings",
    status: blockedDuplicate ? "BLOCKED" : "PASS",
    advisory_only: true,
    accepted: args.accept === true,
    dry_run: !(args.accept && args.write),
    write: args.write === true,
    packet_updated: args.accept === true && args.write === true && !blockedDuplicate,
    program_packet_path: relativePath(cwd, target.resolved.path),
    artifact_paths: args.fromArtifacts.map((artifactPath) => relativePath(cwd, artifactPath)),
    finding_count: artifactFindings.length,
    candidate_count: selectedFindings.length,
    findings: selectedFindings.map((entry) => entry.finding),
    intake_artifact_paths: wroteArtifacts
      ? results.map((result) => result.intake_artifact_path).filter(Boolean)
      : [],
    candidate_tickets: results.map((result) => result.candidate_ticket).filter(Boolean),
    verification_rows: results.flatMap((result) => asArray(result.verification_rows)),
    duplicate_scans: results.map((result) => result.duplicate_scan || null),
    results,
    next_required_command: args.accept
      ? `node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program ${relativePath(cwd, target.resolved.path)} --json`
      : `Re-run with --accept --write after operator review to create proposed intake tickets.`,
  }, env);
}

export function runDisposition(inputArgs, options = {}) {
  const args = { ...inputArgs };
  return buildProgramDisposition({
    cwd: options.cwd || process.cwd(),
    fromRepairPacket: args.fromRepairPacket,
    fromResolutionRequest: args.fromResolutionRequest,
    deferredPrograms: args.deferredPrograms,
    output: args.output,
    close: args.close === true,
    write: args.write === true,
  });
}

function runForwardReasoning(packet, cwd, query, options = {}) {
  const session = createSession();
  session.consultFile(join(skillPath, "prolog", "verification_statuses.pl"));
  session.consultFile(join(skillPath, "prolog", "programs.pl"));
  session.consult(compileVerificationStatusFacts());
  session.consult(programPacketToFacts(packet, {
    cwd,
    remoteMode: options.remoteMode,
    env: options.env,
    programPacketPath: options.programPacketPath,
  }));
  return session.queryAll(query);
}

function ticketSummary(packet, ticketId) {
  const ticket = (packet?.tickets || []).find((entry) => String(entry?.id || "").trim() === ticketId);
  if (!ticket) return { id: ticketId };
  return {
    id: ticketId,
    title: ticket.title || null,
    epic_id: ticket.epic_id || null,
    type: ticket.type || null,
    lifecycle: ticket.lifecycle || null,
    depends_on: Array.isArray(ticket.depends_on) ? ticket.depends_on : [],
    child_plan_policy: ticket.child_plan?.policy || null,
  };
}

function dependencySource(dep) {
  return asString(dep?.from_ref || dep?.source_ref || dep?.source || dep?.blocked_by);
}

function dependencyTarget(dep) {
  return asString(dep?.to_ref || dep?.target_ref || dep?.target || dep?.blocks);
}

function dispatchOrderTickets(packet) {
  const tickets = asArray(packet?.tickets);
  const ticketsById = new Map();
  const depsById = new Map();
  for (const ticket of tickets) {
    const ticketId = asString(ticket?.id);
    if (!ticketId) continue;
    ticketsById.set(ticketId, ticket);
    depsById.set(ticketId, []);
  }

  for (const ticket of tickets) {
    const ticketId = asString(ticket?.id);
    if (!ticketId || !depsById.has(ticketId)) continue;
    for (const depId of asArray(ticket.depends_on).map(asString).filter(Boolean)) {
      if (ticketsById.has(depId)) depsById.get(ticketId).push(depId);
    }
  }
  for (const dep of asArray(packet?.dependencies)) {
    const source = dependencySource(dep);
    const target = dependencyTarget(dep);
    if (source && target && depsById.has(source) && ticketsById.has(target)) {
      depsById.get(source).push(target);
    }
  }

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(ticketId) {
    if (visited.has(ticketId)) return;
    if (visiting.has(ticketId)) return;
    visiting.add(ticketId);
    for (const depId of depsById.get(ticketId) || []) visit(depId);
    visiting.delete(ticketId);
    visited.add(ticketId);
    ordered.push(ticketId);
  }

  for (const ticket of tickets) visit(asString(ticket?.id));
  return ordered.filter(Boolean).map((ticketId) => ticketSummary(packet, ticketId));
}

function collectStoryIds(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) return null;
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    const stories = [...(Array.isArray(registry.stories) ? registry.stories : []), ...(Array.isArray(registry.infrastructure_stories) ? registry.infrastructure_stories : [])];
    return new Set(stories.map((story) => String(story.id || "").trim()).filter(Boolean));
  } catch {
    return null;
  }
}

function runProgramOntology(packet, cwd, gate = null, options = {}) {
  const session = createSession();
  session.consultFile(join(skillPath, "prolog", "verification_statuses.pl"));
  session.consultFile(join(skillPath, "prolog", "programs.pl"));
  session.consult(compileVerificationStatusFacts());
  try {
    session.consult(programPacketToFacts(packet, {
      cwd,
      gate,
      remoteMode: options.remoteMode,
      repo: options.repo,
      env: options.env,
      programPacketPath: options.programPacketPath,
    }));
  } catch (error) {
    return {
      violations: [{
        code: "program_ontology_fact_generation_failed",
        path: "ontology",
        message: error?.message || String(error),
      }],
      warnings: [],
    };
  }
  const violations = session.queryAll("invariant_violated(Name, Detail)");
  const warnings = session.queryAll("invariant_warning(Name, Detail)");
  return {
    violations: violations.map((entry) => ({
      code: String(entry.Name),
      path: "ontology",
      message: formatReason(entry.Detail),
    })),
    warnings: warnings.map((entry) => ({
      code: String(entry.Name),
      path: "ontology",
      message: formatReason(entry.Detail),
    })),
  };
}

function programStatusAfterGate(gate) {
  if (gate === "design-to-ready") return "ready";
  if (gate === "ready-to-execution") return "executing";
  if (gate === "execution-to-program-validate") return "validating";
  if (gate === "validate-to-program-close") return "closed";
  return null;
}

const PROGRAM_STATUS_ORDER = ["design", "ready", "executing", "validating", "closed"];

function isProgramStatusPastGate(previousStatus, nextStatus) {
  const previousIndex = PROGRAM_STATUS_ORDER.indexOf(asString(previousStatus));
  const nextIndex = PROGRAM_STATUS_ORDER.indexOf(asString(nextStatus));
  return previousIndex >= 0 && nextIndex >= 0 && previousIndex > nextIndex;
}

function buildProgramStatusTransition({ target, gate, write, env }) {
  const previousStatus = asString(target?.packet?.status) || null;
  const newStatus = programStatusAfterGate(gate);
  const supported = !!newStatus;
  const alreadyPastGate = supported && isProgramStatusPastGate(previousStatus, newStatus);
  const changed = supported && previousStatus !== newStatus && !alreadyPastGate;
  const transition = {
    gate: gate || null,
    previous_status: previousStatus,
    new_status: supported ? newStatus : previousStatus,
    write_requested: write === true,
    transition_written: false,
    status: supported ? (alreadyPastGate ? "already_past_gate" : (changed ? "pending" : "already_current")) : "unsupported_gate",
  };
  if (!supported || !write || !changed) return transition;
  const nextPacket = clone(target.packet);
  nextPacket.status = newStatus;
  writeFileSync(target.resolved.path, `${JSON.stringify(redactObject(nextPacket, env), null, 2)}\n`, "utf-8");
  target.packet = nextPacket;
  transition.transition_written = true;
  transition.status = "written";
  return transition;
}

function loadTarget(cwd, programArg) {
  const resolved = resolveProgramPacketPath({ cwd, program: programArg });
  if (resolved.status !== "FOUND") return { resolved };
  if (!existsSync(resolved.path)) {
    return {
      resolved: { status: "MISSING", path: resolved.path, message: `Program Packet not found: ${resolved.path}` },
    };
  }
  try {
    return { resolved, ...loadProgramPacket(resolved.path) };
  } catch (error) {
    return {
      resolved,
      loadError: {
        code: "program_packet_load_error",
        path: resolved.path,
        message: error.message,
      },
    };
  }
}

function safeReadJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function resolveArtifactPath(cwd, packetPath, artifactPath) {
  const raw = asString(artifactPath);
  if (!raw) return null;
  if (isAbsolute(raw)) return raw;
  const rootCandidate = resolve(cwd, raw);
  if (existsSync(rootCandidate)) return rootCandidate;
  return resolve(dirname(packetPath), raw);
}

function classifyRemediationAction(action) {
  const text = String(action || "").toLowerCase();
  if (/\bstor(y|ies)\b|story[- ]?bootstrap|story_registry|link .*stor/.test(text)) {
    return {
      workflow: "/story-bootstrap",
      command: "node .agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs --dry-run --json",
      kind: "story_traceability",
    };
  }
  if (/ripple_check|migration-bootstrap|migration smoke|migration proof/.test(text)) {
    return {
      workflow: "/safe-change-power",
      command: "node .agent/skills/iterative-planner/scripts/ripple_check.mjs && node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest",
      kind: "planner_core_proof",
    };
  }
  if (/annotation|consolidate-annotations/.test(text)) {
    return {
      workflow: "/consolidate-annotations",
      command: "node .agent/skills/iterative-planner/scripts/annotation_hints.mjs --json",
      kind: "annotation_repair",
    };
  }
  if (/verification|proof|acceptance/.test(text)) {
    return {
      workflow: "/safe-plan",
      command: "Review Program Packet verification_matrix and add missing proof rows.",
      kind: "verification_repair",
    };
  }
  return {
    workflow: "/advisor",
    command: "Review advisory recommendation and choose the lowest-risk deterministic repair.",
    kind: "manual_review",
  };
}

function advisoryRecommendedActions(parsed, receipt) {
  const direct = [
    ...asArray(parsed?.recommended_actions),
    ...asArray(parsed?.recommended_follow_up),
    ...asArray(parsed?.advisory?.recommended_actions),
    ...asArray(parsed?.deepseek_advisory?.recommended_actions),
    ...asArray(receipt?.recommended_actions),
  ].map(asString).filter(Boolean);
  if (direct.length > 0) return [...new Set(direct)];

  const block = asString(receipt?.deepseek_advisory_block || parsed?.deepseek_advisory_block);
  const actions = [];
  let inActions = false;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^recommended actions:/i.test(line)) {
      inActions = true;
      continue;
    }
    if (!inActions) continue;
    if (!line || /^<<<.*>>>$/.test(line)) break;
    const match = line.match(/^[-*]\s+(.+)$/);
    if (match) actions.push(match[1].trim());
  }
  return [...new Set(actions.filter(Boolean))];
}

function collectAdvisoryActionsFromTicket({ ticket, cwd, packetPath }) {
  const actions = [];
  for (const artifact of asArray(ticket?.review_artifacts)) {
    const artifactPath = resolveArtifactPath(cwd, packetPath, artifact?.path);
    if (!artifactPath || !existsSync(artifactPath)) continue;
    const parsed = safeReadJsonFile(artifactPath);
    const receipt = parsed?.ticket_intake_receipt || parsed?.review_packet?.ticket_intake_receipt || null;
    const blocked = [
      parsed?.final_status,
      parsed?.intake_packet?.final_status,
      receipt?.deterministic_status,
    ].some((status) => normalizeVerificationStatus(status, "execution").kind === "fail");
    if (!blocked && asString(ticket?.lifecycle) !== "blocked") continue;
    for (const action of advisoryRecommendedActions(parsed, receipt)) {
      actions.push({
        action,
        artifact_path: relativePath(cwd, artifactPath),
        advisory_status: asString(receipt?.deepseek_advisory_status || parsed?.advisory?.status || parsed?.deepseek_advisory?.status),
      });
    }
  }
  return actions.filter((entry) => entry.action);
}

function buildRemediationPlan({ result, target, cwd, write, timestamp }) {
  const packetPath = target?.resolved?.path;
  const packet = target?.packet || {};
  const tasks = [];
  for (const ticket of asArray(packet.tickets)) {
    const actions = collectAdvisoryActionsFromTicket({ ticket, cwd, packetPath });
    actions.forEach((action, index) => {
      const classified = classifyRemediationAction(action.action);
      tasks.push({
        id: `REMEDIATE-${sanitizeIdSegment(ticket.id)}-${String(index + 1).padStart(2, "0")}`,
        ticket_id: ticket.id || null,
        ticket_title: ticket.title || null,
        source_artifact: action.artifact_path,
        advisory_status: action.advisory_status,
        recommended_action: action.action,
        kind: classified.kind,
        workflow: classified.workflow,
        suggested_command: classified.command,
        suggested_subagent_type: classified.workflow === "/advisor" ? "explorer" : "worker",
        spawn_status: write ? "task_packet_written" : "dry_run_only",
        authority: "advisory_only_deterministic_gates_remain_authoritative",
        prompt: `Remediate Program Packet ticket ${ticket.id}: ${action.action}`,
      });
    });
  }

  for (const error of asArray(result?.errors)) {
    const classified = classifyRemediationAction(`${error.code} ${error.message}`);
    tasks.push({
      id: `REMEDIATE-PACKET-${String(tasks.length + 1).padStart(2, "0")}`,
      ticket_id: null,
      ticket_title: null,
      source_artifact: null,
      advisory_status: null,
      recommended_action: `${error.code}: ${error.message}`,
      kind: classified.kind,
      workflow: classified.workflow,
      suggested_command: classified.command,
      suggested_subagent_type: "worker",
      spawn_status: write ? "task_packet_written" : "dry_run_only",
      authority: "deterministic_packet_error",
      prompt: `Repair Program Packet validation error ${error.code}: ${error.message}`,
    });
  }

  const remediation = {
    enabled: true,
    mode: write ? "write" : "dry_run",
    status: tasks.length > 0 ? "tasks_prepared" : "no_tasks",
    generated_at: timestamp,
    task_count: tasks.length,
    tasks,
    note: "This CLI writes remediation task packets only; it does not directly spawn Codex subagents or override deterministic Program Packet gates.",
  };
  if (write && packetPath) {
    const stamp = timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const artifactPath = join(dirname(packetPath), "remediation", `remediation_${stamp}.json`);
    mkdirSync(dirname(artifactPath), { recursive: true });
    remediation.artifact_path = relativePath(cwd, artifactPath);
    writeFileSync(artifactPath, `${JSON.stringify(remediation, null, 2)}\n`, "utf-8");
  }
  return remediation;
}

function renderText(result) {
  const blockers = collectResultBlockers(result);
  const lines = [
    `Program Manager ${result.command}${result.gate ? ` ${result.gate}` : ""}: ${result.status}`,
    `Blockers: ${blockers.length}`,
  ];
  if (result.program?.id) lines.push(`Program: ${result.program.id} - ${compactText(result.program.title || "")}`);
  else if (result.packet_path) lines.push(`Packet: ${result.packet_path}`);
  else lines.push("Program: not resolved");
  if (result.message && blockers.length === 0) lines.push(`Message: ${compactText(result.message)}`);
  if (result.program_status_transition) {
    const transition = result.program_status_transition;
    lines.push(`Program status: ${transition.previous_status || "unknown"} -> ${transition.new_status || "unknown"} (${transition.transition_written ? "written" : transition.status || "not written"})`);
  }
  pushTopBlockers(lines, blockers, 3);
  if (result.remediation) {
    lines.push(`Remediation: ${result.remediation.status} (${result.remediation.task_count || 0} task(s))`);
  }
  const lifecycleLine = result.lifecycle_reconciliation
    ? renderLifecycleReconciliationStatusLine(result.lifecycle_reconciliation)
    : "";
  if (lifecycleLine) lines.push(lifecycleLine.trim());
  lines.push(formatResultArtifactLine(result));
  lines.push(`Next: ${verificationStatusIsPass(result.status, "execution") ? "continue with the next planned gate" : programManagerJsonCommand(result)}`);
  return lines.join("\n");
}

function attachLifecycleReconciliation(result, { cwd, programPath }) {
  if (result?.command !== "check") return result;
  try {
    const report = buildLifecycleReconciliationReport({
      cwd,
      program: programPath,
      write: false,
      includeStampedArtifacts: false,
    });
    return {
      ...result,
      lifecycle_reconciliation: lifecycleReconciliationSummary(report),
    };
  } catch (error) {
    return {
      ...result,
      lifecycle_reconciliation: {
        status: "UNAVAILABLE",
        advisory_findings: 0,
        shipped_open_findings: 0,
        duplicate_scope_findings: 0,
        repair_packet_path: null,
        repair_packet_written: false,
        dirty_worktree: false,
        warning_count: 1,
        error: error?.message || String(error),
      },
    };
  }
}

function buildResult({ command, gate, target, validation, ontology, message }) {
  const errors = [...(validation?.errors || []), ...(ontology?.violations || [])];
  const warnings = [...(validation?.warnings || []), ...(ontology?.warnings || [])];
  return {
    command,
    gate: gate || null,
    status: errors.length > 0 ? "FAIL" : "PASS",
    packet_path: target.resolved.path || null,
    program: target.packet ? {
      id: target.packet.id || null,
      title: target.packet.title || null,
      status: target.packet.status || null,
    } : null,
    counts: validation?.counts || {},
    remote_policy: validation?.remote_policy || null,
    gate_satisfiability: validation?.gate_satisfiability || null,
    errors,
    warnings,
    message: message || null,
  };
}

function compactText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function countIntakeBlockers(result) {
  if (result?.blocked_reason === "duplicate_candidates") return asArray(result?.duplicate_scan?.matches).length || 1;
  if (Array.isArray(result?.results)) {
    return result.results.reduce((total, item) => total + countIntakeBlockers(item), 0);
  }
  return asArray(result?.deterministic?.blockers).length
    || result?.ticket_intake_receipt?.deterministic_blocker_count
    || 0;
}

function intakeStatus(result) {
  if (result?.blocked_reason === "duplicate_candidates") return "blocked";
  if (Array.isArray(result?.results)) return countIntakeBlockers(result) > 0 ? "blocked" : (result.dry_run ? "dry-run" : "write");
  return result?.ticket_intake_receipt?.deterministic_status
    || result?.deterministic?.status
    || (verificationStatusIsPass(result?.status, "execution") ? "proposed" : String(result?.status || "unknown").toLowerCase());
}

function collectIntakeBlockerLines(result) {
  if (result?.blocked_reason === "duplicate_candidates") {
    return asArray(result?.duplicate_scan?.matches).map((match) => ({
      code: "duplicate_candidate",
      path: match.id || "ticket",
      message: `${match.title || "Existing ticket"} (${match.similarity || "?"}) in ${match.packet_path || "program packet"}`,
    }));
  }
  if (Array.isArray(result?.results)) return result.results.flatMap((item) => collectIntakeBlockerLines(item));
  return asArray(result?.deterministic?.blockers);
}

function collectResultBlockers(result) {
  const blockers = [
    ...asArray(result?.errors),
  ];
  if (blockers.length === 0 && normalizeVerificationStatus(result?.status, "execution").kind === "fail" && result?.message) {
    blockers.push({ code: "program_manager_failed", path: result.packet_path || "program", message: result.message });
  }
  return blockers;
}

function pushTopBlockers(lines, blockers, limit = 3) {
  for (const blocker of blockers.slice(0, limit)) {
    const code = blocker?.code || "blocker";
    const path = blocker?.path || "packet";
    const message = blocker?.message || String(blocker || "");
    lines.push(`- ${compactText(`${code}: ${path} - ${message}`)}`);
  }
  if (blockers.length > limit) lines.push(`More blockers: ${blockers.length - limit} (see artifact)`);
}

function formatIntakeArtifactLine(result) {
  const path = result?.intake_artifact_path || result?.ticket_intake_receipt?.intake_artifact_path || null;
  if (!path) return "Artifact: not written";
  if (result?.dry_run) return `Artifact: ${path} (planned; dry-run not written)`;
  return `Artifact: ${path}`;
}

function formatResultArtifactLine(result) {
  return result?.human_artifact_path
    ? `Artifact: ${result.human_artifact_path}`
    : "Artifact: not written";
}

function programManagerJsonCommand(result) {
  const gatePart = result?.gate ? ` ${result.gate}` : "";
  const programPart = result?.packet_path ? ` --program ${result.packet_path}` : "";
  return `node .agent/skills/iterative-planner/scripts/program_manager.mjs ${result?.command || "check"}${gatePart}${programPart} --json`;
}

function writeProgramManagerResultArtifact({ result, cwd, packetPath, env }) {
  if (!packetPath) return result;
  const stamp = nowIso().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const commandBits = [result?.command || "result", result?.gate || null].filter(Boolean).map(sanitizeIdSegment);
  const artifactPath = join(dirname(resolve(cwd, packetPath)), "artifacts", `program_manager_${commandBits.join("_")}_${stamp}.json`);
  const payload = {
    ...redactObject(result, env),
    repo_state_stamp: buildRepoStateStamp({
      cwd,
      invocation: {
        command: "program_manager.mjs",
        subcommand: result?.command || null,
        gate: result?.gate || null,
        packet_path: packetPath,
      },
    }),
  };
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return { ...result, human_artifact_path: relativePath(cwd, artifactPath) };
}

function renderIntakeText(result) {
  if (Array.isArray(result.results)) {
    const lines = [
      `Program Manager intake: ${intakeStatus(result)}`,
      `Blockers: ${countIntakeBlockers(result)}`,
      `Program packet: ${result.program_packet_path || "unknown"}`,
    ];
    for (const item of result.results) {
      lines.push(`Ticket: ${item.candidate_ticket?.id || "unknown"} - ${compactText(item.candidate_ticket?.title || "")}`);
      pushTopBlockers(lines, collectIntakeBlockerLines(item), 3);
      lines.push(formatIntakeArtifactLine(item));
      lines.push(`Next: ${item.ticket_intake_receipt?.next_required_command || "inspect artifact or rerun with --json"}`);
    }
    return lines.join("\n");
  }
  if (normalizeVerificationStatus(result.status, "execution").kind === "fail" && result.blocked_reason === "duplicate_candidates") {
    const lines = [
      "Program Manager intake: blocked",
      `Blockers: ${countIntakeBlockers(result)}`,
      `Ticket: ${result.candidate_ticket?.id || "unknown"} - ${compactText(result.candidate_ticket?.title || "")}`,
    ];
    pushTopBlockers(lines, collectIntakeBlockerLines(result), 3);
    lines.push("Artifact: not written");
    lines.push("Next: consolidate with the existing ticket, or re-run with --allow-duplicate if genuinely new.");
    return lines.join("\n");
  }
  const blockers = collectIntakeBlockerLines(result);
  const receipt = result.ticket_intake_receipt;
  const lines = [
    `Program Manager intake: ${intakeStatus(result)}`,
    `Blockers: ${countIntakeBlockers(result)}`,
    `Ticket: ${result.candidate_ticket?.id || receipt?.ticket_id || "unknown"} - ${compactText(result.candidate_ticket?.title || receipt?.ticket_title || "")}`,
  ];
  if (result.duplicate_scan?.status === "overridden") {
    lines.push(`Duplicate scan: overridden via --allow-duplicate (${asArray(result.duplicate_scan?.matches).map((m) => m.id).join(", ")})`);
  }
  pushTopBlockers(lines, blockers, 3);
  lines.push(formatIntakeArtifactLine(result));
  if (receipt?.github_publication) lines.push(`GitHub: ${receipt.github_publication}`);
  lines.push(`Next: ${receipt?.next_required_command || "inspect artifact or rerun with --json"}`);
  return lines.join("\n");
}

function renderFindingsTriageText(result) {
  const lines = [
    `Program Manager findings triage: ${String(result.status || "UNKNOWN").toLowerCase()}`,
    `Accepted: ${result.accepted === true ? "yes" : "no"}`,
    `Packet updated: ${result.packet_updated === true ? "yes" : "no"}`,
    `Findings: ${result.finding_count || 0}`,
    `Candidates: ${result.candidate_count || 0}`,
    `Program packet: ${result.program_packet_path || "unknown"}`,
  ];
  for (const item of asArray(result.results).slice(0, 5)) {
    lines.push(`Ticket: ${item.candidate_ticket?.id || "unknown"} - ${compactText(item.candidate_ticket?.title || "")}`);
    if (item.source_finding?.failing_suite_id) lines.push(`Suite: ${item.source_finding.failing_suite_id}`);
    lines.push(`Artifact: ${result.accepted && result.write && item.intake_artifact_path ? item.intake_artifact_path : "not written"}`);
  }
  lines.push(`Next: ${result.next_required_command || "inspect artifact or rerun with --json"}`);
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  const env = process.env;
  if (["help", "--help", "-h"].includes(args.command)) {
    console.log(usage());
    return 0;
  }

  const FORWARD_COMMANDS = new Set(["next-ready", "dispatch-order", "blockers", "unlocks-if-closed"]);
  const KNOWN_COMMANDS = new Set(["init", "intake", "triage-findings", "disposition", "check", "verify", "facts", ...FORWARD_COMMANDS]);
  if (!KNOWN_COMMANDS.has(args.command)) {
    console.error(`Unknown command: ${args.command}\n\n${usage()}`);
    return 2;
  }
  if (args.command === "init") {
    try {
      const result = runInit(args, { cwd });
      console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
      return 0;
    } catch (error) {
      const payload = {
        command: "init",
        status: "FAIL",
        packet_path: error?.packetPath || null,
        error: error?.message || String(error),
        errors: error?.validation?.errors || [],
        warnings: error?.validation?.warnings || [],
        remote_policy: error?.validation?.remote_policy || null,
        gate_satisfiability: error?.validation?.gate_satisfiability || null,
      };
      if (args.json) console.log(JSON.stringify(payload, null, 2));
      else {
        const resolutionOptions = asArray(payload.gate_satisfiability?.requirements)
          .flatMap((entry) => asArray(entry?.resolution_options).map((option) => option.action))
          .filter((value, index, values) => value && values.indexOf(value) === index);
        const lines = [
          "Program Manager init: FAIL",
          `Blockers: ${payload.errors.length || 1}`,
          `Error: ${compactText(payload.error)}`,
        ];
        if (resolutionOptions.length > 0) lines.push(`Resolution: ${resolutionOptions.join(" | ")}`);
        lines.push("Next: choose one explicit resolution and rerun init");
        console.error(lines.join("\n"));
      }
      return 1;
    }
  }
  if (args.command === "intake") {
    try {
      const result = await runIntake(args, { cwd });
      console.log(args.json ? JSON.stringify(result, null, 2) : renderIntakeText(result));
      const blockedDuplicate = result?.blocked_reason === "duplicate_candidates"
        || asArray(result?.results).some((entry) => entry?.blocked_reason === "duplicate_candidates");
      if (blockedDuplicate) return 3;
      return 0;
    } catch (error) {
      const payload = { status: "FAIL", error: error?.message || String(error) };
      if (args.json) console.log(JSON.stringify(payload, null, 2));
      else console.error(`${payload.error}\n\n${usage()}`);
      return 1;
    }
  }
  if (args.command === "triage-findings") {
    try {
      const result = await runFindingsTriage(args, { cwd });
      console.log(args.json ? JSON.stringify(result, null, 2) : renderFindingsTriageText(result));
      const blockedDuplicate = normalizeVerificationStatus(result?.status, "execution").kind === "fail"
        || asArray(result?.results).some((entry) => entry?.blocked_reason === "duplicate_candidates");
      if (blockedDuplicate) return 3;
      return 0;
    } catch (error) {
      const payload = { command: "triage-findings", status: "FAIL", error: error?.message || String(error) };
      if (args.json) console.log(JSON.stringify(payload, null, 2));
      else console.error(`${payload.error}\n\n${usage()}`);
      return 1;
    }
  }
  if (args.command === "disposition") {
    try {
      const result = runDisposition(args, { cwd });
      console.log(args.json ? JSON.stringify(result, null, 2) : renderProgramDispositionText(result));
      return verificationStatusIsPass(result.status, "execution") ? 0 : 1;
    } catch (error) {
      const payload = { command: "disposition", status: "FAIL", error: error?.message || String(error) };
      if (args.json) console.log(JSON.stringify(payload, null, 2));
      else console.error(`${payload.error}\n\n${usage()}`);
      return 1;
    }
  }
  if (args.command === "verify" && !args.gate) {
    console.error(`Missing program gate.\n\n${usage()}`);
    return 2;
  }
  if ((args.command === "blockers" || args.command === "unlocks-if-closed") && !args.ticket) {
    console.error(`Missing ticket id for ${args.command}.\n\n${usage()}`);
    return 2;
  }

  const target = loadTarget(cwd, args.program);
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Program-packet resolver protocol (FOUND, SKIP, MISSING, AMBIGUOUS), not a verification result; SKIP means no optional packet is in scope.
  if (target.resolved.status === "SKIP") {
    const result = {
      command: args.command,
      gate: args.gate,
      status: "SKIP",
      packet_path: null,
      program: null,
      counts: {},
      errors: [],
      warnings: [],
      message: target.resolved.message,
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 0;
  }
  if (target.resolved.status === "AMBIGUOUS" || target.resolved.status === "MISSING" || target.loadError) {
    const error = target.loadError || {
      code: `program_packet_${target.resolved.status.toLowerCase()}`,
      path: target.resolved.path || "plans/programs",
      message: target.resolved.message,
    };
    const result = {
      command: args.command,
      gate: args.gate,
      status: "FAIL",
      packet_path: target.resolved.path || null,
      program: null,
      counts: {},
      errors: [error],
      warnings: target.resolved.candidates ? [{ code: "program_packet_candidates", path: "plans/programs", message: target.resolved.candidates.join(", ") }] : [],
      message: null,
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 1;
  }

  const remotePolicyOptions = {
    remoteMode: args.remoteMode,
    repo: args.repo,
    env,
    programPacketPath: target.resolved.path,
  };

  if (args.command === "facts") {
    const facts = programPacketToFacts(target.packet, { cwd, ...remotePolicyOptions });
    console.log(facts.trimEnd());
    return 0;
  }

  if (FORWARD_COMMANDS.has(args.command)) {
    const tickets = (() => {
      if (args.command === "dispatch-order") {
        return dispatchOrderTickets(target.packet);
      }
      if (args.command === "next-ready") {
        const rows = runForwardReasoning(target.packet, cwd, "next_ready_ticket(Ticket)", remotePolicyOptions);
        const ids = rows.map((row) => String(row.Ticket)).filter(Boolean);
        return ids.map((id) => ticketSummary(target.packet, id));
      }
      if (args.command === "blockers") {
        const rows = runForwardReasoning(target.packet, cwd, `blocking_chain('${args.ticket}', Blocker)`, remotePolicyOptions);
        const ids = [...new Set(rows.map((row) => String(row.Blocker)).filter(Boolean))];
        return ids.map((id) => ticketSummary(target.packet, id));
      }
      if (args.command === "unlocks-if-closed") {
        const rows = runForwardReasoning(target.packet, cwd, `becomes_ready_if_closed('${args.ticket}', NewlyReady)`, remotePolicyOptions);
        const ids = [...new Set(rows.map((row) => String(row.NewlyReady)).filter(Boolean))];
        return ids.map((id) => ticketSummary(target.packet, id));
      }
      return [];
    })();
    const result = {
      command: args.command,
      gate: null,
      status: "PASS",
      packet_path: target.resolved.path,
      program: target.packet ? {
        id: target.packet.id || null,
        title: target.packet.title || null,
        status: target.packet.status || null,
      } : null,
      ticket: args.ticket || null,
      tickets,
      counts: { tickets: tickets.length },
      errors: [],
      warnings: [],
      message: null,
    };
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const header = `Program Manager: ${result.command}${result.ticket ? ` ${result.ticket}` : ""}`;
      const lines = [header, `Status: ${result.status}`, `Program: ${result.program?.id || "?"} — ${result.program?.title || ""}`, `Tickets returned: ${tickets.length}`];
      for (const ticket of tickets) {
        lines.push(`  - ${ticket.id} [${ticket.lifecycle || "?"}] ${ticket.title || ""}`);
      }
      console.log(lines.join("\n"));
    }
    return 0;
  }

  const options = { cwd, storyIds: collectStoryIds(cwd), ...remotePolicyOptions };
  const validation = args.command === "verify"
    ? evaluateProgramGate(target.packet, args.gate, options)
    : validateProgramPacket(target.packet, options);
  const ontology = runProgramOntology(target.packet, cwd, args.command === "verify" ? args.gate : null, remotePolicyOptions);
  let result = buildResult({
    command: args.command,
    gate: args.gate,
    target,
    validation,
    ontology,
  });
  result = attachLifecycleReconciliation(result, {
    cwd,
    programPath: target.resolved.path,
  });
  if (args.command === "verify") {
    result.program_status_transition = verificationStatusIsPass(result.status, "execution")
      ? buildProgramStatusTransition({
        target,
        gate: args.gate,
        write: args.write === true,
        env,
      })
      : {
        gate: args.gate,
        previous_status: target.packet?.status || null,
        new_status: programStatusAfterGate(args.gate) || target.packet?.status || null,
        write_requested: args.write === true,
        transition_written: false,
        status: "not_written_gate_failed",
      };
    result.program.status = target.packet?.status || result.program.status;
  }
  if (args.remediate) {
    result.remediation = buildRemediationPlan({
      result,
      target,
      cwd,
      write: args.write,
      timestamp: nowIso(),
    });
  }
  const textResult = args.json
    ? result
    : writeProgramManagerResultArtifact({ result, cwd, packetPath: target.resolved.path, env });
  console.log(args.json ? JSON.stringify(result, null, 2) : renderText(textResult));
  return verificationStatusIsPass(result.status, "execution") ? 0 : 1;
}

if (process.argv[1] === __filename) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main, parseArgs };
