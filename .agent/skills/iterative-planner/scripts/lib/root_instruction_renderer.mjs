export const ROOT_INSTRUCTION_SOURCE_OF_TRUTH = Object.freeze({
  template_path: ".agent/skills/iterative-planner/references/CLAUDE.template.md",
  section_headings: Object.freeze([
    "## Session Start (Mandatory)",
    "## Domain Persona Autorun",
    "## Transition Gate Quick Reference",
    "## Available Workflows",
    "## Key References",
  ]),
});

export const ROOT_INSTRUCTION_CANONICAL_COMMENT = "Canonical source: CLAUDE.md. Synced to GEMINI.md and AGENTS.md via .agent/scripts/sync-instructions.sh";
export const ROOT_INSTRUCTION_SNAPSHOT_START = "<!-- BEGIN ITERATIVE-PLANNER MANAGED SNAPSHOT -->";
export const ROOT_INSTRUCTION_SNAPSHOT_END = "<!-- END ITERATIVE-PLANNER MANAGED SNAPSHOT -->";
export const ROOT_INSTRUCTION_SECTION_HEADINGS = ROOT_INSTRUCTION_SOURCE_OF_TRUTH.section_headings;

export const ROOT_INSTRUCTION_TARGETS = Object.freeze([
  Object.freeze({
    id: "claude",
    path: "CLAUDE.md",
    agents: Object.freeze(["Claude"]),
    create_by_default: true,
    default_from_template: true,
    trace_support: Object.freeze({
      status: "supported",
      method: "PostToolUse hook to tool_trace.jsonl",
      setup: "install.mjs --trace-hook",
      gate_behavior: "trace audit can use captured hook events",
    }),
  }),
  Object.freeze({
    id: "gemini_antigravity",
    path: "GEMINI.md",
    agents: Object.freeze(["Gemini", "Antigravity"]),
    create_by_default: true,
    default_from_template: true,
    trace_support: Object.freeze({
      status: "adapter",
      method: "Antigravity trace JSONL import",
      setup: "trace_auditor.mjs --import-antigravity <file>",
      gate_behavior: "trace audit can use imported Antigravity events when provided",
    }),
  }),
  Object.freeze({
    id: "codex_agents",
    path: "AGENTS.md",
    agents: Object.freeze(["Codex", "AGENTS-style"]),
    create_by_default: true,
    default_from_template: true,
    trace_support: Object.freeze({
      status: "not_applicable",
      method: "external PostToolUse hook unavailable",
      setup: "none",
      gate_behavior: "Codex sessions record a clean trace-audit skip",
    }),
  }),
  Object.freeze({
    id: "cursor",
    path: ".cursor/rules/iterative-planner.mdc",
    agents: Object.freeze(["Cursor"]),
    create_by_default: false,
    default_prefix: "---\ndescription: Iterative Planner runtime snapshot\nalwaysApply: true\n---\n\n# Iterative Planner Runtime Snapshot\n\n",
    trace_support: Object.freeze({
      status: "supported",
      method: "PostToolUse hook, Claude Code compatible",
      setup: "install.mjs --trace-hook",
      gate_behavior: "trace audit can use captured hook events",
    }),
  }),
  Object.freeze({
    id: "vscode",
    path: ".github/copilot-instructions.md",
    agents: Object.freeze(["VS Code"]),
    create_by_default: false,
    default_prefix: "# Iterative Planner Runtime Snapshot\n\n",
    trace_support: Object.freeze({
      status: "supported",
      method: "PostToolUse hook when running Claude Code in VS Code",
      setup: "install.mjs --trace-hook",
      gate_behavior: "trace audit can use captured hook events when the IDE exposes them",
    }),
  }),
]);

function normalizeNewlines(content) {
  return String(content || "").replace(/\r\n/g, "\n");
}

function normalizeSnapshot(content) {
  return normalizeNewlines(content).trim().replace(/[ \t]+$/gm, "");
}

function stripNamedLevelTwoSections(content, headings, { startAfterHeading = null } = {}) {
  const lines = normalizeNewlines(content).split("\n");
  const removable = new Set(headings);
  const startIndex = startAfterHeading
    ? lines.findIndex((line) => line.trim() === startAfterHeading)
    : -1;
  if (startAfterHeading && startIndex === -1) return normalizeNewlines(content);

  const output = [];
  let skipping = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.trim();
    const eligible = !startAfterHeading || index > startIndex;
    if (eligible && removable.has(heading)) {
      skipping = true;
      continue;
    }
    if (skipping && /^##\s+/.test(heading)) skipping = false;
    if (!skipping) output.push(line);
  }
  return output.join("\n");
}

function stripLegacyManagedSectionDuplicates(content) {
  return stripNamedLevelTwoSections(content, ROOT_INSTRUCTION_SECTION_HEADINGS, {
    startAfterHeading: "## Session Reference",
  });
}

function stripCanonicalSectionsFromTemplate(content) {
  return stripNamedLevelTwoSections(content, ROOT_INSTRUCTION_SECTION_HEADINGS);
}

