// triage.mjs — v7.4.4: pre-bootstrap goal classification.
//
// The Tesseract pattern surfaces repeatedly: agents open the iterative
// planner for goals that aren't engineering work — questions, lookups,
// analysis tasks, ad-budget tweaks, schedule changes — and burn agent time
// satisfying gates that don't apply.
//
// v7.4.3 introduced the chore shape (verb+noun keyword detection). v7.4.4
// generalises that into a complexity score with a triage recommendation
// covering more cases:
//   - questions ("What does X do?") → skip the planner, just answer
//   - analysis tasks ("Review the retro") → skip or lightweight
//   - chores (covered) → skip or minimal-gate plan
//   - lightweight engineering → lightweight flow (task.md + walkthrough.md)
//   - standard / heavy engineering → full planner
//
// `computeTriage()` returns a recommendation that bootstrap surfaces before
// opening a plan, and that the new `bootstrap.mjs triage` command exposes
// for read-only preview.

import {
  detectPlanShape,
  hasPositiveEngineeringIntent,
  looksLikeAnalysisGoal,
} from "./plan_shape.mjs";
import { detectIrreversibleActionIntent } from "./irreversible_action_contract.mjs";

const QUESTION_LEADS = [
  /^\s*(what|why|how|when|where|who|which|whose|whom)\b/i,
  /^\s*(can|could|should|would|will|do|does|did|is|are|was|were|has|have)\b.{0,80}\?\s*$/i,
];

const PLANNER_CORE_PATTERNS = [
  /\.agent\/skills\/iterative-planner\//,
  /\.agent\/workflows\//,
  /verify_gate|transition\.mjs|bootstrap\.mjs|migrate\.mjs|rule_engine\.mjs/,
];

// Behavioral core: files whose CHANGE alters shared gate/transition/program
// logic and therefore affects every plan. A change touching these earns full
// rigor regardless of size.
const BEHAVIORAL_CORE_PATTERNS = [
  /verify_gate|transition\.mjs|bootstrap\.mjs|migrate\.mjs|rule_engine\.mjs/,
  /scripts\/(transition|verify_gate|bootstrap|migrate|rule_engine|program_manager)\b/,
  /scripts\/lib\/(program_packet|gate_registry|measured_gate|determinism|fact_loader)\b/,
  /config\/gates\.json$/,
  /prolog\/.*\.pl$/,
  /\.agent\/workflows\//,
];

// Additive content: pack data, fixtures, tests, profiles, knowledge docs. These
// live under the engine tree but ADD content rather than change shared logic, so
// they must not be force-routed to max ceremony just for their location. This is
// what stops the "150-line calibration pack → 3,557-line plan dir" trap.
const ADDITIVE_CONTENT_PATTERNS = [
  /(^|\/)packs\//,
  /calibration[^/]*\.json$/,
  /(^|\/)tests?\//,
  /(^|\/)fixtures?\//,
  /\.profile\.(json|ya?ml)$/,
  /(^|\/)knowledge\//,
  /\.md$/,
];

const RISK_KEYWORDS = [
  "regression", "incident", "outage", "production", "breaking change",
  "security", "data loss", "race condition", "deadlock",
];

const SIMPLE_READ_ONLY_ACTION_VERB_PATTERN =
  /^\s*(open|opena|view|visit|load|navigate(?:\s+to)?|go\s+to|pull\s+up|bring\s+up|look\s+at)\b/i;
const SIMPLE_READ_ONLY_ACTION_TARGET_PATTERN =
  /(https?:\/\/|www\.|\b(page|webpage|url|link|site|website|browser|tab|dashboard|screen|doc|document)\b)/i;
const AMBIGUOUS_REFERENCE_PATTERN = /\b(it|that|this|them|those)\b/i;
const DESTRUCTIVE_WRITE_PATTERN =
  /\b(delete|remove|drop|wipe|reset|overwrite|force[-\s]?push|revoke|close|cancel)\b/i;
const SENSITIVE_EXTERNAL_TARGET_PATTERN =
  /\b(production|prod|live|customer|billing|payment|stripe|paypal|bank|wire|transfer|credential|secret|api[\s-]?key|password|database|db|github issue|project item)\b/i;
