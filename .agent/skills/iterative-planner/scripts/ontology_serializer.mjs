#!/usr/bin/env node
// ontology_serializer.mjs — Converts project artifacts into traceability Prolog facts.
//
// Reads story_registry.json, plan.md, verification.md, decisions.md,
// and @planner: annotations, then emits a richer set of Prolog facts
// that enable graph-level traceability reasoning.
//
// The existing fact_loader.mjs asserts flat story facts:
//   story(Id, Title, Priority, Status), code_ref(Id, Path), etc.
//
// This serializer adds ontology-level facts:
//   business_goal(Id, Label).
//   goal_requires(GoalId, CriterionId).
//   success_criterion(Id, Label).
//   criterion_story(CriterionId, StoryId).
//   recipe_entity(EntityId, Title).
//   recipe_capability(CapabilityId, Title).
//   recipe_contract(RecipeId, CapabilityId, Title).
//   validation_artifact(Path, CriterionId).
//   audit_pass(Id, Perspective).
//   audit_perspective(Name).
//
// These facts let Prolog answer multi-hop traceability queries:
//   "Is there an unbroken chain from every goal to validated evidence?"
//
// Usage:
//   node ontology_serializer.mjs                    Print Prolog facts to stdout
//   node ontology_serializer.mjs --dir <path>       Override project directory
//   node ontology_serializer.mjs --json             Output as JSON instead
//
// Programmatic:
//   import { serializeToFacts } from "./ontology_serializer.mjs";
//   const facts = serializeToFacts({ cwd, storyRegistry, planContent, ... });

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { parseAnnotations, walkDir } from "./annotation_parser.mjs";
import { parseMarkdownTable as parseSharedMarkdownTable } from "./lib/markdown_table.mjs";
import {
  sanitizeAtom as sanitize,
  sanitizeStrictId as sanitizeId,
  sanitizeEnumAtom,
} from "./lib/sanitize.mjs";
import {
  analyzeIntentContract,
  extractFilesToModify,
  loadFindingsLedger,
  loadIntentContract,
} from "./lib/plan_utils.mjs";
import { computePlanLearnedObligationsSignal } from "./lib/learned_obligations.mjs";
import { computeMistakeRegistrySignal, loadMistakeRegistry } from "./lib/mistake_registry.mjs";
import { loadRetroRegistry } from "./lib/retro_registry.mjs";
import { extractPersonaPackId, summarizePersonaArtifacts } from "./lib/persona_artifacts.mjs";
import { computeVerificationObligationSynthesis } from "./lib/verification_obligations.mjs";
import {
  criterionMatchesVerificationRow,
  extractSuccessCriteria,
  getTableCell,
  normalizeMatrixText,
  selectCriterionStoryTable,
} from "./lib/verification_matrix.mjs";
import { loadPlanWorkOrder } from "./lib/work_order_contract.mjs";
import { compileQuantGateHardeningFacts } from "./lib/quant_gate_hardening.mjs";
import { computeQuantResultsValidationSignal } from "./lib/quant_results_validation.mjs";
import { computeReviewIntake } from "./lib/review_intake.mjs";
import { compileJournalMemoryFacts } from "./lib/journal_memory.mjs";
import { collectIssueHistoryFactBundle } from "./lib/issue_history_facts.mjs";
import {
  normalizePresentationResult,
  normalizeVerificationMode,
  syncLedgerFromStrategy,
} from "./lib/verification_truth.mjs";
import {
  deriveAntiRecurrencePresentationStatus,
  verificationStatusIsPass,
} from "./lib/verification_status_vocabulary.mjs";
import { readEffectiveVerificationStrategy } from "./lib/verification_strategy.mjs";

// Sanitization delegated to shared lib/sanitize.mjs:
//   sanitize()    = sanitizeAtom    — free-text labels, descriptions
//   sanitizeId()  = sanitizeStrictId — structured IDs, file paths

// ---------------------------------------------------------------------------
// Safe file reader
// ---------------------------------------------------------------------------

const MAX_BYTES = 1_048_576;

function safeRead(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (st.size > MAX_BYTES) return null;
    return readFileSync(filePath, "utf-8");
  } catch { return null; }
}

function closeSignalRequiredAtom(signal) {
  if (typeof signal?.required === "boolean") return signal.required ? "true" : "false";
  return "unknown";
}

function closeSignalSatisfiedAtom(signal) {
  if (signal && typeof signal === "object" && signal.required === false) return "not_required";
  if (typeof signal?.satisfied === "boolean") return signal.satisfied ? "true" : "false";
  return "unknown";
}

function closeSignalStatusValue(signal, fallbackWhenPresent = "not_required") {
  if (!signal || typeof signal !== "object") return "unknown";
  if (signal.status) return signal.status;
  if (signal.required === false) return "not_required";
  return fallbackWhenPresent;
}

function safeReadJson(filePath) {
  const content = safeRead(filePath);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeRecipeRunner(rawRunner) {
  if (!rawRunner || typeof rawRunner !== "object" || Array.isArray(rawRunner)) return null;
  const type = firstNonEmptyString(rawRunner.type);
  const command = asStringList(rawRunner.command);
  if (!type || command.length === 0) return null;
  return {
    type,
    cwd: firstNonEmptyString(rawRunner.cwd, "."),
    command,
    dryRunFlags: asStringList(rawRunner.dry_run_flags),
    liveFlags: asStringList(rawRunner.live_flags),
  };
}

function normalizeDeclaredModes(ledger) {
  const raw = Array.isArray(ledger?.supported_modes)
    ? ledger.supported_modes
    : Array.isArray(ledger?.declared_modes)
      ? ledger.declared_modes
      : [];

  return raw.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) {
      return [{ mode: entry.trim(), source: "verification_ledger" }];
    }
    if (!entry || typeof entry !== "object") return [];

    const mode = firstNonEmptyString(entry.mode, entry.id, entry.name);
    if (!mode) return [];

    const source = firstNonEmptyString(
      entry.declared_by,
      entry.source,
      entry.source_id,
      "verification_ledger",
    );

    return [{ mode, source }];
  });
}

function extractSubjectRefs(subject, keys) {
  const values = [];
  for (const key of keys) {
    values.push(...asStringList(subject?.[key]));
  }
  return values;
}

function loadVerificationLedger(planDir) {
  if (!planDir) return null;
  const ledgerPath = join(planDir, "verification_ledger.json");
  const parsed = safeReadJson(ledgerPath);
  if (!parsed) return null;

  return {
    subjects: Array.isArray(parsed.subjects) ? parsed.subjects.filter(Boolean) : [],
    declaredModes: normalizeDeclaredModes(parsed),
    obligations: Array.isArray(parsed.obligations) ? parsed.obligations.filter(Boolean) : [],
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter(Boolean) : [],
    waivers: Array.isArray(parsed.waivers) ? parsed.waivers.filter(Boolean) : [],
  };
}

function verificationSubjectAliasKey(subjectId) {
  const raw = String(subjectId || "").trim();
  if (!raw) return null;
  const knownPrefixes = [
    "plan:verification-obligation-synthesis:",
    "verification-obligation-synthesis:",
    "verification_obligation_synthesis:",
  ];
  const prefix = knownPrefixes.find((candidate) => raw.toLowerCase().startsWith(candidate));
  const leaf = prefix ? raw.slice(prefix.length) : raw;
  return leaf.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function buildVerificationSubjectCanonicalizer(ledger) {
  const ids = [];
  const explicitAliases = new Map();
  for (const subject of ledger?.subjects || []) {
    const subjectId = firstNonEmptyString(subject?.id, subject?.subject_id);
    ids.push(subjectId);
    for (const alias of asStringList(subject?.aliases)) {
      ids.push(alias);
      if (subjectId) explicitAliases.set(alias, subjectId);
    }
  }
  for (const obligation of ledger?.obligations || []) ids.push(firstNonEmptyString(obligation?.subject, obligation?.subject_id));
  for (const evidence of ledger?.evidence || []) ids.push(firstNonEmptyString(evidence?.subject, evidence?.subject_id));
  for (const waiver of ledger?.waivers || []) ids.push(firstNonEmptyString(waiver?.subject, waiver?.subject_id));

  const byKey = new Map();
  for (const id of ids.filter(Boolean)) {
    const key = verificationSubjectAliasKey(id);
    if (!key) continue;
    const current = byKey.get(key);
    // Prefer the exact leaf-form authored subject over the planner synthesis
    // prefix. Otherwise use the shortest deterministic spelling.
    const preferred = id === key
      ? id
      : (!current || id.length < current.length ? id : current);
    byKey.set(key, preferred);
  }

  return (subjectId) => {
    const raw = String(subjectId || "").trim();
    if (!raw) return raw;
    if (explicitAliases.has(raw)) return explicitAliases.get(raw);
    const key = verificationSubjectAliasKey(raw);
    const isSynthesis = /^plan:verification-obligation-synthesis:/i.test(raw);
    if (!isSynthesis && !ids.includes(raw)) return raw;
    return byKey.get(key) || raw;
  };
}

function loadRecipeOntologySurface(cwd) {
  const recipesDir = join(cwd, "recipes");
  const entityRegistry = safeReadJson(join(recipesDir, "entity_registry.json"));
  const capabilityRegistry = safeReadJson(join(recipesDir, "capability_registry.json"));

  const entities = Array.isArray(entityRegistry?.entities)
    ? entityRegistry.entities
        .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim())
        .map((entry) => ({
          id: entry.id.trim(),
          title: firstNonEmptyString(entry.title, entry.name, entry.id),
          aliases: asStringList(entry.aliases),
          recipeIds: asStringList(entry.recipe_ids),
          systems: entry.systems && typeof entry.systems === "object" ? entry.systems : {},
        }))
    : [];

  const capabilities = Array.isArray(capabilityRegistry?.capabilities)
    ? capabilityRegistry.capabilities
        .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim())
        .map((entry) => ({
          id: entry.id.trim(),
          title: firstNonEmptyString(entry.title, entry.name, entry.id),
          triggers: Array.isArray(entry.triggers) ? entry.triggers : [],
          recipeIds: asStringList(entry.recipe_ids || entry.recipes),
          requiredParams: asStringList(entry.required_params),
          skills: asStringList(entry.skills),
          supportedEntities: asStringList(entry.supported_entities),
        }))
    : [];

  const recipes = [];
  if (existsSync(recipesDir)) {
    for (const name of readdirSync(recipesDir)) {
      const recipeJson = safeReadJson(join(recipesDir, name, "recipe.json"));
      if (!recipeJson || typeof recipeJson !== "object") continue;
      const recipeId = firstNonEmptyString(recipeJson.id, name);
      if (!recipeId) continue;
      recipes.push({
        id: recipeId,
        title: firstNonEmptyString(recipeJson.title, recipeId),
        capabilityId: firstNonEmptyString(recipeJson.capability_id),
        entityIds: asStringList(recipeJson.entity_ids),
        requiredParams: asStringList(recipeJson.required_params),
        skills: asStringList(recipeJson.skills),
        systems: asStringList(recipeJson.systems),
        scripts: Array.isArray(recipeJson.scripts) ? recipeJson.scripts : [],
        runner: normalizeRecipeRunner(recipeJson.runner),
      });
    }
  }

  return {
    entities,
    capabilities,
    recipes,
    present: entities.length > 0 || capabilities.length > 0 || recipes.length > 0 || !!entityRegistry || !!capabilityRegistry,
  };
}

