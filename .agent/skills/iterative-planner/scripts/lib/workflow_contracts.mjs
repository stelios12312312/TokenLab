import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const WORKFLOW_CONTRACT_PROFILE_PATH = join(__dirname, "..", "..", "config", "workflow_contract_profiles.json");
export const WORKFLOW_REGISTRY_PATH = join(__dirname, "..", "..", "config", "workflow_registry.json");
export const WORKFLOW_MIGRATION_INVENTORY_PATH = join(__dirname, "..", "..", "config", "workflow_migration_inventory.json");
export const WORKFLOW_CONTRACT_VERSION = "2026-04-30.ritual-contracts.v1";
export const HOST_OWNED_WORKFLOW_MARKER = "planner:host-owned-workflow";
export const KNOWN_WORKFLOW_ACTIONS = Object.freeze([
  "deprecated",
  "keep_unchanged",
  "new",
  "parked",
  "redesigned",
  "renamed",
  "restored",
  "simplified",
  "updated",
]);

const KNOWN_WORKFLOW_ACTION_SET = new Set(KNOWN_WORKFLOW_ACTIONS);
const WORKFLOW_ID_PATTERN = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CANONICAL_RITUAL_ARTIFACTS = Object.freeze(new Set([
  "plan.md",
  "findings.md",
  "decisions.md",
  "progress.md",
  "verification_strategy.yaml",
  "verification.md",
  "reflection.md",
  "red_team_notes.md",
  "ontology_facts.pl",
  "reports",
  "reports/test_runs",
  "reports/evidence"
]));

const ROUTED_PLANNER_COMMANDS = Object.freeze(new Set([
  "new",
  "resume",
  "status",
  "gate",
  "preflight",
  "work-preflight",
  "ritual-lint",
  "migrate",
  "recipe",
  "ontology",
  "steward",
  "workflow"
]));

const INTERNAL_WORKFLOW_CONTRACT_PROFILES = Object.freeze({
  "/safe-change-power": "implementation_full",
  "/safe-plan": "planning_only",
  "/red-team-audit": "audit",
  "/red-team-user-story-audit": "audit",
  "/regression-audit": "audit",
  "/parity-audit": "audit",
  "/full-review-and-fix": "audit",
  "/recipe-discovery": "recipe",
  "/recipe-tidy": "recipe",
  "/recipe-bootstrap": "recipe",
  "/recipe-fleet-audit": "recipe",
  "/story-bootstrap": "ontology",
  "/register-user-story": "ontology",
  "/story-registry-bootstrap": "ontology",
  "/story-verification": "ontology",
  "/ticket-traceability-repair": "ontology",
  "/roadmap-steward": "stewardship",
  "/steward": "stewardship",
  "/sme-improvement": "diagnostic",
  "/consolidate-annotations": "ontology",
  "/housekeeping": "diagnostic",
  "/kb-update": "diagnostic",
  "/migrate-all": "migration",
  "/ontology": "ontology",
  "/knowledge-steward": "stewardship",
  "/diagnose": "diagnostic",
  "/evidence-browser": "browser_evidence",
  "/thrashing-recovery": "diagnostic",
  "/reflection": "diagnostic",
  "/conventions": "diagnostic",
  "/spot-check": "audit",
});

export function safeReadJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

