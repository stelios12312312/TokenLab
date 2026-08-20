#!/usr/bin/env node
// Public production Program-ticket autonomous delivery CLI.
// @planner:module = autonomous_ticket_delivery_cli
// @planner:capability = production_program_ticket_delivery_cli
// @planner:proves = crit:sc_2, crit:sc_3, crit:sc_5

import { resolve } from "path";
import { emitJson } from "./lib/emit_json.mjs";
import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  DEFAULT_AUTONOMOUS_TICKET_MAX_CHANGED_FILES,
  DEFAULT_AUTONOMOUS_TICKET_MAX_DIFF_LINES,
  DEFAULT_AUTONOMOUS_TICKET_MAX_TOTAL_TOKENS,
  DEFAULT_AUTONOMOUS_TICKET_RECEIPT_ROOT,
  DEFAULT_AUTONOMOUS_TICKET_TIMEOUT_MS,
  runAutonomousTicketDelivery,
} from "./lib/autonomous_ticket_delivery.mjs";

function usage() {
  return `autonomous_ticket_delivery.mjs — one bounded production Program-ticket delivery

Usage:
  node .agent/skills/iterative-planner/scripts/autonomous_ticket_delivery.mjs run \\
    --program <program_packet.json> --ticket <ticket-id> \\
    --agent-cmd "codex exec --json -" [options]

Options:
  --verification-cmd <command>   Parent verification command (default: Program check)
  --receipt-root <path>          Default: ${DEFAULT_AUTONOMOUS_TICKET_RECEIPT_ROOT}
  --workspace-parent <path>      Parent directory for the temporary Git worktree
  --branch <name>                Explicit candidate branch name
  --timeout-ms <n>               Default: ${DEFAULT_AUTONOMOUS_TICKET_TIMEOUT_MS}
  --max-total-tokens <n>         Post-run acceptance ceiling; default: ${DEFAULT_AUTONOMOUS_TICKET_MAX_TOTAL_TOKENS}
  --max-changed-files <n>        Default: ${DEFAULT_AUTONOMOUS_TICKET_MAX_CHANGED_FILES}
  --max-diff-lines <n>           Default: ${DEFAULT_AUTONOMOUS_TICKET_MAX_DIFF_LINES}
  --allow-path <path>            Repeatable; narrows the default write boundary
  --halt-file <path>             Skip without invoking the agent when present
  --keep-workspace               Retain the worktree for diagnosis
  --json                         Emit one complete JSON document

The runner first proves local lifecycle and remote-mirror prerequisites. A
blocked preflight creates no worktree and invokes no agent. When admitted, the
runner invokes the configured agent exactly once. --max-total-tokens is checked
from the completed agent JSONL; it is not a provider-side hard spend cap. The
runner never merges, pushes, deletes branches, or mutates GitHub. PASS is
recomputed by the parent harness.`;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positive(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

export function parseAutonomousTicketDeliveryArgs(argv = []) {
  const help = ["--help", "-h", "help"].includes(argv[0]);
  const options = {
    command: help ? "" : (argv[0] || ""),
    programPath: null,
    ticketId: null,
    agentCommand: null,
    verificationCommand: null,
    receiptRoot: DEFAULT_AUTONOMOUS_TICKET_RECEIPT_ROOT,
    workspaceParent: null,
    branchName: null,
    timeoutMs: DEFAULT_AUTONOMOUS_TICKET_TIMEOUT_MS,
    maxTotalTokens: DEFAULT_AUTONOMOUS_TICKET_MAX_TOTAL_TOKENS,
    maxChangedFiles: DEFAULT_AUTONOMOUS_TICKET_MAX_CHANGED_FILES,
    maxDiffLines: DEFAULT_AUTONOMOUS_TICKET_MAX_DIFF_LINES,
    allowPaths: [],
    haltFile: null,
    keepWorkspace: false,
    json: false,
    help,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--program") options.programPath = requireValue(argv, index++, arg);
    else if (arg.startsWith("--program=")) options.programPath = arg.slice(10);
    else if (arg === "--ticket") options.ticketId = requireValue(argv, index++, arg);
    else if (arg.startsWith("--ticket=")) options.ticketId = arg.slice(9);
    else if (arg === "--agent-cmd") options.agentCommand = requireValue(argv, index++, arg);
    else if (arg.startsWith("--agent-cmd=")) options.agentCommand = arg.slice(12);
    else if (arg === "--verification-cmd") options.verificationCommand = requireValue(argv, index++, arg);
    else if (arg.startsWith("--verification-cmd=")) options.verificationCommand = arg.slice(19);
    else if (arg === "--receipt-root") options.receiptRoot = requireValue(argv, index++, arg);
    else if (arg.startsWith("--receipt-root=")) options.receiptRoot = arg.slice(15);
    else if (arg === "--workspace-parent") options.workspaceParent = requireValue(argv, index++, arg);
    else if (arg.startsWith("--workspace-parent=")) options.workspaceParent = arg.slice(19);
    else if (arg === "--branch") options.branchName = requireValue(argv, index++, arg);
    else if (arg.startsWith("--branch=")) options.branchName = arg.slice(9);
    else if (arg === "--timeout-ms") options.timeoutMs = positive(requireValue(argv, index++, arg), arg);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = positive(arg.slice(13), "--timeout-ms");
    else if (arg === "--max-total-tokens") options.maxTotalTokens = positive(requireValue(argv, index++, arg), arg);
    else if (arg.startsWith("--max-total-tokens=")) options.maxTotalTokens = positive(arg.slice(19), "--max-total-tokens");
    else if (arg === "--max-changed-files") options.maxChangedFiles = positive(requireValue(argv, index++, arg), arg);
    else if (arg.startsWith("--max-changed-files=")) options.maxChangedFiles = positive(arg.slice(20), "--max-changed-files");
    else if (arg === "--max-diff-lines") options.maxDiffLines = positive(requireValue(argv, index++, arg), arg);
    else if (arg.startsWith("--max-diff-lines=")) options.maxDiffLines = positive(arg.slice(17), "--max-diff-lines");
    else if (arg === "--allow-path") options.allowPaths.push(requireValue(argv, index++, arg));
    else if (arg.startsWith("--allow-path=")) options.allowPaths.push(arg.slice(13));
    else if (arg === "--halt-file") options.haltFile = requireValue(argv, index++, arg);
    else if (arg.startsWith("--halt-file=")) options.haltFile = arg.slice(12);
    else if (arg === "--keep-workspace") options.keepWorkspace = true;
    else if (arg === "--json") options.json = true;
    else if (["--help", "-h", "help"].includes(arg)) options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && options.command !== "run") throw new Error(`Unknown command: ${options.command || "(missing)"}`);
  if (!options.help && !options.programPath) throw new Error("run requires --program");
  if (!options.help && !options.ticketId) throw new Error("run requires --ticket");
  if (!options.help && !options.agentCommand) throw new Error("run requires --agent-cmd");
  return options;
}

function renderText(result) {
  const lines = [
    `Autonomous ticket delivery: ${result.status}`,
    `Ticket: ${result.receipt?.ticket_id || "n/a"}`,
    `Receipt: ${result.receipt_path || "n/a"}`,
    `Candidate branch: ${result.candidate_branch || "n/a"}`,
    `Agent invocations: ${result.receipt?.invocation_count ?? result.invocation_count ?? 0}`,
  ];
  for (const finding of result.receipt?.grade?.failures || []) lines.push(`- ${finding.code}: ${finding.detail}`);
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  try {
    options = parseAutonomousTicketDeliveryArgs(argv);
  } catch (error) {
    const payload = { schema_version: 1, status: "FAIL", ok: false, error: error.message };
    if (argv.includes("--json")) emitJson(payload, { exitCode: 2 });
    else console.error(`ERROR: ${error.message}\n${usage()}`);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  try {
    const runDelivery = dependencies.runDelivery || runAutonomousTicketDelivery;
    const result = runDelivery({
      repoRoot: process.cwd(),
      programPath: options.programPath,
      ticketId: options.ticketId,
      agentCommand: options.agentCommand,
      verificationCommand: options.verificationCommand,
      receiptRoot: options.receiptRoot,
      workspaceParent: options.workspaceParent ? resolve(options.workspaceParent) : undefined,
      timeoutMs: options.timeoutMs,
      maxTotalTokens: options.maxTotalTokens,
      maxChangedFiles: options.maxChangedFiles,
      maxDiffLines: options.maxDiffLines,
      allowPaths: options.allowPaths.length > 0 ? options.allowPaths : null,
      haltFile: options.haltFile,
      keepWorkspace: options.keepWorkspace,
      branchName: options.branchName,
    });
    const exitCode = result.ok ? 0 : (result.reason === "halted" ? 3 : 1);
    if (options.json) emitJson(result, { exitCode });
    else console.log(renderText(result));
    return exitCode;
  } catch (error) {
    const payload = { schema_version: 1, status: "FAIL", ok: false, error: error.message };
    if (options.json) emitJson(payload, { exitCode: 1 });
    else console.error(`ERROR: ${error.message}`);
    return 1;
  }
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
