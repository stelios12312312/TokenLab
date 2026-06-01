#!/usr/bin/env node
// knowledge_benchmark.mjs — golden-task benchmark runner for deterministic knowledge discovery.

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

import { getSkillPath } from "./lib/plan_utils.mjs";

const NODE = process.execPath;
const skillDir = getSkillPath(import.meta.url);
const agentDir = resolve(skillDir, "../..");
const plannerRoot = resolve(skillDir, "../../..");
const realProjectConfigPath = join(skillDir, "config", "knowledge_benchmark_real_projects.json");
const projectRegistryPath = join(skillDir, "config", ".project_registry.json");

function runNode(args, cwd) {
  return execFileSync(NODE, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      _PLANNER_PLAN_TARGET: "",
    },
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function seedKnowledgeBase(projectRoot) {
  mkdirSync(join(projectRoot, "plans", "knowledge"), { recursive: true });
  writeFileSync(join(projectRoot, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
}

function createProject() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-knowledge-benchmark-"));
  cpSync(agentDir, join(tmp, ".agent"), { recursive: true });
  seedKnowledgeBase(tmp);
  return tmp;
}

function createPlan(tmp, goal) {
  runNode([".agent/skills/iterative-planner/scripts/bootstrap.mjs", "new", goal], tmp);
  const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
  return {
    planName,
    planDir: join(tmp, "plans", planName),
  };
}

function runKnowledgeResolver(tmp, scenario) {
  const args = [".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs", "--json"];
  if (typeof scenario.explicit_goal === "string" && scenario.explicit_goal.trim()) {
    args.push("--goal", scenario.explicit_goal.trim());
  }
  if (Array.isArray(scenario.explicit_files)) {
    for (const filePath of scenario.explicit_files) {
      if (typeof filePath === "string" && filePath.trim()) {
        args.push("--file", filePath.trim());
      }
    }
  }
  const stdout = runNode(args, tmp);
  const parsed = parseJson(stdout);
  if (!parsed) throw new Error("knowledge_resolver did not emit valid JSON");
  return parsed;
}

const SCENARIOS = [
  {
    id: "known_recipe_tier0",
    archetype: "workflow_automation",
    label: "Known recipe requests should route at tier0 without deep search",
    explicit_goal: "Sync Eventbrite participants into the CRM using the existing recipe",
    expectation: {
      entrypoint: "/recipe-tidy",
      search_tier: "tier0",
      deep_search_used: false,
      matched_via: "recipe_resolution",
      early_stop_prefix: "tier0:",
      budget_class: "easy",
    },
    setup(tmp) {
      mkdirSync(join(tmp, "recipes", "eventbrite-participant-sync"), { recursive: true });
      writeFileSync(join(tmp, "recipes", "entity_registry.json"), JSON.stringify({
        entities: [{ id: "eventbrite", title: "Eventbrite", aliases: ["eventbrite"], recipe_ids: ["eventbrite-participant-sync"] }],
      }, null, 2));
      writeFileSync(join(tmp, "recipes", "capability_registry.json"), JSON.stringify({
        capabilities: [{ id: "participant_sync", title: "Participant sync", triggers: ["sync.*participants?", "fetch.*participants?"], recipe_ids: ["eventbrite-participant-sync"], supported_entities: ["eventbrite"] }],
      }, null, 2));
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "scripts", "run_eventbrite_sync.mjs"), "console.log('sync');\n");
      writeFileSync(join(tmp, "recipes", "eventbrite-participant-sync", "recipe.json"), JSON.stringify({
        id: "eventbrite-participant-sync",
        entity_ids: ["eventbrite"],
        skills: ["recipe_runner"],
        runner: { type: "command", command: ["node", "scripts/run_eventbrite_sync.mjs"] },
      }, null, 2));
    },
  },
  {
    id: "responsive_ui_tier1",
    archetype: "ux_ui",
    label: "Responsive UI obligations should route at tier1 without deep search",
    expectation: {
      entrypoint: "/safe-change",
      search_tier: "tier1",
      deep_search_used: false,
      early_stop_prefix: "tier1:",
      budget_class: "guarded",
    },
    setup(tmp) {
      const { planDir } = createPlan(tmp, "Improve responsive landing page");
      writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
        archetype: "ux_ui",
        preferred_workflows: ["/safe-change"],
        preferred_personas: ["ux_ui"],
      }, null, 2));
      writeFileSync(join(planDir, "plan.md"), `# Plan\n\n## Goal\nImprove responsive landing page\n\n## Files To Modify\n- src/styles.css\n`);
      writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({
        version: 1,
        primary_user: "Website visitor",
        job_to_be_done: "Review a responsive landing page on mobile",
        desired_outcomes: ["Content remains readable on mobile"],
        anti_goals: ["Desktop-only layout regressions"],
        constraints: [],
        deliverables: [{ id: "landing_page", name: "Landing page", kind: "ui", purpose: "Help visitors understand the offer quickly", quality_bars: ["Readable on mobile"], anti_goals: ["Broken mobile layout"], evidence_mode: "manual_observation" }],
      }, null, 2));
      mkdirSync(join(tmp, "src"), { recursive: true });
      writeFileSync(join(tmp, "src", "styles.css"), "body { color: black; }\n");
    },
  },
  {
    id: "quant_upside_sme",
    archetype: "quant",
    label: "Quant upside work should route to /sme-improvement with tier2 persona signals",
    expectation: {
      entrypoint: "/sme-improvement",
      search_tier: "tier2",
      deep_search_used: true,
      matched_via: "upside_persona_alignment",
      budget_class: "deep",
    },
    setup(tmp) {
      const { planDir } = createPlan(tmp, "Improve live-trading edge and validation strategy");
      writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
        archetype: "quant",
        preferred_personas: ["quant", "assumptions_challenger"],
        search_policy: { prefer_early_stop: false },
      }, null, 2));
      writeFileSync(join(planDir, "plan.md"), "# Plan\n\n## Goal\nImprove live-trading edge and validation strategy\n");
      writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        phase: "PLAN",
        items: [
          { pack_id: "quant", guidance: "Protect against leakage and weak validation." },
          { pack_id: "assumptions_challenger", guidance: "Stress the thesis and baseline assumptions." },
        ],
      }, null, 2));
      writeFileSync(join(planDir, "persona_constraints.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        phase: "plan",
        constraints: [{ id: "QU-C-001", role: "quant", severity: "HIGH", constraint: "Plan must include a dedicated leakage review step", story_refs: ["US-Q1"] }],
      }, null, 2));
      writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        gate: "explore-to-plan",
        summary: { fail: 0, warn: 1, info: 0 },
        findings: [{ analyzer: "[quant] role-audit", severity: "warn", message: "Validation strategy is thin.", _roleAudit: { role: "quant", severity: "warn", story_refs: ["US-Q1"] } }],
      }, null, 2));
    },
  },
  {
    id: "course_generator_guardrails",
    archetype: "ux_ui_course",
    label: "User-facing course generation should prefer safe-change-power guardrails",
    expectation: {
      entrypoint: "/safe-change-power",
      search_tier: "tier2",
      deep_search_used: true,
      matched_via: "user_visible_regression_risk",
      budget_class: "deep",
    },
    setup(tmp) {
      const { planDir } = createPlan(tmp, "Improve course creation flow for learners and authors");
      writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
        preferred_personas: ["ux_ui", "traceability"],
        search_policy: { prefer_early_stop: false },
      }, null, 2));
      mkdirSync(join(tmp, "src"), { recursive: true });
      mkdirSync(join(tmp, "templates"), { recursive: true });
      mkdirSync(join(tmp, "schema"), { recursive: true });
      writeFileSync(join(tmp, "src", "course_generator.mjs"), "export function buildCourse() { return []; }\n");
      writeFileSync(join(tmp, "templates", "course_outline.mustache"), "{{title}}\n");
      writeFileSync(join(tmp, "schema", "course_output.json"), "{\n  \"type\": \"object\"\n}\n");
      writeFileSync(join(planDir, "plan.md"), `# Plan\n\n## Goal\nImprove course creation flow for learners and authors\n\n## Files To Modify\n- src/course_generator.mjs\n- templates/course_outline.mustache\n- schema/course_output.json\n`);
      writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({
        version: 1,
        primary_user: "Course creator",
        job_to_be_done: "Create a high-quality course without hidden output regressions",
        desired_outcomes: ["Reliable generated course structure", "Clear author workflow"],
        anti_goals: ["Broken generated outputs", "Confusing authoring flow"],
        constraints: [],
        deliverables: [{ id: "course_flow", kind: "ui", name: "Course creation flow", purpose: "Help authors create courses quickly and safely", evidence_mode: "manual_observation" }],
      }, null, 2));
      writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        phase: "PLAN",
        items: [
          { pack_id: "ux_ui", guidance: "Protect the author workflow and visible output quality." },
          { pack_id: "traceability", guidance: "Keep generated-course evidence linked to stories and outputs." },
        ],
      }, null, 2));
      writeFileSync(join(planDir, "persona_constraints.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        phase: "plan",
        constraints: [{ id: "UX-C-001", role: "ux_ui", severity: "HIGH", constraint: "Plan must include a regression check for generated course outputs", story_refs: ["US-C1"] }],
      }, null, 2));
      writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        gate: "explore-to-plan",
        summary: { fail: 0, warn: 1, info: 0 },
        findings: [{ analyzer: "[ux_ui] role-audit", severity: "warn", message: "Course output regressions are easy to miss.", _roleAudit: { role: "ux_ui", severity: "warn", story_refs: ["US-C1"] } }],
      }, null, 2));
    },
  },
  {
    id: "plugin_config_guardrails",
    archetype: "cms_plugin",
    label: "Plugin config and migration work should prefer safe-change-power guardrails",
    expectation: {
      entrypoint: "/safe-change-power",
      search_tier: "tier2",
      deep_search_used: true,
      matched_via: "config_migration_risk",
      budget_class: "deep",
    },
    setup(tmp) {
      const { planDir } = createPlan(tmp, "Harden membership plugin role migration and config safety");
      writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
        archetype: "cms_plugin",
        preferred_personas: ["config_integrity", "traceability"],
        search_policy: { prefer_early_stop: false },
      }, null, 2));
      mkdirSync(join(tmp, "plugin"), { recursive: true });
      mkdirSync(join(tmp, "config"), { recursive: true });
      mkdirSync(join(tmp, "migrations"), { recursive: true });
      writeFileSync(join(tmp, "plugin", "membership-plugin.php"), "<?php\n// plugin bootstrap\n");
      writeFileSync(join(tmp, "config", "roles.json"), "{\n  \"roles\": []\n}\n");
      writeFileSync(join(tmp, "migrations", "20260408_add_role.php"), "<?php\n// migration\n");
      writeFileSync(join(planDir, "plan.md"), `# Plan\n\n## Goal\nHarden membership plugin role migration and config safety\n\n## Files To Modify\n- plugin/membership-plugin.php\n- config/roles.json\n- migrations/20260408_add_role.php\n`);
      writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        phase: "PLAN",
        items: [
          { pack_id: "config_integrity", guidance: "Protect config compatibility and migration safety." },
          { pack_id: "traceability", guidance: "Keep migration evidence linked to plugin behavior." },
        ],
      }, null, 2));
      writeFileSync(join(planDir, "persona_constraints.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        phase: "plan",
        constraints: [{ id: "CI-C-001", role: "config_integrity", severity: "HIGH", constraint: "Plan must document new role config and migration compatibility", story_refs: ["US-P1"] }],
      }, null, 2));
      writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        gate: "explore-to-plan",
        summary: { fail: 0, warn: 1, info: 0 },
        findings: [{ analyzer: "[config_integrity] role-audit", severity: "warn", message: "Config migrations are regression-prone.", _roleAudit: { role: "config_integrity", severity: "warn", story_refs: ["US-P1"] } }],
      }, null, 2));
    },
  },
  {
    id: "content_automation_steward",
    archetype: "content_automation",
    label: "Content automation drift should escalate to stewardship",
    expectation: {
      entrypoint: "/steward",
      search_tier: "tier2",
      deep_search_used: true,
      matched_via: "content_automation_drift",
      budget_class: "deep",
    },
    setup(tmp) {
      const { planDir } = createPlan(tmp, "Consolidate publishing drift across prompts, outputs, and automation docs");
      writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
        archetype: "content_automation",
        preferred_personas: ["traceability", "assumptions_challenger"],
        search_policy: { prefer_early_stop: false },
      }, null, 2));
      mkdirSync(join(tmp, "prompts"), { recursive: true });
      mkdirSync(join(tmp, "automation"), { recursive: true });
      mkdirSync(join(tmp, "docs"), { recursive: true });
      mkdirSync(join(tmp, "reports", "publishing"), { recursive: true });
      writeFileSync(join(tmp, "prompts", "article_prompt.md"), "# Prompt\n");
      writeFileSync(join(tmp, "automation", "publisher.mjs"), "export async function publish() { return true; }\n");
      writeFileSync(join(tmp, "docs", "publishing.md"), "# Publishing flow\n");
      writeFileSync(join(tmp, "reports", "publishing", "output_summary.md"), "# Output summary\n");
      writeFileSync(join(planDir, "plan.md"), `# Plan\n\n## Goal\nConsolidate publishing drift across prompts, outputs, and automation docs\n\n## Files To Modify\n- prompts/article_prompt.md\n- automation/publisher.mjs\n- docs/publishing.md\n- reports/publishing/output_summary.md\n`);
      writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        phase: "PLAN",
        items: [
          { pack_id: "traceability", guidance: "Keep content outputs and automation grounded in durable evidence." },
          { pack_id: "assumptions_challenger", guidance: "Question whether published outputs still reflect the intended workflow." },
        ],
      }, null, 2));
      writeFileSync(join(planDir, "persona_constraints.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        phase: "plan",
        constraints: [{ id: "TR-C-201", role: "traceability", severity: "HIGH", constraint: "Plan must reconcile docs, prompts, and published outputs", story_refs: ["US-A1"] }],
      }, null, 2));
      writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
        version: 1,
        generated_at: "2026-04-08T00:00:00.000Z",
        gate: "explore-to-plan",
        summary: { fail: 0, warn: 1, info: 0 },
        findings: [{ analyzer: "[traceability] role-audit", severity: "warn", message: "Publishing surfaces are drifting apart.", _roleAudit: { role: "traceability", severity: "warn", story_refs: ["US-A1"] } }],
      }, null, 2));
    },
  },
];

