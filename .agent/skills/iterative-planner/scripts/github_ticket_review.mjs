#!/usr/bin/env node
// github_ticket_review.mjs — Review GitHub tickets against planner evidence.

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  evaluateProgramGate,
  loadProgramPacket,
  resolveProgramPacketPath,
  validateProgramPacket,
} from "./lib/program_packet.mjs";
import { redactSecrets } from "./lib/provider_client.mjs";
import {
  evaluateRetroRecurrenceCheck,
  recurrenceCheckToBlockers,
} from "./lib/retro_recurrence_check.mjs";
import {
  evaluateQuantPersonaGate,
  quantPersonaGateToBlockers,
} from "./lib/quant_persona_gate.mjs";
import {
  assertRemoteReadAllowed,
  assertRemoteWriteAllowed,
  resolveRemoteMode,
} from "./lib/remote_mode.mjs";
import {
  buildIssueSyncContract,
} from "./lib/issue_sync_contract.mjs";
import {
  buildKnowledgeReceipt,
} from "./lib/knowledge_receipt.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = __dirname;
const repoScriptPrefix = ".agent/skills/iterative-planner/scripts";

export const TICKET_REVIEW_STATUSES = Object.freeze([
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

const BLOCKING_COMMANDS = new Set([
  "program_manager_check",
  "program_gate_design_to_ready",
  "program_gate_ready_to_execution",
  "program_gate_execution_to_program_validate",
  "program_gate_validate_to_program_close",
  "rule_engine_verify_stories",
  "rule_engine_find_conflicts",
  "annotation_parser_validate",
  "ontology_serializer",
  "rule_engine_check_invariants",
]);

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(asString).filter(Boolean))];
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function truncate(value, max = 1200) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

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

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function sanitizeFileSegment(value) {
  return normalizeToken(value) || "ticket";
}

function parseArgs(argv = []) {
  const args = [...argv];
  const parsed = {
    command: args.shift() || "help",
    issue: null,
    projectItem: null,
    program: null,
    ticket: null,
    repo: null,
    project: null,
    remoteMode: null,
    write: false,
    json: false,
    closeGithubIssue: false,
    acceptRemoteClose: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--issue") parsed.issue = args[++i] || null;
    else if (arg === "--project-item") parsed.projectItem = args[++i] || null;
    else if (arg === "--program") parsed.program = args[++i] || null;
    else if (arg === "--ticket") parsed.ticket = args[++i] || null;
    else if (arg === "--repo") parsed.repo = args[++i] || null;
    else if (arg === "--project") parsed.project = args[++i] || null;
    else if (arg === "--remote-mode") parsed.remoteMode = args[++i] || null;
    else if (arg === "--write") parsed.write = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--close-github-issue") parsed.closeGithubIssue = true;
    else if (arg === "--accept-remote-close") parsed.acceptRemoteClose = true;
    else if (arg === "--help" || arg === "-h") parsed.command = "help";
    else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function usage() {
  return `github_ticket_review.mjs — Review GitHub tickets against planner evidence

Usage:
  node github_ticket_review.mjs review --issue <n> --program <program-id-or-path> --ticket <ticket-id> [--repo <owner/repo>] [--remote-mode local-only|remote-read|remote-sync] [--write] [--accept-remote-close] [--json]
  node github_ticket_review.mjs review --project-item <node-id-or-url> --program <program-id-or-path> --ticket <ticket-id> [--repo <owner/repo>] [--remote-mode local-only|remote-read|remote-sync] [--write] [--accept-remote-close] [--json]
  node github_ticket_review.mjs publish --program <program-id-or-path> --ticket <ticket-id> --repo <owner/repo> [--project <id/url>] [--remote-mode local-only|remote-read|remote-sync] [--write] [--json]

Safety:
  Dry-run is the default. --write is required for Program Packet edits, review artifacts,
  GitHub comments, labels, project status updates, or issue close attempts.
  GitHub issues are never closed unless --close-github-issue is also passed.
  A closed remote issue advances local ticket lifecycle only with --write --accept-remote-close
  and passing deterministic review checks.
  PLANNER_REMOTE_MODE defaults remote access when --remote-mode is omitted.
  Modes: local-only blocks GitHub reads/writes, remote-read permits reads only,
  and remote-sync permits explicit --write mirror updates.`;
}

function parseRepoFromRemote(remote) {
  const text = String(remote || "").trim();
  if (!text) return null;
  const https = text.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/i);
  if (!https) return null;
  return https[1].replace(/\.git$/i, "");
}

function resolveRepo(cwd, explicitRepo = null, gitRunner = defaultGitRunner) {
  if (asString(explicitRepo)) return explicitRepo;
  const result = gitRunner(["remote", "get-url", "origin"], { cwd });
  if (result.status !== 0) return null;
  return parseRepoFromRemote(result.stdout);
}

function splitRepo(repo) {
  const [owner, name] = String(repo || "").split("/");
  return owner && name ? { owner, name } : { owner: null, name: null };
}

function defaultGitRunner(args, { cwd = process.cwd() } = {}) {
  const child = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: child.status ?? (child.error ? 1 : 0),
    stdout: child.stdout || "",
    stderr: child.stderr || child.error?.message || "",
  };
}

function defaultGhRunner(args, { cwd = process.cwd() } = {}) {
  const child = spawnSync("gh", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: child.status ?? (child.error ? 1 : 0),
    stdout: child.stdout || "",
    stderr: child.stderr || child.error?.message || "",
  };
}

function defaultCommandRunner(command, { cwd = process.cwd() } = {}) {
  const child = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return {
    status: child.status ?? (child.error ? 1 : 0),
    stdout: child.stdout || "",
    stderr: child.stderr || child.error?.message || "",
  };
}

