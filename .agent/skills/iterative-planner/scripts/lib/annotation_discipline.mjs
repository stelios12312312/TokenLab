// annotation_discipline.mjs — Phase A.1 of plans/proposals/proactive-ontology.md
//
// @planner:module = annotation_discipline
// @planner:capability = annotation_discipline_check
// @planner:story_id = _planner_infra
//
// Hard-gate analyzer for `@planner:` annotation discipline at plan-to-execute.
//
// Contract:
//   - Read the plan's `## Files To Modify` list.
//   - Filter to annotation-worthy paths (default: scripts/, lib/, src/,
//     services/; configurable via PLANNER_ANNOTATION_WORTHY_GLOBS).
//   - For each annotation-worthy file that exists on disk:
//       - PASS if `parseAnnotations()` finds >=1 valid @planner: annotation
//         and at least one minimum identity annotation (`module` or
//         `capability`)
//       - PASS if plan.md declares a non-placeholder waiver of shape
//         `[KB_NOT_APPLICABLE: annotation: <path>: <reason>]`
//       - PASS (EXEMPT) if the file exists in git HEAD and that committed
//         baseline had no valid identity annotation. This preserves the
//         legacy-unannotated exception without allowing an established
//         identity annotation to be silently removed or downgraded.
//       - FAIL if git HEAD established a valid identity annotation and the
//         working tree no longer has one.
//       - FAIL as net-new if git cannot positively read the HEAD path.
//       - FAIL otherwise (a NET-NEW file exists, is unannotated, and unwaived)
//   - Files in the plan that don't yet exist on disk are SKIPPED (the
//     plan hasn't been executed yet; no annotation can exist for a file
//     that hasn't been written). They become relevant once the file exists
//     and the plan-to-execute gate is evaluated again.
//
// The analyzer is read-only and pure-ish: same plan content + same disk state
// produces the same diagnosis. Callers decide whether to FAIL the gate or
// surface as warning.

import { existsSync, readFileSync } from "fs";
import { extname } from "path";
import { execFileSync } from "child_process";

import { extractFilesToModify } from "./plan_utils.mjs";
import {
  parseAnnotations,
  parseAnnotationsFromContent,
} from "../annotation_parser.mjs";

const DEFAULT_WORTHY_PREFIXES = [
  "scripts/",
  "src/",
  "lib/",
  "services/",
  ".agent/skills/iterative-planner/scripts/",
  ".agent/skills/iterative-planner/scripts/lib/",
];

// Extensions the annotation_parser actually understands. A file with an
// unsupported extension can't carry a `@planner:` comment so we never
// fail-gate on it (e.g. JSON config, markdown docs).
const ANNOTATABLE_EXTENSIONS = new Set([
  ".py", ".js", ".mjs", ".ts", ".tsx", ".pl", ".rs", ".go", ".rb", ".sh",
  ".yaml", ".yml", ".toml", ".r", ".jl", ".php", ".java", ".c", ".cpp",
  ".h", ".swift", ".kt",
]);

// Reasons that LOOK like real text but are scaffolds/placeholders. Same shape
// as plan_utils.RED_TEAM_PLACEHOLDER_PATTERNS; intentionally narrow so a real
// reason like "test fixture; intentionally generated" passes.
const WAIVER_REASON_PLACEHOLDER_PATTERNS = [
  /^\s*tbd\b/i,
  /^\s*\[tbd\]/i,
  /^\s*todo\b/i,
  /^\s*<[A-Za-z][^>]{0,200}>\s*$/,
  /^\s*\[fill\b/i,
  /^\s*placeholder\b/i,
  /^\s*reason here\b/i,
];

const WAIVER_LINE_RE =
  /\[KB_NOT_APPLICABLE:\s*annotation:\s*([^:\]]+?):\s*([^\]]+?)\]/gi;

export function parseAnnotationWaivers(planContent) {
  // Returns { path -> { reason, placeholder } } for every waiver line found.
  // Bad-shape waivers (placeholder reason) are returned with placeholder=true
  // so the caller can surface them as failures rather than silently pass.
  const out = new Map();
  if (typeof planContent !== "string") return out;
  let match;
  WAIVER_LINE_RE.lastIndex = 0;
  while ((match = WAIVER_LINE_RE.exec(planContent)) !== null) {
    const path = normalizeAnnotationPath(match[1]);
    const reason = String(match[2] || "").trim();
    if (!path) continue;
    const placeholder = WAIVER_REASON_PLACEHOLDER_PATTERNS.some((re) => re.test(reason));
    out.set(path, { reason, placeholder });
  }
  return out;
}

function normalizeAnnotationPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasMinimumIdentityAnnotation(annotations) {
  return (annotations || []).some((annotation) =>
    ["capability", "module"].includes(annotation?.key) &&
    String(annotation?.value || "").trim()
  );
}

