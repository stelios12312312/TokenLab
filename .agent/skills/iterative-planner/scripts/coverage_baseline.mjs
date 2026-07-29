#!/usr/bin/env node
// coverage_baseline.mjs — report-only c8 measurement and modified-script ratchet.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { emitJson } from "./lib/emit_json.mjs";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(__filename);
const SKILL_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");
const DEFAULT_BASELINE = join(SKILL_DIR, "config", "coverage_baseline.json");
const C8_BIN = join(SKILL_DIR, "node_modules", ".bin", process.platform === "win32" ? "c8.cmd" : "c8");
const METRICS = Object.freeze(["lines", "branches", "functions", "statements"]);
const COVERAGE_WORKLOAD_EXCLUSIONS = Object.freeze([
  "cli-determinism",
  "planner-core-coverage-ratchet",
]);
const COVERAGE_PROFILE_ID = "core-release";
const COVERAGE_SUITE_TIMEOUT_MS = 900_000;
const COVERAGE_RUN_TIMEOUT_MS = 1_200_000;
const COVERAGE_WORKLOAD = "governed core-release IVE profile except cli-determinism and planner-core-coverage-ratchet; 900000ms per-suite instrumentation timeout";

export const COVERAGE_TARGETS = Object.freeze([
  ".agent/skills/iterative-planner/scripts/transition.mjs",
  ".agent/skills/iterative-planner/scripts/bootstrap.mjs",
  ".agent/skills/iterative-planner/scripts/migrate.mjs",
  ".agent/skills/iterative-planner/scripts/rule_engine.mjs",
  ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
  ".agent/skills/iterative-planner/scripts/ontology_serializer.mjs",
  ".agent/skills/iterative-planner/scripts/lib/fact_loader.mjs",
  ".agent/skills/iterative-planner/scripts/story_registry.mjs",
  ".agent/skills/iterative-planner/scripts/ripple_check.mjs",
  ".agent/skills/iterative-planner/scripts/program_manager.mjs",
  ".agent/skills/iterative-planner/scripts/task_intake.mjs",
  ".agent/skills/iterative-planner/scripts/project_health.mjs",
  ".agent/skills/iterative-planner/scripts/escalation_check.mjs",
  ".agent/skills/iterative-planner/scripts/pre_commit_policy.mjs",
  ".agent/skills/iterative-planner/scripts/lib/plan_refresh.mjs",
  ".agent/skills/iterative-planner/scripts/lib/evidence_preflight.mjs",
  ".agent/skills/iterative-planner/scripts/lib/preplanning_scaffolding.mjs",
  ".agent/skills/iterative-planner/scripts/lib/lifecycle_reconciler.mjs",
  ".agent/skills/iterative-planner/scripts/lib/verification_truth.mjs",
  ".agent/skills/iterative-planner/scripts/lib/verification_obligations.mjs",
]);

export async function resolveCoverageWorkloadSuiteIds({
  profileId = COVERAGE_PROFILE_ID,
} = {}) {
  const {
    DEFAULT_SUITES,
    resolveReleaseProfile,
  } = await import("../tests/ive/run.mjs");
  const suites = DEFAULT_SUITES;
  const profile = resolveReleaseProfile({ profileId, suites });
  const excluded = new Set(COVERAGE_WORKLOAD_EXCLUSIONS);
  const suiteIds = profile.selected_suite_ids.filter((id) => !excluded.has(id));
  if (suiteIds.length === 0) {
    throw new Error(`IVE release profile ${profileId} returned no coverage workload suites`);
  }
  return suiteIds;
}