function finalizeRenderedRootInstruction(content) {
  return stripLegacyManagedSectionDuplicates(content)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

export function extractMarkdownSection(content, heading) {
  const text = normalizeNewlines(content);
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

export function collectCanonicalRootInstructionSections(templateContent) {
  return ROOT_INSTRUCTION_SECTION_HEADINGS
    .map((heading) => extractMarkdownSection(templateContent, heading))
    .filter(Boolean);
}

export function buildManagedRootInstructionSnapshot(canonicalSections) {
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

export function rootInstructionsLookPlannerManaged(content) {
  const text = String(content || "");
  return text.includes(ROOT_INSTRUCTION_CANONICAL_COMMENT) || text.includes("# Project Instructions - Iterative Planner") || text.includes("# Project Instructions — Iterative Planner");
}

export function rootInstructionSnapshotPresent(content) {
  const text = String(content || "");
  return text.includes(ROOT_INSTRUCTION_SNAPSHOT_START) && text.includes(ROOT_INSTRUCTION_SNAPSHOT_END);
}

export function extractManagedRootInstructionSnapshot(content) {
  const text = normalizeNewlines(content);
  const start = text.indexOf(ROOT_INSTRUCTION_SNAPSHOT_START);
  const end = text.indexOf(ROOT_INSTRUCTION_SNAPSHOT_END);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + ROOT_INSTRUCTION_SNAPSHOT_END.length);
}

export function rootInstructionsHaveCurrentFrontDoors(content, canonicalSections) {
  if (!String(content || "").trim()) return false;
  return canonicalSections.every((section) => String(content || "").includes(section));
}

export function rootInstructionSnapshotMatchesCanonical(content, canonicalSections) {
  const actual = extractManagedRootInstructionSnapshot(content);
  if (!actual) return false;
  return normalizeSnapshot(actual) === normalizeSnapshot(buildManagedRootInstructionSnapshot(canonicalSections));
}

export function applyManagedRootInstructionSnapshot(content, canonicalSections) {
  const text = normalizeNewlines(content);
  const snapshot = buildManagedRootInstructionSnapshot(canonicalSections);
  const start = text.indexOf(ROOT_INSTRUCTION_SNAPSHOT_START);
  const end = text.indexOf(ROOT_INSTRUCTION_SNAPSHOT_END);

  if (start !== -1 && end !== -1 && end > start) {
    const before = text.slice(0, start).replace(/\s*$/, "");
    const after = text.slice(end + ROOT_INSTRUCTION_SNAPSHOT_END.length).replace(/^\s*/, "");
    return finalizeRenderedRootInstruction(`${before}\n\n${snapshot}\n\n${after}`);
  }

  const prefixMatch = text.match(/^((?:#.*\n)?(?:<!--[\s\S]*?-->\n)?\n*)/);
  const prefix = prefixMatch?.[1] || "";
  const remainder = text.slice(prefix.length).replace(/^\s*/, "");
  return finalizeRenderedRootInstruction(`${prefix}${snapshot}\n\n${remainder}`);
}

export function rootInstructionTargetForPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  return ROOT_INSTRUCTION_TARGETS.find((target) => target.path === normalized) || null;
}

export function rootInstructionPortabilityMatrix() {
  return ROOT_INSTRUCTION_TARGETS.map((target) => Object.freeze({
    id: target.id,
    path: target.path,
    agents: Object.freeze([...target.agents]),
    default_created: Boolean(target.create_by_default),
    managed_when_present: target.create_by_default
      ? "created_or_refreshed_by_default"
      : "refreshed_only_when_existing_or_marked_planner_managed",
    source_of_truth: ROOT_INSTRUCTION_SOURCE_OF_TRUTH.template_path,
    snapshot_markers: Object.freeze([ROOT_INSTRUCTION_SNAPSHOT_START, ROOT_INSTRUCTION_SNAPSHOT_END]),
    host_owned_policy: "preserve content outside the managed snapshot block",
    trace_support: Object.freeze({ ...(target.trace_support || {}) }),
  }));
}

export function shouldManageRootInstructionTarget({ target, exists, content }) {
  if (!target) return false;
  if (!exists) return !!target.create_by_default;
  return rootInstructionSnapshotPresent(content) || rootInstructionsLookPlannerManaged(content);
}

export function defaultRootInstructionContent({ target, templateContent, canonicalSections }) {
  if (target?.default_from_template && String(templateContent || "").trim()) {
    return applyManagedRootInstructionSnapshot(
      stripCanonicalSectionsFromTemplate(templateContent),
      canonicalSections,
    );
  }
  return `${target?.default_prefix || ""}${buildManagedRootInstructionSnapshot(canonicalSections)}\n`;
}

export function renderRootInstructionTarget({ target, exists, content, templateContent, canonicalSections }) {
  const current = normalizeNewlines(content);
  if (!shouldManageRootInstructionTarget({ target, exists, content: current })) {
    return {
      target,
      status: "skipped_custom",
      managed: false,
      changed: false,
      content: current,
    };
  }

  const base = exists
    ? current
    : defaultRootInstructionContent({ target, templateContent, canonicalSections });
  const rendered = applyManagedRootInstructionSnapshot(base, canonicalSections);
  const changed = !exists || rendered !== current;
  return {
    target,
    status: exists ? (changed ? "refreshed" : "unchanged") : "created",
    managed: true,
    changed,
    content: rendered,
  };
}

export function rootInstructionParityStatus({ target, exists, content, canonicalSections }) {
  if (!exists) {
    return target?.create_by_default ? "missing" : "absent_optional";
  }
  const managed = shouldManageRootInstructionTarget({ target, exists, content });
  if (!managed) return "custom_unmanaged";
  if (!rootInstructionSnapshotPresent(content)) return "missing_snapshot";
  return rootInstructionSnapshotMatchesCanonical(content, canonicalSections) ? "current" : "stale_snapshot";
}
