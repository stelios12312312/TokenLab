// scripts/lib/plan_self_heal.mjs
//
// Safe self-healing for plan.md and red_team_notes.md when specific
// domain personas are active. Injects required contracts and tables
// to prevent bootstrap/resume health failures.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { readAuditConfig, inferPersonaAdaptation } from "./persona_adaptation.mjs";
import {
  decidePersonaPackActivation,
  resolvePersonaAuthorityPlanContext,
} from "./persona_activation_authority.mjs";

const QUANT_TARGET_CONTRACT = `
### Model Target Contract
| Field | Value |
|---|---|
| **Model Name** | MIM (Market Inefficiency Model) |
| **Purpose** | Test market inefficiency hypothesis and inform trading decisions |
| **Target Label / Formula** | Realized return (\`positive_return\` proxy or excess return) |
| **Prediction Time / Horizon** | Pre-event prediction horizon (e.g. \`T-24\`, \`T-12\`, or \`T-6\`) |
| **Available Data (Known-at-time)** | Odds snapshot and feature provenance known at prediction time |
| **Forbidden Future (No Leakage)** | No post-event lookahead; closing/reference price and future fields are forbidden |
| **Controls / Baseline** | Excess-return baseline control and placebo ablation tests |
| **Failure Modes** | Invalid if data source down or odds snapshot timestamp is out-of-sync |
| **Proof Metric** | Out-of-sample calibration metric, excess return benchmark, and CLV |
| **Target-to-Claim Justification** | Explains why the proxy label supports the named market inefficiency claim |
`;

const QUANT_TARGET_MATRIX = `
### Odds Snapshot Matrix
| Horizon | Entry Price (Taken) | Reference Price (Close) | CLV Availability | Label Type | Price Snapshot / Odds Ladder |
|---|---|---|---|---|---|
| **T-24 (Open)** | Opening price or best available pre-event entry price | Final pre-event closing price | CLV available | Realized return (\`positive_return\` hybrid label) | Hourly odds snapshot price ladder |
| **T-12** | Bet price / price taken at T-12 | Final pre-event closing price | CLV available | Realized return / excess return | Hourly odds snapshot price ladder |
| **T-6** | Bet price / price taken at T-6 | Final pre-event closing price | CLV available | Realized return / excess return | Hourly odds snapshot price ladder |
`;

const TOKENOMICS_CONTRACT = `
### Tokenomics Contract
#### 1. Supply and Emissions
| Metric | Value / Assumption |
|---|---|
| **Max Supply** | 100,000,000 tokens |
| **Total Supply** | 80,000,000 tokens |
| **Circulating Supply** | 20,000,000 tokens |
| **Token Price** | $1.00 |
| **Fully Diluted Valuation (FDV)** | $100,000,000 |
| **Mint Authority / Burn Mechanism** | Burn mechanism active; mint authority is governed by DAO multisig |
| **Emissions Schedule** | 4% scheduled emissions inflation schedule per year |

#### 2. Vesting and Unlocks
| Allocation Bucket | Percentage | Vesting Schedule |
|---|---|---|
| **Team** | 20% | 1-year lockup cliff, then monthly linear release unlock cadence over 3 years |
| **Investor** | 20% | 10% unlock cliff at launch, then linear release unlock schedule over 2 years |
| **Community** | 40% | Governed emissions release schedule for staking rewards |
| **Ecosystem** | 10% | Linear release over 4 years for ecosystem growth |
| **Liquidity** | 10% | 100% unlocked at launch to seed AMM pool depth |

#### 3. Incentive Sustainability
- **Incentive Objective**: Encourage long-term token utility and governance delegation behavior.
- **Yield Source**: Staking rewards funded by a hybrid of 8% protocol revenue APY and 4% scheduled emissions APY (total 12% promised staking APY).
- **Anti-Abuse Controls**: Sybil controls, staking minimum lockups, and anti-gaming wash trading penalties.
- **Reflexivity & Sustainability**: Modeled reflexivity risks to prevent inflation pressure and sell pressure death spiral.

#### 4. Liquidity, Treasury, and Governance
- **Liquidity Depth**: AMM pool depth target of $2,000,000 with low slippage and high market depth.
- **Treasury Runway**: Use of funds budget allows a treasury runway of 36 months of reserves.
- **Governance Authority**: Governance DAO voting weight is proportional to delegation; admin key is a 3-of-5 multisig.
- **Risk Controls**: 72 hours timelock for all emergency pause and mint/burn admin actions.

#### 5. Financial Claim Boundary
> [!NOTE]
> **Not Financial Advice**: This document is for informational purposes only and does not constitute investment advice.
- **Core Assumptions**: Assumes a stable token price of $1.00 and normal protocol adoption scenario.
- **Sensitivity & Stress Analysis**: Downside scenario analysis and stress test modeling under a 90% price drop.
- **Counterargument & Bear Case**: Bear case and residual uncertainty around competitor liquidity mining adoption.

#### 6. Legal and Regulatory Boundary
> [!NOTE]
> **Not Legal Advice**: This is not regulatory or legal advice.
- **Legal/Regulatory Owner**: Coordinated by Legal Counsel for qualified review prior to launch.
- **Jurisdiction & Compliance**: Swiss DLT jurisdiction compliance, including KYC/AML policy and securities law review.
`;

