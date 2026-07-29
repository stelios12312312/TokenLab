// prolog_value_audit.mjs - deterministic E8-2 prove-or-lose report for the Prolog layer.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SKILL_ROOT = resolve(LIB_DIR, "..", "..");
const DEFAULT_REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");

export const DEFAULT_GATE_SURVIVAL_PATH = "reports/ive/gate_survival/gate_survival.json";
export const AUDIT_ID = "e8_2_prolog_value_audit";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return { __read_error: error.message };
  }
}

function rel(repoRoot, path) {
  const out = relative(repoRoot, path).replace(/\\/g, "/");
  return out && !out.startsWith("..") ? out : path.replace(/\\/g, "/");
}

function stripRefSuffix(ref) {
  const text = String(ref || "").trim();
  if (!text) return "";
  const hashIndex = text.indexOf("#");
  const withoutHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const colonLine = withoutHash.match(/^(.+):\d+$/);
  return colonLine ? colonLine[1] : withoutHash;
}

function pathExists(repoRoot, ref) {
  const clean = stripRefSuffix(ref);
  if (!clean || /^(?:node|proof:|http|https):/.test(clean)) return true;
  return existsSync(resolve(repoRoot, clean));
}

function countLines(path) {
  try {
    const text = readFileSync(path, "utf-8");
    if (!text) return 0;
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

function listFiles(dir, predicate = () => true) {
  const out = [];
  function visit(current) {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && predicate(path)) out.push(path);
    }
  }
  visit(dir);
  return out;
}

function lineInventory(repoRoot) {
  const prologDir = join(repoRoot, ".agent", "skills", "iterative-planner", "prolog");
  const tokenomicsDir = join(repoRoot, ".agent", "skills", "iterative-planner", "packs", "tokenomics");
  const prologFiles = listFiles(prologDir, (path) => path.endsWith(".pl"));
  const tokenomicsFiles = listFiles(tokenomicsDir, (path) => path.endsWith(".pl") || path.endsWith(".mjs"));
  const prolog = prologFiles.map((path) => ({ path: rel(repoRoot, path), loc: countLines(path) }));
  const tokenomics = tokenomicsFiles.map((path) => ({ path: rel(repoRoot, path), loc: countLines(path) }));
  return {
    prolog_core: {
      files: prolog,
      total_loc: prolog.reduce((sum, row) => sum + row.loc, 0),
    },
    tokenomics_pack: {
      files: tokenomics,
      total_loc: tokenomics.reduce((sum, row) => sum + row.loc, 0),
    },
  };
}

function loadGateSurvival(repoRoot, gateSurvivalPath) {
  const resolved = resolve(repoRoot, gateSurvivalPath || DEFAULT_GATE_SURVIVAL_PATH);
  if (!existsSync(resolved)) {
    return {
      ok: false,
      path: gateSurvivalPath || DEFAULT_GATE_SURVIVAL_PATH,
      failures: [{ code: "missing_gate_survival", detail: gateSurvivalPath || DEFAULT_GATE_SURVIVAL_PATH }],
    };
  }
  const document = readJson(resolved);
  if (document?.__read_error) {
    return {
      ok: false,
      path: rel(repoRoot, resolved),
      failures: [{ code: "invalid_gate_survival_json", detail: document.__read_error }],
    };
  }
  const summary = document.summary || {};
  const failures = [];
  if (!Number.isFinite(Number(summary.total_decision_log_attempts)) || Number(summary.total_decision_log_attempts) <= 0) {
    failures.push({ code: "gate_survival_missing_attempts", detail: "summary.total_decision_log_attempts is missing or zero" });
  }
  if (!summary.check_classifications || !Number.isFinite(Number(summary.check_classifications.DELETE))) {
    failures.push({ code: "gate_survival_missing_check_classifications", detail: "summary.check_classifications.DELETE is missing" });
  }
  return {
    ok: failures.length === 0,
    path: rel(repoRoot, resolved),
    failures,
    document,
    summary: {
      total_attempts: Number(summary.total_decision_log_attempts || 0),
      total_blocked: Number(summary.total_blocked || 0),
      total_allowed: Number(summary.total_allowed || 0),
      total_bounce_loops: Number(summary.total_bounce_loops || 0),
      total_self_clearing_unblocks: Number(summary.total_self_clearing_unblocks || 0),
      gate_keep_count: Number(summary.gate_classifications?.KEEP || 0),
      gate_demote_count: Number(summary.gate_classifications?.DEMOTE || 0),
      gate_delete_count: Number(summary.gate_classifications?.DELETE || 0),
      check_keep_count: Number(summary.check_classifications?.KEEP || 0),
      check_demote_count: Number(summary.check_classifications?.DEMOTE || 0),
      check_delete_count: Number(summary.check_classifications?.DELETE || 0),
      top_level_plan_dirs: Number(document.corpus?.top_level_plan_dirs || 0),
      all_plan_dirs_including_archive: Number(document.corpus?.all_plan_dirs_including_archive || 0),
      decision_log_files: Number(document.corpus?.decision_log_files || 0),
    },
    gate_rows: {
      "explore-to-plan": document.gates?.["explore-to-plan"]?.classification || null,
      "plan-to-execute": document.gates?.["plan-to-execute"]?.classification || null,
      "execute-to-reflect": document.gates?.["execute-to-reflect"]?.classification || null,
      "reflect-to-validate": document.gates?.["reflect-to-validate"]?.classification || null,
      "validate-to-close": document.gates?.["validate-to-close"]?.classification || null,
      "notify-user": document.gates?.["notify-user"]?.classification || null,
    },
  };
}

