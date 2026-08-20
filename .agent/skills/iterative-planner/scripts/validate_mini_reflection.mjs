#!/usr/bin/env node
// validate_mini_reflection.mjs — Deterministic validator for Phase 2.8 mini-reflection artifacts.
//
// Usage:
//   node .agent/skills/iterative-planner/scripts/validate_mini_reflection.mjs <path> [--json]

import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

import { emitJson } from "./lib/emit_json.mjs";
import { extractMarkdownSection } from "./lib/plan_utils.mjs";

const SCHEMA_ID = "mini_reflection/v1";
const DECISIONS = new Set(["continue", "pivot", "escalate"]);
const REQUIRED_FRONTMATTER_FIELDS = Object.freeze([
  "triggered_by",
  "trigger_at",
  "tool_call_count_since_reflect",
  "response_level",
]);
const TEMPLATE_MARKERS = Object.freeze([
  "specific: not \"test fails\"",
  "or pivot, or escalate",
  "if continue: why this time is different",
  "if pivot: what the new approach is and why",
  "if escalate: why this needs human review",
  "single concrete next tool call, not \"keep trying\"",
]);

function usage() {
  return [
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/validate_mini_reflection.mjs <path> [--json]",
  ].join("\n");
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

function normalizeDocumentText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
}

function normalizeInlineScalar(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const quoted = trimmed.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2].trim() : trimmed;
}

function firstMeaningfulLine(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function normalizeSectionText(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

function splitFrontmatter(documentText) {
  const normalized = normalizeDocumentText(documentText);
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    return {
      frontmatterText: null,
      bodyText: normalized,
    };
  }
  return {
    frontmatterText: match[1],
    bodyText: match[2],
  };
}

function parseInlineArray(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return { ok: false, value: [], issue: "must use inline array syntax like [thrashing_repeat_edit]" };
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return { ok: true, value: [] };
  }

  const values = inner
    .split(",")
    .map((entry) => normalizeInlineScalar(entry))
    .filter(Boolean);

  if (values.length === 0) {
    return { ok: false, value: [], issue: "must contain at least one signal id" };
  }
  return { ok: true, value: values };
}

function parseFrontmatter(frontmatterText) {
  const issues = [];
  const raw = {};

  if (frontmatterText === null) {
    return {
      ok: false,
      raw,
      parsed: {
        triggered_by: [],
        trigger_at: null,
        tool_call_count_since_reflect: null,
        response_level: null,
      },
      issues: ["frontmatter is missing; expected leading --- block"],
    };
  }

  for (const line of String(frontmatterText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-z_]+):\s*(.+?)\s*$/);
    if (!match) {
      issues.push(`frontmatter line is invalid: ${trimmed}`);
      continue;
    }
    const [, key, value] = match;
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      issues.push(`frontmatter.${key} is duplicated`);
      continue;
    }
    raw[key] = value;
  }

  for (const fieldName of REQUIRED_FRONTMATTER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, fieldName)) {
      issues.push(`frontmatter.${fieldName} is missing`);
    }
  }

  const parsed = {
    triggered_by: [],
    trigger_at: null,
    tool_call_count_since_reflect: null,
    response_level: null,
  };

  if (Object.prototype.hasOwnProperty.call(raw, "triggered_by")) {
    const triggeredBy = parseInlineArray(raw.triggered_by);
    if (!triggeredBy.ok) {
      issues.push(`frontmatter.triggered_by ${triggeredBy.issue}`);
    } else {
      parsed.triggered_by = triggeredBy.value;
      if (parsed.triggered_by.length === 0) {
        issues.push("frontmatter.triggered_by must contain at least one signal id");
      }
      for (const signalId of parsed.triggered_by) {
        if (!/^thrashing_[a-z0-9_]+$/.test(signalId)) {
          issues.push(`frontmatter.triggered_by contains invalid signal id: ${signalId}`);
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, "trigger_at")) {
    const triggerAt = normalizeInlineScalar(raw.trigger_at);
    parsed.trigger_at = triggerAt || null;
    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?Z$/;
    if (!triggerAt) {
      issues.push("frontmatter.trigger_at is missing");
    } else if (!isoPattern.test(triggerAt) || Number.isNaN(Date.parse(triggerAt))) {
      issues.push("frontmatter.trigger_at must be an ISO-8601 UTC timestamp");
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, "tool_call_count_since_reflect")) {
    const count = Number.parseInt(String(raw.tool_call_count_since_reflect || "").trim(), 10);
    parsed.tool_call_count_since_reflect = Number.isFinite(count) ? count : null;
    if (!Number.isInteger(count) || count < 1) {
      issues.push("frontmatter.tool_call_count_since_reflect must be an integer >= 1");
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, "response_level")) {
    const responseLevel = Number.parseInt(String(raw.response_level || "").trim(), 10);
    parsed.response_level = Number.isFinite(responseLevel) ? responseLevel : null;
    if (!Number.isInteger(responseLevel) || responseLevel < 1 || responseLevel > 3) {
      issues.push("frontmatter.response_level must be an integer between 1 and 3");
    }
  }

  return {
    ok: issues.length === 0,
    raw,
    parsed,
    issues,
  };
}

function normalizeDecision(value) {
  const line = firstMeaningfulLine(value);
  if (!line) return null;

  let normalized = line.trim().toLowerCase();
  normalized = normalized.replace(/^[-*]\s*/, "");
  normalized = normalized.replace(/^`(.+)`$/, "$1");
  const commentIndex = normalized.indexOf("#");
  if (commentIndex !== -1) {
    normalized = normalized.slice(0, commentIndex).trim();
  }
  normalized = normalized.split(/\s+/)[0] || "";
  return DECISIONS.has(normalized) ? normalized : null;
}

function detectTemplateMarkers(value) {
  const markers = [];
  const normalized = String(value || "").trim();
  if (!normalized) return markers;

  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      markers.push(trimmed);
    }
  }

  const lower = normalized.toLowerCase();
  for (const marker of TEMPLATE_MARKERS) {
    if (lower.includes(marker)) {
      markers.push(marker);
    }
  }

  return [...new Set(markers)];
}

