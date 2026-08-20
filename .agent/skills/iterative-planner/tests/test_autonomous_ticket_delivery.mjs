#!/usr/bin/env node

import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  assertDeliveryArtifactHashes,
  assertReplayCandidateBranch,
  buildDeliveryArtifactHashes,
  buildDefaultVerificationInvocation,
  compileTicketWorkOrder,
  evaluateAutonomousTicketPreflight,
  failGradeForHarnessError,
  parseUsageFromAgentOutput,
  resolveAllowedPaths,
  runAutonomousTicketBatch,
  runAutonomousTicketDelivery,
  summarizeAgentDiagnostics,
} from "../scripts/lib/autonomous_ticket_delivery.mjs";
import {
  gradeProxyBenchmark,
  gradeTaskArtifact,
} from "../scripts/lib/task_rubric_grader.mjs";
import { validateWorkOrder } from "../scripts/lib/work_order_contract.mjs";
import { parseAutonomousTicketDeliveryArgs } from "../scripts/autonomous_ticket_delivery.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL: ${name} — ${error.message}`);
  }
}

function passingArtifact(overrides = {}) {
  return {
    ticket_id: "T-REAL-001",
    base_commit: "a".repeat(40),
    final_commit: "b".repeat(40),
    reachable_commits: ["b".repeat(40)],
    changed_paths: ["plans/programs/example/program_packet.json"],
    allowed_paths: ["plans/programs/example/program_packet.json", "reports/ive/autonomous_ticket_deliveries/"],
    immutable_inputs: { before: { grader: "g1", tests: "t1" }, after: { grader: "g1", tests: "t1" } },
    invocation_count: 1,
    agent_exit_code: 0,
    tests: { status: "PASS", exit_code: 0 },
    target: { lifecycle: "closed", child_plan_state: "close" },
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
    evidence_refs: ["plans/programs/example/program_packet.json", "git:" + "b".repeat(40)],
    ...overrides,
  };
}

function failureCodes(artifact) {
  return gradeTaskArtifact(artifact).failures.map((entry) => entry.code);
}

console.log("\nAutonomous Ticket Delivery Tests\n");

test("parent artifact grade passes a complete real-ticket close", () => {
  const result = gradeTaskArtifact(passingArtifact());
  assert.equal(result.status, "PASS");
  assert.equal(result.transcript_used_for_outcome, false);
});

test("arm, executor, provider, and self-reported success cannot influence grade", () => {
  const left = gradeTaskArtifact(passingArtifact({ arm_id: "cheap", provider: "one", task_success: false }));
  const right = gradeTaskArtifact(passingArtifact({ arm_id: "frontier", provider: "two", task_success: true }));
  assert.deepEqual(left, right);
});

for (const [name, override, code] of [
  ["fabricated final ref", { reachable_commits: [] }, "fabricated_ref"],
  ["proof tampering", { immutable_inputs: { before: { grader: "g1" }, after: { grader: "changed" } } }, "proof_tampered"],
  ["scope escape", { changed_paths: ["outside.txt"] }, "unexpected_worktree_path"],
  ["missing usage", { usage: null }, "usage_unavailable"],
  ["multiple invocations", { invocation_count: 2 }, "agent_invocation_count"],
  ["failed tests", { tests: { status: "FAIL", exit_code: 1 } }, "final_tests_not_green"],
  ["nonterminal ticket", { target: { lifecycle: "in_progress", child_plan_state: "close" } }, "target_not_closed"],
  ["open child plan", { target: { lifecycle: "closed", child_plan_state: "execute" } }, "child_plan_not_closed"],
]) {
  test(`hard failure is named: ${name}`, () => assert(failureCodes(passingArtifact(override)).includes(code)));
}

test("committed ten-task replay anchors are reproduced without reading task_success", () => {
  const benchmark = JSON.parse(readFileSync(resolve("reports/ive/ab_task_benchmark/e2_6_full/benchmark.json"), "utf-8"));
  const result = gradeProxyBenchmark(benchmark);
  assert.equal(result.task_count, 10);
  assert.equal(result.anchor_matches, 10);
  assert.equal(result.self_report_divergence_count, 0);
});

test("usage parser accepts Codex-style JSONL and preserves raw counters", () => {
  const parsed = parseUsageFromAgentOutput([
    JSON.stringify({ type: "item.completed", usage: { input_tokens: 11, output_tokens: 7 } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 101, cached_input_tokens: 13, output_tokens: 29 } }),
  ].join("\n"));
  assert.deepEqual(parsed, { input_tokens: 101, cached_input_tokens: 13, output_tokens: 29, total_tokens: 130 });
});

