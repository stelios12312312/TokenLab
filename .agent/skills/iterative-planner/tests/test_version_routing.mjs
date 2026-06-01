#!/usr/bin/env node
// test_version_routing.mjs — Contract coverage for Phase 6 version routing.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import {
  agentBInvocationModes,
  buildDefaultVersionRouting,
  normalizeVersionRoutingDocument,
  readVersionRouting,
  shouldRunPostCommitStoryVerification,
} from "../scripts/lib/version_routing.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");

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
  return mkdtempSync(join(tmpdir(), `planner-version-routing-${name}-`));
}

function writeJsonFixture(cwd, relativePath, value) {
  const target = join(cwd, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2) + "\n");
}

function scenarioDefaultBuilderRespectsSafetyDefaults() {
  const v6 = buildDefaultVersionRouting();
  assert(v6.planner === "v6", "default version routing assumes v6");
  assert(v6.flavor === "legacy", "default v6 routing uses the legacy flavor marker");
  assert(v6.agents_enabled.agent_b === false, "default v6 routing keeps Agent B disabled");
  assert(v6.agents_enabled.orchestrator === "none", "default v6 routing keeps the orchestrator disabled");

  const v7Full = buildDefaultVersionRouting({ planner: "v7", flavor: "full" });
  assert(v7Full.planner === "v7", "default builder can emit v7 routing");
  assert(v7Full.flavor === "full", "default builder preserves the requested v7 flavor");
  assert(v7Full.agents_enabled.agent_b === true, "v7 full flavor enables Agent B by default");
  assert(v7Full.agents_enabled.orchestrator === "advisory", "v7 full flavor defaults the orchestrator to advisory");
}

function scenarioMissingFileFallsBackToV6() {
  const tmp = makeTemp("missing");
  try {
    const routing = readVersionRouting(tmp);
    assert(routing.planner === "v6", "missing version.json falls back to v6");
    assert(routing.present === false, "missing version.json reports routing_present=false");
    assert(routing.fallback_reason === "missing_version_json", "missing version.json records the fallback reason");
    assert(routing.warnings[0]?.includes("defaulting to v6"), "missing version.json reports a safety warning");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMalformedFileFallsBackToV6() {
  const tmp = makeTemp("malformed");
  try {
    mkdirSync(join(tmp, ".agent"), { recursive: true });
    writeFileSync(join(tmp, ".agent", "version.json"), "{not valid json\n");
    const routing = readVersionRouting(tmp);
    assert(routing.planner === "v6", "malformed version.json falls back to v6");
    assert(routing.present === true, "malformed version.json still reports the file as present");
    assert(routing.malformed === true, "malformed version.json is flagged explicitly");
    assert(routing.fallback_reason === "malformed_version_json", "malformed version.json records the fallback reason");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExplicitV7RoutingNormalizesInvalidFields() {
  const normalized = normalizeVersionRoutingDocument({
    planner: "v7",
    flavor: "full",
    agents_enabled: {
      agent_b: true,
      agent_b_invocation: ["manual_cli", "post_commit_hook", "manual_cli"],
      agent_c: true,
      orchestrator: "surprise",
    },
  }, { present: true, path: join(repoRoot, ".agent", "version.json") });

  assert(normalized.planner === "v7", "explicit v7 routing stays on v7");
  assert(normalized.flavor === "full", "explicit v7 routing preserves the full flavor");
  assert(normalized.agents_enabled.agent_b === true, "explicit v7 routing preserves Agent B enablement");
  assert(normalized.agents_enabled.orchestrator === "advisory", "invalid orchestrator values fall back to the flavor default");
  assert(normalized.warnings.some((warning) => warning.includes("orchestrator")), "invalid orchestrator values emit a warning");
  assert(agentBInvocationModes(normalized).length === 2, "agent B invocation modes are deduplicated");
}

function scenarioPostCommitHookGateUsesSharedRoutingContract() {
  const versionInfo = normalizeVersionRoutingDocument({
    planner: "v7",
    flavor: "full",
    agents_enabled: {
      agent_a: true,
      agent_b: true,
      agent_b_invocation: ["manual_cli", "post_commit_hook"],
      agent_c: true,
      orchestrator: "advisory",
    },
  }, { present: true, path: join(repoRoot, ".agent", "version.json") });

  assert(shouldRunPostCommitStoryVerification(versionInfo) === true, "shared routing helper enables post-commit verification only when the hook mode is declared");

  const noHook = normalizeVersionRoutingDocument({
    planner: "v7",
    flavor: "standard",
    agents_enabled: {
      agent_b: true,
      agent_b_invocation: ["manual_cli"],
      agent_c: false,
      orchestrator: "none",
    },
  }, { present: true, path: join(repoRoot, ".agent", "version.json") });
  assert(shouldRunPostCommitStoryVerification(noHook) === false, "shared routing helper keeps post-commit verification disabled without the hook mode");
}

function scenarioV6IgnoresV7OnlyFields() {
  const normalized = normalizeVersionRoutingDocument({
    planner: "v6",
    flavor: "full",
    agents_enabled: {
      agent_b: true,
      agent_c: true,
      orchestrator: "advisory",
    },
  }, { present: true, path: join(repoRoot, ".agent", "version.json") });

  assert(normalized.planner === "v6", "v6 routing remains v6 even when v7-only fields are present");
  assert(normalized.agents_enabled.agent_b === false, "v6 routing ignores Agent B enablement");
  assert(normalized.agents_enabled.orchestrator === "none", "v6 routing ignores orchestrator settings");
  assert(normalized.warnings.some((warning) => warning.includes("v7-only agent settings")), "v6 routing warns when v7-only settings are ignored");
}

console.log("\nVersion Routing Tests\n");

scenarioDefaultBuilderRespectsSafetyDefaults();
scenarioMissingFileFallsBackToV6();
scenarioMalformedFileFallsBackToV6();
scenarioExplicitV7RoutingNormalizesInvalidFields();
scenarioPostCommitHookGateUsesSharedRoutingContract();
scenarioV6IgnoresV7OnlyFields();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
