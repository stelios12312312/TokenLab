import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const DEFAULT_STALE_FETCH_DAYS = 3;
const DEFAULT_BUDGET_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CENSUS_CLASSES = new Set([
  "WHOLLY_UNMERGED",
  "MERGED_EQUIVALENT",
  "MERGED_THEN_REMOVED",
  "PARTIALLY_MERGED",
  "OBSOLETE",
]);

function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    args,
  };
}

function firstSuccessfulGit(cwd, candidates) {
  for (const args of candidates) {
    const result = runGit(cwd, args);
    if (result.ok && result.stdout.trim()) return { ...result, ref: args[2] || args[1] };
  }
  return null;
}

function parseRemoteRefs(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name, object, committedAt, subject] = line.split("\0");
      return {
        name: String(name || "").trim(),
        object: String(object || "").trim(),
        committed_at: String(committedAt || "").trim(),
        subject: String(subject || "").trim(),
      };
    })
    .filter((ref) => ref.name && !ref.name.endsWith("/HEAD"));
}

function fetchHeadStatus(cwd, gitDir, now, staleDays) {
  const absoluteGitDir = gitDir.startsWith("/") ? gitDir : resolve(cwd, gitDir);
  const fetchHeadPath = join(absoluteGitDir, "FETCH_HEAD");
  if (!existsSync(fetchHeadPath)) {
    return {
      status: "unknown",
      last_fetch_at: null,
      age_days: null,
      stale: true,
      message: "fetch timestamp unavailable; using local remote refs",
    };
  }
  try {
    const stat = statSync(fetchHeadPath);
    const lastFetch = stat.mtime;
    const ageDays = Math.max(0, Math.floor((now.getTime() - lastFetch.getTime()) / DAY_MS));
    return {
      status: ageDays > staleDays ? "stale" : "fresh",
      last_fetch_at: lastFetch.toISOString(),
      age_days: ageDays,
      stale: ageDays > staleDays,
      message: ageDays > staleDays
        ? `fetch state stale (${ageDays}d old); using local remote refs`
        : `fetch state fresh (${ageDays}d old); using local remote refs`,
    };
  } catch (error) {
    return {
      status: "error",
      last_fetch_at: null,
      age_days: null,
      stale: true,
      message: `fetch timestamp unreadable: ${error.message}`,
    };
  }
}

