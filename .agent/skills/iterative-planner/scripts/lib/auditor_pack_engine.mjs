// Shared helpers for AuditorPack implementations.
//
// The public pack contract stays in audit_types.mjs. This module only removes
// repeated internal scaffolding from packs that use the same Prolog pattern.

import { readFileSync } from "fs";
import { createSession } from "./prolog.mjs";
import { makeFinding, SEVERITY } from "./audit_types.mjs";
import { downgradeForShape } from "./pack_severity.mjs";

export function formatPhaseGuidance(guidanceByPhase, phase) {
  const lines = guidanceByPhase?.[String(phase || "").toLowerCase()];
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

export function defaultStoryRef(raw) {
  const subject = String(raw?.subject ?? "unknown");
  return subject !== "project" && subject !== "unknown" && !subject.includes("/")
    ? [subject]
    : [];
}

export function subjectSlug(raw) {
  return String(raw?.file || raw?.subject || "unknown").replace(/\W/g, "_");
}

export function assertStoryFacts(session, storyRegistry, {
  sanitize,
  include = [],
  rawPostconditions = false,
} = {}) {
  if (!storyRegistry || !Array.isArray(storyRegistry.stories)) return;
  if (typeof sanitize !== "function") throw new Error("assertStoryFacts requires a sanitize function");

  const includes = new Set(include);
  for (const story of storyRegistry.stories) {
    if (!story.id) continue;
    const id = sanitize(story.id);
    session.consult(`story(${id}, ${sanitize(story.title || "untitled")}, ${sanitize(story.priority || "medium")}, ${sanitize(story.status || "unknown")}).`);

    if (includes.has("tags") && Array.isArray(story.tags)) {
      for (const tag of story.tags) session.consult(`story_tag(${id}, ${sanitize(tag)}).`);
    }
    if (includes.has("code_refs") && Array.isArray(story.code_refs)) {
      for (const ref of story.code_refs) session.consult(`code_ref(${id}, ${sanitize(ref)}).`);
    }
    if (includes.has("test_refs") && Array.isArray(story.test_refs)) {
      for (const ref of story.test_refs) session.consult(`test_ref(${id}, ${sanitize(ref)}).`);
    }
    if (includes.has("validation_refs") && Array.isArray(story.validation_refs)) {
      for (const ref of story.validation_refs) session.consult(`validation_ref(${id}, ${sanitize(ref)}).`);
    }
    if (includes.has("postconditions") && Array.isArray(story.postconditions)) {
      for (const postcondition of story.postconditions) {
        try {
          const factValue = rawPostconditions ? postcondition : sanitize(postcondition);
          session.consult(`postcondition(${id}, ${factValue}).`);
        } catch {
          // Skip malformed story postconditions. Existing packs have always
          // treated individual malformed facts as non-fatal.
        }
      }
    }
  }
}

function readRules({ packId, rulesFile, rulesLabel }) {
  try {
    return { ok: true, text: readFileSync(rulesFile, "utf-8") };
  } catch (error) {
    return {
      ok: false,
      findings: [{ _error: `Could not load ${rulesLabel || packId} rules.pl: ${error.message}` }],
    };
  }
}

function consultRules(session, rulesText, { packId, rulesLabel }) {
  try {
    session.consult(rulesText);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      findings: [{ _error: `Failed to load ${rulesLabel || packId} Prolog rules: ${error.message}` }],
    };
  }
}

export function defaultPrologAnswerMapper(answer, {
  defaultRuleId = "RULE-???",
  defaultSubject = "project",
  defaultSeverity = SEVERITY.MEDIUM,
} = {}) {
  return {
    ruleId:   String(answer.RuleId   || answer.Rule   || defaultRuleId),
    subject:  String(answer.Subject  || defaultSubject),
    detail:   String(answer.Detail   || ""),
    severity: String(answer.Severity || defaultSeverity),
  };
}

