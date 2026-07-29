#!/usr/bin/env node
// Focused regression coverage for planner-core persona authority in project health.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { detectPlanShape } from "../scripts/lib/plan_shape.mjs";
import { decidePersonaPackActivation } from "../scripts/lib/persona_activation_authority.mjs";
import { deriveTaskFocusContract } from "../scripts/lib/task_focus_contract.mjs";
import { selfHealPlanFiles } from "../scripts/lib/plan_self_heal.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const scriptDir = resolve(testDir, "..", "scripts");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}

function run(args, cwd) {
  const result = spawnSync(NODE, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      _PLANNER_PLAN_TARGET: "",
      PLANNER_SKIP_SELF_HEAL: "1",
    },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function parseJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const shape = detectPlanShape({ goalText: "Implement IVE ticket #9 Resolve persona config authority" });
assert(shape.primary === "planner-core", "persona config authority goal is planner-core before files exist");

const executionShape = detectPlanShape({ goalText: "Implement IVE ticket #10 persona execution script" });
assert(executionShape.primary === "planner-core", "persona execution script goal is planner-core before files exist");

const suppressedQuant = decidePersonaPackActivation("quant", { planShape: { primary: "planner-core" } });
assert(suppressedQuant.authority === "suppressed" && suppressedQuant.may_load === false, "planner-core suppresses quant by default");
assert(suppressedQuant.not_applicable === true && suppressedQuant.n_a_record?.type === "N/A", "planner-core suppressed quant carries compact N/A metadata");
assert(suppressedQuant.shape_suppressed === true, "planner-core quant decision carries shape_suppressed metadata");

const plannerFocus = deriveTaskFocusContract({
  goalText: "Design task focus steering for planner obligations",
  intentContract: { version: 1, plan_shape: "planner-core" },
  scopeContract: {
    declared_files: [".agent/skills/iterative-planner/scripts/bootstrap.mjs"],
    owned_files: [".agent/skills/iterative-planner/scripts/bootstrap.mjs"],
    ambient_dirty_files: ["apps/example/src/App.jsx", ".agent/skills/quant-researcher/tests/test_quant.mjs"],
  },
});
const advisoryQuant = decidePersonaPackActivation("quant", {
  planShape: { primary: "planner-core" },
  taskFocusContract: plannerFocus,
});
assert(advisoryQuant.authority === "advisory" && advisoryQuant.may_synthesize_obligation === false, "focus contract keeps planner-core quant advisory rather than blocking");
assert(advisoryQuant.not_applicable === true && advisoryQuant.n_a_record?.reason === "task_focus_advisory_pack", "focus-advisory quant records N/A rationale");

const forcedQuant = decidePersonaPackActivation("quant", {
  planShape: { primary: "planner-core" },
  forcePacks: ["quant"],
});
assert(forcedQuant.authority === "forced" && forcedQuant.may_load === true, "force_packs restores quant authority explicitly");

const scientificQuant = decidePersonaPackActivation("quant", { planShape: { primary: "scientific" } });
assert(scientificQuant.authority === "active" && scientificQuant.may_load === true, "scientific plans keep quant active by default");

const scientificUx = decidePersonaPackActivation("ux_ui", { planShape: { primary: "scientific" } });
assert(scientificUx.authority === "suppressed" && scientificUx.may_load === false, "scientific plans suppress ux_ui by default");

const plannerCoreTokenomics = decidePersonaPackActivation("tokenomics", { planShape: { primary: "planner-core" } });
assert(plannerCoreTokenomics.authority === "suppressed" && plannerCoreTokenomics.may_load === false, "planner-core suppresses tokenomics by default");
assert(plannerCoreTokenomics.not_applicable === true, "planner-core tokenomics suppression is represented as N/A");

const forcedScientificUx = decidePersonaPackActivation("ux_ui", {
  planShape: { primary: "scientific" },
  forcePacks: ["ux_ui"],
});
assert(forcedScientificUx.authority === "forced" && forcedScientificUx.may_load === true, "force_packs restores ux_ui for scientific UI work");

const tmp = mkdtempSync(join(tmpdir(), "persona-authority-health-"));
try {
  const planDir = join(tmp, "plans", "plan_authority");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(tmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "quant", "quant_research_protocol", "assumptions_challenger", "config_integrity", "traceability"],
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2) + "\n");
  writeFileSync(join(tmp, "plans", ".current_plan"), "plan_authority\n");
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    version: 1,
    state: "PLAN",
    plan_dir: "plan_authority",
    goal: "Implement persona activation authority",
    plan_shape: { primary: "feature" },
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({ version: 1 }, null, 2) + "\n");
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Implement persona activation authority

