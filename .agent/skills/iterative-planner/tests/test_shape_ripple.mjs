#!/usr/bin/env node
// test_shape_ripple.mjs — v7.3.1 shape-conditional gates ripple to PLAN/ETR/VAL.
//
// v7.3.0 made EXPLORE shape-conditional but missed the keyword-overbreadth at
// PLAN (synthesized obligations), the section-shape ritual at ETR (red-team
// vector counts), the keyword overbreadth at VAL (anti-recurrence triggers
// firing on "audit"/"remediation"), the .pl ontology DSL classification, and
// the persona pack scope. This test locks in the v7.3.1 fixes.

import {
  detectPlanShape,
  shapeMinFindings,
} from "../scripts/lib/plan_shape.mjs";
import {
  computeVerificationObligationSynthesis,
  obligationFamilyAllowedForShape,
} from "../scripts/lib/verification_obligations.mjs";
import {
  looksLikeOntologyDslPath,
  requiresTestEvidence,
} from "../scripts/lib/plan_refresh.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nShape-Aware Gate Ripple Contract\n");

// ── #1 Obligation synthesis shape-aware ──────────────────────────────
console.log("\n[#1] Obligation synthesis is shape-aware");

// Tesseract case — webhook plan with "model"/"signal" overlap should NOT
// activate quant_modeling or any irrelevant family.
const tesseract = computeVerificationObligationSynthesis({
  cwd: process.cwd(),
  stateJson: { goal: "Design a webhook to tag users via GHL automation" },
  planContent: "## Goal\nDesign a webhook with multi-agent operating model and signal handling",
});
const tesseractIds = (tesseract.obligations || []).map((o) => o.id);
assert(!tesseractIds.includes("quant_modeling"),
  "webhook plan with 'model'/'signal' in prose does NOT activate quant_modeling");

// Genuine quant work with structured signal still activates quant_modeling
const quantPlan = computeVerificationObligationSynthesis({
  cwd: process.cwd(),
  stateJson: { goal: "Backtest a new alpha strategy" },
  planContent: "## Goal\nBacktest\n## Files To Modify\n- strategies/momentum.py\n- backtest/runner.py",
});
const quantIds = (quantPlan.obligations || []).map((o) => o.id);
assert(quantIds.includes("quant_modeling"),
  "real quant plan with /strategies/ + /backtest/ paths still activates quant_modeling");

// Shape-allowlist filter: feature shape skips quant by default
assert(!obligationFamilyAllowedForShape("quant_modeling", "integration"),
  "integration shape disallows quant_modeling family");
assert(!obligationFamilyAllowedForShape("quant_modeling", "feature"),
  "feature shape disallows quant_modeling family");
assert(obligationFamilyAllowedForShape("quant_modeling", "unknown"),
  "unknown shape allows quant_modeling (legacy strict default)");

// Path matching tolerates missing leading slash
const quantPlan2 = computeVerificationObligationSynthesis({
  cwd: process.cwd(),
  stateJson: { goal: "Add validation suite" },
  planContent: "## Goal\nAdd validation\n## Files To Modify\n- models/factor.py",
});
const quant2Ids = (quantPlan2.obligations || []).map((o) => o.id);
assert(quant2Ids.includes("quant_modeling"),
  "models/factor.py (no leading slash) activates quant via path-tolerance fix");

// ── #2 M-CMS-001 trigger now requires 2 families ─────────────────────
console.log("\n[#2] M-CMS-001 mistake trigger tightened");

// We can't directly run the mistake registry without proper fixtures; instead
// we assert the registry config has the right values. Read the JSON.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..", "..", "..", "..");
const registry = JSON.parse(readFileSync(join(repoRoot, ".agent/skills/iterative-planner/config/mistake_registry.json"), "utf-8"));
const cms = registry.mistakes.find((m) => m.id === "M-CMS-001");
assert(cms?.minimum_trigger_families === 2,
  "M-CMS-001 minimum_trigger_families bumped from 1 to 2");
assert(Array.isArray(cms?.triggers?.file_globs) && cms.triggers.file_globs.some((g) => /wp-/.test(g)),
  "M-CMS-001 now has wp- file_globs to require WordPress path overlap");

// ── #3 + #4 Anti-recurrence trigger no longer fires on 'audit'/'remediation' ─
console.log("\n[#3/#4] Anti-recurrence trigger narrowed");

// Open the plan_refresh.mjs source and assert the trigger list no longer has
// the bare 'audit' or 'remediation' patterns.
const planRefreshSrc = readFileSync(join(repoRoot, ".agent/skills/iterative-planner/scripts/lib/plan_refresh.mjs"), "utf-8");
const triggerBlock = planRefreshSrc.match(/ANTI_RECURRENCE_TRIGGER_PATTERNS\s*=\s*\[([\s\S]*?)\];/)?.[1] || "";
assert(!/label:\s*"audit"/.test(triggerBlock),
  "anti-recurrence triggers no longer include bare 'audit'");
assert(!/label:\s*"remediation"/.test(triggerBlock),
  "anti-recurrence triggers no longer include bare 'remediation'");
assert(/label:\s*"bug"/.test(triggerBlock),
  "anti-recurrence still triggers on 'bug'");
assert(/label:\s*"regression"/.test(triggerBlock),
  "anti-recurrence still triggers on 'regression'");

// ── #5 Ontology DSL exempt from test evidence ────────────────────────
console.log("\n[#5] Ontology DSL files exempt from test_evidence");

assert(looksLikeOntologyDslPath(".agent/skills/iterative-planner/prolog/invariants.pl"),
  "prolog/invariants.pl is recognized as ontology DSL");
assert(looksLikeOntologyDslPath("prolog/transitions.pl"),
  "any prolog/ Prolog file is ontology DSL");
assert(looksLikeOntologyDslPath("rules/foo.pl"),
  "rules/ Prolog file is ontology DSL");
assert(looksLikeOntologyDslPath("ontology/predicates.pl"),
  "ontology/ Prolog file is ontology DSL");
assert(!looksLikeOntologyDslPath("scripts/build.pl"),
  "stray .pl outside ontology folders is NOT ontology DSL (could be Perl)");
assert(!looksLikeOntologyDslPath("src/handler.mjs"),
  "non-DSL files are NOT ontology DSL");

assert(!requiresTestEvidence(".agent/skills/iterative-planner/prolog/invariants.pl"),
  "prolog ontology file does NOT require test evidence");
assert(requiresTestEvidence("scripts/build.pl"),
  "non-ontology .pl file STILL requires test evidence (treated as Perl/code)");

// ── #6 Persona pack shape skiplist ───────────────────────────────────
console.log("\n[#6] Persona pack shape skiplist");

// Read audit_runner source to verify the skiplist is in place
const auditRunnerSrc = readFileSync(join(repoRoot, ".agent/skills/iterative-planner/scripts/audit_runner.mjs"), "utf-8");
assert(/SHAPE_PACK_SKIPLIST/.test(auditRunnerSrc),
  "audit_runner.mjs declares SHAPE_PACK_SKIPLIST");
assert(/integration[\s\S]{0,200}quant/.test(auditRunnerSrc),
  "integration shape skips quant pack");
assert(/docs[\s\S]{0,200}wiring_auditor/.test(auditRunnerSrc),
  "docs shape skips wiring_auditor pack");
assert(/force_packs/.test(auditRunnerSrc),
  "audit_runner.mjs honors force_packs override");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
