// guidance_packet.mjs — Compose bounded, guidance-first task-intake context.
// @planner:module = task_intake_guidance
// @planner:capability = guidance_packet_composition
// @planner:story = US-073

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { buildContextPacket, DEFAULT_ENTRY_BUDGET } from "./context_packet.mjs";
import { buildWorkflowContractSummary } from "./workflow_contracts.mjs";
import { evaluateExternalPrerequisites } from "./program_packet.mjs";

const __filename = fileURLToPath(import.meta.url);
const libDir = dirname(__filename);
const skillRoot = resolve(libDir, "../..");
const sourceProjectRoot = resolve(skillRoot, "../../..");

export const GUIDANCE_PACKET_SCHEMA_VERSION = 1;
export const DEFAULT_GUIDANCE_JSON_PATH = "plans/guidance_packet.json";
export const DEFAULT_GUIDANCE_MD_PATH = "plans/guidance_packet.md";

const FULL_GATE_SEQUENCE = Object.freeze([
  "explore-to-plan",
  "plan-to-execute",
  "execute-to-reflect",
  "reflect-to-validate",
  "validate-to-close",
  "notify-user",
]);

const PLANNER_CORE_PERSONA_EXPECTATIONS = Object.freeze({
  assumptions_challenger: Object.freeze([
    "Name each user-visible or operator-facing claim and the evidence that would falsify it.",
    "Record the strongest false-green path and test it through the real task-intake CLI.",
    "Resolve load-bearing assumptions with observed probes before claiming the packet is complete.",
  ]),
  config_integrity: Object.freeze([
    "Inventory affected flags/defaults and state whether any mutual exclusions change.",
    "Prove migration and portable snapshot parity for shared planner behavior.",
    "Keep planner-owned evidence paths distinct from real host configuration provenance.",
  ]),
  traceability: Object.freeze([
    "Link goal to Program ticket, acceptance criterion, verification row, story/gap, implementation, and proof artifact.",
    "Surface missing or placeholder story links as warnings; do not manufacture coverage.",
    "Keep JSON and Markdown packet projections tied to the same packet hash.",
  ]),
  wiring_auditor: Object.freeze([
    "Exercise the composed packet through task_intake, not only through helper-level calls.",
    "Test child-tool failure or malformed output without silently claiming a clean result.",
    "Verify every generated guidance surface has a downstream consumer or explicit recovery purpose.",
  ]),
});

const GATE_FUNCTION_NAMES = Object.freeze({
  "explore-to-plan": "gateExploreToPlan",
  "plan-to-execute": "gatePlanToExecute",
  "execute-to-reflect": "gateExecuteToReflect",
  "reflect-to-validate": "gateReflectToValidate",
  "validate-to-close": "gateValidateToClose",
  "notify-user": "gateNotifyUser",
});

const CHECKLIST_FILES = Object.freeze({
  "explore-to-plan": "explore-to-plan.yaml",
  "plan-to-execute": "plan-to-execute.yaml",
  "execute-to-reflect": "execute-to-reflect.yaml",
  "reflect-to-validate": "reflect-to-validate.yaml",
  "validate-to-close": "validate-to-close.yaml",
});

const EXACT_ARTIFACTS = Object.freeze({
  "assumption-ledger-present": "findings_ledger.json or findings.md",
  "assumption-probes-recorded": "findings_ledger.json or findings.md",
  "GATE-PLN-002": "plan.md -> ## Files To Modify",
  "GATE-PLN-016": "plan.md -> ## Success Criteria and ## Verification Strategy",
  "GATE-PLN-017": "plan.md -> ## Verification Strategy",
  "GATE-ETR-004": "red_team_notes.md",
  "GATE-ETR-008": "red_team_notes.md",
  "GATE-REF-003": "progress.md and state.json.close_signals.progress",
  "GATE-REF-016": "annotations/story registry/persona provenance -> ontology_facts.pl and state.json.close_signals.semantic_substrate",
  "GATE-VAL-011": "plan.md file inventory, verification.md test proof, or verification_ledger.json waiver",
});

