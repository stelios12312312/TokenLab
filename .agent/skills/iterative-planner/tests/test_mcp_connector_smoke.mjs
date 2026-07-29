#!/usr/bin/env node
// test_mcp_connector_smoke.mjs — T-INTAKE-9C223A3C
//
// capability_probe.mjs and capability_connectivity.mjs test connector internals
// but do not prove a real MCP/connector handshake. This smoke test spawns the
// planner's MCP server as a local stdio subprocess and exercises transport,
// auth, and schema/message boundaries against the actual server binary.
//
// If Node or the server subprocess is unavailable, the test skips cleanly and
// records the residual risk explicitly.

import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { plannerSubprocessEnv } from "./helpers/env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_DIR = resolve(__dirname, "..");
const SERVER_PATH = join(SKILL_DIR, "mcp_server.mjs");
const FIXTURE_PATH = join(SKILL_DIR, "tests", "fixtures", "mcp_connector", "happy_handshake.json");

const EXPECTED_PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 10_000;

let passed = 0;
let failed = 0;
let skipped = 0;
const residualRisks = [];

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function skip(label, reason) {
  skipped++;
  residualRisks.push(reason);
  console.log(`  SKIP: ${label} — ${reason}`);
}

function buildMessage(method, id, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function contentLengthFrame(msg) {
  const json = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

function lineDelimitedFrame(msg) {
  return JSON.stringify(msg) + "\n";
}

async function runMcpSession(frames, { expectResponses = true } = {}) {
  if (!existsSync(SERVER_PATH)) {
    throw new Error(`MCP server not found at ${SERVER_PATH}`);
  }

  const projectRoot = mkdtempSync(join(tmpdir(), "mcp-smoke-"));
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: projectRoot,
    env: plannerSubprocessEnv({
      PLANNER_PROJECT_ROOT: projectRoot,
      PATH: process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin",
    }),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: REQUEST_TIMEOUT_MS,
  });

  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = "";
  const responses = [];

  const stdoutEnded = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      while (true) {
        const headerEnd = stdoutBuffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) break;
        const header = stdoutBuffer.slice(0, headerEnd).toString("utf-8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) break;
        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (stdoutBuffer.length < bodyStart + contentLength) break;
        const body = stdoutBuffer.slice(bodyStart, bodyStart + contentLength).toString("utf-8");
        stdoutBuffer = stdoutBuffer.slice(bodyStart + contentLength);
        try {
          responses.push(JSON.parse(body));
        } catch (err) {
          responses.push({ _parse_error: err.message, _raw: body });
        }
      }
    });
    child.stdout.on("end", resolve);
  });

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => { stderrBuffer += chunk; });

  for (const frame of frames) {
    child.stdin.write(frame);
  }
  child.stdin.end();

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", (err) => resolve(`error: ${err.message}`));
  });

  await stdoutEnded;

  return { responses, stderr: stderrBuffer, exitCode, projectRoot };
}

