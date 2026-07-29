#!/usr/bin/env node
// planner_hygiene.mjs — compact repo cleanup orchestration for low-token planner hygiene.
//
// Usage:
//   node planner_hygiene.mjs scan --compact
//   node planner_hygiene.mjs scan --json
//   node planner_hygiene.mjs fix-safe
//   node planner_hygiene.mjs fix-safe --write
//   node planner_hygiene.mjs fix-safe --json --write
//
// Design rules:
//   - Reuse existing planner truth sources first (`planner_findings`, `story_registry`, `rule_engine`)
//   - Bucket issues into `auto_fix`, `needs_decision`, and `defer`
//   - Only rewrite deterministic bookkeeping drift
//   - Keep unsupported or ambiguous cleanup work visible rather than guessing

import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { computeRecommendedPath } from "./lib/planner_phase_routing.mjs";
import { resolveAntiRitualAssessment } from "./lib/anti_ritual_contract.mjs";
import { isMarkdownTableSeparatorRow, splitMarkdownTableRow } from "./lib/markdown_table.mjs";
import { normalizeVerificationStatus } from "./lib/verification_status_vocabulary.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const NODE = process.execPath;

const REMEDIATION_QUEUE_PATH = join("reports", "remediation_queue.md");
const REVIEW_SUMMARY_PATH = join("reports", "full_review_summary.md");
const STORY_REGISTRY_PATH = join("reports", "user_story_audit", "story_registry.json");

const CANONICAL_QUEUE_STATUSES = new Map([
  ["done", "DONE"],
  ["mitigated", "MITIGATED"],
  ["already mitigated", "MITIGATED"],
  ["pending", "PENDING"],
  ["defer", "DEFER"],
  ["deferred", "DEFER"],
  ["low risk / deferred", "DEFER"],
  ["low risk/deferred", "DEFER"],
  ["blocked", "BLOCKED"],
  ["incomplete", "INCOMPLETE"],
  ["skipped", "SKIPPED"],
]);

const PLANNER_PREFIX_ALLOWLIST = [
  "scripts/",
  "tests/",
  "config/",
  "prolog/",
  "checklists/",
  "references/",
  "analyzers/",
  "packs/",
  "SKILL.md",
  "MIGRATION.md",
  "QUICKSTART.md",
  "ERROR-RECOVERY.md",
  "EDGE-CASES.md",
  "audit.config.example.json",
  "mcp_server.mjs",
];

const NEEDS_DECISION_VARIANCE_KINDS = new Set([
  "story_registry_gap",
  "remediation_backlog_gap",
  "adjacency_gap",
  "domain_checklist_gap",
  "config_fact_gap",
  "story_semantic_gap",
  "structural_token_renderer_gap",
  "proof_gap",
]);

