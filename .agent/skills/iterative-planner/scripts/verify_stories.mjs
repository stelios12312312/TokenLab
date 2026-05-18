#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { extractAnnotations } from "../../story-verification/scripts/extract_annotations.mjs";
import { validateVerificationReport, writeVerificationReport } from "../../story-verification/scripts/report_generator.mjs";
import { verifyObligations } from "../../story-verification/scripts/verify_obligations.mjs";
import { verifyAdequacy, verifyCoverage } from "../../story-verification/scripts/verify_coverage.mjs";
import { normalizePlanDirName, resolvePlanTarget } from "./lib/plan_utils.mjs";
import { readEffectiveVerificationStrategy, VERIFICATION_STRATEGY_FILENAME } from "./lib/verification_strategy.mjs";

const __filename = fileURLToPath(import.meta.url);

const REGISTRY_RELATIVE_PATH = join("reports", "user_story_audit", "story_registry.json");
const REPORTS_RELATIVE_DIR = join("reports", "story_verification");
const SEVERITY_RANK = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};
const PLAN_STATUS_PRIORITY = {
  VERIFIED: 0,
  ORPHANED: 1,
  PARTIAL: 2,
  FAILED: 3,
};

function usage() {
  return [
    "verify_stories.mjs — Agent B read-only story verification",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/verify_stories.mjs --plan <plan_id> [--quiet] [--output <path>] [--fail-on-severity <HIGH|MEDIUM|LOW>]",
    "  node .agent/skills/iterative-planner/scripts/verify_stories.mjs --plan-from-head [--quiet] [--output <path>] [--fail-on-severity <HIGH|MEDIUM|LOW>]",
    "  node .agent/skills/iterative-planner/scripts/verify_stories.mjs --since <date> [--quiet] [--output <path>] [--fail-on-severity <HIGH|MEDIUM|LOW>]",
    "  node .agent/skills/iterative-planner/scripts/verify_stories.mjs --all [--skip-legacy] [--quiet] [--output <path>] [--fail-on-severity <HIGH|MEDIUM|LOW>]",
    "  node .agent/skills/iterative-planner/scripts/verify_stories.mjs --staged [--skip-legacy] [--quiet] [--output <path>] [--fail-on-severity <HIGH|MEDIUM|LOW>]",
    "  node .agent/skills/iterative-planner/scripts/verify_stories.mjs --check-report <path> [--quiet] [--fail-on-severity <HIGH|MEDIUM|LOW>]",
    "",
    "Notes:",
    "  - Agent B is advisory and read-only with respect to code and reports/user_story_audit/story_registry.json.",
    "  - verification_strategy.yaml is the required canonical plan input for plan selectors; report re-check mode only validates an existing report file.",
  ].join("\n");
}

function fail(message, status = 1) {
  return {
    ok: false,
    status,
    error: message,
  };
}

function exitUsage(message = null) {
  if (message) console.error(message);
  console.error(usage());
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    selector: null,
    plan: null,
    since: null,
    checkReport: null,
    quiet: false,
    output: null,
    failOnSeverity: null,
    skipLegacy: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, options };
    }
    if (arg === "--plan") {
      if (options.selector) exitUsage("Choose exactly one selector: --plan, --plan-from-head, --since, --all, --staged, or --check-report.");
      const plan = argv[index + 1];
      if (!plan || plan.startsWith("--")) exitUsage("--plan requires a plan id.");
      options.selector = "plan";
      options.plan = plan;
      index += 1;
      continue;
    }
    if (arg === "--plan-from-head") {
      if (options.selector) exitUsage("Choose exactly one selector: --plan, --plan-from-head, --since, --all, --staged, or --check-report.");
      options.selector = "plan-from-head";
      continue;
    }
    if (arg === "--since") {
      if (options.selector) exitUsage("Choose exactly one selector: --plan, --plan-from-head, --since, --all, --staged, or --check-report.");
      const since = argv[index + 1];
      if (!since || since.startsWith("--")) exitUsage("--since requires a date or relative window.");
      options.selector = "since";
      options.since = since;
      index += 1;
      continue;
    }
    if (arg === "--all") {
      if (options.selector) exitUsage("Choose exactly one selector: --plan, --plan-from-head, --since, --all, --staged, or --check-report.");
      options.selector = "all";
      continue;
    }
    if (arg === "--staged") {
      if (options.selector) exitUsage("Choose exactly one selector: --plan, --plan-from-head, --since, --all, --staged, or --check-report.");
      options.selector = "staged";
      continue;
    }
    if (arg === "--check-report") {
      if (options.selector) exitUsage("Choose exactly one selector: --plan, --plan-from-head, --since, --all, --staged, or --check-report.");
      const reportPath = argv[index + 1];
      if (!reportPath || reportPath.startsWith("--")) exitUsage("--check-report requires a report path.");
      options.selector = "check-report";
      options.checkReport = reportPath;
      index += 1;
      continue;
    }
    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (arg === "--skip-legacy") {
      options.skipLegacy = true;
      continue;
    }
    if (arg === "--output") {
      const output = argv[index + 1];
      if (!output || output.startsWith("--")) exitUsage("--output requires a filesystem path.");
      options.output = output;
      index += 1;
      continue;
    }
    if (arg === "--fail-on-severity") {
      const severity = String(argv[index + 1] || "").toUpperCase();
      if (!SEVERITY_RANK[severity]) exitUsage("--fail-on-severity must be one of HIGH, MEDIUM, LOW.");
      options.failOnSeverity = severity;
      index += 1;
      continue;
    }
    exitUsage(`Unknown argument: ${arg}`);
  }

  if (options.skipLegacy && !["all", "staged"].includes(options.selector)) {
    exitUsage("--skip-legacy is only supported with --all or --staged.");
  }

  return { help: false, options };
}

