#!/usr/bin/env node
// @planner:module = irreversible_action_contract_test
// @planner:capability = verifies_operator_gated_irreversible_actions
// @planner:story = US-094
// @planner:proves = crit:AC-US-094-001, crit:AC-US-094-002, crit:AC-US-094-003, crit:AC-US-094-004, crit:AC-US-094-005, crit:AC-US-094-006, crit:AC-US-094-007

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateIrreversibleAction,
  loadIrreversibleActionRegistry,
  resolveIrreversibleActionClass,
  validateIrreversibleActionRegistry,
} from "../scripts/lib/irreversible_action_contract.mjs";
import { computeTriage } from "../scripts/lib/triage.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const CLI = join(skillDir, "scripts", "irreversible_action_gate.mjs");
const REGISTRY = join(skillDir, "config", "irreversible_action_registry.json");
const SCHEMA = join(skillDir, "config", "irreversible_action_registry.schema.json");
const NOW = "2026-07-16T22:00:00.000Z";
const RECORDED_AT = "2026-07-16T21:55:00.000Z";
const DIRECT_CONFIRMATION_TEXT = "Ok, let's do it";
const DEFAULT_TARGET = "customer-list:test-fixture";
const DEFAULT_PAYLOAD_REF = "draft:test-fixture-001";

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function confirmation(text, overrides = {}) {
  return {
    text,
    actor: "operator@example.invalid",
    source: "direct_user_input",
    recorded_at: RECORDED_AT,
    generated: false,
    delegated: false,
    action_class: "external_communication",
    target: DEFAULT_TARGET,
    payload_ref: DEFAULT_PAYLOAD_REF,
    ...overrides,
  };
}

function request(overrides = {}) {
  const value = {
    action_class: "send_email",
    mode: "execute",
    target: DEFAULT_TARGET,
    payload_ref: DEFAULT_PAYLOAD_REF,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "confirmation")) {
    value.confirmation = confirmation(DIRECT_CONFIRMATION_TEXT, {
      action_class: value.action_class,
      target: value.target,
      payload_ref: value.payload_ref,
    });
  }
  return value;
}

function killPromoteRequest(overrides = {}) {
  const value = {
    action_class: "kill_promote",
    mode: "execute",
    target: "research-route:test-charter:killed_hypothesis",
    payload_ref: `route-artifacts:sha256:${"c".repeat(64)}`,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "confirmation")) {
    value.confirmation = confirmation("Yes, proceed", {
      action_class: value.action_class,
      target: value.target,
      payload_ref: value.payload_ref,
    });
  }
  return value;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, "check", ...args, "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, PLANNER_SKIP_SELF_HEAL: "1" },
  });
}

console.log("\nIrreversible Action Contract Tests\n");

const registry = loadIrreversibleActionRegistry({ cwd: repoRoot });
const rawRegistry = JSON.parse(readFileSync(REGISTRY, "utf-8"));
const requiredIds = [
  "external_communication",
  "publish",
  "deploy",
  "spend_payment",
  "delete_remote",
  "kill_promote",
];

assert(registry.version === 1, "seeded registry loads at version 1");
assert(requiredIds.every((id) => registry.action_classes.some((entry) => entry.id === id)), "seeded registry declares all six required action families");
assert(rawRegistry.action_classes.every((entry) => !Object.hasOwn(entry, "confirmation_token")), "built-in registry contains no confirmation tokens");
assert(registry.action_classes.every((entry) => !Object.hasOwn(entry, "confirmation_token")), "normalized built-in classes contain no confirmation tokens");
assert(registry.preview_modes.includes("draft") && registry.preview_modes.includes("dry_run"), "registry declares draft and dry-run as preview modes");
assert(registry.confirmation.intent_policy === "bounded_affirmative_v1", "registry declares one bounded affirmative policy for every class");
assert(registry.confirmation.required_source === "direct_user_input"
  && registry.confirmation.generated_must_be === false
  && registry.confirmation.delegated_must_be === false
  && registry.confirmation.require_context_binding === true,
"registry preserves the permanent direct-human line and envelope binding");
assert(resolveIrreversibleActionClass(registry, "send_email")?.id === "external_communication", "send_email alias resolves to external communication");
assert(resolveIrreversibleActionClass(registry, "payment")?.id === "spend_payment", "payment alias resolves to spend/payment");
assert(resolveIrreversibleActionClass(registry, "delete-remote")?.id === "delete_remote", "hyphenated delete-remote alias resolves canonically");
assert(resolveIrreversibleActionClass(registry, "kill-promote")?.id === "kill_promote", "hyphenated kill-promote alias resolves canonically");

