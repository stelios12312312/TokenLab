// role_provider_runtime.mjs - E6-1 role-provider binding and cost telemetry.

import {
  callOpenAiCompatibleJson,
  normalizeChatCompletionsEndpoint,
  normalizeOpenAiUsage,
  redactSecrets,
} from "./provider_client.mjs";
import { recordLlmRunTelemetry } from "./llm_run_telemetry.mjs";
import { canonicalVerificationStatus } from "./verification_status_vocabulary.mjs";

export const ROLE_PROVIDER_SCHEMA_VERSION = 1;
export const ROLE_IDS = Object.freeze(["writer", "rubric_admin", "reviewer", "escalation"]);

const ROLE_DEFAULTS = Object.freeze({
  writer: {
    quality: "cheap",
    default_model: "gpt-4.1-mini",
    default_base_url: "https://api.openai.com/v1",
    env_prefix: "PLANNER_WRITER",
  },
  rubric_admin: {
    quality: "cheap",
    default_model: "gpt-4.1-mini",
    default_base_url: "https://api.openai.com/v1",
    env_prefix: "PLANNER_RUBRIC_ADMIN",
  },
  reviewer: {
    quality: "cheap",
    default_model: "gpt-4.1-mini",
    default_base_url: "https://api.openai.com/v1",
    env_prefix: "FRESH_CONTEXT_REVIEWER",
  },
  escalation: {
    quality: "frontier",
    default_model: "gpt-4.1",
    default_base_url: "https://api.openai.com/v1",
    env_prefix: "PLANNER_ESCALATION",
  },
});

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pickFirst(...values) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function defaultEnv(prefix, suffix) {
  return `${prefix}_${suffix}`;
}

function roleProviderConfig(config, role) {
  return asObject(asObject(config).role_providers?.[role]);
}

function qualityProviderConfig(config, quality) {
  const cfg = asObject(config);
  return asObject(cfg.role_provider_defaults?.[quality] || cfg.provider_defaults?.[quality]);
}

function providerKind(...providers) {
  for (const provider of providers) {
    const kind = cleanString(provider?.kind);
    if (kind) return kind;
  }
  return "openai_compatible";
}

function resolveCostConfig(config, provider, model) {
  const costConfig = asObject(config?.cost_estimates || provider?.cost_estimates);
  const rates = asObject(costConfig.rates_per_million_tokens || costConfig.rates || {});
  const direct = asObject(rates[model]);
  const lower = Object.entries(rates).find(([key]) => key.toLowerCase() === String(model || "").toLowerCase());
  const matched = Object.keys(direct).length > 0 ? direct : asObject(lower?.[1]);
  return {
    currency: cleanString(costConfig.currency) || "USD",
    rate_source: cleanString(costConfig.source) || "configured_estimate",
    input_per_million: asNumber(matched.input ?? matched.prompt ?? matched.input_per_million),
    output_per_million: asNumber(matched.output ?? matched.completion ?? matched.output_per_million),
  };
}

