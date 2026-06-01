#!/usr/bin/env node
// test_migration_wave_policy.mjs — verify-fleet status classification coverage.

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const agentDir = join(plannerRoot, ".agent");
const currentVersion = JSON.parse(
  readFileSync(join(plannerRoot, ".agent", "skills", "iterative-planner", "config", "version.json"), "utf-8")
).version;
const migrationContent = readFileSync(
  join(plannerRoot, ".agent", "skills", "iterative-planner", "MIGRATION.md"),
  "utf-8"
);
const migrationVersions = [...migrationContent.matchAll(/\|\s*(\d+\.\d+\.\d+)\s*\|/g)]
  .map((match) => match[1])
  .filter(Boolean)
  .sort((a, b) => {
    const [a1, a2, a3] = a.split(".").map(Number);
    const [b1, b2, b3] = b.split(".").map(Number);
    return a1 - b1 || a2 - b2 || a3 - b3;
  });
const previousVersion = migrationVersions[migrationVersions.length - 2] || "0.0.0";
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

function run(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

function removeConflictedCopyArtifacts(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      removeConflictedCopyArtifacts(full);
      continue;
    }
    if (entry.isFile() && /conflicted copy/i.test(entry.name)) {
      rmSync(full, { force: true });
    }
  }
}

function seedProjectRoot(targetPath) {
  cpSync(agentDir, join(targetPath, ".agent"), { recursive: true });
  removeConflictedCopyArtifacts(join(targetPath, ".agent"));
  for (const name of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
    const source = join(plannerRoot, name);
    if (existsSync(source)) {
      cpSync(source, join(targetPath, name));
    }
  }
  writeFileSync(join(targetPath, "audit.config.json"), JSON.stringify({
    version: 1,
    roles: ["traceability"],
    fail_on: ["fail"],
  }, null, 2));
  mkdirSync(join(targetPath, "plans", "knowledge"), { recursive: true });
  writeFileSync(join(targetPath, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(targetPath, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(targetPath, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(targetPath, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
}

function setPlannerVersion(targetPath, version) {
  const skillPath = join(targetPath, ".agent", "skills", "iterative-planner", "SKILL.md");
  const content = readFileSync(skillPath, "utf-8");
  if (content.includes("planner_version:")) {
    writeFileSync(
      skillPath,
      content.replace(/planner_version:\s*["']?\d+\.\d+\.\d+["']?/, `planner_version: "${version}"`)
    );
    return;
  }
  writeFileSync(skillPath, content.replace(/^---\n/, `---\nplanner_version: "${version}"\n`));
}

function seedValidDiscoveryPolicy(targetPath) {
  writeFileSync(join(targetPath, "planner.discovery.json"), JSON.stringify({
    archetype: "workflow_automation",
    enabled_matchers: ["entity_matching"],
    thresholds: { entity_matching: 0.82 },
  }, null, 2));
}

function seedValidRecipeSurface(targetPath) {
  mkdirSync(join(targetPath, "recipes", "daily-sync"), { recursive: true });
  writeFileSync(join(targetPath, "recipes", "entity_registry.json"), JSON.stringify({
    entities: [{ id: "daily_sync", title: "Daily Sync", aliases: ["daily sync"] }],
  }, null, 2));
  writeFileSync(join(targetPath, "recipes", "capability_registry.json"), JSON.stringify({
    capabilities: [{ id: "run_daily_sync", title: "Run Daily Sync", recipe_ids: ["daily-sync"] }],
  }, null, 2));
  writeFileSync(join(targetPath, "recipes", "daily-sync", "recipe.json"), JSON.stringify({
    id: "daily-sync",
    title: "Daily Sync",
    capability_id: "run_daily_sync",
    entity_ids: ["daily_sync"],
    required_params: ["entity_id"],
  }, null, 2));
}

function seedValidStoryRegistry(targetPath) {
  mkdirSync(join(targetPath, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(targetPath, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    stories: [
      {
        id: "STORY-001",
        title: "Daily sync remains traceable",
        code_refs: ["recipes/daily-sync/recipe.json"],
        test_refs: ["tests/daily-sync.test.mjs"],
        validation_refs: ["reports/daily-sync-validation.md"],
      },
    ],
  }, null, 2));
}

function seedLiveAnnotationSurface(targetPath) {
  mkdirSync(join(targetPath, "src"), { recursive: true });
  writeFileSync(join(targetPath, "src", "daily_sync.py"), `# @planner:validation_module
# @planner:story = STORY-001
# @planner:proves = crit:daily_sync_traceability
def validate_daily_sync():
    return True
`);
}

function seedValidKnowledgeOverlays(targetPath) {
  writeFileSync(join(targetPath, "planner.mistake_overrides.json"), JSON.stringify({
    version: 1,
    mistakes: [
      {
        id: "KB-M-015",
        title: "Draft migration follow-up",
        summary: "Needs deterministic promotion review.",
        status: "draft",
        source_kb_ref: "plans/knowledge/mistakes.md#M-015",
      },
    ],
  }, null, 2));
  writeFileSync(join(targetPath, "planner.learned_obligations.json"), JSON.stringify({
    version: 1,
    obligations: [
      {
        id: "KB-LO-015",
        source_mistake: "KB-M-015",
        subject_id: "draft:non_destructive_migration",
        verification_mode: "manual_review",
        status: "draft",
        source_kb_ref: "plans/knowledge/mistakes.md#M-015",
      },
    ],
  }, null, 2));
}

function seedHealthyAuditConfig(targetPath) {
  writeFileSync(join(targetPath, "audit.config.json"), JSON.stringify({
    version: 1,
    roles: ["traceability", "assumptions_challenger", "wiring_auditor", "config_integrity"],
    fail_on: ["fail"],
  }, null, 2));
}

function seedTraceHookConfig(targetPath) {
  mkdirSync(join(targetPath, ".claude"), { recursive: true });
  writeFileSync(join(targetPath, ".claude", "settings.local.json"), JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          matcher: ".*",
          hooks: [
            { type: "command", command: "node .agent/skills/iterative-planner/scripts/hooks/post_tool_use.mjs" },
          ],
        },
      ],
    },
  }, null, 2));
}

function seedTelemetryHistory(targetPath) {
  const planName = "plan_2026-04-13_telemetry_fixture";
  const planDir = join(targetPath, "plans", planName);
  const artifactsDir = join(targetPath, "plans", planName, "artifacts");
  const telemetryDir = join(targetPath, "plans", planName, "telemetry");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(telemetryDir, { recursive: true });
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    state: "closed",
    plan_shape: { primary: "integration" },
  }, null, 2));
  writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
    phase: "PLAN",
    items: [
      {
        pack_id: "wiring_auditor",
        guidance: "Exercise the telemetry path through configured hooks and stored history.",
      },
    ],
  }, null, 2));
  writeFileSync(join(artifactsDir, "tool_trace.jsonl"), `${JSON.stringify({
    ts: "2026-04-13T10:00:00.000Z",
    seq: 1,
    tool: "Bash",
    paths: [],
    pattern: null,
    command: "node .agent/skills/iterative-planner/tests/test_migration_wave_policy.mjs",
    phase: "EXECUTE",
    plan_dir: planName,
  })}\n`);
  writeFileSync(join(telemetryDir, "events.jsonl"), `${JSON.stringify({
    event: "action_completed",
    timestamp: "2026-04-13T10:00:01.000Z",
    plan_id: planName,
    repo_root: targetPath,
    phase: "EXECUTE",
    command: "node .agent/skills/iterative-planner/tests/test_migration_wave_policy.mjs",
    source: "post_tool_use",
    trust_level: "trusted",
  })}\n${JSON.stringify({
    event: "proof_recorded",
    timestamp: "2026-04-13T10:00:02.000Z",
    plan_id: planName,
    repo_root: targetPath,
    phase: "EXECUTE",
    proof_type: "migration_verification",
    command: "node .agent/skills/iterative-planner/tests/test_migration_wave_policy.mjs",
    source: "post_tool_use",
    trust_level: "trusted",
  })}\n`);
  writeFileSync(join(telemetryDir, "summary.json"), JSON.stringify({
    enabled: true,
    mode: "present",
    trusted_events_count: 2,
  }, null, 2));
}

