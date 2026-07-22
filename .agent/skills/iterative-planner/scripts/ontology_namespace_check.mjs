#!/usr/bin/env node
// ontology_namespace_check.mjs — closed namespace check for IVE ontology facts and packs.

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { emitJson } from "./lib/emit_json.mjs";
import { compileActiveOntologyFacts } from "./lib/ive_active_ontology.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");
const DEFAULT_MANIFEST_PATH = join(SKILL_DIR, "config", "ontology_namespace.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function normalizeList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean))];
}

export function loadOntologyNamespaceManifest({ manifestPath = DEFAULT_MANIFEST_PATH } = {}) {
  const raw = readJson(manifestPath);
  return {
    path: manifestPath,
    predicate_prefixes: normalizeList(raw.predicate_prefixes),
    predicates: normalizeList(raw.predicates),
    rule_id_prefixes: normalizeList(raw.rule_id_prefixes),
  };
}

function listPackRuleFiles(skillDir = SKILL_DIR) {
  const packsDir = join(skillDir, "packs");
  if (!existsSync(packsDir)) return [];
  return readdirSync(packsDir)
    .map((packId) => join(packsDir, packId, "rules.pl"))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function stripInlineComment(line) {
  const index = String(line || "").indexOf("%");
  return index === -1 ? String(line || "") : String(line || "").slice(0, index);
}

export function parsePrologNamespaceTerms(text, { source = "inline" } = {}) {
  const predicates = [];
  const ruleIds = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripInlineComment(lines[index]);
    if (!rawLine.trim()) continue;

    const predicateMatch = rawLine.match(/^([a-z][A-Za-z0-9_]*)\s*\(/u);
    if (predicateMatch) {
      predicates.push({
        predicate: predicateMatch[1],
        source,
        line: index + 1,
      });
    }

    const ruleIdMatch = rawLine.match(/^[a-z][A-Za-z0-9_]*_violation\(\s*'([^']+)'/u);
    if (ruleIdMatch) {
      ruleIds.push({
        rule_id: ruleIdMatch[1],
        source,
        line: index + 1,
      });
    }
  }

  return { predicates, rule_ids: ruleIds };
}

function predicateAllowed(predicate, manifest) {
  if (manifest.predicates.includes(predicate)) return true;
  return manifest.predicate_prefixes.some((prefix) => predicate.startsWith(prefix));
}

function ruleIdAllowed(ruleId, manifest) {
  return manifest.rule_id_prefixes.some((prefix) => String(ruleId || "").startsWith(prefix));
}

function collectNamespaceSources({ cwd = REPO_ROOT, skillDir = SKILL_DIR, extraPrologTexts = [] } = {}) {
  const sources = [];

  const compiled = compileActiveOntologyFacts({ cwd });
  if (compiled?.facts?.length) {
    sources.push({
      source: "active-ontology",
      text: Array.isArray(compiled.facts) ? compiled.facts.join("\n") : String(compiled.facts || ""),
    });
  }

  for (const path of listPackRuleFiles(skillDir)) {
    sources.push({
      source: path,
      text: readFileSync(path, "utf-8"),
    });
  }

  for (const extra of extraPrologTexts || []) {
    sources.push({
      source: extra?.source || "extra-prolog",
      text: extra?.text || "",
    });
  }

  return sources;
}

export function checkOntologyNamespace({
  cwd = REPO_ROOT,
  skillDir = SKILL_DIR,
  manifestPath = join(skillDir, "config", "ontology_namespace.json"),
  extraPrologTexts = [],
} = {}) {
  const manifest = loadOntologyNamespaceManifest({ manifestPath });
  const sources = collectNamespaceSources({ cwd, skillDir, extraPrologTexts });
  const seenPredicates = new Set();
  const seenRuleIds = new Set();
  const issues = [];

  for (const source of sources) {
    const terms = parsePrologNamespaceTerms(source.text, { source: source.source });
    for (const entry of terms.predicates) {
      seenPredicates.add(entry.predicate);
      if (!predicateAllowed(entry.predicate, manifest)) {
        issues.push({
          code: "predicate_out_of_namespace",
          predicate: entry.predicate,
          source: entry.source,
          line: entry.line,
          message: `Predicate ${entry.predicate} is outside ontology namespace manifest`,
        });
      }
    }
    for (const entry of terms.rule_ids) {
      seenRuleIds.add(entry.rule_id);
      if (!ruleIdAllowed(entry.rule_id, manifest)) {
        issues.push({
          code: "rule_id_out_of_namespace",
          rule_id: entry.rule_id,
          source: entry.source,
          line: entry.line,
          message: `Rule id ${entry.rule_id} is outside ontology namespace manifest`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? "PASS" : "FAIL",
    manifest_path: manifest.path,
    source_count: sources.length,
    predicate_count: seenPredicates.size,
    rule_id_count: seenRuleIds.size,
    issues,
  };
}

function main() {
  const jsonMode = process.argv.includes("--json");
  const result = checkOntologyNamespace({ cwd: process.cwd() });
  if (jsonMode) {
    emitJson(result);
  } else {
    console.log(`${result.status}: ontology namespace check (${result.issue_count || result.issues.length} issue(s))`);
    for (const issue of result.issues) {
      console.log(`  - ${issue.source}:${issue.line} ${issue.message}`);
    }
  }
  return result.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
