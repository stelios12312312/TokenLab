#!/usr/bin/env node
// test_integrity_anchor.mjs — git-anchored config-integrity decision logic
// (ceremony-reduction T-INTAKE-93A622F8).

import { trackedFileIntegrityStatus } from "../scripts/lib/determinism.mjs";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}`); }
}

console.log("\nGit-anchored integrity tests\n");

// THE FIX: a committed edit (working tree == HEAD) is in-bounds even though its
// content no longer matches the frozen baseline — committing makes it reviewable,
// so it must not false-block a transition.
assert(
  trackedFileIntegrityStatus({ currentHash: "newhash", baselineHash: "oldbaseline", matchesHead: true }) === "in_bounds",
  "committed edit (matchesHead) is in-bounds even when it diverges from the frozen baseline"
);
assert(
  trackedFileIntegrityStatus({ currentHash: "x", baselineHash: null, matchesHead: true }) === "in_bounds",
  "committed file with no baseline entry is in-bounds"
);

// STILL CAUGHT: uncommitted working-tree drift that diverges from the baseline.
assert(
  trackedFileIntegrityStatus({ currentHash: "tampered", baselineHash: "oldbaseline", matchesHead: false }) === "tampered",
  "uncommitted change diverging from baseline is flagged as tampered"
);

// LEGACY / BACKWARD-COMPAT: uncommitted but still equal to the frozen baseline.
assert(
  trackedFileIntegrityStatus({ currentHash: "same", baselineHash: "same", matchesHead: false }) === "in_bounds",
  "uncommitted file still matching the frozen baseline is in-bounds"
);

// NO GIT (matchesHead === null): fall back to frozen-baseline comparison.
assert(
  trackedFileIntegrityStatus({ currentHash: "same", baselineHash: "same", matchesHead: null }) === "in_bounds",
  "no-git fallback: matches baseline is in-bounds"
);
assert(
  trackedFileIntegrityStatus({ currentHash: "drift", baselineHash: "same", matchesHead: null }) === "tampered",
  "no-git fallback: diverges from baseline is tampered"
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
