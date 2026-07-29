// ive_program_intake.mjs - map ticket-shaped IVE routes to Program Manager intake.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, resolve } from "path";
import { runIntake } from "../program_manager.mjs";
import { validateFactRouting } from "./ive_action_router.mjs";
import { extractNormalizedStoryIdsFromText } from "./planner_canonicalizer.mjs";
import { redactSecrets } from "./provider_client.mjs";
import { verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

const IVE_PROGRAM_INTAKE_SCHEMA_VERSION = 1;
const REQUIRED_TICKET_FIELDS = [
  "source_finding",
  "ontology_fact",
  "concept_guard",
  "valid_next_action",
  "acceptance_criteria",
  "verification_required",
  "stop_condition",
  "recurrence_guard",
];

const ACTION_TICKET_TYPES = Object.freeze({
  fix_now: "feature",
  ticket_now: "feature",
  run_experiment: "research",
  ask_user: "decision",
  accept_limitation: "decision",
  report_only: "documentation",
});

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(asString).filter(Boolean))];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function redactText(value, env = process.env) {
  return redactSecrets(asString(value), env);
}

function redactObject(value, env = process.env) {
  const text = redactSecrets(JSON.stringify(value, null, 2), env);
  try {
    return JSON.parse(text);
  } catch {
    return { redaction_error: "redacted payload was not valid JSON" };
  }
}

function routeOntologyFact(route) {
  return firstNonEmpty(route?.ontology_fact, route?.fact, route?.fact_id, route?.id);
}

function routeNextAction(route) {
  return firstNonEmpty(route?.valid_next_action, route?.next_action);
}

function routeIsTicketShape(route) {
  if (!isPlainObject(route)) return false;
  return route?.program_manager_intake === true
    || route?.program_intake === true
    || route?.ticket_shape === true
    || route?.create_ticket === true
    || routeNextAction(route) === "ticket_now"
    || route?.status === "deferred_with_ticket";
}

