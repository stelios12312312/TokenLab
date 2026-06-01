#!/usr/bin/env node

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { induceOntologyDocuments } from "../scripts/ontology_inducer.mjs";
import { validateOntologyDocument } from "../scripts/lib/ontology_schema.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const inducerScript = join(scriptDir, "ontology_inducer.mjs");
const nodeBin = process.execPath;

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

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-ontology-inducer-${name}-`));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writeText(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function runCli(args, cwd) {
  try {
    const stdout = execFileSync(nodeBin, [inducerScript, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function seedStoryRegistry(tmp) {
  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), {
    version: 1,
    stories: [
      {
        id: "US-900",
        title: "Planner ontology context command",
        priority: "HIGH",
        status: "NOT_IMPLEMENTED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/ontology_context.mjs",
          ".agent/skills/iterative-planner/scripts/planner.mjs",
        ],
        test_refs: [
          ".agent/skills/iterative-planner/tests/test_ontology_context.mjs",
        ],
        validation_refs: [
          "reports/test_runs/plan_ontology_context_latest.yaml",
        ],
      },
    ],
  });
}

function seedVerificationStrategy(tmp) {
  writeJson(join(tmp, "plans", "plan_fixture", "verification_strategy.yaml"), {
    verification_strategy: {
      version: 1,
      plan_id: "plan_fixture",
      criteria: [
        {
          id: "CRIT-001",
          criterion: "planner ontology build returns non-empty facts",
          story_id: "US-900",
          implementation: {
            file: ".agent/skills/iterative-planner/scripts/ontology_inducer.mjs",
            lines: "1-200",
            function: null,
          },
          tests: [
            {
              name: "scenarioBuildInducesAllOntologyClasses",
              file: ".agent/skills/iterative-planner/tests/test_ontology_inducer.mjs",
              type: "integration",
            },
          ],
          evidence_artifacts: [
            {
              type: "coverage_report",
              path: "reports/coverage/ontology_inducer.json",
            },
          ],
        },
      ],
    },
  });
  writeJson(join(tmp, "plans", "plan_fixture", "state.json"), {
    state: "EXECUTE",
  });
}

function seedRetros(tmp) {
  writeJson(join(tmp, "plans", "knowledge", "retros", "retro_ledger.json"), {
    version: 1,
    retros: [
      {
        id: "R-2026-04-24-001",
        date: "2026-04-24",
        title: "Verification parser fixes missed mirrored readers",
        summary: "A mirrored reader stayed stale while verification.md changed.",
        failure_modes: ["MISSED_PARITY"],
        affected_surfaces: [
          ".agent/skills/iterative-planner/scripts/lib/fact_loader.mjs",
          ".agent/skills/iterative-planner/scripts/ontology_serializer.mjs",
          "plans/example/verification.md",
        ],
        promotions: {
          mistake_ids: ["M-032"],
        },
        tags: ["planner_core", "verification_artifact", "mirror_readers"],
        case_file: "plans/knowledge/retros/cases/R-2026-04-24-001.md",
        status: "accepted",
      },
    ],
  });
  writeText(
    join(tmp, "plans", "knowledge", "retros", "cases", "R-2026-04-24-001.md"),
    "# Case\n\nThe mirror reader contract for `verification.md` drifted away from `fact_loader.mjs`.\n"
  );
}

function seedDomainChecklist(tmp) {
  writeJson(join(tmp, ".agent", "semantic", "domain_checklists", "planner_core.yaml"), {
    domain: "planner_core",
    execute_checklist: [
      { item: "Planner-core bootstrap or transition edits keep migration smoke in the proof bundle", severity: "HIGH" },
      { item: "Planner-core CLI changes keep ripple-through coverage aligned", severity: "HIGH" },
    ],
  });
}

function seedWorkflowRegistry(tmp) {
  writeJson(join(tmp, ".agent", "skills", "iterative-planner", "config", "workflow_registry.json"), {
    version: 1,
    workflows: [
      {
        id: "/advisor",
        recipe_affinity: "low",
      },
      {
        id: "/safe-change-power",
        recipe_affinity: "low",
      },
    ],
  });
}

function seedKnowledgeFiles(tmp) {
  writeText(join(tmp, "plans", "knowledge", "mistakes.md"), `# Mistakes

