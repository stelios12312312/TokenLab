#!/usr/bin/env node
// ripple_check.mjs — Verify that every gate behaviour is documented across all required files.
//
// Usage:
//   node ripple_check.mjs                   Check all gates
//   node ripple_check.mjs <gate-name>       Check a specific gate (e.g. execute-to-reflect)
//   node ripple_check.mjs --json            Machine-readable output
//
// This script prevents the "tunnel vision" mistake where a gate change is made
// in transition.mjs but the ripple-through to checklists, failure codes, the
// planner instruction surface, and migration is forgotten.
//
// Exit codes: 0 = all gates fully documented, 1 = gaps found, 2 = error.

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "./lib/emit_json.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillDir = join(scriptDir, "..");
const cwd = process.cwd();

// Read gate list from registry (single source of truth)
const gatesJsonPath = join(skillDir, "config", "gates.json");
const gatesRegistry = existsSync(gatesJsonPath)
  ? JSON.parse(readFileSafe(gatesJsonPath) || "{}").gates || {}
  : {};
const GATES = Object.keys(gatesRegistry);
if (GATES.length === 0) {
  console.error("ERROR: config/gates.json not found or empty — gate registry is required.");
  process.exit(2);
}

// Files that must reference each gate (except notify-user which is lighter)
const REQUIRED_FILES = [
  { path: join(skillDir, "scripts", "transition.mjs"),    label: "transition.mjs" },
  { path: join(skillDir, "config", "failure-codes.json"), label: "failure-codes.json" },
];

const DOC_SURFACE_FILES = [
  { path: join(skillDir, "SKILL.md"), label: "SKILL.md" },
  { path: join(cwd, "CLAUDE.md"), label: "CLAUDE.md" },
  { path: join(cwd, "GEMINI.md"), label: "GEMINI.md" },
  { path: join(cwd, "AGENTS.md"), label: "AGENTS.md" },
];
const ARCHETYPE_SCENARIO_CONFIG_PATH = join(skillDir, "config", "archetype_scenarios.json");

// Checklists: each gate should have a matching YAML checklist
function checklistPath(gate) {
  return join(skillDir, "checklists", `${gate}.yaml`);
}

function readFileSafe(path) {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

function readPlannerCoreProofBundle() {
  const content = readFileSafe(ARCHETYPE_SCENARIO_CONFIG_PATH);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    const bundle = parsed?.planner_core_proof_bundle;
    if (!bundle || typeof bundle !== "object") return null;
    return {
      trigger_paths: Array.isArray(bundle.trigger_paths) ? bundle.trigger_paths : [],
      required_commands: Array.isArray(bundle.required_commands) ? bundle.required_commands : [],
    };
  } catch {
    return null;
  }
}

function checkGate(gateName) {
  const gaps = [];

  // 1. Check required files reference this gate
  for (const { path, label } of REQUIRED_FILES) {
    const content = readFileSafe(path);
    if (!content) {
      gaps.push({ file: label, issue: "file not found" });
      continue;
    }
    if (!content.includes(gateName)) {
      gaps.push({ file: label, issue: `no reference to "${gateName}"` });
    }
  }

  // 1b. Check the planner instruction surface references this gate.
  const docHits = DOC_SURFACE_FILES.filter(({ path }) => {
    const content = readFileSafe(path);
    return content?.includes(gateName);
  });
  if (docHits.length === 0) {
    gaps.push({
      file: "instruction-surface",
      issue: `no reference to "${gateName}" in SKILL.md, CLAUDE.md, GEMINI.md, or AGENTS.md`,
    });
  }

  // 2. Check checklist exists
  const clPath = checklistPath(gateName);
  if (!existsSync(clPath)) {
    gaps.push({ file: `checklists/${gateName}.yaml`, issue: "checklist file missing" });
  }

  // 3. Check failure-codes.json has at least one code for this gate
  const fcPath = join(skillDir, "config", "failure-codes.json");
  const fcContent = readFileSafe(fcPath);
  if (fcContent) {
    try {
      const fc = JSON.parse(fcContent);
      // F-032 FIX: Removed dead variable gatePrefix (was unused)
      const hasCode = Object.values(fc.codes || {}).some(c => c.gate === gateName);
      if (!hasCode) {
        gaps.push({ file: "failure-codes.json", issue: `no failure code with gate="${gateName}"` });
      }
    } catch { /* parse error already caught above */ }
  }

  // 4. Check MIGRATION.md references the gate (for compulsory gates)
  const migPath = join(skillDir, "MIGRATION.md");
  const migContent = readFileSafe(migPath);
  // Only check migration for non-trivial gates
  if (migContent && !migContent.includes(gateName) && gateName !== "notify-user") {
    gaps.push({ file: "MIGRATION.md", issue: `no reference to "${gateName}" (consider if upgrade users need to know)`, severity: "warn" });
  }

  return { gate: gateName, gaps, pass: gaps.filter(g => g.severity !== "warn").length === 0 };
}

// --- Version consistency check ---
// The planner version is encoded in two places. Both must agree.

