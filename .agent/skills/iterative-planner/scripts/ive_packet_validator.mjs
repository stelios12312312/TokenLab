#!/usr/bin/env node
// ive_packet_validator.mjs - CLI wrapper for deterministic IVE packet checks.

import { readFileSync } from "fs";
import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { validateIvePacket } from "./lib/ive_packet_contract.mjs";

function parseArgs(argv) {
  const parsed = {
    json: false,
    help: false,
    packetPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (!parsed.packetPath) parsed.packetPath = arg;
  }

  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/scripts/ive_packet_validator.mjs <packet.json> [--json]

Validates an IVE packet contract. Exits 0 on PASS and 1 on FAIL.`;
}

function loadPacket(packetPath) {
  const resolved = resolve(packetPath);
  const raw = readFileSync(resolved, "utf-8");
  return { packet: JSON.parse(raw), path: resolved };
}

function validatePacketFile(packetPath) {
  try {
    const { packet, path } = loadPacket(packetPath);
    return {
      ...validateIvePacket(packet),
      packet_path: path,
    };
  } catch (err) {
    return {
      ok: false,
      status: "FAIL",
      packet_path: packetPath ? resolve(packetPath) : null,
      errors: [
        {
          code: "packet_read_failed",
          path: "$",
          message: err?.message || String(err),
        },
      ],
      warnings: [],
    };
  }
}

function printText(result) {
  console.log(`IVE packet validator: ${result.status}`);
  if (result.packet_path) console.log(`  packet: ${result.packet_path}`);
  for (const error of result.errors || []) {
    console.log(`  FAIL ${error.code} at ${error.path}: ${error.message}`);
  }
  for (const warning of result.warnings || []) {
    console.log(`  WARN ${warning.code} at ${warning.path}: ${warning.message}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.packetPath) {
    console.log(usage());
    return args.help ? 0 : 1;
  }

  const result = validatePacketFile(args.packetPath);
  if (args.json) emitJson(result);
  else printText(result);
  return result.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export { main, parseArgs, validatePacketFile };
