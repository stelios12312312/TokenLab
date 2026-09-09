#!/usr/bin/env node
// architectural_inventory.mjs — Generates comprehensive architectural inventory for v11 harness redesign.
// Inventories: retained semantic rules, readers/writers, and reusable core components.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = dirname(__filename);
const skillDir = resolve(scriptsDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");

export function buildArchitecturalInventory() {
  const prologDir = join(skillDir, "prolog");
  const plFiles = readdirSync(prologDir).filter((f) => f.endsWith(".pl")).sort();

  // 1. Semantic Rules Inventory
  const rules = [];
  let totalClauses = 0;

  for (const file of plFiles) {
    const content = readFileSync(join(prologDir, file), "utf-8");
    const lines = content.split("\n");
    const invariants = [];
    const predicates = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("%")) {
        const invMatch = line.match(/(I-\d+):?\s*(.*)/);
        if (invMatch) {
          invariants.push({ id: invMatch[1], description: invMatch[2].trim(), line: i + 1 });
        }
        continue;
      }

      totalClauses++;
      const headMatch = line.match(/^([a-z_][a-z0-9_]*)\s*(\((.*?)\))?\s*(:-|\.)/);
      if (headMatch) {
        const name = headMatch[1];
        const argsStr = headMatch[3];
        const arity = argsStr ? argsStr.split(",").length : 0;
        predicates.add(`${name}/${arity}`);
      }
    }

    rules.push({
      file,
      path: `.agent/skills/iterative-planner/prolog/${file}`,
      size_bytes: Buffer.byteLength(content, "utf-8"),
      line_count: lines.length,
      declared_invariants: invariants,
      predicates: Array.from(predicates).sort(),
    });
  }

  // 2. Readers and Writers Inventory
  const readersWriters = [
    {
      component: "Program Manager",
      script: ".agent/skills/iterative-planner/scripts/program_manager.mjs",
      reads: [
        "plans/programs/**/program_packet.json (Program packet authority)",
        "plans/programs/**/intake/*.json (Intake request sources)",
        "reports/user_story_audit/story_registry.json (Story linkage and duplicate checks)",
        ".agent/ontology/cache/runtime-v1.json (Ontology facts for dependency checks)",
      ],
      writes: [
        "plans/programs/**/program_packet.json (Atomic JSON writes with redaction)",
        "plans/programs/**/intake/*_intake_packet.json (Intake artifact records)",
        "reports/user_story_audit/story_registry.json (Auto-story registrations)",
        "plans/programs/**/remediations/*.json (Advisory remediation packets)",
      ],
      authority_boundary: "local-only, remote-read, remote-sync via resolveRemoteMode and resolveGithubMirrorConfig; strictly blocks gh calls unless explicit remote-sync",
      concurrency_lock: "Atomic writeFileSync with in-memory validation preflight",
    },
    {
      component: "GitHub Mirror",
      script: ".agent/skills/iterative-planner/scripts/lib/github_mirror.mjs",
      reads: [
        "Program Packet tickets and remote_policy",
        "Environment variables (PLANNER_REMOTE_MODE, PLANNER_GITHUB_MIRROR)",
      ],
      writes: [
        "Remote GitHub Issues and Labels via gh CLI runner (only in remote-sync mode)",
        "In-memory ticket.github_sync status tracking (queued on network failure)",
      ],
      authority_boundary: "Strictly disabled in local-only and remote-read modes; fail-closed",
      concurrency_lock: "Process-level synchronous spawnSync",
    },
    {
      component: "Transition Engine",
      script: ".agent/skills/iterative-planner/scripts/transition.mjs",
      reads: [
        "plans/<plan_id>/state.json (Plan state machine authority)",
        "plans/<plan_id>/plan.md, findings.md, progress.md, verification.md",
        "plans/<plan_id>/verification_strategy.yaml (Canonical verification contract)",
        ".agent/skills/iterative-planner/config/gates.json (Transition graph specification)",
      ],
      writes: [
        "plans/<plan_id>/state.json (Canonical plan lifecycle state)",
        "plans/<plan_id>/state.json.lock (File-based PID lock)",
        "plans/<plan_id>/artifacts/transition_receipts/*.json (Immutable transition receipts)",
        "plans/<plan_id>/artifacts/gate_input_snapshots/ (State snapshot at transition time)",
        "plans/<plan_id>/artifacts/prolog/*.json (Prolog invariant evaluation proofs)",
      ],
      authority_boundary: "Local plan directory bounded authority; dry-run mode never mutates state",
      concurrency_lock: "Durable PID file lock with stale-lock expiration and journal recovery",
    },
    {
      component: "Ontology Runtime & Fact Builder",
      script: ".agent/skills/iterative-planner/scripts/lib/ontology_runtime.mjs",
      reads: [
        "reports/user_story_audit/story_registry.json (User story definitions)",
        "plans/**/plan.md, verification.md (Plan specifications and criteria)",
        ".agent/rules.md and .agent/rules/*.md (Agent rules and constraints)",
        "plans/knowledge/** (Mistakes, patterns, gotchas, retros)",
      ],
      writes: [
        ".agent/ontology/cache/runtime-v1.json (Content-addressed compiled Prolog fact cache)",
        ".agent/ontology/compiled/facts.pl (Compiled fact text file)",
      ],
      authority_boundary: "Content-addressed SHA-256 cache key; auto-invalidated on source document change",
      concurrency_lock: "Atomic temp file write with renameSync",
    },
    {
      component: "Story Registry Manager",
      script: ".agent/skills/iterative-planner/scripts/story_registry_bootstrap.mjs",
      reads: [
        "reports/user_story_audit/story_registry.json",
        "Source code annotations (@planner:story, @planner:capability)",
      ],
      writes: [
        "reports/user_story_audit/story_registry.json (Versioned user story database)",
      ],
      authority_boundary: "Single-source-of-truth for project story entities",
      concurrency_lock: "JSON write with schema validation preflight",
    },
    {
      component: "Retro Ledger",
      script: ".agent/skills/iterative-planner/scripts/lib/retro_ledger.mjs",
      reads: [
        "plans/knowledge/retros/retro_ledger.json",
      ],
      writes: [
        "plans/knowledge/retros/retro_ledger.json (Historical mistake and lesson records)",
      ],
      authority_boundary: "Append-only lesson tracking for recurrence guards",
      concurrency_lock: "In-memory transaction and atomic file write",
    },
  ];

  // 3. Reusable Core Components Inventory
  const coreComponents = [
    {
      name: "SLD Prolog Resolution Engine",
      location: ".agent/skills/iterative-planner/scripts/lib/prolog.mjs",
      responsibility: "Pure JavaScript SLD resolution with derivation-path cycle detection and backtracking",
      key_primitives: [
        "solve(goals, subst, db, depth, deadline, ancestors)",
        "unify(term1, term2, subst)",
        "createSession(options)",
        "deepWalk(term, subst)",
      ],
      semantics_preserved: [
        "Depth 50+ alternatives preservation via ancestor linked list",
        "Cut operator (!) branch pruning",
        "Negation-as-failure (\\+)",
        "Standard built-ins (findall/3, forall/2, member/2, append/3, is/2, length/2)",
        "Typed fail-closed limits (QueryTimeoutError, QueryDepthError)",
      ],
      reusability_status: "Production-ready core component; zero external runtime dependencies",
    },
    {
      name: "Clause Indexing Subsystem",
      location: ".agent/skills/iterative-planner/scripts/lib/clause_index.mjs",
      responsibility: "First-argument clause candidate filtering for O(1) indexed lookup",
      key_primitives: [
        "ClauseIndex: Map of term keys to candidate clause lists",
        "createIndexedDb: Multi-predicate indexed clause database",
        "getMatching(firstArgTerm): Fast candidate clause extraction preserving order",
      ],
      semantics_preserved: [
        "Preserves clause declaration order exactly",
        "Always retains variable-head clauses for sound SLD unification",
      ],
      reusability_status: "Production-ready core component; reusable across any Datalog/Prolog JS engine",
    },
    {
      name: "Ontology Fact Projector",
      location: ".agent/skills/iterative-planner/scripts/lib/ontology_fact_builder.mjs",
      responsibility: "Deterministic relational fact extraction from workspace filesystem and git artifacts",
      key_primitives: [
        "resolveOntologyDocuments: Resolves stories, plans, rules, code, and tests",
        "renderOntologyProlog: Generates normalized relational Prolog fact string",
        "buildAuthorityReceipt: Cryptographic SHA-256 authority hash of inputs",
      ],
      semantics_preserved: [
        "Projected predicates: story/1, story_title/2, plan_criterion_story/3, test_covers_file/2, etc.",
        "Strict non-empty projection validation",
      ],
      reusability_status: "High reusability; cleanly decoupleable from specific planner workflows",
    },
    {
      name: "State Machine Lifecycle Controller",
      location: ".agent/skills/iterative-planner/scripts/lib/state_machine.mjs",
      responsibility: "Enforces EXPLORE -> PLAN -> EXECUTE -> REFLECT -> VALIDATE -> CLOSE lifecycle",
      key_primitives: [
        "validateTransition(fromState, toState, context)",
        "executeTransition(gateName, options)",
        "enforceGateInvariants(gateName, session)",
      ],
      semantics_preserved: [
        "Invariant I-015: strict gate chain enforcement (no skipped gates)",
        "Dry-run idempotency guarantee (dry-run never mutates state)",
      ],
      reusability_status: "Core harness controller; forms the foundation for v11 Task/Run lifecycle",
    },
    {
      name: "Durable Transition Journal & Receipt Engine",
      location: ".agent/skills/iterative-planner/scripts/lib/transition_journal.mjs and gate_verdict.mjs",
      responsibility: "Crash-resilient state journal and cryptographic transition receipts",
      key_primitives: [
        "buildTransitionReceipt(gate, inputs, results, duration)",
        "writeTransitionReceipt(planDir, receipt)",
        "journalTransitionStart(gate, state) / journalTransitionEnd(gate, state)",
      ],
      semantics_preserved: [
        "Tamper-evident receipt schema with input digests and evaluator timestamps",
        "Crash recovery via interrupted transition journal detection",
      ],
      reusability_status: "Reusable evidence layer for v11 Evidence & Verification subsystem",
    },
  ];

  return {
    schema_version: 1,
    inventory_date: new Date().toISOString(),
    retained_semantic_rules: {
      total_files: plFiles.length,
      total_clauses: totalClauses,
      files: rules,
    },
    readers_and_writers: readersWriters,
    reusable_core_components: coreComponents,
  };
}

