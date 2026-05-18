#!/usr/bin/env node
// test_program_manager.mjs — Program Packet validator and gate contracts.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
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

result = run(["verify", "execution-to-program-validate", "--program", fixture("child_plan_not_closed.json"), "--json"]);
assert(!result.ok && hasError(result, "required_child_plan_not_closed"), "verified ticket with unclosed required child plan fails");

result = run(["verify", "validate-to-program-close", "--program", fixture("program_close_deferred_missing_decision.json"), "--json"]);
assert(!result.ok && hasError(result, "deferred_ticket_missing_decision"), "program close with undecided deferral fails");

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

// Forward-reasoning queries — Phase 1 of ritual elimination.
const dispatchChain = fixture("dispatch_chain.json");

result = run(["next-ready", "--program", dispatchChain, "--json"]);
const nextReadyIds = (result.parsed?.tickets || []).map((entry) => entry.id).sort();
assert(result.ok && JSON.stringify(nextReadyIds) === JSON.stringify(["T-B", "T-D"]), "next-ready returns the unblocked ready tickets");

result = run(["blockers", "T-C", "--program", dispatchChain, "--json"]);
const blockerIds = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && blockerIds.includes("T-B"), "blockers returns transitive blocking ticket");

result = run(["unlocks-if-closed", "T-B", "--program", dispatchChain, "--json"]);
const unlockIds = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && unlockIds.includes("T-C"), "unlocks-if-closed returns the ticket newly unblocked by closing T-B");

result = run(["unlocks-if-closed", "T-A", "--program", dispatchChain, "--json"]);
assert(result.ok && (result.parsed?.tickets || []).length === 0, "unlocks-if-closed returns nothing when target is already done");

result = run(["next-ready", "--program", fixture("valid_ready.json"), "--json"]);
const validNext = (result.parsed?.tickets || []).map((entry) => entry.id);
assert(result.ok && validNext.includes("T-001"), "next-ready works on the original valid fixture");

result = run(["blockers", "T-MISSING", "--program", dispatchChain, "--json"]);
assert(result.ok && (result.parsed?.tickets || []).length === 0, "blockers on unknown ticket returns empty list, not error");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
