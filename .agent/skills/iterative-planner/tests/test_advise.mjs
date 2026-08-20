#!/usr/bin/env node
// test_advise.mjs — Focused coverage for the Phase 4 orchestrator advisory surface.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { buildAdvisoryRecommendation } from "../scripts/advise.mjs";
import { deriveTaskFocusContract } from "../scripts/lib/task_focus_contract.mjs";
import { buildGuidancePacket } from "../scripts/lib/guidance_packet.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const scriptDir = resolve(testDir, "..", "scripts");
const adviseCliPath = join(scriptDir, "advise.mjs");
const taskIntakeCliPath = join(scriptDir, "task_intake.mjs");
const bootstrapCliPath = join(scriptDir, "bootstrap.mjs");
const batchCliPath = join(scriptDir, "batch.mjs");
const plannerCliPath = join(scriptDir, "planner.mjs");
const escalationCheckPath = join(scriptDir, "escalation_check.mjs");
const supervisorUnavailableFixturePath = join(testDir, "fixtures", "task_intake", "supervisor_unavailable_pilot_2026-07-14.json");
const orchestratorRulesPath = join(repoRoot, ".agent", "skills", "iterative-planner", "config", "orchestrator_rules.yaml");
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const raw = String(text || "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-advise-${name}-`));
}

function writeFixture(cwd, relativePath, content) {
  const target = join(cwd, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeJsonFixture(cwd, relativePath, value) {
  const target = join(cwd, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2) + "\n");
}

function runGit(cwd, args) {
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function commitAll(cwd, message) {
  runGit(cwd, ["add", "."]);
  runGit(cwd, [
    "-c", "user.email=planner@example.test",
    "-c", "user.name=Planner Test",
    "commit", "-m", message,
  ]);
}

function buildVersionDoc({
  orchestrator = "advisory",
  invocationModes = ["manual_cli", "post_commit_hook"],
  agentBEnabled = true,
  agentCEnabled = true,
  flavor = "full",
} = {}) {
  return {
    planner: "v7",
    flavor,
    created_at: "2026-04-22T00:00:00Z",
    migrated_from: "v6",
    agents_enabled: {
      agent_a: true,
      agent_b: agentBEnabled,
      agent_b_invocation: invocationModes,
      agent_c: agentCEnabled,
      orchestrator,
    },
  };
}

function seedAdviseFixture(cwd) {
  const planId = "plan_2026-04-22_advise_fixture";
  const planDir = join(cwd, "plans", planId);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(cwd, "plans", ".current_plan"), `${planId}\n`);

  const state = createInitialStateJson(planId, "Advise fixture active plan", { projectRoot: cwd });
  state.state = "EXECUTE";
  writeStateJson(planDir, state);

  writeFileSync(join(planDir, "plan.md"), `# Plan v0

## Goal
Advise fixture active plan

## Files To Modify
- .agent/skills/iterative-planner/scripts/planner.mjs
- .agent/skills/iterative-planner/scripts/advise.mjs
- .agent/workflows/advisor.md
`);

  writeJsonFixture(cwd, ".agent/version.json", buildVersionDoc());
  writeFixture(cwd, join(".agent", "skills", "iterative-planner", "config", "orchestrator_rules.yaml"), `${readFileSync(orchestratorRulesPath, "utf-8")}\n`);
  writeJsonFixture(cwd, "reports/user_story_audit/story_registry.json", {
    version: 1,
    updated: "2026-04-22T00:00:00.000Z",
    stories: [
      {
        id: "US-083",
        title: "Orchestrator advisory recommendation surface and canonical decision logging",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/planner.mjs",
          ".agent/skills/iterative-planner/scripts/advise.mjs",
        ],
        test_refs: [
          ".agent/skills/iterative-planner/tests/test_advise.mjs",
        ],
        validation_refs: [
          ".agent/skills/iterative-planner/tests/test_advise.mjs",
        ],
        doc_refs: [
          ".agent/workflows/advisor.md",
          "README.md",
        ],
        merged_from: [],
        conflicts: [],
      },
    ],
  });

  writeJsonFixture(cwd, join("plans", planId, "verification_strategy.yaml"), {
    verification_strategy: {
      version: 1,
      plan_id: planId,
      created_at: "2026-04-22T09:00:00.000Z",
      updated_at: "2026-04-22T09:10:00.000Z",
      repo_system_context: "Advise fixture",
      verification_obligation_synthesis: {
        summary: "Exercise planner advise against an active plan.",
        scope: "Active-plan orchestration surface",
        non_goals: [],
        dependencies: [],
      },
      criteria: [
        {
          id: "CRIT-083",
          criterion: "Planner advise uses the active plan story linkage.",
          story_id: "US-083",
          repo_system_context: "Advise fixture",
          required_proof_type: "proof:integration_smoke",
          implementation: {
            file: ".agent/skills/iterative-planner/scripts/advise.mjs",
            lines: "1-end",
            function: null,
          },
          acceptance: [
            "Advisory output includes US-083 as the active-plan story link.",
          ],
          tests: [
            {
              name: "test_advise_active_plan_story_linkage",
              file: ".agent/skills/iterative-planner/tests/test_advise.mjs",
              type: "integration",
            },
          ],
          concrete_action: {
            type: "command",
            command: "node .agent/skills/iterative-planner/scripts/planner.mjs advise --json",
            procedure: null,
            reviewer_persona: null,
          },
          how_verified: "integration_test",
          pass_means: "US-083 appears in the story context.",
          what_remains_unverified: null,
          persona_audit_required: false,
          persona_audit_result: null,
          waiver: null,
        },
      ],
    },
  });

  return { planId, planDir };
}

function seedIntakeFixture(cwd) {
  writeJsonFixture(cwd, ".agent/version.json", buildVersionDoc());
  writeFixture(cwd, join(".agent", "skills", "iterative-planner", "config", "orchestrator_rules.yaml"), `${readFileSync(orchestratorRulesPath, "utf-8")}\n`);
  writeJsonFixture(cwd, "reports/user_story_audit/story_registry.json", {
    version: 1,
    updated: "2026-04-22T00:00:00.000Z",
    stories: [
      {
        id: "US-083",
        title: "Orchestrator advisory recommendation surface and canonical decision logging",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/planner.mjs",
          ".agent/skills/iterative-planner/scripts/advise.mjs",
        ],
        test_refs: [
          ".agent/skills/iterative-planner/tests/test_advise.mjs",
        ],
        validation_refs: [
          ".agent/skills/iterative-planner/tests/test_advise.mjs",
        ],
        doc_refs: [
          ".agent/workflows/advisor.md",
          "README.md",
        ],
        merged_from: [],
        conflicts: [],
      },
      {
        id: "US-084",
        title: "Orchestrator task intake and advisory batch front doors",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/planner.mjs",
          ".agent/skills/iterative-planner/scripts/task_intake.mjs",
          ".agent/skills/iterative-planner/scripts/batch.mjs",
        ],
        test_refs: [
          ".agent/skills/iterative-planner/tests/test_advise.mjs",
        ],
        validation_refs: [
          ".agent/skills/iterative-planner/tests/test_advise.mjs",
        ],
        doc_refs: [
          "README.md",
          ".agent/skills/iterative-planner/SKILL.md",
        ],
        merged_from: [],
        conflicts: [],
      },
    ],
  });
}

function seedRulesOnlyFixture(cwd) {
  writeFixture(cwd, join(".agent", "skills", "iterative-planner", "config", "orchestrator_rules.yaml"), `${readFileSync(orchestratorRulesPath, "utf-8")}\n`);
}

