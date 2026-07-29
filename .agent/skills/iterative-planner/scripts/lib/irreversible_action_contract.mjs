// @planner:module = irreversible_action_contract
// @planner:capability = operator_gated_irreversible_action_execution_boundary
// @planner:story = US-094
// @planner:proves = crit:AC-US-094-001, crit:AC-US-094-002, crit:AC-US-094-003, crit:AC-US-094-004, crit:AC-US-094-005, crit:AC-US-094-007

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SKILL_DIR = resolve(dirname(__filename), "..", "..");

export const DEFAULT_IRREVERSIBLE_ACTION_REGISTRY_PATH = join(
  SKILL_DIR,
  "config",
  "irreversible_action_registry.json",
);

const REQUIRED_BUILTIN_IDS = Object.freeze([
  "external_communication",
  "publish",
  "deploy",
  "spend_payment",
  "delete_remote",
  "kill_promote",
]);
const OVERLAY_FIELDS = new Set(["$schema", "version", "action_classes"]);
const ACTION_CLASS_FIELDS = new Set([
  "id",
  "label",
  "aliases",
  "intent_phrases",
  "confirmation_token",
  "required_fields",
]);
const BOUNDED_AFFIRMATIVE_POLICY = "bounded_affirmative_v1";
const BOUNDED_AFFIRMATIVES = new Set([
  "yes",
  "yes please",
  "yes do it",
  "yes proceed",
  "yes go ahead",
  "yes let's do it",
  "please do it",
  "please proceed",
  "please go ahead",
  "do it",
  "go ahead",
  "proceed",
  "ok",
  "okay",
  "ok please",
  "okay please",
  "ok do it",
  "okay do it",
  "ok proceed",
  "okay proceed",
  "ok go ahead",
  "okay go ahead",
  "ok let's do it",
  "okay let's do it",
  "let's do it",
  "i confirm",
  "i approve",
  "confirmed",
]);

function sha256(value) {
  return createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "");
}

function parseJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON at ${path}: ${error.message}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function normalizeActionClass(entry, { source }) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${source} action class must be an object`);
  }
  for (const key of Object.keys(entry)) {
    if (!ACTION_CLASS_FIELDS.has(key)) throw new Error(`${source} action class has unsupported field ${key}`);
  }
  const id = assertString(entry.id, `${source} action class id`);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`${source} action class id ${id} must be lower snake_case`);
  const label = assertString(entry.label, `${source} action class ${id} label`);
  if (!Array.isArray(entry.aliases) || entry.aliases.length === 0) throw new Error(`${source} action class ${id} needs aliases`);
  const aliases = entry.aliases.map((alias) => assertString(alias, `${source} action class ${id} alias`));
  if (!aliases.some((alias) => normalizeKey(alias) === id)) aliases.unshift(id);
  if (!Array.isArray(entry.intent_phrases) || entry.intent_phrases.length === 0) {
    throw new Error(`${source} action class ${id} needs intent_phrases`);
  }
  const intentPhrases = entry.intent_phrases.map((phrase) => assertString(phrase, `${source} action class ${id} intent phrase`));
  if (Object.hasOwn(entry, "confirmation_token") && source !== "project overlay") {
    throw new Error(`${source} action class ${id} cannot declare confirmation_token`);
  }
  if (Object.hasOwn(entry, "confirmation_token")) {
    assertString(entry.confirmation_token, `${source} action class ${id} deprecated confirmation_token`);
  }
  if (!Array.isArray(entry.required_fields)
    || !entry.required_fields.includes("target")
    || !entry.required_fields.includes("payload_ref")) {
    throw new Error(`${source} action class ${id} must require target and payload_ref`);
  }
  return {
    id,
    label,
    aliases: [...new Set(aliases)],
    intent_phrases: [...new Set(intentPhrases)],
    required_fields: ["target", "payload_ref"],
    source,
  };
}

function validateGlobalContract(registry) {
  if (registry.version !== 1) throw new Error("built-in registry version must be 1");
  const modes = Array.isArray(registry.supported_modes) ? registry.supported_modes : [];
  const previews = Array.isArray(registry.preview_modes) ? registry.preview_modes : [];
  for (const mode of ["draft", "dry_run", "execute"]) {
    if (!modes.includes(mode)) throw new Error(`built-in registry is missing supported mode ${mode}`);
  }
  for (const mode of ["draft", "dry_run"]) {
    if (!previews.includes(mode)) throw new Error(`built-in registry is missing preview mode ${mode}`);
  }
  const confirmation = registry.confirmation || {};
  if (confirmation.required_source !== "direct_user_input"
    || confirmation.generated_must_be !== false
    || confirmation.delegated_must_be !== false
    || confirmation.require_actor !== true
    || confirmation.require_recorded_at !== true
    || confirmation.require_context_binding !== true
    || confirmation.text_hash !== "sha256"
    || confirmation.intent_policy !== BOUNDED_AFFIRMATIVE_POLICY) {
    throw new Error("built-in registry weakens the permanent direct-human confirmation line");
  }
  if (!Number.isInteger(confirmation.max_age_seconds) || confirmation.max_age_seconds < 1) {
    throw new Error("built-in registry confirmation max_age_seconds must be a positive integer");
  }
  if (!Number.isInteger(confirmation.max_future_skew_seconds) || confirmation.max_future_skew_seconds < 0) {
    throw new Error("built-in registry confirmation max_future_skew_seconds must be a non-negative integer");
  }
  if (!Array.isArray(registry.persona_obligations) || registry.persona_obligations.length === 0) {
    throw new Error("built-in registry must declare persona_obligations");
  }
}

function mergeClasses(classes) {
  const ids = new Set();
  const aliases = new Map();
  for (const entry of classes) {
    if (ids.has(entry.id)) throw new Error(`duplicate action class id ${entry.id}`);
    ids.add(entry.id);
    for (const alias of entry.aliases) {
      const key = normalizeKey(alias);
      if (aliases.has(key)) throw new Error(`duplicate alias ${JSON.stringify(alias)} across ${aliases.get(key)} and ${entry.id}`);
      aliases.set(key, entry.id);
    }
  }
  return { ids, aliases };
}

export function validateIrreversibleActionRegistry(registry, { requireBuiltins = true, source = "registry" } = {}) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new Error(`${source} must be an object`);
  if (!Array.isArray(registry.action_classes)) throw new Error(`${source} action_classes must be an array`);
  const actionClasses = registry.action_classes.map((entry) => normalizeActionClass(entry, { source }));
  const { ids } = mergeClasses(actionClasses);
  if (requireBuiltins) {
    validateGlobalContract(registry);
    for (const id of REQUIRED_BUILTIN_IDS) {
      if (!ids.has(id)) throw new Error(`built-in registry is missing required action class ${id}`);
    }
  }
  return { ...registry, action_classes: actionClasses };
}

export function loadIrreversibleActionRegistry({
  cwd = process.cwd(),
  registryPath = DEFAULT_IRREVERSIBLE_ACTION_REGISTRY_PATH,
  overlayPath = null,
} = {}) {
  const resolvedRegistryPath = isAbsolute(registryPath) ? registryPath : resolve(cwd, registryPath);
  const builtIn = validateIrreversibleActionRegistry(parseJson(resolvedRegistryPath, "irreversible action registry"), {
    requireBuiltins: true,
    source: "built-in registry",
  });
  const resolvedOverlayPath = overlayPath === false
    ? null
    : (overlayPath
      ? (isAbsolute(overlayPath) ? overlayPath : resolve(cwd, overlayPath))
      : resolve(cwd, builtIn.overlay_path));
  if (!resolvedOverlayPath || !existsSync(resolvedOverlayPath)) {
    return {
      ...builtIn,
      config_sources: [resolvedRegistryPath],
      overlay_applied: false,
    };
  }
  const overlay = parseJson(resolvedOverlayPath, "irreversible action project overlay");
  for (const key of Object.keys(overlay)) {
    if (!OVERLAY_FIELDS.has(key)) throw new Error(`unsupported overlay field ${key}; project policy is additive-only`);
  }
  if (overlay.version !== 1) throw new Error("irreversible action project overlay version must be 1");
  const extension = validateIrreversibleActionRegistry(overlay, {
    requireBuiltins: false,
    source: "project overlay",
  });
  const mergedClasses = [...builtIn.action_classes, ...extension.action_classes];
  mergeClasses(mergedClasses);
  return {
    ...builtIn,
    action_classes: mergedClasses,
    config_sources: [resolvedRegistryPath, resolvedOverlayPath],
    overlay_applied: true,
  };
}

export function resolveIrreversibleActionClass(registry, value) {
  const key = normalizeKey(value);
  if (!key) return null;
  return registry.action_classes.find((entry) => entry.aliases.some((alias) => normalizeKey(alias) === key)) || null;
}

function normalizeConfirmationText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBoundedAffirmative(value, policy) {
  if (policy !== BOUNDED_AFFIRMATIVE_POLICY) return false;
  return BOUNDED_AFFIRMATIVES.has(normalizeConfirmationText(value));
}

function baseVerdict({ registry, actionClass, request, mode }) {
  return {
    contract_version: registry.version,
    status: "BLOCKED",
    ok: false,
    execution_authorized: false,
    action_class: actionClass?.id || null,
    action_label: actionClass?.label || null,
    requested_action_class: String(request?.action_class || ""),
    mode,
    target: typeof request?.target === "string" ? request.target.trim() : null,
    payload_ref: typeof request?.payload_ref === "string" ? request.payload_ref.trim() : null,
    reasons: [],
    receipt: null,
    required_human_action: actionClass
      ? `Review the exact ${actionClass.id} target and payload, then type a fresh direct, unambiguous confirmation. The confirmation must be bound to this unchanged action envelope; generated, inferred, delegated, conditional, draft, or stale wording never authorizes execution.`
      : "Choose one declared irreversible action class; unknown classes are blocked.",
    persona_obligations: [...(registry.persona_obligations || [])],
    config_sources: [...(registry.config_sources || [])],
    state_mutated: false,
    external_action_performed: false,
  };
}

export function evaluateIrreversibleAction({ registry, request = {}, now = new Date().toISOString() } = {}) {
  const safeRequest = request && typeof request === "object" && !Array.isArray(request) ? request : {};
  const actionClass = resolveIrreversibleActionClass(registry, safeRequest.action_class);
  const mode = normalizeKey(safeRequest.mode);
  const verdict = baseVerdict({ registry, actionClass, request: safeRequest, mode });
  if (!actionClass) {
    verdict.reasons.push({ code: "action_class_unknown", detail: "Requested action class is not declared." });
    return verdict;
  }
  if (!registry.supported_modes.includes(mode)) {
    verdict.reasons.push({ code: "mode_unknown", detail: `Mode must be one of ${registry.supported_modes.join(", ")}.` });
    return verdict;
  }
  for (const field of actionClass.required_fields) {
    if (typeof safeRequest[field] !== "string" || !safeRequest[field].trim()) {
      verdict.reasons.push({ code: `${field}_missing`, detail: `${field} is required for ${actionClass.id}.` });
    }
  }
  if (verdict.reasons.length > 0) return verdict;
  if (registry.preview_modes.includes(mode)) {
    verdict.status = "PREVIEW_ALLOWED";
    verdict.ok = true;
    verdict.required_human_action = "Preview work may proceed, but a separate execute check with a fresh direct-user confirmation bound to the unchanged action envelope is still required for live action.";
    return verdict;
  }

  const confirmation = safeRequest.confirmation;
  if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)) {
    verdict.reasons.push({ code: "confirmation_missing", detail: "Execute mode requires a recorded confirmation object." });
    return verdict;
  }
  if (typeof confirmation.text !== "string" || !confirmation.text.trim()) {
    verdict.reasons.push({ code: "confirmation_text_missing", detail: "Direct confirmation text is required." });
  } else if (!isBoundedAffirmative(confirmation.text, registry.confirmation.intent_policy)) {
    verdict.reasons.push({
      code: "confirmation_not_unambiguous_affirmative",
      detail: "Confirmation must be one complete, direct, unconditional affirmative with no draft, preview, delay, or delegated qualifier.",
    });
  }
  if (confirmation.source !== registry.confirmation.required_source) {
    verdict.reasons.push({ code: "confirmation_source_invalid", detail: "Confirmation source must be direct_user_input." });
  }
  if (confirmation.generated === true) {
    verdict.reasons.push({ code: "confirmation_generated", detail: "Generated or automated confirmation is forbidden." });
  } else if (confirmation.generated !== false) {
    verdict.reasons.push({ code: "confirmation_generated_flag_missing", detail: "Confirmation must explicitly record generated=false." });
  }
  if (confirmation.delegated === true) {
    verdict.reasons.push({ code: "confirmation_delegated", detail: "Delegated confirmation is forbidden." });
  } else if (confirmation.delegated !== false) {
    verdict.reasons.push({ code: "confirmation_delegated_flag_missing", detail: "Confirmation must explicitly record delegated=false." });
  }
  if (typeof confirmation.actor !== "string" || !confirmation.actor.trim()) {
    verdict.reasons.push({ code: "confirmation_actor_missing", detail: "Confirmation actor is required." });
  }
  const confirmationActionClass = resolveIrreversibleActionClass(registry, confirmation.action_class);
  if (!confirmationActionClass) {
    verdict.reasons.push({ code: "confirmation_action_class_missing", detail: "Confirmation must name a declared action class." });
  } else if (confirmationActionClass.id !== actionClass.id) {
    verdict.reasons.push({
      code: "confirmation_action_class_mismatch",
      detail: "Confirmation action class does not match the displayed execution request.",
    });
  }
  if (typeof confirmation.target !== "string" || !confirmation.target.trim()) {
    verdict.reasons.push({ code: "confirmation_target_missing", detail: "Confirmation target is required." });
  } else if (confirmation.target.trim() !== safeRequest.target.trim()) {
    verdict.reasons.push({
      code: "confirmation_target_mismatch",
      detail: "Confirmation target does not match the displayed execution request.",
    });
  }
  if (typeof confirmation.payload_ref !== "string" || !confirmation.payload_ref.trim()) {
    verdict.reasons.push({ code: "confirmation_payload_ref_missing", detail: "Confirmation payload_ref is required." });
  } else if (confirmation.payload_ref.trim() !== safeRequest.payload_ref.trim()) {
    verdict.reasons.push({
      code: "confirmation_payload_ref_mismatch",
      detail: "Confirmation payload_ref does not match the displayed execution request.",
    });
  }
  const recordedAtMs = Date.parse(confirmation.recorded_at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(recordedAtMs) || !Number.isFinite(nowMs)) {
    verdict.reasons.push({ code: "confirmation_timestamp_invalid", detail: "Confirmation and evaluation timestamps must be valid ISO timestamps." });
  } else {
    const ageSeconds = (nowMs - recordedAtMs) / 1000;
    if (ageSeconds > registry.confirmation.max_age_seconds) {
      verdict.reasons.push({ code: "confirmation_stale", detail: "Confirmation is older than the configured execution window." });
    }
    if (ageSeconds < -registry.confirmation.max_future_skew_seconds) {
      verdict.reasons.push({ code: "confirmation_from_future", detail: "Confirmation timestamp is too far in the future." });
    }
  }
  if (verdict.reasons.length > 0) return verdict;

  const textHash = sha256(confirmation.text);
  const receiptEnvelope = {
    contract_version: registry.version,
    action_class: actionClass.id,
    mode,
    target: safeRequest.target.trim(),
    payload_ref: safeRequest.payload_ref.trim(),
    actor: confirmation.actor.trim(),
    confirmation_source: confirmation.source,
    confirmation_recorded_at: new Date(recordedAtMs).toISOString(),
    confirmation_generated: false,
    confirmation_delegated: false,
    confirmation_intent_policy: registry.confirmation.intent_policy,
    confirmation_text_sha256: textHash,
  };
  const envelopeHash = sha256(stableJson(receiptEnvelope));
  verdict.status = "AUTHORIZED";
  verdict.ok = true;
  verdict.execution_authorized = true;
  verdict.required_human_action = null;
  verdict.receipt = {
    id: `ira_${envelopeHash.slice(0, 24)}`,
    ...receiptEnvelope,
    envelope_sha256: envelopeHash,
  };
  return verdict;
}

function normalizedIntentText(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function intentPhraseMatches(normalized, phrase) {
  const normalizedPhrase = normalizedIntentText(phrase);
  const orderedWordPairs = new Set(["send email", "send message", "email customer", "message customer"]);
  if (orderedWordPairs.has(normalizedPhrase)) {
    const [first, second] = normalizedPhrase.split(" ");
    return new RegExp(`\\b${escapeRegExp(first)}(?: [a-z0-9.]+){0,3} ${escapeRegExp(second)}\\b`).test(normalized);
  }
  return ` ${normalized} `.includes(` ${normalizedPhrase} `);
}

export function detectIrreversibleActionIntent(text, { registry = null, cwd = process.cwd() } = {}) {
  const raw = String(text || "").trim();
  const normalized = normalizedIntentText(raw);
  const noAction = /\bno external action\b|\bdo not perform any external action\b|\bwithout (sending|publishing|deploying|paying|deleting)\b|\bdo not (send|publish|deploy|pay|charge|delete|execute)\b/.test(normalized);
  const safetyImplementation = /\b(implement|add|build|test|code|fix|refactor|document)\b/.test(normalized)
    && /\b(confirmation|irreversible|external action|registry|gate|guard|safety|planner)\b/.test(normalized);
  const previewOnly = /^\s*(draft|prepare|write|preview)\b/.test(normalized)
    || /\b(dry run|dryrun|preview only)\b/.test(normalized);
  const explicitLiveContinuation = /\b(?:then|and|also)\s+(?:send|publish|deploy|pay|charge|refund|transfer|delete|remove|close)\b/.test(normalized)
    || /\b(?:send|publish|deploy|pay|charge|refund|transfer|delete|remove|close)\b.{0,80}\b(?:now|immediately)\b/.test(normalized);
  if (noAction || ((safetyImplementation || previewOnly) && !explicitLiveContinuation)) {
    return {
      matched: false,
      suppressed: true,
      suppression_reason: noAction ? "explicit_no_external_action" : (safetyImplementation ? "safety_implementation" : "preview_only"),
    };
  }
  const activeRegistry = registry || loadIrreversibleActionRegistry({ cwd });
  for (const actionClass of activeRegistry.action_classes) {
    const matchedPhrase = actionClass.intent_phrases.find((phrase) => intentPhraseMatches(normalized, phrase));
    if (matchedPhrase) {
      return {
        matched: true,
        suppressed: false,
        action_class: actionClass.id,
        action_label: actionClass.label,
        matched_phrase: matchedPhrase,
        execution_authorized: false,
      };
    }
  }
  return { matched: false, suppressed: false, suppression_reason: null };
}
