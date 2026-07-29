// issue_history_facts.mjs — Compile verified GitHub Issue cache records into Prolog facts.
// @planner:capability = github_issue_history_ontology_facts

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join, relative } from "path";

import {
  DEFAULT_CACHE_ROOT,
  verifyIssueHistoryCache,
} from "./issue_history_cache.mjs";
import {
  sanitizeAtom,
  sanitizeEnumAtom,
  sanitizeStrictId,
} from "./sanitize.mjs";

const MAX_CACHE_FILE_BYTES = 1_048_576;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactPath(cwd, path) {
  try {
    return relative(cwd, path) || path;
  } catch {
    return path;
  }
}

function readJson(filePath) {
  const st = statSync(filePath);
  if (st.size > MAX_CACHE_FILE_BYTES) {
    const error = new Error(`cache file exceeds ${MAX_CACHE_FILE_BYTES} bytes: ${filePath}`);
    error.code = "cache_file_too_large";
    throw error;
  }
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function issueNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function cacheIdFor({ repo, cacheDir }) {
  const seed = asString(repo) || basename(cacheDir || "unknown");
  return `issue_history_cache:${seed}`;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function textLooksLikeDecision(value) {
  const text = asString(value);
  return /\b(decision|decided|verdict|accepted|approved|chosen|we will|resolution|resolved)\b/i.test(text);
}

function textLooksLikeBlocker(value) {
  const text = asString(value);
  // proof-status-lint: exempt T-INTAKE-B07B8898 -- Semantic topic classifier detects blocker language in issue-history text.
  return /\b(blocker|blocked|blocking|unblock|unblocked|resolved blocker|dependency blocked)\b/i.test(text);
}

function issueHasBlockerSignal(issue) {
  const labels = asArray(issue?.labels).map((label) => asString(label));
  if (labels.some((label) => textLooksLikeBlocker(label))) return true;
  if (textLooksLikeBlocker(issue?.title) || textLooksLikeBlocker(issue?.body)) return true;
  return asArray(issue?.comments).some((comment) => textLooksLikeBlocker(comment?.body));
}

function normalizedIssueState(issue) {
  const state = asString(issue?.state).toLowerCase();
  if (state === "open" || state === "closed") return state;
  return state || "unknown";
}

function commentId(comment, index) {
  return asString(comment?.id) || `comment_${index + 1}`;
}

function pushFact(lines, seen, fact) {
  if (!fact || seen.has(fact)) return;
  seen.add(fact);
  lines.push(fact);
}

function scanCacheDirs({ cwd, cacheRoot = DEFAULT_CACHE_ROOT, cacheDir = null } = {}) {
  if (cacheDir) {
    const abs = cacheDir.startsWith("/") ? cacheDir : join(cwd, cacheDir);
    return existsSync(abs) ? [abs] : [];
  }
  const root = cacheRoot.startsWith("/") ? cacheRoot : join(cwd, cacheRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((candidate) => {
      try {
        return statSync(candidate).isDirectory() && existsSync(join(candidate, "manifest.json"));
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

function loadVerifiedCache({ cwd, cacheDir }) {
  let manifest = null;
  try {
    manifest = readJson(join(cacheDir, "manifest.json"));
  } catch (error) {
    const cacheId = cacheIdFor({ cacheDir });
    return {
      ok: false,
      cacheId,
      repo: basename(cacheDir),
      manifest: null,
      issues: [],
      failures: [{ code: error.code || "manifest_read_failed", message: error.message }],
    };
  }

  const cacheRel = compactPath(cwd, cacheDir);
  const verification = verifyIssueHistoryCache({ cwd, cacheDir: cacheRel });
  const cacheId = cacheIdFor({ repo: manifest.repo, cacheDir });
  if (!verification.ok) {
    return {
      ok: false,
      cacheId,
      repo: manifest.repo || basename(cacheDir),
      manifest,
      issues: [],
      failures: verification.failures || [{ code: verification.error_code || "cache_verify_failed", message: verification.error }],
    };
  }

  const issues = [];
  for (const entry of asArray(manifest.issue_hashes)) {
    try {
      const issueDoc = readJson(join(cacheDir, entry.path));
      if (issueDoc?.issue) issues.push(issueDoc.issue);
    } catch (error) {
      return {
        ok: false,
        cacheId,
        repo: manifest.repo || basename(cacheDir),
        manifest,
        issues: [],
        failures: [{ code: error.code || "issue_read_failed", number: entry.number, message: error.message }],
      };
    }
  }

  return {
    ok: true,
    cacheId,
    repo: manifest.repo || verification.repo || basename(cacheDir),
    manifest,
    issues,
    failures: [],
  };
}

function compileCacheFacts(cache, { includeTitles = true } = {}) {
  const facts = [];
  const seen = new Set();
  const repo = sanitizeStrictId(cache.repo);
  const cacheId = sanitizeStrictId(cache.cacheId);
  const status = cache.ok ? "valid" : "invalid";

  pushFact(facts, seen, `issue_history_cache(${cacheId}, ${repo}).`);
  pushFact(facts, seen, `issue_history_cache_status(${cacheId}, ${sanitizeEnumAtom(status)}).`);
  if (cache.manifest?.generated_at) {
    pushFact(facts, seen, `issue_history_cache_generated_at(${cacheId}, ${sanitizeStrictId(cache.manifest.generated_at)}).`);
  }

  if (!cache.ok) {
    for (const failure of asArray(cache.failures)) {
      pushFact(facts, seen, `issue_history_cache_issue(${cacheId}, ${sanitizeEnumAtom(failure?.code || "cache_invalid")}).`);
    }
    pushFact(facts, seen, `issue_history_cache_record_count(${cacheId}, 0).`);
    return { facts, meta: { records: 0, labels: 0, comments: 0, decisions: 0, blocker_resolutions: 0 } };
  }

  let labelCount = 0;
  let commentCount = 0;
  let decisionCount = 0;
  let blockerResolutionCount = 0;
  const issues = [...cache.issues].sort((a, b) => Number(a.number) - Number(b.number));
  pushFact(facts, seen, `issue_history_cache_record_count(${cacheId}, ${issues.length}).`);

  for (const issue of issues) {
    const number = issueNumber(issue?.number);
    if (!number) continue;
    const state = normalizedIssueState(issue);
    pushFact(facts, seen, `issue_history_record(${cacheId}, ${number}).`);
    pushFact(facts, seen, `issue_history_record_repo(${cacheId}, ${repo}, ${number}).`);
    pushFact(facts, seen, `issue_state(${repo}, ${number}, ${sanitizeEnumAtom(state)}).`);
    if (includeTitles && asString(issue?.title)) pushFact(facts, seen, `issue_title(${repo}, ${number}, ${sanitizeAtom(issue.title)}).`);

    const author = sanitizeStrictId(issue?.author?.login || "unknown");
    pushFact(facts, seen, `issue_created(${repo}, ${number}, ${sanitizeStrictId(issue?.created_at || "unknown")}, ${author}).`);
    if (asString(issue?.updated_at)) pushFact(facts, seen, `issue_updated(${repo}, ${number}, ${sanitizeStrictId(issue.updated_at)}).`);
    if (asString(issue?.closed_at)) pushFact(facts, seen, `issue_closed(${repo}, ${number}, ${sanitizeStrictId(issue.closed_at)}).`);

    for (const label of uniqueSorted(asArray(issue?.labels).map((entry) => asString(entry)))) {
      labelCount += 1;
      pushFact(facts, seen, `issue_label(${repo}, ${number}, ${sanitizeAtom(label)}).`);
      if (textLooksLikeBlocker(label)) pushFact(facts, seen, `issue_blocker(${repo}, ${number}, ${sanitizeStrictId(`label:${label}`)}).`);
    }

    const issueBodyDecision = textLooksLikeDecision(issue?.title) || textLooksLikeDecision(issue?.body);
    if (issueBodyDecision) {
      decisionCount += 1;
      pushFact(facts, seen, `issue_decision(${repo}, ${number}, ${sanitizeStrictId("issue_body")}).`);
      pushFact(facts, seen, `issue_decision_summary(${repo}, ${number}, ${sanitizeStrictId("issue_body")}, ${sanitizeAtom(issue?.title || issue?.body || "decision")}).`);
    }
    if (textLooksLikeBlocker(issue?.title) || textLooksLikeBlocker(issue?.body)) {
      pushFact(facts, seen, `issue_blocker(${repo}, ${number}, ${sanitizeStrictId("issue_body")}).`);
    }

    for (const [index, comment] of asArray(issue?.comments).entries()) {
      const id = commentId(comment, index);
      const commentAtom = sanitizeStrictId(id);
      const commentAuthor = sanitizeStrictId(comment?.author?.login || "unknown");
      commentCount += 1;
      pushFact(facts, seen, `issue_comment(${repo}, ${number}, ${commentAtom}, ${commentAuthor}).`);
      if (asString(comment?.created_at)) pushFact(facts, seen, `issue_comment_created(${repo}, ${number}, ${commentAtom}, ${sanitizeStrictId(comment.created_at)}).`);
      if (textLooksLikeDecision(comment?.body)) {
        decisionCount += 1;
        pushFact(facts, seen, `issue_decision(${repo}, ${number}, ${commentAtom}).`);
        pushFact(facts, seen, `issue_decision_summary(${repo}, ${number}, ${commentAtom}, ${sanitizeAtom(comment.body)}).`);
      }
      if (textLooksLikeBlocker(comment?.body)) {
        pushFact(facts, seen, `issue_blocker(${repo}, ${number}, ${commentAtom}).`);
      }
    }

    if (state === "closed" && issueHasBlockerSignal(issue)) {
      blockerResolutionCount += 1;
      const source = asString(issue?.closed_at) ? "issue_closed" : "state_closed";
      pushFact(facts, seen, `issue_blocker_resolved(${repo}, ${number}, ${sanitizeStrictId(source)}).`);
    }
  }

  return {
    facts,
    meta: {
      records: issues.length,
      labels: labelCount,
      comments: commentCount,
      decisions: decisionCount,
      blocker_resolutions: blockerResolutionCount,
    },
  };
}

export function collectIssueHistoryFactBundle({
  cwd = process.cwd(),
  cacheRoot = DEFAULT_CACHE_ROOT,
  cacheDir = null,
  includeTitles = true,
} = {}) {
  const cacheDirs = scanCacheDirs({ cwd, cacheRoot, cacheDir });
  const facts = [];
  const caches = [];
  const issues = [];
  const meta = {
    caches: 0,
    invalid_caches: 0,
    records: 0,
    labels: 0,
    comments: 0,
    decisions: 0,
    blocker_resolutions: 0,
  };

  for (const dir of cacheDirs) {
    const cache = loadVerifiedCache({ cwd, cacheDir: dir });
    const compiled = compileCacheFacts(cache, { includeTitles });
    facts.push(...compiled.facts);
    caches.push({
      cache_id: cache.cacheId,
      repo: cache.repo,
      cache_dir: compactPath(cwd, dir),
      status: cache.ok ? "valid" : "invalid",
      failures: cache.failures,
      records: compiled.meta.records,
    });
    meta.caches += 1;
    if (!cache.ok) meta.invalid_caches += 1;
    meta.records += compiled.meta.records;
    meta.labels += compiled.meta.labels;
    meta.comments += compiled.meta.comments;
    meta.decisions += compiled.meta.decisions;
    meta.blocker_resolutions += compiled.meta.blocker_resolutions;
  }

  return {
    ok: meta.invalid_caches === 0,
    status: meta.invalid_caches > 0 ? "WARN" : "PASS",
    cwd,
    cache_root: cacheRoot,
    cache_dir: cacheDir,
    facts,
    caches,
    meta,
    issues,
  };
}