const MONEY_OR_LEGAL_WRITE_PATTERN =
  /\b(charge|refund|pay|transfer|wire|sign|file|submit)\b.{0,80}\b(invoice|payment|bank|tax|legal|contract|terms|customer|client)\b/i;
const TRIVIAL_TEXT_CORRECTION_PATTERN =
  /^\s*(fix|correct|repair|update|change|edit|patch)?\s*(a\s+|the\s+)?(typo|typos|spelling|misspelling|grammar|punctuation|copy\s+edit|copyedit|copy\s+typo|wording)\b/i;
const TRIVIAL_TEXT_CONTEXT_PATTERN =
  /\b(readme|doc|docs|documentation|guide|markdown|md|comment|comments|copy|text|wording|label|labels|title|heading|description)\b/i;
const NON_TRIVIAL_ENGINEERING_TEXT_PATTERN =
  /\b(api|auth|checkout|database|db|migration|schema|production|prod|security|regression|incident|outage|bug|broken|failing|failure|root[\s-]?cause|planner[\s-]?core|bootstrap\.mjs|transition\.mjs|rule_engine\.mjs|migrate\.mjs)\b/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function hasAny(text, words) {
  const t = lower(text);
  return words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(t));
}

function hasAnyPattern(text, patterns) {
  return patterns.some((p) => p.test(text || ""));
}

function looksLikeQuestion(goalText) {
  const t = String(goalText || "").trim();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  return hasAnyPattern(t, QUESTION_LEADS);
}

function countNumberedItems(goalText) {
  const matches = String(goalText || "").match(/(?:^|\s)\d+\)\s|\d+\.\s/g);
  return matches ? matches.length : 0;
}

function looksLikeProvenLocalTimeoutConfigFix(goalText) {
  const t = lower(goalText);
  if (!t) return false;
  const hasTimeoutOrConfigAction = /\b(timeout|timed out|polling|poll|delay|backoff|retry|throttle|rate limit|log|logs|logging|config|configuration)\b/i.test(t);
  const hasHealthyExternalProof =
    /\b(connection|api|auth|ssi|retrieval|diagnostic|probe|smoke|check)\b.{0,100}\b(pass|passed|healthy|alive|works|working|ok|succeeded|success)\b/i.test(t) ||
    /\b(pass|passed|healthy|alive|works|working|ok|succeeded|success)\b.{0,100}\b(connection|api|auth|ssi|retrieval|diagnostic|probe|smoke|check)\b/i.test(t);
  const hasLocalCause = /\b(hardcoded|local|in our code|our code|timeout constant|polling timeout|config|configuration|worker bottleneck|background worker)\b/i.test(t);
  return hasTimeoutOrConfigAction && hasHealthyExternalProof && hasLocalCause;
}

function looksLikeSimpleReadOnlyAction(goalText) {
  const text = String(goalText || "").trim();
  if (!text) return false;
  if (!SIMPLE_READ_ONLY_ACTION_VERB_PATTERN.test(text)) return false;
  if (!SIMPLE_READ_ONLY_ACTION_TARGET_PATTERN.test(text)) return false;
  return !hasPositiveEngineeringIntent(text);
}

