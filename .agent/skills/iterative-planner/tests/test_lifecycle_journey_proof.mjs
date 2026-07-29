#!/usr/bin/env node
// test_lifecycle_journey_proof.mjs - deterministic full planner lifecycle proof.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { plannerSubprocessEnv } from "./helpers/env.mjs";
import { scaffoldVerificationStrategy } from "../scripts/lib/verification_strategy.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const NODE = process.execPath;

const bootstrapScript = join(skillDir, "scripts", "bootstrap.mjs");
const transitionScript = join(skillDir, "scripts", "transition.mjs");

const LIFECYCLE_GATES = [
  "explore-to-plan",
  "plan-to-execute",
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
  "notify-user",
];

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

function runNode(args, cwd, extraEnv = {}) {
  try {
    const stdout = execFileSync(NODE, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: plannerSubprocessEnv(extraEnv),
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function getPlanDir(cwd) {
  const planName = readFileSync(join(cwd, "plans", ".current_plan"), "utf-8").trim();
  return { planName, planDir: join(cwd, "plans", planName) };
}

function transition(gate, cwd, outputs) {
  const result = runNode([transitionScript, gate], cwd, gate === "explore-to-plan" ? { _PLANNER_FAST_TRACK: "1" } : {});
  outputs[gate] = result.stdout + result.stderr;
  assert(result.ok, `transition.mjs ${gate} exits successfully`);
  if (!result.ok) {
    console.log(outputs[gate]);
  }
  return result.ok;
}

function setupFixtureRepo(tmp) {
  mkdirSync(join(tmp, "docs"), { recursive: true });
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  writeFileSync(join(tmp, ".gitignore"), ".agent\nplans/\nreports/\n");
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core"],
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2) + "\n");
  writeFileSync(join(tmp, "docs", "lifecycle-note.md"), "# Lifecycle Fixture\n\nbefore execute\n");

  runGit(["init"], tmp);
  runGit(["config", "user.email", "planner-test@example.invalid"], tmp);
  runGit(["config", "user.name", "Planner Lifecycle Test"], tmp);
  runGit(["add", ".gitignore", "audit.config.json", "docs/lifecycle-note.md"], tmp);
  runGit(["commit", "-m", "seed lifecycle fixture"], tmp);
}

function seedStoryRegistry(tmp) {
  mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
  writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
    version: 1,
    updated: "2026-07-07T00:00:00.000Z",
    stories: [
      {
        id: "US-001",
        title: "Planner state machine reaches close through real gates",
        priority: "HIGH",
        status: "FULLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/transition.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_lifecycle_journey_proof.mjs"],
        doc_refs: [".agent/skills/iterative-planner/SKILL.md"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_lifecycle_journey_proof.mjs"],
        tags: ["roles", "fail_on"],
      },
      {
        id: "US-077",
        title: "Executed proof is stronger than file pointers",
        priority: "HIGH",
        status: "PARTIALLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/tests/ive/run.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_lifecycle_journey_proof.mjs"],
        doc_refs: ["plans/programs/ive-trust-repair/program_packet.json"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_lifecycle_journey_proof.mjs"],
      },
      {
        id: "US-080",
        title: "Claim boundaries are explicit in planner verification",
        priority: "MEDIUM",
        status: "PARTIALLY_COVERED",
        code_refs: [".agent/skills/iterative-planner/scripts/verify_gate.mjs"],
        test_refs: [".agent/skills/iterative-planner/tests/test_lifecycle_journey_proof.mjs"],
        doc_refs: [".agent/skills/iterative-planner/SKILL.md"],
        validation_refs: [".agent/skills/iterative-planner/tests/test_lifecycle_journey_proof.mjs"],
      },
    ],
  }, null, 2) + "\n");
}

