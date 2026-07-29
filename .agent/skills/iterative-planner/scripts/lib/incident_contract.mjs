// @planner:module = incident_contract
// @planner:capability = deterministic_incident_rectification_contract

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const INCIDENT_CONTRACT_VERSION = "1.0.0";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(MODULE_DIR, "..", "..");
const CORE_PLUGIN_REGISTRY = join(SKILL_DIR, "config", "incident_preflight_plugins.json");
const INCIDENT_CONTRACT_FILENAMES = Object.freeze([
  "incident_contract.json",
  join("artifacts", "incident_contract.json"),
]);

const ENTRYPOINTS = new Set(["advisor", "retro", "incident", "explicit", "preflight", "close"]);

const FAILURE_TERMS = Object.freeze([
  "bug", "failure", "failing", "broken", "wrong", "regression", "incident", "screwed", "mismatch",
  "fallback", "stale", "missing", "dead signal", "false green", "bad result", "root cause",
]);

const SHAPE_RULES = Object.freeze([
  {
    id: "quant_wfo",
    label: "Quant WFO / model-result incident",
    terms: [
      "quant", "model", "ml", "prediction", "strategy", "signal", "backtest", "wfo", "walk forward",
      "walk-forward", "optimizer", "optuna", "trial", "hyperparameter", "roi", "alpha", "ufc",
    ],
    persona_packs: ["quant", "quant_target", "wiring_auditor", "assumptions_challenger", "traceability"],
    closeout_gates: [
      "quant_false_green_guards",
      "incident_preflight_rows_pass",
      "rerun_command_and_artifact_lineage",
      "residual_risk_recorded",
    ],
  },
  {
    id: "dead_signal_or_prediction_fallback",
    label: "Dead signal or prediction fallback",
    terms: ["prediction_provider", "provider none", "provider != none", "missing_prediction", "dead signal", "fallback", "no prediction"],
    persona_packs: ["quant", "wiring_auditor", "assumptions_challenger", "traceability"],
    closeout_gates: ["quant_false_green_guards", "incident_preflight_rows_pass"],
  },
  {
    id: "optimizer_artifact_mismatch",
    label: "Optimizer artifact mismatch",
    terms: ["optuna", "study", "trial", "budget", "best params", "best-param", "best parameter", "hyperparameter"],
    persona_packs: ["quant", "wiring_auditor", "traceability"],
    closeout_gates: ["incident_preflight_rows_pass", "rerun_command_and_artifact_lineage"],
  },
  {
    id: "report_artifact_lineage",
    label: "Report/artifact lineage mismatch",
    terms: ["report", "html", "artifact", "canonical report", "canonical backtest", "lineage", "stale artifact"],
    persona_packs: ["wiring_auditor", "config_integrity", "traceability", "assumptions_challenger"],
    closeout_gates: ["rerun_command_and_artifact_lineage", "report_semantic_acceptance", "residual_risk_recorded"],
  },
  {
    id: "temporal_leakage_risk",
    label: "Temporal or leakage risk",
    terms: ["temporal", "leakage", "lookahead", "look-ahead", "known-at-time", "as-of", "oos", "out of sample"],
    persona_packs: ["quant", "quant_target", "assumptions_challenger", "traceability"],
    closeout_gates: ["quant_false_green_guards", "residual_risk_recorded"],
  },
  {
    id: "service_boundary_wiring",
    label: "Connector/backend service boundary wiring",
    terms: ["connector", "api", "backend", "service boundary", "orchestration", "workflow", "mcp", "integration", "migration"],
    persona_packs: ["wiring_auditor", "config_integrity", "traceability", "assumptions_challenger"],
    closeout_gates: ["incident_preflight_rows_pass", "rerun_command_and_artifact_lineage"],
  },
  {
    id: "retro_promotion",
    label: "Retro promotion into future guard",
    terms: ["retro", "recurrence", "active mistake", "learned obligation", "promotion", "future guard", "kb trigger"],
    persona_packs: ["assumptions_challenger", "traceability", "config_integrity", "wiring_auditor"],
    closeout_gates: ["retro_promotion_disposition", "residual_risk_recorded"],
  },
]);

