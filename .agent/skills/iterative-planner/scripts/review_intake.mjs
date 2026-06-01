#!/usr/bin/env node
// review_intake.mjs - Inspect and materialize review-disposition obligations.

import { existsSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";
import { computeReviewIntake, writeReviewIntakeLedger } from "./lib/review_intake.mjs";
import { getPaths, resolvePlanTarget } from "./lib/plan_utils.mjs";

function parseArgs(argv) {
  const args = { command: argv[2] || "help", plan: null, json: false, write: false };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") args.json = true;
    else if (token === "--write") args.write = true;
    else if (token === "--plan") {
      args.plan = argv[index + 1] || null;
      index += 1;
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/review_intake.mjs status --plan <plan> [--json]",
    "  node .agent/skills/iterative-planner/scripts/review_intake.mjs collect --plan <plan> --write [--json]",
  ].join("\n");
}

function resolvePlan(cwd, planArg) {
  const { plansDir } = getPaths(cwd);
  if (!planArg) {
    const target = resolvePlanTarget(plansDir, { exitOnMissing: false });
    if (!target.planDirName) return { ok: false, error: "No active plan found" };
    return {
      ok: true,
      planDirName: target.planDirName,
      planDir: target.planDir,
      source: target.source || "pointer",
    };
  }

  const candidate = isAbsolute(planArg)
    ? planArg
    : planArg.includes("/") || planArg.includes("\\")
      ? resolve(cwd, planArg)
      : join(plansDir, planArg);
  return {
    ok: existsSync(candidate),
    planDirName: basename(candidate),
    planDir: candidate,
    source: planArg,
    error: existsSync(candidate) ? null : `Plan directory not found: ${candidate}`,
  };
}

function printHuman(result) {
  if (!result.ok) {
    console.log(`review_intake: FAIL - ${result.error || "unknown error"}`);
    return;
  }
  const signal = result.review_intake || {};
  console.log(`review_intake: ${result.plan.plan_dir_name}`);
  console.log(`  status: ${signal.status || "unknown"} (required=${signal.required === true}, satisfied=${signal.satisfied === true})`);
  console.log(`  required: ${signal.required_count || 0}, unresolved: ${signal.unresolved_required_count || 0}, advisory: ${signal.advisory_count || 0}`);
  console.log(`  ledger: ${signal.ledger_present ? signal.ledger_path : "not present"}`);
  if (result.ledger_written) console.log(`  wrote: ${signal.ledger_path || result.ledger_path}`);
  for (const item of signal.unresolved_required || []) {
    console.log(`  - ${item.id}: ${item.reason || item.claim || "unresolved review item"}`);
  }
}

const args = parseArgs(process.argv);
if (!["status", "collect"].includes(args.command)) {
  console.log(usage());
  process.exitCode = args.command === "help" ? 0 : 1;
} else {
  const cwd = process.cwd();
  const plan = resolvePlan(cwd, args.plan);
  let result;
  if (!plan.ok) {
    result = { ok: false, status: "fail", error: plan.error, plan };
  } else if (args.command === "collect" && args.write) {
    const signal = writeReviewIntakeLedger({ cwd, planDir: plan.planDir });
    result = { ok: true, status: signal.satisfied ? "pass" : "blocked", plan, review_intake: signal, ledger_written: true };
  } else {
    const signal = computeReviewIntake({ cwd, planDir: plan.planDir });
    result = { ok: true, status: signal.satisfied ? "pass" : "blocked", plan, review_intake: signal };
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exitCode = result.ok ? 0 : 1;
}
