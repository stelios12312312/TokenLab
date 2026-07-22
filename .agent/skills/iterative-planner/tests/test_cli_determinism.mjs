#!/usr/bin/env node
// test_cli_determinism.mjs - n01 regression suite for planner JSON CLI determinism.

import { spawnSync } from "child_process";
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const scriptsDir = join(skillDir, "scripts");
const repoRoot = resolve(skillDir, "..", "..", "..");
const conformanceRunnerPath = join(testDir, "ive", "run.mjs");
const NODE = process.execPath;
const MAX_BUFFER = 40 * 1024 * 1024;
const LARGE_JSON_BYTES = 16 * 1024;
const FIXED_TIMESTAMP = "2026-01-01T00:00:00Z";

const declaredVolatileTimeFields = new Set([
  "as_of",
  "checked_at",
  "collected_at",
  "completed_at",
  "created_at",
  "emitted_at",
  "executed_at",
  "expires_at",
  "generated_at",
  "report_timestamp",
  "rolled_back_at",
  "run_at",
  "timestamp",
  "updated_at",
  "validated_at",
]);

const executableDescriptors = [
  {
    fileName: "knowledge_packs.mjs",
    label: "knowledge_packs machine_learning",
    args: ({ skillDir }) => [scriptPath(skillDir, "knowledge_packs.mjs"), "--pack", "machine_learning", "--json"],
    minBytes: LARGE_JSON_BYTES,
  },
  {
    fileName: "project_ive.mjs",
    label: "project_ive plan replay",
    delegatedJsonFlag: "scripts/lib/ive_projection.mjs",
    args: ({ skillDir }) => [scriptPath(skillDir, "project_ive.mjs"), "--plans", "8", "--json"],
    minBytes: LARGE_JSON_BYTES,
  },
  {
    fileName: "reflection_guide.mjs",
    label: "reflection_guide fixture",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "reflection_guide.mjs"), "--plan", "plan_emit_json", "--json"],
    cwd: ({ fixtures }) => fixtures.reflectionRoot,
  },
  {
    fileName: "validate_reflection.mjs",
    label: "validate_reflection missing file",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "validate_reflection.mjs"), fixtures.missingReflectionPath, "--json"],
    stream: "stderr",
  },
  {
    fileName: "ive_packet_validator.mjs",
    label: "ive_packet_validator large failure",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "ive_packet_validator.mjs"), fixtures.largePacketPath, "--json"],
    minBytes: LARGE_JSON_BYTES,
  },
  {
    fileName: "check_profile.mjs",
    label: "check_profile quant_alpha",
    args: ({ skillDir }) => [scriptPath(skillDir, "check_profile.mjs"), "--profile", "quant_alpha", "--gate", "plan-to-execute", "--json", "--no-cache"],
  },
  {
    fileName: "contract_reliability.mjs",
    label: "contract_reliability registry",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "contract_reliability.mjs"), "check", "--registry", fixtures.contractRegistryPath, "--json"],
  },
  {
    fileName: "behavior_report.mjs",
    label: "behavior_report over a fixture plans dir",
    args: ({ skillDir, fixtures }) => [scriptPath(skillDir, "behavior_report.mjs"), "--plans-dir", join(fixtures.autonomousRoot, "plans"), "--json"],
  },
  {
    fileName: "workspace_artifact_inventory.mjs",
    label: "workspace_artifact_inventory registry fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "workspace_artifact_inventory.mjs"),
      "--registry",
      fixtures.workspaceInventoryRegistryPath,
      "--root",
      fixtures.workspaceInventoryHome,
      "--max-depth",
      "4",
      "--sample-limit",
      "3",
      "--json",
    ],
  },
  {
    fileName: "episode_source_harvest.mjs",
    label: "episode_source_harvest fixture",
    args: ({ skillDir, fixtures }) => [
      scriptPath(skillDir, "episode_source_harvest.mjs"),
      "--scan-root",
      fixtures.episodeSourceRoot,
      "--max-depth",
      "3",
      "--artifact-depth",
      "5",
      "--candidate-limit",
      "6",
      "--json",
    ],
  },
  {
    fileName: "knowledge_triggers.mjs",
    label: "knowledge_triggers validate",
    args: ({ skillDir }) => [scriptPath(skillDir, "knowledge_triggers.mjs"), "--validate", "--json"],
  },
  {
    fileName: "journal.mjs",
    label: "journal facts absent-file fixture",
    args: ({ skillDir }) => [scriptPath(skillDir, "journal.mjs"), "facts", "--json"],
  },
  {
    fileName: "ontology_namespace_check.mjs",
    label: "ontology_namespace_check baseline",
    args: ({ skillDir }) => [scriptPath(skillDir, "ontology_namespace_check.mjs"), "--json"],
  },
  {
    fileName: "thrashing_detector.mjs",
    label: "thrashing_detector fixture",
    args: ({ skillDir }) => [scriptPath(skillDir, "thrashing_detector.mjs"), "--plan", "plans/plan_emit_json", "--json"],
    cwd: ({ fixtures }) => fixtures.reflectionRoot,
    stream: "stderr",
  },
  {
    fileName: "ive_release_handoff.mjs",
    label: "ive_release_handoff no-write",
    delegatedJsonFlag: "scripts/lib/ive_release_handoff.mjs",
    args: ({ skillDir }) => [scriptPath(skillDir, "ive_release_handoff.mjs"), "--plans", "1", "--no-write", "--no-rollback-drill", "--json"],
  },
  {
    fileName: "autonomous_driver.mjs",
    label: "autonomous_driver already closed",
    args: ({ skillDir }) => [scriptPath(skillDir, "autonomous_driver.mjs"), "run", "--until", "close", "--plan", "plan_autonomous_closed", "--json"],
    cwd: ({ fixtures }) => fixtures.autonomousRoot,
  },
];