function checkVersionConsistency() {
  const gaps = [];

  // Source of truth: version.json
  const versionJsonPath = join(skillDir, "config", "version.json");
  const versionJsonContent = readFileSafe(versionJsonPath);
  let canonicalVersion = null;
  if (!versionJsonContent) {
    gaps.push({ file: "config/version.json", issue: "version.json not found — this is the single source of truth for version" });
  } else {
    try {
      canonicalVersion = JSON.parse(versionJsonContent).version;
      if (!canonicalVersion) {
        gaps.push({ file: "config/version.json", issue: "version field missing in version.json" });
      }
    } catch {
      gaps.push({ file: "config/version.json", issue: "version.json is not valid JSON" });
    }
  }

  // Check SKILL.md frontmatter matches
  const skillContent = readFileSafe(join(skillDir, "SKILL.md"));
  const skillMatch = skillContent?.match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/);
  const skillVersion = skillMatch?.[1] || null;

  if (!skillVersion) {
    gaps.push({ file: "SKILL.md", issue: "planner_version not found in frontmatter" });
  } else if (canonicalVersion && skillVersion !== canonicalVersion) {
    gaps.push({
      file: "SKILL.md",
      issue: `planner_version="${skillVersion}" but version.json="${canonicalVersion}"`
    });
  }

  // Check MIGRATION.md version history includes the canonical version
  const migrationContent = readFileSafe(join(skillDir, "MIGRATION.md"));
  const versionRows = migrationContent?.match(/\|\s*(\d+\.\d+\.\d+)\s*\|/g) || [];
  const migrationVersions = versionRows.map(r => r.match(/(\d+\.\d+\.\d+)/)?.[1]).filter(Boolean);
  // F-018 FIX: Sort by semver instead of assuming document order = chronological
  migrationVersions.sort((a, b) => {
    const [a1, a2, a3] = a.split(".").map(Number);
    const [b1, b2, b3] = b.split(".").map(Number);
    return a1 - b1 || a2 - b2 || a3 - b3;
  });
  const latestMigrationVersion = migrationVersions.length > 0 ? migrationVersions[migrationVersions.length - 1] : null;

  if (canonicalVersion && latestMigrationVersion && latestMigrationVersion !== canonicalVersion) {
    gaps.push({
      file: "MIGRATION.md",
      issue: `latest version in history="${latestMigrationVersion}" but version.json="${canonicalVersion}"`,
      severity: "warn"
    });
  }

  return {
    gate: "version-consistency",
    gaps,
    pass: gaps.filter(g => g.severity !== "warn").length === 0,
    versions: { canonical: canonicalVersion, skill: skillVersion, migrationDoc: latestMigrationVersion }
  };
}

function checkPlannerCoreProofBundle() {
  const gaps = [];
  const bundle = readPlannerCoreProofBundle();
  const skillContent = readFileSafe(join(skillDir, "SKILL.md")) || "";
  const preCommitContent = readFileSafe(join(skillDir, "scripts", "pre_commit_policy.mjs")) || "";

  if (!bundle) {
    gaps.push({ file: "config/archetype_scenarios.json", issue: "planner_core_proof_bundle registry missing or invalid" });
    return { gate: "planner-core-proof-bundle", gaps, pass: false };
  }

  if (bundle.trigger_paths.length === 0) {
    gaps.push({ file: "config/archetype_scenarios.json", issue: "planner_core_proof_bundle.trigger_paths must list the sensitive planner-core surfaces" });
  }

  if (bundle.required_commands.length === 0) {
    gaps.push({ file: "config/archetype_scenarios.json", issue: "planner_core_proof_bundle.required_commands must list the required scenario suites" });
  }

  for (const command of bundle.required_commands) {
    if (!skillContent.includes(command)) {
      gaps.push({ file: "SKILL.md", issue: `planner-core proof bundle command missing from docs: ${command}` });
    }
  }

  if (!preCommitContent.includes("planner-core proof bundle expected before merge")) {
    gaps.push({ file: "pre_commit_policy.mjs", issue: "pre-commit policy does not surface the planner-core proof bundle reminder" });
  }

  return {
    gate: "planner-core-proof-bundle",
    gaps,
    pass: gaps.filter((gap) => gap.severity !== "warn").length === 0,
  };
}

// --- CLI ---
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const specificGate = args.find(a => !a.startsWith("--"));

const gatesToCheck = specificGate ? [specificGate] : GATES;
const results = gatesToCheck.map(checkGate);

// Always run version consistency check (unless checking a specific gate)
if (!specificGate) {
  results.push(checkVersionConsistency());
  results.push(checkPlannerCoreProofBundle());
}

const totalGaps = results.reduce((sum, r) => sum + r.gaps.length, 0);
const hardGaps = results.reduce((sum, r) => sum + r.gaps.filter(g => g.severity !== "warn").length, 0);
const exitCode = hardGaps > 0 ? 1 : 0;

if (jsonMode) {
  emitJson({ results, summary: { gates: results.length, total_gaps: totalGaps, hard_gaps: hardGaps } }, { exitCode });
} else {
  console.log("\n  ══ RIPPLE-THROUGH CHECK ══\n");
  for (const r of results) {
    const icon = r.pass ? "✅" : "❌";
    console.log(`  ${icon} ${r.gate}`);
    for (const g of r.gaps) {
      const severity = g.severity === "warn" ? "⚠️" : "❌";
      console.log(`     ${severity} ${g.file}: ${g.issue}`);
    }
  }
  console.log(`\n  Summary: ${results.length} gate(s) checked, ${totalGaps} gap(s) found (${hardGaps} hard)\n`);
  if (hardGaps > 0) {
    console.log("  RESULT: ❌ GAPS FOUND — update all required files before proceeding\n");
  } else if (totalGaps > 0) {
    console.log("  RESULT: ⚠️  Warnings only — review but not blocking\n");
  } else {
    console.log("  RESULT: ✅ All gates fully documented\n");
  }
  process.exitCode = exitCode;
}
