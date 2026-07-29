// supervisor_runner.mjs
//
// Reusable wrapper around lib/provider_client.mjs for planner supervisor verdicts.
// Used by escalation_check.mjs (advisor) and transition.mjs (ontology fix).
//
// Contract:
//   - Provider verdicts are advisory; deterministic gates remain authoritative.
//   - sha256 cache keyed on (supervisor_id, supervisor_version, context_hash).
//   - schema validation rejects malformed responses; fallback verdict on any error.
//   - PLANNER_SUPERVISOR_DISABLED=1 short-circuits to fallback for cost control.
//   - Mock-response is forwarded via PLANNER_SUPERVISOR_MOCK_RESPONSE for tests.

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { callOpenAiCompatibleJson, loadSupervisorProviderConfig, redactSecrets } from "./provider_client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = join(__dirname, "..", "..", "cache", "supervisor_verdicts");

// v1 -> v2: command-shape whitelist added.
// v2 -> v3: prompt-side secret redaction added (Vector 5).
// v3 -> v4: cache-hit re-validation (red-team audit F-001), tighter args
//   regex (F-002), and truthy phase_guard_required (F-003). v3 cache
//   entries may carry whitelist-bypassing commands or wrong-phase fixes
//   from prior runs, so the version bump invalidates them; subsequent
//   reads also re-validate every cache entry through the active validator.
export const SUPERVISOR_VERSION = "v4";

// Vector 5 fix: redact secrets from the supervisor's outbound prompt payload
// before it reaches the LLM provider. Wraps the existing redactSecrets()
// pattern library (configured API keys, Bearer tokens, sk-*, ghp_*, github_pat_*).
// Exported for direct unit-test access.
export function redactSupervisorPromptPayload(payload, env = process.env) {
  const serialised = typeof payload === "string" ? payload : JSON.stringify(payload);
  return redactSecrets(serialised, env);
}

// Allowed command shapes. The supervisor prompt instructs the model to emit
// only these; the validator filters anything else as a hallucination.
//
// Three permitted shapes:
//   1. node .agent/skills/iterative-planner/scripts/<file>.mjs [args...]
//   2. node .agent/skills/iterative-planner/tests/<file>.mjs [args...]
//   3. /workflow-name slash command (e.g. /advisor, /retro, /steward)
//
// Tested through the governed advisor/supervisor scenarios in test_advise.mjs. If we need a
// new shape (e.g. shell commands like `git status`), add a regex here AND a
// corresponding test case, AND bump SUPERVISOR_VERSION so existing caches
// don't serve verdicts validated under the old whitelist.
// Case-sensitive: planner convention is lowercase script names + lowercase slash
// commands. Strict matching reduces the risk of a model fabricating a path
// that "looks right" via case variation (e.g., /Advisor, /ADVISOR).
//
// Args portion (F-002 audit fix): allow only A-Za-z0-9 plus a small whitelist
// of safe shell-metachar-free punctuation [_./=-]. Rejects shell redirection
// (`>`, `<`), globs (`*`, `?`), tabs/newlines, and multiple spaces.
// Capped at 200 chars in args to bound payload-length attacks.
const PLANNER_SCRIPT_CMD_RE = /^node \.agent\/skills\/iterative-planner\/(scripts|tests)\/[a-z0-9_-]+\.mjs( [A-Za-z0-9_./=-]+){0,20}$/;
const SLASH_COMMAND_RE = /^\/[a-z][a-z0-9-]*$/;

