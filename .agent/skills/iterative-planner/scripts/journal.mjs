#!/usr/bin/env node
// journal.mjs - CLI for the advisory agent journal.

import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  appendJournalEntry,
  compileJournalFacts,
  JOURNAL_CONFIDENCE,
  JOURNAL_STATUSES,
  JOURNAL_TYPES,
  loadJournal,
} from "./lib/agent_journal.mjs";

function parseArgs(argv = []) {
  const args = {
    command: null,
    cwd: process.cwd(),
    json: false,
    entry: {
      refs: [],
      promoted_to: [],
      tags: [],
      linked_ids: [],
      superseded_by: [],
      source_entries: [],
      keys: [],
    },
    unknown: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!args.command && !arg.startsWith("--")) {
      args.command = arg;
      continue;
    }
    if (arg === "--json") args.json = true;
    else if (arg === "--cwd") args.cwd = argv[++index] || args.cwd;
    else if (arg === "--id") args.entry.id = argv[++index] || "";
    else if (arg === "--type") args.entry.type = argv[++index] || "";
    else if (arg === "--status") args.entry.status = argv[++index] || "";
    else if (arg === "--confidence") args.entry.confidence = argv[++index] || "";
    else if (arg === "--topic") args.entry.topic = argv[++index] || "";
    else if (arg === "--summary") args.entry.summary = argv[++index] || "";
    else if (arg === "--actor") args.entry.actor = argv[++index] || "";
    else if (arg === "--ts") args.entry.ts = argv[++index] || "";
    else if (arg === "--created-at") args.entry.created_at = argv[++index] || "";
    else if (arg === "--valid-at") args.entry.valid_at = argv[++index] || "";
    else if (arg === "--invalid-at") args.entry.invalid_at = argv[++index] || "";
    else if (arg === "--expired-at") args.entry.expired_at = argv[++index] || "";
    else if (arg === "--project-key") args.entry.project_key = argv[++index] || "";
    else if (arg === "--ref") args.entry.refs.push(argv[++index] || "");
    else if (arg === "--promoted-to") args.entry.promoted_to.push(argv[++index] || "");
    else if (arg === "--tag") args.entry.tags.push(argv[++index] || "");
    else if (arg === "--linked-id") args.entry.linked_ids.push(argv[++index] || "");
    else if (arg === "--superseded-by") args.entry.superseded_by.push(argv[++index] || "");
    else if (arg === "--source-entry") args.entry.source_entries.push(argv[++index] || "");
    else if (arg === "--key") args.entry.keys.push(argv[++index] || "");
    else if (arg === "--verdict") args.entry.verdict = argv[++index] || "";
    else if (arg === "-h" || arg === "--help") args.command = "help";
    else args.unknown.push(arg);
  }

  args.command ||= "list";
  return args;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/journal.mjs append --type <type> --summary <text> [--topic <topic>] [--created-at <iso>] [--valid-at <iso>] [--project-key <key>] [--ref <ref>] [--promoted-to <ref>] [--superseded-by <id>] [--source-entry <id>] [--key <key>] [--verdict <verdict>] [--tag <tag>] [--json]
  node .agent/skills/iterative-planner/scripts/journal.mjs list [--json]
  node .agent/skills/iterative-planner/scripts/journal.mjs facts [--json]

Types: ${JOURNAL_TYPES.join(", ")}
Statuses: ${JOURNAL_STATUSES.join(", ")}
Confidence: ${JOURNAL_CONFIDENCE.join(", ")}`;
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === "help") return { ok: true, status: "PASS", help: usage() };
  if (args.unknown.length > 0) {
    return { ok: false, status: "FAIL", error: "unknown_options", unknown: args.unknown };
  }

  if (args.command === "append") {
    const result = appendJournalEntry({ cwd: args.cwd, entry: args.entry });
    return { status: result.ok ? "PASS" : "FAIL", ...result };
  }

  if (args.command === "list") {
    const journal = loadJournal({ cwd: args.cwd });
    return { ok: true, status: "PASS", ...journal };
  }

  if (args.command === "facts") {
    const journal = compileJournalFacts({ cwd: args.cwd });
    return { ok: true, status: "PASS", ...journal };
  }

  return { ok: false, status: "FAIL", error: "unknown_command", command: args.command };
}

function printText(report) {
  if (report.help) {
    console.log(report.help);
    return;
  }
  if (report.facts) {
    console.log(report.facts.join("\n"));
    return;
  }
  if (report.entry) {
    console.log(`Journal append: ${report.status} ${report.entry.id}`);
    return;
  }
  console.log(`Journal entries: ${report.entries?.length || 0}; issues: ${report.issues?.length || 0}`);
  for (const entry of report.entries || []) {
    console.log(`  [${entry.status}/${entry.type}] ${entry.id}: ${entry.summary}`);
  }
  for (const issue of report.issues || []) {
    console.log(`  WARN line ${issue.line}: ${issue.code}${issue.detail ? ` - ${issue.detail}` : ""}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = run(argv);
  if (args.json) emitJson(report);
  else printText(report);
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Locally built journal-validation report enum is derived from issue collection.
  return report.status === "FAIL" ? 1 : 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { parseArgs };
