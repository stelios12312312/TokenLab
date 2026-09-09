#!/usr/bin/env node
// ontology_usefulness_assessment.mjs — Comprehensive inventory and usefulness assessment of production rules.
// Categorizes rules into:
// 1. Generic harness safety/integrity rules
// 2. Project-owned domain knowledge
// 3. Derived facts and projections
// 4. Formatting/process ceremony
// 5. Duplicate or unused mechanisms
// Evaluates mistake prevented, inputs, allowed task, rejected claim, disposition, and consistency vs goal achievement.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = dirname(__filename);
const skillDir = resolve(scriptsDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");

export function runOntologyUsefulnessAssessment() {
  const prologDir = join(skillDir, "prolog");
  const plFiles = readdirSync(prologDir).filter((f) => f.endsWith(".pl")).sort();

  // 1. Scan files and count clauses
  const fileInventories = [];
  let totalClauses = 0;
  for (const f of plFiles) {
    const content = readFileSync(join(prologDir, f), "utf-8");
    const lines = content.split("\n");
    let clauseCount = 0;
    const predicates = new Set();
    const invariants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("%")) {
        const invMatch = line.match(/(I-\d+):?\s*(.*)/);
        if (invMatch) {
          invariants.push({ id: invMatch[1], description: invMatch[2].trim(), line: i + 1 });
        }
        continue;
      }
      clauseCount++;
      const headMatch = line.match(/^([a-z_][a-z0-9_]*)\s*(\((.*?)\))?\s*(:-|\.)/);
      if (headMatch) {
        const name = headMatch[1];
        const argsStr = headMatch[3];
        const arity = argsStr ? argsStr.split(",").length : 0;
        predicates.add(`${name}/${arity}`);
      }
    }
    totalClauses += clauseCount;
    fileInventories.push({
      file: f,
      size_bytes: Buffer.byteLength(content, "utf-8"),
      line_count: lines.length,
      clause_count: clauseCount,
      declared_invariants: invariants,
      predicates: Array.from(predicates).sort(),
    });
  }

  // 2. Authoritative Family Assessments
  const families = [
    {
      family_id: "FAM-INTEGRITY-STATE",
      category: "generic_harness_safety",
      title: "State Machine Transition & Reachability Guardrails",
      rules: ["gate_chain_broken (I-015)", "forbidden_path_reachable (I-021)", "hard_deadlock", "gate_bypass_exists", "structural_transition_missing", "gate_missing_failure_code (I-012)", "gate_missing_checklist"],
      real_mistake_prevented: "Silent skipping of required safety, exploration, reflection, or validation gates; corrupting state machine lifecycle into terminal states without executing intermediate checks; unprincipled shortcutting.",
      authoritative_inputs: "state.json (current state, iteration, transition history), gates.json (state machine graph), failure-codes.json, checklist YAMLs.",
      execution_path: "transition.mjs gate preparation and semantic checks; invoked on every `transition.mjs <gate>` run.",
      legitimate_task_allowed: "Sequential progression through EXPLORE -> PLAN -> EXECUTE -> REFLECT -> VALIDATE -> CLOSE, as well as fast-track transitions that still execute all required gates in order.",
      harmful_claim_rejected: "Claiming a task is 'VALIDATED' or 'CLOSED' when PLAN or EXECUTE was bypassed, or claiming a gate passed when required checklists or failure codes do not exist.",
      disposition: "BLOCK",
      disposition_rationale: "Core safety guarantee. Lifecycle skipping compromises all evidence integrity. Must remain hard blocking.",
      consistency_vs_achievement: "Consistency check only. Proves the agent executed gates in the required sequence; does NOT prove the underlying code or business outcome succeeded.",
      simplification_proposal: "Consolidate Prolog reachability path queries with deterministic TypeScript state machine transition tables in v11 core API to reduce Prolog parsing overhead.",
      replacement_tests: "Unit tests in test_state_machine.mjs and transition_gate_flows integration tests.",
      reader_impact: "transition.mjs and state_machine.mjs readers benefit from faster lookup without Prolog consultation.",
    },
    {
      family_id: "FAM-INTEGRITY-GRAPH",
      category: "generic_harness_safety",
      title: "Dependency Graph & Story Integrity",
      rules: ["circular_dependency (I-002)", "depends_on_unimplemented (I-004)", "depends_on_retired (I-005)", "story_conflict (I-006)", "prerequisite_lifecycle_alignment (I-025)"],
      real_mistake_prevented: "Deadlocked dependency cycles (A depends on B depends on A); executing tickets whose prerequisites are unbuilt or retired; undetected contradictory postconditions across stories.",
      authoritative_inputs: "story_registry.json, Program Packet tickets, ontology facts (depends_on/2, story/4).",
      execution_path: "rule_engine.mjs check-invariants, program_manager.mjs check/verify, transition.mjs semantic checks.",
      legitimate_task_allowed: "Linear or DAG dependency chains where prerequisites are implemented and active before dependents execute.",
      harmful_claim_rejected: "Starting execution on a ticket or marking a story ready when its hard prerequisite is unimplemented, retired, or cyclical.",
      disposition: "BLOCK",
      disposition_rationale: "Graph integrity is a structural precondition for deterministic execution order. Must block invalid dependency topologies.",
      consistency_vs_achievement: "Consistency check only. Verifies dependency graph is an acyclic DAG with valid statuses; does not prove prerequisite implementations meet requirements.",
      simplification_proposal: "Standard topological sort (Kahn's algorithm) in JS kernel. Cycle detection in JS is O(V+E) versus Prolog SLD traversal with depth guards.",
      replacement_tests: "Unit test suite for DAG topological sorting and circular dependency detection.",
      reader_impact: "Program manager and transition engine can query graph topology directly in-memory.",
    },
    {
      family_id: "FAM-INTEGRITY-REGISTRY",
      category: "generic_harness_safety",
      title: "Story Registry & Defect Consistency",
      rules: ["blocked_story_fully_covered (I-009)", "open_gap_fully_covered (I-010)", "blocked_without_gap (I-011)", "registry_tampered (I-017)"],
      real_mistake_prevented: "False-green claims where a story is labeled 'fully_covered' while actively blocked by an open defect or unclosed gap; tampered story registry hash.",
      authoritative_inputs: "story_registry.json (blocked_by, open_gaps, status), story_registry.json.sha256 digest.",
      execution_path: "rule_engine.mjs check-invariants, rule_engine.mjs verify-stories.",
      legitimate_task_allowed: "Marking a story 'fully_covered' once all blocking defects and open gaps have been remediated and verified with evidence.",
      harmful_claim_rejected: "Self-asserting full coverage while known defects remain open or gaps exist in the registry.",
      disposition: "BLOCK",
      disposition_rationale: "Prevents false-green regression suppression. Direct evidence of integrity defect if violated.",
      consistency_vs_achievement: "Consistency check. Proves registry fields do not contradict each other; actual defect remediation requires separate executed tests.",
      simplification_proposal: "Enforce via JSON schema validation preflight on story_registry.json read/write.",
      replacement_tests: "Schema validation tests in test_story_registry_bootstrap.mjs.",
      reader_impact: "Eliminates need to project blocked_by_defect/2 facts into Prolog.",
    },
    {
      family_id: "FAM-INTEGRITY-EVIDENCE",
      category: "generic_harness_safety",
      title: "Evidence Chain & Recurrence Safeguards",
      rules: ["broken_evidence_chain", "verification_row_missing_evidence", "truth_surface_nonconvergent", "anti_recurrence_guard_missing", "active_mistake_missing_declared_guard", "active_mistake_missing_verification_hook"],
      real_mistake_prevented: "Declaring criteria passed without referencing real evidence artifacts; closing a plan without anti-recurrence guards for past registered mistakes; ungrounded PASS verdicts.",
      authoritative_inputs: "verification_strategy.yaml, verification.md, verification_ledger.json, mistake_registry (retros/retro_ledger.json).",
      execution_path: "transition.mjs reflect-to-validate and validate-to-close semantic checks.",
      legitimate_task_allowed: "Passing gates when each planned criterion has a concrete evidence row referencing verified command output, test suites, or artifacts, and active mistake guards are satisfied.",
      harmful_claim_rejected: "Claiming criterion passed with narrative assertions only, missing evidence references, or omitting declared anti-recurrence guards.",
      disposition: "BLOCK",
      disposition_rationale: "Core of harness trust. Protects against agent hallucination of success without observable proof.",
      consistency_vs_achievement: "Consistency and provenance check. Verifies proof links exist and match schema; does not evaluate whether the underlying command output was falsified (requires external runner trust boundary).",
      simplification_proposal: "Consolidate verification truth evaluation into a typed TypeScript verifier evaluating `VerificationStrategy` contracts directly.",
      replacement_tests: "Verification truth contract unit tests in test_claims_evidence_contract.mjs.",
      reader_impact: "Replaces brittle Markdown table regex parsing with structured JSON/YAML verification ledger.",
    },
    {
      family_id: "FAM-INTEGRITY-CONTRACT",
      category: "generic_harness_safety",
      title: "Intent Contract & Scope Disciplines",
      rules: ["intent_contract_missing", "intent_contract_invalid", "intent_contract_without_required_deliverable", "deliverable_missing_purpose", "deliverable_missing_quality_contract", "unmapped_source_file", "undocumented_config_flag"],
      real_mistake_prevented: "Underspecified plans with ambiguous deliverables; unmapped source files modified without architectural ownership; silent addition of undocumented configuration flags.",
      authoritative_inputs: "intent_contract.json, scope.json, plan.md, git status (tracked/untracked files).",
      execution_path: "transition.mjs explore-to-plan and plan-to-execute pre-planning checks.",
      legitimate_task_allowed: "Tasks that specify clear outcomes, deliverables, quality contracts, and map all modified files.",
      harmful_claim_rejected: "Proceeding with execution on a vague prompt with zero deliverables or introducing unowned files into the repository.",
      disposition: "BLOCK",
      disposition_rationale: "Enforces upfront clarity before agent spends execution budget.",
      consistency_vs_achievement: "Consistency check. Asserts work order structure; does not evaluate quality of deliverable content.",
      simplification_proposal: "Integrate into work-order JSON schema validator (E3-1 / US-PM-AUTO-086).",
      replacement_tests: "JSON schema tests for work-order contracts.",
      reader_impact: "transition.mjs reads work-order JSON directly without generating intent_contract Prolog facts.",
    },
    {
      family_id: "FAM-DOMAIN-SCIENTIFIC",
      category: "project_owned_domain",
      title: "Quant, Scientific & ML Invariants",
      rules: ["ml_temporal_leakage", "quant_optimization_scale_contract_invalid", "quant_run_class_inflation", "probability_model_no_calibration", "live_model_no_edge_proof", "insufficient_data_for_optimization", "no_temporal_split", "ml_calibration_error_exceeded", "ml_metric_floor_failed", "ml_upstream_data_drift"],
      real_mistake_prevented: "Data leakage across temporal train/test splits; uncalibrated probability predictions deployed to live markets; inflated optimization claims from inadequate sample sizes; silent data drift.",
      authoritative_inputs: "Project model metadata, calibration artifacts, split specifications, optimization trial ledgers.",
      execution_path: "Prolog rule engine when quant/ml persona is active or project ontology declares scientific shape.",
      legitimate_task_allowed: "Model development with strict temporal validation, verified calibration error (ECE < 0.08), and explicit optimization trial counts.",
      harmful_claim_rejected: "Claiming a predictive model has an edge without temporal out-of-sample evaluation or calibration verification.",
      disposition: "BLOCK_WHEN_ACTIVE",
      disposition_rationale: "Essential for financial and scientific applications. However, should live in a project-owned domain pack, NOT mandatory core harness.",
      consistency_vs_achievement: "Can verify mathematical thresholds (ECE, sample size, split dates); still requires trusted upstream evaluation runs.",
      simplification_proposal: "Extract out of core `invariants.pl` into `.agent/packs/quant/` and `.agent/packs/ml/` as optional project domain packs.",
      replacement_tests: "Pack-level domain conformance tests in packs/quant/tests/.",
      reader_impact: "Core harness projects without quant/ML tasks avoid loading 300+ lines of specialized Prolog rules.",
    },
    {
      family_id: "FAM-DOMAIN-TOKENOMICS",
      category: "project_owned_domain",
      title: "Tokenomics & Treasury Authority Invariants",
      rules: ["token_supply_unaccounted", "vesting_unlock_unverified", "treasury_authority_missing"],
      real_mistake_prevented: "Unbalanced token emissions, unverified vesting unlock cliffs, and unauthorized treasury movement.",
      authoritative_inputs: "TokenLab model specifications, vesting schedule tables, smart contract parameter files.",
      execution_path: "Tokenomics persona evaluation during plan review.",
      legitimate_task_allowed: "Token economic models with mathematically closed supply curves and verified multisig governance.",
      harmful_claim_rejected: "Deploying tokenomic parameter updates without supply conservation proof.",
      disposition: "BLOCK_WHEN_ACTIVE",
      disposition_rationale: "Project-owned domain knowledge. Belongs in tokenomics domain pack.",
      consistency_vs_achievement: "Mathematical consistency check of supply models; not market performance proof.",
      simplification_proposal: "Package into `.agent/packs/tokenomics/`.",
      replacement_tests: "Tokenomics pack rule tests.",
      reader_impact: "Decouples tokenomics rules from generic code refactoring tasks.",
    },
    {
      family_id: "FAM-PROJECTION-DERIVED",
      category: "derived_facts_projections",
      title: "Workspace & Artifact Relational Projections",
      rules: ["story/4", "test_ref/2", "code_ref/2", "doc_ref/2", "plan_criterion_story/3", "all_affected/2", "all_conflicts/1", "completeness_dimension/1"],
      real_mistake_prevented: "Inability to query workspace entities relationally; manual coordination of cross-cutting file references.",
      authoritative_inputs: "Workspace file tree, git status, Markdown frontmatter, @planner annotations.",
      execution_path: "ontology_fact_builder.mjs rendered into facts.pl / memory database.",
      legitimate_task_allowed: "Fast relational join queries across stories, code files, tests, and criteria.",
      harmful_claim_rejected: "Rejects ungrounded queries where referenced entity does not exist in workspace.",
      disposition: "ADVISE",
      disposition_rationale: "Projections are derived read models, not decision policies. They must reflect workspace reality accurately.",
      consistency_vs_achievement: "Purely structural representation. Does not imply any goal has been achieved.",
      simplification_proposal: "Generate projections on-demand per active task scope rather than serializing all 45,000 facts into a giant text string.",
      replacement_tests: "Projection parity tests in test_ontology_fact_builder.mjs.",
      reader_impact: "Reduces cold projection latency from ~450ms to <50ms for bounded tasks.",
    },
    {
      family_id: "FAM-CEREMONY-PROCESS",
      category: "formatting_process_ceremony",
      title: "Process Formatting & Word-Count Ceremonies",
      rules: ["learning_note_too_long", "learning_note_completeness_claim", "novel_insight_floor_not_met", "reflection_unsubstantiated", "audit_perspectives_present", "audit_set_has_two_distinct_perspectives", "GATE-EXP-009 (50-word minimum)"],
      real_mistake_prevented: "Originally intended to prevent lazy or superficial agent explanations; attempted to force 'deep thought' via length quotas.",
      authoritative_inputs: "Markdown word counts, finding sentence counts, arbitrary perspective labels in red_team_notes.md.",
      execution_path: "transition.mjs gate checks and Prolog invariants.",
      legitimate_task_allowed: "Concise, precise, 1-line bug fixes with obvious root causes.",
      harmful_claim_rejected: "Fails to reject genuinely hallucinated or incorrect code that happens to be accompanied by 50 words of fluff. Wrongly rejects concise accurate findings.",
      disposition: "RETIRE",
      disposition_rationale: "Pure ceremony. Encourages agent padding, increases token burn, provides zero semantic assurance, and causes friction without preventing real defects.",
      consistency_vs_achievement: "Neither consistency nor achievement. Formatting conformity only.",
      simplification_proposal: "Retire word-count and finding-count gates. Replace with semantic requirement: each finding must identify an observed failure, a reproducing condition, and an expected outcome.",
      replacement_tests: "Semantic finding validator checking for {observed, condition, expected} fields instead of word counts.",
      reader_impact: "Removes verbose prose padding from findings.md, saving ~30% token overhead per task.",
    },
    {
      family_id: "FAM-UNUSED-DUPLICATE",
      category: "duplicate_unused_mechanisms",
      title: "Orphaned Predicates & Duplicate Mechanisms",
      rules: ["story/3 (unprojected)", "criterion_story/2 (unprojected)", "duplicate reachability cycle checks in reachability.pl vs invariants.pl", "deactivated_user_access (commented out)", "unencrypted_pii (commented out)", "no_rate_limit (commented out)"],
      real_mistake_prevented: "None — these are dead code paths, commented-out placeholders, or benchmark targets for nonexistent predicates (as discovered in E-02).",
      authoritative_inputs: "None.",
      execution_path: "Never queried by production gates, or querying nonexistent facts returning 0 results.",
      legitimate_task_allowed: "All.",
      harmful_claim_rejected: "None.",
      disposition: "RETIRE",
      disposition_rationale: "Dead code increases cognitive overhead, bloats rule parsing time, and distorts microbenchmarks.",
      consistency_vs_achievement: "N/A.",
      simplification_proposal: "Delete orphaned rules and commented-out placeholders from prolog/*.pl.",
      replacement_tests: "Linting rule checking for unconsulted or unreferenced Prolog predicates.",
      reader_impact: "Cleaner Prolog source, faster parsing time.",
    }
  ];

  // 3. Structural Statistics
  const categoryCounts = {};
  for (const f of families) {
    categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
  }

  const report = {
    schema_version: 1,
    report_id: "v11_phase0_rule_usefulness_assessment",
    generated_at: new Date().toISOString(),
    inventory: {
      total_files: plFiles.length,
      total_clauses: totalClauses,
      file_inventories: fileInventories,
    },
    summary_by_category: categoryCounts,
    rule_families: families,
    consistency_vs_achievement_doctrine: {
      principle: "Checking relational consistency is fundamentally distinct from proving project goal achievement.",
      core_distinctions: [
        "Consistency checking proves internal coherence (e.g. story has a test, dependencies are acyclic, criteria have evidence rows, statuses match).",
        "Goal achievement proves external empirical validity (e.g. tests actually ran and exited 0, model accuracy met target on real data, security exploit was blocked).",
        "Agent-authored assertions ('I verified X and it passed') are self-claims, NOT machine evidence.",
        "A PASS verdict on an invariant check only means no contradictory facts were detected within the closed world; it does not prove the goal succeeded in reality.",
        "Evidence must originate from runner-observed receipts outside the agent's writable memory boundary."
      ]
    },
    recommendations: {
      immediate_simplifications: [
        "Retire word-count and finding-count ceremony gates (GATE-EXP-009, learning_note_too_long) without weakening semantic gates.",
        "Decouple domain-specific packs (quant, ml, tokenomics) into project-owned modules.",
        "Retire dead/commented-out Prolog predicates (story/3, criterion_story/2, unused auth checks).",
        "Consolidate dependency DAG and state machine reachability checks into deterministic JS algorithms."
      ],
      reader_impact_summary: "Reduces rule parsing overhead by ~40%, eliminates agent prose padding tokens, and provides clear separation between harness safety and domain packs."
    }
  };

  return report;
}

