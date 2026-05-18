#!/usr/bin/env node
// verification_runner.mjs — Execute verification_matrix rows that opt in to
// automatic execution.
//
// Phase 3 of ritual elimination: a row whose `command_or_action` is meant as a
// real proof should actually run, not be stored as a claim. This runner spawns
// rows tagged executor=auto, captures exit code + truncated stdout, and writes
// the result back to the Program Packet so gates can distinguish a manual claim
// from an executed proof.
//
// Three safety locks (so we don't add ritual to remove ritual):
//   1. Default executor is 'manual' (today's behavior is unchanged).
//   2. Per-row opt-in via "executor": "auto".
//   3. Global env lock: PLANNER_VERIFICATION_EXECUTE=1 must be set.
//
// Usage:
//   node verification_runner.mjs run [--program <path-or-id>] [--row <id>] [--json] [--write]
//   node verification_runner.mjs run --dry-run [--program <path-or-id>] [--json]
//
// --dry-run lists rows that would execute (regardless of env lock).
// Without --write, the runner prints results without modifying the packet.
// With --write, the runner updates the packet's verification_matrix entries.

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import {
  loadProgramPacket,
  resolveProgramPacketPath,
} from "./lib/program_packet.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STDOUT_EXCERPT_LIMIT = 4000;
const DEFAULT_TIMEOUT_SECONDS = 60;

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    command: args.shift() || "help",
    program: null,
    row: null,
    json: false,
    write: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--write") parsed.write = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--program") parsed.program = args[++i] || null;
    else if (arg === "--row") parsed.row = args[++i] || null;
    else if (!parsed.program) parsed.program = arg;
  }
  return parsed;
}

function usage() {
  return `verification_runner.mjs — Execute opt-in verification_matrix rows

Usage:
  node verification_runner.mjs run [--program <path-or-id>] [--row <id>] [--json] [--write]
  node verification_runner.mjs run --dry-run [--program <path-or-id>] [--json]

Safety locks:
  1. Default executor is 'manual' — only rows with executor='auto' are eligible.
  2. PLANNER_VERIFICATION_EXECUTE=1 must be set in the environment, otherwise the
     runner refuses to spawn any command. --dry-run bypasses the env check.
  3. Per-row timeout (default ${DEFAULT_TIMEOUT_SECONDS}s) prevents hanging commands.

Without --write, results are printed but the Program Packet is unchanged.`;
}

function lockSatisfied() {
  return String(process.env.PLANNER_VERIFICATION_EXECUTE || "").trim() === "1";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function selectAutoRows(packet, rowFilter) {
  return asArray(packet?.verification_matrix).filter((row) => {
    if (!row || typeof row !== "object") return false;
    if (String(row.executor || "manual").toLowerCase() !== "auto") return false;
    if (!String(row.command_or_action || "").trim()) return false;
    if (rowFilter && String(row.id || "") !== String(rowFilter)) return false;
    return true;
  });
}

function executeRow(row, cwd) {
  const command = String(row.command_or_action || "").trim();
  const timeoutSeconds = Number(row.timeout_seconds || DEFAULT_TIMEOUT_SECONDS);
  const startedAt = new Date().toISOString();
  const proc = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    encoding: "utf-8",
    timeout: Math.max(1, timeoutSeconds) * 1000,
  });
  const stdout = String(proc.stdout || "");
  const stderr = String(proc.stderr || "");
  const exitCode = proc.status === null ? -1 : proc.status;
  const timedOut = proc.signal === "SIGTERM" || (proc.error && proc.error.code === "ETIMEDOUT");
  const result = exitCode === 0 ? "PASS" : timedOut ? "TIMEOUT" : "FAIL";
  const excerpt = (stdout || stderr).slice(0, STDOUT_EXCERPT_LIMIT);
  return {
    row_id: row.id,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    command,
    exit_code: exitCode,
    timed_out: timedOut,
    result,
    stdout_excerpt: excerpt,
  };
}

function applyResultsToPacket(packet, executions) {
  const byId = new Map(executions.map((execution) => [String(execution.row_id), execution]));
  const updated = JSON.parse(JSON.stringify(packet));
  for (const row of asArray(updated.verification_matrix)) {
    const execution = byId.get(String(row.id));
    if (!execution) continue;
    row.result = execution.result;
    row.result_source = "executed";
    row.executed_at = execution.finished_at;
    row.exit_code = execution.exit_code;
    row.stdout_excerpt = execution.stdout_excerpt;
  }
  return updated;
}

