#!/usr/bin/env node
// persona_manifest_ci.mjs - local CI backstop for persona manifests and rules snapshots.

import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import {
  formatPersonaManifestCiReport,
  runPersonaManifestCi,
} from "./lib/persona_manifest_ci.mjs";

function usage() {
  return `Usage:
  node persona_manifest_ci.mjs [--project <path>] [--json] [--no-root-instructions]

Checks:
  - persona_obligations.json manifest shape and role references
  - audit.config.json configured roles
  - high-confidence missing persona seed roles from persona_adapt
  - managed root instruction/rules snapshot parity
  - persona authority decisions for planner-core work`;
}

function readFlagValue(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) return fallback;
  return args[index + 1];
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }

  const report = runPersonaManifestCi({
    projectRoot: readFlagValue(argv, "--project", "."),
    checkRootInstructions: !argv.includes("--no-root-instructions"),
  });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatPersonaManifestCiReport(report));
  }

  return report.ok ? 0 : 1;
}

function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
