// plan_shape.mjs — Detect the shape of a plan from goal text + planned files +
// intent contract, so gates can apply shape-appropriate requirements instead
// of demanding the maximalist set on every plan.
//
// v7.3.0: introduced to fix the EXPLORE→PLAN ritual problem where webhook /
// integration / feature plans were forced to fill in "Root Cause: N/A" and
// "Adjacency: N/A" lines that contributed nothing.
//
// Shapes (mutually exclusive primary; secondary tags are additive):
//
//   bug-fix       — fixing a defect; root cause + adjacency required
//   regression    — restoring lost behavior; root cause + adjacency required
//   integration   — webhook / external API / connector; assumption ledger required
//   feature       — adding new capability; ≥1 finding suffices
//   scientific    — quant/research/model/data work; assumption probes required
//   refactor      — restructuring without behavior change; adjacency recommended
//   migration     — upgrade / move / delete; root cause + adjacency required
//   planner-core  — touches .agent/skills/iterative-planner/ shared surfaces
//   docs          — documentation-only change
//   unknown       — fallback when no signals match
//
// Each shape has an explicit set of EXPLORE requirements. The checklist runner
// honors shape requirements via `required_for_shapes` on YAML items.

const SHAPE_REQUIREMENTS = Object.freeze({
  "bug-fix":      { min_findings: 3, root_cause: true,  adjacency: true,  assumption_ledger: false },
  "regression":   { min_findings: 3, root_cause: true,  adjacency: true,  assumption_ledger: true },
  "integration":  { min_findings: 1, root_cause: false, adjacency: false, assumption_ledger: true },
  "feature":      { min_findings: 1, root_cause: false, adjacency: false, assumption_ledger: false },
  "scientific":   { min_findings: 3, root_cause: false, adjacency: false, assumption_ledger: true },
  "refactor":     { min_findings: 1, root_cause: false, adjacency: true,  assumption_ledger: false },
  "migration":    { min_findings: 3, root_cause: true,  adjacency: true,  assumption_ledger: true },
  "planner-core": { min_findings: 3, root_cause: true,  adjacency: true,  assumption_ledger: true },
  "docs":         { min_findings: 1, root_cause: false, adjacency: false, assumption_ledger: false },
  // v7.4.3: chore shape for operational/admin tasks (config tweaks, ad budget
  // changes, schedule edits, credential rotation, content updates). These
  // aren't engineering work; the iterative planner state machine adds friction
  // without value. Minimum gates so the agent can move through quickly when
  // it absolutely must use the planner — but bootstrap also prints a prompt
  // suggesting the agent skip the planner entirely for chores.
  "chore":        { min_findings: 1, root_cause: false, adjacency: false, assumption_ledger: false },
  // v7.4.4: analysis shape for review/audit/explain/list tasks that don't
  // produce code changes. Same minimal gate profile as chore — the planner
  // state machine isn't appropriate for read-only investigations.
  "analysis":     { min_findings: 1, root_cause: false, adjacency: false, assumption_ledger: false },
  "unknown":      { min_findings: 3, root_cause: true,  adjacency: true,  assumption_ledger: false },
});

const PLANNER_CORE_PATH_PATTERNS = [
  /^\.agent\/skills\/iterative-planner\//,
  /^\.agent\/workflows\//,
  /^\.agent\/rules\.md$/,
];

const DOC_PATH_PATTERNS = [
  /^docs?\//,
  /\.md$/,
  /^README/i,
];

function lower(value) {
  return String(value || "").toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function matchesAny(text, patterns) {
  const t = lower(text);
  return patterns.some((pattern) => pattern.test(t));
}

function hasWord(text, word) {
  return new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, "i").test(String(text || ""));
}

function hasAnyWord(text, words) {
  return words.some((word) => hasWord(text, word));
}

function planFilesTouchPlannerCore(plannedFiles) {
  return asArray(plannedFiles).some((filePath) => PLANNER_CORE_PATH_PATTERNS.some((pattern) => pattern.test(String(filePath || ""))));
}

const PLANNER_CORE_GOAL_PATTERN = /\b(iterative[\s-]?planner|planner[\s-]?core|persona(?:[\s-]+(?:activation|config))?[\s-]+authority|persona[\s-]+execution(?:[\s-]+script)?|persona_execute(?:\.mjs)?|persona_adapt(?:\.mjs)?|project_health(?:\.mjs)?|audit\.config(?:\.json)?|role[\s-]?packs?|transition[\s-]+gate|bootstrap\.mjs|rule_engine(?:\.mjs)?|verification_matrix(?:\.mjs)?)\b/i;

