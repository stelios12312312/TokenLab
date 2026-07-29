#!/usr/bin/env node
// test_llm_run_telemetry.mjs - Canonical LLM run ledger contract.

import assert from "assert";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import { callRoleProviderJson } from "../scripts/lib/role_provider_runtime.mjs";
import { getProjectGateTimings } from "../scripts/lib/interface_telemetry.mjs";
import {
  RAW_STORAGE_ACKNOWLEDGEMENT,
  buildIdeTelemetryAdapterMatrix,
  getLlmRunTelemetryPaths,
  normalizeIdeTelemetryEvent,
  readLlmRunTelemetryRecords,
  recordLlmRunTelemetry,
  summarizeLlmRunTelemetry,
  validateLlmRunTelemetryConfig,
} from "../scripts/lib/llm_run_telemetry.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

let passed = 0;
let failed = 0;

function check(condition, label, detail = "") {
  try {
    assert.ok(condition, detail || label);
    passed += 1;
    console.log(`  PASS: ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL: ${label}${error?.message ? ` - ${error.message}` : ""}`);
  }
}

function setupProject(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const planName = "plan_2026-06-25_llm_run_test";
  const planDir = join(root, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(root, "plans", ".current_plan"), `${planName}\n`);
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "EXECUTE",
    goal: "test llm run telemetry",
  }, null, 2));
  writeFileSync(join(planDir, "plan.md"), "# Plan\n\n## Goal\nTest LLM run telemetry\n");
  return { root, planName, planDir };
}

function readLedgerText(planDir) {
  const { runsPath } = getLlmRunTelemetryPaths(planDir);
  return existsSync(runsPath) ? readFileSync(runsPath, "utf-8") : "";
}

function parseLastRecord(planDir) {
  const { records } = readLlmRunTelemetryRecords(planDir);
  return records.at(-1);
}

function cleanup(project) {
  rmSync(project.root, { recursive: true, force: true });
}

function scenarioPrivacyAndAppendOnly() {
  const project = setupProject("llm-run-privacy");
  try {
    const env = {
      USER_SECRET_TOKEN: "user-secret-value",
    };
    const messages = [
      {
        role: "user",
        content: "Use sk-1234567890abcdef, Bearer abcdefghijklmnopqrstuvwxyz, ghp_1234567890ABCDEFGHIJKL, and user-secret-value.",
      },
    ];
    const first = recordLlmRunTelemetry({
      cwd: project.root,
      planDir: project.planDir,
      planDirName: project.planName,
      actor: "writer",
      source: "unit_test",
      provider: { kind: "openai_compatible", model: "unit-model", apiKey: "should-not-persist" },
      messages,
      responseText: "Result mentions sk-1234567890abcdef and user-secret-value.",
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      env,
    });
    const second = recordLlmRunTelemetry({
      cwd: project.root,
      planDir: project.planDir,
      planDirName: project.planName,
      actor: "reviewer",
      source: "unit_test",
      messages: [{ role: "user", content: "another run" }],
      responseText: "ok",
      env,
    });
    const ledgerText = readLedgerText(project.planDir);
    const { records } = readLlmRunTelemetryRecords(project.planDir);
    check(first.written === true && second.written === true, "ledger writes are successful");
    check(records.length === 2, "ledger append-only records two runs");
    check(records[0].run_id !== records[1].run_id, "ledger run ids are unique");
    check(records[0].prompt_digest && records[0].response_digest, "ledger stores prompt and response digests");
    check(!Object.prototype.hasOwnProperty.call(records[0], "prompt_text"), "default ledger omits full prompt text");
    check(!Object.prototype.hasOwnProperty.call(records[0], "response_text"), "default ledger omits full response text");
    for (const secret of [
      "sk-1234567890abcdef",
      "Bearer abcdefghijklmnopqrstuvwxyz",
      "ghp_1234567890ABCDEFGHIJKL",
      "user-secret-value",
      "should-not-persist",
    ]) {
      check(!ledgerText.includes(secret), `ledger redacts ${secret}`);
    }
  } finally {
    cleanup(project);
  }
}

