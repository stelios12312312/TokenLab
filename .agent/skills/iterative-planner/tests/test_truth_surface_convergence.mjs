import assert from "assert/strict";
import { mkdtempSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  evaluateTruthSurfaceConvergence,
  writeTruthSurfaceReceipt,
} from "../scripts/lib/truth_surface_convergence.mjs";

const NOW = "2026-08-13T12:00:00.000Z";
const FRESH_EXPIRY = "2026-08-14T12:00:00.000Z";
const STALE_EXPIRY = "2026-08-12T12:00:00.000Z";

function packet({
  id = "PGM-TEST",
  status = "executing",
  lifecycle = "closed",
  storyRef = "US-001",
  issue = 17,
  issueState = "open",
  remoteMode = "remote-sync",
} = {}) {
  return {
    path: `plans/programs/${id.toLowerCase()}/program_packet.json`,
    packet: {
      version: 1,
      id,
      title: id,
      goal: "Test convergence",
      status,
      remote_mode: remoteMode,
      story_refs: [storyRef],
      epics: [{ id: "EP-1", story_refs: [storyRef], ticket_refs: ["T-1"] }],
      tickets: [{
        id: "T-1",
        epic_id: "EP-1",
        lifecycle,
        story_refs: [storyRef],
        acceptance_criteria: ["AC-1"],
        external_refs: issue === null ? [] : [{
          kind: "github_issue",
          repo: "owner/repo",
          issue_number: issue,
          state: issueState,
          synced_at: "2026-08-01T00:00:00.000Z",
        }],
      }],
      acceptance_criteria: [{ id: "AC-1", subject_ref: "T-1", story_refs: [storyRef], text: "Observable test acceptance" }],
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: [],
      decisions: [],
    },
  };
}

function remoteSnapshot({ state = "open", expiresAt = FRESH_EXPIRY, complete = true, issue = 17 } = {}) {
  return {
    version: 1,
    source: "github",
    repository: "owner/repo",
    collected_at: NOW,
    expires_at: expiresAt,
    complete,
    query_coverage: { issues: true, pull_requests: true },
    issues: [{ number: issue, state, url: `https://github.com/owner/repo/issues/${issue}` }],
    pull_requests: [],
  };
}

function repositoryInput(overrides = {}) {
  return {
    now: NOW,
    scope: { kind: "repository" },
    programs: [packet()],
    story_ids: ["US-001"],
    remote_snapshot: remoteSnapshot(),
    audit_signal: { status: "fresh", required_actions: [], advisory_actions: [], audits: [] },
    plan_snapshot: { complete: true, plans: [{ id: "plan-current", state: "execute", current: true }] },
    branch_snapshot: { collected_at: NOW, expires_at: FRESH_EXPIRY, complete: true, branches: [] },
    pr_snapshot: { collected_at: NOW, expires_at: FRESH_EXPIRY, complete: true, pull_requests: [] },
    ...overrides,
  };
}

function finding(report, kind) {
  return report.findings.find((entry) => entry.kind === kind);
}

// Local Program lifecycle is canonical. Fresh GitHub-open is mirror drift and
// produces an exact confirmation-required close action.
{
  const report = evaluateTruthSurfaceConvergence(repositoryInput());
  const drift = finding(report, "local_terminal_remote_open");
  assert.equal(report.required, true);
  assert.equal(report.satisfied, false);
  assert.equal(report.status, "drift");
  assert.equal(drift?.disposition, "actionable");
  assert.deepEqual(report.actions.find((entry) => entry.kind === "github_issue_close")?.target, {
    repo: "owner/repo",
    issue_number: 17,
  });
  assert.equal(report.actions.find((entry) => entry.kind === "github_issue_close")?.confirmation_required, true);
}

// Explicit deferral remains visible but is not silently upgraded to closure.
{
  const report = evaluateTruthSurfaceConvergence(repositoryInput({ programs: [packet({ lifecycle: "deferred" })] }));
  assert.equal(finding(report, "local_terminal_remote_open")?.disposition, "acknowledged_deferred");
  assert.equal(report.actions.some((entry) => entry.kind === "github_issue_close"), false);
}

// Remote closed with a locally active ticket is an authority conflict requiring
// local review, not permission to rewrite Program lifecycle.
{
  const report = evaluateTruthSurfaceConvergence(repositoryInput({
    programs: [packet({ lifecycle: "in_progress" })],
    remote_snapshot: remoteSnapshot({ state: "closed" }),
  }));
  assert.equal(finding(report, "remote_closed_local_nonterminal")?.disposition, "actionable");
  assert.equal(report.actions.some((entry) => entry.kind === "program_ticket_review"), true);
}

