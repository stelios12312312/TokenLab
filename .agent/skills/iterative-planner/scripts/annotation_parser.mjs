#!/usr/bin/env node
// annotation_parser.mjs — Parses @planner: annotations from source files.
//
// Scans the project codebase for structured annotations embedded in comments
// and outputs Prolog facts, Turtle triples, and/or a JSON report.
//
// Annotations are deterministic metadata that both Prolog and the ontology
// layer consume as ground truth. Instead of the AI discovering connections
// at audit time (heuristic, error-prone), developers declare relationships
// at write time.
//
// Usage:
//   node annotation_parser.mjs                         JSON report to stdout
//   node annotation_parser.mjs --prolog                Prolog facts to stdout
//   node annotation_parser.mjs --turtle                Turtle triples to stdout
//   node annotation_parser.mjs --json                  JSON report to stdout (default)
//   node annotation_parser.mjs --validate              Validate references, exit 1 on errors
//   node annotation_parser.mjs --coverage              Report annotation coverage metrics
//   node annotation_parser.mjs --dir <path>            Override project directory
//
// Annotation format (in any comment style):
//   Format: @planner:<key>                     Flag annotation
//   Format: @planner:<key> = <value>           Key-value annotation
//   Format: @planner:<key> = <val1>, <val2>    Multi-value annotation
//   Legacy: @planner:<key>: <value>            Accepted for compatibility; prefer "="

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "fs";
import { join, relative, extname, resolve } from "path";
import { sanitizeAtom, sanitizeStrictId } from "./lib/sanitize.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ANNOTATION_PREFIX = "@planner:";

// Comment prefixes by file extension
const COMMENT_PREFIXES = {
  ".py":   ["#"],
  ".js":   ["//"],
  ".mjs":  ["//"],
  ".ts":   ["//"],
  ".tsx":  ["//"],
  ".pl":   ["%%", "%"],
  ".rs":   ["//"],
  ".go":   ["//"],
  ".rb":   ["#"],
  ".sh":   ["#"],
  ".yaml": ["#"],
  ".yml":  ["#"],
  ".toml": ["#"],
  ".r":    ["#"],
  ".jl":   ["#"],
  ".php":  ["//", "#"],
  ".java": ["//"],
  ".c":    ["//"],
  ".cpp":  ["//"],
  ".h":    ["//"],
  ".swift":["//"],
  ".kt":   ["//"],
};

// Known annotation keys and their types
const ANNOTATION_SCHEMA = {
  validation_module:       { type: "flag" },
  consumer:                { type: "value" },
  proves:                  { type: "value" },
  requires:                { type: "value" },
  reviewed_by:             { type: "list" },
  mutually_exclusive:      { type: "value" },
  metric_type:             { type: "value", enum: ["raw", "capped", "transformed", "normalized"] },
  enabled_default:         { type: "value", enum: ["true", "false"] },
  config_flag:             { type: "value" },
  story:                   { type: "value" },
  module:                  { type: "value" },
  capability:              { type: "value" },
  disable_justification:   { type: "value" },
  disable_expiry:          { type: "value" },
};

// Directories to skip
const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv",
  "dist", "build", ".next", "target", ".tox", "coverage",
]);

function isGeneratedEvidenceRoot(fullPath, baseDir) {
  const rel = relative(baseDir, fullPath).replace(/\\/g, "/");
  const topLevel = rel.split("/")[0];
  return topLevel === "plans" || topLevel === "reports" ||
    rel === ".agent/cache" || rel.startsWith(".agent/cache/");
}

// Validation-relevant directories (for coverage metrics)
const VALIDATION_DIRS = [
  "validation", "validators", "checks", "gates", "guards",
  "core/validation", "src/validation", "lib/validation",
];

// ---------------------------------------------------------------------------
// File scanner
// ---------------------------------------------------------------------------

