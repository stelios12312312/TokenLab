#!/usr/bin/env node
// tests/ive/run.mjs - IVE conformance runner.
//
// The runner delegates to existing deterministic scripts/tests and aggregates
// their results. It also exposes a small selection API so Program Packet rows
// can run focused phases such as core.packet-contract without inventing a
// second orchestration path.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { emitJson } from "../../scripts/lib/emit_json.mjs";
import { isDirectInvocation } from "../../scripts/lib/script_entrypoint.mjs";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const TESTS_ROOT = dirname(TEST_DIR);
const SKILL_DIR = dirname(TESTS_ROOT);
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");

const SCHEMA_VERSION = 1;
const STDOUT_EXCERPT_BYTES = 500;
const DEFAULT_TIMEOUT_MS = 120000;
const NODE = process.execPath;
const REPORT_ROOT = join(REPO_ROOT, "reports", "ive", "test_runs");
const VISUALIZER_SKIP_EXIT_CODE = 78;

const FAILING_STATUSES = new Set(["FAIL", "TIMEOUT", "NOT_IMPLEMENTED_YET"]);

function displayCommand(command) {
  return command.join(" ");
}

function suite({
  id,
  category,
  label,
  command,
  phases = ["default"],
  surfaces = [category],
  fixtures = [],
  changedFilePatterns = [],
  timeoutMs = null,
  run,
}) {
  return {
    id,
    name: id,
    category,
    label,
    command,
    display_command: displayCommand(command),
    required: true,
    phases,
    surfaces,
    fixtures,
    changed_file_patterns: changedFilePatterns,
    timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
    run,
  };
}

function skillRel(path) {
  return `.agent/skills/iterative-planner/${path}`;
}

