import { existsSync, readFileSync, writeFileSync } from "fs";
import { extname, join } from "path";

export const POLICY_FILE_NAMES = Object.freeze([
  "planner.policy.yaml",
  "planner.policy.yml",
  "planner.policy.json",
]);

export const DEFAULT_PLANNER_POLICY = Object.freeze({
  version: 1,
  shape: null,
  domain: null,
  default_route: "auto",
  verification: Object.freeze({
    compact_by_default: true,
  }),
  story_registry: Object.freeze({
    enforced_for: Object.freeze(["code", "integration", "quant", "security"]),
  }),
  persona: Object.freeze({
    ambient: true,
    surface_on_session_start: true,
  }),
  ive: Object.freeze({
    ambient: true,
    surface_on_session_start: true,
  }),
  session: Object.freeze({
    kb_reads_required: false,
  }),
  transition_output: "full",
});

const ROUTES = new Set(["auto", "lightweight", "full"]);
const TRANSITION_OUTPUT_MODES = new Set(["minimal", "full"]);
const POLICY_KEY_ORDER = [
  "version",
  "shape",
  "domain",
  "default_route",
  "verification",
  "story_registry",
  "persona",
  "ive",
  "session",
  "transition_output",
];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map((item) => clone(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function normalizePolicyToken(value) {
  if (value === null || value === undefined) return null;
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (!token || ["auto", "default", "none", "null"].includes(token)) return null;
  return token;
}

export function normalizePlannerPolicyShape(value) {
  const token = normalizePolicyToken(value);
  if (!token) return null;
  const aliases = {
    "planner": "planner-core",
    "planner-core": "planner-core",
    "planner-infra": "planner-core",
    "planner-infrastructure": "planner-core",
    "planner-core-repo": "planner-core",
    "scientific-quant": "scientific",
    "quant-research": "scientific",
  };
  return aliases[token] || token;
}

export function normalizePlannerPolicyDomain(value) {
  const token = normalizePolicyToken(value);
  if (!token) return null;
  const aliases = {
    "planner": "planner-core",
    "planner-core": "planner-core",
    "planner-infra": "planner-core",
    "planner-infrastructure": "planner-core",
  };
  return aliases[token] || token;
}

function mergeDefaults(defaults, existing) {
  const merged = clone(defaults);
  if (!isPlainObject(existing)) return merged;
  for (const [key, value] of Object.entries(existing)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeDefaults(merged[key], value);
    } else {
      merged[key] = clone(value);
    }
  }
  return merged;
}

function hasPath(value, pathParts) {
  let cursor = value;
  for (const part of pathParts) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) return false;
    cursor = cursor[part];
  }
  return true;
}

export function missingPlannerPolicyDefaultPaths(policy) {
  const missing = [];

  function visit(defaults, pathParts = []) {
    for (const [key, defaultValue] of Object.entries(defaults)) {
      const next = [...pathParts, key];
      if (!hasPath(policy, next)) {
        missing.push(next.join("."));
        continue;
      }
      if (isPlainObject(defaultValue)) visit(defaultValue, next);
    }
  }

  visit(DEFAULT_PLANNER_POLICY);
  return missing;
}

export function mergePlannerPolicyDefaults(policy = {}) {
  return mergeDefaults(DEFAULT_PLANNER_POLICY, policy);
}

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === "\"" || ch === "'") && line[i - 1] !== "\\") {
      quote = quote === ch ? null : (quote || ch);
      continue;
    }
    if (ch === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

function unquote(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitInlineArray(value) {
  const inner = value.trim().slice(1, -1).trim();
  if (!inner) return [];
  const parts = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if ((ch === "\"" || ch === "'") && inner[i - 1] !== "\\") {
      quote = quote === ch ? null : (quote || ch);
      current += ch;
      continue;
    }
    if (ch === "," && !quote) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((part) => parseYamlScalar(part));
}

function parseYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return splitInlineArray(trimmed);
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return unquote(trimmed);
}

function normalizeYamlLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((raw, index) => {
      const line = stripYamlComment(raw).replace(/\s+$/, "");
      if (!line.trim()) return null;
      const indent = (line.match(/^ */) || [""])[0].length;
      return { index: index + 1, indent, trim: line.trim() };
    })
    .filter(Boolean);
}