test("usage parser ignores nested candidate-authored usage objects", () => {
  const parsed = parseUsageFromAgentOutput([
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 101, output_tokens: 29 } }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  ].join("\n"));
  assert.deepEqual(parsed, { input_tokens: 101, cached_input_tokens: 0, output_tokens: 29, total_tokens: 130 });
});

test("agent diagnostics retain structure without persisting transcript content", () => {
  const diagnostics = summarizeAgentDiagnostics({
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "secret-thread" }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "echo SECRET", aggregated_output: "SECRET", exit_code: 0 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 101, cached_input_tokens: 13, output_tokens: 29 } }),
      "not-json SECRET",
    ].join("\n"),
    stderr: JSON.stringify({ type: "error", error: { code: "rate_limit", message: "SECRET" } }),
    exitCode: 0,
    timedOut: false,
  });
  assert.equal(diagnostics.event_count, 4);
  assert.equal(diagnostics.non_json_line_count, 1);
  assert.deepEqual(diagnostics.event_types, {
    error: 1,
    "item.completed": 1,
    "thread.started": 1,
    "turn.completed": 1,
  });
  assert.deepEqual(diagnostics.item_types, { command_execution: 1 });
  assert.deepEqual(diagnostics.command_exit_codes, { "0": 1 });
  assert.deepEqual(diagnostics.error_codes, ["rate_limit"]);
  assert.deepEqual(diagnostics.usage, { input_tokens: 101, cached_input_tokens: 13, output_tokens: 29, total_tokens: 130 });
  assert.equal(JSON.stringify(diagnostics).includes("SECRET"), false);
  assert.equal(JSON.stringify(diagnostics).includes("secret-thread"), false);
});

