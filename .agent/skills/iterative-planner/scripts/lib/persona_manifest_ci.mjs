// persona_manifest_ci.mjs - deterministic persona/rules CI backstop.

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  BUILTIN_PERSONA_PACKS,
  inferPersonaAdaptation,
  isProblematicPersonaStatus,
} from "./persona_adaptation.mjs";
import {
  decideDomainProfileActivation,
} from "./persona_activation_authority.mjs";
import {
  ROOT_INSTRUCTION_SECTION_HEADINGS,
  ROOT_INSTRUCTION_TARGETS,
  collectCanonicalRootInstructionSections,
  rootInstructionParityStatus,
} from "./root_instruction_renderer.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultSkillRoot = resolve(__dirname, "..", "..");

const KNOWN_DOMAIN_PROFILES = Object.freeze([
  "quant",
  "quant_betting",
  "tokenomics",
  "automation",
  "frontend",
  "planner_infra",
]);

const KNOWN_VIRTUAL_ROLES = Object.freeze([
  "core",
  "quant_research_protocol",
]);

const AUTHORITY_EXPECTATIONS = Object.freeze({
  planner_infra: Object.freeze({
    authority: "active",
    active_packs: Object.freeze(["assumptions_challenger", "config_integrity", "traceability"]),
  }),
  automation: Object.freeze({
    authority: "active",
    active_packs: Object.freeze(["assumptions_challenger", "wiring_auditor"]),
  }),
  quant: Object.freeze({
    authority: "suppressed",
    suppressed_packs: Object.freeze(["quant"]),
  }),
  quant_betting: Object.freeze({
    authority: "suppressed",
    suppressed_packs: Object.freeze(["quant", "quant_research_protocol", "quant_target"]),
  }),
  tokenomics: Object.freeze({
    authority: "suppressed",
    suppressed_packs: Object.freeze(["tokenomics"]),
  }),
  frontend: Object.freeze({
    authority: "suppressed",
    suppressed_packs: Object.freeze(["ux_ui"]),
  }),
});

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function unique(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function readJson(path) {
  if (!existsSync(path)) return { present: false, ok: false, value: null, error: "missing" };
  try {
    return { present: true, ok: true, value: JSON.parse(readFileSync(path, "utf-8")), error: null };
  } catch (error) {
    return { present: true, ok: false, value: null, error: error?.message || "invalid JSON" };
  }
}

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function makeIssue({ code, surface, message, severity = "error", repair_command = null, detail = null }) {
  return {
    code,
    severity,
    surface,
    message,
    repair_command,
    detail,
  };
}

function issueCodeParts(...parts) {
  return parts
    .map((part) => String(part || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean)
    .join("_");
}

function knownRoles() {
  return new Set([...KNOWN_VIRTUAL_ROLES, ...BUILTIN_PERSONA_PACKS]);
}

function resolvePaths(projectRoot, skillRoot = null) {
  const root = resolve(projectRoot || process.cwd());
  const projectSkillRoot = join(root, ".agent", "skills", "iterative-planner");
  const effectiveSkillRoot = skillRoot
    ? resolve(skillRoot)
    : existsSync(projectSkillRoot)
      ? projectSkillRoot
      : defaultSkillRoot;

  return {
    project_root: root,
    skill_root: effectiveSkillRoot,
    persona_manifest: join(effectiveSkillRoot, "config", "persona_obligations.json"),
    root_instruction_template: join(effectiveSkillRoot, "references", "CLAUDE.template.md"),
    audit_config_candidates: [
      join(root, "audit.config.json"),
      join(root, ".agent", "audit.config.json"),
    ],
  };
}

function validateArrayField({ entry, field, profileId, issues, required = true }) {
  if (entry[field] === undefined) {
    if (required) {
      issues.push(makeIssue({
        code: "persona_manifest_missing_array_field",
        surface: "persona_manifest",
        message: `Persona profile '${profileId}' is missing required array field '${field}'.`,
        detail: { profile: profileId, field },
      }));
    }
    return [];
  }
  if (!Array.isArray(entry[field])) {
    issues.push(makeIssue({
      code: "persona_manifest_invalid_array_field",
      surface: "persona_manifest",
      message: `Persona profile '${profileId}' field '${field}' must be an array.`,
      detail: { profile: profileId, field },
    }));
    return [];
  }
  return unique(entry[field]);
}

function validateRoles({ roles, profileId, field, issues }) {
  const allowed = knownRoles();
  for (const role of roles) {
    if (!/^[a-z][a-z0-9_]*$/.test(role)) {
      issues.push(makeIssue({
        code: "persona_manifest_invalid_role_name",
        surface: "persona_manifest",
        message: `Persona profile '${profileId}' ${field} entry '${role}' is not a valid role id.`,
        detail: { profile: profileId, field, role },
      }));
      continue;
    }
    if (!allowed.has(role)) {
      issues.push(makeIssue({
        code: "persona_manifest_unknown_role",
        surface: "persona_manifest",
        message: `Persona profile '${profileId}' references unknown role '${role}' in ${field}.`,
        repair_command: "Use a shipped persona role or add a documented authority decision before updating the manifest.",
        detail: { profile: profileId, field, role },
      }));
    }
  }
}

function validatePersonaManifest(paths) {
  const issues = [];
  const parsed = readJson(paths.persona_manifest);
  const report = {
    path: paths.persona_manifest,
    present: parsed.present,
    valid: false,
    profiles: [],
    profile_count: 0,
  };

  if (!parsed.present) {
    issues.push(makeIssue({
      code: "persona_manifest_missing",
      surface: "persona_manifest",
      message: `Persona manifest is missing at ${paths.persona_manifest}.`,
      repair_command: "Run `node .agent/skills/iterative-planner/scripts/migrate.mjs setup .` to reinstall planner-managed config.",
    }));
    return { report, issues };
  }

  if (!parsed.ok) {
    issues.push(makeIssue({
      code: "persona_manifest_invalid_json",
      surface: "persona_manifest",
      message: `Persona manifest JSON is invalid: ${parsed.error}`,
      repair_command: "Fix .agent/skills/iterative-planner/config/persona_obligations.json, then rerun persona_manifest_ci.mjs.",
    }));
    return { report, issues };
  }

  const doc = parsed.value;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    issues.push(makeIssue({
      code: "persona_manifest_not_object",
      surface: "persona_manifest",
      message: "Persona manifest must be a JSON object.",
    }));
    return { report, issues };
  }
  if (!Number.isInteger(doc.version) || doc.version < 1) {
    issues.push(makeIssue({
      code: "persona_manifest_invalid_version",
      surface: "persona_manifest",
      message: "Persona manifest version must be a positive integer.",
    }));
  }
  if (!Array.isArray(doc.personas) || doc.personas.length === 0) {
    issues.push(makeIssue({
      code: "persona_manifest_missing_personas",
      surface: "persona_manifest",
      message: "Persona manifest must include a non-empty personas array.",
    }));
    return { report, issues };
  }

  const seen = new Set();
  for (const entry of doc.personas) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(makeIssue({
        code: "persona_manifest_invalid_profile",
        surface: "persona_manifest",
        message: "Persona manifest entries must be objects.",
      }));
      continue;
    }

    const profileId = String(entry.id || "").trim();
    if (!/^[a-z][a-z0-9_]*$/.test(profileId)) {
      issues.push(makeIssue({
        code: "persona_manifest_invalid_profile_id",
        surface: "persona_manifest",
        message: `Persona profile id '${profileId || "(missing)"}' is invalid.`,
      }));
      continue;
    }
    if (seen.has(profileId)) {
      issues.push(makeIssue({
        code: "persona_manifest_duplicate_profile",
        surface: "persona_manifest",
        message: `Persona manifest contains duplicate profile '${profileId}'.`,
        detail: { profile: profileId },
      }));
    }
    seen.add(profileId);
    if (!KNOWN_DOMAIN_PROFILES.includes(profileId)) {
      issues.push(makeIssue({
        code: "persona_manifest_unknown_profile",
        surface: "persona_manifest",
        message: `Persona profile '${profileId}' has no authority expectation in persona_manifest_ci.`,
        repair_command: "Add a documented authority expectation for the new profile before shipping it.",
        detail: { profile: profileId },
      }));
    }

    const seedRoles = validateArrayField({ entry, field: "seed_roles", profileId, issues });
    const companions = validateArrayField({ entry, field: "expected_companions", profileId, issues });
    const terms = validateArrayField({ entry, field: "terms", profileId, issues });
    const manifestPaths = validateArrayField({ entry, field: "paths", profileId, issues });
    const deps = validateArrayField({ entry, field: "deps", profileId, issues });
    validateArrayField({ entry, field: "obligations", profileId, issues });

    if (seedRoles.length === 0) {
      issues.push(makeIssue({
        code: "persona_manifest_missing_seed_roles",
        surface: "persona_manifest",
        message: `Persona profile '${profileId}' must declare at least one seed role.`,
        detail: { profile: profileId },
      }));
    }
    if (terms.length + manifestPaths.length + deps.length === 0) {
      issues.push(makeIssue({
        code: "persona_manifest_missing_detection_surface",
        surface: "persona_manifest",
        message: `Persona profile '${profileId}' must declare at least one detection term, path, or dependency.`,
        detail: { profile: profileId },
      }));
    }
    validateRoles({ roles: seedRoles, profileId, field: "seed_roles", issues });
    validateRoles({ roles: companions, profileId, field: "expected_companions", issues });

    report.profiles.push({
      id: profileId,
      seed_roles: seedRoles,
      expected_companions: companions,
      term_count: terms.length,
      path_count: manifestPaths.length,
      dep_count: deps.length,
    });
  }

  report.profile_count = report.profiles.length;
  report.valid = issues.filter((entry) => entry.severity === "error").length === 0;
  return { report, issues };
}

