#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import {
  bootstrapRegistryFromAnnotations,
  initializeBootstrapRegistry,
  REGISTRY_RELATIVE_PATH,
  SHARED_SCHEMA_RELATIVE_PATH,
  validateBootstrapRegistry,
} from "../scripts/bootstrap_registry.mjs";
import {
  MUTEX_FACTS_RELATIVE_PATH,
  POSTCONDITIONS_RELATIVE_PATH,
  READINESS_RELATIVE_PATH,
  validateSubstrateReadiness,
} from "../scripts/substrate_check.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-bootstrap-registry-${name}-`));
}

function run(args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function installPlannerFixture(cwd) {
  const upgrade = run([join(scriptDir, "migrate.mjs"), "upgrade", cwd], cwd);
  assert(upgrade.ok, "migrate upgrade installs planner into the bootstrap-registry fixture");
}

function writeFixtureFile(root, relativePath, content) {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), content);
}

function readRegistry(root) {
  return JSON.parse(readFileSync(join(root, REGISTRY_RELATIVE_PATH), "utf-8"));
}

function writeSubstrateFixture(root, readiness = null) {
  writeFixtureFile(root, READINESS_RELATIVE_PATH, JSON.stringify(readiness || {
    readiness: {
      story_registry: "configured",
      mutex_facts: "configured",
      postconditions: "configured",
      domain_checklists: "configured",
      telemetry_capture: "configured",
      opt_outs: {},
    },
  }, null, 2) + "\n");
  writeFixtureFile(root, MUTEX_FACTS_RELATIVE_PATH, JSON.stringify({ mutex_facts: [] }, null, 2) + "\n");
  writeFixtureFile(root, POSTCONDITIONS_RELATIVE_PATH, JSON.stringify({ postconditions: [] }, null, 2) + "\n");
  writeFixtureFile(root, join(".agent", "semantic", "domain_checklists", "planner_core.yaml"), JSON.stringify({
    domain: "planner_core",
    triggers: [
      { path_pattern: ".agent/skills/iterative-planner/**" },
    ],
    execute_checklist: [
      { item: "Planner-core CLI changes keep ripple-through coverage aligned", severity: "HIGH" },
    ],
  }, null, 2) + "\n");
}

