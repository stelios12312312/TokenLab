// semantic_hygiene.mjs - Source/config discovery for planner ontology hygiene.

import { execFileSync } from "child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join, relative } from "path";

import { sanitizeEnumAtom, sanitizeStrictId } from "./sanitize.mjs";

export const DEFAULT_SOURCE_HYGIENE_CONFIG = Object.freeze({
  version: 1,
  source_extensions: [
    ".cjs", ".css", ".go", ".html", ".java", ".js", ".jsx", ".kt", ".mjs",
    ".php", ".py", ".rb", ".rs", ".sh", ".svelte", ".swift", ".ts", ".tsx",
    ".vue",
  ],
  skip_dirs: [
    ".cache", ".git", ".next", ".nuxt", ".turbo", ".venv", "__pycache__", "build",
    "coverage", "dist", "node_modules", "out", "reports", "tmp", "venv", "vendor",
  ],
  skip_path_prefixes: ["plans/", "apps/ive-visualizer/public/"],
  ignored_files: [],
  ignored_globs: [
    "apps/ive-visualizer/src/data/packInspector.generated.js",
    "docs/ive-redesign/examples/**",
    "docs/ive-redesign/overview.html",
    "scratch/**",
  ],
  ignore_header_markers: ["@planner:disabled", "@planner:ignore"],
  config_file_patterns: [
    ".env", ".env.example", ".env.sample", ".env.template", ".env.defaults",
    ".env.dist", "*.env.example", "*.env.sample", "*.env.template",
    "*.config.json", "*.config.example.json", "*.config.template.json",
    "config.json", "config.example.json", "config.template.json",
  ],
  config_skip_patterns: [".env.local", "*.local", "*.local.*"],
  json_property_keys: ["auto_committee", "fail_on", "role_options", "roles"],
  json_env_value_key_suffixes: ["_env", "Env"],
});

const MAX_HEADER_BYTES = 4096;
const MAX_CONFIG_BYTES = 512_000;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UPPER_ENV_KEY_RE = /^[A-Z][A-Z0-9_]{2,}$/;
const GIT_ROUTING_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
];

function arrayValue(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim()) : [];
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function normalizeExtension(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  return text.startsWith(".") ? text : `.${text}`;
}

function mergeConfig(raw = {}) {
  const configuredSourceExtensions = arrayValue(raw.source_extensions || raw.sourceExtensions).map(normalizeExtension).filter(Boolean);
  return {
    ...DEFAULT_SOURCE_HYGIENE_CONFIG,
    ...raw,
    source_extensions: configuredSourceExtensions.length > 0
      ? configuredSourceExtensions
      : DEFAULT_SOURCE_HYGIENE_CONFIG.source_extensions,
    skip_dirs: arrayValue(raw.skip_dirs || raw.skipDirs).length > 0
      ? arrayValue(raw.skip_dirs || raw.skipDirs)
      : DEFAULT_SOURCE_HYGIENE_CONFIG.skip_dirs,
    skip_path_prefixes: arrayValue(raw.skip_path_prefixes || raw.skipPathPrefixes).length > 0
      ? arrayValue(raw.skip_path_prefixes || raw.skipPathPrefixes)
      : DEFAULT_SOURCE_HYGIENE_CONFIG.skip_path_prefixes,
    ignored_files: arrayValue(raw.ignored_files || raw.ignoredFiles),
    ignored_globs: arrayValue(raw.ignored_globs || raw.ignoredGlobs),
    ignore_header_markers: arrayValue(raw.ignore_header_markers || raw.ignoreHeaderMarkers).length > 0
      ? arrayValue(raw.ignore_header_markers || raw.ignoreHeaderMarkers)
      : DEFAULT_SOURCE_HYGIENE_CONFIG.ignore_header_markers,
    config_file_patterns: arrayValue(raw.config_file_patterns || raw.configFilePatterns).length > 0
      ? arrayValue(raw.config_file_patterns || raw.configFilePatterns)
      : DEFAULT_SOURCE_HYGIENE_CONFIG.config_file_patterns,
    config_skip_patterns: arrayValue(raw.config_skip_patterns || raw.configSkipPatterns).length > 0
      ? arrayValue(raw.config_skip_patterns || raw.configSkipPatterns)
      : DEFAULT_SOURCE_HYGIENE_CONFIG.config_skip_patterns,
    json_property_keys: arrayValue(raw.json_property_keys || raw.jsonPropertyKeys).length > 0
      ? arrayValue(raw.json_property_keys || raw.jsonPropertyKeys)
      : DEFAULT_SOURCE_HYGIENE_CONFIG.json_property_keys,
    json_env_value_key_suffixes: arrayValue(raw.json_env_value_key_suffixes || raw.jsonEnvValueKeySuffixes).length > 0
      ? arrayValue(raw.json_env_value_key_suffixes || raw.jsonEnvValueKeySuffixes)
      : DEFAULT_SOURCE_HYGIENE_CONFIG.json_env_value_key_suffixes,
  };
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (st.size > MAX_CONFIG_BYTES) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function loadSemanticHygieneConfig(cwd = process.cwd(), { configPath = null } = {}) {
  const path = configPath || join(cwd, ".agent", "skills", "iterative-planner", "config", "source_hygiene.json");
  const raw = readJsonFile(path);
  const config = mergeConfig(raw && typeof raw === "object" ? raw : {});
  const env = { ...process.env };
  for (const key of GIT_ROUTING_ENV_KEYS) delete env[key];
  try {
    execFileSync("git", ["-C", cwd, "check-ignore", "-q", "--", ".agent"], {
      env,
      stdio: "ignore",
    });
    config.skip_path_prefixes = [...new Set([...config.skip_path_prefixes, ".agent/"])];
  } catch {
    // The planner source repository tracks .agent; non-Git workspaces and
    // ordinary unignored source trees retain the configured discovery rules.
  }
  return config;
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === "*" && next === "*") {
      out += ".*";
      i++;
    } else if (char === "*") {
      out += "[^/]*";
    } else if ("\\^$+?.()|{}[]".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  out += "$";
  return new RegExp(out);
}

function matchesPattern(relPath, pattern) {
  const normalized = normalizePath(relPath);
  const base = basename(normalized);
  const normalizedPattern = normalizePath(pattern);
  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalized) || regex.test(base);
}

