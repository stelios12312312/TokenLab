// persona_adaptation.mjs - project persona fit, usage, and safe adaptation.
//
// This is intentionally read-only by default. The only writer is
// applySafePersonaAdaptation(), and it only performs high-confidence additive
// audit.config.json updates.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import {
  summarizePersonaArtifacts,
} from "./persona_artifacts.mjs";
import {
  decideDomainProfileActivation,
  resolvePersonaAuthorityPlanContext,
} from "./persona_activation_authority.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillDir = resolve(__dirname, "..", "..");

export const BUILTIN_PERSONA_PACKS = Object.freeze([
  "quant",
  "quant_target",
  "tokenomics",
  "ux_ui",
  "wiring_auditor",
  "assumptions_challenger",
  "config_integrity",
  "traceability",
]);

const QUANT_FAMILY = new Set(["quant", "quant_target"]);
const PROBLEM_STATUSES = new Set([
  "underfit_high_confidence",
  "underfit_advisory",
  "unused",
  "overactive",
  "blocked_invalid_config",
]);

export const PERSONA_OBLIGATIONS_CONFIG_PATH = join(skillDir, "config", "persona_obligations.json");

const BUILTIN_DOMAIN_RULES = Object.freeze({
  quant: Object.freeze({
    profile: "quant",
    seed_roles: ["quant"],
    expected_companions: ["quant_target", "assumptions_challenger", "wiring_auditor", "traceability"],
    terms: [
      "quant", "model", "modeling", "modelling", "backtest", "backtesting",
      "portfolio", "alpha", "factor", "signal", "strategy", "optimizer",
      "optimization", "optuna", "trueskill", "true skill", "train/test",
      "calibration", "timeseries", "time series", "finance", "market",
    ],
    paths: [
      "model", "models", "backtest", "backtests", "strategy", "strategies",
      "quant", "portfolio", "optimizer", "trueskill",
    ],
    deps: ["pandas", "numpy", "scikit-learn", "sklearn", "statsmodels", "optuna", "xgboost", "lightgbm"],
  }),
  quant_betting: Object.freeze({
    profile: "quant_betting",
    seed_roles: ["quant"],
    expected_companions: ["quant_target", "assumptions_challenger", "wiring_auditor", "traceability"],
    terms: [
      "betting", "bet", "bets", "odds", "clv", "closing line value",
      "closing line", "sportsbook", "bookmaker", "market inefficiency",
      "market inefficiency model", "mim", "positive_return", "realized return",
      "excess return", "entry price", "reference price", "line movement",
      "t-24", "t-12", "t-6",
    ],
    paths: ["betting", "odds", "sportsbook", "wager", "markets", "ipbs"],
    deps: [],
  }),
  tokenomics: Object.freeze({
    profile: "tokenomics",
    seed_roles: ["tokenomics"],
    expected_companions: ["assumptions_challenger", "wiring_auditor", "traceability"],
    terms: [
      "tokenomics", "token economics", "token economy", "tokenlab", "token lab",
      "token launch", "token allocation", "token utility", "token supply",
      "circulating supply", "max supply", "total supply", "emissions",
      "inflation schedule", "vesting", "unlock", "cliff", "treasury",
      "liquidity mining", "staking rewards", "airdrop", "governance token",
      "dao governance", "token distribution", "fdv", "fully diluted valuation",
      "token holder", "token holders", "burn mechanism", "mint authority",
    ],
    paths: [
      "tokenomics", "tokenlab", "token-lab", "tokens", "vesting",
      "emissions", "treasury", "governance token", "staking", "dao governance",
    ],
    deps: [],
  }),
  automation: Object.freeze({
    profile: "automation",
    seed_roles: ["assumptions_challenger", "wiring_auditor"],
    expected_companions: [],
    terms: [
      "automation", "orchestration", "workflow", "runner", "recipe",
      "connector", "sync", "pipeline", "scheduler", "hook", "tool trace",
      "posttooluse", "mcp", "daemon",
    ],
    paths: ["automation", "workflow", "workflows", "recipes", "runner", "connectors", "hooks", "scripts"],
    deps: [],
  }),
  frontend: Object.freeze({
    profile: "frontend",
    seed_roles: ["ux_ui", "traceability"],
    expected_companions: [],
    terms: [
      "frontend", "user-facing", "ui", "ux", "component", "page",
      "layout", "browser", "responsive", "form", "button",
    ],
    paths: ["components", "pages", "app", "frontend", "ui", "views", "routes"],
    deps: ["react", "next", "vite", "vue", "svelte", "tailwind", "lucide-react"],
  }),
  planner_infra: Object.freeze({
    profile: "planner_infra",
    seed_roles: ["assumptions_challenger", "config_integrity", "traceability"],
    expected_companions: [],
    terms: [
      "planner", "iterative-planner", "audit.config", "persona", "migration",
      "bootstrap", "transition", "gate", "ontology", "invariant", "workflow",
      "story registry", "config integrity",
    ],
    paths: [
      ".agent/skills/iterative-planner", ".agent/workflows",
      "planner", "transition", "bootstrap", "migrate", "rule_engine",
    ],
    deps: [],
  }),
});

