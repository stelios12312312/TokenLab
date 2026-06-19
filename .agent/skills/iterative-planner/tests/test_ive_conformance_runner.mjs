#!/usr/bin/env node
// test_ive_conformance_runner.mjs — IVE conformance runner contracts.

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_SUITES,
  listSuites,
  parseArgs,
  runConformance,
  selectSuites,
} from "./ive/run.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const runnerCli = join(testDir, "ive", "run.mjs");
const NODE = process.execPath;

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

function sameIds(selected, expected) {
  const got = selected.map((suite) => suite.id).sort();
  const want = [...expected].sort();
  return got.length === want.length && got.every((id, index) => id === want[index]);
}

function fakeExecutor(failIds = new Set()) {
  return (suite) => ({
    id: suite.id,
    category: suite.category,
    label: suite.label,
    required: suite.required !== false,
    command: suite.display_command,
    status: failIds.has(suite.id) ? "FAIL" : "PASS",
    exit_code: failIds.has(suite.id) ? 17 : 0,
    timed_out: false,
    started_at: "2026-05-27T00:00:00.000Z",
    finished_at: "2026-05-27T00:00:00.001Z",
    stdout_excerpt: failIds.has(suite.id) ? "" : "ok",
    stderr_excerpt: failIds.has(suite.id) ? "planned failure" : "",
  });
}

console.log("\nIVE Conformance Runner Tests\n");

const categories = new Set(DEFAULT_SUITES.map((suite) => suite.category));
for (const category of ["loop_guard", "escalation", "structured_plan", "ontology", "doc_contract", "visualizer", "ripple", "migration", "release", "projection", "knowledge_pack", "cli_contract", "quant", "ci", "active_ontology", "ideation", "reflection", "advisory", "scenario"]) {
  assert(categories.has(category), `default suite includes ${category}`);
}

assert(DEFAULT_SUITES.every((suite) => suite.id && suite.category && suite.display_command && suite.required === true), "default suites have stable required metadata");
assert(DEFAULT_SUITES.every((suite) => Array.isArray(suite.fixtures) && Array.isArray(suite.changed_file_patterns)), "default suites declare fixtures and changed-file patterns");
assert(DEFAULT_SUITES.some((suite) => suite.display_command.includes("rule_engine.mjs check-invariants")), "default suites delegate ontology proof to rule_engine");
assert(DEFAULT_SUITES.some((suite) => suite.display_command.includes("ripple_check.mjs")), "default suites delegate ripple proof to ripple_check");
const researchMemorySuite = DEFAULT_SUITES.find((suite) => suite.id === "research-memory-packet-e2e");
assert(researchMemorySuite?.required === true, "research memory packet e2e suite is required by default");
assert(researchMemorySuite?.display_command.includes("test_research_memory_packet.mjs"), "research memory packet e2e suite drives the real packet test");
const transitionGateSuite = DEFAULT_SUITES.find((suite) => suite.id === "transition-gate-flows");
assert(transitionGateSuite?.required === true, "transition gate flow suite is required by default");
assert(transitionGateSuite?.display_command.includes("test_transition_gate_flows.mjs"), "transition gate flow suite drives the real lifecycle test");
assert(transitionGateSuite?.timeout_ms === 180000, "transition gate flow suite has CI-safe timeout override");
const knowledgeTriggerSuite = DEFAULT_SUITES.find((suite) => suite.id === "knowledge-triggers");
assert(knowledgeTriggerSuite?.required === true, "knowledge trigger suite is required by default");
assert(knowledgeTriggerSuite?.display_command.includes("test_knowledge_triggers.mjs"), "knowledge trigger suite drives the real trigger test");
const visualizerContractSuite = DEFAULT_SUITES.find((suite) => suite.id === "visualizer-contract-bridge-guard");
assert(visualizerContractSuite?.fixtures.includes("apps/ive-visualizer/scripts/path-portability-check.mjs"), "visualizer contract suite owns path-portability fixture");
assert(visualizerContractSuite?.fixtures.includes("apps/ive-visualizer/scripts/live-payload-check.mjs"), "visualizer contract suite owns live-payload fixture");
assert(visualizerContractSuite?.fixtures.includes("apps/ive-visualizer/scripts/generate-live-payload.mjs"), "visualizer contract suite owns live-payload generator fixture");

let selected = selectSuites(DEFAULT_SUITES, ["ontology"]);
assert(sameIds(selected, ["ontology-cli-source-truth", "ontology-invariants", "spot-check-invariants", "trace-coverage-maturity"]), "--only category selects matching suites");

