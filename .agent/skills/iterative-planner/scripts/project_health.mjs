#!/usr/bin/env node
// project_health.mjs — Deterministic project health analyzer.
//
// Usage:
//   node project_health.mjs                     Full scan — all analyzers
//   node project_health.mjs --quick             Quick mode — only fast checks
//   node project_health.mjs --analyzer <name>   Single analyzer
//   node project_health.mjs --diff <ref>        Only files changed since <ref>
//   node project_health.mjs --json              Machine-readable JSON output
//   node project_health.mjs --out <path>        Save report to file
//   node project_health.mjs --list              List available analyzers
//   node project_health.mjs --help              Show usage
//
// Exit codes: 0 = no FAILs, 1 = at least one FAIL, 2 = script error.
// Zero dependencies — Node.js 18+.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync } from "fs";
import { join, dirname, resolve, relative, extname, basename, sep } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  getSkillPath, getPaths, readPointer, readFile, fileExists,
  parseSimpleYaml, matchGlob, walkDir
} from "./lib/plan_utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const skillPath = getSkillPath(import.meta.url);
const cwd = process.cwd();
const paths = getPaths(cwd);
const _isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  quick: args.includes("--quick"),
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("help"),
  list: args.includes("--list"),
  analyzer: null,
  diff: null,
  out: null,
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--analyzer" && args[i + 1]) flags.analyzer = args[++i];
  if (args[i] === "--diff" && args[i + 1]) flags.diff = args[++i];
  if (args[i] === "--out" && args[i + 1]) flags.out = args[++i];
}

if (_isMain && flags.help) {
  console.log(`project_health.mjs — Deterministic project health analyzer

Usage:
  node project_health.mjs                     Full scan — all analyzers
  node project_health.mjs --quick             Quick mode (fast checks only, <3s)
  node project_health.mjs --analyzer <name>   Run a single analyzer
  node project_health.mjs --diff <ref>        Scope to files changed since <ref>
  node project_health.mjs --json              Output JSON instead of markdown
  node project_health.mjs --out <path>        Save report to file (default: stdout)
  node project_health.mjs --list              List available analyzers

Exit codes: 0 = no FAILs, 1 = at least one FAIL, 2 = script error.

Analyzer YAML files are loaded from:
  1. <cwd>/.agent/analyzers/*.yaml       (project-specific overrides)
  2. <skill-path>/analyzers/*.yaml       (skill defaults)`);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Load analyzers from YAML
// ---------------------------------------------------------------------------

function loadAnalyzers() {
  const analyzers = new Map(); // name -> config (project overrides skill defaults)

  // Skill defaults
  const skillAnalyzersDir = join(skillPath, "analyzers");
  if (existsSync(skillAnalyzersDir)) {
    for (const f of readdirSync(skillAnalyzersDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))) {
      try {
        const text = readFileSync(join(skillAnalyzersDir, f), "utf-8");
        const config = parseSimpleYaml(text);
        config._source = "skill";
        config._file = f;
        analyzers.set(f.replace(/\.(yaml|yml)$/, ""), config);
      } catch (e) {
        console.error(`  ⚠️ Failed to parse analyzer ${f}: ${e.message}`);
      }
    }
  }

  // Project overrides
  const projectAnalyzersDir = join(cwd, ".agent", "analyzers");
  if (existsSync(projectAnalyzersDir)) {
    for (const f of readdirSync(projectAnalyzersDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))) {
      try {
        const text = readFileSync(join(projectAnalyzersDir, f), "utf-8");
        const config = parseSimpleYaml(text);
        config._source = "project";
        config._file = f;
        analyzers.set(f.replace(/\.(yaml|yml)$/, ""), config);
      } catch (e) {
        console.error(`  ⚠️ Failed to parse project analyzer ${f}: ${e.message}`);
      }
    }
  }

  return analyzers;
}

