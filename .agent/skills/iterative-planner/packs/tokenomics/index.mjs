// packs/tokenomics/index.mjs - Token economics persona auditor.
//
// This pack reviews tokenomics planning surfaces for missing economic
// contracts and deterministic arithmetic contradictions. It is advisory
// infrastructure, not financial or legal advice.

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { makeConstraint, makeFinding, SEVERITY } from "../../scripts/lib/audit_types.mjs";
import { createSession } from "../../scripts/lib/prolog.mjs";

const PACK_ID = "tokenomics";
const __filename = fileURLToPath(import.meta.url);
const PACK_DIR = dirname(__filename);
export const RULES_FILE = join(PACK_DIR, "rules.pl");

const RULE_DEFS = [
  {
    id: "TK-001",
    name: "Supply and emissions contract",
    rationale: "Tokenomics claims are not interpretable until supply, emissions, mint/burn authority, and allocation assumptions are explicit.",
    false_positive: "A project may only mention tokenomics as an out-of-scope future concern.",
    remediation: "Declare total/max/circulating supply assumptions, mint/burn authority, emissions/inflation schedule, and allocation buckets.",
    engine: "js",
  },
  {
    id: "TK-002",
    name: "Vesting and unlock pressure",
    rationale: "Vesting, cliffs, and unlock cadence determine whether incentives and liquidity claims are plausible.",
    false_positive: "The work may be pre-discovery and explicitly scoped to cataloging missing token data.",
    remediation: "Add vesting schedule, cliff/unlock cadence, and team/investor/community/liquidity allocation buckets.",
    engine: "js",
  },
  {
    id: "TK-003",
    name: "Incentive sustainability",
    rationale: "Rewards, staking, airdrops, and liquidity mining need a source of yield and abuse/reflexivity analysis.",
    false_positive: "The plan may be a pure contract-refactor with no incentive mechanism changes.",
    remediation: "State the incentive objective, source of yield/rewards, anti-abuse or Sybil controls, and reflexivity/sustainability risks.",
    engine: "js",
  },
  {
    id: "TK-004",
    name: "Liquidity, treasury, and governance authority",
    rationale: "Liquidity depth, treasury runway, and governance/admin authority are core risk surfaces for token projects.",
    false_positive: "The project may delegate these topics to a separate approved economic memo that is linked elsewhere.",
    remediation: "Document liquidity/LP assumptions, treasury runway or use of funds, governance/admin-key authority, and operational risk controls.",
    engine: "js",
  },
  {
    id: "TK-005",
    name: "Financial claim boundary",
    rationale: "Token price, ROI, APY, FDV, or valuation language can look like investment advice without assumptions and stress boundaries.",
    false_positive: "A plan may quote a third-party claim only to reject it.",
    remediation: "Mark outputs as not financial advice, include assumptions, scenario/sensitivity or stress analysis, strongest counterargument, and residual uncertainty. Guaranteed ROI/return claims must be removed or explicitly blocked for qualified review.",
    engine: "js",
  },
  {
    id: "TK-006",
    name: "Legal and regulatory review boundary",
    rationale: "Token launches and governance mechanisms can have jurisdiction-specific legal risk that the planner cannot resolve itself.",
    false_positive: "Internal research may explicitly state that legal/regulatory analysis is out of scope and blocked on counsel.",
    remediation: "Name the legal/regulatory owner or qualified-review boundary, relevant jurisdiction assumptions, and not-legal-advice wording.",
    engine: "js",
  },
  {
    id: "TK-007",
    name: "Allocation arithmetic",
    rationale: "Allocation buckets must reconcile to roughly 100 percent before supply or launch-readiness claims are trusted.",
    false_positive: "The plan may be comparing multiple scenarios and explicitly mark the shown buckets as partial.",
    remediation: "Reconcile allocation buckets so the declared distribution sums to approximately 100 percent, or mark it as a partial scenario.",
    engine: "prolog",
  },
  {
    id: "TK-008",
    name: "Supply ordering",
    rationale: "Circulating supply must not exceed total supply, and total supply must not exceed max supply.",
    false_positive: "The plan may use separate assets or wrapped-token units and clearly state they are not comparable.",
    remediation: "Correct circulating, total, and max supply units so circulating <= total <= max.",
    engine: "prolog",
  },
  {
    id: "TK-009",
    name: "FDV reconciliation",
    rationale: "Fully diluted valuation should reconcile to token price times max supply within declared tolerance.",
    false_positive: "The plan may quote a third-party FDV with a different price timestamp and label that source explicitly.",
    remediation: "Recompute FDV as token price multiplied by max supply, or explain the timestamp/source mismatch.",
    engine: "prolog",
  },
  {
    id: "TK-010",
    name: "Staking APY sustainability",
    rationale: "APY claims funded by scheduled emissions rather than modeled protocol revenue can create reflexive sell pressure.",
    false_positive: "A temporary bootstrap subsidy may be acceptable when explicitly capped, funded, and stress-tested.",
    remediation: "Reconcile staking APY against modeled protocol revenue plus scheduled emissions, and flag emissions-funded yield as a launch risk.",
    engine: "prolog",
  },
  {
    id: "TK-011",
    name: "Unlock cliff pressure",
    rationale: "Large cliff unlocks can dominate liquidity and incentive assumptions.",
    false_positive: "A large unlock may be locked in a non-transferable escrow with explicit controls.",
    remediation: "Reduce or phase large unlock cliffs, or document liquidity and sell-pressure controls.",
    engine: "prolog",
  },
  {
    id: "TK-012",
    name: "Governance/admin timelock",
    rationale: "Admin-key authority without a timelock leaves token supply, treasury, or governance controls unreviewable at launch speed.",
    false_positive: "Emergency-only authority may be acceptable when scope, multisig, timelock, and post-launch removal are explicit.",
    remediation: "Add timelock or equivalent governance delay for admin authority, or mark the launch as blocked pending qualified review.",
    engine: "prolog",
  },
];

