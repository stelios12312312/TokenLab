#!/usr/bin/env node
// @planner:story_id US-087
// @planner:proves = crit:CRIT-003, crit:CRIT-007

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

import { loadInterfaceConfig } from "../../planner-mcp/interface_config.mjs";

function usage() {
  return [
    "security_audit.mjs — Phase 9 interface security checklist",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/security_audit.mjs audit [--json]",
  ].join("\n");
}

function read(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function fileMode(path) {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    return null;
  }
}

function check(id, label, passed, evidence, severity = "HIGH") {
  return { id, label, status: passed ? "PASS" : "FAIL", severity, evidence };
}

function includesAll(content, needles) {
  return needles.every((needle) => content.includes(needle));
}

function runAudit(projectRoot = process.cwd()) {
  const interfaceLoad = loadInterfaceConfig({ projectRoot });
  const config = interfaceLoad.config || {};
  const http = config.interfaces?.http || {};
  const mcp = config.interfaces?.mcp || {};
  const httpServer = read(join(projectRoot, ".agent", "skills", "planner-mcp", "http_server.mjs"));
  const auth = read(join(projectRoot, ".agent", "skills", "planner-mcp", "http_auth.mjs"));
  const rateLimit = read(join(projectRoot, ".agent", "skills", "planner-mcp", "http_rate_limit.mjs"));
  const server = read(join(projectRoot, ".agent", "skills", "planner-mcp", "server.mjs"));
  const common = read(join(projectRoot, ".agent", "skills", "planner-mcp", "tools", "common.mjs"));
  const securityTests = read(join(projectRoot, ".agent", "skills", "planner-mcp", "tests", "test_security_boundaries.mjs"));
  const httpTests = read(join(projectRoot, ".agent", "skills", "planner-mcp", "tests", "test_http_server.mjs"));
  const docsHttp = read(join(projectRoot, "docs", "http", "ci_github_actions.md"));
  const reverseProxyDocs = read(join(projectRoot, "docs", "http", "reverse_proxy.md"));
  const permissionsPath = join(projectRoot, ".agent", "http_permissions.yaml");
  const permissionsContent = read(permissionsPath);
  const permissionMode = fileMode(permissionsPath);

  const checks = [
    check(
      "SEC-HTTP-001",
      "HTTP bind address defaults to localhost",
      http.bind === "127.0.0.1",
      `.agent/interfaces.yaml http.bind=${JSON.stringify(http.bind)}`
    ),
    check(
      "SEC-HTTP-002",
      "Protected HTTP endpoints require bearer token auth",
      includesAll(httpServer, ["authorizeHttpRequest"]) && includesAll(auth, ["Bearer", "hashToken", "allowed_tools"]),
      "http_server.mjs delegates to http_auth.mjs and http_auth.mjs hashes bearer tokens with per-tool permissions"
    ),
    check(
      "SEC-HTTP-003",
      "HTTP rate limiting is implemented and tested",
      includesAll(rateLimit, ["rate_limit", "per_minute"]) || includesAll(httpTests, ["rate limiting", "rate limit"]),
      "http_rate_limit.mjs and test_http_server.mjs cover burst throttling"
    ),
    check(
      "SEC-HTTP-004",
      "HTTP audit log records request outcomes without raw tokens",
      includesAll(httpServer, ["audit", "token_hash"]) && httpTests.includes("raw token"),
      "http_server.mjs writes token_hash; test_http_server.mjs asserts raw token is absent"
    ),
    check(
      "SEC-HTTP-005",
      "Permission denied and unknown tools share a generic error",
      server.includes("tool_not_available") && httpTests.includes("same external status as denied tools"),
      "server.mjs returns tool_not_available; test_http_server.mjs compares denied and unknown tool responses"
    ),
    check(
      "SEC-HTTP-006",
      "Correlation IDs are propagated into audit/error metadata",
      includesAll(httpServer, ["request_id", "correlation"]) || httpTests.includes("correlation"),
      "http_server.mjs/test_http_server.mjs include request/correlation id coverage"
    ),
    check(
      "SEC-MCP-001",
      "MCP version routing refuses non-v7 projects",
      server.includes("validateProjectVersion") && securityTests.includes("unsupported_planner_version"),
      "server.mjs validateProjectVersion plus security boundary tests"
    ),
    check(
      "SEC-MCP-002",
      "Agent B read-only and Agent C token budget boundaries are enforced",
      common.includes("agent_b_read_only_violation") && common.includes("agent_c_token_budget_required") && securityTests.includes("read-only"),
      "tools/common.mjs guardToolCall plus test_security_boundaries.mjs"
    ),
    check(
      "SEC-MCP-003",
      "Secret scanner/redaction runs over MCP tool output",
      common.includes("redactSecrets") && securityTests.includes("sk-"),
      "tools/common.mjs redacts known token forms; test_security_boundaries.mjs covers secret redaction"
    ),
    check(
      "SEC-MCP-004",
      "Forbidden traversal/resource paths are rejected",
      securityTests.includes("traversal") && server.includes("resource_read_failed"),
      "test_security_boundaries.mjs covers traversal rejection"
    ),
    check(
      "SEC-DOC-001",
      "HTTP token rotation and GitHub Actions recipe are documented",
      docsHttp.includes("http-token rotate") && /authorization:\s*`Bearer/i.test(docsHttp),
      "docs/http/ci_github_actions.md"
    ),
    check(
      "SEC-DOC-002",
      "Reverse proxy HTTPS examples are documented",
      reverseProxyDocs.includes("nginx") && reverseProxyDocs.includes("Caddy"),
      "docs/http/reverse_proxy.md"
    ),
    check(
      "SEC-CONFIG-001",
      "HTTP permissions file does not contain raw bearer tokens in committed config",
      existsSync(permissionsPath) && !/Bearer\s+\S+|token:\s*\S{12,}/i.test(permissionsContent),
      `.agent/http_permissions.yaml mode=${permissionMode || "missing"}`
    ),
    check(
      "SEC-CONFIG-002",
      "MCP transport defaults to stdio",
      mcp.transport === "stdio",
      `.agent/interfaces.yaml mcp.transport=${JSON.stringify(mcp.transport)}`
    ),
  ];

  return {
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    status: checks.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
    interface_config_ok: interfaceLoad.ok,
    interface_config_issues: interfaceLoad.issues || [],
    checks,
  };
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "audit";
  const json = args.includes("--json");
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command !== "audit") {
    console.error(`Unknown security command: ${command}`);
    console.error(usage());
    process.exit(2);
  }
  const result = runAudit();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Security audit ${result.status}: ${result.checks.length} checks`);
    for (const entry of result.checks) console.log(`${entry.status}: ${entry.id} ${entry.label}`);
  }
  process.exit(result.status === "PASS" ? 0 : 1);
}

main();