function writeFindings(planDir) {
  writeFileSync(join(planDir, "findings.md"), `# Findings

[FAST_TRACK]

## F-001: Lifecycle proof needs real transitions
The fixture must run a real bootstrap and real transition commands instead of editing state.json by hand.
That matters because J13/J14 are about trust in executed proof, not file pointers.
The transition runtime is the system under test, so this finding names bootstrap.mjs, transition.mjs, and the generated artifacts as the exercised boundary.
The test should fail at the gate that drifts instead of hiding behind source inspection.

## F-002: EXECUTE needs a real worktree change
The fixture needs a tracked file edit after plan-to-execute and before execute-to-reflect.
That edit gives the journey a concrete artifact produced during EXECUTE.
The proof remains deterministic because the file is seeded in a temp git repo and the diff is asserted before REFLECT.
The edit is documentation-shaped so Tier 1 avoids pretending it validates production autonomous code generation.

## F-003: Tier 1 has a narrow claim boundary
Tier 1 proves deterministic lifecycle scaffolding and IVE registration only.
It does not prove that an autonomous agent can discover, implement, and validate a seeded defect.
That broader concept claim belongs to the scoped Tier 3 ticket.
The test must say this boundary in its verification artifacts so future reports cannot overclaim the result.

## Root Cause
Root Cause: previous IVE conformance coverage aggregated element tests without a single journey that created real lifecycle artifacts across all gates.

## Adjacency
Adjacency: bootstrap.mjs creates the plan, transition.mjs advances the state machine, verify_gate.mjs enforces artifacts, and the IVE runner selects the executable proof.

## Assumption Ledger
- VERIFIED: The temp directory is a git repo with a tracked fixture file.
- VERIFIED: The local .agent symlink lets planner subprocesses run against the fixture as a project.
- VERIFIED: The Tier 1 journey is deterministic scaffolding proof, not autonomous-coding concept proof.
`);
}