function readAuditConfig(paths) {
  for (const candidate of paths.audit_config_candidates) {
    const parsed = readJson(candidate);
    if (parsed.present) return { path: candidate, ...parsed };
  }
  return {
    path: paths.audit_config_candidates[0],
    present: false,
    ok: false,
    value: null,
    error: "missing",
  };
}

function validateAuditConfig(paths) {
  const issues = [];
  const parsed = readAuditConfig(paths);
  const report = {
    path: parsed.path,
    present: parsed.present,
    valid: false,
    roles: [],
  };

  if (!parsed.present) {
    issues.push(makeIssue({
      code: "audit_config_missing",
      surface: "audit_config",
      message: "audit.config.json is missing; persona roles are not configured for CI.",
      repair_command: "Run `node .agent/skills/iterative-planner/scripts/migrate.mjs setup .` or create audit.config.json with explicit roles.",
    }));
    return { report, issues };
  }
  if (!parsed.ok) {
    issues.push(makeIssue({
      code: "audit_config_invalid_json",
      surface: "audit_config",
      message: `audit.config.json is invalid JSON: ${parsed.error}`,
      repair_command: "Fix audit.config.json, then rerun persona_manifest_ci.mjs.",
    }));
    return { report, issues };
  }
  const doc = parsed.value;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    issues.push(makeIssue({
      code: "audit_config_not_object",
      surface: "audit_config",
      message: "audit.config.json must be a JSON object.",
    }));
    return { report, issues };
  }
  if (!Array.isArray(doc.roles)) {
    issues.push(makeIssue({
      code: "audit_config_roles_not_array",
      surface: "audit_config",
      message: "audit.config.json roles must be an array.",
      repair_command: "Use `roles: [\"core\", ...]` with shipped persona role ids.",
    }));
    return { report, issues };
  }

  const roles = doc.roles.map((role) => String(role || "").trim()).filter(Boolean);
  report.roles = unique(roles);
  const allowed = knownRoles();
  const seen = new Set();
  for (const role of roles) {
    if (seen.has(role)) {
      issues.push(makeIssue({
        code: "audit_config_duplicate_role",
        surface: "audit_config",
        message: `audit.config.json declares duplicate role '${role}'.`,
        detail: { role },
      }));
    }
    seen.add(role);
    if (!/^[a-z][a-z0-9_]*$/.test(role)) {
      issues.push(makeIssue({
        code: "audit_config_invalid_role_name",
        surface: "audit_config",
        message: `audit.config.json role '${role}' is not a valid role id.`,
        detail: { role },
      }));
      continue;
    }
    if (!allowed.has(role)) {
      issues.push(makeIssue({
        code: "audit_config_unknown_role",
        surface: "audit_config",
        message: `audit.config.json references unknown persona role '${role}'.`,
        repair_command: "Use a shipped persona role, remove the role, or add a documented local pack before enabling it.",
        detail: { role },
      }));
    }
  }
  if (doc.fail_on !== undefined && !Array.isArray(doc.fail_on)) {
    issues.push(makeIssue({
      code: "audit_config_fail_on_not_array",
      surface: "audit_config",
      message: "audit.config.json fail_on must be an array when present.",
    }));
  }
  if (doc.force_packs !== undefined && !Array.isArray(doc.force_packs)) {
    issues.push(makeIssue({
      code: "audit_config_force_packs_not_array",
      surface: "audit_config",
      message: "audit.config.json force_packs must be an array when present.",
    }));
  }

  report.valid = issues.filter((entry) => entry.severity === "error").length === 0;
  return { report, issues };
}

