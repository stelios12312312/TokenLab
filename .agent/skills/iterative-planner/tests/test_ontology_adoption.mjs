#!/usr/bin/env node
// @planner:story = US-PM-AUTO-H3434ADDD105DC699, US-PM-AUTO-HBF2B3C2090464C16, US-PM-AUTO-H1229E651159F53BB, US-PM-AUTO-H5A1BFEA9588799F9, US-PM-AUTO-H0089A575E71FE05C, US-PM-AUTO-HC62AE04535181BF5
// @planner:proves = AC-T-INTAKE-30B796E4, AC-T-INTAKE-659B5968, AC-T-INTAKE-DAAFB01B, AC-T-INTAKE-70CFF88C, AC-T-INTAKE-7025D179
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  formatProjectOntologyProvisioning,
  formatProjectSetupCompletion,
  mergeProjectOntologyExitCode,
  provisionProjectOntology,
} from "../scripts/lib/project_ontology_provisioning.mjs";
import { mergeProjectOwnedDocuments } from "../scripts/lib/ontology_fact_builder.mjs";
import { resolveModelAssurance } from "../scripts/lib/model_assurance.mjs";
import { buildCanonicalOntologyGraph, buildDegradedOntologyGraph, buildGovernedNavigationProjection } from "../../../../apps/ive-visualizer/scripts/canonical-ontology-adapter.mjs";

