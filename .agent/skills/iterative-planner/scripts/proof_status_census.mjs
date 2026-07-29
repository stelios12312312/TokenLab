#!/usr/bin/env node
// @planner:module proof_status_census
// @planner:capability proof_status_reader_guard

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "fs";
import { dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import {
  getVerificationStatusVocabulary,
  verificationStatusIsPass,
} from "./lib/verification_status_vocabulary.mjs";
import { emitJson } from "./lib/emit_json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "..");
const DEFAULT_ROOT = resolve(SKILL_DIR, "..", "..", "..");
const DEFAULT_REGISTRY = join(SKILL_DIR, "config", "proof_status_reader_census.json");
const DEFAULT_REPORT = join(DEFAULT_ROOT, "reports", "ive", "2026-07-15-proof-status-reader-census.md");
const EXEMPTION_RE = /proof-status-lint:\s*exempt\s+(T-[A-Z0-9-]+)\s+--\s+(.+?)\s*$/i;
const CANONICAL_PATHS = new Set([
  ".agent/skills/iterative-planner/scripts/lib/verification_status_vocabulary.mjs",
  ".agent/skills/iterative-planner/prolog/verification_statuses.pl",
]);

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceLine(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function normalizedSnippet(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function vocabularyForms() {
  const forms = new Set();
  for (const context of Object.values(getVerificationStatusVocabulary().contexts)) {
    for (const status of context.statuses) {
      forms.add(status.canonical);
      for (const form of status.forms) forms.add(form);
    }
  }
  return [...forms]
    .map((value) => String(value).trim())
    .filter((value) => value.length >= 2)
    .sort((a, b) => b.length - a.length);
}

function validExemption(lines, lineNumber) {
  for (const candidateLine of [lineNumber, lineNumber - 1]) {
    if (candidateLine < 1) continue;
    const match = lines[candidateLine - 1]?.match(EXEMPTION_RE);
    if (!match) continue;
    const reason = match[2].trim();
    if (reason.length < 12) return { valid: false, ticket: match[1], reason, error: "exemption_reason_too_short" };
    return { valid: true, ticket: match[1].toUpperCase(), reason, line: candidateLine };
  }
  return null;
}

function pushMatches(results, { source, path, language, rule, regex, predicate = null }) {
  const lines = source.split("\n");
  for (const match of source.matchAll(regex)) {
    const offset = match.index || 0;
    const context = source.slice(Math.max(0, offset - 180), Math.min(source.length, offset + match[0].length + 180));
    if (predicate && !predicate(match, context)) continue;
    const line = sourceLine(source, offset);
    const snippet = normalizedSnippet(match[0]);
    const exemption = validExemption(lines, line);
    results.push({
      id: `${path}:${rule}:${sha(snippet)}`,
      path,
      line,
      language,
      reader_class: rule,
      snippet,
      exemption,
    });
  }
}

export function scanProofStatusSource(source, {
  path = "fixture.mjs",
  language = extname(path) === ".pl" ? "prolog" : "javascript",
} = {}) {
  const majorForms = "PASS|PASSED|FAIL|FAILED|VERIFIED|SATISFIED|SUCCESS|SUCCESSFUL|OK|WAIVED|PENDING|BLOCKED|ERROR|SKIP|SKIPPED|TIMEOUT|COMPLETED|DONE";
  const boundedMajorForms = `(?<![A-Za-z])(?:${majorForms})(?![A-Za-z])`;
  const results = [];
  if (language === "prolog") {
    pushMatches(results, {
      source,
      path,
      language,
      rule: "prolog_status_list",
      regex: new RegExp(`\\bmember\\s*\\([^,]+,\\s*\\[[^\\]]*(?:${majorForms})[^\\]]*(?:${majorForms})[^\\]]*\\]\\s*\\)`, "gim"),
    });
    pushMatches(results, {
      source,
      path,
      language,
      rule: "prolog_direct_proof_atom",
      regex: new RegExp(`\\b(?:validation_status|verification_result_status)\\s*\\([^\\n)]*,\\s*(?:${majorForms})\\s*\\)`, "gim"),
    });
    pushMatches(results, {
      source,
      path,
      language,
      rule: "duplicate_projection_fact",
      regex: /^\s*verification_status_token\s*\([^\n]+\)\s*\./gim,
    });
  } else {
    pushMatches(results, {
      source,
      path,
      language,
      rule: "direct_status_comparison",
      regex: new RegExp(`(?:[A-Za-z_$][\\w$]*\\??\\.)?(?:status|result|outcome|verdict)\\s*(?:===?|!==?)\\s*["'](?:${majorForms})["']|["'](?:${majorForms})["']\\s*(?:===?|!==?)\\s*(?:[A-Za-z_$][\\w$]*\\??\\.)?(?:status|result|outcome|verdict)`, "gim"),
    });
    pushMatches(results, {
      source,
      path,
      language,
      rule: "status_collection",
      regex: new RegExp(`(?:const|let|var)\\s+[A-Za-z0-9_]*(?:PASS|FAIL|RESULT|OUTCOME|VERDICT|PROOF|VERIFICATION|TEST_(?:STATUS|RESULT|OUTCOME))[A-Za-z0-9_]*\\s*=\\s*(?:new\\s+Set\\s*\\(\\s*\\[[^\\]]{0,500}?["'](?:${majorForms})["'][^\\]]{0,500}?\\]\\s*\\)|\\[[^\\]]{0,500}?["'](?:${majorForms})["'][^\\]]{0,500}?\\])`, "gim"),
    });
    pushMatches(results, {
      source,
      path,
      language,
      rule: "status_collection",
      regex: new RegExp(`\\[[\\s\\S]{0,300}?["'](?:${majorForms})["'][\\s\\S]{0,300}?\\]\\s*\\.includes\\s*\\(\\s*(?:status|result|outcome|verdict)`, "gim"),
    });
    pushMatches(results, {
      source,
      path,
      language,
      rule: "status_collection",
      regex: new RegExp(`new\\s+Set\\s*\\(\\s*\\[[\\s\\S]{0,300}?["'](?:${majorForms})["'][\\s\\S]{0,300}?["'](?:${majorForms})["'][\\s\\S]{0,300}?\\]\\s*\\)\\s*\\.has\\s*\\(`, "gim"),
    });
    pushMatches(results, {
      source,
      path,
      language,
      rule: "status_regex",
      regex: new RegExp(`(?:new\\s+RegExp\\s*\\([^)]{0,400}${boundedMajorForms}[^)]{0,400}\\)|\\/[^/\\n]{0,300}${boundedMajorForms}[^/\\n]{0,300}\\/[gimsuy]*)\\s*\\.test\\s*\\(\\s*(?:status|result|outcome|verdict|proof|line|text|value)`, "gim"),
    });
    pushMatches(results, {
      source,
      path,
      language,
      rule: "default_to_pass",
      regex: new RegExp(`(?:\\?\\?|\\|\\|)\\s*["'](?:pass|passed|ok|success|verified)["']`, "gim"),
    });
  }
  const occurrences = new Map();
  return results.map((result) => {
    const occurrence = (occurrences.get(result.id) || 0) + 1;
    occurrences.set(result.id, occurrence);
    return occurrence === 1 ? result : { ...result, id: `${result.id}:occurrence-${occurrence}` };
  }).sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

function walk(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "tests", "fixtures"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, output);
    else if ([".mjs", ".js", ".cjs", ".pl"].includes(extname(entry.name))) output.push(path);
  }
  return output;
}

function repositorySourceFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean)
      .filter((path) => [".mjs", ".js", ".cjs", ".pl"].includes(extname(path)))
      .map((path) => join(root, path));
  } catch {
    return walk(root);
  }
}