function writePlan(planDir) {
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Deterministic full lifecycle journey proof

## Problem Statement
Expected behavior: the fixture edits docs/lifecycle-note.md during EXECUTE, walks all real transition.mjs gates, and reaches CLOSE without hand-writing state.json histories. Invariants: bootstrap and transition commands must be real subprocesses, the EXECUTE edit must be visible in git diff, and Tier 1 must not be described as autonomous-coding concept proof. Edge cases: notify-user is audit-only, so the state history has five state-changing transitions while the command output still proves the sixth gate ran.

## Context
This temp fixture represents the Tier 1 J13/J14 proof shape. It keeps scope deliberately small: deterministic planner lifecycle scaffolding with no live service, scheduler, or autonomous coding driver.

## Files To Modify
- docs/lifecycle-note.md

## Steps
1. Bootstrap a planner plan in the fixture repository.
2. Author normal EXPLORE and PLAN artifacts.
3. Edit docs/lifecycle-note.md during EXECUTE.
4. Run execute-to-reflect, reflect-to-validate, validate-to-close, and notify-user.
5. Assert clean CLOSE, real transition history, and the Tier 1 claim boundary.

## Verification Obligation Synthesis
- Repo/system context: temp git fixture, bootstrap.mjs, transition.mjs, verify_gate.mjs, and generated planner artifacts.
- Task shape: deterministic integration proof for planner lifecycle scaffolding.
- Ontology signals: US-001, US-077, and US-080 bind the state machine, executed-proof, and claim-boundary invariants.
- Persona signals: wiring_auditor requires exercised commands; traceability requires gate/state proof; assumptions_challenger requires the autonomous-coding boundary.
- System boundaries touched: bootstrap.mjs, transition.mjs, verify_gate.mjs, generated plan artifacts, and the temp git worktree.
- Derived verification obligations: real gate chain, real file edit, clean close state, and explicit remaining-unverified claim boundary.

## Semantic Upkeep Contract
- Profile: integration_backend_orchestration
- Ontology action: revise_existing
- Story action: revise_existing
- Validation bundle: integration
- Strictness mode: full
- Close blocker if skipped: The journey could become a file-pointer claim instead of executed transition proof.

## Failure Modes
- A transition gate changes artifact requirements and blocks the fixture.
- The EXECUTE edit is skipped and the diff assertion catches it.
- The audit-only notify-user gate stops accepting CLOSE state.
- The proof gets overclaimed as autonomous-coding evidence.

## Risks
- The fixture could become too tailored to current markdown quirks.
- The test could be slow because it exercises every real gate.
- The documentation-shaped edit could be mistaken for production code proof.

## Success Criteria
1. sc_1: The fixture runs all six real transition.mjs gate commands.
2. sc_2: The fixture edits docs/lifecycle-note.md during EXECUTE and proves the diff before REFLECT.
3. sc_3: The produced state reaches CLOSE with real state-changing transition history.
4. sc_4: The verification artifacts state that Tier 1 proves deterministic scaffolding only and Tier 3 is required for autonomous-coding concept proof.

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-001; J13; J14 | transition.mjs fixture | proof:integration_smoke | Run the six transition.mjs commands | Each command exits 0 | Autonomous coding is not exercised |
| sc_2 | US-001; J13; J14 | temp git fixture | proof:behavioral_test | Inspect git diff after EXECUTE edit | docs/lifecycle-note.md differs from HEAD | Production code generation is not exercised |
| sc_3 | US-001; J14 | generated state.json | proof:artifact_review | Read produced state.json after notify-user | state is CLOSE and real transition pairs exist | notify-user remains audit-only |
| sc_4 | US-077; US-080; J13 | verification.md and summary.md | proof:artifact_review | Review Tier 1 claim boundary text | Tier 3 remains required for autonomous concept proof | Tier 2/Tier 3 implementation remains future work |

## Active Mistake Response
| Mistake | Guard | Planned handling | Planned evidence |
|---|---|---|---|
| J13/J14 | lifecycle_execution | Drive the real state machine from bootstrap through close. | transition.mjs outputs and state.json |
| J13/J14 | claim_boundary | State that Tier 1 is deterministic scaffolding only. | verification.md and summary.md |

## Fix Classification
Defense in depth

## Configuration And Flags
No new project flags, config defaults, or mutual exclusions are introduced. The fixture uses existing planner subprocess environment helpers and a local audit.config.json.

## Pre-Mortem
If this fixture fails later, the likely cause is gate-contract drift or a hidden assumption about fabricated state. The test should fail at the real transition command so the gate output remains the diagnostic source.

## Knowledge Application
[KB_NO_NEW_LEARNINGS]
`);
  writeFileSync(join(planDir, "decisions.md"), `# Decisions

## D-001: Keep Tier 1 deterministic
Decision: The fixture authors deterministic artifacts and runs real gates, but does not claim autonomous-coding concept proof.
Rationale: Tier 3 is the planned headless-agent dogfood run for the autonomous concept claim.
`);
}

function writeExecuteArtifacts(planDir, gateOutputs) {
  writeFileSync(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Bootstrapped a temp git fixture repo with a tracked lifecycle file.
- [x] Ran explore-to-plan and plan-to-execute as real transition.mjs commands.
- [x] Edited docs/lifecycle-note.md during EXECUTE and verified git diff.

## In Progress
None.

## Remaining
None.

## Blocked
None.
`);

  writeFileSync(join(planDir, "verification.md"), `# Verification

## Criteria Verification
| Criterion | Story linkage | Result | Evidence |
|---|---|---|---|
| sc_1 | US-001 | PASS | explore-to-plan and plan-to-execute ran as real transition.mjs commands. |
| sc_2 | US-001 | PASS | docs/lifecycle-note.md was edited during EXECUTE and git diff showed the change. |
| sc_3 | US-001 | N/A | Later gates still need to run before final state can be inspected. |
| sc_4 | US-077; US-080 | PASS | This file states Tier 1 proves deterministic scaffolding only; Tier 3 is required for autonomous-coding concept proof. |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | bootstrap.mjs new created the plan in the temp fixture repo. |
| Locally / unit tested | PASS | transition.mjs explore-to-plan and plan-to-execute passed. |
| Context-appropriate integration tested | PASS | Real planner transition commands exercised the fixture. |
| Audit reviewed | PASS | red_team_notes.md covers fabricated history, skipped edit, and overclaim risks. |
| Live approved | NOT REQUESTED | No live system is in scope for this deterministic fixture. |

## Systems Exercised
- bootstrap.mjs new
- transition.mjs explore-to-plan
- transition.mjs plan-to-execute
- git diff for docs/lifecycle-note.md

## Remaining Unverified
Autonomous coding is not proven; Tier 3 is required for the autonomous-coding concept claim.

## Verification Sufficiency
This stage is sufficient for execute-to-reflect because it proves a real EXECUTE artifact exists and the later close proof is still pending.

## Test Drift Scan
PASS - The fixture runs the current transition entrypoints rather than matching source text.

## Regression Audit
PASS - The test is the recurrence guard for J13/J14 Tier 1 lifecycle scaffolding.

## Anti-Recurrence Guard
PASS - Guard Type: test. The fixture asserts real gate commands and an EXECUTE-time file diff.

## Proof of Work
\`\`\`text
node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan
PASS
node .agent/skills/iterative-planner/scripts/transition.mjs plan-to-execute
PASS
git diff -- docs/lifecycle-note.md
${gateOutputs.diff.trim()}
\`\`\`
`);

  writeFileSync(join(planDir, "red_team_notes.md"), `# Red-Team Adversarial Analysis

## Vector 1: Gate history could be fabricated
Attack:
- A test writes state.json directly with a plausible transition history.
Impact:
- The suite reports lifecycle confidence without ever exercising transition.mjs or verify_gate.mjs.
Mitigation:
- This fixture only advances state by subprocess calls to transition.mjs and asserts the produced state pairs after the commands run.

## Vector 2: EXECUTE could be empty
Attack:
- The plan enters REFLECT without changing any tracked fixture artifact.
Impact:
- The journey proves ceremony but not an actual EXECUTE work product.
Mitigation:
- The test edits docs/lifecycle-note.md after plan-to-execute and fails unless git diff shows that tracked file changed before execute-to-reflect.

## Vector 3: Tier 1 could be overclaimed
Attack:
- A deterministic fixture is summarized as autonomous-coding evidence.
Impact:
- J13/J14 appear resolved while the planted-defect headless-agent dogfood proof remains untested.
Mitigation:
- verification.md and summary.md explicitly state that Tier 1 proves deterministic scaffolding only and Tier 3 is required for the autonomous-coding concept claim.
`);
}

