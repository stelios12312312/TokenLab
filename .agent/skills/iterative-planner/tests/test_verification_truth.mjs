#!/usr/bin/env node

import assert from "assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  classifyPlannedEvidencePath,
  deriveVerificationTruth,
  normalizePresentationResult,
  normalizeVerificationMode,
  syncLedgerFromStrategy,
} from "../scripts/lib/verification_truth.mjs";

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS: ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL: ${label}`);
    console.log(`        ${error.message}`);
  }
}

function makePlanDir(name) {
  const root = mkdtempSync(join(tmpdir(), `planner-verification-truth-${name}-`));
  const planDir = join(root, "plans", "plan_fixture");
  mkdirSync(planDir, { recursive: true });
  return { root, planDir };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function markdownProofTable(result = "PASS") {
  return `# Verification

## Criteria Verification
| Criterion | Result | Evidence |
|---|---|---|
| Fixture criterion | ${result} | Command output below. |

## Proof
\`\`\`text
node fixture-test.mjs
all fixture checks passed
0 failures across the fixture proof bundle
\`\`\`

This verification report contains enough ordinary explanatory words to satisfy the legacy markdown proof floor. The command output is intentionally small but substantive, and the table result token remains strict so presentation nuance belongs in the evidence column instead of the result column. Additional context records deterministic command execution, expected behavior, observed behavior, residual scope, operator rationale, regression coverage, artifact provenance, and closeout confidence without relying on ornamental wording.
`;
}

check("strict presentation result tokens reject residual-warning prose", () => {
  assert.equal(normalizePresentationResult("PASS").kind, "pass");
  assert.equal(normalizePresentationResult("WAIVED").kind, "waived");
  assert.equal(normalizePresentationResult("N/A").kind, "not_applicable");
  assert.equal(normalizePresentationResult("PASS WITH RESIDUAL WARNINGS").valid, false);
});

check("unsupported historical modes normalize to the strict mode enum", () => {
  assert.equal(normalizeVerificationMode("integration"), "integration_smoke");
  assert.equal(normalizeVerificationMode("migration_simulation"), "migration_smoke");
  assert.equal(normalizeVerificationMode("browser_journey"), "browser_visual");
});

check("ledger truth wins over markdown residual-warning presentation", () => {
  const { root, planDir } = makePlanDir("ledger-first");
  try {
    writeFileSync(join(planDir, "plan.md"), "# Plan\n");
    writeFileSync(join(planDir, "verification.md"), markdownProofTable("PASS WITH RESIDUAL WARNINGS"));
    writeJson(join(planDir, "verification_ledger.json"), {
      version: 1,
      obligations: [
        { id: "vo_migration", subject: "crit:sc_1", mode: "migration_smoke", severity: "required" },
      ],
      evidence: [
        {
          id: "ev_migration",
          subject: "crit:sc_1",
          mode: "migration_smoke",
          status: "PASS",
          command: "node .agent/skills/iterative-planner/tests/test_migration.mjs",
          evidence: "migration smoke passed",
        },
      ],
    });

    const truth = deriveVerificationTruth({ planDir });
    assert.equal(truth.source, "ledger");
    assert.equal(truth.allVerificationPass, true);
    assert.equal(truth.proofOfWork, true);
    assert.equal(truth.hasPassedMode.migration_smoke, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("markdown fallback remains available for no-ledger plans", () => {
  const { root, planDir } = makePlanDir("markdown-fallback");
  try {
    writeFileSync(join(planDir, "verification.md"), markdownProofTable("PASS"));
    const truth = deriveVerificationTruth({ planDir });
    assert.equal(truth.source, "markdown_fallback");
    assert.equal(truth.allVerificationPass, true);
    assert.equal(truth.proofOfWork, true);
    assert(truth.warnings.includes("verification_ledger_missing_markdown_fallback_deprecated"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("markdown fallback blocks non-strict presentation result tokens", () => {
  const { root, planDir } = makePlanDir("markdown-invalid-token");
  try {
    writeFileSync(join(planDir, "verification.md"), markdownProofTable("PASS WITH RESIDUAL WARNINGS"));
    const truth = deriveVerificationTruth({ planDir });
    assert.equal(truth.source, "markdown_fallback");
    assert.equal(truth.allVerificationPass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("strategy synchronization creates normalized criterion obligations", () => {
  const synced = syncLedgerFromStrategy({
    strategy: {
      verification_strategy: {
        criteria: [
          {
            id: "CRIT-001",
            criterion: "Recipe migration parity remains covered.",
            story_id: "US-015",
            required_proof_type: "proof:orchestration_smoke plus proof:migration_parity",
          },
        ],
      },
    },
    successCriteria: [
      { id: "sc_1", label: "Recipe migration parity remains covered." },
    ],
  });

  const obligationKeys = synced.obligations.map((entry) => `${entry.subject}:${entry.mode}`).sort();
  assert(obligationKeys.includes("crit:CRIT-001:integration_smoke"));
  assert(obligationKeys.includes("crit:CRIT-001:migration_smoke"));
  assert(obligationKeys.includes("crit:sc_1:integration_smoke"));
  assert(obligationKeys.includes("crit:sc_1:migration_smoke"));
});

check("migration-managed planner paths are distinct from ordinary app code", () => {
  const strategy = {
    criteria: [
      { id: "CRIT-001", required_proof_type: "proof:migration_parity" },
    ],
  };
  assert.equal(
    classifyPlannedEvidencePath(".agent/skills/iterative-planner/scripts/foo.mjs", { strategy }).kind,
    "migration_managed",
  );
  assert.equal(
    classifyPlannedEvidencePath("src/app.js", { strategy }).kind,
    "code",
  );
});

console.log(`test_verification_truth passed: ${passed} assertions`);
if (failed > 0) process.exit(1);