function normalizeTextArray(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  const text = asString(value);
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function acceptanceCriteriaForRoute(route) {
  return normalizeTextArray(
    route?.acceptance_criteria
      ?? route?.acceptance
      ?? route?.criteria
      ?? route?.acceptance_criteria_text,
  );
}

function storyRefsForRoute(route, packet) {
  const raw = uniqueStrings([
    ...asArray(route?.story_refs),
    ...asArray(route?.stories),
    ...asArray(packet?.story_refs),
    ...asArray(packet?.intent?.story_refs),
  ]);
  const extracted = extractNormalizedStoryIdsFromText([
    route?.source_finding,
    routeOntologyFact(route),
    route?.concept_guard,
    route?.verification_required,
    route?.stop_condition,
    route?.recurrence_guard,
    ...acceptanceCriteriaForRoute(route),
    ...raw,
  ].filter(Boolean).join("\n"));
  return uniqueStrings([...raw, ...extracted]);
}

function titleFromRoute(route, index) {
  const explicit = firstNonEmpty(route?.ticket_title, route?.title, route?.summary);
  if (explicit) return explicit;
  const fact = routeOntologyFact(route)
    .replace(/^ive_fact\((.*)\)$/i, "$1")
    .replace(/[_(),]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (fact) return `IVE ${fact}`.slice(0, 90);
  return `IVE Program Intake ${index + 1}`;
}

function ticketTypeFromRoute(route) {
  return firstNonEmpty(route?.ticket_type, route?.ticketType, ACTION_TICKET_TYPES[routeNextAction(route)], "feature");
}

function baseTicketTypeFromRoute(route) {
  const explicit = firstNonEmpty(route?.base_ticket_type, route?.baseTicketType, route?.base_type);
  if (explicit) return explicit;
  return ACTION_TICKET_TYPES[routeNextAction(route)] || "feature";
}

function buildIntakeText({ route, acceptanceCriteria, storyRefs }) {
  const lines = [
    `Source finding: ${route.source_finding}`,
    `Ontology fact: ${routeOntologyFact(route)}`,
    `Concept guard: ${route.concept_guard}`,
    `Valid next action: ${routeNextAction(route)}`,
    "Acceptance criteria:",
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    `Verification required: ${route.verification_required}`,
    `Stop condition: ${route.stop_condition}`,
    `Recurrence guard: ${route.recurrence_guard}`,
  ];
  if (storyRefs.length > 0) lines.push(`Story refs: ${storyRefs.join(" ")}`);
  return lines.join("\n");
}

function fieldCoverage(route, acceptanceCriteria, storyRefs) {
  return {
    source_finding: !!asString(route?.source_finding),
    ontology_fact: !!routeOntologyFact(route),
    concept_guard: !!asString(route?.concept_guard),
    valid_next_action: !!routeNextAction(route),
    acceptance_criteria: acceptanceCriteria.length > 0,
    verification_required: !!asString(route?.verification_required),
    stop_condition: !!asString(route?.stop_condition),
    recurrence_guard: !!asString(route?.recurrence_guard),
    story_refs: storyRefs.length > 0,
  };
}

function missingTicketFields(route, acceptanceCriteria) {
  const missing = [];
  if (!asString(route?.source_finding)) missing.push("source_finding");
  if (!routeOntologyFact(route)) missing.push("ontology_fact");
  if (!asString(route?.concept_guard)) missing.push("concept_guard");
  if (!routeNextAction(route)) missing.push("valid_next_action");
  if (acceptanceCriteria.length === 0) missing.push("acceptance_criteria");
  if (!asString(route?.verification_required)) missing.push("verification_required");
  if (!asString(route?.stop_condition)) missing.push("stop_condition");
  if (!asString(route?.recurrence_guard)) missing.push("recurrence_guard");
  return missing;
}

function buildMappingIssue(code, path, message, extra = {}) {
  return { code, path, message, source: "ive_program_intake", ...extra };
}

function mapRouteToIntakeItem(route, index, packet, env = process.env) {
  const acceptanceCriteria = acceptanceCriteriaForRoute(route).map((entry) => redactText(entry, env));
  const storyRefs = storyRefsForRoute(route, packet);
  const missing = missingTicketFields(route, acceptanceCriteria);
  const ontologyFact = routeOntologyFact(route);
  const validNextAction = routeNextAction(route);
  const title = redactText(titleFromRoute(route, index), env);
  const text = redactText(buildIntakeText({
    route,
    acceptanceCriteria,
    storyRefs,
  }), env);
  const item = {
    id: firstNonEmpty(route?.ticket_ref, route?.ticket_id, route?.id, ontologyFact, `ive-route-${index + 1}`),
    title,
    text,
    ticket_type: ticketTypeFromRoute(route),
    type: baseTicketTypeFromRoute(route),
    persona_packs: uniqueStrings(route?.persona_packs || []),
    persona_review: route?.persona_review === true,
  };
  if (item.persona_packs.length === 0) delete item.persona_packs;
  if (item.persona_review === false) delete item.persona_review;
  return {
    route_index: index,
    ontology_fact: ontologyFact,
    valid_next_action: validNextAction,
    title,
    source_fields: {
      source_finding: redactText(route?.source_finding, env),
      ontology_fact: redactText(ontologyFact, env),
      concept_guard: redactText(route?.concept_guard, env),
      valid_next_action: validNextAction,
      acceptance_criteria: acceptanceCriteria,
      verification_required: redactText(route?.verification_required, env),
      stop_condition: redactText(route?.stop_condition, env),
      recurrence_guard: redactText(route?.recurrence_guard, env),
      story_refs: storyRefs,
      ticket_ref: firstNonEmpty(route?.ticket_ref, route?.ticket_id),
    },
    field_coverage: fieldCoverage(route, acceptanceCriteria, storyRefs),
    missing_fields: missing,
    program_manager_item: item,
  };
}

function mapIvePacketToProgramIntake(packet, options = {}) {
  const env = options.env || process.env;
  const routing = validateFactRouting(packet, options.routing || {});
  if (!routing.ok) {
    return {
      ok: false,
      status: "FAIL",
      schema_version: IVE_PROGRAM_INTAKE_SCHEMA_VERSION,
      reason: "ive_packet_routing_failed",
      routing,
      mapping_errors: asArray(routing.errors),
      program_manager_called: false,
      intake_items: [],
      mappings: [],
    };
  }

  const routes = asArray(packet?.fact_routes);
  const mappings = routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => routeIsTicketShape(route))
    .map(({ route, index }) => mapRouteToIntakeItem(route, index, packet, env));

  const mappingErrors = [];
  for (const mapping of mappings) {
    for (const field of mapping.missing_fields) {
      mappingErrors.push(buildMappingIssue(
        "ticket_route_required_field_missing",
        `fact_routes[${mapping.route_index}].${field}`,
        `Ticket-shaped IVE route is missing ${field}`,
        { ontology_fact: mapping.ontology_fact, field },
      ));
    }
  }

  return {
    ok: mappingErrors.length === 0,
    status: mappingErrors.length === 0 ? "PASS" : "FAIL",
    schema_version: IVE_PROGRAM_INTAKE_SCHEMA_VERSION,
    routing,
    ticket_route_count: mappings.length,
    intake_items: mappings.map((mapping) => mapping.program_manager_item),
    mappings,
    mapping_errors: mappingErrors,
    program_manager_called: false,
  };
}

function resolveProgramPath(cwd, programPath) {
  if (!programPath) return null;
  return isAbsolute(programPath) ? programPath : resolve(cwd, programPath);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, value, env) {
  writeFileSync(path, `${JSON.stringify(redactObject(value, env), null, 2)}\n`, "utf-8");
}

function findById(items, id) {
  return asArray(items).find((item) => asString(item?.id) === asString(id)) || null;
}

function resultItems(intakeResult) {
  if (Array.isArray(intakeResult?.results)) return intakeResult.results;
  if (intakeResult?.candidate_ticket) return [intakeResult];
  return [];
}

function enrichProgramPacket({ programPath, mappings, intakeResult, cwd, env }) {
  const relPath = intakeResult?.program_packet_path || programPath;
  const absPath = resolveProgramPath(cwd, relPath);
  if (!absPath || !existsSync(absPath)) {
    return { updated: false, reason: "program_packet_not_found", path: relPath || null };
  }

  const packet = readJson(absPath);
  const items = resultItems(intakeResult);
  const updatedTickets = [];
  const updatedAcceptanceCriteria = [];
  const updatedVerificationRows = [];

  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index];
    const result = items[index] || {};
    const candidate = result.candidate_ticket || intakeResult?.candidate_tickets?.[index] || null;
    if (!candidate?.id) continue;

    const ticket = findById(packet.tickets, candidate.id);
    if (!ticket) continue;

    ticket.ive_source = {
      schema_version: IVE_PROGRAM_INTAKE_SCHEMA_VERSION,
      route_index: mapping.route_index,
      ...mapping.source_fields,
    };
    ticket.story_refs = uniqueStrings([...(ticket.story_refs || []), ...mapping.source_fields.story_refs]);
    ticket.review_artifacts = [
      ...asArray(ticket.review_artifacts).filter((artifact) => artifact?.kind !== "ive_program_intake_mapping"),
      {
        path: result.intake_artifact_path || intakeResult?.intake_artifact_paths?.[index] || null,
        kind: "ive_program_intake_mapping",
        status: "review_ready",
        generated_at: intakeResult?.run_finished_at || new Date().toISOString(),
      },
    ].filter((artifact) => artifact.path);
    updatedTickets.push(ticket.id);

    for (const acId of asArray(ticket.acceptance_criteria)) {
      const row = findById(packet.acceptance_criteria, acId);
      if (!row) continue;
      row.text = mapping.source_fields.acceptance_criteria.join(" ");
      row.story_refs = uniqueStrings([...(row.story_refs || []), ...mapping.source_fields.story_refs]);
      row.ive_source = {
        ontology_fact: mapping.source_fields.ontology_fact,
        concept_guard: mapping.source_fields.concept_guard,
        valid_next_action: mapping.source_fields.valid_next_action,
      };
      updatedAcceptanceCriteria.push(row.id);
    }

    for (const vmId of asArray(ticket.verification_refs)) {
      const row = findById(packet.verification_matrix, vmId);
      if (!row) continue;
      row.proof_type = row.proof_type || "proof:integration";
      row.command_or_action = mapping.source_fields.verification_required;
      row.pass_means = [
        `IVE verification requirement is satisfied for ${mapping.source_fields.ontology_fact}.`,
        `Stop condition: ${mapping.source_fields.stop_condition}`,
        `Recurrence guard: ${mapping.source_fields.recurrence_guard}`,
      ].join(" ");
      row.ive_source = {
        source_finding: mapping.source_fields.source_finding,
        ontology_fact: mapping.source_fields.ontology_fact,
        concept_guard: mapping.source_fields.concept_guard,
        valid_next_action: mapping.source_fields.valid_next_action,
      };
      updatedVerificationRows.push(row.id);
    }
  }

  writeJson(absPath, packet, env);
  return {
    updated: true,
    program_packet_path: relPath,
    ticket_ids: uniqueStrings(updatedTickets),
    acceptance_criteria_refs: uniqueStrings(updatedAcceptanceCriteria),
    verification_refs: uniqueStrings(updatedVerificationRows),
  };
}