export function resolveRoleProvider({ role, config = {}, env = process.env } = {}) {
  if (!ROLE_IDS.includes(role)) {
    throw Object.assign(new Error(`Unknown role provider role: ${role}`), {
      code: "role_provider_unknown_role",
      role,
      allowed_roles: [...ROLE_IDS],
    });
  }

  const cfg = asObject(config);
  const defaults = ROLE_DEFAULTS[role];
  const roleCfg = roleProviderConfig(cfg, role);
  const quality = pickFirst(roleCfg.quality, defaults.quality);
  const qualityCfg = qualityProviderConfig(cfg, quality);
  const legacy = asObject(cfg.provider);

  const envPrefix = pickFirst(roleCfg.env_prefix, qualityCfg.env_prefix, defaults.env_prefix);
  const apiKeyEnv = pickFirst(roleCfg.api_key_env, qualityCfg.api_key_env, legacy.api_key_env, defaultEnv(envPrefix, "API_KEY"));
  const modelEnv = pickFirst(roleCfg.model_env, qualityCfg.model_env, legacy.model_env, defaultEnv(envPrefix, "MODEL"));
  const baseUrlEnv = pickFirst(roleCfg.base_url_env, qualityCfg.base_url_env, legacy.base_url_env, defaultEnv(envPrefix, "BASE_URL"));
  const mockResponseEnv = pickFirst(roleCfg.mock_response_env, qualityCfg.mock_response_env, legacy.mock_response_env, defaultEnv(envPrefix, "MOCK_RESPONSE"));
  const mockErrorEnv = pickFirst(roleCfg.mock_error_env, qualityCfg.mock_error_env, legacy.mock_error_env, defaultEnv(envPrefix, "MOCK_ERROR"));

  const apiKey = cleanString(env[apiKeyEnv]);
  const model = pickFirst(env[modelEnv], roleCfg.default_model, roleCfg.model, qualityCfg.default_model, qualityCfg.model, defaults.default_model, legacy.default_model, legacy.model);
  const baseUrl = pickFirst(env[baseUrlEnv], roleCfg.default_base_url, roleCfg.base_url, qualityCfg.default_base_url, qualityCfg.base_url, legacy.default_base_url, legacy.base_url, defaults.default_base_url);
  const timeoutMs = asNumber(roleCfg.timeout_ms, asNumber(qualityCfg.timeout_ms, asNumber(legacy.timeout_ms, 20000)));
  const missing = [];
  if (!apiKey && !cleanString(env[mockResponseEnv]) && !cleanString(env[mockErrorEnv])) missing.push(apiKeyEnv);
  if (!model) missing.push(modelEnv || `role_providers.${role}.default_model`);
  if (!baseUrl) missing.push(baseUrlEnv || `role_providers.${role}.default_base_url`);
  const cost = resolveCostConfig(cfg, roleCfg, model);

  return {
    schema_version: ROLE_PROVIDER_SCHEMA_VERSION,
    role,
    quality,
    kind: providerKind(roleCfg, qualityCfg, legacy),
    apiKey,
    model,
    baseUrl,
    endpoint: baseUrl ? normalizeChatCompletionsEndpoint(baseUrl) : "",
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000,
    phases: ["role_provider"],
    writeMode: "role_call",
    configured: missing.length === 0,
    missing,
    apiKeyEnv,
    modelEnv,
    baseUrlEnv,
    mockResponseEnv,
    mockErrorEnv,
    mockResponse: cleanString(env[mockResponseEnv]),
    mockError: cleanString(env[mockErrorEnv]),
    cost_estimate: cost,
  };
}

export function publicRoleProviderConfig(provider) {
  return {
    schema_version: ROLE_PROVIDER_SCHEMA_VERSION,
    role: provider?.role || null,
    quality: provider?.quality || null,
    kind: provider?.kind || null,
    configured: !!provider?.configured,
    model: provider?.model || null,
    base_url: provider?.baseUrl || null,
    endpoint: provider?.endpoint || null,
    timeout_ms: provider?.timeoutMs || null,
    api_key_env: provider?.apiKeyEnv || null,
    model_env: provider?.modelEnv || null,
    base_url_env: provider?.baseUrlEnv || null,
    mock_response_env: provider?.mockResponseEnv || null,
    mock_error_env: provider?.mockErrorEnv || null,
    missing: Array.isArray(provider?.missing) ? provider.missing : [],
    cost_estimate: {
      currency: provider?.cost_estimate?.currency || "USD",
      rate_source: provider?.cost_estimate?.rate_source || "configured_estimate",
      has_rate: Number.isFinite(provider?.cost_estimate?.input_per_million) &&
        Number.isFinite(provider?.cost_estimate?.output_per_million),
    },
  };
}

export function estimateTokensFromText(text) {
  const chars = String(text || "").length;
  return chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0;
}

function estimateMessagesTokens(messages) {
  return estimateTokensFromText(JSON.stringify(messages || []));
}

