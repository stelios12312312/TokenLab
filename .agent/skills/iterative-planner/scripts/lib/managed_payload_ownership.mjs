// @planner:module = managed_payload_ownership
// @planner:story = US-015
// @planner:proves = sc_1, sc_2, sc_3, sc_4, sc_7

/**
 * Authoritative ownership vocabulary for planner migrations.
 *
 * The classifier is deliberately conservative: a path that is not covered by
 * this contract is UNKNOWN and may not be mutated merely because it happens to
 * live under a broad migration scope.
 */
export const MANAGED_PAYLOAD_OWNERSHIP = Object.freeze({
  ENGINE: "engine",
  PROJECT: "project",
  MIXED_PROJECTION: "mixed_projection",
  GENERATED: "generated",
  UNKNOWN: "unknown",
});

export function normalizeManagedPayloadPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function normalizedPathSet(paths) {
  return new Set(
    (Array.isArray(paths) ? paths : [])
      .map(normalizeManagedPayloadPath)
      .filter(Boolean),
  );
}

function isPathOrChild(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function classifyManagedPayloadPath(path, { managedWorkflowPaths = [] } = {}) {
  const normalized = normalizeManagedPayloadPath(path);
  if (!normalized) return MANAGED_PAYLOAD_OWNERSHIP.UNKNOWN;

  const generatedPaths = new Set([
    ".agent/skills/iterative-planner/config/last_upgrade_receipt.json",
    ".agent/ontology/provisioning_receipt.json",
  ]);
  if (
    generatedPaths.has(normalized)
    || isPathOrChild(normalized, ".agent/ontology/cache")
  ) {
    return MANAGED_PAYLOAD_OWNERSHIP.GENERATED;
  }

  const projectExactPaths = new Set([
    ".agent/skills/iterative-planner/config/.project_registry.json",
    ".agent/skills/iterative-planner/config/source_hygiene.json",
    "planner.policy.yaml",
    "planner.policy.yml",
    "planner.policy.json",
    "planner.discovery.json",
    "audit.config.json",
    "audit.config.yaml",
    "audit.config.yml",
  ]);
  if (projectExactPaths.has(normalized)) {
    return MANAGED_PAYLOAD_OWNERSHIP.PROJECT;
  }

  const mixedProjectionPaths = new Set([
    ".agent/rules.md",
    "CLAUDE.md",
    "GEMINI.md",
    "AGENTS.md",
    ".cursor/rules/iterative-planner.mdc",
    ".github/copilot-instructions.md",
  ]);
  if (mixedProjectionPaths.has(normalized)) {
    return MANAGED_PAYLOAD_OWNERSHIP.MIXED_PROJECTION;
  }

  if (isPathOrChild(normalized, ".agent/workflows")) {
    return normalizedPathSet(managedWorkflowPaths).has(normalized)
      ? MANAGED_PAYLOAD_OWNERSHIP.ENGINE
      : MANAGED_PAYLOAD_OWNERSHIP.PROJECT;
  }

  const projectPrefixes = [
    ".agent/ontology",
    ".agent/rules",
    "plans/knowledge",
    "recipes",
  ];
  if (projectPrefixes.some((prefix) => isPathOrChild(normalized, prefix))) {
    return MANAGED_PAYLOAD_OWNERSHIP.PROJECT;
  }

  if (isPathOrChild(normalized, ".agent/skills/iterative-planner")) {
    return MANAGED_PAYLOAD_OWNERSHIP.ENGINE;
  }

  // Only source-inventory entries under other skill directories are proposed
  // by migration. Classifying that declared distribution surface as engine
  // does not make arbitrary consumer-only skills migration candidates.
  if (isPathOrChild(normalized, ".agent/skills")) {
    return MANAGED_PAYLOAD_OWNERSHIP.ENGINE;
  }

  const engineExactPaths = new Set([
    ".agent/scripts/sync-instructions.sh",
    ".agent/scripts/migrate-all-projects.sh",
    ".agent/gotchas.md",
    ".agent/ADAPTATION-GUIDE.md",
  ]);
  if (engineExactPaths.has(normalized)) {
    return MANAGED_PAYLOAD_OWNERSHIP.ENGINE;
  }

  return MANAGED_PAYLOAD_OWNERSHIP.UNKNOWN;
}
