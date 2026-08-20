// owned_file_replace.mjs — ownership-aware, no-overwrite local file replacement.
//
// Canonical publication uses link(2), whose destination creation is exclusive.
// Replacements first preserve the observed inode behind a unique displaced path,
// then vacate the canonical name and publish exclusively. Callers must still use
// their domain lock: this primitive protects cooperating planner writers and the
// deterministic race boundaries below; it does not claim transactional semantics
// against a hostile process scheduled between every individual filesystem call.

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function immutableToken(path, stat, bytes) {
  return Object.freeze({
    path: resolve(path),
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    digest: digest(bytes),
  });
}

function sameToken(left, right) {
  return Boolean(
    left
      && right
      && left.path === right.path
      && left.dev === right.dev
      && left.ino === right.ino
      && left.size === right.size
      && left.digest === right.digest,
  );
}

function result(fields) {
  return Object.freeze({
    status: fields.status,
    reason: fields.reason || null,
    phase: fields.phase || "none",
    path: fields.path ? resolve(fields.path) : null,
    expected: fields.expected || null,
    prepared: fields.prepared || null,
    published: fields.published || null,
    displaced: fields.displaced || null,
    operation_id: fields.operationId || null,
    error: fields.error || null,
  });
}

function ownedSibling(path, operationId, role) {
  return resolve(dirname(path), `.${basename(path)}.owned-${operationId}.${role}`);
}

function writePrepared(path, bytes, mode) {
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const observation = observeOwnedFile(path);
  if (observation.status !== "present") {
    throw new Error(`prepared file could not be observed: ${observation.reason}`);
  }
  return observation.token;
}

function cleanResidue(token) {
  if (!token) return { status: "committed", reason: "no_residue" };
  return cleanupOwnedFile(token);
}

function invokeHook(hooks, name, context) {
  if (typeof hooks?.[name] === "function") hooks[name](Object.freeze({ ...context }));
}

/** Observe a bounded regular file and return an immutable identity + digest token. */
export function observeOwnedFile(path, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const canonicalPath = resolve(path);
  try {
    const before = lstatSync(canonicalPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      return { status: "unsafe", token: null, reason: "not_regular_file" };
    }
    if (before.size > maxBytes) {
      return { status: "unsafe", token: null, reason: "size_limit" };
    }
    const bytes = readFileSync(canonicalPath);
    const after = lstatSync(canonicalPath);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
    ) {
      return { status: "conflict", token: null, reason: "changed_during_read" };
    }
    return { status: "present", token: immutableToken(canonicalPath, after, bytes), bytes };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", token: null, reason: "absent" };
    return { status: "error", token: null, reason: error?.code || error?.message || "read_failed" };
  }
}

/** True only while token.path is the exact regular-file identity and digest observed. */
export function tokenOwnsPath(token) {
  if (!token?.path) return false;
  const current = observeOwnedFile(token.path);
  return current.status === "present" && sameToken(token, current.token);
}

/** Remove only the exact path identity represented by token. */
export function cleanupOwnedFile(token) {
  if (!token?.path) return { status: "conflict", reason: "invalid_token" };
  const observation = observeOwnedFile(token.path);
  if (observation.status === "absent") return { status: "committed", reason: "already_absent" };
  if (observation.status !== "present" || !sameToken(token, observation.token)) {
    return { status: "conflict", reason: "ownership_lost" };
  }
  try {
    unlinkSync(token.path);
    return { status: "committed", reason: "owned_path_removed" };
  } catch (error) {
    return { status: "cleanup_pending", reason: error?.code || error?.message || "unlink_failed" };
  }
}

/**
 * Replace path using expected read provenance. `expected: null` means the caller
 * observed absence. A successful publication never replaces an occupied name.
 */