function loadTarget(cwd, programArg) {
  const resolved = resolveProgramPacketPath({ cwd, program: programArg });
  if (resolved.status !== "FOUND") return { resolved };
  if (!existsSync(resolved.path)) {
    return { resolved: { status: "MISSING", path: resolved.path, message: `Program Packet not found: ${resolved.path}` } };
  }
  try {
    return { resolved, ...loadProgramPacket(resolved.path) };
  } catch (error) {
    return { resolved, loadError: { code: "program_packet_load_error", message: error.message, path: resolved.path } };
  }
}

function renderText(result) {
  const lines = [];
  lines.push(`Verification Runner: ${result.command}${result.dryRun ? " (dry-run)" : ""}`);
  lines.push(`Status: ${result.status}`);
  if (result.packet_path) lines.push(`Packet: ${result.packet_path}`);
  if (result.message) lines.push(result.message);
  lines.push(`Eligible rows: ${result.eligible_count}`);
  lines.push(`Executed: ${result.executed_count}`);
  for (const execution of result.executions) {
    lines.push(`- ${execution.row_id} → ${execution.result} (exit=${execution.exit_code}${execution.timed_out ? ", TIMED OUT" : ""})`);
    if (execution.stdout_excerpt) {
      lines.push(`  stdout: ${execution.stdout_excerpt.split("\n").slice(0, 3).join(" / ")}`);
    }
  }
  if (result.write_status) lines.push(result.write_status);
  if (result.locks_status) lines.push(result.locks_status);
  return lines.join("\n");
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(args.command)) {
    console.log(usage());
    return 0;
  }
  if (args.command !== "run") {
    console.error(`Unknown command: ${args.command}\n\n${usage()}`);
    return 2;
  }

  const target = loadTarget(cwd, args.program);
  if (target.resolved.status === "SKIP") {
    const result = {
      command: args.command,
      status: "SKIP",
      packet_path: null,
      eligible_count: 0,
      executed_count: 0,
      executions: [],
      message: target.resolved.message,
      dryRun: args.dryRun,
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 0;
  }
  if (target.resolved.status !== "FOUND" || target.loadError) {
    const error = target.loadError || {
      code: `program_packet_${target.resolved.status.toLowerCase()}`,
      message: target.resolved.message,
      path: target.resolved.path || "plans/programs",
    };
    const result = {
      command: args.command,
      status: "FAIL",
      packet_path: target.resolved.path || null,
      eligible_count: 0,
      executed_count: 0,
      executions: [],
      message: error.message,
      dryRun: args.dryRun,
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 1;
  }

  const eligibleRows = selectAutoRows(target.packet, args.row);
  const result = {
    command: args.command,
    status: "PASS",
    packet_path: target.resolved.path,
    eligible_count: eligibleRows.length,
    executed_count: 0,
    executions: [],
    dryRun: args.dryRun,
    locks_status: null,
    write_status: null,
    message: null,
  };

  if (eligibleRows.length === 0) {
    result.message = "No verification rows opted into automatic execution (executor='auto' required).";
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 0;
  }

  if (args.dryRun) {
    result.executions = eligibleRows.map((row) => ({
      row_id: row.id,
      result: "DRY_RUN",
      exit_code: null,
      timed_out: false,
      stdout_excerpt: `would run: ${String(row.command_or_action || "").trim()}`,
    }));
    result.message = `Dry-run only: ${eligibleRows.length} row(s) would execute.`;
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 0;
  }

  if (!lockSatisfied()) {
    result.status = "BLOCKED";
    result.locks_status = "PLANNER_VERIFICATION_EXECUTE=1 required to run commands. Set the env var explicitly to authorize execution. Use --dry-run to preview without authorization.";
    console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 1;
  }

  for (const row of eligibleRows) {
    result.executions.push(executeRow(row, cwd));
  }
  result.executed_count = result.executions.length;
  const anyFail = result.executions.some((execution) => execution.result !== "PASS");
  result.status = anyFail ? "FAIL" : "PASS";

  if (args.write) {
    const updated = applyResultsToPacket(target.packet, result.executions);
    writeFileSync(target.resolved.path, JSON.stringify(updated, null, 2) + "\n", "utf-8");
    result.write_status = `Updated ${target.resolved.path} — ${result.executed_count} row(s) annotated with result_source='executed'.`;
  } else {
    result.write_status = "Read-only run. Pass --write to persist results back to the Program Packet.";
  }

  console.log(args.json ? JSON.stringify(result, null, 2) : renderText(result));
  return result.status === "PASS" ? 0 : 1;
}

if (process.argv[1] === __filename) {
  process.exitCode = main();
}

export { main };