function runGhJson(args, options) {
  const result = options.ghRunner(args, { cwd: options.cwd });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${truncate(result.stderr || result.stdout, 800)}`);
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(`gh ${args.join(" ")} returned invalid JSON: ${error.message}`);
  }
}

function parseProjectItemId(value) {
  const text = asString(value);
  if (!text) return null;
  if (/^PVTI_/i.test(text)) return text;
  const url = text.match(/[?&]itemId=([^&#]+)/i);
  if (url) return decodeURIComponent(url[1]);
  const path = text.match(/\/items\/([^/?#]+)/i);
  if (path) return decodeURIComponent(path[1]);
  return text.includes("/") ? null : text;
}

function normalizeIssue(raw, { repo, source = "issue", projectItem = null } = {}) {
  const labels = asArray(raw?.labels).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean);
  const comments = asArray(raw?.comments).map((comment) => {
    const databaseId = comment?.databaseId ?? comment?.database_id ?? null;
    const graphId = comment?.node_id || comment?.nodeId || comment?.graphqlId || comment?.id || null;
    return {
      id: databaseId ?? comment?.id ?? null,
      node_id: graphId && String(graphId) !== String(databaseId ?? "") ? graphId : null,
      url: comment?.url || null,
      body: comment?.body || "",
      author: comment?.author?.login || comment?.author || null,
    };
  });
  return {
    source,
    repo,
    id: raw?.id || null,
    node_id: raw?.node_id || raw?.nodeId || null,
    number: raw?.number ?? null,
    title: raw?.title || "",
    body: raw?.body || "",
    state: raw?.state || null,
    url: raw?.url || null,
    labels,
    comments,
    project_item: projectItem,
  };
}

function fetchIssue(issueNumber, { cwd, repo, ghRunner }) {
  const json = runGhJson([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "number,title,body,state,url,labels,comments,assignees,milestone",
  ], { cwd, ghRunner });
  return normalizeIssue(json, { repo, source: "issue" });
}

function projectItemQuery() {
  return `query($id: ID!) {
    node(id: $id) {
      ... on ProjectV2Item {
        id
        type
        project { id title url }
        content {
          __typename
          ... on Issue {
            number
            title
            body
            state
            url
            repository { name owner { login } }
            labels(first: 30) { nodes { name } }
          }
        }
        fieldValues(first: 30) {
          nodes {
            __typename
            ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } }
            ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { id name } } }
          }
        }
      }
    }
  }`;
}

function projectFieldsQuery() {
  return `query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        id
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }`;
}

function fetchProjectItem(projectItemArg, { cwd, repo, ghRunner }) {
  const itemId = parseProjectItemId(projectItemArg);
  if (!itemId) throw new Error("Project item must be a ProjectV2 item node id or a URL containing itemId/items/<id>");
  const json = runGhJson(["api", "graphql", "-f", `query=${projectItemQuery()}`, "-F", `id=${itemId}`], { cwd, ghRunner });
  const item = json?.data?.node;
  if (!item?.id) throw new Error(`Project item not found: ${projectItemArg}`);
  const content = item.content || {};
  let issue = null;
  if (content.__typename === "Issue" && content.number) {
    const linkedRepo = content.repository?.owner?.login && content.repository?.name
      ? `${content.repository.owner.login}/${content.repository.name}`
      : repo;
    issue = fetchIssue(content.number, { cwd, repo: linkedRepo, ghRunner });
    issue.source = "project_item";
  } else {
    issue = normalizeIssue({
      number: null,
      title: content.title || `Project item ${item.id}`,
      body: JSON.stringify(item.fieldValues || {}, null, 2),
      state: content.state || null,
      url: item.project?.url || null,
      labels: [],
      comments: [],
    }, { repo, source: "project_item" });
  }
  issue.project_item = {
    id: item.id,
    type: item.type || null,
    project: item.project || null,
    field_values: item.fieldValues?.nodes || [],
    source_arg: projectItemArg,
  };
  return issue;
}

function loadTarget(cwd, programArg) {
  const resolved = resolveProgramPacketPath({ cwd, program: programArg });
  if (resolved.status !== "FOUND") {
    throw new Error(resolved.message || `Program Packet not found for ${programArg || "(default)"}`);
  }
  const loaded = loadProgramPacket(resolved.path);
  return { path: resolved.path, packet: loaded.packet };
}

function collectStoryIds(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) return null;
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    const stories = [
      ...asArray(registry.stories),
      ...asArray(registry.infrastructure_stories),
    ];
    return new Set(stories.map((story) => asString(story?.id)).filter(Boolean));
  } catch {
    return null;
  }
}

function readStoryRegistryIndex(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(registryPath)) return new Map();
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    const stories = [
      ...asArray(registry?.stories),
      ...asArray(registry?.infrastructure_stories),
    ];
    return new Map(stories.map((story) => [asString(story?.id), story]).filter(([id]) => id));
  } catch {
    return new Map();
  }
}

function storyTitle(story) {
  return asString(story?.title || story?.name || story?.summary || story?.narrative?.need) || null;
}

function storyStatus(story) {
  return asString(story?.status || story?.state || story?.review_status) || null;
}

function collectStoryContext({ ticket, storyRefs, cwd }) {
  const registry = cwd ? readStoryRegistryIndex(cwd) : new Map();
  const explicit = new Map(asArray(ticket?.story_context)
    .map((entry) => [asString(entry?.id || entry?.story_ref || entry?.storyRef), entry])
    .filter(([id]) => id));
  return uniqueStrings(storyRefs).map((storyRef) => {
    const provided = explicit.get(storyRef) || null;
    const story = registry.get(storyRef) || null;
    return {
      id: storyRef,
      title: asString(provided?.title) || storyTitle(story),
      status: asString(provided?.status) || storyStatus(story),
      relevance: asString(provided?.relevance || provided?.context || provided?.reason) || "Linked through Program Packet ticket or acceptance criteria.",
    };
  });
}

function findTicket(packet, ticketId) {
  return asArray(packet?.tickets).find((ticket) => asString(ticket?.id) === ticketId) || null;
}

function collectTicketEvidence(packet, ticket, { cwd = null } = {}) {
  const acceptanceIds = new Set(asArray(ticket?.acceptance_criteria).map(asString).filter(Boolean));
  const verificationIds = new Set(asArray(ticket?.verification_refs).map(asString).filter(Boolean));
  const acceptance = asArray(packet?.acceptance_criteria)
    .filter((criterion) => acceptanceIds.has(asString(criterion?.id)) || asString(criterion?.subject_ref) === asString(ticket?.id));
  const verification = asArray(packet?.verification_matrix)
    .filter((row) => verificationIds.has(asString(row?.id)) || asString(row?.subject_ref) === asString(ticket?.id));
  const storyRefs = uniqueStrings([
    ...asArray(ticket?.story_refs),
    ...acceptance.flatMap((criterion) => asArray(criterion?.story_refs)),
  ]);
  const changedFiles = uniqueStrings([
    ...asArray(ticket?.changed_files),
    ...asArray(ticket?.canonical_files),
    ...asArray(ticket?.deletes_files),
    ...asArray(ticket?.moves_files).flatMap((move) => typeof move === "string" ? [move] : [move?.from, move?.to]),
  ]);
  return {
    story_refs: storyRefs,
    story_context: collectStoryContext({ ticket, storyRefs, cwd }),
    defect_refs: uniqueStrings(ticket?.defect_refs),
    gap_refs: uniqueStrings(ticket?.gap_refs),
    acceptance_criteria: acceptance,
    verification_rows: verification,
    child_plan: ticket?.child_plan || null,
    changed_files: changedFiles,
  };
}

function markdownBlock(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function comparableLine(value) {
  return markdownBlock(value).replace(/\s+/g, " ").toLowerCase();
}

function firstMarkdownBlock(values) {
  for (const value of values) {
    const text = markdownBlock(value);
    if (text) return text;
  }
  return "";
}

function stripDuplicateLeadingTitle(text, title) {
  const body = markdownBlock(text);
  const heading = comparableLine(title);
  if (!body || !heading) return body;
  const lines = body.split("\n");
  if (comparableLine(lines[0]) !== heading) return body;
  return lines.slice(1).join("\n").trim();
}

function intakeDescriptionFromPacket(intakePacket, ticketTitle) {
  if (!intakePacket || typeof intakePacket !== "object") return null;
  const title = firstMarkdownBlock([
    intakePacket.source?.ticket_title,
    intakePacket.source?.title,
    intakePacket.ticket_title,
    intakePacket.title,
  ]);
  const text = firstMarkdownBlock([
    intakePacket.source?.text,
    intakePacket.source_text,
    intakePacket.body,
    intakePacket.source?.body,
    intakePacket.text,
    intakePacket.description,
    intakePacket.source?.description,
    intakePacket.content,
    intakePacket.source?.content,
  ]);
  const body = stripDuplicateLeadingTitle(text, ticketTitle || title);
  if (!body) return null;
  const structured = intakePacket.source?.structured || intakePacket.structured || {};
  return {
    title,
    body,
    problem: firstMarkdownBlock([
      intakePacket.candidate_ticket?.problem,
      structured.problem,
      intakePacket.problem,
    ]),
    proposed_change: firstMarkdownBlock([
      intakePacket.candidate_ticket?.proposed_change,
      structured.proposed_change,
      intakePacket.proposed_change,
    ]),
    story_context: asArray(intakePacket.story_context || intakePacket.candidate_ticket?.story_context || structured.story_context),
  };
}

function resolveArtifactCandidates({ cwd, packetPath, artifactPath }) {
  const raw = asString(artifactPath);
  if (!raw) return [];
  if (isAbsolute(raw)) return [raw];
  return uniqueStrings([
    resolve(cwd, raw),
    packetPath ? resolve(dirname(packetPath), raw) : null,
  ]);
}

function loadIntakeDescription({ cwd, packetPath, ticket }) {
  const artifacts = asArray(ticket?.review_artifacts).filter((artifact) => {
    const kind = asString(artifact?.kind);
    const path = asString(artifact?.path);
    return kind === "program_intake_packet" || /intake_packet\.json$/i.test(path);
  });
  for (const artifact of artifacts) {
    for (const candidate of resolveArtifactCandidates({ cwd, packetPath, artifactPath: artifact.path })) {
      if (!candidate || !existsSync(candidate)) continue;
      try {
        const packet = JSON.parse(readFileSync(candidate, "utf-8"));
        const description = intakeDescriptionFromPacket(packet, ticket?.title);
        if (description) return { ...description, path: candidate };
      } catch {
        // Publish must remain available for hand-authored or stale Program Packets.
      }
    }
  }
  return null;
}

function buildTicketIntakeReceipt({
  action,
  source,
  programPacketPath,
  ticket,
  evidence,
  deterministicStatus,
  deterministicBlockers,
  github,
  reviewArtifactPath,
  retroRecurrenceCheck,
  quantPersonaGate,
  sourceText,
  programContext,
}) {
  const blockers = asArray(deterministicBlockers);
  const recurrence = retroRecurrenceCheck || null;
  const quantGate = quantPersonaGate || null;
  const personaReview = ticket?.persona_review || null;
  const personaPacks = uniqueStrings([
    ...asArray(ticket?.persona_packs),
    ...asArray(personaReview?.persona_packs),
  ]);
  const knowledgeReceipt = buildKnowledgeReceipt({
    source: {
      surface: `github_ticket_${action || "review"}`,
      kind: source || null,
      title: github?.title || ticket?.title || null,
      ticket_id: ticket?.id || null,
      path: reviewArtifactPath || null,
      text: sourceText || null,
    },
    ticket,
    personaReview,
    personaPacks,
    sourceText: sourceText || "",
    retroRecurrenceCheck: recurrence,
    quantPersonaGate: quantGate,
    deterministicStatus: deterministicStatus || "not_run_publish_only",
    deterministicBlockers: blockers,
    evidenceRefs: [
      ...asArray(ticket?.story_refs),
      ...asArray(ticket?.verification_refs),
      ...asArray(evidence?.verification_rows).map((entry) => entry?.id),
    ],
    remainingUnverifiedRisk: [],
    artifactRefs: [
      { kind: "program_packet", path: programPacketPath },
      reviewArtifactPath ? { kind: "ticket_review_packet", path: reviewArtifactPath } : null,
    ].filter(Boolean),
  });
  return {
    name: "Ticket Intake Receipt",
    version: 1,
    action,
    front_door: "/program-manager",
    source: {
      kind: source || null,
      repo: github?.repo || null,
      issue_number: github?.issue_number ?? github?.number ?? null,
      project_item_id: github?.project_item_id || null,
      url: github?.url || null,
      title: github?.title || null,
    },
    program_packet_path: programPacketPath,
    review_artifact_path: reviewArtifactPath || null,
    ticket_id: ticket?.id || null,
    ticket_title: ticket?.title || null,
    ticket_lifecycle: ticket?.lifecycle || null,
    persona_packs: personaPacks,
    story_refs: uniqueStrings([...asArray(ticket?.story_refs), ...asArray(evidence?.story_refs)]),
    gap_refs: uniqueStrings([...asArray(ticket?.gap_refs), ...asArray(evidence?.gap_refs)]),
    defect_refs: uniqueStrings([...asArray(ticket?.defect_refs), ...asArray(evidence?.defect_refs)]),
    acceptance_criteria_refs: uniqueStrings([
      ...asArray(ticket?.acceptance_criteria),
      ...asArray(evidence?.acceptance_criteria).map((entry) => entry?.id),
    ]),
    verification_refs: uniqueStrings([
      ...asArray(ticket?.verification_refs),
      ...asArray(evidence?.verification_rows).map((entry) => entry?.id),
    ]),
    deterministic_status: deterministicStatus || "not_run_publish_only",
    deterministic_blocker_count: blockers.length,
    deterministic_blockers: blockers.slice(0, 8),
    program_context_status: programContext?.status || null,
    program_context_blocker_count: asArray(programContext?.blockers).length,
    program_context_blockers: asArray(programContext?.blockers).slice(0, 8),
    knowledge_receipt: knowledgeReceipt,
    retro_recurrence_status: recurrence?.status || "not_run",
    retro_recurrence_blocking_count: recurrence?.summary?.blocking_count || 0,
    retro_recurrence_advisory_count: recurrence?.summary?.advisory_count || 0,
    quant_persona_gate_status: quantGate?.status || "not_run",
    quant_persona_gate_required: quantGate?.required === true,
    quant_persona_gate_reason: quantGate?.reason || null,
    quant_persona_gate_declared_scope: quantGate?.declared_scope || null,
    quant_persona_gate_missing_count: quantGate?.summary?.missing_guard_count || 0,
    direct_github_creation_allowed: false,
    github_publication: action === "publish" ? "explicit_publish" : "mirror_sync_only",
    next_required_command: `node .agent/skills/iterative-planner/scripts/program_manager.mjs check --program ${programPacketPath} --json`,
    review_command: `node .agent/skills/iterative-planner/scripts/github_ticket_review.mjs review --issue <n> --program ${programPacketPath} --ticket ${ticket?.id || "<ticket-id>"} --json`,
  };
}

function relevantProgramGates(status) {
  const normalized = normalizeToken(status);
  if (normalized === "design") return ["design-to-ready"];
  if (normalized === "ready") return ["design-to-ready", "ready-to-execution"];
  if (normalized === "executing") return ["ready-to-execution", "execution-to-program-validate"];
  if (normalized === "validating") return ["execution-to-program-validate", "validate-to-program-close"];
  if (normalized === "closed") return ["validate-to-program-close"];
  return [];
}

function scriptCommand(id, scriptName, args) {
  const scriptPath = join(scriptDir, scriptName);
  const display = `node ${repoScriptPrefix}/${scriptName} ${args.join(" ")}`.trim();
  return {
    id,
    argv: [process.execPath, scriptPath, ...args],
    display,
  };
}

function deterministicCommandPlan({ packet, programPath, storyRefs }) {
  const commands = [
    scriptCommand("program_manager_check", "program_manager.mjs", ["check", "--program", programPath, "--json"]),
  ];
  for (const gate of relevantProgramGates(packet?.status)) {
    commands.push(scriptCommand(`program_gate_${gate.replaceAll("-", "_")}`, "program_manager.mjs", ["verify", gate, "--program", programPath, "--json"]));
  }
  if (storyRefs.length > 0) {
    for (const storyRef of storyRefs) {
      commands.push(scriptCommand(`story_registry_evidence_${normalizeToken(storyRef)}`, "story_registry.mjs", ["evidence", storyRef, "--json"]));
    }
  } else {
    commands.push(scriptCommand("story_registry_evidence", "story_registry.mjs", ["evidence", "--json"]));
  }
  commands.push(
    scriptCommand("rule_engine_verify_stories", "rule_engine.mjs", ["verify-stories", "--json"]),
    scriptCommand("rule_engine_find_conflicts", "rule_engine.mjs", ["find-conflicts", "--json"]),
    scriptCommand("annotation_parser_validate", "annotation_parser.mjs", ["--json", "--validate"]),
    scriptCommand("annotation_assist", "annotation_assist.mjs", ["--json"]),
    scriptCommand("ontology_serializer", "ontology_serializer.mjs", ["--json"]),
    scriptCommand("rule_engine_check_invariants", "rule_engine.mjs", ["check-invariants", "--json"]),
  );
  return commands;
}

function summarizeCommand(command, result, env) {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return {
    id: command.id,
    command: command.display,
    exit_code: result.status,
    status: result.status === 0 ? "pass" : "fail",
    blocking: BLOCKING_COMMANDS.has(command.id),
    stdout_excerpt: truncate(redactText(stdout, env), 1600),
    stderr_excerpt: truncate(redactText(stderr, env), 800),
    output_sha256: sha256(`${stdout}\n${stderr}`),
  };
}

function runDeterministicCommands({ cwd, packet, programPath, storyRefs, commandRunner, env }) {
  const commands = deterministicCommandPlan({ packet, programPath, storyRefs });
  return commands.map((command) => summarizeCommand(command, commandRunner(command, { cwd }), env));
}

function collectDeterministicBlockers({ validation, gateResults, commandResults }) {
  const blockers = [];
  for (const error of validation.errors || []) {
    blockers.push({
      source: "program_packet",
      code: error.code || "program_packet_error",
      path: error.path || null,
      message: error.message || "Program Packet validation failed",
    });
  }
  for (const gate of gateResults || []) {
    for (const error of gate.errors || []) {
      blockers.push({
        source: `program_gate:${gate.gate}`,
        code: error.code || "program_gate_error",
        path: error.path || null,
        message: error.message || "Program gate failed",
      });
    }
  }
  for (const result of commandResults || []) {
    if (result.exit_code !== 0 && result.blocking) {
      blockers.push({
        source: result.id,
        code: `${result.id}_failed`,
        path: result.command,
        message: result.stderr_excerpt || result.stdout_excerpt || "Deterministic command failed",
      });
    }
  }
  return blockers;
}

function targetReferenceIds(ticket, ticketEvidence) {
  return uniqueStrings([
    ticket?.id,
    ...asArray(ticket?.acceptance_criteria),
    ...asArray(ticket?.verification_refs),
    ...asArray(ticket?.compatibility_contract_refs),
    ...asArray(ticket?.migration_boundary_refs),
    ...asArray(ticket?.deletion_move_census_refs),
    ...asArray(ticketEvidence?.acceptance_criteria).map((entry) => entry?.id),
    ...asArray(ticketEvidence?.verification_rows).map((entry) => entry?.id),
  ]);
}

function tokenAppears(value, token) {
  const text = String(value || "");
  const escaped = String(token || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(text);
}

function targetOwnsValidationError(error, ticket, ticketEvidence) {
  const code = asString(error?.code);
  const path = asString(error?.path);
  const message = asString(error?.message);
  if (
    code === "program_packet_not_object"
    || code === "program_packet_version"
    || code === "program_remote_mode_invalid"
    || code === "program_invalid_status"
    || code.startsWith("program_missing_")
    || code.endsWith("_not_array")
  ) return true;
  return targetReferenceIds(ticket, ticketEvidence).some((id) => (
    path.includes(`[${id}]`)
    || tokenAppears(message, id)
  ));
}

function collectTicketAcceptanceBlockers({ validation, commandResults, ticket, ticketEvidence }) {
  const blockers = [];
  for (const error of asArray(validation?.errors)) {
    if (!targetOwnsValidationError(error, ticket, ticketEvidence)) continue;
    blockers.push({
      source: "ticket_contract",
      code: error.code || "ticket_contract_error",
      path: error.path || null,
      message: error.message || "Reviewed ticket contract validation failed",
    });
  }
  for (const result of asArray(commandResults)) {
    if (result.exit_code === 0 || !String(result.id || "").startsWith("story_registry_evidence")) continue;
    blockers.push({
      source: result.id,
      code: `${result.id}_failed`,
      path: result.command,
      message: result.stderr_excerpt || result.stdout_excerpt || "Reviewed ticket story evidence failed",
    });
  }
  return blockers;
}

function reviewArtifactPath(packetPath, ticketId) {
  const dir = join(dirname(packetPath), "reviews");
  return join(dir, `${sanitizeFileSegment(ticketId)}_review_packet.json`);
}

function relativePath(cwd, path) {
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return abs.startsWith(resolve(cwd)) ? abs.slice(resolve(cwd).length + 1) : path;
}

function externalRefForIssue(issue, timestamp) {
  const base = {
    synced_at: timestamp,
    title: issue.title || null,
    state: issue.state || null,
    url: issue.url || null,
  };
  if (issue.project_item?.id) {
    return {
      kind: "github_project_item",
      repo: issue.repo || null,
      issue_number: issue.number || null,
      project_item_id: issue.project_item.id,
      project_id: issue.project_item.project?.id || null,
      project_url: issue.project_item.project?.url || null,
      ...base,
    };
  }
  return {
    kind: "github_issue",
    repo: issue.repo || null,
    issue_number: issue.number || null,
    ...base,
  };
}

function sameExternalRef(a, b) {
  if (a?.kind !== b?.kind) return false;
  if (b.kind === "github_issue") return a.repo === b.repo && Number(a.issue_number) === Number(b.issue_number);
  if (b.kind === "github_project_item") return a.project_item_id === b.project_item_id;
  return false;
}

function upsertBy(items, next, predicate) {
  const out = asArray(items).filter((item) => !predicate(item, next));
  out.push(next);
  return out;
}

function updateProgramPacket({ packet, ticketId, issue, artifactRelPath, finalStatus, timestamp, sync }) {
  const next = JSON.parse(JSON.stringify(packet));
  const ticket = findTicket(next, ticketId);
  if (!ticket) throw new Error(`Ticket not found while updating packet: ${ticketId}`);
  const remoteDecision = sync?.sync_contract?.remote_to_local || null;
  const acceptedRemoteClose = finalStatus === "review_ready"
    && remoteDecision?.action === "candidate_remote_close"
    && remoteDecision?.candidate_lifecycle;
  if (acceptedRemoteClose) {
    ticket.lifecycle = remoteDecision.candidate_lifecycle;
  }
  const issueForPacket = sync?.close?.action === "closed"
    ? { ...issue, state: "CLOSED" }
    : issue;
  const externalRef = externalRefForIssue(issueForPacket, timestamp);
  ticket.external_refs = upsertBy(ticket.external_refs, externalRef, sameExternalRef);
  const artifact = {
    path: artifactRelPath,
    kind: "ticket_review_packet",
    status: finalStatus,
    generated_at: timestamp,
  };
  ticket.review_artifacts = upsertBy(ticket.review_artifacts, artifact, (a, b) => a?.path === b.path);
  ticket.github_sync = {
    ...(ticket.github_sync && typeof ticket.github_sync === "object" ? ticket.github_sync : {}),
    last_synced_at: timestamp,
    last_review_status: finalStatus,
    last_issue_url: issue.url || ticket.github_sync?.last_issue_url || null,
    last_comment_url: sync?.comment_url || ticket.github_sync?.last_comment_url || null,
    last_sync_contract_version: sync?.sync_contract?.version || ticket.github_sync?.last_sync_contract_version || null,
    last_sync_conflicts: sync?.sync_contract?.conflicts || [],
    last_remote_to_local: remoteDecision
      ? {
          action: acceptedRemoteClose ? "accepted_remote_close" : remoteDecision.action,
          candidate_lifecycle: remoteDecision.candidate_lifecycle || null,
          accepted_lifecycle: acceptedRemoteClose ? remoteDecision.candidate_lifecycle : null,
          reason: remoteDecision.reason || null,
          accepted_at: acceptedRemoteClose ? timestamp : null,
        }
      : ticket.github_sync?.last_remote_to_local || null,
    labels_applied: sync?.labels_applied || [],
    labels_removed: sync?.labels_removed || [],
    project_status: sync?.project_status || null,
    close: sync?.close || null,
  };
  ticket.last_review_status = finalStatus;
  ticket.review_status = finalStatus;
  return next;
}

function markerFor(ticketId) {
  return `<!-- planner-ticket-review:${ticketId} -->`;
}

function renderReviewComment(reviewPacket, { env = process.env } = {}) {
  const blockers = asArray(reviewPacket.deterministic?.blockers);
  const programContext = reviewPacket.deterministic?.program_context || null;
  const programBlockers = asArray(programContext?.blockers);
  const recurrence = reviewPacket.retro_recurrence_check || reviewPacket.deterministic?.retro_recurrence_check || null;
  const recurrenceMatches = asArray(recurrence?.matches);
  const quantGate = reviewPacket.quant_persona_gate || reviewPacket.deterministic?.quant_persona_gate || null;
  const lines = [
    markerFor(reviewPacket.ticket?.id || "unknown"),
    "### Planner Ticket Review",
    "",
    `Status: **${reviewPacket.final_status}**`,
    `Program context: **${programContext?.status || "unknown"}**`,
    `Program: \`${reviewPacket.program?.id || "unknown"}\``,
    `Ticket: \`${reviewPacket.ticket?.id || "unknown"}\``,
    `Review packet: \`${reviewPacket.artifact?.path || "dry-run"}\``,
    "",
    "Deterministic checks are authoritative.",
    "",
  ];
  if (recurrence) {
    lines.push("Retro Recurrence Check:");
    lines.push(`- Status: \`${recurrence.status || "not_run"}\``);
    lines.push(`- Blocking: ${recurrence.summary?.blocking_count || 0}; Advisory: ${recurrence.summary?.advisory_count || 0}`);
    for (const match of recurrenceMatches.filter((entry) => entry.blocking).slice(0, 4)) {
      lines.push(`- BLOCKED ${match.id}: missing ${asArray(match.missing_proof).join(", ") || "required recurrence evidence"}`);
    }
    for (const match of recurrenceMatches.filter((entry) => !entry.blocking && entry.status === "advisory").slice(0, 3)) {
      lines.push(`- Advisory ${match.id}: ${match.title || match.source_type || "recurrence match"}`);
    }
    lines.push("");
  }
  if (quantGate?.required) {
    lines.push("Quant Persona Gate:");
    lines.push(`- Status: \`${quantGate.status || "not_run"}\``);
    lines.push(`- Missing guards: ${quantGate.summary?.missing_guard_count || 0}`);
    for (const guard of asArray(quantGate.required_guards).filter((entry) => !entry.satisfied).slice(0, 5)) {
      lines.push(`- BLOCKED ${guard.id}: ${guard.next_action || "required quant evidence missing"}`);
    }
    lines.push("");
  }
  if (blockers.length > 0) {
    lines.push("Blocking evidence:");
    for (const blocker of blockers.slice(0, 8)) {
      lines.push(`- ${blocker.source}: ${blocker.code} — ${blocker.message}`);
    }
    if (blockers.length > 8) lines.push(`- ... ${blockers.length - 8} more blocker(s)`);
  } else {
    lines.push("Blocking evidence: none found by deterministic checks.");
  }
  if (programContext) {
    lines.push("", "Program-wide context (separate from ticket review acceptance):");
    if (programBlockers.length > 0) {
      for (const blocker of programBlockers.slice(0, 5)) {
        lines.push(`- ${blocker.source}: ${blocker.code} — ${blocker.message}`);
      }
      if (programBlockers.length > 5) lines.push(`- ... ${programBlockers.length - 5} more Program blocker(s)`);
      lines.push("- These blockers remain authoritative at publish and Program-close gates.");
    } else {
      lines.push("- Whole-Program validation, gates, and commands reported no blocker.");
    }
  }
  if (reviewPacket.artifact?.path) {
    lines.push("", `Review packet: \`${reviewPacket.artifact.path}\``);
  }
  return redactText(lines.join("\n"), env);
}

