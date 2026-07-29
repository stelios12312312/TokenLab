#!/usr/bin/env node
// audit_runner.mjs — Role-pack registry, loader, and unified findings runner.
//
// Usage (CLI):
//   node audit_runner.mjs                        Run all configured role packs
//   node audit_runner.mjs --list-packs           List available built-in packs
//   node audit_runner.mjs --pack quant           Run a single pack by id
//   node audit_runner.mjs --json                 Machine-readable JSON output
//   node audit_runner.mjs --config <path>        Override config file path
//   node audit_runner.mjs --report-only          Never exit 1 (report-only / dry-run mode)
//   node audit_runner.mjs --help                 Show usage
//
// Usage (programmatic — import into project_health.mjs):
//   import { loadAuditConfig, buildProjectContext, runRoleAuditors } from './audit_runner.mjs';
//   const config  = loadAuditConfig(cwd);
//   const context = await buildProjectContext(cwd, skillPath, config);
//   const findings = await runRoleAuditors(context);
//
// Config file: audit.config.json at <cwd>/audit.config.json or <cwd>/.agent/audit.config.json
//
// Exit codes: 0 = no findings at fail_on severity, 1 = findings above threshold, 2 = script error.
// Preserves all existing project_health.mjs behavior when no config is present.

import { readFileSync, existsSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve, dirname, basename, sep as pathSep } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getSkillPath, getPaths, resolvePlanTarget, readFile, readFindingsMarkdown } from "./lib/plan_utils.mjs";
import { SEVERITY_ORDER, toHealthSeverity, meetsThreshold } from "./lib/audit_types.mjs";
import {
  summarizePersonaConstraintsArtifact,
  summarizePersonaFindingsArtifact,
  summarizePersonaGuidanceArtifact,
} from "./lib/persona_artifacts.mjs";
import { createSession } from "./lib/prolog.mjs";
import { sanitizeAtom, sanitizeEnumAtom } from "./lib/sanitize.mjs";
import { resolvePlannerPolicyShape } from "./lib/planner_policy.mjs";
import { inferPersonaAdaptation } from "./lib/persona_adaptation.mjs";
import {
  decidePersonaPackActivation,
  renderPersonaShapeSuppressionConflicts,
  renderShapeSuppressionReceipt,
  resolvePersonaAuthorityPlanContext,
  summarizePersonaAuthority,
} from "./lib/persona_activation_authority.mjs";

const __filename = fileURLToPath(import.meta.url);
const skillPath   = getSkillPath(import.meta.url);
const cwd         = process.cwd();

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load audit.config.json from the project directory.
 * Search order: <cwd>/audit.config.json → <cwd>/.agent/audit.config.json
 * Returns null if no config is found (role auditors disabled).
 */
