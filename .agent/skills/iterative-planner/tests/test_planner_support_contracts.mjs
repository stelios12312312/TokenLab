#!/usr/bin/env node
// test_planner_support_contracts.mjs
// Focused coverage for remaining planner support surfaces that are not well
// exercised by the gate journey tests.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { createHash } from "crypto";

import { detectIDE, getTraceMethod, formatIDEWarning } from "../scripts/lib/ide_detect.mjs";
import { computeLearnedObligationsSignal, loadLearnedObligationsRegistry } from "../scripts/lib/learned_obligations.mjs";
import { computeMistakeRegistrySignal, loadMistakeRegistry } from "../scripts/lib/mistake_registry.mjs";
import { refreshPlanArtifacts } from "../scripts/lib/plan_refresh.mjs";
import { extractFilesToModify } from "../scripts/lib/plan_utils.mjs";
import { createSession } from "../scripts/lib/prolog.mjs";
import { summarizeProofTelemetry } from "../scripts/lib/proof_telemetry.mjs";
import { createSemanticEngine } from "../scripts/lib/semantic_engine.mjs";
import { loadRules, loadStateFacts, loadStoryFacts } from "../scripts/lib/fact_loader.mjs";
import { sanitizeAtom, sanitizeStrictId, sanitizeEnumAtom, formatReason } from "../scripts/lib/sanitize.mjs";
import { computeVerificationObligationSynthesis } from "../scripts/lib/verification_obligations.mjs";
import { auditTrace } from "../scripts/trace_auditor.mjs";
import {
  createInitialStateJson,
  readStateJson,
  validateStateIntegrity,
  validateStateJson,
  writeStateJson,
} from "../scripts/lib/determinism.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");
const plannerSkillPath = join(plannerRoot, ".agent", "skills", "iterative-planner");
const NODE = process.execPath;
const ruleEnginePath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/rule_engine.mjs");
const ontologySerializerPath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/ontology_serializer.mjs");
const projectHealthPath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/project_health.mjs");
const hookPath = join(plannerRoot, ".agent/skills/iterative-planner/scripts/hooks/post_tool_use.mjs");
const schemaPath = join(plannerRoot, ".agent/skills/iterative-planner/config/state.schema.json");
const checklistDir = join(plannerRoot, ".agent/skills/iterative-planner/checklists");
const checklistIntegrityPath = join(plannerRoot, ".agent/skills/iterative-planner/config/.checklist_integrity");
const learnedObligationsRegistryPath = join(plannerRoot, ".agent/skills/iterative-planner/config/learned_obligations.json");

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

