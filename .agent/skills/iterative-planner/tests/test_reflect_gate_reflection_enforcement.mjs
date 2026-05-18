#!/usr/bin/env node

import {
  mkdtempSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "fs";
import { basename, join } from "path";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import {
  REFLECTION_GUIDE_SECTION_ORDER,
  REFLECTION_GUIDE_SECTION_TITLES,
  REFLECTION_GUIDE_VERSION,
} from "../scripts/lib/reflection_guide.mjs";

const NODE = process.execPath;
const repoRoot = "/Users/stylianoskampakis/Dropbox (Personal)/Freelance/Iterative Planner";
const agentDir = join(repoRoot, ".agent");
const bootstrapScript = join(agentDir, "skills", "iterative-planner", "scripts", "bootstrap.mjs");
const verifyGateScript = join(agentDir, "skills", "iterative-planner", "scripts", "verify_gate.mjs");

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

function runNode(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-reflect-gate-${name}-`));
}

function seedProject(tmp, goal) {
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger"],
    fail_on: ["CRITICAL"],
  }, null, 2) + "\n");
  const bootstrap = runNode([bootstrapScript, "new", goal], tmp);
  assert(bootstrap.ok, `bootstrap new succeeds for "${goal}"`);
  const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
  return join(tmp, "plans", planName);
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function prepareReflectFixture(tmp, planDir) {
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Problem Statement
Exercise the structured reflect-to-validate enforcement path.

## Files To Modify
- .agent/skills/iterative-planner/scripts/verify_gate.mjs
`);
  writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Prepared reflect gate fixture
`);
  writeFileSync(join(planDir, "summary.md"), "# Summary\n\n[KB_NO_NEW_LEARNINGS]\n");

  const statePath = join(planDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.state = "REFLECT";
  state.close_signals = {
    kb: {
      satisfied: true,
      status: "no_new_learnings",
    },
    progress: {
      satisfied: true,
      open_items: 0,
    },
    semantic_substrate: {
      required: false,
      satisfied: true,
      status: "not_required",
      scan_scope: "planned_plus_nearby",
      scan_scope_used: "planned_plus_nearby",
      scope_degraded: false,
      scope_degraded_reason: null,
      relevant_domains: [],
      relevance_evidence: {
        config: "none",
        story_semantics: "none",
      },
      advisory_gap_ids: [],
      blocking_gap_ids: [],
    },
  };
  writeJson(statePath, state);
}

function writeReflectionGuide(planDir) {
  const planName = basename(planDir);
  const sections = {};
  for (const sectionId of REFLECTION_GUIDE_SECTION_ORDER) {
    sections[sectionId] = {
      title: REFLECTION_GUIDE_SECTION_TITLES[sectionId],
      questions: sectionId === "edge_case_coverage"
        ? [{
            id: "edge_case_coverage:uncovered_edge_cases",
            title: "Resolve uncovered edge cases",
            subject_id: "uncovered_edge_cases",
            required: true,
            answer_modes: ["pivot_back_to_execute", "accept_as_known_limitation", "out_of_scope"],
          }]
        : [],
    };
  }
  writeJson(join(planDir, "reflection_guide.yaml"), {
    reflection_guide: {
      version: REFLECTION_GUIDE_VERSION,
      plan_id: planName,
      generated_at: "2026-04-26T16:30:00Z",
      section_order: REFLECTION_GUIDE_SECTION_ORDER,
      sections,
      questions: [],
      required_question_count: 1,
      summary: {},
    },
  });
}

function buildReflectionDocument(planDir, {
  template = false,
  answeredCount = "1/1",
  edgeCaseCoverage = "out_of_scope — This fixture only exercises the reflect gate contract, so no uncovered runtime edge case remains after the required reflection answer is recorded.",
  nextMove = "VALIDATE — The reflection is structured, answered, and ready for proof review.",
} = {}) {
  const planName = basename(planDir);
  if (template) {
    return `---
plan_id: ${planName}
generated_from_guide: plans/${planName}/reflection_guide.yaml
guide_version: ${REFLECTION_GUIDE_VERSION}
answered_at: PENDING_UTC_TIMESTAMP
required_questions_answered: 0/0
---

# Reflection

## Solution Verdict
PASS / FAIL / PARTIAL. Did the implemented change actually improve the intended thing?

## Surprises
Keep this section even when the guide has no required question here.

## Plan vs Progress Divergence
Answer every required question from reflection_guide.yaml. Use \`### <subject>\` subsections when the guide asks about specific mistakes, retros, patterns, or conventions.

## Applicable KB Entries
Answer every required question from reflection_guide.yaml.

## Relevant Retros
Answer every required question from reflection_guide.yaml.

## Edge Case Coverage
Answer every required question from reflection_guide.yaml.

## Pattern Application Check
Keep this section even when the guide has no required question here.

## Thrashing & Process Signals
Keep this section even when the guide has no required question here.

## Proof Weight Audit
Keep this section even when the guide has no required question here.

## Next Time Candidates
Keep this section even when the guide has no required question here.

## Convention Application Check
Keep this section even when the guide has no required question here.

## Lessons Learned
### What worked well
Keep this section even when the guide has no required question here.

### What failed or took longer
Keep this section even when the guide has no required question here.

### Gotchas discovered
Keep this section even when the guide has no required question here.

### Next time
Keep this section even when the guide has no required question here.

## Semantic Verdict
Completed during REFLECT. This is the semantic/solution judgment surface before VALIDATE takes over proof sufficiency.

## Evidence-Readiness Verdict
READY / NOT READY. Is the work ready to enter VALIDATE, even if final proof has not yet passed?

## Next Move
Rewrite as needed within the active iteration; do not leave template text behind when moving to VALIDATE.
`;
  }

  return `---
plan_id: ${planName}
generated_from_guide: plans/${planName}/reflection_guide.yaml
guide_version: ${REFLECTION_GUIDE_VERSION}
answered_at: 2026-04-26T16:40:00Z
required_questions_answered: ${answeredCount}
---

# Reflection

## Solution Verdict
PASS — The structured reflection contract is fully answered and ready for deterministic validate-time checks.

## Surprises
The guide-backed reflection stayed readable while becoming substantially more checkable.

## Plan vs Progress Divergence
The only unplanned work was the shared validation wiring itself, and that was a discovered dependency needed to keep the reflect contract deterministic.

## Applicable KB Entries
Mistake M-001 stayed relevant because the runtime, docs, and tests all needed to move together instead of drifting apart.

## Relevant Retros
R-2026-03-24-001 still applies here because planner contract drift only stays closed when the gate and scaffold change together.

## Edge Case Coverage
${edgeCaseCoverage}

## Pattern Application Check
The deterministic parser-first pattern stayed intact because the same structured reflection contract now feeds both the CLI validator and the reflect gate.

## Thrashing & Process Signals
No execute-time thrashing signal fired in this focused fixture, and the guide-backed reflection stayed bounded enough not to create fresh churn.

## Proof Weight Audit
The structured reflection answer count gives VALIDATE a deterministic readiness signal instead of relying on prose-only confidence claims.

## Next Time Candidates
A reusable next-time candidate is to keep the guide generator, reflection validator, and reflect gate in the same commit whenever the schema expands again.

## Convention Application Check
No additional convention-specific question fired in this fixture, and the reflection still records that the naming and command surfaces stayed aligned.

## Lessons Learned
### What worked well
- Sharing a validator between the CLI and gate keeps the reflection contract honest.

### What failed or took longer
- Updating the scaffold, gate, and flow tests together touched more surfaces than the validator alone.

### Gotchas discovered
- A structured reflection can still look plausible until the gate checks for missing answers and template markers explicitly.

### Next time
- Generate the guide, answer it locally, and run validate-reflection before retrying reflect-to-validate.

## Semantic Verdict
PASS — Stories, ontology, and authoring semantics still line up after the structured reflection contract change.

## Evidence-Readiness Verdict
READY — The focused proof bundle is sufficient for this reflect gate fixture.

## Next Move
${nextMove}
`;
}