function relativePathLabel(cwd, targetPath) {
  const relativePath = relative(cwd, targetPath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : targetPath;
}

function resolveCanonicalPathInfo(cwd, targetPath) {
  const relativePath = relativePathLabel(cwd, targetPath);
  const normalized = relativePath.split(sep).join("/");
  const match = normalized.match(/^plans\/([^/]+)\/reflections\/(mini_[^/]+\.md)$/);
  return {
    relative_path: relativePath,
    canonical_path: !!match,
    plan_id: match ? match[1] : null,
    file_name: basename(targetPath),
    file_name_valid: /^mini_.+\.md$/.test(basename(targetPath)),
  };
}

export function validateMiniReflection({ cwd = process.cwd(), filePath } = {}) {
  const resolvedPath = resolve(cwd, String(filePath || ""));
  const pathInfo = resolveCanonicalPathInfo(cwd, resolvedPath);
  const issues = [];
  const warnings = [];
  const result = {
    ok: false,
    schema: SCHEMA_ID,
    path: resolvedPath,
    relative_path: pathInfo.relative_path,
    plan_id: pathInfo.plan_id,
    canonical_path: pathInfo.canonical_path,
    frontmatter: {
      triggered_by: [],
      trigger_at: null,
      tool_call_count_since_reflect: null,
      response_level: null,
    },
    fields: {
      current_blocker: null,
      decision: null,
      rationale: null,
      next_action: null,
    },
    template_detected: false,
    issues,
    warnings,
  };

  if (!filePath) {
    issues.push("path is required");
    return result;
  }

  if (!existsSync(resolvedPath)) {
    issues.push(`file does not exist: ${pathInfo.relative_path}`);
    return result;
  }

  if (!pathInfo.canonical_path) {
    issues.push("path must match plans/<plan_id>/reflections/mini_<timestamp>.md");
  }
  if (!pathInfo.file_name_valid) {
    issues.push("filename must start with mini_ and end with .md");
  }

  const text = readFileSync(resolvedPath, "utf-8");
  const { frontmatterText, bodyText } = splitFrontmatter(text);
  const frontmatter = parseFrontmatter(frontmatterText);
  result.frontmatter = frontmatter.parsed;
  issues.push(...frontmatter.issues);

  const currentBlocker = normalizeSectionText(extractMarkdownSection(bodyText, "Current Blocker"));
  const decisionSection = normalizeSectionText(extractMarkdownSection(bodyText, "Continue / Pivot / Escalate"));
  const rationale = normalizeSectionText(extractMarkdownSection(bodyText, "Rationale"));
  const nextAction = normalizeSectionText(extractMarkdownSection(bodyText, "If continue: specific next action"));

  const templateHits = [
    ...detectTemplateMarkers(currentBlocker),
    ...detectTemplateMarkers(decisionSection),
    ...detectTemplateMarkers(rationale),
    ...detectTemplateMarkers(nextAction),
  ];
  result.template_detected = templateHits.length > 0;
  if (templateHits.length > 0) {
    issues.push(`untouched template content detected: ${templateHits.join("; ")}`);
  }

  result.fields.current_blocker = currentBlocker || null;
  result.fields.decision = normalizeDecision(decisionSection);
  result.fields.rationale = rationale || null;
  result.fields.next_action = nextAction || null;

  if (!currentBlocker) {
    issues.push("current_blocker is missing");
  }
  if (!decisionSection) {
    issues.push("decision is missing");
  } else if (!result.fields.decision) {
    issues.push("decision must be one of: continue, pivot, escalate");
  }
  if (!rationale) {
    issues.push("rationale is missing");
  }
  if (result.fields.decision === "continue" && !nextAction) {
    issues.push("next_action is required when decision=continue");
  }

  result.ok = issues.length === 0;
  return result;
}

function renderHuman(result) {
  const lines = [];
  lines.push(`Mini-reflection validation: ${result.ok ? "PASS" : "FAIL"}`);
  lines.push(`Path: ${result.relative_path}`);
  lines.push(`Plan: ${result.plan_id || "unknown"}`);
  lines.push(`Decision: ${result.fields.decision || "missing"}`);
  lines.push(`Triggered by: ${(result.frontmatter.triggered_by || []).join(", ") || "missing"}`);
  lines.push(`Template detected: ${result.template_detected ? "yes" : "no"}`);
  if ((result.issues || []).length > 0) {
    lines.push("Issues:");
    for (const issue of result.issues) lines.push(`- ${issue}`);
  }
  if ((result.warnings || []).length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {
    filePath: null,
    json: false,
    help: false,
  };

  for (const token of argv.slice(2)) {
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (!args.filePath) {
      args.filePath = token;
      continue;
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.filePath) {
    console.error(usage());
    process.exit(args.help ? 0 : 2);
  }

  const result = validateMiniReflection({
    cwd: process.cwd(),
    filePath: args.filePath,
  });

  const exitCode = result.ok ? 0 : 1;
  if (args.json) {
    emitJson(result, { exitCode });
    return;
  } else {
    console.log(renderHuman(result));
  }
  process.exitCode = exitCode;
}

if (isMainModule()) {
  main();
}
