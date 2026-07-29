import { canonicalizeVerificationProofText } from "./verification_obligations.mjs";
import { splitMarkdownTableRow } from "./markdown_table.mjs";

export const PLANNER_SECTION_ALIASES = Object.freeze({
  Steps: ["Execution Steps"],
});

export const VERIFICATION_HEADER_ALIASES = Object.freeze({
  "Repo/system context": ["System context", "Repo context", "Context"],
  "Required proof type": ["Proof type", "Proof"],
  "Concrete command or action": ["Command", "Action"],
  "Pass means": ["Expected result", "Pass"],
  "What remains unverified": ["Residual risk", "Remaining risk", "Unverified scope"],
});

const STORY_ID_FINAL_SEGMENT = "(?:\\d{1,4}|H[0-9A-F]{8,64})";
const STORY_LINK_PATTERN = new RegExp(`\\bUS(?:[\\s_-]*\\d{1,4}|(?:[\\s_-]+[A-Z][A-Z0-9]{0,15})+[\\s_-]+${STORY_ID_FINAL_SEGMENT})\\b`, "gi");
const CANONICAL_STORY_LINK_PATTERN = /^US(?:-[A-Z][A-Z0-9]{0,15})*-(?:\d{1,4}|H[0-9A-F]{8,64})$/;

function normalizeText(value) {
  return String(value || "")
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHeaderKey(value) {
  return normalizeText(value).toLowerCase();
}

function findSectionAliases(planContent) {
  const corrections = [];
  for (const [canonical, aliases] of Object.entries(PLANNER_SECTION_ALIASES)) {
    for (const alias of aliases) {
      const pattern = new RegExp(`^## ${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
      if (pattern.test(String(planContent || ""))) {
        corrections.push({
          type: "section_heading",
          from: alias,
          to: canonical,
        });
      }
    }
  }
  return corrections;
}

function findHeaderAliases(content) {
  const corrections = [];
  const lines = String(content || "").split("\n");
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cells = splitMarkdownTableRow(line).filter(Boolean);
    for (const cell of cells) {
      const normalizedCell = normalizeHeaderKey(cell);
      for (const [canonical, aliases] of Object.entries(VERIFICATION_HEADER_ALIASES)) {
        const alias = aliases.find((entry) => normalizeHeaderKey(entry) === normalizedCell);
        if (alias) {
          corrections.push({
            type: "verification_header",
            from: cell,
            to: canonical,
          });
        }
      }
    }
  }
  return corrections;
}

function findProofAliases(content) {
  const corrections = [];
  const aliasCandidates = [
    "visual verification",
    "browser trace",
    "browser walkthrough",
    "manual verification",
    "integration smoke test",
    "smoke test",
  ];

  const lowerContent = String(content || "").toLowerCase();
  for (const candidate of aliasCandidates) {
    if (!lowerContent.includes(candidate)) continue;
    const canonical = canonicalizeVerificationProofText(candidate);
    if (canonical && canonical !== candidate) {
      corrections.push({
        type: "proof_label",
        from: candidate,
        to: canonical,
      });
    }
  }
  return corrections;
}

function findStoryLinkCorrections(content) {
  const corrections = [];
  const seen = new Set();
  for (const match of String(content || "").matchAll(STORY_LINK_PATTERN)) {
    const raw = match[0];
    const canonical = canonicalizeStoryLinkToken(raw);
    if (!canonical || canonical === raw) continue;
    const key = `${raw}->${canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    corrections.push({
      type: "story_link",
      from: raw,
      to: canonical,
    });
  }
  return corrections;
}

export function canonicalizeStoryLinkToken(value) {
  const match = String(value || "").match(STORY_LINK_PATTERN);
  if (!match) return null;
  const text = match[0].trim();
  const normalized = text
    .replace(/^us/i, "US")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toUpperCase();
  const numericOnly = normalized.match(/^US-?(\d{1,4})$/);
  if (numericOnly) return `US-${numericOnly[1]}`;
  if (CANONICAL_STORY_LINK_PATTERN.test(normalized)) return normalized;
  return null;
}

export function extractNormalizedStoryIdsFromText(value) {
  return [...new Set(Array.from(String(value || "").matchAll(STORY_LINK_PATTERN))
    .map((match) => canonicalizeStoryLinkToken(match[0]))
    .filter(Boolean))];
}

export function collectPlannerCanonicalization({
  planContent = "",
  verificationContent = "",
} = {}) {
  const corrections = [
    ...findSectionAliases(planContent),
    ...findHeaderAliases(planContent),
    ...findHeaderAliases(verificationContent),
    ...findProofAliases(planContent),
    ...findProofAliases(verificationContent),
    ...findStoryLinkCorrections(planContent),
  ];

  return {
    applied: corrections,
    count: corrections.length,
  };
}
