#!/usr/bin/env node

import assert from "assert/strict";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadRules, loadStateFacts, loadStoryFacts } from "../scripts/lib/fact_loader.mjs";
import { refreshPlanArtifacts } from "../scripts/lib/plan_refresh.mjs";
import { createInitialStateJson, writeStateJson } from "../scripts/lib/determinism.mjs";
import {
  classifyPlannedEvidencePath,
  deriveVerificationTruth,
  normalizePresentationResult,
  normalizeVerificationMode,
  readVerificationLedger,
  syncLedgerFromStrategy,
} from "../scripts/lib/verification_truth.mjs";
import {
  compileVerificationStatusFacts,
  getVerificationStatusVocabulary,
  normalizeVerificationStatus,
  verificationStatusIsHardFailure,
} from "../scripts/lib/verification_status_vocabulary.mjs";
import { selectCriterionStoryTable } from "../scripts/lib/verification_matrix.mjs";
import {
  migratePlanVerificationStrategy,
  scaffoldVerificationStrategy,
} from "../scripts/lib/verification_strategy.mjs";
import { serializeToFacts } from "../scripts/ontology_serializer.mjs";
import { scanProofStatusRepository, scanProofStatusSource } from "../scripts/proof_status_census.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const ruleEngineScript = join(skillDir, "scripts", "rule_engine.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function consultVerificationStatusTruth(session) {
  session.consultFile(join(skillDir, "prolog", "verification_statuses.pl"));
  session.consult(compileVerificationStatusFacts());
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS: ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL: ${label}`);
    console.log(`        ${error.message}`);
  }
}

function makePlanDir(name) {
  const root = mkdtempSync(join(tmpdir(), `planner-verification-truth-${name}-`));
  const planDir = join(root, "plans", "plan_fixture");
  mkdirSync(planDir, { recursive: true });
  return { root, planDir };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function markdownProofTable(result = "PASS") {
  return `# Verification

## Criteria Verification
| Criterion | Result | Evidence |
|---|---|---|
| Fixture criterion | ${result} | Command output below. |

## Proof
\`\`\`text
node fixture-test.mjs
all fixture checks passed
0 failures across the fixture proof bundle
\`\`\`

This verification report contains enough ordinary explanatory words to satisfy the legacy markdown proof floor. The command output is intentionally small but substantive, and the table result token remains strict so presentation nuance belongs in the evidence column instead of the result column. Additional context records deterministic command execution, expected behavior, observed behavior, residual scope, operator rationale, regression coverage, artifact provenance, and closeout confidence without relying on ornamental wording.
`;
}

function writeKnowledgeFixture(root) {
  const kbDir = join(root, "plans", "knowledge");
  mkdirSync(kbDir, { recursive: true });
  writeFileSync(join(kbDir, "index.md"), "# Knowledge Base Index\n");
  writeFileSync(join(kbDir, "mistakes.md"), "# Mistakes\n\n## M-001\nFixture mistake.\n");
  writeFileSync(join(kbDir, "patterns.md"), "# Patterns\n\n## P-001\nFixture pattern.\n");
  writeFileSync(join(kbDir, "gotchas.md"), "# Gotchas\n\n## G-001\nFixture gotcha.\n");
}

function makeRuntimeFixture(name, result = "PASS") {
  const root = mkdtempSync(join(tmpdir(), `planner-verification-runtime-${name}-`));
  const planName = "plan_fixture";
  const planDir = join(root, "plans", planName);
  mkdirSync(planDir, { recursive: true });
  writeKnowledgeFixture(root);
  writeFileSync(join(root, "plans", ".current_plan"), `${planName}\n`);
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Verification truth runtime fixture

## Problem Statement
Strict close-result parsing must be shared by Prolog, ontology, and diagnostics.

## Files To Modify
- .agent/skills/iterative-planner/scripts/lib/verification_truth.mjs

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| sc_1 | US-077 | node .agent/skills/iterative-planner/tests/test_verification_truth.mjs | PASS |
`);
  writeFileSync(join(planDir, "verification.md"), markdownProofTable(result));
  writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] Fixture seeded.\n");
  const state = createInitialStateJson(planName, "Verification truth runtime fixture", { projectRoot: root });
  state.state = "VALIDATE";
  writeStateJson(planDir, state);
  return { root, planName, planDir };
}

function loadRuntimeSession(fixture) {
  const session = createSession();
  loadRules(session, { cwd: fixture.root, skillPath: skillDir });
  loadStateFacts(session, { cwd: fixture.root, skillPath: skillDir });
  return session;
}

check("strict presentation result tokens reject residual-warning prose", () => {
  assert.equal(normalizePresentationResult("PASS").kind, "pass");
  assert.equal(normalizePresentationResult("WAIVED").kind, "waived");
  assert.equal(normalizePresentationResult("N/A").kind, "not_applicable");
  assert.equal(normalizePresentationResult("NOT APPLICABLE").kind, "not_applicable");
  assert.equal(normalizePresentationResult("PARTIAL PASS").valid, false);
  assert.equal(normalizePresentationResult("PASS WITH RESIDUAL WARNINGS").valid, false);
  assert.equal(normalizePresentationResult("PASS AT CLOSE ENTRY").valid, false);
});

check("configured verification vocabulary has exact JavaScript and Prolog parity", () => {
  const vocabulary = getVerificationStatusVocabulary();
  const session = createSession();
  session.consultFile(join(skillDir, "prolog", "verification_statuses.pl"));
  session.consult(compileVerificationStatusFacts());

  for (const [context, definition] of Object.entries(vocabulary.contexts)) {
    for (const status of definition.statuses) {
      for (const form of status.forms) {
        const normalized = normalizeVerificationStatus(form, context);
        assert.equal(normalized.valid, true, `${context}:${form} is valid in JavaScript`);
        assert.equal(normalized.canonical, status.canonical, `${context}:${form} canonicalizes in JavaScript`);
        assert.equal(normalized.kind, status.kind, `${context}:${form} classifies in JavaScript`);
        assert.equal(normalized.satisfies, status.satisfies, `${context}:${form} has the configured JavaScript truth value`);
        assert.equal(
          verificationStatusIsHardFailure(form, context),
          status.kind === "fail",
          `${context}:${form} has the configured hard-failure classification`,
        );
        assert(
          session.check(
            `verification_status_token('${context}', '${normalized.token.replace(/'/g, "\\'")}', '${status.canonical.replace(/'/g, "\\'")}', '${status.kind}', ${status.satisfies ? "true" : "false"})`,
          ),
          `${context}:${form} has the same Prolog classification`,
        );
      }
    }
  }
  assert.equal(verificationStatusIsHardFailure("GREENISH", "gate"), true, "unknown gate status is a fail-closed hard failure");
  assert.equal(verificationStatusIsHardFailure("WARN", "gate"), false, "configured pending gate status remains advisory");
});