function usageForCall(providerUsage, messages, responseText) {
  const usage = normalizeOpenAiUsage(providerUsage);
  if (usage) return { ...usage, token_source: "provider" };
  const promptTokens = estimateMessagesTokens(messages);
  const completionTokens = estimateTokensFromText(responseText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    token_source: "estimated",
  };
}

function estimateCost(provider, usage) {
  const cost = provider?.cost_estimate || {};
  const inputRate = asNumber(cost.input_per_million);
  const outputRate = asNumber(cost.output_per_million);
  const currency = cleanString(cost.currency) || "USD";
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) {
    return {
      estimate_status: "missing_rate",
      currency,
      cost_estimate_usd: null,
      rate_source: cleanString(cost.rate_source) || "configured_estimate",
    };
  }
  const inputCost = (Number(usage.prompt_tokens || 0) / 1_000_000) * inputRate;
  const outputCost = (Number(usage.completion_tokens || 0) / 1_000_000) * outputRate;
  return {
    estimate_status: "estimated",
    currency,
    cost_estimate_usd: Number((inputCost + outputCost).toFixed(8)),
    rate_source: cleanString(cost.rate_source) || "configured_estimate",
  };
}

function emptyTotals() {
  return {
    call_count: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    total_latency_ms: 0,
    cost_estimate_usd: 0,
  };
}

export class CostLedger {
  constructor({ taskId = "role_provider_task", currency = "USD" } = {}) {
    this.taskId = cleanString(taskId) || "role_provider_task";
    this.currency = cleanString(currency) || "USD";
    this.calls = [];
  }

  recordCall(call = {}) {
    const usage = usageForCall(call.usage, call.messages, call.responseText);
    const provider = call.provider || {};
    const cost = estimateCost(provider, usage);
    const entry = {
      role: cleanString(call.role || provider.role) || "unknown",
      quality: cleanString(provider.quality) || null,
      model: cleanString(provider.model) || null,
      source: cleanString(call.source) || "provider",
      status: canonicalVerificationStatus(call.status, "execution", { fallback: "unknown" }),
      latency_ms: Math.max(0, Math.round(asNumber(call.latencyMs, 0) || 0)),
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      token_source: usage.token_source,
      estimate_status: cost.estimate_status,
      cost_estimate_usd: cost.cost_estimate_usd,
      currency: cost.currency,
      rate_source: cost.rate_source,
    };
    this.calls.push(entry);
    return entry;
  }

  summary() {
    const totals = emptyTotals();
    const byRole = new Map();
    let estimateStatus = "not_applicable";
    for (const call of this.calls) {
      totals.call_count += 1;
      totals.prompt_tokens += Number(call.prompt_tokens || 0);
      totals.completion_tokens += Number(call.completion_tokens || 0);
      totals.total_tokens += Number(call.total_tokens || 0);
      totals.total_latency_ms += Number(call.latency_ms || 0);
      if (call.estimate_status === "missing_rate") estimateStatus = "missing_rate";
      else if (estimateStatus !== "missing_rate") estimateStatus = "estimated";
      if (Number.isFinite(call.cost_estimate_usd)) totals.cost_estimate_usd += call.cost_estimate_usd;

      const role = call.role || "unknown";
      const roleTotals = byRole.get(role) || emptyTotals();
      roleTotals.call_count += 1;
      roleTotals.prompt_tokens += Number(call.prompt_tokens || 0);
      roleTotals.completion_tokens += Number(call.completion_tokens || 0);
      roleTotals.total_tokens += Number(call.total_tokens || 0);
      roleTotals.total_latency_ms += Number(call.latency_ms || 0);
      if (Number.isFinite(call.cost_estimate_usd)) roleTotals.cost_estimate_usd += call.cost_estimate_usd;
      byRole.set(role, roleTotals);
    }
    return {
      schema_version: ROLE_PROVIDER_SCHEMA_VERSION,
      task_id: this.taskId,
      call_count: totals.call_count,
      estimate_status: estimateStatus,
      currency: this.currency,
      prompt_tokens: totals.prompt_tokens,
      completion_tokens: totals.completion_tokens,
      total_tokens: totals.total_tokens,
      total_latency_ms: totals.total_latency_ms,
      cost_estimate_usd: Number(totals.cost_estimate_usd.toFixed(8)),
      by_role: Object.fromEntries([...byRole.entries()].map(([role, value]) => [
        role,
        {
          ...value,
          cost_estimate_usd: Number(value.cost_estimate_usd.toFixed(8)),
        },
      ])),
      calls: [...this.calls],
    };
  }
}