function docsIvePattern(fileName) {
  return new RegExp(`^docs/ive-redesign/${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function visualizerAppRoot(repoRoot = REPO_ROOT) {
  return join(repoRoot, "apps", "ive-visualizer");
}

function visualizerPlaywrightBin(repoRoot = REPO_ROOT) {
  return join(visualizerAppRoot(repoRoot), "node_modules", ".bin", process.platform === "win32" ? "playwright.cmd" : "playwright");
}

const DEFAULT_SUITES = [
  suite({
    id: "ontology-invariants",
    category: "ontology",
    label: "Ontology invariants",
    command: ["node", join(SCRIPTS_DIR, "rule_engine.mjs"), "check-invariants", "--json"],
    fixtures: [skillRel("scripts/rule_engine.mjs")],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/rule_engine\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\//,
      /^reports\/user_story_audit\/story_registry\.json$/,
    ],
  }),
  suite({
    id: "trace-coverage-maturity",
    category: "ontology",
    label: "I-016 trace coverage is maturity-scaled (early phases advisory, mature phases hard) — FT-3",
    command: ["node", join(TESTS_ROOT, "test_trace_coverage_maturity.mjs")],
    fixtures: [
      skillRel("tests/test_trace_coverage_maturity.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("scripts/lib/fact_loader.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_trace_coverage_maturity\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
    ],
  }),
  suite({
    id: "ontology-cli-source-truth",
    category: "ontology",
    label: "Ontology CLI and runtime source-of-truth contracts",
    command: ["node", join(TESTS_ROOT, "test_ontology_cli.mjs")],
    fixtures: [
      skillRel("tests/test_ontology_cli.mjs"),
      skillRel("scripts/ontology_cli.mjs"),
      skillRel("scripts/planner.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/ontology_fact_builder.mjs"),
      skillRel("scripts/lib/ontology_schema.mjs"),
      skillRel("scripts/lib/semantic_engine.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ontology_cli\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_cli\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/planner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(fact_loader|ontology_fact_builder|ontology_schema|semantic_engine)\.mjs$/,
      /^\.agent\/ontology\/facts\//,
    ],
  }),
  suite({
    id: "transition-gate-flows",
    category: "structured_plan",
    label: "Planner transition gate lifecycle flows",
    command: ["node", join(TESTS_ROOT, "test_transition_gate_flows.mjs")],
    timeoutMs: 180000,
    phases: ["state-machine", "gate-lifecycle", "planner-core"],
    surfaces: ["state_machine", "transition_gates", "planner_core", "semantic_gate"],
    fixtures: [
      skillRel("tests/test_transition_gate_flows.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/lib/determinism.mjs"),
      skillRel("scripts/lib/plan_integrity.mjs"),
      skillRel("scripts/lib/plan_refresh.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("prolog/transitions.pl"),
      skillRel("config/gates.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_transition_gate_flows\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(bootstrap|transition|verify_gate)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(determinism|plan_integrity|plan_refresh|fact_loader)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/(invariants|transitions)\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
      /^\.agent\/skills\/iterative-planner\/checklists\//,
    ],
  }),
  suite({
    id: "knowledge-triggers",
    category: "active_ontology",
    label: "Knowledge Trigger obligations, insight injection, capture, and promotion",
    command: ["node", join(TESTS_ROOT, "test_knowledge_triggers.mjs")],
    phases: ["knowledge-triggers", "active-knowledge", "planner-memory"],
    surfaces: ["knowledge_triggers", "active_ontology", "obligation_gate", "insight_injection"],
    fixtures: [
      skillRel("tests/test_knowledge_triggers.mjs"),
      skillRel("scripts/knowledge_triggers.mjs"),
      skillRel("scripts/lib/knowledge_triggers.mjs"),
      skillRel("config/knowledge_triggers.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_knowledge_triggers\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/knowledge_triggers\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/knowledge_triggers\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/knowledge_triggers\.json$/,
    ],
  }),
  suite({
    id: "agent-journal-ontology",
    category: "active_ontology",
    label: "Agent journal advisory memory and ontology facts",
    command: ["node", join(TESTS_ROOT, "test_agent_journal.mjs")],
    phases: ["planner-memory", "ontology", "migration-parity"],
    surfaces: ["agent_journal", "fact_loader", "prolog", "planner_core"],
    fixtures: [
      skillRel("tests/test_agent_journal.mjs"),
      skillRel("scripts/journal.mjs"),
      skillRel("scripts/lib/agent_journal.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_agent_journal\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/journal\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(agent_journal|fact_loader)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^plans\/knowledge\/agent_journal\.jsonl$/,
    ],
  }),
  suite({
    id: "persona-manifest",
    category: "escalation",
    label: "Persona manifest verifier",
    command: ["node", join(SCRIPTS_DIR, "persona_manifest_verify.mjs"), "verify", "--strict", "--json"],
    fixtures: [
      skillRel("scripts/persona_manifest_verify.mjs"),
      skillRel("config/persona_manifest.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/persona_manifest_verify\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/persona_manifest\.json$/,
      /^\.agent\/skills\/iterative-planner\/packs\//,
    ],
  }),
  suite({
    id: "program-manager-tests",
    category: "structured_plan",
    label: "Program manager tests",
    command: ["node", join(TESTS_ROOT, "test_program_manager.mjs")],
    fixtures: [skillRel("tests/test_program_manager.mjs"), skillRel("scripts/program_manager.mjs")],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/program_manager\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_program_manager\.mjs$/,
      /^plans\/programs\//,
    ],
  }),
  suite({
    id: "program-packet-design-to-ready",
    category: "structured_plan",
    label: "Program packet design-to-ready gate (clean-checkout)",
    command: ["node", join(TESTS_ROOT, "test_program_packet_design_to_ready_gate.mjs")],
    fixtures: [
      skillRel("tests/test_program_packet_design_to_ready_gate.mjs"),
      skillRel("scripts/program_manager.mjs"),
      skillRel("scripts/lib/program_packet.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_program_packet_design_to_ready_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/program_manager\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/program_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/programs\.pl$/,
      /^plans\/programs\//,
    ],
  }),
  suite({
    id: "north-star-telemetry",
    category: "projection",
    label: "North Star telemetry: measured-vs-threshold gate (t07)",
    command: ["node", join(TESTS_ROOT, "test_north_star_telemetry.mjs")],
    fixtures: [
      skillRel("tests/test_north_star_telemetry.mjs"),
      skillRel("scripts/lib/north_star_telemetry.mjs"),
      skillRel("scripts/lib/planner_manifesto.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_north_star_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/north_star_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/planner_manifesto\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
    ],
  }),
  suite({
    id: "verification-metrics",
    category: "projection",
    label: "Verification metrics: real-definition collector (dead-load/gated/real-data/genuine-close) for North Star gating",
    command: ["node", join(TESTS_ROOT, "test_verification_metrics.mjs")],
    fixtures: [
      skillRel("tests/test_verification_metrics.mjs"),
      skillRel("scripts/verification_metrics.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_verification_metrics\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verification_metrics\.mjs$/,
    ],
  }),
  suite({
    id: "false-failure-ledger",
    category: "projection",
    label: "Verifier resilience: false-failure ledger (block-then-pass-unchanged self-clear detection)",
    command: ["node", join(TESTS_ROOT, "test_gate_false_failure_ledger.mjs")],
    fixtures: [
      skillRel("tests/test_gate_false_failure_ledger.mjs"),
      skillRel("scripts/gate_false_failure_ledger.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_gate_false_failure_ledger\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/gate_false_failure_ledger\.mjs$/,
    ],
  }),
  suite({
    id: "real-telemetry-false-failures",
    category: "projection",
    label: "Verifier resilience: false-failure ledger grounded in real sibling-project telemetry",
    command: ["node", join(TESTS_ROOT, "test_real_telemetry_false_failures.mjs")],
    fixtures: [
      skillRel("tests/test_real_telemetry_false_failures.mjs"),
      skillRel("scripts/gate_false_failure_ledger.mjs"),
      skillRel("tests/fixtures/real_telemetry/crawler_extractor_GATE-TMP-002.jsonl"),
      skillRel("tests/fixtures/real_telemetry/evolution_trading_GATE-ETR-008.jsonl"),
      skillRel("tests/fixtures/real_telemetry/tesseract_GATE-ETR-008.jsonl"),
      skillRel("tests/fixtures/real_telemetry/ipbs_GATE-REF-003.jsonl"),
      skillRel("tests/fixtures/real_telemetry/trueskill_tennis_GATE-REF-003.jsonl"),
      skillRel("tests/fixtures/real_telemetry/tokenlab_GATE-EXP-001.jsonl"),
      skillRel("tests/fixtures/real_telemetry/valueinvesting_reflect_to_close_stuck.jsonl"),
      skillRel("tests/fixtures/real_telemetry/crawler_extractor_GATE-VAL-015.jsonl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_real_telemetry_false_failures\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/gate_false_failure_ledger\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_telemetry\//,
    ],
  }),
  suite({
    id: "harvest-real-telemetry",
    category: "projection",
    label: "Fixture supply chain: registry-driven harvester stages provenance-led real telemetry (US-088)",
    command: ["node", join(TESTS_ROOT, "test_harvest_real_telemetry.mjs")],
    fixtures: [
      skillRel("tests/test_harvest_real_telemetry.mjs"),
      skillRel("scripts/harvest_real_telemetry.mjs"),
      skillRel("scripts/gate_false_failure_ledger.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_harvest_real_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/harvest_real_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_telemetry\//,
    ],
  }),
  suite({
    id: "real-telemetry-replay",
    category: "projection",
    label: "Real-telemetry replay: live gate-decision engine reproduces recorded verdicts + hash-chain integrity (Epic B)",
    command: ["node", join(TESTS_ROOT, "test_replay_telemetry.mjs")],
    fixtures: [
      skillRel("tests/test_replay_telemetry.mjs"),
      skillRel("scripts/replay_telemetry.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_replay_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/replay_telemetry\.mjs$/,
    ],
  }),
  suite({
    id: "capability-probe",
    category: "projection",
    label: "Verifier resilience: capability probe (never require proof from a sensor detected as off)",
    command: ["node", join(TESTS_ROOT, "test_capability_probe.mjs")],
    fixtures: [
      skillRel("tests/test_capability_probe.mjs"),
      skillRel("scripts/lib/capability_probe.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_capability_probe\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/capability_probe\.mjs$/,
    ],
  }),
  suite({
    id: "gate-idempotence",
    category: "projection",
    label: "Verifier resilience: gate idempotence (same verdict on an unchanged plan run twice)",
    command: ["node", join(TESTS_ROOT, "test_gate_idempotence_check.mjs")],
    fixtures: [
      skillRel("tests/test_gate_idempotence_check.mjs"),
      skillRel("scripts/gate_idempotence_check.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_gate_idempotence_check\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/gate_idempotence_check\.mjs$/,
    ],
  }),
  suite({
    id: "spot-check-invariants",
    category: "ontology",
    label: "Spot-check invariants and manual audit parity",
    command: ["node", join(TESTS_ROOT, "test_spot_check_invariants.mjs")],
    fixtures: [
      skillRel("tests/test_spot_check_invariants.mjs"),
      skillRel("scripts/rule_engine.mjs"),
      skillRel("scripts/lib/rule_commands.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/lib/spot_check.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_spot_check_invariants\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/rule_engine\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(rule_commands|fact_loader|spot_check)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
    ],
  }),
  suite({
    id: "red-team-depth-gate",
    category: "structured_plan",
    label: "GATE-ETR-008 red-team vector depth and scaffold rejection",
    command: ["node", join(TESTS_ROOT, "test_repair_packet.mjs")],
    phases: ["stage1", "execute-to-reflect", "red-team-depth", "semantic-gates"],
    surfaces: ["structured_plan", "semantic_gate", "red_team"],
    fixtures: [
      skillRel("tests/test_repair_packet.mjs"),
      skillRel("scripts/lib/plan_utils.mjs"),
      skillRel("scripts/lib/repair_packet.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("config/gate_templates/GATE-ETR-008.json"),
      skillRel("examples/passing/GATE-ETR-008.md"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_repair_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(plan_utils|repair_packet)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/gate_templates\/GATE-ETR-008\.json$/,
      /^\.agent\/skills\/iterative-planner\/examples\/passing\/GATE-ETR-008\.md$/,
    ],
  }),
  suite({
    id: "contract-preview",
    category: "structured_plan",
    label: "Front-loaded contract preview: rules surfaced before acting (cure for #1 ritual cause)",
    command: ["node", join(TESTS_ROOT, "test_contract_preview.mjs")],
    fixtures: [
      skillRel("tests/test_contract_preview.mjs"),
      skillRel("scripts/lib/contract_preview.mjs"),
      skillRel("scripts/lib/determinism.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_contract_preview\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/contract_preview\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/determinism\.mjs$/,
    ],
  }),
  suite({
    id: "contract-reliability",
    category: "structured_plan",
    label: "Contract reliability: output, assumptions, claims, complaints, and project-local registry",
    command: ["node", join(TESTS_ROOT, "test_contract_reliability.mjs")],
    phases: ["contract-reliability", "generalized-reliability", "core.contracts"],
    surfaces: ["structured_plan", "contract_reliability", "traceability", "assumptions"],
    fixtures: [
      skillRel("tests/test_contract_reliability.mjs"),
      skillRel("scripts/contract_reliability.mjs"),
      skillRel("scripts/lib/contract_reliability.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_contract_reliability\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/contract_reliability\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/contract_reliability\.mjs$/,
      /^plans\/programs\/ive-contract-reliability-generalization\//,
    ],
  }),
  suite({
    id: "northstar-ui-dogfood",
    category: "projection",
    label: "North-Star UI dogfood: real verdict → cockpit payload (T-E14EBBAE)",
    command: ["node", join(TESTS_ROOT, "test_northstar_dogfood.mjs")],
    fixtures: [
      skillRel("tests/test_northstar_dogfood.mjs"),
      skillRel("scripts/lib/northstar_dogfood.mjs"),
      skillRel("scripts/lib/north_star_telemetry.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_northstar_dogfood\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/northstar_dogfood\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "capability-connectivity",
    category: "structured_plan",
    label: "Capability connectivity: no shelf-ware (T-25285668 AC1)",
    command: ["node", join(TESTS_ROOT, "test_capability_connectivity.mjs")],
    fixtures: [
      skillRel("tests/test_capability_connectivity.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
      skillRel("packs/quant/forecastability.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_capability_connectivity\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\//,
    ],
  }),
  suite({
    id: "annotation-discipline-gate",
    category: "structured_plan",
    label: "GATE-PLN-ANN-001 annotation discipline",
    command: ["node", join(TESTS_ROOT, "test_annotation_discipline_gate.mjs")],
    phases: ["stage1", "plan-to-execute", "annotation-discipline", "semantic-gates"],
    surfaces: ["structured_plan", "semantic_gate", "annotations"],
    fixtures: [
      skillRel("tests/test_annotation_discipline_gate.mjs"),
      skillRel("scripts/lib/annotation_discipline.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/annotation_parser.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_annotation_discipline_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/annotation_discipline\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/annotation_parser\.mjs$/,
    ],
  }),
  suite({
    id: "autonomous-driver",
    category: "structured_plan",
    label: "t13 autonomous driver: executed-test gates block CLOSE",
    command: ["node", join(TESTS_ROOT, "test_autonomous_driver.mjs")],
    phases: ["stage2", "t13", "autonomous-driver", "semantic-gates"],
    surfaces: ["planner_runtime", "semantic_gate", "validation", "visualizer"],
    fixtures: [
      skillRel("tests/test_autonomous_driver.mjs"),
      skillRel("scripts/planner.mjs"),
      skillRel("scripts/autonomous_driver.mjs"),
      skillRel("scripts/lib/autonomous_driver.mjs"),
      skillRel("scripts/transition.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("scripts/test_baseline.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_autonomous_driver\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/autonomous_driver\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/planner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/transition\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/autonomous_driver\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_capability_connectivity\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "autonomous-verification-agents",
    category: "orchestration",
    label: "t14 AVA adversarial defect artifacts block CLOSE and surface in cockpit",
    command: ["node", join(TESTS_ROOT, "test_autonomous_verification_agents.mjs")],
    phases: ["stage4", "t14", "ava", "semantic-gates", "visualizer"],
    surfaces: ["planner_runtime", "semantic_gate", "ontology", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_autonomous_verification_agents.mjs"),
      skillRel("scripts/lib/autonomous_verification_agents.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("scripts/verify_gate.mjs"),
      skillRel("prolog/invariants.pl"),
      skillRel("config/ontology_namespace.json"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_autonomous_verification_agents\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/autonomous_verification_agents\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verify_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/ontology_namespace\.json$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-validation-retrofit",
    category: "structured_plan",
    label: "e03/e04 consumed by the live REFLECT/VALIDATE quant gate (connectivity)",
    command: ["node", join(TESTS_ROOT, "test_quant_validation_retrofit.mjs")],
    fixtures: [
      skillRel("tests/test_quant_validation_retrofit.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
      skillRel("packs/quant/forecastability.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_validation_retrofit\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\//,
    ],
  }),
  suite({
    id: "quant-leakage-artifact",
    category: "quant",
    label: "t08 artifact-backed leakage/temporal split proof",
    command: ["node", join(TESTS_ROOT, "test_leakage_proof.mjs")],
    phases: ["stage1", "t08", "quant-results-validation", "semantic-gates"],
    surfaces: ["quant", "semantic_gate", "validation", "proof_telemetry", "ontology", "visualizer"],
    fixtures: [
      skillRel("tests/test_leakage_proof.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("scripts/lib/proof_telemetry.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_leakage_proof\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_proof_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/leakage_proof\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/proof_telemetry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-archetype-accomplices",
    category: "quant",
    label: "e06 archetype accomplices and residual scope-gap PLAN reopen",
    command: ["node", join(TESTS_ROOT, "test_archetype_accomplice_conformance.mjs")],
    phases: ["stage1", "e06", "quant-results-validation", "visualizer"],
    surfaces: ["quant", "semantic_gate", "validation", "bootstrap", "ontology", "visualizer"],
    fixtures: [
      skillRel("tests/test_archetype_accomplices.mjs"),
      skillRel("tests/test_archetype_accomplice_conformance.mjs"),
      skillRel("tests/test_quant_results_validation.mjs"),
      skillRel("packs/quant/archetype_accomplices.mjs"),
      skillRel("packs/quant/index.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_archetype_accomplices\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_archetype_accomplice_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/archetype_accomplices\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/index\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-betting-market",
    category: "quant",
    label: "t10 betting-market de-vig, rating, Markov, and sports sample-floor gate",
    command: ["node", join(TESTS_ROOT, "test_betting_market_conformance.mjs")],
    phases: ["stage1", "t10", "quant-results-validation", "visualizer"],
    surfaces: ["quant", "semantic_gate", "validation", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_betting_market_pack.mjs"),
      skillRel("tests/test_betting_market_conformance.mjs"),
      skillRel("tests/test_quant_results_validation.mjs"),
      skillRel("packs/quant/betting_market.mjs"),
      skillRel("packs/quant/index.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_betting_market_pack\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_betting_market_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/betting_market\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/index\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-crypto-execution",
    category: "quant",
    label: "t11 crypto execution realism funding, liquidation, cost, slippage, and venue gate",
    command: ["node", join(TESTS_ROOT, "test_crypto_execution_conformance.mjs")],
    phases: ["stage1", "t11", "quant-results-validation", "visualizer"],
    surfaces: ["quant", "semantic_gate", "validation", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_crypto_execution_pack.mjs"),
      skillRel("tests/test_crypto_execution_conformance.mjs"),
      skillRel("tests/test_quant_results_validation.mjs"),
      skillRel("packs/quant/crypto_execution.mjs"),
      skillRel("packs/quant/index.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_crypto_execution_pack\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_crypto_execution_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/crypto_execution\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/index\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "tokenomics-arithmetic-gate",
    category: "tokenomics",
    label: "t12 tokenomics arithmetic, Prolog, runtime gate, and visualizer surface",
    command: ["node", join(TESTS_ROOT, "test_tokenomics_conformance.mjs")],
    phases: ["stage1", "t12", "tokenomics", "semantic-gates", "visualizer"],
    surfaces: ["tokenomics", "semantic_gate", "ontology", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_tokenomics_pack.mjs"),
      skillRel("tests/test_tokenomics_conformance.mjs"),
      skillRel("packs/tokenomics/index.mjs"),
      skillRel("packs/tokenomics/rules.pl"),
      skillRel("scripts/audit_runner.mjs"),
      skillRel("config/gates.json"),
      skillRel("config/ontology_namespace.json"),
      skillRel("config/persona_manifest.json"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_tokenomics_pack\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_tokenomics_conformance\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/tokenomics\//,
      /^\.agent\/skills\/iterative-planner\/scripts\/audit_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/(gates|ontology_namespace|persona_manifest)\.json$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "isolated-adversarial-auditor",
    category: "orchestration",
    label: "e05 isolated adversarial auditor and single-writer orchestration",
    command: ["node", join(TESTS_ROOT, "test_isolated_adversarial_auditor_conformance.mjs")],
    phases: ["stage4", "e05", "orchestration", "semantic-gates", "visualizer"],
    surfaces: ["orchestration", "persona_gate", "semantic_gate", "ontology", "visualizer", "browser"],
    fixtures: [
      skillRel("tests/test_agent_orchestration.mjs"),
      skillRel("tests/test_isolated_adversarial_auditor.mjs"),
      skillRel("tests/test_isolated_adversarial_auditor_conformance.mjs"),
      skillRel("scripts/lib/agent_orchestration.mjs"),
      skillRel("scripts/lib/isolated_adversarial_auditor.mjs"),
      skillRel("scripts/audit_runner.mjs"),
      skillRel("config/agent_orchestration.json"),
      skillRel("config/ontology_namespace.json"),
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_agent_orchestration\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_isolated_adversarial_auditor.*\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(agent_orchestration|isolated_adversarial_auditor)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/audit_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/(agent_orchestration|ontology_namespace)\.json$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "quant-forecastability-pregates",
    category: "structured_plan",
    label: "Quant forecastability & data-quality pre-gates (e04)",
    command: ["node", join(TESTS_ROOT, "test_forecastability.mjs")],
    fixtures: [
      skillRel("tests/test_forecastability.mjs"),
      skillRel("packs/quant/forecastability.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_forecastability\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/forecastability\.mjs$/,
    ],
  }),
  suite({
    id: "quant-calibration-gate",
    category: "structured_plan",
    label: "Quant calibration bands + impossibility gate (e03)",
    command: ["node", join(TESTS_ROOT, "test_calibration_gate.mjs")],
    fixtures: [
      skillRel("tests/test_calibration_gate.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
      skillRel("packs/quant/calibration.json"),
      skillRel("packs/quant/rules.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_calibration_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\//,
    ],
  }),
  suite({
    id: "research-memory-packet-e2e",
    category: "quant",
    label: "Research Memory Packet validity seam ingest-route-rank-gate e2e",
    command: ["node", join(TESTS_ROOT, "test_research_memory_packet.mjs")],
    phases: ["research-memory-packet-e2e", "research-memory", "quant-results-validation", "semantic-gates"],
    surfaces: ["quant", "validation", "structured_plan", "active_ontology"],
    fixtures: [
      skillRel("tests/test_research_memory_packet.mjs"),
      skillRel("scripts/lib/research_validity_binding.mjs"),
      skillRel("scripts/lib/research_memory_packet.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
      skillRel("packs/quant/calibration_gate.mjs"),
      skillRel("packs/quant/forecastability.mjs"),
      "docs/ive-redesign/research_memory_packets.md",
      "plans/programs/ive-ontology-memory/program_packet.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_research_memory_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/research_validity_binding\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/research_memory_packet\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/(leakage_proof|calibration_gate|forecastability)\.mjs$/,
      docsIvePattern("research_memory_packets.md"),
      /^plans\/programs\/ive-ontology-memory\/program_packet\.json$/,
    ],
  }),
  suite({
    id: "persona-manifest-tests",
    category: "escalation",
    label: "Persona manifest tests",
    command: ["node", join(TESTS_ROOT, "test_persona_manifest_verify.mjs")],
    fixtures: [skillRel("tests/test_persona_manifest_verify.mjs")],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_persona_manifest_verify\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/persona_manifest_verify\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/persona_manifest\.json$/,
    ],
  }),
  suite({
    id: "phase-authority-contracts",
    category: "loop_guard",
    label: "Phase authority and loop guard contracts",
    command: ["node", join(TESTS_ROOT, "test_phase_authority_contract.mjs")],
    fixtures: [skillRel("tests/test_phase_authority_contract.mjs")],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_phase_authority_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/planner_phase_routing\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
    ],
  }),
  suite({
    id: "structural-contracts",
    category: "structural",
    label: "IVE structural gate, namespace, doc, and version contracts",
    command: ["node", join(TESTS_ROOT, "test_t16_structural_contracts.mjs")],
    phases: ["stage1", "structural", "t16"],
    surfaces: ["gate_registry", "ontology", "doc_contract", "migration", "version"],
    fixtures: [
      skillRel("tests/test_t16_structural_contracts.mjs"),
      skillRel("scripts/lib/gate_registry.mjs"),
      skillRel("scripts/ontology_namespace_check.mjs"),
      skillRel("config/ontology_namespace.json"),
      skillRel("prolog/transitions.pl"),
      skillRel("config/gates.json"),
      skillRel("config/version.json"),
      skillRel("MIGRATION.md"),
      "docs/ive-redesign/15_multi_ide_portability.md",
      "docs/ive-redesign/16_multi_ide_portability.md",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_t16_structural_contracts\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/gate_registry\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_namespace_check\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/ontology_namespace\.json$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/transitions\.pl$/,
      /^\.agent\/skills\/iterative-planner\/config\/gates\.json$/,
      /^\.agent\/skills\/iterative-planner\/config\/version\.json$/,
      /^\.agent\/skills\/iterative-planner\/MIGRATION\.md$/,
      docsIvePattern("15_multi_ide_portability.md"),
      docsIvePattern("16_multi_ide_portability.md"),
    ],
  }),
  suite({
    id: "doc-contract-mvp",
    category: "doc_contract",
    label: "Visualizer MVP doc contract",
    command: [
      "grep",
      "-cE",
      "^### (MVP Scope|Proof Plan|Data Contract|No-Direct-Write Rule)\\s*$",
      join(REPO_ROOT, "docs/ive-redesign/08_visualizer_ui.md"),
    ],
    run: runDocContractCheck,
    fixtures: ["docs/ive-redesign/08_visualizer_ui.md"],
    changedFilePatterns: [docsIvePattern("08_visualizer_ui.md")],
  }),
  suite({
    id: "doc-contract-multi-ide",
    category: "doc_contract",
    label: "Multi-IDE portability doc contract",
    command: [
      "grep",
      "-cE",
      "^## (Source Of Truth|Portability Matrix|Managed Snapshot Rule|Update Workflow|Trace Behavior|False-Green Guards|Verification Checklist)\\s*$",
      join(REPO_ROOT, "docs/ive-redesign/16_multi_ide_portability.md"),
    ],
    run: runDocContractCheck,
    fixtures: ["docs/ive-redesign/16_multi_ide_portability.md"],
    changedFilePatterns: [docsIvePattern("16_multi_ide_portability.md")],
  }),
  suite({
    id: "docs-contracts",
    category: "doc_contract",
    label: "Combined IVE doc contracts",
    command: ["node", join(TEST_DIR, "run.mjs"), "--only", "doc-contract-mvp", "--only", "doc-contract-multi-ide", "--json"],
    run: runDocsContractsAggregate,
    fixtures: ["docs/ive-redesign/08_visualizer_ui.md", "docs/ive-redesign/16_multi_ide_portability.md"],
    changedFilePatterns: [/^docs\/ive-redesign\//],
  }),
  suite({
    id: "visualizer-contract-bridge-guard",
    category: "visualizer",
    label: "IVE Visualizer contract, bridge, and no-direct-write checks",
    command: ["npm", "--prefix", join(REPO_ROOT, "apps", "ive-visualizer"), "test"],
    phases: ["2.6b", "5", "dashboard", "visualizer"],
    surfaces: ["visualizer", "dashboard", "bridge", "browser"],
    fixtures: [
      "apps/ive-visualizer/package.json",
      "apps/ive-visualizer/scripts/graph-payload-check.mjs",
      "apps/ive-visualizer/scripts/live-payload-check.mjs",
      "apps/ive-visualizer/scripts/generate-live-payload.mjs",
      "apps/ive-visualizer/scripts/bridge-parity-check.mjs",
      "apps/ive-visualizer/scripts/no-direct-write-check.mjs",
      "apps/ive-visualizer/scripts/path-portability-check.mjs",
      "apps/ive-visualizer/src/lib/dashboardBridge.js",
      "apps/ive-visualizer/src/lib/graphPayloadContract.js",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
      "apps/ive-visualizer/public/ive-graph-payload.json",
    ],
    changedFilePatterns: [/^apps\/ive-visualizer\//, docsIvePattern("08_visualizer_ui.md"), docsIvePattern("15_visualizer_mvp.md")],
  }),
  suite({
    id: "visualizer-browser-proof",
    category: "visualizer",
    label: "IVE Visualizer browser screenshots and accessibility",
    command: [visualizerPlaywrightBin(REPO_ROOT), "test", "--config=playwright.config.mjs"],
    run: runVisualizerBrowserProof,
    phases: ["2.6b", "5", "dashboard", "visualizer"],
    surfaces: ["visualizer", "dashboard", "browser"],
    fixtures: [
      "apps/ive-visualizer/package.json",
      "apps/ive-visualizer/scripts/run-playwright.mjs",
      "apps/ive-visualizer/playwright.config.mjs",
      "apps/ive-visualizer/tests/visualizer-smoke.spec.mjs",
      "apps/ive-visualizer/tests/northstar-dogfood.spec.mjs",
      "apps/ive-visualizer/src/App.jsx",
      "apps/ive-visualizer/src/styles.css",
      "apps/ive-visualizer/src/data/visualizerPayload.js",
    ],
    changedFilePatterns: [/^apps\/ive-visualizer\//, docsIvePattern("08_visualizer_ui.md"), docsIvePattern("15_visualizer_mvp.md")],
  }),
  suite({
    id: "ripple-check",
    category: "ripple",
    label: "Planner ripple check",
    command: ["node", join(SCRIPTS_DIR, "ripple_check.mjs")],
    fixtures: [skillRel("scripts/ripple_check.mjs")],
    changedFilePatterns: [/^\.agent\/skills\/iterative-planner\//, /^docs\/ive-redesign\//],
  }),
  suite({
    id: "core-packet-contract",
    category: "structured_plan",
    label: "IVE packet contract",
    command: ["node", join(TESTS_ROOT, "test_ive_packet_contract.mjs")],
    phases: ["core.packet-contract"],
    fixtures: [
      skillRel("tests/test_ive_packet_contract.mjs"),
      skillRel("scripts/lib/ive_packet_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_packet_contract\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_packet_contract\.mjs$/,
    ],
  }),
  suite({
    id: "core-routing",
    category: "structured_plan",
    label: "IVE fact/action routing",
    command: ["node", join(TESTS_ROOT, "test_ive_action_router.mjs")],
    phases: ["core.routing"],
    fixtures: [
      skillRel("tests/test_ive_action_router.mjs"),
      skillRel("scripts/lib/ive_action_router.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_action_router\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_action_router\.mjs$/,
    ],
  }),
  suite({
    id: "core-program-intake",
    category: "structured_plan",
    label: "IVE Program Manager intake",
    command: ["node", join(TESTS_ROOT, "test_ive_program_intake.mjs")],
    phases: ["core.program-intake"],
    fixtures: [
      skillRel("tests/test_ive_program_intake.mjs"),
      skillRel("scripts/lib/ive_program_intake.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_program_intake\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_program_intake\.mjs$/,
      /^plans\/programs\//,
    ],
  }),
  suite({
    id: "core-user-verdict",
    category: "structured_plan",
    label: "IVE user verdict renderer",
    command: ["node", join(TESTS_ROOT, "test_ive_user_verdict.mjs")],
    phases: ["core.user-verdict"],
    fixtures: [
      skillRel("tests/test_ive_user_verdict.mjs"),
      skillRel("scripts/lib/ive_user_verdict.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_user_verdict\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_user_verdict\.mjs$/,
    ],
  }),
  suite({
    id: "migration-bootstrap",
    category: "migration",
    label: "IVE migration bootstrap",
    command: ["node", join(TESTS_ROOT, "test_ive_migration_bootstrap.mjs")],
    phases: ["0.5", "migration.bootstrap"],
    surfaces: ["migration", "structured_plan"],
    fixtures: [
      skillRel("tests/test_ive_migration_bootstrap.mjs"),
      skillRel("scripts/migrate.mjs"),
      skillRel("scripts/bootstrap.mjs"),
      skillRel("scripts/lib/ive_migration_bootstrap.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_migration_bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/migrate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/bootstrap\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_migration_bootstrap\.mjs$/,
      docsIvePattern("10_migration.md"),
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "canonical-release-handoff",
    category: "release",
    label: "IVE canonical migration release handoff",
    command: ["node", join(SCRIPTS_DIR, "ive_release_handoff.mjs"), "--plans", "50", "--json"],
    phases: ["6", "canonical-migration", "release-handoff"],
    surfaces: ["release", "migration", "structured_plan"],
    fixtures: [
      skillRel("scripts/ive_release_handoff.mjs"),
      skillRel("scripts/lib/ive_release_handoff.mjs"),
      skillRel("scripts/lib/ive_migration_bootstrap.mjs"),
      skillRel("scripts/lib/ive_projection.mjs"),
      skillRel("tests/test_ive_release_handoff.mjs"),
      "docs/ive-redesign/17_release_lane.md",
      "plans/programs/ive-runtime-build/program_packet.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/scripts\/ive_release_handoff\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_release_handoff\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_release_handoff\.mjs$/,
      /^plans\/programs\/ive-runtime-build\//,
      docsIvePattern("10_migration.md"),
      docsIvePattern("11_testing.md"),
      docsIvePattern("14_review_board.md"),
      docsIvePattern("17_release_lane.md"),
      /^\.agent\/skills\/iterative-planner\/config\/version\.json$/,
      /^\.agent\/skills\/iterative-planner\/MIGRATION\.md$/,
    ],
  }),
  suite({
    id: "projection-north-star",
    category: "projection",
    label: "IVE projection and North Star v2",
    command: ["node", join(TESTS_ROOT, "test_ive_projection_north_star.mjs")],
    phases: ["1", "2", "projection", "north-star"],
    surfaces: ["projection", "north_star", "structured_plan"],
    fixtures: [
      skillRel("tests/test_ive_projection_north_star.mjs"),
      skillRel("scripts/project_ive.mjs"),
      skillRel("scripts/lib/ive_projection.mjs"),
      skillRel("scripts/lib/planner_manifesto.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_projection_north_star\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/project_ive\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_projection\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/planner_manifesto\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      docsIvePattern("02_north_star.md"),
      docsIvePattern("09_roadmap.md"),
      docsIvePattern("10_migration.md"),
    ],
  }),
  suite({
    id: "profile-knowledge-packs",
    category: "knowledge_pack",
    label: "IVE profile evaluator and knowledge packs",
    command: ["node", join(TESTS_ROOT, "test_ive_profile_knowledge_packs.mjs")],
    phases: ["2.5", "2.6", "2.6a", "2.5,2.6", "profiles", "knowledge-packs"],
    surfaces: ["profile", "knowledge_pack", "ontology", "migration"],
    fixtures: [
      skillRel("tests/test_ive_profile_knowledge_packs.mjs"),
      skillRel("scripts/check_profile.mjs"),
      skillRel("scripts/knowledge_packs.mjs"),
      skillRel("scripts/lib/ive_profile_packs.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("profiles/quant_alpha.profile.json"),
      skillRel("knowledge_packs/machine_learning/pack.json"),
      skillRel("knowledge_packs/machine_learning/pitfalls.json"),
      skillRel("knowledge_packs/machine_learning/opportunities.json"),
      skillRel("knowledge_packs/machine_learning/constraints.json"),
      skillRel("knowledge_packs/machine_learning/decisions.json"),
      skillRel("knowledge_packs/machine_learning/vocabulary.json"),
      skillRel("knowledge_packs/machine_learning/canonical_artifacts.json"),
      skillRel("knowledge_packs/machine_learning_toolbox/pack.json"),
      skillRel("knowledge_packs/machine_learning_toolbox/tools.json"),
      skillRel("knowledge_packs/quant_results_communication/pack.json"),
      skillRel("knowledge_packs/product_management/pack.json"),
      skillRel("knowledge_packs/ux_ui_experience/pack.json"),
      skillRel("knowledge_packs/coaching_methodology/pack.json"),
      skillRel("knowledge_packs/software_engineering_methodology/pack.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_profile_knowledge_packs\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/check_profile\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/knowledge_packs\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_profile_packs\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/profiles\//,
      /^\.agent\/skills\/iterative-planner\/knowledge_packs\//,
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "cli-determinism",
    category: "cli_contract",
    label: "IVE JSON CLI determinism across pipe, TTY, path, and repeat runs",
    command: ["node", join(TESTS_ROOT, "test_cli_determinism.mjs")],
    phases: ["stage1", "cli-json", "determinism"],
    surfaces: ["cli", "json", "stdout", "tty", "path", "conformance"],
    fixtures: [
      skillRel("tests/test_cli_determinism.mjs"),
      skillRel("tests/test_emit_json_cli.mjs"),
      skillRel("scripts/lib/emit_json.mjs"),
      skillRel("scripts/knowledge_packs.mjs"),
      skillRel("scripts/project_ive.mjs"),
      skillRel("scripts/lib/ive_projection.mjs"),
      skillRel("scripts/reflection_guide.mjs"),
      skillRel("scripts/validate_reflection.mjs"),
      skillRel("scripts/ive_packet_validator.mjs"),
      skillRel("scripts/check_profile.mjs"),
      skillRel("scripts/journal.mjs"),
      skillRel("scripts/thrashing_detector.mjs"),
      skillRel("scripts/ive_release_handoff.mjs"),
      skillRel("scripts/lib/ive_release_handoff.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_cli_determinism\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/test_emit_json_cli\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/emit_json\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/(knowledge_packs|project_ive|reflection_guide|validate_reflection|ive_packet_validator|check_profile|journal|thrashing_detector|ive_release_handoff)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(ive_projection|ive_release_handoff)\.mjs$/,
    ],
  }),
  suite({
    id: "quant-results-validation",
    category: "quant",
    label: "IVE quant results validation semantic gates",
    command: ["node", join(TESTS_ROOT, "test_quant_results_validation.mjs")],
    phases: ["stage1", "e01", "e02", "t06", "provenance", "quant-results-validation", "semantic-gates"],
    surfaces: ["quant", "claim_ledger", "semantic_gate", "validation", "conformance"],
    fixtures: [
      skillRel("tests/test_quant_results_validation.mjs"),
      skillRel("scripts/lib/claim_ledger.mjs"),
      skillRel("scripts/lib/quant_results_validation.mjs"),
      skillRel("scripts/lib/measured_gate.mjs"),
      skillRel("scripts/lib/run_record.mjs"),
      skillRel("packs/quant/leakage_proof.mjs"),
      skillRel("scripts/ontology_serializer.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/claim_ledger\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/quant_results_validation\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/measured_gate\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/run_record\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/packs\/quant\/leakage_proof\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_serializer\.mjs$/,
    ],
  }),
  suite({
    id: "verification-runner",
    category: "structured_plan",
    label: "IVE verification runner provenance",
    command: ["node", join(TESTS_ROOT, "test_verification_runner.mjs")],
    phases: ["stage1", "t06", "provenance", "verification-runner"],
    surfaces: ["runner", "provenance", "verification", "program_packet"],
    fixtures: [
      skillRel("tests/test_verification_runner.mjs"),
      skillRel("tests/fixtures/programs/auto_executor.json"),
      skillRel("scripts/verification_runner.mjs"),
      skillRel("scripts/lib/run_record.mjs"),
      skillRel("config/program_packet.schema.json"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_verification_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/programs\/auto_executor\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/verification_runner\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/run_record\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/config\/program_packet\.schema\.json$/,
    ],
  }),
  suite({
    id: "ci-enforcement-contracts",
    category: "ci",
    label: "IVE CI enforcement and branch-protection contracts",
    command: ["node", join(TESTS_ROOT, "test_ci_enforcement_contracts.mjs")],
    phases: ["stage1", "ci-enforcement", "t04"],
    surfaces: ["ci", "git_hooks", "github", "conformance"],
    fixtures: [
      skillRel("tests/test_ci_enforcement_contracts.mjs"),
      skillRel("scripts/hooks/install.mjs"),
      skillRel("scripts/hooks/pre-push"),
      skillRel("scripts/hooks/pre_push_conformance.mjs"),
      skillRel("scripts/snapshot_branch_protection.mjs"),
      ".github/workflows/ive-conformance.yml",
      ".github/branch-protection.snapshot.json",
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ci_enforcement_contracts\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/hooks\/(install|pre_push_conformance)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/hooks\/pre-push$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/snapshot_branch_protection\.mjs$/,
      /^\.github\/workflows\/ive-conformance\.yml$/,
      /^\.github\/branch-protection\.snapshot\.json$/,
      /^apps\/ive-visualizer\//,
    ],
  }),
  suite({
    id: "planner-shell-wrapper-hooks",
    category: "ci",
    label: "Planner shell wrapper hooks and local advisory pre-commit policy",
    command: ["node", join(TESTS_ROOT, "test_planner_shell_wrappers.mjs")],
    phases: ["stage1", "ci-enforcement", "n03"],
    surfaces: ["git_hooks", "planner_runtime", "conformance"],
    fixtures: [skillRel("tests/test_planner_shell_wrappers.mjs"), skillRel("scripts/pre_commit_policy.mjs"), skillRel("scripts/hooks/pre-commit"), skillRel("scripts/hooks/pre-push"), skillRel("scripts/pre-commit-hook.sh"), skillRel("SKILL.md")],
    changedFilePatterns: [/^\.agent\/skills\/iterative-planner\/tests\/test_planner_shell_wrappers\.mjs$/, /^\.agent\/skills\/iterative-planner\/scripts\/pre_commit_policy\.mjs$/, /^\.agent\/skills\/iterative-planner\/scripts\/hooks\/pre-(commit|push)$/, /^\.agent\/skills\/iterative-planner\/scripts\/pre-commit-hook\.sh$/, /^\.agent\/skills\/iterative-planner\/SKILL\.md$/],
  }),
  suite({
    id: "active-ontology-temporal-provenance",
    category: "active_ontology",
    label: "IVE active ontology and temporal provenance",
    command: ["node", join(TESTS_ROOT, "test_ive_active_ontology.mjs")],
    phases: ["4.5", "active-ontology", "temporal-provenance"],
    surfaces: ["ontology", "provenance", "migration"],
    fixtures: [
      skillRel("tests/test_ive_active_ontology.mjs"),
      skillRel("scripts/ontology_write.mjs"),
      skillRel("scripts/lib/ive_active_ontology.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_active_ontology\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/ontology_write\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_active_ontology\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      docsIvePattern("07a_active_ontology_file.md"),
      docsIvePattern("07b_temporal_provenance.md"),
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "ideation-anchors-operators-intent",
    category: "ideation",
    label: "IVE ideation anchors, operators, and intent binding",
    command: ["node", join(TESTS_ROOT, "test_ive_ideation_operators.mjs")],
    phases: ["3", "ideation", "anchors", "operators", "intent-binding"],
    surfaces: ["ideation", "ontology", "structured_plan"],
    fixtures: [
      skillRel("tests/test_ive_ideation_operators.mjs"),
      skillRel("scripts/lib/ive_ideation_operators.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_ideation_operators\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_ideation_operators\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      docsIvePattern("03_ideation.md"),
      docsIvePattern("04a_reflection_as_diff.md"),
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "structured-evidence-reflection-diff",
    category: "reflection",
    label: "IVE structured evidence and reflection diff",
    command: ["node", join(TESTS_ROOT, "test_ive_reflection_diff.mjs")],
    phases: ["4", "4.6", "4,4.6", "t06", "provenance", "structured-evidence", "reflection-diff"],
    surfaces: ["evidence", "reflection", "ontology", "migration"],
    fixtures: [
      skillRel("tests/test_ive_reflection_diff.mjs"),
      skillRel("scripts/reflection_renderer.mjs"),
      skillRel("scripts/lib/ive_reflection_diff.mjs"),
      skillRel("scripts/lib/run_record.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_reflection_diff\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/reflection_renderer\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_reflection_diff\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/run_record\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/fact_loader\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
      docsIvePattern("04a_reflection_as_diff.md"),
      docsIvePattern("09_roadmap.md"),
      docsIvePattern("10_migration.md"),
    ],
  }),
  suite({
    id: "reflection-invariants",
    category: "reflection",
    label: "Structured REFLECT invariant contracts",
    command: ["node", join(TESTS_ROOT, "test_reflection_invariants.mjs")],
    phases: ["4", "reflection-invariants", "semantic-gates"],
    surfaces: ["reflection", "semantic_gate", "ontology"],
    fixtures: [
      skillRel("tests/test_reflection_invariants.mjs"),
      skillRel("scripts/lib/reflection_validation.mjs"),
      skillRel("scripts/lib/reflection_guide.mjs"),
      skillRel("scripts/lib/fact_loader.mjs"),
      skillRel("prolog/invariants.pl"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_reflection_invariants\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/(reflection_validation|reflection_guide|fact_loader)\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/prolog\/invariants\.pl$/,
    ],
  }),
  suite({
    id: "continuous-advisory-records",
    category: "advisory",
    label: "IVE continuous advisory records",
    command: ["node", join(TESTS_ROOT, "test_ive_advisory_records.mjs")],
    phases: ["4.7", "continuous-advisory", "advisory-records"],
    surfaces: ["advisory", "structured_plan", "migration"],
    fixtures: [
      skillRel("tests/test_ive_advisory_records.mjs"),
      skillRel("scripts/lib/ive_advisory_records.mjs"),
      skillRel("scripts/lib/ive_packet_contract.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_advisory_records\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_advisory_records\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_packet_contract\.mjs$/,
      docsIvePattern("04b_continuous_advisory.md"),
      docsIvePattern("09_roadmap.md"),
    ],
  }),
  suite({
    id: "scenario-harness",
    category: "scenario",
    label: "IVE scenario and negative closure harness",
    command: ["node", join(TESTS_ROOT, "test_ive_scenario_harness.mjs")],
    phases: ["scenarios"],
    surfaces: ["scenario", "structured_plan"],
    fixtures: [
      skillRel("tests/test_ive_scenario_harness.mjs"),
      skillRel("scripts/lib/ive_scenario_harness.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_ive_scenario_harness\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_scenario_harness\.mjs$/,
    ],
  }),
  suite({
    id: "real-episode-replay-corpus",
    category: "scenario",
    label: "Real Mac mini episode replay corpus",
    command: ["node", join(TESTS_ROOT, "test_real_episode_replay_corpus.mjs")],
    phases: ["scenarios", "real-episodes", "autocode-replay"],
    surfaces: ["scenario", "real_episode_corpus", "quant", "structured_plan"],
    fixtures: [
      skillRel("tests/test_real_episode_replay_corpus.mjs"),
      skillRel("tests/fixtures/real_episodes/mac_mini_quant_episodes.json"),
      skillRel("scripts/lib/ive_real_episode_corpus.mjs"),
      skillRel("scripts/lib/ive_scenario_harness.mjs"),
    ],
    changedFilePatterns: [
      /^\.agent\/skills\/iterative-planner\/tests\/test_real_episode_replay_corpus\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/tests\/fixtures\/real_episodes\/mac_mini_quant_episodes\.json$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_real_episode_corpus\.mjs$/,
      /^\.agent\/skills\/iterative-planner\/scripts\/lib\/ive_scenario_harness\.mjs$/,
    ],
  }),
];

function captureExcerpt(value) {
  const text = (value || "").toString();
  return text.length > STDOUT_EXCERPT_BYTES
    ? `${text.slice(0, STDOUT_EXCERPT_BYTES)}...[truncated]`
    : text;
}

function normalizeRepoPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function repoRelPath(absPath, repoRoot = REPO_ROOT) {
  return normalizeRepoPath(relative(repoRoot, absPath));
}

function sanitizeRunId(value, now = new Date()) {
  const fallback = `ive-${now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")}`;
  const raw = String(value || process.env.IVE_RUN_ID || fallback).trim() || fallback;
  return raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 120) || fallback;
}

function splitChangedFiles(values = []) {
  return values
    .flatMap((value) => String(value || "").split(/[\n,]/g))
    .map(normalizeRepoPath)
    .filter(Boolean);
}

function toManifestStatus(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "PASS") return "pass";
  if (normalized === "WARN" || normalized === "WARNING") return "warn";
  if (normalized === "SKIPPED" || normalized === "SKIP") return "skipped";
  if (normalized === "NOT_APPLICABLE" || normalized === "NOT-APPLICABLE") return "not_applicable";
  if (normalized === "NOT_IMPLEMENTED_YET" || normalized === "NOT-IMPLEMENTED-YET") return "not_implemented_yet";
  return "fail";
}