function currentWiring(repoRoot) {
  const determinismPath = join(repoRoot, ".agent", "skills", "iterative-planner", "config", "determinism.json");
  const gatesPath = join(repoRoot, ".agent", "skills", "iterative-planner", "config", "gates.json");
  const determinism = readJson(determinismPath);
  const gatesDocument = readJson(gatesPath);
  const gates = gatesDocument.gates || gatesDocument || {};
  const gatesWithReachability = Object.entries(gates)
    .filter(([, config]) => config?.reachability_audit === true)
    .map(([gate]) => gate)
    .sort();
  const gatesWithoutReachability = Object.entries(gates)
    .filter(([, config]) => config?.reachability_audit === false)
    .map(([gate]) => gate)
    .sort();
  return {
    determinism_path: rel(repoRoot, determinismPath),
    gates_path: rel(repoRoot, gatesPath),
    prolog_shadow_mode: {
      enabled: determinism.features?.prolog_shadow_mode?.enabled === true,
    },
    prolog_enforce_mode: {
      enabled: determinism.features?.prolog_enforce_mode?.enabled === true,
    },
    reachability_audit: {
      enabled: determinism.features?.reachability_audit?.enabled === true,
    },
    gates_with_reachability: gatesWithReachability,
    gates_without_reachability: gatesWithoutReachability,
  };
}