function writeReflectionArtifacts(planDir) {
  writeFileSync(join(planDir, "reflection.md"), `# Reflection

## Solution Verdict
pass - The deterministic fixture produced bootstrap, EXPLORE, PLAN, EXECUTE, and REFLECT artifacts through real commands.

## Semantic Verdict
pass - The proof chain is behavioral and keeps the Tier 1 claim boundary explicit.

## Evidence-Readiness Verdict
pass - Verification records command output, the git diff, and the remaining autonomous-coding gap.

## Next Move
Proceed to VALIDATE.

## Knowledge Base Sign-Off
- Decision: no_new_learnings
- Reason: This deterministic fixture adds regression coverage but does not introduce a durable new operating lesson.

## Recipe Promotion
N/A - This is a focused regression fixture, not a reusable operator recipe.
`);
}

function writeValidateArtifacts(planDir, gateOutputs) {
  writeFileSync(join(planDir, "verification.md"), `# Verification

## Criteria Verification
| Criterion | Story linkage | Result | Evidence |
|---|---|---|---|
| sc_1 | US-001 | PASS | All six transition.mjs gate commands ran: ${LIFECYCLE_GATES.join(", ")}. |
| sc_2 | US-001 | PASS | docs/lifecycle-note.md was edited during EXECUTE and git diff showed the change before REFLECT. |
| sc_3 | US-001 | PASS | Produced state.json reached VALIDATE before close and is expected to close via validate-to-close. |
| sc_4 | US-077; US-080 | PASS | Tier 1 is documented as deterministic scaffolding only; Tier 3 is required for autonomous-coding concept proof. |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | bootstrap.mjs new created the active plan. |
| Locally / unit tested | PASS | The lifecycle proof test asserts each transition command. |
| Context-appropriate integration tested | PASS | The fixture exercised the real planner transition path end to end. |
| Audit reviewed | PASS | red_team_notes.md covers fabricated history, skipped edit, and overclaim risks. |
| Live approved | NOT REQUESTED | No live system is in scope. |

## Systems Exercised
- bootstrap.mjs new
- transition.mjs explore-to-plan
- transition.mjs plan-to-execute
- transition.mjs execute-to-reflect
- transition.mjs reflect-to-validate
- transition.mjs validate-to-close
- transition.mjs notify-user
- git diff for docs/lifecycle-note.md

## Remaining Unverified
Autonomous coding is not proven; Tier 3 is required for the autonomous-coding concept claim.

## Verification Sufficiency
PASS - The required Tier 1 claim is deterministic lifecycle scaffolding, so real gate commands plus generated artifact inspection are sufficient.

## Test Drift Scan
PASS - The fixture executes transition entrypoints instead of inspecting source files.

## Regression Audit
PASS - This test is the recurrence guard for the missing full-lifecycle J13/J14 proof.

## Anti-Recurrence Guard
PASS - Guard Type: test. The journey test asserts all real gates and the EXECUTE edit.

## Proof of Work
\`\`\`text
${LIFECYCLE_GATES.map((gate) => `transition.mjs ${gate}: PASS`).join("\n")}
git diff -- docs/lifecycle-note.md
${gateOutputs.diff.trim()}
\`\`\`
`);

  writeFileSync(join(planDir, "summary.md"), `# Summary

The deterministic lifecycle journey fixture reached VALIDATE through real planner artifacts and is ready to close. Tier 1 proves deterministic full-lifecycle scaffolding only; the autonomous-coding concept claim requires Tier 3.

[KB_NO_NEW_LEARNINGS]
`);
}