function scenarioRawStorageAcknowledgement() {
  const project = setupProject("llm-run-raw");
  try {
    const invalid = validateLlmRunTelemetryConfig({
      enabled: true,
      store_raw_prompt: true,
      require_raw_storage_acknowledgement: true,
      raw_storage_acknowledgement: "",
    });
    check(invalid.ok === false, "raw storage config rejects missing acknowledgement");
    const blocked = recordLlmRunTelemetry({
      cwd: project.root,
      planDir: project.planDir,
      planDirName: project.planName,
      messages: [{ role: "user", content: "user-secret-value" }],
      responseText: "ok",
      env: { USER_SECRET_TOKEN: "user-secret-value" },
      telemetryConfig: {
        enabled: true,
        store_raw_prompt: true,
        require_raw_storage_acknowledgement: true,
        raw_storage_acknowledgement: "",
      },
    });
    check(blocked.written === false && blocked.reason === "invalid_privacy_config", "invalid privacy config blocks raw ledger write");
    const allowed = recordLlmRunTelemetry({
      cwd: project.root,
      planDir: project.planDir,
      planDirName: project.planName,
      messages: [{ role: "user", content: "user-secret-value" }],
      responseText: "response user-secret-value",
      env: { USER_SECRET_TOKEN: "user-secret-value" },
      telemetryConfig: {
        enabled: true,
        store_raw_prompt: true,
        store_raw_response: true,
        require_raw_storage_acknowledgement: true,
        raw_storage_acknowledgement: RAW_STORAGE_ACKNOWLEDGEMENT,
      },
    });
    const record = parseLastRecord(project.planDir);
    check(allowed.written === true, "acknowledged raw storage writes");
    check(record.prompt_text.includes("[REDACTED]"), "stored full prompt text is redacted");
    check(record.response_text.includes("[REDACTED]"), "stored full response text is redacted");
    check(!readLedgerText(project.planDir).includes("user-secret-value"), "raw ledger output does not include env secret");
  } finally {
    cleanup(project);
  }
}

function scenarioIdeAdapters() {
  const postTool = normalizeIdeTelemetryEvent({
    tool_name: "Read",
    tool_input: { file_path: "plans/example.md" },
  }, { ide: "claude_code" });
  const antigravity = normalizeIdeTelemetryEvent({
    name: "read_file",
    args: { path: "plans/ag.md" },
  }, { ide: "antigravity" });
  const codex = normalizeIdeTelemetryEvent({ reason: "not_applicable" }, { ide: "codex" });
  const matrix = buildIdeTelemetryAdapterMatrix({ hookConfigured: false, llmRunTelemetryEnabled: true });
  check(postTool.source === "post_tool_use" && postTool.paths.includes("plans/example.md"), "PostToolUse payload normalizes to canonical event");
  check(antigravity.source === "antigravity_import" && antigravity.paths.includes("plans/ag.md"), "Antigravity payload normalizes to canonical event");
  check(codex.event_type === "capture_unavailable" && codex.capture_status.primary_tool_capture === "unavailable", "Codex emits clean unavailable event");
  check(matrix.find((entry) => entry.ide === "vs_code").primary_tool_capture === "unsupported_without_claude_or_cursor_hook", "VS Code adapter status is unsupported without hook");
  check(matrix.find((entry) => entry.ide === "codex").planner_owned_llm_events === "recordable", "Codex planner-owned LLM events remain recordable");
}

function scenarioArtifactStitcher() {
  const project = setupProject("llm-run-stitch");
  try {
    mkdirSync(join(project.planDir, "review_intake_sources"), { recursive: true });
    mkdirSync(join(project.planDir, "artifacts"), { recursive: true });
    mkdirSync(join(project.planDir, "telemetry"), { recursive: true });
    writeFileSync(join(project.planDir, "persona_guidance.json"), JSON.stringify({
      summary: { pack_ids: ["wiring_auditor"] },
      items: [{ pack_id: "traceability" }],
    }));
    writeFileSync(join(project.planDir, "persona_findings.json"), JSON.stringify({
      findings: [{ analyzer: "[config_integrity] config_integrity", severity: "warn" }],
    }));
    writeFileSync(join(project.planDir, "review_intake_sources", "deepseek.json"), JSON.stringify({
      source: "deepseek",
      status: "review_ready",
      deterministic_truth: { status: "fail" },
    }));
    writeFileSync(join(project.planDir, "artifacts", "tool_trace.jsonl"), `${JSON.stringify({
      ts: "2026-06-25T10:00:00.000Z",
      seq: 1,
      tool: "Read",
      paths: ["plans/example.md"],
    })}\n`);
    writeFileSync(join(project.planDir, "telemetry", "events.jsonl"), `${JSON.stringify({
      timestamp: "2026-06-25T10:00:01.000Z",
      event: "proof_recorded",
      proof_type: "planner_smoke",
    })}\n`);
    recordLlmRunTelemetry({
      cwd: project.root,
      planDir: project.planDir,
      planDirName: project.planName,
      actor: "writer",
      source: "unit_test",
      messages: [{ role: "user", content: "prompt" }],
      responseText: "response",
      personaPacks: ["assumptions_challenger"],
      advisoryArtifacts: ["review_intake_sources/deepseek.json"],
      toolRefs: ["tool_trace:1"],
    });
    const summary = summarizeLlmRunTelemetry({
      cwd: project.root,
      planDir: project.planDir,
      planDirName: project.planName,
      persist: true,
    });
    check(summary.mode === "present", "stitcher reports present when ledger and linked artifacts exist");
    check(summary.run_count === 1, "stitcher counts runs");
    check(summary.persona_packs.includes("wiring_auditor") && summary.persona_packs.includes("assumptions_challenger"), "stitcher merges persona packs from artifacts and runs");
    check(summary.advisory_artifacts.length === 1, "stitcher lists advisory artifacts");
    check(summary.tool_trace.line_count === 1 && summary.proof_telemetry.event_count === 1, "stitcher reports tool and proof telemetry counts");
    check(summary.deterministic_status.advisory_can_clear_blockers === false, "advisory output cannot clear deterministic blockers");
    check(existsSync(join(project.planDir, "telemetry", "llm_runs_summary.json")), "stitcher persists summary artifact");
  } finally {
    cleanup(project);
  }

  const absent = setupProject("llm-run-absent");
  try {
    const summary = summarizeLlmRunTelemetry({
      cwd: absent.root,
      planDir: absent.planDir,
      planDirName: absent.planName,
      persist: false,
    });
    check(summary.mode === "absent" && summary.capture_gaps.includes("llm_run_ledger_absent"), "missing ledger reports absent capture gap");
  } finally {
    cleanup(absent);
  }
}

