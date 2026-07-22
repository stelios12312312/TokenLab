#!/usr/bin/env node
// test_ive_active_ontology.mjs — IVE phase 4.5 active ontology and temporal provenance proof.

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { createSession } from "../scripts/lib/prolog.mjs";
import { loadProjectMetaFacts } from "../scripts/lib/fact_loader.mjs";
import {
  appendActiveOntologyDelta,
  compileActiveOntologyFacts,
  getActiveOntologyPath,
  initializeActiveOntology,
  parseActiveOntology,
  validateActiveOntology,
} from "../scripts/lib/ive_active_ontology.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const skillDir = resolve(testDir, "..");
const repoRoot = resolve(skillDir, "..", "..", "..");
const NODE = process.execPath;
const ontologyWriteCli = join(skillDir, "scripts", "ontology_write.mjs");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function makeTemp(name) {
  return mkdtempSync(join(tmpdir(), name));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

function appendTitle(cwd, title = "Durable memory", options = {}) {
  return appendActiveOntologyDelta({
    cwd,
    planId: "plan_fixture",
    phase: "Plan",
    trigger: "GateTransition",
    gate: "plan-to-execute",
    sourceRef: "reports/user_story_audit/story_registry.json#US-077",
    operations: [{
      operation: "add",
      subject: "p:US-077",
      predicate: "req:title",
      object: title,
      objectKind: "literal",
    }],
    ...options,
  });
}

function runCli(args, cwd = repoRoot) {
  return JSON.parse(execFileSync(NODE, [ontologyWriteCli, ...args, "--json"], {
    cwd,
    encoding: "utf-8",
  }));
}

console.log("\nIVE Active Ontology Tests\n");

function testAppendParseAndCompile() {
  const tmp = makeTemp("ive-active-ontology-");
  try {
    const result = appendTitle(tmp);
    assert(result.ok && result.iteration_id === "p:ITR-001", "append creates first iteration and digest");

    const parsed = parseActiveOntology({ cwd: tmp });
    assert(parsed.ok && parsed.current_statements.length === 1, "parser reads current statement from project.ttl");
    assert(parsed.iterations[0].plan_id === "plan_fixture", "parser reads iteration provenance");
    assert(parsed.deltas[0].operation === "prov:AddAssertion", "parser reads add delta operation");

    const compiled = compileActiveOntologyFacts({ cwd: tmp });
    assert(compiled.ok && compiled.facts.some((fact) => fact.includes("active_ontology_current('p:US-077', 'req:title', 'Durable memory')")), "compiler emits active_ontology_current fact");
  } finally {
    cleanup(tmp);
  }
}

function testStaleWriteRefusesMutation() {
  const tmp = makeTemp("ive-active-ontology-stale-");
  try {
    const first = appendTitle(tmp, "One");
    const second = appendActiveOntologyDelta({
      cwd: tmp,
      expectDigest: first.digest_after,
      operations: [{
        operation: "add",
        subject: "p:US-079",
        predicate: "req:title",
        object: "Two",
        objectKind: "literal",
      }],
    });
    assert(second.ok, "append with current digest succeeds");
    const before = readFileSync(getActiveOntologyPath(tmp), "utf-8");
    const stale = appendActiveOntologyDelta({
      cwd: tmp,
      expectDigest: first.digest_after,
      operations: [{
        operation: "add",
        subject: "p:US-086",
        predicate: "req:title",
        object: "Three",
        objectKind: "literal",
      }],
    });
    const after = readFileSync(getActiveOntologyPath(tmp), "utf-8");
    assert(!stale.ok && stale.code === "active_ontology_stale_write", "stale digest is refused");
    assert(before === after, "stale write leaves project.ttl unchanged");
  } finally {
    cleanup(tmp);
  }
}

function testHandEditRejectsCompile() {
  const tmp = makeTemp("ive-active-ontology-tamper-");
  try {
    appendTitle(tmp);
    writeFileSync(getActiveOntologyPath(tmp), readFileSync(getActiveOntologyPath(tmp), "utf-8") + "\np:TAMPER req:title \"manual\"^^xsd:string .\n");
    const validation = validateActiveOntology({ cwd: tmp });
    assert(!validation.ok && validation.code === "active_ontology_integrity_mismatch", "hand-edited Turtle fails sidecar integrity validation");
    const compiled = compileActiveOntologyFacts({ cwd: tmp });
    assert(!compiled.ok && compiled.facts.some((fact) => fact.includes("active_ontology_integrity_status('fail')")), "tampered ontology does not compile as trusted facts");
  } finally {
    cleanup(tmp);
  }
}

function testRetractionPreservesHistoryButRemovesCurrent() {
  const tmp = makeTemp("ive-active-ontology-retract-");
  try {
    appendTitle(tmp);
    const retracted = appendActiveOntologyDelta({
      cwd: tmp,
      operations: [{
        operation: "retract",
        subject: "p:US-077",
        predicate: "req:title",
        object: "Durable memory",
        objectKind: "literal",
        reason: "replaced by canonical story title",
      }],
    });
    assert(retracted.ok && retracted.retract_count === 1, "retraction writes a provenance delta");
    const parsed = parseActiveOntology({ cwd: tmp });
    assert(parsed.statements.length === 1 && parsed.current_statements.length === 0, "retraction preserves statement history and removes current projection");
    const compiled = compileActiveOntologyFacts({ cwd: tmp });
    assert(compiled.facts.some((fact) => fact.includes("active_ontology_triple('p:US-077'")),
      "history triple remains compiled");
    assert(!compiled.facts.some((fact) => fact.includes("active_ontology_current('p:US-077'")),
      "retracted triple is not current");
  } finally {
    cleanup(tmp);
  }
}

function testCliAndFactLoaderBridge() {
  const tmp = makeTemp("ive-active-ontology-cli-");
  try {
    const init = runCli(["init", "--dir", tmp]);
    assert(init.ok && existsSync(getActiveOntologyPath(tmp)), "ontology_write init creates project.ttl");
    const appended = runCli([
      "append",
      "--dir", tmp,
      "--subject", "p:US-077",
      "--predicate", "req:title",
      "--object", "Durable memory",
      "--object-kind", "literal",
      "--plan-id", "plan_fixture",
      "--phase", "Plan",
    ]);
    assert(appended.ok && appended.iteration_id === "p:ITR-001", "ontology_write append emits JSON iteration metadata");
    const compiled = runCli(["compile", "--dir", tmp]);
    assert(compiled.ok && compiled.facts.some((fact) => fact.includes("active_ontology_current")), "ontology_write compile emits active ontology facts");

    const session = createSession();
    loadProjectMetaFacts(session, { cwd: tmp });
    const matches = [...session.query("active_ontology_current('p:US-077', 'req:title', 'Durable memory')")];
    assert(matches.length === 1, "fact_loader exposes active ontology current facts to Prolog consumers");
  } finally {
    cleanup(tmp);
  }
}

testAppendParseAndCompile();
testStaleWriteRefusesMutation();
testHandEditRejectsCompile();
testRetractionPreservesHistoryButRemovesCurrent();
testCliAndFactLoaderBridge();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
