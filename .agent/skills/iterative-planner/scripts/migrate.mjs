#!/usr/bin/env node
// migrate.mjs — Non-destructive planner upgrade for existing projects.
//
// Usage:
//   node migrate.mjs detect <target-project-path>    Detect current planner version + integrity
//   node migrate.mjs upgrade <target-project-path>    Apply upgrades
//   node migrate.mjs upgrade <target-project-path> --seed-kb   Also seed knowledge base
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
import { join, dirname, basename, resolve, relative, extname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { parseAnnotations, validate as validateAnnotationSet } from "./annotation_parser.mjs";
import {
  readMistakeRegistryEntries,
  validateMistakeOverlayDocument,
} from "./lib/mistake_registry.mjs";
import {
  readLearnedObligationRegistryEntries,
  validateLearnedObligationOverlayDocument,
} from "./lib/learned_obligations.mjs";
import { loadRetroRegistry } from "./lib/retro_registry.mjs";
import { summarizeWorkflowIntelligence } from "./lib/workflow_intelligence.mjs";
import {
  inferPersonaAdaptation,
  isProblematicPersonaStatus,
  registryPathFromEnv,
} from "./lib/persona_adaptation.mjs";
import { attachSemanticHealth } from "./lib/semantic_maintenance.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillDir = resolve(scriptDir, "..");
const agentDir = resolve(skillDir, "../..");

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
const ROOT_INSTRUCTION_CANONICAL_COMMENT = "Canonical source: CLAUDE.md. Synced to GEMINI.md and AGENTS.md via .agent/scripts/sync-instructions.sh";
const ROOT_INSTRUCTION_SNAPSHOT_START = "<!-- BEGIN ITERATIVE-PLANNER MANAGED SNAPSHOT -->";
const ROOT_INSTRUCTION_SNAPSHOT_END = "<!-- END ITERATIVE-PLANNER MANAGED SNAPSHOT -->";
const ROOT_INSTRUCTION_SECTION_HEADINGS = [
  "## Domain Persona Autorun",
  "## Transition Gate Quick Reference",
  "## Available Workflows",
  "## Key References",
];
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
    join(targetBase, "references", "CLAUDE.template.md"),
    join(agentDir, "..", "CLAUDE.md"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function extractMarkdownSection(content, heading) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const start = text.indexOf(heading);
  if (start === -1) return null;

  const nextHeadingRegex = /^##\s+/gm;
  nextHeadingRegex.lastIndex = start + heading.length;
  let end = text.length;
  let match;
  while ((match = nextHeadingRegex.exec(text))) {
    if (match.index > start) {
      end = match.index;
      break;
    }
  }
  return text.slice(start, end).trim();
}

function collectCanonicalRootInstructionSections(templateContent) {
  return ROOT_INSTRUCTION_SECTION_HEADINGS
    .map((heading) => extractMarkdownSection(templateContent, heading))
    .filter(Boolean);
}

function rootInstructionsLookPlannerManaged(content) {
  const text = String(content || "");
  return text.includes(ROOT_INSTRUCTION_CANONICAL_COMMENT) || text.includes("# Project Instructions — Iterative Planner");
}

function rootInstructionSnapshotPresent(content) {
  const text = String(content || "");
  return text.includes(ROOT_INSTRUCTION_SNAPSHOT_START) && text.includes(ROOT_INSTRUCTION_SNAPSHOT_END);
}

function rootInstructionsHaveCurrentFrontDoors(content, canonicalSections) {
  if (!String(content || "").trim()) return false;
  return canonicalSections.every((section) => String(content || "").includes(section));
}

function buildManagedRootInstructionSnapshot(canonicalSections) {
  return [
    ROOT_INSTRUCTION_SNAPSHOT_START,
    "## Planner Runtime Snapshot (Managed)",
    "",
    "This planner-managed snapshot is refreshed by `migrate.mjs setup` and `migrate.mjs upgrade`.",
    "If older planner instructions elsewhere in this file disagree, follow this snapshot.",
    "",
    ...canonicalSections.flatMap((section, index) => index === 0 ? [section] : ["", section]),
    ROOT_INSTRUCTION_SNAPSHOT_END,
  ].join("\n");
}

function applyManagedRootInstructionSnapshot(content, canonicalSections) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const snapshot = buildManagedRootInstructionSnapshot(canonicalSections);
  const start = text.indexOf(ROOT_INSTRUCTION_SNAPSHOT_START);
  const end = text.indexOf(ROOT_INSTRUCTION_SNAPSHOT_END);

  if (start !== -1 && end !== -1 && end > start) {
    const before = text.slice(0, start).replace(/\s*$/, "");
    const after = text.slice(end + ROOT_INSTRUCTION_SNAPSHOT_END.length).replace(/^\s*/, "");
    return `${before}\n\n${snapshot}\n\n${after}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  const prefixMatch = text.match(/^((?:#.*\n)?(?:<!--[\s\S]*?-->\n)?\n*)/);
  const prefix = prefixMatch?.[1] || "";
  const remainder = text.slice(prefix.length).replace(/^\s*/, "");
  return `${prefix}${snapshot}\n\n${remainder}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
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
      name.endsWith(".json") || name.endsWith(".schema.json") || name === ".checklist_integrity"
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

  // Tests (golden tests + fixtures)
  const sourceTestsDir = join(skillDir, "tests");
  if (existsSync(sourceTestsDir)) {
    for (const f of walkDir(sourceTestsDir, (name) => name.endsWith(".mjs") || name.endsWith(".json") || name.endsWith(".md"))) {
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
        `Run \`node .agent/skills/iterative-planner/tests/test_planner_doc_contracts.mjs\` in the planner source repo, repair the template, and rerun \`node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade "${targetPath}"\`.`
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
      const srcH = normalizedComparisonHash(sourcePath, { sourceProjectPath: resolve(join(agentDir, "..")) });
      const destH = normalizedComparisonHash(e.path);
      if (srcH && destH && srcH !== destH) stale.push(e);
    }
  }
  return stale;
}

function findRootInstructionSyncIssues(targetPath) {
  const claudePath = join(targetPath, "CLAUDE.md");
  if (!existsSync(claudePath)) return [];

  const advisories = [];
  const targetBase = join(targetPath, ".agent", "skills", "iterative-planner");
  const templatePath = findRootInstructionTemplatePath(targetBase);
  const templateContent = templatePath ? readFile(templatePath) : null;
  const canonicalSections = collectCanonicalRootInstructionSections(templateContent);
  const claudeContent = readFile(claudePath);
  if (
    canonicalSections.length === ROOT_INSTRUCTION_SECTION_HEADINGS.length &&
    rootInstructionsLookPlannerManaged(claudeContent) &&
    !rootInstructionsHaveCurrentFrontDoors(claudeContent, canonicalSections)
  ) {
    advisories.push({
      path: claudePath,
      category: "root-instructions",
      critical: false,
      code: "stale_root_instruction_front_doors",
      repair_via: "setup",
    });
  }

  const claudeHash = fileHash(claudePath);
  if (!claudeHash) return advisories;

  for (const name of ["GEMINI.md", "AGENTS.md"]) {
    const otherPath = join(targetPath, name);
    if (!existsSync(otherPath)) continue;
    const otherHash = fileHash(otherPath);
    if (otherHash && otherHash !== claudeHash) {
      advisories.push({
        path: otherPath,
        category: "root-instructions",
        critical: false,
        code: "root_instruction_sync_drift",
        repair_via: "sync-instructions.sh",
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

function buildDoctorReport(targetPath) {
  const targetSkillMd = join(targetPath, ".agent/skills/iterative-planner/SKILL.md");
  const detection = detectVersion(targetSkillMd);
  const manifest = buildExpectedManifest(targetPath);
  const missing = manifest.filter((entry) => !existsSync(entry.path));
  const stale = findVerificationDrift(manifest, targetPath);
  const setupIssues = collectRepairableSetupIssues(targetPath);
  const advisoryIssues = findRootInstructionSyncIssues(targetPath);
  const versionMismatch = detection.version !== CURRENT_VERSION;
  const criticalMissing = missing.filter((entry) => entry.critical);

  const repairReasons = [];
  if (versionMismatch) repairReasons.push(`version ${detection.version} -> ${CURRENT_VERSION}`);
  if (missing.length > 0) repairReasons.push(`${missing.length} missing file(s)`);
  if (stale.length > 0) repairReasons.push(`${stale.length} stale file(s)`);
  if (setupIssues.length > 0) repairReasons.push(`${setupIssues.length} repairable setup issue(s)`);

  const advisoryReasons = [];
  if (advisoryIssues.length > 0) advisoryReasons.push(`${advisoryIssues.length} advisory sync issue(s)`);

  const description = repairReasons.length > 0
    ? [...repairReasons, ...advisoryReasons].join(", ")
    : advisoryReasons.length > 0
      ? `planner install is current; ${advisoryReasons.join(", ")}`
      : "planner install is current";

  return {
    source_project_path: resolve(join(agentDir, "..")),
    target_path: targetPath,
    detected_version: detection.version,
    current_version: CURRENT_VERSION,
    detection,
    needs_repair: versionMismatch || missing.length > 0 || stale.length > 0 || setupIssues.length > 0,
    repair_command: `node .agent/skills/iterative-planner/scripts/migrate.mjs upgrade ${JSON.stringify(targetPath)}`,
    summary: {
      description,
      version_mismatch: versionMismatch,
      missing_count: missing.length,
      critical_missing_count: criticalMissing.length,
      stale_count: stale.length,
      setup_issue_count: setupIssues.length,
      advisory_count: advisoryIssues.length,
    },
    missing_files: missing.map((entry) => formatDoctorManifestEntry(targetPath, entry)),
    stale_files: stale.map((entry) => formatDoctorManifestEntry(targetPath, entry)),
    setup_issues: setupIssues,
    advisory_issues: advisoryIssues.map((entry) => formatDoctorAdvisoryEntry(targetPath, entry)),
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
    const srcHash = normalizedComparisonHash(src, { sourceProjectPath: resolve(join(agentDir, "..")) });
    const destHash = normalizedComparisonHash(dest);
    if (srcHash && destHash && srcHash === destHash) {
      log.push(`  OK (up to date): ${basename(dest)}`);
      return false;
    }
    // File exists but is stale — update it
    if (dryRun) {
      log.push(`  WOULD UPDATE: ${basename(dest)} (content differs from source)`);
      return true;
    }
    ensureDir(dirname(dest));
    copyFileSync(src, dest);
    log.push(`  UPDATED: ${basename(dest)}`);
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

  // 2. Seed KB files if missing (v3.0.0: explore-to-plan gate FAILs without these)
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

  // 3. Check SKILL.md has planner_version matching version.json
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

  // 4. Install pre-commit hook if not present
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

  // 5. Install sync-instructions.sh and create root instruction files
  log.push("\n## Root Instruction Files (CLAUDE.md / GEMINI.md / AGENTS.md)");
  const syncScriptSrc  = join(agentDir, "scripts", "sync-instructions.sh");
  const syncScriptDest = join(targetPath, ".agent/scripts", "sync-instructions.sh");
  const claudeMdSrc = findRootInstructionTemplatePath(targetBase);
  const claudeMdDest   = join(targetPath, "CLAUDE.md");
  const geminiMdDest   = join(targetPath, "GEMINI.md");
  const agentsMdDest   = join(targetPath, "AGENTS.md");

  if (existsSync(syncScriptSrc)) {
    ensureDir(join(targetPath, ".agent/scripts"));
    copyIfMissing(syncScriptSrc, syncScriptDest, dryRun, log);
    if (!dryRun && existsSync(syncScriptDest)) chmodSync(syncScriptDest, 0o755);
  } else {
    log.push(`  SKIP: sync-instructions.sh source not found`);
  }

  if (!existsSync(claudeMdDest)) {
    if (claudeMdSrc && existsSync(claudeMdSrc)) {
      if (!dryRun) {
        copyFileSync(claudeMdSrc, claudeMdDest);
        log.push(`  CREATED: CLAUDE.md (from planner template — edit to customise for this project)`);
      } else {
        log.push(`  WOULD CREATE: CLAUDE.md`);
      }
    } else {
      log.push(`  SKIP: CLAUDE.md template not found`);
    }
  } else {
    log.push(`  OK: CLAUDE.md exists`);
  }

  const canonicalSections = collectCanonicalRootInstructionSections(readFile(claudeMdSrc));
  if (
    existsSync(claudeMdDest) &&
    canonicalSections.length === ROOT_INSTRUCTION_SECTION_HEADINGS.length
  ) {
    const existingClaude = readFile(claudeMdDest) || "";
    if (
      rootInstructionsLookPlannerManaged(existingClaude) &&
      !rootInstructionsHaveCurrentFrontDoors(existingClaude, canonicalSections)
    ) {
      const refreshedClaude = applyManagedRootInstructionSnapshot(existingClaude, canonicalSections);
      if (!dryRun) {
        writeFileSync(claudeMdDest, refreshedClaude);
        log.push(`  REFRESHED: current planner snapshot in CLAUDE.md`);
      } else {
        log.push(`  WOULD REFRESH: current planner snapshot in CLAUDE.md`);
      }
    }
  }

  // Always sync GEMINI.md and AGENTS.md from CLAUDE.md (if it now exists)
  if (existsSync(claudeMdDest)) {
    if (!dryRun) {
      copyFileSync(claudeMdDest, geminiMdDest);
      copyFileSync(claudeMdDest, agentsMdDest);
      log.push(`  SYNCED: GEMINI.md and AGENTS.md from CLAUDE.md`);
    } else {
      log.push(`  WOULD SYNC: GEMINI.md and AGENTS.md from CLAUDE.md`);
    }
  }

  // 6. Run ripple check
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
    console.log(`\n  Run: node migrate.mjs upgrade ${targetPath}`);
  } else if (missing.length > 0) {
    console.log(`\n  🟡 Optional files missing (${missing.length}):`);
    for (const e of missing.slice(0, 10)) {
      console.log(`     - ${relative(targetPath, e.path)} [${e.category}]`);
    }
    if (missing.length > 10) console.log(`     ... and ${missing.length - 10} more`);
    console.log(`\n  Run: node migrate.mjs upgrade ${targetPath}`);
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
  console.log(`  Target project:    ${report.target_path}`);
  console.log(`  Detected version:  ${report.detected_version}`);
  console.log(`  Current version:   ${report.current_version}`);
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
    console.log(`\n  Suggested repair: node migrate.mjs upgrade ${targetPath}`);
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
  const staleCount = findVerificationDrift(manifest, targetPath).length;
  const setupIssues = collectRepairableSetupIssues(targetPath);
  const advisoryIssues = findRootInstructionSyncIssues(targetPath);

  if (version === CURRENT_VERSION && missing.length === 0 && staleCount === 0 && setupIssues.length === 0 && !seedKB) {
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

  if (version === CURRENT_VERSION && missing.length === 0 && staleCount === 0 && setupIssues.length > 0 && !seedKB) {
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

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  PLANNER UPGRADE ${dryRun ? "(DRY RUN) " : ""}                             ║`);
  const changeDesc = missing.length > 0 && staleCount > 0
    ? `${missing.length} new, ${staleCount} stale`
    : missing.length > 0 ? `${missing.length} to add`
    : staleCount > 0 ? `${staleCount} to update`
    : `0 changes`;
  console.log(`║  ${version} → ${CURRENT_VERSION}  (${changeDesc})                  ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

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
    (name) => name.endsWith(".json") || name === ".checklist_integrity",
    dryRun, log
  );
  if (!dryRun) {
    const targetRegistryPath = join(targetBase, "config", ".project_registry.json");
    try {
      const registry = existsSync(targetRegistryPath)
        ? JSON.parse(readFileSync(targetRegistryPath, "utf-8"))
        : { projects: [] };
      registry.source_project_path = resolve(join(agentDir, ".."));
      writeFileSync(targetRegistryPath, JSON.stringify(registry, null, 2) + "\n");
      log.push("  UPDATED: .project_registry.json source_project_path");
    } catch (e) {
      log.push(`  WARN: Could not update .project_registry.json source_project_path: ${e.message}`);
    }
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
    (name) => name.endsWith(".mjs") || name.endsWith(".json") || name.endsWith(".md"),
    dryRun, log
  );

  // --- Packs (domain packs) ---
  log.push("\n## Domain Packs");
  copyDirTree(
    join(skillDir, "packs"),
    join(targetBase, "packs"),
    (name) => name.endsWith(".mjs") || name.endsWith(".pl") || name.endsWith(".md") || name.endsWith(".json"),
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
            // Recompute _state_hash via determinism.mjs
            const skillBase = join(targetPath, ".agent/skills/iterative-planner");
            const hashScript = `
              import { computeStateHash } from "./scripts/lib/determinism.mjs";
              import { readFileSync, writeFileSync } from "fs";
              const p = ${JSON.stringify(statePath)};
              const s = JSON.parse(readFileSync(p, "utf8"));
              s.circuit_breakers = {};
              s._state_hash = computeStateHash(s);
              writeFileSync(p, JSON.stringify(s, null, 2));
            `;
            runNode(["--input-type=module", "-e", hashScript], { cwd: skillBase, stdio: "pipe", timeout: 10000 });
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

    if (stillMissing.length === 0) {
      console.log(`  ✅ POST-UPGRADE VERIFICATION: All ${postManifest.length} files present.`);
    } else if (stillMissingCritical.length > 0) {
      console.log(`  ❌ POST-UPGRADE VERIFICATION: ${stillMissingCritical.length} CRITICAL file(s) still missing:`);
      for (const e of stillMissingCritical) {
        console.log(`     - ${relative(targetPath, e.path)} [${e.category}]`);
      }
    } else {
      console.log(`  ⚠️  POST-UPGRADE VERIFICATION: ${stillMissing.length} optional file(s) still missing.`);
    }
    // Re-baseline config integrity hashes after upgrade (RETRO M-005).
    // migrate.mjs is a trusted file modifier — updated files must not trigger
    // integrity violations on the next transition.
    const configIntegrityPath = join(targetPath, ".agent/skills/iterative-planner/config/.config_integrity");
    if (existsSync(configIntegrityPath)) {
      try { unlinkSync(configIntegrityPath); } catch { /* ignore */ }
    }
    try {
      const rebaseline = `import{updateConfigIntegrity}from'./scripts/lib/determinism.mjs';process.exit(updateConfigIntegrity({force:true})?0:1)`;
      const skillBase = join(targetPath, ".agent/skills/iterative-planner");
      runNode(["--input-type=module", "-e", rebaseline], { cwd: skillBase, stdio: "pipe", timeout: 10000 });
      console.log(`  ✅ CONFIG INTEGRITY: Re-baselined after upgrade.`);
    } catch (e) {
      // determinism.mjs may not exist or export updateConfigIntegrity in older versions — not fatal
      console.log(`  ⚠️  CONFIG INTEGRITY: Could not re-baseline automatically. Delete .config_integrity manually if transitions block.`);
    }

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

  if (missing.length > 0 && missingCritical.length === 0) {
    console.log(`\n  🟡 Only optional files missing — core functionality intact.`);
  }

  if (missing.length === 0 && stale.length === 0) {
    if (advisoryIssues.length > 0) {
      console.log(`\n  ✅ PASS — Planner-managed files are present and current. Advisory instruction drift is listed above.`);
    } else {
      console.log(`\n  ✅ PASS — Installation complete. All ${manifest.length} files present and up to date.`);
    }
  } else if (missing.length === 0 && stale.length > 0) {
    console.log(`\n  ⚠️  STALE — All files present but ${stale.length} need updating. Run: node migrate.mjs upgrade <path>`);
  }

  console.log();
  process.exit(missingCritical.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Project-level setup (always runs, regardless of version)
// ---------------------------------------------------------------------------

function cmdSetup(targetPath, dryRun) {
  const log = [];

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  PROJECT SETUP ${dryRun ? "(DRY RUN) " : ""}                              ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  runProjectSetup(targetPath, dryRun, log);

  // Print log
  for (const line of log) {
    console.log(line);
  }

  console.log(`\n  ══ SETUP COMPLETE ══`);
  console.log(`  If audit.config.json was just created, edit it to add your domain role(s): "assumptions_challenger", "quant", "tokenomics", "ux_ui", etc.`);
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
    source_project_path: registry?.source_project_path || resolve(join(agentDir, "..")),
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
      console.log(`\n  To upgrade all: node migrate.mjs upgrade-all`);
    }
    console.log();
  }

  return enriched;
}

function cmdUpgradeAll(dryRun) {
  const registry = loadRegistry();

  // If no registry or stale (>7 days), auto-scan
  const registryAge = registry.last_scan
    ? (Date.now() - new Date(registry.last_scan).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  let projects;
  if (registry.projects.length === 0 || registryAge > 7) {
    console.log("  Registry empty or stale — scanning for projects first...\n");
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
    console.log(`  Using cached registry (${projects.length} projects, scanned ${registry.last_scan})\n`);
  }

  // Filter to source project itself
  const sourceProject = resolve(join(agentDir, ".."));
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
      // Run upgrade
      const upgradeResult = cmdUpgrade(project.path, false, dryRun);
      if (!dryRun && upgradeResult?.setupNeeded) cmdSetup(project.path, false);

      // Verify version after upgrade
      const postSkillMd = join(project.path, ".agent/skills/iterative-planner/SKILL.md");
      const postContent = readFile(postSkillMd);
      const postVersion = postContent?.match(/planner_version:\s*["']?(\d+\.\d+\.\d+)["']?/)?.[1] || "unknown";

      results.push({
        name: project.name,
        path: project.path,
        from: project.version,
        to: postVersion,
        status: "OK",
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

  const ok = results.filter(r => r.status === "OK");
  const failed = results.filter(r => r.status !== "OK");

  for (const r of results) {
    const icon = r.status === "OK" ? "✅" : "❌";
    const versionChange = r.from === r.to ? `v${r.to}` : `v${r.from} → v${r.to}`;
    console.log(`  ${icon} ${r.name.padEnd(35)} ${versionChange}`);
  }

  console.log(`\n  ${ok.length} succeeded, ${failed.length} failed out of ${results.length} projects`);
  if (failed.length > 0) {
    console.log(`\n  Failed projects:`);
    for (const r of failed) console.log(`    ${r.path}: ${r.status}`);
  }
  console.log();

  if (dryRun) {
    console.log(`  Registry metadata unchanged in dry run.`);
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
  const registryAge = registry.last_scan
    ? (Date.now() - new Date(registry.last_scan).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  let projects;
  if (registry.projects.length === 0 || registryAge > 7) {
    console.log("  Registry empty or stale — scanning for projects first...\n");
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
    console.log(`  Using cached registry (${projects.length} projects)\n`);
  }

  const sourceProject = resolve(join(agentDir, ".."));
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
    if (report.status !== "PASS") process.exitCode = 1;
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
  if (report.status !== "PASS") process.exitCode = 1;
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
  if (secondPass?.status && secondPass.status !== "PASS") return "semantically_behind";
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
  const sourceProject = resolve(join(agentDir, ".."));
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
    second_pass_required: status === "semantically_behind" || status === "blocked",
    second_pass_verified: secondPassVerification.status === "PASS",
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
  const migrationWaveRead = readMigrationWaveManifest(manifestPath || defaultMigrationWavePath());
  const report = {
    generated_at: new Date().toISOString(),
    current_version: CURRENT_VERSION,
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

  if (projectReport.second_pass_verification?.status && projectReport.second_pass_verification.status !== "PASS") {
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

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage: node migrate.mjs <command> <target-project-path> [options]

Commands:
  detect <path>              Detect version + integrity check (missing files)
  doctor <path>              Machine-readable repair diagnosis for self-heal entrypoints
  upgrade <path>             Apply upgrades (all components)
  upgrade <path> --seed-kb   Also seed knowledge base
  setup <path>               Project-level setup (audit config, hooks, version sync)
  annotate <path>            Bootstrap @planner: annotations (scan, apply, review)
  verify <path>              Post-upgrade integrity verification
  scaffold-discovery-policy <path>  Suggest or write a starter planner.discovery.json for matched archetypes
  promote-knowledge <path>   Preview or write draft KB promotion overlays for host-owned learnings
  semantic-scan <path>       Read-only semantic health scan for one project

  scan [path...]             Discover all planner projects under given paths
  verify-fleet               Classify discovered projects by migration/support status
  fleet-doctor               Group recurring fleet readiness gaps by project archetype
  migration-wave create      Write reports/migration_wave.json include/exclude contract
  migration-wave verify      Verify migration_wave.json version boundaries
  upgrade-all                Upgrade ALL discovered projects (uses registry from last scan)
  annotate-all               Annotate ALL discovered projects

Options:
  --dry-run                  Preview changes without writing files
  --json                     Emit JSON for commands that support it (doctor, verify-fleet, fleet-doctor, migration-wave, scaffold-discovery-policy, promote-knowledge, semantic-scan)
  --write                    Write scaffold output for commands that support it
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

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const seedKB = args.includes("--seed-kb");
const jsonOutput = args.includes("--json");
const writePolicy = args.includes("--write");
let draftCandidatesPathArg = null;
let waveManifestPathArg = null;
let waveExpectedVersion = null;
let waveDeferredVersion = null;
let waveReason = null;
const waveExclusions = [];
const filteredArgs = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
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

// ---------------------------------------------------------------------------
// Self-update: for mutating commands we refresh the target copy first so a stale
// downstream migrate.mjs can still repair itself. Read-only commands must not
// force writes into host projects just to inspect them.
// ---------------------------------------------------------------------------
const selfSource = __filename;
const selfTarget = targetPath ? join(targetPath, ".agent/skills/iterative-planner/scripts/migrate.mjs") : null;
const selfUpdatingCommands = new Set(["upgrade", "setup", "annotate", "promote-knowledge"]);
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

if (command === "detect") {
  cmdDetect(targetPath);
} else if (command === "doctor") {
  cmdDoctor(targetPath, jsonOutput);
} else if (command === "upgrade") {
  const upgradeResult = cmdUpgrade(targetPath, seedKB, dryRun);
  if (!dryRun && upgradeResult?.setupNeeded) {
    cmdSetup(targetPath, false);
  }
} else if (command === "setup") {
  cmdSetup(targetPath, dryRun);
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
  cmdUpgradeAll(dryRun);
} else if (command === "annotate-all") {
  cmdAnnotateAll(dryRun);
} else {
  console.error(`ERROR: Unknown command "${command}". Use --help.`);
  process.exit(1);
}
