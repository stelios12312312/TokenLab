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
import { compileVerificationStatusFacts } from "../scripts/lib/verification_status_vocabulary.mjs";

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

function factIncludes(report, fragment) {
  return (report.facts || []).some((fact) => fact.includes(fragment));
}

function factCount(report, fragment) {
  return (report.facts || []).filter((fact) => fact.includes(fragment)).length;
}

function createTempProject(name = "ive-profile-pack-") {
  const tmp = mkdtempSync(join(tmpdir(), name));
  ensureDir(join(tmp, "docs"));
  ensureDir(join(tmp, ".agent/skills/iterative-planner/scripts"));
  writeFileSync(join(tmp, "docs/ive-engine-plan.md"), "# IVE\n\nQuant alpha profile fixture with enough detail to satisfy the bundled profile min-size contract for deterministic cache and CLI checks.\n");
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
  const tmp = createTempProject("ive-bundled-profile-");
  const cacheDir = mkdtempSync(join(tmpdir(), "ive-profile-cache-"));
  try {
    const first = evaluateProjectProfiles({
      cwd: tmp,
      profileIds: ["quant_alpha"],
      gate: "plan-to-execute",
      cacheDir,
    });
    assert(first.ok && first.status === "PASS", "bundled quant_alpha profile evaluates PASS");
    assert(first.profile_results?.[0]?.checks?.some((check) => check.kind === "regex_not_in_glob"), "profile evaluates closed regex_not_in_glob check kind");

    const second = evaluateProjectProfiles({
      cwd: tmp,
      profileIds: ["quant_alpha"],
      gate: "plan-to-execute",
      cacheDir,
    });
    assert(second.ok && second.cache_hit === true, "unchanged profile evaluation reports cache_hit");

    const cli = parseCliJson(checkProfileCli, ["--profile", "quant_alpha", "--gate", "plan-to-execute", "--json", "--no-cache"], tmp);
    assert(cli.status === "PASS" && cli.profiles_evaluated === 1, "check_profile.mjs emits parseable PASS JSON");
  } finally {
    cleanup(tmp);
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
    assert(!warned.ok && warned.status === "WARN", "gate severity override surfaces WARN without treating it as passing proof");

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
      testResults: { fixture_passed: "pass" },
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

  const configuredMl = mkdtempSync(join(tmpdir(), "ive-configured-ml-pack-"));
  try {
    writeJson(join(configuredMl, "audit.config.json"), {
      roles: ["core", "quant"],
      knowledge_packs: ["machine_learning", "tokenomics"],
      knowledge_packs_disabled: ["tokenomics"],
    });
    const configured = loadKnowledgePacks({ cwd: configuredMl, skillDir });
    assert(configured.ok && configured.status === "PASS", "repo-configured machine_learning pack loads without CLI pack flag");
    assert(packResult(configured, "machine_learning")?.status === "PASS", "repo-configured machine_learning pack is active");
    assert(packResult(configured, "machine_learning_toolbox")?.trigger === "DependencyLoaded", "repo-configured machine_learning loads toolbox dependency");
    assert(packResult(configured, "quant_results_communication")?.trigger === "DependencyLoaded", "repo-configured machine_learning loads quant communication dependency");
    assert(packResult(configured, "tokenomics")?.status === "DISABLED", "repo-configured disabled tokenomics pack stays disabled");
  } finally {
    cleanup(configuredMl);
  }

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

function testGeneratedArtifactDiscoveryIsIgnored() {
  const tmp = mkdtempSync(join(tmpdir(), "ive-generated-artifact-discovery-"));
  try {
    ensureDir(join(tmp, "reports/ive/test_runs/run-old/copied"));
    ensureDir(join(tmp, "plans/plan_old/artifacts/prolog"));
    writeFileSync(join(tmp, "reports/ive/test_runs/run-old/coach-report.md"), "generated coaching output\n");
    writeFileSync(join(tmp, "reports/ive/test_runs/run-old/copied/webhook.js"), "export const generated = true;\n");
    writeFileSync(join(tmp, "plans/plan_old/artifacts/prolog/token-plan.md"), "generated tokenomics output\n");

    const generatedOnly = loadKnowledgePacks({ cwd: tmp, skillDir, activeProfiles: [] });
    assert(!packResult(generatedOnly, "coaching_methodology"), "generated test-run markdown cannot activate coaching knowledge");
    assert(!packResult(generatedOnly, "app_dev_tesseract"), "generated test-run source copies cannot activate app knowledge");
    assert(!packResult(generatedOnly, "tokenomics"), "generated plan artifacts cannot activate tokenomics knowledge");

    ensureDir(join(tmp, "docs"));
    writeFileSync(join(tmp, "docs/team-coaching.md"), "source coaching method\n");
    const sourceBacked = loadKnowledgePacks({ cwd: tmp, skillDir, activeProfiles: [] });
    assert(packResult(sourceBacked, "coaching_methodology")?.status === "PASS", "legitimate docs still activate coaching knowledge");
  } finally {
    cleanup(tmp);
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

function testKnowledgePackObligationBridgeActivationEvidenceAndCli() {
  const tmp = createTempProject("ive-ml-obligation-project-");
  try {
    writeFileSync(join(tmp, "docs/ive-engine-plan.md"), [
      "# ML fixture",
      "This project claims a model result with probability output.",
      "It improves the baseline through hyperparameter search.",
    ].join("\n"));

    const missing = loadKnowledgePacks({ cwd: tmp, skillDir, packIds: ["machine_learning"] });
    const mlMissing = packResult(missing, "machine_learning");
    assert(missing.ok && mlMissing?.status === "PASS", "accepted bundled ML pack still loads when obligations are unsatisfied");
    assert((mlMissing?.obligation_count || 0) >= 5, "ML pack declares at least five generic obligations");
    assert((mlMissing?.active_obligation_count || 0) >= 5, "ML model/result/probability/search text activates fixture obligations");
    assert(factIncludes(missing, "pack_obligation('machine_learning', 'ML-OBL-LEAKAGE-PROOF')"), "obligation schema emits pack_obligation fact");
    assert(factIncludes(missing, "active_obligation('ML-OBL-LEAKAGE-PROOF', 'machine_learning')"), "active obligation emits source-pack fact");
    assert(factIncludes(missing, "verification_obligation('ML-OBL-LEAKAGE-PROOF', 'pack_machine_learning_leakage_proof'"), "active obligation reuses verification_obligation substrate");
    assert(factIncludes(missing, "obligation_source('ML-OBL-LEAKAGE-PROOF', 'knowledge_pack', 'machine_learning')"), "active obligation records source-pack provenance");
    assert(factIncludes(missing, "obligation_requires('ML-OBL-HOLDOUT-OOS'"), "holdout/OOS obligation emits requirement facts");
    assert(!factIncludes(missing, "verification_evidence("), "missing ML proof does not synthesize passing evidence");

    writeJson(join(tmp, "reports/user_story_audit/story_registry.json"), {
      stories: [
        {
          id: "US-ML-001",
          title: "ML proof fixture",
          status: "in_progress",
          validation_refs: [
            "leakage temporal split proof",
            "holdout OOS walk-forward validation",
            "baseline control comparison",
            "probability calibration artifact",
            "selection-control overfitting proof",
          ],
        },
      ],
    });
    const satisfied = loadKnowledgePacks({ cwd: tmp, skillDir, packIds: ["machine_learning"] });
    const mlSatisfied = packResult(satisfied, "machine_learning");
    assert((mlSatisfied?.satisfied_obligation_count || 0) >= 5, "story validation refs satisfy ML fixture obligations");
    assert(factIncludes(satisfied, "verification_evidence("), "satisfied pack obligation emits verification_evidence fact");
    assert(factIncludes(satisfied, "obligation_satisfied_by('ML-OBL-LEAKAGE-PROOF'"), "satisfied obligation records evidence provenance");

    const cli = parseCliJson(knowledgePacksCli, ["--pack", "machine_learning", "--json"], tmp);
    assert(cli.active_obligation_count >= 5 && cli.facts.some((fact) => fact.includes("active_obligation")), "knowledge_packs.mjs surfaces active obligation facts in JSON");
  } finally {
    cleanup(tmp);
  }
}

function testKnowledgePackObligationTrustDisableUnrelatedAndDedup() {
  const activeProject = createTempProject("ive-obligation-active-");
  const unrelatedProject = createTempProject("ive-obligation-unrelated-");
  const communityProject = createTempProject("ive-obligation-community-");
  const tempSkill = createTempSkill("ive-obligation-skill-");
  try {
    writeFileSync(join(activeProject, "docs/ive-engine-plan.md"), "model result probability hyperparameter improvement\n");
    const disabled = loadKnowledgePacks({ cwd: activeProject, skillDir, packIds: ["machine_learning"], disabledPacks: ["machine_learning"] });
    assert(disabled.status === "DISABLED" && (disabled.active_obligation_count || 0) === 0, "disabled pack emits no active obligations");

    writeFileSync(join(unrelatedProject, "docs/ive-engine-plan.md"), "workflow documentation with no predictive modelling claims\n");
    const unrelated = loadKnowledgePacks({ cwd: unrelatedProject, skillDir, packIds: ["machine_learning"] });
    assert((packResult(unrelated, "machine_learning")?.obligation_count || 0) >= 5, "explicit ML pack load still reads declared obligations");
    assert((packResult(unrelated, "machine_learning")?.active_obligation_count || 0) === 0, "unrelated non-ML text does not activate ML obligations");
    assert(!factIncludes(unrelated, "active_obligation("), "unrelated non-ML project emits no blocking active obligation facts");

    writeJson(join(tempSkill, "knowledge_packs/community_pack/pack.json"), {
      id: "community_pack",
      version: 1,
      trust_tier: "community",
      applies_when: { file_exists_any: ["docs/ive-engine-plan.md"] },
      entry_files: ["pitfalls.json"],
      obligation_files: ["obligations.json"],
    });
    writeJson(join(tempSkill, "knowledge_packs/community_pack/pitfalls.json"), [
      { id: "COMM-PIT-001", title: "Community fixture", severity: "medium", polarity: "risk" },
    ]);
    writeJson(join(tempSkill, "knowledge_packs/community_pack/obligations.json"), {
      obligations: [
        {
          id: "COMM-OBL-001",
          subject_id: "community_obligation_subject",
          mode: "artifact_review",
          severity: "required",
          required_by_phase: "plan",
          applies_when: { text_any: ["community-model"] },
          satisfied_by: { any: [{ id: "community-proof", kind: "validation_ref_terms_any", terms: ["community proof"] }] },
        },
      ],
    });
    writeFileSync(join(communityProject, "docs/ive-engine-plan.md"), "community-model claim\n");
    const blocked = loadKnowledgePacks({ cwd: communityProject, skillDir: tempSkill, packIds: ["community_pack"] });
    assert(!blocked.ok && (blocked.active_obligation_count || 0) === 0 && blocked.facts.length === 0, "unaccepted community pack cannot emit blocking obligations");

    const accepted = loadKnowledgePacks({
      cwd: communityProject,
      skillDir: tempSkill,
      packIds: ["community_pack"],
      allowCommunity: true,
      acceptedPacks: ["community_pack"],
    });
    assert(accepted.ok && accepted.active_obligation_count === 1, "accepted community pack can emit one active obligation");
    assert(factCount(accepted, "active_obligation('COMM-OBL-001'") === 1, "active obligation facts are deduplicated");
  } finally {
    cleanup(activeProject);
    cleanup(unrelatedProject);
    cleanup(communityProject);
    cleanup(tempSkill);
  }
}

function testPackObligationPrologGenericEnforcementAndWaivers() {
  const invariants = readFileSync(join(skillDir, "prolog/invariants.pl"), "utf-8");
  const baseFacts = `
    current_state(plan).
    active_obligation('ML-OBL-LEAKAGE-PROOF', 'machine_learning').
    verification_subject('pack_machine_learning_leakage_proof', 'pack_obligation').
    verification_mode('artifact_review').
    verification_supported('artifact_review').
    verification_obligation('ML-OBL-LEAKAGE-PROOF', 'pack_machine_learning_leakage_proof', 'artifact_review', 'required').
    obligation_source('ML-OBL-LEAKAGE-PROOF', 'knowledge_pack', 'machine_learning').
    obligation_required_by_phase('ML-OBL-LEAKAGE-PROOF', plan).
  `;

  const missing = createSession();
  missing.consult(baseFacts);
  missing.consult(invariants);
  assert([...missing.query("invariant_violated(missing_pack_obligation, 'pack_machine_learning_leakage_proof')")].length === 1, "generic Prolog blocks active pack obligation without evidence");

  const evidenced = createSession();
  evidenced.consult(`${compileVerificationStatusFacts()}\n${baseFacts} verification_evidence('ev_leakage', 'pack_machine_learning_leakage_proof', 'artifact_review', passed).`);
  evidenced.consult(readFileSync(join(skillDir, "prolog/verification_statuses.pl"), "utf-8"));
  evidenced.consult(invariants);
  assert([...evidenced.query("invariant_violated(missing_pack_obligation, 'pack_machine_learning_leakage_proof')")].length === 0, "passing evidence satisfies active pack obligation");

  const validWaiver = createSession();
  validWaiver.consult(`${baseFacts}
    verification_waiver('pack_machine_learning_leakage_proof', 'artifact_review', 'wv_leakage').
    waiver_reason('wv_leakage', 'documented out of scope').
    waiver_approved_by('wv_leakage', 'operator').
    waiver_expires_at('wv_leakage', '2026-12-31').
  `);
  validWaiver.consult(invariants);
  assert([...validWaiver.query("invariant_violated(missing_pack_obligation, 'pack_machine_learning_leakage_proof')")].length === 0, "reasoned scoped waiver satisfies active pack obligation");

  const invalidWaiver = createSession();
  invalidWaiver.consult(`${baseFacts}
    verification_waiver('pack_machine_learning_leakage_proof', 'artifact_review', 'wv_bad').
    waiver_approved_by('wv_bad', 'operator').
  `);
  invalidWaiver.consult(invariants);
  assert([...invalidWaiver.query("invariant_violated(missing_pack_obligation, 'pack_machine_learning_leakage_proof')")].length === 1, "waiver without reason and expiry does not satisfy pack obligation");
  assert([...invalidWaiver.query("invariant_violated(pack_obligation_waiver_missing_reason, 'wv_bad')")].length === 1, "invalid waiver reports missing reason");
  assert([...invalidWaiver.query("invariant_violated(pack_obligation_waiver_missing_expiry, 'wv_bad')")].length === 1, "invalid waiver reports missing expiry");
}

function testFactLoaderDoesNotInjectKnowledgePacksAndNotApplicable() {
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
  const loadedMatches = [...session.query("knowledge_pack_loaded('machine_learning', 1, 'bundled')")];
  const entryMatches = [...session.query("knowledge_pack_entry('machine_learning', 'ML-PIT-001', 'pitfall')")];
  assert(loadedMatches.length === 0 && entryMatches.length === 0, "fact_loader does not inject knowledge-pack facts into gate sessions");
}

function testAppDevTesseractPackActivation() {
  const tmp = mkdtempSync(join(tmpdir(), "ive-app-dev-tesseract-project-"));
  try {
    ensureDir(join(tmp, "tesseract_operator/api"));
    writeFileSync(join(tmp, "tesseract_operator/api/webhook.py"), "def handle_webhook(request):\n    return {'ok': True}\n");
    const report = loadKnowledgePacks({ cwd: tmp, skillDir, activeProfiles: [] });
    const appDev = packResult(report, "app_dev_tesseract");
    assert(report.ok && appDev?.status === "PASS", "app_dev_tesseract activates from tesseract-family app files");
    assert((appDev?.entry_count || 0) >= 8, "app_dev_tesseract loads rubric-backed pitfalls and constraints");
    assert((appDev?.obligation_count || 0) >= 4, "app_dev_tesseract loads pack obligations");
    assert(factIncludes(report, "knowledge_pack_loaded('app_dev_tesseract', 1, 'bundled')"), "app_dev_tesseract emits loaded fact");
  } finally {
    cleanup(tmp);
  }
}

testBundledProfileAndCache();
testProfileInheritanceOverridesAndUnknownKinds();
testKnowledgePackLoadTrustDisableAndCli();
testIndependentSiblingPackActivation();
testGeneratedArtifactDiscoveryIsIgnored();
testCommunityTrustGate();
testKnowledgePackObligationBridgeActivationEvidenceAndCli();
testKnowledgePackObligationTrustDisableUnrelatedAndDedup();
testPackObligationPrologGenericEnforcementAndWaivers();
testFactLoaderDoesNotInjectKnowledgePacksAndNotApplicable();
testAppDevTesseractPackActivation();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