function parseSimpleYaml(text) {
  const root = {};
  const lines = normalizeYamlLines(text);
  const stack = [{ indent: -1, container: root }];

  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i];
    if (entry.indent % 2 !== 0) {
      throw new Error(`Unsupported YAML indentation at line ${entry.index}; use multiples of two spaces`);
    }

    while (stack.length > 1 && entry.indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].container;

    if (entry.trim.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`YAML list item at line ${entry.index} has no list parent`);
      }
      parent.push(parseYamlScalar(entry.trim.slice(2)));
      continue;
    }

    const match = entry.trim.match(/^([^:]+):(?:\s*(.*))?$/);
    if (!match) throw new Error(`Unsupported YAML entry at line ${entry.index}`);
    if (Array.isArray(parent)) throw new Error(`YAML mapping at line ${entry.index} has a list parent`);

    const key = match[1].trim();
    const rawValue = match[2] ?? "";
    if (!key) throw new Error(`Missing YAML key at line ${entry.index}`);

    if (rawValue.trim() === "") {
      const next = lines.slice(i + 1).find((candidate) => candidate.indent > entry.indent);
      const child = next?.trim.startsWith("- ") ? [] : {};
      parent[key] = child;
      stack.push({ indent: entry.indent, container: child });
    } else {
      parent[key] = parseYamlScalar(rawValue);
    }
  }

  return root;
}

export function parsePlannerPolicyText(text, policyPath = "planner.policy.yaml") {
  const ext = extname(policyPath).toLowerCase();
  if (ext === ".json") return JSON.parse(String(text || "{}"));
  return parseSimpleYaml(text);
}

export function validatePlannerPolicy(policy) {
  const issues = [];
  if (!isPlainObject(policy)) {
    return { ok: false, issues: ["planner policy must be an object"] };
  }

  if (!Number.isInteger(policy.version) || policy.version < 1) {
    issues.push("version must be an integer >= 1");
  }
  for (const key of ["shape", "domain"]) {
    const value = policy[key];
    if (value !== null && value !== undefined && (typeof value !== "string" || !String(value).trim())) {
      issues.push(`${key} must be null or a non-empty string`);
    }
  }
  if (!ROUTES.has(policy.default_route)) {
    issues.push("default_route must be one of: auto, lightweight, full");
  }
  if (!TRANSITION_OUTPUT_MODES.has(policy.transition_output)) {
    issues.push("transition_output must be one of: minimal, full");
  }

  if (!isPlainObject(policy.verification)) {
    issues.push("verification must be an object");
  } else if (typeof policy.verification.compact_by_default !== "boolean") {
    issues.push("verification.compact_by_default must be a boolean");
  }

  if (!isPlainObject(policy.story_registry)) {
    issues.push("story_registry must be an object");
  } else if (
    !Array.isArray(policy.story_registry.enforced_for) ||
    !policy.story_registry.enforced_for.every((entry) => typeof entry === "string" && entry.trim())
  ) {
    issues.push("story_registry.enforced_for must be an array of strings");
  }

  for (const section of ["persona", "ive"]) {
    if (!isPlainObject(policy[section])) {
      issues.push(`${section} must be an object`);
      continue;
    }
    for (const key of ["ambient", "surface_on_session_start"]) {
      if (typeof policy[section][key] !== "boolean") {
        issues.push(`${section}.${key} must be a boolean`);
      }
    }
  }

  if (!isPlainObject(policy.session)) {
    issues.push("session must be an object");
  } else if (typeof policy.session.kb_reads_required !== "boolean") {
    issues.push("session.kb_reads_required must be a boolean");
  }

  return { ok: issues.length === 0, issues };
}

