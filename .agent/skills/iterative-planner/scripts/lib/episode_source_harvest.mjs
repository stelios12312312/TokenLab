// episode_source_harvest.mjs - Read-only local episode source candidate harvesting.
// @planner:module = episode_source_harvest
// @planner:capability = direct_local_episode_source_harvest

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export const EPISODE_SOURCE_HARVEST_VERSION = 1;

export const DEFAULT_EPISODE_SIGNAL_FAMILIES = Object.freeze([
  "aha_or_lesson",
  "missed_risk_or_retro",
  "quant_boundary",
  "autocode_loop",
  "ive_ontology_trace",
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

const PROJECT_MARKERS = Object.freeze([
  ".git",
  ".agent",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "package.json",
  "pyproject.toml",
  "plans",
]);

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
]);

const SIGNALS = Object.freeze([
  {
    family: "aha_or_lesson",
    weight: 8,
    pattern: /\b(aha|breakthrough|insight|realized|realised|learned|lesson|finding)\b/gi,
  },
  {
    family: "missed_risk_or_retro",
    weight: 10,
    pattern: /\b(missed|gap|bug|failure|wrong|regression|false[- ]green|false[- ]positive|stale|blocked|drift|root cause|retro)\b/gi,
  },
  {
    family: "quant_boundary",
    weight: 12,
    pattern: /\b(leakage|temporal|out[- ]of[- ]sample|oos|calibration|backtest|optimizer|hyperparameter|cpcv|walk[- ]forward|clv|closing line|odds|kelly|trueskill|markov|baseline|holdout)\b/gi,
  },
  {
    family: "autocode_loop",
    weight: 9,
    pattern: /\b(autocode|automode|autonomous|agent|loop|retry|reflection|planner|gate|transition)\b/gi,
  },
  {
    family: "ive_ontology_trace",
    weight: 9,
    pattern: /\b(ive|ontology|prolog|invariant|persona|traceability|program packet|ticket|verification)\b/gi,
  },
]);