function walkDir(dir, baseDir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch { return files; }

  // Resolve real baseDir once for symlink boundary checking
  const realBase = realpathSync(baseDir);

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    if (entry.startsWith(".") && entry !== ".agent") continue;

    const fullPath = join(dir, entry);
    if (isGeneratedEvidenceRoot(fullPath, baseDir)) continue;
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    // Symlink boundary check: ensure real path stays within project root
    if (stat.isSymbolicLink?.() || true) {
      try {
        const realPath = realpathSync(fullPath);
        if (!realPath.startsWith(realBase)) continue; // Outside project root — skip
      } catch { continue; }
    }

    if (stat.isDirectory()) {
      walkDir(fullPath, baseDir, files);
    } else if (stat.isFile()) {
      const ext = extname(entry);
      if (COMMENT_PREFIXES[ext]) {
        files.push(relative(baseDir, fullPath));
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Annotation parser
// ---------------------------------------------------------------------------

function parseAnnotations(filePath, baseDir) {
  const fullPath = join(baseDir, filePath);
  const ext = extname(filePath);
  const prefixes = COMMENT_PREFIXES[ext];
  if (!prefixes) return [];

  let content;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch { return []; }

  const annotations = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Strip comment prefix
    let stripped = null;
    for (const prefix of prefixes) {
      if (line.startsWith(prefix)) {
        stripped = line.slice(prefix.length).trim();
        break;
      }
    }
    if (!stripped) continue;

    // Check for @planner: prefix — must be at the START of the comment content
    // This prevents matching mid-sentence references like "Load @planner: annotations"
    if (!stripped.startsWith(ANNOTATION_PREFIX)) continue;

    const afterPrefix = stripped.slice(ANNOTATION_PREFIX.length);

    // Parse key = value or key (flag)
    const assignmentMatch = afterPrefix.match(/^([a-z_]+)\s*(=|:)\s*(.+)$/i);
    let key, rawValue;

    if (!assignmentMatch) {
      // Flag annotation: @planner:validation_module
      key = afterPrefix.trim().toLowerCase();
      rawValue = null;
    } else {
      key = assignmentMatch[1].trim().toLowerCase();
      rawValue = assignmentMatch[3].trim();
    }

    // Validate key
    const schema = ANNOTATION_SCHEMA[key];
    if (!schema) {
      annotations.push({
        file: filePath,
        line: i + 1,
        key,
        value: rawValue,
        values: rawValue ? [rawValue] : [],
        error: `Unknown annotation key: ${key}`,
      });
      continue;
    }

    // Parse value based on type
    let values = [];
    if (schema.type === "flag") {
      // No value expected
    } else if (schema.type === "list") {
      values = rawValue ? rawValue.split(",").map(v => v.trim()).filter(Boolean) : [];
    } else {
      values = rawValue ? [rawValue.trim()] : [];
    }

    // Validate enum values
    if (schema.enum && values.length > 0) {
      for (const v of values) {
        if (!schema.enum.includes(v.toLowerCase())) {
          annotations.push({
            file: filePath,
            line: i + 1,
            key,
            value: rawValue,
            values,
            error: `Invalid value '${v}' for ${key}. Must be one of: ${schema.enum.join(", ")}`,
          });
          continue;
        }
      }
    }

    annotations.push({
      file: filePath,
      line: i + 1,
      key,
      value: rawValue,
      values,
      error: null,
    });
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Output: Prolog facts
// ---------------------------------------------------------------------------

// Sanitization delegated to shared lib/sanitize.mjs (sanitizeAtom, sanitizeStrictId).
// File paths use sanitizeStrictId; free-text values use sanitizeAtom.

function toPrologFacts(allAnnotations) {
  const facts = [];
  const fileAnnotations = groupByFile(allAnnotations);

  for (const [filePath, annotations] of Object.entries(fileAnnotations)) {
    const path = sanitizeStrictId(filePath);

    for (const ann of annotations) {
      if (ann.error) continue;

      switch (ann.key) {
        case "validation_module":
          facts.push(`validation_module(${path}).`);
          break;
        case "consumer": {
          const consumerTarget = ann.values[0];
          if (!consumerTarget) break;
          const targetPath = sanitizeStrictId(consumerTarget);
          facts.push(`module_has_live_consumer(${targetPath}).`);
          facts.push(`annotation_consumer(${path}, ${targetPath}).`);
          break;
        }
        case "proves":
          facts.push(`annotation_proves(${path}, ${sanitizeStrictId(ann.values[0])}).`);
          break;
        case "requires":
          facts.push(`annotation_requires(${path}, ${sanitizeStrictId(ann.values[0])}).`);
          break;
        case "reviewed_by":
          for (const persona of ann.values) {
            facts.push(`review_assignment(${path}, ${sanitizeStrictId(persona)}).`);
          }
          break;
        case "mutually_exclusive": {
          // Need the config_flag from the same file to pair them
          const flagAnn = annotations.find(a => a.key === "config_flag");
          if (flagAnn && flagAnn.values[0]) {
            facts.push(`mutually_exclusive(${sanitizeStrictId(flagAnn.values[0])}, ${sanitizeStrictId(ann.values[0])}).`);
            facts.push(`mutually_exclusive(${sanitizeStrictId(ann.values[0])}, ${sanitizeStrictId(flagAnn.values[0])}).`);
          }
          break;
        }
        case "metric_type":
          facts.push(`metric(${path}, ${sanitizeStrictId(ann.values[0])}).`);
          break;
        case "enabled_default":
          facts.push(`module_default_enabled(${path}, ${ann.values[0].toLowerCase()}).`);
          // WR-003 needs validation_check(Module, disabled) to fire
          if (ann.values[0].toLowerCase() === "false") {
            facts.push(`validation_check(${path}, disabled).`);
          }
          break;
        case "config_flag":
          facts.push(`config_flag(${path}, ${sanitizeStrictId(ann.values[0])}, unknown).`);
          break;
        case "story":
          facts.push(`code_ref(${sanitizeStrictId(ann.values[0])}, ${path}).`);
          break;
        case "disable_justification":
          facts.push(`disable_justification(${path}, ${sanitizeAtom(ann.values[0])}).`);
          break;
        case "disable_expiry":
          facts.push(`disable_expiry(${path}, ${sanitizeStrictId(ann.values[0])}).`);
          break;
      }
    }
  }

  return facts.join("\n");
}

// ---------------------------------------------------------------------------
// Output: Turtle triples
// ---------------------------------------------------------------------------

function toTurtle(allAnnotations) {
  const triples = [
    "@prefix impl: <http://iterative-planner.dev/implementation/> .",
    "@prefix req: <http://iterative-planner.dev/requirements/> .",
    "@prefix audit: <http://iterative-planner.dev/audit/> .",
    "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
    "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
    "",
  ];

  const fileAnnotations = groupByFile(allAnnotations);

  for (const [filePath, annotations] of Object.entries(fileAnnotations)) {
    const iri = `impl:${encodeFileIRI(filePath)}`;

    for (const ann of annotations) {
      if (ann.error) continue;

      switch (ann.key) {
        case "validation_module":
          triples.push(`${iri} a impl:ValidationModule ; rdfs:label "${filePath}" .`);
          break;
        case "consumer":
          triples.push(`${iri} impl:invokes impl:${encodeFileIRI(ann.values[0])} .`);
          break;
        case "proves":
          triples.push(`${iri} impl:proves req:${encodeIRI(ann.values[0])} .`);
          break;
        case "requires":
          triples.push(`${iri} impl:requires req:${encodeIRI(ann.values[0])} .`);
          break;
        case "reviewed_by":
          for (const persona of ann.values) {
            triples.push(`audit:${encodeIRI(persona)} audit:reviews ${iri} .`);
          }
          break;
        case "mutually_exclusive": {
          const flagAnn = annotations.find(a => a.key === "config_flag");
          if (flagAnn && flagAnn.values[0]) {
            triples.push(`impl:${encodeIRI(flagAnn.values[0])} impl:excludes impl:${encodeIRI(ann.values[0])} .`);
          }
          break;
        }
        case "metric_type":
          triples.push(`${iri} impl:metricType "${ann.values[0]}" .`);
          break;
        case "enabled_default":
          triples.push(`${iri} impl:enabledDefault "${ann.values[0]}"^^xsd:boolean .`);
          break;
        case "config_flag":
          triples.push(`impl:${encodeIRI(ann.values[0])} a impl:ConfigFlag ; impl:declaredIn ${iri} .`);
          break;
        case "story":
          triples.push(`${iri} impl:realizes req:${encodeIRI(ann.values[0])} .`);
          break;
        case "disable_justification":
          triples.push(`${iri} impl:disableReason "${escTurtle(ann.values[0])}" .`);
          break;
        case "disable_expiry":
          triples.push(`${iri} impl:disableExpiry "${ann.values[0]}"^^xsd:date .`);
          break;
      }
    }
  }

  return triples.join("\n");
}

function encodeFileIRI(path) {
  return path.replace(/[^a-zA-Z0-9_\-/.]/g, "_").replace(/\//g, "__");
}

function encodeIRI(str) {
  return str.replace(/[^a-zA-Z0-9_\-:]/g, "_");
}

function escTurtle(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Output: JSON report
// ---------------------------------------------------------------------------

function toJSON(allAnnotations, baseDir) {
  const fileAnnotations = groupByFile(allAnnotations);
  const errors = allAnnotations.filter(a => a.error);

  const summary = {
    total_files_scanned: 0,
    files_with_annotations: Object.keys(fileAnnotations).length,
    total_annotations: allAnnotations.length,
    errors: errors.length,
    by_key: {},
  };

  for (const ann of allAnnotations) {
    if (!summary.by_key[ann.key]) summary.by_key[ann.key] = 0;
    summary.by_key[ann.key]++;
  }

  return {
    summary,
    files: fileAnnotations,
    errors: errors.map(e => ({
      file: e.file,
      line: e.line,
      key: e.key,
      error: e.error,
    })),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(allAnnotations, baseDir) {
  const errors = [];
  const fileAnnotations = groupByFile(allAnnotations);

  // Collect all annotations for cross-referencing
  const allConsumers = new Set();
  const allConfigFlags = new Map(); // flag -> file
  const allMutualExclusions = []; // [flagA, flagB]

  for (const [filePath, annotations] of Object.entries(fileAnnotations)) {
    for (const ann of annotations) {
      if (ann.error) {
        errors.push({ file: filePath, line: ann.line, error: ann.error, severity: "warn" });
        continue;
      }

      // Validate @planner:consumer path exists and stays within project root
      if (ann.key === "consumer" && ann.values[0]) {
        const consumerPath = resolve(baseDir, ann.values[0]);
        const realBase = resolve(baseDir);
        if (!consumerPath.startsWith(realBase + "/") && consumerPath !== realBase) {
          errors.push({
            file: filePath,
            line: ann.line,
            error: `Consumer path escapes project root: ${ann.values[0]}`,
            severity: "fail",
          });
        } else if (!existsSync(consumerPath)) {
          errors.push({
            file: filePath,
            line: ann.line,
            error: `Consumer path does not exist: ${ann.values[0]}`,
            severity: "fail",
          });
        }
        allConsumers.add(ann.values[0]);
      }

      // Validate @planner:disable_expiry is not in the past
      if (ann.key === "disable_expiry" && ann.values[0]) {
        const expiry = new Date(ann.values[0]);
        if (!isNaN(expiry.getTime()) && expiry < new Date()) {
          errors.push({
            file: filePath,
            line: ann.line,
            error: `Disable expiry date has passed: ${ann.values[0]}`,
            severity: "fail",
          });
        }
      }

      // Collect config flags for symmetry check
      if (ann.key === "config_flag" && ann.values[0]) {
        allConfigFlags.set(ann.values[0], filePath);
      }

      if (ann.key === "mutually_exclusive" && ann.values[0]) {
        const flagAnn = annotations.find(a => a.key === "config_flag");
        if (flagAnn && flagAnn.values[0]) {
          allMutualExclusions.push([flagAnn.values[0], ann.values[0], filePath, ann.line]);
        }
      }

      // Validate @planner:reviewed_by personas are known
      if (ann.key === "reviewed_by") {
        const knownPersonas = [
          "wiring_auditor", "assumptions_challenger", "config_integrity",
          "quant", "quant_target", "tokenomics", "ux_ui", "traceability",
        ];
        for (const p of ann.values) {
          if (!knownPersonas.includes(p)) {
            errors.push({
              file: filePath,
              line: ann.line,
              error: `Unknown persona: ${p}. Known: ${knownPersonas.join(", ")}`,
              severity: "warn",
            });
          }
        }
      }
    }
  }

  // Check mutual exclusion symmetry
  for (const [flagA, flagB, file, line] of allMutualExclusions) {
    const hasReverse = allMutualExclusions.some(
      ([a, b]) => a === flagB && b === flagA
    );
    if (!hasReverse) {
      errors.push({
        file,
        line,
        error: `Mutual exclusion is not symmetric: ${flagA} excludes ${flagB} but ${flagB} does not exclude ${flagA}`,
        severity: "warn",
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Coverage metrics
// ---------------------------------------------------------------------------

function coverageReport(allAnnotations, baseDir) {
  const fileAnnotations = groupByFile(allAnnotations);

  // Find validation-related files
  const validationFiles = [];
  for (const dir of VALIDATION_DIRS) {
    const fullDir = join(baseDir, dir);
    if (!existsSync(fullDir)) continue;
    try {
      const files = readdirSync(fullDir);
      for (const f of files) {
        const ext = extname(f);
        if (COMMENT_PREFIXES[ext]) {
          validationFiles.push(relative(baseDir, join(fullDir, f)));
        }
      }
    } catch { /* skip */ }
  }

  const annotatedValidation = validationFiles.filter(f => fileAnnotations[f]);
  const unannotated = validationFiles.filter(f => !fileAnnotations[f]);

  return {
    validation_files: {
      total: validationFiles.length,
      annotated: annotatedValidation.length,
      unannotated: unannotated,
      coverage_pct: validationFiles.length > 0
        ? Math.round((annotatedValidation.length / validationFiles.length) * 100)
        : 100,
    },
    annotation_counts: Object.entries(
      allAnnotations.reduce((acc, a) => {
        acc[a.key] = (acc[a.key] || 0) + 1;
        return acc;
      }, {})
    ).sort((a, b) => b[1] - a[1]),
    files_with_annotations: Object.keys(fileAnnotations).length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByFile(annotations) {
  const grouped = {};
  for (const ann of annotations) {
    if (!grouped[ann.file]) grouped[ann.file] = [];
    grouped[ann.file].push(ann);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// CLI (only runs when invoked directly, not when imported)
// ---------------------------------------------------------------------------

const _isMainModule = process.argv[1] && (
  process.argv[1].endsWith("annotation_parser.mjs") ||
  process.argv[1].endsWith("annotation_parser.js")
);

if (_isMainModule) { _runCli(); }

function _runCli() {
const args = process.argv.slice(2);
const flags = {
  prolog:   args.includes("--prolog"),
  turtle:   args.includes("--turtle"),
  json:     args.includes("--json"),
  validate: args.includes("--validate"),
  coverage: args.includes("--coverage"),
};

// Default to JSON if no output format specified
if (!flags.prolog && !flags.turtle && !flags.validate && !flags.coverage) {
  flags.json = true;
}

// Parse --dir option
let baseDir = process.cwd();
const dirIdx = args.indexOf("--dir");
if (dirIdx !== -1 && args[dirIdx + 1]) {
  baseDir = resolve(args[dirIdx + 1]);
}

// Scan and parse
const files = walkDir(baseDir, baseDir);
const allAnnotations = [];
for (const file of files) {
  const fileAnnotations = parseAnnotations(file, baseDir);
  allAnnotations.push(...fileAnnotations);
}

// Output
if (flags.prolog) {
  const prologOutput = toPrologFacts(allAnnotations);
  if (prologOutput) {
    console.log("%% Auto-generated by annotation_parser.mjs");
    console.log(`%% Parsed ${allAnnotations.length} annotations from ${files.length} files`);
    console.log(prologOutput);
  } else {
    console.log("%% No @planner: annotations found.");
  }
}

if (flags.turtle) {
  const turtleOutput = toTurtle(allAnnotations);
  console.log(turtleOutput);
}

if (flags.json) {
  const report = toJSON(allAnnotations, baseDir);
  report.summary.total_files_scanned = files.length;
  console.log(JSON.stringify(report, null, 2));
}

if (flags.validate) {
  const validationErrors = validate(allAnnotations, baseDir);
  const parseErrors = allAnnotations.filter(a => a.error);

  if (validationErrors.length === 0 && parseErrors.length === 0) {
    if (!flags.json) {
      console.log(`✅ All ${allAnnotations.length} annotations valid (${files.length} files scanned).`);
    }
    process.exit(0);
  } else {
    const fails = validationErrors.filter(e => e.severity === "fail");
    const warns = validationErrors.filter(e => e.severity === "warn");

    for (const e of fails) {
      console.error(`❌ ${e.file}:${e.line} — ${e.error}`);
    }
    for (const e of warns) {
      console.warn(`⚠️  ${e.file}:${e.line} — ${e.error}`);
    }
    for (const e of parseErrors) {
      console.warn(`⚠️  ${e.file}:${e.line} — ${e.error}`);
    }

    if (!flags.json) {
      console.log(`\n${fails.length} errors, ${warns.length + parseErrors.length} warnings (${allAnnotations.length} annotations, ${files.length} files)`);
    }
    process.exit(fails.length > 0 ? 1 : 0);
  }
}

if (flags.coverage) {
  const report = coverageReport(allAnnotations, baseDir);
  console.log("Annotation Coverage Report");
  console.log("=========================\n");
  console.log(`Files scanned: ${files.length}`);
  console.log(`Files with annotations: ${report.files_with_annotations}`);
  console.log(`\nValidation directory coverage: ${report.validation_files.coverage_pct}% (${report.validation_files.annotated}/${report.validation_files.total})`);

  if (report.validation_files.unannotated.length > 0) {
    console.log(`\nUnannotated validation files:`);
    for (const f of report.validation_files.unannotated) {
      console.log(`  ⚠️  ${f}`);
    }
  }

  if (report.annotation_counts.length > 0) {
    console.log(`\nAnnotation counts by key:`);
    for (const [key, count] of report.annotation_counts) {
      console.log(`  ${key}: ${count}`);
    }
  }
}
} // end _runCli

// Export for use by packs
export { parseAnnotations, toPrologFacts, toTurtle, validate, walkDir, groupByFile };
