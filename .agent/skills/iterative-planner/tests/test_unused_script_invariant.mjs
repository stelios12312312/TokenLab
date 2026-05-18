#!/usr/bin/env node
// test_unused_script_invariant.mjs — B.4 guard against planner scripts that
// ship without a runtime caller or explicit user-facing CLI contract.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function runCheckInvariants(cwd) {
  try {
    const stdout = execFileSync(NODE, [".agent/skills/iterative-planner/scripts/rule_engine.mjs", "check-invariants", "--json"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, status: 0, stdout, parsed: parseJson(stdout) };
  } catch (error) {
    const stdout = error.stdout || "";
    return { ok: false, status: error.status || 1, stdout, parsed: parseJson(stdout) };
  }
}

function parseJson(stdout) {
  const start = String(stdout || "").indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(String(stdout).slice(start));
  } catch {
    return null;
  }
}

function warningNames(parsed) {
  return new Set((parsed?.warnings || []).map((entry) => entry.name));
}

function hasUnusedWarning(parsed, scriptName) {
  return (parsed?.warnings || []).some((entry) => entry.name === "unused_script" && entry.detail === scriptName);
}

console.log("\nUnused Script Invariant Tests\n");

const tmp = mkdtempSync(join(tmpdir(), "unused-script-invariant-"));
try {
  cpSync(join(repoRoot, ".agent"), join(tmp, ".agent"), { recursive: true });
  mkdirSync(join(tmp, "reports"), { recursive: true });
  cpSync(join(repoRoot, "reports", "user_story_audit"), join(tmp, "reports", "user_story_audit"), { recursive: true });

  const scriptsDir = join(tmp, ".agent", "skills", "iterative-planner", "scripts");
  const referencesDir = join(tmp, ".agent", "skills", "iterative-planner", "references");
  assert(!existsSync(join(scriptsDir, "recipe_runner.mjs")), "recipe_runner.mjs is not shipped as an active planner script");
  assert(existsSync(join(referencesDir, "recipe_runner_reference.mjs")), "recipe runner exists only as a non-dispatched reference implementation");

  const baseline = runCheckInvariants(tmp);
  assert(baseline.ok, "check-invariants exits 0 for the copied planner fixture");
  assert(!!baseline.parsed, "check-invariants emits JSON for the copied planner fixture");
  assert(!hasUnusedWarning(baseline.parsed, "recipe_runner.mjs"), "recipe runner reference does not trigger unused_script");
  assert(!hasUnusedWarning(baseline.parsed, "recipe_resolver.mjs"), "recipe_resolver.mjs remains caller-wired");
  assert(!hasUnusedWarning(baseline.parsed, "recipe_discovery.mjs"), "recipe_discovery.mjs remains caller-wired");
  assert(!hasUnusedWarning(baseline.parsed, "recipe_bootstrap.mjs"), "recipe_bootstrap.mjs remains caller-wired");

  const probeScript = "zz_unused_probe.mjs";
  writeFileSync(join(scriptsDir, probeScript), "export function probe() { return true; }\n");

  const unused = runCheckInvariants(tmp);
  assert(unused.ok, "check-invariants exits 0 when unused script is still advisory");
  assert(!!unused.parsed, "check-invariants emits JSON for unused script fixture");
  assert(warningNames(unused.parsed).has("unused_script"), "unused script warning is reported");
  assert(hasUnusedWarning(unused.parsed, probeScript), "unused script warning names the planted script");
  assert(!(unused.parsed?.violations || []).some((entry) => entry.name === "unused_script"), "unused script is not a violation before grace expiry");

  writeFileSync(join(tmp, ".agent", "workflows", "probe.md"), `# Probe\n\nRuns ${probeScript} as a wired workflow helper.\n`);
  const wired = runCheckInvariants(tmp);
  assert(wired.ok, "check-invariants exits 0 after wiring the planted script");
  assert(!!wired.parsed, "check-invariants emits JSON after wiring the planted script");
  assert(!hasUnusedWarning(wired.parsed, probeScript), "wiring the planted script clears the unused warning");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
