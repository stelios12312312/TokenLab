#!/usr/bin/env node
// issue_history_facts.mjs — Query local GitHub Issue history cache facts.

import { resolve } from "path";

import { collectIssueHistoryFactBundle } from "./lib/issue_history_facts.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { DEFAULT_CACHE_ROOT } from "./lib/issue_history_cache.mjs";
import { createSession } from "./lib/prolog.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function usage() {
  return `issue_history_facts.mjs — local issue-history ontology facts

Usage:
  node issue_history_facts.mjs facts [--dir <repo>] [--cache-root plans/knowledge/github_issues] [--cache <cache-dir>] [--json]
  node issue_history_facts.mjs query "<prolog>" [--dir <repo>] [--cache-root plans/knowledge/github_issues] [--cache <cache-dir>] [--json]

This command reads local cache files only. It does not call GitHub.`;
}

function parseArgs(argv = []) {
  const args = [...argv];
  const parsed = {
    command: args.shift() || "facts",
    cwd: process.cwd(),
    cacheRoot: DEFAULT_CACHE_ROOT,
    cache: null,
    queryText: null,
    json: false,
    help: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg.startsWith("-") && parsed.command === "query" && !parsed.queryText) {
      parsed.queryText = arg;
    } else if (arg === "--dir" || arg === "--cwd") {
      parsed.cwd = resolve(args.shift() || process.cwd());
    } else if (arg === "--cache-root") {
      parsed.cacheRoot = args.shift() || DEFAULT_CACHE_ROOT;
    } else if (arg === "--cache") {
      parsed.cache = args.shift() || null;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function normalizeQueryText(queryText) {
  return String(queryText || "").trim().replace(/\.\s*$/, "");
}

function queryFacts(bundle, queryText) {
  const normalized = normalizeQueryText(queryText);
  if (!normalized) {
    return {
      ok: false,
      status: "FAIL",
      query: "",
      solution_count: 0,
      solutions: [],
      error: "query text is required",
    };
  }
  const session = createSession();
  session.consult(bundle.facts.join("\n"));
  try {
    const solutions = session.queryAll(normalized);
    return {
      ok: true,
      status: bundle.status,
      query: normalized,
      solution_count: solutions.length,
      solutions,
    };
  } catch (error) {
    return {
      ok: false,
      status: "FAIL",
      query: normalized,
      solution_count: 0,
      solutions: [],
      error: error.message,
    };
  }
}

function renderFacts(bundle) {
  return bundle.facts.join("\n");
}

function renderQuery(result) {
  const lines = [
    `issue_history_query: ${result.ok ? "PASS" : "FAIL"}`,
    `query: ${result.query}`,
    `solutions: ${result.solution_count}`,
  ];
  for (const solution of result.solutions || []) {
    const entries = Object.entries(solution);
    lines.push(entries.length > 0 ? `- ${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")}` : "- yes");
  }
  if (result.error) lines.push(`error: ${result.error}`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.command === "help") {
    return { ok: true, status: "PASS", help: usage() };
  }
  if (cwd && args.cwd === process.cwd()) args.cwd = cwd;
  const bundle = collectIssueHistoryFactBundle({
    cwd: args.cwd,
    cacheRoot: args.cacheRoot,
    cacheDir: args.cache,
  });

  if (args.command === "facts") return { ...bundle, command: "facts" };
  if (args.command === "query") {
    return {
      ...queryFacts(bundle, args.queryText),
      command: "query",
      cwd: args.cwd,
      cache_root: args.cacheRoot,
      cache_dir: args.cache,
      cache_meta: bundle.meta,
      caches: bundle.caches,
    };
  }
  throw new Error(`Unknown command: ${args.command}`);
}

if (isDirectInvocation(import.meta.url)) {
  main()
    .then((result) => {
      const json = process.argv.includes("--json");
      if (result.help && !json) console.log(result.help);
      else if (json) emitJson(result);
      else if (result.command === "query") console.log(renderQuery(result));
      else console.log(renderFacts(result));
      // proof-status-lint: exempt T-INTAKE-B07B8898 -- Fact-generation command result is synthesized from local I/O and validation errors.
      if (result.status === "FAIL") process.exitCode = 1;
    })
    .catch((error) => {
      if (process.argv.includes("--json")) {
        emitJson({ ok: false, status: "FAIL", error: error.message });
      } else {
        console.error(`issue_history_facts: FAIL\n${error.message}`);
      }
      process.exitCode = 1;
    });
}
