#!/usr/bin/env node

import { writeFileSync } from "fs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  measurePlanArtifactProjection,
  renderPlanArtifact,
  renderPlanArtifacts,
  resolvePlanDirForRenderer,
  summarizeRenderResults,
  writeRenderedArtifacts,
} from "./lib/plan_artifact_renderer.mjs";

function usage(exitCode = 0) {
  const text = [
    "plan_artifact_renderer.mjs — render plan markdown artifacts from JSON sources",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/plan_artifact_renderer.mjs render --plan <plan> [--artifact <name|all>] [--write] [--json]",
    "  node .agent/skills/iterative-planner/scripts/plan_artifact_renderer.mjs measure [--plans plans] [--sample 5] [--json]",
    "",
    "Artifacts:",
    "  state.md, findings.md, plan.md, verification.md, persona_guidance.md, persona_constraints.md, persona_findings.md, persona_execution.md",
  ].join("\n");
  if (exitCode === 0) console.log(text);
  else console.error(text);
  process.exit(exitCode);
}

function flagValue(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function parseArtifacts(args) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--artifact" && args[i] !== "--artifacts") continue;
    if (args[i + 1]) values.push(args[i + 1]);
    i += 1;
  }
  return values.length > 0 ? values : ["all"];
}

function runRender(args) {
  const json = hasFlag(args, "--json");
  const write = hasFlag(args, "--write");
  const planArg = flagValue(args, "--plan");
  if (!planArg) usage(1);
  const planDir = resolvePlanDirForRenderer(planArg);
  const artifacts = parseArtifacts(args);
  const results = write
    ? writeRenderedArtifacts(planDir, { artifacts })
    : renderPlanArtifacts(planDir, { artifacts });
  const summary = summarizeRenderResults(planDir, results);
  summary.write = write;

  if (json) {
    emitJson(summary);
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Renderer summary status is locally synthesized from artifact-render errors.
    process.exit(summary.status === "PASS" ? 0 : 1);
  }

  if (!write && results.length === 1 && results[0]?.status === "rendered") {
    writeFileSync(1, results[0].text);
    process.exit(0);
  }

  for (const result of results) {
    const writeNote = result.written ? " written" : "";
    console.log(`${result.artifact}: ${result.status}${writeNote} (${result.source || "no source"})`);
    if (result.error) console.log(`  error: ${result.error}`);
  }
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Renderer summary status is locally synthesized from artifact-render errors.
  process.exit(summary.status === "PASS" ? 0 : 1);
}

function runMeasure(args) {
  const json = hasFlag(args, "--json");
  const plansDir = flagValue(args, "--plans", "plans");
  const sample = Number(flagValue(args, "--sample", "5"));
  const result = measurePlanArtifactProjection({ plansDir, sampleLimit: sample });
  if (json) {
    emitJson(result);
    process.exit(0);
  }
  console.log(`Sampled plans: ${result.sample_count}`);
  console.log(`Current files: ${result.totals.current_file_count}`);
  console.log(`Projected files: ${result.totals.projected_file_count}`);
  console.log(`Delta files: ${result.totals.delta_files}`);
  for (const plan of result.plans) {
    console.log(`${plan.plan}: ${plan.current_file_count} -> ${plan.projected_file_count} (${plan.delta_files})`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = argv.slice(1);
  if (!command || command === "--help" || command === "help") usage(0);
  if (command === "render") return runRender(args);
  if (command === "measure") return runMeasure(args);
  usage(1);
}

if (isDirectInvocation(import.meta.url)) {
  main();
}

export { renderPlanArtifact };