function normalizePathForMatch(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function safeStat(path) {
  try {
    return { ok: true, stat: lstatSync(path) };
  } catch (error) {
    return { ok: false, error };
  }
}

function sortStrings(values) {
  return [...values].sort((a, b) => String(a).localeCompare(String(b)));
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function lowerRel(relPath) {
  return normalizePathForMatch(relPath).toLowerCase();
}

function fileExtension(path) {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function isTextCandidateFile(path) {
  return TEXT_EXTENSIONS.has(fileExtension(path));
}

function hasProjectMarker(dir) {
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

function artifactCategories(relPath) {
  const lower = lowerRel(relPath);
  const segments = lower.split("/").filter(Boolean);
  const name = basename(lower);
  const categories = [];

  if (
    lower.startsWith("plans/") ||
    lower.includes("/plans/") ||
    segments.includes("plans") ||
    lower.includes("plan_")
  ) {
    categories.push("plan_artifact");
  }
  if (name === "decisions.md" || name.startsWith("decision-") || segments.includes("decisions")) {
    categories.push("decision_log");
  }
  if (lower.includes("retro") || lower.includes("retros/")) {
    categories.push("retro");
  }
  if (
    lower.includes("/knowledge/") ||
    lower.startsWith("knowledge/") ||
    ["mistakes.md", "patterns.md", "gotchas.md"].includes(name)
  ) {
    categories.push("knowledge");
  }
  if (segments.includes("reports") || lower.startsWith("reports/") || name.includes("report")) {
    categories.push("report");
  }
  if (/(transcript|conversation|session|chat|claude|codex)/i.test(lower)) {
    categories.push("transcript_like");
  }

  return uniqueStrings(categories);
}

function baseCategoryScore(categories) {
  let score = 0;
  if (categories.includes("retro")) score += 14;
  if (categories.includes("decision_log")) score += 10;
  if (categories.includes("knowledge")) score += 9;
  if (categories.includes("transcript_like")) score += 8;
  if (categories.includes("plan_artifact")) score += 6;
  if (categories.includes("report")) score += 5;
  return score;
}

function countPattern(pattern, text) {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text)) count += 1;
  return count;
}

function signalCountsForText(text) {
  const counts = {};
  let score = 0;
  for (const signal of SIGNALS) {
    const count = countPattern(signal.pattern, text);
    if (count <= 0) continue;
    counts[signal.family] = count;
    score += signal.weight * Math.min(count, 5);
  }
  return { counts, score };
}

function readBoundedText(path, maxBytes) {
  try {
    const buffer = readFileSync(path);
    return buffer.slice(0, Math.max(0, maxBytes)).toString("utf-8");
  } catch {
    return "";
  }
}

export function discoverProjectRoots(scanRoots = [process.cwd()], {
  maxDepth = 4,
  skipDirs = DEFAULT_SKIP_DIRS,
} = {}) {
  const roots = [];
  const warnings = [];
  const seen = new Set();

  function addRoot(path) {
    const root = resolve(path);
    if (seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  }

  function visit(dir, depth, explicitRoot = false) {
    const stat = safeStat(dir);
    if (!stat.ok || !stat.stat.isDirectory()) {
      warnings.push(`Scan root is not a readable directory: ${dir}`);
      return;
    }

    if (hasProjectMarker(dir)) {
      addRoot(dir);
      if (!explicitRoot) return;
    }
    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Cannot read ${dir}: ${error.code || error.message}`);
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (entry.isSymbolicLink?.()) continue;
      if (skipDirs.has(entry.name)) continue;
      visit(join(dir, entry.name), depth + 1, false);
    }
  }

  for (const root of scanRoots.length > 0 ? scanRoots : [process.cwd()]) {
    const resolved = isAbsolute(root) ? root : resolve(root);
    visit(resolved, 0, true);
  }

  return {
    roots: sortStrings(roots),
    warnings,
  };
}

function scanProjectCandidates(projectRoot, {
  artifactDepth = 6,
  candidateLimit = 50,
  maxBytes = 64 * 1024,
  skipDirs = DEFAULT_SKIP_DIRS,
} = {}) {
  const candidates = [];
  const warnings = [];
  let scannedFiles = 0;
  let traversedDirectories = 0;

  function visit(dir, depth) {
    if (depth > artifactDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Cannot read ${normalizePathForMatch(relative(projectRoot, dir)) || "."}: ${error.code || error.message}`);
      return;
    }
    traversedDirectories += 1;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const relPath = normalizePathForMatch(relative(projectRoot, abs));
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink?.() && !skipDirs.has(entry.name)) visit(abs, depth + 1);
        continue;
      }
      if (!entry.isFile?.()) continue;
      scannedFiles += 1;
      if (!isTextCandidateFile(abs)) continue;

      const categories = artifactCategories(relPath);
      if (categories.length === 0) continue;

      const signalText = `${relPath}\n${readBoundedText(abs, maxBytes)}`;
      const signal = signalCountsForText(signalText);
      const score = baseCategoryScore(categories) + signal.score;
      if (score <= 0) continue;

      candidates.push({
        source_path: relPath,
        absolute_path: abs,
        categories,
        signal_counts: signal.counts,
        signal_families: sortStrings(Object.keys(signal.counts)),
        score,
      });
    }
  }

  visit(projectRoot, 0);
  candidates.sort((a, b) => b.score - a.score || a.source_path.localeCompare(b.source_path));
  return {
    candidates: candidates.slice(0, Math.max(0, candidateLimit)),
    candidate_count_total: candidates.length,
    scanned_files: scannedFiles,
    traversed_directories: traversedDirectories,
    warnings,
  };
}

