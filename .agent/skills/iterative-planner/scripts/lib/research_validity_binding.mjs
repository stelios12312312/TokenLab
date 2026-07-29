// research_validity_binding.mjs — deterministic Metric.validity_class seam.
//
// The binding table is intentionally tiny and class-only. Metric context can
// shape gate input after dispatch, but it cannot select a different gate.

import { existsSync, readFileSync } from "fs";
import { isAbsolute, resolve } from "path";

import { evaluateCalibration } from "../../packs/quant/calibration_gate.mjs";
import { evaluateForecastability } from "../../packs/quant/forecastability.mjs";
import { evaluateLeakageProofArtifact } from "../../packs/quant/leakage_proof.mjs";

const FROZEN_BINDINGS = Object.freeze({
  temporal_holdout: Object.freeze({
    gate_fn: "evaluateLeakageProofArtifact",
    suite_id: "quant-leakage-artifact",
  }),
  walk_forward: Object.freeze({
    gate_fn: "evaluateLeakageProofArtifact",
    suite_id: "quant-leakage-artifact",
  }),
  calibration: Object.freeze({
    gate_fn: "evaluateCalibration",
    suite_id: "quant-calibration-gate",
  }),
  forecastability: Object.freeze({
    gate_fn: "evaluateForecastability",
    suite_id: "quant-forecastability-pregates",
  }),
  none: Object.freeze({
    gate_fn: null,
    suite_id: null,
  }),
});

export const VALIDITY_CLASS_BINDINGS = Object.freeze({ ...FROZEN_BINDINGS });

export const RESERVED_VALIDITY_CLASSES = Object.freeze([
  "multiple_testing",
  "cost_realism",
  "regime",
]);

const RESERVED_CLASS_SET = new Set(RESERVED_VALIDITY_CLASSES);
const CLOSED_DOMAIN_VOCAB = new Set(["domain_free", "generic", "betting", "crypto", "tokenomics"]);
const CLOSED_TASK_TYPE_VOCAB = new Set([
  "regression",
  "classification",
  "probability",
  "probabilistic",
  "calibration",
  "time_series",
  "forecast",
  "forecasting",
  "ranking",
]);

const DEFAULT_GATE_REGISTRY = Object.freeze({
  evaluateLeakageProofArtifact,
  evaluateCalibration,
  evaluateForecastability,
});

