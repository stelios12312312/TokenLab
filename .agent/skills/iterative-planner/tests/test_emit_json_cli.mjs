#!/usr/bin/env node
// Compatibility wrapper: n01 folds the old t01 pipe-emission guard into the
// first-class CLI determinism suite.

import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const result = spawnSync(process.execPath, [join(testDir, "test_cli_determinism.mjs"), ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

process.exitCode = result.status ?? 1;
