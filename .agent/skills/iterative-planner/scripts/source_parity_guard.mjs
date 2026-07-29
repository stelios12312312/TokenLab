#!/usr/bin/env node
// @planner:module = source_parity
// @planner:capability = planner_source_parity_close_guard

import { createHash } from "crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { basename, join, resolve } from "path";
import { pathToFileURL } from "url";

const PLANNER_PREFIXES = [
  ".agent/skills/iterative-planner/",
  ".agent/workflows/",
];

function usage() {
  return `source_parity_guard.mjs — fail if planned planner-core edits are not mirrored to the source kit

Usage:
  node .agent/skills/iterative-planner/scripts/source_parity_guard.mjs [--json] [--cwd <path>] [--source <path>] [--plan <path>] [--require] [--all] [--files <csv>]
`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function asPosix(path) {
  return String(path).replaceAll("\\", "/");
}

function normalizeRepoPath(value) {
  let rel = asPosix(String(value || "").trim());
  rel = rel.replace(/^['"`(<]+/, "").replace(/[>'"`),.;:]+$/, "");
  if (rel.startsWith("./")) rel = rel.slice(2);
  return rel;
}

function isPlannerCoreRelPath(rel) {
  return PLANNER_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function discoverSourcePath(cwd, explicitSource = null) {
  if (explicitSource) return resolve(cwd, explicitSource);
  if (process.env.PLANNER_SOURCE_PROJECT) return resolve(cwd, process.env.PLANNER_SOURCE_PROJECT);
  const registryPath = join(cwd, ".agent/skills/iterative-planner/config/.project_registry.json");
  if (!existsSync(registryPath)) return null;
  const registry = readJson(registryPath);
  return registry.source_project_path ? resolve(cwd, registry.source_project_path) : null;
}

function discoverPlanDir(cwd, explicitPlan = null) {
  if (explicitPlan) return resolve(cwd, explicitPlan);
  const pointerPath = join(cwd, "plans", ".current_plan");
  if (!existsSync(pointerPath)) return null;
  const planName = readFileSync(pointerPath, "utf-8").trim();
  if (!planName) return null;
  return resolve(cwd, "plans", basename(planName));
}

function extractPlannerFilesFromText(text) {
  const files = new Set();
  const pattern = /(?:^|[\s`"'(])((?:\.\/)?\.agent\/[A-Za-z0-9_.\/-]+)/gm;
  let match = null;
  while ((match = pattern.exec(text)) !== null) {
    const rel = normalizeRepoPath(match[1]);
    if (isPlannerCoreRelPath(rel)) files.add(rel);
  }
  return [...files].sort();
}

function extractPlannerFilesFromPlan(planDir) {
  if (!planDir || !existsSync(planDir)) return [];
  const planFiles = ["plan.md", "verification_strategy.yaml", "decisions.md"]
    .map((name) => join(planDir, name))
    .filter((path) => existsSync(path));
  const files = new Set();
  for (const path of planFiles) {
    for (const rel of extractPlannerFilesFromText(readFileSync(path, "utf-8"))) {
      files.add(rel);
    }
  }
  return [...files].sort();
}

function walkPlannerCoreFiles(cwd) {
  const roots = PLANNER_PREFIXES.map((prefix) => join(cwd, prefix));
  const files = [];
  function walk(absDir, rootPrefix) {
    if (!existsSync(absDir)) return;
    for (const name of readdirSync(absDir)) {
      const abs = join(absDir, name);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, rootPrefix);
      } else if (stat.isFile()) {
        files.push(asPosix(abs.slice(cwd.length + 1)));
      }
    }
  }
  for (const root of roots) walk(root, root);
  return files.sort();
}

function compareFiles({ cwd, sourcePath, files }) {
  const compared = [];
  const missingSource = [];
  const missingTarget = [];
  const divergent = [];
  for (const rel of files) {
    const targetFile = join(cwd, rel);
    const sourceFile = join(sourcePath, rel);
    if (!existsSync(targetFile)) {
      missingTarget.push(rel);
      continue;
    }
    if (!existsSync(sourceFile)) {
      missingSource.push(rel);
      continue;
    }
    const targetHash = sha256(targetFile);
    const sourceHash = sha256(sourceFile);
    compared.push({ path: rel, target_hash: targetHash, source_hash: sourceHash });
    if (targetHash !== sourceHash) divergent.push(rel);
  }
  return { compared, missing_source: missingSource, missing_target: missingTarget, divergent };
}

export function runSourceParityGuard(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const sourcePath = discoverSourcePath(cwd, options.source || null);
  const planDir = discoverPlanDir(cwd, options.plan || null);
  if (!sourcePath || !existsSync(sourcePath)) {
    return {
      ok: false,
      status: "fail",
      reason: "missing_source_project",
      cwd,
      source_path: sourcePath,
      plan_dir: planDir,
      files_checked: [],
    };
  }

  const explicitFiles = Array.isArray(options.files)
    ? options.files.map(normalizeRepoPath).filter(isPlannerCoreRelPath)
    : [];
  const plannedFiles = explicitFiles.length
    ? explicitFiles
    : options.all
      ? walkPlannerCoreFiles(cwd)
      : extractPlannerFilesFromPlan(planDir);
  const files = [...new Set(plannedFiles)].sort();
  if (!files.length && !options.require) {
    return {
      ok: true,
      status: "skip",
      reason: "no_planned_planner_core_files",
      cwd,
      source_path: sourcePath,
      plan_dir: planDir,
      files_checked: [],
    };
  }

  const comparison = compareFiles({ cwd, sourcePath, files });
  const ok = comparison.missing_source.length === 0
    && comparison.missing_target.length === 0
    && comparison.divergent.length === 0;
  return {
    ok,
    status: ok ? "pass" : "fail",
    reason: ok ? "planner_core_source_parity_satisfied" : "planner_core_source_parity_drift",
    cwd,
    source_path: sourcePath,
    plan_dir: planDir,
    files_checked: files,
    compared_count: comparison.compared.length,
    ...comparison,
  };
}

function parseArgs(argv) {
  const args = { json: false, cwd: process.cwd(), source: null, plan: null, require: false, all: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--cwd") args.cwd = resolve(process.cwd(), argv[++i] || ".");
    else if (arg === "--source") args.source = argv[++i] || "";
    else if (arg === "--plan") args.plan = argv[++i] || "";
    else if (arg === "--require") args.require = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--files") args.files = (argv[++i] || "").split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHuman(payload) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Explicit operational SKIP reports that a parity source pair is outside the selected command scope.
  if (payload.status === "skip") {
    console.log(`Source parity guard: SKIP (${payload.reason})`);
    return;
  }
  if (payload.ok) {
    console.log(`Source parity guard: PASS (${payload.files_checked.length} planner-core file(s) checked)`);
    return;
  }
  console.log(`Source parity guard: FAIL (${payload.reason})`);
  for (const rel of payload.missing_source || []) console.log(`- missing in source: ${rel}`);
  for (const rel of payload.missing_target || []) console.log(`- missing in target: ${rel}`);
  for (const rel of payload.divergent || []) console.log(`- divergent: ${rel}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    const payload = runSourceParityGuard(args);
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else printHuman(payload);
    process.exit(payload.ok ? 0 : 1);
  } catch (error) {
    const payload = { ok: false, status: "error", error: error?.message || String(error) };
    if (process.argv.includes("--json")) console.log(JSON.stringify(payload, null, 2));
    else {
      console.error(payload.error);
      console.error(usage());
    }
    process.exit(2);
  }
}