export function loadRealProjectCohorts(configPath = realProjectConfigPath) {
  const parsed = readJsonFile(configPath);
  return Array.isArray(parsed?.cohorts) ? parsed.cohorts : [];
}

export function matchRegisteredProject(projects, pathFragments = []) {
  const list = Array.isArray(projects) ? projects : [];
  for (const fragment of pathFragments) {
    if (typeof fragment !== "string" || !fragment.trim()) continue;
    const match = list.find((project) => typeof project?.path === "string" && project.path.includes(fragment));
    if (match) return match;
  }
  return null;
}

export function runKnowledgeBenchmarks() {
  const scenarioResults = [];

  for (const scenario of SCENARIOS) {
    const tmp = createProject();
    try {
      scenario.setup(tmp);
      const parsed = runKnowledgeResolver(tmp, scenario);
      const topWorkflow = parsed?.relevant_workflows?.[0] || {};
      const matchedVia = Array.isArray(topWorkflow.matched_via) ? topWorkflow.matched_via : [];
      const routeMatches = parsed?.recommended_entrypoint?.value === scenario.expectation.entrypoint;
      const tierMatches = parsed?.search_tier === scenario.expectation.search_tier;
      const deepMatches = parsed?.trace_profile?.deep_search_used === scenario.expectation.deep_search_used;
      const signalMatches = scenario.expectation.matched_via
        ? matchedVia.includes(scenario.expectation.matched_via)
        : true;
      const earlyStopMatches = Object.prototype.hasOwnProperty.call(scenario.expectation, "early_stop_prefix")
        ? String(parsed?.trace_profile?.early_stop_reason || "").startsWith(scenario.expectation.early_stop_prefix)
        : true;

      scenarioResults.push({
        id: scenario.id,
        archetype: scenario.archetype,
        label: scenario.label,
        expected: scenario.expectation,
        actual: {
          entrypoint: parsed?.recommended_entrypoint?.value || null,
          search_tier: parsed?.search_tier || null,
          deep_search_used: !!parsed?.trace_profile?.deep_search_used,
          matched_via: matchedVia,
          early_stop_reason: parsed?.trace_profile?.early_stop_reason || null,
          tiers_visited: Array.isArray(parsed?.trace_profile?.tiers_visited) ? parsed.trace_profile.tiers_visited : [],
          sources_consulted: Array.isArray(parsed?.trace_profile?.sources_consulted) ? parsed.trace_profile.sources_consulted : [],
          candidate_count: Number(parsed?.trace_profile?.candidate_count || 0),
          route_decision_basis: Array.isArray(parsed?.trace_profile?.route_decision_basis) ? parsed.trace_profile.route_decision_basis : [],
        },
        checks: {
          route_matches: routeMatches,
          tier_matches: tierMatches,
          deep_search_matches: deepMatches,
          signal_matches: signalMatches,
          early_stop_matches: earlyStopMatches,
        },
        passed: routeMatches && tierMatches && deepMatches && signalMatches && earlyStopMatches,
      });
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  const total = scenarioResults.length;
  const easyCases = scenarioResults.filter((result) => result.expected.budget_class !== "deep");
  const deepCases = scenarioResults.filter((result) => result.expected.budget_class === "deep");
  const routeMatches = scenarioResults.filter((result) => result.checks.route_matches).length;
  const tierMatches = scenarioResults.filter((result) => result.checks.tier_matches).length;
  const deepSearchMatches = scenarioResults.filter((result) => result.checks.deep_search_matches).length;
  const signalMatches = scenarioResults.filter((result) => result.checks.signal_matches).length;
  const earlyStopComparable = scenarioResults.filter((result) => Object.prototype.hasOwnProperty.call(result.expected, "early_stop_prefix"));
  const earlyStopMatches = earlyStopComparable.filter((result) => result.checks.early_stop_matches).length;

  const mean = (values) => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const archetypeSummary = {};
  for (const result of scenarioResults) {
    const bucket = archetypeSummary[result.archetype] || {
      scenarios: 0,
      passed: 0,
      avg_tiers_visited: 0,
      avg_sources_consulted: 0,
      avg_candidate_count: 0,
      route_accuracy: 0,
      deep_search_count: 0,
    };
    bucket.scenarios++;
    if (result.passed) bucket.passed++;
    if (result.checks.route_matches) bucket.route_accuracy++;
    if (result.actual.deep_search_used) bucket.deep_search_count++;
    bucket.avg_tiers_visited += result.actual.tiers_visited.length;
    bucket.avg_sources_consulted += result.actual.sources_consulted.length;
    bucket.avg_candidate_count += result.actual.candidate_count;
    archetypeSummary[result.archetype] = bucket;
  }

  for (const bucket of Object.values(archetypeSummary)) {
    bucket.route_accuracy = bucket.scenarios === 0 ? 0 : bucket.route_accuracy / bucket.scenarios;
    bucket.avg_tiers_visited = bucket.scenarios === 0 ? 0 : bucket.avg_tiers_visited / bucket.scenarios;
    bucket.avg_sources_consulted = bucket.scenarios === 0 ? 0 : bucket.avg_sources_consulted / bucket.scenarios;
    bucket.avg_candidate_count = bucket.scenarios === 0 ? 0 : bucket.avg_candidate_count / bucket.scenarios;
  }

  return {
    generated_at: new Date().toISOString(),
    total_scenarios: total,
    passed_scenarios: scenarioResults.filter((result) => result.passed).length,
    route_accuracy: routeMatches / total,
    tier_accuracy: tierMatches / total,
    deep_search_accuracy: deepSearchMatches / total,
    matched_via_accuracy: signalMatches / total,
    early_stop_accuracy: earlyStopComparable.length === 0 ? 1 : earlyStopMatches / earlyStopComparable.length,
    easy_case_no_deep_search_rate: easyCases.length === 0 ? 1 : easyCases.filter((result) => result.actual.deep_search_used === false).length / easyCases.length,
    deep_case_deep_search_rate: deepCases.length === 0 ? 1 : deepCases.filter((result) => result.actual.deep_search_used === true).length / deepCases.length,
    avg_tiers_visited: mean(scenarioResults.map((result) => result.actual.tiers_visited.length)),
    avg_sources_consulted: mean(scenarioResults.map((result) => result.actual.sources_consulted.length)),
    avg_candidate_count: mean(scenarioResults.map((result) => result.actual.candidate_count)),
    archetypes: archetypeSummary,
    scenarios: scenarioResults,
  };
}

export function runRealProjectBenchmarks({
  configPath = realProjectConfigPath,
  registryPath = projectRegistryPath,
} = {}) {
  const cohorts = loadRealProjectCohorts(configPath);
  const registry = readJsonFile(registryPath);
  const projects = Array.isArray(registry?.projects) ? registry.projects : [];
  const scenarioResults = [];

  for (const cohort of cohorts) {
    const project = matchRegisteredProject(projects, cohort.path_fragments);
    if (!project?.path || !existsSync(project.path)) {
      scenarioResults.push({
        id: cohort.id,
        archetype: cohort.archetype,
        label: cohort.label,
        expected: cohort.expected,
        skipped: true,
        skip_reason: project?.path ? "project_path_missing" : "project_not_registered",
      });
      continue;
    }

    const args = [
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
      "--dir", project.path,
      "--goal", cohort.goal,
      "--no-plan-context",
    ];
    for (const filePath of Array.isArray(cohort.files) ? cohort.files : []) {
      if (typeof filePath === "string" && filePath.trim()) {
        args.push("--file", filePath.trim());
      }
    }

    const parsed = parseJson(runNode(args, plannerRoot));
    const topWorkflow = parsed?.relevant_workflows?.[0] || {};
    const matchedVia = Array.isArray(topWorkflow.matched_via) ? topWorkflow.matched_via : [];
    const routeMatches = parsed?.recommended_entrypoint?.value === cohort.expected.entrypoint;
    const tierMatches = !cohort.expected.search_tier || parsed?.search_tier === cohort.expected.search_tier;
    const deepMatches = !Object.prototype.hasOwnProperty.call(cohort.expected, "deep_search_used") ||
      parsed?.trace_profile?.deep_search_used === cohort.expected.deep_search_used;

    scenarioResults.push({
      id: cohort.id,
      archetype: cohort.archetype,
      label: cohort.label,
      project_path: project.path,
      expected: cohort.expected,
      actual: {
        entrypoint: parsed?.recommended_entrypoint?.value || null,
        search_tier: parsed?.search_tier || null,
        deep_search_used: !!parsed?.trace_profile?.deep_search_used,
        matched_via: matchedVia,
        early_stop_reason: parsed?.trace_profile?.early_stop_reason || null,
      },
      checks: {
        route_matches: routeMatches,
        tier_matches: tierMatches,
        deep_search_matches: deepMatches,
      },
      passed: routeMatches && tierMatches && deepMatches,
      skipped: false,
    });
  }

  const executed = scenarioResults.filter((result) => !result.skipped);
  const mean = (values) => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    generated_at: new Date().toISOString(),
    cohort: "real-projects",
    total_defined: scenarioResults.length,
    executed_scenarios: executed.length,
    skipped_scenarios: scenarioResults.filter((result) => result.skipped).length,
    passed_scenarios: executed.filter((result) => result.passed).length,
    route_accuracy: executed.length === 0 ? 1 : executed.filter((result) => result.checks.route_matches).length / executed.length,
    tier_accuracy: executed.length === 0 ? 1 : executed.filter((result) => result.checks.tier_matches).length / executed.length,
    deep_search_accuracy: executed.length === 0 ? 1 : executed.filter((result) => result.checks.deep_search_matches).length / executed.length,
    avg_defined_path_fragments: mean(cohorts.map((entry) => Array.isArray(entry.path_fragments) ? entry.path_fragments.length : 0)),
    scenarios: scenarioResults,
  };
}

function formatHuman(summary) {
  const totalScenarios = Number(summary.total_scenarios ?? summary.total_defined ?? 0);
  const passedScenarios = Number(summary.passed_scenarios ?? 0);
  const lines = [
    "Knowledge Resolver Benchmarks",
    "",
    `Scenarios: ${passedScenarios}/${totalScenarios} passed`,
    `Route accuracy: ${(summary.route_accuracy * 100).toFixed(0)}%`,
    `Tier accuracy: ${(summary.tier_accuracy * 100).toFixed(0)}%`,
    `Deep-search accuracy: ${(summary.deep_search_accuracy * 100).toFixed(0)}%`,
    ...(typeof summary.easy_case_no_deep_search_rate === "number"
      ? [`Easy-case no-deep-search rate: ${(summary.easy_case_no_deep_search_rate * 100).toFixed(0)}%`]
      : []),
    ...(typeof summary.avg_tiers_visited === "number"
      ? [`Average tiers visited: ${summary.avg_tiers_visited.toFixed(2)}`]
      : []),
    ...(typeof summary.avg_sources_consulted === "number"
      ? [`Average sources consulted: ${summary.avg_sources_consulted.toFixed(2)}`]
      : []),
    ...(typeof summary.avg_candidate_count === "number"
      ? [`Average candidate count: ${summary.avg_candidate_count.toFixed(2)}`]
      : []),
    ...(typeof summary.skipped_scenarios === "number"
      ? [`Skipped scenarios: ${summary.skipped_scenarios}`]
      : []),
    "",
  ];

  for (const scenario of summary.scenarios) {
    if (scenario.skipped) {
      lines.push(`SKIP ${scenario.id} -> ${scenario.skip_reason}`);
      continue;
    }
    lines.push(`${scenario.passed ? "PASS" : "FAIL"} ${scenario.id} -> ${scenario.actual.entrypoint} (${scenario.actual.search_tier})`);
  }

  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const outputJson = args.includes("--json");
  const summary = args.includes("--real-projects")
    ? runRealProjectBenchmarks()
    : runKnowledgeBenchmarks();
  if (outputJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatHuman(summary));
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith("knowledge_benchmark.mjs") ||
  process.argv[1].includes("knowledge_benchmark")
);

if (isMain) main();