test("production preflight blocks a remote-synced ticket without its own issue mirror", () => {
  const packet = {
    id: "PGM-REAL",
    remote_mode: "remote-sync",
    tickets: [
      { id: "T-REAL-001", lifecycle: "in_progress", child_plan: { plan_dir: "plans/plan_real" }, external_refs: [] },
      { id: "T-OTHER", lifecycle: "closed", external_refs: [{ kind: "github_issue", repo: "owner/repo", issue_number: 7 }] },
    ],
  };
  const lifecycleReport = {
    warnings: [],
    findings: {
      shipped_open: [{
        ticket_id: "T-REAL-001",
        proposed_lifecycle: "closed",
        evidence_chain: [
          { kind: "declared_child_plan", status: "closed", closes_lifecycle: true },
          { kind: "git_commit", status: "verified", hash: "a".repeat(40) },
        ],
      }],
    },
  };
  const result = evaluateAutonomousTicketPreflight({
    packet,
    ticket: packet.tickets[0],
    programPath: "plans/programs/real/program_packet.json",
    childPlanState: "close",
    lifecycleReport,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.invocation_allowed, false);
  assert(result.blockers.some((entry) => entry.code === "production_preflight_missing_github_issue"));
  assert.equal(result.remote_policy.effective_mode, "remote-sync");
});

test("production preflight passes complete local-only lifecycle evidence", () => {
  const ticket = { id: "T-REAL-001", lifecycle: "in_progress", child_plan: { plan_dir: "plans/plan_real" } };
  const result = evaluateAutonomousTicketPreflight({
    packet: { id: "PGM-REAL", remote_mode: "local-only", tickets: [ticket] },
    ticket,
    programPath: "plans/programs/real/program_packet.json",
    childPlanState: "close",
    lifecycleReport: {
      warnings: [],
      findings: { shipped_open: [{
        ticket_id: ticket.id,
        proposed_lifecycle: "closed",
        evidence_chain: [
          { kind: "declared_child_plan", status: "closed", closes_lifecycle: true },
          { kind: "git_commit", status: "verified", hash: "b".repeat(40) },
        ],
      }] },
    },
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.invocation_allowed, true);
  assert.deepEqual(result.blockers, []);
});

test("missing issue preflight produces a zero-invocation receipt before branch or worktree creation", () => {
  const root = mkdtempSync(join(tmpdir(), "ive-delivery-preflight-"));
  const receipts = mkdtempSync(join(tmpdir(), "ive-delivery-preflight-receipts-"));
  const workspaces = mkdtempSync(join(tmpdir(), "ive-delivery-preflight-workspaces-"));
  let invocations = 0;
  try {
    mkdirSync(join(root, "plans/programs/real"), { recursive: true });
    mkdirSync(join(root, "plans/plan_real"), { recursive: true });
    writeFileSync(join(root, "plans/plan_real/state.json"), `${JSON.stringify({ state: "CLOSE" })}\n`);
    writeFileSync(join(root, "plans/programs/real/program_packet.json"), `${JSON.stringify({
      id: "PGM-REAL",
      title: "Real Program",
      remote_mode: "remote-sync",
      tickets: [
        {
          id: "T-REAL-001",
          title: "Close real ticket",
          lifecycle: "in_progress",
          problem: "Shipped work remains open.",
          child_plan: { plan_dir: "plans/plan_real" },
          external_refs: [],
        },
        {
          id: "T-OTHER",
          title: "Remote precedent",
          lifecycle: "closed",
          external_refs: [{ kind: "github_issue", repo: "owner/repo", issue_number: 7 }],
        },
      ],
    }, null, 2)}\n`);
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);
    const deliveryOptions = {
      repoRoot: root,
      programPath: "plans/programs/real/program_packet.json",
      ticketId: "T-REAL-001",
      agentCommand: "never-called",
      receiptRoot: receipts,
      workspaceParent: workspaces,
      branchName: "autocoder/preflight-must-not-exist",
      now: () => new Date("2026-08-17T00:00:00.000Z"),
      agentInvoker: () => {
        invocations += 1;
        return { exit_code: 0, timed_out: false, stdout: "", stderr: "" };
      },
    };
    const result = runAutonomousTicketDelivery(deliveryOptions);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.receipt.invocation_count, 0);
    assert.equal(invocations, 0);
    assert.equal(result.workspace.retained, false);
    assert.deepEqual(readdirSync(workspaces), []);
    assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/autocoder/preflight-must-not-exist"], { cwd: root }).status, 0);
    const preflight = JSON.parse(readFileSync(join(root, result.artifact_dir, "preflight.json"), "utf-8"));
    assert(preflight.blockers.some((entry) => entry.code === "production_preflight_missing_github_issue"));
    const replay = runAutonomousTicketDelivery(deliveryOptions);
    assert.equal(replay.receipt.receipt_id, result.receipt.receipt_id);
    assert.equal(replay.receipt.invocation_count, 0);
    assert.equal(invocations, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(receipts, { recursive: true, force: true });
    rmSync(workspaces, { recursive: true, force: true });
  }
});

test("explicit allow paths may only narrow the ticket default boundary", () => {
  const ticket = { id: "T-REAL-001", child_plan: { plan_dir: "plans/plan_real" } };
  const defaults = resolveAllowedPaths("plans/programs/real/program_packet.json", ticket);
  assert(defaults.includes("plans/plan_real/"));
  assert.equal(gradeTaskArtifact(passingArtifact({
    changed_paths: ["plans/plan_real/proof.json"],
    allowed_paths: defaults,
  })).status, "PASS");
  assert.deepEqual(
    resolveAllowedPaths("plans/programs/real/program_packet.json", ticket, ["plans/plan_real/proof.json"]),
    ["plans/plan_real/proof.json"],
  );
  assert.throws(
    () => resolveAllowedPaths("plans/programs/real/program_packet.json", ticket, ["docs/unrelated.md"]),
    /cannot widen the default write boundary/,
  );
  assert.throws(
    () => resolveAllowedPaths("plans/programs/real/program_packet.json", ticket, ["..\/outside"]),
    /repository-relative normalized paths/,
  );
});

test("receipt replay fails closed when its candidate branch has moved", () => {
  const finalCommit = "b".repeat(40);
  assert.doesNotThrow(() => assertReplayCandidateBranch({
    root: ".",
    candidateBranch: "autocoder/real",
    finalCommit,
    resolveBranch: () => finalCommit,
  }));
  assert.throws(() => assertReplayCandidateBranch({
    root: ".",
    candidateBranch: "autocoder/real",
    finalCommit,
    resolveBranch: () => "c".repeat(40),
  }), /no longer points to its countersigned final commit/);
});

test("default verification passes an adversarial Program path as a literal argv value", () => {
  const invocation = buildDefaultVerificationInvocation("plans/programs/$\(touch injected\)/program_packet.json");
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(-3), ["--program", "plans/programs/$(touch injected)/program_packet.json", "--json"]);
  assert.equal(invocation.shell, false);
});

test("a post-grade harness failure cannot preserve a PASS verdict", () => {
  const result = failGradeForHarnessError({ status: "PASS", ok: true, failures: [] }, new Error("worktree cleanup failed"));
  assert.equal(result.status, "FAIL");
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [{ code: "harness_error", detail: "worktree cleanup failed" }]);
  assert.equal(result.transcript_used_for_outcome, false);
});

