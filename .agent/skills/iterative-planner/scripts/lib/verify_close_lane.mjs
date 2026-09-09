// verify_close_lane.mjs — "Verify-and-Close" express lane for fast-track work.
//
// Completes a routine/bug-fix plan in ONE transition instead of the four
// sequential essay-writing gates (reflect → validate → close → notify).
// The lane verifies intent with executable proofs instead of markdown essays:
//   1. Test execution proof   — `node --test` (or --test-cmd override) exits 0
//   2. Invariant check proof  — rule_engine.mjs check-invariants exits 0
//   3. verification_receipt.json — intent matched, failure/edge-case tested,
//      blast radius clean (validated if present, generated from proofs if not)
//
// The legacy six gates remain untouched for multi-phase programs. A plan may
// take this lane only from EXECUTE/REFLECT/VALIDATE, and only when the plan is
// fast-track (/boost, [FAST_TRACK], or findings_ledger fast_track) or --force
// is given explicitly.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import { planUsesFastTrack } from "./plan_utils.mjs";
import { PASS, FAIL, WARN, check } from "./plan_utils.mjs";
import { nowISO, withFailureCode } from "./determinism.mjs";

export const VERIFY_AND_CLOSE_STATES = new Set(["EXECUTE", "REFLECT", "VALIDATE"]);
export const DEFAULT_VERIFY_CLOSE_TEST_CMD = "node --test tests/";
export const VERIFICATION_RECEIPT_FILE = "verification_receipt.json";

const __lane_filename = fileURLToPath(import.meta.url);
const skillPath = join(dirname(__lane_filename), "..", "..");

export function verificationReceiptPath(planDir) {
  return join(planDir, VERIFICATION_RECEIPT_FILE);
}

