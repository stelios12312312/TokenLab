// issue_history_cache.mjs — Deterministic GitHub Issue history cache.
// @planner:capability = github_issue_history_cache

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, relative } from "path";
import {
  assertRemoteReadAllowed,
  resolveRemoteMode,
} from "./remote_mode.mjs";

export const ISSUE_HISTORY_CACHE_VERSION = 1;
export const DEFAULT_CACHE_ROOT = "plans/knowledge/github_issues";
const ISSUE_FIELDS = [
  "number",
  "title",
  "state",
  "url",
  "labels",
  "updatedAt",
  "createdAt",
  "closedAt",
  "author",
  "assignees",
  "milestone",
  "body",
];
const DETAIL_FIELDS = [...ISSUE_FIELDS, "comments"];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeState(value) {
  const normalized = asString(value).toLowerCase();
  if (["open", "closed", "all"].includes(normalized)) return normalized;
  return "all";
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function parseCsv(value) {
  if (Array.isArray(value)) return value.flatMap(parseCsv);
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function repoSlug(repo) {
  return String(repo || "unknown")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "__")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function compactPath(cwd, path) {
  try {
    return relative(cwd, path) || path;
  } catch {
    return path;
  }
}

function runGhJson(args, { cwd, ghRunner }) {
  const result = ghRunner(args, { cwd });
  if (result.status !== 0) {
    const output = String(result.stderr || result.stdout || "").trim();
    const rateLimited = /rate.?limit|secondary rate|api rate/i.test(output);
    const error = new Error(output || `gh ${args.join(" ")} failed`);
    error.code = rateLimited ? "rate_limited" : "gh_failed";
    error.args = args;
    error.output = output;
    throw error;
  }
  try {
    return JSON.parse(result.stdout || "null");
  } catch (error) {
    error.code = "invalid_gh_json";
    error.output = result.stdout;
    throw error;
  }
}

export function defaultGhRunner(args, { cwd = process.cwd() } = {}) {
  const child = spawnSync("gh", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: child.status ?? (child.error ? 1 : 0),
    stdout: child.stdout || "",
    stderr: child.stderr || child.error?.message || "",
  };
}

export function buildIssueListArgs({ repo, state = "all", labels = [], scope = "all", limit = 100 } = {}) {
  const args = [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    normalizeState(state),
    "--limit",
    String(Number.isFinite(Number(limit)) ? Math.max(1, Math.trunc(Number(limit))) : 100),
    "--json",
    ISSUE_FIELDS.join(","),
  ];
  for (const label of parseCsv(labels).sort((a, b) => a.localeCompare(b))) {
    args.push("--label", label);
  }
  const normalizedScope = asString(scope).toLowerCase() || "all";
  if (normalizedScope === "assigned") args.push("--assignee", "@me");
  else if (normalizedScope === "created") args.push("--author", "@me");
  else if (normalizedScope === "mentioned") args.push("--mention", "@me");
  return args;
}

function buildIssueViewArgs({ repo, number }) {
  return [
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    DETAIL_FIELDS.join(","),
  ];
}

function normalizeLabel(label) {
  if (typeof label === "string") return label;
  return asString(label?.name);
}

function normalizeUser(user) {
  if (!user) return null;
  if (typeof user === "string") return { login: user };
  return {
    login: asString(user.login) || null,
  };
}

function normalizeComment(comment) {
  return {
    id: asString(comment?.id) || String(comment?.databaseId || ""),
    author: normalizeUser(comment?.author),
    body: asString(comment?.body),
    created_at: asString(comment?.createdAt),
    updated_at: asString(comment?.updatedAt),
    url: asString(comment?.url),
  };
}

export function normalizeIssue(raw, { source = "detail" } = {}) {
  const labels = asArray(raw?.labels)
    .map(normalizeLabel)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const comments = asArray(raw?.comments)
    .map(normalizeComment)
    .sort((a, b) => String(a.created_at || a.id).localeCompare(String(b.created_at || b.id)));
  return {
    number: Number(raw?.number),
    title: asString(raw?.title),
    state: asString(raw?.state).toLowerCase() || null,
    url: asString(raw?.url),
    labels,
    author: normalizeUser(raw?.author),
    assignees: asArray(raw?.assignees).map(normalizeUser).filter(Boolean).sort((a, b) => String(a.login).localeCompare(String(b.login))),
    milestone: raw?.milestone ? { title: asString(raw.milestone.title), number: raw.milestone.number ?? null } : null,
    body: asString(raw?.body),
    created_at: asString(raw?.createdAt),
    updated_at: asString(raw?.updatedAt),
    closed_at: asString(raw?.closedAt),
    comments,
    source,
  };
}

function manifestWithoutContentHash(manifest) {
  const clone = { ...manifest };
  delete clone.content_sha256;
  return clone;
}

function issuePathFor(number) {
  return `issues/${String(number).padStart(6, "0")}.json`;
}

export function writeIssueHistoryCache({ cwd = process.cwd(), out = DEFAULT_CACHE_ROOT, repo, query, issues, partialFailures = [], generatedAt = new Date().toISOString(), ttlHours = 24 } = {}) {
  const cacheDir = join(cwd, out, repoSlug(repo));
  const issueDir = join(cacheDir, "issues");
  mkdirSync(issueDir, { recursive: true });

  const issueEntries = [];
  for (const issue of [...issues].sort((a, b) => Number(a.number) - Number(b.number))) {
    const relPath = issuePathFor(issue.number);
    const doc = {
      schema_version: ISSUE_HISTORY_CACHE_VERSION,
      repo,
      generated_at: generatedAt,
      issue,
    };
    const hash = sha256(stableStringify(doc));
    writeJson(join(cacheDir, relPath), { ...doc, sha256: hash });
    issueEntries.push({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      updated_at: issue.updated_at,
      path: relPath,
      sha256: hash,
    });
  }

  const index = {
    schema_version: ISSUE_HISTORY_CACHE_VERSION,
    repo,
    generated_at: generatedAt,
    query,
    issue_count: issueEntries.length,
    issues: issueEntries,
  };
  const indexHash = sha256(stableStringify(index));
  writeJson(join(cacheDir, "index.json"), { ...index, sha256: indexHash });

  const manifest = {
    schema_version: ISSUE_HISTORY_CACHE_VERSION,
    repo,
    generated_at: generatedAt,
    expires_at: new Date(Date.parse(generatedAt) + Number(ttlHours || 24) * 60 * 60 * 1000).toISOString(),
    refresh_after_hours: Number(ttlHours || 24),
    query,
    query_sha256: sha256(stableStringify(query)),
    issue_count: issueEntries.length,
    partial_failure_count: partialFailures.length,
    partial_failures: partialFailures,
    index_path: "index.json",
    index_sha256: indexHash,
    issue_hashes: issueEntries.map((entry) => ({ number: entry.number, path: entry.path, sha256: entry.sha256 })),
  };
  const contentHash = sha256(stableStringify(manifestWithoutContentHash(manifest)));
  const finalManifest = { ...manifest, content_sha256: contentHash };
  writeJson(join(cacheDir, "manifest.json"), finalManifest);

  return {
    cache_dir: compactPath(cwd, cacheDir),
    cache_dir_abs: cacheDir,
    manifest: finalManifest,
    index: { ...index, sha256: indexHash },
    status: partialFailures.length > 0 ? "WARN" : "PASS",
  };
}

export function verifyIssueHistoryCache({ cwd = process.cwd(), cacheDir } = {}) {
  const absDir = cacheDir?.startsWith("/") ? cacheDir : join(cwd, cacheDir || "");
  const issues = [];
  const failures = [];
  try {
    const manifest = readJson(join(absDir, "manifest.json"));
    const expectedManifestHash = manifest.content_sha256;
    const actualManifestHash = sha256(stableStringify(manifestWithoutContentHash(manifest)));
    if (expectedManifestHash !== actualManifestHash) failures.push({ code: "manifest_hash_mismatch", expected: expectedManifestHash, actual: actualManifestHash });

    const index = readJson(join(absDir, manifest.index_path || "index.json"));
    const expectedIndexHash = manifest.index_sha256;
    const actualIndexHash = sha256(stableStringify({ ...index, sha256: undefined }));
    if (expectedIndexHash !== actualIndexHash) failures.push({ code: "index_hash_mismatch", expected: expectedIndexHash, actual: actualIndexHash });

    for (const entry of asArray(manifest.issue_hashes)) {
      const issueDoc = readJson(join(absDir, entry.path));
      const actualIssueHash = sha256(stableStringify({ ...issueDoc, sha256: undefined }));
      if (entry.sha256 !== actualIssueHash || issueDoc.sha256 !== actualIssueHash) {
        failures.push({ code: "issue_hash_mismatch", number: entry.number, expected: entry.sha256, actual: actualIssueHash });
      }
      issues.push(issueDoc.issue);
    }
    return {
      ok: failures.length === 0,
      status: failures.length === 0 ? "PASS" : "FAIL",
      cache_dir: compactPath(cwd, absDir),
      repo: manifest.repo,
      issue_count: issues.length,
      partial_failure_count: manifest.partial_failure_count || 0,
      failures,
    };
  } catch (error) {
    return {
      ok: false,
      status: "FAIL",
      cache_dir: compactPath(cwd, absDir),
      error_code: "cache_verify_failed",
      error: error.message,
      failures: [{ code: "cache_verify_failed", message: error.message }],
    };
  }
}

export function collectIssueHistoryCache({
  cwd = process.cwd(),
  repo,
  out = DEFAULT_CACHE_ROOT,
  state = "all",
  labels = [],
  scope = "all",
  limit = 100,
  ttlHours = 24,
  generatedAt = new Date().toISOString(),
  remoteMode = null,
  env = process.env,
  ghRunner = defaultGhRunner,
} = {}) {
  const mode = resolveRemoteMode({ explicit: remoteMode, env, defaultMode: "remote-read" });
  assertRemoteReadAllowed(mode, "issue_history_cache collect");
  if (!repo) throw new Error("collect requires --repo <owner/repo>");

  const query = {
    repo,
    state: normalizeState(state),
    labels: parseCsv(labels).sort((a, b) => a.localeCompare(b)),
    scope: asString(scope).toLowerCase() || "all",
    limit: Number.isFinite(Number(limit)) ? Math.max(1, Math.trunc(Number(limit))) : 100,
  };

  let listed;
  try {
    listed = runGhJson(buildIssueListArgs(query), { cwd, ghRunner });
  } catch (error) {
    return {
      ok: false,
      status: "FAIL",
      error_code: error.code === "rate_limited" ? "rate_limited" : "gh_list_failed",
      error: error.output || error.message,
      remote_mode: mode,
      query,
      cache_dir: join(out, repoSlug(repo)),
    };
  }

  const summaries = asArray(listed);
  const issues = [];
  const partialFailures = [];
  for (const summary of summaries) {
    const number = summary?.number;
    if (!number) continue;
    try {
      const detail = runGhJson(buildIssueViewArgs({ repo, number }), { cwd, ghRunner });
      issues.push(normalizeIssue({ ...summary, ...detail }, { source: "detail" }));
    } catch (error) {
      partialFailures.push({
        number,
        code: error.code === "rate_limited" ? "rate_limited" : "gh_detail_failed",
        message: error.output || error.message,
      });
      issues.push(normalizeIssue(summary, { source: "list_fallback" }));
    }
  }

  const written = writeIssueHistoryCache({
    cwd,
    out,
    repo,
    query,
    issues,
    partialFailures,
    generatedAt,
    ttlHours,
  });
  return {
    ok: partialFailures.length === 0,
    status: written.status,
    remote_mode: mode,
    query,
    cache_dir: written.cache_dir,
    manifest: written.manifest,
    partial_failures: partialFailures,
  };
}
