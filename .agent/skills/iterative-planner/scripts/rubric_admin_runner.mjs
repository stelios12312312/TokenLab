#!/usr/bin/env node
// rubric_admin_runner.mjs - CLI for E6-3 cheap rubric-admin suite execution.

import {
  loadRubricAdminSuite,
  renderRubricAdminSuiteText,
  runRubricAdminSuite,
  validateRubricAdminSuite,
} from "./lib/rubric_admin_runner.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/rubric_admin_runner.mjs --suite <suite.json> [--model <id> ...] [--json] [--attempt N] [--max-bounces N]

Runs the deterministic E6-3 rubric-admin sycophancy suite. Exits 0 when all selected rubric-admin configs are shippable, 1 when selected configs are unshippable or invalid.`;
}

function parseInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    suitePath: null,
    modelIds: [],
    json: false,
    help: false,
    attempt: 0,
    maxBounces: 2,
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--validate-only") parsed.validateOnly = true;
    else if (arg === "--suite") parsed.suitePath = argv[++index] || null;
    else if (arg.startsWith("--suite=")) parsed.suitePath = arg.slice("--suite=".length) || null;
    else if (arg === "--model") parsed.modelIds.push(argv[++index] || "");
    else if (arg.startsWith("--model=")) parsed.modelIds.push(arg.slice("--model=".length));
    else if (arg === "--attempt") parsed.attempt = parseInteger(argv[++index], parsed.attempt);
    else if (arg.startsWith("--attempt=")) parsed.attempt = parseInteger(arg.slice("--attempt=".length), parsed.attempt);
    else if (arg === "--max-bounces") parsed.maxBounces = parseInteger(argv[++index], parsed.maxBounces);
    else if (arg.startsWith("--max-bounces=")) parsed.maxBounces = parseInteger(arg.slice("--max-bounces=".length), parsed.maxBounces);
    else if (!parsed.suitePath) parsed.suitePath = arg;
  }
  parsed.modelIds = parsed.modelIds.map((entry) => String(entry || "").trim()).filter(Boolean);
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.suitePath) {
    console.log(usage());
    return args.help ? 0 : 1;
  }

  try {
    const { path, suite } = loadRubricAdminSuite(args.suitePath);
    const validation = validateRubricAdminSuite(suite);
    if (!validation.ok || args.validateOnly) {
      const result = {
        schema_version: 1,
        return_type: "rubric_admin_suite_validation",
        ok: validation.ok,
        status: validation.status,
        suite_path: path,
        validation,
      };
      if (args.json) emitJson(result);
      else console.log(renderRubricAdminSuiteText({
        ...result,
        suite_id: suite?.id || null,
        summary: validation.summary || {},
        errors: validation.errors || [],
      }));
      return validation.ok ? 0 : 1;
    }

    const result = await runRubricAdminSuite({
      suite,
      modelIds: args.modelIds,
      attempt: args.attempt,
      maxBounces: args.maxBounces,
    });
    result.suite_path = path;
    if (args.json) emitJson(result);
    else console.log(renderRubricAdminSuiteText(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    const result = {
      schema_version: 1,
      return_type: "rubric_admin_suite",
      ok: false,
      status: "FAIL",
      errors: [
        {
          code: error?.code || "rubric_admin_runner_failed",
          path: "$",
          message: error?.message || String(error),
        },
      ],
    };
    if (args.json) emitJson(result);
    else console.error(`ERROR: ${result.errors[0].message}`);
    return 1;
  }
}

if (isDirectInvocation(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main, parseArgs };