function normalizePath(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sourceHash(repoRoot, repoPath) {
  return sha256(readFileSync(join(repoRoot, normalizePath(repoPath))));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function metricShape(metric) {
  return {
    total: Number(metric?.total || 0),
    covered: Number(metric?.covered || 0),
    skipped: Number(metric?.skipped || 0),
    pct: Number(metric?.pct || 0),
  };
}

function summarizeIstanbulFile(fileCoverage) {
  const statementMap = fileCoverage?.statementMap || {};
  const statementHits = fileCoverage?.s || {};
  const functionMap = fileCoverage?.fnMap || {};
  const functionHits = fileCoverage?.f || {};
  const branchMap = fileCoverage?.branchMap || {};
  const branchHits = fileCoverage?.b || {};

  const statementKeys = Object.keys(statementMap);
  const functionKeys = Object.keys(functionMap);
  const branchValues = Object.values(branchHits).flat();
  const lines = new Map();
  for (const key of statementKeys) {
    const line = Number(statementMap[key]?.start?.line || 0);
    if (!line) continue;
    const hit = Number(statementHits[key] || 0);
    lines.set(line, Math.max(lines.get(line) || 0, hit));
  }

  const summarize = (hits) => {
    const total = hits.length;
    const covered = hits.filter((hit) => Number(hit) > 0).length;
    return { total, covered, skipped: 0, pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)) };
  };

  return {
    lines: summarize([...lines.values()]),
    branches: summarize(branchValues),
    functions: summarize(functionKeys.map((key) => functionHits[key] || 0)),
    statements: summarize(statementKeys.map((key) => statementHits[key] || 0)),
  };
}

function reportEntryForTarget(report, repoRoot, target) {
  const normalizedTarget = normalizePath(target);
  for (const [key, value] of Object.entries(report || {})) {
    const absolute = resolve(repoRoot, normalizedTarget);
    const normalizedKey = normalizePath(key);
    if (normalizedKey === normalizedTarget || resolve(key) === absolute || normalizePath(relative(repoRoot, key)) === normalizedTarget) {
      return value;
    }
  }
  return null;
}

export function buildBaselineFromIstanbul({ report, repoRoot = REPO_ROOT, generatedAt = new Date().toISOString(), workload = null } = {}) {
  const targets = COVERAGE_TARGETS.map((file) => {
    const entry = reportEntryForTarget(report, repoRoot, file);
    if (!entry) throw new Error(`Coverage report missing declared target: ${file}`);
    return {
      file,
      source_hash: sourceHash(repoRoot, file),
      metrics: summarizeIstanbulFile(entry),
    };
  });
  return {
    schema_version: 1,
    id: "T-INTAKE-AE7E117D",
    generated_at: generatedAt,
    generator: { tool: "c8", version: "11.0.0", node: process.version, mode: "report_only" },
    workload: workload || COVERAGE_WORKLOAD,
    metric_policy: { comparison: "per_modified_script_no_regression", metrics: [...METRICS], global_threshold: null },
    targets,
  };
}

export function validateBaselineArtifact(baseline, { repoRoot = REPO_ROOT, requireFresh = true, expectedTargets = COVERAGE_TARGETS } = {}) {
  const issues = [];
  const rows = Array.isArray(baseline?.targets) ? baseline.targets : [];
  const expected = expectedTargets.map(normalizePath);
  const actual = rows.map((row) => normalizePath(row?.file));
  if (baseline?.schema_version !== 1) issues.push("schema_version must be 1");
  if (actual.length !== expected.length) issues.push(`target count must be ${expected.length}, found ${actual.length}`);
  if (new Set(actual).size !== actual.length) issues.push("target rows must be unique");
  for (const file of expected) if (!actual.includes(file)) issues.push(`missing target row: ${file}`);
  for (const row of rows) {
    const file = normalizePath(row?.file);
    if (!expected.includes(file)) issues.push(`unexpected target row: ${file}`);
    if (!/^[a-f0-9]{64}$/.test(String(row?.source_hash || ""))) issues.push(`invalid source_hash: ${file}`);
    for (const metric of METRICS) {
      const value = row?.metrics?.[metric];
      if (!value || !Number.isFinite(value.pct) || value.pct < 0 || value.pct > 100) issues.push(`invalid ${metric}.pct: ${file}`);
    }
    if (requireFresh && file && existsSync(join(repoRoot, file)) && row?.source_hash !== sourceHash(repoRoot, file)) {
      issues.push(`stale source_hash: ${file}`);
    }
  }
  return { status: issues.length === 0 ? "PASS" : "FAIL", issues, target_count: rows.length };
}

