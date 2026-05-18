#!/usr/bin/env node
// test_repair_packet_examples.mjs - Staleness defense for repair-packet examples.
//
// Each examples/passing/<GATE-ID>.md must actually PASS its own gate when the
// example content is substituted into the gate's primary artifact (e.g.,
// red_team_notes.md for GATE-ETR-008). Without this test, a gate predicate can
// evolve and reject the very example we recommend as the worked sample —
// silently turning the scaffold into a trap rather than a guide.
//
// New gates registered under config/gate_templates/*.json with examples in
// examples/passing/<GATE-ID>.md are auto-discovered here; add the gate-specific
// fixture builder + gate runner via FIXTURE_BUILDERS below.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { gateExecuteToReflect, gatePlanToExecute } from "../scripts/verify_gate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillRoot = join(__dirname, "..");
const TEMPLATE_DIR = join(skillRoot, "config", "gate_templates");
const EXAMPLE_DIR = join(skillRoot, "examples", "passing");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// Per-gate fixture builders: each entry knows how to (1) seed a temp plan_dir
// with the example content placed in the right artifact, (2) run the gate
// predicate against the plan_dir, and (3) extract the relevant gate result.
// Adding a new gate to the staleness defense requires adding one entry here.
//
// The example is the canonical shape of ONE passing vector; some gates
// require multiple vectors (e.g. GATE-ETR-008 needs >=3 to fire at all,
// per GATE-ETR-003's separate vector-count threshold). The seed() builder
// is responsible for multiplying the example into the minimum quorum so
// the depth check we care about actually runs.
const FIXTURE_BUILDERS = {
  "GATE-ETR-008": {
    seed(planDir, exampleContent) {
      // Strip the leading "## Vector 1:" so we can re-prefix with distinct
      // titles. Empty/missing prefix is acceptable — we re-add the heading.
      const body = exampleContent.replace(/^##\s+Vector\s+1:[^\n]*\n?/i, "").trim();
      const vectorTitles = [
        "Parser label drift (example clone 1)",
        "Parser label drift (example clone 2)",
        "Parser label drift (example clone 3)",
      ];
      const vectors = vectorTitles.map((title, i) => `## Vector ${i + 1}: ${title}\n${body}`);
      writeFileSync(join(planDir, "red_team_notes.md"), vectors.join("\n\n"));
      // progress.md is required by sibling checks in gateExecuteToReflect;
      // supply a minimal substantive value so the example is isolated to
      // GATE-ETR-008 depth, not knocked out by an unrelated FAIL.
      writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] fixture\n");
    },
    run(planDir) {
      return gateExecuteToReflect(planDir);
    },
    result(results) {
      return results.find((r) => r?.code === "GATE-ETR-008");
    },
  },

  "GATE-PLN-ANN-001": {
    // The example shows TWO passing shapes (a file with annotations, a
    // plan-side waiver). We exercise the annotated-file shape: extract the
    // first JS code block from the example and seed it as the file under test.
    // The corresponding plan.md lists that file in `## Files To Modify`.
    // If the gate predicate evolves (e.g. requires more annotations), the
    // example's content must be updated to keep passing — that's the
    // staleness defense.
    seed(planDir, exampleContent, { fixtureRoot }) {
      const codeBlockRe = /```(?:javascript|js|mjs)?\n([\s\S]*?)```/;
      const match = exampleContent.match(codeBlockRe);
      const annotatedSource = match
        ? match[1].trim() + "\n"
        : "// @planner:capability = staleness_test_fallback\nexport const v = 1;\n";
      // Place the annotated file at the path the worked example documents.
      const filePathInPlan = "scripts/lib/sample_helper.mjs";
      const absFilePath = join(fixtureRoot, filePathInPlan);
      mkdirSync(join(absFilePath, ".."), { recursive: true });
      writeFileSync(absFilePath, annotatedSource);
      // Plan must list the file in Files To Modify so the gate notices it.
      // Include a minimal but valid plan.md skeleton for gatePlanToExecute.
      const plan = [
        "# Plan v0",
        "",
        "## Problem Statement",
        "Staleness fixture exercising the annotated-file path.",
        "",
        "## Files To Modify",
        `- ${filePathInPlan}`,
        "",
        "## Steps",
        "1. seed",
        "",
        "## Verification Strategy",
        "Verified by test_repair_packet_examples.mjs.",
        "",
        "## Success Criteria",
        "Example passes GATE-PLN-ANN-001.",
        "",
        "## Semantic Upkeep Contract",
        "- Profile: integration_backend_orchestration",
      ].join("\n");
      writeFileSync(join(planDir, "plan.md"), plan);
    },
    // gatePlanToExecute resolves files relative to process.cwd(). The fixture
    // root must be the cwd when the gate runs, so the test runner sets cwd
    // before invoking the gate (see the per-builder cwd handling below).
    run(planDir, fixtureRoot) {
      const originalCwd = process.cwd();
      try {
        process.chdir(fixtureRoot);
        return gatePlanToExecute(planDir);
      } finally {
        process.chdir(originalCwd);
      }
    },
    result(results) {
      return results.find((r) => r?.code === "GATE-PLN-ANN-001");
    },
  },
};

console.log("\nRepair Packet Examples - staleness defense\n");

// Discover every gate that has BOTH a template and an example. Any such pair
// must have a matching FIXTURE_BUILDERS entry, otherwise the staleness test
// is incomplete — we make that explicit so future contributors see the gap.
const templates = existsSync(TEMPLATE_DIR)
  ? readdirSync(TEMPLATE_DIR).filter((name) => name.endsWith(".json"))
  : [];

for (const templateFile of templates) {
  const gateId = templateFile.replace(/\.json$/, "");
  const examplePath = join(EXAMPLE_DIR, `${gateId}.md`);
  if (!existsSync(examplePath)) {
    assert(false, `${gateId}: example file is missing at ${examplePath}`);
    continue;
  }

  const builder = FIXTURE_BUILDERS[gateId];
  if (!builder) {
    assert(false, `${gateId}: no FIXTURE_BUILDERS entry — staleness coverage incomplete`);
    continue;
  }

  const exampleContent = readFileSync(examplePath, "utf-8");
  const tmp = mkdtempSync(join(tmpdir(), `repair-example-${gateId}-`));
  const planDir = join(tmp, "plans", `plan_${gateId.toLowerCase()}`);
  mkdirSync(planDir, { recursive: true });
  try {
    // Pass the fixture root through to seed/run so gates that need a cwd
    // (e.g. GATE-PLN-ANN-001 reads file content relative to process.cwd())
    // can resolve paths correctly.
    builder.seed(planDir, exampleContent, { fixtureRoot: tmp });
    const results = builder.run(planDir, tmp);
    const targetResult = builder.result(results);
    assert(!!targetResult, `${gateId}: gate predicate produced a result entry`);
    if (!targetResult) continue;
    assert(
      targetResult.status === "PASS",
      `${gateId}: example PASSES its own gate (got ${targetResult.status}: ${(targetResult.detail || "").slice(0, 120)})`
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

if (templates.length === 0) {
  assert(false, "no gate_templates found — staleness defense has nothing to assert");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
