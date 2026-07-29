import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { createInitialStateJson, writeStateJson } from "../../scripts/lib/determinism.mjs";
import { plannerSubprocessEnv } from "./env.mjs";

const __filename = fileURLToPath(import.meta.url);
const helperDir = dirname(__filename);

export const skillDir = resolve(helperDir, "..", "..");
export const repoRoot = resolve(skillDir, "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
export const scriptDir = join(skillDir, "scripts");
export const verifyGateScript = join(scriptDir, "verify_gate.mjs");
export const plannerPreflightScript = join(scriptDir, "planner_preflight.mjs");
export const ontologySerializerScript = join(scriptDir, "ontology_serializer.mjs");
export const retroPromoteScript = join(scriptDir, "retro_promote.mjs");
export const objectiveProofScript = join(scriptDir, "objective_proof.mjs");
export const NODE = process.execPath;

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function writeText(path, value) {
  writeFileSync(path, `${String(value || "").replace(/\s+$/, "")}\n`);
}

export function runNode(args, cwd, extraEnv = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: plannerSubprocessEnv(extraEnv),
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

function runBin(bin, args, cwd) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(bin, args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
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

export function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), `planner-archetype-matrix-${name}-`));
}

export function cleanupTemp(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

function seedAgentLink(projectRoot) {
  const linkPath = join(projectRoot, ".agent");
  if (!existsSync(linkPath)) {
    symlinkSync(agentDir, linkPath, "dir");
  }
}

function seedKnowledgeBase(projectRoot) {
  mkdirSync(join(projectRoot, "plans", "knowledge", "retros", "cases"), { recursive: true });
  writeText(join(projectRoot, "plans", "knowledge", "index.md"), "# Knowledge Base Index");
  writeText(join(projectRoot, "plans", "knowledge", "mistakes.md"), "# Mistakes");
  writeText(join(projectRoot, "plans", "knowledge", "patterns.md"), "# Patterns");
  writeText(join(projectRoot, "plans", "knowledge", "gotchas.md"), "# Gotchas");
}

export function seedDiscoveryPolicy(projectRoot, archetype) {
  writeJson(join(projectRoot, "planner.discovery.json"), {
    archetype,
  });
}

function ensureFreshGitHead(projectRoot) {
  if (!existsSync(join(projectRoot, ".git"))) {
    const init = runBin("git", ["init"], projectRoot);
    if (!init.ok) throw new Error("git init failed for matrix fixture");
    runBin("git", ["config", "user.name", "Codex Matrix"], projectRoot);
    runBin("git", ["config", "user.email", "codex-matrix@example.com"], projectRoot);
    const commit = runBin("git", ["commit", "--allow-empty", "-m", "matrix fixture"], projectRoot);
    if (!commit.ok) throw new Error("git commit failed for matrix fixture");
  }

  const head = runBin("git", ["rev-parse", "HEAD"], projectRoot);
  if (!head.ok) throw new Error("git rev-parse HEAD failed for matrix fixture");
  return (head.stdout || "").trim();
}

function seedAuditLog(projectRoot, auditFixture) {
  const profile = auditFixture?.profile || "stale_required";
  let audits = [];

  if (profile === "fresh") {
    const head = ensureFreshGitHead(projectRoot);
    const timestamp = new Date().toISOString();
    audits = [
      { type: "red-team", timestamp, commit: head },
      { type: "regression", timestamp, commit: head },
      { type: "advisor", timestamp, commit: head },
    ];
  }

  writeJson(join(projectRoot, "plans", "audit_log.json"), { audits });
}

function semanticUpkeepContractBlock({ validationBundle = "behavioral", closeBlockerIfSkipped = "Acceptance-matrix semantics would drift from the runtime contract." } = {}) {
  return `## Semantic Upkeep Contract
- Profile: integration_backend_orchestration
- Ontology action: update_relationships
- Story action: revise_existing
- Validation bundle: ${validationBundle}
- Strictness mode: full
- Close blocker if skipped: ${closeBlockerIfSkipped}
`;
}

function buildVerificationSynthesisBlock({ boundaries, derivedObligations }) {
  return `## Verification Obligation Synthesis
- Repo/system context: Deterministic archetype acceptance fixture for the planner compiler pipeline.
- Task shape: Scenario-driven planner-core acceptance regression.
- Ontology signals: N/A — acceptance fixture without live story-registry wiring.
- Persona signals: N/A — acceptance fixture.
- System boundaries touched: ${boundaries}
- Derived verification obligations: ${derivedObligations}
`;
}

function buildVerificationStrategyRow(scenario) {
  const claim = scenario.objective_claim_fixture;
  const learned = scenario.learned_obligation_fixture;

  if (learned) {
    if (learned.covered_in_plan === true) {
      return `| Scenario records the early learned-obligation proof contract. | N/A — no story registry | ${learned.subject_id} guard coverage | proof:${learned.verification_mode} — ${learned.verification_mode} | Record ${learned.verification_mode} evidence for ${learned.subject_id} with ${learned.guard_type || "matrix_guard"} | The plan names the steered obligation explicitly before EXECUTE | Live production proof remains outside the fixture |`;
    }
    return `| Scenario records the integration proof path. | N/A — no story registry | Integration boundary smoke | proof:integration_smoke — integration_smoke | Run the integration smoke and review the changed files | Integration path is covered in principle | The explicit learned-obligation contract is still missing |`;
  }

  if (claim) {
    return `| ${claim.quality_bar} | N/A — no story registry | ${claim.purpose} | proof:${claim.proof_type || "browser_journey"} — ${claim.proof_type || "browser_journey"} | Record structured browser proof for ${claim.claim_id} | ${claim.quality_bar} | Manual confirmation outside the normalized artifact remains out of scope |`;
  }

  if (scenario.family === "migration_parity_stale_audit") {
    return `| Migration parity path remains coherent. | N/A — no story registry | Migration and rollout smoke | proof:migration_parity — migration_parity | Run the migration parity command and review the routing surface | Migration parity evidence is documented | Fresh audit debt may still remain visible |`;
  }

  if (scenario.family === "planner_core_shared_surface_retro_reuse") {
    return `| Planner-core retro reuse stays deterministic. | N/A — no story registry | Retro promotion command path | proof:command_smoke — command_smoke | Run retro_promote.mjs preview for the planner-core retro fixture | The shared planner-core retro reuses the canonical family | Final operator docs are handled separately |`;
  }

  return `| ${scenario.goal} stays within the documented contract. | N/A — no story registry | Repo-local acceptance fixture | proof:doc_contract_check — doc_contract_check | Review the changed surface against the fixture contract | The scenario stays within the declared contract | Live behavior outside the fixture remains unchanged |`;
}

function buildPlanMarkdown(scenario) {
  const boundaries = scenario.files.join(", ");
  const derivedObligations = scenario.learned_obligation_fixture
    ? `Early steering for ${scenario.learned_obligation_fixture.id} plus ${scenario.gate.name} coverage.`
    : scenario.objective_claim_fixture
      ? `Structured objective proof for ${scenario.objective_claim_fixture.claim_id}.`
      : scenario.family === "migration_parity_stale_audit"
        ? "Migration parity proof plus audit freshness visibility."
        : scenario.family === "planner_core_shared_surface_retro_reuse"
          ? "Retro reuse preview plus planner-core shared-surface parity."
          : "Acceptance fixture parity across planner surfaces.";
  const verificationRow = buildVerificationStrategyRow(scenario);

  return `# Plan

## Goal
${scenario.goal}

## Problem Statement
Archetype acceptance fixtures should keep the planner compiler pipeline deterministic across preflight, refresh, gate, and ontology surfaces.

## Files To Modify
${scenario.files.map((filePath) => `- ${filePath}`).join("\n")}

## Steps
1. Seed the deterministic scenario artifacts.
2. Exercise the planner surface under test.
3. Compare the result against the shared scenario contract.

${buildVerificationSynthesisBlock({ boundaries, derivedObligations })}
${semanticUpkeepContractBlock({
  validationBundle: scenario.family === "migration_parity_stale_audit" ? "mixed" : "behavioral",
  closeBlockerIfSkipped: "The archetype acceptance layer would stop matching the runtime compiler pipeline.",
})}

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
${verificationRow}

## Success Criteria
1. The archetype scenario behaves according to its deterministic acceptance contract.

## Fix Classification
Acceptance matrix regression
`;
}

function buildReflectionMarkdown() {
  return `# Reflection

## Solution Verdict
PASS — the acceptance fixture produced the intended scenario shape.

## Semantic Verdict
PASS — the generated planner surfaces remain coherent for this scenario.

## Evidence-Readiness Verdict
PASS — the fixture is ready to enter VALIDATE.

## Next Move
Proceed to VALIDATE
`;
}

function buildVerificationMarkdown(scenario) {
  const claim = scenario.objective_claim_fixture;
  const deliverableSection = claim
    ? `## Deliverable Evidence
### ${claim.deliverable_name}
- PASS: ${claim.deliverable_name} keeps ${claim.quality_bar} during manual observation in the acceptance fixture.
Mode: ${claim.evidence_mode || "manual_observation"}

`
    : "";

  return `# Verification

## Criteria Verification
| # | Criterion | Method | Result |
|---|---|---|---|
| 1 | Fixture contract remains coherent | Acceptance fixture review | PASS |

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Bootstrapped | PASS | Scenario fixture seeded |
| Locally / unit tested | PASS | Deterministic planner fixture |
| Context-appropriate integration tested | PASS | Acceptance fixture evidence recorded |
| Audit reviewed | ${scenario.audit_fixture?.profile === "fresh" ? "PASS" : "PENDING"} | ${scenario.audit_fixture?.profile === "fresh" ? "Fresh audit log fixture" : "Audit freshness handled separately"} |
| Live approved | NOT REQUESTED | Out of scope |

## Systems Exercised
- Planner acceptance fixture for ${scenario.id}

## Remaining Unverified
None inside the deterministic fixture boundary.

## Verification Sufficiency
The acceptance fixture is sufficient for scenario-level planner regression coverage.

${deliverableSection}## Regression Audit
N/A — acceptance matrix fixture.

## Proof of Work
\`\`\`text
fixture
PASS
\`\`\`
`;
}

function createObjectiveIntentContract(claim) {
  return {
    version: 1,
    primary_user: claim.primary_user || "Site visitor",
    job_to_be_done: claim.job_to_be_done || `Use ${claim.deliverable_name} successfully`,
    desired_outcomes: [claim.quality_bar],
    anti_goals: [claim.anti_goal || "Broken user journey"],
    deliverables: [
      {
        id: claim.deliverable_id,
        name: claim.deliverable_name,
        kind: claim.kind || "ui",
        required: true,
        purpose: claim.purpose,
        quality_bars: [claim.quality_bar],
        required_signals: [claim.quality_bar],
        evidence_mode: claim.evidence_mode || "manual_observation",
        objective_claims: [
          {
            id: claim.claim_id,
            type: claim.type || "nav_edge",
            from: claim.from,
            to: claim.to,
            viewport: claim.viewport || "mobile",
            required: true,
            proof_type: claim.proof_type || "browser_journey",
          },
        ],
      },
    ],
  };
}

function buildVerificationLedger(scenario) {
  const claim = scenario.objective_claim_fixture;
  const deliverableEvidence = claim
    ? [
        {
          id: `ev_${claim.deliverable_id}`,
          subject: `deliverable:${claim.deliverable_id}`,
          mode: claim.evidence_mode || "manual_observation",
          status: "passed",
        },
      ]
    : [];

  const claimEvidence = (!claim || scenario.compiler.objective_status === "missing_proof")
    ? []
    : [
        {
          id: `ev_${claim.claim_id}`,
          claim_id: claim.claim_id,
          subject: `deliverable:${claim.deliverable_id}`,
          mode: claim.proof_type || "browser_journey",
          status: "passed",
          artifacts: [scenario.browser_observation_fixture?.artifact_path || "artifacts/browser_observation.json"],
        },
      ];

  const learnedEvidence = scenario.learned_obligation_fixture?.satisfied === true
    ? [
        {
          id: `ev_${scenario.learned_obligation_fixture.id}`,
          subject: scenario.learned_obligation_fixture.subject_id,
          mode: scenario.learned_obligation_fixture.verification_mode,
          status: "passed",
          guard_type: scenario.learned_obligation_fixture.guard_type || "matrix_guard",
        },
      ]
    : [];

  return {
    version: 1,
    evidence: [...deliverableEvidence, ...claimEvidence, ...learnedEvidence],
    waivers: [],
  };
}

function seedBrowserObservation(planDir, scenario) {
  const claim = scenario.objective_claim_fixture;
  const fixture = scenario.browser_observation_fixture;
  if (!claim || !fixture || fixture.file_state === "missing") return;

  mkdirSync(join(planDir, "artifacts"), { recursive: true });
  const artifactPath = join(planDir, fixture.artifact_path || "artifacts/browser_observation.json");
  mkdirSync(dirname(artifactPath), { recursive: true });

  if (fixture.file_state === "invalid_json") {
    writeFileSync(artifactPath, "{ invalid json\n");
    return;
  }

  writeJson(artifactPath, {
    version: 1,
    observations: [
      {
        claim_id: claim.claim_id,
        status: fixture.observation_status || "passed",
        proof_type: claim.proof_type || "browser_journey",
        viewport: fixture.observation_viewport || claim.viewport || "mobile",
        from: claim.from,
        to: claim.to,
        detail: fixture.detail || `${claim.deliverable_name} objective proof fixture`,
      },
    ],
  });
}

function seedLearnedObligationOverlay(projectRoot, scenario) {
  const learned = scenario.learned_obligation_fixture;
  if (!learned) {
    writeJson(join(projectRoot, "planner.learned_obligations.json"), {
      version: 1,
      obligations: [],
    });
    return;
  }

  writeJson(join(projectRoot, "planner.learned_obligations.json"), {
    version: 1,
    obligations: [
      {
        id: learned.id,
        subject_id: learned.subject_id,
        verification_mode: learned.verification_mode,
        status: learned.status || "active",
        required_by_phase: learned.required_by_phase || "reflect",
        steer_from_phase: learned.steer_from_phase || "plan",
        guard_types: [learned.guard_type || "matrix_guard"],
        minimum_trigger_families: 2,
        triggers: {
          file_globs: learned.file_globs || ["src/**"],
          plan_terms: learned.plan_terms || ["matrix plan steering"],
        },
      },
    ],
  });
}

function seedMistakeOverlay(projectRoot) {
  writeJson(join(projectRoot, "planner.mistake_overrides.json"), {
    version: 1,
    mistakes: [],
  });
}

function seedRetroPromotionFixture(projectRoot, scenario) {
  const retro = scenario.retro_fixture;
  if (!retro) return;

  const retroDir = join(projectRoot, "plans", "knowledge", "retros");
  mkdirSync(join(retroDir, "cases"), { recursive: true });

  const caseFile = `plans/knowledge/retros/cases/${retro.retro_id}.md`;
  writeJson(join(retroDir, "retro_ledger.json"), {
    version: 1,
    retros: [
      {
        id: retro.retro_id,
        date: "2026-04-14",
        title: "Planner-core shared surface retro reuse fixture",
        summary: "Planner-core retros should reuse the canonical mistake family instead of spawning redundant new families.",
        failure_modes: ["missed_blast_radius"],
        discovered_phase: "validate-to-close",
        affected_surfaces: scenario.files,
        root_cause: "The planner-core contract was treated as a local fix instead of a shared surface.",
        promotion_decision: "docs_only",
        status: "accepted",
        case_file: caseFile,
        promotions: null,
        kb_refs: ["plans/knowledge/mistakes.md#M-001"],
        related_story_ids: [],
        related_plan_ids: [],
        supersedes: [],
        tags: ["planner_core", "retro_reuse"],
      },
    ],
  });
  writeText(join(projectRoot, caseFile), `# ${retro.retro_id}

## Incident
The planner-core retro fixture should deterministically reuse M-001.
`);
}

function seedAcceptancePlan(projectRoot, scenario) {
  const planName = `plan_${scenario.id}`;
  const planDir = join(projectRoot, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeText(join(projectRoot, "plans", ".current_plan"), planName);

  const state = createInitialStateJson(planName, scenario.goal, { projectRoot });
  state.state = scenario.gate.name === "plan-to-execute" ? "PLAN" : "REFLECT";

  if (scenario.gate.name === "plan-to-execute") {
    writeText(join(planDir, "decisions.md"), `# Decision Log

## D-001
Accepted the shared archetype acceptance fixture.
`);
  } else {
    writeText(join(planDir, "decisions.md"), "# Decision Log\n\n## D-001\nAcceptance fixture prepared.\n");
    writeText(join(planDir, "reflection.md"), buildReflectionMarkdown());
    writeText(join(planDir, "progress.md"), `# Progress

## Completed
- [x] Seeded acceptance fixture
`);
    writeText(join(planDir, "verification.md"), buildVerificationMarkdown(scenario));
  }

  writeStateJson(planDir, state);
  writeText(join(planDir, "plan.md"), buildPlanMarkdown(scenario));
  writeText(join(planDir, "summary.md"), "# Summary\n\n[KB_NO_NEW_LEARNINGS]\n");

  if (scenario.objective_claim_fixture) {
    writeJson(join(planDir, "intent_contract.json"), createObjectiveIntentContract(scenario.objective_claim_fixture));
    writeJson(join(planDir, "verification_ledger.json"), buildVerificationLedger(scenario));
    seedBrowserObservation(planDir, scenario);
  } else if (scenario.learned_obligation_fixture) {
    writeJson(join(planDir, "verification_ledger.json"), buildVerificationLedger(scenario));
  }

  seedLearnedObligationOverlay(projectRoot, scenario);

  return { planName, planDir };
}

function seedPoisonedPlan(projectRoot, scenario) {
  const planName = `plan_${scenario.id}`;
  const planDir = join(projectRoot, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeText(join(projectRoot, "plans", ".current_plan"), planName);

  const state = createInitialStateJson(planName, scenario.goal, { projectRoot });
  state.state = scenario.active_plan?.state || "PLAN";
  state.transitions = [
    { from: "INIT", to: "EXPLORE", gate_result: "SKIP", timestamp: "2026-04-07T10:00:00Z" },
    { from: "EXPLORE", to: "PLAN", gate_result: "PASS", timestamp: "2026-04-07T10:01:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:02:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:03:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:04:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:05:00Z" },
    { from: "PLAN", to: "PLAN", gate_result: "FAIL", failure_codes: ["GATE-PLAN-001"], timestamp: "2026-04-07T10:06:00Z" },
  ];
  writeStateJson(planDir, state);
  writeText(join(planDir, "plan.md"), `# Plan

## Goal
${scenario.goal}

## Files To Modify
${scenario.files.map((filePath) => `- ${filePath}`).join("\n")}
`);
}

export function seedArchetypePreflightFixture(projectRoot, scenario) {
  mkdirSync(join(projectRoot, "plans"), { recursive: true });
  seedAgentLink(projectRoot);
  seedKnowledgeBase(projectRoot);
  seedDiscoveryPolicy(projectRoot, scenario.archetype);
  seedAuditLog(projectRoot, scenario.audit_fixture);

  if (scenario.active_plan?.poisoned) {
    seedPoisonedPlan(projectRoot, scenario);
  }
}

export function seedArchetypeAcceptanceFixture(projectRoot, scenario) {
  mkdirSync(join(projectRoot, "plans"), { recursive: true });
  seedAgentLink(projectRoot);
  seedKnowledgeBase(projectRoot);
  seedDiscoveryPolicy(projectRoot, scenario.archetype);
  seedMistakeOverlay(projectRoot);
  const seeded = seedAcceptancePlan(projectRoot, scenario);
  seedRetroPromotionFixture(projectRoot, scenario);
  seedAuditLog(projectRoot, scenario.audit_fixture);
  return seeded;
}