const SCOPE_TERMS = [
  "tokenomics", "token economics", "token economy", "tokenlab", "token lab",
  "token launch", "token allocation", "token utility", "token supply",
  "circulating supply", "max supply", "total supply", "emissions",
  "inflation schedule", "vesting", "unlock", "cliff", "treasury",
  "liquidity mining", "staking rewards", "airdrop", "governance token",
  "dao governance", "token distribution", "fdv", "fully diluted valuation",
  "token holder", "token holders", "burn mechanism", "mint authority",
];

const PATH_TERMS = [
  "tokenomics", "tokenlab", "token-lab", "tokens", "vesting",
  "emissions", "treasury", "governance", "staking", "dao",
];

const SUPPLY_GROUPS = Object.freeze([
  Object.freeze({ key: "supply", terms: ["total supply", "max supply", "circulating supply", "supply cap", "token supply"] }),
  Object.freeze({ key: "emissions", terms: ["emissions", "inflation", "issuance", "release schedule", "emission schedule"] }),
  Object.freeze({ key: "authority", terms: ["mint", "mint authority", "burn", "burn mechanism", "supply authority", "admin authority"] }),
  Object.freeze({ key: "allocation", terms: ["allocation", "distribution", "team", "investor", "community", "ecosystem", "liquidity bucket"] }),
]);

const VESTING_GROUPS = Object.freeze([
  Object.freeze({ key: "vesting", terms: ["vesting", "vesting schedule"] }),
  Object.freeze({ key: "cliff", terms: ["cliff", "lockup", "lock-up"] }),
  Object.freeze({ key: "unlock", terms: ["unlock", "unlock schedule", "unlock cadence", "linear release"] }),
  Object.freeze({ key: "buckets", terms: ["team", "investor", "advisor", "community", "ecosystem", "liquidity"] }),
]);

const INCENTIVE_GROUPS = Object.freeze([
  Object.freeze({ key: "objective", terms: ["objective", "utility", "behavior", "incentive goal", "mechanism goal"] }),
  Object.freeze({ key: "yield_source", terms: ["yield source", "reward source", "revenue", "fees", "fee share", "treasury-funded", "subsidy"] }),
  Object.freeze({ key: "abuse", terms: ["sybil", "abuse", "anti-abuse", "gaming", "mercenary", "wash", "spam"] }),
  Object.freeze({ key: "reflexivity", terms: ["reflexivity", "sustainability", "death spiral", "sell pressure", "inflation pressure"] }),
]);