function findExistingReviewComment(issue, ticketId) {
  const marker = markerFor(ticketId);
  return asArray(issue?.comments).find((comment) => String(comment?.body || "").includes(marker)) || null;
}

function ghWrite(args, { cwd, ghRunner }) {
  const result = ghRunner(args, { cwd });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${truncate(result.stderr || result.stdout, 800)}`);
  }
  return result;
}

function isRestCommentId(value) {
  return /^\d+$/.test(String(value || ""));
}

function updateIssueComment({ repo, comment, body, cwd, ghRunner }) {
  const { owner, name } = splitRepo(repo);
  if (!owner || !name) return { action: "skipped", reason: "Cannot update comment without owner/repo" };
  if (isRestCommentId(comment?.id)) {
    ghWrite(["api", `repos/${owner}/${name}/issues/comments/${comment.id}`, "-X", "PATCH", "-f", `body=${body}`], { cwd, ghRunner });
    return { action: "updated", method: "rest", comment_url: comment.url || null };
  }
  const nodeId = asString(comment?.node_id || comment?.id);
  if (!nodeId) return { action: "skipped", reason: "Existing comment has no updateable id" };
  const mutation = `mutation($id: ID!, $body: String!) {
    updateIssueComment(input: { id: $id, body: $body }) {
      issueComment { url }
    }
  }`;
  const json = runGhJson(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${nodeId}`, "-f", `body=${body}`], { cwd, ghRunner });
  return {
    action: "updated",
    method: "graphql",
    comment_url: json?.data?.updateIssueComment?.issueComment?.url || comment.url || null,
  };
}

