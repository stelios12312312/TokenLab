#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { verificationStatusIsPass } from "./lib/verification_status_vocabulary.mjs";

const DEFAULT_OUT_DIR = "reports/ive/consolidation_receipts";

function readArgValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseArgs(argv = []) {
  const args = {
    before: null,
    after: null,
    outDir: DEFAULT_OUT_DIR,
    runId: "consolidation-receipt",
    generatedAt: null,
    sample: false,
    write: true,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--before") {
      args.before = readArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--after") {
      args.after = readArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--out-dir") {
      args.outDir = readArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--run-id") {
      args.runId = readArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--generated-at") {
      args.generatedAt = readArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--sample") {
      args.sample = true;
    } else if (arg === "--no-write") {
      args.write = false;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.help) {
    return args;
  }
  if (args.sample && (args.before || args.after)) {
    throw new Error("--sample cannot be combined with --before or --after");
  }
  if (!args.sample && (!args.before || !args.after)) {
    throw new Error("--before and --after are required unless --sample is used");
  }

  return args;
}

function usage() {
  return [
    "Usage: node .agent/skills/iterative-planner/scripts/consolidation_receipt.mjs --before <manifest.json> --after <manifest.json> [--out-dir <dir>] [--run-id <id>] [--generated-at <iso>] [--json]",
    "       node .agent/skills/iterative-planner/scripts/consolidation_receipt.mjs --sample --no-write --json",
  ].join("\n");
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Manifest not found: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function normalizeSuiteStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isRequiredSuite(suite) {
  return suite?.required !== false;
}

function isFailureSuite(suite) {
  return !verificationStatusIsPass(normalizeSuiteStatus(suite?.status), "execution");
}

function suiteId(suite, index) {
  return String(suite?.id || suite?.suite || suite?.name || `suite-${index + 1}`);
}

function summarizeManifest(manifest) {
  const suites = Array.isArray(manifest?.suites) ? manifest.suites : [];
  const requiredFailures = suites
    .map((suite, index) => ({ suite, id: suiteId(suite, index) }))
    .filter(({ suite }) => isRequiredSuite(suite) && isFailureSuite(suite))
    .map(({ suite, id }) => ({ id, status: normalizeSuiteStatus(suite.status) }));
  const requiredSuites = suites
    .map((suite, index) => ({ suite, id: suiteId(suite, index) }))
    .filter(({ suite }) => isRequiredSuite(suite))
    .map(({ suite, id }) => ({ id, status: normalizeSuiteStatus(suite.status) }));
  return {
    run_id: manifest?.run_id || manifest?.runId || null,
    generated_at: manifest?.generated_at || manifest?.generatedAt || null,
    overall_status: manifest?.status || manifest?.overall_status || null,
    suite_count: suites.length,
    passed: suites.filter((suite) => verificationStatusIsPass(normalizeSuiteStatus(suite.status), "execution")).length,
    failed: suites.filter((suite) => isFailureSuite(suite)).length,
    required_suites: requiredSuites,
    required_failures: requiredFailures,
  };
}

function keyFailures(failures) {
  return new Map(failures.map((failure) => [failure.id, failure]));
}

function diffRequiredFailures(beforeSummary, afterSummary) {
  const before = keyFailures(beforeSummary.required_failures);
  const after = keyFailures(afterSummary.required_failures);
  const beforeRequiredSuites = keyFailures(beforeSummary.required_suites);
  const afterRequiredSuites = keyFailures(afterSummary.required_suites);
  const newRequiredFailures = [...after.values()].filter((failure) => !before.has(failure.id));
  const resolvedRequiredFailures = [...before.values()].filter((failure) => !after.has(failure.id));
  const unchangedRequiredFailures = [...after.values()].filter((failure) => before.has(failure.id));
  const removedRequiredSuites = [...beforeRequiredSuites.values()].filter((suite) => !afterRequiredSuites.has(suite.id));
  return { newRequiredFailures, resolvedRequiredFailures, unchangedRequiredFailures, removedRequiredSuites };
}

function sampleManifest(label) {
  return {
    run_id: `sample-${label}`,
    generated_at: "2026-07-04T00:00:00.000Z",
    status: "FAIL",
    suites: [
      { id: "program-packet-design-to-ready", status: "fail", required: true },
      { id: "cli-determinism", status: "fail", required: true },
      { id: "story-registry-merge-guard", status: "pass", required: true },
    ],
  };
}

export function buildReceipt({ beforeManifest, afterManifest, runId, generatedAt }) {
  const before = summarizeManifest(beforeManifest);
  const after = summarizeManifest(afterManifest);
  const diff = diffRequiredFailures(before, after);
  const status = diff.newRequiredFailures.length === 0 && diff.removedRequiredSuites.length === 0 ? "PASS" : "FAIL";
  return {
    schema_version: "ive.consolidation_receipt.v1",
    status,
    generated_at: generatedAt || new Date().toISOString(),
    run_id: runId,
    policy: {
      push_bypass_allowed_when: "no_new_required_failures",
      github_actions_evidence_allowed: false,
    },
    before,
    after,
    new_required_failures: diff.newRequiredFailures,
    removed_required_suites: diff.removedRequiredSuites,
    resolved_required_failures: diff.resolvedRequiredFailures,
    unchanged_required_failures: diff.unchangedRequiredFailures,
  };
}

function writeReceipt(outDir, runId, receipt) {
  const artifactDir = join(outDir, runId);
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, "receipt.json");
  writeFileSync(artifactPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  return artifactPath;
}

function renderText(receipt, artifactPath = null) {
  const lines = [
    `Consolidation receipt: ${receipt.status}`,
    `Run: ${receipt.run_id}`,
    `New required failures: ${receipt.new_required_failures.length}`,
    `Resolved required failures: ${receipt.resolved_required_failures.length}`,
  ];
  if (artifactPath) lines.push(`Artifact: ${artifactPath}`);
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return { exitCode: 0, receipt: null };
  }

  const beforeManifest = args.sample ? sampleManifest("before") : readJsonFile(args.before);
  const afterManifest = args.sample ? sampleManifest("after") : readJsonFile(args.after);
  const receipt = buildReceipt({
    beforeManifest,
    afterManifest,
    runId: args.runId,
    generatedAt: args.generatedAt,
  });
  const artifactPath = args.write ? writeReceipt(args.outDir, args.runId, receipt) : null;
  if (artifactPath) {
    receipt.artifact_path = artifactPath;
  }

  if (args.json) {
    emitJson(receipt);
  } else {
    process.stdout.write(`${renderText(receipt, artifactPath)}\n`);
  }
  return { exitCode: verificationStatusIsPass(receipt.status, "execution") ? 0 : 1, receipt };
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const result = main();
    process.exitCode = result.exitCode;
  } catch (error) {
    const payload = {
      status: "ERROR",
      error: error instanceof Error ? error.message : String(error),
      usage: usage(),
    };
    if (process.argv.includes("--json")) {
      emitJson(payload, { fd: 2 });
    } else {
      process.stderr.write(`${payload.error}\n${payload.usage}\n`);
    }
    process.exitCode = 2;
  }
}