const requested = (() => {
  const index = process.argv.indexOf("--section");
  return index >= 0 ? process.argv[index + 1] : "all";
})();
const run = (section) => requested === "all" || requested === section;
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (run("provisioning")) {
  await test("provisioning dry-run is non-mutating", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontology-provision-dry-"));
    let calls = 0;
    const receipt = provisionProjectOntology({
      cwd: root,
      dryRun: true,
      buildFacts: (options) => {
        calls += 1;
        assert.equal(options.dryRun, true);
        return { ok: true, changed_fact_documents: ["code"], wrote_fact_documents: [], changed_generated_facts: true, wrote_generated_facts: false, counts: { code: { files: 1 } }, warnings: [], authority_receipt: { source_digest: "sha256:host", schema_version: 1, engine_version: "test" } };
      },
    });
    assert.equal(calls, 1);
    assert.equal(receipt.status, "would_change");
    assert.equal(receipt.no_change, false);
    assert.equal(receipt.freshness.compiled_projection, "would_refresh");
    assert.equal(existsSync(join(root, ".agent/ontology/provisioning_receipt.json")), false);
  });

  await test("dry-run restores and rejects an accidental publisher mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontology-provision-dry-violation-"));
    const factsDir = join(root, ".agent/ontology/facts");
    mkdirSync(factsDir, { recursive: true });
    const canonical = join(factsDir, "code.yaml");
    writeFileSync(canonical, "before\n");
    const receipt = provisionProjectOntology({
      cwd: root,
      dryRun: true,
      buildFacts: () => {
        writeFileSync(canonical, "unexpected write\n");
        return { ok: true, changed_fact_documents: ["code"], changed_generated_facts: false, warnings: [], authority_receipt: { source_digest: "sha256:test" } };
      },
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.rolled_back, true);
    assert.equal(readFileSync(canonical, "utf8"), "before\n");
  });

  await test("failed provisioning restores exact canonical bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontology-provision-rollback-"));
    const factsDir = join(root, ".agent/ontology/facts");
    mkdirSync(factsDir, { recursive: true });
    const canonical = join(factsDir, "code.yaml");
    writeFileSync(canonical, "host-authored\n");
    const before = sha(readFileSync(canonical));
    const receipt = provisionProjectOntology({
      cwd: root,
      buildFacts: () => {
        writeFileSync(canonical, "partial-write\n");
        throw new Error("injected validation failure");
      },
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.rolled_back, true);
    assert.equal(sha(readFileSync(canonical)), before);
  });

  await test("second successful provisioning reports no change", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontology-provision-idempotent-"));
    const result = { ok: true, changed_fact_documents: [], wrote_fact_documents: [], changed_generated_facts: false, wrote_generated_facts: false, counts: { code: { files: 1 } }, warnings: [], authority_receipt: { source_digest: "sha256:host", schema_version: 1, engine_version: "test" } };
    const first = provisionProjectOntology({ cwd: root, buildFacts: () => result });
    const second = provisionProjectOntology({ cwd: root, buildFacts: () => result });
    assert.equal(first.status, "current");
    assert.equal(second.status, "current");
    assert.equal(second.changed, false);
    assert.equal(second.no_change, true);
    assert.equal(second.exclusions.present, false);
  });

  await test("project-owned facts survive induction unless explicitly excluded", () => {
    const current = {
      code: { modules: [], files: [{ path: "src/custom.mjs", module: "custom" }], classes: [], functions: [], file_dependencies: [] },
      specification: { domains: [], stories: [], plans: [] },
      verification: { criteria: [], tests: [], artifacts: [], test_runs: [], coverage_reports: [] },
      process: { mistakes: [], patterns: [], gotchas: [], retros: [], adrs: [], workflows: [], mirror_readers: [], edge_cases: [], invariants: [] },
    };
    const induced = structuredClone(current);
    induced.code.files = [{ path: "src/induced.mjs", module: "app" }];
    const preserved = mergeProjectOwnedDocuments(current, induced);
    assert.deepEqual(preserved.code.files.map((entry) => entry.path), ["src/custom.mjs", "src/induced.mjs"]);
    const excluded = mergeProjectOwnedDocuments(current, induced, { "code.files": ["src/custom.mjs"] });
    assert.deepEqual(excluded.code.files.map((entry) => entry.path), ["src/induced.mjs"]);
  });

  await test("provisioning receipts render every setup outcome without weakening failures", () => {
    const wouldChange = formatProjectOntologyProvisioning({
      ok: true,
      status: "would_change",
      authority: { source_digest: "sha256:dry" },
    });
    const updated = formatProjectOntologyProvisioning({ ok: true, status: "updated", authority: null });
    const current = formatProjectOntologyProvisioning({ ok: true, status: "current", authority: {} });
    const rolledBack = formatProjectOntologyProvisioning({ ok: false, rolled_back: true, issues: ["invalid ontology"] });
    const failed = formatProjectOntologyProvisioning({ ok: false, rolled_back: false });
    assert.match(wouldChange[0], /WOULD UPDATE.*sha256:dry/);
    assert.match(updated[0], /UPDATED.*digest unavailable/);
    assert.match(current[0], /OK.*digest unavailable/);
    assert.match(rolledBack.join("\n"), /prior canonical bytes restored.*invalid ontology/s);
    assert.match(failed[0], /provisioning failed$/);
    assert.equal(mergeProjectOntologyExitCode(undefined, { ok: true }), undefined);
    assert.equal(mergeProjectOntologyExitCode(7, { ok: true }), 7);
    assert.equal(mergeProjectOntologyExitCode(undefined, { ok: false }), 1);
    assert.match(formatProjectSetupCompletion(true), /SETUP COMPLETE/);
    assert.match(formatProjectSetupCompletion(false), /SETUP FAILED.*RESTORED/);
  });
}

