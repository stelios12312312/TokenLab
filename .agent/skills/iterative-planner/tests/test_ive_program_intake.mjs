#!/usr/bin/env node
// test_ive_program_intake.mjs - IVE packet to Program Manager intake coverage.

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  mapIvePacketToProgramIntake,
  runIveProgramIntake,
} from "../scripts/lib/ive_program_intake.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..");
const cliPath = join(testDir, "..", "scripts", "ive_program_intake.mjs");
const NODE = process.execPath;

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
  return mkdtempSync(join(tmpdir(), "ive-program-intake-"));
}

function baseProgram() {
  return {
    version: 1,
    id: "PGM-IVE-INTAKE",
    title: "IVE Intake Fixture",
    status: "design",
    goal: "Test IVE packet to Program Manager intake.",
    story_refs: ["US-044", "US-077", "US-079", "US-080"],
    epics: [
      {
        id: "EP-IVE",
        title: "IVE core",
        story_refs: ["US-044", "US-077", "US-079", "US-080"],
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
  };
}

function writeProgram(tmp) {
  const dir = join(tmp, "plans", "programs", "ive-intake");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "program_packet.json");
  writeFileSync(path, `${JSON.stringify(baseProgram(), null, 2)}\n`, "utf-8");
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function samplePacket(overrides = {}) {
  const ticketRoute = {
    source_finding: "Polymarket Alpha review could discuss opportunity quality without proving price provenance.",
    ontology_fact: "market_reference_or_liquidity_unrouted",
    status: "routed",
    concept_guard: "Alpha claims require entry/reference price, known-at-time market snapshot, liquidity, and no inspected future price move.",
    valid_next_action: "ticket_now",
    acceptance_criteria: [
      "Ticket identifies entry price, reference price, market timestamp, and unavailable provenance fields.",
      "Ticket records whether missing provenance is repaired, deferred, or accepted as a no-alpha limitation.",
    ],
    verification_required: "Market provenance audit with source, timestamp, liquidity, and claim boundary.",
    stop_condition: "After 3 failed provenance checks, route to accept_limitation or a dedicated repair ticket.",
    recurrence_guard: "Program Packet verification row forbids Polymarket alpha tickets from closing without provenance status.",
    story_refs: ["US-044", "US-079"],
    ticket_title: "Repair market provenance intake",
    ticket_ref: "IVE-MARKET-PROVENANCE",
  };
  const acceptedRoute = {
    source_finding: "Current run is diagnostic only and makes no alpha claim.",
    ontology_fact: "diagnostic_only_not_fulfillment",
    status: "accepted",
    concept_guard: "Diagnostic output must not be described as request fulfillment.",
    valid_next_action: "accept_limitation",
    verification_required: "Limitation statement is visible to the operator.",
    stop_condition: "No further report rewrites unless the operator asks for a new experiment.",
    recurrence_guard: "Future closeouts include fulfilled/partial/not-fulfilled status.",
    claim_boundary: "No fulfillment or alpha claim is allowed from this route.",
  };
  return {
    schema_version: 1,
    intent: {
      goal: "Create local Program Manager tickets for IVE ticket-shaped routes",
      story_refs: ["US-080"],
    },
    source_findings: [
      { id: "F-001", summary: ticketRoute.source_finding },
      { id: "F-002", summary: acceptedRoute.source_finding },
    ],
    ontology_facts: [
      {
        ontology_fact: ticketRoute.ontology_fact,
        source_finding: "F-001",
        material: true,
      },
      {
        ontology_fact: acceptedRoute.ontology_fact,
        source_finding: "F-002",
        material: true,
      },
    ],
    concept_dictionary: {
      market_reference_or_liquidity_unrouted: "Market provenance and liquidity remain unresolved.",
      diagnostic_only_not_fulfillment: "Diagnostic output is not request fulfillment.",
    },
    fact_routes: [ticketRoute, acceptedRoute],
    closure_status: "closeable",
    closure_reason: "Ticket-shaped blocker is routed to Program Manager intake and diagnostic limitation is accepted.",
    advisory_review: {
      status: "not_run",
    },
    ...overrides,
  };
}

function mockEnv() {
  return {
    ...process.env,
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
      status: "review_ready",
      summary: "Program intake mapping is review ready.",
      findings: [],
      recommended_actions: [],
    }),
  };
}

function fakeGh() {
  const calls = [];
  return {
    calls,
    runner: (args) => {
      calls.push(args);
      return { status: 1, stdout: "", stderr: "GitHub should not be called" };
    },
  };
}

console.log("\nIVE Program Intake Tests\n");