function loadRecipeDiscoverySurface(cwd) {
  const discoveryPath = join(cwd, "recipes", "discovery_review.json");
  const parsed = safeReadJson(discoveryPath);
  if (!parsed || !Array.isArray(parsed.candidates)) {
    return {
      present: false,
      goal: null,
      candidates: [],
    };
  }

  return {
    present: true,
    goal: firstNonEmptyString(parsed.goal),
    candidates: parsed.candidates
      .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim())
      .map((entry) => ({
        id: entry.id.trim(),
        title: firstNonEmptyString(entry.title, entry.id),
        status: firstNonEmptyString(entry.status, "review_required"),
        capabilityId: firstNonEmptyString(entry.capability_id_guess),
        recipeId: firstNonEmptyString(entry.recipe_id_guess),
        entityId: firstNonEmptyString(entry.entity_id_guess),
        scripts: Array.isArray(entry.scripts)
          ? entry.scripts
              .map((script) => {
                if (typeof script === "string" && script.trim()) return script.trim();
                if (script && typeof script === "object" && typeof script.path === "string" && script.path.trim()) {
                  return script.path.trim();
                }
                return null;
              })
              .filter(Boolean)
          : [],
        decision: firstNonEmptyString(entry.review?.decision, "pending"),
      })),
  };
}

function loadStructuredFindingsLedger(planDir) {
  if (!planDir) return null;
  const ledgerInfo = loadFindingsLedger(planDir);
  const parsed = ledgerInfo?.parsed;
  if (!parsed) return null;

  return {
    findings: Array.isArray(parsed.findings) ? parsed.findings.filter(Boolean) : [],
  };
}

function loadPersonaArtifacts(planDir) {
  const guidance = planDir ? safeReadJson(join(planDir, "persona_guidance.json")) : null;
  const constraints = planDir ? safeReadJson(join(planDir, "persona_constraints.json")) : null;
  const findings = planDir ? safeReadJson(join(planDir, "persona_findings.json")) : null;
  return {
    guidance,
    constraints,
    findings,
    summary: summarizePersonaArtifacts({
      guidanceDoc: guidance,
      constraintsDoc: constraints,
      findingsDoc: findings,
    }),
  };
}

const ANTI_RECURRENCE_TRIGGER_PATTERNS = [
  { label: "retro", pattern: /\bretro(?:spective)?\b/i },
  { label: "postmortem", pattern: /\bpost[- ]?mortem\b/i },
  { label: "bug_hunt", pattern: /\bbug[- ]?hunt(?:ing)?\b/i },
  { label: "bug", pattern: /\bbug(?:fix)?\b/i },
  { label: "defect", pattern: /\bdefect\b/i },
  { label: "regression", pattern: /\bregression\b/i },
  { label: "incident", pattern: /\bincident\b/i },
  { label: "remediation", pattern: /\bremediation\b/i },
  { label: "anti_recurrence", pattern: /\banti[- ]?recurrence\b/i },
  { label: "root_cause", pattern: /\broot[- ]?cause\b/i },
  { label: "red_team", pattern: /\bred[- ]?team\b/i },
  { label: "audit", pattern: /\baudit\b/i },
];

const ANTI_RECURRENCE_GUARD_ALIASES = new Map([
  ["test", "test"],
  ["tests", "test"],
  ["regression_test", "test"],
  ["ontology", "ontology"],
  ["prolog", "ontology"],
  ["rule", "ontology"],
  ["rules", "ontology"],
  ["invariant", "ontology"],
  ["invariants", "ontology"],
  ["annotation", "annotation"],
  ["annotations", "annotation"],
  ["traceability", "annotation"],
  ["story_linkage", "annotation"],
  ["kb", "kb"],
  ["knowledge_base", "kb"],
  ["mistake", "kb"],
  ["mistakes", "kb"],
  ["pattern", "kb"],
  ["patterns", "kb"],
  ["gotcha", "kb"],
  ["gotchas", "kb"],
]);

function extractMarkdownSection(content, heading) {
  if (!content || !heading) return "";
  const headingMatch = String(content).match(new RegExp(`^## ${heading}\\s*$`, "m"));
  if (!headingMatch || headingMatch.index === undefined) return "";

  const afterHeading = String(content).slice(headingMatch.index + headingMatch[0].length).replace(/^\n/, "");
  const nextHeadingMatch = afterHeading.match(/\n## |\n# /);
  return nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
}

function collectAntiRecurrenceTriggerTerms(goalText, planContent) {
  const source = [
    firstNonEmptyString(goalText),
    extractMarkdownSection(planContent, "Fix Classification"),
    extractMarkdownSection(planContent, "Problem Statement"),
  ]
    .filter(Boolean)
    .join("\n");

  const terms = [];
  for (const { label, pattern } of ANTI_RECURRENCE_TRIGGER_PATTERNS) {
    if (pattern.test(source)) terms.push(label);
  }
  return [...new Set(terms)];
}

function normalizeAntiRecurrenceGuardType(rawValue) {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/[/|]+/g, ",")
    .replace(/[\s-]+/g, "_");
  return ANTI_RECURRENCE_GUARD_ALIASES.get(normalized) || null;
}

function collectAntiRecurrenceGuardTypes(values) {
  const rawValues = Array.isArray(values) ? values : [values];
  const guardTypes = new Set();

  for (const rawValue of rawValues) {
    if (Array.isArray(rawValue)) {
      for (const nested of collectAntiRecurrenceGuardTypes(rawValue)) guardTypes.add(nested);
      continue;
    }
    if (typeof rawValue !== "string" || !rawValue.trim()) continue;
    const parts = rawValue.split(/[;,/|]+/);
    for (const part of parts) {
      const normalized = normalizeAntiRecurrenceGuardType(part);
      if (normalized) guardTypes.add(normalized);
    }
  }

  return [...guardTypes];
}

function extractAntiRecurrenceMarkdownEvidence(verificationContent) {
  const section = extractMarkdownSection(verificationContent, "Anti-Recurrence Guard");
  if (!section.trim()) return { satisfied: false, guardTypes: [] };

  const { passRecorded, guardValues } = deriveAntiRecurrencePresentationStatus(section);
  const guardTypes = collectAntiRecurrenceGuardTypes(guardValues);

  return {
    satisfied: passRecorded && guardTypes.length > 0,
    guardTypes,
  };
}

// ---------------------------------------------------------------------------
// Goal extraction from plan.md
// ---------------------------------------------------------------------------

