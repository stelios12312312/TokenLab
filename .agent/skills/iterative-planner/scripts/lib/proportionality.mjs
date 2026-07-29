// proportionality.mjs — the ceremony-to-substance signal.
//
// The planner has a 1,897-line thrash detector for gate RETRIES but nothing
// that notices an over-scoped plan: a 3,557-line plan dir generated for a
// ~150-line deliverable (the e03 calibration-bands case). The planner measured
// process COMPLIANCE but never process EFFICIENCY, so ceremony accreted
// silently. This surfaces it as an advisory — never a block — in the same
// spirit as the false-red counter: if planner bookkeeping dwarfs the work, say
// so, and point at the lightweight lane.

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Files inside a plan dir that the PLANNER generates as bookkeeping rather than
// the operator's authored thinking (plan.md / scope.json / verification.md /
// walkthrough.md). These dominate the line count of an over-scoped plan dir.
const MACHINE_GENERATED = [
  /^state\.json$/,
  /_facts\.pl$/,
  /^health_baseline\.json$/,
  /^persona_.*\.json$/,
  /_ledger\.json$/,
  /^findings\.json$/,
  /^ontology_.*\.(pl|json)$/,
];

function countLines(file) {
  try {
    const txt = readFileSync(file, "utf-8");
    return txt ? txt.split("\n").length : 0;
  } catch {
    return 0;
  }
}

// Sum the lines of machine-generated bookkeeping files present in a plan dir.
export function measurePlanScaffolding(planDir) {
  let lines = 0;
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(planDir);
  } catch {
    return { lines: 0, files: [] };
  }
  for (const name of entries) {
    if (!MACHINE_GENERATED.some((p) => p.test(name))) continue;
    const full = join(planDir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const n = countLines(full);
    lines += n;
    files.push({ name, lines: n });
  }
  files.sort((a, b) => b.lines - a.lines);
  return { lines, files };
}

// Pure verdict. `deliverableLines` may be null when the code change can't be
// measured; we then fall back to an absolute ceiling on scaffolding alone.
export function proportionalityVerdict({
  scaffoldingLines = 0,
  deliverableLines = null,
  ratioThreshold = 8,
  scaffoldingFloor = 400,
  absoluteCeiling = 2500,
} = {}) {
  const hasDeliverable = typeof deliverableLines === "number" && deliverableLines >= 0;
  let over = false;
  let ratio = null;
  let reason = null;
  if (hasDeliverable) {
    ratio = scaffoldingLines / Math.max(deliverableLines, 1);
    if (scaffoldingLines >= scaffoldingFloor && ratio >= ratioThreshold) {
      over = true;
      reason = `plan scaffolding (${scaffoldingLines} lines) is ${ratio.toFixed(1)}× the deliverable (${deliverableLines} lines)`;
    }
  } else if (scaffoldingLines >= absoluteCeiling) {
    over = true;
    reason = `plan scaffolding is ${scaffoldingLines} lines of planner bookkeeping`;
  }
  return {
    over_threshold: over,
    ratio,
    scaffolding_lines: scaffoldingLines,
    deliverable_lines: hasDeliverable ? deliverableLines : null,
    severity: over ? "advisory" : "ok",
    message: over
      ? `Ceremony check: ${reason}. For work this size prefer the lightweight flow, or a program ticket with child_plan.policy "lightweight".`
      : null,
  };
}
