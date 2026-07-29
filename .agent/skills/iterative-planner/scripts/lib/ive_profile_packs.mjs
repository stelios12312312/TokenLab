// ive_profile_packs.mjs - IVE profile evaluator and knowledge-pack loader.
//
// The helper is intentionally read-only for planner state. It reads bundled
// profile/pack JSON, evaluates deterministic checks, and emits Prolog facts
// that other planner surfaces may consume.

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { sanitizeAtom, sanitizeEnumAtom } from "./sanitize.mjs";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SKILL_DIR = resolve(LIB_DIR, "..", "..");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");

const PROFILE_CHECK_KINDS = new Set([
  "file_exists",
  "file_min_size",
  "prolog_fact",
  "prolog_query",
  "sparql",
  "test_named",
  "telemetry_field",
  "regex_in_glob",
  "regex_not_in_glob",
  "decorator_present",
  "decorator_absent",
  "composite",
]);

const PROFILE_COLLECTION_KEYS = [
  "required_artifacts",
  "required_metrics",
  "forbidden_patterns",
  "required_ontology_triples",
  "required_decorators",
];

const DEFAULT_PACK_ENTRY_FILES = [
  "pitfalls.json",
  "opportunities.json",
  "constraints.json",
  "decisions.json",
  "vocabulary.json",
  "canonical_artifacts.json",
];

const DEFAULT_PACK_OBLIGATION_FILES = [
  "obligations.json",
];

const PROJECT_TEXT_EXTENSIONS = /\.(md|txt|json|jsonl|yaml|yml|mjs|js|ts|tsx|jsx)$/i;
const PROJECT_TEXT_ROOTS = [
  "README.md",
  "package.json",
  "docs",
  "plans",
  "reports/user_story_audit",
  "src",
];
const MAX_PROJECT_TEXT_FILES = 400;
const MAX_PROJECT_TEXT_BYTES = 1_500_000;

const TRUST_TIERS = new Set(["bundled", "vendored", "community"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function safeReadJson(path, fallback = null) {
  try {
    return existsSync(path) ? readJson(path) : fallback;
  } catch {
    return fallback;
  }
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeRepoPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function uniqueObjects(values = [], keyFn = (value) => stableStringify(value)) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function shouldSkipDiscoveryDirectory(repoRoot, path) {
  const rel = normalizeRepoPath(relative(repoRoot, path));
  if (rel === "reports/ive/test_runs" || rel.startsWith("reports/ive/test_runs/")) return true;
  if (/^plans\/plan_[^/]+\/(artifacts|telemetry|checkpoints)(\/|$)/.test(rel)) return true;
  return rel === ".agent/cache" || rel.startsWith(".agent/cache/");
}

function listDirFiles(root, filter = () => true, { repoRoot = root } = {}) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === ".git" || name === "node_modules" || name === ".DS_Store") continue;
      const abs = join(current, name);
      let st = null;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!shouldSkipDiscoveryDirectory(repoRoot, abs)) stack.push(abs);
      } else if (filter(name, abs)) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

function globToRegExp(glob) {
  const normalized = normalizeRepoPath(glob);
  let pattern = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        pattern += ".*";
        i += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (ch === "?") {
      pattern += "[^/]";
    } else {
      pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

function resolveRepoFile(cwd, repoPath) {
  return resolve(cwd, normalizeRepoPath(repoPath));
}

function filesForSpec(cwd, spec = {}) {
  const pathValue = spec.path || spec.file || spec.glob;
  if (!pathValue) return [];
  const normalized = normalizeRepoPath(pathValue);
  if (!/[*?]/.test(normalized)) {
    const abs = resolveRepoFile(cwd, normalized);
    return existsSync(abs) ? [abs] : [];
  }
  const regex = globToRegExp(normalized);
  const wildcardIndex = normalized.search(/[*?]/);
  const fixedPrefix = wildcardIndex >= 0 ? normalized.slice(0, wildcardIndex) : normalized;
  const slashIndex = fixedPrefix.lastIndexOf("/");
  const searchRoot = slashIndex >= 0
    ? resolveRepoFile(cwd, fixedPrefix.slice(0, slashIndex))
    : cwd;
  return listDirFiles(
    searchRoot,
    (name, abs) => regex.test(normalizeRepoPath(relative(cwd, abs))),
    { repoRoot: cwd },
  );
}

function safeReadText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, out));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectStrings(entry, out));
  return out;
}

function collectStringsForKeys(value, keys, out = []) {
  const wanted = new Set(keys);
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStringsForKeys(entry, wanted, out));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (wanted.has(key)) collectStrings(entry, out);
      collectStringsForKeys(entry, wanted, out);
    }
  }
  return out;
}

function readProjectText(cwd) {
  const files = [];
  for (const relPath of PROJECT_TEXT_ROOTS) {
    const abs = resolveRepoFile(cwd, relPath);
    if (!existsSync(abs)) continue;
    let st = null;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isFile() && PROJECT_TEXT_EXTENSIONS.test(abs)) files.push(abs);
    else if (st.isDirectory()) files.push(...listDirFiles(abs, (name) => PROJECT_TEXT_EXTENSIONS.test(name), { repoRoot: cwd }));
  }
  let total = 0;
  const chunks = [];
  for (const abs of uniqueStrings(files).slice(0, MAX_PROJECT_TEXT_FILES)) {
    const text = safeReadText(abs);
    if (!text) continue;
    const remaining = MAX_PROJECT_TEXT_BYTES - total;
    if (remaining <= 0) break;
    const chunk = text.slice(0, remaining);
    chunks.push(chunk);
    total += chunk.length;
  }
  return chunks.join("\n").toLowerCase();
}

