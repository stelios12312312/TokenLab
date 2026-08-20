#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearThreadPlanTarget,
  readThreadPlanTarget,
  writeThreadPlanTarget,
} from "../scripts/lib/plan_utils.mjs";

let passed = 0;

function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  PASS: ${label}`);
}

function makePlansRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `planner-target-${name}-`));
  const plansDir = join(root, "plans");
  mkdirSync(join(plansDir, ".thread_targets"), { recursive: true });
  mkdirSync(join(plansDir, "plan_old"));
  mkdirSync(join(plansDir, "plan_new"));
  return { root, plansDir };
}

function targetPath(plansDir, threadId) {
  return join(plansDir, ".thread_targets", `${threadId}.txt`);
}

function replaceTarget(path, bytes, suffix) {
  renameSync(path, `${path}.${suffix}`);
  writeFileSync(path, bytes, { flag: "wx" });
}

console.log("Plan target ownership tests");

{
  const { root, plansDir } = makePlansRoot("normal");
  try {
    const threadId = "normal";
    const path = targetPath(plansDir, threadId);
    const written = writeThreadPlanTarget(plansDir, "plan_old", { threadId });
    check(written.written && readThreadPlanTarget(plansDir, { threadId }) === "plan_old", "owned target round-trips");

    const mismatch = clearThreadPlanTarget(plansDir, { threadId, planDirName: "plan_new" });
    check(!mismatch.cleared && mismatch.reason === "plan_mismatch" && existsSync(path), "plan mismatch preserves current target");

    const cleared = clearThreadPlanTarget(plansDir, { threadId, planDirName: "plan_old" });
    check(cleared.cleared && !existsSync(path), "matching owner clears its target");

    const outside = join(root, "outside.txt");
    writeFileSync(outside, "plan_old\n");
    symlinkSync(outside, path);
    const unsafe = clearThreadPlanTarget(plansDir, { threadId, planDirName: "plan_old" });
    check(!unsafe.cleared && unsafe.reason === "unsafe_target" && lstatSync(path).isSymbolicLink(), "unsafe symlink target survives clear");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, plansDir } = makePlansRoot("races");
  try {
    const clearThread = "clear-race";
    const clearPath = targetPath(plansDir, clearThread);
    writeFileSync(clearPath, "plan_old\n");
    const clear = clearThreadPlanTarget(plansDir, {
      threadId: clearThread,
      planDirName: "plan_old",
      hooks: {
        beforeCleanup() {
          replaceTarget(clearPath, "plan_new\n", "old-owner");
        },
      },
    });
    check(!clear.cleared && clear.reason === "target_changed" && readFileSync(clearPath, "utf8") === "plan_new\n", "clear preserves concurrent retarget");

    const staleThread = "stale-race";
    const stalePath = targetPath(plansDir, staleThread);
    writeFileSync(stalePath, "plan_missing\n");
    const stale = readThreadPlanTarget(plansDir, {
      threadId: staleThread,
      hooks: {
        beforeStaleCleanup() {
          replaceTarget(stalePath, "plan_new\n", "stale-owner");
        },
      },
    });
    check(stale === null && readFileSync(stalePath, "utf8") === "plan_new\n", "stale cleanup preserves concurrent valid target");

    const sameThread = "same-bytes";
    const samePath = targetPath(plansDir, sameThread);
    writeFileSync(samePath, "plan_old\n");
    const before = lstatSync(samePath);
    const same = clearThreadPlanTarget(plansDir, {
      threadId: sameThread,
      planDirName: "plan_old",
      hooks: {
        beforeCleanup() {
          replaceTarget(samePath, "plan_old\n", "same-owner");
        },
      },
    });
    const after = lstatSync(samePath);
    check(
      !same.cleared
        && same.reason === "target_changed"
        && (before.dev !== after.dev || before.ino !== after.ino),
      "same-bytes different-inode retarget survives cleanup",
    );

    const writeThread = "write-race";
    const writePath = targetPath(plansDir, writeThread);
    writeFileSync(writePath, "plan_old\n");
    const racedWrite = writeThreadPlanTarget(plansDir, "plan_new", {
      threadId: writeThread,
      hooks: {
        beforeDisplace() {
          replaceTarget(writePath, "plan_old\n", "write-owner");
        },
      },
    });
    check(!racedWrite.written && racedWrite.status === "conflict" && readFileSync(writePath, "utf8") === "plan_old\n", "writer refuses a same-bytes replacement before displacement");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${passed}/${passed} assertions passed`);
