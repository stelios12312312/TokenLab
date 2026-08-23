#!/usr/bin/env node

// @planner:module = quant_researcher_skill_contract_test
// @planner:proves = sc_4

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillPath = resolve(__dirname, "..", "SKILL.md");
const dataReceiptSchemaPath = resolve(__dirname, "..", "contracts", "data_receipt.schema.json");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${message}`);
    return;
  }
  failed += 1;
  console.log(`FAIL: ${message}`);
}

function includesAll(text, values) {
  return values.every((value) => text.includes(value));
}

assert(existsSync(skillPath), "SKILL.md exists");
assert(existsSync(dataReceiptSchemaPath), "data receipt schema exists");

const skill = readFileSync(skillPath, "utf8");

assert(skill.startsWith("---\nname: quant-researcher"), "YAML frontmatter declares the skill name");
assert(skill.includes("description: >"), "YAML frontmatter declares a description");

const orderedStateMachine = "SURVEY -> HYPOTHESIZE -> DESIGN -> planner-loop -> INTERPRET -> ROUTE -> REPORT -> CLOSE";
assert(skill.includes(orderedStateMachine), "exact outer state machine is documented");

for (const phase of ["SURVEY", "HYPOTHESIZE", "DESIGN", "planner-loop", "INTERPRET", "ROUTE", "REPORT", "CLOSE"]) {
  assert(skill.includes(`| ${phase} |`), `${phase} phase has a phase-contract row`);
}

assert(
  includesAll(skill, ["Purpose", "Entry criteria", "Required actions/artifacts", "Exit criteria"]),
  "phase contract table has purpose, entry criteria, actions/artifacts, and exit criteria"
);

assert(
  includesAll(skill, [
    "EXPLORE -> PLAN -> EXECUTE -> REFLECT -> VALIDATE -> CLOSE",
    "transition.mjs",
    "inner iterative plan",
    "inner_plan_ref.json",
  ]),
  "planner-loop delegates to the iterative planner gate chain"
);

assert(
  includesAll(skill, [
    "survey.md",
    "hypothesis_queue.json",
    "experiment_charter.json",
    "experiment_evidence.json",
    "quant_results_validation.json",
    "interpretation.md",
    "route_decision.json",
    "research_report.md",
    "close_receipt.json",
    "killed_hypotheses.json",
    "research_contract.json",
    "data_receipt.schema.json",
    "quant_researcher_contracts.mjs",
    "quant_researcher_e2e_manifest.json",
    "test_quant_researcher_e2e.mjs",
    "test_quant_researcher_runtime_contracts.mjs",
  ]),
  "filesystem layout names durable research artifacts"
);

assert(
  includesAll(skill, [
    "quant_research_protocol",
    "quant_target",
    "wiring_auditor",
    "config_integrity",
    "traceability",
  ]),
  "delegated proof surfaces are named"
);

assert(
  includesAll(skill, [
    "No live trading",
    "No financial, legal, tax, or investment advice",
    "promotion_allowed=false",
    "Promotion requires explicit validation artifacts",
    "New configuration flags: none",
    "Migration: none",
  ]),
  "safety, promotion, config, and migration boundaries are explicit"
);

assert(
  includesAll(skill, [
    "Research Memory Contract",
    "Research Reporter Contract",
    "Process Identity Binding",
    "Autonomy And Operator Gates",
    "next_best_experiment",
    "fails closed",
    "Default autonomy is Level 2",
  ]),
  "runtime support contracts are documented"
);

assert(
  includesAll(skill, [
    "Data Receipt Contract",
    "data_receipt_refs",
    "data_receipts",
    "valid",
    "invalid",
    "environment_invalid",
    "degraded_coverage",
    "Only `valid` evidence can support result claims",
    "deterministic fixtures only",
  ]),
  "data receipt contract and exact shared evidence validity vocabulary are documented"
);

assert(
  includesAll(skill, [
    "minimum detectable effect",
    "sample floor",
    "power note",
    "one-sentence tested region",
    "killed_hypothesis",
    "no_go",
    "kill_claim_from_smoke_evidence",
    "serious_search",
    "promotion_candidate",
    "run_experiment",
  ]),
  "symmetric kill-claim evidence floor and safe fallback are documented"
);

const dataReceiptSchema = JSON.parse(readFileSync(dataReceiptSchemaPath, "utf8"));
assert(dataReceiptSchema.properties?.schema_version?.const === 1, "data receipt schema version is pinned to 1");
assert(
  includesAll(dataReceiptSchema.required || [], [
    "receipt_ref",
    "source",
    "generator_identity",
    "span",
    "freshness",
    "row_counts",
    "coverage_counts",
    "content_hash",
    "schema_hash",
    "missing_data_profile",
    "known_at_time",
  ]),
  "data receipt schema requires all fail-closed proof fields"
);

assert(
  includesAll(skill, [
    "E2E Fixture Corpus Contract",
    "node .agent/skills/quant-researcher/tests/test_quant_researcher_e2e.mjs --type <project-type> --min 11",
    "ipbs-ufc",
    "tennis-trueskill",
    "betting-odds",
    "tokenomics",
    "ml-ranking-backtest",
    "data-quality",
    "planted-failure",
    "promotion-blocked",
    "unrouted-fact failures",
    "smoke-kill-attempt",
  ]),
  "E2E fixture corpus command, project types, and scoreboard fields are documented"
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\nAll ${passed} quant-researcher skill contract assertions passed.`);
