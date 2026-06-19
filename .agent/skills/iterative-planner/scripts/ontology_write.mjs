#!/usr/bin/env node

import { resolve } from "path";

import { isDirectInvocation } from "./lib/script_entrypoint.mjs";
import {
  appendActiveOntologyDelta,
  compileActiveOntologyFacts,
  computeActiveOntologyDigest,
  getActiveOntologyPath,
  initializeActiveOntology,
  validateActiveOntology,
} from "./lib/ive_active_ontology.mjs";

function usage() {
  return [
    "ontology_write.mjs",
    "",
    "Usage:",
    "  node .agent/skills/iterative-planner/scripts/ontology_write.mjs init [--dir <repo>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/ontology_write.mjs append --subject p:ID --predicate req:title --object \"Text\" [--object-kind literal|iri] [--plan-id <id>] [--phase Plan] [--source-ref <ref>] [--expect-digest <sha256>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/ontology_write.mjs retract --subject p:ID --predicate req:title --object \"Text\" [--object-kind literal|iri] [--reason <text>] [--expect-digest <sha256>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/ontology_write.mjs validate [--dir <repo>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/ontology_write.mjs compile [--dir <repo>] [--json]",
    "  node .agent/skills/iterative-planner/scripts/ontology_write.mjs digest [--dir <repo>] [--json]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    command: args.shift() || "help",
    cwd: process.cwd(),
    json: false,
    help: false,
    invalid: null,
    subject: null,
    predicate: null,
    object: null,
    objectKind: "iri",
    datatype: "xsd:string",
    planId: "ad-hoc",
    phase: "AdHoc",
    trigger: "ManualRepair",
    gate: null,
    sourceRef: "manual",
    expectDigest: null,
    reason: null,
    addedBy: "planner",
  };

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case "--dir":
      case "--cwd":
        options.cwd = resolve(args.shift() || process.cwd());
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--subject":
        options.subject = args.shift() || null;
        break;
      case "--predicate":
        options.predicate = args.shift() || null;
        break;
      case "--object":
        options.object = args.shift() || null;
        break;
      case "--object-kind":
      case "--object_kind":
        options.objectKind = args.shift() || "iri";
        break;
      case "--datatype":
        options.datatype = args.shift() || "xsd:string";
        break;
      case "--plan-id":
      case "--plan_id":
        options.planId = args.shift() || "ad-hoc";
        break;
      case "--phase":
        options.phase = args.shift() || "AdHoc";
        break;
      case "--trigger":
        options.trigger = args.shift() || "ManualRepair";
        break;
      case "--gate":
        options.gate = args.shift() || null;
        break;
      case "--source-ref":
      case "--source_ref":
        options.sourceRef = args.shift() || "manual";
        break;
      case "--expect-digest":
      case "--expect_digest":
        options.expectDigest = args.shift() || null;
        break;
      case "--reason":
        options.reason = args.shift() || null;
        break;
      case "--added-by":
      case "--added_by":
        options.addedBy = args.shift() || "planner";
        break;
      default:
        options.invalid = token;
        break;
    }
  }

  return options;
}

function requiredOperationFields(options) {
  const missing = [];
  for (const field of ["subject", "predicate", "object"]) {
    if (!options[field]) missing.push(field);
  }
  return missing;
}

function resultForCommand(options) {
  if (options.command === "init") {
    return { command: "init", ...initializeActiveOntology({ cwd: options.cwd }) };
  }
  if (options.command === "validate") {
    return { command: "validate", ...validateActiveOntology({ cwd: options.cwd }) };
  }
  if (options.command === "compile") {
    return { command: "compile", ...compileActiveOntologyFacts({ cwd: options.cwd }) };
  }
  if (options.command === "digest") {
    const digest = computeActiveOntologyDigest({ cwd: options.cwd });
    return { ok: !!digest, command: "digest", status: digest ? "PASS" : "MISSING", digest, path: getActiveOntologyPath(options.cwd) };
  }
  if (options.command === "append" || options.command === "retract") {
    const missing = requiredOperationFields(options);
    if (missing.length > 0) {
      return { ok: false, command: options.command, status: "FAIL", issues: [`missing required field(s): ${missing.join(", ")}`] };
    }
    return {
      command: options.command,
      ...appendActiveOntologyDelta({
        cwd: options.cwd,
        operations: [{
          operation: options.command === "append" ? "add" : "retract",
          subject: options.subject,
          predicate: options.predicate,
          object: options.object,
          objectKind: options.objectKind,
          datatype: options.datatype,
          sourceRef: options.sourceRef,
          reason: options.reason,
        }],
        planId: options.planId,
        phase: options.phase,
        trigger: options.trigger,
        gate: options.gate,
        sourceRef: options.sourceRef,
        expectDigest: options.expectDigest,
        addedBy: options.addedBy,
      }),
    };
  }
  return { ok: false, command: options.command, status: "FAIL", issues: [`unknown command: ${options.command}`] };
}

function humanSummary(result) {
  const lines = [
    `Active ontology ${result.command}`,
    `- status: ${result.status}`,
    `- ok: ${result.ok ? "true" : "false"}`,
  ];
  if (result.path) lines.push(`- path: ${result.path}`);
  if (result.digest) lines.push(`- digest: ${result.digest}`);
  if (result.digest_after) lines.push(`- digest_after: ${result.digest_after}`);
  if (result.iteration_id) lines.push(`- iteration: ${result.iteration_id}`);
  if (Array.isArray(result.facts)) lines.push(`- facts: ${result.facts.length}`);
  if (Array.isArray(result.issues) && result.issues.length > 0) {
    lines.push("- issues:");
    for (const issue of result.issues) lines.push(`  - ${issue}`);
  }
  return lines.join("\n");
}

export { parseArgs, resultForCommand };

if (isDirectInvocation(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === "help" || options.invalid) {
    if (options.invalid) console.error(`Unknown argument: ${options.invalid}`);
    console.log(usage());
    process.exit(options.invalid ? 2 : 0);
  }

  const result = resultForCommand(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(humanSummary(result));
  process.exit(result.ok ? 0 : 1);
}