function uniqueCatchRows() {
  return [
    {
      id: "traceability_graph_join",
      verdict: "keep_minimal_prolog",
      prolog_surfaces: [
        ".agent/skills/iterative-planner/prolog/stories.pl",
        ".agent/skills/iterative-planner/prolog/invariants.pl",
      ],
      rule_ids: ["story_proves_criterion", "annotation_mismatch", "broken_evidence_chain"],
      evidence_refs: [
        ".agent/skills/iterative-planner/tests/test_verification_truth.mjs",
        ".agent/skills/iterative-planner/prolog/stories.pl",
        ".agent/skills/iterative-planner/scripts/ontology_serializer.mjs",
      ],
      unique_value: "Relational joins across stories, criteria, annotations, validation refs, and proof chains are compact in Prolog and are not covered by one equivalent JS gate.",
      js_duplicate: false,
    },
    {
      id: "tokenomics_arithmetic",
      verdict: "keep_minimal_prolog",
      prolog_surfaces: [
        ".agent/skills/iterative-planner/packs/tokenomics/rules.pl",
      ],
      rule_ids: ["TK-005", "TK-007", "TK-008", "TK-009", "TK-010", "TK-011", "TK-012"],
      evidence_refs: [
        ".agent/skills/iterative-planner/tests/test_tokenomics_conformance.mjs",
        ".agent/skills/iterative-planner/packs/tokenomics/rules.pl",
      ],
      unique_value: "Token supply, vesting, unlock, incentive-source, and arithmetic invariants are executed as declarative rules and surfaced through runtime conformance.",
      js_duplicate: false,
    },
    {
      id: "temporal_split_leakage_guard",
      verdict: "keep_or_port_later",
      prolog_surfaces: [
        ".agent/skills/iterative-planner/prolog/invariants.pl",
      ],
      rule_ids: ["no_temporal_split", "quant_no_temporal_split"],
      evidence_refs: [
        ".agent/skills/iterative-planner/tests/test_leakage_proof.mjs",
        ".agent/skills/iterative-planner/prolog/invariants.pl",
      ],
      unique_value: "Temporal leakage proof is a cross-fact invariant over story/task shape and verification evidence; it is not just a local string check.",
      js_duplicate: false,
    },
    {
      id: "program_packet_relational_invariants",
      verdict: "keep_minimal_prolog",
      prolog_surfaces: [
        ".agent/skills/iterative-planner/prolog/programs.pl",
      ],
      rule_ids: ["program_ticket_without_traceability", "program_child_plan_not_closed", "program_dependency_cycle"],
      evidence_refs: [
        ".agent/skills/iterative-planner/prolog/programs.pl",
        ".agent/skills/iterative-planner/scripts/program_manager.mjs",
        ".agent/skills/iterative-planner/tests/test_program_manager.mjs",
      ],
      unique_value: "Program tickets, dependencies, child-plan state, AC rows, VM rows, and lifecycle evidence are naturally relational and catch cross-packet drift.",
      js_duplicate: "partial",
    },
    {
      id: "gate_chain_reachability",
      verdict: "keep_current",
      prolog_surfaces: [
        ".agent/skills/iterative-planner/prolog/transitions.pl",
        ".agent/skills/iterative-planner/prolog/reachability.pl",
      ],
      rule_ids: ["gate_chain_broken", "forbidden_path", "dead_end_state"],
      evidence_refs: [
        ".agent/skills/iterative-planner/prolog/transitions.pl",
        ".agent/skills/iterative-planner/prolog/reachability.pl",
        ".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs",
        ".agent/skills/iterative-planner/config/gates.json",
      ],
      unique_value: "The state machine is checked as a graph with reachability and forbidden-transition rules, not only as per-command JS branches.",
      js_duplicate: "partial",
    },
  ];
}

function duplicateRows(wiring) {
  return [
    {
      id: "gate_chain_duplicate_js",
      verdict: "port_candidate_keep_until_divergence_proof",
      surfaces: [
        ".agent/skills/iterative-planner/scripts/transition.mjs",
        ".agent/skills/iterative-planner/prolog/transitions.pl",
      ],
      evidence_refs: [
        ".agent/skills/iterative-planner/tests/test_transition_gate_flows.mjs",
        ".agent/skills/iterative-planner/prolog/transitions.pl",
      ],
      reason: "Some transition ordering checks exist in both JS and Prolog; remove only after a JS-only proof preserves divergence detection.",
    },
    {
      id: "reachability_disabled_claim",
      verdict: wiring.reachability_audit.enabled && wiring.gates_with_reachability.length > 0
        ? "stale_claim_refuted"
        : "claim_matches_current_config",
      surfaces: [
        ".agent/skills/iterative-planner/config/determinism.json",
        ".agent/skills/iterative-planner/config/gates.json",
        ".agent/skills/iterative-planner/prolog/reachability.pl",
      ],
      evidence_refs: [
        ".agent/skills/iterative-planner/config/determinism.json",
        ".agent/skills/iterative-planner/config/gates.json",
      ],
      reason: "Ticket prose said reachability was already disabled, but current config enables it for transition gates except notify-user.",
    },
    {
      id: "serializer_inducer_round_trip",
      verdict: "delete_or_port_candidate_requires_separate_census",
      surfaces: [
        ".agent/skills/iterative-planner/scripts/ontology_serializer.mjs",
        ".agent/skills/iterative-planner/scripts/ontology_inducer.mjs",
      ],
      evidence_refs: [
        ".agent/skills/iterative-planner/scripts/ontology_serializer.mjs",
        ".agent/skills/iterative-planner/scripts/ontology_inducer.mjs",
        ".agent/skills/iterative-planner/tests/test_ontology_cli.mjs",
      ],
      reason: "Fact generation may remain necessary, but round-trip induction is not counted as a unique catch without a named failure class.",
    },
    {
      id: "global_review_intake_noise",
      verdict: "demote_to_targeted_context",
      surfaces: [
        ".agent/skills/iterative-planner/scripts/review_intake.mjs",
        "reports/ive/gate_survival/gate_survival.json",
      ],
      evidence_refs: [
        "reports/ive/gate_survival/gate_survival.json",
      ],
      reason: "E2-4 already classifies broad review-intake noise as known false-red context, not a reason to keep global blockers.",
    },
    {
      id: "stale_registry_orphan_envelope",
      verdict: "fixture_not_drive_by_fix",
      surfaces: [
        ".agent/skills/iterative-planner/prolog/invariants.pl",
        "reports/ive/gate_survival/gate_survival.json",
      ],
      evidence_refs: [
        "reports/ive/gate_survival/gate_survival.json",
      ],
      reason: "Known stale registry/orphan envelope red is preserved as an E2-3 fixture and should not be fixed by E8-2.",
    },
  ];
}

