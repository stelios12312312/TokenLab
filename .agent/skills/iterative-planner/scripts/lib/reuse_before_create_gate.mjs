// @planner:module = reuse_before_create_gate
// @planner:capability = reuse_before_create_duplicate_capability_gate

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { extractFilesToModify } from "./plan_utils.mjs";
import { validateRecipeSurface } from "./recipe_utils.mjs";
import { buildRecipeFleetAudit } from "../recipe_fleet_audit.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";

const SCRIPT_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".tsx", ".py", ".sh"]);
const SCRIPT_DIR_RE = /(^|\/)(scripts?|jobs?|bin|tools|tasks|commands|runners)(\/|$)/i;
const MAX_ANNOTATION_FILES = 500;
const MAX_ANNOTATION_BYTES = 64_000;
const NEAR_MATCH_MIN_SCORE = 0.25;
const NEAR_MATCH_MIN_SHARED_TOKENS = 3;

const DECLARATION_KEYS = new Set([
  "proposed_creations",
  "proposed_creation",
  "scripts_to_create",
  "script_to_create",
  "proposed_scripts",
  "new_scripts",
  "files_to_create",
  "new_files",
]);

const DECLARATION_CONTAINERS = [
  "implementation_plan",
  "execution_plan",
  "planner_extensions",
  "extensions",
  "metadata",
];

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value || "").trim();
}