if (run("assurance")) {
  await test("assurance is monotonic and never changes the normal model surface", () => {
    const result = resolveModelAssurance({
      configuredFloor: "standard",
      taskRisk: "enhanced",
      capability: { profile: "standard", provenance: "observed" },
      observedFailures: 2,
      requestedProfile: "standard",
    });
    assert.equal(result.ok, true);
    assert.equal(result.effective_profile, "critical");
    assert.deepEqual(result.normal_surface, {
      provider_selection: "unchanged",
      model_selection: "unchanged",
      generation: "unchanged",
      tools: "unchanged",
    });
    assert.ok(result.required_checks.includes("ontology_invariants"));
    assert.ok(result.required_checks.includes("evidence_freshness"));
    assert.ok(result.required_checks.includes("postcondition"));
    assert.ok(result.required_checks.includes("exercised_system"));
    assert.ok(result.required_checks.includes("bounded_retry"));
  });

  await test("unknown identity stays unknown and self-downgrade is rejected", () => {
    const result = resolveModelAssurance({
      configuredFloor: "enhanced",
      taskRisk: "standard",
      capability: { profile: "critical", provenance: "model_claim" },
      requestedProfile: "standard",
    });
    assert.equal(result.identity_provenance, "unknown");
    assert.equal(result.effective_profile, "enhanced");
    assert.equal(result.downgrade_rejected, true);
    assert.ok(result.warnings.some((entry) => entry.includes("untrusted")));
  });

  await test("failure escalation and retry budgets are bounded", () => {
    const result = resolveModelAssurance({ configuredFloor: "standard", taskRisk: "standard", observedFailures: 99 });
    assert.equal(result.effective_profile, "critical");
    assert.ok(result.retry_budget >= 0 && result.retry_budget <= 2);
  });
}

