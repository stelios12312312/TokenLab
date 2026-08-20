#!/usr/bin/env node
// intent_contract_bootstrap.mjs — Draft or refresh intent_contract.json from active-plan context.
//
// Purpose:
//   Help /advisor and operators consolidate messy user intent into a structured
//   draft contract the gates can later enforce.
//
// Behavior:
//   - Reads the active plan goal plus findings truth (ledger-first, markdown fallback)
//   - Conservatively infers likely deliverables, anti-goals, and draft outcomes
//   - Preserves stronger manual fields already present in intent_contract.json
//
// Usage:
//   node intent_contract_bootstrap.mjs
//   node intent_contract_bootstrap.mjs --dry-run
//   node intent_contract_bootstrap.mjs --json
//   node intent_contract_bootstrap.mjs --dir <path>
//   node intent_contract_bootstrap.mjs --plan <plan_dir_name>

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import {
  getWorkOrderSuccessCriteria,
  getWorkOrderVerificationRows,
  loadPlanWorkOrder,
  writePlanWorkOrderProjection,
} from "./lib/work_order_contract.mjs";
import {
  analyzeIntentContract,
  getPaths,
  goalNeedsIntentContract,
  loadIntentContract,
  readFile,
  resolveFindingsTruth,
  resolvePlanTarget,
} from "./lib/plan_utils.mjs";
import { emitJson } from "./lib/emit_json.mjs";

const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes("--dry-run"),
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
};

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

const cwd = readFlagValue("--dir") ? resolve(readFlagValue("--dir")) : process.cwd();
const explicitPlan = readFlagValue("--plan");

if (flags.help) {
  console.log(`intent_contract_bootstrap.mjs — Draft or refresh intent_contract.json from active-plan context

Usage:
  node intent_contract_bootstrap.mjs
  node intent_contract_bootstrap.mjs --dry-run
  node intent_contract_bootstrap.mjs --json
  node intent_contract_bootstrap.mjs --dir <path>
  node intent_contract_bootstrap.mjs --plan <plan_dir_name>

Behavior:
  - Uses the active plan by default
  - Drafts missing intent fields from goal + findings context
  - Preserves stronger manual fields already present in intent_contract.json
  - Does not invent certainty: if actor or JTBD are not explicit enough, fields stay null and are reported as missing
`);
  process.exit(0);
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))];
}

function normalizeId(text, fallback, index = 0) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized && !/^\d/.test(normalized)) return normalized;
  return `${fallback}_${index + 1}`;
}

