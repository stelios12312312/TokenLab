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
  existsSync,
  rmSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { KB_SALT_HEX_LEN, computeStateHash, writeStateJson } from "../scripts/lib/determinism.mjs";
import { buildEnvelope, getEnvelopePath, validateEnvelopeAgainstDisk } from "../scripts/lib/plan_contract.mjs";

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
    maybeRefreshPlanToExecuteEnvelope(args, cwd);
    maybeRefreshInvariantEnvelope(args, cwd);
    const stdout = execFileSync(NODE, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        _PLANNER_PLAN_TARGET: "",
        ...extraEnv,
      },
    });
    maybeMaterializeApprovalEnvelope(args, cwd);
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

function maybeMaterializeApprovalEnvelope(args, cwd) {
  const command = String(args?.[0] || "");
  const gate = String(args?.[1] || "");
  if (command !== transitionScript || gate !== "explore-to-plan") return;
  materializeApprovalEnvelopeForCurrentPlan(cwd);
}

function maybeRefreshPlanToExecuteEnvelope(args, cwd) {
  const command = String(args?.[0] || "");
  const gate = String(args?.[1] || "");
  if (args.includes("--planning-only")) return;
  if (gate !== "plan-to-execute") return;
  if (command !== transitionScript && command !== verifyGateScript) return;
  materializeApprovalEnvelopeForCurrentPlan(cwd);
}

function maybeRefreshInvariantEnvelope(args, cwd) {
  const command = String(args?.[0] || "");
  const subcommand = String(args?.[1] || "");
  if (command !== ruleEngineScript || subcommand !== "check-invariants") return;
  materializeApprovalEnvelopeForCurrentPlan(cwd);
}

