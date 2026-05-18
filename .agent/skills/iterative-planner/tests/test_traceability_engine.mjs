#!/usr/bin/env node
// test_traceability_engine.mjs — Focused coverage for the annotation-connected
// traceability commands and planner visualizer traceability payloads.

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const ruleEngineScript = resolve(testDir, "..", "scripts", "rule_engine.mjs");
const visualizerScript = resolve(repoRoot, "tools", "planner-visualizer", "generate.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function extractJson(output) {
  const text = String(output || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runNode(script, args, cwd, env = {}) {
  try {
    const stdout = execFileSync(NODE, [script, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env,
        CODEX_THREAD_ID: "",
        _PLANNER_PLAN_TARGET: "",
      },
    });
    return {
      ok: true,
      status: 0,
      stdout,
      stderr: "",
      parsed: extractJson(stdout),
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
      parsed: extractJson(error.stdout || ""),
    };
  }
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-traceability-${name}-`));
}

function createTraceabilityFixture() {
  const tmp = makeTemp("commands");
  const planName = "plan_traceability_fixture";
  const planDir = join(tmp, "plans", planName);

  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeStateJson(planDir, createInitialStateJson(planName, "Traceability fixture", { projectRoot: tmp }));
  writeText(join(planDir, "plan.md"), `# Plan

## Goal
Traceability fixture

## Success Criteria
1. Direct annotation criterion
2. Registry-only criterion

## Verification Strategy
| Criterion | Evidence | Stories |
| --- | --- | --- |
| Direct annotation criterion | validation chain | US-100 |
| Registry-only criterion | registry validation | US-200 |

## Files To Modify
- src/annotated.js
- src/registry_only.js
- src/missing_story.js
- src/missing_criterion.js
- validation/story_validation.py
- validation/story_link_only.py
- validation/orphan_validation.py
`);
  writeText(join(planDir, "verification.md"), `# Verification

| Criterion | Subject | Evidence | Result |
| --- | --- | --- | --- |
| Direct annotation criterion | US-100 | tests/direct.validation.py | PASS |
| Registry-only criterion | US-200 | tests/registry.validation.py | PASS |
`);

  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    updated: "2026-04-10T00:00:00.000Z",
    stories: [
      {
        id: "US-100",
        title: "Annotation-backed story",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: ["src/annotated.js"],
        test_refs: ["tests/direct.validation.py"],
        validation_refs: ["tests/direct.validation.py"],
      },
      {
        id: "US-200",
        title: "Registry-only proof story",
        priority: "MEDIUM",
        status: "FULLY_COVERED",
        code_refs: ["src/registry_only.js"],
        validation_refs: ["tests/registry.validation.py"],
      },
    ],
  });

  writeText(join(tmp, "src", "annotated.js"), `// @planner:story = US-100
// @planner:proves = crit:sc_1
// fixture source
`);
  writeText(join(tmp, "src", "registry_only.js"), `// registry-only source\n`);
  writeText(join(tmp, "src", "missing_story.js"), `// @planner:story = US-999
// missing story annotation source
`);
  writeText(join(tmp, "src", "missing_criterion.js"), `// @planner:proves = crit:ghost_criterion
// missing criterion annotation source
`);
  writeText(join(tmp, "tests", "direct.validation.py"), `# validation fixture\n`);
  writeText(join(tmp, "tests", "registry.validation.py"), `# registry validation fixture\n`);
  writeText(join(tmp, "validation", "story_validation.py"), `# @planner:validation_module
# @planner:story = US-100
# validation module fixture
`);
  writeText(join(tmp, "validation", "story_link_only.py"), `# @planner:story = US-100
# story link only fixture
`);
  writeText(join(tmp, "validation", "orphan_validation.py"), `# @planner:validation_module
# orphan validation fixture
`);

  return tmp;
}

function createVisualizerFixture() {
  const tmp = makeTemp("visualizer");

  mkdirSync(join(tmp, "plans"), { recursive: true });
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  symlinkSync(join(repoRoot, ".agent"), join(tmp, ".agent"), "dir");

  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    updated: "2026-04-10T00:00:00.000Z",
    stories: [
      {
        id: "US-VIS-001",
        title: "Visualizer fallback story",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: ["src/visualizer.js"],
        test_refs: ["tests/visualizer.test.js"],
        validation_refs: ["tests/visualizer.test.js"],
      },
      {
        id: "US-VIS-002",
        title: "Second fallback story",
        priority: "MEDIUM",
        status: "PARTIALLY_COVERED",
        code_refs: ["src/secondary.js"],
        validation_refs: ["tests/secondary.validation.js"],
      },
    ],
  });

  writeText(join(tmp, "src", "visualizer.js"), `// visualizer source\n`);
  writeText(join(tmp, "src", "secondary.js"), `// secondary source\n`);
  writeText(join(tmp, "tests", "visualizer.test.js"), `// visualizer test\n`);
  writeText(join(tmp, "tests", "secondary.validation.js"), `// secondary validation\n`);

  return tmp;
}