function scenarioBuildRecommendationHonorsUpstreamWorkflow() {
  const recommendation = buildAdvisoryRecommendation({
    cwd: repoRoot,
    goalText: "This scary refactor wording should not override upstream routing",
    preflight: {
      active_plan: { present: false },
      flow: { mode: "lightweight", confidence: "high" },
      workflow: {
        recommended: "/safe-change",
      },
      recovery: {
        mode: "start_lightweight",
        command: "Use normal plan spine with scaled obligations via /safe-change",
      },
      signals: {
        planning_only_request: false,
      },
      task_profile: {
        id: "integration_backend_orchestration",
      },
      recommended_path: "continue",
      audit_posture: "normal",
    },
    escalation: {
      escalations: [],
      supervisor_verdict: { status: "unavailable", source: "fallback" },
    },
    versionInfo: buildVersionDoc(),
    statusSnapshot: {
      present: false,
      recent_plan_ids: [],
    },
    storyIds: [],
  });

  assert(recommendation.task_intake_compatibility.front_door.mode === "direct_workflow", "advise derives direct_workflow from the upstream preflight contract");
  assert(recommendation.recommended_flow[0]?.workflow === "/safe-change", "advise honors planner_preflight workflow recommendations instead of reclassifying raw goal text");
  assert(recommendation.recommended_flow[0]?.mode === "lightweight", "advise preserves the lightweight upstream flow mode");
  assert(recommendation.matched_rule_ids?.includes("agent_a_direct_workflow"), "advise reports the direct-workflow rule id for the matched primary composition rule");
  assert(!recommendation.matched_rule_ids?.includes("agent_c_post_retro_review"), "advise does not match retro follow-up rules when upstream workflow is not /retro");
  assert(recommendation.supervisor_verdict?.status === "unavailable", "advise carries supervisor verdict metadata additively without changing the valid flow");
}

function scenarioRecoverPoisonRuleWinsFirstMatch() {
  const recommendation = buildAdvisoryRecommendation({
    cwd: repoRoot,
    goalText: "Continue safely after poison recovery",
    preflight: {
      active_plan: { present: false },
      flow: { mode: "full", confidence: "high" },
      workflow: {
        recommended: "/safe-change-power",
      },
      recovery: {
        mode: "recover_poison_execute",
        command: "node .agent/skills/iterative-planner/scripts/planner.mjs recover-poison",
      },
      signals: {
        planning_only_request: false,
      },
      task_profile: {
        id: "integration_backend_orchestration",
      },
      recommended_path: "recover",
      audit_posture: "adversarial",
    },
    escalation: { escalations: [] },
    versionInfo: buildVersionDoc(),
    statusSnapshot: {
      present: false,
      recent_plan_ids: [],
    },
    storyIds: [],
  });

  assert(recommendation.recommended_flow[0]?.workflow === "recover-poison", "advise lets the poison-recovery rule win before other primary routing rules");
  assert(recommendation.matched_rule_ids?.[0] === "agent_a_recover_poison", "advise reports the poison-recovery rule as the first matched primary rule");
}

function scenarioStructuredRulesChainStoryVerificationAndAudits() {
  const recommendation = buildAdvisoryRecommendation({
    cwd: repoRoot,
    goalText: "Continue the active orchestrator slice",
    preflight: {
      active_plan: { present: true },
      flow: { mode: "full", confidence: "high" },
      workflow: {
        recommended: "continue-active-plan",
      },
      recovery: {
        mode: "continue_active_plan",
        command: "node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect",
      },
      signals: {
        planning_only_request: false,
      },
      task_profile: {
        id: "integration_backend_orchestration",
      },
      recommended_path: "targeted_red_team",
      audit_posture: "adversarial",
    },
    escalation: {
      escalations: [
        {
          workflow: "/regression-audit",
          severity: "REQUIRED",
          reason: "Regression audit is stale",
        },
      ],
    },
    versionInfo: buildVersionDoc(),
    statusSnapshot: {
      present: true,
      id: "plan_fixture",
      phase: "EXECUTE",
      source: "thread",
      recent_plan_ids: [],
    },
    storyIds: ["US-083"],
  });

  const workflows = recommendation.recommended_flow.map((step) => step.workflow);
  assert(workflows[0] === "continue-active-plan", "advise continues the active plan when the active-plan primary rule matches");
  assert(workflows.includes("/story-verification"), "advise appends Agent B story verification when story-linked follow-up rules match");
  assert(workflows.includes("/regression-audit"), "advise appends required non-advisor audits from the audit follow-up rule");
  assert(recommendation.matched_rule_ids?.includes("agent_a_continue_active_plan"), "advise reports the active-plan primary rule id");
  assert(recommendation.matched_rule_ids?.includes("agent_b_story_verification"), "advise reports the story-verification follow-up rule id");
  assert(recommendation.matched_rule_ids?.includes("required_non_advisor_audits"), "advise reports the audit follow-up rule id");
}

function scenarioRetroRuleMatchesOnlyWhenWorkflowRetro() {
  const recommendation = buildAdvisoryRecommendation({
    cwd: repoRoot,
    goalText: "Run the retro follow-up",
    preflight: {
      active_plan: { present: false },
      flow: { mode: "full", confidence: "high" },
      workflow: {
        recommended: "/retro",
      },
      recovery: {
        mode: "start_full",
        command: "/retro",
      },
      signals: {
        planning_only_request: false,
      },
      task_profile: {
        id: "integration_backend_orchestration",
      },
      recommended_path: "continue",
      audit_posture: "normal",
    },
    escalation: { escalations: [] },
    versionInfo: buildVersionDoc(),
    statusSnapshot: {
      present: false,
      recent_plan_ids: [],
    },
    storyIds: [],
  });

  assert(recommendation.recommended_flow.some((step) => step.workflow === "/knowledge-steward"), "advise appends Agent C only when the upstream workflow is /retro");
  assert(recommendation.matched_rule_ids?.includes("agent_c_post_retro_review"), "advise reports the retro follow-up rule id when it matches");
}

function scenarioRawTextDoesNotBecomeClassifier() {
  const recommendation = buildAdvisoryRecommendation({
    cwd: repoRoot,
    goalText: "retro story verification chaos words should not trigger extra routing",
    preflight: {
      active_plan: { present: false },
      flow: { mode: "lightweight", confidence: "high" },
      workflow: {
        recommended: "/safe-change",
      },
      recovery: {
        mode: "start_lightweight",
        command: "/safe-change",
      },
      signals: {
        planning_only_request: false,
      },
      task_profile: {
        id: "integration_backend_orchestration",
      },
      recommended_path: "continue",
      audit_posture: "normal",
    },
    escalation: { escalations: [] },
    versionInfo: buildVersionDoc({ agentCEnabled: true }),
    statusSnapshot: {
      present: false,
      recent_plan_ids: [],
    },
    storyIds: [],
  });

  assert(recommendation.recommended_flow.length === 1, "advise keeps the flow to the single upstream step when no follow-up rule actually matches");
  assert(!recommendation.matched_rule_ids?.includes("agent_b_story_verification"), "advise does not infer story verification from raw goal text alone");
  assert(!recommendation.matched_rule_ids?.includes("agent_c_post_retro_review"), "advise does not infer retro follow-up from raw goal text alone");
}

