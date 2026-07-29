#!/usr/bin/env node

import {
  mkdtempSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { fileURLToPath, pathToFileURL } from "url";

import {
  createInitialStateJson,
  readStateJson,
  writeStateJson,
} from "../scripts/lib/determinism.mjs";
import {
  REFLECTION_GUIDE_SECTION_ORDER,
  REFLECTION_GUIDE_SECTION_TITLES,
  REFLECTION_GUIDE_VERSION,
} from "../scripts/lib/reflection_guide.mjs";
import { normalizeReflectionDecisionAnswer } from "../scripts/lib/reflection_validation.mjs";

const NODE = process.execPath;
const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const ruleEngineScript = join(agentDir, "skills", "iterative-planner", "scripts", "rule_engine.mjs");

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
  return mkdtempSync(join(tmpdir(), `planner-reflection-invariants-${name}-`));
}

function seedProject(tmp, goal) {
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger"],
    fail_on: ["CRITICAL"],
  }, null, 2) + "\n");
  const planName = `plan_${goal.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "reflection_fixture"}`;
  const plansDir = join(tmp, "plans");
  const planDir = join(plansDir, planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(plansDir, ".current_plan"), `${planName}\n`);
  writeStateJson(planDir, createInitialStateJson(planName, goal, { projectRoot: tmp }));
  return planDir;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function prepareReflectFixture(planDir) {
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Problem Statement
Exercise the structured reflection invariant surface.

## Files To Modify
- .agent/skills/iterative-planner/prolog/invariants.pl
`);
  writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Prepared reflection invariant fixture
`);
  writeFileSync(join(planDir, "summary.md"), "# Summary\n\n[KB_NO_NEW_LEARNINGS]\n");

  const state = readStateJson(planDir);
  state.state = "REFLECT";
  state.close_signals = {
    kb: { satisfied: true, status: "no_new_learnings" },
    progress: { satisfied: true, open_items: 0 },
    semantic_substrate: {
      required: false,
      satisfied: true,
      status: "not_required",
      scan_scope: "planned_plus_nearby",
      scan_scope_used: "planned_plus_nearby",
      scope_degraded: false,
      scope_degraded_reason: null,
      relevant_domains: [],
      relevance_evidence: { config: "none", story_semantics: "none" },
      advisory_gap_ids: [],
      blocking_gap_ids: [],
    },
  };
  writeStateJson(planDir, state);
  writeStoryRegistry(planDir, [
    {
      id: "US-001",
      title: "Reflection fixture baseline",
      status: "NOT_IMPLEMENTED",
      code_refs: [],
      test_refs: [],
      validation_refs: [],
    },
  ]);
}

function writeStoryRegistry(planDir, stories = []) {
  const reportsDir = join(planDir, "..", "..", "reports", "user_story_audit");
  mkdirSync(reportsDir, { recursive: true });
  writeJson(join(reportsDir, "story_registry.json"), {
    version: 1,
    updated: "2026-04-26T17:45:00Z",
    stories,
  });
}

function writeReflectionGuide(planDir, { includeRequiredRetro = false, noModeQuestion = false } = {}) {
  const planName = basename(planDir);
  const sections = {};
  for (const sectionId of REFLECTION_GUIDE_SECTION_ORDER) {
    sections[sectionId] = {
      title: REFLECTION_GUIDE_SECTION_TITLES[sectionId],
      questions: [],
    };
  }

  if (noModeQuestion) {
    sections.pattern_application_check.questions.push({
      id: "pattern_application_check:regression_verdict",
      title: "Regression verdict",
      subject_id: "regression_verdict",
      required: true,
      answer_modes: [],
    });
  } else {
    sections.edge_case_coverage.questions.push({
      id: "edge_case_coverage:uncovered_edge_cases",
      title: "Resolve uncovered edge cases",
      subject_id: "uncovered_edge_cases",
      required: true,
      answer_modes: ["pivot_back_to_execute", "accept_as_known_limitation", "out_of_scope"],
    });
  }

  if (includeRequiredRetro) {
    sections.relevant_retros.retros = [
      {
        id: "R-2026-04-20-001",
        required: true,
        matches_because: "change_class_overlap",
      },
    ];
    sections.relevant_retros.questions.push({
      id: "relevant_retros:r_2026_04_20_001",
      title: "Address R-2026-04-20-001",
      subject_id: "R-2026-04-20-001",
      required: true,
      answer_modes: [],
    });
  } else {
    sections.relevant_retros.retros = [];
  }

  const requiredQuestionCount = Object.values(sections)
    .flatMap((section) => section.questions || [])
    .filter((question) => question.required !== false)
    .length;

  writeJson(join(planDir, "reflection_guide.yaml"), {
    reflection_guide: {
      version: REFLECTION_GUIDE_VERSION,
      plan_id: planName,
      generated_at: "2026-04-26T17:30:00Z",
      section_order: REFLECTION_GUIDE_SECTION_ORDER,
      sections,
      questions: [],
      required_question_count: requiredQuestionCount,
      summary: {},
    },
  });
}

