#!/usr/bin/env node
// test_knowledge_triggers.mjs — Knowledge Trigger primitive (ive-ontology-memory).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  loadKnowledgeTriggers,
  computeKnowledgeTriggerSignal,
  validateTrigger,
  evaluateObligationGate,
  selectInsightInjections,
  rankRelevantInsightInjections,
  evaluateRankedInjectionAgainstLegacy,
  captureTrigger,
  promoteTrigger,
  listDraftTriggers,
  loadDraftOverlay,
} from "../scripts/lib/knowledge_triggers.mjs";
import { draftKtFromRetro } from "../scripts/lib/retro_registry.mjs";
import { run as ktCliRun } from "../scripts/knowledge_triggers.mjs";
import { JOURNAL_REL_PATH } from "../scripts/lib/agent_journal.mjs";
import {
  DEFAULT_REAL_EPISODE_CORPUS_PATH,
  loadRealEpisodeCorpus,
} from "../scripts/lib/ive_real_episode_corpus.mjs";

const SHIPPED_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config", "knowledge_triggers.json");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}`); }
}

const TRIGGERS = [
  {
    id: "KT-CMO-PAGE-001", kind: "obligation", title: "CMO review",
    when: { file_globs: ["**/pages/**"], plan_terms: ["create page", "landing page"], story_tags: ["marketing"], minimum_trigger_families: 1 },
    apply: { mode: "inject-or-block", surface: "gate:plan-to-execute" },
    provenance: { trust_level: "trusted" },
  },
  {
    id: "KT-RENDER-CACHE-001", kind: "insight", title: "render cache",
    when: { plan_terms: ["page slow", "render performance"], file_globs: ["**/cache/**"], minimum_trigger_families: 1 },
    apply: { mode: "inject", surface: "phase:explore" },
    provenance: { trust_level: "trusted" },
  },
];

console.log("\nKnowledge Trigger Tests\n");

console.log("[the shipped config loads + validates]");
const loaded = loadKnowledgeTriggers();
assert(loaded.ok && loaded.triggers.length >= 2, "config/knowledge_triggers.json loads with >=2 triggers");
assert(loaded.triggers.every((kt) => validateTrigger(kt).ok), "every shipped KT record is structurally valid");

console.log("\n[planner dogfood false-green incident trigger — fires precisely]");
{
  const dogfoodId = "KT-PLANNER-DOGFOOD-FALSE-GREEN-001";
  const dogfoodGoal = [
    "the planner is not eating its own dogfood",
    "advisor not used",
    "ontology not used",
    "IV not used",
    "health audit missed user stories and north star missing",
  ].join("; ");
  const signal = computeKnowledgeTriggerSignal(loaded.triggers, {
    goalText: dogfoodGoal,
    files: [".agent/skills/iterative-planner/scripts/project_health.mjs"],
  });
  const hit = signal.active.find((a) => a.id === dogfoodId);
  assert(hit?.kind === "obligation" && hit?.apply?.mode === "inject-or-block", "dogfood incident language fires the trusted planner truth-packet obligation");
  assert(hit?.knowledge?.required_evidence?.includes("verification_ledger:planner_truth_packet"), "dogfood KT requires structured planner_truth_packet evidence");

  const falsePositiveGoals = [
    "Improve the North Star dashboard rendering",
    "Write user stories for the onboarding workflow",
    "Run advisor workflow triage for an unrelated CI failure",
    "Refactor project health output formatting",
  ];
  const falsePositiveHits = falsePositiveGoals
    .map((goalText) => computeKnowledgeTriggerSignal(loaded.triggers, { goalText }).active.some((a) => a.id === dogfoodId))
    .filter(Boolean);
  assert(falsePositiveHits.length === 0, "dogfood KT precision fixtures stay quiet on 4 near-miss prompts");
  const fileOnlyHit = computeKnowledgeTriggerSignal(loaded.triggers, {
    goalText: "Update planner workflow migration with US-077 traceability",
    files: [".agent/skills/iterative-planner/scripts/program_manager.mjs"],
  }).active.some((a) => a.id === dogfoodId);
  assert(!fileOnlyHit, "dogfood KT stays quiet for planner-core file changes without incident language");
}

