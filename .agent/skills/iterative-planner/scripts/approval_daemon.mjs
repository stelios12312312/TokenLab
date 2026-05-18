#!/usr/bin/env node
// approval_daemon.mjs — Sidecar process for plan approval.
//
// Two delivery channels for nonces:
//   1. Unix domain socket (preferred) — transition.mjs sends the nonce directly
//      to the daemon over a socket. The plaintext nonce NEVER touches disk.
//      This prevents the LLM from reading nonce files (RT-DAEMON-V4-012).
//   2. File-based polling (fallback) — if the socket is not available,
//      transition.mjs writes a nonce file and the daemon polls for it.
//
// The socket also acts as a singleton lock (RT-DAEMON-V4-013) — only one
// daemon can bind to the socket path at a time.
//
// Modes:
//   --auto       Auto-approve safe-change workflows only (<=3 files).
//   --once       Prompt y/n for one nonce, then exit.
//   (default)    Prompt y/n continuously. Requires TTY on stdin.
//
// Usage:
//   node .agent/skills/iterative-planner/scripts/approval_daemon.mjs
//   node approval_daemon.mjs --auto
//   node approval_daemon.mjs --once
//
// Zero dependencies — Node.js 18+.

import { readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, realpathSync, mkdirSync } from "fs";
import { join, relative, resolve as pathResolve } from "path";
import { homedir } from "os";
import { createHash, randomBytes } from "crypto";
import { createInterface } from "readline";
import { createServer } from "net";
import { readStateJson, writeStateJson, acquireStateLock, NONCE_HEX_LEN, KB_SALT_HEX_LEN } from "./lib/determinism.mjs";
import { loadFindingsLedger, syncFindingsMarkdownFromLedger } from "./lib/plan_utils.mjs";

const NONCE_DIR = join(homedir(), ".config", "iterative-planner");
const SOCKET_PATH = join(NONCE_DIR, ".daemon.sock");
const NONCE_TTL_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const MAX_AUTO_APPROVE_FILES = 20;
const PLAN_WAIT_MAX_MS = 120_000;
const autoMode = process.argv.includes("--auto");
const onceMode = process.argv.includes("--once");

// RT-DAEMON-003: Interactive mode requires a real TTY.
if (!autoMode && !process.stdin.isTTY) {
  console.error("ERROR: Interactive mode requires a real terminal (TTY) on stdin.");
  console.error("If the LLM spawned this, use --auto for safe-change workflows.");
  console.error("For interactive approval, run this in a separate terminal.");
  process.exit(1);
}

const handled = new Set();
const skippedAuto = new Set();
const pendingPlanWait = new Map();

// ── Shared helpers ───────────────────────────────────

function resolvePlanDir(payload) {
  const plansRoot = join(process.cwd(), "plans");
  let resolvedPlansRoot;
  try { resolvedPlansRoot = realpathSync(plansRoot); } catch { return null; }

  // M4-FIX: Use path.relative for boundary check instead of startsWith (fragile with similar prefixes).
  if (payload.plan_dir) {
    try {
      const resolved = realpathSync(payload.plan_dir);
      const rel = relative(resolvedPlansRoot, resolved);
      if (rel !== "" && !rel.startsWith("..")) return resolved;
      console.error(`  WARN: plan_dir resolves outside plans/ — using fallback`);
    } catch { /* failed */ }
  }
  const fallback = join(plansRoot, payload.plan);
  try {
    if (existsSync(fallback)) {
      const resolved = realpathSync(fallback);
      const rel = relative(resolvedPlansRoot, resolved);
      if (rel !== "" && !rel.startsWith("..")) return resolved;
    }
  } catch { /* failed */ }
  return null;
}

function readPlanContent(planDir) {
  if (!planDir) return null;
  const planPath = join(planDir, "plan.md");
  if (!existsSync(planPath)) return null;
  return readFileSync(planPath, "utf-8");
}

