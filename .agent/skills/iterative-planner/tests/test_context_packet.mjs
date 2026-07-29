#!/usr/bin/env node
// test_context_packet.mjs - Context packet retrieval, budget, and provenance tests.

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { buildContextPacket, writeContextPacket } from "../scripts/lib/context_packet.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const scriptPath = join(skillDir, "scripts", "context_packet.mjs");
const NODE = process.execPath;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, String(value));
}

function makeFixture(root) {
  writeJson(join(root, "reports", "user_story_audit", "story_registry.json"), {
    stories: [
      { id: "US-Q-001", title: "Quant CLV as-of snapshot repair", status: "ACTIVE", tags: ["quant", "clv", "as-of"] },
      { id: "US-P-001", title: "Persona authority for traced quant ideas", status: "ACTIVE", tags: ["persona", "ontology"] },
      { id: "US-UI-001", title: "Planner dashboard visual polish", status: "ACTIVE", tags: ["ui"] },
    ],
  });
  writeJson(join(root, "plans", "programs", "quant-context", "program_packet.json"), {
    version: 1,
    id: "quant-context",
    title: "Quant Context Packet Fixture",
    goal: "Fixture program for context packet tests",
    status: "executing",
    epics: [],
    tickets: [
      {
        id: "T-QUANT-001",
        title: "Repair CLV as-of snapshot lineage",
        lifecycle: "in_progress",
        story_refs: ["US-Q-001", "US-P-001"],
        summary: "Fix leakage-prone CLV snapshot planning.",
      },
      {
        id: "T-UI-NOISE",
        title: "Polish planner dashboard colors",
        lifecycle: "ready",
        story_refs: ["US-UI-001"],
      },
    ],
    acceptance_criteria: [],
    dependencies: [],
    compatibility_contracts: [],
    migration_boundaries: [],
    deletion_move_census: [],
    verification_matrix: [],
    decisions: [],
  });
  writeText(join(root, "plans", "knowledge", "agent_journal.jsonl"), [
    JSON.stringify({
      id: "J-Q-001",
      type: "observation",
      status: "accepted",
      confidence: "measured",
      topic: "quant persona CLV repair",
      summary: "Quant persona flagged CLV as-of snapshot leakage and asked for traced acceptance criteria.",
      tags: ["quant", "clv", "leakage"],
      linked_ids: ["US-Q-001", "T-QUANT-001"],
      refs: ["reports/quant/clv_fixture.json"],
    }),
    JSON.stringify({
      id: "J-UI-NOISE",
      type: "observation",
      status: "accepted",
      confidence: "reported",
      topic: "UI color note",
      summary: "Dashboard color contrast could be polished later.",
      tags: ["ui"],
      linked_ids: ["US-UI-001"],
    }),
  ].join("\n") + "\n");
  return root;
}

function fixtureResolverPayload(goal) {
  return {
    goal,
    active_plan: { present: false, plan_dir_name: null, state: null },
    related_stories: [
      {
        id: "US-Q-001",
        title: "Quant CLV as-of snapshot repair",
        status: "ACTIVE",
        score: 88,
        refs: ["src/quant/clv.ts"],
        matched_terms: ["quant", "clv"],
        matched_files: [],
      },
      {
        id: "US-P-001",
        title: "Persona authority for traced quant ideas",
        status: "ACTIVE",
        score: 66,
        refs: [],
        matched_terms: ["persona"],
        matched_files: [],
      },
    ],
    related_retros: [
      {
        id: "R-Q-001",
        title: "CLV leakage retro",
        summary: "Prior quant work missed an as-of boundary and needed leakage controls.",
        score: 91,
        reasons: ["goal_overlap:clv", "story_ref:US-Q-001"],
        kb_refs: ["plans/knowledge/gotchas.md#G-CLV-001"],
      },
    ],
    related_mistakes: [
      {
        id: "M-Q-001",
        title: "Quant leakage proof missing",
        summary: "Quant planning must prove temporal/as-of boundaries.",
        kb_refs: ["plans/knowledge/mistakes.md#M-Q-001"],
        matched_terms: ["leakage"],
      },
    ],
    active_obligations: [
      {
        id: "leakage_control",
        subject_id: "US-Q-001",
        verification_mode: "temporal_split",
        guard_types: ["leakage"],
      },
    ],
    matches: {
      trusted: [
        {
          kind: "kb_ref",
          id: "G-CLV-001",
          title: "CLV snapshots need as-of boundaries",
          summary: "Known gotcha for quant CLV planning.",
          score: 80,
          trust_level: "trusted",
          source_refs: ["plans/knowledge/gotchas.md#G-CLV-001"],
          matched_by: ["goal_overlap:clv"],
        },
      ],
      derived: [
        {
          kind: "kb_ref",
          id: "G-UI-NOISE",
          title: "UI dashboard visual note",
          summary: "Unrelated UI gotcha.",
          score: 1,
          trust_level: "derived",
          source_refs: ["plans/knowledge/gotchas.md#G-UI-NOISE"],
          matched_by: [],
        },
      ],
      draft: [],
    },
    persona_signals: {
      present: true,
      pack_ids: ["quant", "traceability"],
      story_refs: ["US-Q-001"],
      total_items: 2,
    },
    verification_obligation_synthesis: {
      obligations: [
        {
          id: "quant_lineage",
          label: "Quant lineage",
          required_proof_type: "as-of lineage proof",
          blocking: true,
          source_signals: ["story_tag:quant", "persona:quant"],
          source_provenance: [{ file: "reports/user_story_audit/story_registry.json", signal: "US-Q-001" }],
        },
      ],
    },
    retrieval_trace: {
      stages: [{ stage: "trusted", item_count: 1, item_ids: ["kb_ref:G-CLV-001"] }],
      consulted_sources: ["story_registry.json", "retro_ledger.json"],
    },
    trust_summary: {
      trusted_count: 1,
      derived_count: 1,
      strongest_signal: "strong_deterministic",
      gap_check_needed: false,
    },
    trace_profile: {
      sources_consulted: ["story_registry.json", "retro_ledger.json"],
    },
  };
}