function materializeApprovalEnvelopeForCurrentPlan(cwd) {
  // Many legacy gate fixtures rewrite plan.md after explore-to-plan so they can
  // probe one specific PLAN check. Under the envelope contract, that edit is
  // post-approval disk drift. Refresh the fixture-only envelope from the same
  // approval nonce so these tests continue to exercise their intended gate.
  if (!existsSync(join(cwd, "plans", ".current_plan"))) return;
  const { planDir } = getPlanDir(cwd);
  const statePath = join(planDir, "state.json");
  const state = readJson(statePath);
  if (!state?.approval_nonce_hash) return;

  const existingEnvelope = validateEnvelopeAgainstDisk(planDir);
  if (existingEnvelope.ok) return;

  const decisions = readText(join(planDir, "decisions.md"));
  const nonceMatch = decisions.match(/\[APPROVED:([0-9a-f]+)\]/);
  if (!nonceMatch) return;

  const built = buildEnvelope(planDir, {
    approvalNonce: nonceMatch[1],
    approverOrigin: "auto",
  });
  if (!built.envelope) {
    throw new Error(`failed to materialize approval envelope for fixture: [${built.reason_code}] ${built.detail}`);
  }

  writeFileSync(getEnvelopePath(planDir), JSON.stringify(built.envelope, null, 2) + "\n");
  state.approval_envelope_path = "approval_envelope.json";
  state.approval_envelope_schema = built.envelope.schema_version;
  writeStateJson(planDir, state);
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

function seedProject(cwd, goal) {
  symlinkSync(agentDir, join(cwd, ".agent"), "dir");
  writeFileSync(join(cwd, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger"],
    fail_on: ["CRITICAL"],
  }, null, 2) + "\n");

  const bootstrap = runNode([bootstrapScript, "new", goal], cwd);
  assert(bootstrap.ok, `bootstrap new succeeds for "${goal}"`);

  const { planDir } = getPlanDir(cwd);
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
  const bootstrap = runNode([copiedBootstrapScript, "new", goal], cwd);
  assert(bootstrap.ok, `bootstrap new succeeds for copied planner fixture "${goal}"`);

  const { planDir } = getPlanDir(cwd);
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
Root Cause: earlier smoke coverage skipped the end-to-end approval and knowledge proof path.
That left critical planner behaviors looking healthy in aggregate without direct behavioral coverage.
This fixture closes that gap with real state and artifact transitions.
It also proves the first-run bootstrap case can satisfy knowledge-base proof requirements without hand-editing plan state.
The regression target is behavioral correctness for the gate, not just the existence of a happy-path helper.

## Finding 3
Adjacency: bootstrap.mjs seeds the plan, transition.mjs advances it, and verify_gate.mjs validates the artifacts.
The temp project includes plans/knowledge so the KB digest branch is active.
Auto approval mode should emit a real approval marker into decisions.md.
Because several planner components participate in one transition, the test needs enough written context to resemble a real EXPLORE artifact.
That keeps the standard-depth gate focused on substantive planner reasoning instead of a markdown formatting shortcut.

## Assumption Ledger
- VERIFIED: The temp project contains a local .agent path so planner subprocesses behave like a real repo.
- VERIFIED: The default approval mode is auto, so explore-to-plan should write an approval marker without a daemon.
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
Need end-to-end transition coverage for approval nonce and KB digest paths.

## Files To Modify
- .agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs
- reports/user_story_audit/story_registry.json

## Steps
1. Build a temp planner project with a local .agent symlink.
2. Run explore-to-plan in fast-track mode to exercise signed state updates.
3. Verify plan-to-execute gate behavior and nonce consumption.

## Verification Strategy
Run targeted transition and gate regressions, then rerun invariant checks.

## Active Mistake Response
| Mistake | Guard | Planned handling | Planned evidence |
|---|---|---|---|
| M-001 | ripple_through | Keep transition, gate, and supporting planner surfaces aligned across the nonce and KB digest flow. | transition regression plus ripple-aware fixture review |
| M-001 | migration_smoke | Preserve the migration-facing contract while exercising planner-core transition behavior. | migration journey smoke stays part of the fixture contract |

## Semantic Upkeep Contract
- Profile: integration_backend_orchestration
- Ontology action: update_relationships
- Story action: revise_existing
- Validation bundle: integration
- Strictness mode: full
- Close blocker if skipped: Nonce consumption, approval semantics, and transition truth would drift from the exercised runtime behavior.

## Success Criteria
- Explore-to-plan generates approval and KB digest hashes.
- Plan-to-execute accepts the approved nonce path and records nonce consumption.

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
| \`node .agent/skills/iterative-planner/tests/test_planner_script_smoke.mjs\` | Plan-only prompts route to \`/safe-plan\` in shared preflight | Silent fallback to \`/safe-change\` for no-code requests |
| \`node .agent/skills/iterative-planner/tests/test_knowledge_resolver.mjs\` | Deterministic workflow ranking prefers \`/safe-plan\` for planning-only prompts even in planner-core repos | Planner-core boosts overwhelming explicit no-code intent |
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
| The planning-only validator blocks incomplete handoffs. | ${storyId} | Planner-core workflow, routing, and read-only validator surfaces | Planning-only gate regression plus workflow/routing smoke coverage | Run \`verify_gate.mjs plan-to-execute --planning-only\`, \`test_planner_script_smoke.mjs\`, and \`test_knowledge_resolver.mjs\` against the targeted fixtures | Missing sections fail, the complete fixture passes, and plan-only prompts resolve to \`/safe-plan\` | Real future implementation still needs the code changes described by the handoff; this session proves the planning contract only |

## Success Criteria
1. The planning-only validator blocks incomplete handoffs.

## Fix Classification
Defense in depth

${sections.join("\n")}
`;
}

function buildLightweightPlanningOnlyTask(goal = "Design a lightweight planning-only safe-plan handoff") {
  return `# Task

${goal}

- Scope: planning-only workflow hardening
- Constraint: do not write product or runtime code in this session
`;
}