function normalizePersonaObligationRule(entry) {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  return Object.freeze({
    profile: id,
    seed_roles: unique(entry.seed_roles),
    expected_companions: unique(entry.expected_companions),
    terms: unique(entry.terms),
    paths: unique(entry.paths),
    deps: unique(entry.deps),
    obligations: unique(entry.obligations),
  });
}

function normalizePersonaObligationRules(value) {
  const entries = Array.isArray(value?.personas) ? value.personas : [];
  const rules = {};
  for (const entry of entries) {
    const rule = normalizePersonaObligationRule(entry);
    if (!rule || rules[rule.profile]) return null;
    rules[rule.profile] = rule;
  }
  return Object.keys(rules).length > 0 ? Object.freeze(rules) : null;
}

export function loadPersonaObligationRules(configPath = PERSONA_OBLIGATIONS_CONFIG_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return normalizePersonaObligationRules(parsed) || BUILTIN_DOMAIN_RULES;
  } catch {
    return BUILTIN_DOMAIN_RULES;
  }
}

export const DOMAIN_RULES = loadPersonaObligationRules();

const SERIOUS_SHAPES = new Set([
  "feature",
  "integration",
  "migration",
  "planner-core",
  "scientific",
  "bug-fix",
  "regression",
  "refactor",
  "unknown",
]);
const TRIVIAL_SHAPES = new Set(["chore", "docs", "analysis", "question"]);

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function unique(values) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function safeReadText(path, limit = 120_000) {
  try {
    const text = readFileSync(path, "utf-8");
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  }
}

function readJson(path) {
  if (!existsSync(path)) return { present: false, ok: false, value: null, error: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return { present: true, ok: true, value, error: null };
  } catch (error) {
    return { present: true, ok: false, value: null, error: error.message };
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
  for (const key of asArray(keys)) {
    const value = configValue(config, key);
    if (Array.isArray(value)) values.push(...value);
  }
  return unique(values.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean));
}

function configuredSuppressedDomainProfiles(auditConfig) {
  return configList(auditConfig?.config, [
    "suppressed_domain_profiles",
    "persona.suppressed_domain_profiles",
    "persona_adaptation.suppressed_domain_profiles",
  ]);
}

function containsAny(text, terms) {
  const haystack = lower(text);
  return terms.some((term) => haystack.includes(lower(term)));
}

