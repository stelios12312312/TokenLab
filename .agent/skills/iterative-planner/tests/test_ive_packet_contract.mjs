#!/usr/bin/env node
// test_ive_packet_contract.mjs - IVE packet contract validator coverage.

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { validateIvePacket } from "../scripts/lib/ive_packet_contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..");
const validatorCli = join(testDir, "..", "scripts", "ive_packet_validator.mjs");
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

function samplePacket(overrides = {}) {
  return {
    schema_version: 1,
    intent: {
      goal: "Evaluate a planner finding through the IVE packet boundary",
    },
    source_findings: [
      {
        id: "F-001",
        summary: "A deterministic blocker must route to a fact and action",
      },
    ],
    concept_dictionary: {
      deterministic_blocker: "A non-advisory fact that must be fixed, ticketed, or explicitly stopped.",
    },
    fact_routes: [
      {
        source_finding: "F-001",
        ontology_fact: "ive_fact(deterministic_blocker,F-001)",
        status: "routed",
        concept_guard: "deterministic_blocker",
        valid_next_action: "fix_now",
        verification_required: "unit test and CLI proof",
        stop_condition: "validator rejects the invalid packet shape",
        recurrence_guard: "contract test covers this route class",
      },
    ],
    closure_status: "closeable",
    closure_reason: "All material facts have deterministic routes and valid next actions.",
    advisory_review: {
      status: "not_run",
    },
    ...overrides,
  };
}

function errorCodes(result) {
  return new Set((result.errors || []).map((issue) => issue.code));
}

function runCli(packet) {
  const dir = mkdtempSync(join(tmpdir(), "ive-packet-"));
  const packetPath = join(dir, "packet.json");
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));
  try {
    const stdout = execFileSync(NODE, [validatorCli, packetPath, "--json"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exit_code: 0, stdout, parsed: JSON.parse(stdout) };
  } catch (err) {
    const stdout = err.stdout?.toString() || "";
    return {
      exit_code: err.status ?? 1,
      stdout,
      parsed: stdout ? JSON.parse(stdout) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nIVE Packet Contract Tests\n");

{
  const result = validateIvePacket(samplePacket());
  assert(result.ok && result.status === "PASS", "valid packet passes");
  assert(result.errors.length === 0, "valid packet has no errors");
}

{
  const packet = samplePacket();
  delete packet.source_findings;
  const result = validateIvePacket(packet);
  assert(!result.ok, "missing required top-level field fails");
  assert(errorCodes(result).has("required_field_missing"), "missing top-level field reports required_field_missing");
}

{
  const packet = samplePacket({
    fact_routes: [
      {
        ...samplePacket().fact_routes[0],
        status: "maybe_routed",
        valid_next_action: "think_about_it",
      },
    ],
  });
  const result = validateIvePacket(packet);
  const codes = errorCodes(result);
  assert(!result.ok, "unknown route status/action fails");
  assert(codes.has("unknown_route_status"), "unknown status is reported");
  assert(codes.has("unknown_next_action"), "unknown next action is reported");
}

{
  const packet = samplePacket({
    fact_routes: [
      {
        ...samplePacket().fact_routes[0],
        status: "unrouted",
        valid_next_action: "report_only",
      },
    ],
    closure_status: "blocked",
  });
  const result = validateIvePacket(packet);
  assert(!result.ok, "report_only with unrouted material fact fails");
  assert(errorCodes(result).has("report_only_with_unrouted_material_fact"), "report_only blocker is reported");
}

{
  const packet = samplePacket({
    fact_routes: [
      {
        ...samplePacket().fact_routes[0],
        status: "blocked",
        valid_next_action: "ticket_now",
      },
    ],
    closure_status: "closeable",
  });
  const result = validateIvePacket(packet);
  assert(!result.ok, "closeable packet with deterministic blocker fails");
  assert(errorCodes(result).has("closeable_with_deterministic_blocker"), "closeable blocker is reported");
}

{
  const packet = samplePacket({
    fact_routes: [
      {
        ...samplePacket().fact_routes[0],
        status: "blocked",
        valid_next_action: "ticket_now",
      },
    ],
    closure_status: "blocked",
    advisory_review: {
      status: "review_ready",
    },
  });
  const result = validateIvePacket(packet);
  assert(!result.ok, "advisory review cannot clear deterministic blocker");
  assert(
    errorCodes(result).has("advisory_cannot_clear_deterministic_blocker"),
    "advisory blocker code is reported",
  );
}

{
  const packet = samplePacket({
    fact_routes: [
      {
        ...samplePacket().fact_routes[0],
        status: "removed",
        valid_next_action: "report_only",
        removal_evidence: "Verified upstream correction removed the material fact.",
      },
    ],
  });
  const result = validateIvePacket(packet);
  assert(result.ok, "removed route with removal evidence passes");
}

{
  const packet = samplePacket({
    fact_routes: [
      {
        ...samplePacket().fact_routes[0],
        status: "removed",
        valid_next_action: "report_only",
      },
    ],
  });
  const result = validateIvePacket(packet);
  assert(!result.ok, "removed route without removal evidence fails");
  assert(errorCodes(result).has("removed_route_missing_evidence"), "removed evidence code is reported");
}

{
  const result = runCli(samplePacket());
  assert(result.exit_code === 0, "CLI exits 0 for valid packet");
  assert(result.parsed?.status === "PASS", "CLI valid packet emits PASS JSON");
}

{
  const result = runCli(samplePacket({ closure_status: "done" }));
  assert(result.exit_code === 1, "CLI exits non-zero for invalid packet");
  assert(result.parsed?.status === "FAIL", "CLI invalid packet emits FAIL JSON");
  assert(errorCodes(result.parsed).has("unknown_closure_status"), "CLI surfaces validation error code");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
