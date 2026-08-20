// plan_utils.mjs — Shared utilities for iterative planner scripts.
//
// Extracted from duplicated helpers across verify_gate, checklist_runner,
// test_baseline, close_guard, and bootstrap. Single source of truth.
//
// Zero dependencies — Node.js 18+.

import { readFileSync, writeFileSync, realpathSync, existsSync, statSync, lstatSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname, resolve, basename, extname } from "path";
import { fileURLToPath } from "url";
import { getIntentContractProjection, loadPlanWorkOrder } from "./work_order_contract.mjs";
import { normalizeVerificationStatus } from "./verification_status_vocabulary.mjs";
import { cleanupOwnedFile, finalizeOwnedFileReplace, observeOwnedFile, replaceOwnedFile } from "./owned_file_replace.mjs";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the skill directory from a script's import.meta.url.
 * Assumes scripts live in <skill-dir>/scripts/ or <skill-dir>/scripts/lib/.
 */
export function getSkillPath(importMetaUrl) {
  const __filename = fileURLToPath(importMetaUrl);
  const scriptDir = dirname(__filename);
  // Handle both scripts/ and scripts/lib/ locations
  const dirName = scriptDir.endsWith("lib") ? resolve(scriptDir, "..", "..") : resolve(scriptDir, "..");
  return dirName;
}

/**
 * Standard plan directory paths resolved from cwd.
 */
export function getPaths(cwdOverride) {
  const cwd = cwdOverride || process.cwd();
  const plansDir = join(cwd, "plans");
  const pointerFile = join(plansDir, ".current_plan");
  const knowledgeDir = join(plansDir, "knowledge");
  const threadTargetsDir = join(plansDir, ".thread_targets");
  return { cwd, plansDir, pointerFile, knowledgeDir, threadTargetsDir };
}

// ---------------------------------------------------------------------------
// Plan pointer
// ---------------------------------------------------------------------------

const THREAD_TARGETS_DIR = ".thread_targets";

// Harness-agnostic per-agent session/thread identity. Codex sets CODEX_THREAD_ID;
// Claude Code sets CLAUDE_CODE_SESSION_ID. _PLANNER_THREAD_ID is a manual override
// for any other harness. Without one of these, per-thread plan isolation is
// impossible and every concurrent agent falls through to the shared
// plans/.current_plan pointer (plans get mixed up across agents).
export function getPlannerThreadId(env = process.env) {
  const candidates = [
    env?._PLANNER_THREAD_ID,
    env?.CODEX_THREAD_ID,
    env?.CLAUDE_CODE_SESSION_ID,
  ];
  for (const raw of candidates) {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

export function getPlannerEnvPlanTarget(env = process.env, plansDir = null) {
  const raw = env?._PLANNER_PLAN_TARGET;
  return normalizePlanDirName(raw, plansDir);
}

function sanitizeThreadId(threadId) {
  return String(threadId || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 160);
}

export function normalizePlanDirName(rawPlan, plansDir = null) {
  if (typeof rawPlan !== "string") return null;
  const trimmed = rawPlan.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)(plan_[^/]+)(?:\/|$)/);
  if (match) return match[1];
  if (normalized.startsWith("plan_")) return normalized.replace(/\/+$/, "");

  if (plansDir) {
    const candidate = resolve(plansDir, normalized);
    const base = basename(candidate);
    if (base.startsWith("plan_")) return base;
  }

  return null;
}

function getThreadTargetPath(plansDir, threadId) {
  const safeThreadId = sanitizeThreadId(threadId);
  if (!safeThreadId) return null;
  return join(plansDir, THREAD_TARGETS_DIR, `${safeThreadId}.txt`);
}

export function readThreadPlanTarget(plansDir, opts = {}) {
  const threadId = opts.threadId || getPlannerThreadId(opts.env);
  const targetPath = getThreadTargetPath(plansDir, threadId);
  if (!targetPath) return null;
  const observed = observeOwnedFile(targetPath, { maxBytes: 4096 });
  if (observed.status !== "present") return null;
  const planDirName = normalizePlanDirName(observed.bytes.toString("utf8"), plansDir);
  if (planDirName && existsSync(join(plansDir, planDirName))) return planDirName;
  if (typeof opts.hooks?.beforeStaleCleanup === "function") {
    opts.hooks.beforeStaleCleanup({ targetPath, token: observed.token });
  }
  cleanupOwnedFile(observed.token);
  return null;
}

export function writeThreadPlanTarget(plansDir, planDirName, opts = {}) {
  const normalizedPlanDirName = normalizePlanDirName(planDirName, plansDir);
  const threadId = opts.threadId || getPlannerThreadId(opts.env);
  const targetPath = getThreadTargetPath(plansDir, threadId);
  if (!normalizedPlanDirName || !targetPath) return { written: false, reason: "missing_target" };
  if (!existsSync(join(plansDir, normalizedPlanDirName))) return { written: false, reason: "missing_plan_dir" };

  mkdirSync(join(plansDir, THREAD_TARGETS_DIR), { recursive: true });
  const observed = observeOwnedFile(targetPath, { maxBytes: 4096 });
  const replacement = replaceOwnedFile({
    path: targetPath,
    bytes: `${normalizedPlanDirName}\n`,
    expected: observed.status === "present" ? observed.token : null,
    hooks: opts.hooks || {},
  });
  if (replacement.status !== "committed") {
    return { written: false, reason: replacement.reason, status: replacement.status, replacement };
  }
  const finalization = finalizeOwnedFileReplace(replacement);
  if (finalization.status !== "committed") {
    return { written: false, reason: finalization.reason, status: "cleanup_pending", replacement };
  }
  return { written: true, threadId, targetPath, planDirName: normalizedPlanDirName, replacement };
}

export function clearThreadPlanTarget(plansDir, opts = {}) {
  const threadId = opts.threadId || getPlannerThreadId(opts.env);
  const targetPath = getThreadTargetPath(plansDir, threadId);
  if (!targetPath) return { cleared: false, reason: "missing_target" };

  const observed = observeOwnedFile(targetPath, { maxBytes: 4096 });
  if (observed.status === "absent") return { cleared: false, reason: "missing_target" };
  if (observed.status !== "present") return { cleared: false, reason: "unsafe_target" };

  if (opts.planDirName) {
    const existing = normalizePlanDirName(observed.bytes.toString("utf8"), plansDir);
    const normalizedPlanDirName = normalizePlanDirName(opts.planDirName, plansDir);
    if (!existing || existing !== normalizedPlanDirName) {
      return { cleared: false, reason: "plan_mismatch", existing };
    }
  }

  if (typeof opts.hooks?.beforeCleanup === "function") {
    opts.hooks.beforeCleanup({ targetPath, token: observed.token });
  }
  const cleanup = cleanupOwnedFile(observed.token);
  return cleanup.status === "committed"
    ? { cleared: true, threadId, targetPath }
    : { cleared: false, reason: "target_changed", status: cleanup.status };
}

export function resolvePlanTarget(plansDir, opts = {}) {
  const explicitPlan = normalizePlanDirName(opts.plan || opts.planDirName || null, plansDir);
  const explicitProvided = typeof opts.plan === "string" || typeof opts.planDirName === "string";
  const threadId = opts.threadId || getPlannerThreadId(opts.env);
  const envPlan = getPlannerEnvPlanTarget(opts.env, plansDir);

  if (explicitProvided) {
    if (explicitPlan && existsSync(join(plansDir, explicitPlan))) {
      return {
        source: "explicit",
        threadId,
        planDirName: explicitPlan,
        planDir: join(plansDir, explicitPlan),
      };
    }
    if (opts.exitOnMissing) {
      console.error(`ERROR: Plan not found: ${opts.plan || opts.planDirName}`);
      process.exit(1);
    }
    return { source: "explicit", threadId, planDirName: null, planDir: null };
  }

  if (opts.allowEnvTarget !== false && envPlan && existsSync(join(plansDir, envPlan))) {
    return {
      source: "env",
      threadId,
      planDirName: envPlan,
      planDir: join(plansDir, envPlan),
    };
  }

  if (opts.allowThreadTarget !== false) {
    const threadPlanDirName = readThreadPlanTarget(plansDir, { threadId, env: opts.env });
    if (threadPlanDirName) {
      return {
        source: "thread",
        threadId,
        planDirName: threadPlanDirName,
        planDir: join(plansDir, threadPlanDirName),
      };
    }
  }

  const pointerPlanDirName = readPointer(plansDir);
  if (pointerPlanDirName) {
    return {
      source: "pointer",
      threadId,
      planDirName: pointerPlanDirName,
      planDir: join(plansDir, pointerPlanDirName),
    };
  }

  if (opts.exitOnMissing) {
    console.error("ERROR: No target plan. Create one with bootstrap.mjs first.");
    process.exit(1);
  }

  return { source: null, threadId, planDirName: null, planDir: null };
}

/**
 * Read the active plan directory name from plans/.current_plan.
 * Returns the directory name (not full path), or null if no active plan.
 */
export function readPointer(plansDir) {
  const pointerFile = join(plansDir, ".current_plan");
  try {
    const name = readFileSync(pointerFile, "utf-8").trim();
    if (!name) return null;
    if (existsSync(join(plansDir, name))) return name;
    // Stale pointer — directory was deleted but pointer remains
    debugLog("readPointer", `Stale pointer: plans/${name} no longer exists. Run 'bootstrap.mjs list' to inspect.`);
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the full path to the active plan directory.
 * Returns { planDirName, planDir } or exits with error if no active plan.
 */
export function getActivePlan(plansDir, { exitOnMissing = true } = {}) {
  const planDirName = readPointer(plansDir);
  if (!planDirName) {
    if (exitOnMissing) {
      console.error("ERROR: No active plan. Create one with bootstrap.mjs first.");
      process.exit(1);
    }
    return { planDirName: null, planDir: null };
  }
  return { planDirName, planDir: join(plansDir, planDirName) };
}

const ACTIVE_PLAN_MARKDOWN = "ACTIVE_PLAN.md";
const ACTIVE_PLAN_JSON = "ACTIVE_PLAN.json";
const NON_ACTIVE_PLAN_TRACE_LIMIT = 30;
const NON_ACTIVE_PLAN_WRITE_TOOLS = new Set(["Edit", "Write"]);
const NON_ACTIVE_PLAN_READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export function normalizeStatus(text) {
  const status = normalizeVerificationStatus(text, "decision");
  if (!status.valid) return null;
  if (status.kind === "pass") return "pass";
  if (status.kind === "fail") return "fail";
  if (status.kind === "pending") return "warn";
  return null;
}

const DOC_ONLY_EXTENSIONS = new Set([
  ".md", ".txt", ".rst", ".adoc",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
]);

const STATIC_UI_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
]);

export function looksLikeDocumentationPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (lower.endsWith("/")) return true;
  if (
    lower.includes("/workflows/") ||
    lower.endsWith("/readme.md") ||
    lower.endsWith("skill.md") ||
    lower.includes("/references/")
  ) {
    return true;
  }
  return DOC_ONLY_EXTENSIONS.has(extname(lower));
}

export function looksLikeStaticUiPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  return STATIC_UI_EXTENSIONS.has(extname(raw.toLowerCase()));
}

function normalizeHeadingText(value) {
  return String(value || "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const SECTION_HEADING_ALIASES = Object.freeze({
  "files to modify": [
    "Files To Modify",
    "Files to Modify",
    "Files to Change",
    "Touched Files",
    "Owned Files",
  ],
});

export function extractMarkdownSection(content, heading) {
  const text = String(content || "");
  const aliases = SECTION_HEADING_ALIASES[normalizeHeadingText(heading)] || [heading];
  const wanted = new Set(aliases.map(normalizeHeadingText));
  const headingPattern = /^##\s+(.+?)\s*$/gm;
  let headingMatch = null;
  let match = null;
  while ((match = headingPattern.exec(text)) !== null) {
    if (wanted.has(normalizeHeadingText(match[1]))) {
      headingMatch = match;
      break;
    }
  }
  if (!headingMatch || headingMatch.index === undefined) return "";

  const afterHeading = text.slice(headingMatch.index + headingMatch[0].length).replace(/^\n/, "");
  const nextHeadingMatch = afterHeading.match(/\n## |\n# /);
  return nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
}

const ROOT_FILE_NAMES = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "makefile",
  "package.json",
  "readme.md",
  "tsconfig.json",
]);

function stripListedPathStatus(value) {
  return String(value || "")
    .trim()
    .replace(/^\[(?:new|add|added|create|modify|edit|update|delete|remove|touch|owned|test|doc|config)\]\s+/i, "")
    .trim();
}

function normalizePathCandidate(value) {
  let normalized = stripListedPathStatus(value);
  const markdownLink = normalized.match(/^\[[^\]]+\]\(([^)]+)\)$/);
  if (markdownLink) normalized = markdownLink[1].trim();
  const codeWrapped = normalized.match(/^`+(.*)`+$/);
  if (codeWrapped) normalized = codeWrapped[1].trim();
  normalized = normalized.replace(/^['"]+|['"]+$/g, "").trim();
  normalized = normalized.replace(/[),.;]+$/g, "").trim();
  return normalized;
}

function isPlaceholderListedPath(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === "tbd" || normalized === "n/a" || normalized === "none") return true;
  if (normalized === "to be determined after explore") return true;
  return normalized.startsWith("to be determined") ||
    normalized.startsWith("pending explore") ||
    normalized.startsWith("list every file");
}