function pathMatchesTerm(filepath, term) {
  const normalizedPath = lower(filepath).replace(/\\/g, "/");
  const normalizedTerm = lower(term).replace(/\\/g, "/");
  if (!normalizedTerm) return false;
  if (normalizedTerm.includes("/")) return normalizedPath.includes(normalizedTerm);
  const segments = normalizedPath.split("/");
  return segments.some((segment) => {
    const segmentName = segment.includes(".") ? segment.split(".").slice(0, -1).join(".") : segment;
    const normSegment = segmentName.replace(/[\/._\-\s]+/g, " ").trim();
    const normTerm = normalizedTerm.replace(/[\/._\-\s]+/g, " ").trim();
    if (normSegment === normTerm) return true;
    if (!normTerm.includes(" ")) {
      return normSegment.split(" ").includes(normTerm);
    }
    return normSegment.includes(normTerm);
  });
}

function containsAnyPath(filePathText, terms) {
  const paths = String(filePathText || "").split("\n").filter(Boolean);
  return paths.some((path) => terms.some((term) => pathMatchesTerm(path, term)));
}

function countTerms(text, terms) {
  const haystack = lower(text);
  return terms.filter((term) => haystack.includes(lower(term))).length;
}

function severityRank(confidence) {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  if (confidence === "low") return 1;
  return 0;
}

function confidenceFromFamilies(count, explicitConfigured = false) {
  if (explicitConfigured || count >= 2) return "high";
  if (count === 1) return "medium";
  return "low";
}

function mergeConfidence(values) {
  const best = values.reduce((acc, value) => Math.max(acc, severityRank(value)), 0);
  return best >= 3 ? "high" : best === 2 ? "medium" : "low";
}

function hasRole(roles, role) {
  return asArray(roles).includes(role);
}

export function auditConfigCandidates(projectRoot) {
  return [
    join(projectRoot, "audit.config.json"),
    join(projectRoot, ".agent", "audit.config.json"),
  ];
}

export function readAuditConfig(projectRoot) {
  for (const path of auditConfigCandidates(projectRoot)) {
    if (!existsSync(path)) continue;
    const parsed = readJson(path);
    if (!parsed.ok) {
      return {
        present: true,
        valid: false,
        path,
        config: null,
        configured_roles: [],
        error: parsed.error || "invalid_json",
      };
    }
    if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      return {
        present: true,
        valid: false,
        path,
        config: null,
        configured_roles: [],
        error: "audit.config.json must contain a JSON object",
      };
    }
    if (parsed.value.roles !== undefined && !Array.isArray(parsed.value.roles)) {
      return {
        present: true,
        valid: false,
        path,
        config: parsed.value,
        configured_roles: [],
        error: "audit.config.json roles must be an array",
      };
    }
    const roles = unique(Array.isArray(parsed.value.roles) ? parsed.value.roles : ["core"]);
    return {
      present: true,
      valid: true,
      path,
      config: parsed.value,
      configured_roles: roles.length > 0 ? roles : ["core"],
      error: null,
    };
  }
  return {
    present: false,
    valid: true,
    path: join(projectRoot, "audit.config.json"),
    config: null,
    configured_roles: ["core"],
    error: null,
  };
}

function plannerPackRoot(projectRoot) {
  const installed = join(projectRoot, ".agent", "skills", "iterative-planner", "packs");
  if (existsSync(installed)) return installed;
  return join(skillDir, "packs");
}

function availablePacks(projectRoot) {
  const root = plannerPackRoot(projectRoot);
  return BUILTIN_PERSONA_PACKS.filter((role) => existsSync(join(root, role, "index.mjs")));
}

function shouldSkipDir(name) {
  return new Set([
    ".git", "node_modules", ".agent", "plans", "reports", "dist", "build",
    ".next", "coverage", "__pycache__", ".venv", "venv", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".tox", "out", "tmp",
  ]).has(name);
}

function collectProjectFiles(projectRoot, limit = 1800) {
  const files = [];
  function walk(dir) {
    if (files.length >= limit) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const full = join(dir, entry.name);
      files.push(relative(projectRoot, full).replace(/\\/g, "/"));
    }
  }
  walk(projectRoot);
  return files;
}

function readDependencyText(projectRoot) {
  const names = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.cfg",
    "Pipfile",
    "Cargo.toml",
  ];
  return names.map((name) => safeReadText(join(projectRoot, name), 80_000)).join("\n");
}

