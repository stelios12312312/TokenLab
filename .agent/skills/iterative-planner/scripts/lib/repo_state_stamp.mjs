// @planner:module = repo_state_stamp
// @planner:capability = stamps_receipts_with_repo_state_and_dirty_input_digests

import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { spawnSync } from "child_process";

const DEFAULT_MAX_DIRTY_FILES = 200;
const MAX_STAMPED_ARTIFACT_BYTES = 1024 * 1024;
const DEFAULT_ARTIFACT_PATH_LIMIT = 80;
const STAMP_SCHEMA_VERSION = "repo_state_stamp.v1";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function uniqueSorted(values) {
  return [...new Set(values.map(normalizeRepoPath).filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
  } catch (err) {
    return { status: 1, stdout: "", stderr: err?.message || String(err) };
  }
}

function stripGitQuotes(path) {
  const value = asString(path);
  if (!value) return "";
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function normalizeStatusPath(path) {
  const value = stripGitQuotes(path);
  const renameMarker = " -> ";
  if (value.includes(renameMarker)) return normalizeRepoPath(value.split(renameMarker).pop());
  return normalizeRepoPath(value);
}

function pathWithinRoot(path, root) {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedRoot = normalizeRepoPath(root);
  if (!normalizedPath || !normalizedRoot) return false;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function pathIntersects(path, scopePath) {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedScope = normalizeRepoPath(scopePath);
  if (!normalizedPath || !normalizedScope) return false;
  return normalizedPath === normalizedScope ||
    normalizedPath.startsWith(`${normalizedScope}/`) ||
    normalizedScope.startsWith(`${normalizedPath}/`);
}

function digestFile(root, repoPath) {
  const absPath = resolve(root, repoPath);
  try {
    const st = statSync(absPath);
    if (!st.isFile()) {
      return { digest: null, digest_status: st.isDirectory() ? "directory" : "not_file" };
    }
    const digest = createHash("sha256").update(readFileSync(absPath)).digest("hex");
    return { digest, digest_status: "ok" };
  } catch (err) {
    return {
      digest: null,
      digest_status: err?.code === "ENOENT" ? "missing" : "unreadable",
    };
  }
}

export function parseGitStatusPorcelain(text) {
  const entries = [];
  for (const rawLine of String(text || "").split("\n")) {
    if (!rawLine.trim()) continue;
    const status = rawLine.length >= 2 ? rawLine.slice(0, 2) : rawLine.trim();
    const rawPath = rawLine.length > 3 ? rawLine.slice(3) : "";
    const path = normalizeStatusPath(rawPath);
    if (!path) continue;
    entries.push({
      status,
      path,
      tracked: status !== "??",
    });
  }
  return entries;
}

export function buildRepoStateStamp({
  cwd = process.cwd(),
  inputRoots = [],
  maxDirtyFiles = DEFAULT_MAX_DIRTY_FILES,
  invocation = {},
  now = () => new Date(),
  gitRunner = defaultGitRunner,
} = {}) {
  const resolvedCwd = resolve(cwd);
  const rootProc = runGit(gitRunner, resolvedCwd, ["rev-parse", "--show-toplevel"], { timeout: 5000 });
  const gitRoot = rootProc?.status === 0 ? asString(rootProc.stdout) : resolvedCwd;
  const headProc = runGit(gitRunner, gitRoot, ["rev-parse", "HEAD"], { timeout: 5000 });
  const statusProc = runGit(gitRunner, gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10000 });
  const normalizedInputRoots = uniqueSorted(inputRoots);
  const entries = statusProc?.status === 0 ? parseGitStatusPorcelain(statusProc.stdout) : [];
  const eligibleEntries = entries
    .filter((entry) => entry.tracked || normalizedInputRoots.some((root) => pathWithinRoot(entry.path, root)))
    .sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
  const totalDirtyFileCount = eligibleEntries.length;
  const limit = Number.isFinite(maxDirtyFiles) && maxDirtyFiles >= 0 ? maxDirtyFiles : DEFAULT_MAX_DIRTY_FILES;
  const listedEntries = eligibleEntries.slice(0, limit);
  const dirtyFiles = listedEntries.map((entry) => ({
    path: entry.path,
    status: entry.status,
    tracked: entry.tracked,
    ...digestFile(gitRoot, entry.path),
  }));

  return {
    schema_version: STAMP_SCHEMA_VERSION,
    stamped_at: now().toISOString(),
    git_root: normalizeRepoPath(relative(resolvedCwd, gitRoot)) || ".",
    head_sha: headProc?.status === 0 ? asString(headProc.stdout) : null,
    head_short_sha: headProc?.status === 0 ? asString(headProc.stdout).slice(0, 12) : null,
    dirty: totalDirtyFileCount > 0,
    dirty_file_count: totalDirtyFileCount,
    listed_dirty_file_count: dirtyFiles.length,
    overflow_count: Math.max(0, totalDirtyFileCount - dirtyFiles.length),
    dirty_files: dirtyFiles,
    untracked_input_roots: normalizedInputRoots,
    invocation: {
      cwd: normalizeRepoPath(relative(gitRoot, resolvedCwd)) || ".",
      ...invocation,
    },
    warnings: [
      ...(rootProc?.status === 0 ? [] : [`git_root_unavailable: ${asString(rootProc?.stderr) || "git rev-parse failed"}`]),
      ...(headProc?.status === 0 ? [] : [`head_unavailable: ${asString(headProc?.stderr) || "git rev-parse HEAD failed"}`]),
      ...(statusProc?.status === 0 ? [] : [`status_unavailable: ${asString(statusProc?.stderr) || "git status failed"}`]),
    ],
  };
}

export function repoStateStampHasDirtyFiles(stamp) {
  return Array.isArray(stamp?.dirty_files) && stamp.dirty_files.length > 0;
}

export function dirtyFilesIntersectScope(stamp, scopeFiles = []) {
  const scope = uniqueSorted(scopeFiles);
  if (scope.length === 0) return [];
  const dirtyFiles = Array.isArray(stamp?.dirty_files) ? stamp.dirty_files : [];
  return dirtyFiles
    .map((entry) => normalizeRepoPath(entry?.path || entry))
    .filter((path) => scope.some((scopePath) => pathIntersects(path, scopePath)))
    .sort((a, b) => a.localeCompare(b));
}

export function extractRepoStateStampFromObject(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [
    value.repo_state_stamp,
    value.repoStateStamp,
    value.repo_state,
    value.repoState,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === "object") || null;
}

function parseStampedJsonArtifact(raw, artifactPath) {
  try {
    const parsed = JSON.parse(raw);
    const stamp = extractRepoStateStampFromObject(parsed);
    return stamp ? [{ artifact_path: artifactPath, repo_state_stamp: stamp }] : [];
  } catch {
    return [];
  }
}

function parseStampedJsonlArtifact(raw, artifactPath) {
  const entries = [];
  String(raw || "").split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      const stamp = extractRepoStateStampFromObject(parsed);
      if (stamp) {
        entries.push({
          artifact_path: artifactPath,
          line: index + 1,
          repo_state_stamp: stamp,
        });
      }
    } catch {
      // Ignore non-JSON log lines; callers only need stamped receipt evidence.
    }
  });
  return entries;
}

