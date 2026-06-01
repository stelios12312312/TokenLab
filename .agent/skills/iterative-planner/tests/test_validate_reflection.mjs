#!/usr/bin/env node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

import {
  REFLECTION_GUIDE_SECTION_ORDER,
  REFLECTION_GUIDE_SECTION_TITLES,
  REFLECTION_GUIDE_VERSION,
} from "../scripts/lib/reflection_guide.mjs";
import { validateReflection } from "../scripts/lib/reflection_validation.mjs";

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

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-reflection-${name}-`));
}

function writeReflectionGuideFixture(tmp, planName) {
  const guidePath = join(tmp, "plans", planName, "reflection_guide.yaml");
  mkdirSync(dirname(guidePath), { recursive: true });
  writeFileSync(guidePath, `${JSON.stringify({
    reflection_guide: {
      version: REFLECTION_GUIDE_VERSION,
      plan_id: planName,
      generated_at: "2026-04-26T12:30:00Z",
      section_order: REFLECTION_GUIDE_SECTION_ORDER,
      sections: {
        plan_vs_progress: {
          title: REFLECTION_GUIDE_SECTION_TITLES.plan_vs_progress,
          questions: [
            {
              id: "plan_vs_progress:unplanned_work",
              title: "Classify unplanned work",
              subject_id: "unplanned_work",
              required: true,
              answer_modes: ["intentional_scope_expansion", "discovered_dependency", "scope_creep"],
            },
          ],
        },
        applicable_kb: {
          title: REFLECTION_GUIDE_SECTION_TITLES.applicable_kb,
          questions: [
            {
              id: "applicable_kb:m_001",
              title: "Address M-001",
              subject_id: "M-001",
              required: true,
              answer_modes: [],
            },
          ],
        },
        relevant_retros: {
          title: REFLECTION_GUIDE_SECTION_TITLES.relevant_retros,
          questions: [
            {
              id: "relevant_retros:r_2026_03_24_001",
              title: "Address R-2026-03-24-001",
              subject_id: "R-2026-03-24-001",
              required: true,
              answer_modes: [],
            },
          ],
        },
        edge_case_coverage: {
          title: REFLECTION_GUIDE_SECTION_TITLES.edge_case_coverage,
          questions: [],
        },
        pattern_application_check: {
          title: REFLECTION_GUIDE_SECTION_TITLES.pattern_application_check,
          questions: [],
        },
        process_signals: {
          title: REFLECTION_GUIDE_SECTION_TITLES.process_signals,
          questions: [],
        },
        proof_weight_audit: {
          title: REFLECTION_GUIDE_SECTION_TITLES.proof_weight_audit,
          questions: [],
        },
        next_time_candidates: {
          title: REFLECTION_GUIDE_SECTION_TITLES.next_time_candidates,
          questions: [],
        },
        convention_application_check: {
          title: REFLECTION_GUIDE_SECTION_TITLES.convention_application_check,
          questions: [],
        },
      },
      questions: [],
      required_question_count: 3,
      summary: {},
    },
  }, null, 2)}\n`);
  return guidePath;
}

function buildReflectionDocument(planName, sectionOverrides = {}, frontmatterOverrides = {}) {
  const frontmatter = {
    plan_id: planName,
    generated_from_guide: `plans/${planName}/reflection_guide.yaml`,
    guide_version: String(REFLECTION_GUIDE_VERSION),
    answered_at: "2026-04-26T12:45:00Z",
    required_questions_answered: "3/3",
    ...frontmatterOverrides,
  };

  const sections = {
    "Solution Verdict": "PASS — The validator and scaffold updates close the real planner-core reflection contract gap instead of only documenting it.",
    "Surprises": "The guide-driven sections stayed easy to author, but the old compatibility headings still have to remain truthful until the gate reads the new validator directly.",
    "Plan vs Progress Divergence": "The only unplanned work was README.md, and that was a discovered_dependency because the new validator front door would otherwise be invisible to operators.",
    "Applicable KB Entries": "Mistake M-001 stayed active for this slice, so the CLI, scaffold, docs, and tests were updated together and the full planner smoke suite was rerun to prove the ripple stayed aligned.",
    "Relevant Retros": "R-2026-03-24-001 remained relevant, and the same drift path is now closed because the reflection schema, validator, scaffold, and smoke coverage move together in one slice.",
    "Edge Case Coverage": "No additional uncovered edge case forced a pivot here because the validator fixture exercised missing, vacuous, and valid answer paths directly.",
    "Pattern Application Check": "The new validator follows the same deterministic parser-first pattern as the mini-reflection validator and proves the contract through targeted fixtures plus planner smoke.",
    "Thrashing & Process Signals": "No execute-time thrashing signal fired for this slice, but the section records that the reflect-time contract stayed bounded and did not introduce fresh recovery churn.",
    "Proof Weight Audit": "The reflection validator now gives the later gate a deterministic answered-count surface, which raises confidence instead of relying on prose-only readiness claims.",
    "Next Time Candidates": "A reusable next-time candidate is to update the scaffold, validator, and dispatcher help in the same commit whenever reflection semantics expand again.",
    "Convention Application Check": "No additional convention question fired for this slice, and the new validator path stays consistent with the existing planner dispatcher naming scheme.",
    "Lessons Learned": `### What worked well
