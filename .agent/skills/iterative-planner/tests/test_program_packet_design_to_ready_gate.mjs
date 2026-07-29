#!/usr/bin/env node
// test_program_packet_design_to_ready_gate.mjs
//
// Closes the conformance gap that let "verified" tickets resting on uncommitted,
// local-only plan dirs survive local proof: the conformance runner validated the IVE packet SCHEMA
// (core-packet-contract) but never ran Program-Packet `design-to-ready`, which is
// what catches required_child_plan_dir_missing / program_child_plan_not_closed.
// This test runs design-to-ready on every active program packet so that class
// fails during local conformance instead of being discovered mid-implementation.
//
// Known-debt packets are reported as ADVISORY only when their exact error-code
// profile is unchanged. New codes or changed counts fail closed.

import { execFileSync } from "child_process";
import { readdirSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { validateProgramPacket } from "../scripts/lib/program_packet.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const NODE = process.execPath;
const PM = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "program_manager.mjs");
const PROGRAMS_DIR = join(repoRoot, "plans", "programs");
const PROJECT_KNOWN_DEBT_PATH = join(
  repoRoot,
  ".agent",
  "skills",
  "iterative-planner",
  "config",
  "program_packet_known_debt_profiles.json"
);

// Pre-existing design-to-ready debt NOT yet cleaned. These stay visible every
// run, but only exact packet/error-code profiles are advisory. Shrink this map
// as packets are fixed; any drift is a failing signal.
function loadProjectKnownDebtProfiles() {
  if (!existsSync(PROJECT_KNOWN_DEBT_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PROJECT_KNOWN_DEBT_PATH, "utf-8"));
    return parsed && typeof parsed === "object" && parsed.profiles && typeof parsed.profiles === "object"
      ? parsed.profiles
      : {};
  } catch (error) {
    console.log(`  FAIL: project known-debt profile is unreadable JSON (${error.message})`);
    failed++;
    return {};
  }
}

const DEFAULT_KNOWN_DEBT_PROFILES = Object.freeze({
  "gate-forward-scaffold-fixes": {
    status: "FAIL",
    total: 2,
    codes: {
      mistake_mitigation_pass_without_hook_evidence: 2,
    },
  },
});

const KNOWN_DEBT_PROFILES = Object.freeze({
  ...DEFAULT_KNOWN_DEBT_PROFILES,
  ...loadProjectKnownDebtProfiles(),
});

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

function designToReady(packetPath) {
  try {
    const out = execFileSync(NODE, [PM, "verify", "design-to-ready", "--program", packetPath, "--json"], { encoding: "utf-8" });
    return JSON.parse(out);
  } catch (e) {
    // verify exits non-zero on FAIL; the JSON is still on stdout.
    try { return JSON.parse(String(e.stdout || "")); } catch { return { status: "ERROR", errors: [{ code: "cli_error", message: String(e.message).slice(0, 200) }] }; }
  }
}

function readProgramStatus(packetPath) {
  try {
    return String(JSON.parse(readFileSync(packetPath, "utf-8"))?.status || "").trim();
  } catch {
    return "";
  }
}

function errorCodeCounts(errors) {
  const counts = {};
  for (const error of errors || []) {
    const code = error?.code || "unknown_error";
    counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

function sameCodeCounts(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key, index) => key === actualKeys[index] && actual[key] === expected[key]);
}