if (_isMain && flags.list) {
  const analyzers = loadAnalyzers();
  console.log(`Available analyzers (${analyzers.size}):\n`);
  for (const [key, config] of analyzers) {
    const quickTag = config.quick ? " [quick]" : "";
    const src = config._source === "project" ? " (project override)" : "";
    console.log(`  ${key.padEnd(25)} ${(config.name || "(no name)").padEnd(35)}${quickTag}${src}`);
  }
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Diff scoping
// ---------------------------------------------------------------------------

// Validate a git ref: allow commit hashes, HEAD, HEAD~N, branch names (no shell metacharacters).
// Rejects consecutive dots (..) and trailing .lock per git's own ref rules.
function safeGitRef(ref) {
  if (!ref || typeof ref !== "string") return null;
  const trimmed = ref.trim();
  // Allow: hex hashes, HEAD, HEAD~N, HEAD^, simple branch/tag names (alphanumeric, -, _, /, .)
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return trimmed;
  if (/^(HEAD)([~^]\d*)?$/.test(trimmed)) return trimmed;
  if (/^[a-zA-Z0-9_.\-/]+$/.test(trimmed) && !trimmed.includes("..") && !trimmed.endsWith(".lock")) return trimmed;
  return null;
}

function getChangedFiles(ref) {
  const safeRef = safeGitRef(ref);
  if (!safeRef) {
    console.error(`  ⚠️ Invalid or unsafe git ref '${ref}' — scanning all files`);
    return null;
  }
  try {
    const proc = spawnSync("git", ["diff", "--name-only", safeRef], {
      cwd, encoding: "utf-8", timeout: 10000,
    });
    if (proc.status !== 0) {
      console.error(`  ⚠️ git diff failed for ref '${safeRef}' — scanning all files`);
      return null;
    }
    return (proc.stdout || "").trim().split("\n").filter(Boolean);
  } catch {
    console.error(`  ⚠️ git diff failed for ref '${safeRef}' — scanning all files`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Analyzer implementations
// ---------------------------------------------------------------------------

function getFilesByGlobs(scanPaths, excludePaths) {
  const allFiles = walkDir(cwd, excludePaths || []);
  if (!scanPaths || scanPaths.length === 0) return allFiles;
  return allFiles.filter(f => scanPaths.some(p => matchGlob(p, f)));
}

// --- Type 1: doc_references ---

function analyzerDocReferences(config, diffFiles) {
  const findings = [];
  const scanPaths = config.scan_paths || ["README.md", "docs/**/*.md", ".agent/**/*.md"];
  const excludePaths = config.exclude_paths || ["node_modules/**", ".git/**"];
  const codeRoot = config.code_root || ".";

  // Get all markdown files to scan
  let mdFiles = getFilesByGlobs(scanPaths, excludePaths).filter(f => f.endsWith(".md"));
  if (diffFiles) mdFiles = mdFiles.filter(f => diffFiles.includes(f));

  const missing = new Map(); // path -> { locations: [], count: 0 }

  for (const mdFile of mdFiles) {
    const fullPath = join(cwd, mdFile);
    const content = readFile(fullPath);
    if (!content) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Extract markdown links: [text](path)
      const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
      let m;
      while ((m = linkRe.exec(line)) !== null) {
        const ref = m[2];
        checkRef(ref, mdFile, i + 1, codeRoot, missing);
      }

      // Extract inline code paths: `path/to/file.ext`
      const codeRe = /`([^`]+\.[a-zA-Z]{1,6})`/g;
      while ((m = codeRe.exec(line)) !== null) {
        const ref = m[1];
        // Only check things that look like file paths
        if (ref.includes("/") && !ref.includes(" ") && !ref.startsWith("http")) {
          checkRef(ref, mdFile, i + 1, codeRoot, missing);
        }
      }
    }
  }

  for (const [ref, info] of missing) {
    findings.push({
      analyzer: config.name || "Documentation Reference Check",
      severity: config.severity || "warn",
      message: `Stale reference: \`${ref}\` does not exist`,
      location: info.locations[0],
      count: info.count,
      details: info.count > 1
        ? `Also referenced in: ${info.locations.slice(1, 5).join(", ")}${info.count > 5 ? ` (+${info.count - 5} more)` : ""}`
        : undefined,
    });
  }

  return findings;
}