// Read committed bytes so the canonical parser can distinguish a genuinely
// legacy-unannotated file from an identity regression. Any failure (not a git
// repo, git absent, path not in HEAD) returns exists=false and keeps net-new
// enforcement fail-closed.
function readFromGitHead(relPath, cwd) {
  if (!relPath || !cwd) return { exists: false, content: null };
  try {
    const content = execFileSync("git", ["show", `HEAD:${relPath}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { exists: true, content };
  } catch {
    return { exists: false, content: null };
  }
}

function isWorthyPath(relPath, customPrefixes = null) {
  const prefixes = Array.isArray(customPrefixes) && customPrefixes.length > 0
    ? customPrefixes
    : DEFAULT_WORTHY_PREFIXES;
  const normalized = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return false;
  if (!ANNOTATABLE_EXTENSIONS.has(extname(normalized).toLowerCase())) return false;
  return prefixes.some((p) => normalized.startsWith(p));
}

function loadWorthyPrefixes(env) {
  const raw = String(env?.PLANNER_ANNOTATION_WORTHY_GLOBS || "").trim();
  if (!raw) return null;
  return raw.split(/[;,]+/).map((s) => s.trim()).filter(Boolean);
}

export function isAnnotationDisciplineEnabled(env = process.env) {
  const v = String(env?.PLANNER_ANNOTATION_DISCIPLINE || "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  // Default ON. Operator can disable via env.
  return true;
}

export function analyzeAnnotationDiscipline({
  planContent,
  cwd,
  env = process.env,
} = {}) {
  if (typeof planContent !== "string" || !cwd) {
    return {
      enabled: false,
      required: false,
      satisfied: true,
      planned: [],
      worthy: [],
      violations: [],
      waivers: new Map(),
      reason: "missing_inputs",
    };
  }
  const enabled = isAnnotationDisciplineEnabled(env);
  const planned = extractFilesToModify(planContent);
  const waivers = parseAnnotationWaivers(planContent);
  const worthyPrefixes = loadWorthyPrefixes(env);
  const worthy = planned.map(normalizeAnnotationPath).filter((p) => isWorthyPath(p, worthyPrefixes));

  if (!enabled) {
    return {
      enabled: false,
      required: worthy.length > 0,
      satisfied: true,
      planned,
      worthy,
      violations: [],
      waivers,
      reason: "PLANNER_ANNOTATION_DISCIPLINE=off",
    };
  }

  const violations = [];
  for (const relPath of worthy) {
    const waiver = waivers.get(relPath);
    if (waiver && !waiver.placeholder) {
      // Real waiver — file is allowed to lack annotations.
      continue;
    }
    if (waiver && waiver.placeholder) {
      // Waiver present but reason looks like a placeholder — count as violation.
      violations.push({
        path: relPath,
        kind: "waiver_placeholder",
        detail: `waiver reason "${waiver.reason}" looks like a placeholder; write a real reason`,
      });
      continue;
    }
    // No waiver. File must exist on disk AND have annotations.
    const annotations = parseAnnotations(relPath, cwd).filter((annotation) => annotation && !annotation.error);
    if (!existsSync(joinSafe(cwd, relPath))) {
      // Not yet created — skip. (Pre-EXECUTE, the file is in the plan but
      // hasn't been written. Once the file exists, a re-run of this gate
      // enforces the annotation contract.)
      continue;
    }
    if (Array.isArray(annotations) && annotations.length > 0 && hasMinimumIdentityAnnotation(annotations)) {
      continue;
    }
    // File exists on disk but is not adequately annotated. A committed path is
    // exempt only when its HEAD baseline was also legacy-unannotated. If HEAD
    // had a valid identity, losing it is a regression. Missing HEAD content is
    // treated as net-new so AV-7 stays closed.
    const baseline = readFromGitHead(relPath, cwd);
    if (baseline.exists) {
      const baselineAnnotations = parseAnnotationsFromContent(relPath, baseline.content)
        .filter((annotation) => annotation && !annotation.error);
      if (!hasMinimumIdentityAnnotation(baselineAnnotations)) {
        continue;
      }
      violations.push({
        path: relPath,
        kind: "identity_annotation_regression",
        detail: `${relPath} had @planner:module or @planner:capability in git HEAD but the working tree no longer has a valid identity annotation`,
      });
      continue;
    }
    if (Array.isArray(annotations) && annotations.length > 0) {
      violations.push({
        path: relPath,
        kind: "missing_required_annotation",
        detail: `${relPath} (net-new) has @planner annotations but lacks @planner:module or @planner:capability`,
      });
      continue;
    }
    violations.push({
      path: relPath,
      kind: "missing_annotation",
      detail: `${relPath} (net-new) exists but has no @planner: annotations and no waiver in plan.md`,
    });
  }

  return {
    enabled: true,
    required: worthy.length > 0,
    satisfied: violations.length === 0,
    planned,
    worthy,
    violations,
    waivers,
    reason: violations.length === 0 ? "all_clear" : "violations_present",
  };
}

function joinSafe(cwd, relPath) {
  // Avoid importing path.join just for one call — and keep behaviour
  // identical to how parseAnnotations resolves the file.
  if (relPath.startsWith("/")) return relPath;
  return `${cwd.replace(/\/$/, "")}/${relPath}`;
}
