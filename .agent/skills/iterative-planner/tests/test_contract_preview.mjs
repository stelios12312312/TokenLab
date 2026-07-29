#!/usr/bin/env node
// test_contract_preview.mjs — front-loaded contract preview for substantive contracts.
//
// Proves the agent is TOLD the rules before it acts: the meta-rules its planned files
// trigger (must-be-wired, namespace, ritual budget) and the invariants its
// shape will face — so a later Prolog/CI failure is never a surprise it discovers after.

import {
  previewMetaRules,
  previewRitualBudget,
  previewShapeInvariants,
  previewContract,
  renderContractPreview,
} from "../scripts/lib/contract_preview.mjs";
import { mkdtempSync, symlinkSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..", "..", "..", "..");
const agentDir = join(repoRoot, ".agent");
const NODE = process.execPath;
const bootstrap = join(agentDir, "skills", "iterative-planner", "scripts", "bootstrap.mjs");

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}
const has = (rules, id) => rules.some((r) => r.id === id);

console.log("\nFront-loaded contract preview\n");

// ── Retired integrity substrate is not previewed as ritual ───────────
console.log("[retired integrity preview]");
assert(!has(previewMetaRules(["config/gates.json", "prolog/invariants.pl"]), "integrity_rebaseline_required"),
  "editing former integrity-tracked files no longer previews a re-baseline ritual");

// ── Meta-rules: surfaced UP FRONT for the planned files ───────────────
console.log("\n[meta-rules previewed before acting]");
const editTracked = previewMetaRules(["config/gates.json", "prolog/invariants.pl"]);
assert(has(editTracked, "namespace_registration_required"), "editing a .pl file → namespace-registration rule is previewed");

const newGate = previewMetaRules(["packs/quant/leakage_proof.mjs"]);
assert(has(newGate, "capability_must_be_wired"), "adding a pack gate module → must-be-wired rule is previewed (the e03/e04 lesson, up front)");

const runner = previewMetaRules(["tests/ive/run.mjs"]);
assert(runner.length === 0, "editing the conformance runner no longer previews a re-baseline rule");

const benign = previewMetaRules(["packs/quant/calibration.json", "docs/readme.md"]);
assert(benign.length === 0, "benign additive files trigger no meta-rules (no false ritual)");

// ── AC2 ritual budget, front-loaded (stated before a heavy plan exists) ──
console.log("\n[ritual budget front-loaded]");
assert(previewRitualBudget("lightweight")?.id === "ritual_budget", "lightweight routing → ritual-budget rule previewed");
assert(previewRitualBudget("skip_planner")?.id === "ritual_budget", "skip routing → ritual-budget rule previewed");
assert(previewRitualBudget("full_planner") === null, "full/standard routing → no ritual-budget warning (legit heavy work)");

// ── Shape invariants previewed ────────────────────────────────────────
console.log("\n[shape invariants previewed]");
const quantInv = previewShapeInvariants("quant");
assert(quantInv.some((i) => /north_star/i.test(i.family)) && quantInv.some((i) => /calibration/i.test(i.family)),
  "quant shape previews the north-star + calibration invariants it will face");
const plannerCoreInv = previewShapeInvariants("planner-core");
assert(plannerCoreInv.some((i) => /plan_to_execute_scaffold/.test(i.family)), "planner-core shape previews plan-to-execute scaffold obligation");
assert(plannerCoreInv.some((i) => /kb_tag_obligation/.test(i.family)), "planner-core shape previews KB tag obligation");
assert(plannerCoreInv.some((i) => /story_linkage_obligation/.test(i.family)), "planner-core shape previews story-linkage obligation");
assert(plannerCoreInv.some((i) => /context_sensitive_matrix/.test(i.family)), "planner-core shape previews context-sensitive matrix obligation");
assert(plannerCoreInv.some((i) => /kb_digest_proof/.test(i.family)), "planner-core shape previews KB digest proof obligation");
assert(plannerCoreInv.some((i) => /self-proof/i.test(i.family)), "planner-core shape previews close-time self-proof obligation");
assert(plannerCoreInv.some((i) => /anti-recurrence/i.test(i.family)), "planner-core shape previews anti-recurrence obligation");
assert(plannerCoreInv.some((i) => /deliverable/i.test(i.family)), "planner-core shape previews deliverable-ledger obligation");
assert(plannerCoreInv.some((i) => /semantic.substrate/i.test(i.family)), "planner-core shape previews semantic-substrate obligation");
assert(previewShapeInvariants("unknown").length === 0, "an unknown shape previews no shape invariants (no noise)");

