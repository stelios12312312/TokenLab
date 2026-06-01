#!/usr/bin/env node
// @planner:story_id US-087
// @planner:proves = crit:CRIT-003

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillDir = resolve(scriptDir, "..");
const recoveryPath = join(skillDir, "ERROR-RECOVERY.md");
const failureCodesPath = join(skillDir, "config", "failure-codes.json");

function usage() {
  console.log(`Usage: planner explain <error-code>
       planner explain --list`);
}

function parseEntries(markdown) {
  const entries = new Map();
  const headingPattern = /^(#{2,3})\s+([^:\n`]+|`[^`]+`)(?::[^\n]*)?$/gm;
  const matches = [...markdown.matchAll(headingPattern)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const rawHeading = String(match[2] || "").replace(/`/g, "").trim();
    const codeMatch = rawHeading.match(/\bGATE-[A-Z]+-\d+\b|\bAV-\d+\b|\bRT\d+-[A-Z0-9-]+\b/);
    if (!codeMatch) continue;
    const code = codeMatch[0];
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    const body = markdown.slice(start, end).trim();
    const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
    const isFixLine = (line) => /^[-*]\s*(\*\*)?(Fix|Run|Action|Re-run|Retry|Use|Start|Check)\b/i.test(line)
      || /^(\*\*)?(Fix|Run|Action|Re-run|Retry|Use|Start|Check)\b/i.test(line);
    const cause = lines.find((line) => !line.startsWith("#") && !line.startsWith("```") && !line.startsWith("-") && !isFixLine(line)) || "N/A - not recorded";
    const fixes = lines
      .filter(isFixLine)
      .map((line) => line
        .replace(/^[-*]\s*/, "")
        .replace(/^\*\*(Fix|Run|Action|Re-run|Retry|Use|Start|Check):\*\*\s*/i, "")
        .replace(/^\*(Fix|Run|Action|Re-run|Retry|Use|Start|Check):\*\*\s*/i, "")
        .replace(/^(Fix|Run|Action|Re-run|Retry|Use|Start|Check):\s*/i, ""));
    entries.set(code.toUpperCase(), { code, heading: rawHeading, cause, fixes, body });
  }
  return entries;
}

function safeJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function gatePhase(gate) {
  return String(gate || "")
    .split("-to-")
    .map((part) => part.toUpperCase())
    .join(" -> ") || "N/A - not recorded";
}

function fallbackFix(code, metadata) {
  const check = String(metadata?.check || "");
  if (code === "GATE-ETR-011" || check === "evidence_verification") {
    return "Run the evidence commands declared in verification_strategy.yaml, record passing evidence in verification.md or reports/test_runs, then re-run execute-to-reflect.";
  }
  if (check.includes("test_drift")) {
    return "Add a Test Drift Scan section to verification.md, then re-run the gate.";
  }
  if (metadata?.remediation) {
    return metadata.remediation;
  }
  if (metadata?.gate) {
    return `Fix the ${check || "reported"} condition, then re-run transition.mjs ${metadata.gate}.`;
  }
  return "Check ERROR-RECOVERY.md and failure-codes.json for the closest matching recovery path.";
}

function mergeFailureCodeEntries(entries) {
  const registry = safeJson(failureCodesPath);
  const codes = registry?.codes && typeof registry.codes === "object" ? registry.codes : {};
  for (const [code, metadata] of Object.entries(codes)) {
    const normalized = code.toUpperCase();
    if (entries.has(normalized)) {
      entries.set(normalized, { ...entries.get(normalized), metadata });
      continue;
    }
    entries.set(normalized, {
      code,
      heading: `${code}: ${metadata.message || metadata.description || metadata.check || "Registered failure code"}`,
      cause: metadata.message || metadata.description || "N/A - not recorded",
      fixes: [fallbackFix(code, metadata)],
      body: "",
      metadata,
    });
  }
  return entries;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return 0;
  }
  if (!existsSync(recoveryPath)) {
    console.error(`ERROR: ERROR-RECOVERY.md not found at ${recoveryPath}`);
    return 1;
  }
  const entries = mergeFailureCodeEntries(parseEntries(readFileSync(recoveryPath, "utf-8")));
  if (args.includes("--list")) {
    console.log("Known Error Codes");
    for (const code of [...entries.keys()].sort()) console.log(`- ${code}`);
    return 0;
  }
  const code = String(args[0] || "").trim().toUpperCase();
  if (!code) {
    usage();
    return 2;
  }
  const entry = entries.get(code);
  if (!entry) {
    console.log(`Unknown error code: ${code}`);
    console.log("Known codes:");
    for (const known of [...entries.keys()].sort().slice(0, 10)) console.log(`- ${known}`);
    return 1;
  }
  console.log(`Error: ${entry.code}`);
  console.log(`Phase: ${gatePhase(entry.metadata?.gate)}`);
  console.log(`Check: ${entry.metadata?.check || "N/A - not recorded"}`);
  console.log();
  console.log(`Cause: ${entry.cause.replace(/^\*\*Cause:\*\*\s*/i, "")}`);
  console.log("Fix:");
  if (entry.fixes.length === 0) {
    console.log("- N/A - not recorded");
  } else {
    for (const fix of entry.fixes) console.log(`- ${fix}`);
  }
  return 0;
}

process.exitCode = main();
