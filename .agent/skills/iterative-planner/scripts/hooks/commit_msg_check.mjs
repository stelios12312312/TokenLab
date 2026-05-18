#!/usr/bin/env node
// commit_msg_check.mjs — deterministic commit body guard for planner commits.

import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

const messagePath = process.argv[2];

function usage() {
  console.error("Usage: node commit_msg_check.mjs <commit-msg-file>");
}

function projectRoot() {
  return process.env.ITERATIVE_PLANNER_PROJECT_ROOT || process.cwd();
}

function logBypass(reason) {
  const logPath = join(projectRoot(), "reports", "errors", "commit_msg_escapes.log");
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${new Date().toISOString()}\t${reason}\n`);
}

function isGuardedSubject(subject) {
  return [
    /^Close Phase\b/i,
    /^Phase\s+\d+\b/i,
    /^feat(?:\([^)]+\))?!?:/i,
    /^fix(?:\([^)]+\))?!?:/i,
    /^chore(?:\([^)]+\))?!?:/i,
  ].some((pattern) => pattern.test(subject));
}

function missingHeadings(body) {
  return ["Why:", "What:", "Proof:"].filter((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`^${escaped}(?:\\s|$)`, "m").test(body);
  });
}

if (!messagePath) {
  usage();
  process.exit(1);
}

let message = "";
try {
  message = readFileSync(messagePath, "utf-8");
} catch (error) {
  console.error(`ERROR: could not read commit message: ${error.message}`);
  process.exit(1);
}

const normalized = message.replace(/\r\n/g, "\n");
const subject = normalized.split("\n")[0].trim();
if (!subject || !isGuardedSubject(subject)) {
  process.exit(0);
}

const body = normalized.split("\n").slice(1).join("\n").trim();
const missing = missingHeadings(body);
if (body && missing.length === 0) {
  process.exit(0);
}

if (process.env.PLANNER_ALLOW_EMPTY_BODY === "1") {
  logBypass(`guarded_subject=${subject}; missing=${missing.length > 0 ? missing.join(",") : "body"}`);
  process.exit(0);
}

console.error("ERROR: guarded planner commit message is missing required body headings.");
console.error(`Subject: ${subject}`);
console.error("Required headings: Why:, What:, Proof:");
if (missing.length > 0) console.error(`Missing: ${missing.join(", ")}`);
console.error("Emergency bypass: PLANNER_ALLOW_EMPTY_BODY=1 git commit ...");
process.exit(1);
