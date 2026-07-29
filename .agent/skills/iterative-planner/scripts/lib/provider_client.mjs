// provider_client.mjs — OpenAI-compatible provider helpers.

const DEFAULT_TIMEOUT_MS = 20_000;
const JSON_REPAIR_MAX_TOKENS = 1000;

export function normalizeChatCompletionsEndpoint(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function normalizeOpenAiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.outputTokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? (promptTokens + completionTokens));
  return {
    prompt_tokens: Number.isFinite(promptTokens) && promptTokens >= 0 ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) && completionTokens >= 0 ? completionTokens : 0,
    total_tokens: Number.isFinite(totalTokens) && totalTokens >= 0 ? totalTokens : 0,
  };
}

function mergeOpenAiUsage(...items) {
  const normalized = items.map(normalizeOpenAiUsage).filter(Boolean);
  if (normalized.length === 0) return null;
  return normalized.reduce((acc, item) => ({
    prompt_tokens: acc.prompt_tokens + item.prompt_tokens,
    completion_tokens: acc.completion_tokens + item.completion_tokens,
    total_tokens: acc.total_tokens + item.total_tokens,
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
}

export function redactSecrets(value, env = process.env) {
  const envSecrets = Object.entries(env || {})
    .filter(([key, secret]) => /(API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) && typeof secret === "string" && secret.length >= 6)
    .map(([, secret]) => secret);

  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of envSecrets) {
    text = text.split(secret).join("[REDACTED]");
  }
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_API_KEY]");
  text = text.replace(/\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, "[REDACTED_STRIPE_KEY]");
  text = text.replace(/\bpk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, "[REDACTED_STRIPE_KEY]");
  text = text.replace(/\bghp_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bgho_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bghu_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bghs_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bghr_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_GITLAB_TOKEN]");
  text = text.replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]");
  text = text.replace(/\b(?:xoxb|xoxp|xoxa|xoxr|xapp)-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]");
  text = text.replace(/\bshpat_[A-Za-z0-9]{30,}\b/g, "[REDACTED_SHOPIFY_TOKEN]");
  text = text.replace(/\bshpca_[A-Za-z0-9]{30,}\b/g, "[REDACTED_SHOPIFY_TOKEN]");
  text = text.replace(/\bshppa_[A-Za-z0-9]{30,}\b/g, "[REDACTED_SHOPIFY_TOKEN]");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
  return text;
}

export function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Provider response was empty");

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Provider response was not valid JSON");
  }
}

export function loadSupervisorProviderConfig(env = process.env) {
  const apiKey = env.PLANNER_SUPERVISOR_API_KEY || "";
  const model = env.PLANNER_SUPERVISOR_MODEL || "gpt-4.1-mini";
  const baseUrl = env.PLANNER_SUPERVISOR_BASE_URL || "https://api.openai.com/v1";
  const timeoutRaw = Number.parseInt(env.PLANNER_SUPERVISOR_TIMEOUT_MS || "", 10);
  const missing = [];
  if (!apiKey && !env.PLANNER_SUPERVISOR_MOCK_RESPONSE && !env.PLANNER_SUPERVISOR_MOCK_ERROR) {
    missing.push("PLANNER_SUPERVISOR_API_KEY");
  }
  if (!model) missing.push("PLANNER_SUPERVISOR_MODEL");
  if (!baseUrl) missing.push("PLANNER_SUPERVISOR_BASE_URL");
  return {
    apiKey,
    model,
    baseUrl,
    endpoint: baseUrl ? normalizeChatCompletionsEndpoint(baseUrl) : "",
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
    configured: missing.length === 0,
    missing,
    mockResponse: env.PLANNER_SUPERVISOR_MOCK_RESPONSE || "",
    mockError: env.PLANNER_SUPERVISOR_MOCK_ERROR || "",
  };
}

export async function callOpenAiCompatibleJson({ config, messages, temperature = 0, maxTokens = 1200, env = process.env, fetchImpl = globalThis.fetch }) {
  if (config?.mockError === "timeout") {
    throw Object.assign(new Error("Mock timeout"), { code: "timeout" });
  }
  if (config?.mockError === "http_error") {
    throw Object.assign(new Error("Mock HTTP error"), { code: "http_error", status: 502 });
  }
  if (config?.mockResponse) {
    const parsed = extractJsonObject(config.mockResponse);
    return {
      parsed,
      raw_excerpt: redactSecrets(config.mockResponse.slice(0, 2000), env),
      source: "mock",
      usage: normalizeOpenAiUsage(parsed?.usage),
    };
  }
  if (!config?.configured) {
    throw Object.assign(new Error(`Provider config missing: ${(config?.missing || []).join(", ")}`), { code: "unavailable" });
  }
  if (typeof fetchImpl !== "function") {
    throw Object.assign(new Error("fetch is unavailable in this Node runtime"), { code: "unavailable" });
  }

  const requestCompletion = async (requestMessages, requestMaxTokens = maxTokens) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: requestMessages,
          temperature,
          max_tokens: requestMaxTokens,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw Object.assign(new Error(`Provider HTTP ${response.status}: ${redactSecrets(bodyText.slice(0, 500), env)}`), {
          code: "http_error",
          status: response.status,
        });
      }
      const body = extractJsonObject(bodyText);
      const choice = body?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Provider response missing choices[0].message.content");
      }
      return {
        content,
        finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
        usage: normalizeOpenAiUsage(body?.usage),
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw Object.assign(new Error(`Provider timed out after ${config.timeoutMs}ms`), { code: "timeout" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await requestCompletion(messages, maxTokens);
  try {
    return {
      parsed: extractJsonObject(first.content),
      raw_excerpt: redactSecrets(first.content.slice(0, 2000), env),
      source: "provider",
      finish_reason: first.finish_reason,
      usage: first.usage,
    };
  } catch (firstError) {
    const repairMessages = [
      {
        role: "system",
        content: [
          "You repair invalid JSON for a planner provider response.",
          "Return exactly one valid JSON object and nothing else.",
          "Use only double-quoted strings, include commas between every array item and object property, and keep arrays short.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          parse_error: firstError?.message || "invalid JSON",
          finish_reason: first.finish_reason,
          invalid_json_excerpt: first.content.slice(0, 6000),
        }),
      },
    ];
    const repaired = await requestCompletion(repairMessages, Math.min(Math.max(maxTokens, JSON_REPAIR_MAX_TOKENS), 1600));
    try {
      return {
        parsed: extractJsonObject(repaired.content),
        raw_excerpt: redactSecrets(repaired.content.slice(0, 2000), env),
        source: "provider",
        finish_reason: repaired.finish_reason,
        repaired_json: true,
        usage: mergeOpenAiUsage(first.usage, repaired.usage),
      };
    } catch (repairError) {
      throw new Error(`Provider returned invalid JSON (${firstError?.message || "parse failed"}); repair retry failed (${repairError?.message || "parse failed"})`);
    }
  }
}