console.log("\n[planner dogfood false-green incident trigger — gate obligation]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-dogfood-"));
  try {
    const goalText = "dogfood failure: false green health audit missed user stories and north star missing";
    writeFileSync(join(tmp, "plan.md"), `# Plan\n\n## Goal\n${goalText}\n\n## Files To Modify\n- .agent/skills/iterative-planner/config/knowledge_triggers.json\n`);
    const before = evaluateObligationGate({
      gate: "plan-to-execute",
      planDir: tmp,
      goalText,
      plannedFiles: [".agent/skills/iterative-planner/config/knowledge_triggers.json"],
    });
    const beforeHit = before.find((o) => o.id === "KT-PLANNER-DOGFOOD-FALSE-GREEN-001");
    assert(beforeHit?.satisfied === false, "dogfood KT blocks plan-to-execute before planner_truth_packet evidence exists");
    assert(beforeHit?.missing_evidence?.includes("verification_ledger:planner_truth_packet"), "dogfood KT reports missing planner_truth_packet evidence");

    const wrongGate = evaluateObligationGate({
      gate: "explore-to-plan",
      planDir: tmp,
      goalText,
      plannedFiles: [".agent/skills/iterative-planner/config/knowledge_triggers.json"],
    });
    assert(wrongGate.every((o) => o.id !== "KT-PLANNER-DOGFOOD-FALSE-GREEN-001"), "dogfood KT is scoped to plan-to-execute");

    writeFileSync(join(tmp, "verification_ledger.json"), JSON.stringify({
      evidence: [
        {
          id: "planner_truth_packet",
          subject_id: "planner_truth_packet",
          mode: "artifact_review",
          status: "PASS",
          evidence_refs: ["reports/planner_truth_packet.json"],
        },
      ],
    }, null, 2));
    const after = evaluateObligationGate({
      gate: "plan-to-execute",
      planDir: tmp,
      goalText,
      plannedFiles: [".agent/skills/iterative-planner/config/knowledge_triggers.json"],
    });
    assert(after.find((o) => o.id === "KT-PLANNER-DOGFOOD-FALSE-GREEN-001")?.satisfied === true, "dogfood KT is satisfied once structured planner_truth_packet evidence is recorded");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n[obligation instance — CMO]");
const onPageWrite = computeKnowledgeTriggerSignal(TRIGGERS, { toolEvent: "Write:src/pages/home.tsx" });
assert(onPageWrite.active.some((a) => a.id === "KT-CMO-PAGE-001"), "a page-write tool event fires the CMO obligation");
const onCreatePage = computeKnowledgeTriggerSignal(TRIGGERS, { goalText: "Create a new landing page for the launch" });
assert(onCreatePage.active.some((a) => a.id === "KT-CMO-PAGE-001" && a.kind === "obligation" && a.apply.mode === "inject-or-block"), "the create-page goal fires the CMO obligation with block-capable apply");

console.log("\n[insight instance — same mechanism, different kind + apply]");
const onSlow = computeKnowledgeTriggerSignal(TRIGGERS, { goalText: "the page renders slowly, investigate render performance" });
assert(onSlow.active.some((a) => a.id === "KT-RENDER-CACHE-001" && a.kind === "insight" && a.apply.mode === "inject"), "a performance goal resurfaces the render-cache insight (inject, not block)");

console.log("\n[no spurious matches]");
const onUnrelated = computeKnowledgeTriggerSignal(TRIGGERS, { goalText: "Refactor the database migration runner", files: ["src/db/migrate.ts"] });
assert(onUnrelated.active.length === 0, "an unrelated goal fires no triggers");

console.log("\n[matched_by provenance + grouping]");
assert(onPageWrite.active[0].matched_by.length > 0, "active triggers carry matched_by families (honest provenance)");
const grouped = computeKnowledgeTriggerSignal(TRIGGERS, { goalText: "create page", toolEvent: "Write:src/pages/a.tsx" });
assert((grouped.by_kind.obligation || 0) >= 1, "signal groups matches by kind");

console.log("\n[trust-tier gates apply-mode — only trusted may block]");
assert(!validateTrigger({ id: "x", kind: "obligation", when: {}, apply: { mode: "block" }, provenance: { trust_level: "draft" } }).ok, "a block-mode KT from a non-trusted source is rejected");
assert(validateTrigger({ id: "y", kind: "insight", when: {}, apply: { mode: "inject" }, provenance: { trust_level: "derived" } }).ok, "a derived insight with inject mode is valid");

console.log("\n[obligation enforcement at the gate — portable, evidence-gated]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-gate-"));
  try {
    writeFileSync(join(tmp, "plan.md"), "# Plan\n\n## Goal\nCreate a new landing page\n\n## Files To Modify\n- src/pages/home.tsx\n");
    const before = evaluateObligationGate({ gate: "plan-to-execute", planDir: tmp, goalText: "Create a new landing page", plannedFiles: ["src/pages/home.tsx"] });
    assert(before.some((o) => o.id === "KT-CMO-PAGE-001" && o.satisfied === false), "CMO obligation BLOCKS plan-to-execute when cmo_review evidence is missing");
    writeFileSync(join(tmp, "decisions.md"), "## Decisions\n- CMO review: cmo_review captured; sign-off recorded.\n");
    const proseOnly = evaluateObligationGate({ gate: "plan-to-execute", planDir: tmp, goalText: "Create a new landing page", plannedFiles: ["src/pages/home.tsx"] });
    assert(proseOnly.some((o) => o.id === "KT-CMO-PAGE-001" && o.satisfied === false), "CMO obligation ignores prose-only cmo_review markers for verification_ledger tokens");
    writeFileSync(join(tmp, "verification_ledger.json"), JSON.stringify({
      evidence: [
        {
          id: "cmo_review",
          subject_id: "cmo_review",
          status: "PASS",
          evidence_refs: ["reports/cmo-review.md"],
        },
      ],
    }, null, 2));
    const after = evaluateObligationGate({ gate: "plan-to-execute", planDir: tmp, goalText: "Create a new landing page", plannedFiles: ["src/pages/home.tsx"] });
    assert(after.some((o) => o.id === "KT-CMO-PAGE-001" && o.satisfied === true), "CMO obligation is SATISFIED once structured verification_ledger evidence is recorded");
    const wrongGate = evaluateObligationGate({ gate: "explore-to-plan", planDir: tmp, goalText: "Create a new landing page", plannedFiles: ["src/pages/home.tsx"] });
    assert(wrongGate.length === 0, "the CMO obligation is surface-scoped — it does not fire at a non-matching gate");
    const unrelated = evaluateObligationGate({ gate: "plan-to-execute", planDir: tmp, goalText: "Refactor the database migration layer", plannedFiles: ["src/db/x.ts"] });
    assert(unrelated.length === 0, "no obligation fires for an unrelated (non-page) plan");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n[journal-memory loading — native wins, legacy seeds fill gaps]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-memory-"));
  try {
    const configPath = join(tmp, "knowledge_triggers.json");
    const overlayPath = join(tmp, "drafts.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      triggers: [
        {
          id: "KT-JOURNAL-WINS",
          kind: "insight",
          title: "legacy title",
          when: { plan_terms: ["legacy term"], minimum_trigger_families: 1 },
          knowledge: { directive: "legacy directive" },
          apply: { mode: "inject", surface: "phase:explore" },
          provenance: { trust_level: "trusted" },
        },
        {
          id: "KT-LEGACY-FILLS",
          kind: "insight",
          title: "legacy fill",
          when: { plan_terms: ["legacy fill"], minimum_trigger_families: 1 },
          knowledge: { directive: "legacy fills missing journal ids" },
          apply: { mode: "inject", surface: "phase:explore" },
          provenance: { trust_level: "trusted" },
        },
      ],
    }, null, 2));
    const journalPath = join(tmp, JOURNAL_REL_PATH);
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, "", { flag: "w" });
    writeFileSync(journalPath, `${JSON.stringify({
      id: "J-KT-001",
      type: "promotion",
      status: "accepted",
      confidence: "operator_policy",
      summary: "Journal-native KT replaces same-id legacy seed.",
      memory_role: "knowledge_trigger",
      payload: {
        id: "KT-JOURNAL-WINS",
        kind: "insight",
        title: "journal title",
        when: { plan_terms: ["journal term"], minimum_trigger_families: 1 },
        knowledge: { directive: "journal directive" },
        apply: { mode: "inject", surface: "phase:explore" },
        provenance: { trust_level: "trusted" },
      },
    })}\n`, { flag: "a" });

    const merged = loadKnowledgeTriggers(configPath, { overlayPath, cwd: tmp });
    assert(merged.ok === true, "journal-memory KT loader succeeds with legacy fallback present");
    assert(merged.triggers.find((kt) => kt.id === "KT-JOURNAL-WINS")?.title === "journal title", "journal-native KT wins over same-id legacy seed");
    assert(merged.triggers.some((kt) => kt.id === "KT-LEGACY-FILLS"), "legacy KT seed fills ids absent from journal memory");
    const fired = computeKnowledgeTriggerSignal(merged.triggers, { goalText: "journal term" });
    assert(fired.active.some((entry) => entry.id === "KT-JOURNAL-WINS"), "journal-native KT keeps unchanged trigger matching behavior");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n[insight injection — the positive-memory half, inject not block]");
{
  const onSlow = selectInsightInjections(TRIGGERS, { goalText: "the page renders slowly, investigate render performance" });
  assert(onSlow.some((a) => a.id === "KT-RENDER-CACHE-001"), "a matching performance goal selects the render-cache insight for injection");
  const onPage = selectInsightInjections(TRIGGERS, { toolEvent: "Write:src/pages/home.tsx", goalText: "create a landing page" });
  assert(!onPage.some((a) => a.id === "KT-CMO-PAGE-001"), "an obligation KT is never surfaced as an insight injection (inject is for insights/strategies only)");
  const onUnrelated2 = selectInsightInjections(TRIGGERS, { goalText: "rename a database column" });
  assert(onUnrelated2.length === 0, "no insight is injected for an unrelated goal");
}

