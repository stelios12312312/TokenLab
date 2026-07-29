// novel_insight_floor.mjs - shared ADV-LLM-005 / I-050 evaluator.
//
// The gate and Prolog fact loader both call this module so the user-facing
// failure and the ontology invariant cannot diverge.

import { join } from "path";

import { readArtifact } from "./artifact_io.mjs";
import { readStateJson } from "./determinism.mjs";
import { detectPlanShape } from "./plan_shape.mjs";
import { sanitizeAtom, sanitizeEnumAtom } from "./sanitize.mjs";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const WARNING_THRESHOLD = 2;
const FAILURE_THRESHOLD = 3;
const MIN_LESSON_WORDS = 4;
const NON_IDEATION_SHAPES = new Set(["docs", "documentation", "analysis", "chore"]);
const GATE_STATUS_KEYS = ["gate_result", "result", "status", "outcome", "verdict", "decision"];

function safeRead(filePath) {
  const artifact = readArtifact(filePath);
  return artifact.ok ? artifact.content : "";
}

function parseJsonContent(raw) {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeShape(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "unknown";
}

function stripMarkdownNoise(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s{0,3}[-*]\s+/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractH2Section(content, headingPattern) {
  const lines = String(content || "").split("\n");
  const start = lines.findIndex((line) => /^##\s+/.test(line.trim()) && headingPattern.test(line.trim()));
  if (start === -1) return "";
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) break;
    collected.push(lines[index]);
  }
  return collected.join("\n");
}

function resolvePlanShape({ planDir, stateJson }) {
  const stateShape = normalizeShape(stateJson?.plan_shape?.primary || stateJson?.plan_shape);
  if (stateShape && stateShape !== "unknown") return stateShape;

  const planContent = safeRead(join(planDir, "plan.md"));
  const filesSection = planContent.match(/##\s+Files\s+[Tt]o\s+[Mm]odify\s*\n([\s\S]*?)(?=\n##|$)/);
  const plannedFiles = filesSection
    ? (filesSection[1].match(/^\s*[-*]\s+`?([^`\s]+)`?/gm) || [])
        .map((line) => line.replace(/^\s*[-*]\s+`?/, "").replace(/`?\s*$/, "").trim())
        .filter(Boolean)
    : [];
  return normalizeShape(detectPlanShape({
    goalText: stateJson?.goal || "",
    plannedFiles,
    intentContract: null,
  }).primary);
}

function isGatePass(entry) {
  return verificationStatusIsPass(firstStatusValue(entry), "decision");
}

function firstStatusValue(entry) {
  if (!entry || typeof entry !== "object") return "";
  for (const key of GATE_STATUS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      return entry[key];
    }
  }
  return "";
}

function isExecuteToReflect(entry) {
  const gate = normalize(entry?.gate || entry?.name || entry?.transition);
  const from = normalize(entry?.from || entry?.from_state || entry?.previous_state || entry?.source);
  const to = normalize(entry?.to || entry?.to_state || entry?.next_state || entry?.target || entry?.state);
  if (gate === "execute to reflect" || gate === "execute reflect") return isGatePass(entry);
  return from === "execute" && to === "reflect" && isGatePass(entry);
}

function transitionWindowCount(stateJson) {
  const candidates = [
    stateJson?.transitions,
    stateJson?.transition_history,
    stateJson?.history,
  ].filter(Array.isArray);
  const count = candidates
    .flat()
    .filter((entry) => entry && typeof entry === "object")
    .filter(isExecuteToReflect)
    .length;
  if (count > 0) return count;
  const iteration = Number(stateJson?.iteration);
  return Number.isFinite(iteration) && iteration > 0 ? Math.floor(iteration) : 0;
}

function countDecisions(decisionsContent) {
  return (String(decisionsContent || "").match(/^##\s+D-\d{3}\b/gm) || []).length;
}

function countLessons(reflectionContent) {
  const sections = [
    extractH2Section(reflectionContent, /^##\s+Lessons?\s+(Learned|Learnt|Discovered)\b/i),
    extractH2Section(reflectionContent, /^##\s+Learning[s]?\b/i),
  ].filter(Boolean);
  if (sections.length === 0) return 0;

  let count = 0;
  for (const section of sections) {
    const cleaned = stripMarkdownNoise(section);
    if (!cleaned) continue;
    if (/\b(no new learnings?|nothing (new )?(learned|learnt)|n\/a|none)\b/i.test(cleaned)) continue;
    if (cleaned.split(/\s+/).filter(Boolean).length >= MIN_LESSON_WORDS) count += 1;
  }
  return count;
}

function countRiskObjects(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countRiskObjects(item), 0);

  const type = normalize(value.type || value.kind || value.category || value.label);
  const origin = normalize(value.origin || value.source || value.created_by || value.actor || value.author);
  const text = normalize(value.text || value.summary || value.description || value.risk || value.title);
  const looksLikeRisk = /\b(pre mortem|premortem|risk|failure mode|counterargument)\b/.test(type)
    || /\b(pre mortem|premortem risk|self generated risk|failure mode)\b/.test(text);
  const selfGenerated = !origin || /\b(self|agent|assistant|planner|codex)\b/.test(origin);
  const ownCount = looksLikeRisk && selfGenerated ? 1 : 0;

  return ownCount + Object.values(value).reduce((sum, item) => sum + countRiskObjects(item), 0);
}

function countTextualRisks(contents) {
  return contents.filter((content) => {
    const text = normalize(content);
    if (/\bnot\s+(?:a\s+)?(?:self[-_\s]?generated|agent[-_\s]?generated|planner[-_\s]?generated)\b/.test(text)) return false;
    return /\b(self generated|self-generated|agent generated|planner generated)\b/.test(text)
      && /\b(pre mortem|premortem|risk|failure mode)\b/.test(text);
  }).length;
}

function countSelfGeneratedRisks(planDir, { operatorLedgerJson = null, reflectionContent = null, decisionsContent = null } = {}) {
  const ledgerCount = countRiskObjects(operatorLedgerJson);
  const textualCount = countTextualRisks([
    reflectionContent ?? safeRead(join(planDir, "reflection.md")),
    decisionsContent ?? safeRead(join(planDir, "decisions.md")),
    safeRead(join(planDir, "findings.md")),
  ]);
  return ledgerCount + textualCount;
}

function hasExecutionOnlyWaiver({ decisionsContent, reflectionContent }) {
  const sections = extractDecisionSections(`${decisionsContent || ""}\n${reflectionContent || ""}`);
  return sections.some((section) => {
    const text = normalize(section);
    if (/\b(?:do|does|did)\s+not\s+waiv\w*\b/.test(text) || /\bnot\s+waiv\w*\b/.test(text)) return false;
    return (
      /\bnovel insight floor\b[\s\S]{0,240}\bwaiv/.test(text)
      || /\bwaiv\w*\b[\s\S]{0,240}\bnovel insight floor\b/.test(text)
      || /\b(execution only|routine execution|mechanical execution)\b[\s\S]{0,240}\bwaiv/.test(text)
      || /\bwaiv\w*\b[\s\S]{0,240}\b(execution only|routine execution|mechanical execution)\b/.test(text)
    );
  });
}

function extractDecisionSections(content) {
  const lines = String(content || "").split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+D-\d{3}\b/i.test(trimmed)) {
      if (current) sections.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      if (current) sections.push(current.join("\n"));
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) sections.push(current.join("\n"));
  return sections;
}

function buildDetail(result) {
  if (!result.required) {
    return `I-050 novel-insight floor not required for ${result.planShape}-shaped work.`;
  }
  if (result.artifactReadError) {
    const failures = (result.artifactReadErrors || [])
      .map((entry) => `${entry.artifact}:${entry.error || "read_error"}`)
      .join(", ");
    return `I-050 artifact read error: ${failures}. Required ideation artifacts must be readable before evaluating the novel-insight floor.`;
  }
  if (result.waived) {
    return "I-050 novel-insight floor waived for execution-only work with an explicit waiver.";
  }
  if (result.missingRequiredArtifacts) {
    return "Required ideation artifacts are missing: reflection.md and decisions.md are both absent for required I-050 work.";
  }
  const countSummary = `${result.insightCount} insight(s): ${result.decisionCount} decision(s), ${result.lessonCount} lesson(s), ${result.riskCount} self-generated risk(s)`;
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Renderer summarizes an internally evaluated I-050 contract from its issue list.
  if (result.status === "pass") {
    return result.windowCount < WARNING_THRESHOLD
      ? `I-050 novel-insight floor pending: ${result.windowCount}/${FAILURE_THRESHOLD} barren REFLECT cycle(s); ${countSummary}.`
      : `I-050 novel-insight floor satisfied: ${countSummary}.`;
  }
  const recovery = "Record a new ## D-### decision, a substantive lesson, a self-generated pre-mortem risk, or an explicit execution-only waiver.";
  if (result.status === "warn") {
    return `I-050 warning: ${result.windowCount}/${FAILURE_THRESHOLD} barren REFLECT cycle(s) with ${countSummary}. ${recovery}`;
  }
  return `I-050 failure: ${result.windowCount}/${FAILURE_THRESHOLD} barren REFLECT cycle(s) with ${countSummary}. ${recovery}`;
}

export function evaluateNovelInsightFloor({ planDir, cwd = process.cwd(), stateJson = null } = {}) {
  if (!planDir) {
    throw new Error("evaluateNovelInsightFloor requires planDir");
  }
  const effectiveState = stateJson || readStateJson(planDir) || {};
  const planShape = resolvePlanShape({ planDir, stateJson: effectiveState });
  const required = !NON_IDEATION_SHAPES.has(planShape);
  const windowCount = transitionWindowCount(effectiveState);
  const decisionsPath = join(planDir, "decisions.md");
  const reflectionPath = join(planDir, "reflection.md");
  const operatorLedgerPath = join(planDir, "operator_ledger.json");
  const decisionsArtifact = readArtifact(decisionsPath);
  const reflectionArtifact = readArtifact(reflectionPath);
  const operatorLedgerArtifact = readArtifact(operatorLedgerPath);
  const artifactReadErrors = [
    { artifact: "decisions.md", path: decisionsPath, read: decisionsArtifact },
    { artifact: "reflection.md", path: reflectionPath, read: reflectionArtifact },
    { artifact: "operator_ledger.json", path: operatorLedgerPath, read: operatorLedgerArtifact },
  ]
    .filter((entry) => !entry.read.ok)
    .map((entry) => ({
      artifact: entry.artifact,
      path: entry.path,
      error: entry.read.error || "read_error",
    }));
  const decisionsExists = decisionsArtifact.exists;
  const reflectionExists = reflectionArtifact.exists;
  const operatorLedgerExists = operatorLedgerArtifact.exists;
  const artifactPresence = {
    decisions: decisionsExists,
    reflection: reflectionExists,
    operator_ledger: operatorLedgerExists,
  };

  if (required && artifactReadErrors.length > 0) {
    const result = {
      cwd,
      required,
      waived: false,
      missingRequiredArtifacts: false,
      artifactReadError: true,
      artifactReadErrors,
      artifactPresence,
      code: "artifact_read_error",
      planShape,
      windowCount,
      warningThreshold: WARNING_THRESHOLD,
      threshold: FAILURE_THRESHOLD,
      decisionCount: 0,
      lessonCount: 0,
      riskCount: 0,
      insightCount: 0,
      status: "fail",
      reason: "artifact_read_error",
    };
    result.detail = buildDetail(result);
    return result;
  }

  const decisionsContent = decisionsArtifact.content;
  const reflectionContent = reflectionArtifact.content;
  const decisionCount = countDecisions(decisionsContent);
  const lessonCount = countLessons(reflectionContent);
  const riskCount = countSelfGeneratedRisks(planDir, {
    operatorLedgerJson: parseJsonContent(operatorLedgerArtifact.content),
    reflectionContent,
    decisionsContent,
  });
  const insightCount = decisionCount + lessonCount + riskCount;
  const waived = hasExecutionOnlyWaiver({ decisionsContent, reflectionContent });
  const missingRequiredArtifacts = required && !waived && !decisionsExists && !reflectionExists;

  let status = "pass";
  if (!required) {
    status = "not_required";
  } else if (waived) {
    status = "waived";
  } else if (missingRequiredArtifacts) {
    status = "fail";
  } else if (insightCount > 0 || windowCount < WARNING_THRESHOLD) {
    status = "pass";
  } else if (windowCount >= FAILURE_THRESHOLD) {
    status = "fail";
  } else {
    status = "warn";
  }

  const result = {
    cwd,
    required,
    waived,
    missingRequiredArtifacts,
    artifactReadError: false,
    artifactReadErrors: [],
    artifactPresence,
    code: null,
    planShape,
    windowCount,
    warningThreshold: WARNING_THRESHOLD,
    threshold: FAILURE_THRESHOLD,
    decisionCount,
    lessonCount,
    riskCount,
    insightCount,
    status,
    reason: status,
  };
  result.detail = buildDetail(result);
  return result;
}

export function compileNovelInsightFloorFacts(result) {
  const effective = result || {
    required: false,
    waived: false,
    windowCount: 0,
    warningThreshold: WARNING_THRESHOLD,
    threshold: FAILURE_THRESHOLD,
    decisionCount: 0,
    lessonCount: 0,
    riskCount: 0,
    insightCount: 0,
    status: "not_required",
    detail: "I-050 novel-insight floor not evaluated.",
  };
  return [
    `novel_insight_floor_required(${effective.required ? "true" : "false"}).`,
    `novel_insight_floor_waived(${effective.waived ? "true" : "false"}).`,
    `novel_insight_floor_window_count(${Number(effective.windowCount) || 0}).`,
    `novel_insight_floor_threshold(${Number(effective.threshold) || FAILURE_THRESHOLD}).`,
    `novel_insight_floor_warning_threshold(${Number(effective.warningThreshold) || WARNING_THRESHOLD}).`,
    `novel_insight_count(${Number(effective.insightCount) || 0}).`,
    `novel_insight_decision_count(${Number(effective.decisionCount) || 0}).`,
    `novel_insight_lesson_count(${Number(effective.lessonCount) || 0}).`,
    `novel_insight_risk_count(${Number(effective.riskCount) || 0}).`,
    `novel_insight_floor_status(${sanitizeEnumAtom(effective.status || "unknown")}).`,
    `novel_insight_floor_error(${sanitizeEnumAtom(effective.code || "none")}).`,
    `novel_insight_floor_reason(${sanitizeAtom(effective.detail || effective.reason || "unknown")}).`,
  ];
}