{
  const mapped = mapIvePacketToProgramIntake(samplePacket(), { env: mockEnv() });
  const mapping = mapped.mappings[0];
  const text = mapping.program_manager_item.text;

  assert(mapped.ok && mapped.status === "PASS", "valid ticket-shaped route maps successfully");
  assert(mapped.ticket_route_count === 1, "only ticket-shaped route is selected");
  assert(mapping.field_coverage.source_finding, "source_finding coverage is recorded");
  assert(mapping.field_coverage.ontology_fact, "ontology_fact coverage is recorded");
  assert(mapping.field_coverage.concept_guard, "concept_guard coverage is recorded");
  assert(mapping.field_coverage.valid_next_action, "valid_next_action coverage is recorded");
  assert(mapping.field_coverage.acceptance_criteria, "acceptance criteria coverage is recorded");
  assert(mapping.field_coverage.verification_required, "verification_required coverage is recorded");
  assert(mapping.field_coverage.stop_condition, "stop_condition coverage is recorded");
  assert(mapping.field_coverage.recurrence_guard, "recurrence_guard coverage is recorded");
  assert(text.includes("Source finding:"), "intake text preserves source finding label");
  assert(text.includes("Ontology fact:"), "intake text preserves ontology fact label");
  assert(text.includes("Acceptance criteria:"), "intake text preserves acceptance criteria label");
  assert(!text.includes("Current run is diagnostic only"), "non-ticket accepted route is not ticketized");
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const before = readFileSync(programPath, "utf-8");
    const gh = fakeGh();
    const result = await runIveProgramIntake(samplePacket(), {
      cwd: tmp,
      program: programPath,
      env: mockEnv(),
      ghRunner: gh.runner,
    });

    assert(result.status === "PASS" && result.dry_run === true, "dry-run succeeds");
    assert(result.program_manager_called === true, "dry-run exercises Program Manager intake");
    assert(result.ticket_intake_receipts.length === 1, "dry-run emits a Ticket Intake Receipt");
    assert(result.ticket_intake_receipts[0].name === "Ticket Intake Receipt", "receipt has canonical name");
    assert(result.ticket_intake_receipts[0].direct_github_creation_allowed === false, "receipt forbids direct GitHub creation");
    assert(result.no_direct_github_write === true, "adapter reports no direct GitHub write");
    assert(gh.calls.length === 0, "dry-run does not call GitHub runner");
    assert(readFileSync(programPath, "utf-8") === before, "dry-run does not mutate Program Packet");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const gh = fakeGh();
    const result = await runIveProgramIntake(samplePacket(), {
      cwd: tmp,
      program: programPath,
      write: true,
      env: mockEnv(),
      ghRunner: gh.runner,
    });
    const packet = readJson(programPath);
    const ticket = packet.tickets[0];
    const ac = packet.acceptance_criteria.find((entry) => entry.id === ticket.acceptance_criteria[0]);
    const vm = packet.verification_matrix.find((entry) => entry.id === ticket.verification_refs[0]);

    assert(result.status === "PASS" && result.write === true, "write mode succeeds");
    assert(result.write_enrichment.updated === true, "write mode enriches local packet");
    assert(packet.tickets.length === 1, "write mode creates one local Program Packet ticket");
    assert(ticket.ive_source.ontology_fact === "market_reference_or_liquidity_unrouted", "ticket stores IVE ontology fact");
    assert(ticket.ive_source.valid_next_action === "ticket_now", "ticket stores IVE next action");
    assert(ac.text.includes("Ticket identifies entry price"), "acceptance row stores IVE acceptance criteria");
    assert(vm.command_or_action.includes("Market provenance audit"), "verification row stores IVE verification requirement");
    assert(vm.pass_means.includes("Stop condition:"), "verification row stores IVE stop condition");
    assert(vm.pass_means.includes("Recurrence guard:"), "verification row stores IVE recurrence guard");
    assert(existsSync(join(tmp, result.program_manager_intake.intake_artifact_paths[0])), "write mode writes local intake artifact");
    assert(gh.calls.length === 0, "write mode does not call GitHub runner");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const packet = samplePacket();
  delete packet.fact_routes[0].acceptance_criteria;
  const mapped = mapIvePacketToProgramIntake(packet, { env: mockEnv() });
  assert(mapped.status === "FAIL", "missing acceptance criteria fails mapping");
  assert(mapped.program_manager_called === false, "mapping failure occurs before Program Manager intake");
  assert(
    mapped.mapping_errors.some((issue) => issue.code === "ticket_route_required_field_missing" && issue.field === "acceptance_criteria"),
    "missing acceptance criteria reports stable issue code",
  );
}

{
  const tmp = makeTemp();
  try {
    const programPath = writeProgram(tmp);
    const packetPath = join(tmp, "ive_packet.json");
    writeFileSync(packetPath, `${JSON.stringify(samplePacket(), null, 2)}\n`, "utf-8");
    const stdout = execFileSync(NODE, [cliPath, "--packet", packetPath, "--program", programPath, "--json"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: mockEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result = JSON.parse(stdout);
    assert(result.status === "PASS", "CLI emits PASS JSON for valid packet");
    assert(result.dry_run === true, "CLI defaults to dry-run");
    assert(result.ticket_intake_receipts.length === 1, "CLI exposes receipt list");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