function looksLikeListedPath(value) {
  const candidate = normalizePathCandidate(value);
  if (isPlaceholderListedPath(candidate)) return false;
  if (/^\[/.test(candidate)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return false;
  if (/\s/.test(candidate)) return false;
  if (candidate.includes("|")) return false;

  const normalized = candidate.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  if (lower.startsWith(".") || lower.includes("/")) return true;
  if (ROOT_FILE_NAMES.has(lower)) return true;
  return Boolean(extname(lower));
}

function normalizeListedPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const codeSpanCandidates = [...raw.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  for (const candidate of codeSpanCandidates) {
    const normalized = normalizePathCandidate(candidate);
    if (looksLikeListedPath(normalized)) return normalized;
  }

  const stripped = stripListedPathStatus(raw);
  const splitCandidates = [
    stripped,
    stripped.split(/\s+-\s+|\s+--\s+|\s+—\s+|\s+–\s+|:\s+/)[0],
    stripped.split(/\s+\(/)[0],
    stripped.split(/\s+/)[0],
  ].map(normalizePathCandidate);

  for (const candidate of splitCandidates) {
    if (looksLikeListedPath(candidate)) return candidate;
  }

  return null;
}

export function extractFilesToModify(planContent) {
  const section = extractMarkdownSection(planContent, "Files To Modify");
  if (!section) return [];
  const files = [];
  const seen = new Set();
  const addFile = (value) => {
    const normalized = normalizeListedPath(value);
    if (!normalized) return;
    const key = normalized.replace(/\\/g, "/");
    if (seen.has(key)) return;
    seen.add(key);
    files.push(normalized);
  };

  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      addFile(bullet[1]);
      continue;
    }
    const heading = line.match(/^#{3,6}\s+(.+)$/);
    if (heading) addFile(heading[1]);
  }

  return files;
}

function textIncludesAnyPhrase(text, phrases) {
  const lower = String(text || "").toLowerCase();
  return phrases.some((phrase) => lower.includes(String(phrase || "").toLowerCase()));
}

export function goalLooksLikeCmsMissingContentIncident(goalText, plannedFiles = []) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const text = String(goalText || "").toLowerCase();
  if (!text) return false;

  const cmsContextSignals = /\b(wordpress|cms|custom post type|custom post types|page builder|elementor|gutenberg|theme|plugin|archive|post type)\b/;
  const missingContentPhrases = [
    "missing content",
    "content is missing",
    "data disappeared",
    "page looks empty",
    "pages look empty",
    "looks empty",
    "empty page",
    "blank page",
    "content not showing",
    "not showing",
    "custom post type missing",
    "custom post types missing",
  ];
  const databaseRewriteSignals = /\b(migrate|migration|sync|rewrite|backend|query|database|db)\b/;
  const wordpressFileSignals = files.some((filePath) => {
    const normalized = String(filePath || "").toLowerCase();
    return normalized.endsWith(".php") ||
      normalized.includes("wp-content/") ||
      normalized.includes("wordpress") ||
      normalized.includes("theme") ||
      normalized.includes("plugin");
  });

  const hasCmsContext = cmsContextSignals.test(text) || wordpressFileSignals;
  const hasMissingSymptom = textIncludesAnyPhrase(text, missingContentPhrases);
  return hasCmsContext && (hasMissingSymptom || (databaseRewriteSignals.test(text) && textIncludesAnyPhrase(text, ["missing", "empty", "blank"])));
}

export function goalLooksLikeCmsContentEdit(goalText, plannedFiles = []) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const text = String(goalText || "").toLowerCase();
  if (!text) return false;

  const cmsSignals = /\b(wordpress|cms|landing page|page|button|cta|link|banner|hero|menu|redirect)\b/;
  const contentEditSignals = /\b(remove|edit|update|redirect|replace|hide|delete|swap|change|retarget)\b/;
  const uiFileSignals = files.some((filePath) => /\.(html|htm|css|scss|sass|less|php)$/.test(String(filePath || "").toLowerCase()));

  return (cmsSignals.test(text) && contentEditSignals.test(text)) || (uiFileSignals && cmsSignals.test(text));
}

export function goalLooksLikeStaticUiDeliverable(goalText, plannedFiles = []) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  if (goalLooksLikeCmsMissingContentIncident(goalText, files)) return false;
  if (files.length > 0 && files.every(looksLikeStaticUiPath)) return true;
  if (goalLooksLikeCmsContentEdit(goalText, files)) return true;

  const text = String(goalText || "").toLowerCase();
  if (!text) return false;

  const uiSignals = /\b(page|ui|screen|view|landing page|html|css|wordpress|cms|button|cta|link)\b/;
  const presentationSignals = /\b(static|standalone|frontend|visual|layout|design)\b/;
  const actionSignals = /\b(clone|copy|mirror|recreate|replicate|restyle|design|refresh|match|remove|edit|update|redirect|replace|hide|delete)\b/;

  return uiSignals.test(text) && (presentationSignals.test(text) || actionSignals.test(text));
}

export function goalLooksLikeDocContractChange(goalText, plannedFiles = []) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  if (files.length > 0 && files.every((filePath) => looksLikeDocumentationPath(filePath) && !looksLikeStaticUiPath(filePath))) {
    return true;
  }

  const text = String(goalText || "").toLowerCase();
  if (!text) return false;

  const docSignals = /\b(doc|docs|documentation|readme|workflow|workflows|skill|guide|instruction|instructions|wording|copy|template|contract|checklist)\b/;
  const changeSignals = /\b(add|align|clarify|document|fix|refresh|rewrite|sync|tighten|update)\b/;
  const codeSignals = /\b(runtime|provider|schema|api|database|migration|refactor|embedding|auth|parser)\b/;

  return docSignals.test(text) && changeSignals.test(text) && !codeSignals.test(text);
}

export function goalLooksLikePlannerCoreChange(goalText, plannedFiles = []) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  if (files.some((filePath) => (
    filePath.includes(".agent/skills/iterative-planner/") ||
    filePath.includes(".agent/workflows/") ||
    filePath === ".agent/rules.md"
  ))) {
    return true;
  }

  const text = String(goalText || "").toLowerCase();
  if (!text) return false;

  return /\b(planner|gate|ontology|traceability|story registry|story-registry|advisor|safe-change|safe-change-power|preflight)\b/.test(text) ||
    /\bworkflow registry\b/.test(text) ||
    /\bplanner workflow\b/.test(text);
}

export function detectPlannerDogfoodIncident(goalText, plannedFiles = []) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const text = String(goalText || "").toLowerCase();
  if (!text) {
    return {
      active: false,
      trigger: "planner-dogfood-false-green",
      matched_surfaces: [],
      matched_terms: [],
    };
  }

  const plannerFileContext = files.some((filePath) => {
    const normalized = String(filePath || "").toLowerCase();
    return normalized.includes(".agent/skills/iterative-planner/") ||
      normalized.includes(".agent/workflows/") ||
      normalized.includes("plans/programs/planner-dogfood-false-green-remediation/");
  });
  const plannerContext = plannerFileContext ||
    /\b(planner|iterative planner|agent|workflow|advisor|steward|ontology|invariant verification|iv)\b/.test(text);
  const incidentTerms = [
    "dogfood",
    "false green",
    "false-green",
    "health audit missed",
    "health audit using gemini missed",
    "not eating its own dogfood",
    "not eating own dogfood",
    "bad at eating",
    "failed to use",
    "did not use",
    "didn't use",
  ];
  const matchedIncidentTerms = incidentTerms.filter((phrase) => text.includes(phrase));
  const surfaceChecks = [
    {
      id: "advisor",
      terms: ["advisor not used", "advisor not being used", "advisor being used", "little of advisor", "lack of advisor"],
    },
    {
      id: "steward",
      terms: ["steward not used", "steward not being used", "lack of steward", "route to steward", "steward automatically"],
    },
    {
      id: "ontology_iv",
      terms: ["ontology not used", "ontology or iv", "ontology/iv", " iv not used", "invariant verification not used", "invariant verification", " iv "],
    },
    {
      id: "user_stories",
      terms: ["user stories missing", "lack of user stories", "nothing about user stories", "story traceability missing"],
    },
    {
      id: "north_star",
      terms: ["north star missing", "north star not mentioned", "lack of north star", "nothing about north star", "mention of it"],
    },
    {
      id: "health_audit",
      terms: ["health audit missed", "health audit using gemini", "health audit uncovered", "health audit"],
    },
  ];

  const matchedSurfaces = [];
  const matchedTerms = [...matchedIncidentTerms];
  for (const surface of surfaceChecks) {
    const matches = surface.terms.filter((phrase) => text.includes(phrase));
    if (matches.length === 0) continue;
    matchedSurfaces.push(surface.id);
    matchedTerms.push(...matches);
  }

  const hasDogfoodOrFalseGreen = text.includes("dogfood") || text.includes("false green") || text.includes("false-green");
  const hasHealthAuditMiss = text.includes("health audit") && matchedSurfaces.some((id) => ["user_stories", "north_star"].includes(id));
  const clusteredPlannerComplaint = plannerContext && matchedSurfaces.length >= 2 && (
    matchedIncidentTerms.length > 0 ||
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Semantic risk-language detector checks Current Understanding and pre-mortem text for acknowledged weaknesses.
    /\b(missed|missing|lack|little|not used|not being used|nothing about|failed)\b/.test(text)
  );
  const active = plannerContext && matchedSurfaces.length > 0 && (
    hasDogfoodOrFalseGreen ||
    hasHealthAuditMiss ||
    clusteredPlannerComplaint
  );

  const reasonSurfaces = matchedSurfaces.length > 0 ? matchedSurfaces.join(", ") : "planner dogfood surface";
  return {
    active,
    trigger: "planner-dogfood-false-green",
    matched_surfaces: [...new Set(matchedSurfaces)],
    matched_terms: [...new Set(matchedTerms)],
    recommended_entrypoint: "/advisor",
    recommended_followup_workflow: "/steward",
    next: "Run /advisor to acknowledge the incident, then launch /steward before ordinary continuation.",
    why: `Planner dogfood false-green complaint matched ${reasonSurfaces}; stewardship must consolidate advisor, ontology/IV, story, and North Star drift.`,
  };
}

export function goalLooksLikeOperationalIntegrationChange(goalText, plannedFiles = []) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const text = String(goalText || "").toLowerCase();
  if (!text && files.length === 0) return false;

  const integrationSignals = /\b(integration|connector|webhook|adapter|transport|runner|orchestration|sync|retry|api)\b/;
  const fileSignals = files.some((filePath) => {
    const normalized = String(filePath || "").toLowerCase();
    return normalized.includes("/integrations/") ||
      normalized.includes("runner") ||
      normalized.includes("connector") ||
      normalized.includes("webhook") ||
      normalized.endsWith(".mjs") ||
      normalized.endsWith(".js");
  });

  return integrationSignals.test(text) && fileSignals;
}

export function goalLooksLikeSimpleTask(goalText, plannedFiles = []) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const text = String(goalText || "").toLowerCase();
  const explicitSimple = /\b(single-file|single file|one-file|one file|simple|quick|obvious|tiny|small|known-root-cause|known root cause|straightforward)\b/;
  const complexSignals = /\b(migration|refactor|cross-system|cross system|shared module|shared modules|multi-file|multiple files|investigate|diagnose|unclear|stabilize)\b/;

  if (goalLooksLikeCmsMissingContentIncident(goalText, files)) return false;
  if (goalLooksLikeStaticUiDeliverable(goalText, files)) return true;
  if (files.length > 0 && files.length <= 3 && !complexSignals.test(text)) return true;
  return explicitSimple.test(text) && !complexSignals.test(text);
}

export function goalLooksLikeProgramIntakeRequest(goalText) {
  const text = String(goalText || "").toLowerCase();
  if (!text) return false;

  const directIntakeSignals = [
    "idea-to-ticket",
    "idea to ticket",
    "ideas-to-tickets",
    "ideas to tickets",
    "turn ideas into tickets",
    "turn broad ideas into tickets",
    "convert ideas into tickets",
    "create tickets from ideas",
    "draft tickets from ideas",
    "generate tickets from ideas",
    "ticket-centered intake",
    "ticket centered intake",
    "program intake",
    "backlog intake",
    "issue intake",
    "github issue intake",
    "github project intake",
  ];
  if (textIncludesAnyPhrase(text, directIntakeSignals)) return true;

  const sourceSignals = /\b(idea|ideas|backlog|roadmap|github issue|github issues|github project|github projects|project item|project items|broad prompt|broad prompts|user story|user stories)\b/.test(text);
  const targetSignals = /\b(ticket|tickets|issue|issues|program packet|program packets|epic|epics|acceptance criteria|verification row|verification rows|child plan|child plans|backlog)\b/.test(text);
  const generationSignals = /\b(generate|create|draft|derive|turn|convert|intake|decompose|triage|seed|scaffold|populate|publish)\b/.test(text);

  return sourceSignals && targetSignals && generationSignals;
}

// @planner:config_flag = planning_only_mode
// @planner:mutually_exclusive = execution_ready_mode
export function goalLooksLikePlanningOnlyRequest(goalText) {
  const text = String(goalText || "").toLowerCase();
  if (!text) return false;

  const explicitExecutionSameSessionSignals = [
    "then implement",
    "then build",
    "then fix",
    "then code",
    "then execute",
    "and implement",
    "and then implement",
    "and build",
    "and then build",
    "go ahead and implement",
    "write the code",
    "build the fix",
  ];

  const explicitNoCodeSignals = [
    "plan only",
    "planning only",
    "no code",
    "without writing code",
    "without code",
    "code later",
    "do not write code",
    "don't write code",
    "dont write code",
  ];

  if (
    textIncludesAnyPhrase(text, explicitExecutionSameSessionSignals) &&
    !textIncludesAnyPhrase(text, explicitNoCodeSignals)
  ) {
    return false;
  }

  const strongSignals = [
    "plan only",
    "planning only",
    "implementation plan",
    "no code",
    "without writing code",
    "without code",
    "code later",
    "think this through first",
    "think it through first",
    "plan this first",
    "just plan",
    "do not write code",
    "don't write code",
    "dont write code",
  ];

  if (textIncludesAnyPhrase(text, strongSignals)) return true;

  const pairedSignals = (
    /\b(plan|planning)\b/.test(text) &&
    /\b(later|handoff|proposal|outline|strategy|audit|separate session|not now)\b/.test(text) &&
    /\b(code|implement|implementation|build|ship|execute)\b/.test(text)
  );

  return pairedSignals;
}

export function inferPreflightEvidenceMode(goalText, { plannedFiles = [] } = {}) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const dogfoodIncident = detectPlannerDogfoodIncident(goalText, files);
  if (dogfoodIncident.active) {
    return {
      mode: "artifact_review",
      reason: "Planner dogfood false-green incidents need a truth packet plus steward/advisor routing proof before ordinary continuation.",
    };
  }

  if (goalLooksLikeCmsMissingContentIncident(goalText, files)) {
    return {
      mode: "artifact_review",
      reason: "Missing-content CMS incidents need turbulence, raw HTML/DOM, and entity-preservation proof before backend rewrites are considered.",
    };
  }

  if (goalLooksLikeStaticUiDeliverable(goalText, files)) {
    return {
      mode: "manual_observation",
      reason: "Static/UI deliverables naturally prove correctness through structured manual or browser observation.",
    };
  }

  if (goalLooksLikeDocContractChange(goalText, files)) {
    return {
      mode: "contract_test",
      reason: "Documentation-first and workflow-contract changes are best proved with contract tests that lock the promised surface.",
    };
  }

  if (
    goalLooksLikePlannerCoreChange(goalText, files) ||
    files.some((filePath) => filePath.includes("/scripts/") || filePath.endsWith(".mjs") || filePath.endsWith(".js"))
  ) {
    return {
      mode: "behavioral_smoke",
      reason: "Planner-core and orchestration changes are best proved with behavioral smoke tests plus a planner journey check.",
    };
  }

  if (goalNeedsIntentContract(goalText)) {
    return {
      mode: "artifact_review",
      reason: "User-facing deliverables should be proved against substantive artifact quality rather than file existence alone.",
    };
  }

  return {
    mode: "test_evidence",
    reason: "Default code changes should still prove correctness with planned test evidence and passing execution.",
  };
}