function syncIssueComment({ issue, ticketId, body, cwd, repo, ghRunner }) {
  if (!issue?.number) return { action: "skipped", reason: "No linked issue number" };
  const existing = findExistingReviewComment(issue, ticketId);
  if (existing?.id) {
    return updateIssueComment({ repo, comment: existing, body, cwd, ghRunner });
  }
  const result = ghWrite(["issue", "comment", String(issue.number), "--repo", repo, "--body", body], { cwd, ghRunner });
  return { action: "created", comment_url: asString(result.stdout) || null };
}

function listRepoLabels({ cwd, repo, ghRunner }) {
  const json = runGhJson(["label", "list", "--repo", repo, "--json", "name", "--limit", "1000"], { cwd, ghRunner });
  return new Set(asArray(json).map((entry) => asString(entry?.name || entry)).filter(Boolean));
}

function createRepoLabel({ cwd, repo, label, ghRunner }) {
  ghWrite([
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--color",
    "6f42c1",
    "--description",
    "Planner Program Packet mirror label",
  ], { cwd, ghRunner });
}

function preflightLabels({ issue, labels, cwd, repo, ghRunner }) {
  if (!issue?.number || labels.length === 0) return { action: "skipped", labels: [], created: [] };
  const existing = listRepoLabels({ cwd, repo, ghRunner });
  const missing = labels.filter((label) => !existing.has(label));
  for (const label of missing) createRepoLabel({ cwd, repo, label, ghRunner });
  return { action: missing.length > 0 ? "created_missing" : "ok", labels, created: missing };
}