function readProgramPacketText(cwd) {
  const root = join(cwd, "plans/programs");
  if (!existsSync(root)) return "";
  return listDirFiles(root, (name) => name === "program_packet.json" || name.endsWith(".json"), { repoRoot: cwd })
    .slice(0, 80)
    .map((abs) => safeReadText(abs))
    .join("\n")
    .toLowerCase();
}

function evidenceCorpus(cwd) {
  const storyRegistry = safeReadJson(join(cwd, "reports/user_story_audit/story_registry.json"), {}) || {};
  const storyStrings = collectStrings(storyRegistry, []);
  const validationStrings = collectStringsForKeys(storyRegistry, [
    "validation_refs",
    "verification_refs",
    "test_refs",
    "evidence_refs",
  ], []);
  const programText = readProgramPacketText(cwd);
  const projectText = readProjectText(cwd);
  return {
    project_text: projectText,
    story_text: storyStrings.join("\n").toLowerCase(),
    validation_text: validationStrings.join("\n").toLowerCase(),
    program_text: programText,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textHasTerm(text, term) {
  const haystack = String(text || "").toLowerCase();
  const needle = String(term || "").trim().toLowerCase();
  if (!needle) return false;
  if (/^[a-z0-9_+-]+$/i.test(needle)) {
    return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}(?=$|[^a-z0-9_])`).test(haystack);
  }
  return haystack.includes(needle);
}

function textHasAny(text, terms) {
  const values = uniqueStrings(terms);
  return values.length === 0 ? true : values.some((term) => textHasTerm(text, term));
}

function normalizeCondition(spec = {}) {
  return spec && typeof spec === "object" ? spec : {};
}

function conditionMatches(spec = {}, { cwd, corpus } = {}) {
  const condition = normalizeCondition(spec);
  if (Object.keys(condition).length === 0) return true;
  let checked = false;
  if (condition.file_exists) {
    checked = true;
    if (!existsSync(resolveRepoFile(cwd, condition.file_exists))) return false;
  }
  if (Array.isArray(condition.file_exists_any) && condition.file_exists_any.length > 0) {
    checked = true;
    if (!condition.file_exists_any.some((entry) => existsSync(resolveRepoFile(cwd, entry)))) return false;
  }
  if (Array.isArray(condition.file_glob_any) && condition.file_glob_any.length > 0) {
    checked = true;
    if (!condition.file_glob_any.some((glob) => filesForSpec(cwd, { glob }).length > 0)) return false;
  }
  if (Array.isArray(condition.text_any) && condition.text_any.length > 0) {
    checked = true;
    if (!textHasAny(corpus.project_text, condition.text_any)) return false;
  }
  if (Array.isArray(condition.project_text_any) && condition.project_text_any.length > 0) {
    checked = true;
    if (!textHasAny(corpus.project_text, condition.project_text_any)) return false;
  }
  if (Array.isArray(condition.story_text_any) && condition.story_text_any.length > 0) {
    checked = true;
    if (!textHasAny(corpus.story_text, condition.story_text_any)) return false;
  }
  if (Array.isArray(condition.validation_ref_terms_any) && condition.validation_ref_terms_any.length > 0) {
    checked = true;
    if (!textHasAny(corpus.validation_text, condition.validation_ref_terms_any)) return false;
  }
  if (Array.isArray(condition.program_text_any) && condition.program_text_any.length > 0) {
    checked = true;
    if (!textHasAny(corpus.program_text, condition.program_text_any)) return false;
  }
  if (!checked) return false;
  return true;
}

function normalizeFact(value) {
  return String(value || "").trim().replace(/\.\s*$/, "");
}

function statusRank(status) {
  // INFO is a generated advisory severity, not authored proof status.
  if (status === "INFO") return 0;
  const normalized = normalizeVerificationStatus(status, "execution");
  if (normalized.kind === "fail" || !normalized.valid) return 3;
  if (normalized.kind === "pending" || normalized.kind === "waived") return 2;
  return normalized.kind === "pass" ? 1 : 3;
}

function normalizeSeverity(value) {
  const normalized = String(value || "fail").trim().toLowerCase();
  if (normalized === "warning") return "warn";
  if (["fail", "warn", "info"].includes(normalized)) return normalized;
  return "fail";
}

function resultStatus(pass, severity) {
  if (pass) return "PASS";
  return normalizeSeverity(severity) === "warn" ? "WARN" : normalizeSeverity(severity) === "info" ? "INFO" : "FAIL";
}

function getPath(value, dotted) {
  return String(dotted || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => (current && typeof current === "object" ? current[key] : undefined), value);
}

function loadAuditConfig(cwd) {
  return safeReadJson(join(cwd, "audit.config.json"), {}) || {};
}

function readNorthStarType(cwd) {
  const manifesto = safeReadJson(join(cwd, ".agent/skills/iterative-planner/config/planner_manifesto.json"), null);
  return manifesto?.north_star_type || null;
}

function importPresent(cwd, name) {
  const pkg = safeReadJson(join(cwd, "package.json"), null);
  if (pkg) {
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.optionalDependencies || {}),
    };
    if (Object.prototype.hasOwnProperty.call(deps, name)) return true;
  }
  const needle = String(name || "").trim();
  if (!needle) return false;
  return listDirFiles(cwd, (entryName) => /\.(mjs|js|ts|tsx|jsx|json|md)$/.test(entryName))
    .some((abs) => safeReadText(abs).includes(needle));
}

function appliesWhen(applies = {}, { cwd, activeProfiles = [], loadedPackIds = [] } = {}) {
  if (!applies || Object.keys(applies).length === 0) return true;
  const loadedPacks = new Set(uniqueStrings(loadedPackIds));
  if (Array.isArray(applies.dependency_loaded_any) && applies.dependency_loaded_any.length > 0) {
    if (!applies.dependency_loaded_any.some((id) => loadedPacks.has(id))) return false;
  }
  if (applies.file_exists && !existsSync(resolveRepoFile(cwd, applies.file_exists))) return false;
  if (Array.isArray(applies.file_exists_any) && applies.file_exists_any.length > 0) {
    if (!applies.file_exists_any.some((entry) => existsSync(resolveRepoFile(cwd, entry)))) return false;
  }
  if (Array.isArray(applies.file_glob_any) && applies.file_glob_any.length > 0) {
    if (!applies.file_glob_any.some((glob) => filesForSpec(cwd, { glob }).length > 0)) return false;
  }
  if (applies.import_present && !importPresent(cwd, applies.import_present)) return false;
  if (applies.north_star_type && readNorthStarType(cwd) !== applies.north_star_type) return false;
  if (Array.isArray(applies.profile_active_any) && applies.profile_active_any.length > 0) {
    const active = new Set(activeProfiles);
    if (!applies.profile_active_any.some((id) => active.has(id))) return false;
  }
  return true;
}

function expandSelectedPackIds({
  catalog,
  initialIds,
  disabled,
  cwd,
  activeProfiles,
}) {
  const selected = new Set(uniqueStrings(initialIds));
  const triggers = new Map([...selected].map((id) => [id, "KnowledgePackLoad"]));
  const dependencyActive = () => new Set([...selected].filter((id) => !disabled.has(id)));

  let changed = true;
  while (changed) {
    changed = false;
    const active = dependencyActive();
    for (const pack of catalog.packs.values()) {
      if (selected.has(pack.id) || disabled.has(pack.id)) continue;
      const dependencies = uniqueStrings(pack.dependencies || []);
      const dependencyHints = uniqueStrings(pack.applies_when?.dependency_loaded_any || []);
      const dependencyTriggered = [...dependencies, ...dependencyHints].some((id) => active.has(id));
      if (!dependencyTriggered) continue;
      if (!appliesWhen(pack.applies_when, { cwd, activeProfiles, loadedPackIds: [...active] })) continue;
      selected.add(pack.id);
      triggers.set(pack.id, "DependencyLoaded");
      changed = true;
    }
  }

  return { selectedIds: [...selected], triggers };
}

function configuredList(config, keys) {
  for (const key of keys) {
    const value = getPath(config, key);
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === "string" && value.trim()) return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function profileDir(skillDir = SKILL_DIR) {
  return join(skillDir, "profiles");
}

function packRoot(skillDir = SKILL_DIR) {
  return join(skillDir, "knowledge_packs");
}

export function loadProfileCatalog({ skillDir = SKILL_DIR } = {}) {
  const root = profileDir(skillDir);
  const profiles = new Map();
  const errors = [];
  if (!existsSync(root)) return { profiles, errors, root };
  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith(".profile.json")) continue;
    const path = join(root, name);
    try {
      const profile = readJson(path);
      const id = String(profile.id || name.replace(/\.profile\.json$/, "")).trim();
      profiles.set(id, { ...profile, id, path });
    } catch (err) {
      errors.push({ path, error: err.message });
    }
  }
  return { profiles, errors, root };
}

function checksFromProfile(profile) {
  return PROFILE_COLLECTION_KEYS.flatMap((key) =>
    (Array.isArray(profile[key]) ? profile[key] : []).map((check) => ({ ...check, collection: key }))
  );
}

function mergeProfile(parent, child) {
  const merged = {
    ...parent,
    ...child,
    extends: child.extends || [],
    inherited_from: uniqueStrings([...(parent.inherited_from || []), parent.id, ...(child.inherited_from || [])]),
  };
  for (const key of PROFILE_COLLECTION_KEYS) {
    merged[key] = [
      ...(Array.isArray(parent[key]) ? parent[key] : []),
      ...(Array.isArray(child[key]) ? child[key] : []),
    ];
  }
  merged.gate_overrides = {
    ...(parent.gate_overrides || {}),
    ...(child.gate_overrides || {}),
  };
  return merged;
}

function resolveProfile(id, catalog, seen = new Set()) {
  if (seen.has(id)) throw new Error(`profile inheritance cycle at ${id}`);
  const profile = catalog.profiles.get(id);
  if (!profile) throw new Error(`profile not found: ${id}`);
  seen.add(id);
  const disabledParents = new Set(uniqueStrings(profile.disabled_extends || profile.disabled_parents));
  let resolved = { ...profile, inherited_from: [] };
  for (const parentId of uniqueStrings(profile.extends || [])) {
    if (disabledParents.has(parentId)) continue;
    const parent = resolveProfile(parentId, catalog, seen);
    resolved = mergeProfile(parent, resolved);
  }
  seen.delete(id);
  return resolved;
}

function validateProfile(profile) {
  const issues = [];
  for (const check of checksFromProfile(profile)) {
    if (!PROFILE_CHECK_KINDS.has(check.kind)) {
      issues.push({
        code: "unknown_check_kind",
        check_id: check.id || check.name || "unknown",
        kind: check.kind || "missing",
      });
    }
  }
  return issues;
}

function gateOverride(profile, gate, check) {
  const gateConfig = profile.gate_overrides?.[gate] || {};
  const id = check.id || check.name;
  const disabled = new Set(uniqueStrings([
    ...(gateConfig.disabled_checks || []),
    ...(gateConfig.disabled_check_ids || []),
  ]));
  const severityOverrides = gateConfig.severity_overrides || {};
  return {
    disabled: disabled.has(id) || disabled.has(check.kind),
    severity: severityOverrides[id] || severityOverrides[check.kind] || check.severity,
  };
}

function evaluateComposite(check, ctx) {
  const children = Array.isArray(check.checks) ? check.checks : [];
  const mode = String(check.mode || "all").toLowerCase();
  const childResults = children.map((child, index) => evaluateCheck({ ...child, id: child.id || `${check.id || "composite"}_${index}` }, ctx));
  const passing = mode === "any"
    ? childResults.some((entry) => verificationStatusIsPass(entry.status, "execution"))
    : childResults.every((entry) => verificationStatusIsPass(entry.status, "execution"));
  return {
    pass: passing,
    detail: `${mode} composite over ${childResults.length} child check(s)`,
    children: childResults,
  };
}

function evaluateCheck(check, ctx) {
  const override = gateOverride(ctx.profile, ctx.gate, check);
  const severity = normalizeSeverity(override.severity || check.severity || "fail");
  const id = check.id || check.name || `${check.collection || "check"}:${check.kind}`;
  if (override.disabled || check.disabled === true) {
    return { id, kind: check.kind, severity, status: "SKIP", pass: true, detail: "disabled by gate override" };
  }

  let pass = false;
  let detail = "";
  let children = [];
  try {
    if (check.kind === "file_exists") {
      const abs = resolveRepoFile(ctx.cwd, check.path || check.file);
      pass = existsSync(abs);
      detail = normalizeRepoPath(check.path || check.file);
    } else if (check.kind === "file_min_size") {
      const abs = resolveRepoFile(ctx.cwd, check.path || check.file);
      const size = existsSync(abs) ? statSync(abs).size : 0;
      const minBytes = Number(check.min_bytes || check.minBytes || 1);
      pass = size >= minBytes;
      detail = `${normalizeRepoPath(check.path || check.file)} size=${size} min=${minBytes}`;
    } else if (check.kind === "regex_in_glob" || check.kind === "regex_not_in_glob") {
      const files = filesForSpec(ctx.cwd, check);
      const re = new RegExp(String(check.pattern || ""), check.flags || "");
      const matches = files.filter((abs) => re.test(safeReadText(abs)));
      pass = check.kind === "regex_in_glob" ? matches.length > 0 : matches.length === 0;
      detail = `${matches.length}/${files.length} file(s) matched ${check.pattern}`;
    } else if (check.kind === "decorator_present" || check.kind === "decorator_absent") {
      const text = safeReadText(resolveRepoFile(ctx.cwd, check.path || check.file));
      const hasDecorator = text.includes(String(check.decorator || ""));
      pass = check.kind === "decorator_present" ? hasDecorator : !hasDecorator;
      detail = `${normalizeRepoPath(check.path || check.file)} ${check.decorator || ""}`;
    } else if (check.kind === "prolog_fact" || check.kind === "prolog_query" || check.kind === "sparql") {
      const expected = normalizeFact(check.fact || check.query || check.expected_fact);
      pass = expected ? ctx.facts.has(expected) : false;
      detail = expected || "missing expected fact";
    } else if (check.kind === "test_named") {
      const name = check.test || check.name || check.id;
      pass = verificationStatusIsPass(ctx.testResults[name], "execution");
      detail = String(name || "unknown");
    } else if (check.kind === "telemetry_field") {
      const actual = getPath(ctx.telemetry, check.field);
      pass = Object.prototype.hasOwnProperty.call(check, "equals")
        ? actual === check.equals
        : actual !== undefined && actual !== null;
      detail = `${check.field || "unknown"}=${JSON.stringify(actual)}`;
    } else if (check.kind === "composite") {
      const composite = evaluateComposite(check, ctx);
      pass = composite.pass;
      detail = composite.detail;
      children = composite.children;
    }
  } catch (err) {
    pass = false;
    detail = err.message;
  }

  const status = resultStatus(pass, severity);
  return { id, kind: check.kind, severity, status, pass, detail, children };
}

function profileInputFingerprint(cwd, profiles, gate) {
  const specs = profiles.flatMap((profile) => checksFromProfile(profile));
  const fileRefs = [];
  for (const spec of specs) {
    const pathValue = spec.path || spec.file || spec.glob;
    if (!pathValue) continue;
    const files = filesForSpec(cwd, spec);
    if (files.length === 0) fileRefs.push({ path: normalizeRepoPath(pathValue), missing: true });
    for (const abs of files) {
      let hash = "unreadable";
      let size = 0;
      try {
        const content = readFileSync(abs);
        hash = sha256(content);
        size = content.length;
      } catch {
        // Keep unreadable marker.
      }
      fileRefs.push({ path: normalizeRepoPath(relative(cwd, abs)), size, hash });
    }
  }
  return sha256(stableStringify({
    gate,
    profiles: profiles.map((profile) => ({ id: profile.id, body: profile })),
    fileRefs: fileRefs.sort((a, b) => a.path.localeCompare(b.path)),
  }));
}

export function evaluateProjectProfiles({
  cwd = process.cwd(),
  skillDir = SKILL_DIR,
  profileIds = null,
  gate = null,
  useCache = true,
  cacheDir = null,
  facts = [],
  testResults = {},
  telemetry = {},
} = {}) {
  const auditConfig = loadAuditConfig(cwd);
  const catalog = loadProfileCatalog({ skillDir });
  const configuredProfiles = configuredList(auditConfig, [
    "ive.profiles",
    "ive_profiles",
    "profiles",
    "profile_ids",
  ]);
  const explicitIds = Array.isArray(profileIds) ? profileIds.filter(Boolean) : null;
  const activeIds = explicitIds || configuredProfiles;
  const selectedIds = activeIds.length > 0
    ? activeIds
    : [...catalog.profiles.values()]
      .filter((profile) => appliesWhen(profile.applies_when, { cwd }))
      .map((profile) => profile.id);

  if (catalog.errors.length > 0) {
    return { ok: false, status: "FAIL", error_code: "profile_catalog_parse_error", errors: catalog.errors };
  }
  if (selectedIds.length === 0) {
    return {
      ok: true,
      status: "NOT_APPLICABLE",
      status_reason: "no_active_profile",
      profiles_evaluated: 0,
      cache_hit: false,
      profile_results: [],
    };
  }

  let profiles = [];
  try {
    profiles = selectedIds.map((id) => resolveProfile(id, catalog));
  } catch (err) {
    return { ok: false, status: "FAIL", error_code: "profile_resolution_failed", error: err.message, cache_hit: false };
  }

  const validationIssues = profiles.flatMap((profile) =>
    validateProfile(profile).map((issue) => ({ ...issue, profile_id: profile.id }))
  );
  if (validationIssues.length > 0) {
    return {
      ok: false,
      status: "FAIL",
      error_code: "unknown_check_kind",
      issues: validationIssues,
      profiles_evaluated: profiles.length,
      cache_hit: false,
    };
  }

  const resolvedCacheDir = cacheDir || join(cwd, ".agent/cache/ive/profile_matches");
  const cacheKey = profileInputFingerprint(cwd, profiles, gate || "default");
  const cachePath = join(resolvedCacheDir, `${cacheKey}.json`);
  if (useCache && existsSync(cachePath)) {
    const cached = safeReadJson(cachePath, null);
    if (cached) return { ...cached, cache_hit: true, cache_path: cachePath };
  }

  const factSet = new Set(uniqueStrings(facts).map(normalizeFact));
  const profileResults = profiles.map((profile) => {
    const ctx = { cwd, profile, gate: gate || "default", facts: factSet, testResults, telemetry };
    const checks = checksFromProfile(profile).map((check) => evaluateCheck(check, ctx));
    const worst = checks.reduce((rank, check) => Math.max(rank, statusRank(check.status)), 0);
    const status = worst >= 3 ? "FAIL" : worst === 2 ? "WARN" : "PASS";
    return {
      profile_id: profile.id,
      title: profile.title || profile.id,
      inherited_from: profile.inherited_from || [],
      check_count: checks.length,
      status,
      ok: verificationStatusIsPass(status, "execution"),
      checks,
    };
  });

  const worst = profileResults.reduce((rank, result) => Math.max(rank, statusRank(result.status)), 0);
  const report = {
    ok: verificationStatusIsPass(worst >= 3 ? "FAIL" : worst === 2 ? "WARN" : "PASS", "execution"),
    status: worst >= 3 ? "FAIL" : worst === 2 ? "WARN" : "PASS",
    schema_version: 1,
    profiles_evaluated: profileResults.length,
    gate: gate || null,
    cache_key: cacheKey,
    cache_hit: false,
    profile_results: profileResults,
  };

  if (useCache) {
    ensureDir(resolvedCacheDir);
    writeFileSync(cachePath, JSON.stringify(report, null, 2) + "\n");
    report.cache_path = cachePath;
  }
  return report;
}

export function loadKnowledgePackCatalog({ skillDir = SKILL_DIR } = {}) {
  const root = packRoot(skillDir);
  const packs = new Map();
  const errors = [];
  if (!existsSync(root)) return { packs, errors, root };
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(dir, "pack.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = readJson(manifestPath);
      const id = String(manifest.id || manifest.pack || name).trim();
      packs.set(id, { ...manifest, id, dir, manifest_path: manifestPath });
    } catch (err) {
      errors.push({ path: manifestPath, error: err.message });
    }
  }
  return { packs, errors, root };
}

function packEntryType(fileName) {
  return fileName.replace(/\.json$/, "").replace(/s$/, "");
}

function loadPackEntries(pack) {
  const files = Array.isArray(pack.entry_files) && pack.entry_files.length > 0
    ? pack.entry_files
    : DEFAULT_PACK_ENTRY_FILES;
  const entries = [];
  const errors = [];
  for (const file of files) {
    const path = join(pack.dir, file);
    if (!existsSync(path)) continue;
    try {
      const body = readJson(path);
      const values = Array.isArray(body) ? body : (Array.isArray(body.entries) ? body.entries : []);
      for (const entry of values) {
        entries.push({
          ...entry,
          type: entry.type || packEntryType(file),
          source_file: file,
        });
      }
    } catch (err) {
      errors.push({ path, error: err.message });
    }
  }
  return { entries, errors };
}

function packObligationFiles(pack) {
  return Array.isArray(pack.obligation_files) && pack.obligation_files.length > 0
    ? pack.obligation_files
    : DEFAULT_PACK_OBLIGATION_FILES;
}

function normalizeObligationRequirement(raw, index) {
  const req = raw && typeof raw === "object" ? raw : {};
  const kind = String(req.kind || req.type || "unknown").trim();
  return {
    ...req,
    id: String(req.id || req.name || `requirement_${index + 1}`).trim(),
    kind,
  };
}

function normalizeObligation(pack, raw, index, sourceFile) {
  if (!raw || typeof raw !== "object") {
    return { error: `obligation ${index + 1} in ${sourceFile} is not an object` };
  }
  const id = String(raw.id || raw.obligation_id || "").trim();
  if (!id) return { error: `obligation ${index + 1} in ${sourceFile} is missing id` };
  const subjectId = String(raw.subject_id || raw.subject || `pack_${pack.id}_${id}`).trim()
    .replace(/[^a-zA-Z0-9_./@-]/g, "_")
    .replace(/_+/g, "_");
  const satisfiedBy = raw.satisfied_by || raw.satisfaction || {};
  const requirements = Array.isArray(satisfiedBy)
    ? satisfiedBy
    : Array.isArray(satisfiedBy.any)
      ? satisfiedBy.any
      : Array.isArray(raw.requires)
        ? raw.requires
        : [];
  return {
    ...raw,
    id,
    subject_id: subjectId || `pack_${pack.id}_${id}`,
    mode: String(raw.mode || "artifact_review").trim(),
    severity: String(raw.severity || "required").trim(),
    required_by_phase: String(raw.required_by_phase || raw.required_phase || "plan").trim(),
    applies_when: raw.applies_when || raw.when || {},
    requirements: requirements.map(normalizeObligationRequirement),
    source_file: sourceFile,
  };
}

function loadPackObligations(pack) {
  const obligations = [];
  const errors = [];
  const seen = new Set();
  for (const file of packObligationFiles(pack)) {
    const path = join(pack.dir, file);
    if (!existsSync(path)) continue;
    try {
      const body = readJson(path);
      const values = Array.isArray(body) ? body : (Array.isArray(body.obligations) ? body.obligations : []);
      values.forEach((entry, index) => {
        const normalized = normalizeObligation(pack, entry, index, file);
        if (normalized.error) {
          errors.push({ path, error: normalized.error });
          return;
        }
        if (seen.has(normalized.id)) return;
        seen.add(normalized.id);
        obligations.push(normalized);
      });
    } catch (err) {
      errors.push({ path, error: err.message });
    }
  }
  return { obligations, errors };
}

function requirementSatisfied(requirement, { cwd, corpus }) {
  const kind = String(requirement.kind || "").trim();
  if (kind === "validation_ref_terms_any") return textHasAny(corpus.validation_text, requirement.terms || requirement.any || []);
  if (kind === "story_terms_any") return textHasAny(corpus.story_text, requirement.terms || requirement.any || []);
  if (kind === "program_verification_terms_any") return textHasAny(corpus.program_text, requirement.terms || requirement.any || []);
  if (kind === "text_terms_any" || kind === "project_text_terms_any") return textHasAny(corpus.project_text, requirement.terms || requirement.any || []);
  if (kind === "artifact_exists_any" || kind === "file_exists_any") {
    return uniqueStrings(requirement.paths || requirement.files || requirement.any || []).some((entry) => existsSync(resolveRepoFile(cwd, entry)));
  }
  if (kind === "file_glob_any") {
    return uniqueStrings(requirement.globs || requirement.any || []).some((glob) => filesForSpec(cwd, { glob }).length > 0);
  }
  return false;
}

function compilePackObligations(pack, obligations, { cwd, corpus, tier }) {
  return obligations.map((obligation) => {
    const active = conditionMatches(obligation.applies_when, { cwd, corpus });
    const evidence = active
      ? obligation.requirements
        .filter((requirement) => requirementSatisfied(requirement, { cwd, corpus }))
        .map((requirement) => ({
          id: `pack_evidence_${sha256(`${pack.id}:${obligation.id}:${requirement.id}`).slice(0, 12)}`,
          requirement_id: requirement.id,
          kind: requirement.kind,
        }))
      : [];
    return {
      ...obligation,
      trust_tier: tier,
      active,
      satisfied: evidence.length > 0,
      evidence,
    };
  });
}

function knowledgePackObligationFacts(pack, compiledObligations, tier) {
  const source = pack.provenance?.source || `knowledge_pack:${pack.id}@v${Number.parseInt(pack.version || pack.schema_version || 1, 10) || 1}`;
  const writer = pack.provenance?.writer || "knowledge_pack";
  const facts = [];
  for (const obligation of compiledObligations) {
    facts.push(`pack_obligation(${sanitizeAtom(pack.id)}, ${sanitizeAtom(obligation.id)}).`);
    facts.push(`obligation_trust_tier(${sanitizeAtom(obligation.id)}, ${sanitizeEnumAtom(tier)}).`);
    facts.push(`obligation_provenance(${sanitizeAtom(obligation.id)}, ${sanitizeAtom(source)}, ${sanitizeAtom(writer)}).`);
    for (const requirement of obligation.requirements) {
      facts.push(`obligation_requires(${sanitizeAtom(obligation.id)}, ${sanitizeAtom(requirement.id)}, ${sanitizeEnumAtom(requirement.kind)}).`);
    }
    if (!obligation.active) continue;
    facts.push(`active_obligation(${sanitizeAtom(obligation.id)}, ${sanitizeAtom(pack.id)}).`);
    facts.push(`verification_subject(${sanitizeAtom(obligation.subject_id)}, ${sanitizeEnumAtom("pack_obligation")}).`);
    facts.push(`verification_mode(${sanitizeEnumAtom(obligation.mode)}).`);
    facts.push(`verification_supported(${sanitizeEnumAtom(obligation.mode)}).`);
    facts.push(`verification_obligation(${sanitizeAtom(obligation.id)}, ${sanitizeAtom(obligation.subject_id)}, ${sanitizeEnumAtom(obligation.mode)}, ${sanitizeEnumAtom(obligation.severity)}).`);
    facts.push(`obligation_source(${sanitizeAtom(obligation.id)}, ${sanitizeEnumAtom("knowledge_pack")}, ${sanitizeAtom(pack.id)}).`);
    facts.push(`obligation_required_by_phase(${sanitizeAtom(obligation.id)}, ${sanitizeEnumAtom(obligation.required_by_phase)}).`);
    for (const evidence of obligation.evidence) {
      facts.push(`verification_evidence(${sanitizeAtom(evidence.id)}, ${sanitizeAtom(obligation.subject_id)}, ${sanitizeEnumAtom(obligation.mode)}, ${sanitizeEnumAtom("passed")}).`);
      facts.push(`evidence_artifact(${sanitizeAtom(evidence.id)}, ${sanitizeAtom(`knowledge_pack:${pack.id}:${obligation.id}:${evidence.requirement_id}`)}).`);
      facts.push(`obligation_satisfied_by(${sanitizeAtom(obligation.id)}, ${sanitizeAtom(evidence.id)}).`);
    }
  }
  return uniqueStrings(facts);
}

function knowledgePackFacts(pack, entries, trigger = "KnowledgePackLoad", compiledObligations = [], tierOverride = null) {
  const version = Number.parseInt(pack.version || pack.schema_version || 1, 10) || 1;
  const tier = tierOverride || (TRUST_TIERS.has(String(pack.trust_tier || "").toLowerCase())
    ? String(pack.trust_tier).toLowerCase()
    : "bundled");
  const source = `knowledge_pack:${pack.id}@v${version}`;
  const facts = [
    `knowledge_pack_loaded(${sanitizeAtom(pack.id)}, ${version}, ${sanitizeEnumAtom(tier)}).`,
    `knowledge_pack_trigger(${sanitizeAtom(pack.id)}, ${sanitizeAtom(trigger)}).`,
  ];
  for (const dep of uniqueStrings(pack.dependencies || [])) {
    facts.push(`knowledge_pack_dependency(${sanitizeAtom(pack.id)}, ${sanitizeAtom(dep)}).`);
  }
  for (const entry of entries) {
    const entryId = entry.id || `${pack.id}:${entry.type}:${entries.indexOf(entry)}`;
    facts.push(`knowledge_pack_entry(${sanitizeAtom(pack.id)}, ${sanitizeAtom(entryId)}, ${sanitizeEnumAtom(entry.type || "entry")}).`);
    facts.push(`knowledge_pack_entry_severity(${sanitizeAtom(entryId)}, ${sanitizeEnumAtom(entry.severity || "medium")}).`);
    facts.push(`knowledge_pack_entry_polarity(${sanitizeAtom(entryId)}, ${sanitizeEnumAtom(entry.polarity || "neutral")}).`);
    facts.push(`knowledge_pack_provenance(${sanitizeAtom(entryId)}, ${sanitizeAtom(entry.source || source)}, ${sanitizeAtom(entry.writer || "knowledge_pack")}).`);
  }
  facts.push(...knowledgePackObligationFacts(pack, compiledObligations, tier));
  return uniqueStrings(facts);
}

export function loadKnowledgePacks({
  cwd = process.cwd(),
  skillDir = SKILL_DIR,
  packIds = null,
  disabledPacks = [],
  acceptedPacks = [],
  allowCommunity = null,
  activeProfiles = [],
} = {}) {
  const auditConfig = loadAuditConfig(cwd);
  const catalog = loadKnowledgePackCatalog({ skillDir });
  if (catalog.errors.length > 0) {
    return { ok: false, status: "FAIL", error_code: "knowledge_pack_catalog_parse_error", errors: catalog.errors, facts: [] };
  }

  const configuredPacks = configuredList(auditConfig, [
    "ive.knowledge_packs",
    "knowledge_packs",
  ]);
  const configuredDisabled = configuredList(auditConfig, [
    "ive.knowledge_packs_disabled",
    "knowledge_packs_disabled",
  ]);
  const disabled = new Set([...configuredDisabled, ...disabledPacks].map(String));
  const explicitIds = Array.isArray(packIds) ? packIds.filter(Boolean) : null;
  const baseSelectedIds = explicitIds || (configuredPacks.length > 0
    ? configuredPacks
    : [...catalog.packs.values()]
      .filter((pack) => appliesWhen(pack.applies_when, { cwd, activeProfiles }))
      .map((pack) => pack.id));
  const { selectedIds, triggers } = expandSelectedPackIds({
    catalog,
    initialIds: baseSelectedIds,
    disabled,
    cwd,
    activeProfiles,
  });

  if (selectedIds.length === 0) {
    return { ok: true, status: "NOT_APPLICABLE", status_reason: "no_active_knowledge_pack", facts: [], pack_results: [] };
  }

  const accepted = new Set([
    ...configuredList(auditConfig, ["ive.accepted_knowledge_packs", "accepted_knowledge_packs"]),
    ...acceptedPacks,
  ].map(String));
  const communityAllowed = allowCommunity ?? (
    auditConfig.allow_community_packs === true ||
    auditConfig.ive?.allow_community_packs === true
  );

  const facts = [];
  const packResults = [];
  const corpus = evidenceCorpus(cwd);
  for (const id of selectedIds) {
    const pack = catalog.packs.get(id);
    if (!pack) {
      packResults.push({ pack_id: id, status: "FAIL", ok: false, error_code: "knowledge_pack_missing" });
      continue;
    }
    const tier = TRUST_TIERS.has(String(pack.trust_tier || "").toLowerCase())
      ? String(pack.trust_tier).toLowerCase()
      : "bundled";
    if (disabled.has(id)) {
      packResults.push({
        pack_id: id,
        status: "DISABLED",
        ok: true,
        trust_tier: tier,
        trigger: "KnowledgePackDeactivation",
        facts: [],
      });
      continue;
    }
    if (tier === "community" && (!communityAllowed || !accepted.has(id))) {
      packResults.push({
        pack_id: id,
        status: "BLOCKED",
        ok: false,
        trust_tier: tier,
        error_code: "community_pack_requires_allow_and_accept",
        facts: [],
      });
      continue;
    }
    const { entries, errors } = loadPackEntries(pack);
    const { obligations, errors: obligationErrors } = loadPackObligations(pack);
    if (errors.length > 0 || obligationErrors.length > 0) {
      packResults.push({ pack_id: id, status: "FAIL", ok: false, trust_tier: tier, errors: [...errors, ...obligationErrors], facts: [] });
      continue;
    }
    const compiledObligations = compilePackObligations(pack, obligations, { cwd, corpus, tier });
    const trigger = triggers.get(id) || "KnowledgePackLoad";
    const packFacts = knowledgePackFacts(pack, entries, trigger, compiledObligations, tier);
    facts.push(...packFacts);
    packResults.push({
      pack_id: id,
      status: "PASS",
      ok: true,
      trust_tier: tier,
      version: Number.parseInt(pack.version || pack.schema_version || 1, 10) || 1,
      trigger,
      dependency_count: uniqueStrings(pack.dependencies || []).length,
      entry_count: entries.length,
      obligation_count: compiledObligations.length,
      active_obligation_count: compiledObligations.filter((obligation) => obligation.active).length,
      satisfied_obligation_count: compiledObligations.filter((obligation) => obligation.satisfied).length,
      entries,
      obligations: compiledObligations,
      facts: packFacts,
    });
  }

  const hasFail = packResults.some((result) => !result.ok && result.status !== "DISABLED");
  const hasLoaded = packResults.some((result) => verificationStatusIsPass(result.status, "execution"));
  const allDisabled = packResults.length > 0 && packResults.every((result) => result.status === "DISABLED");
  const dedupedFacts = uniqueStrings(facts);
  return {
    ok: !hasFail,
    status: hasFail ? "FAIL" : hasLoaded ? "PASS" : allDisabled ? "DISABLED" : "NOT_APPLICABLE",
    schema_version: 1,
    selected_pack_count: selectedIds.length,
    loaded_pack_count: packResults.filter((result) => verificationStatusIsPass(result.status, "execution")).length,
    obligation_count: packResults.reduce((sum, result) => sum + (result.obligation_count || 0), 0),
    active_obligation_count: packResults.reduce((sum, result) => sum + (result.active_obligation_count || 0), 0),
    satisfied_obligation_count: packResults.reduce((sum, result) => sum + (result.satisfied_obligation_count || 0), 0),
    facts: dedupedFacts,
    pack_results: packResults,
  };
}

export const IVE_PROFILE_PACK_CONSTANTS = Object.freeze({
  PROFILE_CHECK_KINDS: [...PROFILE_CHECK_KINDS],
  DEFAULT_PACK_ENTRY_FILES,
  DEFAULT_PACK_OBLIGATION_FILES,
  TRUST_TIERS: [...TRUST_TIERS],
  DEFAULT_SKILL_DIR: SKILL_DIR,
  DEFAULT_REPO_ROOT: REPO_ROOT,
});
