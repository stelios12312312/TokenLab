#!/usr/bin/env node

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { induceConventionCandidates } from "../scripts/convention_inducer.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptPath = resolve(testDir, "..", "scripts", "convention_inducer.mjs");
const nodeBin = process.execPath;

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
  return mkdtempSync(join(tmpdir(), `planner-convention-inducer-${name}-`));
}

function writeText(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function runCli(args, cwd) {
  try {
    const stdout = execFileSync(nodeBin, [scriptPath, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function seedFrontendPages(tmp) {
  for (let index = 0; index < 10; index += 1) {
    writeText(
      join(tmp, "src", "pages", `page_${index}.tsx`),
      `import MainLayout from "../layout/MainLayout";\nimport { Menu } from "../components/Menu";\n\nexport function Page${index}() {\n  return <MainLayout><Menu /></MainLayout>;\n}\n`
    );
  }
}

function seedBackendRoutes(tmp) {
  for (let index = 0; index < 10; index += 1) {
    writeText(
      join(tmp, "src", "api", "v1", `route_${index}.ts`),
      `import { requireAuth } from "../auth";\n\nexport function route${index}(app) {\n  app.get("/route-${index}", requireAuth, () => "ok");\n}\n`
    );
  }
}

function seedQuantStrategies(tmp) {
  for (let index = 0; index < 10; index += 1) {
    writeText(
      join(tmp, "src", "strategies", `strategy_${index}.py`),
      `class Strategy${index}Strategy(BaseStrategy):\n    risk_limits = {"daily": 1}\n`
    );
  }
}

function seedExistingConvention(tmp) {
  writeJson(join(tmp, ".agent", "ontology", "facts", "conventions.yaml"), {
    conventions: {
      version: 1,
      conventions: [
        {
          id: "CONV-900",
          title: "Pages import MainLayout",
          status: "active",
          domain: "frontend",
          scope: "pages",
          confidence: 1,
          applies_to: {
            file_patterns: ["src/pages/**/*.tsx"],
            change_classes: ["new_page", "page_modification"],
          },
          requires: [
            { import_contains: "MainLayout" },
          ],
          evidence_type: "static_analysis",
          detected_from: "manual",
        },
      ],
    },
  });
}

function scenarioDetectorsProduceStructuredCandidatesAndReport() {
  const tmp = makeTemp("all");
  try {
    seedFrontendPages(tmp);
    seedBackendRoutes(tmp);
    seedQuantStrategies(tmp);

    const result = induceConventionCandidates({ cwd: tmp });
    assert(result.ok, "convention induction succeeds for fixture codebases");
    assert(result.candidate_count >= 4, "convention induction produces candidates across the three detector families");
    assert(result.candidates.some((candidate) => candidate.requires.some((requirement) => requirement.import_contains === "MainLayout")), "import detector proposes the shared MainLayout import");
    assert(result.candidates.some((candidate) => candidate.requires.some((requirement) => requirement.jsx_tree_contains === "Menu")), "JSX detector proposes the shared Menu component");
    assert(result.candidates.some((candidate) => candidate.requires.some((requirement) => requirement.inherits_from === "BaseStrategy")), "class inheritance detector proposes the shared BaseStrategy parent");
    assert(!!result.report_path && existsSync(result.report_path), "convention induction writes the candidate report by default");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioPathAndDetectorFiltersStayFocused() {
  const tmp = makeTemp("filters");
  try {
    seedFrontendPages(tmp);
    seedBackendRoutes(tmp);

    const run = runCli(["--dir", tmp, "--path", "src/pages", "--detector", "jsx_tree_only", "--json"], tmp);
    assert(run.ok, "convention inducer CLI exits cleanly for a focused JSX run");
    const parsed = parseJson(run.stdout);
    assert(!!parsed, "convention inducer CLI emits valid JSON");
    assert(parsed?.detectors?.length === 1 && parsed.detectors[0] === "jsx_tree", "focused JSX run executes only the JSX detector");
    assert(parsed?.candidates?.every((candidate) => candidate.detected_from === "induction_jsx_tree"), "focused JSX run emits only JSX-derived candidates");
    assert(parsed?.candidates?.every((candidate) => candidate.applies_to?.file_patterns?.[0]?.startsWith("src/pages/")), "focused JSX run keeps candidates inside the requested subtree");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioExistingConventionsAreDeduplicated() {
  const tmp = makeTemp("dedupe");
  try {
    seedFrontendPages(tmp);
    seedExistingConvention(tmp);

    const result = induceConventionCandidates({ cwd: tmp });
    assert(result.ok, "convention induction succeeds when authored conventions already exist");
    assert(result.candidates.every((candidate) => !candidate.requires.some((requirement) => requirement.import_contains === "MainLayout")), "existing convention fingerprints are not re-proposed as duplicate candidates");
    assert(result.candidates.every((candidate) => Number(String(candidate.id).replace(/^CONV-/, "")) > 900), "new convention candidates allocate ids above existing ontology conventions");
    assert(new Set(result.candidates.map((candidate) => candidate.id)).size === result.candidates.length, "new convention candidates keep unique ids within the report");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

scenarioDetectorsProduceStructuredCandidatesAndReport();
scenarioPathAndDetectorFiltersStayFocused();
scenarioExistingConventionsAreDeduplicated();

console.log(`\nConvention inducer tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