function statusForReport({ issues = [], warningCount = 0, skippedCount = 0 } = {}) {
  if (issues.length > 0) return "FAIL";
  if (warningCount > 0 || skippedCount > 0) return "WARN";
  return "PASS";
}

function patternMatches(pattern, file) {
  if (pattern instanceof RegExp) return pattern.test(file);
  if (typeof pattern === "string") {
    if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -3));
    return file === normalizeRepoPath(pattern);
  }
  return false;
}

function isRunnerSurfaceChange(file) {
  return [
    ".agent/skills/iterative-planner/tests/ive/run.mjs",
    ".agent/skills/iterative-planner/tests/ive/test_run.mjs",
    ".agent/skills/iterative-planner/tests/test_ive_conformance_runner.mjs",
    ".github/workflows/ive-conformance.yml",
  ].includes(file);
}

function selectedByChangedFiles(item, changedFiles = []) {
  if (!changedFiles.length) return true;
  if (changedFiles.some(isRunnerSurfaceChange)) return true;
  const patterns = item.changed_file_patterns || [];
  return changedFiles.some((file) => patterns.some((pattern) => patternMatches(pattern, file)));
}

function missingRequiredFixtures(item, repoRoot = REPO_ROOT) {
  return (item.fixtures || [])
    .map(normalizeRepoPath)
    .filter((fixture) => fixture && !existsSync(resolve(repoRoot, fixture)));
}

