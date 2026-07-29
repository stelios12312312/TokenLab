// pack_severity.mjs — Shape-conditional severity downgrade for persona pack
// findings. v7.4.2: introduced after the Tennis incident showed traceability
// TR-005 was firing HIGH on every plan shape, including ones where the rule's
// concern wasn't relevant. Other packs have the same shape blindness; this
// helper applies the same downgrade pattern uniformly across packs.
//
// Usage from a pack's normalizeFinding(raw, context):
//
//   import { downgradeForShape } from "../../scripts/lib/pack_severity.mjs";
//   const severity = downgradeForShape({
//     ruleId: raw.ruleId,
//     defaultSeverity: raw.severity || "HIGH",
//     planShape: context?.planShape,
//     downgrades: { "RULE-X": ["feature", "refactor", "docs"] },
//   });
//
// Bug-fix / regression / migration / planner-core / unknown always keep their
// original severity (legacy strict default + diagnosis-shaped plans need it).

const LOW_SEVERITY = "LOW";

export function downgradeForShape({ ruleId, defaultSeverity, planShape, downgrades, target = LOW_SEVERITY }) {
  const original = defaultSeverity || "HIGH";
  if (!ruleId || !planShape) return original;
  const shapePrimary = String(planShape.primary || "").toLowerCase();
  if (!shapePrimary) return original;
  const map = downgrades || {};
  const allowedShapes = map[ruleId];
  if (!Array.isArray(allowedShapes) || allowedShapes.length === 0) return original;
  return allowedShapes.includes(shapePrimary) ? target : original;
}