export function replaceOwnedFile({
  path,
  bytes,
  expected,
  mode = 0o600,
  hooks = {},
} = {}) {
  if (!path) throw new TypeError("replaceOwnedFile requires path");
  if (expected === undefined) throw new TypeError("replaceOwnedFile requires expected provenance (token or null)");

  const canonicalPath = resolve(path);
  const operationId = `${process.pid}-${randomUUID()}`;
  const preparedPath = ownedSibling(canonicalPath, operationId, "prepared");
  const displacedPath = ownedSibling(canonicalPath, operationId, "displaced");
  let prepared = null;
  let published = null;
  let displaced = null;
  let phase = "none";

  const snapshot = (status, reason, error = null) => result({
    status,
    reason,
    phase,
    path: canonicalPath,
    expected,
    prepared,
    published,
    displaced,
    operationId,
    error: error ? String(error.message || error) : null,
  });

  try {
    prepared = writePrepared(preparedPath, bytes, mode);
    phase = "prepared";
    invokeHook(hooks, "afterPrepare", { path: canonicalPath, prepared, expected });

    const current = observeOwnedFile(canonicalPath);
    if (expected === null) {
      if (current.status !== "absent") {
        cleanResidue(prepared);
        return snapshot("conflict", "expected_absence_violated");
      }
    } else if (current.status !== "present" || !sameToken(expected, current.token)) {
      cleanResidue(prepared);
      return snapshot("conflict", "expected_owner_changed");
    }

    if (expected !== null) {
      invokeHook(hooks, "beforeDisplace", { path: canonicalPath, prepared, expected });
      const beforeDisplace = observeOwnedFile(canonicalPath);
      if (beforeDisplace.status !== "present" || !sameToken(expected, beforeDisplace.token)) {
        cleanResidue(prepared);
        return snapshot("conflict", "owner_changed_before_displace");
      }

      linkSync(canonicalPath, displacedPath);
      displaced = observeOwnedFile(displacedPath).token;
      if (!displaced || displaced.dev !== expected.dev || displaced.ino !== expected.ino || displaced.digest !== expected.digest) {
        cleanResidue(displaced);
        cleanResidue(prepared);
        return snapshot("conflict", "displaced_owner_mismatch");
      }

      const beforeVacate = observeOwnedFile(canonicalPath);
      if (beforeVacate.status !== "present" || !sameToken(expected, beforeVacate.token)) {
        cleanResidue(displaced);
        cleanResidue(prepared);
        return snapshot("conflict", "owner_changed_before_vacate");
      }
      unlinkSync(canonicalPath);
      phase = "displaced";
    }

    invokeHook(hooks, "beforePublish", { path: canonicalPath, prepared, displaced, expected });
    try {
      invokeHook(hooks, "beforePublishLink", { path: canonicalPath, prepared, displaced, expected });
      linkSync(prepared.path, canonicalPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        cleanResidue(displaced);
        cleanResidue(prepared);
        return snapshot("conflict", "destination_occupied");
      }
      throw error;
    }

    published = observeOwnedFile(canonicalPath).token;
    phase = "published";
    if (!published || published.dev !== prepared.dev || published.ino !== prepared.ino || published.digest !== prepared.digest) {
      return snapshot("cleanup_pending", "published_owner_unverifiable");
    }

    invokeHook(hooks, "afterPublish", { path: canonicalPath, prepared, published, displaced, expected });
    const stillPublished = tokenOwnsPath(published);
    const preparedCleanup = cleanResidue(prepared);
    if (!stillPublished || preparedCleanup.status !== "committed") {
      return snapshot("cleanup_pending", stillPublished ? "prepared_cleanup_pending" : "published_owner_lost");
    }
    return snapshot("committed", "published_exclusively");
  } catch (error) {
    return snapshot("cleanup_pending", "operation_interrupted", error);
  }
}

export function ownedFileCommitSucceeded(replacement) {
  return replacement?.status === "committed";
}

export function requireOwnedFileCommit(replacement, label = "owned file write") {
  if (!ownedFileCommitSucceeded(replacement)) {
    const error = new Error(`${label}: ${replacement?.status || "missing"}/${replacement?.reason || "unknown"}`);
    error.code = "OWNED_FILE_WRITE_NOT_COMMITTED";
    error.replacement = replacement || null;
    throw error;
  }
  return replacement;
}

