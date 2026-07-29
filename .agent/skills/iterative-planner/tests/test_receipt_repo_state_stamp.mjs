#!/usr/bin/env node
// @planner:module = receipt_repo_state_stamp_test
// @planner:capability = verifies_j11_receipt_writers_carry_repo_state_stamp

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendDecisionLog,
  buildDecisionEntry,
  writeProofTrace,
} from "../scripts/lib/determinism.mjs";
import {
  evaluateDirtyInputProofArtifacts,
  REPO_STATE_STAMP_SCHEMA_VERSION,
} from "../scripts/lib/repo_state_stamp.mjs";
import { gateValidateToClose } from "../scripts/verify_gate.mjs";
import { DEFAULT_SUITES, runConformance } from "./ive/run.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const NODE = process.execPath;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function assertCanonicalStamp(stamp, label) {
  assert.equal(stamp?.schema_version, REPO_STATE_STAMP_SCHEMA_VERSION, `${label} carries canonical repo_state_stamp schema`);
  assert("head_sha" in stamp, `${label} records head_sha`);
  assert(Array.isArray(stamp.dirty_files), `${label} records bounded dirty_files list`);
  assert(Number.isInteger(stamp.overflow_count), `${label} records overflow_count`);
}

{
  const temp = mkdtempSync(join(tmpdir(), "receipt-stamp-determinism-"));
  try {
    const planDir = join(temp, "plan_2026-07-06_test");
    mkdirSync(planDir, { recursive: true });
    const appended = appendDecisionLog(planDir, buildDecisionEntry(
      "plan-to-execute",
      { plan: "T-INTAKE-34C0058D" },
      [{ name: "receipt stamp test", status: "PASS" }],
      "ALLOWED",
      "EXECUTE",
    ));
    assert.equal(appended, true, "decision log append succeeds");
    const decisionLine = readFileSync(join(planDir, "artifacts", "decision_log.jsonl"), "utf-8").trim().split("\n").pop();
    assertCanonicalStamp(JSON.parse(decisionLine).repo_state_stamp, "decision log record");

    const proofWritten = writeProofTrace(planDir, "plan-to-execute", {
      gate: "plan-to-execute",
      result: "allowed",
      ticket: "T-INTAKE-34C0058D",
    });
    assert.equal(proofWritten, true, "proof trace write succeeds");
    const proofDir = join(planDir, "artifacts", "prolog");
    const proofFile = readdirSync(proofDir).find((name) => name.endsWith(".json"));
    assert(proofFile, "proof trace JSON exists");
    assertCanonicalStamp(readJson(join(proofDir, proofFile)).repo_state_stamp, "proof trace");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

{
  const temp = mkdtempSync(join(tmpdir(), "receipt-stamp-ive-"));
  try {
    const suite = DEFAULT_SUITES.find((item) => item.id === "repo-state-stamps");
    assert(suite, "IVE suite registry includes repo-state-stamps");
    const report = runConformance({
      suites: [suite],
      only: ["repo-state-stamps"],
      executeCommand: (item) => ({
        id: item.id,
        category: item.category,
        label: item.label,
        required: item.required,
        command: item.display_command,
        status: "PASS",
        exit_code: 0,
        timed_out: false,
        started_at: "2026-07-06T00:00:00.000Z",
        finished_at: "2026-07-06T00:00:00.001Z",
        stdout_excerpt: "ok",
        stderr_excerpt: "",
      }),
      writeManifest: true,
      runId: "receipt-stamp-test",
      repoRoot,
      reportRoot: temp,
    });
    assert.equal(report.status, "PASS", "fake IVE run passes");
    const manifest = readJson(join(temp, "receipt-stamp-test", "manifest.json"));
    assertCanonicalStamp(manifest.repo_state_stamp, "IVE manifest");
    const suiteArtifact = readJson(join(temp, "receipt-stamp-test", "repo-state-stamps.json"));
    assertCanonicalStamp(suiteArtifact.repo_state_stamp, "IVE per-suite artifact");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

{
  const temp = mkdtempSync(join(tmpdir(), "receipt-stamp-pm-"));
  try {
    const sourcePacket = join(repoRoot, "plans", "programs", "ive-trust-repair", "program_packet.json");
    const packetCopy = join(temp, "program_packet.json");
    writeFileSync(packetCopy, readFileSync(sourcePacket, "utf-8"));
    const result = spawnSync(NODE, [
      join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "program_manager.mjs"),
      "check",
      "--program",
      packetCopy,
    ], { cwd: repoRoot, encoding: "utf-8" });
    const output = `${result.stdout}\n${result.stderr}`;
    const artifactMatch = output.match(/^Artifact:\s+(.+\.json)$/m);
    assert(artifactMatch, `Program Manager text output names artifact path: ${output}`);
    const artifactPath = artifactMatch[1].trim();
    assert(existsSync(artifactPath), "Program Manager artifact exists");
    assertCanonicalStamp(readJson(artifactPath).repo_state_stamp, "Program Manager artifact");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

{
  const artifact = {
    ticket: "T-INTAKE-34C0058D",
    repo_state_stamp: {
      schema_version: REPO_STATE_STAMP_SCHEMA_VERSION,
      dirty_files: [
        { path: ".agent/skills/iterative-planner/scripts/verify_gate.mjs", digest: "abc", status: " M" },
      ],
    },
  };
  const evaluation = evaluateDirtyInputProofArtifacts({
    cwd: repoRoot,
    artifactPaths: [join(repoRoot, "plans", "not-real", "artifact.json")],
    scopeFiles: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
  });
  assert.equal(evaluation.stamped_artifact_count, 0, "missing artifacts are ignored");

  const tempPlan = join(repoRoot, "plans", `.tmp-receipt-stamp-${process.pid}`);
  try {
    mkdirSync(tempPlan, { recursive: true });
    const artifactPath = join(tempPlan, "proof.json");
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    const relArtifactPath = `plans/${tempPlan.split("/plans/").pop()}/proof.json`;
    const directEvaluation = evaluateDirtyInputProofArtifacts({
      cwd: repoRoot,
      verificationContent: `See ${relArtifactPath}`,
      scopeFiles: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
    });
    assert.equal(directEvaluation.dirty_input_artifact_count, 1, "dirty-input helper reports scoped dirty artifact");

    writeFileSync(join(tempPlan, "plan.md"), [
      "# Test Plan",
      "## Files To Modify",
      "- .agent/skills/iterative-planner/scripts/verify_gate.mjs",
    ].join("\n"));
    writeFileSync(join(tempPlan, "verification.md"), [
      "# Verification",
      "PASS",
      "## Regression Audit",
      "PASS",
      "```",
      `artifact: ${relArtifactPath}`,
      "```",
    ].join("\n"));
    const gateResults = gateValidateToClose(tempPlan);
    const advisory = gateResults.find((entry) => entry.name === "Stamped proof artifacts dirty-input advisory");
    assert.equal(advisory?.status, "WARN", "validate-to-close emits dirty-input proof advisory warning");
    assert.match(advisory?.detail || "", /verify_gate\.mjs/, "dirty-input proof advisory names intersecting dirty file");
  } finally {
    rmSync(tempPlan, { recursive: true, force: true });
  }
}

console.log("receipt_repo_state_stamp: PASS");
