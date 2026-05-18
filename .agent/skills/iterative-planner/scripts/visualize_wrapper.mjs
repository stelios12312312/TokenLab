#!/usr/bin/env node
// @planner:story_id US-087
// @planner:proves = crit:CRIT-003

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const repoRoot = resolve(scriptDir, "..", "..", "..", "..");

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: planner visualize [--plan <dir>] [--open]");
    return 0;
  }
  const generator = join(repoRoot, "tools", "planner-visualizer", "generate.mjs");
  if (!existsSync(generator)) {
    console.error(`ERROR: visualizer generator not found at ${generator}`);
    return 1;
  }
  const env = { ...process.env };
  const planIndex = args.indexOf("--plan");
  if (planIndex >= 0 && args[planIndex + 1]) {
    env.PLANNER_VISUALIZER_PLAN = args[planIndex + 1];
  }
  const result = spawnSync(process.execPath, [generator], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 120_000,
  });
  if (result.error?.code === "ETIMEDOUT") {
    console.error("ERROR: planner visualizer timed out after 120s.");
    return 1;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) return result.status || 1;
  const htmlPath = join(repoRoot, "reports", "planner-visualizer", "index.html");
  console.log(`Report: ${htmlPath}`);
  if (args.includes("--open") && process.platform === "darwin") {
    spawnSync("open", [htmlPath], { stdio: "ignore" });
  }
  return 0;
}

process.exitCode = main();
