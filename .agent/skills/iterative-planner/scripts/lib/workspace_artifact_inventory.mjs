// workspace_artifact_inventory.mjs - Read-only registry workspace artifact inventory.
// @planner:module = workspace_artifact_inventory
// @planner:capability = registry_workspace_artifact_inventory

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";

export const WORKSPACE_ARTIFACT_INVENTORY_VERSION = 1;

export const DEFAULT_ARTIFACT_CATEGORIES = Object.freeze([
  "plans_directories",
  "decision_logs",
  "retros",
  "knowledge_files",
  "reports",
  "transcript_like_files",
]);

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".next",
  "dist",
  "build",
  "target",
  ".cache",
]);

function normalizePathForMatch(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeStat(path) {
  try {
    return { ok: true, stat: lstatSync(path) };
  } catch (error) {
    return { ok: false, error };
  }
}

function emptyArtifactCounts() {
  return Object.fromEntries(DEFAULT_ARTIFACT_CATEGORIES.map((category) => [category, 0]));
}

function emptyArtifactSamples() {
  return Object.fromEntries(DEFAULT_ARTIFACT_CATEGORIES.map((category) => [category, []]));
}

function addCategory(result, category, relPath, sampleLimit) {
  if (!category || !Object.prototype.hasOwnProperty.call(result.counts, category)) return;
  result.counts[category] += 1;
  const samples = result.samples[category];
  if (samples.length < sampleLimit) samples.push(relPath || ".");
}

export function defaultRegistryPath(cwd = process.cwd()) {
  return join(cwd, ".agent", "skills", "iterative-planner", "config", ".project_registry.json");
}

export function loadProjectRegistry(registryPath) {
  if (!registryPath || !existsSync(registryPath)) {
    return {
      ok: false,
      status: "missing",
      path: registryPath || null,
      registry: null,
      errors: [`Registry file not found: ${registryPath || "(none)"}`],
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        status: "invalid",
        path: registryPath,
        registry: null,
        errors: ["Registry root must be a JSON object"],
      };
    }
    if (!Array.isArray(parsed.projects)) {
      return {
        ok: false,
        status: "invalid",
        path: registryPath,
        registry: parsed,
        errors: ["Registry must contain a projects array"],
      };
    }
    return { ok: true, status: "ok", path: registryPath, registry: parsed, errors: [] };
  } catch (error) {
    return {
      ok: false,
      status: "invalid_json",
      path: registryPath,
      registry: null,
      errors: [`Registry JSON parse failed: ${error.message}`],
    };
  }
}

