// lifecycle_contract.mjs — compile the complete planner finish line before EXECUTE.

import { createHash } from "crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { parseSimpleYaml } from "./plan_utils.mjs";
import { getWorkflowContract, workflowMarkdownPath } from "./workflow_contracts.mjs";

export const LIFECYCLE_CONTRACT_FILENAME = "completion_contract.json";
export const LIFECYCLE_CONTRACT_VERSION = 1;

const CANONICAL_PROOF_MODES = Object.freeze([
  "artifact_review",
  "command",
  "dry_run",
  "integration_smoke",
  "migration_smoke",
  "test",
]);

const CHECKLIST_FILES = Object.freeze({
  "explore-to-plan": "explore-to-plan.yaml",
  "plan-to-execute": "plan-to-execute.yaml",
  "execute-to-reflect": "execute-to-reflect.yaml",
  "reflect-to-validate": "reflect-to-validate.yaml",
  "validate-to-close": "validate-to-close.yaml",
  "notify-user": "notify-user.yaml",
});

const ARTIFACT_PRODUCERS = Object.freeze({
  "{plan-dir}/findings.md": { id: "explore-work", phase: "EXPLORE", order: -0.5 },
  "{plan-dir}/findings_ledger.json": { id: "explore-work", phase: "EXPLORE", order: -0.5 },
  "{plan-dir}/intent_contract.json": { id: "explore-work", phase: "EXPLORE", order: -0.5 },
  "{plan-dir}/plan.md": { id: "planning-work", phase: "PLAN", order: 0.5 },
  "{plan-dir}/implementation_prompt.md": { id: "planning-work", phase: "PLAN", order: 0.5 },
  "{plan-dir}/decisions.md": { id: "planning-work", phase: "PLAN", order: 0.5 },
  "{plan-dir}/verification_strategy.yaml": { id: "gate-prepare:plan-to-execute", phase: "PLAN", order: 0.75 },
  "{plan-dir}/completion_contract.json": { id: "gate-prepare:plan-to-execute", phase: "PLAN", order: 0.75 },
  "{plan-dir}/baseline.json": { id: "plan-bootstrap", phase: "PLAN", order: 0.25 },
  "{plan-dir}/health_baseline.json": { id: "plan-bootstrap", phase: "PLAN", order: 0.25 },
  "{plan-dir}/health_report.md": { id: "explore-health-scan", phase: "EXPLORE", order: -0.25 },
  "{plan-dir}/red_team_notes.md": { id: "execute-work", phase: "EXECUTE", order: 1.5 },
  "{plan-dir}/progress.md": { id: "execute-work", phase: "EXECUTE", order: 1.5 },
  "{plan-dir}/verification.md": { id: "execute-work", phase: "EXECUTE", order: 1.5 },
  "{plan-dir}/reflection.md": { id: "reflect-work", phase: "REFLECT", order: 2.5 },
  "{plan-dir}/health_final.json": { id: "validation-work", phase: "VALIDATE", order: 3.5 },
  "{plan-dir}/verification_ledger.json": { id: "validation-work", phase: "VALIDATE", order: 3.5 },
  "{plan-dir}/summary.md": { id: "close-handoff", phase: "CLOSE", order: 4.5 },
  "{cwd}/audit.config.json": { id: "project-configuration", phase: "PROJECT", order: -1 },
  "reports/defect_register.md": { id: "project-reporting", phase: "PROJECT", order: -1 },
  "reports/red_team_audit/findings.md": { id: "project-reporting", phase: "PROJECT", order: -1 },
});

const DELIVERABLE_ARTIFACT_ALIASES = Object.freeze({
  implementation_plan: "{plan-dir}/plan.md",
  execution_prompt: "{plan-dir}/implementation_prompt.md",
});

function safeJson(path, fallback = null) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : fallback; }
  catch { return fallback; }
}

function safeText(path) {
  try { return existsSync(path) ? readFileSync(path, "utf-8") : ""; }
  catch { return ""; }
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function stableUnique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort();
}

