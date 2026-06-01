#!/usr/bin/env node
// @planner:story_id US-087
// @planner:proves = crit:CRIT-003

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

const NA = "N/A - not recorded";

function safeRead(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function safeJson(path) {
  try {
    const content = safeRead(path);
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

function resolvePlan(argPlan) {
  const plansDir = join(process.cwd(), "plans");
  if (argPlan) {
    const name = argPlan.replace(/^plans\//, "").replace(/\/$/, "");
    const dir = resolve(process.cwd(), argPlan.startsWith("/") ? argPlan : join("plans", name));
    return { name, dir };
  }
  const pointer = safeRead(join(plansDir, ".current_plan"))?.trim();
  if (pointer) return { name: pointer, dir: join(plansDir, pointer) };
  const active = safeJson(join(plansDir, "ACTIVE_PLAN.json"));
  const activeName = active?.plan?.planDirName || active?.planDirName || active?.id;
  if (activeName) return { name: activeName, dir: join(plansDir, activeName) };
  return null;
}

function section(content, heading) {
  if (!content) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`, "m"));
  return match ? match[1].trim() : null;
}

function countChecks(progress) {
  return {
    done: (progress.match(/^- \[x\]/gm) || []).length,
    todo: (progress.match(/^- \[ \]/gm) || []).length,
    active: (progress.match(/^- \[\/\]/gm) || []).length,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: planner inspect [--plan <dir>]");
    return 0;
  }
  const planArg = args.includes("--plan") ? args[args.indexOf("--plan") + 1] : null;
  const target = resolvePlan(planArg);
  if (!target || !existsSync(target.dir)) {
    console.error("ERROR: No target plan found.");
    return 1;
  }
  const state = safeJson(join(target.dir, "state.json")) || {};
  const metrics = safeJson(join(target.dir, "metrics.json")) || safeJson(join(target.dir, "plan_metrics.json")) || {};
  const plan = safeRead(join(target.dir, "plan.md")) || "";
  const progress = safeRead(join(target.dir, "progress.md")) || "";
  const verification = safeRead(join(target.dir, "verification.md")) || "";
  const strategy = safeJson(join(target.dir, "verification_strategy.yaml"));
  const thrashing = safeJson(join(target.dir, "artifacts", "thrashing_status.json")) || safeJson(join(process.cwd(), "reports", "thrashing", `${target.name}.json`));
  const checks = countChecks(progress);
  const stat = statSync(target.dir);

  console.log(`Plan Inspect: ${target.name}`);
  console.log(`Path: plans/${target.name}`);
  console.log(`State: ${state.state || NA}`);
  console.log(`Iteration: ${state.iteration ?? NA}`);
  console.log(`Goal: ${state.goal || section(plan, "Goal")?.split("\n")[0] || NA}`);
  console.log(`Current step: ${state.current_step || NA}`);
  console.log(`Last updated: ${stat.mtime.toISOString()}`);
  console.log();
  console.log("Progress");
  console.log(`- Completed: ${checks.done}`);
  console.log(`- In progress: ${checks.active}`);
  console.log(`- Remaining: ${checks.todo}`);
  console.log();
  console.log("Verification");
  console.log(`- Strategy: ${strategy ? "present" : NA}`);
  console.log(`- PASS lines: ${(verification.match(/\bPASS\b/g) || []).length}`);
  console.log(`- FAIL lines: ${(verification.match(/\bFAIL\b/g) || []).length}`);
  console.log();
  console.log("Metrics");
  console.log(`- Gate count: ${Array.isArray(state.transitions) ? state.transitions.length : metrics.gate_count ?? NA}`);
  console.log(`- Time in phase: ${metrics.time_in_phase || metrics.current_phase_age || NA}`);
  console.log();
  console.log("Thrashing");
  console.log(`- Response level: ${thrashing?.response_level ?? NA}`);
  console.log(`- Active signals: ${Array.isArray(thrashing?.active_signal_ids) ? thrashing.active_signal_ids.join(", ") || "none" : NA}`);
  return 0;
}

process.exitCode = main();
