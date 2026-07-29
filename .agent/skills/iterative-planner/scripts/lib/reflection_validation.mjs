import { existsSync, readFileSync } from "fs";
import { basename, dirname, relative, resolve, sep } from "path";

import { extractMarkdownSection } from "./plan_utils.mjs";
import {
  collectRequiredReflectionGuideQuestions,
  readReflectionGuideDocument,
  REFLECTION_GUIDE_SECTION_ORDER,
  REFLECTION_GUIDE_SECTION_TITLES,
  REFLECTION_GUIDE_VERSION,
} from "./reflection_guide.mjs";

export const REFLECTION_FILENAME = "reflection.md";
export const REFLECTION_SCHEMA_ID = "reflection/v1";

export const REFLECTION_FRONTMATTER_FIELDS = Object.freeze([
  "plan_id",
  "generated_from_guide",
  "guide_version",
  "answered_at",
  "required_questions_answered",
]);

export const REFLECTION_REQUIRED_SECTIONS = Object.freeze([
  { id: "solution_verdict", title: "Solution Verdict" },
  { id: "surprises", title: "Surprises" },
  ...REFLECTION_GUIDE_SECTION_ORDER.map((sectionId) => ({
    id: sectionId,
    title: REFLECTION_GUIDE_SECTION_TITLES[sectionId],
  })),
  { id: "lessons_learned", title: "Lessons Learned" },
  { id: "semantic_verdict", title: "Semantic Verdict" },
  { id: "evidence_readiness_verdict", title: "Evidence-Readiness Verdict" },
  { id: "next_move", title: "Next Move" },
]);

const TEMPLATE_MARKERS = Object.freeze([
  "PENDING_UTC_TIMESTAMP",
  "0/0",
  "Answer every required question from reflection_guide.yaml",
  "Use `### <subject>` subsections",
  "Keep this section even when the guide has no required question here",
  "PASS / FAIL / PARTIAL. Did the implemented change actually improve the intended thing?",
  "Completed during REFLECT. This is the semantic/solution judgment surface before VALIDATE takes over proof sufficiency.",
  "Rewrite as needed within the active iteration; do not leave template text behind when moving to VALIDATE.",
]);

const VACUOUS_SCALARS = new Set([
  "n/a",
  "na",
  "none",
  "no",
  "unknown",
  "todo",
  "tbd",
  "pass",
  "fail",
  "partial",
  "ready",
  "not ready",
  "same as above",
  "out of scope",
]);

// proof-status-lint: exempt T-INTAKE-B07B8898 -- Anti-terse scalar set rejects one-word reflection answers such as yes, no, pass, fail, or partial.
const TERSE_VERDICT_SCALARS = new Set([
  "yes",
  "no",
  "pass",
  "fail",
  "partial",
]);

const MIN_ANSWER_LENGTH = 24;
const MIN_TERSE_VERDICT_LENGTH = 8;

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

