#!/usr/bin/env node
// test_llm_drift_steward.mjs — cheap-LLM drift auditor and async maintenance.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { callOpenAiCompatibleJson, loadDriftLlmConfig, normalizeLlmDriftPayload } from "../scripts/lib/llm_drift_client.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const agentDir = resolve(skillDir, "../..");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function run(args, cwd, extraEnv = {}) {
  const result = spawnSync(NODE, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      _PLANNER_PLAN_TARGET: "",
      PLANNER_SKIP_SELF_HEAL: "1",
      ...extraEnv,
    },
    timeout: 60_000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bootstrapProject() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-llm-drift-"));
  cpSync(agentDir, join(tmp, ".agent"), { recursive: true });
  const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
  const created = run([bootstrapScript, "new", "LLM drift steward regression"], tmp);
  assert(created.ok, "bootstrap new exits cleanly for drift steward fixture");
  const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, "src", "foo.js"), "export const value = 1;\n");
  return { tmp, planName };
}

const auditorScript = ".agent/skills/iterative-planner/scripts/llm_drift_auditor.mjs";
const maintenanceScript = ".agent/skills/iterative-planner/scripts/llm_drift_maintenance.mjs";

const { tmp, planName } = bootstrapProject();

try {
  console.log("\n[Provider/config]");
  const missing = run([auditorScript, "--mode", "gate", "--gate", "plan-to-execute", "--plan", planName, "--json"], tmp);
  const missingJson = parseJson(missing.stdout);
  assert(missing.ok, "auditor exits 0 when provider config is missing");
  assert(missingJson?.status === "unavailable", "missing provider config returns unavailable");
  assert(missingJson?.fail_open === true, "missing provider config is fail-open");

  writeFileSync(join(tmp, ".env.local"), [
    "DEEPSEEK_API_KEY=sk-local-deepseek-alias",
    "PLANNER_DRIFT_LLM_PHASES=gate,post_task",
    "PLANNER_DRIFT_LLM_WRITE_MODE=safe_apply",
    "",
  ].join("\n"));
  const localConfig = loadDriftLlmConfig({}, { cwd: tmp });
  assert(localConfig.configured === true, ".env.local DeepSeek alias configures the drift provider");
  assert(localConfig.model === "deepseek-chat", ".env.local DeepSeek alias defaults the model");
  assert(localConfig.baseUrl === "https://api.deepseek.com/v1", ".env.local DeepSeek alias defaults the base URL");
  assert(localConfig.usingDeepSeekAlias === true, ".env.local reports DeepSeek alias usage");

  const explicitEnvConfig = loadDriftLlmConfig({
    PLANNER_DRIFT_LLM_API_KEY: "sk-env-provider",
    PLANNER_DRIFT_LLM_MODEL: "explicit-model",
    PLANNER_DRIFT_LLM_BASE_URL: "https://explicit.invalid/v1",
    DEEPSEEK_API_KEY: "sk-env-deepseek-alias",
  }, { cwd: tmp });
  assert(explicitEnvConfig.apiKey === "sk-env-provider", "process env planner key wins over local env and DeepSeek alias");
  assert(explicitEnvConfig.model === "explicit-model", "process env planner model wins over local env default");
  assert(explicitEnvConfig.baseUrl === "https://explicit.invalid/v1", "process env planner base URL wins over local env default");
  assert(explicitEnvConfig.usingDeepSeekAlias === false, "explicit planner key disables DeepSeek alias mode");

  const localAliasAudit = run([auditorScript, "--mode", "gate", "--gate", "plan-to-execute", "--plan", planName, "--json"], tmp, {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({ status: "fresh", summary: "local env alias works", findings: [] }),
  });
  const localAliasJson = parseJson(localAliasAudit.stdout);
  assert(localAliasAudit.ok, "auditor uses .env.local DeepSeek alias with mock provider");
  assert(localAliasJson?.provider?.configured === true, "auditor public provider config reports local env alias configured");
  assert(localAliasJson?.provider?.using_deepseek_alias === true, "auditor public provider config reports DeepSeek alias mode");
  assert(!localAliasAudit.stdout.includes("sk-local-deepseek-alias"), "local .env DeepSeek key is not printed in auditor JSON");

  const secret = "sk-test-secret-drift-steward";
  const staleResponse = JSON.stringify({
    status: "stale_blocking",
    summary: `secret should not leak ${secret}`,
    findings: [
      {
        classification: "stale_blocking",
        surface: "recover-poison docs",
        file: "README.md",
        claim: "Recovery guidance stale",
        reason: "Docs disagree with deterministic transition result",
        confidence: "high",
        runtime_truth_refs: ["planner_findings"],
        recommended_action: "Run deterministic follow-up",
      },
    ],
  });
  const stale = run([auditorScript, "--mode", "gate", "--gate", "plan-to-execute", "--plan", planName, "--json"], tmp, {
    PLANNER_DRIFT_LLM_API_KEY: secret,
    PLANNER_DRIFT_LLM_MODEL: "kimi-or-deepseek-test",
    PLANNER_DRIFT_LLM_BASE_URL: "https://example.invalid/v1",
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: staleResponse,
  });
  const staleJson = parseJson(stale.stdout);
  assert(stale.ok, "mock stale_blocking auditor exits 0");
  assert(staleJson?.status === "stale_blocking", "mock stale_blocking classification is preserved");
  assert(staleJson?.hard_blocking === false, "stale_blocking is not a hard gate block");
  assert(!stale.stdout.includes(secret), "API key and echoed secret are redacted from auditor JSON");

  const invalid = run([auditorScript, "--mode", "gate", "--gate", "plan-to-execute", "--plan", planName, "--json"], tmp, {
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: "not json",
  });
  const invalidJson = parseJson(invalid.stdout);
  assert(invalid.ok, "invalid LLM JSON exits 0");
  assert(invalidJson?.status === "unavailable", "invalid LLM JSON returns unavailable");

  const timeout = run([auditorScript, "--mode", "gate", "--gate", "plan-to-execute", "--plan", planName, "--json"], tmp, {
    PLANNER_DRIFT_LLM_MOCK_ERROR: "timeout",
  });
  const timeoutJson = parseJson(timeout.stdout);
  assert(timeout.ok, "mock timeout exits 0");
  assert(timeoutJson?.status === "unavailable", "mock timeout returns unavailable");

  const httpError = run([auditorScript, "--mode", "gate", "--gate", "plan-to-execute", "--plan", planName, "--json"], tmp, {
    PLANNER_DRIFT_LLM_MOCK_ERROR: "http_error",
  });
  const httpJson = parseJson(httpError.stdout);
  assert(httpError.ok, "mock HTTP error exits 0");
  assert(httpJson?.status === "unavailable", "mock HTTP error returns unavailable");

  const contradictory = normalizeLlmDriftPayload({
    status: "fresh",
    summary: "looks clean",
    findings: [
      {
        classification: "stale_blocking",
        surface: "docs",
        reason: "contradiction",
      },
    ],
  });
  assert(contradictory.status === "stale_blocking", "contradictory fresh payload normalizes to worst finding status");

  const humanSecret = "sk-human-mode-redaction-test";
  const human = run([auditorScript, "--mode", "gate", "--gate", "plan-to-execute", "--plan", planName, "--mock-response", JSON.stringify({
    status: "fresh",
    summary: `secret ${humanSecret}`,
    findings: [
      {
        classification: "fresh",
        surface: `surface ${humanSecret}`,
        reason: `reason ${humanSecret}`,
      },
    ],
  })], tmp, {
    PLANNER_DRIFT_LLM_API_KEY: humanSecret,
    PLANNER_DRIFT_LLM_MODEL: "deepseek-test",
    PLANNER_DRIFT_LLM_BASE_URL: "https://example.invalid/v1",
  });
  assert(human.ok, "human-mode auditor exits cleanly with mock response");
  assert(!human.stdout.includes(humanSecret) && !human.stderr.includes(humanSecret), "human-mode auditor redacts configured API key from LLM-derived text");

  spawnSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
  writeFileSync(join(tmp, "README.md"), "Ambient dirty README fixture.\n");
  writeFileSync(join(tmp, "plans", planName, "plan.md"), `# Plan

## Problem Statement
The LLM drift audit should receive active-plan scope before ambient worktree dirt.

## Files To Modify
- src/foo.js
`);
  const scopedTruth = run([auditorScript, "--mode", "gate", "--gate", "validate-to-close", "--plan", planName, "--json"], tmp, {
    PLANNER_DRIFT_LLM_API_KEY: "sk-scoped-truth-test",
    PLANNER_DRIFT_LLM_MODEL: "deepseek-test",
    PLANNER_DRIFT_LLM_BASE_URL: "https://example.invalid/v1",
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({ status: "fresh", summary: "clean", findings: [] }),
  });
  const scopedTruthJson = parseJson(scopedTruth.stdout);
  const scopedFiles = scopedTruthJson?.deterministic_truth?.changed_files || [];
  assert(scopedTruth.ok, "auditor exits cleanly for scoped changed-files fixture");
  assert(scopedTruthJson?.deterministic_truth?.changed_files_source === "plan_files", "auditor deterministic truth prefers active-plan files when present");
  assert(scopedFiles.some((entry) => entry.path === "src/foo.js"), "auditor deterministic truth includes planned file");
  assert(!scopedFiles.some((entry) => entry.path === "README.md"), "auditor deterministic truth excludes ambient dirty README when plan files exist");

  const requestBodies = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    const attempt = requestBodies.length;
    const content = attempt === 1
      ? "{\"status\":\"fresh\",\"findings\":["
      : JSON.stringify({
        status: "fresh",
        summary: "repaired compact JSON",
        findings: [],
        proposed_semantic_edits: [],
        recommended_follow_up: [],
      });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [
          {
            finish_reason: attempt === 1 ? "length" : "stop",
            message: { content },
          },
        ],
      }),
    };
  };
  const providerConfig = loadDriftLlmConfig({
    PLANNER_DRIFT_LLM_API_KEY: "sk-provider-test",
    PLANNER_DRIFT_LLM_MODEL: "deepseek-test",
    PLANNER_DRIFT_LLM_BASE_URL: "https://example.invalid/v1",
  });
  const repaired = await callOpenAiCompatibleJson({
    config: providerConfig,
    messages: [{ role: "user", content: "Return JSON" }],
    fetchImpl: fakeFetch,
  });
  assert(requestBodies[0]?.response_format?.type === "json_object", "provider request asks for JSON object response_format");
  assert(requestBodies.length === 2, "malformed provider JSON triggers one repair retry");
  assert(repaired?.parsed?.status === "fresh", "repair retry returns parsed JSON");
  assert(repaired?.repaired_json === true, "repair retry is marked in the client result");

  console.log("\n[Async maintenance]");
  const sourceBefore = readFileSync(join(tmp, "src", "foo.js"), "utf-8");
  const missingJobPath = join(tmp, "missing-plan-job.json");
  const missingPlanSecret = "sk-missing-plan-redaction-test";
  writeFileSync(missingJobPath, JSON.stringify({
    version: 1,
    id: "drift_job_missing_plan",
    status: "pending",
    plan: `missing-${missingPlanSecret}`,
    created_at: new Date().toISOString(),
  }, null, 2) + "\n");
  const missingJob = run([maintenanceScript, "run", "--job", missingJobPath, "--json"], tmp, {
    PLANNER_DRIFT_LLM_API_KEY: missingPlanSecret,
  });
  const missingJobJson = parseJson(readFileSync(missingJobPath, "utf-8"));
  assert(!missingJob.ok, "maintenance run exits non-zero for missing target plan");
  assert(missingJobJson?.status === "failed", "failed maintenance run writes failed job status");
  assert(typeof missingJobJson?.failed_at === "string", "failed maintenance run records failed_at");
  assert(typeof missingJobJson?.error === "string" && !missingJobJson.error.includes(missingPlanSecret), "failed maintenance run records redacted error");

  const enqueue = run([maintenanceScript, "enqueue", "--plan", planName, "--reason", "post_task", "--json"], tmp);
  const enqueueJson = parseJson(enqueue.stdout);
  assert(enqueue.ok, "enqueue exits cleanly");
  assert(existsSync(enqueueJson?.job_path || ""), "enqueue writes a job file");
  assert(readFileSync(join(tmp, "src", "foo.js"), "utf-8") === sourceBefore, "enqueue does not mutate source files");

  const semanticResponse = JSON.stringify({
    status: "stale_advisory",
    summary: "annotation review needed",
    findings: [
      {
        classification: "stale_advisory",
        surface: "annotation",
        file: "src/foo.js",
        claim: "foo lacks a criterion annotation",
        reason: "Suggested only; deterministic proof is absent",
        confidence: "medium",
        runtime_truth_refs: ["annotation_parser", "ontology_serializer"],
        recommended_action: "Review manually",
      },
    ],
    proposed_semantic_edits: [
      {
        file: "src/foo.js",
        line: 1,
        kind: "@planner:proves",
        rationale: "Possible criterion proof",
        proposed_text: "// @planner:proves = crit:sc_1",
        deterministic_validation: "not_proven",
      },
    ],
  });
  const runJob = run([maintenanceScript, "run", "--job", enqueueJson.job_path, "--mock-response", semanticResponse, "--json"], tmp);
  const runJson = parseJson(runJob.stdout);
  assert(runJob.ok, "maintenance run exits cleanly with mock LLM");
  assert(existsSync(runJson?.report_path || ""), "maintenance run writes JSON report");
  assert(existsSync(join(tmp, "plans", planName, "async", "drift_maintenance_report.md")), "maintenance run writes Markdown report");
  assert(runJson?.report?.ontology_usage_proof?.commands?.annotation_validate?.command?.includes("annotation_parser.mjs --validate"), "report records annotation validation command");
  assert(runJson?.report?.ontology_usage_proof?.commands?.rule_engine_check_invariants?.command?.includes("rule_engine.mjs check-invariants"), "report records invariant check command");
  assert(runJson?.report?.ontology_usage_proof?.commands?.traceability_pack?.command?.includes("audit_runner.mjs --pack traceability"), "report records traceability pack command");
  assert(runJson?.report?.semantic_source_edits_applied === false, "LLM semantic edits are not applied directly");
  assert(runJson?.report?.review_artifacts?.length === 1, "LLM semantic edit creates a review artifact");
  assert(readFileSync(join(tmp, "src", "foo.js"), "utf-8") === sourceBefore, "LLM semantic suggestion does not mutate source files");

  const baselineReport = parseJson(readFileSync(runJson.report_path, "utf-8"));
  baselineReport.ontology_usage_proof.outputs.ontology_fact_hash = "previous-different-ontology";
  writeFileSync(runJson.report_path, JSON.stringify(baselineReport, null, 2) + "\n");
  const enqueue2 = run([maintenanceScript, "enqueue", "--plan", planName, "--reason", "post_task", "--json"], tmp);
  const enqueue2Json = parseJson(enqueue2.stdout);
  const ritual = run([maintenanceScript, "run", "--job", enqueue2Json.job_path, "--mock-response", JSON.stringify({ status: "fresh", summary: "clean", findings: [] }), "--json"], tmp);
  const ritualJson = parseJson(ritual.stdout);
  assert(ritual.ok, "second maintenance run exits cleanly");
  assert(ritualJson?.report?.ontology_usage_proof?.decision_effect === "ritual_only", "ontology-only change with no downstream output change is classified ritual_only");

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