const schema = JSON.parse(readFileSync(SCHEMA, "utf-8"));
assert(schema.$schema?.includes("json-schema") && schema.required.includes("action_classes"), "registry ships a machine-readable JSON schema");
assert(!schema.$defs?.action_class?.required.includes("confirmation_token"), "schema does not require exact tokens");
assert(schema.$defs?.action_class?.properties?.confirmation_token?.deprecated === true, "schema marks the legacy overlay token property deprecated");

const tokenizedBuiltIn = structuredClone(rawRegistry);
tokenizedBuiltIn.action_classes[0].confirmation_token = "LEGACY SEND";
let tokenizedBuiltInBlocked = false;
try {
  validateIrreversibleActionRegistry(tokenizedBuiltIn, { requireBuiltins: true, source: "built-in registry" });
} catch (error) {
  tokenizedBuiltInBlocked = /cannot declare confirmation_token/i.test(error.message);
}
assert(tokenizedBuiltInBlocked, "built-in validation rejects reintroduced token values");

for (const mode of ["draft", "dry_run"]) {
  const verdict = evaluateIrreversibleAction({ registry, request: request({ mode }), now: NOW });
  assert(verdict.status === "PREVIEW_ALLOWED", `${mode} remains available as preview work`);
  assert(verdict.execution_authorized === false && verdict.receipt === null, `${mode} never authorizes execution or mints an execution receipt`);
  assert(!Object.hasOwn(verdict, "required_confirmation_token"), `${mode} verdict has no token presentation field`);
}

const softPhrase = evaluateIrreversibleAction({
  registry,
  request: request({ confirmation: confirmation("proceed with draft") }),
  now: NOW,
});
assert(softPhrase.status === "BLOCKED" && softPhrase.execution_authorized === false, "exact negative `proceed with draft` is blocked");
assert(softPhrase.reasons.some((entry) => entry.code === "confirmation_not_unambiguous_affirmative"), "soft-phrase block names the affirmative-policy failure");

const missingConfirmation = evaluateIrreversibleAction({ registry, request: request({ confirmation: undefined }), now: NOW });
assert(missingConfirmation.status === "BLOCKED" && missingConfirmation.reasons.some((entry) => entry.code === "confirmation_missing"), "missing confirmation blocks execute mode");
assert(!JSON.stringify(missingConfirmation).includes(DIRECT_CONFIRMATION_TEXT), "blocked verdict never echoes confirmation text");
assert(!Object.hasOwn(missingConfirmation, "required_confirmation_token"), "blocked verdict has no token presentation field");

const generated = evaluateIrreversibleAction({
  registry,
  request: request({ confirmation: confirmation(DIRECT_CONFIRMATION_TEXT, { generated: true }) }),
  now: NOW,
});
assert(generated.status === "BLOCKED" && generated.reasons.some((entry) => entry.code === "confirmation_generated"), "generated confirmation is rejected even with affirmative text");

const automated = evaluateIrreversibleAction({
  registry,
  request: request({ confirmation: confirmation(DIRECT_CONFIRMATION_TEXT, { source: "automation" }) }),
  now: NOW,
});
assert(automated.status === "BLOCKED" && automated.reasons.some((entry) => entry.code === "confirmation_source_invalid"), "non-user confirmation source is rejected");

