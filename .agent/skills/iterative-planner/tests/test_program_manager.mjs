#!/usr/bin/env node
// test_program_manager.mjs — Program Packet validator and gate contracts.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const cli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "program_manager.mjs");
const fixturesDir = join(testDir, "fixtures", "programs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function fixture(name) {
  return join(fixturesDir, name);
}

function run(args, cwd = repoRoot, env = process.env) {
  try {
    const stdout = execFileSync(NODE, [cli, ...args], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-JSON command */ }
    return { ok: true, stdout, parsed };
  } catch (error) {
    const stdout = error.stdout || "";
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* ignore */ }
    return { ok: false, stdout, stderr: error.stderr || "", parsed };
  }
}

function hasError(result, code) {
  return (result.parsed?.errors || []).some((entry) => entry.code === code);
}

console.log("\nProgram Manager Contracts\n");

assert(existsSync(cli), "program_manager.mjs exists");

let result = run(["check", "--program", fixture("valid_ready.json"), "--json"]);
assert(result.ok && result.parsed.status === "PASS", "valid Program Packet passes check");
assert(result.parsed.counts.tickets === 1, "valid Program Packet reports ticket count");

result = run(["verify", "design-to-ready", "--program", fixture("valid_ready.json"), "--json"]);
assert(result.ok && result.parsed.status === "PASS", "design-to-ready accepts a traceable ready packet");