export function renderMarkdown(inv) {
  const r = inv.retained_semantic_rules;
  const rw = inv.readers_and_writers;
  const c = inv.reusable_core_components;

  let md = `# V11 Harness Architectural Inventory

**Date**: ${inv.inventory_date}  
**Scope**: Retained semantic rules, core readers/writers, and reusable harness components.

---

## 1. Retained Semantic Rules Inventory

Total Rule Files: **${r.total_files}** | Total Parsed Clauses: **${r.total_clauses.toLocaleString()}**

| Rule File | Size (bytes) | Lines | Key Predicates & Invariant Categories |
|---|---|---|---|
`;

  for (const f of r.files) {
    const invCount = f.declared_invariants.length;
    const invList = invCount > 0 ? f.declared_invariants.slice(0, 3).map((i) => i.id).join(", ") + (invCount > 3 ? ` (+${invCount - 3} more)` : "") : "Utility rules";
    const predSummary = f.predicates.slice(0, 4).join(", ") + (f.predicates.length > 4 ? ` (+${f.predicates.length - 4} more)` : "");
    md += `| \`${f.file}\` | ${f.size_bytes.toLocaleString()} | ${f.line_count} | **Invariants**: ${invList}<br>**Predicates**: \`${predSummary}\` |\n`;
  }

  md += `
### Invariant Categories in \`invariants.pl\`
- **Story / Test Coverage**: I-001 (high priority untested), I-003 (code without tests), I-010 (uncovered stories), I-020 (stale tests), I-028 (test coverage thresholds)
- **Dependency & Integrity**: I-002 (circular dependencies), I-004 (unimplemented dependencies), I-005 (retired dependencies), I-025 (prerequisite lifecycle alignment)
- **Conflict & Postconditions**: I-006 (conflicting postconditions between stories)
- **Infrastructure & Documentation**: I-007 (infrastructure ownership), I-008 (script documentation), I-012 (rules sync parity), I-014 (schema compliance)
- **State Machine & Gates**: I-015 (strict gate chain order), I-016 (terminal plan integrity), I-017 (active plan uniqueness), I-027 (gate requirement satisfaction)
- **Defects & Remediation**: I-019 (defect resolution evidence), I-022 (gap closure proof), I-023 (unresolved critical defects), I-024 (regression guard)

---

## 2. Readers & Writers Inventory

| Component / Script | Reads | Writes | Authority Boundary | Concurrency / Locking |
|---|---|---|---|---|
`;

  for (const item of rw) {
    md += `| **${item.component}**<br>\`${item.script}\` | ${item.reads.map((r) => `- \`${r}\``).join("<br>")} | ${item.writes.map((w) => `- \`${w}\``).join("<br>")} | ${item.authority_boundary} | ${item.concurrency_lock} |\n`;
  }

  md += `
