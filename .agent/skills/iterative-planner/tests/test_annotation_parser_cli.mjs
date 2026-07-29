#!/usr/bin/env node
// @planner:module = annotation_parser_cli_contract
// @planner:story = US-060
// @planner:proves = annotation_parser_single_json_document

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/annotation_parser.mjs", import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function fixture(name, source) {
  const root = mkdtempSync(join(tmpdir(), `annotation-parser-cli-${name}-`));
  writeFileSync(join(root, "sample.mjs"), source);
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, "--dir", root], {
    encoding: "utf8",
    env: { ...process.env, PLANNER_SKIP_SELF_HEAL: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseWholeStdout(result, label) {
  try {
    const parsed = JSON.parse(result.stdout);
    assert(true, `${label} stdout is exactly one JSON value`);
    return parsed;
  } catch (error) {
    assert(false, `${label} stdout is exactly one JSON value`, error.message);
    return null;
  }
}

console.log("\nAnnotation Parser CLI Contract Regression\n");

const roots = {
  clean: fixture("clean", "// @planner:module = clean_fixture\nexport const ok = true;\n"),
  warning: fixture("warning", "// @planner:unknown_contract = warning_fixture\nexport const ok = true;\n"),
  failure: fixture("failure", "// @planner:consumer = missing-consumer.mjs\nexport const ok = true;\n"),
};

mkdirSync(join(roots.clean, "reports/ive/test_runs/run-generated"), { recursive: true });
mkdirSync(join(roots.clean, "plans/plan_generated/artifacts/prolog"), { recursive: true });
writeFileSync(
  join(roots.clean, "reports/ive/test_runs/run-generated/copied.mjs"),
  "// @planner:consumer = missing-generated-consumer.mjs\n",
);
writeFileSync(
  join(roots.clean, "plans/plan_generated/artifacts/prolog/generated.mjs"),
  "// @planner:consumer = missing-generated-plan-consumer.mjs\n",
);

try {
  const cleanJson = run(roots.clean, ["--json", "--validate"]);
  const cleanPayload = parseWholeStdout(cleanJson, "clean JSON validation");
  assert(cleanJson.status === 0, "clean JSON validation exits 0", `status=${cleanJson.status}`);
  assert(cleanJson.stderr === "", "clean JSON validation has no stderr diagnostics", cleanJson.stderr.trim());
  assert(cleanPayload?.summary?.total_annotations === 1, "clean JSON payload reports one annotation");
  assert(cleanPayload?.summary?.total_files_scanned === 1, "generated reports and plan artifacts are excluded from source annotation discovery");
  assert(!cleanJson.stdout.includes("✅ All"), "clean JSON stdout has no human success suffix");

  const warningJson = run(roots.warning, ["--validate", "--json"]);
  const warningPayload = parseWholeStdout(warningJson, "warning JSON validation");
  assert(warningJson.status === 0, "warning JSON validation exits 0", `status=${warningJson.status}`);
  assert(warningJson.stderr.includes("Unknown annotation key: unknown_contract"), "warning diagnostic remains on stderr");
  assert(warningPayload?.summary?.errors === 1 && warningPayload?.errors?.length === 1, "warning JSON payload retains parse-error structure");
  assert(!warningJson.stdout.includes("errors,"), "warning JSON stdout has no human aggregate suffix");

  const failureJson = run(roots.failure, ["--json", "--validate"]);
  const failurePayload = parseWholeStdout(failureJson, "failure JSON validation");
  assert(failureJson.status === 1, "failure JSON validation exits 1", `status=${failureJson.status}`);
  assert(failureJson.stderr.includes("Consumer path does not exist: missing-consumer.mjs"), "failure diagnostic remains on stderr");
  assert(failurePayload?.summary?.total_annotations === 1, "failure JSON payload remains complete");
  assert(!failureJson.stdout.includes("errors,"), "failure JSON stdout has no human aggregate suffix");

  const cleanHuman = run(roots.clean, ["--validate"]);
  assert(cleanHuman.status === 0, "clean human validation exits 0", `status=${cleanHuman.status}`);
  assert(cleanHuman.stdout.includes("✅ All 1 annotations valid"), "clean human validation retains success text");

  const warningHuman = run(roots.warning, ["--validate"]);
  assert(warningHuman.status === 0, "warning human validation exits 0", `status=${warningHuman.status}`);
  assert(/0 errors, \d+ warnings/.test(warningHuman.stdout), "warning human validation retains aggregate summary");
  assert(warningHuman.stderr.includes("Unknown annotation key: unknown_contract"), "warning human diagnostic remains visible");

  const failureHuman = run(roots.failure, ["--validate"]);
  assert(failureHuman.status === 1, "failure human validation exits 1", `status=${failureHuman.status}`);
  assert(failureHuman.stdout.includes("1 errors, 0 warnings"), "failure human validation retains aggregate summary");
  assert(failureHuman.stderr.includes("Consumer path does not exist: missing-consumer.mjs"), "failure human diagnostic remains visible");
} finally {
  for (const root of Object.values(roots)) {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
