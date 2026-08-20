#!/usr/bin/env node
// blast_radius.mjs — Deterministic dependency & similarity mapper
//
// Usage:
//   node blast_radius.mjs --self-test             Run this script's local smoke check
//   node blast_radius.mjs <file> [symbol]         Map dependencies for a file (optionally focused on a symbol)
//   node blast_radius.mjs --multi <f1> <f2> ...   Map dependencies for multiple files
//   node blast_radius.mjs --files <f1> <f2> ...   MCP-compatible alias for --multi
//   node blast_radius.mjs --diff                   Map dependencies for all files in the last git diff
//   node blast_radius.mjs --json <file>            Output as JSON
//   node blast_radius.mjs --budget-ms <ms>         Override the invocation-wide time budget
//
// Produces a structured report:
//   1. DEPENDENTS    — who imports/requires/calls into this file
//   2. DEPENDENCIES  — what this file imports/requires/calls out to
//   3. SIBLINGS      — other files in the same directory
//   4. SYMBOL GRAPH  — if a symbol is specified, where it's used and what it calls
//   5. SIMILAR CODE  — files with similar naming/structural patterns
//
// Zero dependencies — Node 18+. Builds one bounded text corpus per invocation.

import { readFileSync, existsSync, readdirSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { join, dirname, basename, extname, relative } from "path";
import { spawnSync } from "child_process";
import { performance } from "perf_hooks";
import {
  assertSelfTest,
  cleanupSelfTestTemp,
  initGitRepo,
  makeSelfTestTemp,
  plannerSelfTestEnv,
  printSelfTestPass,
  runBin,
  selfPath,
} from "./lib/script_self_test.mjs";

const cwd = process.cwd();
const DEFAULT_BUDGET_MS = 20000;
const MAX_BUDGET_MS = 2147483647;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TARGETS = 512;
const GENERATED_ROOTS = new Set(["plans", "reports", "coverage"]);
const ALWAYS_EXCLUDED_PATH_SEGMENTS = new Set([".git", "node_modules"]);
const EXCLUDED_PATH_SEGMENTS = new Set([...ALWAYS_EXCLUDED_PATH_SEGMENTS, ...GENERATED_ROOTS]);
const SECTION_NAMES = Object.freeze(["dependents", "dependencies", "siblings", "symbols", "similar"]);
const GIT_INVENTORY_AUTHORITY_ERROR = "ERROR: Git inventory unavailable in detected worktree; refusing filesystem fallback.";

// ---------------------------------------------------------------------------
// Language-aware import/require patterns
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS = {
  // Python: from X import Y, import X
  ".py": {
    outbound: /(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/g,
    inbound: (basename_no_ext) => [
      `from ${basename_no_ext}`,
      `import ${basename_no_ext}`,
      `from .${basename_no_ext}`,
    ],
  },
  // JavaScript/TypeScript: import/require + dynamic import() + re-export (RP-006)
  ".js": {
    outbound: /(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\)|export\s+.*?\s+from\s+['"]([^'"]+)['"])/g,
    inbound: (basename_no_ext) => [
      `from '${basename_no_ext}`,
      `from "./${basename_no_ext}`,
      `from '${basename_no_ext}`,
      `require('${basename_no_ext}`,
      `require("./${basename_no_ext}`,
      `import("./${basename_no_ext}`,   // RP-006: dynamic import
      `import('./${basename_no_ext}`,   // RP-006: dynamic import (single quotes)
      `from "./${basename_no_ext}`,     // RP-006: re-export
    ],
  },
  ".ts": null,  // same as .js
  ".tsx": null,
  ".jsx": null,
  ".mjs": null,
  ".cjs": null,
  // PHP: require/include/use
  ".php": {
    outbound: /(?:require(?:_once)?\s+['"]([^'"]+)['"]|include(?:_once)?\s+['"]([^'"]+)['"]|use\s+([\w\\]+))/g,
    inbound: (basename_no_ext) => [
      `require '${basename_no_ext}`,
      `require_once '${basename_no_ext}`,
      `include '${basename_no_ext}`,
    ],
  },
};

// Fill aliases
for (const ext of [".ts", ".tsx", ".jsx", ".mjs", ".cjs"]) {
  IMPORT_PATTERNS[ext] = IMPORT_PATTERNS[".js"];
}

// ---------------------------------------------------------------------------
// Symbol extraction — language-aware function/class/method detection
// ---------------------------------------------------------------------------

const SYMBOL_PATTERNS = {
  ".py": /(?:def\s+(\w+)|class\s+(\w+))/g,
  ".js": /(?:function\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())/g,
  ".ts": /(?:function\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+)\s*[=:]\s*(?:async\s+)?(?:function|\())/g,
  ".php": /(?:function\s+(\w+)|class\s+(\w+))/g,
};
for (const ext of [".tsx", ".jsx", ".mjs", ".cjs"]) {
  SYMBOL_PATTERNS[ext] = SYMBOL_PATTERNS[".js"];
}

// ---------------------------------------------------------------------------
// Bounded inventory and analysis functions
// ---------------------------------------------------------------------------

function normalizeRepoPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function isEligibleRepoPath(value) {
  const normalized = normalizeRepoPath(value);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return false;
  const segments = normalized.split("/");
  if (GENERATED_ROOTS.has(segments[0])) return false;
  return !segments.some(segment => ALWAYS_EXCLUDED_PATH_SEGMENTS.has(segment));
}

function createDeadline(budgetMs) {
  const startedAt = performance.now();
  return {
    budgetMs,
    startedAt,
    expiresAt: startedAt + budgetMs,
    truncated: false,
    reason: null,
    stage: null,
  };
}

function deadlineExpired(deadline, stage) {
  if (deadline.truncated) return true;
  if (performance.now() < deadline.expiresAt) return false;
  deadline.truncated = true;
  deadline.reason = "budget_exhausted";
  deadline.stage = stage;
  return true;
}

function remainingBudgetMs(deadline) {
  return Math.max(1, Math.floor(deadline.expiresAt - performance.now()));
}

function hasGitMetadataAncestor(startDir) {
  let currentDir = startDir;
  while (true) {
    try {
      const metadata = lstatSync(join(currentDir, ".git"));
      if (metadata.isDirectory() || metadata.isFile()) return true;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return true;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return false;
    currentDir = parentDir;
  }
}

function runGitBounded(gitArgs, deadline, stage, { probeWhenExpired = false } = {}) {
  const alreadyExpired = deadlineExpired(deadline, stage);
  if (alreadyExpired && !probeWhenExpired) {
    return { status: null, stdout: "", stderr: "", timedOut: true };
  }
  const proc = spawnSync("git", gitArgs, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: remainingBudgetMs(deadline),
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = proc.error?.code === "ETIMEDOUT";
  if (timedOut || performance.now() >= deadline.expiresAt) {
    deadline.truncated = true;
    deadline.reason = "budget_exhausted";
    deadline.stage ||= stage;
  }
  return {
    status: proc.status,
    stdout: proc.stdout || "",
    stderr: proc.stderr || "",
    timedOut,
    errorCode: proc.error?.code || null,
  };
}

function walkFallback(rootDir, deadline) {
  const files = [];
  let excludedEntries = 0;
  let unreadableDirectories = 0;
  let nonRegularEntries = 0;
  let symbolicLinkEntries = 0;
  const visit = (absDir) => {
    if (deadlineExpired(deadline, "inventory_fallback")) return;
    let entries = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      unreadableDirectories += 1;
      return;
    }
    for (const entry of entries) {
      if (deadlineExpired(deadline, "inventory_fallback")) return;
      const absPath = join(absDir, entry.name);
      const relPath = normalizeRepoPath(relative(rootDir, absPath));
      if (!isEligibleRepoPath(relPath)) {
        excludedEntries += 1;
        continue;
      }
      if (entry.isDirectory()) {
        visit(absPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      } else {
        nonRegularEntries += 1;
        if (entry.isSymbolicLink()) symbolicLinkEntries += 1;
      }
    }
  };
  visit(rootDir);
  return { files, excludedEntries, unreadableDirectories, nonRegularEntries, symbolicLinkEntries };
}

function buildInventory(deadline) {
  const gitMetadataDetected = hasGitMetadataAncestor(cwd);
  const gitResult = runGitBounded(
    ["ls-files", "-z", "--cached"],
    deadline,
    "inventory_git",
    { probeWhenExpired: gitMetadataDetected },
  );
  const gitUsable = gitResult.status === 0;
  const gitTimedOut = gitResult.timedOut;
  if (gitMetadataDetected && !gitUsable && !gitTimedOut) {
    return { authorityError: GIT_INVENTORY_AUTHORITY_ERROR };
  }
  const useFilesystemFallback = !gitUsable && !gitMetadataDetected && !gitTimedOut;
  const fallback = !useFilesystemFallback
    ? { files: [], excludedEntries: 0, unreadableDirectories: 0, nonRegularEntries: 0, symbolicLinkEntries: 0 }
    : walkFallback(cwd, deadline);
  const rawPaths = gitUsable
    ? gitResult.stdout.split("\0").filter(Boolean).map(normalizeRepoPath)
    : fallback.files;
  const scope = gitUsable
    ? "git_tracked_searchable_text_excluding_generated"
    : (gitMetadataDetected
      ? "git_tracked_searchable_text_excluding_generated"
      : "filesystem_searchable_text_excluding_generated");
  const enumerationComplete = (
    !gitTimedOut &&
    !deadline.truncated &&
    (gitUsable || (useFilesystemFallback && fallback.unreadableDirectories === 0))
  );
  const eligiblePaths = rawPaths
    .filter(isEligibleRepoPath)
    .sort((left, right) => left.localeCompare(right));
  const excludedEntries = gitUsable
    ? rawPaths.length - eligiblePaths.length
    : fallback.excludedEntries;
  const inventoryEntriesSeen = gitUsable
    ? rawPaths.length
    : rawPaths.length + fallback.excludedEntries + fallback.nonRegularEntries;
  const corpus = [];
  const corpusByPath = new Map();
  let binaryFilesSkipped = 0;
  let oversizedFilesSkipped = 0;
  let unreadableFilesSkipped = 0;
  let nonRegularFilesSkipped = fallback.nonRegularEntries;
  let symbolicLinksSkipped = fallback.symbolicLinkEntries;

  for (const repoPath of eligiblePaths) {
    if (deadlineExpired(deadline, "inventory_load")) break;
    const absPath = join(cwd, repoPath);
    try {
      const stats = lstatSync(absPath);
      if (stats.isSymbolicLink()) {
        symbolicLinksSkipped += 1;
        nonRegularFilesSkipped += 1;
        continue;
      }
      if (!stats.isFile()) {
        nonRegularFilesSkipped += 1;
        continue;
      }
      if (stats.size > MAX_TEXT_FILE_BYTES) {
        oversizedFilesSkipped += 1;
        continue;
      }
      const content = readFileSync(absPath, "utf-8");
      if (content.includes("\0")) {
        binaryFilesSkipped += 1;
        continue;
      }
      const entry = { path: repoPath, absPath, content };
      corpus.push(entry);
      corpusByPath.set(repoPath, entry);
    } catch {
      unreadableFilesSkipped += 1;
    }
  }
  const sourceCoverageComplete = (
    oversizedFilesSkipped === 0 &&
    unreadableFilesSkipped === 0 &&
    nonRegularFilesSkipped === 0
  );
  const corpusCoverageComplete = enumerationComplete && sourceCoverageComplete;

  return {
    scope,
    rawPathCount: rawPaths.length,
    eligiblePaths,
    eligiblePathSet: new Set(eligiblePaths),
    excludedEntries,
    inventoryEntriesSeen,
    corpus,
    corpusByPath,
    enumerationComplete,
    sourceCoverageComplete,
    corpusCoverageComplete,
    complete: corpusCoverageComplete && !deadline.truncated,
    binaryFilesSkipped,
    oversizedFilesSkipped,
    unreadableFilesSkipped,
    nonRegularFilesSkipped,
    symbolicLinksSkipped,
    fallbackUnreadableDirectories: fallback.unreadableDirectories,
  };
}

function getDependents(filePath, context) {
  const ext = extname(filePath);
  const bnNoExt = basename(filePath, ext);
  const bn = basename(filePath);
  const patterns = [...(IMPORT_PATTERNS[ext]?.inbound(bnNoExt) || []), bn];
  const dependents = new Set();

  for (const entry of context.inventory.corpus) {
    if (deadlineExpired(context.deadline, `dependents:${filePath}`)) {
      return { value: [...dependents].sort(), complete: false };
    }
    if (entry.path === filePath) continue;
    if (patterns.some(pattern => entry.content.includes(pattern))) {
      dependents.add(entry.path);
    }
  }

  return {
    value: [...dependents].sort(),
    complete: context.inventory.corpusCoverageComplete,
  };
}

function getDependencies(filePath, context) {
  if (deadlineExpired(context.deadline, `dependencies:${filePath}`)) {
    return { value: [], complete: false };
  }
  const ext = extname(filePath);
  const patterns = IMPORT_PATTERNS[ext];
  if (!patterns) return { value: [], complete: true };
  const content = context.inventory.corpusByPath.get(filePath)?.content;
  if (typeof content !== "string") {
    return { value: [], complete: false };
  }
  const deps = new Set();
  let match;
  let matchCount = 0;
  const regex = new RegExp(patterns.outbound.source, patterns.outbound.flags);
  while ((match = regex.exec(content)) !== null) {
    if ((matchCount % 128) === 0 && deadlineExpired(context.deadline, `dependencies:${filePath}`)) {
      return { value: [...deps].sort(), complete: false };
    }
    matchCount += 1;
    const dep = match[1] || match[2] || match[3] || match[4];
    if (dep) deps.add(dep);
  }
  return { value: [...deps].sort(), complete: true };
}

function getSiblings(filePath, context) {
  if (deadlineExpired(context.deadline, `siblings:${filePath}`)) {
    return { value: [], complete: false };
  }
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const codeExtensions = new Set([".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".php"]);
  const siblings = [];
  for (const entry of context.inventory.corpus) {
    if (deadlineExpired(context.deadline, `siblings:${filePath}`)) {
      return { value: siblings.sort(), complete: false };
    }
    const candidate = entry.path;
    if (candidate === filePath || dirname(candidate) !== dir || basename(candidate).startsWith(".")) continue;
    const candidateExt = extname(candidate);
    if (candidateExt === ext || codeExtensions.has(candidateExt)) siblings.push(candidate);
  }
  return {
    value: siblings.sort(),
    complete: context.inventory.corpusCoverageComplete,
  };
}

function getSymbols(filePath, context) {
  if (deadlineExpired(context.deadline, `symbols:${filePath}`)) {
    return { value: [], complete: false };
  }
  const ext = extname(filePath);
  const pattern = SYMBOL_PATTERNS[ext];
  if (!pattern) return { value: [], complete: true };
  const content = context.inventory.corpusByPath.get(filePath)?.content;
  if (typeof content !== "string") return { value: [], complete: false };
  const symbols = [];
  let match;
  let scannedThrough = 0;
  let lineNum = 1;
  let matchCount = 0;
  const regex = new RegExp(pattern.source, pattern.flags);
  while ((match = regex.exec(content)) !== null) {
    for (let offset = scannedThrough; offset < match.index; offset += 1) {
      if ((offset % 4096) === 0 && deadlineExpired(context.deadline, `symbols:${filePath}`)) {
        return { value: symbols, complete: false };
      }
      if (content.charCodeAt(offset) === 10) lineNum += 1;
    }
    scannedThrough = match.index;
    if ((matchCount % 128) === 0 && deadlineExpired(context.deadline, `symbols:${filePath}`)) {
      return { value: symbols, complete: false };
    }
    matchCount += 1;
    const name = match[1] || match[2] || match[3];
    if (name && !name.startsWith("_") && name !== "constructor") {
      symbols.push({ name, line: lineNum });
    }
  }
  return { value: symbols, complete: true };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSymbolUsages(symbol, filePath, context) {
  const results = [];
  for (const entry of context.inventory.corpus) {
    if (deadlineExpired(context.deadline, `symbol_usages:${filePath}`)) {
      return { value: results.sort((a, b) => b.matches - a.matches).slice(0, 20), complete: false };
    }
    if (entry.path === filePath) continue;
    const pattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`, "g");
    let matches = 0;
    while (pattern.exec(entry.content) !== null) {
      matches += 1;
      if ((matches % 128) === 0 && deadlineExpired(context.deadline, `symbol_usages:${filePath}`)) {
        return {
          value: results.sort((a, b) => b.matches - a.matches).slice(0, 20),
          complete: false,
        };
      }
    }
    if (matches > 0) results.push({ file: entry.path, matches });
  }
  return {
    value: results.sort((a, b) => b.matches - a.matches).slice(0, 20),
    complete: context.inventory.corpusCoverageComplete,
  };
}

function findSimilarFiles(filePath, context) {
  const bn = basename(filePath, extname(filePath));
  const ext = extname(filePath);
  const similar = [];
  const parts = bn.split(/[_\-.]/).filter(p => p.length > 2);
  for (const entry of context.inventory.corpus) {
    if (deadlineExpired(context.deadline, `similar:${filePath}`)) {
      return { value: dedupeSimilar(similar), complete: false };
    }
    if (entry.path === filePath || extname(entry.path) !== ext) continue;
    const candidateName = basename(entry.path, extname(entry.path));
    for (const part of parts) {
      if (candidateName.includes(part)) {
        similar.push({ file: entry.path, reason: `shares naming pattern: "${part}"` });
        break;
      }
    }
  }

  const content = context.inventory.corpusByPath.get(filePath)?.content;
  if (typeof content === "string") {
    // Python: class X(BaseClass)
    const pyMatch = content.match(/class\s+\w+\s*\((\w+)\)/);
    if (pyMatch) {
      const base = pyMatch[1];
      const pattern = new RegExp(`class\\s+\\w+\\s*\\(${escapeRegex(base)}\\)`);
      for (const entry of context.inventory.corpus) {
        if (deadlineExpired(context.deadline, `similar:${filePath}`)) {
          return { value: dedupeSimilar(similar), complete: false };
        }
        if (entry.path !== filePath && pattern.test(entry.content)) {
          similar.push({ file: entry.path, reason: `also extends ${base}` });
        }
      }
    }
    const jsMatch = content.match(/class\s+\w+\s+extends\s+(\w+)/);
    if (jsMatch) {
      const base = jsMatch[1];
      const pattern = new RegExp(`extends\\s+${escapeRegex(base)}\\b`);
      for (const entry of context.inventory.corpus) {
        if (deadlineExpired(context.deadline, `similar:${filePath}`)) {
          return { value: dedupeSimilar(similar), complete: false };
        }
        if (entry.path !== filePath && pattern.test(entry.content)) {
          similar.push({ file: entry.path, reason: `also extends ${base}` });
        }
      }
    }
  }

  return {
    value: dedupeSimilar(similar),
    complete: context.inventory.corpusCoverageComplete,
  };
}

function dedupeSimilar(similar) {
  const seen = new Set();
  return similar.filter(s => {
    if (seen.has(s.file)) return false;
    seen.add(s.file);
    return true;
  }).slice(0, 15);
}

function emptyAnalysis(filePath) {
  return {
    file: filePath,
    dependents: [],
    dependencies: [],
    siblings: [],
    symbols: [],
    similar: [],
    sectionCompleteness: Object.fromEntries(SECTION_NAMES.map(section => [section, false])),
    complete: false,
    blastRadius: 0,
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function analyzeFile(filePath, context) {
  const analysis = emptyAnalysis(filePath);
  const stages = [
    ["dependents", getDependents],
    ["dependencies", getDependencies],
    ["siblings", getSiblings],
    ["symbols", getSymbols],
    ["similar", findSimilarFiles],
  ];
  for (const [section, analyze] of stages) {
    if (deadlineExpired(context.deadline, `${section}:${filePath}`)) continue;
    const result = analyze(filePath, context);
    analysis[section] = result.value;
    analysis.sectionCompleteness[section] = result.complete;
  }
  analysis.complete = SECTION_NAMES.every(section => analysis.sectionCompleteness[section]);
  analysis.blastRadius = new Set([
    ...analysis.dependents,
    ...analysis.siblings,
    ...analysis.similar.map(entry => entry.file),
  ]).size;
  return analysis;
}

function analyzeSymbol(filePath, symbolName, context) {
  const usages = getSymbolUsages(symbolName, filePath, context);
  return {
    symbol: symbolName,
    file: filePath,
    usages: usages.value,
    complete: usages.complete,
  };
}

function buildSearchMetadata(context, analyses, symbolAnalysis) {
  const complete = (
    context.inventory.complete &&
    !context.deadline.truncated &&
    analyses.every(analysis => analysis.complete) &&
    (!symbolAnalysis || symbolAnalysis.complete)
  );
  const sourceCoverageLimited = !context.inventory.sourceCoverageComplete;
  const enumerationLimited = !context.inventory.enumerationComplete && !context.deadline.truncated;
  const truncated = context.deadline.truncated || sourceCoverageLimited || enumerationLimited;
  return {
    complete,
    truncated,
    reason: (
      context.deadline.reason ||
      (sourceCoverageLimited ? "source_files_skipped" : null) ||
      (enumerationLimited ? "inventory_enumeration_incomplete" : null)
    ),
    stage: context.deadline.stage || (sourceCoverageLimited ? "inventory_load" : null) || (enumerationLimited ? "inventory_fallback" : null),
    budget_ms: context.deadline.budgetMs,
    elapsed_ms: Math.ceil(performance.now() - context.deadline.startedAt),
    scope: context.inventory.scope,
    tracked_files_seen: context.inventory.scope.startsWith("git_")
      ? context.inventory.rawPathCount
      : null,
    inventory_entries_seen: context.inventory.inventoryEntriesSeen,
    files_considered: context.inventory.eligiblePaths.length,
    files_loaded: context.inventory.corpus.length,
    files_excluded: context.inventory.scope.startsWith("git_")
      ? context.inventory.excludedEntries
      : null,
    entries_excluded: context.inventory.excludedEntries,
    binary_files_skipped: context.inventory.binaryFilesSkipped,
    oversized_files_skipped: context.inventory.oversizedFilesSkipped,
    unreadable_files_skipped: context.inventory.unreadableFilesSkipped,
    non_regular_files_skipped: context.inventory.nonRegularFilesSkipped,
    symbolic_links_skipped: context.inventory.symbolicLinksSkipped,
    fallback_unreadable_directories: context.inventory.fallbackUnreadableDirectories,
    max_text_file_bytes: MAX_TEXT_FILE_BYTES,
    max_targets: MAX_TARGETS,
    excluded_roots: [...EXCLUDED_PATH_SEGMENTS].sort(),
  };
}

function formatReport(analyses, symbolAnalysis = null, search = null) {
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════");
  lines.push("  BLAST RADIUS MAP");
  lines.push("══════════════════════════════════════════════════════════");
  lines.push("");

  if (search?.truncated) {
    if (search.reason === "budget_exhausted") {
      lines.push("  PARTIAL RESULTS — time budget exhausted");
      lines.push(`  Search stopped at: ${search.stage || "unknown"} (${search.elapsed_ms}ms / ${search.budget_ms}ms)`);
    } else {
      lines.push("  PARTIAL RESULTS — source corpus incomplete");
      lines.push(`  Search limitation: ${search.reason || "unknown"} at ${search.stage || "unknown"}`);
    }
    lines.push("");
  }

  for (const a of analyses) {
    if (!a) continue;

    lines.push(`  📄 ${a.file}`);
    lines.push(`  ${"─".repeat(50)}`);

    lines.push("");
    lines.push(`  ⬆️  DEPENDENTS (${a.dependents.length} files import this)${a.sectionCompleteness?.dependents ? "" : " [INCOMPLETE]"}:`);
    if (a.dependents.length === 0) {
      lines.push("     (none found)");
    } else {
      for (const d of a.dependents.slice(0, 15)) {
        lines.push(`     ${d}`);
      }
      if (a.dependents.length > 15) lines.push(`     ... and ${a.dependents.length - 15} more`);
    }

    lines.push("");
    lines.push(`  ⬇️  DEPENDENCIES (this file imports ${a.dependencies.length} modules)${a.sectionCompleteness?.dependencies ? "" : " [INCOMPLETE]"}:`);
    if (a.dependencies.length === 0) {
      lines.push("     (none found)");
    } else {
      for (const d of a.dependencies) {
        lines.push(`     ${d}`);
      }
    }

    lines.push("");
    lines.push(`  👥 SIBLINGS (${a.siblings.length} files in same directory)${a.sectionCompleteness?.siblings ? "" : " [INCOMPLETE]"}:`);
    if (a.siblings.length === 0) {
      lines.push("     (none)");
    } else {
      for (const s of a.siblings.slice(0, 10)) {
        lines.push(`     ${s}`);
      }
      if (a.siblings.length > 10) lines.push(`     ... and ${a.siblings.length - 10} more`);
    }

    lines.push("");
    lines.push(`  🔤 SYMBOLS (${a.symbols.length} functions/classes)${a.sectionCompleteness?.symbols ? "" : " [INCOMPLETE]"}:`);
    if (a.symbols.length === 0) {
      lines.push("     (none)");
    } else {
      for (const s of a.symbols.slice(0, 20)) {
        lines.push(`     L${s.line}: ${s.name}`);
      }
      if (a.symbols.length > 20) lines.push(`     ... and ${a.symbols.length - 20} more`);
    }

    lines.push("");
    lines.push(`  🔁 SIMILAR CODE (${a.similar.length} files with matching patterns)${a.sectionCompleteness?.similar ? "" : " [INCOMPLETE]"}:`);
    if (a.similar.length === 0) {
      lines.push("     (none)");
    } else {
      for (const s of a.similar) {
        lines.push(`     ${s.file}  (${s.reason})`);
      }
    }

    lines.push("");
    lines.push(`  📊 TOTAL BLAST RADIUS: ${a.blastRadius} files${a.complete ? "" : " (partial)"}`);
    lines.push("");
  }

  if (symbolAnalysis) {
    lines.push(`  🎯 SYMBOL USAGE: "${symbolAnalysis.symbol}" (from ${symbolAnalysis.file})${symbolAnalysis.complete ? "" : " [INCOMPLETE]"}`);
    lines.push(`  ${"─".repeat(50)}`);
    if (symbolAnalysis.usages.length === 0) {
      lines.push("     (not used outside this file)");
    } else {
      for (const u of symbolAnalysis.usages) {
        lines.push(`     ${u.file} (${u.matches} references)`);
      }
    }
    lines.push("");
  }

  const totalBlast = analyses.reduce((sum, a) => sum + (a?.blastRadius || 0), 0);
  lines.push("  ══════════════════════════════════════════════════════");
  lines.push("  GENERALIZE CHECKLIST — paste into findings.md:");
  lines.push("");
  lines.push("  ## Blast Radius Map");
  lines.push("");
  for (const a of analyses) {
    if (!a) continue;
    lines.push(`  ### ${a.file}`);
    lines.push(`  - Dependents: ${a.dependents.length} (${a.dependents.slice(0, 5).join(", ")}${a.dependents.length > 5 ? "..." : ""})${a.sectionCompleteness?.dependents ? "" : " [INCOMPLETE]"}`);
    lines.push(`  - Dependencies: ${a.dependencies.length}${a.sectionCompleteness?.dependencies ? "" : " [INCOMPLETE]"}`);
    lines.push(`  - Siblings: ${a.siblings.length}${a.sectionCompleteness?.siblings ? "" : " [INCOMPLETE]"}`);
    lines.push(`  - Similar: ${a.similar.length} (${a.similar.slice(0, 3).map(s => s.file).join(", ")}${a.similar.length > 3 ? "..." : ""})${a.sectionCompleteness?.similar ? "" : " [INCOMPLETE]"}`);
    lines.push(`  - Symbols: ${a.symbols.map(s => s.name).join(", ")}${a.sectionCompleteness?.symbols ? "" : " [INCOMPLETE]"}`);
    lines.push("");
  }
  lines.push(`  **Total blast radius: ${totalBlast} files to review during GENERALIZE${search?.truncated ? " (partial)" : ""}**`);
  lines.push("");

  const allDependents = new Set(analyses.flatMap(a => a?.dependents || []));
  const allSimilar = new Set(analyses.flatMap(a => a?.similar?.map(s => s.file) || []));
  if (allDependents.size > 0 || allSimilar.size > 0) {
    lines.push("  ## GENERALIZE Scan Targets");
    lines.push("");
    lines.push("  Files that MUST be checked for the same pattern/anti-pattern:");
    lines.push("");
    for (const f of [...allDependents, ...allSimilar]) {
      lines.push(`  - [ ] ${f}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--self-test") && (args.length !== 1 || args[0] !== "--self-test")) {
  console.error("ERROR: --self-test must be supplied alone.");
  process.exit(1);
}
if (args[0] === "--self-test") {
  const scriptPath = selfPath(import.meta.url);
  const tmp = makeSelfTestTemp("blast-radius");
  const nonGitTmp = makeSelfTestTemp("blast-radius-non-git");
  const primaryPath = "src/alpha-service.mjs";
  const selfTestStartedAt = performance.now();
  const selfTestDeadline = selfTestStartedAt + 26000;
  try {
    initGitRepo(tmp);
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "src", "reports"), { recursive: true });
    mkdirSync(join(tmp, "plans"), { recursive: true });
    mkdirSync(join(tmp, "reports"), { recursive: true });
    mkdirSync(join(tmp, "coverage"), { recursive: true });
    writeFileSync(join(tmp, primaryPath), `import { helper } from "./b.mjs";
export function alpha() { return helper(); }
`);
    writeFileSync(join(tmp, "src", "b.mjs"), `export function helper() { return 1; }\n`);
    writeFileSync(join(tmp, "src", "beta-service.mjs"), `export function beta() { return 2; }\n`);
    writeFileSync(join(tmp, "src", "binary.dat"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(tmp, "src", "c.mjs"), `import { alpha } from "./alpha-service.mjs";
console.log(alpha());
`);
    writeFileSync(join(tmp, "src", "reports", "nested-source.mjs"), `import { alpha } from "../alpha-service.mjs";\nalpha();\n`);
    writeFileSync(join(tmp, "plans", "generated-decoy.mjs"), `import { alpha } from "../src/alpha-service.mjs";\nalpha();\n`);
    writeFileSync(join(tmp, "reports", "generated-decoy.mjs"), `import { alpha } from "../src/alpha-service.mjs";\nalpha();\n`);
    writeFileSync(join(tmp, "coverage", "generated-decoy.mjs"), `import { alpha } from "../src/alpha-service.mjs";\nalpha();\n`);
    writeFileSync(join(tmp, "src", "untracked-decoy.mjs"), `import { alpha } from "./alpha-service.mjs";\nalpha();\n`);

    const fillerPaths = [];
    for (let index = 0; index < 320; index += 1) {
      const name = `src/dependent-${String(index).padStart(3, "0")}.mjs`;
      fillerPaths.push(name);
      writeFileSync(join(tmp, name), `import { alpha } from "./alpha-service.mjs";\nexport const value${index} = alpha();\n`);
    }

    const trackedSources = [
      primaryPath,
      "src/b.mjs",
      "src/beta-service.mjs",
      "src/binary.dat",
      "src/c.mjs",
      "src/reports/nested-source.mjs",
      ...fillerPaths,
    ];
    const addSources = runBin("git", ["add", "--", ...trackedSources], tmp);
    assertSelfTest(addSources.ok, "source fixture files are tracked", addSources.stderr || addSources.stdout);
    const addGenerated = runBin("git", ["add", "-f", "--", "plans/generated-decoy.mjs", "reports/generated-decoy.mjs", "coverage/generated-decoy.mjs"], tmp);
    assertSelfTest(addGenerated.ok, "generated-root decoys are force-tracked", addGenerated.stderr || addGenerated.stdout);

    const authorityContractResults = [];
    function recordAuthorityContract(label, condition, detail = "") {
      authorityContractResults.push({ label, passed: Boolean(condition), detail });
    }

    function runBlast(cliArgs, timeout = 12000, runCwd = tmp, envOverrides = {}) {
      const startedAt = performance.now();
      const aggregateRemaining = Math.max(1, Math.floor(selfTestDeadline - performance.now()));
      const proc = spawnSync(process.execPath, [scriptPath, ...cliArgs], {
        cwd: runCwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: Math.max(1, Math.min(timeout, aggregateRemaining)),
        maxBuffer: 8 * 1024 * 1024,
        env: plannerSelfTestEnv(envOverrides),
      });
      return {
        status: proc.status,
        signal: proc.signal,
        error: proc.error,
        stdout: proc.stdout || "",
        stderr: proc.stderr || "",
        elapsedMs: Math.ceil(performance.now() - startedAt),
      };
    }

    function assertNotTimedOut(result, label) {
      assertSelfTest(
        !result.error && !result.signal && result.status !== null,
        `${label} completes before the outer timeout`,
        `${result.error?.message || ""}\nstatus=${result.status} signal=${result.signal}\n${result.stderr}`,
      );
    }

    function assertFiveArrays(analysis, label) {
      for (const section of ["dependents", "dependencies", "siblings", "symbols", "similar"]) {
        assertSelfTest(Array.isArray(analysis?.[section]), `${label} retains ${section} array`, JSON.stringify(analysis));
      }
    }

    function assertFiveHeadings(output, label) {
      for (const heading of ["DEPENDENTS", "DEPENDENCIES", "SIBLINGS", "SYMBOLS", "SIMILAR CODE"]) {
        assertSelfTest(output.includes(heading), `${label} retains ${heading} heading`, output);
      }
    }

    const result = runBlast(["--json", "--budget-ms", "5000", primaryPath]);
    assertNotTimedOut(result, "complete JSON control");
    assertSelfTest(result.status === 0, "blast_radius complete JSON exits 0", result.stderr || result.stdout);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assertSelfTest(!!parsed, "blast_radius emits valid JSON", result.stdout);
    assertSelfTest(result.stdout.length > 8192, "complete JSON survives a payload larger than a pipe buffer", `bytes=${result.stdout.length}`);
    assertSelfTest(parsed?.truncated === false, "complete JSON is explicitly untruncated", result.stdout);
    assertSelfTest(parsed?.search?.complete === true, "complete JSON reports complete search", result.stdout);
    assertSelfTest(
      parsed?.search?.scope === "git_tracked_searchable_text_excluding_generated",
      "complete JSON reports bounded source scope",
      result.stdout,
    );
    assertSelfTest(parsed?.search?.budget_ms === 5000, "complete JSON reports the override budget", result.stdout);
    assertSelfTest(
      parsed?.search?.binary_files_skipped === 1,
      "complete JSON discloses binary files outside searchable-text scope",
      result.stdout,
    );
    assertFiveArrays(parsed?.analyses?.[0], "complete JSON");
    assertSelfTest(
      ["dependents", "dependencies", "siblings", "symbols", "similar"].every(
        section => parsed?.analyses?.[0]?.sectionCompleteness?.[section] === true,
      ),
      "complete JSON marks all five sections complete",
      result.stdout,
    );
    assertSelfTest(parsed?.analyses?.[0]?.dependencies?.includes("./b.mjs"), "blast_radius reports outbound dependencies", result.stdout);
    assertSelfTest(parsed?.analyses?.[0]?.dependents?.includes("src/c.mjs"), "blast_radius reports inbound dependents", result.stdout);
    assertSelfTest(parsed?.analyses?.[0]?.siblings?.includes("src/b.mjs"), "blast_radius reports sibling files", result.stdout);
    assertSelfTest(
      parsed?.analyses?.[0]?.symbols?.some(symbol => symbol.name === "alpha"),
      "blast_radius reports source symbols",
      result.stdout,
    );
    assertSelfTest(
      parsed?.analyses?.[0]?.similar?.some(entry => entry.file === "src/beta-service.mjs"),
      "blast_radius reports similar-name source files",
      result.stdout,
    );
    assertSelfTest(
      parsed?.analyses?.[0]?.dependents?.includes("src/reports/nested-source.mjs"),
      "blast_radius excludes generated roots without excluding nested source directories with the same name",
      result.stdout,
    );
    assertSelfTest(
      parsed?.analyses?.[0]?.dependents?.some(path => path.startsWith("src/dependent-")),
      "blast_radius retains tracked source dependents",
      result.stdout,
    );
    assertSelfTest(!result.stdout.includes("generated-decoy.mjs"), "blast_radius excludes tracked generated-root decoys", result.stdout);
    assertSelfTest(!result.stdout.includes("untracked-decoy.mjs"), "blast_radius excludes untracked decoys", result.stdout);

    const human = runBlast(["--budget-ms", "5000", primaryPath]);
    assertNotTimedOut(human, "complete human control");
    assertSelfTest(human.status === 0, "blast_radius complete human output exits 0", human.stderr || human.stdout);
    assertFiveHeadings(human.stdout, "complete human output");
    assertSelfTest(!human.stdout.includes("PARTIAL RESULTS"), "complete human output has no partial banner", human.stdout);

    for (const alias of ["--files", "--multi"]) {
      const multi = runBlast(["--json", "--budget-ms", "5000", alias, primaryPath, "src/b.mjs"]);
      assertNotTimedOut(multi, `${alias} multi-file control`);
      assertSelfTest(multi.status === 0, `${alias} exits 0`, multi.stderr || multi.stdout);
      let multiJson = null;
      try { multiJson = JSON.parse(multi.stdout); } catch { /* asserted below */ }
      assertSelfTest(!!multiJson, `${alias} emits valid JSON`, multi.stdout);
      assertSelfTest(
        JSON.stringify(multiJson?.analyses?.map(entry => entry.file)) === JSON.stringify([primaryPath, "src/b.mjs"]),
        `${alias} analyzes every requested file in input order`,
        multi.stdout,
      );
    }

    const duplicateTargets = runBlast([
      "--json",
      "--budget-ms",
      "5000",
      "--files",
      `./${primaryPath}`,
      primaryPath.replace("/", "//"),
      ...Array.from({ length: 800 }, () => primaryPath),
      "src/b.mjs",
    ]);
    assertNotTimedOut(duplicateTargets, "duplicate-target control");
    assertSelfTest(duplicateTargets.status === 0, "duplicate target list exits 0", duplicateTargets.stderr || duplicateTargets.stdout);
    let duplicateJson = null;
    try { duplicateJson = JSON.parse(duplicateTargets.stdout); } catch { /* asserted below */ }
    assertSelfTest(
      JSON.stringify(duplicateJson?.analyses?.map(entry => entry.file)) === JSON.stringify([primaryPath, "src/b.mjs"]),
      "duplicate target list is bounded and deduplicated in first-seen order",
      duplicateTargets.stdout,
    );

    const truncatedTargets = fillerPaths.slice(0, 160);
    const truncated = runBlast(["--json", "--budget-ms", "1", "--files", ...truncatedTargets]);
    assertNotTimedOut(truncated, "forced truncated JSON control");
    assertSelfTest(truncated.status === 2, "forced truncated JSON exits 2", truncated.stderr || truncated.stdout);
    assertSelfTest(truncated.stdout.length > 8192, "truncated JSON survives a payload larger than a pipe buffer", `bytes=${truncated.stdout.length}`);
    let truncatedJson = null;
    try { truncatedJson = JSON.parse(truncated.stdout); } catch { /* asserted below */ }
    assertSelfTest(!!truncatedJson, "forced truncated stdout remains valid JSON", truncated.stdout);
    assertSelfTest(truncatedJson?.truncated === true, "forced truncated JSON has a truncation marker", truncated.stdout);
    assertSelfTest(truncatedJson?.search?.complete === false, "forced truncated JSON reports incomplete search", truncated.stdout);
    assertSelfTest(truncatedJson?.search?.reason === "budget_exhausted", "forced truncated JSON reports its reason", truncated.stdout);
    assertSelfTest(!!truncatedJson?.search?.stage, "forced truncated JSON reports its stage", truncated.stdout);
    assertSelfTest(truncatedJson?.analyses?.length === truncatedTargets.length, "forced truncated JSON retains every requested target", truncated.stdout);
    for (const analysis of truncatedJson?.analyses || []) {
      assertFiveArrays(analysis, "forced truncated JSON");
    }
    assertSelfTest(
      (truncatedJson?.analyses || []).some(analysis =>
        ["dependents", "dependencies", "siblings", "symbols", "similar"].some(
          section => analysis?.sectionCompleteness?.[section] === false,
        )),
      "forced truncated JSON marks unfinished sections incomplete",
      truncated.stdout,
    );
    recordAuthorityContract(
      "timeout remains an honest exit-2 partial result",
      truncated.status === 2 &&
        truncatedJson?.truncated === true &&
        truncatedJson?.search?.complete === false &&
        truncatedJson?.search?.reason === "budget_exhausted",
      `status=${truncated.status} truncated=${truncatedJson?.truncated} complete=${truncatedJson?.search?.complete} reason=${truncatedJson?.search?.reason}`,
    );

    const truncatedHuman = runBlast(["--budget-ms", "1", "--files", ...truncatedTargets]);
    assertNotTimedOut(truncatedHuman, "forced truncated human control");
    assertSelfTest(truncatedHuman.status === 2, "forced truncated human output exits 2", truncatedHuman.stderr || truncatedHuman.stdout);
    assertSelfTest(
      truncatedHuman.stdout.includes("PARTIAL RESULTS — time budget exhausted"),
      "forced truncated human output has an unmistakable banner",
      truncatedHuman.stdout,
    );
    assertFiveHeadings(truncatedHuman.stdout, "forced truncated human output");

    const invalidCases = [
      [],
      ["--json", "--budget-ms"],
      ["--json", "--budget-ms", "not-a-number", primaryPath],
      ["--json", "--budget-ms", "0", primaryPath],
      ["--json", "--budget-ms", "-1", primaryPath],
      ["--json", "--budget-ms", "999999999999999999999999", primaryPath],
      ["--json", "--diff", "--files", primaryPath],
      ["--self-test", "--files", primaryPath],
      ["--json", "--files", ...Array.from({ length: MAX_TARGETS + 1 }, (_, index) => `src/unique-${index}.mjs`)],
      ["--json", "--budget-ms", "1", "--files", primaryPath, ...fillerPaths, "src/definitely-missing.mjs"],
    ];
    for (const invalidArgs of invalidCases) {
      const invalid = runBlast(invalidArgs);
      assertNotTimedOut(invalid, `invalid usage ${invalidArgs.join(" ")}`);
      assertSelfTest(invalid.status === 1, `invalid usage exits 1: ${invalidArgs.join(" ")}`, invalid.stderr || invalid.stdout);
    }

    for (const helpArgs of [["--help", "--definitely-invalid"], ["--definitely-invalid", "--help"]]) {
      const help = runBlast(helpArgs);
      assertNotTimedOut(help, `help precedence ${helpArgs.join(" ")}`);
      assertSelfTest(help.status === 0, `help exits 0 regardless of option order: ${helpArgs.join(" ")}`, help.stderr || help.stdout);
      assertSelfTest(help.stdout.includes("Usage:"), "help prints usage guidance", help.stdout);
    }

    const commitFixture = runBin("git", ["commit", "-m", "self-test baseline"], tmp);
    assertSelfTest(commitFixture.ok, "diff fixture baseline commits", commitFixture.stderr || commitFixture.stdout);
    writeFileSync(join(tmp, primaryPath), `import { helper } from "./b.mjs";
export function alpha() { return helper(); }
// unstaged shallow-repository diff control
`);
    const shallowDiff = runBlast(["--json", "--budget-ms", "5000", "--diff"]);
    assertNotTimedOut(shallowDiff, "shallow-repository unstaged diff control");
    assertSelfTest(shallowDiff.status === 0, "shallow-repository unstaged diff exits 0", shallowDiff.stderr || shallowDiff.stdout);
    let shallowDiffJson = null;
    try { shallowDiffJson = JSON.parse(shallowDiff.stdout); } catch { /* asserted below */ }
    assertSelfTest(
      JSON.stringify(shallowDiffJson?.analyses?.map(entry => entry.file)) === JSON.stringify([primaryPath]),
      "shallow-repository diff falls back to tracked staged and unstaged changes",
      shallowDiff.stdout,
    );

    const gitAuthorityDiagnostic = "ERROR: Git inventory unavailable in detected worktree; refusing filesystem fallback.";
    const missingGitPath = runBlast(
      ["--json", "--budget-ms", "5000", primaryPath],
      12000,
      tmp,
      { PATH: join(tmp, "missing-bin") },
    );
    assertNotTimedOut(missingGitPath, "detected-worktree missing-git control");
    recordAuthorityContract(
      "detected worktree fails closed when git cannot be spawned",
      missingGitPath.status === 1 &&
        missingGitPath.stdout === "" &&
        missingGitPath.stderr.includes(gitAuthorityDiagnostic) &&
        !`${missingGitPath.stdout}${missingGitPath.stderr}`.includes("untracked-decoy.mjs"),
      `status=${missingGitPath.status} stdout_bytes=${Buffer.byteLength(missingGitPath.stdout)} stable_diagnostic=${missingGitPath.stderr.includes(gitAuthorityDiagnostic)} ignored_leak=${`${missingGitPath.stdout}${missingGitPath.stderr}`.includes("untracked-decoy.mjs")}`,
    );

    const missingGitExhaustedBudget = runBlast(
      ["--json", "--budget-ms", "1", primaryPath],
      12000,
      tmp,
      { PATH: join(tmp, "missing-bin") },
    );
    assertNotTimedOut(missingGitExhaustedBudget, "detected-worktree missing-git exhausted-budget control");
    recordAuthorityContract(
      "detected worktree Git spawn failure outranks coincident budget exhaustion",
      missingGitExhaustedBudget.status === 1 &&
        missingGitExhaustedBudget.stdout === "" &&
        missingGitExhaustedBudget.stderr.includes(gitAuthorityDiagnostic) &&
        !`${missingGitExhaustedBudget.stdout}${missingGitExhaustedBudget.stderr}`.includes("untracked-decoy.mjs"),
      `status=${missingGitExhaustedBudget.status} stdout_bytes=${Buffer.byteLength(missingGitExhaustedBudget.stdout)} stable_diagnostic=${missingGitExhaustedBudget.stderr.includes(gitAuthorityDiagnostic)} ignored_leak=${`${missingGitExhaustedBudget.stdout}${missingGitExhaustedBudget.stderr}`.includes("untracked-decoy.mjs")}`,
    );

    const brokenIndexPath = join(tmp, "broken-git-index");
    writeFileSync(brokenIndexPath, "not-a-git-index\n");
    const gitExit128 = runBlast(
      ["--json", "--budget-ms", "5000", primaryPath],
      12000,
      tmp,
      { GIT_INDEX_FILE: brokenIndexPath },
    );
    assertNotTimedOut(gitExit128, "detected-worktree git-exit-128 control");
    recordAuthorityContract(
      "detected worktree fails closed on git exit 128",
      gitExit128.status === 1 &&
        gitExit128.stdout === "" &&
        gitExit128.stderr.includes(gitAuthorityDiagnostic) &&
        !`${gitExit128.stdout}${gitExit128.stderr}`.includes("untracked-decoy.mjs"),
      `status=${gitExit128.status} stdout_bytes=${Buffer.byteLength(gitExit128.stdout)} stable_diagnostic=${gitExit128.stderr.includes(gitAuthorityDiagnostic)} ignored_leak=${`${gitExit128.stdout}${gitExit128.stderr}`.includes("untracked-decoy.mjs")}`,
    );

    mkdirSync(join(nonGitTmp, "src"), { recursive: true });
    mkdirSync(join(nonGitTmp, "plans"), { recursive: true });
    writeFileSync(join(nonGitTmp, "src", "main.mjs"), `import { helper } from "./helper.mjs";\nexport function main() { return helper(); }\n`);
    writeFileSync(join(nonGitTmp, "src", "helper.mjs"), `export function helper() { return 1; }\n`);
    writeFileSync(join(nonGitTmp, "src", "consumer.mjs"), `import { main } from "./main.mjs";\nmain();\n`);
    writeFileSync(join(nonGitTmp, "plans", "generated-decoy.mjs"), `import { main } from "../src/main.mjs";\nmain();\n`);
    const fallbackResult = runBlast(["--json", "--budget-ms", "5000", "src/main.mjs"], 12000, nonGitTmp);
    assertNotTimedOut(fallbackResult, "bounded non-git fallback");
    assertSelfTest(fallbackResult.status === 0, "bounded non-git fallback exits 0", fallbackResult.stderr || fallbackResult.stdout);
    let fallbackJson = null;
    try { fallbackJson = JSON.parse(fallbackResult.stdout); } catch { /* asserted below */ }
    assertSelfTest(
      fallbackJson?.search?.scope === "filesystem_searchable_text_excluding_generated",
      "non-git fallback reports its filesystem scope",
      fallbackResult.stdout,
    );
    assertSelfTest(
      fallbackJson?.analyses?.[0]?.dependents?.includes("src/consumer.mjs"),
      "non-git fallback retains source relationships",
      fallbackResult.stdout,
    );
    assertSelfTest(!fallbackResult.stdout.includes("generated-decoy.mjs"), "non-git fallback excludes generated roots", fallbackResult.stdout);
    recordAuthorityContract(
      "true non-git directory retains bounded filesystem fallback",
      fallbackResult.status === 0 &&
        fallbackJson?.search?.scope === "filesystem_searchable_text_excluding_generated" &&
        fallbackJson?.analyses?.[0]?.dependents?.includes("src/consumer.mjs") &&
        !fallbackResult.stdout.includes("generated-decoy.mjs"),
      `status=${fallbackResult.status} scope=${fallbackJson?.search?.scope} retained_consumer=${fallbackJson?.analyses?.[0]?.dependents?.includes("src/consumer.mjs")}`,
    );

    const mcpPlanDir = join(tmp, "plans", "self-test-plan");
    mkdirSync(mcpPlanDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), "self-test-plan\n");
    writeFileSync(join(mcpPlanDir, "state.json"), `${JSON.stringify({ state: "EXPLORE" }, null, 2)}\n`);
    const mcpRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "check_adjacency",
        arguments: { files: [primaryPath, "src/b.mjs"] },
      },
    });
    const mcpStartedAt = performance.now();
    const mcpResult = spawnSync(process.execPath, [join(dirname(scriptPath), "..", "mcp_server.mjs")], {
      cwd: tmp,
      encoding: "utf-8",
      input: `Content-Length: ${Buffer.byteLength(mcpRequest)}\r\n\r\n${mcpRequest}`,
      timeout: Math.max(1, Math.min(12000, Math.floor(selfTestDeadline - performance.now()))),
      maxBuffer: 8 * 1024 * 1024,
      env: { ...plannerSelfTestEnv(), PLANNER_PROJECT_ROOT: tmp },
    });
    const mcpControl = {
      status: mcpResult.status,
      signal: mcpResult.signal,
      error: mcpResult.error,
      stdout: mcpResult.stdout || "",
      stderr: mcpResult.stderr || "",
      elapsedMs: Math.ceil(performance.now() - mcpStartedAt),
    };
    assertNotTimedOut(mcpControl, "MCP check_adjacency transport control");
    assertSelfTest(mcpControl.status === 0, "MCP check_adjacency transport exits 0", mcpControl.stderr || mcpControl.stdout);
    const mcpBodyStart = mcpControl.stdout.indexOf("\r\n\r\n");
    let mcpJson = null;
    try { mcpJson = JSON.parse(mcpControl.stdout.slice(mcpBodyStart + 4)); } catch { /* asserted below */ }
    const mcpText = mcpJson?.result?.content?.[0]?.text || "";
    assertSelfTest(mcpBodyStart >= 0 && !!mcpJson, "MCP check_adjacency returns framed JSON-RPC", mcpControl.stdout);
    assertSelfTest(
      mcpText.includes(`📄 ${primaryPath}`) && mcpText.includes("📄 src/b.mjs"),
      "MCP check_adjacency forwards every requested file through --files",
      mcpControl.stdout,
    );
    assertSelfTest(!mcpText.includes("PARTIAL RESULTS"), "MCP check_adjacency transport returns complete fixture output", mcpControl.stdout);
    recordAuthorityContract(
      "framed MCP check_adjacency preserves exit-0 content",
      mcpControl.status === 0 &&
        mcpJson?.result?.isError !== true &&
        mcpText.includes(`📄 ${primaryPath}`) &&
        mcpText.includes("📄 src/b.mjs"),
      `transport_status=${mcpControl.status} is_error=${mcpJson?.result?.isError === true} content_bytes=${Buffer.byteLength(mcpText)}`,
    );

    const mcpSpawnFixturePath = join(tmp, "mcp-spawn-fixture.cjs");
    writeFileSync(mcpSpawnFixturePath, `const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function fixtureSpawnSync(command, args, options) {
  if (Array.isArray(args) && String(args[0] || "").endsWith("blast_radius.mjs")) {
    const fixtureStatus = process.env.PLANNER_BLAST_FIXTURE_STATUS;
    const spawnFailed = fixtureStatus === "null";
    return {
      pid: 0,
      output: [],
      stdout: process.env.PLANNER_BLAST_FIXTURE_STDOUT || "",
      stderr: process.env.PLANNER_BLAST_FIXTURE_STDERR || "",
      status: spawnFailed ? null : Number(fixtureStatus),
      signal: null,
      error: spawnFailed ? Object.assign(new Error("fixture spawn failure"), { code: "ENOENT" }) : undefined,
    };
  }
  return originalSpawnSync.call(this, command, args, options);
};
syncBuiltinESMExports();
`);

    function runFramedMcpAdjacency(fixtureStatus, fixtureStdout, fixtureStderr) {
      const startedAt = performance.now();
      const proc = spawnSync(process.execPath, [join(dirname(scriptPath), "..", "mcp_server.mjs")], {
        cwd: tmp,
        encoding: "utf-8",
        input: `Content-Length: ${Buffer.byteLength(mcpRequest)}\r\n\r\n${mcpRequest}`,
        timeout: Math.max(1, Math.min(12000, Math.floor(selfTestDeadline - performance.now()))),
        maxBuffer: 8 * 1024 * 1024,
        env: plannerSelfTestEnv({
          NODE_OPTIONS: `--require=${mcpSpawnFixturePath}`,
          PLANNER_PROJECT_ROOT: tmp,
          PLANNER_BLAST_FIXTURE_STATUS: String(fixtureStatus),
          PLANNER_BLAST_FIXTURE_STDOUT: fixtureStdout,
          PLANNER_BLAST_FIXTURE_STDERR: fixtureStderr,
        }),
      });
      const control = {
        status: proc.status,
        signal: proc.signal,
        error: proc.error,
        stdout: proc.stdout || "",
        stderr: proc.stderr || "",
        elapsedMs: Math.ceil(performance.now() - startedAt),
      };
      const bodyStart = control.stdout.indexOf("\r\n\r\n");
      let json = null;
      try { json = JSON.parse(control.stdout.slice(bodyStart + 4)); } catch { /* recorded below */ }
      return {
        control,
        bodyStart,
        json,
        text: json?.result?.content?.[0]?.text || "",
      };
    }

    const mcpPartial = runFramedMcpAdjacency(
      2,
      "PARTIAL RESULTS — fixture budget exhausted\n",
      "",
    );
    recordAuthorityContract(
      "framed MCP check_adjacency preserves exit-2 partial content",
      mcpPartial.control.status === 0 &&
        mcpPartial.bodyStart >= 0 &&
        !!mcpPartial.json &&
        mcpPartial.json?.result?.isError !== true &&
        mcpPartial.text.includes("PARTIAL RESULTS — fixture budget exhausted"),
      `transport_status=${mcpPartial.control.status} framed=${mcpPartial.bodyStart >= 0} is_error=${mcpPartial.json?.result?.isError === true} text=${JSON.stringify(mcpPartial.text)}`,
    );

    const mcpHardError = runFramedMcpAdjacency(
      1,
      "IGNORED MCP RESULT PAYLOAD\n",
      "fixture git authority failure\n",
    );
    recordAuthorityContract(
      "framed MCP check_adjacency maps exit 1 to isError",
      mcpHardError.control.status === 0 &&
        mcpHardError.bodyStart >= 0 &&
        !!mcpHardError.json &&
        mcpHardError.json?.result?.isError === true &&
        mcpHardError.text.includes("fixture git authority failure") &&
        !mcpHardError.text.includes("IGNORED MCP RESULT PAYLOAD"),
      `transport_status=${mcpHardError.control.status} framed=${mcpHardError.bodyStart >= 0} is_error=${mcpHardError.json?.result?.isError === true} leaked_payload=${mcpHardError.text.includes("IGNORED MCP RESULT PAYLOAD")} text=${JSON.stringify(mcpHardError.text)}`,
    );

    const mcpSpawnError = runFramedMcpAdjacency(
      "null",
      "",
      "fixture spawn failure\n",
    );
    recordAuthorityContract(
      "framed MCP check_adjacency maps null child status to isError",
      mcpSpawnError.control.status === 0 &&
        mcpSpawnError.bodyStart >= 0 &&
        !!mcpSpawnError.json &&
        mcpSpawnError.json?.result?.isError === true &&
        mcpSpawnError.text.includes("fixture spawn failure"),
      `transport_status=${mcpSpawnError.control.status} framed=${mcpSpawnError.bodyStart >= 0} is_error=${mcpSpawnError.json?.result?.isError === true} text=${JSON.stringify(mcpSpawnError.text)}`,
    );

    const densePath = "src/dense-symbols.mjs";
    const denseContent = Array.from(
      { length: 30000 },
      (_, index) => `export function dense${String(index).padStart(5, "0")}() { return ${index}; }\n`,
    ).join("");
    assertSelfTest(
      Buffer.byteLength(denseContent) < MAX_TEXT_FILE_BYTES,
      "dense-symbol fixture remains inside the searchable source limit",
      `bytes=${Buffer.byteLength(denseContent)}`,
    );
    writeFileSync(join(tmp, densePath), denseContent);
    const addDense = runBin("git", ["add", "--", densePath], tmp);
    assertSelfTest(addDense.ok, "dense-symbol fixture is tracked", addDense.stderr || addDense.stdout);
    const denseResult = runBlast(["--json", "--budget-ms", "1000", densePath], 5000);
    assertNotTimedOut(denseResult, "dense-symbol adversarial control");
    assertSelfTest(
      denseResult.status === 0 || denseResult.status === 2,
      "dense-symbol adversarial control exits complete or explicit partial",
      denseResult.stderr || denseResult.stdout,
    );
    let denseJson = null;
    try { denseJson = JSON.parse(denseResult.stdout); } catch { /* asserted below */ }
    assertSelfTest(!!denseJson, "dense-symbol adversarial control emits parseable JSON", denseResult.stdout);
    assertSelfTest(
      denseResult.status !== 2 || denseJson?.search?.reason === "budget_exhausted",
      "dense-symbol budget exhaustion is explicit",
      denseResult.stdout,
    );

    let symlinkCreated = false;
    const symlinkPath = "src/generated-link.mjs";
    try {
      symlinkSync("../plans/generated-decoy.mjs", join(tmp, symlinkPath));
      const addSymlink = runBin("git", ["add", "--", symlinkPath], tmp);
      assertSelfTest(addSymlink.ok, "symlink fixture is tracked", addSymlink.stderr || addSymlink.stdout);
      symlinkCreated = true;
    } catch {
      // Some Windows environments cannot create symlinks without elevated privileges.
    }
    if (symlinkCreated) {
      const symlinkResult = runBlast(["--json", symlinkPath]);
      assertNotTimedOut(symlinkResult, "explicit symlink rejection");
      assertSelfTest(symlinkResult.status === 1, "explicit symlink target exits 1", symlinkResult.stderr || symlinkResult.stdout);
      assertSelfTest(
        symlinkResult.stderr.includes("Symbolic-link targets are outside the eligible source scope"),
        "explicit symlink rejection explains the scope boundary",
        symlinkResult.stderr,
      );
    }

    const oversizedPath = "src/oversized-source.mjs";
    const oversizedPrefix = `import { alpha } from "./alpha-service.mjs";\nalpha();\n`;
    writeFileSync(
      join(tmp, oversizedPath),
      oversizedPrefix + "x".repeat(MAX_TEXT_FILE_BYTES + 1024 - Buffer.byteLength(oversizedPrefix)),
    );
    const addOversized = runBin("git", ["add", "--", oversizedPath], tmp);
    assertSelfTest(addOversized.ok, "oversized source fixture is tracked", addOversized.stderr || addOversized.stdout);
    const oversizedResult = runBlast(["--json", "--budget-ms", "5000", primaryPath], 12000);
    assertNotTimedOut(oversizedResult, "oversized-source partial control");
    assertSelfTest(oversizedResult.status === 2, "oversized source prevents a false complete exit", oversizedResult.stderr || oversizedResult.stdout);
    let oversizedJson = null;
    try { oversizedJson = JSON.parse(oversizedResult.stdout); } catch { /* asserted below */ }
    assertSelfTest(!!oversizedJson, "oversized-source partial stdout remains valid JSON", oversizedResult.stdout);
    assertSelfTest(oversizedJson?.search?.reason === "source_files_skipped", "oversized-source partial reports its reason", oversizedResult.stdout);
    assertSelfTest(oversizedJson?.search?.oversized_files_skipped === 1, "oversized-source partial reports its counter", oversizedResult.stdout);
    assertSelfTest(
      oversizedJson?.search?.symbolic_links_skipped === (symlinkCreated ? 1 : 0),
      "source-corpus partial reports tracked symlink exclusions",
      oversizedResult.stdout,
    );
    assertSelfTest(
      oversizedJson?.analyses?.[0]?.sectionCompleteness?.dependents === false,
      "oversized-source partial marks corpus-dependent sections incomplete",
      oversizedResult.stdout,
    );
    assertSelfTest(
      !oversizedJson?.analyses?.[0]?.siblings?.includes(symlinkPath),
      "tracked symlinks never leak into sibling results",
      oversizedResult.stdout,
    );
    assertSelfTest(
      oversizedJson?.analyses?.[0]?.sectionCompleteness?.siblings === false,
      "tracked symlink omissions mark sibling coverage incomplete",
      oversizedResult.stdout,
    );
    const oversizedHuman = runBlast(["--budget-ms", "5000", primaryPath], 12000);
    assertNotTimedOut(oversizedHuman, "oversized-source human partial control");
    assertSelfTest(oversizedHuman.status === 2, "oversized-source human output exits 2", oversizedHuman.stderr || oversizedHuman.stdout);
    assertSelfTest(
      oversizedHuman.stdout.includes("PARTIAL RESULTS — source corpus incomplete"),
      "oversized-source human output has an unmistakable corpus banner",
      oversizedHuman.stdout,
    );
    assertFiveHeadings(oversizedHuman.stdout, "oversized-source human output");

    const expectedAuthorityContractCount = 9;
    const passedAuthorityContracts = authorityContractResults.filter(result => result.passed);
    const failedAuthorityContracts = authorityContractResults.filter(result => !result.passed);
    assertSelfTest(
      authorityContractResults.length === expectedAuthorityContractCount && failedAuthorityContracts.length === 0,
      `authority contract matrix: ${passedAuthorityContracts.length}/${expectedAuthorityContractCount} passed, ${failedAuthorityContracts.length} failed`,
      authorityContractResults
        .map(result => `[${result.passed ? "PASS" : "FAIL"}] ${result.label}${result.detail ? ` — ${result.detail}` : ""}`)
        .join("\n"),
    );

    assertSelfTest(
      performance.now() < selfTestDeadline,
      "blast_radius aggregate self-test completes inside 26 seconds",
      `elapsed_ms=${Math.ceil(performance.now() - selfTestStartedAt)}`,
    );
    printSelfTestPass("blast_radius");
  } finally {
    cleanupSelfTestTemp(tmp);
    cleanupSelfTestTemp(nonGitTmp);
  }
  process.exit(0);
}

function usageText() {
  return `Usage:
  node blast_radius.mjs <file> [symbol]                 Map one file
  node blast_radius.mjs --multi <f1> <f2> ...           Map multiple files
  node blast_radius.mjs --files <f1> <f2> ...           MCP-compatible alias for --multi
  node blast_radius.mjs --diff                          Map eligible files in the last git diff
  node blast_radius.mjs --json <file>                   Output as JSON
  node blast_radius.mjs --budget-ms <positive integer>  Override the ${DEFAULT_BUDGET_MS}ms invocation budget (max ${MAX_BUDGET_MS})

At most ${MAX_TARGETS} unique targets are accepted per invocation. Generated roots
(${[...EXCLUDED_PATH_SEGMENTS].sort().join(", ")}) and symlinks are excluded before
content loading. Exit 0 means complete, exit 1 means usage/input error, and exit 2
means explicit partial results after budget exhaustion or an incomplete source corpus.`;
}

function parseCliArgs(rawArgs) {
  const config = {
    jsonMode: false,
    diffMode: false,
    selector: null,
    operands: [],
    budgetMs: DEFAULT_BUDGET_MS,
    help: false,
    error: null,
  };
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    config.help = true;
    return config;
  }

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--json") {
      config.jsonMode = true;
    } else if (arg === "--diff") {
      if (config.diffMode) {
        config.error = "--diff may be supplied only once.";
        break;
      }
      config.diffMode = true;
    } else if (arg === "--multi" || arg === "--files") {
      if (config.selector) {
        config.error = `${arg} cannot be combined with ${config.selector}.`;
        break;
      }
      config.selector = arg;
    } else if (arg === "--budget-ms") {
      const rawBudget = rawArgs[index + 1];
      const parsedBudget = Number(rawBudget);
      if (
        rawBudget === undefined ||
        !/^\d+$/.test(rawBudget) ||
        !Number.isSafeInteger(parsedBudget) ||
        parsedBudget <= 0 ||
        parsedBudget > MAX_BUDGET_MS
      ) {
        config.error = `--budget-ms requires a positive integer no greater than ${MAX_BUDGET_MS}.`;
        break;
      }
      config.budgetMs = parsedBudget;
      index += 1;
    } else if (arg.startsWith("-")) {
      config.error = `Unknown option: ${arg}`;
      break;
    } else {
      config.operands.push(arg);
    }
  }

  if (config.error || config.help) return config;
  if (config.diffMode && (config.selector || config.operands.length > 0)) {
    config.error = "--diff cannot be combined with explicit file selectors or positional targets.";
    return config;
  }
  if (config.diffMode) return config;
  if (config.selector && config.operands.length === 0) {
    config.error = `${config.selector} requires at least one file.`;
    return config;
  }
  if (!config.selector && config.operands.length === 0) {
    config.error = "No file was supplied.";
    return config;
  }
  if (!config.selector && config.operands.length > 2) {
    config.error = "Multiple files require --multi or --files.";
    return config;
  }
  if (config.selector) {
    config.operands = [...new Set(config.operands.map(normalizeRepoPath))];
    if (config.operands.length > MAX_TARGETS) {
      config.error = `${config.selector} accepts at most ${MAX_TARGETS} unique files.`;
      return config;
    }
  }
  return config;
}

function validateExplicitPath(rawPath) {
  const repoPath = normalizeRepoPath(rawPath);
  if (!isEligibleRepoPath(repoPath)) {
    return { ok: false, error: `File is outside the eligible source scope: ${rawPath}` };
  }
  const absPath = join(cwd, repoPath);
  if (!existsSync(absPath)) {
    return { ok: false, error: `File not found: ${rawPath}` };
  }
  try {
    const stats = lstatSync(absPath);
    if (stats.isSymbolicLink()) {
      return { ok: false, error: `Symbolic-link targets are outside the eligible source scope: ${rawPath}` };
    }
    if (!stats.isFile()) {
      return { ok: false, error: `Not a regular file: ${rawPath}` };
    }
  } catch {
    return { ok: false, error: `Unable to inspect file: ${rawPath}` };
  }
  return { ok: true, path: repoPath };
}

function resolveDiffTargets(context) {
  let result = runGitBounded(["diff", "HEAD~1", "--name-only", "-z"], context.deadline, "diff_targets");
  if (!result.timedOut && (result.status !== 0 || !result.stdout)) {
    result = runGitBounded(["diff", "HEAD", "--name-only", "-z"], context.deadline, "diff_targets");
  }
  if (!result.timedOut && result.status !== 0) {
    result = runGitBounded(["diff", "--cached", "--name-only", "-z"], context.deadline, "diff_targets");
  }
  return [...new Set(result.stdout
    .split("\0")
    .map(normalizeRepoPath)
    .filter(Boolean)
    .filter(isEligibleRepoPath)
    .filter(path => existsSync(join(cwd, path)))
    .filter(path => !context.inventory.enumerationComplete || context.inventory.eligiblePathSet.has(path)))];
}

function runMain(rawArgs) {
  if (rawArgs.length === 0) {
    console.error(`ERROR: No file was supplied.\n\n${usageText()}`);
    return 1;
  }
  const config = parseCliArgs(rawArgs);
  if (config.help) {
    process.stdout.write(`${usageText()}\n`);
    return 0;
  }
  if (config.error) {
    console.error(`ERROR: ${config.error}\n\n${usageText()}`);
    return 1;
  }

  const deadline = createDeadline(config.budgetMs);
  let filesToAnalyze = [];
  let symbolName = null;
  if (!config.diffMode) {
    const explicitOperands = config.selector ? config.operands : config.operands.slice(0, 1);
    for (const operand of explicitOperands) {
      const validation = validateExplicitPath(operand);
      if (!validation.ok) {
        console.error(`ERROR: ${validation.error}`);
        return 1;
      }
      filesToAnalyze.push(validation.path);
      deadlineExpired(deadline, "input_validation");
    }
    if (!config.selector) {
      symbolName = config.operands[1] || null;
      if (symbolName && !/^\w+$/.test(symbolName)) {
        console.error(`ERROR: Symbol name "${symbolName}" contains invalid characters. Only word characters (a-z, A-Z, 0-9, _) are allowed.`);
        return 1;
      }
    }
  }

  const inventory = buildInventory(deadline);
  if (inventory.authorityError) {
    console.error(inventory.authorityError);
    return 1;
  }
  const context = { deadline, inventory };
  if (config.diffMode) {
    filesToAnalyze = resolveDiffTargets(context);
    if (filesToAnalyze.length > MAX_TARGETS) {
      console.error(`ERROR: Diff contains ${filesToAnalyze.length} eligible files; maximum is ${MAX_TARGETS}. Analyze a bounded subset with --files.`);
      return 1;
    }
  }

  if (inventory.enumerationComplete) {
    const untracked = filesToAnalyze.filter(path => !inventory.eligiblePathSet.has(path));
    if (untracked.length > 0) {
      console.error(`ERROR: File is not tracked in the eligible source scope: ${untracked.join(", ")}`);
      return 1;
    }
    if (!deadline.truncated) {
      const unsearchable = filesToAnalyze.filter(path => !inventory.corpusByPath.has(path));
      if (unsearchable.length > 0) {
        console.error(`ERROR: File is not readable searchable text: ${unsearchable.join(", ")}`);
        return 1;
      }
    }
  }

  if (filesToAnalyze.length === 0 && !deadline.truncated) {
    console.error("ERROR: No valid eligible files to analyze.");
    return 1;
  }

  const analyses = filesToAnalyze.map(path => analyzeFile(path, context));
  const symbolAnalysis = symbolName && filesToAnalyze.length > 0
    ? analyzeSymbol(filesToAnalyze[0], symbolName, context)
    : null;
  deadlineExpired(deadline, "render");
  let search = buildSearchMetadata(context, analyses, symbolAnalysis);

  if (config.jsonMode) {
    const buildPayload = () => JSON.stringify({
      truncated: search.truncated,
      search,
      analyses,
      symbolAnalysis,
    }, null, 2);
    let output = buildPayload();
    if (deadlineExpired(deadline, "render_json")) {
      search = buildSearchMetadata(context, analyses, symbolAnalysis);
      output = buildPayload();
    }
    process.stdout.write(`${output}\n`);
  } else {
    let output = formatReport(analyses, symbolAnalysis, search);
    if (deadlineExpired(deadline, "render_human")) {
      search = buildSearchMetadata(context, analyses, symbolAnalysis);
      output = formatReport(analyses, symbolAnalysis, search);
    }
    process.stdout.write(output);
  }
  return search.truncated ? 2 : 0;
}

process.exitCode = runMain(args);
