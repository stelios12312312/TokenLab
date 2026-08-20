#!/usr/bin/env node
// test_program_manager_findings_triage.mjs - FI2 findings-to-intake replay contract.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const cli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "program_manager.mjs");
const NODE = process.execPath;
const replayScoreboard = "reports/ive/scoreboard/scoreboard-2026-07-07T17-40-11-369Z/scoreboard.json";
const replayManifest = "reports/ive/test_runs/scoreboard-2026-07-07T17-40-11-369Z-conformance/manifest.json";
const replayStdout = ".agent/skills/iterative-planner/tests/fixtures/findings_triage/cli-determinism.failure-excerpt.txt";

let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    assert.fail(`${label} emitted invalid JSON: ${error.message}\n${stdout}`);
  }
}

function run(args) {
  const result = spawnSync(NODE, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 25 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: result.stdout.trim() ? parseJson(result.stdout, args.join(" ")) : null,
  };
}

function writeProgramPacket(dir) {
  const packetPath = join(dir, "program_packet.json");
  const packet = {
    version: 1,
    id: "PGM-FI2-TEST",
    title: "FI2 findings triage replay",
    status: "design",
    goal: "Replay deterministic findings into advisory Program Manager intake.",
    story_refs: ["US-091"],
    canonical_files: [],
    epics: [{
      id: "EP-FI2",
      title: "Findings triage",
      story_refs: ["US-091"],
      ticket_refs: [],
    }],
    tickets: [],
    acceptance_criteria: [],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [],
    decisions: [],
  };
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
  return packetPath;
}

function seedDuplicateTicket(packetPath) {
  const packet = JSON.parse(readFileSync(packetPath, "utf-8"));
  packet.tickets.push({
    id: "T-EXISTING-CLI-DETERMINISM",
    title: "Fix cli-determinism deterministic finding",
    type: "defect",
    ticket_type: "defect",
    lifecycle: "proposed",
    story_refs: ["US-091"],
    acceptance_criteria: [],
    verification_refs: [],
  });
  writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
}

function cliCandidate(result) {
  return (result.parsed.results || []).find((entry) =>
    entry.source_finding?.failing_suite_id === "cli-determinism" ||
    entry.candidate_ticket?.title?.includes("cli-determinism")
  );
}

function refsContain(refs, needle) {
  return refs.some((ref) => String(ref).includes(needle));
}

console.log("\nProgram Manager Findings Triage Replay\n");

ok(existsSync(join(repoRoot, replayScoreboard)), "committed 2026-07-07 scoreboard replay receipt exists");
ok(existsSync(join(repoRoot, replayManifest)), "committed nested conformance manifest exists");
ok(existsSync(join(repoRoot, replayStdout)), "committed cli-determinism failure excerpt exists");

