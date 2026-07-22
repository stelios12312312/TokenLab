#!/usr/bin/env node
// check_profile.mjs - evaluate IVE runtime profiles for the current project.

import { resolve } from "path";

import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import { evaluateProjectProfiles } from "./lib/ive_profile_packs.mjs";

function parseArgs(argv = []) {
  const parsed = {
    cwd: process.cwd(),
    json: false,
    profiles: [],
    gate: null,
    useCache: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--cwd") parsed.cwd = resolve(argv[++index] || ".");
    else if (arg.startsWith("--cwd=")) parsed.cwd = resolve(arg.slice("--cwd=".length));
    else if (arg === "--profile") parsed.profiles.push(argv[++index]);
    else if (arg.startsWith("--profile=")) parsed.profiles.push(arg.slice("--profile=".length));
    else if (arg === "--gate") parsed.gate = argv[++index] || null;
    else if (arg.startsWith("--gate=")) parsed.gate = arg.slice("--gate=".length);
    else if (arg === "--no-cache") parsed.useCache = false;
  }
  parsed.profiles = parsed.profiles.filter(Boolean);
  return parsed;
}

function printText(report) {
  console.log(`IVE profile check: ${report.status}`);
  if (report.status_reason) console.log(`Reason: ${report.status_reason}`);
  console.log(`Profiles evaluated: ${report.profiles_evaluated || 0}`);
  console.log(`Cache hit: ${report.cache_hit ? "yes" : "no"}`);
  for (const profile of report.profile_results || []) {
    console.log(`- ${profile.profile_id}: ${profile.status} (${profile.check_count} checks)`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = evaluateProjectProfiles({
    cwd: args.cwd,
    profileIds: args.profiles.length > 0 ? args.profiles : null,
    gate: args.gate,
    useCache: args.useCache,
  });
  if (args.json) emitJson(report);
  else printText(report);
  return report.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
