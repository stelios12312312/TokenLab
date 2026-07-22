#!/usr/bin/env node
// reflection_renderer.mjs - render IVE Phase 4.6 reflection diffs.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  compileStructuredEvidence,
  loadIveReflectionDiffInputs,
  renderReflectionMarkdown,
} from "./lib/ive_reflection_diff.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const args = { plan: null, json: false, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--plan") args.plan = argv[++index] || null;
    else if (arg.startsWith("--plan=")) args.plan = arg.slice("--plan=".length);
  }
  return args;
}

function resolvePlanDir(planArg, cwd = process.cwd()) {
  if (planArg) {
    const direct = resolve(cwd, planArg);
    if (existsSync(direct)) return direct;
    const underPlans = resolve(cwd, "plans", planArg);
    if (existsSync(underPlans)) return underPlans;
    return direct;
  }
  const pointer = join(cwd, "plans", ".current_plan");
  if (!existsSync(pointer)) return null;
  const name = readFileSync(pointer, "utf-8").trim();
  return name ? join(cwd, "plans", name) : null;
}

function renderForPlan({ plan = null, cwd = process.cwd(), write = false } = {}) {
  const planDir = resolvePlanDir(plan, cwd);
  if (!planDir || !existsSync(planDir)) {
    return {
      ok: false,
      status: "FAIL",
      issue: {
        code: "plan_not_found",
        message: `Plan not found: ${plan || "(current)"}`,
      },
    };
  }

  const { structuredTelemetry } = loadIveReflectionDiffInputs({ cwd, planDir });
  const compiled = compileStructuredEvidence(structuredTelemetry);
  const markdown = renderReflectionMarkdown(compiled.report, structuredTelemetry);
  const result = {
    ok: compiled.report.status !== "FAIL",
    status: compiled.report.status,
    plan_dir: planDir,
    plan_id: basename(planDir),
    report: compiled.report,
    markdown,
  };

  if (write) {
    mkdirSync(planDir, { recursive: true });
    const reflectionPath = join(planDir, "reflection.md");
    const legacyPath = join(planDir, "reflection.legacy.md");
    if (existsSync(reflectionPath)) {
      const existing = readFileSync(reflectionPath, "utf-8");
      if (!existing.includes("GENERATED: ive_reflection_diff") && !existsSync(legacyPath)) {
        renameSync(reflectionPath, legacyPath);
      }
    }
    writeFileSync(reflectionPath, `${markdown}\n`);
    result.wrote = reflectionPath;
    result.legacy_path = existsSync(legacyPath) ? legacyPath : null;
  }

  return result;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = renderForPlan(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok || result.markdown) {
    console.log(result.markdown || result.issue?.message || "");
  } else {
    console.error(result.issue?.message || "Reflection rendering failed.");
  }
  return result.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  const code = await main();
  process.exitCode = code;
}

export {
  parseArgs,
  renderForPlan,
  resolvePlanDir,
};
