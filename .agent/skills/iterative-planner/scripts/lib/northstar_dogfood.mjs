// northstar_dogfood.mjs — T-INTAKE-E14EBBAE: build the North-Star UI dogfood payload
// from the REAL backend (no mock). A known-bad input (declared IC>0.05, measured 0.02)
// is driven through the real chain: manifesto → north-star facts → metric_actual facts →
// invariants.pl I-032 → invariant_violated(north_star_metric_failed) → live visualizer
// payload. The visualizer fixture and the Playwright dogfood both consume THIS output, so
// the cockpit renders a verdict the real engine produced, not a hand-written one.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createSession } from "./prolog.mjs";
import { normalizePlannerManifesto, buildNorthStarFacts } from "./planner_manifesto.mjs";
import { collectMetricActualFacts } from "./north_star_telemetry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, "..", "..");                 // iterative-planner
const repoRootDefault = resolve(skillRoot, "..", "..", "..");
const INVARIANTS = join(skillRoot, "prolog", "invariants.pl");

// Run the real engine on the known-bad fixture and return the genuine violation(s).
export function computeNorthStarDogfoodViolations({
  metricId = "information_coefficient",
  threshold = "> 0.05",
  measured = 0.02,
} = {}) {
  const manifesto = normalizePlannerManifesto({
    version: 2,
    north_star_type: "quant_alpha",
    hard_policy_mode: "hard",
    core_metrics: [{ id: metricId, threshold, scope: "final_out_of_sample" }],
    invariant_directives: [{ id: "metrics_must_be_measured", severity: "hard" }],
  });
  const nsFacts = buildNorthStarFacts(manifesto).facts;

  const tmp = mkdtempSync(join(tmpdir(), "northstar-dogfood-"));
  let metricFacts = [];
  try {
    mkdirSync(join(tmp, "reports", "backtests"), { recursive: true });
    writeFileSync(join(tmp, "reports", "backtests", "final_oos.json"), JSON.stringify({ [metricId]: measured }));
    metricFacts = collectMetricActualFacts({ cwd: tmp, metricIds: [metricId] });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const session = createSession();
  for (const f of [...nsFacts, ...metricFacts]) session.consult(f);
  session.consult(readFileSync(INVARIANTS, "utf-8"));

  const violations = [];
  for (const ans of session.query("invariant_violated(north_star_metric_failed, Metric)")) {
    violations.push({
      id: "north_star_metric_failed",
      severity: "fail",
      message: `north_star_metric_failed: ${String(ans.Metric)} measured ${measured} below declared threshold ${threshold}`,
      metric: String(ans.Metric),
    });
  }
  return violations;
}

// Build the full visualizer payload with the real North-Star violation injected.
export function buildNorthStarDogfoodPayload({ repoRoot = repoRootDefault } = {}) {
  const violations = computeNorthStarDogfoodViolations();
  // Imported lazily so the skill test can run even if the app dir is absent.
  return import(resolve(repoRoot, "apps/ive-visualizer/scripts/generate-live-payload.mjs"))
    .then(({ generateLiveGraphPayload }) => ({
      violations,
      payload: generateLiveGraphPayload({
        repoRoot,
        generatedAt: "2026-06-03T00:00:00.000Z",
        invariantResult: { status: "fail", count: violations.length, violations },
      }),
    }));
}
