#!/usr/bin/env node
// test_program_packet_lightweight.mjs — the lightweight child-plan tier.
//
// Root-cause fix: programs previously had only `required | not_required |
// waived` child-plan policies. `required` forces a full closed state-machine
// plan_dir, and there was no proportional middle gear — so a 150-line pack
// ticket got the same heavy ceremony as a cross-system refactor (the e03
// "3,557-line plan dir" trap). This tier lets a program ticket close on a
// lightweight on-disk proof (task.md + walkthrough.md) WITHOUT a full closed
// state machine — but it is still a real gate: missing proof must fail.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { validateProgramPacket, CHILD_PLAN_POLICIES } from "../scripts/lib/program_packet.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}
function codes(result) {
  return result.errors.map((e) => e.code);
}

console.log("\nLightweight child-plan tier\n");

// "lightweight" is a recognised policy.
assert(CHILD_PLAN_POLICIES.has("lightweight"),
  "CHILD_PLAN_POLICIES includes 'lightweight'");

// Schema enum accepts it too.
const schema = JSON.parse(readFileSync(
  join(repoRoot, ".agent", "skills", "iterative-planner", "config", "program_packet.schema.json"), "utf-8"));
const enumVals = JSON.stringify(schema).match(/"required","not_required","waived"[^\]]*/);
assert(JSON.stringify(schema).includes('"lightweight"'),
  "program_packet.schema.json child_plan.policy enum includes 'lightweight'");

const tmp = mkdtempSync(join(tmpdir(), "lw-packet-"));
try {
  // plan dir WITH walkthrough proof
  mkdirSync(join(tmp, "plans", "lw_ok"), { recursive: true });
  writeFileSync(join(tmp, "plans", "lw_ok", "walkthrough.md"), "# Walkthrough\nDid the thing.\n");
  // plan dir WITHOUT proof
  mkdirSync(join(tmp, "plans", "lw_noproof"), { recursive: true });
  writeFileSync(join(tmp, "plans", "lw_noproof", "scope.json"), "{}");
  // required plan dir with an OPEN (non-closed) state
  mkdirSync(join(tmp, "plans", "req_open"), { recursive: true });
  writeFileSync(join(tmp, "plans", "req_open", "state.json"), JSON.stringify({ state: "EXECUTE" }));

  const mk = (id, lifecycle, child_plan) => ({ id, lifecycle, child_plan });

  // Case 1: lightweight + verified + on-disk walkthrough → no lightweight errors.
  const okPacket = { id: "PROG", status: "active",
    tickets: [mk("T-LW-OK", "verified", { policy: "lightweight", plan_dir: "plans/lw_ok", reason: "slice" })] };
  const okRes = validateProgramPacket(okPacket, { cwd: tmp });
  assert(!codes(okRes).some((c) => c.startsWith("lightweight_child_plan")),
    "lightweight + verified + walkthrough.md on disk → no lightweight child-plan error");

  // Case 2: lightweight + verified + plan_dir but NO proof → proof-missing error.
  const noProofPacket = { id: "PROG", status: "active",
    tickets: [mk("T-LW-NOPROOF", "verified", { policy: "lightweight", plan_dir: "plans/lw_noproof", reason: "slice" })] };
  const noProofRes = validateProgramPacket(noProofPacket, { cwd: tmp });
  assert(codes(noProofRes).includes("lightweight_child_plan_proof_missing"),
    "lightweight + verified + no walkthrough → lightweight_child_plan_proof_missing (still a real gate)");

  // Case 3: lightweight + verified + no plan_dir → dir-required error (no inline-only bypass).
  const noDirPacket = { id: "PROG", status: "active",
    tickets: [mk("T-LW-NODIR", "verified", { policy: "lightweight", plan_dir: null, reason: "slice" })] };
  const noDirRes = validateProgramPacket(noDirPacket, { cwd: tmp });
  assert(codes(noDirRes).includes("lightweight_child_plan_dir_required"),
    "lightweight + verified + no plan_dir → lightweight_child_plan_dir_required (no inline-only bypass)");

  // Case 4 (regression): required is NOT weakened — open state still fails.
  const reqPacket = { id: "PROG", status: "active",
    tickets: [mk("T-REQ-OPEN", "verified", { policy: "required", plan_dir: "plans/req_open", reason: "full" })] };
  const reqRes = validateProgramPacket(reqPacket, { cwd: tmp });
  assert(codes(reqRes).includes("required_child_plan_not_closed"),
    "required + verified + non-closed state still fails (lightweight tier did not weaken required)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
