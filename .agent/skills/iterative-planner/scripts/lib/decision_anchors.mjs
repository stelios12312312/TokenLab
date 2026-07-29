// decision_anchors.mjs - Journal-backed decision anchor audit and projections.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { JOURNAL_REL_PATH, loadJournal } from "./agent_journal.mjs";

const ACTIVE_STATUSES = new Set(["accepted", "promoted"]);
const RETIRED_STATUSES = new Set(["retired"]);
const DEFAULT_INCLUDE_STATUSES = ["accepted", "promoted"];
const MARKER_RE = /\bDECISION\s+(\[STALE\]\s+)?([A-Za-z0-9_./:@-]+:D-[A-Za-z0-9_-]+)\b/g;
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".pl", ".sh", ".txt", ".yaml", ".yml",
]);
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "reports",
  "plans",
]);
const EXCLUDED_PATH_PARTS = [
  `${sep}.agent${sep}skills${sep}iterative-planner${sep}tests${sep}`,
  `${sep}apps${sep}ive-visualizer${sep}tests${sep}`,
];

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asList(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(source.map(asString).filter(Boolean))];
}

function asStatusSet(value = DEFAULT_INCLUDE_STATUSES) {
  return new Set(asList(value).map((item) => item.toLowerCase()));
}

function normalizeRelPath(cwd, pathValue) {
  const raw = asString(pathValue);
  if (!raw) return "";
  const absolute = resolve(cwd, raw);
  const rel = relative(cwd, absolute).split(sep).join("/");
  if (!rel || rel.startsWith("..") || rel === ".") return "";
  return rel;
}