function stripInlineComment(value) {
  return cleanText(value).replace(/\s+#.*$/, "").trim();
}

export function normalizeCapabilityId(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeComparablePath(value) {
  let text = cleanText(value).replace(/[`'"]/g, "").replace(/\\/g, "/");
  if (!text) return "";
  text = text.replace(/^\.\//, "");
  return text.toLowerCase();
}

export function normalizeCommand(value) {
  if (Array.isArray(value)) return value.map((part) => cleanText(part)).filter(Boolean).join(" ").trim().toLowerCase();
  if (value && typeof value === "object") {
    if (Array.isArray(value.command)) return normalizeCommand(value.command);
    if (typeof value.command === "string") return normalizeCommand(value.command);
  }
  return cleanText(value).replace(/\s+/g, " ").toLowerCase();
}

function scriptBasename(value) {
  const path = normalizeComparablePath(value);
  if (!path) return "";
  return basename(path).toLowerCase();
}

function isScriptLikePath(value) {
  const normalized = normalizeComparablePath(value);
  if (!normalized) return false;
  const ext = extname(normalized);
  if (!SCRIPT_EXTENSIONS.has(ext)) return false;
  return SCRIPT_DIR_RE.test(normalized);
}

function candidateText(entry) {
  return [
    entry.capability_id,
    entry.recipe_id,
    entry.title,
    entry.purpose,
    ...(entry.script_paths || []),
    ...(entry.commands || []),
  ].filter(Boolean).join(" ");
}

function tokenize(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[_./:-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !["node", "script", "scripts", "runner", "command", "create", "file"].includes(token));
}

function jaccard(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return { score: 0, shared: [] };
  const shared = [...a].filter((token) => b.has(token));
  const union = new Set([...a, ...b]);
  return { score: shared.length / union.size, shared };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function statFile(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function resolveMaybe(cwd, value) {
  const text = cleanText(value);
  if (!text) return "";
  return isAbsolute(text) ? text : resolve(cwd, text);
}

function findLocalFleetConfig(cwd) {
  const candidates = [
    join(cwd, ".agent", "recipe_fleet.config.yaml"),
    join(cwd, "recipe_fleet.config.yaml"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function normalizeDeclaration(entry, source) {
  if (typeof entry === "string") {
    return {
      source,
      path: entry,
      command: "",
      capability_id: "",
      purpose: "",
      title: "",
    };
  }
  if (!entry || typeof entry !== "object") return null;
  const pathValue = entry.path || entry.file || entry.file_path || entry.script || entry.script_path || "";
  return {
    source,
    path: cleanText(pathValue),
    command: entry.command || entry.runner || entry.runner_command || "",
    capability_id: cleanText(entry.capability_id || entry.capability || entry.id || ""),
    purpose: cleanText(entry.purpose || entry.description || entry.title || ""),
    title: cleanText(entry.title || entry.name || ""),
  };
}

function collectDeclarationValues(workOrder) {
  if (!workOrder || typeof workOrder !== "object") return [];
  const values = [];
  for (const key of DECLARATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(workOrder, key)) values.push(...asArray(workOrder[key]).map((value) => ({ key, value })));
  }
  for (const containerKey of DECLARATION_CONTAINERS) {
    const nested = workOrder[containerKey];
    if (!nested || typeof nested !== "object") continue;
    for (const key of DECLARATION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(nested, key)) values.push(...asArray(nested[key]).map((value) => ({ key: `${containerKey}.${key}`, value })));
    }
  }
  return values;
}

export function extractProposedCreations({ cwd = process.cwd(), planContent = "", workOrder = null } = {}) {
  const fromPlan = extractFilesToModify(planContent)
    .filter((file) => isScriptLikePath(file))
    .filter((file) => !existsSync(resolveMaybe(cwd, file)))
    .map((file) => normalizeDeclaration({ path: file, purpose: "planned script creation" }, "plan.files_to_modify"));

  const fromWorkOrder = collectDeclarationValues(workOrder)
    .map(({ key, value }) => normalizeDeclaration(value, `work_order.${key}`))
    .filter(Boolean)
    .filter((decl) => decl.capability_id || decl.command || isScriptLikePath(decl.path));

  return uniqueBy([...fromPlan, ...fromWorkOrder].filter(Boolean), (decl) => [
    decl.source,
    normalizeComparablePath(decl.path),
    normalizeCapabilityId(decl.capability_id),
    normalizeCommand(decl.command),
  ].join("|"));
}

function entryFromRecipe({ rootPath, project = "local", recipe, source }) {
  const normalized = recipe.normalized || {};
  const scriptPaths = asArray(normalized.scripts).map((script) => cleanText(script?.path || script?.command || script)).filter(Boolean);
  const commands = [
    normalizeCommand(normalized.runner?.command),
    ...asArray(normalized.scripts).map((script) => normalizeCommand(script?.command)).filter(Boolean),
  ].filter(Boolean);
  return {
    kind: "recipe",
    source,
    project,
    root_path: rootPath,
    recipe_id: normalized.recipe_id || recipe.id || "",
    capability_id: normalized.capability_id || "",
    title: normalized.title || recipe.id || "",
    purpose: asArray(normalized.scripts).map((script) => cleanText(script?.purpose)).filter(Boolean).join("; "),
    path: normalized.recipe_json_path || recipe.path || "",
    script_paths: scriptPaths,
    commands,
  };
}

function entriesFromCapabilityRegistry(rootPath, source, project = "local") {
  const registry = readJson(join(rootPath, "recipes", "capability_registry.json"));
  const capabilities = Array.isArray(registry?.capabilities) ? registry.capabilities : [];
  return capabilities
    .map((capability) => ({
      kind: "capability_registry",
      source,
      project,
      root_path: rootPath,
      recipe_id: "",
      capability_id: cleanText(capability?.id),
      title: cleanText(capability?.title || capability?.name),
      purpose: cleanText(capability?.description),
      path: join(rootPath, "recipes", "capability_registry.json"),
      script_paths: asArray(capability?.scripts).map((script) => cleanText(script?.path || script?.command || script)).filter(Boolean),
      commands: asArray(capability?.scripts).map((script) => normalizeCommand(script?.command)).filter(Boolean),
    }))
    .filter((entry) => entry.capability_id || entry.script_paths.length || entry.commands.length);
}

function collectRecipeEntries(rootPath, { source = "local_recipe", project = "local" } = {}) {
  if (!rootPath || !existsSync(rootPath)) return [];
  const surface = validateRecipeSurface(rootPath);
  const recipes = asArray(surface.recipes)
    .filter((recipe) => recipe?.valid !== false)
    .map((recipe) => entryFromRecipe({ rootPath, project, recipe, source }));
  return [
    ...recipes,
    ...entriesFromCapabilityRegistry(rootPath, source === "fleet_recipe" ? "fleet_capability_registry" : "local_capability_registry", project),
  ];
}

function walkScriptFiles(root, depth = 0, files = []) {
  if (!root || files.length >= MAX_ANNOTATION_FILES || depth > 3 || !existsSync(root)) return files;
  const stat = statFile(root);
  if (!stat) return files;
  if (stat.isFile()) {
    if (SCRIPT_EXTENSIONS.has(extname(root).toLowerCase())) files.push(root);
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (files.length >= MAX_ANNOTATION_FILES) break;
    if (["node_modules", ".git", "plans", "reports"].includes(entry.name)) continue;
    walkScriptFiles(join(root, entry.name), depth + 1, files);
  }
  return files;
}

function collectAnnotatedScriptEntries(cwd) {
  const roots = [
    join(cwd, ".agent", "skills", "iterative-planner", "scripts"),
    join(cwd, "scripts"),
  ];
  const files = uniqueBy(roots.flatMap((root) => walkScriptFiles(root)), (file) => resolve(file));
  const entries = [];
  for (const file of files) {
    const stat = statFile(file);
    if (!stat || stat.size > MAX_ANNOTATION_BYTES) continue;
    const text = readText(file).slice(0, MAX_ANNOTATION_BYTES);
    const capability = text.match(/@planner:capability\s*=?\s*([^\r\n]+)/);
    if (!capability) continue;
    const module = text.match(/@planner:module\s*=?\s*([^\r\n]+)/);
    const rel = normalizeComparablePath(relative(cwd, file));
    entries.push({
      kind: "annotated_script",
      source: "planner_annotation",
      project: "local",
      root_path: cwd,
      recipe_id: "",
      capability_id: stripInlineComment(capability[1]),
      title: stripInlineComment(module?.[1] || basename(file)),
      purpose: stripInlineComment(capability[1]),
      path: rel,
      script_paths: [rel],
      commands: [],
    });
  }
  return entries;
}

function collectFleetEntries({ cwd, fleetConfigPath = null } = {}) {
  const configPath = fleetConfigPath || findLocalFleetConfig(cwd);
  if (!configPath) return { entries: [], warnings: [] };
  if (!existsSync(resolveMaybe(cwd, configPath))) {
    return { entries: [], warnings: [`fleet_config_missing:${configPath}`] };
  }
  const audit = buildRecipeFleetAudit({ cwd, configPath });
  const entries = [];
  for (const project of asArray(audit.projects)) {
    entries.push(...collectRecipeEntries(project.root_path, { source: "fleet_recipe", project: project.name }));
  }
  return { entries, warnings: [] };
}

export function collectReuseInventory({ cwd = process.cwd(), fleetConfigPath = null } = {}) {
  const localEntries = collectRecipeEntries(cwd, { source: "local_recipe", project: "local" });
  const annotatedEntries = collectAnnotatedScriptEntries(cwd);
  const fleet = collectFleetEntries({ cwd, fleetConfigPath });
  const entries = uniqueBy([...localEntries, ...fleet.entries, ...annotatedEntries], (entry) => [
    entry.kind,
    entry.source,
    entry.project,
    normalizeCapabilityId(entry.capability_id),
    normalizeComparablePath(entry.path),
    (entry.script_paths || []).map(normalizeComparablePath).join(","),
    (entry.commands || []).map(normalizeCommand).join(","),
  ].join("|"));
  return {
    entries,
    warnings: fleet.warnings,
    summary: {
      entry_count: entries.length,
      local_recipe_count: localEntries.length,
      fleet_entry_count: fleet.entries.length,
      annotated_script_count: annotatedEntries.length,
    },
  };
}

function describeCandidate(entry) {
  return {
    kind: entry.kind,
    source: entry.source,
    project: entry.project,
    root_path: entry.root_path,
    recipe_id: entry.recipe_id,
    capability_id: entry.capability_id,
    title: entry.title,
    path: entry.path,
    script_paths: entry.script_paths || [],
    commands: entry.commands || [],
  };
}

function exactDuplicateIssues(proposal, candidates) {
  const issues = [];
  const proposalCapability = normalizeCapabilityId(proposal.capability_id);
  const proposalPath = normalizeComparablePath(proposal.path);
  const proposalBase = scriptBasename(proposal.path);
  const proposalCommand = normalizeCommand(proposal.command);

  for (const candidate of candidates) {
    const candidateCapability = normalizeCapabilityId(candidate.capability_id);
    if (proposalCapability && candidateCapability && proposalCapability === candidateCapability) {
      issues.push({
        severity: "block",
        code: "duplicate_capability_id",
        reason: `capability_id ${proposal.capability_id} already exists`,
        proposal,
        candidate: describeCandidate(candidate),
      });
      continue;
    }

    const candidateCommands = asArray(candidate.commands).map(normalizeCommand).filter(Boolean);
    if (proposalCommand && candidateCommands.includes(proposalCommand)) {
      issues.push({
        severity: "block",
        code: "duplicate_runner_command",
        reason: `runner command ${proposalCommand} already exists`,
        proposal,
        candidate: describeCandidate(candidate),
      });
      continue;
    }

    const candidatePaths = asArray(candidate.script_paths).map(normalizeComparablePath).filter(Boolean);
    if (proposalPath && candidatePaths.includes(proposalPath)) {
      issues.push({
        severity: "block",
        code: "duplicate_script_path",
        reason: `script path ${proposal.path} already exists`,
        proposal,
        candidate: describeCandidate(candidate),
      });
      continue;
    }

    const candidateBases = candidatePaths.map((path) => basename(path).toLowerCase()).filter(Boolean);
    if (proposalBase && candidateBases.includes(proposalBase)) {
      issues.push({
        severity: "block",
        code: "duplicate_script_name",
        reason: `script name ${proposalBase} already exists`,
        proposal,
        candidate: describeCandidate(candidate),
      });
    }
  }
  return issues;
}

function nearMatchIssues(proposal, candidates) {
  const proposalText = [
    proposal.capability_id,
    proposal.title,
    proposal.purpose,
    proposal.path,
    normalizeCommand(proposal.command),
  ].filter(Boolean).join(" ");
  return candidates
    .map((candidate) => {
      const match = jaccard(proposalText, candidateText(candidate));
      return { candidate, match };
    })
    .filter(({ match }) => match.score >= NEAR_MATCH_MIN_SCORE && match.shared.length >= NEAR_MATCH_MIN_SHARED_TOKENS)
    .sort((a, b) => b.match.score - a.match.score || candidateText(a.candidate).localeCompare(candidateText(b.candidate)))
    .slice(0, 3)
    .map(({ candidate, match }) => ({
      severity: "warn",
      code: "near_capability_match",
      reason: `near match shares ${match.shared.join(", ")}`,
      score: Number(match.score.toFixed(4)),
      proposal,
      candidate: describeCandidate(candidate),
    }));
}

export function evaluateReuseBeforeCreateGate({
  cwd = process.cwd(),
  planDir = null,
  planContent = "",
  workOrder = null,
  fleetConfigPath = null,
} = {}) {
  const effectiveCwd = cwd || process.cwd();
  const effectivePlanContent = planContent || (planDir ? readText(join(planDir, "plan.md")) : "");
  const declarations = extractProposedCreations({ cwd: effectiveCwd, planContent: effectivePlanContent, workOrder });
  const inventory = collectReuseInventory({ cwd: effectiveCwd, fleetConfigPath });

  const exactIssues = declarations.flatMap((proposal) => exactDuplicateIssues(proposal, inventory.entries));
  const exactKeys = new Set(exactIssues.map((issue) => [
    issue.proposal.source,
    normalizeComparablePath(issue.proposal.path),
    normalizeCapabilityId(issue.proposal.capability_id),
    issue.code,
  ].join("|")));
  const nearIssues = declarations.flatMap((proposal) => nearMatchIssues(proposal, inventory.entries))
    .filter((issue) => !exactKeys.has([
      issue.proposal.source,
      normalizeComparablePath(issue.proposal.path),
      normalizeCapabilityId(issue.proposal.capability_id),
      "duplicate_capability_id",
    ].join("|")));

  const blockCount = exactIssues.length;
  const warnCount = nearIssues.length;
  const status = blockCount > 0 ? "FAIL" : (warnCount > 0 ? "WARN" : "PASS");
  return {
    version: 1,
    status,
    plan_dir: planDir ? basename(planDir) : null,
    proposed_creation_count: declarations.length,
    inventory_summary: inventory.summary,
    warnings: inventory.warnings,
    issues: [...exactIssues, ...nearIssues],
    declarations,
  };
}

export function summarizeReuseBeforeCreateGate(result) {
  const status = normalizeVerificationStatus(result?.status, "gate");
  const proposed = result?.proposed_creation_count || 0;
  const blocks = asArray(result?.issues).filter((issue) => issue.severity === "block");
  const warns = asArray(result?.issues).filter((issue) => issue.severity === "warn");
  if (status.kind === "fail") {
    const first = blocks[0];
    const candidate = first?.candidate?.recipe_id || first?.candidate?.capability_id || first?.candidate?.path || "existing capability";
    return `Reuse-before-create blocked ${blocks.length} duplicate proposal(s); first ${first?.code || "duplicate"} should reuse ${candidate}.`;
  }
  if (status.kind === "pending" && status.token !== "UNKNOWN") {
    const first = warns[0];
    const candidate = first?.candidate?.recipe_id || first?.candidate?.capability_id || first?.candidate?.path || "existing capability";
    return `Reuse-before-create found ${warns.length} near-match proposal(s) for ${proposed} creation(s); review ${candidate} before creating new code.`;
  }
  if (status.kind === "pass") {
    return `Reuse-before-create passed: ${proposed} proposed creation(s), ${result?.inventory_summary?.entry_count || 0} inventory candidate(s), 0 duplicate blocks.`;
  }
  return `Reuse-before-create status is missing or unknown; ${proposed} proposed creation(s) cannot be treated as passing.`;
}