const CANONICAL_SHAPES = Object.freeze({
  "assumption-ledger-present": "findings_ledger.json assumptions[] entry: { id, statement, status: VERIFIED|VIOLATED, probe }.",
  "assumption-probes-recorded": "At least one assumption records status VERIFIED or VIOLATED plus the concrete probe and observed result.",
  "GATE-PLN-002": "Use raw path-only bullets under ## Files To Modify; list every owned runtime, test, documentation, registry, and evidence file.",
  "GATE-PLN-016": "Every sc_N criterion has a Story linkage cell naming an active US-* story; N/A is legal only when the repository has no story registry.",
  "GATE-PLN-017": "| Criterion | Story linkage | Repo/system context | Required proof type | Concrete command or action | Pass means | What remains unverified |",
  "GATE-ETR-004": "Each adversarial vector contains an explicit Mitigation section describing an existing defense and any residual gap.",
  "GATE-ETR-008": "At least three substantive vectors, each using accepted Attack, Impact, and Mitigation labels; template filler is not evidence.",
  "GATE-REF-003": "All progress.md checkbox items are complete before reflect-to-validate; refresh must set close_signals.progress.satisfied=true.",
  "GATE-REF-016": "Declare real host config contradictions with semantic facts and preserve provenance. planner-owned evidence paths do not create host config mutual-exclusion obligations; do not add magic phrases to plan prose.",
  "GATE-VAL-011": "List a matching test file and paste a passing command in verification.md, or record a structured approved waiver for plan:test-evidence/plan:test-coverage.",
});

export const MEASURED_DENIAL_IDS = Object.freeze([
  "assumption-ledger-present",
  "assumption-probes-recorded",
  "GATE-PLN-002",
  "GATE-PLN-016",
  "GATE-PLN-017",
  "GATE-ETR-004",
  "GATE-ETR-008",
  "GATE-REF-003",
  "GATE-VAL-011",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(asArray(values).map((value) => asString(value)).filter(Boolean))];
}

function safeRead(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function safeJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

function rel(cwd, path) {
  return String(relative(cwd, path) || ".").replace(/\\/g, "/");
}

function hashPacket(packet) {
  const clone = structuredClone(packet);
  delete clone.generated_at;
  delete clone.packet_hash;
  delete clone.artifacts;
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex").slice(0, 32);
}

function normalizeGoal(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9-]+/g, " ").replace(/\s+/g, " ").trim();
}

function goalTokens(value) {
  return new Set(normalizeGoal(value).split(" ").filter((token) => token.length >= 3));
}

function overlap(goal, text) {
  const tokens = goalTokens(goal);
  return [...goalTokens(text)].filter((token) => tokens.has(token)).length;
}