if (run("ive")) {
  await test("canonical IVE graph keeps one identity and typed story-to-proof edges", () => {
    const graph = buildCanonicalOntologyGraph({
      documents: {
        code: { files: [{ path: "src/a.mjs", module: "app", language: "javascript" }], modules: [{ id: "app", path: "src" }], classes: [], functions: [], file_dependencies: [] },
        specification: { domains: [{ name: "core" }], stories: [{ id: "US-1", title: "Story", status: "FULLY_COVERED", domain: "core", acceptance_criteria: [{ id: "AC-1", text: "Works" }] }], plans: [{ id: "plan-1", story_ids: ["US-1"], phase: "validate" }] },
        verification: { criteria: [{ id: "sc_1", plan_id: "plan-1", story_id: "US-1", test_refs: ["tests/a.mjs"], artifact_refs: ["reports/a.json"] }], tests: [{ name: "tests/a.mjs", file: "tests/a.mjs", criterion_ids: ["sc_1"], covered_files: ["src/a.mjs"] }], artifacts: [{ path: "reports/a.json", type: "test_report", criterion_ids: ["sc_1"] }], test_runs: [{ id: "run-1", test_name: "tests/a.mjs", status: "pass", current: true, provenance: "test_run_record" }], coverage_reports: [] },
        process: { mistakes: [], patterns: [], gotchas: [], retros: [], adrs: [], workflows: [], mirror_readers: [], edge_cases: [], invariants: [] },
        proof_weights: { proof_types: {}, risk_levels: {}, domain_defaults: {} },
        conventions: { conventions: [] },
      },
      authorityReceipt: { source_digest: "sha256:canonical", generated_at: "2026-08-30T00:00:00.000Z", provenance: "project_owned_canonical_yaml" },
      programOverlay: { stories: [{ id: "US-1", title: "Duplicate overlay" }], tickets: [{ id: "T-2", title: "Dependent", story_refs: ["US-1"], depends_on: ["T-1", "T-MISSING"] }, { id: "T-1", title: "Ticket", story_refs: ["US-1"], depends_on: [] }] },
    });
    assert.equal(graph.nodes.filter((node) => node.id === "US-1").length, 1);
    assert.equal(graph.nodes.filter((node) => node.id === "T-1").length, 1);
    assert.ok(graph.edges.some((edge) => edge.type === "verifies"));
    assert.ok(graph.edges.some((edge) => edge.type === "tested_by"));
    assert.ok(graph.edges.some((edge) => edge.type === "covers_code"));
    assert.ok(graph.edges.some((edge) => edge.id === "depends_on:T-2->T-1"));
    assert.ok(!graph.edges.some((edge) => edge.target === "T-MISSING"));
    assert.equal(graph.meta.canonical_source_digest, "sha256:canonical");
    assert.equal(graph.meta.read_only, true);
    assert.equal(graph.meta.degraded, false);
  });

  await test("governed IVE navigation projection preserves temporal evidence and graph complexity", () => {
    const graph = {
      nodes: [
        { id: "A", type: "domain", label: "A", provenance: "canonical", freshness: "current", verification_state: "current", position: { x: 0, y: 0 }, data: { label: "A" } },
        { id: "B", type: "domain", label: "B", provenance: "canonical", freshness: "current", verification_state: "current", position: { x: 0, y: 0 }, data: { label: "B" } },
        { id: "C", type: "domain", label: "C", provenance: "canonical", freshness: "current", verification_state: "current", position: { x: 0, y: 0 }, data: { label: "C" } },
        { id: "T-1", type: "ticket", label: "Ticket", provenance: "program", freshness: "current", verification_state: "pending", position: { x: 0, y: 0 }, data: { label: "Ticket" } },
      ],
      edges: [
        { id: "belongs_to:A->B", type: "belongs_to", source: "A", target: "B", label: "belongs_to" },
        { id: "belongs_to:A->C", type: "belongs_to", source: "A", target: "C", label: "belongs_to" },
        { id: "belongs_to:B->A", type: "belongs_to", source: "B", target: "A", label: "belongs_to" },
        { id: "tracks:T-1->A", type: "tracks", source: "T-1", target: "A", label: "tracks" },
      ],
      meta: { canonical_node_count: 4, canonical_edge_count: 4, degraded: false },
    };
    const packet = {
      id: "PGM-1",
      tickets: [
        { id: "T-1", lifecycle: "ready", external_refs: [{ kind: "github_issue", url: "https://example.test/1", synced_at: "2026-09-01T12:00:00.000Z" }, { kind: "github_issue", url: "https://example.test/1/earlier", synced_at: "2026-09-01T10:00:00.000Z" }], review_artifacts: [{ kind: "review", path: "reports/review.json", generated_at: "2026-09-01T11:00:00.000Z" }] },
        { id: "T-2", lifecycle: "proposed", external_refs: [], review_artifacts: [] },
      ],
      dependencies: [{ id: "D-1", from_ref: "T-2", to_ref: "T-1", type: "requires", status: "active" }],
    };
    const projection = buildGovernedNavigationProjection({
      graph,
      programPacket: packet,
      authorityReceipt: { source_digest: "sha256:canonical", generated_at: "2026-09-01T13:00:00.000Z", provenance: "project_owned_canonical_yaml" },
      maxNodes: 3,
      maxEvents: 10,
    });
    assert.equal(projection.schema_version, "ive.navigation-projection.v1");
    assert.equal(projection.read_only, true);
    assert.equal(projection.canonical_source_digest, "sha256:canonical");
    assert.equal(projection.temporal.availability, "partial");
    assert.deepEqual(projection.temporal.events.map((event) => event.occurred_at), ["2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "2026-09-01T12:00:00.000Z"]);
    assert.ok(projection.temporal.events.every((event) => event.source_path && event.freshness));
    const reordered = buildGovernedNavigationProjection({
      graph,
      programPacket: { ...packet, tickets: [{ ...packet.tickets[0], external_refs: [...packet.tickets[0].external_refs].reverse(), review_artifacts: [...packet.tickets[0].review_artifacts].reverse() }, packet.tickets[1]] },
      authorityReceipt: { source_digest: "sha256:canonical", generated_at: "2026-09-01T13:00:00.000Z", provenance: "project_owned_canonical_yaml" },
      maxNodes: 3,
      maxEvents: 10,
    });
    assert.deepEqual(reordered.temporal.events.map((event) => event.id), projection.temporal.events.map((event) => event.id));
    assert.equal(projection.hierarchy.available_node_count, 4);
    assert.equal(projection.hierarchy.displayed_node_count, 3);
    assert.equal(projection.hierarchy.truncated, true);
    const a = projection.hierarchy.nodes.find((node) => node.id === "A");
    assert.deepEqual(a.parent_ids, ["B", "C"]);
    assert.equal(a.multiple_parents, true);
    assert.equal(a.in_cycle, true);
    assert.deepEqual(projection.hierarchy.nodes.map((node) => node.id), ["A", "B", "C"]);

    const empty = buildGovernedNavigationProjection({ graph: { nodes: [], edges: [], meta: {} }, programPacket: { tickets: [] }, authorityReceipt: { source_digest: "sha256:empty", provenance: "canonical" } });
    assert.equal(empty.temporal.availability, "unavailable");
    assert.equal(empty.temporal.events.length, 0);
    assert.ok(empty.temporal.missing_reason.includes("No source-backed"));
  });

  await test("canonical-load failure is explicit and cannot masquerade as the canonical graph", () => {
    const graph = buildDegradedOntologyGraph({
      fallbackGraph: { nodes: [{ id: "T-1", position: { x: 0, y: 0 }, data: { label: "Ticket" } }], edges: [] },
      authorityReceipt: { source_digest: "sha256:unavailable", provenance: "unavailable" },
      issues: ["canonical ontology unavailable"],
    });
    assert.equal(graph.meta.degraded, true);
    assert.equal(graph.meta.projection_kind, "program_fallback");
    assert.equal(graph.meta.canonical_node_count, 0);
    assert.deepEqual(graph.meta.issues, ["canonical ontology unavailable"]);
  });
}

if (run("performance")) {
  await test("cache hit is fact-identical and corruption rebuilds fresh", async () => {
    const runtime = await import("../scripts/lib/ontology_runtime.mjs");
    const repo = fileURLToPath(new URL("../../../..", import.meta.url));
    const root = await mkdtemp(join(tmpdir(), "ontology-cache-"));
    cpSync(join(repo, ".agent/ontology/facts"), join(root, ".agent/ontology/facts"), { recursive: true });
    mkdirSync(join(root, ".agent/skills/iterative-planner/config"), { recursive: true });
    cpSync(join(repo, ".agent/skills/iterative-planner/config/version.json"), join(root, ".agent/skills/iterative-planner/config/version.json"));
    const first = runtime.loadOntologyRuntime({ cwd: root });
    const second = runtime.loadOntologyRuntime({ cwd: root });
    assert.equal(first.ok, true);
    assert.equal(first.cache.status, "miss");
    assert.equal(second.cache.status, "hit");
    assert.equal(second.facts_text, first.facts_text);
    writeFileSync(join(root, ".agent/ontology/cache/runtime-v1.json"), "{corrupt");
    const rebuilt = runtime.loadOntologyRuntime({ cwd: root });
    assert.equal(rebuilt.cache.status, "miss");
    assert.equal(rebuilt.facts_text, first.facts_text);
    assert.ok(rebuilt.warnings.some((warning) => warning.includes("cache unreadable")));
    const otherRoot = await mkdtemp(join(tmpdir(), "ontology-cache-other-"));
    assert.notEqual(
      runtime.ontologyRuntimeCacheKey({ cwd: root, authorityReceipt: first.authority_receipt }),
      runtime.ontologyRuntimeCacheKey({ cwd: otherRoot, authorityReceipt: first.authority_receipt }),
    );
    const baseKeyInput = { cwd: root, authorityReceipt: first.authority_receipt };
    assert.notEqual(runtime.ontologyRuntimeCacheKey(baseKeyInput), runtime.ontologyRuntimeCacheKey({ ...baseKeyInput, projectionProfile: "gate" }));
    assert.notEqual(runtime.ontologyRuntimeCacheKey(baseKeyInput), runtime.ontologyRuntimeCacheKey({ ...baseKeyInput, configDigest: "changed" }));
    assert.notEqual(
      runtime.ontologyRuntimeCacheKey(baseKeyInput),
      runtime.ontologyRuntimeCacheKey({ ...baseKeyInput, authorityReceipt: { ...first.authority_receipt, engine_version: "changed" } }),
    );
  });
}

if (!process.exitCode) console.log(`\n${passed} ontology adoption tests passed`);