function extractGoals(planContent) {
  if (!planContent) return [];
  const goals = [];

  // Extract primary goal from ## Goal section
  const goalMatch = planContent.match(/^## Goal\s*\n([\s\S]*?)(?=\n##|\n$)/m);
  if (goalMatch) {
    const label = goalMatch[1].trim().split("\n")[0].trim();
    if (label) {
      goals.push({
        id: "primary_goal",
        label: label.slice(0, 200), // truncate long goals
      });
    }
  }

  return goals;
}

function normalizePath(filePath) {
  return String(filePath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Goal-to-criteria mapping heuristic
// ---------------------------------------------------------------------------

function mapCriteriaToGoals(goals, criteria) {
  // Simple: all criteria map to primary goal (most plans have one goal)
  // Future: parse explicit criterion → goal mappings from annotations
  const links = [];
  const primaryGoal = goals.find(g => g.id === "primary_goal");
  if (primaryGoal) {
    for (const c of criteria) {
      links.push({ goalId: primaryGoal.id, criterionId: c.id });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Criterion-to-story mapping
// ---------------------------------------------------------------------------

function mapCriteriaToStories(criteria, stories, planContent, workOrder = null) {
  const links = [];
  const seen = new Set();
  const explicitlyLinkedCriteria = new Set();
  const addLink = (criterionId, storyId, { explicit = false } = {}) => {
    const key = `${criterionId}::${storyId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (explicit) explicitlyLinkedCriteria.add(criterionId);
    links.push({ criterionId, storyId });
  };

  // Strategy 1: @planner:proves annotations link files → criteria
  // (handled separately via annotation facts)

  // Strategy 2: shared Verification Strategy reader maps criteria -> stories.
  const table = selectCriterionStoryTable(planContent, { workOrder });
  if (table?.header) {
    const headerCells = table.header.map((cell) => normalizeMatrixText(cell));
    const criterionColumn = headerCells.findIndex((cell) => cell.includes("criterion"));
    const storyColumn = headerCells.findIndex((cell) => cell.includes("story linkage") || cell === "story");
    if (criterionColumn >= 0 && storyColumn >= 0) {
      for (const row of table.rows || []) {
        const criterionCell = getTableCell(row, criterionColumn);
        const storyCell = getTableCell(row, storyColumn);
        const rowText = `${storyCell} ${(row.cells || []).join(" ")}`.toLowerCase();
        for (const c of criteria) {
          if (!criterionMatchesVerificationRow(c, criterionCell)) continue;
          for (const s of stories) {
            if (rowText.includes(String(s.id || "").toLowerCase())) {
              addLink(c.id, s.id, { explicit: true });
            }
          }
        }
      }
    }
  }

  // Strategy 3: Story code_refs overlap with criterion test commands
  // (this is a weaker heuristic, but catches common cases)
  const planFiles = extractFilesToModify(planContent).map(normalizePath);
  if (planFiles.length > 0 && stories.length > 0) {
    for (const story of stories) {
      const storyCodeRefs = Array.isArray(story?.code_refs) ? story.code_refs.map(normalizePath) : [];
      if (storyCodeRefs.length === 0) continue;
      const overlaps = storyCodeRefs.some((codeRef) => planFiles.includes(codeRef));
      if (!overlaps) continue;

      for (const criterion of criteria) {
        if (explicitlyLinkedCriteria.has(criterion.id)) continue;
        addLink(criterion.id, story.id);
      }
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// Validation artifact detection
// ---------------------------------------------------------------------------

function detectValidationArtifacts(cwd, criteria) {
  const artifacts = [];
  const validationDirs = [
    "validation", "validators", "checks", "notebooks",
    "reports", "scripts", "tests/validation",
  ];

  for (const dir of validationDirs) {
    const fullDir = join(cwd, dir);
    if (!existsSync(fullDir)) continue;
    try {
      const files = readdirSync(fullDir);
      for (const file of files) {
        const lower = file.toLowerCase();
        // Match validation files to criteria by keyword
        for (const c of criteria) {
          const keywords = c.label.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 4);
          if (keywords.some(kw => lower.includes(kw))) {
            artifacts.push({
              path: join(dir, file),
              criterionId: c.id,
              confidence: "heuristic",
            });
          }
        }
        // Also detect generic validation patterns
        if (/calibrat|brier|reliability|edge_|baseline|clv/i.test(lower)) {
          artifacts.push({
            path: join(dir, file),
            criterionId: null, // unlinked validation artifact
            confidence: "pattern",
          });
        }
      }
    } catch { /* skip */ }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Audit pass extraction from red_team_notes.md
// ---------------------------------------------------------------------------

function extractAuditPasses(planDir) {
  const passes = [];
  const rtPath = join(planDir, "red_team_notes.md");
  const content = safeRead(rtPath);
  if (!content) return passes;

  // Known perspectives
  const PERSPECTIVES = [
    "code_correctness", "assumptions_challenge", "connectivity",
    "failure_modes", "security", "performance", "data_integrity",
    "output_trustworthiness", "configuration_integrity", "wiring",
  ];

  // Extract ## headings as attack vectors / perspectives
  const headings = content.match(/^##\s+(.+)/gm) || [];
  let passNum = 0;
  for (const h of headings) {
    const heading = h.replace(/^##\s+/, "").toLowerCase();
    passNum++;
    const passId = `rt_pass_${passNum}`;

    // Try to classify the perspective
    let perspective = "general";
    for (const p of PERSPECTIVES) {
      if (heading.includes(p.replace(/_/g, " ")) || heading.includes(p)) {
        perspective = p;
        break;
      }
    }
    // Keyword fallback
    if (perspective === "general") {
      if (/wir|connect|import|integrat/.test(heading)) perspective = "connectivity";
      else if (/calibr|accurac|output|trust/.test(heading)) perspective = "output_trustworthiness";
      else if (/config|flag|toggle/.test(heading)) perspective = "configuration_integrity";
      else if (/assum|claim|evidence|proof/.test(heading)) perspective = "assumptions_challenge";
      else if (/secur|inject|auth/.test(heading)) perspective = "security";
      else if (/fail|error|edge|crash/.test(heading)) perspective = "failure_modes";
      else if (/perf|latenc|speed/.test(heading)) perspective = "performance";
    }

    passes.push({ id: passId, perspective, heading: h.replace(/^##\s+/, "") });
  }

  return passes;
}

// ---------------------------------------------------------------------------
// Verification results extraction
// ---------------------------------------------------------------------------

function extractVerificationResults(planDir) {
  const results = [];
  const vPath = join(planDir, "verification.md");
  const content = safeRead(vPath);
  if (!content) return results;

  const section = extractMarkdownSection(content, "Criteria Verification");
  const { header, rows } = parseMarkdownTable(section);
  if (!header) return results;

  const criterionColumn = findColumnIndex(header, ["criterion"]);
  const resultColumn = findColumnIndex(header, ["result"]);
  const evidenceColumn = findColumnIndex(header, ["evidence"]);
  if ([criterionColumn, resultColumn, evidenceColumn].some((index) => index === -1)) return results;

  for (const row of rows) {
    const criterion = row[criterionColumn] || row[0] || "";
    const status = normalizePresentationResult(row[resultColumn] || "");
    results.push({
      criterion: normalizeTableFactValue(criterion),
      status: status.valid ? status.canonical : status.token,
      evidence: normalizeTableFactValue(row[evidenceColumn] || row[row.length - 1] || ""),
    });
  }

  return results;
}

function parseMarkdownTable(sectionContent) {
  return parseSharedMarkdownTable(sectionContent);
}

function normalizeTableCell(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeTableFactValue(value) {
  let normalized = String(value || "").trim();
  let changed = true;
  while (changed && normalized) {
    changed = false;
    for (const [open, close] of [["`", "`"], ["**", "**"], ["__", "__"], ["*", "*"], ["_", "_"]]) {
      if (
        normalized.startsWith(open) &&
        normalized.endsWith(close) &&
        normalized.length > open.length + close.length
      ) {
        normalized = normalized.slice(open.length, normalized.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  return normalized.replace(/\s+/g, " ").trim();
}

function findColumnIndex(header, candidates) {
  const normalizedHeader = (header || []).map((cell) => normalizeTableCell(cell));
  return normalizedHeader.findIndex((cell) => candidates.some((candidate) => cell.includes(candidate)));
}

function extractActiveMistakeResponse(planContent) {
  const section = extractMarkdownSection(planContent, "Active Mistake Response");
  const { header, rows } = parseMarkdownTable(section);
  if (!header) return [];

  const mistakeColumn = findColumnIndex(header, ["mistake"]);
  const guardColumn = findColumnIndex(header, ["guard"]);
  const handlingColumn = findColumnIndex(header, ["planned handling"]);
  const evidenceColumn = findColumnIndex(header, ["planned evidence"]);
  if ([mistakeColumn, guardColumn, handlingColumn, evidenceColumn].some((index) => index === -1)) return [];

  return rows
    .map((row) => ({
      mistake_id: normalizeTableFactValue(row[mistakeColumn]),
      guard: normalizeTableFactValue(row[guardColumn]),
      planned_handling: normalizeTableFactValue(row[handlingColumn]),
      planned_evidence: normalizeTableFactValue(row[evidenceColumn]),
    }))
    .filter((entry) => entry.mistake_id && entry.guard);
}

function extractActiveMistakeEvidence(verificationContent) {
  const section = extractMarkdownSection(verificationContent, "Active Mistake Evidence");
  const { header, rows } = parseMarkdownTable(section);
  if (!header) return [];

  const mistakeColumn = findColumnIndex(header, ["mistake"]);
  const hookColumn = findColumnIndex(header, ["hook"]);
  const statusColumn = findColumnIndex(header, ["status"]);
  const evidenceColumn = findColumnIndex(header, ["evidence"]);
  if ([mistakeColumn, hookColumn, statusColumn, evidenceColumn].some((index) => index === -1)) return [];

  return rows
    .map((row) => {
      const status = row[statusColumn] || "";
      const evidence = normalizeTableFactValue(row[evidenceColumn]);
      return {
        mistake_id: normalizeTableFactValue(row[mistakeColumn]),
        hook: normalizeTableFactValue(row[hookColumn]),
        status,
        evidence,
        satisfied: verificationStatusIsPass(status, "presentation"),
      };
    })
    .filter((entry) => entry.mistake_id && entry.hook);
}

// ---------------------------------------------------------------------------
// Main serializer
// ---------------------------------------------------------------------------

export function serializeToFacts({
  cwd,
  storyRegistry,
  planDir,
  planContent,
  annotations,
  quantResultsValidationOverride = null,
}) {
  const facts = [];
  const meta = {
    goals: 0,
    criteria: 0,
    goal_criterion_links: 0,
    criterion_story_links: 0,
    validation_artifacts: 0,
    audit_passes: 0,
    annotation_proves: 0,
    verification_results: 0,
    verification_subjects: 0,
    verification_modes: 0,
    verification_obligations: 0,
    verification_evidence: 0,
    verification_waivers: 0,
    retro_cases: 0,
    known_mistakes: 0,
    active_mistakes: 0,
    structured_findings: 0,
    persona_packs: 0,
    persona_constraints: 0,
    persona_findings: 0,
    review_intake_items: 0,
    quant_gate_hardening: 0,
    quant_results_validation: 0,
    intent_contracts: 0,
    intent_deliverables: 0,
    recipe_entities: 0,
    recipe_capabilities: 0,
    recipe_contracts: 0,
    recipe_discovery_candidates: 0,
    journal_memory_records: 0,
    issue_history_caches: 0,
    issue_history_invalid_caches: 0,
    issue_history_records: 0,
    issue_history_labels: 0,
    issue_history_comments: 0,
    issue_history_decisions: 0,
    issue_history_blocker_resolutions: 0,
  };

  facts.push("% ==========================================================");
  facts.push("% Ontology traceability facts (auto-generated)");
  facts.push(`% Generated by ontology_serializer.mjs`);
  facts.push("% ==========================================================");
  facts.push("");
  const journalMemory = compileJournalMemoryFacts({ cwd });
  facts.push("% --- Journal-memory substrate facts ---");
  for (const fact of journalMemory.facts || []) facts.push(fact);
  meta.journal_memory_records = journalMemory.records?.length || 0;
  facts.push("");

  const issueHistory = collectIssueHistoryFactBundle({ cwd });
  facts.push("% --- GitHub issue-history cache facts ---");
  for (const fact of issueHistory.facts || []) facts.push(fact);
  meta.issue_history_caches = issueHistory.meta?.caches || 0;
  meta.issue_history_invalid_caches = issueHistory.meta?.invalid_caches || 0;
  meta.issue_history_records = issueHistory.meta?.records || 0;
  meta.issue_history_labels = issueHistory.meta?.labels || 0;
  meta.issue_history_comments = issueHistory.meta?.comments || 0;
  meta.issue_history_decisions = issueHistory.meta?.decisions || 0;
  meta.issue_history_blocker_resolutions = issueHistory.meta?.blocker_resolutions || 0;
  facts.push("");

  // --- 1. Business goals ---
  const goals = extractGoals(planContent);
  const verificationContent = planDir ? (safeRead(join(planDir, "verification.md")) || "") : "";
  const planStateJson = planDir ? (safeReadJson(join(planDir, "state.json")) || {}) : {};
  const workOrderInfo = planDir ? loadPlanWorkOrder(planDir) : { parsed: null, error: null };
  const workOrder = workOrderInfo.error ? null : workOrderInfo.parsed;
  const effectiveVerificationStrategy = planDir
    ? readEffectiveVerificationStrategy({ cwd, planDir, planContent })
    : null;
  const traceabilityPlanContent = effectiveVerificationStrategy?.ok
    ? effectiveVerificationStrategy.compatibility_plan_content
    : planContent;
  const rawVerificationLedger = loadVerificationLedger(planDir);
  const verificationLedger = rawVerificationLedger && effectiveVerificationStrategy?.ok
    ? syncLedgerFromStrategy({
        strategy: effectiveVerificationStrategy.document || effectiveVerificationStrategy.strategy,
        existingLedger: { ...rawVerificationLedger, present: true },
        successCriteria: extractSuccessCriteria(traceabilityPlanContent),
      })
    : rawVerificationLedger;
  const canonicalVerificationSubject = buildVerificationSubjectCanonicalizer(verificationLedger);
  const emittedVerificationAliases = new Set();
  const recordVerificationAlias = (original, canonical) => {
    if (!original || !canonical || original === canonical) return;
    const key = `${original}=>${canonical}`;
    if (emittedVerificationAliases.has(key)) return;
    emittedVerificationAliases.add(key);
    facts.push(`verification_subject_alias(${sanitizeId(original)}, ${sanitizeId(canonical)}).`);
  };
  const retroRegistry = loadRetroRegistry({ cwd });
  const mistakeRegistry = loadMistakeRegistry();
  const mistakeSignal = computeMistakeRegistrySignal({
    planDir,
    stateJson: planStateJson,
    planContent,
    storyRegistry,
  });
  const learnedObligations = computePlanLearnedObligationsSignal({
    cwd,
    planDir,
    stateJson: planStateJson,
    planContent,
    verificationContent,
    verificationLedger,
    storyRegistry,
    mistakeSignal,
    requiredAtOrBefore: "close",
  });
  const antiRecurrenceTriggerTerms = collectAntiRecurrenceTriggerTerms(goals[0]?.label || null, planContent);
  const antiRecurrenceMarkdownEvidence = extractAntiRecurrenceMarkdownEvidence(verificationContent);
  const activeMistakeResponses = extractActiveMistakeResponse(planContent);
  const activeMistakeEvidence = extractActiveMistakeEvidence(verificationContent);
  const personaArtifacts = loadPersonaArtifacts(planDir);
  const verificationObligationSynthesis = computeVerificationObligationSynthesis({
    cwd,
    planDir,
    stateJson: { goal: goals[0]?.label || null },
    planContent,
    storyRegistry,
  });
  const quantResultsValidation = quantResultsValidationOverride || computeQuantResultsValidationSignal({
      planDir,
      projectRoot: cwd,
      planContent,
      verificationContent,
      reflectionContent: planDir ? safeRead(join(planDir, "reflection.md")) : "",
      summaryContent: planDir ? safeRead(join(planDir, "summary.md")) : "",
    });
  const reviewIntake = computeReviewIntake({
    cwd,
    planDir,
  });
  for (const g of goals) {
    facts.push(`business_goal(${sanitizeId(g.id)}, ${sanitize(g.label)}).`);
    meta.goals++;
  }
  if (goals.length > 0) facts.push("");

  // --- 2. Success criteria ---
  const criteria = extractSuccessCriteria(planContent, { workOrder });
  for (const c of criteria) {
    facts.push(`success_criterion(${sanitizeId(c.id)}, ${sanitize(c.label)}).`);
    // Also emit arity-1 form for invariants.pl HR-011 and pack compatibility
    facts.push(`success_criterion(${sanitizeId(c.id)}).`);
    meta.criteria++;
  }
  if (criteria.length > 0) facts.push("");

  // --- 3. Goal → criterion links ---
  const goalCriterionLinks = mapCriteriaToGoals(goals, criteria);
  for (const link of goalCriterionLinks) {
    facts.push(`goal_requires(${sanitizeId(link.goalId)}, ${sanitizeId(link.criterionId)}).`);
    meta.goal_criterion_links++;
  }
  if (goalCriterionLinks.length > 0) facts.push("");

  // --- 4. Criterion → story links ---
  const stories = storyRegistry?.stories || [];
  const criterionStoryLinks = mapCriteriaToStories(criteria, stories, traceabilityPlanContent, workOrder);
  for (const link of criterionStoryLinks) {
    facts.push(`criterion_story(${sanitizeId(link.criterionId)}, ${sanitize(link.storyId)}).`);
    meta.criterion_story_links++;
  }

  // Also generate from @planner:proves annotations
  if (Array.isArray(annotations)) {
    for (const ann of annotations) {
      if (ann.key === "proves" && ann.value) {
        // annotation_proves links a file to a criterion
        const criterionId = ann.value.startsWith("crit:")
          ? ann.value.slice(5)
          : ann.value;
        facts.push(`annotation_proves_criterion(${sanitize(ann.file)}, ${sanitizeId(criterionId)}).`);
        meta.annotation_proves++;
      }
      if (ann.key === "story" && ann.value) {
        // annotation links a file to a story
        facts.push(`annotation_story_link(${sanitize(ann.file)}, ${sanitize(ann.value)}).`);
      }
    }
  }
  if (meta.criterion_story_links + meta.annotation_proves > 0) facts.push("");

  // --- 5. Validation artifacts ---
  for (const story of stories) {
    if (!Array.isArray(story.validation_refs)) continue;
    for (const ref of story.validation_refs) {
      facts.push(`validation_ref(${sanitizeId(story.id)}, ${sanitize(ref)}).`);
    }
  }

  const validationArtifacts = detectValidationArtifacts(cwd, criteria);
  for (const va of validationArtifacts) {
    if (va.criterionId) {
      facts.push(`validation_artifact(${sanitize(va.path)}, ${sanitizeId(va.criterionId)}).`);
    } else {
      facts.push(`validation_artifact_unlinked(${sanitize(va.path)}).`);
    }
    meta.validation_artifacts++;
  }

  // Also pick up @planner:validation_module annotations
  if (Array.isArray(annotations)) {
    for (const ann of annotations) {
      if (ann.key === "validation_module") {
        facts.push(`validation_module_declared(${sanitize(ann.file)}).`);
      }
    }
  }
  if (meta.validation_artifacts > 0 || stories.some((s) => Array.isArray(s.validation_refs) && s.validation_refs.length > 0)) facts.push("");

  // --- 6. Audit passes and perspectives ---
  // Always declare known perspectives (even without planDir) so TR-005 can fire
  const ALL_PERSPECTIVES = [
    "code_correctness", "assumptions_challenge", "connectivity",
    "failure_modes", "security", "performance", "data_integrity",
    "output_trustworthiness", "configuration_integrity",
  ];
  for (const p of ALL_PERSPECTIVES) {
    facts.push(`known_perspective(${sanitizeId(p)}).`);
  }

  if (planDir) {
    const passes = extractAuditPasses(planDir);

    for (const p of passes) {
      facts.push(`audit_pass(${sanitizeId(p.id)}, ${sanitizeId(p.perspective)}).`);
      // Emit audit_perspective/2 for HR-010 invariant compatibility
      facts.push(`audit_perspective(${sanitizeId(p.id)}, ${sanitizeId(p.perspective)}).`);
      meta.audit_passes++;
    }
    if (passes.length > 0) facts.push("");
  }

  // --- 7. Verification results ---
  if (planDir) {
    const results = extractVerificationResults(planDir);
    for (const r of results) {
      facts.push(`verification_result_status(${sanitize(r.criterion)}, ${sanitize(r.status)}, ${sanitize(r.evidence)}).`);
      meta.verification_results++;
    }
    if (results.length > 0) facts.push("");
  }

  // --- 8. Intent contract (optional / intent-aware gating) ---
  if (planDir || planContent) {
    const primaryGoal = goals.find((goal) => goal.id === "primary_goal");
    const intentInfo = planDir
      ? loadIntentContract(planDir)
      : { present: false, parsed: null, error: null };
    const intentAnalysis = analyzeIntentContract(intentInfo.parsed, {
      goalText: primaryGoal?.label || "",
    });

    facts.push(`intent_contract_required(${intentAnalysis.requiredByGoal ? "true" : "false"}).`);
    facts.push(`intent_contract_present(${intentInfo.present ? "true" : "false"}).`);
    facts.push(`intent_contract_invalid(${intentInfo.error ? "true" : "false"}).`);

    if (intentAnalysis.primaryUser) {
      facts.push(`intent_primary_user(${sanitize(intentAnalysis.primaryUser)}).`);
    }
    if (intentAnalysis.jobToBeDone) {
      facts.push(`intent_job_to_be_done(${sanitize(intentAnalysis.jobToBeDone)}).`);
    }
    for (const outcome of intentAnalysis.desiredOutcomes) {
      facts.push(`intent_desired_outcome(${sanitize(outcome)}).`);
    }
    for (const antiGoal of intentAnalysis.antiGoals) {
      facts.push(`intent_anti_goal(${sanitize(antiGoal)}).`);
    }
    for (const constraint of intentAnalysis.constraints) {
      facts.push(`intent_constraint(${sanitize(constraint)}).`);
    }

    for (const deliverable of intentAnalysis.deliverables) {
      facts.push(
        `deliverable_contract(${sanitizeId(deliverable.id)}, ${sanitizeEnumAtom(deliverable.kind)}, ${sanitize(deliverable.name || deliverable.id)}).`
      );
      facts.push(`deliverable_required(${sanitizeId(deliverable.id)}, ${deliverable.required ? "true" : "false"}).`);
      if (deliverable.purpose) {
        facts.push(`deliverable_purpose(${sanitizeId(deliverable.id)}, ${sanitize(deliverable.purpose)}).`);
      }
      for (const qualityBar of deliverable.qualityBars) {
        facts.push(`deliverable_quality_bar(${sanitizeId(deliverable.id)}, ${sanitize(qualityBar)}).`);
      }
      for (const section of deliverable.requiredSections) {
        facts.push(`deliverable_required_section(${sanitizeId(deliverable.id)}, ${sanitize(section)}).`);
      }
      for (const signal of deliverable.requiredSignals) {
        facts.push(`deliverable_required_signal(${sanitizeId(deliverable.id)}, ${sanitize(signal)}).`);
      }
      for (const antiGoal of deliverable.antiGoals) {
        facts.push(`deliverable_anti_goal(${sanitizeId(deliverable.id)}, ${sanitize(antiGoal)}).`);
      }
      facts.push(`deliverable_evidence_mode(${sanitizeId(deliverable.id)}, ${sanitizeEnumAtom(deliverable.evidenceMode)}).`);
      meta.intent_deliverables++;
    }

    if (intentInfo.present || intentAnalysis.requiredByGoal) {
      meta.intent_contracts++;
      facts.push("");
    }
  }

  // --- 9. Recipe/entity/capability registries (optional / additive) ---
  const recipeSurface = loadRecipeOntologySurface(cwd);
  if (recipeSurface.present) {
    const recipeFacts = [];
    const seenFacts = new Set();
    const emit = (fact) => {
      if (!fact || seenFacts.has(fact)) return;
      recipeFacts.push(fact);
      seenFacts.add(fact);
    };

    emit("recipe_registry_present(true).");

    for (const entity of recipeSurface.entities) {
      emit(`recipe_entity(${sanitizeId(entity.id)}, ${sanitize(entity.title || entity.id)}).`);
      meta.recipe_entities++;
      for (const alias of entity.aliases) {
        emit(`recipe_entity_alias(${sanitizeId(entity.id)}, ${sanitize(alias)}).`);
      }
      for (const recipeId of entity.recipeIds) {
        emit(`recipe_entity_recipe(${sanitizeId(entity.id)}, ${sanitizeId(recipeId)}).`);
      }
      for (const [systemName, systemPayload] of Object.entries(entity.systems)) {
        emit(`recipe_entity_system(${sanitizeId(entity.id)}, ${sanitizeEnumAtom(systemName)}).`);
        if (systemPayload && typeof systemPayload === "object") {
          for (const [refKey, refValue] of Object.entries(systemPayload)) {
            if (typeof refValue === "string" && refValue.trim()) {
              emit(`recipe_entity_system_ref(${sanitizeId(entity.id)}, ${sanitizeEnumAtom(systemName)}, ${sanitizeEnumAtom(refKey)}, ${sanitize(refValue)}).`);
            }
          }
        }
      }
    }

    for (const capability of recipeSurface.capabilities) {
      emit(`recipe_capability(${sanitizeId(capability.id)}, ${sanitize(capability.title || capability.id)}).`);
      meta.recipe_capabilities++;
      for (const trigger of capability.triggers) {
        const pattern = firstNonEmptyString(trigger?.pattern, trigger);
        if (pattern) emit(`recipe_trigger(${sanitizeId(capability.id)}, ${sanitize(pattern)}).`);
      }
      for (const recipeId of capability.recipeIds) {
        emit(`recipe_capability_recipe(${sanitizeId(capability.id)}, ${sanitizeId(recipeId)}).`);
      }
      for (const param of capability.requiredParams) {
        emit(`recipe_capability_requires(${sanitizeId(capability.id)}, ${sanitizeId(param)}).`);
      }
      for (const skill of capability.skills) {
        emit(`recipe_capability_skill(${sanitizeId(capability.id)}, ${sanitizeEnumAtom(skill)}).`);
      }
      for (const entityId of capability.supportedEntities) {
        emit(`recipe_capability_entity(${sanitizeId(capability.id)}, ${sanitizeId(entityId)}).`);
      }
    }

    for (const recipe of recipeSurface.recipes) {
      emit(`recipe_contract(${sanitizeId(recipe.id)}, ${sanitizeId(recipe.capabilityId || "unknown_capability")}, ${sanitize(recipe.title || recipe.id)}).`);
      meta.recipe_contracts++;
      for (const entityId of recipe.entityIds) {
        emit(`recipe_entity_binding(${sanitizeId(recipe.id)}, ${sanitizeId(entityId)}).`);
      }
      for (const param of recipe.requiredParams) {
        emit(`recipe_required_param(${sanitizeId(recipe.id)}, ${sanitizeId(param)}).`);
      }
      for (const system of recipe.systems) {
        emit(`recipe_system(${sanitizeId(recipe.id)}, ${sanitizeEnumAtom(system)}).`);
      }
      for (const skill of recipe.skills) {
        emit(`recipe_skill(${sanitizeId(recipe.id)}, ${sanitizeEnumAtom(skill)}).`);
      }
      if (recipe.runner) {
        emit(`recipe_runner_type(${sanitizeId(recipe.id)}, ${sanitizeEnumAtom(recipe.runner.type)}).`);
        emit(`recipe_runner_cwd(${sanitizeId(recipe.id)}, ${sanitize(recipe.runner.cwd || ".")}).`);
        for (const [index, token] of recipe.runner.command.entries()) {
          emit(`recipe_runner_token(${sanitizeId(recipe.id)}, ${index + 1}, ${sanitize(token)}).`);
        }
        for (const flag of recipe.runner.dryRunFlags) {
          emit(`recipe_runner_dry_flag(${sanitizeId(recipe.id)}, ${sanitize(flag)}).`);
        }
        for (const flag of recipe.runner.liveFlags) {
          emit(`recipe_runner_live_flag(${sanitizeId(recipe.id)}, ${sanitize(flag)}).`);
        }
      }
      for (const script of recipe.scripts) {
        if (typeof script === "string" && script.trim()) {
          emit(`recipe_script(${sanitizeId(recipe.id)}, ${sanitize(script)}).`);
          continue;
        }
        if (script && typeof script === "object" && typeof script.path === "string" && script.path.trim()) {
          emit(`recipe_script(${sanitizeId(recipe.id)}, ${sanitize(script.path)}).`);
        }
      }
    }

    if (recipeFacts.length > 0) {
      facts.push(...recipeFacts);
      facts.push("");
    }
  }

  // --- 10. Recipe discovery review surface (optional / additive) ---
  const discoverySurface = loadRecipeDiscoverySurface(cwd);
  if (discoverySurface.present) {
    facts.push("recipe_discovery_present(true).");
    if (discoverySurface.goal) {
      facts.push(`recipe_discovery_goal(${sanitize(discoverySurface.goal)}).`);
    }
    for (const candidate of discoverySurface.candidates) {
      facts.push(`recipe_discovery_candidate(${sanitizeId(candidate.id)}, ${sanitize(candidate.title)}).`);
      facts.push(`recipe_discovery_status(${sanitizeId(candidate.id)}, ${sanitizeEnumAtom(candidate.status)}).`);
      facts.push(`recipe_discovery_decision(${sanitizeId(candidate.id)}, ${sanitizeEnumAtom(candidate.decision)}).`);
      if (candidate.capabilityId) {
        facts.push(`recipe_discovery_capability(${sanitizeId(candidate.id)}, ${sanitizeId(candidate.capabilityId)}).`);
      }
      if (candidate.recipeId) {
        facts.push(`recipe_discovery_recipe(${sanitizeId(candidate.id)}, ${sanitizeId(candidate.recipeId)}).`);
      }
      if (candidate.entityId) {
        facts.push(`recipe_discovery_entity(${sanitizeId(candidate.id)}, ${sanitizeId(candidate.entityId)}).`);
      }
      for (const scriptPath of candidate.scripts) {
        facts.push(`recipe_discovery_script(${sanitizeId(candidate.id)}, ${sanitize(scriptPath)}).`);
      }
      meta.recipe_discovery_candidates++;
    }
    facts.push("");
  }

  // --- 11. Structured retro archive facts (optional / additive) ---
  if (retroRegistry.usable) {
    for (const retro of retroRegistry.retros || []) {
      facts.push(`retro_case(${sanitizeId(retro.id)}).`);
      facts.push(`retro_status(${sanitizeId(retro.id)}, ${sanitizeEnumAtom(retro.status)}).`);
      meta.retro_cases++;
      if (retro.promotion_decision) {
        facts.push(`retro_promotion_decision(${sanitizeId(retro.id)}, ${sanitizeEnumAtom(retro.promotion_decision)}).`);
      }
      for (const failureMode of retro.failure_modes || []) {
        facts.push(`retro_failure_mode(${sanitizeId(retro.id)}, ${sanitizeEnumAtom(failureMode)}).`);
      }
      if (retro.discovered_phase) {
        facts.push(`retro_discovered_phase(${sanitizeId(retro.id)}, ${sanitizeEnumAtom(retro.discovered_phase)}).`);
      }
      if (retro.status === "accepted" && retro.case_file && existsSync(resolve(cwd, retro.case_file))) {
        facts.push(`retro_case_file(${sanitizeId(retro.id)}, ${sanitize(retro.case_file)}).`);
      }
      for (const mistakeId of retro.promotions?.mistake_ids || []) {
        facts.push(`retro_promoted_mistake(${sanitizeId(retro.id)}, ${sanitizeId(mistakeId)}).`);
      }
    }
    if ((retroRegistry.retros || []).length > 0) facts.push("");
  }

  // --- 12. Known + active mistake registry facts (optional / additive) ---
  facts.push(`mistake_registry_present(${mistakeRegistry.present ? "true" : "false"}).`);
  facts.push(`mistake_registry_usable(${mistakeRegistry.usable ? "true" : "false"}).`);
  if (mistakeRegistry.usable) {
    for (const mistake of mistakeRegistry.mistakes || []) {
      facts.push(`known_mistake(${sanitizeId(mistake.id)}, ${sanitize(mistake.title || mistake.id)}).`);
      meta.known_mistakes++;
      if (mistake.summary) {
        facts.push(`mistake_summary(${sanitizeId(mistake.id)}, ${sanitize(mistake.summary)}).`);
      }
      if (mistake.family) {
        facts.push(`mistake_family(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom(mistake.family)}).`);
      }
      for (const kbRef of mistake.kb_refs || []) {
        facts.push(`mistake_kb_ref(${sanitizeId(mistake.id)}, ${sanitize(kbRef)}).`);
      }
      for (const retroId of mistake.retro_refs || []) {
        facts.push(`mistake_originates_from_retro(${sanitizeId(mistake.id)}, ${sanitizeId(retroId)}).`);
      }
      for (const tag of mistake.query_tags || []) {
        facts.push(`mistake_query_tag(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom(tag)}).`);
      }
      for (const guardType of mistake.required_guards || []) {
        facts.push(`mistake_required_guard(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom(guardType)}).`);
      }
      for (const evidence of mistake.required_evidence || []) {
        facts.push(`mistake_required_evidence(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom(evidence)}).`);
      }
      for (const annotationKey of mistake.recommended_annotations || []) {
        facts.push(`mistake_recommended_annotation(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom(annotationKey)}).`);
      }
      for (const hook of mistake.verification_hooks || []) {
        facts.push(`mistake_verification_hook(${sanitizeId(mistake.id)}, ${sanitize(hook)}).`);
      }
      for (const obligationId of mistake.obligation_ids || []) {
        facts.push(`mistake_obligation(${sanitizeId(mistake.id)}, ${sanitizeId(obligationId)}).`);
      }
      for (const supersededId of mistake.supersedes || []) {
        facts.push(`mistake_supersedes(${sanitizeId(mistake.id)}, ${sanitizeId(supersededId)}).`);
      }
    }

    for (const mistake of mistakeSignal.active_mistakes || []) {
      facts.push(`active_mistake(${sanitizeId(mistake.id)}).`);
      meta.active_mistakes++;
      for (const family of mistake.matched_trigger_families || []) {
        facts.push(`active_mistake_trigger_family(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom(family)}).`);
      }
      for (const filePath of mistake.matched_files || []) {
        facts.push(`active_mistake_match(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom("file_globs")}, ${sanitize(filePath)}).`);
      }
      for (const term of mistake.matched_terms || []) {
        facts.push(`active_mistake_match(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom("plan_terms")}, ${sanitize(term)}).`);
      }
      for (const kind of mistake.matched_deliverable_kinds || []) {
        facts.push(`active_mistake_match(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom("deliverable_kinds")}, ${sanitizeEnumAtom(kind)}).`);
      }
      for (const tag of mistake.matched_story_tags || []) {
        facts.push(`active_mistake_match(${sanitizeId(mistake.id)}, ${sanitizeEnumAtom("story_tags")}, ${sanitizeEnumAtom(tag)}).`);
      }
    }

    for (const response of activeMistakeResponses) {
      facts.push(`mistake_guard_declared(${sanitizeId(response.mistake_id)}, ${sanitizeEnumAtom(response.guard)}).`);
    }

    for (const evidence of activeMistakeEvidence) {
      if (evidence.satisfied) {
        facts.push(`mistake_hook_satisfied(${sanitizeId(evidence.mistake_id)}, ${sanitize(evidence.hook)}).`);
      }
    }

  }
  facts.push("");

  // --- 13. Learned verification obligations (registry-backed semantic bridge) ---
  if (learnedObligations.required) {
    for (const obligation of learnedObligations.active_obligations || []) {
      const subjectId = canonicalVerificationSubject(obligation.subject_id);
      recordVerificationAlias(obligation.subject_id, subjectId);
      facts.push(`verification_subject(${sanitizeId(subjectId)}, ${sanitizeEnumAtom("plan_guard")}).`);
      facts.push(`verification_mode(${sanitizeEnumAtom(obligation.verification_mode)}).`);
      facts.push(`verification_obligation(${sanitizeId(`vo_${obligation.id}`)}, ${sanitizeId(subjectId)}, ${sanitizeEnumAtom(obligation.verification_mode)}, ${sanitizeEnumAtom(obligation.severity || "warn_then_fail")}).`);
      facts.push(`obligation_source(${sanitizeId(`vo_${obligation.id}`)}, ${sanitizeEnumAtom("learned_obligation")}, ${sanitizeId(obligation.id)}).`);
      facts.push(`obligation_required_by_phase(${sanitizeId(`vo_${obligation.id}`)}, ${sanitizeEnumAtom(obligation.required_by_phase || "reflect")}).`);
      meta.verification_subjects++;
      meta.verification_modes++;
      meta.verification_obligations++;

      for (const family of obligation.matched_trigger_families || []) {
        facts.push(`subject_capability(${sanitizeId(subjectId)}, ${sanitizeId(`learned_trigger:${family}`)}).`);
      }
      if (obligation.source_mistake) {
        facts.push(`subject_capability(${sanitizeId(subjectId)}, ${sanitizeId(`source_mistake:${obligation.source_mistake}`)}).`);
        facts.push(`obligation_source_mistake(${sanitizeId(`vo_${obligation.id}`)}, ${sanitizeId(obligation.source_mistake)}).`);
      }
      if (obligation.source_registry_degraded) {
        facts.push(`obligation_source_registry_degraded(${sanitizeId(`vo_${obligation.id}`)}).`);
        if (obligation.source_registry_status) {
          facts.push(`obligation_source_registry_status(${sanitizeId(`vo_${obligation.id}`)}, ${sanitizeEnumAtom(obligation.source_registry_status)}).`);
        }
      }

      if (obligation.status === "verification_md" || obligation.status === "verification_ledger") {
        facts.push(`verification_evidence(${sanitizeId(`ev_${obligation.id}`)}, ${sanitizeId(subjectId)}, ${sanitizeEnumAtom(obligation.verification_mode)}, ${sanitizeEnumAtom("passed")}).`);
        facts.push(`evidence_command(${sanitizeId(`ev_${obligation.id}`)}, ${sanitize(
          obligation.status === "verification_ledger"
            ? "verification_ledger.json"
            : "verification.md Learned Obligations"
        )}).`);
        meta.verification_evidence++;
      }

      facts.push("");
    }
  }

  // --- 14. Synthesized verification obligations (planner-owned semantic bridge) ---
  if (verificationObligationSynthesis.required) {
    for (const obligation of verificationObligationSynthesis.obligations) {
      const obligationId = `vos_${obligation.id}`;
      const generatedSubjectId = `plan:verification-obligation-synthesis:${obligation.id}`;
      const subjectId = canonicalVerificationSubject(generatedSubjectId);
      const verificationMode = normalizeVerificationMode(obligation.verification_mode);
      recordVerificationAlias(generatedSubjectId, subjectId);
      facts.push(`verification_subject(${sanitizeId(subjectId)}, ${sanitizeEnumAtom("plan_guard")}).`);
      facts.push(`verification_mode(${sanitizeEnumAtom(verificationMode)}).`);
      facts.push(`verification_obligation(${sanitizeId(obligationId)}, ${sanitizeId(subjectId)}, ${sanitizeEnumAtom(verificationMode)}, ${sanitizeEnumAtom("required")}).`);
      facts.push(`obligation_source(${sanitizeId(obligationId)}, ${sanitizeEnumAtom("planner_synthesis")}, ${sanitizeId(obligation.id)}).`);
      facts.push(`obligation_required_by_phase(${sanitizeId(obligationId)}, ${sanitizeEnumAtom("plan")}).`);
      meta.verification_subjects++;
      meta.verification_modes++;
      meta.verification_obligations++;

      for (const packId of obligation.matched_persona_packs) {
        facts.push(`obligation_source(${sanitizeId(obligationId)}, ${sanitizeEnumAtom("persona_pack")}, ${sanitizeId(packId)}).`);
      }
      for (const tag of obligation.matched_story_tags) {
        facts.push(`obligation_source(${sanitizeId(obligationId)}, ${sanitizeEnumAtom("story_tag")}, ${sanitizeId(tag)}).`);
      }
      for (const filePath of obligation.matched_files) {
        facts.push(`subject_capability(${sanitizeId(subjectId)}, ${sanitizeId(`boundary:${filePath}`)}).`);
      }

      facts.push("");
    }
  }

  // --- 15. Anti-recurrence verification subject (additive semantic bridge) ---
  if (antiRecurrenceTriggerTerms.length > 0) {
    facts.push(`verification_subject(${sanitizeId("plan:anti-recurrence")}, ${sanitizeEnumAtom("plan_guard")}).`);
    facts.push(`verification_mode(${sanitizeEnumAtom("artifact_review")}).`);
    facts.push(`verification_obligation(${sanitizeId("vo_plan_anti_recurrence")}, ${sanitizeId("plan:anti-recurrence")}, ${sanitizeEnumAtom("artifact_review")}, ${sanitizeEnumAtom("required")}).`);
    facts.push(`obligation_source(${sanitizeId("vo_plan_anti_recurrence")}, ${sanitizeEnumAtom("planner_core")}, ${sanitizeId("anti_recurrence_contract")}).`);
    facts.push(`obligation_required_by_phase(${sanitizeId("vo_plan_anti_recurrence")}, ${sanitizeEnumAtom("reflect")}).`);
    meta.verification_subjects++;
    meta.verification_modes++;
    meta.verification_obligations++;

    for (const trigger of antiRecurrenceTriggerTerms) {
      facts.push(`subject_capability(${sanitizeId("plan:anti-recurrence")}, ${sanitizeId(`trigger:${trigger}`)}).`);
    }

    if (antiRecurrenceMarkdownEvidence.satisfied) {
      facts.push(`verification_evidence(${sanitizeId("ev_plan_anti_recurrence")}, ${sanitizeId("plan:anti-recurrence")}, ${sanitizeEnumAtom("artifact_review")}, ${sanitizeEnumAtom("passed")}).`);
      facts.push(`evidence_command(${sanitizeId("ev_plan_anti_recurrence")}, ${sanitize("verification.md Anti-Recurrence Guard")}).`);
      meta.verification_evidence++;
    }

    facts.push("");
  }

  // --- 16. Structured verification ledger (optional / Phase 1 additive) ---
  if (verificationLedger) {
    const ledgerFacts = [];
    const seenFacts = new Set();
    const emit = (fact) => {
      if (!fact || seenFacts.has(fact)) return;
      ledgerFacts.push(fact);
      seenFacts.add(fact);
    };

    emit("verification_ledger_present(true).");
    emit("verification_obligation_tracking_enabled(true).");

    const criterionStories = new Map();
    for (const link of criterionStoryLinks) {
      if (!criterionStories.has(link.criterionId)) criterionStories.set(link.criterionId, new Set());
      criterionStories.get(link.criterionId).add(link.storyId);
    }

    for (const criterion of criteria) {
      const subjectId = `crit:${criterion.id}`;
      emit(`verification_subject(${sanitizeId(subjectId)}, ${sanitizeEnumAtom("criterion")}).`);
      emit(`subject_criterion(${sanitizeId(subjectId)}, ${sanitizeId(criterion.id)}).`);
      meta.verification_subjects++;

      const storyIds = criterionStories.get(criterion.id) || new Set();
      for (const storyId of storyIds) {
        emit(`subject_story(${sanitizeId(subjectId)}, ${sanitizeId(storyId)}).`);
      }
    }

    for (const subject of verificationLedger.subjects) {
      const rawSubjectId = firstNonEmptyString(subject?.id, subject?.subject_id);
      if (!rawSubjectId) continue;
      const subjectId = canonicalVerificationSubject(rawSubjectId);
      recordVerificationAlias(rawSubjectId, subjectId);
      for (const alias of asStringList(subject?.aliases)) {
        recordVerificationAlias(alias, subjectId);
      }

      const kind = firstNonEmptyString(subject?.kind, subject?.type, "generic");
      emit(`verification_subject(${sanitizeId(subjectId)}, ${sanitizeEnumAtom(kind)}).`);
      meta.verification_subjects++;

      const criterionRefs = extractSubjectRefs(subject, ["criterion_refs", "criteria", "criterion"]);
      if (criterionRefs.length === 0 && kind === "criterion" && subjectId.startsWith("crit:")) {
        criterionRefs.push(subjectId.slice(5));
      }

      for (const criterionId of criterionRefs) {
        emit(`subject_criterion(${sanitizeId(subjectId)}, ${sanitizeId(criterionId)}).`);
      }
      for (const storyId of extractSubjectRefs(subject, ["story_refs", "stories", "story"])) {
        emit(`subject_story(${sanitizeId(subjectId)}, ${sanitizeId(storyId)}).`);
      }
      for (const capabilityId of extractSubjectRefs(subject, ["capability_refs", "capabilities", "capability"])) {
        emit(`subject_capability(${sanitizeId(subjectId)}, ${sanitizeId(capabilityId)}).`);
      }
      for (const journeyId of extractSubjectRefs(subject, ["journey_refs", "journeys", "journey"])) {
        emit(`subject_journey(${sanitizeId(subjectId)}, ${sanitizeId(journeyId)}).`);
      }
    }

    for (const declaration of verificationLedger.declaredModes) {
      emit(`verification_mode(${sanitizeEnumAtom(declaration.mode)}).`);
      emit(`verification_supported(${sanitizeEnumAtom(declaration.mode)}).`);
      emit(`verification_mode_declared_by(${sanitizeEnumAtom(declaration.mode)}, ${sanitizeId(declaration.source)}).`);
      meta.verification_modes++;
    }

    for (const obligation of verificationLedger.obligations) {
      const obligationId = firstNonEmptyString(obligation?.id, obligation?.obligation_id);
      const rawSubjectId = firstNonEmptyString(obligation?.subject, obligation?.subject_id);
      const subjectId = canonicalVerificationSubject(rawSubjectId);
      recordVerificationAlias(rawSubjectId, subjectId);
      const mode = firstNonEmptyString(obligation?.mode);
      if (!obligationId || !subjectId || !mode) continue;

      const severity = firstNonEmptyString(obligation?.severity, "required");
      emit(`verification_mode(${sanitizeEnumAtom(mode)}).`);
      emit(`verification_obligation(${sanitizeId(obligationId)}, ${sanitizeId(subjectId)}, ${sanitizeEnumAtom(mode)}, ${sanitizeEnumAtom(severity)}).`);
      meta.verification_obligations++;

      const sourceType = firstNonEmptyString(obligation?.source_type);
      const sourceId = firstNonEmptyString(obligation?.source_id);
      if (sourceType && sourceId) {
        emit(`obligation_source(${sanitizeId(obligationId)}, ${sanitizeEnumAtom(sourceType)}, ${sanitizeId(sourceId)}).`);
      }

      const requiredByPhase = firstNonEmptyString(obligation?.required_by_phase, obligation?.phase);
      if (requiredByPhase) {
        emit(`obligation_required_by_phase(${sanitizeId(obligationId)}, ${sanitizeEnumAtom(requiredByPhase)}).`);
      }
    }

    for (const evidence of verificationLedger.evidence) {
      const evidenceId = firstNonEmptyString(evidence?.id, evidence?.evidence_id);
      const rawSubjectId = firstNonEmptyString(evidence?.subject, evidence?.subject_id);
      const subjectId = canonicalVerificationSubject(rawSubjectId);
      recordVerificationAlias(rawSubjectId, subjectId);
      const mode = firstNonEmptyString(evidence?.mode);
      if (!evidenceId || !subjectId || !mode) continue;

      const status = firstNonEmptyString(evidence?.status, "unknown");
      emit(`verification_mode(${sanitizeEnumAtom(mode)}).`);
      emit(`verification_evidence(${sanitizeId(evidenceId)}, ${sanitizeId(subjectId)}, ${sanitizeEnumAtom(mode)}, ${sanitizeEnumAtom(status)}).`);
      meta.verification_evidence++;

      const actor = firstNonEmptyString(evidence?.actor);
      if (actor) emit(`evidence_actor(${sanitizeId(evidenceId)}, ${sanitizeEnumAtom(actor)}).`);

      const environment = firstNonEmptyString(evidence?.environment, evidence?.env);
      if (environment) emit(`evidence_environment(${sanitizeId(evidenceId)}, ${sanitizeEnumAtom(environment)}).`);

      const command = firstNonEmptyString(evidence?.command, evidence?.action);
      if (command) emit(`evidence_command(${sanitizeId(evidenceId)}, ${sanitize(command)}).`);

      for (const traceId of extractSubjectRefs(evidence, ["trace_refs", "traces", "trace"])) {
        emit(`evidence_trace(${sanitizeId(evidenceId)}, ${sanitizeId(traceId)}).`);
      }

      for (const artifactPath of extractSubjectRefs(evidence, ["artifacts", "artifact_refs", "artifact_paths"])) {
        emit(`evidence_artifact(${sanitizeId(evidenceId)}, ${sanitizeId(artifactPath)}).`);
      }

      if (typeof evidence?.manual_ack === "boolean") {
        emit(`manual_ack(${sanitizeId(evidenceId)}, ${evidence.manual_ack}).`);
      }
    }

    for (const waiver of verificationLedger.waivers) {
      const waiverId = firstNonEmptyString(waiver?.id, waiver?.waiver_id);
      const rawSubjectId = firstNonEmptyString(waiver?.subject, waiver?.subject_id);
      const subjectId = canonicalVerificationSubject(rawSubjectId);
      recordVerificationAlias(rawSubjectId, subjectId);
      const mode = firstNonEmptyString(waiver?.mode);
      if (!waiverId || !subjectId || !mode) continue;

      emit(`verification_mode(${sanitizeEnumAtom(mode)}).`);
      emit(`verification_waiver(${sanitizeId(subjectId)}, ${sanitizeEnumAtom(mode)}, ${sanitizeId(waiverId)}).`);
      meta.verification_waivers++;

      const reason = firstNonEmptyString(waiver?.reason);
      if (reason) emit(`waiver_reason(${sanitizeId(waiverId)}, ${sanitize(reason)}).`);

      const approvedBy = firstNonEmptyString(waiver?.approved_by);
      if (approvedBy) emit(`waiver_approved_by(${sanitizeId(waiverId)}, ${sanitizeEnumAtom(approvedBy)}).`);

      const expiresAt = firstNonEmptyString(waiver?.expires_at);
      if (expiresAt) emit(`waiver_expires_at(${sanitizeId(waiverId)}, ${sanitizeId(expiresAt)}).`);
    }

    if (ledgerFacts.length > 0) {
      facts.push(...ledgerFacts);
      facts.push("");
    }
  }

  // --- 14. Structured findings ledger (optional / additive) ---
  const findingsLedger = loadStructuredFindingsLedger(planDir);
  if (findingsLedger) {
    const findingFacts = [];
    const seenFacts = new Set();
    const emit = (fact) => {
      if (!fact || seenFacts.has(fact)) return;
      findingFacts.push(fact);
      seenFacts.add(fact);
    };

    emit("findings_ledger_present(true).");

    for (let index = 0; index < findingsLedger.findings.length; index++) {
      const finding = findingsLedger.findings[index];
      const findingId = firstNonEmptyString(finding?.id, finding?.finding_id, `F-${String(index + 1).padStart(3, "0")}`);
      const findingTitle = firstNonEmptyString(finding?.title, finding?.summary, finding?.label, `Finding ${index + 1}`);

      emit(`finding_record(${sanitizeId(findingId)}, ${sanitize(findingTitle)}).`);
      meta.structured_findings++;

      for (const storyId of extractSubjectRefs(finding, ["story_refs", "stories", "story"])) {
        emit(`finding_story(${sanitizeId(findingId)}, ${sanitizeId(storyId)}).`);
      }
      for (const filePath of extractSubjectRefs(finding, ["file_refs", "files", "file"])) {
        emit(`finding_file(${sanitizeId(findingId)}, ${sanitizeId(filePath)}).`);
      }
      for (const tag of extractSubjectRefs(finding, ["tags", "tag"])) {
        emit(`finding_tag(${sanitizeId(findingId)}, ${sanitizeEnumAtom(tag)}).`);
      }

      const sourceType = firstNonEmptyString(finding?.source_type, finding?.sourceType);
      const sourceId = firstNonEmptyString(finding?.source_id, finding?.sourceId);
      if (sourceType && sourceId) {
        emit(`finding_source(${sanitizeId(findingId)}, ${sanitizeEnumAtom(sourceType)}, ${sanitizeId(sourceId)}).`);
      }
    }

    if (findingFacts.length > 0) {
      facts.push(...findingFacts);
      facts.push("");
    }
  }

  // --- 16. Review intake close signal (optional / additive) ---
  if (reviewIntake) {
    facts.push(`review_intake_required(${closeSignalRequiredAtom(reviewIntake)}).`);
    facts.push(`review_intake_satisfied(${closeSignalSatisfiedAtom(reviewIntake)}).`);
    facts.push(`review_intake_unresolved_required_count(${Number(reviewIntake.unresolved_required_count || 0)}).`);
    for (const item of Array.isArray(reviewIntake.items) ? reviewIntake.items : []) {
      facts.push(`review_item(${sanitizeId(item.id)}, ${sanitizeEnumAtom(item.source_kind || "unknown")}, ${item.required ? "true" : "false"}).`);
      facts.push(`review_item_classification(${sanitizeId(item.id)}, ${sanitizeEnumAtom(item.classification || "unknown")}).`);
      if (item.source_path) facts.push(`review_item_source(${sanitizeId(item.id)}, ${sanitize(item.source_path)}).`);
      if (item.claim) facts.push(`review_item_claim(${sanitizeId(item.id)}, ${sanitize(item.claim)}).`);
      if (item.reason) facts.push(`review_item_reason(${sanitizeId(item.id)}, ${sanitize(item.reason)}).`);
      if (item.required) facts.push(`review_item_required(${sanitizeId(item.id)}).`);
      if (item.unresolved) facts.push(`review_item_unresolved(${sanitizeId(item.id)}).`);
      if (item.disposition?.status) {
        facts.push(`review_item_disposition(${sanitizeId(item.id)}, ${sanitizeEnumAtom(item.disposition.status)}).`);
        facts.push(`review_item_disposition_valid(${sanitizeId(item.id)}, ${item.disposition_valid ? "true" : "false"}).`);
      }
      meta.review_intake_items++;
    }
    facts.push("");
  }

  // --- 17. Quant gate hardening facts (optional / additive) ---
  try {
    const quantGateFacts = compileQuantGateHardeningFacts({ cwd, planDir, planContent });
    if (Array.isArray(quantGateFacts?.facts) && quantGateFacts.facts.length > 0) {
      facts.push(...quantGateFacts.facts);
      facts.push("");
      meta.quant_gate_hardening++;
    }
  } catch {
    facts.push("quant_optimization_scale_required(false).");
    facts.push("quant_optimization_scale_status('error').");
    facts.push("quant_run_class_interpretive(false).");
    facts.push("quant_run_class_quick_evidence(false).");
    facts.push("quant_run_class_discovered_budget_unknown(true).");
    facts.push("quant_leakage_proof_artifact_required(false).");
    facts.push("quant_leakage_proof_artifact_status('error').");
    facts.push("quant_leakage_proof_artifact_row_count(0).");
    facts.push("");
  }

  // --- 18. Quant results validation close signal (optional / additive) ---
  if (quantResultsValidation) {
    facts.push(`quant_results_validation_required(${closeSignalRequiredAtom(quantResultsValidation)}).`);
    facts.push(`quant_results_validation_satisfied(${closeSignalSatisfiedAtom(quantResultsValidation)}).`);
    facts.push(`quant_results_validation_status(${sanitizeEnumAtom(closeSignalStatusValue(quantResultsValidation))}).`);
    facts.push(`quant_results_evidence_validity(${sanitizeEnumAtom(quantResultsValidation.evidence_validity || "not_required")}).`);
    facts.push(`quant_results_claim_support_allowed(${quantResultsValidation.claim_support_allowed === true ? "true" : "false"}).`);
    facts.push(`quant_results_numeric_output_reportable(${quantResultsValidation.numeric_output_reportable === true ? "true" : "false"}).`);
    const environmentReceipt = quantResultsValidation.environment_preflight_receipt || null;
    facts.push(`quant_results_environment_preflight_status(${sanitizeEnumAtom(environmentReceipt?.status || "not_available")}).`);
    facts.push(`quant_results_environment_preflight_performed(${environmentReceipt?.performed === true ? "true" : "false"}).`);
    facts.push(`quant_results_environment_preflight_probe_count(${Number.isInteger(environmentReceipt?.probe_count) ? environmentReceipt.probe_count : 0}).`);
    if (quantResultsValidation.run_class) {
      facts.push(`quant_results_run_class(${sanitizeEnumAtom(quantResultsValidation.run_class)}).`);
    }
    if (quantResultsValidation.promotion_verdict) {
      facts.push(`quant_results_promotion_verdict(${sanitizeEnumAtom(quantResultsValidation.promotion_verdict)}).`);
    }
    for (const issue of Array.isArray(quantResultsValidation.blocking_issues) ? quantResultsValidation.blocking_issues : []) {
      facts.push(`quant_results_blocking_issue(${sanitizeEnumAtom(issue)}).`);
    }
    facts.push(`scientific_review_present(${quantResultsValidation.scientific_review ? "true" : "false"}).`);
    facts.push(`scientific_review_satisfied(${quantResultsValidation.scientific_review?.satisfied === true ? "true" : "false"}).`);
    facts.push(`scientific_execution_status(${sanitizeEnumAtom(quantResultsValidation.scientific_review?.execution_status || "not_available")}).`);
    facts.push(`scientific_design_validity(${sanitizeEnumAtom(quantResultsValidation.scientific_review?.design_validity || "not_available")}).`);
    facts.push(`scientific_evidence_grade(${sanitizeEnumAtom(quantResultsValidation.scientific_review?.evidence_grade || "not_available")}).`);
    facts.push(`scientific_verdict(${sanitizeEnumAtom(quantResultsValidation.scientific_review?.scientific_verdict || "not_available")}).`);
    facts.push(`scientific_promotion_status(${sanitizeEnumAtom(quantResultsValidation.scientific_review?.promotion_status || "not_available")}).`);
    const semanticGates = Array.isArray(quantResultsValidation.semantic_gates) ? quantResultsValidation.semantic_gates : [];
    facts.push(`quant_semantic_gate_count(${semanticGates.length}).`);
    for (const gate of semanticGates) {
      const gateId = sanitizeId(gate?.id || "unknown_gate");
      facts.push(`quant_semantic_gate(${gateId}, ${gate?.satisfied ? "true" : "false"}).`);
      facts.push(`quant_semantic_gate_measured(${gateId}, ${sanitize(JSON.stringify(gate?.measured ?? null))}).`);
      const threshold = gate?.threshold && typeof gate.threshold === "object" ? gate.threshold : {};
      facts.push(`quant_semantic_gate_threshold(${gateId}, ${sanitize(threshold.op || "missing")}, ${sanitize(JSON.stringify(threshold.value ?? null))}).`);
      for (const criterion of Array.isArray(gate?.per_criterion) ? gate.per_criterion : []) {
        const criterionId = sanitizeId(criterion?.id || "unknown_criterion");
        facts.push(`quant_semantic_gate_criterion(${gateId}, ${criterionId}, ${criterion?.satisfied ? "true" : "false"}).`);
        facts.push(`quant_semantic_gate_criterion_measured(${gateId}, ${criterionId}, ${sanitize(JSON.stringify(criterion?.measured ?? null))}).`);
      }
    }
    const claims = Array.isArray(quantResultsValidation.claim_ledgers) ? quantResultsValidation.claim_ledgers : [];
    facts.push(`quant_claim_ledger_count(${claims.length}).`);
    let auditOverrideCount = 0;
    for (const claim of claims) {
      const claimId = sanitizeId(claim?.id || "unknown_claim");
      auditOverrideCount += Array.isArray(claim?.audit) ? claim.audit.length : 0;
      facts.push(`quant_claim_status(${claimId}, ${sanitizeEnumAtom(claim?.status || "unknown")}).`);
      facts.push(`quant_claim_posterior(${claimId}, ${sanitize(JSON.stringify(claim?.posterior ?? null))}).`);
      facts.push(`quant_claim_threshold(${claimId}, ${sanitize(JSON.stringify(claim?.threshold ?? null))}).`);
      facts.push(`quant_claim_evidence_count(${claimId}, ${Number.isInteger(claim?.evidence_count) ? claim.evidence_count : 0}).`);
      facts.push(`quant_claim_disconfirming_count(${claimId}, ${Number.isInteger(claim?.disconfirming_count) ? claim.disconfirming_count : 0}).`);
      for (const evidence of Array.isArray(claim?.evidence) ? claim.evidence : []) {
        const evidenceId = sanitizeId(evidence?.id || "unknown_evidence");
        facts.push(`quant_claim_evidence_provenance(${claimId}, ${evidenceId}, ${sanitizeEnumAtom(evidence?.provenance || "unknown")}).`);
        facts.push(`quant_claim_evidence_lr(${claimId}, ${evidenceId}, ${sanitize(JSON.stringify(evidence?.likelihood_ratio ?? null))}).`);
        facts.push(`quant_claim_evidence_cap_applied(${claimId}, ${evidenceId}, ${evidence?.lr_cap_applied ? "true" : "false"}).`);
      }
    }
    facts.push(`quant_claim_audit_override_count(${auditOverrideCount}).`);
    meta.quant_results_validation++;
    facts.push("");
  }

  // --- 19. Persona artifacts (optional / additive) ---
  if (personaArtifacts.summary.present) {
    const personaFacts = [];
    const seenFacts = new Set();
    const emit = (fact) => {
      if (!fact || seenFacts.has(fact)) return;
      personaFacts.push(fact);
      seenFacts.add(fact);
    };

    emit("persona_artifacts_present(true).");

    for (const packId of personaArtifacts.summary.pack_ids) {
      emit(`persona_pack(${sanitizeId(packId)}).`);
      meta.persona_packs++;
    }

    const guidancePhase = firstNonEmptyString(personaArtifacts.guidance?.phase, personaArtifacts.summary.guidance.phase);
    if (guidancePhase) {
      emit(`persona_guidance_phase(${sanitizeEnumAtom(guidancePhase)}).`);
    }
    for (const item of Array.isArray(personaArtifacts.guidance?.items) ? personaArtifacts.guidance.items : []) {
      const packId = extractPersonaPackId(item);
      if (!packId) continue;
      emit(`persona_guidance_pack(${sanitizeId(packId)}, ${sanitizeEnumAtom(guidancePhase || "unknown")}).`);
    }

    const constraints = Array.isArray(personaArtifacts.constraints?.constraints) ? personaArtifacts.constraints.constraints : [];
    for (const constraint of constraints) {
      const constraintId = firstNonEmptyString(constraint?.id, constraint?.constraint);
      const packId = firstNonEmptyString(extractPersonaPackId(constraint), "unknown");
      const severity = firstNonEmptyString(constraint?.severity, "unknown");
      if (!constraintId) continue;
      emit(`persona_constraint(${sanitizeId(constraintId)}, ${sanitizeId(packId)}, ${sanitizeEnumAtom(severity)}).`);
      meta.persona_constraints++;
      for (const storyId of extractSubjectRefs(constraint, ["story_refs", "stories", "story"])) {
        emit(`persona_constraint_story(${sanitizeId(constraintId)}, ${sanitizeId(storyId)}).`);
      }
    }

    const findings = Array.isArray(personaArtifacts.findings?.findings) ? personaArtifacts.findings.findings : [];
    for (let index = 0; index < findings.length; index++) {
      const finding = findings[index];
      const findingId = firstNonEmptyString(
        finding?._roleAudit?.id,
        finding?.id,
        finding?.finding_id,
        `PF-${String(index + 1).padStart(3, "0")}`,
      );
      const packId = firstNonEmptyString(extractPersonaPackId(finding), "unknown");
      const severity = firstNonEmptyString(finding?._roleAudit?.severity, finding?.severity, "unknown");
      emit(`persona_finding(${sanitizeId(findingId)}, ${sanitizeId(packId)}, ${sanitizeEnumAtom(severity)}).`);
      meta.persona_findings++;
      for (const storyId of extractSubjectRefs(finding?._roleAudit || finding, ["story_refs", "stories", "story"])) {
        emit(`persona_finding_story(${sanitizeId(findingId)}, ${sanitizeId(storyId)}).`);
      }
    }

    if (personaFacts.length > 0) {
      facts.push(...personaFacts);
      facts.push("");
    }
  }

  // --- 19. Completeness marker ---
  facts.push(`ontology_loaded(${meta.goals}, ${meta.criteria}, ${meta.audit_passes}).`);

  const emittedVerificationFacts = new Set();
  const dedupedFacts = facts.filter((fact) => {
    if (!/^verification_(?:subject|mode|obligation|evidence|waiver|supported|ledger|obligation_tracking)/.test(fact)) return true;
    if (emittedVerificationFacts.has(fact)) return false;
    emittedVerificationFacts.add(fact);
    return true;
  });

  return { facts: dedupedFacts.join("\n"), meta };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  let outputJson = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && args[i + 1]) { cwd = resolve(args[++i]); }
    if (args[i] === "--json") { outputJson = true; }
  }

  // Load story registry
  let storyRegistry = null;
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (existsSync(registryPath)) {
    try { storyRegistry = JSON.parse(readFileSync(registryPath, "utf-8")); } catch { /* skip */ }
  }

  // Find active plan
  let planDir = null;
  let planContent = null;
  const pointerFile = join(cwd, "plans", ".current_plan");
  if (existsSync(pointerFile)) {
    const planDirName = readFileSync(pointerFile, "utf-8").trim();
    planDir = join(cwd, "plans", planDirName);
    const planPath = join(planDir, "plan.md");
    planContent = safeRead(planPath);
  }

  // Load annotations
  let annotations = [];
  try {
    const sourceFiles = walkDir(cwd, cwd);
    for (const f of sourceFiles) {
      annotations.push(...parseAnnotations(f, cwd));
    }
  } catch { /* skip */ }

  const { facts, meta } = serializeToFacts({
    cwd,
    storyRegistry,
    planDir,
    planContent,
    annotations,
  });

  if (outputJson) {
    console.log(JSON.stringify({ meta, facts: facts.split("\n").filter(l => l && !l.startsWith("%")) }, null, 2));
  } else {
    console.log(facts);
  }
}

// Run CLI if invoked directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("ontology_serializer.mjs") ||
  process.argv[1].includes("ontology_serializer")
);
if (isMain) main();
