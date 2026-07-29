#!/usr/bin/env node
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { evaluateNovelInsightFloor } from "../scripts/lib/novel_insight_floor.mjs";
import { createSemanticEngine } from "../scripts/lib/semantic_engine.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const skillDir = resolve(__dirname, "..");
const fixturesDir = join(__dirname, "ive/fixtures/adversarial/idea_barrenness");
const transitionScript = join(repoRoot, ".agent/skills/iterative-planner/scripts/verify_gate.mjs");
const ruleEngineScript = join(repoRoot, ".agent/skills/iterative-planner/scripts/rule_engine.mjs");

let passed = 0;
let failed = 0;

function assert(condition, message, detail = "") {
  if (!condition) {
    failed += 1;
    console.error(`not ok - ${message}`);
    if (detail) console.error(detail);
    return;
  }
  passed += 1;
  console.log(`ok - ${message}`);
}

function loadFixture(name) {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8"));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function execNode(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd,
      encoding: "utf8",
      env: plannerSubprocessEnv({
        PLANNER_SUPERVISOR_MODE: "mock",
        CLAUDE_CODE_ENTRYPOINT: "unit-test",
        PLANNER_DISABLE_AUTO_ADVISOR: "1"
      })
    });
    return { ok: true, status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? error.message
    };
  }
}

function reflectCycles(count, overrides = {}) {
  return [
    {
      gate: "explore-to-plan",
      from: "EXPLORE",
      to: "PLAN",
      gate_result: "PASS",
      timestamp: "2026-06-18T00:00:00.000Z"
    },
    {
      gate: "plan-to-execute",
      from: "PLAN",
      to: "EXECUTE",
      gate_result: "PASS",
      timestamp: "2026-06-18T00:00:01.000Z"
    },
    ...Array.from({ length: count }, (_, index) => ({
      gate: "execute-to-reflect",
      from: "EXECUTE",
      to: "REFLECT",
      gate_result: "PASS",
      timestamp: `2026-06-18T00:00:${String(index + 2).padStart(2, "0")}.000Z`,
      ...overrides,
    }))
  ];
}

function reflectionMarkdown({ lesson = false, lessonText = null } = {}) {
  const effectiveLessonText = lessonText ?? (
    lesson
      ? "A shared evaluator must feed both JS gate checks and Prolog facts so ADV-LLM-005 cannot drift between layers."
      : null
  );
  const lessonBlock = effectiveLessonText
    ? lessonText
      ? `- ${effectiveLessonText}
`
      : `### What changed in my understanding
- ${effectiveLessonText}
`
    : "No new learnings.\n";
  return `# Reflection

## Solution Verdict
PASS - The fixture reached REFLECT.

## Semantic Verdict
PASS - The fixture is semantically stable enough for the novel-insight floor check.

## Evidence-Readiness Verdict
PASS - Evidence exists for the reflection gate fixture.

## Lessons Learned
${lessonBlock}
## Next Move
PASS - Continue to VALIDATE if semantic gates pass.

## Knowledge Base Sign-Off
- Decision: no_new_learnings
- Reason: fixture-only plan with no durable project learning.
`;
}

function operatorLedger({ risk = false } = {}) {
  return {
    version: 1,
    entries: risk
      ? [
          {
            type: "premortem_risk",
            origin: "self_generated",
            text: "The reflection might report progress without adding a reusable decision, lesson, or risk signal."
          }
        ]
      : []
  };
}

