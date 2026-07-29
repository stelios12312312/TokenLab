// plan_scaffold.mjs — deterministic mechanical section scaffolding for plan.md.
//
// Reduces ritual on plan-to-execute by prefilling the sections that gates
// GATE-PLN-003, GATE-PLN-018, GATE-PLN-019, and GATE-PLN-020 check, while
// leaving agent-authored content untouched.

import { computeVerificationObligationSynthesis } from "./verification_obligations.mjs";
import { deriveTaskProfileContract } from "./task_profile_contracts.mjs";
import { deriveTaskFocusContract, summarizeTaskFocusContract } from "./task_focus_contract.mjs";
import { classifyPlannerPreflight, extractFilesToModify } from "./plan_utils.mjs";

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function sentenceCase(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function bulletList(items) {
  const compact = (Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return compact.length > 0 ? compact.map((item) => `- ${item}`).join("\n") : "- *None identified.*";
}

function inlineList(items, fallback = "N/A") {
  const compact = (Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return compact.length > 0 ? compact.join(", ") : fallback;
}

function formatPlannedFiles(files) {
  const list = (Array.isArray(files) ? files : [])
    .map((f) => String(f || "").trim())
    .filter(Boolean);
  if (list.length === 0) return "*To be determined after EXPLORE.*";
  return bulletList(list);
}

function inferRepoContext(goal, files) {
  const hasRuntime = files.some((f) => /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rs|php|rb)$/.test(f));
  const hasTests = files.some((f) => /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\./.test(f));
  const hasDocs = files.some((f) => /\.(md|txt|rst)$/.test(f));
  const hasConfig = files.some((f) => /(^|\/)(config|configs)\/|\.json$|\.ya?ml$/.test(f));

  const parts = [];
  if (hasRuntime) parts.push("runtime code");
  if (hasTests) parts.push("tests");
  if (hasDocs) parts.push("documentation");
  if (hasConfig) parts.push("configuration");

  if (parts.length === 0) {
    return "Project artifact change; specific system boundary to be confirmed during EXPLORE.";
  }
  return `This change touches ${parts.join(", ")} in the repository. Goal: ${sentenceCase(goal)}.`;
}

function inferTaskShape(planShape) {
  const primary = planShape?.primary || "unknown";
  const source = planShape?.source || "goal_text";
  const requirements = planShape?.requirements || {};
  const pieces = [`Detected plan shape: ${primary} (source: ${source}).`];
  if (requirements.root_cause) pieces.push("Requires root-cause documentation.");
  if (requirements.adjacency) pieces.push("Requires adjacency/blast-radius mapping.");
  if (requirements.assumption_ledger) pieces.push("Requires an assumption ledger.");
  return pieces.join(" ");
}

export function generateExecutionStepsScaffold({ goal = "", plannedFiles = [], planShape = null } = {}) {
  const files = (Array.isArray(plannedFiles) ? plannedFiles : []).filter(Boolean);
  const goalClause = sentenceCase(goal) || "the goal";
  const lines = [
    `1. EXPLORE: Read the codebase areas relevant to ${goalClause}.`,
  ];

  if (files.length > 0) {
    lines.push(`2. DESIGN: Confirm the change surface across the files to modify:`);
    for (const file of files.slice(0, 8)) {
      lines.push(`   - \`${file}\``);
    }
    if (files.length > 8) lines.push(`   - … and ${files.length - 8} more.`);
    lines.push(`3. IMPLEMENT: Edit the planned files to satisfy ${goalClause}.`);
  } else {
    lines.push(`2. DESIGN: Identify the concrete files and boundaries to change.`);
    lines.push(`3. IMPLEMENT: Edit the planned files to satisfy ${goalClause}.`);
  }

  lines.push(`4. TEST: Run the relevant unit/integration tests and record evidence in verification.md.`);

  if (planShape?.primary && planShape.primary !== "unknown") {
    lines.push(`5. SHAPE-SPECIFIC: Satisfy ${planShape.primary}-shape obligations (findings, root cause, adjacency, or assumption ledger as required).`);
  }

  lines.push(`6. VERIFY: Run the plan-to-execute gate and address any remaining PLN-*** findings.`);
  return lines.join("\n");
}

export function generateVerificationObligationSynthesisScaffold({
  cwd = process.cwd(),
  planDir = null,
  goal = "",
  plannedFiles = [],
  planShape = null,
  storyRegistry = null,
  taskFocusContract = null,
} = {}) {
  const synthesis = computeVerificationObligationSynthesis({
    cwd,
    planDir,
    planContent: `## Goal\n${goal}\n\n## Files To Modify\n${formatPlannedFiles(plannedFiles)}`,
    storyRegistry,
    planShape,
    taskFocusContract,
  });

  const goalClause = sentenceCase(goal) || "the goal";
  const files = Array.isArray(plannedFiles) ? plannedFiles.filter(Boolean) : [];

  const repoContext = firstNonEmptyString(
    synthesis.source_summary?.repo_contexts?.join(", "),
    inferRepoContext(goal, files)
  );

  const taskShape = inferTaskShape(planShape);

  const ontologySignals = synthesis.source_summary?.ontology_signals || [];
  const personaSignals = synthesis.source_summary?.persona_signals || [];
  const boundaries = synthesis.source_summary?.system_boundaries || [];

  const obligations = synthesis.obligations || [];
  const blockingObligations = obligations.filter((o) => o.blocking !== false);
  const obligationsText = blockingObligations.length > 0
    ? blockingObligations.map((o) => `${o.label}: ${o.rationale}`).join("; ")
    : (obligations.length > 0
      ? "Advisory obligations only; no blocking proof obligations required."
      : "No synthesized verification obligations required for this plan context.");
  const focusSummary = summarizeTaskFocusContract(synthesis.task_focus_contract);
  const proofFamilies = inlineList(synthesis.task_focus_contract?.required_proof_families, "No focus-specific proof families");

  const lines = [
    `- Task focus contract: ${focusSummary}`,
    `- Repo/system context: ${repoContext}`,
    `- Task shape: ${taskShape}`,
    `- Ontology signals: ${inlineList(ontologySignals, "N/A - no ontology signals")}`,
    `- Persona signals: ${inlineList(personaSignals, "N/A - no persona signals")}`,
    `- System boundaries touched: ${boundaries.length > 0 ? boundaries.join(", ") : "To be confirmed during EXPLORE."}`,
    `- Focus proof families: ${proofFamilies}`,
    `- Derived verification obligations: ${obligationsText}`,
  ];

  return lines.join("\n");
}

export function generateSemanticUpkeepContractScaffold({
  goal = "",
  plannedFiles = [],
  planShape = null,
  classification = null,
  taskFocusContract = null,
} = {}) {
  const derived = deriveTaskProfileContract({
    goalText: goal,
    plannedFiles,
    classification,
    taskFocusContract,
  });

  const profile = derived.task_profile;
  const upkeep = derived.semantic_upkeep;
  const validation = derived.validation_bundle;

  const lines = [
    `- Profile: ${profile.id} — ${profile.label}. ${profile.reason}`,
    `- Ontology action: ${upkeep.required ? upkeep.ontology_action : "none"}`,
    `- Story action: ${upkeep.required ? upkeep.story_action : "none"}`,
    `- Validation bundle: ${validation.id} — ${validation.reason}`,
    `- Strictness mode: ${derived.strictness_mode}`,
    `- Close blocker if skipped: ${upkeep.close_blocker_if_skipped}`,
  ];

  return lines.join("\n");
}

function sectionExists(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## ${escaped}\\s*$`, "m").test(String(content || ""));
}

function insertSection(content, heading, body) {
  const normalizedContent = String(content || "").trimEnd();
  const section = `## ${heading}\n${body.trim()}\n`;
  return `${normalizedContent}\n\n${section}`;
}

export function ensurePlanScaffoldSections(planContent, {
  goal = "",
  plannedFiles = [],
  planShape = null,
  cwd = process.cwd(),
  planDir = null,
  storyRegistry = null,
} = {}) {
  let content = String(planContent || "");
  const inserted = [];
  const classification = classifyPlannerPreflight(goal, { plannedFiles });
  const taskFocusContract = deriveTaskFocusContract({
    cwd,
    planDir,
    goalText: goal,
    plannedFiles,
    planShape,
    triage: classification,
  });

  if (!sectionExists(content, "Execution Steps") && !sectionExists(content, "Steps")) {
    content = insertSection(content, "Execution Steps", generateExecutionStepsScaffold({ goal, plannedFiles, planShape }));
    inserted.push("Execution Steps");
  }

  if (!sectionExists(content, "Verification Obligation Synthesis")) {
    content = insertSection(content, "Verification Obligation Synthesis", generateVerificationObligationSynthesisScaffold({
      cwd,
      planDir,
      goal,
      plannedFiles,
      planShape,
      storyRegistry,
      taskFocusContract,
    }));
    inserted.push("Verification Obligation Synthesis");
  }

  if (!sectionExists(content, "Semantic Upkeep Contract")) {
    content = insertSection(content, "Semantic Upkeep Contract", generateSemanticUpkeepContractScaffold({
      goal,
      plannedFiles,
      planShape,
      classification,
      taskFocusContract,
    }));
    inserted.push("Semantic Upkeep Contract");
  }

  return { content, inserted };
}