function readCensusClasses(cwd, censusPath) {
  const resolvedPath = censusPath ? resolve(cwd, censusPath) : join(cwd, "reports", "ive", "branch_census_2026-07.md");
  if (!existsSync(resolvedPath)) {
    return { status: "missing", path: resolvedPath, classes: new Map() };
  }
  try {
    const text = readFileSync(resolvedPath, "utf-8");
    const classes = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("| `")) continue;
      const branch = line.match(/^\|\s*`([^`]+)`/);
      const classMatch = line.match(/`\b(WHOLLY_UNMERGED|MERGED_EQUIVALENT|MERGED_THEN_REMOVED|PARTIALLY_MERGED|OBSOLETE)\b`/);
      if (branch && classMatch && CENSUS_CLASSES.has(classMatch[1])) {
        classes.set(branch[1], classMatch[1]);
      }
    }
    return { status: classes.size > 0 ? "loaded" : "empty", path: resolvedPath, classes };
  } catch (error) {
    return { status: "error", path: resolvedPath, error: error.message, classes: new Map() };
  }
}

function severityForAge(ageDays) {
  if (ageDays === null || ageDays === undefined) return "unknown";
  if (ageDays > 21) return "loud";
  if (ageDays >= 7) return "warning";
  return "advisory";
}

function maxSeverity(rows) {
  if (rows.some((row) => row.severity === "loud")) return "loud";
  if (rows.some((row) => row.severity === "warning")) return "warning";
  if (rows.some((row) => row.severity === "advisory")) return "advisory";
  return "clean";
}

function inspectCommand(mainRef, branchName) {
  return `git log ${mainRef}..${branchName} --oneline`;
}

function actCommand(branchName) {
  return `rg -n '${branchName.replace(/^origin\//, "")}' reports/ive/branch_census_2026-07.md`;
}

export function collectBranchDrift({
  cwd = process.cwd(),
  now = new Date(),
  staleDays = DEFAULT_STALE_FETCH_DAYS,
  budgetMs = DEFAULT_BUDGET_MS,
  censusPath = null,
  mainRef = null,
  fixedElapsedMs = null,
} = {}) {
  const started = Date.now();
  const currentNow = asDate(now);
  const rootCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  const base = {
    ok: true,
    as_of: currentNow.toISOString(),
    cwd: resolve(cwd),
    budget_ms: Number(budgetMs),
    elapsed_ms: 0,
    elapsed_mode: fixedElapsedMs === null || fixedElapsedMs === undefined ? "measured" : "fixed_for_determinism",
    over_budget: false,
    status: "unknown",
    message: "",
    main_ref: null,
    fetch: null,
    census: null,
    branch_count: 0,
    drift_count: 0,
    severity: "clean",
    rows: [],
  };

  const finish = (payload) => {
    const elapsed = fixedElapsedMs === null || fixedElapsedMs === undefined
      ? Date.now() - started
      : Number(fixedElapsedMs);
    const next = {
      ...base,
      ...payload,
      elapsed_ms: elapsed,
    };
    next.over_budget = Number.isFinite(Number(next.budget_ms)) && elapsed > Number(next.budget_ms);
    return next;
  };

  if (!rootCheck.ok || rootCheck.stdout.trim() !== "true") {
    return finish({
      ok: false,
      status: "not_git_repo",
      message: "not a Git work tree; branch drift unavailable",
    });
  }

  const gitDirResult = runGit(cwd, ["rev-parse", "--git-dir"]);
  const fetch = gitDirResult.ok
    ? fetchHeadStatus(cwd, gitDirResult.stdout.trim(), currentNow, Number(staleDays))
    : { status: "unknown", stale: true, message: "git dir unavailable; using local remote refs" };
  const census = readCensusClasses(cwd, censusPath);

  const mainCandidates = mainRef
    ? [["rev-parse", "--verify", mainRef]]
    : [
        ["rev-parse", "--verify", "main"],
        ["rev-parse", "--verify", "origin/main"],
        ["rev-parse", "--verify", "refs/remotes/origin/main"],
      ];
  const main = firstSuccessfulGit(cwd, mainCandidates);
  if (!main) {
    return finish({
      ok: false,
      status: "missing_main_ref",
      message: "main comparison ref missing; branch drift unavailable",
      fetch,
      census: { status: census.status, path: census.path, error: census.error || null },
    });
  }
  const resolvedMainRef = mainRef || (main.ref === "refs/remotes/origin/main" ? "origin/main" : main.ref);
  const mainObject = main.stdout.trim();

  const refsResult = runGit(cwd, [
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(committerdate:iso8601)%00%(subject)",
    "refs/remotes",
  ]);
  if (!refsResult.ok) {
    return finish({
      ok: false,
      status: "remote_ref_error",
      message: refsResult.stderr.trim() || "remote refs could not be read",
      main_ref: resolvedMainRef,
      fetch,
      census: { status: census.status, path: census.path, error: census.error || null },
    });
  }

  const allRemoteRefs = parseRemoteRefs(refsResult.stdout);
  const remoteRefs = allRemoteRefs
    .filter((ref) => ref.name !== "origin/main")
    .filter((ref) => ref.object !== mainObject || !/\/main$/.test(ref.name));

  if (allRemoteRefs.length === 0) {
    return finish({
      status: "no_remote_refs",
      message: "no remote-tracking branch refs found",
      main_ref: resolvedMainRef,
      fetch,
      census: { status: census.status, path: census.path, error: census.error || null },
    });
  }

  const rows = [];
  for (const ref of remoteRefs) {
    const aheadResult = runGit(cwd, ["rev-list", "--count", `${resolvedMainRef}..${ref.name}`]);
    const ahead = aheadResult.ok ? Number(aheadResult.stdout.trim()) : null;
    if (!Number.isFinite(ahead) || ahead <= 0) continue;
    const committedAt = asDate(ref.committed_at);
    const ageDays = Number.isNaN(committedAt.getTime())
      ? null
      : Math.max(0, Math.floor((currentNow.getTime() - committedAt.getTime()) / DAY_MS));
    rows.push({
      branch: ref.name,
      tip: ref.object.slice(0, 10),
      subject: ref.subject,
      ahead,
      tip_age_days: ageDays,
      severity: severityForAge(ageDays),
      census_class: census.classes.get(ref.name) || "unknown",
      inspect_command: inspectCommand(resolvedMainRef, ref.name),
      act_command: actCommand(ref.name),
    });
  }
  rows.sort((a, b) => {
    const severityRank = { loud: 3, warning: 2, advisory: 1, unknown: 0 };
    return (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0)
      || (b.tip_age_days || 0) - (a.tip_age_days || 0)
      || b.ahead - a.ahead
      || a.branch.localeCompare(b.branch);
  });

  return finish({
    status: rows.length > 0 ? "drift" : "clean",
    message: rows.length > 0
      ? `${rows.length} remote branch(es) carry commits not in ${resolvedMainRef}`
      : `0 remote branch(es) carry commits not in ${resolvedMainRef}`,
    main_ref: resolvedMainRef,
    fetch,
    census: { status: census.status, path: census.path, error: census.error || null },
    branch_count: remoteRefs.length,
    drift_count: rows.length,
    severity: maxSeverity(rows),
    rows,
  });
}

function ageLabel(days) {
  return days === null || days === undefined ? "unknown" : `${days}d`;
}

function severityLabel(severity) {
  if (severity === "loud") return "LOUD";
  if (severity === "warning") return "WARN";
  if (severity === "advisory") return "ADVISORY";
  return "UNKNOWN";
}

export function renderBranchDriftStatus(report, { maxRows = 30 } = {}) {
  if (!report || typeof report !== "object") return "";
  const lines = [];
  if (report.status === "not_git_repo") {
    return "Branch drift: unavailable - not a Git work tree.";
  }
  if (report.status === "missing_main_ref") {
    return "Branch drift: unavailable - main comparison ref missing.";
  }
  if (report.status === "remote_ref_error") {
    return `Branch drift: unavailable - ${report.message || "remote refs could not be read"}.`;
  }
  if (report.status === "no_remote_refs") {
    lines.push("Branch drift: empty - no remote-tracking branch refs found.");
  } else if (report.status === "clean") {
    lines.push(`Branch drift: clean - ${report.message}.`);
  } else if (report.status === "drift") {
    const banner = report.severity === "loud" ? "LOUD" : report.severity === "warning" ? "WARN" : "ADVISORY";
    lines.push(`Branch drift: ${banner} - ${report.message}.`);
    lines.push("  Severity is advisory-only; branch drift does not block planner gates.");
    lines.push("  Branch | Ahead | Age | Severity | R1 class | Next");
    for (const row of report.rows.slice(0, maxRows)) {
      lines.push(`  ${row.branch} | ${row.ahead} | ${ageLabel(row.tip_age_days)} | ${severityLabel(row.severity)} | ${row.census_class} | Inspect: ${row.inspect_command}`);
      lines.push(`    Act: ${row.act_command}`);
    }
    if (report.rows.length > maxRows) {
      lines.push(`  ... ${report.rows.length - maxRows} more branch row(s) omitted from status output; run branch_drift_probe.mjs --json for the full set.`);
    }
  } else {
    lines.push(`Branch drift: unavailable - ${report.message || "unknown status"}.`);
  }

  if (report.fetch?.message) lines.push(`  ${report.fetch.message}.`);
  if (report.census?.status && report.census.status !== "loaded") {
    lines.push(`  R1 census: ${report.census.status}; rows use census class unknown when needed.`);
  }
  lines.push(`  Probe: ${report.elapsed_ms}ms/${report.budget_ms}ms${report.over_budget ? " (over budget)" : ""}.`);
  return lines.join("\n");
}