export function normalizeWorkflowId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function normalizeWorkflowAction(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizePhase(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const gateMap = {
    "explore-to-plan": "explore",
    "plan-to-execute": "plan",
    "execute-to-reflect": "execute",
    "reflect-to-validate": "reflect",
    "validate-to-close": "validate",
    "notify-user": "close"
  };
  return gateMap[normalized] || normalized || "plan";
}

export function getSkillRootFromProject(projectRoot = process.cwd()) {
  return join(projectRoot, ".agent", "skills", "iterative-planner");
}

export function getWorkflowDir(projectRoot = process.cwd()) {
  return join(projectRoot, ".agent", "workflows");
}

export function getParkedWorkflowDir(projectRoot = process.cwd()) {
  return join(projectRoot, ".agent", "_parked");
}

export function loadWorkflowRegistry(projectRoot = process.cwd()) {
  const path = join(getSkillRootFromProject(projectRoot), "config", "workflow_registry.json");
  const parsed = safeReadJson(path, null);
  const workflows = Array.isArray(parsed?.workflows) ? parsed.workflows : [];
  return { path, version: parsed?.version || null, workflows };
}

export function loadWorkflowContractProfiles(projectRoot = process.cwd()) {
  const path = join(getSkillRootFromProject(projectRoot), "config", "workflow_contract_profiles.json");
  const parsed = safeReadJson(path, null);
  const profiles = parsed?.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
  return {
    path,
    version: parsed?.version || null,
    contract_version: parsed?.contract_version || WORKFLOW_CONTRACT_VERSION,
    profiles
  };
}

export function loadWorkflowMigrationInventory(projectRoot = process.cwd()) {
  const path = join(getSkillRootFromProject(projectRoot), "config", "workflow_migration_inventory.json");
  const parsed = safeReadJson(path, null);
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return {
    path,
    version: parsed?.version || null,
    generated_report: typeof parsed?.generated_report === "string" && parsed.generated_report.trim()
      ? parsed.generated_report.trim()
      : join("reports", "workflow_migration_inventory.yaml"),
    entries,
  };
}

export function listWorkflowMarkdownIds(projectRoot = process.cwd()) {
  const workflowDir = getWorkflowDir(projectRoot);
  if (!existsSync(workflowDir)) return [];
  return readdirSync(workflowDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => `/${entry.replace(/\.md$/i, "")}`)
    .sort();
}

export function listParkedWorkflowMarkdownIds(projectRoot = process.cwd()) {
  const parkedDir = getParkedWorkflowDir(projectRoot);
  if (!existsSync(parkedDir)) return [];
  return readdirSync(parkedDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => `/${entry.replace(/\.md$/i, "")}`)
    .sort();
}

export function getWorkflowEntry(projectRoot, workflowId) {
  const normalized = normalizeWorkflowId(workflowId);
  const registry = loadWorkflowRegistry(projectRoot);
  return registry.workflows.find((entry) => normalizeWorkflowId(entry?.id) === normalized) || null;
}

export function getWorkflowContract(projectRoot, workflowId) {
  const normalized = normalizeWorkflowId(workflowId);
  const registry = loadWorkflowRegistry(projectRoot);
  const profilesDocument = loadWorkflowContractProfiles(projectRoot);
  const inventory = loadWorkflowMigrationInventory(projectRoot);
  const workflow = registry.workflows.find((entry) => normalizeWorkflowId(entry?.id) === normalized) || null;
  const inventoryEntry = inventory.entries.find((entry) => normalizeWorkflowId(entry?.workflow) === normalized) || null;
  const internalProfileId = inventoryEntry
    ? (inventoryEntry.contract_profile || INTERNAL_WORKFLOW_CONTRACT_PROFILES[normalized] || null)
    : null;
  const profileId = workflow?.contract_profile || internalProfileId || null;
  const profile = profileId ? profilesDocument.profiles[profileId] || null : null;
  return {
    workflow_id: normalized,
    workflow: workflow || (inventoryEntry ? {
      id: normalized,
      purpose: inventoryEntry.v6_purpose || inventoryEntry.notes || "Internal workflow accounted for by workflow migration inventory.",
      internal: true,
      inventory_action: inventoryEntry.v7_action || null,
      contract_profile: profileId,
    } : null),
    contract_profile: profileId,
    profile,
    contract_version: profilesDocument.contract_version,
    registry_path: registry.path,
    profiles_path: profilesDocument.path,
    inventory_path: inventory.path,
    registry_public: Boolean(workflow),
    inventory_accounted: Boolean(inventoryEntry)
  };
}

export function workflowMarkdownPath(projectRoot, workflowId) {
  const normalized = normalizeWorkflowId(workflowId);
  if (!normalized) return null;
  return join(getWorkflowDir(projectRoot), `${normalized.slice(1)}.md`);
}

export function parkedWorkflowMarkdownPath(projectRoot, workflowId) {
  const normalized = normalizeWorkflowId(workflowId);
  if (!normalized) return null;
  return join(getParkedWorkflowDir(projectRoot), `${normalized.slice(1)}.md`);
}

export function workflowFileHasExplicitHostOwnerMarker(filePath) {
  if (!filePath || !existsSync(filePath)) return false;
  let text = "";
  try {
    text = readFileSync(filePath, "utf-8").slice(0, 4096);
  } catch {
    return false;
  }
  return text.includes(HOST_OWNED_WORKFLOW_MARKER) ||
    /planner[_-]owner:\s*host/i.test(text);
}

export function workflowMarkdownIsExplicitHostOwned(projectRoot, workflowId) {
  const path = workflowMarkdownPath(projectRoot, workflowId);
  return workflowFileHasExplicitHostOwnerMarker(path);
}

function issue({ id, severity = "error", message, repair_command = null, workflow = null, profile = null }) {
  return {
    id,
    severity,
    blocking: severity === "error",
    message,
    repair_command,
    workflow,
    profile
  };
}

export function isCanonicalWorkflowSource(projectRoot = process.cwd()) {
  // Inside a managed upgrade proof or pinned source snapshot, the project root
  // is always a candidate or snapshot — never the canonical source. Returning
  // false preserves consumer identity across parked-workflow transitions
  // (T-INTAKE-962DFCF9).
  if (
    process.env._PLANNER_MANAGED_UPGRADE_PROOF_RUNNING === "1"
    || process.env._PLANNER_PINNED_SOURCE_RUNNING === "1"
  ) {
    return false;
  }
  const registryPath = join(getSkillRootFromProject(projectRoot), "config", ".project_registry.json");
  const registry = safeReadJson(registryPath, null);
  const sourcePath = typeof registry?.source_project_path === "string"
    ? registry.source_project_path.trim()
    : "";
  return Boolean(sourcePath) && resolve(sourcePath) === resolve(projectRoot);
}

export function buildWorkflowDispositionSurface(
  projectRoot = process.cwd(),
  { requireParkedArtifacts = isCanonicalWorkflowSource(projectRoot) } = {},
) {
  const inventory = loadWorkflowMigrationInventory(projectRoot);
  const registry = loadWorkflowRegistry(projectRoot);
  const activeIds = new Set(listWorkflowMarkdownIds(projectRoot));
  const parkedIds = new Set(listParkedWorkflowMarkdownIds(projectRoot));
  const registryIds = new Set(registry.workflows.map((entry) => normalizeWorkflowId(entry?.id)).filter(Boolean));
  const issues = [];
  const normalizedIds = inventory.entries.map((entry) => normalizeWorkflowId(entry?.workflow));
  const validIds = normalizedIds.filter((id) => id && WORKFLOW_ID_PATTERN.test(id));
  const duplicateIds = new Set(validIds.filter((id, index) => validIds.indexOf(id) !== index));

  inventory.entries.forEach((entry, index) => {
    if (!normalizedIds[index] || !WORKFLOW_ID_PATTERN.test(normalizedIds[index])) {
      issues.push(issue({
        id: "workflow_inventory_invalid_id",
        message: `workflow_migration_inventory.json entry ${index + 1} must declare a lower-kebab workflow id such as /safe-change`,
      }));
    }
  });
  for (const workflowId of [...duplicateIds].sort()) {
    issues.push(issue({
      id: "workflow_inventory_duplicate_id",
      workflow: workflowId,
      message: `workflow_migration_inventory.json declares duplicate workflow id ${workflowId}`,
    }));
  }

  const entries = inventory.entries.map((entry, index) => {
    const workflowId = validIds.includes(normalizedIds[index]) ? normalizedIds[index] : null;
    const action = normalizeWorkflowAction(entry?.v7_action);
    const actionKnown = KNOWN_WORKFLOW_ACTION_SET.has(action);
    const parked = action === "parked";
    const activeFileExists = Boolean(workflowId && activeIds.has(workflowId));
    const parkedFileExists = Boolean(workflowId && parkedIds.has(workflowId));
    const registryTracked = Boolean(workflowId && registryIds.has(workflowId));

    if (workflowId && !action) {
      issues.push(issue({
        id: "workflow_inventory_missing_action",
        workflow: workflowId,
        message: `${workflowId} must declare a non-empty v7_action in workflow_migration_inventory.json`,
      }));
    } else if (workflowId && !actionKnown) {
      issues.push(issue({
        id: "workflow_inventory_unknown_action",
        workflow: workflowId,
        message: `${workflowId} declares unknown v7_action ${JSON.stringify(entry?.v7_action ?? null)}`,
        repair_command: `Choose one of: ${[...KNOWN_WORKFLOW_ACTIONS].sort().join(", ")}.`,
      }));
    }

    if (workflowId && actionKnown && parked) {
      if (activeFileExists) {
        issues.push(issue({
          id: "workflow_parked_present_in_active_dir",
          workflow: workflowId,
          message: `${workflowId} is Parked but remains active at ${workflowMarkdownPath(projectRoot, workflowId)}`,
          repair_command: `Move it to ${parkedWorkflowMarkdownPath(projectRoot, workflowId)}.`,
        }));
      }
      if (registryTracked) {
        issues.push(issue({
          id: "workflow_parked_public_registry_conflict",
          workflow: workflowId,
          message: `${workflowId} is Parked but remains public in workflow_registry.json`,
        }));
      }
      if (requireParkedArtifacts && !parkedFileExists) {
        issues.push(issue({
          id: "workflow_parked_artifact_missing",
          workflow: workflowId,
          message: `${workflowId} is Parked but its canonical archive ${parkedWorkflowMarkdownPath(projectRoot, workflowId)} is missing`,
        }));
      }
    } else if (workflowId && actionKnown && !activeFileExists) {
      issues.push(issue({
        id: "workflow_active_file_missing",
        workflow: workflowId,
        message: `${workflowId} declares active disposition ${entry.v7_action} but ${workflowMarkdownPath(projectRoot, workflowId)} is missing`,
      }));
    }

    return {
      ...entry,
      workflow: workflowId,
      action,
      action_known: actionKnown,
      disposition_status: parked ? "parked" : "active",
      fleet_managed: actionKnown && !parked,
      active_file: workflowId ? workflowMarkdownPath(projectRoot, workflowId) : null,
      active_file_exists: activeFileExists,
      parked_file: workflowId ? parkedWorkflowMarkdownPath(projectRoot, workflowId) : null,
      parked_file_exists: parkedFileExists,
      registry_tracked: registryTracked,
    };
  });

  const inventoryIds = new Set(validIds);
  for (const activeId of [...activeIds].sort()) {
    if (!inventoryIds.has(activeId) && !workflowMarkdownIsExplicitHostOwned(projectRoot, activeId)) {
      issues.push(issue({
        id: "workflow_markdown_missing_inventory_entry",
        workflow: activeId,
        message: `${workflowMarkdownPath(projectRoot, activeId)} exists without a workflow_migration_inventory.json disposition`,
        repair_command: `Add ${activeId} to workflow_migration_inventory.json or mark a consumer-owned file with ${HOST_OWNED_WORKFLOW_MARKER}.`,
      }));
    }
  }
  for (const parkedId of [...parkedIds].sort()) {
    const matchingEntries = entries.filter((entry) => entry.workflow === parkedId);
    if (!matchingEntries.some((entry) => entry.action === "parked")) {
      issues.push(issue({
        id: "workflow_parked_artifact_undispositioned",
        workflow: parkedId,
        message: `${parkedWorkflowMarkdownPath(projectRoot, parkedId)} exists without a Parked inventory disposition`,
      }));
    }
  }

  return {
    ok: issues.every((entry) => !entry.blocking),
    issues,
    inventory,
    registry,
    entries,
    active_workflow_ids: [...activeIds].sort(),
    parked_workflow_ids: [...parkedIds].sort(),
    require_parked_artifacts: requireParkedArtifacts,
  };
}

export function listFleetManagedWorkflowFiles(projectRoot = process.cwd(), options = {}) {
  const surface = buildWorkflowDispositionSurface(projectRoot, {
    requireParkedArtifacts: false,
    ...options,
  });
  const specIssues = surface.issues.filter(
    (entry) => entry.blocking && entry.id.startsWith("workflow_inventory_"),
  );
  if (specIssues.length > 0) {
    const detail = specIssues
      .map((entry) => `${entry.id}${entry.workflow ? `:${entry.workflow}` : ""}`)
      .join(", ");
    throw new Error(`workflow disposition surface is invalid: ${detail}`);
  }
  return surface.entries
    .filter((entry) => entry.fleet_managed)
    .map((entry) => `${entry.workflow.slice(1)}.md`)
    .sort();
}

function isPlannerCommandRouted(projectRoot, command) {
  if (ROUTED_PLANNER_COMMANDS.has(command)) return true;
  const plannerPath = join(getSkillRootFromProject(projectRoot), "scripts", "planner.mjs");
  if (!existsSync(plannerPath)) return false;
  const text = readFileSync(plannerPath, "utf-8");
  return text.includes(`"${command}"`) || text.includes(`'${command}'`) || text.includes(`cmd === "${command}"`);
}

export function validateWorkflowContractSurface(projectRoot = process.cwd()) {
  const registry = loadWorkflowRegistry(projectRoot);
  const profilesDocument = loadWorkflowContractProfiles(projectRoot);
  const profileIds = new Set(Object.keys(profilesDocument.profiles || {}));
  const workflowIds = registry.workflows.map((entry) => normalizeWorkflowId(entry?.id)).filter(Boolean);
  const workflowIdSet = new Set(workflowIds);
  const markdownIds = new Set(listWorkflowMarkdownIds(projectRoot));
  const dispositionSurface = buildWorkflowDispositionSurface(projectRoot);
  const inventory = dispositionSurface.inventory;
  const issues = [...dispositionSurface.issues];

  if (registry.version !== 1) {
    issues.push(issue({
      id: "workflow_registry_invalid_version",
      message: `workflow_registry.json must declare version=1 at ${registry.path}`
    }));
  }
  if (profilesDocument.version !== 1) {
    issues.push(issue({
      id: "workflow_contract_profiles_invalid_version",
      message: `workflow_contract_profiles.json must declare version=1 at ${profilesDocument.path}`
    }));
  }

  const duplicates = workflowIds.filter((id, index) => workflowIds.indexOf(id) !== index);
  for (const duplicate of [...new Set(duplicates)]) {
    issues.push(issue({
      id: "workflow_registry_duplicate_id",
      workflow: duplicate,
      message: `workflow_registry.json declares duplicate workflow id ${duplicate}`
    }));
  }

  if (inventory.version !== 1) {
    issues.push(issue({
      id: "workflow_migration_inventory_invalid_version",
      message: `workflow_migration_inventory.json must declare version=1 at ${inventory.path}`
    }));
  }

  for (const workflow of registry.workflows) {
    const workflowId = normalizeWorkflowId(workflow?.id);
    if (!workflowId) continue;
    if (!markdownIds.has(workflowId)) {
      issues.push(issue({
        id: "workflow_registry_missing_markdown",
        workflow: workflowId,
        message: `${workflowId} is in workflow_registry.json but ${workflowMarkdownPath(projectRoot, workflowId)} is missing`,
        repair_command: `Create ${workflowMarkdownPath(projectRoot, workflowId)} or remove the stale registry entry.`
      }));
    }

    if (!workflow.contract_profile) {
      issues.push(issue({
        id: "workflow_registry_missing_contract_profile",
        workflow: workflowId,
        message: `${workflowId} is missing contract_profile`,
        repair_command: `Add a contract_profile to ${workflowId} in workflow_registry.json.`
      }));
      continue;
    }

    if (!profileIds.has(workflow.contract_profile)) {
      issues.push(issue({
        id: "workflow_registry_unknown_contract_profile",
        workflow: workflowId,
        profile: workflow.contract_profile,
        message: `${workflowId} references unknown contract profile ${workflow.contract_profile}`,
        repair_command: `Define ${workflow.contract_profile} in workflow_contract_profiles.json or choose an existing profile.`
      }));
    }
  }

  for (const [profileId, profile] of Object.entries(profilesDocument.profiles || {})) {
    for (const command of profile.required_commands || []) {
      if (!isPlannerCommandRouted(projectRoot, command)) {
        issues.push(issue({
          id: "workflow_contract_command_not_routed",
          profile: profileId,
          message: `Contract profile ${profileId} requires planner command ${command}, but planner.mjs does not route it`,
          repair_command: `Route ${command} in .agent/skills/iterative-planner/scripts/planner.mjs.`
        }));
      }
    }
    for (const artifacts of Object.values(profile.required_artifacts_by_phase || {})) {
      for (const artifact of artifacts || []) {
        if (!CANONICAL_RITUAL_ARTIFACTS.has(artifact)) {
          issues.push(issue({
            id: "workflow_contract_unknown_artifact",
            profile: profileId,
            message: `Contract profile ${profileId} names unknown canonical artifact ${artifact}`,
            repair_command: `Add ${artifact} to CANONICAL_RITUAL_ARTIFACTS or use an existing artifact id.`
          }));
        }
      }
    }
  }

  return {
    ok: issues.every((entry) => !entry.blocking),
    issues,
    registry,
    profiles: profilesDocument,
    workflow_files: [...markdownIds].sort(),
    dispositions: dispositionSurface,
  };
}

export function requiredArtifactsForPhase(profile, phase) {
  const normalizedPhase = normalizePhase(phase);
  const byPhase = profile?.required_artifacts_by_phase || {};
  return [
    ...(byPhase.all || []),
    ...(byPhase[normalizedPhase] || [])
  ];
}

export function artifactExists(planDir, artifact) {
  if (!planDir || !artifact) return false;
  return existsSync(join(planDir, artifact));
}

export function buildWorkflowContractSummary(projectRoot, workflowId) {
  const contract = getWorkflowContract(projectRoot, workflowId);
  const profile = contract.profile || {};
  return {
    workflow_id: contract.workflow_id,
    contract_profile: contract.contract_profile,
    workflow_contract_version: contract.contract_version,
    enforcement: profile.enforcement || "unknown",
    required_commands: profile.required_commands || [],
    required_artifacts_by_phase: profile.required_artifacts_by_phase || {},
    required_gates: profile.required_gates || [],
    required_proof_surfaces: profile.required_proof_surfaces || [],
    post_change_audits: profile.post_change_audits || []
  };
}

function gitOutput(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 10000 });
  if (proc.status !== 0) return null;
  return String(proc.stdout || "").trim();
}