function checkRef(ref, mdFile, lineNum, codeRoot, missing) {
  // Skip URLs, anchors, data URIs, command-like strings
  if (/^(https?:|#|data:|mailto:|ftp:)/.test(ref)) return;
  if (ref.startsWith("file:///")) {
    // Absolute file URI
    const absPath = ref.replace("file:///", "/").split("#")[0];
    if (!existsSync(absPath)) {
      const short = absPath.length > 60 ? "..." + absPath.slice(-57) : absPath;
      addMissing(missing, short, `${mdFile}:${lineNum}`);
    }
    return;
  }
  // Skip common non-file patterns
  if (/^(npm |git |pip |node |python |docker )/.test(ref)) return;
  if (ref.includes("*") || ref.includes("{")) return; // Globs
  if (!ref.includes("/") && !ref.includes(".")) return; // Not a path
  // Skip template/placeholder paths (e.g., <role>, path/to/*, plan_YYYY-MM-DD_hex/)
  if (ref.includes("<") && ref.includes(">")) return; // Template variables like <role>
  if (/^path\//.test(ref)) return; // Documentation examples
  if (/plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+\//.test(ref)) return; // Example plan dirs
  // Skip runtime-created paths (created at plan bootstrap, not present in source tree)
  if (/^(\.claude\/settings(\.local)?\.json|\.cursor\/settings\.json|plans\/(FINDINGS|DECISIONS|LESSONS|annotation_review)\.md|plans\/knowledge\/|plans\/semantic_backlog\/|checkpoints\/|knowledge\/(index|mistakes|patterns|gotchas|parity-registry)\.md|reports\/(user_story_audit|regression_audit|remediation_queue|full_review_summary|stewardship)\b|reports\/sme_improvement\/(opportunity_queue\.json|recommendation_report\.md)\b|recipes\/(discovery_review\.(json|md)|entity_registry\.json|capability_registry\.json)\b|findings\/)/.test(ref)) return;
  // Skip example code paths used as illustrations in reference docs and workflow templates
  // (Ruby, Python, TypeScript examples that are not part of this project)
  if (/\.(rb|py|ts)$/.test(ref) && /^(lib\/|src\/|app\/|config\/initializers\/|test\/|tests\/|core\/|models\/)/.test(ref)) return;

  // Remove anchor
  const cleanRef = ref.split("#")[0];
  if (!cleanRef) return;

  // Try resolving relative to: (1) code root, (2) the markdown file's directory,
  // (3) the nearest skill root (e.g., .agent/skills/iterative-planner/).
  // Many docs use paths relative to their own directory or their skill's root.
  const fromRoot = resolve(cwd, codeRoot, cleanRef);
  const fromFile = resolve(cwd, dirname(mdFile), cleanRef);
  // Walk up from the file to find the nearest skill root (directory containing SKILL.md)
  let fromSkill = null;
  let fromSkillScriptLib = null;
  let dir = dirname(resolve(cwd, mdFile));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "SKILL.md"))) {
      fromSkill = resolve(dir, cleanRef);
      if (cleanRef.startsWith("lib/")) fromSkillScriptLib = resolve(dir, "scripts", cleanRef);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!existsSync(fromRoot) && !existsSync(fromFile) && !(fromSkill && existsSync(fromSkill)) && !(fromSkillScriptLib && existsSync(fromSkillScriptLib))) {
    addMissing(missing, cleanRef, `${mdFile}:${lineNum}`);
  }
}

function addMissing(missing, ref, location) {
  if (!missing.has(ref)) {
    missing.set(ref, { locations: [], count: 0 });
  }
  const entry = missing.get(ref);
  entry.count++;
  if (entry.locations.length < 10) entry.locations.push(location);
}

// --- Type 6: orphaned_capabilities ---

function analyzerOrphanedCapabilities(config, diffFiles) {
  const findings = [];
  const scanPaths = config.scan_paths || [".agent/skills/**/scripts/**/*.{mjs,py,sh}", ".agent/skills/**/prolog/**/*.pl", ".agent/workflows/**/*.md"];
  const excludePaths = config.exclude_paths || ["node_modules/**", ".git/**", "**/lib/**"];
  const referenceDocs = config.reference_docs || [
    "README.md",
    ".agent/ADAPTATION-GUIDE.md",
    ".agent/skills/**/README.md",
    ".agent/skills/**/SKILL.md",
    ".agent/skills/**/MIGRATION.md",
    ".agent/skills/**/references/**/*.md",
    ".agent/rules.md",
  ];

  // Get capability files to check
  let capabilities = getFilesByGlobs(scanPaths, excludePaths);
  if (diffFiles) {
    capabilities = capabilities.filter(f => diffFiles.includes(f));
  }

  // Read all reference contents
  const docFiles = getFilesByGlobs(referenceDocs, excludePaths).filter(f => f.endsWith(".md"));
  let allText = " ";
  for (const doc of docFiles) {
    const content = readFile(join(cwd, doc));
    if (content) allText += " " + content + " ";
  }

  for (const cap of capabilities) {
    const basenameExt = cap.replace(/\\/g, "/").split("/").pop(); // script.mjs
    const basenameNoExt = basenameExt.split(".")[0];               // script

    // Check if exact basename (e.g. `rule_engine.mjs`) is found in docs.
    // Workflow files are already documentation, so a real heading or front-matter
    // description counts as self-documenting even if no separate index lists them.
    const isWorkflow = cap.includes("workflows/");
    let isDocumented = isWorkflow
      ? allText.includes(basenameNoExt)
      : allText.includes(basenameExt);

    if (!isDocumented && isWorkflow) {
      const workflowText = readFile(join(cwd, cap)) || "";
      const hasHeading = /^#\s+\S/m.test(workflowText);
      const hasDescription = /^description:\s*\S/mi.test(workflowText);
      isDocumented = hasHeading || hasDescription || workflowText.toLowerCase().includes(`/${basenameNoExt.toLowerCase()}`);
    }

    if (!isDocumented) {
      findings.push({
        analyzer: config.name || "Orphaned Capabilities",
        severity: config.severity || "error",
        message: `Orphaned capability detected: \`${basenameExt}\` (${cap})`,
        location: cap,
        count: 1,
        details: "Not referenced in core documentation (README.md, SKILL.md, etc.). Process Blast Radius failure."
      });
    }
  }

  return findings;
}

// --- Type 2: grep_patterns ---

function analyzerGrepPatterns(config, diffFiles) {
  const findings = [];
  const scanPaths = config.scan_paths || ["src/**", "lib/**", "scripts/**"];
  const excludePaths = config.exclude_paths || ["node_modules/**", ".git/**", "dist/**"];
  const patterns = config.patterns || config.items || [];
  const maxPerPattern = 10;

  let allFiles = getFilesByGlobs(scanPaths, excludePaths);
  if (diffFiles) allFiles = allFiles.filter(f => diffFiles.includes(f));

  for (const patCfg of patterns) {
    const patStr = patCfg.pattern;
    if (!patStr) continue;

    let regex;
    try {
      regex = new RegExp(patStr);
      // F-016 FIX: Reject potentially catastrophic backtracking patterns
      // Test with a small input to catch obvious ReDoS before applying to large files
      const testInput = "a".repeat(30);
      const start = Date.now();
      testInput.match(regex);
      if (Date.now() - start > 100) {
        continue; // Pattern took >100ms on tiny input — likely catastrophic
      }
    } catch {
      continue;
    }

    const includeGlobs = patCfg.include || [];
    const excludeGlobs = patCfg.exclude || [];
    const contextExclude = patCfg.context_exclude || [];
    const label = patCfg.label || patStr;
    const severity = patCfg.severity || config.severity || "warn";

    let matchFiles = allFiles;
    if (includeGlobs.length > 0) {
      matchFiles = matchFiles.filter(f => includeGlobs.some(g => matchGlob(g, f)));
    }
    if (excludeGlobs.length > 0) {
      matchFiles = matchFiles.filter(f => !excludeGlobs.some(g => matchGlob(g, f)));
    }

    const matches = [];
    let totalCount = 0;

    for (const file of matchFiles) {
      const fullPath = join(cwd, file);
      // Skip large files
      try {
        const st = statSync(fullPath);
        if (st.size > 1024 * 1024) continue; // 1MB guard
      } catch { continue; }

      const content = readFile(fullPath);
      if (!content) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          // Context exclude: skip if line contains any excluded string
          if (contextExclude.length > 0 && contextExclude.some(ce => lines[i].includes(ce))) {
            continue;
          }
          totalCount++;
          if (matches.length < maxPerPattern) {
            matches.push(`${file}:${i + 1}`);
          }
        }
      }
    }

    if (totalCount > 0) {
      findings.push({
        analyzer: config.name || "Pattern Grep Scan",
        severity,
        message: label,
        location: matches[0],
        count: totalCount,
        details: totalCount > 1
          ? `${matches.length} shown${totalCount > matches.length ? ` (${totalCount} total)` : ""}. Also at: ${matches.slice(1, 5).join(", ")}${totalCount > 5 ? " ..." : ""}`
          : undefined,
      });
    }
  }

  return findings;
}

