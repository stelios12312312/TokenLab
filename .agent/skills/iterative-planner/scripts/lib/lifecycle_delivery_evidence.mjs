// @planner:module = lifecycle_delivery_evidence
// @planner:capability = deterministic_lifecycle_delivery_evidence
// @planner:story = US-079

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";

const CLOSED_STATES = new Set(["close", "closed"]);
export const LIFECYCLE_GIT_CANDIDATE_LIMIT = 50;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function uniquePaths(values) {
  return [...new Set(asArray(values).map(normalizeRepoPath).filter(Boolean))].sort();
}

function isSafeRepoPath(value) {
  const path = normalizeRepoPath(value);
  return !!path && !isAbsolute(path) && !path.split("/").includes("..");
}

function isGovernancePath(value) {
  const path = normalizeRepoPath(value);
  return path === "plans" || path.startsWith("plans/") || path === "reports" || path.startsWith("reports/");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textReferencesTicketId(text, ticketId) {
  const id = asString(ticketId);
  if (!id) return false;
  return new RegExp(`(^|[^A-Za-z0-9-])${escapeRegex(id)}([^A-Za-z0-9-]|$)`).test(String(text || ""));
}

export function planGoalReferencesTicket(goal, ticketId) {
  return textReferencesTicketId(asString(goal), ticketId);
}

function canonicalMaybeMissing(absPath) {
  const parts = [];
  let current = absPath;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absPath;
    parts.unshift(basename(current));
    current = parent;
  }
  try {
    const real = realpathSync(current);
    return parts.length > 0 ? join(real, ...parts) : real;
  } catch {
    return absPath;
  }
}

export function canonicalLifecyclePlanDir(cwd, value) {
  const raw = asString(value);
  if (!raw) return "";
  const normalizedRaw = normalizeRepoPath(raw);
  const supportedRaw = !isAbsolute(raw) && /^plan_[^/]+$/.test(normalizedRaw)
    ? `plans/${normalizedRaw}`
    : raw;
  const root = resolve(cwd);
  const candidate = isAbsolute(supportedRaw) ? resolve(supportedRaw) : resolve(root, supportedRaw);
  const canonicalRoot = canonicalMaybeMissing(root);
  const canonicalCandidate = canonicalMaybeMissing(candidate);
  const fromRoot = relative(canonicalRoot, canonicalCandidate);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) return "";
  const normalized = normalizeRepoPath(fromRoot);
  const topLevelPlan = /^plans\/plan_[^/]+$/.test(normalized);
  const programChildPlan = /^plans\/programs\/[^/]+\/child_plans\/[^/]+$/.test(normalized);
  return topLevelPlan || programChildPlan ? normalized : "";
}

function defaultGitRunner(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: options.timeout || 10000,
  });
}

function runGit(gitRunner, cwd, args, options = {}) {
  try {
    return gitRunner(cwd, args, options);
  } catch (error) {
    return { status: 1, stdout: "", stderr: error?.message || String(error), error };
  }
}