console.log("\n[semantic insight injection — top-3 trusted/derived only, never obligations]");
{
  const paraphrase = selectInsightInjections(TRIGGERS, { goalText: "the page is so slow to render" });
  const renderHit = paraphrase.find((a) => a.id === "KT-RENDER-CACHE-001");
  assert(Boolean(renderHit), "a semantic paraphrase surfaces the render-cache insight even without an exact plan_term");
  assert(renderHit?.matched_by?.some((m) => String(m).startsWith("semantic:")), "semantic hits carry matched_by score provenance");

  const semanticTriggers = [
    ...TRIGGERS,
    {
      id: "KT-SEM-PAINT-001", kind: "strategy", title: "First paint latency triage",
      summary: "When page rendering feels slow, inspect first paint and render cache warmup before deeper profiling.",
      when: { plan_terms: ["first paint latency"], minimum_trigger_families: 1 },
      knowledge: { directive: "Check first paint timing and cache warmup." },
      apply: { mode: "inject", surface: "phase:explore" },
      provenance: { trust_level: "derived" },
    },
    {
      id: "KT-SEM-VIEW-001", kind: "insight", title: "View rendering can hide cache misses",
      summary: "A page that renders slowly may be paying a view-cache miss instead of doing expensive component work.",
      when: { plan_terms: ["view cache miss"], minimum_trigger_families: 1 },
      knowledge: { directive: "Rule out view-cache misses before rewriting the renderer." },
      apply: { mode: "advisory-with-consumer", surface: "phase:explore" },
      provenance: { trust_level: "trusted" },
    },
    {
      id: "KT-SEM-ROUTE-001", kind: "insight", title: "Route render slowness",
      summary: "Route-level rendering slowness often points to render-cache setup or deferred page data.",
      when: { plan_terms: ["route render slowness"], minimum_trigger_families: 1 },
      knowledge: { directive: "Compare route render timing with cache state." },
      apply: { mode: "inject", surface: "phase:explore" },
      provenance: { trust_level: "derived" },
    },
    {
      id: "KT-SEM-BROWSER-001", kind: "strategy", title: "Browser page performance",
      summary: "Slow browser pages usually need render performance and first-paint checks before broad rewrites.",
      when: { plan_terms: ["browser page performance"], minimum_trigger_families: 1 },
      knowledge: { directive: "Start with render performance and first-paint checks." },
      apply: { mode: "inject", surface: "phase:explore" },
      provenance: { trust_level: "trusted" },
    },
    {
      id: "KT-SEM-DRAFT-001", kind: "insight", title: "Draft slow render idea",
      summary: "Draft knowledge about pages that are slow to render should not auto-inject.",
      when: { plan_terms: ["draft slow render"], minimum_trigger_families: 1 },
      knowledge: { directive: "Do not auto-inject drafts." },
      apply: { mode: "inject", surface: "phase:explore" },
      provenance: { trust_level: "draft" },
    },
    {
      id: "KT-SEM-OBL-001", kind: "obligation", title: "Render page review",
      summary: "An obligation that sounds semantically similar must not surface through insight injection.",
      when: { plan_terms: ["render page review"], minimum_trigger_families: 1 },
      knowledge: { directive: "Review render page work.", required_evidence: ["verification_ledger:render_review"] },
      apply: { mode: "inject-or-block", surface: "gate:plan-to-execute" },
      provenance: { trust_level: "trusted" },
    },
  ];
  const bounded = selectInsightInjections(semanticTriggers, { goalText: "the page is so slow to render" });
  assert(bounded.length === 3, "semantic injection is bounded to the top 3 results");
  assert(bounded.every((a) => a.trust_level === "trusted" || a.trust_level === "derived"), "semantic injection surfaces only trusted/derived records");
  assert(!bounded.some((a) => a.id === "KT-SEM-DRAFT-001"), "semantic injection does not surface draft records");
  assert(!bounded.some((a) => a.id === "KT-SEM-OBL-001"), "semantic injection does not surface obligations");

  const tmp = mkdtempSync(join(tmpdir(), "kt-sem-obligation-"));
  try {
    const configPath = join(tmp, "knowledge_triggers.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, triggers: [semanticTriggers.find((t) => t.id === "KT-SEM-OBL-001")] }, null, 2));
    writeFileSync(join(tmp, "plan.md"), "# Plan\n## Goal\nthe page is so slow to render\n");
    const gate = evaluateObligationGate({ gate: "plan-to-execute", planDir: tmp, goalText: "the page is so slow to render", configPath });
    assert(gate.length === 0, "semantic similarity alone never makes an obligation block");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[ranked insight injection — BM25 + graph distance + episode confidence]");
{
  const rankedTriggers = [
    {
      id: "KT-RANK-TEMPORAL-001", kind: "insight", title: "Temporal leakage proof",
      summary: "Temporal model validation needs known-at-time splits, leakage boundaries, and calibration before any result celebration.",
      when: { plan_terms: ["model validation"], file_globs: ["models/**"], minimum_trigger_families: 1 },
      knowledge: { directive: "Check temporal leakage, calibration, and known-at-time evidence before summarizing model results." },
      apply: { mode: "inject", surface: "phase:explore" },
      provenance: { trust_level: "trusted", confidence: "measured", episode_mentions: ["run-a", "run-b", "run-c"] },
      refs: ["src/models/train.ts", "gate:plan-to-execute"],
    },
    {
      id: "KT-RANK-GENERIC-001", kind: "insight", title: "Generic model testing",
      summary: "Model work should have tests and a short report.",
      when: { plan_terms: ["model validation"], minimum_trigger_families: 1 },
      knowledge: { directive: "Run the model tests." },
      apply: { mode: "inject", surface: "phase:explore" },
      provenance: { trust_level: "trusted", confidence: "reported", episode_mentions: ["run-a"] },
      refs: ["docs/model-report.md"],
    },
    {
      id: "KT-RANK-UI-001", kind: "strategy", title: "Responsive page rendering",
      summary: "Page rendering work should verify mobile and desktop visual states.",
      when: { plan_terms: ["page rendering"], minimum_trigger_families: 1 },
      knowledge: { directive: "Capture browser proof before closing UI changes." },
      apply: { mode: "inject", surface: "phase:explore" },
      provenance: { trust_level: "derived", confidence: "inferred", episode_mentions: ["ui-a"] },
      refs: ["src/pages/home.tsx"],
    },
  ];
  const ranked = rankRelevantInsightInjections(rankedTriggers, {
    goalText: "Investigate suspicious model validation before claiming success; overfitting and temporal leakage may be missing from the proof.",
    files: ["src/models/train.ts"],
    gates: ["plan-to-execute"],
    prologFacts: [
      "plan_touches_file(active_plan, src_models_train_ts).",
      "artifact_related(src_models_train_ts, models).",
      "gate_in_transition(plan_to_execute).",
    ],
  }, { limit: 3 });
  assert(ranked[0]?.id === "KT-RANK-TEMPORAL-001", "BM25 + graph + measured episode confidence ranks the temporal leakage insight first");
  assert(ranked[0]?.matched_by?.some((entry) => String(entry).startsWith("bm25:")), "ranked hits carry BM25 score provenance");
  assert(ranked[0]?.matched_by?.some((entry) => String(entry).startsWith("graph:")), "ranked hits carry graph-distance provenance");
  assert(
    ranked[0]?.matched_by?.some((entry) => String(entry).startsWith("episodes:")) && ranked[0]?.episode_mentions >= 3,
    "ranked hits carry repeated-episode provenance"
  );
  const selected = selectInsightInjections(rankedTriggers, {
    goalText: "Investigate suspicious model validation before claiming success; temporal leakage may be missing.",
    files: ["src/models/train.ts"],
  });
  assert(selected[0]?.id === "KT-RANK-TEMPORAL-001", "selectInsightInjections uses ranked retrieval for planning-time positive memory");
}

console.log("\n[ranked vs legacy injection — 14 real corpus plans]");
{
  const loadedCorpus = loadRealEpisodeCorpus(DEFAULT_REAL_EPISODE_CORPUS_PATH);
  const episodes = loadedCorpus.corpus.episodes;
  const familyLabel = (value) => String(value || "").replace(/_/g, " ");
  const triggers = episodes.map((episode, index) => ({
    id: `KT-REAL-${String(index + 1).padStart(2, "0")}-${episode.id}`,
    kind: "insight",
    title: episode.knowledge_trigger.title,
    summary: [
      episode.title,
      episode.finding_summary,
      episode.aha_pattern,
      episode.route?.verification_required,
      episode.route?.concept_guard,
    ].filter(Boolean).join(" "),
    when: {
      plan_terms: [familyLabel(episode.family), "quant verification"],
      file_globs: [`**/${episode.source_refs?.[0]?.source_path || "plans/knowledge/**"}`],
      minimum_trigger_families: 1,
    },
    knowledge: { directive: episode.knowledge_trigger.directive },
    apply: { mode: "inject", surface: "phase:explore" },
    provenance: {
      trust_level: "trusted",
      confidence: episode.quant_guard ? "measured" : "reported",
      episode_mentions: [episode.id, ...(episode.source_refs || []).map((ref) => ref.evidence_id).filter(Boolean)],
    },
    refs: (episode.source_refs || []).map((ref) => ref.source_path),
  }));
  const cases = episodes.map((episode, index) => ({
    id: episode.id,
    expected_id: triggers[index].id,
    goalText: [
      episode.title,
      episode.finding_summary,
      episode.route?.verification_required,
      episode.route?.concept_guard,
    ].filter(Boolean).join(" "),
    files: (episode.source_refs || []).map((ref) => ref.source_path),
  }));
  const evalResult = evaluateRankedInjectionAgainstLegacy(triggers, cases, { limit: 3 });
  console.log(`  side-by-side: cases=${evalResult.case_count}, ranked_hits=${evalResult.ranked_top_n_hits}, legacy_hits=${evalResult.legacy_top_n_hits}`);
  assert(evalResult.case_count >= 10, "side-by-side evaluation covers at least 10 real corpus plans");
  assert(evalResult.ranked_top_n_hits === evalResult.case_count, "ranked retrieval surfaces the expected real-episode knowledge in top-N for every case");
  assert(evalResult.ranked_top_n_hits >= evalResult.legacy_top_n_hits, "ranked retrieval recall is no worse than legacy trigger matching");
  assert(evalResult.ranked_top_n_hits > evalResult.legacy_top_n_hits, "ranked retrieval improves over legacy exact trigger matching on the real corpus fixture");
}

console.log("\n[capture — agent-proposed draft is inert until promoted (sc_1)]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-cap-"));
  const overlayPath = join(tmp, "drafts.json");
  try {
    const cap = captureTrigger(
      { id: "KT-CAP-INSIGHT-1", kind: "insight", title: "cache insight", when: { plan_terms: ["render performance"] }, knowledge: { directive: "warm the cache" }, apply: { mode: "inject" } },
      { overlayPath }
    );
    assert(cap.ok && cap.written === 1, "capture writes one draft to the overlay");
    const ov = loadDraftOverlay(overlayPath);
    assert(ov.triggers[0]?.provenance?.trust_level === "draft", "captured record is hard-stamped trust_level:draft");
    // Inert on the inject path: a draft is never auto-surfaced.
    const merged = loadKnowledgeTriggers(SHIPPED_CONFIG, { overlayPath });
    const injected = selectInsightInjections(merged.triggers, { goalText: "investigate render performance" });
    assert(!injected.some((a) => a.id === "KT-CAP-INSIGHT-1"), "a draft is NOT surfaced by selectInsightInjections (inert until promoted)");
    // But it IS matchable (so the resurfacer/list can find it).
    const signal = computeKnowledgeTriggerSignal(merged.triggers, { goalText: "investigate render performance" });
    assert(signal.active.some((a) => a.id === "KT-CAP-INSIGHT-1"), "a draft is still matchable (the resurfacer can find it)");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[capture — a blocking apply.mode FAILS LOUDLY, never silently downgraded (sc_2)]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-cap-"));
  const overlayPath = join(tmp, "drafts.json");
  try {
    const cap = captureTrigger(
      { id: "KT-CAP-BLOCK-1", kind: "obligation", title: "x", when: { plan_terms: ["y"] }, apply: { mode: "block" } },
      { overlayPath }
    );
    assert(!cap.ok && cap.results[0]?.error === "draft_cannot_block", "block mode at draft tier fails loudly with draft_cannot_block");
    assert(!existsSync(overlayPath), "no overlay file is written on a loud-fail capture");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[capture — the shipped seed store is NEVER mutated (sc_3)]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-cap-"));
  const overlayPath = join(tmp, "drafts.json");
  const before = readFileSync(SHIPPED_CONFIG, "utf-8");
  try {
    captureTrigger({ id: "KT-CAP-SHIP-1", kind: "insight", title: "x", when: { plan_terms: ["zzz"] }, knowledge: { directive: "d" }, apply: { mode: "inject" } }, { configPath: SHIPPED_CONFIG, overlayPath });
    promoteTrigger("KT-CAP-SHIP-1", "derived", { overlayPath });
    const after = readFileSync(SHIPPED_CONFIG, "utf-8");
    assert(before === after, "capture + promote leave config/knowledge_triggers.json byte-identical");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[capture — id-uniqueness + dedupe-on-when both SKIP]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-cap-"));
  const overlayPath = join(tmp, "drafts.json");
  try {
    captureTrigger({ id: "KT-DUP-1", kind: "insight", title: "a", when: { plan_terms: ["alpha"] }, knowledge: { directive: "d1" }, apply: { mode: "inject" } }, { overlayPath });
    const dupId = captureTrigger({ id: "KT-DUP-1", kind: "insight", title: "b", when: { plan_terms: ["beta"] }, knowledge: { directive: "d2" }, apply: { mode: "inject" } }, { overlayPath });
    assert(dupId.results[0]?.status === "SKIP" && dupId.results[0]?.reason === "duplicate_id", "an existing id is SKIPped (duplicate_id)");
    const dupWhen = captureTrigger({ id: "KT-DUP-2", kind: "insight", title: "a", when: { plan_terms: ["alpha"] }, knowledge: { directive: "d1" }, apply: { mode: "inject" } }, { overlayPath });
    assert(dupWhen.results[0]?.status === "SKIP" && dupWhen.results[0]?.reason === "duplicate_when", "an identical when+directive is SKIPped (duplicate_when)");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[promote — draft→derived enables injection; draft→trusted+block enables gate-eligibility (sc_6)]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-prom-"));
  const overlayPath = join(tmp, "drafts.json");
  try {
    captureTrigger({ id: "KT-PROM-1", kind: "insight", title: "perf", when: { plan_terms: ["slow render"] }, knowledge: { directive: "cache it" }, apply: { mode: "inject" } }, { overlayPath });
    let merged = loadKnowledgeTriggers(SHIPPED_CONFIG, { overlayPath });
    assert(!selectInsightInjections(merged.triggers, { goalText: "page is slow render" }).some((a) => a.id === "KT-PROM-1"), "draft does not inject before promotion");
    promoteTrigger("KT-PROM-1", "derived", { overlayPath });
    merged = loadKnowledgeTriggers(SHIPPED_CONFIG, { overlayPath });
    assert(selectInsightInjections(merged.triggers, { goalText: "page is slow render" }).some((a) => a.id === "KT-PROM-1"), "after promote→derived the insight injects");

    captureTrigger({ id: "KT-PROM-OBL", kind: "obligation", title: "review", when: { plan_terms: ["launch page"] }, knowledge: { directive: "ask review", required_evidence: ["verification_ledger:some_review"] }, apply: { mode: "inject" } }, { overlayPath });
    const prom = promoteTrigger("KT-PROM-OBL", "trusted", { overlayPath, applyMode: "inject-or-block", surface: "gate:plan-to-execute" });
    assert(prom.ok && prom.to === "trusted", "obligation promotes draft→trusted with block-capable apply");
    const planTmp = mkdtempSync(join(tmpdir(), "kt-plan-"));
    writeFileSync(join(planTmp, "plan.md"), "# Plan\n## Goal\nlaunch page\n");
    const gate = evaluateObligationGate({ gate: "plan-to-execute", planDir: planTmp, goalText: "launch page", plannedFiles: [], configPath: SHIPPED_CONFIG, overlayPath });
    assert(gate.some((o) => o.id === "KT-PROM-OBL"), "a promoted-to-trusted obligation becomes gate-eligible at evaluateObligationGate");
    rmSync(planTmp, { recursive: true, force: true });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[promote — negatives: not_found / not_draft / invalid_target]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-prom-"));
  const overlayPath = join(tmp, "drafts.json");
  try {
    assert(promoteTrigger("KT-NONE", "derived", { overlayPath }).error === "not_found", "promoting an unknown id → not_found");
    captureTrigger({ id: "KT-PN-1", kind: "insight", title: "x", when: { plan_terms: ["q"] }, knowledge: { directive: "d" }, apply: { mode: "inject" } }, { overlayPath });
    assert(promoteTrigger("KT-PN-1", "bogus", { overlayPath }).error === "invalid_target_trust", "promoting to an invalid trust → invalid_target_trust");
    promoteTrigger("KT-PN-1", "derived", { overlayPath });
    assert(promoteTrigger("KT-PN-1", "trusted", { overlayPath }).error === "not_draft", "promoting an already-promoted record → not_draft");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[list-drafts — only un-promoted drafts are listed]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-list-"));
  const overlayPath = join(tmp, "drafts.json");
  try {
    captureTrigger([
      { id: "KT-L-1", kind: "insight", title: "one", when: { plan_terms: ["t1"] }, knowledge: { directive: "d1" }, apply: { mode: "inject" } },
      { id: "KT-L-2", kind: "insight", title: "two", when: { plan_terms: ["t2"] }, knowledge: { directive: "d2" }, apply: { mode: "inject" } },
    ], { overlayPath });
    assert(listDraftTriggers({ overlayPath }).length === 2, "two captured drafts are listed");
    promoteTrigger("KT-L-1", "derived", { overlayPath });
    const remaining = listDraftTriggers({ overlayPath });
    assert(remaining.length === 1 && remaining[0].id === "KT-L-2", "a promoted record drops out of the draft list");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[retro-promotion — draftKtFromRetro produces a when-clause that actually FIRES (sc_7)]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-retro-"));
  const overlayPath = join(tmp, "drafts.json");
  try {
    const retro = { id: "R-2026-06-06-001", title: "Render cache cold on first paint", root_cause: "first paint skipped the warm cache", affected_surfaces: ["src/render/cache.ts", "render performance"] };
    const candidate = draftKtFromRetro(retro);
    assert(candidate && candidate.provenance.proposed_from === "R-2026-06-06-001", "draftKtFromRetro carries retro lineage");
    const cap = captureTrigger(candidate, { overlayPath });
    assert(cap.ok && cap.written === 1, "retro-derived candidate captures as a valid draft");
    const merged = loadKnowledgeTriggers(SHIPPED_CONFIG, { overlayPath });
    // FIRES on a plausible future context (a goal mentioning the topic / surface).
    const firesByTerm = computeKnowledgeTriggerSignal(merged.triggers, { goalText: "the page has poor render performance" });
    const firesByFile = computeKnowledgeTriggerSignal(merged.triggers, { files: ["src/render/cache.ts"] });
    assert(firesByTerm.active.some((a) => a.id === candidate.id) || firesByFile.active.some((a) => a.id === candidate.id), "the retro-derived KT fires on a plausible context (not inert-after-promotion)");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[CLI — --capture/--promote thread --overlay so the shipped store is never touched (sc_3, wiring)]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-cli-"));
  const overlayPath = join(tmp, "drafts.json");
  const before = readFileSync(SHIPPED_CONFIG, "utf-8");
  try {
    const capRep = ktCliRun(["--capture", "--id", "KT-CLI-1", "--kind", "insight", "--title", "cli insight", "--directive", "do it", "--plan-term", "cli term", "--overlay", overlayPath]);
    assert(capRep.status === "PASS" && capRep.written === 1, "CLI --capture writes a draft to the tmp overlay");
    const promRep = ktCliRun(["--promote", "KT-CLI-1", "--to", "derived", "--overlay", overlayPath]);
    assert(promRep.status === "PASS" && promRep.to === "derived", "CLI --promote flips the draft to derived");
    const listRep = ktCliRun(["--list-drafts", "--overlay", overlayPath]);
    assert(listRep.count === 0, "CLI --list-drafts shows zero remaining drafts after promotion");
    assert(readFileSync(SHIPPED_CONFIG, "utf-8") === before, "the CLI path never mutates the shipped store");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[no-clobber — a corrupt overlay is NEVER overwritten (data-loss guard, must-fix)]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-corrupt-"));
  const overlayPath = join(tmp, "drafts.json");
  // A present-but-unreadable overlay that (pretend) holds prior drafts + operator promotions.
  const corrupt = "{ this is not valid json — operator promotions live here";
  writeFileSync(overlayPath, corrupt);
  try {
    const cap = captureTrigger({ id: "KT-NEW-1", kind: "insight", title: "x", when: { plan_terms: ["q"] }, knowledge: { directive: "d" }, apply: { mode: "inject" } }, { overlayPath });
    assert(!cap.ok && cap.error === "overlay_unreadable_refusing_to_clobber", "capture REFUSES to write over a corrupt overlay (no data loss)");
    assert(readFileSync(overlayPath, "utf-8") === corrupt, "the corrupt overlay file is left byte-identical (host knowledge preserved)");
    const prom = promoteTrigger("KT-NEW-1", "derived", { overlayPath });
    assert(!prom.ok && prom.error === "overlay_unreadable_refusing_to_clobber", "promote also refuses to rewrite a corrupt overlay");
    assert(readFileSync(overlayPath, "utf-8") === corrupt, "promote leaves the corrupt overlay byte-identical too");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[dedupe — distinct kinds with the same when+directive do NOT collide (whenSignature includes kind)]");
{
  const tmp = mkdtempSync(join(tmpdir(), "kt-kind-"));
  const overlayPath = join(tmp, "drafts.json");
  try {
    const a = captureTrigger({ id: "KT-K-INS", kind: "insight", title: "t", when: { plan_terms: ["same"] }, knowledge: { directive: "same directive" }, apply: { mode: "inject" } }, { overlayPath });
    const b = captureTrigger({ id: "KT-K-STR", kind: "strategy", title: "t", when: { plan_terms: ["same"] }, knowledge: { directive: "same directive" }, apply: { mode: "inject" } }, { overlayPath });
    assert(a.written === 1 && b.written === 1, "an insight and a strategy with identical when+directive are BOTH captured (kind distinguishes them)");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log("\n[shipped seeds are all trusted — a draft seed would silently lose enforcement while winning id-collision]");
{
  const shipped = JSON.parse(readFileSync(SHIPPED_CONFIG, "utf-8"));
  assert((shipped.triggers || []).every((t) => t?.provenance?.trust_level === "trusted"), "every shipped seed KT is provenance.trust_level 'trusted'");
}

console.log("\n[retro mapper — an unusable retro yields no dead KT instead of an empty-when one]");
{
  assert(draftKtFromRetro({ id: "R-X", title: "ab", affected_surfaces: [], summary: "", root_cause: "" }) === null, "a retro with no derivable trigger context returns null (no never-firing KT)");
  const usable = draftKtFromRetro({ id: "R-Y", title: "ab", affected_surfaces: [], summary: "the parser dropped the verification table rows", root_cause: "" });
  assert(usable && usable.when.plan_terms.length > 0, "a retro with only a summary still backfills firing plan_terms");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