export function inferPreflightFlow(goalText, { plannedFiles = [], activePlanPoisoned = false } = {}) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const text = String(goalText || "").toLowerCase();
  const complexSignals = /\b(migration|refactor|cross-system|cross system|shared module|shared modules|multi-file|multiple files|investigate|diagnose|unclear|stabilize)\b/;
  const dogfoodIncident = detectPlannerDogfoodIncident(goalText, files);

  if (dogfoodIncident.active) {
    return {
      mode: "full",
      reason: "Planner dogfood false-green incidents are cross-surface planner-core incidents and must stay in the full flow.",
      confidence: "high",
    };
  }

  if (goalLooksLikeCmsMissingContentIncident(goalText, files)) {
    return {
      mode: "full",
      reason: "WordPress/CMS missing-content incidents are diagnostic-first work and must stay in the full planner flow.",
      confidence: "high",
    };
  }

  if (goalLooksLikeStaticUiDeliverable(goalText, files)) {
    return {
      mode: "lightweight",
      reason: "Static/UI and page-clone work is intentionally routed to the lightweight flow.",
      confidence: "high",
    };
  }

  if (files.length > 0 && files.length <= 3 && files.every((filePath) => looksLikeDocumentationPath(filePath) && !goalLooksLikePlannerCoreChange(goalText, files))) {
    return {
      mode: "lightweight",
      reason: "Small documentation-first changes can stay in the lightweight flow.",
      confidence: "medium",
    };
  }

  if (activePlanPoisoned && goalLooksLikeSimpleTask(goalText, files)) {
    return {
      mode: "lightweight",
      reason: "The remaining work is simple enough to finish in the lightweight flow after recovery.",
      confidence: "high",
    };
  }

  if (
    goalLooksLikePlannerCoreChange(goalText, files) ||
    goalLooksLikeOperationalIntegrationChange(goalText, files) ||
    complexSignals.test(text) ||
    files.length > 3
  ) {
    return {
      mode: "full",
      reason: "Planner-core, shared-surface, migration, or multi-file work should stay in the full iterative planner flow.",
      confidence: "high",
    };
  }

  if (goalLooksLikeSimpleTask(goalText, files)) {
    return {
      mode: "lightweight",
      reason: "The task shape looks small and well-bounded enough for the lightweight flow.",
      confidence: "medium",
    };
  }

  return {
    mode: "full",
    reason: "When task shape is ambiguous, default to the full planner rather than under-classifying risk.",
    confidence: "low",
  };
}

export function inferIntentEvidenceMode(intentAnalysis) {
  const deliverables = Array.isArray(intentAnalysis?.requiredDeliverables)
    ? intentAnalysis.requiredDeliverables
    : [];
  const modes = [...new Set(
    deliverables
      .map((deliverable) => String(deliverable?.evidenceMode || deliverable?.evidence_mode || "").trim().toLowerCase())
      .filter(Boolean)
  )];

  if (modes.length !== 1) return null;

  return {
    mode: modes[0],
    reason: `The active intent contract already declares ${modes[0]} for its required deliverables.`,
    source: "intent_contract",
  };
}

function nextTransitionForState(stateName) {
  const normalized = typeof stateName === "string" ? stateName.trim().toUpperCase() : "";
  if (normalized === "EXPLORE") return "explore-to-plan";
  if (normalized === "PLAN") return "plan-to-execute";
  if (normalized === "EXECUTE") return "execute-to-reflect";
  if (normalized === "REFLECT") return "reflect-to-validate";
  if (normalized === "VALIDATE") return "validate-to-close";
  if (normalized === "CLOSE") return "notify-user";
  return null;
}

export function inferPreflightWorkflow(goalText, {
  plannedFiles = [],
  hasActivePlan = false,
  activePlanPoisoned = false,
  flow = null,
} = {}) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const text = String(goalText || "").toLowerCase();
  const flowInfo = flow || inferPreflightFlow(goalText, { plannedFiles: files, activePlanPoisoned });
  const plannerCore = goalLooksLikePlannerCoreChange(goalText, files);
  const cmsMissingContent = goalLooksLikeCmsMissingContentIncident(goalText, files);
  const dogfoodIncident = detectPlannerDogfoodIncident(goalText, files);
  const sharedSurface = /\b(migration|refactor|cross-system|cross system|shared module|shared modules)\b/.test(text) || files.length > 5;
  const planningOnly = goalLooksLikePlanningOnlyRequest(goalText);
  const programIntake = goalLooksLikeProgramIntakeRequest(goalText);

  if (!String(goalText || "").trim() && !hasActivePlan) {
    return {
      recommended: "/advisor",
      escalation_reason: "missing_goal_context",
      reason: "No explicit goal or active plan context exists yet, so /advisor is the safest triage surface.",
    };
  }

  if (hasActivePlan && !activePlanPoisoned) {
    return {
      recommended: "continue-active-plan",
      escalation_reason: "active_plan_context",
      reason: "An active plan already owns this work, so continue its state machine instead of re-routing it.",
    };
  }

  if (planningOnly) {
    return {
      recommended: "/safe-plan",
      escalation_reason: flowInfo.mode === "full" ? "planning_only_full_flow" : "planning_only_lightweight",
      reason: programIntake
        ? "The request is explicitly planning-only and idea/backlog intake-shaped, so use /safe-plan for the plan and hand off concrete ticket creation to /program-manager."
        : flowInfo.mode === "full"
          ? "The request is explicitly planning-only, so use /safe-plan and keep the work in a full planning flow without crossing into execution."
          : "The request is explicitly planning-only, so use /safe-plan and keep the work in the lightweight planning branch without writing code.",
    };
  }

  if (dogfoodIncident.active) {
    return {
      recommended: "/steward",
      escalation_reason: "planner_dogfood_false_green_incident",
      reason: "Planner dogfood false-green complaints span advisor, steward, ontology/IV, stories, and North Star surfaces, so /steward must consolidate the drift before ordinary continuation.",
    };
  }

  if (cmsMissingContent) {
    return {
      recommended: "/safe-change-power",
      escalation_reason: "cms_missing_content_diagnosis",
      reason: "CMS missing-content incidents need the stronger wrapper so turbulence checks, raw HTML/DOM inspection, and entity-preservation proof stay explicit before backend changes.",
    };
  }

  if (programIntake && !plannerCore && files.length === 0) {
    return {
      recommended: "/program-manager",
      escalation_reason: "program_intake_request",
      reason: "Broad idea, backlog, GitHub issue, or ticket-generation intake belongs in /program-manager so Program Packets, stories, acceptance criteria, verification rows, and ontology evidence become the durable parent surface.",
    };
  }

  if (plannerCore || sharedSurface) {
    return {
      recommended: "/safe-change-power",
      escalation_reason: plannerCore ? "planner_core_shared_surface" : "cross_system_risk",
      reason: "Planner-core, workflow-contract, and other shared-surface changes benefit from /safe-change-power because it preserves the full flow and adds deterministic post-change escalation.",
    };
  }

  return {
    recommended: "/safe-change",
    escalation_reason: flowInfo.mode === "full" ? "full_flow_required" : "none",
    reason: flowInfo.mode === "full"
      ? "Use /safe-change to bootstrap the full planner flow for this bounded but non-trivial change."
      : "Use /safe-change so the lightweight branch can execute the task without unnecessary planner overhead.",
  };
}

export function inferPreflightRecovery(goalText, {
  plannedFiles = [],
  hasActivePlan = false,
  activePlanPoisoned = false,
  activePlanState = null,
  flow = null,
} = {}) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const flowInfo = flow || inferPreflightFlow(goalText, { plannedFiles: files, activePlanPoisoned });
  const nextGate = nextTransitionForState(activePlanState);
  const planningOnly = goalLooksLikePlanningOnlyRequest(goalText);

  if (activePlanPoisoned) {
    return {
      mode: flowInfo.mode === "lightweight" ? "recover_poison_then_lightweight" : "recover_poison_then_full",
      reason: "The active plan is blocked by a poisoned gate tail, so preserve its context before resuming in the correctly sized flow.",
      command: "node .agent/skills/iterative-planner/scripts/bootstrap.mjs recover-poison",
    };
  }

  if (hasActivePlan && nextGate) {
    return {
      mode: "continue_active_plan",
      reason: "The active plan is healthy, so keep moving through its gate chain instead of starting over.",
      command: `node .agent/skills/iterative-planner/scripts/transition.mjs ${nextGate}`,
    };
  }

  if (hasActivePlan) {
    return {
      mode: "continue_active_plan",
      reason: "The active plan already owns this work.",
      command: null,
    };
  }

  if (!String(goalText || "").trim()) {
    return {
      mode: "advisor_triage",
      reason: "Routing needs either a concrete goal or an active plan before the planner can classify the work.",
      command: "/advisor",
    };
  }

  if (flowInfo.mode === "full") {
    return {
      mode: "bootstrap_full_plan",
      reason: planningOnly
        ? "This planning-only request still belongs in the full iterative planner flow before handoff."
        : "This task belongs in the full iterative planner flow.",
      command: "node .agent/skills/iterative-planner/scripts/bootstrap.mjs new \"<goal>\"",
    };
  }

  return {
    mode: "start_lightweight",
    reason: planningOnly
      ? "This planning-only request can use the normal plan spine with scaled obligations."
      : "This task can use the normal plan spine with scaled lightweight obligations.",
    command: planningOnly
      ? "Use normal plan spine via /safe-plan with --planning-only --plan <plan-dir>"
      : "Use normal plan spine with scaled obligations via /safe-change",
  };
}

export function classifyPlannerPreflight(goalText, {
  plannedFiles = [],
  hasActivePlan = false,
  activePlanPoisoned = false,
  activePlanState = null,
  intentAnalysis = null,
} = {}) {
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];
  const dogfoodIncident = detectPlannerDogfoodIncident(goalText, files);
  const flow = inferPreflightFlow(goalText, { plannedFiles: files, activePlanPoisoned });
  const intentEvidence = inferIntentEvidenceMode(intentAnalysis);
  const heuristicEvidence = inferPreflightEvidenceMode(goalText, { plannedFiles: files });
  const evidence = intentEvidence || { ...heuristicEvidence, source: "heuristic" };
  const workflow = inferPreflightWorkflow(goalText, {
    plannedFiles: files,
    hasActivePlan,
    activePlanPoisoned,
    flow,
  });
  const strictness = {
    mode: flow.mode === "full" ? "full" : "lightweight",
    reason: flow.mode === "full"
      ? "Full-plan work keeps the stricter planner and canonicalization contract."
      : "Lightweight work tolerates more formatting variance and relies on bounded proof."
  };
  const recovery = inferPreflightRecovery(goalText, {
    plannedFiles: files,
    hasActivePlan,
    activePlanPoisoned,
    activePlanState,
    flow,
  });

  return {
    flow,
    evidence,
    workflow,
    strictness,
    recovery,
    escalation_reason: workflow.escalation_reason,
    recovery_path: recovery.mode,
    signals: {
      has_active_plan: hasActivePlan,
      active_plan_poisoned: activePlanPoisoned,
      cms_missing_content_incident: goalLooksLikeCmsMissingContentIncident(goalText, files),
      cms_content_edit: goalLooksLikeCmsContentEdit(goalText, files),
      static_ui_deliverable: goalLooksLikeStaticUiDeliverable(goalText, files),
      doc_contract_change: goalLooksLikeDocContractChange(goalText, files),
      planner_core_change: goalLooksLikePlannerCoreChange(goalText, files),
      planner_dogfood_incident: dogfoodIncident.active,
      program_intake_request: goalLooksLikeProgramIntakeRequest(goalText),
      planning_only_request: goalLooksLikePlanningOnlyRequest(goalText),
      simple_task_shape: goalLooksLikeSimpleTask(goalText, files),
      goal_requires_intent_contract: goalNeedsIntentContract(goalText),
      planned_file_count: files.length,
      planned_files_doc_only: files.length > 0 && files.every((filePath) => looksLikeDocumentationPath(filePath) && !looksLikeStaticUiPath(filePath)),
      planned_files_static_ui_only: files.length > 0 && files.every(looksLikeStaticUiPath),
      planned_files_include_runtime: files.some((filePath) => /\.(mjs|cjs|js|jsx|ts|tsx|py|rb|php|go|rs)$/.test(filePath)),
    },
    planner_dogfood_incident: dogfoodIncident,
  };
}

function normalizeIntentId(raw, fallbackPrefix, index) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized && !/^\d/.test(normalized)) return normalized;
  return `${fallbackPrefix}_${index + 1}`;
}

export function goalNeedsIntentContract(goalText) {
  const text = String(goalText || "").toLowerCase();
  if (!text) return false;

  const explicitUserFacingSignals = /\b(user-facing|customer-facing|client-facing|operator-facing|reviewer-facing|analyst-facing|trader-facing|stakeholder-facing|admin-facing|end-user)\b/;
  const audienceSignals = /\b(user|users|persona|personas|customer|customers|client|clients|operator|operators|trader|traders|analyst|analysts|reviewer|reviewers|stakeholder|stakeholders|administrator|administrators|admin|admins)\b/;
  const strongDeliverableSignals = /\b(report|dashboard|export|screen|ui|page|view)\b/;
  const analyticalDeliverableSignals = /\b(backtest|backtesting)\b/;
  const weakDeliverableSignals = /\b(workflow|experience|deliverable|artifact|summary|analysis|result|results|output|ux)\b/;
  const actionSignals = /\b(add|audit|build|clone|copy|create|deliver|design|fix|generate|implement|improve|introduce|mirror|present|produce|recreate|refactor|refresh|replicate|ship|show|surface|update)\b/;
  const internalMaintenanceSignals = /\b(planner|docs?|documentation|migration|internal|shared|helper|helpers|gate|gates|script|scripts|config|configs|determinism|lint|harness|fixture|fixtures|test|tests)\b/;

  const hasExplicitUserFacing = explicitUserFacingSignals.test(text);
  const hasAudience = audienceSignals.test(text);
  const hasStrongDeliverable = strongDeliverableSignals.test(text) ||
    (analyticalDeliverableSignals.test(text) && /\b(report|analysis|results?)\b/.test(text));
  const hasWeakDeliverable = weakDeliverableSignals.test(text);
  const hasAction = actionSignals.test(text);
  const hasInternalMaintenanceContext = internalMaintenanceSignals.test(text);

  if (hasExplicitUserFacing) return true;
  if (hasStrongDeliverable && (hasAudience || hasAction) && !(hasInternalMaintenanceContext && !hasAudience)) {
    return true;
  }
  return hasWeakDeliverable && hasAudience && hasAction;
}