Sharing a deterministic parser between the CLI and the future gate wiring keeps the contract honest.

### What failed or took longer
Threading the new schema through both authoring docs and runtime scaffolds touched more surfaces than the validator alone.

### Gotchas discovered
Guide-driven sections need explicit non-vacuous checks or a single heading can hide an unanswered required question.

### Next time
Generate the guide, author the reflection, and validate it locally before trying the reflect-to-validate gate.`,
    "Semantic Verdict": "PASS — The guide, reflection schema, and planner help now describe the same reflect-time contract without introducing semantic drift.",
    "Evidence-Readiness Verdict": "READY — The validator fixtures and planner smoke prove the contract is ready for later gate integration.",
    "Next Move": "VALIDATE — The reflection content is structured, answered, and ready for the next deterministic gate to consume.",
    ...sectionOverrides,
  };

  return `---
plan_id: ${frontmatter.plan_id}
generated_from_guide: ${frontmatter.generated_from_guide}
guide_version: ${frontmatter.guide_version}
answered_at: ${frontmatter.answered_at}
required_questions_answered: ${frontmatter.required_questions_answered}
---

# Reflection

## Solution Verdict
${sections["Solution Verdict"]}

## Surprises
${sections["Surprises"]}

## Plan vs Progress Divergence
${sections["Plan vs Progress Divergence"]}

## Applicable KB Entries
${sections["Applicable KB Entries"]}

## Relevant Retros
${sections["Relevant Retros"]}

## Edge Case Coverage
${sections["Edge Case Coverage"]}

## Pattern Application Check
${sections["Pattern Application Check"]}

## Thrashing & Process Signals
${sections["Thrashing & Process Signals"]}

## Proof Weight Audit
${sections["Proof Weight Audit"]}

## Next Time Candidates
${sections["Next Time Candidates"]}

## Convention Application Check
${sections["Convention Application Check"]}

## Lessons Learned
${sections["Lessons Learned"]}

## Semantic Verdict
${sections["Semantic Verdict"]}

## Evidence-Readiness Verdict
${sections["Evidence-Readiness Verdict"]}

## Next Move
${sections["Next Move"]}
`;
}

function writeReflectionFixture(tmp, content, filename = "reflection.md") {
  const planName = "plan_reflection_validation";
  const relativePath = join("plans", planName, filename);
  const absolutePath = join(tmp, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeReflectionGuideFixture(tmp, planName);
  writeFileSync(absolutePath, content);
  return { planName, relativePath, absolutePath };
}

function scenarioAcceptsValidReflection() {
  const tmp = makeTemp("valid");
  try {
    const planName = "plan_reflection_validation";
    const fixture = writeReflectionFixture(tmp, buildReflectionDocument(planName));
    const result = validateReflection({ cwd: tmp, filePath: fixture.relativePath });
    assert(result.ok, "validateReflection accepts a valid structured reflection");
    assert(result.plan_id === planName, "validateReflection preserves the canonical plan id");
    assert(result.required_question_count === 3, "validateReflection reads the guide required question count");
    assert(result.answered_question_count === 3, "validateReflection counts answered required questions");
    assert(result.template_detected === false, "validateReflection leaves template detection off for authored content");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRejectsMissingRequiredAnswer() {
  const tmp = makeTemp("missing-answer");
  try {
    const planName = "plan_reflection_validation";
    const fixture = writeReflectionFixture(
      tmp,
      buildReflectionDocument(
        planName,
        {
          "Relevant Retros": "",
        },
        {
          required_questions_answered: "3/3",
        },
      ),
    );
    const result = validateReflection({ cwd: tmp, filePath: fixture.relativePath });
    assert(!result.ok, "validateReflection rejects a reflection with a missing required answer");
    assert(
      (result.issues || []).some((issue) => issue.includes("required question R-2026-03-24-001 is missing")),
      "missing required answer reports the specific required retro question",
    );
    assert(
      (result.issues || []).some((issue) => issue.includes("answered count 3 does not match actual answered count 2")),
      "missing required answer reports the frontmatter answered-count mismatch",
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRejectsVacuousRequiredAnswer() {
  const tmp = makeTemp("vacuous-answer");
  try {
    const planName = "plan_reflection_validation";
    const fixture = writeReflectionFixture(
      tmp,
      buildReflectionDocument(planName, {
        "Applicable KB Entries": "N/A",
      }),
    );
    const result = validateReflection({ cwd: tmp, filePath: fixture.relativePath });
    assert(!result.ok, "validateReflection rejects a vacuous required answer");
    assert(
      (result.issues || []).some((issue) => issue.includes("required question M-001 is vacuous")),
      "vacuous required answer reports the specific KB question",
    );
    assert(
      (result.issues || []).some((issue) => issue.includes("section Applicable KB Entries is vacuous")),
      "vacuous required answer also reports the section-level schema failure",
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nReflection Validator\n");

scenarioAcceptsValidReflection();
scenarioRejectsMissingRequiredAnswer();
scenarioRejectsVacuousRequiredAnswer();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