function normalizeArtifactPath(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function artifactId(path) {
  return `artifact:${normalizeArtifactPath(path).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}`;
}

function producerFor(path, consumerOrder) {
  const normalized = normalizeArtifactPath(path);
  if (ARTIFACT_PRODUCERS[normalized]) return { ...ARTIFACT_PRODUCERS[normalized] };
  if (normalized === "{plan-dir}/state.json" || normalized === "{plan-dir}/state.md") {
    return { id: "prior-transition-state", phase: "LIFECYCLE", order: Math.max(-1, consumerOrder - 0.5) };
  }
  if (normalized.startsWith("{plan-dir}/artifacts/")) {
    return { id: "prior-gate-artifact", phase: "LIFECYCLE", order: Math.max(-1, consumerOrder - 0.5) };
  }
  if (normalized.startsWith("{plan-dir}/")) return null;
  return { id: "project-source", phase: "PROJECT", order: -1 };
}

function proofModesForCheck(item) {
  const kind = String(item?.check || "").trim();
  if (kind === "command_succeeds") return ["command", "integration_smoke"];
  if (kind === "json_field_equals") return ["artifact_review"];
  return ["artifact_review"];
}

function readChecklist(skillPath, gate) {
  const filename = CHECKLIST_FILES[gate];
  if (!filename) return { path: null, items: [] };
  const path = join(skillPath, "checklists", filename);
  const parsed = parseSimpleYaml(safeText(path));
  return { path, items: Array.isArray(parsed?.items) ? parsed.items : [] };
}

function readVerificationStrategy(planDir) {
  const path = join(planDir, "verification_strategy.yaml");
  const parsed = parseSimpleYaml(safeText(path));
  return parsed?.verification_strategy || parsed || null;
}

function normalizeEvidenceMode(value) {
  const mode = String(value || "").trim().toLowerCase().replace(/^proof:/, "").replace(/-/g, "_");
  if (!mode) return null;
  if (mode === "integration") return "integration_smoke";
  if (mode === "migration") return "migration_smoke";
  return mode;
}

function mapDeliverables(intentContract, artifacts, strategy) {
  const artifactByPath = new Map(artifacts.flatMap((artifact) => [
    [artifact.path, artifact],
    [basename(artifact.path), artifact],
  ]));
  const criteria = Array.isArray(strategy?.criteria) ? strategy.criteria : [];
  return (Array.isArray(intentContract?.deliverables) ? intentContract.deliverables : []).map((deliverable, index) => {
    const name = String(deliverable?.name || deliverable?.path || deliverable?.id || `deliverable-${index + 1}`).trim();
    const deliverableId = String(deliverable?.id || `deliverable-${index + 1}`);
    const explicitPath = normalizeArtifactPath(deliverable?.artifact_path || deliverable?.path);
    const aliasedPath = DELIVERABLE_ARTIFACT_ALIASES[deliverableId] || null;
    const artifact = artifactByPath.get(explicitPath)
      || artifactByPath.get(basename(explicitPath))
      || artifactByPath.get(aliasedPath)
      || artifactByPath.get(basename(name))
      || null;
    const mode = normalizeEvidenceMode(deliverable?.evidence_mode || deliverable?.evidenceMode);
    const proofCriterion = criteria.find((criterion) => {
      const haystack = JSON.stringify(criterion).toLowerCase();
      return haystack.includes(String(deliverable?.id || name).toLowerCase());
    }) || null;
    return {
      id: deliverableId,
      name,
      evidence_mode: mode,
      artifact_id: artifact?.id || null,
      criterion_id: proofCriterion?.id || null,
      mapped: Boolean(artifact || (proofCriterion && mode && CANONICAL_PROOF_MODES.includes(mode))),
    };
  });
}

export function validateLifecycleContract(contract) {
  const issues = [];
  const gates = Array.isArray(contract?.graph?.gates) ? contract.graph.gates : [];
  const artifacts = Array.isArray(contract?.graph?.artifacts) ? contract.graph.artifacts : [];
  const checks = Array.isArray(contract?.graph?.checks) ? contract.graph.checks : [];
  const edges = Array.isArray(contract?.graph?.edges) ? contract.graph.edges : [];
  if (gates.length === 0 || gates.at(-1)?.id !== "notify-user") {
    issues.push({ code: "terminal_gate_missing", detail: "Lifecycle graph must terminate at notify-user." });
  }
  for (const artifact of artifacts) {
    if ((artifact.consumers || []).length > 0 && !artifact.producer) {
      issues.push({ code: "missing_producer", artifact_id: artifact.id, detail: `${artifact.path} has consumers but no producer.` });
    }
  }
  for (const check of checks) {
    if (!Array.isArray(check.accepted_proof_modes) || check.accepted_proof_modes.length === 0) {
      issues.push({ code: "proof_mode_unmapped", check_id: check.id, detail: `${check.id} has no canonical proof mode.` });
    }
  }
  for (const edge of edges) {
    if (!Number.isFinite(edge.producer_order) || !Number.isFinite(edge.consumer_order) || edge.producer_order >= edge.consumer_order) {
      issues.push({ code: "producer_after_consumer", edge_id: edge.id, detail: `${edge.producer_gate} must precede ${edge.consumer_gate}.` });
    }
  }
  for (const deliverable of Array.isArray(contract?.deliverables) ? contract.deliverables : []) {
    if (!deliverable.mapped) issues.push({ code: "deliverable_unmapped", deliverable_id: deliverable.id, detail: `${deliverable.name} has no lifecycle artifact or canonical proof row.` });
  }
  return {
    ok: issues.length === 0,
    issues,
    issue_count: issues.length,
    late_requirement_count: issues.length,
  };
}

export function compileLifecycleContract({
  cwd = process.cwd(),
  skillPath = join(cwd, ".agent", "skills", "iterative-planner"),
  planDir,
  workflowId = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!planDir) throw new Error("compileLifecycleContract requires planDir");
  const state = safeJson(join(planDir, "state.json"), {});
  const selectedWorkflow = workflowId || state?.workflow_id || "/safe-change";
  const gateRegistryPath = join(skillPath, "config", "gates.json");
  const gateRegistry = safeJson(gateRegistryPath, { gates: {} });
  const gateEntries = Object.entries(gateRegistry?.gates || {});
  const gates = gateEntries.map(([id, definition], order) => ({
    id,
    order,
    from: definition?.from ?? null,
    to: definition?.to ?? null,
    audit_only: definition?.audit_only === true,
    authority_profile: definition?.authority_profile || null,
  }));
  const gateOrder = new Map(gates.map((gate) => [gate.id, gate.order]));
  const failureCodesPath = join(skillPath, "config", "failure-codes.json");
  const failureCodes = safeJson(failureCodesPath, { codes: {} })?.codes || {};
  const artifactsByPath = new Map();
  const checks = [];
  const sources = [gateRegistryPath, failureCodesPath];

  for (const gate of gates) {
    const checklist = readChecklist(skillPath, gate.id);
    if (checklist.path) sources.push(checklist.path);
    for (const item of checklist.items) {
      const checkId = `check:${gate.id}:${item.id}`;
      const failureCode = Object.entries(failureCodes).find(([, metadata]) => metadata?.gate === gate.id && metadata?.check === item.id)?.[0]
        || `${String(gateRegistry.gates?.[gate.id]?.failure_code_prefix || "GATE-CONTRACT")}-CHECKLIST`;
      const acceptedProofModes = proofModesForCheck(item);
      const artifactPaths = stableUnique([item.path, item.skip_if_path].map(normalizeArtifactPath));
      checks.push({
        id: checkId,
        gate: gate.id,
        checklist_id: item.id,
        check_type: item.check || null,
        severity: item.severity || "fail",
        failure_code: failureCode,
        accepted_proof_modes: acceptedProofModes,
        applicability: item.required_for_shapes || "always",
        invalidation_keys: ["plan", "evidence", "gate_config", "checklist"],
        artifact_ids: artifactPaths.map(artifactId),
      });
      for (const path of artifactPaths) {
        if (!artifactsByPath.has(path)) {
          artifactsByPath.set(path, {
            id: artifactId(path),
            path,
            producer: producerFor(path, gate.order),
            consumers: [],
            accepted_proof_modes: [],
            invalidation_keys: ["plan", "evidence"],
          });
        }
        const artifact = artifactsByPath.get(path);
        artifact.consumers.push({ gate: gate.id, check_id: checkId, order: gate.order });
        artifact.accepted_proof_modes = stableUnique([...artifact.accepted_proof_modes, ...acceptedProofModes]);
      }
    }
  }

  // `notify-user` consumes a summary even though the checklist keeps it advisory.
  // Publishing it here makes its producer/consumer order explicit before EXECUTE.
  const manualArtifacts = [
    ["{plan-dir}/plan.md", "plan-to-execute"],
    ["{plan-dir}/implementation_prompt.md", "plan-to-execute"],
    ["{plan-dir}/completion_contract.json", "plan-to-execute"],
    ["{plan-dir}/verification_ledger.json", "validate-to-close"],
    ["{plan-dir}/summary.md", "notify-user"],
  ];
  for (const [path, gateId] of manualArtifacts) {
    const order = gateOrder.get(gateId);
    if (!artifactsByPath.has(path)) {
      artifactsByPath.set(path, {
        id: artifactId(path),
        path,
        producer: producerFor(path, order),
        consumers: [],
        accepted_proof_modes: ["artifact_review"],
        invalidation_keys: ["plan", "evidence"],
      });
    }
    artifactsByPath.get(path).consumers.push({ gate: gateId, check_id: `derived:${gateId}:${basename(path)}`, order });
  }

  const artifacts = [...artifactsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  const edges = artifacts.flatMap((artifact) => (artifact.consumers || []).map((consumer) => ({
    id: `edge:${artifact.id}:${consumer.gate}:${consumer.check_id}`,
    artifact_id: artifact.id,
    producer_gate: artifact.producer?.id || null,
    consumer_gate: consumer.gate,
    producer_order: artifact.producer?.order ?? null,
    consumer_order: consumer.order,
  })));
  const strategy = readVerificationStrategy(planDir);
  const intentContract = safeJson(join(planDir, "intent_contract.json"), {});
  const workflowContract = getWorkflowContract(cwd, selectedWorkflow);
  const workflowPath = workflowMarkdownPath(cwd, selectedWorkflow);
  if (workflowPath) sources.push(workflowPath);
  for (const name of ["plan.md", "state.json", "verification_strategy.yaml", "intent_contract.json", "focus_contract.json"]) {
    const path = join(planDir, name);
    if (existsSync(path)) sources.push(path);
  }
  const contract = {
    version: LIFECYCLE_CONTRACT_VERSION,
    generated_at: generatedAt,
    plan_id: state?.plan_id || state?.plan_dir || basename(planDir),
    workflow: {
      id: selectedWorkflow,
      contract_profile: workflowContract?.contract_profile || null,
      contract_version: workflowContract?.contract_version || null,
    },
    terminal_phase: "CLOSE",
    terminal_gate: "notify-user",
    canonical_proof_modes: [...CANONICAL_PROOF_MODES],
    graph: { gates, checks, artifacts, edges },
    deliverables: mapDeliverables(intentContract, artifacts, strategy),
    sources: stableUnique(sources.map((path) => relative(cwd, path).replace(/\\/g, "/") || ".")),
  };
  contract.validation = validateLifecycleContract(contract);
  contract.contract_digest = sha256({ ...contract, generated_at: null, contract_digest: null, validation: contract.validation });
  return contract;
}

export function writeLifecycleContract({ planDir, contract }) {
  if (!planDir || !contract) throw new Error("writeLifecycleContract requires planDir and contract");
  const path = join(planDir, LIFECYCLE_CONTRACT_FILENAME);
  const next = `${JSON.stringify(contract, null, 2)}\n`;
  if (safeText(path) === next) return { path, written: false, reason: "already_current" };
  const temp = `${path}.tmp`;
  writeFileSync(temp, next);
  renameSync(temp, path);
  return { path, written: true, reason: existsSync(path) ? "written" : "created" };
}

export function renderLifecycleContractSummary(contract) {
  const validation = contract?.validation || validateLifecycleContract(contract);
  return [
    `Lifecycle completion contract: ${validation.ok ? "PASS" : "FAIL"}`,
    `  gates=${contract?.graph?.gates?.length || 0} checks=${contract?.graph?.checks?.length || 0} artifacts=${contract?.graph?.artifacts?.length || 0}`,
    `  terminal=${contract?.terminal_gate || "missing"} issues=${validation.issue_count || 0} digest=${contract?.contract_digest || "unavailable"}`,
  ].join("\n");
}
