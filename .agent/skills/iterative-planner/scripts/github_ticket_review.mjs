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
import {
  callOpenAiCompatibleJson,
  loadDriftLlmConfig,
  publicDriftConfig,
  redactSecrets,
} from "./lib/llm_drift_client.mjs";
import {
  evaluateRetroRecurrenceCheck,
  recurrenceCheckToBlockers,
} from "./lib/retro_recurrence_check.mjs";
import {
  evaluateQuantPersonaGate,
  quantPersonaGateToBlockers,
} from "./lib/quant_persona_gate.mjs";
import {
  buildDeepSeekAdvisoryBlock,
  DEEPSEEK_VERBATIM_REPRODUCTION_CONTRACT,
} from "./lib/deepseek_advisory_block.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptDir = __dirname;
const repoScriptPrefix = ".agent/skills/iterative-planner/scripts";

export const TICKET_REVIEW_STATUSES = Object.freeze([
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

function normalizeStatus(value, fallback = "unavailable") {
  const normalized = String(value || "").trim().toLowerCase();
  return TICKET_REVIEW_STATUSES.includes(normalized) ? normalized : fallback;
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
    write: false,
    json: false,
    closeGithubIssue: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--issue") parsed.issue = args[++i] || null;
    else if (arg === "--project-item") parsed.projectItem = args[++i] || null;
    else if (arg === "--program") parsed.program = args[++i] || null;
    else if (arg === "--ticket") parsed.ticket = args[++i] || null;
    else if (arg === "--repo") parsed.repo = args[++i] || null;
    else if (arg === "--project") parsed.project = args[++i] || null;
    else if (arg === "--write") parsed.write = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--close-github-issue") parsed.closeGithubIssue = true;
    else if (arg === "--help" || arg === "-h") parsed.command = "help";
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function usage() {
  return `github_ticket_review.mjs — Review GitHub tickets against planner evidence

Usage:
  node github_ticket_review.mjs review --issue <n> --program <program-id-or-path> --ticket <ticket-id> [--repo <owner/repo>] [--write] [--json]
  node github_ticket_review.mjs review --project-item <node-id-or-url> --program <program-id-or-path> --ticket <ticket-id> [--repo <owner/repo>] [--write] [--json]
  node github_ticket_review.mjs publish --program <program-id-or-path> --ticket <ticket-id> --repo <owner/repo> [--project <id/url>] [--write] [--json]

Safety:
  Dry-run is the default. --write is required for Program Packet edits, review artifacts,
  GitHub comments, labels, project status updates, or issue close attempts.
  GitHub issues are never closed unless --close-github-issue is also passed.`;
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
  const comments = asArray(raw?.comments).map((comment) => ({
    id: comment?.id || comment?.databaseId || null,
    url: comment?.url || null,
    body: comment?.body || "",
    author: comment?.author?.login || comment?.author || null,
  }));
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

function findTicket(packet, ticketId) {
  return asArray(packet?.tickets).find((ticket) => asString(ticket?.id) === ticketId) || null;
}

function collectTicketEvidence(packet, ticket) {
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
  return { title, body };
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
  deepseekAdvisoryStatus,
  deepseekAdvisory,
  github,
  reviewArtifactPath,
  retroRecurrenceCheck,
  quantPersonaGate,
}) {
  const blockers = asArray(deterministicBlockers);
  const recurrence = retroRecurrenceCheck || null;
  const quantGate = quantPersonaGate || null;
  const advisoryStatus = deepseekAdvisory?.status || deepseekAdvisoryStatus || "not_run";
  const advisoryBlock = deepseekAdvisory ? buildDeepSeekAdvisoryBlock(deepseekAdvisory) : null;
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
    retro_recurrence_status: recurrence?.status || "not_run",
    retro_recurrence_blocking_count: recurrence?.summary?.blocking_count || 0,
    retro_recurrence_advisory_count: recurrence?.summary?.advisory_count || 0,
    quant_persona_gate_status: quantGate?.status || "not_run",
    quant_persona_gate_required: quantGate?.required === true,
    quant_persona_gate_missing_count: quantGate?.summary?.missing_guard_count || 0,
    deepseek_advisory_status: advisoryStatus,
    deepseek_advisory_block: advisoryBlock,
    verbatim_reproduction_contract: advisoryBlock ? DEEPSEEK_VERBATIM_REPRODUCTION_CONTRACT : null,
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

function normalizeAdvisoryPayload(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  return {
    status: normalizeStatus(payload.status || payload.classification, "unavailable"),
    summary: typeof payload.summary === "string" ? payload.summary : "",
    findings: asArray(payload.findings).map((finding, index) => ({
      id: asString(finding?.id) || `DS-${String(index + 1).padStart(3, "0")}`,
      status: normalizeStatus(finding?.status || finding?.classification, "fresh"),
      message: asString(finding?.message || finding?.reason || finding?.summary),
      evidence_refs: asArray(finding?.evidence_refs).map(asString).filter(Boolean),
    })),
    recommended_actions: asArray(payload.recommended_actions || payload.recommended_follow_up).map(asString).filter(Boolean),
  };
}

async function runDeepSeekAdvisory({ reviewPacket, cwd, env, fetchImpl }) {
  const config = loadDriftLlmConfig(env, { cwd });
  const publicConfig = publicDriftConfig(config);
  const system = [
    "You are an advisory reviewer for a planner ticket review packet.",
    "Return JSON only with: status, summary, findings, recommended_actions.",
    `Allowed status values: ${TICKET_REVIEW_STATUSES.filter((status) => status !== "unavailable").join(", ")}.`,
    "Deterministic checks are authoritative; do not claim verified or closed.",
    "If quant_persona_gate is required and blocked, classify the ticket as blocked or needs_verification; never call it review_ready.",
  ].join(" ");
  try {
    const response = await callOpenAiCompatibleJson({
      config,
      env,
      fetchImpl,
      maxTokens: 1400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(redactObject(reviewPacket, env)) },
      ],
    });
    return {
      available: true,
      config: publicConfig,
      source: response.source || "provider",
      raw_excerpt: response.raw_excerpt || "",
      ...normalizeAdvisoryPayload(response.parsed),
    };
  } catch (error) {
    return {
      available: false,
      status: "unavailable",
      summary: `DeepSeek advisory unavailable: ${error?.message || "unknown error"}`,
      findings: [],
      recommended_actions: [],
      config: publicConfig,
    };
  }
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
  const externalRef = externalRefForIssue(issue, timestamp);
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
    labels_applied: sync?.labels_applied || [],
    project_status: sync?.project_status || null,
  };
  ticket.last_review_status = finalStatus;
  return next;
}

function lifecycleLabels(finalStatus, ticket) {
  const labels = new Set();
  labels.add(finalStatus === "blocked" ? "planner:blocked" : "planner:review-ready");
  const lifecycle = normalizeToken(ticket?.lifecycle);
  if (lifecycle) labels.add(`planner:ticket-${lifecycle.replaceAll("_", "-")}`);
  return [...labels];
}

function markerFor(ticketId) {
  return `<!-- planner-ticket-review:${ticketId} -->`;
}

function renderReviewComment(reviewPacket, { env = process.env } = {}) {
  const blockers = asArray(reviewPacket.deterministic?.blockers);
  const recurrence = reviewPacket.retro_recurrence_check || reviewPacket.deterministic?.retro_recurrence_check || null;
  const recurrenceMatches = asArray(recurrence?.matches);
  const quantGate = reviewPacket.quant_persona_gate || reviewPacket.deterministic?.quant_persona_gate || null;
  const advisoryBlock = reviewPacket.ticket_intake_receipt?.deepseek_advisory_block || null;
  const lines = [
    markerFor(reviewPacket.ticket?.id || "unknown"),
    "### Planner Ticket Review",
    "",
    `Status: **${reviewPacket.final_status}**`,
    `Program: \`${reviewPacket.program?.id || "unknown"}\``,
    `Ticket: \`${reviewPacket.ticket?.id || "unknown"}\``,
    `DeepSeek advisory: \`${reviewPacket.deepseek_advisory?.status || "unavailable"}\``,
    "",
    "Deterministic checks are authoritative. DeepSeek is advisory only.",
    "",
  ];
  if (advisoryBlock) {
    lines.push("DeepSeek advisory verdict:");
    lines.push("");
    lines.push(advisoryBlock);
    lines.push("");
  }
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

function syncIssueComment({ issue, ticketId, body, cwd, repo, ghRunner }) {
  if (!issue?.number) return { action: "skipped", reason: "No linked issue number" };
  const existing = findExistingReviewComment(issue, ticketId);
  if (existing?.id) {
    const { owner, name } = splitRepo(repo);
    if (!owner || !name) return { action: "skipped", reason: "Cannot update comment without owner/repo" };
    ghWrite(["api", `repos/${owner}/${name}/issues/comments/${existing.id}`, "-X", "PATCH", "-f", `body=${body}`], { cwd, ghRunner });
    return { action: "updated", comment_url: existing.url || null };
  }
  const result = ghWrite(["issue", "comment", String(issue.number), "--repo", repo, "--body", body], { cwd, ghRunner });
  return { action: "created", comment_url: asString(result.stdout) || null };
}

function syncLabels({ issue, labels, cwd, repo, ghRunner }) {
  if (!issue?.number || labels.length === 0) return { action: "skipped", labels: [] };
  ghWrite(["issue", "edit", String(issue.number), "--repo", repo, "--add-label", labels.join(",")], { cwd, ghRunner });
  return { action: "updated", labels };
}

function desiredProjectStatus(finalStatus) {
  return finalStatus === "blocked" ? ["Blocked", "Planner Blocked"] : ["Review Ready", "Ready for Review", "Planner Review Ready"];
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

function syncGithub({ issue, ticket, reviewPacket, args, cwd, repo, ghRunner, env }) {
  const body = renderReviewComment(reviewPacket, { env });
  const labels = lifecycleLabels(reviewPacket.final_status, ticket);
  const comment = syncIssueComment({ issue, ticketId: ticket.id, body, cwd, repo, ghRunner });
  const labelResult = syncLabels({ issue, labels, cwd, repo, ghRunner });
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
    labels: labelResult,
    labels_applied: labelResult.labels || [],
    project_status: projectStatus,
    close,
    comment_body: body,
  };
}

function buildInitialReviewPacket({ issue, packet, packetPath, ticket, ticketEvidence, validation, gateResults, commandResults, blockers, recurrenceCheck, quantPersonaGate, timestamp, artifactRelPath }) {
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
      program_packet_validation: validation,
      program_gates: gateResults,
      command_results: commandResults,
    },
    deepseek_advisory: {
      status: "unavailable",
      summary: "not_run",
      findings: [],
      recommended_actions: [],
    },
    final_status: blockers.length > 0 ? "blocked" : "review_ready",
    artifact: {
      path: artifactRelPath,
    },
  };
}