// Missing, stale, and partial remote observations are indeterminate when the
// scoped packet needs a remote mirror; packet cached state cannot satisfy truth.
for (const [label, snapshot] of [
  ["missing", null],
  ["expired", remoteSnapshot({ expiresAt: STALE_EXPIRY })],
  ["partial", remoteSnapshot({ complete: false })],
]) {
  const report = evaluateTruthSurfaceConvergence(repositoryInput({ remote_snapshot: snapshot }));
  assert.equal(finding(report, "remote_snapshot_unusable")?.disposition, "indeterminate", label);
  assert.equal(report.status, "indeterminate", label);
}

// Local-only Program scope never invents a remote requirement.
{
  const report = evaluateTruthSurfaceConvergence({
    ...repositoryInput({
      scope: { kind: "program", program_id: "PGM-TEST" },
      programs: [packet({ issue: null, remoteMode: "local-only" })],
      remote_snapshot: null,
      branch_snapshot: null,
      pr_snapshot: null,
      plan_snapshot: null,
    }),
  });
  assert.equal(finding(report, "remote_snapshot_unusable"), undefined);
  assert.equal(report.satisfied, false); // Program status still disagrees with its terminal ticket lattice.
}

// Story identity is checked across Program, epic, ticket, and criterion refs.
{
  const report = evaluateTruthSurfaceConvergence(repositoryInput({ programs: [packet({ storyRef: "US-GHOST" })] }));
  const ghosts = report.findings.filter((entry) => entry.kind === "unknown_story_ref");
  assert.equal(ghosts.length, 4);
  assert(ghosts.every((entry) => entry.disposition === "actionable"));
}

// Cross-Program prerequisites are evaluated from canonical sibling packets even
// when the convergence scope contains only the dependent Program.
{
  const primary = packet({ issue: null, remoteMode: "local-only", lifecycle: "in_progress" });
  primary.packet.tickets[0].external_prerequisites = [{
    program_ref: "PGM-PREREQUISITE",
    ticket_ref: "T-GRADER",
    required_lifecycle: "closed",
  }];
  const prerequisite = {
    path: "plans/programs/prerequisite/program_packet.json",
    packet: {
      id: "PGM-PREREQUISITE",
      title: "Prerequisite",
      goal: "Supply the grader",
      status: "deferred",
      remote_mode: "local-only",
      story_refs: ["US-001"],
      epics: [],
      tickets: [{ id: "T-GRADER", lifecycle: "deferred", story_refs: ["US-001"] }],
      acceptance_criteria: [],
      verification_matrix: [],
    },
  };
  const report = evaluateTruthSurfaceConvergence(repositoryInput({
    scope: { kind: "program", program_id: "PGM-TEST" },
    programs: [primary, prerequisite],
    remote_snapshot: null,
    branch_snapshot: null,
    pr_snapshot: null,
    plan_snapshot: null,
  }));
  const drift = finding(report, "external_prerequisite_unsatisfied");
  assert.equal(drift?.disposition, "actionable");
  assert.equal(drift?.subject?.ticket_id, "T-1");
  assert.equal(drift?.subject?.prerequisite_ticket_id, "T-GRADER");
}

// An active Program with zero active tickets is surfaced with the canonical next
// gate action rather than being directly rewritten.
{
  const report = evaluateTruthSurfaceConvergence(repositoryInput({ remote_snapshot: remoteSnapshot({ state: "closed" }) }));
  const drift = finding(report, "program_status_ticket_lattice_drift");
  assert.equal(drift?.disposition, "actionable");
  assert.equal(report.actions.some((entry) =>
    entry.kind === "program_gate" && entry.payload?.gate === "execution-to-program-validate"), true);
}

// VALIDATING with an unmet Program-level proof is an honest gate wait, not
// lifecycle drift that the reconciler may bypass.
{
  const report = evaluateTruthSurfaceConvergence(repositoryInput({
    programs: [packet({ status: "validating" })],
    remote_snapshot: remoteSnapshot({ state: "closed" }),
  }));
  assert.equal(finding(report, "program_status_ticket_lattice_drift"), undefined);
  assert.equal(finding(report, "program_validation_pending")?.disposition, "advisory");
  assert.equal(report.actions.some((entry) => entry.kind === "program_gate"), false);
}