function syncLabels({ issue, labels, removeLabels = [], cwd, repo, ghRunner }) {
  const addLabels = uniqueStrings(labels);
  const remove = uniqueStrings(removeLabels).filter((label) => !addLabels.includes(label));
  if (!issue?.number || (addLabels.length === 0 && remove.length === 0)) return { action: "skipped", labels: [], removed: [] };
  const args = ["issue", "edit", String(issue.number), "--repo", repo];
  if (addLabels.length > 0) args.push("--add-label", addLabels.join(","));
  if (remove.length > 0) args.push("--remove-label", remove.join(","));
  ghWrite(args, { cwd, ghRunner });
  return { action: "updated", labels: addLabels, removed: remove };
}

function desiredProjectStatus(finalStatus) {
  return normalizeVerificationStatus(finalStatus, "execution").kind === "fail"
    ? ["Blocked", "Planner Blocked"]
    : ["Review Ready", "Ready for Review", "Planner Review Ready"];
}

function discoverProjectStatusMapping({ projectId, finalStatus, cwd, ghRunner }) {
  if (!projectId) return null;
  const json = runGhJson(["api", "graphql", "-f", `query=${projectFieldsQuery()}`, "-F", `projectId=${projectId}`], { cwd, ghRunner });
  const fields = asArray(json?.data?.node?.fields?.nodes);
  const statusField = fields.find((field) => normalizeToken(field?.name) === "status" && Array.isArray(field.options));
  if (!statusField) return null;
  const desired = desiredProjectStatus(finalStatus).map(normalizeToken);
  const option = asArray(statusField.options).find((candidate) => desired.includes(normalizeToken(candidate?.name)));
  if (!option) return null;
  return { field_id: statusField.id, option_id: option.id, option_name: option.name };
}

function syncProjectStatus({ issue, finalStatus, cwd, ghRunner }) {
  const item = issue?.project_item;
  const projectId = item?.project?.id;
  if (!item?.id || !projectId) return { action: "skipped", reason: "No project item/project id" };
  const mapping = discoverProjectStatusMapping({ projectId, finalStatus, cwd, ghRunner });
  if (!mapping) return { action: "skipped", reason: "No matching Status field option discovered" };
  ghWrite([
    "project",
    "item-edit",
    "--id",
    item.id,
    "--project-id",
    projectId,
    "--field-id",
    mapping.field_id,
    "--single-select-option-id",
    mapping.option_id,
  ], { cwd, ghRunner });
  return { action: "updated", status: mapping.option_name, field_id: mapping.field_id, option_id: mapping.option_id };
}

function maybeCloseIssue({ issue, cwd, repo, ghRunner, closeGithubIssue, body }) {
  if (!closeGithubIssue) return { action: "skipped", reason: "--close-github-issue not set" };
  if (!issue?.number) return { action: "skipped", reason: "No linked issue number" };
  ghWrite(["issue", "close", String(issue.number), "--repo", repo, "--comment", body], { cwd, ghRunner });
  return { action: "closed" };
}

function remoteCloseAcceptanceStatus({ requested, finalStatus, syncContract, write = false }) {
  const decision = syncContract?.remote_to_local || {};
  if (!requested) {
    return { requested: false, accepted: false, action: "not_requested", reason: "--accept-remote-close not set" };
  }
  if (finalStatus !== "review_ready") {
    return {
      requested: true,
      accepted: false,
      action: "blocked_by_review",
      reason: "Deterministic review did not reach review_ready.",
    };
  }
  if (decision.action !== "candidate_remote_close") {
    return {
      requested: true,
      accepted: false,
      action: decision.action || "not_applicable",
      reason: decision.reason || "Remote close is not a local advancement candidate.",
    };
  }
  if (!write) {
    return {
      requested: true,
      accepted: false,
      would_accept: true,
      action: "candidate_remote_close",
      candidate_lifecycle: decision.candidate_lifecycle || null,
      reason: "Dry-run only; use --write --accept-remote-close to advance local lifecycle.",
    };
  }
  return {
    requested: true,
    accepted: true,
    action: "accepted_remote_close",
    accepted_lifecycle: decision.candidate_lifecycle || null,
    reason: "Remote close accepted through deterministic review-ready Program Manager gate.",
  };
}

function syncGithub({ issue, ticket, reviewPacket, args, cwd, repo, ghRunner, env }) {
  const body = renderReviewComment(reviewPacket, { env });
  const acceptRemoteClose = Boolean(args.acceptRemoteClose && reviewPacket.final_status === "review_ready");
  const syncContract = buildIssueSyncContract({
    ticket,
    issue,
    reviewStatus: reviewPacket.final_status,
    closeGithubIssue: args.closeGithubIssue,
    acceptRemoteClose,
  });
  const labels = syncContract.local_to_remote.desired_labels;
  const removeLabels = syncContract.local_to_remote.remove_labels;
  const labelPreflight = preflightLabels({ issue, labels, cwd, repo, ghRunner });
  const comment = syncIssueComment({ issue, ticketId: ticket.id, body, cwd, repo, ghRunner });
  const labelResult = syncLabels({ issue, labels, removeLabels, cwd, repo, ghRunner });
  const projectStatus = syncProjectStatus({ issue, finalStatus: reviewPacket.final_status, cwd, ghRunner });
  const close = maybeCloseIssue({
    issue,
    cwd,
    repo,
    ghRunner,
    closeGithubIssue: args.closeGithubIssue,
    body,
  });
  return {
    comment,
    comment_url: comment.comment_url || null,
    label_preflight: labelPreflight,
    labels: labelResult,
    labels_applied: labelResult.labels || [],
    labels_removed: labelResult.removed || [],
    project_status: projectStatus,
    close,
    sync_contract: syncContract,
    remote_close_acceptance: remoteCloseAcceptanceStatus({
      requested: args.acceptRemoteClose,
      finalStatus: reviewPacket.final_status,
      syncContract,
      write: true,
    }),
    comment_body: body,
  };
}