function readStoryRegistryText(projectRoot) {
  const paths = [
    join(projectRoot, "reports", "user_story_audit", "story_registry.json"),
    join(projectRoot, ".agent", "reports", "user_story_audit", "story_registry.json"),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    return safeReadText(path, 180_000);
  }
  return "";
}

function readDiscoveryPolicyText(projectRoot) {
  return safeReadText(join(projectRoot, "planner.discovery.json"), 80_000);
}

function readRecentPlanText(planDir) {
  return [
    "state.json",
    "plan.md",
    "findings.md",
    "summary.md",
    "reflection.md",
    "verification.md",
  ].map((name) => safeReadText(join(planDir, name), 60_000)).join("\n");
}

function readRecentPlanSemanticText(planDir) {
  return [
    "plan.md",
    "findings.md",
    "summary.md",
    "reflection.md",
    "verification.md",
  ].map((name) => safeReadText(join(planDir, name), 60_000)).join("\n");
}

function readActivePlanAuthorityContext(projectRoot) {
  const pointerPath = join(projectRoot, "plans", ".current_plan");
  if (!existsSync(pointerPath)) return null;
  const planName = safeReadText(pointerPath, 2_000).trim();
  if (!planName) return null;
  const planDir = join(projectRoot, "plans", planName);
  if (!existsSync(planDir)) return null;
  const state = readJson(join(planDir, "state.json"));
  return resolvePersonaAuthorityPlanContext({
    cwd: projectRoot,
    planDir,
    stateJson: state.ok ? state.value : null,
    planContent: safeReadText(join(planDir, "plan.md"), 120_000),
  });
}

function recentPlanDirs(projectRoot, limit = 12) {
  const plansRoot = join(projectRoot, "plans");
  if (!existsSync(plansRoot)) return [];
  let entries = [];
  try {
    entries = readdirSync(plansRoot)
      .filter((name) => name.startsWith("plan_"))
      .map((name) => {
        const path = join(plansRoot, name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(path).mtimeMs; } catch { /* ignore */ }
        return { name, path, mtimeMs };
      });
  } catch {
    return [];
  }
  return entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.path);
}

function parsePlanShape(planDir, text) {
  const state = readJson(join(planDir, "state.json"));
  const primary = state.ok ? state.value?.plan_shape?.primary : null;
  if (typeof primary === "string" && primary.trim()) return primary.trim();
  const goal = lower(text);
  if (/question|explain|review|audit|inspect|summari[sz]e/.test(goal)) return "analysis";
  if (/chore|setting|schedule|budget|credential|content tweak/.test(goal)) return "chore";
  if (/migration|upgrade|migrate/.test(goal)) return "migration";
  if (/planner|transition|bootstrap|gate|migrate\.mjs/.test(goal)) return "planner-core";
  if (/model|quant|backtest|trueskill|odds|clv/.test(goal)) return "scientific";
  return "feature";
}

function looksTrivial(shape, text) {
  if (TRIVIAL_SHAPES.has(shape)) return true;
  const value = lower(text);
  return /^(what|why|how|when|where|who)\b/.test(value.trim()) ||
    /\b(docs?|documentation|readme|copy edit|typo)\b/.test(value);
}

function looksSerious(shape, text) {
  if (looksTrivial(shape, text)) return false;
  if (SERIOUS_SHAPES.has(shape)) return true;
  return /\b(implement|fix|migrate|refactor|model|workflow|integration|planner)\b/i.test(text);
}

function readPersonaJson(planDir, name) {
  const parsed = readJson(join(planDir, name));
  return parsed.ok ? parsed.value : null;
}

function planPersonaSummary(planDir) {
  return summarizePersonaArtifacts({
    guidanceDoc: readPersonaJson(planDir, "persona_guidance.json"),
    constraintsDoc: readPersonaJson(planDir, "persona_constraints.json"),
    findingsDoc: readPersonaJson(planDir, "persona_findings.json"),
  });
}