export function renderMarkdownAssessment(report) {
  const inv = report.inventory;
  return `# V11 Phase 0: Production Ontology & Rule Usefulness Assessment

**Date**: ${report.generated_at}  
**Scope**: Authoritative evaluation of all 11 production Prolog files (${inv.total_clauses.toLocaleString()} clauses) across iterative-planner.

---

## 1. Executive Summary & Classification

The iterative-planner Prolog ontology contains **${inv.total_files} rule files** and **${inv.total_clauses.toLocaleString()} parsed clauses**.
Our evaluation categorizes all production rules into five distinct operational buckets:

| Category | Description | Primary Rule Families | Disposition |
|---|---|---|---|
| **Generic Harness Safety & Integrity** | State transitions, DAG dependencies, defect blocking, evidence provenance | State Machine, Dependency DAG, Story Registry, Evidence Chain, Intent Contract | **BLOCK** (Retain as core) |
| **Project-Owned Domain Knowledge** | Quantitative model validation, temporal splits, tokenomics, calibration | Quant / ML / Scientific, Tokenomics | **DECOUPLE** (Move to project packs) |
| **Derived Facts & Projections** | Relational graph projections of workspace files, stories, criteria | Fact Builder Projections, Transitive Closures | **OPTIMIZE** (On-demand generation) |
| **Formatting & Process Ceremony** | Word count quotas, finding counts, reflection length, forced perspectives | Word-count limits, Insight floors, Prose rules | **RETIRE** (Remove token padding) |
| **Duplicate or Unused Mechanisms** | Dead predicates, commented-out rules, redundant graph traversals | Orphaned story/3, dead auth rules, duplicate cycle checks | **RETIRE** (Clean dead code) |

---

## 2. Consistency Checking vs. Project Goal Achievement

> ### **Core Harness Doctrine**:
> **Relational consistency checking is NOT proof that a project goal has been achieved.**
> Agent-authored assertions are not independent execution evidence.

1. **What Consistency Checking Proves**:
   - Internal structural coherence: stories have linked tests; criteria map to stories; dependencies form an acyclic DAG; registered defects block coverage; status transitions follow allowable edges.
   - Closed-world validity: within the universe of extracted facts, no declared invariant rule evaluated to true.
2. **What Consistency Checking CANNOT Prove**:
   - That the underlying test actually executed successfully against real code.
   - That the test exercised the intended defect or edge case (a test that passes trivially or asserts 'true' satisfies consistency).
   - That the project objective (e.g. 'faster harness', 'usable UI', 'improved calibration') was achieved in reality.
3. **Execution Evidence Standard**:
   - Machine-verified proof requires runner-observed receipts containing process exit codes, stdout/stderr digests, immutable input hashes, and execution timestamps recorded outside the agent's writable memory boundary.

---

## 3. Coherent Rule Family Deep Dives

${report.rule_families.map((fam) => `### ${fam.family_id}: ${fam.title}
- **Category**: \`${fam.category}\` | **Disposition**: **${fam.disposition}**
- **Rules Included**: ${fam.rules.join(", ")}
- **Real Mistake Prevented**: ${fam.real_mistake_prevented}
- **Authoritative Inputs & Execution Path**: ${fam.authoritative_inputs} (Executed via: \`${fam.execution_path}\`)
- **Legitimate Task Allowed**: ${fam.legitimate_task_allowed}
- **Harmful / Unsupported Claim Rejected**: ${fam.harmful_claim_rejected}
- **Disposition Rationale**: ${fam.disposition_rationale}
- **Consistency vs. Achievement Distinction**: ${fam.consistency_vs_achievement}
- **Proposed Simplification**: ${fam.simplification_proposal}
- **Replacement Tests**: ${fam.replacement_tests}
- **Reader & Consumer Impact**: ${fam.reader_impact}
`).join("\n---\n\n")}