// ── Plan-to-execute scaffold shape invariants ─────────────────────────
console.log("\n[plan-to-execute scaffold shape invariants]");
const scaffoldInv = previewShapeInvariants("planner-core");
assert(scaffoldInv.some((i) => /plan_to_execute_scaffold/i.test(i.family)),
  "planner-core shape previews the plan_to_execute_scaffold invariant");
assert(scaffoldInv.some((i) => /execution steps/i.test(i.requires) && /verification obligation synthesis/i.test(i.requires) && /semantic upkeep contract/i.test(i.requires)),
  "plan_to_execute_scaffold invariant names the three mechanical sections");

// ── End-to-end preview + render ───────────────────────────────────────
console.log("\n[end-to-end]");
const contract = previewContract({ plannedFiles: ["packs/quant/leakage_proof.mjs", "config/gates.json"], planShape: "quant", triagePath: "lightweight" });
assert(has(contract.meta_rules, "capability_must_be_wired") && has(contract.meta_rules, "ritual_budget"),
  "previewContract aggregates wiring + ritual-budget rules");
const rendered = renderContractPreview(contract);
assert(/Contract preview/.test(rendered) && /must be imported|wired/i.test(rendered) && !/re-baseline/i.test(rendered),
  "renderContractPreview prints substantive requirements without re-baseline ritual");

// ── Path-normalization edge cases (so the tracked-file rule isn't bypassed) ──
console.log("\n[path normalization]");
assert(has(previewMetaRules(["./prolog/invariants.pl"]), "namespace_registration_required"),
  "./-prefixed Prolog path is detected");
const dedup = previewMetaRules(["config/gates.json", "prolog/invariants.pl", "scripts/lib/program_packet.mjs"]);
assert(!has(dedup, "integrity_rebaseline_required"),
  "former integrity-tracked files produce no re-baseline preview noise");
assert(previewMetaRules([]).length === 0 && previewMetaRules(null).length === 0,
  "empty/null planned files yields no meta-rules (no crash)");
assert(!has(previewMetaRules(["packs/quant/index.mjs"]), "capability_must_be_wired"),
  "pack index.mjs is excluded from the must-be-wired rule (it is the entrypoint, not a gate)");
assert(!has(previewMetaRules(["packs/quant/rules.pl"]), "capability_must_be_wired"),
  "pack rules.pl is excluded from must-be-wired (but DOES trigger namespace registration)");
assert(has(previewMetaRules(["packs/quant/rules.pl"]), "namespace_registration_required"),
  "pack rules.pl triggers the namespace-registration rule");

// ── CLI: `bootstrap contract` is the front-loaded surface the agent runs ──
console.log("\n[bootstrap contract subcommand]");
const tmp = mkdtempSync(join(tmpdir(), "contract-cli-"));
try {
  symlinkSync(agentDir, join(tmp, ".agent"), "dir");
  execFileSync("git", ["init", "-q"], { cwd: tmp });
  const env = { ...process.env, CODEX_THREAD_ID: "", _PLANNER_PLAN_TARGET: "" };

  const out = execFileSync(NODE, [bootstrap, "contract", "Add a quant leakage gate", "--files=packs/quant/leakage_proof.mjs,config/gates.json", "--json"], { cwd: tmp, encoding: "utf-8", env });
  const parsed = JSON.parse(out);
  const ids = (parsed.meta_rules || []).map((r) => r.id);
  assert(!ids.includes("integrity_rebaseline_required"), "CLI --json no longer surfaces a re-baseline rule for former tracked files");
  assert(ids.includes("capability_must_be_wired"), "CLI --json surfaces the must-be-wired rule for a new pack gate");
  assert(Array.isArray(parsed.shape_invariants), "CLI --json returns shape_invariants array");

  const text = execFileSync(NODE, [bootstrap, "contract", "Tweak the settings page", "--files=src/settings.jsx"], { cwd: tmp, encoding: "utf-8", env });
  assert(/Contract preview/.test(text), "CLI text mode prints the contract preview header");

  // read-only: no plan dir / state written
  assert(!existsSync(join(tmp, "plans", ".current_plan")), "contract subcommand is read-only — writes no plan");

  // usage error on no goal + no files
  let errored = false;
  try { execFileSync(NODE, [bootstrap, "contract"], { cwd: tmp, encoding: "utf-8", env }); }
  catch (e) { errored = e.status === 2; }
  assert(errored, "contract with no goal/files exits with usage error (status 2)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
