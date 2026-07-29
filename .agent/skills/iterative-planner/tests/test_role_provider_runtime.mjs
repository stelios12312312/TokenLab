#!/usr/bin/env node
// test_role_provider_runtime.mjs - E6-1 role-provider runtime contract.

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  ROLE_IDS,
  callRoleProviderJson,
  createCostLedger,
  resolveRoleProvider,
} from "../scripts/lib/role_provider_runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function baseConfig(overrides = {}) {
  return {
    role_provider_defaults: {
      cheap: {
        kind: "openai_compatible",
        default_model: "cheap-model",
        default_base_url: "https://example.invalid/v1",
        api_key_env: "CHEAP_API_KEY",
        timeout_ms: 1000,
      },
      frontier: {
        kind: "openai_compatible",
        default_model: "frontier-model",
        default_base_url: "https://frontier.invalid/v1",
        api_key_env: "FRONTIER_API_KEY",
        timeout_ms: 2000,
      },
    },
    role_providers: {
      writer: { quality: "cheap" },
      rubric_admin: { quality: "cheap" },
      reviewer: {
        quality: "cheap",
        mock_response_env: "REVIEWER_MOCK_RESPONSE",
        mock_error_env: "REVIEWER_MOCK_ERROR",
      },
      escalation: { quality: "frontier" },
    },
    cost_estimates: {
      currency: "USD",
      source: "unit_test_configured_estimate",
      rates_per_million_tokens: {
        "cheap-model": { input: 0.5, output: 1.5 },
        "frontier-model": { input: 2, output: 6 },
      },
    },
    ...overrides,
  };
}

function scenarioRoleDefaults() {
  const cfg = baseConfig();
  const env = { CHEAP_API_KEY: "cheap-key", FRONTIER_API_KEY: "frontier-key" };
  const resolved = Object.fromEntries(ROLE_IDS.map((role) => [role, resolveRoleProvider({ role, config: cfg, env })]));
  assert(resolved.writer.quality === "cheap", "writer defaults to cheap");
  assert(resolved.rubric_admin.quality === "cheap", "rubric_admin defaults to cheap");
  assert(resolved.reviewer.quality === "cheap", "reviewer defaults to cheap");
  assert(resolved.escalation.quality === "frontier", "escalation defaults to frontier");
  assert(resolved.rubric_admin.model === "cheap-model", "rubric_admin uses cheap default model");
  assert(resolved.escalation.model === "frontier-model", "escalation uses frontier default model");
  assert(Object.values(resolved).every((provider) => provider.configured === true), "configured roles resolve when required env is present");
}

function scenarioUnknownRoleFails() {
  try {
    resolveRoleProvider({ role: "sidekick", config: baseConfig(), env: {} });
    assert(false, "unknown role fails");
  } catch (error) {
    assert(error?.code === "role_provider_unknown_role", "unknown role names role_provider_unknown_role");
    assert((error?.allowed_roles || []).includes("rubric_admin"), "unknown role error carries allowed roles");
  }
}

function scenarioRoleOverrideWinsOverLegacy() {
  const cfg = baseConfig({
    role_provider_defaults: {},
    provider: {
      kind: "openai_compatible",
      default_model: "legacy-model",
      default_base_url: "https://legacy.invalid/v1",
      api_key_env: "LEGACY_API_KEY",
    },
    role_providers: {
      reviewer: {
        quality: "cheap",
        default_model: "role-model",
        api_key_env: "ROLE_API_KEY",
      },
    },
  });
  const provider = resolveRoleProvider({ role: "reviewer", config: cfg, env: { ROLE_API_KEY: "role-key" } });
  assert(provider.model === "role-model", "role-specific model wins over legacy provider");
  assert(provider.apiKeyEnv === "ROLE_API_KEY", "role-specific api_key_env wins over legacy provider");
  assert(provider.baseUrl === "https://legacy.invalid/v1", "legacy provider remains fallback for unset fields");
}

async function scenarioProviderUnavailable() {
  try {
    await callRoleProviderJson({
      role: "writer",
      config: baseConfig(),
      messages: [{ role: "user", content: "hello" }],
      env: {},
    });
    assert(false, "provider unavailable fails");
  } catch (error) {
    assert(error?.code === "provider_unavailable", "provider unavailable uses explicit code");
    assert((error?.provider?.missing || []).includes("CHEAP_API_KEY"), "provider unavailable names missing env field");
  }
}

async function scenarioCostLedger() {
  const cfg = baseConfig({
    role_providers: {
      writer: {
        quality: "cheap",
        mock_response_env: "WRITER_MOCK_RESPONSE",
      },
    },
  });
  const ledger = createCostLedger({ taskId: "unit-role-call" });
  const response = await callRoleProviderJson({
    role: "writer",
    config: cfg,
    messages: [{ role: "user", content: "Return JSON." }],
    ledger,
    env: {
      WRITER_MOCK_RESPONSE: JSON.stringify({
        status: "ok",
        summary: "fixture",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    },
  });
  assert(response.source === "mock", "mock provider path executes through shared wrapper");
  assert(response.cost_ledger.call_count === 1, "ledger records one call");
  assert(response.cost_ledger.total_tokens === 150, "ledger records provider token usage");
  assert(response.cost_ledger.estimate_status === "estimated", "ledger records estimated cost status when rates exist");
  assert(response.cost_ledger.cost_estimate_usd > 0, "ledger computes configured dollar estimate");
  assert(response.cost_ledger.by_role.writer.call_count === 1, "ledger aggregates by role");
  assert(response.cost_call.latency_ms >= 0, "ledger records latency");
}

async function scenarioMissingRate() {
  const cfg = baseConfig({
    cost_estimates: {
      currency: "USD",
      rates_per_million_tokens: {},
    },
    role_providers: {
      writer: {
        quality: "cheap",
        mock_response_env: "WRITER_MOCK_RESPONSE",
      },
    },
  });
  const response = await callRoleProviderJson({
    role: "writer",
    config: cfg,
    messages: [{ role: "user", content: "Return JSON." }],
    env: {
      WRITER_MOCK_RESPONSE: JSON.stringify({
        status: "ok",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    },
  });
  assert(response.cost_ledger.estimate_status === "missing_rate", "missing rates surface missing_rate");
  assert(response.cost_ledger.calls[0].cost_estimate_usd === null, "missing rates do not masquerade as zero cost");
}

function scenarioDocsContract() {
  const docs = readFileSync(resolve(repoRoot, "docs", "role-provider-runtime.md"), "utf-8");
  for (const term of [
    "rubric_admin",
    "escalation",
    "FRESH_CONTEXT_REVIEWER_API_KEY",
    "rates_per_million_tokens",
    "missing_rate",
    "provider_unavailable",
    "fail-honest",
  ]) {
    assert(docs.includes(term), `docs mention ${term}`);
  }
}

console.log("\nRole Provider Runtime Tests (E6-1)\n");

scenarioRoleDefaults();
scenarioUnknownRoleFails();
scenarioRoleOverrideWinsOverLegacy();
await scenarioProviderUnavailable();
await scenarioCostLedger();
await scenarioMissingRate();
scenarioDocsContract();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