Tokenomics is named here only as an out-of-scope profile that must not be auto-loaded for planner-core work.

## Files To Modify
- .agent/skills/iterative-planner/scripts/project_health.mjs
- .agent/skills/iterative-planner/scripts/audit_runner.mjs
- .agent/skills/iterative-planner/scripts/lib/plan_shape.mjs
`);

  const health = run([join(scriptDir, "project_health.mjs"), "--quick", "--json"], tmp);
  const healthReport = parseJson(health);
  const healthAnalyzers = (healthReport?.findings || []).map((entry) => String(entry?.analyzer || ""));
  assert(!!healthReport, "project_health emits parseable JSON for active planner-core authority fixture");
  assert(!healthAnalyzers.some((name) => name.startsWith("[quant]")), "project_health suppresses quant findings for planner-core active plan");
  assert(!healthAnalyzers.some((name) => name.startsWith("[ux_ui]")), "project_health suppresses ux_ui findings for planner-core active plan");
  assert((healthReport?.persona_authority?.not_applicable_packs || []).includes("quant"), "project_health surfaces quant N/A authority");
  assert((healthReport?.persona_authority?.not_applicable_packs || []).includes("quant_research_protocol"), "project_health surfaces quant_research_protocol N/A authority");

  const audit = run([join(scriptDir, "audit_runner.mjs"), "--plan", "plan_authority", "--json", "--report-only"], tmp);
  const auditReport = parseJson(audit);
  assert(Array.isArray(auditReport?.packs_loaded), "audit_runner emits loaded pack list");
  assert(!auditReport.packs_loaded.includes("quant"), "audit_runner suppresses configured quant pack for planner-core active plan");
  assert(!auditReport.packs_loaded.includes("tokenomics"), "audit_runner suppresses scoped tokenomics auto-detect for planner-core active plan");
  assert((auditReport.persona_authority?.advisory_packs || []).includes("quant"), "audit_runner reports quant as advisory under task-focus context");
  assert((auditReport.persona_authority?.not_applicable_packs || []).includes("quant"), "audit_runner reports quant as not applicable");
  assert((auditReport.persona_authority?.n_a_decisions || []).some((entry) => entry.pack_id === "quant" && entry.reason), "audit_runner emits compact N/A decision rationale");
  assert(audit.stderr.includes("Persona shape suppression:"), "audit_runner stderr emits a shape suppression receipt");
  assert(audit.stderr.includes("dropped_packs=quant, quant_research_protocol"), "suppression receipt names dropped packs together");
  assert(audit.stderr.includes("override=audit.config.json force_packs=[]"), "suppression receipt names force_packs override");
  assert(!audit.stderr.includes("Persona shape conflict:"), "audit_runner does not warn conflict without high-confidence persona_adapt evidence");

  const scientificPlanDir = join(tmp, "plans", "plan_scientific");
  mkdirSync(scientificPlanDir, { recursive: true });
  writeFileSync(join(scientificPlanDir, "state.json"), JSON.stringify({
    version: 1,
    state: "PLAN",
    plan_dir: "plan_scientific",
    goal: "Build a quant leakage replay pack with temporal split checks",
    plan_shape: { primary: "scientific" },
  }, null, 2) + "\n");
  writeFileSync(join(scientificPlanDir, "intent_contract.json"), JSON.stringify({ version: 1, plan_shape: "scientific" }, null, 2) + "\n");
  writeFileSync(join(scientificPlanDir, "plan.md"), `# Plan

## Goal
Build a quant leakage replay pack with temporal split checks