export function isValidPlannerCommand(cmd) {
  if (typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // Hard guards against any control character (newline, tab, NUL, etc.) before
  // regex testing — defence in depth against future regex weaknesses.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  // Hard cap on overall length to bound payload-size attacks.
  if (trimmed.length > 400) return false;
  if (PLANNER_SCRIPT_CMD_RE.test(trimmed)) return true;
  if (SLASH_COMMAND_RE.test(trimmed)) return true;
  return false;
}

const ALLOWED_COMMAND_SHAPES_DOC = [
  "Allowed command shapes (ONLY these will be accepted):",
  "  1. node .agent/skills/iterative-planner/scripts/<existing-file>.mjs [args]",
  "  2. node .agent/skills/iterative-planner/tests/<existing-file>.mjs",
  "  3. /workflow-name (e.g. /advisor, /retro, /steward, /safe-change, /red-team-audit)",
  "Do NOT invent script filenames. Do NOT use shell commands (echo, cat, git, etc.).",
  "If unsure whether a script exists, recommend /advisor as the safe fallback.",
].join(" ");

const ADVISOR_PROMPT_TEMPLATE = [
  "You are the planner advisor supervisor.",
  "Read the escalation context and produce a single recommended next move.",
  "Return JSON exactly matching: {\"next\":\"one sentence action\",\"why\":\"one sentence reason\",\"commands\":[\"...\"]}.",
  "Keep next and why under 200 chars each. Provide 1-3 commands.",
  ALLOWED_COMMAND_SHAPES_DOC,
  "If the escalation reason is unclear, return commands: [\"/advisor\"].",
].join(" ");

const ONTOLOGY_FIX_PROMPT_TEMPLATE = [
  "You are the planner ontology fix supervisor.",
  "An invariant has been violated. Recommend the lowest-blast-radius fix.",
  "Return JSON exactly matching: {\"suggested_fix_command\":\"<command or null>\",\"auto_repair_safe\":<bool>,\"explanation\":\"one sentence\"}.",
  "If you cannot infer a safe fix, return suggested_fix_command=null and auto_repair_safe=false.",
  ALLOWED_COMMAND_SHAPES_DOC,
  "Never recommend editing state.json directly.",
].join(" ");

function sha256(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

function cacheKey(supervisorId, contextHash) {
  return sha256(`${supervisorId}::${SUPERVISOR_VERSION}::${contextHash}`);
}

function cachePath(key) {
  return join(CACHE_DIR, `${key}.json`);
}

function readCacheEntry(key) {
  try {
    const p = cachePath(key);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

// Red-team audit F-001 fix: read+revalidate cache entries through the same
// validator that gates fresh LLM responses. A cache entry that was written by
// a prior validator version, or planted by an attacker with filesystem access,
// could carry whitelist-bypassing commands.
//
// Two deletion triggers:
//   1. validator returns null (entry completely unparseable / shape rejected)
//   2. validator returned a result but filtered_command_count > 0 — meaning
//      SOME commands in the cached file failed the whitelist. Even though the
//      returned verdict is safe (bad commands stripped), the file on disk
//      still contains them. Delete so the bad strings don't persist at rest
//      and the next call re-fetches a clean verdict.
function readValidatedCacheEntry(key, validator) {
  const raw = readCacheEntry(key);
  if (!raw) return null;
  // Validators expect the bare verdict shape, not the supervisor_status/source
  // metadata fields. Strip those before validating.
  const { supervisor_status, source, filtered_command_count, ...verdict } = raw;
  const validated = validator(verdict);
  const poisoned =
    !validated ||
    (validated.filtered_command_count && validated.filtered_command_count > 0) ||
    validated.degraded_from_invalid_cmd === true;
  if (poisoned) {
    try { unlinkSync(cachePath(key)); } catch { /* ignore */ }
    return null;
  }
  return validated;
}

function writeCacheEntry(key, verdict) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(key), JSON.stringify(verdict, null, 2) + "\n");
  } catch {
    /* non-fatal; recompute next time */
  }
}

export function clearSupervisorCache() {
  try {
    if (!existsSync(CACHE_DIR)) return 0;
    let removed = 0;
    for (const name of readdirSync(CACHE_DIR)) {
      if (!name.endsWith(".json")) continue;
      try {
        unlinkSync(join(CACHE_DIR, name));
        removed += 1;
      } catch { /* ignore individual failures */ }
    }
    return removed;
  } catch {
    return 0;
  }
}

function isDisabled(env) {
  const v = String(env?.PLANNER_SUPERVISOR_DISABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// Red-team audit F-003 fix: accept any reasonable truthy value as a request
// to engage the M-009 phase guard. The supervisor's safety contract is to
// REFUSE to propose fixes for phase-premature invariants; the trigger should
// fail SAFE (over-guarding is harmless, under-guarding lets the supervisor
// propose wrong-phase fixes).
function isPhaseGuardActive(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "yes" || v === "1";
  }
  return false;
}

// Vector 9: fail-closed mode. When PLANNER_SUPERVISOR_REQUIRED=1 the
// supervisor must produce a fresh LLM verdict; any fallback path (LLM
// down, missing API key, malformed JSON, all-hallucinated commands) is
// flagged with required_but_unavailable=true so callers (bootstrap.mjs)
// can exit non-zero rather than silently degrading.
export function isSupervisorRequired(env) {
  const v = String(env?.PLANNER_SUPERVISOR_REQUIRED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function markRequiredIfApplicable(verdict, env) {
  if (!verdict || !isSupervisorRequired(env)) return verdict;
  // Strict interpretation: under PLANNER_SUPERVISOR_REQUIRED=1 the operator
  // expects a *fresh LLM verdict*. fresh and cached count as success; anything
  // else (unavailable, phase_guard, deterministic refusals) is flagged so
  // callers can exit non-zero or alert.
  if (verdict.supervisor_status === "fresh" || verdict.supervisor_status === "cached") return verdict;
  return { ...verdict, required_but_unavailable: true };
}

function fallbackAdvisorVerdict(reason, env = {}) {
  return markRequiredIfApplicable({
    next: "Review the escalation manually; run /advisor for full triage",
    why: `Supervisor unavailable: ${reason}`,
    commands: [
      "node .agent/skills/iterative-planner/scripts/escalation_check.mjs",
    ],
    supervisor_status: "unavailable",
    source: "fallback",
    reason,
  }, env);
}

function fallbackOntologyFixVerdict(violation, reason, env = {}) {
  return markRequiredIfApplicable({
    suggested_fix_command: null,
    auto_repair_safe: false,
    explanation: `Supervisor unavailable (${reason}); investigate ${violation?.name || "violation"} manually`,
    supervisor_status: "unavailable",
    source: "fallback",
    reason,
  }, env);
}

function validateAdvisorVerdict(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const next = typeof parsed.next === "string" ? parsed.next.trim() : "";
  const why = typeof parsed.why === "string" ? parsed.why.trim() : "";
  if (!next || !why) return null;
  if (!Array.isArray(parsed.commands)) return null;
  // Filter to only commands that match a known planner CLI shape. This
  // catches hallucinated paths like `node nonexistent-script.js`.
  // If every command is filtered out, treat as malformed -> fallback.
  // Tracked filtered count is returned so the renderer/test can surface it.
  const candidates = parsed.commands
    .filter((c) => typeof c === "string" && c.trim())
    .map((c) => c.trim());
  const commands = candidates.filter(isValidPlannerCommand).slice(0, 3);
  if (commands.length === 0) return null;
  const filtered_count = candidates.length - commands.length;
  return {
    next: next.slice(0, 400),
    why: why.slice(0, 400),
    commands,
    ...(filtered_count > 0 ? { filtered_command_count: filtered_count } : {}),
  };
}

function validateOntologyFixVerdict(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const cmd = parsed.suggested_fix_command;
  if (cmd !== null && (typeof cmd !== "string" || !cmd.trim())) return null;
  const safe = parsed.auto_repair_safe;
  if (typeof safe !== "boolean") return null;
  const explanation = typeof parsed.explanation === "string" ? parsed.explanation.trim() : "";
  if (!explanation) return null;
  // If supervisor proposed a command but it doesn't match a known planner CLI
  // shape, degrade it to null + manual review rather than letting a
  // hallucinated path render as a `Run:` line.
  let finalCmd = cmd === null ? null : cmd.trim().slice(0, 400);
  let finalSafe = safe;
  let finalExplanation = explanation.slice(0, 400);
  let degraded = false;
  if (finalCmd !== null && !isValidPlannerCommand(finalCmd)) {
    finalExplanation = `Supervisor proposed an unrecognised command shape (${finalCmd.slice(0, 80)}); falling back to manual review`;
    finalCmd = null;
    finalSafe = false;
    degraded = true;
  }
  return {
    suggested_fix_command: finalCmd,
    auto_repair_safe: finalSafe,
    explanation: finalExplanation,
    // Red-team F-001 signal: cache reads use this to delete entries whose
    // stored fix_command failed the whitelist. The returned verdict itself
    // is safe (cmd downgraded to null), but the on-disk file still carries
    // the hallucinated string — better to clear it than to keep filtering
    // it forever.
    ...(degraded ? { degraded_from_invalid_cmd: true } : {}),
  };
}

function configureProvider(env) {
  const config = loadSupervisorProviderConfig(env);
  if (env.PLANNER_SUPERVISOR_MOCK_RESPONSE) {
    config.mockResponse = env.PLANNER_SUPERVISOR_MOCK_RESPONSE;
  }
  if (env.PLANNER_SUPERVISOR_MOCK_ERROR) {
    config.mockError = env.PLANNER_SUPERVISOR_MOCK_ERROR;
  }
  return config;
}

export async function runAdvisorSupervisor({
  escalations,
  planState = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  // Wrap the body so every return path passes through markRequiredIfApplicable.
  // This flags fallback / phase_guard verdicts with required_but_unavailable
  // when PLANNER_SUPERVISOR_REQUIRED=1 (Vector 9 fail-closed mode).
  const result = await (async () => {
    if (isDisabled(env)) {
      return fallbackAdvisorVerdict("PLANNER_SUPERVISOR_DISABLED", env);
    }
    const context = {
      escalations: Array.isArray(escalations) ? escalations.slice(0, 5).map((e) => ({
        type: e?.type || "unknown",
        reason: typeof e?.reason === "string" ? e.reason.slice(0, 500) : "",
        severity: e?.severity || null,
      })) : [],
      plan_phase: planState?.state || null,
      plan_iter: typeof planState?.iter === "number" ? planState.iter : null,
    };
    const contextHash = sha256(JSON.stringify(context));
    const key = cacheKey("advisor", contextHash);
    // F-001 fix: re-validate cache hits through validateAdvisorVerdict so a
    // poisoned cache file (planted by FS attacker, or a v3-keyed leftover
    // from earlier validator versions) cannot ship whitelist-bypassing
    // commands. readValidatedCacheEntry deletes invalid entries.
    const cached = readValidatedCacheEntry(key, validateAdvisorVerdict);
    if (cached) {
      return { ...cached, supervisor_status: "cached", source: "cache" };
    }
    const config = configureProvider(env);
    let llmResult;
    try {
      llmResult = await callOpenAiCompatibleJson({
        config,
        env,
        fetchImpl,
        maxTokens: 800,
        messages: [
          { role: "system", content: ADVISOR_PROMPT_TEMPLATE },
          { role: "user", content: redactSupervisorPromptPayload(context, env) },
        ],
      });
    } catch (err) {
      return fallbackAdvisorVerdict(err?.code || err?.message || "llm_call_failed", env);
    }
    const validated = validateAdvisorVerdict(llmResult?.parsed);
    if (!validated) {
      return fallbackAdvisorVerdict("schema_validation_failed", env);
    }
    const verdict = { ...validated, supervisor_status: "fresh", source: llmResult.source || "provider" };
    writeCacheEntry(key, verdict);
    return verdict;
  })();
  return markRequiredIfApplicable(result, env);
}

export async function runOntologyFixSupervisor({
  violation,
  factBundle = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const result = await (async () => {
    if (!violation || typeof violation !== "object") {
      return fallbackOntologyFixVerdict({ name: "unknown" }, "no_violation_provided", env);
    }
    if (isDisabled(env)) {
      return fallbackOntologyFixVerdict(violation, "PLANNER_SUPERVISOR_DISABLED", env);
    }
    // M-009 guard: phase-premature invariants get a deterministic null verdict
    // Red-team audit F-003 fix: accept truthy values, not just strict === true.
    // Callers passing JSON-parsed violations might serialize the flag as a
    // string ("true"/"yes"/"1") or number (1). The safety contract is
    // "phase-premature invariants must NOT receive an LLM-generated fix" —
    // err on the side of guarding too much, never too little.
    if (isPhaseGuardActive(violation.phase_guard_required)) {
      return {
        suggested_fix_command: null,
        auto_repair_safe: false,
        explanation: `Invariant ${violation.name || "unknown"} is phase-premature; resolve in a later planner phase`,
        supervisor_status: "phase_guard",
        source: "deterministic",
      };
    }
    const context = {
      invariant_name: typeof violation.name === "string" ? violation.name : "unknown",
      invariant_detail: typeof violation.detail === "string" ? violation.detail.slice(0, 500) : "",
      fact_bundle_summary: factBundle ? Object.keys(factBundle).slice(0, 10) : null,
    };
    const contextHash = sha256(JSON.stringify(context));
    const key = cacheKey("ontology_fix", contextHash);
    // F-001 fix: same as runAdvisorSupervisor — re-validate cache hits.
    const cached = readValidatedCacheEntry(key, validateOntologyFixVerdict);
    if (cached) {
      return { ...cached, supervisor_status: "cached", source: "cache" };
    }
    const config = configureProvider(env);
    let llmResult;
    try {
      llmResult = await callOpenAiCompatibleJson({
        config,
        env,
        fetchImpl,
        maxTokens: 400,
        messages: [
          { role: "system", content: ONTOLOGY_FIX_PROMPT_TEMPLATE },
          { role: "user", content: redactSupervisorPromptPayload(context, env) },
        ],
      });
    } catch (err) {
      return fallbackOntologyFixVerdict(violation, err?.code || err?.message || "llm_call_failed", env);
    }
    const validated = validateOntologyFixVerdict(llmResult?.parsed);
    if (!validated) {
      return fallbackOntologyFixVerdict(violation, "schema_validation_failed", env);
    }
    const verdict = { ...validated, supervisor_status: "fresh", source: llmResult.source || "provider" };
    writeCacheEntry(key, verdict);
    return verdict;
  })();
  return markRequiredIfApplicable(result, env);
}

export function renderAdvisorVerdictBlock(verdict) {
  // Stdout-safe rendering for bootstrap.mjs / transition.mjs.
  // Returns multi-line string ready to console.log.
  if (!verdict) return "";
  const lines = [
    `  NEXT: ${verdict.next || "(no recommendation)"}`,
    `  WHY:  ${verdict.why || "(no reason)"}`,
  ];
  for (const cmd of Array.isArray(verdict.commands) ? verdict.commands : []) {
    lines.push(`     Run: ${cmd}`);
  }
  lines.push(`  Supervisor: ${verdict.supervisor_status || "unknown"} (source=${verdict.source || "unknown"})`);
  // Vector 9: when PLANNER_SUPERVISOR_REQUIRED=1 and the supervisor degraded,
  // surface a loud line so operators don't read a fallback as genuine LLM
  // guidance. bootstrap.mjs status uses this same flag to exit non-zero.
  if (verdict.required_but_unavailable) {
    lines.push(`  ⚠️  PLANNER_SUPERVISOR_REQUIRED is set but the supervisor did not produce a fresh verdict. This is a fallback.`);
  }
  return lines.join("\n");
}

// Phase B helper used by transition.mjs to render the Suggested Fixes block.
// Takes the array of semantic-check results (as returned by runSemanticChecks
// then enriched by enrichViolationsWithFixes). Returns a stdout-ready multi-line
// string, or empty string if there is nothing to render.
//
// Two sections may appear, separated by a blank line:
//   "Suggested Fixes (supervisor-generated; advisory)"
//      — one entry per violation with a non-null suggested_fix_command
//   "Phase-Premature Violations (M-009 guard)"
//      — one entry per violation flagged phase_guard (no fix command — defer)
//
// Each Suggested Fix entry renders as:
//     <invariant-name> (<detail>) [safe] | [manual review]
//       Run: <command>
//       Why: <one-sentence explanation>
//       Source: <provider | cache | fallback | mock>
export function renderSuggestedFixesBlock(semanticResults) {
  if (!Array.isArray(semanticResults) || semanticResults.length === 0) return "";
  const sections = [];
  for (const r of semanticResults) {
    if (!Array.isArray(r?.violations) || r.violations.length === 0) continue;
    const fixable = r.violations.filter((v) => v?.suggested_fix_command && v.supervisor_status !== "phase_guard");
    const phaseGuarded = r.violations.filter((v) => v?.supervisor_status === "phase_guard");
    if (fixable.length > 0) {
      const lines = ["  -- Suggested Fixes (supervisor-generated; advisory) --"];
      for (const v of fixable) {
        const safetyTag = v.auto_repair_safe ? "[safe]" : "[manual review]";
        lines.push(`  ${v.name}${v.detail ? ` (${v.detail})` : ""} ${safetyTag}`);
        lines.push(`     Run: ${v.suggested_fix_command}`);
        if (v.explanation) lines.push(`     Why: ${v.explanation}`);
        if (v.supervisor_source) lines.push(`     Source: ${v.supervisor_source}`);
      }
      sections.push(lines.join("\n"));
    }
    if (phaseGuarded.length > 0) {
      const lines = [`  -- Phase-Premature Violations (M-009 guard; ${phaseGuarded.length}) --`];
      for (const v of phaseGuarded) {
        lines.push(`  ${v.name}${v.detail ? ` (${v.detail})` : ""}: resolve in a later planner phase`);
      }
      sections.push(lines.join("\n"));
    }
  }
  return sections.join("\n\n");
}

// Phase A helper used by bootstrap.mjs to render the advisor escalation block.
// Combines the escalation banner with the supervisor verdict (or the legacy
// marker fallback when supervisor_verdict is absent).
// Returns multi-line stdout-ready string, or empty string if no escalation.
export function renderAdvisorEscalationBlock({ advisorEscalation, supervisorVerdict } = {}) {
  if (!advisorEscalation) return "";
  const lines = [`  ⚠️  Advisor review recommended — ${advisorEscalation.reason || "(no reason given)"}`];
  if (advisorEscalation.recommended_followup_workflow) {
    lines.push(`     Follow-up: ${advisorEscalation.recommended_followup_workflow} after /advisor acknowledgement.`);
    if (advisorEscalation.recommended_followup_next) {
      lines.push(`     NEXT: ${advisorEscalation.recommended_followup_next}`);
    }
  }
  if (supervisorVerdict) {
    lines.push("");
    lines.push(renderAdvisorVerdictBlock(supervisorVerdict).replace(/^/gm, "   "));
  } else if (advisorEscalation.auto_launch_marker) {
    lines.push(`     ${advisorEscalation.auto_launch_marker}`);
  }
  lines.push(`     Run /advisor to capture lessons and check codebase health.`);
  return lines.join("\n");
}
