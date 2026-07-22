#!/usr/bin/env node
// test_ive_profile_knowledge_packs.mjs — IVE profile evaluator and knowledge-pack contracts.

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadProjectMetaFacts } from "../scripts/lib/fact_loader.mjs";
import {
  evaluateProjectProfiles,
  loadKnowledgePacks,
} from "../scripts/lib/ive_profile_packs.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const NODE = process.execPath;
const checkProfileCli = join(skillDir, "scripts", "check_profile.mjs");
const knowledgePacksCli = join(skillDir, "scripts", "knowledge_packs.mjs");

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

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function packResult(report, packId) {
  return (report.pack_results || []).find((entry) => entry.pack_id === packId) || null;
}

function createTempProject(name = "ive-profile-pack-") {
  const tmp = mkdtempSync(join(tmpdir(), name));
  ensureDir(join(tmp, "docs"));
  ensureDir(join(tmp, ".agent/skills/iterative-planner/scripts"));
  writeFileSync(join(tmp, "docs/ive-engine-plan.md"), "# IVE\n\nQuant alpha profile fixture.\n");
  writeFileSync(join(tmp, ".agent/skills/iterative-planner/scripts/project_ive.mjs"), "console.log('fixture');\n");
  return tmp;
}

function createTempSkill(name = "ive-skill-") {
  return mkdtempSync(join(tmpdir(), name));
}

function parseCliJson(command, args, cwd = repoRoot) {
  return JSON.parse(execFileSync(NODE, [command, ...args], {
    cwd,
    encoding: "utf-8",
  }));
}

console.log("\nIVE Profile and Knowledge-Pack Tests\n");

function testBundledProfileAndCache() {
  const cacheDir = mkdtempSync(join(tmpdir(), "ive-profile-cache-"));
  try {
    const first = evaluateProjectProfiles({
      cwd: repoRoot,
      profileIds: ["quant_alpha"],
      gate: "plan-to-execute",
      cacheDir,
    });
    assert(first.ok && first.status === "PASS", "bundled quant_alpha profile evaluates PASS");
    assert(first.profile_results?.[0]?.checks?.some((check) => check.kind === "regex_not_in_glob"), "profile evaluates closed regex_not_in_glob check kind");

    const second = evaluateProjectProfiles({
      cwd: repoRoot,
      profileIds: ["quant_alpha"],
      gate: "plan-to-execute",
      cacheDir,
    });
    assert(second.ok && second.cache_hit === true, "unchanged profile evaluation reports cache_hit");

    const cli = parseCliJson(checkProfileCli, ["--profile", "quant_alpha", "--gate", "plan-to-execute", "--json", "--no-cache"]);
    assert(cli.status === "PASS" && cli.profiles_evaluated === 1, "check_profile.mjs emits parseable PASS JSON");
  } finally {
    cleanup(cacheDir);
  }
}