selected = selectSuites(DEFAULT_SUITES, ["ripple-check"]);
assert(selected.length === 1 && selected[0].category === "ripple", "--only id selects one suite");

selected = selectSuites(DEFAULT_SUITES, ["quant-results-validation"]);
assert(selected.length === 1 && selected[0].category === "quant", "--only quant-results-validation selects one quant suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.routing");
assert(selected.length === 1 && selected[0].id === "core-routing", "--phase core.routing selects routing suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.program-intake");
assert(selected.length === 1 && selected[0].id === "core-program-intake", "--phase core.program-intake selects program-intake suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.contracts");
assert(selected.length === 1 && selected[0].id === "contract-reliability", "--phase core.contracts selects contract reliability suite");

selected = selectSuites(DEFAULT_SUITES, [], "core.user-verdict");
assert(selected.length === 1 && selected[0].id === "core-user-verdict", "--phase core.user-verdict selects user-verdict suite");

selected = selectSuites(DEFAULT_SUITES, [], "annotation-discipline");
assert(selected.length === 1 && selected[0].id === "annotation-discipline-gate", "--phase annotation-discipline selects annotation discipline gate suite");

selected = selectSuites(DEFAULT_SUITES, [], "red-team-depth");
assert(selected.length === 1 && selected[0].id === "red-team-depth-gate", "--phase red-team-depth selects ETR-008 red-team depth suite");

selected = selectSuites(DEFAULT_SUITES, [], "scenarios");
assert(
  selected.length === 2 &&
    selected.some((suite) => suite.id === "scenario-harness") &&
    selected.some((suite) => suite.id === "real-episode-replay-corpus"),
  "--phase scenarios selects scenario suite family",
);

selected = selectSuites(DEFAULT_SUITES, [], "e02");
assert(selected.length === 1 && selected[0].id === "quant-results-validation", "--phase e02 selects quant results validation suite");

selected = selectSuites(DEFAULT_SUITES, [], "e01");
assert(selected.length === 1 && selected[0].id === "quant-results-validation", "--phase e01 selects quant results validation suite");

selected = selectSuites(DEFAULT_SUITES, [], "research-memory-packet-e2e");
assert(selected.length === 1 && selected[0].id === "research-memory-packet-e2e", "--phase research-memory-packet-e2e selects research packet suite");

selected = selectSuites(DEFAULT_SUITES, [], "gate-lifecycle");
assert(selected.length === 1 && selected[0].id === "transition-gate-flows", "--phase gate-lifecycle selects transition gate flow suite");

selected = selectSuites(DEFAULT_SUITES, [], "knowledge-triggers");
assert(selected.length === 1 && selected[0].id === "knowledge-triggers", "--phase knowledge-triggers selects knowledge trigger suite");

selected = selectSuites(DEFAULT_SUITES, [], "t06");
assert(
  selected.length === 3 &&
    selected.some((suite) => suite.id === "quant-results-validation") &&
    selected.some((suite) => suite.id === "structured-evidence-reflection-diff") &&
    selected.some((suite) => suite.id === "verification-runner"),
  "--phase t06 selects quant, reflection, and runner provenance suites",
);

selected = selectSuites(DEFAULT_SUITES, [], "0.5");
assert(selected.length === 1 && selected[0].id === "migration-bootstrap", "--phase 0.5 selects migration bootstrap suite");

selected = selectSuites(DEFAULT_SUITES, [], "6");
assert(selected.length === 1 && selected[0].id === "canonical-release-handoff", "--phase 6 selects canonical release handoff suite");

selected = selectSuites(DEFAULT_SUITES, [], "1,2");
assert(selected.length === 1 && selected[0].id === "projection-north-star", "--phase 1,2 selects projection and North Star suite");

selected = selectSuites(DEFAULT_SUITES, [], "2.5,2.6");
assert(selected.length === 1 && selected[0].id === "profile-knowledge-packs", "--phase 2.5,2.6 selects profile/knowledge-pack suite");

selected = selectSuites(DEFAULT_SUITES, [], "4.5");
assert(selected.length === 1 && selected[0].id === "active-ontology-temporal-provenance", "--phase 4.5 selects active ontology suite");

selected = selectSuites(DEFAULT_SUITES, [], "3");
assert(selected.length === 1 && selected[0].id === "ideation-anchors-operators-intent", "--phase 3 selects ideation anchors/operators/intent suite");

selected = selectSuites(DEFAULT_SUITES, [], "4,4.6");
assert(sameIds(selected, ["reflection-invariants", "structured-evidence-reflection-diff"]), "--phase 4,4.6 selects structured evidence/reflection suite");

