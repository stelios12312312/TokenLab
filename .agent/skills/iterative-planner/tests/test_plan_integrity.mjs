#!/usr/bin/env node

import assert from "assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  PLAN_APPROVAL_INTEGRITY_VERSION,
  PLAN_TAMPER_FINGERPRINT_VERSION,
  computeLegacyPlanMarkdownHash,
  computePlanApprovalIntegrity,
  computePlanApprovalIntegrityForState,
  computePlanTamperFingerprint,
} from "../scripts/lib/plan_integrity.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${error.message}`);
  }
}

function makePlanDir() {
  const planDir = mkdtempSync(join(tmpdir(), "planner-plan-integrity-"));
  writeFileSync(join(planDir, "plan.md"), "# Plan\n\n## Goal\nProtect approved plan artifacts.\n");
  writeFileSync(join(planDir, "verification_strategy.yaml"), JSON.stringify({
    verification_strategy: {
      version: 1,
      criteria: [
        { id: "CRIT-001", criterion: "Structured artifact is approved" },
      ],
    },
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "plan.json"), JSON.stringify({
    goal: "future structured plan artifact",
    files: ["plan.md"],
  }, null, 2) + "\n");
  return planDir;
}

function makeProjectBackedPlanDir() {
  const root = mkdtempSync(join(tmpdir(), "planner-plan-integrity-project-"));
  const planDir = join(root, "plans", "plan_integrity_fixture");
  mkdirSync(planDir, { recursive: true });
  mkdirSync(join(root, ".agent/skills/iterative-planner/scripts/lib"), { recursive: true });
  mkdirSync(join(root, ".agent/skills/iterative-planner/prolog"), { recursive: true });
  mkdirSync(join(root, ".agent/skills/iterative-planner/config"), { recursive: true });

  writeFileSync(join(planDir, "plan.md"), "# Plan\n\n## Goal\nProtect enforcement artifacts.\n");
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    version: 1,
    state: "PLAN",
    plan_dir: "plan_integrity_fixture",
    transitions: [],
  }, null, 2) + "\n");
  writeFileSync(join(root, ".agent/skills/iterative-planner/scripts/lib/prolog.mjs"), "// prolog bridge\n");
  writeFileSync(join(root, ".agent/skills/iterative-planner/prolog/invariants.pl"), "% invariants\n");
  writeFileSync(join(root, ".agent/skills/iterative-planner/prolog/transitions.pl"), "% transitions\n");
  writeFileSync(join(root, ".agent/skills/iterative-planner/config/determinism.json"), "{\"version\":1}\n");

  return { root, planDir };
}

console.log("\nPlan Integrity Contract Test\n");

