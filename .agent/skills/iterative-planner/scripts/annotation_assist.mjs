#!/usr/bin/env node
// annotation_assist.mjs — Agent-assisted @planner: annotation bootstrapper.
//
// Scans a project, infers relationships (imports, validation modules, config
// flags, story links, consumer wiring), cross-references with story_registry
// and plan.md, and outputs a ready-to-apply annotation plan.
//
// Usage:
//   node annotation_assist.mjs                         Scan cwd, output report
//   node annotation_assist.mjs --dir <path>            Override project directory
//   node annotation_assist.mjs --json                  Output as JSON
//   node annotation_assist.mjs --apply                 Write annotations into files
//   node annotation_assist.mjs --dry-run               Show what --apply would do
//
// The output is a per-file list of suggested annotations with confidence levels,
// ready for human review before applying.

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, resolve, relative, extname, basename, dirname } from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COMMENT_STYLE = {
  ".py":   "#",
  ".js":   "//",
  ".mjs":  "//",
  ".ts":   "//",
  ".tsx":  "//",
  ".pl":   "%%",
  ".rs":   "//",
  ".go":   "//",
  ".rb":   "#",
  ".sh":   "#",
  ".yaml": "#",
  ".yml":  "#",
  ".toml": "#",
  ".r":    "#",
  ".jl":   "#",
  ".php":  "//",
  ".java": "//",
  ".c":    "//",
  ".cpp":  "//",
  ".h":    "//",
  ".swift":"//",
  ".kt":   "//",
};

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv",
  "dist", "build", ".next", "target", ".tox", "coverage",
  ".agent", "plans", "vendor",
]);

// Heuristic signals for classification
const VALIDATION_SIGNALS = [
  /\bvalidat(e|ion|or)\b/i, /\bcalibrat(e|ion)\b/i, /\baccuracy\b/i,
  /\bprecision\b/i, /\brecall\b/i, /\bf1.score\b/i, /\bbacktest\b/i,
  /\bsanity.check\b/i, /\bquality.check\b/i, /\bconfusion.matrix\b/i,
  /\bmetric/i, /\bassert.*quality\b/i, /\bcheck.*output\b/i,
  /\bverif(y|ication)\b/i, /\bcross.val/i, /\bholdout\b/i,
];

