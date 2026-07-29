#!/usr/bin/env node

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { buildOntologyFacts } from "../scripts/lib/ontology_fact_builder.mjs";
import { getOntologyCompiledFactPath } from "../scripts/lib/ontology_schema.mjs";
import { createSemanticEngine } from "../scripts/lib/semantic_engine.mjs";
import { createSession } from "../scripts/lib/prolog.mjs";
import { loadRules } from "../scripts/lib/fact_loader.mjs";

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
        code_refs: [
          ".agent/skills/iterative-planner/scripts/ontology_context.mjs",
          ".agent/skills/iterative-planner/scripts/planner.mjs",
        ],
        test_refs: [
          ".agent/skills/iterative-planner/tests/test_ontology_cli.mjs",
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
    assert(facts.includes("story_has_criterion('US-900', 'AC-US-900-001')."), "generated facts include story-to-criterion links");
    assert(facts.includes("verification_criterion('CRIT-001', 'plan_fixture')."), "generated facts include verification criteria");
    assert(facts.includes("artifact_proves_criterion('reports/coverage/ontology_inducer.json', 'CRIT-001')."), "generated facts include artifact-to-criterion proof links");
    assert(facts.includes("workflow('/advisor')."), "generated facts include induced workflows");
    assert(facts.includes("proof_weight_type('unit_test')."), "generated facts include proof weight type facts");
    assert(facts.includes("proof_weight_domain_default('planner_core', 'high')."), "generated facts include proof weight domain defaults");
    assert(facts.includes("convention('CONV-900')."), "generated facts include convention facts");
    assert(facts.includes("convention_applies_to_change_class('CONV-900', 'workflow')."), "generated facts include convention applicability facts");
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

    assert(session.check("story_has_criterion('US-900', 'AC-US-900-001')"), "semantic engine auto-loads generated repo story criteria facts");
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
      session.check("story_has_criterion('US-900', 'AC-US-900-001')"),
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

    const query = runCli(ontologyCliPath, ["query", "artifact_proves_criterion(A, 'CRIT-001').", "--dir", tmp, "--json"], tmp);
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
scenarioIncrementalBuildSkipsUnchangedWrites();
scenarioPlannerAliasDelegatesToOntologyBuild();
scenarioQueryAndFactsSurfaceStructuredOntologyData();
scenarioValidateFlagsPlantedDanglingTestReference();
scenarioSemanticEngineLoadsGeneratedRepoFacts();
scenarioRuleEngineIgnoresHandEditedCompiledRepoFacts();

console.log(`\nOntology CLI tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
