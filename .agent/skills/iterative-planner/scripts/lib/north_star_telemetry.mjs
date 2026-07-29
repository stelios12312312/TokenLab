// north_star_telemetry.mjs — t07 North Star telemetry serializer.
//
// Before t07 the North Star flow (02_north_star.md §2) was design-only: nothing
// emitted metric_actual, so a quant plan passed by DECLARING IC>0.05, never by
// MEASURING it. This scans reports/backtests/*.json (+ coverage) and emits
// metric_actual/3 facts so invariants.pl can compare measured-vs-threshold.
//
// The Prolog interpreter (scripts/lib/prolog.mjs) is integer-only, so metric
// values AND manifesto thresholds are scaled by SCALE before being asserted.
// Comparison is per-metric, so a single uniform scale is safe.

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, isAbsolute } from "path";

export const SCALE = 1_000_000;

export function scaleMetric(value) {
  return Math.round(Number(value) * SCALE);
}

function quote(str) {
  return `'${String(str || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Pull a metric value out of a backtest JSON object: top-level, under .metrics,
// or under .coverage. Returns a finite number or null.
function extractMetric(obj, metricId) {
  for (const container of [obj, obj?.metrics, obj?.coverage]) {
    if (container && typeof container === "object" && typeof container[metricId] === "number" && Number.isFinite(container[metricId])) {
      return container[metricId];
    }
  }
  return null;
}

// Scan <cwd>/reports/backtests/*.json and emit metric_actual(Id, Scaled, Source)
// facts for each manifesto metric id found. `metricIds` restricts which metrics
// are emitted (the manifesto's core_metric ids); empty/undefined = emit all
// numeric top-level/metrics/coverage keys.
export function collectMetricActualFacts({ cwd = process.cwd(), metricIds = null, dir = join("reports", "backtests") } = {}) {
  const facts = [];
  const base = isAbsolute(dir) ? dir : join(cwd, dir);
  let entries = [];
  try {
    entries = readdirSync(base).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    return facts; // no reports/backtests — nothing measured
  }
  const wanted = Array.isArray(metricIds) && metricIds.length ? new Set(metricIds) : null;
  const seen = new Set(); // first file wins per metric (deterministic)
  for (const name of entries.sort()) {
    const full = join(base, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch { continue; }
    let obj;
    try {
      obj = JSON.parse(readFileSync(full, "utf-8"));
    } catch { continue; }
    if (!obj || typeof obj !== "object") continue;

    const candidateIds = wanted
      ? [...wanted]
      : [...new Set([
          ...Object.keys(obj),
          ...Object.keys(obj.metrics || {}),
          ...Object.keys(obj.coverage || {}),
        ])];
    for (const metricId of candidateIds) {
      if (seen.has(metricId)) continue;
      const value = extractMetric(obj, metricId);
      if (value === null) continue;
      seen.add(metricId);
      facts.push(`metric_actual(${quote(metricId)}, ${scaleMetric(value)}, ${quote(join(dir, name))}).`);
    }
  }
  return facts;
}
