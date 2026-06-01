#!/usr/bin/env node

import { existsSync, copyFileSync } from "fs";
import { join } from "path";
import { generateCommitMessage, readStagedDiff } from "./lib/sidekick_commit_message.mjs";
import { missingConfigMessage, readSidekickConfig, SIDEKICK_CONFIG_EXAMPLE_RELATIVE_PATH, SIDEKICK_CONFIG_RELATIVE_PATH } from "./lib/sidekick_providers.mjs";

function usage() {
  return [
    "sidekick.mjs — opt-in cheaper-model delegation for bounded planner tasks",
    "",
    "Usage:",
    "  planner sidekick init",
    "  planner sidekick commit-message [--from-diff]",
  ].join("\n");
}

function readStdinIfPresent() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function runInit(cwd) {
  const target = join(cwd, SIDEKICK_CONFIG_RELATIVE_PATH);
  if (existsSync(target)) {
    console.log(".agent/sidekick.config.yaml already exists.");
    return 0;
  }
  copyFileSync(join(cwd, SIDEKICK_CONFIG_EXAMPLE_RELATIVE_PATH), target);
  console.log("Created .agent/sidekick.config.yaml from the example template.");
  return 0;
}

async function runCommitMessage(args, cwd) {
  const configResult = readSidekickConfig(cwd);
  if (!configResult.ok) {
    console.log(missingConfigMessage());
    return 0;
  }

  const fromDiff = args.includes("--from-diff");
  const stdinText = fromDiff ? "" : await readStdinIfPresent();
  const diffText = fromDiff ? readStagedDiff(cwd) : stdinText;
  const result = await generateCommitMessage({ cwd, diffText, config: configResult.config });
  process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  return 0;
}

async function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (command === "init") return runInit(cwd);
  if (command === "commit-message") return runCommitMessage(args.slice(1), cwd);
  console.error(`Unknown sidekick subcommand: ${command}`);
  console.error(usage());
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