function scenarioAdviseCliWritesCanonicalDecisionLog() {
  const tmp = makeTemp("decision-log");
  try {
    const { planId } = seedAdviseFixture(tmp);

    const direct = run([adviseCliPath, "--json"], tmp);
    assert(direct.ok, "advise.mjs --json exits cleanly for an active-plan fixture");
    const directJson = parseJson(direct.stdout);
    assert(!!directJson, "advise.mjs emits valid JSON");
    const payload = directJson?.advisory_recommendation;
    assert(payload?.task_intake_compatibility?.front_door?.mode === "continue_active_plan", "advise derives continue_active_plan from the active-plan preflight output");
    assert(payload?.recommended_flow?.[0]?.workflow === "continue-active-plan", "advise recommends Agent A continue the active plan");
    assert(payload?.recommended_flow?.[1]?.workflow === "/story-verification", "advise chains Agent B when the active plan strategy links a story");
    assert(payload?.story_context?.story_ids?.includes("US-083"), "advise narrows story linkage to the active plan verification strategy");
    assert(payload?.matched_rule_ids?.includes("agent_a_continue_active_plan"), "advise CLI reports the matched active-plan rule id");
    assert(payload?.matched_rule_ids?.includes("agent_b_story_verification"), "advise CLI reports the matched story-verification rule id");
    assert(payload?.rule_contract?.relative_path === ".agent/skills/iterative-planner/config/orchestrator_rules.yaml", "advise CLI reports the canonical rule-contract path");
    assert(payload?.advisory_mode === "advisory", "advise reports advisory mode when version routing enables the orchestrator");
    assert(payload?.decision_log?.wrote === true, "advise reports that it wrote the canonical decision log");

    const logPath = payload?.decision_log?.path || join(tmp, "reports", "orchestrator", "decisions_2026-04-22.yaml");
    assert(existsSync(logPath), "advise writes reports/orchestrator/decisions_<date>.yaml");
    const logJson = parseJson(readFileSync(logPath, "utf-8"));
    const entries = Array.isArray(logJson?.orchestrator_decisions) ? logJson.orchestrator_decisions : [];
    assert(entries.length === 1, "advise appends one decision record on first run");
    assert(entries[0]?.task_description === "Advise fixture active plan", "decision log records the active plan goal");
    assert(entries[0]?.recommended_flow?.[0]?.workflow === "continue-active-plan", "decision log records the recommended flow");
    assert(entries[0]?.matched_rule_ids?.includes("agent_a_continue_active_plan"), "decision log records matched rule ids for auditability");
    assert(entries[0]?.user_action === "pending", "decision log initializes user_action as pending");

    const alias = run([plannerCliPath, "advise", "--json"], tmp);
    assert(alias.ok, "planner.mjs advise --json exits cleanly");
    const aliasJson = parseJson(alias.stdout);
    assert(aliasJson?.advisory_recommendation?.active_plan?.plan_id === planId, "planner.mjs advise preserves the direct script active-plan targeting");
    assert(aliasJson?.advisory_recommendation?.story_context?.story_ids?.includes("US-083"), "planner.mjs advise preserves the direct script story linkage");

    const appendedLog = parseJson(readFileSync(logPath, "utf-8"));
    assert((appendedLog?.orchestrator_decisions || []).length === 2, "advise appends to the canonical decision log instead of overwriting it");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAdviseNoPlanContextSkipsAmbientPlanReuse() {
  const tmp = makeTemp("no-plan-context");
  try {
    seedAdviseFixture(tmp);
    const result = run([adviseCliPath, "--goal", "Refactor planner routing for US-083", "--json", "--no-log", "--no-plan-context"], tmp);
    assert(result.ok, "advise --no-plan-context exits cleanly");
    const parsed = parseJson(result.stdout)?.advisory_recommendation;
    assert(parsed?.active_plan?.present === false, "advise --no-plan-context hides ambient active-plan reuse");
    assert(parsed?.recommended_flow?.[0]?.workflow !== "continue-active-plan", "advise --no-plan-context does not recommend continuing the ambient active plan");
    assert((parsed?.story_context?.story_ids || []).includes("US-083"), "advise --no-plan-context still keeps explicit story ids from the requested goal");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAdviseFallsBackToV6WhenVersionJsonMissing() {
  const tmp = makeTemp("version-missing");
  try {
    seedRulesOnlyFixture(tmp);
    const result = run([adviseCliPath, "--goal", "Fix typo in README link", "--json", "--no-log", "--no-plan-context"], tmp);
    assert(result.ok, "advise exits cleanly when version.json is missing");
    const parsed = parseJson(result.stdout)?.advisory_recommendation;
    assert(parsed?.version_routing?.planner === "v6", "advise falls back to v6 when version.json is missing");
    assert(parsed?.version_routing?.routing_present === false, "advise reports routing_present=false when version.json is missing");
    assert(parsed?.version_routing?.fallback_reason === "missing_version_json", "advise reports the missing-file fallback reason");
    assert(parsed?.advisory_mode === "preview_only", "advise stays preview-only when version.json is missing");
    assert((parsed?.version_routing?.warnings || []).some((warning) => warning.includes("defaulting to v6")), "advise surfaces the missing-file routing warning");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAdviseFallsBackToV6WhenVersionJsonMalformed() {
  const tmp = makeTemp("version-malformed");
  try {
    seedRulesOnlyFixture(tmp);
    writeFixture(tmp, ".agent/version.json", "{ not valid json\n");
    const result = run([adviseCliPath, "--goal", "Fix typo in README link", "--json", "--no-log", "--no-plan-context"], tmp);
    assert(result.ok, "advise exits cleanly when version.json is malformed");
    const parsed = parseJson(result.stdout)?.advisory_recommendation;
    assert(parsed?.version_routing?.planner === "v6", "advise falls back to v6 when version.json is malformed");
    assert(parsed?.version_routing?.routing_present === true, "advise still reports routing_present=true when the malformed file exists");
    assert(parsed?.version_routing?.fallback_reason === "malformed_version_json", "advise reports the malformed-file fallback reason");
    assert((parsed?.reasoning || []).some((line) => line.includes("Version routing warning")), "advise records the routing warning in its reasoning trace");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAdviseExternalFixtureIgnoresCopiedPlannerDrift() {
  const tmp = makeTemp("external-drift");
  try {
    writeJsonFixture(tmp, ".agent/version.json", buildVersionDoc({ orchestrator: "none", flavor: "standard" }));
    writeFixture(tmp, join(".agent", "skills", "iterative-planner", "config", "orchestrator_rules.yaml"), `${readFileSync(orchestratorRulesPath, "utf-8")}\n`);
    writeJsonFixture(tmp, ".agent/skills/iterative-planner/config/.project_registry.json", {
      source_project_path: repoRoot,
      projects: [],
      last_scan: null,
      scan_roots: [],
    });
    writeFixture(tmp, ".agent/skills/iterative-planner/scripts/lib/project_lifecycle.mjs", "export const copiedPlanner = 1;\n");
    writeFixture(tmp, ".agent/skills/iterative-planner/config/.checklist_integrity", "baseline\n");
    writeFixture(tmp, "plans/knowledge/index.md", "# Knowledge\n");
    writeFixture(tmp, "plans/knowledge/mistakes.md", "# Mistakes\n");
    writeFixture(tmp, "plans/knowledge/patterns.md", "# Patterns\n");
    writeFixture(tmp, "plans/knowledge/gotchas.md", "# Gotchas\n");
    writeJsonFixture(tmp, "plans/knowledge/retros/retro_ledger.json", { version: 1, retros: [] });
    writeFixture(tmp, "src/summary.mjs", "export function summarizeIssues() { return ''; }\n");
    writeFixture(tmp, "test/summary.test.mjs", "import '../src/summary.mjs';\n");
    writeJsonFixture(tmp, "reports/user_story_audit/story_registry.json", {
      version: 1,
      stories: [
        {
          id: "US-001",
          title: "Limit issues per priority in generated summaries",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/summary.mjs"],
          test_refs: ["test/summary.test.mjs"],
        },
      ],
    });

    runGit(tmp, ["init"]);
    commitAll(tmp, "initial fixture");
    writeFixture(tmp, "goal.md", "# Goal\nLimit issues per priority.\n");
    commitAll(tmp, "baseline goal");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf-8" }).trim();
    const now = new Date().toISOString();
    writeJsonFixture(tmp, "plans/audit_log.json", {
      audits: ["red-team", "regression", "retro", "user-story", "advisor"].map((type) => ({
        type,
        timestamp: now,
        commit: head,
      })),
      workflow_events: [],
    });

    writeFixture(tmp, ".agent/skills/iterative-planner/scripts/lib/project_lifecycle.mjs", "export const copiedPlanner = 2;\n");
    writeFixture(tmp, ".agent/skills/iterative-planner/config/.checklist_integrity", "updated\n");
    writeFixture(tmp, "src/summary.mjs", "export function summarizeIssues(issues = []) { return issues.length; }\n");
    writeFixture(tmp, "test/summary.test.mjs", "import { summarizeIssues } from '../src/summary.mjs';\nif (summarizeIssues([]) !== 0) throw new Error('expected zero');\n");

    const result = run([
      plannerCliPath,
      "advise",
      "--goal", "Add limitPerPriority to issue summaries",
      "--json",
      "--no-log",
      "--no-plan-context",
    ], tmp);
    assert(result.ok, "planner advise exits cleanly for an external fixture with copied planner drift");
    const recommendation = parseJson(result.stdout)?.advisory_recommendation;
    assert(recommendation?.task_intake_compatibility?.recommended_workflow === "/safe-change", "advise keeps ordinary external host-code work on /safe-change");
    const workflows = (recommendation?.recommended_flow || []).map((step) => step.workflow);
    assert(!workflows.includes("/steward"), "advise does not route copied planner install drift into /steward for host-code work");
    assert(!workflows.includes("/red-team-audit"), "copied planner install drift does not trigger red-team audit escalation");
    assert(!workflows.includes("/regression-audit"), "copied planner install drift does not trigger regression audit escalation");
    assert(!JSON.stringify(recommendation || {}).includes("Shared/core modules touched: .agent/skills/iterative-planner"), "advisor reasoning excludes copied planner internals from shared-module escalation");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTaskIntakeKeepsExplicitWorkflow() {
  const tmp = makeTemp("task-intake-explicit");
  try {
    const result = run([taskIntakeCliPath, "/retro capture lessons", "--json"], tmp);
    assert(result.ok, "task_intake.mjs exits cleanly for explicit workflows");
    const parsed = parseJson(result.stdout)?.task_intake;
    assert(parsed?.route === "explicit_workflow", "task intake preserves explicit workflow intent");
    assert(parsed?.explicit_workflow === "/retro", "task intake reports the explicit workflow id");
    assert(parsed?.advisory_recommendation === null, "task intake does not escalate explicit workflow requests into advise");
    assert(parsed?.advisory_reminder === null, "explicit workflow task intake emits no guidance reminder");
    const human = run([taskIntakeCliPath, "/retro capture lessons"], tmp);
    assert(human.ok && human.stdout.includes("Workflow: /retro") && human.stdout.includes("Command: /retro"), "human task-intake output renders explicit workflow intent");
    assert(!human.stdout.includes("Guidance available"), "explicit workflow human output remains reminder-free");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTaskIntakeDirectsSimpleWork() {
  const tmp = makeTemp("task-intake-simple");
  try {
    seedIntakeFixture(tmp);
    const result = run([taskIntakeCliPath, "--goal", "Fix typo in README link", "--json", "--no-plan-context"], tmp);
    assert(result.ok, "task_intake.mjs exits cleanly for simple work");
    const parsed = parseJson(result.stdout)?.task_intake;
    assert(parsed?.route === "direct_agent_a", "task intake routes simple work directly to Agent A");
    assert(parsed?.recommended_action?.workflow === "/safe-change", "task intake keeps the lightweight direct workflow for simple work");
    assert(parsed?.advisory_recommendation === null, "task intake does not invoke advise for simple direct work");
    assert(parsed?.advisory_reminder === null, "direct task intake emits no guidance reminder");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTaskIntakeEscalatesNonTrivialWork() {
  const tmp = makeTemp("task-intake-advisor");
  try {
    seedIntakeFixture(tmp);
    const result = run([taskIntakeCliPath, "--goal", "Refactor planner routing across scripts for US-083", "--json", "--no-plan-context"], tmp);
    assert(result.ok, "task_intake.mjs exits cleanly for non-trivial work");
    const parsed = parseJson(result.stdout)?.task_intake;
    assert(parsed?.route === "advisor_recommended", "task intake escalates non-trivial work into advise");
    assert(parsed?.advisory_recommendation?.recommended_flow?.[0]?.workflow === "/safe-change-power", "task intake preserves the orchestrator's Agent A recommendation for non-trivial work");
    assert(parsed?.advisory_recommendation?.recommended_flow?.some((step) => step.workflow === "/story-verification"), "task intake carries through story-verification follow-ups from advise");
    assert(parsed?.decision_log?.wrote === true, "task intake preserves the orchestrator decision log when it escalates into advise");
    assert(parsed?.advisory_reminder?.next_command === parsed?.recommended_action?.command, "advisor-escalated task intake publishes the selected command as NEXT");
    assert(parsed?.advisory_reminder?.why === parsed?.rationale, "advisor-escalated task intake publishes its routing rationale as WHY");
    assert(parsed?.advisory_reminder?.authority?.advisory_only === true && parsed?.advisory_reminder?.authority?.adds_gate_obligation === false, "advisor-escalated reminder declares non-enforcement authority");
    const human = run([taskIntakeCliPath, "--goal", "Refactor planner routing across scripts for US-083", "--no-plan-context", "--no-log"], tmp);
    assert(human.ok && human.stdout.includes("Recommended flow:") && human.stdout.includes("/safe-change-power"), "human task-intake output renders the advisor-recommended flow");
    assert(human.stdout.includes("Guidance available") && human.stdout.includes("NEXT:") && human.stdout.includes("WHY:"), "advisor-escalated human output renders concise NEXT/WHY guidance");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTaskIntakeAsksHumanForCanonicalOperatorDecision() {
  const tmp = makeTemp("task-intake-canonical-ask-human");
  try {
    seedIntakeFixture(tmp);
    const result = run([taskIntakeCliPath, "--goal", "Delete it", "--json", "--no-plan-context"], tmp);
    assert(result.ok, "task_intake.mjs exits cleanly for a canonical ask-user decision");
    const payload = parseJson(result.stdout);
    const decision = payload?.task_intake;
    assert(decision?.route === "ask_human", "canonical triage ask_user becomes the ask_human route");
    assert(decision?.decision_request?.question === "Which exact target should I change?", "ask_human preserves the canonical triage question exactly");
    assert(decision?.decision_request?.options?.length === 2, "canonical ask_human publishes two bounded options");
    assert(decision?.decision_request?.authority?.advisory_cannot_promote_lifecycle === true, "ask_human states the advisory lifecycle authority boundary");
    assert(decision?.recommended_action === null, "ask_human does not fabricate a recommended workflow action");
    assert(payload?.guidance_packet?.route?.workflow === null, "ask_human guidance does not fabricate a workflow");
    assert((payload?.guidance_packet?.gate_contracts || []).length === 0, "ask_human guidance publishes zero lifecycle gates");
    assert(decision?.advisory_reminder === null, "ask_human task intake emits no guidance reminder");
    const human = run([taskIntakeCliPath, "--goal", "Delete it", "--no-plan-context"], tmp);
    assert(human.ok && human.stdout.includes("Question: Which exact target should I change?"), "human task-intake output renders the bounded question");
    assert(human.stdout.includes("1. Name the target") && human.stdout.includes("2. Cancel the request"), "human task-intake output renders both bounded options");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function scenarioDecisionRequestHelperCoversAmbiguityConflictAndRecordedDegradation() {
  let helper = null;
  try {
    helper = await import(join(scriptDir, "lib", "intake_decision_request.mjs"));
  } catch {
    // Failing-first: the helper does not exist until the implementation step.
  }
  assert(typeof helper?.deriveIntakeDecisionRequest === "function", "bounded intake decision helper exists as one pure shared contract");
  if (typeof helper?.deriveIntakeDecisionRequest !== "function") return;

  const lowConfidence = helper.deriveIntakeDecisionRequest({
    goal: "Implement robust routing behavior",
    triage: { recommended_path: "standard_planner", operator_action: "planner" },
    preflight: {
      active_plan: { present: false, used_for_classification: false },
      flow: { mode: "full", confidence: "low", reason: "When task shape is ambiguous, default to the full planner rather than under-classifying risk." },
      workflow: { recommended: "/safe-change" },
    },
  });
  assert(lowConfidence?.reason_code === "low_confidence_ambiguity", "explicit low-confidence ambiguity asks the human instead of guessing");
  assert(lowConfidence?.options?.length === 2, "low-confidence ambiguity has two bounded options");

  const conflict = helper.deriveIntakeDecisionRequest({
    goal: "Improve this",
    triage: { recommended_path: "lightweight", operator_action: "lightweight_plan" },
    preflight: {
      active_plan: { present: false, used_for_classification: false },
      flow: { mode: "full", confidence: "high", reason: "Shared work needs the full planner." },
      workflow: { recommended: "/safe-change-power" },
    },
  });
  assert(conflict?.reason_code === "authoritative_route_conflict", "genuine triage/preflight route-family conflict asks the human");
  assert(conflict?.options?.some((option) => option.id === "use_triage_route") && conflict?.options?.some((option) => option.id === "use_preflight_route"), "route conflict exposes both authoritative candidate routes");

  const equivalent = helper.deriveIntakeDecisionRequest({
    goal: "Implement the bounded change",
    triage: { recommended_path: "standard_planner", operator_action: "planner" },
    preflight: {
      active_plan: { present: false, used_for_classification: false },
      flow: { mode: "full", confidence: "high", reason: "Use the standard full planner." },
      workflow: { recommended: "/safe-change" },
    },
  });
  assert(equivalent === null, "equivalent standard/full planner route families stay green");

  const fixture = JSON.parse(readFileSync(supervisorUnavailableFixturePath, "utf-8"));
  assert(fixture?.provenance?.kind === "real_pilot_episode" && fixture?.provenance?.fabricated === false, "supervisor-unavailable fixture declares real pilot provenance");
  assert(String(fixture?.observed_block || "").includes("Supervisor: unavailable (source=fallback)"), "recorded fixture preserves the observed unavailable verdict block");
  const unavailable = helper.deriveIntakeDecisionRequest({
    goal: fixture.goal,
    triage: fixture.triage,
    preflight: fixture.preflight,
    advisoryRecommendation: fixture.advisory_recommendation,
  });
  assert(unavailable?.reason_code === "supervisor_unavailable_no_flow", "recorded supervisor-unavailable episode with no flow asks the human");

  const validFlowControl = helper.deriveIntakeDecisionRequest({
    goal: fixture.goal,
    triage: fixture.triage,
    preflight: { ...fixture.preflight, workflow: { recommended: "/safe-change" }, flow: { mode: "full", confidence: "high", reason: "A valid deterministic route exists." } },
    advisoryRecommendation: { ...fixture.advisory_recommendation, recommended_flow: [{ workflow: "/safe-change", mode: "full_loop", when: "now" }] },
  });
  assert(validFlowControl === null, "supervisor unavailability stays non-blocking when a valid flow exists");

  const validTriageControl = helper.deriveIntakeDecisionRequest({
    goal: fixture.goal,
    triage: { recommended_path: "standard_planner", operator_action: "planner" },
    preflight: fixture.preflight,
    advisoryRecommendation: fixture.advisory_recommendation,
  });
  assert(validTriageControl === null, "supervisor unavailability stays advisory when canonical triage already supplies a valid route");

  const explicitControl = helper.deriveIntakeDecisionRequest({
    goal: "/safe-change implement it",
    explicitWorkflow: "/safe-change",
    triage: { operator_action: "ask_user", operator_question: "Which target?", recommended_path: "skip_planner" },
  });
  assert(explicitControl === null, "explicit workflow intent bypasses ask_human derivation");

  const activePlanControl = helper.deriveIntakeDecisionRequest({
    goal: "Continue the active plan",
    activePlanContinuation: true,
    preflight: { active_plan: { present: true, used_for_classification: true }, flow: { mode: "full", confidence: "low", reason: "ambiguous" } },
  });
  assert(activePlanControl === null, "active-plan continuation bypasses ask_human derivation");
}

function seedGuidanceFirstProgram(cwd) {
  writeJsonFixture(cwd, "plans/programs/guidance-first/program_packet.json", {
    schema_version: 1,
    program_id: "PGM-GUIDANCE-FIRST",
    id: "PGM-GUIDANCE-FIRST",
    title: "Guidance-First Orchestration",
    status: "design",
    goal: "Give every agent the relevant guidance before work begins.",
    epics: [{ id: "EP-INTAKE", title: "Guidance intake", story_refs: ["US-INTAKE-TBD"], ticket_refs: ["T-INTAKE-120A6B61"] }],
    tickets: [{
      id: "T-INTAKE-120A6B61",
      epic_id: "EP-INTAKE",
      title: "G1: Compose the guidance packet in task_intake output",
      lifecycle: "proposed",
      story_refs: [],
      gap_refs: ["GAP-INTAKE-120A6B61"],
      depends_on: ["T-INTAKE-2707D982"],
      external_prerequisites: [{ program_ref: "PGM-GUIDANCE-PREREQ", ticket_ref: "T-PREREQ", required_lifecycle: "closed" }],
      acceptance_criteria: ["AC-G1"],
      verification_refs: ["VM-G1"],
      problem: "Publish route gate persona ontology knowledge and ticket contracts before the agent acts.",
      child_plan: {
        policy: "required",
        plan_dir: null,
        reason: "The fixture requires a governed implementation child plan.",
      },
    }],
    acceptance_criteria: [{ id: "AC-G1", subject_ref: "T-INTAKE-120A6B61", text: "Full and proportional guidance packet behavior is measured." }],
    verification_matrix: [{ id: "VM-G1", subject_ref: "T-INTAKE-120A6B61", acceptance_criterion_ref: "AC-G1", proof_type: "proof:behavioral_test", command_or_action: "Run test_advise.mjs", pass_means: "Packet contract is present." }],
    dependencies: [{ from: "T-INTAKE-120A6B61", to: "T-INTAKE-2707D982", type: "depends_on" }],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    decisions: [],
  });
  writeJsonFixture(cwd, "plans/programs/guidance-prereq/program_packet.json", {
    version: 1,
    id: "PGM-GUIDANCE-PREREQ",
    title: "Guidance prerequisite",
    status: "deferred",
    goal: "Provide a prerequisite contract.",
    epics: [],
    tickets: [{ id: "T-PREREQ", lifecycle: "deferred" }],
    acceptance_criteria: [],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [],
    decisions: [],
  });
}

function scenarioTaskIntakeComposesFullGuidancePacket() {
  const tmp = makeTemp("task-intake-guidance-full");
  try {
    seedIntakeFixture(tmp);
    seedGuidanceFirstProgram(tmp);
    writeFixture(tmp, "audit.config.json", `${JSON.stringify({ roles: ["core", "quant", "assumptions_challenger", "config_integrity", "traceability", "wiring_auditor"] }, null, 2)}\n`);
    writeFixture(tmp, "plans/knowledge/index.md", "# Knowledge\n- P-001 guidance-first composition\n");
    writeFixture(tmp, "plans/knowledge/mistakes.md", "# Mistakes\n## M-001 Publish contracts before execution\nAgents fail when required artifact shapes arrive after authoring.\n");
    writeFixture(tmp, "plans/knowledge/patterns.md", "# Patterns\n## P-001 Guidance first\nCompose bounded relevant contracts at task intake.\n");
    writeFixture(tmp, "plans/knowledge/gotchas.md", "# Gotchas\n## G-001 Fixture persona suppression\nPlanner-core clamp fixtures keep quant advisory unless a real quant claim is declared.\n");

    const result = run([
      taskIntakeCliPath,
      "--goal", "Implement planner-core L3 clamp fixture guidance for G1 T-INTAKE-120A6B61 in PGM-GUIDANCE-FIRST",
      "--json",
      "--no-plan-context",
    ], tmp);
    assert(result.ok, "task_intake.mjs exits cleanly while composing full guidance");
    const payload = parseJson(result.stdout);
    const packet = payload?.guidance_packet;
    const gates = (packet?.gate_contracts || []).map((entry) => entry.gate);
    assert(JSON.stringify(gates) === JSON.stringify(["explore-to-plan", "plan-to-execute", "execute-to-reflect", "reflect-to-validate", "validate-to-close", "notify-user"]), "full guidance publishes the complete six-gate sequence");
    assert((packet?.gate_contracts || []).every((entry) => entry.check_ids.length > 0 && entry.artifact_expectations.length > 0), "every full-flow gate carries check IDs and artifact expectations");
    assert((packet?.gate_contracts || []).every((entry) => entry.preflight_command === `node .agent/skills/iterative-planner/scripts/transition.mjs ${entry.gate} --dry-run`), "every full-flow gate publishes the authoritative transition dry-run preflight");
    const denialIds = new Set((packet?.measured_denial_preemption || []).map((entry) => entry.id));
    assert(["assumption-ledger-present", "assumption-probes-recorded", "GATE-PLN-002", "GATE-PLN-016", "GATE-PLN-017", "GATE-ETR-004", "GATE-ETR-008", "GATE-REF-003", "GATE-VAL-011"].every((id) => denialIds.has(id)), "packet carries canonical shapes for all nine attempt-6 denial classes");
    assert(packet?.persona_guardrails?.active_packs?.includes("config_integrity") && packet?.persona_guardrails?.suppressed_or_advisory_packs?.some((entry) => entry.pack_id === "quant"), "planner-core fixture packet carries active guardrails and quant suppression context");
    assert(packet?.semantic_substrate_contract?.check_id === "GATE-REF-016" && packet.semantic_substrate_contract.canonical_shape.includes("planner-owned evidence paths"), "packet explains the GATE-REF-016 semantic provenance contract");
    assert(packet?.program_context?.tickets?.[0]?.id === "T-INTAKE-120A6B61" && packet.program_context.tickets[0].acceptance_criteria[0]?.id === "AC-G1", "packet embeds exact matched ticket acceptance context");
    assert(packet?.program_context?.tickets?.[0]?.verification_rows?.[0]?.id === "VM-G1" && packet.program_context.tickets[0].depends_on.includes("T-INTAKE-2707D982"), "packet embeds exact verification and dependency context");
    assert(packet?.program_context?.tickets?.[0]?.prerequisite_blockers?.some((entry) => entry.program_ref === "PGM-GUIDANCE-PREREQ" && entry.ticket_ref === "T-PREREQ"), "task intake exposes unsatisfied cross-Program prerequisites in the selected ticket context");
    assert(packet?.ontology_findings?.warnings?.some((warning) => warning.includes("US-INTAKE-TBD")), "packet preserves the Program story-linkage warning");
    assert(packet?.budgets?.context_entries_used <= packet?.budgets?.context_entry_budget, "guidance packet respects the context entry budget");
    assert(existsSync(join(tmp, "plans", "guidance_packet.json")) && existsSync(join(tmp, "plans", "guidance_packet.md")), "task intake writes carried JSON and Markdown guidance artifacts");
    const rendered = readFileSync(join(tmp, "plans", "guidance_packet.md"), "utf-8");
    assert(rendered.includes("notify-user") && rendered.includes("GATE-REF-016") && rendered.includes("T-INTAKE-120A6B61"), "Markdown mirror renders gate semantic and Program context");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function scenarioTaskIntakeUsesExactActiveProgramContext() {
  const tmp = makeTemp("task-intake-active-program-context");
  try {
    const { planDir } = seedAdviseFixture(tmp);
    const activePacketPath = "plans/programs/active-authority/program_packet.json";
    writeJsonFixture(tmp, activePacketPath, {
      version: 1,
      id: "PGM-ACTIVE-AUTHORITY",
      remote_mode: "local-only",
      title: "Exact active authority",
      status: "executing",
      goal: "Own the exact current plan work.",
      epics: [],
      tickets: [{ id: "T-ACTIVE-001", title: "Exact active ticket", lifecycle: "in_progress", story_refs: ["US-083"] }],
      acceptance_criteria: [], dependencies: [], compatibility_contracts: [], migration_boundaries: [], deletion_move_census: [], verification_matrix: [], decisions: [],
    });
    writeJsonFixture(tmp, "plans/programs/closed-lexical-winner/program_packet.json", {
      version: 1,
      id: "PGM-CLOSED-LEXICAL-WINNER",
      remote_mode: "local-only",
      title: "Advise fixture active plan closed lexical winner archived routing guidance",
      status: "closed",
      goal: "Advise fixture active plan closed lexical winner archived routing guidance.",
      epics: [],
      tickets: [{ id: "T-CLOSED-001", title: "Advise fixture active plan", lifecycle: "closed", story_refs: ["US-083"] }],
      acceptance_criteria: [], dependencies: [], compatibility_contracts: [], migration_boundaries: [], deletion_move_census: [], verification_matrix: [], decisions: [],
    });
    const state = JSON.parse(readFileSync(join(planDir, "state.json"), "utf-8"));
    state.program_context = {
      program_id: "PGM-ACTIVE-AUTHORITY",
      program_packet_path: activePacketPath,
      ticket_id: "T-ACTIVE-001",
    };
    writeStateJson(planDir, state);

    const result = run([taskIntakeCliPath, "--json", "--no-log"], tmp);
    const payload = parseJson(result.stdout);
    assert(result.ok && payload?.task_intake?.route === "continue_active_plan", "task intake recognizes authoritative active-plan continuation");
    assert(payload?.guidance_packet?.program_context?.program?.id === "PGM-ACTIVE-AUTHORITY" && payload?.guidance_packet?.program_context?.tickets?.[0]?.id === "T-ACTIVE-001", "continued-plan guidance uses the exact state.json Program and ticket instead of a lexical winner");
    assert(payload?.guidance_packet?.program_context?.selection_source === "active_plan_program_context", "guidance exposes active-plan Program authority provenance");

    const fuzzy = await buildGuidancePacket({
      cwd: tmp,
      goal: "Review closed lexical winner archived routing guidance",
      decision: { route: "direct_agent_a", recommended_action: { workflow: "/safe-change" } },
      preflight: { flow: { mode: "full" }, workflow: { recommended: "/safe-change" }, active_plan: { used_for_classification: false } },
    });
    assert(fuzzy?.program_context?.program === null, "fuzzy-only new-work guidance excludes a closed Program");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapCarriesMatchingIntakeContextIntoFocusContract() {
  const tmp = makeTemp("bootstrap-intake-focus-handoff");
  const staleTmp = makeTemp("bootstrap-stale-intake-focus");
  try {
    runGit(tmp, ["init"]);
    seedIntakeFixture(tmp);
    seedGuidanceFirstProgram(tmp);
    writeFixture(tmp, "audit.config.json", `${JSON.stringify({ roles: ["core", "assumptions_challenger", "config_integrity", "traceability", "wiring_auditor"] }, null, 2)}\n`);
    commitAll(tmp, "seed guidance handoff fixture");

    const goal = "Implement planner-core L3 clamp fixture guidance for G1 T-INTAKE-120A6B61 in PGM-GUIDANCE-FIRST";
    const intake = run([taskIntakeCliPath, "--goal", goal, "--json", "--no-plan-context"], tmp);
    assert(intake.ok, "real task_intake CLI exits cleanly before bootstrap focus handoff");
    const packet = parseJson(intake.stdout)?.guidance_packet;
    assert(!!packet?.packet_hash, "task_intake publishes a signed guidance packet for focus handoff");

    writeFixture(tmp, "unrelated-post-intake.txt", "host-owned dirtiness created after task intake\n");
    const bootstrap = run([bootstrapCliPath, "new", goal], tmp);
    assert(bootstrap.ok, "real bootstrap CLI creates the matching guidance-backed child plan");
    const planId = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planId);
    const focus = JSON.parse(readFileSync(join(planDir, "focus_contract.json"), "utf-8"));

    assert(JSON.stringify(focus?.intake_context?.persona_guardrails) === JSON.stringify(packet?.persona_guardrails), "focus intake snapshot preserves persona_guardrails verbatim");
    assert(JSON.stringify(focus?.program_context) === JSON.stringify(packet?.program_context), "focus top-level Program context equals the intake packet structurally");
    assert(JSON.stringify(focus?.intake_context?.program_context) === JSON.stringify(packet?.program_context), "focus intake snapshot preserves Program context verbatim");
    assert(focus?.program_context?.program?.id === "PGM-GUIDANCE-FIRST" && focus?.program_context?.tickets?.[0]?.id === "T-INTAKE-120A6B61", "focus carries the exact matched Program and ticket identity");
    assert(focus?.program_context?.tickets?.[0]?.lifecycle === "proposed" && focus?.program_context?.tickets?.[0]?.child_plan?.policy === "required", "focus carries ticket lifecycle and child-plan policy");
    assert(focus?.program_context?.tickets?.[0]?.verification_rows?.[0]?.id === "VM-G1", "focus carries exact intake verification rows");
    assert((focus?.ambient_scope?.dirty_files || []).length === 0 && !focus?.ambient_scope?.dirty_files?.includes("unrelated-post-intake.txt"), "guidance-backed focus excludes post-intake host dirtiness from ambient context");

    const rederived = deriveTaskFocusContract({ cwd: tmp, planDir, goalText: goal });
    assert(JSON.stringify(rederived?.intake_context) === JSON.stringify(focus?.intake_context), "plan-directory re-derivation preserves the immutable intake snapshot");
    assert(JSON.stringify(rederived?.ambient_scope) === JSON.stringify(focus?.ambient_scope), "plan-directory re-derivation preserves guidance-backed ambient scope exactly");

    runGit(staleTmp, ["init"]);
    seedIntakeFixture(staleTmp);
    writeJsonFixture(staleTmp, "plans/guidance_packet.json", packet);
    commitAll(staleTmp, "seed stale guidance fixture");
    const differentGoal = "Refactor shared planner routing across bootstrap and preflight modules to repair focus derivation";
    const staleBootstrap = run([bootstrapCliPath, "new", differentGoal], staleTmp);
    assert(staleBootstrap.ok, "real bootstrap CLI creates a plan when a stale packet has a different goal");
    const stalePlanId = readFileSync(join(staleTmp, "plans", ".current_plan"), "utf-8").trim();
    const staleFocus = JSON.parse(readFileSync(join(staleTmp, "plans", stalePlanId, "focus_contract.json"), "utf-8"));
    assert(staleFocus?.intake_context === undefined && staleFocus?.program_context === null, "mismatched-goal guidance packet is ignored instead of importing stale context");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(staleTmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTaskIntakeKeepsSkipGuidanceProportional() {
  const tmp = makeTemp("task-intake-guidance-skip");
  try {
    seedIntakeFixture(tmp);
    const result = run([taskIntakeCliPath, "/ignore-planner inspect one README heading", "--json", "--no-plan-context"], tmp);
    assert(result.ok, "task_intake.mjs exits cleanly for proportional skip guidance");
    const payload = parseJson(result.stdout);
    const packet = payload?.guidance_packet;
    assert(packet?.proportionality?.level === "skip" && packet?.gate_contracts?.length === 0, "skip-route packet declares no lifecycle gate obligations");
    assert(packet?.persona_guardrails?.expectations?.length === 0 && packet?.program_context?.tickets?.length === 0, "skip-route packet omits heavyweight persona and Program obligations");
    assert(payload?.task_intake?.advisory_reminder === null, "skip-route task intake emits no guidance reminder");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTaskIntakeHonorsCanonicalQuestionSkipRoute() {
  const tmp = makeTemp("task-intake-guidance-question-skip");
  try {
    seedIntakeFixture(tmp);
    const goal = "what does the scoreboard quality score mean?";
    const triageResult = run([bootstrapCliPath, "triage", goal, "--json"], tmp);
    assert(triageResult.ok, "bootstrap triage exits cleanly for the acceptance question");
    const canonicalRoute = parseJson(triageResult.stdout)?.recommended_path;
    assert(canonicalRoute === "skip_planner_question", "bootstrap triage classifies the acceptance question as skip_planner_question");

    const result = run([taskIntakeCliPath, "--goal", goal, "--json", "--no-plan-context"], tmp);
    assert(result.ok, "task_intake.mjs exits cleanly for a natural-language question");
    const payload = parseJson(result.stdout);
    const decision = payload?.task_intake;
    const packet = payload?.guidance_packet;
    assert(decision?.route === canonicalRoute, "task intake preserves the canonical question skip route");
    assert(decision?.recommended_action?.workflow === "/ignore-planner", "question skip route points to the explicit bypass workflow");
    assert(decision?.advisory_recommendation === null, "question skip route does not invoke advisor orchestration");
    assert(packet?.proportionality?.level === "skip" && packet?.gate_contracts?.length === 0, "question skip packet declares zero lifecycle gates");
    assert(packet?.persona_guardrails?.expectations?.length === 0 && packet?.program_context?.tickets?.length === 0, "question skip packet omits heavyweight persona and Program obligations");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTaskIntakeHandlesImperativeAnalysisAndNegativeScope() {
  const tmp = makeTemp("task-intake-guidance-negative-scope-analysis");
  try {
    seedIntakeFixture(tmp);
    seedGuidanceFirstProgram(tmp);
    const programPath = join(tmp, "plans", "programs", "guidance-first", "program_packet.json");
    const attractiveProgram = JSON.parse(readFileSync(programPath, "utf-8"));
    attractiveProgram.title = "IVE trust metrics and bounded next-move guidance";
    attractiveProgram.goal = "Assess the completed IVE trust run, explain improved metrics after test trimming, and recommend the next bounded move.";
    attractiveProgram.tickets[0].title = "Assess IVE trust metrics and recommend the next bounded move";
    attractiveProgram.tickets[0].problem = "Explain why IVE trust metrics improved despite heavy test trimming.";
    writeFileSync(programPath, `${JSON.stringify(attractiveProgram, null, 2)}\n`);

    const exactGoal = "Assess what should come next after the completed four-item IVE trust run, explain why the metrics improved despite heavy test trimming, and recommend one bounded next move without implementing it";
    const analysisGoals = [
      exactGoal,
      "Assess the completed IVE trust run and recommend one bounded next step",
      "Review the completed IVE trust run without changing or implementing anything",
      "Review the fix Codex made",
      "Review our latest patch before recommending next steps",
      "Assess the parser fix and report the risks",
      "Explain Codex's parser fix without changing anything",
    ];

    for (const [index, goal] of analysisGoals.entries()) {
      const triageResult = run([bootstrapCliPath, "triage", goal, "--json"], tmp);
      assert(triageResult.ok, `bootstrap triage exits cleanly for analysis fixture ${index + 1}`);
      const triage = parseJson(triageResult.stdout);
      assert(triage?.recommended_path === "skip_planner", `analysis fixture ${index + 1} uses the canonical skip route`);
      assert(triage?.shape?.primary === "analysis", `analysis fixture ${index + 1} has analysis shape`);
      assert(triage?.focus_contract?.work_intent === "analysis_only", `analysis fixture ${index + 1} has analysis-only task focus`);

      const intakeResult = run([taskIntakeCliPath, "--goal", goal, "--json", "--no-plan-context"], tmp);
      assert(intakeResult.ok, `task_intake.mjs exits cleanly for analysis fixture ${index + 1}`);
      const payload = parseJson(intakeResult.stdout);
      const decision = payload?.task_intake;
      const packet = payload?.guidance_packet;
      assert(decision?.route === triage?.recommended_path, `task intake preserves canonical classification for analysis fixture ${index + 1}`);
      assert(decision?.recommended_action?.workflow === "/ignore-planner", `analysis fixture ${index + 1} points to the explicit bypass workflow`);
      assert(decision?.advisory_recommendation === null, `analysis fixture ${index + 1} does not invoke advisor orchestration`);
      assert(packet?.proportionality?.level === "skip" && packet?.gate_contracts?.length === 0, `analysis fixture ${index + 1} publishes zero gate contracts`);
      assert((packet?.persona_guardrails?.expectations || []).length === 0 && (packet?.persona_guardrails?.active_packs || []).length === 0, `analysis fixture ${index + 1} omits heavyweight persona obligations`);
      assert((packet?.program_context?.tickets || []).length === 0, `analysis fixture ${index + 1} omits the attractive unrelated Program match`);
    }

    const positiveWorkGoals = [
      "Review the intake classifier and implement a negation-aware fix",
      "Do not implement the dashboard; instead fix the intake classifier regression",
      "Review the fix, then implement the guard",
      "Fix the parser",
      "Implement the classifier",
      "Change the routing",
      "Build the regression fixture",
    ];
    for (const [index, goal] of positiveWorkGoals.entries()) {
      const triageResult = run([bootstrapCliPath, "triage", goal, "--json"], tmp);
      assert(triageResult.ok, `bootstrap triage exits cleanly for positive-work control ${index + 1}`);
      const triage = parseJson(triageResult.stdout);
      assert(!["skip_planner", "skip_planner_question"].includes(triage?.recommended_path), `positive-work control ${index + 1} does not skip implementation work`);
      assert(triage?.shape?.primary !== "analysis", `positive-work control ${index + 1} is not analysis-shaped`);
      assert(triage?.focus_contract?.work_intent !== "analysis_only", `positive-work control ${index + 1} keeps actionable task focus`);
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBatchLifecycleStaysAdvisoryOnly() {
  const tmp = makeTemp("batch-lifecycle");
  try {
    seedIntakeFixture(tmp);

    const start = run([batchCliPath, "start", "Series of quick fixes", "--json"], tmp);
    assert(start.ok, "batch start exits cleanly");
    const startJson = parseJson(start.stdout)?.batch_session;
    assert(startJson?.status === "OPEN", "batch start opens an advisory batch session");

    const addSimple = run([batchCliPath, "add", "Fix typo in README link", "--json"], tmp);
    assert(addSimple.ok, "batch add exits cleanly for a simple item");
    const addSimpleJson = parseJson(addSimple.stdout)?.batch_session;
    assert(addSimpleJson?.summary?.direct_agent_a === 1, "batch add counts direct lightweight items");

    const addComplex = run([batchCliPath, "add", "Refactor planner routing across scripts for US-083", "--json"], tmp);
    assert(addComplex.ok, "batch add exits cleanly for a non-trivial item");
    const addComplexJson = parseJson(addComplex.stdout)?.batch_session;
    assert(addComplexJson?.summary?.advisor_recommended === 1, "batch add counts orchestrator-escalated items");

    const addHuman = run([batchCliPath, "add", "Delete it", "--json"], tmp);
    assert(addHuman.ok, "batch add exits cleanly for a human-decision item");
    const addHumanJson = parseJson(addHuman.stdout)?.batch_session;
    assert(addHumanJson?.summary?.ask_human === 1, "batch add counts ask_human items additively");

    const status = run([plannerCliPath, "batch", "status", "--json"], tmp);
    assert(status.ok, "planner batch status alias exits cleanly");
    const statusJson = parseJson(status.stdout)?.batch_session;
    assert(statusJson?.summary?.total_items === 3, "planner batch status reports all queued items including ask_human");

    const close = run([plannerCliPath, "batch", "close", "--json"], tmp);
    assert(close.ok, "planner batch close alias exits cleanly");
    const closeJson = parseJson(close.stdout)?.batch_session;
    assert(closeJson?.status === "CLOSED", "planner batch close seals the session");
    assert(closeJson?.close_summary?.advisory_only === true, "batch close keeps the mode explicitly advisory-only");
    assert((closeJson?.close_summary?.primary_execution_order || []).length === 3, "batch close reports the per-item primary execution order");
    const humanPrimary = closeJson?.close_summary?.primary_execution_order?.find((entry) => entry.route === "ask_human");
    assert(humanPrimary?.workflow === null && humanPrimary?.mode === "human_decision", "batch close retains ask_human without fabricating a workflow");
    assert(closeJson?.close_summary?.batched_followups?.some((step) => step.workflow === "/story-verification"), "batch close aggregates story-verification follow-ups");
    assert(closeJson?.close_summary?.batched_followups?.some((step) => String(step.command || "").includes("verify-stories --since")), "batch close rewrites story verification into a batched manual command");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAdvisorSignificantChangeDoesNotAutorunForActiveCloseoutPlan() {
  const tmp = makeTemp("advisor-no-autorun-active-closeout");
  try {
    runGit(tmp, ["init"]);
    mkdirSync(join(tmp, "plans", "plan_active"), { recursive: true });
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), "plan_active\n");
    const state = createInitialStateJson("plan_active", "Active validate plan", { projectRoot: tmp });
    state.state = "VALIDATE";
    writeStateJson(join(tmp, "plans", "plan_active"), state);
    writeFileSync(join(tmp, "lib", "core.js"), "export const value = 1;\n");
    commitAll(tmp, "initial fixture");
    const firstCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf-8" }).trim();

    writeJsonFixture(tmp, "plans/audit_log.json", {
      audits: [
        { type: "advisor", timestamp: new Date().toISOString(), commit: firstCommit },
      ],
    });
    writeFileSync(join(tmp, "lib", "core.js"), "export const value = 2;\n");
    commitAll(tmp, "touch shared module");

    const result = run([escalationCheckPath, "--json"], tmp);
    assert(result.ok, "escalation_check exits cleanly for active closeout advisor fixture");
    const advisor = (parseJson(result.stdout)?.escalations || []).find((entry) => entry.type === "advisor-review");
    assert(!!advisor, "significant shared-module change still recommends advisor review");
    assert(advisor.trigger === "significant-change", "advisor recommendation is classified as significant-change only");
    assert(advisor.auto_launch === false, "active VALIDATE plan suppresses advisor autorun for significant-change-only recommendation");
    assert(!advisor.auto_launch_marker, "active VALIDATE plan omits the advisor autorun marker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAdvisorStaleReviewAutorunsWhenNoActivePlan() {
  const tmp = makeTemp("advisor-autorun-no-active-plan");
  try {
    runGit(tmp, ["init"]);
    writeFileSync(join(tmp, "README.md"), "fixture\n");
    commitAll(tmp, "initial fixture");

    const result = run([escalationCheckPath, "--json"], tmp);
    assert(result.ok, "escalation_check exits cleanly for no-active-plan advisor fixture");
    const advisor = (parseJson(result.stdout)?.escalations || []).find((entry) => entry.type === "advisor-review");
    assert(!!advisor, "missing advisor history recommends advisor review");
    assert(advisor.auto_launch === true, "no active plan plus stale advisor review keeps autorun enabled");
    assert(advisor.auto_launch_marker === "[WORKFLOW_AUTORUN:/advisor]", "hard stale/no-active-plan path includes the advisor autorun marker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nAdvise Tests\n");

scenarioBuildRecommendationHonorsUpstreamWorkflow();
scenarioRecoverPoisonRuleWinsFirstMatch();
scenarioStructuredRulesChainStoryVerificationAndAudits();
scenarioRetroRuleMatchesOnlyWhenWorkflowRetro();
scenarioRawTextDoesNotBecomeClassifier();
scenarioAdviseCliWritesCanonicalDecisionLog();
scenarioAdviseNoPlanContextSkipsAmbientPlanReuse();
scenarioAdviseFallsBackToV6WhenVersionJsonMissing();
scenarioAdviseFallsBackToV6WhenVersionJsonMalformed();
scenarioAdviseExternalFixtureIgnoresCopiedPlannerDrift();
scenarioTaskIntakeKeepsExplicitWorkflow();
scenarioTaskIntakeDirectsSimpleWork();
scenarioTaskIntakeEscalatesNonTrivialWork();
scenarioTaskIntakeAsksHumanForCanonicalOperatorDecision();
await scenarioDecisionRequestHelperCoversAmbiguityConflictAndRecordedDegradation();
scenarioTaskIntakeComposesFullGuidancePacket();
await scenarioTaskIntakeUsesExactActiveProgramContext();
scenarioBootstrapCarriesMatchingIntakeContextIntoFocusContract();
scenarioTaskIntakeKeepsSkipGuidanceProportional();
scenarioTaskIntakeHonorsCanonicalQuestionSkipRoute();
scenarioTaskIntakeHandlesImperativeAnalysisAndNegativeScope();
scenarioBatchLifecycleStaysAdvisoryOnly();
scenarioAdvisorSignificantChangeDoesNotAutorunForActiveCloseoutPlan();
scenarioAdvisorStaleReviewAutorunsWhenNoActivePlan();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