const TEST_SIGNALS = [
  /\btest_/i, /\b_test\b/i, /\bspec\b/i, /\btest\b.*\bcase\b/i,
  /\bpytest\b/i, /\bdescribe\(/i, /\bit\(/i, /\bexpect\(/i,
  /\bassert\b/i, /\bunittest\b/i,
];

const CONFIG_SIGNALS = [
  /\bconfig\b/i, /\bsettings?\b/i, /\bparameters?\b/i,
  /\bhyperparams?\b/i, /\bflags?\b/i,
];

const MODEL_SIGNALS = [
  /\bmodel\b/i, /\bpredict\b/i, /\bclassif(y|ier)\b/i,
  /\bregress(or|ion)\b/i, /\btrain\b/i, /\binference\b/i,
  /\bfit\b/i, /\bpipeline\b/i, /\bestimator\b/i,
];

// ---------------------------------------------------------------------------
// File scanner
// ---------------------------------------------------------------------------

function walkProject(dir, baseDir, files = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    if (entry.startsWith(".")) continue;

    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isDirectory()) {
      walkProject(fullPath, baseDir, files);
    } else if (stat.isFile()) {
      const ext = extname(entry);
      if (COMMENT_STYLE[ext]) {
        files.push(relative(baseDir, fullPath));
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Import / dependency graph builder
// ---------------------------------------------------------------------------

function extractImports(content, ext) {
  const imports = [];

  // Python: import X, from X import Y
  if (ext === ".py") {
    for (const m of content.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) {
      imports.push(m[1].replace(/\./g, "/"));
    }
  }

  // JS/TS: import ... from "X", require("X")
  if ([".js", ".mjs", ".ts", ".tsx"].includes(ext)) {
    for (const m of content.matchAll(/(?:from|require\()\s*["']([^"']+)["']/gm)) {
      imports.push(m[1]);
    }
  }

  // Go: import "X"
  if (ext === ".go") {
    for (const m of content.matchAll(/import\s+(?:\([\s\S]*?\)|"([^"]+)")/gm)) {
      if (m[1]) imports.push(m[1]);
    }
  }

  // PHP: require/include/use
  if (ext === ".php") {
    for (const m of content.matchAll(/(?:require|include)(?:_once)?\s*[\(]?\s*["']([^"']+)["']/gm)) {
      imports.push(m[1]);
    }
    for (const m of content.matchAll(/^\s*use\s+([\w\\]+)/gm)) {
      imports.push(m[1].replace(/\\/g, "/"));
    }
  }

  return imports;
}

function buildImportGraph(files, baseDir) {
  const graph = {}; // file -> [imported files]
  const reverseGraph = {}; // file -> [files that import it]

  for (const f of files) {
    const fullPath = join(baseDir, f);
    let content;
    try { content = readFileSync(fullPath, "utf-8"); } catch { continue; }

    const ext = extname(f);
    const imports = extractImports(content, ext);
    graph[f] = [];

    for (const imp of imports) {
      // Try to resolve import to a project file
      const candidates = files.filter(pf => {
        const pfNoExt = pf.replace(/\.[^.]+$/, "");
        const impNorm = imp.replace(/^\.\//, "");
        return pf === imp || pf === `${imp}${ext}` || pfNoExt === impNorm ||
               pf.endsWith(`/${impNorm}${ext}`) || pf.endsWith(`/${impNorm}/index${ext}`) ||
               pf.endsWith(`${impNorm}.py`) || pf.endsWith(`${impNorm}.mjs`);
      });
      for (const c of candidates) {
        graph[f].push(c);
        if (!reverseGraph[c]) reverseGraph[c] = [];
        reverseGraph[c].push(f);
      }
    }
  }

  return { graph, reverseGraph };
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function classifyFile(filePath, content) {
  const name = basename(filePath).toLowerCase();
  const dir = dirname(filePath).toLowerCase();
  const classes = new Set();
  const confidence = {};

  // Path-based signals
  if (/test|spec/.test(name) || /tests?\//.test(dir)) {
    classes.add("test");
    confidence.test = "high";
  }
  if (/valid|calibr|backtest|sanity|quality/.test(name) || /validat/.test(dir)) {
    classes.add("validation");
    confidence.validation = "high";
  }
  if (/config|settings|params/.test(name) || /config/.test(dir)) {
    classes.add("config");
    confidence.config = "high";
  }

  // Content-based signals
  const lines = content.split("\n").slice(0, 100); // scan first 100 lines
  const fullScan = content.slice(0, 10000);

  let validationHits = 0;
  let testHits = 0;
  let configHits = 0;
  let modelHits = 0;

  for (const sig of VALIDATION_SIGNALS) { if (sig.test(fullScan)) validationHits++; }
  for (const sig of TEST_SIGNALS) { if (sig.test(fullScan)) testHits++; }
  for (const sig of CONFIG_SIGNALS) { if (sig.test(fullScan)) configHits++; }
  for (const sig of MODEL_SIGNALS) { if (sig.test(fullScan)) modelHits++; }

  if (validationHits >= 3 && !classes.has("validation")) {
    classes.add("validation");
    confidence.validation = confidence.validation || "medium";
  }
  if (modelHits >= 3) {
    classes.add("model");
    confidence.model = "medium";
  }
  if (configHits >= 2 && !classes.has("config")) {
    classes.add("config");
    confidence.config = confidence.config || "low";
  }

  // Detect boolean flags in config files
  const flags = [];
  if (classes.has("config")) {
    // JSON booleans
    for (const m of content.matchAll(/"([^"]+)"\s*:\s*(true|false)/g)) {
      flags.push({ name: m[1], value: m[2] });
    }
    // Python/shell booleans
    for (const m of content.matchAll(/^([A-Z_]+)\s*=\s*(True|False|true|false|1|0)\s*$/gm)) {
      flags.push({ name: m[1].toLowerCase(), value: m[2].toLowerCase() });
    }
  }

  return { classes: [...classes], confidence, flags };
}

// ---------------------------------------------------------------------------
// Story registry cross-reference
// ---------------------------------------------------------------------------

function loadStoryRegistry(cwd) {
  for (const p of ["story_registry.json", "plans/story_registry.json", ".agent/story_registry.json"]) {
    const fullPath = join(cwd, p);
    if (existsSync(fullPath)) {
      try { return JSON.parse(readFileSync(fullPath, "utf-8")); } catch { /* skip */ }
    }
  }
  return null;
}

function matchFileToStories(filePath, storyRegistry) {
  if (!storyRegistry || !Array.isArray(storyRegistry.stories)) return [];
  const matches = [];

  for (const story of storyRegistry.stories) {
    if (!story.id) continue;

    // Direct code_ref match
    if (Array.isArray(story.code_refs) && story.code_refs.some(r => filePath.includes(r) || r.includes(filePath))) {
      matches.push({ storyId: story.id, relation: "code_ref", confidence: "high" });
    }
    // Direct test_ref match
    if (Array.isArray(story.test_refs) && story.test_refs.some(r => filePath.includes(r) || r.includes(filePath))) {
      matches.push({ storyId: story.id, relation: "test_ref", confidence: "high" });
    }
    // Direct validation_ref match
    if (Array.isArray(story.validation_refs) && story.validation_refs.some(r => filePath.includes(r) || r.includes(filePath))) {
      matches.push({ storyId: story.id, relation: "validation_ref", confidence: "high" });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Plan cross-reference
// ---------------------------------------------------------------------------

function loadPlan(cwd) {
  for (const p of ["plans/plan.md", "plan.md", ".agent/plans/plan.md"]) {
    const fullPath = join(cwd, p);
    if (existsSync(fullPath)) {
      try { return readFileSync(fullPath, "utf-8"); } catch { /* skip */ }
    }
  }
  return null;
}

function extractCriteria(planContent) {
  if (!planContent) return [];
  const criteria = [];
  const section = planContent.match(/^## Success Criteria\s*\n([\s\S]*?)(?=\n## |\n$)/m);
  if (!section) return criteria;

  const lines = section[1].split("\n");
  for (const line of lines) {
    const numMatch = line.match(/^\s*(\d+)\.\s+(.+)/);
    if (numMatch) {
      criteria.push({ id: `sc_${numMatch[1]}`, label: numMatch[2].trim() });
      continue;
    }
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (bulletMatch) {
      criteria.push({ id: `sc_${criteria.length + 1}`, label: bulletMatch[1].trim() });
    }
  }
  return criteria;
}

// ---------------------------------------------------------------------------
// Annotation suggestion engine
// ---------------------------------------------------------------------------

function suggestAnnotations(filePath, content, classification, storyMatches, importGraph, reverseGraph, criteria) {
  const suggestions = [];
  const ext = extname(filePath);
  const comment = COMMENT_STYLE[ext] || "//";

  // 1. validation_module — for validation-classified files
  if (classification.classes.includes("validation") && !classification.classes.includes("test")) {
    suggestions.push({
      key: "validation_module",
      type: "flag",
      confidence: classification.confidence.validation || "medium",
      reason: "File contains validation/quality-checking logic",
      annotation: `${comment} @planner:validation_module`,
    });
  }

  // 2. story — link to story registry
  for (const match of storyMatches) {
    suggestions.push({
      key: "story",
      value: match.storyId,
      confidence: match.confidence,
      reason: `${match.relation} in story_registry for ${match.storyId}`,
      annotation: `${comment} @planner:story = ${match.storyId}`,
    });
  }

  // 3. consumer — files that import this file (reverse dependencies)
  const consumers = reverseGraph[filePath] || [];
  if (consumers.length > 0 && consumers.length <= 5) {
    for (const consumer of consumers) {
      suggestions.push({
        key: "consumer",
        value: consumer,
        confidence: "high",
        reason: `Imported by ${consumer}`,
        annotation: `${comment} @planner:consumer = ${consumer}`,
      });
    }
  } else if (consumers.length > 5) {
    // Too many consumers — just note the count
    suggestions.push({
      key: "consumer",
      value: `${consumers.length} files`,
      confidence: "medium",
      reason: `Imported by ${consumers.length} files (top: ${consumers.slice(0, 3).join(", ")})`,
      annotation: `${comment} @planner:consumer = ${consumers[0]}`,
      note: `${consumers.length - 1} additional consumers — add the most important ones`,
    });
  }

  // 4. config_flag + mutually_exclusive — for config files with boolean flags
  if (classification.flags.length > 0) {
    for (const flag of classification.flags) {
      suggestions.push({
        key: "config_flag",
        value: flag.name,
        confidence: "high",
        reason: `Boolean flag "${flag.name}" = ${flag.value}`,
        annotation: `${comment} @planner:config_flag = ${flag.name}`,
      });
    }
  }

  // 5. proves — match validation files to success criteria by keyword overlap
  if (classification.classes.includes("validation") && criteria.length > 0) {
    const contentLower = content.toLowerCase();
    for (const crit of criteria) {
      const keywords = crit.label.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const matchCount = keywords.filter(kw => contentLower.includes(kw)).length;
      if (matchCount >= 2 || (keywords.length <= 3 && matchCount >= 1)) {
        suggestions.push({
          key: "proves",
          value: `crit:${crit.id}`,
          confidence: matchCount >= 3 ? "high" : "medium",
          reason: `Content matches success criterion "${crit.label}" (${matchCount}/${keywords.length} keywords)`,
          annotation: `${comment} @planner:proves = crit:${crit.id}`,
        });
      }
    }
  }

  // 6. enabled_default — for modules with enable/disable patterns
  if (/enabled?\s*[=:]\s*(true|false)/i.test(content) || /ENABLED\s*=\s*(True|False)/i.test(content)) {
    const match = content.match(/enabled?\s*[=:]\s*(true|false)/i);
    if (match) {
      suggestions.push({
        key: "enabled_default",
        value: match[1].toLowerCase(),
        confidence: "low",
        reason: `Contains enable/disable pattern (default: ${match[1]})`,
        annotation: `${comment} @planner:enabled_default = ${match[1].toLowerCase()}`,
      });
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

function formatReport(results, cwd) {
  const lines = [];
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("  @planner: ANNOTATION ASSIST REPORT");
  lines.push(`  Project: ${cwd}`);
  lines.push(`  Files scanned: ${results.scanned}`);
  lines.push(`  Files with suggestions: ${results.files.length}`);
  lines.push(`  Total suggestions: ${results.totalSuggestions}`);
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("");

  // Summary by type
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byKey = {};
  for (const f of results.files) {
    for (const s of f.suggestions) {
      bySeverity[s.confidence] = (bySeverity[s.confidence] || 0) + 1;
      byKey[s.key] = (byKey[s.key] || 0) + 1;
    }
  }

  lines.push("SUMMARY");
  lines.push(`  High confidence:   ${bySeverity.high}`);
  lines.push(`  Medium confidence: ${bySeverity.medium}`);
  lines.push(`  Low confidence:    ${bySeverity.low}`);
  lines.push("");
  lines.push("  By annotation type:");
  for (const [key, count] of Object.entries(byKey).sort((a, b) => b[1] - a[1])) {
    lines.push(`    @planner:${key.padEnd(25)} ${count}`);
  }
  lines.push("");
  lines.push("───────────────────────────────────────────────────────────");
  lines.push("");

  // Per-file details
  for (const f of results.files) {
    lines.push(`📄 ${f.file}`);
    if (f.classes.length > 0) {
      lines.push(`   Classification: ${f.classes.join(", ")}`);
    }
    lines.push("");

    for (const s of f.suggestions) {
      const badge = s.confidence === "high" ? "🟢" : s.confidence === "medium" ? "🟡" : "🔵";
      lines.push(`   ${badge} ${s.annotation}`);
      lines.push(`      Reason: ${s.reason}`);
      if (s.note) lines.push(`      Note: ${s.note}`);
    }
    lines.push("");
  }

  // Apply instructions
  lines.push("───────────────────────────────────────────────────────────");
  lines.push("HOW TO APPLY");
  lines.push("");
  lines.push("  1. Review each suggestion above (especially 🟡 medium and 🔵 low confidence)");
  lines.push("  2. Run with --apply to auto-insert accepted annotations:");
  lines.push("     node annotation_assist.mjs --apply");
  lines.push("  3. Or manually add annotations to file headers");
  lines.push("  4. Validate: node annotation_parser.mjs --validate");
  lines.push("  5. Check traceability: node ontology_serializer.mjs --json");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Annotation applicator
// ---------------------------------------------------------------------------

function applyAnnotations(results, baseDir, dryRun) {
  let applied = 0;
  let skipped = 0;

  for (const f of results.files) {
    const fullPath = join(baseDir, f.file);
    let content;
    try { content = readFileSync(fullPath, "utf-8"); } catch { continue; }

    // Skip files that already have annotations
    if (content.includes("@planner:")) {
      console.log(`  SKIP ${f.file} — already has @planner: annotations`);
      skipped++;
      continue;
    }

    // Only apply high-confidence suggestions
    const highConf = f.suggestions.filter(s => s.confidence === "high");
    if (highConf.length === 0) continue;

    const ext = extname(f.file);
    const comment = COMMENT_STYLE[ext] || "//";

    // Build annotation block
    const block = [];
    block.push(`${comment} ─── @planner: annotations (auto-generated, review before committing) ───`);
    for (const s of highConf) {
      block.push(s.annotation);
    }
    block.push("");

    // Insert after shebang / encoding / docstring opener, or at top
    const lines = content.split("\n");
    let insertAt = 0;
    if (lines[0]?.startsWith("#!")) insertAt = 1;
    if (lines[insertAt]?.startsWith("# -*-") || lines[insertAt]?.startsWith("# coding")) insertAt++;

    const newContent = [
      ...lines.slice(0, insertAt),
      ...block,
      ...lines.slice(insertAt),
    ].join("\n");

    if (dryRun) {
      console.log(`  DRY-RUN ${f.file} — would insert ${highConf.length} annotations at line ${insertAt + 1}`);
      for (const s of highConf) console.log(`    ${s.annotation}`);
    } else {
      writeFileSync(fullPath, newContent, "utf-8");
      console.log(`  APPLIED ${f.file} — ${highConf.length} annotations`);
    }
    applied++;
  }

  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  let outputJson = false;
  let apply = false;
  let dryRun = false;
  let minConfidence = "low"; // low, medium, high

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && args[i + 1]) { cwd = resolve(args[++i]); }
    if (args[i] === "--json") { outputJson = true; }
    if (args[i] === "--apply") { apply = true; }
    if (args[i] === "--dry-run") { dryRun = true; apply = true; }
    if (args[i] === "--min-confidence" && args[i + 1]) { minConfidence = args[++i]; }
  }

  cwd = resolve(cwd);

  // 1. Scan files
  const files = walkProject(cwd, cwd);
  console.error(`Scanning ${files.length} source files in ${cwd}...`);

  // 2. Load context
  const storyRegistry = loadStoryRegistry(cwd);
  const planContent = loadPlan(cwd);
  const criteria = extractCriteria(planContent);

  if (storyRegistry) console.error(`  Story registry: ${storyRegistry.stories?.length || 0} stories`);
  if (planContent) console.error(`  Plan: found (${criteria.length} success criteria)`);

  // 3. Build import graph
  const { graph, reverseGraph } = buildImportGraph(files, cwd);
  console.error(`  Import graph: ${Object.keys(graph).length} files with imports`);

  // 4. Classify and suggest
  const results = {
    scanned: files.length,
    files: [],
    totalSuggestions: 0,
  };

  const confidenceOrder = { high: 3, medium: 2, low: 1 };
  const minConf = confidenceOrder[minConfidence] || 1;

  for (const f of files) {
    const fullPath = join(cwd, f);
    let content;
    try { content = readFileSync(fullPath, "utf-8"); } catch { continue; }

    // Skip files that already have annotations (report them separately)
    if (content.includes("@planner:")) continue;

    const classification = classifyFile(f, content);
    const storyMatches = matchFileToStories(f, storyRegistry);
    const suggestions = suggestAnnotations(
      f, content, classification, storyMatches,
      graph, reverseGraph, criteria
    ).filter(s => (confidenceOrder[s.confidence] || 1) >= minConf);

    if (suggestions.length > 0) {
      results.files.push({
        file: f,
        classes: classification.classes,
        suggestions,
      });
      results.totalSuggestions += suggestions.length;
    }
  }

  // Sort: most suggestions first, then by confidence
  results.files.sort((a, b) => {
    const aMax = Math.max(...a.suggestions.map(s => confidenceOrder[s.confidence] || 0));
    const bMax = Math.max(...b.suggestions.map(s => confidenceOrder[s.confidence] || 0));
    if (bMax !== aMax) return bMax - aMax;
    return b.suggestions.length - a.suggestions.length;
  });

  // 5. Output
  if (apply) {
    const { applied, skipped } = applyAnnotations(results, cwd, dryRun);
    console.log(`\n${dryRun ? "DRY-RUN" : "DONE"}: ${applied} files annotated, ${skipped} skipped (already annotated)`);
  } else if (outputJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatReport(results, cwd));
  }
}

main();