function extensionFor(pathValue) {
  const match = String(pathValue || "").match(/(\.[A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function shouldSkipDir(name) {
  return EXCLUDED_DIRS.has(name);
}

function shouldSkipFile(cwd, absolutePath) {
  const rel = relative(cwd, absolutePath);
  const normalized = absolutePath.split(sep).join(sep);
  if (EXCLUDED_PATH_PARTS.some((part) => normalized.includes(part))) return true;
  if (rel.startsWith("..")) return true;
  const ext = extensionFor(absolutePath);
  return ext && !TEXT_EXTENSIONS.has(ext);
}

function walkFiles(cwd, dir = cwd, files = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".agent") {
      if (shouldSkipDir(entry.name)) continue;
    }
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walkFiles(cwd, absolute, files);
    } else if (entry.isFile() && !shouldSkipFile(cwd, absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

function readTextFile(path) {
  try {
    const stat = statSync(path);
    if (stat.size > 1024 * 1024) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function markerObjectsForContent(content, relPath) {
  const markers = [];
  const text = String(content || "");
  MARKER_RE.lastIndex = 0;
  let match;
  while ((match = MARKER_RE.exec(text))) {
    markers.push({
      anchor_id: match[2],
      stale: Boolean(match[1]),
      path: relPath,
      index: match.index,
      marker: match[0],
    });
  }
  return markers;
}

function stripFencedCodeBlocks(content) {
  return String(content || "").replace(/```[\s\S]*?```/g, "");
}

export function findDecisionAnchorMarkers({ cwd = process.cwd() } = {}) {
  const root = resolve(cwd);
  const markers = [];
  for (const absolutePath of walkFiles(root)) {
    const content = readTextFile(absolutePath);
    if (content === null) continue;
    const relPath = relative(root, absolutePath).split(sep).join("/");
    const scanContent = relPath.endsWith(".md") ? stripFencedCodeBlocks(content) : content;
    markers.push(...markerObjectsForContent(scanContent, relPath));
  }
  return markers;
}

function payloadString(payload, ...keys) {
  if (!payload || typeof payload !== "object") return "";
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return "";
}

function deriveDecisionId(anchorId) {
  const match = asString(anchorId).match(/(?:^|:)(D-[A-Za-z0-9_-]+)$/);
  return match ? match[1] : "";
}

export function decisionAnchorFromEntry(entry, { cwd = process.cwd() } = {}) {
  if (!entry || entry.memory_role !== "decision_anchor") return null;
  const payload = entry.payload || {};
  const anchorId = payloadString(payload, "anchor_id", "anchorId", "id") || entry.keys?.[0] || "";
  const decisionId = payloadString(payload, "decision_id", "decisionId") || deriveDecisionId(anchorId);
  const planId = payloadString(payload, "plan_id", "planId") || anchorId.split(":")[0] || "";
  const relPath = normalizeRelPath(cwd, payloadString(payload, "path", "file", "target_path", "targetPath"));
  const status = ACTIVE_STATUSES.has(entry.status)
    ? "active"
    : RETIRED_STATUSES.has(entry.status)
      ? "retired"
      : entry.status;

  return {
    anchor_id: anchorId,
    journal_entry_id: entry.id,
    plan_id: planId,
    decision_id: decisionId,
    path: relPath,
    status,
    journal_status: entry.status,
    summary: entry.summary,
    refs: entry.refs || [],
    source_entries: entry.source_entries || [],
  };
}

export function loadDecisionAnchors({ cwd = process.cwd(), path } = {}) {
  const journal = loadJournal({ cwd, path });
  const anchors = journal.entries
    .map((entry) => decisionAnchorFromEntry(entry, { cwd }))
    .filter(Boolean);
  return { ...journal, anchors };
}

function issue(code, detail = {}) {
  return { code, ...detail };
}

export function auditDecisionAnchors({ cwd = process.cwd(), path } = {}) {
  const root = resolve(cwd);
  const loaded = loadDecisionAnchors({ cwd: root, path });
  const markers = findDecisionAnchorMarkers({ cwd: root });
  const markersById = new Map();
  for (const marker of markers) {
    if (!markersById.has(marker.anchor_id)) markersById.set(marker.anchor_id, []);
    markersById.get(marker.anchor_id).push(marker);
  }

  const activeAnchors = loaded.anchors.filter((anchor) => anchor.status === "active");
  const retiredAnchors = loaded.anchors.filter((anchor) => anchor.status === "retired");
  const knownAnchorIds = new Set(loaded.anchors.map((anchor) => anchor.anchor_id).filter(Boolean));
  const issues = [];

  for (const anchor of loaded.anchors) {
    if (!anchor.anchor_id) {
      issues.push(issue("decision_anchor_missing_anchor_id", { journal_entry_id: anchor.journal_entry_id }));
    }
    if (!anchor.plan_id) {
      issues.push(issue("decision_anchor_missing_plan_id", { anchor_id: anchor.anchor_id, journal_entry_id: anchor.journal_entry_id }));
    }
    if (!anchor.decision_id) {
      issues.push(issue("decision_anchor_missing_decision_id", { anchor_id: anchor.anchor_id, journal_entry_id: anchor.journal_entry_id }));
    }
    if (anchor.status === "active" && !anchor.path) {
      issues.push(issue("decision_anchor_missing_path", { anchor_id: anchor.anchor_id, journal_entry_id: anchor.journal_entry_id }));
    }
  }

  for (const anchor of activeAnchors) {
    if (!anchor.anchor_id || !anchor.path) continue;
    const absolutePath = resolve(root, anchor.path);
    if (!absolutePath.startsWith(`${root}${sep}`) && absolutePath !== root) {
      issues.push(issue("active_anchor_path_outside_repo", { anchor_id: anchor.anchor_id, path: anchor.path }));
      continue;
    }
    if (!existsSync(absolutePath)) {
      issues.push(issue("active_anchor_file_missing", { anchor_id: anchor.anchor_id, path: anchor.path }));
      continue;
    }
    const fileMarkers = (markersById.get(anchor.anchor_id) || []).filter((marker) => marker.path === anchor.path);
    if (fileMarkers.length === 0) {
      issues.push(issue("active_anchor_marker_missing", { anchor_id: anchor.anchor_id, path: anchor.path }));
      continue;
    }
    if (!fileMarkers.some((marker) => !marker.stale)) {
      issues.push(issue("active_anchor_marker_stale", { anchor_id: anchor.anchor_id, path: anchor.path }));
    }
  }

  const orphanMarkers = [];
  const staleOrphanMarkers = [];
  for (const marker of markers) {
    if (knownAnchorIds.has(marker.anchor_id)) continue;
    if (marker.stale) {
      staleOrphanMarkers.push(marker);
    } else {
      orphanMarkers.push(marker);
      issues.push(issue("orphan_decision_anchor_marker", {
        anchor_id: marker.anchor_id,
        path: marker.path,
      }));
    }
  }

  return {
    ok: issues.length === 0 && loaded.issues.length === 0,
    journal_path: loaded.path,
    journal_issue_count: loaded.issues.length,
    journal_issues: loaded.issues,
    issues,
    anchors: loaded.anchors,
    markers,
    summary: {
      active_anchor_count: activeAnchors.length,
      retired_anchor_count: retiredAnchors.length,
      marker_count: markers.length,
      orphan_marker_count: orphanMarkers.length,
      stale_orphan_marker_count: staleOrphanMarkers.length,
    },
  };
}

export function retireOrphanDecisionAnchors({ cwd = process.cwd(), path, write = false } = {}) {
  const root = resolve(cwd);
  const audit = auditDecisionAnchors({ cwd: root, path });
  const orphanIssues = audit.issues.filter((item) => item.code === "orphan_decision_anchor_marker");
  const byPath = new Map();
  for (const item of orphanIssues) {
    if (!byPath.has(item.path)) byPath.set(item.path, []);
    byPath.get(item.path).push(item.anchor_id);
  }

  const changes = [];
  const changedFiles = [];
  for (const [relPath, anchorIds] of byPath.entries()) {
    const absolutePath = resolve(root, relPath);
    const original = readTextFile(absolutePath);
    if (original === null) continue;
    let next = original;
    for (const anchorId of anchorIds) {
      const escaped = anchorId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      next = next.replace(new RegExp(`\\bDECISION\\s+(${escaped})\\b`, "g"), `DECISION [STALE] $1`);
    }
    if (next !== original) {
      changes.push({ path: relPath, anchor_ids: [...new Set(anchorIds)].sort() });
      changedFiles.push(relPath);
      if (write) writeFileSync(absolutePath, next);
    }
  }

  return {
    ok: true,
    write: Boolean(write),
    changed_files: [...new Set(changedFiles)].sort(),
    changes,
    issue_count: orphanIssues.length,
  };
}

function provenanceForEntry(entry) {
  const parts = [`journal:${entry.id}`];
  for (const ref of entry.refs || []) parts.push(`ref:${ref}`);
  for (const source of entry.source_entries || []) parts.push(`source:${source}`);
  for (const target of entry.promoted_to || []) parts.push(`promoted_to:${target}`);
  return parts.join(", ");
}

function fitToLineCap(lines, maxLines, omittedCount) {
  if (lines.length <= maxLines) return lines;
  const truncatedLine = `- Truncated at ${maxLines} lines; ${omittedCount} entr${omittedCount === 1 ? "y" : "ies"} omitted.`;
  if (maxLines <= 0) return [];
  const clipped = lines.slice(0, maxLines);
  clipped[maxLines - 1] = truncatedLine;
  return clipped;
}

export function projectJournalEntries({
  cwd = process.cwd(),
  path,
  maxLines = 80,
  title = "Knowledge Projection",
  includeStatuses = DEFAULT_INCLUDE_STATUSES,
} = {}) {
  const cap = Number(maxLines);
  if (!Number.isInteger(cap) || cap < 4) {
    return { ok: false, error: "invalid_max_lines", detail: "maxLines must be an integer >= 4" };
  }

  const journal = loadJournal({ cwd, path });
  const statuses = asStatusSet(includeStatuses);
  const entries = journal.entries.filter((entry) => statuses.has(entry.status));
  const lines = [
    `# ${asString(title) || "Knowledge Projection"}`,
    `> Generated from ${JOURNAL_REL_PATH}; journal remains authoritative.`,
    "",
  ];
  let rendered = 0;
  for (const entry of entries) {
    const line = `- ${entry.id} [${entry.status}/${entry.type}/${entry.confidence}] ${entry.summary} (provenance: ${provenanceForEntry(entry)})`;
    if (lines.length + 1 > cap) break;
    lines.push(line);
    rendered += 1;
  }
  const omitted = Math.max(0, entries.length - rendered);
  if (omitted > 0) {
    if (lines.length < cap) {
      lines.push(`- Truncated at ${cap} lines; ${omitted} entr${omitted === 1 ? "y" : "ies"} omitted.`);
    } else {
      lines[cap - 1] = `- Truncated at ${cap} lines; ${omitted} entr${omitted === 1 ? "y" : "ies"} omitted.`;
    }
  }
  const capped = fitToLineCap(lines, cap, omitted);
  return {
    ok: true,
    source_path: path || join(cwd, JOURNAL_REL_PATH),
    entry_count: entries.length,
    rendered_count: rendered,
    omitted_count: omitted,
    line_count: capped.length,
    markdown: `${capped.join("\n")}\n`,
    issues: journal.issues,
  };
}

export function writeJournalProjection({ outputPath, ...options } = {}) {
  const projected = projectJournalEntries(options);
  if (!projected.ok) return projected;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, projected.markdown);
  }
  return { ...projected, output_path: outputPath || null };
}
