#!/usr/bin/env node
// app_dev_tesseract_check.mjs - CLI wrapper for the app-dev tesseract checker.

import { scanAppDevTesseractProject, summarizeAppDevTesseractReport } from "./lib/app_dev_tesseract_pack.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { normalizeVerificationStatus } from "./lib/verification_status_vocabulary.mjs";

function usage() {
  console.error("Usage: node .agent/skills/iterative-planner/scripts/app_dev_tesseract_check.mjs [--root <path>] [--json] [--strict]");
}

function parseArgs(argv) {
  const args = {
    rootDir: process.cwd(),
    json: false,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.rootDir = argv[++index] || "";
    else if (arg.startsWith("--root=")) args.rootDir = arg.slice("--root=".length);
    else if (arg === "--json") args.json = true;
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      args.unknown = arg;
    }
  }
  return args;
}

function printHuman(report) {
  console.log(`App-dev tesseract checker: ${summarizeAppDevTesseractReport(report)}`);
  for (const check of report.checks || []) {
    console.log(`- ${check.id}: ${check.status} (${check.finding_count} finding(s), ${check.surface_count} surface(s))`);
    for (const item of (check.findings || []).slice(0, 8)) {
      const location = item.line ? `${item.file}:${item.line}` : item.file;
      console.log(`  ${item.severity.toUpperCase()} ${item.code} ${location} - ${item.message}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.unknown) {
  usage();
  process.exit(args.unknown ? 2 : 0);
}

const report = scanAppDevTesseractProject({ rootDir: args.rootDir });
const reportStatus = normalizeVerificationStatus(report.status, "gate");
const exitCode = !reportStatus.valid || reportStatus.token === "UNKNOWN" || (reportStatus.kind === "fail" && report.error)
  ? 2
  : args.strict && reportStatus.kind === "fail"
    ? 1
    : 0;
if (args.json) {
  emitJson(report, { exitCode });
} else {
  printHuman(report);
  process.exit(exitCode);
}