function countHighPersonaBlockers(summary) {
  const findings = summary?.findings?.severity_counts || {};
  const constraints = summary?.constraints?.severity_counts || {};
  return (findings.high || 0) + (findings.critical || 0) +
    (constraints.high || 0) + (constraints.critical || 0);
}

function analyzeUsage(projectRoot) {
  const dirs = recentPlanDirs(projectRoot);
  const result = {
    recent_serious_plans: 0,
    plans_with_persona_artifacts: 0,
    trivial_plans_with_persona_blockers: 0,
    serious_quant_model_plans: 0,
    serious_quant_model_plans_without_quant_family: 0,
    recent_plan_count: dirs.length,
  };

  for (const planDir of dirs) {
    const text = readRecentPlanText(planDir);
    const shape = parsePlanShape(planDir, text);
    const summary = planPersonaSummary(planDir);
    const packIds = new Set(summary.pack_ids || []);
    const highBlockers = countHighPersonaBlockers(summary);
    const quantText = containsAny(text, [
      "quant", "model", "backtest", "trueskill", "market inefficiency",
      "mim", "odds", "clv", "positive_return",
    ]);

    if (looksTrivial(shape, text)) {
      if (highBlockers > 0) result.trivial_plans_with_persona_blockers += 1;
      continue;
    }

    if (looksSerious(shape, text)) {
      result.recent_serious_plans += 1;
      if (summary.total_items > 0) result.plans_with_persona_artifacts += 1;
      if (quantText) {
        result.serious_quant_model_plans += 1;
        if (![...QUANT_FAMILY].some((role) => packIds.has(role))) {
          result.serious_quant_model_plans_without_quant_family += 1;
        }
      }
    }
  }

  return result;
}

function evidenceFamiliesForRule({ rule, projectName, filePathText, dependencyText, storyText, discoveryText, configuredRoles }) {
  const families = [];
  if (containsAny(projectName, rule.terms) || containsAny(projectName, rule.paths)) families.push("name");
  if (containsAnyPath(filePathText, rule.paths)) families.push("paths");
  if (containsAny(dependencyText, rule.deps) || countTerms(dependencyText, rule.terms) >= 2) families.push("dependencies");
  if (countTerms(storyText, rule.terms) >= 2) families.push("stories");
  if (countTerms(discoveryText, rule.terms) >= 2) families.push("discovery_policy");
  if (hasRole(configuredRoles, rule.profile)) families.push("configured_role");
  return unique(families);
}

function detectDomainProfiles(projectRoot, auditConfig) {
  const files = collectProjectFiles(projectRoot);
  const configuredRoles = auditConfig.configured_roles;
  const context = {
    projectName: basename(projectRoot),
    filePathText: files.join("\n"),
    dependencyText: readDependencyText(projectRoot),
    storyText: readStoryRegistryText(projectRoot),
    discoveryText: readDiscoveryPolicyText(projectRoot),
    configuredRoles,
  };

  const profiles = [];
  for (const rule of Object.values(DOMAIN_RULES)) {
    const families = evidenceFamiliesForRule({ rule, ...context });
    const explicitConfigured = hasRole(configuredRoles, rule.profile);
    if (!explicitConfigured && families.length === 1 && families[0] === "name") continue;
    const confidence = confidenceFromFamilies(families.length, explicitConfigured);
    if (confidence === "low" && families.length === 0) continue;
    profiles.push({
      profile: rule.profile,
      confidence,
      evidence_families: families,
      seed_roles: [...rule.seed_roles],
      expected_companions: [...rule.expected_companions],
    });
  }

  // Betting is a quant specialization; keep quant seed role implied even when
  // generic quant terms are sparse.
  const bettingProfile = profiles.find((entry) => entry.profile === "quant_betting");
  if (bettingProfile && !profiles.some((entry) => entry.profile === "quant")) {
    profiles.push({
      profile: "quant",
      confidence: bettingProfile.confidence,
      evidence_families: ["quant_betting_specialization"],
      seed_roles: ["quant"],
      expected_companions: [...DOMAIN_RULES.quant.expected_companions],
    });
  }

  return profiles.sort((a, b) =>
    severityRank(b.confidence) - severityRank(a.confidence) || a.profile.localeCompare(b.profile)
  );
}

