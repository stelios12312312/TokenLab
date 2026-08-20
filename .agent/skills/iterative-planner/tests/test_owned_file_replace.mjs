#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(testDir, "..");
const primitivePath = join(skillDir, "scripts", "lib", "owned_file_replace.mjs");

let primitivePromise;
let passed = 0;
let failed = 0;

function loadPrimitive() {
  primitivePromise ??= import(pathToFileURL(primitivePath).href).catch((error) => {
    throw new Error(`owned replacement primitive unavailable: ${error.code || error.message}`);
  });
  return primitivePromise;
}

function makeFixture(name, initialBytes) {
  const root = mkdtempSync(join(tmpdir(), `planner-owned-file-${name}-`));
  const path = join(root, "canonical.json");
  if (initialBytes !== undefined) writeFileSync(path, initialBytes, { flag: "wx" });
  return { root, path };
}

function replacePath(path, bytes, suffix) {
  const displaced = `${path}.${suffix}`;
  renameSync(path, displaced);
  writeFileSync(path, bytes, { flag: "wx" });
  return displaced;
}

function bytesAt(path) {
  return readFileSync(path, "utf8");
}

async function withFixture(name, initialBytes, callback) {
  const fixture = makeFixture(name, initialBytes);
  try {
    await callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function runCase(number, title, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  PASS case ${number}: ${title}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL case ${number}: ${title}`);
    console.log(`       ${error.message}`);
  }
}

console.log("Owned file replacement CAS matrix");

await runCase(1, "expected absence commits with a published ownership token", async () => {
  await withFixture("create", undefined, async ({ path }) => {
    const { replaceOwnedFile, tokenOwnsPath } = await loadPrimitive();
    const result = replaceOwnedFile({ path, bytes: "new\n", expected: null });
    assert.equal(result.status, "committed");
    assert.equal(bytesAt(path), "new\n");
    assert.equal(tokenOwnsPath(result.published), true);
    assert.equal(result.displaced, null);
  });
});

await runCase(2, "matching replacement returns published and displaced tokens", async () => {
  await withFixture("replace", "old\n", async ({ path }) => {
    const {
      finalizeOwnedFileReplace,
      observeOwnedFile,
      replaceOwnedFile,
      tokenOwnsPath,
    } = await loadPrimitive();
    const expected = observeOwnedFile(path).token;
    const result = replaceOwnedFile({ path, bytes: "new\n", expected });
    assert.equal(result.status, "committed");
    assert.equal(bytesAt(path), "new\n");
    assert.equal(tokenOwnsPath(result.published), true);
    assert.equal(tokenOwnsPath(result.displaced), true);
    assert.equal(finalizeOwnedFileReplace(result).status, "committed");
    assert.equal(existsSync(result.displaced.path), false);
  });
});

await runCase(3, "stale expected identity conflicts without changing canonical bytes", async () => {
  await withFixture("stale", "old\n", async ({ path }) => {
    const { observeOwnedFile, replaceOwnedFile } = await loadPrimitive();
    const expected = observeOwnedFile(path).token;
    replacePath(path, "foreign\n", "stale-original");
    const result = replaceOwnedFile({ path, bytes: "new\n", expected });
    assert.equal(result.status, "conflict");
    assert.equal(bytesAt(path), "foreign\n");
    assert.equal(result.published, null);
  });
});

await runCase(4, "occupied destination defeats expected-absence publication", async () => {
  await withFixture("occupied", "occupant\n", async ({ path }) => {
    const { replaceOwnedFile } = await loadPrimitive();
    const result = replaceOwnedFile({ path, bytes: "new\n", expected: null });
    assert.equal(result.status, "conflict");
    assert.equal(bytesAt(path), "occupant\n");
    assert.equal(result.published, null);
  });
});

await runCase(5, "replacement before displacement survives owned cleanup", async () => {
  await withFixture("before-displace", "old\n", async ({ path }) => {
    const {
      finalizeOwnedFileReplace,
      observeOwnedFile,
      replaceOwnedFile,
    } = await loadPrimitive();
    const expected = observeOwnedFile(path).token;
    const result = replaceOwnedFile({
      path,
      bytes: "new\n",
      expected,
      hooks: {
        beforeDisplace() {
          replacePath(path, "foreign-before\n", "owned-before");
        },
      },
    });
    assert.equal(result.status, "conflict");
    assert.equal(bytesAt(path), "foreign-before\n");
    finalizeOwnedFileReplace(result);
    assert.equal(bytesAt(path), "foreign-before\n");
  });
});

await runCase(6, "occupant inserted after displacement wins exclusive publication", async () => {
  await withFixture("before-publish", "old\n", async ({ path }) => {
    const {
      observeOwnedFile,
      replaceOwnedFile,
      rollbackOwnedFileReplace,
    } = await loadPrimitive();
    const expected = observeOwnedFile(path).token;
    const result = replaceOwnedFile({
      path,
      bytes: "new\n",
      expected,
      hooks: {
        beforePublish() {
          writeFileSync(path, "foreign-winner\n", { flag: "wx" });
        },
      },
    });
    assert.equal(result.status, "conflict");
    assert.equal(bytesAt(path), "foreign-winner\n");
    const rollback = rollbackOwnedFileReplace(result);
    assert.equal(rollback.status, "conflict");
    assert.equal(bytesAt(path), "foreign-winner\n");
  });

  await withFixture("publish-syscall-failure", "old\n", async ({ path }) => {
    const {
      observeOwnedFile,
      recoverOwnedFileReplace,
      replaceOwnedFile,
      tokenOwnsPath,
    } = await loadPrimitive();
    const error = new Error("SIMULATED_PUBLISH_IO_FAILURE");
    error.code = "EIO";
    const result = replaceOwnedFile({
      path,
      bytes: "new\n",
      expected: observeOwnedFile(path).token,
      hooks: {
        beforePublishLink() {
          throw error;
        },
      },
    });
    assert.equal(result.status, "cleanup_pending");
    assert.equal(result.phase, "displaced");
    assert.equal(existsSync(path), false);
    assert.equal(tokenOwnsPath(result.displaced), true);
    assert.equal(tokenOwnsPath(result.prepared), true);
    assert.equal(recoverOwnedFileReplace(result).status, "committed");
    assert.equal(bytesAt(path), "old\n");
    assert.equal(existsSync(result.displaced.path), false);
    assert.equal(existsSync(result.prepared.path), false);
  });
});

await runCase(7, "post-publication replacement reports cleanup pending and survives", async () => {
  await withFixture("after-publish", "old\n", async ({ path }) => {
    const {
      finalizeOwnedFileReplace,
      observeOwnedFile,
      replaceOwnedFile,
      rollbackOwnedFileReplace,
    } = await loadPrimitive();
    const expected = observeOwnedFile(path).token;
    const result = replaceOwnedFile({
      path,
      bytes: "new\n",
      expected,
      hooks: {
        afterPublish() {
          replacePath(path, "foreign-after\n", "published-owner");
        },
      },
    });
    assert.equal(result.status, "cleanup_pending");
    assert.equal(bytesAt(path), "foreign-after\n");
    assert.equal(rollbackOwnedFileReplace(result).status, "conflict");
    assert.equal(finalizeOwnedFileReplace(result).status, "cleanup_pending");
    assert.equal(bytesAt(path), "foreign-after\n");
  });
});

await runCase(8, "rollback restores only while the published token still owns canonical", async () => {
  await withFixture("rollback-owned", "old\n", async ({ path }) => {
    const {
      observeOwnedFile,
      replaceOwnedFile,
      rollbackOwnedFileReplace,
    } = await loadPrimitive();
    const expected = observeOwnedFile(path).token;
    const owned = replaceOwnedFile({ path, bytes: "new\n", expected });
    assert.equal(rollbackOwnedFileReplace(owned).status, "committed");
    assert.equal(bytesAt(path), "old\n");

    const expectedAgain = observeOwnedFile(path).token;
    const lost = replaceOwnedFile({ path, bytes: "newer\n", expected: expectedAgain });
    replacePath(path, "foreign\n", "lost-publication");
    assert.equal(rollbackOwnedFileReplace(lost).status, "conflict");
    assert.equal(bytesAt(path), "foreign\n");
  });
});

await runCase(9, "cleanup preserves a same-content different-inode substitution", async () => {
  await withFixture("cleanup-token", "same\n", async ({ path }) => {
    const { cleanupOwnedFile, observeOwnedFile } = await loadPrimitive();
    const token = observeOwnedFile(path).token;
    replacePath(path, "same\n", "original-owner");
    const result = cleanupOwnedFile(token);
    assert.equal(result.status, "conflict");
    assert.equal(bytesAt(path), "same\n");
  });
});

await runCase(10, "production adoption propagates outcomes and recovers crash phases", async () => {
  await withFixture("recovery", "old\n", async ({ path, root }) => {
    const {
      finalizeOwnedFileReplace,
      observeOwnedFile,
      ownedFileCommitSucceeded,
      recoverOwnedFileReplace,
      replaceOwnedFile,
      requireOwnedFileCommit,
    } = await loadPrimitive();
    const expected = observeOwnedFile(path).token;
    const prepared = replaceOwnedFile({
      path,
      bytes: "never-authoritative\n",
      expected,
      hooks: {
        afterPrepare() {
          throw new Error("SIMULATED_PREPARED_CRASH");
        },
      },
    });
    assert.equal(prepared.status, "cleanup_pending");
    assert.equal(recoverOwnedFileReplace(prepared).status, "conflict");
    assert.equal(bytesAt(path), "old\n");

    const committed = replaceOwnedFile({
      path,
      bytes: "authoritative\n",
      expected: observeOwnedFile(path).token,
      hooks: {
        afterPublish() {
          throw new Error("SIMULATED_COMMITTED_CRASH");
        },
      },
    });
    assert.equal(committed.status, "cleanup_pending");
    assert.equal(recoverOwnedFileReplace(committed).status, "committed");
    assert.equal(bytesAt(path), "authoritative\n");
    assert.equal(ownedFileCommitSucceeded({ status: "committed" }), true);
    assert.equal(ownedFileCommitSucceeded({ status: "conflict" }), false);
    assert.equal(requireOwnedFileCommit({ status: "committed" }).status, "committed");
    assert.throws(
      () => requireOwnedFileCommit({ status: "conflict", reason: "fixture" }, "fixture write"),
      /fixture write: conflict\/fixture/,
    );

    const {
      readTransitionJournal,
      recoverTransitionJournal,
      removeTransitionJournal,
      writeTransitionJournal,
    } = await import("../scripts/lib/transition_journal.mjs");
    const stateBefore = observeOwnedFile(path).token;
    const preparedJournal = writeTransitionJournal(root, {
      gate: "plan-to-execute",
      phase: "prepared",
      state_before: stateBefore,
      state_after: null,
    }, { expected: null });
    assert.equal(preparedJournal.status, "committed");
    assert.equal(recoverTransitionJournal(root).status, "aborted_clean");
    assert.equal(readTransitionJournal(root).status, "absent");

    const interruptedJournal = writeTransitionJournal(root, {
      gate: "plan-to-execute",
      phase: "prepared",
      state_before: observeOwnedFile(path).token,
      state_after: null,
    }, { expected: null });
    const interruptedState = replaceOwnedFile({
      path,
      bytes: "interrupted-authority\n",
      expected: observeOwnedFile(path).token,
    });
    assert.equal(interruptedState.status, "committed");
    const publishedJournal = writeTransitionJournal(root, {
      ...interruptedJournal.journal,
      phase: "state_published",
      state_after: interruptedState.published,
    }, { expected: interruptedJournal.token });
    assert.equal(publishedJournal.status, "committed");
    assert.equal(recoverTransitionJournal(root).status, "recovery_required");
    assert.equal(bytesAt(path), "interrupted-authority\n");
    assert.equal(removeTransitionJournal(publishedJournal).status, "committed");
    assert.equal(finalizeOwnedFileReplace(interruptedState).status, "committed");

    const requiredAdopters = [
      "scripts/lib/determinism.mjs",
      "scripts/lib/plan_metrics.mjs",
      "scripts/lib/gate_verdict.mjs",
      "scripts/lib/gate_input_snapshot.mjs",
      "scripts/lib/plan_refresh.mjs",
      "scripts/lib/transition_journal.mjs",
      "scripts/transition.mjs",
      "scripts/bootstrap.mjs",
      "scripts/migrate.mjs",
      "scripts/ritual_lint.mjs",
    ];
    mkdirSync(join(root, "census"), { recursive: true });
    for (const relativePath of requiredAdopters) {
      const source = readFileSync(join(skillDir, relativePath), "utf8");
      assert.match(
        source,
        /replaceOwnedFile|writeStateJsonResult|ensureCircuitBreakersState/,
        `${relativePath} lacks structured ownership adoption`,
      );
    }
    const bootstrapSource = readFileSync(join(skillDir, "scripts/bootstrap.mjs"), "utf8");
    const closeBody = bootstrapSource.match(/function cmdClose\(opts = \{\}\) \{[\s\S]*?\nfunction cmdResetCircuitBreaker/)?.[0] || "";
    assert.match(closeBody, /const statePlanDir = join\(plansDir, planDirName\);/);
    assert.match(closeBody, /const stateRead = readStateJsonWithProvenance\(statePlanDir\);/);
    assert.match(closeBody, /writeStateJsonResult\(statePlanDir, stateJson, \{\s*expected: stateRead\.provenance,/);
    assert.match(
      closeBody,
      /catch \(e\) \{\s*debugLog\("bootstrap", `state\.json close update failed: \$\{e\.message\}`\);\s*throw e;\s*\}/,
      "bootstrap close must propagate a non-committed structured state write",
    );
  });
});

console.log(`\n${passed}/10 cases passed; ${failed}/10 cases failed`);
if (failed > 0) process.exitCode = 1;