function buildInitialReviewPacket({ issue, packet, packetPath, ticket, ticketEvidence, validation, gateResults, commandResults, blockers, programBlockers, recurrenceCheck, quantPersonaGate, timestamp, artifactRelPath }) {
  return {
    version: 1,
    generated_at: timestamp,
    program: {
      id: packet.id || null,
      title: packet.title || null,
      status: packet.status || null,
      packet_path: packetPath,
    },
    ticket,
    github: {
      source: issue.source,
      repo: issue.repo,
      issue_number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: issue.url,
      labels: issue.labels,
      project_item: issue.project_item,
    },
    linked_evidence: ticketEvidence,
    retro_recurrence_check: recurrenceCheck,
    quant_persona_gate: quantPersonaGate,
    deterministic: {
      status: blockers.length > 0 ? "blocked" : "review_ready",
      blockers,
      retro_recurrence_check: recurrenceCheck,
      quant_persona_gate: quantPersonaGate,
      program_context: {
        status: programBlockers.length > 0 ? "blocked" : "pass",
        blockers: programBlockers,
        authority: "visible_in_review_authoritative_at_publish_and_program_close",
      },
      program_packet_validation: validation,
      program_gates: gateResults,
      command_results: commandResults,
    },
    final_status: blockers.length > 0 ? "blocked" : "review_ready",
    artifact: {
      path: artifactRelPath,
    },
  };
}

function writeReviewArtifact({ artifactPath, reviewPacket, env }) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const redactedPacket = redactObject(reviewPacket, env);
  writeFileSync(artifactPath, `${JSON.stringify(redactedPacket, null, 2)}\n`, "utf-8");
}

function writeReviewOutputs({ cwd, packetPath, packet, reviewPacket, artifactPath, ticketId, issue, sync, timestamp, env }) {
  const updatedPacket = updateProgramPacket({
    packet,
    ticketId,
    issue,
    artifactRelPath: relativePath(cwd, artifactPath),
    finalStatus: reviewPacket.final_status,
    timestamp,
    sync,
  });
  writeFileSync(packetPath, `${JSON.stringify(updatedPacket, null, 2)}\n`, "utf-8");
  return updatedPacket;
}

export async function runReview(inputArgs, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const clock = options.clock || (() => new Date());
  const ghRunner = options.ghRunner || defaultGhRunner;
  const gitRunner = options.gitRunner || defaultGitRunner;
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const args = Array.isArray(inputArgs) ? parseArgs(inputArgs) : { ...inputArgs };

  if (args.command !== "review") throw new Error(`Unknown command: ${args.command || "(missing)"}`);
  if (!args.program) throw new Error("Missing --program");
  if (!args.ticket) throw new Error("Missing --ticket");
  if (!!args.issue === !!args.projectItem) throw new Error("Pass exactly one of --issue or --project-item");
  const remoteMode = resolveRemoteMode({
    explicit: args.remoteMode,
    env,
    defaultMode: args.write ? "remote-sync" : "remote-read",
  });
  if (args.write) {
    assertRemoteWriteAllowed(remoteMode, "github_ticket_review review --write");
  } else {
    assertRemoteReadAllowed(remoteMode, "github_ticket_review review");
  }

  const repo = resolveRepo(cwd, args.repo, gitRunner);
  if (!repo) throw new Error("Cannot determine GitHub repo; pass --repo <owner/repo>");
  const timestamp = nowIso(clock);
  const issue = args.issue
    ? fetchIssue(args.issue, { cwd, repo, ghRunner })
    : fetchProjectItem(args.projectItem, { cwd, repo, ghRunner });
  const target = loadTarget(cwd, args.program);
  const ticket = findTicket(target.packet, args.ticket);
  if (!ticket) throw new Error(`Ticket not found in Program Packet: ${args.ticket}`);
  const packetForReview = JSON.parse(JSON.stringify(target.packet));
  const ticketForReview = findTicket(packetForReview, args.ticket);
  if (ticketForReview) {
    ticketForReview.external_refs = upsertBy(
      ticketForReview.external_refs,
      externalRefForIssue(issue, timestamp),
      sameExternalRef,
    );
  }

  const storyIds = collectStoryIds(cwd);
  const validation = validateProgramPacket(packetForReview, {
    cwd,
    storyIds,
    programPacketPath: target.path,
  });
  const gateResults = relevantProgramGates(packetForReview.status).map((gate) => evaluateProgramGate(packetForReview, gate, {
    cwd,
    storyIds,
    programPacketPath: target.path,
  }));
  const ticketEvidence = collectTicketEvidence(packetForReview, ticketForReview || ticket, { cwd });
  const commandResults = runDeterministicCommands({
    cwd,
    packet: packetForReview,
    programPath: target.path,
    storyRefs: ticketEvidence.story_refs,
    commandRunner,
    env,
  });
  const recurrenceCheck = evaluateRetroRecurrenceCheck({
    cwd,
    sourceText: [issue.title, issue.body].filter(Boolean).join("\n\n"),
    packet: packetForReview,
    ticket: ticketForReview || ticket,
    acceptanceCriteria: ticketEvidence.acceptance_criteria,
    verificationRows: ticketEvidence.verification_rows,
    commandResults,
    reviewArtifacts: (ticketForReview || ticket).review_artifacts,
    env,
  });
  const quantPersonaGate = evaluateQuantPersonaGate({
    sourceText: [issue.title, issue.body].filter(Boolean).join("\n\n"),
    packet: packetForReview,
    ticket: ticketForReview || ticket,
    acceptanceCriteria: ticketEvidence.acceptance_criteria,
    verificationRows: ticketEvidence.verification_rows,
    changedFiles: ticketEvidence.changed_files,
    reviewArtifacts: (ticketForReview || ticket).review_artifacts,
  });
  const programBlockers = collectDeterministicBlockers({ validation, gateResults, commandResults });
  const blockers = [
    ...collectTicketAcceptanceBlockers({
      validation,
      commandResults,
      ticket: ticketForReview || ticket,
      ticketEvidence,
    }),
    ...recurrenceCheckToBlockers(recurrenceCheck),
    ...quantPersonaGateToBlockers(quantPersonaGate),
  ];
  const artifactPath = reviewArtifactPath(target.path, args.ticket);
  const artifactRelPath = relativePath(cwd, artifactPath);
  let reviewPacket = buildInitialReviewPacket({
    issue,
    packet: packetForReview,
    packetPath: relativePath(cwd, target.path),
    ticket: ticketForReview || ticket,
    ticketEvidence,
    validation,
    gateResults,
    commandResults,
    blockers,
    programBlockers,
    recurrenceCheck,
    quantPersonaGate,
    timestamp,
    artifactRelPath,
  });

  reviewPacket = {
    ...reviewPacket,
    final_status: reviewPacket.deterministic.status,
  };
  reviewPacket.ticket_intake_receipt = buildTicketIntakeReceipt({
    action: "review",
    source: issue.project_item?.id ? "github_project_item" : "github_issue",
    programPacketPath: relativePath(cwd, target.path),
    ticket: ticketForReview || ticket,
    evidence: ticketEvidence,
    deterministicStatus: reviewPacket.final_status,
    deterministicBlockers: reviewPacket.deterministic.blockers,
    retroRecurrenceCheck: recurrenceCheck,
    quantPersonaGate,
    github: {
      repo,
      issue_number: issue.number,
      project_item_id: issue.project_item?.id || null,
      url: issue.url,
      title: issue.title,
    },
    sourceText: [issue.title, issue.body].filter(Boolean).join("\n\n"),
    reviewArtifactPath: artifactRelPath,
    programContext: reviewPacket.deterministic.program_context,
  });

  const dryRunSyncContract = buildIssueSyncContract({
    ticket: ticketForReview || ticket,
    issue,
    reviewStatus: reviewPacket.final_status,
    closeGithubIssue: args.closeGithubIssue,
    acceptRemoteClose: Boolean(args.acceptRemoteClose && reviewPacket.final_status === "review_ready"),
  });
  let githubSync = {
    mode: args.write ? "write" : "dry_run",
    remote_mode: remoteMode,
    planned_comment: renderReviewComment(reviewPacket, { env }),
    labels_applied: dryRunSyncContract.local_to_remote.desired_labels,
    labels_removed: dryRunSyncContract.local_to_remote.remove_labels,
    sync_contract: dryRunSyncContract,
    remote_close_acceptance: remoteCloseAcceptanceStatus({
      requested: args.acceptRemoteClose,
      finalStatus: reviewPacket.final_status,
      syncContract: dryRunSyncContract,
      write: args.write,
    }),
    project_status: null,
  };
  let updatedPacket = null;
  if (args.write) {
    writeReviewArtifact({ artifactPath, reviewPacket, env });
    githubSync = {
      remote_mode: remoteMode,
      ...syncGithub({ issue, ticket, reviewPacket, args, cwd, repo, ghRunner, env }),
    };
    updatedPacket = writeReviewOutputs({
      cwd,
      packetPath: target.path,
      packet: target.packet,
      reviewPacket,
      artifactPath,
      ticketId: args.ticket,
      issue,
      sync: githubSync,
      timestamp,
      env,
    });
  }

  const result = {
    status: "PASS",
    review_status: reviewPacket.final_status,
    dry_run: !args.write,
    write: !!args.write,
    remote_mode: remoteMode,
    close_github_issue: !!args.closeGithubIssue,
    accept_remote_close: !!args.acceptRemoteClose,
    repo,
    issue: {
      source: issue.source,
      number: issue.number,
      url: issue.url,
      project_item_id: issue.project_item?.id || null,
    },
    program_packet_path: relativePath(cwd, target.path),
    review_artifact_path: artifactRelPath,
    review_packet: args.write ? redactObject(reviewPacket, env) : redactObject(reviewPacket, env),
    ticket_intake_receipt: redactObject(reviewPacket.ticket_intake_receipt, env),
    github_sync: redactObject(githubSync, env),
    packet_updated: !!updatedPacket,
  };
  return redactObject(result, env);
}