export async function runPrologPackAudit(context, {
  packId,
  rulesFile,
  query,
  collectFacts,
  mapAnswer = defaultPrologAnswerMapper,
  afterQuery,
  defaultRuleId,
  defaultSubject = "project",
  defaultSeverity = SEVERITY.MEDIUM,
  rulesLabel = packId,
  sessionFactory = createSession,
} = {}) {
  if (!packId) throw new Error("runPrologPackAudit requires packId");
  if (!rulesFile) throw new Error(`runPrologPackAudit(${packId}) requires rulesFile`);
  if (!query) throw new Error(`runPrologPackAudit(${packId}) requires query`);

  const session = sessionFactory();
  if (typeof collectFacts === "function") {
    const earlyFindings = await collectFacts(context, session);
    if (Array.isArray(earlyFindings)) return earlyFindings;
  }

  const rules = readRules({ packId, rulesFile, rulesLabel });
  if (!rules.ok) return rules.findings;

  const consulted = consultRules(session, rules.text, { packId, rulesLabel });
  if (!consulted.ok) return consulted.findings;

  const rawFindings = [];
  try {
    for (const answer of session.query(query)) {
      rawFindings.push(mapAnswer(answer, {
        defaultRuleId,
        defaultSubject,
        defaultSeverity,
      }));
    }
  } catch (error) {
    if (process.env.DEBUG) console.error(`[${packId}] Prolog query error: ${error.message}`);
  }

  if (typeof afterQuery === "function") {
    const nextFindings = await afterQuery(rawFindings, context, session);
    return Array.isArray(nextFindings) ? nextFindings : rawFindings;
  }
  return rawFindings;
}

export function normalizePackFinding(raw, context, {
  packId,
  rules = [],
  defaultSeverity = SEVERITY.MEDIUM,
  category = "general",
  errorId = `${String(packId || "PACK").toUpperCase()}-ERR`,
  errorRecommendation = `Check that packs/${packId}/rules.pl is present and valid Prolog.`,
  severityDowngrades = null,
  severityResolver = null,
  evidenceTemplates = {},
  fallbackEvidence = null,
  fallbackRecommendation = "See pack documentation.",
  recommendation = null,
  storyRefs = defaultStoryRef,
  slug = subjectSlug,
  id = null,
  meta = null,
} = {}) {
  if (!packId) throw new Error("normalizePackFinding requires packId");

  if (raw?._error) {
    return makeFinding({
      id:             errorId,
      role:           packId,
      severity:       SEVERITY.MEDIUM,
      category:       "pack_error",
      story_refs:     [],
      evidence:       raw._error,
      recommendation: errorRecommendation,
    });
  }

  const rule = rules.find((entry) => entry.id === raw.ruleId) || {};
  const severity = typeof severityResolver === "function"
    ? severityResolver(raw, context, rule)
    : severityDowngrades
      ? downgradeForShape({
        ruleId: raw.ruleId,
        defaultSeverity: raw.severity || defaultSeverity,
        planShape: context?.planShape,
        downgrades: severityDowngrades,
      })
      : raw.severity || defaultSeverity;

  const evidenceFn = evidenceTemplates[raw.ruleId];
  const evidence = evidenceFn
    ? evidenceFn(raw.subject, raw.detail, raw)
    : typeof fallbackEvidence === "function"
      ? fallbackEvidence(raw, context, rule)
      : raw.detail || `${raw.ruleId} violation for ${raw.subject}`;

  const categoryValue = typeof category === "function" ? category(raw, context, rule) : category;
  const metaValue = typeof meta === "function" ? meta(raw, context, rule) : meta;
  const recommendationValue = typeof recommendation === "function"
    ? recommendation(raw, context, rule)
    : raw.recommendation || rule.remediation || fallbackRecommendation;
  const idValue = typeof id === "function" ? id(raw, context, rule) : `${raw.ruleId}-${slug(raw, context, rule)}`;

  return makeFinding({
    id:             idValue,
    role:           packId,
    severity,
    category:       categoryValue,
    story_refs:     typeof storyRefs === "function" ? storyRefs(raw, context, rule) : [],
    evidence,
    recommendation: recommendationValue,
    meta:           metaValue || {},
  });
}