function looksLikeTrivialTextCorrection(goalText) {
  const text = String(goalText || "").trim();
  if (!text) return false;
  if (!TRIVIAL_TEXT_CORRECTION_PATTERN.test(text)) return false;
  if (NON_TRIVIAL_ENGINEERING_TEXT_PATTERN.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 8 || TRIVIAL_TEXT_CONTEXT_PATTERN.test(text);
}

function userDecisionNeeded(goalText, { cwd = process.cwd() } = {}) {
  const text = String(goalText || "").trim();
  if (!text) return { needed: false, reason: null, question: null };
  let irreversibleIntent;
  try {
    irreversibleIntent = detectIrreversibleActionIntent(text, { cwd });
  } catch (error) {
    return {
      needed: true,
      reason: "irreversible-action registry is invalid, so live execution fails closed",
      question: `Repair the irreversible-action registry before any live action. ${error.message}`,
      irreversible_action: {
        action_class: null,
        execution_authorized: false,
        registry_error: error.message,
      },
    };
  }
  if (irreversibleIntent.suppressed) {
    return {
      needed: false,
      reason: null,
      question: null,
      irreversible_action: irreversibleIntent,
    };
  }
  if (DESTRUCTIVE_WRITE_PATTERN.test(text) && AMBIGUOUS_REFERENCE_PATTERN.test(text)) {
    return {
      needed: true,
      reason: "destructive action has an ambiguous target",
      question: "Which exact target should I change?",
    };
  }
  if (irreversibleIntent.matched) {
    return {
      needed: true,
      reason: `${irreversibleIntent.action_label} is an irreversible external action`,
      question: `Review the exact ${irreversibleIntent.action_class} target and payload, then type a fresh direct confirmation in your own words. It must be unambiguous, non-delegated, and bound to that unchanged action. Draft or dry-run approval is never execution authorization.`,
      irreversible_action: irreversibleIntent,
    };
  }
  if (DESTRUCTIVE_WRITE_PATTERN.test(text) && SENSITIVE_EXTERNAL_TARGET_PATTERN.test(text)) {
    return {
      needed: true,
      reason: "destructive or irreversible action touches a sensitive/live external target",
      question: "Please confirm the exact target and that this live/destructive action is intended.",
    };
  }
  if (MONEY_OR_LEGAL_WRITE_PATTERN.test(text)) {
    return {
      needed: true,
      reason: "money, customer, or legal action needs explicit confirmation",
      question: "Please confirm the exact action and target before I proceed.",
    };
  }
  return {
    needed: false,
    reason: null,
    question: null,
    irreversible_action: null,
  };
}

function normalizePlannerPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return { present: false, default_route: "auto" };
  }
  const defaultRoute = String(policy.default_route || "auto").trim().toLowerCase();
  return {
    present: true,
    default_route: ["auto", "lightweight", "full"].includes(defaultRoute) ? defaultRoute : "auto",
  };
}

function policyMayOverrideRoute({
  recommendedPath,
  decisionNeeded,
  looksQuestion,
  simpleReadOnlyAction,
  hasEngineeringVerb,
  shapePrimary,
}) {
  if (decisionNeeded || looksQuestion || simpleReadOnlyAction) return false;
  if (["lightweight", "standard_planner", "full_planner"].includes(recommendedPath)) return true;
  return recommendedPath === "skip_planner" && hasEngineeringVerb && shapePrimary !== "chore";
}