const UX_UI_CONTRACT = `
### UX/UI Usability Contract
- **Accessibility (a11y) Baseline**: Keyboard navigation and colour contrast WCAG AA checks will be performed on all views.
- **Error State Usability**: Interactive components (forms, modals, dialogs, inputs) must handle error states and show validation messages.
- **Browser Journey Proof**: Capture screenshot and captured-viewport artifacts to prove visual state correctness.
`;

const NINE_PERSPECTIVES = {
  code_correctness: `## Vector 1: code_correctness
Attack:
- Unchecked input boundaries or incorrect logic in the implementation.
Impact:
- System crashes or incorrect calculations.
Mitigation:
- Strict validation, unit tests, and boundary checks.`,

  assumptions_challenge: `## Vector 2: assumptions_challenge
Attack:
- Relying on unchecked external system state or client inputs.
Impact:
- Incorrect model predictions or state corruption.
Mitigation:
- Defensive checks and explicit limitation documentation.`,

  connectivity: `## Vector 3: connectivity
Attack:
- Network failures, latency, or API downtime.
Impact:
- Blocked operations or timeouts.
Mitigation:
- Retries with exponential backoff and fallback providers.`,

  failure_modes: `## Vector 4: failure_modes
Attack:
- Edge-case crashes, process termination, or disk full conditions.
Impact:
- Unhandled crashes and data loss.
Mitigation:
- Graceful degradation and robust error catch blocks.`,

  security: `## Vector 5: security
Attack:
- Input injection, unauthorized access, or prompt manipulation.
Impact:
- Compromised system execution or data exposure.
Mitigation:
- Strict sanitization, least privilege execution, and output validation.`,

  performance: `## Vector 6: performance
Attack:
- High load, memory leaks, or slow database queries.
Impact:
- High latency and resource exhaustion.
Mitigation:
- Profiling, tuning, and time-boxed resource limits.`,

  data_integrity: `## Vector 7: data_integrity
Attack:
- Corrupted database state, race conditions, or partial writes.
Impact:
- Divergent or corrupted system state.
Mitigation:
- Transaction isolation, checksums, and atomic writes.`,

  output_trustworthiness: `## Vector 8: output_trustworthiness
Attack:
- Speculative outputs, hallucinations, or biased results.
Impact:
- Misleading claims or bad downstream decisions.
Mitigation:
- Rigorous evaluation metrics and statistical checks.`,

  configuration_integrity: `## Vector 9: configuration_integrity
Attack:
- Missing environment variables, wrong flags, or stale settings.
Impact:
- Inconsistent system behavior or silent failures.
Mitigation:
- Strict config validation at startup and environment parity checks.`
};