function normalizeSectionText(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

function firstMeaningfulLine(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || null;
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

function parseAnsweredCount(rawValue) {
  const normalized = normalizeInlineScalar(rawValue);
  const match = normalized.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) {
    return { ok: false, answered: null, required: null };
  }
  return {
    ok: true,
    answered: Number.parseInt(match[1], 10),
    required: Number.parseInt(match[2], 10),
  };
}

function parseFrontmatter(frontmatterText) {
  const issues = [];
  const raw = {};

  if (frontmatterText === null) {
    return {
      ok: false,
      raw,
      parsed: {
        plan_id: null,
        generated_from_guide: null,
        guide_version: null,
        answered_at: null,
        required_questions_answered: { answered: null, required: null },
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

  for (const fieldName of REFLECTION_FRONTMATTER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, fieldName)) {
      issues.push(`frontmatter.${fieldName} is missing`);
    }
  }

  const parsed = {
    plan_id: normalizeInlineScalar(raw.plan_id) || null,
    generated_from_guide: normalizeInlineScalar(raw.generated_from_guide) || null,
    guide_version: null,
    answered_at: normalizeInlineScalar(raw.answered_at) || null,
    required_questions_answered: { answered: null, required: null },
  };

  if (!parsed.plan_id) {
    issues.push("frontmatter.plan_id is missing");
  }
  if (!parsed.generated_from_guide) {
    issues.push("frontmatter.generated_from_guide is missing");
  }

  const guideVersion = Number.parseInt(String(raw.guide_version || "").trim(), 10);
  parsed.guide_version = Number.isFinite(guideVersion) ? guideVersion : null;
  if (!Number.isInteger(guideVersion) || guideVersion < 1) {
    issues.push("frontmatter.guide_version must be an integer >= 1");
  }

  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?Z$/;
  if (!parsed.answered_at) {
    issues.push("frontmatter.answered_at is missing");
  } else if (!isoPattern.test(parsed.answered_at) || Number.isNaN(Date.parse(parsed.answered_at))) {
    issues.push("frontmatter.answered_at must be an ISO-8601 UTC timestamp");
  }

  const answeredCount = parseAnsweredCount(raw.required_questions_answered);
  if (!answeredCount.ok) {
    issues.push("frontmatter.required_questions_answered must use <answered>/<required> format");
  } else {
    parsed.required_questions_answered = {
      answered: answeredCount.answered,
      required: answeredCount.required,
    };
  }

  return {
    ok: issues.length === 0,
    raw,
    parsed,
    issues,
  };
}

function relativePathLabel(cwd, targetPath) {
  const relativePath = relative(cwd, targetPath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : targetPath;
}

function resolveCanonicalPathInfo(cwd, targetPath) {
  const relativePath = relativePathLabel(cwd, targetPath);
  const normalized = relativePath.split(sep).join("/");
  const match = normalized.match(/^plans\/([^/]+)\/reflection\.md$/);
  return {
    relative_path: relativePath,
    canonical_path: !!match,
    plan_id: match ? match[1] : null,
    file_name: basename(targetPath),
  };
}

function resolveGuidePath(cwd, reflectionPath, generatedFromGuide) {
  const raw = normalizeInlineScalar(generatedFromGuide);
  if (!raw) return resolve(dirname(reflectionPath), "reflection_guide.yaml");
  const candidates = [];
  if (raw.startsWith("/")) candidates.push(resolve(raw));
  candidates.push(resolve(cwd, raw));
  candidates.push(resolve(dirname(reflectionPath), raw));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] || resolve(dirname(reflectionPath), "reflection_guide.yaml");
}

function normalizeExtractedSectionContent(sectionText) {
  const normalized = normalizeSectionText(sectionText);
  if (/^##\s+/.test(normalized) || /^#\s+/.test(normalized)) return "";
  return normalized;
}

function parseSubsections(sectionText) {
  const lines = String(sectionText || "").split("\n");
  const sections = [];
  let current = null;

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) {
        current.body = normalizeSectionText(current.bodyLines.join("\n"));
        delete current.bodyLines;
        sections.push(current);
      }
      current = {
        heading: headingMatch[1].trim(),
        bodyLines: [],
      };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }

  if (current) {
    current.body = normalizeSectionText(current.bodyLines.join("\n"));
    delete current.bodyLines;
    sections.push(current);
  }

  return sections;
}

function stripLeadingSubsections(sectionText) {
  const normalized = String(sectionText || "");
  const index = normalized.search(/^###\s+/m);
  if (index === -1) return normalizeSectionText(normalized);
  return normalizeSectionText(normalized.slice(0, index));
}

function normalizeTokenString(value) {
  return normalizeInlineScalar(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findMatchingSubsection(subsections, question) {
  const subjectId = normalizeInlineScalar(question?.subject_id);
  if (subjectId) {
    const subjectLower = subjectId.toLowerCase();
    const direct = subsections.find((entry) => entry.heading.toLowerCase().includes(subjectLower));
    if (direct) return direct;
  }

  const titleTokens = normalizeTokenString(question?.title || "").split(/\s+/).filter((token) => token.length > 2);
  if (titleTokens.length === 0) return null;
  return subsections.find((entry) => {
    const headingTokens = new Set(normalizeTokenString(entry.heading).split(/\s+/).filter(Boolean));
    return titleTokens.filter((token) => headingTokens.has(token)).length >= Math.min(2, titleTokens.length);
  }) || null;
}

function stripMarkdownNoise(text) {
  return String(text || "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTemplateMarkers(text) {
  const markers = [];
  const normalized = String(text || "");
  const lowered = normalized.toLowerCase();

  for (const marker of TEMPLATE_MARKERS) {
    if (normalized.includes(marker) || lowered.includes(marker.toLowerCase())) {
      markers.push(marker);
    }
  }

  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) markers.push(trimmed);
  }

  return [...new Set(markers)];
}

function vacuousReason(answerText, options = {}) {
  const stripped = stripMarkdownNoise(answerText);
  const normalized = stripped.toLowerCase();
  const allowTerseVerdict = options?.allowTerseVerdict === true;
  if (!normalized) return "answer is empty";
  if (VACUOUS_SCALARS.has(normalized)) {
    if (allowTerseVerdict && TERSE_VERDICT_SCALARS.has(normalized)) return null;
    return "answer uses a vacuous placeholder";
  }
  if (/^(n\/?a|none|todo|tbd|same as above)\b/.test(normalized)) return "answer starts with a vacuous placeholder";
  if (detectTemplateMarkers(answerText).length > 0) return "answer still contains template markers";
  const minLength = allowTerseVerdict ? MIN_TERSE_VERDICT_LENGTH : MIN_ANSWER_LENGTH;
  if (normalized.length < minLength) return "answer is too short to be specific";
  return null;
}

function normalizeDecisionToken(value) {
  return normalizeInlineScalar(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// "Deferring resolution of the issue" → accept_as_known_limitation (triggers the
// I-045 follow-up gate). This must NOT fire on "defer to <authority/default>"
// (e.g. "defer to upstream defaults", "defer to the team") — yielding to an
// authority is not a deferral of work. The earlier `defer ... (to|until|for)`
// pattern conflated the two; here a "defer ... to ..." answer only counts when
// the target is a later TIME or the named WORK, never a bare noun.
function defersResolutionToLaterWork(answer) {
  return (
    // "defer/deferred this|it ... for now | until <anything>"
    /\bdefer(?:red|ring|s)?\b(?: this| it| them)?[^.]{0,30}\b(?:for now|until\b)/.test(answer) ||
    // "defer ... to|until|for|in a/the next|future|later|subsequent iteration|release|..."
    /\bdefer(?:red|ring|s)?\b[^.]{0,30}\b(?:to|until|for|in)\b[^.]{0,20}\b(?:next|future|later|subsequent|upcoming|another)\b[^.]{0,20}\b(?:iteration|release|sprint|cycle|milestone|version|pr|phase|pass|round)\b/.test(answer) ||
    // explicit deferral whose object names the work/issue itself
    /\bdefer(?:red|ring|s)?\b[^.]{0,30}\b(?:resolution|resolving|the fix|fixing|addressing|remediation|(?:this|the) (?:issue|fix|bug|defect|work|item|problem))\b/.test(answer)
  );
}

export function normalizeReflectionDecisionAnswer(answerText, explicitDecision = null) {
  const direct = normalizeDecisionToken(explicitDecision);
  if (direct) return direct;

  const answer = String(answerText || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!answer) return null;

  if (/(pivot_back_to_execute|pivot back to execute|pivot(?:ing)? back now|add test and pivot back to execute)/.test(answer)) {
    return "pivot_back_to_execute";
  }
  if (/\breturn(?:ing)? to execute\b/.test(answer) && !/\b(was|were|had been|already|earlier|previously|now done|done)\b/.test(answer)) {
    return "pivot_back_to_execute";
  }
  if (/(accept_as_known_limitation|accept(?:ed)? as (?:a )?known limitation|known limitation(?: with follow[- ]up)?)/.test(answer)) {
    return "accept_as_known_limitation";
  }
  if (/(choos(?:e|ing)|decid(?:e|ing)) not to resolve|not resolv(?:e|ing).*(?:current|this) iteration/.test(answer) || defersResolutionToLaterWork(answer)) {
    return "accept_as_known_limitation";
  }
  if (/(out_of_scope|out of scope)/.test(answer)) {
    return "out_of_scope";
  }
  return null;
}

function detectAnswerMode(answerText, answerModes = []) {
  const haystack = normalizeDecisionToken(answerText).replace(/_+/g, "_");
  for (const mode of Array.isArray(answerModes) ? answerModes : []) {
    const normalizedMode = normalizeDecisionToken(mode);
    if (!normalizedMode) continue;
    if (haystack.includes(normalizedMode)) return normalizedMode;
  }
  return normalizeReflectionDecisionAnswer(answerText);
}

function extractFollowupStoryIds(answerText) {
  return [...new Set((String(answerText || "").match(/\bUS-\d+\b/g) || []).map((entry) => entry.toUpperCase()))];
}

function buildSectionMap(bodyText) {
  const map = new Map();
  for (const section of REFLECTION_REQUIRED_SECTIONS) {
    map.set(section.id, {
      ...section,
      content: normalizeExtractedSectionContent(extractMarkdownSection(bodyText, section.title)),
    });
  }
  return map;
}

function questionAnswerModes(question) {
  return Array.isArray(question?.answer_modes)
    ? question.answer_modes.map((mode) => normalizeDecisionToken(mode)).filter(Boolean)
    : [];
}

function sectionAllowsTerseVerdict(sectionId, requiredQuestions) {
  const questions = requiredQuestions.filter((question) =>
    question?.section_id === sectionId && question?.required !== false
  );
  return questions.length === 1 && questionAnswerModes(questions[0]).length === 0;
}

function validateRequiredSections(sectionMap, requiredQuestions = []) {
  const results = [];
  const issues = [];

  for (const section of REFLECTION_REQUIRED_SECTIONS) {
    const content = sectionMap.get(section.id)?.content || "";
    const reason = vacuousReason(content, {
      allowTerseVerdict: sectionAllowsTerseVerdict(section.id, requiredQuestions),
    });
    const result = {
      id: section.id,
      title: section.title,
      present: Boolean(content),
      vacuous: Boolean(content) && Boolean(reason),
      detail: !content
        ? "section is missing"
        : reason
          ? reason
          : "section is present",
    };
    results.push(result);
    if (!content) {
      issues.push(`section ${section.title} is missing`);
    } else if (reason) {
      issues.push(`section ${section.title} is vacuous: ${reason}`);
    }
  }

  return { results, issues };
}

function validateQuestionAnswers(sectionMap, requiredQuestions) {
  const issues = [];
  const grouped = new Map();
  for (const question of requiredQuestions) {
    if (!grouped.has(question.section_id)) grouped.set(question.section_id, []);
    grouped.get(question.section_id).push(question);
  }

  const results = [];

  for (const question of requiredQuestions) {
    const sectionInfo = sectionMap.get(question.section_id);
    const sectionContent = sectionInfo?.content || "";
    const sectionQuestions = grouped.get(question.section_id) || [];
    const subsections = parseSubsections(sectionContent);
    const matchedSubsection = findMatchingSubsection(subsections, question);

    let answerText = "";
    if (matchedSubsection) {
      answerText = matchedSubsection.body;
    } else if (sectionQuestions.length === 1) {
      answerText = sectionContent;
    } else {
      answerText = stripLeadingSubsections(sectionContent);
    }

    const answerPresent = Boolean(answerText) && (matchedSubsection || sectionQuestions.length === 1);
    const answerModes = questionAnswerModes(question);
    let reason = answerPresent ? vacuousReason(answerText, { allowTerseVerdict: answerModes.length === 0 }) : "required question does not have a matching subsection answer";
    const decision = detectAnswerMode(answerText, question.answer_modes);
    const followupStoryIds = extractFollowupStoryIds(answerText);
    if (answerPresent && !reason && answerModes.length > 0 && !decision) {
      reason = `answer must explicitly choose one of: ${answerModes.join(", ")}`;
    }

    const result = {
      question_id: question.id,
      section_id: question.section_id,
      subject_id: normalizeInlineScalar(question.subject_id) || null,
      title: normalizeInlineScalar(question.title) || null,
      required: question.required !== false,
      matched_heading: matchedSubsection?.heading || null,
      present: answerPresent,
      answered: answerPresent && !reason,
      vacuous: answerPresent && Boolean(reason),
      decision,
      followup_story_ids: followupStoryIds,
      answer_text: answerPresent ? answerText : "",
      detail: answerPresent
        ? (reason || "required question is addressed")
        : "required question does not have a matching subsection answer",
    };

    results.push(result);

    if (!answerPresent) {
      const subjectLabel = result.subject_id || result.title || question.id;
      issues.push(`required question ${subjectLabel} is missing an answer in section ${sectionInfo?.title || question.section_id}`);
      continue;
    }
    if (reason) {
      const subjectLabel = result.subject_id || result.title || question.id;
      issues.push(`required question ${subjectLabel} is vacuous: ${reason}`);
    }
  }

  return { results, issues };
}

export function validateReflection({ cwd = process.cwd(), filePath } = {}) {
  const targetPath = resolve(cwd, filePath || "");
  const pathInfo = resolveCanonicalPathInfo(cwd, targetPath);
  const result = {
    ok: false,
    schema_id: REFLECTION_SCHEMA_ID,
    path: targetPath,
    relative_path: pathInfo.relative_path,
    canonical_path: pathInfo.canonical_path,
    plan_id: pathInfo.plan_id,
    guide_path: null,
    guide_version: null,
    frontmatter: {},
    required_question_count: 0,
    answered_question_count: 0,
    required_sections: [],
    question_results: [],
    template_detected: false,
    template_markers: [],
    issues: [],
  };

  if (!filePath) {
    result.issues.push("reflection path is required");
    return result;
  }
  if (!existsSync(targetPath)) {
    result.issues.push(`reflection file is missing: ${filePath}`);
    return result;
  }

  const documentText = normalizeDocumentText(readFileSync(targetPath, "utf-8"));
  const { frontmatterText, bodyText } = splitFrontmatter(documentText);
  const frontmatter = parseFrontmatter(frontmatterText);
  result.frontmatter = frontmatter.parsed;
  result.issues.push(...frontmatter.issues);

  const guidePath = resolveGuidePath(cwd, targetPath, frontmatter.parsed.generated_from_guide);
  result.guide_path = guidePath;

  const guide = readReflectionGuideDocument(guidePath);
  if (!guide.ok) {
    result.issues.push(`reflection guide is missing or invalid: ${relativePathLabel(cwd, guidePath)}`);
    return result;
  }

  result.guide_version = guide.document?.reflection_guide?.version ?? null;
  const guidePlanId = normalizeInlineScalar(guide.document?.reflection_guide?.plan_id);
  result.required_question_count = collectRequiredReflectionGuideQuestions(guide.document).length;

  if (frontmatter.parsed.guide_version !== null && frontmatter.parsed.guide_version !== REFLECTION_GUIDE_VERSION) {
    result.issues.push(`frontmatter.guide_version must equal ${REFLECTION_GUIDE_VERSION}`);
  }
  if (result.guide_version !== REFLECTION_GUIDE_VERSION) {
    result.issues.push(`reflection guide version must equal ${REFLECTION_GUIDE_VERSION}`);
  }
  if (frontmatter.parsed.plan_id && guidePlanId && frontmatter.parsed.plan_id !== guidePlanId) {
    result.issues.push(`frontmatter.plan_id does not match reflection guide plan_id (${guidePlanId})`);
  }
  if (pathInfo.plan_id && frontmatter.parsed.plan_id && pathInfo.plan_id !== frontmatter.parsed.plan_id) {
    result.issues.push(`frontmatter.plan_id does not match canonical reflection path (${pathInfo.plan_id})`);
  }
  if (!pathInfo.plan_id && frontmatter.parsed.plan_id) {
    result.plan_id = frontmatter.parsed.plan_id;
  } else if (frontmatter.parsed.plan_id) {
    result.plan_id = frontmatter.parsed.plan_id;
  } else if (guidePlanId) {
    result.plan_id = guidePlanId;
  }

  const requiredQuestions = collectRequiredReflectionGuideQuestions(guide.document);
  const sectionMap = buildSectionMap(bodyText);
  const sectionValidation = validateRequiredSections(sectionMap, requiredQuestions);
  result.required_sections = sectionValidation.results;
  result.issues.push(...sectionValidation.issues);

  const questionValidation = validateQuestionAnswers(sectionMap, requiredQuestions);
  result.question_results = questionValidation.results;
  result.issues.push(...questionValidation.issues);
  result.answered_question_count = questionValidation.results.filter((entry) => entry.answered === true).length;

  const answeredCounts = frontmatter.parsed.required_questions_answered || {};
  if (Number.isInteger(answeredCounts.required) && answeredCounts.required !== result.required_question_count) {
    result.issues.push(
      `frontmatter.required_questions_answered total ${answeredCounts.required} does not match guide required count ${result.required_question_count}`
    );
  }
  if (Number.isInteger(answeredCounts.answered) && answeredCounts.answered !== result.answered_question_count) {
    result.issues.push(
      `frontmatter.required_questions_answered answered count ${answeredCounts.answered} does not match actual answered count ${result.answered_question_count}`
    );
  }

  result.template_markers = detectTemplateMarkers(documentText);
  result.template_detected = result.template_markers.length > 0;
  if (result.template_detected) {
    result.issues.push(`untouched template content detected: ${result.template_markers.join(", ")}`);
  }

  result.ok = result.issues.length === 0;
  return result;
}
