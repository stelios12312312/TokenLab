#!/usr/bin/env node
// test_github_ticket_review.mjs — GitHub ticket review CLI contracts.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { renderText, runPublish, runReview } from "../scripts/github_ticket_review.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

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
  return mkdtempSync(join(tmpdir(), "github-ticket-review-"));
}

function baseProgram(overrides = {}) {
  const ticket = {
    id: "T-001",
    epic_id: "EP-001",
    title: "Review GitHub ticket",
    type: "feature",
    lifecycle: "ready",
    story_refs: ["US-001"],
    defect_refs: [],
    gap_refs: [],
    depends_on: [],
    acceptance_criteria: ["AC-001"],
    child_plan: {
      policy: "not_required",
      plan_dir: null,
      reason: "Unit-test fixture",
    },
    compatibility_contract_refs: [],
    migration_boundary_refs: [],
    deletion_move_census_refs: [],
    verification_refs: ["VM-001"],
    ...(overrides.ticket || {}),
  };
  return {
    version: 1,
    id: "PGM-TEST",
    title: "Ticket Review Fixture",
    status: "ready",
    goal: "Prove GitHub ticket review behavior.",
    story_refs: ["US-001"],
    epics: [
      {
        id: "EP-001",
        title: "Review loop",
        story_refs: ["US-001"],
        ticket_refs: ["T-001"],
      },
    ],
    tickets: [ticket],
    acceptance_criteria: [
      {
        id: "AC-001",
        scope: "ticket",
        subject_ref: "T-001",
        text: "Ticket review packet is generated.",
        story_refs: ["US-001"],
        maintenance_rationale: null,
      },
    ],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [
      {
        id: "VM-001",
        scope: "ticket",
        subject_ref: "T-001",
        acceptance_criterion_ref: "AC-001",
        proof_type: "proof:artifact_review",
        command_or_action: "Review ticket packet",
        pass_means: "Packet contains deterministic evidence",
      },
    ],
    decisions: [],
    ...overrides.packet,
  };
}

function writeProgram(tmp, packet) {
  const dir = join(tmp, "plans", "programs", packet.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "program_packet.json");
  writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
  return path;
}

function writeIntakePacket(tmp, packetId, name, packet) {
  const relPath = join("plans", "programs", packetId, "intake", name);
  const absPath = join(tmp, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
  return relPath;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function issueFixture(body = "Issue body") {
  return {
    number: 42,
    title: "Build review loop",
    body,
    state: "OPEN",
    url: "https://github.com/owner/repo/issues/42",
    labels: [{ name: "enhancement" }],
    comments: [
      {
        id: "COMMENT-1",
        url: "https://github.com/owner/repo/issues/42#issuecomment-1",
        body: "<!-- planner-ticket-review:T-001 -->\nold body",
        author: { login: "github-actions" },
      },
    ],
  };
}

function projectItemFixture() {
  return {
    data: {
      node: {
        id: "PVTI_item",
        type: "ISSUE",
        project: { id: "PVT_project", title: "Planner Project", url: "https://github.com/orgs/owner/projects/1" },
        content: {
          __typename: "Issue",
          number: 42,
          title: "Build review loop",
          body: "Project-linked issue",
          state: "OPEN",
          url: "https://github.com/owner/repo/issues/42",
          repository: { name: "repo", owner: { login: "owner" } },
          labels: { nodes: [{ name: "enhancement" }] },
        },
        fieldValues: { nodes: [] },
      },
    },
  };
}

function projectFieldsFixture() {
  return {
    data: {
      node: {
        id: "PVT_project",
        fields: {
          nodes: [
            {
              __typename: "ProjectV2SingleSelectField",
              id: "FIELD_status",
              name: "Status",
              options: [
                { id: "OPT_review_ready", name: "Review Ready" },
                { id: "OPT_blocked", name: "Blocked" },
              ],
            },
          ],
        },
      },
    },
  };
}

function createFakeGh({ issue = issueFixture(), projectItem = projectItemFixture(), projectFields = projectFieldsFixture() } = {}) {
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    const key = args.join(" ");
    if (args[0] === "api" && args[1] === "repos/owner/repo/issues" && args.includes("POST")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          id: "ISSUE_NODE_99",
          node_id: "ISSUE_NODE_99",
          number: 99,
          title: "Published planner ticket",
          body: "",
          state: "OPEN",
          url: "https://github.com/owner/repo/issues/99",
          labels: [],
          comments: [],
        }),
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify(issue), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      if (key.includes("addProjectV2ItemById")) {
        return { status: 0, stdout: JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "PVTI_published" } } } }), stderr: "" };
      }
      const query = args.find((arg) => String(arg).startsWith("query=")) || "";
      if (query.includes("ProjectV2Item")) return { status: 0, stdout: JSON.stringify(projectItem), stderr: "" };
      if (query.includes("ProjectV2")) return { status: 0, stdout: JSON.stringify(projectFields), stderr: "" };
    }
    if (args[0] === "api" && key.includes("issues/comments")) {
      return { status: 0, stdout: JSON.stringify({ url: issue.comments?.[0]?.url || null }), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      return { status: 0, stdout: "https://github.com/owner/repo/issues/42#issuecomment-new", stderr: "" };
    }
    if (args[0] === "issue" && ["edit", "close"].includes(args[1])) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "project" && args[1] === "item-edit") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "project" && args[1] === "item-add") {
      return { status: 0, stdout: JSON.stringify({ id: "PVTI_published" }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `Unexpected gh call: ${key}` };
  };
  return { runner, calls };
}