function formatCodeCounts(counts) {
  const entries = Object.entries(counts || {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "none";
  return entries.map(([code, count]) => `${code}:${count}`).join(", ");
}

function gitPathIgnored(path) {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", "--", path], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function knownDebtMatches(result, expected) {
  const errors = result.errors || [];
  const actualCounts = errorCodeCounts(errors);
  return result.status === expected.status
    && errors.length === expected.total
    && sameCodeCounts(actualCounts, expected.codes);
}

console.log("\nProgram-packet design-to-ready local conformance gate\n");

// ── 1. Git boundary guard: proof-chain state must be addable without force.
for (const [probe, label] of [
  ["plans/knowledge/__a1_gitignore_probe__.md", "plans/knowledge files are not ignored"],
  ["plans/programs/__a1_gitignore_probe__/program_packet.json", "plans/programs packets are not ignored"],
  ["plans/plan_2099-01-01_a1gitignoreprobe/state.json", "planner child-plan state files are not ignored"],
  ["plans/plan_2099-01-01_a1gitignoreprobe/verification.md", "planner child-plan proof files are not ignored"],
  ["reports/ive/codex_handoff_2099-01-01.md", "IVE handoff reports are not ignored"],
  ["reports/ive/test_runs/ive-2099-01-01T00-00-00Z/manifest.json", "IVE test-run manifests are not ignored"],
  ["reports/ive/consolidation_receipts/probe/receipt.json", "IVE receipt artifacts are not ignored"],
  ["reports/ive/lifecycle_dispositions/probe/receipt.json", "IVE lifecycle disposition receipts are not ignored"],
  ["reports/ive/autonomous_dogfood_runs/2099-01-01/receipt.json", "IVE autonomous dogfood receipts are not ignored"],
  ["reports/ive/scoreboard/probe/scoreboard.json", "IVE scoreboard reports are not ignored"],
  ["reports/red_team_audit/probe/findings.md", "red-team audit reports are not ignored"],
  ["reports/regression_audit/probe/regression_report.md", "regression audit reports are not ignored"],
]) {
  assert(!gitPathIgnored(probe), label);
}

for (const [probe, label] of [
  ["plans/.current_plan", "active plan pointer remains ignored"],
  ["plans/.current_plan.codex", "thread-local current-plan pointers remain ignored"],
  ["plans/.thread_targets/thread.json", "plan isolation lane targets remain ignored"],
  ["plans/ACTIVE_PLAN.md", "active plan markdown alias remains ignored"],
  ["plans/ACTIVE_PLAN.json", "active plan json alias remains ignored"],
  ["reports/ive/test_runs/ive-2099-01-01T00-00-00Z/logs/suite.stdout.log", "IVE stdout logs remain ignored"],
  ["reports/ive/test_runs/ive-2099-01-01T00-00-00Z/logs/suite.stderr.log", "IVE stderr logs remain ignored"],
  ["reports/ive/test_runs/ive-2099-01-01T00-00-00Z/visualizer-browser-proof.json", "IVE non-manifest suite bulk remains ignored"],
  ["reports/ive/autonomous_dogfood_runs/2099-01-01/transcript.log", "IVE autonomous dogfood non-receipt bulk remains ignored"],
  ["reports/migration/validate_migration_2099-01-01T00-00-00Z.json", "migration scratch reports remain ignored"],
  ["reports/ive/release_handoff/2099-01-01T00-00-00Z/details.json", "release handoff generated bulk remains ignored by default"],
]) {
  assert(gitPathIgnored(probe), label);
}

// ── 2. Detection guard: the gate MUST catch a required child plan whose dir is missing.
// (If this silently stops catching the class, the whole gate is theater.)
const tmp = mkdtempSync(join(tmpdir(), "d2r-guard-"));
try {
  const bad = { id: "PROG-GUARD", status: "active",
    tickets: [{ id: "T-GUARD", lifecycle: "verified",
      child_plan: { policy: "required", plan_dir: "plans/does_not_exist_xyz", reason: "guard" } }] };
  const res = validateProgramPacket(bad, { cwd: tmp });
  const codes = res.errors.map((e) => e.code);
  assert(codes.includes("required_child_plan_dir_missing"),
    "a verified ticket with a required-but-missing child-plan dir is caught (gate is real)");

  // And a valid waiver clears it (JS/Prolog parity — the honest remediation path).
  const waived = { id: "PROG-GUARD", status: "active",
    decisions: [{ id: "D-W", type: "child_plan_artifact_waiver", subject_ref: "PROG-GUARD", decision: "x", rationale: "y" }],
    tickets: [{ id: "T-GUARD", lifecycle: "verified",
      child_plan: { policy: "required", plan_dir: "plans/does_not_exist_xyz", reason: "guard", waiver_decision_ref: "D-W" } }] };
  const wres = validateProgramPacket(waived, { cwd: tmp });
  assert(!wres.errors.some((e) => e.code.startsWith("required_child_plan")),
    "a valid waiver_decision_ref clears the missing-dir error (JS layer)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// M1 administrative closure lane: a valid backlog_disposition record is the
// evidence for administrative closure, while an ordinary evidence-free closed
// ticket remains blocked.
{
  function administrativeClosurePacket({ disposition = true, decisionRef = "D-ADMIN", remoteMode = "local-only" } = {}) {
    return {
      version: 1,
      id: "PGM-ADMIN-CLOSE",
      title: "Administrative close fixture",
      status: "executing",
      remote_mode: remoteMode,
      goal: "Close obsolete backlog without pretending delivery occurred.",
      story_refs: ["US-001"],
      epics: [{
        id: "EP-ADMIN",
        title: "Backlog administration",
        story_refs: ["US-001"],
        ticket_refs: ["T-ADMIN"],
      }],
      tickets: [{
        id: "T-ADMIN",
        epic_id: "EP-ADMIN",
        title: "Obsolete backlog ticket",
        type: "feature",
        lifecycle: "closed",
        review_status: "unavailable",
        gap_refs: ["GAP-ADMIN"],
        acceptance_criteria: [],
        verification_refs: [],
        external_refs: [],
        ...(disposition ? {
          backlog_disposition: {
            classification: "close_obsolete",
            decision_ref: decisionRef,
            receipt_ref: "reports/ive/lifecycle_dispositions/admin-fixture.json",
            source: "program_manager_disposition",
          },
        } : {}),
      }],
      acceptance_criteria: [],
      dependencies: [],
      compatibility_contracts: [],
      migration_boundaries: [],
      deletion_move_census: [],
      verification_matrix: [],
      decisions: [{
        id: "D-ADMIN",
        type: "backlog_disposition",
        subject_ref: "T-ADMIN",
        status: "accepted",
        decision: "Close obsolete backlog ticket; no delivery work remains.",
      }],
    };
  }

  const ok = validateProgramPacket(administrativeClosurePacket());
  assert(ok.ok, "valid administrative backlog disposition can close without delivery evidence");

  const missingDisposition = validateProgramPacket(administrativeClosurePacket({ disposition: false }));
  const missingCodes = missingDisposition.errors.map((error) => error.code);
  assert(!missingDisposition.ok, "seeded ordinary evidence-free closed ticket still fails validation without backlog_disposition");
  assert(missingCodes.includes("ready_ticket_missing_acceptance"), "seeded ordinary evidence-free closed ticket still fails acceptance evidence");
  assert(missingCodes.includes("ready_ticket_missing_verification"), "seeded ordinary evidence-free closed ticket still fails verification evidence");
  const missingRemoteSync = validateProgramPacket(administrativeClosurePacket({
    disposition: false,
    remoteMode: "remote-sync",
  }), { env: {} });
  const missingRemoteSyncCodes = missingRemoteSync.errors.map((error) => error.code);
  assert(missingRemoteSyncCodes.includes("ready_ticket_missing_github_issue"), "seeded ordinary evidence-free closed ticket still fails GitHub mirror evidence in remote-sync mode");

  const badDecision = validateProgramPacket(administrativeClosurePacket({ decisionRef: "D-MISSING" }));
  assert(!badDecision.ok, "administrative disposition with missing decision_ref target does not bypass delivery evidence");
}

// ── 3. Enforce design-to-ready on every committed program packet.
let packetDirs = [];
try { packetDirs = readdirSync(PROGRAMS_DIR).filter((d) => existsSync(join(PROGRAMS_DIR, d, "program_packet.json"))); } catch { /* none */ }
assert(packetDirs.length > 0, `discovered program packets to validate (${packetDirs.length})`);

for (const dir of packetDirs) {
  const packetPath = join(PROGRAMS_DIR, dir, "program_packet.json");
  const programStatus = readProgramStatus(packetPath);
  if (programStatus === "deferred") {
    assert(true, `${dir} is deferred; design-to-ready promotion is not applicable`);
    continue;
  }
  const res = designToReady(packetPath);
  const errCount = (res.errors || []).length;
  const knownDebt = KNOWN_DEBT_PROFILES[dir];
  if (knownDebt) {
    const actualCounts = errorCodeCounts(res.errors || []);
    const matches = knownDebtMatches(res, knownDebt);
    assert(matches,
      `${dir} known debt profile matches exactly (status=${res.status}, ${errCount} errors; codes=${formatCodeCounts(actualCounts)})`);
    if (!matches) {
      console.log(`       expected status=${knownDebt.status}, errors=${knownDebt.total}; codes=${formatCodeCounts(knownDebt.codes)}`);
      console.log(`       actual   status=${res.status}, errors=${errCount}; codes=${formatCodeCounts(actualCounts)}`);
      (res.errors || []).slice(0, 6).forEach((e) => console.log(`       ${e.code} ${e.path || e.message || ""}`));
    } else {
      console.log(`  ADVISORY (known debt): ${dir} → exact profile unchanged. Remove from KNOWN_DEBT_PROFILES once cleaned.`);
    }
    continue;
  }
  assert(res.status === "PASS" && errCount === 0,
    `${dir} passes design-to-ready (status=${res.status}, ${errCount} errors)`);
  if (res.status !== "PASS") (res.errors || []).slice(0, 6).forEach((e) => console.log(`       ${e.code} ${e.path || e.message || ""}`));
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
