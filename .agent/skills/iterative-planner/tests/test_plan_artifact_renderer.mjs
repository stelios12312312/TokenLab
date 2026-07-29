#!/usr/bin/env node

import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  measurePlanArtifactProjection,
  renderPlanArtifact,
  renderPlanArtifacts,
} from "../scripts/lib/plan_artifact_renderer.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const cliPath = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "plan_artifact_renderer.mjs");
const NODE = process.execPath;

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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function listFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path.replace(root, ""));
      }
    }
  }
  visit(root);
  return files.sort();
}

function createFixture(tmp, name = "plan_renderer_fixture") {
  const plansDir = join(tmp, "plans");
  const planDir = join(plansDir, name);
  mkdirSync(planDir, { recursive: true });

  writeJson(join(planDir, "state.json"), {
    state: "PLAN",
    iteration: 1,
    current_step: "step_1",
    fix_attempts: { step_1: 1 },
    change_manifest: ["renderer fixture"],
    transitions: [
      {
        from: "EXPLORE",
        to: "PLAN",
        timestamp: "2026-06-16T10:00:00.000Z",
        gate_result: "PASS",
        failure_codes: [],
      },
    ],
  });

  writeJson(join(planDir, "findings_ledger.json"), {
    version: 1,
    findings: [
      {
        id: "F-001",
        title: "Structured renderer fixture",
        severity: "info",
        summary: "Renderer can project findings from JSON.",
        evidence: ["fixture"],
      },
    ],
    root_cause: ["JSON sources need deterministic markdown projections."],
    adjacency: ["state.md", "plan.md"],
  });

  writeJson(join(planDir, "plan.json"), {
    goal: "Render artifacts from JSON",
    problem_statement: {
      expected_behavior: "Renderer projects markdown without mutating by default.",
      invariants: ["JSON remains authoritative"],
      edge_cases: ["missing source"],
    },
    files_to_modify: ["scripts/lib/plan_artifact_renderer.mjs"],
    steps: [
      { id: "step_1", description: "Add renderer", status: "pending" },
    ],
    success_criteria: [
      { id: "sc_1", description: "Renderer maps one source to one target." },
    ],
    verification_strategy: [
      {
        criterion_id: "sc_1",
        story_linkage: "US-086",
        repo_context: "renderer fixture",
        required_proof_type: "proof:behavioral",
        command: "node test_plan_artifact_renderer.mjs",
        pass_means: "test passes",
        what_remains_unverified: "remote CI",
      },
    ],
    semantic_upkeep_contract: {
      profile: "other",
      ontology_action: "none",
      story_action: "none",
      validation_bundle: "mixed",
      strictness_mode: "full",
      close_blocker_if_skipped: "renderer proof missing",
    },
  });

  writeJson(join(planDir, "verification_ledger.json"), {
    version: 1,
    evidence: [
      {
        id: "ev_renderer",
        subject: "deliverable:renderer",
        mode: "test",
        status: "passed",
        actor: "codex",
        command: "node test_plan_artifact_renderer.mjs",
        artifacts: ["test_plan_artifact_renderer.mjs"],
      },
    ],
    waivers: [
      {
        id: "wv_remote_ci",
        subject: "remote-ci",
        mode: "not_applicable",
        reason: "local fixture",
        approved_by: "test",
      },
    ],
  });

  writeJson(join(planDir, "persona_guidance.json"), {
    version: 1,
    phase: "plan",
    items: [
      { pack_id: "traceability", guidance: "Link evidence to success criteria." },
    ],
  });

  writeJson(join(planDir, "persona_constraints.json"), {
    version: 1,
    phase: "plan",
    constraints: [
      {
        id: "CI-C-001",
        role: "config_integrity",
        severity: "MEDIUM",
        constraint: "Document CLI flags",
        rationale: "Flags can mutate state.",
        story_refs: ["US-086"],
      },
    ],
  });

  writeJson(join(planDir, "persona_findings.json"), {
    version: 1,
    gate: "plan-to-execute",
    findings: [
      {
        analyzer: "[traceability] traceability",
        severity: "warn",
        message: "fixture warning",
        location: "US-086",
        details: "fixture detail",
      },
    ],
  });

  writeJson(join(planDir, "persona_execution.json"), {
    version: 1,
    status: "ok",
    phase: "execute",
    summary: { obligations: 1, blocking: 0 },
    persona_authority: {
      decisions: [
        { pack_id: "traceability", authority: "active", reason: "fixture" },
      ],
    },
    obligations: [
      { id: "traceability", severity: "medium", status: "open", description: "prove projection" },
    ],
  });

  return { plansDir, planDir };
}

function runCli(args, cwd) {
  return spawnSync(NODE, [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
  });
}

function scenarioRendererAndCli() {
  const tmp = mkdtempSync(join(tmpdir(), "plan-artifact-renderer-"));
  try {
    const { plansDir, planDir } = createFixture(tmp);
    const results = renderPlanArtifacts(planDir);
    assert(results.length === 8, "renders all selected artifact pairs");
    assert(results.every((item) => item.status === "rendered"), "all fixture JSON sources render");
    assert(results.every((item) => item.source && item.source_path && item.target_path), "each result declares one source and one target");
    assert(results.every((item) => item.existing_mirror.present === false), "rendering does not write mirrors by default");

    const state = renderPlanArtifact(planDir, "state.md");
    assert(state.text.includes("# Current State: PLAN"), "state renderer projects state.md text");
    assert(state.existing_mirror.matches === null, "missing mirror has null match status");

    const renderJson = runCli(["render", "--plan", planDir, "--artifact", "state.md", "--json"], repoRoot);
    assert(renderJson.status === 0, "CLI render --json exits cleanly");
    const parsed = JSON.parse(renderJson.stdout);
    assert(parsed.artifacts?.[0]?.status === "rendered", "CLI render JSON reports rendered artifact");
    assert(!existsSync(join(planDir, "state.md")), "CLI render without --write does not create state.md");

    const writeJsonRun = runCli(["render", "--plan", planDir, "--artifact", "state.md", "--write", "--json"], repoRoot);
    assert(writeJsonRun.status === 0, "CLI render --write exits cleanly");
    assert(existsSync(join(planDir, "state.md")), "CLI render --write materializes state.md");
    assert(readFileSync(join(planDir, "state.md"), "utf-8").includes("Transition History"), "written state.md contains projected text");

    const beforeMeasure = listFiles(planDir);
    const measurement = measurePlanArtifactProjection({ plansDir, sampleLimit: 1 });
    const afterMeasure = listFiles(planDir);
    assert(JSON.stringify(beforeMeasure) === JSON.stringify(afterMeasure), "measurement does not mutate sampled plans");
    assert(measurement.sample_count === 1, "measurement reports one sampled plan");
    assert(measurement.plans[0].current_file_count > measurement.plans[0].projected_file_count, "measurement reports projected file-count reduction");

    const measureJson = runCli(["measure", "--plans", plansDir, "--sample", "1", "--json"], repoRoot);
    assert(measureJson.status === 0, "CLI measure --json exits cleanly");
    const measureParsed = JSON.parse(measureJson.stdout);
    assert(measureParsed.totals.delta_files < 0, "CLI measure reports negative file delta when mirrors exist");

    writeFileSync(join(planDir, "plan.json"), "{bad json\n");
    const badPlan = renderPlanArtifact(planDir, "plan.md");
    assert(badPlan.status === "error" && badPlan.error, "malformed JSON source reports structured error");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\nPlan Artifact Renderer Tests\n");
scenarioRendererAndCli();

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${passed} assertions passed`);
