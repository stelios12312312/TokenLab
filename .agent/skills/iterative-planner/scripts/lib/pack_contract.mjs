// pack_contract.mjs - deterministic E5 pack shipping contract validation.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { normalizeVerificationStatus, verificationStatusIsPass } from "./verification_status_vocabulary.mjs";

export const PACK_CONTRACT_VERSION = 1;
export const PACK_CONTRACT_FILENAME = "pack_contract.json";

export const KERNEL_PROCESS_PERSONA_EXEMPTIONS = Object.freeze({
  assumptions_challenger: "kernel_process_persona",
  traceability: "kernel_process_persona",
  config_integrity: "kernel_process_persona",
  wiring_auditor: "kernel_process_persona",
});

export const NON_PACK_DIRS = new Set(["_template"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_DIR = resolve(__dirname, "..", "..");
const DEFAULT_ROOT_DIR = resolve(SKILL_DIR, "..", "..", "..");
const DEFAULT_PACKS_DIR = join(SKILL_DIR, "packs");
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const PACK_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER_PROJECT_PATTERN = /^(example|sample|todo|tbd|test|demo|your[-_ ]?project)$/i;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function stripRefFragment(ref) {
  return String(ref || "").split("#")[0];
}

function resolveRepoRef(ref, rootDir) {
  const stripped = stripRefFragment(ref);
  if (!isNonEmptyString(stripped)) return null;
  return resolve(rootDir, stripped);
}

function refExists(ref, rootDir) {
  const resolved = resolveRepoRef(ref, rootDir);
  return !!resolved && existsSync(resolved);
}

function loadJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function checkerSourceRef(checker) {
  for (const field of ["module", "script", "path"]) {
    if (isNonEmptyString(checker[field])) return { field, value: checker[field] };
  }
  return null;
}

function hasCommand(value) {
  if (isNonEmptyString(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function normalizedServedProjectId(entry) {
  if (isNonEmptyString(entry)) return entry.trim();
  if (isPlainObject(entry) && isNonEmptyString(entry.id)) return entry.id.trim();
  return "";
}

function uniqueRealServedProjects(entries) {
  const ids = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = normalizedServedProjectId(entry);
    if (!id || PLACEHOLDER_PROJECT_PATTERN.test(id)) continue;
    ids.add(id);
  }
  return ids;
}

function loadRegistryEntries(ref, rootDir, collectionName, errors, path) {
  if (!isNonEmptyString(ref)) return [];
  const resolved = resolveRepoRef(ref, rootDir);
  if (!resolved || !existsSync(resolved)) return [];
  try {
    const parsed = loadJsonFile(resolved);
    if (!Array.isArray(parsed?.[collectionName])) {
      addIssue(errors, `${collectionName}_registry_missing`, path, `${path} must contain a ${collectionName} array`);
      return [];
    }
    return parsed[collectionName];
  } catch (err) {
    addIssue(errors, `${collectionName}_registry_unreadable`, path, `${path} could not be parsed: ${err.message}`);
    return [];
  }
}

function validateRubrics(contract, errors) {
  if (!Array.isArray(contract.rubrics) || contract.rubrics.length === 0) {
    addIssue(errors, "rubrics_missing", "rubrics", "rubrics must be a non-empty array");
    return;
  }

  const seen = new Set();
  contract.rubrics.forEach((rubric, index) => {
    const base = `rubrics[${index}]`;
    if (!isPlainObject(rubric)) {
      addIssue(errors, "rubric_not_object", base, "rubric entries must be objects");
      return;
    }
    if (!isNonEmptyString(rubric.id) || !ID_PATTERN.test(rubric.id)) {
      addIssue(errors, "rubric_id_invalid", `${base}.id`, "rubric id must match /^[a-z][a-z0-9_-]*$/");
    } else if (seen.has(rubric.id)) {
      addIssue(errors, "rubric_id_duplicate", `${base}.id`, `duplicate rubric id '${rubric.id}'`);
    } else {
      seen.add(rubric.id);
    }
    if (!isNonEmptyString(rubric.question)) {
      addIssue(errors, "rubric_question_missing", `${base}.question`, "rubric question must be non-empty");
    }
    if (rubric.closed_question !== true) {
      addIssue(errors, "rubric_not_closed_question", `${base}.closed_question`, "rubrics must be closed questions");
    }
    if (!Array.isArray(rubric.allowed_answers) || rubric.allowed_answers.length < 2 || !rubric.allowed_answers.every(isNonEmptyString)) {
      addIssue(errors, "rubric_allowed_answers_invalid", `${base}.allowed_answers`, "closed rubrics require at least two non-empty allowed answers");
    }
  });
}

function validateCheckers(contract, { rootDir, seededDefectIds }, errors) {
  if (!Array.isArray(contract.checkers) || contract.checkers.length === 0) {
    addIssue(errors, "checkers_missing", "checkers", "checkers must be a non-empty array");
    return;
  }

  const seen = new Set();
  contract.checkers.forEach((checker, index) => {
    const base = `checkers[${index}]`;
    if (!isPlainObject(checker)) {
      addIssue(errors, "checker_not_object", base, "checker entries must be objects");
      return;
    }
    if (!isNonEmptyString(checker.id) || !ID_PATTERN.test(checker.id)) {
      addIssue(errors, "checker_id_invalid", `${base}.id`, "checker id must match /^[a-z][a-z0-9_-]*$/");
    } else if (seen.has(checker.id)) {
      addIssue(errors, "checker_id_duplicate", `${base}.id`, `duplicate checker id '${checker.id}'`);
    } else {
      seen.add(checker.id);
    }
    if (checker.deterministic !== true) {
      addIssue(errors, "checker_not_deterministic", `${base}.deterministic`, "checkers must declare deterministic: true");
    }
    const source = checkerSourceRef(checker);
    if (!source && !hasCommand(checker.command)) {
      addIssue(errors, "checker_source_missing", base, "checker must declare command, module, script, or path");
    }
    if (source && !refExists(source.value, rootDir)) {
      addIssue(errors, "checker_source_missing_file", `${base}.${source.field}`, `checker ${source.field} '${source.value}' does not exist`);
    }
    if (!Array.isArray(checker.seeded_defect_ids) || checker.seeded_defect_ids.length === 0 || !checker.seeded_defect_ids.every(isNonEmptyString)) {
      addIssue(errors, "checker_seeded_defect_ids_missing", `${base}.seeded_defect_ids`, "checker must declare at least one seeded defect id");
    } else {
      for (const defectId of checker.seeded_defect_ids) {
        if (!seededDefectIds.has(defectId)) {
          addIssue(errors, "checker_seeded_defect_missing", `${base}.seeded_defect_ids`, `seeded defect '${defectId}' is not declared for this pack`);
        }
      }
    }
  });
}

function validateRefs(contract, { rootDir, packId }, errors) {
  for (const [field, code] of [
    ["calibration_ref", "calibration_ref_missing"],
    ["goldens_ref", "goldens_ref_missing"],
    ["seeded_defects_ref", "seeded_defects_ref_missing"],
  ]) {
    if (!isNonEmptyString(contract[field])) {
      addIssue(errors, code, field, `${field} must be a non-empty repo-relative ref`);
    } else if (!refExists(contract[field], rootDir)) {
      addIssue(errors, `${field}_file_missing`, field, `${field} '${contract[field]}' does not exist`);
    }
  }

  const goldenEntries = loadRegistryEntries(contract.goldens_ref, rootDir, "fixtures", errors, "goldens_ref");
  if (!goldenEntries.some((entry) => entry?.pack_id === packId)) {
    addIssue(errors, "goldens_pack_entry_missing", "goldens_ref", `goldens_ref must contain at least one fixture for pack '${packId}'`);
  }

  const seededEntries = loadRegistryEntries(contract.seeded_defects_ref, rootDir, "defects", errors, "seeded_defects_ref");
  const seededForPack = seededEntries.filter((entry) => entry?.pack_id === packId && isNonEmptyString(entry?.id));
  if (seededForPack.length === 0) {
    addIssue(errors, "seeded_defects_pack_entry_missing", "seeded_defects_ref", `seeded_defects_ref must contain at least one defect for pack '${packId}'`);
  }
  return new Set(seededForPack.map((entry) => entry.id));
}

function validateServesProjects(contract, errors) {
  if (!Array.isArray(contract.serves_projects)) {
    addIssue(errors, "serves_projects_missing", "serves_projects", "serves_projects must be an array");
    return;
  }
  const realProjects = uniqueRealServedProjects(contract.serves_projects);
  if (realProjects.size < 2) {
    addIssue(errors, "serves_projects_too_few", "serves_projects", "serves_projects must name at least two real projects");
  }
  contract.serves_projects.forEach((entry, index) => {
    if (isNonEmptyString(entry)) return;
    if (isPlainObject(entry) && isNonEmptyString(entry.id) && isNonEmptyString(entry.evidence_ref)) return;
    addIssue(errors, "serves_project_invalid", `serves_projects[${index}]`, "served project entries must be strings or { id, evidence_ref } objects");
  });
}

export function validatePackContract(contract, { packId = null, packDir = null, rootDir = DEFAULT_ROOT_DIR } = {}) {
  const errors = [];
  const warnings = [];
  const expectedPackId = packId || (packDir ? basename(packDir) : null);

  if (!isPlainObject(contract)) {
    addIssue(errors, "contract_not_object", "$", "pack contract must be a JSON object");
    return { ok: false, status: "FAIL", pack_id: expectedPackId, errors, warnings };
  }

  if (contract.schema_version !== PACK_CONTRACT_VERSION) {
    addIssue(errors, "schema_version_invalid", "schema_version", `schema_version must be ${PACK_CONTRACT_VERSION}`);
  }
  if (!isNonEmptyString(contract.pack_id) || !PACK_ID_PATTERN.test(contract.pack_id)) {
    addIssue(errors, "pack_id_invalid", "pack_id", "pack_id must match /^[a-z][a-z0-9_]*$/");
  } else if (expectedPackId && contract.pack_id !== expectedPackId) {
    addIssue(errors, "pack_id_mismatch", "pack_id", `pack_id '${contract.pack_id}' must match directory '${expectedPackId}'`);
  }

  const effectivePackId = isNonEmptyString(contract.pack_id) ? contract.pack_id : expectedPackId;
  validateRubrics(contract, errors);
  const seededDefectIds = validateRefs(contract, { rootDir, packId: effectivePackId }, errors);
  validateCheckers(contract, { rootDir, seededDefectIds }, errors);
  validateServesProjects(contract, errors);

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "FAIL",
    pack_id: effectivePackId,
    errors,
    warnings,
  };
}

export function validatePackContractFile(contractPath, { packDir = null, rootDir = DEFAULT_ROOT_DIR } = {}) {
  const resolvedPath = resolve(contractPath);
  const resolvedPackDir = packDir ? resolve(packDir) : dirname(resolvedPath);
  const packId = basename(resolvedPackDir);
  try {
    const contract = loadJsonFile(resolvedPath);
    return {
      ...validatePackContract(contract, { packId, packDir: resolvedPackDir, rootDir }),
      contract_path: resolvedPath,
      pack_dir: resolvedPackDir,
    };
  } catch (err) {
    return {
      ok: false,
      status: "FAIL",
      pack_id: packId,
      contract_path: resolvedPath,
      pack_dir: resolvedPackDir,
      errors: [
        {
          code: "contract_read_failed",
          path: "$",
          message: err?.message || String(err),
        },
      ],
      warnings: [],
    };
  }
}

function validatePackDir(packDir, { rootDir }) {
  const packId = basename(packDir);
  if (NON_PACK_DIRS.has(packId)) {
    return {
      ok: true,
      status: "SKIPPED",
      reason_code: "template_pack",
      pack_id: packId,
      pack_dir: packDir,
      errors: [],
      warnings: [],
    };
  }
  if (KERNEL_PROCESS_PERSONA_EXEMPTIONS[packId]) {
    return {
      ok: true,
      status: "EXEMPT",
      reason_code: KERNEL_PROCESS_PERSONA_EXEMPTIONS[packId],
      pack_id: packId,
      pack_dir: packDir,
      errors: [],
      warnings: [],
    };
  }

  const contractPath = join(packDir, PACK_CONTRACT_FILENAME);
  if (!existsSync(contractPath)) {
    return {
      ok: false,
      status: "FAIL",
      pack_id: packId,
      pack_dir: packDir,
      contract_path: contractPath,
      errors: [
        {
          code: "pack_contract_missing",
          path: PACK_CONTRACT_FILENAME,
          message: `non-exempt pack '${packId}' must include ${PACK_CONTRACT_FILENAME}`,
        },
      ],
      warnings: [],
    };
  }
  return validatePackContractFile(contractPath, { packDir, rootDir });
}

export function validatePackContracts({
  rootDir = DEFAULT_ROOT_DIR,
  packsDir = DEFAULT_PACKS_DIR,
  packIds = null,
} = {}) {
  const resolvedRoot = resolve(rootDir);
  const resolvedPacksDir = resolve(packsDir);
  const errors = [];
  const warnings = [];

  if (!existsSync(resolvedPacksDir)) {
    addIssue(errors, "packs_dir_missing", "packs_dir", `packs directory '${resolvedPacksDir}' does not exist`);
    return {
      ok: false,
      status: "FAIL",
      root_dir: resolvedRoot,
      packs_dir: resolvedPacksDir,
      pack_results: [],
      errors,
      warnings,
      counts: { checked: 0, passed: 0, failed: 1, exempt: 0, skipped: 0 },
    };
  }

  const selected = new Set(Array.isArray(packIds) ? packIds : []);
  const packDirs = readdirSync(resolvedPacksDir)
    .map((entry) => join(resolvedPacksDir, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .filter((entryPath) => selected.size === 0 || selected.has(basename(entryPath)))
    .sort();

  const packResults = packDirs.map((packDir) => validatePackDir(packDir, { rootDir: resolvedRoot }));
  for (const result of packResults) {
    for (const error of result.errors || []) {
      errors.push({ ...error, pack_id: result.pack_id });
    }
    for (const warning of result.warnings || []) {
      warnings.push({ ...warning, pack_id: result.pack_id });
    }
  }

  const exemptionReasons = new Set(Object.values(KERNEL_PROCESS_PERSONA_EXEMPTIONS));
  const isExempt = (result) => result.ok === true && exemptionReasons.has(result.reason_code);
  const isSkipped = (result) => {
    const status = normalizeVerificationStatus(result.status, "execution");
    return result.ok === true && status.kind === "pending" && status.token !== "unknown";
  };
  const isPassed = (result) => result.ok === true
    && verificationStatusIsPass(result.status, "execution");
  const failed = packResults.filter((result) => !isPassed(result) && !isExempt(result) && !isSkipped(result)).length;
  const passed = packResults.filter(isPassed).length;
  const exempt = packResults.filter(isExempt).length;
  const skipped = packResults.filter(isSkipped).length;

  return {
    ok: failed === 0,
    status: failed === 0 ? "PASS" : "FAIL",
    root_dir: resolvedRoot,
    packs_dir: resolvedPacksDir,
    pack_results: packResults,
    errors,
    warnings,
    counts: {
      checked: packResults.length,
      passed,
      failed,
      exempt,
      skipped,
    },
  };
}

export function defaultRootDir() {
  return DEFAULT_ROOT_DIR;
}

export function defaultPacksDir() {
  return DEFAULT_PACKS_DIR;
}
