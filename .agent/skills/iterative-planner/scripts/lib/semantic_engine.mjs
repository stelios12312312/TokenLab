// @planner:module = semantic_engine
// @planner:capability = unified_semantic_ontology_engine

import { join } from "path";

import { getRuleBundleVersion, hashRuleFiles } from "./determinism.mjs";
import { refreshPlanArtifacts } from "./plan_refresh.mjs";
import { createDiagnosticsSession } from "./semantic_substrate.mjs";

export function createSemanticEngine({
  cwd = process.cwd(),
  skillPath,
  refreshOntology = true,
  transientCloseSignals = null,
  transientOntologyFacts = "",
  transientRegistryRefresh = false,
  ontologyProjectionProfile = "full",
  queryTimeoutMs = 3000,
  semanticEngine = null,
} = {}) {
  if (semanticEngine) {
    return semanticEngine;
  }

  const ctx = { cwd, skillPath, transientRegistryRefresh };
  let refresh = null;
  const hasProvidedCloseSignals = transientCloseSignals && typeof transientCloseSignals === "object";
  const hasProvidedOntologyFacts =
    typeof transientOntologyFacts === "string" && transientOntologyFacts.trim().length > 0;

  if (refreshOntology && !hasProvidedCloseSignals && !hasProvidedOntologyFacts) {
    try {
      refresh = refreshPlanArtifacts({
        cwd,
        skillPath,
        refreshOntology: true,
        persistOntology: false,
        persistState: false,
        syncFindings: false,
      });
    } catch {
      // Best-effort refresh — fall back to on-disk artifacts if refresh fails.
    }
  }

  ctx.transientCloseSignals = hasProvidedCloseSignals ? transientCloseSignals : (refresh?.closeSignals || null);
  ctx.transientOntologyFacts = hasProvidedOntologyFacts
    ? transientOntologyFacts
    : (typeof refresh?.ontology?.facts === "string" ? refresh.ontology.facts : "");

  const {
    session,
    rules,
    degradedCoverage,
    storyInfo,
    stateInfo,
    proofTelemetry,
  } = createDiagnosticsSession({
    cwd,
    skillPath,
    transientCloseSignals: ctx.transientCloseSignals,
    transientOntologyFacts: ctx.transientOntologyFacts,
    transientRegistryRefresh: ctx.transientRegistryRefresh,
    ontologyProjectionProfile,
    queryTimeoutMs,
  });

  return {
    session,
    rules,
    degradedCoverage,
    storyInfo,
    stateInfo,
    proofTelemetry,
    ruleBundleVersion: getRuleBundleVersion(),
    ruleHashes: hashRuleFiles(skillPath),
    refresh_source: hasProvidedCloseSignals || hasProvidedOntologyFacts ? "shared_snapshot" : (refresh ? "fresh_refresh" : "none"),
  };
}