export function createCostLedger(options = {}) {
  return new CostLedger(options);
}

function providerUnavailable(provider) {
  return Object.assign(new Error(`Provider unavailable for role ${provider?.role || "unknown"}: ${(provider?.missing || []).join(", ") || "not configured"}`), {
    code: "provider_unavailable",
    provider: publicRoleProviderConfig(provider),
  });
}

export async function callRoleProviderJson({
  role,
  config = {},
  messages = [],
  ledger = null,
  taskId = "role_provider_task",
  temperature = 0,
  maxTokens = 1200,
  telemetry = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const provider = resolveRoleProvider({ role, config, env });
  const hasMockPath = !!provider.mockResponse || !!provider.mockError;
  if (!provider.configured && !hasMockPath) {
    throw providerUnavailable(provider);
  }

  const costLedger = ledger || createCostLedger({
    taskId,
    currency: provider.cost_estimate?.currency || "USD",
  });
  const started = Date.now();
  try {
    const response = await callOpenAiCompatibleJson({
      config: provider,
      messages,
      temperature,
      maxTokens,
      env,
      fetchImpl,
    });
    const responseText = response.raw_excerpt || JSON.stringify(response.parsed || {});
    const call = costLedger.recordCall({
      role,
      provider,
      source: response.source || "provider",
      latencyMs: Date.now() - started,
      usage: response.usage,
      messages,
      responseText,
      status: "pass",
    });
    let llmRunTelemetry = { written: false, reason: "not_attempted" };
    if (telemetry !== false) {
      try {
        llmRunTelemetry = recordLlmRunTelemetry({
          cwd: telemetry?.cwd || process.cwd(),
          planDir: telemetry?.planDir || null,
          planDirName: telemetry?.planDirName || null,
          planId: telemetry?.planId || null,
          phase: telemetry?.phase || null,
          actor: { kind: "role_provider", id: role, role },
          role,
          source: "role_provider",
          eventType: "completion",
          provider: publicRoleProviderConfig(provider),
          model: provider.model,
          messages,
          responseText,
          responseObject: response.parsed,
          usage: response.usage,
          costCall: call,
          costLedger: costLedger.summary(),
          personaPacks: telemetry?.personaPacks || [],
          toolRefs: telemetry?.toolRefs || [],
          advisoryArtifacts: telemetry?.advisoryArtifacts || [],
          artifacts: telemetry?.artifacts || [],
          captureStatus: telemetry?.captureStatus || null,
          metadata: {
            task_id: taskId,
            source: response.source || "provider",
            finish_reason: response.finish_reason || null,
            repaired_json: response.repaired_json === true,
            ...(telemetry?.metadata || {}),
          },
          env,
          telemetryConfig: telemetry?.config || null,
        });
      } catch (telemetryError) {
        llmRunTelemetry = {
          written: false,
          reason: "telemetry_error",
          error: redactSecrets(telemetryError?.message || "llm run telemetry error", env),
        };
      }
    }
    return {
      ...response,
      role,
      provider: publicRoleProviderConfig(provider),
      cost_call: call,
      cost_ledger: costLedger.summary(),
      llm_run_telemetry: llmRunTelemetry,
    };
  } catch (error) {
    if (error?.code === "unavailable") {
      throw providerUnavailable(provider);
    }
    error.message = redactSecrets(error?.message || "role provider error", env);
    error.provider = publicRoleProviderConfig(provider);
    throw error;
  }
}
