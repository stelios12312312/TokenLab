#!/usr/bin/env node
// test_learned_obligations_schema.mjs
// Schema coverage for learned-obligation execution-script metadata.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  readLearnedObligationRegistryEntries,
  validateLearnedObligationOverlayDocument,
} from "../scripts/lib/learned_obligations.mjs";
import {
  countWords,
  hasSection,
  validateAcceptanceCheck,
} from "../scripts/lib/acceptance_predicates.mjs";
import {
  loadPersonaObligationRules,
} from "../scripts/lib/persona_adaptation.mjs";

let passed = 0;
let failed = 0;
let overlayCounter = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function scenarioRegistryBackwardCompatibility() {
  const tmp = mkdtempSync(join(tmpdir(), "learned-obligations-schema-"));
  try {
    const registryPath = join(tmp, "learned_obligations.json");
    writeJson(registryPath, {
      version: 1,
      obligations: [
        {
          id: "responsive_ui_mobile",
          source_mistake: "M-UI-001",
          subject_id: "plan:responsive-ui-mobile",
          verification_mode: "manual_observation",
          guard_types: ["mobile_responsiveness"],
          required_by_phase: "reflect",
        },
        {
          id: "execution_script_artifact",
          subject_id: "plan:execution-script",
          verification_mode: "artifact_review",
          template_path: "templates/personas/execution_script.md",
          required_sections: ["Schema definition", "Emit + verify contract"],
          acceptance_checks: [
            "has_section(Schema definition)",
            { predicate: "min_word_count", count: 50 },
          ],
          decisions: [
            "template_source",
            { id: "acceptance_predicate_scope", prompt: "Which predicates are active?" },
          ],
          inputs: ["intent_contract.json", { id: "learned_obligations", path: "config/learned_obligations.json" }],
          pre_resolved: { severity: "warn_then_fail" },
          personas: ["traceability", "config_integrity"],
        },
      ],
    });

    const { obligations } = readLearnedObligationRegistryEntries({ registryPath });
    const oldEntry = obligations.find((entry) => entry.id === "responsive_ui_mobile");
    const newEntry = obligations.find((entry) => entry.id === "execution_script_artifact");

    assert(oldEntry?.template_path === null, "old learned-obligation entries remain valid without template_path");
    assert(Array.isArray(oldEntry?.required_sections) && oldEntry.required_sections.length === 0, "old entries receive empty required_sections");
    assert(Array.isArray(oldEntry?.acceptance_checks) && oldEntry.acceptance_checks.length === 0, "old entries receive empty acceptance_checks");
    assert(newEntry?.template_path === "templates/personas/execution_script.md", "new entries preserve template_path");
    assert(newEntry?.required_sections?.includes("Schema definition"), "new entries preserve required_sections");
    assert(newEntry?.acceptance_checks?.length === 2, "new entries normalize supported acceptance checks");
    assert(newEntry?.decisions?.some((slot) => slot.id === "acceptance_predicate_scope"), "new entries normalize object decision slots");
    assert(newEntry?.inputs?.length === 2, "new entries preserve input refs");
    assert(newEntry?.pre_resolved?.severity === "warn_then_fail", "new entries preserve pre_resolved object");
    assert(newEntry?.personas?.includes("config_integrity"), "new entries normalize persona ids");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function overlayWith(entry) {
  const tmp = mkdtempSync(join(tmpdir(), "learned-obligations-overlay-"));
  const overlayPath = join(tmp, "planner.learned_obligations.json");
  writeJson(overlayPath, {
    version: 1,
    obligations: [entry],
  });
  return { tmp, overlayPath };
}

function assertOverlayError(entry, expectedError, label) {
  const { tmp, overlayPath } = overlayWith(entry);
  try {
    const result = validateLearnedObligationOverlayDocument({
      overlayPath,
      baseIds: new Set(["responsive_ui_mobile"]),
    });
    assert(result.usable === false && result.error === expectedError, label);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function validOverlayBase(extra = {}) {
  overlayCounter += 1;
  return {
    id: `host_obligation_${overlayCounter}`,
    subject_id: "plan:host-obligation",
    verification_mode: "artifact_review",
    status: "approved",
    ...extra,
  };
}

function scenarioOverlayValidation() {
  const valid = overlayWith(validOverlayBase({
    template_path: "templates/personas/host.md",
    acceptance_checks: ["has_section(Summary)", { predicate: "regex_match", pattern: "PASS" }],
    decisions: ["proof_scope", { key: "reviewer" }],
    personas: ["traceability", "wiring_auditor"],
  }));
  try {
    const result = validateLearnedObligationOverlayDocument({
      overlayPath: valid.overlayPath,
      baseIds: new Set(["responsive_ui_mobile"]),
    });
    assert(result.usable === true, "valid overlay accepts new learned-obligation schema fields");
    assert(result.active_entries[0]?.acceptance_checks?.length === 2, "valid overlay normalizes acceptance checks");
    assert(result.active_entries[0]?.decisions?.length === 2, "valid overlay normalizes decision slots");
  } finally {
    try { rmSync(valid.tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  assertOverlayError(validOverlayBase({ template_path: "../escape.md" }), "invalid_template_path", "overlay rejects template_path traversal");
  assertOverlayError(validOverlayBase({ acceptance_checks: ["unknown_predicate(x)"] }), "invalid_acceptance_predicate", "overlay rejects unknown acceptance predicates");
  assertOverlayError(validOverlayBase({ decisions: [{}] }), "invalid_decision_slot", "overlay rejects malformed decision slots");
  assertOverlayError(validOverlayBase({ personas: ["not_a_persona"] }), "unknown_persona", "overlay rejects unknown persona ids");
}

function scenarioAcceptancePredicateLibrary() {
  assert(validateAcceptanceCheck("has_section(Proof of Work)").valid, "string predicate has_section validates");
  assert(validateAcceptanceCheck({ predicate: "numeric_range", min: 0, max: 1 }).valid, "object predicate numeric_range validates");
  assert(validateAcceptanceCheck({ predicate: "regex_match", pattern: "[" }).valid === false, "regex_match rejects invalid regex");
  assert(hasSection("# Title\n\n## Proof of Work\nDone\n", "Proof of Work"), "hasSection detects markdown headings");
  assert(countWords("one two\nthree") === 3, "countWords counts simple word tokens");
}

function scenarioPersonaObligationsConfig() {
  const rules = loadPersonaObligationRules();
  assert(rules.planner_infra?.seed_roles?.includes("config_integrity"), "persona_obligations config exposes planner_infra seed roles");
  assert(rules.quant_betting?.expected_companions?.includes("quant_target"), "persona_obligations config preserves quant_betting companions");
  assert(rules.tokenomics?.seed_roles?.includes("tokenomics"), "persona_obligations config exposes tokenomics seed role");
  assert(rules.tokenomics?.expected_companions?.includes("traceability"), "persona_obligations config preserves tokenomics companions");

  const validProfileId = overlayWith(validOverlayBase({
    personas: ["tokenomics"],
  }));
  try {
    const result = validateLearnedObligationOverlayDocument({
      overlayPath: validProfileId.overlayPath,
      baseIds: new Set(["responsive_ui_mobile"]),
    });
    assert(result.usable === true, "learned-obligation personas accept tokenomics ids from persona_obligations config");
  } finally {
    try { rmSync(validProfileId.tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

scenarioRegistryBackwardCompatibility();
scenarioOverlayValidation();
scenarioAcceptancePredicateLibrary();
scenarioPersonaObligationsConfig();

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