function loadRegistry(path) {
  if (!existsSync(path)) throw new Error(`proof_status_census_registry_missing:${path}`);
  const registry = JSON.parse(readFileSync(path, "utf8"));
  if (registry.schema_version !== 1 || !Array.isArray(registry.readers)) {
    throw new Error(`proof_status_census_registry_invalid:${path}`);
  }
  return registry;
}

function isProductionSource(root, file) {
  const path = relative(root, file).replace(/\\/g, "/");
  if (/^(?:plans|reports|docs|scratch)\//.test(path)) return false;
  if (/(?:^|\/)(?:tests?|fixtures?)(?:\/|$)/.test(path)) return false;
  return true;
}

function collectSourceFiles(root, repositoryFiles = repositorySourceFiles(root)) {
  return repositoryFiles.filter((file) => isProductionSource(root, file));
}

function registryIssues({ root, registry, candidates, sourceFiles }) {
  const issues = [];
  const seenIds = new Set();
  const exemptCandidates = candidates.filter((candidate) => candidate.exemption?.valid);
  const protocolExemptions = new Map();
  for (const exemption of registry.protocol_exemptions || []) {
    if (!exemption.id || protocolExemptions.has(exemption.id)) {
      issues.push({ code: "protocol_exemption_duplicate_or_missing_id", id: exemption.id || null });
      continue;
    }
    if (!exemption.reason || exemption.reason.trim().length < 20 || !exemption.proof_boundary) {
      issues.push({ code: "protocol_exemption_contract_incomplete", id: exemption.id });
    }
    protocolExemptions.set(exemption.id, exemption);
  }
  for (const reader of registry.readers) {
    if (!reader.id || seenIds.has(reader.id)) issues.push({ code: "registry_duplicate_or_missing_id", reader: reader.id || null });
    seenIds.add(reader.id);
    const absolute = join(root, reader.path || "");
    if (!reader.path || !existsSync(absolute)) {
      issues.push({ code: "registry_reader_path_missing", reader: reader.id, path: reader.path || null });
      continue;
    }
    const content = readFileSync(absolute, "utf8");
    if (!reader.anchor || !content.includes(reader.anchor)) {
      issues.push({ code: "registry_reader_anchor_stale", reader: reader.id, path: reader.path, anchor: reader.anchor || null });
    }
    if (!["canonical-derived", "repaired", "deleted", "exempt"].includes(reader.classification)) {
      issues.push({ code: "registry_reader_unresolved", reader: reader.id, classification: reader.classification || null });
    }
    if (reader.classification === "exempt") {
      const live = exemptCandidates.some((candidate) => candidate.path === reader.path && candidate.exemption.ticket === reader.ticket);
      if (!reader.ticket || !reader.reason || !live) {
        issues.push({ code: "registry_exemption_not_live", reader: reader.id, path: reader.path });
      }
    }
  }

  for (const candidate of candidates) {
    if (CANONICAL_PATHS.has(candidate.path)) continue;
    if (protocolExemptions.has(candidate.id)) continue;
    if (candidate.exemption?.valid) {
      const registered = registry.readers.some((reader) => reader.classification === "exempt"
        && reader.path === candidate.path
        && reader.ticket === candidate.exemption.ticket
        && reader.anchor
        && readFileSync(join(root, reader.path), "utf8").includes(reader.anchor));
      if (!registered) issues.push({ code: "unregistered_exemption", ...candidate });
      continue;
    }
    if (candidate.exemption && !candidate.exemption.valid) {
      issues.push({ code: candidate.exemption.error, ...candidate });
      continue;
    }
    issues.push({ code: "unclassified_proof_status_reader", ...candidate });
  }

  for (const [id, exemption] of protocolExemptions) {
    const candidate = candidates.find((entry) => entry.id === id);
    if (!candidate) issues.push({ code: "protocol_exemption_stale", id, path: exemption.path || null });
    else if (exemption.path && exemption.path !== candidate.path) {
      issues.push({ code: "protocol_exemption_path_mismatch", id, path: exemption.path, actual_path: candidate.path });
    } else if (!candidate.exemption?.valid || candidate.exemption.ticket !== registry.ticket) {
      issues.push({ code: "protocol_exemption_annotation_missing", id, path: candidate.path });
    } else if (candidate.exemption.reason !== exemption.reason) {
      issues.push({ code: "protocol_exemption_annotation_reason_mismatch", id, path: candidate.path });
    }
  }

  for (const file of sourceFiles) {
    const path = relative(root, file).replace(/\\/g, "/");
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = line.match(EXEMPTION_RE);
      if (!match) return;
      const attached = candidates.some((candidate) => candidate.path === path && candidate.exemption?.line === index + 1);
      if (!attached) issues.push({ code: "orphan_exemption_annotation", path, line: index + 1 });
    });
  }
  return issues;
}

