#!/usr/bin/env node
// delivery_receipt_assemble.mjs - CLI for E6-4 delivery receipt assembly.

import {
  assembleDeliveryReceiptFile,
  renderDeliveryReceiptText,
} from "./lib/delivery_receipt_assembler.mjs";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/delivery_receipt_assemble.mjs --input <fixture.json> [--output <receipt.json>] [--json] [--now <iso>]

Assembles an E6-4 delivery receipt from claims/evidence, rubric-admin verdicts, deterministic checks, escalation protocol review, residual risks, and cost ledgers. Exits 0 on a valid receipt and 1 on invalid input or provider failure.`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    inputPath: null,
    outputPath: null,
    json: false,
    help: false,
    now: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const valueFor = (name) => {
      if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), index };
      return { value: argv[index + 1] || null, index: index + 1 };
    };
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--input" || arg.startsWith("--input=")) {
      const next = valueFor("--input");
      parsed.inputPath = next.value;
      index = next.index;
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      const next = valueFor("--output");
      parsed.outputPath = next.value;
      index = next.index;
    } else if (arg === "--now" || arg.startsWith("--now=")) {
      const next = valueFor("--now");
      parsed.now = next.value;
      index = next.index;
    } else if (!parsed.inputPath) {
      parsed.inputPath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.inputPath) {
    console.log(usage());
    return args.help ? 0 : 1;
  }
  try {
    const result = await assembleDeliveryReceiptFile({
      inputPath: args.inputPath,
      outputPath: args.outputPath,
      now: args.now,
    });
    const payload = {
      ...result.receipt,
      input_path: result.input_path,
      output_path: result.output_path,
    };
    if (args.json) emitJson(payload);
    else console.log(renderDeliveryReceiptText(payload));
    return 0;
  } catch (error) {
    const result = {
      schema_version: 1,
      return_type: "delivery_receipt",
      ok: false,
      status: "FAIL",
      errors: [
        {
          code: error?.code || "delivery_receipt_assemble_failed",
          path: "$",
          message: error?.message || String(error),
        },
      ],
      validation: error?.validation || null,
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
