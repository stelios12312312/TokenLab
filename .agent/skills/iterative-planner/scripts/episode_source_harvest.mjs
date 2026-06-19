#!/usr/bin/env node
// episode_source_harvest.mjs - CLI for read-only local episode source harvesting.
// @planner:module = episode_source_harvest_cli
// @planner:capability = direct_local_episode_source_harvest_cli

import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  formatEpisodeSourceHarvestText,
  harvestEpisodeSources,
  parseEpisodeSourceHarvestArgs,
} from "./lib/episode_source_harvest.mjs";

function usage() {
  return [
    "episode_source_harvest.mjs — read-only direct-local episode source candidate harvest",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/episode_source_harvest.mjs [--json] [--scan-root <path> ...] [--max-depth <n>] [--artifact-depth <n>] [--candidate-limit <n>] [--sample-limit <n>]",
    "",
    "The command reads planner/report/knowledge/transcript-like text artifacts, emits paths/signals/counts only, and does not evaluate quant results.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const options = parseEpisodeSourceHarvestArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.unknown?.length) {
    console.error(`Unknown option(s): ${options.unknown.join(", ")}`);
    console.error(usage());
    return 2;
  }

  const report = harvestEpisodeSources({
    scanRoots: options.scanRoots,
    maxDepth: options.maxDepth,
    artifactDepth: options.artifactDepth,
    candidateLimit: options.candidateLimit,
    sampleLimit: options.sampleLimit,
  });
  if (options.json) emitJson(report);
  else console.log(formatEpisodeSourceHarvestText(report));
  return report.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