function safeRead(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function canonicalPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function safeReadJson(filePath) {
  try {
    const content = safeRead(filePath);
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function extractJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to debug-tolerant extraction.
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runJsonScript(scriptName, args = [], cwd = process.cwd()) {
  const scriptPath = join(scriptDir, scriptName);
  try {
    const stdout = execFileSync(NODE, [scriptPath, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      ok: true,
      status: 0,
      stdout,
      stderr: "",
      parsed: extractJson(stdout),
    };
  } catch (error) {
    const stdout = error.stdout || "";
    const stderr = error.stderr || "";
    return {
      ok: false,
      status: error.status ?? 1,
      stdout,
      stderr,
      parsed: extractJson(stdout),
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

function slugify(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = splitMarkdownTableRow(trimmed);
  if (cells.length === 0) return null;
  if (isMarkdownTableSeparatorRow(trimmed)) return null;
  return cells;
}

function renderMarkdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function normalizeQueueStatus(value) {
  const normalized = normalizeText(value);
  return CANONICAL_QUEUE_STATUSES.get(normalized) || String(value || "").trim().toUpperCase() || "UNKNOWN";
}

function normalizeSummaryStatus(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === "done") return "DONE";
  if (normalized === "already mitigated") return "MITIGATED";
  if (normalized.includes("low risk") && normalized.includes("defer")) return "DEFER";
  if (normalized === "deferred" || normalized === "defer") return "DEFER";
  if (normalized === "blocked") return "BLOCKED";
  if (normalized === "incomplete") return "INCOMPLETE";
  if (normalized === "skipped") return "SKIPPED";
  if (normalized === "mitigated") return "MITIGATED";
  return null;
}

function extractIssueIds(value) {
  return [...new Set(String(value || "").match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/g) || [])];
}

function humanizeKind(kind) {
  return String(kind || "")
    .split(/[_-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function parseRemediationQueue(content) {
  const lines = String(content || "").split("\n");
  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    const cells = parseMarkdownTableRow(lines[index]);
    if (!cells || cells.length < 8) continue;
    if (/^#$/i.test(cells[0]) || /^id$/i.test(cells[1])) continue;

    entries.push({
      lineIndex: index,
      cells,
      ordinal: cells[0],
      id: cells[1],
      source: cells[2],
      severity: cells[3],
      title: cells[4],
      files: cells[5],
      dependsOn: cells[6],
      statusRaw: cells[7],
      status: normalizeQueueStatus(cells[7]),
    });
  }
  return { lines, entries };
}

function parseReviewSummary(content) {
  const lines = String(content || "").split("\n");
  let inSection = false;
  const byId = new Map();

  for (const line of lines) {
    if (/^##\s+Remediation Results\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;

    const cells = parseMarkdownTableRow(line);
    if (!cells || cells.length < 3) continue;
    if (/^status$/i.test(cells[0])) continue;

    const normalizedStatus = normalizeSummaryStatus(cells[0]);
    const ids = extractIssueIds(cells[2]);
    if (!normalizedStatus || ids.length === 0) continue;

    for (const id of ids) {
      byId.set(id, {
        id,
        status: normalizedStatus,
        sourceStatus: cells[0],
        sourceItems: cells[2],
      });
    }
  }

  return { byId };
}

function splitRef(ref) {
  const value = String(ref || "");
  const firstColon = value.indexOf(":");
  if (firstColon === -1) return { base: value, suffix: "" };
  return {
    base: value.slice(0, firstColon),
    suffix: value.slice(firstColon),
  };
}

function storyRegistryWarningKey(value) {
  return String(value || "")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function storyRegistryFieldLabel(field) {
  if (field === "code_refs") return "code_ref";
  if (field === "test_refs") return "test_ref";
  if (field === "validation_refs") return "validation_ref";
  return field;
}

function isPlannerRelativePath(value) {
  return PLANNER_PREFIX_ALLOWLIST.some((prefix) => String(value || "").startsWith(prefix));
}

function buildPlannerPrefixedPath(value) {
  if (!isPlannerRelativePath(value)) return null;
  return `.agent/skills/iterative-planner/${value}`;
}

function collectPlannerFindingsItems(result) {
  const needsDecision = [];
  const defer = [];
  const parsed = result?.parsed;

  if (!parsed) {
    needsDecision.push({
      id: "planner_findings_unavailable",
      bucket: "needs_decision",
      kind: "upstream_check_unavailable",
      title: "planner_findings did not return parseable JSON",
      detail: "The compact hygiene scan could not parse planner_findings output; inspect the upstream script before trusting cleanup status.",
      source: "planner_findings",
    });
    return { needsDecision, defer };
  }

  for (const entry of parsed.semantic_blocks || []) {
    const detail = String(entry?.detail || "");
    needsDecision.push({
      id: `semantic_block:${slugify(entry?.kind)}:${slugify(detail)}`,
      bucket: "needs_decision",
      kind: entry?.kind || "semantic_block",
      title: `Planner finding: ${humanizeKind(entry?.kind || "semantic_block")}`,
      detail,
      source: "planner_findings",
    });
  }

  for (const violation of parsed.invariant_violations || []) {
    needsDecision.push({
      id: `invariant_violation:${slugify(violation)}`,
      bucket: "needs_decision",
      kind: "invariant_violation",
      title: "Invariant violation requires investigation",
      detail: String(violation),
      source: "planner_findings",
    });
  }

  for (const entry of parsed.repairable_variances || []) {
    const kind = entry?.kind || "repairable_variance";
    const detail = String(entry?.detail || "");
    const target = NEEDS_DECISION_VARIANCE_KINDS.has(kind) ? needsDecision : defer;
    target.push({
      id: `${target === needsDecision ? "needs_decision" : "defer"}:${slugify(kind)}:${slugify(detail)}`,
      bucket: target === needsDecision ? "needs_decision" : "defer",
      kind,
      title: `Planner finding: ${humanizeKind(kind)}`,
      detail,
      source: "planner_findings",
    });
  }

  for (const warning of parsed.invariant_warnings || []) {
    defer.push({
      id: `invariant_warning:${slugify(warning)}`,
      bucket: "defer",
      kind: "invariant_warning",
      title: "Invariant advisory",
      detail: String(warning),
      source: "planner_findings",
    });
  }

  const antiRitual = parsed?.anti_ritual;
  for (const driftId of antiRitual?.drift_ids || []) {
    const target = driftId === "ritual_only_blocker" || driftId === "execute_supervision_drift"
      ? needsDecision
      : defer;
    target.push({
      id: `anti_ritual:${slugify(driftId)}`,
      bucket: target === needsDecision ? "needs_decision" : "defer",
      kind: "anti_ritual",
      title: `Anti-ritual drift: ${humanizeKind(driftId)}`,
      detail: antiRitual.detail,
      source: "planner_findings",
    });
  }

  if (parsed?.knowledge_trust_summary?.gap_check_needed) {
    const reviewSurface = parsed?.draft_promotion_contract?.review_surface?.relative_path || "plans/knowledge/draft_candidates.review.json";
    defer.push({
      id: `knowledge_gap_check:${slugify(parsed.knowledge_trust_summary.gap_check_reason || "required")}`,
      bucket: "defer",
      kind: "knowledge_gap_check",
      title: "Reviewed draft knowledge gap-check is available",
      detail: `Trusted retrieval is weak. If a reviewer or outer agent finds missed candidates, record them in ${reviewSurface} and promote them additively without changing planner truth until a later approval step.`,
      source: "planner_findings",
    });
  }

  return { needsDecision, defer };
}

function collectStoryRegistryRefRepairs(cwd, registry) {
  const candidates = [];
  if (!registry || !Array.isArray(registry.stories)) return candidates;

  for (let storyIndex = 0; storyIndex < registry.stories.length; storyIndex++) {
    const story = registry.stories[storyIndex];
    for (const field of ["code_refs", "test_refs", "validation_refs"]) {
      const refs = Array.isArray(story[field]) ? story[field] : [];
      for (let refIndex = 0; refIndex < refs.length; refIndex++) {
        const { base, suffix } = splitRef(refs[refIndex]);
        if (!base || base.startsWith(".agent/skills/iterative-planner/")) continue;
        if (existsSync(join(cwd, base))) continue;

        const candidateBase = buildPlannerPrefixedPath(base);
        if (!candidateBase) continue;
        if (!existsSync(join(cwd, candidateBase))) continue;

        candidates.push({
          id: `story_ref_prefix:${story.id}:${field}:${refIndex}`,
          bucket: "auto_fix",
          kind: "story_registry_ref_prefix",
          title: `Repair planner-local story ref for ${story.id}`,
          detail: `${field} entry '${refs[refIndex]}' points to a missing repo-local path, but the shipped planner path exists.`,
          source: "story_registry",
          file: STORY_REGISTRY_PATH,
          story_id: story.id,
          story_index: storyIndex,
          field,
          ref_index: refIndex,
          from: refs[refIndex],
          to: `${candidateBase}${suffix}`,
          fix_type: "story_registry_ref_prefix",
        });
      }
    }
  }

  return candidates;
}

function collectStoryRegistryIssues(result, suppressedWarnings = new Set()) {
  const needsDecision = [];
  const parsed = result?.parsed;

  if (!parsed) {
    needsDecision.push({
      id: "story_registry_check_unavailable",
      bucket: "needs_decision",
      kind: "upstream_check_unavailable",
      title: "story_registry.mjs check did not return parseable JSON",
      detail: "The compact hygiene scan could not parse story_registry.mjs output; inspect the registry manually.",
      source: "story_registry",
    });
    return needsDecision;
  }

  for (const error of parsed.errors || []) {
    needsDecision.push({
      id: `story_registry_error:${slugify(error)}`,
      bucket: "needs_decision",
      kind: "story_registry_error",
      title: "Story registry error",
      detail: String(error),
      source: "story_registry",
    });
  }

  for (const warning of parsed.warnings || []) {
    const warningText = String(warning);
    if (suppressedWarnings.has(storyRegistryWarningKey(warningText))) continue;
    needsDecision.push({
      id: `story_registry_warning:${slugify(warningText)}`,
      bucket: "needs_decision",
      kind: "story_registry_warning",
      title: "Story registry warning",
      detail: warningText,
      source: "story_registry",
    });
  }

  return needsDecision;
}

function collectInvariantIssues(result) {
  const needsDecision = [];
  const parsed = result?.parsed;

  if (!parsed) {
    needsDecision.push({
      id: "invariants_unavailable",
      bucket: "needs_decision",
      kind: "upstream_check_unavailable",
      title: "rule_engine check-invariants did not return parseable JSON",
      detail: "The compact hygiene scan could not parse invariant output; inspect the upstream rule engine manually.",
      source: "rule_engine",
    });
    return needsDecision;
  }

  if (normalizeVerificationStatus(parsed.status, "gate").kind === "fail" && Number(parsed.count) > 0) {
    needsDecision.push({
      id: "invariant_failures_present",
      bucket: "needs_decision",
      kind: "invariant_violation",
      title: "Invariant failures are present",
      detail: `${parsed.count} invariant violation(s) require manual repair before the repo can be treated as semantically clean.`,
      source: "rule_engine",
    });
  }

  return needsDecision;
}

function collectReportStatusDrift(cwd) {
  const summaryPath = join(cwd, REVIEW_SUMMARY_PATH);
  const queuePath = join(cwd, REMEDIATION_QUEUE_PATH);
  if (!existsSync(summaryPath) || !existsSync(queuePath)) return [];

  const queue = parseRemediationQueue(safeRead(queuePath) || "");
  const summary = parseReviewSummary(safeRead(summaryPath) || "");
  const candidates = [];

  for (const entry of queue.entries) {
    const mapped = summary.byId.get(entry.id);
    if (!mapped) continue;
    if (mapped.status === entry.status) continue;

    candidates.push({
      id: `report_status_drift:${entry.id}`,
      bucket: "auto_fix",
      kind: "report_status_drift",
      title: `Sync remediation status for ${entry.id}`,
      detail: `remediation_queue.md marks ${entry.id} as ${entry.status}, but full_review_summary.md maps it to ${mapped.status}.`,
      source: "report_reconciliation",
      file: REMEDIATION_QUEUE_PATH,
      entry_id: entry.id,
      line_index: entry.lineIndex,
      from: entry.status,
      to: mapped.status,
      fix_type: "report_status_drift",
    });
  }

  return candidates;
}

function uniqueById(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    output.push(item);
  }
  return output;
}

export function scanPlannerHygiene({ cwd = process.cwd() } = {}) {
  const plannerFindings = runJsonScript("planner_findings.mjs", ["--json"], cwd);
  const storyRegistryCheck = runJsonScript("story_registry.mjs", ["check", "--json"], cwd);
  const invariantCheck = runJsonScript("rule_engine.mjs", ["check-invariants", "--json"], cwd);

  const storyRegistry = safeReadJson(join(cwd, STORY_REGISTRY_PATH));
  const refRepairs = collectStoryRegistryRefRepairs(cwd, storyRegistry);
  const reportDriftRepairs = collectReportStatusDrift(cwd);
  const autoFix = uniqueById([...reportDriftRepairs, ...refRepairs]);

  const suppressedStoryWarnings = new Set(
    refRepairs.map((item) =>
      storyRegistryWarningKey(`${item.story_id}: ${storyRegistryFieldLabel(item.field)} '${item.from}' — file not found`)
    )
  );
  const plannerFindingItems = collectPlannerFindingsItems(plannerFindings);
  const storyRegistryIssues = collectStoryRegistryIssues(storyRegistryCheck, suppressedStoryWarnings);
  const invariantIssues = collectInvariantIssues(invariantCheck);

  const needsDecision = uniqueById([
    ...plannerFindingItems.needsDecision,
    ...storyRegistryIssues,
    ...invariantIssues,
  ]);
  const defer = uniqueById(plannerFindingItems.defer);
  const postureRoute = computeRecommendedPath({
    workflow: plannerFindings.parsed?.workflow || null,
    classification: {
      flow_mode: plannerFindings.parsed?.flow_mode || null,
      strictness_mode: plannerFindings.parsed?.strictness_mode || null,
      signals: {
        planned_file_count: Array.isArray(plannerFindings.parsed?.related_stories)
          ? plannerFindings.parsed.related_stories.length
          : 0,
      },
    },
    semanticBlocks: plannerFindings.parsed?.semantic_blocks || [],
    repairableVariances: plannerFindings.parsed?.repairable_variances || [],
    semanticSubstrate: plannerFindings.parsed?.semantic_substrate || null,
    symmetryHunts: plannerFindings.parsed?.symmetry_hunts || [],
    hygieneSummary: {
      auto_fix_count: autoFix.length,
    },
  });
  const antiRitual = plannerFindings.parsed?.anti_ritual || resolveAntiRitualAssessment({
    classification: {
      flow_mode: plannerFindings.parsed?.flow_mode || null,
      recovery: plannerFindings.parsed?.recommended_recovery || null,
      workflow: { recommended: plannerFindings.parsed?.workflow || null },
      strictness_mode: plannerFindings.parsed?.strictness_mode || null,
    },
    recovery: plannerFindings.parsed?.recommended_recovery || null,
    workflow: plannerFindings.parsed?.workflow || null,
    recommendedPath: postureRoute.recommended_path,
    authorityProfile: plannerFindings.parsed?.authority_profile || null,
    phaseContract: plannerFindings.parsed?.phase_contract || null,
    semanticBlocks: plannerFindings.parsed?.semantic_blocks || [],
    repairableVariances: plannerFindings.parsed?.repairable_variances || [],
    semanticSubstrate: plannerFindings.parsed?.semantic_substrate || null,
    validation: {
      validation_bundle: plannerFindings.parsed?.validation_bundle || null,
      proof_posture: plannerFindings.parsed?.proof_posture || null,
    },
    activePlan: plannerFindings.parsed?.active_plan || null,
    activePlanPoisoned: plannerFindings.parsed?.active_plan?.poisoned === true,
    canonicalization: plannerFindings.parsed?.canonicalization_summary || null,
  });
  const recommendedPath = (
    antiRitual.recommended_action === "downgrade_to_lightweight" ||
    antiRitual.recommended_action === "recover_then_lightweight"
  ) ? "continue" : postureRoute.recommended_path;
  const recommendedPathReason = (
    antiRitual.recommended_action === "downgrade_to_lightweight" ||
    antiRitual.recommended_action === "recover_then_lightweight"
  ) ? `Anti-ritual contract: ${antiRitual.detail}` : postureRoute.reason;

  return {
    generated_at: new Date().toISOString(),
    cwd,
    audit_posture: postureRoute.audit_posture,
    recommended_path: recommendedPath,
    recommended_path_reason: recommendedPathReason,
    anti_ritual: antiRitual,
    knowledge_trust_summary: plannerFindings.parsed?.knowledge_trust_summary || null,
    knowledge_match_summary: plannerFindings.parsed?.knowledge_match_summary || null,
    draft_promotion_contract: plannerFindings.parsed?.draft_promotion_contract || null,
    summary: {
      auto_fix_count: autoFix.length,
      needs_decision_count: needsDecision.length,
      defer_count: defer.length,
      total_count: autoFix.length + needsDecision.length + defer.length,
    },
    auto_fix: autoFix,
    needs_decision: needsDecision,
    defer,
    commands: {
      scan: "node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs scan --compact",
      scan_json: "node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs scan --json",
      fix_safe: "node .agent/skills/iterative-planner/scripts/planner_hygiene.mjs fix-safe --write",
    },
    upstream: {
      planner_findings: {
        ok: plannerFindings.ok,
        status: plannerFindings.status,
        parsed: plannerFindings.parsed,
      },
      story_registry_check: {
        ok: storyRegistryCheck.ok,
        status: storyRegistryCheck.status,
        parsed: storyRegistryCheck.parsed,
      },
      invariant_check: {
        ok: invariantCheck.ok,
        status: invariantCheck.status,
        parsed: invariantCheck.parsed,
      },
    },
  };
}

export function applySafePlannerHygiene({ cwd = process.cwd(), write = false } = {}) {
  const scan = scanPlannerHygiene({ cwd });
  const pendingRepairs = scan.auto_fix.filter((item) => item.fix_type);
  const applied = [];
  const changedFiles = new Set();

  if (!write) {
    return {
      generated_at: new Date().toISOString(),
      cwd,
      mode: "dry_run",
      pending_count: pendingRepairs.length,
      applied_count: 0,
      changed_files: [],
      pending_repairs: pendingRepairs,
      scan_summary: scan.summary,
    };
  }

  const queueRepairs = pendingRepairs.filter((item) => item.fix_type === "report_status_drift");
  if (queueRepairs.length > 0) {
    const queuePath = join(cwd, REMEDIATION_QUEUE_PATH);
    const queue = parseRemediationQueue(safeRead(queuePath) || "");
    const byLineIndex = new Map(queue.entries.map((entry) => [entry.lineIndex, entry]));
    for (const repair of queueRepairs) {
      const entry = byLineIndex.get(repair.line_index);
      if (!entry) continue;
      entry.cells[7] = repair.to;
      queue.lines[repair.line_index] = renderMarkdownTableRow(entry.cells);
      applied.push(repair);
      changedFiles.add(REMEDIATION_QUEUE_PATH);
    }
    writeFileSync(queuePath, `${queue.lines.join("\n").replace(/\s+$/, "")}\n`);
  }

  const refRepairs = pendingRepairs.filter((item) => item.fix_type === "story_registry_ref_prefix");
  if (refRepairs.length > 0) {
    const registryPath = join(cwd, STORY_REGISTRY_PATH);
    const registry = safeReadJson(registryPath);
    if (registry && Array.isArray(registry.stories)) {
      for (const repair of refRepairs) {
        const story = registry.stories[repair.story_index];
        if (!story || !Array.isArray(story[repair.field])) continue;
        story[repair.field][repair.ref_index] = repair.to;
        applied.push(repair);
        changedFiles.add(STORY_REGISTRY_PATH);
      }
      writeJson(registryPath, registry);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    cwd,
    mode: "write",
    pending_count: pendingRepairs.length,
    applied_count: applied.length,
    changed_files: [...changedFiles],
    applied,
  };
}

function printItems(title, items) {
  console.log(`\n${title}`);
  if (!items.length) {
    console.log("- none");
    return;
  }
  for (const item of items) {
    console.log(`- ${item.title}: ${item.detail}`);
  }
}

function printScanHuman(result) {
  console.log("Planner Hygiene");
  console.log(`Audit posture / path: ${result.audit_posture} / ${result.recommended_path}`);
  if (result.knowledge_trust_summary) {
    console.log(
      `Knowledge trust: trusted=${result.knowledge_trust_summary.trusted_count} derived=${result.knowledge_trust_summary.derived_count} draft=${result.knowledge_trust_summary.draft_count}`
    );
  }
  if (result.anti_ritual?.status && result.anti_ritual.status !== "clean") {
    console.log(`Anti-ritual: ${result.anti_ritual.status} (${result.anti_ritual.recommended_action})`);
    console.log(`Detail: ${result.anti_ritual.detail}`);
  }
  console.log(`Summary: ${result.summary.auto_fix_count} auto-fix, ${result.summary.needs_decision_count} needs-decision, ${result.summary.defer_count} defer`);
  printItems("Auto Fix", result.auto_fix);
  printItems("Needs Decision", result.needs_decision);
  printItems("Defer", result.defer);
  if (result.summary.auto_fix_count > 0) {
    console.log(`\nApply safe repairs: ${result.commands.fix_safe}`);
  }
}

function printFixHuman(result) {
  if (result.mode === "dry_run") {
    console.log("Planner Hygiene Safe Fix (dry run)");
    console.log(`Pending repairs: ${result.pending_count}`);
    for (const repair of result.pending_repairs || []) {
      console.log(`- ${repair.title}: ${repair.detail}`);
    }
    if (result.pending_count > 0) {
      console.log("\nRe-run with --write to apply these deterministic repairs.");
    }
    return;
  }

  console.log("Planner Hygiene Safe Fix");
  console.log(`Applied repairs: ${result.applied_count}`);
  if (result.changed_files.length > 0) {
    console.log(`Changed files: ${result.changed_files.join(", ")}`);
  }
  for (const repair of result.applied || []) {
    console.log(`- ${repair.title}: ${repair.from} -> ${repair.to}`);
  }
}

function printUsage() {
  console.log(`Usage: node planner_hygiene.mjs <command> [options]

Commands:
  scan         Aggregate compact planner hygiene findings
  fix-safe     Preview or apply deterministic bookkeeping repairs

Options:
  --json       Emit machine-readable JSON
  --compact    Human-readable compact scan output (default for scan)
  --write      Apply safe fixes when used with fix-safe
`);
}

function isMain() {
  return process.argv[1] && canonicalPath(fileURLToPath(import.meta.url)) === canonicalPath(process.argv[1]);
}

function main() {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("-")) || "scan";
  const jsonMode = args.includes("--json");
  const write = args.includes("--write");

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return 0;
  }

  if (command === "scan") {
    const result = scanPlannerHygiene();
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printScanHuman(result);
    }
    return 0;
  }

  if (command === "fix-safe") {
    const result = applySafePlannerHygiene({ write });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printFixHuman(result);
    }
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  return 1;
}

if (isMain()) {
  process.exitCode = main();
}