## Files To Modify
- .agent/skills/iterative-planner/tests/fixtures/real_episodes/mac_mini_quant_episodes.json
`);

  const scientificAudit = run([join(scriptDir, "audit_runner.mjs"), "--plan", "plan_scientific", "--json", "--report-only"], tmp);
  const scientificReport = parseJson(scientificAudit);
  assert(scientificReport?.packs_loaded?.includes("quant"), "audit_runner keeps quant loaded for scientific plans");
  assert(!scientificReport?.packs_loaded?.includes("ux_ui"), "audit_runner suppresses ux_ui for scientific plans without explicit force");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const policyTmp = mkdtempSync(join(tmpdir(), "persona-authority-policy-shape-"));
try {
  mkdirSync(join(policyTmp, ".agent", "skills", "iterative-planner", "scripts"), { recursive: true });
  writeFileSync(join(policyTmp, ".agent", "skills", "iterative-planner", "scripts", "audit_runner.mjs"), "// installed planner marker\n");
  writeFileSync(join(policyTmp, "planner.policy.yaml"), "version: 1\nshape: planner-core\n");
  writeFileSync(join(policyTmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "quant", "ux_ui"],
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2) + "\n");

  const declaredAudit = run([join(scriptDir, "audit_runner.mjs"), "--json", "--report-only"], policyTmp);
  const declaredReport = parseJson(declaredAudit);
  assert(Array.isArray(declaredReport?.packs_loaded), "declared policy audit emits JSON");
  assert(!declaredReport.packs_loaded.includes("quant"), "declared shape=planner-core suppresses quant");
  assert(!declaredReport.packs_loaded.includes("ux_ui"), "declared shape=planner-core suppresses ux_ui");
  assert(declaredAudit.stderr.includes("Persona shape suppression: dropped_packs=quant, ux_ui; shape=planner-core; source=declared:planner_policy.shape"), "declared planner-core policy receipt names source");
  assert(declaredAudit.stderr.includes("Persona shape conflict: active/high persona_adapt role(s) quant, ux_ui suppressed by shape=planner-core"), "declared planner-core policy warns on persona-vs-shape conflict");

  const status = run([join(scriptDir, "bootstrap.mjs"), "status"], policyTmp);
  assert(status.stdout.includes("Persona shape suppression: dropped_packs=quant, ux_ui; shape=planner-core; source=declared:planner_policy.shape"), "bootstrap status mirrors shape suppression receipt");
  assert(status.stdout.includes("Persona shape conflict: active/high persona_adapt role(s) quant, ux_ui suppressed by shape=planner-core"), "bootstrap status mirrors persona-vs-shape conflict");

  writeFileSync(join(policyTmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "quant", "ux_ui"],
    force_packs: ["quant"],
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2) + "\n");
  const forcedAudit = run([join(scriptDir, "audit_runner.mjs"), "--json", "--report-only"], policyTmp);
  const forcedReport = parseJson(forcedAudit);
  assert(forcedReport?.packs_loaded?.includes("quant"), "force_packs restores quant under declared planner-core shape");
  assert(!forcedReport?.packs_loaded?.includes("ux_ui"), "unforced ux_ui remains suppressed under declared planner-core shape");
  assert(forcedAudit.stderr.includes("override=audit.config.json force_packs=[quant]"), "suppression receipt names non-empty force_packs override");
} finally {
  rmSync(policyTmp, { recursive: true, force: true });
}

const consumerTmp = mkdtempSync(join(tmpdir(), "persona-authority-consumer-domain-"));
try {
  mkdirSync(join(consumerTmp, ".agent", "skills", "iterative-planner", "scripts"), { recursive: true });
  writeFileSync(join(consumerTmp, ".agent", "skills", "iterative-planner", "scripts", "audit_runner.mjs"), "// installed planner marker\n");
  writeFileSync(join(consumerTmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "quant"],
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
  }, null, 2) + "\n");
  writeFileSync(join(consumerTmp, "planner.policy.yaml"), "version: 1\ndomain: quant\n");
  const quantDomainAudit = run([join(scriptDir, "audit_runner.mjs"), "--json", "--report-only"], consumerTmp);
  const quantDomainReport = parseJson(quantDomainAudit);
  assert(quantDomainReport?.packs_loaded?.includes("quant"), "consumer repo with domain=quant loads quant despite vendored planner");
  assert(!quantDomainAudit.stderr.includes("shape=planner-core"), "consumer domain policy is not reported as planner-core");

  rmSync(join(consumerTmp, "planner.policy.yaml"), { force: true });
  const noPolicyAudit = run([join(scriptDir, "audit_runner.mjs"), "--json", "--report-only"], consumerTmp);
  const noPolicyReport = parseJson(noPolicyAudit);
  assert(noPolicyReport?.packs_loaded?.includes("quant"), "no-policy consumer with only vendored planner is not inferred planner-core");
} finally {
  rmSync(consumerTmp, { recursive: true, force: true });
}

const suppressedTmp = mkdtempSync(join(tmpdir(), "persona-authority-suppressed-domain-"));
try {
  const planDir = join(suppressedTmp, "plans", "plan_feature");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(suppressedTmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "assumptions_challenger"],
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
    suppressed_domain_profiles: ["tokenomics"],
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    version: 1,
    state: "PLAN",
    plan_dir: "plan_feature",
    goal: "Implement feature that mentions tokenomics as excluded scope",
    plan_shape: { primary: "feature" },
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "intent_contract.json"), JSON.stringify({ version: 1 }, null, 2) + "\n");
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Implement feature that mentions tokenomics only to exclude it.

## Problem Statement
Tokenomics, token supply, emissions, vesting, and treasury are not part of this repository.

## Files To Modify
- src/feature.js
`);

  const audit = run([join(scriptDir, "audit_runner.mjs"), "--plan", "plan_feature", "--json", "--report-only"], suppressedTmp);
  const report = parseJson(audit);
  assert(Array.isArray(report?.packs_loaded), "audit_runner emits loaded pack list for suppressed domain fixture");
  assert(!report.packs_loaded.includes("tokenomics"), "audit_runner honors audit.config suppressed_domain_profiles for scoped tokenomics auto-detect");
} finally {
  rmSync(suppressedTmp, { recursive: true, force: true });
}

