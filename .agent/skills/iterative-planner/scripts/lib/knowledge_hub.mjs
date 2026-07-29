function normalizeString(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/");
}

function normalizeRef(value) {
  return String(value || "").trim();
}

function normalizeId(value) {
  return normalizeString(value).replace(/\s+/g, "_");
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function tokenize(value) {
  return normalizeString(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function matchTags(goalText, tags) {
  const normalizedGoal = ` ${normalizeString(goalText)} `;
  return uniqueList((Array.isArray(tags) ? tags : [])
    .map((tag) => normalizeString(tag))
    .filter((tag) => tag && normalizedGoal.includes(` ${tag} `)));
}

function titleSummaryTokens(value) {
  return tokenize(value).slice(0, 12);
}

function commonPrefixLength(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}

function computeTokenSimilarity(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  let best = 0;
  for (const source of leftTokens) {
    for (const candidate of rightTokens) {
      if (source === candidate) {
        best = Math.max(best, 1);
        continue;
      }
      const prefix = commonPrefixLength(source, candidate);
      const similarity = prefix >= 4 ? (prefix / Math.max(source.length, candidate.length)) : 0;
      best = Math.max(best, similarity);
    }
  }
  return best;
}

function humanizeId(value) {
  const cleaned = String(value || "")
    .replace(/^plan:/i, "")
    .replace(/^kb:/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function buildItemKey(item) {
  return `${item.kind}:${item.id}`;
}

function sortItems(items) {
  return [...(Array.isArray(items) ? items : [])]
    .sort((left, right) =>
      (right.score - left.score) ||
      String(left.kind || "").localeCompare(String(right.kind || "")) ||
      String(left.id || "").localeCompare(String(right.id || ""))
    );
}

function pushItem(map, item) {
  if (!item || !item.kind || !item.id) return;
  const key = buildItemKey(item);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      kind: item.kind,
      id: String(item.id),
      title: String(item.title || item.id),
      summary: String(item.summary || ""),
      source_refs: uniqueList((item.source_refs || []).map(normalizeRef)),
      linked_ids: uniqueList(item.linked_ids || []),
      matched_by: uniqueList(item.matched_by || []),
      score: Number(item.score) || 0,
      trust_level: String(item.trust_level || "derived"),
      blocking_capable: item.blocking_capable === true,
    });
    return;
  }

  existing.title = existing.title || item.title || item.id;
  existing.summary = existing.summary || item.summary || "";
  existing.source_refs = uniqueList([...(existing.source_refs || []), ...((item.source_refs || []).map(normalizeRef))]);
  existing.linked_ids = uniqueList([...(existing.linked_ids || []), ...(item.linked_ids || [])]);
  existing.matched_by = uniqueList([...(existing.matched_by || []), ...(item.matched_by || [])]);
  existing.score = Math.max(existing.score || 0, Number(item.score) || 0);
  existing.blocking_capable = existing.blocking_capable || item.blocking_capable === true;
}

function buildRegistryRef(path, id) {
  const normalizedPath = normalizePath(path);
  const normalizedId = String(id || "").trim();
  return normalizedPath && normalizedId ? `${normalizedPath}#${normalizedId}` : normalizedPath || null;
}

function collectSignalIds(values) {
  return uniqueList((Array.isArray(values) ? values : []).map((value) => {
    if (!value || typeof value !== "object") return null;
    return typeof value.id === "string" && value.id.trim()
      ? `${value.kind || value.type || "signal"}:${value.id.trim()}`
      : null;
  }).filter(Boolean));
}

function buildPromptSearchTerms({
  goalText,
  planMatchContext,
  trusted,
  derived,
  verificationObligationSynthesis,
  symmetryHunts,
}) {
  return uniqueList([
    ...tokenize(goalText).slice(0, 8),
    ...((planMatchContext?.storyTags || []).slice(0, 4)),
    ...((planMatchContext?.plannedFiles || []).slice(0, 4).map((filePath) => {
      const normalized = normalizePath(filePath);
      const parts = normalized.split("/");
      return parts[parts.length - 1] || normalized;
    })),
    ...((verificationObligationSynthesis?.obligations || []).slice(0, 3).map((entry) => entry.label || entry.id)),
    ...((symmetryHunts || []).slice(0, 3).map((entry) => entry.label || entry.id)),
    ...trusted.slice(0, 3).map((entry) => entry.title || entry.id),
    ...derived.slice(0, 3).map((entry) => entry.title || entry.id),
  ]).slice(0, 16);
}

function createDraftCandidatePrompt({
  goalText,
  planMatchContext,
  trusted,
  derived,
  verificationObligationSynthesis,
  symmetryHunts,
  gapCheckReason,
}) {
  return {
    stage: "draft_candidate_only",
    reason: gapCheckReason,
    objective: "Ask an outer LLM layer for missed knowledge candidates only after deterministic retrieval is empty or weak.",
    goal: goalText,
    planned_files: uniqueList(planMatchContext?.plannedFiles || []),
    observed_files: uniqueList(planMatchContext?.observedFiles || []),
    trusted_match_ids: trusted.map((entry) => buildItemKey(entry)),
    derived_match_ids: derived.map((entry) => buildItemKey(entry)),
    ontology_signal_ids: collectSignalIds(verificationObligationSynthesis?.obligations),
    symmetry_hunt_ids: (symmetryHunts || []).map((entry) => entry.id).filter(Boolean),
    search_terms: buildPromptSearchTerms({
      goalText,
      planMatchContext,
      trusted,
      derived,
      verificationObligationSynthesis,
      symmetryHunts,
    }),
    constraints: [
      "Return draft candidates only; do not claim they are true.",
      "Prefer concrete ids, file refs, and why-this-might-matter explanations.",
      "Do not create new blockers, invariants, or proof satisfaction from draft output.",
      "Any accepted candidate must be promoted into a deterministic registry or KB surface before it can steer planner truth.",
    ],
    prompt: "Review the goal, file scope, trusted matches, derived matches, ontology signals, and symmetry hunts. Propose up to five missed retros, mistakes, learned obligations, or KB references as draft candidates only, each with why it might matter and which deterministic surface should validate or promote it.",
  };
}

function addLinkedKbRefs(targetMap, items, { trustLevel, kbHeadingMatches }) {
  const KB_DOC_PATHS = new Set([
    "plans/knowledge/index.md",
    "plans/knowledge/mistakes.md",
    "plans/knowledge/patterns.md",
    "plans/knowledge/gotchas.md",
  ]);
  const headingMap = new Map((kbHeadingMatches || []).map((entry) => [
    normalizeRef(`plans/knowledge/${entry.source}`),
    entry,
  ]));

  for (const item of items) {
    for (const ref of item.source_refs || []) {
      if (!String(ref).startsWith("plans/knowledge/")) continue;
      const pathOnly = normalizeRef(String(ref).split("#")[0]);
      if (!KB_DOC_PATHS.has(pathOnly)) continue;
      const headingMatch = headingMap.get(pathOnly) || null;
      const fragment = String(ref).includes("#") ? String(ref).split("#")[1] : "";
      if (!fragment) continue;
      pushItem(targetMap, {
        kind: "kb_ref",
        id: fragment || normalizeId(ref),
        title: humanizeId(fragment || pathOnly.split("/").pop() || ref),
        summary: `Linked knowledge-base reference surfaced from ${item.kind} ${item.id}.`,
        source_refs: [ref],
        linked_ids: [buildItemKey(item)],
        matched_by: [
          `linked_from:${item.kind}:${item.id}`,
          headingMatch ? `kb_heading_terms:${(headingMatch.matched_terms || []).join(",")}` : null,
        ].filter(Boolean),
        score: Math.max(1, Math.round((item.score || 0) * 0.65)),
        trust_level: trustLevel,
        blocking_capable: false,
      });
    }
  }
}

function buildMistakeMatchedBy(mistake) {
  return uniqueList([
    ...((mistake.matched_trigger_families || []).map((value) => `trigger_family:${value}`)),
    ...((mistake.matched_declared_files || []).map((value) => `planned_file:${normalizePath(value)}`)),
    ...((mistake.matched_observed_files || []).map((value) => `observed_file:${normalizePath(value)}`)),
    ...((mistake.matched_terms || []).map((value) => `plan_term:${value}`)),
    ...((mistake.matched_story_tags || []).map((value) => `story_tag:${value}`)),
    ...((mistake.matched_deliverable_kinds || []).map((value) => `deliverable_kind:${value}`)),
  ]);
}

function scoreActiveMistake(mistake) {
  return 100 +
    ((mistake.matched_trigger_families || []).length * 12) +
    ((mistake.matched_declared_files || []).length * 6) +
    ((mistake.matched_observed_files || []).length * 4) +
    ((mistake.matched_terms || []).length * 4) +
    ((mistake.matched_story_tags || []).length * 3) +
    ((mistake.matched_deliverable_kinds || []).length * 3);
}

function buildObligationMatchedBy(obligation) {
  return uniqueList([
    obligation.activation_source ? `activation_source:${obligation.activation_source}` : null,
    ...((obligation.matched_trigger_families || []).map((value) => `trigger_family:${value}`)),
    ...((obligation.matched_declared_files || []).map((value) => `planned_file:${normalizePath(value)}`)),
    ...((obligation.matched_observed_files || []).map((value) => `observed_file:${normalizePath(value)}`)),
    ...((obligation.matched_terms || []).map((value) => `plan_term:${value}`)),
    ...((obligation.matched_story_tags || []).map((value) => `story_tag:${value}`)),
    ...((obligation.guard_types || []).map((value) => `guard_type:${value}`)),
  ]);
}

function scoreActiveObligation(obligation) {
  return 88 +
    ((obligation.matched_trigger_families || []).length * 10) +
    ((obligation.matched_declared_files || []).length * 5) +
    ((obligation.matched_observed_files || []).length * 3) +
    ((obligation.matched_terms || []).length * 3) +
    ((obligation.guard_types || []).length * 2);
}

function buildRetroMatchedBy(retro, trustedReasons) {
  const matches = [];
  for (const reason of trustedReasons.length > 0 ? trustedReasons : (retro.reasons || [])) {
    if (String(reason || "").trim()) matches.push(`retro_reason:${reason}`);
  }
  for (const mistakeId of retro.matched_mistakes || []) {
    matches.push(`linked_mistake:${mistakeId}`);
  }
  for (const tag of retro.matched_tags || []) {
    matches.push(`tag_overlap:${tag}`);
  }
  for (const ref of retro.matched_kb_refs || []) {
    matches.push(`kb_ref_overlap:${ref}`);
  }
  return uniqueList(matches);
}

function isTrustedRetroReason(reason) {
  const normalized = normalizeString(reason);
  return normalized.startsWith("direct retro ref") ||
    normalized.startsWith("kb ref overlap") ||
    normalized.startsWith("affected surface overlap") ||
    normalized.startsWith("promotion overlap");
}

function collectSimilarityTerms({
  goalText,
  symmetryHunts,
  verificationObligationSynthesis,
}) {
  return uniqueList([
    ...tokenize(goalText),
    ...((symmetryHunts || []).flatMap((entry) => titleSummaryTokens(`${entry?.id || ""} ${entry?.label || ""}`))),
    ...((verificationObligationSynthesis?.obligations || []).flatMap((entry) => titleSummaryTokens(`${entry?.id || ""} ${entry?.label || ""}`))),
  ]);
}

function hasMinimumDerivedAnchor({
  goalMatches = [],
  fileMatches = [],
  similarityOverlap = [],
  titleSimilarity = 0,
}) {
  const strongAnchors = uniqueList([
    fileMatches.length > 0 ? "file_scope" : null,
    goalMatches.length >= 2 ? "goal_cluster" : null,
    similarityOverlap.length >= 2 ? "ontology_cluster" : null,
    titleSimilarity >= 0.84 ? "title_similarity" : null,
  ]);
  const supportedSingleAnchor =
    goalMatches.length >= 1 &&
    (fileMatches.length > 0 || similarityOverlap.length > 0 || titleSimilarity >= 0.78);

  return {
    accepted: strongAnchors.length > 0 || supportedSingleAnchor,
    anchors: strongAnchors.length > 0 ? strongAnchors : supportedSingleAnchor ? ["supported_single_anchor"] : [],
  };
}

function scoreDerivedMistakeCandidate(mistake, {
  goalText,
  planMatchContext,
  symmetryHunts,
  verificationObligationSynthesis,
}) {
  const goalMatches = matchTags(goalText, [mistake.title, mistake.summary, ...(mistake.query_tags || [])]);
  const partialFileMatches = uniqueList([
    ...(mistake.triggers?.file_globs || []),
  ]).filter((glob) => (planMatchContext?.effectiveFiles || []).some((filePath) => {
    const normalizedGlob = normalizeString(glob);
    const normalizedPath = normalizeString(filePath);
    return normalizedGlob && normalizedPath && normalizedPath.includes(normalizedGlob.replace(/\s+/g, " "));
  }));
  const similarityTerms = collectSimilarityTerms({
    goalText,
    symmetryHunts,
    verificationObligationSynthesis,
  });
  const titleSimilarity = computeTokenSimilarity(goalText, `${mistake.title || ""} ${mistake.summary || ""}`);
  const similarityOverlap = similarityTerms.filter((term) =>
    titleSummaryTokens(`${mistake.title || ""} ${mistake.summary || ""} ${(mistake.query_tags || []).join(" ")}`).includes(term)
  );

  const matchedBy = uniqueList([
    ...goalMatches.map((value) => `goal_overlap:${value}`),
    ...partialFileMatches.map((value) => `near_file_glob:${value}`),
    ...similarityOverlap.map((value) => `ontology_similarity:${value}`),
    titleSimilarity >= 0.72 ? `title_similarity:${titleSimilarity.toFixed(2)}` : null,
  ]);
  const anchorProfile = hasMinimumDerivedAnchor({
    goalMatches,
    fileMatches: partialFileMatches,
    similarityOverlap,
    titleSimilarity,
  });

  const score = (goalMatches.length * 18) +
    (partialFileMatches.length * 10) +
    (similarityOverlap.length * 6) +
    (titleSimilarity >= 0.72 ? 10 : 0);

  return {
    matchedBy: uniqueList([
      ...matchedBy,
      ...anchorProfile.anchors.map((value) => `derived_anchor:${value}`),
    ]),
    score,
    accepted: anchorProfile.accepted,
  };
}

function scoreDerivedObligationCandidate(obligation, {
  goalText,
  symmetryHunts,
  verificationObligationSynthesis,
}) {
  const goalMatches = matchTags(goalText, [
    obligation.id,
    obligation.subject_id,
    obligation.verification_mode,
    ...(obligation.guard_types || []),
  ]);
  const similarityTerms = collectSimilarityTerms({
    goalText,
    symmetryHunts,
    verificationObligationSynthesis,
  });
  const detailText = `${obligation.id} ${obligation.subject_id} ${obligation.verification_mode} ${(obligation.guard_types || []).join(" ")}`;
  const similarityOverlap = similarityTerms.filter((term) => titleSummaryTokens(detailText).includes(term));
  const similarity = computeTokenSimilarity(goalText, detailText);

  const matchedBy = uniqueList([
    ...goalMatches.map((value) => `goal_overlap:${value}`),
    ...similarityOverlap.map((value) => `ontology_similarity:${value}`),
    similarity >= 0.72 ? `title_similarity:${similarity.toFixed(2)}` : null,
  ]);
  const anchorProfile = hasMinimumDerivedAnchor({
    goalMatches,
    similarityOverlap,
    titleSimilarity: similarity,
  });
  const score = (goalMatches.length * 16) + (similarityOverlap.length * 6) + (similarity >= 0.72 ? 10 : 0);
  return {
    matchedBy: uniqueList([
      ...matchedBy,
      ...anchorProfile.anchors.map((value) => `derived_anchor:${value}`),
    ]),
    score,
    accepted: anchorProfile.accepted,
  };
}

function scoreRetroCandidate(retro, { goalText, effectiveFiles, symmetryHunts, verificationObligationSynthesis }) {
  const goalMatches = matchTags(goalText, [
    retro.title,
    retro.summary,
    ...(retro.tags || []),
  ]);
  const pathMatches = (effectiveFiles || []).filter((filePath) =>
    (retro.affected_surfaces || []).some((surface) => normalizePath(filePath).includes(normalizePath(surface)))
  );
  const similarityTerms = collectSimilarityTerms({
    goalText,
    symmetryHunts,
    verificationObligationSynthesis,
  });
  const retroText = `${retro.title || ""} ${retro.summary || ""} ${(retro.tags || []).join(" ")}`;
  const similarityOverlap = similarityTerms.filter((term) => titleSummaryTokens(retroText).includes(term));
  const similarity = computeTokenSimilarity(goalText, retroText);

  const matchedBy = uniqueList([
    ...goalMatches.map((value) => `goal_overlap:${value}`),
    ...pathMatches.map((value) => `affected_surface:${normalizePath(value)}`),
    ...similarityOverlap.map((value) => `ontology_similarity:${value}`),
    similarity >= 0.72 ? `title_similarity:${similarity.toFixed(2)}` : null,
  ]);
  const anchorProfile = hasMinimumDerivedAnchor({
    goalMatches,
    fileMatches: pathMatches,
    similarityOverlap,
    titleSimilarity: similarity,
  });
  const score = (goalMatches.length * 16) + (pathMatches.length * 14) + (similarityOverlap.length * 6) + (similarity >= 0.72 ? 10 : 0);

  return {
    matchedBy: uniqueList([
      ...matchedBy,
      ...anchorProfile.anchors.map((value) => `derived_anchor:${value}`),
    ]),
    score,
    hasExactPathOverlap: pathMatches.length > 0,
    accepted: anchorProfile.accepted,
  };
}

function createKbHeadingItem(match) {
  return {
    kind: "kb_ref",
    id: normalizeId(`${match.source}:${match.heading}`),
    title: match.heading,
    summary: `Knowledge-base heading matched goal terms: ${(match.matched_terms || []).join(", ")}.`,
    source_refs: [`plans/knowledge/${match.source}`],
    linked_ids: [],
    matched_by: (match.matched_terms || []).map((value) => `kb_heading_term:${value}`),
    score: 18 + ((match.matched_terms || []).length * 6),
    trust_level: "derived",
    blocking_capable: false,
  };
}

export function buildKnowledgeHub({
  goalText = "",
  planMatchContext = {},
  kbHeadingMatches = [],
  mistakeRegistry = null,
  mistakeSignal = null,
  obligationsRegistry = null,
  obligationsSignal = null,
  retroRegistry = null,
  relatedRetros = [],
  verificationObligationSynthesis = null,
  symmetryHunts = [],
} = {}) {
  const trustedMap = new Map();
  const derivedMap = new Map();
  const trustedRegistryRef = buildRegistryRef(".agent/skills/iterative-planner/config/mistake_registry.json", "mistakes");
  const learnedRegistryRef = buildRegistryRef(".agent/skills/iterative-planner/config/learned_obligations.json", "obligations");
  const retroLedgerRef = buildRegistryRef("plans/knowledge/retros/retro_ledger.json", "retros");

  for (const mistake of mistakeSignal?.active_mistakes || []) {
    pushItem(trustedMap, {
      kind: "mistake",
      id: mistake.id,
      title: mistake.title,
      summary: mistake.summary,
      source_refs: uniqueList([
        buildRegistryRef(".agent/skills/iterative-planner/config/mistake_registry.json", mistake.id),
        ...(mistake.kb_refs || []),
      ]),
      linked_ids: uniqueList([
        ...(mistake.retro_refs || []),
        ...(mistake.obligation_ids || []),
      ]),
      matched_by: buildMistakeMatchedBy(mistake),
      score: scoreActiveMistake(mistake),
      trust_level: "trusted",
      blocking_capable: true,
    });
  }

  for (const obligation of obligationsSignal?.active_obligations || []) {
    const tier = (obligation.source_registry_degraded || obligation.activation_source === "fallback_triggers")
      ? "derived"
      : "trusted";
    pushItem(tier === "trusted" ? trustedMap : derivedMap, {
      kind: "learned_obligation",
      id: obligation.id,
      title: humanizeId(obligation.subject_id || obligation.id),
      summary: `${obligation.verification_mode} evidence is required by ${obligation.required_by_phase || "reflect"} for ${obligation.subject_id || obligation.id}.`,
      source_refs: uniqueList([
        buildRegistryRef(".agent/skills/iterative-planner/config/learned_obligations.json", obligation.id),
        ...(obligation.kb_refs || []),
      ]),
      linked_ids: uniqueList([
        obligation.source_mistake,
        obligation.subject_id,
      ]),
      matched_by: buildObligationMatchedBy(obligation),
      score: scoreActiveObligation(obligation),
      trust_level: tier,
      blocking_capable: tier === "trusted",
    });
  }

  const trustedRetroIds = new Set();
  for (const retro of relatedRetros || []) {
    const trustedReasons = (retro.reasons || []).filter(isTrustedRetroReason);
    const tier = trustedReasons.length > 0 ? "trusted" : "derived";
    if (tier === "trusted") trustedRetroIds.add(retro.id);
    pushItem(tier === "trusted" ? trustedMap : derivedMap, {
      kind: "retro",
      id: retro.id,
      title: retro.title,
      summary: retro.summary || retro.root_cause || "",
      source_refs: uniqueList([
        buildRegistryRef("plans/knowledge/retros/retro_ledger.json", retro.id),
        retro.case_file ? normalizePath(retro.case_file) : null,
        ...(retro.kb_refs || []),
      ]),
      linked_ids: uniqueList([
        ...(retro.matched_mistakes || []),
        ...(retro.promotions?.mistake_ids || []),
        ...(retro.promotions?.obligation_ids || []),
      ]),
      matched_by: buildRetroMatchedBy(retro, trustedReasons),
      score: Math.max(retro.score || 0, trustedReasons.length > 0 ? 104 : 44),
      trust_level: tier,
      blocking_capable: false,
    });
  }

  const activeMistakeIds = new Set((mistakeSignal?.active_mistakes || []).map((entry) => entry.id));
  const activeObligationIds = new Set((obligationsSignal?.active_obligations || []).map((entry) => entry.id));
  for (const retro of retroRegistry?.accepted_retros || []) {
    if (trustedRetroIds.has(retro.id)) continue;
    const promotionMistakeOverlap = (retro.promotions?.mistake_ids || []).filter((id) => activeMistakeIds.has(id));
    const promotionObligationOverlap = (retro.promotions?.obligation_ids || []).filter((id) => activeObligationIds.has(id));
    if (promotionMistakeOverlap.length === 0 && promotionObligationOverlap.length === 0) continue;

    trustedRetroIds.add(retro.id);
    pushItem(trustedMap, {
      kind: "retro",
      id: retro.id,
      title: retro.title,
      summary: retro.summary || retro.root_cause || "",
      source_refs: uniqueList([
        buildRegistryRef("plans/knowledge/retros/retro_ledger.json", retro.id),
        retro.case_file ? normalizePath(retro.case_file) : null,
        ...(retro.kb_refs || []),
      ]),
      linked_ids: uniqueList([
        ...promotionMistakeOverlap,
        ...promotionObligationOverlap,
      ]),
      matched_by: uniqueList([
        ...promotionMistakeOverlap.map((id) => `retro_promotion:mistake:${id}`),
        ...promotionObligationOverlap.map((id) => `retro_promotion:learned_obligation:${id}`),
      ]),
      score: 112 + (promotionMistakeOverlap.length * 10) + (promotionObligationOverlap.length * 10),
      trust_level: "trusted",
      blocking_capable: false,
    });
  }

  for (const mistake of mistakeRegistry?.mistakes || []) {
    if (activeMistakeIds.has(mistake.id)) continue;
    const candidate = scoreDerivedMistakeCandidate(mistake, {
      goalText,
      planMatchContext,
      symmetryHunts,
      verificationObligationSynthesis,
    });
    if (!candidate.accepted || candidate.score < 24) continue;
    pushItem(derivedMap, {
      kind: "mistake",
      id: mistake.id,
      title: mistake.title,
      summary: mistake.summary,
      source_refs: uniqueList([
        buildRegistryRef(".agent/skills/iterative-planner/config/mistake_registry.json", mistake.id),
        ...(mistake.kb_refs || []),
      ]),
      linked_ids: uniqueList([
        ...(mistake.retro_refs || []),
        ...(mistake.obligation_ids || []),
      ]),
      matched_by: candidate.matchedBy,
      score: candidate.score,
      trust_level: "derived",
      blocking_capable: false,
    });
  }

  for (const obligation of obligationsRegistry?.obligations || []) {
    if (activeObligationIds.has(obligation.id)) continue;
    const candidate = scoreDerivedObligationCandidate(obligation, {
      goalText,
      symmetryHunts,
      verificationObligationSynthesis,
    });
    if (!candidate.accepted || candidate.score < 22) continue;
    pushItem(derivedMap, {
      kind: "learned_obligation",
      id: obligation.id,
      title: humanizeId(obligation.subject_id || obligation.id),
      summary: `${obligation.verification_mode} evidence candidate for ${obligation.subject_id}.`,
      source_refs: uniqueList([
        buildRegistryRef(".agent/skills/iterative-planner/config/learned_obligations.json", obligation.id),
        obligation.source_kb_ref,
      ]),
      linked_ids: uniqueList([
        obligation.source_mistake,
        obligation.subject_id,
      ]),
      matched_by: candidate.matchedBy,
      score: candidate.score,
      trust_level: "derived",
      blocking_capable: false,
    });
  }

  for (const retro of retroRegistry?.accepted_retros || []) {
    const key = `retro:${retro.id}`;
    if (trustedMap.has(key) || derivedMap.has(key)) continue;
    const candidate = scoreRetroCandidate(retro, {
      goalText,
      effectiveFiles: planMatchContext?.effectiveFiles || [],
      symmetryHunts,
      verificationObligationSynthesis,
    });
    if (!candidate.accepted || candidate.score < 22) continue;
    pushItem(candidate.hasExactPathOverlap ? trustedMap : derivedMap, {
      kind: "retro",
      id: retro.id,
      title: retro.title,
      summary: retro.summary || retro.root_cause || "",
      source_refs: uniqueList([
        buildRegistryRef("plans/knowledge/retros/retro_ledger.json", retro.id),
        retro.case_file ? normalizePath(retro.case_file) : null,
        ...(retro.kb_refs || []),
      ]),
      linked_ids: uniqueList([
        ...(retro.promotions?.mistake_ids || []),
        ...(retro.promotions?.obligation_ids || []),
      ]),
      matched_by: candidate.matchedBy,
      score: candidate.hasExactPathOverlap ? Math.max(96, candidate.score) : candidate.score,
      trust_level: candidate.hasExactPathOverlap ? "trusted" : "derived",
      blocking_capable: false,
    });
  }

  for (const match of kbHeadingMatches || []) {
    pushItem(derivedMap, createKbHeadingItem(match));
  }

  const trusted = sortItems([...trustedMap.values()]).slice(0, 12);
  const derived = sortItems([...derivedMap.values()])
    .filter((item) => !trustedMap.has(buildItemKey(item)))
    .slice(0, 12);

  const trustedKbMap = new Map();
  addLinkedKbRefs(trustedKbMap, trusted, { trustLevel: "trusted", kbHeadingMatches });
  for (const item of trustedKbMap.values()) pushItem(trustedMap, item);

  const derivedKbMap = new Map();
  addLinkedKbRefs(derivedKbMap, derived, { trustLevel: "derived", kbHeadingMatches });
  for (const item of derivedKbMap.values()) {
    if (!trustedMap.has(buildItemKey(item))) pushItem(derivedMap, item);
  }

  const finalTrusted = sortItems([...trustedMap.values()]).slice(0, 12);
  const finalDerived = sortItems([...derivedMap.values()])
    .filter((item) => !trustedMap.has(buildItemKey(item)))
    .slice(0, 12);
  const draft = [];

  const trustedScoreTotal = finalTrusted.reduce((sum, item) => sum + (item.score || 0), 0);
  const strongTrusted = finalTrusted.some((item) =>
    item.blocking_capable === true ||
    (item.kind !== "kb_ref" && (item.score || 0) >= 100)
  );
  const gapCheckReason = finalTrusted.length === 0
    ? "no_trusted_matches"
    : strongTrusted
      ? null
      : "trusted_matches_weak";
  const gapCheckNeeded = !!gapCheckReason;

  const trustSummary = {
    trusted_count: finalTrusted.length,
    trusted_score_total: trustedScoreTotal,
    trusted_blocking_capable_count: finalTrusted.filter((item) => item.blocking_capable).length,
    derived_count: finalDerived.length,
    derived_score_total: finalDerived.reduce((sum, item) => sum + (item.score || 0), 0),
    draft_count: draft.length,
    strongest_signal: strongTrusted
      ? "strong_deterministic"
      : finalTrusted.length > 0
        ? "weak_deterministic"
        : "no_deterministic_match",
    gap_check_needed: gapCheckNeeded,
    gap_check_reason: gapCheckReason,
  };

  const retrievalTrace = {
    stages: [
      {
        stage: "exact",
        trust_level: "trusted",
        basis: [
          "active mistake triggers",
          "explicit linked obligations",
          "retro promotions",
          "planned files",
          "observed files",
          "linked KB refs",
        ],
        item_count: finalTrusted.length,
        item_ids: finalTrusted.map((entry) => buildItemKey(entry)),
      },
      {
        stage: "derived",
        trust_level: "derived",
        basis: [
          "ontology/prolog challenge signals",
          "symmetry hunts",
          "bounded similarity over titles",
          "bounded similarity over query_tags",
          "bounded similarity over affected surfaces",
        ],
        item_count: finalDerived.length,
        item_ids: finalDerived.map((entry) => buildItemKey(entry)),
      },
      {
        stage: "draft",
        trust_level: "draft",
        basis: [
          "outer-agent draft gap check only when trusted retrieval is empty or weak",
        ],
        item_count: draft.length,
        item_ids: [],
        invoked: gapCheckNeeded,
        reason: gapCheckReason,
      },
    ],
    consulted_sources: uniqueList([
      trustedRegistryRef,
      learnedRegistryRef,
      retroLedgerRef,
      ...(kbHeadingMatches.length > 0 ? ["plans/knowledge/index.md"] : []),
    ]).filter(Boolean),
    route_guardrail: "Only trusted and ontology-backed matches may steer hard planner behavior. Derived matches are advisory. Draft candidates stay non-blocking until promoted into deterministic truth.",
    routing_inputs: {
      trusted_match_ids: finalTrusted.map((entry) => buildItemKey(entry)),
      derived_match_ids: finalDerived.map((entry) => buildItemKey(entry)),
      blocker_capable_match_ids: finalTrusted.filter((entry) => entry.blocking_capable).map((entry) => buildItemKey(entry)),
      advisory_only_match_ids: [
        ...finalDerived.map((entry) => buildItemKey(entry)),
        ...draft.map((entry) => buildItemKey(entry)),
      ],
    },
  };

  return {
    matches: {
      trusted: finalTrusted,
      derived: finalDerived,
      draft,
    },
    gap_check_needed: gapCheckNeeded,
    draft_candidate_prompt: gapCheckNeeded
      ? createDraftCandidatePrompt({
          goalText,
          planMatchContext,
          trusted: finalTrusted,
          derived: finalDerived,
          verificationObligationSynthesis,
          symmetryHunts,
          gapCheckReason,
        })
      : null,
    retrieval_trace: retrievalTrace,
    trust_summary: trustSummary,
    recommended_path_provenance: retrievalTrace.routing_inputs,
  };
}