const inventoryExemptions = new Map([
  "annotation_assist.mjs",
  "annotation_hints.mjs",
  "annotation_parser.mjs",
  "annotation_quality.mjs",
  "advise.mjs",
  "audit_runner.mjs",
  "batch.mjs",
  "blast_radius.mjs",
  "bootstrap.mjs",
  "bootstrap_registry.mjs",
  "close_signals.mjs",
  "convention_inducer.mjs",
  "conventions.mjs",
  "escalation_check.mjs",
  "gate_compliance.mjs",
  "gate_false_failure_ledger.mjs",
  "gate_idempotence_check.mjs",
  "gate_prepare.mjs",
  "generate_tests.mjs",
  "harvest_real_telemetry.mjs",
  "github_ticket_review.mjs",
  "intent_contract_bootstrap.mjs",
  "ive_program_intake.mjs",
  "ive_user_verdict.mjs",
  "knowledge_benchmark.mjs",
  "knowledge_resolver.mjs",
  "llm_drift_auditor.mjs",
  "llm_drift_maintenance.mjs",
  "migrate.mjs",
  "ontology_cli.mjs",
  "ontology_context.mjs",
  "ontology_inducer.mjs",
  "ontology_serializer.mjs",
  "ontology_write.mjs",
  "orient.mjs",
  "persona_adapt.mjs",
  "persona_execute.mjs",
  "persona_manifest_ci.mjs",
  "persona_manifest_verify.mjs",
  "planner.mjs",
  "planner_findings.mjs",
  "planner_hygiene.mjs",
  "planner_preflight.mjs",
  "pre_commit_policy.mjs",
  "program_manager.mjs",
  "project.mjs",
  "project_health.mjs",
  "recipe_bootstrap.mjs",
  "recipe_discovery.mjs",
  "recipe_fleet_audit.mjs",
  "recipe_resolver.mjs",
  "recipe_runner.mjs",
  "recipe_validate.mjs",
  "replay_telemetry.mjs",
  "reflection_renderer.mjs",
  "retro_registry.mjs",
  "review_intake.mjs",
  "ripple_check.mjs",
  "ritual_lint.mjs",
  "rule_engine.mjs",
  "security_audit.mjs",
  "semantic_maintenance.mjs",
  "semantic_map.mjs",
  "snapshot_branch_protection.mjs",
  "spot_check_worker.mjs",
  "story_cli.mjs",
  "story_registry.mjs",
  "story_registry_bootstrap.mjs",
  "substrate_check.mjs",
  "task_intake.mjs",
  "telemetry.mjs",
  "test_run_record.mjs",
  "transition.mjs",
  "validate_mini_reflection.mjs",
  "verification_matrix.mjs",
  "verification_metrics.mjs",
  "verification_runner.mjs",
  "verification_strategy.mjs",
  "verify_gate.mjs",
  "work_preflight.mjs",
  "workflow.mjs",
].map((fileName) => [
  fileName,
  "Inventory-owned exemption: command requires workflow-specific state, subcommands, or mutation-safe fixtures before it can join the generic deterministic execution set.",
]));

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, String(value));
}