export function computeTriage({ goalText = "", plannedFiles = [], intentContract = null, plannerPolicy = null, cwd = process.cwd() } = {}) {
  const goal = String(goalText || "").trim();
  const reasons = [];
  const shape = detectPlanShape({ goalText: goal, plannedFiles, intentContract });
  const simpleReadOnlyAction = looksLikeSimpleReadOnlyAction(goal);
  const trivialTextCorrection = looksLikeTrivialTextCorrection(goal);
  const hasEngineeringVerb = hasPositiveEngineeringIntent(goal);
  const decision = userDecisionNeeded(goal, { cwd });
  const policy = normalizePlannerPolicy(plannerPolicy);

  let score = 5; // start at "standard"

  // Strong negative signals (push toward "skip the planner")
  if (looksLikeQuestion(goal)) {
    score -= 6;
    reasons.push("goal looks like a question — answer it directly, don't open a plan");
  }
  if (shape.primary === "chore") {
    score -= 5;
    reasons.push("goal is operational/admin (chore shape)");
  }
  if (looksLikeAnalysisGoal(goal)) {
    score -= 5;
    reasons.push("goal is analysis-only and contains no positive engineering intent");
  }
  if (simpleReadOnlyAction) {
    score -= 6;
    reasons.push("goal is a simple read-only open/view action — do it directly");
  }
  if (decision.needed) {
    score -= 6;
    reasons.push(`${decision.reason} — ask the user before acting`);
  }

  // Light negative signals
  const wordCount = goal.split(/\s+/).filter(Boolean).length;
  if (wordCount < 5) {
    score -= 1;
    reasons.push(`goal is very short (${wordCount} words)`);
  }
  if (asArray(plannedFiles).length === 0 && shape.primary === "unknown") {
    score -= 1;
    reasons.push("no planned files declared and shape is unknown");
  }
  if (looksLikeProvenLocalTimeoutConfigFix(goal) && !hasAny(goal, RISK_KEYWORDS)) {
    score -= 4;
    reasons.push("diagnostics already point to a local timeout/config fix with the external system healthy");
  }
  if (trivialTextCorrection && shape.primary !== "planner-core" && !hasAny(goal, RISK_KEYWORDS)) {
    score -= 4;
    reasons.push("goal looks like a trivial typo/spelling/copy correction");
  }

  // Positive signals (push toward "use the planner")
  //
  // Blast-radius awareness: "touches a file under the skill dir" is NOT the same
  // as "changes shared gate/transition logic". A change that only ADDS pack
  // content / fixtures / tests is proportional work even though it lives under
  // the engine tree. Only BEHAVIORAL core edits earn the full max-ceremony bump.
  const files = asArray(plannedFiles).map((f) => String(f || ""));
  const plannerCoreFiles = files.filter((f) => PLANNER_CORE_PATTERNS.some((p) => p.test(f)));
  const touchesBehavioralCore = files.some((f) => BEHAVIORAL_CORE_PATTERNS.some((p) => p.test(f)));
  const additiveOnly = plannerCoreFiles.length > 0
    && !touchesBehavioralCore
    && plannerCoreFiles.every((f) => ADDITIVE_CONTENT_PATTERNS.some((p) => p.test(f)));

  if (touchesBehavioralCore) {
    score += 4;
    reasons.push("planned files change planner behavioral core (gate/transition/program logic) — full rigor");
  } else if (additiveOnly) {
    score += 1;
    reasons.push("planned files are additive pack/fixture/test content under the engine tree — proportional flow, not a behavioral core change");
  } else if (plannerCoreFiles.length > 0) {
    score += 4;
    reasons.push("planned files touch planner-core (always use planner for those)");
  }
  if (shape.primary === "planner-core" && !additiveOnly) {
    score += 3;
    reasons.push("shape is planner-core");
  }
  if (shape.primary === "bug-fix" || shape.primary === "regression") {
    score += 2;
    reasons.push(`shape is ${shape.primary} (diagnosis-grade work)`);
  }
  if (shape.primary === "migration") {
    score += 2;
    reasons.push("shape is migration (cross-project ripple risk)");
  }
  if (hasAny(goal, RISK_KEYWORDS)) {
    score += 2;
    reasons.push("goal mentions risk keywords (regression / incident / production / security / ...)");
  }
  const numbered = countNumberedItems(goal);
  if (numbered >= 3) {
    score += 1;
    reasons.push(`goal has ${numbered} numbered items (multi-step work)`);
  }
  if (hasEngineeringVerb && asArray(plannedFiles).length >= 2) {
    score += 1;
    reasons.push("goal has engineering verbs and ≥2 planned files");
  }

  // Decision boundaries
  let recommended_path;
  let summary;
  if (decision.needed) {
    recommended_path = "skip_planner";
    summary = "Ask the user for the missing/risky decision before acting. The planner is not the right tool for unresolved target or permission ambiguity.";
  } else if (looksLikeQuestion(goal)) {
    recommended_path = "skip_planner_question";
    summary = "This is a question — answer the user directly. The planner state machine is for tracking work, not for answering questions.";
  } else if (simpleReadOnlyAction) {
    recommended_path = "skip_planner";
    summary = "This is a simple read-only open/view action — do it directly. The planner state machine adds friction without value here.";
  } else if (score <= 0) {
    recommended_path = "skip_planner";
    summary = "Skip the iterative planner entirely. Just do the task and commit. The state machine adds friction without value here.";
  } else if (score <= 3) {
    recommended_path = "lightweight";
    summary = "Use the lightweight flow (task.md → implementation_plan.md → walkthrough.md). Full state machine is overkill for goals at this complexity.";
  } else if (score <= 7) {
    recommended_path = "standard_planner";
    summary = "Standard iterative planner. Shape-aware gates will scale to the work.";
  } else {
    recommended_path = "full_planner";
    summary = "Full planner with safe-change-power rigor. High complexity / high-risk surface.";
  }

  let policyApplied = false;
  if (policy.default_route !== "auto" && policyMayOverrideRoute({
    recommendedPath: recommended_path,
    decisionNeeded: decision.needed,
    looksQuestion: looksLikeQuestion(goal),
    simpleReadOnlyAction,
    hasEngineeringVerb,
    shapePrimary: shape.primary,
  })) {
    policyApplied = true;
    if (policy.default_route === "lightweight") {
      recommended_path = "lightweight";
      summary = "Project planner.policy requests the lightweight route for actionable engineering work.";
      reasons.push("planner.policy default_route=lightweight applied");
    } else if (policy.default_route === "full") {
      recommended_path = "full_planner";
      summary = "Project planner.policy requests the full planner route for actionable engineering work.";
      reasons.push("planner.policy default_route=full applied");
    }
  }

  const operatorAction = decision.needed
    ? "ask_user"
    : (recommended_path === "skip_planner_question"
      ? "direct_answer"
      : (recommended_path === "skip_planner"
        ? "direct_action"
        : (recommended_path === "lightweight" ? "lightweight_plan" : "planner")));

  return {
    complexity_score: score,
    recommended_path,
    operator_action: operatorAction,
    operator_question: decision.needed ? decision.question : null,
    summary,
    reasons,
    shape: {
      primary: shape.primary,
      source: shape.source,
    },
    looks_like_question: looksLikeQuestion(goal),
    simple_read_only_action: simpleReadOnlyAction,
    trivial_text_correction: trivialTextCorrection,
    word_count: wordCount,
    planner_policy: {
      present: policy.present,
      default_route: policy.default_route,
      applied: policyApplied,
    },
    irreversible_action: decision.irreversible_action
      ? { ...decision.irreversible_action, execution_authorized: false }
      : null,
  };
}

