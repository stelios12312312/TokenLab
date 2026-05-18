#!/usr/bin/env node
// test_advise.mjs — Focused coverage for the Phase 4 orchestrator advisory surface.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import { buildAdvisoryRecommendation } from "../scripts/advise.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const repoRoot = resolve(testDir, "..", "..", "..", "..");
const scriptDir = resolve(testDir, "..", "scripts");
const adviseCliPath = join(scriptDir, "advise.mjs");
const taskIntakeCliPath = join(scriptDir, "task_intake.mjs");
const batchCliPath = join(scriptDir, "batch.mjs");
const plannerCliPath = join(scriptDir, "planner.mjs");
const escalationCheckPath = join(scriptDir, "escalation_check.mjs");
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
        command: "Use task.md + implementation_plan.md + walkthrough.md via /safe-change",
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

  assert(recommendation.task_intake_compatibility.front_door.mode === "direct_workflow", "advise derives direct_workflow from the upstream preflight contract");
  assert(recommendation.recommended_flow[0]?.workflow === "/safe-change", "advise honors planner_preflight workflow recommendations instead of reclassifying raw goal text");
  assert(recommendation.recommended_flow[0]?.mode === "lightweight", "advise preserves the lightweight upstream flow mode");
  assert(recommendation.matched_rule_ids?.includes("agent_a_direct_workflow"), "advise reports the direct-workflow rule id for the matched primary composition rule");
  assert(!recommendation.matched_rule_ids?.includes("agent_c_post_retro_review"), "advise does not match retro follow-up rules when upstream workflow is not /retro");
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
    writeFixture(tmp, ".agent/skills/iterative-planner/config/.config_integrity", "baseline\n");
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
    writeFixture(tmp, ".agent/skills/iterative-planner/config/.config_integrity", "updated\n");
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

    const status = run([plannerCliPath, "batch", "status", "--json"], tmp);
    assert(status.ok, "planner batch status alias exits cleanly");
    const statusJson = parseJson(status.stdout)?.batch_session;
    assert(statusJson?.summary?.total_items === 2, "planner batch status reports both queued items");

    const close = run([plannerCliPath, "batch", "close", "--json"], tmp);
    assert(close.ok, "planner batch close alias exits cleanly");
    const closeJson = parseJson(close.stdout)?.batch_session;
    assert(closeJson?.status === "CLOSED", "planner batch close seals the session");
    assert(closeJson?.close_summary?.advisory_only === true, "batch close keeps the mode explicitly advisory-only");
    assert((closeJson?.close_summary?.primary_execution_order || []).length === 2, "batch close reports the per-item primary execution order");
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
scenarioBatchLifecycleStaysAdvisoryOnly();
scenarioAdvisorSignificantChangeDoesNotAutorunForActiveCloseoutPlan();
scenarioAdvisorStaleReviewAutorunsWhenNoActivePlan();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