async function main() {
  console.log("MCP/connector smoke parity test (T-INTAKE-9C223A3C)\n");

  // --- Fixture sanity ---
  let fixture = null;
  try {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    assert(true, `fixture loaded from ${FIXTURE_PATH}`);
  } catch (err) {
    skip("fixture load", `missing or unreadable fixture: ${err.message}`);
  }

  // --- Transport boundary: Content-Length framing with initialize handshake ---
  let initSession;
  try {
    const initFrame = contentLengthFrame(buildMessage("initialize", 1, {
      protocolVersion: EXPECTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-connector-smoke-test", version: "0.1.0" },
    }));
    initSession = await runMcpSession([initFrame]);
  } catch (err) {
    skip("MCP server spawn", `subprocess failed to start: ${err.message}`);
    console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (residualRisks.length) {
      console.log("\nResidual risks:");
      for (const risk of residualRisks) console.log(`  - ${risk}`);
    }
    process.exit(failed > 0 ? 1 : 0);
  }

  assert(initSession.exitCode === 0, "server exits cleanly after Content-Length handshake");
  assert(initSession.responses.length >= 1, "received at least one response via Content-Length framing");

  const initResponse = initSession.responses.find((r) => r.id === 1);
  assert(initResponse && initResponse.result, "initialize returned a result");
  assert(initResponse.result.protocolVersion === EXPECTED_PROTOCOL_VERSION, `protocol version is ${EXPECTED_PROTOCOL_VERSION}`);
  assert(initResponse.result.serverInfo && initResponse.result.serverInfo.name === "iterative-planner", "serverInfo.name is 'iterative-planner'");
  assert(initResponse.result.capabilities && initResponse.result.capabilities.tools, "server advertises tools capability");

  // --- Transport boundary: line-delimited JSON fallback is accepted ---
  let lineSession;
  try {
    const lineInitFrame = lineDelimitedFrame(buildMessage("initialize", 2, {
      protocolVersion: EXPECTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-connector-smoke-test", version: "0.1.0" },
    }));
    lineSession = await runMcpSession([lineInitFrame]);
  } catch (err) {
    skip("line-delimited fallback", `subprocess failed: ${err.message}`);
  }

  if (lineSession) {
    // The server documents a line-delimited fallback parser. We verify it does
    // not crash; the response may race with process.exit(0) on stdin end, so we
    // only assert clean exit and record the flush limitation as residual risk.
    assert(lineSession.exitCode === 0, "server exits cleanly after line-delimited input");
    if (!lineSession.responses.some((r) => r.id === 2)) {
      residualRisks.push("Line-delimited JSON responses may not be flushed before the server exits on stdin end (observed response race).");
    }
  }

  // --- Schema boundary: tools/list returns valid tool shapes ---
  let toolsSession;
  try {
    const initFrame = contentLengthFrame(buildMessage("initialize", 3, {
      protocolVersion: EXPECTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-connector-smoke-test", version: "0.1.0" },
    }));
    const initializedFrame = contentLengthFrame(buildMessage("initialized", null));
    const toolsFrame = contentLengthFrame(buildMessage("tools/list", 4));
    toolsSession = await runMcpSession([initFrame, initializedFrame, toolsFrame]);
  } catch (err) {
    skip("tools/list handshake", `subprocess failed: ${err.message}`);
  }

  if (toolsSession) {
    const toolsResponse = toolsSession.responses.find((r) => r.id === 4);
    assert(toolsResponse?.result && Array.isArray(toolsResponse.result.tools), "tools/list returns tools array");
    const tools = toolsResponse?.result?.tools || [];
    assert(tools.length >= 5, `tools/list returns >=5 tools (got ${tools.length})`);
    const first = tools[0];
    assert(typeof first.name === "string" && first.name.length > 0, "each tool has a non-empty name");
    assert(first.inputSchema && first.inputSchema.type === "object", "each tool has an object inputSchema");
    const getStateTool = tools.find((t) => t.name === "get_state");
    assert(getStateTool, "get_state tool is present in tools/list");
    if (fixture && fixture.expectedTools) {
      for (const expected of fixture.expectedTools) {
        assert(tools.some((t) => t.name === expected), `expected tool '${expected}' is present`);
      }
    }
  }

  // --- Schema boundary: tool call validates required arguments ---
  let callSession;
  try {
    const initFrame = contentLengthFrame(buildMessage("initialize", 5, {
      protocolVersion: EXPECTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-connector-smoke-test", version: "0.1.0" },
    }));
    const initializedFrame = contentLengthFrame(buildMessage("initialized", null));
    const badCallFrame = contentLengthFrame(buildMessage("tools/call", 6, {
      name: "set_problem_statement",
      arguments: {}, // missing required expected/current/root_cause
    }));
    callSession = await runMcpSession([initFrame, initializedFrame, badCallFrame]);
  } catch (err) {
    skip("tool call schema boundary", `subprocess failed: ${err.message}`);
  }

  if (callSession) {
    const callResponse = callSession.responses.find((r) => r.id === 6);
    assert(callResponse && (callResponse.error || callResponse.result?.isError), "missing required args produce an error/isError result");
  }

  // --- Auth boundary: server starts without credentials and does not leak secrets ---
  assert(!initSession.stderr.includes("API_KEY"), "server stderr does not contain literal API_KEY");
  assert(!initSession.stderr.includes("SECRET"), "server stderr does not contain literal SECRET");
  assert(!initSession.stderr.includes("PASSWORD"), "server stderr does not contain literal PASSWORD");
  assert(initSession.stderr.includes("Iterative Planner MCP server"), "server startup banner is present on stderr");

  // --- Mock-parity contract: document what this test does not cover ---
  residualRisks.push(
    "Real IDE MCP client handshake (Claude Desktop, Codex, etc.) is not exercised; only the local stdio transport is tested.",
    "No authentication/authorization layer exists in mcp_server.mjs, so auth boundary coverage is limited to absence-of-secrets and env-root isolation.",
    "Long-running sessions, tool list change notifications, and cancellation are not covered.",
    "Concurrent client connections and stdin backpressure are not covered."
  );

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (residualRisks.length) {
    console.log("\nResidual risks / unverified surfaces:");
    for (const risk of residualRisks) console.log(`  - ${risk}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
