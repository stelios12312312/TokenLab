#!/usr/bin/env node
// test_persona_artifacts.mjs — focused coverage for persona summaries and ontology facts.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { summarizePersonaArtifacts } from "../scripts/lib/persona_artifacts.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
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

function run(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function scenarioPersonaSummaryNormalizesPackAndStorySignals() {
  const summary = summarizePersonaArtifacts({
    guidanceDoc: {
      phase: "PLAN",
      items: [
        { pack_id: "traceability", guidance: "Keep story coverage explicit." },
        { pack_id: "ux_ui", guidance: "Protect user-visible outputs." },
      ],
    },
    constraintsDoc: {
      phase: "plan",
      constraints: [
        { id: "PC_TRACE_001", role: "traceability", severity: "HIGH", story_refs: ["US_123"] },
        { id: "PC_QUANT_001", role: "quant", severity: "CRITICAL", story_refs: ["US_456"] },
      ],
    },
    findingsDoc: {
      gate: "explore-to-plan",
      findings: [
        {
          analyzer: "[traceability] role-audit",
          severity: "warn",
          _roleAudit: {
            role: "traceability",
            severity: "warn",
            category: "story_linkage",
            story_refs: ["US_123"],
          },
        },
      ],
    },
  });

  assert(summary.present === true, "persona summary reports presence when any persona artifact exists");
  assert(summary.total_items === 5, "persona summary counts guidance, constraints, and findings together");
  assert(summary.pack_ids.includes("traceability") && summary.pack_ids.includes("quant"), "persona summary preserves pack ids across artifacts");
  assert(summary.story_refs.includes("US_123") && summary.story_refs.includes("US_456"), "persona summary merges story refs across constraints and findings");
  assert(summary.constraints.severity_counts.high === 1, "persona summary preserves HIGH constraint counts");
  assert(summary.constraints.severity_counts.critical === 1, "persona summary preserves CRITICAL constraint counts");
  assert(summary.findings.severity_counts.warn === 1, "persona summary preserves persona finding severities");
  assert(summary.constraints.blocking_ids.includes("PC_TRACE_001"), "persona summary identifies blocking constraint ids");
}

function scenarioOntologySerializerEmitsPersonaFacts() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-persona-ontology-"));
  try {
    mkdirSync(join(tmp, "plans", "plan_fixture"), { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), "plan_fixture\n");
    writeFileSync(join(tmp, "plans", "plan_fixture", "plan.md"), `# Plan

## Goal
Keep story coverage explicit
`);
    writeFileSync(join(tmp, "plans", "plan_fixture", "persona_guidance.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      phase: "PLAN",
      items: [
        { pack_id: "traceability", guidance: "Keep story coverage explicit." },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "plans", "plan_fixture", "persona_constraints.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      phase: "plan",
      constraints: [
        { id: "PC_TRACE_001", role: "traceability", severity: "HIGH", constraint: "Map stories explicitly.", story_refs: ["US_123"] },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "plans", "plan_fixture", "persona_findings.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      gate: "explore-to-plan",
      summary: { fail: 0, warn: 1, info: 0 },
      findings: [
        {
          id: "PF_001",
          analyzer: "[traceability] role-audit",
          severity: "warn",
          message: "Story linkage is thin.",
          _roleAudit: {
            role: "traceability",
            severity: "warn",
            story_refs: ["US_123"],
          },
        },
      ],
    }, null, 2));

    const result = run([
      join(scriptDir, "ontology_serializer.mjs"),
      "--json",
      "--dir",
      tmp,
    ], tmp);
    assert(result.ok, "ontology_serializer exits cleanly for persona artifacts");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "ontology_serializer emits valid JSON for persona artifacts");
    assert(parsed?.facts?.some((fact) => fact.includes("persona_artifacts_present(true)")), "ontology_serializer marks persona artifacts as present");
    assert(parsed?.facts?.some((fact) => fact.includes("persona_pack('traceability')")), "ontology_serializer emits persona pack facts");
    assert(parsed?.facts?.some((fact) => fact.includes("persona_guidance_pack('traceability', 'plan')")), "ontology_serializer emits persona guidance facts");
    assert(parsed?.facts?.some((fact) => fact.includes("persona_constraint('PC_TRACE_001', 'traceability', 'high')")), "ontology_serializer emits persona constraint facts");
    assert(parsed?.facts?.some((fact) => fact.includes("persona_constraint_story('PC_TRACE_001', 'US_123')")), "ontology_serializer links persona constraints to stories");
    assert(parsed?.facts?.some((fact) => fact.includes("persona_finding('PF_001', 'traceability', 'warn')")), "ontology_serializer emits persona finding facts");
    assert(parsed?.facts?.some((fact) => fact.includes("persona_finding_story('PF_001', 'US_123')")), "ontology_serializer links persona findings to stories");
    assert(parsed?.meta?.persona_packs === 1, "ontology_serializer tracks persona pack counts in meta");
    assert(parsed?.meta?.persona_constraints === 1, "ontology_serializer tracks persona constraint counts in meta");
    assert(parsed?.meta?.persona_findings === 1, "ontology_serializer tracks persona finding counts in meta");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

scenarioPersonaSummaryNormalizesPackAndStorySignals();
scenarioOntologySerializerEmitsPersonaFacts();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