function buildReflectionDocument(planDir, {
  answeredCount = "1/1",
  edgeCaseCoverage = "out_of_scope — This fixture only exercises the invariant surface, so no uncovered runtime edge case remains after the required reflection answer is recorded.",
  relevantRetros = "The surrounding planner contract changed, but this paragraph intentionally avoids naming the required retro id so the invariant can detect the gap.",
  patternApplicationCheck = "The deterministic parser-first pattern stayed intact because the same structured reflection contract now feeds both the CLI validator and the semantic layer.",
  nextMove = "VALIDATE — The reflection is structured, answered, and ready for proof review.",
} = {}) {
  const planName = basename(planDir);
  return `---
plan_id: ${planName}
generated_from_guide: plans/${planName}/reflection_guide.yaml
guide_version: ${REFLECTION_GUIDE_VERSION}
answered_at: 2026-04-26T17:40:00Z
required_questions_answered: ${answeredCount}
---

# Reflection

## Solution Verdict
PASS — The structured reflection contract is fully answered and ready for deterministic validation.

## Surprises
The guide-backed reflection stayed readable while becoming machine-checkable enough for invariants.

## Plan vs Progress Divergence
The only unplanned work was the shared reflection wiring itself, and that was a discovered dependency needed to keep the reflect contract deterministic.

## Applicable KB Entries
Mistake M-001 stayed relevant because the runtime, docs, and tests all needed to move together instead of drifting apart.

## Relevant Retros
${relevantRetros}

## Edge Case Coverage
${edgeCaseCoverage}

## Pattern Application Check
${patternApplicationCheck}

## Thrashing & Process Signals
No execute-time thrashing signal fired in this focused fixture, and the guide-backed reflection stayed bounded enough not to create fresh churn.

## Proof Weight Audit
The structured reflection answer count gives VALIDATE a deterministic readiness signal instead of relying on prose-only confidence claims.

## Next Time Candidates
A reusable next-time candidate is to keep the guide generator, reflection validator, and semantic checks in the same commit whenever the schema expands again.

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
READY — The focused proof bundle is sufficient for this reflection invariant fixture.

## Next Move
${nextMove}
`;
}