## M-032: Shared artifact readers must be inventoried and regression-tested together

The mirror reader for \`verification.md\` and \`fact_loader.mjs\` drifted.
Frequency: 2
`);

  writeText(join(tmp, "plans", "knowledge", "patterns.md"), `# Patterns

## P-090: Preserve parser-reader parity

Use shared parser helpers when a reader contract changes.
`);

  writeText(join(tmp, "plans", "knowledge", "gotchas.md"), `# Gotchas

## G-081: Mirror readers drift quietly

Planner-core parser changes can leave mirror readers stale.
`);
}

function seedAdr(tmp) {
  writeText(
    join(tmp, ".agent", "decisions", "0020-ontology-yaml-source-of-truth.md"),
    "# ADR 0020: Ontology YAML source of truth\n\n## Decision\n\nKeep YAML canonical.\n"
  );
}

function seedProofWeights(tmp, document = null) {
  writeJson(join(tmp, ".agent", "ontology", "facts", "proof_weights.yaml"), document || {
    proof_weights: {
      version: 1,
      proof_types: {
        unit_test: {
          label: "Unit test override",
          category: "test",
          base_weight: 9,
        },
      },
      risk_levels: {
        low: {
          required_weight: 1,
        },
        critical: {
          required_weight: 11,
        },
      },
      domain_defaults: {
        planner_core: "critical",
      },
    },
  });
}

function seedConventions(tmp, document = null) {
  writeJson(join(tmp, ".agent", "ontology", "facts", "conventions.yaml"), document || {
    conventions: {
      version: 1,
      conventions: [
        {
          id: "CONV-900",
          title: "Planner workflow docs stay slash-prefixed",
          status: "active",
          domain: "planner_core",
          scope: "workflows",
          confidence: 1,
          applies_to: {
            file_patterns: [".agent/workflows/*.md"],
            change_classes: ["workflow"],
          },
          requires: [
            { import_contains: "/advisor" },
          ],
          evidence_type: "static_analysis",
          detected_from: "manual",
        },
      ],
    },
  });
}

