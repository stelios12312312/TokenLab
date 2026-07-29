#!/usr/bin/env node
// migrate.mjs — Non-destructive planner upgrade for existing projects.
//
// Usage:
//   node migrate.mjs detect <target-project-path>    Detect current planner version + integrity
//   node migrate.mjs upgrade <target-project-path> --commit    Prove and commit upgrades
//   node migrate.mjs upgrade <target-project-path> --commit --seed-kb   Also seed knowledge base
//   node migrate.mjs verify <target-project-path>     Post-upgrade integrity check
//   node migrate.mjs --dry-run upgrade <target-path>  Preview changes without writing
//
// Design rules:
//   - Updates stale files by comparing SHA-256 hashes (RT10-MIGRATE fix)
//   - KB seeding is opt-in (--seed-kb flag)
//   - Tracks planner version in SKILL.md frontmatter
//   - Post-upgrade verification catches missing AND stale files
//   - Dynamic directory scanning (no hardcoded file lists that go stale)
//
// Zero dependencies — Node 18+.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, renameSync, statSync, chmodSync, unlinkSync, realpathSync } from "fs";
import { join, dirname, basename, resolve, relative, extname, sep } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { parseAnnotations, validate as validateAnnotationSet } from "./annotation_parser.mjs";
import {
  readMistakeRegistryEntries,
  validateMistakeOverlayDocument,
} from "./lib/mistake_registry.mjs";
import { createMigrationSourcePin } from "./lib/migration_source_pin.mjs";
import {
  readLearnedObligationRegistryEntries,
  validateLearnedObligationOverlayDocument,
} from "./lib/learned_obligations.mjs";
import { loadRetroRegistry } from "./lib/retro_registry.mjs";
import { summarizeWorkflowIntelligence } from "./lib/workflow_intelligence.mjs";
import {
  HOST_OWNED_WORKFLOW_MARKER,
  validateWorkflowContractSurface,
  workflowFileHasExplicitHostOwnerMarker,
} from "./lib/workflow_contracts.mjs";
import {
  canonicalVerificationStatus,
  verificationStatusIsPass,
} from "./lib/verification_status_vocabulary.mjs";
import {
  inferPersonaAdaptation,
  isProblematicPersonaStatus,
  registryPathFromEnv,
} from "./lib/persona_adaptation.mjs";
import { writePlanWorkOrderProjection } from "./lib/work_order_contract.mjs";
import { attachSemanticHealth } from "./lib/semantic_maintenance.mjs";
import { readStateJson as readPlanStateJson, writeStateJson as writePlanStateJson } from "./lib/determinism.mjs";
import { ensurePlannerPolicy, loadPlannerPolicy } from "./lib/planner_policy.mjs";
import {
  ROOT_INSTRUCTION_SOURCE_OF_TRUTH,
  ROOT_INSTRUCTION_TARGETS,
  ROOT_INSTRUCTION_SECTION_HEADINGS,
  collectCanonicalRootInstructionSections,
  rootInstructionsLookPlannerManaged,
  rootInstructionSnapshotPresent,
  rootInstructionsHaveCurrentFrontDoors,
  renderRootInstructionTarget,
  rootInstructionParityStatus,
} from "./lib/root_instruction_renderer.mjs";
import {
  buildIveMigrationPlan,
  DEFAULT_IVE_PHASE,
  DEFAULT_VALIDATE_PLAN_COUNT,
  findIveBackupRetentionWarnings,
  runIveRecover,
  runIveRollback,
  runIveUpgrade,
  runIveValidateMigration,
} from "./lib/ive_migration_bootstrap.mjs";
import { JOURNAL_REL_PATH, loadJournal } from "./lib/agent_journal.mjs";
import {
  MANAGED_UPGRADE_RECEIPT_RELATIVE_PATH as MANAGED_UPGRADE_RECEIPT_REL_PATH,
  managedUpgradeConsentCommand,
  managedUpgradeDiagnostics,
  managedUpgradeRecoveryCommand,
  readCommittedPlannerVersion,
  recoverManagedUpgrade,
  runManagedUpgradeTransaction,
} from "./lib/managed_upgrade_transaction.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillDir = resolve(scriptDir, "..");
const agentDir = resolve(skillDir, "../..");
const {
  assessManagedSyncSafety,
  canonicalSourceProjectPath,
  gitPath,
  managedDisplayPath,
  printManagedSyncRefusal,
  runFromPinnedSourceSnapshot,
  selectedSourceCommit,
  selectedSourceRef,
  sourcePathHasHistory,
} = createMigrationSourcePin({ agentDir, fileHash, normalizeComparablePath });

// Read version from single source of truth
const versionJsonPath = join(skillDir, "config", "version.json");
const CURRENT_VERSION = existsSync(versionJsonPath)
  ? JSON.parse(readFileSync(versionJsonPath, "utf-8")).version
  : "3.0.0"; // fallback if version.json missing (should not happen)
const discoveryBenchmarkConfigPath = join(skillDir, "config", "knowledge_benchmark_real_projects.json");
const archetypeProfilesConfigPath = join(skillDir, "config", "archetype_profiles.json");

const PRE_COMMIT_SECTION_MARKER = "# --- iterative-planner ripple-check hook ---";
const PRE_COMMIT_DIRECT_MARKER = "iterative-planner managed pre-commit hook";
const LEGACY_PRE_COMMIT_SENTINEL = "Planner files staged — running ripple-through check...";
const CONFLICTED_COPY_PATTERN = /conflicted copy/i;
const RUN_NODE_COMMAND = "sh .agent/skills/iterative-planner/scripts/hooks/run-node.sh";
const TELEMETRY_HOOK_COMMAND = `${RUN_NODE_COMMAND} .agent/skills/iterative-planner/scripts/hooks/post_tool_use.mjs`;
const TELEMETRY_SETTINGS_CANDIDATES = [
  [".claude", "settings.local.json"],
  [".claude", "settings.json"],
  [".cursor", "settings.json"],
];
const ANNOTATION_SURFACE_EXTENSIONS = new Set([
  ".py", ".js", ".mjs", ".ts", ".tsx", ".pl", ".rs", ".go", ".rb", ".sh",
  ".yaml", ".yml", ".toml", ".r", ".jl", ".php", ".java", ".c", ".cpp",
  ".h", ".swift", ".kt",
]);
const ANNOTATION_SURFACE_SKIP_SEGMENTS = new Set([
  ".agent", "plans", "reports", "node_modules", "dist", "build", ".next",
  "coverage", "Iterative Planner",
]);
const HIGH_SIGNAL_ANNOTATION_KEYS = Object.freeze([
  "story",
  "proves",
  "validation_module",
  "config_flag",
  "mutually_exclusive",
]);
const DEFAULT_MIGRATION_WAVE_EXCLUSIONS = Object.freeze([
  "Tesseract Automation Engine",
  "EVL Trader",
  "IPBS",
  "Tennis",
]);
const SETUP_PROFILES = new Set(["full", "kernel"]);
const KERNEL_INSTRUCTIONS_REL_PATH = "AGENTS.md";
const KERNEL_INSTRUCTION_MARKER = "## Iterative Planner Kernel";
const KERNEL_SEED_ID = "J-KERNEL-SEED";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(path) {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function isManagedPreCommitHook(content) {
  return content.includes(PRE_COMMIT_SECTION_MARKER) ||
    content.includes(PRE_COMMIT_DIRECT_MARKER) ||
    content.includes("scripts/pre_commit_policy.mjs") ||
    content.includes("scripts/ripple_check.mjs") ||
    content.includes(LEGACY_PRE_COMMIT_SENTINEL);
}

function renderManagedPreCommitSection(content) {
  return `${PRE_COMMIT_SECTION_MARKER}\n${content.replace(/^#!.*\n/, "")}\n${PRE_COMMIT_SECTION_MARKER} end\n`;
}

function refreshManagedPreCommitHook(existing, sourceContent) {
  if (!existing.includes(PRE_COMMIT_SECTION_MARKER)) return sourceContent;

  const lines = existing.split("\n");
  const startIdx = lines.findIndex((line) => line.includes(PRE_COMMIT_SECTION_MARKER));
  const endIdx = lines.findIndex((line, index) => index > startIdx && line.includes(`${PRE_COMMIT_SECTION_MARKER} end`));
  if (startIdx === -1 || endIdx === -1) return existing;

  const section = renderManagedPreCommitSection(sourceContent).trimEnd().split("\n");
  lines.splice(startIdx, endIdx - startIdx + 1, ...section);
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

function runNode(args, options = {}) {
  return execFileSync(process.execPath, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

function isConflictedCopyArtifact(name) {
  return CONFLICTED_COPY_PATTERN.test(String(name || ""));
}

function listManagedDirNames(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !isConflictedCopyArtifact(name))
    .filter((name) => predicate(name));
}

function listManagedDirEntries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !isConflictedCopyArtifact(entry.name));
}

function findConflictedCopyArtifacts(rootPath) {
  const matches = [];
  if (!existsSync(rootPath)) return matches;

  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (isConflictedCopyArtifact(entry.name)) matches.push(full);
    }
  }

  scan(rootPath);
  return matches;
}

/** Recursively list all files under dir matching a filter function. */
function walkDir(dir, filter = () => true) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of listManagedDirEntries(dir)) {
    const full = join(dir, entry.name);
    // F-015 FIX: Skip symlinks to prevent infinite recursion from symlink loops
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...walkDir(full, filter));
    } else if (filter(entry.name, full)) {
      results.push(full);
    }
  }
  return results;
}

