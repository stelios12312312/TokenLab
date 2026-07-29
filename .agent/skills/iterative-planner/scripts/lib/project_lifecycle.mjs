import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { initializeBootstrapRegistry, REGISTRY_RELATIVE_PATH } from "../bootstrap_registry.mjs";
import { buildDefaultVersionRouting, readVersionRouting, VERSION_ROUTING_RELATIVE_PATH } from "./version_routing.mjs";
import { detectWorkflowCustomizations } from "./workflow_customization.mjs";

const __filename = fileURLToPath(import.meta.url);
const libDir = dirname(__filename);
const scriptsDir = dirname(libDir);
const migrateScriptPath = join(scriptsDir, "migrate.mjs");

const CLAUDE_TEMPLATE_RELATIVE_PATH = join(".agent", "skills", "iterative-planner", "references", "CLAUDE.template.md");
const FORBIDDEN_PATHS_RELATIVE_PATH = join(".agent", "forbidden_paths.yaml");
const INITIAL_DECISION_RELATIVE_PATH = join(".agent", "decisions", "0001-initial-v7-adoption.md");
const VALID_INIT_ORCHESTRATORS = new Set(["none", "advisory"]);

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeTextFile(path, content) {
  ensureDir(dirname(path));
  writeFileSync(path, String(content));
}