function pathStartsWith(relPath, prefix) {
  const normalized = normalizePath(relPath);
  const normalizedPrefix = normalizePath(prefix).replace(/\/?$/, "/");
  return normalized.startsWith(normalizedPrefix);
}

function isSkipped(relPath, config) {
  const normalized = normalizePath(relPath);
  const parts = normalized.split("/");
  const skipDirs = new Set(config.skip_dirs || []);
  if (parts.some((part) => skipDirs.has(part))) return true;
  if ((config.skip_path_prefixes || []).some((prefix) => pathStartsWith(normalized, prefix))) return true;
  return false;
}

function isSourceFile(relPath, config) {
  const extension = extname(relPath).toLowerCase();
  return new Set(config.source_extensions || []).has(extension);
}

function headerIgnoreReason(filePath, config) {
  try {
    const fdContent = readFileSync(filePath, { encoding: "utf-8", flag: "r" }).slice(0, MAX_HEADER_BYTES);
    const marker = (config.ignore_header_markers || []).find((entry) => fdContent.includes(entry));
    return marker ? `header:${marker}` : null;
  } catch {
    return null;
  }
}

function registryIgnoreReason(relPath, config) {
  const normalized = normalizePath(relPath);
  if ((config.ignored_files || []).map(normalizePath).includes(normalized)) return "registry:file";
  if ((config.ignored_globs || []).some((pattern) => matchesPattern(normalized, pattern))) return "registry:glob";
  return null;
}