function summarizeProjects(projects) {
  const signal_counts = Object.fromEntries(DEFAULT_EPISODE_SIGNAL_FAMILIES.map((family) => [family, 0]));
  let candidate_count = 0;
  for (const project of projects) {
    candidate_count += project.candidates.length;
    for (const candidate of project.candidates) {
      for (const family of candidate.signal_families) {
        signal_counts[family] = (signal_counts[family] || 0) + 1;
      }
    }
  }
  return {
    project_count: projects.length,
    candidate_count,
    signal_counts,
  };
}

export function harvestEpisodeSources({
  scanRoots = [process.cwd()],
  maxDepth = 4,
  artifactDepth = 6,
  candidateLimit = 50,
  sampleLimit = 5,
  maxBytes = 64 * 1024,
} = {}) {
  const discovered = discoverProjectRoots(scanRoots, { maxDepth });
  const projects = discovered.roots.map((root) => {
    const scan = scanProjectCandidates(root, { artifactDepth, candidateLimit, maxBytes });
    return {
      name: basename(root),
      root,
      candidate_count: scan.candidates.length,
      candidate_count_total: scan.candidate_count_total,
      scanned_files: scan.scanned_files,
      traversed_directories: scan.traversed_directories,
      candidates: scan.candidates,
      warnings: scan.warnings,
    };
  });

  const warnings = [
    ...discovered.warnings,
    ...projects.flatMap((project) => project.warnings.map((warning) => `${project.name}: ${warning}`)),
  ];

  return {
    ok: true,
    version: EPISODE_SOURCE_HARVEST_VERSION,
    claim_boundary: {
      proof_type: "episode_source_candidate_inventory",
      quant_result_claim: false,
      source_excerpt_emitted: false,
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
    options: {
      scan_roots: scanRoots.map((root) => (isAbsolute(root) ? root : resolve(root))),
      max_depth: maxDepth,
      artifact_depth: artifactDepth,
      candidate_limit: candidateLimit,
      sample_limit: sampleLimit,
    },
    summary: {
      ...summarizeProjects(projects),
      warnings: warnings.length,
    },
    projects,
    warnings,
  };
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseEpisodeSourceHarvestArgs(argv = []) {
  const options = {
    json: false,
    scanRoots: [],
    maxDepth: 4,
    artifactDepth: 6,
    candidateLimit: 50,
    sampleLimit: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--scan-root") options.scanRoots.push(argv[++index] || process.cwd());
    else if (arg === "--max-depth") options.maxDepth = parseNumber(argv[++index], 4);
    else if (arg === "--artifact-depth") options.artifactDepth = parseNumber(argv[++index], 6);
    else if (arg === "--candidate-limit") options.candidateLimit = parseNumber(argv[++index], 50);
    else if (arg === "--sample-limit") options.sampleLimit = parseNumber(argv[++index], 5);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else {
      if (!options.unknown) options.unknown = [];
      options.unknown.push(arg);
    }
  }

  if (options.scanRoots.length === 0) options.scanRoots.push(process.cwd());
  return options;
}

export function formatEpisodeSourceHarvestText(report) {
  const lines = [];
  lines.push(`Episode source harvest: ${report.ok ? "PASS" : "FAIL"}`);
  lines.push(`Projects: ${report.summary.project_count}`);
  lines.push(`Candidates: ${report.summary.candidate_count}`);
  lines.push("Signals:");
  for (const family of DEFAULT_EPISODE_SIGNAL_FAMILIES) {
    lines.push(`  ${family}: ${report.summary.signal_counts[family] || 0}`);
  }
  lines.push("Top projects:");
  for (const project of report.projects.slice(0, report.options.sample_limit)) {
    lines.push(`  ${project.name}: ${project.candidate_count} candidate(s)`);
    for (const candidate of project.candidates.slice(0, report.options.sample_limit)) {
      lines.push(`    - ${candidate.source_path} [${candidate.signal_families.join(", ") || "path_only"}] score=${candidate.score}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings.slice(0, report.options.sample_limit)) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}