console.log("\nContext Packet Tests\n");

const tmp = mkdtempSync(join(tmpdir(), "context-packet-"));
try {
  const fixtureRoot = makeFixture(join(tmp, "fixture"));
  const goal = "Plan quant CLV as-of snapshot repair with persona traceability";
  const packet = buildContextPacket({
    cwd: fixtureRoot,
    goal,
    program: "quant-context",
    ticket: "T-QUANT-001",
    tokenBudget: 2600,
    entryBudget: 14,
    noPlanContext: true,
    generatedAt: "2026-01-01T00:00:00.000Z",
    resolverPayload: fixtureResolverPayload(goal),
  });

  assert(packet.packet_type === "context_packet" && packet.schema_version === 1, "packet declares canonical schema");
  assert(packet.goal === goal, "packet preserves task goal");
  assert(packet.active_tickets.some((entry) => entry.id === "T-QUANT-001"), "matching Program Packet ticket is included");
  assert(packet.ontology_facts.some((entry) => entry.id === "US-Q-001"), "quant story fact is included");
  assert(packet.ontology_facts.some((entry) => entry.id === "quant_lineage"), "ontology/verification obligation is included");
  assert(packet.retros.some((entry) => entry.id === "R-Q-001"), "related retro is included");
  assert(packet.journal_entries.some((entry) => entry.id === "J-Q-001"), "relevant journal entry is included");
  assert(packet.persona_signals.some((entry) => entry.id === "quant"), "quant persona signal is included when resolver marks it relevant");
  assert(packet.known_gotchas.some((entry) => entry.id === "G-CLV-001"), "known gotcha is included");
  assert(packet.prior_failure_modes.some((entry) => entry.id === "M-Q-001"), "prior failure mode is included");
  assert(!packet.active_tickets.some((entry) => entry.id === "T-UI-NOISE"), "unrelated Program Packet ticket is excluded from included tickets");
  assert(packet.excluded_noise.some((entry) => entry.id === "T-UI-NOISE"), "excluded ticket noise is recorded with provenance");
  assert(packet.excluded_noise.some((entry) => entry.id === "J-UI-NOISE"), "excluded journal noise is recorded");
  assert(packet.budgets.included_entries <= packet.budgets.entry_budget, "entry budget is enforced");
  assert(packet.budgets.approximate_tokens <= packet.budgets.token_budget, "token budget is enforced");

  const tightPacket = buildContextPacket({
    cwd: fixtureRoot,
    goal,
    program: "quant-context",
    ticket: "T-QUANT-001",
    tokenBudget: 2600,
    entryBudget: 3,
    noPlanContext: true,
    generatedAt: "2026-01-01T00:00:00.000Z",
    resolverPayload: fixtureResolverPayload(goal),
  });
  assert(tightPacket.budgets.included_entries <= 3, "tight entry budget caps included packet entries");
  assert(tightPacket.excluded_noise.some((entry) => entry.reason === "budget_exceeded"), "budget overflow is recorded as excluded noise");

  const included = [
    ...packet.active_tickets,
    ...packet.ontology_facts,
    ...packet.retros,
    ...packet.journal_entries,
    ...packet.persona_signals,
    ...packet.known_gotchas,
    ...packet.prior_failure_modes,
  ];
  assert(included.every((entry) => Array.isArray(entry.source_refs) && entry.source_refs.length > 0), "every included entry carries source provenance");
  assert(typeof packet.packet_hash === "string" && packet.packet_hash.length === 32, "packet has a stable content hash");

  const outPath = join(tmp, "written", "context_packet.json");
  const written = writeContextPacket(packet, outPath, { cwd: repoRoot });
  assert(existsSync(written), "writeContextPacket writes an explicit output path");
  assert(JSON.parse(readFileSync(written, "utf-8")).packet_type === "context_packet", "written packet parses");

  const defaultOut = join(fixtureRoot, "context_packet.json");
  const cli = spawnSync(NODE, [
    scriptPath,
    "--dir", fixtureRoot,
    "--goal", goal,
    "--program", "quant-context",
    "--ticket", "T-QUANT-001",
    "--entry-budget", "10",
    "--json",
    "--no-plan-context",
  ], { cwd: repoRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  assert(cli.status === 0, "CLI exits 0 for read-only JSON generation", cli.stderr);
  const cliPacket = JSON.parse(cli.stdout);
  assert(cliPacket.packet_type === "context_packet", "CLI emits context_packet JSON");
  assert(!existsSync(defaultOut), "CLI is read-only by default");

  const cliOut = join(tmp, "cli", "context_packet.json");
  const cliWrite = spawnSync(NODE, [
    scriptPath,
    "--dir", fixtureRoot,
    "--goal", goal,
    "--program", "quant-context",
    "--ticket", "T-QUANT-001",
    "--write", cliOut,
    "--json",
    "--no-plan-context",
  ], { cwd: repoRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  assert(cliWrite.status === 0, "CLI write exits 0", cliWrite.stderr);
  assert(existsSync(cliOut), "CLI writes only when --write path is explicit");
  assert(JSON.parse(cliWrite.stdout).write_status?.written === true, "CLI reports write status in JSON output");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