export function scanProofStatusRepository({ root = DEFAULT_ROOT, registryPath = DEFAULT_REGISTRY } = {}) {
  root = resolve(root);
  registryPath = resolve(registryPath);
  const plannerSkillRoot = join(root, ".agent", "skills", "iterative-planner");
  const registry = loadRegistry(registryPath);
  const protocolExemptionIds = new Set((registry.protocol_exemptions || []).map((entry) => entry.id));
  const repositoryFiles = repositorySourceFiles(root);
  const sourceFiles = collectSourceFiles(root, repositoryFiles);
  const candidates = [];
  for (const file of sourceFiles) {
    const path = relative(root, file).replace(/\\/g, "/");
    const language = extname(file) === ".pl" ? "prolog" : "javascript";
    candidates.push(...scanProofStatusSource(readFileSync(file, "utf8"), { path, language }));
  }
  const issues = registryIssues({ root, registry, candidates, sourceFiles });
  return {
    schema_version: 1,
    status: issues.length === 0 ? "PASS" : "FAIL",
    root,
    registry_path: relative(root, registryPath).replace(/\\/g, "/"),
    denominators: {
      baseline_javascript_files: registry.baseline?.javascript_files ?? null,
      baseline_prolog_files: registry.baseline?.prolog_files ?? null,
      checked_javascript_files: repositoryFiles.filter((file) => extname(file) !== ".pl").length,
      checked_prolog_files: repositoryFiles.filter((file) => extname(file) === ".pl" && file.startsWith(plannerSkillRoot)).length,
      excluded_nonproduction_javascript_files: repositoryFiles.filter((file) => extname(file) !== ".pl" && !sourceFiles.includes(file)).length,
      scanned_production_files: sourceFiles.length,
      scanned_source_files: sourceFiles.length,
      javascript_files: sourceFiles.filter((file) => extname(file) !== ".pl").length,
      prolog_files: sourceFiles.filter((file) => extname(file) === ".pl").length,
      registered_readers: registry.readers.length,
      canonical_derived_readers: registry.readers.filter((reader) => reader.classification === "canonical-derived").length,
      repaired_readers: registry.readers.filter((reader) => reader.classification === "repaired").length,
      discovered_candidates: candidates.length,
      live_exemptions: candidates.filter((candidate) => candidate.exemption?.valid || protocolExemptionIds.has(candidate.id)).length,
      protocol_exemptions: (registry.protocol_exemptions || []).length,
    },
    candidates,
    issues,
    readers: registry.readers,
    protocol_exemptions: registry.protocol_exemptions || [],
  };
}

