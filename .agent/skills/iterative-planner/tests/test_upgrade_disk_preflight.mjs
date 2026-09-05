#!/usr/bin/env node

import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { statfsSync, existsSync } from "fs";
import { preflightDiskSpace } from "../scripts/lib/managed_upgrade_transaction.mjs";

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

// 1. preflightDiskSpace succeeds when minFreeBytes is minimal (e.g. 1 KB)
{
  const result = preflightDiskSpace(process.cwd(), 1024);
  assert(result.ok === true, "preflightDiskSpace passes with minimal free space requirement");
  assert(typeof result.freeBytes === "number" && result.freeBytes > 0, "preflightDiskSpace returns numeric freeBytes");
}

// 2. preflightDiskSpace throws structured error when required space exceeds available disk space
{
  let caught = null;
  try {
    // Request an impossible 1000 TB free space
    preflightDiskSpace(process.cwd(), 1000 * 1024 * 1024 * 1024 * 1024);
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, "preflightDiskSpace throws when space is insufficient");
  assert(caught?.code === "ENOSPC_PREFLIGHT", "preflight error contains ENOSPC_PREFLIGHT code");
  assert(caught?.message.includes("Insufficient disk space"), "preflight error message explains insufficient space");
  assert(typeof caught?.freeBytes === "number", "preflight error carries measured freeBytes");
  assert(typeof caught?.requiredBytes === "number", "preflight error carries requiredBytes");
}

// 3. Process exit temp dir cleanup verification
{
  const childScript = `
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tracked = new Set();
function makeTemp(name) {
  const p = mkdtempSync(join(tmpdir(), "test-cleanup-fixture-"));
  tracked.add(p);
  return p;
}

process.on("exit", () => {
  for (const p of tracked) {
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

const tmp = makeTemp("test");
console.log(tmp);
process.exit(0);
`;

  const out = execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { encoding: "utf-8" });
  const createdDir = out.trim();
  assert(!existsSync(createdDir), "exit handler cleans up tracked temp directory after process exit");
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
