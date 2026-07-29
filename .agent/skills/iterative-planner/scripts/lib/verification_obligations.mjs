import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadPlanMatchContext, normalizeStringList } from "./mistake_registry.mjs";
import { summarizePersonaArtifacts } from "./persona_artifacts.mjs";
import { readScopeContract } from "./scope_contract.mjs";
import { detectPlanShape } from "./plan_shape.mjs";
import { decidePersonaPackActivation } from "./persona_activation_authority.mjs";
import { deriveTaskFocusContract, taskFocusPackStatus } from "./task_focus_contract.mjs";
import {
  goalLooksLikeStaticUiDeliverable,
  looksLikeStaticUiPath,
} from "./plan_utils.mjs";

function safeReadJson(filePath) {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) : null;
  } catch {
    return null;
  }
}

function readPersonaArtifactJson(filePath, artifactName) {
  if (!existsSync(filePath)) return { document: null, issue: null };
  try {
    return {
      document: JSON.parse(readFileSync(filePath, "utf-8")),
      issue: null,
    };
  } catch (error) {
    return {
      document: null,
      issue: {
        artifact: artifactName,
        severity: "warning",
        code: "parse_error",
        message: `${artifactName} unreadable; persona recommendations may be incomplete (${error.message}).`,
      },
    };
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PROOF_TEXT_ALIASES = Object.freeze([
  Object.freeze({ from: /\bproof:unit_test\b/g, to: "unit test" }),
  Object.freeze({ from: /\bproof:browser_journey\b/g, to: "browser journey" }),
  Object.freeze({ from: /\bproof:browser_screenshot\b/g, to: "browser screenshot" }),
  Object.freeze({ from: /\bproof:dry_run\b/g, to: "dry run" }),
  Object.freeze({ from: /\bproof:curl_probe\b/g, to: "curl probe" }),
  Object.freeze({ from: /\bproof:api_probe\b/g, to: "api probe" }),
  Object.freeze({ from: /\bproof:connector_dry_run\b/g, to: "connector dry-run" }),
  Object.freeze({ from: /\bproof:integration_smoke\b/g, to: "integration smoke" }),
  Object.freeze({ from: /\bproof:command_smoke\b/g, to: "command smoke" }),
  Object.freeze({ from: /\bproof:planner_smoke\b/g, to: "planner smoke" }),
  Object.freeze({ from: /\bproof:migration_verification\b/g, to: "migration verification" }),
  Object.freeze({ from: /\bproof:artifact_review\b/g, to: "artifact review" }),
  Object.freeze({ from: /\bproof:orchestration_smoke\b/g, to: "orchestration smoke" }),
  Object.freeze({ from: /\bproof:migration_parity\b/g, to: "migration parity" }),
  Object.freeze({ from: /\bproof:postcondition_check\b/g, to: "postcondition check" }),
  Object.freeze({ from: /\bproof:mutually_exclusive_check\b/g, to: "mutually exclusive check" }),
  Object.freeze({ from: /\bproof:temporal_split_check\b/g, to: "temporal split check" }),
  Object.freeze({ from: /\bproof:leakage_check\b/g, to: "leakage check" }),
  Object.freeze({ from: /\bproof:out_of_sample_validation\b/g, to: "out of sample validation" }),
  Object.freeze({ from: /\bproof:benchmark_comparison\b/g, to: "benchmark comparison" }),
  Object.freeze({ from: /\bproof:calibration_check\b/g, to: "calibration check" }),
  Object.freeze({ from: /\bproof:backtest_run\b/g, to: "backtest run" }),
  Object.freeze({ from: /\bproof:quant_results_validation\b/g, to: "quant results validation" }),
  Object.freeze({ from: /\bproof:alpha_discovery_contract\b/g, to: "alpha discovery contract" }),
  Object.freeze({ from: /\bproof:doc_contract_check\b/g, to: "doc contract check" }),
  Object.freeze({ from: /\bproof:live_parity_check\b/g, to: "live parity check" }),
  Object.freeze({ from: /\bproof:renderer_contract_check\b/g, to: "renderer contract check" }),
  Object.freeze({ from: /\bproof:manual_observation\b/g, to: "manual observation" }),
  Object.freeze({ from: /\bproof:visual_proof\b/g, to: "visual proof" }),
  Object.freeze({ from: /\bvisual verification\b/g, to: "visual proof" }),
  Object.freeze({ from: /\bbrowser screenshot\b/g, to: "browser journey" }),
  Object.freeze({ from: /\bbrowser trace\b/g, to: "browser journey" }),
  Object.freeze({ from: /\bbrowser walkthrough\b/g, to: "browser journey" }),
  Object.freeze({ from: /\bmanual verification\b/g, to: "manual observation" }),
  Object.freeze({ from: /\bconnector dry run\b/g, to: "connector dry-run" }),
  Object.freeze({ from: /\breal connector dry-run\b/g, to: "connector dry-run" }),
  Object.freeze({ from: /\bapi probe\b/g, to: "api probe" }),
  Object.freeze({ from: /\bcurl probe\b/g, to: "curl probe" }),
  Object.freeze({ from: /\btransport-level check\b/g, to: "transport check" }),
  Object.freeze({ from: /\bintegration smoke test\b/g, to: "integration smoke" }),
  Object.freeze({ from: /\bsmoke test\b/g, to: "smoke" }),
  Object.freeze({ from: /\bparity verification\b/g, to: "migration parity" }),
  Object.freeze({ from: /\bcompatibility\/parity check\b/g, to: "migration parity" }),
  Object.freeze({ from: /\bcompatibility parity check\b/g, to: "migration parity" }),
  Object.freeze({ from: /\bcompatibility check\b/g, to: "migration parity" }),
  Object.freeze({ from: /\bpath verification\b/g, to: "migration parity" }),
]);

export const VERIFICATION_PROOF_IDS = Object.freeze({
  unit_test: "proof:unit_test",
  browser_journey: "proof:browser_journey",
  browser_screenshot: "proof:browser_screenshot",
  dry_run: "proof:dry_run",
  curl_probe: "proof:curl_probe",
  api_probe: "proof:api_probe",
  connector_dry_run: "proof:connector_dry_run",
  integration_smoke: "proof:integration_smoke",
  command_smoke: "proof:command_smoke",
  planner_smoke: "proof:planner_smoke",
  migration_verification: "proof:migration_verification",
  artifact_review: "proof:artifact_review",
  orchestration_smoke: "proof:orchestration_smoke",
  migration_parity: "proof:migration_parity",
  postcondition_check: "proof:postcondition_check",
  mutually_exclusive_check: "proof:mutually_exclusive_check",
  temporal_split_check: "proof:temporal_split_check",
  leakage_check: "proof:leakage_check",
  out_of_sample_validation: "proof:out_of_sample_validation",
  benchmark_comparison: "proof:benchmark_comparison",
  calibration_check: "proof:calibration_check",
  backtest_run: "proof:backtest_run",
  quant_results_validation: "proof:quant_results_validation",
  alpha_discovery_contract: "proof:alpha_discovery_contract",
  doc_contract_check: "proof:doc_contract_check",
  live_parity_check: "proof:live_parity_check",
  renderer_contract_check: "proof:renderer_contract_check",
  manual_observation: "proof:manual_observation",
  visual_proof: "proof:visual_proof",
});

export function canonicalizeVerificationProofText(value) {
  let normalized = normalizeText(value);
  for (const alias of PROOF_TEXT_ALIASES) {
    normalized = normalized.replace(alias.from, alias.to);
  }
  return normalized.replace(/\s+/g, " ").trim();
}

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/");
}

function normalizeKeyword(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadStoryRegistry(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  const parsed = safeReadJson(registryPath);
  return parsed && Array.isArray(parsed.stories) ? parsed : null;
}

export function loadPersonaArtifactSummary(planDir) {
  if (!planDir) return summarizePersonaArtifacts();
  const guidance = readPersonaArtifactJson(join(planDir, "persona_guidance.json"), "persona_guidance.json");
  const constraints = readPersonaArtifactJson(join(planDir, "persona_constraints.json"), "persona_constraints.json");
  const findings = readPersonaArtifactJson(join(planDir, "persona_findings.json"), "persona_findings.json");
  return summarizePersonaArtifacts({
    guidanceDoc: guidance.document,
    constraintsDoc: constraints.document,
    findingsDoc: findings.document,
    issues: [guidance.issue, constraints.issue, findings.issue].filter(Boolean),
  });
}

function findKeywordMatches(text, keywords) {
  const normalizedText = normalizeText(text);
  return uniqueList(normalizeStringList(keywords).filter((keyword) => {
    const normalizedKeyword = normalizeKeyword(keyword);
    if (!normalizedKeyword) return false;
    if (normalizedKeyword.includes(" ")) return normalizedText.includes(normalizedKeyword);
    if (/^[a-z0-9]+$/.test(normalizedKeyword) && normalizedKeyword.length <= 3) {
      const boundaryPattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(normalizedKeyword)}([^a-z0-9]|$)`, "i");
      return boundaryPattern.test(normalizedText);
    }
    return normalizedText.includes(normalizedKeyword);
  }));
}

function findPathKeywordMatches(paths, keywords) {
  const normalizedKeywords = uniqueList(normalizeStringList(keywords).map(normalizeKeyword));
  const matches = [];

  for (const rawPath of Array.isArray(paths) ? paths : []) {
    const normalizedPath = normalizePath(rawPath).toLowerCase();
    if (!normalizedPath) continue;
    // v7.3.1: prepend "/" so leading-slash keywords like "/models/" match
    // relative paths like "models/foo.py" the same as "/abs/models/foo.py".
    // Substring keywords without leading slash still work the same way.
    const matchTarget = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
    if (normalizedKeywords.some((keyword) => matchTarget.includes(keyword) || normalizedPath.includes(keyword))) matches.push(rawPath);
  }

  return uniqueList(matches);
}

function findDeliverableKindMatches(deliverables, kinds) {
  const wanted = new Set(normalizeStringList(kinds).map(normalizeKeyword));
  if (wanted.size === 0) return [];
  return uniqueList((Array.isArray(deliverables) ? deliverables : [])
    .map((deliverable) => normalizeKeyword(deliverable?.kind))
    .filter((kind) => kind && wanted.has(kind)));
}

function findStoryTagMatches(storyTags, tags) {
  const available = new Set(normalizeStringList(storyTags).map(normalizeKeyword));
  return uniqueList(normalizeStringList(tags).filter((tag) => available.has(normalizeKeyword(tag))));
}

function findPersonaPackMatches(summary, packIds, authorityOpts = {}) {
  const available = new Set(normalizeStringList(summary?.pack_ids).map(normalizeKeyword));
  return uniqueList(normalizeStringList(packIds).filter((packId) => (
    available.has(normalizeKeyword(packId)) &&
    decidePersonaPackActivation(packId, authorityOpts).may_synthesize_obligation
  )));
}

function obligationFamilyAllowedForFocus(family, taskFocusContract) {
  if (!taskFocusContract || typeof taskFocusContract !== "object") return true;
  if (taskFocusContract.plan_shape?.primary === "pending_focus") return false;

  const packs = normalizeStringList(family?.persona_packs);
  if (packs.length === 0) return true;

  const statuses = packs.map((packId) => taskFocusPackStatus(taskFocusContract, packId));
  if (statuses.some((status) => status === "authoritative")) return true;
  if (statuses.every((status) => status === "unspecified")) return true;
  return false;
}

function collectSourceSignals(family, matches) {
  return uniqueList([
    ...matches.goal_terms.map((term) => `task:${term}`),
    ...matches.files.map((filePath) => `boundary:${filePath}`),
    ...matches.deliverable_kinds.map((kind) => `deliverable:${kind}`),
    ...matches.story_tags.map((tag) => `story_tag:${tag}`),
    ...matches.persona_packs.map((packId) => `persona:${packId}`),
    family.allow_persona_only && matches.persona_packs.length > 0 ? "persona_only_trigger" : null,
  ]);
}

function buildBoundarySummary(matches) {
  return uniqueList([
    ...matches.files,
    ...matches.story_tags.map((tag) => `story_tag:${tag}`),
    ...matches.deliverable_kinds.map((kind) => `deliverable:${kind}`),
  ]);
}

function buildSourceProvenance(signals, { ambientFiles = new Set(), ownedFiles = new Set() } = {}) {
  return uniqueList(signals).map((signal) => {
    const fileMatch = String(signal).match(/^boundary:(.+)$/);
    if (fileMatch) {
      const filePath = normalizePath(fileMatch[1]);
      const ambient = ambientFiles.has(filePath) && !ownedFiles.has(filePath);
      return {
        signal,
        file: filePath,
        source: ambient ? "ambient_dirty_scope" : "owned_plan_scope",
        blocking: !ambient,
      };
    }
    return {
      signal,
      source: "plan_context",
      blocking: true,
    };
  });
}

export const VERIFICATION_OBLIGATION_FAMILIES = Object.freeze([
  Object.freeze({
    id: "browser_ui",
    label: "browser/UI",
    verification_mode: "browser_journey",
    required_proof_type: "browser E2E, browser journey with screenshot artifacts, visual proof, or structured manual observation with captured viewport evidence",
    proof_ids: [VERIFICATION_PROOF_IDS.browser_journey, VERIFICATION_PROOF_IDS.browser_screenshot, VERIFICATION_PROOF_IDS.visual_proof, VERIFICATION_PROOF_IDS.manual_observation],
    context_keywords: ["browser", "ui", "frontend", "visual", "web automation", "responsive", "user-visible"],
    proof_keywords: ["browser", "e2e", "end-to-end", "visual", "screenshot", "screenshots", "captured viewport", "image artifact", "manual observation", "manual", "playwright", "playwright screenshot", "selenium"],
    file_keywords: [".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".html", "/ui/", "/frontend/", "playwright", "browser"],
    deliverable_kinds: ["ui"],
    story_tags: ["ui", "frontend", "browser", "web", "automation", "ux"],
    persona_packs: ["ux_ui"],
    allow_persona_only: true,
    requires_audit_review: false,
    rationale: "User-visible browser and visual changes need proof that exercises the actual rendered journey and leaves inspectable visual artifacts, not only local wrappers.",
  }),
  Object.freeze({
    id: "cms_missing_content_diagnosis",
    label: "CMS missing-content diagnosis",
    verification_mode: "artifact_review",
    required_proof_type: "artifact review, curl probe, browser journey, structured manual observation, or direct DB proof review",
    proof_ids: [VERIFICATION_PROOF_IDS.artifact_review, VERIFICATION_PROOF_IDS.curl_probe, VERIFICATION_PROOF_IDS.api_probe, VERIFICATION_PROOF_IDS.browser_journey, VERIFICATION_PROOF_IDS.renderer_contract_check, VERIFICATION_PROOF_IDS.manual_observation],
    context_keywords: [
      "wordpress",
      "cms",
      "missing content",
      "content is missing",
      "page looks empty",
      "looks empty",
      "empty page",
      "blank page",
      "content not showing",
      "custom post type missing",
      "custom post types missing",
      "data disappeared",
      "raw html",
      "dom",
    ],
    proof_keywords: [
      "artifact review",
      "curl",
      "probe",
      "browser",
      "manual observation",
      "raw html",
      "dom",
      "direct db proof",
      "database query",
      "zero-byte",
    ],
    file_keywords: ["wordpress", "wp-content", ".php", "wordpress.yaml", "planner_findings", "plan_utils"],
    deliverable_kinds: [],
    story_tags: ["diagnostics", "preflight", "routing", "evidence"],
    persona_packs: ["assumptions_challenger"],
    allow_persona_only: false,
    requires_goal_signal: true,
    requires_audit_review: true,
    rationale: "CMS missing-content reports are expensive false-green risks unless the planner proves whether the render layer or the data/query layer actually failed.",
  }),
  Object.freeze({
    id: "api_integration",
    label: "API/integration",
    verification_mode: "api_probe",
    required_proof_type: "real connector dry-run, transport-level check, API probe, audit artifact review, or integration smoke",
    proof_ids: [VERIFICATION_PROOF_IDS.api_probe, VERIFICATION_PROOF_IDS.dry_run, VERIFICATION_PROOF_IDS.connector_dry_run, VERIFICATION_PROOF_IDS.integration_smoke, VERIFICATION_PROOF_IDS.artifact_review],
    context_keywords_unambiguous: ["api", "connector", "transport", "webhook", "mcp", "external system", "external service"],
    context_keywords_ambiguous: ["integration", "adapter", "client", "probe"],
    context_keywords: ["api", "integration", "connector", "transport", "webhook", "mcp", "external system", "external service", "adapter", "client", "probe"],
    proof_keywords: ["integration", "dry-run", "audit", "transport", "smoke", "curl", "connector", "mcp", "probe", "api"],
    file_keywords: ["/api/", "/integration/", "/integrations/", "/connector/", "/connectors/", "connector_", "connector-", "transport", "webhook", "mcp", "/adapter/", "/adapters/"],
    deliverable_kinds: ["integration", "automation"],
    story_tags: ["api", "integration", "connector", "transport", "mcp", "webhook"],
    persona_packs: ["wiring_auditor", "assumptions_challenger"],
    allow_persona_only: false,
    require_structured_or_unambiguous: true,
    requires_audit_review: true,
    rationale: "Integration-heavy systems need evidence from the real boundary or a faithful dry-run path, plus artifact review when transport or connector behavior matters.",
  }),
  Object.freeze({
    id: "backend_service",
    label: "backend/service",
    verification_mode: "integration",
    required_proof_type: "command-level smoke, API smoke, integration test, or round-trip verification",
    proof_ids: [VERIFICATION_PROOF_IDS.command_smoke, VERIFICATION_PROOF_IDS.integration_smoke, VERIFICATION_PROOF_IDS.api_probe, VERIFICATION_PROOF_IDS.unit_test],
    context_keywords_unambiguous: ["backend", "worker", "server", "daemon", "backend service", "service boundary", "command surface", "cli surface"],
    context_keywords_ambiguous: ["service", "job", "command", "cli"],
    context_keywords: ["backend", "service", "worker", "job", "command", "cli", "server", "daemon", "backend service", "service boundary", "command surface", "cli surface"],
    proof_keywords: ["integration", "smoke", "command", "cli", "api smoke", "round-trip"],
    file_keywords: ["/backend/", "/service/", "/services/", "/worker/", "/workers/", "/server/", "/servers/", "/cli/", "/commands/", "/daemon/", "daemon.mjs", "daemon.js", "worker.mjs", "worker.js"],
    deliverable_kinds: ["service", "backend"],
    story_tags: ["backend", "service", "worker", "cli", "command"],
    persona_packs: ["wiring_auditor"],
    allow_persona_only: false,
    require_structured_or_unambiguous: true,
    requires_audit_review: false,
    rationale: "Backend and command surfaces should show command-level or integration behavior rather than relying only on local wrappers.",
  }),
  Object.freeze({
    id: "recipe_orchestration",
    label: "recipe/orchestration",
    verification_mode: "integration",
    required_proof_type: "real dry-run, exercised-systems review, audit artifact review, or orchestration smoke",
    proof_ids: [VERIFICATION_PROOF_IDS.dry_run, VERIFICATION_PROOF_IDS.orchestration_smoke, VERIFICATION_PROOF_IDS.integration_smoke, VERIFICATION_PROOF_IDS.planner_smoke, VERIFICATION_PROOF_IDS.artifact_review],
    context_keywords_unambiguous: ["recipe", "orchestration", "workflow runner", "recipe runner", "orchestration runner"],
    context_keywords_ambiguous: ["workflow", "automation", "runner", "bootstrap"],
    context_keywords: ["recipe", "orchestration", "workflow", "automation", "runner", "bootstrap", "workflow runner", "recipe runner", "orchestration runner"],
    proof_keywords: ["dry-run", "artifact review", "exercised systems", "runner", "orchestration", "smoke", "audit"],
    file_keywords: ["recipes/", "/recipes/", "recipe.json", "recipe_", "recipe-", "/runner/", "/runners/", "runner.mjs", "runner.js", "/workflow/", "/workflows/", "/orchestration/", "/automation/"],
    deliverable_kinds: ["automation"],
    story_tags: ["recipes", "workflow", "runner", "bootstrap", "discovery"],
    persona_packs: ["traceability", "wiring_auditor"],
    allow_persona_only: false,
    require_structured_or_unambiguous: true,
    requires_audit_review: true,
    rationale: "Recipe and orchestration changes are only credible when the real execution path or a faithful dry-run demonstrates what systems were actually exercised.",
  }),
  Object.freeze({
    id: "migration_parity",
    label: "migration/parity",
    verification_mode: "migration_simulation",
    required_proof_type: "migration smoke, compatibility/parity check, or explicit path verification",
    proof_ids: [VERIFICATION_PROOF_IDS.migration_parity, VERIFICATION_PROOF_IDS.migration_verification, VERIFICATION_PROOF_IDS.live_parity_check],
    context_keywords_unambiguous: ["migration", "migrations", "migrate", "parity", "upgrade", "verify path", "mcp path", "compatibility"],
    context_keywords_ambiguous: ["compat", "schema", "path", "config"],
    context_keywords: ["migration", "migrations", "migrate", "parity", "upgrade", "verify path", "mcp path", "compat", "compatibility", "schema", "path", "config"],
    matrix_context_keywords: ["migration", "parity", "slug parity", "path parity", "upgrade", "verify path", "mcp path", "compat", "compatibility"],
    proof_keywords: ["migration parity", "migration smoke", "parity", "parity verification", "compatibility check", "explicit path verification", "path verification", "live parity"],
    file_keywords: ["/migration", "/migrations/", "migrate", "upgrade", "parity", "compat", "/schema/", "/schemas/", "schema.sql", "schema.json", "migration_"],
    deliverable_kinds: ["migration", "config"],
    story_tags: ["migration", "config", "parity", "ontology"],
    persona_packs: ["config_integrity", "traceability"],
    allow_persona_only: true,
    require_structured_or_unambiguous: true,
    requires_audit_review: true,
    rationale: "Migration and shared-module changes need proof of compatibility, parity, or path validity, not just local test wrappers.",
  }),
  Object.freeze({
    id: "quant_modeling",
    label: "quant/modeling",
    verification_mode: "benchmark",
    required_proof_type: "temporal split, leakage, OOS, benchmark, calibration, backtest, alpha discovery contract, quant results validation, or live-parity validation",
    proof_ids: [
      VERIFICATION_PROOF_IDS.temporal_split_check,
      VERIFICATION_PROOF_IDS.leakage_check,
      VERIFICATION_PROOF_IDS.out_of_sample_validation,
      VERIFICATION_PROOF_IDS.benchmark_comparison,
      VERIFICATION_PROOF_IDS.calibration_check,
      VERIFICATION_PROOF_IDS.backtest_run,
      VERIFICATION_PROOF_IDS.alpha_discovery_contract,
      VERIFICATION_PROOF_IDS.quant_results_validation,
      VERIFICATION_PROOF_IDS.live_parity_check,
    ],
    // v7.3.1: split context keywords into unambiguous (always count) vs.
    // English-overloaded (count only when paired with a structured signal).
    // The legacy `context_keywords` is preserved as the union for backward
    // compatibility with downstream code that hasn't been updated to read
    // the split. Synthesis logic uses the split for false-positive control.
    context_keywords_unambiguous: ["backtest", "out of sample", "out-of-sample", "leakage", "temporal split", "walk forward", "calibration check", "alpha discovery contract", "quant results validation", "live parity"],
    context_keywords_ambiguous: ["quant", "model", "signal", "factor", "alpha", "edge hypothesis", "strategy", "benchmark", "calibration"],
    context_keywords: ["quant", "model", "signal", "factor", "alpha", "edge hypothesis", "strategy", "backtest", "benchmark", "calibration", "leakage", "temporal split", "walk forward", "out of sample"],
    matrix_context_keywords: ["quant", "model", "signal", "factor", "alpha", "edge hypothesis", "strategy", "backtest", "benchmark", "calibration", "leakage", "temporal split", "walk forward", "out of sample", "alpha discovery contract", "quant results validation"],
    proof_keywords: ["temporal split", "leakage", "out of sample", "benchmark", "calibration", "backtest", "alpha discovery contract", "quant results validation", "live parity"],
    file_keywords: ["/models/", "/signals/", "/alphas/", "/strategies/", "/backtest/", "alpha_strategy", "signal", "factor", "portfolio"],
    deliverable_kinds: ["model"],
    story_tags: ["quant", "model", "signal", "backtest"],
    persona_packs: ["quant"],
    allow_persona_only: false,
    // v7.3.1: false-positive-prone family. Activate ONLY when a structured
    // signal (file path / deliverable kind / story tag) confirms quant scope,
    // OR an unambiguous keyword is present. Bare goal-text mentions of
    // "model" / "signal" / "operating model" no longer activate quant.
    require_structured_or_unambiguous: true,
    requires_audit_review: true,
    rationale: "Quant changes need timeline and realism proof, not just code-level confidence.",
  }),
]);

export function getVerificationObligationFamily(familyId) {
  return VERIFICATION_OBLIGATION_FAMILIES.find((family) => family.id === familyId) || null;
}

// v7.3.1: shape-conditional allowlist of obligation families. The `unknown`
// shape (legacy strict default) and explicit override get all families. Other
// shapes only activate the families that are realistic for that task type —
// a `feature` plan can't trigger `quant_modeling` even with a structured signal.
// Set to null/undefined to disable shape filtering entirely.
const SHAPE_OBLIGATION_ALLOWLIST = Object.freeze({
  "bug-fix":      new Set(["api_integration", "recipe_orchestration", "backend_service", "migration_parity", "browser_ui", "responsive_ui", "static_ui", "wordpress_layered_renderer", "cms_missing_content_diagnosis"]),
  "regression":   new Set(["api_integration", "recipe_orchestration", "backend_service", "migration_parity", "browser_ui", "responsive_ui", "static_ui", "wordpress_layered_renderer", "cms_missing_content_diagnosis"]),
  "integration":  new Set(["api_integration", "recipe_orchestration", "backend_service", "migration_parity"]),
  "feature":      new Set(["api_integration", "recipe_orchestration", "backend_service", "browser_ui", "responsive_ui", "static_ui", "wordpress_layered_renderer"]),
  "scientific":   new Set(["quant_modeling", "backend_service", "migration_parity"]),
  "refactor":     new Set(["api_integration", "recipe_orchestration", "backend_service", "migration_parity"]),
  "migration":    new Set(["api_integration", "migration_parity", "recipe_orchestration", "backend_service"]),
  "planner-core": new Set(["api_integration", "recipe_orchestration", "migration_parity", "backend_service"]),
  "docs":         new Set([]),
  // v7.4.3: chore shape allows zero obligation families. Operational tasks
  // (ad budget changes, credential rotations, schedule edits) don't need
  // synthesized verification obligations — agents transitioning a chore
  // plan should not be asked to add backtest / dry-run / migration-parity
  // proof IDs to a verification matrix that wouldn't even apply.
  "chore":        new Set([]),
  // v7.4.4: analysis shape — review/audit/explain tasks. No obligations.
  "analysis":     new Set([]),
});

export function obligationFamilyAllowedForShape(familyId, shapePrimary) {
  if (!shapePrimary || shapePrimary === "unknown") return true;
  const allowed = SHAPE_OBLIGATION_ALLOWLIST[shapePrimary];
  if (!allowed) return true; // unknown shape names → don't filter
  return allowed.has(familyId);
}

const COMPACT_LOW_RISK_SHAPES = new Set(["docs", "chore", "analysis"]);
const COMPACT_LOW_RISK_ALLOWED_OBLIGATIONS = new Set(["browser_ui"]);
const COMPACT_LOW_RISK_HIGH_RISK_TERMS = Object.freeze([
  "api",
  "integration",
  "connector",
  "webhook",
  "mcp",
  "external system",
  "external service",
  "adapter",
  "backend",
  "service",
  "worker",
  "server",
  "daemon",
  "cli",
  "recipe",
  "orchestration",
  "workflow runner",
  "migration",
  "parity",
  "upgrade",
  "database",
  "db",
  "transport",
  "dry-run",
  "live parity",
  "quant",
  "backtest",
  "temporal split",
  "leakage",
  "calibration",
  "alpha",
  "factor",
  "signal",
  "security",
  "auth",
  "authentication",
  "authorization",
  "credential",
  "secret",
  "api key",
  "password",
  "pii",
  "payment",
  "data loss",
  "destructive",
]);

function containsCompactHighRiskTerm(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return COMPACT_LOW_RISK_HIGH_RISK_TERMS.find((term) => {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) return false;
    if (normalizedTerm.includes(" ")) return normalized.includes(normalizedTerm);
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(normalizedTerm)}([^a-z0-9]|$)`, "i").test(normalized);
  }) || null;
}

export function deriveLowRiskVerificationMatrixPolicy({
  shapePrimary = null,
  planMatchContext = {},
  obligations = [],
} = {}) {
  const plannedFiles = Array.isArray(planMatchContext.plannedFiles) ? planMatchContext.plannedFiles : [];
  const effectiveFiles = Array.isArray(planMatchContext.effectiveFiles) ? planMatchContext.effectiveFiles : [];
  const filesForRisk = plannedFiles.length > 0 ? plannedFiles : effectiveFiles;
  const goalText = planMatchContext.goalText || "";
  const blockingObligations = (Array.isArray(obligations) ? obligations : [])
    .filter((obligation) => obligation?.blocking !== false);
  const blockingObligationIds = uniqueList(blockingObligations.map((obligation) => obligation.id).filter(Boolean));
  const disallowedObligationIds = blockingObligationIds.filter((id) => !COMPACT_LOW_RISK_ALLOWED_OBLIGATIONS.has(id));
  const staticArtifact = plannedFiles.length > 0 &&
    plannedFiles.every((filePath) => looksLikeStaticUiPath(filePath)) &&
    goalLooksLikeStaticUiDeliverable(goalText, plannedFiles);
  const lowRiskShape = COMPACT_LOW_RISK_SHAPES.has(shapePrimary);
  const riskSignals = uniqueList([
    containsCompactHighRiskTerm(goalText) ? `goal:${containsCompactHighRiskTerm(goalText)}` : null,
    ...filesForRisk.map((filePath) => {
      const matched = containsCompactHighRiskTerm(filePath);
      return matched ? `file:${matched}:${filePath}` : null;
    }),
    ...disallowedObligationIds.map((id) => `obligation:${id}`),
  ]);
  const eligible = (lowRiskShape || staticArtifact) && riskSignals.length === 0;
  const reason = eligible
    ? (staticArtifact ? "static_artifact" : `shape:${shapePrimary}`)
    : !lowRiskShape && !staticArtifact
      ? "shape_not_low_risk"
      : "high_risk_signal";

  return {
    mode: "compact_low_risk",
    eligible,
    reason,
    shape: shapePrimary || "unknown",
    static_artifact: staticArtifact,
    low_risk_shape: lowRiskShape,
    blocking_risks: riskSignals,
    blocking_obligation_ids: blockingObligationIds,
    allowed_obligation_ids: [...COMPACT_LOW_RISK_ALLOWED_OBLIGATIONS],
    required_sentence_label: "Low-risk verification obligation",
  };
}

export function computeVerificationObligationSynthesis({
  cwd = process.cwd(),
  planDir = null,
  stateJson = null,
  planContent = "",
  storyRegistry = null,
  planShape = null,
  taskFocusContract = null,
} = {}) {
  const effectiveStoryRegistry = storyRegistry || loadStoryRegistry(cwd);
  const personaSummary = loadPersonaArtifactSummary(planDir);
  const scopeContract = planDir ? readScopeContract(planDir) : null;
  const ambientFiles = new Set((scopeContract?.ambient_dirty_files || []).map(normalizePath));
  const ownedFiles = new Set((scopeContract?.owned_files || scopeContract?.declared_files || []).map(normalizePath));
  const planMatchContext = loadPlanMatchContext({
    cwd,
    planDir,
    stateJson,
    planContent,
    storyRegistry: effectiveStoryRegistry,
  });

  const searchText = [
    planMatchContext.goalText,
    planMatchContext.planSearchText,
  ].filter(Boolean).join("\n");
  const fileContextPaths = Array.isArray(planMatchContext.plannedFiles) && planMatchContext.plannedFiles.length > 0
    ? planMatchContext.plannedFiles
    : planMatchContext.effectiveFiles;

  const obligations = [];

  // v7.3.1: derive shape-aware filter. Caller can pass an explicit planShape;
  // otherwise we infer from goalText + plannedFiles + intentContract.
  // `unknown` falls through to legacy behavior (all families allowed).
  let shapePrimary = planShape?.primary || null;
  if (!shapePrimary) {
    try {
      const detected = detectPlanShape({
        goalText: planMatchContext.goalText || "",
        plannedFiles: planMatchContext.plannedFiles || planMatchContext.effectiveFiles || [],
        intentContract: planMatchContext.intentContract || null,
      });
      shapePrimary = detected.primary;
    } catch { shapePrimary = null; }
  }
  const focusContract = taskFocusContract || deriveTaskFocusContract({
    cwd,
    planDir,
    goalText: planMatchContext.goalText || "",
    intentContract: planMatchContext.intentContract || null,
    scopeContract,
    plannedFiles: planMatchContext.plannedFiles || planMatchContext.effectiveFiles || [],
    planShape: shapePrimary ? { primary: shapePrimary } : null,
  });
  const forcePacks = [
    ...normalizeStringList(safeReadJson(join(cwd, "audit.config.json"))?.force_packs),
    ...normalizeStringList(safeReadJson(join(cwd, ".agent", "audit.config.json"))?.force_packs),
  ];
  const personaAuthorityOpts = {
    planShape: shapePrimary ? { primary: shapePrimary } : null,
    forcePacks,
    evidence: ["verification_obligation_synthesis"],
    taskFocusContract: focusContract,
  };

  for (const family of VERIFICATION_OBLIGATION_FAMILIES) {
    const ambiguousKeywords = Array.isArray(family.context_keywords_ambiguous)
      ? family.context_keywords_ambiguous
      : null;
    const unambiguousKeywords = Array.isArray(family.context_keywords_unambiguous)
      ? family.context_keywords_unambiguous
      : null;
    const matches = {
      goal_terms_task: findKeywordMatches(planMatchContext.goalText, family.context_keywords),
      goal_terms: findKeywordMatches(searchText, family.context_keywords),
      goal_terms_unambiguous: unambiguousKeywords ? findKeywordMatches(searchText, unambiguousKeywords) : [],
      goal_terms_ambiguous: ambiguousKeywords ? findKeywordMatches(searchText, ambiguousKeywords) : [],
      files: findPathKeywordMatches(fileContextPaths, family.file_keywords),
      deliverable_kinds: findDeliverableKindMatches(planMatchContext.deliverables, family.deliverable_kinds),
      story_tags: findStoryTagMatches(planMatchContext.storyTags, family.story_tags),
      persona_packs: findPersonaPackMatches(personaSummary, family.persona_packs, personaAuthorityOpts),
    };

    const nonPersonaSignalCount = matches.goal_terms.length +
      matches.files.length +
      matches.deliverable_kinds.length +
      matches.story_tags.length;
    const structuredSignalCount = matches.files.length +
      matches.deliverable_kinds.length +
      matches.story_tags.length;

    // v7.3.1: shape-conditional allowlist. Skip families that don't apply
    // for the detected plan shape — UNLESS a structured signal (file path,
    // deliverable kind, story tag) confirms the family genuinely applies.
    // Structured signals are evidence the work *is* that family; shape
    // filter should not override real evidence.
    if (!obligationFamilyAllowedForShape(family.id, shapePrimary) && structuredSignalCount === 0) continue;

    if (family.requires_goal_signal && matches.goal_terms_task.length === 0) continue;

    if (nonPersonaSignalCount === 0 && !(family.allow_persona_only && matches.persona_packs.length > 0)) continue;
    if (structuredSignalCount === 0 &&
        matches.goal_terms.length < 2 &&
        matches.goal_terms_unambiguous.length === 0 &&
        !(family.allow_persona_only && matches.persona_packs.length > 0)) {
      continue;
    }

    // v7.3.1: families flagged require_structured_or_unambiguous activate
    // only when a structured signal OR an unambiguous keyword is present.
    // Multiple ambiguous-only goal_terms (e.g. "model" + "signal" in non-quant
    // text) no longer trigger quant_modeling.
    if (family.require_structured_or_unambiguous &&
        structuredSignalCount === 0 &&
        matches.goal_terms_unambiguous.length === 0 &&
        matches.persona_packs.length === 0) {
      continue;
    }

    const sourceSignals = collectSourceSignals(family, matches);
    const sourceProvenance = buildSourceProvenance(sourceSignals, { ambientFiles, ownedFiles });
    const onlyAmbientFileProvenance = sourceProvenance.length > 0 &&
      sourceProvenance.every((entry) => entry.source === "ambient_dirty_scope");
    const focusAllowsFamily = obligationFamilyAllowedForFocus(family, focusContract);
    const blocking = !onlyAmbientFileProvenance && focusAllowsFamily;

    obligations.push({
      id: family.id,
      label: family.label,
      verification_mode: family.verification_mode,
      required_proof_type: family.required_proof_type,
      proof_ids: family.proof_ids,
      suggested_proof_ids: family.proof_ids,
      proof_keywords: family.proof_keywords,
      context_keywords: family.context_keywords,
      requires_audit_review: family.requires_audit_review,
      rationale: family.rationale,
      matched_goal_terms: matches.goal_terms,
      matched_files: matches.files,
      matched_deliverable_kinds: matches.deliverable_kinds,
      matched_story_tags: matches.story_tags,
      matched_persona_packs: matches.persona_packs,
      source_signals: sourceSignals,
      source_provenance: sourceProvenance,
      source_scope: onlyAmbientFileProvenance ? "ambient_dirty_scope" : "owned_or_plan_context",
      focus_status: focusAllowsFamily ? "authorized" : "advisory_by_task_focus",
      blocking,
      system_boundaries_touched: buildBoundarySummary(matches),
    });
  }

  const blockingObligations = obligations.filter((obligation) => obligation.blocking !== false);
  const required = blockingObligations.length > 0;
  const requiredValidationLevels = required
    ? uniqueList([
      "Context-appropriate integration tested",
      blockingObligations.some((obligation) => obligation.requires_audit_review) ? "Audit reviewed" : null,
    ])
    : [];

  return {
    required,
    status: required ? "synthesized" : "not_required",
    goal: planMatchContext.goalText,
    required_plan_fields: required ? [
      "Repo/system context",
      "Task shape",
      "Ontology signals",
      "Persona signals",
      "System boundaries touched",
      "Derived verification obligations",
    ] : [],
    required_reporting_sections: required ? [
      "Systems Exercised",
      "Remaining Unverified",
      "Verification Sufficiency",
    ] : [],
    required_validation_levels: requiredValidationLevels,
    source_summary: {
      repo_contexts: obligations.map((obligation) => obligation.label),
      task_shape_signals: uniqueList(obligations.flatMap((obligation) => [
        ...obligation.matched_goal_terms,
        ...obligation.matched_deliverable_kinds,
      ])),
      ontology_signals: uniqueList(obligations.flatMap((obligation) => [
        ...obligation.matched_story_tags.map((tag) => `story_tag:${tag}`),
        ...obligation.matched_files
          .filter((filePath) => normalizePath(filePath).toLowerCase().includes("recipes/"))
          .map((filePath) => `recipe_surface:${filePath}`),
      ])),
      persona_signals: uniqueList([
        ...normalizeStringList(focusContract?.authoritative_packs).map((packId) => `focus_authoritative:${packId}`),
        ...normalizeStringList(focusContract?.advisory_packs).map((packId) => `focus_advisory:${packId}`),
        ...normalizeStringList(personaSummary.pack_ids).map((packId) => `pack:${packId}`),
        ...normalizeStringList(personaSummary.constraints?.blocking_ids).map((constraintId) => `blocking:${constraintId}`),
        ...normalizeStringList((personaSummary.issues || []).map((issue) => issue.code)).map((code) => `artifact_issue:${code}`),
      ]),
      system_boundaries: uniqueList(obligations.flatMap((obligation) => obligation.system_boundaries_touched)),
    },
    persona_summary: personaSummary,
    task_focus_contract: focusContract,
    persona_artifact_issues: personaSummary.issues || [],
    plan_shape: shapePrimary || "unknown",
    low_risk_verification_policy: deriveLowRiskVerificationMatrixPolicy({
      shapePrimary,
      planMatchContext,
      obligations,
    }),
    story_ids: planMatchContext.storyIds,
    story_tags: planMatchContext.storyTags,
    effective_files: planMatchContext.effectiveFiles,
    deliverable_kinds: uniqueList((planMatchContext.deliverables || []).map((deliverable) => normalizeKeyword(deliverable?.kind)).filter(Boolean)),
    active_count: obligations.length,
    blocking_count: blockingObligations.length,
    obligations,
    detail: required
      ? `Synthesized ${blockingObligations.length} blocking verification obligation(s): ${blockingObligations.map((obligation) => obligation.label).join(", ")}`
      : obligations.length > 0
        ? `Synthesized ${obligations.length} advisory obligation(s) from ambient context; no blocking proof obligation required`
        : "No synthesized verification obligations required for this plan context",
  };
}

const ADVERSARIAL_AUDIT_PROFILES = Object.freeze([
  Object.freeze({
    id: "quant_truthfulness",
    label: "Quant Truthfulness",
    archetypes: ["quant"],
    obligation_ids: [],
    persona_packs: ["quant"],
    adversarial_objective: "Try to make the algorithm look valid, profitable, or calibrated when it is actually leaked, fragile, or untradeable.",
    primary_question: "How could this system create false alpha or false confidence without obviously crashing?",
    primary_focus: [
      "Temporal leakage and target leakage",
      "Regime fragility and split realism",
      "Execution, slippage, and live-parity realism",
    ],
    attack_vectors: [
      Object.freeze({
        id: "quant_temporal_leakage",
        title: "Make future information leak into the model",
        prompt: "Try to find any split, feature, label, or benchmark path that lets future information improve the reported result.",
        why: "Quant systems fail expensively when they look predictive for the wrong reason.",
        priority: "high",
      }),
      Object.freeze({
        id: "quant_regime_fragility",
        title: "Collapse the edge outside the winning regime",
        prompt: "Try alternate periods, sparse slices, or changed market regimes to see whether the apparent edge disappears once conditions shift.",
        why: "A strategy that only works in one historical pocket can still look excellent in a headline backtest.",
        priority: "high",
      }),
      Object.freeze({
        id: "quant_execution_reality_gap",
        title: "Break the result with realistic execution assumptions",
        prompt: "Try realistic slippage, latency, fills, costs, or position constraints until the reported edge stops looking deployable.",
        why: "Backtests often fail at the execution layer long before the code throws an error.",
        priority: "medium",
      }),
    ],
  }),
  Object.freeze({
    id: "ui_resilience",
    label: "UI Resilience",
    archetypes: ["ux_ui", "ux_ui_course"],
    obligation_ids: ["browser_ui"],
    persona_packs: ["ux_ui"],
    adversarial_objective: "Try to crash, freeze, mislead, or lock out the user-visible experience.",
    primary_question: "How could a user hit a broken or deceptive state even if the happy-path demo looks fine?",
    primary_focus: [
      "Null, empty, and error-state rendering",
      "Stale state, races, and repeated interactions",
      "Responsive and accessibility failures",
    ],
    attack_vectors: [
      Object.freeze({
        id: "ui_null_or_error_render",
        title: "Crash or mislead the rendered state with empty data",
        prompt: "Try null, empty, partial, or slow-loading data until the rendered surface crashes, freezes, or lies about what state the user is in.",
        why: "User-visible failures often come from incomplete data rather than syntax errors.",
        priority: "high",
      }),
      Object.freeze({
        id: "ui_state_race",
        title: "Break the flow with stale or out-of-order state",
        prompt: "Try repeated clicks, back/forward navigation, or out-of-order responses to surface stale state, duplicate actions, or misleading progress.",
        why: "Race conditions create expensive UX bugs without requiring a full app crash.",
        priority: "high",
      }),
      Object.freeze({
        id: "ui_responsive_accessibility_lockout",
        title: "Lock the user out on mobile or assistive paths",
        prompt: "Try narrow screens, keyboard-only use, zoomed layouts, and accessibility-critical flows until controls disappear, overlap, or become unreachable.",
        why: "A UI can pass a happy-path review while still failing the environments real users depend on.",
        priority: "medium",
      }),
    ],
  }),
  Object.freeze({
    id: "wordpress_guardrails",
    label: "WordPress Guardrails",
    archetypes: ["cms_plugin"],
    obligation_ids: [],
    persona_packs: [],
    adversarial_objective: "Try to mutate privileged behavior through hooks, nonces, REST surfaces, or escaping gaps without obvious breakage.",
    primary_question: "How could this plugin quietly widen capability or trust untrusted input while appearing to work?",
    primary_focus: [
      "Nonce and capability enforcement",
      "Hook and filter integrity",
      "REST auth and escaping/sanitization gaps",
    ],
    attack_vectors: [
      Object.freeze({
        id: "wp_nonce_capability_bypass",
        title: "Bypass nonce or capability checks",
        prompt: "Try unauthenticated, low-privilege, or stale-nonce requests against admin, AJAX, or REST actions to see whether privileged behavior still executes.",
        why: "WordPress failures are often silent authorization bugs rather than crashes.",
        priority: "high",
      }),
      Object.freeze({
        id: "wp_hook_integrity_conflict",
        title: "Break behavior through hook ordering or missing guards",
        prompt: "Try conflicting hook registration order, duplicate registrations, or missing removal paths until filters or actions produce unintended side effects.",
        why: "Hook-based systems can drift semantically while still returning valid responses.",
        priority: "medium",
      }),
      Object.freeze({
        id: "wp_rest_escape_gap",
        title: "Exploit REST or output escaping gaps",
        prompt: "Try untrusted payloads through REST handlers and rendering paths to see whether output is exposed without proper auth, escaping, or sanitization.",
        why: "REST and templating surfaces often hide the most expensive trust bugs.",
        priority: "medium",
      }),
    ],
  }),
  Object.freeze({
    id: "workflow_truthfulness",
    label: "Workflow Truthfulness",
    archetypes: ["workflow_automation", "content_automation"],
    obligation_ids: ["recipe_orchestration", "migration_parity"],
    persona_packs: ["traceability", "wiring_auditor", "assumptions_challenger"],
    adversarial_objective: "Try to make the workflow claim success, completeness, or parity even when the real system path was not exercised.",
    primary_question: "How could this system look green while the real boundary behavior is missing, partial, or untrue?",
    primary_focus: [
      "False-success status or artifact claims",
      "Partial-failure and retry truthfulness",
      "Migration, contract, and parity drift",
    ],
    attack_vectors: [
      Object.freeze({
        id: "workflow_false_success",
        title: "Report success without exercising the real path",
        prompt: "Try to find any route where the workflow reports completion even though the downstream system, connector, or live boundary was never actually exercised.",
        why: "Orchestration systems often fail by false green status rather than hard exceptions.",
        priority: "high",
      }),
      Object.freeze({
        id: "workflow_partial_failure_resume",
        title: "Hide partial failure behind retries or resumes",
        prompt: "Try mid-flight dependency failure, timeout, or replay so the system looks resumable or successful while leaving duplicate or missing side effects.",
        why: "Partial truth is more dangerous than explicit failure in automation-heavy systems.",
        priority: "high",
      }),
      Object.freeze({
        id: "workflow_contract_or_migration_drift",
        title: "Let contracts, docs, or parity claims drift from behavior",
        prompt: "Try to find any place where docs, migration claims, or proof artifacts say one thing while the actual route, runner, or compatibility path does another.",
        why: "Shared workflow systems often decay through contract drift before they obviously break.",
        priority: "medium",
      }),
    ],
  }),
  Object.freeze({
    id: "backend_integrity",
    label: "Backend Integrity",
    archetypes: [],
    obligation_ids: ["backend_service", "api_integration"],
    persona_packs: ["wiring_auditor", "assumptions_challenger"],
    adversarial_objective: "Try to create silent corruption, partial writes, auth drift, or duplicate side effects.",
    primary_question: "How could this service return plausible answers while corrupting truth underneath?",
    primary_focus: [
      "Silent data corruption and partial writes",
      "Auth, scope, and tenant drift",
      "Retry, timeout, and idempotency failures",
    ],
    attack_vectors: [
      Object.freeze({
        id: "backend_silent_corruption",
        title: "Silently corrupt or coerce state",
        prompt: "Try malformed, boundary, or partial inputs until the service accepts them with coercion, truncation, or default values instead of explicit failure.",
        why: "Backend incidents often come from silent truth loss rather than exceptions.",
        priority: "high",
      }),
      Object.freeze({
        id: "backend_auth_scope_drift",
        title: "Escape the intended permission or data scope",
        prompt: "Try unauthenticated, cross-scope, or low-privilege requests to see whether data or actions escape the intended authorization boundary.",
        why: "Permission drift can look like normal functionality until the wrong actor hits it.",
        priority: "high",
      }),
      Object.freeze({
        id: "backend_retry_idempotency",
        title: "Duplicate side effects through retries or partial failure",
        prompt: "Try retries, timeouts, and replayed requests to see whether the system produces duplicates, missing compensation, or false 200-style success.",
        why: "Distributed paths often fail at retry semantics before they fail at basic syntax.",
        priority: "medium",
      }),
    ],
  }),
]);

function uniqueById(entries) {
  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    items.push(entry);
  }
  return items;
}

function intersectNormalized(left, right) {
  const rightSet = new Set((Array.isArray(right) ? right : []).map(normalizeKeyword));
  return uniqueList((Array.isArray(left) ? left : []).filter((value) => rightSet.has(normalizeKeyword(value))));
}

function buildAttackVector(definition, sourceSignals = []) {
  return {
    id: definition.id,
    title: definition.title,
    prompt: definition.prompt,
    why: definition.why,
    priority: definition.priority || "medium",
    source_signals: uniqueList(sourceSignals),
  };
}

function collectDiagnosticTokens(entries) {
  const tokens = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const text = normalizeText(`${entry?.kind || ""} ${entry?.detail || entry || ""}`);
    if (text.includes("adjacency gap")) tokens.add("adjacency_gap");
    if (text.includes("missing visual evidence")) tokens.add("missing_visual_evidence");
    if (text.includes("missing integration probe")) tokens.add("missing_integration_probe");
    if (text.includes("missing mutually exclusive") || text.includes("config fact gap")) tokens.add("config_fact_gap");
    if (text.includes("missing postcondition") || text.includes("story semantic gap")) tokens.add("story_semantic_gap");
    if (text.includes("temporal split")) tokens.add("quant_temporal_split");
    if (text.includes("leakage")) tokens.add("quant_leakage");
    if (text.includes("calibration")) tokens.add("quant_calibration");
    if (text.includes("backtest or parity")) tokens.add("quant_backtest_parity");
  }
  return [...tokens];
}

