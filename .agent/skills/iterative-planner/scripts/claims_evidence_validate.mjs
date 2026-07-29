#!/usr/bin/env node
// claims_evidence_validate.mjs - CLI wrapper for deterministic claims/evidence checks.

import { readFileSync } from "fs";
import { resolve } from "path";
import {
  decideClaimsEvidenceBounce,
  projectClaimsEvidenceReceipt,
  validateClaimsEvidence,
} from "./lib/claims_evidence_contract.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function parseIntegerFlag(argv, index) {
  const value = argv[index + 1];
  if (value === undefined) return { value: null, consumed: 0 };
  const parsed = Number(value);
  return Number.isInteger(parsed) ? { value: parsed, consumed: 1 } : { value: null, consumed: 1 };
}

function parseArgs(argv) {
  const parsed = {
    json: false,
    help: false,
    claimsEvidencePath: null,
    attempt: null,
    max_bounces: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--attempt") {
      const result = parseIntegerFlag(argv, index);
      parsed.attempt = result.value;
      index += result.consumed;
    } else if (arg === "--max-bounces") {
      const result = parseIntegerFlag(argv, index);
      parsed.max_bounces = result.value;
      index += result.consumed;
    } else if (!parsed.claimsEvidencePath) parsed.claimsEvidencePath = arg;
  }

  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/claims_evidence_validate.mjs <claims-evidence.json> [--json] [--attempt N] [--max-bounces N]

Validates an Iterative Planner claims/evidence return. Exits 0 on PASS, 1 on bounceable FAIL, and 2 on escalation-required FAIL.`;
}

function loadClaimsEvidence(claimsEvidencePath) {
  const resolved = resolve(claimsEvidencePath);
  const raw = readFileSync(resolved, "utf-8");
  return { payload: JSON.parse(raw), path: resolved };
}

function bounceOptionsFromArgs(args) {
  const options = {};
  if (Number.isInteger(args.attempt)) options.attempt = args.attempt;
  if (Number.isInteger(args.max_bounces)) options.max_bounces = args.max_bounces;
  return options;
}

function validateClaimsEvidenceFile(claimsEvidencePath, options = {}) {
  try {
    const { payload, path } = loadClaimsEvidence(claimsEvidencePath);
    const validation = validateClaimsEvidence(payload);
    const bounce_decision = decideClaimsEvidenceBounce(validation, options);
    return {
      ...validation,
      claims_evidence_path: path,
      bounce_decision,
      receipt: validation.ok ? projectClaimsEvidenceReceipt(payload) : null,
    };
  } catch (err) {
    const validation = {
      ok: false,
      status: "FAIL",
      claims_evidence_path: claimsEvidencePath ? resolve(claimsEvidencePath) : null,
      errors: [
        {
          code: "claims_evidence_read_failed",
          path: "$",
          message: err?.message || String(err),
        },
      ],
      warnings: [],
      bounce: {
        attempt: Number.isInteger(options.attempt) ? options.attempt : 0,
        max_bounces: Number.isInteger(options.max_bounces) ? options.max_bounces : 2,
      },
    };
    return {
      ...validation,
      bounce_decision: decideClaimsEvidenceBounce(validation, options),
      receipt: null,
    };
  }
}

function printText(result) {
  console.log(`Claims/evidence validator: ${result.status}`);
  if (result.claims_evidence_path) console.log(`  claims_evidence: ${result.claims_evidence_path}`);
  if (result.bounce_decision) console.log(`  next_action: ${result.bounce_decision.next_action}`);
  for (const error of result.errors || []) {
    console.log(`  FAIL ${error.code} at ${error.path}: ${error.message}`);
  }
  for (const warning of result.warnings || []) {
    console.log(`  WARN ${warning.code} at ${warning.path}: ${warning.message}`);
  }
}

function exitCodeFor(result) {
  if (result.ok) return 0;
  return result.bounce_decision?.action === "escalate" ? 2 : 1;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.claimsEvidencePath) {
    console.log(usage());
    return args.help ? 0 : 1;
  }

  const result = validateClaimsEvidenceFile(args.claimsEvidencePath, bounceOptionsFromArgs(args));
  if (args.json) emitJson(result);
  else printText(result);
  return exitCodeFor(result);
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { main, parseArgs, validateClaimsEvidenceFile };
