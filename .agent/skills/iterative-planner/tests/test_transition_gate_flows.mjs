#!/usr/bin/env node
// test_transition_gate_flows.mjs — Behavioral regression coverage for core
// transition and gate flows that were still missing direct test linkage.

import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  existsSync,
  chmodSync,
  rmSync,
  utimesSync,
} from "fs";
import { basename, join, resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { evaluateGateResults, mistakeHookTargetIntegrityResult } from "../scripts/verify_gate.mjs";
import { createHash } from "crypto";
import { deriveGateDecision, KB_SALT_HEX_LEN } from "../scripts/lib/determinism.mjs";
import { stampRunRecordPayload } from "../scripts/lib/run_record.mjs";
import { computePlanLearnedObligationsSignal } from "../scripts/lib/learned_obligations.mjs";
import { assessDegradedCoverage, loadDegradedCoverageCensus } from "../scripts/lib/degraded_coverage.mjs";
import { loadRules } from "../scripts/lib/fact_loader.mjs";
import { GateContractError, normalizeGateResults, normalizeGateResultsForTransition } from "../scripts/lib/gate_verdict.mjs";
import { createSession } from "../scripts/lib/prolog.mjs";
import { serializeToFacts } from "../scripts/ontology_serializer.mjs";
import { summarizeLearnedObligationsSignal } from "../scripts/verify_gate.mjs";
import { analyzeVerificationMatrix } from "../scripts/lib/verification_matrix.mjs";
import { refreshPlanArtifacts } from "../scripts/lib/plan_refresh.mjs";
import { resolveGateInputSnapshot } from "../scripts/lib/gate_input_snapshot.mjs";
import { classifyRitualLintProcess, ritualLintTimeoutMs } from "../scripts/transition.mjs";
import { plannerSubprocessEnv } from "./helpers/env.mjs";
import {
  buildEmptyOntologyDocument,
  ONTOLOGY_ENTITY_CLASSES,
} from "../scripts/lib/ontology_schema.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const NODE = process.execPath;

const bootstrapScript = join(skillDir, "scripts", "bootstrap.mjs");
const transitionScript = join(skillDir, "scripts", "transition.mjs");
const verifyGateScript = join(skillDir, "scripts", "verify_gate.mjs");
const verificationMatrixScript = join(skillDir, "scripts", "verification_matrix.mjs");
const ruleEngineScript = join(skillDir, "scripts", "rule_engine.mjs");
const semanticDivergenceScript = join(skillDir, "scripts", "lib", "semantic_divergence.mjs");
const gateVerdictScript = join(skillDir, "scripts", "lib", "gate_verdict.mjs");
const semanticDivergencePatternFixture = join(testDir, "fixtures", "gate_sem_003_tesseract_pattern.json");
const realTelemetryFixtureDir = join(testDir, "fixtures", "real_telemetry");

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

function runNode(args, cwd, extraEnv = {}) {
  try {
    const stdout = execFileSync(NODE, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: plannerSubprocessEnv(extraEnv),
    });
    return {
      ok: true,
      status: 0,
      stdout,
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

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-gates-${name}-`));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readText(path) {
  return readFileSync(path, "utf-8");
}

function readKnowledgeBaseContent(projectRoot) {
  const kbDir = join(projectRoot, "plans", "knowledge");
  let kbContent = "";
  for (const file of ["index.md", "mistakes.md", "patterns.md", "gotchas.md"]) {
    kbContent += readText(join(kbDir, file));
  }
  return kbContent;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function getPlanDir(cwd) {
  const planName = readFileSync(join(cwd, "plans", ".current_plan"), "utf-8").trim();
  return { planName, planDir: join(cwd, "plans", planName) };
}

function seedPreplanningStoryBaseline(cwd) {
  const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
  if (existsSync(registryPath)) return;
  seedStoryRegistry(cwd, [
    {
      id: "US-PREPLANNING-DRAFT",
      title: "Draft pre-planning traceability baseline",
      priority: "LOW",
      status: "DRAFT",
      summary: "Draft-only baseline used by transition smoke fixtures before active story linkage is available.",
      tags: ["roles", "fail_on"],
    },
  ]);
}

function seedProject(cwd, goal) {
  symlinkSync(agentDir, join(cwd, ".agent"), "dir");
  writeFileSync(join(cwd, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger"],
    fail_on: ["CRITICAL"],
  }, null, 2) + "\n");

  const bootstrap = runNode([bootstrapScript, "new", "--force", goal], cwd, { PLANNER_SKIP_SELF_HEAL: "1" });
  assert(bootstrap.ok, `bootstrap new succeeds for "${goal}"`);

  const { planDir } = getPlanDir(cwd);
  seedPreplanningStoryBaseline(cwd);
  return planDir;
}

function seedCopiedPlannerProject(cwd, goal) {
  cpSync(agentDir, join(cwd, ".agent"), { recursive: true });
  writeFileSync(join(cwd, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger"],
    fail_on: ["CRITICAL"],
  }, null, 2) + "\n");

  const copiedBootstrapScript = join(cwd, ".agent", "skills", "iterative-planner", "scripts", "bootstrap.mjs");
  const copiedVerifyGateScript = join(cwd, ".agent", "skills", "iterative-planner", "scripts", "verify_gate.mjs");
  const bootstrap = runNode([copiedBootstrapScript, "new", "--force", goal], cwd, { PLANNER_SKIP_SELF_HEAL: "1" });
  assert(bootstrap.ok, `bootstrap new succeeds for copied planner fixture "${goal}"`);

  const { planDir } = getPlanDir(cwd);
  seedPreplanningStoryBaseline(cwd);
  return { planDir, copiedVerifyGateScript };
}

function writeExploreFindings(planDir, goalText, extra = "") {
  const fastTrackTag = extra.includes("[NO_FAST_TRACK]") ? "" : "[FAST_TRACK]\n";
  const cleanedExtra = extra.replace("[NO_FAST_TRACK]\n", "").replace("[NO_FAST_TRACK]", "");
  writeFileSync(join(planDir, "findings.md"), `# Findings
${fastTrackTag}${cleanedExtra}

## Finding 1
The ${goalText} flow needs a real planner-style fixture instead of helper-only tests.
This exercise is focused on transition and gate behavior rather than source inspection.
The affected scripts are transition.mjs and verify_gate.mjs.
That matters because the planner contract is enforced at runtime by real gate outputs, not by static examples in documentation.
If the fixture is too shallow, it teaches the test suite to pass the same kind of markdown the real gate should reject.

## Finding 2
Root Cause: earlier smoke coverage skipped the end-to-end transition and knowledge proof path.
That left critical planner behaviors looking healthy in aggregate without direct behavioral coverage.
This fixture closes that gap with real state and artifact transitions.
It also proves the first-run bootstrap case can satisfy knowledge-base proof requirements without hand-editing plan state.
The regression target is behavioral correctness for the gate, not just the existence of a happy-path helper.

## Finding 3
Adjacency: bootstrap.mjs seeds the plan, transition.mjs advances it, and verify_gate.mjs validates the artifacts.
The temp project includes plans/knowledge so the KB digest branch is active.
E8-1 removed approval and tamper nonce ceremonies from this lifecycle path.
Because several planner components participate in one transition, the test needs enough written context to resemble a real EXPLORE artifact.
That keeps the standard-depth gate focused on substantive planner reasoning instead of a markdown formatting shortcut.

## Assumption Ledger
- VERIFIED: The temp project contains a local .agent path so planner subprocesses behave like a real repo.
- VERIFIED: Explore-to-plan should advance state without writing approval, transition, or tamper nonce fields.
`);
}

function writeStructuredIndexedFindings(planDir) {
  writeFileSync(join(planDir, "findings.md"), `# Findings

[FAST_TRACK]

## Index
- F-001 — the planner is validating findings depth from actual indexed sections, not just index bullets
- F-002 — structural sections like Root Cause and Adjacency must not be counted as evidence-bearing findings
- F-003 — fast-track preambles should not create artificial shallow-section failures

## F-001: Indexed findings need self-contained analysis
The explore gate now needs substantive analysis in the indexed finding sections themselves, not just a populated index.
That keeps the quality bar attached to the actual evidence-bearing content instead of letting a summary block carry the whole file.
This regression fixture mirrors the format agents are most likely to write when they follow the updated docs.

## F-002: Structural headings must stay out of depth accounting
Root Cause, Adjacency, Assumption Ledger, and Story Candidates are mandatory planner structure, but they are not findings.
If the parser counts them as findings or shallow sections, the gate punishes compliance with its own template.
The JS gate and Prolog fact loader should both ignore those sections the same way.

## F-003: Fast-track preambles should be harmless metadata
The [FAST_TRACK] marker is an activation tag, not a finding section.
A valid file should not fail just because that tag appears before the first ## heading.
This fixture keeps the preamble present so both parsers have to tolerate the real user-facing shape.

## Root Cause
Root Cause: the earlier contract mixed three different ideas of what counted as a finding, so honest planner output could fail by formatting alone.

## Adjacency
Adjacency: this behavior spans the shared parser in plan utilities, the JS gate, the Prolog fact loader, and the user-facing planner docs.

## Assumption Ledger
- VERIFIED: fast-track mode is the intended path for this targeted explore regression.
- VERIFIED: structural headings belong in findings.md, but they are not depth-bearing indexed findings.

## Story Candidates
- N/A — regression fix for planner infrastructure rather than new feature discovery.
`);
}

function writeFindingsLedger(planDir, overrides = {}) {
  const ledger = {
    version: 1,
    fast_track: true,
    kb_digest_salt: null,
    findings: [
      {
        id: "F-001",
        title: "Structured findings drive gate truth",
        summary: "The rollout should let the EXPLORE gate read structured findings without relying on markdown heading parsing.",
        details: [
          "This protects the planner from formatting drift between docs, JS checks, and Prolog facts.",
          "The effective source should be the populated findings ledger when present.",
          "Legacy markdown must remain available as fallback during rollout.",
        ],
        story_refs: ["IP-001"],
        file_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
      },
      {
        id: "F-002",
        title: "Root cause must be explicit in the structured source",
        summary: "The same facts that satisfy the gate need to be available to the ontology and Prolog bridge.",
        details: [
          "A boolean presence check is not enough because the structured record should still carry real explanatory text.",
          "That keeps human review and machine checks aligned.",
        ],
        source_type: "persona_pack",
        source_id: "quant",
      },
      {
        id: "F-003",
        title: "Adjacency needs the same shared interpretation",
        summary: "Adjacency markers should be recorded structurally so the gate does not depend on markdown keyword scanning alone.",
        details: [
          "The rollout can still preserve findings.md as the readable surface.",
          "But the normalized structured record is the safer truth source when it is populated.",
        ],
        tags: ["infra"],
      },
    ],
    root_cause: {
      summary: "The planner historically split findings semantics across docs, verify_gate.mjs, and fact_loader.mjs.",
    },
    adjacency: {
      summary: "This change spans bootstrap, verify_gate, fact_loader, and ontology_serializer.",
    },
    assumptions: [
      { status: "VERIFIED", statement: "Structured findings can stay additive during rollout." },
    ],
    existing_capabilities: [],
    story_candidates: [],
    ...overrides,
  };

  writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
}

function writeIntentContract(planDir, overrides = {}) {
  const contract = {
    version: 1,
    primary_user: "Portfolio analyst",
    job_to_be_done: "Review a deliverable and decide whether the strategy deserves deeper investigation",
    desired_outcomes: [
      "Surface whether the output is trustworthy enough to act on",
    ],
    anti_goals: [
      "Do not treat empty or hollow deliverables as success",
    ],
    constraints: [
      "The deliverable must make false-green states visible",
    ],
    deliverables: [
      {
        id: "backtest_report",
        name: "Backtesting report",
        kind: "report",
        purpose: "Support analyst review without hiding degenerate output",
        quality_bars: ["Contains substantive interpretation and metrics"],
        required_sections: ["Backtest window", "Baseline comparison"],
        required_signals: ["trade count"],
        anti_goals: ["Empty report", "Metric-free PASS"],
        evidence_mode: "artifact_review",
      },
    ],
    ...overrides,
  };

  writeJson(join(planDir, "intent_contract.json"), contract);
}

function writePlanForExecute(planDir) {
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Problem Statement
Need end-to-end transition coverage for retired nonce ceremony and KB digest paths.

## Files To Modify
- .agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs
- reports/user_story_audit/story_registry.json

## Steps
1. Build a temp planner project with a local .agent symlink.
2. Run explore-to-plan in fast-track mode to exercise signed state updates.
3. Verify plan-to-execute gate behavior after ordinary plan evidence edits.

## Verification Strategy
Run targeted transition and gate regressions, then rerun invariant checks.

## Active Mistake Response
| Mistake | Guard | Planned handling | Planned evidence |
|---|---|---|---|
| M-001 | ripple_through | Keep transition, gate, and supporting planner surfaces aligned across the retired nonce and KB digest flow. | transition regression plus ripple-aware fixture review |
| M-001 | migration_smoke | Preserve the migration-facing contract while exercising planner-core transition behavior. | migration journey smoke stays part of the fixture contract |

## Semantic Upkeep Contract
- Profile: integration_backend_orchestration
- Ontology action: update_relationships
- Story action: revise_existing
- Validation bundle: integration
- Strictness mode: full
- Close blocker if skipped: Retired nonce ceremony and transition truth would drift from the exercised runtime behavior.

## Success Criteria
- Explore-to-plan generates KB digest proof without approval, transition, or tamper nonce fields.
- Plan-to-execute accepts ordinary plan evidence edits without a tamper approval ceremony.

## Fix Classification
Defense in depth

## Invariants
I-001 high_priority_untested
I-003 code_without_tests

## Pre-Mortem
If this test becomes flaky later, the most likely cause is drift between the temp fixture and the real planner user journey.

[KB_NOT_APPLICABLE: this targeted regression fixture is validating nonce flow and does not map to a specific prior KB entry]
`);
}

function writeRecentToolTrace(planDir, entries) {
  const artifactsDir = join(planDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(
    join(artifactsDir, "tool_trace.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
}

function semanticUpkeepContractBlock({
  profile = "integration_backend_orchestration",
  ontologyAction = "update_relationships",
  storyAction = "revise_existing",
  validationBundle = "integration",
  strictnessMode = "full",
  closeBlockerIfSkipped = "Workflow semantics and validation posture would drift from the implementation.",
} = {}) {
  return `## Semantic Upkeep Contract
- Profile: \`${profile}\`
- Ontology action: ${ontologyAction}
- Story action: ${storyAction}
- Validation bundle: ${validationBundle}
- Strictness mode: ${strictnessMode}
- Close blocker if skipped: ${closeBlockerIfSkipped}
`;
}

function seedStoryRegistry(tmp, stories) {
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    updated: "2026-04-14T10:00:00.000Z",
    stories,
  }, null, 2) + "\n");
}

function seedLocalDailyRunnerRecipe(tmp) {
  mkdirSync(join(tmp, "recipes", "daily-runner"), { recursive: true });
  writeJson(join(tmp, "recipes", "entity_registry.json"), {
    version: 1,
    entities: [{ id: "portfolio", title: "Portfolio" }],
  });
  writeJson(join(tmp, "recipes", "capability_registry.json"), {
    version: 1,
    capabilities: [{
      id: "daily_runner",
      title: "Daily Runner",
      description: "Runs deterministic daily portfolio workflow jobs.",
      scripts: [{ path: "scripts/daily_runner.mjs", purpose: "Run the daily portfolio workflow" }],
    }],
  });
  writeJson(join(tmp, "recipes", "daily-runner", "recipe.json"), {
    id: "daily-runner",
    title: "Daily Runner",
    capability_id: "daily_runner",
    entity_ids: ["portfolio"],
    required_params: ["portfolio_id"],
    scripts: [{ path: "scripts/daily_runner.mjs", purpose: "Run the daily portfolio workflow" }],
    runner: {
      type: "command",
      command: ["node", "scripts/daily_runner.mjs"],
      cwd: ".",
      defaults: {},
      dry_run_flags: ["--dry-run"],
      live_flags: [],
    },
  });
}

function buildPlanningOnlyPlan({
  goal = "Design a planning-only safe-plan handoff",
  storyId = "US-901",
  includeRetros = true,
  includeExactTestInventory = true,
  includeRedTeam = true,
  includeStoryAudit = true,
  includePersonaChallenges = true,
  includePersonaExpansion = true,
  retroSource = "retro_ledger.json -> R-2026-03-24-001",
  alignDeterministicAttackVectors = true,
} = {}) {
  const sections = [];

  if (includeRetros) {
    sections.push(`## Active Retros And Mistake Guards
| Source | Risk to this plan | Guard in plan | Future proof/test required |
|---|---|---|---|
| ${retroSource} | Planner-core planning changes can drift across docs, routing, and validator surfaces | Keep workflow doc, routing code, validator logic, and regression coverage in the same handoff | Add planner-preflight, knowledge-resolver, and planning-only gate regressions |
`);
  }

  if (includeExactTestInventory) {
    sections.push(`## Exact Test Inventory
| Test or test group | What it proves | Prevents |
|---|---|---|
| \`node .agent/skills/iterative-planner/tests/test_advise.mjs\` | Plan-only prompts route to \`/safe-plan\` in shared preflight | Silent fallback to \`/safe-change\` for no-code requests |
| \`node .agent/skills/iterative-planner/tests/ive/run.mjs --only advisor-task-intake-routing --json --no-manifest\` | Deterministic workflow routing preserves explicit no-code intent | Planner-core boosts overwhelming explicit no-code intent |
| \`node .agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs\` | \`verify_gate.mjs plan-to-execute --planning-only\` enforces the new section contract | Handing off under-specified plans without retro, audit, or persona coverage |
`);
  }

  if (includeRedTeam) {
    const redTeamRows = alignDeterministicAttackVectors
      ? `| workflow_false_success: the handoff could claim planning quality without grounding the audit in deterministic signals | Another operator could treat table presence as proof even though the retros, tests, and story audit are still generic | Require matched retro ids, concrete tests, and real story ids before the planning-only gate can pass |
| workflow_partial_failure_resume: the plan could validate one happy-path audit row while partial traceability gaps stay hidden | A future implementation might resume from the handoff and discover story or proof gaps only after work has started | Keep a targeted Story And Traceability Audit row plus the exact future test inventory in the validated plan |
| workflow_contract_or_migration_drift: the workflow docs and validator can drift apart while both still look plausible in isolation | Planner-core changes touch routing, docs, and gate behavior together, so a partial update can leave operators following the wrong contract | Keep workflow docs, validator logic, and regression coverage in the same handoff and verify them together |`
      : `| Generic planning risk that sounds careful but is not tied to deterministic attack vectors | Another implementer could hand-wave past the real workflow truthfulness risks | Add more careful review later |
| Vague concern about regressions | The plan might miss something somewhere | Add tests eventually |
| Story drift in some form | Traceability could be incomplete | Revisit during implementation |`;
    sections.push(`## Plan Red-Team Review
| Attack | Why this plan is vulnerable | Guard added to the plan |
|---|---|---|
${redTeamRows}
`);
  }

  if (includeStoryAudit) {
    sections.push(`## Story And Traceability Audit
| Story | Criteria touched | Planned proof | Gap/conflict | Required follow-up |
|---|---|---|---|---|
| ${storyId} | Planning-only validator blocks incomplete plan handoffs | Run \`verify_gate.mjs plan-to-execute --planning-only\` plus regression coverage in the transition gate suite | None currently — fixture story registry already points to a stable validation ref | Keep the validator test updated if section names or column names change |
`);
  }

  if (includePersonaChallenges) {
    sections.push(`## Persona Challenges
| Persona | Concern | Change made to plan |
|---|---|---|
| traceability | Planning-only work can look complete while leaving proof obligations implicit | Added the Story And Traceability Audit and Exact Test Inventory sections |
| assumptions_challenger | A red-team pass can become vague commentary without a fixed structure | Added a required Plan Red-Team Review table with three attacks and guards |
`);
  }

  if (includePersonaExpansion) {
    sections.push(`## Persona Expansion Opportunities
| Persona | Opportunity | Why it is not in current scope |
|---|---|---|
| ux_ui | Add a lightweight planning template for user-facing, manual-observation plans | This rollout is focused on the core planning-only contract, not new templates |
| wiring_auditor | Add deterministic command snippets for targeted story evidence collection | The immediate goal is to harden the handoff contract before expanding helper surfaces |
`);
  }

  return `# Plan

## Goal
${goal}

## Problem Statement
Planning-only work should still produce an execution-ready handoff with explicit retros, tests, traceability, red-team review, and persona pressure.

## Files To Modify
- .agent/workflows/safe-plan.md
- .agent/skills/iterative-planner/scripts/verify_gate.mjs
- .agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs

## Steps
1. Strengthen the planning-only workflow contract.
2. Add a planning-only validator path.
3. Add routing and regression coverage.

${semanticUpkeepContractBlock({
  validationBundle: "behavioral",
  closeBlockerIfSkipped: "Planning-only routing and validation semantics would drift from the public handoff contract.",
})}

## Verification Obligation Synthesis
- Repo/system context: Planner-core workflow, routing, and validator surfaces
- Task shape: Planning-only contract hardening
- Ontology signals: Story linkage to ${storyId}
- Persona signals: traceability and assumptions_challenger
- System boundaries touched: workflow docs, routing heuristics, read-only plan gate
- Derived verification obligations: Prove both routing preference and planning-only gate enforcement

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| The planning-only validator blocks incomplete handoffs. | ${storyId} | Planner-core workflow, routing, and read-only validator surfaces | Planning-only gate regression plus workflow/routing smoke coverage | Run \`verify_gate.mjs plan-to-execute --planning-only\` and the governed \`advisor-task-intake-routing\` suite against the targeted fixtures | Missing sections fail, the complete fixture passes, and plan-only prompts resolve to \`/safe-plan\` | Real future implementation still needs the code changes described by the handoff; this session proves the planning contract only |

## Success Criteria
1. The planning-only validator blocks incomplete handoffs.

## Fix Classification
Defense in depth

${sections.join("\n")}
`;
}

function prepareReflectCloseFixture(tmp, planDir, { planContent, verificationContent, verificationLedger = null, intentContract = null }) {
  writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), `# Patterns

## P-001 | Reflect close fixture
Close readiness is being exercised against structured close signals.
`);

  writeFileSync(join(planDir, "plan.md"), planContent);
  writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Prepared reflect-to-close fixture
`);
  writeFileSync(join(planDir, "verification.md"), verificationContent);

  if (verificationLedger) {
    writeFileSync(join(planDir, "verification_ledger.json"), JSON.stringify(verificationLedger, null, 2) + "\n");
  }
  if (intentContract) {
    writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify(intentContract, null, 2) + "\n");
  }

  const statePath = join(planDir, "state.json");
  const state = readJson(statePath);
  state.state = "REFLECT";
  writeJson(statePath, state);
}

function buildSatisfiedCloseSignals(overrides = {}) {
  const semanticSubstrate = {
    required: false,
    satisfied: true,
    status: "not_required",
    scan_scope: "planned_plus_nearby",
    scan_scope_used: "planned_plus_nearby",
    scope_degraded: false,
    scope_degraded_reason: null,
    relevant_domains: [],
    relevance_evidence: {
      config: "none",
      story_semantics: "none",
    },
    advisory_gap_ids: [],
    blocking_gap_ids: [],
    sources_present: {
      annotations: false,
      story_registry: false,
      persona_artifacts: false,
    },
    detail: "Semantic substrate not required for this plan shape",
    ...(overrides.semantic_substrate || {}),
  };

  return {
    last_refreshed_at: "2026-04-09T13:20:00.000Z",
    kb: {
      baseline_hash: null,
      current_hash: null,
      changed_since_plan_start: false,
      status: "no_new_learnings",
      satisfied: true,
      explicit_no_new_learnings: true,
      explicit_updated_tag: false,
      legacy_entries_detected: false,
    },
    planner_core: {
      required: false,
      migration_smoke_verified: false,
      planner_journey_verified: false,
      satisfied: true,
      proof_bundle_required: false,
      proof_bundle_verified: true,
      proof_bundle_required_commands: [],
      proof_bundle_missing_commands: [],
      verification_command: null,
      journey_verification_command: null,
    },
    test_evidence: {
      required: false,
      satisfied: true,
      status: "not_required",
      code_paths: [],
      test_paths: [],
      test_command_verified: false,
      waiver_reason: null,
      waiver_approved_by: null,
    },
    anti_recurrence: {
      required: false,
      satisfied: true,
      status: "not_required",
      trigger_terms: [],
      guard_types: [],
      waiver_reason: null,
      waiver_approved_by: null,
    },
    learned_obligations: {
      required: false,
      satisfied: true,
      status: "not_required",
      active_count: 0,
      satisfied_count: 0,
      active_obligations: [],
    },
    verification_obligation_synthesis: {
      required: false,
      satisfied: true,
      status: "not_required",
      active_count: 0,
      required_validation_levels: [],
      required_reporting_sections: ["Systems Exercised", "Remaining Unverified", "Verification Sufficiency"],
      obligations: [],
      systems_exercised_present: true,
      remaining_unverified_present: true,
      sufficiency_rationale_present: true,
      validation_status: {},
      detail: "Structured close signal: verification-obligation synthesis not required for this plan",
    },
    semantic_substrate: semanticSubstrate,
    intent_evidence: {
      required: false,
      satisfied: true,
      status: "not_required",
      contract_present: false,
      goal_requires_contract: false,
      required_deliverables: 0,
      satisfied_deliverables: 0,
      primary_user: null,
      job_to_be_done: null,
      detail: "Structured close signal: intent-driven deliverable evidence not required for this plan",
      missing_fields: [],
      missing_deliverables: [],
      deliverables: [],
    },
    ...overrides,
    semantic_substrate: semanticSubstrate,
  };
}

function writeStructuredCloseSignals(planDir, closeSignals) {
  const statePath = join(planDir, "state.json");
  const state = readJson(statePath);
  state.close_signals = closeSignals;
  writeJson(statePath, state);
}

function setPlanState(planDir, nextState, extra = {}) {
  const statePath = join(planDir, "state.json");
  const state = {
    ...readJson(statePath),
    ...extra,
    state: nextState,
  };
  writeJson(statePath, state);
}

function buildValidateClosePlan(filesToModify) {
  return `# Plan

## Problem Statement
Close-time drift maintenance should use the active plan scope before it considers ambient worktree changes.

## Files To Modify
${filesToModify.map((file) => `- ${file}`).join("\n")}

## Verification Strategy
Run the validate-to-close transition against a scoped fixture and inspect the enqueue behavior.

## Fix Classification
Defense in depth

[KB_NO_NEW_LEARNINGS]
`;
}

function buildValidateCloseVerification() {
  return `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Validate-to-close uses plan-scoped files for post-task drift maintenance. | Transition fixture | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Temp planner project seeded |
| Locally / unit tested | PASS | Validate-to-close transition fixture executed |
| Context-appropriate integration tested | PASS | Real transition.mjs path exercised |
| Audit reviewed | NOT REQUESTED | Fixture is regression-scoped |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- transition.mjs validate-to-close
- review_intake source ingestion path

## Remaining Unverified
None for this scoped regression fixture.

## Verification Sufficiency
The target behavior is transition close scoping after async maintenance removal, so a real validate-to-close transition with dirty ambient and planned worktree fixtures is sufficient.

## Regression Audit
Regression fixture covers that obsolete async maintenance queues are not recreated.

## Proof of Work

\`\`\`text
node .agent/skills/iterative-planner/scripts/transition.mjs validate-to-close
PASS
The transition exercised the real planner close path, preserved deterministic gate truth, and inspected async drift maintenance enqueue behavior after the gate passed.
\`\`\`
`;
}

function prepareValidateCloseTransitionFixture(tmp, planDir, { filesToModify, dirtyReadme = false }) {
  writeFileSync(join(planDir, "plan.md"), buildValidateClosePlan(filesToModify));
  writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Prepared validate-to-close scoped drift maintenance fixture
`);
  writeFileSync(join(planDir, "verification.md"), buildValidateCloseVerification());
  writeFileSync(join(planDir, "summary.md"), `# Summary

[KB_NO_NEW_LEARNINGS]
`);
  mkdirSync(join(tmp, "notes"), { recursive: true });
  writeFileSync(join(tmp, "notes", "local.txt"), "Local note fixture.\n");
  if (dirtyReadme) {
    writeFileSync(join(tmp, "README.md"), "Dirty ambient README fixture.\n");
  }
  const timestamp = new Date().toISOString();
  setPlanState(planDir, "VALIDATE", {
    transitions: [
      { from: "INIT", to: "EXPLORE", timestamp, gate_result: "SKIP", failure_codes: [], script_versions: {} },
      { from: "EXPLORE", to: "PLAN", timestamp, gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "PLAN", to: "EXECUTE", timestamp, gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "EXECUTE", to: "REFLECT", timestamp, gate_result: "PASS", failure_codes: [], script_versions: {} },
      { from: "REFLECT", to: "VALIDATE", timestamp, gate_result: "PASS", failure_codes: [], script_versions: {} },
    ],
  });
}

function writeExecuteToReflectArtifacts(planDir) {
  writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Prepared execute-to-reflect semantic substrate fixture
`);
  writeFileSync(join(planDir, "verification.md"), `# Verification

## Test Drift Scan
N/A — no tests.

## Parity
N/A — no parity-registry.md.
`);
  writeFileSync(join(planDir, "red_team_notes.md"), `## Vector 1: Null payload reaches the validator
Attack:
- Upstream sends null for the config payload.
Impact:
- Validation short-circuits and the gate records a false green.
Mitigation:
- Assert non-null input at the boundary and cover it with a regression check.

## Vector 2: Shared parser change misses a second consumer
Attack:
- One gate parser is updated but the checklist still expects the old shape.
Impact:
- Operators satisfy one surface and still fail the transition.
Mitigation:
- Reuse shared parsing logic and add a behavioral regression test for both surfaces.

## Vector 3: Proof-of-work gets summarized instead of pasted
Attack:
- The operator writes only a tidy prose summary of passing commands.
Impact:
- Close gates cannot distinguish verified output from optimistic narration.
Mitigation:
- Require fenced command output or an explicit UNVERIFIED marker.
`);
}

function buildPlannerCoreMistakePlan({ includeActiveMistakeResponse = false } = {}) {
  const activeMistakeResponse = includeActiveMistakeResponse
    ? `
## Active Mistake Response
| Mistake | Guard | Planned handling | Planned evidence |
|---|---|---|---|
| M-001 | ripple_through | Update scripts, docs, ontology, and migration surfaces together instead of treating the change as code-only. | ripple_check |
| M-001 | migration_smoke | Re-run the governed migration and transition paths after the planner-core change lands. | migration-bootstrap, transition-gate-flows |
`
    : "";

  return `# Plan

## Goal
Refactor planner migration ripple checks

## Problem Statement
Planner-core behavioral changes should fail early when the active ripple-through mistake is detected but its required guards are not declared explicitly.

## Context
[KB_APPLIED: M-001]

## Files To Modify
- .agent/skills/iterative-planner/scripts/migrate.mjs
- .agent/workflows/retro.md

## Steps
1. Keep planner-core ripple surfaces aligned.
2. Prove the migration path still behaves as expected.
3. Fail early if the active mistake contract is incomplete.

${semanticUpkeepContractBlock({
  validationBundle: "behavioral",
  closeBlockerIfSkipped: "Planner-core ripple-through would drift from the explicit gate contract.",
})}

## Verification Strategy
| Criterion | Check | Pass means |
|---|---|---|
| PLAN blocks missing active mistake guards. | Run transition.mjs plan-to-execute | The transition explains the missing planner-core guard contract. |

${activeMistakeResponse}## Success Criteria
1. PLAN blocks missing active mistake guards.

## Fix Classification
Defense in depth

## Pre-Mortem
If this fails later, the most likely cause is that planner-core ripple-through becomes advisory prose again instead of an explicit gate-owned contract.
`;
}