function deriveSignalDrivenVectors({ diagnosticTokens, symmetryHunts = [], sourceSignals = [] }) {
  const vectors = [];
  const symmetryRequiresRedTeam = (symmetryHunts || []).some((entry) => entry?.recommended_guard === "requires_red_team");

  if (diagnosticTokens.includes("missing_visual_evidence")) {
    vectors.push(buildAttackVector({
      id: "signal_rendered_truth_gap",
      title: "Find a rendered-truth gap the local proof missed",
      prompt: "Try to find any browser-visible or user-visible state where the rendered truth diverges from what wrapper tests or local logic suggest.",
      why: "Missing visual evidence is a clue that the real UX truth surface may still be untested.",
      priority: "high",
    }, [...sourceSignals, "diagnostic:missing_visual_evidence"]));
  }

  if (diagnosticTokens.includes("missing_integration_probe")) {
    vectors.push(buildAttackVector({
      id: "signal_false_success_boundary",
      title: "Make the boundary look green without reaching the dependency",
      prompt: "Try to make the integration path return a plausible success shape even though the real dependency, connector, or transport path was never exercised.",
      why: "Missing integration probes usually hide false-success states at the boundary.",
      priority: "high",
    }, [...sourceSignals, "diagnostic:missing_integration_probe"]));
  }

  if (diagnosticTokens.includes("config_fact_gap")) {
    vectors.push(buildAttackVector({
      id: "signal_contradictory_runtime_modes",
      title: "Force contradictory runtime modes",
      prompt: "Try incompatible config or flag combinations until the system reaches an impossible or misleading mode that docs and code disagree about.",
      why: "Missing contradiction facts are a strong hint that hidden impossible states still exist.",
      priority: "medium",
    }, [...sourceSignals, "diagnostic:config_fact_gap"]));
  }

  if (diagnosticTokens.includes("story_semantic_gap")) {
    vectors.push(buildAttackVector({
      id: "signal_unmodeled_state_transition",
      title: "Reach an unmodeled end state",
      prompt: "Try to drive the system into a stateful outcome that the stories or postconditions do not describe, especially after partial failure or repeated actions.",
      why: "Missing story semantics mean the ontology cannot yet prove which end states are valid.",
      priority: "medium",
    }, [...sourceSignals, "diagnostic:story_semantic_gap"]));
  }

  if (diagnosticTokens.includes("quant_temporal_split")) {
    vectors.push(buildAttackVector({
      id: "signal_quant_temporal_split",
      title: "Exploit a weak temporal split",
      prompt: "Try to improve the result simply by changing temporal split assumptions, walk-forward boundaries, or lookback windows.",
      why: "A missing temporal split check is a direct signal that timeline discipline may still be weak.",
      priority: "high",
    }, [...sourceSignals, "diagnostic:quant_temporal_split"]));
  }

  if (diagnosticTokens.includes("quant_leakage")) {
    vectors.push(buildAttackVector({
      id: "signal_quant_leakage",
      title: "Leak target knowledge into evaluation",
      prompt: "Try to find any feature engineering, labeling, or benchmark path that silently imports future or post-outcome information.",
      why: "A leakage warning is already telling us where the false-confidence risk lives.",
      priority: "high",
    }, [...sourceSignals, "diagnostic:quant_leakage"]));
  }

  if (diagnosticTokens.includes("quant_calibration")) {
    vectors.push(buildAttackVector({
      id: "signal_quant_calibration",
      title: "Overstate confidence without changing the ranking",
      prompt: "Try to find prediction outputs that keep the ordering plausible while the confidence, sizing, or calibration becomes misleading.",
      why: "Calibration failures can hide under apparently reasonable directional accuracy.",
      priority: "medium",
    }, [...sourceSignals, "diagnostic:quant_calibration"]));
  }

  if (diagnosticTokens.includes("quant_backtest_parity")) {
    vectors.push(buildAttackVector({
      id: "signal_quant_live_parity",
      title: "Separate backtest success from live behavior",
      prompt: "Try to create a path where the backtest remains green while live or parity assumptions would obviously fail.",
      why: "Backtest/live mismatch is a classic false-green quant failure.",
      priority: "medium",
    }, [...sourceSignals, "diagnostic:quant_backtest_parity"]));
  }

  if (diagnosticTokens.includes("adjacency_gap") || symmetryRequiresRedTeam) {
    vectors.push(buildAttackVector({
      id: "signal_parallel_failure_hunt",
      title: "Find the same failure shape in adjacent surfaces",
      prompt: "Search sibling modules, alternate routes, nearby workflows, or other repos for the same failure class instead of stopping at the first local hit.",
      why: "Adjacency gaps and symmetry hunts both indicate that the planner already expects parallel failures nearby.",
      priority: "medium",
    }, [
      ...sourceSignals,
      ...(diagnosticTokens.includes("adjacency_gap") ? ["diagnostic:adjacency_gap"] : []),
      ...(symmetryRequiresRedTeam ? ["symmetry:requires_red_team"] : []),
    ]));
  }

  return vectors;
}