function gitRawOutput(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 10000 });
  if (proc.status !== 0) return null;
  return String(proc.stdout || "").replace(/\r?\n$/, "");
}

function safeCommitHash(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

export function resolveCommit(cwd = process.cwd(), commitish = "HEAD") {
  const output = gitOutput(cwd, ["rev-parse", commitish]);
  return output || null;
}

function parseNumstat(text) {
  const files = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) continue;
    const added = match[1] === "-" ? 0 : Number.parseInt(match[1], 10) || 0;
    const removed = match[2] === "-" ? 0 : Number.parseInt(match[2], 10) || 0;
    const file = match[3].trim();
    linesAdded += added;
    linesRemoved += removed;
    files.push({ file, added, removed });
  }
  return { files, linesAdded, linesRemoved };
}

function parsePorcelainStatus(text) {
  const entries = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim() || "modified";
    let file = line.slice(3).trim();
    if (file.includes(" -> ")) file = file.split(" -> ").pop().trim();
    if (file) entries.push({ status, file });
  }
  return entries;
}

function ignoreCoveragePath(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  if (normalized === "plans/audit_log.json" || normalized === "plans/.current_plan") return true;
  if (normalized === ".agent/http_permissions.yaml") return true;
  if (normalized.startsWith("reports/telemetry_capture/")) return true;
  if (normalized.startsWith("reports/workflow_intelligence/")) return true;
  if (/^plans\/plan_[^/]+\/(?:state\.json|state\.md|ontology_facts\.pl|metrics\.json|health_final\.json|health_report\.md|persona_findings\.json|executed_test_gates\.json)$/.test(normalized)) return true;
  if (/^plans\/plan_[^/]+\/artifacts\/(?:\.invariant_advisories\.json|\.repair_surface_[^/]+\.json|decision_log\.jsonl)$/.test(normalized)) return true;
  if (/^plans\/plan_[^/]+\/artifacts\/prolog\/[^/]+\.json$/.test(normalized)) return true;
  return false;
}