function passingCommandRunner(command) {
  return { status: 0, stdout: JSON.stringify({ status: "PASS", id: command.id }), stderr: "" };
}

function failingCommandRunner(failIds) {
  const ids = new Set(failIds);
  return (command) => ids.has(command.id)
    ? { status: 1, stdout: "", stderr: `${command.id} failed` }
    : passingCommandRunner(command);
}

function writeCalls(calls) {
  return calls.filter((args) => {
    if (args[0] === "issue" && ["comment", "edit", "close"].includes(args[1])) return true;
    if (args[0] === "project" && args[1] === "item-edit") return true;
    if (args[0] === "project" && args[1] === "item-add") return true;
    if (args[0] === "api" && args[1] === "repos/owner/repo/issues" && args.includes("POST")) return true;
    if (args[0] === "api" && args.some((arg) => arg === "-X") && args.includes("PATCH")) return true;
    return false;
  });
}

function createIssueCalls(calls) {
  return calls.filter((args) => args[0] === "api" && args[1] === "repos/owner/repo/issues" && args.includes("POST"));
}

const mockReviewReadyEnv = {
  PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    status: "review_ready",
    summary: "Advisory review says ready",
    findings: [{ id: "DS-001", status: "fresh", message: "Review packet has enough references" }],
    recommended_actions: ["Keep deterministic evidence authoritative"],
  }),
};

