#!/usr/bin/env node
// test_weekly_l3_launchd.mjs — deterministic contracts for the inert local L3 lane.

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_ALLOWED_TOOLS,
  L3_RECEIPT_ROOT,
  L3_TIMEOUT_MS,
  buildClaudeAgentCommand,
  buildHarnessArgs,
  findLatestClaudeBinary,
  parseClaudeExtensionVersion,
} from "../../../../tools/ci/run-weekly-l3-autonomous-dogfood.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const runnerPath = join(repoRoot, "tools", "ci", "run-weekly-l3-autonomous-dogfood.mjs");
const plistPath = join(repoRoot, "docs", "ci", "com.ive-studio.weekly-l3-dogfood.plist.template");
const docsPath = join(repoRoot, "docs", "ci", "l3-autonomous-dogfood.md");

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function fakeExtension(root, version, script, executable = true) {
  const binary = join(root, `anthropic.claude-code-${version}-darwin-arm64`, "resources", "native-binary", "claude");
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, script);
  chmodSync(binary, executable ? 0o755 : 0o644);
  return binary;
}

console.log("\nWeekly L3 Launchd Seat Tests\n");

const tmp = mkdtempSync(join(tmpdir(), "ive-weekly-l3-"));
try {
  const root = join(tmp, "extensions with spaces (and parens)", "owner's seat");
  const older = fakeExtension(root, "2.9.0", "#!/bin/sh\nexit 0\n");
  const expected = fakeExtension(root, "2.10.0", "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$IVE_ARGV_OUT\"\n");
  fakeExtension(root, "3.0.0", "#!/bin/sh\nexit 0\n", false);

  assert(parseClaudeExtensionVersion("anthropic.claude-code-2.10.0-darwin-arm64")?.parts.join(".") === "2.10.0", "extension version parser accepts the VS Code directory shape");
  assert(parseClaudeExtensionVersion("other.claude-code-2.10.0") === null, "extension version parser rejects unrelated directories");

  const selected = findLatestClaudeBinary({ extensionRoots: [root] });
  assert(selected.binaryPath === expected && selected.binaryPath !== older, "resolver uses numeric version order and skips a newer non-executable seat", selected.binaryPath);

  const command = buildClaudeAgentCommand(selected.binaryPath);
  assert(command.includes("--allowedTools='Bash(node:*),Bash(git:*)'"), "agent command preserves the mandatory equals-form quoted allowlist", command);
  assert(command.endsWith(" -"), "agent command preserves the stdin marker after the allowlist", command);
  assert(CLAUDE_ALLOWED_TOOLS === "Bash(node:*),Bash(git:*)", "allowlist is the proven two-tool seat");

  const argvOutput = join(tmp, "claude-argv.txt");
  const executed = spawnSync("/bin/sh", ["-lc", command], {
    env: { ...process.env, IVE_ARGV_OUT: argvOutput },
    encoding: "utf-8",
  });
  const actualArgv = readFileSync(argvOutput, "utf-8").trim().split("\n");
  assert(executed.status === 0, "quoted command executes through /bin/sh -lc", executed.stderr);
  assert(JSON.stringify(actualArgv) === JSON.stringify([
    "-p",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools=Bash(node:*),Bash(git:*)",
    "-",
  ]), "native binary receives exact Claude argv", JSON.stringify(actualArgv));

  const harnessArgs = buildHarnessArgs({ agentCommand: command });
  assert(harnessArgs.includes("--timeout-ms") && harnessArgs[harnessArgs.indexOf("--timeout-ms") + 1] === String(L3_TIMEOUT_MS), "harness receives the one-hour timeout");
  assert(harnessArgs.includes("--receipt-root") && harnessArgs[harnessArgs.indexOf("--receipt-root") + 1] === L3_RECEIPT_ROOT, "harness receives the standard receipt root");
  assert(harnessArgs.at(-1) === "--json", "harness receipt mode is JSON");

  const dryRun = spawnSync(process.execPath, [runnerPath, "--dry-run"], {
    cwd: repoRoot,
    env: { ...process.env, VSCODE_EXTENSIONS_DIR: root },
    encoding: "utf-8",
  });
  const dryPayload = JSON.parse(dryRun.stdout);
  assert(dryRun.status === 0 && dryPayload.scheduling_performed === false, "dry-run resolves configuration without scheduling");
  assert(dryPayload.claude_binary === expected && dryPayload.timeout_ms === 3600000, "dry-run reports selected seat and timeout");

  const runnerSource = readFileSync(runnerPath, "utf-8");
  assert(!runnerSource.includes("launchctl"), "runner has no scheduler mutation path");
  assert(!runnerSource.includes("anthropic.claude-code-2.1.206"), "runner does not pin the historical extension version");

  const plist = readFileSync(plistPath, "utf-8");
  const lint = spawnSync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf-8" });
  assert(lint.status === 0, "launchd plist template is syntactically valid", lint.stderr);
  assert(plist.includes("__REPO_ROOT__") && plist.includes("__NODE_BINARY__") && plist.includes("__HOME__"), "plist keeps machine paths as explicit placeholders");
  assert(plist.includes("<key>Weekday</key>\n    <integer>1</integer>") && plist.includes("<integer>4</integer>") && plist.includes("<integer>17</integer>"), "plist declares Monday 04:17 local schedule");
  assert(!plist.includes("anthropic.claude-code-2.1.206"), "plist does not pin an extension directory");

  const docs = readFileSync(docsPath, "utf-8");
  assert(docs.includes("does not install or load the job") && docs.includes("operator decision"), "runbook preserves the operator-owned scheduling boundary");
  assert(docs.includes("launchctl bootstrap") && docs.includes("launchctl bootout") && docs.includes("plutil -lint"), "runbook documents install, validation, and rollback");
  assert(docs.includes(L3_RECEIPT_ROOT), "runbook names the standard receipt root");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