function scenarioInitializeBootstrapRegistry() {
  const tmp = makeTemp("new");
  try {
    installPlannerFixture(tmp);

    const result = initializeBootstrapRegistry(tmp);
    const registry = readRegistry(tmp);

    assert(result.changed === true, "initializeBootstrapRegistry creates a missing canonical registry");
    assert(existsSync(join(tmp, REGISTRY_RELATIVE_PATH)), "canonical story_registry.json path is created");
    assert(existsSync(join(tmp, SHARED_SCHEMA_RELATIVE_PATH)), "shared schema path exists in the installed planner fixture");
    assert(registry.version === 1, "empty registry uses version 1");
    assert(Array.isArray(registry.stories) && registry.stories.length === 0, "empty registry starts with no stories");
    assert(typeof registry.updated === "string" && registry.updated.length > 0, "empty registry records legacy updated timestamp");
    assert(typeof registry.updated_at === "string" && registry.updated_at.length > 0, "empty registry also records updated_at");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapFromAnnotations() {
  const tmp = makeTemp("annotations");
  try {
    installPlannerFixture(tmp);
    writeFixtureFile(tmp, "src/service.js", `// @planner:story = US-042
export function runService() {
  return true;
}
`);
    writeFixtureFile(tmp, "tests/service.test.js", `// @planner:story_id US-099
export function testService() {
  return true;
}
`);

    const result = bootstrapRegistryFromAnnotations(tmp);
    const registry = readRegistry(tmp);
    const story42 = registry.stories.find((story) => story.id === "US-042");
    const story99 = registry.stories.find((story) => story.id === "US-099");

    assert(result.annotation_story_count === 2, "bootstrapRegistryFromAnnotations discovers both legacy and roadmap story annotation forms");
    assert(result.created_story_count === 2, "bootstrapRegistryFromAnnotations creates one legacy-safe record per detected story id");
    assert(story42?.status === "NOT_IMPLEMENTED", "annotation-seeded stories stay on the Phase 0.5 legacy status vocabulary");
    assert(story42?.needs_review === true, "annotation-seeded stories are marked needs_review");
    assert((story42?.detected_files || []).includes("src/service.js"), "non-test annotations land in detected_files");
    assert((story99?.detected_tests || []).includes("tests/service.test.js"), "test annotations land in detected_tests");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapIgnoresNestedPlannerManagedPaths() {
  const tmp = makeTemp("nested-ignore");
  try {
    installPlannerFixture(tmp);
    writeFixtureFile(tmp, "src/live.js", `// @planner:story = US-600
export const liveStory = true;
`);
    writeFixtureFile(tmp, "fixtures/downstream/.agent/skills/iterative-planner/tests/ignored.mjs", `// @planner:story = US-601
export const ignoredAgentStory = true;
`);
    writeFixtureFile(tmp, "fixtures/downstream/plans/ignored.js", `// @planner:story = US-602
export const ignoredPlanStory = true;
`);
    writeFixtureFile(tmp, "fixtures/downstream/reports/ignored.js", `// @planner:story = US-603
export const ignoredReportStory = true;
`);
    writeFixtureFile(tmp, "fixtures/downstream/roadmap_v7/ignored.js", `// @planner:story = US-604
export const ignoredRoadmapStory = true;
`);
    writeFixtureFile(tmp, "fixtures/downstream/docs/ignored.js", `// @planner:story = US-605
export const ignoredDocsStory = true;
`);

    const result = bootstrapRegistryFromAnnotations(tmp);
    const registry = readRegistry(tmp);
    const storyIds = registry.stories.map((story) => story.id).sort();

    assert(result.annotation_story_count === 1, "bootstrapRegistryFromAnnotations ignores nested planner-managed directory segments");
    assert(result.created_story_count === 1, "bootstrapRegistryFromAnnotations only seeds stories from host code paths");
    assert(storyIds.length === 1 && storyIds[0] === "US-600", "nested planner-managed annotations are excluded from the seeded registry");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioValidateBootstrapRegistry() {
  const tmp = makeTemp("validate");
  try {
    installPlannerFixture(tmp);
    const staleReview = new Date(Date.now() - 40 * 86_400_000).toISOString();

    writeFixtureFile(tmp, "src/implemented.js", `// @planner:story = US-200
export const implemented = true;
`);
    writeFixtureFile(tmp, "src/orphan.js", `// @planner:story_id US-201
export const orphan = true;
`);
    writeFixtureFile(tmp, "src/retired.js", `// @planner:story = US-203
export const retired = true;
`);

    writeFixtureFile(tmp, REGISTRY_RELATIVE_PATH, JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stories: [
        {
          id: "US-200",
          title: "Implemented and annotated",
          priority: "MEDIUM",
          status: "PARTIALLY_COVERED",
          code_refs: [],
          test_refs: [],
          doc_refs: [],
          validation_refs: [],
          merged_from: [],
          conflicts: [],
        },
        {
          id: "US-202",
          title: "Implemented but missing annotations",
          priority: "MEDIUM",
          status: "FULLY_COVERED",
          code_refs: [],
          test_refs: [],
          doc_refs: [],
          validation_refs: [],
          merged_from: [],
          conflicts: [],
        },
        {
          id: "US-203",
          title: "Retired but still annotated",
          priority: "LOW",
          status: "RETIRED",
          code_refs: [],
          test_refs: [],
          doc_refs: [],
          validation_refs: [],
          merged_from: [],
          conflicts: [],
        },
        {
          id: "US-204",
          title: "Needs review debt",
          priority: "LOW",
          status: "NOT_IMPLEMENTED",
          code_refs: [],
          test_refs: [],
          doc_refs: [],
          validation_refs: [],
          merged_from: [],
          conflicts: [],
          needs_review: true,
          needs_review_since: staleReview,
        }
      ],
    }, null, 2) + "\n");

    const result = validateBootstrapRegistry(tmp);

    assert(result.ok === false, "validateBootstrapRegistry fails when registry drift is present");
    assert(result.orphan_annotations.includes("US-201"), "validateBootstrapRegistry flags orphan story annotations");
    assert(result.missing_annotation_backed_stories.includes("US-202"), "validateBootstrapRegistry flags implemented stories with no matching annotations");
    assert(result.retired_with_annotations.includes("US-203"), "validateBootstrapRegistry flags retired stories that still have annotations");
    assert(result.curation_debt.some((entry) => entry.story_id === "US-204"), "validateBootstrapRegistry flags stale needs_review curation debt");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapCliDispatch() {
  const tmp = makeTemp("cli");
  try {
    installPlannerFixture(tmp);
    writeFixtureFile(tmp, "src/cli.js", `// @planner:story = US-333
export const cliBootstrap = true;
`);

    const bootstrapScript = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs");
    const result = run([bootstrapScript, "bootstrap-registry", "--from-annotations", "--json"], tmp);

    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }

    assert(result.ok, "bootstrap.mjs bootstrap-registry subcommand exits cleanly");
    assert(!!parsed, "bootstrap.mjs bootstrap-registry emits valid JSON");
    assert(parsed?.status === "seeded", "bootstrap.mjs bootstrap-registry reports seeded status");
    assert(readRegistry(tmp).stories.some((story) => story.id === "US-333"), "bootstrap.mjs bootstrap-registry writes the canonical registry");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCurrentReaderAcceptsBootstrappedRegistry() {
  const tmp = makeTemp("reader");
  try {
    installPlannerFixture(tmp);
    writeFixtureFile(tmp, "src/reader.js", `// @planner:story = US-500
export const readerCompat = true;
`);

    bootstrapRegistryFromAnnotations(tmp);

    const storyRegistryScript = join(scriptDir, "story_registry.mjs");
    const result = run([storyRegistryScript, "check", "--json"], tmp);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }

    assert(result.ok, "current story_registry.mjs check accepts helper-produced Phase 0.5 registry output");
    assert(!!parsed, "story_registry.mjs check emits valid JSON for helper-produced registry output");
    assert(parsed?.status === "PASS", "helper-produced registry stays within the current reader's accepted legacy shape");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSubstrateCheckConfigured() {
  const tmp = makeTemp("substrate-configured");
  try {
    installPlannerFixture(tmp);
    initializeBootstrapRegistry(tmp);
    writeSubstrateFixture(tmp);

    const result = validateSubstrateReadiness(tmp);

    assert(result.ok === true, "validateSubstrateReadiness passes when required semantic substrate surfaces are configured");
    assert(result.surfaces?.mutex_facts?.status === "PASS", "validateSubstrateReadiness accepts the mutex_facts template");
    assert(result.surfaces?.postconditions?.status === "PASS", "validateSubstrateReadiness accepts the postconditions template");
    assert(result.surfaces?.domain_checklists?.status === "PASS", "validateSubstrateReadiness accepts the domain checklist template");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSubstrateCheckFailsOnMissingSurface() {
  const tmp = makeTemp("substrate-missing");
  try {
    installPlannerFixture(tmp);
    initializeBootstrapRegistry(tmp);
    writeSubstrateFixture(tmp);
    rmSync(join(tmp, MUTEX_FACTS_RELATIVE_PATH), { force: true });

    const result = validateSubstrateReadiness(tmp);

    assert(result.ok === false, "validateSubstrateReadiness fails when a configured semantic surface file is missing");
    assert(result.surfaces?.mutex_facts?.status === "FAIL", "missing mutex_facts.yaml blocks the substrate check");
    assert((result.errors || []).some((issue) => issue.surface === "mutex_facts" && issue.code === "missing_surface_file"), "validateSubstrateReadiness reports the exact missing-surface issue");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSubstrateCheckAllowsExplicitOptOut() {
  const tmp = makeTemp("substrate-opt-out");
  try {
    installPlannerFixture(tmp);
    initializeBootstrapRegistry(tmp);
    writeSubstrateFixture(tmp, {
      readiness: {
        story_registry: "configured",
        mutex_facts: "configured",
        domain_checklists: "configured",
        telemetry_capture: "configured",
        opt_outs: {
          postconditions: {
            not_applicable: true,
            reason: "This fixture only exercises readiness declarations, not stateful flow semantics.",
          },
        },
      },
    });
    rmSync(join(tmp, POSTCONDITIONS_RELATIVE_PATH), { force: true });

    const result = validateSubstrateReadiness(tmp);

    assert(result.ok === true, "validateSubstrateReadiness accepts an explicit opt-out for an otherwise missing surface");
    assert(result.surfaces?.postconditions?.declaration === "opt_out", "postconditions surface is reported as an opt-out instead of a configured file");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSubstrateCliDispatch() {
  const tmp = makeTemp("substrate-cli");
  try {
    installPlannerFixture(tmp);
    initializeBootstrapRegistry(tmp);
    writeSubstrateFixture(tmp);

    const bootstrapScript = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs");
    const result = run([bootstrapScript, "substrate", "check", "--json"], tmp);

    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }

    assert(result.ok, "bootstrap.mjs substrate check exits cleanly");
    assert(!!parsed, "bootstrap.mjs substrate check emits valid JSON");
    assert(parsed?.status === "PASS", "bootstrap.mjs substrate check reports PASS for a configured fixture");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function main() {
  scenarioInitializeBootstrapRegistry();
  scenarioBootstrapFromAnnotations();
  scenarioBootstrapIgnoresNestedPlannerManagedPaths();
  scenarioValidateBootstrapRegistry();
  scenarioBootstrapCliDispatch();
  scenarioCurrentReaderAcceptsBootstrappedRegistry();
  scenarioSubstrateCheckConfigured();
  scenarioSubstrateCheckFailsOnMissingSurface();
  scenarioSubstrateCheckAllowsExplicitOptOut();
  scenarioSubstrateCliDispatch();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