const CLOSEOUT_GATE_DEFINITIONS = Object.freeze({
  incident_contract_present: {
    id: "incident_contract_present",
    title: "Incident contract is present",
    required_evidence: ["incident_contract.json is present and matches the incident shape"],
  },
  advisor_persona_findings_consumed: {
    id: "advisor_persona_findings_consumed",
    title: "Advisor and persona findings were consumed",
    required_evidence: ["Advisor/escalation status and persona obligations are acknowledged, acted on, or waived with rationale"],
  },
  incident_preflight_rows_pass: {
    id: "incident_preflight_rows_pass",
    title: "Incident preflight rows executed",
    required_evidence: ["Every required incident preflight row records PASS evidence or an explicit accepted-risk waiver"],
  },
  rerun_command_and_artifact_lineage: {
    id: "rerun_command_and_artifact_lineage",
    title: "Rerun command and artifact lineage are proven",
    required_evidence: ["Exact rerun command, artifact paths, report/backtest input lineage, and freshness proof are recorded"],
  },
  quant_false_green_guards: {
    id: "quant_false_green_guards",
    title: "Quant false-green guards are satisfied",
    required_evidence: ["prediction_provider != none, 0 missing_prediction, optimizer lineage, best-param consumption, temporal/leakage proof"],
  },
  residual_risk_recorded: {
    id: "residual_risk_recorded",
    title: "Residual risk is explicit",
    required_evidence: ["Remaining unverified risk and strongest counterargument are recorded before close"],
  },
  report_semantic_acceptance: {
    id: "report_semantic_acceptance",
    title: "Report semantic acceptance is proven",
    required_evidence: ["Report/artifact answers the operator question, names lineage, preserves diagnostics, states recommendations or stop conditions, and records claims not promoted"],
  },
  retro_promotion_disposition: {
    id: "retro_promotion_disposition",
    title: "Retro promotion disposition is recorded",
    required_evidence: ["Confirmed root cause is promoted to a mistake, learned obligation, plugin requirement, KB trigger, or explicitly rejected with rationale"],
  },
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function objectText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "");
  }
}

function containsTerm(text, term) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  if (/^[a-z0-9]+$/.test(normalizedTerm) && normalizedTerm.length <= 4) {
    return new RegExp(`(^|[^a-z0-9])${normalizedTerm}([^a-z0-9]|$)`).test(text);
  }
  return text.includes(normalizedTerm);
}

function matchedTerms(text, terms) {
  return asArray(terms).filter((term) => containsTerm(text, term));
}