function countLines(value) {
  if (!value) return 0;
  return String(value).split(/\r\n|\r|\n/).length;
}

function hashWorktreeFile(cwd, file) {
  try {
    const fullPath = join(cwd, file);
    const stat = statSync(fullPath);
    if (!stat.isFile()) return { file, kind: "non_file", size: stat.size };
    if (stat.size > 1_048_576) {
      return { file, kind: "large_file", size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs) };
    }
    const content = readFileSync(fullPath);
    return {
      file,
      kind: "file",
      size: stat.size,
      sha256: createHash("sha256").update(content).digest("hex"),
      line_count: countLines(content.toString("utf-8")),
    };
  } catch {
    return { file, kind: "missing" };
  }
}

export function computeChangeCoverageFingerprint(cwd = process.cwd(), commitish = "HEAD") {
  const commit = resolveCommit(cwd, commitish);
  if (!commit) {
    return {
      covers_commit: null,
      covers_worktree: false,
      worktree_dirty: false,
      worktree_fingerprint: null,
      changed_file_count: 0,
      lines_added: 0,
      lines_removed: 0,
      line_delta: 0,
      changed_files: [],
      change_fingerprint: null
    };
  }

  const numstat = gitOutput(cwd, ["show", "--format=", "--numstat", "--find-renames", commit]) || "";
  const parsed = parseNumstat(numstat);
  const fingerprintInput = JSON.stringify({
    commit,
    files: parsed.files
      .map((entry) => [entry.file, entry.added, entry.removed])
      .sort((a, b) => a[0].localeCompare(b[0]))
  });
  return {
    covers_commit: commit,
    covers_worktree: false,
    worktree_dirty: false,
    worktree_fingerprint: null,
    changed_file_count: parsed.files.length,
    lines_added: parsed.linesAdded,
    lines_removed: parsed.linesRemoved,
    line_delta: parsed.linesAdded - parsed.linesRemoved,
    changed_files: parsed.files.map((entry) => entry.file).sort(),
    change_fingerprint: createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 32)
  };
}