result = run(["verify", "ready-to-execution", "--program", fixture("valid_ready.json"), "--json"]);
assert(result.ok && result.parsed.status === "PASS", "ready-to-execution accepts ready ticket evidence");

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-transition-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.status = "design";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["verify", "design-to-ready", "--program", packetPath, "--json"], tmp);
    assert(result.ok && result.parsed?.program_status_transition?.transition_written === false, "verify dry-run reports but does not write status transition");
    assert(JSON.parse(readFileSync(packetPath, "utf-8")).status === "design", "verify dry-run leaves Program Packet status unchanged");

    result = run(["verify", "design-to-ready", "--program", packetPath, "--write", "--json"], tmp);
    const writtenPacket = JSON.parse(readFileSync(packetPath, "utf-8"));
    assert(result.ok && result.parsed?.program_status_transition?.transition_written === true, "verify --write advances program status on passing gate");
    assert(result.parsed.program_status_transition.previous_status === "design", "status transition reports previous status");
    assert(result.parsed.program_status_transition.new_status === "ready", "status transition reports new status");
    assert(writtenPacket.status === "ready", "verify --write persists advanced program status");

    result = run(["verify", "design-to-ready", "--program", packetPath, "--write", "--json"], tmp);
    assert(result.ok && result.parsed?.program_status_transition?.transition_written === false, "verify --write is idempotent when target status is already current");

    writtenPacket.status = "executing";
    writeFileSync(packetPath, `${JSON.stringify(writtenPacket, null, 2)}\n`, "utf-8");
    result = run(["verify", "design-to-ready", "--program", packetPath, "--write", "--json"], tmp);
    assert(result.ok && result.parsed?.program_status_transition?.status === "already_past_gate", "design-to-ready is idempotent when program status is already past ready");
    assert(JSON.parse(readFileSync(packetPath, "utf-8")).status === "executing", "design-to-ready --write does not downgrade executing program status");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-transition-fail-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("missing_epic_story.json"), "utf-8"));
    packet.status = "design";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["verify", "design-to-ready", "--program", packetPath, "--write", "--json"], tmp);
    assert(!result.ok && result.parsed?.program_status_transition?.transition_written === false, "verify --write does not transition failed gates");
    assert(JSON.parse(readFileSync(packetPath, "utf-8")).status === "design", "failed verify --write leaves Program Packet status unchanged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-review-state-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.tickets[0].lifecycle = "review_ready";
    packet.tickets[0].review_status = "submitted";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp);
    assert(result.ok && result.parsed.status === "PASS", "review lifecycle aliases validate without becoming execution lifecycle states");

    const facts = run(["facts", "--program", packetPath], tmp);
    assert(facts.ok && facts.stdout.includes("ticket_lifecycle('T-001', 'proposed')"), "review lifecycle aliases emit proposed effective lifecycle facts");

    packet.tickets[0].review_status = "nonsense";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    result = run(["check", "--program", packetPath, "--json"], tmp);
    assert(!result.ok && hasError(result, "ticket_invalid_review_status"), "invalid ticket review_status fails validation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

result = run(["facts", "--program", fixture("valid_ready.json")]);
assert(result.ok && result.stdout.includes("program('PGM-TEST'"), "facts command emits program facts");
assert(result.stdout.includes("ticket('T-001'"), "facts command emits ticket facts");

result = run(["check", "--program", fixture("missing_epic_story.json"), "--json"]);
assert(!result.ok && hasError(result, "epic_without_story"), "missing epic story fails");
assert(hasError(result, "program_epic_without_story"), "missing epic story also fails through ontology invariant");

result = run(["check", "--program", fixture("migration_without_contract.json"), "--json"]);
assert(!result.ok && hasError(result, "migration_ticket_missing_contract"), "migration without compatibility contract fails");

result = run(["check", "--program", fixture("delete_without_census.json"), "--json"]);
assert(!result.ok && hasError(result, "delete_move_ticket_missing_census"), "delete/move ticket without census fails");

result = run(["check", "--program", fixture("canonical_delete_without_replacement.json"), "--json"]);
assert(!result.ok && hasError(result, "canonical_delete_without_replacement"), "canonical delete without replacement decision fails");

result = run(["check", "--program", fixture("dependency_cycle.json"), "--json"]);
assert(!result.ok && hasError(result, "ticket_dependency_cycle"), "dependency cycle fails");

result = run(["verify", "execution-to-program-validate", "--program", fixture("child_plan_dir_missing.json"), "--json"]);
assert(!result.ok && hasError(result, "required_child_plan_dir_missing"), "verified ticket with fabricated child_plan dir fails");
assert(!result.ok && !hasError(result, "required_child_plan_not_closed"), "missing-dir failure does not double-emit required_child_plan_not_closed");

// F-001 null-path closure: verified ticket with plan_dir=null + inline state=closed must FAIL with the new error code.
// The check fires BEFORE required_child_plan_dir_missing because plan_dir presence is checked first.
result = run(["verify", "execution-to-program-validate", "--program", fixture("child_plan_dir_required.json"), "--json"]);
assert(!result.ok && hasError(result, "required_child_plan_dir_required"), "verified ticket with null plan_dir fails validation (F-001)");
assert(!result.ok && !hasError(result, "required_child_plan_dir_missing"), "null-path failure is distinct from missing-path failure");
assert(!result.ok && !hasError(result, "required_child_plan_not_closed"), "null-path failure does not fall through to not_closed");

// F-010 closure: parameterized validator-invariant test.
//
// Enumerates policy=required × lifecycle × falsy-plan_dir to catch the next
// "N branches for N+1 modes" regression structurally rather than waiting for a
// red-team audit to find it. The base fixture is the F-001 child_plan_dir_required
// shape; we mutate plan_dir and lifecycle in memory and write to tmpdirs.
{
  const baseFixture = JSON.parse(readFileSync(fixture("child_plan_dir_required.json"), "utf-8"));
  const FALSY_PLAN_DIRS = [null, ""];
  const LIFECYCLES_THAT_FIRE = ["verified", "closed"];
  const LIFECYCLES_THAT_DO_NOT_FIRE = ["draft", "in_progress", "ready", "done"];
  const EXPECTED_CODE = "required_child_plan_dir_required";

  function cloneWith(planDir, lifecycle) {
    const copy = JSON.parse(JSON.stringify(baseFixture));
    copy.tickets[0].lifecycle = lifecycle;
    copy.tickets[0].child_plan.plan_dir = planDir;
    return copy;
  }

  for (const lifecycle of LIFECYCLES_THAT_FIRE) {
    for (const planDir of FALSY_PLAN_DIRS) {
      const tmp = mkdtempSync(join(tmpdir(), "f010-fire-"));
      try {
        const packetPath = join(tmp, "program_packet.json");
        writeFileSync(packetPath, JSON.stringify(cloneWith(planDir, lifecycle)));
        const r = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"]);
        const planDirLabel = planDir === null ? "null" : '""';
        assert(!r.ok && hasError(r, EXPECTED_CODE),
          `F-010: policy=required + lifecycle=${lifecycle} + plan_dir=${planDirLabel} emits ${EXPECTED_CODE}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  // Boundary: when lifecycle is not verified/closed, the validator must NOT
  // fire even with a falsy plan_dir. Catches the symmetric regression class
  // where someone widens VERIFIED_OR_CLOSED without re-checking branch coverage.
  for (const lifecycle of LIFECYCLES_THAT_DO_NOT_FIRE) {
    const tmp = mkdtempSync(join(tmpdir(), "f010-skip-"));
    try {
      const packetPath = join(tmp, "program_packet.json");
      writeFileSync(packetPath, JSON.stringify(cloneWith(null, lifecycle)));
      const r = run(["check", "--program", packetPath, "--json"]);
      const codes = (r.parsed?.errors || []).map((e) => e.code);
      assert(!codes.includes(EXPECTED_CODE),
        `F-010: policy=required + lifecycle=${lifecycle} + plan_dir=null does NOT emit ${EXPECTED_CODE}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-childplan-"));
  try {
    const childPlanDir = join(tmp, "plans", "plan_child_open");
    const fixtureSrc = JSON.parse(readFileSync(fixture("child_plan_not_closed.json"), "utf-8"));
    // Materialize a real on-disk child plan dir whose state is not CLOSE.
    const stateDir = join(childPlanDir);
    const fsLib = await import("fs");
    fsLib.mkdirSync(stateDir, { recursive: true });
    fsLib.writeFileSync(join(stateDir, "state.json"), JSON.stringify({ state: "EXECUTE" }));
    fixtureSrc.tickets[0].child_plan.plan_dir = "plan_child_open";
    delete fixtureSrc.tickets[0].child_plan.state;
    const packetPath = join(tmp, "program_packet.json");
    fsLib.writeFileSync(packetPath, JSON.stringify(fixtureSrc));
    const r = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"], tmp);
    assert(!r.ok && hasError(r, "required_child_plan_not_closed"), "verified ticket with real-but-open child plan dir fails with not_closed");
    assert(!r.ok && !hasError(r, "required_child_plan_dir_missing"), "real-dir + open-state path does not emit dir_missing");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

result = run(["verify", "validate-to-program-close", "--program", fixture("program_close_deferred_missing_decision.json"), "--json"]);
assert(!result.ok && hasError(result, "deferred_ticket_missing_decision"), "program close with undecided deferral fails");

result = run(["verify", "validate-to-program-close", "--program", fixture("program_close_child_plan_missing.json"), "--json"]);
assert(!result.ok && hasError(result, "required_child_plan_dir_missing"), "closed program with fabricated child_plan dir fails JS validation");
assert(!result.ok && hasError(result, "program_child_plan_not_closed"), "closed program with fabricated child_plan dir fails ontology validation");

{
  function closedReviewPacket(mutator = () => {}) {
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.status = "closed";
    packet.tickets[0].lifecycle = "closed";
    packet.tickets[0].child_plan = { policy: "not_required", plan_dir: null, reason: "Fixture" };
    packet.verification_matrix[0].result = "pass";
    packet.acceptance_criteria.push({
      id: "AC-PGM",
      scope: "program",
      subject_ref: "PGM-TEST",
      text: "Program close has passing evidence.",
      story_refs: ["US-001"],
      maintenance_rationale: null,
    });
    packet.verification_matrix.push({
      id: "VM-PGM",
      scope: "program",
      subject_ref: "PGM-TEST",
      acceptance_criterion_ref: "AC-PGM",
      proof_type: "proof:artifact_review",
      command_or_action: "Review program close fixture",
      pass_means: "Program row passes",
      result: "pass",
    });
    mutator(packet);
    return packet;
  }

  const cases = [
    [
      "review-not-run",
      (packet) => { packet.tickets[0].review_status = "not_run"; },
      "ticket_closure_review_not_run",
      "program_ticket_review_not_run",
      "closed ticket with review_status:not_run fails closure",
    ],
    [
      "persona-needs-evidence",
      (packet) => { packet.tickets[0].persona_review = { status: "needs_evidence" }; },
      "ticket_closure_persona_review_needs_evidence",
      "program_ticket_persona_review_needs_evidence",
      "closed ticket with persona_review.status:needs_evidence fails closure",
    ],
  ];
  for (const [name, mutator, jsCode, ontologyCode, label] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), `program-manager-close-${name}-`));
    try {
      const packetPath = join(tmp, "program_packet.json");
      writeFileSync(packetPath, `${JSON.stringify(closedReviewPacket(mutator), null, 2)}\n`, "utf-8");
      const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], tmp);
      assert(!r.ok && hasError(r, jsCode), `${label} through JS validation`);
      assert(!r.ok && hasError(r, ontologyCode), `${label} through ontology validation`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const reviewReadyTmp = mkdtempSync(join(tmpdir(), "program-manager-close-review-ready-"));
  try {
    const packetPath = join(reviewReadyTmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(closedReviewPacket((packet) => {
      packet.tickets[0].review_status = "review_ready";
      packet.tickets[0].persona_review = { status: "accepted" };
    }), null, 2)}\n`, "utf-8");
    const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], reviewReadyTmp);
    assert(r.ok && r.parsed?.status === "PASS", "closed ticket with review_ready/accepted review metadata passes");
  } finally {
    rmSync(reviewReadyTmp, { recursive: true, force: true });
  }

  const writeFailTmp = mkdtempSync(join(tmpdir(), "program-manager-close-write-fail-"));
  try {
    const packetPath = join(writeFailTmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(fixture("program_close_child_plan_missing.json"), "utf-8"));
    packet.status = "validating";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
    const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--write", "--json"], writeFailTmp);
    const writtenPacket = JSON.parse(readFileSync(packetPath, "utf-8"));
    assert(!r.ok && r.parsed?.program_status_transition?.transition_written === false, "failed validate-to-program-close --write does not persist closed status");
    assert(writtenPacket.status === "validating", "failed program close --write leaves Program Packet status unchanged");
  } finally {
    rmSync(writeFailTmp, { recursive: true, force: true });
  }
}

// Closed-ticket verification truth: final ticket lifecycles cannot keep stale
// failed or blank row results just because the program-level row passes.
{
  function closedPacketWithTicketResult(value, { omitResult = false } = {}) {
    const packet = JSON.parse(readFileSync(fixture("valid_ready.json"), "utf-8"));
    packet.status = "closed";
    packet.tickets[0].lifecycle = "closed";
    packet.acceptance_criteria.push({
      id: "AC-PGM",
      scope: "program",
      subject_ref: "PGM-TEST",
      text: "Program close has passing evidence.",
      story_refs: ["US-001"],
      maintenance_rationale: null,
    });
    if (omitResult) delete packet.verification_matrix[0].result;
    else packet.verification_matrix[0].result = value;
    packet.verification_matrix.push({
      id: "VM-PGM",
      scope: "program",
      subject_ref: "PGM-TEST",
      acceptance_criterion_ref: "AC-PGM",
      proof_type: "proof:artifact_review",
      command_or_action: "Review program close fixture",
      pass_means: "Program row passes",
      result: "pass",
    });
    return packet;
  }

  const cases = [
    ["fail", { omitResult: false }, "failing"],
    ["pass", { omitResult: true }, "blank"],
  ];
  for (const [value, options, label] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), `program-manager-ticket-vm-${label}-`));
    try {
      const packetPath = join(tmp, "program_packet.json");
      writeFileSync(packetPath, `${JSON.stringify(closedPacketWithTicketResult(value, options), null, 2)}\n`, "utf-8");
      const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], tmp);
      assert(!r.ok && hasError(r, "ticket_verification_not_passed"), `closed ticket with ${label} verification row fails JS validation`);
      assert(!r.ok && hasError(r, "program_ticket_verification_not_passed"), `closed ticket with ${label} verification row fails ontology validation`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), "program-manager-ticket-vm-waived-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(closedPacketWithTicketResult("accepted_risk"), null, 2)}\n`, "utf-8");
    const r = run(["verify", "validate-to-program-close", "--program", packetPath, "--json"], tmp);
    assert(r.ok && r.parsed?.status === "PASS", "closed ticket with accepted_risk verification row is allowed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const tmp = mkdtempSync(join(tmpdir(), "program-manager-skip-"));
try {
  result = run(["check", "--json"], tmp);
  assert(result.ok && result.parsed.status === "SKIP", "missing Program Packet returns SKIP");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-init-"));
  try {
    result = run(["init", "--program", "z1-m3", "--title", "Z1 M3", "--goal", "Coordinate Z1 M3 work.", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "z1-m3", "program_packet.json");
    const packet = JSON.parse(readFileSync(packetPath, "utf-8"));
    assert(result.ok && result.parsed.status === "PASS", "init creates a Program Packet");
    assert(packet.version === 1 && packet.status === "design", "init writes valid base packet metadata");
    assert(Array.isArray(packet.tickets) && Array.isArray(packet.verification_matrix), "init writes required empty arrays");
    const check = run(["check", "--program", packetPath, "--json"], tmp);
    assert(check.ok && check.parsed.status === "PASS", "init output passes Program Manager check");
    const overwrite = run(["init", "--program", "z1-m3", "--json"], tmp);
    assert(!overwrite.ok && /already exists/.test(overwrite.parsed?.error || overwrite.stderr), "init refuses accidental overwrite");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-remediate-"));
  try {
    const init = run(["init", "--program", "remediate", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "remediate", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "remediation fixture initializes a packet");
    const mock = JSON.stringify({
      status: "blocked",
      summary: "Needs a story link",
      findings: [{ id: "DS-001", status: "needs_story", message: "No story linked" }],
      recommended_actions: ["Link one or more stories to the ticket using /story-bootstrap"],
    });
    const intake = run([
      "intake",
      "--program",
      packetPath,
      "--from-text",
      "Add a Program Manager remediation feature without a story ref",
      "--write",
      "--llm-review",
      "--json",
    ], tmp, { PLANNER_DRIFT_LLM_MOCK_RESPONSE: mock });
    assert(intake.ok, "remediation fixture writes a blocked advisory intake artifact");
    const dryRun = run(["check", "--program", packetPath, "--remediate", "--json"], tmp);
    assert(dryRun.ok && dryRun.parsed?.remediation?.task_count >= 1, "--remediate dry-run emits task packets");
    assert((dryRun.parsed?.remediation?.tasks || []).some((task) => task.workflow === "/story-bootstrap"), "--remediate maps story recommendations to story-bootstrap");
    const write = run(["check", "--program", packetPath, "--remediate", "--write", "--json"], tmp);
    assert(write.ok && existsSync(join(tmp, write.parsed?.remediation?.artifact_path || "")), "--remediate --write writes a remediation artifact");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-intake-preserve-"));
  try {
    const init = run(["init", "--program", "preserve", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "preserve", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "preserve fixture initializes a packet");
    const sourceText = "Update planner workflow migration in .agent/skills/iterative-planner/scripts/program_manager.mjs with US-077 traceability.";
    const mock = JSON.stringify({
      status: "review_ready",
      summary: "Mock advisory.",
      findings: [],
      recommended_actions: [],
    });
    const first = run([
      "intake",
      "--program", packetPath,
      "--from-text", sourceText,
      "--title", "Preserve custom proof rows",
      "--write",
      "--json",
    ], tmp, { PLANNER_DRIFT_LLM_MOCK_RESPONSE: mock });
    const ticketId = first.parsed?.candidate_ticket?.id;
    const acceptanceId = first.parsed?.candidate_ticket?.acceptance_criteria?.[0];
    const verificationId = first.parsed?.candidate_ticket?.verification_refs?.[0];
    assert(first.ok && ticketId && acceptanceId && verificationId, "preserve fixture creates intake ticket");

    const packet = JSON.parse(readFileSync(packetPath, "utf-8"));
    const acceptance = packet.acceptance_criteria.find((entry) => entry.id === acceptanceId);
    const verification = packet.verification_matrix.find((entry) => entry.id === verificationId);
    acceptance.text = "Custom preserved acceptance row requires ripple_check and test_migration evidence.";
    verification.proof_type = "proof:test";
    verification.command_or_action = "node .agent/skills/iterative-planner/scripts/ripple_check.mjs && node .agent/skills/iterative-planner/tests/test_migration.mjs";
    verification.pass_means = "ripple_check and test_migration pass before the ticket can become ready.";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    const repeat = run([
      "intake",
      "--program", packetPath,
      "--from-text", sourceText,
      "--title", "Preserve custom proof rows",
      "--write",
      "--json",
    ], tmp, { PLANNER_DRIFT_LLM_MOCK_RESPONSE: mock });
    assert(repeat.ok && repeat.parsed?.candidate_ticket?.id === ticketId, "repeat intake updates the same ticket");
    assert(repeat.parsed?.verification_rows?.[0]?.command_or_action?.includes("ripple_check.mjs"), "repeat intake preserves custom verification command");
    assert(repeat.parsed?.ticket_intake_receipt?.retro_recurrence_status === "pass", "preserved proof row satisfies recurrence guard");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// T-INTAKE-D451770E closure: --auto-story dry-run + dedup behavior.
// Uses PLANNER_DRIFT_LLM_MOCK_RESPONSE / PLANNER_DRIFT_LLM_MOCK_ERROR to
// control the LLM advisory deterministically — no live API calls.
{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-auto-story-"));
  try {
    const init = run(["init", "--program", "auto-story", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "auto-story", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "auto-story fixture initializes a packet");
    const registryPath = join(tmp, "reports", "user_story_audit", "story_registry.json");
    const fsLib = await import("fs");
    fsLib.mkdirSync(dirname(registryPath), { recursive: true });
    fsLib.writeFileSync(registryPath, JSON.stringify({ updated: "2026-05-30T00:00:00Z", stories: [], consolidations: [] }, null, 2));

    // Scenario A: --auto-story with mock LLM error -> deterministic fallback path, advisory.available === false
    const failOpen = run([
      "intake",
      "--program", packetPath,
      "--from-text", "Add a Program Manager auto-story feature that drafts review-needed stories",
      "--auto-story",
      "--write",
      "--json",
    ], tmp, { PLANNER_DRIFT_LLM_MOCK_ERROR: "timeout" });
    assert(failOpen.ok && failOpen.parsed?.auto_story?.enabled === true, "--auto-story emits auto_story.enabled=true");
    assert(failOpen.parsed?.auto_story?.advisory?.available === false, "--auto-story fails open when LLM unreachable (mocked error)");
    assert(Array.isArray(failOpen.parsed?.auto_story?.stories), "--auto-story produces a stories array even on fail-open");

    // Scenario B: --auto-story with a successful mock LLM -> story written to registry
    fsLib.writeFileSync(registryPath, JSON.stringify({ updated: "2026-05-30T00:00:00Z", stories: [], consolidations: [] }, null, 2));
    const mockStories = JSON.stringify({
      story_candidates: [
        {
          title: "Auto-story drafting from intake",
          user: "program operator",
          need: "Draft review-needed stories from intake text",
          outcome: "Program tickets carry traceable story refs without manual edits",
          acceptance_criteria: ["Draft stories are marked NOT_IMPLEMENTED", "Dedup prevents duplicate appends"],
          tags: ["program_manager"],
        },
      ],
    });
    const happyPath = run([
      "intake",
      "--program", packetPath,
      "--from-text", "Add a Program Manager auto-story feature that drafts review-needed stories",
      "--auto-story",
      "--write",
      "--json",
    ], tmp, { PLANNER_DRIFT_LLM_MOCK_RESPONSE: mockStories });
    assert(happyPath.ok && (happyPath.parsed?.auto_story?.story_refs || []).length >= 1, "--auto-story mock LLM produces at least one story ref");
    const updatedRegistry = JSON.parse(fsLib.readFileSync(registryPath, "utf-8"));
    assert(updatedRegistry.stories.length >= 1, "--auto-story writes draft story into story_registry.json");
    const draftStory = updatedRegistry.stories[0];
    assert(draftStory?.status === "NOT_IMPLEMENTED" && (draftStory?.tags || []).includes("draft"), "--auto-story marks drafts as NOT_IMPLEMENTED + draft tag");

    // Scenario C: re-run with identical text + mock should NOT duplicate
    const beforeCount = updatedRegistry.stories.length;
    const repeat = run([
      "intake",
      "--program", packetPath,
      "--from-text", "Add a Program Manager auto-story feature that drafts review-needed stories",
      "--auto-story",
      "--write",
      "--json",
    ], tmp, { PLANNER_DRIFT_LLM_MOCK_RESPONSE: mockStories });
    assert(repeat.ok, "--auto-story repeat invocation succeeds");
    const finalRegistry = JSON.parse(fsLib.readFileSync(registryPath, "utf-8"));
    assert(finalRegistry.stories.length === beforeCount, "--auto-story dedups via source_hash on repeat invocation");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// T-INTAKE-7132C8C3 closure: summarizeLongTitle threshold + override + deterministic fallback.
{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-title-summary-"));
  try {
    const init = run(["init", "--program", "title-summary", "--json"], tmp);
    const packetPath = join(tmp, "plans", "programs", "title-summary", "program_packet.json");
    assert(init.ok && existsSync(packetPath), "title-summary fixture initializes a packet");
    const fsLib = await import("fs");

    // Scenario A: short title (< 70 chars) -> no summarization triggered
    const shortText = "Add a Program Manager flag for short titles. Short and clear.";
    const short = run([
      "intake",
      "--program", packetPath,
      "--from-text", shortText,
      "--write",
      "--json",
    ], tmp);
    const shortTitleSource = short.parsed?.intake_packet?.source?.title_source;
    assert(short.ok && shortTitleSource && shortTitleSource !== "llm_summary" && shortTitleSource !== "deterministic_summary", "short title does not trigger summarization");

    // Scenario B: long title (> 70 chars) + LLM mocked error -> deterministic_summary path
    const longText = "Add a Program Manager that handles arbitrarily long intake text without crashing or producing chopped truncated titles for the operator to manually rewrite later when triaging the backlog";
    const longFallback = run([
      "intake",
      "--program", packetPath,
      "--from-text", longText,
      "--write",
      "--json",
    ], tmp, { PLANNER_DRIFT_LLM_MOCK_ERROR: "timeout" });
    const fallbackTitleSource = longFallback.parsed?.intake_packet?.source?.title_source;
    const fallbackTitle = longFallback.parsed?.intake_packet?.source?.title;
    assert(longFallback.ok && fallbackTitleSource === "deterministic_summary", "long title without LLM uses deterministic_summary fallback");
    assert(fallbackTitle && fallbackTitle.length <= 70 && !fallbackTitle.endsWith("..."), "deterministic fallback title is concise and does not end with ellipsis");

    // Scenario C: long title with explicit --title -> override wins; no summarization
    const override = run([
      "intake",
      "--program", packetPath,
      "--from-text", longText,
      "--title", "Explicit Override Title",
      "--write",
      "--json",
    ], tmp);
    const overrideTitleSource = override.parsed?.intake_packet?.source?.title_source;
    const overrideTitle = override.parsed?.intake_packet?.source?.title;
    assert(override.ok && overrideTitle === "Explicit Override Title", "--title explicit override is preserved");
    assert(overrideTitleSource !== "llm_summary" && overrideTitleSource !== "deterministic_summary", "--title override skips summarization entirely");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Forward-reasoning queries — Phase 1 of ritual elimination.
const dispatchChain = fixture("dispatch_chain.json");

result = run(["dispatch-order", "--program", dispatchChain, "--json"]);
const dispatchOrderIds = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && JSON.stringify(dispatchOrderIds) === JSON.stringify(["T-A", "T-B", "T-C", "T-D"]), "dispatch-order returns the full dependency-aware ticket order");

result = run(["next-ready", "--program", dispatchChain, "--json"]);
const nextReadyIds = (result.parsed?.tickets || []).map((entry) => entry.id).sort();
assert(result.ok && JSON.stringify(nextReadyIds) === JSON.stringify(["T-B", "T-D"]), "next-ready returns the unblocked ready tickets");

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-done-dep-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(dispatchChain, "utf-8"));
    packet.tickets.find((ticket) => ticket.id === "T-A").lifecycle = "done";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["next-ready", "--program", packetPath, "--json"], tmp);
    const doneDepReadyIds = (result.parsed?.tickets || []).map((entry) => entry.id).sort();
    assert(result.ok && JSON.stringify(doneDepReadyIds) === JSON.stringify(["T-D"]), "next-ready does not treat done dependency as verified proof");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

result = run(["blockers", "T-C", "--program", dispatchChain, "--json"]);
const blockerIds = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && blockerIds.includes("T-B"), "blockers returns transitive blocking ticket");

result = run(["unlocks-if-closed", "T-B", "--program", dispatchChain, "--json"]);
const unlockIds = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && unlockIds.includes("T-C"), "unlocks-if-closed returns the ticket newly unblocked by closing T-B");

result = run(["unlocks-if-closed", "T-A", "--program", dispatchChain, "--json"]);
assert(result.ok && (result.parsed?.tickets || []).length === 0, "unlocks-if-closed returns nothing when target is already verified");

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-dep-gate-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const packet = JSON.parse(readFileSync(dispatchChain, "utf-8"));
    packet.status = "executing";
    for (const row of packet.verification_matrix) row.result = "pass";
    packet.tickets.find((ticket) => ticket.id === "T-B").type = "artifact";
    packet.tickets.find((ticket) => ticket.id === "T-C").lifecycle = "verified";
    packet.tickets.find((ticket) => ticket.id === "T-D").type = "artifact";
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"], tmp);
    const depErrors = result.parsed?.errors || [];
    assert(!result.ok && hasError(result, "ticket_dependency_not_verified"), "program validation blocks verified ticket with an unverified dependency");
    assert(depErrors.some((entry) => /T-B/.test(entry.message || "")), "dependency gate names the missing prerequisite");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "program-manager-stage3-dep-gate-"));
  try {
    const packetPath = join(tmp, "program_packet.json");
    const ticketIds = {
      e02: "T-INTAKE-2A496B0A",
      e01: "T-INTAKE-ACB6E1E9",
      e03: "T-INTAKE-CDA31E84",
    };
    const packet = {
      version: 1,
      id: "PGM-STAGE3-GATE",
      title: "Stage 3 dependency gate fixture",
      status: "executing",
      goal: "Prove measured quant tickets cannot validate before keystone dependencies.",
      story_refs: ["US-079"],
      epics: [{
        id: "EP-001",
        title: "Dependency gate",
        story_refs: ["US-079"],
        ticket_refs: [ticketIds.e02, ticketIds.e01, ticketIds.e03],
      }],
      tickets: [
        {
          id: ticketIds.e02,
          epic_id: "EP-001",
          title: "Two-layer gate split still open",
          type: "artifact",
          lifecycle: "ready",
          story_refs: ["US-079"],
          defect_refs: [],
          gap_refs: [],
          depends_on: [],
          acceptance_criteria: ["AC-E02"],
          child_plan: { policy: "not_required", plan_dir: null, reason: "fixture" },
          compatibility_contract_refs: [],
          migration_boundary_refs: [],
          deletion_move_census_refs: [],
          verification_refs: ["VM-E02"],
        },
        {
          id: ticketIds.e01,
          epic_id: "EP-001",
          title: "Bayesian ledger advanced too early",
          type: "artifact",
          lifecycle: "verified",
          story_refs: ["US-079"],
          defect_refs: [],
          gap_refs: [],
          depends_on: [ticketIds.e02],
          acceptance_criteria: ["AC-E01"],
          child_plan: { policy: "not_required", plan_dir: null, reason: "fixture" },
          compatibility_contract_refs: [],
          migration_boundary_refs: [],
          deletion_move_census_refs: [],
          verification_refs: ["VM-E01"],
        },
        {
          id: ticketIds.e03,
          epic_id: "EP-001",
          title: "Stage 3 measured quant ticket advanced too early",
          type: "artifact",
          lifecycle: "verified",
          story_refs: ["US-079"],
          defect_refs: [],
          gap_refs: [],
          depends_on: [ticketIds.e01],
          acceptance_criteria: ["AC-E03"],
          child_plan: { policy: "not_required", plan_dir: null, reason: "fixture" },
          compatibility_contract_refs: [],
          migration_boundary_refs: [],
          deletion_move_census_refs: [],
          verification_refs: ["VM-E03"],
        },
      ],
      acceptance_criteria: [
        { id: "AC-E02", scope: "ticket", subject_ref: ticketIds.e02, text: "e02 exists.", story_refs: ["US-079"], maintenance_rationale: null },
        { id: "AC-E01", scope: "ticket", subject_ref: ticketIds.e01, text: "e01 depends on e02.", story_refs: ["US-079"], maintenance_rationale: null },
        { id: "AC-E03", scope: "ticket", subject_ref: ticketIds.e03, text: "e03 depends on e01.", story_refs: ["US-079"], maintenance_rationale: null },
      ],
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: [
        { id: "VM-E02", scope: "ticket", subject_ref: ticketIds.e02, acceptance_criterion_ref: "AC-E02", proof_type: "proof:artifact_review", command_or_action: "review", pass_means: "ok", result: "pass" },
        { id: "VM-E01", scope: "ticket", subject_ref: ticketIds.e01, acceptance_criterion_ref: "AC-E01", proof_type: "proof:artifact_review", command_or_action: "review", pass_means: "ok", result: "pass" },
        { id: "VM-E03", scope: "ticket", subject_ref: ticketIds.e03, acceptance_criterion_ref: "AC-E03", proof_type: "proof:artifact_review", command_or_action: "review", pass_means: "ok", result: "pass" },
      ],
      decisions: [],
    };
    writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");

    result = run(["verify", "execution-to-program-validate", "--program", packetPath, "--json"], tmp);
    const depErrors = result.parsed?.errors || [];
    assert(!result.ok && hasError(result, "ticket_dependency_not_verified"), "Stage-3 dependency gate blocks measured ticket chain while e02 is open");
    assert(depErrors.some((entry) => /T-INTAKE-2A496B0A/.test(entry.message || "")), "Stage-3 dependency gate names e02 as the missing prerequisite");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

result = run(["next-ready", "--program", fixture("valid_ready.json"), "--json"]);
const validNext = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && validNext.includes("T-001"), "next-ready works on the original valid fixture");

result = run(["blockers", "T-MISSING", "--program", dispatchChain, "--json"]);
assert(result.ok && (result.parsed?.tickets || []).length === 0, "blockers on unknown ticket returns empty list, not error");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
