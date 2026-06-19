#!/usr/bin/env node
// test_t16_structural_contracts.mjs — t16 structural debt contracts.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  loadGateRegistry,
} from "../scripts/lib/gate_registry.mjs";
import {
  rootInstructionPortabilityMatrix,
} from "../scripts/lib/root_instruction_renderer.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    failures.push(detail ? `${label}: ${detail}` : label);
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function normalizeCell(value) {
  return String(value || "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSurface(value) {
  return normalizeCell(value)
    .toLowerCase()
    .replace(/\s+clients?$/u, "")
    .replace(/\s+/g, " ");
}

function extractSection(markdown, heading) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const start = text.search(new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im"));
  if (start === -1) return "";
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function parseMarkdownTableRows(section) {
  return String(section || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .filter((line) => !/^\|\s*-+/.test(line))
    .slice(1)
    .map((line) => line.slice(1, -1).split("|").map(normalizeCell));
}

function expectedInstructionFileBySurface(matrix) {
  const expected = new Map();
  for (const entry of matrix) {
    for (const agent of entry.agents || []) {
      expected.set(normalizeSurface(agent), entry.path);
    }
  }
  return expected;
}

function comparePortabilityDocToRenderer({ docText, matrix }) {
  const rows = parseMarkdownTableRows(extractSection(docText, "Portability Matrix"));
  const actual = new Map();
  for (const row of rows) {
    if (row.length < 2) continue;
    actual.set(normalizeSurface(row[0]), row[1]);
  }

  const expected = expectedInstructionFileBySurface(matrix);
  const issues = [];
  for (const [surface, expectedPath] of expected.entries()) {
    const actualPath = actual.get(surface);
    if (!actualPath) {
      issues.push(`missing ${surface}`);
    } else if (actualPath !== expectedPath) {
      issues.push(`${surface}: expected ${expectedPath}, got ${actualPath}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function checkVersionAgreement({ versionJsonText, skillText, migrationText }) {
  let configVersion = "";
  try {
    configVersion = JSON.parse(versionJsonText).version || "";
  } catch {
    return { ok: false, issues: ["version.json is not valid JSON"] };
  }

  const skillVersion = skillText.match(/planner_version:\s*"([^"]+)"/)?.[1] || "";
  const latestMigrationVersion = migrationText.match(/^\|\s*([0-9]+\.[0-9]+\.[0-9]+)\s*\|/m)?.[1] || "";
  const versionRow = migrationText
    .split("\n")
    .find((line) => line.startsWith(`| ${configVersion} |`)) || "";
  const skipRationale = /\b9(?:\.x|\.0\.0)?\b/i.test(versionRow) && /\b(skip|skipped|reserved|intentionally)\b/i.test(versionRow);

  const issues = [];
  if (configVersion !== skillVersion) issues.push(`SKILL.md version ${skillVersion} != config ${configVersion}`);
  if (configVersion !== latestMigrationVersion) issues.push(`MIGRATION latest ${latestMigrationVersion} != config ${configVersion}`);
  if (!skipRationale) issues.push("MIGRATION 10.0.0 row does not explain the skipped 9.x major line");
  return { ok: issues.length === 0, issues };
}

console.log("\nt16 Structural Contract Tests\n");

const gateRegistryModule = await import("../scripts/lib/gate_registry.mjs");
const namespaceModule = await import("../scripts/ontology_namespace_check.mjs").catch((error) => ({ __error: error }));

{
  const required = ["renderGateRegistryPrologFacts", "compareGateRegistryPrologFacts"];
  for (const name of required) {
    assert(typeof gateRegistryModule[name] === "function", `gate registry exports ${name}`);
  }

  if (required.every((name) => typeof gateRegistryModule[name] === "function")) {
    const registry = loadGateRegistry({ skillPath: skillDir });
    const prologText = readFileSync(join(skillDir, "prolog", "transitions.pl"), "utf-8");
    const comparison = gateRegistryModule.compareGateRegistryPrologFacts({
      gates: registry.gates,
      prologText,
    });
    assert(comparison.ok, "Prolog gate facts match config/gates.json", comparison.issues?.join("; "));

    const driftText = prologText.replace("gate_transition('plan-to-execute', plan, execute).", "gate_transition('plan-to-execute', plan, validate).");
    const drift = gateRegistryModule.compareGateRegistryPrologFacts({
      gates: registry.gates,
      prologText: driftText,
    });
    assert(!drift.ok, "injected Prolog gate drift fails");
  }
}

{
  assert(typeof namespaceModule.checkOntologyNamespace === "function", "ontology namespace checker exports checkOntologyNamespace");
  if (typeof namespaceModule.checkOntologyNamespace === "function") {
    const baseline = namespaceModule.checkOntologyNamespace({ cwd: repoRoot });
    assert(baseline.ok, "current active ontology and packs stay inside namespace", baseline.issues?.map((issue) => issue.message || issue.code).join("; "));

    const injected = namespaceModule.checkOntologyNamespace({
      cwd: repoRoot,
      extraPrologTexts: [{ source: "injected-out-of-namespace.pl", text: "rogue_predicate('fixture')." }],
    });
    assert(!injected.ok, "injected out-of-namespace predicate fails");
    assert(
      injected.issues?.some((issue) => issue.predicate === "rogue_predicate"),
      "namespace failure names the injected predicate"
    );
  }
}

{
  const matrix = rootInstructionPortabilityMatrix();
  const canonicalDoc = readFileSync(join(repoRoot, "docs", "ive-redesign", "16_multi_ide_portability.md"), "utf-8");
  const historicalDoc = readFileSync(join(repoRoot, "docs", "ive-redesign", "15_multi_ide_portability.md"), "utf-8");
  const parity = comparePortabilityDocToRenderer({ docText: canonicalDoc, matrix });
  assert(parity.ok, "doc 16 portability matrix matches renderer matrix", parity.issues.join("; "));

  const driftDoc = canonicalDoc.replace("| Antigravity | `GEMINI.md` |", "| Antigravity | `AGENTS.md` |");
  const drift = comparePortabilityDocToRenderer({ docText: driftDoc, matrix });
  assert(!drift.ok, "injected doc-vs-code portability drift fails");

  assert(
    !/^##\s+Portability Matrix\s*$/im.test(historicalDoc),
    "historical doc 15 no longer presents a normative portability matrix"
  );
}

{
  const versionJsonText = readFileSync(join(skillDir, "config", "version.json"), "utf-8");
  const skillText = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
  const migrationText = readFileSync(join(skillDir, "MIGRATION.md"), "utf-8");
  const agreement = checkVersionAgreement({ versionJsonText, skillText, migrationText });
  assert(agreement.ok, "version surfaces agree and skipped major is explained", agreement.issues.join("; "));

  const drift = checkVersionAgreement({
    versionJsonText,
    skillText: skillText.replace('planner_version: "10.0.0"', 'planner_version: "10.0.1"'),
    migrationText,
  });
  assert(!drift.ok, "injected version-surface drift fails");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