export function computeCurrentCoverageFingerprint(cwd = process.cwd()) {
  const commit = safeCommitHash(resolveCommit(cwd, "HEAD"));
  if (!commit) return computeChangeCoverageFingerprint(cwd, "HEAD");

  const statusEntries = parsePorcelainStatus(gitRawOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]) || "")
    .filter((entry) => !ignoreCoveragePath(entry.file));
  const changedFiles = [...new Set(statusEntries.map((entry) => entry.file))].sort();
  if (changedFiles.length === 0) {
    const headCoverage = computeChangeCoverageFingerprint(cwd, "HEAD");
    return {
      ...headCoverage,
      covers_worktree: true,
      worktree_dirty: false,
      worktree_fingerprint: headCoverage.change_fingerprint,
    };
  }

  const trackedDiffRaw = parseNumstat(gitOutput(cwd, ["diff", "--numstat", "--find-renames", "HEAD", "--"]) || "");
  const trackedFiles = trackedDiffRaw.files.filter((entry) => !ignoreCoveragePath(entry.file));
  const untrackedFiles = statusEntries.filter((entry) => entry.status === "??").map((entry) => entry.file).sort();
  const untrackedDigests = untrackedFiles.map((file) => hashWorktreeFile(cwd, file));
  const untrackedLines = untrackedDigests.reduce((sum, entry) => sum + (entry.line_count || 0), 0);
  const fingerprintInput = JSON.stringify({
    commit,
    dirty_files: changedFiles,
    tracked_diff: trackedFiles.map((entry) => [entry.file, entry.added, entry.removed]).sort((a, b) => a[0].localeCompare(b[0])),
    untracked: untrackedDigests,
  });
  const trackedAdded = trackedFiles.reduce((sum, entry) => sum + entry.added, 0);
  const trackedRemoved = trackedFiles.reduce((sum, entry) => sum + entry.removed, 0);
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 32);
  return {
    covers_commit: commit,
    covers_worktree: true,
    worktree_dirty: true,
    worktree_fingerprint: fingerprint,
    changed_file_count: changedFiles.length,
    lines_added: trackedAdded + untrackedLines,
    lines_removed: trackedRemoved,
    line_delta: trackedAdded + untrackedLines - trackedRemoved,
    changed_files: changedFiles,
    change_fingerprint: fingerprint,
  };
}