function looksLikePlannerCore(goalText) {
  return PLANNER_CORE_GOAL_PATTERN.test(String(goalText || ""));
}

// v7.4.3: chore detection. Operational/admin tasks (ad budget changes,
// credential rotations, schedule edits, content updates, dashboard tweaks)
// match a verb + noun pattern. They aren't engineering work, so the planner
// state machine adds friction without value. The verb-only or noun-only
// match is too loose; require both for chore classification.
const CHORE_VERB_PATTERN = /\b(increase|decrease|raise|lower|update|change|set|adjust|modify|tune|configure|reconfigure|rename|rebrand|toggle|enable|disable|rotate|reset|restart|reboot|schedule|reschedule|reorder|prioritize|deprioritize)\b/i;

const CHORE_NOUN_PATTERNS = [
  // Ad/marketing/billing
  /\bad[s]?[\s-]?(group|set|campaign|spend|budget|account|copy|creative)/i,
  /\bbudget(s)?\b/i,
  /\b(facebook|google|tiktok|linkedin|twitter|x|meta|reddit|instagram)\b/i,
  /\b(stripe|paypal|braintree|shopify|gumroad)\b/i,
  /\bsubscription[s]?\b/i,
  /\bpricing|coupon|discount|promotion\b/i,
  // Operational settings
  /\b(setting|preference|configuration|env(ironment)?[\s-]?var(iable)?|feature[\s-]?flag)[s]?\b/i,
  /\b(quota|limit|throttle|rate[\s-]?limit|threshold)[s]?\b/i,
  /\b(schedule|cron|cadence|frequency|interval)[s]?\b/i,
  /\b(credential|secret|token|api[\s-]?key|password)[s]?\b/i,
  /\b(permission|role|access|grant)[s]?\b/i,
  // Content/CMS chores (no code change)
  /\b(post|page|article|copy|wording|caption|landing[\s-]?page)\b/i,
  /\b(banner|hero|header|footer)[s]?\b/i,
];

const REDIRECT_CHORE_VERB_PATTERN = /\b(add|set\s+up|setup|create|configure|reconfigure|update|change|enable|disable|remove|delete|redirect|forward|rewrite)\b/i;
const REDIRECT_CHORE_NOUN_PATTERN = /\b(redirects?|rewrites?|url[\s-]forwarding|forwarding[\s-]rules?|301|302|old[\s-]?url|new[\s-]?url)\b/i;
const REDIRECT_ENGINEERING_CONTEXT_PATTERN = /\b(implement|build|fix|debug|middleware|router|route[\s-]handler|routing[\s-](logic|code)|application[\s-]route|server[\s-]side|next\.config|express|react[\s-]router|module|function|component|test)\b/i;

function looksLikeRedirectChore(goalText) {
  const text = String(goalText || "").trim();
  if (!text) return false;
  if (!REDIRECT_CHORE_VERB_PATTERN.test(text) || !REDIRECT_CHORE_NOUN_PATTERN.test(text)) return false;
  return !REDIRECT_ENGINEERING_CONTEXT_PATTERN.test(text);
}

function looksLikeChore(goalText) {
  const text = String(goalText || "").trim();
  if (!text) return false;
  if (looksLikeRedirectChore(text)) return true;
  if (!CHORE_VERB_PATTERN.test(text)) return false;
  return CHORE_NOUN_PATTERNS.some((pattern) => pattern.test(text));
}

// v7.4.4: analysis shape — review / audit / explain / inspect / show / list
// tasks that don't produce code changes. The triage layer recommends
// skipping the planner entirely for these; the shape keeps gates minimal
// when an agent does open a plan anyway.
const ANALYSIS_VERB_PATTERN = /^(review|check|audit|inspect|examine|assess|evaluate|recommend|report(?:\s+on)?|explain|describe|show|list|summari[sz]e|tell|find|lookup|look[\s-]up|investigate|analy[sz]e|compare|diff|read|trace|understand|open|opena|view|visit|load|navigate|go\s+to|pull\s+up|bring\s+up|look\s+at)\b/i;