function parseSinceDate(rawValue, now = new Date()) {
  const text = String(rawValue || "").trim();
  if (!text) return null;

  const relativeMatch = text.match(/^(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)\s+ago$/i);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const multipliers = {
      minute: 60_000,
      minutes: 60_000,
      hour: 3_600_000,
      hours: 3_600_000,
      day: 86_400_000,
      days: 86_400_000,
      week: 604_800_000,
      weeks: 604_800_000,
    };
    const multiplier = multipliers[unit];
    if (!multiplier) return null;
    return new Date(now.getTime() - (amount * multiplier));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readRegistryDocument(projectRoot) {
  const registryPath = join(projectRoot, REGISTRY_RELATIVE_PATH);
  if (!existsSync(registryPath)) {
    throw new Error(`Missing canonical story registry at ${registryPath}`);
  }
  try {
    return {
      path: registryPath,
      document: JSON.parse(readFileSync(registryPath, "utf8")),
    };
  } catch (error) {
    throw new Error(`Unable to parse ${registryPath}: ${error.message}`);
  }
}

function listPlanIds(projectRoot) {
  const plansDir = join(projectRoot, "plans");
  if (!existsSync(plansDir)) return [];
  return readdirSync(plansDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
    .map((entry) => entry.name)
    .sort();
}

function resolvePlanFromHead(projectRoot) {
  const gitShow = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  if (gitShow.error) {
    throw new Error(`git show failed: ${gitShow.error.message}`);
  }
  if (gitShow.status !== 0) {
    const stderr = String(gitShow.stderr || "").trim();
    throw new Error(stderr || "git show --name-only --format= HEAD failed");
  }

  const planIds = new Set();
  for (const line of String(gitShow.stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.replace(/\\/g, "/").match(/(?:^|\/)plans\/(plan_[^/]+)(?:\/|$)/);
    if (match?.[1]) planIds.add(match[1]);
  }

  if (planIds.size === 1) return [...planIds][0];
  if (planIds.size > 1) {
    throw new Error(`HEAD touches multiple plan directories (${[...planIds].join(", ")}); rerun with --plan <plan_id>.`);
  }
  throw new Error("HEAD does not reference a plan directory; rerun with --plan <plan_id>.");
}

function resolvePlansFromStaged(projectRoot) {
  const gitDiff = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  if (gitDiff.error) {
    throw new Error(`git diff --cached failed: ${gitDiff.error.message}`);
  }
  if (gitDiff.status !== 0) {
    const stderr = String(gitDiff.stderr || "").trim();
    throw new Error(stderr || "git diff --cached --name-only failed");
  }

  const planIds = new Set();
  for (const line of String(gitDiff.stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.replace(/\\/g, "/").match(/(?:^|\/)plans\/(plan_[^/]+)(?:\/|$)/);
    if (match?.[1]) planIds.add(match[1]);
  }

  return [...planIds].sort();
}

function resolveStrategyTimestamp(strategyBundle) {
  const strategy = strategyBundle?.strategy;
  const candidate = strategy?.updated_at || strategy?.created_at;
  if (candidate && !Number.isNaN(new Date(candidate).getTime())) {
    return new Date(candidate);
  }
  try {
    return statSync(strategyBundle.strategyPath).mtime;
  } catch {
    return null;
  }
}

function resolvePlanObservedDate(planId, planDir) {
  const planIdMatch = String(planId || "").match(/^plan_(\d{4}-\d{2}-\d{2})(?:_|$)/);
  if (planIdMatch?.[1]) {
    return {
      date: planIdMatch[1],
      source: "plan_id",
    };
  }

  for (const candidate of [join(planDir, VERIFICATION_STRATEGY_FILENAME), join(planDir, "plan.md"), planDir]) {
    try {
      return {
        date: statSync(candidate).mtime.toISOString().slice(0, 10),
        source: "mtime",
      };
    } catch {
      // Best-effort fallback only.
    }
  }

  return {
    date: null,
    source: null,
  };
}

function loadStrategyBundle(projectRoot, rawPlan) {
  const plansDir = join(projectRoot, "plans");
  const normalizedPlan = normalizePlanDirName(rawPlan, plansDir);
  if (!normalizedPlan) {
    return {
      ok: false,
      planId: rawPlan,
      legacy: false,
      observed_date: null,
      errors: [`Plan not found: ${rawPlan}`],
    };
  }

  const planDir = join(plansDir, normalizedPlan);
  const observedDate = resolvePlanObservedDate(normalizedPlan, planDir);
  const strategyResult = readEffectiveVerificationStrategy({ cwd: projectRoot, planDir });
  if (!strategyResult.ok) {
    return {
      ok: false,
      planId: normalizedPlan,
      planDir,
      legacy: strategyResult.source === "markdown",
      observed_date: observedDate.date,
      observed_date_source: observedDate.source,
      errors: strategyResult.errors,
      source: strategyResult.source,
      warnings: strategyResult.warnings || [],
    };
  }

  if (strategyResult.source !== "yaml") {
    return {
      ok: false,
      planId: normalizedPlan,
      planDir,
      legacy: true,
      observed_date: observedDate.date,
      observed_date_source: observedDate.source,
      errors: [`verify-stories requires canonical ${VERIFICATION_STRATEGY_FILENAME} for ${normalizedPlan}`],
      source: strategyResult.source,
      warnings: strategyResult.warnings || [],
    };
  }

  return {
    ok: true,
    planId: normalizedPlan,
    planDir,
    legacy: false,
    strategyPath: strategyResult.path,
    strategyDocument: strategyResult.document,
    strategy: strategyResult.strategy,
    timestamp: resolveStrategyTimestamp({
      strategy: strategyResult.strategy,
      strategyPath: strategyResult.path,
    }),
    observed_date: observedDate.date,
    observed_date_source: observedDate.source,
    warnings: strategyResult.warnings || [],
  };
}

function resolveSelectedPlanIds(projectRoot, options) {
  if (options.selector === "plan") return [options.plan];
  if (options.selector === "plan-from-head") return [resolvePlanFromHead(projectRoot)];
  if (options.selector === "all") return listPlanIds(projectRoot);
  if (options.selector === "staged") return resolvePlansFromStaged(projectRoot);
  if (options.selector === "since") {
    const sinceDate = parseSinceDate(options.since);
    if (!sinceDate) {
      throw new Error(`Unable to parse --since value: ${options.since}`);
    }
    return listPlanIds(projectRoot).filter((planId) => {
      const bundle = loadStrategyBundle(projectRoot, planId);
      if (!bundle.ok) return false;
      return bundle.timestamp instanceof Date && bundle.timestamp.getTime() >= sinceDate.getTime();
    });
  }

  const plansDir = join(projectRoot, "plans");
  const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
  if (target.planDirName) return [target.planDirName];
  throw new Error("No target plan resolved. Pass --plan, --plan-from-head, --since, or --all.");
}

function collectRelevantStoryIds(strategyBundles) {
  const storyIds = new Set();
  for (const bundle of strategyBundles) {
    for (const criterion of Array.isArray(bundle?.strategy?.criteria) ? bundle.strategy.criteria : []) {
      const storyId = typeof criterion?.story_id === "string" ? criterion.story_id.trim() : "";
      if (storyId) storyIds.add(storyId);
    }
  }
  return storyIds;
}

function safeRelativePath(projectRoot, rawPath) {
  const text = String(rawPath || "").trim();
  if (!text || text === ".") return null;

  const globIndex = text.search(/[*?\[]/);
  const candidate = (globIndex >= 0 ? text.slice(0, globIndex) : text)
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  if (!candidate || candidate === ".") return null;

  const absolute = resolve(projectRoot, candidate);
  const relativePath = relative(projectRoot, absolute);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..")) return null;
  return { absolute, relativePath };
}

function annotationRootForPath(projectRoot, rawPath) {
  const safe = safeRelativePath(projectRoot, rawPath);
  if (!safe) return null;

  let rootAbsolute = safe.absolute;
  if (existsSync(rootAbsolute)) {
    try {
      const stats = statSync(rootAbsolute);
      if (stats.isFile()) rootAbsolute = dirname(rootAbsolute);
    } catch {
      rootAbsolute = extname(safe.relativePath) ? dirname(rootAbsolute) : rootAbsolute;
    }
  } else if (extname(safe.relativePath)) {
    rootAbsolute = dirname(rootAbsolute);
  }

  const rootRelative = relative(projectRoot, rootAbsolute);
  if (!rootRelative || rootRelative === "." || rootRelative.startsWith("..")) return null;
  return rootRelative;
}

function deriveAnnotationScanRoots(projectRoot, strategyBundles) {
  const roots = new Set(["src", "tests"]);

  for (const bundle of strategyBundles) {
    for (const criterion of Array.isArray(bundle?.strategy?.criteria) ? bundle.strategy.criteria : []) {
      const implementationFile = typeof criterion?.implementation?.file === "string" ? criterion.implementation.file : "";
      const implementationRoot = annotationRootForPath(projectRoot, implementationFile);
      if (implementationRoot) roots.add(implementationRoot);

      for (const test of Array.isArray(criterion?.tests) ? criterion.tests : []) {
        const testFile = typeof test?.file === "string" ? test.file : "";
        const testRoot = annotationRootForPath(projectRoot, testFile);
        if (testRoot) roots.add(testRoot);
      }
    }
  }

  return [...roots].sort();
}

function buildStoryPlanMap(strategyBundles) {
  const storyPlanMap = new Map();
  for (const bundle of strategyBundles) {
    for (const criterion of Array.isArray(bundle?.strategy?.criteria) ? bundle.strategy.criteria : []) {
      const storyId = typeof criterion?.story_id === "string" ? criterion.story_id.trim() : "";
      if (!storyId) continue;
      if (!storyPlanMap.has(storyId)) storyPlanMap.set(storyId, new Set());
      storyPlanMap.get(storyId).add(bundle.planId);
    }
  }
  return storyPlanMap;
}

function inferTestClassification({ name = "", file = "", type = null } = {}) {
  if (typeof type === "string" && type.trim()) return type.trim();
  const haystack = `${name} ${file}`.toLowerCase();
  if (haystack.includes("integration")) return "integration";
  if (haystack.includes("unit")) return "unit";
  if (haystack.includes("e2e")) return "e2e";
  if (haystack.includes("smoke")) return "smoke";
  return null;
}

function buildTestResults(projectRoot, annotations, strategyBundles) {
  const testSymbolMap = new Map();
  for (const record of Array.isArray(annotations?.records) ? annotations.records : []) {
    if (record.scope === "test" && record.symbol) {
      testSymbolMap.set(record.symbol, record);
    }
  }

  const results = {};
  for (const bundle of strategyBundles) {
    for (const criterion of Array.isArray(bundle?.strategy?.criteria) ? bundle.strategy.criteria : []) {
      for (const test of Array.isArray(criterion?.tests) ? criterion.tests : []) {
        if (!test?.name) continue;
        const declaredPath = typeof test.file === "string" && test.file.trim()
          ? resolve(projectRoot, test.file)
          : null;
        const existing = results[test.name] || {
          name: test.name,
          exists: false,
          passed: null,
          classification: inferTestClassification(test),
          changed_in_plan: false,
        };
        results[test.name] = {
          ...existing,
          exists: existing.exists || !!testSymbolMap.get(test.name) || !!(declaredPath && existsSync(declaredPath)),
          classification: existing.classification || inferTestClassification(test),
        };
      }
    }
  }

  return results;
}

function matchesImplementationFile(recordFile, criterionFile) {
  const recordPath = String(recordFile || "").replace(/\\/g, "/");
  const criterionPath = String(criterionFile || "").trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!criterionPath) return true;
  return recordPath === criterionPath
    || recordPath.endsWith(`/${criterionPath}`)
    || recordPath.startsWith(`${criterionPath}/`);
}

function matchCriterionRecords(criterion, annotations) {
  const criterionFile = typeof criterion?.implementation?.file === "string" ? criterion.implementation.file : null;
  const criterionStoryId = typeof criterion?.story_id === "string" ? criterion.story_id.trim() : "";
  return (annotations?.records || []).filter((record) => {
    const storyIds = Array.isArray(record?.tags?.story_id) ? record.tags.story_id : [];
    const storyMatch = criterionStoryId ? storyIds.includes(criterionStoryId) : true;
    const fileMatch = criterionFile ? matchesImplementationFile(record.file, criterionFile) : true;
    return storyMatch && fileMatch;
  });
}

function collectCoveredAcceptance(records) {
  const covered = new Map();
  for (const record of records) {
    for (const acceptance of Array.isArray(record?.tags?.accepts) ? record.tags.accepts : []) {
      if (!covered.has(acceptance)) {
        covered.set(acceptance, record);
      }
    }
  }
  return covered;
}

function buildAcceptanceStatus(criterion, records) {
  const expected = Array.isArray(criterion?.acceptance) ? criterion.acceptance : [];
  const covered = collectCoveredAcceptance(records);

  return expected.map((acceptance) => {
    const record = covered.get(acceptance);
    if (record) {
      return {
        criterion: acceptance,
        status: "verified",
        evidence: `${record.file}:${record.line}`,
      };
    }
    return {
      criterion: acceptance,
      status: records.length > 0 ? "not_verified" : "unknown",
      evidence: records.length > 0 ? "Missing matching @planner:accepts annotation" : "No matching annotation record",
    };
  });
}

function summarizeTestStatus(criterion, testResults) {
  const declared = Array.isArray(criterion?.tests) ? criterion.tests : [];
  const candidates = declared
    .map((test) => testResults[test?.name])
    .filter(Boolean);

  if (candidates.length === 0) {
    return { test_exists: false, test_passing: null };
  }

  const anyExists = candidates.some((candidate) => candidate.exists);
  const anyPassed = candidates.some((candidate) => candidate.passed === true);
  const anyFailed = candidates.some((candidate) => candidate.passed === false);

  return {
    test_exists: anyExists,
    test_passing: anyPassed ? true : anyFailed ? false : null,
  };
}

function determineCriterionStatus({ records, acceptanceMet, obligation }) {
  if (records.length === 0) return "FAILED";
  const allAcceptanceVerified = acceptanceMet.every((entry) => entry.status === "verified");
  const anyAcceptanceVerified = acceptanceMet.some((entry) => entry.status === "verified");

  if (obligation?.obligation_met === true && (acceptanceMet.length === 0 || allAcceptanceVerified)) {
    return "VERIFIED";
  }
  if (anyAcceptanceVerified || obligation?.obligation_met === true) {
    return "PARTIAL";
  }
  return "PARTIAL";
}

function obligationSeverity(obligationFinding) {
  const notes = String(obligationFinding?.obligation_notes || "").toLowerCase();
  if (!notes) return "MEDIUM";
  if (notes.includes("missing") || notes.includes("unsupported")) return "HIGH";
  if (notes.includes("not-run")) return "LOW";
  return "MEDIUM";
}

function mapCoverageFindingToGap(finding) {
  const typeMap = {
    ORPHANED_ANNOTATION: "ORPHANED_CODE",
    MISSING_IMPLEMENTATION: "ORPHANED_CODE",
    STALE_TEST_REFERENCE: "MISSING_TEST",
    INCOMPLETE_ACCEPTANCE: "STALE_ANNOTATION",
    STALE_RETIRED_ANNOTATION: "STALE_ANNOTATION",
  };
  return {
    type: typeMap[finding.type] || "OBLIGATION_MISMATCH",
    criterion_id: null,
    file: finding.file || null,
    description: finding.description,
    severity: finding.severity || "MEDIUM",
  };
}

function buildSyntheticCoverageFindings(coverageFindings, storyPlanMap) {
  return coverageFindings
    .filter((finding) => finding.type === "ORPHANED_ANNOTATION")
    .map((finding) => {
      const planIds = [...(storyPlanMap.get(finding.story_id) || [])].sort();
      return {
        criterion_id: `ORPHANED:${finding.story_id || "unknown"}`,
        status: "ORPHANED",
        annotation_found: finding.description,
        code_matches_declared: false,
        test_exists: false,
        test_passing: null,
        acceptance_met: [],
        obligation_met: false,
        obligation_notes: finding.description,
        plan_id: planIds.length === 1 ? planIds[0] : null,
        plan_ids: planIds.length > 1 ? planIds : undefined,
        story_id: finding.story_id || null,
      };
    });
}

function filterCoverageFindings(coverageFindings, storyIds) {
  if (storyIds.size === 0) return [];
  return coverageFindings.filter((finding) => storyIds.has(finding.story_id));
}

function shouldSkipLegacyBundles(options) {
  return options.selector === "all" || (options.selector === "staged" && options.skipLegacy === true);
}

function partitionStrategyBundles(bundles, options) {
  const canonicalBundles = [];
  const skippedLegacyBundles = [];
  const failedBundles = [];

  for (const bundle of bundles) {
    if (bundle.ok) {
      canonicalBundles.push(bundle);
      continue;
    }

    if (shouldSkipLegacyBundles(options) && bundle.legacy) {
      skippedLegacyBundles.push(bundle);
      continue;
    }

    failedBundles.push(bundle);
  }

  return { canonicalBundles, skippedLegacyBundles, failedBundles };
}

function summarizeLegacyDateRange(skippedLegacyBundles) {
  const dates = skippedLegacyBundles
    .map((bundle) => bundle.observed_date)
    .filter((value) => typeof value === "string" && value.trim())
    .sort();
  return {
    start: dates[0] || null,
    end: dates[dates.length - 1] || null,
  };
}

function buildLegacyWarning(skippedLegacyBundles, options) {
  if (skippedLegacyBundles.length === 0) return null;
  const range = summarizeLegacyDateRange(skippedLegacyBundles);
  const rangeLabel = range.start && range.end
    ? range.start === range.end
      ? range.start
      : `${range.start}..${range.end}`
    : "unknown date range";
  const mode = options.selector === "all" && !options.skipLegacy ? "default --all behavior" : "--skip-legacy";
  const suffix = skippedLegacyBundles.length === 1 ? "" : "s";
  return `Skipped ${skippedLegacyBundles.length} legacy plan${suffix} during ${mode} (${rangeLabel}); legacy markdown inputs remain transition-tolerated and do not block the aggregate report.`;
}

function classifyPlanStatus(findings, strategyBundles) {
  const planStatuses = new Map(strategyBundles.map((bundle) => [bundle.planId, "VERIFIED"]));

  for (const finding of findings) {
    const planIds = new Set();
    if (typeof finding?.plan_id === "string" && finding.plan_id.trim()) {
      planIds.add(finding.plan_id.trim());
    }
    for (const planId of Array.isArray(finding?.plan_ids) ? finding.plan_ids : []) {
      if (typeof planId === "string" && planId.trim()) planIds.add(planId.trim());
    }

    for (const planId of planIds) {
      if (!planStatuses.has(planId)) continue;
      const candidateStatus = finding.status === "FAILED"
        ? "FAILED"
        : finding.status === "PARTIAL"
          ? "PARTIAL"
          : finding.status === "ORPHANED"
            ? "ORPHANED"
            : null;
      if (!candidateStatus) continue;
      const currentStatus = planStatuses.get(planId) || "VERIFIED";
      if (PLAN_STATUS_PRIORITY[candidateStatus] > PLAN_STATUS_PRIORITY[currentStatus]) {
        planStatuses.set(planId, candidateStatus);
      }
    }
  }

  const plans = [...planStatuses.entries()]
    .map(([plan_id, status]) => ({ plan_id, status }))
    .sort((left, right) => left.plan_id.localeCompare(right.plan_id));

  return {
    total: plans.length,
    verified: plans.filter((plan) => plan.status === "VERIFIED").length,
    partial: plans.filter((plan) => plan.status === "PARTIAL").length,
    failed: plans.filter((plan) => plan.status === "FAILED").length,
    orphaned: plans.filter((plan) => plan.status === "ORPHANED").length,
    plans,
  };
}

function buildReportDocument({
  projectRoot,
  options,
  strategyBundles,
  annotations,
  coverageFindings,
  adequacyFindings = [],
  skippedLegacyBundles = [],
}) {
  const criteria = strategyBundles.flatMap((bundle) => Array.isArray(bundle?.strategy?.criteria) ? bundle.strategy.criteria : []);
  const storyPlanMap = buildStoryPlanMap(strategyBundles);
  const testResults = buildTestResults(projectRoot, annotations, strategyBundles);
  const obligationResult = verifyObligations({
    strategyDocument: {
      verification_strategy: {
        version: 1,
        criteria,
      },
    },
    annotations,
    testResults,
  });
  const obligationByCriterionId = new Map(obligationResult.findings.map((finding) => [finding.criterion_id, finding]));

  const findings = [];
  const gaps = coverageFindings.map((finding) => mapCoverageFindingToGap(finding));

  for (const criterion of criteria) {
    const records = matchCriterionRecords(criterion, annotations);
    const acceptanceMet = buildAcceptanceStatus(criterion, records);
    const obligation = obligationByCriterionId.get(criterion.id) || {
      obligation_met: false,
      obligation_notes: "Missing obligation evaluation",
    };
    const tests = summarizeTestStatus(criterion, testResults);

    findings.push({
      criterion_id: criterion.id,
      status: determineCriterionStatus({ records, acceptanceMet, obligation }),
      annotation_found: records[0]?.raw?.join("; ") || null,
      code_matches_declared: records.length > 0,
      test_exists: tests.test_exists,
      test_passing: tests.test_passing,
      acceptance_met: acceptanceMet,
      obligation_met: obligation.obligation_met,
      obligation_notes: obligation.obligation_notes,
      plan_id: strategyBundles.find((bundle) => bundle.strategy.criteria.includes(criterion))?.planId || null,
      story_id: criterion.story_id || null,
    });

    if (obligation.obligation_met !== true) {
      gaps.push({
        type: "OBLIGATION_MISMATCH",
        criterion_id: criterion.id,
        file: criterion?.implementation?.file || null,
        description: obligation.obligation_notes || `${criterion.id} failed its declared ${criterion.how_verified || "unknown"} obligation`,
        severity: obligationSeverity(obligation),
      });
    }
  }

  const syntheticCoverageFindings = buildSyntheticCoverageFindings(coverageFindings, storyPlanMap);
  findings.push(...syntheticCoverageFindings);

  const verified = findings.filter((finding) => finding.status === "VERIFIED").length;
  const partial = findings.filter((finding) => finding.status === "PARTIAL").length;
  const failed = findings.filter((finding) => finding.status === "FAILED").length;
  const orphaned = findings.filter((finding) => finding.status === "ORPHANED").length;
  const totalCriteria = criteria.length;
  const coveragePct = totalCriteria === 0 ? 100 : Number(((verified / totalCriteria) * 100).toFixed(2));

  const reportPlanId = options.selector === "staged"
    ? "batch:staged"
    : strategyBundles.length === 1
      ? strategyBundles[0].planId
      : options.selector === "since"
      ? `batch:since:${options.since}`
      : options.selector === "all"
        ? "batch:all"
        : `batch:${strategyBundles.map((bundle) => bundle.planId).join(",")}`;

  const strategySource = strategyBundles.length === 1
    ? relative(projectRoot, strategyBundles[0].strategyPath)
    : strategyBundles.length === 0
      ? "N/A — no selected canonical plans"
      : strategyBundles.map((bundle) => relative(projectRoot, bundle.strategyPath)).join(", ");
  const warnings = [];
  const legacyWarning = buildLegacyWarning(skippedLegacyBundles, options);
  if (legacyWarning) warnings.push(legacyWarning);
  if (strategyBundles.length === 0 && skippedLegacyBundles.length > 0) {
    warnings.push("No canonical verification_strategy.yaml plans matched the selector; the report is a transition-tolerant legacy skip summary only.");
  }
  const isBatchReport = ["all", "since", "staged"].includes(options.selector) || strategyBundles.length > 1 || skippedLegacyBundles.length > 0;
  const fleetSummary = isBatchReport
    ? {
      canonical_plans: classifyPlanStatus(findings, strategyBundles),
      legacy_plans: {
        skipped: skippedLegacyBundles.length,
        skip_mode: options.selector === "all" && !options.skipLegacy ? "default_all_mode" : skippedLegacyBundles.length > 0 ? "explicit_flag" : "none",
        date_range: summarizeLegacyDateRange(skippedLegacyBundles),
      },
    }
    : null;

  return {
    verification_report: {
      version: 1,
      plan_id: reportPlanId,
      verified_at: new Date().toISOString(),
      verified_by: "agent_b",
      strategy_source: strategySource,
      findings,
      summary: {
        total_criteria: totalCriteria,
        verified,
        partial,
        failed,
        orphaned,
        coverage_pct: coveragePct,
      },
      gaps,
      adequacy_findings: Array.isArray(adequacyFindings) ? adequacyFindings : [],
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(fleetSummary ? { fleet_summary: fleetSummary } : {}),
    },
  };
}

function sanitizeOutputStem(value) {
  return String(value || "story_verification")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "story_verification";
}

function defaultOutputPath(projectRoot, reportDocument) {
  const stem = sanitizeOutputStem(reportDocument?.verification_report?.plan_id);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(projectRoot, REPORTS_RELATIVE_DIR, `${stem}_${timestamp}.yaml`);
}

function shouldFailOnSeverity(gaps, threshold) {
  if (!threshold) return false;
  const minimumRank = SEVERITY_RANK[threshold];
  return gaps.some((gap) => SEVERITY_RANK[gap.severity] >= minimumRank);
}

function readReportDocument(reportPath) {
  if (!existsSync(reportPath)) {
    throw new Error(`Report not found: ${reportPath}`);
  }
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${reportPath}: ${error.message}`);
  }
}

function logCheckReportSummary({ reportPath, reportDocument, failOnSeverityTriggered, threshold, quiet }) {
  if (quiet) return;
  const report = reportDocument?.verification_report;
  console.log(`verify-stories: checked ${reportPath}`);
  console.log(`  plan: ${report?.plan_id}`);
  console.log(
    `  summary: verified=${report?.summary?.verified || 0}, partial=${report?.summary?.partial || 0}, failed=${report?.summary?.failed || 0}, orphaned=${report?.summary?.orphaned || 0}`
  );
  if (threshold) {
    console.log(`  threshold: ${threshold} ${failOnSeverityTriggered ? "triggered" : "clear"}`);
  }
}

function logSummary(result, quiet) {
  if (quiet) return;
  const report = result.reportDocument?.verification_report;
  console.log(`verify-stories: ${report?.plan_id}`);
  console.log(`  plans: ${result.strategyBundles.map((bundle) => bundle.planId).join(", ") || "(none)"}`);
  console.log(`  output: ${relative(result.projectRoot, result.outputPath)}`);
  console.log(
    `  summary: verified=${report?.summary?.verified || 0}, partial=${report?.summary?.partial || 0}, failed=${report?.summary?.failed || 0}, orphaned=${report?.summary?.orphaned || 0}`
  );
  if (report?.fleet_summary) {
    const canonical = report.fleet_summary.canonical_plans || {};
    const legacy = report.fleet_summary.legacy_plans || {};
    console.log(
      `  fleet: canonical verified=${canonical.verified || 0}, partial=${canonical.partial || 0}, failed=${canonical.failed || 0}, orphaned=${canonical.orphaned || 0}; legacy_skipped=${legacy.skipped || 0}`
    );
  }
  if (result.failOnSeverityTriggered) {
    console.log(`  threshold: ${result.options.failOnSeverity} triggered`);
  }
}

export function runVerifyStories(argv = process.argv.slice(2), projectRoot = process.cwd()) {
  const { help, options } = parseArgs(argv);
  if (help) {
    return { ok: true, status: 0, help: usage() };
  }

  if (options.selector === "check-report") {
    let reportDocument;
    try {
      reportDocument = readReportDocument(resolve(projectRoot, options.checkReport));
    } catch (error) {
      return fail(error.message, 1);
    }
    const validation = validateVerificationReport({ reportDocument });
    if (!validation.ok) {
      return fail(validation.errors.join("; "), 1);
    }
    const failOnSeverityTriggered = shouldFailOnSeverity(
      reportDocument?.verification_report?.gaps || [],
      options.failOnSeverity
    );
    const result = {
      ok: !failOnSeverityTriggered,
      status: failOnSeverityTriggered ? 1 : 0,
      projectRoot,
      options,
      reportDocument,
      reportPath: resolve(projectRoot, options.checkReport),
      failOnSeverityTriggered,
    };
    logCheckReportSummary({
      reportPath: relative(projectRoot, result.reportPath),
      reportDocument,
      failOnSeverityTriggered,
      threshold: options.failOnSeverity,
      quiet: options.quiet,
    });
    return result;
  }

  let selectedPlanIds;
  try {
    selectedPlanIds = resolveSelectedPlanIds(projectRoot, options);
  } catch (error) {
    return fail(error.message, 1);
  }

  if (selectedPlanIds.length === 0) {
    if (options.selector === "staged") {
      const reportDocument = buildReportDocument({
        projectRoot,
        options,
        strategyBundles: [],
        annotations: { records: [] },
        coverageFindings: [],
        adequacyFindings: [],
      });
      const outputPath = options.output
        ? resolve(projectRoot, options.output)
        : defaultOutputPath(projectRoot, reportDocument);
      reportDocument.verification_report.warnings = [
        "No staged plan directories matched; nothing to verify.",
      ];
      const writeResult = writeVerificationReport({
        projectRoot,
        reportDocument,
        outputPath,
        planId: reportDocument.verification_report.plan_id,
      });
      if (!writeResult.ok) {
        return fail((writeResult.errors || []).join("; "), 1);
      }
      const result = {
        ok: true,
        status: 0,
        projectRoot,
        options,
        strategyBundles: [],
        outputPath,
        reportDocument,
        failOnSeverityTriggered: false,
      };
      logSummary(result, options.quiet);
      return result;
    }
    return fail("No plans matched the requested selector.", 1);
  }

  const selectedBundles = selectedPlanIds.map((planId) => loadStrategyBundle(projectRoot, planId));
  const {
    canonicalBundles: strategyBundles,
    skippedLegacyBundles,
    failedBundles,
  } = partitionStrategyBundles(selectedBundles, options);
  if (failedBundles.length > 0) {
    return fail(
      failedBundles
        .map((bundle) => `${bundle.planId}: ${(bundle.errors || []).join("; ")}`)
        .join("\n"),
      1
    );
  }

  let registryRead;
  try {
    registryRead = readRegistryDocument(projectRoot);
  } catch (error) {
    return fail(error.message, 1);
  }

  const annotations = extractAnnotations({
    projectRoot,
    roots: deriveAnnotationScanRoots(projectRoot, strategyBundles),
  });
  const relevantStoryIds = collectRelevantStoryIds(strategyBundles);
  const coverageResult = verifyCoverage({
    registryDocument: registryRead.document,
    annotations,
  });
  const filteredCoverageFindings = filterCoverageFindings(
    coverageResult.findings,
    relevantStoryIds
  );
  const adequacyFindings = strategyBundles.flatMap((bundle) => verifyAdequacy({
    projectRoot,
    strategyDocument: bundle.strategyDocument,
  }).findings);

  const reportDocument = buildReportDocument({
    projectRoot,
    options,
    strategyBundles,
    annotations,
    coverageFindings: filteredCoverageFindings,
    adequacyFindings,
    skippedLegacyBundles,
  });

  const validation = validateVerificationReport({ reportDocument });
  if (!validation.ok) {
    return fail(validation.errors.join("; "), 1);
  }

  const outputPath = options.output
    ? resolve(projectRoot, options.output)
    : defaultOutputPath(projectRoot, reportDocument);

  const writeResult = writeVerificationReport({
    projectRoot,
    reportDocument,
    outputPath,
    planId: reportDocument.verification_report.plan_id,
  });
  if (!writeResult.ok) {
    return fail((writeResult.errors || []).join("; "), 1);
  }

  const failOnSeverityTriggered = shouldFailOnSeverity(
    reportDocument.verification_report.gaps,
    options.failOnSeverity
  );

  const result = {
    ok: !failOnSeverityTriggered,
    status: failOnSeverityTriggered ? 1 : 0,
    projectRoot,
    options,
    strategyBundles,
    skippedLegacyBundles,
    outputPath,
    reportDocument,
    failOnSeverityTriggered,
  };
  logSummary(result, options.quiet);
  return result;
}

if (resolve(process.argv[1] || "") === __filename) {
  const result = runVerifyStories(process.argv.slice(2), process.cwd());
  if (result.help) {
    console.log(result.help);
    process.exit(0);
  }
  if (!result.ok && result.error) {
    console.error(result.error);
  }
  process.exit(result.status || 0);
}
