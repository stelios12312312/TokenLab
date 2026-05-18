#!/usr/bin/env node
// blast_radius.mjs — Deterministic dependency & similarity mapper
//
// Usage:
//   node blast_radius.mjs <file> [symbol]         Map dependencies for a file (optionally focused on a symbol)
//   node blast_radius.mjs --multi <f1> <f2> ...   Map dependencies for multiple files
//   node blast_radius.mjs --diff                   Map dependencies for all files in the last git diff
//   node blast_radius.mjs --json <file>            Output as JSON
//
// Produces a structured report:
//   1. DEPENDENTS    — who imports/requires/calls into this file
//   2. DEPENDENCIES  — what this file imports/requires/calls out to
//   3. SIBLINGS      — other files in the same directory
//   4. SYMBOL GRAPH  — if a symbol is specified, where it's used and what it calls
//   5. SIMILAR CODE  — files with similar naming/structural patterns
//
// Zero dependencies — Node 18+. Uses grep internally.

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, basename, extname, relative } from "path";
import { spawnSync } from "child_process";
import { debugLog } from "./lib/plan_utils.mjs";

const cwd = process.cwd();

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
// Core analysis functions
// ---------------------------------------------------------------------------

function safeGrep(pattern, searchPath, opts = "") {
  try {
    const args = ["-rn"];
    if (opts) args.push(...opts.split(/\s+/).filter(Boolean));
    args.push("--", pattern, searchPath);
    const proc = spawnSync("grep", args, { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 30000 });
    return (proc.stdout || "").trim();
  } catch (e) {
    debugLog("safeGrep", e.message);
    return "";
  }
}

function safeGrepL(pattern, searchPath) {
  try {
    const proc = spawnSync("grep", ["-rl", "--", pattern, searchPath], { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 30000 });
    return (proc.stdout || "").trim().split("\n").filter(Boolean);
  } catch (e) {
    debugLog("safeGrepL", e.message);
    return [];
  }
}

function getDependents(filePath) {
  const ext = extname(filePath);
  const bnNoExt = basename(filePath, ext);
  const bn = basename(filePath);
  const patterns = IMPORT_PATTERNS[ext];

  const dependents = new Set();

  // Search for imports of this file
  const searchPatterns = patterns?.inbound(bnNoExt) || [];
  searchPatterns.push(bn); // Also search for the full filename

  for (const pat of searchPatterns) {
    const files = safeGrepL(pat, cwd);
    for (const f of files) {
      const rel = relative(cwd, f);
      if (rel !== relative(cwd, filePath) && !rel.includes("node_modules") && !rel.includes(".git") && !rel.startsWith("plans/")) {
        dependents.add(rel);
      }
    }
  }

  return [...dependents].sort();
}

function getDependencies(filePath) {
  const ext = extname(filePath);
  const patterns = IMPORT_PATTERNS[ext];
  if (!patterns) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const deps = new Set();
    let match;
    const regex = new RegExp(patterns.outbound.source, patterns.outbound.flags);
    while ((match = regex.exec(content)) !== null) {
      // F-012 FIX: Include 4th capture group for re-exports (export { x } from './y')
      const dep = match[1] || match[2] || match[3] || match[4];
      if (dep) deps.add(dep);
    }
    return [...deps].sort();
  } catch {
    return [];
  }
}

function getSiblings(filePath) {
  const dir = dirname(filePath);
  try {
    const ext = extname(filePath);
    const bn = basename(filePath);
    return readdirSync(dir)
      .filter(f => {
        if (f === bn) return false;
        if (f.startsWith(".")) return false;
        const fExt = extname(f);
        // Include files with same extension, or common code extensions
        return fExt === ext || [".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".php"].includes(fExt);
      })
      .map(f => relative(cwd, join(dir, f)))
      .sort();
  } catch {
    return [];
  }
}

function getSymbols(filePath) {
  const ext = extname(filePath);
  const pattern = SYMBOL_PATTERNS[ext];
  if (!pattern) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const symbols = [];
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(content)) !== null) {
      const name = match[1] || match[2] || match[3];
      if (name && !name.startsWith("_") && name !== "constructor") {
        const lineNum = content.slice(0, match.index).split("\n").length;
        symbols.push({ name, line: lineNum });
      }
    }
    return symbols;
  } catch {
    return [];
  }
}

function getSymbolUsages(symbol, filePath) {
  const results = [];
  const output = safeGrep(`\\b${symbol}\\b`, cwd, "-l");
  const files = output.split("\n").filter(Boolean);
  const relTarget = relative(cwd, filePath);

  for (const f of files) {
    const rel = relative(cwd, f);
    if (rel === relTarget) continue;
    if (rel.includes("node_modules") || rel.includes(".git") || rel.startsWith("plans/")) continue;

    // Get the actual matching lines
    const lines = safeGrep(`\\b${symbol}\\b`, f);
    const matchCount = lines.split("\n").filter(Boolean).length;
    results.push({ file: rel, matches: matchCount });
  }

  return results.sort((a, b) => b.matches - a.matches).slice(0, 20);
}