function commandEnv() {
  return {
    ...process.env,
    CODEX_THREAD_ID: "",
    _PLANNER_PLAN_TARGET: "",
    PLANNER_SKIP_SELF_HEAL: process.env.PLANNER_SKIP_SELF_HEAL || "1",
  };
}

function runExitCodeCheck(command, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd = undefined } = {}) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      cwd,
      env: commandEnv(),
    });
    return {
      status: "PASS",
      exit_code: 0,
      timed_out: false,
      stdout_excerpt: captureExcerpt(stdout),
      stderr_excerpt: "",
      raw_stdout: stdout,
      raw_stderr: "",
    };
  } catch (err) {
    const timedOut = err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    return {
      status: timedOut ? "TIMEOUT" : "FAIL",
      exit_code: timedOut ? -1 : (err.status ?? 1),
      timed_out: timedOut,
      stdout_excerpt: captureExcerpt(err.stdout || err.message),
      stderr_excerpt: captureExcerpt(err.stderr || ""),
      raw_stdout: (err.stdout || "").toString(),
      raw_stderr: (err.stderr || err.message || "").toString(),
    };
  }
}

function runVisualizerBrowserProof(_command, { timeoutMs = DEFAULT_TIMEOUT_MS, repoRoot = REPO_ROOT } = {}) {
  const appRoot = visualizerAppRoot(repoRoot);
  const playwrightBin = visualizerPlaywrightBin(repoRoot);
  if (!existsSync(playwrightBin)) {
    const reason = "playwright_dependency_missing";
    const guidance = "Run: npm ci --prefix apps/ive-visualizer && npm --prefix apps/ive-visualizer exec playwright -- install --with-deps chromium";
    return {
      status: "SKIPPED",
      exit_code: VISUALIZER_SKIP_EXIT_CODE,
      timed_out: false,
      status_reason: `${reason}: ${guidance}`,
      stdout_excerpt: `${reason}: ${guidance}`,
      stderr_excerpt: "",
      raw_stdout: `${reason}: ${guidance}\n`,
      raw_stderr: "",
    };
  }
  return runExitCodeCheck([playwrightBin, "test", "--config=playwright.config.mjs"], {
    timeoutMs,
    cwd: appRoot,
  });
}

