#!/usr/bin/env node
// @planner:story_id US-087
// @planner:proves = crit:CRIT-003

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const STOPWORDS = new Set("a an and are as at be by for from has in is it of on or that the this to with without into through".split(" "));

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

function section(content, heading) {
  const match = String(content || "").match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`, "m"));
  return match ? match[1].trim() : "";
}

function stem(token) {
  return token.replace(/(ing|ed|ly|es|s)$/i, "");
}

function tokens(text) {
  return new Set(String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    .map(stem));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log('Usage: planner similar "<goal>"');
    return 0;
  }
  const goal = args.join(" ").trim();
  if (!goal) {
    console.error('ERROR: Provide a goal, e.g. planner similar "test goal"');
    return 2;
  }
  const plansDir = join(process.cwd(), "plans");
  const needle = tokens(goal);
  const rows = [];
  for (const entry of existsSync(plansDir) ? readdirSync(plansDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !entry.name.startsWith("plan_")) continue;
    const planDir = join(plansDir, entry.name);
    const plan = safeRead(join(planDir, "plan.md")) || "";
    const state = safeJson(join(planDir, "state.json")) || {};
    const planGoal = state.goal || section(plan, "Goal");
    const score = jaccard(needle, tokens(planGoal));
    if (score <= 0) continue;
    rows.push({
      score,
      name: entry.name,
      state: state.state || "UNKNOWN",
      snippet: String(planGoal || "N/A - not recorded").replace(/\s+/g, " ").slice(0, 90),
    });
  }
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  console.log(`Similar Plans for: ${goal}`);
  if (rows.length === 0) {
    console.log("- none");
    return 0;
  }
  for (const row of rows.slice(0, 5)) {
    console.log(`- ${row.score.toFixed(2)} ${row.state} plans/${row.name} - ${row.snippet}`);
  }
  return 0;
}

process.exitCode = main();
