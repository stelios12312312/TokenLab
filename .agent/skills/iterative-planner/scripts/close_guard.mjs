#!/usr/bin/env node
// close_guard.mjs — CLOSE phase enforcement and minimal-CLOSE template generation.
//
// Usage:
//   node close_guard.mjs --self-test                    Run this script's local smoke check
//   node close_guard.mjs check [--plan <plan-dir>]          Check if plan is nearly done and CLOSE is needed
//   node close_guard.mjs template [--plan <plan-dir>]       Generate a minimal-CLOSE summary template from decisions.md
//
// Reads from an explicit target plan, thread-local target, or plans/.current_plan.
// Zero dependencies — Node 18+.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { getPaths, readPointer, resolvePlanTarget, readFile, readFindingsMarkdown } from "./lib/plan_utils.mjs";
import { captureEnvValues, restoreEnvValues } from "./lib/env_scope.mjs";
import { deriveVerificationTruth } from "./lib/verification_truth.mjs";
import {
  assertSelfTest,
  cleanupSelfTestTemp,
  makeSelfTestTemp,
  printSelfTestPass,
  runNodeScript,
  seedActivePlan,
  selfPath,
} from "./lib/script_self_test.mjs";

const cwd = process.cwd();
const { plansDir, knowledgeDir } = getPaths(cwd);

// ---------------------------------------------------------------------------
// Check: is CLOSE needed?
// ---------------------------------------------------------------------------

