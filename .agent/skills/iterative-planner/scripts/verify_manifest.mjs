#!/usr/bin/env node
// verify_manifest.mjs — Compare state.md change manifest against actual git diff.
//
// Usage:
//   node verify_manifest.mjs --self-test           Run this script's local smoke check
//   node verify_manifest.mjs check                Compare manifest to git diff
//   node verify_manifest.mjs auto-approve-check   Check auto-approval criteria (≤3 files, ≤30 lines)
//
// Reads change manifest from {plan-dir}/state.md and compares with git diff output.
// Zero dependencies — Node 18+.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { getPaths, readPointer, readFile, debugLog, matchesBasename } from "./lib/plan_utils.mjs";
import {
  assertSelfTest,
  cleanupSelfTestTemp,
  initGitRepo,
  makeSelfTestTemp,
  printSelfTestPass,
  runBin,
  runNodeScript,
  seedActivePlan,
  selfPath,
} from "./lib/script_self_test.mjs";

const cwd = process.cwd();
const { plansDir } = getPaths(cwd);

function getManifestFiles(stateContent) {
  if (!stateContent) return [];
  // Extract files from "## Change Manifest" section
  const manifestSection = stateContent.match(/## Change Manifest[\s\S]*?(?=\n## |$)/);
  if (!manifestSection) return [];
  const files = [];
  const lines = manifestSection[0].split("\n");
  for (const line of lines) {
    // Match "- path/to/file" or "- `path/to/file`" or "- Modified: path/to/file"
    const match = line.match(/^[-*]\s+(?:(?:Modified|Created|Deleted|Added|Changed|Updated|Renamed):\s*)?`?([^\s`(]+\.\w+)`?/);
    if (match) files.push(match[1]);
  }
  return [...new Set(files)]; // deduplicate
}

function getGitDiffFiles() {
  try {
    const proc = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
    if (proc.status !== 0) throw new Error(proc.stderr || "git diff failed");
    return proc.stdout.trim().split("\n").filter(f => f.trim());
  } catch (e) {
    debugLog("getGitDiffFiles", e.message);
    // Try diff against last commit if HEAD fails
    try {
      const proc = spawnSync("git", ["diff", "--name-only"], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      if (proc.status !== 0) throw new Error(proc.stderr || "git diff failed");
      return proc.stdout.trim().split("\n").filter(f => f.trim());
    } catch (e2) {
      debugLog("getGitDiffFiles_fallback", e2.message);
      return null;
    }
  }
}

function getGitDiffStats() {
  try {
    const proc = spawnSync("git", ["diff", "--stat", "HEAD"], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
    if (proc.status !== 0) throw new Error(proc.stderr || "git diff --stat failed");
    const output = proc.stdout;
    // F-022 FIX: Handle empty diff output gracefully
    if (!output || !output.trim()) return { insertions: 0, deletions: 0, netLines: 0 };
    // Last line: "N files changed, X insertions(+), Y deletions(-)"
    const statsLine = output.trim().split("\n").pop();
    const insertions = (statsLine.match(/(\d+)\s+insertion/) || [null, "0"])[1];
    const deletions = (statsLine.match(/(\d+)\s+deletion/) || [null, "0"])[1];
    return {
      insertions: parseInt(insertions),
      deletions: parseInt(deletions),
      netLines: parseInt(insertions) - parseInt(deletions),
    };
  } catch {
    return null;
  }
}

function cmdCheck(planDir, planDirName) {
  const state = readFile(join(planDir, "state.md"));
  const manifestFiles = getManifestFiles(state);
  const gitFiles = getGitDiffFiles();

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  CHANGE MANIFEST VERIFICATION                       ║`);
  console.log(`║  Plan: ${planDirName.padEnd(45)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  if (gitFiles === null) {
    console.log("  ⚠️  Could not run git diff — not a git repository or no commits.");
    process.exit(0);
  }

  // Filter out plans/ from git diff (those shouldn't be in manifest)
  const relevantGitFiles = gitFiles.filter(f => !f.startsWith("plans/"));

  console.log(`  Manifest files: ${manifestFiles.length}`);
  console.log(`  Git diff files: ${relevantGitFiles.length}`);
  console.log();

  // Files in git but not in manifest (MISSED)
  const missed = relevantGitFiles.filter(f => !manifestFiles.some(m => matchesBasename(f, m)));
  // Files in manifest but not in git (PHANTOM)
  const phantom = manifestFiles.filter(m => !relevantGitFiles.some(f => matchesBasename(f, m)));
  // Matching
  const matched = manifestFiles.filter(m => relevantGitFiles.some(f => matchesBasename(f, m)));

  let hasFail = false;

  if (matched.length > 0) {
    console.log(`  ✅ [PASS] ${matched.length} file(s) match between manifest and git diff`);
  }

  if (missed.length > 0) {
    console.log(`  ❌ [FAIL] ${missed.length} file(s) in git diff but NOT in manifest:`);
    for (const f of missed) console.log(`          - ${f}`);
    hasFail = true;
  }

  if (phantom.length > 0) {
    console.log(`  ⚠️  [WARN] ${phantom.length} file(s) in manifest but NOT in git diff:`);
    for (const f of phantom) console.log(`          - ${f} (may have been committed already)`);
  }

  if (relevantGitFiles.length === 0 && manifestFiles.length === 0) {
    console.log(`  ✅ [PASS] No changes — manifest and git diff both empty`);
  }

  console.log();
  if (hasFail) {
    console.log(`  ══ RESULT: ❌ MANIFEST MISMATCH — update state.md change manifest ══`);
    process.exit(1);
  } else {
    console.log(`  ══ RESULT: ✅ MANIFEST VERIFIED ══`);
    process.exit(0);
  }
}

function cmdAutoApproveCheck(planDir, planDirName) {
  const gitFiles = getGitDiffFiles();
  const stats = getGitDiffStats();

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  AUTO-APPROVAL CHECK                                ║`);
  console.log(`║  Plan: ${planDirName.padEnd(45)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  if (gitFiles === null) {
    console.log("  ⚠️  Could not run git diff.");
    process.exit(0);
  }

  const relevantFiles = gitFiles.filter(f => !f.startsWith("plans/"));
  const fileCount = relevantFiles.length;
  const netLines = stats ? stats.netLines : 0;

  let eligible = true;

  // Check 1: ≤3 files
  if (fileCount <= 3) {
    console.log(`  ✅ Files modified: ${fileCount} (≤3)`);
  } else {
    console.log(`  ❌ Files modified: ${fileCount} (>3 — requires approval)`);
    eligible = false;
  }

  // Check 2: ≤30 net new lines
  if (stats) {
    if (netLines <= 30) {
      console.log(`  ✅ Net new lines: ${netLines >= 0 ? "+" : ""}${netLines} (≤30)`);
    } else {
      console.log(`  ❌ Net new lines: +${netLines} (>30 — requires approval)`);
      eligible = false;
    }
    console.log(`     (${stats.insertions} insertions, ${stats.deletions} deletions)`);
  }

  console.log();
  if (eligible) {
    console.log(`  ══ RESULT: ✅ AUTO-APPROVAL ELIGIBLE ══`);
  } else {
    console.log(`  ══ RESULT: ❌ REQUIRES USER APPROVAL ══`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: node verify_manifest.mjs <command>

Commands:
  check               Compare state.md manifest to git diff
  auto-approve-check  Check auto-approval criteria (≤3 files, ≤30 lines)

Reads from active plan directory (plans/.current_plan).`);
}

const args = process.argv.slice(2);
if (args[0] === "--self-test") {
  const scriptPath = selfPath(import.meta.url);
  const tmp = makeSelfTestTemp("verify-manifest");
  try {
    initGitRepo(tmp);
    const planDir = seedActivePlan(tmp, "plan_manifest_self_test");
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "main.js"), "export const value = 1;\n");
    writeFileSync(join(planDir, "state.md"), `# State

## Change Manifest
- src/main.js
`);

    const add = runBin("git", ["add", "."], tmp);
    assertSelfTest(add.ok, "git add succeeds for verify_manifest fixture", add.stderr || add.stdout);
    const commit = runBin("git", ["commit", "-m", "initial fixture"], tmp);
    assertSelfTest(commit.ok, "git commit succeeds for verify_manifest fixture", commit.stderr || commit.stdout);

    writeFileSync(join(tmp, "src", "main.js"), "export const value = 2;\n");

    const checkResult = runNodeScript([scriptPath, "check"], tmp);
    assertSelfTest(checkResult.ok, "verify_manifest check exits cleanly for a matching manifest", checkResult.stderr || checkResult.stdout);
    assertSelfTest(checkResult.stdout.includes("MANIFEST VERIFIED"), "verify_manifest check reports a verified manifest", checkResult.stdout);

    const autoApprove = runNodeScript([scriptPath, "auto-approve-check"], tmp);
    assertSelfTest(autoApprove.ok, "verify_manifest auto-approve-check exits cleanly for a small diff", autoApprove.stderr || autoApprove.stdout);
    assertSelfTest(autoApprove.stdout.includes("AUTO-APPROVAL ELIGIBLE"), "verify_manifest auto-approve-check reports eligibility for a small diff", autoApprove.stdout);

    printSelfTestPass("verify_manifest");
  } finally {
    cleanupSelfTestTemp(tmp);
  }
  process.exit(0);
}

if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
  printUsage();
  process.exit(0);
}

const planDirName = readPointer(plansDir);
if (!planDirName) {
  console.error("ERROR: No active plan.");
  process.exit(1);
}
const planDir = join(plansDir, planDirName);

if (args[0] === "check") {
  cmdCheck(planDir, planDirName);
} else if (args[0] === "auto-approve-check") {
  cmdAutoApproveCheck(planDir, planDirName);
} else {
  console.error(`ERROR: Unknown command "${args[0]}". Use --help.`);
  process.exit(1);
}
