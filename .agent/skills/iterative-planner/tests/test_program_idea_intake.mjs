#!/usr/bin/env node
// test_program_idea_intake.mjs — Program Manager idea-to-ticket intake contracts.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { runIntake } from "../scripts/program_manager.mjs";
import { extractNormalizedStoryIdsFromText } from "../scripts/lib/planner_canonicalizer.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const cliPath = join(testDir, "..", "scripts", "program_manager.mjs");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function makeTemp() {
  return mkdtempSync(join(tmpdir(), "program-idea-intake-"));
}

function baseProgram(overrides = {}) {
  return {
    version: 1,
    id: "PGM-INTAKE",
    title: "Idea Intake Fixture",
    status: "design",
    goal: "Turn broad ideas into traceable Program Packet tickets.",
    story_refs: ["US-001"],
    epics: [
      {
        id: "EP-001",
        title: "Backlog intake",
        story_refs: ["US-001"],
        ticket_refs: [],
      },
    ],
    tickets: [],
    acceptance_criteria: [],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [],
    decisions: [],
    ...overrides,
  };
}

function writeProgram(tmp, packet = baseProgram()) {
  const dir = join(tmp, "plans", "programs", packet.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "program_packet.json");
  writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function issueFixture(body = "Issue body") {
  return {
    number: 17,
    title: "Evaluate market intake",
    body,
    state: "OPEN",
    url: "https://github.com/owner/repo/issues/17",
    labels: [{ name: "idea" }],
    comments: [],
  };
}

function projectItemFixture() {
  return {
    data: {
      node: {
        id: "PVTI_intake",
        type: "ISSUE",
        project: { id: "PVT_project", title: "Planner Project", url: "https://github.com/orgs/owner/projects/1" },
        content: {
          __typename: "Issue",
          number: 17,
          title: "Evaluate project item intake",
          body: "Project issue body US-079",
          state: "OPEN",
          url: "https://github.com/owner/repo/issues/17",
          repository: { name: "repo", owner: { login: "owner" } },
          labels: { nodes: [{ name: "idea" }] },
        },
        fieldValues: { nodes: [] },
      },
    },
  };
}

function createFakeGh({ issue = issueFixture(), projectItem = projectItemFixture() } = {}) {
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    const key = args.join(" ");
    if (args[0] === "issue" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify(issue), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "graphql" && key.includes("ProjectV2Item")) {
      return { status: 0, stdout: JSON.stringify(projectItem), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `Unexpected gh call: ${key}` };
  };
  return { runner, calls };
}

const mockReviewReadyEnv = {
  PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    status: "review_ready",
    summary: "Advisory review says the intake is ready to discuss.",
    findings: [],
    recommended_actions: [],
  }),
};

console.log("\nProgram Idea Intake Contracts\n");

{
  const ids = extractNormalizedStoryIdsFromText("US079, us-hfc-001, US_HFOPP_004, and USER123 should not be a story");
  assert(ids.includes("US-079"), "canonicalizer extracts compact numeric story refs");
  assert(ids.includes("US-HFC-001"), "canonicalizer extracts family-qualified story refs");
  assert(ids.includes("US-HFOPP-004"), "canonicalizer extracts five-letter family story refs");
  assert(!ids.includes("USER-123") && !ids.includes("USER123"), "canonicalizer ignores unrelated prose tokens");
}

