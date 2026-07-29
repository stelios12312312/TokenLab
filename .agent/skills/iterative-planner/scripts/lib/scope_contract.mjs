// scope_contract.mjs — Separate declared task scope from ambient dirty worktree state.

import { createHash } from "crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { extractFilesToModify } from "./plan_utils.mjs";

export const SCOPE_CONTRACT_FILENAME = "scope.json";
export const AMBIENT_DIRTY_SCOPE_HEADING = "Ambient Dirty Scope";
export const LARGE_AMBIENT_DIRTY_THRESHOLD = 20;

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
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function computeFingerprint(contract) {
  const payload = JSON.stringify({
    declared_files: contract.declared_files,
    observed_dirty_files_at_start: contract.observed_dirty_files_at_start,
    owned_files: contract.owned_files,
    ambient_dirty_files: contract.ambient_dirty_files,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export function buildScopeContract({ cwd = process.cwd(), planDir, planContent = "", now = new Date().toISOString() } = {}) {
  const existing = planDir ? readScopeContract(planDir) : null;
  const declared = uniqueSorted(extractFilesToModify(planContent));
  const observedDirty = existing?.observed_dirty_files_at_start
    ? uniqueSorted(existing.observed_dirty_files_at_start)
    : listObservedDirtyFiles(cwd);
  const owned = declared;
  const ownedSet = new Set(owned);
  const ambient = observedDirty.filter((file) => !ownedSet.has(file));
  const overlap = observedDirty.filter((file) => ownedSet.has(file));
  const contract = {
    version: 1,
    generated_at: existing?.generated_at || now,
    updated_at: now,
    declared_files: declared,
    observed_dirty_files_at_start: observedDirty,
    owned_files: owned,
    ambient_dirty_files: ambient,
    summary: {
      declared_count: declared.length,
      observed_dirty_count: observedDirty.length,
      overlap_count: overlap.length,
      ambient_count: ambient.length,
      large_ambient_dirty: ambient.length >= LARGE_AMBIENT_DIRTY_THRESHOLD && declared.length > 0,
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