function runDocContractCheck(command) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const count = parseInt(stdout.trim(), 10);
    if (Number.isFinite(count) && count >= 4) {
      return {
        status: "PASS",
        exit_code: 0,
        timed_out: false,
        stdout_excerpt: `count=${count}`,
        stderr_excerpt: "",
        raw_stdout: stdout,
        raw_stderr: "",
      };
    }
    return {
      status: "FAIL",
      exit_code: 0,
      timed_out: false,
      stdout_excerpt: `count=${count} (expected >=4)`,
      stderr_excerpt: "",
      raw_stdout: stdout,
      raw_stderr: "",
    };
  } catch (err) {
    return {
      status: "FAIL",
      exit_code: err.status ?? 1,
      timed_out: false,
      stdout_excerpt: captureExcerpt(err.stdout || err.message),
      stderr_excerpt: captureExcerpt(err.stderr || ""),
      raw_stdout: (err.stdout || "").toString(),
      raw_stderr: (err.stderr || err.message || "").toString(),
    };
  }
}

function runDocsContractsAggregate(_command, options) {
  const docSuites = DEFAULT_SUITES.filter((item) => item.id === "doc-contract-mvp" || item.id === "doc-contract-multi-ide");
  const results = docSuites.map((item) => executeSuite(item, options));
  const failed = results.filter((result) => result.status !== "PASS");
  return {
    status: failed.length === 0 ? "PASS" : "FAIL",
    exit_code: failed.length === 0 ? 0 : 1,
    timed_out: results.some((result) => result.timed_out),
    stdout_excerpt: captureExcerpt(JSON.stringify(results.map((result) => ({
      id: result.id,
      status: result.status,
      stdout_excerpt: result.stdout_excerpt,
    })))),
    stderr_excerpt: "",
    raw_stdout: JSON.stringify(results, null, 2),
    raw_stderr: "",
  };
}