const missingActor = evaluateIrreversibleAction({
  registry,
  request: request({ confirmation: confirmation(DIRECT_CONFIRMATION_TEXT, { actor: "" }) }),
  now: NOW,
});
assert(missingActor.status === "BLOCKED" && missingActor.reasons.some((entry) => entry.code === "confirmation_actor_missing"), "blank actor is rejected");

const stale = evaluateIrreversibleAction({
  registry,
  request: request({ confirmation: confirmation(DIRECT_CONFIRMATION_TEXT, { recorded_at: "2026-07-16T20:00:00.000Z" }) }),
  now: NOW,
});
assert(stale.status === "BLOCKED" && stale.reasons.some((entry) => entry.code === "confirmation_stale"), "stale confirmation record is rejected");

const wrongClass = evaluateIrreversibleAction({
  registry,
  request: request({ action_class: "deploy", confirmation: confirmation(DIRECT_CONFIRMATION_TEXT) }),
  now: NOW,
});
assert(wrongClass.status === "BLOCKED" && wrongClass.reasons.some((entry) => entry.code === "confirmation_action_class_mismatch"), "confirmation for one class cannot authorize another class");

for (const text of ["yes", "Yes, please", "go ahead", "Please proceed", "ok let's do it", "I confirm", "I approve"]) {
  const direct = evaluateIrreversibleAction({
    registry,
    request: request({ confirmation: confirmation(text) }),
    now: NOW,
  });
  assert(direct.status === "AUTHORIZED", `bounded affirmative authorizes: ${text}`);
}

for (const text of ["no", "maybe", "yes if safe", "ok but wait", "proceed with draft", "my manager said yes", "do it later", "preview it"]) {
  const rejected = evaluateIrreversibleAction({
    registry,
    request: request({ confirmation: confirmation(text) }),
    now: NOW,
  });
  assert(rejected.status === "BLOCKED"
    && rejected.reasons.some((entry) => entry.code === "confirmation_not_unambiguous_affirmative"),
  `bounded grammar rejects non-authorizing text: ${text}`);
}

const delegated = evaluateIrreversibleAction({
  registry,
  request: request({ confirmation: confirmation("Yes", { delegated: true }) }),
  now: NOW,
});
assert(delegated.status === "BLOCKED" && delegated.reasons.some((entry) => entry.code === "confirmation_delegated"), "delegated confirmation is rejected");

const missingDelegated = evaluateIrreversibleAction({
  registry,
  request: request({ confirmation: confirmation("Yes", { delegated: undefined }) }),
  now: NOW,
});
assert(missingDelegated.status === "BLOCKED"
  && missingDelegated.reasons.some((entry) => entry.code === "confirmation_delegated_flag_missing"),
"confirmation must explicitly record delegated=false");

for (const [field, value, reason] of [
  ["target", "customer-list:other", "confirmation_target_mismatch"],
  ["payload_ref", "draft:other", "confirmation_payload_ref_mismatch"],
]) {
  const mismatch = evaluateIrreversibleAction({
    registry,
    request: request({ confirmation: confirmation("Yes", { [field]: value }) }),
    now: NOW,
  });
  assert(mismatch.status === "BLOCKED" && mismatch.reasons.some((entry) => entry.code === reason), `${field} mismatch blocks confirmation reuse`);
}