function normalizeDeliverableContract(deliverable, index) {
  const name = firstNonEmptyString(deliverable?.name, deliverable?.title, deliverable?.label);
  const id = normalizeIntentId(
    firstNonEmptyString(deliverable?.id, deliverable?.slug, deliverable?.key, name),
    "deliverable",
    index
  );
  const kind = firstNonEmptyString(deliverable?.kind, deliverable?.type, "artifact")?.toLowerCase() || "artifact";
  const purpose = firstNonEmptyString(
    deliverable?.purpose,
    deliverable?.job_to_be_done,
    deliverable?.use_for,
    deliverable?.why
  );
  const qualityBars = normalizeStringList(
    deliverable?.quality_bars || deliverable?.qualityBars || deliverable?.acceptance_bars
  );
  const requiredSections = normalizeStringList(
    deliverable?.required_sections || deliverable?.sections || deliverable?.required_fields
  );
  const requiredSignals = normalizeStringList(
    deliverable?.required_signals || deliverable?.required_metrics || deliverable?.required_evidence
  );
  const antiGoals = normalizeStringList(
    deliverable?.anti_goals || deliverable?.false_green_patterns || deliverable?.must_not_happen
  );
  const evidenceMode = firstNonEmptyString(
    deliverable?.evidence_mode,
    deliverable?.verification_mode,
    deliverable?.mode,
    "artifact_review"
  ) || "artifact_review";
  const required = deliverable?.required !== false;

  const missing = [];
  if (!name) missing.push("name");
  if (!purpose) missing.push("purpose");
  if (
    qualityBars.length === 0 &&
    requiredSections.length === 0 &&
    requiredSignals.length === 0 &&
    antiGoals.length === 0
  ) {
    missing.push("quality_contract");
  }

  return {
    id,
    name,
    kind,
    required,
    purpose,
    qualityBars,
    requiredSections,
    requiredSignals,
    antiGoals,
    evidenceMode,
    missing,
  };
}

export function loadIntentContract(planDir) {
  const contractPath = join(planDir, "intent_contract.json");
  const workOrderInfo = loadPlanWorkOrder(planDir);
  if (workOrderInfo.present && workOrderInfo.error) {
    return {
      path: workOrderInfo.path,
      legacy_path: contractPath,
      present: true,
      parsed: null,
      error: `${workOrderInfo.error}: ${workOrderInfo.validation?.errors?.map((entry) => `${entry.path}: ${entry.message}`).join("; ") || "unreadable work_order.json"}`,
      source: "work_order_projection",
    };
  }

  const present = existsSync(contractPath);
  const parsed = present ? safeReadJson(contractPath) : null;
  const projected = getIntentContractProjection(workOrderInfo.parsed);
  if (
    projected &&
    parsed &&
    typeof parsed === "object" &&
    shouldPreferLegacyIntentContract({
      contractPath,
      legacy: parsed,
      workOrderPath: workOrderInfo.path,
      projection: projected,
    })
  ) {
    return {
      path: contractPath,
      work_order_path: workOrderInfo.path,
      present: true,
      parsed,
      error: null,
      source: "legacy_intent_contract",
      projection_shadowed: true,
    };
  }

  if (projected) {
    return {
      path: workOrderInfo.path,
      legacy_path: contractPath,
      present: true,
      parsed: projected,
      error: null,
      source: "work_order_projection",
    };
  }

  if (!present) {
    return { path: contractPath, present: false, parsed: null, error: null, source: "legacy_intent_contract" };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      path: contractPath,
      present: true,
      parsed: null,
      error: "Malformed JSON in intent_contract.json",
      source: "legacy_intent_contract",
    };
  }

  return { path: contractPath, present: true, parsed, error: null, source: "legacy_intent_contract" };
}

function safeStatMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function intentContractHasContent(contract) {
  if (!contract || typeof contract !== "object") return false;
  if (firstNonEmptyString(contract.primary_user, contract.user, contract.actor, contract.intended_user)) return true;
  if (firstNonEmptyString(contract.job_to_be_done, contract.job, contract.intent, contract.user_need)) return true;
  if (normalizeStringList(contract.desired_outcomes || contract.outcomes || contract.success_outcomes).length > 0) return true;
  if (normalizeStringList(contract.anti_goals || contract.false_green_patterns || contract.must_not_happen).length > 0) return true;
  if (normalizeStringList(contract.constraints || contract.guardrails || contract.non_goals).length > 0) return true;
  return Array.isArray(contract.deliverables) && contract.deliverables.length > 0;
}

function shouldPreferLegacyIntentContract({ contractPath, legacy, workOrderPath, projection }) {
  if (!legacy || typeof legacy !== "object") return false;
  if (!intentContractHasContent(projection)) return true;

  const legacyMtimeMs = safeStatMs(contractPath);
  const workOrderMtimeMs = safeStatMs(workOrderPath);
  return legacyMtimeMs !== null && workOrderMtimeMs !== null && legacyMtimeMs > workOrderMtimeMs + 1;
}

export function analyzeIntentContract(contract, { goalText = "" } = {}) {
  const parsed = contract && typeof contract === "object" ? contract : null;
  const primaryUser = firstNonEmptyString(
    parsed?.primary_user,
    parsed?.user,
    parsed?.actor,
    parsed?.intended_user
  );
  const jobToBeDone = firstNonEmptyString(
    parsed?.job_to_be_done,
    parsed?.job,
    parsed?.intent,
    parsed?.user_need
  );
  const desiredOutcomes = normalizeStringList(
    parsed?.desired_outcomes || parsed?.outcomes || parsed?.success_outcomes
  );
  const antiGoals = normalizeStringList(
    parsed?.anti_goals || parsed?.false_green_patterns || parsed?.must_not_happen
  );
  const constraints = normalizeStringList(parsed?.constraints || parsed?.guardrails || parsed?.non_goals);
  const deliverables = Array.isArray(parsed?.deliverables)
    ? parsed.deliverables.map((deliverable, index) => normalizeDeliverableContract(deliverable, index))
    : [];
  const requiredDeliverables = deliverables.filter((deliverable) => deliverable.required);
  const requiredByGoal = goalNeedsIntentContract(goalText) || requiredDeliverables.length > 0;

  const missingCoreFields = [];
  if (!primaryUser) missingCoreFields.push("primary_user");
  if (!jobToBeDone) missingCoreFields.push("job_to_be_done");
  if (desiredOutcomes.length === 0) missingCoreFields.push("desired_outcomes");
  if (requiredByGoal && requiredDeliverables.length === 0) {
    missingCoreFields.push("deliverables");
  }
  if (antiGoals.length === 0 && requiredDeliverables.length === 0) {
    missingCoreFields.push("deliverables_or_anti_goals");
  }

  return {
    present: !!parsed,
    parsed,
    goalText,
    requiredByGoal,
    primaryUser,
    jobToBeDone,
    desiredOutcomes,
    antiGoals,
    constraints,
    deliverables,
    requiredDeliverables,
    missingCoreFields,
    meaningful: missingCoreFields.length === 0,
    missingDeliverableContracts: requiredDeliverables.filter((deliverable) => deliverable.missing.length > 0),
    deliverablesMissingAntiGoals: requiredDeliverables.filter((deliverable) => deliverable.antiGoals.length === 0),
  };
}

function writeAtomicText(path, content) {
  const observed = observeOwnedFile(path);
  const replacement = replaceOwnedFile({
    path,
    bytes: content,
    expected: observed.status === "present" ? observed.token : null,
  });
  if (replacement.status !== "committed") {
    throw new Error(`owned text write ${replacement.status}: ${replacement.reason}`);
  }
  const finalization = finalizeOwnedFileReplace(replacement);
  if (finalization.status !== "committed") {
    throw new Error(`owned text write cleanup_pending: ${finalization.reason}`);
  }
  return replacement;
}

function canonicalizePath(path) {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path);
  } catch {
    return resolve(path);
  }
}

function toProjectRelative(projectRoot, targetPath) {
  const normalizedRoot = canonicalizePath(projectRoot);
  const normalizedTarget = canonicalizePath(targetPath);
  const rootPrefix = `${normalizedRoot}/`;
  if (normalizedTarget === normalizedRoot) return ".";
  if (normalizedTarget.startsWith(rootPrefix)) {
    return normalizedTarget.slice(rootPrefix.length).replace(/\\/g, "/");
  }
  return normalizedTarget.replace(/\\/g, "/");
}

function normalizeTrackedPath(projectRoot, rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  try {
    return canonicalizePath(resolve(projectRoot, rawPath));
  } catch {
    return null;
  }
}

function extractPlanDirNameFromPath(projectRoot, trackedPath) {
  const relativePath = toProjectRelative(projectRoot, trackedPath);
  const match = relativePath.match(/^plans\/(plan_[^/]+)(?:\/|$)/);
  return match ? { planDirName: match[1], relativePath } : null;
}

function readGoalFromPlan(planDir, fallbackState) {
  if (typeof fallbackState?.goal === "string" && fallbackState.goal.trim()) {
    return fallbackState.goal.trim();
  }
  const planContent = readFile(join(planDir, "plan.md"));
  if (!planContent) return null;
  const match = planContent.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return match ? match[1].trim() : null;
}

function buildActivePlanAliasPayload(plansDir, planDirName, planDir, stateJson) {
  const projectRoot = dirname(plansDir);
  const generatedAt = new Date().toISOString();
  const aliasPaths = getActivePlanAliasPaths(plansDir);

  if (!planDirName || !planDir || !existsSync(planDir)) {
    return {
      generated_at: generatedAt,
      active: false,
      source_of_truth: "plans/.current_plan",
      aliases: {
        markdown: toProjectRelative(projectRoot, aliasPaths.markdown),
        json: toProjectRelative(projectRoot, aliasPaths.json),
      },
      recovery: {
        command: 'node .agent/skills/iterative-planner/scripts/bootstrap.mjs new "<goal>"',
        note: "If your IDE is open on another plans/plan_* directory, treat it as historical context only.",
      },
    };
  }

  const goal = readGoalFromPlan(planDir, stateJson) || "(goal unavailable)";
  const state = typeof stateJson?.state === "string" ? stateJson.state.toUpperCase() : "UNKNOWN";
  const files = {
    state: `plans/${planDirName}/state.md`,
    plan: `plans/${planDirName}/plan.md`,
    progress: `plans/${planDirName}/progress.md`,
    decisions: `plans/${planDirName}/decisions.md`,
    findings: `plans/${planDirName}/findings.md`,
    findings_ledger: `plans/${planDirName}/findings_ledger.json`,
    intent_contract: `plans/${planDirName}/intent_contract.json`,
    verification: `plans/${planDirName}/verification.md`,
  };

  return {
    generated_at: generatedAt,
    active: true,
    source_of_truth: "plans/.current_plan",
    plan_dir_name: planDirName,
    plan_dir: `plans/${planDirName}`,
    state,
    goal,
    aliases: {
      markdown: toProjectRelative(projectRoot, aliasPaths.markdown),
      json: toProjectRelative(projectRoot, aliasPaths.json),
    },
    files,
    guard_rail: "If your IDE is showing a different plans/plan_* directory, switch back to these files before editing or running a gate.",
  };
}

function buildActivePlanAliasMarkdown(payload) {
  if (!payload.active) {
    return `# Active Plan

Updated: ${payload.generated_at}
Source of truth: ${payload.source_of_truth}

No active plan.

## Recovery
- Create one: \`${payload.recovery.command}\`
- ${payload.recovery.note}
`;
  }

  return `# Active Plan

Updated: ${payload.generated_at}
Source of truth: ${payload.source_of_truth}

## Current
- Plan directory: \`${payload.plan_dir}\`
- State: \`${payload.state}\`
- Goal: ${payload.goal}

## Canonical Files
- \`${payload.files.state}\`
- \`${payload.files.plan}\`
- \`${payload.files.progress}\`
- \`${payload.files.decisions}\`
- \`${payload.files.findings}\`
- \`${payload.files.findings_ledger}\`
- \`${payload.files.intent_contract}\`
- \`${payload.files.verification}\`

## Guard Rails
- ${payload.guard_rail}
- Machine-readable alias: \`${payload.aliases.json}\`
`;
}

export function getActivePlanAliasPaths(plansDir) {
  return {
    markdown: join(plansDir, ACTIVE_PLAN_MARKDOWN),
    json: join(plansDir, ACTIVE_PLAN_JSON),
  };
}

/**
 * Write canonical active-plan alias files for IDEs and agents.
 * Mirrors plans/.current_plan and never becomes a second source of truth.
 */
export function syncActivePlanAlias(plansDir, opts = {}) {
  if (!existsSync(plansDir)) {
    return { synced: false, reason: "plans_dir_missing" };
  }

  let planDirName = opts.planDirName || null;
  let planDir = opts.planDir || null;
  if (!planDirName || !planDir) {
    const active = getActivePlan(plansDir, { exitOnMissing: false });
    planDirName = active.planDirName;
    planDir = active.planDir;
  }

  const stateJson = opts.stateJson || (planDir ? safeReadJson(join(planDir, "state.json")) : null);
  const payload = buildActivePlanAliasPayload(plansDir, planDirName, planDir, stateJson);
  const aliasPaths = getActivePlanAliasPaths(plansDir);

  try {
    writeAtomicText(aliasPaths.markdown, buildActivePlanAliasMarkdown(payload) + "\n");
    writeAtomicText(aliasPaths.json, JSON.stringify(payload, null, 2) + "\n");
    return {
      synced: true,
      active: payload.active,
      planDirName: payload.plan_dir_name || null,
      aliasPaths,
    };
  } catch (error) {
    debugLog("plan_utils", `Active plan alias sync failed: ${error.message}`);
    return {
      synced: false,
      active: payload.active,
      planDirName: payload.plan_dir_name || null,
      aliasPaths,
      reason: error.message,
    };
  }
}

