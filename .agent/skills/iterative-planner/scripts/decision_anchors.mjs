#!/usr/bin/env node
// decision_anchors.mjs - CLI for journal-backed decision anchors.

import { resolve } from "path";
import {
  auditDecisionAnchors,
  retireOrphanDecisionAnchors,
  writeJournalProjection,
} from "./lib/decision_anchors.mjs";
import { emitJson } from "./lib/emit_json.mjs";

function parseArgs(argv) {
  const args = {
    command: argv[2] || "audit",
    cwd: process.cwd(),
    json: false,
    write: false,
    maxLines: 80,
    title: "Knowledge Projection",
    output: null,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--cwd") args.cwd = resolve(argv[++index] || ".");
    else if (arg.startsWith("--cwd=")) args.cwd = resolve(arg.slice("--cwd=".length) || ".");
    else if (arg === "--max-lines") args.maxLines = Number(argv[++index]);
    else if (arg.startsWith("--max-lines=")) args.maxLines = Number(arg.slice("--max-lines=".length));
    else if (arg === "--title") args.title = argv[++index] || args.title;
    else if (arg.startsWith("--title=")) args.title = arg.slice("--title=".length) || args.title;
    else if (arg === "--output") args.output = argv[++index] || null;
    else if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length) || null;
    else if (arg === "--help" || arg === "-h") args.command = "help";
  }
  return args;
}

function printJson(result, exitCode = 0) {
  emitJson(result, { exitCode });
}

function printHelp() {
  console.log([
    "Usage: node decision_anchors.mjs <audit|retire-orphans|project> [options]",
    "",
    "Options:",
    "  --json                 Print JSON.",
    "  --cwd <path>           Project root. Defaults to current directory.",
    "  --write                Apply retire-orphans changes.",
    "  --max-lines <n>        Projection line cap. Defaults to 80.",
    "  --title <text>         Projection title.",
    "  --output <path>        Write projection markdown to a file.",
  ].join("\n"));
}

function main() {
  const args = parseArgs(process.argv);
  let result;
  if (args.command === "help") {
    printHelp();
    return;
  }
  if (args.command === "audit") {
    result = auditDecisionAnchors({ cwd: args.cwd });
  } else if (args.command === "retire-orphans") {
    result = retireOrphanDecisionAnchors({ cwd: args.cwd, write: args.write });
  } else if (args.command === "project") {
    result = writeJournalProjection({
      cwd: args.cwd,
      maxLines: args.maxLines,
      title: args.title,
      outputPath: args.output ? resolve(args.cwd, args.output) : null,
    });
  } else {
    result = { ok: false, error: "unknown_command", command: args.command };
  }

  const exitCode = result.ok ? 0 : 1;
  if (args.json || args.command === "audit" || !result.ok) {
    printJson(result, exitCode);
  } else if (args.command === "project") {
    process.stdout.write(result.markdown || "");
  } else {
    console.log(result.ok ? "PASS" : "FAIL");
  }
}

main();
