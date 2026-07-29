// environment_preflight.mjs - disk-derived environment truth for result evidence.

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "fs";
import { createHash } from "crypto";
import { isAbsolute, relative, resolve, sep } from "path";

import { buildEvidenceValidityVerdict } from "./evidence_validity.mjs";

const RECEIPT_SCHEMA_VERSION = 1;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function addBlocker(blockers, code, id = null) {
  blockers.push(id ? `${code}:${id}` : code);
}

function insideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sha256File(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function notRequiredReceipt(evaluatedAt) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    required: false,
    performed: false,
    status: "not_required",
    evidence_validity: null,
    evaluated_at: evaluatedAt,
    expected_worktree_root: null,
    observed_worktree_root: null,
    probe_count: 0,
    claim_support_allowed: false,
    numeric_output_reportable: false,
    blocking_issues: [],
    blockers: [],
    warnings: [],
    checks: [],
    sources: [],
  };
}

/**
 * Evaluate declared result sources from the filesystem. Caller-supplied file
 * observations are deliberately unsupported: identity, size, mtime, and hash
 * are all computed here from the active project root.
 */
export function evaluateEnvironmentPreflight({
  required = false,
  claimed_sources: claimedSources = [],
  project_root: projectRoot = null,
  evaluated_at: evaluatedAtInput = null,
} = {}) {
  const requestedEvaluationDate = evaluatedAtInput ? new Date(evaluatedAtInput) : new Date();
  const evaluatedDate = Number.isFinite(requestedEvaluationDate.getTime())
    ? requestedEvaluationDate
    : new Date();
  const evaluatedAt = evaluatedDate.toISOString();

  // Proportionality contract: no source enumeration, path resolution, or fs
  // observation is allowed for work that does not bear a result claim.
  if (!required) return notRequiredReceipt(evaluatedAt);

  const blockers = [];
  const warnings = [];
  const checks = [];
  const sources = [];
  let probeCount = 0;
  let observedWorktreeRoot = null;

  const declaredProjectRoot = nonEmptyString(projectRoot);
  if (!declaredProjectRoot) {
    addBlocker(blockers, "active_worktree_root_missing");
  } else {
    try {
      observedWorktreeRoot = realpathSync(resolve(declaredProjectRoot));
      checks.push({ id: "active_worktree_root", pass: true, observed: observedWorktreeRoot });
    } catch (error) {
      addBlocker(blockers, "active_worktree_root_invalid");
      checks.push({
        id: "active_worktree_root",
        pass: false,
        observed: resolve(declaredProjectRoot),
        error: String(error?.code || error?.message || error),
      });
    }
  }

  if (!Array.isArray(claimedSources) || claimedSources.length === 0) {
    addBlocker(blockers, "claimed_data_sources_missing");
  } else {
    const seenIds = new Set();
    for (let index = 0; index < claimedSources.length; index++) {
      const raw = asObject(claimedSources[index]);
      const id = nonEmptyString(raw.id) || `source_${index + 1}`;
      const receipt = {
        id,
        declared_path: nonEmptyString(raw.path),
        declared_expected_worktree_root: nonEmptyString(raw.expected_worktree_root),
        canonical_path: null,
        canonical_expected_worktree_root: null,
        exists: false,
        regular_file: false,
        bytes: null,
        mtime: null,
        age_seconds: null,
        max_age_seconds: null,
        sha256: null,
        blockers: [],
      };
      sources.push(receipt);

      if (!nonEmptyString(raw.id)) addBlocker(receipt.blockers, "claimed_data_source_id_missing", id);
      if (seenIds.has(id)) addBlocker(receipt.blockers, "claimed_data_source_id_duplicate", id);
      seenIds.add(id);

      if (!receipt.declared_path) addBlocker(receipt.blockers, "claimed_data_source_path_missing", id);
      if (!receipt.declared_expected_worktree_root) {
        addBlocker(receipt.blockers, "claimed_data_source_expected_worktree_missing", id);
      }

      const freshness = asObject(raw.freshness);
      const maxAgeSeconds = Number(freshness.max_age_seconds);
      if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
        addBlocker(receipt.blockers, "claimed_data_source_freshness_invalid", id);
      } else {
        receipt.max_age_seconds = maxAgeSeconds;
      }

      let expectedRoot = null;
      if (receipt.declared_expected_worktree_root && observedWorktreeRoot) {
        const declaredExpected = isAbsolute(receipt.declared_expected_worktree_root)
          ? receipt.declared_expected_worktree_root
          : resolve(observedWorktreeRoot, receipt.declared_expected_worktree_root);
        try {
          expectedRoot = realpathSync(declaredExpected);
          receipt.canonical_expected_worktree_root = expectedRoot;
          if (expectedRoot !== observedWorktreeRoot) {
            addBlocker(receipt.blockers, "claimed_data_source_expected_worktree_mismatch", id);
          }
        } catch {
          addBlocker(receipt.blockers, "claimed_data_source_expected_worktree_invalid", id);
        }
      }

      if (receipt.declared_path && expectedRoot) {
        const declaredPath = isAbsolute(receipt.declared_path)
          ? receipt.declared_path
          : resolve(expectedRoot, receipt.declared_path);
        probeCount++;
        if (!existsSync(declaredPath)) {
          addBlocker(receipt.blockers, "claimed_data_source_missing", id);
        } else {
          receipt.exists = true;
          try {
            const canonicalPath = realpathSync(declaredPath);
            receipt.canonical_path = canonicalPath;
            if (observedWorktreeRoot && !insideRoot(observedWorktreeRoot, canonicalPath)) {
              addBlocker(receipt.blockers, "claimed_data_source_outside_active_worktree", id);
            }
            if (!insideRoot(expectedRoot, canonicalPath)) {
              addBlocker(receipt.blockers, "claimed_data_source_outside_expected_worktree", id);
            }

            const stat = statSync(canonicalPath);
            receipt.regular_file = stat.isFile();
            receipt.bytes = stat.size;
            receipt.mtime = stat.mtime.toISOString();
            receipt.age_seconds = (evaluatedDate.getTime() - stat.mtimeMs) / 1000;
            if (!stat.isFile()) addBlocker(receipt.blockers, "claimed_data_source_not_regular_file", id);
            if (stat.isFile() && stat.size === 0) addBlocker(receipt.blockers, "claimed_data_source_empty", id);
            if (receipt.age_seconds < 0) addBlocker(receipt.blockers, "claimed_data_source_mtime_future", id);
            if (receipt.max_age_seconds !== null && receipt.age_seconds > receipt.max_age_seconds) {
              addBlocker(receipt.blockers, "claimed_data_source_stale", id);
            }
            if (stat.isFile() && stat.size > 0) receipt.sha256 = sha256File(canonicalPath);
          } catch (error) {
            addBlocker(receipt.blockers, "claimed_data_source_observation_failed", id);
            receipt.observation_error = String(error?.code || error?.message || error);
          }
        }
      }

      blockers.push(...receipt.blockers);
      checks.push({
        id: `claimed_data_source:${id}`,
        pass: receipt.blockers.length === 0,
        blockers: [...receipt.blockers],
      });
    }
  }

  const dedupedBlockers = [...new Set(blockers)];
  const verdict = buildEvidenceValidityVerdict({
    state: dedupedBlockers.length === 0 ? "valid" : "environment_invalid",
    blockers: dedupedBlockers,
    warnings,
    checks,
  });

  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    required: true,
    performed: true,
    status: verdict.state,
    evidence_validity: verdict.state,
    evaluated_at: evaluatedAt,
    expected_worktree_root: observedWorktreeRoot,
    observed_worktree_root: observedWorktreeRoot,
    probe_count: probeCount,
    claim_support_allowed: verdict.claim_support_allowed,
    numeric_output_reportable: verdict.claim_support_allowed,
    blocking_issues: verdict.blockers,
    blockers: verdict.blockers,
    warnings: verdict.warnings,
    checks: verdict.checks,
    sources,
  };
}
