import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildOntologyFacts } from "./ontology_fact_builder.mjs";
import { ONTOLOGY_ENTITY_CLASSES, getOntologyCompiledFactPath, getOntologyFactPath } from "./ontology_schema.mjs";

export const PROJECT_ONTOLOGY_RECEIPT = ".agent/ontology/provisioning_receipt.json";

export function formatProjectOntologyProvisioning(receipt) {
  if (receipt?.ok) {
    const verbs = {
      would_change: "WOULD UPDATE",
      updated: "UPDATED",
      current: "OK",
    };
    const verb = verbs[receipt.status];
    const digest = receipt.authority?.source_digest || "digest unavailable";
    return [
      `  ${verb}: project-owned canonical ontology (${digest})`,
      `  RECEIPT: ${PROJECT_ONTOLOGY_RECEIPT}`,
    ];
  }
  const rollback = receipt?.rolled_back ? "; prior canonical bytes restored" : "";
  return [
    `  ❌ Project ontology provisioning failed${rollback}`,
    ...(receipt?.issues || []).map((issue) => `     - ${issue}`),
  ];
}

export function mergeProjectOntologyExitCode(currentExitCode, receipt) {
  return receipt?.ok ? currentExitCode : 1;
}

export function formatProjectSetupCompletion(ok) {
  return ok
    ? `\n  ══ SETUP COMPLETE ══`
    : `\n  ══ SETUP FAILED — PRIOR ONTOLOGY BYTES RESTORED ══`;
}

function governedPaths(cwd) {
  return [
    ...ONTOLOGY_ENTITY_CLASSES.map((entityClass) => getOntologyFactPath(entityClass, cwd)),
    getOntologyCompiledFactPath(cwd),
  ];
}

export function projectOntologyPresent(cwd = process.cwd()) {
  return governedPaths(cwd).some((path) => existsSync(path));
}

function snapshot(paths) {
  return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
}

function restore(snapshots) {
  for (const [path, bytes] of snapshots) {
    if (bytes === null) {
      if (existsSync(path)) unlinkSync(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

function snapshotChanged(before, after) {
  for (const [path, bytes] of before) {
    const next = after.get(path);
    if (bytes === null || next === null) {
      if (bytes !== next) return true;
    } else if (!bytes.equals(next)) return true;
  }
  return false;
}

function writeReceipt(cwd, receipt) {
  const path = join(cwd, PROJECT_ONTOLOGY_RECEIPT);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temp, path);
}

function exclusionSummary(cwd) {
  const path = join(cwd, ".agent/ontology/exclusions.json");
  if (!existsSync(path)) return { path: ".agent/ontology/exclusions.json", present: false, count: 0 };
  try {
    const document = JSON.parse(readFileSync(path, "utf8"));
    const count = Object.values(document.exclusions || {}).reduce(
      (sum, identities) => sum + (Array.isArray(identities) ? identities.length : 0),
      0,
    );
    return { path: ".agent/ontology/exclusions.json", present: true, count };
  } catch {
    return { path: ".agent/ontology/exclusions.json", present: true, count: null };
  }
}

export function provisionProjectOntology({ cwd = process.cwd(), dryRun = false, buildFacts = buildOntologyFacts } = {}) {
  const paths = governedPaths(cwd);
  const before = snapshot(paths);
  const base = {
    schema_version: 1,
    operation: "project_ontology_provisioning",
    cwd,
    dry_run: dryRun,
    generated_at: new Date().toISOString(),
  };
  let dryRunRolledBack = false;
  try {
    const result = buildFacts({ cwd, induce: true, incremental: true, dryRun, projectionProfile: "full" });
    if (!result?.ok) throw new Error((result?.issues || ["ontology build failed"]).join("; "));
    if (dryRun && snapshotChanged(before, snapshot(paths))) {
      restore(before);
      dryRunRolledBack = true;
      throw new Error("dry-run publisher mutated governed ontology bytes; changes were restored");
    }
    const changed = Boolean((result.changed_fact_documents || []).length || result.changed_generated_facts);
    const receipt = {
      ...base,
      ok: true,
      status: dryRun && changed ? "would_change" : changed ? "updated" : "current",
      changed,
      no_change: !changed,
      rolled_back: false,
      changed_fact_documents: result.changed_fact_documents || [],
      wrote_fact_documents: result.wrote_fact_documents || [],
      wrote_generated_facts: Boolean(result.wrote_generated_facts),
      counts: result.counts || null,
      warnings: result.warnings || [],
      degraded_coverage: Boolean((result.warnings || []).length),
      exclusions: exclusionSummary(cwd),
      freshness: {
        canonical_yaml: "current",
        compiled_projection: dryRun && changed ? "would_refresh" : "current",
      },
      authority: result.authority_receipt || null,
    };
    if (!dryRun) writeReceipt(cwd, receipt);
    return receipt;
  } catch (error) {
    if (!dryRun) restore(before);
    const receipt = {
      ...base,
      ok: false,
      status: "failed",
      changed: false,
      no_change: false,
      rolled_back: !dryRun || dryRunRolledBack,
      degraded_coverage: true,
      exclusions: exclusionSummary(cwd),
      freshness: { canonical_yaml: "restored", compiled_projection: "restored" },
      issues: [error instanceof Error ? error.message : String(error)],
    };
    if (!dryRun) writeReceipt(cwd, receipt);
    return receipt;
  }
}