function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function safeRead(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function normalizePlugin(plugin, source) {
  const id = asString(plugin?.id);
  if (!id) return null;
  return {
    id,
    title: asString(plugin?.title) || id,
    applies_to: unique(plugin?.applies_to),
    phase: asString(plugin?.phase) || "before_close",
    required: plugin?.required !== false,
    fail_closed: plugin?.fail_closed !== false,
    state_mutated: plugin?.state_mutated === true,
    command_or_action: asString(plugin?.command_or_action),
    pass_means: asString(plugin?.pass_means),
    evidence_terms: unique(plugin?.evidence_terms),
    source,
  };
}

function loadPluginFile(path, source) {
  const parsed = readJson(path);
  if (!parsed) return { plugins: [], warnings: existsSync(path) ? [{ code: "invalid_plugin_registry_json", path }] : [] };
  const plugins = asArray(parsed.plugins).map((entry) => normalizePlugin(entry, source)).filter(Boolean);
  const warnings = plugins
    .filter((plugin) => plugin.state_mutated)
    .map((plugin) => ({ code: "state_mutating_plugin_rejected", plugin_id: plugin.id, path }));
  return {
    plugins: plugins.filter((plugin) => !plugin.state_mutated),
    warnings,
  };
}

export function loadIncidentPreflightRegistry({ cwd = process.cwd() } = {}) {
  const sources = [
    { path: CORE_PLUGIN_REGISTRY, source: "core" },
    { path: join(cwd, ".agent", "incident_preflight_plugins.json"), source: "host:.agent" },
    { path: join(cwd, "incident_preflight_plugins.json"), source: "host:root" },
  ];
  const plugins = [];
  const warnings = [];
  for (const source of sources) {
    const result = loadPluginFile(source.path, source.source);
    plugins.push(...result.plugins);
    warnings.push(...result.warnings);
  }
  const byId = new Map();
  for (const plugin of plugins) {
    if (!byId.has(plugin.id)) byId.set(plugin.id, plugin);
  }
  return {
    version: 1,
    state_mutated: false,
    plugins: [...byId.values()],
    warnings,
    sources: sources.map((entry) => ({ ...entry, present: existsSync(entry.path) })),
  };
}

export function classifyIncident({
  text = "",
  entrypoint = "explicit",
  files = [],
} = {}) {
  const normalizedEntrypoint = ENTRYPOINTS.has(String(entrypoint || "").trim()) ? String(entrypoint || "").trim() : "explicit";
  const combined = normalizeText([text, ...asArray(files)].join("\n"));
  const matchedFailureTerms = matchedTerms(combined, FAILURE_TERMS);
  const matchedShapes = SHAPE_RULES
    .map((shape) => ({
      id: shape.id,
      label: shape.label,
      matched_terms: matchedTerms(combined, shape.terms),
      persona_packs: shape.persona_packs,
      closeout_gates: shape.closeout_gates,
    }))
    .filter((shape) => shape.matched_terms.length > 0);

  const explicitIncident = normalizedEntrypoint === "incident" || normalizedEntrypoint === "explicit";
  const required = matchedShapes.length > 0 || matchedFailureTerms.length > 0 || explicitIncident;
  const severity = matchedShapes.some((shape) => ["quant_wfo", "dead_signal_or_prediction_fallback", "optimizer_artifact_mismatch"].includes(shape.id))
    ? "fail_closed"
    : required ? "incident_contract_required" : "not_applicable";

  return {
    required,
    entrypoint: normalizedEntrypoint,
    severity,
    matched_failure_terms: matchedFailureTerms,
    shapes: matchedShapes,
    shape_ids: matchedShapes.map((shape) => shape.id),
  };
}

function pluginsForShapes(registry, shapeIds) {
  const wanted = new Set(shapeIds);
  return asArray(registry.plugins).filter((plugin) =>
    plugin.required && asArray(plugin.applies_to).some((shape) => wanted.has(shape))
  );
}

function closeoutGatesForShapes(shapeIds) {
  const gateIds = unique([
    "incident_contract_present",
    "advisor_persona_findings_consumed",
    ...SHAPE_RULES
      .filter((shape) => shapeIds.includes(shape.id))
      .flatMap((shape) => shape.closeout_gates),
  ]);
  return gateIds.map((id) => CLOSEOUT_GATE_DEFINITIONS[id]).filter(Boolean).map((gate) => ({
    ...gate,
    fail_closed: true,
  }));
}

function personaPacksForShapes(shapeIds) {
  return unique(SHAPE_RULES
    .filter((shape) => shapeIds.includes(shape.id))
    .flatMap((shape) => shape.persona_packs));
}

function obligation(id, title, evidenceTerms = [], source = "incident_contract") {
  return {
    id,
    title,
    required: true,
    evidence_terms: unique(evidenceTerms),
    source,
  };
}

function phaseObligationsForIncident({ required, shapeIds, personaPacks, requiredPreflights, closeoutGates }) {
  if (!required) return { setup: [], plan: [], execute: [], reflect: [], close: [] };
  const shapes = new Set(shapeIds);
  const setup = [
    obligation("incident_contract_required", "Generate and preserve the incident contract", [
      "incident_contract.json", "entrypoint", "active_plan_isolation",
    ]),
  ];
  if (personaPacks.length) {
    setup.push(obligation("persona_scan_required", "Run persona scan before incident planning", [
      "persona_adapt scan", ...personaPacks,
    ]));
  }

  const plan = [
    obligation("domain_persona_packs", "Carry required domain persona packs into the plan", personaPacks),
  ];
  if (shapes.has("quant_wfo") || shapes.has("temporal_leakage_risk")) {
    plan.push(
      obligation("quant_target_data_lineage", "Define target, data lineage, and known-at-time boundary", [
        "target", "data lineage", "known-at-time", "prediction horizon",
      ]),
      obligation("temporal_leakage_controls", "Plan temporal/leakage proof and controls", [
        "temporal", "leakage", "walk-forward", "controls", "baseline",
      ]),
      obligation("result_claim_boundary", "State allowed result claims and non-promotion boundary", [
        "result claim", "diagnostic", "residual risk", "not promoted",
      ]),
    );
  }
  if (shapes.has("quant_wfo") || shapes.has("optimizer_artifact_mismatch")) {
    plan.push(obligation("optimizer_search_surface", "Declare optimizer/search surface and budget lineage", [
      "optimizer", "optuna", "trial", "budget", "best params",
    ]));
  }
  if (shapes.has("dead_signal_or_prediction_fallback") || shapes.has("quant_wfo")) {
    plan.push(obligation("model_signal_presence", "Require live model signal before interpreting results", [
      "prediction_provider", "missing_prediction", "model signal",
    ]));
  }
  if (shapes.has("report_artifact_lineage")) {
    plan.push(obligation("report_semantic_acceptance_contract", "Define report semantic acceptance before close", [
      "operator question", "semantic acceptance", "lineage", "diagnostic", "stop condition",
    ]));
  }
  if (shapes.has("service_boundary_wiring")) {
    plan.push(obligation("service_boundary_exercise", "Plan connector/backend boundary proof", [
      "connector", "backend", "boundary", "dry-run", "partial failure",
    ]));
  }
  if (shapes.has("retro_promotion")) {
    plan.push(obligation("retro_promotion_plan", "Plan retro promotion evidence and deterministic guard", [
      "active mistake", "learned obligation", "recurrence", "future guard",
    ]));
  }

  const preflightIds = requiredPreflights.map((entry) => entry.id);
  const execute = [];
  if (preflightIds.length) {
    execute.push(obligation("required_preflight_rows", "Execute required incident preflight rows", preflightIds, "incident_preflight_registry"));
  }
  for (const phase of unique(requiredPreflights.map((entry) => entry.phase))) {
    execute.push(obligation(`preflight_phase_${phase}`, `Satisfy incident preflights for ${phase}`, [
      phase,
      ...requiredPreflights.filter((entry) => entry.phase === phase).map((entry) => entry.id),
    ], "incident_preflight_registry"));
  }

  const reflect = [
    obligation("advisor_persona_findings_consumed", "Consume advisor and persona findings before closeout", [
      "advisor", "persona", "consumed", "waiver rationale",
    ]),
    obligation("strongest_counterargument_recorded", "Record strongest counterargument and false-green risk", [
      "counterargument", "false green", "residual risk",
    ]),
  ];
  if (shapes.has("retro_promotion")) {
    reflect.push(obligation("retro_promotion_candidate_reviewed", "Review whether the incident should promote a future guard", [
      "retro promotion", "active mistake", "learned obligation", "plugin requirement",
    ]));
  }

  const close = [
    obligation("closeout_gates_pass", "Record PASS evidence for every fail-closed closeout gate", closeoutGates.map((entry) => entry.id)),
  ];
  if (!closeoutGates.some((entry) => entry.id === "residual_risk_recorded")) {
    close.push(obligation("residual_risk_recorded", "Record residual risk or accepted-risk waiver", [
      "residual risk", "accepted risk", "waiver",
    ]));
  }

  return { setup, plan, execute, reflect, close };
}

function collectProgramText(packet, ticketId) {
  const ticket = asArray(packet?.tickets).find((entry) => asString(entry?.id) === ticketId) || null;
  const acceptanceIds = new Set(asArray(ticket?.acceptance_criteria).map(asString).filter(Boolean));
  const verificationIds = new Set(asArray(ticket?.verification_refs).map(asString).filter(Boolean));
  const acceptance = asArray(packet?.acceptance_criteria).filter((entry) =>
    asString(entry?.subject_ref) === ticketId || acceptanceIds.has(asString(entry?.id))
  );
  const verification = asArray(packet?.verification_matrix).filter((entry) =>
    asString(entry?.subject_ref) === ticketId || verificationIds.has(asString(entry?.id))
  );
  const text = [
    packet?.id,
    packet?.title,
    packet?.goal,
    ticket?.id,
    ticket?.title,
    ticket?.problem,
    ticket?.proposed_change,
    ...asArray(ticket?.persona_packs),
    ...acceptance.map((entry) => entry?.text),
    ...verification.map((entry) => [entry?.proof_type, entry?.command_or_action, entry?.pass_means].filter(Boolean).join(" ")),
  ].filter(Boolean).join("\n");
  return { ticket, acceptance, verification, text };
}

export function loadProgramIncidentSource({ cwd = process.cwd(), program = null, ticket = null } = {}) {
  if (!program) return { text: "", packet: null, ticket: null, warnings: [] };
  const path = program.includes("/") || program.endsWith(".json")
    ? resolve(cwd, program)
    : resolve(cwd, "plans", "programs", program, "program_packet.json");
  const packet = readJson(path);
  if (!packet) return { text: "", packet: null, ticket: null, warnings: [{ code: "program_packet_unavailable", path }] };
  const source = collectProgramText(packet, ticket);
  return { ...source, packet, path, warnings: [] };
}

export function buildIncidentContract({
  cwd = process.cwd(),
  entrypoint = "explicit",
  text = "",
  files = [],
  program = null,
  ticket = null,
  activePlan = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const programSource = loadProgramIncidentSource({ cwd, program, ticket });
  const sourceText = [text, programSource.text].filter(Boolean).join("\n\n");
  const classification = classifyIncident({ text: sourceText, entrypoint, files });
  const registry = loadIncidentPreflightRegistry({ cwd });
  const requiredPreflights = classification.required ? pluginsForShapes(registry, classification.shape_ids) : [];
  const personaPacks = classification.required ? personaPacksForShapes(classification.shape_ids) : [];
  const closeoutGates = classification.required ? closeoutGatesForShapes(classification.shape_ids) : [];

  return {
    version: INCIDENT_CONTRACT_VERSION,
    generated_at: generatedAt,
    state_mutated: false,
    status: classification.required ? "required" : "not_required",
    source: {
      entrypoint: classification.entrypoint,
      program_packet: programSource.path || null,
      ticket_id: ticket || programSource.ticket?.id || null,
      source_text_sha256_hint: sourceText ? `${sourceText.length}chars` : null,
      active_plan: activePlan || null,
    },
    incident: {
      required: classification.required,
      severity: classification.severity,
      suspected_failure_classes: classification.shape_ids,
      matched_failure_terms: classification.matched_failure_terms,
      matched_shapes: classification.shapes.map((shape) => ({
        id: shape.id,
        label: shape.label,
        matched_terms: shape.matched_terms,
      })),
    },
    advisor: {
      required: classification.required,
      command: "node .agent/skills/iterative-planner/scripts/escalation_check.mjs --json",
      consume_in_closeout: true,
    },
    persona: {
      required_packs: personaPacks,
      scan_command: "node .agent/skills/iterative-planner/scripts/persona_adapt.mjs scan . --json",
      summary: personaPacks.length
        ? `${personaPacks.join(", ")} required for this incident shape`
        : "No domain persona packs required by incident classifier",
    },
    preflight_registry: {
      state_mutated: registry.state_mutated,
      plugin_count: registry.plugins.length,
      warnings: registry.warnings,
    },
    required_preflights: requiredPreflights.map((plugin) => ({
      id: plugin.id,
      title: plugin.title,
      phase: plugin.phase,
      fail_closed: plugin.fail_closed,
      state_mutated: false,
      command_or_action: plugin.command_or_action,
      pass_means: plugin.pass_means,
      evidence_terms: plugin.evidence_terms,
      source: plugin.source,
    })),
    closeout_gates: closeoutGates,
    phase_obligations: phaseObligationsForIncident({
      required: classification.required,
      shapeIds: classification.shape_ids,
      personaPacks,
      requiredPreflights,
      closeoutGates,
    }),
    active_plan_isolation: {
      recommended_mode: activePlan ? "parallel_child_plan_or_resume_matching_incident_plan" : "create_incident_plan",
      reason: activePlan
        ? "An active plan is present; preserve it unless it is the same incident plan."
        : "No active plan supplied; create a dedicated incident repair plan.",
    },
    next_commands: classification.required ? unique([
      "node .agent/skills/iterative-planner/scripts/escalation_check.mjs --json",
      "node .agent/skills/iterative-planner/scripts/persona_adapt.mjs scan . --json",
      requiredPreflights.length ? "node .agent/skills/iterative-planner/scripts/evidence_preflight.mjs check --gate GATE-VAL-022 --json" : null,
    ]) : [],
    warnings: programSource.warnings,
  };
}

function findIncidentContractPath(planDir) {
  for (const name of INCIDENT_CONTRACT_FILENAMES) {
    const candidate = join(planDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function incidentCloseoutRows(content) {
  const sectionMatch = String(content || "").match(/^##\s+Incident Closeout\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/im);
  const section = sectionMatch?.[1] || "";
  const tableLines = section.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|"));
  const labeledRows = section.split("\n").map((line) => {
    const match = line.trim().match(/^([a-z0-9][a-z0-9_-]*)\s+([^:|]+):\s*(\S[\s\S]*)$/i);
    return match ? { id: match[1], status: match[2].trim(), evidence: match[3].trim() } : null;
  }).filter(Boolean);
  if (tableLines.length < 3) return labeledRows;
  const split = (line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const header = split(tableLines[0]).map((cell) => normalizeText(cell));
  const idColumn = header.findIndex((cell) => ["id", "gate", "preflight"].includes(cell));
  const statusColumn = header.findIndex((cell) => ["status", "result"].includes(cell));
  const evidenceColumn = header.findIndex((cell) => ["evidence", "detail", "proof"].includes(cell));
  if (idColumn === -1 || statusColumn === -1 || evidenceColumn === -1) return labeledRows;
  const tableRows = tableLines.slice(2).map(split).filter((row) => row.some(Boolean)).map((row) => ({
    id: row[idColumn] || "",
    status: row[statusColumn] || "",
    evidence: row[evidenceColumn] || "",
  }));
  return [...tableRows, ...labeledRows];
}

function evidenceContainsAny(content, terms) {
  const normalized = normalizeText(content);
  return asArray(terms).some((term) => containsTerm(normalized, term));
}

function incidentRequiredByPlanText(text) {
  return /\[INCIDENT_CONTRACT_REQUIRED\]/i.test(text || "") ||
    /^##\s+Incident Contract\s*$/im.test(text || "");
}

export function evaluateIncidentCloseout({
  cwd = process.cwd(),
  planDir,
  planContent = null,
  verificationContent = null,
} = {}) {
  const dir = planDir ? resolve(cwd, planDir) : null;
  const planText = planContent ?? (dir ? safeRead(join(dir, "plan.md")) : "");
  const verifyText = verificationContent ?? (dir ? safeRead(join(dir, "verification.md")) : "");
  const contractPath = dir ? findIncidentContractPath(dir) : null;
  const explicitRequired = incidentRequiredByPlanText(planText);

  if (!contractPath) {
    return {
      required: explicitRequired,
      satisfied: !explicitRequired,
      status: explicitRequired ? "missing_contract" : "not_required",
      detail: explicitRequired
        ? "Incident closeout is required but incident_contract.json is missing"
        : "Incident closeout not required for this plan",
      artifact: "incident_contract.json",
      missing: explicitRequired ? ["incident_contract.json"] : [],
      actions: explicitRequired ? [
        "Generate or record incident_contract.json before close.",
        "Run node .agent/skills/iterative-planner/scripts/incident_contract.mjs check --plan <plan-dir> --json for diagnostics.",
      ] : [],
      contract_path: null,
      contract: null,
    };
  }

  const contract = readJson(contractPath);
  if (!contract) {
    return {
      required: true,
      satisfied: false,
      status: "invalid_contract",
      detail: "incident_contract.json is invalid JSON",
      artifact: "incident_contract.json",
      missing: ["valid incident_contract.json"],
      actions: ["Rewrite incident_contract.json as valid JSON generated by incident_contract.mjs."],
      contract_path: contractPath,
      contract: null,
    };
  }

  const requiredPreflights = asArray(contract.required_preflights).filter((entry) => entry?.fail_closed !== false);
  const closeoutGates = asArray(contract.closeout_gates).filter((entry) => entry?.fail_closed !== false);
  const closeoutRows = incidentCloseoutRows(verifyText);
  const missing = [];

  for (const gate of closeoutGates) {
    const row = closeoutRows.find((entry) => entry.id === gate.id);
    if (!row || !verificationStatusIsPass(row.status, "presentation")) missing.push(`closeout gate missing PASS: ${gate.id}`);
  }
  for (const preflight of requiredPreflights) {
    const row = closeoutRows.find((entry) => entry.id === preflight.id);
    if (!row || !verificationStatusIsPass(row.status, "presentation")) missing.push(`required preflight missing PASS: ${preflight.id}`);
    if (asArray(preflight.evidence_terms).length > 0 && !evidenceContainsAny(row?.evidence || "", preflight.evidence_terms)) {
      missing.push(`required preflight lacks evidence terms: ${preflight.id}`);
    }
  }

  const hasIncidentCloseoutSection = /^##\s+Incident Closeout\s*$/im.test(verifyText);
  if (!hasIncidentCloseoutSection) missing.push("verification.md -> ## Incident Closeout section");

  const satisfied = missing.length === 0;
  return {
    required: true,
    satisfied,
    status: satisfied ? "pass" : "missing_evidence",
    detail: satisfied
      ? `Incident closeout satisfied (${closeoutGates.length} closeout gate(s), ${requiredPreflights.length} preflight row(s))`
      : `Incident closeout missing evidence: ${missing.join("; ")}`,
    artifact: "incident_contract.json / verification.md",
    missing,
    actions: satisfied ? [] : [
      "Add `## Incident Closeout` to verification.md.",
      "For every incident closeout gate and required preflight, add an exact id/status/evidence table row with canonical PASS status.",
      "Include advisor/persona consumption, rerun command, artifact lineage, residual risk, and any accepted-risk waivers.",
    ],
    contract_path: contractPath,
    contract,
  };
}

export function summarizeIncidentCloseout(result) {
  if (!result?.required) return "Incident closeout not required for this plan";
  if (result.satisfied) return result.detail || "Incident closeout satisfied";
  return result.detail || `Incident closeout missing evidence: ${asArray(result?.missing).join("; ")}`;
}

export function readPlanIncidentSource({ cwd = process.cwd(), plan = null } = {}) {
  if (!plan) return { plan_dir: null, text: "", active_plan: null };
  const plansDir = join(cwd, "plans");
  const planDir = plan.includes("/") ? resolve(cwd, plan) : join(plansDir, plan);
  const state = readJson(join(planDir, "state.json"));
  const files = [];
  try {
    for (const name of readdirSync(planDir)) {
      if (["plan.md", "findings.md", "verification.md", "reflection.md"].includes(name)) files.push(join(planDir, name));
    }
  } catch {
    // Missing plan dirs are handled by empty text.
  }
  return {
    plan_dir: existsSync(planDir) ? planDir : null,
    active_plan: state?.plan_dir || basename(planDir),
    text: files.map((file) => safeRead(file)).join("\n\n"),
  };
}
