// packs/tokenomics/index.mjs - Token economics persona auditor.
//
// This pack reviews tokenomics planning surfaces for missing economic
// contracts. It is advisory infrastructure, not financial or legal advice.

import { makeConstraint, makeFinding, SEVERITY } from "../../scripts/lib/audit_types.mjs";

const PACK_ID = "tokenomics";

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
    remediation: "Mark outputs as not financial advice, include assumptions, scenario/sensitivity or stress analysis, strongest counterargument, and residual uncertainty.",
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

function combinedContextText(context) {
  const stories = allRegistryStories(context?.storyRegistry);
  return normalizeText([
    ...Object.values(context?.planFiles || {}),
    ...stories.map(storyText),
  ].join(" "));
}

function matchingStories(storyRegistry, terms) {
  return allRegistryStories(storyRegistry)
    .filter((story) => textContainsAny(storyText(story), terms))
    .map((story) => story.id)
    .filter(Boolean);
}

function roles(context) {
  return Array.isArray(context?.auditConfig?.roles) ? context.auditConfig.roles : [];
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
  if (roles(context).includes(PACK_ID)) return true;
  if (textContainsAny(text, SCOPE_TERMS)) return true;
  return hasPathSignal(context);
}

function phaseAllowsBlockingFindings(context) {
  const phase = normalizeText(context?.currentState || "");
  if (!phase) return true;
  return !["explore", "init"].includes(phase);
}

function analyze(context) {
  const text = combinedContextText(context);
  const hasClaimLanguage = textContainsAny(text, CLAIM_TERMS);
  return {
    text,
    supply: countCoveredGroups(text, SUPPLY_GROUPS),
    vesting: countCoveredGroups(text, VESTING_GROUPS),
    incentives: countCoveredGroups(text, INCENTIVE_GROUPS),
    liquidity: countCoveredGroups(text, LIQUIDITY_GROUPS),
    claims: countCoveredGroups(text, CLAIM_BOUNDARY_GROUPS),
    regulatory: countCoveredGroups(text, REGULATORY_GROUPS),
    hasClaimLanguage,
    storyRefs: matchingStories(context?.storyRegistry, SCOPE_TERMS),
  };
}

function incomplete(groups, minCovered, required = []) {
  return groups.covered.length < minCovered || required.some((key) => groups.missing.includes(key));
}

function makeRawFinding(ruleId, category, detail, recommendation, analysis, severity = SEVERITY.HIGH, missing = []) {
  return {
    ruleId,
    category,
    detail,
    recommendation,
    severity,
    story_refs: analysis.storyRefs,
    missing,
  };
}

function findingsForAnalysis(analysis) {
  const findings = [];

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

  if (analysis.hasClaimLanguage && incomplete(analysis.claims, 3, ["not_financial_advice", "assumptions"])) {
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
    findings.push(makeRawFinding(
      "TK-006",
      "legal_regulatory_boundary",
      `Tokenomics scope is present, but the legal/regulatory review boundary is incomplete (missing: ${analysis.regulatory.missing.join(", ")}).`,
      "Name the legal or regulatory owner, jurisdiction assumptions, and not-legal-advice boundary before relying on token launch or governance claims.",
      analysis,
      SEVERITY.MEDIUM,
      analysis.regulatory.missing
    ));
  }

  return findings;
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
    if (!hasScope(context) || !phaseAllowsBlockingFindings(context)) return [];
    return findingsForAnalysis(analyze(context));
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
    return findingsForAnalysis(analysis).map((finding) => makeConstraint({
      id: `${finding.ruleId.replace("TK-", "TK-C-")}`,
      role: PACK_ID,
      constraint: finding.recommendation,
      severity: finding.severity,
      rationale: RULE_DEFS.find((rule) => rule.id === finding.ruleId)?.rationale || "Tokenomics scope needs explicit assumptions before claims are trusted.",
      story_refs: finding.story_refs || [],
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
          advisory_boundary: "Not financial or legal advice; live token launches and investment decisions require qualified review.",
        },
      },
    });
  },
};

export default tokenomicsPack;