// Required audit debt participates in repository close truth; recommendations do not.
{
  const report = evaluateTruthSurfaceConvergence(repositoryInput({
    audit_signal: {
      status: "stale_required",
      required_actions: [{ audit_type: "regression", workflow: "/regression-audit", reason: "7 commits stale" }],
      advisory_actions: [{ audit_type: "user-story", workflow: "/red-team-user-story-audit", reason: "recommended" }],
      audits: [],
    },
  }));
  assert.equal(finding(report, "required_audit_stale")?.disposition, "actionable");
  assert.equal(report.actions.some((entry) => entry.kind === "run_workflow" && entry.payload?.workflow === "/regression-audit"), true);
}

// Repository scope requires usable branch/PR/plan observations and makes
// unresolved branches/PRs explicit confirmation or decision actions.
{
  const report = evaluateTruthSurfaceConvergence(repositoryInput({
    plan_snapshot: {
      complete: true,
      plans: [
        { id: "plan-current", state: "execute", current: true },
        { id: "plan-orphan", state: "reflect", current: false },
      ],
    },
    branch_snapshot: {
      collected_at: NOW,
      expires_at: FRESH_EXPIRY,
      complete: true,
      branches: [
        { name: "origin/merged", classification: "MERGED_EQUIVALENT", disposition: "actionable" },
        { name: "origin/unique", classification: "WHOLLY_UNMERGED", disposition: "indeterminate" },
      ],
    },
    pr_snapshot: {
      collected_at: NOW,
      expires_at: FRESH_EXPIRY,
      complete: true,
      pull_requests: [
        { repo: "owner/repo", number: 204, state: "open", head_in_main: true },
        { repo: "owner/repo", number: 206, state: "open", head_in_main: false },
      ],
    },
  }));
  assert.equal(finding(report, "orphan_plan")?.disposition, "actionable");
  assert.equal(report.actions.some((entry) => entry.kind === "remote_branch_delete" && entry.confirmation_required), true);
  assert.equal(report.actions.some((entry) => entry.kind === "github_pr_close" && entry.target?.number === 204), true);
  assert.equal(report.findings.some((entry) => entry.kind === "branch_disposition_required" && entry.disposition === "indeterminate"), true);
  assert.equal(report.findings.some((entry) => entry.kind === "pr_disposition_required" && entry.disposition === "indeterminate"), true);
}

// Unrelated legacy plans remain compatible and do not require invented inputs.
{
  const report = evaluateTruthSurfaceConvergence({ now: NOW, scope: { kind: "none" } });
  assert.deepEqual({ required: report.required, satisfied: report.satisfied, status: report.status }, {
    required: false,
    satisfied: true,
    status: "not_required",
  });
}

// Canonical ordering and digest/receipt identity are stable under input order.
{
  const left = evaluateTruthSurfaceConvergence(repositoryInput({
    programs: [packet({ id: "PGM-B", issue: 18 }), packet({ id: "PGM-A", issue: 17 })],
    remote_snapshot: {
      ...remoteSnapshot(),
      issues: [
        { number: 18, state: "open", url: "https://github.com/owner/repo/issues/18" },
        { number: 17, state: "open", url: "https://github.com/owner/repo/issues/17" },
      ],
    },
  }));
  const right = evaluateTruthSurfaceConvergence(repositoryInput({
    programs: [packet({ id: "PGM-A", issue: 17 }), packet({ id: "PGM-B", issue: 18 })],
    remote_snapshot: {
      ...remoteSnapshot(),
      issues: [
        { number: 17, state: "open", url: "https://github.com/owner/repo/issues/17" },
        { number: 18, state: "open", url: "https://github.com/owner/repo/issues/18" },
      ],
    },
  }));
  assert.equal(left.input_digest, right.input_digest);
  assert.equal(left.receipt_id, right.receipt_id);
  assert.deepEqual(left.actions, right.actions);
}

// Local receipt writing is idempotent and does not churn mtime/bytes.
{
  const dir = mkdtempSync(join(tmpdir(), "truth-surface-receipt-"));
  const path = join(dir, "receipt.json");
  const report = evaluateTruthSurfaceConvergence(repositoryInput());
  const first = writeTruthSurfaceReceipt(path, report);
  const beforeBytes = readFileSync(path, "utf-8");
  const beforeMtime = statSync(path).mtimeMs;
  const second = writeTruthSurfaceReceipt(path, report);
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(readFileSync(path, "utf-8"), beforeBytes);
  assert.equal(statSync(path).mtimeMs, beforeMtime);
}

console.log("truth surface convergence tests: PASS");
