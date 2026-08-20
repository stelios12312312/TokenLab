#!/usr/bin/env node

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { buildOntologyFacts } from "../scripts/lib/ontology_fact_builder.mjs";
import {
  ONTOLOGY_ENTITY_CLASSES,
  getOntologyCompiledFactPath,
  getOntologyFactPath,
} from "../scripts/lib/ontology_schema.mjs";
import { createSemanticEngine } from "../scripts/lib/semantic_engine.mjs";
import { createSession } from "../scripts/lib/prolog.mjs";
import { loadRules } from "../scripts/lib/fact_loader.mjs";
import { lintVerificationStrategy } from "../scripts/lib/verification_strategy.mjs";
import { induceOntologyDocuments } from "../scripts/ontology_inducer.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const plannerSkillPath = resolve(scriptDir, "..");
const ontologyCliPath = join(scriptDir, "ontology_cli.mjs");
const plannerCliPath = join(scriptDir, "planner.mjs");
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
  return mkdtempSync(join(tmpdir(), `planner-ontology-cli-${name}-`));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writeText(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotGeneratedAuthority(tmp) {
  const paths = {
    ...Object.fromEntries(
      ONTOLOGY_ENTITY_CLASSES.map((entityClass) => [
        entityClass,
        getOntologyFactPath(entityClass, tmp),
      ])
    ),
    compiled: getOntologyCompiledFactPath(tmp),
  };
  return Object.fromEntries(
    Object.entries(paths).map(([name, path]) => {
      const bytes = readFileSync(path);
      return [name, { path, bytes, sha256: sha256(bytes) }];
    })
  );
}

function assertGeneratedAuthorityUnchanged(snapshot, label) {
  for (const [name, expected] of Object.entries(snapshot)) {
    const actual = readFileSync(expected.path);
    assert(actual.equals(expected.bytes), `${label}: ${name} authority bytes remain unchanged`);
    assert(sha256(actual) === expected.sha256, `${label}: ${name} authority SHA-256 remains unchanged`);
  }
}

function runCli(scriptPath, args, cwd) {
  try {
    const stdout = execFileSync(nodeBin, [scriptPath, ...args], {
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
        domain: "planner_core",
        tags: ["planner-core", "traceability"],
        code_refs: [
          ".agent/skills/iterative-planner/scripts/ontology_context.mjs",
          ".agent/skills/iterative-planner/scripts/planner.mjs",
        ],
        test_refs: [
          ".agent/skills/iterative-planner/tests/test_ontology_cli.mjs",
        ],
        validation_refs: [
          "reports/ive/test_runs/plan_ontology_context_latest.yaml",
        ],
        acceptance_criteria: [
          {
            id: "AC-US-900-EXPLICIT",
            description: "Canonical story criterion description",
          },
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
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      repo_system_context: "Ontology verification fixture",
      verification_obligation_synthesis: {
        summary: "Exercise ontology source truth.",
        scope: "Fixture-only ontology induction.",
        non_goals: [],
        dependencies: [],
      },
      criteria: [
        {
          id: "CRIT-001",
          criterion: "planner ontology build returns non-empty facts",
          story_id: "US-900",
          story_criterion_id: "AC-US-900-EXPLICIT",
          domain: "planner_core",
          repo_system_context: "Fixture ontology induction and graph validation.",
          required_proof_type: "proof:integration_smoke",
          implementation: {
            file: ".agent/skills/iterative-planner/scripts/ontology_inducer.mjs",
            lines: "1-200",
            function: null,
          },
          acceptance: ["planner ontology build returns non-empty facts"],
          tests: [
            {
              name: "scenarioBuildInducesAllOntologyClasses",
              file: ".agent/skills/iterative-planner/tests/test_ontology_cli.mjs",
              type: "integration",
            },
          ],
          evidence_artifacts: [
            {
              type: "coverage_report",
              path: "reports/coverage/ontology_inducer.json",
            },
          ],
          concrete_action: {
            type: "command",
            command: "node test_ontology_cli.mjs",
          },
          how_verified: "integration_test",
          pass_means: "The fixture builds and validates.",
          what_remains_unverified: "Production data is outside this fixture.",
          persona_audit_required: false,
        },
      ],
    },
  });
  writeJson(join(tmp, "plans", "plan_fixture", "state.json"), {
    state: "EXECUTE",
  });
}

function seedAdditionalStory(tmp, {
  storyId,
  criterionId,
  title = "Additional ontology story",
} = {}) {
  const registryPath = join(tmp, "reports", "user_story_audit", "story_registry.json");
  const registry = readJson(registryPath);
  registry.stories.push({
    id: storyId,
    title,
    priority: "HIGH",
    status: "NOT_IMPLEMENTED",
    code_refs: [],
    test_refs: [],
    validation_refs: [],
    acceptance_criteria: [
      {
        id: criterionId,
        description: `${title} acceptance`,
      },
    ],
  });
  writeJson(registryPath, registry);
}

function seedAdditionalVerificationStrategy(tmp, {
  planId,
  criterionId = "CRIT-001",
  storyId = "US-900",
  storyCriterionId = null,
  testName,
  testFile,
  artifactPath,
  state = "EXECUTE",
} = {}) {
  const criterion = {
    id: criterionId,
    criterion: `${planId} keeps its verification identity`,
    story_id: storyId,
    implementation: {
      file: ".agent/skills/iterative-planner/scripts/ontology_inducer.mjs",
      lines: "1-200",
      function: null,
    },
    tests: [
      {
        name: testName,
        file: testFile,
        type: "integration",
      },
    ],
    evidence_artifacts: [
      {
        type: "test_output",
        path: artifactPath,
      },
    ],
  };
  if (storyCriterionId) criterion.story_criterion_id = storyCriterionId;

  writeJson(join(tmp, "plans", planId, "verification_strategy.yaml"), {
    verification_strategy: {
      version: 1,
      plan_id: planId,
      criteria: [criterion],
    },
  });
  writeJson(join(tmp, "plans", planId, "state.json"), { state });
}

function seedFullAdditionalVerificationStrategy(tmp, {
  planId,
  storyId,
  storyCriterionId,
  testName,
  testFile,
  artifactPath,
  state = "EXECUTE",
} = {}) {
  const document = readJson(join(tmp, "plans", "plan_fixture", "verification_strategy.yaml"));
  document.verification_strategy.plan_id = planId;
  document.verification_strategy.repo_system_context = `${planId} ontology verification fixture`;
  const criterion = document.verification_strategy.criteria[0];
  criterion.criterion = `${planId} keeps its verification identity`;
  criterion.story_id = storyId;
  criterion.story_criterion_id = storyCriterionId;
  criterion.tests = [{
    name: testName,
    file: testFile,
    type: "integration",
  }];
  criterion.evidence_artifacts = [{
    type: "test_output",
    path: artifactPath,
  }];
  writeJson(join(tmp, "plans", planId, "verification_strategy.yaml"), document);
  writeJson(join(tmp, "plans", planId, "state.json"), { state });
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
  writeText(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
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

function seedConventions(tmp) {
  writeJson(join(tmp, ".agent", "ontology", "facts", "conventions.yaml"), {
    conventions: {
      version: 1,
      conventions: [
        {
          id: "CONV-900",
          title: "Planner workflows stay slash-prefixed",
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

function seedAllSources(tmp) {
  seedStoryRegistry(tmp);
  seedVerificationStrategy(tmp);
  seedRetros(tmp);
  seedDomainChecklist(tmp);
  seedWorkflowRegistry(tmp);
  seedKnowledgeFiles(tmp);
  seedAdr(tmp);
  seedConventions(tmp);
}

function scenarioBuildCliWritesGeneratedRepoFacts() {
  const tmp = makeTemp("build");
  try {
    seedAllSources(tmp);

    const result = runCli(ontologyCliPath, ["build", "--dir", tmp, "--induce", "--json"], tmp);
    assert(result.ok, "ontology_cli build --induce exits cleanly");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "ontology_cli build emits valid JSON");
    assert(parsed?.ok === true, "ontology_cli build reports success");
    assert(parsed?.wrote_generated_facts === true, "ontology_cli build writes .agent/ontology/facts.pl");
    assert((parsed?.wrote_fact_documents || []).length >= 5, "ontology_cli build refreshes the changed canonical ontology YAML documents on first induction");
    assert((parsed?.wrote_fact_documents || []).includes("proof_weights"), "ontology_cli build records proof_weights as a refreshed canonical YAML document");

    const factsPath = getOntologyCompiledFactPath(tmp);
    const facts = readFileSync(factsPath, "utf-8");
    assert(facts.includes("% Generated by planner ontology build"), "generated facts file records its provenance");
    assert(facts.includes("story('US-900')."), "generated facts include induced stories");
    assert(facts.includes("acceptance_criterion('AC-US-900-EXPLICIT', 'Canonical story criterion description')."), "generated facts preserve canonical description-based criterion text");
    assert(facts.includes("story_has_criterion('US-900', 'AC-US-900-EXPLICIT')."), "generated facts preserve canonical story-to-criterion links");
    assert(facts.includes("verification_criterion('CRIT-001', 'plan_fixture')."), "generated facts include verification criteria");
    assert(facts.includes("plan_criterion_verifies_story_criterion('plan_fixture', 'CRIT-001', 'AC-US-900-EXPLICIT')."), "generated facts preserve explicit plan-to-story criterion links with plan identity");
    assert(facts.includes("artifact_proves_plan_criterion('reports/coverage/ontology_inducer.json', 'plan_fixture', 'CRIT-001')."), "generated facts include plan-aware artifact-to-criterion proof links");
    assert(facts.includes("workflow('/advisor')."), "generated facts include induced workflows");
    assert(facts.includes("proof_weight_type('unit_test')."), "generated facts include proof weight type facts");
    assert(facts.includes("proof_weight_domain_default('planner_core', 'high')."), "generated facts include proof weight domain defaults");
    assert(facts.includes("convention('CONV-900')."), "generated facts include convention facts");
    assert(facts.includes("convention_applies_to_change_class('CONV-900', 'workflow')."), "generated facts include convention applicability facts");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioPlanCriterionIdentityIsScopedAndExplicit() {
  const tmp = makeTemp("criterion-scope");
  try {
    seedAllSources(tmp);
    seedAdditionalStory(tmp, {
      storyId: "US-901",
      criterionId: "AC-US-901-001",
      title: "Second plan identity",
    });
    seedAdditionalVerificationStrategy(tmp, {
      planId: "plan_second",
      storyId: "US-901",
      storyCriterionId: "AC-US-901-001",
      testName: "scenarioSecondPlan",
      testFile: ".agent/skills/iterative-planner/tests/test_second_plan.mjs",
      artifactPath: "reports/test_runs/second-plan.json",
    });

    const secondStrategyPath = join(tmp, "plans", "plan_second", "verification_strategy.yaml");
    const secondStrategy = readJson(secondStrategyPath);
    secondStrategy.verification_strategy.criteria.push({
      id: "CRIT-UNMAPPED",
      criterion: "A story reference alone is not an acceptance-criterion mapping",
      story_id: "US-901",
      implementation: {
        file: ".agent/skills/iterative-planner/scripts/ontology_inducer.mjs",
        lines: "1-200",
        function: null,
      },
      tests: [
        {
          name: "scenarioUnmappedPlanCriterion",
          file: ".agent/skills/iterative-planner/tests/test_second_plan.mjs",
          type: "integration",
        },
      ],
    });
    writeJson(secondStrategyPath, secondStrategy);

    const build = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(build.ok, "same-ID two-plan fixture builds ontology facts");
    const facts = build.facts;
    assert(
      facts.includes("plan_criterion_verifies_story_criterion('plan_fixture', 'CRIT-001', 'AC-US-900-EXPLICIT')."),
      "plan A criterion keeps its explicit story criterion"
    );
    assert(
      facts.includes("plan_criterion_verifies_story_criterion('plan_second', 'CRIT-001', 'AC-US-901-001')."),
      "plan B same-local-ID criterion keeps its explicit story criterion"
    );
    assert(
      facts.includes("test_verifies_plan_criterion('scenarioBuildInducesAllOntologyClasses', 'plan_fixture', 'CRIT-001')."),
      "plan A test edge retains plan identity"
    );
    assert(
      facts.includes("test_verifies_plan_criterion('scenarioSecondPlan', 'plan_second', 'CRIT-001')."),
      "plan B test edge retains plan identity"
    );
    assert(
      !facts.includes("criterion_verifies_story_criterion('CRIT-001'"),
      "compiled facts omit ambiguous bare plan-criterion-to-story links"
    );
    assert(
      !facts.includes("test_verifies_criterion('scenarioSecondPlan', 'CRIT-001')."),
      "compiled facts omit ambiguous bare plan-criterion test links"
    );
    assert(
      !facts.includes("plan_criterion_verifies_story_criterion('plan_second', 'CRIT-UNMAPPED'"),
      "story_id alone does not guess the story's first acceptance criterion"
    );
    assert(
      facts.includes("test_verifies_criterion('.agent/skills/iterative-planner/tests/test_ontology_cli.mjs', 'AC-US-900-EXPLICIT')."),
      "globally identified story-criterion test links retain the two-argument compatibility predicate"
    );

    const { session } = createSemanticEngine({
      cwd: tmp,
      skillPath: plannerSkillPath,
      refreshOntology: false,
    });
    assert(
      session.check("test_verifies_plan_criterion('scenarioBuildInducesAllOntologyClasses', 'plan_fixture', 'CRIT-001')"),
      "semantic query resolves plan A's exact test edge"
    );
    assert(
      !session.check("test_verifies_plan_criterion('scenarioSecondPlan', 'plan_fixture', 'CRIT-001')"),
      "semantic query cannot cross-join plan B's same-ID test into plan A"
    );

    const verificationPath = join(tmp, ".agent", "ontology", "facts", "verification.yaml");
    const verification = readJson(verificationPath);
    const secondPlanTest = verification.verification.tests.find((record) => record.name === "scenarioSecondPlan");
    assert(
      !secondPlanTest?.criterion_ids?.includes("CRIT-001"),
      "canonical test records do not retain ambiguous bare plan-local criterion IDs"
    );
    secondPlanTest.criterion_ids = ["CRIT-001"];
    writeJson(verificationPath, verification);
    const invalid = runCli(ontologyCliPath, ["validate", "--dir", tmp, "--json"], tmp);
    const invalidParsed = parseJson(invalid.stdout);
    assert(!invalid.ok, "ontology validate rejects a planted ambiguous bare plan-local test criterion");
    assert(
      invalidParsed?.dangling_test_criteria?.some((entry) => entry.includes("CRIT-001")),
      "ontology validate identifies the planted bare plan-local criterion"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioCrossPlanCriterionReuseRemainsValid() {
  const tmp = makeTemp("cross-plan-criterion-control");
  try {
    seedAllSources(tmp);
    seedAdditionalStory(tmp, {
      storyId: "US-901",
      criterionId: "AC-US-901-001",
      title: "Second plan identity positive control",
    });
    seedFullAdditionalVerificationStrategy(tmp, {
      planId: "plan_second",
      storyId: "US-901",
      storyCriterionId: "AC-US-901-001",
      testName: "scenarioCrossPlanCriterionReuseRemainsValid",
      testFile: ".agent/skills/iterative-planner/tests/test_second_plan.mjs",
      artifactPath: "reports/test_runs/cross-plan-control.json",
    });

    const firstLint = lintVerificationStrategy({
      cwd: tmp,
      planDir: join(tmp, "plans", "plan_fixture"),
    });
    const secondLint = lintVerificationStrategy({
      cwd: tmp,
      planDir: join(tmp, "plans", "plan_second"),
    });
    assert(firstLint.ok, "full strategy lint accepts the first owner of a plan-local criterion ID");
    assert(secondLint.ok, "full strategy lint accepts the same normalized criterion ID in a different plan");

    const build = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(build.ok, "cross-plan reuse of a normalized criterion ID remains a valid induction input");
    const scopedCriteria = build.documents.verification.criteria.filter(
      (record) => record.id === "CRIT-001"
    );
    assert(scopedCriteria.length === 2, "cross-plan reuse induces two independently scoped criterion records");
    assert(
      scopedCriteria.some((record) => record.plan_id === "plan_fixture" && record.story_id === "US-900"),
      "cross-plan reuse retains plan A ownership"
    );
    assert(
      scopedCriteria.some((record) => record.plan_id === "plan_second" && record.story_id === "US-901"),
      "cross-plan reuse retains plan B ownership"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioDuplicateSamePlanCriterionIdentityFailsClosed() {
  const tmp = makeTemp("duplicate-plan-criterion");
  try {
    seedAllSources(tmp);
    seedAdditionalStory(tmp, {
      storyId: "US-901",
      criterionId: "AC-US-901-001",
      title: "Duplicate criterion owner B",
    });
    const baseline = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(baseline.ok, "duplicate criterion fixture establishes canonical ontology authority");
    const authority = snapshotGeneratedAuthority(tmp);

    const strategyPath = join(tmp, "plans", "plan_fixture", "verification_strategy.yaml");
    const originalStrategy = readFileSync(strategyPath);
    const strategyDocument = readJson(strategyPath);
    const ownerB = JSON.parse(JSON.stringify(strategyDocument.verification_strategy.criteria[0]));
    ownerB.id = ` ${ownerB.id} `;
    ownerB.criterion = "duplicate normalized identity must not merge owner B evidence";
    ownerB.story_id = "US-901";
    ownerB.story_criterion_id = "AC-US-901-001";
    ownerB.acceptance = ["owner B evidence remains unreachable"];
    ownerB.tests = [{
      name: "scenarioDuplicateOwnerB",
      file: ".agent/skills/iterative-planner/tests/test_duplicate_owner_b.mjs",
      type: "integration",
    }];
    ownerB.evidence_artifacts = [{
      type: "test_output",
      path: "reports/test_runs/duplicate-owner-b.json",
    }];
    strategyDocument.verification_strategy.criteria.push(ownerB);
    writeJson(strategyPath, strategyDocument);

    const lint = lintVerificationStrategy({
      cwd: tmp,
      planDir: join(tmp, "plans", "plan_fixture"),
    });
    assert(!lint.ok, "full strategy lint rejects duplicate normalized same-plan criterion IDs");
    assert(
      lint.issues.some((entry) =>
        entry.toLowerCase().includes("duplicate") &&
        entry.includes("plan_fixture:CRIT-001")
      ),
      "full strategy lint reports the duplicate normalized plan/criterion identity"
    );

    const induced = induceOntologyDocuments({ cwd: tmp });
    assert(!induced.ok, "ontology induction rejects duplicate normalized criterion IDs during source preflight");
    assert(
      induced.issues.some((entry) =>
        entry.includes(strategyPath) &&
        entry.toLowerCase().includes("duplicate") &&
        entry.includes("plan_fixture:CRIT-001")
      ),
      "induction reports the exact selected strategy path and duplicate normalized identity"
    );
    assert(
      !induced.documents.verification.tests.some((record) => record.name === "scenarioDuplicateOwnerB"),
      "rejected duplicate input cannot merge owner B test evidence in memory"
    );
    assert(
      !induced.documents.verification.artifacts.some(
        (record) => record.path === "reports/test_runs/duplicate-owner-b.json"
      ),
      "rejected duplicate input cannot merge owner B artifact evidence in memory"
    );

    const rejectedBuild = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(!rejectedBuild.ok, "duplicate normalized identity aborts ontology build before writes");
    assert(rejectedBuild.wrote_fact_documents.length === 0, "duplicate rejection writes no canonical YAML documents");
    assert(rejectedBuild.wrote_generated_facts === false, "duplicate rejection writes no compiled facts.pl");
    assertGeneratedAuthorityUnchanged(authority, "duplicate rejection");

    const { session } = createSemanticEngine({
      cwd: tmp,
      skillPath: plannerSkillPath,
      refreshOntology: false,
    });
    assert(
      !session.check("test_verifies_plan_criterion('scenarioDuplicateOwnerB', 'plan_fixture', 'CRIT-001')"),
      "owner B test evidence is not semantically reachable through owner A's criterion"
    );
    assert(
      !session.check("artifact_proves_plan_criterion('reports/test_runs/duplicate-owner-b.json', 'plan_fixture', 'CRIT-001')"),
      "owner B artifact evidence is not semantically reachable through owner A's criterion"
    );

    writeText(strategyPath, originalStrategy);
    const recovery = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(recovery.ok, "correcting the duplicate selected strategy restores ontology induction");
    assertGeneratedAuthorityUnchanged(authority, "duplicate correction");

    const verificationPath = join(tmp, ".agent", "ontology", "facts", "verification.yaml");
    const verification = readJson(verificationPath);
    verification.verification.criteria.push({
      ...verification.verification.criteria[0],
      id: ` ${verification.verification.criteria[0].id} `,
    });
    writeJson(verificationPath, verification);
    const runtimeValidation = runCli(ontologyCliPath, ["validate", "--dir", tmp, "--json"], tmp);
    const runtimeParsed = parseJson(runtimeValidation.stdout);
    assert(!runtimeValidation.ok, "runtime ontology validation rejects duplicate normalized plan/criterion identities");
    assert(
      runtimeParsed?.issues?.some((entry) =>
        entry.toLowerCase().includes("duplicate") &&
        entry.includes("plan_fixture:CRIT-001")
      ),
      "runtime validation identifies the duplicate normalized plan/criterion identity"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioInvalidSelectedStrategyFailsBeforeAuthorityWrites() {
  const tmp = makeTemp("invalid-selected-strategy");
  try {
    seedAllSources(tmp);
    const baseline = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(baseline.ok, "invalid selected-strategy fixture establishes canonical ontology authority");

    const strategyPath = join(tmp, "plans", "plan_fixture", "verification_strategy.yaml");
    const originalStrategy = readFileSync(strategyPath);
    const authority = snapshotGeneratedAuthority(tmp);

    function assertRejectedAndRecover(rawStrategy, expectedIssue, label) {
      writeText(strategyPath, rawStrategy);
      const rejected = buildOntologyFacts({ cwd: tmp, induce: true });
      assert(!rejected.ok, `${label} selected strategy aborts ontology induction`);
      assert(
        rejected.issues.some((entry) =>
          entry.includes(strategyPath) &&
          entry.includes(expectedIssue)
        ),
        `${label} rejection reports the exact selected strategy path and structural issue`
      );
      assert(rejected.wrote_fact_documents.length === 0, `${label} rejection writes no canonical YAML`);
      assert(rejected.wrote_generated_facts === false, `${label} rejection writes no compiled facts.pl`);
      assertGeneratedAuthorityUnchanged(authority, `${label} rejection`);

      writeText(strategyPath, originalStrategy);
      const recovery = buildOntologyFacts({ cwd: tmp, induce: true });
      assert(recovery.ok, `${label} strategy correction restores induction`);
      assertGeneratedAuthorityUnchanged(authority, `${label} correction`);
    }

    assertRejectedAndRecover(
      "{",
      "must be valid JSON-compatible YAML",
      "malformed"
    );
    assertRejectedAndRecover(
      "{}\n",
      "verification_strategy root object missing",
      "structurally invalid"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioStoryCriterionOwnershipAndPrimaryDomainFailClosed() {
  const tmp = makeTemp("criterion-owner-domain");
  try {
    seedAllSources(tmp);
    seedAdditionalStory(tmp, {
      storyId: "US-901",
      criterionId: "AC-US-901-001",
      title: "Second story in one plan",
    });
    const registryPath = join(tmp, "reports", "user_story_audit", "story_registry.json");
    const registry = readJson(registryPath);
    registry.stories.push({
      id: "US-902",
      title: "Cross-surface implementation",
      priority: "MEDIUM",
      status: "NOT_IMPLEMENTED",
      code_refs: [
        ".agent/skills/iterative-planner/scripts/ontology_inducer.mjs",
        "plans/knowledge/retros/retro_ledger.json",
      ],
      test_refs: [],
      doc_refs: [],
      validation_refs: [],
      acceptance_criteria: ["Cross-surface ownership stays explicitly unclassified."],
    });
    writeJson(registryPath, registry);

    const strategyPath = join(tmp, "plans", "plan_fixture", "verification_strategy.yaml");
    const strategy = readJson(strategyPath);
    strategy.verification_strategy.criteria.push({
      ...strategy.verification_strategy.criteria[0],
      id: "CRIT-002",
      criterion: "second story remains independently owned",
      story_id: "US-901",
      story_criterion_id: "AC-US-901-001",
      acceptance: ["second story remains independently owned"],
      tests: [{
        name: "scenarioSecondStorySamePlan",
        file: "tests/analysis/test_second_story.mjs",
        type: "integration",
      }],
      evidence_artifacts: [],
    });
    strategy.verification_strategy.criteria[0].story_criterion_id = "AC-US-901-001";
    writeJson(strategyPath, strategy);

    const lint = lintVerificationStrategy({
      cwd: tmp,
      planDir: join(tmp, "plans", "plan_fixture"),
    });
    assert(!lint.ok, "verification strategy lint rejects a cross-story acceptance-criterion owner");
    assert(
      lint.issues.some((entry) => entry.includes("AC-US-901-001") && entry.includes("US-900")),
      "verification strategy lint identifies the exact criterion/story ownership mismatch"
    );

    const build = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(build.ok, "cross-story ownership fixture still induces structurally valid ontology documents");
    const inducedCriterion = build.documents.verification.criteria.find(
      (record) => record.plan_id === "plan_fixture" && record.id === "CRIT-001"
    );
    assert(inducedCriterion?.story_id === "US-900", "induced verification criteria retain their exact story identity");

    const invalid = runCli(ontologyCliPath, ["validate", "--dir", tmp, "--json"], tmp);
    const invalidParsed = parseJson(invalid.stdout);
    assert(!invalid.ok, "ontology validate rejects a cross-story acceptance-criterion edge within one multi-story plan");
    assert(
      invalidParsed?.dangling_story_criteria?.some(
        (entry) => entry.includes("plan_fixture:CRIT-001") && entry.includes("US-900")
      ),
      "ontology validate reports the exact row-level story ownership mismatch"
    );

    const specificationPath = join(tmp, ".agent", "ontology", "facts", "specification.yaml");
    const specification = readJson(specificationPath);
    const inducedStory = specification.specification.stories.find((record) => record.id === "US-900");
    assert(
      inducedStory?.domain === "planner_core",
      "explicit canonical story domain outranks an incidental reports/ive validation path"
    );
    const ambiguousStory = specification.specification.stories.find((record) => record.id === "US-902");
    assert(
      ambiguousStory?.domain === undefined,
      "ambiguous multi-domain code ownership fails closed without a primary domain"
    );

    const evidenceMutation = readJson(registryPath);
    const mutableStory = evidenceMutation.stories.find((record) => record.id === "US-900");
    mutableStory.test_refs.reverse();
    mutableStory.doc_refs = ["AGENTS.md", "README.md"];
    mutableStory.validation_refs = [
      "plans/plan_evidence_only/verification.md",
      "reports/ive/test_runs/evidence-only/manifest.json",
      "apps/ive-visualizer/tests/evidence-only.spec.mjs",
    ];
    writeJson(registryPath, evidenceMutation);
    const evidenceOnlyBuild = buildOntologyFacts({ cwd: tmp, induce: true, dryRun: true });
    const evidenceOnlyStory = evidenceOnlyBuild.documents?.specification?.stories?.find(
      (record) => record.id === "US-900"
    );
    assert(
      evidenceOnlyStory?.domain === "planner_core",
      "test, documentation, validation, and reference order changes cannot alter the primary story domain"
    );

    strategy.verification_strategy.criteria[0].story_criterion_id = "AC-US-900-EXPLICIT";
    writeJson(strategyPath, strategy);
    const correctedBuild = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(correctedBuild.ok, "corrected same-plan story ownership fixture rebuilds");
    const corrected = runCli(ontologyCliPath, ["validate", "--dir", tmp, "--json"], tmp);
    const correctedParsed = parseJson(corrected.stdout);
    assert(
      correctedParsed?.dangling_story_criteria?.length === 0,
      "corrected same-plan story ownership clears criterion-ownership issues before duplicate-ID mutation"
    );

    const secondStory = specification.specification.stories.find((record) => record.id === "US-901");
    secondStory.acceptance_criteria[0].id = "AC-US-900-EXPLICIT";
    writeJson(specificationPath, specification);
    const duplicate = runCli(ontologyCliPath, ["validate", "--dir", tmp, "--json"], tmp);
    const duplicateParsed = parseJson(duplicate.stdout);
    assert(!duplicate.ok, "ontology validate rejects acceptance-criterion IDs owned by multiple stories");
    assert(
      duplicateParsed?.dangling_story_criteria?.some(
        (entry) => entry.includes("AC-US-900-EXPLICIT") && entry.includes("multiple stories")
      ),
      "ontology validate reports duplicate acceptance-criterion ownership"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioGitInductionExcludesInactiveUntrackedPlans() {
  const tmp = makeTemp("plan-authority");
  try {
    seedAllSources(tmp);
    seedAdditionalVerificationStrategy(tmp, {
      planId: "plan_active",
      criterionId: "ACTIVE-001",
      storyCriterionId: "AC-US-900-EXPLICIT",
      testName: "scenarioActivePlan",
      testFile: ".agent/skills/iterative-planner/tests/test_active_plan.mjs",
      artifactPath: "reports/test_runs/active-plan.json",
    });
    seedAdditionalVerificationStrategy(tmp, {
      planId: "plan_abandoned",
      criterionId: "ABANDONED-001",
      storyCriterionId: "AC-US-900-EXPLICIT",
      testName: "scenarioAbandonedPlan",
      testFile: ".agent/skills/iterative-planner/tests/test_abandoned_plan.mjs",
      artifactPath: "reports/test_runs/abandoned-plan.json",
      state: "CLOSE",
    });
    writeText(join(tmp, "plans", ".current_plan"), "plan_active\n");
    execFileSync("git", ["init", "-q"], { cwd: tmp, stdio: "pipe" });
    execFileSync("git", ["add", "--", "plans/plan_fixture/verification_strategy.yaml"], {
      cwd: tmp,
      stdio: "pipe",
    });

    const build = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(build.ok, "Git plan-authority fixture builds ontology facts");
    const plans = readJson(join(tmp, ".agent", "ontology", "facts", "specification.yaml"))
      .specification.plans.map((record) => record.id);
    assert(plans.includes("plan_fixture"), "tracked historical plan remains an induction input");
    assert(plans.includes("plan_active"), "explicitly current untracked plan remains an induction input");
    assert(!plans.includes("plan_abandoned"), "inactive untracked plan is excluded from canonical ontology");
    assert(!build.facts.includes("plan('plan_abandoned')."), "inactive untracked plan is excluded from compiled Prolog facts");

    const repeat = buildOntologyFacts({ cwd: tmp, induce: true, dryRun: true });
    assert(repeat.ok, "repeated authoritative-plan induction succeeds");
    assert(repeat.facts === build.facts, "authoritative-plan induction is byte-deterministic");
    assert(repeat.changed_fact_documents.length === 0, "repeated authoritative-plan induction has no canonical YAML drift");

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = join(tmp, "missing-git-bin");
      const failedInventory = buildOntologyFacts({ cwd: tmp, induce: true, dryRun: true });
      assert(!failedInventory.ok, "Git worktree induction fails closed when tracked-plan inventory is unavailable");
      assert(
        failedInventory.issues.some((entry) => entry.includes("tracked-plan inventory failed")),
        "failed Git inventory reports the plan-authority error instead of selecting every directory"
      );
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioPlanPointersRespectLifecycleAuthority() {
  const tmp = makeTemp("pointer-lifecycle-authority");
  try {
    seedAllSources(tmp);
    const planFixtures = [
      ["plan_tracked_close", "TRACKED-CLOSE-001", "CLOSE"],
      ["plan_current_close", "CURRENT-CLOSE-001", "CLOSE"],
      ["plan_current_unreadable", "CURRENT-UNREADABLE-001", "EXECUTE"],
      ["plan_thread_close", "THREAD-CLOSE-001", "CLOSE"],
      ["plan_thread_unreadable", "THREAD-UNREADABLE-001", "EXECUTE"],
      ["plan_thread_active", "THREAD-ACTIVE-001", "PLAN"],
      ["plan_inactive", "INACTIVE-001", "EXECUTE"],
    ];
    for (const [planId, criterionId, state] of planFixtures) {
      seedAdditionalVerificationStrategy(tmp, {
        planId,
        criterionId,
        storyCriterionId: "AC-US-900-EXPLICIT",
        testName: `scenario${criterionId.replace(/[^A-Za-z0-9]/g, "")}`,
        testFile: `.agent/skills/iterative-planner/tests/${planId}.mjs`,
        artifactPath: `reports/test_runs/${planId}.json`,
        state,
      });
    }
    writeText(join(tmp, "plans", "plan_current_unreadable", "state.json"), "{");
    writeText(join(tmp, "plans", "plan_thread_unreadable", "state.json"), "{");

    const currentPointerPath = join(tmp, "plans", ".current_plan");
    const threadPointerPaths = {
      terminal: join(tmp, "plans", ".thread_targets", "terminal.txt"),
      missing: join(tmp, "plans", ".thread_targets", "missing.txt"),
      unreadable: join(tmp, "plans", ".thread_targets", "unreadable.txt"),
      active: join(tmp, "plans", ".thread_targets", "active.txt"),
    };
    writeText(currentPointerPath, "plan_current_close\n");
    writeText(threadPointerPaths.terminal, "plan_thread_close\n");
    writeText(threadPointerPaths.missing, "plan_thread_missing\n");
    writeText(threadPointerPaths.unreadable, "plan_thread_unreadable\n");
    writeText(threadPointerPaths.active, "plan_thread_active\n");

    execFileSync("git", ["init", "-q"], { cwd: tmp, stdio: "pipe" });
    execFileSync(
      "git",
      [
        "add",
        "--",
        "plans/plan_fixture/verification_strategy.yaml",
        "plans/plan_tracked_close/verification_strategy.yaml",
      ],
      { cwd: tmp, stdio: "pipe" }
    );

    const initialPointerBytes = new Map(
      [currentPointerPath, ...Object.values(threadPointerPaths)]
        .map((path) => [path, readFileSync(path)])
    );
    const build = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(build.ok, "pointer lifecycle fixture builds canonical ontology authority");
    const planIds = build.documents.specification.plans.map((record) => record.id);
    assert(planIds.includes("plan_fixture"), "tracked nonterminal historical control remains selected");
    assert(planIds.includes("plan_tracked_close"), "tracked CLOSE history remains selected");
    assert(planIds.includes("plan_thread_active"), "readable nonterminal untracked thread target remains selected");
    assert(!planIds.includes("plan_current_close"), "terminal untracked .current_plan target is excluded");
    assert(!planIds.includes("plan_thread_close"), "terminal untracked thread target is excluded");
    assert(!planIds.includes("plan_thread_missing"), "missing untracked thread target is excluded");
    assert(!planIds.includes("plan_thread_unreadable"), "unreadable untracked thread target is excluded");
    assert(!planIds.includes("plan_inactive"), "unpointed untracked plan remains excluded");

    const warningText = build.warnings.join("\n");
    assert(
      warningText.includes(".current_plan") &&
      warningText.includes("plan_current_close") &&
      /terminal|close/i.test(warningText),
      "terminal current-pointer exclusion emits a lifecycle-specific warning"
    );
    assert(
      warningText.includes("terminal.txt") &&
      warningText.includes("plan_thread_close") &&
      /terminal|close/i.test(warningText),
      "terminal thread-pointer exclusion emits a lifecycle-specific warning"
    );
    assert(
      warningText.includes("missing.txt") &&
      warningText.includes("plan_thread_missing") &&
      /missing|does not exist/i.test(warningText),
      "missing thread-pointer exclusion emits a target-specific warning"
    );
    assert(
      warningText.includes("unreadable.txt") &&
      warningText.includes("plan_thread_unreadable") &&
      /unreadable|invalid/i.test(warningText),
      "unreadable thread-pointer exclusion emits a target-specific warning"
    );
    for (const [path, bytes] of initialPointerBytes.entries()) {
      assert(readFileSync(path).equals(bytes), `ontology induction leaves pointer bytes unchanged: ${path}`);
    }

    const repeat = buildOntologyFacts({ cwd: tmp, induce: true, dryRun: true });
    assert(repeat.ok, "repeated pointer lifecycle induction succeeds");
    assert(repeat.facts === build.facts, "pointer lifecycle selection is fact-byte deterministic");
    assert(
      JSON.stringify(repeat.warnings) === JSON.stringify(build.warnings),
      "pointer lifecycle warnings are order- and byte-deterministic"
    );
    assert(
      repeat.changed_fact_documents.length === 0,
      "repeated pointer lifecycle induction has no canonical YAML drift"
    );

    function assertRejectedCurrentPointer(target, reasonPattern, label) {
      writeText(currentPointerPath, `${target}\n`);
      const pointerBytes = readFileSync(currentPointerPath);
      const candidate = buildOntologyFacts({ cwd: tmp, induce: true, dryRun: true });
      const candidatePlans = candidate.documents.specification.plans.map((record) => record.id);
      assert(candidate.ok, `${label} current-pointer target is handled without failing induction`);
      assert(!candidatePlans.includes(target), `${label} current-pointer target is excluded`);
      assert(
        candidate.warnings.some((warning) =>
          warning.includes(".current_plan") &&
          warning.includes(target) &&
          reasonPattern.test(warning)
        ),
        `${label} current-pointer target emits a deterministic reason-specific warning`
      );
      assert(candidate.facts === build.facts, `${label} current-pointer target cannot change authoritative facts`);
      assert(
        readFileSync(currentPointerPath).equals(pointerBytes),
        `${label} current-pointer evaluation leaves pointer bytes unchanged`
      );

      const candidateRepeat = buildOntologyFacts({ cwd: tmp, induce: true, dryRun: true });
      assert(candidateRepeat.facts === candidate.facts, `${label} current-pointer facts repeat deterministically`);
      assert(
        JSON.stringify(candidateRepeat.warnings) === JSON.stringify(candidate.warnings),
        `${label} current-pointer warnings repeat deterministically`
      );
    }

    assertRejectedCurrentPointer(
      "plan_current_missing",
      /missing|does not exist/i,
      "missing"
    );
    assertRejectedCurrentPointer(
      "plan_current_unreadable",
      /unreadable|invalid/i,
      "unreadable"
    );

    for (const path of Object.values(threadPointerPaths)) {
      assert(
        readFileSync(path).equals(initialPointerBytes.get(path)),
        `repeated current-pointer probes leave thread pointer bytes unchanged: ${path}`
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioIncrementalBuildSkipsUnchangedWrites() {
  const tmp = makeTemp("incremental");
  try {
    seedAllSources(tmp);

    const first = runCli(ontologyCliPath, ["build", "--dir", tmp, "--induce", "--json"], tmp);
    assert(first.ok, "initial ontology build exits cleanly before incremental verification");

    const second = runCli(ontologyCliPath, ["build", "--dir", tmp, "--incremental", "--json"], tmp);
    assert(second.ok, "incremental ontology build exits cleanly");
    const parsed = parseJson(second.stdout);
    assert(!!parsed, "incremental ontology build emits valid JSON");
    assert(parsed?.changed_generated_facts === false, "incremental ontology build detects an unchanged generated facts file");
    assert(parsed?.wrote_generated_facts === false, "incremental ontology build skips rewriting unchanged generated facts");
    assert((parsed?.wrote_fact_documents || []).length === 0, "incremental ontology build leaves canonical YAML untouched when no induction was requested");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioPlannerAliasDelegatesToOntologyBuild() {
  const tmp = makeTemp("planner-alias");
  try {
    seedAllSources(tmp);

    const help = runCli(plannerCliPath, ["help"], tmp);
    assert(help.ok, "planner help exits cleanly for the ontology alias fixture");
    assert(help.stdout.includes("planner.mjs ontology build [--induce] [--incremental] [--dry-run] [--json]"), "planner help documents the ontology build front door");
    assert(help.stdout.includes("planner.mjs ontology query \"<prolog>\" [--json]"), "planner help documents the ontology query front door");
    assert(help.stdout.includes("planner.mjs ontology facts --entity <type> [--domain <domain>] [--json]"), "planner help documents the ontology facts front door");
    assert(help.stdout.includes("planner.mjs ontology validate [--json]"), "planner help documents the ontology validate front door");

    const result = runCli(plannerCliPath, ["ontology", "build", "--dir", tmp, "--induce", "--json"], tmp);
    assert(result.ok, "planner ontology build alias exits cleanly");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner ontology build alias emits valid JSON");
    assert(parsed?.ok === true, "planner ontology build alias preserves the success contract");
    assert(parsed?.total_fact_count > 0, "planner ontology build alias reports a non-empty generated fact set");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioSemanticEngineLoadsGeneratedRepoFacts() {
  const tmp = makeTemp("semantic-engine");
  try {
    seedAllSources(tmp);
    const buildResult = buildOntologyFacts({ cwd: tmp, induce: true });

    assert(buildResult.ok, "programmatic ontology build succeeds for semantic-engine integration coverage");
    assert(buildResult.wrote_generated_facts === true, "programmatic ontology build writes generated repo facts");

    const { session } = createSemanticEngine({
      cwd: tmp,
      skillPath: plannerSkillPath,
      refreshOntology: false,
    });

    assert(session.check("story_has_criterion('US-900', 'AC-US-900-EXPLICIT')"), "semantic engine auto-loads generated repo story criteria facts");
    assert(session.check("verification_criterion('CRIT-001', 'plan_fixture')"), "semantic engine auto-loads generated repo verification facts");
    assert(session.check("workflow('/advisor')"), "semantic engine auto-loads generated repo workflow facts");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioRuleEngineIgnoresHandEditedCompiledRepoFacts() {
  const tmp = makeTemp("compiled-facts-injection");
  try {
    seedAllSources(tmp);
    const buildResult = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(buildResult.ok, "compiled-facts injection fixture builds canonical ontology facts");

    const factsPath = getOntologyCompiledFactPath(tmp);
    writeText(
      factsPath,
      `${buildResult.facts}\n% injected stale/manual fact; absent from YAML source\nstory('US-9001','fake',high,fully_covered).\n`
    );

    const session = createSession();
    const loaded = loadRules(session, { cwd: tmp, skillPath: plannerSkillPath });
    session.consult("current_state(reflect). reflection_known_limitation_followup('question', 'US-9001').");

    assert(
      loaded.includes("ontology facts (generated from source)"),
      "rule loader renders repo ontology facts from source YAML"
    );
    assert(
      session.check("story_has_criterion('US-900', 'AC-US-900-EXPLICIT')"),
      "rule loader still exposes legitimate source-generated ontology facts"
    );
    assert(
      session.check("invariant_violated(reflection_known_limitation_missing_followup, 'US-9001')"),
      "hand-edited compiled facts.pl cannot fake a follow-up story for I-045"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioQueryAndFactsSurfaceStructuredOntologyData() {
  const tmp = makeTemp("query-facts");
  try {
    seedAllSources(tmp);
    const seededBuild = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(seededBuild.ok, "query/facts fixture builds ontology facts before querying");

    const query = runCli(ontologyCliPath, ["query", "artifact_proves_plan_criterion(A, 'plan_fixture', 'CRIT-001').", "--dir", tmp, "--json"], tmp);
    assert(query.ok, "ontology query exits cleanly");
    const queryParsed = parseJson(query.stdout);
    assert(!!queryParsed, "ontology query emits valid JSON");
    assert(queryParsed?.solution_count === 1, "ontology query reports the expected solution count");
    assert(queryParsed?.solutions?.[0]?.A === "reports/coverage/ontology_inducer.json", "ontology query returns the expected binding value");

    const facts = runCli(ontologyCliPath, ["facts", "--entity", "workflow", "--dir", tmp, "--json"], tmp);
    assert(facts.ok, "ontology facts exits cleanly");
    const factsParsed = parseJson(facts.stdout);
    assert(!!factsParsed, "ontology facts emits valid JSON");
    assert(factsParsed?.count === 2, "ontology facts reports the seeded workflow count");
    assert(factsParsed?.records?.some((record) => record.name === "/advisor"), "ontology facts includes the seeded /advisor workflow");

    const proofWeights = runCli(ontologyCliPath, ["facts", "--entity", "proof_weight_type", "--dir", tmp, "--json"], tmp);
    assert(proofWeights.ok, "ontology proof weight facts exit cleanly");
    const proofWeightsParsed = parseJson(proofWeights.stdout);
    assert(!!proofWeightsParsed, "ontology proof weight facts emit valid JSON");
    assert((proofWeightsParsed?.count || 0) > 0, "ontology proof weight facts report the bootstrapped proof-weight count");
    assert(proofWeightsParsed?.records?.some((record) => record.id === "unit_test"), "ontology proof weight facts include the unit_test starter type");

    const conventions = runCli(ontologyCliPath, ["facts", "--entity", "convention", "--dir", tmp, "--json"], tmp);
    assert(conventions.ok, "ontology convention facts exit cleanly");
    const conventionsParsed = parseJson(conventions.stdout);
    assert(!!conventionsParsed, "ontology convention facts emit valid JSON");
    assert(conventionsParsed?.count === 1, "ontology convention facts report the seeded convention count");
    assert(conventionsParsed?.records?.[0]?.id === "CONV-900", "ontology convention facts include the seeded convention");

    const plannerFacts = runCli(plannerCliPath, ["ontology", "facts", "--entity", "story", "--dir", tmp, "--json"], tmp);
    assert(plannerFacts.ok, "planner ontology facts alias exits cleanly");
    const plannerFactsParsed = parseJson(plannerFacts.stdout);
    assert(!!plannerFactsParsed, "planner ontology facts alias emits valid JSON");
    assert(plannerFactsParsed?.count === 1, "planner ontology facts alias preserves the record count");
    assert(plannerFactsParsed?.records?.[0]?.id === "US-900", "planner ontology facts alias preserves the seeded story");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioValidateFlagsPlantedDanglingTestReference() {
  const tmp = makeTemp("validate");
  try {
    seedAllSources(tmp);
    const seededBuild = buildOntologyFacts({ cwd: tmp, induce: true });
    assert(seededBuild.ok, "validation fixture builds ontology facts before mutation");

    const verificationPath = join(tmp, ".agent", "ontology", "facts", "verification.yaml");
    const verification = readJson(verificationPath);
    verification.verification.criteria[0].test_refs.push("test_that_does_not_exist");
    writeJson(verificationPath, verification);

    const result = runCli(ontologyCliPath, ["validate", "--dir", tmp, "--json"], tmp);
    assert(!result.ok, "ontology validate exits non-zero when the graph contains a dangling test reference");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "ontology validate emits valid JSON on failure");
    assert((parsed?.issue_count || 0) >= 1, "ontology validate reports at least one issue for the planted dangling reference");
    assert(parsed?.missing_test_refs?.[0]?.includes("test_that_does_not_exist"), "ontology validate surfaces the planted dangling test reference");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

scenarioBuildCliWritesGeneratedRepoFacts();
scenarioPlanCriterionIdentityIsScopedAndExplicit();
scenarioCrossPlanCriterionReuseRemainsValid();
scenarioDuplicateSamePlanCriterionIdentityFailsClosed();
scenarioInvalidSelectedStrategyFailsBeforeAuthorityWrites();
scenarioStoryCriterionOwnershipAndPrimaryDomainFailClosed();
scenarioGitInductionExcludesInactiveUntrackedPlans();
scenarioPlanPointersRespectLifecycleAuthority();
scenarioIncrementalBuildSkipsUnchangedWrites();
scenarioPlannerAliasDelegatesToOntologyBuild();
scenarioQueryAndFactsSurfaceStructuredOntologyData();
scenarioValidateFlagsPlantedDanglingTestReference();
scenarioSemanticEngineLoadsGeneratedRepoFacts();
scenarioRuleEngineIgnoresHandEditedCompiledRepoFacts();

console.log(`\nOntology CLI tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