function buildLightweightPlanningOnlyImplementationPlan({
  goal = "Design a lightweight planning-only safe-plan handoff",
  storyId = "US-902",
  retroSource = "retro_ledger.json -> R-2026-03-24-001",
  alignDeterministicAttackVectors = true,
} = {}) {
  return buildPlanningOnlyPlan({
    goal,
    storyId,
    retroSource,
    alignDeterministicAttackVectors,
  }).replace(/^# Plan\b/m, "# Implementation Plan");
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
    transition_nonce: extra.transition_nonce || "a".repeat(32),
  };
  state._state_hash = computeStateHash(state);
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
- llm_drift_maintenance.mjs enqueue path

## Remaining Unverified
None for this scoped regression fixture.

## Verification Sufficiency
The target behavior is transition enqueue scoping, so a real validate-to-close transition with a dirty ambient worktree fixture is sufficient.

## Regression Audit
Regression fixture covers plan-scoped async maintenance enqueue behavior.

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
| M-001 | migration_smoke | Re-run the migration smoke path after the planner-core change lands. | test_migration |
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

function writeActiveMistakeVerification(planDir, { includeMigrationHook = false, markdownCodeCells = false } = {}) {
  const mistakeCell = markdownCodeCells ? "`M-001`" : "M-001";
  const rippleHookCell = markdownCodeCells ? "`ripple_check`" : "ripple_check";
  const migrationHookCell = markdownCodeCells ? "`test_migration`" : "test_migration";
  const migrationRow = includeMigrationHook
    ? `\n| ${mistakeCell} | ${migrationHookCell} | PASS | \`node .agent/skills/iterative-planner/scripts/migrate.mjs verify .\` passed after the planner-core change |`
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
- test_migration remains intentionally absent in this fixture so the reflect gate has to report the missing active mistake hook.

## Verification Sufficiency
This regression targets the active mistake proof contract itself, so the reflect gate should fail until every required hook is explicitly proven.

## Test Drift Scan
N/A — no tests.

## Regression Audit
N/A — no baseline captured.

## Active Mistake Evidence
| Mistake | Hook | Status | Evidence |
|---|---|---|---|
| ${mistakeCell} | ${rippleHookCell} | PASS | \`ripple_check\` recorded the required planner-core surfaces for this fixture |${migrationRow}

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
    assert(typeof afterExplore.approval_nonce_hash === "string" && afterExplore.approval_nonce_hash.length === 32, "explore-to-plan stores approval_nonce_hash");
    assert(typeof afterExplore.kb_digest_hash === "string" && afterExplore.kb_digest_hash.length === 32, "explore-to-plan stores kb_digest_hash");
    assert(typeof afterExplore.transition_nonce === "string" && afterExplore.transition_nonce.length === 32, "explore-to-plan stores transition_nonce");
    assert(typeof afterExplore.tamper_fingerprint?.hash === "string" && afterExplore.tamper_fingerprint.hash.length === 32, "explore-to-plan stores tamper_fingerprint after auto approval artifacts");
    assert(/\[APPROVED:[0-9a-f]+\]/.test(decisions), "explore-to-plan writes an approval marker in auto mode");
    const approvalNonceMatch = decisions.match(/\[APPROVED:([0-9a-f]+)\]/);
    const envelopeAfterExplore = validateEnvelopeAgainstDisk(planDir);
    assert(envelopeAfterExplore.ok, "explore-to-plan materializes a valid approval envelope for the fixture");
    if (approvalNonceMatch && envelopeAfterExplore.ok) {
      const expectedEnvelopeNonceHash = createHash("sha256").update(approvalNonceMatch[1]).digest("hex");
      assert(envelopeAfterExplore.envelope.approval_nonce_hash === expectedEnvelopeNonceHash, "approval envelope records the full approval nonce hash");
    }
    assert(!!kbDigestMatch && kbDigestMatch[1].length === KB_SALT_HEX_LEN, "explore-to-plan persists KB digest proof in findings.md when no ledger exists");
    if (kbDigestMatch) {
      const expectedDigest = createHash("sha256").update(kbDigestMatch[1] + readKnowledgeBaseContent(tmp)).digest("hex").slice(0, 32);
      assert(expectedDigest === afterExplore.kb_digest_hash, "persisted KB digest salt in findings.md matches the stored KB digest hash");
    }
    assert(existsSync(join(planDir, "persona_guidance.md")), "explore-to-plan writes persona_guidance.md");

    const approvalHash = afterExplore.approval_nonce_hash;
    const progressPath = join(planDir, "progress.md");
    writeFileSync(progressPath, readText(progressPath).trimEnd() + "\n- [x] Tamper fixture changed a sensitive artifact.\n");
    const tamperedPreflight = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(tamperedPreflight.ok, "tamper fingerprint mismatch warns without blocking a legitimate next transition");
    assert(tamperedPreflight.stdout.includes("GATE-TMP-002"), "tamper fingerprint mismatch emits the stable warning code");

    const execute = runNode([transitionScript, "plan-to-execute"], tmp);
    assert(execute.ok, "transition plan-to-execute exits cleanly with the approved nonce path");
    assert(execute.stdout.includes("Entering phase: EXECUTE"), "transition plan-to-execute reports the entered EXECUTE authority phase");
    assert(execute.stdout.includes("Proof posture: Boundary Capture"), "transition plan-to-execute reports the EXECUTE proof posture");

    const afterExecute = readJson(join(planDir, "state.json"));
    assert(afterExecute.state === "EXECUTE", "plan-to-execute advances the signed state to EXECUTE");
    assert(Array.isArray(afterExecute.consumed_nonces) && afterExecute.consumed_nonces.includes(approvalHash), "plan-to-execute records the consumed approval nonce hash");
    assert(typeof afterExecute.tamper_fingerprint?.hash === "string" && afterExecute.tamper_fingerprint.hash.length === 32, "plan-to-execute refreshes tamper_fingerprint after legitimate artifact changes");
    assert(afterExecute.tamper_fingerprint.hash !== afterExplore.tamper_fingerprint.hash, "tamper_fingerprint changes after the fixture artifact change and transition");
    assert(existsSync(join(planDir, "persona_guidance.md")), "plan-to-execute refreshes persona_guidance.md");

    const staleGate = runNode([verifyGateScript, "plan-to-execute"], tmp);
    assert(!staleGate.ok, "verify_gate plan-to-execute still fails after nonce consumption");
    assert(staleGate.stdout.includes("This gate already passed"), "stale plan-to-execute checks explain the gate already passed");
    assert(staleGate.stdout.includes("verification_matrix.mjs lint"), "stale plan-to-execute checks point to the non-mutating matrix linter");
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
    assert(gate.stdout.includes("Deterministic Repair Packet"), "blocked explore-to-plan transition prints the deterministic repair packet");
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
    state.nonce_generated_at = new Date().toISOString();
    state._state_hash = computeStateHash(state);
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
    state.nonce_generated_at = new Date().toISOString();
    state._state_hash = computeStateHash(state);
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

    const blocked = runNode([transitionScript, "plan-to-execute"], tmp);
    assert(!blocked.ok, "transition plan-to-execute blocks active planner-core mistakes without declared guards");
    assert(blocked.stdout.includes("active_mistake_missing_declared_guard"), "plan-to-execute surfaces the missing active mistake guard invariant name");
    assert(blocked.stdout.includes("M-001"), "plan-to-execute identifies which active mistake is missing a declared guard");
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
    writeActiveMistakeVerification(planDir, { includeMigrationHook: false });
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
    state._state_hash = computeStateHash(state);
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
    writeActiveMistakeVerification(planDir, { includeMigrationHook: true, markdownCodeCells: true });
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
    state._state_hash = computeStateHash(state);
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
          test_refs: [".agent/skills/iterative-planner/tests/test_planner_script_smoke.mjs"],
          validation_refs: [".agent/skills/iterative-planner/tests/test_planner_script_smoke.mjs"],
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
    assert(gate.stdout.includes("Low-Level Agent Gate Packet"), "blocked plan-to-execute output prints the low-level packet");
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
    writeFileSync(join(planDir, "plan.md"), buildPlanningOnlyPlan({ goal }));

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
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

function scenarioPlanningOnlyGatePassesForLightweightHandoff() {
  const tmp = makeTemp("planning-only-lightweight-pass");
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
    writeFileSync(join(tmp, "task.md"), buildLightweightPlanningOnlyTask());
    writeFileSync(join(tmp, "implementation_plan.md"), buildLightweightPlanningOnlyImplementationPlan());

    const gate = runNode([verifyGateScript, "plan-to-execute", "--planning-only"], tmp);
    assert(gate.ok, "verify_gate plan-to-execute --planning-only accepts a lightweight audit-backed handoff without plans/");
    assert(gate.stdout.includes("GATE-PLN-LW-001") && gate.stdout.includes("GATE-PLN-029"), "lightweight planning-only validation reports both lightweight and audit provenance checks");
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
    state._state_hash = computeStateHash(state);
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
    state._state_hash = computeStateHash(state);
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
  try {
    execFileSync("git", ["init"], { cwd: ambientTmp, stdio: "ignore" });
    const ambientPlanDir = seedProject(ambientTmp, "ordinary documentation close scope smoke");
    prepareValidateCloseTransitionFixture(ambientTmp, ambientPlanDir, {
      filesToModify: ["notes/local.txt"],
      dirtyReadme: true,
    });

    const ambientClose = runNode([transitionScript, "validate-to-close"], ambientTmp);
    assert(ambientClose.ok, "transition validate-to-close passes with a dirty ambient README fixture");
    assert(!ambientClose.stdout.includes("Async drift maintenance enqueued"), "validate-to-close does not enqueue async maintenance for unrelated dirty drift-sensitive files");
    assert(!existsSync(join(ambientPlanDir, "async")), "unrelated dirty drift-sensitive files do not create an async job directory");

    const plannedPlanDir = seedProject(plannedTmp, "planned documentation close scope smoke");
    prepareValidateCloseTransitionFixture(plannedTmp, plannedPlanDir, {
      filesToModify: ["README.md"],
      dirtyReadme: true,
    });

    const plannedClose = runNode([transitionScript, "validate-to-close"], plannedTmp);
    assert(plannedClose.ok, "transition validate-to-close passes when a planned drift-sensitive file is declared");
    assert(plannedClose.stdout.includes("Async drift maintenance enqueued"), "validate-to-close enqueues async maintenance for planned drift-sensitive files");
    assert(plannedClose.stdout.includes("(scope=plan_files)"), "async maintenance enqueue reports plan_files scope");
    assert(existsSync(join(plannedPlanDir, "async")), "planned drift-sensitive files create an async job directory");
  } finally {
    try { rmSync(ambientTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(plannedTmp, { recursive: true, force: true }); } catch { /* best effort */ }
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
- .agent/skills/iterative-planner/tests/test_bootstrap_state_surface.mjs

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
node .agent/skills/iterative-planner/tests/test_migration.mjs
PASS
\`\`\`

\`\`\`text
node .agent/skills/iterative-planner/tests/test_bootstrap_state_surface.mjs
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

    const gate = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(gate.ok, "verify_gate reflect-to-close accepts progress.md when only completed items remain");
    const refreshedState = readJson(join(planDir, "state.json"));
    assert(refreshedState?.close_signals?.progress?.satisfied === true, "close_signals.progress ignores the progress legend text and stays satisfied");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReflectCloseRequiresQuantResultsValidationForResultClaims() {
  const tmp = makeTemp("quant-results-close-gate");
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

    writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify({
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
        strongest_counterargument: "Wiring proof does not establish economic edge.",
        falsification_criteria: "Any economic-edge claim invalidates this diagnostic fixture.",
        odds_snapshot_matrix: "entry price: T-24/open; reference price: close; CLV available: yes; label type: excess return",
        presentation_stamp: "diagnostic_only",
      },
    }, null, 2) + "\n");

    const diagnostic = runNode([verifyGateScript, "reflect-to-close"], tmp);
    assert(diagnostic.ok, "verify_gate reflect-to-close accepts wiring-proof quant results only as diagnostic_only");
    assert(diagnostic.stdout.includes("GATE-VAL-016") && diagnostic.stdout.includes("diagnostic_only"), "reflect-to-close reports diagnostic-only quant validation as satisfied");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
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

    const gate = runNode([verifyGateScript, "execute-to-reflect"], tmp);
    assert(gate.ok, "verify_gate execute-to-reflect accepts a legacy completed bullet as evidence of completed work");
    assert(gate.stdout.includes("1 completed item(s) found"), "execute-to-reflect reports the legacy completed bullet as completed work");
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
- PASS: Added a durable mistake entry that future retro plans can reuse.
Guard Type: kb

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

function scenarioRuleEngineReadOnlyChecksDoNotMutateState() {
  const tmp = makeTemp("rule-engine-read-only");
  try {
    const planDir = seedProject(tmp, "rule engine read-only smoke");
    const statePath = join(planDir, "state.json");
    const before = readText(statePath);

    const invariants = runNode([ruleEngineScript, "check-invariants", "--json"], tmp);
    assert(invariants.ok || invariants.status === 1, "rule_engine check-invariants returns a read-only report");
    assert(readText(statePath) === before, "rule_engine check-invariants leaves state.json unchanged");
    assert(!existsSync(join(planDir, "ontology_facts.pl")), "rule_engine check-invariants does not write ontology_facts.pl during read-only refresh");

    const conflicts = runNode([ruleEngineScript, "find-conflicts", "--json"], tmp);
    assert(conflicts.ok || conflicts.status === 1, "rule_engine find-conflicts returns a read-only report");
    assert(readText(statePath) === before, "rule_engine find-conflicts also leaves state.json unchanged");
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

console.log("\nTransition And Gate Flow Test\n");

scenarioTransitionFlow();
scenarioBootstrapExploreWithoutFastTrack();
scenarioCodexSkipsExternalTraceWarnings();
scenarioStructuredIndexedFindingsStayAligned();
scenarioJsonFirstFindingsLedger();
scenarioFindingsLedgerProjectionSyncs();
scenarioExploreTransitionPrintsRepairPacket();
scenarioKbDigestGate();
scenarioKbDigestLedgerGate();
scenarioExploreGateRequiresIntentContract();
scenarioExploreGateSkipsIntentContractForInternalMaintenanceGoals();
scenarioPlanGateRequiresDeliverableMapping();
scenarioPlanGateRequiresExplicitCriterionStoryLinkage();
scenarioStableCriterionIdsAndNotImplementedStoriesAreGeneralContracts();
scenarioPlanGateRequiresContextSensitiveVerificationMatrix();
scenarioVerificationMatrixRecognizesProofIds();
scenarioVerificationMatrixCoversTableCriteriaAndProseProofRows();
scenarioPlanGatePrintsLowLevelAgentPacket();
scenarioPlanningOnlyGatePassesWithAuditBackedPlan();
scenarioPlanningOnlyGateBlocksMissingRetros();
scenarioPlanningOnlyGateBlocksMissingExactTestInventory();
scenarioPlanningOnlyGateBlocksMissingRedTeamReview();
scenarioPlanningOnlyGateBlocksMissingStoryAudit();
scenarioPlanningOnlyGatePassesForLightweightHandoff();
scenarioPlanningOnlyGateBlocksUngroundedRetroSources();
scenarioPlanningOnlyGateBlocksUngroundedRedTeamReview();
scenarioPlanTransitionExplainsBrokenEvidenceChainAdvisory();
scenarioPlanTransitionBlocksMissingActiveMistakeGuard();
scenarioReflectTransitionBlocksMissingActiveMistakeHookEvidence();
scenarioReflectTransitionAcceptsMarkdownWrappedActiveMistakeHookEvidence();
scenarioResetCircuitBreaker();
scenarioHistoryPoisonDiagnosesButAllowsValidTransition();
scenarioReverseDivergenceStaysDiagnostic();
scenarioKbUpdateCloseGate();
scenarioValidateToCloseIgnoresZeroFailSummaries();
scenarioValidateCloseScopesAsyncDriftMaintenanceToPlanFiles();
scenarioPlannerCoreCloseNeedsJourneyProof();
scenarioCodeChangesNeedTestEvidence();
scenarioStaticUiManualObservationSatisfiesClose();
scenarioStandardPassOutputCountsAsTestEvidence();
scenarioProgressLegendDoesNotCreateFalseOpenItems();
scenarioReflectCloseRequiresQuantResultsValidationForResultClaims();
scenarioExecuteToReflectCountsCompletedBullets();
scenarioExecuteToReflectWarnsOnSemanticSubstrateGaps();
scenarioExecuteToReflectWarnsOnSemanticSubstrateScopeDegradation();
scenarioExecuteToReflectWarnsOnWeakSemanticSubstrateHints();
scenarioTestEvidenceWaiverPasses();
scenarioRemediationCloseNeedsAntiRecurrenceGuard();
scenarioRemediationCloseAcceptsAntiRecurrenceGuard();
scenarioLearnedObligationCloseNeedsEvidence();
scenarioLearnedObligationCloseAcceptsStructuredEvidence();
scenarioReflectGateRequiresVerificationObligationReporting();
scenarioReflectCloseBlocksSemanticSubstrateGaps();
scenarioReflectCloseDowngradesRitualOnlySemanticSubstrateDrift();
scenarioSemanticChecksReuseSharedRefreshSnapshot();
scenarioReflectCloseAcceptsSatisfiedAndIrrelevantSemanticSubstrate();
scenarioLearnedObligationCloseBlocksDegradedSourceRegistry();
scenarioRuleEngineReadOnlyChecksDoNotMutateState();
scenarioIntentEvidenceRequiredForClose();
scenarioStalePlanReadWarns();
scenarioStalePlanEditBlocks();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