export function extractArtifactPathsFromText(text, { limit = DEFAULT_ARTIFACT_PATH_LIMIT } = {}) {
  const pattern = /(?:^|[\s("'`])((?:\.agent|plans|reports|docs|apps|packages|scripts|tests)\/[A-Za-z0-9_./@%+=-]+\.(?:json|jsonl))(?=$|[\s)"'`,;:])/g;
  const paths = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(String(text || ""))) && paths.length < limit) {
    const candidate = normalizeRepoPath(match[1]);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    paths.push(candidate);
  }
  return paths;
}

export function collectRepoStateStampedArtifacts({
  cwd = process.cwd(),
  artifactPaths = [],
  text = "",
} = {}) {
  const resolvedCwd = resolve(cwd);
  const candidates = uniqueSorted([
    ...artifactPaths,
    ...extractArtifactPathsFromText(text),
  ]);
  const artifacts = [];
  for (const candidate of candidates) {
    const artifactPath = isAbsolute(candidate) ? candidate : resolve(resolvedCwd, candidate);
    let st;
    try {
      st = statSync(artifactPath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_STAMPED_ARTIFACT_BYTES) continue;
    const raw = readFileSync(artifactPath, "utf-8");
    const relPath = normalizeRepoPath(relative(resolvedCwd, artifactPath));
    const parsed = relPath.endsWith(".jsonl")
      ? parseStampedJsonlArtifact(raw, relPath)
      : parseStampedJsonArtifact(raw, relPath);
    artifacts.push(...parsed);
  }
  return artifacts.sort((a, b) => {
    const pathOrder = a.artifact_path.localeCompare(b.artifact_path);
    if (pathOrder !== 0) return pathOrder;
    return (a.line || 0) - (b.line || 0);
  });
}

export function evaluateDirtyInputProofArtifacts({
  cwd = process.cwd(),
  verificationContent = "",
  scopeFiles = [],
  artifactPaths = [],
} = {}) {
  const artifacts = collectRepoStateStampedArtifacts({ cwd, text: verificationContent, artifactPaths });
  const intersections = [];
  for (const artifact of artifacts) {
    const dirtyFiles = dirtyFilesIntersectScope(artifact.repo_state_stamp, scopeFiles);
    if (dirtyFiles.length === 0) continue;
    intersections.push({
      artifact_path: artifact.artifact_path,
      line: artifact.line || null,
      dirty_files: dirtyFiles,
    });
  }
  return {
    stamped_artifact_count: artifacts.length,
    dirty_input_artifact_count: intersections.length,
    intersections,
  };
}

export const REPO_STATE_STAMP_SCHEMA_VERSION = STAMP_SCHEMA_VERSION;
