#!/usr/bin/env node
// test_tokenomics_pack.mjs - Contract coverage for the tokenomics persona pack.

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import tokenomicsPack from "../packs/tokenomics/index.mjs";

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

function contextFor(planText, extra = {}) {
  return {
    cwd: "/tmp/tokenlab",
    currentState: "plan",
    auditConfig: { roles: ["core", "tokenomics"], auto_committee: true },
    planFiles: { "plan.md": planText },
    storyRegistry: {
      version: 1,
      stories: [
        {
          id: "US-TK",
          title: "TokenLab tokenomics design",
          status: "FULLY_COVERED",
          postconditions: ["TokenLab tokenomics discovery has traceable review coverage"],
        },
      ],
    },
    ...extra,
  };
}

function adversarialPlanText() {
  return `# TokenLab Launch Plan

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

function normalizeFindings(raw) {
  return raw.map((finding) => tokenomicsPack.normalizeFinding(finding));
}

async function scenarioPackFindings() {
  const ctx = contextFor(`# Plan

TokenLab tokenomics roadmap: design staking rewards, liquidity mining,
airdrops, token allocation, APY, FDV projection, governance token utility,
and launch readiness.
`);
  assert(tokenomicsPack.applies(ctx), "tokenomics pack applies to TokenLab/tokenomics scope");
  const raw = await tokenomicsPack.audit(ctx);
  const normalized = normalizeFindings(raw);
  const ids = normalized.map((finding) => finding.id);
  assert(ids.includes("TK-001"), "tokenomics pack flags missing supply/emissions contract");
  assert(ids.includes("TK-002"), "tokenomics pack flags missing vesting/unlock contract");
  assert(ids.includes("TK-003"), "tokenomics pack flags missing incentive sustainability contract");
  assert(ids.includes("TK-004"), "tokenomics pack flags missing liquidity/treasury/governance contract");
  assert(ids.includes("TK-005"), "tokenomics pack flags financial claim boundary when APY/FDV language appears");
  assert(ids.includes("TK-006"), "tokenomics pack flags legal/regulatory review boundary");
  assert(normalized.every((finding) => finding.meta?.tokenomics?.advisory_boundary?.includes("Not financial or legal advice")), "tokenomics findings carry advisory boundary metadata");

  const constraints = tokenomicsPack.getPlanConstraints(ctx);
  assert(constraints.some((constraint) => constraint.id === "TK-C-001"), "tokenomics PLAN constraints mirror supply/emissions finding");
  assert(constraints.some((constraint) => constraint.severity === "MEDIUM" && constraint.id === "TK-C-006"), "legal/regulatory boundary is advisory-medium by default");
}

async function scenarioAdversarialArithmeticFailsInExplore() {
  const ctx = contextFor(adversarialPlanText(), { currentState: "explore" });
  assert(tokenomicsPack.applies(ctx), "tokenomics pack applies to adversarial tokenomics launch plan");
  const raw = await tokenomicsPack.audit(ctx);
  const normalized = normalizeFindings(raw);
  const ids = normalized.map((finding) => finding.id);
  for (const expected of ["TK-005", "TK-007", "TK-008", "TK-009", "TK-010", "TK-011", "TK-012"]) {
    assert(ids.includes(expected), `adversarial keyword-stuffed plan raises ${expected}`);
  }
  const blocking = normalized.filter((finding) => ["CRITICAL", "HIGH"].includes(finding.severity));
  assert(blocking.length >= 7, "adversarial arithmetic and claim findings are gate-blocking in EXPLORE");
  assert(normalized.some((finding) => finding.meta?.tokenomics?.prolog_rule === "tokenomics_violation/4"), "arithmetic findings identify tokenomics_violation/4 provenance");
}

function scenarioTokenomicsPrologRules() {
  const rulesPath = resolve(testDir, "../packs/tokenomics/rules.pl");
  const rulesExist = existsSync(rulesPath);
  assert(rulesExist, "tokenomics Prolog rules.pl exists");
  if (!rulesExist) return;

  const rulesText = readFileSync(rulesPath, "utf-8");
  assert(rulesText.includes("tokenomics_violation"), "rules.pl defines tokenomics_violation/4");
  assert(rulesText.includes("invariant_violated"), "rules.pl defines invariant_violated/2 bridge");

  const session = createSession();
  session.consultFile(rulesPath);
  session.consult(`
tokenomics_allocation_sum_bps(tbad, 13000).
tokenomics_supply(tbad, circulating, 1300000).
tokenomics_supply(tbad, total, 1200000).
tokenomics_supply(tbad, max, 1000000).
tokenomics_fdv_diff_bps(tbad, 2500).
tokenomics_apy_bps(tbad, promised, 4500).
tokenomics_apy_bps(tbad, protocol_revenue, 500).
tokenomics_apy_bps(tbad, scheduled_emissions, 3500).
tokenomics_unlock_cliff_bps(tbad, 4000).
tokenomics_admin_key(tbad, true).
tokenomics_guaranteed_roi_claim(tbad).
`);
  const violations = session.queryAll("tokenomics_violation(Rule, tbad, Detail, Severity).");
  const ruleIds = violations.map((row) => row.Rule);
  for (const expected of ["TK-007", "TK-008", "TK-009", "TK-010", "TK-011", "TK-012", "TK-005"]) {
    assert(ruleIds.includes(expected), `rules.pl emits ${expected} for invalid facts`);
  }
  assert(session.check("invariant_violated(tokenomics_arithmetic_invalid, tbad)."), "rules.pl raises invariant_violated/2 for invalid tokenomics arithmetic");
}

async function scenarioCompletePlanPasses() {
  const ctx = contextFor(`# Plan

TokenLab tokenomics contract:
- Total supply, max supply, circulating supply, mint authority, burn mechanism.
- Emissions schedule, inflation assumptions, allocation distribution across team, investor, community, ecosystem, and liquidity buckets.
- Vesting schedule with cliff, lockup, unlock schedule, unlock cadence, and linear release assumptions.
- Incentive objective and token utility with fee revenue as yield source, anti-abuse and Sybil controls, and reflexivity/sustainability risk.
- Liquidity pool depth, LP assumptions, treasury runway, reserves, governance DAO voting, multisig admin key, timelock, quorum, pause and emergency controls.
- FDV and APY discussion is not financial advice or investment advice; assumptions, scenario analysis, stress test, sensitivity, bear case, counterargument, residual uncertainty, and residual risk are recorded.
- Legal owner, regulatory owner, counsel qualified review, jurisdiction, compliance, securities, KYC, AML, and not legal advice boundary are recorded.
`);
  const raw = await tokenomicsPack.audit(ctx);
  assert(raw.length === 0, "complete tokenomics contract produces no findings");
  assert(tokenomicsPack.getPlanConstraints(ctx).length === 0, "complete tokenomics contract produces no PLAN constraints");
}

function scenarioListPacks() {
  const stdout = execFileSync(NODE, [resolve(scriptDir, "audit_runner.mjs"), "--list-packs"], {
    cwd: resolve(testDir, "../../../.."),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert(stdout.includes("tokenomics"), "audit_runner --list-packs includes tokenomics");
}

console.log("\nTokenomics Persona Pack Tests\n");
await scenarioPackFindings();
await scenarioAdversarialArithmeticFailsInExplore();
scenarioTokenomicsPrologRules();
await scenarioCompletePlanPasses();
scenarioListPacks();

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