function writeJsonFile(path, value) {
  writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function git(args, projectRoot) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
  return {
    ok: result.status === 0,
    status: typeof result.status === "number" ? result.status : 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function isGitRepo(projectRoot) {
  return git(["rev-parse", "--show-toplevel"], projectRoot).ok;
}

function isGitClean(projectRoot) {
  const result = git(["status", "--porcelain"], projectRoot);
  if (!result.ok) return false;
  return result.stdout.trim().length === 0;
}

function hasPlannerInstall(projectRoot) {
  return existsSync(join(projectRoot, ".agent", "skills", "iterative-planner", "SKILL.md"));
}

function hasRootVersionDocument(projectRoot) {
  return existsSync(join(projectRoot, VERSION_ROUTING_RELATIVE_PATH));
}

function buildAgentSelection(spec, defaults) {
  if (!spec) return { ...defaults };
  const selected = new Set(
    String(spec)
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .map((entry) => {
        if (entry === "a" || entry === "agent_a" || entry === "agent-a") return "agent_a";
        if (entry === "b" || entry === "agent_b" || entry === "agent-b") return "agent_b";
        if (entry === "c" || entry === "agent_c" || entry === "agent-c") return "agent_c";
        return entry;
      })
  );

  const agentBEnabled = selected.has("agent_b");
  return {
    agent_a: selected.has("agent_a"),
    agent_b: agentBEnabled,
    agent_b_invocation: agentBEnabled
      ? (defaults.agent_b_invocation.length > 0 ? [...defaults.agent_b_invocation] : ["manual_cli"])
      : [],
    agent_c: selected.has("agent_c"),
    orchestrator: defaults.orchestrator,
  };
}

function resolveInitOrchestrator(orchestrator, fallback) {
  if (typeof orchestrator !== "string" || !orchestrator.trim()) return fallback;
  const requested = orchestrator.trim().toLowerCase();
  return VALID_INIT_ORCHESTRATORS.has(requested) ? requested : fallback;
}

function buildRootVersionDocument({ flavor = "standard", agentsEnabled = null, orchestrator = null } = {}) {
  const defaults = buildDefaultVersionRouting({ planner: "v7", flavor });
  const selectedAgents = buildAgentSelection(agentsEnabled, defaults.agents_enabled);
  const resolvedOrchestrator = resolveInitOrchestrator(orchestrator, selectedAgents.orchestrator);
  return {
    planner: "v7",
    flavor: defaults.flavor,
    created_at: new Date().toISOString(),
    migrated_from: null,
    agents_enabled: {
      ...selectedAgents,
      orchestrator: resolvedOrchestrator,
    },
  };
}

function writeForbiddenPaths(projectRoot) {
  const path = join(projectRoot, FORBIDDEN_PATHS_RELATIVE_PATH);
  if (existsSync(path)) return path;
  writeTextFile(path, `${JSON.stringify({
    version: 1,
    blocked_paths: [
      ".env",
      ".env.*",
      "secrets/",
      "credentials/",
      "*.pem",
    ],
    notes: [
      "Add project-specific secret, credential, and generated-artifact paths before broader tool rollout.",
    ],
  }, null, 2)}\n`);
  return path;
}

function writeInitialDecisionRecord(projectRoot, initVersionDoc) {
  const path = join(projectRoot, INITIAL_DECISION_RELATIVE_PATH);
  if (existsSync(path)) return path;
  writeTextFile(path, [
    "# 0001: Initial v7 adoption",
    "",
    "## Context",
    "This project was initialized with the v7 planner lifecycle scaffold.",
    "",
    "## Decision",
    `Adopt planner=${initVersionDoc.planner}, flavor=${initVersionDoc.flavor}, orchestrator=${initVersionDoc.agents_enabled.orchestrator}.`,
    "",
    "## Consequences",
    "- Project lifecycle and migration readiness should flow through planner front doors.",
    "- Add the first story before the first /safe-change or equivalent implementation workflow.",
    "",
  ].join("\n"));
  return path;
}

function ensureStarterReports(projectRoot) {
  const created = [];
  for (const relativePath of [
    join("reports", "errors"),
    join("reports", "metrics"),
  ]) {
    const absolutePath = join(projectRoot, relativePath);
    ensureDir(absolutePath);
    const gitkeepPath = join(absolutePath, ".gitkeep");
    if (!existsSync(gitkeepPath)) writeTextFile(gitkeepPath, "");
    created.push(relativePath);
  }
  return created;
}

function runUpgrade(projectRoot) {
  const result = spawnSync(process.execPath, [migrateScriptPath, "upgrade", projectRoot], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
  return {
    ok: result.status === 0,
    status: typeof result.status === "number" ? result.status : 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function readRegistry(projectRoot) {
  const registry = safeReadJson(join(projectRoot, REGISTRY_RELATIVE_PATH));
  const stories = Array.isArray(registry?.stories) ? registry.stories : [];
  return {
    present: !!registry,
    story_count: stories.length,
    registry,
  };
}

function listOpenPlans(projectRoot) {
  const plansDir = join(projectRoot, "plans");
  if (!existsSync(plansDir)) return [];
  return readdirSync(plansDir)
    .filter((entry) => entry.startsWith("plan_"))
    .map((entry) => {
      const planDir = join(plansDir, entry);
      const state = safeReadJson(join(planDir, "state.json"));
      if (!state || typeof state !== "object") return null;
      const normalizedState = String(state.state || "").toUpperCase();
      if (!normalizedState || normalizedState === "CLOSE") return null;
      return {
        id: entry,
        state: normalizedState,
        legacy_format: !existsSync(join(planDir, "verification_strategy.yaml")),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function recommendedResolutionForPlan(plan) {
  const state = String(plan?.state || "").toUpperCase();
  if (state === "EXPLORE" || state === "PLAN") return "convert-to-v7";
  if (state === "EXECUTE" || state === "REFLECT" || state === "VALIDATE" || state === "CLOSE") return "complete-on-v6";
  return "review";
}

function buildLifecyclePlanSteps(diagnosis) {
  const scenario = diagnosis?.scenario || "unknown";
  if (scenario === "greenfield_uninitialized") {
    return [
      { phase: "EXPLORE", action: "Run planner init --json in a clean git repo." },
      { phase: "PLAN", action: "Add the first story and project-specific CLAUDE.md context." },
      { phase: "VALIDATE", action: "Run planner project diagnose --json until ready_for_first_task is true." },
    ];
  }
  if (scenario === "migration_incomplete") {
    return [
      { phase: "EXPLORE", action: "List active plans with planner plan resolve --list --json." },
      { phase: "PLAN", action: "Choose complete-on-v6 for late plans or convert-to-v7 for early plans." },
      { phase: "VALIDATE", action: "Rerun planner project diagnose --json after each conversion or completion." },
    ];
  }
  if (scenario === "v6_migration_candidate") {
    return [
      { phase: "EXPLORE", action: "Run planner workflow customize detect --json and review CLAUDE.md state." },
      { phase: "PLAN", action: "Run planner migrate merge-claude-md . --json to record preservation/merge advice." },
      { phase: "EXECUTE", action: "Run migrate upgrade only after active plans and customization review are resolved." },
    ];
  }
  return [
    { phase: "EXPLORE", action: "Review planner project diagnose --json output." },
    { phase: "PLAN", action: "Keep story registry and project-specific instructions current." },
    { phase: "VALIDATE", action: "Run planner health --json and planner verify-stories --all --quiet before rollout." },
  ];
}

export function generateProjectPlan(projectRoot = process.cwd()) {
  const diagnosisResult = diagnoseProject(projectRoot);
  const diagnosis = diagnosisResult.diagnosis;
  return {
    status: "PASS",
    project_root: resolve(projectRoot),
    scenario: diagnosis.scenario,
    readiness: diagnosis.readiness,
    next_actions: diagnosis.next_actions || [],
    plan: {
      mode: diagnosis.scenario?.includes("migration") ? "migration" : "setup",
      steps: buildLifecyclePlanSteps(diagnosis),
    },
  };
}

export function resolvePlanLifecycle(projectRoot = process.cwd(), options = {}) {
  const openPlans = listOpenPlans(resolve(projectRoot));
  const plans = openPlans.map((plan) => ({
    ...plan,
    recommended_option: recommendedResolutionForPlan(plan),
  }));

  if (options.list) {
    return {
      status: "PASS",
      action: "list",
      project_root: resolve(projectRoot),
      open_plan_count: plans.length,
      plans,
    };
  }

  const planId = options.planId || plans[0]?.id || null;
  if (!planId) {
    return {
      status: "PASS",
      action: "none",
      project_root: resolve(projectRoot),
      message: "No in-flight plans found.",
      plans,
    };
  }

  const plan = plans.find((entry) => entry.id === planId);
  if (!plan) {
    return {
      status: "FAIL",
      action: "resolve",
      code: "plan_not_found",
      message: `In-flight plan not found: ${planId}`,
      plans,
    };
  }

  const requested = options.option || plan.recommended_option;
  return {
    status: "PASS",
    action: "resolve",
    project_root: resolve(projectRoot),
    plan,
    selected_option: requested,
    dry_run: true,
    command: requested === "convert-to-v7"
      ? `planner migrate-plan ${plan.id} --dry-run`
      : requested === "complete-on-v6"
        ? `Continue ${plan.id} on v6 until CLOSE, then rerun planner project diagnose --json.`
        : `Review ${plan.id} manually before migration.`,
    note: "planner plan resolve is a deterministic guidance front door; destructive completion or abandon actions require explicit operator workflow.",
  };
}

export function analyzeClaudeMerge(projectRoot = process.cwd()) {
  const resolvedRoot = resolve(projectRoot);
  const claude = detectClaudeState(resolvedRoot);
  const customizationReport = detectWorkflowCustomizations(resolvedRoot);
  const customizationSummary = summarizeCustomizationReview(customizationReport);
  return {
    status: "PASS",
    action: "merge-claude-md",
    project_root: resolvedRoot,
    claude,
    write_status: "unchanged",
    recommendation: claude.state === "customized"
      ? "Preserve project-specific CLAUDE.md content and review workflow customization findings before migration."
      : "CLAUDE.md matches the planner template or is missing; migrate upgrade can refresh managed instructions.",
    customization_review: {
      issue_count: customizationReport.workflow_customizations.issues.length,
      customization_count: customizationReport.workflow_customizations.customization_count,
      summary: customizationSummary,
    },
    note: "This v7.0 command records deterministic merge readiness and preservation guidance. Interactive semantic editing remains operator-reviewed.",
  };
}

function detectClaudeState(projectRoot) {
  const claudePath = join(projectRoot, "CLAUDE.md");
  if (!existsSync(claudePath)) {
    return {
      present: false,
      state: "missing",
    };
  }
  const templatePath = join(projectRoot, CLAUDE_TEMPLATE_RELATIVE_PATH);
  const currentContent = readFileSync(claudePath, "utf-8");
  const templateContent = existsSync(templatePath) ? readFileSync(templatePath, "utf-8") : null;
  return {
    present: true,
    state: templateContent && currentContent === templateContent ? "template_unchanged" : "customized",
  };
}

function summarizeCustomizationReview(customizationReport) {
  const issues = customizationReport?.workflow_customizations?.issues || [];
  const customizations = customizationReport?.workflow_customizations?.customizations || [];
  return [
    ...issues.map((entry) => entry.message),
    ...customizations.map((entry) => {
    if (entry.action === "deprecate_on_migrate") {
      return `${entry.file} differs from canonical and maps to a deprecated workflow path`;
    }
    if (entry.action === "preserve") {
      return `${entry.file} adds a local workflow section that should be preserved`;
    }
    return `${entry.file} differs from the canonical workflow template and needs review`;
    }),
  ];
}

function deriveScenario({ hasAgentDir, versionInfo, hasRootVersion, openPlans }) {
  if (!hasAgentDir) return "greenfield_uninitialized";
  if (versionInfo?.planner === "v7" && versionInfo?.migrated_from === "v6") {
    return openPlans.some((entry) => entry.legacy_format) ? "migration_incomplete" : "v7_migrated";
  }
  if (hasRootVersion && versionInfo?.planner === "v7") return "greenfield_in_progress";
  return "v6_migration_candidate";
}

function summarizeProjectState(projectRoot, customizationReport) {
  const hasAgentDir = existsSync(join(projectRoot, ".agent"));
  const hasPlanner = hasPlannerInstall(projectRoot);
  const hasRootVersion = hasRootVersionDocument(projectRoot);
  const versionInfo = hasAgentDir ? readVersionRouting(projectRoot) : null;
  const registry = hasPlanner ? readRegistry(projectRoot) : { present: false, story_count: 0, registry: null };
  const openPlans = listOpenPlans(projectRoot);
  const claude = detectClaudeState(projectRoot);
  const workflowCustomizations = customizationReport?.workflow_customizations?.customizations || [];

  return {
    has_agent_dir: hasAgentDir,
    has_planner_install: hasPlanner,
    has_root_version_json: hasRootVersion,
    version_info: versionInfo,
    registry,
    open_plans: openPlans,
    claude,
    workflow_customizations: workflowCustomizations,
  };
}

export function initializeProject(projectRoot = process.cwd(), options = {}) {
  const resolvedRoot = resolve(projectRoot);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    return {
      ok: false,
      status: "FAIL",
      code: "missing_directory",
      message: `Target directory does not exist: ${resolvedRoot}`,
    };
  }
  if (!isGitRepo(resolvedRoot)) {
    return {
      ok: false,
      status: "FAIL",
      code: "not_git_repo",
      message: "planner init requires a git repository target.",
    };
  }
  if (!isGitClean(resolvedRoot)) {
    return {
      ok: false,
      status: "FAIL",
      code: "git_dirty",
      message: "planner init requires a clean git worktree.",
    };
  }
  if (existsSync(join(resolvedRoot, ".agent"))) {
    return {
      ok: false,
      status: "FAIL",
      code: "agent_dir_exists",
      message: "planner init refuses repos that already contain .agent/. Use migrate upgrade or repair flows instead.",
    };
  }

  const upgrade = runUpgrade(resolvedRoot);
  if (!upgrade.ok) {
    return {
      ok: false,
      status: "FAIL",
      code: "upgrade_failed",
      message: "planner init could not complete the trusted upgrade/setup substrate.",
      stdout: upgrade.stdout,
      stderr: upgrade.stderr,
    };
  }

  const rootVersionDoc = buildRootVersionDocument(options);
  const versionPath = join(resolvedRoot, VERSION_ROUTING_RELATIVE_PATH);
  writeJsonFile(versionPath, rootVersionDoc);
  const forbiddenPath = writeForbiddenPaths(resolvedRoot);
  const initialDecisionPath = writeInitialDecisionRecord(resolvedRoot, rootVersionDoc);
  const createdReportDirs = ensureStarterReports(resolvedRoot);
  const registryResult = initializeBootstrapRegistry(resolvedRoot);

  return {
    ok: true,
    status: "PASS",
    project_root: resolvedRoot,
    version_path: versionPath,
    forbidden_paths_path: forbiddenPath,
    initial_decision_path: initialDecisionPath,
    registry_path: registryResult.registry_path,
    report_directories: createdReportDirs,
    next_steps: [
      "Run `planner project diagnose --json` to confirm readiness state.",
      "Add the first story to the canonical registry before the first implementation workflow.",
      "Review `CLAUDE.md` and `.agent/forbidden_paths.yaml` for project-specific context.",
    ],
  };
}

export function diagnoseProject(projectRoot = process.cwd()) {
  const resolvedRoot = resolve(projectRoot);
  if (!isGitRepo(resolvedRoot)) {
    return {
      diagnosis: {
        scenario: "unclear_not_git_repo",
        project_state: {
          has_git_repo: false,
        },
        readiness: {
          overall: "UNCLEAR_SCENARIO",
          blockers: [
            "Target is not a git repository, so lifecycle readiness cannot be classified safely.",
          ],
          recommendations: [
            "Initialize git first, then rerun planner project diagnose.",
          ],
        },
        next_actions: [
          "git init",
          "planner project diagnose --json",
        ],
      },
      exit_code: 2,
    };
  }

  const customizationReport = detectWorkflowCustomizations(resolvedRoot);
  const state = summarizeProjectState(resolvedRoot, customizationReport);
  const scenario = deriveScenario({
    hasAgentDir: state.has_agent_dir,
    versionInfo: state.version_info,
    hasRootVersion: state.has_root_version_json,
    openPlans: state.open_plans,
  });

  const blockers = [];
  const manualReviewNeeded = [];
  const recommendations = [];
  const nextActions = [];
  const customizationIssues = customizationReport?.workflow_customizations?.issues || [];
  let overall = "READY_WITH_CAVEATS";
  let readyForFirstTask = false;

  if (scenario === "greenfield_uninitialized") {
    overall = "NOT_INITIALIZED";
    blockers.push("Planner is not installed in this repo yet.");
    recommendations.push("Run planner init in the repo root.");
    nextActions.push("planner init --json");
  } else if (scenario === "greenfield_in_progress") {
    if (state.registry.story_count === 0) {
      blockers.push("Registry is empty. Add at least one story before the first implementation workflow.");
    }
    if (state.claude.state === "template_unchanged") {
      recommendations.push("CLAUDE.md still matches the starter template. Add project-specific context before wider team use.");
    }
    recommendations.push("Review .agent/forbidden_paths.yaml and add repo-specific secret or generated-artifact paths.");
    nextActions.push("planner project diagnose --json");
    if (state.registry.story_count === 0) {
      nextActions.push("Add the first story to reports/user_story_audit/story_registry.json, then run planner bootstrap-registry --validate --json");
    } else {
      nextActions.push("Run planner bootstrap-registry --validate --json after any story registry edits.");
    }
    overall = blockers.length > 0 ? "SETUP_IN_PROGRESS" : "READY_WITH_CAVEATS";
    readyForFirstTask = blockers.length === 0;
  } else if (scenario === "v6_migration_candidate") {
    if (state.open_plans.length > 0) {
      blockers.push(`${state.open_plans.length} active plan(s) are still open. Close, migrate, or explicitly resolve them before migration.`);
    }
    if (customizationIssues.length > 0) {
      blockers.push(...customizationIssues.map((entry) => entry.message));
      nextActions.push("Repair .agent/skills/iterative-planner/config/.project_registry.json source_project_path, then rerun planner workflow customize detect --json");
    }
    manualReviewNeeded.push(...summarizeCustomizationReview(customizationReport));
    recommendations.push("Review workflow customizations before running the migration.");
    nextActions.push("planner workflow customize detect --json");
    nextActions.push("node .agent/skills/iterative-planner/scripts/migrate.mjs doctor . --json");
    overall = blockers.length > 0 ? "READY_WITH_CAVEATS" : "READY_WITH_CAVEATS";
    readyForFirstTask = false;
  } else if (scenario === "migration_incomplete") {
    const legacyPlans = state.open_plans.filter((entry) => entry.legacy_format);
    if (legacyPlans.length > 0) {
      blockers.push(`${legacyPlans.length} legacy-format plan(s) are still in flight and need completion or conversion.`);
      nextActions.push(`node .agent/skills/iterative-planner/scripts/planner.mjs migrate-plan ${legacyPlans[0].id} --dry-run`);
    }
    if (customizationIssues.length > 0) {
      blockers.push(...customizationIssues.map((entry) => entry.message));
      nextActions.push("Repair .agent/skills/iterative-planner/config/.project_registry.json source_project_path, then rerun planner workflow customize detect --json");
    }
    manualReviewNeeded.push(...summarizeCustomizationReview(customizationReport));
    overall = "NEEDS_PLAN_CONVERSION";
    readyForFirstTask = false;
  } else {
    manualReviewNeeded.push(...summarizeCustomizationReview(customizationReport));
    if (state.registry.story_count === 0) {
      recommendations.push("Registry is still empty; add a first story before deeper workflow use.");
    }
    overall = "READY_WITH_CAVEATS";
    readyForFirstTask = state.registry.story_count > 0;
  }

  const diagnosis = {
    diagnosis: {
      scenario,
      project_state: {
        has_git_repo: true,
        git_clean: isGitClean(resolvedRoot),
        has_agent_dir: state.has_agent_dir,
        has_root_version_json: state.has_root_version_json,
        version: state.version_info
          ? {
              planner: state.version_info.planner,
              flavor: state.version_info.flavor,
              migrated_from: state.version_info.migrated_from,
              routing_present: state.version_info.present,
              warnings: state.version_info.warnings,
            }
          : null,
        has_registry: {
          present: state.registry.present,
          story_count: state.registry.story_count,
        },
        has_claude_md: {
          present: state.claude.present,
          state: state.claude.state,
        },
        active_plans: {
          count: state.open_plans.length,
          plans: state.open_plans,
        },
        workflow_customizations: {
          count: state.workflow_customizations.length,
          source_project_path: customizationReport.workflow_customizations.source_project_path,
        },
      },
      readiness: {
        overall,
        ready_for_first_task: readyForFirstTask,
        blockers,
        manual_review_needed: manualReviewNeeded,
        recommendations,
      },
      next_actions: nextActions,
    },
  };

  if (scenario === "unclear_not_git_repo") {
    return { ...diagnosis, exit_code: 2 };
  }
  const exitCode = blockers.length > 0 || scenario === "greenfield_uninitialized" ? 1 : 0;
  return { ...diagnosis, exit_code: exitCode };
}

export function formatProjectLifecycleText(result) {
  if (result.project_root) {
    if (result.action === "merge-claude-md") {
      return [
        "planner migrate merge-claude-md",
        `  Project root: ${result.project_root}`,
        `  CLAUDE.md: ${result.claude.present ? result.claude.state : "missing"}`,
        `  Write status: ${result.write_status}`,
        `  Recommendation: ${result.recommendation}`,
      ].join("\n");
    }
    if (result.plan) {
      return [
        "planner project plan",
        `  Project root: ${result.project_root}`,
        `  Scenario: ${result.scenario}`,
        `  Mode: ${result.plan.mode}`,
        ...result.plan.steps.map((step) => `  ${step.phase}: ${step.action}`),
      ].join("\n");
    }
    if (result.action === "list" || result.action === "resolve" || result.action === "none") {
      const lines = [
        "planner plan resolve",
        `  Project root: ${result.project_root}`,
        `  Action: ${result.action}`,
      ];
      for (const plan of result.plans || (result.plan ? [result.plan] : [])) {
        lines.push(`  Plan: ${plan.id} (${plan.state}) -> ${plan.recommended_option}`);
      }
      if (result.command) lines.push(`  Command: ${result.command}`);
      if (result.message) lines.push(`  Message: ${result.message}`);
      return lines.join("\n");
    }
    return [
      "planner init",
      `  Project root: ${result.project_root}`,
      `  Version doc: ${result.version_path}`,
      `  Registry: ${result.registry_path}`,
      `  Initial ADR: ${result.initial_decision_path}`,
      ...result.next_steps.map((entry) => `  Next: ${entry}`),
    ].join("\n");
  }

  const payload = result.diagnosis;
  const lines = [];
  lines.push("planner project diagnose");
  lines.push(`  Scenario: ${payload.scenario}`);
  lines.push(`  Overall: ${payload.readiness.overall}`);
  lines.push(`  Ready for first task: ${payload.readiness.ready_for_first_task ? "yes" : "no"}`);
  if (payload.readiness.blockers.length > 0) {
    for (const blocker of payload.readiness.blockers) lines.push(`  Blocker: ${blocker}`);
  }
  if ((payload.readiness.manual_review_needed || []).length > 0) {
    for (const item of payload.readiness.manual_review_needed) lines.push(`  Review: ${item}`);
  }
  if ((payload.readiness.recommendations || []).length > 0) {
    for (const item of payload.readiness.recommendations) lines.push(`  Recommend: ${item}`);
  }
  for (const action of payload.next_actions || []) lines.push(`  Next: ${action}`);
  return lines.join("\n");
}

export { parseFlagValue };