function cmdCheck(planDir, planDirName) {
  const progress = readFile(join(planDir, "progress.md"));
  const verification = readFile(join(planDir, "verification.md"));

  // R5-002-FIX: Read state from signed state.json, NOT unsigned state.md.
  // An LLM can write arbitrary content to state.md to fake the current state.
  let currentState = "UNKNOWN";
  let iteration = "?";
  try {
    const stateJson = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
    currentState = stateJson.state || "UNKNOWN";
    iteration = String(stateJson.iteration || "?");
  } catch {
    // Fallback: state.json missing or malformed
  }

  if (!progress) {
    console.log("⚠️  Cannot read progress.md — unable to assess.");
    process.exit(0);
  }

  // Count completed vs remaining
  const completed = (progress.match(/^- \[x\]/gm) || []).length;
  const inProgress = (progress.match(/^- \[\/\]/gm) || []).length;
  const remaining = (progress.match(/^- \[ \]/gm) || []).length;
  const total = completed + inProgress + remaining;

  // Verification truth is structured and fail-closed. A PASS word elsewhere in
  // the document is not close evidence, and evidence presence cannot upgrade a
  // missing, unknown, or failing result.
  const verificationTruth = deriveVerificationTruth({ cwd, planDir, verificationContent: verification });
  const allPass = verificationTruth.resultsRecorded === true && verificationTruth.allVerificationPass === true;

  console.log(`\n┌──────────────────────────────────────────────────────┐`);
  console.log(`│  CLOSE GUARD CHECK                                   │`);
  // M6-FIX: Whitelist safe characters instead of blacklisting control chars.
  // Prevents Unicode control chars (U+200B etc.) and ANSI escape injection.
  const safePlanName = planDirName.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
  console.log(`│  Plan: ${safePlanName.padEnd(45)}│`);
  console.log(`└──────────────────────────────────────────────────────┘\n`);

  console.log(`  State:       ${currentState} (iteration ${iteration})`);
  console.log(`  Progress:    ${completed}/${total} completed, ${inProgress} in progress, ${remaining} remaining`);
  console.log(`  Completion:  ${total > 0 ? Math.round((completed / total) * 100) : 0}%`);
  console.log();

  const completionPct = total > 0 ? completed / total : 0;

  if (completionPct >= 0.8 && remaining <= 1) {
    console.log(`  🔔 CLOSE IS DUE — plan is ≥80% complete.`);
    console.log(`  Action: Transition to CLOSE. Run \`close_guard.mjs template\` to generate summary.`);
  } else if (allPass) {
    console.log(`  🔔 CLOSE IS DUE — all verification criteria PASS.`);
    console.log(`  Action: Transition to CLOSE. Run \`close_guard.mjs template\` to generate summary.`);
  } else if (completionPct >= 0.5) {
    console.log(`  ⚠️  Plan is ${Math.round(completionPct * 100)}% complete — approaching CLOSE territory.`);
    console.log(`  Action: Complete remaining items, then CLOSE.`);
  } else {
    console.log(`  ✅ Plan is ${Math.round(completionPct * 100)}% complete — not yet near CLOSE.`);
  }

  // Check KB readiness
  const kbExists = existsSync(knowledgeDir);
  const mistakesExists = existsSync(join(knowledgeDir, "mistakes.md"));
  const patternsExists = existsSync(join(knowledgeDir, "patterns.md"));
  const gotchasExists = existsSync(join(knowledgeDir, "gotchas.md"));

  console.log();
  if (!kbExists) {
    console.log(`  ⚠️  Knowledge base does not exist — will need to create at CLOSE.`);
  } else {
    console.log(`  KB Status: ${mistakesExists ? "✅" : "❌"} mistakes.md  ${patternsExists ? "✅" : "❌"} patterns.md  ${gotchasExists ? "✅" : "❌"} gotchas.md`);
  }

  // RP-008: Check for placeholder content in key plan files
  const PLACEHOLDER_MARKERS = [
    "To be populated",
    "TBD",
    "TODO: fill in",
    "[placeholder]",
    "PLACEHOLDER",
  ];
  // Include summary.md so a freshly generated template (all placeholders) is flagged (F-009).
  const keyFiles = ["plan.md", "findings.md", "progress.md", "summary.md"];
  for (const kf of keyFiles) {
    const kfPath = join(planDir, kf);
    const content = kf === "findings.md"
      ? readFindingsMarkdown(planDir)
      : (existsSync(kfPath) ? readFile(kfPath) : null);
    if (content && PLACEHOLDER_MARKERS.some(m => content.includes(m))) {
      console.log(`  ⚠️  ${kf} contains placeholder content — update before closing.`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Template: generate minimal-CLOSE summary from decisions.md
// ---------------------------------------------------------------------------

function cmdTemplate(planDir, planDirName) {
  const decisions = readFile(join(planDir, "decisions.md"));
  const progress = readFile(join(planDir, "progress.md"));
  const plan = readFile(join(planDir, "plan.md"));
  const verification = readFile(join(planDir, "verification.md"));

  const goal = plan ? (plan.match(/\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || [])[1] : null;
  const goalLine = goal ? goal.split("\n")[0].trim() : "No goal found";

  // Extract completed items from progress
  const completedItems = progress
    ? (progress.match(/^- \[x\] .+$/gm) || []).map(l => l.replace(/^- \[x\] /, "  - "))
    : [];

  // Extract decisions
  const decisionHeadings = decisions
    ? (decisions.match(/^## .+$/gm) || []).filter(h => !h.includes("Decision Log")).map(h => `  - ${h.replace(/^## /, "")}`)
    : [];

  // Extract verification results
  const verificationLines = verification
    ? (verification.match(/^\| \d+ .+$/gm) || []).map(l => `  - ${l.replace(/^\| /, "").replace(/\s*\|/g, " —")}`)
    : [];

  // Generate template
  const summaryPath = join(planDir, "summary.md");
  const template = `# Summary: ${goalLine}

## What Was Done
${completedItems.length > 0 ? completedItems.join("\n") : "  - (fill in completed work)"}

## Key Decisions
${decisionHeadings.length > 0 ? decisionHeadings.join("\n") : "  - (no decisions logged — review decisions.md)"}

## Verification Results
${verificationLines.length > 0 ? verificationLines.join("\n") : "  - (fill in from verification.md)"}

## Lessons Learned
### Mistakes
- (review decisions.md for failed approaches → add to knowledge/mistakes.md as M-NNN)

### Patterns
- (review successful approaches → add to knowledge/patterns.md as P-NNN)

### Gotchas
- (review surprises → add to knowledge/gotchas.md as G-NNN)
`;

  if (existsSync(summaryPath)) {
    console.log(`⚠️  summary.md already exists — not overwriting.`);
    console.log(`  Path: ${summaryPath}`);
  } else {
    writeFileSync(summaryPath, template);
    console.log(`✅ Generated summary.md template at:`);
    console.log(`   ${summaryPath}`);
    console.log();
    console.log(`  Pre-populated from:`);
    console.log(`    - ${completedItems.length} completed items from progress.md`);
    console.log(`    - ${decisionHeadings.length} decisions from decisions.md`);
    console.log(`    - ${verificationLines.length} verification lines`);
    console.log();
    console.log(`  Next: Review and fill in Lessons Learned section, then update KB files.`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: node close_guard.mjs <command> [--plan <plan-dir>]

Commands:
  check       Check if plan is nearly done and CLOSE is needed
  template    Generate a minimal-CLOSE summary.md from decisions/progress

Reads from an explicit target plan, thread-local target, or plans/.current_plan.`);
}

const args = process.argv.slice(2);
if (args[0] === "--self-test") {
  const scriptPath = selfPath(import.meta.url);
  const tmp = makeSelfTestTemp("close-guard");
  try {
    const planDir = seedActivePlan(tmp, "plan_close_self_test");
    writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "EXECUTE", iteration: 2 }, null, 2));
    writeFileSync(join(planDir, "progress.md"), `# Progress

- [x] finished one
- [x] finished two
- [x] finished three
- [x] finished four
- [ ] wrap up notes
`);
    writeFileSync(join(planDir, "verification.md"), "## Verification\nPASS\n");
    writeFileSync(join(planDir, "decisions.md"), `# Decisions

## D-001
Use close_guard smoke fixture
`);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Close guard smoke coverage
`);

    const checkResult = runNodeScript([scriptPath, "check"], tmp);
    assertSelfTest(checkResult.ok, "close_guard check exits cleanly", checkResult.stderr || checkResult.stdout);
    assertSelfTest(checkResult.stdout.includes("CLOSE IS DUE"), "close_guard check identifies a near-close plan", checkResult.stdout);

    const templateResult = runNodeScript([scriptPath, "template"], tmp);
    assertSelfTest(templateResult.ok, "close_guard template exits cleanly", templateResult.stderr || templateResult.stdout);
    assertSelfTest(existsSync(join(planDir, "summary.md")), "close_guard template writes summary.md");

    printSelfTestPass("close_guard");
  } finally {
    cleanupSelfTestTemp(tmp);
  }
  process.exit(0);
}

if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
  printUsage();
  process.exit(0);
}

let planOverride = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--plan") {
    planOverride = args[i + 1] || null;
    i++;
  }
}

const target = resolvePlanTarget(plansDir, { exitOnMissing: false, plan: planOverride });
const { planDirName, planDir } = target;
if (!planDirName) {
  console.error("ERROR: No target plan.");
  process.exit(1);
}
const plannerEnvScope = captureEnvValues(["_PLANNER_PLAN_TARGET"]);
process.env._PLANNER_PLAN_TARGET = planDirName;
try {

if (target.source && target.source !== "pointer") {
  console.log(`Target source: ${target.source}`);
  const pointerPlanDirName = readPointer(plansDir);
  if (pointerPlanDirName && pointerPlanDirName !== planDirName) {
    console.log(`Pointer: plans/.current_plan → ${pointerPlanDirName}`);
  }
  console.log();
}

if (args[0] === "check") {
  cmdCheck(planDir, planDirName);
} else if (args[0] === "template") {
  cmdTemplate(planDir, planDirName);
} else {
  console.error(`ERROR: Unknown command "${args[0]}". Use --help.`);
  process.exit(1);
}
} finally {
  restoreEnvValues(plannerEnvScope);
}