function findRootInstructionTemplatePath(targetBase) {
  const candidates = [
    join(targetBase, "references", basename(ROOT_INSTRUCTION_SOURCE_OF_TRUTH.template_path)),
    join(agentDir, "..", "CLAUDE.md"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

// ---------------------------------------------------------------------------
// Manifest: the canonical list of everything that should exist after migration
// ---------------------------------------------------------------------------

function buildExpectedManifest(targetPath) {
  const base = join(targetPath, ".agent/skills/iterative-planner");
  const entries = [];

  // Standalone planner files
  const standaloneSkillFiles = [
    { path: "SKILL.md", category: "core", critical: true },
    { path: "MIGRATION.md", category: "docs", critical: false },
    { path: "QUICKSTART.md", category: "docs", critical: false },
    { path: "ERROR-RECOVERY.md", category: "docs", critical: false },
    { path: "EDGE-CASES.md", category: "docs", critical: false },
    { path: "audit.config.example.json", category: "config", critical: false },
    { path: "mcp_server.mjs", category: "mcp", critical: false },
  ];
  for (const entry of standaloneSkillFiles) {
    if (existsSync(join(skillDir, entry.path))) {
      entries.push({ path: join(base, entry.path), category: entry.category, critical: entry.critical });
    }
  }

  // Scripts — scan source dynamically
  const sourceScripts = listManagedDirNames(scriptDir, (f) => f.endsWith(".mjs") || f.endsWith(".sh"));
  for (const f of sourceScripts) {
    entries.push({ path: join(base, "scripts", f), category: "scripts", critical: true });
  }

  // Hook scripts
  const sourceHooksDir = join(scriptDir, "hooks");
  if (existsSync(sourceHooksDir)) {
    for (const f of walkDir(sourceHooksDir, (name) => !name.startsWith("."))) {
      const relPath = relative(sourceHooksDir, f);
      entries.push({ path: join(base, "scripts/hooks", relPath), category: "hook-scripts", critical: false });
    }
  }

  // Script libraries
  const sourceLibDir = join(scriptDir, "lib");
  if (existsSync(sourceLibDir)) {
    for (const f of listManagedDirNames(sourceLibDir)) {
      if (f.endsWith(".mjs") || f.endsWith(".md")) {
        entries.push({ path: join(base, "scripts/lib", f), category: "lib", critical: true });
      }
    }
  }

  // Prolog rules
  const sourcePrologDir = join(skillDir, "prolog");
  if (existsSync(sourcePrologDir)) {
    for (const f of listManagedDirNames(sourcePrologDir, (f) => f.endsWith(".pl"))) {
      entries.push({ path: join(base, "prolog", f), category: "prolog", critical: true });
    }
  }

  // Config
  const sourceConfigDir = join(skillDir, "config");
  if (existsSync(sourceConfigDir)) {
    for (const f of listManagedDirNames(sourceConfigDir, (name) =>
      (name.endsWith(".json") && name !== basename(MANAGED_UPGRADE_RECEIPT_REL_PATH))
        || name.endsWith(".schema.json")
        || name === ".checklist_integrity"
        || name.endsWith(".yaml")
    )) {
      entries.push({ path: join(base, "config", f), category: "config", critical: true });
    }
  }

  // Checklists
  const sourceChecklistsDir = join(skillDir, "checklists");
  if (existsSync(sourceChecklistsDir)) {
    for (const f of listManagedDirNames(sourceChecklistsDir, (f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
      entries.push({ path: join(base, "checklists", f), category: "checklists", critical: true });
    }
    // Domain checklists
    const sourceDomainsDir = join(sourceChecklistsDir, "domains");
    if (existsSync(sourceDomainsDir)) {
      for (const f of listManagedDirNames(sourceDomainsDir, (f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
        entries.push({ path: join(base, "checklists/domains", f), category: "domain-checklists", critical: false });
      }
    }
  }

  // References
  const sourceRefsDir = join(skillDir, "references");
  if (existsSync(sourceRefsDir)) {
    for (const f of listManagedDirNames(sourceRefsDir, (f) => f.endsWith(".md"))) {
      entries.push({ path: join(base, "references", f), category: "references", critical: false });
    }
  }

  // Analyzers
  const sourceAnalyzersDir = join(skillDir, "analyzers");
  if (existsSync(sourceAnalyzersDir)) {
    for (const f of listManagedDirNames(sourceAnalyzersDir, (f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
      entries.push({ path: join(base, "analyzers", f), category: "analyzers", critical: false });
    }
  }

  // Tests (golden tests + fixtures). Keep every supported proof asset format
  // atomic with the test modules that consume it.
  const sourceTestsDir = join(skillDir, "tests");
  if (existsSync(sourceTestsDir)) {
    for (const f of walkDir(sourceTestsDir, (name) =>
      name.endsWith(".mjs")
        || name.endsWith(".json")
        || name.endsWith(".jsonl")
        || name.endsWith(".md")
        || name.endsWith(".html")
    )) {
      const relPath = relative(sourceTestsDir, f);
      entries.push({ path: join(base, "tests", relPath), category: "tests", critical: false });
    }
  }

  // Packs (domain packs — quant, ux_ui, etc.)
  const sourcePacksDir = join(skillDir, "packs");
  if (existsSync(sourcePacksDir)) {
    for (const f of walkDir(sourcePacksDir, (name) => name.endsWith(".mjs") || name.endsWith(".pl") || name.endsWith(".md") || name.endsWith(".json"))) {
      const relPath = relative(sourcePacksDir, f);
      entries.push({ path: join(base, "packs", relPath), category: "packs", critical: false });
    }
  }

  // IVE runtime profiles
  const sourceProfilesDir = join(skillDir, "profiles");
  if (existsSync(sourceProfilesDir)) {
    for (const f of walkDir(sourceProfilesDir, (name) => name.endsWith(".json") || name.endsWith(".md"))) {
      const relPath = relative(sourceProfilesDir, f);
      entries.push({ path: join(base, "profiles", relPath), category: "profiles", critical: false });
    }
  }

  // IVE reference knowledge packs
  const sourceKnowledgePacksDir = join(skillDir, "knowledge_packs");
  if (existsSync(sourceKnowledgePacksDir)) {
    for (const f of walkDir(sourceKnowledgePacksDir, (name) => name.endsWith(".json") || name.endsWith(".md"))) {
      const relPath = relative(sourceKnowledgePacksDir, f);
      entries.push({ path: join(base, "knowledge_packs", relPath), category: "knowledge-packs", critical: false });
    }
  }

  // Workflows — scan source dynamically
  const sourceWorkflowsDir = join(agentDir, "workflows");
  if (existsSync(sourceWorkflowsDir)) {
    for (const f of listManagedDirNames(sourceWorkflowsDir, (f) => f.endsWith(".md"))) {
      entries.push({ path: join(targetPath, ".agent/workflows", f), category: "workflows", critical: true });
    }
  }

  // Agent-level files
  const agentFiles = ["rules.md", "gotchas.md", "ADAPTATION-GUIDE.md"];
  for (const f of agentFiles) {
    if (existsSync(join(agentDir, f))) {
      entries.push({ path: join(targetPath, ".agent", f), category: "agent-config", critical: false });
    }
  }

  // Agent scripts (non-skill)
  const agentScriptFiles = ["sync-instructions.sh", "migrate-all-projects.sh"];
  for (const f of agentScriptFiles) {
    if (existsSync(join(agentDir, "scripts", f))) {
      entries.push({ path: join(targetPath, ".agent/scripts", f), category: "agent-scripts", critical: false });
    }
  }

  // Root instruction files
  // Project-specific customization is expected, so content drift is advisory.
  for (const f of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
    entries.push({
      path: join(targetPath, f),
      category: "root-instructions",
      critical: true,
      allow_content_drift: true,
    });
  }

  // Other skills (red-team-remediation, etc.)
  const sourceSkillsDir = join(agentDir, "skills");
  if (existsSync(sourceSkillsDir)) {
    for (const skillName of listManagedDirNames(sourceSkillsDir)) {
      if (skillName === "iterative-planner") continue; // handled above
      const skillPath = join(sourceSkillsDir, skillName);
      if (!statSync(skillPath).isDirectory()) continue;
      for (const f of walkDir(skillPath, (name) => name.endsWith(".md"))) {
        const relPath = relative(sourceSkillsDir, f);
        entries.push({ path: join(targetPath, ".agent/skills", relPath), category: `skill-${skillName}`, critical: false });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

function detectVersion(targetSkillMd) {
  const content = readFile(targetSkillMd);
  if (!content) return { version: "0.0.0", reason: "SKILL.md not found", confidence: "FAILED" };

  // Check for version marker in frontmatter
  const versionMatch = content.match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/);
  if (versionMatch) return { version: versionMatch[1], reason: "Version marker found", confidence: "HIGH" };

  // RP-014: Heuristic detection — confidence is LOW because keyword matching
  // can be fooled by comments, changelogs, or documentation mentioning features.
  const hasVerifyGate = content.includes("verify_gate.mjs");
  const hasDriftDetection = content.includes("Drift Detection");
  const hasDiagnosticFirst = content.includes("Diagnostic-First");
  const hasChecklistRunner = content.includes("checklist_runner.mjs");

  if (hasVerifyGate && hasDriftDetection && hasDiagnosticFirst && hasChecklistRunner) {
    return { version: "2.0.0", reason: "All v2.0 features detected (heuristic)", confidence: "LOW" };
  }
  if (hasVerifyGate) {
    return { version: "1.5.0", reason: "verify_gate present but missing P1 gates (heuristic)", confidence: "LOW" };
  }

  const hasKBGate = content.includes("Knowledge Base Gate");
  const hasRootCause = content.includes("Root Cause Verification");
  const hasAdjacency = content.includes("Adjacency Discovery");
  const hasBatchMode = content.includes("Autonomous Batch Mode");

  if (hasKBGate && hasRootCause && hasAdjacency && hasBatchMode) {
    return { version: "1.0.0", reason: "All v1.0 features present, missing enforcement scripts (heuristic)", confidence: "LOW" };
  }

  if (hasKBGate) {
    return { version: "0.9.0", reason: "KB Gate present, partial v1.0 (heuristic)", confidence: "LOW" };
  }

  return { version: "0.5.0", reason: "Basic SKILL.md without gates (heuristic)", confidence: "LOW" };
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Default KB templates — single source of truth for cmdUpgrade and cmdSetup. */
const KB_INDEX_TEMPLATE = `# Knowledge Base Index

| File | Topics |
|------|--------|
| [mistakes.md](mistakes.md) | Recurring mistakes and antipatterns |
| [patterns.md](patterns.md) | Proven implementation patterns |
| [gotchas.md](gotchas.md) | Non-obvious traps and constraints |
| [retros/retro_ledger.json](retros/retro_ledger.json) | Structured retro archive with promotion decisions and case-file pointers |
`;
const RETRO_LEDGER_TEMPLATE = JSON.stringify({ version: 1, retros: [] }, null, 2) + "\n";
const KB_DEFAULTS = {
  "index.md": KB_INDEX_TEMPLATE,
  "mistakes.md": `# Mistakes\n\nRecurring mistakes and antipatterns. Format: \`M-NNN: Short title (date)\`.\n\n<!-- Next mistake: M-001 -->\n`,
  "patterns.md": `# Patterns\n\nProven implementation patterns. Record what worked so future plans can reuse it.\n\nFormat: \`P-NNN: Short title (date)\` — What worked, why it worked, when to apply it.\n\n<!-- Next pattern: P-001 -->\n`,
  "gotchas.md": `# Gotchas\n\nNon-obvious traps and constraints. Format: \`G-NNN: Short title (date)\`.\n\n<!-- Next gotcha: G-001 -->\n`,
};
const DEFAULT_DRAFT_CANDIDATES_REVIEW_RELATIVE_PATH = "plans/knowledge/draft_candidates.review.json";
const APPROVED_DRAFT_REVIEW_STATUSES = new Set(["approved", "promote", "promoted"]);

// ---------------------------------------------------------------------------
// File upgrade operations
// ---------------------------------------------------------------------------

function fileHash(path) {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return null; }
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeComparablePath(path) {
  if (typeof path !== "string" || !path.trim()) return null;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitCommand(targetPath, args, options = {}) {
  return execFileSync("git", ["-C", targetPath, ...args], {
    encoding: options.encoding === null ? null : "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitCommandSucceeds(targetPath, args) {
  try {
    gitCommand(targetPath, args);
    return true;
  } catch {
    return false;
  }
}

function pathIsInside(rootPath, candidatePath) {
  const normalizedRoot = resolve(rootPath);
  const normalizedCandidate = resolve(candidatePath);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function parseChecklistDecisionRef(decisionRef) {
  const match = String(decisionRef || "").match(/^([^#]+)#(D-[A-Za-z0-9_-]+)$/);
  if (!match) {
    throw new Error("--decision-ref must be a plans/plan_*/decisions.md#D-* reference");
  }
  const decisionPath = gitPath(match[1]);
  if (!/^plans\/plan_[^/]+\/decisions\.md$/.test(decisionPath)) {
    throw new Error("--decision-ref must resolve to plans/plan_*/decisions.md inside the target repository");
  }
  return { decisionPath, decisionId: match[2] };
}

function checklistIntegrityTimestamp() {
  const raw = process.env.CHECKLIST_INTEGRITY_TIMESTAMP || new Date().toISOString();
  const timestamp = new Date(raw);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("CHECKLIST_INTEGRITY_TIMESTAMP must be a valid ISO-8601 timestamp when provided");
  }
  return timestamp.toISOString();
}

function loadChecklistIntegrityProjection(targetPath, checklistName, decisionRef) {
  if (!/^[a-z0-9_-]+$/.test(String(checklistName || ""))) {
    throw new Error("--checklist must contain only lower-case letters, digits, underscores, or hyphens");
  }

  const targetRoot = realpathSync(targetPath);
  const gitRoot = realpathSync(String(gitCommand(targetRoot, ["rev-parse", "--show-toplevel"])).trim());
  if (gitRoot !== targetRoot) {
    throw new Error(`target must be the Git worktree root (resolved ${gitRoot})`);
  }

  const checklistBase = ".agent/skills/iterative-planner/checklists";
  const yamlRel = `${checklistBase}/${checklistName}.yaml`;
  const ymlRel = `${checklistBase}/${checklistName}.yml`;
  const checklistRel = existsSync(join(targetRoot, yamlRel)) ? yamlRel : ymlRel;
  const checklistPath = join(targetRoot, checklistRel);
  if (!existsSync(checklistPath)) throw new Error(`checklist not found: ${yamlRel} or ${ymlRel}`);
  const checklistRealPath = realpathSync(checklistPath);
  if (!pathIsInside(targetRoot, checklistRealPath)) throw new Error("checklist resolves outside the target repository");
  if (!gitCommandSucceeds(targetRoot, ["ls-files", "--error-unmatch", "--", checklistRel])) {
    throw new Error(`checklist must be tracked at HEAD: ${checklistRel}`);
  }
  const worktreeClean = gitCommandSucceeds(targetRoot, ["diff", "--quiet", "--", checklistRel]);
  const indexClean = gitCommandSucceeds(targetRoot, ["diff", "--cached", "--quiet", "--", checklistRel]);
  if (!worktreeClean || !indexClean) {
    throw new Error(`checklist must be clean in both worktree and index: ${checklistRel}`);
  }

  const headBytes = gitCommand(targetRoot, ["show", `HEAD:${checklistRel}`], { encoding: null });
  const worktreeBytes = readFileSync(checklistRealPath);
  if (!Buffer.from(headBytes).equals(worktreeBytes)) {
    throw new Error(`checklist worktree bytes do not equal HEAD: ${checklistRel}`);
  }

  const registryRel = ".agent/skills/iterative-planner/config/.checklist_integrity";
  const registryPath = join(targetRoot, registryRel);
  if (!existsSync(registryPath)) throw new Error(`checklist integrity registry not found: ${registryRel}`);
  const registryRealPath = realpathSync(registryPath);
  if (!pathIsInside(targetRoot, registryRealPath)) throw new Error("checklist integrity registry resolves outside the target repository");
  if (!gitCommandSucceeds(targetRoot, ["ls-files", "--error-unmatch", "--", registryRel])) {
    throw new Error(`checklist integrity registry must be tracked: ${registryRel}`);
  }
  if (!gitCommandSucceeds(targetRoot, ["diff", "--quiet", "--", registryRel]) ||
      !gitCommandSucceeds(targetRoot, ["diff", "--cached", "--quiet", "--", registryRel])) {
    throw new Error(`checklist integrity registry must be clean before regeneration: ${registryRel}`);
  }
  const registryText = readFileSync(registryRealPath, "utf-8");
  let registry;
  try {
    registry = JSON.parse(registryText);
  } catch (error) {
    throw new Error(`checklist integrity registry is invalid JSON: ${error.message}`);
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("checklist integrity registry must be a JSON object");
  }
  if (!Object.prototype.hasOwnProperty.call(registry, checklistName) ||
      typeof registry[checklistName] !== "string" || !registry[checklistName]) {
    throw new Error(`refusing lazy baseline: registry has no existing entry for ${checklistName}`);
  }

  const parsedDecision = parseChecklistDecisionRef(decisionRef);
  const decisionPath = join(targetRoot, parsedDecision.decisionPath);
  if (!existsSync(decisionPath)) throw new Error(`decision file not found: ${parsedDecision.decisionPath}`);
  const decisionRealPath = realpathSync(decisionPath);
  if (!pathIsInside(targetRoot, decisionRealPath)) throw new Error("decision file resolves outside the target repository");
  const decisionText = readFileSync(decisionRealPath, "utf-8");
  const escapedDecisionId = parsedDecision.decisionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decisionHeading = new RegExp(`^## ${escapedDecisionId}(?::|\\s*$)`, "m");
  if (!decisionHeading.test(decisionText)) {
    throw new Error(`decision heading not found: ## ${parsedDecision.decisionId}`);
  }

  const checklistSha256 = sha256Bytes(headBytes);
  const registryHash = checklistSha256.slice(0, 32);
  if (registry[checklistName] === registryHash) {
    throw new Error(`registry entry already matches clean HEAD for ${checklistName}; regeneration is unnecessary`);
  }
  const projectedRegistry = { ...registry, [checklistName]: registryHash };
  const projectedRegistryText = `${JSON.stringify(projectedRegistry, null, 2)}\n`;
  const headSha = String(gitCommand(targetRoot, ["rev-parse", "HEAD"])).trim();

  return {
    targetRoot,
    headSha,
    checklistName,
    checklistRel,
    checklistPath: checklistRealPath,
    checklistSha256,
    registryHash,
    registryRel,
    registryPath: registryRealPath,
    registry,
    registryText,
    registrySha256: sha256Bytes(registryText),
    projectedRegistry,
    projectedRegistryText,
    projectedRegistrySha256: sha256Bytes(projectedRegistryText),
    previousValue: registry[checklistName],
    decisionRef,
    decisionPath: parsedDecision.decisionPath,
    decisionId: parsedDecision.decisionId,
    decisionSha256: sha256Bytes(decisionText),
    cleanliness: {
      tracked: true,
      worktree_clean: worktreeClean,
      index_clean: indexClean,
      worktree_matches_head: true,
    },
  };
}

function checklistIntegrityReceipt(snapshot, timestamp, receiptRel) {
  return {
    schema_version: "checklist_integrity_regeneration_receipt.v1",
    status: "PASS",
    operation: "regenerate-checklist-integrity",
    mode: "write",
    recorded_at: timestamp,
    source: {
      target_root: snapshot.targetRoot,
      head_sha: snapshot.headSha,
    },
    authorization: {
      decision_ref: snapshot.decisionRef,
      decision_path: snapshot.decisionPath,
      decision_id: snapshot.decisionId,
      decision_sha256: snapshot.decisionSha256,
    },
    checklist: {
      name: snapshot.checklistName,
      path: snapshot.checklistRel,
      sha256: snapshot.checklistSha256,
      registry_hash: snapshot.registryHash,
    },
    registry: {
      path: snapshot.registryRel,
      previous_value: snapshot.previousValue,
      new_value: snapshot.registryHash,
      sha256_before: snapshot.registrySha256,
      sha256_after: snapshot.projectedRegistrySha256,
      sibling_entries_unchanged: true,
    },
    cleanliness: snapshot.cleanliness,
    receipt_path: receiptRel,
  };
}

function emitChecklistIntegrityResult(result, jsonOutput) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`Checklist integrity regeneration ${result.mode}: PASS`);
    console.log(`  Checklist: ${result.checklist.path}`);
    console.log(`  HEAD:      ${result.source.head_sha}`);
    console.log(`  Decision:  ${result.authorization.decision_ref}`);
    console.log(`  Registry:  ${result.registry.previous_value} -> ${result.registry.new_value}`);
    if (result.receipt_path) console.log(`  Receipt:   ${result.receipt_path}`);
  } else {
    console.error(`Checklist integrity regeneration: FAIL\n  ${result.reason}`);
  }
}

function cmdRegenerateChecklistIntegrity(targetPath, { checklistName, decisionRef, dryRun, write, jsonOutput }) {
  try {
    if (dryRun && write) throw new Error("--dry-run and --write are mutually exclusive");
    if (!checklistName) throw new Error("--checklist is required");
    if (!decisionRef) throw new Error("--decision-ref is required");
    const mode = write ? "write" : "dry-run";
    const initial = loadChecklistIntegrityProjection(targetPath, checklistName, decisionRef);
    const baseResult = {
      ok: true,
      status: "PASS",
      operation: "regenerate-checklist-integrity",
      mode,
      source: { target_root: initial.targetRoot, head_sha: initial.headSha },
      authorization: {
        decision_ref: initial.decisionRef,
        decision_path: initial.decisionPath,
        decision_id: initial.decisionId,
        decision_sha256: initial.decisionSha256,
      },
      checklist: {
        name: initial.checklistName,
        path: initial.checklistRel,
        sha256: initial.checklistSha256,
        registry_hash: initial.registryHash,
      },
      registry: {
        path: initial.registryRel,
        previous_value: initial.previousValue,
        new_value: initial.registryHash,
        sha256_before: initial.registrySha256,
        sha256_after: initial.projectedRegistrySha256,
        sibling_entries_unchanged: true,
      },
      cleanliness: initial.cleanliness,
      receipt_path: null,
    };

    if (!write) {
      emitChecklistIntegrityResult(baseResult, jsonOutput);
      return;
    }

    const fresh = loadChecklistIntegrityProjection(targetPath, checklistName, decisionRef);
    const unchanged = [
      ["HEAD", initial.headSha, fresh.headSha],
      ["checklist hash", initial.checklistSha256, fresh.checklistSha256],
      ["decision digest", initial.decisionSha256, fresh.decisionSha256],
      ["registry digest", initial.registrySha256, fresh.registrySha256],
    ];
    const changed = unchanged.find(([, before, after]) => before !== after);
    if (changed) throw new Error(`${changed[0]} changed between preflight and write; refusing regeneration`);

    const timestamp = checklistIntegrityTimestamp();
    const stamp = timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const receiptRel = `reports/ive/checklist_integrity_regenerations/checklist_integrity_regeneration_${stamp}_${checklistName}_${fresh.headSha.slice(0, 12)}.json`;
    const receiptPath = join(fresh.targetRoot, receiptRel);
    if (existsSync(receiptPath)) throw new Error(`receipt already exists: ${receiptRel}`);
    ensureDir(dirname(receiptPath));
    const receipt = checklistIntegrityReceipt(fresh, timestamp, receiptRel);
    const nonce = `${process.pid}.${Date.now()}`;
    const registryTmp = `${fresh.registryPath}.${nonce}.new.tmp`;
    const rollbackTmp = `${fresh.registryPath}.${nonce}.rollback.tmp`;
    const receiptTmp = `${receiptPath}.${nonce}.tmp`;
    let registryReplaced = false;
    try {
      writeFileSync(registryTmp, fresh.projectedRegistryText);
      writeFileSync(rollbackTmp, fresh.registryText);
      writeFileSync(receiptTmp, `${JSON.stringify(receipt, null, 2)}\n`);
      renameSync(registryTmp, fresh.registryPath);
      registryReplaced = true;
      try {
        renameSync(receiptTmp, receiptPath);
      } catch (error) {
        renameSync(rollbackTmp, fresh.registryPath);
        registryReplaced = false;
        throw new Error(`receipt finalization failed; registry restored: ${error.message}`);
      }
      try { if (existsSync(rollbackTmp)) unlinkSync(rollbackTmp); } catch { /* best-effort cleanup */ }
    } catch (error) {
      if (registryReplaced && existsSync(rollbackTmp)) {
        try { renameSync(rollbackTmp, fresh.registryPath); } catch (rollbackError) {
          throw new Error(`regeneration failed and registry rollback failed: ${error.message}; ${rollbackError.message}`);
        }
      }
      for (const tempPath of [registryTmp, rollbackTmp, receiptTmp]) {
        try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
      }
      throw error;
    }

    emitChecklistIntegrityResult({ ...baseResult, mode: "write", receipt_path: receiptRel }, jsonOutput);
  } catch (error) {
    const failure = {
      ok: false,
      status: "FAIL",
      operation: "regenerate-checklist-integrity",
      mode: write ? "write" : "dry-run",
      reason: error.message,
      durable_state: "inspect reported reason; failed writes are rolled back when possible and never emit a PASS result",
    };
    emitChecklistIntegrityResult(failure, jsonOutput);
    process.exit(1);
  }
}

function readJsonSafe(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function makeSemanticIssue(surface, code, severity, path, message, command = null) {
  return { surface, code, severity, path, message, command };
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()))]
    : [];
}

function normalizeSelector(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function selectorsFromProject(project) {
  return [
    project?.name,
    basename(project?.path || ""),
    project?.path,
  ].map(normalizeSelector).filter(Boolean);
}

function projectMatchesSelector(project, selector) {
  const normalizedSelector = normalizeSelector(selector);
  if (!normalizedSelector) return false;
  return selectorsFromProject(project).some((candidate) =>
    candidate === normalizedSelector ||
    candidate.includes(normalizedSelector) ||
    normalizedSelector.includes(candidate)
  );
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveDraftCandidatesReviewPath(targetPath, draftCandidatesPathArg = null) {
  const rawValue = firstNonEmptyString(draftCandidatesPathArg) || DEFAULT_DRAFT_CANDIDATES_REVIEW_RELATIVE_PATH;
  return {
    raw: rawValue,
    absolute: resolve(targetPath, rawValue),
  };
}

function buildKnowledgePromotionCommand(targetPath, draftCandidatesPathArg = DEFAULT_DRAFT_CANDIDATES_REVIEW_RELATIVE_PATH) {
  return `node .agent/skills/iterative-planner/scripts/migrate.mjs promote-knowledge "${targetPath}" --draft-candidates "${draftCandidatesPathArg}" --write`;
}

function normalizeReviewedDraftPromotionTarget(target, kind) {
  const normalized = normalizeToken(target);
  if (["mistake_overrides", "mistake_registry", "mistake_overlay"].includes(normalized)) return "mistake_overrides";
  if (["learned_obligation_overrides", "learned_obligation_overlay", "learned_obligations", "obligation_overrides"].includes(normalized)) return "learned_obligation_overrides";
  if (kind === "mistake") return "mistake_overrides";
  if (kind === "learned_obligation") return "learned_obligation_overrides";
  return null;
}

function normalizeReviewedDraftKind(value) {
  const normalized = normalizeToken(value);
  if (normalized === "mistake") return "mistake";
  if (["learned_obligation", "obligation"].includes(normalized)) return "learned_obligation";
  return null;
}

function summarizeReviewedDraftCandidate(candidate, extra = {}) {
  return {
    id: candidate.id,
    kind: candidate.kind,
    title: candidate.title,
    summary: candidate.summary,
    source_refs: candidate.source_refs,
    linked_ids: candidate.linked_ids,
    matched_by: candidate.matched_by,
    score: candidate.score,
    trust_level: candidate.trust_level,
    blocking_capable: candidate.blocking_capable,
    review_status: candidate.review_status,
    promotion_target: candidate.promotion_target,
    overlay_id: extra.overlay_id || null,
    source: "reviewed_draft",
  };
}

function loadReviewedDraftCandidates(reviewPath) {
  if (!existsSync(reviewPath)) {
    return {
      path: reviewPath,
      present: false,
      usable: true,
      error: null,
      reviewed_candidates: [],
      approved_candidates: [],
      invalid_candidates: [],
      issues: [],
    };
  }

  const parsed = readJsonSafe(reviewPath);
  if (!parsed.ok) {
    return {
      path: reviewPath,
      present: true,
      usable: false,
      error: "invalid_json",
      reviewed_candidates: [],
      approved_candidates: [],
      invalid_candidates: [],
      issues: ["draft_candidates.review.json is not valid JSON"],
    };
  }

  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return {
      path: reviewPath,
      present: true,
      usable: false,
      error: "invalid_shape",
      reviewed_candidates: [],
      approved_candidates: [],
      invalid_candidates: [],
      issues: ["draft_candidates.review.json must be a JSON object"],
    };
  }

  if ("reviewed_candidates" in parsed.value && !Array.isArray(parsed.value.reviewed_candidates)) {
    return {
      path: reviewPath,
      present: true,
      usable: false,
      error: "invalid_reviewed_candidates_array",
      reviewed_candidates: [],
      approved_candidates: [],
      invalid_candidates: [],
      issues: ["draft_candidates.review.json must expose a reviewed_candidates array"],
    };
  }

  const candidates = [];
  const approved = [];
  const invalid = [];
  const issues = [];
  const seenIds = new Set();

  for (const [index, raw] of (parsed.value.reviewed_candidates || []).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      invalid.push({ index, reason: "invalid_entry" });
      issues.push(`reviewed_candidates[${index}] is not a valid object`);
      continue;
    }

    const id = firstNonEmptyString(raw.id);
    const kind = normalizeReviewedDraftKind(raw.kind);
    const overlayEntry = raw.overlay_entry && typeof raw.overlay_entry === "object" && !Array.isArray(raw.overlay_entry)
      ? raw.overlay_entry
      : null;
    const title = firstNonEmptyString(raw.title, overlayEntry?.title, overlayEntry?.subject_id, id);
    const summary = firstNonEmptyString(raw.summary, overlayEntry?.summary, `Reviewed draft candidate ${id || index + 1}`);
    const reviewStatus = normalizeToken(raw.review_status || "pending");
    const trustLevel = normalizeToken(raw.trust_level || "draft") === "draft" ? "draft" : "draft";
    const promotionTarget = normalizeReviewedDraftPromotionTarget(raw.promotion_target, kind);

    if (!id) {
      invalid.push({ index, reason: "missing_id" });
      issues.push(`reviewed_candidates[${index}] is missing a stable id`);
      continue;
    }
    if (seenIds.has(id)) {
      invalid.push({ index, reason: "duplicate_id", id });
      issues.push(`draft candidate id '${id}' is repeated`);
      continue;
    }
    seenIds.add(id);

    if (!kind) {
      invalid.push({ index, id, reason: "invalid_kind" });
      issues.push(`draft candidate '${id}' must declare kind=mistake or kind=learned_obligation`);
      continue;
    }
    if (!overlayEntry) {
      invalid.push({ index, id, reason: "missing_overlay_entry" });
      issues.push(`draft candidate '${id}' must include an overlay_entry object`);
      continue;
    }
    if (!promotionTarget) {
      invalid.push({ index, id, reason: "invalid_promotion_target" });
      issues.push(`draft candidate '${id}' has an unsupported promotion_target`);
      continue;
    }

    const candidate = {
      id,
      kind,
      title,
      summary,
      source_refs: normalizeStringArray(raw.source_refs),
      linked_ids: normalizeStringArray(raw.linked_ids),
      matched_by: normalizeStringArray(raw.matched_by),
      score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
      trust_level: trustLevel,
      blocking_capable: false,
      review_status: reviewStatus,
      promotion_target: promotionTarget,
      overlay_entry: overlayEntry,
    };
    candidates.push(candidate);
    if (APPROVED_DRAFT_REVIEW_STATUSES.has(reviewStatus)) approved.push(candidate);
  }

  return {
    path: reviewPath,
    present: true,
    usable: true,
    error: null,
    reviewed_candidates: candidates,
    approved_candidates: approved,
    invalid_candidates: invalid,
    issues,
  };
}

function buildReviewedDraftPromotionCandidates(reviewSurface) {
  const registryCandidates = [];
  const obligationCandidates = [];
  const mistakeOverlayCandidates = [];
  const learnedObligationOverlayCandidates = [];
  const skippedCandidates = [];

  for (const candidate of reviewSurface.approved_candidates || []) {
    const overlay = candidate.overlay_entry || {};
    if (candidate.kind === "mistake" && candidate.promotion_target === "mistake_overrides") {
      const overlayId = firstNonEmptyString(overlay.id);
      const title = firstNonEmptyString(overlay.title, candidate.title);
      const summary = firstNonEmptyString(overlay.summary, candidate.summary);
      if (!overlayId || !title || !summary) {
        skippedCandidates.push({ id: candidate.id, reason: "invalid_mistake_overlay_entry" });
        continue;
      }

      mistakeOverlayCandidates.push({
        ...overlay,
        id: overlayId,
        title,
        summary,
        source_kb_ref: firstNonEmptyString(overlay.source_kb_ref, candidate.source_refs[0]),
        status: "draft",
        promotion_notes: firstNonEmptyString(
          overlay.promotion_notes,
          `Promoted from reviewed draft candidate ${candidate.id}; remains inert until separately approved or activated.`
        ),
      });
      registryCandidates.push(summarizeReviewedDraftCandidate(candidate, { overlay_id: overlayId }));
      continue;
    }

    if (candidate.kind === "learned_obligation" && candidate.promotion_target === "learned_obligation_overrides") {
      const overlayId = firstNonEmptyString(overlay.id);
      const subjectId = firstNonEmptyString(overlay.subject_id, overlay.subjectId);
      const verificationMode = firstNonEmptyString(overlay.verification_mode, overlay.mode);
      if (!overlayId || !subjectId || !verificationMode) {
        skippedCandidates.push({ id: candidate.id, reason: "invalid_learned_obligation_overlay_entry" });
        continue;
      }

      learnedObligationOverlayCandidates.push({
        ...overlay,
        id: overlayId,
        subject_id: subjectId,
        verification_mode: verificationMode,
        source_kb_ref: firstNonEmptyString(overlay.source_kb_ref, candidate.source_refs[0]),
        status: "draft",
        promotion_notes: firstNonEmptyString(
          overlay.promotion_notes,
          `Promoted from reviewed draft candidate ${candidate.id}; remains inert until separately approved or activated.`
        ),
      });
      obligationCandidates.push(summarizeReviewedDraftCandidate(candidate, { overlay_id: overlayId }));
      continue;
    }

    skippedCandidates.push({ id: candidate.id, reason: "unsupported_candidate_target" });
  }

  return {
    reviewed_candidates: [
      ...registryCandidates,
      ...obligationCandidates,
    ],
    registry_candidates: registryCandidates,
    obligation_candidates: obligationCandidates,
    mistake_overlay_candidates: mistakeOverlayCandidates,
    learned_obligation_overlay_candidates: learnedObligationOverlayCandidates,
    skipped_candidates: skippedCandidates,
  };
}

function mergePromotionCandidates(primary, secondary, key = "id") {
  const merged = new Map();
  for (const item of [...(primary || []), ...(secondary || [])]) {
    if (!item || !item[key]) continue;
    merged.set(item[key], item);
  }
  return [...merged.values()];
}

function normalizeDiscoveryPolicyRecommendation(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const normalized = {};
  if (typeof policy.archetype === "string" && policy.archetype.trim()) normalized.archetype = policy.archetype.trim();
  if (normalizeStringArray(policy.enabled_matchers).length > 0) normalized.enabled_matchers = normalizeStringArray(policy.enabled_matchers);
  if (normalizeStringArray(policy.disabled_matchers).length > 0) normalized.disabled_matchers = normalizeStringArray(policy.disabled_matchers);
  if (normalizeStringArray(policy.preferred_personas).length > 0) normalized.preferred_personas = normalizeStringArray(policy.preferred_personas);
  if (normalizeStringArray(policy.preferred_workflows).length > 0) normalized.preferred_workflows = normalizeStringArray(policy.preferred_workflows);
  if (normalizeStringArray(policy.preferred_recipes).length > 0) normalized.preferred_recipes = normalizeStringArray(policy.preferred_recipes);
  if (normalizeStringArray(policy.required_secondary_signals).length > 0) normalized.required_secondary_signals = normalizeStringArray(policy.required_secondary_signals);
  if (policy.thresholds && typeof policy.thresholds === "object" && !Array.isArray(policy.thresholds)) {
    normalized.thresholds = policy.thresholds;
  }
  if (policy.search_policy && typeof policy.search_policy === "object" && !Array.isArray(policy.search_policy)) {
    normalized.search_policy = {};
    if (typeof policy.search_policy.allow_tier2 === "boolean") normalized.search_policy.allow_tier2 = policy.search_policy.allow_tier2;
    if (typeof policy.search_policy.prefer_early_stop === "boolean") normalized.search_policy.prefer_early_stop = policy.search_policy.prefer_early_stop;
    if (Object.keys(normalized.search_policy).length === 0) delete normalized.search_policy;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function loadDiscoveryPolicyScaffolds() {
  const parsed = readJsonSafe(discoveryBenchmarkConfigPath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return [];
  return Array.isArray(parsed.value.cohorts) ? parsed.value.cohorts : [];
}

function findDiscoveryPolicyScaffold(targetPath) {
  const resolvedTarget = resolve(targetPath);
  for (const cohort of loadDiscoveryPolicyScaffolds()) {
    const pathFragments = normalizeStringArray(cohort.path_fragments);
    if (pathFragments.length === 0) continue;
    if (!pathFragments.some((fragment) => resolvedTarget.includes(fragment))) continue;
    const recommendedPolicy = normalizeDiscoveryPolicyRecommendation(cohort.recommended_policy);
    if (!recommendedPolicy) continue;
    return {
      cohort_id: cohort.id || null,
      archetype: cohort.archetype || recommendedPolicy.archetype || null,
      label: cohort.label || null,
      path_fragments: pathFragments,
      goal: typeof cohort.goal === "string" ? cohort.goal : null,
      recommended_policy: recommendedPolicy,
    };
  }
  return null;
}

function buildDiscoveryPolicyScaffoldReport(targetPath) {
  const path = join(targetPath, "planner.discovery.json");
  const scaffold = findDiscoveryPolicyScaffold(targetPath);
  return {
    target_path: targetPath,
    discovery_policy_path: path,
    discovery_policy_present: existsSync(path),
    matched: !!scaffold,
    scaffold,
    recommended_command: scaffold
      ? `node .agent/skills/iterative-planner/scripts/migrate.mjs scaffold-discovery-policy "${targetPath}" --write`
      : null,
  };
}

function validateDiscoveryPolicySurface(targetPath) {
  const path = join(targetPath, "planner.discovery.json");
  const scaffold = buildDiscoveryPolicyScaffoldReport(targetPath);
  const result = {
    owner: "host-project",
    mutation_policy: "preserve",
    path,
    present: existsSync(path),
    usable: false,
    archetype: null,
    enabled_matchers: [],
    scaffold_available: !!scaffold.scaffold && !existsSync(path),
    recommended_scaffold: scaffold.scaffold
      ? {
        cohort_id: scaffold.scaffold.cohort_id,
        archetype: scaffold.scaffold.archetype,
        label: scaffold.scaffold.label,
        recommended_policy: scaffold.scaffold.recommended_policy,
        recommended_command: scaffold.recommended_command,
      }
      : null,
    issues: [],
  };
  if (!result.present) return result;

  const parsed = readJsonSafe(path);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    result.issues.push(
      makeSemanticIssue(
        "planner.discovery.json",
        "invalid_discovery_policy",
        "error",
        path,
        "planner.discovery.json is missing valid JSON object structure",
        "Review planner.discovery.json and rerun `node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json`."
      )
    );
    return result;
  }

  const policy = parsed.value;
  const matcherFields = ["enabled_matchers", "disabled_matchers"];
  for (const field of matcherFields) {
    if (field in policy && !Array.isArray(policy[field])) {
      result.issues.push(
        makeSemanticIssue(
          "planner.discovery.json",
          `invalid_${field}`,
          "error",
          path,
          `${field} must be an array when present`,
          "Normalize planner.discovery.json matcher fields to arrays."
        )
      );
    }
  }
  if ("thresholds" in policy && (!policy.thresholds || typeof policy.thresholds !== "object" || Array.isArray(policy.thresholds))) {
    result.issues.push(
      makeSemanticIssue(
        "planner.discovery.json",
        "invalid_thresholds",
        "error",
        path,
        "thresholds must be an object when present",
        "Normalize planner.discovery.json thresholds to an object keyed by matcher family."
      )
    );
  }

  result.archetype = typeof policy.archetype === "string" ? policy.archetype : null;
  result.enabled_matchers = Array.isArray(policy.enabled_matchers) ? policy.enabled_matchers : [];
  result.usable = result.issues.length === 0;
  return result;
}

function validateAuditConfigSurface(targetPath) {
  const path = join(targetPath, "audit.config.json");
  const result = {
    owner: "host-project",
    mutation_policy: "preserve",
    path,
    present: existsSync(path),
    usable: false,
    roles: [],
    issues: [],
  };
  if (!result.present) return result;

  const parsed = readJsonSafe(path);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    result.issues.push(
      makeSemanticIssue(
        "audit.config.json",
        "invalid_audit_config",
        "error",
        path,
        "audit.config.json is missing valid JSON object structure",
        "Review audit.config.json and rerun `node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json`."
      )
    );
    return result;
  }

  const config = parsed.value;
  if (!Array.isArray(config.roles)) {
    result.issues.push(
      makeSemanticIssue(
        "audit.config.json",
        "invalid_roles",
        "error",
        path,
        "audit.config.json.roles must be an array",
        "Set audit.config.json roles to an array of persona pack ids."
      )
    );
  }
  result.roles = Array.isArray(config.roles) ? config.roles : [];
  result.usable = result.issues.length === 0;
  return result;
}

function personaAdaptationSeverity(status) {
  if (status === "blocked_invalid_config") return "error";
  if (status === "underfit_advisory") return "info";
  if (status === "underfit_high_confidence" || status === "unused" || status === "overactive") return "warning";
  return "info";
}

function personaAdaptationMessage(report) {
  if (report.status === "blocked_invalid_config") {
    return `Persona adaptation cannot inspect roles because audit.config.json is invalid: ${report.audit_config_error || "invalid JSON"}.`;
  }
  if (report.status === "underfit_high_confidence") {
    return `Project evidence strongly recommends missing persona seed roles: ${(report.missing_seed_roles || []).join(", ") || "unknown"}.`;
  }
  if (report.status === "underfit_advisory") {
    return `Project evidence may warrant additional persona seed roles: ${(report.missing_seed_roles || []).join(", ") || "unknown"}.`;
  }
  if (report.status === "unused") {
    return "Recent serious plans did not produce persona guidance, constraints, or findings.";
  }
  if (report.status === "overactive") {
    return "Recent trivial plans repeatedly produced high-severity persona blockers.";
  }
  return `Persona adaptation status is ${report.status}.`;
}

function validatePersonaAdaptationSurface(targetPath) {
  const report = inferPersonaAdaptation(targetPath, { commandTarget: targetPath });
  const result = {
    owner: "host-project",
    mutation_policy: "additive-safe-apply",
    path: report.audit_config_path || targetPath,
    present: true,
    usable: report.status !== "blocked_invalid_config",
    status: report.status,
    confidence: report.confidence,
    domain_profiles: report.domain_profiles,
    configured_roles: report.configured_roles,
    recommended_seed_roles: report.recommended_seed_roles,
    expected_companions: report.expected_companions,
    missing_seed_roles: report.missing_seed_roles,
    usage: report.usage,
    recommended_command: report.recommended_command,
    issues: [],
  };

  if (isProblematicPersonaStatus(report.status)) {
    const command = report.status === "blocked_invalid_config"
      ? "Review audit.config.json and rerun `node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json`."
      : report.recommended_command;
    result.issues.push(
      makeSemanticIssue(
        "persona_adaptation",
        `persona_${report.status}`,
        personaAdaptationSeverity(report.status),
        result.path,
        personaAdaptationMessage(report),
        command
      )
    );
  }

  return result;
}

function validateRecipeSurface(targetPath) {
  const recipesDir = join(targetPath, "recipes");
  const entityRegistryPath = join(recipesDir, "entity_registry.json");
  const capabilityRegistryPath = join(recipesDir, "capability_registry.json");
  const discoveryReviewPath = join(recipesDir, "discovery_review.json");
  const result = {
    owner: "host-project",
    mutation_policy: "preserve",
    path: recipesDir,
    present: existsSync(recipesDir),
    usable: false,
    configured_surface: false,
    discovery_review_present: existsSync(discoveryReviewPath),
    entity_registry_present: existsSync(entityRegistryPath),
    capability_registry_present: existsSync(capabilityRegistryPath),
    recipe_count: 0,
    invalid_recipe_files: [],
    issues: [],
  };
  if (!result.present) return result;

  const recipeDirs = readdirSync(recipesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const dir of recipeDirs) {
    const recipePath = join(recipesDir, dir, "recipe.json");
    if (!existsSync(recipePath)) continue;
    result.recipe_count += 1;
    const parsed = readJsonSafe(recipePath);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      result.invalid_recipe_files.push(recipePath);
      result.issues.push(
        makeSemanticIssue(
          "recipes",
          "invalid_recipe_json",
          "error",
          recipePath,
          `recipe.json in ${dir} is missing valid JSON object structure`,
          `Review ${relative(targetPath, recipePath)} and rerun recipe bootstrap or tidy.`
        )
      );
      continue;
    }
    if (typeof parsed.value.id !== "string" || !parsed.value.id) {
      result.invalid_recipe_files.push(recipePath);
      result.issues.push(
        makeSemanticIssue(
          "recipes",
          "recipe_missing_id",
          "error",
          recipePath,
          `recipe.json in ${dir} is missing a stable id`,
          `Add a stable id to ${relative(targetPath, recipePath)}.`
        )
      );
    }
  }

  for (const [surface, path, code] of [
    ["recipes", entityRegistryPath, "invalid_entity_registry"],
    ["recipes", capabilityRegistryPath, "invalid_capability_registry"],
  ]) {
    if (!existsSync(path)) continue;
    const parsed = readJsonSafe(path);
    if (!parsed.ok) {
      result.issues.push(
        makeSemanticIssue(
          surface,
          code,
          "error",
          path,
          `${basename(path)} is not valid JSON`,
          `Review ${relative(targetPath, path)} and rerun recipe tidy/bootstrap.`
        )
      );
    }
  }

  result.configured_surface = result.entity_registry_present || result.capability_registry_present || result.recipe_count > 0;
  if (result.recipe_count > 0 && (!result.entity_registry_present || !result.capability_registry_present)) {
    result.issues.push(
      makeSemanticIssue(
        "recipes",
        "missing_recipe_registry",
        "error",
        recipesDir,
        "Recipe folders exist without both entity_registry.json and capability_registry.json",
        "Run `/recipe-tidy` or `recipe_bootstrap.mjs` to restore the deterministic registry surface."
      )
    );
  }
  result.usable = result.issues.length === 0;
  return result;
}

function validateStoryRegistrySurface(targetPath) {
  const path = join(targetPath, "reports", "user_story_audit", "story_registry.json");
  const result = {
    owner: "host-project",
    mutation_policy: "preserve",
    path,
    present: existsSync(path),
    usable: false,
    story_count: 0,
    issues: [],
  };
  if (!result.present) return result;

  const parsed = readJsonSafe(path);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    result.issues.push(
      makeSemanticIssue(
        "story_registry",
        "invalid_story_registry",
        "error",
        path,
        "story_registry.json is missing valid JSON object structure",
        "Run `node .agent/skills/iterative-planner/scripts/story_registry.mjs check --json` and repair the registry."
      )
    );
    return result;
  }

  const stories = parsed.value.stories;
  if (!Array.isArray(stories)) {
    result.issues.push(
      makeSemanticIssue(
        "story_registry",
        "invalid_story_array",
        "error",
        path,
        "story_registry.json must expose a stories array",
        "Repair story_registry.json so the top-level stories field is an array."
      )
    );
    return result;
  }

  result.story_count = stories.length;
  result.usable = true;
  return result;
}

function countJsonlRecords(path) {
  if (!existsSync(path)) return { line_count: 0, latest_at: null };
  const content = readFile(path) || "";
  let latestAt = null;
  try {
    latestAt = statSync(path).mtime.toISOString();
  } catch {
    latestAt = null;
  }
  return {
    line_count: content.split("\n").filter((line) => line.trim()).length,
    latest_at: latestAt,
  };
}

function listPlanDirectories(targetPath) {
  const plansDir = join(targetPath, "plans");
  if (!existsSync(plansDir)) return [];
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("plan_"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function buildTraceHookInstallCommand(targetPath) {
  return `cd "${targetPath}" && ${RUN_NODE_COMMAND} .agent/skills/iterative-planner/scripts/hooks/install.mjs --trace-hook`;
}

function validateTelemetryCaptureSurface(targetPath) {
  const determinismPath = join(targetPath, ".agent", "skills", "iterative-planner", "config", "determinism.json");
  const determinism = readJsonSafe(determinismPath);
  const toolTraceEnabled = determinism.ok && determinism.value?.features?.tool_trace?.enabled === true;
  const proofTelemetryEnabled = determinism.ok && determinism.value?.features?.proof_telemetry?.enabled === true;
  const planDirs = listPlanDirectories(targetPath);
  const settingsFiles = TELEMETRY_SETTINGS_CANDIDATES.map((segments) => {
    const path = join(targetPath, ...segments);
    const present = existsSync(path);
    const parsed = present ? readJsonSafe(path) : null;
    const content = present ? readFile(path) || "" : "";
    return {
      path,
      relative_path: relative(targetPath, path),
      present,
      valid_json: !present || !!parsed?.ok,
      hook_configured: present && /post_tool_use\.mjs/.test(content),
    };
  });

  let toolTracePlanCount = 0;
  let toolTraceLineCount = 0;
  let latestToolTraceAt = null;
  let proofTelemetryPlanCount = 0;
  let proofTelemetryEventCount = 0;
  let proofTelemetrySummaryCount = 0;
  let latestProofTelemetryAt = null;

  for (const planDirName of planDirs) {
    const toolTrace = countJsonlRecords(join(targetPath, "plans", planDirName, "artifacts", "tool_trace.jsonl"));
    if (toolTrace.line_count > 0) {
      toolTracePlanCount++;
      toolTraceLineCount += toolTrace.line_count;
      if (toolTrace.latest_at && (!latestToolTraceAt || toolTrace.latest_at > latestToolTraceAt)) {
        latestToolTraceAt = toolTrace.latest_at;
      }
    }

    const proofTelemetry = countJsonlRecords(join(targetPath, "plans", planDirName, "telemetry", "events.jsonl"));
    if (proofTelemetry.line_count > 0) {
      proofTelemetryPlanCount++;
      proofTelemetryEventCount += proofTelemetry.line_count;
      if (proofTelemetry.latest_at && (!latestProofTelemetryAt || proofTelemetry.latest_at > latestProofTelemetryAt)) {
        latestProofTelemetryAt = proofTelemetry.latest_at;
      }
    }

    if (existsSync(join(targetPath, "plans", planDirName, "telemetry", "summary.json"))) {
      proofTelemetrySummaryCount++;
    }
  }

  const hookConfigured = settingsFiles.some((file) => file.hook_configured);
  const configPresent = settingsFiles.some((file) => file.present);
  const invalidSettings = settingsFiles.filter((file) => file.present && !file.valid_json);
  const readinessRequired = toolTraceEnabled || proofTelemetryEnabled;
  const result = {
    owner: "host-project",
    mutation_policy: "preserve_or_append",
    path: join(targetPath, ".claude"),
    present: configPresent,
    usable: readinessRequired ? hookConfigured : true,
    tool_trace_enabled: toolTraceEnabled,
    proof_telemetry_enabled: proofTelemetryEnabled,
    settings_files: settingsFiles,
    hook_configured: hookConfigured,
    plan_count: planDirs.length,
    tool_trace_plan_count: toolTracePlanCount,
    tool_trace_line_count: toolTraceLineCount,
    latest_tool_trace_at: latestToolTraceAt,
    proof_telemetry_plan_count: proofTelemetryPlanCount,
    proof_telemetry_event_count: proofTelemetryEventCount,
    proof_telemetry_summary_count: proofTelemetrySummaryCount,
    latest_proof_telemetry_at: latestProofTelemetryAt,
    issues: [],
  };

  if (invalidSettings.length > 0) {
    result.issues.push(
      makeSemanticIssue(
        "telemetry_capture",
        "invalid_telemetry_settings_json",
        "info",
        invalidSettings[0].path,
        "A supported IDE settings file exists but is not valid JSON, so telemetry hook readiness cannot be trusted from that file",
        buildTraceHookInstallCommand(targetPath)
      )
    );
  }

  if (readinessRequired && !hookConfigured) {
    result.issues.push(
      makeSemanticIssue(
        "telemetry_capture",
        "missing_post_tool_use_hook",
        "info",
        join(targetPath, ".claude"),
        "tool_trace/proof_telemetry features are enabled, but no supported IDE settings file configures the PostToolUse telemetry hook",
        buildTraceHookInstallCommand(targetPath)
      )
    );
  }

  if (planDirs.length > 0 && toolTraceLineCount === 0) {
    result.issues.push(
      makeSemanticIssue(
        "telemetry_capture",
        "no_tool_trace_history",
        "info",
        join(targetPath, "plans"),
        "Planner history exists but no tool_trace.jsonl records are stored under any plan artifacts directory",
        buildTraceHookInstallCommand(targetPath)
      )
    );
  }

  if (planDirs.length > 0 && proofTelemetryEnabled && proofTelemetryEventCount === 0) {
    result.issues.push(
      makeSemanticIssue(
        "telemetry_capture",
        "no_proof_telemetry_history",
        "info",
        join(targetPath, "plans"),
        "Planner history exists but no proof telemetry events are stored under any plan telemetry directory",
        buildTraceHookInstallCommand(targetPath)
      )
    );
  }

  if (toolTraceLineCount > 0 && proofTelemetryEnabled && proofTelemetryEventCount === 0) {
    result.issues.push(
      makeSemanticIssue(
        "telemetry_capture",
        "trace_without_proof_telemetry",
        "info",
        join(targetPath, "plans"),
        "Tool traces exist, but proof telemetry events are still absent, so the fleet captures read traces without the advisory proof-telemetry layer",
        buildTraceHookInstallCommand(targetPath)
      )
    );
  }

  return result;
}

function validateWorkflowIntelligenceSurface(targetPath) {
  const summary = summarizeWorkflowIntelligence(targetPath);
  const result = {
    owner: "host-project",
    mutation_policy: "preserve_or_append",
    path: summary.path,
    present: summary.present,
    usable: summary.usable,
    plan_count: summary.plan_count,
    audit_count: summary.audit_count,
    audit_counts: summary.audit_counts,
    advisor_audit_count: summary.advisor_audit_count,
    workflow_events_supported: summary.workflow_events_supported,
    workflow_event_count: summary.workflow_event_count,
    invalid_workflow_event_count: summary.invalid_workflow_event_count,
    tracked_workflows: summary.tracked_workflows,
    workflows: summary.workflows,
    stewardship_reports: summary.stewardship_reports,
    sme_improvement_reports: summary.sme_improvement_reports,
    issues: [],
  };

  for (const issue of summary.issues || []) {
    result.issues.push(
      makeSemanticIssue(
        "workflow_intelligence",
        issue.code,
        issue.severity || "info",
        issue.path || summary.path,
        issue.message,
        null
      )
    );
  }

  return result;
}

function toRepoRelativePath(targetPath, fullPath) {
  return relative(targetPath, fullPath).replace(/\\/g, "/");
}

function annotationSurfaceIncludesFile(targetPath, fullPath) {
  const relativePath = toRepoRelativePath(targetPath, fullPath);
  if (!relativePath || relativePath.startsWith("..")) return false;
  const segments = relativePath.split("/");
  if (segments.some((segment) => ANNOTATION_SURFACE_SKIP_SEGMENTS.has(segment))) return false;
  return ANNOTATION_SURFACE_EXTENSIONS.has(extname(fullPath).toLowerCase());
}

function buildAnnotateCommand(targetPath, { review = false } = {}) {
  if (review) {
    return `cd "${targetPath}" && node .agent/skills/iterative-planner/scripts/annotation_parser.mjs --validate`;
  }
  return `cd "${targetPath}" && node .agent/skills/iterative-planner/scripts/migrate.mjs annotate . --dry-run`;
}

function validateAnnotationCoverageSurface(targetPath) {
  const files = walkDir(targetPath, (_, fullPath) => annotationSurfaceIncludesFile(targetPath, fullPath))
    .map((fullPath) => toRepoRelativePath(targetPath, fullPath));
  const annotations = [];
  for (const filePath of files) {
    annotations.push(...parseAnnotations(filePath, targetPath));
  }

  const byKey = {};
  for (const annotation of annotations) {
    byKey[annotation.key] = (byKey[annotation.key] || 0) + 1;
  }

  const filesWithAnnotations = new Set(annotations.map((annotation) => annotation.file)).size;
  const highSignalKeysPresent = HIGH_SIGNAL_ANNOTATION_KEYS.filter((key) => (byKey[key] || 0) > 0);
  const highSignalAnnotationCount = highSignalKeysPresent.reduce((sum, key) => sum + (byKey[key] || 0), 0);
  const lowSignalAnnotationCount = byKey.consumer || 0;
  const validation = validateAnnotationSet(annotations, targetPath);
  const failValidation = validation.filter((entry) => entry.severity === "fail");
  const warningValidation = validation.filter((entry) => entry.severity !== "fail");
  const result = {
    owner: "host-project",
    mutation_policy: "preserve_or_append",
    path: targetPath,
    present: annotations.length > 0,
    usable: failValidation.length === 0,
    scanned_file_count: files.length,
    files_with_annotations: filesWithAnnotations,
    total_annotations: annotations.length,
    by_key: byKey,
    high_signal_annotation_count: highSignalAnnotationCount,
    high_signal_keys_present: highSignalKeysPresent,
    low_signal_annotation_count: lowSignalAnnotationCount,
    issues: [],
  };

  if (annotations.length === 0) {
    result.issues.push(
      makeSemanticIssue(
        "annotation_coverage",
        "no_live_annotations",
        "info",
        targetPath,
        "No live @planner: annotations were found outside planner-managed, plan, or report directories.",
        buildAnnotateCommand(targetPath)
      )
    );
  } else if (highSignalAnnotationCount === 0) {
    result.issues.push(
      makeSemanticIssue(
        "annotation_coverage",
        "annotation_surface_low_signal",
        "info",
        targetPath,
        "Live annotations exist, but they only provide low-signal coverage. Add @planner:story, @planner:proves, @planner:validation_module, or config contradiction facts.",
        buildAnnotateCommand(targetPath)
      )
    );
  }

  for (const entry of failValidation) {
    result.issues.push(
      makeSemanticIssue(
        "annotation_coverage",
        "invalid_annotation_surface",
        "error",
        join(targetPath, entry.file),
        entry.error,
        buildAnnotateCommand(targetPath, { review: true })
      )
    );
  }
  for (const entry of warningValidation) {
    result.issues.push(
      makeSemanticIssue(
        "annotation_coverage",
        "annotation_surface_warning",
        "warning",
        join(targetPath, entry.file),
        entry.error,
        buildAnnotateCommand(targetPath, { review: true })
      )
    );
  }

  return result;
}

function validateRootInstructionSurface(targetPath) {
  const path = join(targetPath, "CLAUDE.md");
  const targetBase = join(targetPath, ".agent", "skills", "iterative-planner");
  const templatePath = findRootInstructionTemplatePath(targetBase);
  const templateContent = templatePath ? readFile(templatePath) : null;
  const canonicalSections = collectCanonicalRootInstructionSections(templateContent);
  const content = readFile(path);
  const result = {
    owner: "host-project",
    mutation_policy: "refresh_managed_snapshot",
    path,
    present: existsSync(path),
    usable: false,
    planner_managed_candidate: rootInstructionsLookPlannerManaged(content),
    snapshot_present: rootInstructionSnapshotPresent(content),
    canonical_section_count: canonicalSections.length,
    current_front_doors_present: rootInstructionsHaveCurrentFrontDoors(content, canonicalSections),
    issues: [],
  };

  if (!templateContent || canonicalSections.length !== ROOT_INSTRUCTION_SECTION_HEADINGS.length) {
    result.issues.push(
      makeSemanticIssue(
        "root_instructions",
        "invalid_root_instruction_template",
        "error",
        templatePath || path,
        "The shipped CLAUDE instruction template is missing the canonical workflow/gate snapshot sections required for migration.",
        `Run \`node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest\` in the planner source repo, repair the template, and rerun \`node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade "${targetPath}" --commit\`.`
      )
    );
    return result;
  }

  if (!result.present) {
    result.issues.push(
      makeSemanticIssue(
        "root_instructions",
        "missing_root_instruction_file",
        "error",
        path,
        "CLAUDE.md is missing, so operators have no root instruction surface for current planner workflows.",
        `Run \`node .agent/skills/iterative-planner/scripts/migrate.mjs setup "${targetPath}"\` to recreate the root instruction files.`
      )
    );
    return result;
  }

  if (result.planner_managed_candidate && !result.current_front_doors_present) {
    result.issues.push(
      makeSemanticIssue(
        "root_instructions",
        "stale_root_instruction_front_doors",
        "error",
        path,
        "Planner-managed root instructions do not advertise the current gate flow and workflow catalog.",
        `Run \`node .agent/skills/iterative-planner/scripts/migrate.mjs setup "${targetPath}"\` to refresh the managed planner snapshot, then rerun \`node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json\`.`
      )
    );
  }

  result.usable = result.issues.length === 0;
  return result;
}

function validatePlannerManagedArtifactSurface(targetPath) {
  const path = join(targetPath, ".agent");
  const artifacts = findConflictedCopyArtifacts(path);
  const result = {
    owner: "planner-managed",
    mutation_policy: "replace",
    path,
    present: existsSync(path),
    usable: artifacts.length === 0,
    artifact_count: artifacts.length,
    artifacts: artifacts.map((artifactPath) => relative(targetPath, artifactPath)),
    issues: [],
  };

  if (artifacts.length > 0) {
    result.issues.push(
      makeSemanticIssue(
        "planner_managed_artifacts",
        "planner_conflicted_copy_artifact",
        "error",
        artifacts[0],
        `Planner-managed Dropbox conflicted-copy artifacts detected (${artifacts.length})`,
        `Remove the conflicted-copy artifacts under ${relative(targetPath, path)} and rerun \`node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json\`.`
      )
    );
  }

  return result;
}

function normalizePromotionStatus(value, fallback = "draft") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return ["draft", "approved", "active", "disabled"].includes(normalized) ? normalized : fallback;
}

function stripMarkdownFormatting(value) {
  return String(value || "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .trim();
}

function extractKnowledgeEntrySummary(body) {
  const candidates = [
    body.match(/\*\*What happened:\*\*\s*([^\n]+)/i)?.[1],
    body.match(/\*\*What worked:\*\*\s*([^\n]+)/i)?.[1],
    body.match(/\*\*Rule of thumb:\*\*\s*([^\n]+)/i)?.[1],
    body.match(/\*\*Pattern to break:\*\*\s*([^\n]+)/i)?.[1],
  ]
    .map((value) => stripMarkdownFormatting(value))
    .filter(Boolean);
  if (candidates.length > 0) return candidates[0];

  return body
    .split("\n")
    .map((line) => stripMarkdownFormatting(line))
    .find((line) => line && !line.startsWith("-") && !line.startsWith("<!--")) || "";
}

function extractMarkdownKnowledgeEntries(content, { prefix, sourcePath }) {
  const text = typeof content === "string" ? content : "";
  const matches = [...text.matchAll(new RegExp(`^##+\\s+(${prefix}-\\d+):?\\s*(.+)$`, "gim"))];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const id = String(match[1] || "").trim().toUpperCase();
    const title = stripMarkdownFormatting(match[2] || id);
    const body = text.slice(start, end).trim();
    return {
      id,
      title,
      body,
      summary: extractKnowledgeEntrySummary(body) || title,
      source_kb_ref: `${sourcePath}#${id}`,
    };
  });
}

function classifyKnowledgePromotionCandidate(entry, retroDecision = null) {
  if (retroDecision === "docs_only") return "kb_only";
  if (retroDecision === "registry_guard") return "registry_candidate";
  if (retroDecision === "learned_obligation" || retroDecision === "hard_invariant") return "obligation_candidate";

  const text = `${entry.title}\n${entry.summary}\n${entry.body}`.toLowerCase();
  const registrySignals = [
    "pattern to break",
    "how to prevent",
    "fix applied",
    "rule of thumb",
    "detection:",
    "detection",
    "prevent",
    "guard",
  ];
  const obligationSignals = [
    "verification",
    "evidence",
    "proof",
    "waiver",
    "manual observation",
    "required_by_phase",
    "close gate",
    "responsive",
    "mobile",
  ];
  const isObligation = obligationSignals.some((signal) => text.includes(signal));
  const isRegistry = isObligation || registrySignals.some((signal) => text.includes(signal));
  return isObligation ? "obligation_candidate" : isRegistry ? "registry_candidate" : "kb_only";
}

function findKnowledgePromotionRetroMatch(retroRegistry, entry) {
  const accepted = Array.isArray(retroRegistry?.accepted_retros) ? retroRegistry.accepted_retros : [];
  if (!entry?.source_kb_ref || accepted.length === 0) return null;
  const matches = accepted
    .filter((retro) => Array.isArray(retro.kb_refs) && retro.kb_refs.includes(entry.source_kb_ref))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || a.id.localeCompare(b.id));
  return matches[0] || null;
}

function buildKnowledgePromotionReport(targetPath, { draftCandidatesPathArg = null } = {}) {
  const draftReviewPath = resolveDraftCandidatesReviewPath(targetPath, draftCandidatesPathArg);
  const sourceFiles = {
    mistakes: {
      path: join(targetPath, "plans", "knowledge", "mistakes.md"),
      present: false,
      entry_count: 0,
    },
    patterns: {
      path: join(targetPath, "plans", "knowledge", "patterns.md"),
      present: false,
      entry_count: 0,
    },
    gotchas: {
      path: join(targetPath, "plans", "knowledge", "gotchas.md"),
      present: false,
      entry_count: 0,
    },
    retro_ledger: {
      path: join(targetPath, "plans", "knowledge", "retros", "retro_ledger.json"),
      present: false,
      usable: false,
      accepted_count: 0,
      warning_count: 0,
    },
    reviewed_draft_candidates: {
      path: draftReviewPath.absolute,
      relative_path: draftReviewPath.raw,
      present: false,
      usable: true,
      reviewed_count: 0,
      approved_count: 0,
      invalid_count: 0,
      issue_count: 0,
    },
  };

  const mistakesContent = readFile(sourceFiles.mistakes.path);
  sourceFiles.mistakes.present = !!mistakesContent;
  const mistakeEntries = extractMarkdownKnowledgeEntries(mistakesContent, {
    prefix: "M",
    sourcePath: "plans/knowledge/mistakes.md",
  });
  sourceFiles.mistakes.entry_count = mistakeEntries.length;

  const patternsContent = readFile(sourceFiles.patterns.path);
  sourceFiles.patterns.present = !!patternsContent;
  sourceFiles.patterns.entry_count = extractMarkdownKnowledgeEntries(patternsContent, {
    prefix: "P",
    sourcePath: "plans/knowledge/patterns.md",
  }).length;

  const gotchasContent = readFile(sourceFiles.gotchas.path);
  sourceFiles.gotchas.present = !!gotchasContent;
  sourceFiles.gotchas.entry_count = extractMarkdownKnowledgeEntries(gotchasContent, {
    prefix: "G",
    sourcePath: "plans/knowledge/gotchas.md",
  }).length;
  const retroRegistry = loadRetroRegistry({
    cwd: targetPath,
    ledgerPath: sourceFiles.retro_ledger.path,
  });
  sourceFiles.retro_ledger.present = retroRegistry.present;
  sourceFiles.retro_ledger.usable = retroRegistry.usable;
  sourceFiles.retro_ledger.accepted_count = (retroRegistry.accepted_retros || []).length;
  sourceFiles.retro_ledger.warning_count = (retroRegistry.warnings || []).length;
  const reviewedDraftCandidates = loadReviewedDraftCandidates(draftReviewPath.absolute);
  sourceFiles.reviewed_draft_candidates.present = reviewedDraftCandidates.present;
  sourceFiles.reviewed_draft_candidates.usable = reviewedDraftCandidates.usable;
  sourceFiles.reviewed_draft_candidates.reviewed_count = (reviewedDraftCandidates.reviewed_candidates || []).length;
  sourceFiles.reviewed_draft_candidates.approved_count = (reviewedDraftCandidates.approved_candidates || []).length;
  sourceFiles.reviewed_draft_candidates.invalid_count = (reviewedDraftCandidates.invalid_candidates || []).length;
  sourceFiles.reviewed_draft_candidates.issue_count = (reviewedDraftCandidates.issues || []).length;

  const kbRegistryCandidates = [];
  const kbObligationCandidates = [];
  const kbOnly = [];
  const kbMistakeOverlayCandidates = [];
  const kbLearnedObligationOverlayCandidates = [];

  for (const entry of mistakeEntries) {
    const retroMatch = findKnowledgePromotionRetroMatch(retroRegistry, entry);
    const classification = classifyKnowledgePromotionCandidate(entry, retroMatch?.promotion_decision || null);
    const promotedMistakeId = `KB-${entry.id}`;
    const promotedObligationId = `KB-LO-${entry.id}`;
    const baseCandidate = {
      source_id: entry.id,
      title: entry.title,
      summary: entry.summary,
      source_kb_ref: entry.source_kb_ref,
      classification,
      retro_id: retroMatch?.id || null,
      promotion_decision: retroMatch?.promotion_decision || null,
    };

    if (classification === "kb_only") {
      kbOnly.push(baseCandidate);
      continue;
    }

    kbMistakeOverlayCandidates.push({
      id: promotedMistakeId,
      title: entry.title,
      summary: entry.summary,
      source_kb_ref: entry.source_kb_ref,
      status: "draft",
      promotion_notes: retroMatch
        ? `Auto-scaffolded from ${entry.id} using retro ${retroMatch.id} (${retroMatch.promotion_decision}); add triggers, guards, and verification hooks before approval.`
        : `Auto-scaffolded from ${entry.id}; add triggers, guards, and verification hooks before approval.`,
    });
    kbRegistryCandidates.push({
      ...baseCandidate,
      overlay_id: promotedMistakeId,
      source: "kb",
    });

    if (classification === "obligation_candidate") {
      kbLearnedObligationOverlayCandidates.push({
        id: promotedObligationId,
        source_mistake: promotedMistakeId,
        source_kb_ref: entry.source_kb_ref,
        subject_id: `draft:${entry.id.toLowerCase().replace(/-/g, "_")}`,
        verification_mode: "manual_review",
        severity: "warn_then_fail",
        required_by_phase: "reflect",
        status: "draft",
        promotion_notes: retroMatch
          ? `Auto-scaffolded from ${entry.id} using retro ${retroMatch.id} (${retroMatch.promotion_decision}); replace draft subject_id, verification_mode, and triggers before approval.`
          : `Auto-scaffolded from ${entry.id}; replace draft subject_id, verification_mode, and triggers before approval.`,
      });
      kbObligationCandidates.push({
        ...baseCandidate,
        overlay_id: promotedMistakeId,
        obligation_id: promotedObligationId,
        source: "kb",
      });
    }
  }

  const reviewedDraftPromotions = buildReviewedDraftPromotionCandidates(reviewedDraftCandidates);
  const registryCandidates = mergePromotionCandidates(
    kbRegistryCandidates,
    reviewedDraftPromotions.registry_candidates,
    "overlay_id"
  );
  const obligationCandidates = mergePromotionCandidates(
    kbObligationCandidates,
    reviewedDraftPromotions.obligation_candidates,
    "overlay_id"
  );
  const mistakeOverlayCandidates = mergePromotionCandidates(
    kbMistakeOverlayCandidates,
    reviewedDraftPromotions.mistake_overlay_candidates
  );
  const learnedObligationOverlayCandidates = mergePromotionCandidates(
    kbLearnedObligationOverlayCandidates,
    reviewedDraftPromotions.learned_obligation_overlay_candidates
  );

  return {
    target_path: targetPath,
    source_files: sourceFiles,
    recommended_command: buildKnowledgePromotionCommand(targetPath, draftReviewPath.raw),
    review_surface: {
      path: draftReviewPath.absolute,
      relative_path: draftReviewPath.raw,
      present: reviewedDraftCandidates.present,
      usable: reviewedDraftCandidates.usable,
      reviewed_count: (reviewedDraftCandidates.reviewed_candidates || []).length,
      approved_count: (reviewedDraftCandidates.approved_candidates || []).length,
      promotable_count: reviewedDraftPromotions.reviewed_candidates.length,
      invalid_count: (reviewedDraftCandidates.invalid_candidates || []).length,
      issues: reviewedDraftCandidates.issues,
    },
    candidates: {
      registry_candidates: registryCandidates,
      obligation_candidates: obligationCandidates,
      kb_only: kbOnly,
      mistake_overlay_candidates: mistakeOverlayCandidates,
      learned_obligation_overlay_candidates: learnedObligationOverlayCandidates,
      reviewed_draft_candidates: reviewedDraftPromotions.reviewed_candidates,
      skipped_reviewed_draft_candidates: reviewedDraftPromotions.skipped_candidates,
    },
  };
}

function validateMistakeOverridesSurface(targetPath) {
  const path = join(targetPath, "planner.mistake_overrides.json");
  const registryPath = join(targetPath, ".agent", "skills", "iterative-planner", "config", "mistake_registry.json");
  const { mistakes } = readMistakeRegistryEntries({ registryPath });
  const overlay = validateMistakeOverlayDocument({
    overlayPath: path,
    baseIds: new Set(mistakes.map((mistake) => mistake.id)),
  });
  const result = {
    owner: "host-project",
    mutation_policy: "preserve",
    path,
    present: overlay.present,
    usable: overlay.usable,
    entry_count: overlay.all_entries.length,
    active_count: overlay.active_entries.length,
    draft_count: overlay.draft_entries.length,
    issues: [],
  };
  if (!result.present) return result;
  if (overlay.usable) return result;

  const repairCommand = "Review planner.mistake_overrides.json and rerun `node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json`.";
  const issueMap = {
    invalid_json: makeSemanticIssue("planner.mistake_overrides.json", "invalid_mistake_overrides", "error", path, "planner.mistake_overrides.json is missing valid JSON object structure", repairCommand),
    invalid_shape: makeSemanticIssue("planner.mistake_overrides.json", "invalid_mistake_overrides", "error", path, "planner.mistake_overrides.json is missing valid JSON object structure", repairCommand),
    invalid_mistakes_array: makeSemanticIssue("planner.mistake_overrides.json", "invalid_mistake_overrides_array", "error", path, "planner.mistake_overrides.json must expose a mistakes array", "Normalize planner.mistake_overrides.json so the top-level mistakes field is an array."),
    invalid_entry: makeSemanticIssue("planner.mistake_overrides.json", "invalid_mistake_override_entry", "error", path, "planner.mistake_overrides.json contains an entry that is not a valid object with required fields", "Repair planner.mistake_overrides.json so every mistake override entry is a valid object."),
    missing_id: makeSemanticIssue("planner.mistake_overrides.json", "mistake_override_missing_id", "error", path, "planner.mistake_overrides.json contains an entry without a stable id", "Add a stable id to each planner.mistake_overrides.json entry."),
    duplicate_entry_id: makeSemanticIssue("planner.mistake_overrides.json", "duplicate_mistake_override_id", "error", path, "planner.mistake_overrides.json repeats an id within the host-owned overlay", "Deduplicate planner.mistake_overrides.json ids."),
    invalid_status: makeSemanticIssue("planner.mistake_overrides.json", "invalid_mistake_override_status", "error", path, "planner.mistake_overrides.json contains an unsupported status token", "Use draft, approved, active, or disabled for mistake override statuses."),
    duplicate_overlay_id: makeSemanticIssue("planner.mistake_overrides.json", "duplicate_mistake_override_registry_id", "error", path, "planner.mistake_overrides.json collides with a shipped planner registry id and will be rejected at runtime", "Rename or remove the colliding host-owned overlay id, then rerun `node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json`."),
  };
  result.issues.push(issueMap[overlay.error] || makeSemanticIssue("planner.mistake_overrides.json", "invalid_mistake_overrides", "error", path, "planner.mistake_overrides.json is unusable", repairCommand));
  return result;
}

function validateLearnedObligationOverridesSurface(targetPath) {
  const path = join(targetPath, "planner.learned_obligations.json");
  const registryPath = join(targetPath, ".agent", "skills", "iterative-planner", "config", "learned_obligations.json");
  const { obligations } = readLearnedObligationRegistryEntries({ registryPath });
  const overlay = validateLearnedObligationOverlayDocument({
    overlayPath: path,
    baseIds: new Set(obligations.map((obligation) => obligation.id)),
  });
  const result = {
    owner: "host-project",
    mutation_policy: "preserve",
    path,
    present: overlay.present,
    usable: overlay.usable,
    entry_count: overlay.all_entries.length,
    active_count: overlay.active_entries.length,
    draft_count: overlay.draft_entries.length,
    issues: [],
  };
  if (!result.present) return result;
  if (overlay.usable) return result;

  const repairCommand = "Review planner.learned_obligations.json and rerun `node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json`.";
  const issueMap = {
    invalid_json: makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_overrides", "error", path, "planner.learned_obligations.json is missing valid JSON object structure", repairCommand),
    invalid_shape: makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_overrides", "error", path, "planner.learned_obligations.json is missing valid JSON object structure", repairCommand),
    invalid_obligations_array: makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_overrides_array", "error", path, "planner.learned_obligations.json must expose an obligations array", "Normalize planner.learned_obligations.json so the top-level obligations field is an array."),
    invalid_entry: makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_override_entry", "error", path, "planner.learned_obligations.json contains an entry that is not a valid object with required fields", "Repair planner.learned_obligations.json so every learned-obligation override entry is a valid object."),
    missing_required_fields: makeSemanticIssue("planner.learned_obligations.json", "learned_obligation_override_missing_fields", "error", path, "planner.learned_obligations.json contains an entry missing id, subject_id, or verification_mode", "Add id, subject_id, and verification_mode to each planner.learned_obligations.json entry."),
    duplicate_entry_id: makeSemanticIssue("planner.learned_obligations.json", "duplicate_learned_obligation_override_id", "error", path, "planner.learned_obligations.json repeats an id within the host-owned overlay", "Deduplicate planner.learned_obligations.json ids."),
    invalid_status: makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_override_status", "error", path, "planner.learned_obligations.json contains an unsupported status token", "Use draft, approved, active, or disabled for learned-obligation override statuses."),
    duplicate_overlay_id: makeSemanticIssue("planner.learned_obligations.json", "duplicate_learned_obligation_override_registry_id", "error", path, "planner.learned_obligations.json collides with a shipped planner registry id and will be rejected at runtime", "Rename or remove the colliding host-owned overlay id, then rerun `node .agent/skills/iterative-planner/scripts/migrate.mjs verify-fleet --json`."),
    invalid_template_path: makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_template_path", "error", path, "planner.learned_obligations.json contains a template_path outside templates/personas/", "Use a relative templates/personas/... path or null for advisory-only learned obligations."),
    invalid_acceptance_predicate: makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_acceptance_predicate", "error", path, "planner.learned_obligations.json contains an unsupported or malformed acceptance check", "Use supported predicates such as has_section, regex_match, numeric_range, json_schema, min_word_count, or references_baseline_named."),
    invalid_decision_slot: makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_decision_slot", "error", path, "planner.learned_obligations.json contains a malformed decisions[] slot", "Use non-empty decision ids or objects with id/name/key for decisions[]."),
    unknown_persona: makeSemanticIssue("planner.learned_obligations.json", "unknown_learned_obligation_persona", "error", path, "planner.learned_obligations.json references a persona id that is not known to this planner", "Use a known persona id such as traceability, config_integrity, wiring_auditor, assumptions_challenger, ux_ui, tokenomics, quant, or quant_target."),
  };
  result.issues.push(issueMap[overlay.error] || makeSemanticIssue("planner.learned_obligations.json", "invalid_learned_obligation_overrides", "error", path, "planner.learned_obligations.json is unusable", repairCommand));
  return result;
}

function readOverlayDocument(path, arrayKey) {
  const present = existsSync(path);
  if (!present) {
    return {
      present: false,
      usable: true,
      error: null,
      document: { version: 1, [arrayKey]: [] },
      entries: [],
    };
  }

  const parsed = readJsonSafe(path);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return {
      present: true,
      usable: false,
      error: "invalid_json",
      document: null,
      entries: [],
    };
  }

  if (arrayKey in parsed.value && !Array.isArray(parsed.value[arrayKey])) {
    return {
      present: true,
      usable: false,
      error: `invalid_${arrayKey}_array`,
      document: null,
      entries: [],
    };
  }

  return {
    present: true,
    usable: true,
    error: null,
    document: {
      ...parsed.value,
      version: parsed.value.version || 1,
      [arrayKey]: Array.isArray(parsed.value[arrayKey]) ? parsed.value[arrayKey] : [],
    },
    entries: Array.isArray(parsed.value[arrayKey]) ? parsed.value[arrayKey] : [],
  };
}

function applyOverlayPromotion({ overlayPath, arrayKey, candidates, write, dryRun, semanticValidator = null }) {
  const existing = readOverlayDocument(overlayPath, arrayKey);
  const result = {
    path: overlayPath,
    candidate_count: candidates.length,
    present: existing.present,
    usable: existing.usable,
    error: existing.error,
    existing_count: existing.entries.length,
    added_count: 0,
    final_count: existing.entries.length,
    write_status: candidates.length === 0 ? "no_candidates" : "not_written",
  };

  if (!existing.usable) {
    result.write_status = "blocked_invalid_existing";
    return result;
  }

  if (typeof semanticValidator === "function") {
    const semantic = semanticValidator(overlayPath);
    result.present = semantic.present;
    result.usable = semantic.present ? semantic.usable : existing.usable;
    result.error = semantic.error;
    result.existing_count = Math.max(existing.entries.length, semantic.all_entries.length);
    result.final_count = result.existing_count;
    if (semantic.present && !semantic.usable) {
      result.write_status = "blocked_invalid_existing";
      return result;
    }
  }

  if (candidates.length === 0) return result;

  const existingIds = new Set(
    existing.entries
      .map((entry) => (entry && typeof entry.id === "string" ? entry.id.trim() : ""))
      .filter(Boolean)
  );
  const additions = candidates.filter((candidate) => !existingIds.has(candidate.id));
  result.added_count = additions.length;
  result.final_count = existing.entries.length + additions.length;

  if (additions.length === 0) {
    result.write_status = existing.present ? "preserved_existing" : "no_candidates";
    return result;
  }

  if (!write) {
    result.write_status = existing.present ? "not_written" : "not_written";
    return result;
  }

  if (dryRun) {
    result.write_status = existing.present ? "would_merge_existing" : "would_write";
    return result;
  }

  ensureDir(dirname(overlayPath));
  const document = {
    ...existing.document,
    version: existing.document.version || 1,
    [arrayKey]: [...existing.entries, ...additions],
  };
  writeFileSync(overlayPath, `${JSON.stringify(document, null, 2)}\n`);
  result.write_status = existing.present ? "merged_existing" : "written";
  return result;
}

function collectSecondPassSemanticVerification(targetPath) {
  const hostProjectSurfaces = collectHostProjectSurfaceStatus(targetPath);
  const plannerManagedSurfaces = {
    migration_hygiene: validatePlannerManagedArtifactSurface(targetPath),
  };
  const surfaces = {
    ...hostProjectSurfaces,
    ...plannerManagedSurfaces,
  };
  const issues = Object.values(surfaces).flatMap((surface) => surface.issues || []);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const recommendedCommands = [...new Set(issues.map((issue) => issue.command).filter(Boolean))];

  return {
    status: errorCount > 0 ? "FAIL" : warningCount > 0 ? "WARN" : "PASS",
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    checked_surfaces: Object.keys(surfaces),
    issues,
    recommended_commands: recommendedCommands,
    host_project_surfaces: hostProjectSurfaces,
    planner_managed_surfaces: plannerManagedSurfaces,
    surfaces,
  };
}

function normalizedComparisonHash(path, opts = {}) {
  const name = basename(path);
  if (name !== ".project_registry.json") return fileHash(path);

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const sourceProjectPath = typeof opts.sourceProjectPath === "string"
      ? opts.sourceProjectPath
      : parsed?.source_project_path;
    const normalized = {
      source_project_path: normalizeComparablePath(sourceProjectPath),
    };
    return createHash("sha256").update(stableJsonStringify(normalized)).digest("hex");
  } catch {
    return fileHash(path);
  }
}

/**
 * Find manifest entries whose destination exists but content differs from source.
 * Used by both cmdUpgrade (to count changes) and cmdVerify (to report staleness).
 */
function findStaleFiles(manifest, targetPath) {
  const stale = [];
  for (const e of manifest) {
    if (e.allow_content_drift) continue;
    if (!existsSync(e.path)) continue;
    const relToTarget = relative(join(targetPath, ".agent"), e.path);
    const sourcePath = join(agentDir, relToTarget);
    if (existsSync(sourcePath)) {
      const srcH = normalizedComparisonHash(sourcePath, { sourceProjectPath: canonicalSourceProjectPath() });
      const destH = normalizedComparisonHash(e.path);
      if (srcH && destH && srcH !== destH) stale.push(e);
    }
  }
  return stale;
}

function loadRootInstructionCanonical(targetPath) {
  const targetBase = join(targetPath, ".agent", "skills", "iterative-planner");
  const templatePath = findRootInstructionTemplatePath(targetBase);
  const templateContent = templatePath ? readFile(templatePath) : null;
  const canonicalSections = collectCanonicalRootInstructionSections(templateContent);
  return {
    targetBase,
    templatePath,
    templateContent,
    canonicalSections,
    valid: !!templateContent && canonicalSections.length === ROOT_INSTRUCTION_SECTION_HEADINGS.length,
  };
}

function syncRootInstructionSurfaces(targetPath, { dryRun = false, log = null } = {}) {
  const canonical = loadRootInstructionCanonical(targetPath);
  const report = {
    source_of_truth: ROOT_INSTRUCTION_SOURCE_OF_TRUTH,
    template_path: canonical.templatePath,
    status: canonical.valid ? "ok" : "invalid_template",
    dry_run: dryRun,
    targets: [],
  };

  if (!canonical.valid) {
    if (log) log.push("  SKIP: root instruction template is missing required canonical sections");
    return report;
  }

  for (const target of ROOT_INSTRUCTION_TARGETS) {
    const targetPathAbs = join(targetPath, target.path);
    const exists = existsSync(targetPathAbs);
    if (!exists && !target.create_by_default) {
      const entry = {
        id: target.id,
        path: target.path,
        agents: target.agents,
        status: "skipped_optional_absent",
        changed: false,
        managed: false,
      };
      report.targets.push(entry);
      continue;
    }

    const existingContent = exists ? readFile(targetPathAbs) || "" : "";
    const rendered = renderRootInstructionTarget({
      target,
      exists,
      content: existingContent,
      templateContent: canonical.templateContent,
      canonicalSections: canonical.canonicalSections,
    });
    const entry = {
      id: target.id,
      path: target.path,
      agents: target.agents,
      status: rendered.status,
      changed: rendered.changed,
      managed: rendered.managed,
    };
    report.targets.push(entry);

    if (rendered.changed && rendered.managed && !dryRun) {
      ensureDir(dirname(targetPathAbs));
      writeFileSync(targetPathAbs, rendered.content);
    }
  }

  if (log) {
    const changed = report.targets.filter((entry) => entry.changed).length;
    const managed = report.targets.filter((entry) => entry.managed).length;
    log.push(`  ROOT SNAPSHOT: ${changed} changed, ${managed} managed target(s), source=${ROOT_INSTRUCTION_SOURCE_OF_TRUTH.template_path}`);
    for (const entry of report.targets) {
      if (entry.status === "skipped_optional_absent") continue;
      log.push(`    ${entry.status.toUpperCase()}: ${entry.path} (${entry.agents.join(", ")})`);
    }
  }

  return report;
}

function findRootInstructionSyncIssues(targetPath) {
  const canonical = loadRootInstructionCanonical(targetPath);
  if (!canonical.valid) return [];

  const advisories = [];
  for (const target of ROOT_INSTRUCTION_TARGETS) {
    const absolutePath = join(targetPath, target.path);
    const exists = existsSync(absolutePath);
    if (!exists && !target.create_by_default) continue;
    const content = exists ? readFile(absolutePath) || "" : "";
    const status = rootInstructionParityStatus({
      target,
      exists,
      content,
      canonicalSections: canonical.canonicalSections,
    });

    if (status === "stale_snapshot" || status === "missing_snapshot") {
      advisories.push({
        path: absolutePath,
        category: "root-instructions",
        critical: false,
        code: status === "stale_snapshot" ? "stale_root_instruction_snapshot" : "missing_root_instruction_snapshot",
        repair_via: "sync-instructions.sh",
      });
      continue;
    }

    if (
      exists &&
      rootInstructionsLookPlannerManaged(content) &&
      !rootInstructionsHaveCurrentFrontDoors(content, canonical.canonicalSections)
    ) {
      advisories.push({
        path: absolutePath,
        category: "root-instructions",
        critical: false,
        code: "stale_root_instruction_front_doors",
        repair_via: "setup",
      });
    }
  }
  return advisories;
}

function findVerificationDrift(manifest, targetPath) {
  const combined = findStaleFiles(manifest, targetPath);
  const seen = new Set();
  return combined.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

/**
 * Build category summary from manifest. Used by cmdDetect and cmdVerify.
 */
function buildCategorySummary(manifest, staleEntries = []) {
  const categories = {};
  for (const e of manifest) {
    if (!categories[e.category]) categories[e.category] = { total: 0, present: 0, missing: 0, critical_missing: 0, stale: 0 };
    categories[e.category].total++;
    if (existsSync(e.path)) categories[e.category].present++;
    else {
      categories[e.category].missing++;
      if (e.critical) categories[e.category].critical_missing++;
    }
  }
  for (const e of staleEntries) {
    if (categories[e.category]) categories[e.category].stale = (categories[e.category].stale || 0) + 1;
  }
  return categories;
}

function collectRepairableSetupIssues(targetPath) {
  const issues = [];
  const auditConfigPath = join(targetPath, "audit.config.json");
  if (!existsSync(auditConfigPath)) {
    issues.push({
      code: "missing_audit_config",
      path: "audit.config.json",
      repair_via: "setup",
    });
  }

  for (const name of Object.keys(KB_DEFAULTS)) {
    const kbPath = join(targetPath, "plans", "knowledge", name);
    if (!existsSync(kbPath)) {
      issues.push({
        code: "missing_kb_file",
        path: join("plans", "knowledge", name),
        repair_via: "setup",
      });
    }
  }

  const policyInfo = loadPlannerPolicy(targetPath);
  if (!policyInfo.present) {
    issues.push({
      code: "missing_planner_policy",
      path: "planner.policy.yaml",
      repair_via: "setup",
    });
  } else if (!policyInfo.valid) {
    issues.push({
      code: "invalid_planner_policy",
      path: policyInfo.path ? relative(targetPath, policyInfo.path) : "planner.policy.yaml",
      repair_via: "manual_then_setup",
      issues: policyInfo.issues,
    });
  } else if (policyInfo.missing_defaults.length > 0) {
    issues.push({
      code: "incomplete_planner_policy",
      path: policyInfo.path ? relative(targetPath, policyInfo.path) : "planner.policy.yaml",
      repair_via: "setup",
      missing_defaults: policyInfo.missing_defaults,
    });
  }

  return issues;
}

function formatDoctorManifestEntry(targetPath, entry) {
  return {
    path: relative(targetPath, entry.path),
    category: entry.category,
    critical: !!entry.critical,
  };
}

function formatDoctorAdvisoryEntry(targetPath, entry) {
  return {
    path: relative(targetPath, entry.path),
    category: entry.category,
    code: entry.code,
    repair_via: entry.repair_via,
  };
}

function validateRitualContractReadiness(targetPath) {
  try {
    const report = validateWorkflowContractSurface(targetPath);
    return {
      status: report.ok ? "PASS" : "FAIL",
      issue_count: Array.isArray(report.issues) ? report.issues.length : 0,
      issues: Array.isArray(report.issues) ? report.issues : [],
      registry_public_count: Array.isArray(report.registry?.workflows) ? report.registry.workflows.length : 0,
      workflow_file_count: Array.isArray(report.workflow_files) ? report.workflow_files.length : 0,
    };
  } catch (e) {
    return {
      status: "FAIL",
      issue_count: 1,
      issues: [{
        id: "ritual_contract_readiness_error",
        severity: "error",
        message: e.message,
      }],
      registry_public_count: 0,
      workflow_file_count: 0,
    };
  }
}

function buildDoctorReport(targetPath) {
  const targetSkillMd = join(targetPath, ".agent/skills/iterative-planner/SKILL.md");
  const detection = detectVersion(targetSkillMd);
  const upgradeState = managedUpgradeDiagnostics(targetPath, CURRENT_VERSION);
  const committedVersion = upgradeState.committed_version || detection.version;
  const treeVersion = upgradeState.tree_version || detection.version;
  const versionStratigraphy = {
    committed: committedVersion,
    tree: treeVersion,
    source: CURRENT_VERSION,
    source_commit: selectedSourceCommit(),
    classification: upgradeState.classification,
  };
  const installState = upgradeState.classification === "half_applied_upgrade"
    ? "half_applied_payload"
    : upgradeState.classification;
  const manifest = buildExpectedManifest(targetPath);
  const missing = manifest.filter((entry) => !existsSync(entry.path));
  const stale = findVerificationDrift(manifest, targetPath);
  const setupIssues = collectRepairableSetupIssues(targetPath);
  const advisoryIssues = findRootInstructionSyncIssues(targetPath);
  const ritualContractReadiness = validateRitualContractReadiness(targetPath);
  const versionMismatch = committedVersion !== CURRENT_VERSION;
  const criticalMissing = missing.filter((entry) => entry.critical);

  const repairReasons = [];
  if (versionMismatch) repairReasons.push(`committed version ${committedVersion} -> ${CURRENT_VERSION}`);
  if (installState !== "coherent_committed") {
    repairReasons.push(`install state ${installState}`);
  }
  if (missing.length > 0) repairReasons.push(`${missing.length} missing file(s)`);
  if (stale.length > 0) repairReasons.push(`${stale.length} stale file(s)`);
  if (setupIssues.length > 0) repairReasons.push(`${setupIssues.length} repairable setup issue(s)`);
  if (!verificationStatusIsPass(ritualContractReadiness.status, "execution")) repairReasons.push(`ritual contract readiness ${ritualContractReadiness.status}`);

  const advisoryReasons = [];
  if (advisoryIssues.length > 0) advisoryReasons.push(`${advisoryIssues.length} advisory sync issue(s)`);

  const description = repairReasons.length > 0
    ? [...repairReasons, ...advisoryReasons].join(", ")
    : advisoryReasons.length > 0
      ? `planner install is current; ${advisoryReasons.join(", ")}`
      : "planner install is current";

  return {
    source_project_path: canonicalSourceProjectPath(),
    source_ref: selectedSourceRef(),
    source_commit: selectedSourceCommit(),
    target_path: targetPath,
    detected_version: detection.version,
    current_version: CURRENT_VERSION,
    committed_version: committedVersion,
    tree_version: treeVersion,
    source_version: CURRENT_VERSION,
    install_state: installState,
    upgrade_state: installState,
    version_stratigraphy: versionStratigraphy,
    active_upgrade_transaction: upgradeState.active_transaction,
    last_upgrade_receipt: upgradeState.last_receipt,
    detection,
    needs_repair: versionMismatch || installState !== "coherent_committed" || missing.length > 0 || stale.length > 0 || setupIssues.length > 0 || !verificationStatusIsPass(ritualContractReadiness.status, "execution"),
    repair_command: managedUpgradeConsentCommand(
      targetPath,
      selectedSourceCommit() || selectedSourceRef(),
      false,
      __filename,
    ),
    recovery_command: upgradeState.active_transaction
      ? managedUpgradeRecoveryCommand(
          targetPath,
          selectedSourceCommit() || selectedSourceRef(),
          __filename,
        )
      : null,
    summary: {
      description,
      version_mismatch: versionMismatch,
      missing_count: missing.length,
      critical_missing_count: criticalMissing.length,
      stale_count: stale.length,
      setup_issue_count: setupIssues.length,
      advisory_count: advisoryIssues.length,
      ritual_contract_readiness: ritualContractReadiness.status,
      ritual_contract_issue_count: ritualContractReadiness.issue_count,
    },
    missing_files: missing.map((entry) => formatDoctorManifestEntry(targetPath, entry)),
    stale_files: stale.map((entry) => formatDoctorManifestEntry(targetPath, entry)),
    setup_issues: setupIssues,
    advisory_issues: advisoryIssues.map((entry) => formatDoctorAdvisoryEntry(targetPath, entry)),
    ritual_contract_readiness: ritualContractReadiness,
  };
}

/**
 * Copy src → dest if dest is missing OR if dest content differs from src.
 * RT10-MIGRATE: Previous version only checked existsSync() — stale files
 * were never updated, making upgrade a no-op for existing installations.
 * Now compares SHA-256 hashes and overwrites stale files.
 */
function copyIfMissing(src, dest, dryRun, log) {
  if (!existsSync(src)) {
    log.push(`  SKIP (source missing): ${basename(src)}`);
    return false;
  }
  if (isConflictedCopyArtifact(basename(src)) || isConflictedCopyArtifact(basename(dest))) {
    log.push(`  SKIP (ignored conflicted-copy artifact): ${basename(src)}`);
    return false;
  }
  if (existsSync(dest)) {
    const srcHash = normalizedComparisonHash(src, { sourceProjectPath: canonicalSourceProjectPath() });
    const destHash = normalizedComparisonHash(dest);
    if (srcHash && destHash && srcHash === destHash) {
      log.push(`  OK (up to date): ${basename(dest)}`);
      return false;
    }
    // File exists but is stale — update it
    const beforeHash = fileHash(dest);
    const afterHash = fileHash(src);
    if (dryRun) {
      log.push(`  WOULD UPDATE: ${managedDisplayPath(dest)} before_sha256=${beforeHash || "unavailable"} after_sha256=${afterHash || "unavailable"}`);
      return true;
    }
    ensureDir(dirname(dest));
    copyFileSync(src, dest);
    log.push(`  UPDATED: ${managedDisplayPath(dest)} before_sha256=${beforeHash || "unavailable"} after_sha256=${fileHash(dest) || afterHash || "unavailable"}`);
    return true;
  }
  if (dryRun) {
    log.push(`  WOULD CREATE: ${basename(dest)}`);
    return true;
  }
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  log.push(`  CREATED: ${basename(dest)}`);
  return true;
}

function appendSectionIfMissing(filePath, marker, section, dryRun, log) {
  const content = readFile(filePath);
  if (!content) {
    log.push(`  SKIP (file not found): ${basename(filePath)}`);
    return false;
  }
  if (content.includes(marker)) {
    log.push(`  SKIP (already has "${marker}"): ${basename(filePath)}`);
    return false;
  }
  if (dryRun) {
    log.push(`  WOULD APPEND to ${basename(filePath)}: section starting with "${marker}"`);
    return true;
  }
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content + "\n\n" + section);
  renameSync(tmpPath, filePath);
  log.push(`  APPENDED to ${basename(filePath)}: section "${marker}"`);
  return true;
}

/** Copy a directory tree (files matching filter) from source to target. */
function copyDirTree(sourceDir, targetDir, filter, dryRun, log) {
  if (!existsSync(sourceDir)) return;
  for (const f of walkDir(sourceDir, filter)) {
    const relPath = relative(sourceDir, f);
    copyIfMissing(f, join(targetDir, relPath), dryRun, log);
  }
}

function collectObsoletePlannerWorkflowFiles(targetPath) {
  const sourceWorkflowsDir = join(agentDir, "workflows");
  const targetWorkflowsDir = join(targetPath, ".agent/workflows");
  if (!existsSync(sourceWorkflowsDir) || !existsSync(targetWorkflowsDir)) {
    return { prunable: [], preserved: [] };
  }

  const canonical = new Set(listManagedDirNames(sourceWorkflowsDir, (name) => name.endsWith(".md")));
  const prunable = [];
  const preserved = [];
  for (const entry of readdirSync(targetWorkflowsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (canonical.has(entry.name)) continue;
    const full = join(targetWorkflowsDir, entry.name);
    const sourceRelativePath = gitPath(join(".agent", "workflows", entry.name));
    const canonicalHistory = sourcePathHasHistory(sourceRelativePath);
    if (workflowFileHasExplicitHostOwnerMarker(full) || canonicalHistory === false) {
      preserved.push(full);
    } else {
      // A null history result is indeterminate, so retain fail-closed behavior
      // by sending the path through managed-sync safety rather than preserving it.
      prunable.push(full);
    }
  }
  return {
    prunable: prunable.sort((a, b) => a.localeCompare(b)),
    preserved: preserved.sort((a, b) => a.localeCompare(b)),
  };
}

function pruneObsoletePlannerWorkflowFiles(targetPath, dryRun, log) {
  const { prunable, preserved } = collectObsoletePlannerWorkflowFiles(targetPath);
  for (const path of preserved) {
    if (workflowFileHasExplicitHostOwnerMarker(path)) {
      log.push(`  PRESERVED host-owned workflow: ${basename(path)} (${HOST_OWNED_WORKFLOW_MARKER})`);
    } else {
      log.push(`  PRESERVED non-canonical workflow: ${basename(path)} (no same-path canonical source history)`);
    }
  }
  if (prunable.length === 0) {
    log.push("  OK: no obsolete planner workflow leftovers");
    return 0;
  }
  for (const path of prunable) {
    if (dryRun) {
      log.push(`  WOULD REMOVE obsolete planner workflow: ${gitPath(relative(targetPath, path))} before_sha256=${fileHash(path) || "unavailable"} after_sha256=missing`);
      continue;
    }
    const beforeHash = fileHash(path);
    unlinkSync(path);
    log.push(`  REMOVED obsolete planner workflow: ${gitPath(relative(targetPath, path))} before_sha256=${beforeHash || "unavailable"} after_sha256=missing`);
  }
  return prunable.length;
}

function collectObsoletePlannerTestFiles(targetPath) {
  const sourceTestsDir = join(skillDir, "tests");
  const targetTestsDir = join(
    targetPath,
    ".agent/skills/iterative-planner/tests",
  );
  const include = (name) =>
    name.endsWith(".mjs") || name.endsWith(".json") || name.endsWith(".md");
  if (!existsSync(sourceTestsDir) || !existsSync(targetTestsDir)) {
    return { prunable: [], preserved: [] };
  }

  const canonical = new Set(
    walkDir(sourceTestsDir, include)
      .map((path) => gitPath(relative(sourceTestsDir, path))),
  );
  const prunable = [];
  const preserved = [];
  for (const path of walkDir(targetTestsDir, include)) {
    const relativeTestPath = gitPath(relative(targetTestsDir, path));
    if (canonical.has(relativeTestPath)) continue;
    const sourceRelativePath = gitPath(
      join(".agent", "skills", "iterative-planner", "tests", relativeTestPath),
    );
    const canonicalHistory = sourcePathHasHistory(sourceRelativePath);
    if (canonicalHistory === false) {
      preserved.push(path);
    } else {
      // Null history is indeterminate. Route it through managed-sync safety so
      // the upgrade refuses instead of silently deleting unknown bytes.
      prunable.push(path);
    }
  }
  return {
    prunable: prunable.sort((a, b) => a.localeCompare(b)),
    preserved: preserved.sort((a, b) => a.localeCompare(b)),
  };
}

function pruneObsoletePlannerTestFiles(targetPath, dryRun, log) {
  const { prunable, preserved } = collectObsoletePlannerTestFiles(targetPath);
  for (const path of preserved) {
    log.push(
      `  PRESERVED non-canonical test asset: ${gitPath(relative(targetPath, path))} (no same-path canonical source history)`,
    );
  }
  if (prunable.length === 0) {
    log.push("  OK: no obsolete planner test leftovers");
    return 0;
  }
  for (const path of prunable) {
    const relativePath = gitPath(relative(targetPath, path));
    if (dryRun) {
      log.push(
        `  WOULD REMOVE obsolete planner test: ${relativePath} before_sha256=${fileHash(path) || "unavailable"} after_sha256=missing`,
      );
      continue;
    }
    const beforeHash = fileHash(path);
    unlinkSync(path);
    log.push(
      `  REMOVED obsolete planner test: ${relativePath} before_sha256=${beforeHash || "unavailable"} after_sha256=missing`,
    );
  }
  return prunable.length;
}

/**
 * Shared project-level setup: audit config, KB seeding, version marker, hooks, ripple check.
 * Called by explicit setup and by upgrade only when a real repair requires setup.
 */
function runProjectSetup(targetPath, dryRun, log) {
  const targetBase = join(targetPath, ".agent/skills/iterative-planner");

  // 1. Seed audit.config.json if missing
  log.push("\n## Audit Config");
  const auditConfigTarget = join(targetPath, "audit.config.json");
  if (!existsSync(auditConfigTarget)) {
    const defaultConfig = JSON.stringify({ roles: ["core"], fail_on: ["HIGH", "CRITICAL"] }, null, 2) + "\n";
    if (!dryRun) {
      writeFileSync(auditConfigTarget, defaultConfig);
      log.push(`  CREATED: audit.config.json (persona audit is compulsory at execute-to-reflect, reflect-to-validate, and validate-to-close)`);
    } else {
      log.push(`  WOULD CREATE: audit.config.json`);
    }
  } else {
    log.push(`  OK: audit.config.json exists`);
  }

  // 2. Seed planner.policy.yaml if missing or merge newly added defaults.
  log.push("\n## Planner Policy");
  ensurePlannerPolicy(targetPath, { dryRun, log });

  // 3. Seed KB files if missing (v3.0.0: explore-to-plan gate FAILs without these)
  log.push("\n## Knowledge Base (required)");
  const kbDir = join(targetPath, "plans/knowledge");
  ensureDir(kbDir);
  for (const [name, content] of Object.entries(KB_DEFAULTS)) {
    const kbTarget = join(kbDir, name);
    if (!existsSync(kbTarget)) {
      if (!dryRun) {
        writeFileSync(kbTarget, content);
        log.push(`  CREATED: plans/knowledge/${name}`);
      } else {
        log.push(`  WOULD CREATE: plans/knowledge/${name}`);
      }
    } else {
      log.push(`  OK: plans/knowledge/${name} exists`);
    }
  }
  const retroDir = join(kbDir, "retros");
  const retroCasesDir = join(retroDir, "cases");
  ensureDir(retroCasesDir);
  const retroLedgerTarget = join(retroDir, "retro_ledger.json");
  if (!existsSync(retroLedgerTarget)) {
    if (!dryRun) {
      writeFileSync(retroLedgerTarget, RETRO_LEDGER_TEMPLATE);
      log.push("  CREATED: plans/knowledge/retros/retro_ledger.json");
    } else {
      log.push("  WOULD CREATE: plans/knowledge/retros/retro_ledger.json");
    }
  } else {
    log.push("  OK: plans/knowledge/retros/retro_ledger.json exists");
  }

  // 4. Check SKILL.md has planner_version matching version.json
  log.push("\n## Version Marker");
  const versionJsonTarget = join(targetBase, "config", "version.json");
  let targetVersion = CURRENT_VERSION;
  if (existsSync(versionJsonTarget)) {
    try {
      targetVersion = JSON.parse(readFileSync(versionJsonTarget, "utf-8")).version || CURRENT_VERSION;
    } catch { /* use default */ }
  }
  const targetSkillMd = join(targetBase, "SKILL.md");
  const skillContent = readFile(targetSkillMd);
  if (skillContent) {
    const match = skillContent.match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/);
    if (match && match[1] === targetVersion) {
      log.push(`  OK: SKILL.md planner_version matches version.json (${targetVersion})`);
    } else if (match) {
      if (!dryRun) {
        const updated = skillContent.replace(/planner_version:\s*["']?\d+\.\d+\.\d+["']?/, `planner_version: "${targetVersion}"`);
        writeFileSync(targetSkillMd + ".tmp", updated);
        renameSync(targetSkillMd + ".tmp", targetSkillMd);
        log.push(`  FIXED: planner_version ${match[1]} → ${targetVersion}`);
      } else {
        log.push(`  WOULD FIX: planner_version ${match[1]} → ${targetVersion}`);
      }
    } else if (skillContent.startsWith("---")) {
      if (!dryRun) {
        const updated = skillContent.replace(/^---\n/, `---\nplanner_version: "${targetVersion}"\n`);
        writeFileSync(targetSkillMd + ".tmp", updated);
        renameSync(targetSkillMd + ".tmp", targetSkillMd);
        log.push(`  ADDED: planner_version: "${targetVersion}" to frontmatter`);
      } else {
        log.push(`  WOULD ADD: planner_version: "${targetVersion}"`);
      }
    }
  }

  // 5. Install pre-commit hook if not present
  log.push("\n## Pre-commit Hook");
  const gitHooksDir = join(targetPath, ".git", "hooks");
  const preCommitTarget = join(gitHooksDir, "pre-commit");
  const hookSource = join(targetBase, "scripts", "hooks", "pre-commit");
  if (existsSync(preCommitTarget)) {
    const hookContent = readFile(preCommitTarget);
    const hookSourceContent = readFile(hookSource);
    if (hookContent && hookSourceContent && isManagedPreCommitHook(hookContent)) {
      const refreshed = refreshManagedPreCommitHook(hookContent, hookSourceContent);
      if (refreshed === hookContent) {
        log.push(`  OK: pre-commit hook already installed`);
      } else if (dryRun) {
        log.push(`  WOULD REFRESH: managed pre-commit hook`);
      } else {
        ensureDir(gitHooksDir);
        writeFileSync(preCommitTarget, refreshed);
        chmodSync(preCommitTarget, 0o755);
        log.push(`  REFRESHED: managed pre-commit hook`);
      }
    } else {
      log.push(`  SKIP: pre-commit hook exists but is not ours — run install.mjs manually`);
    }
  } else if (existsSync(join(targetPath, ".git"))) {
    if (existsSync(hookSource) && !dryRun) {
      ensureDir(gitHooksDir);
      copyFileSync(hookSource, preCommitTarget);
      chmodSync(preCommitTarget, 0o755);
      log.push(`  INSTALLED: pre-commit hook (ripple-through check)`);
    } else if (existsSync(hookSource)) {
      log.push(`  WOULD INSTALL: pre-commit hook`);
    } else {
      log.push(`  SKIP: hook source not found`);
    }
  } else {
    log.push(`  SKIP: not a git repo`);
  }

  // 6. Install sync-instructions.sh and create root instruction files
  log.push("\n## Root Instruction Files (CLAUDE.md / GEMINI.md / AGENTS.md)");
  const syncScriptSrc  = join(agentDir, "scripts", "sync-instructions.sh");
  const syncScriptDest = join(targetPath, ".agent/scripts", "sync-instructions.sh");

  if (existsSync(syncScriptSrc)) {
    ensureDir(join(targetPath, ".agent/scripts"));
    copyIfMissing(syncScriptSrc, syncScriptDest, dryRun, log);
    if (!dryRun && existsSync(syncScriptDest)) chmodSync(syncScriptDest, 0o755);
  } else {
    log.push(`  SKIP: sync-instructions.sh source not found`);
  }

  syncRootInstructionSurfaces(targetPath, { dryRun, log });

  // 7. Run ripple check
  log.push("\n## Ripple-Through Check");
  const rippleCheckPath = join(targetBase, "scripts", "ripple_check.mjs");
  if (existsSync(rippleCheckPath)) {
    try {
      const output = runNode([rippleCheckPath], { cwd: targetPath, timeout: 15000 });
      const hasGaps = output.includes("GAPS FOUND");
      log.push(hasGaps ? `  ❌ Ripple check found gaps — see output above` : `  OK: All gates fully documented`);
      if (output.trim()) console.log(output);
    } catch (e) {
      if (e.stdout) console.log(e.stdout);
      log.push(`  ⚠️  Ripple check reported issues (exit ${e.status})`);
    }
  } else {
    log.push(`  SKIP: ripple_check.mjs not found`);
  }
}

function normalizeSetupProfile(value) {
  const normalized = String(value || "full").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (!normalized || normalized === "default") return "full";
  if (normalized === "planner_kernel" || normalized === "minimal_kernel") return "kernel";
  return normalized;
}

function kernelInstructionSection() {
  return `${KERNEL_INSTRUCTION_MARKER}

Use the planner kernel when this repo only needs cheap execution support:
- Keep task memory in \`${JOURNAL_REL_PATH}\`.
- Record retros as promoted journal entries when a lesson should survive.
- Treat incidents as activation evidence for the full planner layer.

Kernel setup is intentionally small. If repeated incidents, cross-file migrations, program packets, or gate evidence are needed, graduate to the full planner setup instead of adding a second local ritual.
`;
}

function kernelInstructionDocument() {
  return `# Project Instructions

${kernelInstructionSection()}`;
}

function kernelSeedEntry() {
  return {
    id: KERNEL_SEED_ID,
    ts: new Date().toISOString(),
    type: "decision",
    status: "accepted",
    confidence: "operator_policy",
    topic: "planner_kernel",
    summary: "Kernel profile installed: memory, retro, and plan spine only.",
    tags: ["kernel", "install_profile"],
    actor: "migrate.mjs",
    payload: {
      install_profile: "kernel",
      files: [KERNEL_INSTRUCTIONS_REL_PATH, JOURNAL_REL_PATH],
      activation_rules: [
        {
          trigger: "journal incident or failure entry",
          layer: "full_planner",
          recommendation: "Run full planner setup before closing complex or recurring work.",
        },
      ],
    },
  };
}

function runKernelProjectSetup(targetPath, dryRun, log) {
  log.push("\n## Kernel Profile");
  log.push("  PROFILE: kernel (two-file drop-in; full setup remains the default)");

  log.push("\n## Kernel Instruction File");
  const instructionsPath = join(targetPath, KERNEL_INSTRUCTIONS_REL_PATH);
  if (!existsSync(instructionsPath)) {
    if (dryRun) {
      log.push(`  WOULD CREATE: ${KERNEL_INSTRUCTIONS_REL_PATH}`);
    } else {
      writeFileSync(instructionsPath, kernelInstructionDocument());
      log.push(`  CREATED: ${KERNEL_INSTRUCTIONS_REL_PATH}`);
    }
  } else {
    appendSectionIfMissing(instructionsPath, KERNEL_INSTRUCTION_MARKER, kernelInstructionSection(), dryRun, log);
  }

  log.push("\n## Kernel Journal");
  const journalPath = join(targetPath, JOURNAL_REL_PATH);
  const seedLine = `${JSON.stringify(kernelSeedEntry())}\n`;
  if (!existsSync(journalPath)) {
    if (dryRun) {
      log.push(`  WOULD CREATE: ${JOURNAL_REL_PATH}`);
    } else {
      ensureDir(dirname(journalPath));
      writeFileSync(journalPath, seedLine);
      log.push(`  CREATED: ${JOURNAL_REL_PATH}`);
    }
  } else {
    const existing = readFile(journalPath) || "";
    if (existing.includes(`"id":"${KERNEL_SEED_ID}"`) || existing.includes(`"install_profile":"kernel"`)) {
      log.push(`  OK: ${JOURNAL_REL_PATH} already records kernel metadata`);
    } else if (dryRun) {
      log.push(`  WOULD APPEND: ${JOURNAL_REL_PATH} kernel seed`);
    } else {
      writeFileSync(journalPath, `${existing.trimEnd()}\n${seedLine}`);
      log.push(`  APPENDED: ${JOURNAL_REL_PATH} kernel seed`);
    }
  }

  log.push("\n## Full Planner Surface");
  log.push("  SKIP: kernel setup does not copy .agent/skills/iterative-planner/scripts");
}

function normalizeTagList(tags) {
  return (Array.isArray(tags) ? tags : []).map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean);
}

function entryHasTag(entry, tag) {
  return normalizeTagList(entry?.tags).includes(tag);
}

function entryTopic(entry) {
  return String(entry?.topic || "").trim().toLowerCase();
}

function loadPlannerProfileMetadata(targetPath) {
  const profilePath = join(targetPath, "planner.profile.json");
  if (!existsSync(profilePath)) return null;
  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf-8"));
    const rawProfile = profile.install_profile || profile.profile || profile.tier;
    if (normalizeSetupProfile(rawProfile) === "kernel") {
      return { active: true, source: "planner.profile.json" };
    }
  } catch {
    return null;
  }
  return null;
}

function summarizeKernelStatus(targetPath) {
  const journal = loadJournal({ cwd: targetPath });
  const entries = journal.entries || [];
  const seedEntry = entries.find((entry) => entry?.payload?.install_profile === "kernel" || entryHasTag(entry, "install_profile"));
  const profileMetadata = loadPlannerProfileMetadata(targetPath);
  const taskEntries = entries.filter((entry) => entryTopic(entry) === "task" || entryHasTag(entry, "task")).length;
  const retroPromotions = entries.filter((entry) => (
    entry?.type === "promotion" && (entryTopic(entry) === "retro" || entryHasTag(entry, "retro"))
  )).length;
  const incidentEntries = entries.filter((entry) => (
    entry?.type === "failure" || entryTopic(entry) === "incident" || entryHasTag(entry, "incident")
  )).length;
  const profileActive = !!profileMetadata || !!seedEntry;
  const activatedLayers = [];
  if (incidentEntries > 0) {
    activatedLayers.push({
      id: "full_planner",
      status: "recommended",
      reason: "incident_history",
      command: "node .agent/skills/iterative-planner/scripts/migrate.mjs setup .",
    });
  }

  return {
    ok: true,
    profile: profileActive ? "kernel" : "unknown",
    profile_source: profileMetadata?.source || (seedEntry ? JOURNAL_REL_PATH : null),
    target_path: targetPath,
    instructions_present: existsSync(join(targetPath, KERNEL_INSTRUCTIONS_REL_PATH)),
    journal: {
      present: journal.present,
      path: journal.path,
      entries: entries.length,
      issues: journal.issues.length,
      task_entries: taskEntries,
      retro_promotions: retroPromotions,
      incident_entries: incidentEntries,
    },
    activated_layers: activatedLayers,
  };
}

function cmdKernelStatus(targetPath, jsonOutput) {
  const summary = summarizeKernelStatus(targetPath);
  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  KERNEL PROFILE STATUS                              ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Profile:       ${summary.profile}`);
  console.log(`  Source:        ${summary.profile_source || "not detected"}`);
  console.log(`  Instructions:  ${summary.instructions_present ? "present" : "missing"}`);
  console.log(`  Journal:       ${summary.journal.entries} entr${summary.journal.entries === 1 ? "y" : "ies"}, ${summary.journal.issues} issue(s)`);
  console.log(`  Tasks:         ${summary.journal.task_entries}`);
  console.log(`  Retro promos:  ${summary.journal.retro_promotions}`);
  console.log(`  Incidents:     ${summary.journal.incident_entries}`);
  if (summary.activated_layers.length > 0) {
    console.log(`\n  Activated layers:`);
    for (const layer of summary.activated_layers) {
      console.log(`    - ${layer.id}: ${layer.status} (${layer.reason})`);
      console.log(`      ${layer.command}`);
    }
  } else {
    console.log(`\n  Activated layers: none`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdDetect(targetPath) {
  const targetSkillMd = join(targetPath, ".agent/skills/iterative-planner/SKILL.md");
  const { version, reason, confidence } = detectVersion(targetSkillMd);

  const manifest = buildExpectedManifest(targetPath);
  const missing = manifest.filter(e => !existsSync(e.path));
  const missingCritical = missing.filter(e => e.critical);
  const categories = buildCategorySummary(manifest);

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  PLANNER VERSION DETECTION + INTEGRITY              ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Project:          ${targetPath}`);
  console.log(`  Detected version: ${version}`);
  console.log(`  Confidence:       ${confidence}`);
  console.log(`  Reason:           ${reason}`);
  console.log(`  Current version:  ${CURRENT_VERSION}`);
  console.log(`  Needs upgrade:    ${version !== CURRENT_VERSION ? "YES" : "NO"}`);
  if (confidence === "LOW") {
    console.log(`\n  ⚠️  LOW confidence: version detected by heuristic keyword matching.`);
    console.log(`     Add 'planner_version: "${version}"' to SKILL.md frontmatter for reliable detection.`);
  }

  console.log(`\n  Integrity Check (${manifest.length} expected files):`);
  for (const [cat, info] of Object.entries(categories).sort((a, b) => a[0].localeCompare(b[0]))) {
    const status = info.missing === 0 ? "✅" : info.missing === info.total ? "❌" : "⚠️";
    console.log(`    ${status} ${cat}: ${info.present}/${info.total}`);
  }

  if (missingCritical.length > 0) {
    console.log(`\n  🔴 CRITICAL files missing (${missingCritical.length}):`);
    for (const e of missingCritical.slice(0, 15)) {
      console.log(`     - ${relative(targetPath, e.path)} [${e.category}]`);
    }
    if (missingCritical.length > 15) console.log(`     ... and ${missingCritical.length - 15} more`);
    console.log(`\n  Run: node migrate.mjs upgrade ${targetPath} --commit`);
  } else if (missing.length > 0) {
    console.log(`\n  🟡 Optional files missing (${missing.length}):`);
    for (const e of missing.slice(0, 10)) {
      console.log(`     - ${relative(targetPath, e.path)} [${e.category}]`);
    }
    if (missing.length > 10) console.log(`     ... and ${missing.length - 10} more`);
    console.log(`\n  Run: node migrate.mjs upgrade ${targetPath} --commit`);
  } else {
    console.log(`\n  ✅ All files present. Installation is complete.`);
  }
  console.log();
}

function cmdDoctor(targetPath, jsonOutput) {
  const report = buildDoctorReport(targetPath);

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  PLANNER DOCTOR                                     ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Source repo:       ${report.source_project_path}`);
  console.log(`  Source ref:        ${report.source_ref}`);
  console.log(`  Source commit:     ${report.source_commit || "unresolved"}`);
  console.log(`  Target project:    ${report.target_path}`);
  console.log(`  Committed version: ${report.committed_version}`);
  console.log(`  Tree version:      ${report.tree_version}`);
  console.log(`  Source version:    ${report.source_version}`);
  console.log(`  Install state:     ${report.install_state}`);
  console.log(`  Needs repair:      ${report.needs_repair ? "YES" : "NO"}`);
  console.log(`  Summary:           ${report.summary.description}`);

  if (report.missing_files.length > 0) {
    console.log(`\n  Missing files (${report.missing_files.length}):`);
    for (const entry of report.missing_files.slice(0, 15)) {
      console.log(`    - ${entry.path} [${entry.category}]${entry.critical ? " [critical]" : ""}`);
    }
  }

  if (report.stale_files.length > 0) {
    console.log(`\n  Stale files (${report.stale_files.length}):`);
    for (const entry of report.stale_files.slice(0, 15)) {
      console.log(`    - ${entry.path} [${entry.category}]${entry.critical ? " [critical]" : ""}`);
    }
  }

  if (report.setup_issues.length > 0) {
    console.log(`\n  Repairable setup issues (${report.setup_issues.length}):`);
    for (const entry of report.setup_issues) {
      console.log(`    - ${entry.path} (${entry.code})`);
    }
  }

  if ((report.advisory_issues || []).length > 0) {
    console.log(`\n  Advisory issues (${report.advisory_issues.length}) — informational only, no self-heal:`);
    for (const entry of report.advisory_issues.slice(0, 15)) {
      console.log(`    - ${entry.path} [${entry.category}] (${entry.code}; repair via ${entry.repair_via})`);
    }
  }

  if (report.needs_repair) {
    if (report.recovery_command) console.log(`\n  Interrupted transaction recovery: ${report.recovery_command}`);
    console.log(`\n  Suggested repair: ${report.repair_command}`);
  } else {
    console.log(`\n  ✅ Planner install is current and repairable setup state is intact.`);
    if ((report.advisory_issues || []).length > 0) {
      console.log(`  Advisory-only drift does not trigger planner self-heal.`);
    }
  }
  console.log();
}

function cmdUpgrade(targetPath, seedKB, dryRun) {
  const log = [];
  const targetSkillMd = join(targetPath, ".agent/skills/iterative-planner/SKILL.md");
  const { version, confidence } = detectVersion(targetSkillMd);

  if (confidence === "LOW") {
    console.log(`\n  ⚠️  LOW confidence version detection (heuristic). Proceeding with caution.`);
  }

  // BUG FIX: Don't skip upgrade even if version matches — check for missing files first
  const manifest = buildExpectedManifest(targetPath);
  const missing = manifest.filter(e => !existsSync(e.path));

  // RT10-MIGRATE: Also count stale files (exist but content differs)
  const staleEntries = findVerificationDrift(manifest, targetPath);
  const staleCount = staleEntries.length;
  const obsoleteWorkflows = collectObsoletePlannerWorkflowFiles(targetPath);
  const obsoleteWorkflowCount = obsoleteWorkflows.prunable.length;
  const obsoleteTests = collectObsoletePlannerTestFiles(targetPath);
  const obsoleteTestCount = obsoleteTests.prunable.length;
  const setupIssues = collectRepairableSetupIssues(targetPath);
  const advisoryIssues = findRootInstructionSyncIssues(targetPath);

  const syncSafetyEntries = staleEntries.filter((entry) => basename(entry.path) !== ".project_registry.json");
  const syncSafety = assessManagedSyncSafety(
    targetPath,
    syncSafetyEntries,
    [...obsoleteWorkflows.prunable, ...obsoleteTests.prunable],
  );
  if (!syncSafety.ok) {
    const stratigraphy = managedUpgradeDiagnostics(targetPath, CURRENT_VERSION);
    console.log(
      `\n  Version strata: committed=${stratigraphy.committed_version}, tree=${stratigraphy.tree_version}, source=${stratigraphy.source_version}`,
    );
    printManagedSyncRefusal(syncSafety);
    process.exitCode = 1;
    return {
      noOp: false,
      setupNeeded: false,
      changed: false,
      blocked: true,
      from: version,
      to: CURRENT_VERSION,
      reason: "managed-sync-conflict",
      conflicts: syncSafety.conflicts,
    };
  }

  if (version === CURRENT_VERSION && missing.length === 0 && staleCount === 0 && obsoleteWorkflowCount === 0 && obsoleteTestCount === 0 && setupIssues.length === 0 && !seedKB) {
    console.log(`\n  ✅ Already at version ${CURRENT_VERSION} with all ${manifest.length} files present and up to date.`);
    console.log(`  No project-level setup repair is required; upgrade is a read-only no-op.`);
    if (advisoryIssues.length > 0) {
      console.log(`  Advisory setup drift remains (${advisoryIssues.length} issue(s)); run setup explicitly to refresh root instructions or mirrors.`);
    }
    console.log();
    return {
      noOp: true,
      setupNeeded: false,
      changed: false,
      from: version,
      to: CURRENT_VERSION,
      reason: "already-current-clean",
    };
  }

  if (version === CURRENT_VERSION && missing.length === 0 && staleCount === 0 && obsoleteWorkflowCount === 0 && obsoleteTestCount === 0 && setupIssues.length > 0 && !seedKB) {
    console.log(`\n  ⚠️  Already at version ${CURRENT_VERSION}, but ${setupIssues.length} setup repair issue(s) require project setup.`);
    console.log(`  Planner-managed files are current; setup ${dryRun ? "would run" : "will run"} as the explicit repair step.\n`);
    return {
      noOp: false,
      setupNeeded: true,
      changed: false,
      from: version,
      to: CURRENT_VERSION,
      reason: "setup-repair-required",
    };
  }

  if (version === CURRENT_VERSION && missing.length > 0) {
    console.log(`\n  ⚠️  Version is ${CURRENT_VERSION} but ${missing.length} file(s) are missing. Repairing...`);
  }

  if (version === CURRENT_VERSION && setupIssues.length > 0) {
    console.log(`\n  ⚠️  Version is ${CURRENT_VERSION} but ${setupIssues.length} setup repair issue(s) remain. Setup ${dryRun ? "would run" : "will run"} after file sync.`);
  }

  if (version === CURRENT_VERSION && obsoleteWorkflowCount > 0) {
    console.log(`\n  ⚠️  Version is ${CURRENT_VERSION} but ${obsoleteWorkflowCount} obsolete planner workflow file(s) remain. Pruning...`);
  }
  if (version === CURRENT_VERSION && obsoleteTestCount > 0) {
    console.log(`\n  ⚠️  Version is ${CURRENT_VERSION} but ${obsoleteTestCount} obsolete planner test file(s) remain. Pruning...`);
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  PLANNER UPGRADE ${dryRun ? "(DRY RUN) " : ""}                             ║`);
  const changeParts = [];
  if (missing.length > 0) changeParts.push(`${missing.length} new`);
  if (staleCount > 0) changeParts.push(`${staleCount} stale`);
  if (obsoleteWorkflowCount > 0) changeParts.push(`${obsoleteWorkflowCount} obsolete workflow${obsoleteWorkflowCount === 1 ? "" : "s"}`);
  if (obsoleteTestCount > 0) changeParts.push(`${obsoleteTestCount} obsolete test${obsoleteTestCount === 1 ? "" : "s"}`);
  const changeDesc = changeParts.length > 0 ? changeParts.join(", ") : "0 changes";
  console.log(`║  ${version} → ${CURRENT_VERSION}  (${changeDesc})                  ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Source ref: ${selectedSourceRef()}`);
  console.log(`  Source commit: ${selectedSourceCommit() || "unresolved"}`);
  if (selectedSourceCommit()) {
    console.log(`  Manual pinned-ref first hop: node ${JSON.stringify(join(canonicalSourceProjectPath(), ".agent/skills/iterative-planner/scripts/migrate.mjs"))} upgrade ${JSON.stringify(targetPath)} --source-ref ${selectedSourceCommit()} --commit`);
  }
  console.log();

  const targetBase = join(targetPath, ".agent/skills/iterative-planner");

  // --- Scripts (dynamic scan) ---
  log.push("## Scripts");
  if (existsSync(scriptDir)) {
    for (const f of listManagedDirNames(scriptDir, (f) => f.endsWith(".mjs") || f.endsWith(".sh")).sort()) {
      copyIfMissing(join(scriptDir, f), join(targetBase, "scripts", f), dryRun, log);
    }
  }

  // --- Hook scripts ---
  log.push("\n## Hook Scripts");
  copyDirTree(
    join(scriptDir, "hooks"),
    join(targetBase, "scripts/hooks"),
    (name) => !name.startsWith("."),
    dryRun, log
  );

  // --- Script libraries (lib/) ---
  log.push("\n## Script Libraries");
  copyDirTree(
    join(scriptDir, "lib"),
    join(targetBase, "scripts/lib"),
    (name) => name.endsWith(".mjs") || name.endsWith(".md"),
    dryRun, log
  );

  // --- Prolog rules ---
  log.push("\n## Prolog Rules");
  copyDirTree(
    join(skillDir, "prolog"),
    join(targetBase, "prolog"),
    (name) => name.endsWith(".pl"),
    dryRun, log
  );

  // --- Config ---
  log.push("\n## Config");
  copyDirTree(
    join(skillDir, "config"),
    join(targetBase, "config"),
    (name) => (name.endsWith(".json")
        && name !== ".project_registry.json"
        && name !== basename(MANAGED_UPGRADE_RECEIPT_REL_PATH))
      || name === ".checklist_integrity"
      || name.endsWith(".yaml"),
    dryRun, log
  );
  const targetRegistryPath = join(targetBase, "config", ".project_registry.json");
  try {
    const registryBefore = existsSync(targetRegistryPath) ? readFileSync(targetRegistryPath) : null;
    const registry = existsSync(targetRegistryPath)
      ? JSON.parse(readFileSync(targetRegistryPath, "utf-8"))
      : { projects: [] };
    registry.source_project_path = canonicalSourceProjectPath();
    const registryAfter = `${JSON.stringify(registry, null, 2)}\n`;
    if (!registryBefore || !registryBefore.equals(Buffer.from(registryAfter))) {
      const beforeHash = registryBefore ? createHash("sha256").update(registryBefore).digest("hex") : "missing";
      const afterHash = createHash("sha256").update(registryAfter).digest("hex");
      if (dryRun) {
        log.push(`  WOULD MERGE: .project_registry.json source_project_path before_sha256=${beforeHash} after_sha256=${afterHash}`);
      } else {
        writeFileSync(targetRegistryPath, registryAfter);
        log.push(`  UPDATED: ${managedDisplayPath(targetRegistryPath)} before_sha256=${beforeHash} after_sha256=${afterHash}`);
      }
    } else {
      log.push("  OK (up to date): .project_registry.json source_project_path");
    }
  } catch (e) {
    log.push(`  WARN: Could not update .project_registry.json source_project_path: ${e.message}`);
  }

  // --- Checklists ---
  log.push("\n## Checklists");
  copyDirTree(
    join(skillDir, "checklists"),
    join(targetBase, "checklists"),
    (name) => name.endsWith(".yaml") || name.endsWith(".yml"),
    dryRun, log
  );

  // --- References ---
  log.push("\n## References");
  copyDirTree(
    join(skillDir, "references"),
    join(targetBase, "references"),
    (name) => name.endsWith(".md"),
    dryRun, log
  );

  // --- Analyzers ---
  log.push("\n## Analyzers");
  copyDirTree(
    join(skillDir, "analyzers"),
    join(targetBase, "analyzers"),
    (name) => name.endsWith(".yaml") || name.endsWith(".yml"),
    dryRun, log
  );

  // --- Tests (golden tests + fixtures) ---
  log.push("\n## Tests");
  copyDirTree(
    join(skillDir, "tests"),
    join(targetBase, "tests"),
    (name) =>
      name.endsWith(".mjs")
        || name.endsWith(".json")
        || name.endsWith(".jsonl")
        || name.endsWith(".md")
        || name.endsWith(".html"),
    dryRun, log
  );
  pruneObsoletePlannerTestFiles(targetPath, dryRun, log);

  // --- Packs (domain packs) ---
  log.push("\n## Domain Packs");
  copyDirTree(
    join(skillDir, "packs"),
    join(targetBase, "packs"),
    (name) => name.endsWith(".mjs") || name.endsWith(".pl") || name.endsWith(".md") || name.endsWith(".json"),
    dryRun, log
  );

  // --- IVE Profiles ---
  log.push("\n## IVE Profiles");
  copyDirTree(
    join(skillDir, "profiles"),
    join(targetBase, "profiles"),
    (name) => name.endsWith(".json") || name.endsWith(".md"),
    dryRun, log
  );

  // --- IVE Knowledge Packs ---
  log.push("\n## IVE Knowledge Packs");
  copyDirTree(
    join(skillDir, "knowledge_packs"),
    join(targetBase, "knowledge_packs"),
    (name) => name.endsWith(".json") || name.endsWith(".md"),
    dryRun, log
  );

  // --- Standalone files ---
  log.push("\n## Skill Files");
  copyIfMissing(join(skillDir, "SKILL.md"), join(targetBase, "SKILL.md"), dryRun, log);
  copyIfMissing(join(skillDir, "MIGRATION.md"), join(targetBase, "MIGRATION.md"), dryRun, log);
  copyIfMissing(join(skillDir, "QUICKSTART.md"), join(targetBase, "QUICKSTART.md"), dryRun, log);
  copyIfMissing(join(skillDir, "ERROR-RECOVERY.md"), join(targetBase, "ERROR-RECOVERY.md"), dryRun, log);
  copyIfMissing(join(skillDir, "EDGE-CASES.md"), join(targetBase, "EDGE-CASES.md"), dryRun, log);
  copyIfMissing(join(skillDir, "audit.config.example.json"), join(targetBase, "audit.config.example.json"), dryRun, log);
  copyIfMissing(join(skillDir, "mcp_server.mjs"), join(targetBase, "mcp_server.mjs"), dryRun, log);

  // NOTE: audit.config.json, KB seeding, version marker, hook installation, and
  // ripple check are handled by runProjectSetup() — called via cmdSetup after
  // upgrade completes. The shipped hook source files above are part of the
  // planner install surface and must exist before setup runs.

  // --- Workflows (dynamic scan) ---
  log.push("\n## Workflows");
  const sourceWorkflowsDir = join(agentDir, "workflows");
  const targetWorkflowsDir = join(targetPath, ".agent/workflows");
  if (existsSync(sourceWorkflowsDir)) {
    for (const f of listManagedDirNames(sourceWorkflowsDir, (f) => f.endsWith(".md")).sort()) {
      copyIfMissing(join(sourceWorkflowsDir, f), join(targetWorkflowsDir, f), dryRun, log);
    }
  }
  pruneObsoletePlannerWorkflowFiles(targetPath, dryRun, log);

  // --- Agent-level config files ---
  log.push("\n## Agent Config");
  const agentFiles = ["rules.md", "gotchas.md", "ADAPTATION-GUIDE.md"];
  for (const f of agentFiles) {
    copyIfMissing(join(agentDir, f), join(targetPath, ".agent", f), dryRun, log);
  }

  // --- Agent scripts (non-skill) ---
  log.push("\n## Agent Scripts");
  const agentScriptsDir = join(targetPath, ".agent/scripts");
  const agentScriptFiles = ["sync-instructions.sh", "migrate-all-projects.sh"];
  for (const fileName of agentScriptFiles) {
    const agentScriptSrc = join(agentDir, "scripts", fileName);
    const agentScriptDest = join(agentScriptsDir, fileName);
    if (existsSync(agentScriptSrc)) {
      ensureDir(agentScriptsDir);
      copyIfMissing(agentScriptSrc, agentScriptDest, dryRun, log);
      if (!dryRun && existsSync(agentScriptDest)) chmodSync(agentScriptDest, 0o755);
    }
  }

  // --- Other skills (red-team-remediation, etc.) ---
  log.push("\n## Other Skills");
  const sourceSkillsDir = join(agentDir, "skills");
  if (existsSync(sourceSkillsDir)) {
    for (const skillName of listManagedDirNames(sourceSkillsDir).sort()) {
      if (skillName === "iterative-planner") continue;
      const src = join(sourceSkillsDir, skillName);
      if (!statSync(src).isDirectory()) continue;
      copyDirTree(src, join(targetPath, ".agent/skills", skillName), (name) => name.endsWith(".md"), dryRun, log);
    }
  }

  // --- v3.8.0: Seed circuit_breakers field in active plan state.json ---
  // The persistent circuit breaker (v3.8.0) reads circuit_breakers from state.json.
  // Existing plans without this field work fine (defaults to {} on first access),
  // but we seed it proactively to make the schema explicit and avoid first-write surprises.
  if (!dryRun) {
    try {
      const plansDir = join(targetPath, "plans");
      const pointerFile = join(plansDir, ".current_plan");
      if (existsSync(pointerFile)) {
        const planDirName = readFileSync(pointerFile, "utf-8").trim();
        const planDir = join(plansDir, planDirName);
        const statePath = join(plansDir, planDirName, "state.json");
        if (existsSync(statePath)) {
          const stateJson = JSON.parse(readFileSync(statePath, "utf-8"));
          if (!stateJson.circuit_breakers) {
            stateJson.circuit_breakers = {};
            delete stateJson._state_hash;
            writeFileSync(statePath, JSON.stringify(stateJson, null, 2) + "\n");
            log.push(`  SEEDED: circuit_breakers field in ${planDirName}/state.json (v3.8.0)`);
          }
        }

        const findingsLedgerPath = join(planDir, "findings_ledger.json");
        if (!existsSync(findingsLedgerPath)) {
          writeFileSync(findingsLedgerPath, JSON.stringify({
            version: 1,
            fast_track: false,
            kb_digest_salt: null,
            findings: [],
            root_cause: null,
            adjacency: null,
            assumptions: [],
            existing_capabilities: [],
            story_candidates: [],
          }, null, 2) + "\n");
          log.push(`  SEEDED: findings_ledger.json in ${planDirName} (structured findings rollout)`);
        }

        const intentContractPath = join(planDir, "intent_contract.json");
        if (!existsSync(intentContractPath)) {
          writeFileSync(intentContractPath, JSON.stringify({
            version: 1,
            primary_user: null,
            job_to_be_done: null,
            desired_outcomes: [],
            anti_goals: [],
            constraints: [],
            deliverables: [],
          }, null, 2) + "\n");
          log.push(`  SEEDED: intent_contract.json in ${planDirName} (structured intent rollout)`);
        }

        const workOrderPath = join(planDir, "work_order.json");
        if (!existsSync(workOrderPath)) {
          let intentContract = null;
          try {
            intentContract = JSON.parse(readFileSync(intentContractPath, "utf-8"));
          } catch {
            intentContract = {
              version: 1,
              primary_user: null,
              job_to_be_done: null,
              desired_outcomes: [],
              anti_goals: [],
              constraints: [],
              deliverables: [],
            };
          }
          const stateJson = readPlanStateJson(planDir);
          writePlanWorkOrderProjection(planDir, {
            goal: stateJson?.goal || `Active planner plan ${planDirName}`,
            intentContract,
          });
          log.push(`  SEEDED: work_order.json in ${planDirName} (structured work-order projection rollout)`);
        }
      }
    } catch (e) {
      log.push(`  WARN: Could not seed active plan rollout files: ${e.message}`);
    }
  }

  // --- Seed KB if requested ---
  if (seedKB) {
    log.push("\n## Knowledge Base Seeds");
    const seedDir = join(skillDir, "knowledge/seed");
    const targetKBDir = join(targetPath, "plans/knowledge");
    if (existsSync(seedDir)) {
      ensureDir(targetKBDir);
      for (const f of listManagedDirNames(seedDir)) {
        if (f.endsWith(".md")) {
          copyIfMissing(join(seedDir, f), join(targetKBDir, `seed-${f}`), dryRun, log);
        }
      }
    }
  }

  // Version marker update is handled by runProjectSetup() after upgrade.

  // Print log
  for (const line of log) {
    console.log(line);
  }

  // --- Post-upgrade verification ---
  console.log();
  if (!dryRun) {
    const postManifest = buildExpectedManifest(targetPath);
    const stillMissing = postManifest.filter(e => !existsSync(e.path));
    const stillMissingCritical = stillMissing.filter(e => e.critical);
    const stillStale = findVerificationDrift(postManifest, targetPath);

    if (stillMissing.length === 0 && stillStale.length === 0) {
      console.log(`  ✅ POST-UPGRADE VERIFICATION: All ${postManifest.length} files present and current.`);
    } else if (stillMissingCritical.length > 0) {
      console.log(`  ❌ POST-UPGRADE VERIFICATION: ${stillMissingCritical.length} CRITICAL file(s) still missing:`);
      for (const e of stillMissingCritical) {
        console.log(`     - ${relative(targetPath, e.path)} [${e.category}]`);
      }
    } else {
      console.log(`  ⚠️  POST-UPGRADE VERIFICATION: ${stillMissing.length} optional file(s) still missing.`);
    }
    if (stillStale.length > 0) {
      console.log(`  ❌ POST-UPGRADE VERIFICATION: ${stillStale.length} managed file(s) remain stale.`);
      for (const entry of stillStale.slice(0, 15)) {
        console.log(`     - ${relative(targetPath, entry.path)} [${entry.category}]`);
      }
      process.exitCode = 1;
    }
    // Config integrity baselines are signed trust anchors. Migration may create
    // a missing first baseline, but existing baselines require an out-of-band
    // nonce before re-baselining so a tampered in-tree rule file is not laundered.
    console.log(`  ✅ CONFIG INTEGRITY: Retired by E8-1; no baseline or rebaseline required.`);
    console.log(`  ✅ PERSONA MANIFEST: Retired by E8-1; no manifest hash refresh required.`);

    console.log(`\n  ══ UPGRADE COMPLETE — ${version} → ${CURRENT_VERSION} ══`);
    console.log(`  IMPORTANT: Review SKILL.md changes manually.`);
    console.log(`  See MIGRATION.md for manual SKILL.md integration steps.`);
  } else {
    console.log(`  ══ DRY RUN COMPLETE — no files were modified ══`);
  }

  return {
    noOp: false,
    setupNeeded: true,
    changed: !dryRun,
    from: version,
    to: CURRENT_VERSION,
    reason: "upgrade-or-repair",
  };
}

function cmdVerify(targetPath) {
  const manifest = buildExpectedManifest(targetPath);
  const missing = manifest.filter(e => !existsSync(e.path));
  const missingCritical = missing.filter(e => e.critical);
  const present = manifest.filter(e => existsSync(e.path));
  const stale = findVerificationDrift(manifest, targetPath);
  const advisoryIssues = findRootInstructionSyncIssues(targetPath);
  const ritualContractReadiness = validateRitualContractReadiness(targetPath);
  const categories = buildCategorySummary(manifest, stale);

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  POST-UPGRADE VERIFICATION                          ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  console.log(`  Expected: ${manifest.length}  Present: ${present.length}  Missing: ${missing.length}\n`);

  for (const [cat, info] of Object.entries(categories).sort((a, b) => a[0].localeCompare(b[0]))) {
    const icon = info.missing === 0 && !info.stale ? "✅" : info.critical_missing > 0 ? "❌" : "⚠️";
    let extra = "";
    if (info.critical_missing > 0) extra += ` (${info.critical_missing} CRITICAL)`;
    if (info.stale > 0) extra += ` (${info.stale} stale)`;
    console.log(`  ${icon} ${cat.padEnd(20)} ${info.present}/${info.total}${extra}`);
  }

  if (missingCritical.length > 0) {
    console.log(`\n  🔴 CRITICAL files missing (${missingCritical.length}):`);
    for (const e of missingCritical) {
      console.log(`     - ${relative(targetPath, e.path)}`);
    }
  }

  if (stale.length > 0) {
    console.log(`\n  🟡 STALE files (${stale.length}) — content differs from source, run upgrade to update:`);
    for (const e of stale.slice(0, 20)) {
      console.log(`     - ${relative(targetPath, e.path)} [${e.category}]`);
    }
    if (stale.length > 20) console.log(`     ... and ${stale.length - 20} more`);
  }

  if (advisoryIssues.length > 0) {
    console.log(`\n  ℹ️  Advisory sync drift (${advisoryIssues.length}) — does not block install health or self-heal:`);
    for (const entry of advisoryIssues.slice(0, 20)) {
      console.log(`     - ${relative(targetPath, entry.path)} [${entry.category}] (${entry.code})`);
    }
  }

  console.log(`\n  ${verificationStatusIsPass(ritualContractReadiness.status, "execution") ? "✅" : "❌"} ritual_contract_readiness ${ritualContractReadiness.status} (${ritualContractReadiness.issue_count} issue(s), public workflows ${ritualContractReadiness.registry_public_count}, workflow files ${ritualContractReadiness.workflow_file_count})`);
  for (const issue of (ritualContractReadiness.issues || []).slice(0, 20)) {
    console.log(`     - ${issue.id}: ${issue.message}`);
  }

  if (missing.length > 0 && missingCritical.length === 0) {
    console.log(`\n  🟡 Only optional files missing — core functionality intact.`);
  }

  if (missing.length === 0 && stale.length === 0 && verificationStatusIsPass(ritualContractReadiness.status, "execution")) {
    if (advisoryIssues.length > 0) {
      console.log(`\n  ✅ PASS — Planner-managed files are present and current. Advisory instruction drift is listed above.`);
    } else {
      console.log(`\n  ✅ PASS — Installation complete. All ${manifest.length} files present and up to date.`);
    }
  } else if (missing.length === 0 && stale.length > 0) {
    console.log(`\n  ⚠️  STALE — All files present but ${stale.length} need updating. Run: node migrate.mjs upgrade <path> --commit`);
  }

  console.log();
  process.exit(missingCritical.length > 0 || !verificationStatusIsPass(ritualContractReadiness.status, "execution") ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Project-level setup (always runs, regardless of version)
// ---------------------------------------------------------------------------

function cmdSetup(targetPath, dryRun, options = {}) {
  const log = [];
  const profile = normalizeSetupProfile(options.profile || "full");
  if (!SETUP_PROFILES.has(profile)) {
    console.error(`ERROR: Unknown setup profile '${options.profile}'. Expected: full, kernel.`);
    process.exit(2);
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  PROJECT SETUP ${profile === "kernel" ? "[kernel] " : ""}${dryRun ? "(DRY RUN) " : ""}                     ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  if (profile === "kernel") {
    runKernelProjectSetup(targetPath, dryRun, log);
  } else {
    runProjectSetup(targetPath, dryRun, log);
  }

  // Print log
  for (const line of log) {
    console.log(line);
  }

  console.log(`\n  ══ SETUP COMPLETE ══`);
  if (profile === "kernel") {
    console.log(`  Kernel profile installed. Use kernel-status to inspect journal counts and earned-layer activation.`);
  } else {
    console.log(`  If audit.config.json was just created, edit it to add your domain role(s): "assumptions_challenger", "quant", "tokenomics", "ux_ui", etc.`);
  }
  console.log();
}

function cmdSyncInstructions(targetPath, dryRun, jsonOutput) {
  const log = [];
  const report = syncRootInstructionSurfaces(targetPath, { dryRun, log });

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(verificationStatusIsPass(report.status, "execution") ? 0 : 1);
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  ROOT INSTRUCTION SYNC ${dryRun ? "(DRY RUN) " : ""}                    ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  for (const line of log) console.log(line);
  if (!verificationStatusIsPass(report.status, "execution")) {
    console.log(`\n  ❌ Sync skipped: root instruction template is invalid.`);
    process.exit(1);
  }
  console.log(`\n  ══ ROOT INSTRUCTION SYNC COMPLETE ══`);
  console.log();
}

// ---------------------------------------------------------------------------
// Annotate — agent-assisted @planner: annotation bootstrapping
// ---------------------------------------------------------------------------

function cmdAnnotate(targetPath, dryRun) {
  const assistScript = join(scriptDir, "annotation_assist.mjs");
  const parserScript = join(scriptDir, "annotation_parser.mjs");
  const serializerScript = join(scriptDir, "ontology_serializer.mjs");

  if (!existsSync(assistScript)) {
    console.error("ERROR: annotation_assist.mjs not found. Run 'upgrade' first.");
    process.exit(1);
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  ANNOTATION BOOTSTRAP ${dryRun ? "(DRY RUN) " : ""}                        ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  // --- Phase 1: Scan and report ---
  console.log("  Phase 1: Scanning project for annotation candidates...\n");
  try {
    const scanResult = runNode([assistScript, "--dir", targetPath, "--json"], {
      timeout: 120000,
    });

    let report;
    try { report = JSON.parse(scanResult); } catch {
      console.error("  ERROR: Could not parse annotation_assist output.");
      return;
    }

    console.log(`  Files scanned:          ${report.scanned}`);
    console.log(`  Files with suggestions: ${report.files.length}`);
    console.log(`  Total suggestions:      ${report.totalSuggestions}`);

    // Count by confidence
    let high = 0, medium = 0, low = 0;
    const byKey = {};
    for (const f of report.files) {
      for (const s of f.suggestions) {
        if (s.confidence === "high") high++;
        else if (s.confidence === "medium") medium++;
        else low++;
        byKey[s.key] = (byKey[s.key] || 0) + 1;
      }
    }
    console.log(`\n  High confidence:   ${high}`);
    console.log(`  Medium confidence: ${medium}`);
    console.log(`  Low confidence:    ${low}`);
    console.log(`\n  By type:`);
    for (const [key, count] of Object.entries(byKey).sort((a, b) => b[1] - a[1])) {
      console.log(`    @planner:${key.padEnd(25)} ${count}`);
    }

    if (report.totalSuggestions === 0) {
      console.log(`\n  No annotation candidates found. Project may already be annotated or have no scannable source files.`);
      return;
    }

    // --- Phase 2: Apply high-confidence annotations ---
    console.log(`\n  Phase 2: ${dryRun ? "Previewing" : "Applying"} high-confidence annotations...\n`);
    const applyMode = dryRun ? "--dry-run" : "--apply";
    try {
      const applyResult = runNode([assistScript, "--dir", targetPath, applyMode, "--min-confidence", "high"], {
        timeout: 120000,
      });
      // Print stdout lines
      for (const line of applyResult.split("\n")) {
        if (line.trim()) console.log(`  ${line}`);
      }
    } catch (e) {
      const output = e.stdout || e.stderr || "";
      for (const line of output.split("\n")) {
        if (line.trim()) console.log(`  ${line}`);
      }
    }

    // --- Phase 3: Generate review checklist for medium/low confidence ---
    const reviewItems = [];
    for (const f of report.files) {
      const needsReview = f.suggestions.filter(s => s.confidence !== "high");
      if (needsReview.length > 0) {
        reviewItems.push({ file: f.file, suggestions: needsReview });
      }
    }

    if (reviewItems.length > 0 && !dryRun) {
      const reviewPath = join(targetPath, "plans", "annotation_review.md");
      const reviewLines = [
        "# Annotation Review Checklist",
        "",
        `Generated: ${new Date().toISOString().slice(0, 10)}`,
        `Project: ${targetPath}`,
        "",
        "These suggestions need human review before applying.",
        "Edit this file — check items you approve, delete items you reject.",
        "Then run: `node .agent/skills/iterative-planner/scripts/annotation_parser.mjs --validate`",
        "",
        "---",
        "",
      ];

      for (const item of reviewItems) {
        reviewLines.push(`## ${item.file}`);
        reviewLines.push("");
        for (const s of item.suggestions) {
          const badge = s.confidence === "medium" ? "MEDIUM" : "LOW";
          reviewLines.push(`- [ ] \`${s.annotation}\` — [${badge}] ${s.reason}`);
        }
        reviewLines.push("");
      }

      reviewLines.push("---");
      reviewLines.push("");
      reviewLines.push("## Manual annotations to add");
      reviewLines.push("");
      reviewLines.push("The assist tool cannot infer these — add them based on your domain knowledge:");
      reviewLines.push("");
      reviewLines.push("- [ ] `@planner:proves = crit:<criterion_id>` — which validation files prove which success criteria?");
      reviewLines.push("- [ ] `@planner:mutually_exclusive = <other_flag>` — which config flags conflict?");
      reviewLines.push("- [ ] `@planner:reviewed_by = <persona>` — which files need specific persona review?");
      reviewLines.push("- [ ] `@planner:metric_type = raw|capped|transformed|normalized` — metric classification for contamination checks");
      reviewLines.push("");

      try {
        const plansDir = join(targetPath, "plans");
        if (!existsSync(plansDir)) mkdirSync(plansDir, { recursive: true });
        writeFileSync(reviewPath, reviewLines.join("\n"), "utf-8");
        console.log(`\n  Review checklist written to: plans/annotation_review.md`);
        console.log(`  ${reviewItems.length} files with ${reviewItems.reduce((n, i) => n + i.suggestions.length, 0)} suggestions need human review.`);
      } catch (e) {
        console.log(`\n  WARNING: Could not write review checklist: ${e.message}`);
      }
    }

    // --- Phase 4: Validate and report traceability ---
    if (!dryRun) {
      console.log(`\n  Phase 3: Validating annotations...\n`);
      try {
        const validateResult = runNode([parserScript, "--dir", targetPath, "--validate"], { timeout: 60000 });
        for (const line of validateResult.split("\n")) {
          if (line.trim()) console.log(`  ${line}`);
        }
      } catch (e) {
        const output = e.stdout || e.stderr || "";
        for (const line of output.split("\n")) {
          if (line.trim()) console.log(`  ${line}`);
        }
      }

      console.log(`\n  Phase 4: Generating traceability facts...\n`);
      try {
        const traceResult = runNode([serializerScript, "--dir", targetPath, "--json"], { timeout: 60000 });
        let traceMeta;
        try { traceMeta = JSON.parse(traceResult).meta; } catch { /* skip */ }
        if (traceMeta) {
          console.log(`  Traceability facts generated:`);
          console.log(`    Goals:                 ${traceMeta.goals}`);
          console.log(`    Success criteria:      ${traceMeta.criteria}`);
          console.log(`    Goal→criterion links:  ${traceMeta.goal_criterion_links}`);
          console.log(`    Criterion→story links: ${traceMeta.criterion_story_links}`);
          console.log(`    Validation artifacts:  ${traceMeta.validation_artifacts}`);
          console.log(`    Audit passes:          ${traceMeta.audit_passes}`);
          console.log(`    Annotation proofs:     ${traceMeta.annotation_proves}`);
          console.log(`    Verification results:  ${traceMeta.verification_results}`);
        }
      } catch (e) {
        const output = e.stdout || e.stderr || "";
        for (const line of output.split("\n")) {
          if (line.trim()) console.log(`  ${line}`);
        }
      }
    }

  } catch (e) {
    const output = e.stdout || e.stderr || e.message || "";
    console.error(`  ERROR during annotation scan: ${output.slice(0, 500)}`);
    return;
  }

  // --- Phase 5: Bootstrap story registry ---
  const bootstrapScript = join(scriptDir, "story_registry_bootstrap.mjs");
  if (existsSync(bootstrapScript)) {
    const registryPath = join(targetPath, "reports", "user_story_audit", "story_registry.json");
    const registryExists = existsSync(registryPath);
    if (!registryExists) {
      console.log(`\n  Phase 5: Bootstrapping story registry...\n`);
      try {
        const bootstrapArgs = [bootstrapScript, "--dir", targetPath];
        if (dryRun) bootstrapArgs.push("--dry-run");
        const bootstrapResult = runNode(bootstrapArgs, { timeout: 60000 });
        for (const line of bootstrapResult.split("\n")) {
          if (line.trim()) console.log(`  ${line}`);
        }
      } catch (e) {
        const output = e.stdout || e.stderr || "";
        console.log(`  ⚠️ Story registry bootstrap warning: ${output.slice(0, 200) || e.message}`);
      }
    } else {
      console.log(`\n  Phase 5: Story registry already exists — skipping bootstrap`);
      console.log(`    To add new stories: node ${bootstrapScript} --dir "${targetPath}" --dry-run`);
    }
  }

  console.log(`\n  ══ ANNOTATION BOOTSTRAP ${dryRun ? "(DRY RUN) " : ""}COMPLETE ══`);
  if (!dryRun) {
    console.log(`\n  Next steps:`);
    console.log(`    1. Review plans/annotation_review.md — approve/reject medium/low confidence suggestions`);
    console.log(`    2. Manually add @planner:proves, @planner:mutually_exclusive annotations`);
    console.log(`    3. Re-validate: node .agent/skills/iterative-planner/scripts/annotation_parser.mjs --validate`);
    console.log(`    4. Check traceability: node .agent/skills/iterative-planner/scripts/ontology_serializer.mjs --json`);
    console.log(`    5. Update story registry: node .agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Project registry — persists discovered project paths for upgrade-all
// ---------------------------------------------------------------------------

const registryPath = registryPathFromEnv();

function normalizeRegistry(registry) {
  return {
    ...registry,
    source_project_path: registry?.source_project_path || canonicalSourceProjectPath(),
    projects: Array.isArray(registry?.projects) ? registry.projects : [],
    last_scan: registry?.last_scan || null,
    scan_roots: Array.isArray(registry?.scan_roots) ? registry.scan_roots : [],
  };
}

function loadRegistry() {
  try {
    if (existsSync(registryPath)) return normalizeRegistry(JSON.parse(readFileSync(registryPath, "utf-8")));
  } catch { /* corrupt — reset */ }
  return normalizeRegistry({ projects: [], last_scan: null });
}

function fleetRegistryStatus(registry = loadRegistry()) {
  const projects = Array.isArray(registry.projects) ? registry.projects : [];
  const existingProjects = projects.filter((project) => project?.path && existsSync(project.path));
  const staleProjects = projects.filter((project) => project?.path && !existsSync(project.path));
  return {
    path: registryPath,
    scope: "fleet_batch_cache_only",
    per_project_registration_required: false,
    last_scan: registry.last_scan || null,
    project_count: projects.length,
    existing_project_count: existingProjects.length,
    stale_paths_ignored: staleProjects.length,
    stale_paths_status: staleProjects.length > 0 ? "advisory_fleet_only" : "none",
  };
}

function printFleetRegistryBoundary(status = fleetRegistryStatus()) {
  console.log("  Registry scope: fleet/batch commands only; single-project migration uses explicit target paths and does not require source-repo registration.");
  if (status.stale_paths_ignored > 0) {
    console.log(`  Stale registry paths: ${status.stale_paths_ignored} ignored for this fleet run (advisory fleet drift; run scan to refresh the batch cache).`);
  }
}

function saveRegistry(registry) {
  const normalized = normalizeRegistry(registry);
  const tmpPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(normalized, null, 2) + "\n");
    renameSync(tmpPath, registryPath);
  } catch (error) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/**
 * Recursively scan directories for iterative planner installations.
 * Looks for .agent/skills/iterative-planner/ or .agent/iterative-planner/.
 * Skips node_modules, .git, and other noise directories.
 */
function scanForProjects(roots) {
  const found = [];
  const skipDirs = new Set(["node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build", ".next"]);

  function scan(dir, depth) {
    if (depth > 6) return; // Don't recurse too deep
    let entries;
    try { entries = listManagedDirEntries(dir); } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (skipDirs.has(entry.name)) continue;
      const full = join(dir, entry.name);

      // Check if this directory IS a project with the planner
      const standardPath = join(full, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs");
      const legacyPath = join(full, ".agent", "iterative-planner", "SKILL.md");
      if (existsSync(standardPath)) {
        found.push({ path: full, type: "standard" });
        continue; // Don't recurse into projects
      }
      if (existsSync(legacyPath)) {
        found.push({ path: full, type: "legacy" });
        continue;
      }
      // Recurse into subdirectories
      scan(full, depth + 1);
    }
  }

  for (const root of roots) {
    if (existsSync(root)) scan(root, 0);
  }

  // Deduplicate by resolved path
  const seen = new Set();
  return found.filter(p => {
    const resolved = resolve(p.path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function cmdScan(roots, quiet) {
  if (!quiet) {
    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║  SCANNING FOR ITERATIVE PLANNER PROJECTS            ║`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
    console.log(`  Scanning: ${roots.join(", ")}\n`);
  }

  const projects = scanForProjects(roots);

  // Enrich with version info
  const enriched = projects.map(p => {
    const skillMd = join(p.path, ".agent/skills/iterative-planner/SKILL.md");
    const content = readFile(skillMd);
    const vMatch = content?.match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/);
    return {
      ...p,
      version: vMatch ? vMatch[1] : "unknown",
      name: basename(p.path),
    };
  });

  // Save to registry
  const registry = {
    projects: enriched.map(p => ({ path: p.path, type: p.type })),
    last_scan: new Date().toISOString(),
    scan_roots: roots,
  };
  saveRegistry(registry);

  if (!quiet) {
    if (enriched.length === 0) {
      console.log("  No projects found.\n");
      return enriched;
    }

    // Group by version
    const byVersion = {};
    for (const p of enriched) {
      const v = p.version;
      if (!byVersion[v]) byVersion[v] = [];
      byVersion[v].push(p);
    }

    const needsUpgrade = enriched.filter(p => p.version !== CURRENT_VERSION);

    for (const [version, ps] of Object.entries(byVersion).sort()) {
      const icon = version === CURRENT_VERSION ? "✅" : "⬆️";
      console.log(`  ${icon} v${version} (${ps.length} project${ps.length > 1 ? "s" : ""}):`);
      for (const p of ps) {
        const typeTag = p.type === "legacy" ? " [legacy]" : "";
        console.log(`     ${p.path}${typeTag}`);
      }
      console.log();
    }

    console.log(`  Summary: ${enriched.length} projects found, ${needsUpgrade.length} need upgrade to v${CURRENT_VERSION}`);
    console.log(`  Registry saved to: ${registryPath}`);
    if (needsUpgrade.length > 0) {
      console.log(`\n  To upgrade all: node migrate.mjs upgrade-all --commit`);
    }
    console.log();
  }

  return enriched;
}

function cmdUpgradeAll(dryRun, commitRequested = false) {
  const registry = loadRegistry();
  const initialRegistryStatus = fleetRegistryStatus(registry);

  // If no registry or stale (>7 days), auto-scan
  const registryAge = registry.last_scan
    ? (Date.now() - new Date(registry.last_scan).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  let projects;
  if (registry.projects.length === 0 || registryAge > 7) {
    console.log("  Fleet registry empty or stale (batch cache only) - scanning for projects first...");
    printFleetRegistryBoundary(initialRegistryStatus);
    console.log();
    const homeDir = homedir();
    const defaultRoots = [
      join(homeDir, "Dropbox (Personal)", "Freelance"),
      join(homeDir, "Documents"),
      join(homeDir, "Projects"),
      join(homeDir, "Desktop"),
    ].filter(existsSync);
    projects = cmdScan(defaultRoots, false);
  } else {
    // Use cached registry but verify paths still exist
    projects = registry.projects
      .filter(p => existsSync(p.path))
      .map(p => {
        const skillMd = join(p.path, ".agent/skills/iterative-planner/SKILL.md");
        const content = readFile(skillMd);
        const vMatch = content?.match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/);
        return { ...p, version: vMatch ? vMatch[1] : "unknown", name: basename(p.path) };
      });
    console.log(`  Using cached fleet registry (${projects.length} existing projects, scanned ${registry.last_scan})`);
    printFleetRegistryBoundary(initialRegistryStatus);
    console.log();
  }

  // Filter to source project itself
  const sourceProject = canonicalSourceProjectPath();
  const targets = projects.filter(p => resolve(p.path) !== sourceProject);

  const needsUpgrade = targets.filter(p => p.version !== CURRENT_VERSION);
  const alreadyCurrent = targets.filter(p => p.version === CURRENT_VERSION);

  console.log(`╔══════════════════════════════════════════════════════╗`);
  console.log(`║  UPGRADE ALL ${dryRun ? "(DRY RUN) " : ""}                                  ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  console.log(`  Source version: ${CURRENT_VERSION}`);
  console.log(`  Projects: ${targets.length} total, ${needsUpgrade.length} need upgrade, ${alreadyCurrent.length} current\n`);

  if (needsUpgrade.length === 0 && alreadyCurrent.length > 0) {
    // Even current projects may have stale files — run upgrade on all
    console.log(`  All projects at v${CURRENT_VERSION}, but checking for stale files...\n`);
  }

  const results = [];

  for (const project of targets) {
    const label = `${project.name} (${project.version})`;
    console.log(`\n── ${label} ──`);
    console.log(`   ${project.path}\n`);

    try {
      // Run the same single-project transactional boundary for every target.
      const preview = cmdUpgrade(project.path, false, true);
      let upgradeResult = preview;
      if (!dryRun && !preview?.blocked && !preview?.noOp) {
        if (!commitRequested) {
          console.log(`   CONSENT REQUIRED: ${managedUpgradeConsentCommand(project.path, selectedSourceCommit() || selectedSourceRef(), false, __filename)}`);
          upgradeResult = {
            ...preview,
            changed: false,
            consentRequired: true,
            reason: "commit-consent-required",
          };
        } else {
          const transaction = runManagedUpgradeTransaction({
            targetPath: project.path,
            sourceScript: __filename,
            sourceRef: selectedSourceRef(),
            sourceCommit: selectedSourceCommit(),
            fromVersion: readCommittedPlannerVersion(project.path),
            toVersion: CURRENT_VERSION,
          });
          upgradeResult = {
            noOp: false,
            setupNeeded: false,
            changed: transaction.ok,
            from: project.version,
            to: CURRENT_VERSION,
            reason: "transactional-upgrade",
          };
        }
      }

      // Verify version after upgrade
      const postSkillMd = join(project.path, ".agent/skills/iterative-planner/SKILL.md");
      const postContent = readFile(postSkillMd);
      const postVersion = postContent?.match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/)?.[1] || "unknown";

      results.push({
        name: project.name,
        path: project.path,
        from: project.version,
        to: postVersion,
        status: upgradeResult?.consentRequired ? "CONSENT_REQUIRED" : "OK",
        noOp: !!upgradeResult?.noOp,
        setupNeeded: !!upgradeResult?.setupNeeded,
        changed: !!upgradeResult?.changed,
      });
    } catch (e) {
      console.error(`   ❌ FAILED: ${e.message}`);
      results.push({ name: project.name, path: project.path, from: project.version, to: "FAILED", status: e.message });
    }
  }

  // Print summary
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  UPGRADE-ALL SUMMARY                                ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  const consentRequired = results.filter((r) => r.status === "CONSENT_REQUIRED");
  const ok = results.filter((r) => verificationStatusIsPass(r.status, "execution"));
  const failed = results.filter(
    (r) => r.status !== "CONSENT_REQUIRED"
      && !verificationStatusIsPass(r.status, "execution"),
  );

  for (const r of results) {
    const icon = r.status === "CONSENT_REQUIRED"
      ? "⏸️"
      : (verificationStatusIsPass(r.status, "execution") ? "✅" : "❌");
    const versionChange = r.from === r.to ? `v${r.to}` : `v${r.from} → v${r.to}`;
    console.log(`  ${icon} ${r.name.padEnd(35)} ${versionChange}`);
  }

  console.log(`\n  ${ok.length} succeeded, ${consentRequired.length} awaiting consent, ${failed.length} failed out of ${results.length} projects`);
  if (failed.length > 0) {
    console.log(`\n  Failed projects:`);
    for (const r of failed) console.log(`    ${r.path}: ${r.status}`);
  }
  console.log();

  if (dryRun) {
    console.log(`  Registry metadata unchanged in dry run.`);
    return;
  }
  if (!commitRequested && consentRequired.length > 0) {
    console.log(`  Registry metadata unchanged; rerun upgrade-all with --commit to consent.`);
    process.exitCode = 2;
    return;
  }

  // Update registry with new versions
  const updatedRegistry = loadRegistry();
  let registryChanged = false;
  for (const r of ok) {
    if (r.noOp) continue;
    const entry = updatedRegistry.projects.find(p => resolve(p.path) === resolve(r.path));
    if (entry) {
      entry.last_upgraded = new Date().toISOString();
      registryChanged = true;
    }
  }
  if (registryChanged) {
    saveRegistry(updatedRegistry);
  } else {
    console.log(`  Registry metadata unchanged for no-op projects.`);
  }
}

function cmdAnnotateAll(dryRun) {
  const registry = loadRegistry();
  const initialRegistryStatus = fleetRegistryStatus(registry);
  const registryAge = registry.last_scan
    ? (Date.now() - new Date(registry.last_scan).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  let projects;
  if (registry.projects.length === 0 || registryAge > 7) {
    console.log("  Fleet registry empty or stale (batch cache only) - scanning for projects first...");
    printFleetRegistryBoundary(initialRegistryStatus);
    console.log();
    const homeDir = homedir();
    const defaultRoots = [
      join(homeDir, "Dropbox (Personal)", "Freelance"),
      join(homeDir, "Documents"),
      join(homeDir, "Projects"),
      join(homeDir, "Desktop"),
    ].filter(existsSync);
    projects = cmdScan(defaultRoots, false);
  } else {
    projects = registry.projects.filter(p => existsSync(p.path)).map(p => ({
      ...p, name: basename(p.path),
    }));
    console.log(`  Using cached fleet registry (${projects.length} existing projects)`);
    printFleetRegistryBoundary(initialRegistryStatus);
    console.log();
  }

  const sourceProject = canonicalSourceProjectPath();
  const targets = projects.filter(p => resolve(p.path) !== sourceProject);

  console.log(`╔══════════════════════════════════════════════════════╗`);
  console.log(`║  ANNOTATE ALL ${dryRun ? "(DRY RUN) " : ""}                                 ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Projects: ${targets.length}\n`);

  for (const project of targets) {
    console.log(`\n── ${project.name} ──`);
    console.log(`   ${project.path}\n`);
    try {
      cmdAnnotate(project.path, dryRun);
    } catch (e) {
      console.error(`   ❌ FAILED: ${e.message}`);
    }
  }

  console.log(`\n  ══ ANNOTATE-ALL COMPLETE ══\n`);
}

function defaultMigrationWavePath() {
  return join(process.cwd(), "reports", "migration_wave.json");
}

function projectDisplayName(projectPath) {
  return basename(resolve(projectPath));
}

function projectVersionAt(path) {
  return detectVersion(join(path, ".agent/skills/iterative-planner/SKILL.md"));
}

function buildMigrationWaveManifest({
  projects,
  expectedVersion = CURRENT_VERSION,
  deferredVersion = "5.1.6",
  exclusions = DEFAULT_MIGRATION_WAVE_EXCLUSIONS,
  reason = "Explicitly deferred by migration wave contract",
} = {}) {
  const excludeSelectors = normalizeStringArray(exclusions);
  const included = [];
  const excluded = [];

  for (const project of projects || []) {
    const detection = projectVersionAt(project.path);
    const matchingSelector = excludeSelectors.find((selector) => projectMatchesSelector(project, selector)) || null;
    const base = {
      name: project.name || projectDisplayName(project.path),
      path: resolve(project.path),
      actual_version: detection.version,
      detection_confidence: detection.confidence,
      detection_reason: detection.reason,
    };
    if (matchingSelector) {
      excluded.push({
        ...base,
        expected_version: deferredVersion,
        intentional_deferral: true,
        deferral_selector: matchingSelector,
        deferral_reason: reason,
        boundary_status: detection.version === deferredVersion ? "on_deferred_version" : "deferred_version_drift",
      });
      continue;
    }
    included.push({
      ...base,
      expected_version: expectedVersion,
      boundary_status: detection.version === expectedVersion ? "on_expected_version" : "expected_version_drift",
    });
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    source: "planner migration-wave create",
    current_version: CURRENT_VERSION,
    expected_versions: {
      included_projects: expectedVersion,
      intentionally_deferred_projects: deferredVersion,
    },
    exclusions: excludeSelectors.map((selector) => ({ selector, reason })),
    summary: {
      project_count: included.length + excluded.length,
      included_count: included.length,
      intentionally_deferred_count: excluded.length,
      included_drift_count: included.filter((entry) => entry.boundary_status !== "on_expected_version").length,
      deferred_drift_count: excluded.filter((entry) => entry.boundary_status !== "on_deferred_version").length,
    },
    included_projects: included.sort((a, b) => a.path.localeCompare(b.path)),
    excluded_projects: excluded.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function readMigrationWaveManifest(manifestPath = defaultMigrationWavePath()) {
  const parsed = readJsonSafe(manifestPath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { path: manifestPath, present: false, usable: false, manifest: null, error: parsed.error || "missing" };
  }
  const manifest = parsed.value;
  return {
    path: manifestPath,
    present: true,
    usable: manifest.version === 1 && Array.isArray(manifest.included_projects) && Array.isArray(manifest.excluded_projects),
    manifest,
    error: null,
  };
}

function migrationWaveDeferralForProject(project, manifestRead = null) {
  const read = manifestRead || readMigrationWaveManifest();
  if (!read.usable) return null;
  const resolvedPath = resolve(project.path);
  return (read.manifest.excluded_projects || []).find((entry) =>
    resolve(entry.path) === resolvedPath ||
    projectMatchesSelector(project, entry.deferral_selector || entry.name)
  ) || null;
}

function cmdMigrationWaveCreate(jsonOutput, manifestPath, exclusions, expectedVersion, deferredVersion, reason) {
  const projects = loadFleetProjects();
  const manifest = buildMigrationWaveManifest({
    projects,
    expectedVersion: expectedVersion || CURRENT_VERSION,
    deferredVersion: deferredVersion || "5.1.6",
    exclusions: exclusions.length > 0 ? exclusions : DEFAULT_MIGRATION_WAVE_EXCLUSIONS,
    reason: reason || "Explicitly deferred by migration wave contract",
  });
  const targetPath = manifestPath || defaultMigrationWavePath();
  ensureDir(dirname(targetPath));
  writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (jsonOutput) {
    console.log(JSON.stringify({ manifest_path: targetPath, ...manifest }, null, 2));
    return;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  MIGRATION WAVE CONTRACT CREATED                    ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Manifest: ${targetPath}`);
  console.log(`  Included: ${manifest.summary.included_count} expected at ${manifest.expected_versions.included_projects}`);
  console.log(`  Deferred: ${manifest.summary.intentionally_deferred_count} expected at ${manifest.expected_versions.intentionally_deferred_projects}`);
  for (const entry of manifest.excluded_projects) {
    console.log(`  - deferred: ${entry.name} (${entry.actual_version}; ${entry.boundary_status})`);
  }
  console.log();
}

function buildMigrationWaveVerification(manifestPath = defaultMigrationWavePath()) {
  const read = readMigrationWaveManifest(manifestPath);
  if (!read.usable) {
    return {
      manifest_path: manifestPath,
      status: "FAIL",
      error: read.error || "invalid_migration_wave_manifest",
      included_projects: [],
      excluded_projects: [],
      summary: { included_count: 0, intentionally_deferred_count: 0, failures: 1 },
    };
  }

  const verifyEntry = (entry, expectedBoundaryStatus) => {
    const detection = projectVersionAt(entry.path);
    const expectedVersion = entry.expected_version;
    const actualStatus = detection.version === expectedVersion ? expectedBoundaryStatus : "version_boundary_drift";
    return {
      ...entry,
      actual_version: detection.version,
      detection_confidence: detection.confidence,
      detection_reason: detection.reason,
      boundary_status: actualStatus,
      ok: actualStatus === expectedBoundaryStatus,
    };
  };

  const included = (read.manifest.included_projects || []).map((entry) => verifyEntry(entry, "on_expected_version"));
  const excluded = (read.manifest.excluded_projects || []).map((entry) => verifyEntry(entry, "on_deferred_version"));
  const failures = [...included, ...excluded].filter((entry) => !entry.ok);

  return {
    manifest_path: manifestPath,
    status: failures.length === 0 ? "PASS" : "FAIL",
    current_version: CURRENT_VERSION,
    expected_versions: read.manifest.expected_versions,
    summary: {
      included_count: included.length,
      intentionally_deferred_count: excluded.length,
      failures: failures.length,
      included_drift_count: included.filter((entry) => !entry.ok).length,
      deferred_drift_count: excluded.filter((entry) => !entry.ok).length,
    },
    included_projects: included,
    excluded_projects: excluded,
  };
}

function cmdMigrationWaveVerify(jsonOutput, manifestPath) {
  const report = buildMigrationWaveVerification(manifestPath || defaultMigrationWavePath());
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    if (!verificationStatusIsPass(report.status, "execution")) process.exitCode = 1;
    return;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  MIGRATION WAVE VERIFICATION                        ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Manifest: ${report.manifest_path}`);
  console.log(`  Status:   ${report.status}`);
  console.log(`  Included drift: ${report.summary.included_drift_count}`);
  console.log(`  Deferred drift: ${report.summary.deferred_drift_count}`);
  for (const entry of [...report.included_projects, ...report.excluded_projects].filter((item) => !item.ok)) {
    console.log(`  - ${entry.name}: actual ${entry.actual_version}, expected ${entry.expected_version} (${entry.boundary_status})`);
  }
  console.log();
  if (!verificationStatusIsPass(report.status, "execution")) process.exitCode = 1;
}

function collectHostProjectSurfaceStatus(targetPath) {
  return {
    discovery_policy: validateDiscoveryPolicySurface(targetPath),
    audit_config: validateAuditConfigSurface(targetPath),
    persona_adaptation: validatePersonaAdaptationSurface(targetPath),
    annotation_coverage: validateAnnotationCoverageSurface(targetPath),
    telemetry_capture: validateTelemetryCaptureSurface(targetPath),
    workflow_intelligence: validateWorkflowIntelligenceSurface(targetPath),
    root_instructions: validateRootInstructionSurface(targetPath),
    recipes: validateRecipeSurface(targetPath),
    story_registry: validateStoryRegistrySurface(targetPath),
    mistake_overrides: validateMistakeOverridesSurface(targetPath),
    learned_obligation_overrides: validateLearnedObligationOverridesSurface(targetPath),
  };
}

function classifyFleetStatus(report, secondPass = null) {
  if (!report) return "blocked";
  if ((report.summary?.critical_missing_count || 0) > 0) return "blocked";
  if (secondPass?.status && !verificationStatusIsPass(secondPass.status, "execution")) return "semantically_behind";
  if (
    report.summary?.version_mismatch &&
    (report.summary?.missing_count || 0) === 0 &&
    (report.summary?.setup_issue_count || 0) === 0 &&
    (report.summary?.stale_count || 0) <= 1
  ) {
    return "supported_lagging";
  }
  if ((report.summary?.stale_count || 0) > 0 || (report.summary?.setup_issue_count || 0) > 0) {
    return "semantically_behind";
  }
  if (report.summary?.version_mismatch) return "supported_lagging";
  return "current";
}

function fleetStatusReason(status) {
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Locally generated fleet classification controls whether a second scan is required; it is install-state routing rather than verification proof truth.
  if (status === "blocked") return "install_failure";
  if (status === "semantically_behind") return "semantic_backlog";
  if (status === "supported_lagging") return "version_lag";
  if (status === "intentionally_deferred") return "intentional_deferral";
  return "current";
}

function loadFleetProjects() {
  const registry = loadRegistry();
  const registryAge = registry.last_scan
    ? (Date.now() - new Date(registry.last_scan).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  if (registry.projects.length === 0 || registryAge > 7) {
    const homeDir = homedir();
    const defaultRoots = [
      join(homeDir, "Dropbox (Personal)", "Freelance"),
      join(homeDir, "Documents"),
      join(homeDir, "Projects"),
      join(homeDir, "Desktop"),
    ].filter(existsSync);
    cmdScan(defaultRoots, true);
  }

  const refreshed = loadRegistry();
  const sourceProject = canonicalSourceProjectPath();
  return refreshed.projects
    .filter((project) => existsSync(project.path))
    .filter((project) => resolve(project.path) !== sourceProject)
    .map((project) => ({
      ...project,
      name: basename(project.path),
    }));
}

function buildFleetProjectReport(project, migrationWaveRead = null) {
  const deferral = migrationWaveDeferralForProject(project, migrationWaveRead);
  if (deferral) {
    const detection = projectVersionAt(project.path);
    return attachSemanticHealth({
      name: project.name,
      path: project.path,
      status: "intentionally_deferred",
      status_reason: "intentional_deferral",
      detected_version: detection.version,
      current_version: CURRENT_VERSION,
      summary: {
        description: `intentionally deferred by migration wave: ${deferral.deferral_reason || "no reason recorded"}`,
        version_mismatch: detection.version !== CURRENT_VERSION,
        missing_count: 0,
        critical_missing_count: 0,
        stale_count: 0,
        setup_issue_count: 0,
        advisory_count: 0,
      },
      migration_wave_deferral: {
        expected_version: deferral.expected_version,
        actual_version: detection.version,
        deferral_selector: deferral.deferral_selector,
        deferral_reason: deferral.deferral_reason,
        boundary_status: detection.version === deferral.expected_version ? "on_deferred_version" : "deferred_version_drift",
      },
      host_project_surfaces: {},
      planner_managed_surfaces: {},
      second_pass_verification: {
        status: "SKIP",
        issue_count: 0,
        error_count: 0,
        warning_count: 0,
        checked_surfaces: [],
        issues: [],
        recommended_commands: [],
        reason: "intentionally_deferred_by_migration_wave",
      },
      second_pass_required: false,
      second_pass_verified: false,
    });
  }

  const doctor = buildDoctorReport(project.path);
  const secondPassVerification = collectSecondPassSemanticVerification(project.path);
  const status = classifyFleetStatus(doctor, secondPassVerification);
  return attachSemanticHealth({
    name: project.name,
    path: project.path,
    status,
    status_reason: fleetStatusReason(status),
    detected_version: doctor.detected_version,
    current_version: doctor.current_version,
    summary: doctor.summary,
    host_project_surfaces: secondPassVerification.host_project_surfaces,
    planner_managed_surfaces: secondPassVerification.planner_managed_surfaces,
    second_pass_verification: secondPassVerification,
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Locally generated fleet classification controls whether a second scan is required; it is install-state routing rather than verification proof truth.
    second_pass_required: status === "semantically_behind" || status === "blocked",
    second_pass_verified: verificationStatusIsPass(secondPassVerification.status, "execution"),
  });
}

function cmdSemanticScan(targetPath, jsonOutput) {
  const report = buildFleetProjectReport({ name: basename(targetPath), path: targetPath }, null);
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Semantic scan: ${report.name}`);
  console.log(`  path: ${report.path}`);
  console.log(`  status: ${report.semantic_health.overall_status}`);
  console.log(`  planner: ${report.semantic_health.planner_status}`);
  console.log(`  semantic: ${report.semantic_health.semantic_status}`);
  console.log(`  observability: ${report.semantic_health.observability_status}`);
  console.log(`  host_history: ${report.semantic_health.host_history_status}`);
  for (const command of report.semantic_health.recommended_commands || []) {
    console.log(`  repair: ${command}`);
  }
}

function cmdVerifyFleet(jsonOutput, manifestPath = null) {
  const projects = loadFleetProjects();
  const registryStatus = fleetRegistryStatus();
  const migrationWaveRead = readMigrationWaveManifest(manifestPath || defaultMigrationWavePath());
  const report = {
    generated_at: new Date().toISOString(),
    current_version: CURRENT_VERSION,
    fleet_registry: registryStatus,
    migration_wave: migrationWaveRead.usable ? {
      manifest_path: migrationWaveRead.path,
      included_count: migrationWaveRead.manifest.included_projects.length,
      intentionally_deferred_count: migrationWaveRead.manifest.excluded_projects.length,
    } : null,
    project_count: projects.length,
    statuses: {
      current: 0,
      supported_lagging: 0,
      semantically_behind: 0,
      blocked: 0,
      intentionally_deferred: 0,
    },
    semantic_health_statuses: {},
    projects: [],
  };

  for (const project of projects) {
    const projectReport = buildFleetProjectReport(project, migrationWaveRead);
    report.statuses[projectReport.status] += 1;
    const semanticStatus = projectReport.semantic_health?.overall_status || "unknown";
    report.semantic_health_statuses[semanticStatus] = (report.semantic_health_statuses[semanticStatus] || 0) + 1;
    report.projects.push(projectReport);
  }

  report.projects.sort((a, b) => a.path.localeCompare(b.path));

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  FLEET VERIFICATION                                 ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Current planner version: ${CURRENT_VERSION}`);
  console.log(`  Projects checked: ${report.project_count}\n`);
  printFleetRegistryBoundary(registryStatus);
  console.log();
  console.log(`  current:             ${report.statuses.current}`);
  console.log(`  supported_lagging:   ${report.statuses.supported_lagging}`);
  console.log(`  semantically_behind: ${report.statuses.semantically_behind}`);
  console.log(`  intentionally_deferred: ${report.statuses.intentionally_deferred}`);
  console.log(`  blocked:             ${report.statuses.blocked}\n`);
  console.log(`  semantic health:`);
  for (const [status, count] of Object.entries(report.semantic_health_statuses).sort()) {
    console.log(`    ${status}: ${count}`);
  }
  console.log();

  for (const project of report.projects) {
    console.log(`  - ${project.name} [${project.status}]`);
    console.log(`    ${project.path}`);
    console.log(`    version: ${project.detected_version} -> ${project.current_version}`);
    console.log(`    summary: ${project.summary.description}`);
    console.log(`    second pass: ${project.second_pass_verification.status} (${project.second_pass_verification.issue_count} issues)`);
    console.log(`    semantic health: ${project.semantic_health.overall_status} (semantic=${project.semantic_health.semantic_status}, observability=${project.semantic_health.observability_status}, host_history=${project.semantic_health.host_history_status})`);
    for (const command of project.second_pass_verification.recommended_commands) {
      console.log(`    follow-up: ${command}`);
    }
  }
  console.log();
}

function loadArchetypeProfiles() {
  const parsed = readJsonSafe(archetypeProfilesConfigPath);
  const profiles = parsed.ok && parsed.value?.profiles && typeof parsed.value.profiles === "object"
    ? parsed.value.profiles
    : {};
  return {
    path: archetypeProfilesConfigPath,
    version: parsed.value?.version || null,
    profiles,
    default_profile: parsed.value?.default_profile || "support_workflow",
  };
}

function loadPlannerProfile(targetPath) {
  const profilePath = join(targetPath, "planner.profile.json");
  const parsed = readJsonSafe(profilePath);
  return {
    path: profilePath,
    present: existsSync(profilePath),
    usable: parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value),
    profile: parsed.ok ? parsed.value : null,
    error: parsed.ok ? null : parsed.error,
  };
}

function inferPlannerArchetype(targetPath, hostProjectSurfaces = {}) {
  const profile = loadPlannerProfile(targetPath);
  const discovery = hostProjectSurfaces.discovery_policy || validateDiscoveryPolicySurface(targetPath);
  const archetypeProfiles = loadArchetypeProfiles();
  const candidate = profile.profile?.archetype || discovery.archetype || archetypeProfiles.default_profile;
  const normalized = String(candidate || "").trim().replace(/[-\s]+/g, "_");
  const archetype = archetypeProfiles.profiles[normalized] ? normalized : archetypeProfiles.default_profile;
  return {
    archetype,
    source: profile.profile?.archetype ? "planner.profile.json" : discovery.archetype ? "planner.discovery.json" : "default",
    profile_path: profile.path,
    profile_present: profile.present,
    profile_usable: profile.usable,
    defaults: archetypeProfiles.profiles[archetype] || {},
  };
}

function defaultRepairCommand(projectPath, category) {
  if (category === "telemetry") {
    return buildTraceHookInstallCommand(projectPath);
  }
  if (category === "story_registry") {
    return `cd "${projectPath}" && node .agent/skills/iterative-planner/scripts/story_registry.mjs check --json`;
  }
  if (category === "semantic_readiness") {
    return `cd "${projectPath}" && node .agent/skills/iterative-planner/scripts/bootstrap.mjs status`;
  }
  if (category === "annotations") {
    return `cd "${projectPath}" && node .agent/skills/iterative-planner/scripts/migrate.mjs annotate . --dry-run`;
  }
  if (category === "workflow_intelligence") {
    return `cd "${projectPath}" && node .agent/skills/iterative-planner/scripts/escalation_check.mjs --json`;
  }
  return null;
}

function pushGap(gaps, category, surface, issue) {
  if (!gaps[category]) gaps[category] = [];
  gaps[category].push({
    code: issue.code || `${surface}_gap`,
    severity: issue.severity || "info",
    surface,
    path: issue.path || null,
    message: issue.message || `${surface} needs follow-up`,
    command: issue.command || null,
  });
}

function classifyProjectGaps(projectReport) {
  const surfaces = projectReport.host_project_surfaces || {};
  const gaps = {
    telemetry: [],
    story_registry: [],
    semantic_readiness: [],
    annotations: [],
    persona_adaptation: [],
    workflow_intelligence: [],
  };

  const telemetry = surfaces.telemetry_capture;
  for (const issue of telemetry?.issues || []) pushGap(gaps, "telemetry", "telemetry_capture", issue);
  if (telemetry && (telemetry.tool_trace_enabled || telemetry.proof_telemetry_enabled) && !telemetry.hook_configured) {
    pushGap(gaps, "telemetry", "telemetry_capture", {
      code: "telemetry_enabled_but_inactive",
      severity: "info",
      path: telemetry.path,
      message: "Telemetry capture is enabled but inactive because no supported PostToolUse hook is installed.",
      command: defaultRepairCommand(projectReport.path, "telemetry"),
    });
  }

  const storyRegistry = surfaces.story_registry;
  if (storyRegistry && !storyRegistry.present) {
    pushGap(gaps, "story_registry", "story_registry", {
      code: "missing_story_registry",
      severity: "info",
      path: storyRegistry.path,
      message: "Story registry is missing.",
      command: defaultRepairCommand(projectReport.path, "story_registry"),
    });
  }
  for (const issue of storyRegistry?.issues || []) pushGap(gaps, "story_registry", "story_registry", issue);

  const annotations = surfaces.annotation_coverage;
  if (annotations && (!annotations.present || annotations.high_signal_annotation_count === 0)) {
    pushGap(gaps, "annotations", "annotation_coverage", {
      code: annotations.present ? "annotation_surface_low_signal" : "no_live_annotations",
      severity: "info",
      path: annotations.path,
      message: annotations.present ? "Annotation surface has no high-signal planner annotations." : "No live planner annotations were found.",
      command: defaultRepairCommand(projectReport.path, "annotations"),
    });
  }
  for (const issue of annotations?.issues || []) pushGap(gaps, "annotations", "annotation_coverage", issue);

  const personaAdaptation = surfaces.persona_adaptation;
  for (const issue of personaAdaptation?.issues || []) {
    pushGap(gaps, "persona_adaptation", "persona_adaptation", issue);
  }

  const workflow = surfaces.workflow_intelligence;
  if (workflow && (!workflow.present || !workflow.workflow_events_supported)) {
    pushGap(gaps, "workflow_intelligence", "workflow_intelligence", {
      code: workflow.present ? "workflow_events_not_supported" : "missing_workflow_intelligence_log",
      severity: "info",
      path: workflow.path,
      message: workflow.present ? "Workflow intelligence log does not support workflow events yet." : "Workflow intelligence audit log is missing.",
      command: defaultRepairCommand(projectReport.path, "workflow_intelligence"),
    });
  }
  for (const issue of workflow?.issues || []) pushGap(gaps, "workflow_intelligence", "workflow_intelligence", issue);

  if (projectReport.second_pass_verification?.status && !verificationStatusIsPass(projectReport.second_pass_verification.status, "execution")) {
    pushGap(gaps, "semantic_readiness", "second_pass_verification", {
      code: "semantic_readiness_not_passing",
      severity: "warning",
      path: projectReport.path,
      message: "Second-pass semantic readiness is not passing.",
      command: defaultRepairCommand(projectReport.path, "semantic_readiness"),
    });
  }

  return gaps;
}

function buildFleetDoctorReport(manifestPath = null) {
  const projects = loadFleetProjects();
  const migrationWaveRead = readMigrationWaveManifest(manifestPath || defaultMigrationWavePath());
  const priority = ["telemetry", "story_registry", "semantic_readiness", "annotations", "persona_adaptation", "workflow_intelligence"];
  const report = {
    generated_at: new Date().toISOString(),
    source: "planner fleet doctor",
    current_version: CURRENT_VERSION,
    project_count: projects.length,
    recurring_gaps: Object.fromEntries(priority.map((category) => [category, { project_count: 0, issue_count: 0 }])),
    projects: [],
  };

  for (const project of projects) {
    const projectReport = buildFleetProjectReport(project, migrationWaveRead);
    const archetype = inferPlannerArchetype(project.path, projectReport.host_project_surfaces);
    const gaps = classifyProjectGaps(projectReport);
    const gapSummary = {};
    for (const category of priority) {
      const entries = gaps[category] || [];
      gapSummary[category] = entries.length;
      if (entries.length > 0) {
        report.recurring_gaps[category].project_count += 1;
        report.recurring_gaps[category].issue_count += entries.length;
      }
    }
    const repairPriority = Array.isArray(archetype.defaults.repair_priority) && archetype.defaults.repair_priority.length > 0
      ? archetype.defaults.repair_priority
      : priority;
    const recommendedRepairs = repairPriority
      .filter((category) => (gaps[category] || []).length > 0)
      .map((category) => ({
        category,
        issue_count: gaps[category].length,
        command: gaps[category].find((issue) => issue.command)?.command || defaultRepairCommand(project.path, category),
      }));

    report.projects.push({
      name: projectReport.name,
      path: projectReport.path,
      status: projectReport.status,
      status_reason: projectReport.status_reason,
      archetype: archetype.archetype,
      archetype_source: archetype.source,
      proof_defaults: archetype.defaults.proof_defaults || [],
      gap_summary: gapSummary,
      gaps,
      recommended_repairs: recommendedRepairs,
      migration_wave_deferral: projectReport.migration_wave_deferral || null,
    });
  }

  report.projects.sort((a, b) => a.path.localeCompare(b.path));
  return report;
}

function cmdFleetDoctor(jsonOutput, manifestPath = null) {
  const report = buildFleetDoctorReport(manifestPath);
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  FLEET DOCTOR                                       ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Current planner version: ${CURRENT_VERSION}`);
  console.log(`  Projects checked: ${report.project_count}\n`);
  for (const [category, summary] of Object.entries(report.recurring_gaps)) {
    console.log(`  ${category}: ${summary.issue_count} issue(s) across ${summary.project_count} project(s)`);
  }
  console.log();
  for (const project of report.projects) {
    console.log(`  - ${project.name} [${project.status}; ${project.archetype}]`);
    for (const repair of project.recommended_repairs.slice(0, 3)) {
      console.log(`    repair: ${repair.category} (${repair.issue_count}) -> ${repair.command}`);
    }
  }
  console.log();
}

function cmdScaffoldDiscoveryPolicy(targetPath, jsonOutput, writePolicy, dryRun) {
  const report = buildDiscoveryPolicyScaffoldReport(targetPath);
  const existingSurface = validateDiscoveryPolicySurface(targetPath);
  const result = {
    ...report,
    existing_policy_usable: existingSurface.usable,
    existing_policy_archetype: existingSurface.archetype,
    recommended_policy: report.scaffold?.recommended_policy || null,
    write_status: "not_written",
  };

  if (!report.matched) {
    result.write_status = "no_match";
  } else if (report.discovery_policy_present) {
    result.write_status = "preserved_existing";
  } else if (writePolicy && dryRun) {
    result.write_status = "would_write";
  } else if (writePolicy) {
    ensureDir(dirname(report.discovery_policy_path));
    writeFileSync(report.discovery_policy_path, `${JSON.stringify(report.scaffold.recommended_policy, null, 2)}\n`);
    result.write_status = "written";
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  DISCOVERY POLICY SCAFFOLD                          ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Target: ${targetPath}`);
  console.log(`  Existing policy: ${report.discovery_policy_present ? "present" : "missing"}`);
  console.log(`  Archetype match: ${report.matched ? report.scaffold.archetype : "none"}`);

  if (report.matched) {
    console.log(`  Cohort: ${report.scaffold.cohort_id}`);
    console.log(`  Label: ${report.scaffold.label}`);
    console.log(`  Suggested command: ${report.recommended_command}`);
    console.log(`\n${JSON.stringify(report.scaffold.recommended_policy, null, 2)}\n`);
  } else {
    console.log(`  No deterministic scaffold recommendation is available for this project path.\n`);
  }

  if (result.write_status === "written") {
    console.log(`  WROTE: planner.discovery.json scaffold`);
  } else if (result.write_status === "would_write") {
    console.log(`  WOULD WRITE: planner.discovery.json scaffold`);
  } else if (result.write_status === "preserved_existing") {
    console.log(`  PRESERVED: existing planner.discovery.json was not overwritten`);
  }
  console.log();
}

function cmdPromoteKnowledge(targetPath, jsonOutput, writePromotion, dryRun, draftCandidatesPathArg = null) {
  const report = buildKnowledgePromotionReport(targetPath, { draftCandidatesPathArg });
  const mistakeResult = applyOverlayPromotion({
    overlayPath: join(targetPath, "planner.mistake_overrides.json"),
    arrayKey: "mistakes",
    candidates: report.candidates.mistake_overlay_candidates,
    write: writePromotion,
    dryRun,
    semanticValidator: (overlayPath) => {
      const registryPath = join(targetPath, ".agent", "skills", "iterative-planner", "config", "mistake_registry.json");
      const { mistakes } = readMistakeRegistryEntries({ registryPath });
      return validateMistakeOverlayDocument({
        overlayPath,
        baseIds: new Set(mistakes.map((mistake) => mistake.id)),
      });
    },
  });
  const obligationResult = applyOverlayPromotion({
    overlayPath: join(targetPath, "planner.learned_obligations.json"),
    arrayKey: "obligations",
    candidates: report.candidates.learned_obligation_overlay_candidates,
    write: writePromotion,
    dryRun,
    semanticValidator: (overlayPath) => {
      const registryPath = join(targetPath, ".agent", "skills", "iterative-planner", "config", "learned_obligations.json");
      const { obligations } = readLearnedObligationRegistryEntries({ registryPath });
      return validateLearnedObligationOverlayDocument({
        overlayPath,
        baseIds: new Set(obligations.map((obligation) => obligation.id)),
      });
    },
  });

  const result = {
    ...report,
    write_requested: writePromotion,
    overlays: {
      mistake_overrides: mistakeResult,
      learned_obligation_overrides: obligationResult,
    },
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  KNOWLEDGE PROMOTION                                ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Target: ${targetPath}`);
  console.log(`  Mistake entries discovered: ${report.source_files.mistakes.entry_count}`);
  console.log(`  Registry candidates: ${report.candidates.registry_candidates.length}`);
  console.log(`  Obligation candidates: ${report.candidates.obligation_candidates.length}`);
  console.log(`  KB-only entries: ${report.candidates.kb_only.length}`);
  console.log(`  Reviewed draft candidates: ${report.review_surface.promotable_count}`);
  console.log(`  Suggested command: ${report.recommended_command}`);
  console.log();
  console.log(`  Draft review surface: ${report.review_surface.relative_path} (${report.review_surface.present ? "present" : "missing"}, ${report.review_surface.usable ? "usable" : "invalid"})`);
  console.log(`  planner.mistake_overrides.json: ${mistakeResult.write_status} (${mistakeResult.added_count} added)`);
  console.log(`  planner.learned_obligations.json: ${obligationResult.write_status} (${obligationResult.added_count} added)`);
  if (mistakeResult.write_status === "blocked_invalid_existing" || obligationResult.write_status === "blocked_invalid_existing") {
    console.log(`  Existing overlay file is invalid; repair it before rerunning --write.`);
  }
  if (!report.review_surface.usable) {
    console.log(`  Draft review surface is invalid; repair ${report.review_surface.relative_path} before relying on reviewed draft promotion.`);
  }
  console.log();
}

function quoteCommandArg(value) {
  return JSON.stringify(String(value || ""));
}

function safeIvePhase(phase = DEFAULT_IVE_PHASE) {
  const normalized = String(phase || DEFAULT_IVE_PHASE).trim();
  return normalized.replace(/[^A-Za-z0-9_.-]/g, "_") || DEFAULT_IVE_PHASE;
}

function migrateCommand(command, targetPath, flags = []) {
  return [
    "node .agent/skills/iterative-planner/scripts/migrate.mjs",
    command,
    quoteCommandArg(targetPath),
    ...flags,
  ].filter(Boolean).join(" ");
}

function latestIveBackupSummary(targetPath, phase = DEFAULT_IVE_PHASE) {
  const backupRoot = join(targetPath, ".agent", "skills", "iterative-planner", "migration_backups");
  const phaseId = safeIvePhase(phase);
  if (!existsSync(backupRoot)) {
    return {
      available: false,
      phase: phaseId,
      latest_backup_dir: null,
      latest_manifest: null,
      reason: "No migration_backups directory found",
    };
  }
  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${phaseId}_`))
    .map((entry) => join(backupRoot, entry.name))
    .filter((path) => existsSync(join(path, "manifest.json")))
    .sort();
  const latest = candidates.at(-1) || null;
  return {
    available: !!latest,
    phase: phaseId,
    latest_backup_dir: latest ? relative(targetPath, latest) : null,
    latest_manifest: latest ? relative(targetPath, join(latest, "manifest.json")) : null,
    reason: latest ? null : `No backup manifest found for phase ${phaseId}`,
  };
}

function readIveRecoveryMarker(targetPath) {
  const markerPath = join(targetPath, ".agent", "skills", "iterative-planner", "migration_backups", ".ive_migration_in_progress.json");
  const read = readJsonSafe(markerPath);
  if (!existsSync(markerPath)) {
    return {
      present: false,
      path: relative(targetPath, markerPath),
      status: "none",
      recovery_needed: false,
      raw: null,
    };
  }
  if (!read.ok) {
    return {
      present: true,
      path: relative(targetPath, markerPath),
      status: "unreadable",
      recovery_needed: true,
      error: read.error,
      raw: null,
    };
  }
  return {
    present: true,
    path: relative(targetPath, markerPath),
    status: read.value?.status || "unknown",
    recovery_needed: read.value?.status === "in_progress",
    raw: read.value,
  };
}

function plannerInstallClassification(detection) {
  if (detection.confidence === "FAILED" || detection.version === "0.0.0") return "missing";
  if (detection.version !== CURRENT_VERSION) return "lagging";
  return "current";
}

function buildIveFrontDoorStatus(targetPath, { phase = DEFAULT_IVE_PHASE, plans = DEFAULT_VALIDATE_PLAN_COUNT } = {}) {
  const root = resolve(targetPath);
  const phaseId = safeIvePhase(phase);
  const requestedPlans = Math.max(1, Number.parseInt(plans, 10) || DEFAULT_VALIDATE_PLAN_COUNT);
  const detection = detectVersion(join(root, ".agent/skills/iterative-planner/SKILL.md"));
  const classification = plannerInstallClassification(detection);
  const doctor = buildDoctorReport(root);
  const auditPath = join(root, "audit.config.json");
  const auditRead = readJsonSafe(auditPath);
  const auditConfig = auditRead.ok && auditRead.value && typeof auditRead.value === "object"
    ? auditRead.value
    : {};
  const iveMigration = auditConfig.ive_migration && typeof auditConfig.ive_migration === "object"
    ? auditConfig.ive_migration
    : null;
  const plan = buildIveMigrationPlan(root, { phase: phaseId });
  const backup = latestIveBackupSummary(root, phaseId);
  const recovery = readIveRecoveryMarker(root);
  const retentionWarnings = findIveBackupRetentionWarnings(root);
  const commandFlags = ["--phase", phaseId];

  const commands = {
    status: migrateCommand("ive-status", root, [...commandFlags]),
    status_json: migrateCommand("ive-status", root, [...commandFlags, "--json"]),
    dry_run: migrateCommand("ive-adopt", root, [...commandFlags, "--dry-run"]),
    write_adopt: migrateCommand("ive-adopt", root, [...commandFlags, "--write"]),
    validate_migration: migrateCommand("validate-migration", root, ["--plans", String(requestedPlans)]),
    rollback: migrateCommand("rollback", root, [...commandFlags]),
    recover: migrateCommand("recover", root, [...commandFlags]),
    repair_dry_run: migrateCommand("upgrade", root, ["--dry-run"]),
    repair_write: migrateCommand("upgrade", root),
    legacy_explicit_dry_run: migrateCommand("upgrade", root, ["--to-ive", ...commandFlags, "--dry-run"]),
  };

  return {
    ok: true,
    status: "PASS",
    operation: "ive-status",
    read_only: true,
    canonical_files_touched: false,
    target_path: root,
    phase: phaseId,
    generated_at: new Date().toISOString(),
    planner_install: {
      classification,
      detected_version: detection.version,
      current_version: CURRENT_VERSION,
      confidence: detection.confidence,
      reason: detection.reason,
      needs_repair: !!doctor.needs_repair,
      repair_summary: doctor.summary?.description || null,
    },
    ive_adoption: {
      enabled: iveMigration?.enabled === true,
      kill_switch_enabled: auditConfig.ive_features_disabled === true,
      audit_config_present: existsSync(auditPath),
      audit_config_usable: auditRead.ok,
      status: iveMigration?.enabled === true
        ? "adopted"
        : auditConfig.ive_features_disabled === true
          ? "blocked_by_kill_switch"
          : "not_adopted",
      metadata: iveMigration,
    },
    safety: {
      default_mode: "read_only",
      adopt_write_requires: "--write",
      dry_run_default: true,
      mode_conflict: "--dry-run and --write are mutually exclusive for ive-adopt",
      rollback_available: backup.available,
      recovery_needed: recovery.recovery_needed,
    },
    backup,
    recovery,
    retention_warnings: retentionWarnings,
    migration_preview: {
      dry_run_report: plan.dry_run_report,
      backup_dir: plan.backup_dir,
      affected_files: plan.affected_files,
      planned_actions: plan.planned_actions,
      kill_switch: plan.kill_switch,
    },
    commands,
  };
}

function printIveFrontDoorStatus(report) {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  IVE MIGRATION FRONT DOOR                           ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Target:             ${report.target_path}`);
  console.log(`  Phase:              ${report.phase}`);
  console.log(`  Read-only:          yes`);
  console.log(`  Canonical touched:  no`);
  console.log(`  Planner install:    ${report.planner_install.classification} (${report.planner_install.detected_version} -> ${report.planner_install.current_version}, ${report.planner_install.confidence})`);
  console.log(`  IVE adoption:       ${report.ive_adoption.status}`);
  console.log(`  Kill switch:        ${report.ive_adoption.kill_switch_enabled ? "enabled" : "disabled"}`);
  console.log(`  Rollback backup:    ${report.backup.available ? report.backup.latest_manifest : "not available"}`);
  console.log(`  Recover marker:     ${report.recovery.status}${report.recovery.recovery_needed ? " (recovery needed)" : ""}`);
  if (report.retention_warnings.length > 0) {
    console.log(`  Retention warning:  ${report.retention_warnings.length} backup(s) nearing expiry`);
  }
  console.log(`\n  Next commands:`);
  console.log(`    Dry run:     ${report.commands.dry_run}`);
  console.log(`    Adopt/write: ${report.commands.write_adopt}`);
  console.log(`    Validate:    ${report.commands.validate_migration}`);
  console.log(`    Rollback:    ${report.commands.rollback}`);
  console.log(`    Recover:     ${report.commands.recover}`);
  if (report.planner_install.classification !== "current" || report.planner_install.needs_repair) {
    console.log(`    Repair dry:  ${report.commands.repair_dry_run}`);
    console.log(`    Repair:      ${report.commands.repair_write}`);
  }
  console.log(`\n  Default is read-only. Use --write only after reviewing the dry-run output.\n`);
}

function cmdIveStatus(targetPath, { phase = DEFAULT_IVE_PHASE, plans = DEFAULT_VALIDATE_PLAN_COUNT, jsonOutput = false } = {}) {
  const report = buildIveFrontDoorStatus(targetPath, { phase, plans });
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printIveFrontDoorStatus(report);
  }
}

function cmdIveAdopt(targetPath, { phase = DEFAULT_IVE_PHASE, dryRun = false, writeAdoption = false, jsonOutput = false } = {}) {
  if (dryRun && writeAdoption) {
    emitIveMigrationResult({
      ok: false,
      status: "FAIL",
      operation: "ive-adopt",
      phase: safeIvePhase(phase),
      mode: "invalid",
      reason: "--dry-run and --write are mutually exclusive for ive-adopt",
      canonical_files_touched: false,
    }, jsonOutput);
    return;
  }

  if (!dryRun && !writeAdoption) {
    const status = buildIveFrontDoorStatus(targetPath, { phase });
    emitIveMigrationResult({
      ok: true,
      status: "PASS",
      operation: "ive-adopt --dry-run",
      phase: status.phase,
      dry_run: true,
      mode: "dry-run",
      read_only: true,
      defaulted_to_dry_run: true,
      canonical_files_touched: false,
      plan: status.migration_preview,
      report: null,
      follow_up_commands: status.commands,
    }, jsonOutput);
    return;
  }

  const effectiveDryRun = !writeAdoption;
  const result = runIveUpgrade(targetPath, { phase, dryRun: effectiveDryRun, jsonOutput });
  const status = buildIveFrontDoorStatus(targetPath, { phase });
  emitIveMigrationResult({
    ...result,
    operation: writeAdoption ? "ive-adopt --write" : "ive-adopt --dry-run",
    mode: writeAdoption ? "write" : "dry-run",
    read_only: !writeAdoption,
    defaulted_to_dry_run: !dryRun && !writeAdoption,
    canonical_files_touched: writeAdoption
      ? (result.canonical_files_touched === false ? false : verificationStatusIsPass(result.status, "execution"))
      : false,
    follow_up_commands: status.commands,
  }, jsonOutput);
}

function projectHasLegacyPlannerLayout(targetPath) {
  return existsSync(join(targetPath, ".agent", "iterative-planner", "SKILL.md"));
}

function readinessEntry(kind, code, message, command = null, source = null) {
  return {
    kind,
    code,
    message,
    command,
    source,
  };
}

function buildMigrationReadinessReport(targetPath, { phase = DEFAULT_IVE_PHASE, plans = DEFAULT_VALIDATE_PLAN_COUNT } = {}) {
  const root = resolve(targetPath);
  const phaseId = safeIvePhase(phase);
  const requestedPlans = Math.max(1, Number.parseInt(plans, 10) || DEFAULT_VALIDATE_PLAN_COUNT);
  const doctor = buildDoctorReport(root);
  const semantic = buildFleetProjectReport({ name: basename(root), path: root }, null);
  const ive = buildIveFrontDoorStatus(root, { phase: phaseId, plans: requestedPlans });
  const registryStatus = fleetRegistryStatus();
  const detection = doctor.detection || {};
  const legacyLayout = projectHasLegacyPlannerLayout(root);
  const heuristicVersion = detection.confidence === "LOW";
  const backupReady = !!ive.backup?.available;
  const rollbackAvailable = !!ive.safety?.rollback_available;

  const deterministicBlockers = [];
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Locally generated fleet classification emits a deterministic readiness blocker and does not parse or satisfy authored verification status.
  if (semantic.status === "blocked") {
    deterministicBlockers.push(readinessEntry(
      "deterministic_blocker",
      "planner_install_blocked",
      "Planner install has critical missing files or unreadable migration state.",
      ive.commands.repair_write,
      "doctor"
    ));
  }
  if (semantic.status === "semantically_behind") {
    deterministicBlockers.push(readinessEntry(
      "deterministic_blocker",
      "semantic_readiness_not_passing",
      "Second-pass semantic readiness is not passing.",
      semantic.semantic_health?.recommended_commands?.[0] || migrateCommand("semantic-scan", root, ["--json"]),
      "semantic-scan"
    ));
  }
  if (ive.ive_adoption.kill_switch_enabled) {
    deterministicBlockers.push(readinessEntry(
      "deterministic_blocker",
      "kill_switch_enabled",
      "IVE adoption writes are disabled by audit.config.json.",
      null,
      "ive-status"
    ));
  }
  if (ive.recovery?.recovery_needed) {
    deterministicBlockers.push(readinessEntry(
      "deterministic_blocker",
      "recovery_needed",
      "An interrupted IVE migration marker is present.",
      ive.commands.recover,
      "ive-status"
    ));
  }

  const advisoryGaps = [];
  for (const issue of doctor.advisory_issues || []) {
    advisoryGaps.push(readinessEntry(
      "advisory_gap",
      issue.code || "doctor_advisory",
      `${issue.category || "advisory"} drift in ${issue.path}`,
      issue.repair_via || null,
      "doctor"
    ));
  }
  for (const issue of semantic.second_pass_verification?.issues || []) {
    const severity = String(issue.severity || issue.level || "").toLowerCase();
    if (severity === "error" || severity === "critical") continue;
    advisoryGaps.push(readinessEntry(
      "advisory_gap",
      issue.code || issue.id || "semantic_advisory",
      issue.message || issue.summary || "Second-pass semantic advisory.",
      issue.command || null,
      "semantic-scan"
    ));
  }
  if (registryStatus.stale_paths_ignored > 0) {
    advisoryGaps.push(readinessEntry(
      "advisory_gap",
      "stale_registry_paths",
      `${registryStatus.stale_paths_ignored} stale fleet registry path(s) ignored for single-project readiness.`,
      "node .agent/skills/iterative-planner/scripts/migrate.mjs scan",
      "fleet_registry"
    ));
  }

  const dryRunClean = !ive.ive_adoption.kill_switch_enabled && !ive.recovery?.recovery_needed;
  const labels = new Set([semantic.status || "blocked"]);
  if (ive.planner_install.classification === "current") labels.add("current");
  if (ive.planner_install.classification === "lagging") labels.add("supported_lagging");
  if (ive.planner_install.classification === "missing") labels.add("blocked");
  if (dryRunClean) labels.add("dry_run_clean");
  if (ive.ive_adoption.kill_switch_enabled) labels.add("kill_switch_enabled");
  if (backupReady) labels.add("backup_ready");
  if (rollbackAvailable) labels.add("rollback_available");
  if (heuristicVersion) labels.add("heuristic_version");
  if (legacyLayout) labels.add("legacy_layout");

  const remainingActions = [];
  if (deterministicBlockers.length === 0) {
    remainingActions.push({
      label: "Review IVE adoption dry run",
      command: ive.commands.dry_run,
    });
  }
  if (doctor.needs_repair) {
    remainingActions.push({
      label: "Repair planner install",
      command: ive.commands.repair_write,
    });
  }
  if (semantic.second_pass_required) {
    remainingActions.push({
      label: "Inspect semantic readiness",
      command: migrateCommand("semantic-scan", root, ["--json"]),
    });
  }
  if (!backupReady) {
    remainingActions.push({
      label: "Create rollback backup before write adoption",
      command: ive.commands.write_adopt,
    });
  }
  if (registryStatus.stale_paths_ignored > 0) {
    remainingActions.push({
      label: "Refresh fleet registry cache for batch work",
      command: "node .agent/skills/iterative-planner/scripts/migrate.mjs scan",
    });
  }

  const oldPlannerHandlingMode = legacyLayout
    ? "legacy_layout_review"
    : heuristicVersion
      ? "heuristic_version_review"
      : ive.planner_install.classification === "lagging" || semantic.status === "supported_lagging"
        ? "supported_lagging_upgrade"
        : "not_required";

  return {
    ok: true,
    status: deterministicBlockers.length === 0 ? "PASS" : "ACTION_REQUIRED",
    operation: "migration-readiness",
    read_only: true,
    canonical_files_touched: false,
    target_path: root,
    generated_at: new Date().toISOString(),
    phase: phaseId,
    labels: [...labels],
    overall_status: deterministicBlockers.length > 0 ? "action_required" : (semantic.status || "current"),
    planner_install: {
      classification: ive.planner_install.classification,
      detected_version: doctor.detected_version,
      current_version: doctor.current_version,
      confidence: detection.confidence,
      reason: detection.reason,
      needs_repair: !!doctor.needs_repair,
      doctor_status: semantic.status,
      old_planner_handling_mode: oldPlannerHandlingMode,
    },
    semantic_readiness: {
      status: semantic.status,
      status_reason: semantic.status_reason,
      semantic_health: semantic.semantic_health,
      second_pass_required: !!semantic.second_pass_required,
      second_pass_verified: !!semantic.second_pass_verified,
    },
    ive_adoption: {
      status: ive.ive_adoption.status,
      enabled: ive.ive_adoption.enabled,
      kill_switch_enabled: ive.ive_adoption.kill_switch_enabled,
      dry_run_clean: dryRunClean,
    },
    safety: {
      backup_ready: backupReady,
      rollback_available: rollbackAvailable,
      recovery_needed: ive.safety.recovery_needed,
      backup: ive.backup,
      recovery: ive.recovery,
    },
    legacy_handling: {
      heuristic_version: heuristicVersion,
      legacy_layout: legacyLayout,
      mode: oldPlannerHandlingMode,
    },
    deterministic_blockers: deterministicBlockers,
    advisory_gaps: advisoryGaps,
    remaining_actions: remainingActions,
    fleet_registry: {
      ...registryStatus,
      single_project_blocker: false,
    },
    commands: {
      doctor: migrateCommand("doctor", root, ["--json"]),
      semantic_scan: migrateCommand("semantic-scan", root, ["--json"]),
      ive_status: ive.commands.status_json,
      dry_run: ive.commands.dry_run,
      write_adopt: ive.commands.write_adopt,
      validate_migration: ive.commands.validate_migration,
      repair: ive.commands.repair_write,
    },
  };
}

function printMigrationReadinessReport(report) {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  MIGRATION READINESS SUMMARY                        ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
  console.log(`  Target:          ${report.target_path}`);
  console.log(`  Overall:         ${report.overall_status}`);
  console.log(`  Labels:          ${report.labels.join(", ") || "none"}`);
  console.log(`  Planner install: ${report.planner_install.doctor_status} (${report.planner_install.detected_version} -> ${report.planner_install.current_version}, ${report.planner_install.confidence})`);
  console.log(`  IVE adoption:    ${report.ive_adoption.status}`);
  console.log(`  Kill switch:     ${report.ive_adoption.kill_switch_enabled ? "enabled" : "disabled"}`);
  console.log(`  Backup ready:    ${report.safety.backup_ready ? "yes" : "no"}`);
  console.log(`  Rollback:        ${report.safety.rollback_available ? "available" : "not available"}`);
  console.log(`  Registry scope:  fleet advisory only; single-project readiness uses explicit target path`);

  console.log(`\n  Deterministic blockers:`);
  if (report.deterministic_blockers.length === 0) {
    console.log(`    - none`);
  } else {
    for (const item of report.deterministic_blockers) {
      console.log(`    - ${item.code}: ${item.message}`);
      if (item.command) console.log(`      command: ${item.command}`);
    }
  }

  console.log(`\n  Advisory gaps:`);
  if (report.advisory_gaps.length === 0) {
    console.log(`    - none`);
  } else {
    for (const item of report.advisory_gaps.slice(0, 20)) {
      console.log(`    - ${item.code}: ${item.message}`);
      if (item.command) console.log(`      command: ${item.command}`);
    }
    if (report.advisory_gaps.length > 20) console.log(`    - ... and ${report.advisory_gaps.length - 20} more`);
  }

  console.log(`\n  Remaining operator actions:`);
  if (report.remaining_actions.length === 0) {
    console.log(`    - none`);
  } else {
    for (const action of report.remaining_actions) {
      console.log(`    - ${action.label}: ${action.command}`);
    }
  }
  console.log();
}

function cmdMigrationReadiness(targetPath, { phase = DEFAULT_IVE_PHASE, plans = DEFAULT_VALIDATE_PLAN_COUNT, jsonOutput = false } = {}) {
  const report = buildMigrationReadinessReport(targetPath, { phase, plans });
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printMigrationReadinessReport(report);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: node migrate.mjs <command> <target-project-path> [options]

Commands:
  detect <path>              Detect version + integrity check (missing files)
  doctor <path>              Machine-readable repair diagnosis for self-heal entrypoints
  migration-readiness <path> Concise read-only readiness summary (JSON or human)
  ive-status <path>          Read-only IVE migration status and exact next commands
  ive-adopt <path> [--dry-run|--write]
                             Operator-facing IVE adoption wrapper; defaults to dry-run
  upgrade <path>             Read-only upgrade preflight (all components)
  upgrade <path> --commit    Prove and commit in scratch, then fast-forward target
  upgrade <path> --seed-kb   Also seed knowledge base
  upgrade <path> --to-ive [--phase <N>] [--dry-run]
                             Explicitly opt a project into IVE migration bootstrap/adoption
  rollback <path> --phase <N> [--keep-deltas]
                             Roll back one IVE adoption phase from the latest backup
  validate-migration <path> [--plans <N>]
                             Replay recent historical plans and write migration parity proof
  recover <path> [--phase <N>]
                             Resolve an interrupted IVE migration marker
  recover-upgrade <path>     Resolve an interrupted managed planner upgrade journal
  setup <path>               Project-level setup (audit config, hooks, version sync)
  setup <path> --profile kernel
                             Minimal kernel setup (AGENTS.md + journal seed only)
  kernel-status <path>       Read-only kernel journal/profile status
  sync-instructions <path>   Refresh planner-managed root instruction snapshots
  annotate <path>            Bootstrap @planner: annotations (scan, apply, review)
  verify <path>              Post-upgrade integrity verification
  scaffold-discovery-policy <path>  Suggest or write a starter planner.discovery.json for matched archetypes
  promote-knowledge <path>   Preview or write draft KB promotion overlays for host-owned learnings
  semantic-scan <path>       Read-only semantic health scan for one project
  regenerate-checklist-integrity <path> --checklist <name> --decision-ref <plans/plan_*/decisions.md#D-*>
                             Re-authorize one clean tracked HEAD checklist; defaults to dry-run

  scan [path...]             Discover all planner projects under given paths
  verify-fleet               Classify discovered projects by migration/support status (fleet registry cache only)
  fleet-doctor               Group recurring fleet readiness gaps by project archetype
  migration-wave create      Write reports/migration_wave.json include/exclude contract
  migration-wave verify      Verify migration_wave.json version boundaries
  upgrade-all                Upgrade ALL discovered projects (uses fleet registry from last scan)
  annotate-all               Annotate ALL discovered projects (uses fleet registry from last scan)

Registry boundary:
  The project registry is a cached fleet/batch surface for scan, upgrade-all,
  annotate-all, verify-fleet, fleet-doctor, and migration-wave workflows.
  Single-project migration commands use explicit target paths and do not need
  source-repo registration.

Options:
  --dry-run                  Preview changes without writing files
  --commit                   Consent to the transactional managed-upgrade commit
  --source-ref <git-ref>     Read planner payload from this exact source commit/tag (default: PLANNER_SOURCE_REF or HEAD)
  --json                     Emit JSON for commands that support it (doctor, migration-readiness, ive-status, ive-adopt, sync-instructions, verify-fleet, fleet-doctor, migration-wave, scaffold-discovery-policy, promote-knowledge, semantic-scan, regenerate-checklist-integrity)
  --to-ive                   Select the explicit IVE adoption path for upgrade
  --phase <N>                IVE migration phase selector (default: ${DEFAULT_IVE_PHASE})
  --plans <N>                validate-migration historical plan count (default: ${DEFAULT_VALIDATE_PLAN_COUNT})
  --recover                  Alias for recover . when run from a target project root
  --keep-deltas              Retain rollback delta/audit artifacts when supported
  --profile <full|kernel>    Setup profile selector (default: full)
  --tier <full|kernel>       Alias for --profile
  --write                    Write scaffold/adoption output for commands that support it
  --checklist <name>         Existing checklist registry entry to regenerate
  --decision-ref <ref>       Recorded plans/plan_*/decisions.md#D-* authorization
  --draft-candidates <path>  Reviewed draft-candidate surface relative to the target project (default: ${DEFAULT_DRAFT_CANDIDATES_REVIEW_RELATIVE_PATH})
  --manifest <path>          Migration wave manifest path (default: reports/migration_wave.json)
  --exclude <selector>       Exclude project selector for migration-wave create (repeatable)
  --expected-version <ver>   Expected included-project version for migration-wave create
  --deferred-version <ver>   Expected deferred-project version for migration-wave create
  --reason <text>            Deferral reason for migration-wave create

Components migrated:
  Scripts, libraries, Prolog rules, config, checklists, domain checklists,
  references, analyzers, tests, domain packs, workflows, agent config,
  other skills (red-team-remediation, etc.)

Design: Updates stale files (hash comparison), adds missing files.
Current version: ${CURRENT_VERSION}`);
}

function cmdUpgradeApprovalEnvelope(projectRoot, { dryRun, jsonOutput, rollback }) {
  const summary = {
    ok: true,
    action: rollback ? "rollback" : "upgrade",
    dry_run: !!dryRun,
    project_root: projectRoot,
    status: "retired",
    reason: "approval envelope migration was retired by E8-1; legacy approval_envelope artifacts are ignored by runtime gates",
  };

  if (jsonOutput) { console.log(JSON.stringify(summary, null, 2)); return; }

  console.log(`upgrade-approval-envelope ${dryRun ? "(dry-run) " : ""}`);
  console.log(`  status: retired`);
  console.log(`  reason: ${summary.reason}`);
}

function emitIveMigrationResult(result, jsonOutput) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const statusLabel = canonicalVerificationStatus(result.status, "execution", {
      fallback: result.ok === false ? "FAIL" : "UNKNOWN",
    });
    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║  IVE MIGRATION ${statusLabel.padEnd(36)}║`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
    console.log(`  Operation: ${result.operation || "unknown"}`);
    if (result.phase) console.log(`  Phase:     ${result.phase}`);
    if (result.mode) console.log(`  Mode:      ${result.mode}${result.defaulted_to_dry_run ? " (default)" : ""}`);
    if (result.canonical_files_touched !== undefined) {
      console.log(`  Canonical touched: ${result.canonical_files_touched ? "yes" : "no"}`);
    }
    if (result.read_only !== undefined) console.log(`  Read-only: ${result.read_only ? "yes" : "no"}`);
    if (result.reason) console.log(`  Reason:    ${result.reason}`);
    if (result.backup_manifest) console.log(`  Backup:    ${result.backup_manifest}`);
    if (result.backup_dir) console.log(`  Backup dir:${result.backup_dir}`);
    if (result.report?.json_path) console.log(`  Report:    ${result.report.json_path}`);
    if (result.report?.md_path) console.log(`  Plan:      ${result.report.md_path}`);
    if (result.config_integrity?.status) {
      console.log(`  Config integrity: ${result.config_integrity.status}${result.config_integrity.path ? ` (${result.config_integrity.path})` : ""}`);
    }
    if (result.restored_files?.length) console.log(`  Restored:  ${result.restored_files.length} file(s)`);
    if (result.plans_replayed !== undefined) {
      console.log(`  Plans replayed: ${result.plans_replayed}/${result.plans_requested}`);
      console.log(`  Drift count:    ${result.drift_count}`);
    }
    if (result.follow_up_commands) {
      console.log(`\n  Follow-up commands:`);
      console.log(`    Status:      ${result.follow_up_commands.status}`);
      console.log(`    Adopt/write: ${result.follow_up_commands.write_adopt}`);
      console.log(`    Validate:    ${result.follow_up_commands.validate_migration}`);
      console.log(`    Rollback:    ${result.follow_up_commands.rollback}`);
      console.log(`    Recover:     ${result.follow_up_commands.recover}`);
    }
    console.log();
  }
  if (!result.ok) process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const commitRequested = args.includes("--commit");
const transactionApply = args.includes("--transaction-apply");
const seedKB = args.includes("--seed-kb");
const jsonOutput = args.includes("--json");
const writePolicy = args.includes("--write");
const toIve = args.includes("--to-ive");
const recoverRequested = args.includes("--recover");
const keepDeltas = args.includes("--keep-deltas");
let draftCandidatesPathArg = null;
let waveManifestPathArg = null;
let waveExpectedVersion = null;
let waveDeferredVersion = null;
let waveReason = null;
let ivePhaseArg = DEFAULT_IVE_PHASE;
let validatePlansArg = DEFAULT_VALIDATE_PLAN_COUNT;
let setupProfileArg = null;
let sourceRefArg = process.env.PLANNER_SOURCE_REF?.trim() || null;
let invalidSourceRefOption = false;
let checklistNameArg = null;
let decisionRefArg = null;
const waveExclusions = [];
const filteredArgs = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--source-ref") {
    const candidate = args[index + 1];
    if (!candidate || candidate.startsWith("--")) {
      invalidSourceRefOption = true;
    } else {
      sourceRefArg = candidate;
      index++;
    }
    continue;
  }
  if (arg.startsWith("--source-ref=")) {
    sourceRefArg = arg.slice("--source-ref=".length) || null;
    if (!sourceRefArg) invalidSourceRefOption = true;
    continue;
  }
  if (arg === "--checklist") {
    checklistNameArg = args[index + 1] || null;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg.startsWith("--checklist=")) {
    checklistNameArg = arg.slice("--checklist=".length) || null;
    continue;
  }
  if (arg === "--decision-ref") {
    decisionRefArg = args[index + 1] || null;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg.startsWith("--decision-ref=")) {
    decisionRefArg = arg.slice("--decision-ref=".length) || null;
    continue;
  }
  if (arg === "--profile" || arg === "--tier") {
    setupProfileArg = args[index + 1] || null;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg.startsWith("--profile=")) {
    setupProfileArg = arg.slice("--profile=".length) || null;
    continue;
  }
  if (arg.startsWith("--tier=")) {
    setupProfileArg = arg.slice("--tier=".length) || null;
    continue;
  }
  if (arg === "--phase") {
    ivePhaseArg = args[index + 1] || DEFAULT_IVE_PHASE;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg === "--plans") {
    validatePlansArg = args[index + 1] || DEFAULT_VALIDATE_PLAN_COUNT;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg === "--draft-candidates") {
    draftCandidatesPathArg = args[index + 1] || null;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg === "--manifest") {
    waveManifestPathArg = args[index + 1] ? resolve(args[index + 1]) : null;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg === "--exclude") {
    if (args[index + 1]) {
      waveExclusions.push(args[index + 1]);
      index++;
    }
    continue;
  }
  if (arg === "--expected-version") {
    waveExpectedVersion = args[index + 1] || null;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg === "--deferred-version") {
    waveDeferredVersion = args[index + 1] || null;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg === "--reason") {
    waveReason = args[index + 1] || null;
    if (args[index + 1]) index++;
    continue;
  }
  if (arg.startsWith("--")) continue;
  filteredArgs.push(arg);
}

if (invalidSourceRefOption) {
  console.error("ERROR: --source-ref requires a non-empty git commit, tag, or ref; no managed files were written.");
  process.exit(1);
}

if (recoverRequested && filteredArgs[0] !== "recover") {
  if (filteredArgs.length === 0) {
    filteredArgs.push("recover", ".");
  } else {
    filteredArgs.unshift("recover");
  }
}

if (filteredArgs.length === 0 || args.includes("--help") || args.includes("help")) {
  printUsage();
  process.exit(0);
}

const command = filteredArgs[0];
const targetPath = filteredArgs[1] ? resolve(filteredArgs[1]) : null;

// scan, fleet commands, migration-wave, upgrade-all, and annotate-all don't require a target path
if (!["scan", "verify-fleet", "fleet-doctor", "migration-wave", "upgrade-all", "annotate-all"].includes(command)) {
  if (!targetPath) {
    console.error("ERROR: Target project path required.");
    process.exit(1);
  }
  if (!existsSync(targetPath)) {
    console.error(`ERROR: Target path not found: ${targetPath}`);
    process.exit(1);
  }
}

runFromPinnedSourceSnapshot(args, sourceRefArg, command, targetPath);

// ---------------------------------------------------------------------------
// Self-update: for mutating commands we refresh the target copy first so a stale
// downstream migrate.mjs can still repair itself. Read-only commands must not
// force writes into host projects just to inspect them.
// ---------------------------------------------------------------------------
const selfSource = __filename;
const selfTarget = targetPath ? join(targetPath, ".agent/skills/iterative-planner/scripts/migrate.mjs") : null;
const selfUpdatingCommands = new Set(["setup", "sync-instructions", "annotate", "promote-knowledge"]);
if (selfUpdatingCommands.has(command) && selfTarget && resolve(selfSource) !== resolve(selfTarget) && existsSync(selfTarget)) {
  const srcHash = fileHash(selfSource);
  const destHash = fileHash(selfTarget);
  if (srcHash && destHash && srcHash !== destHash) {
    if (!dryRun) {
      ensureDir(dirname(selfTarget));
      copyFileSync(selfSource, selfTarget);
      console.log(`  SELF-UPDATE: migrate.mjs refreshed on target before continuing with the source-driven ${command}.\n`);
    } else {
      console.log(`  SELF-UPDATE (dry run): migrate.mjs would be updated from source.\n`);
    }
  }
}

if (command === "upgrade-approval-envelope") {
  const rollback = args.includes("--rollback");
  cmdUpgradeApprovalEnvelope(targetPath, { dryRun, jsonOutput, rollback });
} else if (command === "detect") {
  cmdDetect(targetPath);
} else if (command === "doctor") {
  cmdDoctor(targetPath, jsonOutput);
} else if (command === "migration-readiness") {
  cmdMigrationReadiness(targetPath, { phase: ivePhaseArg, plans: validatePlansArg, jsonOutput });
} else if (command === "ive-status") {
  cmdIveStatus(targetPath, { phase: ivePhaseArg, plans: validatePlansArg, jsonOutput });
} else if (command === "ive-adopt") {
  cmdIveAdopt(targetPath, { phase: ivePhaseArg, dryRun, writeAdoption: writePolicy, jsonOutput });
} else if (command === "upgrade") {
  if (toIve) {
    const result = runIveUpgrade(targetPath, { phase: ivePhaseArg, dryRun, jsonOutput });
    emitIveMigrationResult(result, jsonOutput);
  } else {
    if (transactionApply) {
      if (process.env._PLANNER_MANAGED_UPGRADE_INTERNAL !== "1") {
        console.error("ERROR: --transaction-apply is internal-only; no managed files were written.");
        process.exit(2);
      }
      const upgradeResult = cmdUpgrade(targetPath, seedKB, false);
      if (upgradeResult?.setupNeeded) cmdSetup(targetPath, false);
    } else {
      const preview = cmdUpgrade(targetPath, seedKB, true);
      if (!preview?.blocked && !preview?.noOp && !dryRun) {
        if (!commitRequested) {
          const consent = managedUpgradeConsentCommand(
            targetPath,
            selectedSourceCommit() || selectedSourceRef(),
            seedKB,
            __filename,
          );
          console.log(`\n  ⏸️  COMMIT CONSENT REQUIRED — target remains unchanged.`);
          console.log(`  Run: ${consent}\n`);
          process.exitCode = 2;
        } else if (resolve(targetPath) === canonicalSourceProjectPath()) {
          console.error("ERROR: transactional upgrade targets consuming repositories, not the canonical source repository.");
          process.exitCode = 2;
        } else {
          try {
            runManagedUpgradeTransaction({
              targetPath,
              sourceScript: __filename,
              sourceRef: selectedSourceRef(),
              sourceCommit: selectedSourceCommit(),
              fromVersion: readCommittedPlannerVersion(targetPath),
              toVersion: CURRENT_VERSION,
              seedKB,
            });
          } catch (error) {
            console.error(
              error.liveTargetAdvanced
                ? "\n  ❌ TRANSACTION FINALIZATION INCOMPLETE — proven candidate is at live HEAD."
                : "\n  ❌ TRANSACTIONAL UPGRADE FAILED — live target was not advanced.",
            );
            console.error(`  ${error.message}`);
            if (error.recovery) console.error(`  Recovery: ${error.recovery}`);
            process.exitCode = 1;
          }
        }
      }
    }
  }
} else if (command === "rollback") {
  const result = runIveRollback(targetPath, { phase: ivePhaseArg, keepDeltas });
  emitIveMigrationResult(result, jsonOutput);
} else if (command === "validate-migration") {
  const result = runIveValidateMigration(targetPath, { plans: validatePlansArg });
  emitIveMigrationResult(result, jsonOutput);
} else if (command === "recover") {
  const result = runIveRecover(targetPath, { phase: ivePhaseArg });
  emitIveMigrationResult(result, jsonOutput);
} else if (command === "recover-upgrade") {
  try {
    const result = recoverManagedUpgrade(targetPath, {
      sourceCommit: selectedSourceCommit(),
    });
    if (jsonOutput) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Managed upgrade recovery: ${result.status}`);
      console.log(`  Target: ${result.target_path}`);
      if (result.target_head) console.log(`  HEAD:   ${result.target_head}`);
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
} else if (command === "setup") {
  cmdSetup(targetPath, dryRun, { profile: setupProfileArg || "full" });
} else if (command === "kernel-status") {
  cmdKernelStatus(targetPath, jsonOutput);
} else if (command === "sync-instructions") {
  cmdSyncInstructions(targetPath, dryRun, jsonOutput);
} else if (command === "annotate") {
  cmdAnnotate(targetPath, dryRun);
} else if (command === "verify") {
  cmdVerify(targetPath);
} else if (command === "scaffold-discovery-policy") {
  cmdScaffoldDiscoveryPolicy(targetPath, jsonOutput, writePolicy, dryRun);
} else if (command === "promote-knowledge") {
  cmdPromoteKnowledge(targetPath, jsonOutput, writePolicy, dryRun, draftCandidatesPathArg);
} else if (command === "semantic-scan") {
  cmdSemanticScan(targetPath, jsonOutput);
} else if (command === "regenerate-checklist-integrity") {
  cmdRegenerateChecklistIntegrity(targetPath, {
    checklistName: checklistNameArg,
    decisionRef: decisionRefArg,
    dryRun,
    write: writePolicy,
    jsonOutput,
  });
} else if (command === "scan") {
  let scanRoots = filteredArgs.slice(1).map(p => resolve(p));
  if (scanRoots.length === 0) {
    const home = homedir();
    scanRoots = [
      join(home, "Dropbox (Personal)", "Freelance"),
      join(home, "Documents"),
      join(home, "Projects"),
      join(home, "Desktop"),
    ].filter(existsSync);
  }
  cmdScan(scanRoots, false);
} else if (command === "verify-fleet") {
  cmdVerifyFleet(jsonOutput, waveManifestPathArg);
} else if (command === "fleet-doctor") {
  cmdFleetDoctor(jsonOutput, waveManifestPathArg);
} else if (command === "migration-wave") {
  const action = filteredArgs[1];
  if (action === "create") {
    cmdMigrationWaveCreate(
      jsonOutput,
      waveManifestPathArg || defaultMigrationWavePath(),
      waveExclusions,
      waveExpectedVersion,
      waveDeferredVersion,
      waveReason
    );
  } else if (action === "verify") {
    cmdMigrationWaveVerify(jsonOutput, waveManifestPathArg || defaultMigrationWavePath());
  } else {
    console.error("ERROR: migration-wave requires create or verify.");
    process.exit(1);
  }
} else if (command === "upgrade-all") {
  cmdUpgradeAll(dryRun, commitRequested);
} else if (command === "annotate-all") {
  cmdAnnotateAll(dryRun);
} else {
  console.error(`ERROR: Unknown command "${command}". Use --help.`);
  process.exit(1);
}