// --- Type 3: parity_registry ---

function analyzerParityRegistry(config) {
  const findings = [];
  const registryPath = resolve(cwd, config.registry_path || "plans/knowledge/parity-registry.md");
  const checks = config.checks || ["file_existence", "function_count"];

  if (!existsSync(registryPath)) {
    findings.push({
      analyzer: config.name || "Parity Registry Check",
      severity: "info",
      message: "No parity registry found. Consider creating plans/knowledge/parity-registry.md.",
      location: registryPath,
      count: 1,
    });
    return findings;
  }

  const content = readFile(registryPath);
  if (!content) return findings;

  // Parse PR-NNN entries
  const entries = [];
  const sections = content.split(/^## /gm);
  for (const section of sections) {
    const titleMatch = section.match(/^(PR-\d+)/);
    if (!titleMatch) continue;

    const id = titleMatch[1];
    const primaryMatch = section.match(/Primary:\s*`?([^\n`]+)/);
    const siblingsMatch = section.match(/Siblings?:\s*`?([^\n`]+)/);
    const invariantMatch = section.match(/Invariant:\s*([^\n]+)/);

    if (primaryMatch) {
      const primary = primaryMatch[1].trim();
      const siblings = siblingsMatch
        ? siblingsMatch[1].split(",").map(s => s.replace(/`/g, "").trim()).filter(Boolean)
        : [];
      entries.push({ id, primary, siblings, invariant: invariantMatch ? invariantMatch[1].trim() : "" });
    }
  }

  for (const entry of entries) {
    // File existence check
    if (checks.includes("file_existence")) {
      const primaryExists = existsSync(resolve(cwd, entry.primary));
      if (!primaryExists) {
        findings.push({
          analyzer: config.name || "Parity Registry Check",
          severity: config.severity || "fail",
          message: `${entry.id}: Primary file missing: ${entry.primary}`,
          location: entry.primary,
          count: 1,
        });
      }
      for (const sib of entry.siblings) {
        if (!existsSync(resolve(cwd, sib))) {
          findings.push({
            analyzer: config.name || "Parity Registry Check",
            severity: config.severity || "fail",
            message: `${entry.id}: Sibling file missing: ${sib}`,
            location: `${entry.primary} ↔ ${sib}`,
            count: 1,
          });
        }
      }
    }

    // Function count check
    if (checks.includes("function_count")) {
      const primaryPath = resolve(cwd, entry.primary);
      if (!existsSync(primaryPath)) continue;

      const primaryFns = countFunctions(primaryPath);
      for (const sib of entry.siblings) {
        const sibPath = resolve(cwd, sib);
        if (!existsSync(sibPath)) continue;
        const sibFns = countFunctions(sibPath);
        if (primaryFns > 0 && sibFns > 0) {
          const ratio = Math.abs(primaryFns - sibFns) / Math.max(primaryFns, sibFns);
          if (ratio > 0.2) {
            findings.push({
              analyzer: config.name || "Parity Registry Check",
              severity: config.severity || "fail",
              message: `${entry.id}: Function count mismatch — primary has ${primaryFns}, sibling has ${sibFns}`,
              location: `${entry.primary} ↔ ${sib}`,
              count: 1,
              details: `Difference: ${Math.abs(primaryFns - sibFns)} (${Math.round(ratio * 100)}% drift)`,
            });
          }
        }
      }
    }

    // Signature match check
    if (checks.includes("signature_match")) {
      const primaryPath = resolve(cwd, entry.primary);
      if (!existsSync(primaryPath)) continue;

      const primaryNames = extractFunctionNames(primaryPath);
      for (const sib of entry.siblings) {
        const sibPath = resolve(cwd, sib);
        if (!existsSync(sibPath)) continue;
        const sibNames = extractFunctionNames(sibPath);
        const inPrimaryOnly = primaryNames.filter(n => !sibNames.includes(n));
        const inSibOnly = sibNames.filter(n => !primaryNames.includes(n));
        if (inPrimaryOnly.length > 0) {
          findings.push({
            analyzer: config.name || "Parity Registry Check",
            severity: "warn",
            message: `${entry.id}: Functions in primary but not in sibling`,
            location: `${entry.primary} ↔ ${sib}`,
            count: inPrimaryOnly.length,
            details: `Missing from sibling: ${inPrimaryOnly.slice(0, 5).join(", ")}`,
          });
        }
      }
    }
  }

  return findings;
}

function countFunctions(filePath) {
  const content = readFile(filePath);
  if (!content) return 0;
  const ext = extname(filePath);
  let pattern;
  if (ext === ".py") pattern = /^\s*def\s+\w+\s*\(/gm;
  // F-013 FIX: Exclude JS keywords (if/for/while/switch/catch) from method-style match
  else if ([".js", ".ts", ".mjs", ".tsx", ".jsx"].includes(ext)) pattern = /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(|(?:async\s+)?(?!if|else|for|while|switch|catch|return|throw|new|typeof|delete|void)\w+\s*\([^)]*\)\s*\{)/gm;
  else if (ext === ".php") pattern = /function\s+\w+\s*\(/gm;
  else return 0;
  const matches = content.match(pattern);
  return matches ? matches.length : 0;
}

function extractFunctionNames(filePath) {
  const content = readFile(filePath);
  if (!content) return [];
  const ext = extname(filePath);
  const names = [];
  const lines = content.split("\n");
  for (const line of lines) {
    let m;
    if (ext === ".py") {
      m = line.match(/^\s*def\s+(\w+)\s*\(/);
    } else if ([".js", ".ts", ".mjs"].includes(ext)) {
      // F-014 FIX: Also extract method-style names to align with countFunctions
      m = line.match(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=|(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{)/);
    } else if (ext === ".php") {
      m = line.match(/function\s+(\w+)\s*\(/);
    }
    if (m) names.push(m[1] || m[2] || m[3]);
  }
  return names.filter(Boolean);
}

// --- Type 4: file_freshness ---

function analyzerFileFreshness(config) {
  const findings = [];
  const pairs = config.pairs || config.items || [];

  for (const pair of pairs) {
    const docPath = pair.doc;
    const watches = pair.watches || [];
    const thresholdDays = pair.threshold_days || 30;

    if (!docPath) continue;
    const fullDocPath = resolve(cwd, docPath);
    if (!existsSync(fullDocPath)) continue;

    // Get doc mtime
    const docMtime = getLastModified(fullDocPath);
    if (!docMtime) continue;

    // Get most recent code mtime
    const codeFiles = getFilesByGlobs(watches, []);
    let mostRecentCode = null;
    let mostRecentFile = null;
    for (const f of codeFiles) {
      const fp = join(cwd, f);
      const mtime = getLastModified(fp);
      if (mtime && (!mostRecentCode || mtime > mostRecentCode)) {
        mostRecentCode = mtime;
        mostRecentFile = f;
      }
    }

    if (!mostRecentCode) continue;

    const diffDays = (mostRecentCode - docMtime) / (1000 * 60 * 60 * 24);
    if (diffDays > thresholdDays) {
      const docAge = Math.round((Date.now() - docMtime) / (1000 * 60 * 60 * 24));
      const codeAge = Math.round((Date.now() - mostRecentCode) / (1000 * 60 * 60 * 24));
      findings.push({
        analyzer: config.name || "Documentation Freshness",
        severity: config.severity || "info",
        message: `${docPath} may be stale — code changed ${codeAge} day(s) ago, doc unchanged for ${docAge} day(s)`,
        location: docPath,
        count: 1,
        details: `Most recent code change: ${mostRecentFile} (${new Date(mostRecentCode).toISOString().split("T")[0]})`,
      });
    }
  }

  return findings;
}

function getLastModified(filePath) {
  // Try git first for accuracy
  if (existsSync(join(cwd, ".git"))) {
    try {
      const proc = spawnSync("git", ["log", "-1", "--format=%ct", "--", relative(cwd, filePath)], {
        cwd, encoding: "utf-8", timeout: 5000,
      });
      const ts = (proc.stdout || "").trim();
      if (ts) return parseInt(ts, 10) * 1000;
    } catch { /* fall through */ }
  }
  // Fall back to mtime
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

function runAnalyzers() {
  const startTime = Date.now();
  const analyzers = loadAnalyzers();
  const allFindings = [];
  let analyzersRan = 0;

  // Get diff-scoped files if requested
  const diffFiles = flags.diff ? getChangedFiles(flags.diff) : null;

  // Get current commit
  let commit = "unknown";
  try {
    const proc = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf-8", timeout: 5000 });
    if (proc.status === 0) commit = (proc.stdout || "").trim();
  } catch { /* not in git */ }

  for (const [key, config] of analyzers) {
    // Filter by name if --analyzer specified
    if (flags.analyzer && key !== flags.analyzer) continue;

    // Skip non-quick analyzers in --quick mode
    if (flags.quick && !config.quick) continue;

    // Skip disabled analyzers
    if (config.enabled === false) continue;

    try {
      let results = [];
      switch (config.type) {
        case "doc_references":
          results = analyzerDocReferences(config, diffFiles);
          break;
        case "orphaned_capabilities":
          results = analyzerOrphanedCapabilities(config, diffFiles);
          break;
        case "grep_patterns":
          results = analyzerGrepPatterns(config, diffFiles);
          break;
        case "parity_registry":
          results = analyzerParityRegistry(config);
          break;
        case "file_freshness":
          results = analyzerFileFreshness(config);
          break;
        default:
          console.error(`  ⚠️ Unknown analyzer type: ${config.type} (in ${config._file})`);
          continue;
      }
      allFindings.push(...results);
      analyzersRan++;
    } catch (e) {
      console.error(`  ⚠️ Analyzer '${key}' failed: ${e.message}`);
    }
  }

  // ── Story registry coverage check ──────────────────────────────────────────
  // Warn when the project has no story_registry.json or fewer stories than the
  // minimum threshold (default 3, overridable via audit.config.json min_stories).
  try {
    const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
    let minStories = 3;
    const auditConfigPath = join(cwd, "audit.config.json");
    if (existsSync(auditConfigPath)) {
      try {
        const ac = JSON.parse(readFileSync(auditConfigPath, "utf-8"));
        if (typeof ac.min_stories === "number") minStories = ac.min_stories;
      } catch { /* non-fatal */ }
    }

    if (!existsSync(registryPath)) {
      allFindings.push({
        analyzer: "story_coverage",
        severity: "warn",
        message: "No story_registry.json found — story coverage unknown",
        location: "reports/user_story_audit/story_registry.json",
        details: `Run: node ${join(".agent/skills/iterative-planner/scripts", "story_registry_bootstrap.mjs")} to bootstrap draft stories from annotations and persona findings`,
      });
    } else {
      try {
        const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
        const stories = [
          ...(Array.isArray(reg.stories) ? reg.stories : []),
          ...(Array.isArray(reg.infrastructure_stories) ? reg.infrastructure_stories : []),
        ];
        if (stories.length < minStories) {
          allFindings.push({
            analyzer: "story_coverage",
            severity: "warn",
            message: `Only ${stories.length} story/stories registered — minimum recommended is ${minStories}`,
            location: "reports/user_story_audit/story_registry.json",
            details: "Run story_registry_bootstrap.mjs to add candidates from annotations and persona findings, or add `@planner:module = ...` / `@planner:capability = ...` annotations to key source files",
          });
        }
      } catch { /* corrupted registry — ignore */ }
    }
  } catch { /* non-fatal */ }

  // ── Red-team artifact contract check ──────────────────────────────────────
  try {
    const antiPatternsMd = join(cwd, "reports", "red_team_audit", "anti_patterns.md");
    const antiPatternsJson = join(cwd, "reports", "red_team_audit", "anti_patterns.json");

    if (existsSync(antiPatternsMd) && !existsSync(antiPatternsJson)) {
      allFindings.push({
        analyzer: "red_team_artifacts",
        severity: "warn",
        message: "anti_patterns.md exists without anti_patterns.json — machine-readable red-team artifact drift",
        location: "reports/red_team_audit/anti_patterns.json",
        details: "Regenerate the red-team packet so the markdown mirror and machine-readable anti-pattern artifact ship together.",
      });
    } else if (existsSync(antiPatternsJson)) {
      try {
        const parsed = JSON.parse(readFileSync(antiPatternsJson, "utf-8"));
        if (!Array.isArray(parsed?.anti_patterns)) {
          allFindings.push({
            analyzer: "red_team_artifacts",
            severity: "warn",
            message: "anti_patterns.json is present but missing an anti_patterns array",
            location: "reports/red_team_audit/anti_patterns.json",
            details: "Expected shape: { \"anti_patterns\": [...] }",
          });
        }
      } catch {
        allFindings.push({
          analyzer: "red_team_artifacts",
          severity: "warn",
          message: "anti_patterns.json is unreadable JSON",
          location: "reports/red_team_audit/anti_patterns.json",
          details: "Repair the machine-readable red-team artifact so downstream routing can consume it.",
        });
      }
    }
  } catch { /* non-fatal */ }

  const duration = Date.now() - startTime;

  // Build summary
  const summary = { fail: 0, warn: 0, info: 0 };
  for (const f of allFindings) {
    if (f.severity === "fail") summary.fail++;
    else if (f.severity === "warn") summary.warn++;
    else summary.info++;
  }

  // Sort: fail first, then warn, then info
  const severityOrder = { fail: 0, warn: 1, info: 2 };
  allFindings.sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));

  const report = {
    output_schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    commit,
    duration_ms: duration,
    analyzers_ran: analyzersRan,
    summary,
    findings: allFindings,
  };

  return report;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatMarkdown(report) {
  const lines = [];
  lines.push("# Project Health Report");
  lines.push(`Generated: ${report.generated_at} | Commit: ${report.commit} | Analyzers: ${report.analyzers_ran} ran | Time: ${(report.duration_ms / 1000).toFixed(1)}s`);
  lines.push("");

  const fails = report.findings.filter(f => f.severity === "fail");
  const warns = report.findings.filter(f => f.severity === "warn");
  const infos = report.findings.filter(f => f.severity === "info");

  if (fails.length > 0) {
    lines.push(`## ❌ Failures (${fails.length})`);
    lines.push("| # | Analyzer | Finding | Location |");
    lines.push("|---|----------|---------|----------|");
    fails.forEach((f, i) => {
      lines.push(`| ${i + 1} | ${f.analyzer} | ${f.message} | ${f.location || "—"} |`);
    });
    lines.push("");
  }

  if (warns.length > 0) {
    lines.push(`## ⚠️ Warnings (${warns.length})`);
    lines.push("| # | Analyzer | Finding | Location | Count |");
    lines.push("|---|----------|---------|----------|-------|");
    warns.forEach((f, i) => {
      lines.push(`| ${i + 1} | ${f.analyzer} | ${f.message} | ${f.location || "—"} | ${f.count || "—"} |`);
    });
    lines.push("");
  }

  if (infos.length > 0) {
    lines.push(`## ℹ️ Info (${infos.length})`);
    lines.push("| # | Analyzer | Finding | Location | Count |");
    lines.push("|---|----------|---------|----------|-------|");
    infos.forEach((f, i) => {
      lines.push(`| ${i + 1} | ${f.analyzer} | ${f.message} | ${f.location || "—"} | ${f.count || "—"} |`);
    });
    lines.push("");
  }

  lines.push("## Summary");
  lines.push(`- **Fail**: ${report.summary.fail} | **Warn**: ${report.summary.warn} | **Info**: ${report.summary.info}`);
  lines.push(`- Time: ${(report.duration_ms / 1000).toFixed(1)}s`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point — guarded so the IIFE does NOT run when imported as a module.
// Without this guard, the async IIFE fires on every import(), prints the health
// report to stdout, then set an exit code — disrupting importing processes
// (e.g. transition.mjs) before their own gate checks can run.
// ---------------------------------------------------------------------------
if (_isMain && !flags.help && !flags.list) (async () => {
  try {
    const report = runAnalyzers();

    // -----------------------------------------------------------------------
    // Role-specific auditors (mandatory — at least one persona pack required)
    // -----------------------------------------------------------------------
    try {
      const { loadAuditConfig, loadRolePacks, buildProjectContext, runRoleAuditors, enforceMinimumPersona } =
        await import("./audit_runner.mjs");

      const auditConfig  = loadAuditConfig(cwd) || { roles: ["core"], fail_on: ["HIGH", "CRITICAL"], role_options: {} };
      let   packs        = await loadRolePacks(auditConfig, skillPath);
      const context      = await buildProjectContext(cwd, skillPath, auditConfig);
      packs              = await enforceMinimumPersona(packs, context);
      const roleFindings = await runRoleAuditors(context, packs);

      // Merge role findings into report (same shape as core findings)
      report.findings.push(...roleFindings);
      for (const f of roleFindings) {
        if (f.severity === "fail")       report.summary.fail++;
        else if (f.severity === "warn")  report.summary.warn++;
        else                             report.summary.info++;
      }

      // Re-sort: fail first, then warn, then info
      const severityOrder = { fail: 0, warn: 1, info: 2 };
      report.findings.sort((a, b) =>
        (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));
    } catch (roleErr) {
      // Role auditor infrastructure errors should be visible, not silently swallowed
      console.error(`  ⚠️ Role auditor error: ${roleErr.message}`);
      if (process.env.DEBUG) {
        console.error(`  [role-audit] ${roleErr.stack}`);
      }
    }
    // -----------------------------------------------------------------------

    const output = flags.json ? JSON.stringify(report, null, 2) : formatMarkdown(report);

    if (flags.out) {
      // F-015 FIX: Validate --out path stays within project directory
      const resolvedOut = resolve(cwd, flags.out);
      if (!resolvedOut.startsWith(realpathSync(cwd) + sep)) {
        console.error("ERROR: --out path must be within the project directory");
        process.exitCode = 2;
        return;
      }
      writeFileSync(resolvedOut, output);
      if (!flags.json) {
        console.log(`✅ Health report saved to ${flags.out}`);
        console.log(`   Fail: ${report.summary.fail} | Warn: ${report.summary.warn} | Info: ${report.summary.info}`);
      }
    } else {
      console.log(output);
    }

    process.exitCode = report.summary.fail > 0 ? 1 : 0;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exitCode = 2;
  }
})();

// ---------------------------------------------------------------------------
// Exported for transition.mjs integration
// ---------------------------------------------------------------------------

export { runAnalyzers, formatMarkdown };