function scenarioMissingSourcesProduceEmptyValidDocuments() {
  const tmp = makeTemp("empty");
  try {
    const result = induceOntologyDocuments({ cwd: tmp });
    assert(result.ok, "missing sources still produce valid ontology documents");
    assert(result.counts.specification.stories === 0, "missing sources keep story counts at zero");
    assert(result.counts.proof_weights.proof_types > 0, "missing sources bootstrap starter proof weight facts");
    assert(result.counts.conventions.total === 0, "missing sources bootstrap an empty conventions surface");
    assert(
      result.sources.some((source) => source.source === "proof-weights" && source.bootstrapped === true),
      "missing proof weight source is reported as a bootstrapped ontology surface"
    );
    assert(
      result.sources.some((source) => source.source === "conventions" && source.bootstrapped === true),
      "missing conventions source is reported as a bootstrapped ontology surface"
    );
    assert(result.sources.every((source) => source.present === false || source.counts), "missing-source metadata stays structured");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioStoryRegistryAndVerificationStrategyPopulateSpecificationAndVerification() {
  const tmp = makeTemp("story-strategy");
  try {
    seedStoryRegistry(tmp);
    seedVerificationStrategy(tmp);
    const result = induceOntologyDocuments({ cwd: tmp, sources: ["story-registry", "verification-strategy"] });

    assert(result.ok, "story registry plus verification strategy induction validates");
    assert(result.documents.specification.stories.some((story) => story.id === "US-900"), "story registry creates specification stories");
    assert(
      result.documents.specification.stories.find((story) => story.id === "US-900")?.acceptance_criteria?.length === 1,
      "story registry synthesizes a fallback acceptance criterion when none are declared"
    );
    assert(result.documents.code.files.some((file) => file.path === ".agent/skills/iterative-planner/scripts/ontology_context.mjs"), "story registry code refs populate code files");
    assert(result.documents.verification.criteria.some((criterion) => criterion.id === "CRIT-001"), "verification strategy populates verification criteria");
    assert(
      result.documents.verification.tests.some((test) => test.name === "scenarioBuildInducesAllOntologyClasses"),
      "verification strategy populates named test facts"
    );
    assert(
      result.documents.verification.artifacts.some((artifact) => artifact.path === "reports/coverage/ontology_inducer.json"),
      "verification strategy populates evidence artifacts"
    );
    assert(
      result.documents.specification.plans.some((plan) => plan.id === "plan_fixture" && plan.phase === "EXECUTE"),
      "verification strategy populates plan facts with plan phase"
    );
    assert(result.documents.proof_weights.proof_types.integration_test, "proof weight defaults remain available during selective induction");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioInducerPreservesExistingProofWeights() {
  const tmp = makeTemp("proof-weights");
  try {
    seedProofWeights(tmp);
    const result = induceOntologyDocuments({ cwd: tmp, sources: ["proof-weights"] });

    assert(result.ok, "proof weight induction validates when a custom document is present");
    assert(result.documents.proof_weights.proof_types.unit_test.base_weight === 9, "proof weight induction preserves authored proof-type overrides");
    assert(result.documents.proof_weights.domain_defaults.planner_core === "critical", "proof weight induction preserves authored domain defaults");
    assert(result.documents.proof_weights.proof_types.integration_test, "proof weight induction backfills missing starter proof types");
    assert(result.documents.proof_weights.risk_levels.medium, "proof weight induction backfills missing starter risk levels");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioInducerPreservesExistingConventions() {
  const tmp = makeTemp("conventions");
  try {
    seedConventions(tmp);
    const result = induceOntologyDocuments({ cwd: tmp, sources: ["conventions"] });

    assert(result.ok, "convention induction validates when an authored document is present");
    assert(result.documents.conventions.conventions.length === 1, "convention induction preserves authored convention rows");
    assert(result.documents.conventions.conventions[0]?.id === "CONV-900", "convention induction preserves authored convention ids");
    assert(result.documents.conventions.conventions[0]?.applies_to?.file_patterns?.[0] === ".agent/workflows/*.md", "convention induction preserves applicability metadata");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioInvalidProofWeightsFailInduction() {
  const tmp = makeTemp("proof-weights-invalid");
  try {
    seedProofWeights(tmp, {
      proof_weights: {
        version: 1,
        proof_types: {
          unit_test: {
            label: "Unit test override",
            category: "test",
            base_weight: 9,
          },
        },
        risk_levels: {
          low: {
            required_weight: 1,
          },
        },
        domain_defaults: {
          planner_core: "unknown_risk",
        },
      },
    });

    const result = induceOntologyDocuments({ cwd: tmp, sources: ["proof-weights"] });
    assert(result.ok === false, "invalid proof weight source fails induction instead of being silently replaced");
    assert(
      (result.issues || []).some((issue) => issue.includes("proof_weights.yaml")),
      "invalid proof weight induction surfaces the source file in the reported issue"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioProcessInducersPopulateRetrosKnowledgeAdrsAndEdgeCases() {
  const tmp = makeTemp("process");
  try {
    seedRetros(tmp);
    seedDomainChecklist(tmp);
    seedWorkflowRegistry(tmp);
    seedKnowledgeFiles(tmp);
    seedAdr(tmp);
    const result = induceOntologyDocuments({
      cwd: tmp,
      sources: ["retros", "domain-checklists", "workflows", "knowledge", "adrs"],
    });

    assert(result.ok, "process-source induction validates");
    assert(result.documents.process.retros.some((retro) => retro.id === "R-2026-04-24-001"), "retro ledger populates retros");
    assert(result.documents.process.mistakes.some((mistake) => mistake.id === "M-032"), "knowledge markdown populates mistakes");
    assert(result.documents.process.patterns.some((pattern) => pattern.id === "P-090"), "knowledge markdown populates patterns");
    assert(result.documents.process.gotchas.some((gotcha) => gotcha.id === "G-081"), "knowledge markdown populates gotchas");
    assert(result.documents.process.workflows.some((workflow) => workflow.name === "/advisor"), "workflow registry populates workflows");
    assert(result.documents.process.adrs.some((adr) => adr.id === "ADR-0020"), "ADR files populate adrs");
    assert(result.documents.process.edge_cases.some((edgeCase) => edgeCase.domain === "planner_core"), "domain checklist populates edge cases");
    assert(result.documents.process.mirror_readers.length > 0, "mirror-reader hints induce mirror reader facts");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioCliWriteIsIdempotentAndWritesFactFiles() {
  const tmp = makeTemp("cli");
  try {
    seedStoryRegistry(tmp);
    seedVerificationStrategy(tmp);
    seedRetros(tmp);
    seedDomainChecklist(tmp);
    seedWorkflowRegistry(tmp);
    seedKnowledgeFiles(tmp);
    seedAdr(tmp);
    seedConventions(tmp);

    const first = runCli(["all", "--dir", tmp, "--json", "--write"], tmp);
    assert(first.ok, "ontology inducer CLI exits cleanly");
    const firstJson = JSON.parse(first.stdout);
    assert(firstJson.wrote === true, "ontology inducer CLI reports writes");

    const files = [
      join(tmp, ".agent", "ontology", "facts", "code.yaml"),
      join(tmp, ".agent", "ontology", "facts", "specification.yaml"),
      join(tmp, ".agent", "ontology", "facts", "verification.yaml"),
      join(tmp, ".agent", "ontology", "facts", "process.yaml"),
      join(tmp, ".agent", "ontology", "facts", "proof_weights.yaml"),
      join(tmp, ".agent", "ontology", "facts", "conventions.yaml"),
    ];
    assert(files.every((filePath) => readFileSync(filePath, "utf-8").trim().startsWith("{")), "ontology inducer writes JSON-compatible YAML fact files");

    const firstFacts = files.map((filePath) => readJson(filePath));
    const second = runCli(["all", "--dir", tmp, "--json", "--write"], tmp);
    assert(second.ok, "ontology inducer CLI reruns cleanly");
    const secondFacts = files.map((filePath) => readJson(filePath));
    assert(JSON.stringify(firstFacts) === JSON.stringify(secondFacts), "rerunning ontology induction is idempotent");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioFinalDocumentsRemainSchemaValid() {
  const tmp = makeTemp("validate");
  try {
    seedStoryRegistry(tmp);
    seedVerificationStrategy(tmp);
    seedRetros(tmp);
    seedDomainChecklist(tmp);
    seedWorkflowRegistry(tmp);
    seedKnowledgeFiles(tmp);
    seedAdr(tmp);
    seedConventions(tmp);
    const result = induceOntologyDocuments({ cwd: tmp });

    for (const entityClass of ["code", "specification", "verification", "process", "proof_weights", "conventions"]) {
      const validation = validateOntologyDocument(entityClass, { [entityClass]: result.documents[entityClass] });
      assert(validation.ok, `${entityClass} induced document remains schema-valid`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

scenarioMissingSourcesProduceEmptyValidDocuments();
scenarioStoryRegistryAndVerificationStrategyPopulateSpecificationAndVerification();
scenarioInducerPreservesExistingProofWeights();
scenarioInducerPreservesExistingConventions();
scenarioInvalidProofWeightsFailInduction();
scenarioProcessInducersPopulateRetrosKnowledgeAdrsAndEdgeCases();
scenarioCliWriteIsIdempotentAndWritesFactFiles();
scenarioFinalDocumentsRemainSchemaValid();

console.log(`\nOntology inducer tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