const authorized = evaluateIrreversibleAction({ registry, request: request(), now: NOW });
const authorizedSerialized = JSON.stringify(authorized);
assert(authorized.status === "AUTHORIZED" && authorized.execution_authorized === true, "fresh direct-user confirmation authorizes the declared action envelope");
assert(authorized.action_class === "external_communication" && authorized.target === request().target, "authorized verdict is bound to canonical class and target");
assert(authorized.receipt?.id?.startsWith("ira_") && /^[a-f0-9]{64}$/.test(authorized.receipt?.confirmation_text_sha256 || ""), "authorized verdict includes a hashed non-secret receipt");
assert(!Object.hasOwn(authorized.receipt || {}, "confirmation_token_sha256"), "receipt exposes no legacy token hash field");
assert(!authorizedSerialized.includes('"text"') && !authorizedSerialized.includes(DIRECT_CONFIRMATION_TEXT), "authorized receipt never echoes plaintext confirmation");
assert(authorized.persona_obligations.includes("wiring_auditor") && authorized.persona_obligations.includes("traceability"), "verdict carries wiring and traceability obligations");

const killPromoteAuthorized = evaluateIrreversibleAction({ registry, request: killPromoteRequest(), now: NOW });
assert(killPromoteAuthorized.status === "AUTHORIZED" && killPromoteAuthorized.action_class === "kill_promote", "direct-user kill_promote fixture authorizes its exact inert route envelope");
assert(!JSON.stringify(killPromoteAuthorized).includes("Yes, proceed"), "kill_promote authorization returns only hash-bound confirmation evidence");

const killPromoteGenerated = evaluateIrreversibleAction({
  registry,
  request: killPromoteRequest({ confirmation: confirmation("Yes", {
    generated: true,
    action_class: "kill_promote",
    target: "research-route:test-charter:killed_hypothesis",
    payload_ref: `route-artifacts:sha256:${"c".repeat(64)}`,
  }) }),
  now: NOW,
});
assert(killPromoteGenerated.status === "BLOCKED" && killPromoteGenerated.reasons.some((entry) => entry.code === "confirmation_generated"), "generated kill_promote confirmation rejects");

const killPromoteInferred = evaluateIrreversibleAction({
  registry,
  request: killPromoteRequest({ confirmation: confirmation("Yes", {
    source: "inferred",
    action_class: "kill_promote",
    target: "research-route:test-charter:killed_hypothesis",
    payload_ref: `route-artifacts:sha256:${"c".repeat(64)}`,
  }) }),
  now: NOW,
});
assert(killPromoteInferred.status === "BLOCKED" && killPromoteInferred.reasons.some((entry) => entry.code === "confirmation_source_invalid"), "inferred kill_promote confirmation rejects");

const killPromoteStale = evaluateIrreversibleAction({
  registry,
  request: killPromoteRequest({ confirmation: confirmation("Yes", {
    recorded_at: "2026-07-16T20:00:00.000Z",
    action_class: "kill_promote",
    target: "research-route:test-charter:killed_hypothesis",
    payload_ref: `route-artifacts:sha256:${"c".repeat(64)}`,
  }) }),
  now: NOW,
});
assert(killPromoteStale.status === "BLOCKED" && killPromoteStale.reasons.some((entry) => entry.code === "confirmation_stale"), "stale kill_promote confirmation rejects");

const unknown = evaluateIrreversibleAction({ registry, request: request({ action_class: "launch_missiles" }), now: NOW });
assert(unknown.status === "BLOCKED" && unknown.reasons.some((entry) => entry.code === "action_class_unknown"), "unknown action class fails closed");

const nullRequest = evaluateIrreversibleAction({ registry, request: null, now: NOW });
assert(nullRequest.status === "BLOCKED" && nullRequest.reasons.some((entry) => entry.code === "action_class_unknown"), "null request fails closed instead of throwing");

