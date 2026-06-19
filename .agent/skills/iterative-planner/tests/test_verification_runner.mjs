#!/usr/bin/env node
// test_verification_runner.mjs — verification_runner.mjs contract.
//
// Phase 3 of ritual elimination: opt-in execution of verification_matrix
// rows. Tests cover the three safety locks (default-manual, per-row opt-in,
// global env lock), the dry-run path, the write-back path, and the
// result_source distinction in gate audit.

import { mkdtempSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const runnerCli = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "verification_runner.mjs");
const fixturePath = join(testDir, "fixtures", "programs", "auto_executor.json");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync(NODE, [runnerCli, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* ignore */ }
    return { ok: true, stdout, parsed };
  } catch (error) {
    const stdout = error.stdout || "";
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* ignore */ }
    return { ok: false, stdout, stderr: error.stderr || "", parsed };
  }
}

function copyFixtureToTmp() {
  const tmp = mkdtempSync(join(tmpdir(), "verification-runner-"));
  const dest = join(tmp, "auto_executor.json");
  copyFileSync(fixturePath, dest);
  return { tmp, dest };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => key !== "run_record")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function makeArtifactProgram() {
  const tmp = mkdtempSync(join(tmpdir(), "verification-runner-artifacts-"));
  const artifact = join(tmp, "metric artifact.json");
  const dest = join(tmp, "auto_artifact_executor.json");
  writeFileSync(artifact, `${JSON.stringify({ schema_version: 1, metric: "roi", value: 0.12 }, null, 2)}\n`);
  writeFileSync(dest, `${JSON.stringify({
    version: 1,
    id: "PGM-AUTO-ARTIFACT",
    title: "Auto artifact executor fixture",
    status: "validating",
    goal: "Exercise runner-bound artifact records.",
    story_refs: ["US-003"],
    epics: [],
    tickets: [],
    acceptance_criteria: [],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [
      {
        id: "VM-AUTO-ARTIFACT",
        scope: "ticket",
        subject_ref: "T-AUTO-ARTIFACT",
        acceptance_criterion_ref: "AC-AUTO-ARTIFACT",
        proof_type: "proof:command_smoke",
        command_or_action: "/bin/sh -c 'echo artifact-ok && exit 0'",
        pass_means: "Exit 0 and artifact receives a runner-bound record",
        executor: "auto",
        timeout_seconds: 10,
        artifact_refs: ["metric artifact.json"],
      },
    ],
    decisions: [],
  }, null, 2)}\n`);
  return { tmp, dest, artifact };
}

console.log("\nVerification Runner Contracts\n");

// 1. Dry-run lists eligible rows without requiring the env lock.
let result = run(["run", "--program", fixturePath, "--dry-run", "--json"]);
assert(result.ok && result.parsed?.eligible_count === 2, "dry-run identifies 2 auto rows in fixture");
assert(result.parsed?.executions?.every((execution) => execution.result === "DRY_RUN"), "dry-run does not execute commands");

// 2. Without env lock, runner refuses to execute.
result = run(["run", "--program", fixturePath, "--json"]);
assert(result.parsed?.status === "BLOCKED", "without PLANNER_VERIFICATION_EXECUTE=1 the runner is BLOCKED");
assert(/PLANNER_VERIFICATION_EXECUTE/.test(result.parsed?.locks_status || ""), "blocked status names the env lock");

// 3. With env lock, runner executes and reports results.
result = run(["run", "--program", fixturePath, "--json"], { PLANNER_VERIFICATION_EXECUTE: "1" });
assert(result.parsed?.executed_count === 2, "runs both auto rows when env lock is satisfied");
const execMap = new Map((result.parsed?.executions || []).map((execution) => [execution.row_id, execution]));
assert(execMap.get("VM-AUTO-PASS")?.result === "PASS" && execMap.get("VM-AUTO-PASS")?.exit_code === 0, "passing command surfaces PASS + exit 0");
assert(execMap.get("VM-AUTO-FAIL")?.result === "FAIL" && execMap.get("VM-AUTO-FAIL")?.exit_code === 7, "failing command surfaces FAIL + non-zero exit");
assert(/runner-ok/.test(execMap.get("VM-AUTO-PASS")?.stdout_excerpt || ""), "stdout excerpt captured for passing row");

