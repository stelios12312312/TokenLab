#!/usr/bin/env node
// test_repair_packet.mjs - Format-lock universal repair packet scaffolds.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadGateRepairTemplate,
  normalizeScaffoldMode,
  renderRepairSurface,
  repairSurfaceOutputVolumeLines,
} from "../scripts/lib/repair_packet.mjs";
import {
  buildGateRepairPacket,
  gateExecuteToReflect,
} from "../scripts/verify_gate.mjs";
import { buildResult as buildGatePreparationResult } from "../scripts/gate_prepare.mjs";

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

function packetText(lines) {
  return (Array.isArray(lines) ? lines : []).join("\n");
}

const legacyLowLevelHeading = ["Low-Level", "Agent Gate Packet"].join(" ");
const legacyDeterministicHeading = ["Deterministic", "Repair Packet"].join(" ");

function runDepthCheckForVectorBody(body, title = "Depth fixture") {
  const tmp = mkdtempSync(join(tmpdir(), "planner-etr-depth-"));
  const planDir = join(tmp, "plans", "plan_etr_depth");
  try {
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] fixture\n");
    const vectors = [1, 2, 3].map((n) => `## Vector ${n}: ${title}\n${body}`);
    writeFileSync(join(planDir, "red_team_notes.md"), vectors.join("\n\n"));
    return gateExecuteToReflect(planDir).find((r) => r.code === "GATE-ETR-008");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioRendererModes() {
  assert(normalizeScaffoldMode({ PLANNER_SCAFFOLDS: "off" }) === "off", "PLANNER_SCAFFOLDS=off is recognized");
  assert(normalizeScaffoldMode({ PLANNER_SCAFFOLDS: "examples-only" }) === "examples-only", "PLANNER_SCAFFOLDS=examples-only is recognized");
  assert(normalizeScaffoldMode({ PLANNER_SCAFFOLDS: "unexpected" }) === "on", "unknown scaffold mode falls back to on");

  const template = loadGateRepairTemplate("GATE-ETR-008");
  assert(template?.gate_id === "GATE-ETR-008", "GATE-ETR-008 template loads from config/gate_templates");

  const full = packetText(renderRepairSurface({
    template,
    gateId: "GATE-ETR-008",
    title: "Red-team vectors have content depth",
    missing: ["Vector 1: missing Attack, Impact, Mitigation"],
    env: { PLANNER_SCAFFOLDS: "on" },
  }));
  assert(full.includes("[GATE-ETR-008] Repair Surface: Red-team vectors have content depth"), "repair surface starts with gate id and title");
  assert(full.includes("Missing:"), "repair surface includes missing section");
  assert(full.includes("Accepted patterns:"), "repair surface includes accepted patterns section");
  assert(full.includes("`**Attack**:`"), "full packet shows colon outside bold as accepted");
  assert(full.includes("NOT accepted") && full.includes("`**Attack:**`"), "full packet warns about colon inside bold");
  assert(full.includes("Paste this into each shallow vector:"), "repair surface includes paste template section");
  assert(full.includes("Worked example:"), "repair surface includes worked example section");
  assert(full.includes("Auto-fix:"), "repair surface includes auto-fix section");
  assert(full.includes("Retry:"), "repair surface includes retry section");

  const examplesOnly = packetText(renderRepairSurface({
    template,
    gateId: "GATE-ETR-008",
    title: "Red-team vectors have content depth",
    missing: ["Vector 1: missing Attack"],
    env: { PLANNER_SCAFFOLDS: "examples-only" },
  }));
  assert(!examplesOnly.includes("Paste this into each shallow vector:"), "examples-only omits paste template");
  assert(examplesOnly.includes("Worked example:"), "examples-only keeps worked example");

  const off = packetText(renderRepairSurface({
    template,
    gateId: "GATE-ETR-008",
    title: "Red-team vectors have content depth",
    missing: ["Vector 1: missing Attack"],
    env: { PLANNER_SCAFFOLDS: "off" },
  }));
  assert(off.includes("Scaffolds: disabled"), "off mode reports disabled scaffolds");
  assert(!off.includes("Accepted patterns:"), "off mode omits scaffold sections");

  const volume = repairSurfaceOutputVolumeLines();
  assert(volume.blocked_first > 0 && volume.blocked_first < 99, "blocked-first line budget improves over E2-1 baseline");
  assert(volume.blocked_repeat > 0 && volume.blocked_repeat < 79, "blocked-repeat line budget improves over E2-1 baseline");
  assert(volume.source_status === "live_repair_surface_counter", "output-volume helper reports a live counter");
}

function scenarioGateEtr008Packet() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-repair-packet-"));
  const planDir = join(tmp, "plans", "plan_repair_packet");
  try {
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] fixture\n");
    writeFileSync(join(planDir, "red_team_notes.md"), `## Vector 1: [TBD]
Attack:
- Replace this with the attack.
Impact:
- Replace this with the damage.
Mitigation:
- Replace this with the fix.

## Vector 2: Missing impact
Attack: Catastrophic input reaches the parser.
Mitigation: The caller sanitizes nothing and the crash is user-visible.

## Vector 3: Too terse
Attack: bad input
Impact: things break
Mitigation: add checks
`);

    const results = gateExecuteToReflect(planDir);
    const depth = results.find((result) => result.code === "GATE-ETR-008");
    assert(depth?.status === "WARN" && depth?.advisory_conversion === true, "fixture surfaces advisory GATE-ETR-008");

    const text = packetText(buildGateRepairPacket({
      planDir,
      planDirName: "plan_repair_packet",
      gateName: "execute-to-reflect",
      results,
    }));
    assert(!text.includes("Repair Surface"), "advisory-only gate result does not emit a blocking repair surface");
    assert(!text.includes(legacyLowLevelHeading), "gate packet no longer uses the old low-level heading");
    assert(!text.includes(legacyDeterministicHeading), "gate packet no longer embeds the old deterministic heading");
    assert(text.split("\n").length < 79, "advisory-only packet stays below blocked-repeat baseline line count");
    assert(!text.includes("[GATE-ETR-008]"), "advisory-only packet does not present GATE-ETR-008 as a blocker");
    assert(!text.includes("Vector 1: [TBD]"), "advisory diagnostics are not repeated as blocking repair prose");
    assert(!text.includes("title still uses placeholder text"), "advisory analyzer detail is not rendered as a hard repair");
    assert(!text.includes("`**Attack**:`"), "advisory-only packet omits formatting ritual examples");
    assert(!text.includes("`**Attack:**`"), "advisory-only packet omits rejected formatting ritual examples");
    assert(!text.includes("examples/passing/GATE-ETR-008.md"), "advisory-only packet does not require a worked-example retry");
    assert(!text.includes("transition.mjs execute-to-reflect"), "advisory-only packet does not instruct a transition retry");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTargetHotspotGuidance() {
  const reflectText = packetText(buildGateRepairPacket({
    planDirName: "plan_hotspot_reflect",
    gateName: "reflect-to-validate",
    results: [
      { status: "FAIL", code: "GATE-REF-003", name: "No uncompleted items remain before VALIDATE", detail: "3 open progress item(s) remain" },
      { status: "FAIL", code: "GATE-REF-004", name: "Knowledge base/semantic record is updated before VALIDATE", detail: "Structured close signal: KB status = missing" },
    ],
  }));
  assert(reflectText.includes("GATE-REF-003 progress repair:"), "reflect repair packet includes GATE-REF-003 progress guidance");
  assert(reflectText.includes("GATE-REF-004 KB repair:"), "reflect repair packet includes GATE-REF-004 KB guidance");
  assert(reflectText.includes("Do not edit `state.json.close_signals`"), "reflect repair packet forbids generated close-signal edits");
  assert(reflectText.includes("close_signals.mjs explain --plan plan_hotspot_reflect --json"), "reflect repair packet names close_signals diagnostic");

  const tmp = mkdtempSync(join(tmpdir(), "planner-hotspot-pte-"));
  const planDir = join(tmp, "plans", "plan_hotspot_plan");
  try {
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "plan.md"), [
      "# Plan",
      "",
      "## Goal",
      "Hotspot repair guidance fixture.",
      "",
      "## Success Criteria",
      "1. sc_1 - fixture criterion.",
      "",
      "## Verification Strategy",
      "| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |",
      "|---|---|---|---|---|---|---|",
      "| sc_1 | US-077 | fixture | proof:planner_smoke | fixture | PASS | None |",
      "",
    ].join("\n"));
    const planText = packetText(buildGateRepairPacket({
      planDir,
      planDirName: "plan_hotspot_plan",
      gateName: "plan-to-execute",
      results: [
        { status: "FAIL", code: "GATE-PLN-016", name: "Success criteria have explicit story linkage", detail: "missing story linkage" },
        { status: "FAIL", code: "GATE-PLN-017", name: "Context-sensitive verification matrix is defined", detail: "missing proof type" },
      ],
    }));
    assert(planText.includes("GATE-PLN-016 story-linkage repair:"), "plan repair packet includes GATE-PLN-016 story guidance");
    assert(planText.includes("GATE-PLN-017 verification-matrix repair:"), "plan repair packet includes GATE-PLN-017 matrix guidance");
    assert(planText.includes("proof:migration_parity"), "plan repair packet names recognized migration/parity proof IDs");
    assert(planText.includes("verification_matrix.mjs lint --plan plan_hotspot_plan --json"), "plan repair packet names matrix lint command");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioCloseTimeHotspotGuidance() {
  const closeText = packetText(buildGateRepairPacket({
    planDirName: "plan_hotspot_close",
    gateName: "validate-to-close",
    results: [
      { status: "FAIL", code: "GATE-VAL-012", name: "Required deliverables have substantive evidence or approved waiver", detail: "Intent-driven deliverables still missing evidence or waiver: report" },
      { status: "FAIL", code: "GATE-VAL-013", name: "Remediation work records an anti-recurrence guard or approved waiver", detail: "Remediation-style work detected (bug) but no anti-recurrence guard evidence or waiver was recorded" },
      { status: "FAIL", code: "GATE-SEM-001", name: "Semantic: validate → close", detail: "Blocked: registry_tampered" },
    ],
  }));
  assert(closeText.includes("GATE-VAL-012 deliverable-evidence repair:"), "close repair packet includes GATE-VAL-012 deliverable guidance");
  assert(closeText.includes("GATE-VAL-013 anti-recurrence repair:"), "close repair packet includes GATE-VAL-013 anti-recurrence guidance");
  assert(closeText.includes("GATE-SEM-001 semantic-substrate repair:"), "close repair packet includes GATE-SEM-001 semantic guidance");
  assert(closeText.includes("Anti-Recurrence Guard"), "anti-recurrence repair names the required verification.md section");
  assert(closeText.includes("registry_hash"), "semantic repair names registry_hash refresh path");
  assert(closeText.includes("close_signals.mjs explain --plan plan_hotspot_close --json"), "close repair packet names close_signals diagnostic");

  const planningOnlyGeneric = packetText(buildGateRepairPacket({
    planDirName: "plan_hotspot_close",
    gateName: "validate-to-close",
    planningOnly: true,
    results: [{ status: "FAIL", code: "GATE-VAL-013", name: "Planning diagnostic", detail: "fixture" }],
  }));
  assert(planningOnlyGeneric.includes("verify_gate.mjs validate-to-close --plan plan_hotspot_close --planning-only"), "planning-only generic repair retains the scoped verifier diagnostic");

  const planningOnlyExplore = packetText(buildGateRepairPacket({
    planDirName: "plan_hotspot_explore",
    gateName: "explore-to-plan",
    planningOnly: true,
    results: [{ status: "FAIL", code: "GATE-EXP-001", name: "Planning diagnostic", detail: "fixture" }],
  }));
  assert(planningOnlyExplore.includes("verify_gate.mjs explore-to-plan --plan plan_hotspot_explore --planning-only"), "planning-only explore repair retains the scoped verifier diagnostic");
}

function scenarioCloseTimePlanHotspotGuidance() {
  const closeText = packetText(buildGateRepairPacket({
    planDirName: "plan_hotspot_new_codes",
    gateName: "validate-to-close",
    results: [
      { status: "FAIL", code: "GATE-EXP-010", name: "KB read proof", detail: "Missing KB digest salt" },
      { status: "FAIL", code: "GATE-PLN-017", name: "Context-sensitive verification matrix is defined", detail: "Missing context matrix" },
      { status: "FAIL", code: "GATE-PLN-020", name: "Task profile and semantic upkeep contract are fully documented", detail: "Semantic Upkeep Contract missing concrete values" },
      { status: "FAIL", code: "GATE-PLN-021", name: "Plan references KB learnings via [KB_APPLIED] or [KB_NOT_APPLICABLE] tag", detail: "KB tag missing" },
      { status: "FAIL", code: "GATE-VAL-022", name: "Incident repair closeout is fail-closed when an incident contract is required", detail: "Incident closeout missing required preflight rows" },
    ],
  }));
  assert(closeText.includes("GATE-EXP-010 KB-digest repair:"), "close repair packet includes GATE-EXP-010 KB digest guidance");
  assert(closeText.includes("findings_ledger.json") && closeText.includes("[KB_DIGEST:<salt>]"), "EXP-010 guidance names the missing KB digest artifact");
  assert(closeText.includes("GATE-PLN-017 verification-matrix repair:"), "close repair packet includes GATE-PLN-017 matrix guidance");
  assert(closeText.includes("plan.md -> ## Verification Strategy"), "PLN-017 guidance names the exact plan section");
  assert(closeText.includes("GATE-PLN-020 semantic-upkeep repair:"), "close repair packet includes GATE-PLN-020 semantic upkeep guidance");
  assert(closeText.includes("plan.md -> ## Semantic Upkeep Contract"), "PLN-020 guidance names the exact plan section");
  assert(closeText.includes("GATE-PLN-021 KB-tag repair:"), "close repair packet includes GATE-PLN-021 KB tag guidance");
  assert(closeText.includes("[KB_APPLIED:<id>]") && closeText.includes("[KB_NOT_APPLICABLE:<reason>]"), "PLN-021 guidance names the exact KB tag shapes");
  assert(closeText.includes("evidence_preflight.mjs check --plan plan_hotspot_new_codes --gate GATE-EXP-010 --json"), "EXP-010 guidance names preflight command");
  assert(closeText.includes("verification_matrix.mjs lint --plan plan_hotspot_new_codes --json"), "PLN-017 guidance names matrix lint command");
  assert(closeText.includes("evidence_preflight.mjs check --plan plan_hotspot_new_codes --gate GATE-PLN-020 --json"), "PLN-020 guidance names preflight command");
  assert(closeText.includes("evidence_preflight.mjs check --plan plan_hotspot_new_codes --gate GATE-PLN-021 --json"), "PLN-021 guidance names preflight command");
  assert(closeText.includes("GATE-VAL-022 incident-closeout repair:"), "close repair packet includes GATE-VAL-022 incident closeout guidance");
  assert(closeText.includes("incident_contract.json"), "VAL-022 guidance names the missing incident contract artifact");
  assert(closeText.includes("verification.md -> ## Incident Closeout"), "VAL-022 guidance names the exact verification section");
  assert(closeText.includes("evidence_preflight.mjs check --plan plan_hotspot_new_codes --gate GATE-VAL-022 --json"), "VAL-022 guidance names preflight command");
}

// Scenario 3: paste-template rejection
// Locks the behaviour that an agent who pastes the gate_templates/<id>.json
// paste_template VERBATIM (without filling the <placeholder> markers) FAILS
// the same gate. Without this, the scaffold is a rubber stamp — exactly the
// failure mode the universal-scaffold proposal warned against.
function scenarioPasteTemplateRejection() {
  const template = loadGateRepairTemplate("GATE-ETR-008");
  if (!template) {
    assert(false, "GATE-ETR-008 template must load before paste-template rejection runs");
    return;
  }
  const pasteBody = (template.paste_template || []).join("\n");
  if (!pasteBody.trim()) {
    assert(false, "GATE-ETR-008 template has empty paste_template");
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "planner-paste-template-"));
  const planDir = join(tmp, "plans", "plan_paste_template");
  try {
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] fixture\n");
    // Three vectors, each with the paste_template content verbatim — what a
    // lazy agent would produce after seeing the scaffold output.
    const vectors = [1, 2, 3].map((n) => `## Vector ${n}: Pasted scaffold ${n}\n${pasteBody}`);
    writeFileSync(join(planDir, "red_team_notes.md"), vectors.join("\n\n"));

    const results = gateExecuteToReflect(planDir);
    const depth = results.find((r) => r.code === "GATE-ETR-008");
    assert(!!depth, "GATE-ETR-008 result entry produced for paste-template fixture");
    assert(
      depth?.status === "WARN" && depth?.advisory_conversion === true,
      `paste-template fixture WARNS on GATE-ETR-008 (got ${depth?.status}: ${(depth?.detail || "").slice(0, 120)})`
    );
    assert(
      typeof depth?.detail === "string" && depth.detail.toLowerCase().includes("placeholder"),
      "WARN detail mentions placeholder content so agents understand the advisory"
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Scenario 4: [FILL: ...] markers in any required section reject the gate
// Locks the second placeholder shape recommended in the universal-scaffold
// proposal. Different mechanism from <angle-bracket> placeholders, same goal.
function scenarioFillMarkerRejection() {
  const tmp = mkdtempSync(join(tmpdir(), "planner-fill-marker-"));
  const planDir = join(tmp, "plans", "plan_fill_marker");
  try {
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] fixture\n");
    const vector = [
      "**Attack**: [FILL: 1-paragraph adversarial scenario]",
      "",
      "**Impact**: [FILL: production consequence]",
      "",
      "**Mitigation**:",
      "1. [FILL: existing defense; cite file or test]",
    ].join("\n");
    const vectors = [1, 2, 3].map((n) => `## Vector ${n}: Fill-marker clone\n${vector}`);
    writeFileSync(join(planDir, "red_team_notes.md"), vectors.join("\n\n"));

    const results = gateExecuteToReflect(planDir);
    const depth = results.find((r) => r.code === "GATE-ETR-008");
    assert(
      depth?.status === "WARN" && depth?.advisory_conversion === true,
      `[FILL: ...] markers WARN on GATE-ETR-008 (got ${depth?.status})`
    );
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function scenarioTrailingAnglePlaceholderRejection() {
  // A bare "<...>" placeholder decorated with ANY trailing punctuation run is an
  // evasion, not real prose. The earlier fix only tolerated a single ".!?"; these
  // variants (comma, semicolon, colon, ellipsis, mixed) must all still FAIL.
  const trailers = [".", ",", ";", ":", "...", " .", "?!"];
  for (const trail of trailers) {
    const body = [
      `Attack: <one-paragraph adversarial scenario; name trigger, input, and fault>${trail}`,
      "",
      "Impact: This copied placeholder can look filled because punctuation makes the template marker evade a too-narrow bare-angle detector.",
      "",
      "Mitigation: The analyzer should still classify the attack section as placeholder content and require a real scenario.",
    ].join("\n");
    const depth = runDepthCheckForVectorBody(body, `Trailing placeholder '${trail}'`);
    assert(
      depth?.status === "WARN" && depth?.advisory_conversion === true,
      `trailing angle-bracket placeholder '${trail}' WARNS on GATE-ETR-008 (got ${depth?.status})`
    );
    assert(
      String(depth?.detail || "").toLowerCase().includes("placeholder"),
      `trailing placeholder '${trail}' failure detail mentions placeholder content`
    );
  }
}

function scenarioKeywordSaladRejection() {
  const repeated = "auth bypass token replay auth bypass token replay";
  const body = [
    `Attack: ${repeated}`,
    "",
    `Impact: ${repeated}`,
    "",
    `Mitigation: ${repeated}`,
  ].join("\n");
  const depth = runDepthCheckForVectorBody(body, "Repeated token salad");
  assert(
    depth?.status === "WARN" && depth?.advisory_conversion === true,
    `repeated-token keyword salad WARNS on GATE-ETR-008 (got ${depth?.status})`
  );
  assert(
    String(depth?.detail || "").toLowerCase().includes("unique words"),
    "keyword-salad failure detail mentions unique-word depth"
  );
}

async function scenarioGuidanceReminderContractAndGatePreparation() {
  let helper = null;
  try {
    helper = await import("../scripts/lib/guidance_reminder.mjs");
  } catch {
    // Failing-first: the shared reminder helper lands after these assertions.
  }
  assert(typeof helper?.buildGuidanceReminder === "function", "shared guidance reminder builder exists");
  assert(typeof helper?.renderGuidanceReminder === "function", "shared guidance reminder renderer exists");
  if (typeof helper?.buildGuidanceReminder === "function") {
    const reminder = helper.buildGuidanceReminder({
      triggered: true,
      surface: "fixture",
      reason: "fixture_gap",
      nextCommand: "node fixture.mjs --repair",
      why: "One deterministic fixture gap remains.",
    });
    assert(reminder?.next_command === "node fixture.mjs --repair", "reminder contract publishes the exact NEXT command");
    assert(reminder?.why === "One deterministic fixture gap remains.", "reminder contract publishes a concise WHY");
    assert(reminder?.authority?.advisory_only === true, "reminder contract declares advisory-only authority");
    assert(reminder?.authority?.adds_gate_obligation === false, "reminder contract cannot add gate obligations");
    assert(helper.buildGuidanceReminder({ triggered: false, nextCommand: "node fixture.mjs", why: "unused" }) === null, "untriggered reminder is null");
    assert(helper.buildGuidanceReminder({ triggered: true, nextCommand: "", why: "missing command" }) === null, "incomplete reminder is null");
    const rendered = helper.renderGuidanceReminder(reminder);
    assert(rendered.includes("Guidance available") && rendered.includes("NEXT: node fixture.mjs --repair") && rendered.includes("WHY:  One deterministic fixture gap remains."), "human reminder uses the guidance-toned NEXT/WHY form");
  }

  const tmp = mkdtempSync(join(tmpdir(), "planner-gate-guidance-"));
  const planDir = join(tmp, "plans", "plan_gate_guidance");
  try {
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "state.json"), JSON.stringify({ state: "EXPLORE", goal: "Prepare a deterministic fixture" }, null, 2) + "\n");
    writeFileSync(join(planDir, "plan.md"), "# Plan\n\n## Goal\nPrepare a deterministic fixture.\n");
    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        { id: "F-001", summary: "First concrete fixture finding", detail: "The first production-path observation is recorded." },
        { id: "F-002", summary: "Second concrete fixture finding", detail: "The second production-path observation is recorded." },
      ],
    }, null, 2) + "\n");
    const unresolved = buildGatePreparationResult({ cwd: tmp, gate: "explore-to-plan", planArg: "plan_gate_guidance", write: false });
    assert(unresolved.status === "needs_preparation", "gate_prepare fixture has an unresolved dry-run gap");
    assert(unresolved.advisory_reminder?.next_command === "node .agent/skills/iterative-planner/scripts/gate_prepare.mjs explore-to-plan --plan plan_gate_guidance --write", "unresolved gate preparation publishes its exact write command");
    assert(String(unresolved.advisory_reminder?.why || "").includes("1 deterministic preparation item"), "unresolved gate preparation explains the missing-item count");

    writeFileSync(join(planDir, "findings_ledger.json"), JSON.stringify({
      version: 1,
      findings: [
        { id: "F-001", summary: "First concrete fixture finding", detail: "The first production-path observation is recorded." },
        { id: "F-002", summary: "Second concrete fixture finding", detail: "The second production-path observation is recorded." },
        { id: "F-003", summary: "Third concrete fixture finding", detail: "The third production-path observation is recorded." },
      ],
    }, null, 2) + "\n");
    const clean = buildGatePreparationResult({ cwd: tmp, gate: "explore-to-plan", planArg: "plan_gate_guidance", write: false });
    assert(clean.ok === true, "gate_prepare clean control passes");
    assert(clean.advisory_reminder === null, "clean gate preparation emits no reminder");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

scenarioRendererModes();
scenarioGateEtr008Packet();
scenarioTargetHotspotGuidance();
scenarioCloseTimeHotspotGuidance();
scenarioCloseTimePlanHotspotGuidance();
scenarioPasteTemplateRejection();
scenarioFillMarkerRejection();
scenarioTrailingAnglePlaceholderRejection();
scenarioKeywordSaladRejection();
await scenarioGuidanceReminderContractAndGatePreparation();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