async function scenarioRoleProviderIntegration() {
  const project = setupProject("llm-run-role-provider");
  try {
    const response = await callRoleProviderJson({
      role: "writer",
      config: {
        role_provider_defaults: {
          cheap: {
            kind: "openai_compatible",
            default_model: "cheap-model",
            default_base_url: "https://example.invalid/v1",
            api_key_env: "CHEAP_API_KEY",
          },
        },
        role_providers: {
          writer: {
            quality: "cheap",
            mock_response_env: "WRITER_MOCK_RESPONSE",
          },
        },
        cost_estimates: {
          currency: "USD",
          rates_per_million_tokens: {
            "cheap-model": { input: 1, output: 2 },
          },
        },
      },
      messages: [{ role: "user", content: "Return JSON." }],
      telemetry: { cwd: project.root },
      env: {
        WRITER_MOCK_RESPONSE: JSON.stringify({
          status: "ok",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    });
    const { records } = readLlmRunTelemetryRecords(project.planDir);
    check(response.llm_run_telemetry.written === true, "role-provider call records LLM run telemetry");
    check(records.length === 1 && records[0].actor.role === "writer", "role-provider ledger records actor role");
    check(records[0].model === "cheap-model", "role-provider ledger records model");
    check(records[0].usage.total_tokens === 15, "role-provider ledger records usage");
  } finally {
    cleanup(project);
  }
}

function scenarioCliReport() {
  const project = setupProject("llm-run-cli");
  try {
    recordLlmRunTelemetry({
      cwd: project.root,
      planDir: project.planDir,
      planDirName: project.planName,
      actor: "writer",
      source: "unit_test",
      messages: [{ role: "user", content: "prompt" }],
      responseText: "response",
    });
    const cli = spawnSync(process.execPath, [
      join(repoRoot, ".agent", "skills", "iterative-planner", "scripts", "telemetry.mjs"),
      "llm-runs",
      "--json",
      "--project",
      project.root,
      "--plan",
      project.planName,
    ], { encoding: "utf-8" });
    check(cli.status === 0, "telemetry CLI llm-runs exits successfully", cli.stderr);
    const parsed = JSON.parse(cli.stdout);
    check(parsed.summary.run_count === 1, "telemetry CLI reports run count");
    check(parsed.capture_status.ide_adapters.some((entry) => entry.ide === "codex" && entry.primary_tool_capture === "unavailable"), "telemetry CLI includes Codex capture gap");
  } finally {
    cleanup(project);
  }
}

function scenarioGateTimingToolErrors() {
  const project = setupProject("gate-timing-tool-errors");
  try {
    writeFileSync(join(project.planDir, "metrics.json"), JSON.stringify({
      version: 1,
      plan_id: project.planName,
      created_at: "2026-06-25T10:00:00.000Z",
      gate_transitions: [{ gate: "explore-to-plan", at: "2026-06-25T10:05:00.000Z", retries: 1 }],
      gate_failures: [{ gate: "explore-to-plan", at: "2026-06-25T10:03:00.000Z", failure_codes: ["GATE-SRC-001"] }],
      tool_errors: [
        { gate: "explore-to-plan", at: "2026-06-25T10:01:00.000Z", code: "TOOL-RIT-001", kind: "process_exit" },
        { gate: "explore-to-plan", at: "2026-06-25T10:02:00.000Z", code: "TOOL-RIT-001", kind: "invalid_json" },
      ],
    }, null, 2));
    const summary = getProjectGateTimings(project.root);
    const plan = summary.plans[0];
    check(summary.tool_error_count === 2, "project gate timings expose aggregate tool errors");
    check(plan.failure_count === 1, "project gate timings preserve semantic failure count");
    check(plan.tool_error_count === 2 && plan.tool_errors.length === 2, "plan gate timings expose tool errors separately");
  } finally {
    cleanup(project);
  }
}

console.log("\nLLM Run Telemetry Tests\n");

scenarioPrivacyAndAppendOnly();
scenarioRawStorageAcknowledgement();
scenarioIdeAdapters();
scenarioArtifactStitcher();
await scenarioRoleProviderIntegration();
scenarioCliReport();
scenarioGateTimingToolErrors();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