async function runIveProgramIntake(packet, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const write = options.write === true;
  const program = options.program || options.programPath;
  const mapped = mapIvePacketToProgramIntake(packet, { ...options, env });

  if (!mapped.ok) {
    return redactObject({
      ...mapped,
      dry_run: !write,
      write,
      no_direct_github_write: true,
    }, env);
  }

  if (mapped.intake_items.length === 0) {
    return redactObject({
      ...mapped,
      dry_run: !write,
      write,
      status: "PASS",
      ok: true,
      program_manager_called: false,
      ticket_count: 0,
      ticket_intake_receipts: [],
      no_direct_github_write: true,
      message: "No ticket-shaped IVE routes matched Program Manager intake selection.",
    }, env);
  }

  if (!program) throw new Error("Missing program path for IVE Program Manager intake");

  const inputArgs = [
    "intake",
    "--program",
    program,
    "--from-json-array",
    JSON.stringify(mapped.intake_items),
    "--json",
  ];
  if (write) inputArgs.splice(inputArgs.length - 1, 0, "--write");

  const intakeResult = await runIntake(inputArgs, {
    cwd,
    env,
    ghRunner: options.ghRunner,
    gitRunner: options.gitRunner,
    fetchImpl: options.fetchImpl,
    clock: options.clock,
  });

  const write_enrichment = write
    ? enrichProgramPacket({
        programPath: program,
        mappings: mapped.mappings,
        intakeResult,
        cwd,
        env,
      })
    : { updated: false, reason: "dry_run" };

  return redactObject({
    ok: verificationStatusIsPass(intakeResult?.status, "execution"),
    status: intakeResult?.status || "FAIL",
    schema_version: IVE_PROGRAM_INTAKE_SCHEMA_VERSION,
    dry_run: !write,
    write,
    program_manager_called: true,
    no_direct_github_write: true,
    direct_github_creation_allowed: false,
    github_publication: "explicit_publish_required_after_local_ticket_receipt",
    ticket_count: mapped.intake_items.length,
    mapping: mapped,
    program_manager_intake: intakeResult,
    write_enrichment,
    ticket_intake_receipts: asArray(intakeResult?.ticket_intake_receipts || intakeResult?.ticket_intake_receipt),
  }, env);
}

export {
  IVE_PROGRAM_INTAKE_SCHEMA_VERSION,
  REQUIRED_TICKET_FIELDS,
  mapIvePacketToProgramIntake,
  routeIsTicketShape,
  runIveProgramIntake,
};