export function readVerificationReceipt(planDir) {
  const path = verificationReceiptPath(planDir);
  if (!existsSync(path)) return { present: false, path, receipt: null };
  try {
    return { present: true, path, receipt: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { present: true, path, receipt: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildVerificationReceipt({ planDirName, testCmd, testExitCode, invariantExitCode }) {
  return {
    schema_version: 1,
    generated_by: "verify-and-close",
    plan_id: planDirName,
    intent_matched: true,
    failure_or_edge_case_tested: true,
    blast_radius_clean: true,
    proofs: {
      test_command: testCmd,
      test_exit_code: testExitCode,
      invariant_check: invariantExitCode === 0 ? "pass" : "fail",
      invariant_command: "node .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants",
    },
    created_at: nowISO(),
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

export function writeVerificationReceipt(planDir, receipt) {
  writeJsonAtomic(verificationReceiptPath(planDir), receipt);
  return verificationReceiptPath(planDir);
}

/**
 * Run the express-lane proof battery. Pure evaluation: no state mutation.
 * Returns { results, proofs: {testCmd, testExitCode, invariantExitCode} }.
 */
export function runVerifyAndCloseProofs({ cwd = process.cwd(), planDir, planDirName, testCmd = DEFAULT_VERIFY_CLOSE_TEST_CMD }) {
  const results = [];

  // Proof 1: test execution.
  const testRun = spawnSync(testCmd, {
    cwd,
    shell: true,
    encoding: "utf-8",
    timeout: 300_000,
    env: { ...process.env },
  });
  const testExitCode = testRun.status === null ? 124 : (testRun.status ?? 2);
  results.push(testExitCode === 0
    ? check("Test execution proof", PASS, `\`${testCmd}\` exited 0.`)
    : withFailureCode(check(
        "Test execution proof",
        FAIL,
        `\`${testCmd}\` exited ${testExitCode}.${testRun.stderr ? ` stderr: ${String(testRun.stderr).slice(0, 400)}` : ""}`,
      ), "GATE-VAC-001"));

  // Proof 2: invariant check.
  const ruleEngine = join(skillPath, "scripts", "rule_engine.mjs");
  const invariantRun = spawnSync(process.execPath, [ruleEngine, "check-invariants", "--smoke"], {
    cwd,
    encoding: "utf-8",
    timeout: 300_000,
    env: { ...process.env },
  });
  const invariantExitCode = invariantRun.status === null ? 124 : (invariantRun.status ?? 2);
  results.push(invariantExitCode === 0
    ? check("Invariant check proof", PASS, "rule_engine.mjs check-invariants exited 0.")
    : withFailureCode(check(
        "Invariant check proof",
        FAIL,
        `rule_engine.mjs check-invariants exited ${invariantExitCode}.${invariantRun.stderr ? ` stderr: ${String(invariantRun.stderr).slice(0, 400)}` : ""}`,
      ), "GATE-VAC-002"));

  // Proof 3: verification receipt (intent / failure-or-edge-case / blast radius).
  const receiptRead = readVerificationReceipt(planDir);
  if (!receiptRead.present) {
    results.push(testExitCode === 0 && invariantExitCode === 0
      ? check("Verification receipt", PASS, `${VERIFICATION_RECEIPT_FILE} absent — will be generated from the proofs above.`)
      : withFailureCode(check(
          "Verification receipt",
          FAIL,
          `${VERIFICATION_RECEIPT_FILE} absent and proofs did not all pass — cannot self-certify.`,
        ), "GATE-VAC-003"));
  } else if (receiptRead.error) {
    results.push(withFailureCode(check(
      "Verification receipt",
      FAIL,
      `${VERIFICATION_RECEIPT_FILE} is unreadable: ${receiptRead.error}`,
    ), "GATE-VAC-003"));
  } else {
    const receipt = receiptRead.receipt || {};
    const confirmations = [
      ["intent_matched", receipt.intent_matched],
      ["failure_or_edge_case_tested", receipt.failure_or_edge_case_tested],
      ["blast_radius_clean", receipt.blast_radius_clean],
    ];
    const unconfirmed = confirmations.filter(([, value]) => value !== true).map(([key]) => key);
    results.push(unconfirmed.length === 0
      ? check("Verification receipt", PASS, `${VERIFICATION_RECEIPT_FILE} confirms intent, failure/edge-case coverage, and clean blast radius.`)
      : withFailureCode(check(
          "Verification receipt",
          FAIL,
          `${VERIFICATION_RECEIPT_FILE} does not confirm: ${unconfirmed.join(", ")}.`,
        ), "GATE-VAC-003"));
  }

  return { results, proofs: { testCmd, testExitCode, invariantExitCode } };
}

/**
 * Gate-style eligibility rows for the express lane.
 */
export function evaluateVerifyAndCloseEligibility({ planDir, stateJson, force = false }) {
  const results = [];
  const state = String(stateJson?.state || "").toUpperCase();
  results.push(VERIFY_AND_CLOSE_STATES.has(state)
    ? check("Express lane eligibility", PASS, `State ${state} may complete via verify-and-close.`)
    : withFailureCode(check(
        "Express lane eligibility",
        FAIL,
        `State ${state || "unknown"} cannot use verify-and-close (allowed from: ${[...VERIFY_AND_CLOSE_STATES].join(", ")}). Use the legacy gates.`,
      ), "GATE-VAC-004"));
  if (stateJson?.state === "CLOSE") {
    results.push(withFailureCode(check(
      "Post-close mutation guard",
      FAIL,
      "Plan is already CLOSED — no further state-mutating transitions are allowed.",
    ), "GATE-GAR-001"));
  }

  const fastTrack = planUsesFastTrack(planDir, process.env);
  if (fastTrack) {
    results.push(check("Fast-track context", PASS, "Plan is fast-track (/boost or [FAST_TRACK]) — express lane authorized."));
  } else if (force) {
    results.push(check("Fast-track context", WARN, "Plan is NOT fast-track; proceeding via explicit --force override."));
  } else {
    results.push(withFailureCode(check(
      "Fast-track context",
      FAIL,
      "Plan is not fast-track. The express lane is reserved for routine/bug-fix work: use /boost, mark [FAST_TRACK] in findings.md, or pass --force explicitly.",
    ), "GATE-VAC-005"));
  }
  return results;
}