function writeReflection(planDir, options = {}) {
  writeFileSync(join(planDir, "reflection.md"), buildReflectionDocument(planDir, options));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scenarioI044AnsweredCountInvariant() {
  const tmp = makeTemp("i044");
  try {
    const planDir = seedProject(tmp, "reflection invariant answered-count fixture");
    prepareReflectFixture(planDir);
    writeReflectionGuide(planDir);
    writeReflection(planDir, {
      answeredCount: "0/1",
      edgeCaseCoverage: "",
    });
    const invariants = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    assert(invariants.ok && invariants.status === 0, "rule_engine check-invariants keeps unanswered reflection questions advisory");
    const parsed = parseJson(invariants.stdout);
    assert(!!parsed, "reflection invariant I-044 fixture emits valid JSON");
    assert(Array.isArray(parsed?.warnings), "I-044 payload includes warnings array");
    assert((parsed?.warnings || []).length > 0, "I-044 payload records advisory evidence");
    const warningNames = new Set((parsed?.warnings || []).map((entry) => entry?.name));
    assert(warningNames.has("reflection_required_questions_unanswered"), "check-invariants surfaces advisory I-044 for unanswered reflection questions");
    assert((parsed?.warnings || []).some((entry) => entry?.name === "reflection_required_questions_unanswered"), "I-044 warning names required-question evidence");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioI045KnownLimitationInvariant() {
  const tmp = makeTemp("i045");
  try {
    const planDir = seedProject(tmp, "reflection invariant known-limitation fixture");
    prepareReflectFixture(planDir);
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
    writeReflectionGuide(planDir);
    writeReflection(planDir, {
      edgeCaseCoverage: "accept_as_known_limitation — The fixture can ship without the extra edge-case test for now, but it needs follow-up story US-999 before close.",
    });
    const invariants = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    assert(!invariants.ok && invariants.status === 1, "rule_engine check-invariants fails when a known limitation lacks a filed follow-up story");
    const parsed = parseJson(invariants.stdout);
    assert(!!parsed, "reflection invariant I-045 fixture emits valid JSON");
    assert(Array.isArray(parsed?.violations), "I-045 payload includes violations array");
    assert(parsed?.status === "FAIL", "I-045 payload reports FAIL status");
    const violationNames = new Set((parsed?.violations || []).map((entry) => entry?.name));
    assert(violationNames.has("reflection_known_limitation_missing_followup"), "check-invariants surfaces I-045 for known limitations without follow-up stories");
    assert((parsed?.violations || []).some((entry) => entry?.name === "reflection_known_limitation_missing_followup"), "I-045 payload names known-limitation evidence");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioI046PivotInvariant() {
  const tmp = makeTemp("i046");
  try {
    const planDir = seedProject(tmp, "reflection invariant pivot fixture");
    prepareReflectFixture(planDir);
    writeReflectionGuide(planDir);
    writeReflection(planDir, {
      edgeCaseCoverage: "pivot_back_to_execute — The uncovered fixture edge case needs a new regression test before the proof surface is trustworthy enough to continue.",
      nextMove: "EXECUTE — Add the missing regression coverage before returning to REFLECT.",
    });
    const semantic = runNode([
      "--input-type=module",
      "-e",
      `import { runSemanticChecks } from ${JSON.stringify(pathToFileURL(ruleEngineScript).href)};
const results = runSemanticChecks("reflect-to-validate", ${JSON.stringify(planDir)});
console.log(JSON.stringify(results));`,
    ], tmp);
    assert(semantic.ok, "runSemanticChecks executes for the reflection pivot fixture");
    const results = parseJson(semantic.stdout) || [];
    assert(Array.isArray(results), "I-046 semantic result is an array");
    assert(results.some((entry) => entry?.status === "FAIL"), "I-046 semantic result contains a FAIL entry");
    assert(
      results.some((entry) => String(entry?.detail || "").includes("reflection_pivot_not_reverted")),
      "runSemanticChecks surfaces I-046 when a pivot decision still targets VALIDATE"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioI047RequiredRetroInvariant() {
  const tmp = makeTemp("i047");
  try {
    const planDir = seedProject(tmp, "reflection invariant required-retro fixture");
    prepareReflectFixture(planDir);
    writeReflectionGuide(planDir, { includeRequiredRetro: true });
    writeReflection(planDir, {
      answeredCount: "2/2",
      relevantRetros: "The reflection acknowledges earlier planner drift in general terms, but it intentionally avoids naming the required retro directly.",
    });
    const invariants = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    assert(invariants.ok && invariants.status === 0, "rule_engine check-invariants keeps missing retro linkage advisory");
    const parsed = parseJson(invariants.stdout);
    assert(!!parsed, "reflection invariant I-047 fixture emits valid JSON");
    assert(parsed?.status === "PASS", "I-047 payload reports PASS with advisory linkage");
    const warningNames = new Set((parsed?.warnings || []).map((entry) => entry?.name));
    assert(warningNames.has("reflection_required_retro_unaddressed"), "check-invariants surfaces advisory I-047 for required retros not addressed explicitly");
    assert((parsed?.warnings || []).some((entry) => String(entry?.detail || "").includes("R-2026-04-20-001")), "I-047 advisory detail names the missing required retro id");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAnswerModeQuestionsRejectKeywordFill() {
  const tmp = makeTemp("keyword-fill");
  try {
    const planDir = seedProject(tmp, "reflection keyword-fill fixture");
    prepareReflectFixture(planDir);
    writeReflectionGuide(planDir);
    writeReflection(planDir, {
      edgeCaseCoverage: "This is addressed and handled appropriately here today.",
    });
    const invariants = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    assert(invariants.ok && invariants.status === 0, "answer-mode keyword-fill prose remains advisory");
    const parsed = parseJson(invariants.stdout);
    const warningNames = new Set((parsed?.warnings || []).map((entry) => entry?.name));
    assert(warningNames.has("reflection_required_questions_unanswered"), "keyword-fill answer surfaces as an advisory unanswered reflection question");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioDecisionEvasionStillRequiresFollowupStory() {
  const tmp = makeTemp("decision-evasion");
  try {
    const planDir = seedProject(tmp, "reflection decision-evasion fixture");
    prepareReflectFixture(planDir);
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
    writeReflectionGuide(planDir);
    writeReflection(planDir, {
      edgeCaseCoverage: "We are choosing not to resolve this within the current iteration, and US-999 should follow later.",
    });
    const invariants = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    assert(!invariants.ok && invariants.status === 1, "known-limitation decision evasion still fails without a filed follow-up story");
    const parsed = parseJson(invariants.stdout);
    const violationNames = new Set((parsed?.violations || []).map((entry) => entry?.name));
    assert(violationNames.has("reflection_known_limitation_missing_followup"), "decision-evasion answer surfaces I-045 instead of silently passing");
    assert((parsed?.violations || []).some((entry) => String(entry?.detail || "").includes("US-999")), "decision-evasion I-045 names the missing follow-up story");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioHistoricalReturnToExecuteDoesNotCreateLivePivot() {
  const tmp = makeTemp("historical-pivot");
  try {
    const planDir = seedProject(tmp, "reflection historical pivot fixture");
    prepareReflectFixture(planDir);
    writeReflectionGuide(planDir);
    writeReflection(planDir, {
      edgeCaseCoverage: "out_of_scope — We were returning to execute to fix the missing case earlier, and that work is now done.",
    });
    const semantic = runNode([
      "--input-type=module",
      "-e",
      `import { runSemanticChecks } from ${JSON.stringify(pathToFileURL(ruleEngineScript).href)};
const results = runSemanticChecks("reflect-to-validate", ${JSON.stringify(planDir)});
console.log(JSON.stringify(results));`,
    ], tmp);
    assert(semantic.ok, "runSemanticChecks executes for historical pivot narration fixture");
    const results = parseJson(semantic.stdout) || [];
    assert(
      !results.some((entry) => String(entry?.detail || "").includes("reflection_pivot_not_reverted")),
      "historical return-to-execute narration is not treated as a live pivot"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTerseVerdictAcceptedForNoModeQuestion() {
  const tmp = makeTemp("terse-verdict");
  try {
    const planDir = seedProject(tmp, "reflection terse verdict fixture");
    prepareReflectFixture(planDir);
    writeReflectionGuide(planDir, { noModeQuestion: true });
    writeReflection(planDir, {
      patternApplicationCheck: "Pass",
    });
    const invariants = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    const parsed = parseJson(invariants.stdout);
    assert(invariants.ok && parsed?.status === "PASS", "terse verdict is accepted for a single required question without answer modes");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Deferral classification must distinguish deferring RESOLUTION (a known
// limitation → I-045 follow-up gate) from "defer to <authority/default>"
// (yielding upstream, NOT a deferral of work). The earlier `defer ... (to|until|
// for)` pattern false-tagged the latter, producing a narrow I-045 false-red.
function scenarioDeferToAuthorityIsNotAKnownLimitation() {
  const knownLimitations = [
    "deferred for now",
    "defer this until the next release",
    "defer fixing to a later iteration",
    "we are deferring resolution to v2",
    "defer the fix until later",
  ];
  for (const answer of knownLimitations) {
    assert(
      normalizeReflectionDecisionAnswer(answer) === "accept_as_known_limitation",
      `deferring resolution is a known limitation: "${answer}"`
    );
  }
  const notLimitations = [
    "defer to upstream defaults",
    "we defer to the team for the final call",
    "defer to the maintainer",
    "defer to existing conventions",
    "the calculation defers to the library default rounding",
  ];
  for (const answer of notLimitations) {
    assert(
      normalizeReflectionDecisionAnswer(answer) !== "accept_as_known_limitation",
      `deferring to an authority/default is NOT a known limitation (no false-red): "${answer}"`
    );
  }
}

console.log("\nReflection Invariants Test\n");

scenarioDeferToAuthorityIsNotAKnownLimitation();
scenarioI044AnsweredCountInvariant();
scenarioI045KnownLimitationInvariant();
scenarioI046PivotInvariant();
scenarioI047RequiredRetroInvariant();
scenarioAnswerModeQuestionsRejectKeywordFill();
scenarioDecisionEvasionStillRequiresFollowupStory();
scenarioHistoricalReturnToExecuteDoesNotCreateLivePivot();
scenarioTerseVerdictAcceptedForNoModeQuestion();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