function writeReviewOutputs({ cwd, packetPath, packet, reviewPacket, artifactPath, ticketId, issue, sync, timestamp, env }) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const redactedPacket = redactObject(reviewPacket, env);
  writeFileSync(artifactPath, `${JSON.stringify(redactedPacket, null, 2)}\n`, "utf-8");
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
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const args = Array.isArray(inputArgs) ? parseArgs(inputArgs) : { ...inputArgs };

  if (args.command !== "review") throw new Error(`Unknown command: ${args.command || "(missing)"}`);
  if (!args.program) throw new Error("Missing --program");
  if (!args.ticket) throw new Error("Missing --ticket");
  if (!!args.issue === !!args.projectItem) throw new Error("Pass exactly one of --issue or --project-item");

  const repo = resolveRepo(cwd, args.repo, gitRunner);
  if (!repo) throw new Error("Cannot determine GitHub repo; pass --repo <owner/repo>");
  const timestamp = nowIso(clock);
  const issue = args.issue
    ? fetchIssue(args.issue, { cwd, repo, ghRunner })
    : fetchProjectItem(args.projectItem, { cwd, repo, ghRunner });
  const target = loadTarget(cwd, args.program);
  const ticket = findTicket(target.packet, args.ticket);
  if (!ticket) throw new Error(`Ticket not found in Program Packet: ${args.ticket}`);

  const storyIds = collectStoryIds(cwd);
  const validation = validateProgramPacket(target.packet, { cwd, storyIds });
  const gateResults = relevantProgramGates(target.packet.status).map((gate) => evaluateProgramGate(target.packet, gate, { cwd, storyIds }));
  const ticketEvidence = collectTicketEvidence(target.packet, ticket);
  const commandResults = runDeterministicCommands({
    cwd,
    packet: target.packet,
    programPath: target.path,
    storyRefs: ticketEvidence.story_refs,
    commandRunner,
    env,
  });
  const recurrenceCheck = evaluateRetroRecurrenceCheck({
    cwd,
    sourceText: [issue.title, issue.body].filter(Boolean).join("\n\n"),
    packet: target.packet,
    ticket,
    acceptanceCriteria: ticketEvidence.acceptance_criteria,
    verificationRows: ticketEvidence.verification_rows,
    commandResults,
    reviewArtifacts: ticket.review_artifacts,
    env,
  });
  const quantPersonaGate = evaluateQuantPersonaGate({
    sourceText: [issue.title, issue.body].filter(Boolean).join("\n\n"),
    packet: target.packet,
    ticket,
    acceptanceCriteria: ticketEvidence.acceptance_criteria,
    verificationRows: ticketEvidence.verification_rows,
    changedFiles: ticketEvidence.changed_files,
    reviewArtifacts: ticket.review_artifacts,
  });
  const blockers = [
    ...collectDeterministicBlockers({ validation, gateResults, commandResults }),
    ...recurrenceCheckToBlockers(recurrenceCheck),
    ...quantPersonaGateToBlockers(quantPersonaGate),
  ];
  const artifactPath = reviewArtifactPath(target.path, args.ticket);
  const artifactRelPath = relativePath(cwd, artifactPath);
  let reviewPacket = buildInitialReviewPacket({
    issue,
    packet: target.packet,
    packetPath: relativePath(cwd, target.path),
    ticket,
    ticketEvidence,
    validation,
    gateResults,
    commandResults,
    blockers,
    recurrenceCheck,
    quantPersonaGate,
    timestamp,
    artifactRelPath,
  });

  const advisory = await runDeepSeekAdvisory({ reviewPacket, cwd, env, fetchImpl });
  reviewPacket = {
    ...reviewPacket,
    deepseek_advisory: advisory,
    final_status: reviewPacket.deterministic.status,
  };
  reviewPacket.ticket_intake_receipt = buildTicketIntakeReceipt({
    action: "review",
    source: issue.project_item?.id ? "github_project_item" : "github_issue",
    programPacketPath: relativePath(cwd, target.path),
    ticket,
    evidence: ticketEvidence,
    deterministicStatus: reviewPacket.final_status,
    deterministicBlockers: reviewPacket.deterministic.blockers,
    deepseekAdvisoryStatus: advisory.status,
    deepseekAdvisory: advisory,
    retroRecurrenceCheck: recurrenceCheck,
    quantPersonaGate,
    github: {
      repo,
      issue_number: issue.number,
      project_item_id: issue.project_item?.id || null,
      url: issue.url,
      title: issue.title,
    },
    reviewArtifactPath: artifactRelPath,
  });

  let githubSync = {
    mode: args.write ? "write" : "dry_run",
    planned_comment: renderReviewComment(reviewPacket, { env }),
    labels_applied: [],
    project_status: null,
  };
  let updatedPacket = null;
  if (args.write) {
    githubSync = syncGithub({ issue, ticket, reviewPacket, args, cwd, repo, ghRunner, env });
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
    close_github_issue: !!args.closeGithubIssue,
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

function renderPublishIssueBody({ packet, ticket, evidence, intakeDescription = null, env = process.env }) {
  const title = asString(ticket.title) || "Program ticket";
  const lines = [
    publishMarker(ticket.id || "unknown"),
    `## ${title}`,
    "",
  ];
  const descriptionBody = markdownBlock(intakeDescription?.body);
  if (descriptionBody) lines.push(descriptionBody, "");
  lines.push(
    "---",
    "",
    `*Planner: Program \`${packet.id || "unknown"}\` | Ticket \`${ticket.id || "unknown"}\` | Lifecycle \`${ticket.lifecycle || "proposed"}\`*`,
    "*Deterministic Program Packet evidence remains authoritative. GitHub is a collaboration mirror.*",
  );
  const storyRefs = uniqueStrings(evidence.story_refs);
  const gapRefs = uniqueStrings(evidence.gap_refs);
  if (storyRefs.length > 0) lines.push(`*Story refs: ${storyRefs.map((id) => `\`${id}\``).join(", ")}*`);
  if (gapRefs.length > 0) lines.push(`*Gap refs: ${gapRefs.map((id) => `\`${id}\``).join(", ")}*`);
  if (evidence.acceptance_criteria.length > 0) {
    lines.push("", "### Acceptance Criteria");
    for (const criterion of evidence.acceptance_criteria.slice(0, 8)) {
      lines.push(`- \`${criterion.id}\`: ${criterion.text || criterion.summary || "Acceptance criterion"}`);
    }
  }
  if (evidence.verification_rows.length > 0) {
    lines.push("", "### Verification Rows");
    for (const row of evidence.verification_rows.slice(0, 8)) {
      lines.push(`- \`${row.id}\`: ${row.command_or_action || row.proof_type || "Verification row"}`);
    }
  }
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

  const timestamp = nowIso(clock);
  const target = loadTarget(cwd, args.program);
  const ticket = findTicket(target.packet, args.ticket);
  if (!ticket) throw new Error(`Ticket not found in Program Packet: ${args.ticket}`);
  const evidence = collectTicketEvidence(target.packet, ticket);
  const title = redactText(ticket.title || `${target.packet.id || "Program"} ${ticket.id}`, env);
  const intakeDescription = loadIntakeDescription({ cwd, packetPath: target.path, ticket });
  const body = renderPublishIssueBody({ packet: target.packet, ticket, evidence, intakeDescription, env });
  const existing = existingPublishedIssue(ticket, args.repo);
  const programPacketPath = relativePath(cwd, target.path);

  let issue = existing ? issueFromPublishedRef(existing, args.repo) : null;
  let projectLink = { action: "skipped", reason: args.project ? "dry-run" : "No project requested" };
  let updatedPacket = null;
  let createAction = existing ? "existing" : "planned";

  if (args.write) {
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
    status: "PASS",
    dry_run: !args.write,
    write: !!args.write,
    repo: args.repo,
    program_packet_path: programPacketPath,
    ticket_id: args.ticket,
    issue: issue ? {
      action: createAction,
      number: issue.number ?? null,
      url: issue.url || null,
    } : {
      action: "planned",
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
      deterministicStatus: "not_run_publish_only",
      deterministicBlockers: [],
      deepseekAdvisoryStatus: "not_run",
      retroRecurrenceCheck: null,
      github: {
        repo: args.repo,
        issue_number: issue?.number ?? null,
        project_item_id: projectLink?.project_item_id || null,
        url: issue?.url || null,
        title,
      },
    }),
    packet_updated: !!updatedPacket,
  };
  return redactObject(result, env);
}