function walkFiles(cwd, config) {
  const files = [];

  function walk(absDir, relDir = "") {
    let entries = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = normalizePath(relDir ? `${relDir}/${entry.name}` : entry.name);
      if (isSkipped(relPath, config)) continue;
      const absPath = join(cwd, relPath);
      let st = null;
      try {
        st = lstatSync(absPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  walk(cwd);
  return files.sort();
}

export function discoverSourceFiles(cwd = process.cwd(), { config = null } = {}) {
  const effectiveConfig = config ? mergeConfig(config) : loadSemanticHygieneConfig(cwd);
  const discovered = [];
  const ignored = [];

  for (const relPath of walkFiles(cwd, effectiveConfig)) {
    if (!isSourceFile(relPath, effectiveConfig)) continue;
    const absPath = join(cwd, relPath);
    const ignoreReason = registryIgnoreReason(relPath, effectiveConfig) || headerIgnoreReason(absPath, effectiveConfig);
    const entry = {
      path: relPath,
      ignored: Boolean(ignoreReason),
      ignore_reason: ignoreReason,
    };
    discovered.push(entry);
    if (entry.ignored) ignored.push(entry);
  }

  return {
    files: discovered.sort((a, b) => a.path.localeCompare(b.path)),
    ignored: ignored.sort((a, b) => a.path.localeCompare(b.path)),
    config: effectiveConfig,
  };
}

function normalizeConfigKey(value) {
  const clean = String(value || "")
    .trim()
    .replace(/[`'"]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return clean || null;
}

function addConfigKey(map, rawKey, source, sourceKind) {
  const key = normalizeConfigKey(rawKey);
  if (!key) return;
  if (!map.has(key)) {
    map.set(key, {
      key,
      raw_keys: new Set(),
      sources: new Set(),
      source_kinds: new Set(),
    });
  }
  const entry = map.get(key);
  entry.raw_keys.add(String(rawKey));
  entry.sources.add(source);
  entry.source_kinds.add(sourceKind);
}

function isEnvFile(relPath, config) {
  const base = basename(relPath);
  if ((config.config_skip_patterns || []).some((pattern) => matchesPattern(relPath, pattern))) return false;
  return (config.config_file_patterns || []).some((pattern) => matchesPattern(base, pattern)) &&
    (base === ".env" || base.startsWith(".env.") || base.endsWith(".env") || base.includes(".env."));
}

function isJsonConfigFile(relPath, config) {
  const base = basename(relPath);
  if (!base.endsWith(".json")) return false;
  if ((config.config_skip_patterns || []).some((pattern) => matchesPattern(relPath, pattern))) return false;
  return (config.config_file_patterns || []).some((pattern) => matchesPattern(relPath, pattern));
}

function parseEnvFile(content, relPath, out) {
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) continue;
    if (ENV_KEY_RE.test(match[1])) addConfigKey(out, match[1], relPath, "env_template");
  }
}

function jsonKeyMatchesConfiguredKey(key, config) {
  const normalized = normalizeConfigKey(key);
  const allowed = new Set((config.json_property_keys || []).map(normalizeConfigKey).filter(Boolean));
  return allowed.has(normalized);
}

function jsonKeyHasEnvSuffix(key, config) {
  return (config.json_env_value_key_suffixes || []).some((suffix) => String(key || "").endsWith(suffix));
}

function parseJsonConfig(value, relPath, out, config) {
  function visit(node) {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node)) {
      if (UPPER_ENV_KEY_RE.test(key) || jsonKeyMatchesConfiguredKey(key, config)) {
        addConfigKey(out, key, relPath, "json_key");
      }
      if (typeof child === "string" && jsonKeyHasEnvSuffix(key, config) && UPPER_ENV_KEY_RE.test(child)) {
        addConfigKey(out, child, relPath, "json_env_value");
      }
      visit(child);
    }
  }

  visit(value);
}

export function discoverConfigKeys(cwd = process.cwd(), { config = null } = {}) {
  const effectiveConfig = config ? mergeConfig(config) : loadSemanticHygieneConfig(cwd);
  const byKey = new Map();

  for (const relPath of walkFiles(cwd, effectiveConfig)) {
    const absPath = join(cwd, relPath);
    let st = null;
    try {
      st = statSync(absPath);
    } catch {
      continue;
    }
    if (st.size > MAX_CONFIG_BYTES) continue;

    if (isEnvFile(relPath, effectiveConfig)) {
      try {
        parseEnvFile(readFileSync(absPath, "utf-8"), relPath, byKey);
      } catch {
        // Best effort: an unreadable config file should not abort invariant loading.
      }
    } else if (isJsonConfigFile(relPath, effectiveConfig)) {
      const parsed = readJsonFile(absPath);
      if (parsed) parseJsonConfig(parsed, relPath, byKey, effectiveConfig);
    }
  }

  const keys = [...byKey.values()].map((entry) => ({
    key: entry.key,
    raw_keys: [...entry.raw_keys].sort(),
    sources: [...entry.sources].sort(),
    source_kinds: [...entry.source_kinds].sort(),
  })).sort((a, b) => a.key.localeCompare(b.key));

  return { keys, config: effectiveConfig };
}

export function loadSemanticHygieneFacts(session, { cwd = process.cwd(), config = null } = {}) {
  const sourceDiscovery = discoverSourceFiles(cwd, { config });
  const configDiscovery = discoverConfigKeys(cwd, { config: sourceDiscovery.config });

  for (const entry of sourceDiscovery.files) {
    session.consult(`source_file(${sanitizeStrictId(entry.path)}).`);
    if (entry.ignored) {
      session.consult(`file_marked_ignored(${sanitizeStrictId(entry.path)}).`);
      if (entry.ignore_reason) {
        session.consult(`file_ignore_reason(${sanitizeStrictId(entry.path)}, ${sanitizeEnumAtom(entry.ignore_reason)}).`);
      }
    }
  }

  for (const entry of configDiscovery.keys) {
    session.consult(`config_key(${sanitizeEnumAtom(entry.key)}).`);
    for (const source of entry.sources || []) {
      session.consult(`config_key_source(${sanitizeEnumAtom(entry.key)}, ${sanitizeStrictId(source)}).`);
    }
  }

  return {
    sources: sourceDiscovery.files,
    ignored: sourceDiscovery.ignored,
    config_keys: configDiscovery.keys,
  };
}