function validateSeedRoles(projectRoot) {
  const issues = [];
  const adaptation = inferPersonaAdaptation(projectRoot, { commandTarget: "." });
  const missing = unique(adaptation.high_confidence_missing_seed_roles || adaptation.safe_apply_roles || []);

  if (adaptation.audit_config_valid === false) {
    issues.push(makeIssue({
      code: "persona_adaptation_invalid_audit_config",
      surface: "persona_adaptation",
      message: adaptation.audit_config_error || "persona adaptation could not parse audit.config.json",
      repair_command: "Fix audit.config.json, then rerun persona_manifest_ci.mjs.",
    }));
  }
  if (missing.length > 0) {
    issues.push(makeIssue({
      code: "missing_required_seed_roles",
      surface: "persona_adaptation",
      message: `High-confidence required persona seed role(s) are missing: ${missing.join(", ")}.`,
      repair_command: adaptation.recommended_command || "node .agent/skills/iterative-planner/scripts/persona_adapt.mjs apply . --safe",
      detail: { missing_seed_roles: missing },
    }));
  } else if (isProblematicPersonaStatus(adaptation.status)) {
    issues.push(makeIssue({
      code: "persona_adaptation_advisory",
      severity: "warning",
      surface: "persona_adaptation",
      message: `Persona adaptation reports '${adaptation.status}' but no high-confidence safe-apply role is required.`,
      repair_command: adaptation.recommended_command || null,
    }));
  }

  return {
    report: {
      status: adaptation.status,
      confidence: adaptation.confidence,
      configured_roles: adaptation.configured_roles || [],
      domain_profiles: adaptation.domain_profiles || [],
      missing_seed_roles: adaptation.missing_seed_roles || [],
      high_confidence_missing_seed_roles: missing,
      recommended_command: adaptation.recommended_command || null,
    },
    issues,
  };
}

