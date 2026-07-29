// contract_reliability.mjs - generic IVE contracts for user intent, assumptions, claims, and complaints.

const VALID_ASSUMPTION_STATUSES = new Set([
  "externally_verified",
  "user_asserted",
  "unverified_allowed",
  "stale",
  "blocking_until_checked",
]);

const HIGH_IMPACT_VALUES = new Set(["high", "critical", "material"]);

const DEFAULT_CLAIM_ROUTES = Object.freeze([
  {
    claim_type: "output_conforms",
    required_proof_kinds: ["proof:output_contract"],
    reject_generic_self_report: true,
  },
  {
    claim_type: "ci_green",
    required_proof_kinds: ["proof:ci_check", "proof:clean_checkout_ci"],
    reject_generic_self_report: true,
  },
  {
    claim_type: "migration_succeeded",
    required_proof_kinds: ["proof:migration_test", "proof:upgrade_smoke"],
    reject_generic_self_report: true,
  },
  {
    claim_type: "quantitative_result",
    required_proof_kinds: ["proof:quant_results_validation"],
    reject_generic_self_report: true,
  },
  {
    claim_type: "assumption_resolved",
    required_proof_kinds: ["proof:assumption_ledger"],
    reject_generic_self_report: true,
  },
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeId(value, fallback = "contract") {
  return asString(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function issue({ code, contractId, itemId = null, message, severity = "error", details = {} }) {
  return {
    code,
    severity,
    contract_id: contractId,
    item_id: itemId,
    message,
    details,
  };
}

function includesSignal(text, signal) {
  const needle = asString(signal?.text ?? signal);
  if (needle) return text.toLowerCase().includes(needle.toLowerCase());
  const pattern = asString(signal?.pattern);
  if (!pattern) return true;
  try {
    return new RegExp(pattern, signal?.flags || "i").test(text);
  } catch {
    return false;
  }
}

function hasHeading(text, heading) {
  const label = asString(heading?.heading ?? heading?.text ?? heading);
  if (!label) return true;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").test(text);
}

function proofRefEntries(proofRefs) {
  return asArray(proofRefs)
    .map((proof) => {
      if (proof && typeof proof === "object") {
        const kind = asString(proof.kind || proof.proof_type);
        const ref = asString(proof.ref || proof.artifact || proof.artifact_path || proof.path);
        return { kind, ref };
      }
      // A bare string carries a kind label but no backing artifact.
      return { kind: asString(proof), ref: "" };
    })
    .filter((entry) => entry.kind);
}

function isHighImpact(assumption) {
  return HIGH_IMPACT_VALUES.has(asString(assumption?.impact || assumption?.risk || assumption?.severity).toLowerCase());
}

function result(contract, issues, extra = {}) {
  const status = issues.some((entry) => entry.severity !== "warning") ? "FAIL" : "PASS";
  return {
    contract_id: normalizeId(contract?.id),
    contract_type: contract?.type || extra.contract_type || "contract",
    // proof-status-lint: exempt T-INTAKE-B07B8898 -- Internal contract-lint aggregate enum is derived from the structural issue list.
    ok: status === "PASS",
    status,
    issue_count: issues.length,
    issues,
    ...extra,
  };
}

export function evaluateOutputContract(contract = {}, artifacts = {}) {
  const contractId = normalizeId(contract.id, "output_contract");
  const text = asString(contract.artifact_text || artifacts.artifact_text || artifacts.text);
  const issues = [];

  if (!text) {
    issues.push(issue({
      code: "output_contract_missing_artifact",
      contractId,
      message: "Output contract needs artifact text to verify the requested format.",
    }));
  }

  for (const section of asArray(contract.required_sections)) {
    const itemId = normalizeId(section?.id || section?.heading || section, "section");
    if (text && !hasHeading(text, section)) {
      issues.push(issue({
        code: "output_contract_missing_section",
        contractId,
        itemId,
        message: `Required output section is missing: ${asString(section?.heading || section) || itemId}.`,
      }));
    }
  }

  for (const signal of asArray(contract.required_signals)) {
    const itemId = normalizeId(signal?.id || signal?.text || signal?.pattern || signal, "signal");
    if (text && !includesSignal(text, signal)) {
      issues.push(issue({
        code: "output_contract_missing_signal",
        contractId,
        itemId,
        message: `Required output signal is missing: ${asString(signal?.text || signal?.pattern || signal) || itemId}.`,
      }));
    }
  }

  for (const placeholder of asArray(contract.forbidden_placeholders)) {
    const itemId = normalizeId(placeholder?.id || placeholder?.text || placeholder, "placeholder");
    if (text && includesSignal(text, placeholder)) {
      issues.push(issue({
        code: "output_contract_forbidden_placeholder",
        contractId,
        itemId,
        message: `Forbidden placeholder text is present: ${asString(placeholder?.text || placeholder) || itemId}.`,
      }));
    }
  }

  for (const antiGoal of asArray(contract.anti_goals)) {
    const itemId = normalizeId(antiGoal?.id || antiGoal?.text || antiGoal?.pattern || antiGoal, "anti_goal");
    if (text && includesSignal(text, antiGoal)) {
      issues.push(issue({
        code: "output_contract_anti_goal_present",
        contractId,
        itemId,
        message: `Output contains a declared anti-goal: ${asString(antiGoal?.text || antiGoal?.pattern || antiGoal) || itemId}.`,
      }));
    }
  }

  return result({ ...contract, id: contractId, type: "output_contract" }, issues, {
    checked_sections: asArray(contract.required_sections).length,
    checked_signals: asArray(contract.required_signals).length,
  });
}

export function evaluateAssumptionLedger(contract = {}) {
  const contractId = normalizeId(contract.id, "assumption_ledger");
  const issues = [];

  for (const assumption of asArray(contract.assumptions)) {
    const itemId = normalizeId(assumption?.id, "assumption");
    const status = asString(assumption?.status).toLowerCase();
    const evidenceRefs = asArray(assumption?.evidence_refs).map(asString).filter(Boolean);
    const hasWaiver = Boolean(asString(assumption?.waiver_ref));
    const hasBoundary = Boolean(asString(assumption?.boundary || assumption?.claim_boundary));

    if (!VALID_ASSUMPTION_STATUSES.has(status)) {
      issues.push(issue({
        code: "assumption_unknown_status",
        contractId,
        itemId,
        message: `Assumption status is unknown: ${status || "missing"}.`,
      }));
      continue;
    }

    if (status === "blocking_until_checked") {
      issues.push(issue({
        code: "assumption_marked_blocking",
        contractId,
        itemId,
        message: "Assumption is explicitly blocking until checked.",
      }));
    }

    if (status === "user_asserted" && isHighImpact(assumption) && evidenceRefs.length === 0) {
      issues.push(issue({
        code: "assumption_high_impact_unverified",
        contractId,
        itemId,
        message: "High-impact user assertion needs evidence, an explicit waiver, or a no-claim boundary before close.",
      }));
    }

    if (status === "externally_verified" && evidenceRefs.length === 0) {
      issues.push(issue({
        code: "assumption_externally_verified_without_evidence",
        contractId,
        itemId,
        message: "Externally verified assumptions need at least one evidence reference; the status label alone is not proof.",
      }));
    }

    if (status === "unverified_allowed" && (!hasWaiver || !hasBoundary)) {
      issues.push(issue({
        code: "assumption_unverified_allowed_without_boundary",
        contractId,
        itemId,
        message: "Unverified allowed assumptions need both a waiver reference and a claim boundary.",
      }));
    }

    if (status === "stale" && !hasBoundary) {
      issues.push(issue({
        code: "assumption_stale_without_boundary",
        contractId,
        itemId,
        message: "Stale assumptions need an explicit freshness boundary.",
      }));
    }
  }

  if (asArray(contract.assumptions).length === 0) {
    issues.push(issue({
      code: "assumption_ledger_empty",
      contractId,
      message: "Assumption ledger contains no assumptions.",
    }));
  }

  return result({ ...contract, id: contractId, type: "assumption_ledger" }, issues, {
    assumption_count: asArray(contract.assumptions).length,
  });
}

export function evaluateClaimProofRoutes(contract = {}) {
  const contractId = normalizeId(contract.id, "claim_proof_routes");
  const builtinClaimTypes = new Set(DEFAULT_CLAIM_ROUTES.map((route) => asString(route.claim_type)));
  // Built-in anti-fabrication routes are non-weakenable. Project-local routes may
  // add NEW claim types only; a local route that collides with a built-in is
  // rejected (fail-closed) and the built-in route is kept.
  const routes = new Map(
    DEFAULT_CLAIM_ROUTES
      .filter((route) => asString(route?.claim_type))
      .map((route) => [asString(route.claim_type), route])
  );
  const issues = [];

  for (const localRoute of asArray(contract.claim_routes)) {
    const claimType = asString(localRoute?.claim_type);
    if (!claimType) continue;
    if (builtinClaimTypes.has(claimType)) {
      issues.push(issue({
        code: "claim_route_builtin_override_rejected",
        contractId,
        itemId: normalizeId(claimType, "claim_route"),
        message: `Project-local routes cannot override or weaken the built-in claim route "${claimType}". Register new claim types instead.`,
      }));
      continue;
    }
    routes.set(claimType, localRoute);
  }

  for (const claim of asArray(contract.claims)) {
    const itemId = normalizeId(claim?.id, "claim");
    const claimType = asString(claim?.type || claim?.claim_type);
    const route = routes.get(claimType);
    const entries = proofRefEntries(claim?.proof_refs);
    const declaredKinds = new Set(entries.map((entry) => entry.kind));
    const satisfiedKinds = new Set(entries.filter((entry) => entry.ref).map((entry) => entry.kind));

    if (!route) {
      issues.push(issue({
        code: "claim_route_unknown_type",
        contractId,
        itemId,
        message: `No proof route is registered for claim type: ${claimType || "missing"}.`,
      }));
      continue;
    }

    const required = asArray(route.required_proof_kinds).map(asString).filter(Boolean);
    if (!required.some((kind) => satisfiedKinds.has(kind))) {
      const declaredButBare = required.some((kind) => declaredKinds.has(kind) && !satisfiedKinds.has(kind));
      issues.push(issue({
        code: declaredButBare ? "claim_route_proof_ref_missing_artifact" : "claim_route_missing_required_proof",
        contractId,
        itemId,
        message: declaredButBare
          ? `Claim ${itemId} declares a required proof kind without a backing ref/artifact (one of: ${required.join(", ")}).`
          : `Claim ${itemId} needs one of: ${required.join(", ")}.`,
        details: {
          required_proof_kinds: required,
          declared_proof_kinds: [...declaredKinds],
          satisfied_proof_kinds: [...satisfiedKinds],
        },
      }));
    }

    if (route.reject_generic_self_report !== false && declaredKinds.has("proof:self_report")) {
      issues.push(issue({
        code: "claim_route_rejects_self_report",
        contractId,
        itemId,
        message: "Self-report proof cannot satisfy this user-visible claim.",
      }));
    }
  }

  if (asArray(contract.claims).length === 0) {
    issues.push(issue({
      code: "claim_route_empty",
      contractId,
      message: "Claim proof route contract contains no claims.",
    }));
  }

  return result({ ...contract, id: contractId, type: "claim_proof_routes" }, issues, {
    claim_count: asArray(contract.claims).length,
  });
}

export function buildComplaintRegressionSeed(complaint = {}) {
  const id = normalizeId(complaint.id || complaint.contract_id || "complaint_regression", "complaint_regression");
  return {
    id,
    user_correction: asString(complaint.user_text || complaint.correction),
    violated_contract_kind: asString(complaint.violated_contract_kind),
    regression_seed: asString(complaint.regression_seed || complaint.expected_behavior),
    proof_target: asString(complaint.proof_target),
    recurrence_guard: asString(complaint.recurrence_guard),
    fixed_claim_allowed: false,
  };
}

export function evaluateComplaintRegression(contract = {}) {
  const contractId = normalizeId(contract.id, "complaint_regression");
  const complaint = contract.complaint || contract;
  const seed = buildComplaintRegressionSeed(complaint);
  const issues = [];

  for (const [field, code] of [
    ["user_correction", "complaint_missing_user_correction"],
    ["violated_contract_kind", "complaint_missing_contract_kind"],
    ["regression_seed", "complaint_missing_regression_seed"],
    ["proof_target", "complaint_missing_proof_target"],
    ["recurrence_guard", "complaint_missing_recurrence_guard"],
  ]) {
    if (!seed[field]) {
      issues.push(issue({
        code,
        contractId,
        itemId: seed.id,
        message: `Complaint regression seed is missing ${field}.`,
      }));
    }
  }

  const resolutionClaim = asString(complaint.resolution_claim);
  const proofRefs = asArray(complaint.proof_refs);
  if (resolutionClaim && proofRefs.length === 0) {
    issues.push(issue({
      code: "complaint_resolution_claim_without_proof",
      contractId,
      itemId: seed.id,
      message: "Complaint artifact cannot claim resolution without proof references.",
    }));
  }

  return result({ ...contract, id: contractId, type: "complaint_regression" }, issues, {
    regression_seed: seed,
  });
}

export function evaluateProjectContractRegistry(registry = {}) {
  const registryId = normalizeId(registry.id, "project_contract_registry");
  const contractResults = [];
  const registryIssues = [];

  for (const contract of asArray(registry.contracts)) {
    const type = asString(contract?.type);
    if (type === "output_contract") contractResults.push(evaluateOutputContract(contract));
    else if (type === "assumption_ledger") contractResults.push(evaluateAssumptionLedger(contract));
    else if (type === "claim_proof_routes") contractResults.push(evaluateClaimProofRoutes(contract));
    else if (type === "complaint_regression") contractResults.push(evaluateComplaintRegression(contract));
    else {
      registryIssues.push(issue({
        code: "project_contract_unknown_type",
        contractId: registryId,
        itemId: normalizeId(contract?.id, "unknown_contract"),
        message: `Unknown project-local contract type: ${type || "missing"}.`,
      }));
    }
  }

  if (asArray(registry.contracts).length === 0) {
    registryIssues.push(issue({
      code: "project_contract_registry_empty",
      contractId: registryId,
      message: "Project contract registry contains no contracts.",
    }));
  }

  const childIssues = contractResults.flatMap((entry) => entry.issues);
  const issues = [...registryIssues, ...childIssues];
  return {
    contract_id: registryId,
    contract_type: "project_contract_registry",
    ok: issues.every((entry) => entry.severity === "warning"),
    status: issues.some((entry) => entry.severity !== "warning") ? "FAIL" : "PASS",
    issue_count: issues.length,
    contract_count: asArray(registry.contracts).length,
    issues,
    results: contractResults,
  };
}

export {
  DEFAULT_CLAIM_ROUTES,
  VALID_ASSUMPTION_STATUSES,
};