{
  const schemaPath = join(testDir, "..", "config", "program_packet.schema.json");
  const schema = readJson(schemaPath);
  const kindEnum = schema.properties.tickets.items.properties.external_refs.items.properties.kind.enum;
  assert(kindEnum.includes("github_issue"), "schema allows GitHub issue external refs");
  assert(kindEnum.includes("github_project_item"), "schema allows GitHub Project item external refs");
  assert(kindEnum.includes("local_file"), "schema allows local file intake refs");
  assert(kindEnum.includes("local_text"), "schema allows local text intake refs");
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const before = readFileSync(programPath, "utf-8");
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "Explore a new market monitoring idea without a story yet",
      "--json",
    ], { cwd: tmp, env: mockReviewReadyEnv });

    assert(result.dry_run === true, "text intake defaults to dry-run");
    assert(result.candidate_ticket.lifecycle === "proposed", "intake tickets start proposed");
    assert(result.gap_refs.length === 1, "missing story creates a gap ref instead of ready status");
    assert(result.ticket_intake_receipt.name === "Ticket Intake Receipt", "text intake emits a Ticket Intake Receipt");
    assert(result.ticket_intake_receipt.front_door === "/program-manager", "intake receipt records the Program Manager front door");
    assert(result.ticket_intake_receipt.ticket_id === result.candidate_ticket.id, "intake receipt records the candidate ticket id");
    assert(result.ticket_intake_receipt.deterministic_status === result.intake_packet.final_status, "intake receipt reflects deterministic intake status");
    assert(result.ticket_intake_receipt.direct_github_creation_allowed === false, "intake receipt forbids direct GitHub creation");
    assert(readFileSync(programPath, "utf-8") === before, "dry-run does not edit Program Packet");
    assert(!existsSync(join(tmp, result.intake_artifact_path)), "dry-run does not write intake artifact");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const help = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert(help.status === 0, "program_manager.mjs --help exits cleanly");
  assert(help.stdout.includes(" init "), "--help documents init");
  assert(help.stdout.includes("--title"), "--help documents --title");
  assert(help.stdout.includes("--from-json-array"), "--help documents --from-json-array");
  assert(help.stdout.includes("--ticket-type"), "--help documents --ticket-type");
  assert(help.stdout.includes("--persona-review"), "--help documents --persona-review");
  assert(help.stdout.includes("--persona-packs"), "--help documents --persona-packs");
  assert(help.stdout.includes("--auto-story"), "--help documents --auto-story");
  assert(help.stdout.includes("--remediate"), "--help documents --remediate");
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const args = [
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-HFC-001: Add idea-to-ticket triage for broad prompts",
      "--write",
      "--json",
    ];
    const first = await runIntake(args, { cwd: tmp, env: mockReviewReadyEnv });
    const second = await runIntake(args, { cwd: tmp, env: mockReviewReadyEnv });
    const packet = readJson(programPath);

    assert(first.packet_updated && second.packet_updated, "--write updates the local Program Packet");
    assert(existsSync(join(tmp, first.intake_artifact_path)), "--write writes a local intake artifact");
    assert(packet.tickets.length === 1, "repeated write upserts instead of duplicating tickets");
    assert(packet.acceptance_criteria.length === 1, "repeated write upserts acceptance criteria");
    assert(packet.verification_matrix.length === 1, "repeated write upserts verification rows");
    assert(packet.tickets[0].story_refs.includes("US-HFC-001"), "family-qualified story refs are extracted from source text");
    assert(packet.tickets[0].gap_refs.length === 0, "story-backed text intake does not create a gap ref");
    assert(packet.tickets[0].external_refs.some((ref) => ref.kind === "local_text"), "text intake records a local text external ref");
    assert(first.ticket_intake_receipt.story_refs.includes("US-HFC-001"), "intake receipt carries story refs");
    assert(first.ticket_intake_receipt.acceptance_criteria_refs.includes(first.acceptance_criteria[0].id), "intake receipt carries acceptance criteria refs");
    assert(first.ticket_intake_receipt.verification_refs.includes(first.verification_rows[0].id), "intake receipt carries verification refs");
    assert(first.ticket_intake_receipt.deterministic_status === "proposed", "story-backed intake receipt stays proposed, not ready");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const longUnformatted = "US-079: Add a sprawling and unformatted Program Manager roadmap intake paragraph that would previously become an unreadable ticket title because no newline separated title from body";
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      longUnformatted,
      "--json",
    ], {
      cwd: tmp,
      env: {
        PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
          title: "Concise Intake Title",
          status: "review_ready",
          summary: "Title summarized",
          findings: [],
          recommended_actions: [],
        }),
      },
    });

    assert(result.candidate_ticket.title === "Concise Intake Title", "long derived title uses LLM summary");
    assert(!result.candidate_ticket.title.includes("[truncated"), "smart title summary avoids truncation markers");
    assert(result.intake_packet.source.title_summary.status === "summarized", "intake packet records title summary provenance");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const registryDir = join(tmp, "reports", "user_story_audit");
    mkdirSync(registryDir, { recursive: true });
    const registryPath = join(registryDir, "story_registry.json");
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      updated: "2026-05-18T00:00:00.000Z",
      stories: [],
      consolidations: [],
    }, null, 2), "utf-8");
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "Add automatic Program Manager story creation for storyless intake",
      "--auto-story",
      "--write",
      "--json",
    ], {
      cwd: tmp,
      env: {
        PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
          status: "review_ready",
          summary: "Draft story candidate found",
          story_candidates: [{
            title: "Automatic Intake Story Creation",
            user: "program operator",
            need: "storyless intake to create draft story links",
            outcome: "the ticket carries traceability without manual registry editing",
            acceptance_criteria: ["Draft story is linked to the ticket"],
            tags: ["traceability"],
          }],
          findings: [],
          recommended_actions: [],
        }),
      },
    });
    const packet = readJson(programPath);
    const registry = readJson(registryPath);
    const story = registry.stories[0];

    assert(result.auto_story.status === "drafted", "--auto-story reports drafted status");
    assert(story.id.startsWith("US-PM-AUTO-"), "--auto-story writes a generated story id");
    assert(story.status === "NOT_IMPLEMENTED", "--auto-story writes a valid backlog story status");
    assert(story.generated_from.review_status === "draft_review_needed", "--auto-story marks generated story as draft review-needed");
    assert(packet.tickets[0].story_refs.includes(story.id), "--auto-story links generated story to ticket");
    assert(packet.tickets[0].gap_refs.length === 0, "--auto-story avoids needs-story gap when a draft story is linked");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-079: This first line should not become the ticket title because the explicit title wins even when the body is long and unformatted",
      "--title",
      "Explicit intake title",
      "--json",
    ], { cwd: tmp, env: mockReviewReadyEnv });

    assert(result.candidate_ticket.title === "Explicit intake title", "--title overrides first-line title extraction");
    assert(result.intake_packet.source.text.includes("first line should not become"), "--title does not replace the source text body");
    assert(result.ticket_intake_receipt.ticket_title === "Explicit intake title", "intake receipt carries the explicit title");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-079: Explore a quant model target without making a result claim",
      "--ticket-type",
      "quant_exploration",
      "--persona-review",
      "--json",
    ], { cwd: tmp, env: mockReviewReadyEnv });

    assert(result.candidate_ticket.ticket_type === "quant_exploration", "--ticket-type records specialized ticket lane");
    assert(result.candidate_ticket.type === "research", "--ticket-type maps to schema-safe base ticket type");
    assert(result.candidate_ticket.persona_packs.includes("quant_target"), "persona review attaches default quant persona packs");
    assert(result.persona_review.status === "needs_evidence", "--persona-review builds advisory review metadata");
    assert(result.ticket_intake_receipt.ticket_type === "quant_exploration", "intake receipt carries specialized ticket type");
    assert(result.ticket_intake_receipt.base_ticket_type === "research", "intake receipt carries schema-safe base ticket type");
    assert(result.ticket_intake_receipt.persona_review_status === "needs_evidence", "intake receipt carries persona review status");
    assert(result.ticket_intake_receipt.persona_packs.includes("quant_target"), "intake receipt carries persona packs");
    assert(result.intake_packet.source.ticket_type === "quant_exploration", "intake packet source records ticket type");
    assert(result.intake_packet.persona_review.ticket_type === "quant_exploration", "intake packet records persona review block");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const sourcePath = join(tmp, "idea.md");
    writeFileSync(sourcePath, "# US-HFOPP-004 File-backed intake\n\nAcceptance should be explicit.\n", "utf-8");
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-file",
      sourcePath,
      "--write",
      "--json",
    ], { cwd: tmp, env: mockReviewReadyEnv });

    assert(result.story_refs.includes("US-HFOPP-004"), "file intake extracts five-letter family story refs");
    assert(readJson(programPath).tickets[0].external_refs.some((ref) => ref.kind === "local_file"), "file intake records a local external ref");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const tickets = [
      {
        id: "bulk-alpha",
        title: "Bulk alpha ticket",
        text: "US-079: Add explicit title handling for Program Manager intake.",
        type: "quant_exploration",
        persona_review: true,
      },
      {
        id: "bulk-beta",
        title: "Bulk beta ticket",
        text: "US-079: Add multi-ticket JSON array ingestion for Program Manager intake.",
        ticket_type: "code_refactor",
        persona_packs: ["wiring_auditor", "config_integrity"],
        persona_review: true,
      },
    ];
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-json-array",
      JSON.stringify(tickets),
      "--write",
      "--json",
    ], { cwd: tmp, env: mockReviewReadyEnv });
    const packet = readJson(programPath);

    assert(result.mode === "bulk", "--from-json-array returns a bulk intake result");
    assert(result.ticket_count === 2, "bulk intake reports two ticket results");
    assert(result.results.length === 2, "bulk intake preserves per-ticket result details");
    assert(packet.tickets.length === 2, "--from-json-array --write adds multiple Program Packet tickets");
    assert(packet.acceptance_criteria.length === 2, "bulk intake writes acceptance criteria per ticket");
    assert(packet.verification_matrix.length === 2, "bulk intake writes verification rows per ticket");
    assert(packet.tickets.some((ticket) => ticket.title === "Bulk alpha ticket"), "bulk intake uses item title for first ticket");
    assert(packet.tickets.some((ticket) => ticket.title === "Bulk beta ticket"), "bulk intake uses item title for second ticket");
    assert(packet.tickets.some((ticket) => ticket.ticket_type === "quant_exploration" && ticket.type === "research"), "bulk intake supports quant exploration ticket lane");
    assert(packet.tickets.some((ticket) => ticket.ticket_type === "code_refactor" && ticket.type === "refactor"), "bulk intake supports code refactor ticket lane");
    assert(packet.tickets.find((ticket) => ticket.ticket_type === "code_refactor")?.persona_packs.includes("config_integrity"), "bulk intake supports per-item persona packs");
    assert(result.ticket_types.includes("quant_exploration") && result.ticket_types.includes("code_refactor"), "bulk result exposes ticket types");
    assert(result.persona_review_statuses.every((status) => status === "needs_evidence"), "bulk result exposes persona review statuses");
    assert(result.ticket_intake_receipts.length === 2, "bulk intake emits one receipt per ticket");
    assert(result.ticket_intake_receipts.some((receipt) => receipt.ticket_type === "code_refactor" && receipt.base_ticket_type === "refactor"), "bulk receipts expose mixed ticket lanes");
    assert(result.intake_artifact_paths.every((path) => existsSync(join(tmp, path))), "bulk intake writes one artifact per ticket");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const fakeGh = createFakeGh({ issue: issueFixture("US-079 issue body") });
    await runIntake([
      "intake",
      "--program",
      programPath,
      "--issue",
      "17",
      "--repo",
      "owner/repo",
      "--write",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, env: mockReviewReadyEnv });
    const ticket = readJson(programPath).tickets[0];

    assert(ticket.external_refs.some((ref) => ref.kind === "github_issue" && ref.issue_number === 17), "issue intake records a GitHub issue external ref");
    assert(fakeGh.calls.some((args) => args[0] === "issue" && args[1] === "view"), "issue intake fetches the GitHub issue");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const fakeGh = createFakeGh();
    await runIntake([
      "intake",
      "--program",
      programPath,
      "--project-item",
      "PVTI_intake",
      "--repo",
      "owner/repo",
      "--write",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, env: mockReviewReadyEnv });
    const ticket = readJson(programPath).tickets[0];

    assert(ticket.external_refs.some((ref) => ref.kind === "github_project_item" && ref.project_item_id === "PVTI_intake"), "project item intake records a Project item external ref");
    assert(fakeGh.calls.some((args) => args[0] === "api" && args[1] === "graphql"), "project item intake fetches project item data");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-079: DeepSeek may critique this, but cannot promote lifecycle",
      "--llm-review",
      "--json",
    ], { cwd: tmp, env: mockReviewReadyEnv });

    assert(result.deepseek_advisory.status === "review_ready", "DeepSeek mock advisory is captured");
    assert(result.candidate_ticket.lifecycle === "proposed", "DeepSeek advisory cannot mark intake ticket ready");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-079: Update planner workflow migration in .agent/skills/iterative-planner/scripts/program_manager.mjs and .agent/workflows/program-manager.md",
      "--llm-review",
      "--json",
    ], { cwd: tmp, env: mockReviewReadyEnv });

    // Right-altitude recurrence: a predictive guard (M-001) is CARRIED into the
    // proposed ticket's verification plan at intake, not hard-blocking scope for
    // evidence that can only be produced at implementation. The child-plan must
    // still satisfy the carried guard downstream.
    assert(result.intake_packet.retro_recurrence_check.status !== "blocked", "planner-core recurrence guard is carried at intake, not hard-blocking scope");
    assert(!result.deterministic.blockers.some((entry) => entry.code === "retro_recurrence_blocked"), "carried recurrence guard does not become a deterministic intake blocker");
    assert(result.intake_packet.retro_recurrence_check.matches.some((entry) => entry.id === "M-001" && entry.status !== "blocked"), "M-001 recurrence guard is satisfied by the auto-carried verification row");
    assert(result.deepseek_advisory.status === "review_ready", "DeepSeek mock advisory is captured");
    assert(result.candidate_ticket.lifecycle === "proposed", "advisory DeepSeek cannot advance the intake ticket lifecycle");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-079: Polymarket odds model produced high-level summaries with no proper observed behavior overview.",
      "--llm-review",
      "--json",
    ], { cwd: tmp, env: mockReviewReadyEnv });

    assert(result.intake_packet.quant_persona_gate.status === "blocked", "quant intake packet includes blocked quant persona gate");
    assert(result.ticket_intake_receipt.quant_persona_gate_status === "blocked", "intake receipt carries quant persona gate status");
    assert(result.deterministic.blockers.some((entry) => entry.source === "quant_persona_gate"), "quant gate blockers join deterministic blockers");
    assert(result.deepseek_advisory.status === "review_ready", "DeepSeek mock can still say quant-blocked intake is review_ready");
    assert(result.intake_packet.final_status === "blocked", "DeepSeek cannot clear quant persona blockers");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  const secret = "sk-redact-program-intake";
  try {
    const programPath = writeProgram(tmp);
    const result = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      `US-079: do not leak ${secret}`,
      "--write",
      "--llm-review",
      "--json",
    ], {
      cwd: tmp,
      env: {
        DEEPSEEK_API_KEY: secret,
        PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
          status: "review_ready",
          summary: `secret says ${secret}`,
          findings: [{ id: "DS-1", status: "fresh", message: secret }],
        }),
      },
    });
    const artifact = readFileSync(join(tmp, result.intake_artifact_path), "utf-8");
    const packet = readFileSync(programPath, "utf-8");

    assert(!JSON.stringify(result).includes(secret), "intake result redacts API keys");
    assert(!artifact.includes(secret), "intake artifact redacts API keys");
    assert(!JSON.stringify(result.ticket_intake_receipt).includes(secret), "intake receipt redacts API keys");
    assert(!packet.includes(secret), "Program Packet intake write redacts API keys");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Duplicate scan (PM-2, consolidation 2026-06-10): intake blocks candidates