const overlayRoot = mkdtempSync(join(tmpdir(), "irreversible-action-overlay-"));
try {
  writeJson(join(overlayRoot, "planner.irreversible-actions.json"), {
    version: 1,
    action_classes: [
      {
        id: "rotate_external_key",
        label: "Rotate an external key",
        aliases: ["rotate_external_key", "rotate-key"],
        intent_phrases: ["rotate external key"],
        confirmation_token: "LEGACY ROTATE KEY",
        required_fields: ["target", "payload_ref"],
      },
    ],
  });
  const extended = loadIrreversibleActionRegistry({ cwd: overlayRoot });
  assert(extended.action_classes.length === registry.action_classes.length + 1, "valid unique project class extends the seeded registry");
  assert(resolveIrreversibleActionClass(extended, "rotate-key")?.id === "rotate_external_key", "valid project alias resolves through the shared registry");
  assert(!Object.hasOwn(resolveIrreversibleActionClass(extended, "rotate-key"), "confirmation_token"), "legacy overlay token is accepted but discarded from normalized runtime state");

  writeJson(join(overlayRoot, "planner.irreversible-actions.json"), {
    version: 1,
    action_classes: [
      {
        id: "shadow_publish",
        label: "Shadow publish",
        aliases: ["publish"],
        intent_phrases: ["shadow publish"],
        required_fields: ["target", "payload_ref"],
      },
    ],
  });
  let duplicateAliasBlocked = false;
  try {
    loadIrreversibleActionRegistry({ cwd: overlayRoot });
  } catch (error) {
    duplicateAliasBlocked = /duplicate alias/i.test(error.message);
  }
  assert(duplicateAliasBlocked, "project overlay cannot shadow a built-in alias");

  writeJson(join(overlayRoot, "planner.irreversible-actions.json"), {
    version: 1,
    action_classes: [
      {
        id: "malformed_action",
        label: "Malformed action",
        aliases: ["malformed_action"],
        intent_phrases: ["malformed action"],
        confirmation_policy: "always_allow",
        required_fields: ["target", "payload_ref"],
      },
    ],
  });
  let malformedFieldBlocked = false;
  try {
    loadIrreversibleActionRegistry({ cwd: overlayRoot });
  } catch (error) {
    malformedFieldBlocked = /unsupported field/i.test(error.message);
  }
  assert(malformedFieldBlocked, "project overlay cannot replace the shared confirmation policy");

  writeJson(join(overlayRoot, "planner.irreversible-actions.json"), {
    version: 1,
    confirmation: { required_source: "automation" },
    action_classes: [],
  });
  let weakeningFieldBlocked = false;
  try {
    loadIrreversibleActionRegistry({ cwd: overlayRoot });
  } catch (error) {
    weakeningFieldBlocked = /unsupported overlay field/i.test(error.message);
  }
  assert(weakeningFieldBlocked, "project overlay cannot replace global human-confirmation rules");
} finally {
  rmSync(overlayRoot, { recursive: true, force: true });
}

const liveTriage = computeTriage({ goalText: "Send the customer email now" });
assert(liveTriage.operator_action === "ask_user" && liveTriage.irreversible_action?.action_class === "external_communication", "triage asks before live communication using registry vocabulary");
assert(liveTriage.irreversible_action?.execution_authorized === false, "triage explicitly carries no execution authority");
assert(!Object.hasOwn(liveTriage.irreversible_action || {}, "confirmation_token"), "triage intent result has no token presentation field");
assert(/type a fresh direct confirmation/i.test(liveTriage.operator_question || ""), "triage asks for ordinary fresh direct confirmation");
assert(!/confirmation token/i.test(liveTriage.operator_question || ""), "triage does not ask the user for a token");

const publishTriage = computeTriage({ goalText: "Publish the release to the live marketplace" });
assert(publishTriage.operator_action === "ask_user" && publishTriage.irreversible_action?.action_class === "publish", "triage recognizes publish intent from the registry");

const spacedCommunicationTriage = computeTriage({ goalText: "Send a marketing email to the customer now" });
assert(spacedCommunicationTriage.operator_action === "ask_user" && spacedCommunicationTriage.irreversible_action?.action_class === "external_communication", "triage recognizes modifiers between send and email");

const codeOnlyTriage = computeTriage({
  goalText: "Implement and test an irreversible-action confirmation registry; do not perform any external action",
  plannedFiles: [".agent/skills/iterative-planner/scripts/lib/irreversible_action_contract.mjs"],
});
assert(codeOnlyTriage.operator_action !== "ask_user", "local safety implementation with explicit no-action boundary is not mistaken for live execution");