const tmp = mkdtempSync(join(tmpdir(), "program-manager-findings-triage-"));
try {
  const packetPath = writeProgramPacket(tmp);
  const initialHash = hashFile(packetPath);

  let result = run([
    "triage-findings",
    "--program", packetPath,
    "--from-artifact", replayScoreboard,
    "--json",
  ]);
  ok(result.ok && result.parsed.status === "PASS", "dry-run triage exits PASS");
  ok(result.parsed.advisory_only === true && result.parsed.accepted === false, "dry-run triage is advisory and unaccepted");
  ok(result.parsed.packet_updated === false, "dry-run triage does not update packet");
  ok(hashFile(packetPath) === initialHash, "dry-run triage leaves Program Packet bytes unchanged");

  const dryCandidate = cliCandidate(result);
  ok(Boolean(dryCandidate), "dry-run emits cli-determinism candidate");
  ok(dryCandidate.source_finding.evidence_refs.run_receipt_path === replayManifest, "candidate names nested conformance receipt");
  ok(dryCandidate.source_finding.evidence_refs.stdout_log_path === replayStdout, "candidate names stdout log path");
  ok(refsContain(dryCandidate.candidate_ticket.evidence_refs || [], "source_parity_guard.mjs"), "candidate names offending source_parity_guard file");
  ok((dryCandidate.verification_rows || []).some((row) => String(row.command_or_action).includes("test_cli_determinism.mjs")), "candidate verification row reruns cli determinism test");
  ok(dryCandidate.duplicate_scan?.status && dryCandidate.duplicate_scan.status !== "not_run", "candidate reports Program Manager duplicate scan result");

  result = run([
    "triage-findings",
    "--program", packetPath,
    "--from-artifact", replayScoreboard,
    "--write",
    "--json",
  ]);
  ok(!result.ok && result.parsed.status === "FAIL", "--write without --accept fails");
  ok(String(result.parsed.error).includes("--accept"), "write-without-accept error explains advisory acceptance gate");
  ok(hashFile(packetPath) === initialHash, "failed write-without-accept leaves Program Packet unchanged");

  const duplicateDir = mkdtempSync(join(tmp, "duplicate-"));
  const duplicatePacketPath = writeProgramPacket(duplicateDir);
  seedDuplicateTicket(duplicatePacketPath);
  const duplicateInitialHash = hashFile(duplicatePacketPath);

  result = run([
    "triage-findings",
    "--program", duplicatePacketPath,
    "--from-artifact", replayScoreboard,
    "--accept",
    "--write",
    "--json",
  ]);
  ok(result.status === 3 && result.parsed.status === "BLOCKED", "duplicate accepted batch blocks before mutation");
  ok(result.parsed.packet_updated === false, "duplicate accepted batch does not update packet");
  ok(hashFile(duplicatePacketPath) === duplicateInitialHash, "duplicate accepted batch leaves Program Packet unchanged");
  ok(Array.isArray(result.parsed.intake_artifact_paths) && result.parsed.intake_artifact_paths.length === 0, "duplicate accepted batch reports no written artifacts");
  const plannedArtifactPaths = (result.parsed.results || [])
    .map((entry) => entry.intake_artifact_path)
    .filter(Boolean);
  ok(plannedArtifactPaths.every((artifactPath) => !existsSync(resolve(repoRoot, artifactPath)) && !existsSync(artifactPath)), "duplicate accepted batch writes no intake artifacts");

  result = run([
    "triage-findings",
    "--program", packetPath,
    "--from-artifact", replayScoreboard,
    "--accept",
    "--write",
    "--json",
  ]);
  ok(result.ok && result.parsed.status === "PASS", "accepted triage exits PASS");
  ok(result.parsed.packet_updated === true, "accepted triage writes packet");
  const written = JSON.parse(readFileSync(packetPath, "utf-8"));
  const ticket = written.tickets.find((entry) => entry.title.includes("cli-determinism"));
  ok(Boolean(ticket), "accepted triage creates proposed cli-determinism ticket");
  ok(ticket.lifecycle === "proposed", "accepted finding remains proposed lifecycle");
  ok((ticket.story_refs || []).includes("US-091"), "accepted ticket links US-091");
  ok(refsContain(ticket.evidence_refs || [], replayManifest), "accepted ticket carries conformance manifest evidence ref");
  ok(refsContain(ticket.evidence_refs || [], replayStdout), "accepted ticket carries stdout log evidence ref");
  ok(refsContain(ticket.evidence_refs || [], "source_parity_guard.mjs"), "accepted ticket carries offending file evidence ref");
  const row = written.verification_matrix.find((entry) => (ticket.verification_refs || []).includes(entry.id));
  ok(Boolean(row), "accepted ticket has verification matrix row");
  ok(String(row.command_or_action).includes("test_cli_determinism.mjs"), "accepted verification row reruns failing test");
  ok(refsContain(row.evidence_refs || [], replayManifest), "accepted verification row carries run receipt evidence ref");
  ok(result.parsed.intake_artifact_paths.some((artifactPath) => existsSync(resolve(repoRoot, artifactPath)) || existsSync(artifactPath)), "accepted triage writes intake artifact");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
