// knowledge_receipt.mjs - Shared Knowledge Receipt projection for decision surfaces.
// @planner:module = knowledge_receipt_contract
// @planner:capability = renders_applied_kb_pack_guard_na_waiver_risk_receipts

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(asString).filter(Boolean))];
}

function normalizeId(value) {
  return asString(value).replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizePackId(value) {
  return normalizeId(value).toLowerCase();
}

function normalizeKbId(value) {
  const raw = asString(value);
  if (!raw) return "";
  const direct = raw.match(/\b(M-[A-Z]+-\d{3}|M-\d{3}|G-\d{3}|P-\d{3}|R-\d{4}-\d{2}-\d{2}-\d{3})\b/i);
  if (direct) return direct[1].toUpperCase();

  const encoded = raw.toLowerCase();
  const encodedSimple = encoded.match(/(?:^|[_\-/])(m|g|p)_(\d{3})(?:[_\-/]|$)/);
  if (encodedSimple) return `${encodedSimple[1].toUpperCase()}-${encodedSimple[2]}`;
  const encodedRetro = encoded.match(/(?:^|[_\-/])r_(\d{4})_(\d{2})_(\d{2})_(\d{3})(?:[_\-/]|$)/);
  if (encodedRetro) return `R-${encodedRetro[1]}-${encodedRetro[2]}-${encodedRetro[3]}-${encodedRetro[4]}`;
  return "";
}

export function extractKnowledgeIdsFromText(value) {
  const text = asString(value);
  if (!text) return [];
  const ids = [];
  const directPattern = /\b(M-[A-Z]+-\d{3}|M-\d{3}|G-\d{3}|P-\d{3}|R-\d{4}-\d{2}-\d{2}-\d{3})\b/gi;
  for (const match of text.matchAll(directPattern)) ids.push(normalizeKbId(match[1]));

  const kbAppliedPattern = /\[KB_APPLIED:([^\]]+)\]/gi;
  for (const match of text.matchAll(kbAppliedPattern)) ids.push(normalizeKbId(match[1]));
  return uniqueStrings(ids);
}

function normalizeArtifactRef(value) {
  if (typeof value === "string") {
    return { path: value };
  }
  if (!value || typeof value !== "object") return null;
  const ref = {
    path: asString(value.path || value.artifact_path || value.ref),
    kind: asString(value.kind || value.type),
    status: asString(value.status),
  };
  return Object.fromEntries(Object.entries(ref).filter(([, entry]) => entry));
}

function normalizeWaiver(value) {
  if (typeof value === "string") {
    return { id: normalizeId(value), reason: value };
  }
  if (!value || typeof value !== "object") return null;
  const waiver = {
    id: normalizeId(value.id || value.waiver_id || value.subject),
    subject: asString(value.subject || value.pack_id || value.guard_id),
    reason: asString(value.reason || value.rationale || value.status),
    approved_by: asString(value.approved_by || value.approver),
  };
  return Object.fromEntries(Object.entries(waiver).filter(([, entry]) => entry));
}

function normalizeRisk(value) {
  if (typeof value === "string") {
    return { id: normalizeId(value), reason: value };
  }
  if (!value || typeof value !== "object") return null;
  const risk = {
    id: normalizeId(value.id || value.code || value.source || value.reason),
    source: asString(value.source || value.path),
    status: asString(value.status || value.severity),
    reason: asString(value.reason || value.message || value.summary),
  };
  return Object.fromEntries(Object.entries(risk).filter(([, entry]) => entry));
}

function guardRecord({ id, sourceId = "", sourceType = "", status = "", reason = "", evidenceRefs = [] } = {}) {
  const guardId = normalizeId(id);
  if (!guardId) return null;
  return {
    id: guardId,
    source_id: normalizeId(sourceId),
    source_type: normalizeId(sourceType),
    status: asString(status),
    reason: asString(reason),
    evidence_refs: uniqueStrings(evidenceRefs),
  };
}