const exactSessionRegression = computeTriage({
  goalText: "Remove token confirmation for all irreversible actions so the human can simply type confirmation; do not perform any external action",
  plannedFiles: [".agent/skills/iterative-planner/scripts/lib/irreversible_action_contract.mjs"],
});
assert(exactSessionRegression.operator_action !== "ask_user", "code-only token-removal request is suppressed before destructive ambiguity routing");

const previewTriage = computeTriage({ goalText: "Draft an email for review, but do not send it" });
assert(previewTriage.operator_action !== "ask_user", "preview-only communication does not request live execution authorization");

const mixedPreviewTriage = computeTriage({ goalText: "Draft the email, then send the customer email now" });
assert(mixedPreviewTriage.operator_action === "ask_user" && mixedPreviewTriage.irreversible_action?.action_class === "external_communication", "mixed preview-then-send intent cannot hide the live action");

const mixedImplementationTriage = computeTriage({ goalText: "Implement the confirmation registry, then publish the release now" });
assert(mixedImplementationTriage.operator_action === "ask_user" && mixedImplementationTriage.irreversible_action?.action_class === "publish", "mixed implementation-then-publish intent cannot hide the live action");

const cliTimestamp = new Date().toISOString();
const commonCli = [
  "--action-class", "send_email",
  "--mode", "execute",
  "--target", "customer-list:test-fixture",
  "--payload-ref", "draft:test-fixture-001",
  "--confirmation-actor", "operator@example.invalid",
  "--confirmation-source", "direct_user_input",
  "--confirmation-recorded-at", cliTimestamp,
  "--confirmation-generated", "false",
  "--confirmation-delegated", "false",
  "--confirmation-action-class", "external_communication",
  "--confirmation-target", "customer-list:test-fixture",
  "--confirmation-payload-ref", "draft:test-fixture-001",
];

const blockedCli = runCli([...commonCli, "--confirmation-text", "proceed with draft"]);
const blockedCliJson = JSON.parse(blockedCli.stdout || "{}");
assert(blockedCli.status === 1 && blockedCliJson.status === "BLOCKED", "CLI negative control exits non-zero and remains blocked");
assert(blockedCliJson.execution_authorized === false, "CLI negative control cannot authorize execution");
assert(!blockedCli.stdout.includes(DIRECT_CONFIRMATION_TEXT), "CLI blocked JSON never echoes unrelated confirmation text");
assert(!Object.hasOwn(blockedCliJson, "required_confirmation_token"), "CLI blocked JSON has no token presentation field");

const authorizedCli = runCli([...commonCli, "--confirmation-text", DIRECT_CONFIRMATION_TEXT]);
const authorizedCliJson = JSON.parse(authorizedCli.stdout || "{}");
assert(authorizedCli.status === 0 && authorizedCliJson.status === "AUTHORIZED", "CLI direct-confirmation positive control exits zero with authorization");
assert(!authorizedCli.stdout.includes('"text"') && !authorizedCli.stdout.includes(DIRECT_CONFIRMATION_TEXT), "CLI positive receipt does not replay plaintext confirmation");

const previewCli = runCli([
  "--action-class", "deploy",
  "--mode", "dry-run",
  "--target", "environment:test-fixture",
  "--payload-ref", "build:test-fixture-001",
]);
const previewCliJson = JSON.parse(previewCli.stdout || "{}");
assert(previewCli.status === 0 && previewCliJson.status === "PREVIEW_ALLOWED", "CLI dry-run remains available without confirmation");
assert(previewCliJson.execution_authorized === false, "CLI dry-run never reports execution authorization");
assert(!Object.hasOwn(previewCliJson, "required_confirmation_token"), "CLI preview JSON has no token presentation field");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
