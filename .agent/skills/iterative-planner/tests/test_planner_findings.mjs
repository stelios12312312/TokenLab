#!/usr/bin/env node
// test_planner_findings.mjs — regression coverage for the deterministic findings script.

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";

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
  } catch (e) {
    return {
      ok: false,
      status: e.status ?? 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
  }
}

function parseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
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

function createProject() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-findings-"));
  cpSync(agentDir, join(tmp, ".agent"), { recursive: true });
  seedKnowledgeBase(tmp);
  return tmp;
}

function seedStoryRegistry(projectRoot, stories) {
  mkdirSync(join(projectRoot, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(projectRoot, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    updated: "2026-04-09T13:20:00.000Z",
    stories,
  }, null, 2));
}

function seedPlan(projectRoot, {
  planName = "plan_2026-04-09_findings",
  goal = "Planner findings fixture",
  planContent = null,
  state = null,
} = {}) {
  const planDir = join(projectRoot, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(projectRoot, "plans", ".current_plan"), `${planName}\n`);
  const nextState = state || createInitialStateJson(planName, goal, { projectRoot });
  writeStateJson(planDir, nextState);
  writeFileSync(join(planDir, "plan.md"), planContent || `# Plan

## Goal
${goal}

## Problem Statement
Planner findings fixture

## Files To Modify
- docs/example.md

## Steps
1. Keep the fixture deterministic.

## Success Criteria
1. The fixture can be read.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| The fixture can be read. | N/A — no story registry in this repo | Review | PASS |
`);
  writeFileSync(join(planDir, "verification.md"), "# Verification\n\n## Notes\nFixture only.\n");
  return { planDir, planName };
}