function seedProject(fixtureName, overrides = {}) {
  const fixture = { ...loadFixture(fixtureName), ...overrides };
  const tmpRoot = mkdtempSync(join(tmpdir(), `ive-idea-barrenness-${fixtureName}-`));
  const planName = `plan_${fixtureName}_${Date.now()}`;
  const planDir = join(tmpRoot, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  mkdirSync(join(tmpRoot, "reports/user_story_audit"), { recursive: true });

  const agentTarget = join(tmpRoot, ".agent");
  if (!existsSync(agentTarget)) {
    symlinkSync(join(repoRoot, ".agent"), agentTarget, "dir");
  }

  writeJson(join(tmpRoot, "audit.config.json"), {
    story_registry: "reports/user_story_audit/story_registry.json"
  });
  writeJson(join(tmpRoot, "reports/user_story_audit/story_registry.json"), {
    version: 1,
    stories: [
      {
        id: "US-PM-AUTO-128",
        title: "Novel insight floor fixture",
        status: "NOT_IMPLEMENTED",
        code_refs: [],
        test_refs: [],
        validation_refs: [],
        doc_refs: []
      }
    ]
  });
  writeFileSync(join(tmpRoot, "plans/.current_plan"), `${planName}\n`);

  writeJson(join(planDir, "state.json"), {
    version: 1,
    state: "REFLECT",
    goal: fixture.goal ?? "Exercise the ADV-LLM-005 novel-insight floor.",
    workflow: "/safe-change-power",
    plan_shape: fixture.plan_shape ?? { primary: "feature", signals: ["feature"], confidence: 0.9 },
    iteration: fixture.iteration ?? 0,
    transitions: fixture.transitions ?? reflectCycles(fixture.reflect_cycles ?? 0),
    close_signals: {
      progress: { satisfied: true, open_items: 0 },
      kb: { satisfied: true, status: "no_new_learnings" },
      semantic_substrate: { required: false, satisfied: true, status: "not_required" }
    }
  });

  writeFileSync(
    join(planDir, "plan.md"),
    `# Plan

## Verification Matrix
- Exercise the novel-insight floor fixture.
`
  );
  writeFileSync(join(planDir, "progress.md"), "# Progress\n\n- [x] Fixture reached REFLECT.\n");
  writeFileSync(join(planDir, "summary.md"), "# Summary\n\nFixture summary.\n");
  writeFileSync(join(planDir, "reflection.md"), fixture.reflection ?? reflectionMarkdown({ lesson: fixture.lesson, lessonText: fixture.lessonText }));
  writeFileSync(join(planDir, "decisions.md"), fixture.decisions ?? "# Decisions\n");
  writeJson(join(planDir, "operator_ledger.json"), operatorLedger({ risk: fixture.risk }));

  return { fixture, tmpRoot, planDir, planName };
}

function cleanup(project) {
  if (project?.tmpRoot) {
    rmSync(project.tmpRoot, { recursive: true, force: true });
  }
}

function runGate(project) {
  return execNode([transitionScript, "reflect-to-validate", "--plan", basename(project.planDir)], project.tmpRoot);
}

function runInvariants(project) {
  return execNode([ruleEngineScript, "check-invariants", "--json"], project.tmpRoot);
}

function queryNovelInsightWarnings(project) {
  const { session } = createSemanticEngine({ cwd: project.tmpRoot, skillPath: skillDir, refreshOntology: true });
  return session.queryAll("invariant_warning(novel_insight_floor_at_risk, Detail)") || [];
}

function includesAny(text, fragments) {
  return fragments.some((fragment) => text.includes(fragment));
}

function scenarioBarrenFails() {
  const project = seedProject("barren");
  try {
    const direct = evaluateNovelInsightFloor({ planDir: project.planDir, cwd: project.tmpRoot });
    assert(direct.status === "fail", "three barren reflections fail I-050 directly");
    assert(direct.insightCount === 0, "barren fixture has zero counted insights");

    const gate = runGate(project);
    assert(!gate.ok, "dual-engine reflect-to-validate preflight blocks a barren third reflection rejected by Prolog");
    assert(includesAny(`${gate.stdout}\n${gate.stderr}`, ["GATE-REF-020", "Novel insight floor"]), "JS gate advisory names GATE-REF-020");
    assert(/novel_insight_floor_not_met|Novel insight floor/i.test(gate.stdout), "authoritative preflight surfaces the Prolog denial without requiring a mirror-only divergence row", gate.stdout);

    const invariants = runInvariants(project);
    assert(!invariants.ok, "Prolog invariants reject a barren third reflection");
    assert(invariants.stdout.includes("novel_insight_floor_not_met"), "Prolog reports novel_insight_floor_not_met");
  } finally {
    cleanup(project);
  }
}

function scenarioWarnsAtTwo() {
  const project = seedProject("barren", { reflect_cycles: 2 });
  try {
    const direct = evaluateNovelInsightFloor({ planDir: project.planDir, cwd: project.tmpRoot });
    assert(direct.status === "warn", "second barren reflection is warning-only");

    const gate = runGate(project);
    assert(gate.ok, "reflect-to-validate permits warning-only barren reflection", `${gate.stdout}\n${gate.stderr}`);
    assert(gate.stdout.includes("WARN") && gate.stdout.includes("Novel insight floor"), "warning-only gate surfaces actionable warning");

    const invariants = runInvariants(project);
    assert(invariants.ok, "Prolog warning does not fail the invariant command", `${invariants.stdout}\n${invariants.stderr}`);
    assert(queryNovelInsightWarnings(project).length > 0, "Prolog reports novel_insight_floor_at_risk warning");
  } finally {
    cleanup(project);
  }
}

function scenarioNonBarrenPasses() {
  const decisionProject = seedProject("non_barren");
  const lessonProject = seedProject("barren", { lesson: true });
  const riskProject = seedProject("barren", { risk: true });
  try {
    const decision = evaluateNovelInsightFloor({ planDir: decisionProject.planDir, cwd: decisionProject.tmpRoot });
    const lesson = evaluateNovelInsightFloor({ planDir: lessonProject.planDir, cwd: lessonProject.tmpRoot });
    const risk = evaluateNovelInsightFloor({ planDir: riskProject.planDir, cwd: riskProject.tmpRoot });

    assert(decision.status === "pass" && decision.decisionCount > 0, "D-### decision satisfies I-050");
    assert(lesson.status === "pass" && lesson.lessonCount > 0, "substantive lesson satisfies I-050");
    assert(risk.status === "pass" && risk.riskCount > 0, "self-generated premortem risk satisfies I-050");

    const gate = runGate(decisionProject);
    assert(gate.ok, "reflect-to-validate accepts non-barren reflection", `${gate.stdout}\n${gate.stderr}`);
    const invariants = runInvariants(decisionProject);
    assert(invariants.ok, "Prolog invariants accept non-barren reflection", `${invariants.stdout}\n${invariants.stderr}`);
  } finally {
    cleanup(decisionProject);
    cleanup(lessonProject);
    cleanup(riskProject);
  }
}

function scenarioMissingTransitionStatusIsUnknown() {
  const project = seedProject("barren", {
    transitions: reflectCycles(3, { gate_result: undefined }),
  });
  const negatedProject = seedProject("barren", {
    transitions: reflectCycles(3, { gate_result: "not pass" }),
  });
  try {
    const direct = evaluateNovelInsightFloor({ planDir: project.planDir, cwd: project.tmpRoot });
    assert(direct.windowCount === 0, "missing execute-to-reflect status does not count as a completed reflection window");
    assert(direct.status === "pass", "missing transition status is unknown rather than a barren-reflection failure");

    const negated = evaluateNovelInsightFloor({ planDir: negatedProject.planDir, cwd: negatedProject.tmpRoot });
    assert(negated.windowCount === 0, "negated execute-to-reflect status does not count as a completed reflection window");
    assert(negated.status === "pass", "negated transition status is unknown rather than a fabricated pass");
  } finally {
    cleanup(project);
    cleanup(negatedProject);
  }
}

function scenarioMissingRequiredArtifactsFail() {
  const project = seedProject("barren", {
    reflect_cycles: 0,
    transitions: reflectCycles(0),
  });
  try {
    rmSync(join(project.planDir, "reflection.md"), { force: true });
    rmSync(join(project.planDir, "decisions.md"), { force: true });

    const direct = evaluateNovelInsightFloor({ planDir: project.planDir, cwd: project.tmpRoot });
    assert(direct.status === "fail", "missing required ideation artifacts fail I-050 directly");
    assert(direct.detail.includes("Required ideation artifacts are missing"), "missing required ideation artifacts explain the failure");

    const gate = runGate(project);
    assert(!gate.ok, "reflect-to-validate rejects missing required ideation artifacts");
  } finally {
    cleanup(project);
  }
}

function scenarioUnreadableRequiredArtifactFails() {
  const project = seedProject("barren", {
    reflect_cycles: 0,
    transitions: reflectCycles(0),
  });
  const decisionsPath = join(project.planDir, "decisions.md");
  try {
    chmodSync(decisionsPath, 0o000);

    const direct = evaluateNovelInsightFloor({ planDir: project.planDir, cwd: project.tmpRoot });
    assert(direct.status === "fail", "unreadable required ideation artifact fails I-050 directly", JSON.stringify(direct, null, 2));
    assert(direct.code === "artifact_read_error", "unreadable required ideation artifact reports artifact_read_error");
    assert(
      direct.artifactReadErrors?.some((entry) => entry.artifact === "decisions.md"),
      "unreadable decisions.md is named in artifact read errors",
      JSON.stringify(direct.artifactReadErrors || [], null, 2)
    );

    const gate = runGate(project);
    assert(!gate.ok, "dual-engine reflect-to-validate preflight blocks an unreadable ideation artifact rejected by Prolog");
    assert(includesAny(`${gate.stdout}\n${gate.stderr}`, ["artifact read error", "artifact_read_error"]), "gate advisory explains artifact read error");
    assert(/novel_insight_floor_artifact_read_error|artifact read error/i.test(gate.stdout), "artifact preflight surfaces the Prolog denial without requiring a mirror-only divergence row", gate.stdout);

    const invariants = runInvariants(project);
    assert(!invariants.ok, "Prolog invariants reject unreadable required ideation artifact");
    assert(invariants.stdout.includes("novel_insight_floor_artifact_read_error"), "Prolog reports novel_insight_floor_artifact_read_error");
  } finally {
    try {
      chmodSync(decisionsPath, 0o600);
    } catch {
      // Best effort: cleanup below can still remove the temporary directory on most filesystems.
    }
    cleanup(project);
  }
}

function scenarioNegatedTextualRiskRejected() {
  const project = seedProject("barren", {
    reflect_cycles: 3,
    reflection: `# Reflection

## Solution Verdict
PASS: The work made no novel decision or lesson.

## Evidence Notes
This is not a self-generated pre-mortem risk; it is a sentence denying that risk evidence exists.

## Knowledge Base Sign-Off
- Decision: no_new_learnings
- Reason: fixture-only plan with no durable project learning.
`,
  });
  try {
    const direct = evaluateNovelInsightFloor({ planDir: project.planDir, cwd: project.tmpRoot });
    assert(direct.riskCount === 0, "negated textual risk does not increment risk evidence");
    assert(direct.status === "fail", "negated textual risk does not satisfy I-050 after repeated barren reflection");

    const gate = runGate(project);
    assert(!gate.ok, "reflect-to-validate rejects repeated barren reflection with only negated risk text");
  } finally {
    cleanup(project);
  }
}

function scenarioNegatedWaiverAndAcknowledgmentRejected() {
  const negatedWaiverProject = seedProject("barren", {
    reflection: `# Reflection

## Solution Verdict
PASS - The fixture reached REFLECT.

## Semantic Verdict
PASS - The fixture is semantically stable enough for the novel-insight floor check.

## Evidence-Readiness Verdict
PASS - Evidence exists for the reflection gate fixture.

## Lessons Learned
No new learnings.

## D-001 - No execution-only waiver
We do NOT waive the novel_insight_floor for this execution-only fixture.

## Next Move
PASS - Continue to VALIDATE if semantic gates pass.

## Knowledge Base Sign-Off
- Decision: no_new_learnings
- Reason: fixture-only plan with no durable project learning.
`
  });
  const negatedAcknowledgmentProject = seedProject("non_barren", {
    reflection: `# Reflection

## Solution Verdict
WARN - There is a known residual risk.

## Semantic Verdict
PASS - The fixture is semantically stable.

## Evidence-Readiness Verdict
PASS - Evidence exists for this fixture.

## Lessons Learned
- Shared status parsing needs explicit negation tests.

## Warnings
Warnings are NOT acknowledged.

## Next Move
PASS - Continue to VALIDATE if semantic gates pass.

## Knowledge Base Sign-Off
- Decision: no_new_learnings
- Reason: fixture-only plan with no durable project learning.
`
  });
  try {
    const negatedWaiver = evaluateNovelInsightFloor({ planDir: negatedWaiverProject.planDir, cwd: negatedWaiverProject.tmpRoot });
    assert(negatedWaiver.status === "fail", "negated execution-only waiver does not satisfy I-050");
    assert(!negatedWaiver.waived, "negated execution-only waiver is not marked waived");

    const gate = runGate(negatedAcknowledgmentProject);
    assert(!gate.ok, "reflect-to-validate rejects negated warning acknowledgment");
    assert(includesAny(`${gate.stdout}\n${gate.stderr}`, ["acknowledge", "WARN"]), "negated warning acknowledgment failure explains warning handling");
  } finally {
    cleanup(negatedWaiverProject);
    cleanup(negatedAcknowledgmentProject);
  }
}

function scenarioShortLessonBoundary() {
  const shortValidProject = seedProject("barren", {
    lessonText: "Gate status unknowns need proof.",
  });
  const tooShortProject = seedProject("barren", {
    lessonText: "Still learning.",
  });
  try {
    const shortValid = evaluateNovelInsightFloor({ planDir: shortValidProject.planDir, cwd: shortValidProject.tmpRoot });
    assert(shortValid.status === "pass", "short valid lesson satisfies I-050");
    assert(shortValid.lessonCount === 1, "short valid lesson is counted");

    const shortValidGate = runGate(shortValidProject);
    assert(shortValidGate.ok, "reflect-to-validate accepts short valid lesson", `${shortValidGate.stdout}\n${shortValidGate.stderr}`);

    const tooShort = evaluateNovelInsightFloor({ planDir: tooShortProject.planDir, cwd: tooShortProject.tmpRoot });
    assert(tooShort.status === "fail", "too-short placeholder lesson still fails I-050");
    assert(tooShort.lessonCount === 0, "too-short placeholder lesson is not counted");
  } finally {
    cleanup(shortValidProject);
    cleanup(tooShortProject);
  }
}

function scenarioWaiverAndNotRequiredPass() {
  const waiverProject = seedProject("barren", {
    decisions:
      "# Decisions\n\n## D-001 - Execution-only waiver for novel_insight_floor\n\nThis routine execution has no new insight; waiver recorded intentionally.\n"
  });
  const choreProject = seedProject("barren", {
    plan_shape: { primary: "chore", signals: ["chore"], confidence: 0.9 }
  });
  try {
    const waiver = evaluateNovelInsightFloor({ planDir: waiverProject.planDir, cwd: waiverProject.tmpRoot });
    const chore = evaluateNovelInsightFloor({ planDir: choreProject.planDir, cwd: choreProject.tmpRoot });

    assert(waiver.status === "waived", "explicit execution-only waiver satisfies I-050");
    assert(chore.status === "not_required", "chore-shaped plans are outside I-050");
    const waiverGate = runGate(waiverProject);
    assert(waiverGate.ok, "reflect-to-validate accepts explicit I-050 waiver", `${waiverGate.stdout}\n${waiverGate.stderr}`);
  } finally {
    cleanup(waiverProject);
    cleanup(choreProject);
  }
}

scenarioBarrenFails();
scenarioWarnsAtTwo();
scenarioNonBarrenPasses();
scenarioMissingTransitionStatusIsUnknown();
scenarioMissingRequiredArtifactsFail();
scenarioUnreadableRequiredArtifactFails();
scenarioNegatedTextualRiskRejected();
scenarioNegatedWaiverAndAcknowledgmentRejected();
scenarioShortLessonBoundary();
scenarioWaiverAndNotRequiredPass();

console.log(`\n${passed} assertions passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