function scoreAdversarialProfile(profile, {
  discoveryArchetype = null,
  obligationIds = [],
  personaPackIds = [],
} = {}) {
  const matchedArchetypes = intersectNormalized(profile.archetypes, [discoveryArchetype].filter(Boolean));
  const matchedObligations = intersectNormalized(profile.obligation_ids, obligationIds);
  const matchedPersonaPacks = intersectNormalized(profile.persona_packs, personaPackIds);

  const matchedSourceSignals = uniqueList([
    ...matchedArchetypes.map((value) => `archetype:${value}`),
    ...matchedObligations.map((value) => `obligation:${value}`),
    ...matchedPersonaPacks.map((value) => `persona:${value}`),
  ]);

  return {
    score: (matchedArchetypes.length * 6) + (matchedObligations.length * 3) + matchedPersonaPacks.length,
    matchedArchetypes,
    matchedObligations,
    matchedPersonaPacks,
    matchedSourceSignals,
  };
}

export function computeAdversarialAuditProfile({
  discoveryArchetype = null,
  verificationObligationSynthesis = null,
  personaSummary = null,
  repairableVariances = [],
  semanticBlocks = [],
  symmetryHunts = [],
} = {}) {
  const obligationIds = uniqueList((verificationObligationSynthesis?.obligations || []).map((entry) => entry?.id).filter(Boolean));
  const personaPackIds = normalizeStringList(personaSummary?.pack_ids);

  let selectedProfile = null;
  let selectedMatch = null;
  for (const profile of ADVERSARIAL_AUDIT_PROFILES) {
    const match = scoreAdversarialProfile(profile, {
      discoveryArchetype,
      obligationIds,
      personaPackIds,
    });
    if (!selectedProfile || match.score > selectedMatch.score) {
      selectedProfile = profile;
      selectedMatch = match;
    }
  }

  if (!selectedProfile || selectedMatch.score <= 0) {
    selectedProfile = null;
    selectedMatch = {
      matchedArchetypes: [],
      matchedObligations: [],
      matchedPersonaPacks: [],
      matchedSourceSignals: [],
    };
  }

  const diagnosticTokens = collectDiagnosticTokens([
    ...(Array.isArray(repairableVariances) ? repairableVariances : []),
    ...(Array.isArray(semanticBlocks) ? semanticBlocks : []),
  ]);

  const baseVectors = selectedProfile
    ? (selectedProfile.attack_vectors || []).map((definition) => buildAttackVector(definition, selectedMatch.matchedSourceSignals))
    : [];
  const signalVectors = deriveSignalDrivenVectors({
    diagnosticTokens,
    symmetryHunts,
    sourceSignals: selectedMatch.matchedSourceSignals,
  });
  const suggestedAttackVectors = uniqueById([...baseVectors, ...signalVectors]).slice(0, 6);

  const required = !!selectedProfile || suggestedAttackVectors.length > 0;
  const label = selectedProfile?.label || (required ? "Signal-Driven Adversarial Hints" : null);
  const adversarialObjective = selectedProfile?.adversarial_objective || (required
    ? "Use the ontology-backed risk signals to choose the most expensive way this system could fail, rather than defaulting to generic attack prompts."
    : null);
  const primaryQuestion = selectedProfile?.primary_question || null;
  const primaryFocus = selectedProfile?.primary_focus || [];
  const matchedSourceSignals = uniqueList([
    ...selectedMatch.matchedSourceSignals,
    ...diagnosticTokens.map((token) => `diagnostic:${token}`),
    ...((symmetryHunts || []).some((entry) => entry?.recommended_guard === "requires_red_team") ? ["symmetry:requires_red_team"] : []),
  ]);

  return {
    required,
    status: required ? "synthesized" : "not_required",
    profile_id: selectedProfile?.id || null,
    label,
    discovery_archetype: discoveryArchetype || null,
    matched_obligations: selectedMatch.matchedObligations,
    matched_persona_packs: selectedMatch.matchedPersonaPacks,
    matched_source_signals: matchedSourceSignals,
    adversarial_objective: adversarialObjective,
    primary_question: primaryQuestion,
    primary_focus: primaryFocus,
    attack_vector_count: suggestedAttackVectors.length,
    detail: required
      ? `${label} — ${suggestedAttackVectors.length} suggested attack vector(s)`
      : "No archetype-specific adversarial profile synthesized for this context",
    suggested_attack_vectors: suggestedAttackVectors,
  };
}
