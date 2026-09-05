// release_artifact_policy.mjs — exhaustive, fail-closed release artifact census.
// @planner:story = US-065, US-091
// @planner:proves = sc_1

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";

const DEFAULT_CONFIG_RELATIVE = ".agent/skills/iterative-planner/config/release_artifact_policy.json";
const EVIDENCE_CLASSES = new Set(["durable_evidence", "transient_evidence"]);

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function validatePolicy(policy) {
  if (!policy || policy.schema_version !== 1) throw new Error("release artifact policy must use schema_version 1");
  if (!Array.isArray(policy.classes) || policy.classes.length === 0) throw new Error("release artifact policy requires classes");
  const ids = policy.classes.map((entry) => String(entry?.id || "").trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("release artifact classes require unique non-empty ids");
  if (policy.classes.filter((entry) => entry?.fallback === true).length !== 1) throw new Error("release artifact policy requires exactly one fallback class");
  return policy;
}

function loadReleaseArtifactPolicy({ repoRoot = process.cwd(), configPath = null } = {}) {
  const path = resolve(configPath || join(repoRoot, DEFAULT_CONFIG_RELATIVE));
  return validatePolicy(JSON.parse(readFileSync(path, "utf-8")));
}

function normalizeInputEntry(entry, { repoRoot, sizeResolver }) {
  const path = normalizePath(typeof entry === "string" ? entry : entry?.path);
  let bytes = Number(typeof entry === "object" ? entry?.bytes : NaN);
  if (!Number.isFinite(bytes) || bytes < 0) {
    if (typeof sizeResolver === "function") bytes = Number(sizeResolver(path));
    else {
      const absolute = resolve(repoRoot, path);
      bytes = existsSync(absolute) && statSync(absolute).isFile() ? statSync(absolute).size : 0;
    }
  }
  return { path, bytes: Math.max(0, Math.trunc(Number.isFinite(bytes) ? bytes : 0)) };
}

function activeWaiverFor(path, waivers, now) {
  const candidates = (Array.isArray(waivers) ? waivers : []).filter((waiver) => normalizePath(waiver?.path) === path);
  if (candidates.length === 0) return { waiver: null, status: null };
  const waiver = candidates[0];
  const reason = String(waiver?.reason || "").trim();
  const expiresAt = Date.parse(String(waiver?.expires_at || ""));
  if (!reason || !Number.isFinite(expiresAt)) return { waiver, status: "invalid" };
  if (expiresAt <= now.getTime()) return { waiver, status: "expired" };
  return { waiver, status: "active" };
}

function classifyReleaseArtifacts(entries, {
  policy = null,
  repoRoot = process.cwd(),
  configPath = null,
  now = new Date(),
  sizeResolver = null,
} = {}) {
  const effectivePolicy = validatePolicy(policy || loadReleaseArtifactPolicy({ repoRoot, configPath }));
  const fallback = effectivePolicy.classes.find((entry) => entry.fallback === true);
  const compiled = effectivePolicy.classes
    .filter((entry) => entry.fallback !== true && entry.id !== "explicitly_waived")
    .map((entry) => ({ ...entry, regexes: (entry.patterns || []).map(globToRegExp) }));
  const normalizedEntries = (Array.isArray(entries) ? entries : []).map((entry) => normalizeInputEntry(entry, { repoRoot, sizeResolver }));
  const violations = [];
  const classified = normalizedEntries.map((entry) => {
    if (!entry.path) {
      violations.push({ code: "release_artifact_path_missing", path: entry.path, message: "staged artifact path is empty" });
      return { ...entry, classification: null, matched_classes: [] };
    }
    const waiverMatch = activeWaiverFor(entry.path, effectivePolicy.waivers, now);
    const matches = compiled.filter((candidate) => candidate.regexes.some((regex) => regex.test(entry.path)));
    if (waiverMatch.status === "invalid") {
      violations.push({ code: "release_artifact_waiver_invalid", path: entry.path, message: `${entry.path} waiver requires a reason and valid future expires_at` });
    }
    const classification = waiverMatch.status === "active"
      ? "explicitly_waived"
      : matches[0]?.id || fallback.id;
    return {
      ...entry,
      classification,
      matched_classes: waiverMatch.status === "active" ? ["explicitly_waived"] : matches.slice(0, 1).map((match) => match.id),
      waiver_status: waiverMatch.status,
      waiver_reason: waiverMatch.status === "active" ? waiverMatch.waiver.reason : null,
      waiver_expires_at: waiverMatch.waiver?.expires_at || null,
    };
  });

  const byClass = Object.fromEntries(effectivePolicy.classes.map((entry) => [entry.id, { file_count: 0, bytes: 0, paths: [] }]));
  for (const entry of classified) {
    if (!entry.classification) continue;
    byClass[entry.classification] ||= { file_count: 0, bytes: 0, paths: [] };
    byClass[entry.classification].file_count += 1;
    byClass[entry.classification].bytes += entry.bytes;
    byClass[entry.classification].paths.push(entry.path);
  }

  const budgetTargets = { ...byClass };
  budgetTargets.total_evidence = classified
    .filter((entry) => EVIDENCE_CLASSES.has(entry.classification))
    .reduce((summary, entry) => ({ file_count: summary.file_count + 1, bytes: summary.bytes + entry.bytes }), { file_count: 0, bytes: 0 });
  for (const [id, budget] of Object.entries(effectivePolicy.budgets || {})) {
    const actual = budgetTargets[id] || { file_count: 0, bytes: 0 };
    for (const [metric, key] of [["max_files", "file_count"], ["max_bytes", "bytes"]]) {
      const limit = Number(budget?.[metric]);
      if (Number.isFinite(limit) && actual[key] > limit) {
        violations.push({
          code: "release_artifact_budget_exceeded",
          classification: id,
          metric,
          actual: actual[key],
          limit,
          message: `${id} ${key} ${actual[key]} exceeds ${limit}`,
        });
      }
    }
  }

  const auditPath = normalizePath(effectivePolicy.audit_log?.path);
  const stagedAuditLog = auditPath ? classified.find((entry) => entry.path === auditPath) : null;
  const auditMaxBytes = Number(effectivePolicy.audit_log?.max_live_bytes);
  if (stagedAuditLog && Number.isFinite(auditMaxBytes) && auditMaxBytes > 0 && stagedAuditLog.bytes > auditMaxBytes) {
    violations.push({
      code: "release_audit_log_compaction_required",
      path: auditPath,
      actual: stagedAuditLog.bytes,
      limit: auditMaxBytes,
      message: `${auditPath} is ${stagedAuditLog.bytes} bytes and requires reviewed digest-preserving compaction before the ${auditMaxBytes}-byte live limit`,
    });
  }

  return {
    schema_version: 1,
    ok: violations.length === 0,
    generated_at: now.toISOString(),
    entries: classified,
    by_class: byClass,
    evidence_totals: budgetTargets.total_evidence,
    budgets: effectivePolicy.budgets || {},
    violations,
    remediation: violations.length === 0
      ? []
      : ["Remove transient run output from the candidate, compact oversized audit history explicitly, or add a reasoned future-expiring waiver."],
  };
}

function planAuditLogCompaction(auditLog, { policy = null, repoRoot = process.cwd(), configPath = null, now = new Date() } = {}) {
  const effectivePolicy = validatePolicy(policy || loadReleaseArtifactPolicy({ repoRoot, configPath }));
  const auditPolicy = effectivePolicy.audit_log || {};
  const path = normalizePath(auditLog?.path || auditPolicy.path || "plans/audit_log.json");
  const bytes = Math.max(0, Number(auditLog?.bytes) || 0);
  const maxLiveBytes = Math.max(0, Number(auditPolicy.max_live_bytes) || 0);
  const sourceDigest = String(auditLog?.digest || "").trim() || null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const digestToken = (sourceDigest || "digest-pending").slice(0, 16);
  const archiveDir = normalizePath(auditPolicy.archive_dir || "plans/audit_archive");
  return {
    schema_version: 1,
    required: maxLiveBytes > 0 && bytes > maxLiveBytes,
    path,
    bytes,
    max_live_bytes: maxLiveBytes,
    archive_path: `${archiveDir}/${basename(path).replace(/\.json$/i, "")}.${stamp}.${digestToken}.json.gz`,
    digest_algorithm: auditPolicy.digest_algorithm || "sha256",
    source_digest: sourceDigest,
    preserve_digest: true,
    automatic_deletion: false,
    next_action: maxLiveBytes > 0 && bytes > maxLiveBytes
      ? "Run explicit archive/compaction with a reviewed integrity receipt before staging the release."
      : "No compaction required.",
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  renameSync(temp, path);
}

function writeArtifactCensusReceipt(census, { repoRoot = process.cwd(), path = null } = {}) {
  const target = resolve(path || join(repoRoot, ".git", "iterative-planner", "release-artifact-census.json"));
  const payload = { ...census };
  payload.receipt_digest = sha256(JSON.stringify(payload));
  writeJsonAtomic(target, payload);
  return { path: normalizePath(relative(repoRoot, target)), receipt_digest: payload.receipt_digest };
}

export {
  classifyReleaseArtifacts,
  globToRegExp,
  loadReleaseArtifactPolicy,
  planAuditLogCompaction,
  validatePolicy as validateReleaseArtifactPolicy,
  writeArtifactCensusReceipt,
};