function lines(value) {
  return String(value || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function repoRelative(cwd, value) {
  const raw = asString(value);
  if (!raw) return "";
  if (!isAbsolute(raw)) return isSafeRepoPath(raw) ? normalizeRepoPath(raw) : "";
  const candidate = normalizeRepoPath(relative(resolve(cwd), resolve(raw)));
  return isSafeRepoPath(candidate) ? candidate : "";
}

function samePaths(left, right) {
  const a = uniquePaths(left);
  const b = uniquePaths(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function abnormalGitFailure(result, code) {
  if (!result || result.status === 0) return [];
  const stderr = String(result.stderr || "");
  const ordinaryMissingObject = /does not exist in|exists on disk, but not in|path .* does not exist|invalid object name|unknown revision/i.test(stderr);
  return result.error || result.signal || result.status === null || !ordinaryMissingObject ? [code] : [];
}

export function deliveryFilesFromScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return [];
  return uniquePaths([
    ...asArray(scope.declared_files),
    ...asArray(scope.owned_files),
  ]).filter((path) => isSafeRepoPath(path) && !isGovernancePath(path));
}

export function readPlanDeliveryScope({
  cwd = process.cwd(),
  planDir,
  source = "worktree",
  commit = null,
  gitRunner = defaultGitRunner,
} = {}) {
  const root = resolve(cwd);
  const planPath = repoRelative(root, planDir);
  if (!planPath) {
    return { ok: false, plan_dir: null, scope_path: null, delivery_files: [], reason: "unsafe_plan_path", diagnostics: [] };
  }
  const scopePath = `${planPath}/scope.json`;
  let raw = null;
  let unavailableReason = "scope_unreadable";
  let diagnostics = [];
  if (source === "index") {
    const result = runGit(gitRunner, root, ["show", `:${scopePath}`], { timeout: 5000 });
    if (result.status === 0) raw = String(result.stdout || "");
    else {
      unavailableReason = "scope_not_indexed";
      diagnostics = abnormalGitFailure(result, "git_indexed_scope_read_failed");
    }
  } else if (source === "commit") {
    const hash = asString(commit);
    if (!hash) {
      unavailableReason = "commit_required_for_scope";
    } else {
      const result = runGit(gitRunner, root, ["show", `${hash}:${scopePath}`], { timeout: 5000 });
      if (result.status === 0) raw = String(result.stdout || "");
      else {
        unavailableReason = "committed_scope_unavailable";
        diagnostics = abnormalGitFailure(result, "git_committed_scope_read_failed");
      }
    }
  } else {
    const absolute = join(root, scopePath);
    if (!existsSync(absolute)) {
      unavailableReason = "scope_missing";
    } else {
      try {
        raw = readFileSync(absolute, "utf-8");
      } catch {
        unavailableReason = "scope_read_failed";
        diagnostics = ["worktree_scope_read_failed"];
      }
    }
  }
  if (raw === null) {
    return { ok: false, plan_dir: planPath, scope_path: scopePath, delivery_files: [], reason: unavailableReason, diagnostics };
  }
  const scope = safeJson(raw);
  if (!scope) {
    return {
      ok: false,
      plan_dir: planPath,
      scope_path: scopePath,
      delivery_files: [],
      reason: "scope_json_invalid",
      diagnostics: [...diagnostics, `${source}_scope_json_invalid`],
    };
  }
  const deliveryFiles = deliveryFilesFromScope(scope);
  return {
    ok: deliveryFiles.length > 0,
    plan_dir: planPath,
    scope_path: scopePath,
    delivery_files: deliveryFiles,
    reason: deliveryFiles.length > 0 ? null : "delivery_scope_empty",
    diagnostics,
  };
}

export function classifyLifecycleCommitEvidence({
  ticketId,
  commit = null,
  commitMessage = "",
  commitFiles = [],
  deliveryFiles = [],
  reachable = false,
} = {}) {
  const changed = uniquePaths(commitFiles).filter(isSafeRepoPath);
  const delivery = uniquePaths(deliveryFiles).filter((path) => isSafeRepoPath(path) && !isGovernancePath(path));
  const exactTicketId = textReferencesTicketId(commitMessage, ticketId);
  const missingDeliveryFiles = delivery.filter((path) => !changed.includes(path));
  const fullDeliveryScope = delivery.length > 0 && missingDeliveryFiles.length === 0;
  let reason = "no_trusted_linkage";
  let trusted = false;
  if (!reachable) {
    reason = "commit_not_head_reachable";
  } else if (exactTicketId) {
    trusted = true;
    reason = "exact_ticket_id";
  } else if (fullDeliveryScope) {
    trusted = true;
    reason = "full_delivery_scope";
  }
  return {
    trusted,
    reason,
    commit: asString(commit) || null,
    reachable: reachable === true,
    exact_ticket_id: exactTicketId,
    full_delivery_scope: fullDeliveryScope,
    delivery_files: delivery,
    changed_files: changed,
    missing_delivery_files: missingDeliveryFiles,
    diagnostics: [],
  };
}

export function verifyLifecycleCommitEvidence({
  cwd = process.cwd(),
  ticketId,
  commit,
  deliveryFiles = [],
  planDir = null,
  knownHeadReachable = false,
  gitRunner = defaultGitRunner,
} = {}) {
  const root = resolve(cwd);
  const rawCommit = asString(commit);
  if (!rawCommit) return classifyLifecycleCommitEvidence({ ticketId, commit: null, deliveryFiles, reachable: false });
  let hash = rawCommit;
  let diagnostics = [];
  if (!knownHeadReachable) {
    const resolved = runGit(gitRunner, root, ["rev-parse", "--verify", `${rawCommit}^{commit}`], { timeout: 5000 });
    if (resolved.status !== 0) {
      return {
        ...classifyLifecycleCommitEvidence({ ticketId, commit: rawCommit, deliveryFiles, reachable: false }),
        exists: false,
        diagnostics: abnormalGitFailure(resolved, "git_commit_resolution_failed"),
      };
    }
    hash = asString(resolved.stdout);
  }
  let reachable = knownHeadReachable;
  if (!knownHeadReachable) {
    const ancestry = runGit(gitRunner, root, ["merge-base", "--is-ancestor", hash, "HEAD"], { timeout: 5000 });
    reachable = ancestry.status === 0;
    const ancestryFailed = ancestry.status !== 0
      && (ancestry.status !== 1 || ancestry.status === null || ancestry.error || ancestry.signal);
    if (ancestryFailed) {
      return {
        ...classifyLifecycleCommitEvidence({ ticketId, commit: hash, deliveryFiles, reachable: false }),
        trusted: false,
        reason: "git_commit_ancestry_check_failed",
        exists: true,
        hash,
        short_hash: hash.slice(0, 12),
        subject: "",
        diagnostics: ["git_commit_ancestry_check_failed"],
      };
    }
  }
  const messageResult = runGit(gitRunner, root, ["show", "-s", "--format=%B", hash], { timeout: 5000 });
  if (messageResult.status !== 0) diagnostics.push(...abnormalGitFailure(messageResult, "git_commit_message_read_failed"));
  const commitMessage = messageResult.status === 0 ? String(messageResult.stdout || "") : "";
  const exactTicketId = textReferencesTicketId(commitMessage, ticketId);
  const currentDelivery = uniquePaths(deliveryFiles).filter((path) => isSafeRepoPath(path) && !isGovernancePath(path));
  if (!reachable || exactTicketId) {
    return {
      ...classifyLifecycleCommitEvidence({
        ticketId,
        commit: hash,
        commitMessage,
        deliveryFiles: currentDelivery,
        reachable,
      }),
      exists: true,
      hash,
      short_hash: hash.slice(0, 12),
      subject: lines(commitMessage)[0] || "",
      diagnostics,
    };
  }

  const committedScope = readPlanDeliveryScope({ cwd: root, planDir, source: "commit", commit: hash, gitRunner });
  diagnostics.push(...asArray(committedScope.diagnostics));
  if (!committedScope.ok) {
    return {
      ...classifyLifecycleCommitEvidence({ ticketId, commit: hash, deliveryFiles: currentDelivery, reachable }),
      trusted: false,
      reason: committedScope.reason || "committed_scope_unavailable",
      exists: true,
      hash,
      short_hash: hash.slice(0, 12),
      subject: lines(commitMessage)[0] || "",
      committed_delivery_files: committedScope.delivery_files,
      committed_scope_matches_current: false,
      diagnostics,
    };
  }
  if (!samePaths(committedScope.delivery_files, currentDelivery)) {
    return {
      ...classifyLifecycleCommitEvidence({ ticketId, commit: hash, deliveryFiles: committedScope.delivery_files, reachable }),
      trusted: false,
      reason: "committed_scope_mismatch",
      exists: true,
      hash,
      short_hash: hash.slice(0, 12),
      subject: lines(commitMessage)[0] || "",
      current_delivery_files: currentDelivery,
      committed_delivery_files: committedScope.delivery_files,
      committed_scope_matches_current: false,
      diagnostics,
    };
  }

  const filesResult = runGit(gitRunner, root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", hash, "--"], { timeout: 10000 });
  if (filesResult.status !== 0) diagnostics.push(...abnormalGitFailure(filesResult, "git_commit_file_read_failed"));
  const commitFiles = filesResult.status === 0 ? lines(filesResult.stdout).map(normalizeRepoPath) : [];
  let classified = classifyLifecycleCommitEvidence({
    ticketId,
    commit: hash,
    commitMessage,
    commitFiles,
    deliveryFiles: committedScope.delivery_files,
    reachable,
  });
  const planPath = repoRelative(root, planDir);
  const statePath = planPath ? `${planPath}/state.json` : "";
  const committedStateResult = statePath
    ? runGit(gitRunner, root, ["show", `${hash}:${statePath}`], { timeout: 5000 })
    : { status: 1, stdout: "", stderr: "missing plan path" };
  if (committedStateResult.status !== 0) diagnostics.push(...abnormalGitFailure(committedStateResult, "git_committed_state_read_failed"));
  const committedStateJson = committedStateResult.status === 0 ? safeJson(String(committedStateResult.stdout || "")) : null;
  if (committedStateResult.status === 0 && !committedStateJson) diagnostics.push("commit_state_json_invalid");
  const committedState = asString(committedStateJson?.state).toLowerCase();
  if (classified.trusted && !CLOSED_STATES.has(committedState)) {
    classified = { ...classified, trusted: false, reason: "committed_state_not_closed" };
  }
  return {
    ...classified,
    exists: true,
    hash,
    short_hash: hash.slice(0, 12),
    subject: lines(commitMessage)[0] || "",
    committed_state: committedState || null,
    current_delivery_files: currentDelivery,
    committed_delivery_files: committedScope.delivery_files,
    committed_scope_matches_current: true,
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

export function collectTrustedLifecycleCommitEvidence({
  cwd = process.cwd(),
  ticketId,
  deliveryFiles = [],
  planDir = null,
  limit = LIFECYCLE_GIT_CANDIDATE_LIMIT,
  gitRunner = defaultGitRunner,
} = {}) {
  const root = resolve(cwd);
  const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : LIFECYCLE_GIT_CANDIDATE_LIMIT;
  const boundedLimit = Math.min(requested, LIFECYCLE_GIT_CANDIDATE_LIMIT);
  const candidates = [];
  const warnings = [];
  const id = asString(ticketId);
  const queryLimit = boundedLimit + 1;
  if (id) {
    const exactLog = runGit(gitRunner, root, [
      "log", "HEAD", `--max-count=${queryLimit}`, "--format=%H", "--fixed-strings", `--grep=${id}`,
    ], { timeout: 15000 });
    if (exactLog.status === 0) candidates.push(...lines(exactLog.stdout));
    else warnings.push("git_exact_id_log_unavailable", ...abnormalGitFailure(exactLog, "git_exact_id_log_failed"));
  }
  const delivery = uniquePaths(deliveryFiles).filter((path) => isSafeRepoPath(path) && !isGovernancePath(path));
  if (delivery.length > 0) {
    const scopeLog = runGit(gitRunner, root, [
      "log", "HEAD", `--max-count=${queryLimit}`, "--format=%H", "--", ...delivery,
    ], { timeout: 15000 });
    if (scopeLog.status === 0) candidates.push(...lines(scopeLog.stdout));
    else warnings.push("git_delivery_scope_log_unavailable", ...abnormalGitFailure(scopeLog, "git_delivery_scope_log_failed"));
  }
  const uniqueCandidates = [...new Set(candidates)];
  if (requested > boundedLimit || uniqueCandidates.length > boundedLimit) warnings.push("git_candidate_budget_exhausted");
  const verified = [];
  let candidatesChecked = 0;
  for (const hash of uniqueCandidates.slice(0, boundedLimit)) {
    candidatesChecked += 1;
    const result = verifyLifecycleCommitEvidence({
      cwd: root,
      ticketId: id,
      commit: hash,
      deliveryFiles: delivery,
      planDir,
      knownHeadReachable: true,
      gitRunner,
    });
    warnings.push(...asArray(result.diagnostics));
    if (!result.trusted) continue;
    verified.push({
      kind: "git_commit",
      status: "verified",
      commit: result.short_hash,
      hash: result.hash,
      subject: result.subject,
      detail: result.reason,
      exact_ticket_id: result.exact_ticket_id,
      full_delivery_scope: result.full_delivery_scope,
      delivery_files: result.delivery_files,
      changed_files: result.changed_files,
      missing_delivery_files: result.missing_delivery_files,
      committed_scope_matches_current: result.committed_scope_matches_current,
      head_reachable: result.reachable,
    });
    break;
  }
  return {
    evidence: verified,
    warnings: [...new Set(warnings)].filter(Boolean).sort(),
    candidate_limit: boundedLimit,
    candidates_checked: candidatesChecked,
  };
}

function parseIndexEntries(raw) {
  return lines(raw).map((line) => {
    const [metadata, path = ""] = line.split("\t");
    const [mode = "", object = "", stageText = ""] = String(metadata || "").split(/\s+/);
    return {
      raw: line,
      mode,
      object,
      stage: Number(stageText),
      path: normalizeRepoPath(path),
    };
  }).filter((entry) => entry.path && Number.isInteger(entry.stage));
}

export function collectStagedCloseEvidence({
  cwd = process.cwd(),
  ticketId,
  planDir,
  gitRunner = defaultGitRunner,
} = {}) {
  const root = resolve(cwd);
  const scope = readPlanDeliveryScope({ cwd: root, planDir, source: "index", gitRunner });
  const diagnostics = [...asArray(scope.diagnostics)];
  const planPath = scope.plan_dir || repoRelative(root, planDir);
  const statePath = planPath ? `${planPath}/state.json` : null;
  const stateResult = statePath
    ? runGit(gitRunner, root, ["show", `:${statePath}`], { timeout: 5000 })
    : { status: 1, stdout: "", stderr: "missing plan path" };
  if (stateResult.status !== 0) diagnostics.push(...abnormalGitFailure(stateResult, "git_indexed_state_read_failed"));
  const indexedStateJson = stateResult.status === 0 ? safeJson(String(stateResult.stdout || "")) : null;
  if (stateResult.status === 0 && !indexedStateJson) diagnostics.push("index_state_json_invalid");
  const indexedState = asString(indexedStateJson?.state).toLowerCase();
  const changedResult = runGit(gitRunner, root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXBD", "HEAD", "--"], { timeout: 10000 });
  if (changedResult.status !== 0) diagnostics.push(...abnormalGitFailure(changedResult, "git_index_diff_read_failed"));
  const stagedPaths = changedResult.status === 0 ? uniquePaths(lines(changedResult.stdout)) : [];
  const deletionResult = runGit(gitRunner, root, ["diff", "--cached", "--name-only", "--diff-filter=D", "HEAD", "--"], { timeout: 10000 });
  if (deletionResult.status !== 0) diagnostics.push(...abnormalGitFailure(deletionResult, "git_index_deletion_read_failed"));
  const deletedPaths = deletionResult.status === 0 ? uniquePaths(lines(deletionResult.stdout)) : [];
  const deliveryFiles = scope.delivery_files || [];
  const stagedDeliveryFiles = deliveryFiles.filter((path) => stagedPaths.includes(path));
  const missingDeliveryFiles = deliveryFiles.filter((path) => !stagedPaths.includes(path));
  const proofPaths = uniquePaths([statePath, scope.scope_path, ...deliveryFiles]).filter(Boolean);
  const indexResult = proofPaths.length > 0
    ? runGit(gitRunner, root, ["ls-files", "--stage", "--", ...proofPaths], { timeout: 10000 })
    : { status: 1, stdout: "", stderr: "missing proof paths" };
  if (indexResult.status !== 0) diagnostics.push(...abnormalGitFailure(indexResult, "git_index_entries_read_failed"));
  const parsedEntries = indexResult.status === 0 ? parseIndexEntries(indexResult.stdout) : [];
  const entriesByPath = new Map();
  for (const entry of parsedEntries) {
    if (!entriesByPath.has(entry.path)) entriesByPath.set(entry.path, []);
    entriesByPath.get(entry.path).push(entry);
  }
  const conflictingIndexPaths = proofPaths.filter((path) =>
    asArray(entriesByPath.get(path)).some((entry) => entry.stage !== 0)
  );
  const missingIndexEntries = proofPaths.filter((path) => {
    if (deletedPaths.includes(path)) return false;
    const entries = asArray(entriesByPath.get(path));
    return entries.filter((entry) => entry.stage === 0).length !== 1;
  });
  if (conflictingIndexPaths.length > 0) diagnostics.push("index_contains_unmerged_entries");
  const indexEntries = parsedEntries.map((entry) => entry.raw).sort();
  const deletionEntries = deletedPaths.filter((path) => proofPaths.includes(path)).map((path) => `deleted\t${path}`).sort();
  const headResult = runGit(gitRunner, root, ["rev-parse", "--verify", "HEAD"], { timeout: 5000 });
  if (headResult.status !== 0) diagnostics.push(...abnormalGitFailure(headResult, "git_head_read_failed"));
  const head = headResult.status === 0 ? asString(headResult.stdout) : null;
  const stateClosed = CLOSED_STATES.has(indexedState);
  const stateStaged = !!statePath && stagedPaths.includes(statePath) && !deletedPaths.includes(statePath);
  const qualified = scope.ok
    && stateClosed
    && stateStaged
    && missingDeliveryFiles.length === 0
    && missingIndexEntries.length === 0
    && conflictingIndexPaths.length === 0
    && !!head;
  const indexFingerprint = qualified
    ? createHash("sha256").update([`head\t${head}`, ...indexEntries, ...deletionEntries].sort().join("\n")).digest("hex")
    : null;
  let reason = "staged_close_pending_commit";
  if (!scope.ok) reason = scope.reason || "delivery_scope_unavailable";
  else if (!stateClosed) reason = "indexed_state_not_closed";
  else if (!stateStaged) reason = "close_state_not_staged";
  else if (missingDeliveryFiles.length > 0) reason = "delivery_scope_not_fully_staged";
  else if (conflictingIndexPaths.length > 0) reason = "index_contains_unmerged_entries";
  else if (missingIndexEntries.length > 0) reason = "index_entries_incomplete";
  else if (!head) reason = "head_unavailable";
  return {
    kind: "staged_close_pending_commit",
    status: qualified ? "pending_commit" : "unqualified",
    qualified,
    reason,
    ticket_id: asString(ticketId) || null,
    plan_dir: planPath || null,
    state_path: statePath,
    scope_path: scope.scope_path || null,
    indexed_state: indexedState || null,
    head,
    delivery_files: deliveryFiles,
    staged_delivery_files: stagedDeliveryFiles,
    deleted_delivery_files: deliveryFiles.filter((path) => deletedPaths.includes(path)),
    missing_delivery_files: missingDeliveryFiles,
    missing_index_entries: missingIndexEntries,
    conflicting_index_paths: conflictingIndexPaths,
    index_entries: qualified ? indexEntries : [],
    deletion_entries: qualified ? deletionEntries : [],
    index_fingerprint: indexFingerprint,
    diagnostics: [...new Set(diagnostics)].filter(Boolean).sort(),
    closes_lifecycle: false,
    dispositionable: false,
  };
}
