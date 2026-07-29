#!/usr/bin/env node
// Story Registry — enforcement + query tool for story_registry.json
//
// Usage:
//   node story_registry.mjs check                    Validate registry schema & file refs
//   node story_registry.mjs evidence [<story-id>]    Show close-time evidence readiness for one story or all incomplete stories
//   node story_registry.mjs freshness                Report age of registry (days, commits)
//   node story_registry.mjs diff <file> [<file>...]  Show stories affected by changed files
//   node story_registry.mjs prune --safe [--write]   List or safely repair stale evidence refs
//   node story_registry.mjs summary                  One-line health summary
//   node story_registry.mjs --json                   Machine-readable output (combine with any command)
//
// Reads from: reports/user_story_audit/story_registry.json
// Exit codes: 0 = OK, 1 = validation errors found

import { readFileSync, existsSync, statSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve, sep } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { normalizeVerificationStatus } from "./lib/verification_status_vocabulary.mjs";

// Validate that a value is a safe git commit hash (7–40 hex chars).
// Returns the trimmed hash or null if invalid.
function safeCommitHash(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

const cwd = process.cwd();
const registryPath = join(cwd, "reports", "user_story_audit", "story_registry.json");
const EVIDENCE_FIELDS = ["code_refs", "test_refs", "validation_refs"];
const AUDIT_PACKET_REQUIRED_FILES = [
  "coverage_summary.md",
  "traceability_matrix.md",
  "findings.md",
  "remediation_plan.md",
];
const LEGACY_COVERAGE_CONTRACT_VERSION = 1;
export const CURRENT_COVERAGE_CONTRACT_VERSION = 2;
const SUPPORTED_EXECUTED_PROOF_KINDS = new Set(["ive_suite", "executed_test_gate"]);
const MAX_EXECUTED_PROOF_BYTES = 1_048_576;

function fileExistsForRef(ref, projectRoot = cwd) {
  const filePath = refPathForFilesystem(ref);
  return Boolean(filePath) && existsSync(join(projectRoot, filePath));
}

function refPathForFilesystem(ref) {
  return String(ref || "").trim().replace(/^\.\//, "").split(":")[0];
}

function safeProjectFile(root, ref) {
  const relativePath = refPathForFilesystem(ref);
  if (!relativePath || isAbsolute(relativePath)) return null;
  const projectRoot = resolve(root);
  const target = resolve(projectRoot, relativePath);
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${sep}`)) return null;
  return target;
}

function readJsonArtifact(root, ref) {
  const target = safeProjectFile(root, ref);
  if (!target) return { ok: false, error: `unsafe project-relative artifact path '${ref}'` };
  if (!existsSync(target)) return { ok: false, error: `artifact '${ref}' does not exist` };
  try {
    if (statSync(target).size > MAX_EXECUTED_PROOF_BYTES) {
      return { ok: false, error: `artifact '${ref}' exceeds the ${MAX_EXECUTED_PROOF_BYTES}-byte executed-proof limit` };
    }
    return { ok: true, value: JSON.parse(readFileSync(target, "utf-8")), path: target };
  } catch (error) {
    return { ok: false, error: `artifact '${ref}' is not valid JSON (${error.message})` };
  }
}

function nonEmptyCommand(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validExecutionWindow(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started;
}

function executionResultPass(status, exitCode) {
  return ["pass", "passed"].includes(String(status || "").trim().toLowerCase()) && exitCode === 0;
}

function proofFailure(proofRef, message) {
  return {
    ok: false,
    kind: String(proofRef?.kind || "unknown"),
    artifact: String(proofRef?.artifact || ""),
    selector: String(proofRef?.selector || ""),
    error: message,
  };
}

export function evaluateExecutedProofRef(proofRef, { cwd: projectRoot = cwd } = {}) {
  if (!proofRef || typeof proofRef !== "object" || Array.isArray(proofRef)) {
    return proofFailure(proofRef, "executed proof entry must be an object");
  }
  const kind = String(proofRef.kind || "").trim();
  const artifact = String(proofRef.artifact || "").trim();
  const selector = String(proofRef.selector || "").trim();
  if (!SUPPORTED_EXECUTED_PROOF_KINDS.has(kind)) {
    return proofFailure(proofRef, `unsupported executed proof kind '${kind || "(blank)"}'`);
  }
  if (!artifact || !selector) {
    return proofFailure(proofRef, "executed proof requires non-blank artifact and selector");
  }

  const loaded = readJsonArtifact(projectRoot, artifact);
  if (!loaded.ok) return proofFailure(proofRef, loaded.error);

  if (kind === "ive_suite") {
    const suite = Array.isArray(loaded.value?.suites)
      ? loaded.value.suites.find((entry) => String(entry?.id || "") === selector)
      : null;
    if (!suite) return proofFailure(proofRef, `IVE manifest '${artifact}' has no suite '${selector}'`);
    if (!nonEmptyCommand(suite.command)) return proofFailure(proofRef, `IVE suite '${selector}' has no recorded command`);
    if (String(suite.status || "").trim().toLowerCase() !== "pass") {
      return proofFailure(proofRef, `IVE suite '${selector}' did not pass`);
    }
    const proofArtifact = String(suite.proof_artifact || "").trim();
    if (!proofArtifact) return proofFailure(proofRef, `IVE suite '${selector}' has no proof_artifact`);
    const proofLoaded = readJsonArtifact(projectRoot, proofArtifact);
    if (!proofLoaded.ok) return proofFailure(proofRef, proofLoaded.error);
    const proof = proofLoaded.value;
    if (String(proof?.id || "") !== selector) return proofFailure(proofRef, `IVE proof id does not match selector '${selector}'`);
    if (!nonEmptyCommand(proof?.command)) return proofFailure(proofRef, `IVE proof '${selector}' has no recorded command`);
    if (String(proof.command).trim() !== String(suite.command).trim()) {
      return proofFailure(proofRef, `IVE manifest and proof commands disagree for '${selector}'`);
    }
    if (!executionResultPass(proof?.status, proof?.exit_code)) {
      return proofFailure(proofRef, `IVE proof '${selector}' has no successful observable result`);
    }
    if (!validExecutionWindow(proof?.started_at, proof?.finished_at)) {
      return proofFailure(proofRef, `IVE proof '${selector}' has no valid execution timestamps`);
    }
    return {
      ok: true,
      kind,
      artifact,
      selector,
      validation_ref: artifact,
      command: String(proof.command),
      result: { status: String(proof.status), exit_code: proof.exit_code },
      started_at: proof.started_at,
      finished_at: proof.finished_at,
      proof_artifact: proofArtifact,
    };
  }

  const gate = loaded.value?.gates?.[selector];
  if (!gate) return proofFailure(proofRef, `executed-test-gates artifact '${artifact}' has no gate '${selector}'`);
  if (String(gate.gate || selector) !== selector) return proofFailure(proofRef, `executed gate id does not match selector '${selector}'`);
  if (!nonEmptyCommand(gate.command)) return proofFailure(proofRef, `executed gate '${selector}' has no recorded command`);
  if (!executionResultPass(gate.status, gate.exit_code)) {
    return proofFailure(proofRef, `executed gate '${selector}' has no successful observable result`);
  }
  if (!validExecutionWindow(gate.started_at, gate.finished_at)) {
    return proofFailure(proofRef, `executed gate '${selector}' has no valid execution timestamps`);
  }
  return {
    ok: true,
    kind,
    artifact,
    selector,
    validation_ref: artifact,
    command: String(gate.command),
    result: { status: String(gate.status), exit_code: gate.exit_code },
    started_at: gate.started_at,
    finished_at: gate.finished_at,
  };
}

export function storyCoverageContractVersion(story, registry) {
  const explicit = Number(story?.coverage_contract_version);
  if (explicit === CURRENT_COVERAGE_CONTRACT_VERSION) return CURRENT_COVERAGE_CONTRACT_VERSION;
  if (explicit === LEGACY_COVERAGE_CONTRACT_VERSION) return LEGACY_COVERAGE_CONTRACT_VERSION;
  return LEGACY_COVERAGE_CONTRACT_VERSION;
}

function legacyStoryIds(registry) {
  return allRegistryStories(registry)
    .filter((story) => Number(story?.coverage_contract_version || LEGACY_COVERAGE_CONTRACT_VERSION) === LEGACY_COVERAGE_CONTRACT_VERSION)
    .map((story) => String(story?.id || ""))
    .filter(Boolean)
    .sort();
}

export function legacyStoryPopulationDigest(registry) {
  const ids = legacyStoryIds(registry);
  return {
    story_count: ids.length,
    story_ids_sha256: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
  };
}

export function validateCoverageContract(registry) {
  const errors = [];
  const contract = registry?.coverage_contract;
  if (contract === undefined) return { errors, mode: "legacy_unpinned", legacy_population: null };
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return { errors: ["coverage_contract must be an object"], mode: "invalid", legacy_population: null };
  }
  if (contract.legacy_version !== LEGACY_COVERAGE_CONTRACT_VERSION) {
    errors.push(`coverage_contract.legacy_version must be ${LEGACY_COVERAGE_CONTRACT_VERSION}`);
  }
  if (contract.current_version !== CURRENT_COVERAGE_CONTRACT_VERSION) {
    errors.push(`coverage_contract.current_version must be ${CURRENT_COVERAGE_CONTRACT_VERSION}`);
  }
  if (typeof contract.effective_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(contract.effective_at) || !Number.isFinite(Date.parse(contract.effective_at))) {
    errors.push("coverage_contract.effective_at must be an ISO timestamp");
  }
  const expected = contract.legacy_population;
  if (!expected || typeof expected !== "object") {
    errors.push("coverage_contract.legacy_population must pin story_count and story_ids_sha256");
  }
  const actual = legacyStoryPopulationDigest(registry);
  if (!Number.isInteger(expected?.story_count) || expected.story_count < 0) {
    errors.push("coverage_contract.legacy_population.story_count must be a non-negative integer");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(expected?.story_ids_sha256 || ""))) {
    errors.push("coverage_contract.legacy_population.story_ids_sha256 must be a SHA-256 digest");
  }
  if (Number.isInteger(expected?.story_count) && expected.story_count !== actual.story_count) {
    errors.push(`coverage_contract legacy population count mismatch (pinned ${expected.story_count}, found ${actual.story_count})`);
  }
  if (/^[a-f0-9]{64}$/i.test(String(expected?.story_ids_sha256 || "")) && expected.story_ids_sha256 !== actual.story_ids_sha256) {
    errors.push(`coverage_contract legacy population digest mismatch (pinned ${expected.story_ids_sha256}, found ${actual.story_ids_sha256})`);
  }
  for (const story of allRegistryStories(registry)) {
    const rawVersion = story?.coverage_contract_version;
    if (rawVersion !== undefined && ![LEGACY_COVERAGE_CONTRACT_VERSION, CURRENT_COVERAGE_CONTRACT_VERSION].includes(Number(rawVersion))) {
      errors.push(`${story.id || "unknown"}: coverage_contract_version must be 1 or 2`);
    }
  }
  return { errors, mode: "versioned", legacy_population: actual };
}

export function evaluateStoryExecutedProof(story, { registry = null, cwd: projectRoot = cwd } = {}) {
  const contractVersion = storyCoverageContractVersion(story, registry);
  const refs = story?.executed_proof_refs;
  const issues = [];
  const valid = [];
  if (contractVersion !== CURRENT_COVERAGE_CONTRACT_VERSION) {
    if (refs !== undefined) issues.push("legacy story declares executed_proof_refs; migrate it to coverage_contract_version 2 first");
    return { contract_version: contractVersion, valid, issues, executed: false };
  }
  if (refs !== undefined && !Array.isArray(refs)) {
    issues.push("executed_proof_refs must be an array");
    return { contract_version: contractVersion, valid, issues, executed: false };
  }
  for (const proofRef of Array.isArray(refs) ? refs : []) {
    const result = evaluateExecutedProofRef(proofRef, { cwd: projectRoot });
    const artifact = String(proofRef?.artifact || "").trim();
    if (!Array.isArray(story?.validation_refs) || !story.validation_refs.includes(artifact)) {
      issues.push(`executed proof artifact '${artifact || "(blank)"}' is not present in validation_refs`);
      continue;
    }
    if (result.ok) valid.push(result);
    else issues.push(result.error);
  }
  return { contract_version: contractVersion, valid, issues, executed: valid.length > 0 };
}

function collectRefWarnings(story, field, warnings, projectRoot = cwd) {
  if (!Array.isArray(story[field])) return;
  const singular = field.replace(/s$/, "");
  for (const ref of story[field]) {
    if (!fileExistsForRef(ref, projectRoot)) {
      warnings.push(`${story.id}: ${singular} '${ref}' — file not found`);
    }
  }
}

export function buildStoryEvidenceReport(story, registry = null, projectRoot = cwd) {
  const issues = [];
  const counts = {};
  const status = story.status || "UNKNOWN";

  if (status === "RETIRED" || status === "NOT_IMPLEMENTED") {
    for (const field of EVIDENCE_FIELDS) {
      const refs = Array.isArray(story[field]) ? story[field] : [];
      counts[field] = refs.length;
    }
    return {
      id: story.id,
      title: story.title || "",
      status,
      counts,
      issues,
      evidence_ready: true,
      guidance: status === "RETIRED"
        ? "Retired stories are historical records and do not require an active evidence chain."
        : "Not-implemented stories are backlog records and do not require code/test/validation evidence until implementation begins.",
    };
  }

  for (const field of EVIDENCE_FIELDS) {
    const refs = Array.isArray(story[field]) ? story[field] : [];
    counts[field] = refs.length;

    if (refs.length === 0) {
      issues.push({
        field,
        type: "missing_field",
        message: `missing ${field}`,
      });
      continue;
    }

    for (const ref of refs) {
      if (!fileExistsForRef(ref, projectRoot)) {
        issues.push({
          field,
          type: "missing_file",
          ref,
          message: `${field} entry '${ref}' points to a missing file`,
        });
      }
    }
  }

  const executedProof = evaluateStoryExecutedProof(story, { registry, cwd: projectRoot });
  counts.executed_proof_refs = Array.isArray(story.executed_proof_refs) ? story.executed_proof_refs.length : 0;
  counts.executed_proofs_valid = executedProof.valid.length;
  if (executedProof.contract_version === CURRENT_COVERAGE_CONTRACT_VERSION) {
    for (const message of executedProof.issues) {
      issues.push({ field: "executed_proof_refs", type: "invalid_executed_proof", message });
    }
    if (!executedProof.executed) {
      issues.push({
        field: "executed_proof_refs",
        type: "missing_executed_proof",
        message: "current coverage contract requires at least one valid executed proof",
      });
    }
  } else if (executedProof.issues.length > 0) {
    for (const message of executedProof.issues) {
      issues.push({ field: "executed_proof_refs", type: "invalid_executed_proof", message });
    }
  }

  return {
    id: story.id,
    title: story.title || "",
    status,
    counts,
    issues,
    evidence_ready: issues.length === 0,
    guidance: issues.length === 0
      ? "Evidence chain inputs are present in story_registry.json."
      : "Update reports/user_story_audit/story_registry.json; @planner: annotations help coverage, but they do not create code_refs, test_refs, or validation_refs.",
  };
}

function summarizeEvidenceIssues(issues) {
  return (issues || []).map((issue) => issue.message).join("; ");
}

// ---------------------------------------------------------------------------
// Registry Access
// ---------------------------------------------------------------------------

function loadRegistry() {
  if (!existsSync(registryPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch (e) {
    return { _parseError: e.message };
  }
}

function parseReportMetadata(content) {
  const text = String(content || "");
  const dateMatch = text.match(/^\*\*Date\*\*:\s*([^\n]+)$/m);
  const commitMatch = text.match(/^\*\*Registry commit\*\*:\s*`([^`]+)`$/m);
  return {
    date: dateMatch ? dateMatch[1].trim() : null,
    commit: commitMatch ? safeCommitHash(commitMatch[1]) : null,
    referencesCanonicalSource: /story_registry\.json/.test(text),
  };
}

function validateAuditPacket(registry) {
  const errors = [];
  const warnings = [];
  const expectedDate = registry?.updated ? String(registry.updated).slice(0, 10) : null;
  const expectedCommit = safeCommitHash(registry?.commit);
  const packetDir = join(cwd, "reports", "user_story_audit");
  const existingPacketFiles = AUDIT_PACKET_REQUIRED_FILES.filter((fileName) => existsSync(join(packetDir, fileName)));

  if (existingPacketFiles.length === 0) {
    return { errors, warnings };
  }

  for (const fileName of AUDIT_PACKET_REQUIRED_FILES) {
    const filePath = join(packetDir, fileName);
    if (!existsSync(filePath)) {
      warnings.push(`Audit packet file missing: ${fileName}`);
      continue;
    }

    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (error) {
      errors.push(`${fileName}: unreadable (${error.message})`);
      continue;
    }

    const metadata = parseReportMetadata(content);
    if (!metadata.referencesCanonicalSource) {
      warnings.push(`${fileName}: missing canonical story_registry.json source marker`);
    }

    if (!metadata.date) {
      errors.push(`${fileName}: missing **Date** metadata`);
    } else if (expectedDate && metadata.date !== expectedDate) {
      errors.push(`${fileName}: packet date ${metadata.date} does not match story_registry.json updated date ${expectedDate}`);
    }

    if (expectedCommit) {
      if (!metadata.commit) {
        errors.push(`${fileName}: missing **Registry commit** metadata`);
      } else if (metadata.commit.toLowerCase() !== expectedCommit.toLowerCase()) {
        errors.push(`${fileName}: registry commit ${metadata.commit} does not match story_registry.json commit ${expectedCommit}`);
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Validation (check)
// ---------------------------------------------------------------------------

export function validateRegistry(registry, projectRoot = cwd) {
  const errors = [];
  const warnings = [];

  // Schema checks
  if (typeof registry.version !== "number") {
    errors.push("Missing or invalid 'version' field (expected number)");
  }
  if (!registry.updated || isNaN(Date.parse(registry.updated))) {
    errors.push("Missing or invalid 'updated' field (expected ISO date string)");
  }
  if (!Array.isArray(registry.stories)) {
    errors.push("Missing or invalid 'stories' field (expected array)");
    return { errors, warnings };
  }

  const coverageContract = validateCoverageContract(registry);
  errors.push(...coverageContract.errors);

  const ids = new Set();
  for (const story of allRegistryStories(registry)) {
    // Required fields
    if (!story.id) {
      errors.push(`Story missing 'id' field: ${JSON.stringify(story).slice(0, 80)}`);
      continue;
    }
    if (ids.has(story.id)) {
      errors.push(`Duplicate story ID: ${story.id}`);
    }
    ids.add(story.id);

    if (!story.title) warnings.push(`${story.id}: missing 'title'`);
    if (!story.status) warnings.push(`${story.id}: missing 'status'`);

    const validStatuses = ["FULLY_COVERED", "PARTIALLY_COVERED", "NOT_IMPLEMENTED", "RETIRED"];
    if (story.status && !validStatuses.includes(story.status)) {
      warnings.push(`${story.id}: unknown status '${story.status}' (expected: ${validStatuses.join(", ")})`);
    }

    // Array fields
    for (const field of ["code_refs", "test_refs", "doc_refs", "validation_refs"]) {
      if (story[field] && !Array.isArray(story[field])) {
        errors.push(`${story.id}: '${field}' must be an array`);
      }
    }

    collectRefWarnings(story, "code_refs", warnings, projectRoot);
    collectRefWarnings(story, "test_refs", warnings, projectRoot);
    collectRefWarnings(story, "validation_refs", warnings, projectRoot);

    if (story.status === "FULLY_COVERED") {
      const evidence = buildStoryEvidenceReport(story, registry, projectRoot);
      if (!evidence.evidence_ready) {
        errors.push(`${story.id}: FULLY_COVERED story is not evidence-ready (${summarizeEvidenceIssues(evidence.issues)})`);
      }
    }
  }

  // Consolidation checks
  if (Array.isArray(registry.consolidations)) {
    for (const c of registry.consolidations) {
      if (!c.surviving || !ids.has(c.surviving)) {
        errors.push(`Consolidation references unknown surviving story: ${c.surviving}`);
      }
      if (!Array.isArray(c.retired) || c.retired.length === 0) {
        warnings.push(`Consolidation for ${c.surviving}: missing or empty 'retired' array`);
      }
    }
  }

  const packetValidation = validateAuditPacket(registry);
  errors.push(...packetValidation.errors);
  warnings.push(...packetValidation.warnings);

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

function getFreshness(registry) {
  const result = { days: null, commits: null, stale: false };

  if (!registry || !registry.updated) return { ...result, days: Infinity, commits: Infinity, stale: true };

  const updatedDate = new Date(registry.updated);
  result.days = Math.floor((Date.now() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));

  if (registry.commit) {
    const safeHash = safeCommitHash(registry.commit);
    if (safeHash) {
      try {
        const proc = spawnSync("git", ["rev-list", `${safeHash}..HEAD`, "--count"], {
          encoding: "utf-8", cwd, timeout: 10000,
        });
        const parsed = Number.parseInt((proc.stdout || "").trim(), 10);
        result.commits = Number.isNaN(parsed) ? 999 : parsed;
      } catch {
        result.commits = 999;
      }
    } else {
      result.commits = 999;
    }
  }

  result.stale = result.days > 14 || (result.commits !== null && result.commits > 15);
  return result;
}

// ---------------------------------------------------------------------------
// Diff (which stories are affected by a file change)
// ---------------------------------------------------------------------------

function diffFiles(files, registry) {
  return diffFilesDetailed(files, registry).affected;
}

function allRegistryStories(registry) {
  return [
    ...(Array.isArray(registry?.stories) ? registry.stories : []),
    ...(Array.isArray(registry?.infrastructure_stories) ? registry.infrastructure_stories : []),
  ];
}

// ---------------------------------------------------------------------------
// Prune (safe stale evidence-ref repair)
// ---------------------------------------------------------------------------

function cleanCandidateToken(token) {
  let cleaned = String(token || "").trim();
  cleaned = cleaned.replace(/^['"`]+/, "").replace(/['"`]+$/, "");
  while (/[),.;\]]$/.test(cleaned)) {
    cleaned = cleaned.slice(0, -1);
  }
  if (cleaned.startsWith("./")) cleaned = cleaned.slice(2);
  return cleaned.split(":")[0];
}

function commandPathCandidates(ref) {
  const text = String(ref || "");
  const tokenCandidates = text.split(/\s+/);
  const pathMatches = text.match(/(?:\.\/|\.agent\/|plans\/|reports\/|docs\/|src\/|tests?\/|scripts\/|lib\/|config\/|roadmap_v7\/)[^\s"'`),;]*/g) || [];
  return [...tokenCandidates, ...pathMatches]
    .map(cleanCandidateToken)
    .filter(Boolean);
}

function isSafeRegistryRelativePath(candidate) {
  return Boolean(candidate)
    && !candidate.startsWith("/")
    && !candidate.startsWith("../")
    && !candidate.includes("/../");
}

function findExistingSuccessorRef(ref) {
  const originalPath = refPathForFilesystem(ref);
  for (const candidate of commandPathCandidates(ref)) {
    if (candidate === originalPath) continue;
    if (!isSafeRegistryRelativePath(candidate)) continue;
    if (existsSync(join(cwd, candidate))) return candidate;
  }
  return null;
}

function addUniqueRef(nextRefs, seenRefs, ref) {
  const normalized = String(ref || "").trim();
  if (!normalized) return false;
  if (seenRefs.has(normalized)) return false;
  seenRefs.add(normalized);
  nextRefs.push(normalized);
  return true;
}

function activeEvidenceIssueFieldsFor(story, fieldResults) {
  const issueFields = [];
  for (const field of EVIDENCE_FIELDS) {
    const refs = Object.prototype.hasOwnProperty.call(fieldResults, field)
      ? fieldResults[field]
      : (Array.isArray(story[field]) ? story[field] : []);
    if (refs.length === 0 || refs.some((ref) => !fileExistsForRef(ref))) {
      issueFields.push(field);
    }
  }
  return issueFields;
}

function buildPruneNote(change, prunedAt) {
  const note = {
    field: change.field,
    ref: change.ref,
    action: change.action,
    reason: change.reason,
    pruned_at: prunedAt,
  };
  if (change.successor_ref) note.successor_ref = change.successor_ref;
  return note;
}

function analyzeRegistryPrune(registry, { write = false, prunedAt = new Date().toISOString() } = {}) {
  const stories = allRegistryStories(registry);
  const changes = [];
  const storyUpdates = [];
  const summary = {
    stories_scanned: stories.length,
    stale_refs: 0,
    replacements: 0,
    removals: 0,
    duplicates: 0,
    stories_changed: 0,
    stories_downgraded: 0,
  };

  for (const story of stories) {
    const fieldResults = {};
    const storyChanges = [];

    for (const field of EVIDENCE_FIELDS) {
      if (!Array.isArray(story[field])) continue;

      const nextRefs = [];
      const seenRefs = new Set();
      let fieldChanged = false;

      for (const ref of story[field]) {
        const refString = String(ref || "").trim();
        if (!refString) {
          fieldChanged = true;
          continue;
        }

        if (fileExistsForRef(refString)) {
          if (!addUniqueRef(nextRefs, seenRefs, refString)) {
            const change = {
              story_id: story.id,
              field,
              ref: refString,
              action: "dedupe",
              reason: "Duplicate evidence ref removed during safe prune.",
            };
            storyChanges.push(change);
            changes.push(change);
            summary.duplicates += 1;
            fieldChanged = true;
          }
          continue;
        }

        const successorRef = findExistingSuccessorRef(refString);
        if (successorRef) {
          const added = addUniqueRef(nextRefs, seenRefs, successorRef);
          const change = {
            story_id: story.id,
            field,
            ref: refString,
            action: "replace",
            successor_ref: successorRef,
            reason: added
              ? "Command-shaped or stale ref contained an existing artifact path."
              : "Command-shaped or stale ref normalized to an existing duplicate artifact path.",
          };
          storyChanges.push(change);
          changes.push(change);
          summary.stale_refs += 1;
          summary.replacements += 1;
          fieldChanged = true;
          continue;
        }

        const change = {
          story_id: story.id,
          field,
          ref: refString,
          action: "remove",
          reason: "Evidence ref points to a missing file and no existing successor path was found.",
        };
        storyChanges.push(change);
        changes.push(change);
        summary.stale_refs += 1;
        summary.removals += 1;
        fieldChanged = true;
      }

      if (fieldChanged) {
        fieldResults[field] = nextRefs;
      }
    }

    let statusChange = null;
    if (story.status === "FULLY_COVERED") {
      const issueFields = activeEvidenceIssueFieldsFor(story, fieldResults);
      if (issueFields.length > 0) {
        statusChange = {
          from: "FULLY_COVERED",
          to: "PARTIALLY_COVERED",
          reason: `Safe prune left incomplete active evidence in: ${issueFields.join(", ")}`,
        };
        summary.stories_downgraded += 1;
      }
    }

    if (storyChanges.length > 0 || statusChange) {
      summary.stories_changed += 1;
      const update = {
        story_id: story.id,
        title: story.title || "",
        fields_changed: Object.keys(fieldResults),
        changes: storyChanges,
      };
      if (statusChange) update.status_change = statusChange;
      storyUpdates.push(update);

      if (write) {
        for (const [field, refs] of Object.entries(fieldResults)) {
          story[field] = refs;
        }
        if (storyChanges.length > 0) {
          story.pruned_refs = [
            ...(Array.isArray(story.pruned_refs) ? story.pruned_refs : []),
            ...storyChanges.map((change) => buildPruneNote(change, prunedAt)),
          ];
        }
        if (statusChange) {
          story.status = statusChange.to;
          story.needs_review = true;
          const note = statusChange.reason;
          story.coverage_note = story.coverage_note
            ? `${story.coverage_note} ${note}.`
            : `${note}.`;
        }
      }
    }
  }

  const status = summary.stale_refs > 0 || summary.duplicates > 0 || summary.stories_downgraded > 0
    ? (write ? "PASS" : "WARN")
    : "PASS";
  const hasChanges = summary.stale_refs > 0 || summary.duplicates > 0 || summary.stories_downgraded > 0;
  return {
    status,
    mode: write ? "write" : "dry-run",
    write,
    registry_path: "reports/user_story_audit/story_registry.json",
    summary,
    changes,
    story_updates: storyUpdates,
    message: hasChanges
      ? (write
        ? "Safe prune applied. Review story_updates and run story_registry.mjs check."
        : "Safe prune dry-run complete. Re-run with --safe --write to apply these changes.")
      : "Safe prune found no stale evidence refs.",
  };
}

function writeRegistry(registry) {
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

function refMatchesFile(file, ref) {
  const normalizedFile = String(file || "").replace(/^\.\//, "");
  const refFile = String(ref || "").split(":")[0].replace(/^\.\//, "");
  if (!normalizedFile || !refFile) return false;
  // RP-015: segment-bounded suffix matching prevents utils.ts matching plan_utils.ts.
  return refFile === normalizedFile
    || normalizedFile.endsWith("/" + refFile)
    || refFile.endsWith("/" + normalizedFile);
}

function diffFilesDetailed(files, registry) {
  const stories = allRegistryStories(registry);
  if (!registry || stories.length === 0) return { affected: [], unmatched: [] };

  const affected = [];
  const matchedFiles = new Set();
  for (const file of files) {
    const normalizedFile = file.replace(/^\.\//, "");
    for (const story of stories) {
      const refs = [
        ...(story.code_refs || []),
        ...(story.test_refs || []),
        ...(story.validation_refs || []),
        ...(story.doc_refs || []),
      ];
      const matches = refs.some(ref => refMatchesFile(normalizedFile, ref));
      if (matches && !affected.find(a => a.id === story.id)) {
        affected.push({
          id: story.id,
          title: story.title,
          status: story.status,
          matchedFile: normalizedFile,
        });
      }
      if (matches) matchedFiles.add(normalizedFile);
    }
  }
  const unmatched = files
    .map(file => String(file || "").replace(/^\.\//, ""))
    .filter(Boolean)
    .filter(file => !matchedFiles.has(file));
  return { affected, unmatched };
}

// ---------------------------------------------------------------------------
// Output Formatters
// ---------------------------------------------------------------------------

function printCheck(registry, jsonMode) {
  if (registry._parseError) {
    const result = { status: "FAIL", errors: [`JSON parse error: ${registry._parseError}`], warnings: [] };
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); } else {
      console.log("❌ FAIL — story_registry.json is not valid JSON");
      console.log(`   ${registry._parseError}`);
    }
    process.exit(1);
  }

  const { errors, warnings } = validateRegistry(registry);
  const status = errors.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";

  if (jsonMode) {
    console.log(JSON.stringify({ status, errors, warnings, storyCount: allRegistryStories(registry).length }, null, 2));
  } else {
    const statusKind = normalizeVerificationStatus(status, "execution").kind;
    const icon = statusKind === "pass" ? "✅" : statusKind === "pending" ? "⚠️" : "❌";
    console.log(`${icon} ${status} — ${allRegistryStories(registry).length} stories in registry`);
    for (const e of errors) console.log(`  ❌ ${e}`);
    for (const w of warnings) console.log(`  ⚠️  ${w}`);
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

function printFreshness(registry, jsonMode) {
  const f = getFreshness(registry);

  if (jsonMode) {
    console.log(JSON.stringify(f, null, 2));
  } else {
    const icon = f.stale ? "🔴" : "🟢";
    const dayLabel = f.days === Infinity ? "NEVER UPDATED" : `${f.days}d ago`;
    const commitLabel = f.commits === null || f.commits === Infinity ? "unknown" : `${f.commits} commits ago`;
    console.log(`${icon} Registry freshness: ${dayLabel}, ${commitLabel}`);
    if (f.stale) console.log("   ⚠️  Registry is stale — run /red-team-user-story-audit to update");
  }
}

function printDiff(files, registry, jsonMode) {
  const { affected, unmatched } = diffFilesDetailed(files, registry);
  const status = unmatched.length > 0 ? "WARN" : affected.length > 0 ? "AFFECTED" : "PASS";

  if (jsonMode) {
    console.log(JSON.stringify({
      status,
      affected,
      count: affected.length,
      unmatched,
      unmatchedCount: unmatched.length,
    }, null, 2));
  } else {
    if (affected.length === 0 && unmatched.length === 0) {
      console.log("✅ No stories affected by the changed files.");
    } else {
      if (affected.length > 0) {
        console.log(`⚠️  ${affected.length} story/stories affected by changed files:\n`);
        for (const a of affected) {
          console.log(`  ${a.id} [${a.status}] — ${a.title}`);
          console.log(`    matched via: ${a.matchedFile}`);
        }
      }
      if (unmatched.length > 0) {
        console.log(`${affected.length > 0 ? "\n" : ""}⚠️  ${unmatched.length} changed file(s) have no story mapping:`);
        for (const file of unmatched) console.log(`  ${file}`);
      }
      console.log("\n  Consider re-running /red-team-user-story-audit to update coverage.");
    }
  }
}

function printPrune(registry, args, jsonMode) {
  const safe = args.includes("--safe");
  const write = args.includes("--write");

  if (!safe) {
    const result = {
      status: "FAIL",
      message: "Refusing to prune story_registry.json without --safe.",
      required_flag: "--safe",
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error("ERROR: 'prune' requires --safe");
    }
    process.exit(1);
  }

  if (!registry) {
    const result = {
      status: "SKIP",
      write: false,
      message: "No story_registry.json found.",
      registry_path: "reports/user_story_audit/story_registry.json",
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("No story_registry.json found; nothing to prune.");
    }
    process.exit(0);
  }

  if (registry._parseError) {
    const result = { status: "FAIL", errors: [`JSON parse error: ${registry._parseError}`], write: false };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error("ERROR: story_registry.json is not valid JSON");
      console.error(`  ${registry._parseError}`);
    }
    process.exit(1);
  }

  const result = analyzeRegistryPrune(registry, { write });
  if (write && result.summary.stories_changed > 0) {
    registry.updated_at = registry.updated_at || registry.updated || new Date().toISOString();
    writeRegistry(registry);
    result.wrote = true;
  } else {
    result.wrote = false;
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} - story registry prune ${result.mode}`);
    console.log(`  stale refs: ${result.summary.stale_refs}`);
    console.log(`  replacements: ${result.summary.replacements}`);
    console.log(`  removals: ${result.summary.removals}`);
    console.log(`  duplicates: ${result.summary.duplicates}`);
    console.log(`  stories changed: ${result.summary.stories_changed}`);
    console.log(`  stories downgraded: ${result.summary.stories_downgraded}`);
    if (!write && result.summary.stories_changed > 0) {
      console.log("  Re-run with --safe --write to apply.");
    }
  }
}

function printEvidence(registry, storyId, jsonMode) {
  if (registry._parseError) {
    const result = { status: "FAIL", errors: [`JSON parse error: ${registry._parseError}`] };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("❌ FAIL — story_registry.json is not valid JSON");
      console.log(`   ${registry._parseError}`);
    }
    process.exit(1);
  }

  const stories = allRegistryStories(registry);
  const allReports = stories.map((story) => buildStoryEvidenceReport(story, registry, cwd));

  if (storyId) {
    const report = allReports.find((entry) => entry.id === storyId);
    if (!report) {
      const result = { status: "FAIL", message: `Story not found: ${storyId}` };
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`❌ Story not found: ${storyId}`);
      }
      process.exit(1);
    }

    const status = report.evidence_ready ? "PASS" : "WARN";
    if (jsonMode) {
      console.log(JSON.stringify({ status, story: report }, null, 2));
    } else {
      const icon = report.evidence_ready ? "✅" : "⚠️";
      console.log(`${icon} Evidence ${status} — ${report.id} [${report.status}] ${report.title}`);
      console.log(`  code_refs: ${report.counts.code_refs}`);
      console.log(`  test_refs: ${report.counts.test_refs}`);
      console.log(`  validation_refs: ${report.counts.validation_refs}`);
      if (report.issues.length > 0) {
        for (const issue of report.issues) console.log(`  ❌ ${issue.message}`);
      }
      console.log(`  Hint: ${report.guidance}`);
    }
    process.exit(report.evidence_ready ? 0 : 1);
  }

  const incomplete = allReports.filter((entry) => !entry.evidence_ready);
  const status = incomplete.length > 0 ? "WARN" : "PASS";
  if (jsonMode) {
    console.log(JSON.stringify({ status, incomplete_count: incomplete.length, stories: incomplete }, null, 2));
  } else if (incomplete.length === 0) {
    console.log("✅ All stories have code_refs, test_refs, and validation_refs present.");
  } else {
    console.log(`⚠️  ${incomplete.length} story/stories have incomplete close-time evidence:\n`);
    for (const report of incomplete) {
      const summary = report.issues.map((issue) => issue.message).join("; ");
      console.log(`  ${report.id} [${report.status}] — ${summary}`);
    }
    console.log(`\n  Hint: Update ${registryPath}; @planner: annotations do not replace story_registry evidence refs.`);
  }
  process.exit(incomplete.length > 0 ? 1 : 0);
}

function printSummary(registry, jsonMode) {
  if (!registry || !Array.isArray(registry.stories)) {
    const result = { exists: false, message: "No story registry found" };
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); } else { console.log("⚠️  No story registry found."); }
    return;
  }

  const total = registry.stories.length;
  const full = registry.stories.filter(s => s.status === "FULLY_COVERED").length;
  const partial = registry.stories.filter(s => s.status === "PARTIALLY_COVERED").length;
  const missing = registry.stories.filter(s => s.status === "NOT_IMPLEMENTED").length;
  const retired = registry.stories.filter(s => s.status === "RETIRED").length;
  const consolidations = registry.consolidations?.length || 0;
  const f = getFreshness(registry);

  if (jsonMode) {
    console.log(JSON.stringify({ total, full, partial, missing, retired, consolidations, freshness: f }, null, 2));
  } else {
    const active = total - retired;
    const coverage = active > 0 ? Math.round((full / active) * 100) : null;
    const coverageLabel = coverage !== null ? `${coverage}%` : "N/A (all retired)";
    const freshIcon = f.stale ? "🔴" : "🟢";
    console.log(`📊 Story Registry: ${total} stories, ${coverageLabel} covered | ${full} full, ${partial} partial, ${missing} missing, ${retired} retired | ${consolidations} consolidations | ${freshIcon} ${f.days === Infinity ? "never updated" : f.days + "d old"}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// F-026 FIX: Guard CLI dispatch so the module can be imported without side effects
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (!isMain) {
  // Module is being imported — export utility functions only, no CLI dispatch
  // Consumers can import { validateRegistry, ... } once this guard is in place
}
if (isMain) {

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const filteredArgs = args.filter(a => a !== "--json");
const command = filteredArgs[0] || "summary";

const registry = loadRegistry();

if (command === "check") {
  if (!registry) {
    if (jsonMode) {
      console.log(JSON.stringify({ status: "SKIP", message: "No story_registry.json found" }, null, 2));
    } else {
      console.log("⚠️  No story_registry.json found — run /red-team-user-story-audit to create one.");
    }
    process.exit(0);
  }
  printCheck(registry, jsonMode);

} else if (command === "evidence") {
  if (!registry) {
    if (jsonMode) {
      console.log(JSON.stringify({ status: "SKIP", message: "No story_registry.json found" }, null, 2));
    } else {
      console.log("⚠️  No story registry — cannot inspect evidence readiness.");
    }
    process.exit(0);
  }
  printEvidence(registry, filteredArgs[1] || null, jsonMode);

} else if (command === "freshness") {
  printFreshness(registry, jsonMode);

} else if (command === "diff") {
  const files = filteredArgs.slice(1);
  if (files.length === 0) {
    console.error("ERROR: 'diff' requires at least one file path argument");
    process.exit(1);
  }
  if (!registry) {
    if (jsonMode) {
      console.log(JSON.stringify({ affected: [], count: 0, message: "No registry" }, null, 2));
    } else {
      console.log("⚠️  No story registry — cannot determine affected stories.");
    }
    process.exit(0);
  }
  printDiff(files, registry, jsonMode);

} else if (command === "prune") {
  printPrune(registry, filteredArgs.slice(1), jsonMode);

} else if (command === "summary") {
  printSummary(registry, jsonMode);

} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: story_registry.mjs [check|evidence [story-id]|freshness|diff <files>|prune --safe [--write]|summary] [--json]");
  process.exit(1);
}

} // end isMain guard
