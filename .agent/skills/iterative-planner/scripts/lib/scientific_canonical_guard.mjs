// scientific_canonical_guard.mjs — hash-tree protection for canonical evidence.
// @planner:module = scientific_canonical_guard
// @planner:capability = canonical_scientific_evidence_immutability_guard
// @planner:story = US-003
// @planner:proves = crit:sc_4

import { existsSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";

import { isWithin, sha256File } from "./scientific_contract.mjs";

export function snapshotCanonicalEvidence(root) {
  const absoluteRoot = resolve(root);
  const files = {};
  if (!existsSync(absoluteRoot)) return { root: absoluteRoot, exists: false, files };
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files[relative(absoluteRoot, path)] = sha256File(path);
    }
  };
  visit(absoluteRoot);
  return { root: absoluteRoot, exists: true, files };
}

export function compareCanonicalEvidence(before, after) {
  const keys = [...new Set([...Object.keys(before?.files || {}), ...Object.keys(after?.files || {})])].sort();
  const changes = keys.flatMap((path) => {
    const left = before?.files?.[path];
    const right = after?.files?.[path];
    if (left === right) return [];
    return [{ path, change: left === undefined ? "created" : right === undefined ? "removed" : "hash_changed", before: left || null, after: right || null }];
  });
  if (before?.exists !== after?.exists) changes.unshift({ path: ".", change: "root_presence_changed", before: before?.exists, after: after?.exists });
  return { unchanged: changes.length === 0, changes };
}

export function outputTargetsCanonicalEvidence({ canonicalRoot, outputRoot }) {
  return Boolean(canonicalRoot && outputRoot && isWithin(canonicalRoot, outputRoot));
}
