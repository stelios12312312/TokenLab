#!/usr/bin/env node
// test_supervisor_runner.mjs — Unit tests for lib/supervisor_runner.mjs.
//
// Covers:
//   - cache hit on identical context (no LLM round-trip)
//   - schema validation rejects malformed responses
//   - PLANNER_SUPERVISOR_DISABLED returns fallback
//   - mock-response path returns valid verdict
//   - LLM unavailable error returns fallback (not crash)
//   - clearSupervisorCache removes stored verdicts

import {
  runAdvisorSupervisor,
  runOntologyFixSupervisor,
  clearSupervisorCache,
  renderAdvisorVerdictBlock,
  renderAdvisorEscalationBlock,
  renderSuggestedFixesBlock,
  isValidPlannerCommand,
  redactSupervisorPromptPayload,
  isSupervisorRequired,
  SUPERVISOR_VERSION,
} from "../scripts/lib/supervisor_runner.mjs";

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

async function safeRun(label, fn) {
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL: ${label} — threw ${err?.message || err}`);
  }
}

const ESCALATIONS = [{ type: "advisor-review", reason: "test reason A", severity: "RECOMMENDED" }];
const PLAN_STATE = { state: "PLAN", iter: 0 };

const VALID_ADVISOR_JSON = JSON.stringify({
  next: "Run /advisor to triage the recent change",
  why: "Recent change is large and shared modules were touched",
  commands: ["node .agent/skills/iterative-planner/scripts/escalation_check.mjs"],
});

const VALID_ONTOLOGY_JSON = JSON.stringify({
  suggested_fix_command: "node .agent/skills/iterative-planner/scripts/story_registry.mjs check",
  auto_repair_safe: true,
  explanation: "Story registry needs verification after edits",
});

console.log("\nSupervisor Runner Contracts");
console.log(`(supervisor_version=${SUPERVISOR_VERSION})\n`);

// Ensure clean cache before tests
clearSupervisorCache();

// ──────────────────────────────────────────────────────────────────────
// Test 1: PLANNER_SUPERVISOR_DISABLED short-circuits to fallback
// ──────────────────────────────────────────────────────────────────────
await safeRun("disabled env -> advisor fallback", async () => {
  const env = { PLANNER_SUPERVISOR_DISABLED: "1" };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "unavailable", "advisor disabled returns unavailable status");
  assert(verdict.source === "fallback", "advisor disabled source=fallback");
  assert(verdict.reason === "PLANNER_SUPERVISOR_DISABLED", "advisor disabled reason recorded");
  assert(typeof verdict.next === "string" && verdict.next.length > 0, "advisor fallback has next text");
  assert(Array.isArray(verdict.commands) && verdict.commands.length >= 1, "advisor fallback has at least 1 command");
});

await safeRun("disabled env -> ontology fallback", async () => {
  const env = { PLANNER_SUPERVISOR_DISABLED: "1" };
  const verdict = await runOntologyFixSupervisor({
    violation: { name: "code_without_tests", detail: "US-001" },
    env,
  });
  assert(verdict.supervisor_status === "unavailable", "ontology disabled returns unavailable status");
  assert(verdict.suggested_fix_command === null, "ontology disabled returns null fix command");
  assert(verdict.auto_repair_safe === false, "ontology disabled auto_repair_safe=false");
});

// ──────────────────────────────────────────────────────────────────────
// Test 2: Mock-response path returns valid verdict (cold cache)
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("advisor mock response -> fresh verdict", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: VALID_ADVISOR_JSON };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "fresh", "first call returns fresh status");
  assert(verdict.source === "mock", "first call source=mock");
  assert(verdict.next.includes("/advisor"), "advisor verdict next field carries mock content");
  assert(Array.isArray(verdict.commands) && verdict.commands[0].includes("escalation_check"), "advisor verdict commands array populated");
});

await safeRun("ontology mock response -> fresh verdict", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: VALID_ONTOLOGY_JSON };
  const verdict = await runOntologyFixSupervisor({
    violation: { name: "code_without_tests", detail: "US-001" },
    env,
  });
  assert(verdict.supervisor_status === "fresh", "first ontology call returns fresh status");
  assert(verdict.auto_repair_safe === true, "ontology verdict carries auto_repair_safe=true");
  assert(verdict.suggested_fix_command.includes("story_registry"), "ontology fix command captured from mock");
});

// ──────────────────────────────────────────────────────────────────────
// Test 3: Cache hit on identical context (no fresh round-trip)
// ──────────────────────────────────────────────────────────────────────
await safeRun("advisor cache hit on identical context", async () => {
  // Second call with SAME context but DIFFERENT mock response — should return cached, not new mock
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    next: "DIFFERENT recommendation",
    why: "DIFFERENT reason",
    commands: ["/different-cmd"],
  }) };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "cached", "second call hits cache");
  assert(verdict.source === "cache", "second call source=cache");
  assert(verdict.next.includes("/advisor"), "cached value preserved, not overwritten by new mock");
  assert(!verdict.next.includes("DIFFERENT"), "cache does NOT pick up new mock content");
});

await safeRun("ontology cache hit on identical violation", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    suggested_fix_command: "DIFFERENT command",
    auto_repair_safe: false,
    explanation: "different",
  }) };
  const verdict = await runOntologyFixSupervisor({
    violation: { name: "code_without_tests", detail: "US-001" },
    env,
  });
  assert(verdict.supervisor_status === "cached", "second ontology call hits cache");
  assert(verdict.suggested_fix_command.includes("story_registry"), "cached ontology verdict preserved");
});

// ──────────────────────────────────────────────────────────────────────
// Test 4: Different context -> different cache key -> new verdict
// ──────────────────────────────────────────────────────────────────────
await safeRun("different escalation context -> cache miss", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: VALID_ADVISOR_JSON };
  const altEscalations = [{ type: "advisor-review", reason: "DIFFERENT reason", severity: "REQUIRED" }];
  const verdict = await runAdvisorSupervisor({ escalations: altEscalations, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "fresh", "different context -> fresh (cache miss)");
});

// ──────────────────────────────────────────────────────────────────────
// Test 5: Schema validation rejects malformed response
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("advisor schema rejects missing fields -> fallback", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({ next: "only next, no why/commands" }) };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "unavailable", "malformed response triggers fallback");
  assert(verdict.source === "fallback", "malformed response source=fallback");
  assert(verdict.reason === "schema_validation_failed", "malformed reason=schema_validation_failed");
});

await safeRun("ontology schema rejects wrong types -> fallback", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    suggested_fix_command: 42, // not a string or null
    auto_repair_safe: "yes",  // not a bool
    explanation: "test",
  }) };
  const verdict = await runOntologyFixSupervisor({
    violation: { name: "different_invariant", detail: "X" },
    env,
  });
  assert(verdict.supervisor_status === "unavailable", "ontology malformed triggers fallback");
  assert(verdict.suggested_fix_command === null, "ontology fallback fix_command=null");
});

// ──────────────────────────────────────────────────────────────────────
// Test 6: LLM error (mock_error) returns fallback, does not crash
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("advisor LLM timeout -> fallback", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_ERROR: "timeout" };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "unavailable", "LLM timeout -> unavailable");
  assert(verdict.reason === "timeout", "LLM timeout reason recorded");
});

await safeRun("advisor LLM http_error -> fallback", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_ERROR: "http_error" };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "unavailable", "LLM http_error -> unavailable");
});

// ──────────────────────────────────────────────────────────────────────
// Test 7: M-009 guard — phase-premature invariants get deterministic null
// ──────────────────────────────────────────────────────────────────────
await safeRun("ontology phase_guard_required -> deterministic null fix", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: VALID_ONTOLOGY_JSON };
  const verdict = await runOntologyFixSupervisor({
    violation: { name: "phase_premature_check", detail: "Y", phase_guard_required: true },
    env,
  });
  assert(verdict.supervisor_status === "phase_guard", "phase-premature -> phase_guard status");
  assert(verdict.source === "deterministic", "phase-premature -> deterministic source (no LLM)");
  assert(verdict.suggested_fix_command === null, "phase-premature -> no fix command");
  assert(verdict.auto_repair_safe === false, "phase-premature -> auto_repair_safe=false");
});

// ──────────────────────────────────────────────────────────────────────
// Test 8: clearSupervisorCache removes entries
// ──────────────────────────────────────────────────────────────────────
await safeRun("clearSupervisorCache empties cache directory", async () => {
  // Pre-warm cache with one entry
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: VALID_ADVISOR_JSON };
  await runAdvisorSupervisor({ escalations: [{ type: "cache_pre_warm", reason: "z" }], planState: PLAN_STATE, env });
  const removed = clearSupervisorCache();
  assert(removed >= 0, "clearSupervisorCache returns count (non-negative)");
  // Next call with same context should be fresh (cache miss)
  const verdict = await runAdvisorSupervisor({ escalations: [{ type: "cache_pre_warm", reason: "z" }], planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "fresh", "after clear, identical context -> fresh (cache miss)");
});

// ──────────────────────────────────────────────────────────────────────
// Test 9: renderAdvisorVerdictBlock produces multi-line output
// ──────────────────────────────────────────────────────────────────────
await safeRun("renderAdvisorVerdictBlock formats NEXT/WHY/Run lines", async () => {
  const block = renderAdvisorVerdictBlock({
    next: "test next",
    why: "test why",
    commands: ["cmd1", "cmd2"],
    supervisor_status: "fresh",
    source: "mock",
  });
  assert(block.includes("NEXT: test next"), "block includes NEXT line");
  assert(block.includes("WHY:  test why"), "block includes WHY line");
  assert(block.includes("Run: cmd1"), "block includes Run: cmd1");
  assert(block.includes("Run: cmd2"), "block includes Run: cmd2");
  assert(block.includes("Supervisor: fresh"), "block includes Supervisor status line");
});

// ──────────────────────────────────────────────────────────────────────
// Test 10: Defensive — undefined/null violation returns fallback, not crash
// ──────────────────────────────────────────────────────────────────────
await safeRun("ontology null violation -> defensive fallback", async () => {
  const verdict = await runOntologyFixSupervisor({ violation: null, env: {} });
  assert(verdict.supervisor_status === "unavailable", "null violation -> unavailable");
  assert(verdict.reason === "no_violation_provided", "null violation reason recorded");
});

// ──────────────────────────────────────────────────────────────────────
// Test 11: renderAdvisorEscalationBlock — used directly by bootstrap.mjs.
// Locks the rendered format so a regression in bootstrap.mjs is caught here.
// ──────────────────────────────────────────────────────────────────────
await safeRun("renderAdvisorEscalationBlock with supervisor verdict", async () => {
  const block = renderAdvisorEscalationBlock({
    advisorEscalation: {
      type: "advisor-review",
      reason: "Recent change touched shared modules",
      auto_launch_marker: "[WORKFLOW_AUTORUN:/advisor]",
    },
    supervisorVerdict: {
      next: "Run /advisor to capture the change",
      why: "Shared modules changed",
      commands: ["node .agent/skills/iterative-planner/scripts/escalation_check.mjs"],
      supervisor_status: "fresh",
      source: "mock",
    },
  });
  assert(block.includes("⚠️  Advisor review recommended"), "banner line present");
  assert(block.includes("Recent change touched shared modules"), "reason rendered");
  assert(block.includes("NEXT: Run /advisor to capture the change"), "NEXT line rendered via inner helper");
  assert(block.includes("WHY:  Shared modules changed"), "WHY line rendered");
  assert(block.includes("Run: node .agent/skills/iterative-planner/scripts/escalation_check.mjs"), "Run line rendered");
  assert(block.includes("Supervisor: fresh"), "supervisor status rendered");
  assert(block.includes("Run /advisor to capture lessons"), "trailing run-advisor hint present");
  // When supervisor_verdict is present, the legacy marker must NOT appear
  assert(!block.includes("[WORKFLOW_AUTORUN:/advisor]"), "legacy marker suppressed when verdict present");
});

await safeRun("renderAdvisorEscalationBlock falls back to marker when no verdict", async () => {
  const block = renderAdvisorEscalationBlock({
    advisorEscalation: {
      type: "advisor-review",
      reason: "Supervisor unavailable scenario",
      auto_launch_marker: "[WORKFLOW_AUTORUN:/advisor]",
    },
    supervisorVerdict: null,
  });
  assert(block.includes("⚠️  Advisor review recommended"), "banner line present");
  assert(block.includes("[WORKFLOW_AUTORUN:/advisor]"), "legacy marker present when verdict missing");
  assert(!block.includes("NEXT:"), "no NEXT line when no verdict");
});

await safeRun("renderAdvisorEscalationBlock returns empty when no escalation", async () => {
  const block = renderAdvisorEscalationBlock({});
  assert(block === "", "empty input -> empty output");
});

// ──────────────────────────────────────────────────────────────────────
// Test 12: renderSuggestedFixesBlock — used directly by transition.mjs.
// Locks the format of the Suggested Fixes / Phase-Premature sections.
// ──────────────────────────────────────────────────────────────────────
await safeRun("renderSuggestedFixesBlock with mixed safe and phase-guarded violations", async () => {
  const semanticResults = [{
    name: "Story invariants",
    status: "FAIL",
    detail: "3 violation(s)",
    violations: [
      {
        name: "code_without_tests",
        detail: "US-001",
        suggested_fix_command: "node .agent/skills/iterative-planner/scripts/story_registry.mjs check",
        auto_repair_safe: true,
        explanation: "Add test refs to story_registry.json for US-001",
        supervisor_status: "fresh",
        supervisor_source: "mock",
      },
      {
        name: "gate_chain_broken",
        detail: "I-015",
        suggested_fix_command: "node .agent/skills/iterative-planner/scripts/transition.mjs <correct-gate>",
        auto_repair_safe: false,
        explanation: "Never edit state.json; always use transition.mjs",
        supervisor_status: "fresh",
        supervisor_source: "mock",
      },
      {
        name: "phase_premature_check",
        detail: "I-XYZ",
        suggested_fix_command: null,
        auto_repair_safe: false,
        explanation: "phase guard",
        supervisor_status: "phase_guard",
        supervisor_source: "deterministic",
      },
    ],
  }];
  const block = renderSuggestedFixesBlock(semanticResults);
  // Safe fix should appear with [safe] tag and Run line
  assert(block.includes("-- Suggested Fixes (supervisor-generated; advisory) --"),
    "Suggested Fixes section header rendered");
  assert(block.includes("code_without_tests (US-001) [safe]"),
    "safe violation entry rendered with [safe] tag");
  assert(block.includes("Run: node .agent/skills/iterative-planner/scripts/story_registry.mjs check"),
    "Run line for safe fix rendered");
  assert(block.includes("Why: Add test refs to story_registry.json for US-001"),
    "Why line rendered with explanation");
  assert(block.includes("Source: mock"),
    "Source line rendered");
  // Manual review entry
  assert(block.includes("gate_chain_broken (I-015) [manual review]"),
    "manual-review violation entry rendered with [manual review] tag");
  // Phase-premature section
  assert(block.includes("-- Phase-Premature Violations (M-009 guard; 1) --"),
    "Phase-Premature section header rendered with count");
  assert(block.includes("phase_premature_check (I-XYZ): resolve in a later planner phase"),
    "phase-guarded violation lists deferral guidance");
  // Critically: phase-guarded violation should NOT appear in Suggested Fixes section
  // (it has a null fix command and supervisor_status=phase_guard)
  const beforePhaseGuard = block.split("-- Phase-Premature Violations")[0];
  assert(!beforePhaseGuard.includes("phase_premature_check"),
    "phase-guarded violation not duplicated into Suggested Fixes section");
});

await safeRun("renderSuggestedFixesBlock returns empty when no violations", async () => {
  const block = renderSuggestedFixesBlock([
    { name: "Semantic: explore → plan", status: "PASS", detail: "ok" },
  ]);
  assert(block === "", "PASS-only results -> empty block");
});

await safeRun("renderSuggestedFixesBlock returns empty when violations have no fix commands", async () => {
  const block = renderSuggestedFixesBlock([{
    name: "Story invariants",
    status: "FAIL",
    detail: "1 violation",
    violations: [{
      name: "some_invariant",
      detail: "X",
      suggested_fix_command: null,
      auto_repair_safe: false,
      supervisor_status: "unavailable",
    }],
  }]);
  // No fixable violations AND no phase_guard violations -> nothing to render
  assert(block === "", "violations without fix commands and not phase-guarded -> empty");
});

await safeRun("renderSuggestedFixesBlock handles empty/null input", async () => {
  assert(renderSuggestedFixesBlock([]) === "", "empty array -> empty");
  assert(renderSuggestedFixesBlock(null) === "", "null -> empty");
  assert(renderSuggestedFixesBlock(undefined) === "", "undefined -> empty");
});

// ──────────────────────────────────────────────────────────────────────
// Test 13: isValidPlannerCommand whitelist (Vector 8 fix)
// Accepts only real planner CLI shapes; rejects hallucinated paths.
// ──────────────────────────────────────────────────────────────────────
await safeRun("isValidPlannerCommand accepts known shapes, rejects hallucinations", async () => {
  // Valid: planner scripts
  assert(isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/escalation_check.mjs"),
    "accepts bare planner script");
  assert(isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/transition.mjs explore-to-plan"),
    "accepts planner script with arg");
  assert(isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/program_manager.mjs intake --program path"),
    "accepts planner script with flags");
  assert(isValidPlannerCommand("node .agent/skills/iterative-planner/tests/test_migration.mjs"),
    "accepts planner test");

  // Valid: slash commands
  assert(isValidPlannerCommand("/advisor"), "accepts /advisor slash command");
  assert(isValidPlannerCommand("/safe-change"), "accepts /safe-change slash command");
  assert(isValidPlannerCommand("/red-team-audit"), "accepts /red-team-audit slash command");
  assert(isValidPlannerCommand("/cmd-a"), "accepts /cmd-a sentinel");

  // Invalid: hallucinated bare script paths (Vector 8 hit)
  assert(!isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/red-team-audit.js"),
    "rejects .js extension (planner uses .mjs)");
  assert(!isValidPlannerCommand("node nonexistent-script.js"), "rejects bare nonexistent path");
  assert(!isValidPlannerCommand("node /some/abs/path.mjs"), "rejects scripts outside planner tree");
  assert(!isValidPlannerCommand("node scripts/transition.mjs"), "rejects path without .agent/ prefix");
  assert(!isValidPlannerCommand("node .agent/other/path.mjs"), "rejects path not in iterative-planner");

  // Invalid: shell commands the supervisor must not invent
  assert(!isValidPlannerCommand("echo hello"), "rejects echo");
  assert(!isValidPlannerCommand("git status"), "rejects git command");
  assert(!isValidPlannerCommand("rm -rf /"), "rejects rm");
  assert(!isValidPlannerCommand("cat file"), "rejects cat");
  assert(!isValidPlannerCommand("npm test"), "rejects npm");

  // Invalid: command-injection shapes
  assert(!isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/x.mjs; rm -rf /"),
    "rejects ; injection");
  assert(!isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/x.mjs && evil"),
    "rejects && injection");
  assert(!isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/x.mjs | evil"),
    "rejects | injection");
  assert(!isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/x.mjs `evil`"),
    "rejects backtick injection");
  assert(!isValidPlannerCommand("node .agent/skills/iterative-planner/scripts/x.mjs $(evil)"),
    "rejects $() injection");

  // Invalid: defensive
  assert(!isValidPlannerCommand(""), "rejects empty");
  assert(!isValidPlannerCommand("   "), "rejects whitespace-only");
  assert(!isValidPlannerCommand(null), "rejects null");
  assert(!isValidPlannerCommand(undefined), "rejects undefined");
  assert(!isValidPlannerCommand(42), "rejects non-string");
  assert(!isValidPlannerCommand("/"), "rejects bare slash");
  assert(!isValidPlannerCommand("/UPPER"), "rejects all-caps slash command");
});

// ──────────────────────────────────────────────────────────────────────
// Test 14: validateAdvisorVerdict filters hallucinated commands
// Mixed valid + invalid -> only valid pass through (with filtered_command_count).
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("advisor: mixed valid + hallucinated commands -> only valid survive", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    next: "Mixed test",
    why: "Some valid, some not",
    commands: [
      "/advisor",                                        // valid
      "node .agent/skills/iterative-planner/scripts/transition.mjs", // valid
      "node hallucinated-script.js",                     // INVALID
      "echo BOOM",                                       // INVALID
    ],
  })};
  const verdict = await runAdvisorSupervisor({ escalations: [{ type: "filter-test", reason: "mix" }], env });
  assert(verdict.supervisor_status === "fresh", "verdict still fresh after filtering");
  assert(verdict.commands.length === 2, "only 2 commands survived the whitelist filter");
  assert(verdict.commands.includes("/advisor"), "slash command preserved");
  assert(verdict.commands.some((c) => c.includes("transition.mjs")), "valid planner script preserved");
  assert(!verdict.commands.some((c) => c.includes("hallucinated")), "hallucinated path filtered");
  assert(!verdict.commands.some((c) => c.includes("echo")), "echo command filtered");
  assert(verdict.filtered_command_count === 2, "filtered_command_count reports 2");
});

clearSupervisorCache();
await safeRun("advisor: all commands hallucinated -> fallback verdict", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    next: "All bad",
    why: "Every command is invalid",
    commands: ["echo a", "echo b", "rm -rf /"],
  })};
  const verdict = await runAdvisorSupervisor({ escalations: [{ type: "all-bad", reason: "test" }], env });
  assert(verdict.supervisor_status === "unavailable", "all-invalid commands -> fallback");
  assert(verdict.source === "fallback", "source=fallback when commands all hallucinated");
  assert(verdict.reason === "schema_validation_failed",
    "reason recorded as schema_validation_failed when whitelist filters everything");
});

// ──────────────────────────────────────────────────────────────────────
// Test 15: validateOntologyFixVerdict degrades hallucinated fix to null + manual
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("ontology: hallucinated fix_command degrades to null + manual review", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    suggested_fix_command: "node hallucinated-fix.js --force",
    auto_repair_safe: true,
    explanation: "Plausible-looking lie",
  })};
  const verdict = await runOntologyFixSupervisor({
    violation: { name: "test_invariant", detail: "X" },
    env,
  });
  assert(verdict.suggested_fix_command === null,
    "hallucinated fix downgraded to null");
  assert(verdict.auto_repair_safe === false,
    "auto_repair_safe forced to false when fix is hallucinated");
  assert(verdict.explanation.includes("unrecognised command shape"),
    "explanation flags the hallucination to the operator");
});

clearSupervisorCache();
await safeRun("ontology: valid planner fix_command passes through unchanged", async () => {
  const env = { PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({
    suggested_fix_command: "node .agent/skills/iterative-planner/scripts/story_registry.mjs check",
    auto_repair_safe: true,
    explanation: "Re-run story check",
  })};
  const verdict = await runOntologyFixSupervisor({
    violation: { name: "test_invariant", detail: "Y" },
    env,
  });
  assert(verdict.suggested_fix_command.includes("story_registry.mjs"),
    "valid fix command preserved verbatim");
  assert(verdict.auto_repair_safe === true,
    "auto_repair_safe preserved when fix is whitelisted");
});

// ──────────────────────────────────────────────────────────────────────
// Test 16: SUPERVISOR_VERSION reflects current contract
//   v1: initial release
//   v2: command whitelist added (Vector 8)
//   v3: prompt-side secret redaction added (Vector 5)
//   v4: cache-hit re-validation + tighter args regex + truthy phase_guard (red-team F-001/F-002/F-003)
// Cache keys include this version, so a bump invalidates entries created
// under an earlier validator/prompt contract.
// ──────────────────────────────────────────────────────────────────────
await safeRun("SUPERVISOR_VERSION reflects current validator+prompt+cache-validation contract", async () => {
  assert(SUPERVISOR_VERSION === "v4",
    "SUPERVISOR_VERSION='v4' so pre-cache-revalidation caches (validated under permissive rules) cannot be served");
});

// ──────────────────────────────────────────────────────────────────────
// Test 17: redactSupervisorPromptPayload (Vector 5 fix)
// Verifies the redactor walks payloads and strips configured secrets,
// Bearer tokens, OpenAI-style sk-*, GitHub tokens before they reach the LLM.
// ──────────────────────────────────────────────────────────────────────
await safeRun("redactSupervisorPromptPayload strips configured API keys", async () => {
  const env = {
    PLANNER_DRIFT_LLM_API_KEY: "sk-configured-key-abcdef1234",
    DEEPSEEK_API_KEY: "sk-deepseek-fallback-key-9876543210",
  };
  const payload = { reason: "Error: api_key=sk-configured-key-abcdef1234 leaked" };
  const out = redactSupervisorPromptPayload(payload, env);
  assert(!out.includes("sk-configured-key-abcdef1234"),
    "configured PLANNER_DRIFT_LLM_API_KEY removed from payload");
  assert(out.includes("[REDACTED]"), "redaction marker present");
});

await safeRun("redactSupervisorPromptPayload catches OpenAI-style sk-* keys not in env", async () => {
  const payload = { reason: "Found sk-c839f18c9f05485c9c2389e0eb072e5d in a commit message" };
  const out = redactSupervisorPromptPayload(payload, {});
  assert(!out.includes("sk-c839f18c9f05485c9c2389e0eb072e5d"),
    "OpenAI-style key scrubbed even without env configured");
  assert(out.includes("[REDACTED_API_KEY]"), "sk-* substitution marker present");
});

await safeRun("redactSupervisorPromptPayload catches GitHub tokens", async () => {
  const payload = {
    findings: [
      "leaked ghp_1234567890abcdefghij1234567890abcdef in commit msg",
      "and github_pat_abcdefghij1234567890abcdefghij in another file",
    ],
  };
  const out = redactSupervisorPromptPayload(payload, {});
  assert(!out.includes("ghp_1234567890abcdefghij1234567890abcdef"), "ghp_ token scrubbed");
  assert(!out.includes("github_pat_abcdefghij1234567890abcdefghij"), "github_pat_ token scrubbed");
  assert(out.includes("[REDACTED_GITHUB_TOKEN]"), "GitHub token marker present");
});

await safeRun("redactSupervisorPromptPayload catches Bearer tokens", async () => {
  const payload = { stack_trace: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" };
  const out = redactSupervisorPromptPayload(payload, {});
  assert(!out.includes("eyJhbGciOiJIUzI1NiJ9.payload.sig"), "Bearer JWT body scrubbed");
  assert(out.includes("Bearer [REDACTED]"), "Bearer redaction substitution applied");
});

await safeRun("redactSupervisorPromptPayload leaves non-secret strings intact", async () => {
  const payload = {
    plan_phase: "EXPLORE",
    iter: 0,
    escalations: [{
      type: "advisor-review",
      reason: "Recent change touched lib/auth.mjs (+20/-3)",
    }],
  };
  const out = redactSupervisorPromptPayload(payload, {});
  assert(out.includes("EXPLORE"), "plan_phase preserved");
  assert(out.includes("advisor-review"), "escalation type preserved");
  assert(out.includes("lib/auth.mjs"), "file path preserved (not a secret)");
  assert(out.includes("+20/-3"), "diff stats preserved");
});

await safeRun("redactSupervisorPromptPayload accepts strings + objects", async () => {
  const out1 = redactSupervisorPromptPayload("plain string with sk-c839f18c9f05485c9c2389e0eb072e5d", {});
  assert(!out1.includes("sk-c839f18c9f05485c9c2389e0eb072e5d"), "string input redacted");
  const out2 = redactSupervisorPromptPayload({ nested: { reason: "sk-c839f18c9f05485c9c2389e0eb072e5d" } }, {});
  assert(!out2.includes("sk-c839f18c9f05485c9c2389e0eb072e5d"), "nested object redacted via JSON.stringify");
});

// ──────────────────────────────────────────────────────────────────────
// Test 18: Integration — outbound prompt body never carries secrets
// Spawns runAdvisorSupervisor with a custom fetchImpl that captures the
// request body, then asserts no configured-secret or sk-* pattern survives.
// ──────────────────────────────────────────────────────────────────────
clearSupervisorCache();
await safeRun("integration: configured API key never appears in outbound LLM body", async () => {
  let capturedBody = null;
  const captureFetch = async (_url, opts) => {
    capturedBody = opts.body;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        next: "x", why: "y", commands: ["/advisor"],
      })}}],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = {
    PLANNER_DRIFT_LLM_API_KEY: "sk-test-configured-1234567890abcdef",
    PLANNER_DRIFT_LLM_MODEL: "test-model",
    PLANNER_DRIFT_LLM_BASE_URL: "https://example.com/v1",
  };
  await runAdvisorSupervisor({
    escalations: [{
      type: "test",
      // Worst case: caller passes a secret in the escalation reason
      reason: "Container env had sk-test-configured-1234567890abcdef in scope",
    }],
    env,
    fetchImpl: captureFetch,
  });
  assert(capturedBody !== null, "fetch was actually invoked (not a mock-response bypass)");
  assert(!capturedBody.includes("sk-test-configured-1234567890abcdef"),
    "configured PLANNER_DRIFT_LLM_API_KEY does NOT appear in request body");
  assert(capturedBody.includes("[REDACTED]"),
    "redaction marker present in outbound body");
});

clearSupervisorCache();
await safeRun("integration: ad-hoc sk-* secrets in escalation reasons get redacted", async () => {
  let capturedBody = null;
  const captureFetch = async (_url, opts) => {
    capturedBody = opts.body;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        next: "x", why: "y", commands: ["/advisor"],
      })}}],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = {
    PLANNER_DRIFT_LLM_API_KEY: "sk-different-from-leaked-key-xxxxxxxx",
    PLANNER_DRIFT_LLM_MODEL: "test-model",
    PLANNER_DRIFT_LLM_BASE_URL: "https://example.com/v1",
  };
  await runAdvisorSupervisor({
    escalations: [{
      type: "test",
      reason: "Leak detected: sk-c839f18c9f05485c9c2389e0eb072e5d in commit abc123",
    }],
    env,
    fetchImpl: captureFetch,
  });
  assert(!capturedBody.includes("sk-c839f18c9f05485c9c2389e0eb072e5d"),
    "ad-hoc sk-* token (not the configured one) ALSO redacted by pattern matcher");
  assert(capturedBody.includes("[REDACTED_API_KEY]"),
    "sk-* pattern-redaction marker present in outbound body");
});

// ──────────────────────────────────────────────────────────────────────
// Test 18: PLANNER_SUPERVISOR_REQUIRED fail-closed mode (Vector 9)
// When set, fallback / phase_guard verdicts are flagged with
// required_but_unavailable=true so callers (bootstrap.mjs) can detect
// degradation rather than treating it as success.
// ──────────────────────────────────────────────────────────────────────
await safeRun("isSupervisorRequired honours env truthy values", async () => {
  const { isSupervisorRequired } = await import("../scripts/lib/supervisor_runner.mjs");
  assert(isSupervisorRequired({ PLANNER_SUPERVISOR_REQUIRED: "1" }) === true, "'1' -> required");
  assert(isSupervisorRequired({ PLANNER_SUPERVISOR_REQUIRED: "true" }) === true, "'true' -> required");
  assert(isSupervisorRequired({ PLANNER_SUPERVISOR_REQUIRED: "yes" }) === true, "'yes' -> required");
  assert(isSupervisorRequired({ PLANNER_SUPERVISOR_REQUIRED: "0" }) === false, "'0' -> not required");
  assert(isSupervisorRequired({}) === false, "absent -> not required");
  assert(isSupervisorRequired(undefined) === false, "undefined env -> not required");
});

clearSupervisorCache();
await safeRun("REQUIRED + DISABLED -> fallback verdict flagged required_but_unavailable", async () => {
  const env = { PLANNER_SUPERVISOR_REQUIRED: "1", PLANNER_SUPERVISOR_DISABLED: "1" };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "unavailable", "disabled returns unavailable");
  assert(verdict.required_but_unavailable === true,
    "REQUIRED env flags fallback verdict so callers can detect degradation");
});

clearSupervisorCache();
await safeRun("REQUIRED + LLM timeout -> fallback flagged required_but_unavailable", async () => {
  const env = { PLANNER_SUPERVISOR_REQUIRED: "1", PLANNER_DRIFT_LLM_MOCK_ERROR: "timeout" };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "unavailable", "timeout returns unavailable");
  assert(verdict.required_but_unavailable === true, "timeout fallback also flagged");
});

clearSupervisorCache();
await safeRun("REQUIRED + malformed mock -> fallback flagged required_but_unavailable", async () => {
  const env = {
    PLANNER_SUPERVISOR_REQUIRED: "1",
    PLANNER_DRIFT_LLM_MOCK_RESPONSE: JSON.stringify({ next: "only next, no other fields" }),
  };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "unavailable", "schema fail returns unavailable");
  assert(verdict.required_but_unavailable === true, "schema-fail fallback also flagged");
});

clearSupervisorCache();
await safeRun("REQUIRED + fresh verdict -> NOT flagged required_but_unavailable", async () => {
  const env = { PLANNER_SUPERVISOR_REQUIRED: "1", PLANNER_DRIFT_LLM_MOCK_RESPONSE: VALID_ADVISOR_JSON };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "fresh", "fresh verdict produced");
  assert(verdict.required_but_unavailable === undefined,
    "fresh verdict has NO required_but_unavailable flag (only degraded ones)");
});

await safeRun("REQUIRED + cached verdict -> NOT flagged required_but_unavailable", async () => {
  // Second call with same context after the previous fresh call hits cache
  const env = { PLANNER_SUPERVISOR_REQUIRED: "1", PLANNER_DRIFT_LLM_MOCK_RESPONSE: VALID_ADVISOR_JSON };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "cached", "second call hits cache");
  assert(verdict.required_but_unavailable === undefined,
    "cached fresh verdict is not flagged (cache hit counts as successful supervision)");
});

clearSupervisorCache();
await safeRun("REQUIRED + ontology phase_guard -> flagged required_but_unavailable", async () => {
  const env = { PLANNER_SUPERVISOR_REQUIRED: "1" };
  const verdict = await runOntologyFixSupervisor({
    violation: { name: "phase_premature_check", detail: "X", phase_guard_required: true },
    env,
  });
  assert(verdict.supervisor_status === "phase_guard", "phase_guard preserved");
  assert(verdict.required_but_unavailable === true,
    "phase_guard counts as not-fresh under REQUIRED -> flagged");
});

await safeRun("not REQUIRED + fallback -> NOT flagged (no regression for default callers)", async () => {
  const env = { PLANNER_SUPERVISOR_DISABLED: "1" };
  const verdict = await runAdvisorSupervisor({ escalations: ESCALATIONS, planState: PLAN_STATE, env });
  assert(verdict.supervisor_status === "unavailable", "disabled fallback");
  assert(verdict.required_but_unavailable === undefined,
    "without REQUIRED env, fallback verdict does NOT carry the flag");
});

await safeRun("renderAdvisorVerdictBlock surfaces required_but_unavailable warning line", async () => {
  const block = renderAdvisorVerdictBlock({
    next: "n", why: "w", commands: ["/advisor"],
    supervisor_status: "unavailable", source: "fallback",
    required_but_unavailable: true,
  });
  assert(block.includes("PLANNER_SUPERVISOR_REQUIRED is set"),
    "rendered block carries the loud REQUIRED warning when flag is set");
  assert(block.includes("This is a fallback"),
    "warning line tells the operator the verdict is a fallback");
});

await safeRun("renderAdvisorVerdictBlock omits warning when flag absent", async () => {
  const block = renderAdvisorVerdictBlock({
    next: "n", why: "w", commands: ["/advisor"],
    supervisor_status: "fresh", source: "provider",
  });
  assert(!block.includes("PLANNER_SUPERVISOR_REQUIRED"),
    "warning line absent when verdict is fresh");
});

// Final summary
console.log(`\n${passed} passed, ${failed} failed`);
clearSupervisorCache(); // leave cache empty for repeatability
process.exit(failed > 0 ? 1 : 0);