const ENGINEERING_ACTION_PATTERN = /\b(refactor(?:s|ed|ing)?|implement(?:s|ed|ing)?|build(?:s|ing)?|built|fix(?:es|ed|ing)?|add(?:s|ed|ing)?|chang(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|introduc(?:e|es|ed|ing)|migrat(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|extract(?:s|ed|ing)?|consolidat(?:e|es|ed|ing)|wir(?:e|es|ed|ing)|integrat(?:e|es|ed|ing)|patch(?:es|ed|ing)?|ship(?:s|ped|ping)?|releas(?:e|es|ed|ing)|publish(?:es|ed|ing)?|connect(?:s|ed|ing)?|remov(?:e|es|ed|ing)|retir(?:e|es|ed|ing)|deduplicat(?:e|es|ed|ing)|simplif(?:y|ies|ied|ying))\b/gi;
const NEGATIVE_SCOPE_PREFIX_PATTERN = /\b(?:without|do\s+not|don't|not\s+to|must\s+not|should\s+not|will\s+not|won't|avoid(?:ing)?|exclud(?:e|es|ed|ing)|rather\s+than|no\s+(?:need|intention|plan)\s+to)\b[\s\S]{0,120}$|\b(?:not|no)\s*$/i;
const CLAUSE_BOUNDARY_PATTERN = /[.!?;\n]|\b(?:but|however|instead|then)\b/gi;
const NOMINAL_ACTION_PREFIX_PATTERN = /(?:^|[^a-z0-9])(?<marker>a|an|the|this|that|these|those|my|your|his|her|its|our|their|[a-z0-9][a-z0-9-]*['’]s)(?<modifiers>(?:\s+[a-z0-9][a-z0-9'-]*){0,2})\s*$/i;
const VERBAL_BRIDGE_PATTERN = /^(?:and|before|after|to|can|could|may|might|must|shall|should|will|would|do|does|did|is|are|was|were|be|been|being|has|have|had)$/i;

function prefixWithinClause(text, actionIndex) {
  const prefix = String(text || "").slice(0, actionIndex);
  let boundary = 0;
  for (const match of prefix.matchAll(CLAUSE_BOUNDARY_PATTERN)) {
    boundary = (match.index || 0) + match[0].length;
  }
  return prefix.slice(boundary);
}

function engineeringActionIsNegated(text, actionIndex) {
  return NEGATIVE_SCOPE_PREFIX_PATTERN.test(prefixWithinClause(text, actionIndex));
}

function engineeringActionIsNominal(text, actionIndex) {
  const prefix = prefixWithinClause(text, actionIndex);
  const match = prefix.match(NOMINAL_ACTION_PREFIX_PATTERN);
  if (!match) return false;

  const modifiers = String(match.groups?.modifiers || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return !modifiers.some((word) => VERBAL_BRIDGE_PATTERN.test(word));
}

export function hasPositiveEngineeringIntent(goalText) {
  const text = String(goalText || "").trim();
  if (!text) return false;
  for (const match of text.matchAll(ENGINEERING_ACTION_PATTERN)) {
    const actionIndex = match.index || 0;
    if (!engineeringActionIsNegated(text, actionIndex) && !engineeringActionIsNominal(text, actionIndex)) return true;
  }
  return false;
}

export function looksLikeAnalysisGoal(goalText) {
  const text = String(goalText || "").trim();
  if (!text) return false;
  if (!ANALYSIS_VERB_PATTERN.test(text)) return false;
  return !hasPositiveEngineeringIntent(text);
}

const SCIENTIFIC_DOMAIN_PATTERN = /\b(trueskill|true skill|markov|elo|glicko|bradley[\s-]?terry|bayesian rating|sackmann|atp|wta|tennis|quant|betting|odds|alpha|factor|signal|strategy)\b/i;
const SCIENTIFIC_PROBE_PATTERN = /\b(point[\s-]?(level|based)|points? (won|lost)|dataset|data|column|coverage|lineage|feature engineering|backtest|walk[\s-]?forward|out[\s-]?of[\s-]?sample|temporal split|leakage|calibration|benchmark|probabilit(y|ies)|prediction|predictive|model)\b/i;
const SCIENTIFIC_UNAMBIGUOUS_PATTERN = /\b(backtest|walk[\s-]?forward|out[\s-]?of[\s-]?sample|temporal split|leakage|calibration|trueskill|true skill|markov|sackmann)\b/i;

function looksLikeScientificQuant(goalText) {
  const text = String(goalText || "").trim();
  if (!text) return false;
  if (SCIENTIFIC_UNAMBIGUOUS_PATTERN.test(text) && SCIENTIFIC_PROBE_PATTERN.test(text)) return true;
  return SCIENTIFIC_DOMAIN_PATTERN.test(text) && SCIENTIFIC_PROBE_PATTERN.test(text);
}

function planFilesAreDocsOnly(plannedFiles) {
  const files = asArray(plannedFiles).filter((filePath) => String(filePath || "").trim());
  if (files.length === 0) return false;
  return files.every((filePath) => DOC_PATH_PATTERNS.some((pattern) => pattern.test(String(filePath || ""))));
}

export function detectPlanShape({ goalText = "", plannedFiles = [], intentContract = null } = {}) {
  const goal = String(goalText || "").trim();
  const explicit = lower(intentContract?.plan_shape || intentContract?.shape || "");
  if (explicit && SHAPE_REQUIREMENTS[explicit]) {
    return { primary: explicit, source: "intent_contract", requirements: SHAPE_REQUIREMENTS[explicit] };
  }

  const signals = {
    bug:         hasAnyWord(goal, ["fix", "bug", "broken", "fails", "regression", "incident", "diagnose", "root[\\s-]?cause"]),
    integration: hasAnyWord(goal, ["webhook", "integrate", "integration", "connector", "external"]) ||
                 /\bAPI\b/.test(goal) ||
                 hasAnyWord(goal, ["GHL", "stripe", "shopify", "wordpress", "wp"]),
    feature:     hasAnyWord(goal, ["add", "build", "implement", "introduce", "create", "support", "enable"]) ||
                 /^(add|build|implement|create|introduce)\b/i.test(goal),
    refactor:    hasAnyWord(goal, ["refactor", "consolidate", "restructure", "extract", "deduplicate", "simplify"]),
    migration:   hasAnyWord(goal, ["migrate", "migration", "upgrade", "move", "delete", "remove", "rename", "retire"]),
    docs:        hasAnyWord(goal, ["document", "documentation", "doc", "guide", "readme", "tutorial"]),
    chore:       looksLikeChore(goal),
    analysis:    looksLikeAnalysisGoal(goal),
    scientific:  looksLikeScientificQuant(goal),
    plannerCore: planFilesTouchPlannerCore(plannedFiles) || looksLikePlannerCore(goal),
    docsOnly:    planFilesAreDocsOnly(plannedFiles),
  };

  // Precedence: planner-core > scientific > chore > analysis > bug-fix > migration > integration > refactor > docs > feature > unknown.
  // Planner-core wins because the proof bundle is non-negotiable for that surface.
  // Scientific/quant work wins over generic feature/bug wording because data
  // and model claims must be probed before they become plan premises.
  // Bug-fix beats integration: "diagnose the regression in the checkout API" is
  // diagnostic work that touches an API, not API integration work.
  // Chore beats integration / migration: "Rotate Stripe API keys" is operational
  // even though it mentions Stripe; "Update WP admin password" is operational
  // even though it mentions WordPress. The verb+noun chore pattern is more
  // specific than bare keyword matching, so chore wins when both fire.
  // Analysis beats raw engineering nouns: "review the parser fix" is read-only,
  // while a later positive work verb makes looksLikeAnalysisGoal return false.
  // Integration beats feature: webhook/connector plans need assumption ledgers.
  let primary;
  let source = "goal_text";
  if (signals.plannerCore) { primary = "planner-core"; source = "planned_files"; }
  else if (signals.scientific) { primary = "scientific"; }
  else if (signals.chore) { primary = "chore"; }
  else if (signals.analysis) { primary = "analysis"; }
  else if (signals.bug) { primary = "bug-fix"; }
  else if (signals.migration) { primary = "migration"; }
  else if (signals.integration) { primary = "integration"; }
  else if (signals.refactor) { primary = "refactor"; }
  else if (signals.docsOnly) { primary = "docs"; source = "planned_files"; }
  else if (signals.docs) { primary = "docs"; }
  else if (signals.feature) { primary = "feature"; }
  else { primary = "unknown"; }

  return {
    primary,
    source,
    requirements: SHAPE_REQUIREMENTS[primary] || SHAPE_REQUIREMENTS.unknown,
    signals,
  };
}

export function shapeRequiresField(shape, field) {
  const req = (shape && shape.requirements) || SHAPE_REQUIREMENTS.unknown;
  return Boolean(req[field]);
}

export function shapeMinFindings(shape) {
  const req = (shape && shape.requirements) || SHAPE_REQUIREMENTS.unknown;
  return Number(req.min_findings || 1);
}

export const SHAPE_NAMES = Object.freeze(Object.keys(SHAPE_REQUIREMENTS));
export { SHAPE_REQUIREMENTS };