function testProfileInheritanceOverridesAndUnknownKinds() {
  const tmp = createTempProject("ive-profile-project-");
  const tempSkill = createTempSkill("ive-profile-skill-");
  try {
    writeJson(join(tempSkill, "profiles/base.profile.json"), {
      id: "base",
      required_artifacts: [
        { id: "base_missing", kind: "file_exists", path: "docs/missing.md", severity: "fail" },
      ],
    });
    writeJson(join(tempSkill, "profiles/child.profile.json"), {
      id: "child",
      extends: ["base"],
      disabled_extends: ["base"],
      required_artifacts: [
        { id: "child_present", kind: "file_exists", path: "docs/ive-engine-plan.md", severity: "fail" },
      ],
    });
    const child = evaluateProjectProfiles({ cwd: tmp, skillDir: tempSkill, profileIds: ["child"], useCache: false });
    assert(child.ok && child.status === "PASS" && child.profile_results[0].check_count === 1, "disabled parent override prevents inherited failing check");

    writeJson(join(tempSkill, "profiles/warn.profile.json"), {
      id: "warn",
      gate_overrides: {
        "plan-to-execute": {
          severity_overrides: {
            "missing_regex": "warn"
          }
        }
      },
      required_metrics: [
        { id: "missing_regex", kind: "regex_in_glob", glob: "docs/ive-engine-plan.md", pattern: "NOT_PRESENT", severity: "fail" },
      ],
    });
    const warned = evaluateProjectProfiles({ cwd: tmp, skillDir: tempSkill, profileIds: ["warn"], gate: "plan-to-execute", useCache: false });
    assert(warned.ok && warned.status === "WARN", "gate severity override downgrades failing check to WARN");

    writeJson(join(tempSkill, "profiles/rich.profile.json"), {
      id: "rich",
      required_artifacts: [
        {
          id: "rich_any_file",
          kind: "composite",
          mode: "any",
          checks: [
            { kind: "file_exists", path: "docs/missing.md" },
            { kind: "file_exists", path: "docs/ive-engine-plan.md" },
          ],
        },
      ],
      required_metrics: [
        { id: "rich_test", kind: "test_named", test: "fixture_passed" },
        { id: "rich_telemetry", kind: "telemetry_field", field: "metrics.alpha", equals: 42 },
      ],
      required_ontology_triples: [
        { id: "rich_fact", kind: "prolog_fact", fact: "knowledge_pack_loaded('machine_learning', 1, 'bundled')" },
        { id: "rich_sparql_alias", kind: "sparql", expected_fact: "knowledge_pack_entry('machine_learning', 'ML-PIT-001', 'pitfall')" },
      ],
    });
    const rich = evaluateProjectProfiles({
      cwd: tmp,
      skillDir: tempSkill,
      profileIds: ["rich"],
      useCache: false,
      facts: [
        "knowledge_pack_loaded('machine_learning', 1, 'bundled').",
        "knowledge_pack_entry('machine_learning', 'ML-PIT-001', 'pitfall').",
      ],
      testResults: { fixture_passed: true },
      telemetry: { metrics: { alpha: 42 } },
    });
    assert(rich.ok && rich.status === "PASS", "profile evaluator supports ontology facts, telemetry, named tests, and composite checks");

    writeJson(join(tempSkill, "profiles/bad.profile.json"), {
      id: "bad",
      required_artifacts: [
        { id: "bad_kind", kind: "ambient_llm_guess", path: "docs/ive-engine-plan.md" },
      ],
    });
    const bad = evaluateProjectProfiles({ cwd: tmp, skillDir: tempSkill, profileIds: ["bad"], useCache: false });
    assert(!bad.ok && bad.error_code === "unknown_check_kind", "unknown profile check kind fails closed");
  } finally {
    cleanup(tmp);
    cleanup(tempSkill);
  }
}

function testKnowledgePackLoadTrustDisableAndCli() {
  const bundled = loadKnowledgePacks({ cwd: repoRoot, packIds: ["machine_learning"] });
  assert(bundled.ok && bundled.status === "PASS" && bundled.loaded_pack_count === 3, "bundled machine_learning pack loads with dependent siblings");
  assert(bundled.facts.includes("knowledge_pack_loaded('machine_learning', 1, 'bundled')."), "loaded pack emits trust-tier fact");
  assert(bundled.facts.some((fact) => fact.includes("knowledge_pack_entry('machine_learning', 'ML-PIT-001', 'pitfall')")), "loaded pack emits typed entry fact");
  assert(bundled.facts.some((fact) => fact.includes("knowledge_pack_provenance('ML-PIT-001'")), "loaded pack emits provenance fact");
  assert(packResult(bundled, "machine_learning_toolbox")?.trigger === "DependencyLoaded", "machine_learning_toolbox activates from dependency_loaded trigger");
  assert(packResult(bundled, "quant_results_communication")?.trigger === "DependencyLoaded", "quant_results_communication activates from dependency_loaded trigger");
  assert(bundled.facts.some((fact) => fact.includes("knowledge_pack_trigger('machine_learning_toolbox', 'DependencyLoaded')")), "dependency-loaded sibling emits trigger fact");

  const disabled = loadKnowledgePacks({ cwd: repoRoot, packIds: ["machine_learning"], disabledPacks: ["machine_learning"] });
  assert(disabled.ok && disabled.status === "DISABLED" && disabled.facts.length === 0, "disabled knowledge pack emits no runtime facts");
  assert(disabled.pack_results[0].trigger === "KnowledgePackDeactivation", "disabled knowledge pack reports deactivation trigger");

  const cli = parseCliJson(knowledgePacksCli, ["--pack", "machine_learning", "--json"]);
  assert(cli.status === "PASS" && cli.loaded_pack_count === 3 && cli.facts.some((fact) => fact.includes("knowledge_pack_loaded")), "knowledge_packs.mjs emits parseable PASS JSON with dependent siblings");
}