function findSimilarFiles(filePath) {
  const bn = basename(filePath, extname(filePath));
  const ext = extname(filePath);
  const similar = [];

  // Strategy 1: Similar naming patterns (e.g., user_service.py → order_service.py)
  const parts = bn.split(/[_\-.]/).filter(p => p.length > 2);
  for (const part of parts) {
    const pattern = `*${part}*${ext}`;
    try {
      const proc = spawnSync("find", [cwd, "-name", pattern, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/plans/*"], {
        encoding: "utf-8", timeout: 15000
      });
      const found = (proc.stdout || "").trim().split("\n").filter(Boolean);
      for (const f of found) {
        const rel = relative(cwd, f);
        if (rel !== relative(cwd, filePath)) {
          similar.push({ file: rel, reason: `shares naming pattern: "${part}"` });
        }
      }
    } catch { /* ignore */ }
  }

  // Strategy 2: Files implementing the same base class/interface
  try {
    const content = readFileSync(filePath, "utf-8");
    // Python: class X(BaseClass)
    const pyMatch = content.match(/class\s+\w+\s*\((\w+)\)/);
    if (pyMatch) {
      const base = pyMatch[1];
      const users = safeGrepL(`class.*\\(${base}\\)`, cwd);
      for (const f of users) {
        const rel = relative(cwd, f);
        if (rel !== relative(cwd, filePath) && !rel.includes("node_modules")) {
          similar.push({ file: rel, reason: `also extends ${base}` });
        }
      }
    }
    // JS/TS: extends BaseClass
    const jsMatch = content.match(/class\s+\w+\s+extends\s+(\w+)/);
    if (jsMatch) {
      const base = jsMatch[1];
      const users = safeGrepL(`extends ${base}`, cwd);
      for (const f of users) {
        const rel = relative(cwd, f);
        if (rel !== relative(cwd, filePath) && !rel.includes("node_modules")) {
          similar.push({ file: rel, reason: `also extends ${base}` });
        }
      }
    }
  } catch { /* ignore */ }

  // Deduplicate
  const seen = new Set();
  return similar.filter(s => {
    if (seen.has(s.file)) return false;
    seen.add(s.file);
    return true;
  }).slice(0, 15);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function analyzeFile(filePath) {
  const absPath = join(cwd, filePath);
  if (!existsSync(absPath)) {
    console.error(`ERROR: File not found: ${filePath}`);
    return null;
  }

  const dependents = getDependents(absPath);
  const dependencies = getDependencies(absPath);
  const siblings = getSiblings(absPath);
  const symbols = getSymbols(absPath);
  const similar = findSimilarFiles(absPath);

  return {
    file: filePath,
    dependents,
    dependencies,
    siblings,
    symbols,
    similar,
    blastRadius: new Set([...dependents, ...siblings, ...similar.map(s => s.file)]).size,
  };
}

function analyzeSymbol(filePath, symbolName) {
  const absPath = join(cwd, filePath);
  const usages = getSymbolUsages(symbolName, absPath);
  return { symbol: symbolName, file: filePath, usages };
}

function printReport(analyses, symbolAnalysis = null) {
  console.log("══════════════════════════════════════════════════════════");
  console.log("  BLAST RADIUS MAP");
  console.log("══════════════════════════════════════════════════════════\n");

  for (const a of analyses) {
    if (!a) continue;

    console.log(`  📄 ${a.file}`);
    console.log(`  ${"─".repeat(50)}`);

    // Dependents
    console.log(`\n  ⬆️  DEPENDENTS (${a.dependents.length} files import this):`);
    if (a.dependents.length === 0) {
      console.log("     (none found)");
    } else {
      for (const d of a.dependents.slice(0, 15)) {
        console.log(`     ${d}`);
      }
      if (a.dependents.length > 15) console.log(`     ... and ${a.dependents.length - 15} more`);
    }

    // Dependencies
    console.log(`\n  ⬇️  DEPENDENCIES (this file imports ${a.dependencies.length} modules):`);
    if (a.dependencies.length === 0) {
      console.log("     (none found)");
    } else {
      for (const d of a.dependencies) {
        console.log(`     ${d}`);
      }
    }

    // Siblings
    console.log(`\n  👥 SIBLINGS (${a.siblings.length} files in same directory):`);
    if (a.siblings.length === 0) {
      console.log("     (none)");
    } else {
      for (const s of a.siblings.slice(0, 10)) {
        console.log(`     ${s}`);
      }
      if (a.siblings.length > 10) console.log(`     ... and ${a.siblings.length - 10} more`);
    }

    // Symbols
    if (a.symbols.length > 0) {
      console.log(`\n  🔤 SYMBOLS (${a.symbols.length} functions/classes):`);
      for (const s of a.symbols.slice(0, 20)) {
        console.log(`     L${s.line}: ${s.name}`);
      }
      if (a.symbols.length > 20) console.log(`     ... and ${a.symbols.length - 20} more`);
    }

    // Similar
    if (a.similar.length > 0) {
      console.log(`\n  🔁 SIMILAR CODE (${a.similar.length} files with matching patterns):`);
      for (const s of a.similar) {
        console.log(`     ${s.file}  (${s.reason})`);
      }
    }

    console.log(`\n  📊 TOTAL BLAST RADIUS: ${a.blastRadius} files`);
    console.log();
  }

  // Symbol analysis
  if (symbolAnalysis) {
    console.log(`  🎯 SYMBOL USAGE: "${symbolAnalysis.symbol}" (from ${symbolAnalysis.file})`);
    console.log(`  ${"─".repeat(50)}`);
    if (symbolAnalysis.usages.length === 0) {
      console.log("     (not used outside this file)");
    } else {
      for (const u of symbolAnalysis.usages) {
        console.log(`     ${u.file} (${u.matches} references)`);
      }
    }
    console.log();
  }

  // Summary for findings.md
  const totalBlast = analyses.reduce((sum, a) => sum + (a?.blastRadius || 0), 0);
  console.log("  ══════════════════════════════════════════════════════");
  console.log("  GENERALIZE CHECKLIST — paste into findings.md:\n");
  console.log("  ## Blast Radius Map\n");
  for (const a of analyses) {
    if (!a) continue;
    console.log(`  ### ${a.file}`);
    console.log(`  - Dependents: ${a.dependents.length} (${a.dependents.slice(0, 5).join(", ")}${a.dependents.length > 5 ? "..." : ""})`);
    console.log(`  - Dependencies: ${a.dependencies.length}`);
    console.log(`  - Siblings: ${a.siblings.length}`);
    console.log(`  - Similar: ${a.similar.length} (${a.similar.slice(0, 3).map(s => s.file).join(", ")}${a.similar.length > 3 ? "..." : ""})`);
    console.log(`  - Symbols: ${a.symbols.map(s => s.name).join(", ")}`);
    console.log();
  }
  console.log(`  **Total blast radius: ${totalBlast} files to review during GENERALIZE**\n`);

  // Actionable checklist
  const allDependents = new Set(analyses.flatMap(a => a?.dependents || []));
  const allSimilar = new Set(analyses.flatMap(a => a?.similar?.map(s => s.file) || []));
  if (allDependents.size > 0 || allSimilar.size > 0) {
    console.log("  ## GENERALIZE Scan Targets\n");
    console.log("  Files that MUST be checked for the same pattern/anti-pattern:\n");
    for (const f of [...allDependents, ...allSimilar]) {
      console.log(`  - [ ] ${f}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const diffMode = args.includes("--diff");
const multiMode = args.includes("--multi");
const filteredArgs = args.filter(a => !a.startsWith("--"));

if (args.length === 0 || args.includes("--help")) {
  console.log(`Usage:
  node blast_radius.mjs <file> [symbol]         Map dependencies for a file
  node blast_radius.mjs --multi <f1> <f2> ...   Map dependencies for multiple files
  node blast_radius.mjs --diff                   Map dependencies for git-changed files
  node blast_radius.mjs --json <file>            Output as JSON

Outputs: dependents, dependencies, siblings, symbols, similar code, and a
GENERALIZE checklist with all files that should be scanned for matching patterns.`);
  process.exit(0);
}

let filesToAnalyze = [];
let symbolName = null;

if (diffMode) {
  try {
    let diff = "";
    const proc1 = spawnSync("git", ["diff", "HEAD~1", "--name-only"], { encoding: "utf-8", timeout: 10000 });
    if (proc1.status === 0 && proc1.stdout) {
      diff = proc1.stdout.trim();
    } else {
      const proc2 = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf-8", timeout: 10000 });
      diff = (proc2.stdout || "").trim();
    }
    filesToAnalyze = diff.split("\n")
      .filter(f => f.trim() && existsSync(join(cwd, f)))
      .filter(f => !f.startsWith("plans/") && !f.includes("node_modules"));
  } catch {
    console.error("ERROR: Not a git repository or no changes found.");
    process.exit(1);
  }
} else if (multiMode) {
  filesToAnalyze = filteredArgs.filter(f => existsSync(join(cwd, f)));
} else {
  filesToAnalyze = [filteredArgs[0]];
  symbolName = filteredArgs[1] || null;
  // F-005 FIX: Validate symbol name to prevent regex injection in grep patterns
  if (symbolName && !/^\w+$/.test(symbolName)) {
    console.error(`ERROR: Symbol name "${symbolName}" contains invalid characters. Only word characters (a-z, A-Z, 0-9, _) are allowed.`);
    process.exit(1);
  }
}

if (filesToAnalyze.length === 0) {
  console.error("ERROR: No valid files to analyze.");
  process.exit(1);
}

const analyses = filesToAnalyze.map(f => analyzeFile(f));
const symAnalysis = symbolName ? analyzeSymbol(filesToAnalyze[0], symbolName) : null;

if (jsonMode) {
  console.log(JSON.stringify({ analyses, symbolAnalysis: symAnalysis }, null, 2));
} else {
  printReport(analyses, symAnalysis);
}
