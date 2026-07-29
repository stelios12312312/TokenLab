#!/usr/bin/env node
// issue_history_cache.mjs — CLI for deterministic GitHub Issue history cache.

import {
  collectIssueHistoryCache,
  DEFAULT_CACHE_ROOT,
  repoSlug,
  verifyIssueHistoryCache,
} from "./lib/issue_history_cache.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function parseArgs(argv = []) {
  const args = [...argv];
  const parsed = {
    command: args.shift() || "help",
    repo: null,
    out: DEFAULT_CACHE_ROOT,
    cache: null,
    state: "all",
    labels: [],
    scope: "all",
    limit: 100,
    ttlHours: 24,
    generatedAt: null,
    remoteMode: null,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo") parsed.repo = args[++i] || null;
    else if (arg === "--out") parsed.out = args[++i] || DEFAULT_CACHE_ROOT;
    else if (arg === "--cache") parsed.cache = args[++i] || null;
    else if (arg === "--state") parsed.state = args[++i] || "all";
    else if (arg === "--labels") parsed.labels = args[++i] || "";
    else if (arg === "--scope") parsed.scope = args[++i] || "all";
    else if (arg === "--limit") parsed.limit = Number(args[++i] || 100);
    else if (arg === "--ttl-hours") parsed.ttlHours = Number(args[++i] || 24);
    else if (arg === "--generated-at") parsed.generatedAt = args[++i] || null;
    else if (arg === "--remote-mode") parsed.remoteMode = args[++i] || null;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.command = "help";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage() {
  return `issue_history_cache.mjs — deterministic GitHub Issue history cache

Usage:
  node issue_history_cache.mjs collect --repo <owner/repo> [--out plans/knowledge/github_issues] [--state open|closed|all] [--labels a,b] [--scope all|assigned|created|mentioned] [--limit n] [--ttl-hours n] [--remote-mode local-only|remote-read|remote-sync] [--json]
  node issue_history_cache.mjs verify --cache <cache-dir> [--json]

Modes:
  collect requires remote-read or remote-sync. verify is offline and reads only cache files.`;
}

function render(result) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Cache command operation result is synthesized from local I/O and error state.
  if (result.status === "PASS") {
    return `issue_history_cache: PASS\ncache: ${result.cache_dir}\nissues: ${result.manifest?.issue_count ?? result.issue_count ?? 0}`;
  }
  if (result.status === "WARN") {
    return `issue_history_cache: WARN\ncache: ${result.cache_dir}\npartial_failures: ${result.partial_failures?.length ?? result.partial_failure_count ?? 0}`;
  }
  return `issue_history_cache: FAIL\n${result.error_code || "error"}: ${result.error || "unknown error"}`;
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, ghRunner = undefined } = {}) {
  const args = parseArgs(argv);
  if (args.command === "help") return { ok: true, status: "PASS", help: usage() };
  if (args.command === "collect") {
    return collectIssueHistoryCache({
      cwd,
      env,
      repo: args.repo,
      out: args.out,
      state: args.state,
      labels: args.labels,
      scope: args.scope,
      limit: args.limit,
      ttlHours: args.ttlHours,
      generatedAt: args.generatedAt || new Date().toISOString(),
      remoteMode: args.remoteMode,
      ghRunner,
    });
  }
  if (args.command === "verify") {
    const cache = args.cache || (args.repo ? `${args.out}/${repoSlug(args.repo)}` : null);
    return verifyIssueHistoryCache({ cwd, cacheDir: cache });
  }
  throw new Error(`Unknown command: ${args.command}`);
}

if (isDirectInvocation(import.meta.url)) {
  main()
    .then((result) => {
      const json = process.argv.includes("--json");
      if (result.help && !json) console.log(result.help);
      else if (json) emitJson(result);
      else console.log(render(result));
      // proof-status-lint: exempt T-INTAKE-B07B8898 -- Cache command operation result is synthesized from local I/O and error state.
      if (result.status === "FAIL") process.exitCode = 1;
    })
    .catch((error) => {
      if (process.argv.includes("--json")) {
        emitJson({ ok: false, status: "FAIL", error: error.message });
      } else {
        console.error(`issue_history_cache: FAIL\n${error.message}`);
      }
      process.exitCode = 1;
    });
}
