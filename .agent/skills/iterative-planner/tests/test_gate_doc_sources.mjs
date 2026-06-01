#!/usr/bin/env node
// test_gate_doc_sources.mjs — Guard against I-014 false positives when
// projects keep their gate table in root IDE instruction files.

import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, cpSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const agentDir = resolve(skillDir, "../..");
const repoRoot = resolve(skillDir, "../../..");
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

function createTempProject() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-doc-surface-"));
  execSync("git init -q", { cwd: tmp });
  return tmp;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function run(cmd, cwd) {
  try {
    return { ok: true, stdout: execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" }) };
  } catch (e) {
    return { ok: false, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

console.log("\nGate Documentation Surface Regression Test\n");
const tmp = createTempProject();

try {
  cpSync(agentDir, join(tmp, ".agent"), { recursive: true });
  cpSync(join(repoRoot, "CLAUDE.md"), join(tmp, "CLAUDE.md"));
  run("bash .agent/scripts/sync-instructions.sh", tmp);

  const rootClaude = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
  assert(rootClaude.includes("notify-user"), "root CLAUDE.md includes notify-user");
  assert(existsSync(join(tmp, "GEMINI.md")) && existsSync(join(tmp, "AGENTS.md")), "sync script created GEMINI.md and AGENTS.md");

  const skillPath = join(tmp, ".agent/skills/iterative-planner/SKILL.md");
  let skillContent = readFileSync(skillPath, "utf-8");
  for (const gate of ["explore-to-plan", "plan-to-execute", "execute-to-reflect", "reflect-to-validate", "validate-to-close", "notify-user"]) {
    skillContent = skillContent.replaceAll(gate, gate.toUpperCase().replace(/-/g, "_"));
  }
  writeFileSync(skillPath, skillContent);

  const result = run(`${NODE} .agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants --json`, tmp);
  assert(result.ok, "rule_engine check-invariants exits cleanly");

  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* handled below */ }
  assert(!!parsed, "check-invariants output is valid JSON");

  const names = new Set((parsed?.violations || []).map((v) => v.name));
  assert(!names.has("gate_missing_skill_doc"), "I-014 does not fail when gate docs live in root IDE files");

  const ripple = run(`${NODE} .agent/skills/iterative-planner/scripts/ripple_check.mjs`, tmp);
  assert(ripple.ok, "ripple_check exits cleanly when root IDE files document the gates");
  assert(ripple.stdout.includes("All gates fully documented"), "ripple_check accepts the root instruction surface");
} finally {
  cleanup(tmp);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