function scriptPath(currentSkillDir, fileName) {
  return join(currentSkillDir, "scripts", fileName);
}

function baseEnv() {
  return {
    ...process.env,
    IVE_MIGRATION_TIMESTAMP: FIXED_TIMESTAMP,
    IVE_RELEASE_HANDOFF_TIMESTAMP: FIXED_TIMESTAMP,
    NO_COLOR: "1",
    PLANNER_SKIP_SELF_HEAL: "1",
  };
}

function runNode(args, { cwd = repoRoot, env = {} } = {}) {
  return spawnSync(NODE, args, {
    cwd,
    env: { ...baseEnv(), ...env },
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runPty(args, { cwd = repoRoot } = {}) {
  if (process.platform === "win32") {
    return { status: 127, stdout: "", stderr: "script(1) PTY wrapper is unavailable on win32" };
  }
  const scriptArgs = process.platform === "darwin"
    ? ["-q", "/dev/null", NODE, ...args]
    : ["-q", "-e", "-c", [NODE, ...args].map(shellQuote).join(" "), "/dev/null"];
  return spawnSync("script", scriptArgs, {
    cwd,
    env: baseEnv(),
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function extractJsonText(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  const direct = raw.trim();
  if (direct) {
    try {
      JSON.parse(direct);
      return direct;
    } catch {
      // PTY transcripts may include control bytes around the JSON payload.
    }
  }
  const starts = ["{", "["]
    .map((char) => ({ char, index: raw.indexOf(char) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  for (const { char, index } of starts) {
    const endChar = char === "{" ? "}" : "]";
    const end = raw.lastIndexOf(endChar);
    if (end <= index) continue;
    const candidate = raw.slice(index, end + 1).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep looking for another JSON opener.
    }
  }
  return direct;
}

function parseJsonFromResult(result, label, { stream = "stdout", pty = false } = {}) {
  const text = pty ? `${result.stdout || ""}${result.stderr || ""}` : (stream === "stderr" ? result.stderr : result.stdout);
  const jsonText = pty ? extractJsonText(text) : String(text || "").trim();
  try {
    return {
      ok: true,
      parsed: JSON.parse(jsonText),
      text: jsonText,
      byteLength: Buffer.byteLength(jsonText),
      status: result.status,
    };
  } catch (error) {
    return {
      ok: false,
      parsed: null,
      text: jsonText,
      byteLength: Buffer.byteLength(jsonText || ""),
      status: result.status,
      error: `${label}: ${error.message}`,
    };
  }
}

function normalizeVolatile(value, key = null) {
  if (key && declaredVolatileTimeFields.has(key)) return "<declared-time>";
  if (Array.isArray(value)) return value.map((entry) => normalizeVolatile(entry));
  if (!value || typeof value !== "object") return value;
  const normalized = {};
  for (const itemKey of Object.keys(value).sort()) {
    normalized[itemKey] = normalizeVolatile(value[itemKey], itemKey);
  }
  return normalized;
}

function canonicalJson(value) {
  return JSON.stringify(normalizeVolatile(value));
}

function makeLargePacket(packetPath) {
  const packet = {
    schema_version: 1,
    intent: { goal: "Exercise large JSON emission through validator failure output." },
    source_findings: [],
    concept_dictionary: {},
    fact_routes: [],
    closure_status: "closeable",
    closure_reason: "Fixture intentionally fails route validation.",
    advisory_review: { status: "not_run" },
  };
  for (let index = 0; index < 520; index += 1) {
    packet.fact_routes.push({
      source_finding: `F-${index}`,
      ontology_fact: "",
      status: "maybe",
      valid_next_action: "nope",
    });
  }
  writeJson(packetPath, packet);
}

function makeReflectionFixture(root) {
  const planDir = join(root, "plans", "plan_emit_json");
  writeText(join(planDir, "plan.md"), [
    "# Plan v0",
    "",
    "## Goal",
    "Emit JSON reflection guide fixture",
    "",
    "## Files To Modify",
    "- fixture.md",
    "",
    "## Success Criteria",
    "| ID | Criterion | Story linkage | Validation method |",
    "|---|---|---|---|",
    "| sc_1 | Fixture succeeds | US-003 | CLI parse proof |",
    "",
    "## Verification Strategy",
    "| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |",
    "|---|---|---|---|---|---|---|",
    "| sc_1 | US-003 | Fixture | proof:integration_smoke | fixture | pass | None |",
    "",
  ].join("\n"));
  writeText(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] Fixture\n");
  writeJson(join(planDir, "state.json"), {
    version: 1,
    state: "REFLECT",
    goal: "Emit JSON reflection guide fixture",
    transitions: [],
  });
  writeJson(join(planDir, "metrics.json"), {
    stage_reversals: 0,
    repeated_gate_failures: 0,
    reflection_rewrites: 0,
  });
  writeJson(join(root, "reports", "user_story_audit", "story_registry.json"), {
    stories: [{ id: "US-003", title: "Gate verification", status: "ACTIVE" }],
  });
  return root;
}

function makeAutonomousDriverFixture(root) {
  const planDir = join(root, "plans", "plan_autonomous_closed");
  writeJson(join(planDir, "state.json"), {
    version: 1,
    state: "CLOSE",
    goal: "Already closed autonomous driver determinism fixture",
    transitions: [],
  });
  writeText(join(root, "plans", ".current_plan"), "plan_autonomous_closed\n");
  return root;
}

function makeContractRegistryFixture(path) {
  writeJson(path, {
    id: "cli_determinism_contract_registry",
    version: 1,
    contracts: [
      {
        id: "report_shape",
        type: "output_contract",
        artifact_text: "# Report\n\n## Evidence\nProof refs: VM-001.\n",
        required_sections: ["Evidence"],
        required_signals: ["Proof refs"],
        forbidden_placeholders: ["TODO"],
      },
    ],
  });
  return path;
}

function makeWorkspaceInventoryFixture(root) {
  const fixtureRoot = join(root, "workspace_inventory");
  const presentProject = join(fixtureRoot, "present_project");
  const currentHome = join(fixtureRoot, "home");
  const registryPath = join(fixtureRoot, "registry.json");
  writeText(join(presentProject, "plans", "plan_2026-01-01_fixture", "decisions.md"), "decision\n");
  writeText(join(presentProject, "plans", "knowledge", "mistakes.md"), "mistake\n");
  writeText(join(presentProject, "reports", "ive", "report.json"), "{}\n");
  writeText(join(presentProject, ".codex", "transcripts", "session.jsonl"), "{}\n");
  ensureDir(join(currentHome, "old_workspace"));
  writeJson(registryPath, {
    projects: [
      { path: presentProject, type: "standard", last_upgraded: "2026-01-01T00:00:00.000Z" },
      { path: "/Users/old/old_workspace/missing_project", type: "standard" },
      { path: "relative/path", type: "standard" },
    ],
    scan_roots: ["/Users/old/old_workspace"],
    source_project_path: presentProject,
  });
  return { registryPath, currentHome };
}

function makeEpisodeSourceFixture(root) {
  const scanRoot = join(root, "episode_sources");
  const project = join(scanRoot, "quant_project");
  ensureDir(join(project, ".git"));
  writeText(join(project, "AGENTS.md"), "# Agent fixture\n");
  writeText(
    join(project, "plans", "plan_2026-01-01_episode", "decisions.md"),
    "Aha: the agent loop missed temporal leakage during optimizer verification.\n"
  );
  writeText(
    join(project, "plans", "knowledge", "retros", "case.md"),
    "Root cause: false-green ontology routing hid the verification gap.\n"
  );
  writeText(
    join(project, "reports", "quant", "backtest_report.md"),
    "Calibration, OOS holdout, and no-alpha claim boundary.\n"
  );
  return scanRoot;
}

function prepareFixtures(root) {
  const fixtureRoot = join(root, ".tmp_cli_determinism");
  const reflectionRoot = makeReflectionFixture(join(fixtureRoot, "reflection-root"));
  const autonomousRoot = makeAutonomousDriverFixture(join(fixtureRoot, "autonomous-root"));
  const largePacketPath = join(fixtureRoot, "large_packet.json");
  const contractRegistryPath = makeContractRegistryFixture(join(fixtureRoot, "contract_registry.json"));
  const workspaceInventory = makeWorkspaceInventoryFixture(fixtureRoot);
  const episodeSourceRoot = makeEpisodeSourceFixture(fixtureRoot);
  makeLargePacket(largePacketPath);
  return {
    root,
    skillDir: join(root, ".agent", "skills", "iterative-planner"),
    reflectionRoot,
    autonomousRoot,
    largePacketPath,
    contractRegistryPath,
    workspaceInventoryRegistryPath: workspaceInventory.registryPath,
    workspaceInventoryHome: workspaceInventory.currentHome,
    episodeSourceRoot,
    missingReflectionPath: join(fixtureRoot, "missing_reflection.md"),
  };
}

function copyMinimalCheckout(tmp) {
  const target = join(tmp, "ive checkout (determinism)");
  ensureDir(target);
  cpSync(join(repoRoot, ".agent"), join(target, ".agent"), { recursive: true });
  cpSync(join(repoRoot, "docs"), join(target, "docs"), { recursive: true });
  cpSync(join(repoRoot, "plans", "programs"), join(target, "plans", "programs"), { recursive: true });
  return target;
}

function discoverJsonCliScripts() {
  return readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => readFileSync(join(scriptsDir, name), "utf-8").includes("--json"))
    .sort();
}

function assertInventoryClosed() {
  const discovered = discoverJsonCliScripts();
  const descriptorNames = new Set(executableDescriptors.map((descriptor) => descriptor.fileName));
  const exemptNames = new Set(inventoryExemptions.keys());
  const missing = discovered.filter((name) => !descriptorNames.has(name) && !exemptNames.has(name));
  const staleDescriptors = executableDescriptors
    .filter((descriptor) => !discovered.includes(descriptor.fileName) && !descriptor.delegatedJsonFlag)
    .map((descriptor) => descriptor.fileName);
  const staleExemptions = [...exemptNames].filter((name) => !discovered.includes(name));
  assert(missing.length === 0, "all discovered --json scripts are covered or explicitly exempted", missing.join(", "));
  assert(staleDescriptors.length === 0, "executable descriptor inventory has no stale entries", staleDescriptors.join(", "));
  assert(staleExemptions.length === 0, "exemption inventory has no stale entries", staleExemptions.join(", "));
  assert(discovered.length >= executableDescriptors.length, "single-source discovery enumerates the JSON CLI surface");
  for (const [fileName, reason] of inventoryExemptions) {
    assert(reason.length >= 40, `${fileName} exemption records a reason`);
  }
  for (const descriptor of executableDescriptors.filter((entry) => entry.delegatedJsonFlag)) {
    const delegatedSource = readFileSync(join(skillDir, descriptor.delegatedJsonFlag), "utf-8");
    assert(delegatedSource.includes("--json"), `${descriptor.fileName} delegated --json parser is inventory-visible`);
  }
}

function assertConformanceRunnerWired() {
  const source = readFileSync(conformanceRunnerPath, "utf-8");
  assert(source.includes('id: "cli-determinism"'), "conformance runner exposes cli-determinism");
  assert(!source.includes('id: "cli-json-emission"'), "old cli-json-emission conformance slot is folded away");
  assert(source.includes("test_cli_determinism.mjs"), "conformance runner points at the determinism suite");
}

function assertUnsafeContractRejected() {
  for (const descriptor of executableDescriptors) {
    const source = readFileSync(join(scriptsDir, descriptor.fileName), "utf-8");
    assert(source.includes("emitJson("), `${descriptor.fileName} uses shared emitJson() helper`);
    assert(!/console\.(log|error)\([^;\n]*JSON\.stringify/s.test(source), `${descriptor.fileName} does not write JSON with console.log/error(JSON.stringify(...))`);
    assert(!/process\.exit\(\s*main\s*\(/.test(source), `${descriptor.fileName} does not force process.exit(main()) after CLI output`);
  }
}

function runDescriptor(descriptor, context, { pty = false, redirect = false } = {}) {
  const args = descriptor.args(context);
  const cwd = typeof descriptor.cwd === "function" ? descriptor.cwd(context) : (descriptor.cwd || context.root);
  if (pty) return runPty(args, { cwd });
  if (!redirect) return runNode(args, { cwd });

  const outputPath = join(context.fixtures.root, `${descriptor.fileName.replace(/[^a-z0-9]+/gi, "_")}.redirect.json`);
  const fd = openSync(outputPath, "w");
  try {
    return spawnSync(NODE, args, {
      cwd,
      env: baseEnv(),
      encoding: "utf-8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", fd, "pipe"],
    });
  } finally {
    closeSync(fd);
  }
}

function assertDescriptorDeterminism(context) {
  for (const descriptor of executableDescriptors) {
    const pipe = parseJsonFromResult(runDescriptor(descriptor, context), descriptor.label, { stream: descriptor.stream || "stdout" });
    assert(pipe.ok, `${descriptor.label}: pipe JSON parses`, pipe.error || "");
    if (!pipe.ok) continue;

    const repeat = parseJsonFromResult(runDescriptor(descriptor, context), `${descriptor.label} repeat`, { stream: descriptor.stream || "stdout" });
    assert(repeat.ok, `${descriptor.label}: repeat JSON parses`, repeat.error || "");
    assert(repeat.ok && canonicalJson(pipe.parsed) === canonicalJson(repeat.parsed), `${descriptor.label}: repeat normalized bytes are identical`);
    assert(pipe.status === repeat.status, `${descriptor.label}: repeat exit code is stable`);

    const pty = parseJsonFromResult(runDescriptor(descriptor, context, { pty: true }), `${descriptor.label} PTY`, { pty: true });
    assert(pty.ok, `${descriptor.label}: PTY JSON parses`, pty.error || "");
    assert(pty.ok && canonicalJson(pipe.parsed) === canonicalJson(pty.parsed), `${descriptor.label}: pipe and PTY normalized bytes are identical`);

    if (descriptor.minBytes) {
      assert(pipe.byteLength > descriptor.minBytes, `${descriptor.label}: payload exceeds ${descriptor.minBytes} bytes`);
    }
  }
}

function assertRedirectParity(context) {
  for (const descriptor of executableDescriptors.filter((item) => item.stream !== "stderr")) {
    const pipe = parseJsonFromResult(runDescriptor(descriptor, context), `${descriptor.label} pipe`);
    const redirected = runDescriptor(descriptor, context, { redirect: true });
    const outputPath = join(context.fixtures.root, `${descriptor.fileName.replace(/[^a-z0-9]+/gi, "_")}.redirect.json`);
    const redirectedText = readFileSync(outputPath, "utf-8");
    let redirectedParsed = null;
    try {
      redirectedParsed = JSON.parse(redirectedText);
    } catch {
      // Assertion below reports the parse failure.
    }
    assert(redirectedParsed !== null, `${descriptor.label}: redirected JSON parses`);
    assert(redirectedParsed !== null && canonicalJson(pipe.parsed) === canonicalJson(redirectedParsed), `${descriptor.label}: pipe and redirected normalized bytes are identical`);
    assert(pipe.status === redirected.status, `${descriptor.label}: redirected exit code matches pipe exit code`);
  }
}

function assertPathWithSpaces(tmp) {
  const copiedRoot = copyMinimalCheckout(tmp);
  const context = {
    root: copiedRoot,
    skillDir: join(copiedRoot, ".agent", "skills", "iterative-planner"),
    fixtures: prepareFixtures(copiedRoot),
  };
  const pathCases = executableDescriptors.filter((descriptor) =>
    ["knowledge_packs.mjs", "check_profile.mjs", "ive_packet_validator.mjs", "reflection_guide.mjs", "validate_reflection.mjs"].includes(descriptor.fileName)
  );
  assert(copiedRoot.includes(" ") && copiedRoot.includes("(") && copiedRoot.includes(")"), "path fixture contains spaces and parentheses");
  for (const descriptor of pathCases) {
    const pipe = parseJsonFromResult(runDescriptor(descriptor, context), `${descriptor.label} spaced path`, { stream: descriptor.stream || "stdout" });
    assert(pipe.ok, `${descriptor.label}: spaced path JSON parses`, pipe.error || "");
    const repeat = parseJsonFromResult(runDescriptor(descriptor, context), `${descriptor.label} spaced path repeat`, { stream: descriptor.stream || "stdout" });
    assert(repeat.ok && canonicalJson(pipe.parsed) === canonicalJson(repeat.parsed), `${descriptor.label}: spaced path repeat normalized bytes are identical`);
  }
}

console.log("\nIVE CLI Determinism Regression\n");

const tmp = mkdtempSync(join(tmpdir(), "ive-cli-determinism-"));
try {
  const context = {
    root: repoRoot,
    skillDir,
    fixtures: prepareFixtures(tmp),
  };
  assertInventoryClosed();
  assertConformanceRunnerWired();
  assertUnsafeContractRejected();
  assertDescriptorDeterminism(context);
  assertRedirectParity(context);
  assertPathWithSpaces(tmp);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
