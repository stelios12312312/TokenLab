#!/usr/bin/env node

import assert from "assert/strict";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { validateCommitMessage } from "../scripts/lib/sidekick_commit_message.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const planner = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "planner.mjs");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function tempProject() {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-sidekick-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  return dir;
}

function runPlanner(cwd, args, input = "") {
  return execFileSync(process.execPath, [planner, ...args], {
    cwd,
    input,
    encoding: "utf-8",
    env: { ...process.env },
  });
}

function writeConfig(cwd, body) {
  writeFileSync(join(cwd, ".agent", "sidekick.config.yaml"), body);
}

const diff = [
  "diff --git a/example.txt b/example.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/example.txt",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n");

test("missing config prints setup instructions and exits 0", () => {
  const cwd = tempProject();
  try {
    const out = runPlanner(cwd, ["sidekick", "commit-message"], diff);
    assert.match(out, /Sidekick not configured/);
    assert.match(out, /planner sidekick init/);
    assert.equal(existsSync(join(cwd, "reports", "sidekick")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("working provider returns valid conventional commit message and audit log", () => {
  const cwd = tempProject();
  try {
    writeConfig(cwd, [
      "provider: fixture",
      "providers:",
      "  fixture:",
      "    type: mock",
      "    model: deterministic",
      "    mock_response: \"feat(sidekick): add commit helper\\n\\nWhy\\n- Reduce mechanical commit drafting\\n\\nWhat\\n- Add sidekick pilot\\n\\nProof\\n- node test_sidekick.mjs\"",
    ].join("\n"));
    const out = runPlanner(cwd, ["sidekick", "commit-message"], diff);
    assert.equal(validateCommitMessage(out).ok, true);
    assert.match(out, /^feat\(sidekick\): add commit helper/);
    const logDir = join(cwd, "reports", "sidekick");
    assert.equal(existsSync(logDir), true);
    const logText = readFileSync(join(logDir, new Date().toISOString().slice(0, 10) + ".log"), "utf-8");
    const event = JSON.parse(logText.trim());
    assert.equal(event.status, "success");
    assert.equal(event.retention, "permanent");
    assert.equal(event.retention_class, 4);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("provider unreachable falls back to the driving agent", () => {
  const cwd = tempProject();
  try {
    writeConfig(cwd, [
      "provider: local",
      "providers:",
      "  local:",
      "    type: ollama",
      "    host: http://127.0.0.1:9",
      "    model: missing",
      "    timeout_ms: 50",
    ].join("\n"));
    const out = runPlanner(cwd, ["sidekick", "commit-message"], diff);
    assert.match(out, /Driving agent: please generate this/);
    assert.match(out, /Prompt:/);
    assert.match(out, /Why/);
    assert.match(out, /What/);
    assert.match(out, /Proof/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("malformed provider output is rejected and falls back", () => {
  const cwd = tempProject();
  try {
    writeConfig(cwd, [
      "provider: fixture",
      "providers:",
      "  fixture:",
      "    type: mock",
      "    model: deterministic",
      "    mock_response: \"not a commit message\"",
    ].join("\n"));
    const out = runPlanner(cwd, ["sidekick", "commit-message"], diff);
    assert.match(out, /invalid_conventional_header/);
    assert.match(out, /Driving agent: please generate this/);
    assert.equal(validateCommitMessage("not a commit message").ok, false);
    assert.equal(validateCommitMessage("not a commit message").reason, "invalid_conventional_header");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("sidekick CLI does not write git or plan artifacts directly", () => {
  const source = readFileSync(join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "sidekick.mjs"), "utf-8");
  assert.doesNotMatch(source, /git\s+commit|plans\/|writeFileSync|appendFileSync/);
});

test("commit-message validator enforces Why What Proof sections", () => {
  const valid = validateCommitMessage("fix(core): handle rollback\n\nWhy\n- Prevent week-one migration failures\n\nWhat\n- Add rollback guard\n\nProof\n- node test_migration.mjs");
  assert.equal(valid.ok, true);
  const missingProof = validateCommitMessage("fix(core): handle rollback\n\nWhy\n- Need it\n\nWhat\n- Added it");
  assert.equal(missingProof.ok, false);
  assert.equal(missingProof.reason, "missing_proof_section");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
