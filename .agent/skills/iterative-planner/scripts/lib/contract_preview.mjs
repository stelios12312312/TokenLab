// contract_preview.mjs — front-loaded contract preview for substantive planner contracts.
//
// The #1 cause of ritual is LATE FEEDBACK: the agent acts with no up-front contract, then
// discovers — only after running Prolog / a gate / CI — that the rules were not what it
// expected, and reworks. This surfaces the contract BEFORE the agent acts: the routing it
// should take, the META-RULES its planned files trigger (must-be-wired,
// namespace registration, ritual budget), and the invariant families that will be checked
// for its plan shape. Each item carries the requirement AND the consequence, so a later
// gate failure is never a surprise — it was previewed.

function norm(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.agent\/skills\/iterative-planner\//, "").replace(/^\.\//, "");
}

// Meta-rules: triggered by the SHAPE of the planned files, not by goal text. These are the
// rules that bit reactively this session — surfaced before the edit instead of after CI.
export function previewMetaRules(plannedFiles = []) {
  const files = (plannedFiles || []).map(norm).filter(Boolean);
  const rules = [];

  const newPackGates = files.filter((f) => /(^|\/)packs\/[^/]+\/(?!index\.mjs$|rules\.pl$)[^/]+\.mjs$/.test(f));
  if (newPackGates.length) {
    rules.push({
      id: "capability_must_be_wired",
      trigger: newPackGates,
      requirement: "A new pack capability module must be imported by a NON-TEST runtime consumer (e.g. quant_results_validation.mjs / fact_loader.mjs).",
      consequence: "Otherwise the capability-connectivity test fails (shelf-ware).",
    });
  }

  const prologEdits = files.filter((f) => /\.pl$/.test(f));
  if (prologEdits.length) {
    rules.push({
      id: "namespace_registration_required",
      trigger: prologEdits,
      requirement: "New Prolog rule-head predicates in bundled packs must be registered in config/ontology_namespace.json (predicate or prefix).",
      consequence: "Otherwise structural-contracts (ontology namespace) fails naming the unregistered predicate.",
    });
  }

  return rules;
}

// Ritual-budget rule (AC2, front-loaded): if triage routed the work light/skip, a heavy
// plan trips the ritual-budget gate. Stated BEFORE the agent spins up a full plan.
export function previewRitualBudget(triagePath) {
  const light = ["lightweight", "skip_planner", "skip_planner_question"].includes(triagePath);
  if (!light) return null;
  return {
    id: "ritual_budget",
    requirement: `Triage routed this as ${triagePath}. Use the lightweight lane (task.md + walkthrough.md, or child_plan.policy "lightweight").`,
    consequence: "A full heavy plan here will trip the ritual-budget gate (heavy scaffolding for light-routed work).",
  };
}

// Curated shape → invariant-family map (linked to references/rule-engine-guide.md). Tells
// the agent which checks WILL run for its shape, so it builds to satisfy them.
const SHAPE_INVARIANTS = {
  quant: [
    { family: "QU-007 / calibration bands", requires: "measured metrics within packs/quant/calibration.json bands (no too-good / impossibility tells)." },
    { family: "north_star_metric_failed (I-032)", requires: "measured North-Star metric meets the declared threshold (measure it, don't declare it)." },
    { family: "no_temporal_split (HR-004)", requires: "time_series work carries split-evidence (train/val/oos ranges, embargo) — not a keyword." },
    { family: "quant_results_validation", requires: "a quant_results_validation.json with run class, controls, leakage audit, promotion verdict." },
  ],
  "planner-core": [
    { family: "registry_tampered / gate registry", requires: "gate behavior changes stay in sync with config/gates.json + the generated Prolog facts." },
    { family: "program_child_plan_not_closed", requires: "verified program tickets have a closed (or lightweight-complete, or waived) child plan." },
    { family: "plan_to_execute_scaffold (GATE-PLN-020)", requires: "plan.md includes ## Execution Steps, ## Verification Obligation Synthesis, and ## Semantic Upkeep Contract before EXECUTE." },
    { family: "kb_tag_obligation (GATE-PLN-021)", requires: "plan.md records [KB_APPLIED:<id>] or [KB_NOT_APPLICABLE:<reason>] so prior learning review is explicit." },
    { family: "story_linkage_obligation (GATE-PLN-016)", requires: "success criteria map to active story_registry.json IDs, or use N/A only when no registry exists." },
    { family: "context_sensitive_matrix (GATE-PLN-017)", requires: "recipe, connector, migration, and backend-boundary plans use the context-sensitive Verification Strategy matrix with proof IDs." },
    { family: "kb_digest_proof (GATE-EXP-010)", requires: "findings_ledger.json kb_digest_salt or findings.md [KB_DIGEST:<salt>] verifies against state.json for KB read proof." },
    { family: "planner-core self-proof (GATE-VAL-010)", requires: "verification.md records PASS for the governed migration-bootstrap and transition-gate-flows IVE suites." },
    { family: "anti-recurrence guard (GATE-VAL-013)", requires: "bug-fix / regression plans record an ## Anti-Recurrence Guard section in verification.md with a valid Guard Type and PASS." },
    { family: "deliverable ledger (GATE-VAL-012)", requires: "goal-shaped plans with required deliverables record PASS evidence or a waiver for each deliverable in verification.md." },
    { family: "semantic substrate (GATE-SEM-001)", requires: "story_registry.json and annotation facts stay consistent; if the registry changes after a signed transition, refresh state.json.registry_hash via transition.mjs." },
  ],
  ux_ui: [
    { family: "rendered-journey proof", requires: "a browser screenshot / rendered artifact + loading/error/empty states (ux_ui persona)." },
  ],
};

export function previewShapeInvariants(planShape) {
  const key = typeof planShape === "string" ? planShape : planShape?.primary;
  return SHAPE_INVARIANTS[key] || [];
}

export function previewContract({ plannedFiles = [], planShape = null, triagePath = null } = {}) {
  const meta = previewMetaRules(plannedFiles);
  const ritual = previewRitualBudget(triagePath);
  if (ritual) meta.push(ritual);
  return {
    routing: triagePath,
    meta_rules: meta,
    shape_invariants: previewShapeInvariants(planShape),
  };
}

export function renderContractPreview(contract) {
  const lines = ["── Contract preview (front-loaded — know the rules before you act) ──"];
  if (contract.routing) lines.push(`  Routing: ${contract.routing}`);
  if (contract.meta_rules.length) {
    lines.push("  Meta-rules your planned files trigger:");
    for (const r of contract.meta_rules) {
      lines.push(`    • [${r.id}] ${r.requirement}`);
      lines.push(`        ⇒ ${r.consequence}`);
    }
  }
  if (contract.shape_invariants.length) {
    lines.push("  Invariants that will be checked for this shape:");
    for (const inv of contract.shape_invariants) lines.push(`    • ${inv.family} — ${inv.requires}`);
  }
  if (contract.meta_rules.length === 0 && contract.shape_invariants.length === 0) {
    lines.push("  No special meta-rules or shape invariants triggered by the declared files/shape.");
  }
  return lines.join("\n");
}