function testIndependentSiblingPackActivation() {
  const productProject = mkdtempSync(join(tmpdir(), "ive-product-pack-project-"));
  const uxProject = mkdtempSync(join(tmpdir(), "ive-ux-pack-project-"));
  try {
    writeJson(join(productProject, "plans/programs/demo/program_packet.json"), {
      id: "PGM-DEMO",
      title: "Product roadmap fixture",
      tickets: [],
    });
    const product = loadKnowledgePacks({ cwd: productProject, skillDir, activeProfiles: [] });
    assert(product.ok && packResult(product, "product_management")?.status === "PASS", "product_management activates from product/program signals");
    assert(!packResult(product, "machine_learning"), "product_management activation does not require machine_learning");

    writeFileSync(join(uxProject, "package.json"), JSON.stringify({ name: "ux-fixture", dependencies: { react: "^18.0.0" } }, null, 2));
    ensureDir(join(uxProject, "src"));
    writeFileSync(join(uxProject, "src/App.jsx"), "export default function App(){ return <main />; }\n");
    const ux = loadKnowledgePacks({ cwd: uxProject, skillDir, activeProfiles: [] });
    assert(ux.ok && packResult(ux, "ux_ui_experience")?.status === "PASS", "ux_ui_experience activates from frontend file signals");
    assert(packResult(ux, "software_engineering_methodology")?.status === "PASS", "software_engineering_methodology activates from package manifest");
    assert(!packResult(ux, "machine_learning"), "ux_ui_experience activation does not require machine_learning");

    const coaching = loadKnowledgePacks({ cwd: uxProject, skillDir, packIds: ["coaching_methodology"] });
    assert(coaching.ok && packResult(coaching, "coaching_methodology")?.entry_count > 0, "coaching_methodology can be selected explicitly as a bundled sibling pack");
  } finally {
    cleanup(productProject);
    cleanup(uxProject);
  }
}

function testCommunityTrustGate() {
  const tmp = createTempProject("ive-community-project-");
  const tempSkill = createTempSkill("ive-community-skill-");
  try {
    writeJson(join(tempSkill, "knowledge_packs/community_pack/pack.json"), {
      id: "community_pack",
      version: 1,
      trust_tier: "community",
      applies_when: {
        file_exists_any: ["docs/ive-engine-plan.md"]
      },
      entry_files: ["pitfalls.json"],
    });
    writeJson(join(tempSkill, "knowledge_packs/community_pack/pitfalls.json"), [
      { id: "COMM-PIT-001", title: "Community fixture", severity: "medium", polarity: "risk" },
    ]);

    const blocked = loadKnowledgePacks({ cwd: tmp, skillDir: tempSkill, packIds: ["community_pack"] });
    assert(!blocked.ok && blocked.pack_results[0].status === "BLOCKED", "community pack blocks without allow and accept");

    const accepted = loadKnowledgePacks({
      cwd: tmp,
      skillDir: tempSkill,
      packIds: ["community_pack"],
      allowCommunity: true,
      acceptedPacks: ["community_pack"],
    });
    assert(accepted.ok && accepted.status === "PASS" && accepted.facts.length > 0, "community pack loads after allow plus per-pack accept");
  } finally {
    cleanup(tmp);
    cleanup(tempSkill);
  }
}

function testFactLoaderBridgeAndNotApplicable() {
  const tmp = createTempProject("ive-na-project-");
  const tempSkill = createTempSkill("ive-na-skill-");
  try {
    const none = evaluateProjectProfiles({ cwd: tmp, skillDir: tempSkill, useCache: false });
    assert(none.ok && none.status === "NOT_APPLICABLE" && none.status_reason === "no_active_profile", "profile evaluator reports NOT_APPLICABLE when no profile is active");
  } finally {
    cleanup(tmp);
    cleanup(tempSkill);
  }

  const session = createSession();
  loadProjectMetaFacts(session, { cwd: repoRoot });
  const matches = [...session.query("knowledge_pack_loaded('machine_learning', 1, 'bundled')")];
  assert(matches.length > 0, "fact_loader exposes read-only knowledge-pack facts to Prolog consumers");
}

testBundledProfileAndCache();
testProfileInheritanceOverridesAndUnknownKinds();
testKnowledgePackLoadTrustDisableAndCli();
testIndependentSiblingPackActivation();
testCommunityTrustGate();
testFactLoaderBridgeAndNotApplicable();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