function writeReflection(planDir, options = {}) {
  writeReflectionGuide(planDir);
  writeFileSync(join(planDir, "reflection.md"), buildReflectionDocument(planDir, options));
}

function writeStoryRegistry(planDir, stories) {
  const reportsDir = join(planDir, "..", "..", "reports", "user_story_audit");
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, "story_registry.json"), {
    version: 1,
    updated: "2026-04-26T16:45:00Z",
    stories,
  });
}

function scenarioBlocksMissingArtifacts() {
  const tmp = makeTemp("missing");
  try {
    const planDir = seedProject(tmp, "reflect gate missing artifact fixture");
    prepareReflectFixture(tmp, planDir);
    rmSync(join(planDir, "reflection.md"), { force: true });
    rmSync(join(planDir, "reflection_guide.yaml"), { force: true });
    const gate = runNode([verifyGateScript, "reflect-to-validate", "--plan", basename(planDir)], tmp);
    assert(!gate.ok, "verify_gate reflect-to-validate blocks when structured reflection artifacts are missing");
    assert(gate.stdout.includes("reflection_missing"), "reflect-to-validate surfaces the reflection_missing blocker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAcceptsValidStructuredReflection() {
  const tmp = makeTemp("valid");
  try {
    const planDir = seedProject(tmp, "reflect gate valid fixture");
    prepareReflectFixture(tmp, planDir);
    writeReflection(planDir);
    const gate = runNode([verifyGateScript, "reflect-to-validate", "--plan", basename(planDir)], tmp);
    assert(gate.ok, "verify_gate reflect-to-validate accepts a valid structured reflection");
    assert(gate.stdout.includes("passes structured validation against reflection_guide.yaml"), "reflect-to-validate reports structured validation success");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBlocksTemplateReflection() {
  const tmp = makeTemp("template");
  try {
    const planDir = seedProject(tmp, "reflect gate template fixture");
    prepareReflectFixture(tmp, planDir);
    writeReflection(planDir, { template: true });
    const gate = runNode([verifyGateScript, "reflect-to-validate", "--plan", basename(planDir)], tmp);
    assert(!gate.ok, "verify_gate reflect-to-validate blocks untouched structured reflection scaffolds");
    assert(gate.stdout.includes("vacuous_answer"), "reflect-to-validate reports the vacuous_answer blocker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBlocksMissingRequiredAnswer() {
  const tmp = makeTemp("missing-answer");
  try {
    const planDir = seedProject(tmp, "reflect gate missing-answer fixture");
    prepareReflectFixture(tmp, planDir);
    writeReflection(planDir, {
      answeredCount: "0/1",
      edgeCaseCoverage: "",
    });
    const gate = runNode([verifyGateScript, "reflect-to-validate", "--plan", basename(planDir)], tmp);
    assert(!gate.ok, "verify_gate reflect-to-validate blocks when a required reflection answer is missing");
    assert(gate.stdout.includes("required_question_unanswered"), "reflect-to-validate reports the required_question_unanswered blocker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBlocksPivotDecision() {
  const tmp = makeTemp("pivot");
  try {
    const planDir = seedProject(tmp, "reflect gate pivot fixture");
    prepareReflectFixture(tmp, planDir);
    writeReflection(planDir, {
      edgeCaseCoverage: "pivot_back_to_execute — The uncovered fixture edge case needs a new regression test before the proof surface is trustworthy enough to continue.",
      nextMove: "EXECUTE — Add the missing regression coverage before returning to REFLECT.",
    });
    const gate = runNode([verifyGateScript, "reflect-to-validate", "--plan", basename(planDir)], tmp);
    assert(!gate.ok, "verify_gate reflect-to-validate blocks when reflection requests a pivot back to EXECUTE");
    assert(gate.stdout.includes("pivot_did_not_revert_phase"), "reflect-to-validate reports the pivot_did_not_revert_phase blocker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBlocksKnownLimitationWithoutStory() {
  const tmp = makeTemp("known-limitation");
  try {
    const planDir = seedProject(tmp, "reflect gate known-limitation fixture");
    prepareReflectFixture(tmp, planDir);
    writeStoryRegistry(planDir, [
      {
        id: "US-001",
        title: "Unrelated story",
        status: "FULLY_COVERED",
        code_refs: [],
        test_refs: [],
        validation_refs: [],
      },
    ]);
    writeReflection(planDir, {
      edgeCaseCoverage: "accept_as_known_limitation — The fixture can ship without the extra edge-case test for now, but it needs follow-up story US-999 before close.",
    });
    const gate = runNode([verifyGateScript, "reflect-to-validate", "--plan", basename(planDir)], tmp);
    assert(!gate.ok, "verify_gate reflect-to-validate blocks known limitations without a filed follow-up story");
    assert(gate.stdout.includes("known_limitation_no_followup"), "reflect-to-validate reports the known_limitation_no_followup blocker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nReflect Gate Reflection Enforcement Test\n");

scenarioBlocksMissingArtifacts();
scenarioAcceptsValidStructuredReflection();
scenarioBlocksTemplateReflection();
scenarioBlocksMissingRequiredAnswer();
scenarioBlocksPivotDecision();
scenarioBlocksKnownLimitationWithoutStory();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