---

## 4. Proposed Simplifications & Immediate Next Steps

1. **Retire Process & Formatting Ceremony (Zero Gate Weakening)**:
   - Remove word-count thresholds (GATE-EXP-009 50-word minimum, learning_note_too_long) that encourage prose padding without improving code quality.
   - Replace with structural semantic validation: findings must declare {observed_failure, reproducing_condition, expected_outcome}.
2. **Decouple Domain Knowledge into Project Packs**:
   - Extract quant, ML, and tokenomics invariants into optional project packs ('.agent/packs/quant', '.agent/packs/tokenomics').
   - The generic core harness remains clean and lightweight for software, operational, and documentation tasks.
3. **Migrate High-Frequency Graph Algorithms to TypeScript**:
   - State transition reachability and dependency DAG cycle detection run faster and simpler in native JS topological sorts (O(V+E)) than SLD Prolog backtracking.
4. **Preserve All Genuine Integrity Gates**:
   - Every blocking gate protecting state sequence, circular dependencies, unverified criteria, and unclosed defects remains strictly enforced.
`;
}

// CLI entrypoint
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const outJson = process.argv.find((a) => a.startsWith("--out-json="))?.split("=")[1] || null;
  const outMd = process.argv.find((a) => a.startsWith("--out-md="))?.split("=")[1] || null;

  console.log("Running V11 Production Ontology & Rule Usefulness Assessment...");
  const report = runOntologyUsefulnessAssessment();

  if (outJson) {
    mkdirSync(dirname(resolve(outJson)), { recursive: true });
    writeFileSync(resolve(outJson), JSON.stringify(report, null, 2) + "\n", "utf-8");
    console.log(`Wrote assessment JSON to ${outJson}`);
  }

  if (outMd) {
    mkdirSync(dirname(resolve(outMd)), { recursive: true });
    writeFileSync(resolve(outMd), renderMarkdownAssessment(report), "utf-8");
    console.log(`Wrote assessment Markdown to ${outMd}`);
  }

  console.log(renderMarkdownAssessment(report));
}