export function deriveHomeRemapCandidate(originalPath, {
  currentHome = homedir(),
} = {}) {
  const normalizedOriginal = normalize(String(originalPath || ""));
  const match = normalizedOriginal.match(/^\/Users\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const suffix = match[2] || "";
  const candidate = normalize(`${currentHome}${suffix}`);
  if (candidate === normalizedOriginal) return null;
  return {
    from_home: `/Users/${match[1]}`,
    to_home: currentHome,
    path: candidate,
    exists: existsSync(candidate),
  };
}

function classifyArtifact(relPath, dirent) {
  const normalized = normalizePathForMatch(relPath);
  const segments = normalized.split("/").filter(Boolean);
  const name = basename(normalized).toLowerCase();
  const lower = normalized.toLowerCase();
  const categories = [];

  if (dirent?.isDirectory?.()) {
    if (name === "plans" || lower.startsWith("plans/plan_") || lower.includes("/plans/plan_")) {
      categories.push("plans_directories");
    }
    if (name === "reports" || segments.includes("reports")) {
      categories.push("reports");
    }
    if (name === "retros" || name === "retro" || lower.includes("retros/")) {
      categories.push("retros");
    }
    return categories;
  }

  if (
    name === "decisions.md" ||
    name.startsWith("decision-") ||
    segments.includes("decisions")
  ) {
    categories.push("decision_logs");
  }

  if (
    lower.startsWith("plans/knowledge/") ||
    lower.includes("/plans/knowledge/") ||
    lower.includes("/knowledge/") ||
    ["mistakes.md", "patterns.md", "gotchas.md"].includes(name)
  ) {
    categories.push("knowledge_files");
  }

  if (lower.includes("retro") || lower.includes("retros/")) {
    categories.push("retros");
  }

  if (segments.includes("reports")) {
    categories.push("reports");
  }

  if (
    /\.(jsonl|md|txt|log)$/i.test(name) &&
    /(transcript|conversation|session|chat|claude|codex)/i.test(lower)
  ) {
    categories.push("transcript_like_files");
  }

  return categories;
}

export function scanArtifactCategories(rootPath, {
  maxDepth = 5,
  sampleLimit = 5,
  skipDirs = DEFAULT_SKIP_DIRS,
} = {}) {
  const result = {
    counts: emptyArtifactCounts(),
    samples: emptyArtifactSamples(),
    warnings: [],
    traversed_directories: 0,
    scanned_entries: 0,
  };

  const root = resolve(rootPath);
  const rootStat = safeStat(root);
  if (!rootStat.ok || !rootStat.stat.isDirectory()) {
    result.warnings.push(`Root is not a readable directory: ${rootPath}`);
    return result;
  }

  function visit(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      result.warnings.push(`Cannot read ${relative(root, dir) || "."}: ${error.code || error.message}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    result.traversed_directories += 1;
    for (const entry of entries) {
      result.scanned_entries += 1;
      const abs = join(dir, entry.name);
      const relPath = normalizePathForMatch(relative(root, abs));
      for (const category of classifyArtifact(relPath, entry)) {
        addCategory(result, category, relPath, sampleLimit);
      }
      if (!entry.isDirectory()) continue;
      if (entry.isSymbolicLink?.()) continue;
      if (skipDirs.has(entry.name)) continue;
      visit(abs, depth + 1);
    }
  }

  visit(root, 0);
  return result;
}

function normalizeProjectEntry(entry, index) {
  const path = isPlainObject(entry) ? entry.path : null;
  return {
    index,
    path: typeof path === "string" ? path : null,
    type: isPlainObject(entry) && typeof entry.type === "string" ? entry.type : null,
    last_upgraded: isPlainObject(entry) && typeof entry.last_upgraded === "string" ? entry.last_upgraded : null,
  };
}

export function inspectWorkspaceEntry(entry, options = {}) {
  const normalizedEntry = normalizeProjectEntry(entry, options.index ?? 0);
  const warnings = [];
  if (!normalizedEntry.path || !isAbsolute(normalizedEntry.path)) {
    return {
      ...normalizedEntry,
      resolution_status: "invalid_path",
      candidate_home_remaps: [],
      artifact_counts: emptyArtifactCounts(),
      artifact_samples: emptyArtifactSamples(),
      warnings: ["Entry path is missing or not absolute"],
    };
  }

  const stat = safeStat(normalizedEntry.path);
  const homeRemap = deriveHomeRemapCandidate(normalizedEntry.path, options);
  const candidate_home_remaps = homeRemap ? [homeRemap] : [];

  if (!stat.ok || !stat.stat.isDirectory()) {
    return {
      ...normalizedEntry,
      resolution_status: "stale_path",
      candidate_home_remaps,
      artifact_counts: emptyArtifactCounts(),
      artifact_samples: emptyArtifactSamples(),
      warnings,
    };
  }

  const scan = scanArtifactCategories(normalizedEntry.path, options);
  return {
    ...normalizedEntry,
    resolution_status: "present_root",
    candidate_home_remaps,
    artifact_counts: scan.counts,
    artifact_samples: scan.samples,
    warnings: scan.warnings,
    scanned_entries: scan.scanned_entries,
    traversed_directories: scan.traversed_directories,
  };
}

function summarizeEntries(entries) {
  const summary = {
    total_entries: entries.length,
    present_roots: 0,
    stale_paths: 0,
    invalid_paths: 0,
    remap_candidates: 0,
    remap_candidates_existing: 0,
    artifact_counts: emptyArtifactCounts(),
    warnings: 0,
  };
  for (const entry of entries) {
    if (entry.resolution_status === "present_root") summary.present_roots += 1;
    if (entry.resolution_status === "stale_path") summary.stale_paths += 1;
    if (entry.resolution_status === "invalid_path") summary.invalid_paths += 1;
    for (const candidate of entry.candidate_home_remaps || []) {
      summary.remap_candidates += 1;
      if (candidate.exists) summary.remap_candidates_existing += 1;
    }
    for (const category of DEFAULT_ARTIFACT_CATEGORIES) {
      summary.artifact_counts[category] += entry.artifact_counts?.[category] || 0;
    }
    summary.warnings += (entry.warnings || []).length;
  }
  return summary;
}

export function inventoryWorkspaceArtifacts({
  cwd = process.cwd(),
  registryPath = defaultRegistryPath(cwd),
  currentHome = homedir(),
  maxDepth = 5,
  sampleLimit = 5,
} = {}) {
  const resolvedRegistryPath = resolve(cwd, registryPath);
  const loaded = loadProjectRegistry(resolvedRegistryPath);
  const report = {
    ok: loaded.ok,
    version: WORKSPACE_ARTIFACT_INVENTORY_VERSION,
    claim_boundary: {
      proof_type: "source_availability_inventory",
      quant_result_claim: false,
      result_claims_not_evaluated: [
        "target",
        "performance",
        "alpha",
        "backtest",
        "calibration",
        "out_of_sample",
        "temporal_leakage",
      ],
    },
    registry: {
      path: resolvedRegistryPath,
      status: loaded.status,
      errors: loaded.errors,
      project_count: Array.isArray(loaded.registry?.projects) ? loaded.registry.projects.length : 0,
      scan_roots: Array.isArray(loaded.registry?.scan_roots) ? loaded.registry.scan_roots : [],
      source_project_path: typeof loaded.registry?.source_project_path === "string" ? loaded.registry.source_project_path : null,
    },
    summary: {
      total_entries: 0,
      present_roots: 0,
      stale_paths: 0,
      invalid_paths: 0,
      remap_candidates: 0,
      remap_candidates_existing: 0,
      artifact_counts: emptyArtifactCounts(),
      warnings: loaded.errors.length,
    },
    entries: [],
    source_project: null,
  };

  if (!loaded.ok) return report;

  const entries = loaded.registry.projects.map((entry, index) => inspectWorkspaceEntry(entry, {
    index,
    currentHome,
    maxDepth,
    sampleLimit,
  }));
  report.entries = entries;
  report.summary = summarizeEntries(entries);

  if (typeof loaded.registry.source_project_path === "string") {
    report.source_project = inspectWorkspaceEntry({
      path: loaded.registry.source_project_path,
      type: "source_project",
    }, {
      index: -1,
      currentHome,
      maxDepth,
      sampleLimit,
    });
  }

  return report;
}

export function parseInventoryArgs(argv = []) {
  const options = {
    json: false,
    registryPath: null,
    currentHome: homedir(),
    maxDepth: 5,
    sampleLimit: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--registry") options.registryPath = argv[++index] || null;
    else if (arg === "--root") options.currentHome = argv[++index] || options.currentHome;
    else if (arg === "--max-depth") options.maxDepth = Number.parseInt(argv[++index] || "", 10);
    else if (arg === "--sample-limit") options.sampleLimit = Number.parseInt(argv[++index] || "", 10);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else {
      if (!options.unknown) options.unknown = [];
      options.unknown.push(arg);
    }
  }

  if (!Number.isFinite(options.maxDepth) || options.maxDepth < 0) options.maxDepth = 5;
  if (!Number.isFinite(options.sampleLimit) || options.sampleLimit < 0) options.sampleLimit = 5;
  return options;
}

export function formatInventoryText(report) {
  const lines = [];
  lines.push(`Workspace artifact inventory: ${report.ok ? "PASS" : "FAIL"}`);
  lines.push(`Registry: ${report.registry.path} (${report.registry.status})`);
  lines.push(`Entries: ${report.summary.total_entries}`);
  lines.push(`Present roots: ${report.summary.present_roots}`);
  lines.push(`Stale paths: ${report.summary.stale_paths}`);
  lines.push(`Existing remap candidates: ${report.summary.remap_candidates_existing}`);
  lines.push("Artifact counts:");
  for (const category of DEFAULT_ARTIFACT_CATEGORIES) {
    lines.push(`  ${category}: ${report.summary.artifact_counts[category] || 0}`);
  }
  if (report.registry.errors.length > 0) {
    lines.push("Errors:");
    for (const error of report.registry.errors) lines.push(`  - ${error}`);
  }
  return lines.join("\n");
}