function statusFor({ auditConfig, usage, recommendedSeedRoles, missingSeedRoles, highConfidenceMissingSeedRoles }) {
  if (!auditConfig.valid) return "blocked_invalid_config";
  if (usage.trivial_plans_with_persona_blockers >= 2) return "overactive";
  if (missingSeedRoles.length > 0) {
    return highConfidenceMissingSeedRoles.length > 0 ? "underfit_high_confidence" : "underfit_advisory";
  }
  if (usage.serious_quant_model_plans_without_quant_family > 0 &&
      !asArray(auditConfig.configured_roles).some((role) => QUANT_FAMILY.has(role))) {
    return "underfit_high_confidence";
  }
  if (
    recommendedSeedRoles.length > 0 &&
    usage.recent_serious_plans > 0 &&
    usage.plans_with_persona_artifacts === 0
  ) {
    return "unused";
  }
  return "satisfied";
}

function shellQuote(value) {
  const text = String(value || ".");
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

export function isProblematicPersonaStatus(status) {
  return PROBLEM_STATUSES.has(status);
}

export function inferPersonaAdaptation(projectPath = process.cwd(), opts = {}) {
  const projectRoot = resolve(projectPath || process.cwd());
  const auditConfig = readAuditConfig(projectRoot);
  const usage = analyzeUsage(projectRoot);
  const activeAuthorityContext = readActivePlanAuthorityContext(projectRoot);
  const forcePacks = auditConfig.config?.force_packs || [];
  const configuredSuppressedProfiles = auditConfig.valid ? configuredSuppressedDomainProfiles(auditConfig) : [];
  const configuredSuppressedProfileSet = new Set(configuredSuppressedProfiles);
  const profiles = auditConfig.valid ? detectDomainProfiles(projectRoot, auditConfig) : [];
  if (
    usage.serious_quant_model_plans_without_quant_family > 0 &&
    !profiles.some((entry) => entry.profile === "quant")
  ) {
    profiles.push({
      profile: "quant",
      confidence: "high",
      evidence_families: ["recent_serious_quant_plan_without_quant_family"],
      seed_roles: ["quant"],
      expected_companions: [...DOMAIN_RULES.quant.expected_companions],
    });
  }
  const highOrMediumProfilesRaw = profiles.filter((entry) => severityRank(entry.confidence) >= 2);
  const profileDecisions = highOrMediumProfilesRaw.map((entry) => ({
    ...entry,
    activation_authority: activeAuthorityContext
      ? decideDomainProfileActivation(entry.profile, {
          planShape: activeAuthorityContext.plan_shape,
          forcePacks,
          evidence: entry.evidence_families,
        })
      : null,
  }));
  const configSuppressedProfiles = profileDecisions
    .filter((entry) => configuredSuppressedProfileSet.has(entry.profile))
    .map((entry) => ({ ...entry, suppression_reason: "audit_config" }));
  const authoritySuppressedProfiles = activeAuthorityContext
    ? profileDecisions
        .filter((entry) => entry.activation_authority?.may_emit_guidance === false)
        .filter((entry) => !configuredSuppressedProfileSet.has(entry.profile))
    : [];
  const highOrMediumProfiles = profileDecisions.filter((entry) => {
    if (configuredSuppressedProfileSet.has(entry.profile)) return false;
    if (activeAuthorityContext && entry.activation_authority?.may_emit_guidance === false) return false;
    return true;
  });
  const suppressedProfiles = [...configSuppressedProfiles, ...authoritySuppressedProfiles];
  const highProfiles = highOrMediumProfiles.filter((entry) => severityRank(entry.confidence) >= 3);
  const recommendedSeedRoles = unique(highOrMediumProfiles.flatMap((entry) => entry.seed_roles));
  const highConfidenceSeedRoles = unique(highProfiles.flatMap((entry) => entry.seed_roles));
  const expectedCompanions = unique(highOrMediumProfiles.flatMap((entry) => entry.expected_companions));
  const configuredRoles = auditConfig.configured_roles;
  const missingSeedRoles = recommendedSeedRoles.filter((role) => !configuredRoles.includes(role));
  const highConfidenceMissingSeedRoles = highConfidenceSeedRoles.filter((role) => !configuredRoles.includes(role));
  const usageForStatus = activeAuthorityContext
    ? {
        ...usage,
        trivial_plans_with_persona_blockers: 0,
        recent_serious_plans: 0,
        plans_with_persona_artifacts: 0,
        serious_quant_model_plans_without_quant_family: 0,
      }
    : usage;
  const status = statusFor({ auditConfig, usage: usageForStatus, recommendedSeedRoles, missingSeedRoles, highConfidenceMissingSeedRoles });
  const confidence = auditConfig.valid
    ? mergeConfidence(highOrMediumProfiles.map((entry) => entry.confidence))
    : "low";
  const commandTarget = opts.commandTarget || (resolve(projectRoot) === resolve(process.cwd()) ? "." : projectRoot);
  const reasons = [];
  for (const profile of highOrMediumProfiles) {
    reasons.push(`${profile.profile}:${profile.confidence}:${profile.evidence_families.join("+") || "configured"}`);
  }
  if (!activeAuthorityContext && usage.recent_serious_plans > 0 && usage.plans_with_persona_artifacts === 0) reasons.push("recent_serious_plans_without_persona_artifacts");
  if (!activeAuthorityContext && usage.trivial_plans_with_persona_blockers > 0) reasons.push("trivial_plans_with_persona_blockers");
  if (!activeAuthorityContext && usage.serious_quant_model_plans_without_quant_family > 0) reasons.push("serious_quant_model_plans_without_quant_family");
  if (configSuppressedProfiles.length > 0) reasons.push(`suppressed_by_audit_config:${configSuppressedProfiles.map((entry) => entry.profile).join("+")}`);
  if (authoritySuppressedProfiles.length > 0) reasons.push(`suppressed_by_active_plan:${authoritySuppressedProfiles.map((entry) => entry.profile).join("+")}`);
  if (!auditConfig.valid) reasons.push(`invalid_audit_config:${auditConfig.error}`);
  const recommendedCommand = highConfidenceMissingSeedRoles.length > 0
    ? `node .agent/skills/iterative-planner/scripts/persona_adapt.mjs apply ${shellQuote(commandTarget)} --safe`
    : activeAuthorityContext
      ? "Review persona_authority.profile_decisions; no safe additive role change is currently authorized."
      : `node .agent/skills/iterative-planner/scripts/persona_adapt.mjs apply ${shellQuote(commandTarget)} --safe`;

  return {
    status,
    confidence,
    domain_profiles: unique(highOrMediumProfiles.map((entry) => entry.profile)),
    suppressed_domain_profiles: unique(suppressedProfiles.map((entry) => entry.profile)),
    configured_roles: configuredRoles,
    recommended_seed_roles: recommendedSeedRoles,
    expected_companions: expectedCompanions,
    usage: {
      recent_serious_plans: usage.recent_serious_plans,
      plans_with_persona_artifacts: usage.plans_with_persona_artifacts,
      trivial_plans_with_persona_blockers: usage.trivial_plans_with_persona_blockers,
    },
    recommended_command: recommendedCommand,
    path: projectRoot,
    audit_config_path: auditConfig.path,
    audit_config_present: auditConfig.present,
    audit_config_valid: auditConfig.valid,
    audit_config_error: auditConfig.error,
    available_roles: availablePacks(projectRoot),
    missing_seed_roles: missingSeedRoles,
    high_confidence_missing_seed_roles: highConfidenceMissingSeedRoles,
    safe_apply_roles: highConfidenceMissingSeedRoles,
    profiles: highOrMediumProfiles,
    persona_authority: activeAuthorityContext ? {
      version: "1.0.0",
      active_plan: {
        present: true,
        plan_dir_name: activeAuthorityContext.plan_dir ? basename(activeAuthorityContext.plan_dir) : null,
        state: readJson(activeAuthorityContext.plan_dir ? join(activeAuthorityContext.plan_dir, "state.json") : "").value?.state || null,
        plan_shape: activeAuthorityContext.plan_shape_primary,
      },
      profile_decisions: profileDecisions.map((entry) => entry.activation_authority).filter(Boolean),
    } : null,
    reasons,
  };
}

function defaultAuditConfig(missingRoles) {
  return {
    roles: unique(["core", ...missingRoles]),
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
  };
}

export function applySafePersonaAdaptation(projectPath = process.cwd(), opts = {}) {
  const projectRoot = resolve(projectPath || process.cwd());
  const report = inferPersonaAdaptation(projectRoot, opts);
  const result = {
    ...report,
    safe: true,
    write_status: "not_written",
    added_roles: [],
    auto_committee_added: false,
    auto_committee_explicit_false: false,
    reason: null,
  };

  if (report.status === "blocked_invalid_config" || !report.audit_config_valid) {
    result.write_status = "blocked_invalid_config";
    result.reason = report.audit_config_error || "invalid audit.config.json";
    return result;
  }
  if (report.confidence !== "high") {
    result.write_status = "not_high_confidence";
    result.reason = `confidence=${report.confidence}`;
    return result;
  }
  const safeApplyRoles = asArray(report.safe_apply_roles);
  if (safeApplyRoles.length === 0) {
    result.write_status = "no_missing_seed_roles";
    result.reason = "no high-confidence missing seed roles are eligible for safe apply";
    return result;
  }

  const auditRead = readAuditConfig(projectRoot);
  const configPath = auditRead.path || join(projectRoot, "audit.config.json");
  const config = auditRead.present ? { ...auditRead.config } : defaultAuditConfig(safeApplyRoles);
  const existingRoles = unique(Array.isArray(config.roles) ? config.roles : ["core"]);
  const nextRoles = unique([...existingRoles, ...safeApplyRoles]);
  const addedRoles = nextRoles.filter((role) => !existingRoles.includes(role));

  config.roles = nextRoles;
  if (config.auto_committee === false) {
    result.auto_committee_explicit_false = true;
  } else if (config.auto_committee === undefined) {
    config.auto_committee = true;
    result.auto_committee_added = true;
  }
  if (!auditRead.present && config.fail_on === undefined) {
    config.fail_on = ["HIGH", "CRITICAL"];
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  result.write_status = "written";
  result.added_roles = addedRoles;
  result.config_path = configPath;
  result.configured_roles = nextRoles;
  return result;
}

export function registryPathFromEnv() {
  const override = process.env.PLANNER_PROJECT_REGISTRY_PATH?.trim();
  return override ? resolve(override) : join(skillDir, "config", ".project_registry.json");
}

export function scanAllPersonaAdaptation(opts = {}) {
  const registryPath = opts.registryPath ? resolve(opts.registryPath) : registryPathFromEnv();
  const parsed = readJson(registryPath);
  const projects = parsed.ok && Array.isArray(parsed.value?.projects) ? parsed.value.projects : [];
  const reports = [];
  for (const project of projects) {
    if (!project?.path || !existsSync(project.path)) continue;
    reports.push(inferPersonaAdaptation(project.path, {
      commandTarget: project.path,
    }));
  }
  const statuses = {};
  for (const report of reports) statuses[report.status] = (statuses[report.status] || 0) + 1;
  return {
    generated_at: new Date().toISOString(),
    registry_path: registryPath,
    registry_present: parsed.present,
    registry_valid: parsed.ok,
    project_count: reports.length,
    statuses,
    projects: reports.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