function publishMarker(ticketId) {
  return `<!-- planner-ticket-publish:${ticketId} -->`;
}

function firstBodyParagraph(value) {
  return markdownBlock(value).split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) || "";
}

function publishProblem({ ticket, intakeDescription }) {
  return firstMarkdownBlock([
    ticket?.problem,
    intakeDescription?.problem,
    firstBodyParagraph(intakeDescription?.body),
    "This Program Packet ticket needs implementation with explicit story, acceptance, and verification evidence.",
  ]);
}

function publishProposedChange({ ticket, intakeDescription, title }) {
  return firstMarkdownBlock([
    ticket?.proposed_change,
    intakeDescription?.proposed_change,
    firstBodyParagraph(intakeDescription?.body),
    `Implement ${title} according to the linked Program Packet ticket and verification rows.`,
  ]);
}

function renderStoryContext(evidence, intakeDescription) {
  const explicit = asArray(evidence.story_context).length > 0
    ? evidence.story_context
    : asArray(intakeDescription?.story_context);
  if (explicit.length > 0) {
    return explicit.slice(0, 10).map((entry) => {
      const id = asString(entry?.id || entry?.story_ref || entry?.storyRef);
      const title = asString(entry?.title);
      const status = asString(entry?.status);
      const relevance = asString(entry?.relevance || entry?.context || entry?.reason);
      const head = id ? `\`${id}\`` : "Story context";
      const label = title ? `${head}: ${title}` : head;
      const details = [
        status ? `status ${status}` : null,
        relevance || null,
      ].filter(Boolean).join("; ");
      return details ? `- ${label} - ${details}` : `- ${label}`;
    });
  }
  const storyRefs = uniqueStrings(evidence.story_refs);
  if (storyRefs.length === 0) return ["- No story refs are linked yet; this blocks readiness until story or gap traceability is added."];
  return storyRefs.slice(0, 10).map((id) => `- \`${id}\`: Linked through Program Packet ticket or acceptance criteria.`);
}

function renderPublishIssueBody({ packet, ticket, evidence, intakeDescription = null, env = process.env }) {
  const title = asString(ticket.title) || "Program ticket";
  const lines = [
    publishMarker(ticket.id || "unknown"),
    `# ${title}`,
    "",
  ];
  lines.push(
    "## Problem",
    publishProblem({ ticket, intakeDescription }),
    "",
    "## Proposed Change",
    publishProposedChange({ ticket, intakeDescription, title }),
    "",
    "## Story Context",
    ...renderStoryContext(evidence, intakeDescription),
  );
  const gapRefs = uniqueStrings(evidence.gap_refs);
  const defectRefs = uniqueStrings(evidence.defect_refs);
  if (gapRefs.length > 0) lines.push(`- Gap refs: ${gapRefs.map((id) => `\`${id}\``).join(", ")}`);
  if (defectRefs.length > 0) lines.push(`- Defect refs: ${defectRefs.map((id) => `\`${id}\``).join(", ")}`);
  if (evidence.acceptance_criteria.length > 0) {
    lines.push("", "## Acceptance Criteria");
    for (const criterion of evidence.acceptance_criteria.slice(0, 8)) {
      lines.push(`- \`${criterion.id}\`: ${criterion.text || criterion.summary || "Acceptance criterion"}`);
    }
  }
  if (evidence.verification_rows.length > 0) {
    lines.push("", "## Verification");
    for (const row of evidence.verification_rows.slice(0, 8)) {
      const proof = row.proof_type ? `${row.proof_type} - ` : "";
      const passMeans = row.pass_means ? ` Pass means: ${row.pass_means}` : "";
      lines.push(`- \`${row.id}\`: ${proof}${row.command_or_action || "Verification row"}.${passMeans}`);
    }
  }
  lines.push(
    "",
    "## Planner Metadata",
    `- Program: \`${packet.id || "unknown"}\``,
    `- Ticket: \`${ticket.id || "unknown"}\``,
    `- Lifecycle: \`${ticket.lifecycle || "proposed"}\``,
    "- Source of truth: deterministic Program Packet evidence; this GitHub issue is a collaboration mirror.",
  );
  return redactText(lines.join("\n"), env);
}

function existingPublishedIssue(ticket, repo) {
  return asArray(ticket?.external_refs).find((ref) => (
    ref?.kind === "github_issue" &&
    ref?.repo === repo &&
    (ref.issue_number || ref.url)
  )) || null;
}

function issueFromPublishedRef(ref, repo) {
  return {
    source: "publish",
    repo,
    number: ref.issue_number ?? null,
    title: ref.title || "",
    body: "",
    state: ref.state || null,
    url: ref.url || null,
    labels: [],
    comments: [],
  };
}

function createGithubIssue({ repo, title, body, cwd, ghRunner }) {
  const { owner, name } = splitRepo(repo);
  if (!owner || !name) throw new Error(`Invalid repo: ${repo}`);
  const json = runGhJson([
    "api",
    `repos/${owner}/${name}/issues`,
    "-X",
    "POST",
    "-f",
    `title=${title}`,
    "-f",
    `body=${body}`,
  ], { cwd, ghRunner });
  return normalizeIssue(json, { repo, source: "publish" });
}

function publishProjectLink({ project, issue, repo, cwd, ghRunner }) {
  if (!project) return { action: "skipped", reason: "No project requested" };
  const issueNodeId = issue.node_id || issue.nodeId || issue.id || null;
  if (/^PVT_/i.test(String(project || "")) && issueNodeId) {
    const mutation = `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`;
    const json = runGhJson([
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-F",
      `projectId=${project}`,
      "-F",
      `contentId=${issueNodeId}`,
    ], { cwd, ghRunner });
    return {
      action: "linked",
      project,
      project_item_id: json?.data?.addProjectV2ItemById?.item?.id || null,
    };
  }

  const { owner } = splitRepo(repo);
  ghWrite(["project", "item-add", String(project), "--owner", owner || "@me", "--url", issue.url || ""], { cwd, ghRunner });
  return { action: "linked", project, project_item_id: null };
}

function updatePacketAfterPublish({ packet, ticketId, issue, timestamp, projectLink }) {
  const next = JSON.parse(JSON.stringify(packet));
  const ticket = findTicket(next, ticketId);
  if (!ticket) throw new Error(`Ticket not found while updating packet: ${ticketId}`);
  const externalRef = {
    kind: "github_issue",
    repo: issue.repo || null,
    issue_number: issue.number ?? null,
    title: issue.title || ticket.title || null,
    state: issue.state || null,
    url: issue.url || null,
    synced_at: timestamp,
  };
  ticket.external_refs = upsertBy(ticket.external_refs, externalRef, sameExternalRef);
  ticket.github_sync = {
    ...(ticket.github_sync && typeof ticket.github_sync === "object" ? ticket.github_sync : {}),
    last_synced_at: timestamp,
    last_issue_url: issue.url || ticket.github_sync?.last_issue_url || null,
    published_issue_number: issue.number ?? ticket.github_sync?.published_issue_number ?? null,
    project_publish: projectLink || null,
  };
  return next;
}

