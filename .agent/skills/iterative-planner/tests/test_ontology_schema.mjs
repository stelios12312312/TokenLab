#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import {
  buildEmptyOntologyDocument,
  getOntologyFactPath,
  getOntologySchemaPath,
  loadOntologyDocuments,
  ONTOLOGY_ENTITY_CLASSES,
  renderOntologyDocument,
  validateOntologyDocument,
} from "../scripts/lib/ontology_schema.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function writeOntologyFact(tmp, entityClass, document) {
  const filePath = getOntologyFactPath(entityClass, tmp);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderOntologyDocument(document));
}

function scenarioSchemaFilesExistAndDescribeEntityContracts() {
  for (const entityClass of ONTOLOGY_ENTITY_CLASSES) {
    const schemaPath = getOntologySchemaPath(entityClass, plannerRoot);
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    const rootKey = entityClass;

    assert(schema.$schema === "https://json-schema.org/draft/2020-12/schema", `${entityClass} schema declares JSON Schema draft`);
    assert(schema.required.includes(rootKey), `${entityClass} schema requires the ${rootKey} root key`);
    assert(schema.properties?.[rootKey]?.properties?.version?.const === 1, `${entityClass} schema pins version 1`);
  }
}

function scenarioOntologySchemasAcceptStarterFacts() {
  const loaded = loadOntologyDocuments({ cwd: plannerRoot, allowMissing: false });
  assert(loaded.ok, "starter ontology documents load cleanly from the repo");
  assert(loaded.documents.every((entry) => entry.present === true), "starter ontology documents are present for all six classes");

  for (const entityClass of ONTOLOGY_ENTITY_CLASSES) {
    const actual = JSON.parse(readFileSync(getOntologyFactPath(entityClass, plannerRoot), "utf-8"));
    const validation = validateOntologyDocument(entityClass, actual);
    assert(validation.ok, `${entityClass} repo fact document validates after induction`);
    assert(actual?.[entityClass]?.version === 1, `${entityClass} repo fact document keeps ontology version 1`);
  }

  const proofWeights = JSON.parse(readFileSync(getOntologyFactPath("proof_weights", plannerRoot), "utf-8"));
  assert(Object.keys(proofWeights?.proof_weights?.proof_types || {}).length >= 10, "repo proof weight facts ship starter proof types");
  assert(Object.keys(proofWeights?.proof_weights?.risk_levels || {}).length === 4, "repo proof weight facts ship starter risk thresholds");
  assert(proofWeights?.proof_weights?.domain_defaults?.payment === "critical", "repo proof weight facts keep payment as a critical domain");
  const specification = JSON.parse(readFileSync(getOntologyFactPath("specification", plannerRoot), "utf-8"));
  assert(
    (specification?.specification?.stories || []).some((story) => story.id === "US-099" && story.domain === "payment"),
    "repo specification facts keep the US-099 payment-domain smoke story"
  );
  const conventions = JSON.parse(readFileSync(getOntologyFactPath("conventions", plannerRoot), "utf-8"));
  assert(Array.isArray(conventions?.conventions?.conventions), "repo convention facts expose the conventions collection");
  const activeConventionIds = (conventions?.conventions?.conventions || [])
    .filter((entry) => entry?.status === "active")
    .map((entry) => entry.id);
  assert(activeConventionIds.length >= 3, "repo convention facts include promoted Phase 2.10 active conventions");
  assert(activeConventionIds.includes("CONV-001"), "repo convention facts include the promoted test dirname convention");
  assert(activeConventionIds.includes("CONV-002"), "repo convention facts include the promoted test fileURLToPath convention");
  assert(activeConventionIds.includes("CONV-007"), "repo convention facts include the promoted MCP tool catalog convention");
}

function scenarioEmptyOntologyScaffoldRemainsValidTemplate() {
  for (const entityClass of ONTOLOGY_ENTITY_CLASSES) {
    const scaffold = buildEmptyOntologyDocument(entityClass);
    const validation = validateOntologyDocument(entityClass, scaffold);
    assert(validation.ok, `${entityClass} empty scaffold stays schema-valid`);
  }
}