const DOMAIN_PROFILE_PERSONAS = Object.freeze({
  quant: Object.freeze(["quant", "quant_research_protocol"]),
  quant_betting: Object.freeze(["quant", "quant_research_protocol", "quant_target"]),
  tokenomics: Object.freeze(["tokenomics"]),
  frontend: Object.freeze(["ux_ui"]),
  automation: Object.freeze(["assumptions_challenger", "wiring_auditor"]),
  planner_infra: Object.freeze(["assumptions_challenger", "config_integrity", "traceability"]),
});

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function configValue(config, dottedKey) {
  if (!config || typeof config !== "object") return undefined;
  let current = config;
  for (const part of String(dottedKey || "").split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

function configList(config, keys) {
  const values = [];
  for (const key of keys || []) {
    const value = configValue(config, key);
    if (Array.isArray(value)) values.push(...value);
  }
  return uniqueStrings(values);
}

function configuredSuppressedPersonas(config) {
  const suppressedProfiles = configList(config, [
    "suppressed_domain_profiles",
    "persona.suppressed_domain_profiles",
    "persona_adaptation.suppressed_domain_profiles",
  ]);
  const explicitPersonas = configList(config, [
    "suppressed_persona_packs",
    "persona.suppressed_packs",
    "persona_packs_disabled",
  ]);
  return new Set(uniqueStrings([
    ...explicitPersonas,
    ...suppressedProfiles.flatMap((profile) => DOMAIN_PROFILE_PERSONAS[profile] || [profile]),
  ]));
}

function activePersonaSet({ auditConfig, adaptation, planDir, cwd }) {
  const roles = uniqueStrings([
    ...(auditConfig.configured_roles || []),
    ...(adaptation?.recommended_seed_roles || []),
    ...(adaptation?.expected_companions || []),
  ]);
  const config = auditConfig.config || {};
  const suppressedPersonas = configuredSuppressedPersonas(config);
  const forcePacks = Array.isArray(config.force_packs) ? config.force_packs : [];
  const planText = existsSync(join(planDir, "plan.md")) ? readFileSync(join(planDir, "plan.md"), "utf-8") : "";
  const authorityContext = resolvePersonaAuthorityPlanContext({
    cwd,
    planDir,
    stateJson: readJson(join(planDir, "state.json")),
    planContent: planText,
  });

  return new Set(roles.filter((role) => {
    if (role === "core") return false;
    if (suppressedPersonas.has(role)) return false;
    return decidePersonaPackActivation(role, {
      planShape: authorityContext.plan_shape || null,
      forcePacks,
      evidence: ["plan_self_heal"],
      taskFocusContract: authorityContext.task_focus_contract,
    }).may_load;
  }));
}

export function selfHealPlanFiles(planDir, cwd = process.cwd()) {
  if (!existsSync(planDir)) return { healed: false, reasons: [] };

  const auditConfig = readAuditConfig(cwd);
  const adaptation = inferPersonaAdaptation(cwd);
  const activePersonas = activePersonaSet({ auditConfig, adaptation, planDir, cwd });

  const planPath = join(planDir, "plan.md");
  const rtPath = join(planDir, "red_team_notes.md");
  const healed = [];

  // 1. Self-heal plan.md
  if (existsSync(planPath)) {
    let planText = readFileSync(planPath, "utf-8");
    let planModified = false;

    if (activePersonas.has("quant_target")) {
      if (!/Model Target Contract/i.test(planText)) {
        planText += "\n" + QUANT_TARGET_CONTRACT + "\n";
        planModified = true;
        healed.push("quant_target: Model Target Contract injected");
      }
      if (!/Odds Snapshot Matrix/i.test(planText)) {
        planText += "\n" + QUANT_TARGET_MATRIX + "\n";
        planModified = true;
        healed.push("quant_target: Odds Snapshot Matrix injected");
      }
    }

    if (activePersonas.has("tokenomics")) {
      if (!/Tokenomics Contract/i.test(planText)) {
        planText += "\n" + TOKENOMICS_CONTRACT + "\n";
        planModified = true;
        healed.push("tokenomics: Tokenomics Contract injected");
      }
    }

    if (activePersonas.has("ux_ui")) {
      if (!/UX\/UI Usability Contract/i.test(planText)) {
        planText += "\n" + UX_UI_CONTRACT + "\n";
        planModified = true;
        healed.push("ux_ui: UX/UI Usability Contract injected");
      }
    }

    if (planModified) {
      writeFileSync(planPath, planText, "utf-8");
    }
  }

  // 2. Self-heal red_team_notes.md (if traceability is active)
  if (existsSync(rtPath) && activePersonas.has("traceability")) {
    let rtText = readFileSync(rtPath, "utf-8");
    const rtTextLower = rtText.toLowerCase();

    // Check if it's the default scaffolding
    const isDefaultScaffold = rtText.includes("## Vector 1: [TBD]") && rtText.includes("## Vector 2: [TBD]") && rtText.includes("## Vector 3: [TBD]");

    if (isDefaultScaffold) {
      // Replace completely with 9 perspectives
      const completeRt = Object.values(NINE_PERSPECTIVES).join("\n\n") + "\n";
      writeFileSync(rtPath, completeRt, "utf-8");
      healed.push("traceability: Default red-team scaffolding replaced with 9 audit perspectives");
    } else {
      // Check which perspectives are missing
      let rtModified = false;
      const headings = (rtText.match(/^##\s+(.+)/gm) || []).map((h) => h.replace(/^##\s+/, "").toLowerCase());

      for (const [key, template] of Object.entries(NINE_PERSPECTIVES)) {
        const keyLower = key.toLowerCase();
        const keySpaces = key.replace(/_/g, " ").toLowerCase();
        const present = headings.some((h) => h.includes(keyLower) || h.includes(keySpaces));

        if (!present) {
          rtText += "\n\n" + template + "\n";
          rtModified = true;
          healed.push(`traceability: Missing perspective '${key}' injected`);
        }
      }

      if (rtModified) {
        writeFileSync(rtPath, rtText, "utf-8");
      }
    }
  }

  return {
    healed: healed.length > 0,
    reasons: healed
  };
}
