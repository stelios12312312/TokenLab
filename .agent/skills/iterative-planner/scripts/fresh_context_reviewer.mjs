#!/usr/bin/env node
// fresh_context_reviewer.mjs - E1-2 fresh-context PR reviewer CLI.

import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import {
  buildReviewerRubric,
  reviewPullRequest,
  renderReviewerComment,
  FRESH_CONTEXT_REVIEWER_CONFIG_PATH,
} from "./lib/fresh_context_reviewer.mjs";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

function parseArgs(argv = []) {
  const args = {
    command: argv[0] && !argv[0].startsWith("--") ? argv[0] : "review",
    config: FRESH_CONTEXT_REVIEWER_CONFIG_PATH,
    diffFile: "",
    changedFiles: "",
    base: "",
    head: "",
    commentFile: "",
    json: false,
    help: false,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config") args.config = argv[++index] || args.config;
    else if (token.startsWith("--config=")) args.config = token.slice("--config=".length);
    else if (token === "--diff-file") args.diffFile = argv[++index] || "";
    else if (token.startsWith("--diff-file=")) args.diffFile = token.slice("--diff-file=".length);
    else if (token === "--changed-files") args.changedFiles = argv[++index] || "";
    else if (token.startsWith("--changed-files=")) args.changedFiles = token.slice("--changed-files=".length);
    else if (token === "--base") args.base = argv[++index] || "";
    else if (token.startsWith("--base=")) args.base = token.slice("--base=".length);
    else if (token === "--head") args.head = argv[++index] || "";
    else if (token.startsWith("--head=")) args.head = token.slice("--head=".length);
    else if (token === "--comment-file") args.commentFile = argv[++index] || "";
    else if (token.startsWith("--comment-file=")) args.commentFile = token.slice("--comment-file=".length);
    else if (token === "--json") args.json = true;
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/fresh_context_reviewer.mjs rubric --config .github/reviewer/config.json [--json]
  node .agent/skills/iterative-planner/scripts/fresh_context_reviewer.mjs review --config .github/reviewer/config.json (--diff-file <path> --changed-files <csv> | --base <ref> --head <ref>) [--comment-file <path>] [--json]

Runs a fresh-context PR reviewer from only the diff, changed-file list, and pack-derived closed questions. Provider unavailable is a failed verdict, not an advisory skip.`;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !["rubric", "review"].includes(args.command)) {
    console.log(usage());
    return args.help ? 0 : 2;
  }

  try {
    if (args.command === "rubric") {
      const rubric = await buildReviewerRubric({ configPath: args.config });
      if (args.json) emitJson(rubric);
      else console.log(renderReviewerComment({
        status: "pass",
        reason: "rubric",
        summary: `${rubric.question_count} closed question(s) compiled from ${rubric.packs.join(", ")}`,
        fresh_context: true,
        question_count: rubric.question_count,
        findings: [],
      }));
      return 0;
    }

    const verdict = await reviewPullRequest({
      configPath: args.config,
      diffFile: args.diffFile,
      changedFiles: args.changedFiles,
      base: args.base,
      head: args.head,
      commentFile: args.commentFile,
    });
    if (args.json) emitJson(verdict);
    else process.stdout.write(renderReviewerComment(verdict));
    return verdict.exit_code ?? (verificationStatusIsPass(verdict.status, "execution") ? 0 : 1);
  } catch (error) {
    const result = {
      schema_version: 1,
      status: "fail",
      reason: error?.code || "reviewer_error",
      summary: error?.message || "fresh-context reviewer failed",
      fail_honest: true,
      fresh_context: true,
      findings: [],
      exit_code: error?.code === "config_missing" || error?.code === "config_invalid" ? 2 : 1,
    };
    if (args.json) emitJson(result);
    else process.stderr.write(`${result.summary}\n`);
    return result.exit_code;
  }
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = await main();
}

export { main, parseArgs };
