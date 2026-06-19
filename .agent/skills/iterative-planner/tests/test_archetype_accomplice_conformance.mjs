#!/usr/bin/env node
// e06 conformance aggregate: pack contract + live QRV gate contract.

import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const NODE = process.execPath;

const tests = [
  "test_archetype_accomplices.mjs",
  "test_quant_results_validation.mjs",
];

let failed = 0;

for (const testFile of tests) {
  const label = `node ${join(TEST_DIR, testFile)}`;
  console.log(`\n${label}`);
  try {
    const stdout = execFileSync(NODE, [join(TEST_DIR, testFile)], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" },
      maxBuffer: 20 * 1024 * 1024,
    });
    process.stdout.write(stdout);
  } catch (err) {
    failed++;
    process.stdout.write((err.stdout || "").toString());
    process.stderr.write((err.stderr || err.message || "").toString());
  }
}

console.log(`\nConformance aggregate: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