function executeSuite(item, options = {}) {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const injectedTarget = process.env.IVE_RUNNER_INJECT_FAILURE || null;
  const missingFixtures = missingRequiredFixtures(item, options.repoRoot || REPO_ROOT);
  let result;

  if (missingFixtures.length > 0) {
    result = {
      status: "NOT_IMPLEMENTED_YET",
      exit_code: 66,
      timed_out: false,
      stdout_excerpt: `missing required fixture(s): ${missingFixtures.join(", ")}`,
      stderr_excerpt: "",
      raw_stdout: "",
      raw_stderr: "",
      status_reason: "missing_required_fixture",
      missing_fixtures: missingFixtures,
    };
  } else if (injectedTarget && injectedTarget === item.id) {
    result = {
      status: "FAIL",
      exit_code: 99,
      timed_out: false,
      stdout_excerpt: `injected failure via IVE_RUNNER_INJECT_FAILURE=${item.id}`,
      stderr_excerpt: "",
      raw_stdout: `injected failure via IVE_RUNNER_INJECT_FAILURE=${item.id}`,
      raw_stderr: "",
      injected: true,
    };
  } else {
    const runner = item.run || runExitCodeCheck;
    const itemTimeoutMs = Number.isFinite(item.timeout_ms) && item.timeout_ms > 0
      ? item.timeout_ms
      : options.timeoutMs;
    result = runner(item.command, { ...options, timeoutMs: itemTimeoutMs });
  }

  return {
    id: item.id,
    name: item.id,
    category: item.category,
    label: item.label,
    required: item.required !== false,
    command: item.display_command,
    status: result.status,
    manifest_status: toManifestStatus(result.status),
    status_reason: result.status_reason || "",
    missing_fixtures: result.missing_fixtures || [],
    surfaces: item.surfaces || [item.category],
    phases: item.phases || [],
    exit_code: result.exit_code,
    timed_out: !!result.timed_out,
    duration_ms: Date.now() - t0,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stdout_excerpt: result.stdout_excerpt || "",
    stderr_excerpt: result.stderr_excerpt || "",
    raw_stdout: result.raw_stdout ?? result.stdout_excerpt ?? "",
    raw_stderr: result.raw_stderr ?? result.stderr_excerpt ?? "",
    injected: !!result.injected,
  };
}