test("bundle integrity includes structured approval artifacts", () => {
  const planDir = makePlanDir();
  try {
    const integrity = computePlanApprovalIntegrity(planDir);
    assert.equal(integrity.version, PLAN_APPROVAL_INTEGRITY_VERSION);
    assert.deepStrictEqual(integrity.artifacts.map((artifact) => artifact.name), [
      "plan.md",
      "verification_strategy.yaml",
      "plan.json",
    ]);
    assert.match(integrity.hash, /^[0-9a-f]{32}$/);
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("verification_strategy-only tamper changes versioned approval hash", () => {
  const planDir = makePlanDir();
  try {
    const before = computePlanApprovalIntegrityForState(planDir, {
      approved_plan_hash_version: PLAN_APPROVAL_INTEGRITY_VERSION,
    }).hash;
    writeFileSync(join(planDir, "verification_strategy.yaml"), JSON.stringify({
      verification_strategy: {
        version: 1,
        criteria: [
          { id: "CRIT-001", criterion: "Tampered structured artifact" },
        ],
      },
    }, null, 2) + "\n");
    const after = computePlanApprovalIntegrityForState(planDir, {
      approved_plan_hash_version: PLAN_APPROVAL_INTEGRITY_VERSION,
    }).hash;
    assert.notEqual(after, before);
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("plan.json-only tamper changes versioned approval hash", () => {
  const planDir = makePlanDir();
  try {
    const before = computePlanApprovalIntegrity(planDir).hash;
    writeFileSync(join(planDir, "plan.json"), JSON.stringify({
      goal: "tampered future structured plan artifact",
      files: ["plan.md", "verification_strategy.yaml"],
    }, null, 2) + "\n");
    const after = computePlanApprovalIntegrity(planDir).hash;
    assert.notEqual(after, before);
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("legacy approval hash stays markdown-only for old state metadata", () => {
  const planDir = makePlanDir();
  try {
    const legacyBefore = computeLegacyPlanMarkdownHash(planDir);
    const stateResolvedBefore = computePlanApprovalIntegrityForState(planDir, {
      approved_plan_hash: legacyBefore,
    });
    writeFileSync(join(planDir, "verification_strategy.yaml"), JSON.stringify({
      verification_strategy: {
        version: 1,
        criteria: [
          { id: "CRIT-001", criterion: "Legacy path ignores structured artifact" },
        ],
      },
    }, null, 2) + "\n");
    const stateResolvedAfter = computePlanApprovalIntegrityForState(planDir, {
      approved_plan_hash: legacyBefore,
    });
    assert.equal(stateResolvedBefore.version, "legacy_plan_md_v1");
    assert.equal(stateResolvedAfter.hash, legacyBefore);
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("artifact metadata opts a state into bundle integrity", () => {
  const planDir = makePlanDir();
  try {
    const before = computePlanApprovalIntegrityForState(planDir, {
      approved_plan_hash_artifacts: ["plan.md", "verification_strategy.yaml"],
    }).hash;
    writeFileSync(join(planDir, "verification_strategy.yaml"), "{\"verification_strategy\":{\"version\":1,\"criteria\":[]}}\n");
    const after = computePlanApprovalIntegrityForState(planDir, {
      approved_plan_hash_artifacts: ["plan.md", "verification_strategy.yaml"],
    }).hash;
    assert.notEqual(after, before);
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("tamper fingerprint includes state and sensitive plan artifacts", () => {
  const planDir = makePlanDir();
  try {
    writeFileSync(join(planDir, "state.json"), JSON.stringify({
      version: 1,
      state: "PLAN",
      plan_dir: "plan_test",
      transitions: [],
    }, null, 2) + "\n");

    const fingerprint = computePlanTamperFingerprint(planDir, {
      stateJson: {
        version: 1,
        state: "PLAN",
        plan_dir: "plan_test",
        transitions: [],
      },
    });
    assert.equal(fingerprint.version, PLAN_TAMPER_FINGERPRINT_VERSION);
    assert.match(fingerprint.hash, /^[0-9a-f]{32}$/);
    assert(fingerprint.artifacts.some((artifact) => artifact.name === "state.json"));
    assert(fingerprint.artifacts.some((artifact) => artifact.name === "plan.md"));
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("tamper fingerprint covers planner enforcement bundle", () => {
  const fixture = makeProjectBackedPlanDir();
  try {
    const fingerprint = computePlanTamperFingerprint(fixture.planDir, {
      stateJson: {
        version: 1,
        state: "PLAN",
        plan_dir: "plan_integrity_fixture",
        transitions: [],
      },
    });
    const artifactNames = new Set(fingerprint.artifacts.map((artifact) => artifact.name));
    assert(artifactNames.has("skill:scripts/lib/prolog.mjs"));
    assert(artifactNames.has("skill:prolog/invariants.pl"));
    assert(artifactNames.has("skill:prolog/transitions.pl"));
    assert(artifactNames.has("skill:config/determinism.json"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("tamper fingerprint ignores its own stored state field", () => {
  const planDir = makePlanDir();
  try {
    const stateJson = {
      version: 1,
      state: "EXECUTE",
      plan_dir: "plan_test",
      transitions: [{ from: "PLAN", to: "EXECUTE" }],
      updated_at: "2026-05-27T00:00:00.000Z",
    };
    const before = computePlanTamperFingerprint(planDir, { stateJson }).hash;
    const after = computePlanTamperFingerprint(planDir, {
      stateJson: {
        ...stateJson,
        updated_at: "2026-05-27T00:01:00.000Z",
        _state_hash: "ignored",
        tamper_fingerprint: {
          version: PLAN_TAMPER_FINGERPRINT_VERSION,
          hash: before,
          generated_at: "2026-05-27T00:00:30.000Z",
        },
      },
    }).hash;
    assert.equal(after, before);
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("tamper fingerprint changes when a sensitive artifact changes", () => {
  const planDir = makePlanDir();
  try {
    writeFileSync(join(planDir, "findings.md"), "# Findings\n\n## F-001\nOriginal finding.\n");
    const stateJson = {
      version: 1,
      state: "EXECUTE",
      plan_dir: "plan_test",
      transitions: [],
    };
    const before = computePlanTamperFingerprint(planDir, { stateJson }).hash;
    writeFileSync(join(planDir, "findings.md"), "# Findings\n\n## F-001\nTampered finding.\n");
    const after = computePlanTamperFingerprint(planDir, { stateJson }).hash;
    assert.notEqual(after, before);
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