function extractGoalText(planDir) {
  try {
    const stateJson = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
    if (typeof stateJson?.goal === "string" && stateJson.goal.trim()) return stateJson.goal.trim();
  } catch { /* fallback */ }

  const planContent = readFile(join(planDir, "plan.md")) || "";
  const goalMatch = planContent.match(/^## Goal\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  return goalMatch ? goalMatch[1].trim().split("\n")[0].trim() : "";
}

function extractStoryCandidates(planDir) {
  const findingsTruth = resolveFindingsTruth(planDir);
  const ledgerCandidates = findingsTruth?.ledgerInfo?.parsed?.story_candidates || findingsTruth?.ledgerInfo?.parsed?.storyCandidates;
  const fromLedger = Array.isArray(ledgerCandidates)
    ? ledgerCandidates.map((entry) => {
      if (typeof entry === "string") return entry.trim();
      return firstNonEmptyString(entry?.title, entry?.summary, entry?.name, entry?.label);
    }).filter(Boolean)
    : [];

  const markdown = readFile(join(planDir, "findings.md")) || "";
  const sectionMatch = markdown.match(/## Story Candidates\s*\n([\s\S]*?)(?=\n## |\n# |$)/m);
  const fromMarkdown = sectionMatch
    ? sectionMatch[1]
      .split("\n")
      .map((line) => line.match(/^\s*[-*]\s+(.+?)(?:\s*\(priority:.*\))?\s*$/i)?.[1]?.trim() || null)
      .filter(Boolean)
    : [];

  return uniqueList([...fromLedger, ...fromMarkdown]);
}

function pickPrimaryUser(text) {
  const candidates = [
    { regex: /\bportfolio analyst\b|\banalyst\b/, value: "Portfolio analyst" },
    { regex: /\btrader\b/, value: "Trader" },
    { regex: /\breviewer\b/, value: "Reviewer" },
    { regex: /\boperator\b/, value: "Operator" },
    { regex: /\badministrator\b|\badmin\b/, value: "Administrator" },
    { regex: /\bcustomer\b|\bclient\b/, value: "Customer" },
    { regex: /\bdeveloper\b|\bengineer\b/, value: "Developer" },
    { regex: /\bstakeholder\b/, value: "Stakeholder" },
    { regex: /\bteam\b/, value: "Internal team" },
    { regex: /\buser\b|\busers\b/, value: "End user" },
  ];

  const lower = String(text || "").toLowerCase();
  return candidates.find((candidate) => candidate.regex.test(lower))?.value || null;
}

function inferDeliverables(goalText, sourceText, { required = goalNeedsIntentContract(goalText) } = {}) {
  if (!required) return [];
  const haystack = `${goalText}\n${sourceText}`.toLowerCase();
  const deliverables = [];

  const pushDeliverable = (deliverable) => {
    if (!deliverable?.id) return;
    if (deliverables.some((entry) => entry.id === deliverable.id)) return;
    deliverables.push(deliverable);
  };

  if (/\bbacktest|backtesting|strategy\b/.test(haystack) && /\breport|analysis|results?\b/.test(haystack)) {
    pushDeliverable({
      id: "backtest_report",
      name: "Backtesting report",
      kind: "report",
      purpose: "Help the user decide whether the strategy deserves deeper investigation",
      quality_bars: ["Contains substantive metrics and interpretation"],
      required_sections: ["Backtest window", "Baseline comparison", "Methodology"],
      required_signals: ["sample count", "trade count", "key performance metrics"],
      anti_goals: ["Empty report", "Metric-free PASS", "Silent failure presented as success"],
      evidence_mode: "artifact_review",
    });
  }

  const genericPatterns = [
    {
      regex: /\bdashboard\b/,
      id: "dashboard",
      name: "Dashboard",
      kind: "dashboard",
      purpose: "Make the key metrics and state visible in one place",
      quality_bars: ["Shows decision-relevant metrics instead of placeholders"],
      required_sections: ["Key metrics", "Status or timestamp"],
      required_signals: ["non-empty metrics"],
      anti_goals: ["Blank dashboard", "Zeros without explanation"],
    },
    {
      regex: /\bworkflow\b|\bflow\b|\bjourney\b|\bexperience\b/,
      id: "workflow",
      name: "User workflow",
      kind: "workflow",
      purpose: "Let the user complete the intended flow without hidden failure states",
      quality_bars: ["Completes end to end with explicit success or failure states"],
      required_sections: ["Entry point", "Completion outcome"],
      required_signals: ["explicit success state", "explicit failure state"],
      anti_goals: ["Silent failure", "Dead-end success state"],
    },
    {
      regex: /\breport\b|\bsummary\b|\banalysis\b|\bresults?\b|\bexport\b/,
      id: "report",
      name: "User-facing report",
      kind: "report",
      purpose: "Communicate the result in a form the user can act on",
      quality_bars: ["Contains substantive conclusions rather than placeholders"],
      required_sections: ["Summary", "Key findings"],
      required_signals: [],
      anti_goals: ["Empty report", "PASS without supporting detail"],
    },
    {
      regex: /\bui\b|\bscreen\b|\bpage\b|\bview\b/,
      id: "ui_surface",
      name: "UI surface",
      kind: "ui",
      purpose: "Let the user understand state and next actions without guessing",
      quality_bars: ["Makes success, empty, and error states explicit"],
      required_sections: ["Primary action", "State feedback"],
      required_signals: ["empty-state guidance"],
      anti_goals: ["Blank success state", "Missing error feedback"],
      evidence_mode: "manual_observation",
    },
  ];

  for (const pattern of genericPatterns) {
    if (!pattern.regex.test(haystack)) continue;
    pushDeliverable({
      id: pattern.id,
      name: pattern.name,
      kind: pattern.kind,
      purpose: pattern.purpose,
      quality_bars: pattern.quality_bars,
      required_sections: pattern.required_sections,
      required_signals: pattern.required_signals,
      anti_goals: pattern.anti_goals,
      evidence_mode: pattern.evidence_mode || "artifact_review",
    });
  }

  if (deliverables.length === 0 && required) {
    const inferredName = firstNonEmptyString(goalText.split(".")[0]) || "User-facing deliverable";
    pushDeliverable({
      id: normalizeId(inferredName, "deliverable"),
      name: inferredName,
      kind: "artifact",
      purpose: "Support the user-facing outcome described in the goal",
      quality_bars: ["Must be substantive enough to support the user goal"],
      required_sections: [],
      required_signals: [],
      anti_goals: ["Artifact exists but is unusable", "Silent failure presented as success"],
      evidence_mode: "artifact_review",
    });
  }

  return deliverables.map((deliverable, index) => ({
    required: true,
    ...deliverable,
    id: normalizeId(deliverable.id || deliverable.name, "deliverable", index),
  }));
}

function inferDesiredOutcomes(primaryUser, goalText, deliverables, storyCandidates) {
  const actor = primaryUser || "the user";
  const outcomes = [];
  for (const deliverable of deliverables) {
    if (deliverable.kind === "report") {
      outcomes.push(`${actor} can use the report to make a decision without guessing what is missing`);
    } else if (deliverable.kind === "dashboard") {
      outcomes.push(`${actor} can see the key state and metrics in one place`);
    } else if (deliverable.kind === "workflow") {
      outcomes.push(`${actor} can complete the workflow with explicit success or failure feedback`);
    } else if (deliverable.kind === "ui") {
      outcomes.push(`${actor} can understand the state of the interface and what to do next`);
    } else {
      outcomes.push(`${actor} can act on the deliverable without hidden ambiguity`);
    }
  }
  if (outcomes.length === 0 && goalText) {
    outcomes.push(`The goal is completed in a way ${actor} can actually use`);
  }
  if (storyCandidates.length > 0) {
    outcomes.push(`The draft intent stays aligned with story candidates such as: ${storyCandidates[0]}`);
  }
  return uniqueList(outcomes);
}

function inferAntiGoals(sourceText, deliverables) {
  const antiGoals = [];
  const lower = String(sourceText || "").toLowerCase();
  const candidates = [
    { regex: /\bfalse[- ]?green\b/, value: "False-green success state" },
    { regex: /\bempty\b/, value: "Empty deliverable treated as success" },
    { regex: /\bhollow\b/, value: "Hollow output treated as complete" },
    { regex: /\bblank\b/, value: "Blank output presented as success" },
    { regex: /\bsilent failure\b/, value: "Silent failure presented as success" },
    { regex: /\bmissing\b/, value: "Missing critical content without explanation" },
    { regex: /\bregression\b/, value: "Regression that violates the user's story" },
  ];
  for (const candidate of candidates) {
    if (candidate.regex.test(lower)) antiGoals.push(candidate.value);
  }
  for (const deliverable of deliverables) {
    antiGoals.push(...asStringList(deliverable.anti_goals || deliverable.antiGoals));
  }
  return uniqueList(antiGoals);
}

function inferConstraints(sourceText, deliverables) {
  const constraints = [];
  const lower = String(sourceText || "").toLowerCase();
  if (/\bbaseline\b/.test(lower)) constraints.push("Baseline comparison must be explicit");
  if (/\bsplit\b/.test(lower)) constraints.push("Split method must be stated explicitly");
  if (/\bdeterministic\b/.test(lower)) constraints.push("The output must be reproducible enough to verify");
  if (deliverables.some((deliverable) => deliverable.kind === "workflow")) {
    constraints.push("Workflow states must make failures visible instead of silently succeeding");
  }
  return uniqueList(constraints);
}

function buildDraftContract({ goalText, sourceText, storyCandidates }) {
  const required = goalNeedsIntentContract(goalText);
  const primaryUser = required
    ? pickPrimaryUser(`${goalText}\n${sourceText}\n${storyCandidates.join("\n")}`)
    : null;
  const deliverables = inferDeliverables(goalText, `${sourceText}\n${storyCandidates.join("\n")}`, { required });
  const desiredOutcomes = required
    ? inferDesiredOutcomes(primaryUser, goalText, deliverables, storyCandidates)
    : [];
  const antiGoals = required ? inferAntiGoals(sourceText, deliverables) : [];
  const constraints = required ? inferConstraints(sourceText, deliverables) : [];

  return {
    version: 1,
    primary_user: primaryUser,
    job_to_be_done: required ? goalText || null : null,
    desired_outcomes: desiredOutcomes,
    anti_goals: antiGoals,
    constraints,
    deliverables: deliverables.map((deliverable) => ({
      id: deliverable.id,
      name: deliverable.name,
      kind: deliverable.kind,
      required: true,
      purpose: deliverable.purpose,
      quality_bars: uniqueList(deliverable.quality_bars || deliverable.qualityBars),
      required_sections: uniqueList(deliverable.required_sections || deliverable.requiredSections),
      required_signals: uniqueList(deliverable.required_signals || deliverable.requiredSignals),
      anti_goals: uniqueList(deliverable.anti_goals || deliverable.antiGoals),
      evidence_mode: deliverable.evidence_mode || deliverable.evidenceMode || "artifact_review",
    })),
  };
}

function mergeStringLists(existing, inferred) {
  return uniqueList([...asStringList(existing), ...asStringList(inferred)]);
}

function mergeDeliverables(existingDeliverables, draftDeliverables) {
  const result = [];
  const byId = new Map();
  for (const deliverable of Array.isArray(existingDeliverables) ? existingDeliverables : []) {
    if (!deliverable || typeof deliverable !== "object") continue;
    const id = normalizeId(firstNonEmptyString(deliverable.id, deliverable.name), "deliverable", result.length);
    const copy = { ...deliverable, id };
    result.push(copy);
    byId.set(id, copy);
  }

  for (const draft of Array.isArray(draftDeliverables) ? draftDeliverables : []) {
    if (!draft || typeof draft !== "object") continue;
    const id = normalizeId(firstNonEmptyString(draft.id, draft.name), "deliverable", result.length);
    const existing = byId.get(id);
    if (!existing) {
      const copy = { ...draft, id };
      result.push(copy);
      byId.set(id, copy);
      continue;
    }

    existing.name = firstNonEmptyString(existing.name, draft.name);
    existing.kind = firstNonEmptyString(existing.kind, draft.kind, "artifact");
    existing.required = existing.required !== false;
    existing.purpose = firstNonEmptyString(existing.purpose, draft.purpose);
    existing.quality_bars = mergeStringLists(existing.quality_bars || existing.qualityBars, draft.quality_bars || draft.qualityBars);
    existing.required_sections = mergeStringLists(existing.required_sections || existing.requiredSections, draft.required_sections || draft.requiredSections);
    existing.required_signals = mergeStringLists(existing.required_signals || existing.requiredSignals, draft.required_signals || draft.requiredSignals);
    existing.anti_goals = mergeStringLists(existing.anti_goals || existing.antiGoals, draft.anti_goals || draft.antiGoals);
    existing.evidence_mode = firstNonEmptyString(existing.evidence_mode, existing.evidenceMode, draft.evidence_mode, draft.evidenceMode, "artifact_review");
  }

  return result.map((deliverable) => ({
    ...deliverable,
    quality_bars: uniqueList(deliverable.quality_bars || deliverable.qualityBars),
    required_sections: uniqueList(deliverable.required_sections || deliverable.requiredSections),
    required_signals: uniqueList(deliverable.required_signals || deliverable.requiredSignals),
    anti_goals: uniqueList(deliverable.anti_goals || deliverable.antiGoals),
    evidence_mode: firstNonEmptyString(deliverable.evidence_mode, deliverable.evidenceMode, "artifact_review"),
  }));
}

function mergeContract(existing, draft) {
  const base = existing && typeof existing === "object" ? existing : {};
  return {
    ...base,
    version: 1,
    primary_user: firstNonEmptyString(base.primary_user, base.user, draft.primary_user),
    job_to_be_done: firstNonEmptyString(base.job_to_be_done, base.job, draft.job_to_be_done),
    desired_outcomes: mergeStringLists(base.desired_outcomes || base.outcomes, draft.desired_outcomes),
    anti_goals: mergeStringLists(base.anti_goals || base.false_green_patterns, draft.anti_goals),
    constraints: mergeStringLists(base.constraints || base.guardrails, draft.constraints),
    deliverables: mergeDeliverables(base.deliverables, draft.deliverables),
  };
}

function main() {
  const { plansDir } = getPaths(cwd);
  const target = resolvePlanTarget(plansDir, {
    plan: explicitPlan,
    exitOnMissing: false,
  });

  if (!target?.planDir) {
    const result = {
      status: "NO_ACTIVE_PLAN",
      message: "No active plan. Create or resume a plan before bootstrapping an intent contract.",
    };
    if (flags.json) {
      emitJson(result, { exitCode: 0 });
      return;
    }
    console.error(result.message);
    process.exit(1);
  }

  const goalText = extractGoalText(target.planDir);
  const findingsTruth = resolveFindingsTruth(target.planDir);
  const sourceText = [
    goalText,
    findingsTruth?.effective?.searchText || "",
    ...extractStoryCandidates(target.planDir),
  ].filter(Boolean).join("\n");
  const required = goalNeedsIntentContract(goalText);
  const existingInfo = loadIntentContract(target.planDir);
  const draft = buildDraftContract({
    goalText,
    sourceText,
    storyCandidates: extractStoryCandidates(target.planDir),
  });
  const merged = mergeContract(existingInfo.parsed, draft);
  const analysis = analyzeIntentContract(merged, { goalText });
  const outputPath = join(target.planDir, "intent_contract.json");

  if (!flags.dryRun) {
    writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`);
    const workOrderInfo = loadPlanWorkOrder(target.planDir);
    writePlanWorkOrderProjection(target.planDir, {
      goal: goalText,
      planDirName: target.planDirName,
      intentContract: merged,
      successCriteria: getWorkOrderSuccessCriteria(workOrderInfo.parsed),
      verificationRows: getWorkOrderVerificationRows(workOrderInfo.parsed),
    });
  }

  const result = {
    status: required
      ? analysis.meaningful
        ? "DRAFT_READY"
        : "REVIEW_NEEDED"
      : "NOT_REQUIRED",
    required,
    wrote: !flags.dryRun,
    plan_dir: target.planDirName,
    goal: goalText,
    findings_source: findingsTruth?.source || "none",
    inferred_primary_user: draft.primary_user,
    inferred_deliverables: draft.deliverables.map((deliverable) => ({
      id: deliverable.id,
      kind: deliverable.kind,
      name: deliverable.name,
    })),
    missing_fields: analysis.missingCoreFields,
    missing_deliverable_contracts: analysis.missingDeliverableContracts.map((deliverable) => deliverable.id),
    output_path: outputPath,
    contract: merged,
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Plan: ${target.planDirName}`);
  console.log(`Goal: ${goalText || "(missing goal)"}`);
  console.log(`Required: ${required ? "yes" : "no"}`);
  console.log(`Result: ${result.status}`);
  console.log(`${flags.dryRun ? "Preview" : "Wrote"}: ${outputPath}`);
  if (analysis.missingCoreFields.length > 0) {
    console.log(`Missing fields: ${analysis.missingCoreFields.join(", ")}`);
  }
  if (analysis.missingDeliverableContracts.length > 0) {
    console.log(`Incomplete deliverables: ${analysis.missingDeliverableContracts.map((deliverable) => deliverable.id).join(", ")}`);
  }
}

main();
