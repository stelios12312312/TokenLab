// scope_contract.mjs — Separate declared task scope from ambient dirty worktree state.

import { createHash } from "crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { extractFilesToModify } from "./plan_utils.mjs";

export const SCOPE_CONTRACT_FILENAME = "scope.json";
export const AMBIENT_DIRTY_SCOPE_HEADING = "Ambient Dirty Scope";
export const LARGE_AMBIENT_DIRTY_THRESHOLD = 20;
export const AMBIENT_SCOPE_SAMPLE_LIMIT = 20;

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizePath).filter(Boolean))].sort();
}

function parsePorcelainStatus(text) {
  const files = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let file = line.slice(3).trim();
    if (file.includes(" -> ")) file = file.split(" -> ").pop().trim();
    if (file) files.push(file);
  }
  return uniqueSorted(files);
}

export function listObservedDirtyFiles(cwd = process.cwd()) {
  try {
    const proc = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        XDG_CONFIG_HOME: "/dev/null",
      },
    });
    if (proc.status !== 0) return [];
    return parsePorcelainStatus(proc.stdout || "");
  } catch {
    return [];
  }
}

function scopePath(planDir) {
  return join(planDir, SCOPE_CONTRACT_FILENAME);
}

export function readScopeContract(planDir) {
  const path = scopePath(planDir);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    // Compatibility projection: legacy consumers may still ask for the old
    // arrays. New persisted contracts remain bounded; readers receive only the
    // exact overlap plus the declared deterministic ambient sample.
    if (Number(parsed.version) >= 2 && parsed.ambient_scope) {
      parsed.ambient_dirty_files = uniqueSorted(parsed.ambient_scope.sample);
      parsed.observed_dirty_files_at_start = uniqueSorted([
        ...(parsed.overlap_files || []),
        ...parsed.ambient_dirty_files,
      ]);
    }
    return parsed;
  } catch {
    return null;
  }
}

function computeFingerprint(contract) {
  const payload = JSON.stringify({
    declared_files: contract.declared_files,
    owned_files: contract.owned_files,
    overlap_files: contract.overlap_files,
    ambient_scope: contract.ambient_scope,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function digestPaths(paths) {
  return createHash("sha256").update(uniqueSorted(paths).join("\0")).digest("hex");
}

function topLevelCounts(paths) {
  const counts = {};
  for (const path of uniqueSorted(paths)) {
    const top = path.split("/")[0] || ".";
    counts[top] = (counts[top] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function compactAmbientScope(paths) {
  const sorted = uniqueSorted(paths);
  return {
    count: sorted.length,
    digest: digestPaths(sorted),
    top_level_counts: topLevelCounts(sorted),
    sample: sorted.slice(0, AMBIENT_SCOPE_SAMPLE_LIMIT),
    sample_limit: AMBIENT_SCOPE_SAMPLE_LIMIT,
    truncated: sorted.length > AMBIENT_SCOPE_SAMPLE_LIMIT,
  };
}

export function buildScopeContract({ cwd = process.cwd(), planDir, planContent = "", now = new Date().toISOString() } = {}) {
  const existing = planDir ? readScopeContract(planDir) : null;
  const declared = uniqueSorted(extractFilesToModify(planContent));
  const observedDirty = existing && Number(existing.version) < 2 && existing?.observed_dirty_files_at_start
    ? uniqueSorted(existing.observed_dirty_files_at_start)
    : listObservedDirtyFiles(cwd);
  const owned = declared;
  const ownedSet = new Set(owned);
  const ambient = observedDirty.filter((file) => !ownedSet.has(file));
  const overlap = observedDirty.filter((file) => ownedSet.has(file));
  const ambientScope = existing && Number(existing.version) >= 2 && existing.ambient_scope
    ? {
        ...existing.ambient_scope,
        sample: uniqueSorted(existing.ambient_scope.sample).slice(0, AMBIENT_SCOPE_SAMPLE_LIMIT),
        sample_limit: AMBIENT_SCOPE_SAMPLE_LIMIT,
      }
    : compactAmbientScope(ambient);
  const contract = {
    version: 2,
    generated_at: existing?.generated_at || now,
    updated_at: now,
    declared_files: declared,
    owned_files: owned,
    overlap_files: overlap,
    ambient_scope: ambientScope,
    summary: {
      declared_count: declared.length,
      observed_dirty_count: overlap.length + ambientScope.count,
      overlap_count: overlap.length,
      ambient_count: ambientScope.count,
      large_ambient_dirty: ambientScope.count >= LARGE_AMBIENT_DIRTY_THRESHOLD && declared.length > 0,
    },
  };
  contract.fingerprint = computeFingerprint(contract);
  return contract;
}

export function writeScopeContract({ cwd = process.cwd(), planDir, planContent = "" } = {}) {
  if (!planDir) return null;
  const contract = buildScopeContract({ cwd, planDir, planContent });
  const path = scopePath(planDir);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(contract, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return contract;
}

export function planHasAmbientDirtyScopeAcknowledgement(planContent) {
  const heading = String(AMBIENT_DIRTY_SCOPE_HEADING).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionMatch = String(planContent || "").match(new RegExp(`^##\\s+${heading}\\s*$\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`, "im"));
  if (!sectionMatch) return false;
  return /unowned changes exist/i.test(sectionMatch[1]) && /not part of this plan/i.test(sectionMatch[1]);
}

export function summarizeScopeContract(contract) {
  const summary = contract?.summary || {};
  return [
    `declared files: ${summary.declared_count || 0}`,
    `observed dirty files: ${summary.observed_dirty_count || 0}`,
    `overlap: ${summary.overlap_count || 0}`,
    `ambient: ${summary.ambient_count || 0}`,
  ].join(", ");
}

export function scopeContractRequiresAmbientAcknowledgement(contract) {
  return contract?.summary?.large_ambient_dirty === true;
}