function parseChecklist(text) {
  const items = [];
  let current = null;
  for (const rawLine of String(text || "").split("\n")) {
    const start = rawLine.match(/^\s*-\s+id:\s*["']?([^"']+?)["']?\s*$/);
    if (start) {
      if (current) items.push(current);
      current = { id: start[1].trim() };
      continue;
    }
    if (!current) continue;
    const field = rawLine.match(/^\s+(check|path|field|string|description|severity|min):\s*(.*?)\s*$/);
    if (field) current[field[1]] = field[2].replace(/^['"]|['"]$/g, "");
    const shapes = rawLine.match(/^\s+required_for_shapes:\s*\[(.*?)\]\s*$/);
    if (shapes) current.required_for_shapes = shapes[1].split(",").map((value) => value.trim().replace(/^['"]|['"]$/g, ""));
  }
  if (current) items.push(current);
  return items;
}

function checklistApplies(item, shape) {
  return !Array.isArray(item.required_for_shapes) || item.required_for_shapes.includes(shape);
}

function genericArtifact(checkId, gate) {
  if (EXACT_ARTIFACTS[checkId]) return EXACT_ARTIFACTS[checkId];
  if (checkId.startsWith("GATE-EXP")) return "findings_ledger.json/findings.md, intent_contract.json, or gate-owned EXPLORE artifact";
  if (checkId.startsWith("GATE-PLN")) return "plan.md, decisions.md, intent_contract.json, or verification strategy";
  if (checkId.startsWith("GATE-ETR")) return "red_team_notes.md, progress.md, verification.md, or annotation/story evidence";
  if (checkId.startsWith("GATE-REF")) return "reflection.md, progress.md, knowledge artifacts, or state.json close signals";
  if (checkId.startsWith("GATE-VAL")) return "verification.md, verification_ledger.json, tests, or close-signal artifacts";
  if (checkId.startsWith("GATE-NTF")) return "summary.md, reflection/knowledge sign-off, or state.json";
  return `${gate} gate-owned artifact`;
}

function checklistArtifact(item) {
  if (EXACT_ARTIFACTS[item.id]) return EXACT_ARTIFACTS[item.id];
  if (item.path) return item.path.replace("{plan-dir}/", "").replace("{knowledge}/", "plans/knowledge/");
  if (item.field) return `findings_ledger.json.${item.field} or equivalent findings.md section`;
  return "gate checklist runtime/proof surface";
}

function genericShape(checkId, expectation, artifact) {
  return CANONICAL_SHAPES[checkId] || `Author ${artifact} so the live check is observably satisfied: ${expectation}`;
}

function verifyFunctionBody(source, gate) {
  const functionName = GATE_FUNCTION_NAMES[gate];
  const start = source.indexOf(`function ${functionName}`);
  if (start < 0) return "";
  const next = source.indexOf("\nfunction ", start + functionName.length + 10);
  return source.slice(start, next < 0 ? source.length : next);
}

function buildGateContracts({ gates, planShape }) {
  if (gates.length === 0) return [];
  const gateRegistry = safeJson(join(skillRoot, "config", "gates.json"))?.gates || {};
  const failureCodes = safeJson(join(skillRoot, "config", "failure-codes.json")) || {};
  const verifierSource = safeRead(join(skillRoot, "scripts", "verify_gate.mjs"));

  return gates.map((gate) => {
    const gateDef = gateRegistry[gate] || {};
    const body = verifyFunctionBody(verifierSource, gate);
    const bodyCodeIds = unique(body.match(/GATE-[A-Z0-9-]+/g) || []);
    const liveChecks = bodyCodeIds.map((id) => {
      const metadata = failureCodes[id] || {};
      return {
        id,
        source: "verify_gate+failure-codes",
        expectation: asString(metadata.message) || asString(metadata.check) || id,
        artifact: genericArtifact(id, gate),
        canonical_shape: genericShape(id, asString(metadata.message) || id, genericArtifact(id, gate)),
        severity: asString(metadata.severity) || "fail",
      };
    });

    const checklistPath = CHECKLIST_FILES[gate] ? join(skillRoot, "checklists", CHECKLIST_FILES[gate]) : null;
    const checklistChecks = checklistPath
      ? parseChecklist(safeRead(checklistPath)).filter((item) => checklistApplies(item, planShape)).map((item) => ({
          id: item.id,
          source: "checklist",
          expectation: item.description || item.check || item.id,
          artifact: checklistArtifact(item),
          canonical_shape: genericShape(item.id, item.description || item.id, checklistArtifact(item)),
          severity: item.severity || "fail",
        }))
      : [];
    const checks = [...liveChecks, ...checklistChecks].filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
    return {
      gate,
      preflight_command: `node .agent/skills/iterative-planner/scripts/transition.mjs ${gate} --dry-run`,
      command: `node .agent/skills/iterative-planner/scripts/transition.mjs ${gate}`,
      from: gateDef.from ?? null,
      to: gateDef.to ?? null,
      audit_only: gateDef.audit_only === true,
      check_ids: checks.map((entry) => entry.id),
      checks,
      artifact_expectations: unique(checks.map((entry) => entry.artifact)),
      canonical_satisfying_shapes: checks.map((entry) => ({ id: entry.id, shape: entry.canonical_shape })),
      sources: unique([
        ".agent/skills/iterative-planner/config/gates.json",
        ".agent/skills/iterative-planner/config/failure-codes.json",
        ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
        CHECKLIST_FILES[gate] ? `.agent/skills/iterative-planner/checklists/${CHECKLIST_FILES[gate]}` : null,
      ]),
    };
  });
}

function loadProgramPackets(cwd) {
  const programsDir = join(cwd, "plans", "programs");
  if (!existsSync(programsDir)) return [];
  return readdirSync(programsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(programsDir, entry.name, "program_packet.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, packet: safeJson(path) }))
    .filter((entry) => entry.packet);
}

function programId(packet) {
  return asString(packet?.program_id || packet?.id);
}

function titleLaneMatch(goal, ticket) {
  const lane = asString(ticket?.title).match(/^([A-Z]\d+):/i)?.[1];
  return lane ? new RegExp(`\\b${lane}\\b`, "i").test(goal) : false;
}

function activePlanProgramSelection({ cwd, decision, preflight, packets }) {
  if (decision?.route !== "continue_active_plan" || preflight?.active_plan?.used_for_classification !== true) return null;
  const planDirName = asString(preflight?.active_plan?.plan_dir_name);
  if (!planDirName || planDirName.includes("/") || planDirName.includes("\\") || planDirName === "." || planDirName === "..") return null;
  const state = safeJson(join(cwd, "plans", planDirName, "state.json"));
  const context = state?.program_context;
  const expectedProgramId = asString(context?.program_id);
  const expectedTicketId = asString(context?.ticket_id);
  const packetRef = asString(context?.program_packet_path);
  let selected = null;
  if (packetRef) {
    const candidatePath = resolve(cwd, packetRef);
    const candidateRel = relative(cwd, candidatePath);
    if (candidateRel !== ".." && !candidateRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      selected = packets.find((entry) => resolve(entry.path) === candidatePath) || null;
    }
  }
  if (!selected && expectedProgramId) {
    const matches = packets.filter((entry) => programId(entry.packet) === expectedProgramId);
    if (matches.length === 1) selected = matches[0];
  }
  if (!selected || (expectedProgramId && programId(selected.packet) !== expectedProgramId)) return null;
  if (expectedTicketId && !asArray(selected.packet?.tickets).some((ticket) => asString(ticket?.id) === expectedTicketId)) return null;
  return { selected, ticket_ids: expectedTicketId ? [expectedTicketId] : [], source: "active_plan_program_context" };
}

function selectProgramContext({ cwd, goal, decision = null, preflight = null }) {
  const packets = loadProgramPackets(cwd);
  const normalizedGoal = normalizeGoal(goal);
  const explicitTicketIds = unique(String(goal || "").match(/T-[A-Z0-9-]+/g) || []);
  const preferred = activePlanProgramSelection({ cwd, decision, preflight, packets });
  const ranked = packets.map((entry) => {
    const id = programId(entry.packet);
    const tickets = asArray(entry.packet.tickets);
    const exactProgram = id && normalizedGoal.includes(id.toLowerCase());
    const exactTicket = tickets.some((ticket) => explicitTicketIds.includes(asString(ticket.id)));
    const exact = exactProgram || exactTicket;
    return { ...entry, exact, score: exactProgram ? 1000 : exactTicket ? 900 : overlap(goal, `${id} ${entry.packet.title} ${entry.packet.goal}`) };
  }).filter((entry) => entry.score > 0 && (entry.exact || asString(entry.packet?.status).toLowerCase() !== "closed"))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const selected = preferred?.selected || ranked[0];
  if (!selected) return { program: null, tickets: [], warnings: [], source: null };

  const packet = selected.packet;
  const preferredTicketIds = new Set(preferred?.ticket_ids || []);
  let tickets = asArray(packet.tickets).filter((ticket) => preferredTicketIds.has(asString(ticket.id)) || (!preferred && (explicitTicketIds.includes(asString(ticket.id)) || titleLaneMatch(goal, ticket))));
  if (tickets.length === 0) {
    tickets = asArray(packet.tickets)
      .map((ticket) => ({ ticket, score: overlap(goal, `${ticket.id} ${ticket.title} ${ticket.problem}`) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .map((entry) => entry.ticket);
  }

  const registryIds = new Set(asArray(safeJson(join(cwd, "reports", "user_story_audit", "story_registry.json"))?.stories).map((story) => asString(story.id)));
  const acceptance = asArray(packet.acceptance_criteria);
  const verification = asArray(packet.verification_matrix);
  const dependencies = asArray(packet.dependencies);
  const warnings = [];
  const externalPrerequisites = evaluateExternalPrerequisites(packet, {
    programPackets: packets.map((entry) => entry.packet),
  });
  for (const epic of asArray(packet.epics)) {
    for (const storyRef of asArray(epic.story_refs)) {
      if (!registryIds.has(asString(storyRef))) warnings.push(`Unknown Program story reference: ${storyRef} (epic ${epic.id || "unknown"})`);
    }
  }
  const expandedTickets = tickets.map((ticket) => {
    const storyRefs = unique(ticket.story_refs);
    if (storyRefs.length === 0) warnings.push(`Ticket ${ticket.id} has no story_refs; preserve its gap/maintenance rationale until traceability is repaired.`);
    return {
      id: ticket.id,
      title: ticket.title,
      lifecycle: ticket.lifecycle || null,
      problem: ticket.problem || ticket.description || "",
      proposed_change: ticket.proposed_change || "",
      story_refs: storyRefs,
      gap_refs: unique(ticket.gap_refs),
      defect_refs: unique(ticket.defect_refs),
      depends_on: unique(ticket.depends_on),
      external_prerequisites: asArray(ticket.external_prerequisites),
      prerequisite_blockers: externalPrerequisites.blockers.filter((entry) => entry.ticket_id === asString(ticket.id)),
      acceptance_criteria: acceptance.filter((row) => asArray(ticket.acceptance_criteria).includes(row.id) || row.subject_ref === ticket.id),
      verification_rows: verification.filter((row) => asArray(ticket.verification_refs).includes(row.id) || row.subject_ref === ticket.id),
      dependency_rows: dependencies.filter((row) => [row.from, row.source_ref, row.subject_ref].includes(ticket.id) || [row.to, row.target_ref].includes(ticket.id)),
      child_plan: ticket.child_plan || null,
      external_refs: asArray(ticket.external_refs),
    };
  });
  for (const blocker of externalPrerequisites.blockers.filter((entry) => tickets.some((ticket) => asString(ticket.id) === entry.ticket_id))) {
    warnings.push(`Unsatisfied external prerequisite for ${blocker.ticket_id}: ${blocker.message}`);
  }
  return {
    program: {
      id: programId(packet),
      title: packet.title || "",
      status: packet.status || null,
      goal: packet.goal || "",
    },
    tickets: expandedTickets,
    warnings: unique(warnings),
    source: rel(cwd, selected.path),
    selection_source: preferred?.source || "goal_match",
  };
}

function relevantContextEntries(packet, selectedTicketIds) {
  const goalRelevant = (entry) => asArray(entry.matched_by).some((match) => /goal_term|goal_overlap|story_ref|ticket:/i.test(match));
  const activeTickets = asArray(packet.active_tickets).filter((entry) => selectedTicketIds.has(entry.id));
  const ontologyFacts = asArray(packet.ontology_facts).filter(goalRelevant);
  const knowledge = [
    ...asArray(packet.known_gotchas),
    ...asArray(packet.prior_failure_modes),
    ...asArray(packet.retros),
    ...asArray(packet.journal_entries),
  ].map((entry) => ({
    id: entry.id,
    type: entry.type,
    title: entry.title,
    summary: entry.summary,
    trust_level: entry.trust_level || null,
    source_refs: entry.source_refs,
    matched_by: entry.matched_by,
  }));
  return { activeTickets, ontologyFacts, knowledge };
}

function runRuleEngine(cwd) {
  const scriptPath = join(skillRoot, "scripts", "rule_engine.mjs");
  const child = spawnSync(process.execPath, [scriptPath, "check-invariants", "--json"], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
    env: process.env,
  });
  const stdout = String(child.stdout || "").trim();
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* recorded below */ }
  const violations = asArray(parsed?.violations || parsed?.invariant_violations);
  const warnings = asArray(parsed?.warnings || parsed?.invariant_warnings);
  return {
    status: parsed ? (violations.length > 0 ? "FAIL" : "PASS") : "UNAVAILABLE",
    invariant_violations: violations.slice(0, 20),
    invariant_warnings: warnings.slice(0, 20),
    summary: parsed?.summary || null,
    error: parsed ? null : String(child.stderr || stdout || `exit ${child.status}`).slice(0, 500),
    source: ".agent/skills/iterative-planner/scripts/rule_engine.mjs check-invariants --json",
  };
}

function runWorkPreflight(cwd, goal) {
  const scriptPath = join(skillRoot, "scripts", "work_preflight.mjs");
  const child = spawnSync(process.execPath, [scriptPath, "--goal", goal, "--json", "--no-plan-context"], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
    env: process.env,
  });
  const stdout = String(child.stdout || "").trim();
  try {
    const parsed = JSON.parse(stdout);
    return {
      status: child.status === 0 ? "PASS" : "WARN",
      selected_workflow_id: parsed.selected_workflow_id || null,
      contract_profile: parsed.contract_profile || null,
      required_artifacts: parsed.required_artifacts || {},
      required_gates: asArray(parsed.required_gates),
      required_proof_surfaces: asArray(parsed.required_proof_surfaces),
      post_change_audits: asArray(parsed.post_change_audit_expectations),
      knowledge_reasons: asArray(parsed.knowledge?.reasons),
      error: null,
    };
  } catch {
    return {
      status: "UNAVAILABLE",
      selected_workflow_id: null,
      contract_profile: null,
      required_artifacts: {},
      required_gates: [],
      required_proof_surfaces: [],
      post_change_audits: [],
      knowledge_reasons: [],
      error: String(child.stderr || stdout || `exit ${child.status}`).slice(0, 500),
    };
  }
}

async function phaseGuidance(activePacks, phases, { planShape = "unknown" } = {}) {
  const expectations = [];
  for (const packId of activePacks) {
    if (planShape === "planner-core" && PLANNER_CORE_PERSONA_EXPECTATIONS[packId]) {
      for (const expectation of PLANNER_CORE_PERSONA_EXPECTATIONS[packId]) {
        expectations.push({ pack_id: packId, phase: "all", expectation });
      }
      continue;
    }
    const modulePath = join(skillRoot, "packs", packId, "index.mjs");
    if (!existsSync(modulePath)) continue;
    try {
      const pack = (await import(pathToFileURL(modulePath).href)).default;
      for (const phase of phases) {
        const guidance = typeof pack?.getPhaseGuidance === "function" ? pack.getPhaseGuidance(phase, {}) : "";
        for (const line of String(guidance || "").split("\n").map((value) => value.replace(/^\d+\.\s*/, "").trim()).filter(Boolean)) {
          expectations.push({ pack_id: packId, phase, expectation: line });
        }
      }
    } catch (error) {
      expectations.push({ pack_id: packId, phase: "all", expectation: `Persona guidance unavailable: ${error.message}` });
    }
  }
  return expectations;
}

async function buildPersonaGuardrails({ preflight, gates, proportionality, planShape }) {
  if (proportionality === "skip") {
    return { active_packs: [], suppressed_or_advisory_packs: [], expectations: [], required_proof_families: [] };
  }
  const authority = preflight?.persona_activation_authority || {};
  const focus = preflight?.focus_contract || {};
  const activePacks = unique(authority.active_packs?.length ? authority.active_packs : focus.authoritative_packs);
  const suppressed = [];
  for (const decision of asArray(authority.n_a_decisions)) {
    suppressed.push({
      pack_id: decision.pack_id,
      authority: decision.authority || "advisory",
      rationale: decision.n_a_rationale || decision.reason,
      may_block: false,
      may_synthesize_obligation: false,
      reactivation: decision.reactivation || null,
    });
  }
  for (const entry of asArray(focus.suppressed_packs)) {
    if (!suppressed.some((candidate) => candidate.pack_id === entry.pack_id)) {
      suppressed.push({ pack_id: entry.pack_id, authority: "advisory", rationale: entry.rationale, may_block: false, may_synthesize_obligation: false, reactivation: entry.reactivation || null });
    }
  }
  const phases = gates.map((gate) => ({
    "explore-to-plan": "explore",
    "plan-to-execute": "plan",
    "execute-to-reflect": "execute",
    "reflect-to-validate": "reflect",
    "validate-to-close": "validate",
    "notify-user": "close",
  }[gate])).filter(Boolean);
  return {
    active_packs: activePacks,
    suppressed_or_advisory_packs: suppressed,
    expectations: await phaseGuidance(activePacks, unique(phases), { planShape }),
    required_proof_families: unique(focus.required_proof_families),
    forbidden_claims: unique(focus.forbidden_claims),
    source: "planner_preflight persona_activation_authority + persona pack phase guidance",
  };
}

function selectWorkflow({ decision, preflight }) {
  if (decision?.route === "ask_human") return null;
  return asString(decision?.explicit_workflow) || asString(decision?.recommended_action?.workflow) || asString(preflight?.workflow?.recommended) || "/safe-change";
}

function proportionalityLevel({ decision, workflowId, preflight }) {
  if (decision?.route === "ask_human") return "skip";
  if (workflowId === "/ignore-planner" || preflight?.flow?.mode === "skip") return "skip";
  if (preflight?.flow?.mode === "lightweight") return "lightweight";
  return "full";
}

function resolveGates({ workflowId, preflight, proportionality }) {
  if (proportionality === "skip") return [];
  let summary = null;
  try { summary = buildWorkflowContractSummary(sourceProjectRoot, workflowId); } catch { /* fallback below */ }
  const required = unique(summary?.required_gates);
  const fullRequested = proportionality === "full" || required.length >= 5;
  return fullRequested ? FULL_GATE_SEQUENCE.slice() : required;
}

export async function buildGuidancePacket({
  cwd = process.cwd(),
  goal = "",
  decision = {},
  preflight = null,
  entryBudget = DEFAULT_ENTRY_BUDGET,
  generatedAt = new Date().toISOString(),
} = {}) {
  const root = resolve(cwd);
  const workflowId = selectWorkflow({ decision, preflight });
  const proportionality = proportionalityLevel({ decision, workflowId, preflight });
  const gates = resolveGates({ workflowId, preflight, proportionality });
  const planShape = asString(preflight?.focus_contract?.plan_shape?.primary || preflight?.task_profile?.id).replace(/_focus_contract$/, "") || "unknown";
  const workPreflight = proportionality === "skip" ? {
    status: "NOT_REQUIRED",
    selected_workflow_id: workflowId,
    contract_profile: "skip",
    required_artifacts: {},
    required_gates: [],
    required_proof_surfaces: [],
    post_change_audits: [],
    knowledge_reasons: [],
    error: null,
  } : runWorkPreflight(root, goal);
  const programContext = proportionality === "skip" ? { program: null, tickets: [], warnings: [], source: null } : selectProgramContext({ cwd: root, goal, decision, preflight });
  const primaryTicket = programContext.tickets[0]?.id || null;
  const contextPacket = buildContextPacket({
    cwd: root,
    goal,
    program: programContext.source,
    ticket: primaryTicket,
    entryBudget,
    noPlanContext: true,
    generatedAt,
  });
  const selectedTicketIds = new Set(programContext.tickets.map((ticket) => ticket.id));
  const relevant = proportionality === "skip"
    ? { activeTickets: [], ontologyFacts: [], knowledge: [] }
    : relevantContextEntries(contextPacket, selectedTicketIds);
  const gateContracts = buildGateContracts({ gates, planShape });
  const personaGuardrails = await buildPersonaGuardrails({ preflight, gates, proportionality, planShape });
  const ruleEngine = proportionality === "skip" ? { status: "NOT_REQUIRED", invariant_violations: [], invariant_warnings: [], summary: null, error: null, source: null } : runRuleEngine(root);
  const ontologyWarnings = unique([
    ...programContext.warnings,
    ...(ruleEngine.status === "UNAVAILABLE" ? [`Invariant check unavailable: ${ruleEngine.error}`] : []),
  ]);

  const packet = {
    schema_version: GUIDANCE_PACKET_SCHEMA_VERSION,
    packet_type: "guidance_packet",
    generated_at: generatedAt,
    goal,
    route: {
      route: decision.route || null,
      workflow: workflowId,
      flow_mode: preflight?.flow?.mode || decision?.preflight_summary?.flow_mode || null,
      rationale: decision.rationale || null,
      next_command: decision?.recommended_action?.command || null,
      decision_request: decision?.decision_request || null,
    },
    workflow_requirements: {
      source_status: workPreflight.status,
      contract_profile: workPreflight.contract_profile,
      routed_artifacts: workPreflight.required_artifacts,
      routed_gates: proportionality === "skip" ? [] : gates,
      routed_proof_surfaces: workPreflight.required_proof_surfaces,
      post_change_audits: workPreflight.post_change_audits,
      source_error: workPreflight.error,
    },
    proportionality: {
      level: proportionality,
      rationale: proportionality === "skip"
        ? `${workflowId || decision?.route || "skip"}: no lifecycle obligations`
        : proportionality === "lightweight"
          ? "Scaled guidance for the normal spine; only routed obligations are included."
          : "Full planner flow; every lifecycle gate is published before authoring begins.",
    },
    budgets: {
      context_entry_budget: contextPacket.budgets.entry_budget,
      context_entries_used: relevant.activeTickets.length + relevant.ontologyFacts.length + relevant.knowledge.length,
      context_entries_excluded: contextPacket.budgets.excluded_entries,
      context_token_budget: contextPacket.budgets.token_budget,
      context_approximate_tokens: contextPacket.budgets.approximate_tokens,
    },
    gate_contracts: gateContracts,
    persona_guardrails: personaGuardrails,
    ontology_findings: {
      current_invariants: ruleEngine,
      goal_story_context: relevant.ontologyFacts,
      warnings: ontologyWarnings,
    },
    semantic_substrate_contract: gates.includes("reflect-to-validate") ? {
      check_id: "GATE-REF-016",
      intent: "Detect task-relevant semantic contradictions and missing stateful story semantics without treating planner-owned evidence paths as host configuration.",
      artifact_expectation: EXACT_ARTIFACTS["GATE-REF-016"],
      canonical_shape: CANONICAL_SHAPES["GATE-REF-016"],
      source: ".agent/skills/iterative-planner/scripts/verify_gate.mjs + semantic substrate runtime",
    } : null,
    knowledge: {
      entries: relevant.knowledge,
      route_reasons: unique([
        ...workPreflight.knowledge_reasons,
        ...asArray(contextPacket.retrieval_trace?.stages).flatMap((stage) => asArray(stage.basis)),
      ]).slice(0, 12),
      warnings: asArray(contextPacket.warnings),
      source_packet_hash: contextPacket.packet_hash,
    },
    program_context: programContext,
    measured_denial_preemption: gates.length === 0 ? [] : MEASURED_DENIAL_IDS.map((id) => ({
      id,
      artifact: EXACT_ARTIFACTS[id],
      canonical_shape: CANONICAL_SHAPES[id],
      baseline: "L3 attempt 6 retained decision log (2026-07-11)",
    })),
    sources_consulted: unique([
      ".agent/skills/iterative-planner/scripts/planner_preflight.mjs",
      ".agent/skills/iterative-planner/scripts/work_preflight.mjs",
      ".agent/skills/iterative-planner/scripts/context_packet.mjs",
      ".agent/skills/iterative-planner/config/gates.json",
      ".agent/skills/iterative-planner/config/failure-codes.json",
      ".agent/skills/iterative-planner/scripts/verify_gate.mjs",
      ".agent/skills/iterative-planner/scripts/rule_engine.mjs",
      programContext.source,
      ...relevant.ontologyFacts.flatMap((entry) => asArray(entry.source_refs)),
      ...relevant.knowledge.flatMap((entry) => asArray(entry.source_refs)),
    ]),
    excluded_context: asArray(contextPacket.excluded_noise).slice(0, entryBudget).map((entry) => ({
      section: entry.section,
      id: entry.id,
      reason: entry.reason,
    })),
  };
  packet.packet_hash = hashPacket(packet);
  return packet;
}

function mdEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderGuidancePacketMarkdown(packet) {
  const lines = [
    "# Guidance Packet",
    "",
    `- Goal: ${packet.goal || "(none)"}`,
    `- Route: ${packet.route.workflow || "(none)"} (${packet.proportionality.level})`,
    `- Packet hash: \`${packet.packet_hash}\``,
    `- Context budget: ${packet.budgets.context_entries_used}/${packet.budgets.context_entry_budget} entries`,
    "",
    "## Gate Contracts",
    "",
  ];
  if (packet.gate_contracts.length === 0) {
    lines.push(`${packet.proportionality.rationale}.`, "");
  } else {
    for (const gate of packet.gate_contracts) {
      lines.push(`### ${gate.gate}`, "", `Preflight: \`${gate.preflight_command}\``, "", `Command: \`${gate.command}\``, "", `Checks: ${gate.check_ids.map((id) => `\`${id}\``).join(", ")}`, "", "Artifact expectations:");
      for (const artifact of gate.artifact_expectations) lines.push(`- ${artifact}`);
      lines.push("");
    }
  }
  lines.push("## Persona Guardrails", "");
  lines.push(`Active: ${packet.persona_guardrails.active_packs.join(", ") || "none"}`);
  for (const item of packet.persona_guardrails.expectations) lines.push(`- ${item.pack_id}/${item.phase}: ${item.expectation}`);
  for (const item of packet.persona_guardrails.suppressed_or_advisory_packs) lines.push(`- ${item.pack_id}: advisory/non-blocking — ${item.rationale}`);
  lines.push("", "## Ontology And Semantic Substrate", "", `Invariant status: ${packet.ontology_findings.current_invariants.status}`);
  for (const warning of packet.ontology_findings.warnings) lines.push(`- Warning: ${warning}`);
  if (packet.semantic_substrate_contract) lines.push(`- ${packet.semantic_substrate_contract.check_id}: ${packet.semantic_substrate_contract.canonical_shape}`);
  lines.push("", "## Knowledge", "");
  for (const entry of packet.knowledge.entries) lines.push(`- ${entry.id}: ${entry.title} — ${entry.summary}`);
  lines.push("", "## Program Context", "");
  if (!packet.program_context.program) lines.push("No matching Program Packet/ticket context.");
  else {
    lines.push(`Program: ${packet.program_context.program.id} — ${packet.program_context.program.title}`);
    for (const ticket of packet.program_context.tickets) {
      lines.push(`- ${ticket.id}: ${ticket.title} (${ticket.lifecycle || "unknown"})`);
      for (const criterion of ticket.acceptance_criteria) lines.push(`  - ${criterion.id}: ${criterion.text}`);
      for (const row of ticket.verification_rows) lines.push(`  - ${row.id}: ${row.pass_means || row.command_or_action || "verification row"}`);
    }
  }
  lines.push("", "## Measured Denial Preemption", "", "| Check | Artifact | Canonical satisfying shape |", "|---|---|---|");
  for (const item of packet.measured_denial_preemption) lines.push(`| ${mdEscape(item.id)} | ${mdEscape(item.artifact)} | ${mdEscape(item.canonical_shape)} |`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function writeGuidancePacket(packet, {
  cwd = process.cwd(),
  jsonPath = DEFAULT_GUIDANCE_JSON_PATH,
  markdownPath = DEFAULT_GUIDANCE_MD_PATH,
} = {}) {
  const resolvedJson = resolve(cwd, jsonPath);
  const resolvedMarkdown = resolve(cwd, markdownPath);
  mkdirSync(dirname(resolvedJson), { recursive: true });
  mkdirSync(dirname(resolvedMarkdown), { recursive: true });
  writeFileSync(resolvedJson, `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(resolvedMarkdown, renderGuidancePacketMarkdown(packet));
  return {
    json_path: rel(resolve(cwd), resolvedJson),
    markdown_path: rel(resolve(cwd), resolvedMarkdown),
    packet_hash: packet.packet_hash,
  };
}