function normalizeClass(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function fail(code, detail = code, extra = {}) {
  return {
    pass: false,
    validity_verdict: "fail",
    verdict: "fail",
    code,
    detail,
    blocker_codes: [code],
    ...extra,
  };
}

function passNoGate(extra = {}) {
  return {
    pass: true,
    validity_verdict: "pass",
    verdict: "pass",
    code: "metric_validity_not_required",
    blocker_codes: [],
    ...extra,
  };
}

function evidenceRef(metric) {
  return metric.validity_evidence_ref
    ?? metric.evidence_ref
    ?? asObject(metric.validity_evidence).artifact
    ?? asObject(metric.evidence).artifact
    ?? null;
}

function evidenceFromMap(ref, evidenceArtifacts = {}) {
  if (!ref || typeof ref !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(evidenceArtifacts, ref)) return evidenceArtifacts[ref];
  if (Object.prototype.hasOwnProperty.call(evidenceArtifacts, `#${ref}`)) return evidenceArtifacts[`#${ref}`];
  return null;
}

function resolveEvidenceArtifact(metric, { baseDir = null, evidenceArtifacts = {} } = {}) {
  if (metric.validity_evidence && typeof metric.validity_evidence === "object") {
    return { ok: true, artifact: metric.validity_evidence, source: "metric.validity_evidence" };
  }

  const inlineMap = {
    ...asObject(metric.evidence_artifacts),
    ...asObject(metric.validity_evidence_artifacts),
    ...asObject(evidenceArtifacts),
  };
  const ref = evidenceRef(metric);
  if (!nonEmpty(ref)) {
    return { ok: false, code: "metric_validity_verdict_missing", detail: "Metric validity evidence artifact reference is missing" };
  }
  if (typeof ref === "object") {
    return { ok: true, artifact: ref, source: "inline_ref" };
  }

  const mapped = evidenceFromMap(String(ref), inlineMap);
  if (mapped !== null && mapped !== undefined) {
    return { ok: true, artifact: mapped, source: `map:${ref}` };
  }

  const raw = String(ref).trim();
  const candidates = isAbsolute(raw)
    ? [raw]
    : [
        baseDir ? resolve(baseDir, raw) : null,
        resolve(process.cwd(), raw),
      ].filter(Boolean);
  const path = candidates.find((candidate) => existsSync(candidate)) || null;
  if (!path) {
    return {
      ok: false,
      code: "metric_validity_verdict_missing",
      detail: `Metric validity evidence artifact not found: ${raw}`,
    };
  }
  try {
    return { ok: true, artifact: JSON.parse(readFileSync(path, "utf-8")), source: path };
  } catch (error) {
    return {
      ok: false,
      code: "metric_validity_verdict_missing",
      detail: `Metric validity evidence artifact is not valid JSON: ${raw}: ${error?.message || "parse failed"}`,
    };
  }
}

function normalizeContext(metric, artifact) {
  const context = {
    ...asObject(artifact.validity_context),
    ...asObject(metric.validity_context),
  };
  const domain = normalizeClass(context.domain);
  const taskType = normalizeClass(context.task_type ?? artifact.task_type ?? metric.task_type);

  if (domain && !CLOSED_DOMAIN_VOCAB.has(domain)) {
    return { ok: false, code: "validity_context_domain_unknown", detail: `Unknown validity_context.domain '${domain}'` };
  }
  if (taskType && !CLOSED_TASK_TYPE_VOCAB.has(taskType)) {
    return { ok: false, code: "validity_context_task_type_unknown", detail: `Unknown validity_context.task_type '${taskType}'` };
  }

  return {
    ok: true,
    domain: domain || "domain_free",
    task_type: taskType || artifact.task_type || metric.task_type || null,
  };
}

function forecastabilityArtifactEmpty(artifact) {
  const doc = asObject(artifact);
  return Object.keys(doc).length === 0;
}

function gateInputFor(binding, metric, artifact) {
  const context = normalizeContext(metric, asObject(artifact));
  if (!context.ok) return context;

  if (binding.gate_fn === "evaluateCalibration") {
    const doc = asObject(artifact);
    return {
      ok: true,
      input: {
        domain: context.domain === "domain_free" || context.domain === "generic" ? "domain_free" : context.domain,
        task_type: context.task_type ?? doc.task_type ?? null,
        metrics_scored: doc.metrics_scored ?? metric.metrics_scored ?? [],
        metrics: asObject(doc.metrics ?? doc.measured_metrics ?? metric.metrics),
        backtest: asObject(doc.backtest),
      },
      context,
    };
  }

  if (binding.gate_fn === "evaluateForecastability") {
    if (forecastabilityArtifactEmpty(artifact)) {
      return {
        ok: false,
        code: "metric_validity_artifact_empty",
        detail: "Forecastability validity evidence is empty; empty input would pass vacuously",
      };
    }
    return { ok: true, input: asObject(artifact), context };
  }

  return { ok: true, input: asObject(artifact), context };
}

function blockerCodes(gateVerdict) {
  const blockers = Array.isArray(gateVerdict?.blockers) ? gateVerdict.blockers : [];
  const rejects = Array.isArray(gateVerdict?.rejects) ? gateVerdict.rejects : [];
  return [
    ...blockers.map((entry) => entry?.code || entry?.gate || entry?.kind || "blocker"),
    ...rejects.map((entry) => entry?.code || entry?.gate || entry?.kind || "reject"),
  ];
}

export function resolveMetricValidity(metric = {}, {
  baseDir = null,
  evidenceArtifacts = {},
  gateOverrides = {},
} = {}) {
  const doc = asObject(metric);
  const validityClass = normalizeClass(doc.validity_class);
  if (!validityClass) {
    return fail("metric_validity_class_missing", "Metric.validity_class is required");
  }
  if (RESERVED_CLASS_SET.has(validityClass)) {
    return fail("metric_validity_binding_missing", `Validity class '${validityClass}' is reserved until a gate exists`, {
      validity_class: validityClass,
    });
  }

  const binding = VALIDITY_CLASS_BINDINGS[validityClass] || null;
  if (!binding) {
    return fail("metric_validity_class_unknown", `Unknown validity_class '${validityClass}'`, {
      validity_class: validityClass,
    });
  }
  if (!binding.gate_fn) {
    return passNoGate({ validity_class: validityClass, suite_id: binding.suite_id, gate_fn: binding.gate_fn });
  }

  const evidence = resolveEvidenceArtifact(doc, { baseDir, evidenceArtifacts });
  if (!evidence.ok) {
    return fail(evidence.code, evidence.detail, {
      validity_class: validityClass,
      suite_id: binding.suite_id,
      gate_fn: binding.gate_fn,
    });
  }

  const input = gateInputFor(binding, doc, evidence.artifact);
  if (!input.ok) {
    return fail(input.code, input.detail, {
      validity_class: validityClass,
      suite_id: binding.suite_id,
      gate_fn: binding.gate_fn,
      evidence_source: evidence.source,
    });
  }

  const gate = gateOverrides[binding.gate_fn] || DEFAULT_GATE_REGISTRY[binding.gate_fn];
  if (typeof gate !== "function") {
    return fail("metric_validity_gate_unavailable", `Bound gate '${binding.gate_fn}' is unavailable`, {
      validity_class: validityClass,
      suite_id: binding.suite_id,
      gate_fn: binding.gate_fn,
      evidence_source: evidence.source,
    });
  }

  const boundGateVerdict = gate(input.input);
  const pass = boundGateVerdict?.pass === true;
  const validityVerdict = String(boundGateVerdict?.verdict || (pass ? "pass" : "fail"));
  const codes = blockerCodes(boundGateVerdict);
  return {
    pass,
    validity_verdict: validityVerdict,
    verdict: validityVerdict,
    code: pass ? "metric_validity_pass" : "metric_validity_failed",
    blocker_codes: pass ? [] : (codes.length ? codes : ["metric_validity_failed"]),
    validity_class: validityClass,
    suite_id: binding.suite_id,
    gate_fn: binding.gate_fn,
    evidence_source: evidence.source,
    validity_context: input.context,
    bound_gate_verdict: boundGateVerdict,
    authority: "bound_gate_verdict",
  };
}

export function validityClassRequiresEvidence(validityClass) {
  const normalized = normalizeClass(validityClass);
  return Boolean(VALIDITY_CLASS_BINDINGS[normalized]?.gate_fn);
}