const LIQUIDITY_GROUPS = Object.freeze([
  Object.freeze({ key: "liquidity", terms: ["liquidity", "lp", "amm", "pool depth", "slippage", "market depth"] }),
  Object.freeze({ key: "treasury", terms: ["treasury", "runway", "use of funds", "reserves", "budget"] }),
  Object.freeze({ key: "governance", terms: ["governance", "dao", "voting", "admin key", "multisig", "delegation"] }),
  Object.freeze({ key: "risk_controls", terms: ["risk control", "pause", "timelock", "emergency", "guardian", "quorum"] }),
]);

const CLAIM_TERMS = [
  "price", "valuation", "fdv", "fully diluted valuation", "market cap",
  "roi", "return", "apy", "apr", "yield", "forecast", "projection",
  "upside", "investment", "investor return", "token value",
];

const CLAIM_BOUNDARY_GROUPS = Object.freeze([
  Object.freeze({ key: "not_financial_advice", terms: ["not financial advice", "not investment advice", "no investment advice"] }),
  Object.freeze({ key: "assumptions", terms: ["assumption", "assumptions", "depends on", "scenario"] }),
  Object.freeze({ key: "sensitivity", terms: ["sensitivity", "stress", "stress test", "scenario analysis", "downside"] }),
  Object.freeze({ key: "counterargument", terms: ["counterargument", "counter-argument", "bear case", "residual uncertainty", "residual risk"] }),
]);

const REGULATORY_GROUPS = Object.freeze([
  Object.freeze({ key: "owner", terms: ["legal owner", "regulatory owner", "counsel", "qualified review", "legal review"] }),
  Object.freeze({ key: "jurisdiction", terms: ["jurisdiction", "regulator", "securities", "compliance", "kyc", "aml"] }),
  Object.freeze({ key: "not_legal_advice", terms: ["not legal advice", "legal advice", "regulatory advice"] }),
]);

const EXPLORE_ACTIVE_RULES = new Set(["TK-005", "TK-006", "TK-007", "TK-008", "TK-009", "TK-010", "TK-011", "TK-012"]);
const AUDIT_TEXT_FILES = ["plan.md", "findings.md", "intent_contract.json", "state.md"];

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function textContainsAny(text, terms) {
  const haystack = normalizeText(text);
  return terms.some((term) => haystack.includes(normalizeText(term)));
}

function storyText(story) {
  return [
    story?.id || "",
    story?.title || "",
    story?.description || "",
    ...(Array.isArray(story?.postconditions) ? story.postconditions : []),
    ...(Array.isArray(story?.preconditions) ? story.preconditions : []),
    ...(Array.isArray(story?.tags) ? story.tags : []),
  ].join(" ");
}

function allRegistryStories(storyRegistry) {
  return [
    ...(Array.isArray(storyRegistry?.stories) ? storyRegistry.stories : []),
    ...(Array.isArray(storyRegistry?.infrastructure_stories) ? storyRegistry.infrastructure_stories : []),
  ];
}

function combinedRawContextText(context) {
  const stories = allRegistryStories(context?.storyRegistry);
  const planFiles = context?.planFiles || {};
  const selectedPlanFileText = AUDIT_TEXT_FILES
    .map((name) => planFiles[name])
    .filter(Boolean);
  return [
    ...(selectedPlanFileText.length > 0 ? selectedPlanFileText : Object.values(planFiles)),
    ...stories.map(storyText),
  ].join("\n");
}

function combinedContextText(context) {
  return normalizeText(combinedRawContextText(context));
}

function matchingStories(storyRegistry, terms) {
  return allRegistryStories(storyRegistry)
    .filter((story) => textContainsAny(storyText(story), terms))
    .map((story) => story.id)
    .filter(Boolean);
}

