#!/usr/bin/env node
// test_tokenomics_conformance.mjs - T12 capability-connectivity proof.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { runPersonaAuditGate } from "../scripts/audit_runner.mjs";
import { generateLiveGraphPayload } from "../../../../apps/ive-visualizer/scripts/generate-live-payload.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "../../..");

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function adversarialPlanMarkdown() {
  return `# Plan

## Problem Statement
TokenLab tokenomics launch plan with keyword-complete but contradictory economic claims.

## Files to Modify
- .agent/skills/iterative-planner/packs/tokenomics/index.mjs
- .agent/skills/iterative-planner/packs/tokenomics/rules.pl
- apps/ive-visualizer/scripts/generate-live-payload.mjs

## Verification Strategy
Tokenomics arithmetic must be checked by the live persona gate and surfaced in the cockpit.

TokenLab tokenomics launch readiness:
- Max supply: 1,000,000 tokens.
- Total supply: 1,200,000 tokens.
- Circulating supply: 1,300,000 tokens.
- Token price: $2.00.
- FDV: $1,500,000.
- Allocation distribution: team 40%, investors 40%, community 40%, liquidity 10%.
- Emissions schedule: scheduled emissions APY 35%.
- Staking rewards APY: 45%.
- Modeled protocol revenue APY: 5%.
- Yield source: scheduled emissions until fees arrive.
- Vesting schedule: 40% unlock cliff at launch, then linear unlock cadence.
- Liquidity pool depth, LP assumptions, treasury runway, reserves, governance DAO voting, multisig admin key, quorum, pause and emergency controls are listed.
- No timelock is planned because the admin key needs launch flexibility.
- Guaranteed ROI: buyers will receive 3x upside after launch.
- Not financial advice, assumptions, scenario analysis, stress test, bear case, counterargument, residual uncertainty, and residual risk are recorded.
- Legal owner, regulatory owner, counsel qualified review, jurisdiction, compliance, securities, KYC, AML, and not legal advice boundary are recorded.
`;
}

function makeTempPlan({ state = "EXECUTE", planMarkdown = adversarialPlanMarkdown() } = {}) {
  const planDir = mkdtempSync(join(repoRoot, "plans", "plan_tmp_t12_tokenomics_"));
  const planDirName = basename(planDir);
  writeFileSync(join(planDir, "plan.md"), planMarkdown);
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state,
    goal: "T12 tokenomics runtime conformance fixture",
    plan_dir: planDirName,
    plan_shape: { primary: "planner-core", source: "t12_conformance_fixture" },
  }, null, 2) + "\n");
  return planDir;
}

function readPersonaFindings(planDir) {
  return JSON.parse(readFileSync(join(planDir, "persona_findings.json"), "utf-8"));
}

async function scenarioRuntimeGateLoadsTokenomics() {
  const planDir = makeTempPlan();
  try {
    const results = await runPersonaAuditGate(repoRoot, skillDir, planDir, "execute-to-reflect");
    const loaded = results.find((result) => result.name === "Persona packs loaded")?.detail || "";
    assert(loaded.includes("tokenomics"), "live persona gate loads tokenomics for a tokenomics-shaped planner-core plan", loaded);
    assert(results.some((result) => result.name === "Persona audit findings" && result.status === "FAIL"), "live persona gate blocks the adversarial tokenomics plan");

    const personaFindings = readPersonaFindings(planDir);
    const ids = (personaFindings.findings || []).map((finding) => finding._roleAudit?.id).filter(Boolean);
    assert(ids.includes("TK-005"), "runtime gate writes TK-005 guaranteed-ROI blocker");
    assert(ids.includes("TK-007"), "runtime gate writes TK-007 allocation arithmetic blocker");
    assert(ids.includes("TK-010"), "runtime gate writes TK-010 emissions-funded APY blocker");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function scenarioGeneratedPayloadSurfacesTokenomicsFindings() {
  const planDir = makeTempPlan();
  try {
    writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-06-04T00:00:00.000Z",
      gate: "execute-to-reflect",
      summary: { fail: 1, warn: 0, info: 0 },
      findings: [
        {
          analyzer: "[tokenomics] allocation_sum_invalid",
          severity: "fail",
          message: "Allocation percentages sum to 130%, not roughly 100%.",
          details: "Reconcile allocation buckets before launch readiness claims.",
          location: "tokenomics",
          count: 1,
          _roleAudit: {
            id: "TK-007",
            role: "tokenomics",
            severity: "CRITICAL",
            category: "allocation_sum_invalid",
            story_refs: ["US-011", "US-019"],
            evidence: "Allocation percentages sum to 130%, not roughly 100%.",
            recommendation: "Reconcile token allocation buckets before launch readiness claims.",
            meta: {
              tokenomics: {
                rule_id: "TK-007",
                invariant_id: "allocation_sum_invalid",
                prolog_rule: "tokenomics_violation/4",
              },
            },
          },
        },
      ],
    }, null, 2) + "\n");

    const payload = generateLiveGraphPayload({ repoRoot, planDir });
    const facts = payload.entities.ontology_facts || [];
    assert(facts.some((fact) => fact.type === "TokenomicsArithmeticGate" && fact.label === "allocation_sum_invalid"), "generated payload exposes tokenomics arithmetic ontology fact");
    assert((payload.invariant_violations || []).some((violation) => violation.id === "allocation_sum_invalid"), "generated payload exposes tokenomics invariant violation");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

console.log("\nTokenomics Capability Conformance Tests\n");
await scenarioRuntimeGateLoadsTokenomics();
scenarioGeneratedPayloadSurfacesTokenomicsFindings();

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