function renderText(result) {
  if (result.ticket_id) {
    return [
      `Planner ticket publish: ${result.issue?.action || "planned"}`,
      `Mode: ${result.dry_run ? "dry-run" : "write"}`,
      `Program packet: ${result.program_packet_path}`,
      `Ticket: ${result.ticket_id}`,
      `Ticket Intake Receipt: ${result.ticket_intake_receipt?.deterministic_status || "not_run_publish_only"}`,
      result.issue?.url ? `GitHub issue: ${result.issue.url}` : null,
    ].filter(Boolean).join("\n");
  }
  const lines = [
    `Planner ticket review: ${result.review_status}`,
    `Mode: ${result.dry_run ? "dry-run" : "write"}`,
    `Program packet: ${result.program_packet_path}`,
    `Review packet: ${result.review_artifact_path}`,
    `Ticket Intake Receipt: ${result.ticket_intake_receipt?.deterministic_status || "unknown"}`,
  ];
  const blockers = asArray(result.review_packet?.deterministic?.blockers);
  const receipt = result.ticket_intake_receipt || null;
  if (receipt?.deepseek_advisory_block) {
    lines.push("");
    lines.push("DeepSeek advisory (REPRODUCE VERBATIM in your reply to the user):");
    lines.push(receipt.deepseek_advisory_block);
    if (receipt.verbatim_reproduction_contract) {
      lines.push("");
      lines.push(`Contract: ${receipt.verbatim_reproduction_contract}`);
    }
  }
  if (blockers.length > 0) {
    lines.push("Blockers:");
    for (const blocker of blockers.slice(0, 8)) {
      lines.push(`- ${blocker.source}: ${blocker.code} — ${blocker.message}`);
    }
  }
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }
  if (["help", "--help", "-h"].includes(args.command)) {
    console.log(usage());
    return 0;
  }
  try {
    if (args.command !== "review" && args.command !== "publish") {
      throw new Error(`Unknown command: ${args.command || "(missing)"}`);
    }
    const result = args.command === "publish"
      ? await runPublish(args)
      : await runReview(args);
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 0;
  } catch (error) {
    const payload = { status: "FAIL", error: error?.message || String(error) };
    if (args?.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`${payload.error}\n\n${usage()}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