function selectedByOnly(item, filters) {
  if (!filters.length) return true;
  return filters.some((filter) => {
    const normalized = String(filter || "").trim();
    return normalized === item.id || normalized === item.name || normalized === item.category;
  });
}

function selectedByPhase(item, phase) {
  if (!phase || phase === "all") return true;
  const phases = String(phase)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (phases.length === 0) return true;
  return phases.some((entry) => (item.phases || []).includes(entry));
}

function selectSuites(suites = DEFAULT_SUITES, only = [], phase = "all", changedFiles = []) {
  const normalizedChangedFiles = splitChangedFiles(changedFiles);
  return suites.filter((item) =>
    selectedByOnly(item, only) &&
    selectedByPhase(item, phase) &&
    selectedByChangedFiles(item, normalizedChangedFiles)
  );
}

function normalizeResult(item, result) {
  const status = String(result.status || "FAIL").trim().toUpperCase();
  return {
    id: result.id || item.id,
    name: result.name || result.id || item.id,
    category: result.category || item.category,
    label: result.label || item.label,
    required: result.required !== false && item.required !== false,
    command: result.command || item.display_command,
    status,
    manifest_status: result.manifest_status || toManifestStatus(status),
    status_reason: result.status_reason || "",
    missing_fixtures: result.missing_fixtures || [],
    surfaces: result.surfaces || item.surfaces || [item.category],
    phases: result.phases || item.phases || [],
    exit_code: result.exit_code,
    timed_out: !!result.timed_out,
    duration_ms: result.duration_ms ?? 0,
    started_at: result.started_at || null,
    finished_at: result.finished_at || null,
    stdout_excerpt: result.stdout_excerpt || "",
    stderr_excerpt: result.stderr_excerpt || "",
    raw_stdout: result.raw_stdout ?? result.stdout_excerpt ?? "",
    raw_stderr: result.raw_stderr ?? result.stderr_excerpt ?? "",
    injected: !!result.injected,
  };
}

function syntheticNotApplicableResult(changedFiles) {
  const message = `No IVE conformance suite matched changed files: ${changedFiles.join(", ") || "(none)"}`;
  return {
    id: "changed-files-not-applicable",
    name: "changed-files-not-applicable",
    category: "selection",
    label: "Changed files outside declared IVE surfaces",
    required: false,
    command: "changed-files selector",
    status: "NOT_APPLICABLE",
    manifest_status: "not_applicable",
    status_reason: "changed_files_outside_declared_ive_surfaces",
    exit_code: 0,
    timed_out: false,
    duration_ms: 0,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    stdout_excerpt: message,
    stderr_excerpt: "",
    raw_stdout: message,
    raw_stderr: "",
    surfaces: ["selection"],
    phases: [],
  };
}

function publicResult(result) {
  const { raw_stdout, raw_stderr, ...rest } = result;
  return rest;
}

