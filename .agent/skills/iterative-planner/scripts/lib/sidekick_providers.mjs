import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseSimpleYaml } from "./plan_utils.mjs";

export const SIDEKICK_CONFIG_RELATIVE_PATH = join(".agent", "sidekick.config.yaml");
export const SIDEKICK_CONFIG_EXAMPLE_RELATIVE_PATH = join(".agent", "sidekick.config.example.yaml");

export function missingConfigMessage() {
  return [
    "Sidekick not configured. Run `planner sidekick init` to set up.",
    "Or add .agent/sidekick.config.yaml manually — see .agent/sidekick.config.example.yaml.",
  ].join("\n");
}

function normalizeProviderConfig(raw) {
  const provider = raw?.provider || raw?.default_provider || "ollama";
  const providers = raw?.providers && typeof raw.providers === "object" ? raw.providers : {};
  const selected = providers[provider] && typeof providers[provider] === "object" ? providers[provider] : {};
  return {
    provider,
    type: selected.type || raw?.type || provider,
    host: selected.host || raw?.host || "http://127.0.0.1:11434",
    endpoint: selected.endpoint || raw?.endpoint || "",
    model: selected.model || raw?.model || "",
    api_key_env: selected.api_key_env || raw?.api_key_env || "",
    timeout_ms: Number(selected.timeout_ms || raw?.timeout_ms || 15000),
    mock_response: selected.mock_response || raw?.mock_response || "",
  };
}

function parseSidekickYaml(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  const simple = parseSimpleYaml(trimmed);
  const config = {};
  for (const key of ["provider", "default_provider", "type", "host", "endpoint", "model", "api_key_env", "timeout_ms", "mock_response"]) {
    if (simple[key] !== undefined) config[key] = simple[key];
  }

  let inProviders = false;
  let currentProvider = null;
  const providers = {};
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^providers:\s*$/.test(line)) {
      inProviders = true;
      currentProvider = null;
      continue;
    }
    const rootValueMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (!inProviders && rootValueMatch) {
      let value = rootValueMatch[2].replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
      if (/^\d+$/.test(value)) value = Number(value);
      config[rootValueMatch[1]] = value;
      continue;
    }
    if (!inProviders) continue;
    const providerMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (providerMatch) {
      currentProvider = providerMatch[1];
      providers[currentProvider] = {};
      continue;
    }
    const valueMatch = line.match(/^    ([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (valueMatch && currentProvider) {
      let value = valueMatch[2].replace(/^["']|["']$/g, "");
      value = value.replace(/\\n/g, "\n");
      if (/^\d+$/.test(value)) value = Number(value);
      providers[currentProvider][valueMatch[1]] = value;
    }
  }
  if (Object.keys(providers).length > 0) config.providers = providers;
  return config;
}

export function readSidekickConfig(cwd = process.cwd(), configPath = SIDEKICK_CONFIG_RELATIVE_PATH) {
  const path = join(cwd, configPath);
  if (!existsSync(path)) return { ok: false, reason: "missing_config", path };
  try {
    return { ok: true, path, config: normalizeProviderConfig(parseSidekickYaml(readFileSync(path, "utf-8"))) };
  } catch (error) {
    return { ok: false, reason: "invalid_config", path, error: error.message };
  }
}

export async function callSidekickProvider(config, prompt) {
  if (config.type === "mock") {
    return { ok: true, text: config.mock_response || "chore(sidekick): generate commit message\n\nWhy\n- Test fixture\n\nWhat\n- Return deterministic output\n\nProof\n- Sidekick mock provider" };
  }

  if (config.type === "ollama") {
    const endpoint = `${String(config.host || "").replace(/\/+$/, "")}/api/generate`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, prompt, stream: false }),
      signal: AbortSignal.timeout(config.timeout_ms),
    });
    if (!response.ok) throw new Error(`ollama_http_${response.status}`);
    const body = await response.json();
    return { ok: true, text: String(body.response || "") };
  }

  if (config.type === "openai_compatible") {
    const apiKey = config.api_key_env ? process.env[config.api_key_env] : "";
    if (!apiKey) throw new Error(`missing_api_key_env:${config.api_key_env || "unset"}`);
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(config.timeout_ms),
    });
    if (!response.ok) throw new Error(`openai_compatible_http_${response.status}`);
    const body = await response.json();
    return { ok: true, text: String(body.choices?.[0]?.message?.content || "") };
  }

  throw new Error(`unsupported_provider_type:${config.type}`);
}