export async function runPublish(inputArgs, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const clock = options.clock || (() => new Date());
  const ghRunner = options.ghRunner || defaultGhRunner;
  const args = Array.isArray(inputArgs) ? parseArgs(inputArgs) : { ...inputArgs };

  if (args.command !== "publish") throw new Error(`Unknown command: ${args.command || "(missing)"}`);
  if (!args.program) throw new Error("Missing --program");
  if (!args.ticket) throw new Error("Missing --ticket");
  if (!args.repo) throw new Error("Missing --repo");
  const remoteMode = resolveRemoteMode({
    explicit: args.remoteMode,
    env,
    defaultMode: args.write ? "remote-sync" : "local-only",
  });
  if (args.write) {
    assertRemoteWriteAllowed(remoteMode, "github_ticket_review publish --write");
  }

  const timestamp = nowIso(clock);
  const target = loadTarget(cwd, args.program);
  const ticket = findTicket(target.packet, args.ticket);
  if (!ticket) throw new Error(`Ticket not found in Program Packet: ${args.ticket}`);
  const evidence = collectTicketEvidence(target.packet, ticket, { cwd });
  const title = redactText(ticket.title || `${target.packet.id || "Program"} ${ticket.id}`, env);
  const intakeDescription = loadIntakeDescription({ cwd, packetPath: target.path, ticket });
  const body = renderPublishIssueBody({ packet: target.packet, ticket, evidence, intakeDescription, env });
  const existing = existingPublishedIssue(ticket, args.repo);
  const programPacketPath = relativePath(cwd, target.path);
  const validation = validateProgramPacket(target.packet, {
    cwd,
    storyIds: collectStoryIds(cwd),
    programPacketPath: target.path,
  });
  const publishBlockers = collectDeterministicBlockers({
    validation,
    gateResults: [],
    commandResults: [],
  });
  const programContext = {
    status: publishBlockers.length > 0 ? "blocked" : "pass",
    blockers: publishBlockers,
    authority: "authoritative_at_publish",
  };

  let issue = existing ? issueFromPublishedRef(existing, args.repo) : null;
  let projectLink = { action: "skipped", reason: args.project ? "dry-run" : "No project requested" };
  let updatedPacket = null;
  let createAction = publishBlockers.length > 0 ? "blocked" : (existing ? "existing" : "planned");

  if (args.write && publishBlockers.length === 0) {
    if (!issue) {
      issue = createGithubIssue({ repo: args.repo, title, body, cwd, ghRunner });
      createAction = "created";
    }
    if (args.project) {
      projectLink = publishProjectLink({ project: args.project, issue, repo: args.repo, cwd, ghRunner });
    }
    updatedPacket = updatePacketAfterPublish({
      packet: target.packet,
      ticketId: args.ticket,
      issue,
      timestamp,
      projectLink,
    });
    writeFileSync(target.path, `${JSON.stringify(redactObject(updatedPacket, env), null, 2)}\n`, "utf-8");
  }

  const result = {
    status: publishBlockers.length > 0 ? "BLOCKED" : "PASS",
    dry_run: !args.write || publishBlockers.length > 0,
    write: !!args.write && publishBlockers.length === 0,
    write_requested: !!args.write,
    remote_mode: remoteMode,
    repo: args.repo,
    program_packet_path: programPacketPath,
    program_packet_validation: validation,
    program_context: programContext,
    ticket_id: args.ticket,
    issue: issue ? {
      action: createAction,
      number: issue.number ?? null,
      url: issue.url || null,
    } : {
      action: createAction,
      number: null,
      url: null,
    },
    project: args.project ? projectLink : null,
    planned_issue: {
      title,
      body,
    },
    ticket_intake_receipt: buildTicketIntakeReceipt({
      action: "publish",
      source: "local_program_packet",
      programPacketPath,
      ticket,
      evidence,
      deterministicStatus: publishBlockers.length > 0 ? "blocked" : "publish_ready",
      deterministicBlockers: publishBlockers,
      retroRecurrenceCheck: null,
      github: {
        repo: args.repo,
        issue_number: issue?.number ?? null,
        project_item_id: projectLink?.project_item_id || null,
        url: issue?.url || null,
        title,
      },
      sourceText: [
        ticket.title,
        ticket.problem,
        ticket.proposed_change,
        intakeDescription?.problem,
        intakeDescription?.proposed_change,
      ].filter(Boolean).join("\n\n"),
      programContext,
    }),
    packet_updated: !!updatedPacket,
  };
  return redactObject(result, env);
}

function compactText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function githubReviewBlockers(result) {
  return asArray(result?.review_packet?.deterministic?.blockers).length > 0
    ? asArray(result.review_packet.deterministic.blockers)
    : asArray(result?.ticket_intake_receipt?.deterministic_blockers);
}

function pushTopBlockers(lines, blockers, limit = 3) {
  for (const blocker of blockers.slice(0, limit)) {
    const source = blocker?.source ? `${blocker.source}: ` : "";
    const code = blocker?.code || "blocker";
    const message = blocker?.message || String(blocker || "");
    lines.push(`- ${compactText(`${source}${code} - ${message}`)}`);
  }
  if (blockers.length > limit) lines.push(`More blockers: ${blockers.length - limit} (see artifact)`);
}

function reviewArtifactLine(result) {
  if (result?.review_artifact_path) {
    const suffix = result?.dry_run ? " (planned; dry-run not written)" : "";
    return `Artifact: ${result.review_artifact_path}${suffix}`;
  }
  return `Artifact: ${result?.program_packet_path || "not written"}${result?.dry_run ? " (dry-run)" : ""}`;
}

function renderText(result) {
  const blockers = githubReviewBlockers(result);
  if (result.ticket_id) {
    const lines = [
      `Planner ticket publish: ${result.issue?.action || "planned"}`,
      `Blockers: ${blockers.length}`,
      `Ticket: ${result.ticket_id}`,
    ];
    if (result.issue?.url) lines.push(`GitHub issue: ${result.issue.url}`);
    pushTopBlockers(lines, blockers, 3);
    lines.push(reviewArtifactLine(result));
    lines.push(`Next: ${result.ticket_intake_receipt?.review_command || result.ticket_intake_receipt?.next_required_command || "run planner ticket review"}`);
    return lines.join("\n");
  }
  const lines = [
    `Planner ticket review: ${result.review_status}`,
    `Blockers: ${blockers.length}`,
    `Program packet: ${result.program_packet_path || "unknown"}`,
  ];
  const programContext = result?.review_packet?.deterministic?.program_context;
  if (programContext) {
    lines.push(`Program context: ${programContext.status || "unknown"} (${asArray(programContext.blockers).length} blocker(s))`);
  }
  pushTopBlockers(lines, blockers, 3);
  lines.push(reviewArtifactLine(result));
  lines.push(`Next: ${result.ticket_intake_receipt?.next_required_command || "inspect artifact or rerun with --json"}`);
  return lines.join("\n");
}

function writeTerminal(stream, text) {
  return new Promise((resolveWrite, rejectWrite) => {
    const onError = (error) => {
      stream.off("error", onError);
      rejectWrite(error);
    };
    stream.once("error", onError);
    stream.write(text, () => {
      stream.off("error", onError);
      resolveWrite();
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    await writeTerminal(process.stderr, `${error.message}\n${usage()}\n`);
    return 2;
  }
  if (["help", "--help", "-h"].includes(args.command)) {
    await writeTerminal(process.stdout, `${usage()}\n`);
    return 0;
  }
  try {
    if (args.command !== "review" && args.command !== "publish") {
      throw new Error(`Unknown command: ${args.command || "(missing)"}`);
    }
    const result = args.command === "publish"
      ? await runPublish(args)
      : await runReview(args);
    await writeTerminal(
      process.stdout,
      `${args.json ? JSON.stringify(result, null, 2) : renderText(result)}\n`,
    );
    return verificationStatusIsPass(result.status, "execution") ? 0 : 1;
  } catch (error) {
    const payload = { status: "FAIL", error: error?.message || String(error) };
    await writeTerminal(
      args?.json ? process.stdout : process.stderr,
      `${args?.json ? JSON.stringify(payload, null, 2) : `${payload.error}\n\n${usage()}`}\n`,
    );
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Await terminal stream callbacks so large --json review packets are complete
  // before explicit exit, including through nonblocking bounded pipes.
  main().then((code) => process.exit(code));
}

export {
  defaultGhRunner,
  defaultGitRunner,
  fetchIssue,
  fetchProjectItem,
  parseArgs,
  renderText,
  renderReviewComment,
  resolveRepo,
};