function writeActiveMistakeVerification(planDir, { includeGovernedMigrationHooks = false, markdownCodeCells = false } = {}) {
  const mistakeCell = markdownCodeCells ? "`M-001`" : "M-001";
  const rippleHookCell = markdownCodeCells ? "`ripple_check`" : "ripple_check";
  const migrationHookCell = markdownCodeCells ? "`migration-bootstrap`" : "migration-bootstrap";
  const transitionHookCell = markdownCodeCells ? "`transition-gate-flows`" : "transition-gate-flows";
  const migrationRows = includeGovernedMigrationHooks
    ? `\n| ${mistakeCell} | ${migrationHookCell} | PASS | governed migration-bootstrap suite passed after the planner-core change |\n| ${mistakeCell} | ${transitionHookCell} | PASS | governed transition-gate-flows suite passed after the planner-core change |`
    : "";
  writeFileSync(join(planDir, "verification.md"), `# Verification

## Criteria Verification
| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |
|---|--------------------------|--------|----------------|--------|----------|
| 1 | PLAN blocks missing active mistake guards. | Automated | \`node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute\` | PASS | Planner-core active-mistake contract reached EXECUTE with explicit guards |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Planner fixture prepared |
| Locally / unit tested | PASS | Planner-core transition fixture exercised locally |
| Context-appropriate integration tested | PENDING | Migration smoke still pending for this fixture |
| Audit reviewed | PENDING | Adversarial review deferred to the explicit red-team artifact |
| Live approved | NOT REQUESTED | Out of scope for this planner-core regression |

## Systems Exercised
- transition.mjs plan-to-execute
- transition.mjs execute-to-reflect

## Remaining Unverified
- migration-bootstrap and transition-gate-flows remain intentionally absent in this fixture so the reflect gate has to report the missing active mistake hooks.

## Verification Sufficiency
This regression targets the active mistake proof contract itself, so the reflect gate should fail until every required hook is explicitly proven.

## Test Drift Scan
N/A — no tests.

## Regression Audit
N/A — no baseline captured.

## Active Mistake Evidence
| Mistake | Hook | Status | Evidence |
|---|---|---|---|
| ${mistakeCell} | ${rippleHookCell} | PASS | \`ripple_check\` recorded the required planner-core surfaces for this fixture |${migrationRows}

## Parity
N/A — no parity-registry.md.

## Proof of Work
\`\`\`text
node transition.mjs plan-to-execute
PASS
\`\`\`
`);
}