export function renderProofStatusCensus(result) {
  const lines = [
    "# Proof and verification-status reader census",
    "",
    `Generated from \`${result.registry_path}\` by \`proof_status_census.mjs\`.`,
    "",
    `Verdict: **${result.status}**`,
    "",
    `Checked-in source denominator: ${result.denominators.checked_javascript_files} JavaScript and ${result.denominators.checked_prolog_files} Prolog files (baseline ${result.denominators.baseline_javascript_files}+${result.denominators.baseline_prolog_files}).`,
    `Scanned proof-bearing production boundary: ${result.denominators.scanned_source_files} files (${result.denominators.javascript_files} JavaScript, ${result.denominators.prolog_files} Prolog).`,
    `Registered readers: ${result.denominators.registered_readers}. Live structural candidates: ${result.denominators.discovered_candidates}. Live exemptions: ${result.denominators.live_exemptions}.`,
    `Classification counts: ${result.denominators.canonical_derived_readers} canonical-derived, ${result.denominators.repaired_readers} repaired, ${result.denominators.protocol_exemptions} exempt+reason.`,
    "",
    "| ID | Language | Path | Symbol | Classification | Reason |",
    "|---|---|---|---|---|---|",
  ];
  for (const reader of result.readers) {
    lines.push(`| ${reader.id} | ${reader.language} | \`${reader.path}\` | \`${reader.symbol || "N/A"}\` | ${reader.classification} | ${String(reader.reason || "").replace(/\|/g, "\\|")} |`);
  }
  lines.push("", "## Narrow non-proof protocol exemptions", "", "| Candidate | Path | Reason | Proof boundary |", "|---|---|---|---|");
  if (result.protocol_exemptions.length === 0) lines.push("| None | N/A | N/A | N/A |");
  else for (const exemption of result.protocol_exemptions) {
    lines.push(`| \`${exemption.id}\` | \`${exemption.path}\` | ${String(exemption.reason).replace(/\|/g, "\\|")} | ${String(exemption.proof_boundary).replace(/\|/g, "\\|")} |`);
  }
  lines.push("", "## Guard issues", "");
  if (result.issues.length === 0) lines.push("None.");
  else for (const issue of result.issues) lines.push(`- ${issue.code}: ${issue.reader || issue.path || issue.id || "repository"}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = { check: false, json: false, render: null, root: DEFAULT_ROOT, registryPath: DEFAULT_REGISTRY };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--render") options.render = argv[++i] || DEFAULT_REPORT;
    else if (arg === "--root") options.root = argv[++i];
    else if (arg === "--registry") options.registryPath = argv[++i];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = scanProofStatusRepository(options);
  if (options.render) {
    const destination = resolve(options.render);
    const { writeFileSync, mkdirSync } = await import("fs");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, renderProofStatusCensus(result));
    result.report_path = relative(resolve(options.root), destination).replace(/\\/g, "/");
  }
  if (options.json) emitJson(result);
  else console.log(`${result.status}: ${result.denominators.registered_readers} registered reader(s), ${result.issues.length} issue(s)`);
  if (options.check && !verificationStatusIsPass(result.status, "gate")) process.exitCode = 1;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
