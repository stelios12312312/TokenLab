#!/usr/bin/env node
import assert from "assert";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const checker = join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "hooks", "commit_msg_check.mjs");

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "planner-commit-msg-"));
}

function runChecker({ cwd, message, env = {} }) {
  const messagePath = join(cwd, "COMMIT_EDITMSG");
  writeFileSync(messagePath, message);
  return spawnSync(process.execPath, [checker, messagePath], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...env,
      ITERATIVE_PLANNER_PROJECT_ROOT: cwd,
    },
  });
}

{
  const cwd = tempRepo();
  const subject = "Close Phase 2 Agent C";
  const result = runChecker({ cwd, message: `${subject}\n` });
  assert.notStrictEqual(result.status, 0, "empty guarded body should be rejected");
  const output = `${result.stdout}\n${result.stderr}`;
  assert(output.includes(subject), "rejection output should include failing subject");
  assert(output.includes("Why:") && output.includes("What:") && output.includes("Proof:"), "rejection output should name required headings");
}

{
  const cwd = tempRepo();
  const subject = "feat: operational hardening";
  const result = runChecker({
    cwd,
    message: `${subject}\n\nWhy: prevent drift\nWhat: add hook\n`,
  });
  assert.notStrictEqual(result.status, 0, "guarded body missing Proof should be rejected");
  const output = `${result.stdout}\n${result.stderr}`;
  assert(output.includes(subject), "missing-heading rejection should include subject");
  assert(output.includes("Proof:"), "missing-heading rejection should mention Proof");
}

{
  const cwd = tempRepo();
  const result = runChecker({
    cwd,
    message: "fix: close commit discipline\n\nWhy: prevent silent close commits\nWhat: enforce hook\nProof: hook test passes\n",
  });
  assert.strictEqual(result.status, 0, "well-formed guarded body should be accepted");
}

{
  const cwd = tempRepo();
  const result = runChecker({
    cwd,
    message: "docs: update notes\n\nshort body without structured headings\n",
  });
  assert.strictEqual(result.status, 0, "unguarded subject should be accepted");
}

{
  const cwd = tempRepo();
  const subject = "Phase 7 cleanup";
  const result = runChecker({
    cwd,
    message: `${subject}\n`,
    env: { PLANNER_ALLOW_EMPTY_BODY: "1" },
  });
  assert.strictEqual(result.status, 0, "escape env should bypass rejection");
  const logPath = join(cwd, "reports", "errors", "commit_msg_escapes.log");
  const log = readFileSync(logPath, "utf-8");
  assert(log.includes(subject), "escape log should include subject");
  assert(log.includes("PLANNER_ALLOW_EMPTY_BODY=1"), "escape log should include escape reason");
}

console.log("test_commit_msg_hook: PASS");
