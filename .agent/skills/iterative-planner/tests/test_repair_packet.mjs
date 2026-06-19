#!/usr/bin/env node
// test_repair_packet.mjs - Format-lock universal repair packet scaffolds.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadGateRepairTemplate,
  normalizeScaffoldMode,
  renderRepairPacket,
} from "../scripts/lib/repair_packet.mjs";
import {
  buildGateRepairPacket,
  gateExecuteToReflect,
} from "../scripts/verify_gate.mjs";

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

  const full = packetText(renderRepairPacket({
    template,
    title: "Red-team vectors have content depth",
    whatMissing: ["Vector 1: missing Attack, Impact, Mitigation"],
    env: { PLANNER_SCAFFOLDS: "on" },
  }));
  assert(full.includes("[GATE-ETR-008] Red-team vectors have content depth"), "full packet starts with gate id and title");
  assert(full.includes("-- What's missing --"), "full packet includes missing section");
  assert(full.includes("-- Accepted patterns --"), "full packet includes accepted patterns section");
  assert(full.includes("`**Attack**:`"), "full packet shows colon outside bold as accepted");
  assert(full.includes("NOT accepted") && full.includes("`**Attack:**`"), "full packet warns about colon inside bold");
  assert(full.includes("-- Paste this into each shallow vector --"), "full packet includes paste template section");
  assert(full.includes("-- Worked example --"), "full packet includes worked example section");
  assert(full.includes("-- Auto-fix --"), "full packet includes auto-fix section");
  assert(full.includes("-- Retry --"), "full packet includes retry section");

  const examplesOnly = packetText(renderRepairPacket({
    template,
    title: "Red-team vectors have content depth",
    whatMissing: ["Vector 1: missing Attack"],
    env: { PLANNER_SCAFFOLDS: "examples-only" },
  }));
  assert(!examplesOnly.includes("-- Paste this into each shallow vector --"), "examples-only omits paste template");
  assert(examplesOnly.includes("-- Worked example --"), "examples-only keeps worked example");

  const off = packetText(renderRepairPacket({
    template,
    title: "Red-team vectors have content depth",
    whatMissing: ["Vector 1: missing Attack"],
    env: { PLANNER_SCAFFOLDS: "off" },
  }));
  assert(off.includes("Repair scaffolds disabled"), "off mode reports disabled scaffolds");
  assert(!off.includes("-- Accepted patterns --"), "off mode omits scaffold sections");
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
    assert(depth?.status === "FAIL", "fixture fails GATE-ETR-008");

    const text = packetText(buildGateRepairPacket({
      planDir,
      planDirName: "plan_repair_packet",
      gateName: "execute-to-reflect",
      results,
    }));
    assert(text.includes("[GATE-ETR-008]"), "gate packet uses the GATE-ETR-008 scaffold");
    assert(text.includes("Vector 1: [TBD]"), "gate packet names shallow vector titles");
    assert(text.includes("title still uses placeholder text"), "gate packet includes analyzer diagnostics");
    assert(text.includes("`**Attack**:`"), "gate packet includes accepted bold label shape");
    assert(text.includes("`**Attack:**`"), "gate packet includes rejected bold-colon warning");
    assert(text.includes("examples/passing/GATE-ETR-008.md"), "gate packet points at worked example");
    assert(text.includes("transition.mjs execute-to-reflect"), "gate packet names retry transition");
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
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
      depth?.status === "FAIL",
      `paste-template fixture FAILS GATE-ETR-008 (got ${depth?.status}: ${(depth?.detail || "").slice(0, 120)})`
    );
    assert(
      typeof depth?.detail === "string" && depth.detail.toLowerCase().includes("placeholder"),
      "FAIL detail mentions placeholder content so agents understand why they failed"
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
      depth?.status === "FAIL",
      `[FILL: ...] markers FAIL GATE-ETR-008 (got ${depth?.status})`
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
      depth?.status === "FAIL",
      `trailing angle-bracket placeholder '${trail}' FAILS GATE-ETR-008 (got ${depth?.status})`
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
    depth?.status === "FAIL",
    `repeated-token keyword salad FAILS GATE-ETR-008 (got ${depth?.status})`
  );
  assert(
    String(depth?.detail || "").toLowerCase().includes("unique words"),
    "keyword-salad failure detail mentions unique-word depth"
  );
}

scenarioRendererModes();
scenarioGateEtr008Packet();
scenarioPasteTemplateRejection();
scenarioFillMarkerRejection();
scenarioTrailingAnglePlaceholderRejection();
scenarioKeywordSaladRejection();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