export function loadAuditConfig(cwdOverride) {
  const base = cwdOverride || cwd;
  const candidates = [
    join(base, "audit.config.json"),
    join(base, ".agent", "audit.config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch (e) {
        throw new Error(`Failed to parse audit config at ${p}: ${e.message}`);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Story registry loading
// ---------------------------------------------------------------------------

function loadStoryRegistry(cwdOverride) {
  const base = cwdOverride || cwd;
  const p = join(base, "reports", "user_story_audit", "story_registry.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan files loading
// ---------------------------------------------------------------------------

function loadPlanFiles(cwdOverride, opts = {}) {
  const base = cwdOverride || cwd;
  const paths = getPaths(base);
  const target = resolvePlanTarget(paths.plansDir, { exitOnMissing: false, plan: opts.plan, env: opts.env });
  if (!target.planDirName) return {};

  const planDir = target.planDir;
  const files = {};
  for (const name of ["state.md", "plan.md", "findings.md", "findings_ledger.json", "intent_contract.json", "decisions.md", "progress.md", "verification.md"]) {
    const content = name === "findings.md"
      ? readFindingsMarkdown(planDir, { sync: false })
      : readFile(join(planDir, name));
    if (content) files[name] = content;
  }
  return files;
}

function loadCurrentPlanState(cwdOverride, opts = {}) {
  const base = cwdOverride || cwd;
  const paths = getPaths(base);
  const target = resolvePlanTarget(paths.plansDir, { exitOnMissing: false, plan: opts.plan, env: opts.env });
  if (!target.planDirName) return null;
  const statePath = join(paths.plansDir, target.planDirName, "state.json");
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    return typeof parsed.state === "string" ? parsed.state.toLowerCase() : null;
  } catch {
    return null;
  }
}

function loadAuthorityPlanContext(cwdOverride, opts = {}) {
  const base = cwdOverride || cwd;
  const paths = getPaths(base);
  const target = resolvePlanTarget(paths.plansDir, { exitOnMissing: false, plan: opts.plan, env: opts.env });
  if (!target.planDirName) return null;
  const statePath = join(paths.plansDir, target.planDirName, "state.json");
  const planPath = join(paths.plansDir, target.planDirName, "plan.md");
  let stateJson = null;
  try {
    if (existsSync(statePath)) stateJson = JSON.parse(readFileSync(statePath, "utf-8"));
  } catch { stateJson = null; }
  return resolvePersonaAuthorityPlanContext({
    cwd: base,
    planDir: target.planDir,
    stateJson,
    planContent: readFile(planPath) || "",
  });
}

function inferProjectLevelPlanShape(base) {
  const declared = resolvePlannerPolicyShape(base);
  if (declared) return declared;

  const canonicalMarkers = [
    join(base, "plans", "programs", "ive-trust-repair", "program_packet.json"),
    join(base, "apps", "ive-visualizer"),
    join(base, ".agent", "skills", "iterative-planner", "tests", "ive", "run.mjs"),
  ];
  if (!canonicalMarkers.every((marker) => existsSync(marker))) return null;
  return {
    primary: "planner-core",
    source: "inferred_canonical_planner_repo",
    source_kind: "inferred",
    declared: false,
  };
}

// ---------------------------------------------------------------------------
// Project context builder
// ---------------------------------------------------------------------------

/**
 * Build a ProjectContext object to pass to role packs.
 * @param {string} cwdOverride
 * @param {string} skillPathOverride
 * @param {Object} auditConfig
 * @returns {Object} ProjectContext
 */
export async function buildProjectContext(cwdOverride, skillPathOverride, auditConfig, opts = {}) {
  const base = cwdOverride || cwd;
  const sPath = skillPathOverride || skillPath;

  // Shared Prolog session — story facts loaded once, reused by all packs
  const session = createSession();
  const storyRegistry = loadStoryRegistry(base);
  let storyCount = 0;

  if (storyRegistry && Array.isArray(storyRegistry.stories)) {
    for (const s of storyRegistry.stories) {
      if (!s.id) continue;
      // sanitizeAtom() preserves case for IDs/titles; sanitizeEnumAtom() lowercases
      // enum fields (priority, status) so Prolog predicates match consistently.
      const id = sanitizeAtom(s.id);
      session.consult(`story(${id}, ${sanitizeAtom(s.title || "untitled")}, ${sanitizeEnumAtom(s.priority || "medium")}, ${sanitizeEnumAtom(s.status || "unknown")}).`);

      if (Array.isArray(s.code_refs)) {
        for (const ref of s.code_refs)
          session.consult(`code_ref(${id}, ${sanitizeAtom(ref)}).`);
      }
      if (Array.isArray(s.test_refs)) {
        for (const ref of s.test_refs)
          session.consult(`test_ref(${id}, ${sanitizeAtom(ref)}).`);
      }
      if (Array.isArray(s.postconditions)) {
        for (const p of s.postconditions) {
          // RT3-FIX: Sanitize postconditions — raw JSON values were passed directly
          // to Prolog consult without escaping, allowing Prolog injection via
          // crafted story_registry.json postcondition fields.
          try { session.consult(`postcondition(${id}, ${sanitizeAtom(p)}).`); } catch { /* skip malformed */ }
        }
      }
      if (Array.isArray(s.tags)) {
        for (const t of s.tags)
          session.consult(`story_tag(${id}, ${sanitizeAtom(t)}).`);
      }
      storyCount++;
    }
  }

  const authorityContext = loadAuthorityPlanContext(base, opts);
  const hasExplicitPlanTarget = !!opts.plan || !!opts.env?.PLANNER_TARGET_PLAN;
  const planShape = authorityContext?.plan_shape || (hasExplicitPlanTarget ? null : inferProjectLevelPlanShape(base));
  const paths = getPaths(base);
  const target = resolvePlanTarget(paths.plansDir, { exitOnMissing: false, plan: opts.plan, env: opts.env });

  return {
    cwd:           base,
    skillPath:     sPath,
    storyRegistry: storyRegistry,
    planFiles:     loadPlanFiles(base, opts),
    planDir:       target.planDir || null,
    planDirName:   target.planDirName || null,
    currentState:  loadCurrentPlanState(base, opts),
    planShape,
    personaAuthorityContext: authorityContext,
    auditConfig:   auditConfig || {},
    prologSession: session,   // shared session — packs add their own rules on top
    storyCount,
  };
}

// RT5-M2: Removed duplicate sanitizeAtom/sanitizeEnumAtom — now imported from sanitize.mjs.
// The local versions were weaker (missing :- and ), pattern stripping).

// ---------------------------------------------------------------------------
// Built-in pack registry
// ---------------------------------------------------------------------------

const BUILTIN_PACKS = new Map([
  ["quant",                  () => import("../packs/quant/index.mjs")],
  ["quant_target",           () => import("../packs/quant_target/index.mjs")],
  ["tokenomics",             () => import("../packs/tokenomics/index.mjs")],
  ["ux_ui",                  () => import("../packs/ux_ui/index.mjs")],
  ["wiring_auditor",         () => import("../packs/wiring_auditor/index.mjs")],
  ["assumptions_challenger", () => import("../packs/assumptions_challenger/index.mjs")],
  ["config_integrity",       () => import("../packs/config_integrity/index.mjs")],
  ["traceability",           () => import("../packs/traceability/index.mjs")],
]);

const EVIDENCE_COMMITTEE_BY_PACK = Object.freeze({
  quant: Object.freeze(["quant_target", "assumptions_challenger", "wiring_auditor", "traceability"]),
  tokenomics: Object.freeze(["assumptions_challenger", "wiring_auditor", "traceability"]),
});

const SCOPED_AUTODETECT_PACKS = Object.freeze(["tokenomics"]);

const DOMAIN_PROFILE_SUPPRESSION_PACKS = Object.freeze({
  quant: Object.freeze(["quant", "quant_research_protocol"]),
  quant_betting: Object.freeze(["quant", "quant_research_protocol", "quant_target"]),
  tokenomics: Object.freeze(["tokenomics"]),
  frontend: Object.freeze(["ux_ui"]),
  automation: Object.freeze(["assumptions_challenger", "wiring_auditor"]),
  planner_infra: Object.freeze(["assumptions_challenger", "config_integrity", "traceability"]),
});

// v7.3.1: shape-pack relevance map. When a plan's detected shape strongly
// implies a pack is irrelevant, audit_runner drops the pack with a notice
// (instead of executing it and producing FAIL findings on unrelated concerns).
// Agents can override per-project via `audit.config.json.force_packs: [...]`.
const SHAPE_PACK_SKIPLIST = Object.freeze({
  "integration":  new Set(["quant", "quant_research_protocol", "quant_target", "ux_ui"]),
  "migration":    new Set(["quant", "quant_research_protocol", "quant_target", "ux_ui"]),
  "planner-core": new Set(["quant", "quant_research_protocol", "quant_target", "tokenomics", "ux_ui"]),
  "docs":         new Set(["quant", "quant_research_protocol", "quant_target", "ux_ui", "wiring_auditor"]),
  // v7.4.3: chore shape skips all packs except traceability. Operational
  // tasks aren't engineering work — running quant / ux_ui / wiring_auditor
  // / assumptions_challenger / config_integrity audits on a chore plan
  // surfaces noise unrelated to the actual work.
  "chore":        new Set(["quant", "quant_research_protocol", "quant_target", "tokenomics", "ux_ui", "wiring_auditor", "assumptions_challenger", "config_integrity"]),
  // v7.4.4: analysis shape (review/audit/explain) — same skip list.
  "analysis":     new Set(["quant", "quant_research_protocol", "quant_target", "tokenomics", "ux_ui", "wiring_auditor", "assumptions_challenger", "config_integrity"]),
});

function isShapeSkipped(role, shapePrimary, forcePacks) {
  return !decidePersonaPackActivation(role, {
    planShape: shapePrimary ? { primary: shapePrimary } : null,
    forcePacks,
  }).may_load;
}

function configValue(config, dottedKey) {
  if (!config || typeof config !== "object") return undefined;
  let current = config;
  for (const part of String(dottedKey || "").split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

function configList(config, keys) {
  const values = [];
  for (const key of keys || []) {
    const value = configValue(config, key);
    if (Array.isArray(value)) values.push(...value);
  }
  return uniqueStrings(values);
}

function configuredSuppressedPersonaPacks(auditConfig) {
  const suppressedProfiles = configList(auditConfig, [
    "suppressed_domain_profiles",
    "persona.suppressed_domain_profiles",
    "persona_adaptation.suppressed_domain_profiles",
  ]);
  const explicitPacks = configList(auditConfig, [
    "suppressed_persona_packs",
    "persona.suppressed_packs",
    "persona_packs_disabled",
  ]);
  return new Set(uniqueStrings([
    ...explicitPacks,
    ...suppressedProfiles.flatMap((profile) => DOMAIN_PROFILE_SUPPRESSION_PACKS[profile] || [profile]),
  ]));
}

function suppressedPackDecision(packId, planShape, evidence = ["audit_config.suppressed_domain_profiles"]) {
  return {
    pack_id: packId,
    plan_shape: planShape?.primary || null,
    authority: "suppressed",
    may_load: false,
    may_emit_guidance: false,
    may_block: false,
    may_synthesize_obligation: false,
    reason: "audit_config_suppressed_domain_profile",
    evidence: uniqueStrings(evidence),
    source: "audit_runner",
  };
}

function checkPackContract(pack, label) {
  const missing = ["applies", "rules", "audit", "normalizeFinding"]
    .filter(m => typeof pack[m] !== "function");
  if (missing.length > 0) {
    console.error(`  ⚠️ ${label} does not implement AuditorPack contract (missing: ${missing.join(", ")})`);
    return false;
  }
  return true;
}

async function loadBuiltInPack(role, label = `Pack '${role}'`) {
  if (!BUILTIN_PACKS.has(role)) return null;
  try {
    const mod = await BUILTIN_PACKS.get(role)();
    const pack = mod.default || mod;
    return checkPackContract(pack, label) ? pack : null;
  } catch (e) {
    console.error(`  ⚠️ Failed to load built-in pack '${role}': ${e.message}`);
    return null;
  }
}

function packApplies(pack, context) {
  try { return typeof pack.applies === "function" ? pack.applies(context) : true; }
  catch { return false; }
}

/**
 * Load role packs listed in audit.config.json `roles`.
 * `core` is always implicitly included and needs no loading.
 * Returns an array of loaded AuditorPack objects.
 *
 * v7.3.1: optionally accepts `planShape` to drop packs whose domain is
 * irrelevant for the detected plan shape (e.g. quant pack on a webhook plan).
 * Set `audit.config.json.force_packs` to override.
 */
export async function loadRolePacks(auditConfig, skillPathOverride, cwdOverride, planShape = null, opts = {}) {
  const sPath = skillPathOverride || skillPath;
  // F-006 FIX: Use cwdOverride for worktree boundary check instead of module-level cwd
  const effectiveCwd = cwdOverride || cwd;
  const roles = Array.isArray(auditConfig.roles) ? auditConfig.roles : ["core"];
  const forcePacks = Array.isArray(auditConfig.force_packs) ? auditConfig.force_packs : [];
  const suppressedPacks = configuredSuppressedPersonaPacks(auditConfig);
  const shapePrimary = planShape?.primary || null;
  const taskFocusContract = opts.taskFocusContract || opts.personaAuthorityContext?.task_focus_contract || null;
  const packs = [];
  const authorityDecisions = [];

  for (const role of roles) {
    if (role === "core") continue; // core = existing project_health analyzers

    // RP-016: Validate role name to prevent path traversal via audit.config.json
    if (!/^[a-z][a-z0-9_]*$/.test(role)) {
      console.error(`  ⚠️ Skipping role '${role}': invalid name (must match /^[a-z][a-z0-9_]*$/)`);
      continue;
    }

    if (suppressedPacks.has(role)) {
      authorityDecisions.push(suppressedPackDecision(role, planShape));
      console.error(`  ↳ Skipping pack '${role}': suppressed by audit.config.json`);
      continue;
    }

    // v7.3.1: shape-conditional pack skip. Packs whose domain is plainly
    // irrelevant for the detected plan shape are dropped here. Agents can
    // override by adding the pack to `audit.config.json.force_packs`.
    const authority = decidePersonaPackActivation(role, {
      planShape,
      forcePacks,
      evidence: ["audit_config.roles"],
      taskFocusContract,
      suppressUnspecifiedDomainPacks: true,
    });
    authorityDecisions.push(authority);
    if (!authority.may_load) {
      console.error(`  ↳ Skipping pack '${role}': not relevant for plan shape '${shapePrimary}' (set audit.config.json.force_packs to override)`);
      continue;
    }

    // Guard: _template is a scaffold, not a loadable pack
    if (role.startsWith("_")) {
      console.error(`  ⚠️ Skipping role '${role}': names starting with '_' are reserved (template/internal)`);
      continue;
    }

    // Guard: unmodified template detection
    if (role === "my_domain") {
      console.warn(`  ⚠️ Pack '${role}' appears to be the unmodified template — rename the id field`);
    }

    // Check built-in registry first
    if (BUILTIN_PACKS.has(role)) {
      const pack = await loadBuiltInPack(role, `Pack '${role}'`);
      if (pack) packs.push(pack);
      continue;
    }

    // Check project-local custom packs: <cwd>/.agent/packs/<role>/index.mjs
    // F-001: Resolve to realpath and verify within git worktree to prevent code execution
    // from crafted --cwd paths pointing outside the project.
    const projectPackPath = join(effectiveCwd, ".agent", "packs", role, "index.mjs");
    if (existsSync(projectPackPath)) {
      try {
        const realPack = realpathSync(projectPackPath);
        const worktreeProc = spawnSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: effectiveCwd, encoding: "utf-8", timeout: 5000,
        });
        const worktreeRoot = (worktreeProc.status === 0 && worktreeProc.stdout)
          ? realpathSync(worktreeProc.stdout.trim())
          : realpathSync(effectiveCwd);
        // RT3-C3-FIX: Use path.sep instead of hardcoded "/" for the boundary check.
        // Also verify the worktree root itself isn't a prefix of an unrelated path
        // (e.g., "/home/user" must not match "/home/user2/evil").
        if (!realPack.startsWith(worktreeRoot + pathSep)) {
          console.error(`  ⚠️ Rejecting pack '${role}': resolved path escapes worktree (${realPack})`);
          continue;
        }
        const mod = await import(realPack);
        const pack = mod.default || mod;
        if (!checkPackContract(pack, `Project pack '${role}'`)) continue;
        packs.push(pack);
      } catch (e) {
        console.error(`  ⚠️ Failed to load project pack '${role}' from ${projectPackPath}: ${e.message}`);
      }
      continue;
    }

    // Unknown pack — fail gracefully with actionable message
    console.error(`  ⚠️ Unknown role pack '${role}'. Built-in options: ${[...BUILTIN_PACKS.keys()].join(", ")}`);
    console.error(`     To add a custom pack, create: .agent/packs/${role}/index.mjs`);
  }

  const personaAuthority = summarizePersonaAuthority(authorityDecisions);
  Object.defineProperty(packs, "personaAuthority", {
    value: personaAuthority,
    enumerable: false,
  });
  const receipt = renderShapeSuppressionReceipt(personaAuthority, { indent: "  " });
  if (receipt) console.error(receipt);
  try {
    const adaptation = inferPersonaAdaptation(effectiveCwd);
    const conflict = renderPersonaShapeSuppressionConflicts(adaptation, personaAuthority, { indent: "  " });
    if (conflict) console.error(conflict);
  } catch {
    // Conflict surfacing is advisory; never make persona adaptation scan failure
    // hide the deterministic pack-loading result.
  }
  return packs;
}

// ---------------------------------------------------------------------------
// Run role auditors
// ---------------------------------------------------------------------------

async function augmentEvidenceCommittee(packs, context) {
  const auditConfig = context?.auditConfig || {};
  if (auditConfig.auto_committee === false) return packs;

  const forcePacks = Array.isArray(auditConfig.force_packs) ? auditConfig.force_packs : [];
  const suppressedPacks = configuredSuppressedPersonaPacks(auditConfig);
  const shapePrimary = context?.planShape?.primary || null;
  const loaded = new Set(packs.map(p => p.id));
  const additions = [];

  for (const pack of packs) {
    const companions = EVIDENCE_COMMITTEE_BY_PACK[pack.id] || [];
    if (companions.length === 0 || !packApplies(pack, context)) continue;

    for (const companionId of companions) {
      if (loaded.has(companionId)) continue;
      if (suppressedPacks.has(companionId)) continue;
      const authority = decidePersonaPackActivation(companionId, {
        planShape: context?.planShape || (shapePrimary ? { primary: shapePrimary } : null),
        forcePacks,
        evidence: [`committee:${pack.id}`],
        taskFocusContract: context?.personaAuthorityContext?.task_focus_contract || null,
        suppressUnspecifiedDomainPacks: true,
      });
      if (!authority.may_load) continue;

      const companion = await loadBuiltInPack(companionId, `Evidence committee pack '${companionId}'`);
      if (!companion || !packApplies(companion, context)) continue;
      additions.push(companion);
      loaded.add(companionId);
    }
  }

  if (additions.length > 0) {
    console.error(`  ℹ️  Evidence committee added ${additions.length} persona pack(s): ${additions.map(p => p.id).join(", ")}`);
    return [...packs, ...additions];
  }
  return packs;
}

async function augmentScopedApplicablePacks(packs, context) {
  const auditConfig = context?.auditConfig || {};
  const forcePacks = Array.isArray(auditConfig.force_packs) ? auditConfig.force_packs : [];
  const suppressedPacks = configuredSuppressedPersonaPacks(auditConfig);
  const loaded = new Set(packs.map(p => p.id));
  const additions = [];

  for (const id of SCOPED_AUTODETECT_PACKS) {
    if (loaded.has(id)) continue;
    if (suppressedPacks.has(id)) {
      console.error(`  ↳ Skipping scoped domain pack '${id}': suppressed by audit.config.json`);
      continue;
    }
    const authority = decidePersonaPackActivation(id, {
      planShape: context?.planShape || null,
      forcePacks,
      evidence: ["scoped_auto_detect"],
      taskFocusContract: context?.personaAuthorityContext?.task_focus_contract || null,
      suppressUnspecifiedDomainPacks: true,
    });
    if (!authority.may_load) continue;
    const pack = await loadBuiltInPack(id, `Scoped domain pack '${id}'`);
    if (!pack || !packApplies(pack, context)) continue;
    additions.push(pack);
    loaded.add(id);
  }

  if (additions.length === 0) return packs;
  console.error(`  ℹ️  Scoped domain auto-detected ${additions.length} persona pack(s): ${additions.map(p => p.id).join(", ")}`);
  return augmentEvidenceCommittee([...packs, ...additions], context);
}

/**
 * Enforce that at least one persona pack is active for the project.
 * If no packs were loaded from explicit config, attempt auto-detection
 * by testing each built-in pack's applies() method against the context.
 * Returns the (possibly augmented) packs array.
 */
export async function enforceMinimumPersona(packs, context) {
  packs = await augmentEvidenceCommittee(packs, context);
  packs = await augmentScopedApplicablePacks(packs, context);

  // Check if at least one loaded pack is actually applicable to this project
  const hasApplicable = packs.some(p => packApplies(p, context));
  if (hasApplicable) return packs;

  // No applicable packs — auto-detect from all built-in packs
  const detected = [];
  const alreadyLoaded = new Set(packs.map(p => p.id));
  const auditConfig = context?.auditConfig || {};
  const forcePacks = Array.isArray(auditConfig.force_packs) ? auditConfig.force_packs : [];
  const suppressedPacks = configuredSuppressedPersonaPacks(auditConfig);
  for (const [id, loader] of BUILTIN_PACKS) {
    if (alreadyLoaded.has(id)) continue; // already loaded but not applicable — skip
    if (suppressedPacks.has(id)) continue;
    const authority = decidePersonaPackActivation(id, {
      planShape: context?.planShape || null,
      forcePacks,
      evidence: ["auto_detect"],
      taskFocusContract: context?.personaAuthorityContext?.task_focus_contract || null,
      suppressUnspecifiedDomainPacks: true,
    });
    if (!authority.may_load) continue;
    try {
      const mod = await loader();
      const pack = mod.default || mod;
      if (checkPackContract(pack, `Pack '${id}'`) && packApplies(pack, context)) {
        detected.push(pack);
      }
    } catch { /* skip broken packs */ }
  }

  if (detected.length > 0) {
    console.error(`  ℹ️  Auto-detected ${detected.length} applicable persona pack(s): ${detected.map(p => p.id).join(", ")}`);
    return augmentEvidenceCommittee([...packs, ...detected], context);
  }

  // No packs detected — emit a warning so the agent knows to configure one
  console.warn(`  ⚠️  No persona pack is active. Every project must have at least one domain persona.`);
  console.warn(`     Configure audit.config.json with a relevant role, or ensure project signals are detectable.`);
  console.warn(`     Available built-in packs: ${[...BUILTIN_PACKS.keys()].join(", ")}`);
  return packs;
}

/**
 * Run all loaded packs against the project context.
 * Returns an array of normalized findings in project_health.mjs format:
 *   { analyzer, severity, message, location, count, details }
 * (Compatible with existing formatMarkdown output.)
 */
export async function runRoleAuditors(context, packs) {
  const allFindings = [];

  for (const pack of packs) {
    // Check applicability
    let applicable = true;
    try {
      applicable = pack.applies(context);
    } catch (e) {
      console.error(`  ⚠️ Pack '${pack.id}' applies() threw: ${e.message}`);
    }

    if (!applicable) {
      if (process.env.DEBUG) console.error(`  [role-audit] Pack '${pack.id}' not applicable — skipped`);
      continue;
    }

    // Run the pack
    let rawFindings = [];
    try {
      rawFindings = await pack.audit(context);
    } catch (e) {
      console.error(`  ⚠️ Pack '${pack.id}' audit() threw: ${e.message}`);
      continue;
    }

    // Normalize each finding
    for (const raw of rawFindings) {
      let normalized;
      try {
        // v7.4.1: pass full context (including planShape) so packs can apply
        // shape-conditional severity filtering inside normalizeFinding.
        normalized = pack.normalizeFinding(raw, context);
      } catch (e) {
        console.error(`  ⚠️ Pack '${pack.id}' normalizeFinding() threw for finding ${JSON.stringify(raw)}: ${e.message}`);
        continue;
      }

      // Convert to project_health.mjs finding format
      allFindings.push({
        analyzer: `[${pack.id}] ${normalized.category || "role-audit"}`,
        severity: toHealthSeverity(normalized.severity),
        message:  normalized.evidence,
        location: normalized.story_refs.length > 0 ? normalized.story_refs.join(", ") : normalized.role,
        count:    1,
        details:  normalized.recommendation,
        // Preserve the structured finding for JSON output
        _roleAudit: normalized,
      });
    }
  }

  return allFindings;
}

// ---------------------------------------------------------------------------
// CI gate check
// ---------------------------------------------------------------------------

/**
 * Returns true if any finding in the list meets or exceeds the fail_on threshold.
 * Uses audit.config.json `fail_on` (default: ["HIGH", "CRITICAL"]).
 */
export function shouldFailCI(findings, auditConfig) {
  const failOn = Array.isArray(auditConfig.fail_on)
    ? auditConfig.fail_on.map(s => s.toUpperCase())
    : ["HIGH", "CRITICAL"];

  return findings.some(f => {
    // F-007 FIX: Guard against undefined severity from partial normalizeFinding results
    const sev = (f._roleAudit?.severity || f.severity || "INFO").toUpperCase();
    return failOn.includes(sev);
  });
}

// ---------------------------------------------------------------------------
// Phase guidance collection (v1.1 — persona prompt injection)
// ---------------------------------------------------------------------------

/**
 * Collect phase-specific guidance from all packs that implement getPhaseGuidance().
 * Returns array of { packId, guidance } objects (only packs with non-empty guidance).
 *
 * @param {Array} packs   — loaded AuditorPack instances
 * @param {Object} context — ProjectContext
 * @param {string} phase  — target phase (explore, plan, execute, reflect)
 * @returns {Array<{ packId: string, guidance: string }>}
 */
export function collectPhaseGuidance(packs, context, phase) {
  const results = [];
  for (const pack of packs) {
    if (typeof pack.getPhaseGuidance !== "function") continue;
    try {
      const guidance = pack.getPhaseGuidance(phase, context);
      if (guidance && typeof guidance === "string" && guidance.trim().length > 0) {
        // Cap at 500 words per pack to prevent context-window bloat
        const words = guidance.trim().split(/\s+/);
        const capped = words.length > 500 ? words.slice(0, 500).join(" ") + " [...]" : guidance.trim();
        results.push({ packId: pack.id, guidance: capped });
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`[phase-guidance] Pack '${pack.id}' getPhaseGuidance() threw: ${e.message}`);
    }
  }
  return results;
}

/**
 * Write persona_guidance.md to the plan directory.
 * Overwrites any previous version (guidance is phase-specific, regenerated each transition).
 */
function writePhaseGuidance(planDir, guidanceItems, phase) {
  if (!planDir || guidanceItems.length === 0) return;
  const summary = summarizePersonaGuidanceArtifact({
    phase,
    items: guidanceItems.map(({ packId, guidance }) => ({
      pack_id: packId,
      guidance,
    })),
  });
  const lines = [
    `# Persona Guidance — ${phase.toUpperCase()} Phase`,
    "",
    `> Auto-generated at gate transition. Read before each ${phase} step.`,
    `> Do NOT edit — regenerated at every gate.`,
    "",
  ];
  for (const { packId, guidance } of guidanceItems) {
    lines.push(`## ${packId}`, "", guidance, "");
  }
  try {
    writeFileSync(join(planDir, "persona_guidance.md"), lines.join("\n"), "utf-8");
    writeFileSync(join(planDir, "persona_guidance.json"), JSON.stringify({
      version: 1,
      generated_at: new Date().toISOString(),
      phase,
      summary,
      items: guidanceItems.map(({ packId, guidance }) => ({
        pack_id: packId,
        guidance,
      })),
    }, null, 2) + "\n", "utf-8");
  } catch (e) {
    if (process.env.DEBUG) console.error(`[phase-guidance] Failed to write persona_guidance.md: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Plan constraints collection (v1.1 — plan-phase persona hooks)
// ---------------------------------------------------------------------------

/**
 * Collect plan constraints from all packs that implement getPlanConstraints().
 * Returns array of Constraint objects (see audit_types.mjs).
 *
 * @param {Array} packs   — loaded AuditorPack instances
 * @param {Object} context — ProjectContext
 * @returns {Array<Object>}
 */
export function collectPlanConstraints(packs, context) {
  const results = [];
  for (const pack of packs) {
    if (typeof pack.getPlanConstraints !== "function") continue;
    try {
      const constraints = pack.getPlanConstraints(context);
      if (Array.isArray(constraints)) {
        results.push(...constraints);
      }
    } catch (e) {
      if (process.env.DEBUG) console.error(`[plan-constraints] Pack '${pack.id}' getPlanConstraints() threw: ${e.message}`);
    }
  }
  return results;
}

/**
 * Write persona_constraints.md to the plan directory.
 * Only written at explore-to-plan gate. Overwrites previous version.
 */
function writePlanConstraints(planDir, constraints) {
  if (!planDir || constraints.length === 0) return;
  const summary = summarizePersonaConstraintsArtifact({
    phase: "plan",
    constraints,
  });
  const lines = [
    "# Persona Constraints for PLAN Phase",
    "",
    "> Auto-generated at explore-to-plan gate. Address each constraint in your plan.",
    "> Unaddressed HIGH/CRITICAL constraints will cause plan-to-execute gate failure.",
    "",
    "| ID | Severity | Constraint | Rationale | Stories |",
    "|----|----------|-----------|-----------|---------|",
  ];
  for (const c of constraints) {
    const stories = (c.story_refs || []).join(", ") || "—";
    lines.push(`| ${c.id} | ${c.severity} | ${c.constraint} | ${c.rationale} | ${stories} |`);
  }
  lines.push("");
  try {
    writeFileSync(join(planDir, "persona_constraints.md"), lines.join("\n"), "utf-8");
    writeFileSync(join(planDir, "persona_constraints.json"), JSON.stringify({
      version: 1,
      generated_at: new Date().toISOString(),
      phase: "plan",
      summary,
      constraints,
    }, null, 2) + "\n", "utf-8");
  } catch (e) {
    if (process.env.DEBUG) console.error(`[plan-constraints] Failed to write persona_constraints.md: ${e.message}`);
  }
}

function writePersonaFindings(planDir, findings, gate) {
  if (!planDir) return;
  const summary = { fail: 0, warn: 0, info: 0 };
  for (const finding of findings || []) {
    if (finding?.severity === "fail") summary.fail++;
    else if (finding?.severity === "warn") summary.warn++;
    else summary.info++;
  }
  const structuredSummary = summarizePersonaFindingsArtifact({
    gate,
    findings: Array.isArray(findings) ? findings : [],
  });
  try {
    writeFileSync(join(planDir, "persona_findings.json"), JSON.stringify({
      version: 1,
      generated_at: new Date().toISOString(),
      gate,
      summary,
      structured_summary: structuredSummary,
      findings: Array.isArray(findings) ? findings : [],
    }, null, 2) + "\n", "utf-8");
  } catch (e) {
    if (process.env.DEBUG) console.error(`[persona-findings] Failed to write persona_findings.json: ${e.message}`);
  }
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function hardlinePersonasForGate(skillRoot, gate) {
  if (!skillRoot || !gate) return [];
  try {
    const gatesPath = join(skillRoot, "config", "gates.json");
    if (!existsSync(gatesPath)) return [];
    const gatesConfig = JSON.parse(readFileSync(gatesPath, "utf-8"));
    const gateEntry = (gatesConfig.gates || {})[gate];
    if (!gateEntry?.hardline_audit && !Array.isArray(gateEntry?.hardline_personas)) return [];
    return uniqueStrings(gateEntry?.hardline_personas || []);
  } catch {
    return [];
  }
}

function applyGateHardlinePersonas(auditConfig, skillRoot, gate) {
  const hardlinePersonas = hardlinePersonasForGate(skillRoot, gate);
  if (hardlinePersonas.length === 0) return auditConfig;
  return {
    ...auditConfig,
    roles: uniqueStrings([...(Array.isArray(auditConfig?.roles) ? auditConfig.roles : ["core"]), ...hardlinePersonas]),
    force_packs: uniqueStrings([...(Array.isArray(auditConfig?.force_packs) ? auditConfig.force_packs : []), ...hardlinePersonas]),
  };
}

// ---------------------------------------------------------------------------
// Gate-integrated persona audit (extracted from transition.mjs)
// ---------------------------------------------------------------------------

import { withFailureCode } from "./lib/determinism.mjs";

const PASS = "PASS", WARN = "WARN", FAIL = "FAIL";
function _check(name, status, detail) { return { name, status, detail }; }

/**
 * Run compulsory persona audit at a gate transition.
 * Returns an array of check results (PASS/WARN/FAIL).
 *
 * RT-008 + RT2-008 + RT-AUDIT-003: Skip requires env var
 * PLANNER_SKIP_PERSONA_AUDIT (LLMs cannot set env vars).
 *
 * @param {string} cwdPath    - Project working directory
 * @param {string} skillRoot  - Skill root path
 * @param {string} planDir    - Active plan directory (absolute)
 * @param {string} gate       - Gate name
 * @returns {Promise<Array<{ name: string, status: string, detail: string }>>}
 */
export async function runPersonaAuditGate(cwdPath, skillRoot, planDir, gate, options = {}) {
  const results = [];
  const persistArtifacts = options.persistArtifacts !== false;
  const artifacts = { gate, findings: null, targetPhase: null, guidanceItems: [], constraints: [] };
  Object.defineProperty(results, "artifacts", { value: artifacts, enumerable: false });

  const skipEnv = process.env.PLANNER_SKIP_PERSONA_AUDIT;
  if (skipEnv) {
    results.push(withFailureCode(_check(
      "Persona audit (skipped via PLANNER_SKIP_PERSONA_AUDIT env var)",
      FAIL,
      `Skipped by user env var: ${skipEnv} — persona audit is compulsory at this gate. Set env var only for debugging.`
    ), "GATE-PER-001"));
    return results;
  }

  try {
    let auditConfig = loadAuditConfig(cwdPath);
    if (!auditConfig) {
      // F-019 FIX: Add failure code for machine-readable tracking
      results.push(withFailureCode(_check(
        "Persona audit config",
        FAIL,
        "No audit.config.json found — persona audit is compulsory at this gate. Create audit.config.json with at least one role."
      ), "GATE-PER-002"));
      return results;
    }
    auditConfig = applyGateHardlinePersonas(auditConfig, skillRoot, gate);

    const context = await buildProjectContext(cwdPath, skillRoot, auditConfig, {
      plan: planDir ? basename(planDir) : null,
      env: process.env,
    });
    let packs = await loadRolePacks(auditConfig, skillRoot, cwdPath, context.planShape, {
      taskFocusContract: context.personaAuthorityContext?.task_focus_contract || null,
    });
    const personaAuthority = packs.personaAuthority || null;
    packs = await enforceMinimumPersona(packs, context);
    if (personaAuthority && !packs.personaAuthority) {
      Object.defineProperty(packs, "personaAuthority", { value: personaAuthority, enumerable: false });
    }

    if (packs.length === 0) {
      // F-019 FIX: Add failure code for machine-readable tracking
      results.push(withFailureCode(_check(
        "Persona pack loaded",
        FAIL,
        "No persona packs could be loaded — at least one domain persona is required"
      ), "GATE-PER-003"));
      return results;
    }

    results.push(_check(
      "Persona packs loaded",
      PASS,
      `${packs.length} pack(s): ${packs.map(p => p.id).join(", ")}`
    ));

    let findings = await runRoleAuditors(context, packs);
    artifacts.findings = findings;
    if (planDir && persistArtifacts) writePersonaFindings(planDir, findings, gate);

    // v1.1: Phase guidance — write persona_guidance.md for the target phase
    let targetPhase = null;
    try {
      const gatesPath = join(skillRoot, "config", "gates.json");
      if (existsSync(gatesPath)) {
        const gatesConfig = JSON.parse(readFileSync(gatesPath, "utf-8"));
        const gateEntry = (gatesConfig.gates || {})[gate];
        if (gateEntry && gateEntry.to) targetPhase = gateEntry.to;
      }
    } catch { /* non-fatal — skip guidance if gates.json unreadable */ }

    if (targetPhase && planDir) {
      const guidanceItems = collectPhaseGuidance(packs, context, targetPhase);
      artifacts.targetPhase = targetPhase;
      artifacts.guidanceItems = guidanceItems;
      if (persistArtifacts) writePhaseGuidance(planDir, guidanceItems, targetPhase);
      if (guidanceItems.length > 0) {
        results.push(_check(
          "Persona guidance resolved",
          PASS,
          `${guidanceItems.length} pack(s) resolved for ${targetPhase.toUpperCase()} phase`
        ));
      }
    }

    // v1.1: Plan constraints — write persona_constraints.md at explore-to-plan
    if (gate === "explore-to-plan" && planDir) {
      const constraints = collectPlanConstraints(packs, context);
      artifacts.constraints = constraints;
      if (persistArtifacts) writePlanConstraints(planDir, constraints);
      if (constraints.length > 0) {
        results.push(_check(
          "Persona constraints collected",
          WARN,
          `${constraints.length} constraint(s) resolved — review before planning`
        ));
      }
    }

    // Summarize findings by severity
    const summary = { fail: 0, warn: 0, info: 0 };
    for (const f of findings) {
      if (f.severity === "fail") summary.fail++;
      else if (f.severity === "warn") summary.warn++;
      else summary.info++;
    }

    const hasFailures = shouldFailCI(findings, auditConfig);

    if (hasFailures) {
      results.push(_check(
        "Persona audit findings",
        FAIL,
        `${summary.fail} FAIL, ${summary.warn} WARN, ${summary.info} INFO — findings exceed fail_on threshold`
      ));
      for (const f of findings) {
        if (f.severity === "fail") {
          results.push(_check(
            `[${f.analyzer}]`,
            FAIL,
            `${f.message}${f.details ? " → " + f.details : ""}`
          ));
        }
      }
    } else if (summary.warn > 0) {
      results.push(_check(
        "Persona audit findings",
        WARN,
        `${summary.warn} warning(s), ${summary.info} info — no findings at fail_on threshold`
      ));
    } else {
      results.push(_check(
        "Persona audit findings",
        PASS,
        findings.length === 0
          ? "No findings — all persona rules pass"
          : `${summary.info} info-level finding(s) — clean`
      ));
    }
  } catch (e) {
    results.push(_check(
      "Persona audit",
      FAIL,
      `Persona audit failed: ${e.message}`
    ));
  }

  return results;
}

export function persistPersonaAuditArtifacts(planDir, artifacts = {}) {
  if (!planDir || !artifacts) return false;
  if (Array.isArray(artifacts.findings)) {
    writePersonaFindings(planDir, artifacts.findings, artifacts.gate);
  }
  if (artifacts.targetPhase && Array.isArray(artifacts.guidanceItems)) {
    writePhaseGuidance(planDir, artifacts.guidanceItems, artifacts.targetPhase);
  }
  if (artifacts.gate === "explore-to-plan" && Array.isArray(artifacts.constraints)) {
    writePlanConstraints(planDir, artifacts.constraints);
  }
  return true;
}

// ---------------------------------------------------------------------------
// CLI entry point (standalone mode)
// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  (process.argv[1].endsWith("audit_runner.mjs") || process.argv[1].endsWith("audit_runner"));

if (isMain) {
  const args = process.argv.slice(2);
  const flags = {
    listPacks:  args.includes("--list-packs"),
    json:       args.includes("--json"),
    help:       args.includes("--help"),
    reportOnly: args.includes("--report-only"),
    pack:       null,
    configPath: null,
    plan:       null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pack"   && args[i + 1]) flags.pack       = args[++i];
    if (args[i] === "--config" && args[i + 1]) flags.configPath = args[++i];
    if (args[i] === "--plan"   && args[i + 1]) flags.plan       = args[++i];
  }

  if (flags.help) {
    console.log(`audit_runner.mjs — Role-specific auditors for the iterative planner

Usage:
  node audit_runner.mjs                      Run all configured role packs
  node audit_runner.mjs --list-packs         List available built-in packs
  node audit_runner.mjs --pack <id>          Run a single pack by id
  node audit_runner.mjs --json               Machine-readable JSON output
  node audit_runner.mjs --config <path>      Override config file path
  node audit_runner.mjs --plan <plan-dir>    Use an explicit planner target
  node audit_runner.mjs --report-only        Never exit 1 (dry-run mode)

Config file: audit.config.json at <cwd>/audit.config.json or <cwd>/.agent/audit.config.json

Built-in packs: ${[...BUILTIN_PACKS.keys()].join(", ")}

Exit codes: 0 = no findings at fail_on severity, 1 = findings above threshold, 2 = error.`);
    process.exitCode = 0;
  } else if (flags.listPacks) {
    console.log(`Built-in role packs:\n`);
    for (const [id] of BUILTIN_PACKS) {
      console.log(`  ${id.padEnd(20)} packs/${id}/index.mjs`);
    }
    console.log(`\nTo create a custom pack, copy the template:\n  cp -r packs/_template .agent/packs/<your_domain>\n  See packs/_template/README.md for instructions.`);
    process.exitCode = 0;
  } else {
    (async () => {
      try {
        const auditConfig = flags.configPath
          ? JSON.parse(readFileSync(flags.configPath, "utf-8"))
          : loadAuditConfig(cwd);

        if (!auditConfig) {
          if (!flags.json) console.log("No audit.config.json found. Role auditors disabled.");
          return 0;
        }

        // Override roles if --pack specified
        if (flags.pack) auditConfig.roles = ["core", flags.pack];

        const context = await buildProjectContext(cwd, skillPath, auditConfig, {
          plan: flags.plan,
          env: process.env,
        });
        let packs     = await loadRolePacks(auditConfig, skillPath, cwd, context.planShape, {
          taskFocusContract: context.personaAuthorityContext?.task_focus_contract || null,
        });
        const personaAuthority = packs.personaAuthority || null;
        packs         = await enforceMinimumPersona(packs, context);
        if (personaAuthority && !packs.personaAuthority) {
          Object.defineProperty(packs, "personaAuthority", { value: personaAuthority, enumerable: false });
        }
        const findings = await runRoleAuditors(context, packs);

        // Summary
        const summary = { fail: 0, warn: 0, info: 0 };
        for (const f of findings) {
          if (f.severity === "fail") summary.fail++;
          else if (f.severity === "warn") summary.warn++;
          else summary.info++;
        }

        const report = {
          generated_at: new Date().toISOString(),
          roles: auditConfig.roles || [],
          packs_loaded: packs.map(p => p.id),
          persona_authority: packs.personaAuthority || summarizePersonaAuthority(
            (auditConfig.roles || []).filter((role) => role !== "core").map((role) =>
              decidePersonaPackActivation(role, {
                planShape: context.planShape,
                forcePacks: auditConfig.force_packs || [],
                evidence: ["audit_config.roles"],
                taskFocusContract: context.personaAuthorityContext?.task_focus_contract || null,
                suppressUnspecifiedDomainPacks: true,
              })
            )
          ),
          summary,
          findings,
        };

        if (flags.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(`# Role Audit Report`);
          console.log(`Generated: ${report.generated_at}`);
          console.log(`Roles: ${report.roles.join(", ")} | Packs loaded: ${report.packs_loaded.join(", ") || "none"}`);
          console.log(`Summary: Fail=${summary.fail} Warn=${summary.warn} Info=${summary.info}\n`);

          for (const f of findings) {
            const icon = f.severity === "fail" ? "❌" : f.severity === "warn" ? "⚠️" : "ℹ️";
            console.log(`${icon} [${f.analyzer}] ${f.message}`);
            if (f.details) console.log(`   → ${f.details}`);
            if (f.location) console.log(`   @ ${f.location}`);
            console.log();
          }
        }

        const hasFailures = shouldFailCI(findings, auditConfig);
        return !flags.reportOnly && hasFailures ? 1 : 0;
      } catch (e) {
        console.error(`ERROR: ${e.message}`);
        return 2;
      }
    })().then((exitCode) => {
      process.exitCode = exitCode;
    });
  }
}