// 4. Without --write, the packet is unchanged.
const beforeHash = readFileSync(fixturePath, "utf-8");
result = run(["run", "--program", fixturePath, "--json"], { PLANNER_VERIFICATION_EXECUTE: "1" });
const afterHash = readFileSync(fixturePath, "utf-8");
assert(beforeHash === afterHash, "without --write the source packet is not mutated");

// 5. With --write, the packet's verification_matrix gets result_source='executed'.
const { tmp, dest } = copyFixtureToTmp();
try {
  result = run(["run", "--program", dest, "--write", "--json"], { PLANNER_VERIFICATION_EXECUTE: "1" });
  const updated = JSON.parse(readFileSync(dest, "utf-8"));
  const passRow = updated.verification_matrix.find((row) => row.id === "VM-AUTO-PASS");
  const failRow = updated.verification_matrix.find((row) => row.id === "VM-AUTO-FAIL");
  const manualRow = updated.verification_matrix.find((row) => row.id === "VM-MANUAL");
  assert(passRow?.result === "PASS" && passRow?.result_source === "executed" && typeof passRow?.exit_code === "number", "passing auto row written with result_source='executed'");
  assert(failRow?.result === "FAIL" && failRow?.result_source === "executed" && failRow?.exit_code === 7, "failing auto row written with FAIL + exit 7");
  assert(manualRow?.result === "PASS" && (!manualRow?.result_source || manualRow.result_source === "manual"), "manual row left untouched");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 6. --row filter restricts which rows execute.
result = run(["run", "--program", fixturePath, "--row", "VM-AUTO-PASS", "--dry-run", "--json"]);
assert(result.parsed?.eligible_count === 1 && result.parsed?.executions?.[0]?.row_id === "VM-AUTO-PASS", "--row filters to a single row");

// 7. Runner-bound artifact refs receive content-hashed run records.
const artifactFixture = makeArtifactProgram();
try {
  result = run(["run", "--program", artifactFixture.dest, "--write", "--json"], { PLANNER_VERIFICATION_EXECUTE: "1" });
  const artifactDoc = JSON.parse(readFileSync(artifactFixture.artifact, "utf-8"));
  assert(result.parsed?.status === "PASS", "artifact-stamping fixture command passes");
  assert(artifactDoc.run_record?.producer === "verification_runner", "runner stamps JSON artifact with producer");
  assert(artifactDoc.run_record?.command === "/bin/sh -c 'echo artifact-ok && exit 0'", "run record includes executed command");
  assert(artifactDoc.run_record?.exit_code === 0, "run record includes exit code");
  assert(typeof artifactDoc.run_record?.timestamp === "string" && artifactDoc.run_record.timestamp.includes("T"), "run record includes timestamp");
  assert(artifactDoc.run_record?.content_hash === payloadHash(artifactDoc), "run record content hash binds artifact payload");
  artifactDoc.value = 0.99;
  assert(artifactDoc.run_record?.content_hash !== payloadHash(artifactDoc), "editing artifact payload invalidates run-record hash");
} finally {
  rmSync(artifactFixture.tmp, { recursive: true, force: true });
}

// 8. Help text mentions all three locks.
result = run(["help"]);
assert(/executor='auto'|executor.*auto/.test(result.stdout), "help mentions per-row opt-in");
assert(/PLANNER_VERIFICATION_EXECUTE=1/.test(result.stdout), "help mentions env lock");
assert(/timeout/.test(result.stdout), "help mentions per-row timeout");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
