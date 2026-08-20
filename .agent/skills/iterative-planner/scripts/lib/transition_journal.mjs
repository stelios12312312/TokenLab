// transition_journal.mjs — durable recovery marker for planner state publication.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanupOwnedFile,
  finalizeOwnedFileReplace,
  observeOwnedFile,
  replaceOwnedFile,
  tokenOwnsPath,
} from "./owned_file_replace.mjs";

export const TRANSITION_JOURNAL_SCHEMA_VERSION = 1;

export function transitionJournalPath(planDir) {
  return join(planDir, "artifacts", "transition_journal.json");
}

export function readTransitionJournal(planDir) {
  const path = transitionJournalPath(planDir);
  const observed = observeOwnedFile(path, { maxBytes: 1024 * 1024 });
  if (observed.status === "absent") return { status: "absent", path, token: null, journal: null };
  if (observed.status !== "present") {
    return { status: "invalid", path, token: observed.token || null, journal: null, reason: observed.reason };
  }
  try {
    const journal = JSON.parse(observed.bytes.toString("utf8"));
    if (
      journal?.schema_version !== TRANSITION_JOURNAL_SCHEMA_VERSION
      || typeof journal?.gate !== "string"
      || !["prepared", "state_published", "committed"].includes(journal?.phase)
    ) {
      return { status: "invalid", path, token: observed.token, journal, reason: "journal_schema_invalid" };
    }
    return { status: "valid", path, token: observed.token, journal };
  } catch (error) {
    return { status: "invalid", path, token: observed.token, journal: null, reason: error.message };
  }
}

export function writeTransitionJournal(planDir, journal, { expected } = {}) {
  const path = transitionJournalPath(planDir);
  mkdirSync(dirname(path), { recursive: true });
  const current = readTransitionJournal(planDir);
  const expectedToken = expected === undefined
    ? (current.status === "valid" ? current.token : null)
    : expected;
  const payload = {
    schema_version: TRANSITION_JOURNAL_SCHEMA_VERSION,
    ...journal,
    updated_at: new Date().toISOString(),
  };
  const replacement = replaceOwnedFile({
    path,
    bytes: `${JSON.stringify(payload, null, 2)}\n`,
    expected: expectedToken || null,
  });
  if (replacement.status !== "committed") {
    return { status: replacement.status, reason: replacement.reason, path, token: null, journal: payload, replacement };
  }
  const finalization = finalizeOwnedFileReplace(replacement);
  if (finalization.status !== "committed") {
    return { status: "cleanup_pending", reason: finalization.reason, path, token: replacement.published, journal: payload, replacement };
  }
  return { status: "committed", reason: null, path, token: replacement.published, journal: payload, replacement };
}

export function removeTransitionJournal(journalRead) {
  if (!journalRead?.token) return { status: "conflict", reason: "journal_token_missing" };
  return cleanupOwnedFile(journalRead.token);
}

/**
 * Prepared journals may be removed only while state still matches state_before.
 * A state-published/committed journal never manufactures authority: it remains a
 * recovery_required blocker until the transition caller reconciles side artifacts.
 */
export function recoverTransitionJournal(planDir) {
  const current = readTransitionJournal(planDir);
  if (current.status === "absent") return { status: "no_transaction", action: "none" };
  if (current.status !== "valid") {
    return { status: "recovery_required", action: "preserve", reason: current.reason || "invalid_journal" };
  }
  const { journal } = current;
  if (journal.phase === "prepared" && tokenOwnsPath(journal.state_before)) {
    const cleanup = removeTransitionJournal(current);
    return cleanup.status === "committed"
      ? { status: "aborted_clean", action: "removed_prepared_journal" }
      : { status: "recovery_required", action: "preserve", reason: cleanup.reason };
  }
  if (journal.state_after && tokenOwnsPath(journal.state_after)) {
    return {
      status: "recovery_required",
      action: "reconcile_published_state",
      gate: journal.gate,
      phase: journal.phase,
    };
  }
  return {
    status: "recovery_required",
    action: "preserve",
    gate: journal.gate,
    phase: journal.phase,
    reason: "canonical_state_matches_neither_journal_owner",
  };
}