function assertTransitionHistory(planDir, gateOutputs) {
  const state = readJson(join(planDir, "state.json"));
  assert(state.state === "CLOSE", "final produced state is CLOSE");

  const pairs = (state.transitions || []).map((entry) => `${entry.from}->${entry.to}`);
  for (const pair of [
    "INIT->EXPLORE",
    "EXPLORE->PLAN",
    "PLAN->EXECUTE",
    "EXECUTE->REFLECT",
    "REFLECT->VALIDATE",
    "VALIDATE->CLOSE",
  ]) {
    assert(pairs.includes(pair), `state transition history includes ${pair}`);
  }
  assert(!pairs.includes("CLOSE->CLOSE"), "notify-user stays audit-only instead of fabricating a state transition");
  assert(/TRANSITION:\s+notify-user/.test(gateOutputs["notify-user"] || ""), "notify-user gate output proves the audit-only command ran");
}

console.log("\nLifecycle Journey Proof\n");

const tmp = mkdtempSync(join(tmpdir(), "planner-lifecycle-"));
const keepTemp = process.env.KEEP_PLANNER_LIFECYCLE_TEMP === "1";
const gateOutputs = {};

try {
  setupFixtureRepo(tmp);

  const bootstrap = runNode([bootstrapScript, "new", "--force", "deterministic full lifecycle journey proof"], tmp);
  assert(bootstrap.ok, "bootstrap.mjs new creates a temp fixture plan");
  if (!bootstrap.ok) console.log(bootstrap.stdout + bootstrap.stderr);

  const { planDir } = getPlanDir(tmp);
  seedStoryRegistry(tmp);
  assert(existsSync(join(planDir, "state.json")), "bootstrap produced state.json");

  writeFindings(planDir);
  if (!transition("explore-to-plan", tmp, gateOutputs)) throw new Error("explore-to-plan failed");

  writePlan(planDir);
  const verificationStrategy = scaffoldVerificationStrategy({ cwd: tmp, planDir, force: true });
  assert(verificationStrategy.ok && verificationStrategy.wrote, "fixture authors a canonical verification strategy after replacing the bootstrap plan");
  if (!transition("plan-to-execute", tmp, gateOutputs)) throw new Error("plan-to-execute failed");

  writeFileSync(join(tmp, "docs", "lifecycle-note.md"), "# Lifecycle Fixture\n\nbefore execute\n\nafter execute\n");
  gateOutputs.diff = runGit(["diff", "--", "docs/lifecycle-note.md"], tmp);
  assert(gateOutputs.diff.includes("after execute"), "EXECUTE made a real tracked file edit");

  writeExecuteArtifacts(planDir, gateOutputs);
  if (!transition("execute-to-reflect", tmp, gateOutputs)) throw new Error("execute-to-reflect failed");

  writeReflectionArtifacts(planDir);
  if (!transition("reflect-to-validate", tmp, gateOutputs)) throw new Error("reflect-to-validate failed");

  writeValidateArtifacts(planDir, gateOutputs);
  if (!transition("validate-to-close", tmp, gateOutputs)) throw new Error("validate-to-close failed");
  if (!transition("notify-user", tmp, gateOutputs)) throw new Error("notify-user failed");

  assertTransitionHistory(planDir, gateOutputs);
  assert(readFileSync(join(tmp, "docs", "lifecycle-note.md"), "utf-8").includes("after execute"), "EXECUTE edit remains in the fixture worktree");
  assert(readFileSync(join(planDir, "verification.md"), "utf-8").includes("Tier 3 is required"), "verification states the Tier 1 claim boundary");
} catch (error) {
  failed += 1;
  console.log(`  FAIL: lifecycle journey threw ${error.message}`);
  if (keepTemp) console.log(`  TEMP: ${tmp}`);
} finally {
  if (!keepTemp) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

console.log(`\nLifecycle journey proof: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