/** Remove owned residues after the caller no longer needs rollback. */
export function finalizeOwnedFileReplace(replacement) {
  if (!replacement || typeof replacement !== "object") {
    return { status: "conflict", reason: "invalid_replacement" };
  }
  const preparedCleanup = cleanResidue(replacement.prepared);
  const displacedCleanup = cleanResidue(replacement.displaced);
  const cleanupComplete = preparedCleanup.status === "committed" && displacedCleanup.status === "committed";
  if (!cleanupComplete) return { status: "cleanup_pending", reason: "owned_residue_not_removed" };

  if (replacement.phase === "published") {
    if (!tokenOwnsPath(replacement.published)) {
      return { status: "cleanup_pending", reason: "published_owner_lost" };
    }
    return { status: "committed", reason: "published_and_finalized" };
  }
  return { status: "conflict", reason: "publication_not_committed" };
}

/** Restore displaced bytes only while canonical is still the returned publication. */
export function rollbackOwnedFileReplace(replacement, { hooks = {} } = {}) {
  if (!replacement?.published || !replacement?.displaced) {
    return { status: "conflict", reason: "rollback_tokens_missing" };
  }
  if (!tokenOwnsPath(replacement.published) || !tokenOwnsPath(replacement.displaced)) {
    return { status: "conflict", reason: "rollback_ownership_lost" };
  }

  try {
    unlinkSync(replacement.path);
    invokeHook(hooks, "beforeRollbackPublish", {
      path: replacement.path,
      published: replacement.published,
      displaced: replacement.displaced,
    });
    linkSync(replacement.displaced.path, replacement.path);
    const restored = observeOwnedFile(replacement.path);
    if (
      restored.status !== "present"
      || restored.token.dev !== replacement.displaced.dev
      || restored.token.ino !== replacement.displaced.ino
      || restored.token.digest !== replacement.displaced.digest
    ) {
      return { status: "cleanup_pending", reason: "rollback_owner_unverifiable" };
    }
    const cleanup = cleanupOwnedFile(replacement.displaced);
    if (cleanup.status !== "committed") return { status: "cleanup_pending", reason: "rollback_cleanup_pending" };
    return { status: "committed", reason: "prior_owner_restored", published: restored.token };
  } catch (error) {
    return {
      status: error?.code === "EEXIST" ? "conflict" : "cleanup_pending",
      reason: error?.code || error?.message || "rollback_failed",
    };
  }
}

/** Recover the two durable phases represented by a structured replacement result. */
export function recoverOwnedFileReplace(replacement) {
  if (!replacement || typeof replacement !== "object") {
    return { status: "conflict", reason: "invalid_replacement" };
  }
  if (replacement.phase === "published" && tokenOwnsPath(replacement.published)) {
    return finalizeOwnedFileReplace(replacement);
  }
  if (replacement.phase === "displaced") {
    if (!replacement.displaced || !tokenOwnsPath(replacement.displaced)) {
      return { status: "cleanup_pending", reason: "displaced_owner_lost" };
    }
    const canonical = observeOwnedFile(replacement.path);
    if (canonical.status !== "absent") {
      return { status: "cleanup_pending", reason: "canonical_occupied_during_recovery" };
    }
    try {
      linkSync(replacement.displaced.path, replacement.path);
    } catch (error) {
      return {
        status: "cleanup_pending",
        reason: error?.code === "EEXIST" ? "canonical_occupied_during_recovery" : (error?.code || error?.message || "restore_failed"),
      };
    }
    const restored = observeOwnedFile(replacement.path);
    if (
      restored.status !== "present"
      || restored.token.dev !== replacement.displaced.dev
      || restored.token.ino !== replacement.displaced.ino
      || restored.token.size !== replacement.displaced.size
      || restored.token.digest !== replacement.displaced.digest
    ) {
      return { status: "cleanup_pending", reason: "restored_owner_unverifiable" };
    }
    const displacedCleanup = cleanResidue(replacement.displaced);
    const preparedCleanup = cleanResidue(replacement.prepared);
    if (displacedCleanup.status !== "committed" || preparedCleanup.status !== "committed") {
      return { status: "cleanup_pending", reason: "restored_cleanup_pending", published: restored.token };
    }
    return { status: "committed", reason: "prior_owner_restored", published: restored.token };
  }
  const finalized = finalizeOwnedFileReplace(replacement);
  if (replacement.phase === "prepared" && finalized.status !== "cleanup_pending") {
    return { status: "conflict", reason: "prepared_write_aborted" };
  }
  return finalized.status === "committed"
    ? { status: "conflict", reason: "publication_not_authoritative" }
    : finalized;
}