selected = selectSuites(DEFAULT_SUITES, [], "4.7");
assert(selected.length === 1 && selected[0].id === "continuous-advisory-records", "--phase 4.7 selects continuous advisory suite");

selected = selectSuites(DEFAULT_SUITES, [], "2.6a,2.6b");
assert(selected.length === 3 && selected.some((suite) => suite.id === "profile-knowledge-packs") && selected.some((suite) => suite.id === "visualizer-contract-bridge-guard") && selected.some((suite) => suite.id === "visualizer-browser-proof"), "--phase 2.6a,2.6b selects sibling-pack and pack-aware visualizer suites");

selected = selectSuites(DEFAULT_SUITES, [], "5");
assert(selected.length === 2 && selected.some((suite) => suite.id === "visualizer-contract-bridge-guard") && selected.some((suite) => suite.id === "visualizer-browser-proof"), "--phase 5 selects visualizer contract and browser suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/knowledge_packs/product_management/pack.json"]);
assert(selected.length === 2 && selected.some((suite) => suite.id === "profile-knowledge-packs") && selected.some((suite) => suite.id === "ripple-check"), "--changed-files selects profile/knowledge-pack and ripple suites for sibling pack files");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/ive-redesign/08_visualizer_ui.md"]);
assert(selected.some((suite) => suite.id === "doc-contract-mvp"), "--changed-files selects the visualizer doc contract");
assert(selected.some((suite) => suite.id === "docs-contracts"), "--changed-files includes the aggregate docs contract");
assert(selected.some((suite) => suite.id === "visualizer-contract-bridge-guard") && selected.some((suite) => suite.id === "visualizer-browser-proof"), "--changed-files selects visualizer proof suites for visualizer docs");
assert(!selected.some((suite) => suite.id === "core-routing"), "--changed-files excludes unrelated core routing suite");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["docs/ive-redesign/16_multi_ide_portability.md"]);
assert(selected.some((suite) => suite.id === "doc-contract-multi-ide"), "--changed-files selects the canonical multi-IDE doc contract");
assert(selected.some((suite) => suite.id === "docs-contracts"), "--changed-files includes aggregate docs contract for canonical multi-IDE docs");

// Exact sorted suite IDs (red-team F-004): inclusion-only assertions can't catch
// over-selection. Every lib change pulls the "capability-connectivity" no-shelf-ware
// guard plus "ripple-check"; pinning the full set forces a deliberate update on drift.
selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_migration_bootstrap.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "migration-bootstrap", "ripple-check"]), "--changed-files selects exactly migration bootstrap, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/annotation_discipline.mjs"]);
assert(sameIds(selected, ["annotation-discipline-gate", "capability-connectivity", "ripple-check"]), "--changed-files selects exactly annotation discipline, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/plan_utils.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "red-team-depth-gate", "ripple-check"]), "--changed-files selects exactly red-team depth, connectivity, and ripple suites for plan_utils");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/verify_gate.mjs"]);
assert(sameIds(selected, ["annotation-discipline-gate", "autonomous-driver", "autonomous-verification-agents", "red-team-depth-gate", "ripple-check", "transition-gate-flows"]), "--changed-files selects exactly live gate consumers, transition flows, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/transition.mjs"]);
assert(sameIds(selected, ["autonomous-driver", "ripple-check", "transition-gate-flows"]), "--changed-files selects exactly transition gate flows, autonomous driver, and ripple for transition.mjs");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/knowledge_triggers.mjs"]);
assert(sameIds(selected, ["knowledge-triggers", "ripple-check"]), "--changed-files selects exactly knowledge triggers and ripple for the Knowledge Trigger CLI");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_release_handoff.mjs"]);
assert(sameIds(selected, ["canonical-release-handoff", "capability-connectivity", "cli-determinism", "ripple-check"]), "--changed-files selects exactly release handoff, connectivity, CLI determinism, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_projection.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "cli-determinism", "projection-north-star", "ripple-check"]), "--changed-files selects exactly projection/North Star, connectivity, CLI determinism, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/knowledge_packs/machine_learning/pack.json"]);
assert(sameIds(selected, ["profile-knowledge-packs", "ripple-check"]), "--changed-files selects exactly profile/knowledge-pack and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_active_ontology.mjs"]);
assert(sameIds(selected, ["active-ontology-temporal-provenance", "capability-connectivity", "ripple-check"]), "--changed-files selects exactly active ontology, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_ideation_operators.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "ideation-anchors-operators-intent", "ripple-check"]), "--changed-files selects exactly ideation operators, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_reflection_diff.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "ripple-check", "structured-evidence-reflection-diff"]), "--changed-files selects exactly reflection diff, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/ive_advisory_records.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "continuous-advisory-records", "ripple-check"]), "--changed-files selects exactly advisory records, connectivity, and ripple suites");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/measured_gate.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "quant-results-validation", "ripple-check"]), "--changed-files selects exactly quant results validation, connectivity, and ripple for measured gate helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/quant_results_validation.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "quant-archetype-accomplices", "quant-betting-market", "quant-crypto-execution", "quant-leakage-artifact", "quant-results-validation", "quant-validation-retrofit", "research-memory-packet-e2e", "ripple-check"]), "--changed-files selects exactly the quant validation consumer family, research memory packet e2e, connectivity, and ripple for the quant parser");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/research_validity_binding.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "research-memory-packet-e2e", "ripple-check"]), "--changed-files selects exactly research packet e2e, connectivity, and ripple for the validity binding seam");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/claim_ledger.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "quant-results-validation", "ripple-check"]), "--changed-files selects exactly quant results validation, connectivity, and ripple for claim ledger helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/contract_reliability.mjs"]);
assert(sameIds(selected, ["capability-connectivity", "contract-reliability", "ripple-check"]), "--changed-files selects exactly contract reliability, connectivity, and ripple for contract reliability helper");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/lib/run_record.mjs"]);
assert(
  sameIds(selected, ["capability-connectivity", "quant-results-validation", "ripple-check", "structured-evidence-reflection-diff", "verification-runner"]),
  "--changed-files selects exactly all run-record consumers, connectivity, and ripple",
);

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/scripts/verification_runner.mjs"]);
assert(sameIds(selected, ["ripple-check", "verification-runner"]), "--changed-files selects exactly verification runner and ripple");