// Render a compact human summary for bootstrap to print.
export function renderTriage(triage, { mode = "warn" } = {}) {
  const lines = [];
  const skipPaths = new Set(["skip_planner_question", "skip_planner"]);
  const lightPaths = new Set(["lightweight"]);
  const heavy = !skipPaths.has(triage.recommended_path) && !lightPaths.has(triage.recommended_path);
  const headerEmoji = heavy ? "ℹ️ " : "⚠️ ";
  lines.push(`${headerEmoji} TRIAGE: ${triage.recommended_path} (complexity score: ${triage.complexity_score}, shape: ${triage.shape.primary})`);
  if (triage.operator_action) lines.push(`     Operator action: ${triage.operator_action}`);
  lines.push(`     ${triage.summary}`);
  if (triage.reasons.length > 0 && (mode === "verbose" || !heavy)) {
    lines.push("     Why this recommendation:");
    for (const r of triage.reasons.slice(0, 5)) lines.push(`       • ${r}`);
  }
  if (triage.operator_action === "ask_user") {
    lines.push("     Recommended actions:");
    lines.push(`       1. Ask: ${triage.operator_question || "Confirm the exact target and permission before acting."}`);
    lines.push("       2. Continue directly after confirmation; don't open a plan just to resolve ambiguity.");
  } else if (skipPaths.has(triage.recommended_path)) {
    lines.push("     Recommended actions:");
    if (triage.recommended_path === "skip_planner_question") {
      lines.push("       1. Just answer the user. Don't open a plan.");
    } else if (triage.simple_read_only_action) {
      lines.push("       1. Just do the read-only action. Don't open a plan.");
    } else {
      lines.push("       1. Just do the task and commit (preferred).");
    }
    lines.push("       2. If a plan is genuinely needed, gates are minimal for this shape.");
    lines.push("       3. To close an opened plan immediately: bootstrap.mjs close");
  }
  return lines.join("\n");
}
