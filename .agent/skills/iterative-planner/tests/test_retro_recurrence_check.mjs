#!/usr/bin/env node
// test_retro_recurrence_check.mjs — deterministic retro/mistake recurrence guard contracts.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  evaluateRetroRecurrenceCheck,
  recurrenceCheckToBlockers,
} from "../scripts/lib/retro_recurrence_check.mjs";

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

function makeTemp() {
  return mkdtempSync(join(tmpdir(), "retro-recurrence-check-"));
}

function writeStoryRegistry(tmp) {
  const dir = join(tmp, "reports", "user_story_audit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "story_registry.json"), JSON.stringify({
    stories: [
      {
        id: "US-079",
        title: "Program Manager workflow and Program Packet validation",
        status: "FULLY_COVERED",
        tags: ["workflow", "ontology", "traceability"],
        code_refs: [".agent/skills/iterative-planner/scripts/program_manager.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_program_idea_intake.mjs"],
        validation_refs: ["program-manager-tests"],
      },
    ],
  }, null, 2), "utf-8");
}

function writeRetroLedger(tmp) {
  const dir = join(tmp, "plans", "knowledge", "retros", "cases");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "R-2026-03-24-001.md"), "# R-2026-03-24-001\n", "utf-8");
  writeFileSync(join(tmp, "plans", "knowledge", "retros", "retro_ledger.json"), JSON.stringify({
    version: 1,
    retros: [
      {
        id: "R-2026-03-24-001",
        date: "2026-03-24",
        title: "Planner-core gate rollout missed ripple-through surfaces",
        summary: "Planner-core behavior missed docs, migration, ontology, and regression surfaces.",
        status: "accepted",
        promotion_decision: "hard_invariant",
        case_file: "plans/knowledge/retros/cases/R-2026-03-24-001.md",
        promotions: { mistake_ids: ["M-001"] },
        kb_refs: ["plans/knowledge/mistakes.md#M-001"],
        tags: ["planner_core", "ripple_through", "migration"],
        affected_surfaces: [".agent/skills/iterative-planner", ".agent/workflows"],
      },
    ],
  }, null, 2), "utf-8");
}

function basePacket(overrides = {}) {
  return {
    id: "PGM-RECURRENCE",
    title: "Recurrence Fixture",
    status: "design",
    tickets: [],
    acceptance_criteria: [],
    verification_matrix: [],
    ...overrides,
  };
}

function ticket(overrides = {}) {
  return {
    id: "T-001",
    title: "Planner workflow migration guard",
    lifecycle: "proposed",
    story_refs: ["US-079"],
    gap_refs: [],
    defect_refs: [],
    acceptance_criteria: [],
    verification_refs: [],
    review_artifacts: [],
    ...overrides,
  };
}

console.log("\nRetro Recurrence Check Contracts\n");

{
  const tmp = makeTemp();
  try {
    writeStoryRegistry(tmp);
    writeRetroLedger(tmp);
    const result = evaluateRetroRecurrenceCheck({
      cwd: tmp,
      sourceText: "Update planner workflow migration in .agent/skills/iterative-planner/scripts/program_manager.mjs and .agent/workflows/program-manager.md",
      packet: basePacket(),
      ticket: ticket(),
    });
    const blockers = recurrenceCheckToBlockers(result);

    assert(result.status === "blocked", "trusted active mistake blocks when required evidence is missing");
    assert(result.matches.some((entry) => entry.source_type === "mistake" && entry.id === "M-001" && entry.blocking === true), "M-001 is a blocking recurrence match");
    assert(result.matches.some((entry) => entry.source_type === "retro" && entry.linked_ids.includes("M-001")), "linked retro promotion is included");
    assert(blockers.some((entry) => entry.code === "retro_recurrence_blocked"), "blocked recurrence converts to deterministic blocker");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    writeStoryRegistry(tmp);
    const verificationRows = [
      {
        id: "VM-001",
        proof_type: "proof:migration_parity",
        command_or_action: "Run ripple_check and test_migration for the planner workflow migration",
        pass_means: "ripple_check and test_migration pass",
      },
    ];
    const result = evaluateRetroRecurrenceCheck({
      cwd: tmp,
      sourceText: "Update planner workflow migration in .agent/skills/iterative-planner/scripts/program_manager.mjs and .agent/workflows/program-manager.md",
      packet: basePacket({ verification_matrix: verificationRows }),
      ticket: ticket({ verification_refs: ["VM-001"] }),
      verificationRows,
    });

    assert(result.status !== "blocked", "existing verification evidence satisfies the trusted recurrence check");
    assert(result.matches.some((entry) => entry.id === "M-001" && entry.status === "pass" && entry.evidence_refs.includes("VM-001")), "M-001 records satisfying evidence refs");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  try {
    writeStoryRegistry(tmp);
    const result = evaluateRetroRecurrenceCheck({
      cwd: tmp,
      sourceText: "Compare retro notes about responsive viewport language without touching UI files or planner migration code",
      packet: basePacket(),
      ticket: ticket({ title: "Retro note comparison", story_refs: [], gap_refs: ["GAP-001"] }),
    });

    assert(result.status !== "blocked", "weak lexical retro overlap stays non-blocking");
    assert(result.matches.every((entry) => entry.blocking !== true), "advisory recurrence matches are not blocker-capable");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = makeTemp();
  const secret = "sk-retro-recurrence-not-real";
  try {
    const result = evaluateRetroRecurrenceCheck({
      cwd: tmp,
      sourceText: `Planner ticket text must not leak ${secret}`,
      packet: basePacket(),
      ticket: ticket({ title: `Do not leak ${secret}` }),
      env: { PLANNER_DRIFT_LLM_API_KEY: secret },
    });

    assert(!JSON.stringify(result).includes(secret), "recurrence check output redacts API-shaped secrets");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