export function summarizeFailedIveSuites(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ""));
  } catch {
    return [];
  }
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  return results
    .filter((entry) => entry?.required !== false
      && !verificationStatusIsPass(entry?.status, "execution"))
    .map((entry) => ({
      id: String(entry?.id || entry?.name || "unknown-suite"),
      status: String(entry?.status || "UNKNOWN"),
      exit_code: entry?.exit_code ?? null,
      timed_out: entry?.timed_out === true,
      detail: String(entry?.stderr_excerpt || entry?.stdout_excerpt || "")
        .trim()
        .slice(-800),
    }));
}

export function auditCoverageRatchet({
  currentBaseline,
  previousBaseline = null,
  changedFiles = [],
  repoRoot = REPO_ROOT,
  expectedTargets = COVERAGE_TARGETS,
  requireFresh = true,
} = {}) {
  const validation = validateBaselineArtifact(currentBaseline, { repoRoot, requireFresh, expectedTargets });
  const issues = [...validation.issues];
  const expected = new Set(expectedTargets.map(normalizePath));
  const modifiedTargets = [...new Set(changedFiles.map(normalizePath).filter((file) => expected.has(file)))].sort();
  const currentRows = new Map((currentBaseline?.targets || []).map((row) => [normalizePath(row.file), row]));
  const previousRows = new Map((previousBaseline?.targets || []).map((row) => [normalizePath(row.file), row]));

  if (previousBaseline) {
    for (const file of modifiedTargets) {
      const current = currentRows.get(file);
      const previous = previousRows.get(file);
      if (!current) {
        issues.push(`modified target missing current baseline row: ${file}`);
        continue;
      }
      if (!previous) {
        issues.push(`modified target missing HEAD baseline row: ${file}`);
        continue;
      }
      for (const metric of METRICS) {
        const currentPct = Number(current?.metrics?.[metric]?.pct);
        const previousPct = Number(previous?.metrics?.[metric]?.pct);
        if (Number.isFinite(currentPct) && Number.isFinite(previousPct) && currentPct < previousPct) {
          issues.push(`${file} ${metric} coverage dropped: ${previousPct} -> ${currentPct}`);
        }
      }
    }
  }

  return {
    status: issues.length === 0 ? "PASS" : "FAIL",
    issues,
    target_count: validation.target_count,
    modified_targets: modifiedTargets,
    compared_to_head: Boolean(previousBaseline),
  };
}

