const NO_NEW_MARKER = "[KB_NO_NEW_LEARNINGS]";
const UPDATED_MARKER = "[KB_UPDATED]";
const NO_NEW_DECISIONS = new Set([
  "no_new_learnings",
  "no_new_learning",
  "none_new",
  "nothing_new",
  "no_new_kb_entry",
  "no_new_kb_entries",
  "no_new_knowledge_base_entry",
  "no_new_knowledge_base_entries",
  "no_kb_entry",
  "no_kb_entries",
  "no_kb_update",
  "no_knowledge_base_update",
  "no_new_kb",
  "no_new_knowledge",
]);

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownSection(content, heading) {
  if (!content || !heading) return "";
  const match = String(content).match(new RegExp(`^## ${escapeRegex(heading)}\\s*$`, "m"));
  if (!match || match.index === undefined) return "";

  const afterHeading = String(content).slice(match.index + match[0].length).replace(/^\n/, "");
  const nextHeading = afterHeading.match(/\n## |\n# /);
  return nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
}

function normalizeDecision(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractLabeledLine(section, labels) {
  const lines = String(section || "").split("\n");
  for (const line of lines) {
    const withoutBullet = line.replace(/^\s*[-*]\s*/, "").trim();
    const colonIndex = withoutBullet.indexOf(":");
    if (colonIndex === -1) continue;
    const label = normalizeDecision(withoutBullet.slice(0, colonIndex));
    if (!labels.some((candidate) => label === normalizeDecision(candidate))) continue;
    return withoutBullet.slice(colonIndex + 1).trim();
  }
  return "";
}

function meaningfulReason(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (["-", "tbd", "todo", "pending", "n/a", "none"].includes(normalized)) return false;
  if (normalized.startsWith("to be populated") || normalized.startsWith("to be defined")) return false;
  return normalized.length >= 8;
}

export function parseKbSignoffSource(content, source = "unknown") {
  const text = String(content || "");
  const section = extractMarkdownSection(text, "Knowledge Base Sign-Off");
  const scanText = section || text;
  const decisionRaw = extractLabeledLine(scanText, [
    "Decision",
    "KB Decision",
    "Knowledge Base Decision",
    "Knowledge Decision",
  ]);
  const reason = extractLabeledLine(scanText, ["Reason", "Rationale", "Why"]);
  const decision = normalizeDecision(decisionRaw);

  const markerNoNew = text.includes(NO_NEW_MARKER);
  const markerUpdated = text.includes(UPDATED_MARKER);
  const decisionNoNew = NO_NEW_DECISIONS.has(decision);
  const decisionUpdated = ["updated", "kb_updated", "knowledge_updated", "knowledge_base_updated"].includes(decision);
  const hasMeaningfulReason = meaningfulReason(reason);

  const noNewLearnings = markerNoNew || (decisionNoNew && hasMeaningfulReason);
  const updated = markerUpdated || decisionUpdated;
  return {
    source,
    present: !!section.trim() || markerNoNew || markerUpdated,
    decision: decisionRaw || null,
    reason: hasMeaningfulReason ? reason : null,
    no_new_learnings: noNewLearnings,
    updated,
    marker_no_new_learnings: markerNoNew,
    marker_updated: markerUpdated,
    pending: decision === "pending",
  };
}

export function collectKbSignoff(sources = []) {
  const parsed = sources
    .filter((entry) => entry && typeof entry.content === "string" && entry.content.length > 0)
    .map((entry) => parseKbSignoffSource(entry.content, entry.source || "unknown"));
  const contributing = parsed.filter((entry) => entry.no_new_learnings || entry.updated);
  return {
    no_new_learnings: contributing.some((entry) => entry.no_new_learnings),
    updated: contributing.some((entry) => entry.updated),
    sources: contributing.map((entry) => entry.source),
    reason: contributing.map((entry) => entry.reason).find(Boolean) || null,
    details: parsed,
  };
}

export { NO_NEW_MARKER, UPDATED_MARKER };