---

## 3. Reusable Core Harness Components

`;

  for (const comp of c) {
    md += `### 3.${c.indexOf(comp) + 1}. ${comp.name}
- **Source**: \`${comp.location}\`
- **Responsibility**: ${comp.responsibility}
- **Key Primitives**:
${comp.key_primitives.map((p) => `  - \`${p}\``).join("\n")}
- **Semantics Preserved**:
${comp.semantics_preserved.map((s) => `  - ${s}`).join("\n")}
- **Status & Reusability**: ${comp.reusability_status}

`;
  }

  return md;
}

// CLI entry
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const outJson = process.argv.find((a) => a.startsWith("--out-json="))?.split("=")[1] || null;
  const outMd = process.argv.find((a) => a.startsWith("--out-md="))?.split("=")[1] || null;

  console.log("Generating V11 architectural inventory...");
  const inv = buildArchitecturalInventory();

  if (outJson) {
    mkdirSync(dirname(resolve(outJson)), { recursive: true });
    writeFileSync(resolve(outJson), JSON.stringify(inv, null, 2) + "\n", "utf-8");
    console.log(`Wrote JSON inventory to ${outJson}`);
  }

  if (outMd) {
    mkdirSync(dirname(resolve(outMd)), { recursive: true });
    writeFileSync(resolve(outMd), renderMarkdown(inv), "utf-8");
    console.log(`Wrote Markdown inventory to ${outMd}`);
  }

  console.log(renderMarkdown(inv));
}