function gitOutput(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function discoverChangedFiles(repoRoot) {
  const values = [
    gitOutput(repoRoot, ["diff", "--name-only", "HEAD", "--"]),
    gitOutput(repoRoot, ["diff", "--cached", "--name-only", "HEAD", "--"]),
  ].flatMap((text) => text.split("\n")).map(normalizePath).filter(Boolean);
  return [...new Set(values)];
}

function readHeadBaseline(repoRoot, baselinePath) {
  const rel = normalizePath(relative(repoRoot, baselinePath));
  const result = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function parseArgs(argv) {
  const args = { command: argv[0] || "check", json: false, changedFiles: [], baseline: DEFAULT_BASELINE };
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") args.json = true;
    else if (token === "--baseline") args.baseline = resolve(argv[++i]);
    else if (token === "--changed-files" || token === "--changed-file") args.changedFiles.push(normalizePath(argv[++i]));
    else if (token === "--no-head") args.noHead = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function printResult(result, jsonMode) {
  if (jsonMode) emitJson(result);
  else {
    console.log(`Coverage baseline ${result.status}`);
    console.log(`  targets: ${result.target_count ?? 0}`);
    console.log(`  modified: ${(result.modified_targets || []).length}`);
    for (const issue of result.issues || []) console.log(`  - ${issue}`);
  }
}

async function measureCoverage(args) {
  if (!existsSync(C8_BIN)) throw new Error(`c8 is not installed; run npm install in ${normalizePath(relative(REPO_ROOT, SKILL_DIR))}`);
  const reportDir = mkdtempSync(join(tmpdir(), "planner-c8-"));
  try {
    const runnerPath = ".agent/skills/iterative-planner/tests/ive/run.mjs";
    const suiteIds = await resolveCoverageWorkloadSuiteIds();

    const c8Args = ["--all", "--reporter=json", `--reports-dir=${reportDir}`];
    for (const target of COVERAGE_TARGETS) c8Args.push("--include", target);
    c8Args.push(
      process.execPath,
      runnerPath,
      "--json",
      "--no-manifest",
      "--minimum-timeout-ms",
      String(COVERAGE_SUITE_TIMEOUT_MS),
    );
    if (process.env._PLANNER_PLAN_TARGET) {
      c8Args.push("--plan-target", process.env._PLANNER_PLAN_TARGET);
    }
    for (const id of suiteIds) c8Args.push("--only", id);
    const run = spawnSync(C8_BIN, c8Args, { cwd: REPO_ROOT, encoding: "utf8", timeout: COVERAGE_RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      const failedSuites = summarizeFailedIveSuites(run.stdout);
      const suiteDetail = failedSuites.length > 0
        ? failedSuites
          .map((entry) => `${entry.id}=${entry.status}`
            + `${entry.timed_out ? "(timeout)" : ""}`
            + `${entry.detail ? `: ${entry.detail}` : ""}`)
          .join("\n")
        : String(run.stderr || run.stdout || "").slice(-4000);
      throw new Error(
        `c8 workload failed with exit ${run.status}; `
        + `${failedSuites.length} required suite(s) failed:\n${suiteDetail}`,
      );
    }
    const reportPath = join(reportDir, "coverage-final.json");
    if (!existsSync(reportPath)) throw new Error("c8 did not produce coverage-final.json");
    const baseline = buildBaselineFromIstanbul({
      report: readJson(reportPath),
      workload: COVERAGE_WORKLOAD,
    });
    atomicWriteJson(args.baseline, baseline);
    return { status: "PASS", command: "measure", baseline_path: normalizePath(relative(REPO_ROOT, args.baseline)), target_count: baseline.targets.length, targets: baseline.targets };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function checkCoverage(args) {
  if (!existsSync(args.baseline)) return { status: "FAIL", command: "check", issues: [`baseline not found: ${normalizePath(relative(REPO_ROOT, args.baseline))}`], target_count: 0, modified_targets: [] };
  const current = readJson(args.baseline);
  const changedFiles = args.changedFiles.length ? args.changedFiles : discoverChangedFiles(REPO_ROOT);
  const previous = args.noHead ? null : readHeadBaseline(REPO_ROOT, args.baseline);
  return { command: "check", baseline_path: normalizePath(relative(REPO_ROOT, args.baseline)), ...auditCoverageRatchet({ currentBaseline: current, previousBaseline: previous, changedFiles, repoRoot: REPO_ROOT }) };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const result = args.command === "measure" ? await measureCoverage(args) : args.command === "check" ? checkCoverage(args) : (() => { throw new Error(`Unknown command: ${args.command}`); })();
    printResult(result, args.json);
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Locally computed coverage-ratchet result used by the command wrapper.
    process.exitCode = result.status === "PASS" ? 0 : 1;
  } catch (error) {
    const result = { status: "FAIL", command: args?.command || null, issues: [error.message] };
    printResult(result, args?.json === true);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