function seedTelemetry(planDir, events) {
  mkdirSync(join(planDir, "telemetry"), { recursive: true });
  writeFileSync(join(planDir, "telemetry", "events.jsonl"), `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function scenarioCmsGoalFindingsStayLightweight() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--goal", "Remove the Facebook CTA button from a WordPress landing page and redirect the contact link",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for CMS wording");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for CMS wording");
    assert(parsed?.task_profile_id === "website_ui_content", "planner_findings classifies CMS edits as website_ui_content");
    assert(parsed?.flow_mode === "lightweight", "planner_findings keeps CMS edits on the lightweight flow");
    assert(parsed?.evidence_mode === "manual_observation", "planner_findings uses manual observation for CMS edits");
    assert(parsed?.authority_profile?.phase === "explore", "planner_findings exposes EXPLORE authority for goal-only CMS work");
    assert(parsed?.proof_posture?.id === "discovery_widening", "planner_findings exposes discovery proof posture for goal-only CMS work");
    assert(typeof parsed?.phase_contract?.summary === "string" && parsed.phase_contract.summary.includes("EXPLORE"), "planner_findings exposes a human-readable phase contract");
    assert(parsed?.audit_posture === "normal", "planner_findings keeps low-risk CMS work in normal audit posture");
    assert(parsed?.recommended_path === "continue", "planner_findings keeps low-risk CMS work on continue");
    assert(["continue", "downgrade_to_lightweight"].includes(parsed?.anti_ritual?.recommended_action), "planner_findings keeps ordinary lightweight CMS work on a non-ritual anti-ritual path");
    assert(parsed?.anti_ritual?.hard_block_allowed === false, "planner_findings does not allow hard blocks for ordinary lightweight CMS work");
    assert(parsed?.project_manifesto?.present === true, "planner_findings surfaces the planner manifesto");
    assert(typeof parsed?.north_star === "string" && parsed.north_star.length > 20, "planner_findings includes the planner north star");
    assert((parsed?.manifesto_alignment_signals || []).includes("impact_over_ritual_prefers_lightweight"), "planner_findings records impact_over_ritual alignment for CMS work");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCmsMissingContentFindingsEscalateAndSurfaceActions() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--goal", "Investigate why a WordPress page looks empty and the custom post type content is missing",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for WordPress missing-content incidents");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for WordPress missing-content incidents");
    assert(parsed?.flow_mode === "full", "planner_findings routes WordPress missing-content incidents to the full flow");
    assert(parsed?.evidence_mode === "artifact_review", "planner_findings chooses artifact_review for WordPress missing-content incidents");
    assert(parsed?.workflow === "/safe-change-power", "planner_findings recommends /safe-change-power for WordPress missing-content incidents");
    assert(parsed?.cms_missing_content_diagnosis?.active === true, "planner_findings activates the CMS missing-content diagnosis detector");
    assert(parsed?.cms_missing_content_diagnosis?.warning_active === true, "planner_findings keeps the warning active when the diagnostic sequence is missing");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("cms_missing_content_diagnosis_gap") && entry.detail.includes("missing_turbulence_question")), "planner_findings flags the missing turbulence question");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("cms_missing_content_diagnosis_gap") && entry.detail.includes("missing_raw_html_dom_probe")), "planner_findings flags the missing raw HTML/DOM probe");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("cms_missing_content_diagnosis_gap") && entry.detail.includes("missing_render_vs_query_branch")), "planner_findings flags the missing render-vs-query branch logic");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("cms_missing_content_diagnosis_gap") && entry.detail.includes("missing_entity_preservation")), "planner_findings flags the missing entity-preservation rule");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "ask_cms_turbulence_question" && entry.reason.includes("Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?")), "planner_findings surfaces the exact turbulence question");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "probe_cms_raw_html_dom" && entry.reason.includes("Probe the exact broken URL via curl or browser/raw HTML before backend speculation.")), "planner_findings surfaces the raw HTML/DOM probe action");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "classify_cms_render_vs_query_branch" && entry.reason.includes("0 bytes")), "planner_findings surfaces the render-vs-query branch classification");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "preserve_cms_entities_until_db_proof" && entry.reason.includes("direct DB proof")), "planner_findings surfaces the entity-preservation action");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExplicitCmsMissingContentPlanClearsTheWarning() {
  const tmp = createProject();
  try {
    seedPlan(tmp, {
      goal: "Investigate why a WordPress page looks empty and the custom post type content is missing",
      planContent: `# Plan

## Goal
Investigate why a WordPress page looks empty and the custom post type content is missing

## Problem Statement
The diagnostic plan must establish turbulence, raw HTML truth, render-vs-query branching, and entity preservation before backend rewrites are considered.

## Files To Modify
- wp-content/themes/site/single-course.php

## Steps
1. Ask exactly "Are there any active migrations, recent plugin uninstalls, or major structural changes active on the site right now?"
2. Probe the exact broken URL via curl or browser/raw HTML before backend speculation.
3. If the expected content block is missing or 0 bytes, treat it as a frontend/theme/page-builder/render crash; if the HTML shell exists but query-driven collections are empty, backend/query investigation is allowed.
4. Do not migrate custom post types or rewrite sync scripts until direct DB proof shows the current structure is the failing node.

## Success Criteria
1. The root cause branch is identified without premature backend rewrites.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| The root cause branch is identified without premature backend rewrites. | N/A — no story registry in this repo | Review | PASS |
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly when the CMS missing-content plan already encodes the triage sequence");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON when the CMS missing-content plan already encodes the triage sequence");
    assert(parsed?.cms_missing_content_diagnosis?.active === true, "planner_findings still recognizes the CMS missing-content diagnosis surface");
    assert(parsed?.cms_missing_content_diagnosis?.warning_active === false, "planner_findings clears the CMS missing-content warning when the plan already encodes the sequence");
    assert(!(parsed?.repairable_variances || []).some((entry) => entry.kind.includes("cms_missing_content_diagnosis_gap")), "planner_findings clears CMS missing-content repairable variances when the plan already covers them");
    assert(!(parsed?.next_best_actions || []).some((entry) => entry.id === "ask_cms_turbulence_question"), "planner_findings does not repeat the turbulence action once it is already encoded");
    assert(!(parsed?.next_best_actions || []).some((entry) => entry.id === "probe_cms_raw_html_dom"), "planner_findings does not repeat the raw HTML/DOM probe once it is already encoded");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExecutionStepsAliasBecomesRepairableVariance() {
  const tmp = createProject();
  try {
    seedPlan(tmp, {
      goal: "Alias fixture",
      planContent: `# Plan

## Goal
Alias fixture

## Problem Statement
The plan should tolerate common section-heading aliases.

## Files To Modify
- docs/alias.md

## Execution Steps
1. Record the alias as repairable variance.

## Success Criteria
1. The alias is detected.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| The alias is detected. | N/A — no story registry in this repo | Review | PASS |
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for section alias variance");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for section alias variance");
    assert((parsed?.canonicalization_summary?.applied || []).some((entry) => entry.type === "section_heading" && entry.from === "Execution Steps" && entry.to === "Steps"), "planner_findings reports the Execution Steps alias correction");
    assert((parsed?.repairable_variances || []).some((entry) => entry.detail.includes("Execution Steps")), "planner_findings classifies the alias as repairable variance");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPoisonedHistoryPrefersRecovery() {
  const tmp = createProject();
  try {
    const baseState = createInitialStateJson("plan_2026-04-09_poison", "Poison recovery fixture", { projectRoot: tmp });
    baseState.state = "PLAN";
    baseState.transitions = [
      ...baseState.transitions,
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-003"] },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-003"] },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-003"] },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-003"] },
      { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLN-003"] },
    ];
    seedPlan(tmp, {
      planName: "plan_2026-04-09_poison",
      goal: "Remove CTA from WordPress page",
      state: baseState,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for poisoned history");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for poisoned history");
    assert(parsed?.active_plan?.poisoned === true, "planner_findings marks the active plan as poisoned");
    assert(parsed?.recommended_recovery?.mode === "recover_poison_then_lightweight", "planner_findings recommends lightweight poison recovery for simple CMS work");
    assert(parsed?.anti_ritual?.recommended_action === "recover_then_lightweight", "planner_findings anti-ritual contract prefers recovery before lightweight continuation for poisoned simple work");
    assert((parsed?.anti_ritual?.blocking_basis || []).includes("integrity_or_poison"), "planner_findings anti-ritual contract treats poisoned history as an integrity/recovery basis");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "run_recover_poison"), "planner_findings suggests recover-poison as the next action");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSemanticBlocksStayBlocking() {
  const tmp = createProject();
  try {
    const created = run([
      ".agent/skills/iterative-planner/scripts/bootstrap.mjs",
      "new",
      "Planner semantic blocker fixture",
    ], tmp);
    assert(created.ok, "bootstrap new succeeds for the semantic blocker fixture");
    const planName = readFileSync(join(tmp, "plans", ".current_plan"), "utf-8").trim();

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--plan", planName,
      "--gate", "plan-to-execute",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for plan-to-execute diagnostics");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for plan-to-execute diagnostics");
    assert((parsed?.semantic_blocks || []).length > 0, "planner_findings surfaces semantic blockers for an incomplete plan");
    assert((parsed?.semantic_blocks || []).some((entry) => entry.detail.includes("no_problem_statement") || entry.detail.includes("not_approved")), "planner_findings includes a real transition guard blocker");
    assert(parsed?.authority_profile?.phase === "execute", "planner_findings uses the entered gate phase for plan-to-execute diagnostics");
    assert(parsed?.proof_posture?.id === "boundary_capture", "planner_findings exposes execute boundary proof posture for plan-to-execute diagnostics");
    assert(parsed?.recommended_recovery?.mode === "resolve_semantic_blocks", "planner_findings treats semantic blockers as a real recovery priority");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlaceholderStoryRegistryBecomesSemanticBlockForFullFlow() {
  const tmp = createProject();
  try {
    seedStoryRegistry(tmp, [
      {
        id: "US-000",
        title: "Placeholder story",
        priority: "LOW",
        status: "PLANNED",
      },
    ]);
    seedPlan(tmp, {
      goal: "Refactor planner transition diagnostics",
      planContent: `# Plan

## Goal
Refactor planner transition diagnostics

## Problem Statement
Planner-core work needs story-backed semantic coverage.

## Files To Modify
- .agent/skills/iterative-planner/scripts/transition.mjs

## Steps
1. Tighten deterministic diagnostics.

## Success Criteria
1. Planner-core diagnostics stay story-backed.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| Planner-core diagnostics stay story-backed. | US-000 | Review | PASS |
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for placeholder story registries");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for placeholder story registries");
    assert((parsed?.semantic_blocks || []).some((entry) => entry.kind.includes("story_registry_gap") && entry.detail.includes("placeholder_story_registry")), "planner_findings surfaces placeholder story registries as a semantic block for full-flow work");
    assert((parsed?.minimal_repair_set || []).some((entry) => entry.kind.includes("story_registry_bootstrap")), "planner_findings includes story bootstrap in the minimal repair set");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "run_story_bootstrap"), "planner_findings suggests /story-bootstrap when the story registry is still a placeholder");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStructuralTokensRequireExplicitRendererHandlingAndVisualProof() {
  const tmp = createProject();
  try {
    seedPlan(tmp, {
      goal: "Show {{IMAGE: conceptual diagram}} markers in the LearnDash course review UI",
      planContent: `# Plan

## Goal
Show {{IMAGE: conceptual diagram}} markers in the LearnDash course review UI

## Problem Statement
The backend now emits {{IMAGE: conceptual diagram}} placeholders inside generated HTML and the review UI must surface them clearly to operators.

## Files To Modify
- src/review/ChangeReviewCard.tsx
- src/review/changeReview.css

## Steps
1. Update the prompt so generated HTML includes {{IMAGE: ...}} placeholders.
2. Preserve the surrounding HTML content.

## Success Criteria
1. Generated image markers are visible in the review UI.

## Verification Obligation Synthesis
- Repo/system context: Browser review surface that renders generated HTML for operator approval.
- Task shape: Structural token output enters a user-visible UI surface.
- Ontology signals: N/A — no ontology signals.
- Persona signals: N/A — no persona signals.
- System boundaries touched: Generated HTML output and the review card renderer.
- Derived verification obligations: Use browser-visible proof instead of trusting the raw HTML string alone.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Generated image markers are visible in the review UI. | N/A — no story registry in this repo | Browser review surface that renders generated HTML for operator approval | Review | Inspect the generated HTML payload for {{IMAGE}} markers | The raw HTML string includes the markers | The frontend rendering path remains unverified |
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for structural token rendering fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for structural token rendering fixtures");
    assert(parsed?.structural_token_rendering?.active === true, "planner_findings detects structural token output on browser review surfaces");
    assert((parsed?.verification_obligations || []).some((entry) => entry.id === "browser_ui"), "planner_findings keeps browser UI verification obligations for the rendered review surface");
    assert(parsed?.adversarial_profile?.profile_id === "ui_resilience", "planner_findings synthesizes a UI-specific adversarial profile for browser review surfaces");
    assert((parsed?.suggested_attack_vectors || []).some((entry) => entry.id === "ui_null_or_error_render"), "planner_findings suggests UI crash/error-state attack vectors for browser review surfaces");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("structural_token_renderer_gap") && entry.detail.includes("renderer_contract_missing")), "planner_findings flags missing explicit renderer handling for structural token output");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("structural_token_renderer_gap") && entry.detail.includes("visual_render_proof_missing")), "planner_findings flags missing browser-visible proof for structural token output");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "verify_structural_token_renderer"), "planner_findings suggests explicit renderer verification for structural token output");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExplicitStructuralTokenRendererPlanClearsTheFinding() {
  const tmp = createProject();
  try {
    seedPlan(tmp, {
      goal: "Render {{IMAGE: conceptual diagram}} markers in the review card",
      planContent: `# Plan

## Goal
Render {{IMAGE: conceptual diagram}} markers in the review card

## Problem Statement
The rendered review UI should intercept structural markers before they reach the raw HTML renderer.

## Files To Modify
- src/review/ChangeReviewCard.tsx

## Steps
1. Teach the frontend renderer to intercept {{IMAGE}} markers before dangerouslySetInnerHTML.
2. Convert the markers into styled review placeholders.

## Success Criteria
1. Generated image markers are visible in the review UI.

## Verification Obligation Synthesis
- Repo/system context: Browser review surface that renders generated HTML for operator approval.
- Task shape: Structural token output enters a user-visible UI surface.
- Ontology signals: N/A — no ontology signals.
- Persona signals: N/A — no persona signals.
- System boundaries touched: Generated HTML output and the review card renderer.
- Derived verification obligations: Use browser-visible proof instead of trusting the raw HTML string alone.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Generated image markers are visible in the review UI. | N/A — no story registry in this repo | Browser review surface that renders generated HTML for operator approval | browser journey | Run the rendered review flow in a browser and capture the visible placeholder state | The review card shows a styled placeholder where the {{IMAGE}} marker appears in content | Cross-browser styling differences remain unverified |
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly when the renderer contract is explicit");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON when the renderer contract is explicit");
    assert(parsed?.structural_token_rendering?.active === true, "planner_findings still recognizes the structural token surface");
    assert(!(parsed?.repairable_variances || []).some((entry) => entry.kind.includes("structural_token_renderer_gap")), "planner_findings clears the structural token renderer warning when the plan already covers renderer handling and browser proof");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioProofTelemetryFlagsMissingVisualEvidence() {
  const tmp = createProject();
  try {
    const { planDir, planName } = seedPlan(tmp, {
      goal: "Review the visible change-review card output",
      planContent: `# Plan

## Goal
Review the visible change-review card output

## Problem Statement
The browser review surface changed and should have browser-visible proof before close.

## Files To Modify
- src/review/ChangeReviewCard.tsx

## Steps
1. Update the review card surface.
`,
    });

    seedTelemetry(planDir, [
      {
        event: "surface_touched",
        timestamp: "2026-04-09T11:00:00.000Z",
        plan_id: planName,
        repo_root: tmp,
        surface: "browser_ui",
        file: "src/review/ChangeReviewCard.tsx",
        source: "post_tool_use",
        trust_level: "trusted",
      },
      {
        event: "proof_recorded",
        timestamp: "2026-04-09T11:00:10.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "unit_test",
        command: "npm test",
        source: "post_tool_use",
        trust_level: "trusted",
      },
    ]);

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for proof-telemetry visual-evidence fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for proof-telemetry visual-evidence fixtures");
    assert(parsed?.proof_telemetry?.mode === "present", "planner_findings surfaces proof telemetry summary when trusted events exist");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("proof_gap") && entry.detail.includes("missing_visual_evidence")), "planner_findings flags missing browser-visible proof from proof telemetry");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "record_visual_evidence"), "planner_findings recommends recording visual evidence for proof telemetry browser gaps");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioQuantProofTelemetryRequiresQuantValidation() {
  const tmp = createProject();
  try {
    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({ archetype: "quant" }, null, 2));
    const { planDir, planName } = seedPlan(tmp, {
      goal: "Adjust the ranking signal model for the next quant release",
      planContent: `# Plan

## Goal
Adjust the ranking signal model for the next quant release

## Problem Statement
Quant model changes need temporal split and leakage evidence before trust increases.

## Files To Modify
- models/ranking_signal.py

## Steps
1. Update the signal model.
`,
    });

    seedTelemetry(planDir, [
      {
        event: "surface_touched",
        timestamp: "2026-04-09T11:10:00.000Z",
        plan_id: planName,
        repo_root: tmp,
        surface: "quant_modeling",
        file: "models/ranking_signal.py",
        source: "post_tool_use",
        trust_level: "trusted",
      },
      {
        event: "proof_recorded",
        timestamp: "2026-04-09T11:10:10.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "unit_test",
        command: "pytest tests/test_ranking_signal.py",
        source: "post_tool_use",
        trust_level: "trusted",
      },
    ]);

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for quant proof-telemetry fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for quant proof-telemetry fixtures");
    assert(parsed?.proof_telemetry?.archetype === "quant", "planner_findings carries the quant archetype into proof telemetry");
    assert(parsed?.adversarial_profile?.profile_id === "quant_truthfulness", "planner_findings synthesizes a quant-specific adversarial profile for quant proof fixtures");
    assert((parsed?.suggested_attack_vectors || []).some((entry) => entry.id === "quant_temporal_leakage"), "planner_findings suggests false-confidence attack vectors for quant proof fixtures");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("proof_gap") && entry.detail.includes("missing_temporal_split_check")), "planner_findings flags missing temporal split evidence for quant model changes");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("proof_gap") && entry.detail.includes("missing_leakage_check")), "planner_findings flags missing leakage evidence for quant model changes");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "verify_quant_temporal_split"), "planner_findings recommends temporal split evidence for quant proof gaps");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioQuantProofTelemetryClearsWithRequiredEvidence() {
  const tmp = createProject();
  try {
    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({ archetype: "quant" }, null, 2));
    const { planDir, planName } = seedPlan(tmp, {
      goal: "Adjust the ranking signal model for the next quant release",
      planContent: `# Plan

## Goal
Adjust the ranking signal model for the next quant release

## Problem Statement
Quant model changes need temporal split and leakage evidence before trust increases.

## Files To Modify
- models/ranking_signal.py

## Steps
1. Update the signal model.
`,
    });

    // Leakage/temporal proofs are artifact-backed (SB-1 hardening): a bare
    // proof_recorded event is ignored unless its artifact_path passes the
    // leakage-proof check (split-evidence date ranges + folds + clean scan).
    // Provide a valid artifact so the proofs are trusted and the gap clears.
    mkdirSync(join(tmp, "reports", "quant"), { recursive: true });
    const leakageArtifactRel = "reports/quant/leakage_proof.json";
    writeFileSync(join(tmp, leakageArtifactRel), JSON.stringify({
      split_evidence: {
        train: { start: "2024-01-01", end: "2024-03-31" },
        validation: { start: "2024-04-02", end: "2024-05-31" },
        final_oos: { start: "2024-06-02", end: "2024-07-31" },
        embargo_days: 1,
        folds: [
          { train_end: "2024-03-31", test_start: "2024-04-02", test_end: "2024-04-30" },
          { train_end: "2024-05-31", test_start: "2024-06-02", test_end: "2024-07-31" },
        ],
        known_at_time_boundary: "All features are available before each fold cutoff.",
      },
      source_leakage_scan: { status: "pass", findings: [] },
    }, null, 2) + "\n");

    seedTelemetry(planDir, [
      {
        event: "surface_touched",
        timestamp: "2026-04-09T11:20:00.000Z",
        plan_id: planName,
        repo_root: tmp,
        surface: "quant_modeling",
        file: "models/ranking_signal.py",
        source: "post_tool_use",
        trust_level: "trusted",
      },
      {
        event: "proof_recorded",
        timestamp: "2026-04-09T11:20:05.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "temporal_split_check",
        command: "python scripts/walk_forward_check.py",
        artifact_path: leakageArtifactRel,
        source: "post_tool_use",
        trust_level: "trusted",
      },
      {
        event: "proof_recorded",
        timestamp: "2026-04-09T11:20:06.000Z",
        plan_id: planName,
        repo_root: tmp,
        proof_type: "leakage_check",
        command: "python scripts/leakage_check.py",
        artifact_path: leakageArtifactRel,
        source: "post_tool_use",
        trust_level: "trusted",
      },
    ]);

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly when quant proof telemetry already carries the required checks");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON when quant proof telemetry already carries the required checks");
    assert(!(parsed?.repairable_variances || []).some((entry) => entry.detail.includes("missing_temporal_split_check")), "planner_findings clears the temporal split warning when telemetry shows the proof");
    assert(!(parsed?.repairable_variances || []).some((entry) => entry.detail.includes("missing_leakage_check")), "planner_findings clears the leakage warning when telemetry shows the proof");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStaleHighRemediationBacklogBecomesSemanticBlock() {
  const tmp = createProject();
  try {
    seedPlan(tmp, {
      goal: "Harden TenderCopilot planner surfaces",
      planContent: `# Plan

## Goal
Harden TenderCopilot planner surfaces

## Problem Statement
Planner-core remediation should not ignore stale HIGH debt.

## Files To Modify
- .agent/skills/iterative-planner/scripts/planner_findings.mjs

## Steps
1. Surface stale backlog deterministically.
`,
    });
    mkdirSync(join(tmp, "reports"), { recursive: true });
    writeFileSync(join(tmp, "reports", "remediation_queue.md"), `# Unified Remediation Queue
Generated: 2026-03-20

| # | ID | Source | Severity | Title | File(s) | Depends On | Status |
|---|----|--------|----------|-------|---------|------------|--------|
| 1 | F-101 | red-team | HIGH | Auth bypass | src/auth.ts | — | PENDING |
| 2 | F-102 | red-team | HIGH | Silent parse | src/parsers.ts | — | PENDING |
| 3 | F-103 | red-team | HIGH | Missing schema guard | src/schema.ts | — | PENDING |
`);

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for stale HIGH remediation backlog fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for stale HIGH remediation backlog fixtures");
    assert((parsed?.semantic_blocks || []).some((entry) => entry.kind.includes("remediation_backlog_gap") && entry.detail.includes("stale_high_pending_remediation")), "planner_findings surfaces stale HIGH remediation backlog as a semantic block");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "review_stale_high_remediation"), "planner_findings recommends reviewing stale HIGH remediation backlog");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMissingAdjacencyOnSiblingRouteFilesBecomesRepairableVariance() {
  const tmp = createProject();
  try {
    mkdirSync(join(tmp, "src", "routes"), { recursive: true });
    writeFileSync(join(tmp, "src", "routes", "tenderRoutes.ts"), "export const tenderRoutes = [];\n");
    writeFileSync(join(tmp, "src", "routes", "fileRoutes.ts"), "export const fileRoutes = [];\n");
    writeFileSync(join(tmp, "src", "routes", "sectionRoutes.ts"), "export const sectionRoutes = [];\n");
    seedPlan(tmp, {
      goal: "Fix TenderCopilot route JSON parsing",
      planContent: `# Plan

## Goal
Fix TenderCopilot route JSON parsing

## Problem Statement
The parser fix should generalize across sibling route files.

## Files To Modify
- src/routes/tenderRoutes.ts

## Steps
1. Repair the broken Prisma JSON handling.
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for adjacency-gap fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for adjacency-gap fixtures");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("adjacency_gap") && entry.detail.includes("missing_structured_adjacency")), "planner_findings flags missing structured adjacency for sibling route work");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "populate_adjacency"), "planner_findings recommends populating adjacency coverage for sibling route work");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlannerCoreSymmetryHuntsEscalatePosture() {
  const tmp = createProject();
  try {
    seedRetroLedger(tmp, [
      {
        id: "R-2026-03-24-001",
        date: "2026-03-24",
        title: "Planner-core ripple-through learned the hard way",
        summary: "Planner-core contract changes must update code, docs, migration, and proof surfaces together.",
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
    seedStoryRegistry(tmp, [
      {
        id: "US-201",
        title: "Planner routing contract stays aligned across scripts and docs",
        priority: "HIGH",
        status: "NOT_IMPLEMENTED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/planner_preflight.mjs",
          ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
        ],
        doc_refs: [
          ".agent/workflows/advisor.md",
        ],
        test_refs: [],
      },
      {
        id: "US-202",
        title: "Planner hygiene triage stays aligned with routing output",
        priority: "MEDIUM",
        status: "NOT_IMPLEMENTED",
        code_refs: [
          ".agent/skills/iterative-planner/scripts/planner_hygiene.mjs",
        ],
        doc_refs: [
          ".agent/workflows/advisor.md",
        ],
        test_refs: [],
      },
    ]);
    seedPlan(tmp, {
      goal: "Refactor planner authority routing",
      planContent: `# Plan

## Goal
Refactor planner authority routing

## Problem Statement
Planner-core routing should stay aligned across scripts, workflow docs, and config.

## Files To Modify
- .agent/skills/iterative-planner/scripts/planner_preflight.mjs
- .agent/skills/iterative-planner/scripts/planner_findings.mjs
- .agent/workflows/advisor.md

## Steps
1. Keep authority_profile, audit_posture, and recommended_path aligned across planner surfaces.
`,
    });
    writeFileSync(join(tmp, "plans", "plan_2026-04-09_findings", "findings.md"), `# Findings

## Finding 1
Planner routing fields must stay aligned across the public triage and diagnostic surfaces.
If one script emits different posture or path guidance, the operator gets contradictory advice.
The work therefore spans planner_preflight, planner_findings, and advisor guidance together.

## Finding 2
Root Cause: planner-core shared surfaces drift when routing fields are added to one script but not the neighboring workflow or diagnostic surface.
That makes hidden-risk escalation inconsistent even when the underlying semantics are the same.
The refactor should make those surfaces converge instead of relying on memory.

## Adjacency
Adjacency: the change must stay aligned across planner_preflight.mjs, planner_findings.mjs, and .agent/workflows/advisor.md.
Neighboring workflow and config surfaces are in scope because the route fields are shared contract, not script-local implementation detail.
`);

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for planner-core symmetry-hunt fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for planner-core symmetry-hunt fixtures");
    assert((parsed?.symmetry_hunts || []).some((entry) => entry.id === "mistake:M-001"), "planner_findings surfaces structured planner-core symmetry hunts from the mistake registry");
    assert((parsed?.related_retros || []).some((entry) => entry.id === "R-2026-03-24-001"), "planner_findings surfaces the top related retro for the active planner-core mistake");
    assert(parsed?.knowledge_trust_summary?.trusted_count >= 1, "planner_findings surfaces the compact knowledge trust summary for planner-core work");
    assert((parsed?.knowledge_match_summary?.trusted_match_ids || []).includes("mistake:M-001"), "planner_findings exposes trusted knowledge match ids directly");
    assert(parsed?.audit_posture === "adversarial", "planner_findings escalates planner-core symmetry hunts to adversarial posture");
    assert(parsed?.recommended_path === "targeted_red_team", "planner_findings routes planner-core symmetry-hunt work to targeted red-team");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioWeakKnowledgeRetrievalSurfacesDraftPromotionAction() {
  const tmp = createProject();
  try {
    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--goal", "Brainstorm an internal memo about broad knowledge alignment",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly when deterministic knowledge retrieval is weak");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON when deterministic knowledge retrieval is weak");
    assert(parsed?.knowledge_trust_summary?.gap_check_needed === true, "planner_findings surfaces gap_check_needed in the compact knowledge trust summary");
    assert(parsed?.draft_promotion_contract?.review_surface?.relative_path === "plans/knowledge/draft_candidates.review.json", "planner_findings surfaces the reviewed draft-candidate review surface");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "review_draft_knowledge_candidates" && (entry.command || "").includes("--draft-candidates")), "planner_findings surfaces the reviewed-draft promotion action when trusted retrieval is weak");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioDomainChecklistPlaceholderBecomesRepairableVariance() {
  const tmp = createProject();
  try {
    writeFileSync(join(tmp, "planner.discovery.json"), JSON.stringify({ archetype: "workflow_automation" }, null, 2));
    seedPlan(tmp, {
      goal: "Harden TenderCopilot workflow reliability",
      planContent: `# Plan

## Goal
Harden TenderCopilot workflow reliability

## Problem Statement
Workflow automation plans should not keep generic domain checklist placeholders.

## Files To Modify
- src/workflows/tenderSync.ts

## Steps
1. Replace generic checklist content with TenderCopilot-specific probes.

## Domain Checklist
- Example: add domain checks here
- TODO: replace with real workflow probes later
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for domain-checklist placeholder fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for domain-checklist placeholder fixtures");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("domain_checklist_gap") && entry.detail.includes("placeholder_domain_checklist")), "planner_findings flags placeholder domain checklist content for required archetypes");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "fill_domain_checklist"), "planner_findings recommends replacing placeholder domain checklist content");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMissingMutuallyExclusiveFactsBecomesRepairableVariance() {
  const tmp = createProject();
  try {
    mkdirSync(join(tmp, "src", "config"), { recursive: true });
    writeFileSync(join(tmp, "src", "config", "runtime.ts"), "export const runtimeMode = process.env.LLM_MODE;\n");
    seedPlan(tmp, {
      goal: "Keep mock mode and provider selection aligned",
      planContent: `# Plan

## Goal
Keep mock mode and provider selection aligned

## Problem Statement
Config flag changes should declare contradictory runtime modes explicitly.

## Files To Modify
- src/config/runtime.ts

## Steps
1. Update LLM_MODE and provider selection behavior.
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for mutually-exclusive config fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for mutually-exclusive config fixtures");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("config_fact_gap") && entry.detail.includes("missing_mutually_exclusive_facts")), "planner_findings flags missing mutually exclusive config facts");
    assert(parsed?.semantic_substrate?.required === true, "planner_findings marks semantic substrate as required for config-flag plans");
    assert(parsed?.semantic_substrate?.scan_scope === "planned_plus_nearby", "planner_findings reports the planned_plus_nearby semantic scan scope for active plans");
    assert((parsed?.semantic_substrate?.blocking_gap_ids || []).includes("missing_mutually_exclusive_facts"), "planner_findings promotes missing mutually-exclusive facts into the semantic-substrate summary");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "declare_mutually_exclusive_facts"), "planner_findings recommends declaring mutually exclusive config facts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioScopedAnnotationRefreshIgnoresUnrelatedFixtures() {
  const tmp = createProject();
  try {
    mkdirSync(join(tmp, "src", "config"), { recursive: true });
    mkdirSync(join(tmp, "fixtures", "examples"), { recursive: true });
    writeFileSync(join(tmp, "src", "config", "runtime.ts"), "export const runtimeMode = process.env.LLM_MODE;\n");
    writeFileSync(join(tmp, "fixtures", "examples", "runtime_fixture.ts"), `// @planner:config_flag = llm_mode_mock
// @planner:mutually_exclusive = provider_openai
export const exampleRuntime = "fixture";
`);
    seedPlan(tmp, {
      goal: "Keep mock mode and provider selection aligned",
      planContent: `# Plan

## Goal
Keep mock mode and provider selection aligned

## Problem Statement
Config flag changes should declare contradictory runtime modes explicitly.

## Files To Modify
- src/config/runtime.ts

## Steps
1. Update LLM_MODE and provider selection behavior.
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly when unrelated fixtures carry mutually-exclusive annotations");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON when unrelated fixtures carry mutually-exclusive annotations");
    assert((parsed?.semantic_substrate?.blocking_gap_ids || []).includes("missing_mutually_exclusive_facts"), "planner_findings ignores unrelated fixture annotations when the active-plan scan is scoped");
    assert((parsed?.repairable_variances || []).some((entry) => entry.detail.includes("missing_mutually_exclusive_facts")), "planner_findings still reports the config gap when only unrelated fixtures declare the annotation");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMutuallyExclusiveAnnotationClearsTheFinding() {
  const tmp = createProject();
  try {
    mkdirSync(join(tmp, "src", "config"), { recursive: true });
    writeFileSync(join(tmp, "src", "config", "runtime.ts"), `// @planner:config_flag = llm_mode_mock
// @planner:mutually_exclusive = provider_openai
export const runtimeMode = process.env.LLM_MODE;
`);
    seedPlan(tmp, {
      goal: "Keep mock mode and provider selection aligned",
      planContent: `# Plan

## Goal
Keep mock mode and provider selection aligned

## Problem Statement
Config flag changes should declare contradictory runtime modes explicitly.

## Files To Modify
- src/config/runtime.ts

## Steps
1. Update LLM_MODE and provider selection behavior.
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly when mutually-exclusive config facts already exist");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON when mutually-exclusive config facts already exist");
    assert(!(parsed?.repairable_variances || []).some((entry) => entry.detail.includes("missing_mutually_exclusive_facts")), "planner_findings clears the mutually-exclusive-facts warning when annotations exist");
    assert(parsed?.semantic_substrate?.satisfied === true, "planner_findings marks the semantic substrate as satisfied once mutually-exclusive facts exist");
    assert((parsed?.semantic_substrate?.blocking_gap_ids || []).length === 0, "planner_findings clears the semantic-substrate blocking gap once mutually-exclusive facts exist");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioGenericProviderWordingDoesNotTriggerConfigBlockers() {
  const tmp = createProject();
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "provider_client.ts"), "export const providerClient = true;\n");
    seedPlan(tmp, {
      goal: "Refactor payment provider client",
      planContent: `# Plan

## Goal
Refactor payment provider client

## Problem Statement
Generic provider wording alone should not imply special config safety semantics.

## Files To Modify
- src/provider_client.ts

## Steps
1. Simplify provider client internals.
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for generic provider wording fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for generic provider wording fixtures");
    assert(!(parsed?.repairable_variances || []).some((entry) => entry.detail.includes("missing_mutually_exclusive_facts")), "planner_findings does not flag mutually-exclusive config facts from generic provider wording alone");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("semantic_substrate_hint") && entry.detail.includes("weak_relevance_hint") && entry.detail.includes("config")), "planner_findings records generic provider wording as a weak config relevance hint instead of a blocker");
    assert(parsed?.semantic_substrate?.required === false, "planner_findings keeps semantic substrate not_required for generic provider wording without stronger config evidence");
    assert(parsed?.semantic_substrate?.relevance_evidence?.config === "weak", "planner_findings persists weak config relevance evidence for generic provider wording");
    assert((parsed?.semantic_substrate?.blocking_gap_ids || []).length === 0, "planner_findings keeps blocking semantic-substrate gaps empty for generic provider wording alone");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMissingStoryPostconditionsAndConflictsBecomeRepairableVariance() {
  const tmp = createProject();
  try {
    seedStoryRegistry(tmp, [
      {
        id: "US-101",
        title: "Approval wizard state should persist after navigation",
        priority: "HIGH",
        status: "NOT_IMPLEMENTED",
      },
      {
        id: "US-102",
        title: "Rejected tenders should not show a success toast",
        priority: "HIGH",
        status: "NOT_IMPLEMENTED",
      },
    ]);
    seedPlan(tmp, {
      goal: "Fix approval wizard state transitions after navigation",
      planContent: `# Plan

## Goal
Fix approval wizard state transitions after navigation

## Problem Statement
Stateful workflow stories should carry postconditions and conflict facts.

## Files To Modify
- src/flows/approvalFlow.ts

## Steps
1. Keep wizard state consistent after navigation.

## Success Criteria
1. Approval flow state stays consistent.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| Approval flow state stays consistent. | US-101 | Review | PASS |
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for missing story postcondition/conflict fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for missing story postcondition/conflict fixtures");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("story_semantic_gap") && entry.detail.includes("missing_story_postconditions")), "planner_findings flags missing story postconditions for stateful full-flow work");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("story_semantic_gap") && entry.detail.includes("missing_story_conflict_facts")), "planner_findings flags missing story conflict facts for stateful full-flow work");
    assert((parsed?.semantic_substrate?.blocking_gap_ids || []).includes("missing_story_postconditions"), "planner_findings promotes missing story postconditions into the semantic-substrate summary");
    assert((parsed?.semantic_substrate?.blocking_gap_ids || []).includes("missing_story_conflict_facts"), "planner_findings promotes missing story conflict facts into the semantic-substrate summary");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "add_story_postconditions"), "planner_findings recommends adding story postconditions");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "declare_story_conflicts"), "planner_findings recommends declaring story conflicts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioInvalidStoryRegistryBecomesSemanticBlock() {
  const tmp = createProject();
  try {
    seedStoryRegistry(tmp, [
      {
        id: "US-103",
        title: "Point-Level TrueSkill Model",
        priority: "HIGH",
        status: "draft",
      },
      {
        id: "US-104",
        title: "Evidence-complete story with no evidence",
        priority: "HIGH",
        status: "FULLY_COVERED",
      },
    ]);
    seedPlan(tmp, {
      goal: "Create a point-based TrueSkill system based on points won/lost instead of match outcomes",
      planContent: `# Plan

## Goal
Create a point-based TrueSkill system based on points won/lost instead of match outcomes

## Problem Statement
The planner should repair story registry state before trusting research guidance.

## Files To Modify
- src/point_trueskill.py

## Steps
1. Keep registry health visible.

## Success Criteria
1. Story repair is surfaced.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| Story repair is surfaced. | US-103 | Review | PASS |
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly when story registry health is invalid");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for invalid story registry fixtures");
    assert(parsed?.story_registry_health?.blocking === true, "planner_findings marks invalid story registry health as blocking");
    assert((parsed?.semantic_blocks || []).some((entry) => entry.kind === "story_registry_invalid" && entry.detail.includes("US-103")), "planner_findings adds a story_registry_invalid semantic block");
    assert((parsed?.minimal_repair_set || []).some((entry) => entry.kind === "story_registry_invalid"), "planner_findings adds story registry repair to the minimal repair set");
    assert((parsed?.next_best_actions || []).some((entry) => entry.id === "repair_story_registry"), "planner_findings recommends the story registry repair command");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBackendWorkflowFilesDoNotTriggerStorySemanticBlockers() {
  const tmp = createProject();
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "workflow_runner.ts"), "export const runWorkflow = true;\n");
    seedStoryRegistry(tmp, [
      {
        id: "US-101",
        title: "Planner workflow execution stays observable",
        priority: "HIGH",
        status: "NOT_IMPLEMENTED",
      },
    ]);
    seedPlan(tmp, {
      goal: "Refactor workflow runner logging",
      planContent: `# Plan

## Goal
Refactor workflow runner logging

## Problem Statement
Backend workflow plumbing should not be mistaken for a user-facing stateful flow.

## Files To Modify
- src/workflow_runner.ts

## Steps
1. Simplify workflow logging and runner internals.

## Success Criteria
1. Workflow logging remains correct.

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| Workflow logging remains correct. | US-101 | Review | PASS |
`,
    });

    const result = run([
      ".agent/skills/iterative-planner/scripts/planner_findings.mjs",
      "--json",
    ], tmp);
    assert(result.ok, "planner_findings exits cleanly for backend workflow fixtures");
    const parsed = parseJson(result.stdout);
    assert(!!parsed, "planner_findings emits valid JSON for backend workflow fixtures");
    assert(!(parsed?.repairable_variances || []).some((entry) => entry.detail.includes("missing_story_postconditions")), "planner_findings does not flag story postconditions for backend workflow files without stronger user-flow evidence");
    assert(!(parsed?.repairable_variances || []).some((entry) => entry.detail.includes("missing_story_conflict_facts")), "planner_findings does not flag story conflict facts for backend workflow files without stronger user-flow evidence");
    assert((parsed?.repairable_variances || []).some((entry) => entry.kind.includes("semantic_substrate_hint") && entry.detail.includes("weak_relevance_hint") && entry.detail.includes("story_semantics")), "planner_findings records backend workflow wording as a weak story-semantic hint instead of a blocker");
    assert(parsed?.semantic_substrate?.required === false, "planner_findings keeps semantic substrate not_required for backend workflow files without stronger story evidence");
    assert(parsed?.semantic_substrate?.relevance_evidence?.story_semantics === "weak", "planner_findings persists weak story-semantic relevance evidence for backend workflow files");
    assert((parsed?.semantic_substrate?.blocking_gap_ids || []).length === 0, "planner_findings keeps blocking semantic-substrate gaps empty for backend workflow files without stronger story evidence");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nPlanner Findings\n");

scenarioCmsGoalFindingsStayLightweight();
scenarioCmsMissingContentFindingsEscalateAndSurfaceActions();
scenarioExplicitCmsMissingContentPlanClearsTheWarning();
scenarioExecutionStepsAliasBecomesRepairableVariance();
scenarioPoisonedHistoryPrefersRecovery();
scenarioSemanticBlocksStayBlocking();
scenarioPlaceholderStoryRegistryBecomesSemanticBlockForFullFlow();
scenarioStructuralTokensRequireExplicitRendererHandlingAndVisualProof();
scenarioExplicitStructuralTokenRendererPlanClearsTheFinding();
scenarioProofTelemetryFlagsMissingVisualEvidence();
scenarioQuantProofTelemetryRequiresQuantValidation();
scenarioQuantProofTelemetryClearsWithRequiredEvidence();
scenarioStaleHighRemediationBacklogBecomesSemanticBlock();
scenarioMissingAdjacencyOnSiblingRouteFilesBecomesRepairableVariance();
scenarioDomainChecklistPlaceholderBecomesRepairableVariance();
scenarioMissingMutuallyExclusiveFactsBecomesRepairableVariance();
scenarioPlannerCoreSymmetryHuntsEscalatePosture();
scenarioWeakKnowledgeRetrievalSurfacesDraftPromotionAction();
scenarioScopedAnnotationRefreshIgnoresUnrelatedFixtures();
scenarioMutuallyExclusiveAnnotationClearsTheFinding();
scenarioGenericProviderWordingDoesNotTriggerConfigBlockers();
scenarioMissingStoryPostconditionsAndConflictsBecomeRepairableVariance();
scenarioInvalidStoryRegistryBecomesSemanticBlock();
scenarioBackendWorkflowFilesDoNotTriggerStorySemanticBlockers();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
