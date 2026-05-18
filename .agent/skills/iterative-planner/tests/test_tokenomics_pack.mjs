#!/usr/bin/env node
// test_tokenomics_pack.mjs - Contract coverage for the tokenomics persona pack.

import { execFileSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

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

async function scenarioPackFindings() {
  const ctx = contextFor(`# Plan

TokenLab tokenomics roadmap: design staking rewards, liquidity mining,
airdrops, token allocation, APY, FDV projection, governance token utility,
and launch readiness.
`);
  assert(tokenomicsPack.applies(ctx), "tokenomics pack applies to TokenLab/tokenomics scope");
  const raw = await tokenomicsPack.audit(ctx);
  const normalized = raw.map((finding) => tokenomicsPack.normalizeFinding(finding));
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
await scenarioCompletePlanPasses();
scenarioListPacks();

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