function evidenceFailures(repoRoot, rows, kind) {
  const failures = [];
  for (const row of rows) {
    if (String(row.verdict || "").startsWith("keep") && (!Array.isArray(row.evidence_refs) || row.evidence_refs.length === 0)) {
      failures.push({ code: `${kind}_missing_evidence_refs`, detail: row.id });
      continue;
    }
    for (const ref of row.evidence_refs || []) {
      if (!pathExists(repoRoot, ref)) {
        failures.push({ code: `${kind}_missing_evidence_ref`, detail: `${row.id}: ${ref}` });
      }
    }
  }
  return failures;
}

function survivalDecision({ failures, uniqueCatches }) {
  if (failures.length > 0) return "blocked_missing_evidence";
  if (uniqueCatches.filter((row) => String(row.verdict || "").startsWith("keep")).length >= 3) {
    return "keep_minimal_prolog";
  }
  return "delete_or_port_prolog";
}

export function buildPrologValueAudit(options = {}) {
  const repoRoot = resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const gateSurvivalPath = options.gateSurvivalPath || DEFAULT_GATE_SURVIVAL_PATH;
  const survival = loadGateSurvival(repoRoot, gateSurvivalPath);
  const wiring = currentWiring(repoRoot);
  const loc = lineInventory(repoRoot);
  const uniqueCatches = uniqueCatchRows();
  const duplicateOrNoisy = duplicateRows(wiring);
  const failures = [
    ...(survival.failures || []),
    ...evidenceFailures(repoRoot, uniqueCatches, "unique_catch"),
    ...evidenceFailures(repoRoot, duplicateOrNoisy, "candidate"),
  ];
  const decision = survivalDecision({ failures, uniqueCatches });

  return {
    schema_version: 1,
    audit_id: AUDIT_ID,
    status: failures.length === 0 ? "PASS" : "FAIL",
    ok: failures.length === 0,
    decision,
    failures,
    e2_4_gate_survival: {
      path: survival.path || gateSurvivalPath,
      ok: survival.ok,
      summary: survival.summary || null,
      gate_rows: survival.gate_rows || {},
    },
    current_wiring: wiring,
    loc,
    unique_catches: uniqueCatches,
    duplicate_or_noisy_candidates: duplicateOrNoisy,
    conclusion: decision === "keep_minimal_prolog"
      ? "Keep a minimal Prolog layer for the named relational catches; port or delete duplicate/noisy surfaces only after separate evidence proves replacement."
      : "Do not keep Prolog without named evidence; deletion or JS port is required once conformance proves replacement.",
  };
}

export function renderPrologValueAuditText(report) {
  const lines = [
    "Prolog Value Audit",
    `Status: ${report.status}`,
    `Decision: ${report.decision}`,
    `Gate-survival attempts: ${report.e2_4_gate_survival?.summary?.total_attempts ?? "unknown"}`,
    `Core Prolog LOC: ${report.loc?.prolog_core?.total_loc ?? 0}`,
    "",
    "Unique Catches:",
    ...report.unique_catches.map((row) => `- ${row.id}: ${row.verdict} (${(row.evidence_refs || []).length} evidence refs)`),
    "",
    "Duplicate Or Noisy Candidates:",
    ...report.duplicate_or_noisy_candidates.map((row) => `- ${row.id}: ${row.verdict}`),
  ];
  if ((report.failures || []).length > 0) {
    lines.push("", "Failures:", ...report.failures.map((failure) => `- ${failure.code}: ${failure.detail}`));
  }
  return `${lines.join("\n")}\n`;
}

export function artifactExists(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