console.log("\nGitHub Ticket Review Contracts\n");

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh();
    const result = await runReview([
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });

    assert(result.dry_run === true, "issue review defaults to dry-run");
    assert(result.review_status === "review_ready", "passing issue review reports review_ready");
    assert(result.ticket_intake_receipt.name === "Ticket Intake Receipt", "review emits a Ticket Intake Receipt");
    assert(result.ticket_intake_receipt.action === "review", "review receipt records review action");
    assert(result.ticket_intake_receipt.front_door === "/program-manager", "review receipt records Program Manager front door");
    assert(result.ticket_intake_receipt.ticket_id === "T-001", "review receipt records ticket id");
    assert(result.ticket_intake_receipt.deterministic_status === result.review_status, "review receipt mirrors deterministic status");
    assert(result.ticket_intake_receipt.deepseek_advisory_status === "review_ready", "review receipt records advisory status separately");
    assert(result.ticket_intake_receipt.deepseek_advisory_block.includes("<<<DEEPSEEK_VERDICT_BEGIN>>>"), "review receipt includes fenced DeepSeek block");
    assert(result.ticket_intake_receipt.deepseek_advisory_block.includes("Review packet has enough references"), "review receipt block includes DeepSeek finding text");
    assert(result.ticket_intake_receipt.deepseek_advisory_block.includes("Keep deterministic evidence authoritative"), "review receipt block includes recommended action");
    assert(result.ticket_intake_receipt.verbatim_reproduction_contract?.includes("audit artifacts"), "review receipt explains DeepSeek artifact contract");
    assert(result.ticket_intake_receipt.deepseek_advisory_summary === "Advisory review says ready", "review receipt carries compact DeepSeek summary");
    assert(result.github_sync.planned_comment.includes("DeepSeek advisory: `review_ready`"), "GitHub review comment surfaces compact DeepSeek status");
    assert(result.github_sync.planned_comment.includes("Advisory review says ready"), "GitHub review comment surfaces compact DeepSeek summary");
    assert(result.github_sync.planned_comment.includes("Review packet:"), "GitHub review comment points to review packet artifact");
    assert(!result.github_sync.planned_comment.includes("<<<DEEPSEEK_VERDICT_BEGIN>>>"), "GitHub review comment omits DeepSeek block delimiters by default");
    assert(renderText(result).includes("DeepSeek advisory: review_ready"), "text-mode review output includes compact DeepSeek status");
    assert(renderText(result).includes("summary: Advisory review says ready"), "text-mode review output includes compact DeepSeek summary");
    assert(!renderText(result).includes("<<<DEEPSEEK_VERDICT_BEGIN>>>"), "text-mode review output omits DeepSeek block delimiters by default");
    assert(renderText(result, { showDeepSeekBlock: true }).includes("<<<DEEPSEEK_VERDICT_BEGIN>>>"), "--show-deepseek-block text rendering includes DeepSeek block");
    assert(result.review_packet.retro_recurrence_check.status === "not_applicable", "passing review packet includes recurrence check");
    assert(result.ticket_intake_receipt.retro_recurrence_status === "not_applicable", "review receipt carries recurrence status");
    assert(writeCalls(fakeGh.calls).length === 0, "dry-run performs no GitHub write calls");
    assert(!readJson(programPath).tickets[0].external_refs, "dry-run does not edit Program Packet metadata");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh();
    const result = await runReview([
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--show-deepseek-block",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });

    assert(result.github_sync.planned_comment.includes("DeepSeek advisory verdict"), "--show-deepseek-block adds the verbose verdict heading to GitHub comment");
    assert(result.github_sync.planned_comment.includes("<<<DEEPSEEK_VERDICT_BEGIN>>>"), "--show-deepseek-block includes DeepSeek delimiters in GitHub comment");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram({
      ticket: {
        title: "Planner workflow migration guard",
      },
    }));
    const fakeGh = createFakeGh({
      issue: issueFixture("Update planner workflow migration in .agent/skills/iterative-planner/scripts/github_ticket_review.mjs and .agent/workflows/program-manager.md"),
    });
    const result = await runReview([
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });

    assert(result.review_status === "blocked", "trusted recurrence risk blocks GitHub review");
    assert(result.review_packet.retro_recurrence_check.status === "blocked", "Review Packet records blocked recurrence status");
    assert(result.ticket_intake_receipt.retro_recurrence_status === "blocked", "review receipt records blocked recurrence status");
    assert(result.review_packet.deepseek_advisory.status === "review_ready", "DeepSeek mock cannot clear recurrence blocker");
    assert(result.github_sync.planned_comment.includes("Retro Recurrence Check"), "GitHub review comment includes recurrence section");
    assert(result.github_sync.planned_comment.includes("M-001"), "GitHub review comment names the recurrence blocker");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram({
      ticket: {
        title: "Polymarket odds model review",
      },
    }));
    const fakeGh = createFakeGh({
      issue: issueFixture("Polymarket odds model produced high-level summaries with no proper observed behavior overview."),
    });
    const result = await runReview([
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });

    assert(result.review_status === "blocked", "quant persona gate blocks high-level GitHub ticket review");
    assert(result.review_packet.quant_persona_gate.status === "blocked", "Review Packet records quant persona gate status");
    assert(result.ticket_intake_receipt.quant_persona_gate_status === "blocked", "review receipt records quant persona gate status");
    assert(result.review_packet.deepseek_advisory.status === "review_ready", "DeepSeek mock cannot clear quant persona blocker");
    assert(result.github_sync.planned_comment.includes("Quant Persona Gate"), "GitHub review comment includes quant persona gate section");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh();
    const args = [
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--write",
      "--json",
    ];
    const first = await runReview(args, { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });
    const second = await runReview(args, { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });
    const packet = readJson(programPath);
    const ticket = packet.tickets[0];

    assert(first.packet_updated && second.packet_updated, "--write updates Program Packet metadata");
    assert(existsSync(join(tmp, first.review_artifact_path)), "--write writes Review Packet artifact");
    assert(readJson(join(tmp, first.review_artifact_path)).ticket_intake_receipt?.action === "review", "Review Packet artifact includes the receipt");
    assert(ticket.external_refs.length === 1, "repeated write upserts external_refs instead of duplicating");
    assert(ticket.review_artifacts.length === 1, "repeated write upserts review_artifacts instead of duplicating");
    assert(ticket.last_review_status === "review_ready", "ticket last_review_status records deterministic result");
    assert(ticket.review_status === "review_ready", "ticket review_status records deterministic result");
    assert(fakeGh.calls.some((args) => args[0] === "api" && args.join(" ").includes("issues/comments/COMMENT-1")), "existing review comment is updated");
    assert(fakeGh.calls.some((args) => args[0] === "issue" && args[1] === "edit" && args.includes("--add-label")), "--write applies lifecycle labels");
    assert(!fakeGh.calls.some((args) => args[0] === "issue" && args[1] === "close"), "--write does not close issues without explicit close flag");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh();
    await runReview([
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--write",
      "--close-github-issue",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });

    assert(fakeGh.calls.some((args) => args[0] === "issue" && args[1] === "close"), "--close-github-issue explicitly closes the linked issue");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh({ issue: { ...issueFixture("Project issue"), comments: [] } });
    const result = await runReview([
      "review",
      "--project-item",
      "PVTI_item",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--write",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });

    assert(result.issue.project_item_id === "PVTI_item", "project item import records project item id");
    assert(fakeGh.calls.some((args) => args[0] === "issue" && args[1] === "view"), "project item import discovers linked issue");
    assert(fakeGh.calls.some((args) => args[0] === "project" && args[1] === "item-edit"), "project item review updates project status when mapping exists");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram({ ticket: { story_refs: [] } }));
    const fakeGh = createFakeGh();
    const result = await runReview([
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, commandRunner: passingCommandRunner, env: mockReviewReadyEnv });

    const blockers = result.review_packet.deterministic.blockers;
    assert(result.review_status === "blocked", "missing story traceability blocks review");
    assert(result.review_packet.deepseek_advisory.status === "review_ready", "DeepSeek mock can still say review_ready");
    assert(result.ticket_intake_receipt.deterministic_status === "blocked", "review receipt preserves deterministic blocked status");
    assert(result.ticket_intake_receipt.deepseek_advisory_status === "review_ready", "review receipt keeps advisory status separate from deterministic status");
    assert(blockers.some((entry) => entry.code === "ticket_without_traceability"), "missing story blocker is preserved");
    assert(result.github_sync.planned_comment.includes("Status: **blocked**"), "dry-run comment reflects deterministic blocker");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram({ ticket: { verification_refs: [] } }));
    const fakeGh = createFakeGh();
    const result = await runReview([
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--json",
    ], {
      cwd: tmp,
      ghRunner: fakeGh.runner,
      commandRunner: failingCommandRunner(["annotation_parser_validate", "rule_engine_check_invariants"]),
      env: mockReviewReadyEnv,
    });
    const blockerCodes = result.review_packet.deterministic.blockers.map((entry) => entry.code);
    assert(result.review_status === "blocked", "missing verification row and failed deterministic commands block review");
    assert(blockerCodes.includes("ready_ticket_missing_verification"), "missing verification fixture is reported");
    assert(blockerCodes.includes("annotation_parser_validate_failed"), "stale/failed annotation validation is reported");
    assert(blockerCodes.includes("rule_engine_check_invariants_failed"), "failed invariant check is reported");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  const secret = "sk-redaction-fixture-not-real";
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh({ issue: issueFixture(`Do not leak ${secret}`) });
    const result = await runReview([
      "review",
      "--issue",
      "42",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--write",
      "--json",
    ], {
      cwd: tmp,
      ghRunner: fakeGh.runner,
      commandRunner: passingCommandRunner,
      env: {
        DEEPSEEK_API_KEY: secret,
        PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
          status: "review_ready",
          summary: `secret says ${secret}`,
          findings: [{ id: "DS-1", status: "fresh", message: secret }],
        }),
      },
    });
    const artifact = readFileSync(join(tmp, result.review_artifact_path), "utf-8");
    const callText = JSON.stringify(fakeGh.calls);

    assert(!JSON.stringify(result).includes(secret), "result JSON redacts API keys");
    assert(!artifact.includes(secret), "Review Packet artifact redacts API keys");
    assert(!JSON.stringify(result.ticket_intake_receipt).includes(secret), "review receipt redacts API keys");
    assert(!String(result.ticket_intake_receipt.deepseek_advisory_block || "").includes(secret), "review receipt DeepSeek block redacts API keys");
    assert(!String(result.github_sync.planned_comment || "").includes(secret), "planned GitHub comment redacts API keys");
    assert(!callText.includes(secret), "GitHub comment/update calls redact API keys");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh();
    const before = readFileSync(programPath, "utf-8");
    const result = await runPublish([
      "publish",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, env: mockReviewReadyEnv });

    assert(result.dry_run === true, "publish defaults to dry-run");
    assert(result.issue.action === "planned", "dry-run publish plans issue creation");
    assert(result.ticket_intake_receipt.action === "publish", "publish emits a Ticket Intake Receipt");
    assert(result.ticket_intake_receipt.deterministic_status === "not_run_publish_only", "publish receipt does not pretend publish verifies the ticket");
    assert(result.ticket_intake_receipt.direct_github_creation_allowed === false, "publish receipt records explicit GitHub publication boundary");
    assert(result.planned_issue.body.includes("Planner: Program"), "dry-run publish keeps planner metadata when no intake artifact exists");
    assert(writeCalls(fakeGh.calls).length === 0, "dry-run publish performs no GitHub writes");
    assert(readFileSync(programPath, "utf-8") === before, "dry-run publish does not edit Program Packet");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const ticketTitle = "Discrete CIP and VRP with Governance";
    const intakeText = `${ticketTitle}

Implement discrete CIP (Creator Incentive Pool) and VRP (Validator Reward Pool) as separate ledger accounts with waterfall-priority funding from Treasury.

Make the GitHub mirror readable to collaborators who are not inside the planner.`;
    const intakePath = writeIntakePacket(tmp, "PGM-TEST", "t-001_intake_packet.json", {
      version: 1,
      source: {
        title: ticketTitle,
        text: intakeText,
      },
    });
    const programPath = writeProgram(tmp, baseProgram({
      ticket: {
        title: ticketTitle,
        review_artifacts: [
          {
            path: intakePath,
            kind: "program_intake_packet",
            generated_at: "2026-05-18T00:00:00.000Z",
          },
        ],
      },
    }));
    const fakeGh = createFakeGh();
    const result = await runPublish([
      "publish",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, env: mockReviewReadyEnv });
    const body = result.planned_issue.body;
    const descriptionIndex = body.indexOf("Implement discrete CIP");
    const metadataIndex = body.indexOf("Planner: Program");
    const afterHeading = body.slice(body.indexOf(`## ${ticketTitle}`) + `## ${ticketTitle}`.length).trimStart();

    assert(body.includes(`## ${ticketTitle}`), "publish issue body leads with ticket title heading");
    assert(descriptionIndex >= 0, "publish issue body includes intake source description");
    assert(descriptionIndex < metadataIndex, "intake source description appears before planner metadata");
    assert(!afterHeading.startsWith(ticketTitle), "publish issue body strips duplicated intake title line");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh();
    const result = await runPublish([
      "publish",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--write",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, env: mockReviewReadyEnv });
    const ticket = readJson(programPath).tickets[0];

    assert(result.packet_updated === true, "--write publish updates Program Packet metadata");
    assert(result.issue.action === "created", "--write publish creates a GitHub issue when missing");
    assert(result.ticket_intake_receipt.source.repo === "owner/repo", "publish receipt records repo");
    assert(ticket.external_refs.some((ref) => ref.kind === "github_issue" && ref.issue_number === 99), "publish records created GitHub issue external ref");
    assert(ticket.github_sync.last_issue_url === "https://github.com/owner/repo/issues/99", "publish records GitHub sync issue URL");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const packet = baseProgram({
      ticket: {
        external_refs: [
          {
            kind: "github_issue",
            repo: "owner/repo",
            issue_number: 99,
            title: "Existing issue",
            url: "https://github.com/owner/repo/issues/99",
            state: "OPEN",
          },
        ],
      },
    });
    const programPath = writeProgram(tmp, packet);
    const fakeGh = createFakeGh();
    const result = await runPublish([
      "publish",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--write",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, env: mockReviewReadyEnv });

    assert(result.issue.action === "existing", "repeated publish reuses existing GitHub issue ref");
    assert(createIssueCalls(fakeGh.calls).length === 0, "repeated publish does not create duplicate issues");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp, baseProgram());
    const fakeGh = createFakeGh();
    const result = await runPublish([
      "publish",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--project",
      "PVT_project",
      "--write",
      "--json",
    ], { cwd: tmp, ghRunner: fakeGh.runner, env: mockReviewReadyEnv });

    assert(result.project.action === "linked", "publish links created issue to requested Project");
    assert(fakeGh.calls.some((args) => args[0] === "api" && args[1] === "graphql" && args.join(" ").includes("addProjectV2ItemById")), "publish uses GitHub project mutation when project node id is available");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  const secret = "sk-publish-redaction-secret";
  try {
    const intakePath = writeIntakePacket(tmp, "PGM-TEST", "t-001_intake_packet.json", {
      version: 1,
      source_text: `Publish without leaking ${secret}

This body also mentions ${secret} and must be redacted before GitHub publication.`,
    });
    const programPath = writeProgram(tmp, baseProgram({
      ticket: {
        title: `Publish without leaking ${secret}`,
        review_artifacts: [
          {
            path: intakePath,
            kind: "program_intake_packet",
            generated_at: "2026-05-18T00:00:00.000Z",
          },
        ],
      },
    }));
    const fakeGh = createFakeGh();
    const result = await runPublish([
      "publish",
      "--program",
      programPath,
      "--ticket",
      "T-001",
      "--repo",
      "owner/repo",
      "--json",
    ], {
      cwd: tmp,
      ghRunner: fakeGh.runner,
      env: {
        DEEPSEEK_API_KEY: secret,
      },
    });

    assert(!JSON.stringify(result).includes(secret), "publish result redacts API keys");
    assert(!result.planned_issue.body.includes(secret), "publish issue body redacts API keys");
    assert(!JSON.stringify(result.ticket_intake_receipt).includes(secret), "publish receipt redacts API keys");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