const selfHealTmp = mkdtempSync(join(tmpdir(), "persona-authority-self-heal-"));
try {
  const planDir = join(selfHealTmp, "plans", "plan_self_heal");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(selfHealTmp, "audit.config.json"), JSON.stringify({
    roles: ["core", "quant_target", "tokenomics", "ux_ui", "traceability"],
    auto_committee: true,
    fail_on: ["HIGH", "CRITICAL"],
    suppressed_domain_profiles: ["tokenomics"],
  }, null, 2) + "\n");
  writeFileSync(join(selfHealTmp, "plans", ".current_plan"), "plan_self_heal\n");
  writeFileSync(join(planDir, "state.json"), JSON.stringify({
    version: 1,
    state: "PLAN",
    plan_dir: "plan_self_heal",
    goal: "Fix planner persona authority",
    plan_shape: { primary: "planner-core" },
  }, null, 2) + "\n");
  writeFileSync(join(planDir, "plan.md"), `# Plan

## Goal
Fix planner persona authority

## Files To Modify
- .agent/skills/iterative-planner/scripts/lib/plan_self_heal.mjs
`);
  const healed = selfHealPlanFiles(planDir, selfHealTmp);
  const planText = readFileSync(join(planDir, "plan.md"), "utf-8");
  assert(!healed.reasons.some((reason) => reason.includes("UX/UI")), "self-heal does not inject UX contract for planner-core-suppressed ux_ui");
  assert(!healed.reasons.some((reason) => reason.includes("Tokenomics")), "self-heal does not inject tokenomics contract when repo suppresses tokenomics");
  assert(!healed.reasons.some((reason) => reason.includes("Model Target")), "self-heal does not inject quant_target contract for planner-core-suppressed quant_target");
  assert(!planText.includes("UX/UI Usability Contract"), "self-heal output plan lacks UX contract");
  assert(!planText.includes("Tokenomics Contract"), "self-heal output plan lacks tokenomics contract");
  assert(!planText.includes("Model Target Contract"), "self-heal output plan lacks model target contract");
} finally {
  rmSync(selfHealTmp, { recursive: true, force: true });
}

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