function validateRootInstructions(paths) {
  const issues = [];
  const templateContent = readText(paths.root_instruction_template);
  const canonicalSections = collectCanonicalRootInstructionSections(templateContent);
  const validTemplate = !!templateContent && canonicalSections.length === ROOT_INSTRUCTION_SECTION_HEADINGS.length;
  const targets = [];

  if (!validTemplate) {
    issues.push(makeIssue({
      code: "root_instruction_template_invalid",
      surface: "root_instructions",
      message: "Root instruction template is missing or does not expose all canonical managed sections.",
      repair_command: "Repair .agent/skills/iterative-planner/references/CLAUDE.template.md, then rerun persona_manifest_ci.mjs.",
    }));
    return {
      report: {
        template_path: paths.root_instruction_template,
        valid_template: false,
        targets,
      },
      issues,
    };
  }

  for (const target of ROOT_INSTRUCTION_TARGETS) {
    const targetPath = join(paths.project_root, target.path);
    const exists = existsSync(targetPath);
    const content = readText(targetPath);
    const status = rootInstructionParityStatus({
      target,
      exists,
      content,
      canonicalSections,
    });
    const entry = {
      id: target.id,
      path: target.path,
      status,
      required: !!target.create_by_default,
    };
    targets.push(entry);

    const failing = ["missing", "missing_snapshot", "stale_snapshot"].includes(status) ||
      (target.create_by_default && status === "custom_unmanaged");
    if (failing) {
      issues.push(makeIssue({
        code: `root_instruction_${issueCodeParts(status)}`,
        surface: "root_instructions",
        message: `Root instruction target '${target.path}' is ${status}.`,
        repair_command: "bash .agent/scripts/sync-instructions.sh",
        detail: entry,
      }));
    }
  }

  return {
    report: {
      template_path: paths.root_instruction_template,
      valid_template: true,
      targets,
    },
    issues,
  };
}