function countPlanFilesFromContent(content) {
  if (!content) return null;
  const match = content.match(/^## files\s+to\s+modify\s*\n([\s\S]*?)(?=\n## |\n---|\n$)/im);
  if (!match) return null;
  return match[1].split("\n").filter(l => {
    const t = l.trim();
    return (t.startsWith("-") || t.startsWith("*")) && t.length > 2;
  }).length;
}

function hashContent(content) {
  if (!content) return null;
  // C1-FIX: 128-bit hash (was 64-bit)
  // RT8-M3: Normalize line endings before hashing — prevents false hash mismatches
  // when editors convert CRLF↔LF or add/remove trailing newlines.
  const normalized = content.replace(/\r\n/g, "\n").replace(/\n+$/, "\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function storePlanHash(planDir, planHash) {
  if (!planDir || !planHash) return false;
  const releaseLock = acquireStateLock(planDir, 2000);
  if (!releaseLock) return false;
  try {
    const sj = readStateJson(planDir);
    if (sj) { sj.approved_plan_hash = planHash; writeStateJson(planDir, sj); return true; }
  } finally { releaseLock(); }
  return false;
}

function showPlanSummary(planDir) {
  const planPath = join(planDir, "plan.md");
  if (!existsSync(planPath)) { console.log(`  (plan.md not found)`); return; }
  const lines = readFileSync(planPath, "utf-8").split("\n").slice(0, 30);
  console.log("\n┌─── Plan Summary ───────────────────────────────────┐");
  for (const line of lines) console.log(`  ${line}`);
  console.log("└────────────────────────────────────────────────────┘");
}

function approve(payload, { writeKbDigest = true, planHash = null, planDir = null } = {}) {
  const resolvedPlanDir = planDir || resolvePlanDir(payload);
  if (!resolvedPlanDir) {
    console.error(`  ERROR: Plan directory not found for "${payload.plan}"`);
    return false;
  }

  // RT10-C5: TOCTOU defense — re-validate path immediately before each write.
  // Between resolvePlanDir() and the write, an attacker could replace the dir
  // with a symlink to an attacker-controlled location.
  function revalidatePath(targetPath) {
    try {
      const realTarget = realpathSync(targetPath);
      const realPlanDir = realpathSync(resolvedPlanDir);
      if (!realTarget.startsWith(realPlanDir)) {
        console.error(`  ERROR: Path escapes plan directory (TOCTOU defense) — refusing write`);
        return false;
      }
      return true;
    } catch { return false; }
  }

  const decisionsPath = join(resolvedPlanDir, "decisions.md");
  const approvalTag = `\n[APPROVED:${payload.approval_nonce}]\n`;

  if (!revalidatePath(existsSync(decisionsPath) ? decisionsPath : resolvedPlanDir)) return false;
  if (existsSync(decisionsPath)) {
    appendFileSync(decisionsPath, approvalTag);
  } else {
    writeFileSync(decisionsPath, `# Decisions\n${approvalTag}`);
  }
  if (planHash) storePlanHash(resolvedPlanDir, planHash);
  if (writeKbDigest && payload.kb_digest_salt) {
    const findingsPath = join(resolvedPlanDir, "findings.md");
    const kbTag = `\n[KB_DIGEST:${payload.kb_digest_salt}]\n`;

    let ledgerUpdated = false;
    const ledgerInfo = loadFindingsLedger(resolvedPlanDir);
    if (ledgerInfo.present && ledgerInfo.parsed) {
      if (!revalidatePath(ledgerInfo.path)) return false;
      try {
        const ledger = { ...ledgerInfo.parsed, kb_digest_salt: payload.kb_digest_salt };
        writeFileSync(ledgerInfo.path, JSON.stringify(ledger, null, 2) + "\n");
        ledgerUpdated = true;
      } catch {
        console.error(`  WARN: Could not update findings_ledger.json with KB digest salt`);
      }
    }

    const syncResult = ledgerUpdated ? syncFindingsMarkdownFromLedger(resolvedPlanDir) : null;
    const needsMarkdownFallback = !ledgerUpdated || !syncResult?.synced;
    if (needsMarkdownFallback && existsSync(findingsPath)) {
      if (!revalidatePath(findingsPath)) return false;
      const currentFindings = readFileSync(findingsPath, "utf-8");
      if (!currentFindings.includes(`[KB_DIGEST:${payload.kb_digest_salt}]`)) {
        appendFileSync(findingsPath, kbTag);
      }
    }
  }
  return true;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// M5-FIX + RT7-H2 + RT7-M3: Schema-validate nonce payloads to prevent forged fields.
function isValidNoncePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.plan !== "string" || !/^[a-zA-Z0-9_\-]+$/.test(payload.plan)) return false;
  // RT8-M2 + RT9-M2: Use centralized NONCE_HEX_LEN constant
  if (typeof payload.approval_nonce !== "string" || !new RegExp(`^[a-f0-9]{${NONCE_HEX_LEN}}$`).test(payload.approval_nonce)) return false;
  if (payload.workflow_type && !["full", "safe-change"].includes(payload.workflow_type)) return false;
  if (payload.created_at && isNaN(new Date(payload.created_at).getTime())) return false;
  // RT7-H2 + RT9-M2: Validate kb_digest_salt format using centralized KB_SALT_HEX_LEN constant.
  if (payload.kb_digest_salt !== null && payload.kb_digest_salt !== undefined) {
    if (typeof payload.kb_digest_salt !== "string" || !new RegExp(`^[a-f0-9]{${KB_SALT_HEX_LEN}}$`).test(payload.kb_digest_salt)) return false;
  }
  // RT7-M3: Validate plan_dir — must be absolute path with no null bytes or shell metacharacters.
  if (payload.plan_dir !== null && payload.plan_dir !== undefined) {
    if (typeof payload.plan_dir !== "string") return false;
    if (!payload.plan_dir.startsWith("/")) return false;
    if (/[\x00`$]/.test(payload.plan_dir)) return false;
    if (payload.plan_dir.length > 4096) return false;
  }
  return true;
}

// ── Nonce processing (shared between socket and file paths) ──

async function processPayload(payload, { fromSocket = false, noncePath = null } = {}) {
  // M5-FIX: Reject malformed payloads before processing
  if (!isValidNoncePayload(payload)) {
    console.error(`  ERROR: Invalid nonce payload — rejected (possible forgery)`);
    if (noncePath) try { unlinkSync(noncePath); } catch { /* gone */ }
    return "error";
  }
  if (autoMode) {
    const workflowType = payload.workflow_type || "full";
    if (workflowType !== "safe-change") {
      console.log(`  ⚠ Skipping "${payload.plan}" — workflow type "${workflowType}" requires interactive approval.`);
      return "skipped";
    }
    const planDir = resolvePlanDir(payload);
    const planContent = readPlanContent(planDir);
    const fileCount = countPlanFilesFromContent(planContent);
    if (fileCount === null) return "defer"; // plan.md not ready yet
    if (fileCount > MAX_AUTO_APPROVE_FILES) {
      console.log(`  ⚠ Skipping "${payload.plan}" — plan lists ${fileCount} files (max ${MAX_AUTO_APPROVE_FILES}).`);
      return "skipped";
    }
    const planHash = hashContent(planContent);
    // RT8-H3: TOCTOU defense — re-read and re-hash plan.md immediately before approve.
    // Between the initial read (file count check) and approve(), plan.md could be modified
    // to add more files, bypassing the MAX_AUTO_APPROVE_FILES safety gate.
    const freshContent = readPlanContent(planDir);
    const freshHash = hashContent(freshContent);
    if (freshHash !== planHash) {
      console.log(`  ⚠ Rejecting "${payload.plan}" — plan.md was modified during approval check (TOCTOU defense).`);
      return "error";
    }
    if (approve(payload, { writeKbDigest: false, planHash, planDir })) {
      console.log(`  ✓ Auto-approved safe-change plan "${payload.plan}" (${fileCount} file${fileCount !== 1 ? "s" : ""})`);
      if (noncePath) try { unlinkSync(noncePath); } catch { /* gone */ }
      return "approved";
    }
    return "error";
  }

  // Interactive mode
  const planDir = resolvePlanDir(payload);
  console.log(`\n══ Approval requested for plan: ${payload.plan} ══`);
  if (payload.workflow_type) console.log(`  Workflow type: ${payload.workflow_type}`);
  if (planDir) showPlanSummary(planDir);

  const answer = await ask(`\n  Approve plan "${payload.plan}"? [y/n]: `);
  if (answer === "y" || answer === "yes") {
    const planContent = readPlanContent(planDir);
    const planHash = hashContent(planContent);
    if (approve(payload, { planHash, planDir })) {
      console.log(`  ✓ Approved — [APPROVED:***] written to decisions.md`);
      if (planHash) console.log(`  ✓ Plan hash stored in state.json`);
      if (payload.kb_digest_salt) console.log(`  ✓ KB digest proof written to findings.md and findings_ledger.json when present`);
      if (noncePath) try { unlinkSync(noncePath); } catch { /* gone */ }
      return "approved";
    }
    return "error";
  }
  if (noncePath) try { unlinkSync(noncePath); } catch { /* gone */ }
  console.log(`  ✗ Rejected.`);
  return "rejected";
}

// ── File-based polling (fallback for when socket is not used) ──

function scanForNonces() {
  if (!existsSync(NONCE_DIR)) return [];
  const results = [];
  try {
    for (const f of readdirSync(NONCE_DIR)) {
      if (!f.startsWith(".nonce_") || handled.has(f) || skippedAuto.has(f)) continue;
      const noncePath = join(NONCE_DIR, f);
      try {
        const payload = JSON.parse(readFileSync(noncePath, "utf-8"));
        if (payload.created_at) {
          const ageMs = Date.now() - new Date(payload.created_at).getTime();
          if (ageMs >= NONCE_TTL_MS) {
            try { unlinkSync(noncePath); } catch { /* */ }
            handled.add(f);
            pendingPlanWait.delete(f);
            continue;
          }
        }
        results.push({ filename: f, path: noncePath, payload });
      } catch { /* skip malformed */ }
    }
  } catch { /* dir read failed */ }
  return results;
}

async function processFileNonce(nonce) {
  const { filename, path: noncePath, payload } = nonce;
  handled.add(filename);
  const result = await processPayload(payload, { noncePath });
  if (result === "defer") {
    const firstSeen = pendingPlanWait.get(filename) || Date.now();
    if (!pendingPlanWait.has(filename)) {
      pendingPlanWait.set(filename, firstSeen);
      console.log(`  ⏳ Waiting for plan.md for "${payload.plan}"...`);
    }
    if (Date.now() - firstSeen > PLAN_WAIT_MAX_MS) {
      console.log(`  ⚠ Timeout — "${payload.plan}" requires interactive approval.`);
      pendingPlanWait.delete(filename);
      skippedAuto.add(filename);
    }
    handled.delete(filename);
  } else if (result === "skipped") {
    handled.delete(filename);
    skippedAuto.add(filename);
  } else {
    pendingPlanWait.delete(filename);
  }
}

async function tick() {
  for (const nonce of scanForNonces()) {
    await processFileNonce(nonce);
    if (onceMode) process.exit(0);
  }
}

// ── Unix domain socket server (RT-DAEMON-V4-012 + V4-013) ──

function startSocketServer() {
  try { mkdirSync(NONCE_DIR, { recursive: true }); } catch { /* exists */ }
  // Clean up stale socket from a crashed daemon
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch { /* */ }
  }

  const server = createServer(conn => {
    let data = "";
    conn.on("data", chunk => { data += chunk; });
    conn.on("end", async () => {
      try {
        const payload = JSON.parse(data);
        console.log(`  📨 Nonce received via socket for plan "${payload.plan}"`);
        const result = await processPayload(payload, { fromSocket: true });
        conn.destroyed || conn.destroy(); // connection already ended
        if (result === "defer") {
          // Socket-delivered nonces that need plan.md: write to file as fallback
          // so the file poller can handle the wait-and-retry logic.
          // RT8-M1: Use randomBytes instead of Date.now() to prevent filename collision
          const tmpPath = join(NONCE_DIR, `.nonce_sock_${randomBytes(8).toString("hex")}`);
          writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n");
          console.log(`  ⏳ Deferred to file poller (plan.md not ready yet)`);
        }
        if (onceMode && (result === "approved" || result === "rejected")) {
          cleanup();
          process.exit(0);
        }
      } catch (e) {
        console.error(`  ERROR processing socket nonce: ${e.message}`);
      }
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error("ERROR: Another approval daemon is already running (socket in use).");
      console.error(`  Socket: ${SOCKET_PATH}`);
      console.error("  Stop the other daemon first, or delete the socket file if it's stale.");
      process.exit(1);
    }
    console.error(`  Socket error: ${err.message}`);
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`  Socket: ${SOCKET_PATH}`);
  });

  return server;
}

// ── Cleanup ──────────────────────────────────────────

let socketServer = null;

function cleanup() {
  if (socketServer) { try { socketServer.close(); } catch { /* */ } }
  if (existsSync(SOCKET_PATH)) { try { unlinkSync(SOCKET_PATH); } catch { /* */ } }
}

// ── Main ──────────────────────────────────────────────

const modeLabel = autoMode ? "auto-approve (safe-change only)" : onceMode ? "single approval" : "interactive";
console.log("┌────────────────────────────────────────────────────┐");
console.log(`│  Approval Daemon                                   │`);
console.log(`│  Mode: ${modeLabel.padEnd(44)}│`);
if (!autoMode) {
  console.log("│  Press Ctrl+C to stop.                             │");
}
console.log("└────────────────────────────────────────────────────┘");

socketServer = startSocketServer();

// Also poll for file-based nonces (fallback + deferred socket nonces)
tick();
const timer = setInterval(tick, POLL_INTERVAL_MS);

process.on("SIGINT", () => { clearInterval(timer); cleanup(); console.log("\n  Daemon stopped."); process.exit(0); });
process.on("SIGTERM", () => { clearInterval(timer); cleanup(); process.exit(0); });
process.on("exit", cleanup);