function writeRunArtifacts(report, {
  repoRoot = REPO_ROOT,
  reportRoot = REPORT_ROOT,
} = {}) {
  const reportDir = join(reportRoot, report.run_id);
  const logsDir = join(reportDir, "logs");
  try {
    mkdirSync(logsDir, { recursive: true });
    for (const result of report.results) {
      const stdoutPath = join(logsDir, `${result.id}.stdout.log`);
      const stderrPath = join(logsDir, `${result.id}.stderr.log`);
      const artifactPath = join(reportDir, `${result.id}.json`);
      writeFileSync(stdoutPath, result.raw_stdout || result.stdout_excerpt || "");
      writeFileSync(stderrPath, result.raw_stderr || result.stderr_excerpt || "");
      result.stdout_log = repoRelPath(stdoutPath, repoRoot);
      result.stderr_log = repoRelPath(stderrPath, repoRoot);
      result.proof_artifact = repoRelPath(artifactPath, repoRoot);
      writeFileSync(artifactPath, JSON.stringify(publicResult(result), null, 2) + "\n");
    }

    const manifestPath = join(reportDir, "manifest.json");
    report.report_dir = repoRelPath(reportDir, repoRoot);
    report.manifest_path = repoRelPath(manifestPath, repoRoot);
    report.suites = report.results.map((result) => ({
      id: result.id,
      surface: result.surfaces?.[0] || result.category,
      category: result.category,
      status: result.manifest_status,
      status_reason: result.status_reason || "",
      required: result.required,
      command: result.command,
      proof_artifact: result.proof_artifact,
      stdout_log: result.stdout_log,
      stderr_log: result.stderr_log,
    }));
    const manifest = {
      schema_version: SCHEMA_VERSION,
      run_id: report.run_id,
      phase: report.phase,
      changed_files: report.changed_files,
      suites: report.suites,
      overall_status: report.overall_status,
      summary: report.summary,
      issues: report.issues,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { ok: true, manifest_path: report.manifest_path, report_dir: report.report_dir };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function runConformance({
  suites = DEFAULT_SUITES,
  only = [],
  phase = "all",
  changedFiles = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  executeCommand = executeSuite,
  writeManifest = false,
  runId = null,
  repoRoot = REPO_ROOT,
  reportRoot = REPORT_ROOT,
} = {}) {
  const runStartedAt = new Date().toISOString();
  const normalizedChangedFiles = splitChangedFiles(changedFiles);
  const baseSelected = suites.filter((item) => selectedByOnly(item, only) && selectedByPhase(item, phase));
  const selected = normalizedChangedFiles.length
    ? baseSelected.filter((item) => selectedByChangedFiles(item, normalizedChangedFiles))
    : baseSelected;
  const issues = [];

  if (baseSelected.length === 0) {
    issues.push({
      code: "no_matching_suite",
      suite_id: null,
      message: `No IVE conformance suite matched only=${only.join(",") || "*"} phase=${phase || "all"}`,
    });
  }

  const results = selected.map((item) => normalizeResult(
    item,
    executeCommand(item, {
      timeoutMs: Number.isFinite(item.timeout_ms) && item.timeout_ms > 0 ? item.timeout_ms : timeoutMs,
      repoRoot,
    })
  ));

  if (baseSelected.length > 0 && normalizedChangedFiles.length > 0 && selected.length === 0) {
    results.push(syntheticNotApplicableResult(normalizedChangedFiles));
  }

  const failedRequired = [];
  let warningCount = 0;
  let skippedCount = 0;
  let notApplicableCount = 0;
  let notImplementedCount = 0;

  for (const result of results) {
    if (result.status === "WARN") warningCount += 1;
    if (result.status === "SKIPPED") skippedCount += 1;
    if (result.status === "NOT_APPLICABLE") notApplicableCount += 1;
    if (result.status === "NOT_IMPLEMENTED_YET") notImplementedCount += 1;

    if (result.status === "NOT_APPLICABLE" && !result.status_reason) {
      issues.push({
        code: "not_applicable_without_reason",
        suite_id: result.id,
        message: `${result.id} reported NOT_APPLICABLE without a status_reason`,
      });
    }

    if (result.status === "SKIPPED" && !result.status_reason) {
      issues.push({
        code: "skipped_without_reason",
        suite_id: result.id,
        message: `${result.id} reported SKIPPED without a status_reason`,
      });
    }

    if (result.required && FAILING_STATUSES.has(result.status)) {
      failedRequired.push(result);
      issues.push({
        code: result.status === "NOT_IMPLEMENTED_YET"
          ? "required_fixture_missing"
          : result.timed_out ? "required_suite_timeout" : "required_suite_failed",
        suite_id: result.id,
        message: `${result.id} reported ${result.status}`,
        missing_fixtures: result.missing_fixtures || [],
      });
    }
  }

  const passedCount = results.filter((result) => result.status === "PASS").length;
  const status = statusForReport({ issues, warningCount, skippedCount });
  const allNotApplicable = results.length > 0 && results.every((result) => result.manifest_status === "not_applicable");
  const overallStatus = status === "FAIL"
    ? "fail"
    : warningCount > 0 || skippedCount > 0 ? "warn" : allNotApplicable ? "not_applicable" : "pass";
  const report = {
    schema_version: SCHEMA_VERSION,
    run_id: sanitizeRunId(runId),
    phase,
    changed_files: normalizedChangedFiles,
    run_started_at: runStartedAt,
    run_finished_at: new Date().toISOString(),
    ok: issues.length === 0,
    status,
    overall_status: overallStatus,
    command_count: results.length,
    passed_count: passedCount,
    failed_required_count: failedRequired.length,
    warning_count: warningCount,
    skipped_count: skippedCount,
    not_applicable_count: notApplicableCount,
    not_implemented_count: notImplementedCount,
    categories: [...new Set(results.map((result) => result.category))],
    results,
    checks: results,
    summary: {
      total: results.length,
      passed: passedCount,
      warned: warningCount,
      skipped: skippedCount,
      not_applicable: notApplicableCount,
      not_implemented: notImplementedCount,
      failed: results.filter((result) => FAILING_STATUSES.has(result.status) || result.status === "FAIL").length,
    },
    issues,
  };

  if (writeManifest) {
    const artifactResult = writeRunArtifacts(report, { repoRoot, reportRoot });
    if (!artifactResult.ok) {
      report.issues.push({
        code: "manifest_write_failed",
        suite_id: null,
        message: artifactResult.reason,
      });
      report.ok = false;
      report.status = "FAIL";
      report.overall_status = "fail";
    }
  }

  report.results = report.results.map(publicResult);
  report.checks = report.results;

  const injectedTarget = process.env.IVE_RUNNER_INJECT_FAILURE || null;
  if (injectedTarget) {
    report.runner_metadata = {
      injected_failures: results.filter((result) => result.injected).map((result) => result.id),
    };
  }

  return report;
}

function listSuites(suites = DEFAULT_SUITES) {
  return {
    ok: true,
    status: "LIST",
    suite_count: suites.length,
    suites: suites.map((item) => ({
      id: item.id,
      category: item.category,
      label: item.label,
      required: item.required !== false,
      phases: item.phases || [],
      surfaces: item.surfaces || [item.category],
      fixtures: item.fixtures || [],
      changed_file_patterns: (item.changed_file_patterns || []).map((pattern) => pattern.toString()),
      command: item.display_command,
    })),
  };
}

function parseArgs(argv = []) {
  const parsed = {
    json: false,
    list: false,
    only: [],
    phase: "all",
    changedFiles: [],
    runId: null,
    writeManifest: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--only") parsed.only.push(argv[++index] || "");
    else if (arg.startsWith("--only=")) parsed.only.push(arg.slice("--only=".length));
    else if (arg === "--phase") parsed.phase = argv[++index] || "all";
    else if (arg.startsWith("--phase=")) parsed.phase = arg.slice("--phase=".length) || "all";
    else if (arg === "--changed-files") parsed.changedFiles.push(argv[++index] || "");
    else if (arg.startsWith("--changed-files=")) parsed.changedFiles.push(arg.slice("--changed-files=".length));
    else if (arg === "--run-id") parsed.runId = argv[++index] || null;
    else if (arg.startsWith("--run-id=")) parsed.runId = arg.slice("--run-id=".length) || null;
    else if (arg === "--no-manifest") parsed.writeManifest = false;
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number.parseInt(argv[++index] || "", 10);
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = Number.parseInt(arg.slice("--timeout-ms=".length), 10);
  }

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    parsed.timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  return parsed;
}

function usage() {
  return `Usage:
  node .agent/skills/iterative-planner/tests/ive/run.mjs [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --list [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --only <id-or-category> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --phase <phase-id> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --changed-files <file-list> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --run-id <stable-id> [--json]
  node .agent/skills/iterative-planner/tests/ive/run.mjs --no-manifest [--json]`;
}

function printText(report) {
  if (report.status === "LIST") {
    console.log(`IVE conformance suites: ${report.suite_count}`);
    for (const item of report.suites) {
      console.log(`  - ${item.id} [${item.category}] ${item.command}`);
    }
    return;
  }

  console.log(`IVE conformance runner: ${report.status}`);
  console.log(`  started:  ${report.run_started_at}`);
  console.log(`  finished: ${report.run_finished_at}`);
  console.log(`  checks:   ${report.summary.passed} passed / ${report.summary.failed} failed`);
  console.log();
  for (const result of report.results) {
    const icon = result.status === "PASS" ? "PASS" : result.status === "SKIPPED" ? "SKIP" : "FAIL";
    console.log(`  ${icon} ${result.name} (${result.duration_ms}ms, exit ${result.exit_code})`);
    if (result.status !== "PASS") {
      const excerpt = (result.stderr_excerpt || result.stdout_excerpt || "").split("\n").slice(0, 5).join("\n");
      if (excerpt) console.log(excerpt.split("\n").map((line) => `      ${line}`).join("\n"));
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const report = args.list
    ? listSuites(DEFAULT_SUITES)
    : runConformance({
      suites: DEFAULT_SUITES,
      only: args.only,
      phase: args.phase,
      changedFiles: args.changedFiles,
      timeoutMs: args.timeoutMs,
      runId: args.runId,
      writeManifest: args.writeManifest,
    });

  if (args.json) emitJson(report);
  else printText(report);
  return report.status === "FAIL" ? 1 : 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}

export {
  DEFAULT_SUITES,
  listSuites,
  parseArgs,
  runConformance,
  selectSuites,
};
