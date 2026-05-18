#!/usr/bin/env node
// test_knowledge_resolver.mjs — thematic coverage for deterministic knowledge discovery.

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const agentDir = resolve(skillDir, "../..");
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
        env: {
          ...process.env,
          CODEX_THREAD_ID: "",
          _PLANNER_PLAN_TARGET: "",
        },
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

function seedKnowledgeBase(projectRoot) {
  mkdirSync(join(projectRoot, "plans", "knowledge"), { recursive: true });
  writeFileSync(join(projectRoot, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "patterns.md"), "# Patterns\n");
  writeFileSync(join(projectRoot, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
}

function seedRetroLedger(projectRoot, retros) {
  mkdirSync(join(projectRoot, "plans", "knowledge", "retros", "cases"), { recursive: true });
  writeFileSync(join(projectRoot, "plans", "knowledge", "retros", "retro_ledger.json"), JSON.stringify({
    version: 1,
    retros,
  }, null, 2));
  for (const retro of retros || []) {
    if (retro?.case_file) {
      writeFileSync(join(projectRoot, retro.case_file), `# ${retro.id}\n`);
    }
  }
}

function seedStoryRegistry(projectRoot, stories) {
  mkdirSync(join(projectRoot, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(projectRoot, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    updated: "2026-04-08T00:00:00.000Z",
    stories,
  }, null, 2));
}

function createProject() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-knowledge-resolver-"));
  cpSync(agentDir, join(tmp, ".agent"), { recursive: true });
  seedKnowledgeBase(tmp);
  return tmp;
}

function parseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

function scenarioKnownRecipeStopsAtTier0() {
  const tmp = createProject();
  try {
    mkdirSync(join(tmp, "recipes", "eventbrite-participant-sync"), { recursive: true });
    writeFileSync(join(tmp, "recipes", "entity_registry.json"), JSON.stringify({
      entities: [
        {
          id: "eventbrite",
          title: "Eventbrite",
          aliases: ["eventbrite"],
          recipe_ids: ["eventbrite-participant-sync"],
        },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "recipes", "capability_registry.json"), JSON.stringify({
      capabilities: [
        {
          id: "participant_sync",
          title: "Participant sync",
          triggers: ["fetch.*participants?"],
          recipe_ids: ["eventbrite-participant-sync"],
          supported_entities: ["eventbrite"],
        },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "recipes", "eventbrite-participant-sync", "recipe.json"), JSON.stringify({
      id: "eventbrite-participant-sync",
      entity_ids: ["eventbrite"],
      skills: ["recipe_runner"],
      runner: {
        type: "command",
        command: ["node", "scripts/run_eventbrite_sync.mjs"],
      },
    }, null, 2));

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal", "Fetch Eventbrite participants",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for a known recipe request");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for a known recipe request");
    assert(parsed?.recommended_entrypoint?.value === "/recipe-tidy", "knowledge_resolver routes known recipes to /recipe-tidy");
    assert(parsed?.search_tier === "tier0", "knowledge_resolver stops at tier0 for known recipes");
    assert(parsed?.trace_profile?.deep_search_used === false, "knowledge_resolver avoids deep search for known recipes");
    assert(parsed?.recipe_resolution?.primary_resolution?.route === "execute_known_recipe", "knowledge_resolver preserves execute_known_recipe route");
    assert(parsed?.relevant_recipes?.[0]?.recipe_id === "eventbrite-participant-sync", "knowledge_resolver surfaces the matched recipe");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioResponsiveUiObligationSurfacesAtTier1() {
  const tmp = createProject();
  try {
    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Improve responsive landing page"], tmp);
    assert(created.ok, "bootstrap new succeeds for the responsive UI fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Improve responsive landing page

## Files To Modify
- src/styles.css
`);
    writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({
      version: 1,
      primary_user: "Website visitor",
      job_to_be_done: "Review a responsive landing page on mobile",
      desired_outcomes: ["Content remains readable on mobile"],
      anti_goals: ["Desktop-only layout regressions"],
      constraints: [],
      deliverables: [
        {
          id: "landing_page",
          name: "Landing page",
          kind: "ui",
          purpose: "Help visitors understand the offer quickly",
          quality_bars: ["Readable on mobile"],
          anti_goals: ["Broken mobile layout"],
          evidence_mode: "manual_observation",
        },
      ],
    }, null, 2));
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "styles.css"), "body { color: black; }\n");

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for the responsive UI fixture");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for the responsive UI fixture");
    assert((parsed?.related_mistakes || []).some((entry) => entry.id === "M-UI-001"), "knowledge_resolver activates the responsive UI mistake registry entry");
    assert((parsed?.active_obligations || []).some((entry) => entry.id === "responsive_ui_mobile"), "knowledge_resolver activates the responsive UI learned obligation");
    assert(parsed?.verification_obligation_synthesis?.required === true, "knowledge_resolver surfaces synthesized verification obligations for responsive UI work");
    assert((parsed?.verification_obligation_synthesis?.obligations || []).some((entry) => entry.id === "browser_ui"), "knowledge_resolver synthesizes a browser/UI verification obligation for responsive UI work");
    assert(parsed?.adversarial_profile?.profile_id === "ui_resilience", "knowledge_resolver synthesizes a UI-specific adversarial profile for responsive UI work");
    assert((parsed?.adversarial_profile?.adversarial_objective || "").includes("crash") && (parsed?.adversarial_profile?.adversarial_objective || "").includes("mislead"), "knowledge_resolver describes UI adversarial work as crash/freeze/misleading-state hunting");
    assert((parsed?.suggested_attack_vectors || []).some((entry) => entry.id === "ui_null_or_error_render"), "knowledge_resolver suggests UI crash/error-state attack vectors for responsive UI work");
    assert(parsed?.search_tier === "tier1", "knowledge_resolver uses tier1 for responsive UI obligations");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlannerCoreMistakeSurfacesRelatedRetro() {
  const tmp = createProject();
  try {
    seedRetroLedger(tmp, [
      {
        id: "R-2026-03-24-001",
        date: "2026-03-24",
        title: "Planner-core ripple-through learned the hard way",
        summary: "Planner-core contract changes must update the surrounding doc, migration, and proof surfaces together.",
        failure_modes: ["MISSED_BLAST_RADIUS"],
        discovered_phase: "execute-to-reflect",
        affected_surfaces: [".agent/skills/iterative-planner/scripts/", ".agent/workflows/"],
        root_cause: "The rollout treated a behavioral contract change like a local code patch.",
        promotion_decision: "hard_invariant",
        promotions: {
          mistake_ids: ["M-001"],
          obligation_ids: [],
          invariant_ids: ["active_mistake_missing_declared_guard"]
        },
        kb_refs: ["plans/knowledge/mistakes.md#M-001"],
        tags: ["planner_core", "ripple"],
        case_file: "plans/knowledge/retros/cases/R-2026-03-24-001.md",
        status: "accepted"
      }
    ]);

    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Refactor planner migration ripple checks"], tmp);
    assert(created.ok, "bootstrap new succeeds for the planner-core retro fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Refactor planner migration ripple checks

## Files To Modify
- .agent/skills/iterative-planner/scripts/migrate.mjs
- .agent/workflows/retro.md
`);

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for the planner-core retro fixture");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for the planner-core retro fixture");
    assert((parsed?.related_mistakes || []).some((entry) => entry.id === "M-001"), "knowledge_resolver activates the planner-core ripple-through mistake");
    assert((parsed?.related_retros || []).some((entry) => entry.id === "R-2026-03-24-001"), "knowledge_resolver surfaces the linked structured retro for the active planner-core mistake");
    assert(parsed?.retro_registry?.present === true && parsed?.retro_registry?.accepted_count === 1, "knowledge_resolver reports the retro registry summary when structured retros exist");
    assert(Array.isArray(parsed?.matches?.trusted), "knowledge_resolver emits matches.trusted for planner-core retro work");
    assert((parsed?.matches?.trusted || []).some((entry) => entry.kind === "mistake" && entry.id === "M-001"), "knowledge_resolver promotes the active planner-core mistake into a trusted knowledge match");
    assert((parsed?.matches?.trusted || []).some((entry) => entry.kind === "retro" && entry.id === "R-2026-03-24-001"), "knowledge_resolver promotes the linked structured retro into a trusted knowledge match");
    assert(Array.isArray(parsed?.matches?.draft) && parsed.matches.draft.length === 0, "knowledge_resolver leaves matches.draft empty when no draft fallback is needed");
    assert(parsed?.gap_check_needed === false, "knowledge_resolver does not request a draft gap check when trusted planner-core matches exist");
    assert(parsed?.draft_promotion_contract?.active === false, "knowledge_resolver keeps the reviewed-draft promotion contract inactive when trusted matches are already strong");
    assert(parsed?.trust_summary?.strongest_signal === "strong_deterministic", "knowledge_resolver summarizes strong trusted planner-core retrieval explicitly");
    assert((parsed?.recommended_path_provenance?.trusted_match_ids || []).includes("mistake:M-001"), "knowledge_resolver points recommended-path provenance at the trusted mistake match");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioWeakLexicalOverlapStaysAdvisory() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal", "Review planner migration ripple notes",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for weak lexical overlap discovery");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for weak lexical overlap discovery");
    assert(!(parsed?.matches?.trusted || []).some((entry) => entry.kind === "mistake" && entry.id === "M-001"), "weak lexical overlap does not promote M-001 into trusted knowledge");
    assert((parsed?.matches?.derived || []).some((entry) => entry.kind === "mistake" && entry.id === "M-001"), "weak lexical overlap can surface M-001 as a derived advisory match");
    assert(!(parsed?.recommended_path_provenance?.blocker_capable_match_ids || []).includes("mistake:M-001"), "derived mistake matches do not become blocker-capable route provenance");
    assert((parsed?.trust_summary?.trusted_blocking_capable_count || 0) === 0, "weak lexical overlap leaves blocker-capable trusted count at zero");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioNoDeterministicMatchRequestsDraftGapCheck() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal", "Brainstorm an internal memo about broad knowledge alignment",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly when deterministic retrieval is weak");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON when deterministic retrieval is weak");
    assert(Array.isArray(parsed?.matches?.trusted) && parsed.matches.trusted.length === 0, "knowledge_resolver leaves trusted matches empty when no deterministic knowledge is found");
    assert(parsed?.gap_check_needed === true, "knowledge_resolver requests a draft gap check when deterministic retrieval is empty or weak");
    assert(parsed?.draft_candidate_prompt?.stage === "draft_candidate_only", "knowledge_resolver emits a structured draft candidate prompt instead of hidden fallback truth");
    assert(parsed?.draft_candidate_prompt?.review_surface?.relative_path === "plans/knowledge/draft_candidates.review.json", "knowledge_resolver points draft gap checks at the reviewed draft-candidate surface");
    assert(parsed?.draft_promotion_contract?.active === true, "knowledge_resolver activates the reviewed-draft promotion contract when the gap check is needed");
    assert(parsed?.draft_promotion_contract?.promotion_command?.includes("--draft-candidates"), "knowledge_resolver emits the additive promotion command for reviewed draft candidates");
    assert(Array.isArray(parsed?.matches?.draft) && parsed.matches.draft.length === 0, "knowledge_resolver keeps matches.draft empty until an outer agent actually proposes draft candidates");
    assert((parsed?.recommended_path_provenance?.blocker_capable_match_ids || []).length === 0, "draft gap-check requests do not create blocker-capable provenance");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRecipeProposalGoalRoutesToRecipeDiscovery() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal", "Propose a recipe from this recent request: sync Eventbrite attendees into GHL",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for prompt-driven recipe proposal wording");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for prompt-driven recipe proposal wording");
    assert(parsed?.recommended_entrypoint?.value === "/recipe-discovery", "knowledge_resolver routes prompt-driven recipe proposal wording to /recipe-discovery");
    assert((parsed?.relevant_workflows || []).some((entry) => entry.id === "/recipe-discovery"), "knowledge_resolver keeps /recipe-discovery in the relevant workflow set for recipe proposal wording");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRepoFirstGoalIgnoresAmbientPlanContext() {
  const tmp = createProject();
  try {
    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Refactor planner bootstrap internals"], tmp);
    assert(created.ok, "bootstrap new succeeds for the repo-first discovery fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
      archetype: "ux_ui",
      preferred_workflows: ["/safe-change"],
      preferred_personas: ["ux_ui"],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Refactor planner bootstrap internals

## Files To Modify
- .agent/skills/iterative-planner/scripts/bootstrap.mjs
`);
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "styles.css"), "body { color: black; }\n");

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal", "Improve responsive landing page",
      "--file", "src/styles.css",
      "--no-plan-context",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for repo-first discovery when no active plan context is requested");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for repo-first no-plan-context discovery");
    assert(parsed?.active_plan?.present === false, "knowledge_resolver suppresses ambient active-plan context when --no-plan-context is used");
    assert(parsed?.recommended_entrypoint?.value === "/safe-change", "knowledge_resolver keeps repo-first responsive work on /safe-change instead of planner-core routing");
    assert(!(parsed?.relevant_workflows?.[0]?.matched_via || []).includes("planner_core_files"), "knowledge_resolver does not leak planner-core file pressure into repo-first discovery");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioFuzzyWorkflowHintRequiresSecondarySignal() {
  const tmp = createProject();
  try {
    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
      enabled_matchers: ["workflow_hint_ranking"],
      required_secondary_signals: ["multi_surface_files"],
    }, null, 2));

    const blocked = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal", "consolidat stewardshp alignment",
      "--json",
    ], tmp);
    assert(blocked.ok, "knowledge_resolver exits cleanly when fuzzy matching lacks secondary signals");
    const blockedJson = parseJson(blocked.stdout);
    assert(!!blockedJson, "knowledge_resolver emits valid JSON when fuzzy matching lacks secondary signals");
    assert(blockedJson?.recommended_entrypoint?.value !== "/steward", "route-changing fuzzy workflow hints do not fire without a secondary signal");

    mkdirSync(join(tmp, "docs"), { recursive: true });
    mkdirSync(join(tmp, "reports", "stewardship"), { recursive: true });
    writeFileSync(join(tmp, "docs", "intent.md"), "# Intent\n");
    writeFileSync(join(tmp, "reports", "stewardship", "notes.md"), "# Stewardship notes\n");

    const allowed = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal", "consolidat stewardshp alignment",
      "--file", "docs/intent.md",
      "--file", "reports/stewardship/notes.md",
      "--json",
    ], tmp);
    assert(allowed.ok, "knowledge_resolver exits cleanly when fuzzy matching has secondary signals");
    const allowedJson = parseJson(allowed.stdout);
    assert(!!allowedJson, "knowledge_resolver emits valid JSON when fuzzy matching has secondary signals");
    assert(allowedJson?.recommended_entrypoint?.value === "/steward", "route-changing fuzzy workflow hints can fire when deterministic secondary signals exist");
    assert((allowedJson?.relevant_workflows?.[0]?.matched_via || []).includes("fuzzy_workflow_hint"), "knowledge_resolver records fuzzy workflow hints explicitly");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTier2UsesPersonaAndAnnotationSignals() {
  const tmp = createProject();
  try {
    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Align cross-surface planner intent"], tmp);
    assert(created.ok, "bootstrap new succeeds for the tier2 fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
      search_policy: {
        prefer_early_stop: false,
      },
    }, null, 2));
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "reports", "stewardship"), { recursive: true });
    writeFileSync(join(tmp, "src", "module.js"), `// @planner:story US-123
export const value = 1;
`);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Align cross-surface planner intent

## Files To Modify
- src/module.js
`);
    writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      phase: "PLAN",
      items: [{ pack_id: "traceability", guidance: "Keep story coverage explicit." }],
    }, null, 2));
    writeFileSync(join(planDir, "persona_constraints.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      phase: "plan",
      constraints: [{ id: "PC-001", role: "traceability", severity: "HIGH", constraint: "Map stories explicitly.", story_refs: ["US-123"] }],
    }, null, 2));
    writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      gate: "explore-to-plan",
      summary: { fail: 0, warn: 1, info: 0 },
      findings: [{ analyzer: "[traceability] role-audit", severity: "warn", message: "Story linkage is thin.", _roleAudit: { role: "traceability", severity: "warn", story_refs: ["US-123"] } }],
    }, null, 2));
    writeFileSync(join(tmp, "reports", "stewardship", "semantic_map.json"), JSON.stringify({
      version: 1,
      areas: [{ id: "planner-intent", title: "Planner intent" }],
    }, null, 2));

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for the tier2 fixture");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for the tier2 fixture");
    assert(parsed?.search_tier === "tier2", "knowledge_resolver escalates to tier2 when early-stop is disabled");
    assert(parsed?.trace_profile?.deep_search_used === true, "knowledge_resolver records deep search when tier2 is used");
    assert((parsed?.trace_profile?.sources_consulted || []).includes("persona_guidance.json"), "knowledge_resolver records persona guidance as a tier2 source");
    assert((parsed?.trace_profile?.sources_consulted || []).includes("annotation_parser"), "knowledge_resolver records annotation parsing as a tier2 source");
    assert(parsed?.persona_signals?.present === true, "knowledge_resolver surfaces persona_signals when persona artifacts exist");
    assert((parsed?.persona_signals?.pack_ids || []).includes("traceability"), "knowledge_resolver summarizes persona pack ids");
    assert((parsed?.persona_signals?.story_refs || []).includes("US-123"), "knowledge_resolver summarizes persona-linked story refs");
    assert(parsed?.persona_signals?.findings?.severity_counts?.warn === 1, "knowledge_resolver preserves persona finding severities");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlannerCoreRouteSurfacesStories() {
  const tmp = createProject();
  try {
    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Refactor planner authority routing"], tmp);
    assert(created.ok, "bootstrap new succeeds for planner-core workflow discovery");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    seedStoryRegistry(tmp, [
      {
        id: "US-073",
        title: "Planner preflight routing and evidence contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/planner_preflight.mjs",
          ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
        ],
        doc_refs: [
          ".agent/workflows/advisor.md",
        ],
        test_refs: [
          ".agent/skills/iterative-planner/tests/test_planner_script_smoke.mjs",
        ],
      },
    ]);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Refactor planner authority routing

## Files To Modify
- .agent/workflows/advisor.md
- .agent/skills/iterative-planner/scripts/planner_preflight.mjs
- .agent/skills/iterative-planner/scripts/planner_findings.mjs
`);

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for planner-core workflow discovery");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for planner-core workflow discovery");
    assert(parsed?.project_manifesto?.present === true, "knowledge_resolver surfaces the planner manifesto for planner-core work");
    assert(parsed?.hard_policy_mode === "minimal_semantic_core", "knowledge_resolver surfaces the planner hard-policy mode");
    assert(typeof parsed?.north_star === "string" && parsed.north_star.includes("semantically valid next move"), "knowledge_resolver surfaces the planner north star");
    assert((parsed?.manifesto_alignment_signals || []).includes("semantic_risk_requires_strict_flow"), "knowledge_resolver records manifesto alignment for semantically strict planner-core work");
    assert((parsed?.manifesto_alignment_signals || []).includes("ontology_should_challenge_semantics"), "knowledge_resolver records ontology challenge alignment for planner-core work");
    assert(parsed?.recommended_entrypoint?.value === "/safe-change-power", "knowledge_resolver routes planner-core changes to /safe-change-power");
    assert((parsed?.related_stories || []).some((story) => story.id === "US-073"), "knowledge_resolver surfaces related stories for planner-core work");
    assert(parsed?.search_tier === "tier1", "knowledge_resolver uses tier1 for planner-core story-backed discovery");
    assert(parsed?.authority_profile?.phase === "explore", "knowledge_resolver exposes EXPLORE authority for repo-first planner-core work");
    assert(parsed?.proof_posture?.id === "discovery_widening", "knowledge_resolver exposes discovery proof posture for repo-first planner-core work");
    assert(typeof parsed?.phase_contract?.summary === "string" && parsed.phase_contract.summary.includes("EXPLORE"), "knowledge_resolver exposes a phase contract summary");
    assert((parsed?.symmetry_hunts || []).some((entry) => entry.id === "mistake:M-001"), "knowledge_resolver surfaces planner-core symmetry hunts from the mistake registry");
    assert(parsed?.audit_posture === "adversarial", "knowledge_resolver escalates planner-core symmetry hunts to adversarial posture");
    assert(parsed?.recommended_path === "targeted_red_team", "knowledge_resolver recommends targeted red-team for planner-core symmetry-hunt work");

    const preflight = run([
      ".agent/skills/iterative-planner/scripts/planner_preflight.mjs",
      "--json",
    ], tmp);
    assert(preflight.ok, "planner_preflight exits cleanly for planner-core workflow discovery");
    const preflightJson = parseJson(preflight.stdout);
    assert(!!preflightJson, "planner_preflight emits valid JSON for planner-core workflow discovery");
    assert(preflightJson?.knowledge_resolution?.recommended_entrypoint?.value === "/safe-change-power", "planner_preflight embeds the knowledge_resolver decision");
    assert(preflightJson?.workflow?.recommended === "continue-active-plan", "planner_preflight keeps active-plan workflow routing separate from the stronger knowledge-resolution entrypoint");
    assert(preflightJson?.authority_profile?.phase === "explore", "planner_preflight exposes EXPLORE authority for planner-core workflow discovery");
    assert(preflightJson?.audit_posture === "adversarial", "planner_preflight propagates adversarial posture from knowledge resolution");
    assert(preflightJson?.recommended_path === "targeted_red_team", "planner_preflight propagates the targeted red-team recommendation");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRedTeamArtifactBecomesSymmetryHunt() {
  const tmp = createProject();
  try {
    mkdirSync(join(tmp, "reports", "red_team_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "red_team_audit", "anti_patterns.json"), JSON.stringify({
      anti_patterns: [
        {
          id: "AP-001",
          label: "Structured hidden-risk drift across advisor surfaces",
          queries: ["authority_profile", "recommended_path"],
          scope: [".agent/workflows/", ".agent/skills/iterative-planner/scripts/"],
          confidence: "high",
          evidence_refs: ["F-201"],
          recommended_guard: "requires_red_team",
        },
      ],
    }, null, 2));

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal", "align advisor routing output",
      "--file", ".agent/workflows/advisor.md",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly when a red-team anti-pattern artifact is present");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON when a red-team anti-pattern artifact is present");
    assert(parsed?.anti_patterns_artifact?.present === true, "knowledge_resolver reports the anti-pattern artifact as present");
    assert((parsed?.symmetry_hunts || []).some((entry) => entry.id === "AP-001" && entry.source === "red_team_artifact"), "knowledge_resolver lifts anti_patterns.json entries into symmetry_hunts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioQuantImprovementUsesPersonaAlignedWorkflow() {
  const tmp = createProject();
  try {
    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Improve live-trading edge and validation strategy"], tmp);
    assert(created.ok, "bootstrap new succeeds for the quant improvement fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
      archetype: "quant",
      preferred_personas: ["quant", "assumptions_challenger"],
      search_policy: {
        prefer_early_stop: false,
      },
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Improve live-trading edge and validation strategy
`);
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
      constraints: [
        { id: "QU-C-001", role: "quant", severity: "HIGH", constraint: "Plan must include a dedicated leakage review step", story_refs: ["US-Q1"] },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      gate: "explore-to-plan",
      summary: { fail: 0, warn: 1, info: 0 },
      findings: [
        { analyzer: "[quant] role-audit", severity: "warn", message: "Validation strategy is thin.", _roleAudit: { role: "quant", severity: "warn", story_refs: ["US-Q1"] } },
      ],
    }, null, 2));

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for the quant improvement fixture");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for the quant improvement fixture");
    assert(parsed?.recommended_entrypoint?.value === "/sme-improvement", "knowledge_resolver routes quant upside work to /sme-improvement");
    assert(parsed?.search_tier === "tier2", "knowledge_resolver uses tier2 when quant improvement work needs persona signals");
    assert((parsed?.relevant_workflows?.[0]?.matched_via || []).includes("upside_persona_alignment"), "knowledge_resolver records upside persona alignment for /sme-improvement");
    assert((parsed?.relevant_workflows?.[0]?.preferred_personas || []).includes("quant"), "knowledge_resolver exposes workflow persona affinities");
    assert((parsed?.semantic_entities || []).some((entry) => entry.type === "project_archetype" && entry.id === "quant"), "knowledge_resolver preserves project archetype semantic entities");
    assert((parsed?.semantic_entities || []).some((entry) => entry.type === "preferred_persona" && entry.id === "quant"), "knowledge_resolver surfaces preferred personas as semantic entities");
    assert(parsed?.adversarial_profile?.profile_id === "quant_truthfulness", "knowledge_resolver synthesizes a quant-specific adversarial profile for quant work");
    assert((parsed?.suggested_attack_vectors || []).some((entry) => entry.id === "quant_temporal_leakage"), "knowledge_resolver suggests false-confidence attack vectors for quant work");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCourseGeneratorRoutesToSafeChangePower() {
  const tmp = createProject();
  try {
    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Improve course creation flow for learners and authors"], tmp);
    assert(created.ok, "bootstrap new succeeds for the course generator fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
      preferred_personas: ["ux_ui", "traceability"],
      search_policy: {
        prefer_early_stop: false,
      },
    }, null, 2));
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "templates"), { recursive: true });
    mkdirSync(join(tmp, "schema"), { recursive: true });
    writeFileSync(join(tmp, "src", "course_generator.mjs"), "export function buildCourse() { return []; }\n");
    writeFileSync(join(tmp, "templates", "course_outline.mustache"), "{{title}}\n");
    writeFileSync(join(tmp, "schema", "course_output.json"), "{\n  \"type\": \"object\"\n}\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Improve course creation flow for learners and authors

## Files To Modify
- src/course_generator.mjs
- templates/course_outline.mustache
- schema/course_output.json
`);
    writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({
      version: 1,
      primary_user: "Course creator",
      job_to_be_done: "Create a high-quality course without hidden output regressions",
      desired_outcomes: ["Reliable generated course structure", "Clear author workflow"],
      anti_goals: ["Broken generated outputs", "Confusing authoring flow"],
      constraints: [],
      deliverables: [
        {
          id: "course_flow",
          kind: "ui",
          name: "Course creation flow",
          purpose: "Help authors create courses quickly and safely",
          evidence_mode: "manual_observation",
        },
      ],
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
      constraints: [
        { id: "UX-C-001", role: "ux_ui", severity: "HIGH", constraint: "Plan must include a regression check for generated course outputs", story_refs: ["US-C1"] },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      gate: "explore-to-plan",
      summary: { fail: 0, warn: 1, info: 0 },
      findings: [
        { analyzer: "[ux_ui] role-audit", severity: "warn", message: "Course output regressions are easy to miss.", _roleAudit: { role: "ux_ui", severity: "warn", story_refs: ["US-C1"] } },
      ],
    }, null, 2));

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for the course generator fixture");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for the course generator fixture");
    assert(parsed?.recommended_entrypoint?.value === "/safe-change-power", "knowledge_resolver routes multi-surface course-generation work to /safe-change-power");
    assert((parsed?.relevant_workflows?.[0]?.matched_via || []).includes("user_visible_regression_risk"), "knowledge_resolver records user-visible regression risk for course-generation work");
    assert(parsed?.recommended_entrypoint?.value !== "/sme-improvement", "knowledge_resolver does not confuse course-generation regression work with upside-only SME work");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPluginConfigWorkRoutesToSafeChangePower() {
  const tmp = createProject();
  try {
    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Harden membership plugin role migration and config safety"], tmp);
    assert(created.ok, "bootstrap new succeeds for the plugin config fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
      archetype: "cms_plugin",
      preferred_personas: ["config_integrity", "traceability"],
      search_policy: {
        prefer_early_stop: false,
      },
    }, null, 2));
    mkdirSync(join(tmp, "plugin"), { recursive: true });
    mkdirSync(join(tmp, "config"), { recursive: true });
    mkdirSync(join(tmp, "migrations"), { recursive: true });
    writeFileSync(join(tmp, "plugin", "membership-plugin.php"), "<?php\n// plugin bootstrap\n");
    writeFileSync(join(tmp, "config", "roles.json"), "{\n  \"roles\": []\n}\n");
    writeFileSync(join(tmp, "migrations", "20260408_add_role.php"), "<?php\n// migration\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Harden membership plugin role migration and config safety

## Files To Modify
- plugin/membership-plugin.php
- config/roles.json
- migrations/20260408_add_role.php
`);
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
      constraints: [
        { id: "CI-C-001", role: "config_integrity", severity: "HIGH", constraint: "Plan must document new role config and migration compatibility", story_refs: ["US-P1"] },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      gate: "explore-to-plan",
      summary: { fail: 0, warn: 1, info: 0 },
      findings: [
        { analyzer: "[config_integrity] role-audit", severity: "warn", message: "Config migrations are regression-prone.", _roleAudit: { role: "config_integrity", severity: "warn", story_refs: ["US-P1"] } },
      ],
    }, null, 2));

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for the plugin config fixture");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for the plugin config fixture");
    assert(parsed?.recommended_entrypoint?.value === "/safe-change-power", "knowledge_resolver routes plugin config/migration work to /safe-change-power");
    assert((parsed?.relevant_workflows?.[0]?.matched_via || []).includes("config_migration_risk"), "knowledge_resolver records config_migration_risk for plugin config work");
    assert((parsed?.verification_obligation_synthesis?.obligations || []).some((entry) => entry.id === "migration_parity"), "knowledge_resolver synthesizes migration/parity obligations for config-migration work");
    assert((parsed?.verification_obligation_synthesis?.source_summary?.persona_signals || []).includes("pack:config_integrity"), "knowledge_resolver preserves persona-pack provenance in synthesized verification obligations");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioContentAutomationDriftRoutesToSteward() {
  const tmp = createProject();
  try {
    const bootstrapScript = ".agent/skills/iterative-planner/scripts/bootstrap.mjs";
    const created = run([bootstrapScript, "new", "Consolidate publishing drift across prompts, outputs, and automation docs"], tmp);
    assert(created.ok, "bootstrap new succeeds for the content automation fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();
    const planDir = join(tmp, "plans", planName);

    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({
      archetype: "content_automation",
      preferred_personas: ["traceability", "assumptions_challenger"],
      search_policy: {
        prefer_early_stop: false,
      },
    }, null, 2));
    mkdirSync(join(tmp, "prompts"), { recursive: true });
    mkdirSync(join(tmp, "automation"), { recursive: true });
    mkdirSync(join(tmp, "docs"), { recursive: true });
    mkdirSync(join(tmp, "reports", "publishing"), { recursive: true });
    writeFileSync(join(tmp, "prompts", "article_prompt.md"), "# Prompt\n");
    writeFileSync(join(tmp, "automation", "publisher.mjs"), "export async function publish() { return true; }\n");
    writeFileSync(join(tmp, "docs", "publishing.md"), "# Publishing flow\n");
    writeFileSync(join(tmp, "reports", "publishing", "output_summary.md"), "# Output summary\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Consolidate publishing drift across prompts, outputs, and automation docs

## Files To Modify
- prompts/article_prompt.md
- automation/publisher.mjs
- docs/publishing.md
- reports/publishing/output_summary.md
`);
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
      constraints: [
        { id: "TR-C-201", role: "traceability", severity: "HIGH", constraint: "Plan must reconcile docs, prompts, and published outputs", story_refs: ["US-A1"] },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-08T00:00:00.000Z",
      gate: "explore-to-plan",
      summary: { fail: 0, warn: 1, info: 0 },
      findings: [
        { analyzer: "[traceability] role-audit", severity: "warn", message: "Publishing surfaces are drifting apart.", _roleAudit: { role: "traceability", severity: "warn", story_refs: ["US-A1"] } },
      ],
    }, null, 2));

    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for the content automation fixture");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for the content automation fixture");
    assert(parsed?.recommended_entrypoint?.value === "/steward", "knowledge_resolver routes content automation drift to /steward");
    assert((parsed?.relevant_workflows?.[0]?.matched_via || []).includes("content_automation_drift"), "knowledge_resolver records content_automation_drift for publishing drift");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyPromptPrefersSafePlan() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal",
      "Think this through first and produce an implementation plan only, no code yet, for revising the planning workflow contract",
      "--file", ".agent/workflows/safe-plan.md",
      "--file", ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for an explicit planning-only prompt");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for an explicit planning-only prompt");
    assert(parsed?.recommended_entrypoint?.value === "/safe-plan", "knowledge_resolver prefers /safe-plan for explicit no-code planning prompts");
    assert((parsed?.recommended_entrypoint?.reason || "").includes("planning") || (parsed?.relevant_workflows?.[0]?.matched_via || []).includes("planning_only_goal"), "knowledge_resolver records the planning-only routing basis");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBroadIdeaIntakeRoutesToProgramManager() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal",
      "Turn broad Polymarket ideas, ontology checks, and user stories into Program Packet tickets and backlog intake",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for broad idea-to-ticket intake");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for broad idea-to-ticket intake");
    assert(parsed?.recommended_entrypoint?.value === "/program-manager", "knowledge_resolver routes broad idea/backlog ticket generation to /program-manager");
    const programManager = (parsed?.relevant_workflows || []).find((entry) => entry.id === "/program-manager");
    assert((programManager?.matched_via || []).includes("program_intake_goal"), "knowledge_resolver records program_intake_goal as the routing basis");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExistingTicketTraceabilityBlockerRoutesToRepair() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal",
      "TokenLab Program Packet tickets DeepSeek advisory needs_story gap reference but no linked stories and story_refs missing",
      "--file", ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--file", ".agent/skills/iterative-planner/config/workflow_registry.json",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for existing ticket traceability blocker");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for existing ticket traceability blocker");
    assert(parsed?.recommended_entrypoint?.value === "/ticket-traceability-repair", "knowledge_resolver routes needs_story/missing story_refs tickets to /ticket-traceability-repair");
    const repair = (parsed?.relevant_workflows || []).find((entry) => entry.id === "/ticket-traceability-repair");
    assert((repair?.matched_via || []).includes("ticket_traceability_repair_goal"), "knowledge_resolver records ticket_traceability_repair_goal as the routing basis");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMixedPlanAndImplementPromptStaysOnExecutionWorkflow() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/knowledge_resolver.mjs",
      "--goal",
      "Before you implement, plan the migration strategy and then build the fix for the planner workflow",
      "--file", ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
      "--file", ".agent/workflows/safe-change-power.md",
      "--json",
    ], tmp);
    assert(result.ok, "knowledge_resolver exits cleanly for mixed plan-and-implement wording");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "knowledge_resolver emits valid JSON for mixed plan-and-implement wording");
    assert(parsed?.recommended_entrypoint?.value === "/safe-change-power", "knowledge_resolver keeps mixed planner-core implementation prompts on /safe-change-power");
    assert(!(parsed?.relevant_workflows?.find((entry) => entry.id === "/safe-plan")?.matched_via || []).includes("planning_only_goal"), "knowledge_resolver no longer promotes /safe-plan from mixed implementation wording alone");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

scenarioKnownRecipeStopsAtTier0();
scenarioResponsiveUiObligationSurfacesAtTier1();
scenarioPlannerCoreMistakeSurfacesRelatedRetro();
scenarioWeakLexicalOverlapStaysAdvisory();
scenarioNoDeterministicMatchRequestsDraftGapCheck();
scenarioRecipeProposalGoalRoutesToRecipeDiscovery();
scenarioRepoFirstGoalIgnoresAmbientPlanContext();
scenarioFuzzyWorkflowHintRequiresSecondarySignal();
scenarioTier2UsesPersonaAndAnnotationSignals();
scenarioPlannerCoreRouteSurfacesStories();
scenarioRedTeamArtifactBecomesSymmetryHunt();
scenarioQuantImprovementUsesPersonaAlignedWorkflow();
scenarioCourseGeneratorRoutesToSafeChangePower();
scenarioPluginConfigWorkRoutesToSafeChangePower();
scenarioContentAutomationDriftRoutesToSteward();
scenarioPlanningOnlyPromptPrefersSafePlan();
scenarioBroadIdeaIntakeRoutesToProgramManager();
scenarioExistingTicketTraceabilityBlockerRoutesToRepair();
scenarioMixedPlanAndImplementPromptStaysOnExecutionWorkflow();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