//    that resemble existing tickets unless --allow-duplicate is passed. ──
{
  const tmp = makeTemp();
  try {
    const packet = baseProgram({
      tickets: [{
        id: "T-EXISTING-1",
        epic_id: "EP-001",
        title: "Wire live visualizer cockpit payload and one steering action",
        type: "feature",
        lifecycle: "proposed",
        story_refs: ["US-001"],
        depends_on: [],
        acceptance_criteria: [],
        verification_refs: [],
      }],
    });
    const programPath = writeProgram(tmp, packet);

    const blocked = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-001: Wire the live visualizer cockpit payload and one steering action",
      "--write",
      "--json",
    ], { cwd: tmp, env: {} });
    assert(blocked.status === "BLOCKED", "near-identical candidate is blocked");
    assert(blocked.blocked_reason === "duplicate_candidates", "blocked reason names duplicate_candidates");
    assert((blocked.duplicate_scan?.matches || []).some((m) => m.id === "T-EXISTING-1"), "duplicate scan names the existing ticket");
    assert(readJson(programPath).tickets.length === 1, "blocked duplicate intake does not write a new ticket");

    const overridden = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-001: Wire the live visualizer cockpit payload and one steering action",
      "--allow-duplicate",
      "--write",
      "--json",
    ], { cwd: tmp, env: {} });
    assert(overridden.status === "PASS", "--allow-duplicate lets the intake proceed");
    assert(overridden.duplicate_scan?.status === "overridden", "override is recorded in the duplicate scan");
    assert(overridden.ticket_intake_receipt?.duplicate_scan_status === "overridden", "receipt carries the override acknowledgement");
    assert(readJson(programPath).tickets.length === 2, "override writes the new ticket");

    const fresh = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-001: Add nightly retention cleanup for stale artifacts",
      "--json",
    ], { cwd: tmp, env: {} });
    assert(fresh.status === "PASS", "non-duplicate candidate passes the scan");
    assert(fresh.duplicate_scan?.status === "clear", "scan reports clear for novel titles");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Cross-program duplicate detection: the scan must see sibling Program Packets.
{
  const tmp = makeTemp();
  try {
    const sibling = baseProgram({
      id: "PGM-SIBLING",
      tickets: [{
        id: "T-SIBLING-1",
        epic_id: "EP-001",
        title: "Add committed harvest script for reproducible telemetry pulls",
        type: "feature",
        lifecycle: "proposed",
        story_refs: ["US-001"],
        depends_on: [],
        acceptance_criteria: [],
        verification_refs: [],
      }],
    });
    writeProgram(tmp, sibling);
    const programPath = writeProgram(tmp, baseProgram());

    const blocked = await runIntake([
      "intake",
      "--program",
      programPath,
      "--from-text",
      "US-001: Add a committed harvest script for reproducible telemetry pulls",
      "--json",
    ], { cwd: tmp, env: {} });
    assert(blocked.status === "BLOCKED", "duplicate in a sibling program blocks intake");
    assert((blocked.duplicate_scan?.matches || []).some((m) => m.id === "T-SIBLING-1" && m.program_id === "PGM-SIBLING"), "match attributes the sibling program");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