function validateAuthorityDecisions(manifestReport) {
  const issues = [];
  const decisions = [];

  for (const profile of manifestReport.profiles || []) {
    const expectation = AUTHORITY_EXPECTATIONS[profile.id];
    if (!expectation) continue;
    const decision = decideDomainProfileActivation(profile.id, {
      planShape: { primary: "planner-core" },
      forcePacks: [],
      evidence: ["persona_manifest_ci"],
    });
    decisions.push(decision);
    const active = new Set(decision.active_packs || []);
    const suppressed = new Set(decision.suppressed_packs || []);

    if (decision.authority !== expectation.authority) {
      issues.push(makeIssue({
        code: "authority_decision_drift",
        surface: "persona_authority",
        message: `Persona profile '${profile.id}' authority is '${decision.authority}', expected '${expectation.authority}' for planner-core.`,
        repair_command: "Update persona_activation_authority.mjs and persona_manifest_ci expectations together, or document the decision path.",
        detail: { profile: profile.id, decision, expectation },
      }));
      continue;
    }

    for (const packId of expectation.active_packs || []) {
      if (!active.has(packId)) {
        issues.push(makeIssue({
          code: "authority_decision_drift",
          surface: "persona_authority",
          message: `Persona profile '${profile.id}' should keep '${packId}' active for planner-core work.`,
          repair_command: "Update persona_activation_authority.mjs and persona_manifest_ci expectations together, or document the decision path.",
          detail: { profile: profile.id, pack_id: packId, decision, expectation },
        }));
      }
    }
    for (const packId of expectation.suppressed_packs || []) {
      if (!suppressed.has(packId)) {
        issues.push(makeIssue({
          code: "authority_decision_drift",
          surface: "persona_authority",
          message: `Persona profile '${profile.id}' should suppress '${packId}' for planner-core work unless forced.`,
          repair_command: "Update persona_activation_authority.mjs and persona_manifest_ci expectations together, or document the decision path.",
          detail: { profile: profile.id, pack_id: packId, decision, expectation },
        }));
      }
    }
  }

  return {
    report: {
      plan_shape: "planner-core",
      decisions,
    },
    issues,
  };
}

function summarizeSurface(issues) {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  return errors > 0 ? "FAIL" : warnings > 0 ? "WARN" : "PASS";
}

export function runPersonaManifestCi({
  projectRoot = process.cwd(),
  skillRoot = null,
  checkRootInstructions = true,
} = {}) {
  const paths = resolvePaths(projectRoot, skillRoot);
  const allIssues = [];

  const manifest = validatePersonaManifest(paths);
  allIssues.push(...manifest.issues);

  const auditConfig = validateAuditConfig(paths);
  allIssues.push(...auditConfig.issues);

  const seedRoles = validateSeedRoles(paths.project_root);
  allIssues.push(...seedRoles.issues);

  const rootInstructions = checkRootInstructions
    ? validateRootInstructions(paths)
    : { report: { skipped: true, targets: [] }, issues: [] };
  allIssues.push(...rootInstructions.issues);

  const authority = validateAuthorityDecisions(manifest.report);
  allIssues.push(...authority.issues);

  const errorCount = allIssues.filter((issue) => issue.severity === "error").length;
  const warningCount = allIssues.filter((issue) => issue.severity === "warning").length;

  return {
    ok: errorCount === 0,
    status: errorCount > 0 ? "FAIL" : "PASS",
    generated_at: new Date().toISOString(),
    project_root: paths.project_root,
    skill_root: paths.skill_root,
    summary: {
      error_count: errorCount,
      warning_count: warningCount,
      issue_count: allIssues.length,
    },
    surfaces: {
      persona_manifest: {
        status: summarizeSurface(manifest.issues),
        ...manifest.report,
      },
      audit_config: {
        status: summarizeSurface(auditConfig.issues),
        ...auditConfig.report,
      },
      persona_adaptation: {
        status: summarizeSurface(seedRoles.issues),
        ...seedRoles.report,
      },
      root_instructions: {
        status: summarizeSurface(rootInstructions.issues),
        ...rootInstructions.report,
      },
      persona_authority: {
        status: summarizeSurface(authority.issues),
        ...authority.report,
      },
    },
    issues: allIssues,
  };
}

export function formatPersonaManifestCiReport(report) {
  const lines = [
    "Persona Manifest CI",
    "",
    `  Project: ${report.project_root}`,
    `  Status: ${report.status}`,
    `  Issues: ${report.summary.error_count} error(s), ${report.summary.warning_count} warning(s)`,
    "",
  ];

  for (const [surface, value] of Object.entries(report.surfaces || {})) {
    lines.push(`  ${surface}: ${value.status}`);
  }

  if ((report.issues || []).length > 0) {
    lines.push("", "Issues:");
    for (const issue of report.issues) {
      const marker = issue.severity === "error" ? "ERROR" : "WARN";
      lines.push(`  - [${marker}] ${issue.code}: ${issue.message}`);
      if (issue.repair_command) lines.push(`    Repair: ${issue.repair_command}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
