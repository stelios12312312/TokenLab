// repair_packet.mjs
//
// Shared renderer for deterministic gate repair surfaces. Gate predicates still
// own truth; this helper only formats already-computed diagnostics into one
// consistent, low-friction surface for agents to follow.

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillRoot = resolve(__dirname, "../..");

const VALID_SCAFFOLD_MODES = new Set(["on", "off", "examples-only"]);

export function normalizeScaffoldMode(env = process.env) {
  const raw = String(env?.PLANNER_SCAFFOLDS || "on").trim().toLowerCase();
  if (VALID_SCAFFOLD_MODES.has(raw)) return raw;
  if (["0", "false", "no"].includes(raw)) return "off";
  if (["1", "true", "yes"].includes(raw)) return "on";
  return "on";
}

export function gateRepairTemplatePath(gateId) {
  const id = String(gateId || "").trim();
  if (!/^[A-Z0-9-]+$/.test(id)) return null;
  return join(skillRoot, "config", "gate_templates", `${id}.json`);
}

export function loadGateRepairTemplate(gateId) {
  const templatePath = gateRepairTemplatePath(gateId);
  if (!templatePath || !existsSync(templatePath)) return null;
  try {
    return JSON.parse(readFileSync(templatePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeLines(value) {
  if (Array.isArray(value)) return value.map((line) => String(line));
  if (value === null || value === undefined) return [];
  return String(value).split("\n");
}

function pushSection(lines, heading, bodyLines) {
  const body = normalizeLines(bodyLines).filter((line) => line !== null && line !== undefined);
  if (body.length === 0) return;
  lines.push(`${heading}:`);
  lines.push(...body);
}

function formatAutoFix(template) {
  if (template?.autofix && typeof template.autofix === "object") {
    if (template.autofix.command) return [`Run: ${template.autofix.command}`];
    if (template.autofix.text) return normalizeLines(template.autofix.text);
  }
  if (typeof template?.autofix === "string" && template.autofix.trim()) {
    return normalizeLines(template.autofix);
  }
  return ["None - this gate requires substantive authoring before retry."];
}

export function renderEvidenceGuidanceLines(guidance, { indent = "", compact = false } = {}) {
  if (!guidance?.required) return [];
  const prefix = String(indent || "");
  const lines = [];
  lines.push(`${prefix}Evidence guidance:`);
  lines.push(`${prefix}- Required columns: ${guidance.required_columns.join(" | ")}`);
  lines.push(`${prefix}- Criterion cells: ${guidance.criterion_references}`);
  if ((guidance.suggested_proof_ids || []).length > 0) {
    lines.push(`${prefix}- Suggested proof IDs: ${guidance.suggested_proof_ids.join(", ")}`);
  }
  if (!compact && (guidance.obligations || []).length > 0) {
    lines.push(`${prefix}- Obligation proof families:`);
    for (const obligation of guidance.obligations) {
      const proofIds = obligation.proof_ids.length > 0 ? obligation.proof_ids.join(", ") : "proof-family keywords";
      lines.push(`${prefix}  - ${obligation.label}: ${proofIds}`);
    }
  }
  lines.push(`${prefix}- Example row shape: ${guidance.example_row_shape}`);
  lines.push(`${prefix}- Lint before transition: ${guidance.diagnostics_command}`);
  return lines;
}

export function renderEvidenceGuidance(guidance, options = {}) {
  return renderEvidenceGuidanceLines(guidance, options).join("\n");
}

export function renderRepairSurface({
  template,
  gateId = null,
  title = null,
  primaryArtifact = null,
  missing = [],
  actions = [],
  diagnostics = [],
  retry = null,
  sections = [],
  env = process.env,
} = {}) {
  const mode = normalizeScaffoldMode(env);
  const gate = String(template?.gate_id || gateId || "GATE").trim();
  const packetTitle = String(title || template?.title || template?.summary || "Repair required").trim();
  const missingLines = normalizeLines(missing);
  const retryCommand = retry || template?.retry || null;
  const lines = [`[${gate}] Repair Surface: ${packetTitle}`];
  if (primaryArtifact) lines.push(`Primary artifact: ${primaryArtifact}`);

  if (mode === "off") {
    lines.push("Scaffolds: disabled by PLANNER_SCAFFOLDS=off.");
    pushSection(lines, "Missing", missingLines.length > 0 ? missingLines : ["See failed gate checks above."]);
    pushSection(lines, "Actions", actions);
    pushSection(lines, "Diagnostics", diagnostics);
    if (retryCommand) pushSection(lines, "Retry", [retryCommand]);
    return lines;
  }

  lines.push(`Scaffolds: ${mode}`);
  pushSection(lines, "Missing", missingLines.length > 0 ? missingLines : ["See failed gate checks above."]);
  pushSection(lines, "Accepted patterns", template?.accepted_patterns || []);

  if (mode === "on") {
    const pasteTemplate = normalizeLines(template?.paste_template || template?.template || []);
    if (pasteTemplate.length > 0) {
      lines.push(`${template?.paste_heading || "Paste this into the target artifact"}:`);
      lines.push("```markdown");
      lines.push(...pasteTemplate);
      lines.push("```");
    }
  }

  pushSection(lines, "Worked example", template?.worked_example ? [template.worked_example] : []);
  pushSection(lines, "Auto-fix", formatAutoFix(template));
  pushSection(lines, "Actions", actions);
  pushSection(lines, "Diagnostics", diagnostics);
  for (const section of Array.isArray(sections) ? sections : []) {
    pushSection(lines, section?.heading || section?.title || "Details", section?.lines || section?.body || []);
  }
  if (retryCommand) pushSection(lines, "Retry", [retryCommand]);
  return lines;
}

export function renderRepairSurfaceRepeatPointer({ gate = "<gate>", artifactPath = null } = {}) {
  const lines = [`Repair Surface unchanged for ${gate}.`];
  if (artifactPath) lines.push(`Full copy: ${artifactPath}`);
  lines.push(`Retry after edits: node .agent/skills/iterative-planner/scripts/transition.mjs ${gate}`);
  return lines;
}

export function repairSurfaceOutputVolumeLines() {
  const template = loadGateRepairTemplate("GATE-ETR-008");
  const first = renderRepairSurface({
    template,
    gateId: "GATE-ETR-008",
    title: "Red-team vectors have content depth",
    primaryArtifact: "plans/<plan-dir>/red_team_notes.md",
    missing: [
      "[GATE-ETR-008] Red-team vector content depth - Vector 1: title still uses placeholder text; missing impact detail.",
      "[GATE-REF-004] Knowledge base sign-off - add a real no-new-learnings reason or update the KB.",
    ],
    actions: [
      "Fix the failed checks above.",
      "Run the truth command before retrying the transition.",
    ],
    diagnostics: [
      "Truth command: node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect --dry-run --plan <plan-dir>",
      "Deep diagnostics: node .agent/skills/iterative-planner/scripts/planner_findings.mjs --dir . --plan <plan-dir> --gate execute-to-reflect --json",
    ],
    retry: "node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect",
    env: { PLANNER_SCAFFOLDS: "on" },
  });
  const repeat = renderRepairSurfaceRepeatPointer({
    gate: "execute-to-reflect",
    artifactPath: "plans/<plan-dir>/artifacts/.repair_surface_execute-to-reflect.json",
  });
  return {
    source: "repair_surface.renderer",
    source_status: "live_repair_surface_counter",
    blocked_first: first.length + 1,
    blocked_repeat: repeat.length + 1,
    pre_dedupe_baseline: 234,
    baseline_blocked_first: 99,
    baseline_blocked_repeat: 79,
  };
}