export function findPlannerPolicyPath(projectRoot = process.cwd()) {
  for (const fileName of POLICY_FILE_NAMES) {
    const candidate = join(projectRoot, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadPlannerPolicy(projectRoot = process.cwd()) {
  const policyPath = findPlannerPolicyPath(projectRoot);
  if (!policyPath) {
    return {
      present: false,
      path: null,
      valid: true,
      policy: null,
      raw_policy: null,
      missing_defaults: Object.keys(DEFAULT_PLANNER_POLICY),
      issues: [],
      source: "absent",
    };
  }

  try {
    const rawPolicy = parsePlannerPolicyText(readFileSync(policyPath, "utf-8"), policyPath);
    const policy = mergePlannerPolicyDefaults(rawPolicy);
    const validation = validatePlannerPolicy(policy);
    return {
      present: true,
      path: policyPath,
      valid: validation.ok,
      policy: validation.ok ? policy : null,
      raw_policy: rawPolicy,
      missing_defaults: missingPlannerPolicyDefaultPaths(rawPolicy),
      issues: validation.issues,
      source: extname(policyPath).toLowerCase() === ".json" ? "json" : "yaml",
    };
  } catch (error) {
    return {
      present: true,
      path: policyPath,
      valid: false,
      policy: null,
      raw_policy: null,
      missing_defaults: [],
      issues: [error.message],
      source: extname(policyPath).toLowerCase() === ".json" ? "json" : "yaml",
    };
  }
}

export function resolvePlannerPolicyShape(projectRoot = process.cwd()) {
  const loaded = loadPlannerPolicy(projectRoot);
  if (!loaded.valid || !loaded.policy) return null;

  const shape = normalizePlannerPolicyShape(loaded.policy.shape);
  if (shape) {
    return {
      primary: shape,
      source: "planner_policy.shape",
      source_kind: "declared",
      declared: true,
      policy_path: loaded.path,
    };
  }

  const domain = normalizePlannerPolicyDomain(loaded.policy.domain);
  if (domain) {
    return {
      primary: domain,
      source: "planner_policy.domain",
      source_kind: "declared",
      declared: true,
      domain,
      policy_path: loaded.path,
    };
  }

  return null;
}

function orderedKeys(value) {
  const keys = Object.keys(value);
  const ordered = POLICY_KEY_ORDER.filter((key) => keys.includes(key));
  const rest = keys.filter((key) => !POLICY_KEY_ORDER.includes(key)).sort();
  return [...ordered, ...rest];
}

function yamlScalar(value) {
  if (Array.isArray(value)) return `[${value.map((item) => yamlScalar(item)).join(", ")}]`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  const text = String(value);
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : JSON.stringify(text);
}

export function serializePlannerPolicyYaml(policy = DEFAULT_PLANNER_POLICY, indent = 0) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const key of orderedKeys(policy)) {
    const value = policy[key];
    if (isPlainObject(value)) {
      lines.push(`${pad}${key}:`);
      lines.push(serializePlannerPolicyYaml(value, indent + 2).trimEnd());
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function serializePlannerPolicyJson(policy = DEFAULT_PLANNER_POLICY) {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

export function policyAllowsCompactVerification(policy) {
  return policy?.verification?.compact_by_default !== false;
}

export function ensurePlannerPolicy(projectRoot = process.cwd(), { dryRun = false, log = null } = {}) {
  const push = (message) => {
    if (Array.isArray(log)) log.push(message);
  };
  const existingPath = findPlannerPolicyPath(projectRoot);

  if (!existingPath) {
    const targetPath = join(projectRoot, POLICY_FILE_NAMES[0]);
    if (dryRun) {
      push("  WOULD CREATE: planner.policy.yaml");
      return { status: "would_create", path: targetPath, changed: false };
    }
    writeFileSync(targetPath, serializePlannerPolicyYaml(DEFAULT_PLANNER_POLICY));
    push("  CREATED: planner.policy.yaml");
    return { status: "created", path: targetPath, changed: true };
  }

  const loaded = loadPlannerPolicy(projectRoot);
  const relativeName = POLICY_FILE_NAMES.find((name) => existingPath.endsWith(name)) || existingPath;
  if (!loaded.valid) {
    push(`  INVALID: ${relativeName} (${loaded.issues.join("; ")})`);
    return { status: "invalid", path: existingPath, changed: false, issues: loaded.issues };
  }

  if (loaded.missing_defaults.length === 0) {
    push(`  OK: ${relativeName} exists`);
    return { status: "ok", path: existingPath, changed: false };
  }

  const merged = mergePlannerPolicyDefaults(loaded.raw_policy);
  if (dryRun) {
    push(`  WOULD MERGE: ${relativeName} (${loaded.missing_defaults.join(", ")})`);
    return {
      status: "would_merge",
      path: existingPath,
      changed: false,
      missing_defaults: loaded.missing_defaults,
    };
  }

  const content = extname(existingPath).toLowerCase() === ".json"
    ? serializePlannerPolicyJson(merged)
    : serializePlannerPolicyYaml(merged);
  writeFileSync(existingPath, content);
  push(`  MERGED: ${relativeName} (${loaded.missing_defaults.join(", ")})`);
  return {
    status: "merged",
    path: existingPath,
    changed: true,
    missing_defaults: loaded.missing_defaults,
  };
}
