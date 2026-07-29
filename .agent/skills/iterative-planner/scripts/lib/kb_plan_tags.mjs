// kb_plan_tags.mjs — shared PLAN-phase KB marker obligation helpers.
//
// Keeps PLN-021 behavior consistent across verify_gate, checklist_runner,
// evidence_preflight, and plan_refresh.

import { basename, join } from "path";

import { resolveKnowledgeFromContext } from "../knowledge_resolver.mjs";
import {
  classifyPlannerPreflight,
  extractFilesToModify,
  readFile,
} from "./plan_utils.mjs";

const KB_TAG_KINDS = new Set(["mistake", "pattern", "gotcha", "kb_ref", "retro"]);

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function extractGoalText(planContent) {
  const match = String(planContent || "").match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return firstNonEmptyString(match?.[1]?.split("\n")[0]);
}

function sanitizeTagText(value) {
  return String(value || "")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

export function planContainsKbTag(planContent) {
  return /\[(?:KB_APPLIED|KB_NOT_APPLICABLE)\b/i.test(String(planContent || ""));
}

export function collectActiveKbHits(knowledgeContext) {
  if (!knowledgeContext) return [];
  const hits = [];
  const seen = new Set();
  const add = (entry) => {
    const id = String(entry?.id || "").trim();
    const kind = String(entry?.kind || "").trim();
    if (!id || !KB_TAG_KINDS.has(kind)) return;
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      id,
      kind,
      title: typeof entry?.title === "string" ? entry.title.trim() : "",
      summary: typeof entry?.summary === "string" ? entry.summary.trim() : "",
    });
  };
  for (const entry of knowledgeContext.related_mistakes || []) add({ ...entry, kind: entry?.kind || "mistake" });
  for (const entry of knowledgeContext.related_retros || []) add({ ...entry, kind: entry?.kind || "retro" });
  for (const group of [knowledgeContext.matches?.trusted, knowledgeContext.matches?.derived]) {
    for (const entry of group || []) add(entry);
  }
  return hits;
}

export function analyzeKbTagObligation(planContent, knowledgeContext) {
  const hits = collectActiveKbHits(knowledgeContext);
  const hasTag = planContainsKbTag(planContent);
  if (hits.length === 0) {
    return {
      satisfied: true,
      hits: [],
      hasTag,
      tag_required: false,
      detail: hasTag
        ? "No active KB mistake/pattern matches; existing KB marker is acceptable"
        : "No active KB mistake/pattern matches — KB marker is not required",
    };
  }

  const hitList = hits.map((h) => `${h.id} (${h.kind})`).join(", ");
  if (hasTag) {
    return {
      satisfied: true,
      hits,
      hasTag: true,
      tag_required: true,
      detail: `Active KB hit(s) present and KB marker referenced: ${hitList}`,
    };
  }
  return {
    satisfied: false,
    hits,
    hasTag: false,
    tag_required: true,
    detail: `Active KB hit(s) require a KB marker: ${hitList}`,
    guidance: hits.map((h) => `Suggested tag: [KB_APPLIED:${h.id}] ${h.title || h.summary || ""}`.trim()),
  };
}

export function resolveKbTagKnowledgeContext({
  cwd = process.cwd(),
  planDir = null,
  planDirName = null,
  stateJson = null,
  planContent = "",
  goalText = "",
  plannedFiles = null,
  classificationHints = null,
} = {}) {
  const goal = firstNonEmptyString(goalText, stateJson?.goal, extractGoalText(planContent));
  const files = Array.isArray(plannedFiles) ? plannedFiles : extractFilesToModify(planContent);
  try {
    return resolveKnowledgeFromContext({
      cwd,
      goalText: goal,
      plannedFiles: files,
      planDir,
      planDirName: planDirName || (planDir ? basename(planDir) : null),
      stateJson,
      planContent,
      verificationContent: planDir ? (readFile(join(planDir, "verification.md")) || "") : "",
      classificationHints: classificationHints || classifyPlannerPreflight(goal, {
        plannedFiles: files,
        hasActivePlan: !!planDir,
        activePlanPoisoned: false,
        activePlanState: stateJson?.state || null,
      }),
    });
  } catch {
    return null;
  }
}

export function renderKbAutoTags(knowledgeContext) {
  const hits = collectActiveKbHits(knowledgeContext);
  if (hits.length === 0) {
    return "[KB_NOT_APPLICABLE: no active KB mistake/pattern matched this plan]";
  }
  return hits
    .map((hit) => {
      const note = sanitizeTagText(hit.title || hit.summary);
      return `[KB_APPLIED:${hit.id}]${note ? ` ${note}` : ""}`;
    })
    .join("\n");
}

export function ensurePlanKbTags(planContent, { knowledgeContext = null } = {}) {
  const content = String(planContent || "");
  if (!content.trim() || planContainsKbTag(content)) {
    return { content, inserted: [], hits: collectActiveKbHits(knowledgeContext) };
  }
  const tags = renderKbAutoTags(knowledgeContext);
  const next = `${content.trimEnd()}\n\n## Knowledge Application\n${tags}\n`;
  return {
    content: next,
    inserted: ["Knowledge Application"],
    hits: collectActiveKbHits(knowledgeContext),
  };
}