function ideaRecord(value) {
  if (typeof value === "string") {
    return { id: normalizeId(value).slice(0, 80), text: value };
  }
  if (!value || typeof value !== "object") return null;
  const text = asString(value.text || value.title || value.summary);
  const idea = {
    id: normalizeId(value.id || value.source_id || text).slice(0, 80),
    source_id: normalizeId(value.source_id || value.ticket_id),
    text,
  };
  if (!idea.id && !idea.text) return null;
  return Object.fromEntries(Object.entries(idea).filter(([, entry]) => entry));
}

function addRecurrenceGuards(records, recurrence) {
  for (const match of asArray(recurrence?.matches)) {
    const sourceId = match?.id || match?.mistake_id || match?.source_id;
    for (const guard of uniqueStrings([
      ...asArray(match?.required_guards),
      ...asArray(match?.guards),
    ])) {
      const record = guardRecord({
        id: guard,
        sourceId,
        sourceType: "retro_recurrence",
        status: match?.status || recurrence?.status,
        evidenceRefs: [
          ...asArray(match?.required_evidence),
          ...asArray(match?.verification_hooks),
          ...asArray(match?.evidence_refs),
        ],
      });
      if (record) records.push(record);
    }
  }
  for (const guard of uniqueStrings(asArray(recurrence?.required_guards))) {
    const record = guardRecord({
      id: guard,
      sourceId: recurrence?.id || "retro_recurrence_check",
      sourceType: "retro_recurrence",
      status: recurrence?.status,
      evidenceRefs: recurrence?.required_evidence || recurrence?.verification_hooks,
    });
    if (record) records.push(record);
  }
}

function addQuantGuards(records, quantGate) {
  for (const guard of asArray(quantGate?.required_guards)) {
    const record = guardRecord({
      id: guard?.id || guard?.guard || guard?.name,
      sourceId: "quant_persona_gate",
      sourceType: "quant_persona_gate",
      status: guard?.status || quantGate?.status,
      reason: guard?.missing_proof || guard?.next_action || guard?.title,
      evidenceRefs: guard?.verification_refs || guard?.required_evidence,
    });
    if (record) records.push(record);
  }
}

function normalizePersonaAuthorityNAs(personaAuthority) {
  const decisions = [
    ...asArray(personaAuthority?.n_a_decisions),
    ...asArray(personaAuthority?.na_decisions),
    ...asArray(personaAuthority?.summary?.n_a_decisions),
  ];
  const records = [];
  for (const decision of decisions) {
    if (typeof decision === "string") {
      const [packId, reason] = decision.split(":");
      records.push({
        pack_id: normalizePackId(packId),
        reason: normalizeId(reason || "not_applicable"),
        rationale: asString(reason || "not applicable"),
      });
      continue;
    }
    if (!decision || typeof decision !== "object") continue;
    const packId = normalizePackId(decision.pack_id || decision.pack || decision.role || decision.id);
    if (!packId) continue;
    records.push({
      pack_id: packId,
      reason: normalizeId(decision.reason || decision.status || "not_applicable"),
      rationale: asString(decision.rationale || decision.n_a_rationale || decision.explanation || decision.reason || decision.status),
    });
  }
  return records;
}

function normalizeNARiskFromQuantGate(quantGate) {
  const status = normalizeId(quantGate?.status).toLowerCase();
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Persona-applicability lifecycle set suppresses records that are not applicable, not required, or skipped.
  if (!["not_applicable", "not_required", "skipped"].includes(status)) return null;
  return {
    pack_id: "quant",
    reason: normalizeId(quantGate?.reason || quantGate?.declared_scope || status),
    rationale: asString(quantGate?.reason || quantGate?.declared_scope || "quant gate not applicable"),
  };
}