function seedPlanHistoryOnly(targetPath) {
  const planName = "plan_2026-04-13_history_only";
  mkdirSync(join(targetPath, "plans", planName, "artifacts"), { recursive: true });
}

function seedWorkflowAuditLog(targetPath, document) {
  mkdirSync(join(targetPath, "plans"), { recursive: true });
  writeFileSync(join(targetPath, "plans", "audit_log.json"), `${JSON.stringify(document, null, 2)}\n`);
}

function seedStewardshipArtifacts(targetPath) {
  mkdirSync(join(targetPath, "reports", "stewardship"), { recursive: true });
  writeFileSync(join(targetPath, "reports", "stewardship", "consolidation_report.md"), "# Stewardship Report\n");
  writeFileSync(join(targetPath, "reports", "stewardship", "opportunity_queue.json"), JSON.stringify({
    version: 1,
    opportunities: [],
  }, null, 2));
}

const tmp = mkdtempSync(join(tmpdir(), "planner-migration-wave-"));
const freshRegistryScanTimestamp = new Date().toISOString();

try {
  seedProjectRoot(tmp);
  setPlannerVersion(tmp, currentVersion);
  const migrateScript = join(tmp, ".agent", "skills", "iterative-planner", "scripts", "migrate.mjs");
  const registryPath = join(tmp, ".agent", "skills", "iterative-planner", "config", ".project_registry.json");

  const currentProject = join(tmp, "fleet-current");
  const laggingProject = join(tmp, "fleet-lagging");
  const behindProject = join(tmp, "fleet-behind");
  const blockedProject = join(tmp, "fleet-blocked");
  const collisionProject = join(tmp, "fleet-collision");
  const junkProject = join(tmp, "fleet-junk");
  for (const project of [currentProject, laggingProject, behindProject, blockedProject, collisionProject, junkProject]) {
    mkdirSync(project, { recursive: true });
    seedProjectRoot(project);
    setPlannerVersion(project, currentVersion);
  }

  seedValidDiscoveryPolicy(currentProject);
  seedValidRecipeSurface(currentProject);
  seedValidStoryRegistry(currentProject);
  seedLiveAnnotationSurface(currentProject);
  seedValidKnowledgeOverlays(currentProject);
  seedHealthyAuditConfig(currentProject);
  seedTraceHookConfig(currentProject);
  seedTelemetryHistory(currentProject);
  seedWorkflowAuditLog(currentProject, {
    audits: [
      {
        type: "advisor",
        timestamp: "2026-04-13T10:00:03.000Z",
        commit: "abcdef12",
      },
    ],
    workflow_events: [
      {
        workflow: "/advisor",
        event: "completed",
        timestamp: "2026-04-13T10:00:03.000Z",
        commit: "abcdef12",
        plan_id: "plan_2026-04-13_telemetry_fixture",
        source_workflow: null,
      },
      {
        workflow: "/steward",
        event: "recommended",
        timestamp: "2026-04-13T10:00:04.000Z",
        commit: "abcdef12",
        plan_id: "plan_2026-04-13_telemetry_fixture",
        source_workflow: "/advisor",
      },
      {
        workflow: "/steward",
        event: "launched",
        timestamp: "2026-04-13T10:00:05.000Z",
        commit: "abcdef12",
        plan_id: "plan_2026-04-13_telemetry_fixture",
        source_workflow: "/advisor",
      },
      {
        workflow: "/steward",
        event: "completed",
        timestamp: "2026-04-13T10:00:06.000Z",
        commit: "abcdef12",
        plan_id: "plan_2026-04-13_telemetry_fixture",
        source_workflow: "/advisor",
      },
    ],
  });

  setPlannerVersion(laggingProject, previousVersion);
  seedPlanHistoryOnly(laggingProject);
  seedWorkflowAuditLog(laggingProject, {
    audits: [
      {
        type: "advisor",
        timestamp: "2026-04-13T11:00:00.000Z",
        commit: "12345678",
      },
    ],
  });
  seedStewardshipArtifacts(laggingProject);

  writeFileSync(join(behindProject, "planner.discovery.json"), "{invalid json\n");
  writeFileSync(join(behindProject, "planner.mistake_overrides.json"), "{invalid json\n");
  const staleRootInstructions = `# Project Instructions — Iterative Planner
<!-- Canonical source: CLAUDE.md. Synced to GEMINI.md and AGENTS.md via .agent/scripts/sync-instructions.sh -->

## Transition Gate Quick Reference

| # | Gate | Command |
|---|------|---------|
| 1 | explore-to-plan | \`node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan\` |
| 2 | plan-to-execute | \`node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute\` |
| 3 | execute-to-reflect | \`node .agent/skills/iterative-planner/scripts/transition.mjs execute-to-reflect\` |
| 4 | reflect-to-close | \`node .agent/skills/iterative-planner/scripts/transition.mjs reflect-to-close\` |
`;
  for (const name of ["CLAUDE.md", "GEMINI.md", "AGENTS.md"]) {
    writeFileSync(join(behindProject, name), staleRootInstructions);
  }
  writeFileSync(join(collisionProject, "planner.mistake_overrides.json"), JSON.stringify({
    version: 1,
    mistakes: [
      {
        id: "M-UI-001",
        title: "Colliding override",
        summary: "Collides with shipped registry id.",
        status: "active",
      },
    ],
  }, null, 2));
  writeFileSync(join(collisionProject, "planner.learned_obligations.json"), JSON.stringify({
    version: 1,
    obligations: [
      {
        id: "responsive_ui_mobile",
        subject_id: "draft:collision_subject",
        verification_mode: "manual_review",
        status: "active",
      },
    ],
  }, null, 2));
  writeFileSync(
    join(junkProject, ".agent/workflows", "safe-change (Stylianos’s MacBook Pro (2)'s conflicted copy 2026-04-08).md"),
    "# conflicted workflow copy\n"
  );
  unlinkSync(join(blockedProject, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs"));

  writeFileSync(registryPath, JSON.stringify({
    source_project_path: tmp,
    last_scan: "2026-04-08T00:00:00.000Z",
    scan_roots: [tmp],
    projects: [
        { path: currentProject, type: "standard" },
        { path: laggingProject, type: "standard" },
        { path: behindProject, type: "standard" },
        { path: blockedProject, type: "standard" },
        { path: collisionProject, type: "standard" },
        { path: junkProject, type: "standard" },
      ],
    }, null, 2));
  for (const project of [currentProject, laggingProject, behindProject, blockedProject, collisionProject, junkProject]) {
    writeFileSync(
      join(project, ".agent", "skills", "iterative-planner", "config", ".project_registry.json"),
      readFileSync(registryPath, "utf-8")
    );
  }

  writeFileSync(registryPath, JSON.stringify({
    source_project_path: tmp,
    last_scan: freshRegistryScanTimestamp,
    scan_roots: [tmp, join(tmp, "extra-scan-root")],
    projects: [
      { path: currentProject, type: "standard", last_upgraded: "2026-04-10T18:08:09.001Z" },
      { path: laggingProject, type: "standard" },
      { path: behindProject, type: "standard" },
      { path: blockedProject, type: "standard" },
      { path: collisionProject, type: "standard" },
      { path: junkProject, type: "standard" },
    ],
  }, null, 2));

  const result = run([migrateScript, "verify-fleet", "--json"], tmp);
  assert(result.ok, "migrate verify-fleet exits cleanly");
  const parsed = JSON.parse(result.stdout);
  assert(parsed?.project_count === 6, "verify-fleet reports every registered fleet project");
  const byName = new Map((parsed?.projects || []).map((project) => [project.name, project]));
  assert(byName.get("fleet-current")?.status === "current", "verify-fleet marks healthy projects as current");
  assert(byName.get("fleet-current")?.summary?.stale_count === 0, "verify-fleet ignores runtime-only registry metadata drift for healthy projects");
  assert(byName.get("fleet-lagging")?.status === "supported_lagging", "verify-fleet marks clean version lag as supported_lagging");
  assert(byName.get("fleet-behind")?.status === "semantically_behind", "verify-fleet marks second-pass semantic drift as semantically_behind");
  assert(byName.get("fleet-blocked")?.status === "blocked", "verify-fleet marks missing critical planner files as blocked");
  assert(byName.get("fleet-collision")?.status === "semantically_behind", "verify-fleet marks shipped-id overlay collisions as semantically_behind");
  assert(byName.get("fleet-junk")?.status === "semantically_behind", "verify-fleet marks planner-managed conflicted-copy artifacts as semantically_behind");
  assert(byName.get("fleet-blocked")?.second_pass_required === true, "verify-fleet requests second-pass verification for blocked projects");
  assert(byName.get("fleet-current")?.second_pass_verification?.status === "PASS", "verify-fleet records a passing second-pass verification for clean projects");
  assert(byName.get("fleet-current")?.second_pass_verified === true, "verify-fleet marks passing second-pass checks as verified");
  assert(byName.get("fleet-current")?.host_project_surfaces?.audit_config?.owner === "host-project", "verify-fleet reports audit.config.json as host-project-owned");
  assert(byName.get("fleet-current")?.host_project_surfaces?.telemetry_capture?.hook_configured === true, "verify-fleet reports telemetry hook readiness when the PostToolUse hook is configured");
  assert(byName.get("fleet-current")?.host_project_surfaces?.telemetry_capture?.usable === true, "verify-fleet marks telemetry capture usable when hook readiness is present");
  assert(byName.get("fleet-current")?.host_project_surfaces?.telemetry_capture?.tool_trace_line_count === 1, "verify-fleet counts stored tool trace lines");
  assert(byName.get("fleet-current")?.host_project_surfaces?.telemetry_capture?.proof_telemetry_event_count === 2, "verify-fleet counts stored proof telemetry events");
  assert((byName.get("fleet-current")?.host_project_surfaces?.telemetry_capture?.issues || []).length === 0, "verify-fleet keeps telemetry capture clean when hook readiness and stored history are present");
  assert(byName.get("fleet-current")?.host_project_surfaces?.workflow_intelligence?.owner === "host-project", "verify-fleet reports workflow intelligence as a host-project-owned surface");
  assert(byName.get("fleet-current")?.host_project_surfaces?.workflow_intelligence?.usable === true, "verify-fleet marks valid workflow-intelligence history usable");
  assert(byName.get("fleet-current")?.host_project_surfaces?.workflow_intelligence?.workflow_event_count === 4, "verify-fleet counts stored workflow-intelligence events");
  assert(
    byName.get("fleet-current")?.host_project_surfaces?.workflow_intelligence?.workflows?.some((entry) => entry.workflow === "/steward" && entry.completed_count === 1),
    "verify-fleet reports stewardship completion history from workflow intelligence"
  );
  assert((byName.get("fleet-current")?.host_project_surfaces?.workflow_intelligence?.issues || []).length === 0, "verify-fleet keeps workflow intelligence clean when recommendation uptake is fully logged");
  assert(byName.get("fleet-current")?.host_project_surfaces?.audit_config?.mutation_policy === "preserve", "verify-fleet marks audit.config.json as preserved during migration");
  assert(byName.get("fleet-current")?.host_project_surfaces?.discovery_policy?.usable === true, "verify-fleet validates a healthy planner.discovery.json surface");
  assert(byName.get("fleet-current")?.host_project_surfaces?.annotation_coverage?.present === true, "verify-fleet detects live host-project annotation coverage");
  assert(byName.get("fleet-current")?.host_project_surfaces?.annotation_coverage?.high_signal_annotation_count === 3, "verify-fleet counts high-signal annotation coverage");
  assert(
    (byName.get("fleet-current")?.host_project_surfaces?.annotation_coverage?.high_signal_keys_present || []).includes("proves"),
    "verify-fleet reports high-signal annotation keys by name"
  );
  assert((byName.get("fleet-current")?.host_project_surfaces?.annotation_coverage?.issues || []).length === 0, "verify-fleet keeps annotation coverage clean when live high-signal annotations exist");
  assert(byName.get("fleet-current")?.host_project_surfaces?.root_instructions?.usable === true, "verify-fleet marks current planner root instructions as usable");
  assert(byName.get("fleet-current")?.host_project_surfaces?.recipes?.configured_surface === true, "verify-fleet detects configured recipe surfaces");
  assert(byName.get("fleet-current")?.host_project_surfaces?.story_registry?.story_count === 1, "verify-fleet reports valid host story registry coverage");
  assert(byName.get("fleet-current")?.host_project_surfaces?.mistake_overrides?.usable === true, "verify-fleet validates a healthy planner.mistake_overrides.json surface");
  assert(byName.get("fleet-current")?.host_project_surfaces?.mistake_overrides?.draft_count === 1, "verify-fleet reports draft mistake overlay counts");
  assert(byName.get("fleet-current")?.host_project_surfaces?.learned_obligation_overrides?.usable === true, "verify-fleet validates a healthy planner.learned_obligations.json surface");
  assert(byName.get("fleet-current")?.host_project_surfaces?.learned_obligation_overrides?.draft_count === 1, "verify-fleet reports draft learned-obligation overlay counts");
  assert(byName.get("fleet-lagging")?.host_project_surfaces?.telemetry_capture?.hook_configured === false, "verify-fleet reports missing telemetry hook readiness when supported settings are absent");
  assert(
    (byName.get("fleet-lagging")?.host_project_surfaces?.telemetry_capture?.issues || []).some((issue) => issue.code === "missing_post_tool_use_hook"),
    "verify-fleet exposes the missing telemetry hook issue code"
  );
  assert(
    (byName.get("fleet-lagging")?.host_project_surfaces?.telemetry_capture?.issues || []).some((issue) => issue.code === "missing_post_tool_use_hook" && String(issue.command || "").includes("run-node.sh")),
    "verify-fleet recommends the hardened trace-hook installer command"
  );
  assert(
    (byName.get("fleet-lagging")?.host_project_surfaces?.telemetry_capture?.issues || []).some((issue) => issue.code === "no_proof_telemetry_history"),
    "verify-fleet exposes missing proof telemetry history as an advisory telemetry issue"
  );
  assert(byName.get("fleet-lagging")?.host_project_surfaces?.workflow_intelligence?.present === true, "verify-fleet detects legacy workflow-intelligence audit history when plans/audit_log.json exists");
  assert(byName.get("fleet-lagging")?.host_project_surfaces?.workflow_intelligence?.workflow_events_supported === false, "verify-fleet distinguishes legacy audit-only workflow history from explicit workflow events");
  assert(byName.get("fleet-lagging")?.host_project_surfaces?.workflow_intelligence?.advisor_audit_count === 1, "verify-fleet reports legacy advisor audit counts in workflow intelligence");
  assert(
    (byName.get("fleet-lagging")?.host_project_surfaces?.workflow_intelligence?.issues || []).some((issue) => issue.code === "workflow_events_missing"),
    "verify-fleet exposes the missing workflow-events issue code"
  );
  assert(
    (byName.get("fleet-lagging")?.host_project_surfaces?.workflow_intelligence?.issues || []).some((issue) => issue.code === "advisor_audit_only_history"),
    "verify-fleet exposes legacy advisor-only workflow history as an advisory issue"
  );
  assert(
    (byName.get("fleet-lagging")?.host_project_surfaces?.workflow_intelligence?.issues || []).some((issue) => issue.code === "steward_reports_without_completion_log"),
    "verify-fleet exposes stewardship artifacts that are missing matching completion events"
  );
  assert(byName.get("fleet-lagging")?.host_project_surfaces?.annotation_coverage?.present === false, "verify-fleet reports when no live annotation coverage exists");
  assert(
    (byName.get("fleet-lagging")?.host_project_surfaces?.annotation_coverage?.issues || []).some((issue) => issue.code === "no_live_annotations"),
    "verify-fleet exposes the no-live-annotations issue code"
  );
  assert(byName.get("fleet-junk")?.planner_managed_surfaces?.migration_hygiene?.usable === false, "verify-fleet reports planner-managed migration hygiene as unusable when conflicted-copy artifacts are present");
  assert(byName.get("fleet-junk")?.planner_managed_surfaces?.migration_hygiene?.artifact_count === 1, "verify-fleet counts planner-managed conflicted-copy artifacts");
  assert(byName.get("fleet-behind")?.second_pass_verification?.status === "FAIL", "verify-fleet surfaces second-pass failures for semantically-behind projects");
  assert(byName.get("fleet-behind")?.second_pass_required === true, "verify-fleet requests second-pass follow-up for semantically-behind projects");
  assert((byName.get("fleet-behind")?.second_pass_verification?.error_count || 0) >= 1, "verify-fleet counts second-pass semantic errors");
  assert(
    (byName.get("fleet-behind")?.second_pass_verification?.issues || []).some((issue) => issue.code === "invalid_discovery_policy"),
    "verify-fleet exposes the exact second-pass issue code for invalid discovery policy files"
  );
  assert(
    (byName.get("fleet-behind")?.second_pass_verification?.issues || []).some((issue) => issue.code === "invalid_mistake_overrides"),
    "verify-fleet exposes the exact second-pass issue code for invalid planner.mistake_overrides.json files"
  );
  assert(byName.get("fleet-behind")?.host_project_surfaces?.root_instructions?.usable === false, "verify-fleet marks stale planner-managed root instructions unusable");
  assert(
    (byName.get("fleet-behind")?.second_pass_verification?.issues || []).some((issue) => issue.code === "stale_root_instruction_front_doors"),
    "verify-fleet exposes the exact second-pass issue code for stale planner root instructions"
  );
  assert(
    (byName.get("fleet-behind")?.second_pass_verification?.recommended_commands || []).length >= 1,
    "verify-fleet returns concrete follow-up commands for second-pass semantic failures"
  );
  assert(byName.get("fleet-collision")?.host_project_surfaces?.mistake_overrides?.usable === false, "verify-fleet marks colliding mistake overlays unusable");
  assert(byName.get("fleet-collision")?.host_project_surfaces?.learned_obligation_overrides?.usable === false, "verify-fleet marks colliding learned-obligation overlays unusable");
  assert(
    (byName.get("fleet-collision")?.second_pass_verification?.issues || []).some((issue) => issue.code === "duplicate_mistake_override_registry_id"),
    "verify-fleet exposes the shipped-registry collision code for planner.mistake_overrides.json"
  );
  assert(
    (byName.get("fleet-collision")?.second_pass_verification?.issues || []).some((issue) => issue.code === "duplicate_learned_obligation_override_registry_id"),
    "verify-fleet exposes the shipped-registry collision code for planner.learned_obligations.json"
  );
  assert(
    (byName.get("fleet-junk")?.second_pass_verification?.issues || []).some((issue) => issue.code === "planner_conflicted_copy_artifact"),
    "verify-fleet exposes the planner-managed conflicted-copy artifact issue code"
  );
  assert(parsed?.statuses?.current === 1, "verify-fleet counts current projects");
  assert(parsed?.statuses?.supported_lagging === 1, "verify-fleet counts supported_lagging projects");
  assert(parsed?.statuses?.semantically_behind === 3, "verify-fleet counts semantically_behind projects");
  assert(parsed?.statuses?.blocked === 1, "verify-fleet counts blocked projects");

  const wavePath = join(tmp, "reports", "migration_wave.json");
  const waveCreate = run([
    migrateScript,
    "migration-wave",
    "create",
    "--manifest",
    wavePath,
    "--exclude",
    "fleet-lagging",
    "--deferred-version",
    previousVersion,
    "--json",
  ], tmp);
  assert(waveCreate.ok, "migration-wave create exits cleanly");
  const waveManifest = JSON.parse(waveCreate.stdout);
  assert(waveManifest?.summary?.intentionally_deferred_count === 1, "migration-wave create records explicit deferrals");
  assert(waveManifest?.excluded_projects?.[0]?.boundary_status === "on_deferred_version", "migration-wave stores deferred version boundary proof");

  const waveVerify = run([migrateScript, "migration-wave", "verify", "--manifest", wavePath, "--json"], tmp);
  assert(waveVerify.ok, "migration-wave verify exits cleanly when boundaries match");
  assert(JSON.parse(waveVerify.stdout)?.status === "PASS", "migration-wave verify passes matching include/exclude boundaries");

  const deferredFleet = run([migrateScript, "verify-fleet", "--manifest", wavePath, "--json"], tmp);
  assert(deferredFleet.ok, "verify-fleet accepts migration wave manifest");
  const deferredParsed = JSON.parse(deferredFleet.stdout);
  const deferredByName = new Map((deferredParsed?.projects || []).map((project) => [project.name, project]));
  assert(deferredByName.get("fleet-lagging")?.status === "intentionally_deferred", "verify-fleet classifies explicit exclusions as intentionally_deferred");
  assert(deferredParsed?.statuses?.intentionally_deferred === 1, "verify-fleet counts intentionally_deferred projects separately");

  const doctor = run([migrateScript, "fleet-doctor", "--manifest", wavePath, "--json"], tmp);
  assert(doctor.ok, "fleet-doctor exits cleanly");
  const doctorParsed = JSON.parse(doctor.stdout);
  assert(doctorParsed?.projects?.some((project) => project.name === "fleet-current" && Array.isArray(project.proof_defaults)), "fleet-doctor emits archetype proof defaults");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