function dedupeTraceHits(hits) {
  const seen = new Set();
  const unique = [];
  for (const hit of hits) {
    const key = `${hit.tool}|${hit.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

/**
 * Inspect recent tool-trace activity for reads or edits against non-active plans.
 * Reads warn; edits/writes are eligible to block transitions.
 */
export function detectRecentNonActivePlanContext(plansDir, planDirName, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : NON_ACTIVE_PLAN_TRACE_LIMIT;
  const planDir = join(plansDir, planDirName || "");
  const tracePath = join(planDir, "artifacts", "tool_trace.jsonl");
  const projectRoot = dirname(plansDir);

  if (!planDirName || !existsSync(tracePath)) {
    return {
      traceAvailable: false,
      activePlanDirName: planDirName || null,
      tracePath: toProjectRelative(projectRoot, tracePath),
      recentEntriesScanned: 0,
      limit,
      reads: [],
      writes: [],
      warned: false,
      blocked: false,
    };
  }

  let entries = [];
  try {
    entries = readFileSync(tracePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (error) {
    debugLog("plan_utils", `Recent non-active plan trace scan failed: ${error.message}`);
    return {
      traceAvailable: false,
      activePlanDirName: planDirName,
      tracePath: toProjectRelative(projectRoot, tracePath),
      recentEntriesScanned: 0,
      limit,
      reads: [],
      writes: [],
      warned: false,
      blocked: false,
    };
  }

  const recentEntries = entries.slice(-limit);
  const staleHits = [];
  for (const entry of recentEntries) {
    const tool = typeof entry?.tool === "string" ? entry.tool : "unknown";
    const isWrite = NON_ACTIVE_PLAN_WRITE_TOOLS.has(tool);
    const isRead = isWrite || NON_ACTIVE_PLAN_READ_TOOLS.has(tool);
    if (!isRead) continue;

    const rawPaths = Array.isArray(entry?.paths) ? entry.paths : [];
    for (const rawPath of rawPaths) {
      const normalizedPath = normalizeTrackedPath(projectRoot, rawPath);
      if (!normalizedPath) continue;
      const planMatch = extractPlanDirNameFromPath(projectRoot, normalizedPath);
      if (!planMatch || planMatch.planDirName === planDirName) continue;

      staleHits.push({
        kind: isWrite ? "write" : "read",
        tool,
        seq: typeof entry.seq === "number" ? entry.seq : null,
        planDirName: planMatch.planDirName,
        path: planMatch.relativePath,
      });
    }
  }

  const writes = dedupeTraceHits(staleHits.filter((hit) => hit.kind === "write"));
  const reads = dedupeTraceHits(staleHits.filter((hit) => hit.kind === "read"));
  return {
    traceAvailable: true,
    activePlanDirName: planDirName,
    tracePath: toProjectRelative(projectRoot, tracePath),
    recentEntriesScanned: recentEntries.length,
    limit,
    reads,
    writes,
    warned: reads.length > 0 || writes.length > 0,
    blocked: writes.length > 0,
    affectedPlans: [...new Set(staleHits.map((hit) => hit.planDirName))],
  };
}

function formatTraceHit(hit) {
  return `${hit.tool} → ${hit.path}`;
}

/**
 * Render a deterministic human-readable detail string for stale-plan context.
 */
export function formatNonActivePlanContextDetail(signal, aliasPath = "plans/ACTIVE_PLAN.md") {
  if (!signal?.warned) return "";

  const segments = [`active plan: plans/${signal.activePlanDirName}`];
  if (signal.writes?.length > 0) {
    const sample = signal.writes.slice(0, 2).map(formatTraceHit).join("; ");
    const extra = signal.writes.length > 2 ? ` (+${signal.writes.length - 2} more)` : "";
    segments.push(`recent non-active plan edits: ${sample}${extra}`);
  }
  if (signal.reads?.length > 0) {
    const sample = signal.reads.slice(0, 2).map(formatTraceHit).join("; ");
    const extra = signal.reads.length > 2 ? ` (+${signal.reads.length - 2} more)` : "";
    segments.push(`recent non-active plan reads: ${sample}${extra}`);
  }
  segments.push(`open ${aliasPath} and switch back before continuing`);
  return segments.join(" | ");
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Read a file safely. Returns content string, or null when the file is
 * absent. F-009 mitigation: non-ENOENT errors (permission denied, IO error,
 * etc.) are debug-logged before returning null so silent IO failures cannot
 * masquerade as "file not present" to callers that conflate the two.
 *
 * Callers that need strict semantics (throw on any error) should use
 * `readFileSync` directly. This helper preserves the "best effort" contract
 * the 47 plan.md readers depend on.
 */
export function readFile(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      debugLog("plan_utils", `readFile(${path}) failed with non-ENOENT error: ${err.code || ""} ${err.message}`);
    }
    return null;
  }
}

/**
 * Check if a file exists.
 */
export function fileExists(path) {
  return existsSync(path);
}

/**
 * Check if a file exists and has meaningful content (beyond markdown boilerplate).
 */
export function fileNotEmpty(path) {
  if (!existsSync(path)) return false;
  const content = readFile(path);
  if (!content) return false;
  // RT3-L5-FIX: Allow lines starting with "*" (markdown unordered lists).
  // Previously fileNotEmpty filtered out "* item" lines, incorrectly rejecting
  // files with substantive markdown list content.
  const lines = content.split("\n").filter(
    (l) => l.trim() && !l.startsWith("#") && !l.startsWith("---")
  );
  return lines.length > 0;
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/**
 * Count ## headings in markdown content.
 */
export function countH2Headings(content) {
  if (!content) return 0;
  const matches = content.match(/^## /gm);
  return matches ? matches.length : 0;
}

/**
 * Check if content contains a string.
 */
export function containsString(content, str) {
  if (!content) return false;
  return content.includes(str);
}

/**
 * Extract a field from content using a regex pattern.
 * Returns the first capture group, or null.
 */
export function extractField(content, pattern) {
  if (!content) return null;
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

const RED_TEAM_REQUIRED_SECTIONS = ["attack", "impact", "mitigation"];
const RED_TEAM_PLACEHOLDER_PATTERNS = [
  /\[tbd\]/i,
  /\btbd\b/i,
  /^\s*replace this\b/i,
  /^\s*todo\b/i,
  /^\s*describe\b/i,
  /^\s*what damage would occur\b/i,
  /^\s*how the code handles this\b/i,
  /^\s*how it handles this\b/i,
];

function stripInlineMarkdown(text) {
  return String(text || "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

function normalizeRedTeamContentLine(line) {
  const trimmed = String(line || "").trim().replace(/^[-*]\s+/, "");
  return stripInlineMarkdown(trimmed);
}

function countWords(text) {
  return (String(text || "").match(/[A-Za-z0-9][A-Za-z0-9'/_-]*/g) || []).length;
}

function countUniqueWords(text) {
  return new Set(
    (String(text || "").match(/[A-Za-z0-9][A-Za-z0-9'/_-]*/g) || [])
      .map((word) => word.toLowerCase())
  ).size;
}

function capitalizeWord(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function parseRedTeamSectionLabel(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;

  const patterns = [
    { style: "heading", regex: /^#{1,6}\s*(attack|impact|mitigation)\s*:?\s*(.*)$/i },
    { style: "bold_inline", regex: /^(?:[-*]\s*)?(?:\*\*|__)(attack|impact|mitigation)(?:\*\*|__)\s*:?\s*(.*)$/i },
    { style: "plain", regex: /^(?:[-*]\s*)?(attack|impact|mitigation)\s*:?\s*(.*)$/i },
  ];

  for (const { style, regex } of patterns) {
    const match = trimmed.match(regex);
    if (!match) continue;
    return {
      key: match[1].toLowerCase(),
      style,
      content: normalizeRedTeamContentLine(match[2] || ""),
    };
  }

  return null;
}

function isRedTeamPlaceholderText(text) {
  // Unfilled angle-bracket scaffold marker: the whole answer (after any list
  // marker) is a single "<...>" placeholder, e.g. "<one-paragraph adversarial
  // scenario; name trigger, input, and fault>". A real vector replaces the
  // marker with prose, so a bare <...> answer means the paste-template was never
  // filled in. Checked on the raw text BEFORE markdown stripping (which would
  // remove the angle brackets). False-positive-safe: a genuine attack embeds
  // markup like <script> inside a sentence, so it is never the entire answer.
  const bare = String(text || "").trim().replace(/^[-*\d.)\s]+/, "").trim();
  // A bare "<...>" answer is a placeholder even when decorated with a trailing
  // run of whitespace/punctuation (e.g. "<scenario>.", "<scenario>,",
  // "<scenario>;", "<scenario>...") — these are evasions, not real prose. Allow
  // any trailing whitespace/Unicode-punctuation run, not just a single .!? char.
  if (/^<[^<>]{3,}>[\s\p{P}]*$/u.test(bare)) return true;
  const normalized = stripInlineMarkdown(text).toLowerCase();
  if (!normalized) return false;
  return RED_TEAM_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function analyzeRedTeamVectorSection(section, opts = {}) {
  const minSectionWords = Number.isFinite(opts.minSectionWords) ? opts.minSectionWords : 4;
  const minVectorWords = Number.isFinite(opts.minVectorWords) ? opts.minVectorWords : 15;
  const minSectionUniqueWords = Number.isFinite(opts.minSectionUniqueWords) ? opts.minSectionUniqueWords : 3;
  const minVectorUniqueWords = Number.isFinite(opts.minVectorUniqueWords) ? opts.minVectorUniqueWords : 10;
  const [rawTitle = "", ...rest] = String(section || "").split("\n");
  const title = stripInlineMarkdown(rawTitle.trim());
  const templateTitle = isRedTeamPlaceholderText(title);
  const sectionLines = {
    attack: [],
    impact: [],
    mitigation: [],
  };
  const sectionStyles = {
    attack: null,
    impact: null,
    mitigation: null,
  };
  const freeformLines = [];
  let activeSection = null;

  for (const rawLine of rest) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const label = parseRedTeamSectionLabel(trimmed);
    if (label) {
      activeSection = label.key;
      if (!sectionStyles[activeSection]) sectionStyles[activeSection] = label.style;
      if (label.content) sectionLines[activeSection].push(label.content);
      continue;
    }

    const normalized = normalizeRedTeamContentLine(trimmed);
    if (!normalized) continue;
    if (activeSection) sectionLines[activeSection].push(normalized);
    else freeformLines.push(normalized);
  }

  const sections = {};
  for (const key of RED_TEAM_REQUIRED_SECTIONS) {
    const lines = sectionLines[key].filter(Boolean);
    const text = lines.join(" ");
    const wordCount = countWords(text);
    sections[key] = {
      present: lines.length > 0,
      lines,
      text,
      wordCount,
      uniqueWordCount: countUniqueWords(text),
      placeholder: lines.length > 0 && lines.every((line) => isRedTeamPlaceholderText(line)),
      style: sectionStyles[key],
    };
  }

  const missingSections = RED_TEAM_REQUIRED_SECTIONS.filter((key) => !sections[key].present);
  const placeholderSections = RED_TEAM_REQUIRED_SECTIONS.filter((key) => sections[key].placeholder);
  const terseSections = RED_TEAM_REQUIRED_SECTIONS.filter((key) =>
    sections[key].present &&
    !sections[key].placeholder &&
    sections[key].wordCount < minSectionWords
  );
  const repetitiveSections = RED_TEAM_REQUIRED_SECTIONS.filter((key) =>
    sections[key].present &&
    !sections[key].placeholder &&
    sections[key].wordCount >= minSectionWords &&
    sections[key].uniqueWordCount < minSectionUniqueWords
  );
  const totalText = RED_TEAM_REQUIRED_SECTIONS.map((key) => sections[key].text).filter(Boolean).join(" ");
  const totalWords = countWords(totalText);
  const uniqueWordCount = countUniqueWords(totalText);
  const issues = [];

  if (templateTitle) issues.push("title still uses placeholder text");
  if (missingSections.length > 0) {
    issues.push(`missing ${missingSections.map(capitalizeWord).join(", ")}`);
  }
  for (const key of placeholderSections) {
    issues.push(`${capitalizeWord(key)} still contains template placeholder text`);
  }
  for (const key of terseSections) {
    issues.push(`${capitalizeWord(key)} is too terse (${sections[key].wordCount} words)`);
  }
  for (const key of repetitiveSections) {
    issues.push(`${capitalizeWord(key)} is too repetitive (${sections[key].uniqueWordCount} unique words)`);
  }
  if (
    !templateTitle &&
    missingSections.length === 0 &&
    placeholderSections.length === 0 &&
    totalWords < minVectorWords
  ) {
    issues.push(`only ${totalWords} total words across Attack/Impact/Mitigation`);
  }
  if (
    !templateTitle &&
    missingSections.length === 0 &&
    placeholderSections.length === 0 &&
    totalWords >= minVectorWords &&
    uniqueWordCount < minVectorUniqueWords
  ) {
    issues.push(`only ${uniqueWordCount} unique words across Attack/Impact/Mitigation`);
  }

  return {
    title,
    rawTitle: rawTitle.trim(),
    freeformLines,
    sections,
    hasAttack: sections.attack.present,
    hasImpact: sections.impact.present,
    hasMitigation: sections.mitigation.present,
    templateTitle,
    missingSections,
    placeholderSections,
    terseSections,
    repetitiveSections,
    totalWords,
    uniqueWordCount,
    substantive:
      !templateTitle &&
      missingSections.length === 0 &&
      placeholderSections.length === 0 &&
      terseSections.length === 0 &&
      repetitiveSections.length === 0 &&
      totalWords >= minVectorWords &&
      uniqueWordCount >= minVectorUniqueWords,
    issues,
  };
}

export function analyzeRedTeamNotes(content, opts = {}) {
  const minSectionWords = Number.isFinite(opts.minSectionWords) ? opts.minSectionWords : 4;
  const minVectorWords = Number.isFinite(opts.minVectorWords) ? opts.minVectorWords : 15;
  const minSectionUniqueWords = Number.isFinite(opts.minSectionUniqueWords) ? opts.minSectionUniqueWords : 3;
  const minVectorUniqueWords = Number.isFinite(opts.minVectorUniqueWords) ? opts.minVectorUniqueWords : 10;

  if (!content) {
    return {
      vectorCount: 0,
      vectors: [],
      substantiveVectors: 0,
      vectorsWithMitigation: 0,
      shallowVectors: [],
      placeholderVectors: [],
      missingMitigationVectors: [],
      hasTemplateContent: false,
      minSectionWords,
      minVectorWords,
      minSectionUniqueWords,
      minVectorUniqueWords,
    };
  }

  const vectors = String(content)
    .split(/^## /m)
    .slice(1)
    .filter((section) => section.trim())
    .map((section) => analyzeRedTeamVectorSection(section, {
      minSectionWords,
      minVectorWords,
      minSectionUniqueWords,
      minVectorUniqueWords,
    }));

  return {
    vectorCount: vectors.length,
    vectors,
    substantiveVectors: vectors.filter((vector) => vector.substantive).length,
    vectorsWithMitigation: vectors.filter((vector) => vector.hasMitigation).length,
    shallowVectors: vectors.filter((vector) => !vector.substantive),
    placeholderVectors: vectors.filter((vector) =>
      vector.templateTitle || vector.placeholderSections.length > 0
    ),
    missingMitigationVectors: vectors.filter((vector) => !vector.hasMitigation),
    hasTemplateContent: vectors.some((vector) =>
      vector.templateTitle || vector.placeholderSections.length > 0
    ),
    minSectionWords,
    minVectorWords,
    minSectionUniqueWords,
    minVectorUniqueWords,
  };
}

// ---------------------------------------------------------------------------
// Check result constructor
// ---------------------------------------------------------------------------

const PASS = "PASS";
const WARN = "WARN";
const FAIL = "FAIL";
const SKIP = "SKIP";
const GATE_HISTORY_POISON_THRESHOLD = 5;
const GATE_HISTORY_POISON_MARKER = "GATE_HISTORY_POISONED";

export { PASS, WARN, FAIL, SKIP, GATE_HISTORY_POISON_THRESHOLD, GATE_HISTORY_POISON_MARKER };

/**
 * Create a check result object.
 * @param {string} name - Human-readable check name
 * @param {string} status - PASS, WARN, FAIL, or SKIP
 * @param {string} [detail] - Optional detail message
 * @returns {{ name: string, status: string, detail?: string }}
 */
export function check(name, status, detail) {
  return { name, status, ...(detail ? { detail } : {}) };
}

// ---------------------------------------------------------------------------
// Gate history helpers
// ---------------------------------------------------------------------------

function normalizeStateName(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : null;
}

/**
 * Return the canonical from/to state shape for a gate definition.
 */
export function getGateTransitionShape(gateRegistry, gate) {
  const gateDef = gateRegistry?.[gate];
  const fromStates = gateDef
    ? (Array.isArray(gateDef.from) ? gateDef.from : [gateDef.from])
      .map(normalizeStateName)
      .filter(Boolean)
    : [];
  const toState = normalizeStateName(gateDef?.to);
  return { fromStates, toState };
}

/**
 * True when a transition entry represents an attempt of the specified gate.
 * FAIL entries remain in the source state, so they match when `to` stays inside
 * the gate's source-state set. PASS entries must land in the gate's target state.
 */
export function transitionMatchesGateAttempt(transition, gateRegistry, gate) {
  if (!transition) return false;
  const { fromStates, toState } = getGateTransitionShape(gateRegistry, gate);
  if (fromStates.length === 0) return false;
  const fromState = normalizeStateName(transition.from);
  const toStateObserved = normalizeStateName(transition.to);
  if (!fromStates.includes(fromState)) return false;
  if (normalizeVerificationStatus(transition.gate_result, "gate").kind === "fail") {
    return fromStates.includes(toStateObserved);
  }
  return toState ? toStateObserved === toState : true;
}

/**
 * Summarize the tail of transition history for a specific gate.
 */
export function summarizeGateFailureTail(transitions, gateRegistry, gate, opts = {}) {
  const threshold = opts.threshold ?? GATE_HISTORY_POISON_THRESHOLD;
  const history = Array.isArray(transitions) ? transitions : [];
  let consecutiveFails = 0;
  let lastMatchingAttempt = null;
  const tailEntries = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!transitionMatchesGateAttempt(entry, gateRegistry, gate)) break;
    if (!lastMatchingAttempt) lastMatchingAttempt = entry;
    tailEntries.push(entry);
    if (normalizeVerificationStatus(entry.gate_result, "gate").kind === "fail") {
      consecutiveFails++;
      continue;
    }
    break;
  }

  const failureCodes = Array.from(new Set(
    tailEntries
      .filter((entry) => normalizeVerificationStatus(entry?.gate_result, "gate").kind === "fail")
      .flatMap((entry) => Array.isArray(entry?.failure_codes) ? entry.failure_codes : [])
      .filter(Boolean)
  )).sort();

  return {
    gate,
    threshold,
    consecutiveFails,
    blocked: consecutiveFails >= threshold,
    lastMatchingAttempt,
    tailEntries,
    failureCodes,
  };
}

/**
 * Find all gates whose trailing transition history is blocked by AV-19.
 */
export function findPoisonedGateHistories(transitions, gateRegistry, opts = {}) {
  return Object.keys(gateRegistry || {})
    .map((gate) => summarizeGateFailureTail(transitions, gateRegistry, gate, opts))
    .filter((entry) => entry.blocked);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Print a section header box.
 */
export function printHeader(title, subtitle) {
  console.log();
  console.log(`╔${"═".repeat(56)}╗`);
  console.log(`║  ${title.padEnd(54)}║`);
  if (subtitle) {
    console.log(`║  ${subtitle.padEnd(54)}║`);
  }
  console.log(`╚${"═".repeat(56)}╝`);
  console.log();
}

/**
 * Print a sub-section divider.
 */
export function printSection(title) {
  console.log(`── ${title} ${"─".repeat(Math.max(0, 52 - title.length))}`);
}

/**
 * Print an array of check results and return summary counts.
 * @param {Array<{name: string, status: string, detail?: string}>} results
 * @returns {{ pass: number, warn: number, fail: number, hasFail: boolean }}
 */
export function printResults(results) {
  let pass = 0, warn = 0, fail = 0, skip = 0;
  // T-INTAKE-A0AAAFC1: PASS checks collapse to a single count line; full detail
  // prints only for WARN/FAIL. Display-only — counts and enforcement unchanged.
  // Set PLANNER_VERBOSE_CHECKS=1 to restore per-PASS lines.
  const verbose = process.env.PLANNER_VERBOSE_CHECKS === "1";
  for (const r of results) {
    if (r.status === PASS && !verbose) {
      pass++;
      continue;
    }
    if (r.status === SKIP && !verbose) {
      skip++;
      continue;
    }
    const icon = r.status === PASS ? "✅" : r.status === FAIL ? "❌" : r.status === SKIP ? "⏭️" : "⚠️";
    const code = r.code ? ` [${r.code}]` : "";
    console.log(`  ${icon} [${r.status}]${code} ${r.name}`);
    if (r.detail) {
      console.log(`          ${r.detail}`);
    }
    if (r.status === PASS) pass++;
    else if (r.status === WARN) warn++;
    else if (r.status === SKIP) skip++;
    else fail++;
  }
  if (pass > 0 && !verbose) {
    console.log(`  ✅ ${pass} check${pass === 1 ? "" : "s"} passed (PLANNER_VERBOSE_CHECKS=1 for detail)`);
  }
  if (skip > 0 && !verbose) {
    console.log(`  ⏭️ ${skip} check${skip === 1 ? "" : "s"} skipped (PLANNER_VERBOSE_CHECKS=1 for detail)`);
  }
  return { pass, warn, fail, skip, hasFail: fail > 0 };
}

/**
 * Print summary line and return whether there were failures.
 */
export function printSummary(counts) {
  console.log();
  console.log(`  Summary: ${counts.pass} PASS, ${counts.warn} WARN, ${counts.fail} FAIL${counts.skip ? `, ${counts.skip} SKIP` : ""}`);
  console.log();
  if (counts.hasFail) {
    console.log(`  ══ RESULT: ❌ BLOCKED — fix FAIL items before proceeding ══`);
  } else {
    console.log(`  ══ RESULT: ✅ ALL CHECKS PASSED ══`);
  }
  return counts.hasFail;
}

// ---------------------------------------------------------------------------
// YAML parser (minimal — handles the checklist/analyzer YAML subset)
// ---------------------------------------------------------------------------

/**
 * Parse a simple YAML file with name + items array.
 * Handles our subset: flat key/value items with optional nesting.
 * Does NOT handle arbitrary YAML — only the checklist/analyzer format.
 */
function parseYamlInlineArray(rawValue) {
  const body = String(rawValue || "").trim().slice(1, -1).trim();
  if (!body) return [];

  const values = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote) {
      escaped = true;
      continue;
    }
    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (char === "," && !quote) {
      values.push(token.trim());
      token = "";
      continue;
    }
    token += char;
  }
  if (token.trim()) values.push(token.trim());
  return values.map((value) => parseYamlScalar(value)).filter((value) => value !== "");
}

function parseYamlScalar(rawValue) {
  let value = String(rawValue || "").trim();
  if (value.startsWith("[") && value.endsWith("]")) return parseYamlInlineArray(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

export function parseSimpleYaml(text, opts = {}) {
  const result = { name: "", items: [] };
  const lines = text.split("\n");
  let currentItem = null;
  let currentList = null;
  let currentListKey = null;
  const warnings = [];
  const collectWarnings = opts.collectWarnings === true;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const rawLine = lines[lineNum];
    const line = rawLine.replace(/\r$/, "");

    // Skip comments and empty lines
    if (line.trim().startsWith("#") || line.trim() === "") continue;

    // Top-level name
    const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
    if (nameMatch) {
      result.name = nameMatch[1];
      continue;
    }

    // RT3-H5-FIX: Top-level scalar fields — anchored field name whitelist.
    // Previously any \w+ matched, allowing injection of control fields.
    const KNOWN_SCALARS = new Set(["type", "enabled", "severity", "quick", "description", "version", "mode", "threshold", "timeout"]);
    const topScalar = line.match(/^([a-z_]+):\s*["']?(.+?)["']?\s*$/);
    if (topScalar && KNOWN_SCALARS.has(topScalar[1])) {
      result[topScalar[1]] = parseYamlScalar(topScalar[2]);
      continue;
    }
    if (topScalar && collectWarnings && !KNOWN_SCALARS.has(topScalar[1])) {
      warnings.push(`line ${lineNum + 1}: unsupported top-level key "${topScalar[1]}"`);
      continue;
    }

    // Skip "items:" / "patterns:" / "scan_paths:" etc. list headers
    if (line.match(/^\w+:\s*$/)) {
      currentListKey = line.trim().replace(":", "");
      continue;
    }

    // Top-level list items (for scan_paths, exclude_paths, etc.)
    const topListItem = line.match(/^\s{2}-\s+["']?(.+?)["']?\s*$/);
    if (topListItem && currentListKey && !line.match(/^\s{2}-\s+\w+:/)) {
      if (!result[currentListKey]) result[currentListKey] = [];
      result[currentListKey].push(topListItem[1]);
      continue;
    }

    // New item in items array (starts with "  - key: value")
    // RT4-M6: Whitelist item-level keys to prevent injection of control fields
    const KNOWN_ITEM_KEYS = new Set(["name", "check", "label", "description", "type", "enabled", "severity", "quick", "mode", "threshold", "timeout", "pattern", "path", "gate", "phase", "rule", "id", "title", "status", "file", "gate_result", "string", "min", "command", "max", "field", "equals", "skip_if_path", "skip_if_string", "required_for_shapes"]);
    const itemStart = line.match(/^\s{2}-\s+(\w+):\s*["']?(.+?)["']?\s*$/);
    if (itemStart && KNOWN_ITEM_KEYS.has(itemStart[1])) {
      if (currentItem) result.items.push(currentItem);
      currentItem = { [itemStart[1]]: parseYamlScalar(itemStart[2]) };
      currentList = null;
      continue;
    }

    // Item property (starts with 4+ spaces)
    const KNOWN_ITEM_PROPS = new Set(["name", "check", "label", "description", "type", "enabled", "severity", "quick", "mode", "threshold", "timeout", "pattern", "path", "gate", "phase", "rule", "id", "title", "status", "file", "gate_result", "include", "exclude", "scan_paths", "exclude_paths", "string", "min", "command", "max", "field", "equals", "skip_if_path", "skip_if_string", "required_for_shapes"]);
    const propMatch = line.match(/^\s{4,}(\w+):\s*["']?(.+?)["']?\s*$/);
    if (propMatch && currentItem && KNOWN_ITEM_PROPS.has(propMatch[1])) {
      currentItem[propMatch[1]] = parseYamlScalar(propMatch[2]);
      currentList = null;
      continue;
    }

    // Item list header (e.g., "    include:")
    const itemListHeader = line.match(/^\s{4,}(\w+):\s*$/);
    if (itemListHeader && currentItem && KNOWN_ITEM_PROPS.has(itemListHeader[1])) {
      currentList = itemListHeader[1];
      if (!currentItem[currentList]) currentItem[currentList] = [];
      continue;
    }

    // Item list value (e.g., "      - \"*.js\"")
    const itemListValue = line.match(/^\s{6,}-\s+["']?(.+?)["']?\s*$/);
    if (itemListValue && currentItem && currentList) {
      currentItem[currentList].push(itemListValue[1]);
      continue;
    }

    if (collectWarnings && /^\s{4,}\S/.test(line) && !/\w+:/.test(line.trim())) {
      warnings.push(`line ${lineNum + 1}: possible multiline value not supported by minimal parser: "${line.trim().slice(0, 60)}"`);
      continue;
    }

    if (collectWarnings && line.trim()) {
      warnings.push(`line ${lineNum + 1}: unparsed line (may indicate unsupported YAML syntax): "${line.trim().slice(0, 80)}"`);
    }
  }
  if (currentItem) result.items.push(currentItem);
  if (collectWarnings) result.warnings = warnings;

  return result;
}

// ---------------------------------------------------------------------------
// Glob-like matching (minimal, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Simple glob matcher. Supports: *, **, ?, and brace-less patterns.
 * Not a full POSIX glob — covers the patterns used in our YAML configs.
 */
export function matchGlob(pattern, filepath) {
  // Normalize separators
  const p = pattern.replace(/\\/g, "/");
  const f = filepath.replace(/\\/g, "/");

  // RT3-H6-FIX: Cap pattern length to prevent ReDoS via crafted glob patterns.
  // Patterns like "a*a*a*a*a*b" cause catastrophic regex backtracking.
  if (p.length > 500) return false;

  // Convert glob to regex
  let regex = "^";
  let i = 0;
  while (i < p.length) {
    if (p[i] === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
    } else if (p[i] === "*") {
      regex += "[^/]*";
      i++;
    } else if (p[i] === "?") {
      regex += "[^/]";
      i++;
    } else if (p[i] === ".") {
      regex += "\\.";
      i++;
    } else {
      regex += p[i];
      i++;
    }
  }
  regex += "$";

  // RT3-H6-FIX: Cap generated regex length to prevent complexity explosion
  if (regex.length > 1000) return false;

  try {
    return new RegExp(regex).test(f);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recursive file walker (symlink-safe, respects excludes)
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively, yielding relative paths.
 * @param {string} root - Absolute root directory
 * @param {string[]} [excludePatterns] - Glob patterns to exclude
 * @param {number} [maxFiles=5000] - Safety cap
 * @returns {string[]} Array of relative file paths
 */
export function walkDir(root, excludePatterns = [], maxFiles = 5000) {
  const results = [];
  const defaultExcludes = ["node_modules/**", ".git/**", "__pycache__/**", "vendor/**", "dist/**"];
  const allExcludes = [...defaultExcludes, ...excludePatterns];

  function walk(dir, rel) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied, etc.
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      // Skip symlinks
      // F-021 FIX: Use lstatSync (doesn't follow symlinks) instead of statSync
      try {
        const full = join(dir, entry.name);
        const stat = lstatSync(full, { throwIfNoEntry: false });
        if (!stat) continue;
        if (stat.isSymbolicLink && stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      // Check excludes
      if (allExcludes.some((p) => matchGlob(p, relPath))) continue;

      if (entry.isDirectory()) {
        // Also check directory excludes
        if (allExcludes.some((p) => matchGlob(p, relPath + "/"))) continue;
        walk(join(dir, entry.name), relPath);
      } else {
        results.push(relPath);
      }
    }
  }

  walk(root, "");
  return results;
}

// ---------------------------------------------------------------------------
// Debug logging (RP-009 — replaces silent catch blocks)
// ---------------------------------------------------------------------------

/**
 * Log a message to stderr when DEBUG=1 is set.
 * Use this in catch blocks instead of silently swallowing errors.
 */
export function debugLog(context, message) {
  if (process.env.DEBUG) {
    console.error(`[DEBUG ${context}] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Findings counting (RP-003 — unified logic)
// ---------------------------------------------------------------------------

const STRUCTURAL_FINDINGS_HEADING_PATTERNS = [
  /^index\b/,
  /^key constraints\b/,
  /^corrections\b/,
  /^root cause(?:\b|:)/,
  /^root cause analysis\b/,
  /^root cause verification\b/,
  /^adjacency(?:\b|:)/,
  /^adjacency discovery\b/,
  /^assumption ledger(?:\b|:)/,
  /^story candidates\b/,
  /^existing capability(?: audit)?\b/,
  /^blast radius(?:\b|:)/,
];

function normalizeFindingsHeading(title) {
  return String(title || "").toLowerCase().trim().replace(/^[#*\-\s]+/, "");
}

function isIndexedFindingHeading(title) {
  const normalized = normalizeFindingsHeading(title);
  return /^f-\d+\b/.test(normalized) ||
    /^finding\s+\d+\b/.test(normalized) ||
    /^\d+\.\s+\S/.test(normalized);
}

function isStructuralFindingsHeading(title) {
  if (isIndexedFindingHeading(title)) return false;
  const normalized = normalizeFindingsHeading(title);
  return STRUCTURAL_FINDINGS_HEADING_PATTERNS.some(pattern => pattern.test(normalized));
}

function countIndexEntries(content) {
  if (!content) return 0;
  const indexMatch = content.match(/^## Index[ \t]*$/m);
  if (!indexMatch) return 0;
  const start = indexMatch.index + indexMatch[0].length;
  const nextHeading = content.indexOf("\n## ", start);
  const body = nextHeading >= 0 ? content.slice(start, nextHeading) : content.slice(start);
  const lines = body.split("\n").filter(l => l.trim());
  return lines.filter(l =>
    l.match(/^- \[/) || l.match(/^- \S/) || l.match(/^\d+\.\s+\S/)
  ).length;
}

export function extractIndexedFindingSections(content) {
  if (!content) return [];
  return content
    .split(/^## /m)
    .slice(1)
    .map(section => {
      const [rawTitle = "", ...rest] = section.split("\n");
      const title = rawTitle.trim();
      const contentLines = rest.filter(line => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("#");
      });
      const bodyText = contentLines.join(" ");
      const words = bodyText.match(/[A-Za-z0-9][A-Za-z0-9'/_-]*/g) || [];
      return {
        title,
        contentLines,
        bodyText,
        wordCount: words.length,
        uniqueWordCount: new Set(words.map(w => w.toLowerCase())).size,
        isIndexed: isIndexedFindingHeading(title),
        isStructural: isStructuralFindingsHeading(title),
        isNASection: contentLines.length <= 2 && contentLines.some(line => /\b(?:n\/a|none)\b/i.test(line)),
      };
    })
    .filter(section => section.title && section.isIndexed && !section.isStructural);
}

export function findingsUseFastTrack(content, env = process.env) {
  return env?._PLANNER_FAST_TRACK === "1" || /\[FAST_TRACK\]/.test(content || "");
}

function collectLedgerContentLines(value, out = []) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectLedgerContentLines(entry, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;

  const CONTENT_KEYS = [
    "summary", "detail", "details", "analysis", "body", "description",
    "notes", "observations", "evidence", "rationale", "impact", "why", "text",
    "content", "lines", "finding", "explanation",
  ];
  for (const key of CONTENT_KEYS) {
    if (key in value) collectLedgerContentLines(value[key], out);
  }
  return out;
}

function collectLedgerStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function firstLedgerValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function findLedgerTag(ledger, tagName) {
  const tags = collectLedgerStringList(ledger?.tags).map((tag) => tag.toUpperCase());
  return tags.includes(String(tagName || "").toUpperCase());
}

function normalizeLedgerFinding(entry, index) {
  if (!entry || typeof entry !== "object") return null;

  const id = firstLedgerValue(entry.id, entry.finding_id, entry.key, `F-${String(index + 1).padStart(3, "0")}`);
  const title = firstLedgerValue(entry.title, entry.summary, entry.label, id);
  const contentLines = collectLedgerContentLines(entry);
  const bodyText = contentLines.join(" ");
  const words = bodyText.match(/[A-Za-z0-9][A-Za-z0-9'/_-]*/g) || [];

  return {
    id: String(id || `F-${String(index + 1).padStart(3, "0")}`),
    title: String(title || `Finding ${index + 1}`),
    contentLines,
    bodyText,
    wordCount: words.length,
    uniqueWordCount: new Set(words.map((word) => word.toLowerCase())).size,
    isIndexed: true,
    isStructural: false,
    isNASection: contentLines.length <= 2 && contentLines.some((line) => /\b(?:n\/a|none)\b/i.test(line)),
    storyRefs: collectLedgerStringList(entry.story_refs || entry.stories || entry.story),
    fileRefs: collectLedgerStringList(entry.file_refs || entry.files || entry.file),
    tags: collectLedgerStringList(entry.tags),
    sourceType: firstLedgerValue(entry.source_type, entry.sourceType),
    sourceId: firstLedgerValue(entry.source_id, entry.sourceId),
  };
}

function findingsLedgerUseFastTrack(ledger, env = process.env) {
  return env?._PLANNER_FAST_TRACK === "1" ||
    ledger?.fast_track === true ||
    ledger?.fastTrack === true ||
    findLedgerTag(ledger, "FAST_TRACK");
}

function extractLedgerSections(ledger) {
  const findings = Array.isArray(ledger?.findings) ? ledger.findings : [];
  return findings
    .map((entry, index) => normalizeLedgerFinding(entry, index))
    .filter(Boolean);
}

function extractLedgerText(ledger, sections) {
  const lines = [];
  for (const section of sections) {
    if (section?.title) lines.push(section.title);
    if (Array.isArray(section?.contentLines)) lines.push(...section.contentLines);
  }
  for (const block of [ledger?.root_cause, ledger?.rootCause, ledger?.adjacency, ledger?.blast_radius, ledger?.blastRadius]) {
    collectLedgerContentLines(block, lines);
  }
  return lines.join("\n");
}

export function analyzeFindingsLedger(ledger, { fastTrack = findingsLedgerUseFastTrack(ledger) } = {}) {
  const findingCount = Array.isArray(ledger?.findings) ? ledger.findings.length : 0;
  const sections = extractLedgerSections(ledger);
  const findingWords = sections.reduce((sum, section) => sum + section.wordCount, 0);
  const minWordsPerFinding = fastTrack ? 20 : 50;
  const minSectionWords = fastTrack ? 12 : 30;
  const maxShallowSections = fastTrack ? 1 : 0;
  const shallowSections = sections.filter((section) =>
    !section.isNASection &&
    section.contentLines.length < 3 &&
    section.wordCount < minSectionWords
  );
  const missingDetailedSections = findingCount > 0 && sections.length === 0;
  return {
    fastTrack,
    findingCount,
    sections,
    shallowSections,
    findingWords,
    minWordsPerFinding,
    minSectionWords,
    maxShallowSections,
    missingDetailedSections,
    searchText: extractLedgerText(ledger, sections),
    hasDepth: !missingDetailedSections &&
      findingWords >= findingCount * minWordsPerFinding &&
      shallowSections.length <= maxShallowSections,
  };
}

export function findingsHasRootCause(content) {
  return /root\s*cause/i.test(content || "");
}

export function findingsHasAdjacency(content) {
  return /\[ADJACENCY\]|\badjacency\b/i.test(content || "");
}

export function findingsLedgerHasRootCause(ledger) {
  return collectLedgerContentLines(ledger?.root_cause || ledger?.rootCause).length > 0;
}

export function findingsLedgerHasAdjacency(ledger) {
  return collectLedgerContentLines(ledger?.adjacency || ledger?.blast_radius || ledger?.blastRadius).length > 0;
}

export function extractKbDigestSalt(content) {
  const match = (content || "").match(/\[KB_DIGEST:([0-9a-f]+)\]/i);
  return match ? match[1] : null;
}

export function extractFindingsKbDigestSalt(ledger) {
  const salt = firstLedgerValue(ledger?.kb_digest_salt, ledger?.kbDigestSalt);
  return typeof salt === "string" && salt.trim() ? salt.trim() : null;
}

function renderMarkdownLines(value) {
  return collectLedgerContentLines(value).map((line) => line.trim()).filter(Boolean);
}

function renderFindingsSectionLines(section) {
  const lines = Array.isArray(section?.contentLines)
    ? section.contentLines.map((line) => line.trim()).filter(Boolean)
    : [];

  if (Array.isArray(section?.storyRefs) && section.storyRefs.length > 0) {
    lines.push(`Story refs: ${section.storyRefs.join(", ")}`);
  }
  if (Array.isArray(section?.fileRefs) && section.fileRefs.length > 0) {
    lines.push(`File refs: ${section.fileRefs.join(", ")}`);
  }
  if (Array.isArray(section?.tags) && section.tags.length > 0) {
    lines.push(`Tags: ${section.tags.join(", ")}`);
  }
  if (section?.sourceType || section?.sourceId) {
    const sourceBits = [section.sourceType, section.sourceId].filter(Boolean);
    if (sourceBits.length > 0) lines.push(`Source: ${sourceBits.join(" / ")}`);
  }
  return lines;
}

function normalizeStructuredList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [value];
}

function renderAssumptionLine(entry) {
  if (typeof entry === "string") {
    return `- ${entry.trim()}`;
  }
  if (!entry || typeof entry !== "object") return null;

  const status = firstLedgerValue(entry.status, entry.result, entry.outcome);
  const statement = firstLedgerValue(
    entry.statement,
    entry.summary,
    entry.assumption,
    entry.hypothesis,
    entry.title
  );
  const probe = firstLedgerValue(entry.probe, entry.command, entry.check);
  const notes = firstLedgerValue(entry.notes, entry.detail, entry.details, entry.analysis);
  const outcome = firstLedgerValue(entry.observation, entry.evidence);

  const detailBits = [probe ? `Probe: ${probe}` : null, outcome ? `Observation: ${outcome}` : null, notes ? `Notes: ${notes}` : null]
    .filter(Boolean);
  const head = `${status ? `${String(status).toUpperCase()}: ` : ""}${statement || detailBits.shift() || "(no assumption text recorded)"}`;
  return detailBits.length > 0 ? `- ${head} (${detailBits.join("; ")})` : `- ${head}`;
}

function renderStoryCandidateLine(entry) {
  if (typeof entry === "string") {
    return `- ${entry.trim()}`;
  }
  if (!entry || typeof entry !== "object") return null;
  const title = firstLedgerValue(entry.title, entry.summary, entry.name, entry.label);
  if (!title) return null;
  const priority = firstLedgerValue(entry.priority, entry.severity);
  return priority ? `- ${title} (priority: ${String(priority).toLowerCase()})` : `- ${title}`;
}

function renderSectionBlock(title, lines) {
  const body = (Array.isArray(lines) ? lines : [])
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);
  if (body.length === 0) return null;
  return [`## ${title}`, ...body].join("\n");
}

function findingsLedgerHasNarrativeContent(ledger) {
  if (!ledger || typeof ledger !== "object") return false;
  if (analyzeFindingsLedger(ledger).findingCount > 0) return true;
  const assumptionLines = normalizeStructuredList(ledger?.assumptions).map(renderAssumptionLine).filter(Boolean);
  const storyCandidateLines = normalizeStructuredList(ledger?.story_candidates || ledger?.storyCandidates).map(renderStoryCandidateLine).filter(Boolean);
  const existingCapabilityLines = renderMarkdownLines(ledger?.existing_capabilities || ledger?.existingCapabilities);
  return renderMarkdownLines(ledger?.root_cause || ledger?.rootCause).length > 0 ||
    renderMarkdownLines(ledger?.adjacency || ledger?.blast_radius || ledger?.blastRadius).length > 0 ||
    assumptionLines.length > 0 ||
    storyCandidateLines.length > 0 ||
    existingCapabilityLines.length > 0;
}

export function findingsLedgerHasRenderableContent(ledger) {
  return findingsLedgerHasNarrativeContent(ledger);
}

export function findingsLedgerHasIndexedFindings(ledger) {
  return analyzeFindingsLedger(ledger).findingCount > 0;
}

export function renderFindingsMarkdownFromLedger(ledger) {
  if (!findingsLedgerHasRenderableContent(ledger)) return null;

  const sections = extractLedgerSections(ledger);
  const indexLines = sections.map((section) => `- ${section.id} — ${section.title}`);
  const findingBlocks = sections
    .map((section) => renderSectionBlock(`${section.id}: ${section.title}`, renderFindingsSectionLines(section)))
    .filter(Boolean);

  const blocks = [
    "# Findings",
    "*Summary and index of all findings. Detailed files go in findings/ directory.*",
    "",
    "*Cross-plan context: start with plans/INDEX.md, then use plans/FINDINGS.md and plans/DECISIONS.md for deep dives.*",
    "",
  ];

  if (findingsLedgerUseFastTrack(ledger)) {
    blocks.push("[FAST_TRACK]");
  }
  const kbSalt = extractFindingsKbDigestSalt(ledger);
  if (kbSalt) {
    blocks.push(`[KB_DIGEST:${kbSalt}]`);
  }
  if (blocks[blocks.length - 1] !== "") blocks.push("");

  const indexBlock = renderSectionBlock("Index", indexLines);
  if (indexBlock) blocks.push(indexBlock);

  if (findingBlocks.length > 0) {
    if (blocks[blocks.length - 1] !== "") blocks.push("");
    blocks.push(findingBlocks.join("\n\n"));
  }

  const rootCauseBlock = renderSectionBlock("Root Cause", renderMarkdownLines(ledger?.root_cause || ledger?.rootCause));
  const adjacencyBlock = renderSectionBlock("Adjacency", renderMarkdownLines(ledger?.adjacency || ledger?.blast_radius || ledger?.blastRadius));
  const assumptionBlock = renderSectionBlock(
    "Assumption Ledger",
    normalizeStructuredList(ledger?.assumptions).map(renderAssumptionLine).filter(Boolean)
  );
  const existingCapabilityBlock = renderSectionBlock(
    "Existing Capability Audit",
    renderMarkdownLines(ledger?.existing_capabilities || ledger?.existingCapabilities)
  );
  const storyCandidatesBlock = renderSectionBlock(
    "Story Candidates",
    normalizeStructuredList(ledger?.story_candidates || ledger?.storyCandidates).map(renderStoryCandidateLine).filter(Boolean)
  );

  for (const block of [rootCauseBlock, adjacencyBlock, assumptionBlock, existingCapabilityBlock, storyCandidatesBlock]) {
    if (!block) continue;
    if (blocks[blocks.length - 1] !== "") blocks.push("");
    blocks.push(block);
  }

  return `${blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function loadFindingsLedger(planDir) {
  const ledgerPath = join(planDir, "findings_ledger.json");
  const present = existsSync(ledgerPath);
  if (!present) {
    return { path: ledgerPath, present: false, parsed: null, error: null };
  }

  const parsed = safeReadJson(ledgerPath);
  if (!parsed) {
    return {
      path: ledgerPath,
      present: true,
      parsed: null,
      error: "Malformed JSON in findings_ledger.json",
    };
  }

  return { path: ledgerPath, present: true, parsed, error: null };
}

export function syncFindingsMarkdownFromLedger(planDir, opts = {}) {
  const findingsPath = join(planDir, "findings.md");
  const findingsContent = readFile(findingsPath);
  const ledgerInfo = loadFindingsLedger(planDir);
  const ledger = ledgerInfo.parsed;

  if (!ledgerInfo.present) {
    return {
      synced: false,
      written: false,
      content: findingsContent,
      findingsPath,
      reason: "ledger_missing",
      ledgerInfo,
    };
  }

  if (ledgerInfo.error || !ledger) {
    return {
      synced: false,
      written: false,
      content: findingsContent,
      findingsPath,
      reason: "ledger_invalid",
      ledgerInfo,
    };
  }

  if (!findingsLedgerHasRenderableContent(ledger)) {
    return {
      synced: false,
      written: false,
      content: findingsContent,
      findingsPath,
      reason: "ledger_not_renderable",
      ledgerInfo,
    };
  }

  const ledgerHasFindings = findingsLedgerHasIndexedFindings(ledger);
  const markdownHasFindings = countIndexedFindings(findingsContent) > 0;
  if (!ledgerHasFindings && markdownHasFindings && opts.allowMetadataOnlyOverwrite !== true) {
    return {
      synced: false,
      written: false,
      content: findingsContent,
      findingsPath,
      reason: "markdown_findings_preserved",
      ledgerInfo,
    };
  }

  const rendered = renderFindingsMarkdownFromLedger(ledger);
  if (!rendered) {
    return {
      synced: false,
      written: false,
      content: findingsContent,
      findingsPath,
      reason: "render_failed",
      ledgerInfo,
    };
  }

  const unchanged = findingsContent === rendered || findingsContent === rendered.trimEnd();
  if (!unchanged) {
    writeAtomicText(findingsPath, rendered);
  }

  return {
    synced: true,
    written: !unchanged,
    content: rendered,
    findingsPath,
    reason: unchanged ? "already_synced" : "synced_from_ledger",
    ledgerInfo,
  };
}

export function readFindingsMarkdown(planDir, opts = {}) {
  const syncResult = opts.sync === false
    ? null
    : syncFindingsMarkdownFromLedger(planDir, opts);
  if (typeof syncResult?.content === "string") return syncResult.content;
  return readFile(join(planDir, "findings.md"));
}

function buildMarkdownFindingsSignals(content) {
  if (!content) return null;
  const depth = analyzeFindingsDepth(content);
  return {
    source: "markdown",
    findingCount: countIndexedFindings(content),
    hasRootCause: findingsHasRootCause(content),
    hasAdjacency: findingsHasAdjacency(content),
    kbDigestSalt: extractKbDigestSalt(content),
    searchText: content,
    depth,
  };
}

function buildLedgerFindingsSignals(ledger) {
  if (!ledger || typeof ledger !== "object") return null;
  const depth = analyzeFindingsLedger(ledger);
  return {
    source: "json",
    findingCount: depth.findingCount,
    hasRootCause: findingsLedgerHasRootCause(ledger),
    hasAdjacency: findingsLedgerHasAdjacency(ledger),
    kbDigestSalt: extractFindingsKbDigestSalt(ledger),
    searchText: depth.searchText,
    depth,
    ledger,
  };
}

function compareFindingsSignals(jsonSignals, markdownSignals) {
  const messages = [];
  if (!jsonSignals || !markdownSignals) return { detected: false, messages };

  const comparisons = [
    ["finding count", jsonSignals.findingCount, markdownSignals.findingCount],
    ["depth verdict", jsonSignals.depth.hasDepth, markdownSignals.depth.hasDepth],
    ["fast-track mode", jsonSignals.depth.fastTrack, markdownSignals.depth.fastTrack],
    ["root-cause presence", jsonSignals.hasRootCause, markdownSignals.hasRootCause],
    ["adjacency presence", jsonSignals.hasAdjacency, markdownSignals.hasAdjacency],
  ];

  for (const [label, jsonValue, markdownValue] of comparisons) {
    if (jsonValue !== markdownValue) {
      messages.push(`${label}: findings_ledger.json=${jsonValue} vs findings.md=${markdownValue}`);
    }
  }

  return { detected: messages.length > 0, messages };
}

export function resolveFindingsTruth(planDir) {
  const findingsPath = join(planDir, "findings.md");
  const findingsContent = readFile(findingsPath);
  const ledgerInfo = loadFindingsLedger(planDir);

  const markdown = buildMarkdownFindingsSignals(findingsContent);
  const json = ledgerInfo.parsed ? buildLedgerFindingsSignals(ledgerInfo.parsed) : null;
  const divergence = compareFindingsSignals(json, markdown);
  const expectedEmptyLedgerFallback = ledgerInfo.present && json && json.findingCount === 0 && markdown && markdown.findingCount > 0;

  let source = "none";
  let effective = null;
  if (json && json.findingCount > 0) {
    source = "json";
    effective = json;
  } else if (markdown) {
    source = "markdown";
    effective = markdown;
  } else if (json) {
    source = "json";
    effective = json;
  }

  const issues = [];
  if (ledgerInfo.present && ledgerInfo.error) {
    issues.push("findings_ledger.json is present but malformed — falling back to findings.md when available");
  }
  if (divergence.detected && !expectedEmptyLedgerFallback) {
    issues.push(`Structured findings divergence detected: ${divergence.messages.join("; ")}`);
  }

  return {
    source,
    effective,
    markdown,
    json,
    issues,
    divergence,
    ledgerInfo,
    findingsPath,
    findingsContent,
  };
}

export function analyzeFindingsDepth(content, { fastTrack = findingsUseFastTrack(content) } = {}) {
  const findingCount = countIndexedFindings(content);
  const sections = extractIndexedFindingSections(content);
  const findingWords = sections.reduce((sum, section) => sum + section.wordCount, 0);
  const minWordsPerFinding = fastTrack ? 20 : 50;
  const minSectionWords = fastTrack ? 12 : 30;
  const maxShallowSections = fastTrack ? 1 : 0;
  const shallowSections = sections.filter(section =>
    !section.isNASection &&
    section.contentLines.length < 3 &&
    section.wordCount < minSectionWords
  );
  const missingDetailedSections = findingCount > 0 && sections.length === 0;
  return {
    fastTrack,
    findingCount,
    sections,
    shallowSections,
    findingWords,
    minWordsPerFinding,
    minSectionWords,
    maxShallowSections,
    missingDetailedSections,
    hasDepth: !missingDetailedSections &&
      findingWords >= findingCount * minWordsPerFinding &&
      shallowSections.length <= maxShallowSections,
  };
}

/**
 * Count indexed findings in a findings.md content string.
 * Supports either bullet entries under `## Index` or self-contained indexed
 * `## F-001` / `## Finding 1` / `## 1.` sections.
 */
export function countIndexedFindings(content) {
  if (!content) return 0;
  const indexCount = countIndexEntries(content);
  if (indexCount > 0) return indexCount;
  return extractIndexedFindingSections(content).length;
}

// ---------------------------------------------------------------------------
// Path matching (RP-010 — replaces substring matching)
// ---------------------------------------------------------------------------

/**
 * Check if a file path contains a directory segment matching the pattern.
 * Unlike str.includes(), this matches whole path segments only.
 * @param {string} filePath - e.g. "src/lib/utils.mjs"
 * @param {string} segment - e.g. "lib" (directory name to match)
 * @returns {boolean}
 */
export function matchesPathSegment(filePath, segment) {
  const parts = filePath.replace(/\\/g, "/").split("/");
  // For directory patterns (ending with /), match directory segments
  const seg = segment.replace(/\/$/, "");
  return parts.some(p => p === seg);
}

/**
 * Check if a file path matches a code_ref by basename comparison.
 * Handles code_refs like "scripts/rule_engine.mjs:cmdFoo" (strips after colon).
 * @param {string} filePath - changed file path
 * @param {string} codeRef - code_ref from story registry
 * @returns {boolean}
 */
export function matchesBasename(filePath, codeRef) {
  const refFile = codeRef.split(":")[0];
  // Match if basenames are equal OR if one path ends with the other
  const fpBase = filePath.replace(/\\/g, "/").split("/").pop();
  const refBase = refFile.replace(/\\/g, "/").split("/").pop();
  // RP-016: Segment-bounded suffix prevents "plan_utils.mjs" matching "utils.mjs".
  return fpBase === refBase || filePath.endsWith("/" + refFile) || refFile.endsWith("/" + filePath);
}

// ---------------------------------------------------------------------------
// Output normalization (Determinism Hardening — DH-004)
// ---------------------------------------------------------------------------

/**
 * Normalize a check result for consistent, reproducible output.
 * Strips trailing whitespace, normalizes line endings.
 */
export function normalizeResult(result) {
  return {
    ...result,
    name: result.name ? result.name.trim() : result.name,
    detail: result.detail ? result.detail.trim() : result.detail,
  };
}

/**
 * Format a check result as a single deterministic string.
 * Includes failure code when present.
 * @param {{ name: string, status: string, detail?: string, code?: string }} result
 * @returns {string}
 */
export function formatResult(result) {
  const icon = result.status === PASS ? "✅" : result.status === FAIL ? "❌" : result.status === SKIP ? "⏭️" : "⚠️";
  const codeStr = result.code ? ` [${result.code}]` : "";
  let line = `  ${icon} [${result.status}]${codeStr} ${result.name}`;
  if (result.detail) {
    line += `\n          ${result.detail}`;
  }
  return line;
}

/**
 * Print an array of check results with normalized, deterministic formatting.
 * Includes failure codes when present.
 * @param {Array<{name: string, status: string, detail?: string, code?: string}>} results
 * @returns {{ pass: number, warn: number, fail: number, hasFail: boolean, codes: string[] }}
 */
export function printResultsWithCodes(results) {
  let pass = 0, warn = 0, fail = 0, skip = 0;
  const codes = [];
  // T-INTAKE-A0AAAFC1: PASS collapses to a count line (see printResults).
  const verbose = process.env.PLANNER_VERBOSE_CHECKS === "1";
  for (const r of results) {
    if (r.status === PASS && !verbose) {
      pass++;
      continue;
    }
    if (r.status === SKIP && !verbose) {
      skip++;
      continue;
    }
    console.log(formatResult(r));
    if (r.status === PASS) pass++;
    else if (r.status === WARN) warn++;
    else if (r.status === SKIP) skip++;
    else { fail++; if (r.code) codes.push(r.code); }
  }
  if (pass > 0 && !verbose) {
    console.log(`  ✅ ${pass} check${pass === 1 ? "" : "s"} passed (PLANNER_VERBOSE_CHECKS=1 for detail)`);
  }
  if (skip > 0 && !verbose) {
    console.log(`  ⏭️ ${skip} check${skip === 1 ? "" : "s"} skipped (PLANNER_VERBOSE_CHECKS=1 for detail)`);
  }
  return { pass, warn, fail, skip, hasFail: fail > 0, codes };
}

/**
 * Print summary line with optional failure codes.
 */
export function printSummaryWithCodes(counts) {
  console.log();
  console.log(`  Summary: ${counts.pass} PASS, ${counts.warn} WARN, ${counts.fail} FAIL${counts.skip ? `, ${counts.skip} SKIP` : ""}`);
  if (counts.codes && counts.codes.length > 0) {
    console.log(`  Failure codes: ${counts.codes.join(", ")}`);
  }
  console.log();
  if (counts.hasFail) {
    console.log(`  ══ RESULT: ❌ BLOCKED — fix FAIL items before proceeding ══`);
  } else {
    console.log(`  ══ RESULT: ✅ ALL CHECKS PASSED ══`);
  }
  return counts.hasFail;
}