check("MCP verification writer schema exposes only canonical presentation statuses", () => {
  const tools = JSON.parse(readFileSync(join(skillDir, "config", "mcp_tools.json"), "utf-8"));
  const exposed = tools.tools?.add_verification_result?.inputSchema?.properties?.status?.enum || [];
  const canonical = getVerificationStatusVocabulary().contexts.presentation.statuses.map((status) => status.canonical);
  assert.deepEqual(exposed, canonical);
  assert.equal(normalizeVerificationStatus("UNVERIFIED", "presentation").valid, false);
});

check("Active Mistake evidence never upgrades a non-satisfying status", () => {
  const makeFacts = (status, evidence = "Executed planner truth packet and preserved the raw receipt.") => {
    const safeStatus = String(status || "missing").replace(/[^A-Za-z0-9]+/g, "-");
    const { root, planDir } = makePlanDir(`active-mistake-${safeStatus}`);
    const planContent = `# Plan

## Active Mistake Response
| Mistake | Guard | Planned handling | Planned evidence |
|---|---|---|---|
| M-PLANNER-DOGFOOD-001 | planner_truth_packet | Preserve semantic truth. | Run the real packet. |
`;
    writeFileSync(join(planDir, "plan.md"), planContent);
    writeFileSync(join(planDir, "verification.md"), `# Verification

## Active Mistake Evidence
| Mistake | Hook | Status | Evidence |
|---|---|---|---|
| M-PLANNER-DOGFOOD-001 | planner_truth_packet | ${status} | ${evidence} |
`);
    const facts = serializeToFacts({ cwd: root, planDir, planContent, storyRegistry: null, annotations: [] }).facts;
    return { root, facts };
  };

  const pass = makeFacts("PASS");
  const fail = makeFacts("FAIL");
  const unknown = makeFacts("GREENISH");
  const missing = makeFacts("");
  const pending = makeFacts("PENDING");
  const waived = makeFacts("WAIVED");
  const notApplicable = makeFacts("N/A");
  try {
    assert(pass.facts.includes("mistake_hook_satisfied('M-PLANNER-DOGFOOD-001', 'planner_truth_packet')."));
    for (const fixture of [fail, unknown, missing, pending, waived, notApplicable]) {
      assert(!fixture.facts.includes("mistake_hook_satisfied('M-PLANNER-DOGFOOD-001', 'planner_truth_packet')."));
    }

    const session = createSession();
    session.consultFile(join(skillDir, "prolog", "invariants.pl"));
    session.consult(fail.facts);
    session.consult(`
active_mistake('M-PLANNER-DOGFOOD-001').
mistake_verification_hook('M-PLANNER-DOGFOOD-001', 'planner_truth_packet').
phase_reached(reflect).
`);
    assert(session.check("invariant_violated(active_mistake_missing_verification_hook, 'M-PLANNER-DOGFOOD-001')"));
  } finally {
    for (const fixture of [pass, fail, unknown, missing, pending, waived, notApplicable]) {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

check("proof-status structural census is a governed executable surface", () => {
  assert(existsSync(join(skillDir, "scripts", "proof_status_census.mjs")), "proof_status_census.mjs must exist");
  assert(existsSync(join(skillDir, "config", "proof_status_reader_census.json")), "proof_status_reader_census.json must exist");
});

check("proof-status repository census is exhaustive and fully classified", () => {
  const result = scanProofStatusRepository({ root: repoRoot });
  assert.equal(result.status, "PASS", JSON.stringify(result.issues, null, 2));
  assert.equal(
    result.denominators.checked_javascript_files,
    result.denominators.javascript_files + result.denominators.excluded_nonproduction_javascript_files,
    "every checked JavaScript file is classified as production-scanned or explicitly nonproduction",
  );
  assert.equal(result.denominators.checked_prolog_files, 20);
  assert.equal(
    result.denominators.scanned_production_files,
    result.denominators.javascript_files + result.denominators.prolog_files,
    "the production denominator equals the complete scanned JavaScript and Prolog boundary",
  );
  assert.equal(result.denominators.excluded_nonproduction_javascript_files, 145);
  assert.equal(result.denominators.registered_readers, 96);
  assert.equal(result.denominators.canonical_derived_readers, 9);
  assert.equal(result.denominators.repaired_readers, 87);
  assert.equal(result.denominators.discovered_candidates, 76);
  assert.equal(result.denominators.live_exemptions, 73);
  assert.equal(result.denominators.protocol_exemptions, 73);
  for (const exemption of result.protocol_exemptions) {
    const candidate = result.candidates.find((entry) => entry.id === exemption.id);
    assert.equal(candidate?.exemption?.valid, true, `${exemption.id} has a live inline annotation`);
  }
  assert.equal(result.issues.length, 0);
});

check("proof-status scanner catches JavaScript and Prolog reader shapes without variable-name dependence", () => {
  const direct = scanProofStatusSource(`const green = verdict === "PASS";`, { path: "fixture.mjs" });
  assert(direct.some((candidate) => candidate.reader_class === "direct_status_comparison"));

  const regex = scanProofStatusSource(`const green = /^PASS$/i.test(outcome);`, { path: "fixture.mjs" });
  assert(regex.some((candidate) => candidate.reader_class === "status_regex"));

  const collection = scanProofStatusSource(`const accepted = new Set([\n  "pass",\n  "verified",\n]).has(value);`, { path: "fixture.mjs" });
  assert(collection.some((candidate) => candidate.reader_class === "status_collection"));

  const prolog = scanProofStatusSource(`subject_ok(S) :- member(S, [passed, pass, ok, verified]).`, {
    path: "fixture.pl",
    language: "prolog",
  });
  assert(prolog.some((candidate) => candidate.reader_class === "prolog_status_list"));

  assert.equal(scanProofStatusSource(`const ok = verificationStatusIsPass(value, "execution");`, { path: "fixture.mjs" }).length, 0);
  assert.equal(scanProofStatusSource(`const closed = state === "CLOSE";`, { path: "fixture.mjs" }).length, 0);
});

check("proof-status scanner binds narrow exemptions to a live candidate and reason", () => {
  const valid = scanProofStatusSource(`// proof-status-lint: exempt T-INTAKE-B07B8898 -- signed machine producer maps exit code and cannot assert authored proof\nconst ok = result === "PASS";`, { path: "fixture.mjs" });
  assert.equal(valid.length > 0, true);
  assert.equal(valid[0].exemption?.valid, true);
  assert.equal(valid[0].exemption?.ticket, "T-INTAKE-B07B8898");

  const blank = scanProofStatusSource(`// proof-status-lint: exempt T-INTAKE-B07B8898 -- short\nconst ok = result === "PASS";`, { path: "fixture.mjs" });
  assert.equal(blank[0].exemption?.valid, false);
  assert.equal(blank[0].exemption?.error, "exemption_reason_too_short");
});

check("unsupported historical modes normalize to the strict mode enum", () => {
  assert.equal(normalizeVerificationMode("integration"), "integration_smoke");
  assert.equal(normalizeVerificationMode("migration_simulation"), "migration_smoke");
  assert.equal(normalizeVerificationMode("browser_journey"), "browser_visual");
});

check("structured presentation truth constrains an otherwise passing ledger", () => {
  const { root, planDir } = makePlanDir("ledger-first");
  try {
    writeFileSync(join(planDir, "plan.md"), "# Plan\n");
    writeFileSync(join(planDir, "verification.md"), markdownProofTable("PASS WITH RESIDUAL WARNINGS"));
    writeJson(join(planDir, "verification_ledger.json"), {
      version: 1,
      obligations: [
        { id: "vo_migration", subject: "crit:sc_1", mode: "migration_smoke", severity: "required" },
      ],
      evidence: [
        {
          id: "ev_migration",
          subject: "crit:sc_1",
          mode: "migration_smoke",
          status: "PASS",
          command: "node .agent/skills/iterative-planner/tests/ive/run.mjs --only migration-bootstrap --json --no-manifest",
          evidence: "migration smoke passed",
        },
      ],
    });

    const truth = deriveVerificationTruth({ planDir });
    assert.equal(truth.source, "ledger");
    assert.equal(truth.allVerificationPass, false);
    assert.equal(truth.proofOfWork, true);
    assert.equal(truth.hasPassedMode.migration_smoke, true);
    assert(truth.details.some((detail) => detail.includes("PASS WITH RESIDUAL WARNINGS")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("markdown fallback remains available for no-ledger plans", () => {
  const { root, planDir } = makePlanDir("markdown-fallback");
  try {
    writeFileSync(join(planDir, "verification.md"), markdownProofTable("PASS"));
    const truth = deriveVerificationTruth({ planDir });
    assert.equal(truth.source, "markdown_fallback");
    assert.equal(truth.allVerificationPass, true);
    assert.equal(truth.proofOfWork, true);
    assert(truth.warnings.includes("verification_ledger_missing_markdown_fallback_deprecated"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("markdown fallback accepts only canonical Validation Status table outcomes", () => {
  const { root, planDir } = makePlanDir("validation-status-fallback");
  try {
    const report = (status) => `# Verification

## Validation Status
| Level | Status | Evidence |
|---|---|---|
| Locally tested | ${status} | Focused command output recorded. |

## Proof of Work
\`\`\`text
node fixture-test.mjs
focused validation fallback proof completed
\`\`\`
`;
    writeFileSync(join(planDir, "verification.md"), report("PASS"));
    assert.equal(deriveVerificationTruth({ planDir }).allVerificationPass, true);
    writeFileSync(join(planDir, "verification.md"), report("FAIL"));
    assert.equal(deriveVerificationTruth({ planDir }).allVerificationPass, false);
    writeFileSync(join(planDir, "verification.md"), report("GREENISH"));
    const unknown = deriveVerificationTruth({ planDir });
    assert.equal(unknown.allVerificationPass, false);
    assert(unknown.details.some((detail) => detail.includes("invalid_presentation_result")));
    writeFileSync(join(planDir, "verification.md"), report(""));
    assert.equal(deriveVerificationTruth({ planDir }).allVerificationPass, false);
    writeFileSync(join(planDir, "verification.md"), `# Verification

## Criteria Verification
| Criterion | Status | Evidence |
|---|---|---|
| Blank status fixture | | Missing status must fail closed. |
`);
    assert.equal(deriveVerificationTruth({ planDir }).allVerificationPass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("ledger evidence satisfaction follows the configured evidence context", () => {
  const { root, planDir } = makePlanDir("ledger-status-satisfaction");
  try {
    writeFileSync(join(planDir, "verification.md"), markdownProofTable("PASS"));
    const ledger = {
      version: 1,
      obligations: [],
      evidence: [{ id: "ev_status", subject: "crit:sc_1", mode: "unit_test", status: "WAIVED" }],
      waivers: [],
    };
    writeJson(join(planDir, "verification_ledger.json"), ledger);
    assert.equal(deriveVerificationTruth({ planDir }).allVerificationPass, true);
    ledger.evidence[0].status = "PENDING";
    writeJson(join(planDir, "verification_ledger.json"), ledger);
    assert.equal(deriveVerificationTruth({ planDir }).allVerificationPass, false);
    ledger.evidence[0].status = "GREENISH";
    writeJson(join(planDir, "verification_ledger.json"), ledger);
    const unknown = deriveVerificationTruth({ planDir });
    assert.equal(unknown.allVerificationPass, false);
    assert(unknown.unknownEvidence.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("required ledger obligations accept only an approved matching waiver", () => {
  const { root, planDir } = makePlanDir("ledger-approved-waiver");
  try {
    writeFileSync(join(planDir, "verification.md"), markdownProofTable("PASS"));
    writeJson(join(planDir, "verification_ledger.json"), {
      version: 1,
      obligations: [{ id: "vo_waived", subject: "crit:sc_1", mode: "unit_test", severity: "required" }],
      evidence: [],
      waivers: [{
        id: "wv_waived",
        subject: "crit:sc_1",
        mode: "unit_test",
        approved_by: "user",
        reason: "The bounded fixture explicitly approves this non-production obligation waiver.",
      }],
    });
    const truth = deriveVerificationTruth({ planDir });
    assert.equal(truth.allVerificationPass, true);
    assert.equal(truth.unsatisfiedObligations.length, 0);
    assert.equal(truth.hasPassedMode.unit_test, true);
    assert.equal(truth.proofOfWork, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("ontology anti-recurrence evidence requires canonical PASS and a guard type", () => {
  const { root, planDir } = makePlanDir("ontology-anti-recurrence");
  const planContent = `# Plan

## Goal
Fix a recurring proof-status bug with a regression guard.
`;
  const makeFacts = (section) => {
    writeFileSync(join(planDir, "verification.md"), `# Verification\n\n## Anti-Recurrence Guard\n${section}\n`);
    return serializeToFacts({ cwd: root, planDir, planContent, storyRegistry: null, annotations: [] }).facts;
  };
  try {
    const recipeDir = join(root, "recipes", "proof-status-fixture");
    mkdirSync(recipeDir, { recursive: true });
    writeJson(join(recipeDir, "recipe.json"), {
      id: "proof-status-fixture",
      title: "Proof status fixture",
      runner: {
        type: "node",
        cwd: ".",
        command: ["node", "scripts/proof-status-fixture.mjs"],
        dry_run_flags: ["--dry-run"],
        live_flags: ["--execute"],
      },
    });
    const tablePass = makeFacts("| Status | Guard Type | Evidence |\n|---|---|---|\n| FAIL | structural | Negative control. |\n| PASS | test / structural | Firing guard. |");
    assert(tablePass.includes("recipe_runner_type('proof-status-fixture', 'node')."));
    assert(tablePass.includes("verification_evidence('ev_plan_anti_recurrence', 'plan:anti-recurrence', 'artifact_review', 'passed')."));
    const tableFail = makeFacts("| Status | Guard Type | Evidence |\n|---|---|---|\n| FAIL | test | Firing negative. |");
    assert(!tableFail.includes("verification_evidence('ev_plan_anti_recurrence'"));
    const labeledPass = makeFacts("Status: PASS\nGuard Types: test, structural");
    assert(labeledPass.includes("verification_evidence('ev_plan_anti_recurrence'"));
    const inlinePass = makeFacts("PASS - Guard Types: test / structural");
    assert(inlinePass.includes("verification_evidence('ev_plan_anti_recurrence'"));
    const noGuard = makeFacts("Status: PASS");
    assert(!noGuard.includes("verification_evidence('ev_plan_anti_recurrence'"));
    const missingSection = makeFacts("");
    assert(!missingSection.includes("verification_evidence('ev_plan_anti_recurrence'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("canonical strategy writers preserve the Markdown compatibility projection", () => {
  const { root, planDir } = makePlanDir("strategy-compatibility-projection");
  try {
    mkdirSync(join(root, "reports", "user_story_audit"), { recursive: true });
    writeJson(join(root, "reports", "user_story_audit", "story_registry.json"), {
      version: 1,
      stories: [{ id: "US-077", status: "FULLY_COVERED" }],
    });
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Preserve canonical strategy compatibility projections for every reader.

## Files To Modify
- .agent/skills/iterative-planner/scripts/lib/verification_strategy.mjs

## Success Criteria
1. Forced strategy writers retain the rendered verification matrix.

## Verification Obligation Synthesis
- Repo/system context: canonical strategy and legacy mirror readers
- Derived verification obligations: compatibility projection parity
- System boundaries touched: strategy scaffolding, migration, and matrix readers
- Task shape: planner-core

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| sc_1 | US-077 | canonical strategy and legacy mirror readers | proof:integration_smoke | node fixture-test.mjs | forced writers keep the rendered matrix | remote migration is not exercised |
`);

    const created = scaffoldVerificationStrategy({ cwd: root, planDir });
    assert.equal(created.ok, true);
    let table = selectCriterionStoryTable(readFileSync(join(planDir, "plan.md"), "utf-8"));
    assert(table && table.rows.length === 1, "creation renders a compatibility table for mirror readers");

    const forced = scaffoldVerificationStrategy({ cwd: root, planDir, force: true });
    assert.equal(forced.ok, true);
    table = selectCriterionStoryTable(readFileSync(join(planDir, "plan.md"), "utf-8"));
    assert(table && table.rows.length === 1, "forced scaffolding retains the compatibility table");

    const migrated = migratePlanVerificationStrategy({ cwd: root, planDir, force: true });
    assert.equal(migrated.ok, true);
    table = selectCriterionStoryTable(readFileSync(join(planDir, "plan.md"), "utf-8"));
    assert(table && table.rows.length === 1, "forced migration retains the compatibility table");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("markdown fallback blocks non-strict presentation result tokens", () => {
  const { root, planDir } = makePlanDir("markdown-invalid-token");
  try {
    writeFileSync(join(planDir, "verification.md"), markdownProofTable("PASS WITH RESIDUAL WARNINGS"));
    const truth = deriveVerificationTruth({ planDir });
    assert.equal(truth.source, "markdown_fallback");
    assert.equal(truth.allVerificationPass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("fact loader uses shared truth for ambiguous markdown result tokens", () => {
  const fixture = makeRuntimeFixture("fact-loader-partial", "PARTIAL PASS");
  try {
    const session = loadRuntimeSession(fixture);
    assert(session.check("all_verification_pass(false)"), "ambiguous result token blocks all_verification_pass");
    assert(session.check("proof_of_work(true)"), "substantive proof remains proof_of_work even when result token is invalid");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

check("fact loader projects valid evidence and environment-preflight receipt truth", () => {
  const fixture = makeRuntimeFixture("fact-loader-environment-receipt", "PASS");
  try {
    const session = createSession();
    loadStateFacts(session, {
      cwd: fixture.root,
      skillPath: skillDir,
      transientCloseSignals: {
        quant_results_validation: {
          required: true,
          satisfied: true,
          status: "diagnostic_only",
          evidence_validity: "valid",
          claim_support_allowed: true,
          numeric_output_reportable: true,
          environment_preflight_receipt: {
            status: "valid",
            performed: true,
            probe_count: 1,
          },
        },
      },
    });

    assert(session.check("quant_results_evidence_validity(valid)"), "valid evidence state reaches runtime Prolog");
    assert(session.check("quant_results_claim_support_allowed(true)"), "valid evidence can support claims");
    assert(session.check("quant_results_numeric_output_reportable(true)"), "valid numeric output is reportable");
    assert(session.check("quant_results_environment_preflight_status(valid)"), "receipt status reaches runtime Prolog");
    assert(session.check("quant_results_environment_preflight_performed(true)"), "performed receipt reaches runtime Prolog");
    assert(session.check("quant_results_environment_preflight_probe_count(1)"), "integer probe count reaches runtime Prolog");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

check("plan refresh fails closed for missing plans and malformed optional story registries", () => {
  const fixture = makeRuntimeFixture("plan-refresh-defensive-inputs", "PASS");
  try {
    const missing = refreshPlanArtifacts({
      cwd: fixture.root,
      skillPath: skillDir,
      planDirName: "plan_missing",
      refreshOntology: false,
      persistState: false,
      syncFindings: false,
    });
    assert.deepEqual(missing, {
      refreshed: false,
      skipped: "missing_plan_dir",
      planDirName: "plan_missing",
    });

    const registryDir = join(fixture.root, "reports", "user_story_audit");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, "story_registry.json"), "{ malformed optional registry\n");
    const statePath = join(fixture.planDir, "state.json");
    const stateBefore = readFileSync(statePath, "utf-8");
    const refreshed = refreshPlanArtifacts({
      cwd: fixture.root,
      skillPath: skillDir,
      planDirName: fixture.planName,
      refreshOntology: false,
      persistState: false,
      syncFindings: false,
    });

    assert.equal(refreshed.refreshed, true, "malformed optional registry does not block refresh");
    assert.equal(refreshed.stateWritten, false, "read-only refresh does not persist state");
    assert.equal(readFileSync(statePath, "utf-8"), stateBefore, "read-only refresh leaves state.json byte-identical");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

check("fact loader authorizes transient registry refresh without weakening tamper detection", () => {
  const fixture = makeRuntimeFixture("registry-refresh-authorization", "PASS");
  const registryDir = join(fixture.root, "reports", "user_story_audit");
  const registryPath = join(registryDir, "story_registry.json");
  try {
    mkdirSync(registryDir, { recursive: true });
    writeJson(registryPath, { version: 1, stories: [] });
    const state = JSON.parse(readFileSync(join(fixture.planDir, "state.json"), "utf-8"));
    state.registry_hash = "stale-registry-hash";
    writeStateJson(fixture.planDir, state);

    const ordinary = createSession();
    loadStoryFacts(ordinary, { cwd: fixture.root });
    assert(ordinary.check("registry_tampered(true)"), "ordinary reads retain signed registry tamper detection");

    const transient = createSession();
    loadStoryFacts(transient, { cwd: fixture.root, transientRegistryRefresh: true });
    assert(transient.check("registry_tampered(false)"), "same-invocation preflight models the authorized transition refresh");

    const previous = process.env._PLANNER_GATE_TRANSITION;
    const previousDryRun = process.env._PLANNER_DRY_RUN;
    process.env._PLANNER_GATE_TRANSITION = "1";
    try {
      process.env._PLANNER_DRY_RUN = "1";
      const beforeDryRun = readFileSync(join(fixture.planDir, "state.json"), "utf-8");
      const dryRun = createSession();
      loadStoryFacts(dryRun, { cwd: fixture.root });
      assert(dryRun.check("registry_tampered(false)"), "the dry-run transition environment authorizes the same transient refresh");
      assert.equal(readFileSync(join(fixture.planDir, "state.json"), "utf-8"), beforeDryRun, "dry-run registry refresh does not persist state.json");

      delete process.env._PLANNER_DRY_RUN;
      const transition = createSession();
      loadStoryFacts(transition, { cwd: fixture.root });
      assert(transition.check("registry_tampered(false)"), "the actual transition environment authorizes the same refresh");
    } finally {
      if (previous === undefined) delete process.env._PLANNER_GATE_TRANSITION;
      else process.env._PLANNER_GATE_TRANSITION = previous;
      if (previousDryRun === undefined) delete process.env._PLANNER_DRY_RUN;
      else process.env._PLANNER_DRY_RUN = previousDryRun;
    }

    writeFileSync(registryPath, "{ malformed registry fixture\n");
    const malformed = loadStoryFacts(createSession(), { cwd: fixture.root });
    assert.equal(malformed.loaded, false, "malformed registries fail closed");
    assert.match(malformed.error, /JSON/, "malformed registry diagnostics preserve the parse error");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

check("fact loader emits rich story and infrastructure traceability facts", () => {
  const fixture = makeRuntimeFixture("registry-rich-story", "PASS");
  const registryDir = join(fixture.root, "reports", "user_story_audit");
  try {
    mkdirSync(registryDir, { recursive: true });
    writeJson(join(registryDir, "story_registry.json"), {
      version: 1,
      stories: [
        { title: "missing id is ignored" },
        {
          id: "US-900",
          title: "Rich traceability story",
          priority: "HIGH",
          status: "ACTIVE",
          tags: ["planner", "traceability"],
          code_refs: ["scripts/example.mjs:10"],
          test_refs: ["tests/example.test.mjs"],
          validation_refs: ["reports/example.md"],
          doc_refs: ["docs/example.md"],
          requires: ["US-899"],
          blocked_by: ["DEF-900"],
          open_gaps: ["exercise uncommon registry branches"],
          preconditions: ["registry is readable"],
          postconditions: ["traceability facts are emitted"],
          actions: ["load the registry"],
          conflicts: ["US-901", { story_id: "US-902" }, {}],
        },
      ],
      infrastructure_stories: [{
        id: "US-901",
        title: "Retired infrastructure story",
        priority: "LOW",
        status: "RETIRED",
        conflicts: [{ with: "US-900" }],
      }],
    });

    const session = createSession();
    const result = loadStoryFacts(session, { cwd: fixture.root });
    assert.equal(result.loaded, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.activeStoryIds, ["US-900"]);
    assert.deepEqual(result.retiredStoryIds, ["US-901"]);
    assert(session.check("story_covers_script('US-900', 'example.mjs')"), "code refs emit script coverage facts");
    assert(session.check("declared_story_conflict('US-901', 'US-900')"), "object conflict refs emit declared conflict facts");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

check("ontology serializer preserves status tokens and Prolog derives strict verification truth", () => {
  const bad = makeRuntimeFixture("ontology-partial", "PARTIAL PASS");
  const waived = makeRuntimeFixture("ontology-waived", "WAIVED");
  const notApplicable = makeRuntimeFixture("ontology-na", "NOT APPLICABLE");
  try {
    const badFacts = serializeToFacts({
      cwd: bad.root,
      planDir: bad.planDir,
      planContent: readFileSync(join(bad.planDir, "plan.md"), "utf-8"),
      storyRegistry: null,
      annotations: [],
    }).facts;
    assert(/verification_result_status\([^)]*, 'PARTIAL PASS',/.test(badFacts), "PARTIAL PASS remains visible as a status fact");
    const badSession = createSession();
    badSession.consultFile(join(skillDir, "prolog", "verification_statuses.pl"));
    badSession.consult(compileVerificationStatusFacts());
    badSession.consult(badFacts);
    assert(badSession.check("verification_result(_, false, _)"), "PARTIAL PASS derives a false verification result");

    const waivedFacts = serializeToFacts({
      cwd: waived.root,
      planDir: waived.planDir,
      planContent: readFileSync(join(waived.planDir, "plan.md"), "utf-8"),
      storyRegistry: null,
      annotations: [],
    }).facts;
    const waivedSession = createSession();
    waivedSession.consultFile(join(skillDir, "prolog", "verification_statuses.pl"));
    waivedSession.consult(compileVerificationStatusFacts());
    waivedSession.consult(waivedFacts);
    assert(waivedSession.check("verification_result(_, true, _)"), "WAIVED derives a non-failing verification result");

    const naFacts = serializeToFacts({
      cwd: notApplicable.root,
      planDir: notApplicable.planDir,
      planContent: readFileSync(join(notApplicable.planDir, "plan.md"), "utf-8"),
      storyRegistry: null,
      annotations: [],
    }).facts;
    const naSession = createSession();
    naSession.consultFile(join(skillDir, "prolog", "verification_statuses.pl"));
    naSession.consult(compileVerificationStatusFacts());
    naSession.consult(naFacts);
    assert(naSession.check("verification_result(_, true, _)"), "NOT APPLICABLE derives a non-failing verification result");
  } finally {
    rmSync(bad.root, { recursive: true, force: true });
    rmSync(waived.root, { recursive: true, force: true });
    rmSync(notApplicable.root, { recursive: true, force: true });
  }
});

check("verification subjects canonicalize exact aliases without accepting a wrong proof mode", () => {
  const fixture = makeRuntimeFixture("subject-alias-mode", "PASS");
  try {
    const ledgerPath = join(fixture.planDir, "verification_ledger.json");
    writeJson(ledgerPath, {
      version: 1,
      subjects: [
        { id: "migration_parity", kind: "plan_guard" },
        { id: "plan:verification-obligation-synthesis:migration_parity", kind: "plan_guard" },
      ],
      obligations: [
        {
          id: "vo_migration_alias",
          subject: "plan:verification-obligation-synthesis:migration_parity",
          mode: "migration_smoke",
          severity: "required",
        },
      ],
      evidence: [
        {
          id: "ev_wrong_mode",
          subject: "migration_parity",
          mode: "integration_smoke",
          status: "PASS",
        },
      ],
    });

    const serialize = () => serializeToFacts({
      cwd: fixture.root,
      planDir: fixture.planDir,
      planContent: readFileSync(join(fixture.planDir, "plan.md"), "utf-8"),
      storyRegistry: null,
      annotations: [],
    }).facts;
    const wrongModeFacts = serialize();
    assert(wrongModeFacts.includes("verification_subject_alias('plan:verification-obligation-synthesis:migration_parity', 'migration_parity')."));
    assert.equal((wrongModeFacts.match(/verification_subject\('migration_parity', 'plan_guard'\)\./g) || []).length, 1);

    const wrongModeSession = createSession();
    consultVerificationStatusTruth(wrongModeSession);
    wrongModeSession.consultFile(join(skillDir, "prolog", "invariants.pl"));
    wrongModeSession.consult(wrongModeFacts);
    assert(wrongModeSession.check("subject_has_passing_evidence('migration_parity', 'integration_smoke')"));
    assert(!wrongModeSession.check("subject_has_passing_evidence('migration_parity', 'migration_smoke')"));

    const matching = JSON.parse(readFileSync(ledgerPath, "utf-8"));
    matching.evidence[0].mode = "migration_smoke";
    writeJson(ledgerPath, matching);
    const matchingModeSession = createSession();
    consultVerificationStatusTruth(matchingModeSession);
    matchingModeSession.consultFile(join(skillDir, "prolog", "invariants.pl"));
    matchingModeSession.consult(serialize());
    assert(matchingModeSession.check("subject_has_passing_evidence('migration_parity', 'migration_smoke')"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

check("synthesized verification obligations serialize only canonical proof modes", () => {
  const fixture = makeRuntimeFixture("synthesized-mode-aliases", "PASS");
  try {
    const planContent = `# Plan

## Goal
Exercise an API connector, recipe orchestration runner, and migration parity path.

## Files To Modify
- src/api/connector.mjs
- recipes/example/runner.mjs
- migrations/upgrade.mjs

## Verification Strategy
| Criterion | Story linkage | Check | Pass means |
|---|---|---|---|
| sc_1 | US-077 | proof:integration_smoke | PASS |
| sc_2 | US-077 | proof:migration_verification | PASS |
`;
    writeFileSync(join(fixture.planDir, "plan.md"), planContent);

    const facts = serializeToFacts({
      cwd: fixture.root,
      planDir: fixture.planDir,
      planContent,
      storyRegistry: null,
      annotations: [],
    }).facts;

    assert(facts.includes("verification_obligation('vos_api_integration', 'plan:verification-obligation-synthesis:api_integration', 'integration_smoke', 'required')."));
    assert(facts.includes("verification_obligation('vos_recipe_orchestration', 'plan:verification-obligation-synthesis:recipe_orchestration', 'integration_smoke', 'required')."));
    assert(facts.includes("verification_obligation('vos_migration_parity', 'plan:verification-obligation-synthesis:migration_parity', 'migration_smoke', 'required')."));
    assert(!facts.includes("verification_mode('api_probe')."));
    assert(!facts.includes("verification_mode('integration')."));
    assert(!facts.includes("verification_mode('migration_simulation')."));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

check("rule-engine diagnostics report invalid verification result tokens through shared truth", () => {
  const fixture = makeRuntimeFixture("rule-diagnostics-partial", "PARTIAL PASS");
  try {
    let output = "";
    try {
      output = execFileSync(NODE, [ruleEngineScript, "check-transition", "validate-to-close", "--json"], {
        cwd: fixture.root,
        encoding: "utf-8",
      });
    } catch (error) {
      output = error.stdout || "";
    }
    const parsed = JSON.parse(output);
    const diagnostics = parsed.diagnostics?.verification_not_passing;
    assert.equal(diagnostics?.js_truth?.all_verification_pass, false);
    assert(
      diagnostics?.js_truth?.warnings?.some((warning) => warning.includes("PARTIAL PASS")),
      "diagnostics name the invalid PARTIAL PASS token",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

check("strategy synchronization creates one canonical criterion obligation with a safe alias", () => {
  const synced = syncLedgerFromStrategy({
    strategy: {
      verification_strategy: {
        criteria: [
          {
            id: "CRIT-001",
            criterion: "Recipe migration parity remains covered.",
            story_id: "US-015",
            required_proof_type: "proof:orchestration_smoke plus proof:migration_parity",
          },
        ],
      },
    },
    successCriteria: [
      { id: "sc_1", label: "Recipe migration parity remains covered." },
    ],
    existingLedger: {
      present: true,
      subjects: [{ id: "crit:sc_1", kind: "criterion", story_refs: ["US-LEGACY"] }],
      obligations: [{
        id: "vo_legacy_alias",
        subject: "crit:sc_1",
        mode: "integration_smoke",
        severity: "optional",
      }],
    },
  });

  const obligationKeys = synced.obligations.map((entry) => `${entry.subject}:${entry.mode}`).sort();
  assert(obligationKeys.includes("crit:CRIT-001:integration_smoke"));
  assert(obligationKeys.includes("crit:CRIT-001:migration_smoke"));
  assert(!obligationKeys.includes("crit:sc_1:integration_smoke"));
  assert(!obligationKeys.includes("crit:sc_1:migration_smoke"));
  const subject = synced.subjects.find((entry) => entry.id === "crit:CRIT-001");
  assert.deepEqual(subject.aliases, ["crit:sc_1"]);
  assert.deepEqual(subject.criterion_refs.sort(), ["CRIT-001", "sc_1"]);
  assert(subject.story_refs.includes("US-LEGACY"));
  assert.equal(
    synced.obligations.find((entry) => entry.subject === "crit:CRIT-001" && entry.mode === "integration_smoke").severity,
    "required",
  );
});

check("production truth parses plan aliases and preserves exact evidence modes", () => {
  const strategy = {
    criteria: [
      {
        id: "CRIT-001",
        criterion: "Equivalent verification aliases share one proof subject.",
        required_proof_type: "proof:integration_smoke",
      },
    ],
  };
  const planContent = `# Plan

## Success Criteria
1. Equivalent verification aliases share one proof subject.
`;
  const makeLedger = (mode) => ({
    present: true,
    subjects: [{ id: "crit:sc_1", kind: "criterion" }],
    evidence: [{
      id: `ev_${mode}`,
      subject: "crit:sc_1",
      mode,
      status: "PASS",
      command: "node fixture-test.mjs",
    }],
  });

  const matching = deriveVerificationTruth({
    planContent,
    strategy,
    existingLedger: makeLedger("integration_smoke"),
  });
  assert.equal(matching.allVerificationPass, true);
  assert.equal(matching.requiredObligations.length, 1);
  assert.equal(matching.requiredObligations[0].subject, "crit:CRIT-001");

  const wrongMode = deriveVerificationTruth({
    planContent,
    strategy,
    existingLedger: makeLedger("unit_test"),
  });
  assert.equal(wrongMode.allVerificationPass, false);
  assert.equal(wrongMode.unsatisfiedObligations.length, 1);
});

check("overlapping criterion prose does not create a verification alias", () => {
  const synced = syncLedgerFromStrategy({
    strategy: {
      criteria: [{
        id: "CRIT-001",
        criterion: "Preserve exact verification aliases.",
        required_proof_type: "proof:unit_test",
      }],
    },
    successCriteria: [{
      id: "sc_1",
      label: "Preserve exact verification aliases and accept approximate prose.",
    }],
  });
  const subject = synced.subjects.find((entry) => entry.id === "crit:CRIT-001");
  assert.deepEqual(subject.aliases, []);
});

check("ambiguous duplicate strategy prose does not claim one plan alias", () => {
  const synced = syncLedgerFromStrategy({
    strategy: {
      criteria: [
        {
          id: "CRIT-001",
          criterion: "Equivalent verification aliases share one proof subject.",
          required_proof_type: "proof:unit_test",
        },
        {
          id: "CRIT-002",
          criterion: "Equivalent verification aliases share one proof subject.",
          required_proof_type: "proof:integration_smoke",
        },
      ],
    },
    successCriteria: [{
      id: "sc_1",
      label: "Equivalent verification aliases share one proof subject.",
    }],
  });
  assert(synced.subjects.every((subject) => !subject.aliases.includes("crit:sc_1")));
});

check("ontology serializer consumes canonical strategy aliases before emitting Prolog facts", () => {
  const { root, planDir } = makePlanDir("serializer-strategy-alias");
  try {
    const planContent = `# Plan

## Success Criteria
1. Equivalent verification aliases share one proof subject.
`;
    writeFileSync(join(planDir, "plan.md"), planContent);
    writeJson(join(planDir, "verification_strategy.yaml"), {
      verification_strategy: {
        criteria: [{
          id: "CRIT-001",
          criterion: "Equivalent verification aliases share one proof subject.",
          required_proof_type: "proof:integration_smoke",
        }],
      },
    });
    const ledgerPath = join(planDir, "verification_ledger.json");
    writeJson(ledgerPath, {
      version: 1,
      subjects: [{ id: "crit:sc_1", kind: "criterion" }],
      evidence: [{
        id: "ev_alias",
        subject: "crit:sc_1",
        mode: "integration_smoke",
        status: "PASS",
        command: "node fixture-test.mjs",
      }],
    });

    const facts = serializeToFacts({
      cwd: root,
      planDir,
      planContent,
      storyRegistry: null,
      annotations: [],
    }).facts;
    assert(facts.includes("verification_subject_alias('crit:sc_1', 'crit:CRIT-001')."));
    assert.equal((facts.match(/verification_obligation\([^\n]*'crit:CRIT-001', 'integration_smoke'/g) || []).length, 1);
    assert(facts.includes("verification_evidence('ev_alias', 'crit:CRIT-001', 'integration_smoke', 'pass')."));

    const matchingSession = createSession();
    consultVerificationStatusTruth(matchingSession);
    matchingSession.consultFile(join(skillDir, "prolog", "invariants.pl"));
    matchingSession.consult(facts);
    assert(matchingSession.check("subject_has_passing_evidence('crit:CRIT-001', 'integration_smoke')"));

    const wrongModeLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    wrongModeLedger.evidence[0].mode = "unit_test";
    writeJson(ledgerPath, wrongModeLedger);
    const wrongModeFacts = serializeToFacts({
      cwd: root,
      planDir,
      planContent,
      storyRegistry: null,
      annotations: [],
    }).facts;
    const wrongModeSession = createSession();
    consultVerificationStatusTruth(wrongModeSession);
    wrongModeSession.consultFile(join(skillDir, "prolog", "invariants.pl"));
    wrongModeSession.consult(wrongModeFacts);
    assert(!wrongModeSession.check("subject_has_passing_evidence('crit:CRIT-001', 'integration_smoke')"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("migration-managed planner paths are distinct from ordinary app code", () => {
  const strategy = {
    criteria: [
      { id: "CRIT-001", required_proof_type: "proof:migration_parity" },
    ],
  };
  assert.equal(
    classifyPlannedEvidencePath(".agent/skills/iterative-planner/scripts/foo.mjs", { strategy }).kind,
    "migration_managed",
  );
  assert.equal(
    classifyPlannedEvidencePath("src/app.js", { strategy }).kind,
    "code",
  );
});

check("verification ledger reader normalizes declared mode entry shapes and fails closed on malformed JSON", () => {
  const { root, planDir } = makePlanDir("declared-mode-shapes");
  const ledgerPath = join(planDir, "verification_ledger.json");
  try {
    writeFileSync(ledgerPath, "{ malformed json\n");
    assert.equal(readVerificationLedger(planDir), null);
    rmSync(ledgerPath);
    mkdirSync(ledgerPath);
    assert.equal(readVerificationLedger(planDir), null);
    rmSync(ledgerPath, { recursive: true, force: true });
    writeFileSync(ledgerPath, "x".repeat(1_048_577));
    assert.equal(readVerificationLedger(planDir), null);
    writeJson(ledgerPath, 7);
    assert.equal(readVerificationLedger(planDir), null);
    writeJson(ledgerPath, {
      version: 1,
      supported_modes: [
        "unit_test",
        { mode: "migration_smoke", declared_by: "fixture" },
        { id: "integration_smoke", source_id: "fixture-source" },
        null,
      ],
      entries: [
        { kind: "subject", id: "crit:sc_1" },
        { kind: "obligation", id: "vo_1", subject: "crit:sc_1", mode: "unit_test", severity: "required" },
        { subject: "crit:sc_1", mode: "unit_test", status: "PASS", command: "node fixture.mjs" },
      ],
    });
    const ledger = readVerificationLedger(planDir);
    assert.deepEqual(ledger.declaredModes.map((entry) => entry.mode), ["unit_test", "migration_smoke", "integration_smoke"]);
    assert.equal(ledger.evidence.length, 1);
    assert.equal(ledger.evidence[0].status_satisfies, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("ontology serializer preserves traceability without inventing plan-scoped proof when no plan directory exists", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-ontology-no-plan-"));
  const planContent = `# Plan

## Goal
Preserve traceability without a materialized plan directory.

## Success Criteria
- [ ] SC-1: Emit only supplied traceability facts.
`;
  try {
    const emptyFacts = serializeToFacts({
      cwd: root,
      planDir: null,
      planContent,
      storyRegistry: null,
      annotations: null,
    }).facts;
    assert(emptyFacts.includes("business_goal('primary_goal'"));
    assert(!emptyFacts.includes("verification_result_status("));

    const tracedFacts = serializeToFacts({
      cwd: root,
      planDir: null,
      planContent,
      storyRegistry: {
        stories: [
          { id: "US-TRACE-1", validation_refs: ["tests/traceability.mjs"] },
          { id: "US-TRACE-2" },
        ],
      },
      annotations: [
        { key: "proves", value: "crit:SC-1", file: "src/traceability.mjs" },
        { key: "story", value: "US-TRACE-1", file: "src/traceability.mjs" },
        { key: "validation_module", value: "tests/traceability.mjs", file: "tests/traceability.mjs" },
      ],
    }).facts;
    assert(tracedFacts.includes("validation_ref('US-TRACE-1', 'tests/traceability.mjs')."));
    assert(tracedFacts.includes("annotation_proves_criterion('src/traceability.mjs', 'SC-1')."));
    assert(tracedFacts.includes("annotation_story_link('src/traceability.mjs', 'US-TRACE-1')."));
    assert(tracedFacts.includes("validation_module_declared('tests/traceability.mjs')."));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("ontology serializer normalizes declared verification mode shapes and rejects malformed declarations", () => {
  const { root, planDir } = makePlanDir("serializer-declared-modes");
  const planContent = "# Plan\n\n## Goal\nSerialize governed verification mode declarations.\n";
  try {
    writeFileSync(join(planDir, "plan.md"), planContent);
    writeJson(join(planDir, "verification_ledger.json"), {
      version: 1,
      declared_modes: [
        "unit_test",
        " ",
        null,
        7,
        { id: "integration_smoke", source_id: "fixture-source" },
        { name: "security_review" },
        {},
      ],
      subjects: [],
      obligations: [],
      evidence: [],
      waivers: [],
    });
    const facts = serializeToFacts({
      cwd: root,
      planDir,
      planContent,
      storyRegistry: null,
      annotations: [],
    }).facts;
    assert(facts.includes("verification_mode_declared_by('unit_test', 'verification_ledger')."));
    assert(facts.includes("verification_mode_declared_by('integration_smoke', 'fixture-source')."));
    assert(facts.includes("verification_mode_declared_by('security_review', 'verification_ledger')."));
    assert(!facts.includes("verification_mode_declared_by('',"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("ontology serializer fails closed on unreadable and oversized plan proof artifacts", () => {
  const { root, planDir } = makePlanDir("serializer-artifact-guards");
  const planContent = "# Plan\n\n## Goal\nReject unreadable proof artifacts.\n";
  try {
    writeFileSync(join(planDir, "plan.md"), planContent);
    mkdirSync(join(planDir, "verification.md"));
    writeFileSync(join(planDir, "reflection.md"), "x".repeat(1_048_577));
    writeJson(join(planDir, "state.json"), 7);
    writeFileSync(join(planDir, "verification_ledger.json"), "{ malformed json\n");

    const invalidRunnerDir = join(root, "recipes", "invalid-array-runner");
    const emptyCommandDir = join(root, "recipes", "empty-command-runner");
    mkdirSync(invalidRunnerDir, { recursive: true });
    mkdirSync(emptyCommandDir, { recursive: true });
    writeJson(join(invalidRunnerDir, "recipe.json"), {
      id: "invalid-array-runner",
      runner: [],
    });
    writeJson(join(emptyCommandDir, "recipe.json"), {
      id: "empty-command-runner",
      runner: { type: "node", command: [] },
    });

    const facts = serializeToFacts({
      cwd: root,
      planDir,
      planContent,
      storyRegistry: null,
      annotations: [],
    }).facts;
    assert(!facts.includes("verification_result_status("));
    assert(!facts.includes("verification_mode_declared_by("));
    assert(!facts.includes("recipe_runner_type('invalid-array-runner'"));
    assert(!facts.includes("recipe_runner_type('empty-command-runner'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`test_verification_truth passed: ${passed} assertions`);
if (failed > 0) process.exit(1);