export function auditLogCoversCurrentCommit(projectRoot, auditType, log = null) {
  const auditLog = log || safeReadJson(join(projectRoot, "plans", "audit_log.json"), { audits: [] });
  const coverage = computeCurrentCoverageFingerprint(projectRoot);
  if (!coverage.covers_commit || !coverage.change_fingerprint) {
    return { covered: false, coverage, matching_audit: null };
  }
  const matching = (Array.isArray(auditLog?.audits) ? auditLog.audits : [])
    .filter((entry) => entry?.type === auditType)
    .filter((entry) => coverage.worktree_dirty
      ? (entry.covers_worktree === true && entry.worktree_fingerprint === coverage.worktree_fingerprint)
        || (entry.coverage_scope === "head" && entry.covers_commit === coverage.covers_commit
          && entry.change_fingerprint === computeChangeCoverageFingerprint(projectRoot, "HEAD").change_fingerprint)
      : entry.covers_commit === coverage.covers_commit && entry.change_fingerprint === coverage.change_fingerprint)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0] || null;
  return {
    covered: Boolean(matching),
    coverage,
    matching_audit: matching
  };
}

export function adoptionCommand({ workflowId, phase = "plan", planDirName = null } = {}) {
  const workflow = normalizeWorkflowId(workflowId) || "</workflow>";
  const planPart = planDirName ? ` --plan plans/${planDirName}` : "";
  return `node .agent/skills/iterative-planner/scripts/planner.mjs ritual-lint --workflow ${workflow} --phase ${normalizePhase(phase)}${planPart} --adopt`;
}