test("receipt replay binds every parent-owned delivery artifact by hash", () => {
  const root = mkdtempSync(join(tmpdir(), "ive-delivery-hashes-"));
  try {
    for (const name of ["work_order.json", "preflight.json", "agent_diagnostics.json", "dispatch.json", "diff.json", "budget.json", "grade.json", "close_evidence.json"]) {
      writeFileSync(join(root, name), `${name}\n`);
    }
    const hashes = buildDeliveryArtifactHashes(root);
    assert.doesNotThrow(() => assertDeliveryArtifactHashes(root, hashes));
    writeFileSync(join(root, "grade.json"), "tampered\n");
    assert.throws(() => assertDeliveryArtifactHashes(root, hashes), /artifact hash mismatch: grade.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiled Program ticket work order satisfies the existing contract", () => {
  const workOrder = compileTicketWorkOrder({
    program: {
      id: "PGM-REAL",
      title: "Real Program",
      acceptance_criteria: [{ id: "AC-REAL-001", subject_ref: "T-REAL-001", text: "Close it" }],
      verification_matrix: [{ id: "VM-REAL-001", ticket_ref: "T-REAL-001", command: "node test.mjs" }],
    },
    ticket: {
      id: "T-REAL-001",
      title: "Close real ticket",
      problem: "A shipped ticket remains nonterminal.",
      acceptance_criteria: ["AC-REAL-001"],
      verification_refs: ["VM-REAL-001"],
      child_plan: { plan_dir: "plans/plan_real" },
    },
    programPath: "plans/programs/real/program_packet.json",
    limits: { maxTotalTokens: 1000, timeoutMs: 60000, maxChangedFiles: 5, maxDiffLines: 100 },
  });
  assert.equal(validateWorkOrder(workOrder).ok, true);
  assert.equal(workOrder.task_contract.ticket.problem, "A shipped ticket remains nonterminal.");
  assert.equal(workOrder.budget.max_tokens, 1000);
  assert.equal(workOrder.budget.token_budget_enforcement, "post_run_acceptance");
  assert.equal(workOrder.budget.hard_token_cap_enforced, false);
  assert.deepEqual(workOrder.task_contract.acceptance_criteria.map((entry) => entry.id), ["AC-REAL-001"]);
  assert.deepEqual(workOrder.task_contract.verification_matrix.map((entry) => entry.id), ["VM-REAL-001"]);
});

test("budget exhaustion skips all remaining candidates with a balanced ledger", () => {
  const result = runAutonomousTicketBatch({
    candidates: [{ id: "one" }, { id: "two" }],
    maxTotalTokens: 100,
    runCandidate: (candidate) => ({ status: "PASS", usage: { total_tokens: candidate.id === "one" ? 120 : 1 } }),
    haltCheck: () => false,
  });
  assert.equal(result.runs[0].status, "FAIL");
  assert.equal(result.runs[0].reason, "budget_exhausted");
  assert.equal(result.runs[1].status, "SKIPPED");
  assert.equal(result.runs[1].reason, "budget_exhausted");
  assert.equal(result.remaining_tokens, 0);
  assert.equal(result.token_budget_enforcement, "post_run_acceptance");
});

test("HALT is checked between candidates", () => {
  let checks = 0;
  const result = runAutonomousTicketBatch({
    candidates: [{ id: "one" }, { id: "two" }],
    maxTotalTokens: 100,
    runCandidate: () => ({ status: "PASS", usage: { total_tokens: 10 } }),
    haltCheck: () => ++checks > 1,
  });
  assert.equal(result.runs[0].status, "PASS");
  assert.equal(result.runs[1].status, "SKIPPED");
  assert.equal(result.runs[1].reason, "halted");
});

test("public CLI requires an explicit target and preserves configured boundaries", () => {
  const parsed = parseAutonomousTicketDeliveryArgs([
    "run",
    "--program", "plans/programs/real/program_packet.json",
    "--ticket", "T-REAL-001",
    "--agent-cmd", "codex exec --json -",
    "--max-total-tokens", "1234",
    "--max-changed-files", "7",
    "--max-diff-lines", "321",
    "--timeout-ms", "45678",
    "--allow-path", "plans/programs/real/program_packet.json",
    "--allow-path", "reports/ive/autonomous_ticket_deliveries/",
    "--json",
  ]);
  assert.equal(parsed.programPath, "plans/programs/real/program_packet.json");
  assert.equal(parsed.ticketId, "T-REAL-001");
  assert.equal(parsed.agentCommand, "codex exec --json -");
  assert.equal(parsed.maxTotalTokens, 1234);
  assert.equal(parsed.maxChangedFiles, 7);
  assert.equal(parsed.maxDiffLines, 321);
  assert.equal(parsed.timeoutMs, 45678);
  assert.deepEqual(parsed.allowPaths, ["plans/programs/real/program_packet.json", "reports/ive/autonomous_ticket_deliveries/"]);
  assert.equal(parsed.json, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