function scenarioTransitionFlow() {
  const tmp = makeTemp("transition-flow");
  try {
    const planDir = seedProject(tmp, "transition gate flow smoke");
    assert(existsSync(join(planDir, "health_report.md")), "bootstrap health scan writes health_report.md");

    writePlanForExecute(planDir);
    writeExploreFindings(planDir, "transition gate flow smoke", "M-003: real user-journey coverage matters.\n");

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan exits cleanly in fast-track mode");
    assert(explore.stdout.includes("Phase Authority"), "transition explore-to-plan prints the phase authority section");
    assert(explore.stdout.includes("Entering phase: PLAN"), "transition explore-to-plan reports the entered PLAN authority phase");
    assert(explore.stdout.includes("Proof posture: Contract Enforcement"), "transition explore-to-plan reports the PLAN proof posture");

    const afterExplore = readJson(join(planDir, "state.json"));
    const decisions = readText(join(planDir, "decisions.md"));
    const findings = readText(join(planDir, "findings.md"));
    const kbDigestMatch = findings.match(/\[KB_DIGEST:([0-9a-f]+)\]/);
    assert(afterExplore.state === "PLAN", "explore-to-plan advances the signed state to PLAN");
    assert(typeof afterExplore.kb_digest_hash === "string" && afterExplore.kb_digest_hash.length === 32, "explore-to-plan stores kb_digest_hash");
    assert(!Object.prototype.hasOwnProperty.call(afterExplore, "approval_nonce_hash"), "explore-to-plan does not store approval_nonce_hash after E8-1");
    assert(!Object.prototype.hasOwnProperty.call(afterExplore, "transition_nonce"), "explore-to-plan does not store transition_nonce after E8-1");
    assert(!Object.prototype.hasOwnProperty.call(afterExplore, "tamper_fingerprint"), "explore-to-plan does not store tamper_fingerprint after E8-1");
    assert(!/\[APPROVED:[0-9a-f]+\]/.test(decisions), "explore-to-plan does not write approval markers after E8-1");
    assert(!existsSync(join(planDir, "approval_envelope.json")), "explore-to-plan does not materialize approval_envelope.json after E8-1");
    assert(!!kbDigestMatch && kbDigestMatch[1].length === KB_SALT_HEX_LEN, "explore-to-plan persists KB digest proof in findings.md when no ledger exists");
    if (kbDigestMatch) {
      const expectedDigest = createHash("sha256").update(kbDigestMatch[1] + readKnowledgeBaseContent(tmp)).digest("hex").slice(0, 32);
      assert(expectedDigest === afterExplore.kb_digest_hash, "persisted KB digest salt in findings.md matches the stored KB digest hash");
    }
    assert(existsSync(join(planDir, "persona_guidance.md")), "explore-to-plan writes persona_guidance.md");

    const progressPath = join(planDir, "progress.md");
    const originalProgress = readText(progressPath);
    writeFileSync(progressPath, originalProgress.trimEnd() + "\n- [x] Ordinary plan evidence edit after explore-to-plan.\n");
    const editedPreflight = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(editedPreflight.ok, "ordinary plan evidence edits do not trigger a retired tamper fingerprint blocker");
    assert(!editedPreflight.stdout.includes("GATE-TMP-002"), "plan-to-execute preflight no longer emits GATE-TMP-002");

    const execute = runNode([transitionScript, "plan-to-execute"], tmp);
    assert(execute.ok, "transition plan-to-execute exits cleanly without nonce ceremony");
    assert(execute.stdout.includes("Entering phase: EXECUTE"), "transition plan-to-execute reports the entered EXECUTE authority phase");
    assert(execute.stdout.includes("Proof posture: Boundary Capture"), "transition plan-to-execute reports the EXECUTE proof posture");

    const afterExecute = readJson(join(planDir, "state.json"));
    assert(afterExecute.state === "EXECUTE", "plan-to-execute advances the signed state to EXECUTE");
    const gateInputSnapshot = resolveGateInputSnapshot({ planDir, gate: "plan-to-execute" });
    assert(gateInputSnapshot.status === "valid", "actual successful plan-to-execute writes a valid gate-input snapshot");
    assert(gateInputSnapshot.manifest?.files?.some((entry) => entry.path === "state.json"), "gate-input snapshot manifest includes canonical state.json evidence");
    assert(readJson(join(gateInputSnapshot.path, "state.json")).state === "PLAN", "gate-input snapshot preserves the pre-transition PLAN state");
    const snapshotGateResults = evaluateGateResults(gateInputSnapshot.path, "plan-to-execute").results;
    assert(snapshotGateResults.every((entry) => entry.status !== "FAIL"), "current strict gate code accepts the verified bytes that the live transition evaluated");
    assert(!Object.prototype.hasOwnProperty.call(afterExecute, "consumed_nonces"), "plan-to-execute does not record consumed approval nonce hashes after E8-1");
    assert(!Object.prototype.hasOwnProperty.call(afterExecute, "tamper_fingerprint"), "plan-to-execute does not refresh tamper_fingerprint after E8-1");
    assert(existsSync(join(planDir, "persona_guidance.md")), "plan-to-execute refreshes persona_guidance.md");

    const staleGate = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!staleGate.ok, "verify_gate plan-to-execute still fails after the transition already advanced");
    assert(staleGate.stdout.includes("GATE-SRC-001"), "stale plan-to-execute delegates to the authoritative wrong-source blocker");
    assert(staleGate.stdout.includes("transition.mjs plan-to-execute --dry-run"), "stale plan-to-execute remains on the unified non-mutating preflight");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanToExecuteFailsClosedWhenSnapshotPreparationCannotReadInput() {
  const tmp = makeTemp("snapshot-prepare-failure");
  let unreadablePath = null;
  try {
    const planDir = seedProject(tmp, "fail closed when a gate-time snapshot input cannot be read");
    writePlanForExecute(planDir);
    writeExploreFindings(planDir, "fail closed when a gate-time snapshot input cannot be read");
    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "snapshot preparation failure fixture reaches PLAN");

    unreadablePath = join(planDir, "unreadable-snapshot-input.txt");
    writeFileSync(unreadablePath, "gate-time snapshot input\n");
    chmodSync(unreadablePath, 0o000);
    const execute = runNode([transitionScript, "plan-to-execute"], tmp);
    chmodSync(unreadablePath, 0o600);
    unreadablePath = null;

    assert(!execute.ok && execute.stdout.includes("Gate-time replay input capture"), "unreadable gate-time input blocks snapshot preparation");
    assert(execute.stdout.includes("GATE-RUN-001"), "snapshot preparation failure uses the stable runtime failure code");
    assert(readJson(join(planDir, "state.json")).state === "PLAN", "snapshot preparation failure does not advance canonical state");
    assert(resolveGateInputSnapshot({ planDir, gate: "plan-to-execute" }).status === "absent", "snapshot preparation failure publishes no replay authority");
  } finally {
    if (unreadablePath) {
      try { chmodSync(unreadablePath, 0o600); } catch { /* best effort */ }
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanToExecuteFailsClosedWhenSnapshotPersistenceConflicts() {
  const tmp = makeTemp("snapshot-persist-failure");
  try {
    const planDir = seedProject(tmp, "fail closed when gate-time snapshot publication conflicts");
    writePlanForExecute(planDir);
    writeExploreFindings(planDir, "fail closed when gate-time snapshot publication conflicts");
    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "snapshot persistence failure fixture reaches PLAN");

    const snapshotRoot = join(planDir, "artifacts", "gate_input_snapshots");
    const pointerPath = join(snapshotRoot, "latest_plan-to-execute.json");
    mkdirSync(snapshotRoot, { recursive: true });
    writeFileSync(pointerPath, "sentinel conflict\n");
    const execute = runNode([transitionScript, "plan-to-execute"], tmp);

    assert(!execute.ok && execute.stdout.includes("Gate-time replay input persistence"), "existing pointer conflict blocks snapshot persistence");
    assert(execute.stdout.includes("GATE-RUN-001"), "snapshot persistence conflict uses the stable runtime failure code");
    assert(readJson(join(planDir, "state.json")).state === "PLAN", "snapshot persistence conflict does not advance canonical state");
    assert(readText(pointerPath) === "sentinel conflict\n", "snapshot persistence conflict preserves the pre-existing pointer bytes");
    assert(readdirSync(snapshotRoot).length === 1, "snapshot persistence conflict leaves no partial snapshot directory");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReplanWarningUsesCanonicalGateTruth() {
  const tmp = makeTemp("canonical-replan-warning");
  try {
    const goal = "Verify canonical transition truth for repeated re-plan history";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);
    const statePath = join(planDir, "state.json");
    const state = readJson(statePath);
    state.transitions.push(
      ...Array.from({ length: 3 }, (_, index) => ({
        from: "PLAN",
        to: "re_plan",
        timestamp: `2026-07-15T08:00:0${index}.000Z`,
        gate_result: "PASS",
        failure_codes: [],
        script_versions: {},
      })),
      {
        from: "PLAN",
        to: "re_plan",
        timestamp: "2026-07-15T08:00:03.000Z",
        gate_result: "GREENISH",
        failure_codes: [],
        script_versions: {},
      },
      {
        from: "PLAN",
        to: null,
        timestamp: "2026-07-15T08:00:04.000Z",
        gate_result: "PASS",
        failure_codes: [],
        script_versions: {},
      },
    );
    writeJson(statePath, state);

    const transition = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(transition.ok, "canonical re-plan history fixture still advances explore-to-plan");
    assert(transition.stdout.includes("3 re-plan cycles detected"),
      "re-plan warning counts only explicit canonical PASS history and ignores unknown or missing targets");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapExploreWithoutFastTrack() {
  const tmp = makeTemp("bootstrap-explore");
  try {
    const planDir = seedProject(tmp, "bootstrap explore proof smoke");
    writeExploreFindings(
      planDir,
      "bootstrap explore proof smoke",
      `[NO_FAST_TRACK]
This first-run fixture intentionally uses the standard explore gate instead of the fast-track escape hatch.
The goal is to prove the bootstrap KB path no longer creates a false semantic blocker before the first digest hash exists.
These extra lines keep the preamble substantive so the standard-depth gate measures the KB bootstrap behavior rather than a shallow markdown preamble.
`
    );

    const explore = runNode([transitionScript, "explore-to-plan"], tmp);
    assert(explore.ok, "transition explore-to-plan exits cleanly on a first run without FAST_TRACK");

    const afterExplore = readJson(join(planDir, "state.json"));
    assert(afterExplore.state === "PLAN", "first-run explore-to-plan advances to PLAN without FAST_TRACK");
    assert(typeof afterExplore.kb_digest_hash === "string" && afterExplore.kb_digest_hash.length === 32, "first-run explore-to-plan still generates kb_digest_hash");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCodexSkipsExternalTraceWarnings() {
  const tmp = makeTemp("codex-trace");
  try {
    const planDir = seedProject(tmp, "codex trace handling smoke");
    writeExploreFindings(planDir, "codex trace handling smoke");

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, {
      _PLANNER_FAST_TRACK: "1",
      CODEX_THREAD_ID: "thread-fixture",
      CODEX_SANDBOX: "seatbelt",
      VSCODE_PID: "4242",
      TERM_PROGRAM: "vscode",
    });

    assert(explore.ok, "transition explore-to-plan exits cleanly in Codex mode without external trace hooks");
    assert(!explore.stdout.includes("GATE-TRC-009"), "Codex mode suppresses unsupported-IDE trace warnings");
    assert(!explore.stdout.includes("Trace: trace file"), "Codex mode skips missing tool trace file warnings");

    const afterExplore = readJson(join(planDir, "state.json"));
    assert(afterExplore.trace_summary?.ide === "codex", "Codex mode records codex trace summary metadata");
    assert(afterExplore.trace_summary?.status === "not_applicable", "Codex mode marks tool trace audit as not applicable");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStructuredIndexedFindingsStayAligned() {
  const tmp = makeTemp("structured-indexed-findings");
  try {
    const planDir = seedProject(tmp, "structured indexed findings gate alignment");
    writeStructuredIndexedFindings(planDir);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts self-contained indexed findings with structural headings");
    assert(!explore.stdout.includes("Prolog/JS divergence"), "transition explore-to-plan stays aligned between JS and Prolog for structured indexed findings");

    const afterExplore = readJson(join(planDir, "state.json"));
    assert(afterExplore.state === "PLAN", "structured indexed findings fixture advances to PLAN");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioJsonFirstFindingsLedger() {
  const tmp = makeTemp("json-findings-ledger");
  try {
    const planDir = seedProject(tmp, "json-first findings ledger smoke");
    writeFindingsLedger(planDir);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp);
    assert(explore.ok, "transition explore-to-plan accepts a populated findings_ledger.json");

    const afterExplore = readJson(join(planDir, "state.json"));
    const ledger = readJson(join(planDir, "findings_ledger.json"));
    const findings = readText(join(planDir, "findings.md"));
    assert(afterExplore.state === "PLAN", "json-first findings ledger fixture advances to PLAN");
    assert(typeof ledger.kb_digest_salt === "string" && ledger.kb_digest_salt.length === KB_SALT_HEX_LEN, "auto explore-to-plan persists KB digest salt into findings_ledger.json when the ledger exists");
    assert(findings.includes(`[KB_DIGEST:${ledger.kb_digest_salt}]`), "ledger-backed auto explore-to-plan syncs findings.md with the persisted KB digest salt");
    const expectedDigest = createHash("sha256").update(ledger.kb_digest_salt + readKnowledgeBaseContent(tmp)).digest("hex").slice(0, 32);
    assert(expectedDigest === afterExplore.kb_digest_hash, "ledger-backed persisted KB digest salt matches the stored KB digest hash");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioFindingsLedgerProjectionSyncs() {
  const tmp = makeTemp("json-findings-divergence");
  try {
    const planDir = seedProject(tmp, "structured findings divergence smoke");
    writeFindingsLedger(planDir);
    writeFileSync(join(planDir, "findings.md"), `# Findings

## Index
- F-001 — stale markdown summary

## F-001: Stale markdown summary
This markdown file was left behind during rollout and no longer matches the structured ledger.
`);

    const gate = runNode([verifyGateScript, "explore-to-plan"], tmp);
    assert(gate.ok, "verify_gate explore-to-plan still passes when the structured findings ledger is authoritative");
    const syncedFindings = readText(join(planDir, "findings.md"));
    assert(syncedFindings.includes("Structured findings drive gate truth"), "verify_gate refresh syncs findings.md from the authoritative ledger");
    assert(!syncedFindings.includes("stale markdown summary"), "verify_gate refresh replaces stale markdown drift with the synced readable projection");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExploreTransitionPrintsRepairPacket() {
  const tmp = makeTemp("explore-repair-packet");
  try {
    const planDir = seedProject(tmp, "repair packet smoke");
    writeFileSync(join(planDir, "findings.md"), `# Findings

## Index
- F-001: One incomplete finding.

## F-001 - One incomplete finding
The repair packet smoke goal has evidence, but this deliberately omits the required root cause, assumption ledger, and adjacency sections.
`);

    const gate = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(!gate.ok, "transition explore-to-plan blocks the repair packet fixture");
    assert(gate.stdout.includes("Repair Surface"), "blocked explore-to-plan transition prints the shared repair surface");
    assert(gate.stdout.includes("Primary artifact: plans/"), "repair packet names the target plan artifact");
    assert(gate.stdout.includes("## F-001 - Observed failure and direct evidence"), "repair packet includes findings section shape");
    assert(gate.stdout.includes("## Root Cause"), "repair packet includes root-cause section shape");
    assert(gate.stdout.includes("## Assumption Ledger"), "repair packet includes assumption-ledger section shape");
    assert(gate.stdout.includes("## Adjacency"), "repair packet includes adjacency section shape");
    assert(gate.stdout.includes("bootstrap.mjs fix-stuck --json"), "repair packet points to loop recovery diagnostics");
    assert(gate.stdout.includes("transition.mjs explore-to-plan"), "repair packet names the retry transition command");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioKbDigestGate() {
  const tmp = makeTemp("kb-digest");
  try {
    const planDir = seedProject(tmp, "kb digest proof smoke");
    const salt = "a".repeat(KB_SALT_HEX_LEN);
    const kbContent = readKnowledgeBaseContent(tmp);

    const state = readJson(join(planDir, "state.json"));
    state.kb_digest_hash = createHash("sha256").update(salt + kbContent).digest("hex").slice(0, 32);
    writeFileSync(join(planDir, "state.json"), JSON.stringify(state, null, 2) + "\n");

    writeExploreFindings(planDir, "kb digest proof smoke", `[KB_DIGEST:${salt}]\n`);

    const gate = runNode([verifyGateScript, "explore-to-plan"], tmp);
    assert(gate.ok, "verify_gate explore-to-plan accepts a correct KB digest proof");
    assert(gate.stdout.includes("KB digest salt verified"), "verify_gate explore-to-plan reports verified KB digest proof");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioKbDigestLedgerGate() {
  const tmp = makeTemp("kb-digest-ledger");
  try {
    const planDir = seedProject(tmp, "kb digest ledger proof smoke");
    const salt = "b".repeat(KB_SALT_HEX_LEN);
    const kbContent = readKnowledgeBaseContent(tmp);

    const state = readJson(join(planDir, "state.json"));
    state.kb_digest_hash = createHash("sha256").update(salt + kbContent).digest("hex").slice(0, 32);
    writeFileSync(join(planDir, "state.json"), JSON.stringify(state, null, 2) + "\n");

    writeFindingsLedger(planDir, { kb_digest_salt: salt });

    const gate = runNode([verifyGateScript, "explore-to-plan"], tmp);
    assert(gate.ok, "verify_gate explore-to-plan accepts a correct KB digest proof from findings_ledger.json");
    assert(gate.stdout.includes("KB digest salt verified"), "verify_gate reports verified KB digest proof from the structured ledger");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExploreGateRequiresIntentContract() {
  const tmp = makeTemp("intent-explore");
  try {
    const goal = "Generate a user-facing backtesting report for analysts";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    const missingIntent = runNode([verifyGateScript, "explore-to-plan"], tmp);
    assert(!missingIntent.ok, "verify_gate explore-to-plan blocks user-facing goals without a meaningful intent contract");
    assert(missingIntent.stdout.includes("intent_contract.json missing required intent fields"), "explore-to-plan explains which intent contract fields are missing");

    writeIntentContract(planDir);
    const withIntent = runNode([verifyGateScript, "explore-to-plan"], tmp);
    assert(withIntent.ok, "verify_gate explore-to-plan accepts a meaningful intent contract for user-facing goals");
    assert(withIntent.stdout.includes("intent_contract.json captures user, job, outcomes, and 1 required deliverable"), "explore-to-plan reports the captured intent contract");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExploreGateSkipsIntentContractForInternalMaintenanceGoals() {
  const tmp = makeTemp("intent-explore-internal");
  try {
    const goal = "Refresh planner workflow docs and summarize the migration path";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    const gate = runNode([verifyGateScript, "explore-to-plan"], tmp);
    assert(gate.ok, "verify_gate explore-to-plan allows internal maintenance goals to proceed without a populated intent contract");
    assert(gate.stdout.includes("Intent contract not required for this goal"), "explore-to-plan reports that internal maintenance intent capture is not required");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanGateRequiresDeliverableMapping() {
  const tmp = makeTemp("intent-plan");
  try {
    const goal = "Create a user-facing trading analysis workflow for analysts";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);
    writeIntentContract(planDir, {
      deliverables: [
        {
          id: "analyst_decision_packet",
          name: "Analyst decision packet",
          kind: "report",
          purpose: "Support analyst review without silent false-greens",
          quality_bars: ["Contains substantive findings and baseline comparison"],
          required_sections: ["Executive summary", "Baseline comparison"],
          anti_goals: ["Blank output"],
          evidence_mode: "artifact_review",
        },
      ],
    });

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the intent-aware user-facing workflow fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Problem Statement
The planner should fail PLAN when required deliverables are never mapped into the execution story.

## Files To Modify
- reports/analysis/workflow.md

## Steps
1. Capture the workflow requirements.
2. Record verification evidence.
3. Close without leaving mapping gaps.

${semanticUpkeepContractBlock({
  validationBundle: "integration",
  closeBlockerIfSkipped: "Required deliverables and workflow semantics would drift from the execution plan.",
})}

## Verification Strategy
Run the planner regression that checks deliverable mapping.

## Success Criteria
- The plan gate notices the missing deliverable mapping.

## Fix Classification
Defense in depth
`);

    const gate = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute blocks required deliverables that are not mapped into the plan");
    assert(gate.stdout.includes("Plan does not reference deliverable(s): analyst_decision_packet"), "plan-to-execute explains which deliverable mapping is missing");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanGateRequiresExplicitCriterionStoryLinkage() {
  const tmp = makeTemp("criterion-story-linkage");
  try {
    const goal = "Retrofit explicit criterion traceability";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-001",
          title: "Planner traceability gate",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/traceability.js"],
          test_refs: ["tests/traceability.test.js"],
          validation_refs: ["tests/validation_traceability.mjs"],
        },
      ],
    }, null, 2));

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the criterion/story traceability fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Retrofit explicit criterion traceability

## Problem Statement
Story-aware plans should fail early when success criteria never declare which story proves them.

## Files To Modify
- src/traceability.js

## Steps
1. Add the gate.
2. Update the docs.
3. Verify the regression coverage.

${semanticUpkeepContractBlock({
  validationBundle: "behavioral",
  closeBlockerIfSkipped: "Criterion-to-story traceability would drift from the plan semantics.",
})}

## Verification Strategy
| Criterion | Check | Pass means |
|---|---|---|
| The plan gate blocks missing story linkage. | Run verify_gate.mjs plan-to-execute | The gate explains the missing mapping |

## Success Criteria
1. The plan gate blocks missing story linkage.

## Fix Classification
Root-cause fix
`);

    const blocked = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!blocked.ok, "verify_gate plan-to-execute blocks success criteria without explicit story linkage when a story registry exists");
    assert(blocked.stdout.includes("Verification Strategy must include explicit 'Criterion' and 'Story linkage' columns"), "plan-to-execute explains the missing criterion/story linkage columns");
    assert(blocked.stdout.includes("suggested story ID(s): US-001"), "plan-to-execute suggests the closest story linkage candidate");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Retrofit explicit criterion traceability

## Problem Statement
Story-aware plans should fail early when success criteria never declare which story proves them.

## Files To Modify
- src/traceability.js

## Steps
1. Add the gate.
2. Update the docs.
3. Verify the regression coverage.

${semanticUpkeepContractBlock({
  validationBundle: "behavioral",
  closeBlockerIfSkipped: "Criterion-to-story traceability would drift from the plan semantics.",
})}

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| The plan gate blocks missing story linkage. | US-001 | Run verify_gate.mjs plan-to-execute | The gate accepts the explicit mapping |

## Success Criteria
1. The plan gate blocks missing story linkage.

## Fix Classification
Root-cause fix
`);

    const satisfied = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(satisfied.ok, "verify_gate plan-to-execute accepts success criteria with explicit story linkage");
    assert(satisfied.stdout.includes("1 success criterion row(s) map explicitly to story_registry.json entries"), "plan-to-execute reports satisfied criterion/story traceability");

    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-103",
          title: "Point-Level TrueSkill Model",
          priority: "HIGH",
          status: "draft",
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Retrofit explicit criterion traceability

## Problem Statement
Story-aware plans should fail early when success criteria point at invalid story rows.

## Files To Modify
- src/traceability.js

## Steps
1. Add the gate.
2. Update the docs.
3. Verify the regression coverage.

${semanticUpkeepContractBlock({
  validationBundle: "behavioral",
  closeBlockerIfSkipped: "Criterion-to-story traceability would drift from the plan semantics.",
})}

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| The plan gate blocks missing story linkage. | US-103 | Run verify_gate.mjs plan-to-execute | The gate rejects invalid story IDs |

## Success Criteria
1. The plan gate blocks missing story linkage.

## Fix Classification
Root-cause fix
`);

    const invalid = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!invalid.ok, "verify_gate plan-to-execute blocks story linkage to invalid registry statuses");
    assert(invalid.stdout.includes("US-103 invalid status 'draft'"), "plan-to-execute names the invalid story status");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStableCriterionIdsAndNotImplementedStoriesAreGeneralContracts() {
  const tmp = makeTemp("stable-criterion-ids");
  try {
    const goal = "Generalize success criterion traceability across report plans";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-201",
        title: "Report defaults remain compatible",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: ["src/report_defaults.js"],
        test_refs: ["tests/report_defaults.test.js"],
        validation_refs: ["tests/report_defaults.test.js"],
      },
      {
        id: "US-202",
        title: "Future report export gate",
        priority: "HIGH",
        status: "NOT_IMPLEMENTED",
        code_refs: [],
        test_refs: [],
        validation_refs: [],
      },
      {
        id: "US-203",
        title: "Report endpoint behavior",
        priority: "MEDIUM",
        status: "PARTIALLY_COVERED",
        code_refs: ["src/report_endpoint.js"],
        test_refs: ["tests/report_endpoint.test.js"],
        validation_refs: ["tests/report_endpoint.test.js"],
      },
    ]);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the stable criterion id fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
Cross-repo plans often keep compact Verification Strategy rows after editing richer Success Criteria tables.
The gate should accept stable criterion IDs rather than requiring exact prose duplication, and a future high-priority story should be allowed to remain untested until its implementation work actually happens.

## Files To Modify
- src/report_defaults.js
- src/report_endpoint.js

## Steps
1. Preserve report default behavior.
2. Plan the future export gate test ownership.
3. Keep endpoint behavior tied to its existing story.

${semanticUpkeepContractBlock({
  validationBundle: "behavioral",
  closeBlockerIfSkipped: "Report criteria would be detached from story evidence.",
})}

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| sc_1 defaults | US-201 | Run \`npm test -- report_defaults\` | Existing report defaults still pass |
| sc_2 future export | US-202 | Planned future test: \`tests/report_export_gate.test.js\` | The plan owns the future test without pretending it already exists |
| sc_3 endpoint | US-203 | Run \`npm test -- report_endpoint\` | Endpoint behavior remains covered |

## Success Criteria
| # | Criterion | Story linkage | Measurement | Pass Threshold |
|---|-----------|---------------|-------------|----------------|
| sc_1 | Report defaults survive the change | US-201 | \`npm test -- report_defaults\` | pass |
| sc_2 | Future report export gate has explicit test ownership | US-202 | planned test path is named | planned |
| sc_3 | Report endpoint behavior remains linked to coverage | US-203 | \`npm test -- report_endpoint\` | pass |

## Fix Classification
Defense in depth

[KB_NOT_APPLICABLE: this fixture proves generalized gate behavior for stable criterion IDs and future story states rather than a project-specific historical mistake]
`);

    const invariants = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    assert(invariants.ok, "rule_engine does not require tests for high-priority NOT_IMPLEMENTED stories");
    assert(!invariants.stdout.includes("high_priority_untested"), "rule_engine omits high_priority_untested for future unimplemented stories");

    const gate = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(gate.ok, "verify_gate plan-to-execute accepts stable sc_N criterion references with compact row labels");
    assert(gate.stdout.includes("3 success criterion row(s) map explicitly to story_registry.json entries"), "plan-to-execute maps all stable-id criteria to story IDs");

    const transition = runNode([transitionScript, "plan-to-execute"], tmp);
    assert(transition.ok, "transition plan-to-execute is not blocked by future NOT_IMPLEMENTED story test gaps");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanTransitionExplainsBrokenEvidenceChainAdvisory() {
  const tmp = makeTemp("broken-evidence-advisory");
  try {
    const goal = "Explain broken evidence chains during plan transition";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "README.md"), "# Evidence Advisory Fixture\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-001",
          title: "Planner evidence advisory",
          priority: "HIGH",
          status: "PARTIALLY_COVERED",
          code_refs: ["src/traceability.js"],
          test_refs: ["tests/traceability.test.js"],
          doc_refs: ["README.md"],
        },
      ],
    }, null, 2));

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the evidence-advisory fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Explain broken evidence chains during plan transition

## Problem Statement
Plan transitions should surface missing evidence hops in operator language before REFLECT.

## Context
[KB_APPLIED: M-021]

## Files To Modify
- src/traceability.js

## Steps
1. Improve invariant messaging.
2. Verify the advisory output.

${semanticUpkeepContractBlock({
  validationBundle: "behavioral",
  closeBlockerIfSkipped: "Evidence-chain diagnostics would drift from the planner transition semantics.",
})}

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| The transition explains the missing evidence hop. | US-001 | Run transition.mjs plan-to-execute | The advisory points to the missing validation_refs |

## Pre-Mortem
If this fails later, the most likely cause is that the advisory text drifts away from the real invariant semantics.

## Success Criteria
1. The transition explains the missing evidence hop.

## Fix Classification
Root-cause fix
`);

    const transition = runNode([transitionScript, "plan-to-execute"], tmp);
    assert(transition.ok, "transition plan-to-execute still succeeds when broken_evidence_chain is only an advisory");
    assert(transition.stdout.includes("broken_evidence_chain"), "plan-to-execute surfaces the broken_evidence_chain advisory name");
    assert(transition.stdout.includes("US-001 missing validation_refs in story_registry.json"), "plan-to-execute explains which story is missing validation_refs");
    assert(transition.stdout.includes("@planner: annotations do not replace story_registry evidence refs"), "plan-to-execute reminds operators that annotations do not satisfy registry evidence refs");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanTransitionBlocksMissingActiveMistakeGuard() {
  const tmp = makeTemp("active-mistake-plan-guard");
  try {
    const goal = "Refactor planner migration ripple checks";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the active-mistake plan-guard fixture");

    writeFileSync(join(planDir, "plan.md"), buildPlannerCoreMistakePlan({ includeActiveMistakeResponse: false }));

    const preflight = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!preflight.ok, "verify_gate plan-to-execute includes semantic invariant failures from the real transition");
    assert(preflight.stdout.includes("[GATE-SEM-002]"), "verify_gate surfaces the same story-invariant failure code before transition");
    assert(!preflight.stdout.includes("[GATE-SEM-003]"), "aligned active-mistake blocking does not create a false tamper alarm in delegated preflight");

    const blocked = runNode([transitionScript, "plan-to-execute"], tmp);
    assert(!blocked.ok, "transition plan-to-execute blocks active planner-core mistakes without declared guards");
    assert(blocked.stdout.includes("active_mistake_missing_declared_guard"), "plan-to-execute surfaces the missing active mistake guard invariant name");
    assert(blocked.stdout.includes("M-001"), "plan-to-execute identifies which active mistake is missing a declared guard");
    assert(!blocked.stdout.includes("[GATE-SEM-003]"), "aligned active-mistake blocking does not create a false tamper alarm in the actual transition");
    const receipt = readJson(join(planDir, "artifacts", "transition_receipts", "latest_plan-to-execute.json"));
    assert(receipt.failure_codes.includes("GATE-SEM-002") && !receipt.failure_codes.includes("GATE-SEM-003"), "actual receipt preserves the ordinary invariant block without a tamper code");
    assert(receipt.explained_divergences.length === 0, "aligned blocking does not fabricate a divergence explanation in the actual receipt");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReflectTransitionBlocksMissingActiveMistakeHookEvidence() {
  const tmp = makeTemp("active-mistake-reflect-hook");
  try {
    const goal = "Refactor planner migration ripple checks";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the active-mistake reflect fixture");

    writeFileSync(join(planDir, "plan.md"), buildPlannerCoreMistakePlan({ includeActiveMistakeResponse: true }));
    writeActiveMistakeVerification(planDir, { includeGovernedMigrationHooks: false });
    const statePath = join(planDir, "state.json");
    const state = readJson(statePath);
    state.state = "REFLECT";
    state.transitions.push(
      {
        from: "PLAN",
        to: "EXECUTE",
        timestamp: "2026-04-11T10:00:00Z",
        gate_result: "PASS",
        failure_codes: [],
        script_versions: {},
      },
      {
        from: "EXECUTE",
        to: "REFLECT",
        timestamp: "2026-04-11T10:05:00Z",
        gate_result: "PASS",
        failure_codes: [],
        script_versions: {},
      }
    );
    writeJson(statePath, state);

    const blocked = runNode([transitionScript, "reflect-to-validate"], tmp);
    assert(!blocked.ok, "transition reflect-to-validate blocks active planner-core mistakes without hook evidence");
    assert(blocked.stdout.includes("active_mistake_missing_verification_hook"), "reflect-to-validate surfaces the missing active mistake hook invariant name");
    assert(blocked.stdout.includes("M-001"), "reflect-to-validate identifies which active mistake is missing hook evidence");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReflectTransitionAcceptsMarkdownWrappedActiveMistakeHookEvidence() {
  const tmp = makeTemp("active-mistake-reflect-markdown-hook");
  try {
    const goal = "Refactor planner migration ripple checks";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the markdown-wrapped active-mistake fixture");

    writeFileSync(join(planDir, "plan.md"), buildPlannerCoreMistakePlan({ includeActiveMistakeResponse: true }));
    writeActiveMistakeVerification(planDir, { includeGovernedMigrationHooks: true, markdownCodeCells: true });
    const statePath = join(planDir, "state.json");
    const state = readJson(statePath);
    state.state = "REFLECT";
    state.transitions.push(
      {
        from: "PLAN",
        to: "EXECUTE",
        timestamp: "2026-04-11T10:00:00Z",
        gate_result: "PASS",
        failure_codes: [],
        script_versions: {},
      },
      {
        from: "EXECUTE",
        to: "REFLECT",
        timestamp: "2026-04-11T10:05:00Z",
        gate_result: "PASS",
        failure_codes: [],
        script_versions: {},
      }
    );
    writeJson(statePath, state);

    const gate = runNode([transitionScript, "reflect-to-validate"], tmp);
    assert(!gate.stdout.includes("active_mistake_missing_verification_hook"), "reflect-to-validate no longer reports missing hook evidence when hook cells are markdown-wrapped");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanGateRequiresContextSensitiveVerificationMatrix() {
  const tmp = makeTemp("verification-matrix");
  try {
    const goal = "Harden recipe orchestration verification planning";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      stories: [
        {
          id: "US-074",
          title: "Recipe runner and bootstrap workflow",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: [".agent/skills/iterative-planner/scripts/recipe_runner.mjs"],
          test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
          validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        },
      ],
    }, null, 2));

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the verification-matrix fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
Recipe orchestration work should not treat wrapper tests as proof that the real system behavior is validated.

## Files To Modify
- recipes/customer-sync/recipe.json
- scripts/customer_sync_wrapper.mjs
- tests/customer_sync_wrapper.test.mjs

## Steps
1. Add the verification contract.
2. Document the proof strategy.
3. Run the planner gate.

${semanticUpkeepContractBlock({
  validationBundle: "integration",
  closeBlockerIfSkipped: "Recipe boundary semantics would drift from the documented proof burden.",
})}

## Verification Obligation Synthesis
- Repo/system context: Recipe orchestration touching a connector dry-run path
- Task shape: Planner contract hardening for recipe validation
- Ontology signals: Story linkage to the recipe runner surface
- Persona signals: N/A — no persona signals for this fixture
- System boundaries touched: recipe runner, connector dry-run, audit artifact
- Derived verification obligations: Require a recipe-aware proof mode rather than wrapper-only testing

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| The planner blocks weak recipe verification plans. | US-074 | Run verify_gate.mjs plan-to-execute | The gate rejects weak planning. |

## Success Criteria
1. The planner blocks weak recipe verification plans.

## Fix Classification
Root-cause fix
`);

    const missingMatrix = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!missingMatrix.ok, "verify_gate plan-to-execute blocks recipe/orchestration plans that still use the generic verification table");
    assert(
      missingMatrix.stdout.includes("missing column(s)") &&
        missingMatrix.stdout.includes("Repo/system context") &&
        missingMatrix.stdout.includes("Required proof type"),
      "plan-to-execute explains the required matrix columns for recipe-style work"
    );

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
Recipe orchestration work should not treat wrapper tests as proof that the real system behavior is validated.

## Files To Modify
- recipes/customer-sync/recipe.json
- scripts/customer_sync_wrapper.mjs

## Steps
1. Add the verification contract.
2. Document the proof strategy.
3. Run the planner gate.

${semanticUpkeepContractBlock({
  validationBundle: "integration",
  closeBlockerIfSkipped: "Recipe boundary semantics would drift from the documented proof burden.",
})}

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| The planner blocks weak recipe verification plans. | US-074 | Recipe orchestration touching connector dry-runs and audit output | Connector dry-run plus orchestration smoke and audit output review | Run \`node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe customer-sync --execute --json\` in safe mode and inspect the emitted audit artifact | The runner executes the dry-run path, records exercised systems, and audit output shows no transport-level failures | Live operator approval remains out of scope for this plan |

## Success Criteria
1. The planner blocks weak recipe verification plans.

## Fix Classification
Root-cause fix
`);

    const missingSynthesis = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!missingSynthesis.ok, "verify_gate plan-to-execute blocks relevant plans that omit verification-obligation synthesis");
    assert(missingSynthesis.stdout.includes("Relevant plans must include a 'Verification Obligation Synthesis' section"), "plan-to-execute explains that relevant plans must document verification-obligation synthesis");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
Recipe orchestration work should not treat wrapper tests as proof that the real system behavior is validated.

## Files To Modify
- recipes/customer-sync/recipe.json
- scripts/customer_sync_wrapper.mjs

## Steps
1. Add the verification contract.
2. Document the proof strategy.
3. Run the planner gate.

${semanticUpkeepContractBlock({
  validationBundle: "integration",
  closeBlockerIfSkipped: "Recipe boundary semantics would drift from the documented proof burden.",
})}

## Verification Obligation Synthesis
- Repo/system context: Recipe orchestration touching connector dry-runs and audit output
- Task shape: Planner contract hardening for recipe validation
- Ontology signals: Story linkage to US-074 and a recipe runner surface
- Persona signals: N/A — no persona signals for this fixture
- System boundaries touched: recipe runner, connector dry-run, audit artifact
- Derived verification obligations: Require orchestration-aware dry-run and audit proof, not wrapper-only proof

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| The planner blocks weak recipe verification plans. | US-074 | Recipe orchestration touching connector dry-runs and audit output | Wrapper unit test | Run npm test customer_sync_wrapper | Wrapper tests pass locally | Connector dry-run not exercised yet |

## Success Criteria
1. The planner blocks weak recipe verification plans.

## Fix Classification
Root-cause fix
`);

    const weakProof = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!weakProof.ok, "verify_gate plan-to-execute blocks wrapper-only proof for recipe/orchestration context");
    assert(weakProof.stdout.includes("still relies on wrapper/unit proof only"), "plan-to-execute explains that wrapper/unit proof is too weak for the stated context");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
Recipe orchestration work should not treat wrapper tests as proof that the real system behavior is validated.

## Files To Modify
- recipes/customer-sync/recipe.json
- scripts/customer_sync_wrapper.mjs

## Steps
1. Add the verification contract.
2. Document the proof strategy.
3. Run the planner gate.

${semanticUpkeepContractBlock({
  validationBundle: "integration",
  closeBlockerIfSkipped: "Recipe boundary semantics would drift from the documented proof burden.",
})}

## Verification Obligation Synthesis
- Repo/system context: Recipe orchestration touching connector dry-runs and audit output
- Task shape: Planner contract hardening for recipe validation
- Ontology signals: Story linkage to US-074 and a recipe runner surface
- Persona signals: N/A — no persona signals for this fixture
- System boundaries touched: recipe runner, connector dry-run, audit artifact
- Derived verification obligations: Require orchestration-aware dry-run and audit proof, not wrapper-only proof

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| The planner blocks weak recipe verification plans. | US-074 | Recipe orchestration touching connector dry-runs and audit output | Connector dry-run plus orchestration smoke and audit output review | Run \`node .agent/skills/iterative-planner/scripts/recipe_runner.mjs --recipe customer-sync --execute --json\` in safe mode and inspect the emitted audit artifact | The runner executes the dry-run path, records exercised systems, and audit output shows no transport-level failures | Live operator approval remains out of scope for this plan |

## Success Criteria
1. The planner blocks weak recipe verification plans.

## Fix Classification
Root-cause fix
`);

    const satisfied = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(satisfied.ok, "verify_gate plan-to-execute accepts a context-appropriate verification matrix for recipe/orchestration work");
    assert(satisfied.stdout.includes("1 success criterion row(s) include context-sensitive verification proof planning"), "plan-to-execute reports the satisfied context-sensitive matrix");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanGateBlocksDuplicateScriptCreation() {
  const tmp = makeTemp("reuse-before-create");
  try {
    const goal = "Add a daily portfolio runner script";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);
    seedLocalDailyRunnerRecipe(tmp);
    seedStoryRegistry(tmp, [
      {
        id: "US-501",
        title: "Duplicate script creation is blocked before execute",
        priority: "HIGH",
        status: "NOT_IMPLEMENTED",
        code_refs: [],
        test_refs: [],
        validation_refs: [],
      },
    ]);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the reuse-before-create fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
The planner should stop a plan from creating a new script when an existing local recipe already owns the same script path and capability.

## Files To Modify
- scripts/daily_runner.mjs

## Steps
1. Propose the new script.
2. Let the PLAN gate compare it to local recipes.
3. Block before EXECUTE if the proposed script duplicates the existing recipe.

${semanticUpkeepContractBlock({
  validationBundle: "integration",
  closeBlockerIfSkipped: "Duplicate script creation could pass into EXECUTE despite a local recipe already owning the capability.",
})}

## Verification Obligation Synthesis
- Repo/system context: PLAN gate plus local recipe inventory
- Task shape: Recipe/orchestration duplicate creation blocker
- Ontology signals: Story linkage to US-501
- Persona signals: traceability and wiring_auditor require real gate proof
- System boundaries touched: plan file list, local recipe inventory, verify_gate plan-to-execute
- Derived verification obligations: Exercise the real plan-to-execute gate and require duplicate script proposals to fail before implementation.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-501 | PLAN gate plus local recipe inventory | proof:integration_smoke | Run \`verify_gate.mjs plan-to-execute\` on this fixture | Duplicate daily runner script proposal fails before EXECUTE | None for this gate fixture |

## Success Criteria
| Criterion | Story linkage | Pass means |
|---|---|---|
| sc_1 | US-501 | Duplicate script creation is blocked before EXECUTE. |

## KB Applied
- [KB_APPLIED] M-001: gate behavior must be proved through the real planner gate, not only helper tests.

## Fix Classification
Defense in depth

## Invariants
I-015 gate chain remains enforced by transition.mjs.

## Pre-Mortem
If this fails later, the most likely cause is that a new script path is treated as a file-list detail and never compared to recipe inventory.
`);

    const blocked = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!blocked.ok, "verify_gate plan-to-execute blocks duplicate script creation");
    assert(blocked.stdout.includes("GATE-PLN-033"), "duplicate script creation exposes GATE-PLN-033");
    assert(blocked.stdout.includes("Reuse-before-create blocked"), "duplicate script creation explains the reuse-before-create blocker");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanGateAllowsCompactLowRiskStaticVerificationObligation() {
  const tmp = makeTemp("compact-low-risk-static");
  try {
    const goal = "Build a static HTML landing page";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal, `## Assumption Ledger
- VERIFIED: The compact static fixture exercises only checked-in HTML/CSS artifacts and no runtime service boundary.
`);
    writeIntentContract(planDir, {
      primary_user: "Site visitor",
      job_to_be_done: "Review a static landing page without relying on runtime integrations",
      desired_outcomes: [
        "The static page artifact can be inspected against an explicit low-risk proof obligation",
      ],
      anti_goals: [
        "Do not treat a missing or unreviewed static artifact as complete",
      ],
      constraints: [
        "No API, backend, credential, migration, or data-loss boundary is part of this fixture",
      ],
      deliverables: [
        {
          id: "static_landing_page",
          name: "Static landing page artifact",
          kind: "static_ui",
          purpose: "Exercise compact verification for low-risk checked-in HTML/CSS artifacts",
          quality_bars: ["Names the reviewed files, proof action, pass signal, and residual browser gap"],
          required_sections: ["Low-risk verification obligation"],
          required_signals: ["static artifact review"],
          anti_goals: ["Runtime integration proof", "Placeholder artifact review"],
          evidence_mode: "artifact_review",
        },
      ],
    });
    seedStoryRegistry(tmp, [
      {
        id: "US-201",
        title: "Static landing page artifact",
        priority: "MEDIUM",
        status: "FULLY_COVERED",
        code_refs: ["site/landing.html", "site/styles.css"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the compact low-risk fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
Static HTML/CSS artifact work should not need a full integration-style matrix when one explicit proof obligation names the artifact, story, action, pass signal, and residual browser gap.

## Files To Modify
- site/landing.html
- site/styles.css

## Steps
1. Add the static artifact.
2. Record the compact proof obligation.
3. Run the planner gate and matrix linter.

${semanticUpkeepContractBlock({
  profile: "website_ui_content",
  validationBundle: "manual_ui",
  strictnessMode: "lightweight",
  closeBlockerIfSkipped: "The static artifact proof could collapse into an untracked visual assertion.",
})}

## Verification Obligation Synthesis
- Repo/system context: Static HTML/CSS artifact with no runtime integration
- Task shape: Static UI artifact
- Ontology signals: Story linkage to US-201
- Persona signals: N/A — no persona signals for this fixture
- System boundaries touched: static HTML/CSS render artifact only
- Derived verification obligations: One compact manual static artifact review obligation is sufficient; no integration, security, external-service, backend, migration, or data-loss boundary is touched.

## Verification Strategy
Low-risk verification obligation: For US-201, sc_1, and static_landing_page, manually review \`site/landing.html\` and \`site/styles.css\` as static artifacts, record the rendered layout observation, and name any remaining browser gap before close.

## Active Mistake Response
| Mistake | Guard | Planned handling | Planned evidence |
|---|---|---|---|
| M-UI-001 | mobile_responsiveness | Exercise a narrow viewport before close | verification ledger manual observation |

## Knowledge Application
[KB_NOT_APPLICABLE: compact static artifact fixture has no active KB mistake/pattern match]

## Success Criteria
1. The static page artifact has an explicit low-risk proof obligation.

## Fix Classification
Defense in depth
`);

    const gate = runNode([verifyGateScript, "plan-to-execute"], tmp, { PLANNER_VERBOSE_CHECKS: "1" });
    console.log(`[DEBUG] Temp directory for scenarioPlanGateAllowsCompactLowRiskStatic: ${tmp}`);
    if (!gate.ok) {
      console.log(`[DEBUG] Last Command Stdout:\n${gate.stdout}`);
      console.log(`[DEBUG] Last Command Stderr:\n${gate.stderr}`);
    }
    assert(gate.ok, "verify_gate plan-to-execute accepts a compact low-risk static obligation");
    assert(gate.stdout.includes("compact low-risk"), "plan-to-execute reports compact low-risk verification acceptance");

    const lint = runNode([verificationMatrixScript, "lint", "--plan", planDir, "--json"], tmp);
    assert(lint.ok, "verification_matrix lint accepts compact low-risk static obligation");
    const packet = JSON.parse(lint.stdout);
    assert(packet.compact_policy?.eligible === true, "verification matrix lint reports compact policy eligibility");
    assert(packet.compact_obligation?.text?.includes("site/landing.html"), "compact obligation text is surfaced in lint JSON");
  } finally {
    // Temporarily disabled rmSync for debugging
    // try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBootstrapScaffoldDefaultsCompactForLowRiskShapes() {
  const cases = [
    { name: "docs", goal: "Document release guide wording", expectedShape: "docs" },
    { name: "chore", goal: "Update account preference setting", expectedShape: "chore" },
    { name: "analysis", goal: "Review planner notes", expectedShape: "analysis" },
  ];

  for (const fixture of cases) {
    const tmp = makeTemp(`compact-scaffold-${fixture.name}`);
    try {
      const planDir = seedProject(tmp, fixture.goal);
      const planContent = readText(join(planDir, "plan.md"));
      const stateJson = readJson(join(planDir, "state.json"));

      assert(stateJson.plan_shape?.primary === fixture.expectedShape, `bootstrap detects ${fixture.expectedShape} shape for compact scaffold fixture`);
      assert(planContent.includes("Low-risk verification obligation:"), `bootstrap seeds compact low-risk obligation for ${fixture.expectedShape} scaffold`);
      assert(!planContent.includes("Baseline shape: Criterion | Story linkage"), `bootstrap omits full matrix scaffold for ${fixture.expectedShape} low-risk plan`);
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function scenarioBootstrapScaffoldPreservesFullMatrixForHighRiskShape() {
  const tmp = makeTemp("compact-scaffold-high-risk");
  try {
    const goal = "Build API connector dry-run for customer sync";
    const planDir = seedProject(tmp, goal);
    const planContent = readText(join(planDir, "plan.md"));
    const stateJson = readJson(join(planDir, "state.json"));

    assert(stateJson.plan_shape?.primary === "integration", "bootstrap detects integration shape for high-risk scaffold fixture");
    assert(!planContent.includes("Low-risk verification obligation:"), "bootstrap does not seed compact low-risk obligation for integration scaffold");
    assert(planContent.includes("Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified"), "bootstrap preserves full context-sensitive matrix scaffold for integration plan");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanGateRejectsCompactHighRiskIntegrationObligation() {
  const tmp = makeTemp("compact-high-risk-integration");
  try {
    const goal = "Build API connector dry-run for customer sync";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the compact high-risk fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
API connector work touches a real integration boundary, so compact low-risk wording must not bypass the full context-sensitive verification matrix.

## Files To Modify
- integrations/customer_connector.mjs

## Steps
1. Add the connector dry-run.
2. Attempt a compact-only proof.
3. Confirm the planner still requires the full matrix.

${semanticUpkeepContractBlock({
  validationBundle: "integration",
  closeBlockerIfSkipped: "Connector boundary semantics would be unproven.",
})}

## Verification Obligation Synthesis
- Repo/system context: API connector dry-run for customer sync
- Task shape: Integration boundary
- Ontology signals: N/A — no ontology signals
- Persona signals: wiring_auditor integration proof posture
- System boundaries touched: API connector, external customer system, transport dry-run
- Derived verification obligations: API/integration and backend/service proof must use a full matrix with dry-run or integration smoke evidence.

## Verification Strategy
Low-risk verification obligation: For sc_1, review the connector dry-run text and record any residual API uncertainty before close.

## Success Criteria
1. API connector compact-only proof is rejected.

## Fix Classification
Defense in depth
`);

    const gate = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute rejects compact-only proof for high-risk integration work");
    assert(
      gate.stdout.includes("Context-sensitive verification matrix") ||
        gate.stdout.includes("No verification matrix table found") ||
        gate.stdout.includes("full matrix"),
      "plan-to-execute explains that high-risk integration work still needs the full matrix"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerificationMatrixRecognizesProofIds() {
  const tmp = makeTemp("verification-proof-ids");
  try {
    const goal = "Improve quant model backtest with migration parity diagnostics";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-003",
        title: "Gate verification",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the proof-id matrix fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
What happened: observed behavior showed quant and migration proof rows were being judged by fragile prose matching instead of exact proof IDs. Quant and migration plans should be able to satisfy synthesized verification obligations with exact proof IDs while still naming the quant persona, target outcome, data source, odds snapshot as-of semantics, temporal leakage guard, and baseline controls. Candidate alpha hypothesis: stale injury-news odds create a temporary edge mechanism. Expected edge metric is positive CLV versus the closing-line benchmark. Falsification threshold: reject if CLV decays or the baseline control wins. Next experiment: run a liquidity-adjusted follow-up screen.

## Files To Modify
- models/ufc_model.py
- migrations/odds_parity.mjs

## Steps
1. Wire proof IDs into the matrix parser.
2. Run the gate and matrix linter.
3. Confirm quant/modeling and migration/parity obligations are covered.

${semanticUpkeepContractBlock({
  profile: "scientific_training_quant",
  validationBundle: "benchmark",
  strictnessMode: "scientific",
  closeBlockerIfSkipped: "Quant proof claims would be unmoored from temporal split and parity evidence.",
})}

## Verification Obligation Synthesis
- Repo/system context: Quant model backtest plus migration parity diagnostics
- Task shape: Planner proof matrix diagnostics for exact proof IDs
- Ontology signals: US-003 gate verification
- Persona signals: quant persona and quant_target proof posture for temporal leakage, target outcome, data lineage, and controls
- System boundaries touched: quant model validation and migration parity checks
- Derived verification obligations : quant/modeling and migration/parity rows must accept exact proof IDs

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| The planner accepts exact quant and migration proof IDs. | US-003 | Quant model backtest, target outcome, data source, odds snapshot as-of timestamp, temporal split, leakage check, benchmark baseline controls, alpha discovery contract, quant results validation, and migration parity | proof:temporal_split_check proof:leakage_check proof:benchmark_comparison proof:backtest_run proof:alpha_discovery_contract proof:quant_results_validation proof:live_parity_check proof:migration_parity | Run verify_gate.mjs plan-to-execute and verification_matrix.mjs lint --json | Gate passes and lint shows quant_modeling plus migration_parity covered | Real trading execution remains out of scope |

## Success Criteria
1. The planner accepts exact quant and migration proof IDs.

## Fix Classification
Root-cause fix
`);

    const gate = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(gate.ok, "verify_gate plan-to-execute accepts exact proof IDs for quant and migration obligations");
    assert(gate.stdout.includes("proof:temporal_split_check"), "plan-to-execute reports recognized quant proof IDs");
    assert(gate.stdout.includes("proof:migration_parity"), "plan-to-execute reports recognized migration proof IDs");

    const lint = runNode([verificationMatrixScript, "lint", "--plan", planDir, "--json"], tmp);
    assert(lint.ok, "verification_matrix lint --json passes for exact proof ID fixture");
    const packet = JSON.parse(lint.stdout);
    const coverage = new Map(packet.obligation_coverage.map((entry) => [entry.id, entry.covered]));
    assert(coverage.get("quant_modeling") === true, "verification matrix lint covers quant_modeling");
    assert(coverage.get("migration_parity") === true, "verification matrix lint covers migration_parity");
    assert(packet.recognized_proof_ids.includes("proof:temporal_split_check"), "verification matrix lint lists recognized exact proof IDs");
    assert(packet.recognized_proof_ids.includes("proof:alpha_discovery_contract"), "verification matrix lint lists recognized alpha discovery proof ID");
    assert(packet.recognized_proof_ids.includes("proof:quant_results_validation"), "verification matrix lint lists recognized quant results proof ID");
    assert(packet.selected_table?.heading === "Verification Strategy", "verification matrix lint reports the selected table heading");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioVerificationMatrixCoversTableCriteriaAndProseProofRows() {
  const tmp = makeTemp("verification-table-prose-proof");
  try {
    const goal = "Improve quant model backtest with migration parity diagnostics";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-003",
        title: "Gate verification",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the table/prose proof fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
What happened: observed behavior showed realistic table-shaped success criteria and natural proof prose could be ignored by the matrix analyzer. Verification matrices should accept those rows without forcing every proof row to use exact proof IDs, while the quant persona still records target outcome, data source, odds snapshot as-of semantics, temporal leakage guard, and baseline controls. Candidate alpha hypothesis: stale injury-news odds create a temporary edge mechanism. Expected edge metric is positive CLV versus the closing-line benchmark. Falsification threshold: reject if CLV decays or the baseline control wins. Next experiment: run a liquidity-adjusted follow-up screen.

## Files To Modify
- models/tennis_model.py
- migrations/odds_parity.mjs

## Steps
1. Parse table-shaped success criteria.
2. Evaluate all meaningful verification rows for synthesized obligation coverage.
3. Confirm lint and gate diagnostics agree.

${semanticUpkeepContractBlock({
  profile: "scientific_training_quant",
  validationBundle: "benchmark",
  strictnessMode: "scientific",
  closeBlockerIfSkipped: "Quant and migration proof rows would be ignored by the matrix analyzer.",
})}

## Verification Obligation Synthesis
- Repo/system context: Quant model backtest plus migration parity diagnostics
- Task shape: Planner proof matrix diagnostics for realistic proof prose
- Ontology signals: US-003 gate verification
- Persona signals: quant persona and quant_target proof posture for temporal leakage, target outcome, data lineage, and controls
- System boundaries touched: quant model validation and migration parity checks
- Derived verification obligations: Quant/modeling and migration/parity proof rows must be recognized even when they are not the row matched to the single top-level criterion

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| The planner accepts realistic verification matrix prose. | US-003 | Planner gate and matrix lint diagnostics | Planner smoke test | Run verify_gate.mjs plan-to-execute and verification_matrix.mjs lint --json | Gate and lint both pass | Live downstream tennis execution remains out of scope |
| Migration parity | N/A | Config migration parity and compatibility path | Compatibility check with explicit path verification | Compare before/after config and migration paths in a dry-run fixture | Migration parity is covered | Fleet rollout remains out of scope |
| Quant validation | N/A | Quant model backtest with target outcome, data source, odds snapshot as-of timestamp, temporal split, leakage controls, and baseline benchmark controls | Benchmark backtest with temporal split, leakage review, calibration check, and out-of-sample validation | Run a backtest fixture and inspect validation ranges | Quant proof family is covered | Statistical significance over full history remains out of scope |

## Success Criteria
| # | Criterion | Measurement | Pass Threshold |
|---|---|---|---|
| 1 | The planner accepts realistic verification matrix prose. | Gate and lint diagnostics for table criteria plus prose proof rows | PASS |

## Fix Classification
Root-cause fix
`);

    const gate = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(gate.ok, "verify_gate plan-to-execute accepts table-shaped criteria and natural proof prose rows");

    const lint = runNode([verificationMatrixScript, "lint", "--plan", planDir, "--json"], tmp);
    assert(lint.ok, "verification_matrix lint --json accepts table-shaped criteria and natural proof prose rows");
    const packet = JSON.parse(lint.stdout);
    const coverage = new Map(packet.obligation_coverage.map((entry) => [entry.id, entry.covered]));
    assert(packet.criterion_to_row_matches.length === 1, "verification matrix lint parses one table-shaped success criterion");
    assert(coverage.get("quant_modeling") === true, "verification matrix lint covers quant_modeling from prose proof rows");
    assert(coverage.get("migration_parity") === true, "verification matrix lint covers migration_parity from prose proof rows");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanGatePrintsLowLevelAgentPacket() {
  const tmp = makeTemp("low-level-agent-packet");
  try {
    const goal = "Build a user-facing LearnDash course export workflow for instructors";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-003",
        title: "Gate verification",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);

    writeJson(join(planDir, "intent_contract.json"), {
      version: 1,
      primary_user: "Course author",
      job_to_be_done: "Export a LearnDash course bundle",
      desired_outcomes: ["Export includes lessons, quizzes, and metadata"],
      anti_goals: "Do not produce an empty export",
      deliverables: [
        {
          id: "course_export",
          name: "Course export",
          kind: "workflow",
          purpose: "Let instructors move course content between sites",
          quality_bars: "Includes lessons and quizzes",
          anti_goals: "Silent partial export",
          evidence_mode: "integration",
        },
      ],
    });

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the low-level packet fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${goal}

## Problem Statement
Course export planning should fail loudly when intent contract shape, story registry linkage, and verification synthesis labels are incomplete.

## Files To Modify
- includes/course-export.php

## Steps
1. Build the course export service.
2. Add integration coverage.

## Verification Obligation Synthesis
- Context: LearnDash course export workflow
- Verification obligations: Integration proof for export behavior

## Success Criteria
1. Course authors can export a course bundle.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Course authors can export a course bundle. | US-067 | LearnDash course export workflow | Integration smoke | Run export integration fixture | Export file contains expected content | Cross-site import remains out of scope |

## Fix Classification
Root-cause fix
`);

    const gate = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute blocks the low-level packet fixture");
    assert(gate.stdout.includes("Repair Surface"), "blocked plan-to-execute output prints the shared repair surface");
    assert(!gate.stdout.includes(["Low-Level", "Agent Gate Packet"].join(" ")), "blocked plan-to-execute output no longer prints the old low-level heading");
    assert(gate.stdout.includes("intent_contract.json list-like fields must be arrays"), "packet names intent_contract list-shape guidance");
    assert(gate.stdout.includes("deliverables[0].quality_bars"), "packet identifies scalar deliverable quality_bars");
    assert(gate.stdout.includes("deliverables[0].anti_goals"), "packet identifies scalar deliverable anti_goals");
    assert(gate.stdout.includes("US-067"), "packet identifies missing story-registry linkage");
    assert(gate.stdout.includes("Verification Obligation Synthesis labels"), "packet lists synthesis labels");
    assert(gate.stdout.includes("Evidence guidance:"), "packet includes shared evidence guidance");
    assert(gate.stdout.includes("Required columns:"), "packet lists required evidence columns");
    assert(gate.stdout.includes("Example row shape:"), "packet shows the matrix row shape before transition");
    assert(gate.stdout.includes("verification_matrix.mjs lint --plan"), "packet points to matrix lint");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyGatePassesWithAuditBackedPlan() {
  const tmp = makeTemp("planning-only-pass");
  try {
    const goal = "Design a planning-only safe-plan handoff";
    const planDir = seedProject(tmp, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-901",
        title: "Planning-only validator contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);
    writeFileSync(join(planDir, "plan.md"), buildPlanningOnlyPlan({
      goal,
      retroSource: "mistake_registry.json -> M-041",
    }));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    if (!gate.ok) console.log(`  DEBUG: planning-only complete fixture output\n${gate.stdout}${gate.stderr}`);
    assert(gate.ok, "verify_gate plan-to-execute --planning-only accepts a complete audit-backed planning handoff");
    assert(gate.stdout.includes("GATE-PLN-021") && gate.stdout.includes("GATE-PLN-026"), "planning-only gate reports the dedicated planning-only checks");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyGateBlocksMissingRetros() {
  const tmp = makeTemp("planning-only-missing-retros");
  try {
    const goal = "Design a planning-only safe-plan handoff";
    const planDir = seedProject(tmp, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-901",
        title: "Planning-only validator contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);
    writeFileSync(join(planDir, "plan.md"), buildPlanningOnlyPlan({ goal, includeRetros: false }));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute --planning-only blocks plans missing retro and mistake guards");
    assert(gate.stdout.includes("Active Retros And Mistake Guards section is missing"), "planning-only gate explains the missing retro/mistake section");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyGateBlocksMissingExactTestInventory() {
  const tmp = makeTemp("planning-only-missing-tests");
  try {
    const goal = "Design a planning-only safe-plan handoff";
    const planDir = seedProject(tmp, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-901",
        title: "Planning-only validator contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);
    writeFileSync(join(planDir, "plan.md"), buildPlanningOnlyPlan({ goal, includeExactTestInventory: false }));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute --planning-only blocks plans missing the exact future test inventory");
    assert(gate.stdout.includes("Exact Test Inventory section is missing"), "planning-only gate explains the missing exact test inventory section");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyGateBlocksMissingRedTeamReview() {
  const tmp = makeTemp("planning-only-missing-red-team");
  try {
    const goal = "Design a planning-only safe-plan handoff";
    const planDir = seedProject(tmp, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-901",
        title: "Planning-only validator contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);
    writeFileSync(join(planDir, "plan.md"), buildPlanningOnlyPlan({ goal, includeRedTeam: false }));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute --planning-only blocks plans missing the red-team review");
    assert(gate.stdout.includes("Plan Red-Team Review section is missing"), "planning-only gate explains the missing plan red-team review section");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyGateBlocksMissingStoryAudit() {
  const tmp = makeTemp("planning-only-missing-story-audit");
  try {
    const goal = "Design a planning-only safe-plan handoff";
    const planDir = seedProject(tmp, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-901",
        title: "Planning-only validator contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);
    writeFileSync(join(planDir, "plan.md"), buildPlanningOnlyPlan({ goal, includeStoryAudit: false }));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute --planning-only blocks story-linked plans missing the story audit");
    assert(gate.stdout.includes("Story And Traceability Audit section is missing"), "planning-only gate explains the missing story and traceability audit section");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyGateBlocksRootLevelLightweightHandoff() {
  const tmp = makeTemp("planning-only-lightweight-block");
  try {
    symlinkSync(agentDir, join(tmp, ".agent"), "dir");
    seedStoryRegistry(tmp, [
      {
        id: "US-902",
        title: "Lightweight planning-only validator contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);
    writeFileSync(join(tmp, "task.md"), "# Task\n\nDesign a lightweight planning-only safe-plan handoff.\n");
    writeFileSync(join(tmp, "implementation_plan.md"), buildPlanningOnlyPlan({
      goal: "Design a lightweight planning-only safe-plan handoff",
      storyId: "US-902",
    }).replace(/^# Plan\b/m, "# Implementation Plan"));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute --planning-only rejects root-level handoffs without a plan spine");
    assert(gate.stderr.includes("planning-only validation now requires a plan spine"),
      "root-level planning-only failure explains the required plan spine");
    assert(!gate.stdout.includes("GATE-PLN-LW-001"), "root-level lightweight gate codes are no longer emitted");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyGateBlocksUngroundedRetroSources() {
  const tmp = makeTemp("planning-only-ungrounded-retro");
  try {
    const goal = "Design a planning-only safe-plan handoff";
    const planDir = seedProject(tmp, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-901",
        title: "Planning-only validator contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);
    writeFileSync(join(planDir, "plan.md"), buildPlanningOnlyPlan({ goal, retroSource: "prior learning" }));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute --planning-only blocks plans with generic retro sources");
    assert(gate.stdout.includes("Active Retros And Mistake Guards should cite concrete sources"), "planning-only gate explains the missing retro provenance");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlanningOnlyGateBlocksUngroundedRedTeamReview() {
  const tmp = makeTemp("planning-only-ungrounded-red-team");
  try {
    const goal = "Design a planning-only safe-plan handoff";
    const planDir = seedProject(tmp, goal);
    seedStoryRegistry(tmp, [
      {
        id: "US-901",
        title: "Planning-only validator contract",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs"],
      },
    ]);
    writeFileSync(join(planDir, "plan.md"), buildPlanningOnlyPlan({ goal, alignDeterministicAttackVectors: false }));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    assert(!gate.ok, "verify_gate plan-to-execute --planning-only blocks red-team tables that ignore deterministic attack vectors");
    assert(gate.stdout.includes("Plan Red-Team Review should align with at least one synthesized attack vector"), "planning-only gate explains the missing red-team provenance");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioResetCircuitBreaker() {
  const tmp = makeTemp("reset-circuit-breaker");
  try {
    const planDir = seedProject(tmp, "reset circuit breaker smoke");
    const statePath = join(planDir, "state.json");
    const state = readJson(statePath);
    state.circuit_breakers = {
      "execute-to-reflect": {
        total_fails: 4,
        last_fail_at: new Date().toISOString(),
      },
    };
    writeJson(statePath, state);

    const reset = runNode([bootstrapScript, "reset-circuit-breaker", "execute-to-reflect"], tmp);
    assert(reset.ok, "bootstrap reset-circuit-breaker exits cleanly");
    assert(reset.stdout.includes("Circuit breaker reset"), "bootstrap reset-circuit-breaker reports the reset");

    const afterReset = readJson(statePath);
    assert(afterReset.circuit_breakers["execute-to-reflect"].total_fails === 0, "bootstrap reset-circuit-breaker zeroes the persistent fail counter");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioHistoryPoisonDiagnosesButAllowsValidTransition() {
  const tmp = makeTemp("history-poison");
  try {
    const planDir = seedProject(tmp, "history poison smoke");
    writeExploreFindings(planDir, "history poison smoke");
    const statePath = join(planDir, "state.json");
    const state = readJson(statePath);
    state.transitions = Array.from({ length: 5 }, (_, index) => ({
      from: "EXPLORE",
      to: "EXPLORE",
      timestamp: `2026-04-03T20:00:0${index}Z`,
      gate_result: "FAIL",
      failure_codes: ["GATE-EXP-001"],
      script_versions: {},
    }));
    writeJson(statePath, state);

    const transitioned = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    const diagnostic = `${transitioned.stdout}\n${transitioned.stderr}`;
    assert(transitioned.ok, "transition explore-to-plan proceeds when current artifacts pass despite five history-poison failures");
    assert(diagnostic.includes("GATE_HISTORY_POISONED"), "transition surfaces poisoned retry history as a warning");
    assert(diagnostic.includes("Keeping the transition live so a now-valid gate can pass"), "transition distinguishes current artifact truth from stale retry history");
    assert(diagnostic.includes("recover-poison remains available"), "transition keeps recover-poison as an optional history-preserving repair");

    const afterTransition = readJson(statePath);
    assert(afterTransition.state === "PLAN", "transition advances once the current gate truth passes");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRetryDiagnosticTimeoutCoversSlowGateTruth() {
  const source = readFileSync(transitionScript, "utf-8");
  const match = source.match(/GATE_RETRY_DIAGNOSTIC_TIMEOUT_MS\s*=\s*(\d+)/);
  const timeoutMs = match ? Number(match[1]) : 0;
  assert(timeoutMs > 600000, "retry guard outlives the governed ten-minute baseline before reporting GATE-RETRY-001");
}

function scenarioReverseDivergenceStaysDiagnostic() {
  const tmp = makeTemp("reverse-divergence");
  try {
    const goal = "Retrofit explicit criterion traceability";
    const planDir = seedProject(tmp, goal);
    writeExploreFindings(planDir, goal);

    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-001",
          title: "Planner traceability gate",
          priority: "HIGH",
          status: "FULLY_COVERED",
          validation_refs: ["tests/validation_traceability.mjs"],
        },
      ],
    }, null, 2));

    const explore = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(explore.ok, "transition explore-to-plan accepts the reverse-divergence fixture");

    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Retrofit explicit criterion traceability

## Problem Statement
Transition diagnostics should not claim Prolog fact injection when JS is the layer correctly rejecting the plan.

## Files To Modify
- src/traceability.js

## Steps
1. Add the gate.
2. Update the docs.
3. Verify the regression coverage.

${semanticUpkeepContractBlock({
  validationBundle: "behavioral",
  closeBlockerIfSkipped: "Criterion-to-story traceability would drift from the plan semantics.",
})}

## Verification Strategy
| Criterion | Check | Pass means |
|---|---|---|
| The plan gate blocks missing story linkage. | Run verify_gate.mjs plan-to-execute | The gate explains the missing mapping |

## Success Criteria
1. The plan gate blocks missing story linkage.

## Fix Classification
Root-cause fix
`);

    const transition = runNode([transitionScript, "plan-to-execute"], tmp);
    assert(!transition.ok, "transition plan-to-execute still fails when the JS gate correctly blocks the plan");
    assert(transition.stdout.includes("Verification Strategy must include explicit 'Criterion' and 'Story linkage' columns"), "transition surfaces the real JS gate failure");
    assert(!transition.stdout.includes("possible Prolog fact injection"), "transition no longer reports fake Prolog fact injection on reverse divergence");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSemanticDivergencePrecisionContract() {
  const probe = runNode([
    "--input-type=module",
    "-e",
    `import { readFileSync } from "fs";
import { classifySemanticDivergence } from ${JSON.stringify(pathToFileURL(semanticDivergenceScript).href)};
import { buildTransitionReceipt } from ${JSON.stringify(pathToFileURL(gateVerdictScript).href)};

const fixture = JSON.parse(readFileSync(${JSON.stringify(semanticDivergencePatternFixture)}, "utf-8"));
const storyInvariantRows = (names) => [{
  name: "Story invariants",
  status: "FAIL",
  code: "GATE-SEM-002",
  detail: "Structured fixture violations",
  violations: names.map((name) => ({ name, detail: "fixture" })),
}];
const classify = (semanticResults, options = {}) => classifySemanticDivergence({
  jsGateBlocked: false,
  semanticResults,
  enforcePrologDivergence: true,
  ...options,
});
const patterns = fixture.cases.map((entry) => {
  const semanticResults = storyInvariantRows(entry.violations);
  const results = classify(semanticResults);
  const receipt = buildTransitionReceipt({
    planId: "plan_semantic_divergence_fixture",
    gate: "validate-to-close",
    sourceState: "VALIDATE",
    targetState: "CLOSE",
    results: [...semanticResults, ...results],
    generatedAt: "2026-07-22T00:00:00.000Z",
  });
  return {
    id: entry.id,
    result_count: results.length,
    status: results[0]?.status || null,
    code: results[0]?.code || null,
    semantic_divergence: results[0]?.semantic_divergence || null,
    receipt_explained: receipt.explained_divergences,
    equivalence_explained: receipt.equivalence?.explained_divergences,
    hard_block_count: receipt.hard_block_count,
    failure_codes: receipt.failure_codes,
  };
});
const negatives = [
  { id: "i035", rows: storyInvariantRows(["unmapped_source_file"]) },
  { id: "synthetic", rows: storyInvariantRows(["synthetic_unknown_invariant"]) },
  { id: "mixed", rows: storyInvariantRows(["high_priority_untested", "unmapped_source_file"]) },
  { id: "missing_violations", rows: [{ name: "Story invariants", status: "FAIL", code: "GATE-SEM-002" }] },
  { id: "empty_violations", rows: [{ name: "Story invariants", status: "FAIL", code: "GATE-SEM-002", violations: [] }] },
  { id: "transition_guard", rows: [{ name: "Semantic transition", status: "FAIL", code: "GATE-SEM-001" }] },
  { id: "engine_error", rows: [{ name: "Semantic checks", status: "FAIL", code: "GATE-SEM-ERR" }] },
  { id: "uncoded", rows: [{ name: "Unknown semantic blocker", status: "FAIL" }] },
].map(({ id, rows }) => ({ id, results: classify(rows) }));

console.log(JSON.stringify({
  provenance: fixture.provenance,
  pattern_count: fixture.cases.length,
  patterns,
  negatives,
  aligned: classify([{ name: "Semantic transition", status: "PASS", code: "GATE-SEM-001" }]),
  reverse: classifySemanticDivergence({
    jsGateBlocked: true,
    semanticResults: [{ name: "Semantic transition", status: "PASS", code: "GATE-SEM-001" }],
    enforcePrologDivergence: true,
  }),
  disabled: classify(storyInvariantRows(["high_priority_untested"]), { enforcePrologDivergence: false }),
  empty_receipt: buildTransitionReceipt({
    planId: "plan_semantic_divergence_fixture",
    gate: "validate-to-close",
    sourceState: "VALIDATE",
    targetState: "CLOSE",
    results: [],
    generatedAt: "2026-07-22T00:00:00.000Z",
  }),
}));`,
  ], repoRoot);

  assert(probe.ok, "shared semantic divergence classifier and receipt probe loads");
  if (!probe.ok) {
    console.log(`  DEBUG: semantic divergence probe ${probe.stderr || probe.stdout}`);
    return;
  }

  const payload = JSON.parse(probe.stdout);
  assert(payload.provenance?.kind === "synthetic_pattern_matrix" && payload.provenance?.raw_rows_available === false, "21-case fixture states its honest aggregate-pattern provenance boundary");
  assert(payload.pattern_count === 21 && payload.patterns.length === 21, "Tesseract-pattern regression contains exactly 21 cases");
  assert(payload.patterns.every((entry) => entry.result_count === 1 && entry.status === "PASS" && entry.code === null), "all 21 ordinary patterns classify the extra divergence alarm as quiet");
  assert(payload.patterns.every((entry) => entry.hard_block_count === 1 && JSON.stringify(entry.failure_codes) === JSON.stringify(["GATE-SEM-002"])), "all 21 receipts preserve the underlying story-invariant block without adding GATE-SEM-003");
  assert(payload.patterns.every((entry) => JSON.stringify(entry.semantic_divergence?.explaining_check_ids) === JSON.stringify(["GATE-SEM-002"])), "all ordinary patterns record only the structured explaining check ID");
  assert(payload.patterns.every((entry) => JSON.stringify(entry.receipt_explained) === JSON.stringify(entry.equivalence_explained) && entry.receipt_explained?.length === 1), "receipt and equivalence preserve identical explained-divergence evidence");
  assert(payload.negatives.every((entry) => entry.results?.length === 1 && entry.results[0]?.status === "FAIL" && entry.results[0]?.code === "GATE-SEM-003"), "I-035, unknown, mixed, missing-structure, and engine blockers remain hard GATE-SEM-003");
  assert(payload.aligned.length === 0, "aligned JavaScript/Prolog decisions emit no divergence row");
  assert(payload.reverse.length === 1 && payload.reverse[0]?.status === "WARN" && payload.reverse[0]?.code === "GATE-SEM-004", "JavaScript-only divergence remains the non-tamper GATE-SEM-004 warning");
  assert(payload.disabled.length === 0, "disabled Prolog enforcement preserves the existing non-blocking boundary");
  assert(Array.isArray(payload.empty_receipt?.explained_divergences) && payload.empty_receipt.explained_divergences.length === 0, "receipts without explanations normalize the additive field to an empty array");
  assert(Array.isArray(payload.empty_receipt?.equivalence?.explained_divergences) && payload.empty_receipt.equivalence.explained_divergences.length === 0, "equivalence without explanations normalizes the additive field to an empty array");

  const ordinaryFamilies = [
    "active_mistake_missing_declared_guard",
    "active_mistake_missing_verification_hook",
    "broken_evidence_chain",
    "deliverable_missing_purpose",
    "high_priority_untested",
  ];
  const sensitiveFamilies = [
    "approval_envelope_tampered",
    "envelope_orphan_no_state_approval",
    "gate_chain_broken",
  ];
  const uniquePrologOnlyRows = new Map();
  for (const file of readdirSync(realTelemetryFixtureDir).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(realTelemetryFixtureDir, file), "utf-8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      const checks = Array.isArray(entry?.checks) ? entry.checks : [];
      const divergence = checks.find((row) =>
        String(row?.name || "").includes("Prolog/JS divergence") &&
        String(row?.detail || "").includes("Prolog semantic checks FAIL")
      );
      if (!divergence) continue;
      const key = [entry.timestamp, entry.gate, entry.inputs?.plan].join("|");
      uniquePrologOnlyRows.set(key, entry);
    }
  }
  const ordinaryCorpusRows = [...uniquePrologOnlyRows.values()].filter((entry) => {
    const detail = String((entry.checks || []).find((row) => String(row?.name || "").includes("Story invariants"))?.detail || "");
    return ordinaryFamilies.some((name) => detail.includes(name)) && !sensitiveFamilies.some((name) => detail.includes(name));
  });
  const observedOrdinaryFamilies = [...new Set(ordinaryCorpusRows.flatMap((entry) => {
    const detail = String((entry.checks || []).find((row) => String(row?.name || "").includes("Story invariants"))?.detail || "");
    return ordinaryFamilies.filter((name) => detail.includes(name));
  }))].sort();
  assert(uniquePrologOnlyRows.size === 28, "checked-in telemetry deduplicates to 28 historical Prolog-only divergence rows");
  assert(ordinaryCorpusRows.length === 22, "checked-in telemetry contains 22 unique ordinary-shape divergence rows after excluding sensitive families");
  assert(JSON.stringify(observedOrdinaryFamilies) === JSON.stringify(ordinaryFamilies), "checked-in telemetry independently confirms exactly the five admitted ordinary families");

  const transitionSource = readFileSync(transitionScript, "utf-8");
  const verifySource = readFileSync(verifyGateScript, "utf-8");
  assert(transitionSource.includes("semantic_divergence.mjs") && transitionSource.includes("classifySemanticDivergence({"), "canonical transition caller uses the shared classifier");
  assert(verifySource.includes("semantic_divergence.mjs") && verifySource.includes("classifySemanticDivergence({"), "legacy direct verifier caller uses the shared classifier");
}

function scenarioUnmappedSourceDivergenceRemainsLoud() {
  const tmp = makeTemp("unmapped-source-divergence");
  try {
    const planDir = seedProject(tmp, "preserve I-035 semantic divergence alarm");
    prepareValidateCloseTransitionFixture(tmp, planDir, {
      filesToModify: ["docs/close-note.md"],
    });
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "unmapped.js"), "export const unmappedFixture = true;\n");

    const blocked = runNode([transitionScript, "validate-to-close"], tmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const receipt = readJson(join(planDir, "artifacts", "transition_receipts", "latest_validate-to-close.json"));
    const preflight = runNode([
      verifyGateScript,
      "reflect-to-close",
      "--plan",
      basename(planDir),
    ], tmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(preflight.ok && preflight.stdout.includes("DIAGNOSTIC ONLY") && preflight.stdout.includes("Target source: explicit"), "legacy direct verifier preserves explicit-target diagnostic behavior without inventing semantic divergence");
    assert(!blocked.ok, "I-035 unmapped source reproduction blocks the real validate-to-close transition");
    assert(blocked.stdout.includes("unmapped_source_file"), "I-035 reproduction names the unmapped source invariant");
    assert(blocked.stdout.includes("[GATE-SEM-003]"), "I-035 reproduction keeps the unexplained semantic divergence alarm loud");
    assert(receipt.failure_codes.includes("GATE-SEM-003") && receipt.explained_divergences.length === 0, "I-035 receipt has a hard tamper code and no ordinary explanation");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioKbUpdateCloseGate() {
  const tmp = makeTemp("kb-close");
  try {
    const planDir = seedProject(tmp, "kb close gate smoke");

    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), `# Patterns

## P-001 | Close gate smoke
Closing evidence can be satisfied by a real KB entry.
`);
    writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Added KB close-gate coverage
`);
    writeFileSync(join(planDir, "verification.md"), `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Close gate sees proof | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Close-gate regression fixture recorded |
| Context-appropriate integration tested | NOT REQUESTED | No operational system surface in this fixture |
| Audit reviewed | NOT REQUESTED | No audit-only obligation in this fixture |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- verify_gate close-signal path

## Remaining Unverified
None — this fixture only validates KB close-signal behavior.

## Verification Sufficiency
The goal is a planner close-signal regression, so a direct close-gate smoke is sufficient here.

## Regression Audit
Regression notes captured.

\`\`\`text
node verify_gate.mjs reflect-to-close
PASS
\`\`\`
`);

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close accepts KB update evidence");
    assert(gate.stdout.includes("KB status"), "reflect-to-close reports structured KB close-signal status");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioValidateToCloseIgnoresZeroFailSummaries() {
  const tmp = makeTemp("validate-close-zero-fail");
  try {
    const planDir = seedProject(tmp, "validate close summary parsing");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Problem Statement
Close-time semantic checks should trust the verification tables instead of proof-block summary text.

## Files To Modify
- src/app.js
- tests/app.test.js

## Verification Strategy
Run the relevant test command and keep the proof block summary text in place.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Existing suite still passes | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Standard test output recorded below |
| Context-appropriate integration tested | NOT REQUESTED | No higher-risk operational surface in this fixture |
| Audit reviewed | NOT REQUESTED | Out of scope |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Local npm test command path

## Remaining Unverified
None — this fixture only checks parsing of standard passing test output.

## Verification Sufficiency
The regression target is test-evidence parsing, so a passing local command transcript is sufficient here.

## Regression Audit
N/A — no baseline captured.

## Proof of Work

\`\`\`text
$ npm test
55 passed, 0 failed
Summary: 24 PASS, 2 WARN, 0 FAIL
\`\`\`
`,
    });

    const reflectGate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(reflectGate.ok, "verify_gate reflect-to-close accepts proof blocks that mention 0 FAIL in a summary line");

    const semantic = runNode([ruleEngineScript, "check-transition", "validate-to-close"], tmp);
    assert(semantic.ok, "rule_engine validate-to-close ignores proof-block summaries when criteria verification passes");
    assert(semantic.stdout.includes("Transition 'validate' → 'close' is ALLOWED"), "validate-to-close reports the passing semantic guard set");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioValidateCloseScopesAsyncDriftMaintenanceToPlanFiles() {
  const ambientTmp = makeTemp("validate-close-plan-scope");
  const plannedTmp = makeTemp("validate-close-planned-drift");
  const repeatTmp = makeTemp("validate-close-plan-scope-repeat");
  try {
    execFileSync("git", ["init"], { cwd: ambientTmp, stdio: "ignore" });
    const ambientPlanDir = seedProject(ambientTmp, "ordinary documentation close scope smoke");
    prepareValidateCloseTransitionFixture(ambientTmp, ambientPlanDir, {
      filesToModify: ["notes/local.txt"],
      dirtyReadme: true,
    });
    writeStructuredCloseSignals(ambientPlanDir, buildSatisfiedCloseSignals({
      test_evidence: {
        required: true,
        satisfied: false,
        status: "stale_missing_test_evidence",
        detail: "Deliberately stale pre-refresh close fact.",
      },
    }));

    const ambientClose = runNode([transitionScript, "validate-to-close"], ambientTmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(ambientClose.ok, "transition validate-to-close passes with a dirty ambient README fixture");
    assert(!ambientClose.stdout.includes("Async drift maintenance enqueued"), "validate-to-close does not enqueue async maintenance for unrelated dirty drift-sensitive files");
    assert(!existsSync(join(ambientPlanDir, "async")), "unrelated dirty drift-sensitive files do not create an async job directory");
    assert(readJson(join(ambientPlanDir, "state.json")).state === "CLOSE", "same-invocation refresh replaces stale close facts before semantic evaluation");

    rmSync(join(ambientTmp, "plans", ".current_plan"), { force: true });
    const notification = runNode([
      transitionScript,
      "notify-user",
      "--plan",
      basename(ambientPlanDir),
    ], ambientTmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(notification.ok, "notify-user succeeds for an explicitly targeted closed plan after its active pointer is already absent");
    assert(notification.stdout.includes("pointer/thread target already absent or reassigned"), "notify-user reports the absent-pointer cleanup path without mutating another target");

    execFileSync("git", ["init"], { cwd: repeatTmp, stdio: "ignore" });
    const repeatPlanDir = seedProject(repeatTmp, "ordinary documentation close scope smoke");
    prepareValidateCloseTransitionFixture(repeatTmp, repeatPlanDir, {
      filesToModify: ["notes/local.txt"],
      dirtyReadme: true,
    });
    writeStructuredCloseSignals(repeatPlanDir, buildSatisfiedCloseSignals({
      test_evidence: {
        required: true,
        satisfied: false,
        status: "stale_missing_test_evidence",
        detail: "Deliberately stale pre-refresh close fact.",
      },
    }));
    const repeatClose = runNode([transitionScript, "validate-to-close"], repeatTmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(repeatClose.ok, "identical validate-to-close input passes on a second first invocation");
    const ambientReceipt = readJson(join(ambientPlanDir, "artifacts", "transition_receipts", "latest_validate-to-close.json"));
    const repeatReceipt = readJson(join(repeatPlanDir, "artifacts", "transition_receipts", "latest_validate-to-close.json"));
    assert(
      ambientReceipt.status === repeatReceipt.status &&
        ambientReceipt.hard_block_count === repeatReceipt.hard_block_count &&
        ambientReceipt.advisory_count === repeatReceipt.advisory_count &&
        JSON.stringify(ambientReceipt.failure_codes) === JSON.stringify(repeatReceipt.failure_codes),
      "same-input validate-to-close receipts are deterministic across fresh plans",
    );

    const plannedPlanDir = seedProject(plannedTmp, "planned documentation close scope smoke");
    prepareValidateCloseTransitionFixture(plannedTmp, plannedPlanDir, {
      filesToModify: ["README.md"],
      dirtyReadme: true,
    });

    const plannedClose = runNode([transitionScript, "validate-to-close"], plannedTmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(plannedClose.ok, "transition validate-to-close passes when a planned drift-sensitive file is declared");
    assert(!plannedClose.stdout.includes("Async drift maintenance enqueued"), "validate-to-close does not enqueue obsolete async maintenance for planned drift-sensitive files");
    assert(!existsSync(join(plannedPlanDir, "async")), "planned drift-sensitive files do not create an obsolete async job directory");
  } finally {
    try { rmSync(ambientTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(plannedTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(repeatTmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioValidateClosePreflightAlignsStatusAndStaysReadOnly() {
  const tmp = makeTemp("validate-close-status-parity");
  try {
    const planDir = seedProject(tmp, "validate close status parity and read-only preflight");
    prepareValidateCloseTransitionFixture(tmp, planDir, { filesToModify: ["notes/local.txt"] });
    const verificationPath = join(planDir, "verification.md");
    const original = readText(verificationPath);

    writeFileSync(verificationPath, original.replace("| PASS |", "| PASS AT CLOSE ENTRY |"));
    const beforePhrase = snapshotPlannerWritableSurfaces(tmp);
    const phrase = runNode([verifyGateScript, "validate-to-close"], tmp);
    assert(!phrase.ok, "standalone validate-to-close blocks PASS AT CLOSE ENTRY");
    assert(phrase.stdout.includes("[GATE-VAL-001]"), "JavaScript gate reports the invalid presentation token");
    assert(phrase.stdout.includes("PASS AT CLOSE ENTRY") && phrase.stdout.includes("Accepted forms"), "diagnostic names the bad token and accepted forms");
    assert(phrase.stdout.includes("[GATE-SEM-001]"), "same preflight runs the Prolog transition guard");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) === JSON.stringify(beforePhrase), "standalone bad-token preflight does not mutate planner artifacts");

    writeFileSync(verificationPath, original.replace("| PASS |", "| FAIL |"));
    const beforeFail = snapshotPlannerWritableSurfaces(tmp);
    const genuineFail = runNode([verifyGateScript, "validate-to-close"], tmp);
    assert(!genuineFail.ok, "standalone validate-to-close blocks a genuine FAIL result");
    assert(genuineFail.stdout.includes("[GATE-VAL-001]"), "JavaScript gate treats FAIL as non-passing truth");
    assert(genuineFail.stdout.includes("[GATE-SEM-001]"), "Prolog gate treats FAIL as non-passing truth");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) === JSON.stringify(beforeFail), "standalone FAIL preflight does not mutate planner artifacts");

    writeFileSync(verificationPath, original);
    writeJson(join(planDir, "verification_ledger.json"), {
      version: 1,
      evidence: [{
        id: "ev_unsupported_close_mode",
        subject: "crit:sc_1",
        mode: "planner_smoke",
        status: "PASS",
        command: "run unsupported close evidence fixture",
      }],
      waivers: [],
    });
    const beforeUnsupportedMode = snapshotPlannerWritableSurfaces(tmp);
    const unsupportedMode = runNode([verifyGateScript, "validate-to-close"], tmp);
    assert(!unsupportedMode.ok, "standalone validate-to-close blocks unsupported structured-ledger evidence modes");
    assert(unsupportedMode.stdout.includes("[GATE-VAL-001]") && unsupportedMode.stdout.includes("unsupported_verification_modes:planner_smoke"), "JavaScript close truth reports the unsupported structured-ledger mode");
    assert(unsupportedMode.stdout.includes("[GATE-SEM-001]"), "Prolog close truth blocks the same unsupported structured-ledger mode");
    assert(!unsupportedMode.stdout.includes("[GATE-SEM-003]"), "unsupported structured-ledger evidence does not create JS/Prolog divergence");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) === JSON.stringify(beforeUnsupportedMode), "unsupported-mode preflight does not mutate planner artifacts");
    rmSync(join(planDir, "verification_ledger.json"), { force: true });

    const registryPath = join(tmp, "reports", "user_story_audit", "story_registry.json");
    writeFileSync(registryPath, `${readText(registryPath).trim()}\n\n`);
    const beforeRegistryRefresh = snapshotPlannerWritableSurfaces(tmp);
    const intentionalRegistryChange = runNode([verifyGateScript, "validate-to-close"], tmp);
    assert(intentionalRegistryChange.ok, "standalone preflight transiently models the actual transition's intentional registry-hash refresh");
    assert(!intentionalRegistryChange.stdout.includes("registry_tampered"), "transient registry refresh removes the stale-hash false block without writing state");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) === JSON.stringify(beforeRegistryRefresh), "transient registry-hash preflight remains byte-identical");

    rmSync(verificationPath, { force: true });
    const beforeMissingReport = snapshotPlannerWritableSurfaces(tmp);
    const missingReport = runNode([verifyGateScript, "validate-to-close"], tmp);
    assert(!missingReport.ok, "standalone validate-to-close blocks a missing verification report");
    assert(missingReport.stdout.includes("[GATE-VAL-001]") && missingReport.stdout.includes("has no structured results"), "missing-report diagnostic follows the configured structured-result boundary");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) === JSON.stringify(beforeMissingReport), "missing-report preflight remains byte-identical");

    writeFileSync(verificationPath, "# Verification\n\nTo be populated during PLAN.\n");
    const beforeTemplateReport = snapshotPlannerWritableSurfaces(tmp);
    const templateReport = runNode([verifyGateScript, "validate-to-close"], tmp);
    assert(!templateReport.ok, "standalone validate-to-close blocks the verification template");
    assert(templateReport.stdout.includes("[GATE-VAL-001]") && templateReport.stdout.includes("has no structured results"), "template diagnostic follows the configured structured-result boundary");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) === JSON.stringify(beforeTemplateReport), "template-report preflight remains byte-identical");

    writeFileSync(verificationPath, original);
    const pointerPath = join(tmp, "plans", ".current_plan");
    const originalPointer = readText(pointerPath);
    mkdirSync(join(tmp, "plans", "plan_other_fixture"), { recursive: true });
    writeFileSync(pointerPath, "plan_other_fixture\n");
    const explicitFast = runNode(
      [verifyGateScript, "validate-to-close", "--plan", basename(planDir)],
      tmp,
      { _PLANNER_FAST_VERIFY: "1" },
    );
    assert(explicitFast.ok, "explicit fast preflight accepts the valid close fixture without refreshing artifacts");
    assert(explicitFast.stdout.includes("Target source: explicit") && explicitFast.stdout.includes("plan_other_fixture"), "explicit target diagnostics disclose a divergent global pointer");
    writeFileSync(pointerPath, originalPointer);

    const unknownGateEvaluation = runNode([
      "--input-type=module",
      "-e",
      `import { evaluateGateResults } from ${JSON.stringify(pathToFileURL(verifyGateScript).href)};
const evaluation = evaluateGateResults(${JSON.stringify(planDir)}, "fixture-unknown-gate");
console.log(JSON.stringify(evaluation));`,
    ], tmp);
    assert(unknownGateEvaluation.ok, "module evaluator handles an unknown diagnostic gate without a refresh snapshot");
    const unknownEvaluation = JSON.parse(unknownGateEvaluation.stdout);
    assert(Array.isArray(unknownEvaluation.results) && unknownEvaluation.results.length >= 1, "unknown diagnostic gate retains common integrity checks");

    const help = runNode([verifyGateScript, "--help"], tmp);
    assert(help.ok && help.stdout.includes("Gates:"), "verify-gate help exits cleanly with the governed gate catalog");
    const unknownCli = runNode([verifyGateScript, "fixture-unknown-gate"], tmp);
    assert(!unknownCli.ok && unknownCli.stderr.includes("Unknown gate"), "verify-gate CLI rejects an unknown gate before resolving plan state");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioPlannerCoreCloseNeedsJourneyProof() {
  const tmp = makeTemp("planner-core-close");
  try {
    const planDir = seedProject(tmp, "planner core self-proof close gate");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Problem Statement
Planner-core close readiness should require a real planner journey, not just migration smoke.

## Files To Modify
- .agent/skills/iterative-planner/scripts/bootstrap.mjs
- .agent/skills/iterative-planner/tests/test_preplanning_scaffolding.mjs

## Verification Strategy
Run planner regressions before closing.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Migration smoke recorded | Regression | PASS |
| 2 | Supporting test recorded | Regression | PASS |

## Regression Audit
Regression notes captured.

\`\`\`text
node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest
PASS
\`\`\`

\`\`\`text
node .agent/skills/iterative-planner/tests/ive/run.mjs --only preplanning-scaffolding --json --no-manifest
PASS
\`\`\`
`,
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!gate.ok, "verify_gate reflect-to-close blocks planner-core changes without a planner journey proof");
    assert(gate.stdout.includes("planner journey PASS"), "reflect-to-close explains that planner-core work needs a planner journey PASS");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCodeChangesNeedTestEvidence() {
  const tmp = makeTemp("test-evidence-close");
  try {
    const planDir = seedProject(tmp, "test evidence close gate");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Problem Statement
Closing should fail when code changes have no planned test file coverage.

## Files To Modify
- src/app.js

## Verification Strategy
Run the relevant test command and record the result.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Existing suite still passes | Regression | PASS |

## Regression Audit
Regression notes captured.

\`\`\`text
npm test
PASS
\`\`\`
`,
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!gate.ok, "verify_gate reflect-to-close blocks code changes without planned test-file evidence");
    assert(gate.stdout.includes("Code changes require test evidence"), "reflect-to-close explains the missing test-evidence requirement");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStaticUiManualObservationSatisfiesClose() {
  const tmp = makeTemp("static-ui-manual-close");
  try {
    const goal = "Clone a single WordPress page into standalone HTML";
    const planDir = seedProject(tmp, goal);

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Clone a single WordPress page into standalone HTML

## Problem Statement
Static UI page work should close on structured manual evidence when the intent contract explicitly requires manual observation.

## Files To Modify
- mastery.html
- styles.css

## Verification Strategy
Record manual browser-review evidence for the ui_surface deliverable.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | ui_surface preserves the original page layout and feedback states | Manual observation | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Static UI fixture uses intent/manual path |
| Context-appropriate integration tested | PASS | Manual browser review of the rendered page |
| Audit reviewed | NOT REQUESTED | Browser-only fixture |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Browser rendering of ui_surface

## Remaining Unverified
None — this fixture only needs structured browser/manual evidence for a static UI deliverable.

## Verification Sufficiency
The intent contract explicitly sets manual_observation for this static UI surface, so browser review is the correct close proof for the fixture.

## Regression Audit
Visual parity notes captured.

## Proof of Work
\`\`\`text
manual browser review of ui_surface
PASS
\`\`\`
`,
      intentContract: {
        version: 1,
        primary_user: "End user",
        job_to_be_done: "Review the standalone cloned page and understand what action to take next",
        desired_outcomes: ["See a faithful page structure with clear state feedback"],
        anti_goals: ["Blank page", "Missing feedback states"],
        constraints: ["Deliver the result as static HTML/CSS"],
        deliverables: [
          {
            id: "ui_surface",
            name: "UI surface",
            kind: "ui",
            purpose: "Let the user understand the cloned page state and next action without guessing",
            quality_bars: ["Layout remains recognizable", "State feedback is visible"],
            required_sections: ["Primary action", "State feedback"],
            required_signals: ["empty-state guidance"],
            anti_goals: ["Blank success state", "Missing error feedback"],
            evidence_mode: "manual_observation",
          },
        ],
      },
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close accepts static UI manual-observation evidence without planned test files");
    assert(gate.stdout.includes("Structured close signal: static UI deliverable uses intent/manual evidence instead of test-file coverage"), "reflect-to-close reports the static UI manual-evidence close signal");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStandardPassOutputCountsAsTestEvidence() {
  const tmp = makeTemp("test-evidence-standard-output");
  try {
    const planDir = seedProject(tmp, "standard pass output satisfies test evidence");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Problem Statement
Standard passing test output should satisfy close-signals without requiring a literal PASS marker beside every command.

## Files To Modify
- src/app.js
- tests/app.test.js

## Verification Strategy
Run the relevant test command and record the output.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Existing suite still passes | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Standard test output recorded below |
| Context-appropriate integration tested | NOT REQUESTED | No higher-risk operational surface in this fixture |
| Audit reviewed | NOT REQUESTED | Out of scope |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Local npm test command path

## Remaining Unverified
None — this fixture only checks parsing of standard passing test output.

## Verification Sufficiency
The regression target is test-evidence parsing, so a passing local command transcript is sufficient here.

## Regression Audit
N/A — no baseline captured.

## Proof of Work
\`\`\`text
$ npm test
55 passed, 0 failed
\`\`\`
`,
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close accepts standard passing test-output phrasing as test evidence");
    assert(gate.stdout.includes("passing test command recorded"), "reflect-to-close explains that the standard pass-output phrasing satisfied test evidence");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioProgressLegendDoesNotCreateFalseOpenItems() {
  const tmp = makeTemp("progress-legend-close");
  try {
    const planDir = seedProject(tmp, "progress legend close gate");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Problem Statement
The progress template legend should not be misread as an actual open checklist item.

## Files To Modify
- reports/retro/findings.md

## Verification Strategy
Record review evidence and ensure close signals treat progress as complete.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Review notes captured | Review | PASS |

## Regression Audit
N/A — no baseline captured.

## Proof of Work
\`\`\`text
manual review
PASS
\`\`\`
`,
    });

    const before = snapshotPlannerWritableSurfaces(tmp);
    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close accepts progress.md when only completed items remain");
    const refreshSnapshot = refreshPlanArtifacts({
      cwd: tmp,
      skillPath: skillDir,
      planDirName: basename(planDir),
      gateName: "reflect-to-close",
      persistState: false,
      persistOntology: false,
      syncFindings: false,
      backfillScaffold: false,
    });
    assert(refreshSnapshot?.closeSignals?.progress?.satisfied === true, "transient close_signals.progress ignores the progress legend text and stays satisfied");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) === JSON.stringify(before), "reflect-to-close preflight leaves planner artifacts unchanged");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReflectCloseRequiresQuantResultsValidationForResultClaims() {
  const tmp = makeTemp("quant-results-close-gate");
  const siblingRoot = makeTemp("quant-results-sibling-worktree");
  try {
    const planDir = seedProject(tmp, "quant model final OOS ROI close gate");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Problem Statement
What happened: observed behavior showed a quant model final-OOS ROI result claim could have only a report and no machine-readable validation artifact. Close should fail until the quant persona records the target outcome, data source, odds snapshot as-of timestamp, temporal leakage handling, and baseline controls. Candidate alpha hypothesis: stale odds reaction creates a temporary edge mechanism. Expected edge metric is positive final-OOS ROI and CLV. Falsification threshold: reject if CLV decays or the baseline control wins. Next experiment: run a liquidity-adjusted follow-up screen.

## Files To Modify
- reports/model_results.md

## Verification Strategy
Use proof:quant_results_validation so the planner challenges controls, stability, confidence, leakage, presentation, and verdict before close. The target outcome is final-OOS ROI, the data source is the fixture report, the odds snapshot is as-of the fixture timestamp, temporal leakage is challenged, and baseline controls are explicit.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Quant result report exists | Review | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Close-gate fixture recorded |
| Context-appropriate integration tested | PASS | Diagnostic quant results validation artifact checked without live model execution |
| Audit reviewed | PASS | Quant result validation gate reviewed |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- verify_gate quant results validation close path

## Remaining Unverified
No live trading or deployment is exercised by this fixture.

## Verification Sufficiency
A direct close-gate regression is sufficient because the behavior under test is the planner's close contract for quant result claims.

## Regression Audit
Captured.

## Proof of Work
\`\`\`text
node verify_gate.mjs reflect-to-close
PASS
\`\`\`
`,
    });

    const missing = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!missing.ok, "verify_gate reflect-to-close blocks quant result claims without quant_results_validation.json");
    assert(missing.stdout.includes("GATE-VAL-016") && missing.stdout.includes("missing_quant_results_validation_artifact"), "reflect-to-close reports the missing quant validation artifact");

    const resultArtifact = (claimedDataSources) => stampRunRecordPayload({
        version: 1,
        applicable: true,
        run_class: "wiring_proof",
        promotion_verdict: "diagnostic_only",
        search: {
          trials_completed: 30,
          unique_parameter_count: 71,
          objective_handling: "frozen",
        },
        controls: [],
        evidence: {
          claimed_data_sources: claimedDataSources,
          strongest_counterargument: "Wiring proof does not establish economic edge.",
          falsification_criteria: "Any economic-edge claim invalidates this diagnostic fixture.",
          odds_snapshot_matrix: "entry price: T-24/open; reference price: close; CLV available: yes; label type: excess return",
          presentation_stamp: "diagnostic_only",
        },
      }, {
        producer: "verification_runner",
        row_id: "VM-QUANT-DIAGNOSTIC",
        command: "node verify_gate.mjs reflect-to-close",
        exit_code: 0,
        timestamp: "2026-06-03T12:00:00.000Z",
      });

    const siblingDatabase = join(siblingRoot, "soccer.db");
    writeFileSync(siblingDatabase, "");
    writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify(resultArtifact([
      {
        id: "soccer_database",
        path: siblingDatabase,
        expected_worktree_root: siblingRoot,
        freshness: { max_age_seconds: 86400 },
      },
    ]), null, 2) + "\n");

    const environmentInvalid = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!environmentInvalid.ok, "verify_gate reflect-to-close blocks a zero-byte sibling-worktree result source");
    assert(
      environmentInvalid.stdout.includes("GATE-VAL-016") &&
        /claimed_data_source_(empty|expected_worktree_mismatch|outside_active_worktree)/.test(environmentInvalid.stdout),
      "reflect-to-close reports the computed sibling-worktree source blocker",
    );
    const invalidSnapshot = refreshPlanArtifacts({
      cwd: tmp,
      planDirName: basename(planDir),
      gateName: "reflect-to-close",
      persistState: false,
      persistOntology: false,
      syncFindings: false,
      backfillScaffold: false,
    });
    const invalidSignal = invalidSnapshot?.closeSignals?.quant_results_validation;
    assert(invalidSignal?.status === "environment_invalid", "live transition refresh exposes environment_invalid for the sibling-worktree source");
    assert(invalidSignal?.numeric_output_reportable === false, "live transition refresh marks sibling-worktree numeric output non-reportable");

    const activeDatabase = join(tmp, "soccer.db");
    writeFileSync(activeDatabase, "non-empty active-worktree database\n");
    const stableTime = new Date(Date.now() - 5000);
    utimesSync(activeDatabase, stableTime, stableTime);
    writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify(resultArtifact([
      {
        id: "soccer_database",
        path: activeDatabase,
        expected_worktree_root: tmp,
        freshness: { max_age_seconds: 86400 },
      },
    ]), null, 2) + "\n");

    const diagnostic = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(diagnostic.ok, "verify_gate reflect-to-close accepts wiring-proof quant results only as diagnostic_only");
    assert(diagnostic.stdout.includes("GATE-VAL-016") && diagnostic.stdout.includes("diagnostic_only"), "reflect-to-close reports diagnostic-only quant validation as satisfied");

    const evidenceCommand = `${NODE} -e ${JSON.stringify("process.stdout.write(JSON.stringify({ metrics: { roi: 0.125 } }));")}`;
    writeJson(join(planDir, "verification_ledger.json"), {
      version: 1,
      evidence: [{
        id: "quant-result-critical-rerun",
        subject: "criterion:quant-result-report",
        mode: "integration_smoke",
        status: "passed",
        command: evidenceCommand,
        artifacts: [],
        summary: "A local JSON-emitting result fixture is rerunnable at close.",
        rerun: {
          risk_bearing: true,
          selection: "critical",
          expected_exit_code: 0,
          timeout_ms: 5000,
          expectations: [{
            source: "stdout_json",
            path: "metrics.roi",
            comparator: "numeric",
            expected: 0.125,
            absolute_tolerance: 0,
            relative_tolerance: 0,
          }],
        },
      }],
      waivers: [],
    });
    writeFileSync(join(planDir, "summary.md"), "# Summary\n\n[KB_NO_NEW_LEARNINGS]\n");
    const timestamp = new Date().toISOString();
    setPlanState(planDir, "VALIDATE", {
      transitions: [
        { from: "INIT", to: "EXPLORE", timestamp, gate_result: "SKIP", failure_codes: [], script_versions: {} },
        { from: "EXPLORE", to: "PLAN", timestamp, gate_result: "PASS", failure_codes: [], script_versions: {} },
        { from: "PLAN", to: "EXECUTE", timestamp, gate_result: "PASS", failure_codes: [], script_versions: {} },
        { from: "EXECUTE", to: "REFLECT", timestamp, gate_result: "PASS", failure_codes: [], script_versions: {} },
        { from: "REFLECT", to: "VALIDATE", timestamp, gate_result: "PASS", failure_codes: [], script_versions: {} },
      ],
    });
    const actualClose = runNode([transitionScript, "validate-to-close"], tmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(actualClose.ok, "actual validate-to-close transition accepts reproducible critical result evidence");
    const closedState = readJson(join(planDir, "state.json"));
    const rerunReceipt = closedState.close_signals?.quant_results_validation?.adversarial_evidence_rerun_receipt;
    assert(closedState.state === "CLOSE", "successful adversarial rerun permits the real lifecycle transition to close");
    assert(rerunReceipt?.status === "satisfied" && rerunReceipt?.performed === true, "actual close persists the satisfied adversarial rerun countersign");
    assert(rerunReceipt?.author_context_reused === false, "actual close receipt proves the worker did not reuse author process context");
    assert(rerunReceipt?.selected_evidence_ids?.[0] === "quant-result-critical-rerun", "actual close receipt names the selected critical evidence row");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(siblingRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExecuteToReflectCountsCompletedBullets() {
  const tmp = makeTemp("execute-completed-bullets");
  try {
    const planDir = seedProject(tmp, "execute-to-reflect completed bullets");

    writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- Recorded the first remediation checkpoint

## In Progress
*Nothing currently.*
`);
    writeFileSync(join(planDir, "verification.md"), `# Verification

## Test Drift Scan
N/A — no tests.

## Parity
N/A — no parity-registry.md.
`);
    writeFileSync(join(planDir, "red_team_notes.md"), `## Vector 1: Null payload reaches the validator
Attack:
- Upstream sends null for the config payload.
Impact:
- Validation short-circuits and the gate records a false green.
Mitigation:
- Assert non-null input at the boundary and cover it with a regression check.

## Vector 2: Shared parser change misses a second consumer
Attack:
- One gate parser is updated but the checklist still expects the old shape.
Impact:
- Operators satisfy one surface and still fail the transition.
Mitigation:
- Reuse shared parsing logic and add a behavioral regression test for both surfaces.

## Vector 3: Proof-of-work gets summarized instead of pasted
Attack:
- The operator writes only a tidy prose summary of passing commands.
Impact:
- Close gates cannot distinguish verified output from optimistic narration.
Mitigation:
- Require fenced command output or an explicit UNVERIFIED marker.
`);

    setPlanState(planDir, "EXECUTE");
    const gate = runNode([verifyGateScript, "execute-to-reflect"], tmp, { PLANNER_VERBOSE_CHECKS: "1" });
    assert(gate.ok, "verify_gate execute-to-reflect accepts a legacy completed bullet as evidence of completed work");
    assert(gate.stdout.includes("1 completed item(s) found"), "execute-to-reflect reports the legacy completed bullet as completed work");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExecuteToReflectGuideFirstRedTeamParity() {
  const tmp = makeTemp("execute-red-team-parity");
  try {
    const planDir = seedProject(tmp, "execute-to-reflect guide-first red-team parity");
    writeExecuteToReflectArtifacts(planDir);
    writeFileSync(
      join(planDir, "red_team_notes.md"),
      readText(join(planDir, "red_team_notes.md")) + `
## Verdict

The three attack vectors above are substantive and mitigated. This summary is
an ornamental closeout heading, not a fourth attack vector.
`,
    );
    setPlanState(planDir, "EXECUTE");

    const jsGate = runNode([verifyGateScript, "execute-to-reflect"], tmp);
    const semanticGate = runNode([ruleEngineScript, "check-transition", "execute-to-reflect", "--json"], tmp);
    const semanticResult = JSON.parse(semanticGate.stdout || "{}");

    assert(jsGate.ok, "guide-first execute-to-reflect JS gate accepts three substantive vectors plus an ornamental verdict heading");
    assert(
      semanticGate.ok && semanticResult.allowed === true && !(semanticResult.blockers || []).includes("no_red_team_notes"),
      "guide-first execute-to-reflect Prolog gate uses the same red-team documentation boundary",
    );

    const transition = runNode([transitionScript, "execute-to-reflect"], tmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(transition.ok, "manual execute-to-reflect transition remains allowed when no saved test baseline is configured");
    assert(
      transition.stdout.includes("test_baseline.mjs verify executed for test-gated transition") &&
        transition.stdout.includes("WARN"),
      "manual missing-baseline execution takes the canonical advisory status branch",
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExecuteToReflectWarnsOnSemanticSubstrateGaps() {
  const tmp = makeTemp("semantic-substrate-execute-warning");
  try {
    const planDir = seedProject(tmp, "semantic substrate execute-to-reflect warning");
    writeExecuteToReflectArtifacts(planDir);
    writeStructuredCloseSignals(planDir, buildSatisfiedCloseSignals({
      semantic_substrate: {
        required: true,
        satisfied: false,
        status: "missing_relevant_gaps",
        relevant_domains: ["config"],
        advisory_gap_ids: ["missing_mutually_exclusive_facts"],
        blocking_gap_ids: ["missing_mutually_exclusive_facts"],
        sources_present: {
          annotations: false,
          story_registry: false,
          persona_artifacts: true,
        },
        detail: "Relevant semantic substrate gaps: missing_mutually_exclusive_facts",
      },
    }));

    const gate = runNode([verifyGateScript, "execute-to-reflect"], tmp);
    assert(gate.ok, "verify_gate execute-to-reflect warns but still passes when semantic-substrate gaps remain advisory-only");
    assert(gate.stdout.includes("GATE-ETR-010") && gate.stdout.includes("Task-relevant semantic substrate gaps are surfaced before REFLECT"), "execute-to-reflect emits the semantic-substrate advisory warning row");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExecuteToReflectWarnsOnSemanticSubstrateScopeDegradation() {
  const tmp = makeTemp("semantic-substrate-execute-scope-degraded");
  try {
    const planDir = seedProject(tmp, "semantic substrate execute-to-reflect degraded scope warning");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Refactor helper logging

## Problem Statement
Missing planned files should keep semantic substrate scope honest even when no blocking domain is relevant.

## Files To Modify
- src/new_helper.ts

## Steps
1. Rework helper logging.
`);
    writeExecuteToReflectArtifacts(planDir);

    const gate = runNode([verifyGateScript, "execute-to-reflect"], tmp);
    assert(gate.ok, "verify_gate execute-to-reflect warns but still passes when semantic-substrate scope degraded");
    assert(gate.stdout.includes("GATE-ETR-010"), "execute-to-reflect emits the semantic-substrate advisory row for degraded scope");
    assert(gate.stdout.includes("scope degraded via missing_planned_files"), "execute-to-reflect surfaces the degraded semantic-substrate scope reason");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioExecuteToReflectWarnsOnWeakSemanticSubstrateHints() {
  const tmp = makeTemp("semantic-substrate-execute-weak-hint");
  try {
    const planDir = seedProject(tmp, "semantic substrate execute-to-reflect weak hint warning");
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "provider_client.ts"), "export const providerClient = true;\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Refactor payment provider client

## Problem Statement
Generic provider wording alone should not imply special config safety semantics.

## Files To Modify
- src/provider_client.ts

## Steps
1. Simplify provider client internals.
`);
    writeExecuteToReflectArtifacts(planDir);

    const gate = runNode([verifyGateScript, "execute-to-reflect"], tmp);
    assert(gate.ok, "verify_gate execute-to-reflect warns but still passes when only weak semantic-substrate hints remain");
    assert(gate.stdout.includes("GATE-ETR-010"), "execute-to-reflect emits the semantic-substrate advisory row for weak hints");
    assert(gate.stdout.includes("Weak semantic-substrate relevance hints detected: config"), "execute-to-reflect surfaces weak semantic-substrate hints without blocking");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTestEvidenceWaiverPasses() {
  const tmp = makeTemp("test-evidence-waiver");
  try {
    const planDir = seedProject(tmp, "test evidence waiver close gate");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Problem Statement
Structured waivers should satisfy the close gate when tests cannot be added in this environment.

## Files To Modify
- src/runtime-config.json

## Verification Strategy
Record the manual validation notes and structured waiver.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Manual review recorded | Review | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | WAIVED | Structured waiver recorded in verification_ledger.json |
| Context-appropriate integration tested | PASS | Manual review captured for this config-only fixture |
| Audit reviewed | PASS | Waiver rationale and review recorded in the structured ledger |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Manual review of runtime-config.json

## Remaining Unverified
Automated test execution remains waived by user because this fixture has no stable harness.

## Verification Sufficiency
This fixture is specifically validating waiver handling, so structured manual review plus an approved waiver is the intended sufficient proof.

## Regression Audit
Regression notes captured.

\`\`\`text
manual review
PASS
\`\`\`
`,
      verificationLedger: {
        version: 1,
        waivers: [
          {
            id: "wv_test_evidence_001",
            subject: "plan:test-evidence",
            mode: "manual_observation",
            reason: "Config-only change with no stable automated harness in this temp fixture",
            approved_by: "user",
          },
        ],
      },
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close accepts an approved structured test-evidence waiver");
    assert(gate.stdout.includes("test evidence waived by user"), "reflect-to-close reports the structured test-evidence waiver");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRemediationCloseNeedsAntiRecurrenceGuard() {
  const tmp = makeTemp("anti-recurrence-missing");
  try {
    const goal = "Retro remediation for recurring planner bug";
    const planDir = seedProject(tmp, goal);

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Retro remediation for recurring planner bug

## Problem Statement
Closing remediation work should fail when no durable anti-recurrence guard was recorded.

## Files To Modify
- reports/retro/findings.md

## Verification Strategy
Record the proof of work and the remediation guard.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Retro report updated | Review | PASS |

## Regression Audit
N/A — no baseline captured.

## Proof of Work
\`\`\`text
manual review
PASS
\`\`\`
`,
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!gate.ok, "verify_gate reflect-to-close blocks remediation work without an anti-recurrence guard");
    assert(gate.stdout.toLowerCase().includes("anti-recurrence guard"), "reflect-to-close explains the missing anti-recurrence guard section");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRemediationCloseAcceptsAntiRecurrenceGuard() {
  const tmp = makeTemp("anti-recurrence-pass");
  try {
    const goal = "Retro remediation for recurring planner bug";
    const planDir = seedProject(tmp, goal);

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Retro remediation for recurring planner bug

## Problem Statement
Closing remediation work should succeed once a durable anti-recurrence guard is recorded.

## Files To Modify
- reports/retro/findings.md

## Verification Strategy
Record the proof of work and the remediation guard.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Retro report updated | Review | PASS |

## Regression Audit
N/A — no baseline captured.

## Anti-Recurrence Guard
| Status | Guard Type | Evidence |
|---|---|---|
| PASS | kb | Added a durable mistake entry that future retro plans can reuse. |

## Proof of Work
\`\`\`text
manual review
PASS
\`\`\`
`,
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close accepts remediation work once an anti-recurrence guard is recorded");
    assert(gate.stdout.toLowerCase().includes("anti-recurrence guard satisfied"), "reflect-to-close reports the satisfied anti-recurrence guard");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function learnedObligationIntentContract() {
  return {
    version: 1,
    primary_user: "Site visitor",
    job_to_be_done: "Use the landing page comfortably on a phone",
    desired_outcomes: ["The page stays readable on a narrow viewport"],
    anti_goals: ["Desktop-only layout"],
    deliverables: [
      {
        id: "landing_page",
        name: "Landing page",
        kind: "ui",
        required: true,
        purpose: "Support responsive mobile browsing",
        quality_bars: ["Readable on narrow viewport"],
        required_sections: ["Hero"],
        anti_goals: ["Horizontal overflow"],
        evidence_mode: "manual_observation",
      },
    ],
  };
}

function scenarioLearnedObligationCloseNeedsEvidence() {
  const tmp = makeTemp("learned-obligation-missing");
  try {
    const goal = "Clone responsive landing page";
    const planDir = seedProject(tmp, goal);

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Clone responsive landing page

## Problem Statement
Responsive UI work should not close without explicit mobile proof.

## Files To Modify
- public/landing.html
- public/landing.css

## Verification Strategy
Record the close proof for responsive mobile behavior.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Landing page updated | Review | PASS |

## Regression Audit
N/A — no baseline captured.

## Proof of Work
\`\`\`text
manual review
PASS
\`\`\`
`,
      intentContract: learnedObligationIntentContract(),
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!gate.ok, "verify_gate reflect-to-close blocks active learned obligations without proof");
    assert(gate.stdout.toLowerCase().includes("learned obligation"), "reflect-to-close explains the missing learned-obligation evidence");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLearnedObligationCloseAcceptsStructuredEvidence() {
  const tmp = makeTemp("learned-obligation-pass");
  try {
    const goal = "Clone responsive landing page";
    const planDir = seedProject(tmp, goal);

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Clone responsive landing page

## Problem Statement
Responsive UI work should close once mobile proof is recorded.

## Files To Modify
- public/landing.html
- public/landing.css

## Verification Strategy
Record the close proof for responsive mobile behavior.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Landing page updated | Review | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Static UI path uses manual-observation intent contract |
| Context-appropriate integration tested | PASS | Narrow-viewport browser observation recorded in verification ledger |
| Audit reviewed | NOT REQUESTED | Browser-only fixture |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Browser narrow-viewport rendering path for \`landing_page\`

## Remaining Unverified
None — live operator approval is intentionally out of scope for this fixture.

## Verification Sufficiency
The changed surface is a static UI deliverable with manual-observation evidence mode, so a narrow-viewport browser check is the context-appropriate proof for this fixture.

## Regression Audit
N/A — no baseline captured.

## Proof of Work
\`\`\`text
manual review
PASS
\`\`\`
`,
      verificationLedger: {
        version: 1,
        supported_modes: [
          "manual_observation",
        ],
        evidence: [
          {
            id: "ev_mobile_001",
            subject: "plan:responsive-ui-mobile",
            mode: "manual_observation",
            status: "passed",
            actor: "agent",
            environment: "browser",
            command: "Manual narrow-viewport observation",
            artifacts: ["artifacts/mobile-proof.txt"],
            guard_type: "mobile_responsiveness",
            manual_ack: true,
          },
        ],
      },
      intentContract: learnedObligationIntentContract(),
    });

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close accepts active learned obligations once structured evidence is recorded");
    assert(gate.stdout.toLowerCase().includes("learned obligation(s) satisfied"), "reflect-to-close reports the satisfied learned-obligation contract");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function seedPlanLearnedObligationParityFixture(tmp, { evidence = null, futureOnly = false } = {}) {
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  const planName = "plan_2026-07-13_learned_parity";
  const planDir = join(tmp, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
  writeJson(join(tmp, "reports", "user_story_audit", "story_registry.json"), { version: 1, stories: [] });
  writeJson(join(planDir, "state.json"), {
    state: "PLAN",
    goal: futureOnly ? "Exercise a future learned obligation" : "Repair a planner dogfood false-green",
    plan_shape: { primary: "planner-core", source: "planned_files" },
  });
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
${futureOnly ? "Exercise a future learned obligation" : "Repair a planner dogfood false-green"}

## Problem Statement
${futureOnly ? "A future obligation must remain advisory before its required phase." : "The planner dogfood false-green must require a live truth packet before execution."}

## Files To Modify
- .agent/skills/iterative-planner/scripts/verify_gate.mjs

## Active Mistake Response
| Mistake | Guard | Planned handling | Planned evidence |
|---|---|---|---|
| M-PLANNER-DOGFOOD-001 | planner_truth_packet | Review the deterministic packet | verification_ledger.json |

## Verification Strategy
Use the live planner truth packet evidence surface.
`);
  writeFileSync(join(planDir, "findings.md"), "# Findings\n");
  writeFileSync(join(planDir, "verification.md"), "# Verification\n");
  writeFileSync(join(planDir, "reflection.md"), "# Reflection\n");
  writeFileSync(join(planDir, "red_team_notes.md"), "# Red Team Notes\n");
  writeFileSync(join(planDir, "decisions.md"), "# Decisions\n");
  writeJson(join(planDir, "intent_contract.json"), { version: 1, desired_outcomes: [], anti_goals: [], constraints: [], deliverables: [] });
  if (evidence) writeJson(join(planDir, "verification_ledger.json"), { version: 1, evidence: [evidence], waivers: [] });
  if (futureOnly) {
    writeJson(join(tmp, "planner.learned_obligations.json"), {
      version: 1,
      obligations: [
        {
          id: "future_phase_fixture",
          subject_id: "future_phase_proof",
          verification_mode: "artifact_review",
          status: "active",
          severity: "required",
          required_by_phase: "reflect",
          minimum_trigger_families: 1,
          triggers: { plan_terms: ["future learned obligation"] },
        },
      ],
    });
  }
  return planDir;
}

function prologLearnedObligationViolations(tmp, planDir, phase = "plan") {
  const planContent = readText(join(planDir, "plan.md"));
  const storyRegistry = readJson(join(tmp, "reports", "user_story_audit", "story_registry.json"));
  const serialized = serializeToFacts({ cwd: tmp, storyRegistry, planDir, planContent, annotations: [] });
  const session = createSession();
  session.consultFile(join(skillDir, "prolog", "invariants.pl"));
  session.consult(`current_state(${phase}).\n` + serialized.facts);
  return session.queryAll("invariant_violated(Name, Detail)")
    .map((entry) => ({ name: String(entry.Name), detail: String(entry.Detail) }));
}

function scenarioPlanLearnedObligationParity() {
  assert(summarizeLearnedObligationsSignal({ required: false, satisfied: true, active_obligations: [] }, { phase: "plan" }).detail.includes("No learned verification obligations"), "learned-obligation diagnostic summarizes the not-required PLAN branch");
  assert(summarizeLearnedObligationsSignal({ required: false, satisfied: true }, { phase: "plan" }).active_obligations === undefined, "learned-obligation diagnostic tolerates a missing active-obligations array");
  assert(summarizeLearnedObligationsSignal({ required: true, satisfied: true, satisfied_count: 1, active_count: 1, active_obligations: [{ satisfied: true }] }, { phase: "plan" }).detail.includes("1/1 learned obligation"), "learned-obligation diagnostic summarizes the satisfied PLAN branch");
  assert(summarizeLearnedObligationsSignal({ required: true, satisfied: true, active_obligations: [{ satisfied: true }] }, { phase: "plan" }).detail.includes("0/1 learned obligation"), "learned-obligation diagnostic uses safe fallback counts when aggregate counts are absent");
  const degradedSummary = summarizeLearnedObligationsSignal({
    required: true,
    satisfied: false,
    active_obligations: [
      {
        id: "planner_dogfood_truth_packet",
        subject_id: "planner_truth_packet",
        verification_mode: "artifact_review",
        satisfied: false,
        source_registry_degraded: true,
        source_mistake: "M-PLANNER-DOGFOOD-001",
        source_registry_status: "unusable",
      },
    ],
  }, { phase: "plan" });
  assert(degradedSummary.detail.includes("source mistake registry degraded"), "learned-obligation diagnostic preserves degraded-registry detail");
  assert(degradedSummary.detail.includes("planner_truth_packet"), "learned-obligation diagnostic preserves missing-subject detail");

  const missingRoot = makeTemp("learned-plan-missing");
  try {
    const planDir = seedPlanLearnedObligationParityFixture(missingRoot);
    const signal = computePlanLearnedObligationsSignal({ cwd: missingRoot, planDir, requiredAtOrBefore: "plan" });
    assert(!signal.required && signal.satisfied, "planner truth evidence is not prematurely required in PLAN");
    assert(!signal.active_ids.includes("planner_dogfood_truth_packet"), "shared live loader keeps the final dogfood obligation inactive before VALIDATE");
    const gate = runNode([verifyGateScript, "plan-to-execute", "--plan", planDir], missingRoot, { PLANNER_VERBOSE_CHECKS: "1" });
    assert(gate.stdout.includes("[PASS] [GATE-PLN-038]"), "JS plan-to-execute gate leaves final truth-packet proof for VALIDATE");
    assert(!prologLearnedObligationViolations(missingRoot, planDir).some((entry) => entry.name === "missing_learned_obligation"), "Prolog does not demand final truth-packet proof in PLAN");
    const validateSignal = computePlanLearnedObligationsSignal({ cwd: missingRoot, planDir, requiredAtOrBefore: "validate" });
    assert(validateSignal.required && !validateSignal.satisfied, "the same missing truth packet becomes mandatory by VALIDATE");
    assert(validateSignal.active_ids.includes("planner_dogfood_truth_packet"), "shared live loader activates the planner dogfood obligation by VALIDATE");
    assert(prologLearnedObligationViolations(missingRoot, planDir, "validate").some((entry) => entry.name === "missing_learned_obligation" && entry.detail.includes("planner_truth_packet")), "Prolog enforces the same truth-packet obligation in VALIDATE");
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }

  const passingRoot = makeTemp("learned-plan-passing");
  try {
    const planDir = seedPlanLearnedObligationParityFixture(passingRoot, {
      evidence: {
        id: "ev_truth_packet",
        subject_id: "planner_truth_packet",
        mode: "artifact_review",
        status: "passed",
        evidence_refs: ["artifacts/planner-truth-packet-review.json"],
      },
    });
    const signal = computePlanLearnedObligationsSignal({ cwd: passingRoot, planDir, requiredAtOrBefore: "plan" });
    assert(!signal.required && signal.satisfied, "early structured truth-packet evidence remains accepted without becoming PLAN ritual");
    const gate = runNode([verifyGateScript, "plan-to-execute", "--plan", planDir], passingRoot, { PLANNER_VERBOSE_CHECKS: "1" });
    assert(gate.stdout.includes("[PASS] [GATE-PLN-038]"), "JS gate accepts the same passing structured evidence row");
    assert(!prologLearnedObligationViolations(passingRoot, planDir).some((entry) => entry.name === "missing_learned_obligation"), "Prolog accepts the same passing structured evidence row");
  } finally {
    rmSync(passingRoot, { recursive: true, force: true });
  }

  const futureRoot = makeTemp("learned-plan-future");
  try {
    const planDir = seedPlanLearnedObligationParityFixture(futureRoot, { futureOnly: true });
    const signal = computePlanLearnedObligationsSignal({ cwd: futureRoot, planDir, requiredAtOrBefore: "plan" });
    assert(!signal.required && signal.satisfied, "future-phase learned obligation does not block the PLAN JS signal");
    assert(!prologLearnedObligationViolations(futureRoot, planDir).some((entry) => entry.name === "missing_learned_obligation"), "future-phase learned obligation does not block Prolog at PLAN");
  } finally {
    rmSync(futureRoot, { recursive: true, force: true });
  }
}

function scenarioInactiveVerificationFamiliesDoNotImposeProof() {
  const planContent = `# Plan

## Success Criteria
1. Migration compatibility remains intact.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-001 | Verification strategy reader and managed migration path | proof:migration_parity | Run migration smoke | Managed install matches source | Remote fleet remains out of scope |
`;
  const synthesis = {
    required: true,
    obligations: [{ id: "migration_parity", label: "migration parity" }],
  };
  const analysis = analyzeVerificationMatrix({ planContent, synthesis });
  assert(analysis.satisfied, "inactive domain families cannot impose proof from overloaded matrix wording");
  assert(!analysis.row_family_matches.some((entry) => entry.family_ids.includes("quant_modeling")), "matrix family matches contain only synthesized active families");

  const weak = analyzeVerificationMatrix({
    planContent: planContent.replace("proof:migration_parity", "proof:unit_test"),
    synthesis,
  });
  assert(!weak.satisfied, "active migration proof remains enforced after inactive-family filtering");
}

function scenarioAmbientScopeAcknowledgementIsAdvisory() {
  const tmp = makeTemp("ambient-scope-advisory");
  try {
    const planDir = seedPlanLearnedObligationParityFixture(tmp, { futureOnly: true });
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(join(tmp, `ambient-change-${index}.txt`), "unowned ambient work\n");
    }
    const gate = runNode([verifyGateScript, "plan-to-execute", "--plan", planDir], tmp, { PLANNER_VERBOSE_CHECKS: "1" });
    assert(gate.stdout.includes("[WARN] [GATE-PLN-018] Ambient dirty scope acknowledged"), "missing ambient acknowledgement is advisory when scope quarantine is deterministic");
    assert(!gate.stdout.includes("[FAIL] [GATE-PLN-018] Ambient dirty scope acknowledged"), "ambient wording cannot hard-block PLAN");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function scenarioReflectGateRequiresVerificationObligationReporting() {
  const tmp = makeTemp("verification-obligation-reporting");
  try {
    const goal = "Harden recipe orchestration verification reporting";
    const planDir = seedProject(tmp, goal);

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
${goal}

## Problem Statement
Recipe orchestration work should disclose what systems were exercised and what remains unverified before close.

## Files To Modify
- recipes/customer-sync/recipe.json
- scripts/customer_sync_wrapper.mjs
- tests/customer_sync_wrapper.test.mjs

## Verification Strategy
Record recipe close proof.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Recipe reporting updated | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Wrapper test fixture noted |
| Context-appropriate integration tested | PENDING | Missing closeout reporting |
| Audit reviewed | PENDING | Missing closeout reporting |
| Live approved | NOT REQUESTED | Out of scope |

## Regression Audit
Captured.

## Proof of Work
\`\`\`text
node .agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs
PASS
\`\`\`
`,
    });

    const missingReporting = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!missingReporting.ok, "verify_gate reflect-to-close blocks synthesized verification obligations without reporting sections");
    assert(missingReporting.stdout.includes("Systems Exercised"), "reflect-to-close explains that Systems Exercised reporting is required for synthesized obligations");

    writeFileSync(join(planDir, "verification.md"), `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Recipe reporting updated | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Wrapper smoke fixture noted |
| Context-appropriate integration tested | PASS | Recipe dry-run path exercised in the simulated closeout |
| Audit reviewed | PASS | Audit-style artifact review recorded below |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Recipe runner dry-run path
- Wrapper command path

## Remaining Unverified
Live operator approval remains out of scope for this fixture.

## Verification Sufficiency
This fixture represents recipe/orchestration closeout, so dry-run plus explicit systems-exercised and residual-risk reporting is the strongest local proof needed here.

## Regression Audit
Captured.

## Proof of Work
\`\`\`text
node .agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs
PASS
\`\`\`
`);

    const satisfied = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(satisfied.ok, "verify_gate reflect-to-close accepts synthesized verification obligations once reporting sections are recorded");
    assert(satisfied.stdout.includes("synthesized obligations reported"), "reflect-to-close reports the satisfied synthesized-obligation reporting contract");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReflectCloseBlocksSemanticSubstrateGaps() {
  const tmp = makeTemp("semantic-substrate-close-fail");
  try {
    const planDir = seedProject(tmp, "semantic substrate reflect-to-close blocker");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Keep mock mode and provider selection aligned

## Problem Statement
Close should fail when relevant semantic-substrate config gaps remain unresolved.

## Files To Modify
- src/config/runtime.ts

## Verification Strategy
Record close proof for the config-handling fixture.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Config close proof recorded | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Close-gate regression fixture recorded |
| Context-appropriate integration tested | NOT REQUESTED | No operational runtime is exercised in this fixture |
| Audit reviewed | NOT REQUESTED | Out of scope |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- verify_gate semantic-substrate close path

## Remaining Unverified
None — this fixture only validates semantic-substrate close behavior.

## Verification Sufficiency
A direct close-gate regression is sufficient because the change under test is the planner close contract itself.

## Regression Audit
Captured.

## Proof of Work
\`\`\`text
node verify_gate.mjs reflect-to-close
PASS
\`\`\`
`,
    });

    writeStructuredCloseSignals(planDir, buildSatisfiedCloseSignals({
      semantic_substrate: {
        required: true,
        satisfied: false,
        status: "missing_relevant_gaps",
        relevant_domains: ["config"],
        advisory_gap_ids: ["missing_mutually_exclusive_facts"],
        blocking_gap_ids: ["missing_mutually_exclusive_facts"],
        sources_present: {
          annotations: false,
          story_registry: false,
          persona_artifacts: true,
        },
        detail: "Relevant semantic substrate gaps: missing_mutually_exclusive_facts",
      },
    }));

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!gate.ok, "verify_gate reflect-to-close blocks task-relevant semantic-substrate gaps");
    assert(gate.stdout.includes("GATE-REF-016") && gate.stdout.includes("missing_mutually_exclusive_facts"), "reflect-to-close prints the blocking semantic-substrate gap digest");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReflectCloseDowngradesRitualOnlySemanticSubstrateDrift() {
  const tmp = makeTemp("semantic-substrate-close-ritual-only");
  try {
    const planDir = seedProject(tmp, "semantic substrate reflect-to-close ritual-only downgrade");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Keep lightweight config wording honest without over-promoting weak hints

## Problem Statement
Close should warn instead of fail when only ritual-only semantic-substrate drift remains.

## Files To Modify
- docs/planner.md

## Verification Strategy
Record close proof for the anti-ritual semantic-substrate fixture.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Ritual-only semantic-substrate drift downgrades to WARN | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Close-gate regression fixture recorded |
| Context-appropriate integration tested | NOT REQUESTED | Documentation-only fixture |
| Audit reviewed | NOT REQUESTED | Out of scope |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- verify_gate anti-ritual semantic-substrate close path

## Remaining Unverified
None — this fixture only validates anti-ritual close behavior.

## Verification Sufficiency
A direct close-gate regression is sufficient because the change under test is the planner close contract itself.

## Regression Audit
Captured.

## Proof of Work
\`\`\`text
node verify_gate.mjs reflect-to-close
WARN
\`\`\`
`,
    });

    writeStructuredCloseSignals(planDir, buildSatisfiedCloseSignals({
      semantic_substrate: {
        required: true,
        satisfied: false,
        status: "missing_relevant_gaps",
        relevant_domains: [],
        relevance_evidence: {
          config: "weak",
          story_semantics: "none",
        },
        advisory_gap_ids: ["missing_mutually_exclusive_facts"],
        blocking_gap_ids: [],
        scope_degraded: true,
        scope_degraded_reason: "missing_planned_files",
        detail: "Relevant semantic substrate gaps remain: missing_mutually_exclusive_facts",
      },
    }));

    const moduleCheck = runNode([
      "--input-type=module",
      "-e",
      `import { evaluateGateResults } from ${JSON.stringify(pathToFileURL(verifyGateScript).href)};
const evaluation = evaluateGateResults(${JSON.stringify(planDir)}, "reflect-to-close");
console.log(JSON.stringify(evaluation));`,
    ], tmp);
    assert(moduleCheck.ok, "evaluateGateResults loads for the ritual-only semantic-substrate fixture");
    const evaluation = JSON.parse(moduleCheck.stdout);
    const semanticRow = evaluation?.results?.find((entry) => entry?.code === "GATE-REF-016");
    assert(semanticRow?.status === "FAIL", "evaluateGateResults keeps ritual-only semantic-substrate drift enforced");
    assert(evaluation?.anti_ritual?.status === "advisory", "evaluateGateResults still surfaces the anti-ritual summary even while keeping the gate enforced");

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close refreshes real plan artifacts on the public CLI surface");
    assert(!gate.stdout.includes("[FAIL] [GATE-REF-016]"), "reflect-to-close does not preserve synthetic ritual-only close signals once the CLI refresh recomputes real file truth");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSemanticChecksReuseSharedRefreshSnapshot() {
  const tmp = makeTemp("shared-refresh-snapshot");
  try {
    const planDir = seedProject(tmp, "reuse the shared refresh snapshot");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Keep contradictory config modes aligned

## Files To Modify
- \`src/config/runtime.ts\`
`,
      verificationContent: `# Verification

## Verification Results
PASS

## Proof of Work
\`\`\`text
semantic snapshot reuse fixture
\`\`\`
`,
    });

    writeStructuredCloseSignals(planDir, buildSatisfiedCloseSignals({
      semantic_substrate: {
        required: true,
        satisfied: true,
        status: "satisfied",
        relevant_domains: ["config"],
        relevance_evidence: {
          config: "strong",
          story_semantics: "none",
        },
        advisory_gap_ids: [],
        blocking_gap_ids: [],
        detail: "Relevant semantic substrate present for config",
      },
    }));

    const moduleCheck = runNode([
      "--input-type=module",
      "-e",
      `import { runSemanticChecks } from ${JSON.stringify(pathToFileURL(ruleEngineScript).href)};
const refreshSnapshot = {
  closeSignals: {
    semantic_substrate: {
      required: true,
      satisfied: false,
      status: "missing_relevant_gaps",
      relevant_domains: ["config"],
      relevance_evidence: { config: "strong", story_semantics: "none" },
      advisory_gap_ids: ["missing_mutually_exclusive_facts"],
      blocking_gap_ids: ["missing_mutually_exclusive_facts"],
      detail: "Relevant semantic substrate gaps: missing_mutually_exclusive_facts"
    }
  },
  ontology: { facts: "" }
};
const results = runSemanticChecks("reflect-to-validate", ${JSON.stringify(planDir)}, { refreshSnapshot });
console.log(JSON.stringify(results));`,
    ], tmp);
    assert(moduleCheck.ok, "runSemanticChecks accepts a shared refresh snapshot");
    const results = JSON.parse(moduleCheck.stdout);
    const semanticRow = results.find((entry) => entry?.code === "GATE-SEM-001");
    assert(semanticRow?.status === "FAIL", "runSemanticChecks reuses the shared refresh snapshot instead of recomputing permissive close signals");
    assert(String(semanticRow?.detail || "").includes("semantic_substrate_incomplete"), "shared refresh snapshot drives the expected semantic blocker detail");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReflectProgressAuthorityParity() {
  const routingTmp = makeTemp("reflect-progress-routing");
  const administrativeTmp = makeTemp("reflect-progress-administrative");
  const substantiveTmp = makeTemp("reflect-progress-substantive");

  const prepareFixture = (tmp, progressItem) => {
    const planDir = seedProject(tmp, "repair reflect progress authority parity in planner core");
    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Maintain final notes

## Problem Statement
The final note should distinguish future lifecycle administration from unfinished delivery work.

## Files To Modify
- docs/final-notes.md

## Verification Strategy
Exercise the real lifecycle boundary and inspect its authoritative receipt.
`,
      verificationContent: `# Verification

## Remaining Unverified
Final notification happens only after the governed close lifecycle.
`,
    });
    writeFileSync(join(planDir, "reflection.md"), `# Reflection

## Solution Verdict
PASS — the closeout-note scope is complete.

## Semantic Verdict
PASS — the fixture keeps lifecycle administration distinct from delivery work.

## Evidence-Readiness Verdict
PASS — the real transition and receipt are the required evidence.

## Next Move
PASS — proceed to VALIDATE.

## Knowledge Base Sign-Off
Decision: no new learnings beyond this bounded regression fixture.
`);
    writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Revised the closeout note.

## Remaining
- [ ] ${progressItem}
`);
    return planDir;
  };

  try {
    symlinkSync(agentDir, join(routingTmp, ".agent"), "dir");
    const lightweightRoute = runNode([bootstrapScript, "new", "maintain final notes"], routingTmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(lightweightRoute.ok && lightweightRoute.stdout.includes("No plan was created."), "non-force administrative bootstrap preserves canonical lightweight routing");
    assert(!existsSync(join(routingTmp, "plans", ".current_plan")), "lightweight administrative routing creates no iterative plan pointer");

    const administrativePlanDir = prepareFixture(
      administrativeTmp,
      "Reconcile the Program ticket lifecycle after this child plan reaches close.\n- [ ] Notify the user after the governed close lifecycle."
    );
    const administrative = runNode([transitionScript, "reflect-to-validate"], administrativeTmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const administrativeReceipt = readJson(join(
      administrativePlanDir,
      "artifacts",
      "transition_receipts",
      "latest_reflect-to-validate.json"
    ));
    const administrativeProgress = readJson(join(administrativePlanDir, "state.json")).close_signals?.progress;
    if (!administrative.ok) {
      console.log(`  DEBUG: administrative hard blocks ${JSON.stringify(administrativeReceipt.hard_blocks)}`);
      console.log(`  DEBUG: administrative advisories ${JSON.stringify(administrativeReceipt.advisories)}`);
    }

    assert(administrative.ok, "real reflect-to-validate advances when only administrative lifecycle progress remains");
    assert(readJson(join(administrativePlanDir, "state.json")).state === "VALIDATE", "administrative progress fixture reaches VALIDATE");
    assert(administrativeProgress?.satisfied === false && administrativeProgress?.blocking_satisfied === true, "administrative fixture preserves aggregate advisory state and explicit hard-boundary satisfaction");
    assert(administrativeProgress?.administrative_open_items?.length === 2 && administrativeProgress?.blocking_open_items?.length === 0, "administrative fixture exposes the actual Program reconciliation and user-notification items as nonblocking");
    assert(administrativeReceipt.status === "PASS" && administrativeReceipt.advisories.some((row) => row.code === "GATE-REF-003"), "administrative receipt retains the visible GATE-REF-003 advisory");
    assert(!administrativeReceipt.failure_codes.some((code) => ["GATE-CHK-011", "GATE-SEM-001", "GATE-SEM-003"].includes(code)), "administrative receipt has no checklist or semantic mirror hard block");

    const substantivePlanDir = prepareFixture(
      substantiveTmp,
      "Implement the remaining parser fix and run its regression test."
    );
    const substantive = runNode([transitionScript, "reflect-to-validate"], substantiveTmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const substantiveReceipt = readJson(join(
      substantivePlanDir,
      "artifacts",
      "transition_receipts",
      "latest_reflect-to-validate.json"
    ));
    const substantiveState = readJson(join(substantivePlanDir, "state.json"));
    const substantiveProgress = substantiveState.close_signals?.progress;
    if (!["GATE-REF-021", "GATE-CHK-011", "GATE-SEM-001"].every((code) => substantiveReceipt.failure_codes.includes(code))) {
      console.log(`  DEBUG: substantive hard blocks ${JSON.stringify(substantiveReceipt.hard_blocks)}`);
    }

    assert(!substantive.ok && substantiveState.state === "REFLECT", "real reflect-to-validate keeps substantive unfinished work in REFLECT");
    assert(substantiveProgress?.satisfied === false && substantiveProgress?.blocking_satisfied === false, "substantive fixture exposes an unsatisfied aggregate and hard boundary");
    assert(substantiveProgress?.blocking_open_items?.length === 1 && substantiveProgress?.administrative_open_items?.length === 0, "substantive fixture exposes the classified item arrays");
    assert(["GATE-REF-021", "GATE-CHK-011", "GATE-SEM-001"].every((code) => substantiveReceipt.failure_codes.includes(code)), "substantive receipt records aligned JavaScript, checklist, and Prolog hard codes");
    assert(!substantiveReceipt.failure_codes.includes("GATE-SEM-003"), "substantive control does not create JS/Prolog divergence");
  } finally {
    try { rmSync(routingTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(administrativeTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(substantiveTmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReflectCloseAcceptsSatisfiedAndIrrelevantSemanticSubstrate() {
  const tmpSatisfied = makeTemp("semantic-substrate-close-pass");
  try {
    const satisfiedPlanDir = seedProject(tmpSatisfied, "semantic substrate reflect-to-close satisfied");
    mkdirSync(join(tmpSatisfied, "src", "config"), { recursive: true });
    mkdirSync(join(tmpSatisfied, "tests"), { recursive: true });
    writeFileSync(join(tmpSatisfied, "src", "config", "runtime.ts"), `// @planner:config_flag = llm_mode_mock
// @planner:mutually_exclusive = provider_openai
export const runtimeMode = process.env.LLM_MODE;
`);
    writeFileSync(join(tmpSatisfied, "tests", "runtime.test.mjs"), "console.log('runtime config smoke');\n");

    prepareReflectCloseFixture(tmpSatisfied, satisfiedPlanDir, {
      planContent: `# Plan

## Goal
Keep mock mode and provider selection aligned

## Problem Statement
Close should pass once the relevant semantic substrate is satisfied.

## Files To Modify
- src/config/runtime.ts
- tests/runtime.test.mjs

## Verification Strategy
Record close proof for the config-handling fixture.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Config close proof recorded | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | npm test recorded below |
| Context-appropriate integration tested | PASS | Runtime config smoke was exercised via the regression fixture |
| Audit reviewed | PASS | Config-close review completed in this deterministic fixture |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Runtime config parsing path
- verify_gate semantic-substrate close path

## Remaining Unverified
None — this fixture only validates semantic-substrate close behavior.

## Verification Sufficiency
A direct close-gate regression is sufficient because the change under test is the planner close contract itself.

## Regression Audit
Captured.

## Proof of Work
\`\`\`text
$ npm test
55 passed, 0 failed
\`\`\`
`,
    });

    const satisfiedGate = runNode([verifyGateScript, "reflect-to-close"], tmpSatisfied);
    assert(satisfiedGate.ok, "verify_gate reflect-to-close passes once the relevant semantic substrate is satisfied");
    assert(satisfiedGate.stdout.includes("Structured close signal: relevant semantic substrate present for config"), "reflect-to-close reports the satisfied semantic-substrate detail");
  } finally {
    try { rmSync(tmpSatisfied, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const tmpIrrelevant = makeTemp("semantic-substrate-not-required");
  try {
    const irrelevantPlanDir = seedProject(tmpIrrelevant, "semantic substrate not required");

    prepareReflectCloseFixture(tmpIrrelevant, irrelevantPlanDir, {
      planContent: `# Plan

## Goal
Refresh planner documentation

## Problem Statement
Close should pass when semantic substrate is not relevant for the active task shape.

## Files To Modify
- docs/planner.md

## Verification Strategy
Record close proof for the documentation fixture.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Documentation close proof recorded | Regression | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Close-gate regression fixture recorded |
| Context-appropriate integration tested | NOT REQUESTED | Documentation-only fixture |
| Audit reviewed | NOT REQUESTED | Out of scope |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- verify_gate semantic-substrate close path

## Remaining Unverified
None — this fixture only validates semantic-substrate close behavior.

## Verification Sufficiency
A direct close-gate regression is sufficient because the change under test is the planner close contract itself.

## Regression Audit
Captured.

## Proof of Work
\`\`\`text
node verify_gate.mjs reflect-to-close
PASS
\`\`\`
`,
    });

    const irrelevantGate = runNode([verifyGateScript, "reflect-to-close"], tmpIrrelevant);
    assert(irrelevantGate.ok, "verify_gate reflect-to-close passes when semantic substrate is not relevant for the task shape");
    assert(irrelevantGate.stdout.includes("Structured close signal: semantic substrate not required for this plan"), "reflect-to-close reports that semantic substrate is not required when the domain is irrelevant");
  } finally {
    try { rmSync(tmpIrrelevant, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLearnedObligationCloseBlocksDegradedSourceRegistry() {
  const tmp = makeTemp("learned-obligation-degraded-registry");
  try {
    const goal = "Clone responsive landing page";
    const { planDir, copiedVerifyGateScript } = seedCopiedPlannerProject(tmp, goal);
    const copiedRegistryPath = join(tmp, ".agent", "skills", "iterative-planner", "config", "mistake_registry.json");
    writeFileSync(copiedRegistryPath, "{ invalid json\n");

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Clone responsive landing page

## Problem Statement
Responsive UI work should not close green if the shipped source mistake registry is degraded.

## Files To Modify
- public/landing.html
- public/landing.css

## Verification Strategy
Record the close proof for responsive mobile behavior.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Landing page updated | Review | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Fixture seeded |
| Locally / unit tested | PASS | Static UI path uses manual-observation intent contract |
| Context-appropriate integration tested | PASS | Responsive-browser proof is recorded in the verification ledger |
| Audit reviewed | NOT REQUESTED | Browser-only fixture |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Browser narrow-viewport rendering path for \`landing_page\`

## Remaining Unverified
None — the degraded source registry itself is the only unresolved issue under test.

## Verification Sufficiency
The responsive browser observation would otherwise be sufficient for this fixture; the remaining block is the degraded source registry contract.

## Regression Audit
N/A — no baseline captured.

## Proof of Work
\`\`\`text
manual review
PASS
Scope: responsive mobile proof recorded in verification ledger
\`\`\`
`,
      verificationLedger: {
        version: 1,
        supported_modes: [
          "manual_observation",
        ],
        evidence: [
          {
            id: "ev_mobile_001",
            subject: "plan:responsive-ui-mobile",
            mode: "manual_observation",
            status: "passed",
            actor: "agent",
            environment: "browser",
            command: "Manual narrow-viewport observation",
            artifacts: ["artifacts/mobile-proof.txt"],
            guard_type: "mobile_responsiveness",
            manual_ack: true,
          },
        ],
      },
      intentContract: learnedObligationIntentContract(),
    });

    const gate = runNode([copiedVerifyGateScript, "reflect-to-close"], tmp);
    assert(!gate.ok, "verify_gate reflect-to-close blocks active learned obligations when their source mistake registry is degraded");
    assert(gate.stdout.toLowerCase().includes("source mistake registry"), "reflect-to-close explains the degraded source mistake registry");
    assert(gate.stdout.includes("responsive_ui_mobile"), "reflect-to-close identifies which learned obligation is relying on the degraded registry");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function snapshotPlannerWritableSurfaces(cwd) {
  const snapshot = {};
  function walk(absolutePath, relativePath) {
    if (!existsSync(absolutePath)) return;
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort()) {
        walk(join(absolutePath, entry), join(relativePath, entry));
      }
      return;
    }
    if (stat.isFile()) {
      snapshot[relativePath.replace(/\\/g, "/")] = createHash("sha256")
        .update(readFileSync(absolutePath))
        .digest("hex");
    }
  }
  for (const surface of ["plans", "reports"]) {
    walk(join(cwd, surface), surface);
  }
  return snapshot;
}

function parseJsonCommandOutput(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function scenarioRuleEngineSmokeModeDoesNotWrite() {
  const tmp = makeTemp("rule-engine-smoke");
  try {
    const planDir = seedProject(tmp, "rule engine non-writing invariant smoke");
    const statePath = join(planDir, "state.json");
    const beforeState = readText(statePath);
    const beforeSurfaces = snapshotPlannerWritableSurfaces(tmp);

    const smoke = runNode([ruleEngineScript, "check-invariants", "--smoke", "--json"], tmp);
    const smokePayload = parseJsonCommandOutput(smoke);
    assert(smoke.ok || smoke.status === 1, "rule_engine check-invariants --smoke evaluates the real invariant engine");
    assert(smokePayload?.mode === "smoke" && smokePayload?.write_policy === "none", "smoke JSON identifies the non-writing policy");
    assert(smokePayload?.proof_persisted === false, "smoke JSON truthfully reports that no proof was persisted");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) === JSON.stringify(beforeSurfaces), "check-invariants --smoke leaves every plan/report file byte-identical");
    assert(readText(statePath) === beforeState, "check-invariants --smoke leaves state.json unchanged");
    assert(!existsSync(join(planDir, "ontology_facts.pl")), "check-invariants --smoke does not persist transient ontology facts");

    const evidence = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    const evidencePayload = parseJsonCommandOutput(evidence);
    assert(evidence.ok || evidence.status === 1, "default check-invariants evaluates the same real invariant engine");
    assert(evidence.status === smoke.status, "smoke and evidence modes preserve exit semantics");
    for (const field of ["semantic_transition_targets", "violations", "warnings", "count", "warning_count", "status"]) {
      assert(JSON.stringify(evidencePayload?.[field]) === JSON.stringify(smokePayload?.[field]), `smoke and evidence payloads preserve ${field}`);
    }
    assert(evidencePayload?.mode === "evidence" && evidencePayload?.write_policy === "proof_trace", "default JSON identifies the governed evidence policy");
    assert(evidencePayload?.proof_persisted === true, "default evidence mode truthfully reports proof persistence");
    assert(JSON.stringify(snapshotPlannerWritableSurfaces(tmp)) !== JSON.stringify(beforeSurfaces), "default evidence mode changes the governed proof surface");
    const proofDir = join(planDir, "artifacts", "prolog");
    assert(readdirSync(proofDir).some((name) => name.startsWith("check-invariants_")), "default evidence mode writes a check-invariants proof trace");

    const conflicts = runNode([ruleEngineScript, "find-conflicts", "--json"], tmp);
    assert(conflicts.ok || conflicts.status === 1, "rule_engine find-conflicts returns a read-only report");
    assert(readText(statePath) === beforeState, "rule_engine find-conflicts also leaves state.json unchanged");

    const misuse = runNode([ruleEngineScript, "find-conflicts", "--smoke", "--json"], tmp);
    assert(misuse.status === 2, "--smoke fails closed when supplied to another command");
    assert(misuse.stderr.includes("supported only by the check-invariants command"), "misuse diagnostic names the flag scope");

    const help = runNode([ruleEngineScript, "--help"], tmp);
    assert(help.stdout.includes("check-invariants --smoke"), "rule_engine help documents non-writing invariant smoke mode");

    const noPlan = makeTemp("rule-engine-smoke-no-plan");
    try {
      symlinkSync(agentDir, join(noPlan, ".agent"), "dir");
      seedPreplanningStoryBaseline(noPlan);
      const noPlanSmoke = runNode([ruleEngineScript, "check-invariants", "--smoke", "--json"], noPlan);
      const noPlanPayload = parseJsonCommandOutput(noPlanSmoke);
      assert(noPlanSmoke.ok || noPlanSmoke.status === 1, "smoke mode evaluates without an active plan");
      assert(noPlanPayload?.proof_persisted === false, "smoke mode without an active plan reports no persisted proof");
    } finally {
      try { rmSync(noPlan, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioIntentEvidenceRequiredForClose() {
  const tmp = makeTemp("intent-close");
  try {
    const goal = "Generate a user-facing backtesting report for analysts";
    const planDir = seedProject(tmp, goal);

    prepareReflectCloseFixture(tmp, planDir, {
      planContent: `# Plan

## Goal
Generate a user-facing backtesting report for analysts

## Problem Statement
Closing should fail when the required report exists only nominally and no substantive evidence proves it is usable.

## Files To Modify
- reports/backtesting/latest.md

## Verification Strategy
Record evidence that the required report is substantive.
`,
      verificationContent: `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|-----------|--------|--------|
| 1 | Regression notes recorded | Review | PASS |

## Regression Audit
Regression notes captured.

\`\`\`text
manual review
PASS
\`\`\`
`,
      intentContract: {
        version: 1,
        primary_user: "Portfolio analyst",
        job_to_be_done: "Review a backtesting report and decide whether the strategy deserves deeper research",
        desired_outcomes: ["Understand whether the strategy beats a baseline"],
        anti_goals: ["Do not treat an empty report as success"],
        constraints: ["The report must state the split method"],
        deliverables: [
          {
            id: "backtest_report",
            name: "Backtesting report",
            kind: "report",
            purpose: "Support analyst review without hiding degenerate output",
            quality_bars: ["Contains substantive metrics and interpretation"],
            required_sections: ["Backtest window", "Baseline comparison"],
            required_signals: ["trade count"],
            anti_goals: ["Empty report", "Metric-free PASS"],
            evidence_mode: "artifact_review",
          },
        ],
      },
    });

    const missingEvidence = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(!missingEvidence.ok, "verify_gate reflect-to-close blocks required deliverables without substantive evidence");
    assert(missingEvidence.stdout.includes("Intent-driven deliverables still missing evidence or waiver: backtest_report"), "reflect-to-close identifies the missing deliverable evidence");

    writeJson(join(planDir, "verification_ledger.json"), {
      version: 1,
      evidence: [
        {
          id: "ev_backtest_report_001",
          subject: "deliverable:backtest_report",
          mode: "artifact_review",
          status: "passed",
          actor: "agent",
          command: "review reports/backtesting/latest.md",
          artifacts: ["reports/backtesting/latest.md"],
        },
      ],
    });

    const satisfied = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(satisfied.ok, "verify_gate reflect-to-close accepts required deliverables once substantive evidence is recorded");
    assert(satisfied.stdout.includes("Structured close signal: 1/1 required deliverable(s) have evidence or waiver"), "reflect-to-close reports satisfied deliverable evidence");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStalePlanReadWarns() {
  const tmp = makeTemp("stale-plan-read");
  try {
    const planDir = seedProject(tmp, "stale plan read warning");
    writeExploreFindings(planDir, "stale plan read warning");

    const stalePlanName = "plan_2026-04-03_oldread";
    const stalePlanDir = join(tmp, "plans", stalePlanName);
    mkdirSync(stalePlanDir, { recursive: true });
    const staleFindings = join(stalePlanDir, "findings.md");
    writeFileSync(staleFindings, "# Historical findings\n");

    writeRecentToolTrace(planDir, [
      {
        ts: "2026-04-04T10:00:00Z",
        seq: 1,
        tool: "Read",
        paths: [join(tmp, "plans", "knowledge", "index.md")],
        phase: "EXPLORE",
        plan_dir: planDir.split("/").pop(),
      },
      {
        ts: "2026-04-04T10:00:01Z",
        seq: 2,
        tool: "Read",
        paths: [staleFindings],
        phase: "EXPLORE",
        plan_dir: planDir.split("/").pop(),
      },
    ]);

    const gate = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(gate.ok, "transition explore-to-plan still passes with recent stale-plan reads");
    assert(gate.stdout.includes("Recent non-active plan context detected"), "transition surfaces a warning for recent stale-plan reads");
    assert(gate.stdout.includes("plans/ACTIVE_PLAN.md"), "transition warning points to the canonical active-plan alias");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStalePlanEditBlocks() {
  const tmp = makeTemp("stale-plan-edit");
  try {
    const planDir = seedProject(tmp, "stale plan edit blocker");
    writeExploreFindings(planDir, "stale plan edit blocker");

    const stalePlanName = "plan_2026-04-03_oldedit";
    const stalePlanDir = join(tmp, "plans", stalePlanName);
    mkdirSync(stalePlanDir, { recursive: true });
    const stalePlanFile = join(stalePlanDir, "plan.md");
    writeFileSync(stalePlanFile, "# Historical plan\n");

    writeRecentToolTrace(planDir, [
      {
        ts: "2026-04-04T10:00:00Z",
        seq: 1,
        tool: "Read",
        paths: [join(tmp, "plans", "knowledge", "index.md")],
        phase: "EXPLORE",
        plan_dir: planDir.split("/").pop(),
      },
      {
        ts: "2026-04-04T10:00:01Z",
        seq: 2,
        tool: "Edit",
        paths: [stalePlanFile],
        phase: "EXPLORE",
        plan_dir: planDir.split("/").pop(),
      },
    ]);

    const gate = runNode([transitionScript, "explore-to-plan"], tmp, { _PLANNER_FAST_TRACK: "1" });
    assert(!gate.ok, "transition explore-to-plan blocks recent stale-plan edits");
    assert(gate.stdout.includes("Recent non-active plan edits detected"), "transition reports the stale-plan edit blocker");
    assert(gate.stdout.includes("Failure codes: GATE-CTX-001"), "transition exposes the deterministic stale-plan edit failure code");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOpportunityStagnationBlocksPlanToExecute() {
  const tmp = makeTemp("stagnation-plan-execute");
  try {
    const planDir = seedProject(tmp, "opportunity stagnation plan to execute");
    writeExploreFindings(planDir, "opportunity stagnation plan to execute");
    writePlanForExecute(planDir);

    // Create a mock opportunity queue with a high-confidence opportunity
    mkdirSync(join(tmp, "reports", "stewardship"), { recursive: true });
    writeJson(join(tmp, "reports", "stewardship", "opportunity_queue.json"), {
      version: 1,
      opportunities: [
        {
          id: "OP-TEST-999",
          title: "Test High Confidence Opportunity",
          confidence: "high",
          action_tier: "draft_and_surface",
        }
      ]
    });

    // Run gate check — should fail because OP-TEST-999 is not in decisions.md or plan.md
    const blocked = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!blocked.ok, "stagnation check blocks plan-to-execute when high-confidence opportunity is unaddressed");
    assert(blocked.stdout.includes("Stagnation block"), "plan-to-execute output reports stagnation blocker");
    assert(blocked.stdout.includes("OP-TEST-999"), "plan-to-execute output names the stagnated opportunity ID");

    // Now, log decision in decisions.md
    writeFileSync(join(planDir, "decisions.md"), "## D-001 - Defer OP-TEST-999 because it is out of scope.\n");

    // Run gate check again — should pass now!
    const satisfied = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(satisfied.ok, "stagnation check passes plan-to-execute when opportunity is deferred in decisions.md");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOpportunityStagnationBlocksValidateToClose() {
  const tmp = makeTemp("stagnation-validate-close");
  try {
    const planDir = seedProject(tmp, "opportunity stagnation validate to close");

    // Setup validate-to-close fixture
    prepareValidateCloseTransitionFixture(tmp, planDir, {
      filesToModify: ["reports/user_story_audit/story_registry.json"],
    });

    // Create a mock opportunity queue with an escalate opportunity
    mkdirSync(join(tmp, "reports", "stewardship"), { recursive: true });
    writeJson(join(tmp, "reports", "stewardship", "opportunity_queue.json"), {
      version: 1,
      opportunities: [
        {
          id: "OP-TEST-888",
          title: "Test Escalate Opportunity",
          confidence: "medium",
          action_tier: "escalate",
        }
      ]
    });

    // Run gate check — should fail because OP-TEST-888 is not addressed or deferred
    const blocked = runNode([verifyGateScript, "validate-to-close"], tmp);
    assert(!blocked.ok, "stagnation check blocks validate-to-close when escalate opportunity is unaddressed");
    assert(blocked.stdout.includes("Stagnation block"), "validate-to-close output reports stagnation blocker");
    assert(blocked.stdout.includes("OP-TEST-888"), "validate-to-close output names the stagnated opportunity ID");

    // Now, log decision in decisions.md
    writeFileSync(join(planDir, "decisions.md"), "## D-001 - Defer OP-TEST-888 because we need more information.\n");

    // Run gate check again — should pass now!
    const satisfied = runNode([verifyGateScript, "validate-to-close"], tmp);
    assert(satisfied.ok, "stagnation check passes validate-to-close when opportunity is deferred in decisions.md");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTransitionBlocksMissingMistakeHookTarget() {
  const cleanIntegrity = mistakeHookTargetIntegrityResult([]);
  assert(cleanIntegrity.status === "PASS", "hook-target integrity helper accepts an empty missing-target set");
  const missingIntegrity = mistakeHookTargetIntegrityResult([{
    mistake_id: "M-DIRECT-MISSING",
    hook: "test_missing_direct",
    target_path: ".agent/skills/iterative-planner/tests/test_missing_direct.mjs",
  }]);
  assert(missingIntegrity.status === "FAIL", "hook-target integrity helper fails a missing target");
  assert(
    missingIntegrity.detail.includes("mistake_verification_hook_target_missing(M-DIRECT-MISSING, test_missing_direct)"),
    "hook-target integrity helper emits the deterministic diagnostic",
  );

  const tmp = makeTemp("missing-mistake-hook-target");
  try {
    const { planDir } = seedCopiedPlannerProject(tmp, "missing mistake hook target transition guard");
    const copiedSkillDir = join(tmp, ".agent", "skills", "iterative-planner");
    const copiedRegistryPath = join(copiedSkillDir, "config", "mistake_registry.json");
    const copiedRegistry = readJson(copiedRegistryPath);
    const copiedMistake = copiedRegistry.mistakes.find((entry) => entry.id === "M-001");
    copiedMistake.verification_hooks.push("test_missing_after_purge");
    writeJson(copiedRegistryPath, copiedRegistry);
    assert(
      copiedMistake.verification_hooks.includes("test_missing_after_purge"),
      "copied fixture retains the planted missing hook",
    );
    assert(
      !existsSync(join(copiedSkillDir, "tests", "test_missing_after_purge.mjs")),
      "copied fixture does not contain the planted hook target",
    );
    writeExploreFindings(planDir, "missing mistake hook target transition guard");

    const copiedTransitionScript = join(copiedSkillDir, "scripts", "transition.mjs");
    const blocked = runNode([copiedTransitionScript, "explore-to-plan"], tmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(!blocked.ok, "transition blocks a missing test-shaped mistake hook target");
    assert(
      blocked.stdout.includes("mistake_verification_hook_target_missing"),
      "transition reports the named missing-hook invariant",
    );
    assert(blocked.stdout.includes("M-001"), "transition identifies the owning mistake");
    assert(blocked.stdout.includes("test_missing_after_purge"), "transition identifies the missing hook target");

    copiedMistake.verification_hooks = copiedMistake.verification_hooks.filter(
      (hook) => hook !== "test_missing_after_purge",
    );
    writeJson(copiedRegistryPath, copiedRegistry);
    const overlayPath = join(tmp, "planner.mistake_overrides.json");
    const overlay = {
      version: 1,
      mistakes: [
        {
          id: "M-OVERLAY-MISSING-HOOK",
          title: "Active overlay missing-hook fixture",
          status: "active",
          verification_hooks: ["test_missing_overlay_target.mjs"],
        },
      ],
    };
    writeJson(overlayPath, overlay);

    const overlayBlocked = runNode([copiedTransitionScript, "explore-to-plan"], tmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(!overlayBlocked.ok, "transition validates active overlay hook targets");
    assert(
      overlayBlocked.stdout.includes("M-OVERLAY-MISSING-HOOK") &&
        overlayBlocked.stdout.includes("test_missing_overlay_target.mjs"),
      "active overlay failure names its mistake and missing target",
    );

    const outsideDir = join(dirname(tmp), `${basename(tmp)}-outside`);
    const outsideTestDir = join(outsideDir, "tests");
    mkdirSync(outsideTestDir, { recursive: true });
    writeFileSync(join(outsideTestDir, "test_escape.mjs"), "export default true;\n");
    overlay.mistakes[0].verification_hooks = [`../${basename(outsideDir)}/tests/test_escape.mjs`];
    writeJson(overlayPath, overlay);
    const outsideBlocked = runNode([copiedTransitionScript, "explore-to-plan"], tmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(!outsideBlocked.ok, "repo-relative hook paths cannot escape the repository even when the target exists");
    rmSync(outsideDir, { recursive: true, force: true });

    overlay.mistakes[0].status = "draft";
    writeJson(overlayPath, overlay);
    const draftAllowed = runNode([copiedTransitionScript, "explore-to-plan"], tmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(draftAllowed.ok, "draft overlay hook targets remain advisory and do not block transitions");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTransitionGuideFirstReceiptContract() {
  const blockedTmp = makeTemp("transition-guidance-blocked");
  const ritualTmp = makeTemp("transition-guidance-ritual");
  const cleanTmp = makeTemp("transition-guidance-clean");
  try {
    const blockedPlanDir = seedProject(blockedTmp, "transition guidance blocked fixture");
    writeFileSync(join(blockedPlanDir, "findings.md"), `# Findings

## Index
- F-001: One incomplete finding.

## F-001 - One incomplete finding
This deliberately omits the minimum finding depth, root cause, assumption ledger, and adjacency contract.
`);
    setPlanState(blockedPlanDir, "VALIDATE");
    const blocked = runNode([transitionScript, "explore-to-plan"], blockedTmp, { _PLANNER_FAST_TRACK: "1" });
    assert(!blocked.ok, "failed transition remains nonzero under the guide-first contract");
    assert(blocked.stdout.indexOf("Attempted Gate Preparation") < blocked.stdout.indexOf("Source-State Check"), "attempted-gate preparation runs before gate evaluation");
    assert(blocked.stdout.includes("RESULT: FAIL gate=explore-to-plan"), "failed transition renders the terminal verdict from the receipt");
    assert(blocked.stdout.includes("NEXT:"), "every rendered hard blocker publishes an exact NEXT action");
    assert(blocked.stdout.includes("WHY:"), "every rendered hard blocker publishes a WHY risk statement");
    const blockedReceiptPath = join(blockedPlanDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json");
    assert(existsSync(blockedReceiptPath), "failed transition persists an authoritative receipt");
    const blockedReceipt = readJson(blockedReceiptPath);
    assert(blockedReceipt.status === "FAIL" && blockedReceipt.hard_block_count > 0, "failed receipt agrees with the terminal verdict");
    assert(blockedReceipt.failure_codes.length > 0 && blockedReceipt.hard_blocks.every((row) => row.code && row.next && row.why), "no persisted hard transition has an empty code, NEXT, or WHY");
    assert(blockedReceipt.attempted_gate_preparation?.write_requested === false, "receipt records non-mutating attempted-gate preparation");

    const ritualPlanDir = seedProject(ritualTmp, "transition guidance ritual-only fixture");
    writeFileSync(join(ritualPlanDir, "findings.md"), `# Findings

## F-001 - Deliberately shallow planning note
This deliberately omits the minimum finding depth, root cause, assumption ledger, and adjacency contract.
`);
    const ritual = runNode([transitionScript, "explore-to-plan"], ritualTmp, { _PLANNER_FAST_TRACK: "1" });
    assert(ritual.ok, "ritual-only transition misses advance under the guide-first contract");
    const ritualReceipt = readJson(join(ritualPlanDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json"));
    assert(ritualReceipt.status === "PASS" && ritualReceipt.advisory_count > 0, "ritual-only misses remain visible in the passing receipt");

    const cleanPlanDir = seedProject(cleanTmp, "transition guidance clean fixture");
    writeFindingsLedger(cleanPlanDir);
    const clean = runNode([transitionScript, "explore-to-plan"], cleanTmp, { _PLANNER_FAST_TRACK: "1" });
    assert(clean.ok, "passing transition control advances successfully");
    assert(clean.stdout.includes("RESULT: PASS gate=explore-to-plan"), "passing transition renders the receipt-backed terminal verdict");
    const cleanReceipt = readJson(join(cleanPlanDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json"));
    assert(cleanReceipt.status === "PASS" && cleanReceipt.hard_block_count === 0, "passing receipt agrees with stdout and has no hard blockers");
  } finally {
    try { rmSync(blockedTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(ritualTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(cleanTmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTransitionIntegrityFailureReceipts() {
  const noPlanTmp = makeTemp("transition-no-plan");
  const prepareTmp = makeTemp("transition-prepare-unavailable");
  const thrashTmp = makeTemp("transition-thrash-guard");
  const circuitTmp = makeTemp("transition-circuit-breaker");
  const cooldownTmp = makeTemp("transition-cooldown");
  const decisionLogTmp = makeTemp("transition-decision-log-lock");
  const stateLockTmp = makeTemp("transition-state-lock");
  try {
    const noPlan = runNode([transitionScript, "explore-to-plan"], noPlanTmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(!noPlan.ok, "transition blocks when no canonical plan target exists");
    assert(noPlan.stdout.includes("GATE-PLAN-001"), "missing-plan verdict publishes the stable failure code");
    assert(noPlan.stdout.includes("NEXT:") && noPlan.stdout.includes("WHY:"), "missing-plan verdict publishes exact NEXT and WHY guidance");

    const { planDir: preparePlanDir } = seedCopiedPlannerProject(prepareTmp, "transition preparation unavailable fixture");
    writeFindingsLedger(preparePlanDir);
    const copiedSkillDir = join(prepareTmp, ".agent", "skills", "iterative-planner");
    const copiedTransitionScript = join(copiedSkillDir, "scripts", "transition.mjs");
    writeFileSync(join(copiedSkillDir, "scripts", "gate_prepare.mjs"), `export function buildResult() {
  throw new Error("fixture preparation outage");
}
`);
    const prepareUnavailable = runNode([copiedTransitionScript, "explore-to-plan"], prepareTmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(prepareUnavailable.ok, "preparation outage remains advisory when authoritative gate proof passes");
    const prepareReceipt = readJson(join(preparePlanDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json"));
    assert(prepareReceipt.advisories.some((row) => row.code === "GATE-PREP-002"), "preparation outage is visible under its stable advisory code");
    assert(prepareReceipt.attempted_gate_preparation?.ok === false && prepareReceipt.status === "PASS", "receipt preserves preparation unavailability without inventing a hard block");

    const { planDir: thrashPlanDir, copiedVerifyGateScript: thrashVerifyGateScript } = seedCopiedPlannerProject(
      thrashTmp,
      "transition repeated failure guard fixture"
    );
    const thrashVerifySource = readText(thrashVerifyGateScript);
    writeFileSync(
      thrashVerifyGateScript,
      thrashVerifySource.replace("\n", "\nif (process.argv[1]?.endsWith('/verify_gate.mjs')) process.exit(23);\n")
    );
    const thrashStatePath = join(thrashPlanDir, "state.json");
    const thrashState = readJson(thrashStatePath);
    thrashState.transitions = Array.from({ length: 3 }, (_, index) => ({
      from: "EXPLORE",
      to: "EXPLORE",
      timestamp: `2026-07-14T08:00:0${index}.000Z`,
      gate_result: "FAIL",
      failure_codes: ["GATE-EXP-001"],
      script_versions: {},
    }));
    writeJson(thrashStatePath, thrashState);
    const thrashTransitionScript = join(thrashTmp, ".agent", "skills", "iterative-planner", "scripts", "transition.mjs");
    const thrashed = runNode([thrashTransitionScript, "explore-to-plan"], thrashTmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const thrashOutput = `${thrashed.stdout}\n${thrashed.stderr}`;
    assert(thrashed.ok && !thrashOutput.includes("GATE-RETRY-001"), "retired verifier failure cannot poison the authoritative retry diagnostic");
    assert(readJson(thrashStatePath).state === "PLAN", "authoritative retry diagnostic allows a now-valid gate to advance");

    const circuitPlanDir = seedProject(circuitTmp, "transition persistent circuit breaker fixture");
    const circuitStatePath = join(circuitPlanDir, "state.json");
    const circuitState = readJson(circuitStatePath);
    circuitState.transitions = [{
      from: "INIT",
      to: "EXPLORE",
      timestamp: "2026-07-14T08:10:00.000Z",
      gate_result: "SKIP",
      failure_codes: [],
      script_versions: {},
    }];
    circuitState.circuit_breakers = { "explore-to-plan": { total_fails: 10 } };
    writeJson(circuitStatePath, circuitState);
    const circuit = runNode([transitionScript, "explore-to-plan"], circuitTmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(!circuit.ok && circuit.stdout.includes("GATE-GAR-002"), "persistent circuit breaker emits its stable hard-block code");
    assert(circuit.stdout.includes("reset-circuit-breaker explore-to-plan"), "circuit-breaker receipt publishes the exact reset action");

    const { planDir: cooldownPlanDir } = seedCopiedPlannerProject(cooldownTmp, "transition configured cooldown fixture");
    const cooldownSkillDir = join(cooldownTmp, ".agent", "skills", "iterative-planner");
    const cooldownConfigPath = join(cooldownSkillDir, "config", "determinism.json");
    const cooldownConfig = readJson(cooldownConfigPath);
    cooldownConfig.features.gate_retry_cooldown = { enabled: true, cooldown_ms: 60_000 };
    writeJson(cooldownConfigPath, cooldownConfig);
    const cooldownStatePath = join(cooldownPlanDir, "state.json");
    const cooldownState = readJson(cooldownStatePath);
    cooldownState.transitions = [
      {
        from: "EXPLORE",
        to: "EXPLORE",
        timestamp: new Date().toISOString(),
        gate_result: "FAIL",
        failure_codes: ["GATE-EXP-001"],
        script_versions: {},
      },
      {
        from: "EXPLORE",
        to: "PLAN",
        timestamp: new Date().toISOString(),
        gate_result: "GREENISH",
        failure_codes: [],
        script_versions: {},
      },
    ];
    writeJson(cooldownStatePath, cooldownState);
    const cooldown = runNode([join(cooldownSkillDir, "scripts", "transition.mjs"), "explore-to-plan"], cooldownTmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(!cooldown.ok && cooldown.stdout.includes("GATE-RETRY-002"), "explicitly configured retry cooldown emits its stable hard-block code");
    assert(cooldown.stdout.includes("NEXT:") && cooldown.stdout.includes("WHY:"), "cooldown receipt includes exact NEXT and WHY guidance");

    const decisionLogPlanDir = seedProject(decisionLogTmp, "transition decision log persistence fixture");
    writeFindingsLedger(decisionLogPlanDir);
    mkdirSync(join(decisionLogPlanDir, "artifacts"), { recursive: true });
    writeFileSync(join(decisionLogPlanDir, "artifacts", "decision_log.jsonl.lock"), String(process.pid));
    const decisionLog = runNode([transitionScript, "explore-to-plan"], decisionLogTmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(!decisionLog.ok && decisionLog.stdout.includes("GATE-AUD-001"), "decision-log persistence failure blocks with a stable integrity code");
    const decisionReceipt = readJson(join(decisionLogPlanDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json"));
    assert(decisionReceipt.hard_blocks.some((row) => row.code === "GATE-AUD-001" && row.next && row.why), "decision-log failure receipt persists code, NEXT, and WHY");
    assert(readJson(join(decisionLogPlanDir, "state.json")).state === "EXPLORE", "decision-log failure does not advance canonical state");

    const stateLockPlanDir = seedProject(stateLockTmp, "transition state lock persistence fixture");
    writeFindingsLedger(stateLockPlanDir);
    const stateLockStatePath = join(stateLockPlanDir, "state.json");
    const stateLockState = readJson(stateLockStatePath);
    stateLockState.workflow_id = "/safe-change-power";
    writeJson(stateLockStatePath, stateLockState);
    writeFileSync(join(stateLockPlanDir, "state.json.lock"), String(process.pid));
    const stateLock = runNode([transitionScript, "explore-to-plan"], stateLockTmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(!stateLock.ok && stateLock.stdout.includes("GATE-STA-001"), "canonical state lock contention blocks with a stable integrity code");
    assert(stateLock.stdout.includes("Ritual Contract Lint"), "workflow-bound transition exercises the ritual contract linter before persistence");
    const stateLockReceipt = readJson(join(stateLockPlanDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json"));
    assert(stateLockReceipt.hard_blocks.some((row) => row.code === "GATE-STA-001" && row.next && row.why), "state-lock failure receipt persists code, NEXT, and WHY");
    assert(readJson(join(stateLockPlanDir, "state.json")).state === "EXPLORE", "state-lock failure does not advance canonical state");
  } finally {
    for (const tmp of [noPlanTmp, prepareTmp, thrashTmp, circuitTmp, cooldownTmp, decisionLogTmp, stateLockTmp]) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function scenarioRitualLintToolErrorsStaySeparateFromGateFailures() {
  const crashTmp = makeTemp("ritual-tool-error-crash");
  const invalidJsonTmp = makeTemp("ritual-tool-error-invalid-json");
  const protocolTmp = makeTemp("ritual-tool-error-protocol-matrix");
  const receiptFailureTmp = makeTemp("ritual-tool-error-receipt-failure");
  const semanticTmp = makeTemp("ritual-tool-error-semantic-control");
  const largeChangeTmp = makeTemp("ritual-tool-error-large-change");
  try {
    const seedRitualFixture = (tmp, goal) => {
      const { planDir } = seedCopiedPlannerProject(tmp, goal);
      writeFindingsLedger(planDir);
      const statePath = join(planDir, "state.json");
      const state = readJson(statePath);
      state.workflow_id = "/safe-change-power";
      writeJson(statePath, state);
      return {
        planDir,
        statePath,
        transitionPath: join(tmp, ".agent", "skills", "iterative-planner", "scripts", "transition.mjs"),
        ritualPath: join(tmp, ".agent", "skills", "iterative-planner", "scripts", "ritual_lint.mjs"),
      };
    };

    const crash = seedRitualFixture(crashTmp, "ritual subprocess crash classification fixture");
    writeFileSync(crash.ritualPath, 'process.stderr.write("fixture crash Bearer abcdefghijklmnopqrstuvwxyz\\n"); process.exit(19);\n');
    const crashStateBefore = readText(crash.statePath);
    const crashDecisionPath = join(crash.planDir, "artifacts", "decision_log.jsonl");
    const crashDecisionBefore = existsSync(crashDecisionPath) ? readText(crashDecisionPath) : null;
    const crashMetricsBefore = readJson(join(crash.planDir, "metrics.json"));
    const crashed = runNode([crash.transitionPath, "explore-to-plan"], crashTmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const crashReceiptPath = join(crash.planDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json");
    assert(existsSync(crashReceiptPath), "ritual subprocess crash persists its terminal receipt");
    if (!existsSync(crashReceiptPath)) {
      console.log(`  DIAGNOSTIC stdout=${JSON.stringify(crashed.stdout)} stderr=${JSON.stringify(crashed.stderr)}`);
      return;
    }
    const crashReceipt = readJson(crashReceiptPath);
    const crashMetricsAfter = readJson(join(crash.planDir, "metrics.json"));
    assert(!crashed.ok && crashed.status === 3, "ritual subprocess crash returns the dedicated tool-error exit status");
    assert(crashed.stdout.includes("RESULT: TOOL_ERROR") && crashed.stdout.includes("TOOL-RIT-001"), "ritual subprocess crash renders a coded TOOL_ERROR verdict");
    assert(
      crashReceipt.status === "TOOL_ERROR" &&
        crashReceipt.tool_error_count === 1 &&
        crashReceipt.tool_error_codes.includes("TOOL-RIT-001") &&
        crashReceipt.failure_codes.length === 0 &&
        crashReceipt.hard_blocks.length === 0,
      "tool-error receipt keeps infrastructure failure separate from semantic blockers",
    );
    assert(crashReceipt.persistence.metrics === true && crashReceipt.persistence.state === false && crashReceipt.persistence.decision_log === false, "tool-error receipt reports the exact non-lifecycle persistence result");
    assert(
      crashReceipt.tool_errors?.[0]?.next?.toLowerCase().includes("retry") &&
        crashReceipt.tool_errors?.[0]?.why?.toLowerCase().includes("tool"),
      "tool-error guidance offers retry/report guidance instead of artifact repair",
    );
    assert(
      crashReceipt.tool_errors?.[0]?.stderr_excerpt?.includes("Bearer [REDACTED]") &&
        !JSON.stringify(crashReceipt).includes("abcdefghijklmnopqrstuvwxyz"),
      "persisted tool-error diagnostics redact secrets before receipt storage",
    );
    assert(readText(crash.statePath) === crashStateBefore, "tool error does not mutate lifecycle state bytes");
    assert(
      (existsSync(crashDecisionPath) ? readText(crashDecisionPath) : null) === crashDecisionBefore,
      "tool error does not append a lifecycle decision",
    );
    assert(
      crashMetricsAfter.gate_attempts_total === crashMetricsBefore.gate_attempts_total &&
        crashMetricsAfter.gate_failures.length === crashMetricsBefore.gate_failures.length &&
        crashMetricsAfter.tool_errors?.length === 1,
      "tool error is observable without consuming a lifecycle attempt",
    );

    const invalidJson = seedRitualFixture(invalidJsonTmp, "ritual invalid JSON classification fixture");
    writeFileSync(invalidJson.ritualPath, 'process.stdout.write("not-json");\n');
    const invalidStateBefore = readText(invalidJson.statePath);
    const invalidMetricsBefore = readText(join(invalidJson.planDir, "metrics.json"));
    const invalid = runNode([invalidJson.transitionPath, "explore-to-plan", "--dry-run"], invalidJsonTmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(!invalid.ok && invalid.status === 3 && invalid.stdout.includes("RESULT: TOOL_ERROR"), "invalid ritual JSON is a deterministic dry-run tool error");
    assert(
      !existsSync(join(invalidJson.planDir, "artifacts", "transition_receipts")),
      "dry-run tool error does not persist a transition receipt",
    );
    assert(
      readText(invalidJson.statePath) === invalidStateBefore &&
        readText(join(invalidJson.planDir, "metrics.json")) === invalidMetricsBefore,
      "dry-run tool error leaves lifecycle state and metrics byte-identical",
    );

    const protocol = seedRitualFixture(protocolTmp, "ritual protocol integrity matrix fixture");
    const protocolCases = [
      {
        kind: "process_signal",
        source: 'process.kill(process.pid, "SIGTERM");\n',
      },
      {
        kind: "empty_stdout",
        source: "process.exit(0);\n",
      },
      {
        kind: "invalid_response",
        source: 'process.stdout.write(JSON.stringify({ok:true}));\n',
      },
      {
        kind: "invalid_response",
        source: 'process.stdout.write(JSON.stringify({ok:true,issue_counts:{total:-1,blocking:0,warnings:0},issues:[]}));\n',
      },
      {
        kind: "protocol_mismatch",
        source: 'process.stdout.write(JSON.stringify({ok:true,issue_counts:{total:0,blocking:0,warnings:0},issues:[]})); process.exit(7);\n',
      },
      {
        kind: "buffer_exhaustion",
        source: 'process.stdout.write("x".repeat(2 * 1024 * 1024));\n',
      },
      {
        kind: "timeout",
        source: "setInterval(() => {}, 1000);\n",
        env: { PLANNER_RITUAL_LINT_TIMEOUT_MS: "50" },
      },
    ];
    for (const protocolCase of protocolCases) {
      writeFileSync(protocol.ritualPath, protocolCase.source);
      const result = runNode([protocol.transitionPath, "explore-to-plan"], protocolTmp, {
        _PLANNER_FAST_TRACK: "1",
        PLANNER_SKIP_SELF_HEAL: "1",
        ...(protocolCase.env || {}),
      });
      const receipt = readJson(join(protocol.planDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json"));
      assert(
        !result.ok && result.status === 3 && receipt.status === "TOOL_ERROR" && receipt.tool_errors[0]?.kind === protocolCase.kind,
        `${protocolCase.kind} is classified as a coded tool error`,
      );
      assert(
        Buffer.byteLength(receipt.tool_errors[0]?.stdout_excerpt || "", "utf-8") <= 2048 &&
          Buffer.byteLength(receipt.tool_errors[0]?.stderr_excerpt || "", "utf-8") <= 2048,
        `${protocolCase.kind} stores bounded diagnostic excerpts`,
      );
    }
    const protocolMetrics = readJson(join(protocol.planDir, "metrics.json"));
    assert(protocolMetrics.tool_errors.length === protocolCases.length, "protocol matrix records every tool error outside lifecycle attempts");
    assert(protocolMetrics.gate_attempts_total === 0 && protocolMetrics.gate_failures.length === 0, "protocol matrix does not inflate lifecycle attempts or semantic failures");

    const receiptFailure = seedRitualFixture(receiptFailureTmp, "ritual tool-error receipt persistence failure fixture");
    writeFileSync(receiptFailure.ritualPath, 'process.stderr.write("fixture crash\\n"); process.exit(19);\n');
    const receiptFailureStateBefore = readText(receiptFailure.statePath);
    mkdirSync(join(receiptFailure.planDir, "artifacts"), { recursive: true });
    writeFileSync(join(receiptFailure.planDir, "artifacts", "transition_receipts"), "fixture blocks receipt directory\n");
    const receiptFailureResult = runNode([receiptFailure.transitionPath, "explore-to-plan"], receiptFailureTmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const receiptFailureMetrics = readJson(join(receiptFailure.planDir, "metrics.json"));
    assert(
      !receiptFailureResult.ok && receiptFailureResult.status === 3 &&
        receiptFailureResult.stdout.includes("RESULT: TOOL_ERROR") &&
        receiptFailureResult.stdout.includes("receipt=unavailable"),
      "receipt persistence failure preserves the terminal TOOL_ERROR classification",
    );
    assert(readText(receiptFailure.statePath) === receiptFailureStateBefore, "receipt persistence failure still leaves lifecycle state unchanged");
    assert(receiptFailureMetrics.tool_errors.length === 1 && receiptFailureMetrics.gate_attempts_total === 0, "receipt persistence failure retains separate best-effort tool telemetry only");

    const semantic = seedRitualFixture(semanticTmp, "semantic gate failure classification control");
    writeFileSync(semantic.ritualPath, 'process.stdout.write(JSON.stringify({ok:false,issue_counts:{total:1,blocking:1,warnings:0},issues:[{id:"fixture_semantic_miss",severity:"error",message:"fixture semantic miss"}]})); process.exit(1);\n');
    setPlanState(semantic.planDir, "VALIDATE", { workflow_id: "/safe-change-power" });
    const semanticMetricsBefore = readJson(join(semantic.planDir, "metrics.json"));
    const semanticResult = runNode([semantic.transitionPath, "explore-to-plan"], semanticTmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const semanticReceipt = readJson(join(semantic.planDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json"));
    const semanticMetricsAfter = readJson(join(semantic.planDir, "metrics.json"));
    assert(!semanticResult.ok && semanticReceipt.status === "FAIL", "semantic gate failure remains FAIL when ritual execution is healthy");
    assert(
      semanticReceipt.failure_codes.includes("GATE-SRC-001") &&
        semanticReceipt.tool_error_count === 0 &&
        semanticReceipt.tool_error_codes?.length === 0,
      "semantic FAIL retains gate codes and no tool-error classification",
    );
    assert(
      semanticMetricsAfter.gate_attempts_total === semanticMetricsBefore.gate_attempts_total + 1 &&
        semanticMetricsAfter.gate_failures.length === semanticMetricsBefore.gate_failures.length + 1,
      "semantic FAIL consumes one ordinary lifecycle attempt",
    );

    const large = seedRitualFixture(largeChangeTmp, "large changed-file ritual output fixture");
    writeFileSync(join(largeChangeTmp, ".gitignore"), ".agent/\n");
    execFileSync("git", ["init", "-q"], { cwd: largeChangeTmp });
    execFileSync("git", ["add", ".gitignore", "audit.config.json", "plans"], { cwd: largeChangeTmp });
    execFileSync("git", ["-c", "user.name=Planner Fixture", "-c", "user.email=planner@example.test", "commit", "-qm", "fixture baseline"], { cwd: largeChangeTmp });
    const largeDir = join(largeChangeTmp, "large-change");
    mkdirSync(largeDir, { recursive: true });
    for (let index = 0; index < 80; index += 1) {
      writeFileSync(
        join(largeDir, `file-${String(index).padStart(3, "0")}-${"long-path-segment-".repeat(6)}.txt`),
        `fixture ${index}\n`,
      );
    }
    const largeLint = runNode([
      large.ritualPath,
      "--workflow", "/safe-change-power",
      "--phase", "validate",
      "--plan", basename(large.planDir),
      "--json",
    ], largeChangeTmp);
    const largePayload = JSON.parse(largeLint.stdout);
    assert(
      Buffer.byteLength(largeLint.stdout, "utf8") > 8192,
      "ritual_lint emits complete parseable JSON beyond one macOS pipe-buffer chunk",
    );
    const auditIssue = largePayload.issues.find((row) => row.id === "missing_covered_post_change_audit");
    assert(!!auditIssue, "large changed-file fixture reaches the post-change audit finding");
    assert(
      auditIssue.detail.changed_files_truncated === true &&
        auditIssue.detail.changed_files.length <= 50 &&
        auditIssue.detail.changed_files_total >= 80,
      "ritual_lint bounds changed-file detail while retaining the original total",
    );
  } finally {
    for (const tmp of [crashTmp, invalidJsonTmp, protocolTmp, receiptFailureTmp, semanticTmp, largeChangeTmp]) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function scenarioCanonicalRitualProcessClassification() {
  const response = (ok, counts = { total: 0, blocking: 0, warnings: 0 }) => JSON.stringify({
    ok,
    issues: [],
    issue_counts: counts,
  });
  const proc = (overrides = {}) => ({
    status: 0,
    signal: null,
    error: null,
    stdout: response(true),
    stderr: "",
    ...overrides,
  });
  const processError = (code) => Object.assign(new Error(`fixture ${code}`), { code });
  const cases = [
    ["timeout", proc({ status: null, error: processError("ETIMEDOUT"), stderr: "Bearer abcdefghijklmnopqrstuvwxyz" })],
    ["buffer_exhaustion", proc({ status: null, error: processError("ENOBUFS") })],
    ["spawn_error", proc({ status: null, error: processError("ENOENT") })],
    ["process_signal", proc({ status: null, signal: "SIGTERM", stdout: "" })],
    ["empty_stdout", proc({ stdout: "" })],
    ["process_exit", proc({ status: 7, stdout: "" })],
    ["invalid_json", proc({ stdout: "{" })],
    ["invalid_response", proc({ stdout: "{}" })],
    ["invalid_response", proc({ stdout: JSON.stringify([]) })],
    ["invalid_response", proc({ stdout: response(true, { total: -1, blocking: 0, warnings: 0 }) })],
    ["missing_exit_status", proc({ status: null })],
    ["protocol_mismatch", proc({ status: 7 })],
  ];
  for (const [kind, fixture] of cases) {
    const result = classifyRitualLintProcess(fixture);
    assert(result.toolError?.kind === kind && result.toolError?.code === "TOOL-RIT-001", `canonical ritual classifier covers ${kind}`);
  }
  const timeout = classifyRitualLintProcess(cases[0][1]);
  assert(!timeout.toolError.stderr_excerpt.includes("abcdefghijklmnopqrstuvwxyz"), "canonical ritual classifier redacts persisted diagnostics");
  const semantic = classifyRitualLintProcess(proc({ status: 1, stdout: response(false, { total: 1, blocking: 1, warnings: 0 }) }));
  assert(semantic.toolError === null && semantic.ok === false, "canonical ritual classifier keeps valid semantic failure separate");
  const healthy = classifyRitualLintProcess(proc());
  assert(healthy.toolError === null && healthy.ok === true, "canonical ritual classifier accepts a healthy response");
  assert(ritualLintTimeoutMs("") === 60000 && ritualLintTimeoutMs("invalid") === 60000, "ritual timeout defaults remain stable");
  assert(ritualLintTimeoutMs("1") === 10 && ritualLintTimeoutMs("90000") === 60000, "ritual timeout override remains bounded");
}

function scenarioBootstrapCreationPersistsExplicitProofPosture() {
  const tmp = makeTemp("bootstrap-proof-posture");
  try {
    cpSync(agentDir, join(tmp, ".agent"), { recursive: true });
    writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
      roles: ["core", "assumptions_challenger", "config_integrity", "traceability", "wiring_auditor"],
      fail_on: ["CRITICAL"],
    }, null, 2) + "\n");
    const copiedScriptDir = join(tmp, ".agent", "skills", "iterative-planner", "scripts");
    const copiedBootstrap = join(copiedScriptDir, "bootstrap.mjs");
    const created = runNode(
      [copiedBootstrap, "new", "--force", "Change shared transition classification and persisted proof contracts"],
      tmp,
      { PLANNER_HEALTH_JSON_TIMEOUT_MS: "1", PLANNER_HEALTH_REPORT_TIMEOUT_MS: "1", PLANNER_SKIP_SELF_HEAL: "1" },
    );
    assert(created.ok, "serious forced plan creation remains available when the bounded health probe is unavailable");

    const { planDir } = getPlanDir(tmp);
    const strategyPath = join(planDir, "verification_strategy.yaml");
    assert(existsSync(strategyPath), "forced plan creation persists the canonical verification strategy");
    const strategy = readJson(strategyPath);
    assert(
      strategy.verification_strategy?.version === 1 &&
        Array.isArray(strategy.verification_strategy?.criteria) &&
        typeof strategy.verification_strategy?.verification_obligation_synthesis === "object",
      "creation-time verification strategy has the complete canonical scaffold shape",
    );

    const baseline = readJson(join(planDir, "health_baseline.json"));
    const report = readText(join(planDir, "health_report.md"));
    assert(
      baseline.status === "unavailable" && baseline.summary === null && baseline.proof_sufficient === false,
      "unavailable health baseline records explicit availability metadata without healthy counts",
    );
    assert(
      report.includes("Status: UNAVAILABLE") && report.includes("not proof"),
      "unavailable health report states its non-proof posture",
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioGuideFirstClassificationContract() {
  const help = runNode([transitionScript, "--help"], repoRoot, { PLANNER_SKIP_SELF_HEAL: "1" });
  assert(help.ok && help.stdout.includes("Unified gate wrapper"), "transition CLI help exits cleanly with the governed gate catalog");
  const unknownGate = runNode([transitionScript, "not-a-gate"], repoRoot, { PLANNER_SKIP_SELF_HEAL: "1" });
  assert(!unknownGate.ok && unknownGate.stderr.includes("Unknown gate 'not-a-gate'"), "transition CLI rejects an unknown gate before runtime mutation");

  assert(deriveGateDecision([{ status: "PASS" }]) === "ALLOWED", "canonical PASS allows a gate decision");
  assert(deriveGateDecision([{ status: "WARN" }]) === "ALLOWED", "canonical WARN remains an advisory gate decision");
  assert(deriveGateDecision([{ status: "GREENISH" }]) === "BLOCKED", "unknown gate status blocks instead of becoming ALLOWED");
  assert(deriveGateDecision([{ name: "missing status" }]) === "BLOCKED", "missing gate status blocks instead of becoming ALLOWED");
  assert(deriveGateDecision([]) === "BLOCKED", "an empty check set cannot become an ALLOWED gate decision");

  const malformed = normalizeGateResults([{ name: "malformed control", status: "GREENISH", detail: "planted" }], {
    gate: "execute-to-reflect",
    planId: "plan_fixture",
  });
  assert(
    malformed[0].status === "FAIL" && malformed[0].code === "GATE-CONTRACT-001",
    "unknown signed check status becomes one coded hard contract failure",
  );

  let uncodedError = null;
  try {
    normalizeGateResults([{ name: "uncoded control", status: "FAIL", detail: "planted" }], {
      gate: "execute-to-reflect",
      planId: "plan_fixture",
    });
  } catch (error) {
    uncodedError = error;
  }
  assert(uncodedError instanceof GateContractError, "uncoded FAIL input throws the structural contract defect");
  const contractResult = normalizeGateResultsForTransition([
    { name: "uncoded control", status: "FAIL", detail: "planted" },
  ], { gate: "execute-to-reflect", planId: "plan_fixture" });
  assert(
    contractResult.filter((row) => row.status === "FAIL").length === 1 &&
      contractResult.every((row) => row.code === "GATE-CONTRACT-001") &&
      contractResult.some((row) => row.status === "WARN" && row.contract_defect_source === true),
    "uncoded source failure is preserved as a coded advisory beside one coded contract blocker",
  );

  const advisory = normalizeGateResults([{ name: "red-team document count", status: "FAIL", code: "GATE-ETR-001" }], {
    gate: "execute-to-reflect",
    planId: "plan_fixture",
  });
  assert(advisory[0].status === "WARN" && advisory[0].advisory_conversion === true, "ritual-only failure converts to a visible advisory");

  const hard = normalizeGateResults([{ name: "semantic invariant", status: "FAIL", code: "GATE-SEM-002" }], {
    gate: "validate-to-close",
    planId: "plan_fixture",
  });
  assert(hard[0].status === "FAIL" && hard[0].next && hard[0].why, "semantic failure remains hard with coded NEXT and WHY");
}

function scenarioMissingOntologyFactsEmitDegradedCoverage() {
  const tmp = makeTemp("missing-ontology-degraded-coverage");
  try {
    const fixtureClock = new Date();
    const fixtureNowMs = fixtureClock.getTime();
    const waiverRecordedAt = new Date(fixtureNowMs - 60_000).toISOString();
    const waiverExpiresAt = new Date(fixtureNowMs + 24 * 60 * 60 * 1000).toISOString();
    const expiredWaiverAt = new Date(fixtureNowMs - 1).toISOString();
    const { planDir } = seedCopiedPlannerProject(tmp, "missing ontology facts degraded coverage fixture");
    const copiedSkillDir = join(tmp, ".agent", "skills", "iterative-planner");
    const copiedOntologyFactsDir = join(tmp, ".agent", "ontology", "facts");
    mkdirSync(copiedOntologyFactsDir, { recursive: true });
    for (const entityClass of ONTOLOGY_ENTITY_CLASSES) {
      writeJson(
        join(copiedOntologyFactsDir, `${entityClass}.yaml`),
        buildEmptyOntologyDocument(entityClass),
      );
    }
    const copiedRuleEngine = join(copiedSkillDir, "scripts", "rule_engine.mjs");
    const copiedBootstrap = join(copiedSkillDir, "scripts", "bootstrap.mjs");
    const copiedTransition = join(copiedSkillDir, "scripts", "transition.mjs");
    const census = loadDegradedCoverageCensus({ cwd: tmp, skillPath: copiedSkillDir });
    assert(
      census.ok && census.census.checks
        .filter((row) => row.disposition === "report_degraded_coverage")
        .every((row) => JSON.stringify(row.exits.map((exit) => exit.kind)) === JSON.stringify(["build_substrate", "record_governed_waiver"])),
      "degraded-coverage census is source-anchored and every reportable check has exactly two exits",
    );
    const loadedRules = loadRules(createSession(), { cwd: tmp, skillPath: copiedSkillDir });
    assert(
      Array.isArray(loadedRules) &&
        loadedRules.includes("ontology facts (generated from source)") &&
        loadedRules.degraded_coverage?.evidence_validity === "valid" &&
        !Object.keys(loadedRules).includes("degraded_coverage"),
      "loadRules preserves its array contract while attaching non-enumerable configured coverage metadata",
    );

    const copiedPrologDir = join(copiedSkillDir, "prolog");
    const copiedPrologBackup = join(tmp, "prolog-backup");
    cpSync(copiedPrologDir, copiedPrologBackup, { recursive: true });
    rmSync(copiedPrologDir, { recursive: true, force: true });
    const missingCoreRules = loadRules(createSession(), { cwd: tmp, skillPath: copiedSkillDir });
    assert(
      missingCoreRules.degraded_coverage?.items?.some((item) => item.check_id === "core_prolog_rule_bundle"),
      "loadRules reports a missing managed core Prolog bundle as degraded coverage",
    );
    cpSync(copiedPrologBackup, copiedPrologDir, { recursive: true });

    const failedCoreRules = loadRules({
      consultFile() { throw new Error("planted core rule load failure"); },
      consult() {},
    }, { cwd: tmp, skillPath: copiedSkillDir });
    assert(
      failedCoreRules.degraded_coverage?.items?.some((item) =>
        item.check_id === "core_prolog_rule_bundle" && item.cause.includes("failed to load")),
      "loadRules preserves core rule load failures in the shared coverage assessment",
    );

    const projectRulesDir = join(tmp, "prolog");
    mkdirSync(projectRulesDir, { recursive: true });
    writeFileSync(join(projectRulesDir, "project.pl"), "project_specific_marker(test).\n");
    const failedProjectRules = loadRules({
      consultFile() {},
      consult(text) {
        if (String(text).includes("project_specific_marker")) throw new Error("planted project rule load failure");
      },
    }, { cwd: tmp, skillPath: copiedSkillDir });
    assert(
      failedProjectRules.degraded_coverage?.items?.some((item) =>
        item.check_id === "project_specific_prolog_rules" && item.cause.includes("failed to load")),
      "loadRules preserves selected project rule load failures in the shared coverage assessment",
    );
    rmSync(projectRulesDir, { recursive: true, force: true });

    const configuredInvariant = runNode([copiedRuleEngine, "check-invariants", "--json", "--smoke"], tmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const configuredPayload = configuredInvariant.stdout.trim() ? JSON.parse(configuredInvariant.stdout) : {};
    const configuredStatus = runNode([copiedBootstrap, "status"], tmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(
      configuredInvariant.ok && configuredPayload.status === "PASS" && !configuredPayload.degraded_coverage &&
        configuredStatus.ok && !configuredStatus.stdout.includes("Degraded coverage"),
      "configured ontology facts stay quiet in direct invariant and bootstrap status controls",
    );

    const waiverPath = join(tmp, ".agent", "degraded_coverage_waivers.json");
    const governedWaiver = {
      waiver_type: "degraded_coverage",
      check_id: "canonical_repository_ontology_facts",
      reason: "Fixture intentionally omits repository ontology facts for the governed degradation control.",
      approved_by: "user",
      recorded_at: waiverRecordedAt,
      expires_at: waiverExpiresAt,
    };
    writeJson(waiverPath, { schema_version: 1, waivers: [governedWaiver] });
    const redundant = assessDegradedCoverage({
      cwd: tmp,
      skillPath: copiedSkillDir,
      now: fixtureClock,
    });
    assert(
      redundant.evidence_validity === "invalid" && redundant.failure_code === "GATE-COV-002",
      "a waiver for a currently configured check fails as redundant governance",
    );
    rmSync(waiverPath, { force: true });
    rmSync(join(tmp, ".agent", "ontology", "facts"), { recursive: true, force: true });

    const invariantRun = runNode([copiedRuleEngine, "check-invariants", "--json", "--smoke"], tmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const invariantPayload = invariantRun.stdout.trim() ? JSON.parse(invariantRun.stdout) : {};
    assert(
      invariantRun.ok &&
        invariantPayload.status === "WARN" &&
        invariantPayload.degraded_coverage?.evidence_validity === "degraded_coverage",
      "missing ontology facts cannot report full coverage from direct invariant CLI",
    );

    const status = runNode([copiedBootstrap, "status"], tmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(
      status.ok &&
        status.stdout.includes("Degraded coverage") &&
        status.stdout.includes("Canonical repository ontology facts") &&
        status.stdout.includes("build_substrate") &&
        status.stdout.includes("record_governed_waiver"),
      "bootstrap status names the degraded check and exactly two governed exits",
    );

    const pointerPath = join(tmp, "plans", ".current_plan");
    const pointerValue = readFileSync(pointerPath, "utf-8");
    rmSync(pointerPath, { force: true });
    const noPlanStatus = runNode([copiedBootstrap, "status"], tmp, { PLANNER_SKIP_SELF_HEAL: "1" });
    assert(
      noPlanStatus.ok &&
        noPlanStatus.stdout.includes("No active plan") &&
        noPlanStatus.stdout.includes("Canonical repository ontology facts"),
      "no-plan bootstrap status also surfaces selected degraded coverage",
    );
    writeFileSync(pointerPath, pointerValue);

    writeExploreFindings(planDir, "missing ontology facts degraded coverage fixture");
    writeJson(waiverPath, {
      schema_version: 1,
      waivers: [{ ...governedWaiver, approved_by: "" }],
    });
    const blockedTransition = runNode([copiedTransition, "explore-to-plan"], tmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(
      !blockedTransition.ok &&
        blockedTransition.stdout.includes("GATE-COV-002") &&
        readJson(join(planDir, "state.json")).state === "EXPLORE",
      "an ungoverned degraded-coverage waiver blocks the actual transition without advancing state",
    );
    rmSync(waiverPath, { force: true });
    const transition = runNode([copiedTransition, "explore-to-plan"], tmp, {
      _PLANNER_FAST_TRACK: "1",
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    assert(
      transition.ok && transition.stdout.includes("GATE-COV-003") && transition.stdout.includes("degraded_coverage"),
      "actual transition surfaces missing ontology facts as an advisory without weakening the gate",
    );
    const receipt = readJson(join(planDir, "artifacts", "transition_receipts", "latest_explore-to-plan.json"));
    assert(
      receipt.degraded_coverage?.evidence_validity === "degraded_coverage" &&
        receipt.degraded_coverage?.items?.[0]?.check_id === "canonical_repository_ontology_facts" &&
        receipt.degraded_coverage?.items?.[0]?.exits?.length === 2,
      "transition receipt persists the governed degraded-coverage assessment",
    );

    writeJson(waiverPath, { schema_version: 1, waivers: [governedWaiver] });
    const waivedInvariant = runNode([copiedRuleEngine, "check-invariants", "--json", "--smoke"], tmp, {
      PLANNER_SKIP_SELF_HEAL: "1",
    });
    const waivedPayload = waivedInvariant.stdout.trim() ? JSON.parse(waivedInvariant.stdout) : {};
    assert(
      waivedInvariant.ok &&
        waivedPayload.status === "WARN" &&
        waivedPayload.degraded_coverage?.status === "waived" &&
        waivedPayload.degraded_coverage?.evidence_validity === "degraded_coverage" &&
        waivedPayload.degraded_coverage?.claim_support_allowed === false,
      "a governed waiver stays visibly degraded and cannot support a full-coverage claim",
    );

    const invalidCases = [
      { label: "unknown", waiver: { ...governedWaiver, check_id: "unknown_check" } },
      { label: "unapproved", waiver: { ...governedWaiver, approved_by: "" } },
      { label: "expired", waiver: { ...governedWaiver, expires_at: expiredWaiverAt } },
    ];
    for (const invalidCase of invalidCases) {
      writeJson(waiverPath, { schema_version: 1, waivers: [invalidCase.waiver] });
      const assessment = assessDegradedCoverage({
        cwd: tmp,
        skillPath: copiedSkillDir,
        now: fixtureClock,
      });
      assert(
        assessment.evidence_validity === "invalid" && assessment.failure_code === "GATE-COV-002",
        `${invalidCase.label} degraded-coverage waiver fails closed`,
      );
    }
    writeJson(waiverPath, { schema_version: 1, waivers: [governedWaiver, governedWaiver] });
    const duplicate = assessDegradedCoverage({
      cwd: tmp,
      skillPath: copiedSkillDir,
      now: fixtureClock,
    });
    assert(
      duplicate.evidence_validity === "invalid" && duplicate.failure_code === "GATE-COV-002",
      "duplicate degraded-coverage waivers fail closed",
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nTransition And Gate Flow Test\n");

scenarioCanonicalRitualProcessClassification();
scenarioRitualLintToolErrorsStaySeparateFromGateFailures();
scenarioReflectProgressAuthorityParity();
scenarioTransitionFlow();
scenarioPlanToExecuteFailsClosedWhenSnapshotPreparationCannotReadInput();
scenarioPlanToExecuteFailsClosedWhenSnapshotPersistenceConflicts();
scenarioReplanWarningUsesCanonicalGateTruth();
// scenarioBootstrapExploreWithoutFastTrack();
// scenarioCodexSkipsExternalTraceWarnings();
// scenarioStructuredIndexedFindingsStayAligned();
// scenarioJsonFirstFindingsLedger();
// scenarioFindingsLedgerProjectionSyncs();
// scenarioExploreTransitionPrintsRepairPacket();
// scenarioKbDigestGate();
// scenarioKbDigestLedgerGate();
// scenarioExploreGateRequiresIntentContract();
// scenarioExploreGateSkipsIntentContractForInternalMaintenanceGoals();
// scenarioPlanGateRequiresDeliverableMapping();
// scenarioPlanGateRequiresExplicitCriterionStoryLinkage();
// scenarioStableCriterionIdsAndNotImplementedStoriesAreGeneralContracts();
// scenarioPlanGateRequiresContextSensitiveVerificationMatrix();
// scenarioPlanGateBlocksDuplicateScriptCreation();
scenarioPlanGateAllowsCompactLowRiskStaticVerificationObligation();
scenarioPlanLearnedObligationParity();
scenarioInactiveVerificationFamiliesDoNotImposeProof();
scenarioAmbientScopeAcknowledgementIsAdvisory();
scenarioLearnedObligationCloseBlocksDegradedSourceRegistry();
scenarioTransitionBlocksMissingMistakeHookTarget();
scenarioGuideFirstClassificationContract();
scenarioMissingOntologyFactsEmitDegradedCoverage();
scenarioTransitionGuideFirstReceiptContract();
scenarioTransitionIntegrityFailureReceipts();
scenarioBootstrapCreationPersistsExplicitProofPosture();
// scenarioBootstrapScaffoldDefaultsCompactForLowRiskShapes();
// scenarioBootstrapScaffoldPreservesFullMatrixForHighRiskShape();
// scenarioPlanGateRejectsCompactHighRiskIntegrationObligation();
// scenarioVerificationMatrixRecognizesProofIds();
// scenarioVerificationMatrixCoversTableCriteriaAndProseProofRows();
// scenarioPlanGatePrintsLowLevelAgentPacket();
scenarioPlanningOnlyGatePassesWithAuditBackedPlan();
// scenarioPlanningOnlyGateBlocksMissingRetros();
// scenarioPlanningOnlyGateBlocksMissingExactTestInventory();
// scenarioPlanningOnlyGateBlocksMissingRedTeamReview();
// scenarioPlanningOnlyGateBlocksMissingStoryAudit();
// scenarioPlanningOnlyGateBlocksRootLevelLightweightHandoff();
// scenarioPlanningOnlyGateBlocksUngroundedRetroSources();
// scenarioPlanningOnlyGateBlocksUngroundedRedTeamReview();
// scenarioPlanTransitionExplainsBrokenEvidenceChainAdvisory();
scenarioPlanTransitionBlocksMissingActiveMistakeGuard();
scenarioSemanticDivergencePrecisionContract();
scenarioUnmappedSourceDivergenceRemainsLoud();
// scenarioReflectTransitionBlocksMissingActiveMistakeHookEvidence();
// scenarioReflectTransitionAcceptsMarkdownWrappedActiveMistakeHookEvidence();
// scenarioResetCircuitBreaker();
// scenarioHistoryPoisonDiagnosesButAllowsValidTransition();
// scenarioRetryDiagnosticTimeoutCoversSlowGateTruth();
// scenarioReverseDivergenceStaysDiagnostic();
// scenarioKbUpdateCloseGate();
// scenarioValidateToCloseIgnoresZeroFailSummaries();
scenarioValidateCloseScopesAsyncDriftMaintenanceToPlanFiles();
scenarioValidateClosePreflightAlignsStatusAndStaysReadOnly();
// scenarioPlannerCoreCloseNeedsJourneyProof();
// scenarioCodeChangesNeedTestEvidence();
// scenarioStaticUiManualObservationSatisfiesClose();
// scenarioStandardPassOutputCountsAsTestEvidence();
scenarioProgressLegendDoesNotCreateFalseOpenItems();
scenarioReflectCloseRequiresQuantResultsValidationForResultClaims();
scenarioExecuteToReflectCountsCompletedBullets();
scenarioExecuteToReflectGuideFirstRedTeamParity();
// scenarioExecuteToReflectWarnsOnSemanticSubstrateGaps();
// scenarioExecuteToReflectWarnsOnSemanticSubstrateScopeDegradation();
// scenarioExecuteToReflectWarnsOnWeakSemanticSubstrateHints();
// scenarioTestEvidenceWaiverPasses();
// scenarioRemediationCloseNeedsAntiRecurrenceGuard();
scenarioRemediationCloseAcceptsAntiRecurrenceGuard();
// scenarioLearnedObligationCloseNeedsEvidence();
// scenarioLearnedObligationCloseAcceptsStructuredEvidence();
// scenarioReflectGateRequiresVerificationObligationReporting();
// scenarioReflectCloseBlocksSemanticSubstrateGaps();
// scenarioReflectCloseDowngradesRitualOnlySemanticSubstrateDrift();
scenarioSemanticChecksReuseSharedRefreshSnapshot();
// scenarioReflectCloseAcceptsSatisfiedAndIrrelevantSemanticSubstrate();
// scenarioLearnedObligationCloseBlocksDegradedSourceRegistry();
scenarioRuleEngineSmokeModeDoesNotWrite();
// scenarioIntentEvidenceRequiredForClose();
// scenarioStalePlanReadWarns();
// scenarioStalePlanEditBlocks();
// scenarioOpportunityStagnationBlocksPlanToExecute();
// scenarioOpportunityStagnationBlocksValidateToClose();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