selected = selectSuites(DEFAULT_SUITES, [], "all", ["apps/ive-visualizer/src/App.jsx"]);
assert(sameIds(selected, ["autonomous-driver", "autonomous-verification-agents", "ci-enforcement-contracts", "isolated-adversarial-auditor", "northstar-ui-dogfood", "quant-archetype-accomplices", "quant-betting-market", "quant-crypto-execution", "quant-leakage-artifact", "tokenomics-arithmetic-gate", "visualizer-browser-proof", "visualizer-contract-bridge-guard"]), "--changed-files selects exactly the visualizer-app suite family for app source changes");

selected = selectSuites(DEFAULT_SUITES, [], "all", [".agent/skills/iterative-planner/tests/ive/run.mjs"]);
assert(selected.length === DEFAULT_SUITES.length, "runner surface changes conservatively select every suite");

let report = runConformance({ suites: DEFAULT_SUITES, executeCommand: fakeExecutor() });
assert(report.ok && report.status === "PASS", "all-passing fake execution reports PASS");
assert(report.command_count === DEFAULT_SUITES.length && report.passed_count === DEFAULT_SUITES.length, "all commands are counted");
assert(report.categories.includes("structured_plan") && report.categories.includes("doc_contract"), "report includes selected categories");

let observedTimeoutMs = null;
report = runConformance({
  suites: DEFAULT_SUITES,
  only: ["transition-gate-flows"],
  timeoutMs: 120000,
  executeCommand: (suite, options) => {
    observedTimeoutMs = options.timeoutMs;
    return fakeExecutor()(suite);
  },
});
assert(report.ok && observedTimeoutMs === 180000, "per-suite timeout override is passed to executor");

report = runConformance({ suites: DEFAULT_SUITES, executeCommand: fakeExecutor(new Set(["docs-contracts"])) });
assert(!report.ok && report.status === "FAIL", "required command failure reports FAIL");
assert(report.failed_required_count === 1, "required failure count is recorded");
assert(report.issues?.[0]?.suite_id === "docs-contracts", "failure issue names the failed suite");

report = runConformance({ suites: DEFAULT_SUITES, only: ["research-memory-packet-e2e"], executeCommand: fakeExecutor(new Set(["research-memory-packet-e2e"])) });
assert(!report.ok && report.status === "FAIL", "required research memory packet suite failure reports FAIL");
assert(report.failed_required_count === 1, "research memory packet suite failure is gated as required");

report = runConformance({
  suites: DEFAULT_SUITES,
  executeCommand: (suite) => ({
    ...fakeExecutor()(suite),
    status: suite.id === "ontology-invariants" ? "TIMEOUT" : "PASS",
    exit_code: suite.id === "ontology-invariants" ? -1 : 0,
    timed_out: suite.id === "ontology-invariants",
  }),
});
assert(!report.ok && report.failed_required_count === 1, "required timeout reports FAIL");
assert(report.results.find((result) => result.id === "ontology-invariants")?.timed_out === true, "timeout metadata is preserved");

