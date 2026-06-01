#!/usr/bin/env node
// test_red_team_depth_gate.mjs — Ensure execute-to-reflect grades red-team
// vectors semantically instead of by arbitrary line wrapping.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gateExecuteToReflect } from "../scripts/verify_gate.mjs";

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

const tmp = mkdtempSync(join(tmpdir(), "planner-red-team-depth-"));
const planDir = join(tmp, "plan");

try {
  mkdirSync(planDir, { recursive: true });

  writeFileSync(join(planDir, "progress.md"), "# Progress\n\n## Completed\n- [x] Cleanup complete\n");
  writeFileSync(join(planDir, "verification.md"), "# Verification\n\n## Test Drift Scan\nCovered.\n");
  writeFileSync(join(planDir, "red_team_notes.md"), `# Red-Team Adversarial Analysis
Intro line 1.
Intro line 2.
Intro line 3.

## Vector 1: Root docs drift
Attack: Update semantic doc loading but forget ripple wiring.
Impact: Setup output disagrees with invariant output.
Mitigation: Keep both surfaces under the same regression test.
Extra evidence: This class of drift already appeared in the audit.
Residual risk: Low once both paths are covered.

## Vector 2: State surface divergence
Attack: Leave state.md stale while state.json advances.
Impact: Operators see the wrong phase and make the wrong next move.
Mitigation: Read state.json canonically and sync state.md during transitions.
Extra evidence: bootstrap status reproduced the mismatch locally.
Residual risk: Low after canonical-state coverage landed.

## Vector 3: Path quoting regression
Attack: Use shell-quoted subprocess commands on a path with spaces or parentheses.
Impact: Upgrade emits partial warnings and skips circuit-breaker seeding.
Mitigation: Use argv-based subprocess calls and keep a quoted-path regression test.
Extra evidence: The migration suite reproduced the bug before the cleanup fix.
Residual risk: Low once the regression test stays green.
`);

  let results = gateExecuteToReflect(planDir);
  let depthCheck = results.find((result) => result.code === "GATE-ETR-008");

  assert(!!depthCheck, "red-team depth check is present");
  assert(depthCheck?.status === "PASS", "red-team depth check ignores the preamble and passes substantive vectors");

  writeFileSync(join(planDir, "red_team_notes.md"), `# Red-Team Adversarial Analysis

## Vector 1: Inline labels still count
**Attack**: Planner-generated bold inline labels should not fail just because they fit on one line.
**Impact**: Agents waste time inserting fake line breaks instead of improving the actual adversarial analysis.
**Mitigation**: Parse Attack, Impact, and Mitigation sections semantically so substantive single-line entries pass.

## Vector 2: Plain labels also count
Attack: A reviewer writes concise but specific sections without extra bullets or spacer lines.
Impact: The gate reports a fake shallow-vector failure and hides the real quality signal from the author.
Mitigation: Enforce minimum section substance with word floors and placeholder detection rather than raw line counting.

## Vector 3: Heading-style sections still count
### Attack
The author prefers subsection headings for readability and keeps each section short but concrete.
### Impact
Formatting style becomes the blocker even though the risk analysis itself is complete and useful.
### Mitigation
Accept heading-style labels in the shared parser and keep the documentation explicit about the supported formats.
`);

  results = gateExecuteToReflect(planDir);
  depthCheck = results.find((result) => result.code === "GATE-ETR-008");
  assert(depthCheck?.status === "PASS", "bold-inline, plain-label, and heading-style vectors all pass when the content is substantive");

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

  results = gateExecuteToReflect(planDir);
  depthCheck = results.find((result) => result.code === "GATE-ETR-008");
  assert(depthCheck?.status === "FAIL", "template, missing-section, and terse vectors still fail the depth gate");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
