#!/usr/bin/env node
// knowledge_packs.mjs - load IVE reference knowledge packs.

import { resolve } from "path";

import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { loadKnowledgePacks } from "./lib/ive_profile_packs.mjs";

function parseArgs(argv = []) {
  const parsed = {
    cwd: process.cwd(),
    json: false,
    packs: [],
    disabled: [],
    accepted: [],
    allowCommunity: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--cwd") parsed.cwd = resolve(argv[++index] || ".");
    else if (arg.startsWith("--cwd=")) parsed.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg === "--pack") parsed.packs.push(argv[++index]);
    else if (arg.startsWith("--pack=")) parsed.packs.push(arg.slice("--pack=".length));
    else if (arg === "--disable") parsed.disabled.push(argv[++index]);
    else if (arg.startsWith("--disable=")) parsed.disabled.push(arg.slice("--disable=".length));
    else if (arg === "--accept") parsed.accepted.push(argv[++index]);
    else if (arg.startsWith("--accept=")) parsed.accepted.push(arg.slice("--accept=".length));
    else if (arg === "--allow-community") parsed.allowCommunity = true;
  }
  parsed.packs = parsed.packs.filter(Boolean);
  parsed.disabled = parsed.disabled.filter(Boolean);
  parsed.accepted = parsed.accepted.filter(Boolean);
  return parsed;
}

function printText(report) {
  console.log(`IVE knowledge packs: ${report.status}`);
  console.log(`Loaded packs: ${report.loaded_pack_count || 0}/${report.selected_pack_count || 0}`);
  if (report.obligation_count) {
    console.log(`Active obligations: ${report.active_obligation_count || 0}/${report.obligation_count}`);
  }
  for (const pack of report.pack_results || []) {
    const parts = [];
    if (pack.entry_count !== undefined) parts.push(`${pack.entry_count} entries`);
    if (pack.obligation_count !== undefined) parts.push(`${pack.active_obligation_count || 0}/${pack.obligation_count} active obligations`);
    const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    console.log(`- ${pack.pack_id}: ${pack.status}${suffix}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = loadKnowledgePacks({
    cwd: args.cwd,
    packIds: args.packs.length > 0 ? args.packs : null,
    disabledPacks: args.disabled,
    acceptedPacks: args.accepted,
    allowCommunity: args.allowCommunity,
  });
  if (args.json) emitJson(report);
  else printText(report);
  return report.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