function countCoveredGroups(text, groups) {
  const covered = [];
  const missing = [];
  for (const group of groups) {
    if (textContainsAny(text, group.terms)) covered.push(group.key);
    else missing.push(group.key);
  }
  return { covered, missing };
}

function hasPathSignal(context) {
  const text = normalizeText(String(context?.cwd || ""));
  return PATH_TERMS.some((term) => text.includes(normalizeText(term)));
}

function hasScope(context, text = combinedContextText(context)) {
  if (textContainsAny(text, SCOPE_TERMS)) return true;
  return hasPathSignal(context);
}

function phaseAllowsFinding(ruleId, context) {
  const phase = normalizeText(context?.currentState || "");
  if (!phase) return true;
  if (["explore", "init"].includes(phase)) return EXPLORE_ACTIVE_RULES.has(ruleId);
  return true;
}

function numberFrom(value) {
  const cleaned = String(value || "").replace(/[$,\s_]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(line) {
  const match = String(line || "").match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  return match ? numberFrom(match[1]) : null;
}

function firstPercent(line) {
  const match = String(line || "").match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*%/);
  return match ? numberFrom(match[1]) : null;
}

function parseValueAfter(text, regex) {
  const match = String(text || "").match(regex);
  return match ? numberFrom(match[1]) : null;
}

function guaranteedRoiClaim(text) {
  const normalized = normalizeText(text);
  return /\bguaranteed\s+(roi|return|returns|upside|yield|apy|apr)\s*:/.test(normalized)
    || /\bguarante(?:e|ed|es|eing)\b.{0,80}\b(buyers?|holders?|investors?)\b.{0,80}\b(roi|return|returns|upside|yield|apy|apr|[0-9]+x)\b/.test(normalized)
    || /\bbuyers?\s+will\s+(receive|earn|get|make)\b.{0,80}\b(roi|return|returns|upside|yield|[0-9]+x)\b/.test(normalized);
}

function hasConcreteTokenomicsInput(input) {
  return input.allocation_sum_bps !== null
    || Object.values(input.supply || {}).some((value) => value !== null && value !== undefined)
    || input.fdv_diff_bps !== null
    || Object.values(input.apy_bps || {}).some((value) => value !== null && value !== undefined)
    || input.unlock_cliff_bps !== null
    || input.guaranteed_roi_claim;
}

function isImplementationMetaPlan(text, input) {
  if (hasConcreteTokenomicsInput(input)) return false;
  const normalized = normalizeText(text);
  return /\b(tokenomics pack|packs tokenomics|rules pl|tokenomics validator|persona pack|conformance suite|generated payload|runtime gate)\b/.test(normalized);
}

function parseTimelockHours(text) {
  const absent = /\b(no|without|missing)\s+timelock\b|\btimelock\s+(is\s+)?(absent|missing|not planned)\b/.test(normalizeText(text));
  if (absent) return null;
  const explicit = String(text || "").match(/\btimelock\b.{0,30}?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(hour|hours|hr|hrs)\b/i);
  if (explicit) return Math.round(numberFrom(explicit[1]) || 0);
  return textContainsAny(text, ["timelock"]) ? 1 : null;
}

export function extractTokenomicsInput(contextOrText) {
  const rawText = typeof contextOrText === "string" ? contextOrText : combinedRawContextText(contextOrText);
  const text = normalizeText(rawText);
  const lines = String(rawText || "").split(/\r?\n/);
  const allocationPercents = [];
  let promisedApy = null;
  let protocolRevenueApy = null;
  let scheduledEmissionsApy = null;
  let unlockCliffPercent = null;
  let yieldSourceEmissions = false;

  for (const line of lines) {
    const lower = normalizeText(line);
    if (/(allocation|distribution|bucket)/.test(lower)) {
      for (const match of String(line).matchAll(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*%/g)) {
        const value = numberFrom(match[1]);
        if (value !== null) allocationPercents.push(value);
      }
    }
    if (lower.includes("protocol revenue") && lower.includes("apy")) {
      protocolRevenueApy = firstPercent(line) ?? protocolRevenueApy;
    } else if ((lower.includes("scheduled emissions") || lower.includes("emissions schedule")) && lower.includes("apy")) {
      scheduledEmissionsApy = firstPercent(line) ?? scheduledEmissionsApy;
    } else if ((lower.includes("staking") || lower.includes("rewards")) && lower.includes("apy")) {
      promisedApy = firstPercent(line) ?? promisedApy;
    }

    if ((lower.includes("yield source") || lower.includes("reward source")) && /(emission|issuance|inflation|subsid)/.test(lower)) {
      yieldSourceEmissions = true;
    }
    if (lower.includes("cliff") && lower.includes("unlock")) {
      unlockCliffPercent = firstPercent(line) ?? unlockCliffPercent;
    }
  }

  const price = parseValueAfter(rawText, /\b(?:token\s+price|price)\s*:?\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const fdv = parseValueAfter(rawText, /\b(?:fdv|fully\s+diluted\s+valuation)\s*:?\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const maxSupply = parseValueAfter(rawText, /\bmax(?:imum)?\s+supply\s*:?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const totalSupply = parseValueAfter(rawText, /\btotal\s+supply\s*:?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const circulatingSupply = parseValueAfter(rawText, /\bcirculating\s+supply\s*:?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const fdvExpected = price !== null && maxSupply !== null ? price * maxSupply : null;
  const fdvDiffBps = fdvExpected && fdv !== null
    ? Math.round((Math.abs(fdv - fdvExpected) / Math.max(1, Math.abs(fdvExpected))) * 10000)
    : null;

  return {
    raw_text: rawText,
    normalized_text: text,
    allocation_sum_bps: allocationPercents.length > 0 ? Math.round(allocationPercents.reduce((sum, value) => sum + value, 0) * 100) : null,
    supply: {
      circulating: circulatingSupply,
      total: totalSupply,
      max: maxSupply,
    },
    price,
    fdv,
    fdv_expected: fdvExpected,
    fdv_diff_bps: fdvDiffBps,
    apy_bps: {
      promised: promisedApy !== null ? Math.round(promisedApy * 100) : null,
      protocol_revenue: protocolRevenueApy !== null ? Math.round(protocolRevenueApy * 100) : null,
      scheduled_emissions: scheduledEmissionsApy !== null ? Math.round(scheduledEmissionsApy * 100) : null,
    },
    yield_source_emissions: yieldSourceEmissions,
    unlock_cliff_bps: unlockCliffPercent !== null ? Math.round(unlockCliffPercent * 100) : null,
    admin_key: textContainsAny(text, ["admin key", "multisig", "governance authority", "mint authority"]),
    timelock_hours: parseTimelockHours(rawText),
    guaranteed_roi_claim: guaranteedRoiClaim(rawText),
  };
}

function prologFact(name, subject, ...args) {
  return `${name}(${subject}, ${args.join(", ")}).`;
}

export function collectTokenomicsPrologFacts(input, subject = "tokenomics_plan") {
  const facts = [];
  if (input.allocation_sum_bps !== null) facts.push(prologFact("tokenomics_allocation_sum_bps", subject, Math.round(input.allocation_sum_bps)));
  for (const [kind, value] of Object.entries(input.supply || {})) {
    if (value !== null && value !== undefined) facts.push(prologFact("tokenomics_supply", subject, kind, Math.round(value)));
  }
  if (input.fdv_diff_bps !== null) facts.push(prologFact("tokenomics_fdv_diff_bps", subject, Math.round(input.fdv_diff_bps)));
  for (const [kind, value] of Object.entries(input.apy_bps || {})) {
    if (value !== null && value !== undefined) facts.push(prologFact("tokenomics_apy_bps", subject, kind, Math.round(value)));
  }
  if (input.yield_source_emissions) facts.push(`tokenomics_yield_source(${subject}, scheduled_emissions).`);
  if (input.unlock_cliff_bps !== null) facts.push(prologFact("tokenomics_unlock_cliff_bps", subject, Math.round(input.unlock_cliff_bps)));
  if (input.admin_key) facts.push(prologFact("tokenomics_admin_key", subject, "true"));
  if (input.timelock_hours !== null && input.timelock_hours !== undefined) facts.push(prologFact("tokenomics_timelock_hours", subject, Math.round(input.timelock_hours)));
  if (input.guaranteed_roi_claim) facts.push(`tokenomics_guaranteed_roi_claim(${subject}).`);
  return facts;
}

function categoryForRule(ruleId, detail = "") {
  if (ruleId === "TK-007") return "allocation_sum_invalid";
  if (ruleId === "TK-008") return "supply_order_invalid";
  if (ruleId === "TK-009") return "fdv_mismatch";
  if (ruleId === "TK-010") return "emissions_funded_yield";
  if (ruleId === "TK-011") return "unlock_cliff_pressure";
  if (ruleId === "TK-012") return "governance_timelock_missing";
  if (ruleId === "TK-005" && String(detail).includes("guaranteed")) return "guaranteed_roi_claim";
  return "tokenomics_arithmetic";
}

function recommendationForRule(ruleId) {
  return RULE_DEFS.find((rule) => rule.id === ruleId)?.remediation || "Reconcile tokenomics assumptions before relying on launch-readiness claims.";
}

export function evaluateTokenomicsArithmetic(input, { storyRefs = [] } = {}) {
  if (!existsSync(RULES_FILE)) return [];
  const facts = collectTokenomicsPrologFacts(input);
  if (facts.length === 0) return [];

  const session = createSession();
  session.consultFile(RULES_FILE);
  session.consult(facts.join("\n"));
  const seen = new Set();
  return session.queryAll("tokenomics_violation(Rule, tokenomics_plan, Detail, Severity).")
    .map((row) => ({
      ruleId: row.Rule,
      category: categoryForRule(row.Rule, row.Detail),
      detail: String(row.Detail || `${row.Rule} tokenomics violation`),
      recommendation: recommendationForRule(row.Rule),
      severity: row.Severity || SEVERITY.CRITICAL,
      story_refs: storyRefs,
      prolog_rule: "tokenomics_violation/4",
    }))
    .filter((finding) => {
      const key = `${finding.ruleId}:${finding.category}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function analyze(context) {
  const rawText = combinedRawContextText(context);
  const text = normalizeText(rawText);
  const hasClaimLanguage = textContainsAny(text, CLAIM_TERMS);
  const storyRefs = matchingStories(context?.storyRegistry, SCOPE_TERMS);
  const tokenomicsInput = extractTokenomicsInput(rawText);
  return {
    text,
    rawText,
    supply: countCoveredGroups(text, SUPPLY_GROUPS),
    vesting: countCoveredGroups(text, VESTING_GROUPS),
    incentives: countCoveredGroups(text, INCENTIVE_GROUPS),
    liquidity: countCoveredGroups(text, LIQUIDITY_GROUPS),
    claims: countCoveredGroups(text, CLAIM_BOUNDARY_GROUPS),
    regulatory: countCoveredGroups(text, REGULATORY_GROUPS),
    hasClaimLanguage,
    guaranteedRoiClaim: tokenomicsInput.guaranteed_roi_claim,
    implementationMetaOnly: isImplementationMetaPlan(rawText, tokenomicsInput),
    arithmetic: evaluateTokenomicsArithmetic(tokenomicsInput, { storyRefs }),
    storyRefs,
  };
}

function incomplete(groups, minCovered, required = []) {
  return groups.covered.length < minCovered || required.some((key) => groups.missing.includes(key));
}

function makeRawFinding(ruleId, category, detail, recommendation, analysis, severity = SEVERITY.HIGH, missing = [], extra = {}) {
  return {
    ruleId,
    category,
    detail,
    recommendation,
    severity,
    story_refs: analysis.storyRefs,
    missing,
    ...extra,
  };
}

function findingsForAnalysis(analysis, context) {
  const findings = [];

  if (analysis.implementationMetaOnly) {
    return analysis.arithmetic.filter((finding) => phaseAllowsFinding(finding.ruleId, context));
  }

  if (incomplete(analysis.supply, 3, ["supply", "emissions"])) {
    findings.push(makeRawFinding(
      "TK-001",
      "supply_emissions",
      `Tokenomics scope is present, but the supply/emissions contract is incomplete (missing: ${analysis.supply.missing.join(", ")}).`,
      "Declare total/max/circulating supply assumptions, mint/burn authority, emissions or inflation schedule, and allocation buckets.",
      analysis,
      SEVERITY.HIGH,
      analysis.supply.missing
    ));
  }

  if (incomplete(analysis.vesting, 3, ["vesting", "unlock"])) {
    findings.push(makeRawFinding(
      "TK-002",
      "vesting_unlocks",
      `Tokenomics scope is present, but vesting/unlock pressure is incomplete (missing: ${analysis.vesting.missing.join(", ")}).`,
      "Add vesting schedule, cliffs or lockups, unlock cadence, and team/investor/community/liquidity allocation buckets.",
      analysis,
      SEVERITY.HIGH,
      analysis.vesting.missing
    ));
  }

  if (incomplete(analysis.incentives, 3, ["objective", "yield_source"])) {
    findings.push(makeRawFinding(
      "TK-003",
      "incentive_sustainability",
      `Tokenomics scope is present, but incentive sustainability is incomplete (missing: ${analysis.incentives.missing.join(", ")}).`,
      "State the incentive objective, source of yield/rewards, abuse or Sybil controls, and reflexivity/sustainability risks.",
      analysis,
      SEVERITY.HIGH,
      analysis.incentives.missing
    ));
  }

  if (incomplete(analysis.liquidity, 3, ["liquidity", "treasury", "governance"])) {
    findings.push(makeRawFinding(
      "TK-004",
      "liquidity_treasury_governance",
      `Tokenomics scope is present, but liquidity, treasury, and governance authority are incomplete (missing: ${analysis.liquidity.missing.join(", ")}).`,
      "Document liquidity/LP assumptions, treasury runway or use of funds, governance/admin authority, and operational risk controls.",
      analysis,
      SEVERITY.HIGH,
      analysis.liquidity.missing
    ));
  }

  if (analysis.guaranteedRoiClaim) {
    findings.push(makeRawFinding(
      "TK-005",
      "guaranteed_roi_claim",
      "Guaranteed ROI/return language is present; tokenomics outputs must not promise buyer returns.",
      "Remove guaranteed ROI/return language or block the launch claim pending qualified financial/legal review.",
      analysis,
      SEVERITY.CRITICAL,
      [],
      { prolog_rule: "tokenomics_violation/4" }
    ));
  } else if (analysis.hasClaimLanguage && incomplete(analysis.claims, 3, ["not_financial_advice", "assumptions"])) {
    findings.push(makeRawFinding(
      "TK-005",
      "financial_claim_boundary",
      `Financial claim language is present, but the claim boundary is incomplete (missing: ${analysis.claims.missing.join(", ")}).`,
      "Mark outputs as not financial or investment advice, include assumptions, scenario/sensitivity or stress analysis, strongest counterargument, and residual uncertainty.",
      analysis,
      SEVERITY.HIGH,
      analysis.claims.missing
    ));
  }

  if (incomplete(analysis.regulatory, 2, ["owner"])) {
    const phase = normalizeText(context?.currentState || "");
    findings.push(makeRawFinding(
      "TK-006",
      "legal_regulatory_boundary",
      `Tokenomics scope is present, but the legal/regulatory review boundary is incomplete (missing: ${analysis.regulatory.missing.join(", ")}).`,
      "Name the legal or regulatory owner, jurisdiction assumptions, and not-legal-advice boundary before relying on token launch or governance claims.",
      analysis,
      ["explore", "init"].includes(phase) ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      analysis.regulatory.missing
    ));
  }

  findings.push(...analysis.arithmetic);
  return findings.filter((finding) => phaseAllowsFinding(finding.ruleId, context));
}

function guidanceLines(lines) {
  return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

const tokenomicsPack = {
  id: PACK_ID,

  applies(context) {
    return hasScope(context);
  },

  rules() {
    return RULE_DEFS;
  },

  async audit(context) {
    if (!hasScope(context)) return [];
    return findingsForAnalysis(analyze(context), context);
  },

  getPhaseGuidance(phase, context) {
    if (!hasScope(context)) return null;
    const guidance = {
      explore: [
        "List tokenomics evidence before accepting the narrative: supply, emissions, allocation, vesting, liquidity, treasury, governance, and incentive assumptions.",
        "Separate descriptive tokenomics analysis from financial or legal advice; mark any live launch/investment decision as needing qualified review.",
        "Identify whether the work is discovery, mechanism design, simulation, contract implementation, governance process, or launch readiness.",
      ],
      plan: [
        "Plan must include a tokenomics contract: supply, emissions, allocation buckets, vesting/unlocks, incentive source, liquidity/treasury/governance authority, and legal/regulatory review boundary.",
        "Plans with ROI, APY, FDV, price, yield, valuation, or return language must include not-financial-advice wording, assumptions, sensitivity/stress coverage, strongest counterargument, and residual uncertainty.",
        "If token mechanisms affect code or contracts, include wiring proof for where tokenomics assumptions enter the implementation and how guardrails are tested.",
      ],
      execute: [
        "Keep economic assumptions explicit in code/config/docs; avoid embedding unexplained constants for rewards, vesting, emissions, treasury, or governance thresholds.",
        "Do not convert advisory economic text into investment, price, or legal claims while implementing.",
        "Preserve links between tokenomics findings, stories, tests, and any governance or treasury authority touched by the change.",
      ],
      reflect: [
        "Check whether the implemented output still matches the declared tokenomics contract or whether assumptions narrowed during execution.",
        "Record missing external inputs, counsel review, market-liquidity assumptions, and untested incentive/reflexivity risks as residual uncertainty.",
        "Downgrade claims when evidence is discovery-only, simulation-only, or missing qualified review.",
      ],
      validate: [
        "Validate the tokenomics contract against produced artifacts: supply/emissions, vesting/unlocks, incentives, liquidity/treasury/governance, and claim-boundary proof.",
        "Reject closeout if financial/legal language survived without explicit advisory boundaries and qualified-review ownership.",
      ],
    };
    const lines = guidance[String(phase || "").toLowerCase()];
    return lines ? guidanceLines(lines) : null;
  },

  getPlanConstraints(context) {
    if (!hasScope(context)) return [];
    const analysis = analyze(context);
    return findingsForAnalysis(analysis, context).map((finding) => makeConstraint({
      id: `${finding.ruleId.replace("TK-", "TK-C-")}`,
      role: PACK_ID,
      constraint: finding.recommendation,
      severity: finding.severity,
      rationale: RULE_DEFS.find((rule) => rule.id === finding.ruleId)?.rationale || "Tokenomics scope needs explicit assumptions before claims are trusted.",
      story_refs: finding.story_refs || [],
      meta: {
        tokenomics: {
          category: finding.category,
          prolog_rule: finding.prolog_rule || null,
        },
      },
    }));
  },

  normalizeFinding(raw) {
    const rule = RULE_DEFS.find((entry) => entry.id === raw.ruleId) || {};
    return makeFinding({
      id: raw.ruleId || "TK-UNKNOWN",
      role: PACK_ID,
      severity: raw.severity || SEVERITY.HIGH,
      category: raw.category || "tokenomics",
      story_refs: raw.story_refs || [],
      evidence: raw.detail || `${raw.ruleId || "TK"} tokenomics finding`,
      recommendation: raw.recommendation || rule.remediation || "Add the missing tokenomics assumptions and review boundaries.",
      meta: {
        tokenomics: {
          rule_id: raw.ruleId,
          missing_groups: raw.missing || [],
          false_positive: rule.false_positive,
          prolog_rule: raw.prolog_rule || null,
          invariant_id: raw.category || null,
          advisory_boundary: "Not financial or legal advice; live token launches and investment decisions require qualified review.",
        },
      },
    });
  },

  extractTokenomicsInput,
  collectTokenomicsPrologFacts,
  evaluateTokenomicsArithmetic,
};

export default tokenomicsPack;