function scenarioTraceabilityCommands() {
  const tmp = createTraceabilityFixture();
  try {
    const impact = runNode(ruleEngineScript, ["impact-from-file", "src/annotated.js", "--json"], tmp);
    assert(impact.status === 0, "impact-from-file exits 0");
    assert(impact.parsed?.status === "MATCHED", "impact-from-file reports a matched file");
    assert((impact.parsed?.stories || []).some((story) => story.id === "US-100"), "impact-from-file links the annotated story");
    assert((impact.parsed?.criteria || []).some((criterion) => criterion.id === "sc_1"), "impact-from-file links the annotated criterion");
    assert((impact.parsed?.goals || []).some((goal) => goal.id === "primary_goal"), "impact-from-file links the derived goal");

    const proveCriterion = runNode(ruleEngineScript, ["prove-criterion", "sc_2", "--json"], tmp);
    assert(proveCriterion.status === 0, "prove-criterion exits 0 for a proven criterion");
    assert(proveCriterion.parsed?.status === "PROVEN", "prove-criterion marks registry-only evidence as proven");
    assert((proveCriterion.parsed?.proof_files || []).includes("tests/registry.validation.py"), "prove-criterion returns the registry validation ref as proof");

    const storyProof = runNode(ruleEngineScript, ["story-proof", "US-100", "--json"], tmp);
    assert(storyProof.status === 0, "story-proof exits 0 for a proven story");
    assert(storyProof.parsed?.status === "PROVEN", "story-proof marks the annotation-backed story as proven");
    assert((storyProof.parsed?.annotation_files || []).includes("src/annotated.js"), "story-proof exposes annotation-backed files");
    assert((storyProof.parsed?.validation_modules || []).includes("validation/story_validation.py"), "story-proof exposes story validation modules");

    const mismatches = runNode(ruleEngineScript, ["annotation-mismatches", "--json"], tmp);
    assert(mismatches.status === 1, "annotation-mismatches exits 1 when hard mismatches exist");
    assert(mismatches.parsed?.status === "FAIL", "annotation-mismatches reports FAIL when missing references exist");
    assert((mismatches.parsed?.errors || []).some((entry) => entry.type === "missing_story"), "annotation-mismatches catches missing stories");
    assert((mismatches.parsed?.errors || []).some((entry) => entry.type === "missing_criterion"), "annotation-mismatches catches missing criteria");
    assert((mismatches.parsed?.warnings || []).some((entry) => entry.type === "orphan_validation_module"), "annotation-mismatches warns on orphan validation modules");
    assert((mismatches.parsed?.warnings || []).some((entry) => entry.type === "story_file_not_in_registry"), "annotation-mismatches warns on annotation files missing from the registry");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVisualizerFallback() {
  const tmp = createVisualizerFixture();
  try {
    const result = runNode(visualizerScript, [], repoRoot, {
      PLANNER_VISUALIZER_REPO_ROOT: tmp,
    });
    assert(result.status === 0, "visualizer generator exits cleanly for a no-active-plan fixture");

    const dataPath = join(tmp, "reports", "planner-visualizer", "data.json");
    const htmlPath = join(tmp, "reports", "planner-visualizer", "index.html");
    assert(existsSync(dataPath), "visualizer generator writes data.json");
    assert(existsSync(htmlPath), "visualizer generator writes index.html");

    if (!existsSync(dataPath) || !existsSync(htmlPath)) return;

    const data = JSON.parse(readFileSync(dataPath, "utf-8"));
    const html = readFileSync(htmlPath, "utf-8");

    assert(Array.isArray(data.ontology?.storyAtlas) && data.ontology.storyAtlas.length > 0, "visualizer fallback still emits story explorer data");
    assert(Array.isArray(data.ontology?.fileAtlas) && data.ontology.fileAtlas.length > 0, "visualizer emits fileAtlas");
    assert(Array.isArray(data.ontology?.proofAtlas?.stories) && data.ontology.proofAtlas.stories.length > 0, "visualizer emits story proof atlas");
    assert(Array.isArray(data.queries?.presets) && data.queries.presets.length > 0, "visualizer emits query presets");
    assert(String(data.ontology?.provenance?.defaultSubjectId || "").startsWith("story:"), "visualizer chooses a story as the default graph subject");
    assert((data.traceability?.status || "") !== "ERROR", "visualizer reports healthy traceability command infrastructure");
    assert((data.traceability?.commandFailureCount || 0) === 0, "visualizer reports zero traceability command failures");
    assert(!(data.ontology?.fileAtlas || []).some((entry) => entry?.status === "ERROR"), "visualizer fallback fileAtlas contains no infrastructure error cards");
    assert(!(data.ontology?.proofAtlas?.stories || []).some((entry) => entry?.status === "ERROR"), "visualizer fallback story proof atlas contains no infrastructure errors");
    assert(!(data.queries?.presets || []).some((preset) => preset?.result?.status === "ERROR"), "visualizer fallback query presets contain no infrastructure errors");

    assert(html.includes("Human"), "visualizer HTML contains the Human traceability toggle");
    assert(html.includes("Graph"), "visualizer HTML contains the Graph traceability toggle");
    assert(html.includes("Query"), "visualizer HTML contains the Query traceability toggle");
    assert(!html.includes("__STYLES__"), "visualizer HTML resolves the styles placeholder");
    assert(!html.includes("__DATA__"), "visualizer HTML resolves the data placeholder");
    assert(!html.includes("__SCRIPT__"), "visualizer HTML resolves the script placeholder");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nTraceability Engine Tests\n");
scenarioTraceabilityCommands();
scenarioVisualizerFallback();

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);