report = runConformance({ suites: DEFAULT_SUITES, only: ["missing-suite"], executeCommand: fakeExecutor() });
assert(!report.ok && report.issues?.[0]?.code === "no_matching_suite", "unknown suite filter fails closed");

report = runConformance({
  suites: DEFAULT_SUITES,
  changedFiles: ["README.md"],
  executeCommand: fakeExecutor(),
});
assert(report.ok && report.overall_status === "not_applicable", "changed files outside IVE surfaces are reasoned not_applicable");
assert(report.results?.[0]?.status_reason === "changed_files_outside_declared_ive_surfaces", "not_applicable includes a reason");

report = runConformance({
  suites: [{
    id: "missing-fixture",
    name: "missing-fixture",
    category: "structured_plan",
    label: "Missing fixture",
    required: true,
    command: ["node", "missing.mjs"],
    display_command: "node missing.mjs",
    phases: ["fixture"],
    fixtures: ["does/not/exist.mjs"],
    changed_file_patterns: [],
  }],
  phase: "fixture",
});
assert(!report.ok && report.status === "FAIL", "missing required fixture fails closed");
assert(report.results?.[0]?.manifest_status === "not_implemented_yet", "missing fixture maps to not_implemented_yet manifest status");
assert(report.issues?.[0]?.code === "required_fixture_missing", "missing fixture emits required_fixture_missing issue");

report = runConformance({
  suites: [{
    id: "reasonless-na",
    name: "reasonless-na",
    category: "structured_plan",
    label: "Reasonless not applicable",
    required: true,
    command: ["node", "noop.mjs"],
    display_command: "node noop.mjs",
    phases: ["fixture"],
    fixtures: [],
    changed_file_patterns: [],
  }],
  phase: "fixture",
  executeCommand: (suite) => ({
    id: suite.id,
    category: suite.category,
    label: suite.label,
    required: true,
    command: suite.display_command,
    status: "NOT_APPLICABLE",
    exit_code: 0,
    timed_out: false,
    started_at: "2026-05-27T00:00:00.000Z",
    finished_at: "2026-05-27T00:00:00.001Z",
    stdout_excerpt: "skipped",
    stderr_excerpt: "",
  }),
});
assert(!report.ok && report.issues?.[0]?.code === "not_applicable_without_reason", "reasonless not_applicable is a stale-green failure");

const tmp = mkdtempSync(join(tmpdir(), "ive-runner-"));
report = runConformance({
  suites: DEFAULT_SUITES,
  only: ["core-routing"],
  executeCommand: fakeExecutor(),
  writeManifest: true,
  runId: "unit-manifest",
  repoRoot: tmp,
  reportRoot: join(tmp, "reports", "ive", "test_runs"),
});
const manifestPath = join(tmp, "reports", "ive", "test_runs", "unit-manifest", "manifest.json");
assert(report.ok && existsSync(manifestPath), "writeManifest writes manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
assert(manifest.overall_status === "pass" && manifest.suites?.[0]?.status === "pass", "manifest uses lower-case pass status");
assert(existsSync(join(tmp, "reports", "ive", "test_runs", "unit-manifest", "logs", "core-routing.stdout.log")), "writeManifest preserves stdout log");

const list = listSuites(DEFAULT_SUITES);
assert(list.ok && list.status === "LIST" && list.suite_count === DEFAULT_SUITES.length, "listSuites emits machine-readable suite inventory");
assert(Array.isArray(list.suites?.[0]?.fixtures), "listSuites includes fixture metadata");

const parsedArgs = parseArgs(["--json", "--only", "ontology", "--only=ripple", "--changed-files", "a.js,b.js", "--run-id=stable", "--timeout-ms=5000", "--no-manifest"]);
assert(parsedArgs.json && parsedArgs.only.length === 2 && parsedArgs.timeoutMs === 5000, "parseArgs handles json, repeated only filters, and timeout");
assert(parsedArgs.changedFiles.length === 1 && parsedArgs.runId === "stable" && parsedArgs.writeManifest === false, "parseArgs handles changed-files, run-id, and no-manifest");

const cliList = execFileSync(NODE, [runnerCli, "--list", "--json"], {
  cwd: repoRoot,
  encoding: "utf-8",
});
const cliJson = JSON.parse(cliList);
assert(cliJson.status === "LIST" && cliJson.suites?.length === DEFAULT_SUITES.length, "CLI list mode emits parseable JSON");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
