#!/usr/bin/env node
// nonce_reveal.mjs — Reveal and consume a one-time approval nonce.
//
// Reads the active plan's nonce file, requires interactive confirmation,
// displays the approval nonce and KB digest salt, then deletes the nonce file.
// The user must then manually add [APPROVED:<nonce>] to decisions.md.
//
// This is the manual alternative to the approval daemon.
//
// Usage:  node .agent/skills/iterative-planner/scripts/nonce_reveal.mjs
//
// Zero dependencies — Node.js 18+.

import { readdirSync, readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const NONCE_DIR = join(homedir(), ".config", "iterative-planner");
const NONCE_TTL_MS = 24 * 60 * 60 * 1000;

// RT-DAEMON-V3-008: Require real TTY on BOTH stdin and stdout.
// stdin.isTTY prevents the LLM from piping input; stdout.isTTY prevents output capture.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("ERROR: nonce_reveal.mjs must be run in a real terminal (stdin and stdout must be a TTY).");
  process.exit(1);
}

// Find the active plan name from plans/.current_plan
const plansDir = join(process.cwd(), "plans");
const pointerFile = join(plansDir, ".current_plan");
let planDirName = null;

if (existsSync(pointerFile)) {
  planDirName = readFileSync(pointerFile, "utf-8").trim();
}

if (!planDirName) {
  console.error("ERROR: No active plan found (plans/.current_plan missing or empty).");
  process.exit(1);
}

// Scan nonce directory for matching nonce
if (!existsSync(NONCE_DIR)) {
  console.error("ERROR: No nonce directory found. Run explore-to-plan transition first.");
  process.exit(1);
}

let foundPayload = null;
let foundNoncePath = null;

for (const f of readdirSync(NONCE_DIR)) {
  if (!f.startsWith(".nonce_")) continue;
  const noncePath = join(NONCE_DIR, f);
  try {
    const payload = JSON.parse(readFileSync(noncePath, "utf-8"));
    if (payload.plan !== planDirName) continue;

    // Check expiry
    if (payload.created_at) {
      const ageMs = Date.now() - new Date(payload.created_at).getTime();
      if (ageMs >= NONCE_TTL_MS) {
        try { unlinkSync(noncePath); } catch { /* best-effort */ }
        console.error(`  Expired nonce for "${planDirName}" deleted.`);
        continue;
      }
    }

    foundPayload = payload;
    foundNoncePath = noncePath;
    break;
  } catch { /* skip malformed */ }
}

if (!foundPayload) {
  console.error(`  No pending nonce found for plan "${planDirName}".`);
  console.error(`  Either the nonce was already consumed, or explore-to-plan hasn't run yet.`);
  process.exit(1);
}

// RT-DAEMON-V3-008: Require interactive confirmation before revealing the nonce.
// This prevents the LLM from running the script and capturing stdout.
console.log(`\n  Found pending nonce for plan: ${planDirName}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question("  Press Enter to reveal nonce (Ctrl+C to cancel): ", () => {
  rl.close();

  console.log();
  console.log(`  Plan: ${foundPayload.plan}`);
  console.log(`  Approval nonce: ${foundPayload.approval_nonce}`);
  if (foundPayload.kb_digest_salt) {
    console.log(`  KB digest salt:  ${foundPayload.kb_digest_salt}`);
  }
  console.log();
  console.log(`  Add to decisions.md:  [APPROVED:${foundPayload.approval_nonce}]`);
  if (foundPayload.kb_digest_salt) {
    console.log(`  Add to findings.md:   [KB_DIGEST:${foundPayload.kb_digest_salt}]`);
    console.log(`  Or set findings_ledger.json -> "kb_digest_salt": "${foundPayload.kb_digest_salt}"`);
  }
  console.log();

  // Delete nonce file (one-time-read)
  try { unlinkSync(foundNoncePath); } catch { /* best-effort */ }
  console.log(`  Nonce file consumed (deleted). This cannot be repeated.`);
});