function deDuplicateRecords(records, keyFn) {
  const seen = new Set();
  const result = [];
  for (const record of records.filter(Boolean)) {
    const key = keyFn(record);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

export function buildKnowledgeReceipt(options = {}) {
  const ticket = options.ticket || {};
  const source = options.source || {};
  const personaReview = options.personaReview || ticket.persona_review || {};
  const retroRecurrenceCheck = options.retroRecurrenceCheck || options.retro_recurrence_check || null;
  const quantPersonaGate = options.quantPersonaGate || options.quant_persona_gate || null;
  const deterministicBlockers = asArray(options.deterministicBlockers || options.deterministic_blockers);
  const sourceText = [
    options.sourceText,
    options.planContent,
    source?.text,
    source?.title,
    ticket?.title,
    ...asArray(options.evidenceRefs),
    ...asArray(options.kbRefs),
    ...asArray(retroRecurrenceCheck?.matches).flatMap((match) => [
      match?.id,
      match?.source_id,
      match?.kb_ref,
      ...asArray(match?.kb_refs),
      ...asArray(match?.evidence_refs),
    ]),
  ].filter(Boolean).join("\n");

  const appliedPackIds = uniqueStrings([
    ...asArray(options.personaPacks).map(normalizePackId),
    ...asArray(ticket?.persona_packs).map(normalizePackId),
    ...asArray(personaReview?.persona_packs).map(normalizePackId),
    ...asArray(options.personaAuthority?.active).map(normalizePackId),
    ...asArray(options.personaAuthority?.summary?.active).map(normalizePackId),
    ...asArray(options.personaAuthority?.active_packs).map(normalizePackId),
    ...asArray(options.personaAuthority?.summary?.active_packs).map(normalizePackId),
  ]);

  const concreteGuards = [];
  addRecurrenceGuards(concreteGuards, retroRecurrenceCheck);
  addQuantGuards(concreteGuards, quantPersonaGate);
  for (const guard of asArray(options.concreteGuards || options.concrete_guards)) {
    const record = guardRecord({
      id: guard?.id || guard?.guard || guard,
      sourceId: guard?.source_id || guard?.sourceId,
      sourceType: guard?.source_type || guard?.sourceType,
      status: guard?.status,
      reason: guard?.reason,
      evidenceRefs: guard?.evidence_refs || guard?.evidenceRefs,
    });
    if (record) concreteGuards.push(record);
  }

  const nAPacks = [
    ...normalizePersonaAuthorityNAs(options.personaAuthority),
    normalizeNARiskFromQuantGate(quantPersonaGate),
    ...asArray(options.nAPacks || options.n_a_packs),
  ].filter(Boolean).map((entry) => ({
    pack_id: normalizePackId(entry.pack_id || entry.pack || entry.id),
    reason: normalizeId(entry.reason || "not_applicable"),
    rationale: asString(entry.rationale || entry.reason || "not applicable"),
  })).filter((entry) => entry.pack_id);

  const normalizedBlockerRisk = deterministicBlockers.map((blocker) => normalizeRisk({
    id: blocker?.code || blocker?.source || "deterministic_blocker",
    source: blocker?.path || blocker?.source,
    status: "blocking",
    reason: blocker?.message || blocker?.code,
  }));
  const explicitRisk = asArray(options.remainingUnverifiedRisk || options.remaining_unverified_risk).map(normalizeRisk);
  if (normalizeId(options.deterministicStatus || options.deterministic_status) === "not_run_publish_only") {
    explicitRisk.push(normalizeRisk({
      id: "publish_only_no_deterministic_review",
      status: "unverified",
      reason: "Publish mirrors the ticket but does not verify implementation readiness.",
    }));
  }

  const artifactRefs = asArray(options.artifactRefs || options.artifact_refs).map(normalizeArtifactRef).filter(Boolean);
  const sourceRecord = Object.fromEntries(Object.entries({
    surface: asString(source.surface || options.surface),
    kind: asString(source.kind || options.kind),
    title: asString(source.title || ticket?.title),
    ticket_id: asString(source.ticket_id || ticket?.id || options.ticketId),
    plan_dir: asString(source.plan_dir || options.planDir),
    path: asString(source.path),
  }).filter(([, value]) => value));

  const receipt = {
    name: "Knowledge Receipt",
    version: 1,
    source: sourceRecord,
    applied_pack_ids: appliedPackIds,
    applied_kb_ids: uniqueStrings([
      ...extractKnowledgeIdsFromText(sourceText),
      ...asArray(options.appliedKbIds || options.applied_kb_ids).map(normalizeKbId),
    ]),
    concrete_guards: deDuplicateRecords(concreteGuards, (record) => `${record.id}:${record.source_id}:${record.source_type}`),
    concrete_ideas: deDuplicateRecords([
      ...asArray(options.concreteIdeas || options.concrete_ideas).map(ideaRecord),
      ideaRecord({
        id: ticket?.id || source?.title,
        source_id: ticket?.id,
        text: source?.title || ticket?.title,
      }),
    ], (record) => `${record.id}:${record.text}`),
    n_a_packs: deDuplicateRecords(nAPacks, (record) => `${record.pack_id}:${record.reason}`),
    waivers: deDuplicateRecords(asArray(options.waivers).map(normalizeWaiver), (record) => `${record.id}:${record.subject}`),
    remaining_unverified_risk: deDuplicateRecords([
      ...explicitRisk,
      ...normalizedBlockerRisk,
    ], (record) => `${record.id}:${record.source}:${record.reason}`),
    artifact_refs: deDuplicateRecords(artifactRefs, (record) => `${record.kind}:${record.path}`),
  };
  receipt.has_content = [
    receipt.applied_pack_ids,
    receipt.applied_kb_ids,
    receipt.concrete_guards,
    receipt.concrete_ideas,
    receipt.n_a_packs,
    receipt.waivers,
    receipt.remaining_unverified_risk,
    receipt.artifact_refs,
  ].some((list) => list.length > 0);
  return receipt;
}

function summarizeList(values, formatter = (value) => value, maxItems = 3) {
  const items = asArray(values).map(formatter).map(asString).filter(Boolean);
  if (items.length === 0) return "";
  const head = items.slice(0, maxItems).join(",");
  const suffix = items.length > maxItems ? `+${items.length - maxItems}` : "";
  return `${head}${suffix}`;
}

export function renderKnowledgeReceiptText(receipt, { indent = "", maxItems = 3 } = {}) {
  if (!receipt?.has_content) return "";
  const segments = [];
  const packs = summarizeList(receipt.applied_pack_ids, (value) => value, maxItems);
  if (packs) segments.push(`packs=${packs}`);
  const kb = summarizeList(receipt.applied_kb_ids, (value) => value, maxItems);
  if (kb) segments.push(`kb=${kb}`);
  const guards = summarizeList(receipt.concrete_guards, (entry) => entry.id, maxItems);
  if (guards) segments.push(`guards=${guards}`);
  const na = summarizeList(receipt.n_a_packs, (entry) => `${entry.pack_id}:${entry.reason || "n/a"}`, maxItems);
  if (na) segments.push(`n/a=${na}`);
  const waivers = summarizeList(receipt.waivers, (entry) => entry.id || entry.subject, maxItems);
  if (waivers) segments.push(`waivers=${waivers}`);
  const risk = summarizeList(receipt.remaining_unverified_risk, (entry) => entry.id || entry.reason, maxItems);
  if (risk) segments.push(`risk=${risk}`);
  const artifacts = summarizeList(receipt.artifact_refs, (entry) => entry.kind || entry.path, maxItems);
  if (artifacts && segments.length < 4) segments.push(`artifacts=${artifacts}`);
  if (segments.length === 0) return "";
  return `${indent}Knowledge receipt: ${segments.join("; ")}`;
}