function runNode(args, cwd, input) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(NODE, args, {
        cwd,
        input,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
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

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function scenarioRuleEngineSemantics() {
  const result = runNode([ruleEnginePath, "--self-test", "--json"], plannerRoot);
  assert(result.ok, "rule_engine self-test exits cleanly");

  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
  assert(!!parsed, "rule_engine self-test emits valid JSON");

  const byName = new Map((parsed?.results || []).map((entry) => [entry.name, entry.status]));
  assert(byName.get("Suggestions generated") === "PASS", "rule_engine self-test covers suggestion generation");
  assert(byName.get("Completeness score computed") === "PASS", "rule_engine self-test covers completeness scoring");
  assert(byName.get("Repo mode detected (solo)") === "PASS", "rule_engine self-test covers solo repo mode");
  assert(byName.get("Repo mode: collaborative") === "PASS", "rule_engine self-test covers collaborative repo mode");
}

function scenarioIDEDetection() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-ide-"));
  try {
    withEnv({
      CLAUDE_CODE_VERSION: "1.0.0",
      CURSOR_SESSION_ID: undefined,
      ANTIGRAVITY_IDE: undefined,
      VSCODE_PID: undefined,
      TERM_PROGRAM: undefined,
      CODEX_THREAD_ID: undefined,
      CODEX_SANDBOX: undefined,
    }, () => {
      const ide = detectIDE(tmp);
      assert(ide.ide === "claude-code", "detectIDE recognizes Claude Code");
      assert(getTraceMethod(tmp) === "post_tool_use_hook", "getTraceMethod returns the Claude/Cursor hook mode");
    });

    const agRoot = join(tmp, "antigravity");
    mkdirSync(join(agRoot, ".antigravity"), { recursive: true });
    withEnv({
      CLAUDE_CODE_VERSION: undefined,
      CURSOR_SESSION_ID: undefined,
      ANTIGRAVITY_IDE: undefined,
      VSCODE_PID: undefined,
      TERM_PROGRAM: undefined,
      CODEX_THREAD_ID: undefined,
      CODEX_SANDBOX: undefined,
    }, () => {
      const ide = detectIDE(agRoot);
      assert(ide.ide === "antigravity", "detectIDE recognizes Antigravity via filesystem marker");
      assert(ide.trace_method === "antigravity_trace", "Antigravity uses the Antigravity trace method");
    });

    withEnv({
      CLAUDE_CODE_VERSION: undefined,
      CURSOR_SESSION_ID: undefined,
      ANTIGRAVITY_IDE: undefined,
      VSCODE_PID: "4242",
      TERM_PROGRAM: "vscode",
      CODEX_THREAD_ID: "thread-fixture",
      CODEX_SANDBOX: "seatbelt",
    }, () => {
      const ide = detectIDE(tmp);
      assert(ide.ide === "codex", "detectIDE recognizes Codex before the generic VS Code fallback");
      assert(ide.trace_audit_mode === "not_applicable", "Codex marks external trace audit as not applicable");
      assert(getTraceMethod(tmp) === null, "Codex does not advertise Claude/Cursor trace hooks");
      assert(formatIDEWarning(ide) === "", "Codex detection stays quiet instead of emitting unsupported-IDE warnings");
    });

    withEnv({
      CLAUDE_CODE_VERSION: undefined,
      CURSOR_SESSION_ID: undefined,
      ANTIGRAVITY_IDE: undefined,
      VSCODE_PID: undefined,
      TERM_PROGRAM: undefined,
      CODEX_THREAD_ID: undefined,
      CODEX_SANDBOX: undefined,
    }, () => {
      const ide = detectIDE(tmp);
      assert(ide.ide === "unknown", "detectIDE returns unknown when no IDE signals exist");
      assert(formatIDEWarning(ide).includes("Unknown IDE environment"), "formatIDEWarning preserves unsupported-IDE guidance");
    });
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSanitizeContracts() {
  const atom = sanitizeAtom("bad:-value\u0000 <script>");
  assert(atom.startsWith("'") && atom.endsWith("'"), "sanitizeAtom always returns a quoted Prolog atom");
  assert(!atom.includes(":-"), "sanitizeAtom strips clause-injection syntax");
  assert(!atom.includes("<script>"), "sanitizeAtom removes unsupported free-text characters");

  const strictId = sanitizeStrictId("../bad path();");
  assert(!strictId.includes(" "), "sanitizeStrictId strips whitespace from structured identifiers");
  assert(!strictId.includes("(") && !strictId.includes(")"), "sanitizeStrictId strips unsafe identifier punctuation");

  assert(sanitizeEnumAtom("Re-Plan!") === "'re_plan'", "sanitizeEnumAtom normalizes enums to lower snake_case");
  assert(formatReason({ functor: "missing_guard", args: ["explore", "plan"] }) === "missing_guard(explore, plan)", "formatReason renders structured Prolog terms");
}

function scenarioStateValidationContracts() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-state-"));
  try {
    const planName = "plan_2026-04-03_abcd1234";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n\n## P-001\nBaseline pattern\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");

    const initial = createInitialStateJson(planName, "Support contract state fixture", { projectRoot: tmp });
    assert(validateStateJson(initial).valid, "validateStateJson accepts a valid initial state");
    assert(typeof initial.knowledge_snapshot?.hash === "string", "createInitialStateJson records a knowledge snapshot when projectRoot is provided");

    writeStateJson(planDir, initial);
    const reloaded = readStateJson(planDir);
    assert(!!reloaded, "readStateJson reloads the written state.json");
    assert(validateStateIntegrity(reloaded).intact, "validateStateIntegrity accepts the freshly written state");

    const tampered = { ...reloaded, goal: "tampered after write" };
    assert(!validateStateIntegrity(tampered).intact, "validateStateIntegrity detects post-write tampering");

    const invalid = { ...reloaded, state: "BROKEN" };
    assert(!validateStateJson(invalid).valid, "validateStateJson rejects invalid state enums");

    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    assert(schema.required.includes("state") && schema.required.includes("plan_dir"), "state.schema.json preserves required canonical fields");
    assert(schema.properties?.state?.enum?.includes("RE_PLAN"), "state.schema.json preserves RE_PLAN in the enum contract");
    assert(schema.additionalProperties === false, "state.schema.json rejects unexpected extra properties");
    assert(!!schema.properties?.knowledge_snapshot, "state.schema.json documents knowledge snapshots");
    assert(!!schema.properties?.close_signals, "state.schema.json documents structured close signals");
    assert(!!schema.properties?.close_signals?.properties?.anti_recurrence, "state.schema.json documents structured anti-recurrence close signals");
    assert(!!schema.properties?.close_signals?.properties?.mistake_registry, "state.schema.json documents structured mistake-registry signals");
    assert(!!schema.properties?.close_signals?.properties?.mistake_registry?.properties?.registry_usable, "state.schema.json documents mistake-registry usability");
    assert(!!schema.properties?.close_signals?.properties?.learned_obligations, "state.schema.json documents structured learned-obligations close signals");
    assert(!!schema.properties?.close_signals?.properties?.learned_obligations?.properties?.source_mistake_registry_usable, "state.schema.json documents source mistake-registry usability");
    assert(!!schema.properties?.close_signals?.properties?.learned_obligations?.properties?.degraded_source_registry, "state.schema.json documents degraded learned-obligation source-registry state");
    assert(!!schema.properties?.close_signals?.properties?.learned_obligations?.properties?.degraded_source_registry_ids, "state.schema.json documents degraded learned-obligation ids");
    assert(!!schema.properties?.close_signals?.properties?.learned_obligations?.properties?.active_obligations?.items?.properties?.source_registry_degraded, "state.schema.json documents per-obligation degraded source-registry state");
    assert(!!schema.properties?.close_signals?.properties?.verification_obligation_synthesis, "state.schema.json documents structured verification-obligation synthesis close signals");
    assert(!!schema.properties?.close_signals?.properties?.verification_obligation_synthesis?.properties?.required_reporting_sections, "state.schema.json documents required closeout reporting sections for synthesized verification obligations");
    assert(!!schema.properties?.close_signals?.properties?.semantic_substrate, "state.schema.json documents structured semantic-substrate close signals");
    assert(!!schema.properties?.close_signals?.properties?.semantic_substrate?.properties?.blocking_gap_ids, "state.schema.json documents semantic-substrate blocking gap ids");
    assert(!!schema.properties?.close_signals?.properties?.semantic_substrate?.properties?.sources_present?.properties?.persona_artifacts, "state.schema.json documents semantic-substrate source provenance");
    assert(!!schema.properties?.close_signals?.properties?.quant_results_validation, "state.schema.json documents quant-results validation close signals");
    assert(!!schema.properties?.close_signals?.properties?.quant_results_validation?.properties?.blocking_issues, "state.schema.json documents quant-results blocking issues");
    assert(!!schema.properties?.close_signals?.properties?.intent_evidence, "state.schema.json documents structured intent-evidence close signals");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioStoryValidationRefsLoadIntoRuntimeFacts() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-story-facts-"));
  try {
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-055",
          title: "M-Model Operator Strategy Report",
          priority: "HIGH",
          status: "FULLY_COVERED",
          code_refs: ["src/report.py"],
          test_refs: ["tests/test_report.py"],
          validation_refs: ["reports/mmodel/strategy_report.html"],
          postconditions: ["quant_advisor_narrative_required"],
        },
      ],
    }, null, 2));

    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: plannerSkillPath });
    loadStoryFacts(session, { cwd: tmp });

    assert(session.check("validation_ref('US-055', 'reports/mmodel/strategy_report.html')"), "loadStoryFacts emits validation_ref facts from story_registry validation_refs");
    assert(!session.check("invariant_violated(quant_advisor_narrative_without_validation, 'US-055')"), "quant advisor validation invariant stays clear when validation_refs exist");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioChecklistIntegrityBaselineStaysSynced() {
  const stored = JSON.parse(readFileSync(checklistIntegrityPath, "utf-8"));
  const checklistFiles = readdirSync(checklistDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();

  assert(checklistFiles.length > 0, "planner has checklist files to integrity-check");

  for (const file of checklistFiles) {
    const checklistName = file.replace(/\.ya?ml$/, "");
    const content = readFileSync(join(checklistDir, file), "utf-8");
    const actual = createHash("sha256").update(content).digest("hex").slice(0, 32);
    assert(typeof stored[checklistName] === "string", `.checklist_integrity includes ${checklistName}`);
    assert(stored[checklistName] === actual, `.checklist_integrity hash matches ${checklistName}`);
  }
}

function scenarioVerificationObligationSynthesisContracts() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-vos-"));
  try {
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    const planDir = join(tmp, "plans", "plan_2026-04-09_vos");
    mkdirSync(planDir, { recursive: true });

    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      stories: [
        {
          id: "US-901",
          title: "Recipe migration proof",
          tags: ["recipes", "migration"],
          code_refs: ["recipes/customer-sync/recipe.json"],
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Harden recipe migration verification proof

## Files To Modify
- recipes/customer-sync/recipe.json
- scripts/migrate_recipe_contract.mjs

## Verification Strategy
| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |
|---|---|---|---|---|---|---|
| Recipe migration proof is explicit. | US-901 | Recipe runner and migration surface | Dry-run plus migration smoke | Run smoke fixture | PASS | Live rollout remains unverified |
`);
    writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
      version: 1,
      phase: "PLAN",
      items: [
        { pack_id: "config_integrity", guidance: "Protect migration compatibility." },
        { pack_id: "traceability", guidance: "Keep workflow proof explicit." },
      ],
    }, null, 2));

    const synthesis = computeVerificationObligationSynthesis({
      cwd: tmp,
      planDir,
      stateJson: { goal: "Harden recipe migration verification proof" },
      planContent: readFileSync(join(planDir, "plan.md"), "utf-8"),
    });

    assert(synthesis.required === true, "verification-obligation synthesis activates for recipe/migration work");
    assert((synthesis.obligations || []).some((entry) => entry.id === "recipe_orchestration"), "verification-obligation synthesis includes recipe/orchestration obligations when recipe surfaces are touched");
    assert((synthesis.obligations || []).some((entry) => entry.id === "migration_parity"), "verification-obligation synthesis includes migration/parity obligations when migration surfaces are touched");
    assert((synthesis.source_summary?.ontology_signals || []).includes("story_tag:recipes"), "verification-obligation synthesis preserves ontology story-tag provenance");
    assert((synthesis.source_summary?.persona_signals || []).includes("pack:config_integrity"), "verification-obligation synthesis preserves persona-pack provenance");
    const migrationObligation = (synthesis.obligations || []).find((entry) => entry.id === "migration_parity");
    assert((migrationObligation?.source_provenance || []).some((entry) => entry.source === "owned_plan_scope" && entry.blocking === true), "verification-obligation synthesis marks owned-file provenance as blocking");

    const ambientPlanDir = join(tmp, "plans", "ambient-scope");
    mkdirSync(ambientPlanDir, { recursive: true });
    const ambientPlan = `# Plan

## Goal
Tidy release notes

## Files To Modify
- docs/release-notes.md

## Verification Strategy
N/A
`;
    writeFileSync(join(ambientPlanDir, "plan.md"), ambientPlan);
    writeFileSync(join(ambientPlanDir, "scope.json"), JSON.stringify({
      version: 1,
      declared_files: ["docs/release-notes.md"],
      owned_files: ["docs/release-notes.md"],
      observed_dirty_files_at_start: ["docs/release-notes.md", "scripts/migrate_ambient.mjs"],
      ambient_dirty_files: ["scripts/migrate_ambient.mjs"],
      summary: {
        declared_count: 1,
        observed_dirty_count: 2,
        overlap_count: 1,
        ambient_count: 1,
        large_ambient_dirty: false,
      },
    }, null, 2));
    const ambientSynthesis = computeVerificationObligationSynthesis({
      cwd: tmp,
      planDir: ambientPlanDir,
      stateJson: {
        goal: "Tidy release notes",
        change_manifest: ["scripts/migrate_ambient.mjs"],
      },
      planContent: ambientPlan,
      storyRegistry: null,
    });
    const ambientMigration = (ambientSynthesis.obligations || []).find((entry) => entry.id === "migration_parity");
    assert(ambientSynthesis.required === false, "verification-obligation synthesis does not make ambient-only obligations blocking");
    assert(!ambientMigration, "verification-obligation synthesis quarantines ambient-only migration files outside owned scope");

    const incidentalPlan = `# Plan

## Goal
Transition gate flow smoke

## Problem Statement
Need end-to-end transition coverage for approval nonce and KB digest paths.

## Files To Modify
- To be determined after EXPLORE

## Steps
1. Build a temp planner project with a local .agent symlink.
2. Run explore-to-plan in fast-track mode to exercise signed state updates.
3. Verify plan-to-execute gate behavior and nonce consumption.
`;
    const incidentalSynthesis = computeVerificationObligationSynthesis({
      cwd: tmp,
      planDir: null,
      stateJson: { goal: "Transition gate flow smoke" },
      planContent: incidentalPlan,
      storyRegistry: null,
    });

    assert(incidentalSynthesis.required === false, "verification-obligation synthesis ignores incidental plan wording without repo-context signals");
    assert((incidentalSynthesis.obligations || []).length === 0, "verification-obligation synthesis ignores template file placeholders and short-keyword false positives");

    const plannerHelperPlan = `# Plan

## Goal
Tighten planner findings and file-scope parsing

## Files To Modify
- .agent/skills/iterative-planner/scripts/lib/plan_utils.mjs
- .agent/skills/iterative-planner/scripts/planner_findings.mjs
`;
    const plannerHelperSynthesis = computeVerificationObligationSynthesis({
      cwd: tmp,
      planDir: null,
      stateJson: { goal: "Tighten planner findings and file-scope parsing" },
      planContent: plannerHelperPlan,
      storyRegistry: null,
    });
    assert(!(plannerHelperSynthesis.obligations || []).some((entry) => entry.id === "cms_missing_content_diagnosis"), "generic planner helper ownership does not activate CMS missing-content obligations");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioFilesToModifyAcceptsCommonNonCanonicalEntries() {
  const planContent = `# Plan

## Files To Modify
- \`src/atp_algo/models/point_trueskill.py\` - new model implementation
- tests/test_point_trueskill.py (new)
### [NEW] src/atp_algo/pipelines/point_pipeline.py
### [MODIFY] \`docs/DATA_FORMAT.md\`
- To be determined after EXPLORE
- This is descriptive prose, not a path
`;

  const files = extractFilesToModify(planContent);
  assert(files.includes("src/atp_algo/models/point_trueskill.py"), "Files To Modify extracts code-span bullets with descriptions");
  assert(files.includes("tests/test_point_trueskill.py"), "Files To Modify extracts path bullets with parenthetical status");
  assert(files.includes("src/atp_algo/pipelines/point_pipeline.py"), "Files To Modify extracts ATP-style status headings");
  assert(files.includes("docs/DATA_FORMAT.md"), "Files To Modify extracts code-span headings");
  assert(!files.some((filePath) => filePath.includes("descriptive prose")), "Files To Modify ignores prose lines");
  assert(!files.some((filePath) => filePath.toLowerCase().includes("to be determined")), "Files To Modify ignores placeholders");
}

function scenarioProjectPolicyFactsStayDeclarative() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-policy-"));
  try {
    mkdirSync(join(tmp, "prolog"), { recursive: true });
    writeFileSync(join(tmp, "prolog", "project.pl"), `%% Safe planner policy facts
privileged_state(execute).
auth_gate(plan, execute).
can_transition(explore, close).
`);

    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: plannerSkillPath });

    assert(session.check("privileged_state(execute)"), "loadRules accepts safe privileged_state policy facts from project.pl");
    assert(session.check("auth_gate(plan, execute)"), "loadRules accepts safe auth_gate policy facts from project.pl");
    assert(!session.check("can_transition(explore, close)"), "loadRules still blocks reserved transition predicates from project.pl");
    assert(!session.check("invariant_warning(no_security_policies_defined, Detail)"), "safe project policy facts satisfy the no_security_policies_defined advisory");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAuditPerspectiveDiversityUsesAuditSet() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-perspectives-"));
  try {
    const single = createSession();
    loadRules(single, { cwd: tmp, skillPath: plannerSkillPath });
    single.consult("audit_perspective(audit_one, security).");
    const singleWarnings = single.queryAll("invariant_warning(audit_lacks_perspective_diversity, Detail)");
    assert(singleWarnings.length === 1, "single-perspective audit sets emit one diversity warning for the whole suite");

    const multi = createSession();
    loadRules(multi, { cwd: tmp, skillPath: plannerSkillPath });
    multi.consult("audit_perspective(audit_one, security).");
    multi.consult("audit_perspective(audit_two, performance).");
    const multiWarnings = multi.queryAll("invariant_warning(audit_lacks_perspective_diversity, Detail)");
    assert(multiWarnings.length === 0, "multi-perspective audit sets do not emit duplicate diversity warnings");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioAntiRecurrenceInvariantEscalatesByPhase() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-anti-recurrence-"));
  try {
    const planName = "plan_2026-04-07_guardphase";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Retro remediation for recurring planner bug
`);

    const executeState = createInitialStateJson(planName, "Anti-recurrence warning fixture");
    executeState.state = "EXECUTE";
    executeState.close_signals = {
      anti_recurrence: {
        required: true,
        satisfied: false,
        status: "missing",
      },
    };
    writeStateJson(planDir, executeState);

    const executeSession = createSession();
    loadRules(executeSession, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(executeSession, { cwd: tmp, skillPath: plannerSkillPath });
    assert(executeSession.check("anti_recurrence_required(true)"), "loadRules exposes the anti_recurrence_required fact from state.json");
    assert(executeSession.check("invariant_warning(anti_recurrence_guard_missing, plan)"), "missing anti-recurrence proof is a warning before evidence phases");
    assert(!executeSession.check("invariant_violated(anti_recurrence_guard_missing, plan)"), "missing anti-recurrence proof does not hard-fail before VALIDATE");

    const validateState = createInitialStateJson(planName, "Anti-recurrence violation fixture");
    validateState.state = "VALIDATE";
    validateState.close_signals = {
      anti_recurrence: {
        required: true,
        satisfied: false,
        status: "missing",
      },
    };
    writeStateJson(planDir, validateState);

    const validateSession = createSession();
    loadRules(validateSession, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(validateSession, { cwd: tmp, skillPath: plannerSkillPath });
    assert(validateSession.check("invariant_violated(anti_recurrence_guard_missing, plan)"), "missing anti-recurrence proof hard-fails once the plan reaches VALIDATE");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSemanticSubstrateCloseSignalPersistsAndLoadsIntoProlog() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-semantic-substrate-"));
  try {
    const planName = "plan_2026-04-09_semantic_substrate";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(join(tmp, "src", "config"), { recursive: true });
    mkdirSync(join(tmp, "fixtures", "examples"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(tmp, "src", "config", "runtime.ts"), "export const runtimeMode = process.env.LLM_MODE;\n");
    writeFileSync(join(tmp, "fixtures", "examples", "runtime_fixture.ts"), `// @planner:config_flag = llm_mode_mock
// @planner:mutually_exclusive = provider_openai
export const runtimeFixture = "fixture";
`);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Keep mock mode and provider selection aligned

## Problem Statement
Config flag changes should declare contradictory runtime modes explicitly.

## Files To Modify
- src/config/runtime.ts

## Steps
1. Update LLM_MODE and provider selection behavior.
`);
    writeFileSync(join(planDir, "verification.md"), "# Verification\n\n## Notes\nFixture only.\n");

    const state = createInitialStateJson(planName, "Keep mock mode and provider selection aligned", { projectRoot: tmp });
    state.state = "REFLECT";
    writeStateJson(planDir, state);

    const refresh = refreshPlanArtifacts({
      cwd: tmp,
      skillPath: plannerSkillPath,
      planDirName: planName,
      refreshOntology: true,
      persistOntology: true,
      persistState: true,
      syncFindings: false,
    });

    assert(refresh.refreshed === true, "refreshPlanArtifacts refreshes close signals for semantic-substrate fixtures");

    const reloaded = readStateJson(planDir);
    const semanticSubstrate = reloaded?.close_signals?.semantic_substrate || null;
    assert(semanticSubstrate?.required === true, "refreshPlanArtifacts persists semantic-substrate required=true for config-flag plans");
    assert(semanticSubstrate?.satisfied === false, "refreshPlanArtifacts persists semantic-substrate satisfied=false when relevant gaps remain");
    assert(semanticSubstrate?.status === "missing_relevant_gaps", "refreshPlanArtifacts persists the semantic-substrate missing_relevant_gaps status");
    assert(semanticSubstrate?.scan_scope === "planned_plus_nearby", "refreshPlanArtifacts persists the planned_plus_nearby semantic scan scope");
    assert(semanticSubstrate?.scan_scope_used === "planned_plus_nearby", "refreshPlanArtifacts persists the actual semantic scan scope used when scoped refresh succeeds");
    assert(semanticSubstrate?.scope_degraded === false, "refreshPlanArtifacts keeps semantic scope honest when scoped refresh succeeds");
    assert(semanticSubstrate?.relevance_evidence?.config === "strong", "refreshPlanArtifacts persists strong config relevance evidence for contradictory-config work");
    assert((semanticSubstrate?.blocking_gap_ids || []).includes("missing_mutually_exclusive_facts"), "refreshPlanArtifacts persists blocking semantic-substrate gap ids");
    assert(semanticSubstrate?.sources_present?.annotations === false, "refreshPlanArtifacts keeps unrelated fixture annotations out of scoped semantic-substrate provenance");

    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(session, { cwd: tmp, skillPath: plannerSkillPath });
    assert(session.check("semantic_substrate_required(true)"), "loadStateFacts emits semantic_substrate_required(true) from close signals");
    assert(session.check("semantic_substrate_satisfied(false)"), "loadStateFacts emits semantic_substrate_satisfied(false) from close signals");
    assert(session.check("semantic_substrate_scope_degraded(false)"), "loadStateFacts emits semantic_substrate_scope_degraded(false) when scoped refresh stays trusted");
    assert(session.check("semantic_substrate_scan_scope_used(planned_plus_nearby)"), "loadStateFacts emits the scoped semantic scan mode");
    assert(session.check("semantic_substrate_relevance(config, strong)"), "loadStateFacts emits strong config relevance facts from the semantic substrate summary");
    assert(session.check("semantic_substrate_gap(missing_mutually_exclusive_facts)"), "loadStateFacts emits semantic_substrate_gap/1 facts from advisory gap ids");
    assert(session.check("semantic_substrate_blocking_gap(missing_mutually_exclusive_facts)"), "loadStateFacts emits semantic_substrate_blocking_gap/1 facts from blocking gap ids");
    assert(session.check("missing_guard(reflect, validate, semantic_substrate_incomplete)"), "Prolog reflect-to-validate guards fail when required semantic substrate remains incomplete");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioReviewIntakeCloseSignalPersistsAndLoadsIntoProlog() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-review-intake-"));
  try {
    const planName = "plan_2026-05-19_review_intake";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(join(planDir, "review_intake_sources"), { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Review intake close-signal fixture

## Problem Statement
Required review items must block close until disposition.

## Files To Modify
- docs/review.md

## Verification Strategy
Exercise review intake.
`);
    writeFileSync(join(planDir, "verification.md"), "# Verification\n\n## Notes\nFixture only.\n");
    writeFileSync(join(planDir, "review_intake_sources", "llm_drift_gate_validate-to-close.json"), JSON.stringify({
      status: "stale_blocking",
      summary: "review item fixture",
      findings: [
        {
          id: "review_fixture",
          classification: "stale_blocking",
          surface: "advisor",
          file: "docs/review.md",
          reason: "Advisor finding must be dispositioned",
          runtime_truth_refs: ["verify_gate"],
          recommended_action: "Reject with reason or verify",
        },
      ],
    }, null, 2) + "\n");

    const state = createInitialStateJson(planName, "Review intake close-signal fixture", { projectRoot: tmp });
    state.state = "VALIDATE";
    writeStateJson(planDir, state);

    const refresh = refreshPlanArtifacts({
      cwd: tmp,
      skillPath: plannerSkillPath,
      planDirName: planName,
      refreshOntology: true,
      persistOntology: true,
      persistState: true,
      syncFindings: false,
    });
    assert(refresh.refreshed === true, "refreshPlanArtifacts refreshes close signals for review-intake fixtures");
    const reviewIntake = refresh.closeSignals?.review_intake || null;
    assert(reviewIntake?.required === true, "review intake is required for stale_blocking findings");
    assert(reviewIntake?.satisfied === false, "review intake remains unsatisfied without a valid disposition");
    assert(reviewIntake?.unresolved_required_count === 1, "review intake counts unresolved required findings");

    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(session, { cwd: tmp, skillPath: plannerSkillPath });
    assert(session.check("review_intake_required(true)"), "loadStateFacts emits review_intake_required(true)");
    assert(session.check("review_intake_satisfied(false)"), "loadStateFacts emits review_intake_satisfied(false)");
    assert(session.check("review_intake_unresolved_required_count(1)"), "loadStateFacts emits unresolved review-intake count");
    assert(session.check("missing_guard(validate, close, review_intake_unresolved)"), "Prolog close guard blocks unresolved review-intake items");
    assert(session.check("invariant_violated(review_intake_unresolved, count(1))"), "review-intake invariant hard-fails at VALIDATE");

    writeFileSync(join(planDir, "review_intake.json"), JSON.stringify({
      version: 1,
      items: [
        {
          id: "llm:stale_blocking:review_fixture",
          disposition: {
            status: "rejected",
            disposition_reason: "Fixture proves deterministic rejection reason handling.",
            evidence_refs: [],
          },
        },
      ],
    }, null, 2) + "\n");

    const satisfiedRefresh = refreshPlanArtifacts({
      cwd: tmp,
      skillPath: plannerSkillPath,
      planDirName: planName,
      refreshOntology: true,
      persistOntology: true,
      persistState: true,
      syncFindings: false,
    });
    assert(satisfiedRefresh.closeSignals?.review_intake?.satisfied === true, "valid rejected disposition satisfies required review intake");
    const satisfiedSession = createSession();
    loadRules(satisfiedSession, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(satisfiedSession, { cwd: tmp, skillPath: plannerSkillPath });
    assert(!satisfiedSession.check("missing_guard(validate, close, review_intake_unresolved)"), "Prolog close guard clears after valid disposition");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMissingPlannedFilesKeepSemanticScopeDegradedAndBlocking() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-semantic-missing-files-"));
  try {
    const planName = "plan_2026-04-09_semantic_missing_files";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(join(tmp, "fixtures", "examples"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(tmp, "fixtures", "examples", "runtime_fixture.ts"), `// @planner:config_flag = llm_mode_mock
// @planner:mutually_exclusive = provider_openai
export const runtimeFixture = "fixture";
`);
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Keep mock mode and provider selection aligned for a new runtime file

## Problem Statement
Missing planned files should not let repo-wide fallback satisfy active-plan semantic substrate.

## Files To Modify
- src/config/new_runtime.ts

## Steps
1. Add the new runtime config file.
`);
    writeFileSync(join(planDir, "verification.md"), "# Verification\n\n## Notes\nFixture only.\n");

    const state = createInitialStateJson(planName, "Keep mock mode and provider selection aligned for a new runtime file", { projectRoot: tmp });
    state.state = "REFLECT";
    writeStateJson(planDir, state);

    const refresh = refreshPlanArtifacts({
      cwd: tmp,
      skillPath: plannerSkillPath,
      planDirName: planName,
      refreshOntology: true,
      persistOntology: true,
      persistState: true,
      syncFindings: false,
    });

    assert(refresh.refreshed === true, "refreshPlanArtifacts succeeds when planned semantic-substrate files do not exist yet");

    const semanticSubstrate = refresh.closeSignals?.semantic_substrate || null;
    assert(semanticSubstrate?.required === true, "missing planned files still keep semantic substrate required for real contradictory-config work");
    assert(semanticSubstrate?.satisfied === false, "missing planned files do not let repo-wide annotations satisfy active-plan semantic substrate");
    assert((semanticSubstrate?.blocking_gap_ids || []).includes("missing_mutually_exclusive_facts"), "missing planned files still preserve the blocking mutually-exclusive gap");
    assert(semanticSubstrate?.scope_degraded === true, "missing planned files persist degraded semantic scope");
    assert(semanticSubstrate?.scan_scope_used === "repo_wide_fallback", "missing planned files persist the actual repo-wide fallback scope used");
    assert(semanticSubstrate?.scope_degraded_reason === "missing_planned_files", "missing planned files persist the degraded-scope reason");
    assert(semanticSubstrate?.relevance_evidence?.config === "strong", "missing planned files preserve strong config relevance even when scope degrades");

    const reloaded = readStateJson(planDir);
    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(session, { cwd: tmp, skillPath: plannerSkillPath, transientCloseSignals: reloaded?.close_signals || null });
    assert(session.check("semantic_substrate_scope_degraded(true)"), "loadStateFacts emits semantic_substrate_scope_degraded(true) when planned files are missing");
    assert(session.check("semantic_substrate_scan_scope_used(repo_wide_fallback)"), "loadStateFacts emits repo_wide_fallback when scoped refresh degraded");
    assert(session.check("semantic_substrate_scope_degraded_reason(missing_planned_files)"), "loadStateFacts emits the degraded-scope reason for missing planned files");
    assert(session.check("semantic_substrate_relevance(config, strong)"), "loadStateFacts keeps strong config relevance facts even when scope degrades");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioQuantResultsValidationFactsStayVisibleToOntology() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-quant-results-facts-"));
  try {
    const planName = "plan_2026-04-10_quant_results";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({ version: 1, stories: [] }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Problem Statement
Validate a betting model final-OOS ROI claim before any promotion decision.

## Files To Modify
- reports/model_results.md

## Verification Strategy
Use proof:quant_results_validation and inspect controls before close.
`);
    writeFileSync(join(planDir, "quant_results_validation.json"), JSON.stringify({
      version: 1,
      applicable: true,
      run_class: "promotion_candidate",
      promotion_verdict: "promotable",
      search: {
        trials_completed: 10,
        unique_parameter_count: 20,
        objective_handling: "frozen",
      },
      sample: {
        bet_count: 120,
        event_count: 120,
        date_span: "2025-01-01..2025-12-31",
      },
      splits: {
        train: "2025-01-01..2025-06-30",
        validation: "2025-07-01..2025-09-30",
        final_oos: "2025-10-01..2025-12-31",
      },
      controls: [
        { name: "baseline", profitable: true, beats_strategy: true },
      ],
      evidence: {
        bootstrap_ci: "ROI CI [-1%, 4%]",
        rolling_or_yearly_stability: "monthly returns reviewed",
        leakage_audit: "known-at-time fields only",
        odds_snapshot_matrix: "entry price: T-24; reference price: close; label type: realized return; CLV/reference price: close",
        strongest_counterargument: "baseline may explain the edge",
        falsification_criteria: "fails if baseline remains stronger after stability audit",
        presentation_stamp: "promotion_candidate",
      },
    }, null, 2));

    const state = createInitialStateJson(planName, "Validate quant results close facts", { projectRoot: tmp });
    state.close_signals = {
      quant_results_validation: {
        required: true,
        satisfied: false,
        status: "blocked_alarm",
        blocking_issues: ["control_baseline_missing_stability_audit"],
        warnings: [],
        required_artifact: "quant_results_validation.json",
        artifact_present: true,
        artifact_valid: true,
        applicable: true,
        run_class: "promotion_candidate",
        promotion_verdict: "promotable",
      },
    };
    writeStateJson(planDir, state);

    const result = runNode([ontologySerializerPath, "--json"], tmp);
    assert(result.ok, "ontology_serializer exits cleanly for quant results validation fixtures");
    const report = JSON.parse(result.stdout);
    const facts = report.facts || [];
    assert(facts.includes("quant_results_validation_required(true)."), "ontology_serializer emits quant_results_validation_required");
    assert(facts.includes("quant_results_validation_satisfied(false)."), "ontology_serializer emits quant_results_validation_satisfied");
    assert(facts.includes("quant_results_validation_status('blocked_alarm')."), "ontology_serializer emits quant results status");
    assert(facts.includes("quant_results_run_class('promotion_candidate')."), "ontology_serializer emits quant results run class");
    assert(facts.some((fact) => fact.startsWith("quant_results_blocking_issue(")), "ontology_serializer emits quant results blocking issues");

    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(session, { cwd: tmp, skillPath: plannerSkillPath });
    assert(session.check("quant_results_validation_required(true)"), "loadStateFacts emits quant_results_validation_required(true)");
    assert(session.check("quant_results_validation_satisfied(false)"), "loadStateFacts emits quant_results_validation_satisfied(false)");
    assert(session.check("quant_results_validation_status(blocked_alarm)"), "loadStateFacts emits blocked quant validation status");
    assert(session.check("quant_results_run_class(promotion_candidate)"), "loadStateFacts emits quant run class");
    assert(session.check("quant_results_promotion_verdict(promotable)"), "loadStateFacts emits quant promotion verdict");
    assert(session.check("quant_results_blocking_issue(control_baseline_missing_stability_audit)"), "loadStateFacts emits quant blocking issue");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioBacktickedPlannerCorePathsStayScopedAndNonBlocking() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-semantic-backticks-"));
  try {
    const planName = "plan_2026-04-09_semantic_backticks";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(join(tmp, ".agent", "skills", "iterative-planner", "scripts", "lib"), { recursive: true });
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(tmp, ".agent", "skills", "iterative-planner", "scripts", "lib", "semantic_substrate.mjs"), "export const semanticSubstrate = true;\n");
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify({
      version: 1,
      generated_at: "2026-04-09T00:00:00.000Z",
      stories: [
        {
          id: "US-101",
          title: "Planner-core story reference",
          priority: "HIGH",
          status: "ACTIVE",
        },
      ],
    }, null, 2));
    writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Tighten planner-core semantic substrate reporting

## Problem Statement
Planner-core close signals should not treat markdown-formatted planner file paths as host-product flow surfaces.

## Files To Modify
- \`.agent/skills/iterative-planner/scripts/lib/semantic_substrate.mjs\`
- \`reports/user_story_audit/story_registry.json\`
- \`plans/knowledge/mistakes.md\`

## Steps
1. Keep planner-core scope deterministic.
`);
    writeFileSync(join(planDir, "verification.md"), "# Verification\n\n## Notes\nFixture only.\n");

    const state = createInitialStateJson(planName, "Tighten planner-core semantic substrate reporting", { projectRoot: tmp });
    state.state = "REFLECT";
    writeStateJson(planDir, state);

    const refresh = refreshPlanArtifacts({
      cwd: tmp,
      skillPath: plannerSkillPath,
      planDirName: planName,
      refreshOntology: true,
      persistOntology: true,
      persistState: true,
      syncFindings: false,
    });

    assert(refresh.refreshed === true, "refreshPlanArtifacts succeeds when Files To Modify uses backticked planner-core paths");

    const reloaded = readStateJson(planDir);
    const semanticSubstrate = reloaded?.close_signals?.semantic_substrate || null;
    assert(semanticSubstrate?.required === false, "backticked planner-core/report paths do not trigger host-surface semantic-substrate relevance");
    assert(semanticSubstrate?.satisfied === true, "backticked planner-core/report paths keep semantic substrate satisfied when no host-product domain is relevant");
    assert(semanticSubstrate?.status === "not_required", "backticked planner-core/report paths persist semantic_substrate.not_required");
    assert((semanticSubstrate?.blocking_gap_ids || []).length === 0, "backticked planner-core/report paths do not persist blocking semantic-substrate gaps");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLearnedObligationsActivationStaysSelective() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-learned-obligations-"));
  try {
    const activePlanDir = join(tmp, "plans", "plan_2026-04-07_mobile_active");
    mkdirSync(activePlanDir, { recursive: true });
    writeFileSync(join(activePlanDir, "intent_contract.json"), JSON.stringify({
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
          evidence_mode: "manual_observation",
        },
      ],
    }, null, 2));

    const activeMistakes = computeMistakeRegistrySignal({
      cwd: tmp,
      planDir: activePlanDir,
      stateJson: { goal: "Clone responsive landing page" },
      planContent: `# Plan v1

## Goal
Clone responsive landing page

## Files To Modify
- src/landing.html
- src/landing.css
`,
      storyRegistry: null,
    });

    const activeSignal = computeLearnedObligationsSignal({
      cwd: tmp,
      planDir: activePlanDir,
      stateJson: { goal: "Clone responsive landing page" },
      planContent: `# Plan v1

## Goal
Clone responsive landing page

## Files To Modify
- src/landing.html
- src/landing.css
`,
      verificationContent: "",
      verificationLedger: null,
      storyRegistry: null,
      mistakeSignal: activeMistakes,
    });

    assert(activeMistakes.active_ids.includes("M-UI-001"), "mistake registry activates M-UI-001 for matching responsive UI work");
    assert(activeSignal.required === true, "learned obligations activate when responsive UI work matches multiple trigger families");
    assert(activeSignal.active_ids.includes("responsive_ui_mobile"), "responsive_ui_mobile activates for matching UI/page/mobile work");
    assert(activeSignal.active_obligations[0]?.activation_source === "mistake_registry", "responsive_ui_mobile can activate from the mistake registry");
    assert(activeSignal.active_obligations[0]?.source_mistake_registered === true, "registry-backed learned obligations record registered source mistakes");
    assert(activeSignal.active_obligations[0]?.recommended_annotations?.includes("proves"), "registry-backed learned obligations inherit recommended annotations");

    const inactivePlanDir = join(tmp, "plans", "plan_2026-04-07_mobile_inactive");
    mkdirSync(inactivePlanDir, { recursive: true });
    writeFileSync(join(inactivePlanDir, "intent_contract.json"), JSON.stringify({
      version: 1,
      primary_user: "Maintainer",
      job_to_be_done: "Refactor an internal parser without changing UI behavior",
      desired_outcomes: ["Cleaner parser logic"],
      anti_goals: ["Accidental UI-surface obligations"],
      deliverables: [],
    }, null, 2));

    const inactiveMistakes = computeMistakeRegistrySignal({
      cwd: tmp,
      planDir: inactivePlanDir,
      stateJson: { goal: "Refactor parser state handling" },
      planContent: `# Plan v1

## Goal
Refactor parser state handling

## Files To Modify
- src/parser.tsx
`,
      storyRegistry: null,
    });

    const inactiveSignal = computeLearnedObligationsSignal({
      cwd: tmp,
      planDir: inactivePlanDir,
      stateJson: { goal: "Refactor parser state handling" },
      planContent: `# Plan v1

## Goal
Refactor parser state handling

## Files To Modify
- src/parser.tsx
`,
      verificationContent: "",
      verificationLedger: null,
      storyRegistry: null,
      mistakeSignal: inactiveMistakes,
    });

    assert(inactiveMistakes.active_count === 0, "mistake registry stays inactive when only one trigger family matches");
    assert(inactiveSignal.required === false, "learned obligations stay inactive when only one trigger family matches");
    assert(inactiveSignal.active_count === 0, "no learned obligation records are emitted for unrelated planner work");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCmsMissingContentContractsStayLinked() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-cms-missing-"));
  try {
    const planDir = join(tmp, "plans", "plan_2026-04-12_cms_missing");
    mkdirSync(planDir, { recursive: true });
    mkdirSync(join(tmp, "reports", "user_story_audit"), { recursive: true });
    const storyRegistry = {
      version: 1,
      stories: [
        {
          id: "US-731",
          title: "CMS missing-content triage stays diagnostic-first",
          tags: ["diagnostics", "preflight", "routing"],
          code_refs: ["wp-content/themes/site/single-course.php"],
        },
      ],
    };
    writeFileSync(join(tmp, "reports", "user_story_audit", "story_registry.json"), JSON.stringify(storyRegistry, null, 2));

    const goal = "Investigate why a WordPress page looks empty and the custom post type content is missing";
    const planContent = `# Plan v1

## Goal
${goal}

## Files To Modify
- wp-content/themes/site/single-course.php
`;

    const activeMistakes = computeMistakeRegistrySignal({
      cwd: tmp,
      planDir,
      stateJson: { goal },
      planContent,
      storyRegistry,
    });
    const cmsMistake = activeMistakes.active_mistakes.find((mistake) => mistake.id === "M-CMS-001");

    const activeSignal = computeLearnedObligationsSignal({
      cwd: tmp,
      planDir,
      stateJson: { goal },
      planContent,
      verificationContent: "",
      verificationLedger: null,
      storyRegistry,
      mistakeSignal: activeMistakes,
    });

    const synthesis = computeVerificationObligationSynthesis({
      cwd: tmp,
      planDir,
      stateJson: { goal },
      planContent,
      storyRegistry,
    });

    assert(activeMistakes.active_ids.includes("M-CMS-001"), "mistake registry activates M-CMS-001 for WordPress missing-content incidents");
    assert(!!cmsMistake, "mistake registry emits the active M-CMS-001 record");
    assert((cmsMistake?.required_guards || []).includes("site_turbulence"), "M-CMS-001 requires the site_turbulence guard");
    assert((cmsMistake?.required_guards || []).includes("raw_html_dom_probe"), "M-CMS-001 requires the raw_html_dom_probe guard");
    assert((cmsMistake?.required_guards || []).includes("entity_preservation"), "M-CMS-001 requires the entity_preservation guard");
    assert((cmsMistake?.verification_hooks || []).includes("verification_ledger:artifact_review"), "M-CMS-001 requires artifact-review ledger proof");
    assert((cmsMistake?.verification_hooks || []).includes("verification.md:Learned Obligations"), "M-CMS-001 requires learned-obligation markdown fallback proof");
    assert(activeSignal.required === true, "CMS missing-content learned obligations activate once the source mistake is active");
    assert(activeSignal.active_ids.includes("cms_missing_content_turbulence"), "CMS missing-content turbulence obligation activates");
    assert(activeSignal.active_ids.includes("cms_missing_content_dom_probe"), "CMS missing-content DOM probe obligation activates");
    assert(activeSignal.active_ids.includes("cms_missing_content_entity_preservation"), "CMS missing-content entity-preservation obligation activates");
    assert(activeSignal.active_obligations.every((obligation) => obligation.activation_source === "mistake_registry"), "CMS missing-content obligations activate from the linked mistake registry");
    assert((synthesis.obligations || []).some((entry) => entry.id === "cms_missing_content_diagnosis"), "verification-obligation synthesis includes the CMS missing-content diagnosis family");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLearnedObligationsUseObservedSurfacesAndFallbackWhenRegistryIsUnusable() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-learned-fallback-"));
  try {
    const planDir = join(tmp, "plans", "plan_2026-04-08_mobile_observed");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({
      version: 1,
      primary_user: "Site visitor",
      job_to_be_done: "Use the marketing page comfortably on a phone",
      desired_outcomes: ["The page stays readable on a narrow viewport"],
      anti_goals: ["Desktop-only layout"],
      deliverables: [
        {
          id: "marketing_page",
          name: "Marketing page",
          kind: "ui",
          required: true,
          purpose: "Support mobile browsing",
          quality_bars: ["Readable on narrow viewport"],
          evidence_mode: "manual_observation",
        },
      ],
    }, null, 2));

    const genericPlan = `# Plan v1

## Goal
Polish the marketing experience

## Files To Modify
- docs/notes.md
`;
    const observedState = {
      goal: "Polish the marketing experience",
      change_manifest: [{ path: "src/mobile.css" }],
    };

    const observedMistakes = computeMistakeRegistrySignal({
      cwd: tmp,
      planDir,
      stateJson: observedState,
      planContent: genericPlan,
      storyRegistry: null,
    });
    const observedMistake = observedMistakes.active_mistakes.find((mistake) => mistake.id === "M-UI-001");

    assert(observedMistakes.active_ids.includes("M-UI-001"), "mistake registry activates responsive UI obligations from observed change surfaces plus intent evidence");
    assert(observedMistake?.matched_observed_files?.includes("src/mobile.css"), "mistake registry records observed changed files that matched responsive UI globs");
    assert((observedMistake?.matched_declared_files || []).length === 0, "mistake registry does not pretend the responsive UI file was declared in Files To Modify");
    assert((observedMistake?.matched_terms || []).length === 0, "mistake registry can activate without relying on plan-term matches");
    assert(observedMistake?.family === "ui_responsiveness", "mistake registry normalizes the shipped family field");
    assert((observedMistake?.retro_refs || []).includes("R-2026-04-08-001"), "mistake registry carries retro refs through to active mistakes");
    assert((observedMistake?.query_tags || []).includes("mobile"), "mistake registry carries query tags through to active mistakes");
    assert((observedMistake?.required_evidence || []).includes("manual_mobile_observation"), "mistake registry carries required evidence through to active mistakes");
    assert(Array.isArray(observedMistake?.supersedes) && observedMistake.supersedes.length === 0, "mistake registry defaults supersedes to an empty array");

    const invalidRegistryPath = join(tmp, "invalid_mistake_registry.json");
    writeFileSync(invalidRegistryPath, "{ invalid json\n");

    const fallbackMistakes = computeMistakeRegistrySignal({
      cwd: tmp,
      planDir,
      stateJson: observedState,
      planContent: genericPlan,
      storyRegistry: null,
      registryPath: invalidRegistryPath,
    });

    const fallbackSignal = computeLearnedObligationsSignal({
      cwd: tmp,
      planDir,
      stateJson: observedState,
      planContent: genericPlan,
      verificationContent: "",
      verificationLedger: null,
      storyRegistry: null,
      registryPath: learnedObligationsRegistryPath,
      mistakeRegistryPath: invalidRegistryPath,
    });
    const fallbackObligation = fallbackSignal.active_obligations.find((obligation) => obligation.id === "responsive_ui_mobile");

    assert(fallbackMistakes.registry_present === true, "mistake registry signal still records that an invalid registry file exists");
    assert(fallbackMistakes.registry_usable === false, "mistake registry signal marks invalid registry files as unusable");
    assert(fallbackMistakes.registry_error === "invalid_json", "mistake registry signal records invalid_json for corrupted registry files");
    assert(fallbackMistakes.status === "registry_unusable", "mistake registry signal reports unusable registries explicitly");
    assert(fallbackSignal.required === true, "learned obligations stay active when the source mistake registry is unusable");
    assert(fallbackSignal.source_mistake_registry_present === true, "learned obligations preserve source mistake registry presence in degraded mode");
    assert(fallbackSignal.source_mistake_registry_usable === false, "learned obligations record degraded source mistake registry usability");
    assert(fallbackSignal.source_mistake_registry_error === "invalid_json", "learned obligations expose invalid registry errors for degraded-mode audits");
    assert(fallbackSignal.degraded_source_registry === true, "learned obligations flag degraded source-registry reliance explicitly");
    assert(fallbackSignal.degraded_source_registry_ids.includes("responsive_ui_mobile"), "learned obligations identify which obligations rely on the degraded source registry");
    assert(fallbackObligation?.activation_source === "fallback_triggers", "responsive_ui_mobile falls back to direct obligation triggers when the mistake registry is unusable");
    assert(fallbackObligation?.source_mistake_registered === null, "degraded learned obligations do not falsely claim the source mistake was verified in an unusable registry");
    assert(fallbackObligation?.source_registry_degraded === true, "degraded learned obligations mark the active obligation as source-registry degraded");
    assert(fallbackObligation?.source_registry_status === "unusable", "degraded learned obligations expose whether the source registry was missing or unusable");
    assert(fallbackObligation?.matched_observed_files?.includes("src/mobile.css"), "fallback learned obligations preserve observed change-surface provenance");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioHostOwnedKnowledgeOverlaysStayDraftUntilApproved() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-knowledge-overlays-"));
  try {
    const planDir = join(tmp, "plans", "plan_2026-04-08_overlay_activation");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "planner.mistake_overrides.json"), JSON.stringify({
      version: 1,
      mistakes: [
        {
          id: "KB-M-DRAFT",
          title: "Draft promotion candidate",
          summary: "Should stay inert until approved.",
          status: "draft",
          triggers: {
            file_globs: ["**/*.css"],
            plan_terms: ["responsive"],
          },
          minimum_trigger_families: 2,
        },
        {
          id: "KB-M-ACTIVE",
          title: "Approved promotion candidate",
          summary: "Should activate once approved.",
          status: "approved",
          triggers: {
            file_globs: ["**/*.css"],
            plan_terms: ["responsive"],
          },
          minimum_trigger_families: 2,
          obligation_ids: ["KB-LO-M-ACTIVE"],
          required_guards: ["mobile_responsiveness"],
        },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "planner.learned_obligations.json"), JSON.stringify({
      version: 1,
      obligations: [
        {
          id: "KB-LO-M-DRAFT",
          source_mistake: "KB-M-DRAFT",
          subject_id: "draft:responsive-ui",
          verification_mode: "manual_review",
          status: "draft",
        },
        {
          id: "KB-LO-M-ACTIVE",
          source_mistake: "KB-M-ACTIVE",
          subject_id: "plan:responsive-ui",
          verification_mode: "manual_review",
          status: "approved",
        },
      ],
    }, null, 2));

    const planContent = `# Plan v1

## Goal
Polish responsive layout

## Files To Modify
- src/mobile.css
`;
    const stateJson = { goal: "Polish responsive layout" };

    const mistakeSignal = computeMistakeRegistrySignal({
      cwd: tmp,
      planDir,
      stateJson,
      planContent,
      storyRegistry: null,
    });
    const mistakeRegistry = loadMistakeRegistry({ cwd: tmp });
    const obligationsSignal = computeLearnedObligationsSignal({
      cwd: tmp,
      planDir,
      stateJson,
      planContent,
      verificationContent: "",
      verificationLedger: null,
      storyRegistry: null,
      mistakeSignal,
    });

    assert(mistakeSignal.registry_overlay_present === true, "mistake registry reports host-owned overlay presence when planner.mistake_overrides.json exists");
    assert(mistakeSignal.registry_overlay_usable === true, "mistake registry reports a usable host-owned overlay when planner.mistake_overrides.json is valid");
    assert(mistakeSignal.active_ids.includes("KB-M-ACTIVE"), "approved host-owned mistake overrides participate in active mistake detection");
    assert(!mistakeSignal.active_ids.includes("KB-M-DRAFT"), "draft host-owned mistake overrides stay inert until approved");
    assert(obligationsSignal.registry_overlay_present === true, "learned obligations report host-owned overlay presence when planner.learned_obligations.json exists");
    assert(obligationsSignal.registry_overlay_usable === true, "learned obligations report a usable host-owned overlay when planner.learned_obligations.json is valid");
    assert(obligationsSignal.active_ids.includes("KB-LO-M-ACTIVE"), "approved host-owned learned-obligation overrides activate through their approved source mistake");
    assert(!obligationsSignal.active_ids.includes("KB-LO-M-DRAFT"), "draft host-owned learned-obligation overrides stay inert until approved");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioHostOwnedOverlayCollisionsFailRuntimeSemantics() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-knowledge-overlay-collision-"));
  try {
    const planDir = join(tmp, "plans", "plan_2026-04-08_overlay_collision");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "planner.mistake_overrides.json"), JSON.stringify({
      version: 1,
      mistakes: [
        {
          id: "M-UI-001",
          title: "Colliding override",
          summary: "Should be rejected because it collides with a shipped id.",
          status: "active",
          triggers: {
            file_globs: ["**/*.css"],
            plan_terms: ["responsive"],
          },
          minimum_trigger_families: 2,
        },
      ],
    }, null, 2));
    writeFileSync(join(tmp, "planner.learned_obligations.json"), JSON.stringify({
      version: 1,
      obligations: [
        {
          id: "responsive_ui_mobile",
          source_mistake: "M-UI-001",
          subject_id: "draft:responsive-ui",
          verification_mode: "manual_review",
          status: "active",
        },
      ],
    }, null, 2));

    const planContent = `# Plan v1

## Goal
Polish responsive layout

## Files To Modify
- src/mobile.css
`;
    const stateJson = { goal: "Polish responsive layout" };

    const mistakeSignal = computeMistakeRegistrySignal({
      cwd: tmp,
      planDir,
      stateJson,
      planContent,
      storyRegistry: null,
    });
    const mistakeRegistry = loadMistakeRegistry({ cwd: tmp });
    const obligationsSignal = computeLearnedObligationsSignal({
      cwd: tmp,
      planDir,
      stateJson,
      planContent,
      verificationContent: "",
      verificationLedger: null,
      storyRegistry: null,
      mistakeSignal,
    });
    const obligationsRegistry = loadLearnedObligationsRegistry({ cwd: tmp });

    assert(mistakeSignal.registry_overlay_present === true, "mistake registry reports colliding host-owned overlay presence");
    assert(mistakeSignal.registry_overlay_usable === false, "mistake registry marks shipped-id collisions unusable at runtime");
    assert(mistakeSignal.registry_overlay_error === "duplicate_overlay_id", "mistake registry exposes duplicate_overlay_id for shipped-id collisions");
    assert(mistakeRegistry.overlay_active_entries.length === 0, "colliding host-owned mistake overlays contribute no active overlay entries");
    assert(obligationsSignal.registry_overlay_present === true, "learned obligations report colliding host-owned overlay presence");
    assert(obligationsSignal.registry_overlay_usable === false, "learned obligations mark shipped-id collisions unusable at runtime");
    assert(obligationsSignal.registry_overlay_error === "duplicate_overlay_id", "learned obligations expose duplicate_overlay_id for shipped-id collisions");
    assert(obligationsRegistry.overlay_active_entries.length === 0, "colliding host-owned learned obligations contribute no active overlay entries");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioMistakeRegistryWarningsCatchDrift() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-mistake-invariants-"));
  try {
    const planName = "plan_2026-04-08_mistakewarn";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Validate registry drift warnings
`);
    writeFileSync(join(planDir, "ontology_facts.pl"), `mistake_registry_present(true).
mistake_registry_usable(true).
known_mistake('M-001', 'Incomplete ripple-through on behavioural changes').
mistake_obligation('M-001', 'responsive_ui_mobile').
active_mistake('M-001').
verification_subject('plan:responsive-ui-mobile', 'plan_guard').
verification_mode('manual_observation').
verification_obligation('vo_responsive_ui_mobile', 'plan:responsive-ui-mobile', 'manual_observation', 'warn_then_fail').
obligation_source('vo_responsive_ui_mobile', 'learned_obligation', 'responsive_ui_mobile').
obligation_required_by_phase('vo_responsive_ui_mobile', 'reflect').
obligation_source_mistake('vo_responsive_ui_mobile', 'M-UNKNOWN').
`);

    const state = createInitialStateJson(planName, "Mistake registry warning fixture");
    state.state = "EXECUTE";
    writeStateJson(planDir, state);

    const session = createSession();
    loadRules(session, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(session, { cwd: tmp, skillPath: plannerSkillPath });
    assert(session.check("invariant_warning(obligation_source_mistake_unregistered, 'vo_responsive_ui_mobile')"), "unknown source_mistake ids surface as advisory warnings");
    assert(!session.check("invariant_warning(active_mistake_without_linked_obligation, 'M-001')"), "active mistakes with emitted obligations do not produce false positive drift warnings");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioLearnedObligationInvariantEscalatesByPhase() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-learned-invariant-"));
  try {
    const planName = "plan_2026-04-07_learnedphase";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Clone responsive landing page
`);
    writeFileSync(join(planDir, "ontology_facts.pl"), `verification_subject('plan:responsive-ui-mobile', 'plan_guard').
verification_mode('manual_observation').
verification_obligation('vo_responsive_ui_mobile', 'plan:responsive-ui-mobile', 'manual_observation', 'warn_then_fail').
obligation_source('vo_responsive_ui_mobile', 'learned_obligation', 'responsive_ui_mobile').
obligation_required_by_phase('vo_responsive_ui_mobile', 'reflect').
obligation_source_registry_degraded('vo_responsive_ui_mobile').
obligation_source_registry_status('vo_responsive_ui_mobile', 'missing').
`);

    const executeState = createInitialStateJson(planName, "Learned-obligation warning fixture");
    executeState.state = "EXECUTE";
    writeStateJson(planDir, executeState);

    const executeSession = createSession();
    loadRules(executeSession, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(executeSession, { cwd: tmp, skillPath: plannerSkillPath });
    assert(executeSession.check("invariant_warning(missing_learned_obligation, 'plan:responsive-ui-mobile')"), "missing learned-obligation proof is a warning before the required phase");
    assert(!executeSession.check("invariant_violated(missing_learned_obligation, 'plan:responsive-ui-mobile')"), "missing learned-obligation proof does not hard-fail before REFLECT");
    assert(executeSession.check("invariant_warning(source_registry_degraded_for_learned_obligation, 'vo_responsive_ui_mobile')"), "degraded learned-obligation source registries warn before the required phase");
    assert(!executeSession.check("invariant_violated(source_registry_degraded_for_learned_obligation, 'vo_responsive_ui_mobile')"), "degraded learned-obligation source registries do not hard-fail before REFLECT");

    const reflectState = createInitialStateJson(planName, "Learned-obligation violation fixture");
    reflectState.state = "REFLECT";
    writeStateJson(planDir, reflectState);

    const reflectSession = createSession();
    loadRules(reflectSession, { cwd: tmp, skillPath: plannerSkillPath });
    loadStateFacts(reflectSession, { cwd: tmp, skillPath: plannerSkillPath });
    assert(reflectSession.check("invariant_violated(missing_learned_obligation, 'plan:responsive-ui-mobile')"), "missing learned-obligation proof hard-fails once the required phase is reached");
    assert(reflectSession.check("invariant_violated(source_registry_degraded_for_learned_obligation, 'vo_responsive_ui_mobile')"), "degraded learned-obligation source registries hard-fail once the required phase is reached");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTraceHookAndAudit() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-trace-"));
  try {
    const planName = "plan_2026-04-03_facefeed";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(planDir, { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "src", "app.js"), "export const traced = true;\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Files to Modify
- src/app.js
`);

    const state = createInitialStateJson(planName, "Trace hook fixture");
    state.state = "EXECUTE";
    writeStateJson(planDir, state);

    const readEvent = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: join(planDir, "plan.md") },
      cwd: tmp,
    });
    const editEvent = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: join(tmp, "src", "app.js") },
      cwd: tmp,
    });
    const bashEvent = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      cwd: tmp,
    });

    const readResult = runNode([hookPath], plannerRoot, readEvent);
    assert(readResult.ok, "post_tool_use hook accepts a Read event");

    const editResult = runNode([hookPath], plannerRoot, editEvent);
    assert(editResult.ok, "post_tool_use hook accepts an Edit event");

    const bashResult = runNode([hookPath], plannerRoot, bashEvent);
    assert(bashResult.ok, "post_tool_use hook accepts a Bash event");

    const { results, coverage } = auditTrace(planDir, "EXECUTE");
    assert(results.every((entry) => entry.status !== "FAIL"), "trace_auditor accepts the traced EXECUTE activity");
    assert(coverage === 100, "trace_auditor reports full EXECUTE trace coverage for the fixture");

    const telemetrySummary = summarizeProofTelemetry({
      cwd: tmp,
      planDir,
      planDirName: planName,
      persist: true,
    });
    assert(telemetrySummary.mode === "present", "proof telemetry summarizes trusted hook events for the active plan");
    assert(telemetrySummary.surfaces.includes("browser_ui"), "proof telemetry derives browser_ui from the traced source file");
    assert(telemetrySummary.proof_events.includes("unit_test"), "proof telemetry infers unit_test evidence from the traced Bash command");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRuleEngineUsesTransientOntologyFacts() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-ontology-refresh-"));
  try {
    const planName = "plan_2026-04-04_c0ffee12";
    const planDir = join(tmp, "plans", planName);
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    mkdirSync(planDir, { recursive: true });

    writeFileSync(join(tmp, "plans", ".current_plan"), `${planName}\n`);
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");
    writeFileSync(join(planDir, "plan.md"), `# Plan v1

## Goal
Use transient ontology facts from current plan content.

## Success Criteria
- SC-001: check-invariants evaluates current plan facts without rewriting ontology_facts.pl

## Verification Strategy
- Run rule_engine.mjs check-invariants --json and confirm stale ontology_facts.pl is left untouched
`);
    writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] Prepared ontology refresh fixture\n");
    writeFileSync(join(planDir, "verification.md"), "# Verification\n\nPASS\n");
    writeFileSync(join(planDir, "findings.md"), "# Findings\n\n## Index\n- [F-001] Ontology refresh should happen before invariant evaluation.\n");
    writeFileSync(join(planDir, "decisions.md"), "# Decision Log\n");
    writeFileSync(join(planDir, "red_team_notes.md"), "# Red-Team Notes\n");
    writeFileSync(join(planDir, "ontology_facts.pl"), "% stale ontology facts\n");

    const state = createInitialStateJson(planName, "Ontology refresh fixture", { projectRoot: tmp });
    state.state = "REFLECT";
    writeStateJson(planDir, state);

    const result = runNode([ruleEnginePath, "check-invariants", "--json"], tmp);
    assert(result.ok, "rule_engine check-invariants exits cleanly for the ontology refresh fixture");
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!parsed, "rule_engine check-invariants emits valid JSON for the ontology refresh fixture");

    const persistedFacts = readFileSync(join(planDir, "ontology_facts.pl"), "utf-8");
    assert(persistedFacts.includes("% stale ontology facts"), "check-invariants leaves ontology_facts.pl untouched during read-only refresh");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioManifestoFactsAndDiagnosticsSurfaceInSemanticEngine() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-manifesto-diagnostics-"));
  try {
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");

    const { session } = createSemanticEngine({
      cwd: tmp,
      skillPath: plannerSkillPath,
      refreshOntology: false,
    });

    assert(session.check("planner_manifesto_present(true)"), "semantic engine exposes planner_manifesto_present from the manifesto registry");
    assert(session.check("planner_hard_policy_mode(minimal_semantic_core)"), "semantic engine exposes the planner hard-policy mode");
    assert(session.check("planner_ontology_role(challenge_and_enrich)"), "semantic engine exposes the ontology role from the manifesto");
    assert(session.check("planner_hard_policy(impact_over_ritual)"), "semantic engine exposes planner hard-policy facts");

    session.consult("diagnostics_active_plan_poisoned(true).");
    session.consult("diagnostics_simple_task(true).");
    session.consult("canonicalization_applied(section_heading, 'Execution Steps', 'Steps').");
    session.consult("diagnostics_structural_token_feature(true).");
    session.consult("diagnostics_ui_renderer_surface(true).");
    session.consult("diagnostics_renderer_contract_explicit(false).");
    session.consult("diagnostics_visual_render_proof(false).");
    session.consult("proof_telemetry_mode(present).");
    session.consult("touched_surface(browser_ui).");
    session.consult("proof_event(unit_test).");
    session.consult("project_archetype(quant).");
    session.consult("touched_surface(quant_modeling).");
    session.consult("task_signal(model_or_signal_change).");

    assert(session.check("repairable_variance(canonicalization(section_heading), info('Execution Steps', 'Steps'))"), "diagnostics rules classify canonicalized section aliases as repairable variance");
    assert(session.check("repairable_variance(structural_token_renderer_gap, info(renderer_contract_missing, explicit_renderer_handling))"), "diagnostics rules classify missing structural token renderer handling as repairable variance");
    assert(session.check("repairable_variance(structural_token_renderer_gap, info(visual_render_proof_missing, browser_or_visual_proof))"), "diagnostics rules classify missing browser-visible proof for structural token rendering as repairable variance");
    assert(session.check("repairable_variance(proof_gap, info(missing_visual_evidence, browser_ui))"), "diagnostics rules classify missing browser-visible telemetry proof as repairable variance");
    assert(session.check("repairable_variance(proof_gap, info(missing_temporal_split_check, quant))"), "diagnostics rules classify missing temporal split proof for quant telemetry as repairable variance");
    assert(session.check("recommended_recovery(recover_poison_then_lightweight)"), "diagnostics rules recommend lightweight poison recovery for simple tasks");
    assert(session.check("next_best_action(run_recover_poison)"), "diagnostics rules expose recover-poison as the next action when history is poisoned");
    assert(session.check("next_best_action(verify_structural_token_renderer)"), "diagnostics rules expose structural token renderer verification as a next action");
    assert(session.check("next_best_action(record_visual_evidence)"), "diagnostics rules expose browser-visible proof capture as a next action");
    assert(session.check("next_best_action(verify_quant_temporal_split)"), "diagnostics rules expose temporal split proof as a next action for quant telemetry gaps");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioSemanticEngineReusesProvidedSnapshot() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-shared-snapshot-"));
  try {
    mkdirSync(join(tmp, "plans", "knowledge"), { recursive: true });
    writeFileSync(join(tmp, "plans", "knowledge", "index.md"), "# Knowledge Base Index\n");
    writeFileSync(join(tmp, "plans", "knowledge", "mistakes.md"), "# Mistakes\n");
    writeFileSync(join(tmp, "plans", "knowledge", "patterns.md"), "# Patterns\n");
    writeFileSync(join(tmp, "plans", "knowledge", "gotchas.md"), "# Gotchas\n");

    const { refresh_source } = createSemanticEngine({
      cwd: tmp,
      skillPath: plannerSkillPath,
      refreshOntology: true,
      transientCloseSignals: {
        semantic_substrate: {
          required: true,
          satisfied: false,
          blocking_gap_ids: ["missing_mutually_exclusive_facts"],
        },
      },
      transientOntologyFacts: "planner_manifesto_present(true).",
    });

    assert(refresh_source === "shared_snapshot", "semantic engine reports shared_snapshot when transition hands it refreshed artifacts");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioDocReferenceAnalyzerIgnoresGeneratedArtifacts() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-doc-refs-"));
  try {
    writeFileSync(join(tmp, "README.md"), `# Fixture

Generated review notes live at \`plans/annotation_review.md\`.
Broken repo-local ref: \`.agent/skills/iterative-planner/scripts/missing_doc_target.mjs\`.
`);

    const result = runNode([projectHealthPath, "--analyzer", "doc-references", "--json"], tmp);
    assert(result.ok, "project_health doc-references analyzer exits cleanly for the fixture");

    let report = null;
    try { report = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!report, "project_health doc-references analyzer emits valid JSON");

    const messages = (report?.findings || []).map((entry) => entry.message);
    assert(!messages.some((msg) => msg.includes("plans/annotation_review.md")), "doc-references ignores generated plans/annotation_review.md references");
    assert(messages.some((msg) => msg.includes("missing_doc_target.mjs")), "doc-references still reports a real broken repo-local reference");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioOrphanedCapabilitiesUsePlannerDocsAndWorkflowSelfDocs() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-orphaned-caps-"));
  try {
    mkdirSync(join(tmp, ".agent", "skills", "example", "prolog"), { recursive: true });
    mkdirSync(join(tmp, ".agent", "skills", "example", "scripts"), { recursive: true });
    mkdirSync(join(tmp, ".agent", "skills", "example", "references"), { recursive: true });
    mkdirSync(join(tmp, ".agent", "workflows"), { recursive: true });

    writeFileSync(join(tmp, ".agent", "skills", "example", "prolog", "transitions.pl"), "can_transition(explore, plan).\n");
    writeFileSync(join(tmp, ".agent", "skills", "example", "scripts", "autonomy_leash.mjs"), "console.log('ok');\n");
    writeFileSync(join(tmp, ".agent", "skills", "example", "MIGRATION.md"), `# Migration

- Core rules: \`transitions.pl\`
- Enforcement: \`autonomy_leash.mjs\`
`);
    writeFileSync(join(tmp, ".agent", "skills", "example", "references", "rule-guide.md"), `# Rule Guide

The planner loads \`transitions.pl\` during gate checks.
`);
    writeFileSync(join(tmp, ".agent", "workflows", "custom-flow.md"), `---
description: Run the custom flow
---
# Custom Flow

This workflow is documented in its own file and should not require a second index entry.
`);

    const result = runNode([projectHealthPath, "--analyzer", "orphaned-capabilities", "--json"], tmp);
    assert(result.ok, "project_health orphaned-capabilities analyzer exits cleanly for documented fixtures");

    let report = null;
    try { report = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!report, "project_health orphaned-capabilities analyzer emits valid JSON");

    const messages = (report?.findings || []).map((entry) => entry.message || "");
    assert(!messages.some((msg) => msg.includes("transitions.pl")), "orphaned-capabilities accepts planner docs from MIGRATION/references");
    assert(!messages.some((msg) => msg.includes("autonomy_leash.mjs")), "orphaned-capabilities accepts documented enforcement scripts");
    assert(!messages.some((msg) => msg.includes("custom-flow.md")), "orphaned-capabilities treats workflow files with real docs as self-documented");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioProjectHealthWarnsWhenAntiPatternsJsonIsMissing() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-red-team-health-"));
  try {
    mkdirSync(join(tmp, "reports", "red_team_audit"), { recursive: true });
    writeFileSync(join(tmp, "reports", "red_team_audit", "anti_patterns.md"), "# Anti-Patterns\n\n- Placeholder\n");

    const result = runNode([projectHealthPath, "--json"], tmp);
    assert(result.ok, "project_health JSON scan exits cleanly when anti_patterns.json is missing");

    let report = null;
    try { report = JSON.parse(result.stdout); } catch { /* asserted below */ }
    assert(!!report, "project_health emits valid JSON for missing anti-pattern artifact fixtures");

    const messages = (report?.findings || []).map((entry) => entry.message || "");
    assert(messages.some((msg) => msg.includes("anti_patterns.md exists without anti_patterns.json")), "project_health warns when the machine-readable anti-pattern artifact is missing");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log("\nPlanner Support Contracts\n");

scenarioRuleEngineSemantics();
scenarioIDEDetection();
scenarioSanitizeContracts();
scenarioStateValidationContracts();
scenarioStoryValidationRefsLoadIntoRuntimeFacts();
scenarioVerificationObligationSynthesisContracts();
scenarioFilesToModifyAcceptsCommonNonCanonicalEntries();
scenarioChecklistIntegrityBaselineStaysSynced();
scenarioProjectPolicyFactsStayDeclarative();
scenarioAuditPerspectiveDiversityUsesAuditSet();
scenarioAntiRecurrenceInvariantEscalatesByPhase();
scenarioSemanticSubstrateCloseSignalPersistsAndLoadsIntoProlog();
scenarioReviewIntakeCloseSignalPersistsAndLoadsIntoProlog();
scenarioMissingPlannedFilesKeepSemanticScopeDegradedAndBlocking();
scenarioQuantResultsValidationFactsStayVisibleToOntology();
scenarioBacktickedPlannerCorePathsStayScopedAndNonBlocking();
scenarioLearnedObligationsActivationStaysSelective();
scenarioCmsMissingContentContractsStayLinked();
scenarioLearnedObligationsUseObservedSurfacesAndFallbackWhenRegistryIsUnusable();
scenarioHostOwnedKnowledgeOverlaysStayDraftUntilApproved();
scenarioHostOwnedOverlayCollisionsFailRuntimeSemantics();
scenarioMistakeRegistryWarningsCatchDrift();
scenarioLearnedObligationInvariantEscalatesByPhase();
scenarioTraceHookAndAudit();
scenarioRuleEngineUsesTransientOntologyFacts();
scenarioManifestoFactsAndDiagnosticsSurfaceInSemanticEngine();
scenarioSemanticEngineReusesProvidedSnapshot();
scenarioDocReferenceAnalyzerIgnoresGeneratedArtifacts();
scenarioOrphanedCapabilitiesUsePlannerDocsAndWorkflowSelfDocs();
scenarioProjectHealthWarnsWhenAntiPatternsJsonIsMissing();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
