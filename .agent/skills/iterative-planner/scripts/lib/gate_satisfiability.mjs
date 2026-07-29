// gate_satisfiability.mjs — Provider-neutral structural gate requirement evaluation.
// @planner:module = gate_satisfiability
// @planner:capability = provider_neutral_gate_requirement_resolution
// @planner:story = US-079, US-PM-AUTO-172
// @planner:proves = sc_1, sc_4, sc_5

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lower(value) {
  return asString(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function waiversForRequirement(waivers, requirementId) {
  return asArray(waivers).filter((waiver) => asString(waiver?.requirement_id || waiver?.requirementId) === requirementId);
}

export function validateGateRequirementWaiver(waiver, decisions = [], requirementId = "") {
  const expectedRequirement = asString(requirementId);
  const waiverRequirement = asString(waiver?.requirement_id || waiver?.requirementId);
  const decisionRef = asString(waiver?.decision_ref || waiver?.decisionRef);
  const reason = asString(waiver?.reason || waiver?.rationale);
  const decision = asArray(decisions).find((entry) => asString(entry?.id) === decisionRef) || null;
  const issues = [];

  if (!waiverRequirement || (expectedRequirement && waiverRequirement !== expectedRequirement)) {
    issues.push("waiver requirement_id does not match the gate requirement");
  }
  if (!decisionRef) issues.push("waiver decision_ref is required");
  if (!reason) issues.push("waiver reason is required");
  if (!decision) {
    issues.push(`waiver decision ${decisionRef || "(missing)"} does not exist`);
  } else {
    if (lower(decision.type) !== "gate_requirement_waiver") {
      issues.push(`decision ${decisionRef} must use type gate_requirement_waiver`);
    }
    if (asString(decision.subject_ref || decision.subjectRef) !== waiverRequirement) {
      issues.push(`decision ${decisionRef} subject_ref must match ${waiverRequirement || expectedRequirement}`);
    }
    if (!asString(decision.rationale)) issues.push(`decision ${decisionRef} rationale is required`);
  }

  return {
    ok: issues.length === 0,
    requirement_id: waiverRequirement || expectedRequirement || null,
    decision_ref: decisionRef || null,
    reason: reason || null,
    decision: decision ? {
      id: asString(decision.id),
      type: lower(decision.type),
      subject_ref: asString(decision.subject_ref || decision.subjectRef),
    } : null,
    issues,
  };
}

export function evaluateGateSatisfiability({ requirements = [], waivers = [], decisions = [] } = {}) {
  const outcomes = [];
  const blockers = [];
  const knownRequirementIds = new Set(
    asArray(requirements).map((descriptor) => asString(descriptor?.id)).filter(Boolean),
  );

  for (const descriptor of asArray(requirements)) {
    const id = asString(descriptor?.id);
    const base = {
      id: id || null,
      description: asString(descriptor?.description) || null,
      reason: asString(descriptor?.reason) || null,
      resolution_options: asArray(descriptor?.resolution_options || descriptor?.resolutionOptions)
        .map((option) => ({
          id: asString(option?.id),
          action: asString(option?.action),
          command: asString(option?.command) || null,
        }))
        .filter((option) => option.id && option.action),
      metadata: descriptor?.metadata && typeof descriptor.metadata === "object"
        ? { ...descriptor.metadata }
        : {},
    };

    if (!id) {
      outcomes.push({ ...base, status: "invalid_requirement", waiver: null });
      blockers.push({ code: "gate_requirement_invalid", requirement_id: null, message: "Gate requirement descriptor requires an id." });
      continue;
    }

    const matchingWaivers = waiversForRequirement(waivers, id);
    let governedWaiver = null;
    if (matchingWaivers.length > 0) {
      const validations = matchingWaivers.map((waiver) => validateGateRequirementWaiver(waiver, decisions, id));
      const valid = matchingWaivers.length === 1 && validations[0].ok ? validations[0] : null;
      if (!valid) {
        const issues = matchingWaivers.length > 1
          ? [`requirement ${id} has multiple waiver records; exactly one is allowed`]
          : validations.flatMap((entry) => entry.issues);
        outcomes.push({
          ...base,
          status: "invalid_waiver",
          waiver: validations[0] || null,
          waiver_issues: issues,
        });
        blockers.push({
          code: "gate_requirement_waiver_invalid",
          requirement_id: id,
          message: `Governed waiver for ${id} is invalid: ${issues.join("; ")}`,
        });
        continue;
      }
      governedWaiver = valid;
    }
    if (descriptor?.applicable === false) {
      outcomes.push({ ...base, status: "not_applicable", waiver: governedWaiver });
      continue;
    }
    if (descriptor?.satisfied === true) {
      outcomes.push({ ...base, status: "satisfied", waiver: governedWaiver });
      continue;
    }
    if (governedWaiver) {
      outcomes.push({ ...base, status: "waived", waiver: governedWaiver });
      continue;
    }

    const outcome = { ...base, status: "resolution_required", waiver: null };
    outcomes.push(outcome);
    blockers.push({
      code: "gate_requirement_resolution_required",
      requirement_id: id,
      message: base.reason || `Gate requirement ${id} is structurally unsatisfied.`,
      resolution_options: outcome.resolution_options,
    });
  }

  for (const waiver of asArray(waivers)) {
    const requirementId = asString(waiver?.requirement_id || waiver?.requirementId);
    if (knownRequirementIds.has(requirementId)) continue;
    const validation = validateGateRequirementWaiver(waiver, decisions, requirementId);
    const issues = [
      requirementId
        ? `waiver references unregistered gate requirement ${requirementId}`
        : "waiver requirement_id is required",
      ...validation.issues,
    ];
    outcomes.push({
      id: requirementId || null,
      description: null,
      reason: null,
      resolution_options: [],
      metadata: {},
      status: "invalid_waiver",
      waiver: validation,
      waiver_issues: issues,
    });
    blockers.push({
      code: "gate_requirement_waiver_invalid",
      requirement_id: requirementId || null,
      message: `Governed waiver for ${requirementId || "(missing requirement)"} is invalid: ${issues.join("; ")}`,
    });
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? "satisfied" : "blocked",
    requirements: outcomes,
    blockers,
    counts: {
      total: outcomes.length,
      // proof-status-lint: exempt T-INTAKE-B07B8898 -- Gate-requirement lifecycle enum, not authored or executed verification-result truth.
      satisfied: outcomes.filter((entry) => entry.status === "satisfied").length,
      // proof-status-lint: exempt T-INTAKE-B07B8898 -- Gate-requirement lifecycle enum, not authored or executed verification-result truth.
      waived: outcomes.filter((entry) => entry.status === "waived").length,
      not_applicable: outcomes.filter((entry) => entry.status === "not_applicable").length,
      blocked: blockers.length,
    },
  };
}