function scenarioMissingOntologyFilesDegradeSafely() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-ontology-missing-"));
  try {
    const loaded = loadOntologyDocuments({ cwd: tmp, allowMissing: true });
    assert(loaded.ok, "missing ontology files are tolerated when allowMissing=true");
    assert(loaded.missing.length === ONTOLOGY_ENTITY_CLASSES.length, "all ontology classes report missing when the surface is absent");
    assert(loaded.documents.every((entry) => entry.present === false), "missing ontology files stay explicitly absent rather than pretending to load");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioInvalidSpecificationStoryFailsValidation() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-ontology-invalid-"));
  try {
    const invalid = buildEmptyOntologyDocument("specification");
    invalid.specification.stories.push({
      title: "Missing id story",
      status: "NOT_IMPLEMENTED",
      acceptance_criteria: [
        {
          id: "AC-001-1",
          text: "Still missing the story id.",
        },
      ],
    });
    writeOntologyFact(tmp, "specification", invalid);

    const loaded = loadOntologyDocuments({ cwd: tmp, allowMissing: true });
    const specification = loaded.documents.find((entry) => entry.entity_class === "specification");

    assert(specification.ok === false, "invalid specification facts are rejected");
    assert(
      (specification.issues || []).some((issue) => issue.includes("specification.stories[0].id is required")),
      "invalid specification facts name the missing story id"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioInvalidVerificationArtifactTypeFailsValidation() {
  const document = buildEmptyOntologyDocument("verification");
  document.verification.artifacts.push({
    path: "reports/ontology/bad.txt",
    type: "log_dump",
  });

  const validation = validateOntologyDocument("verification", document);
  assert(validation.ok === false, "invalid verification artifact types are rejected");
  assert(
    validation.issues.some((issue) => issue.includes("verification.artifacts[0].type must be one of")),
    "invalid verification artifact types explain the allowed enum"
  );
}

function scenarioInvalidProofWeightsDomainDefaultFailsValidation() {
  const document = buildEmptyOntologyDocument("proof_weights");
  document.proof_weights.proof_types.unit_test = {
    label: "Unit test",
    category: "test",
    base_weight: 2,
  };
  document.proof_weights.risk_levels.low = {
    required_weight: 2,
  };
  document.proof_weights.domain_defaults.planner_core = "unknown_risk";

  const validation = validateOntologyDocument("proof_weights", document);
  assert(validation.ok === false, "proof weight domain defaults must resolve to declared risk levels");
  assert(
    validation.issues.some((issue) => issue.includes("proof_weights.domain_defaults.planner_core must reference a declared proof_weights.risk_levels entry")),
    "proof weight validation explains dangling risk-level references"
  );
}

function scenarioInvalidConventionApplicabilityFailsValidation() {
  const document = buildEmptyOntologyDocument("conventions");
  document.conventions.conventions.push({
    id: "CONV-001",
    title: "Pages use the shared layout",
    status: "active",
    domain: "frontend",
    scope: "pages",
    confidence: 0.95,
    applies_to: {},
    requires: [],
    evidence_type: "static_analysis",
    detected_from: "induction",
  });

  const validation = validateOntologyDocument("conventions", document);
  assert(validation.ok === false, "invalid conventions are rejected");
  assert(
    validation.issues.some((issue) => issue.includes("conventions.conventions[0].applies_to must declare at least one")),
    "invalid conventions explain the missing applicability scope"
  );
  assert(
    validation.issues.some((issue) => issue.includes("conventions.conventions[0].requires must contain at least one requirement")),
    "invalid conventions explain the missing requirements"
  );
}

scenarioSchemaFilesExistAndDescribeEntityContracts();
scenarioOntologySchemasAcceptStarterFacts();
scenarioEmptyOntologyScaffoldRemainsValidTemplate();
scenarioMissingOntologyFilesDegradeSafely();
scenarioInvalidSpecificationStoryFailsValidation();
scenarioInvalidVerificationArtifactTypeFailsValidation();
scenarioInvalidProofWeightsDomainDefaultFailsValidation();
scenarioInvalidConventionApplicabilityFailsValidation();

console.log(`\nOntology schema tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
